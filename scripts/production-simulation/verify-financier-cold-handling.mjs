import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh evidence directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false, "Choose a fresh evidence directory");
mkdirSync(output, { recursive: true });

const engineDirectory = resolve(
  `apps/portal/public/bakery-physics/executions/${manifest.bundle.id}`,
);
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
);
const E = await import(
  pathToFileURL(join(engineDirectory, manifest.engine.file)).href
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}
function save(name, data) {
  writeFileSync(join(output, name), `${canonicalJson(data)}\n`);
}

const cell = await prepareCell(runtime, "financier-cold-cell");
assert.equal(cell.fixture, "persistent-rack/1");
assert.equal(cell.robot, "fairino-fr10");
assert.deepEqual(cell.ingredients, {
  massKg: 1,
  forwardMm: 0,
  lateralMm: 0,
});
assert.equal(cell.clampForceN, 100);
save("cell-definition.json", cell);

const manualInput = financierRecipeInput(3, 2, 900);
const manualScenario = value(await compileFinancierRecipe(manualInput));
const manualAdmitted = value(await E.admitScenario(manualScenario));

const input = structuredClone(manualInput);
input.moulds = [
  { id: "mould-a", cavities: 8, profile: "matsunaga-financier-8p" },
  { id: "mould-b", cavities: 8, profile: "matsunaga-financier-8p" },
];
const scenario = value(await compileFinancierRecipe(input, cell));
const admitted = value(await E.admitScenario(scenario));
assert.equal(scenario.cells.length, 1);
assert.equal(scenario.cells[0].id, "financier-cold-cell");

save("recipe.json", {
  kind: "financier-recipe",
  coldHandling: "fairino-fr10",
  recipe: input,
});
save("execution.json", manifest);
save("scenario.json", scenario);

async function open(activeScenario, saved, leg) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const reply = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells: [cell],
    identity: {
      runId: "financier-cold-carrier-acceptance",
      executionId: `financier-${leg}`,
      hostSession: `host-${leg}`,
      parent:
        saved === null
          ? null
          : {
              snapshot: saved.document.snapshot,
              execution: saved.document.state.identity.executionId,
            },
    },
    origin:
      saved === null
        ? { kind: "scenario", scenario: activeScenario }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
  });
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  return host;
}

async function drive(host, until = 21_600_000_000) {
  for (let turn = 0; turn < 2000; turn++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (
      reply.view.time >= until ||
      [
        "completed",
        "blocked",
        "stopped-at-limit",
        "awaiting-inspection",
      ].includes(reply.view.status.kind)
    ) {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      return { run: state.run, view: reply.view };
    }
  }
  throw new Error("Financier cold-handling run exceeded its execution bound");
}

function pendingInspection(item) {
  return item.kind === "pending";
}
function sameId(id, item) {
  return item.id === id;
}
function recipeTask(run, workflow, key) {
  const id = `${workflow}#0/${key}`;
  const found = run.tasks.find(sameId.bind(null, id));
  assert.ok(found, `Missing task ${id}`);
  return found;
}
function processEvents(run) {
  const events = [];
  for (const {
    sequence: _sequence,
    execution: _execution,
    ...event
  } of run.events)
    if (!["command-admitted", "pause-settled"].includes(event.kind))
      events.push(event);
  return events;
}
function recipeBalance(run) {
  const results = E.runResults(run, {
    after: null,
    through: run.position.time,
  });
  let remainingMg = 0;
  let exitedMg = 0;
  for (const stock of results.stock)
    if (stock.unit === "milligram") remainingMg += stock.remaining;
  const reported = {};
  for (const entry of results.reported) {
    reported[entry.destination] = entry.amount;
    if (entry.unit === "milligram" && entry.role !== "intermediate-stock")
      exitedMg += entry.amount;
  }
  assert.equal(
    remainingMg + exitedMg,
    775_000,
    "Recipe mass balances at this boundary",
  );
  return { remainingMg, exitedMg, reported, results };
}

async function driveRecipe(
  host,
  until = 21_600_000_000,
  stopBeforeInspectionTask = null,
) {
  for (let step = 0; step < 30; step++) {
    const boundary = await drive(host, until);
    recipeBalance(boundary.run);
    if (boundary.run.status.kind !== "awaiting-inspection") return boundary;
    const pending = boundary.view.inspections.find(pendingInspection);
    assert.ok(pending, "Awaiting inspection requires a pending inspection");
    if (
      stopBeforeInspectionTask !== null &&
      pending.task === stopBeforeInspectionTask
    )
      return boundary;
    for (const lotId of pending.lots) {
      const lot = boundary.run.lots.find(sameId.bind(null, lotId));
      assert.equal(lot.disposition, "held", `Lot ${lotId} must stay held`);
    }
    const outcome = pending.task.startsWith("load-hazelnut-b#")
      ? "reject"
      : "accept";
    const request = {
      kind: "inspect",
      commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/g, "-")}`,
      expectedControlRevision: boundary.view.controlRevision,
      task: pending.task,
      definition: pending.definition,
      lots: pending.lots,
      outcome,
      note: "Operator inspection for Plan 61A cold-carrier acceptance",
    };
    const reply = await host.handle(request);
    assert.equal(reply.kind, "commanded", JSON.stringify(reply));
    assert.equal(reply.receipt.status, "accepted", JSON.stringify(reply));
  }
  throw new Error("Recipe did not settle after its inspections");
}

// 1. Baseline uninterrupted execution with native Wasm cold-carrier transfers
const baselineHost = await open(scenario, null, "baseline");
const baselineBoundary = await driveRecipe(baselineHost);
const baseline = baselineBoundary.run;
assert.equal(
  baseline.status.kind,
  "completed",
  JSON.stringify(baseline.status),
);
const baselineBalance = recipeBalance(baseline);

// Check oven preheat overlap with batter preparation and mould reuse
const preheatTask = recipeTask(baseline, "financier-preheat", "preheat");
const storeBatterTask = recipeTask(
  baseline,
  "hazelnut-preparation-batches",
  "store-batter",
);
const loadAOven = recipeTask(baseline, "load-hazelnut-a", "load-oven");
assert.ok(storeBatterTask.completedAt < preheatTask.completedAt);
assert.ok(loadAOven.startedAt >= preheatTask.completedAt);

const returnMouldA = recipeTask(baseline, "load-hazelnut-a", "return-mould");
const prepareMouldC = recipeTask(baseline, "load-hazelnut-c", "prepare-mould");
assert.ok(
  prepareMouldC.startedAt >= returnMouldA.completedAt,
  "Load C refills mould-a only after demould, wash, and return",
);

// Check native cold-carrier transfer across all three loads
for (const loadId of [
  "load-hazelnut-a",
  "load-hazelnut-b",
  "load-hazelnut-c",
]) {
  const crumbCheck = recipeTask(baseline, loadId, "crumb-check");
  const packReady = recipeTask(baseline, loadId, "pack-ready");
  const stageCold = recipeTask(baseline, loadId, "stage-cold-carrier");
  const transferCold = recipeTask(baseline, loadId, "transfer-cold-carrier");
  const handoffCold = recipeTask(baseline, loadId, "handoff-cold-carrier");
  const releasePack = recipeTask(baseline, loadId, "release-for-packing");
  const movePack = recipeTask(baseline, loadId, "move-to-packing");
  const finishPack = recipeTask(baseline, loadId, "finish-product");

  assert.equal(transferCold.kind, "completed");
  assert.ok(stageCold.startedAt >= crumbCheck.completedAt);
  assert.ok(stageCold.startedAt >= packReady.completedAt);
  assert.ok(transferCold.startedAt >= stageCold.completedAt);
  assert.ok(handoffCold.startedAt >= transferCold.completedAt);
  assert.ok(releasePack.startedAt >= handoffCold.completedAt);
  assert.ok(movePack.startedAt >= releasePack.completedAt);
  assert.ok(finishPack.startedAt >= movePack.completedAt);
}

// Check 775 g mass balance and Load B rejection
assert.equal(baselineBalance.remainingMg, 145_000);
for (const [destination, amount] of Object.entries({
  "hazelnut-batter-prepared": 745_000,
  "filled-mass": 600_000,
  "filled-pieces": 24,
  "butter-evaporation": 22_000,
  "mixing-residue": 8_000,
  "baking-loss": 36_000,
  "rejected-mass": 188_000,
  "rejected-pieces": 8,
  "sample-mass": 23_500,
  "sample-pieces": 1,
  "packed-mass": 352_500,
  "packed-pieces": 15,
}))
  assert.equal(baselineBalance.reported[destination], amount, destination);

for (const carrier of baseline.carriers) {
  assert.equal(carrier.bound, null);
  assert.equal(carrier.custody.kind, "stored");
  const expected = carrier.id.startsWith("grid-")
    ? "empty-grids"
    : `clean-${carrier.id.replace(/-1$/, "")}`;
  assert.equal(carrier.custody.storage, expected);
}
save("baseline.json", await baselineHost.handle({ kind: "save" }));
await baselineHost.handle({ kind: "dispose" });

// 2. Interrupt native cold-carrier transfer in-flight after pickup, save, dispose Wasm worker, restore, and pause/reopen at packing release
const transferA = recipeTask(
  baseline,
  "load-hazelnut-a",
  "transfer-cold-carrier",
);
const interruptTime = transferA.startedAt + 10_000_000;

const movingHost = await open(scenario, null, "in-flight");
const movingBoundary = await driveRecipe(movingHost, interruptTime);
assert.equal(
  recipeTask(movingBoundary.run, "load-hazelnut-a", "transfer-cold-carrier")
    .kind,
  "executing",
);
const grid1InFlight = movingBoundary.run.carriers.find(
  sameId.bind(null, "grid-1"),
);
assert.equal(grid1InFlight.custody.kind, "transport");
assert.equal(
  grid1InFlight.custody.task,
  "load-hazelnut-a#0/transfer-cold-carrier",
);
assert.equal(
  recipeTask(movingBoundary.run, "load-hazelnut-a", "release-for-packing").kind,
  "waiting",
);
const pausedInFlight = await movingHost.handle({
  kind: "pause",
  commandId: "pause-cold-carrier-in-flight",
});
assert.equal(pausedInFlight.receipt.status, "accepted");
const inFlightSave = await movingHost.handle({ kind: "save" });
assert.equal(inFlightSave.kind, "saved");
save("cold-carrier-in-flight.json", inFlightSave);
await movingHost.handle({ kind: "dispose" });

// Reopen from mid-transfer checkpoint and advance to Load A packing release inspection
const resumedHost = await open(scenario, inFlightSave, "resumed-to-packing");
const atPackingRelease = await driveRecipe(
  resumedHost,
  21_600_000_000,
  "load-hazelnut-a#0/release-for-packing",
);
assert.equal(atPackingRelease.run.status.kind, "awaiting-inspection");
assert.equal(
  recipeTask(atPackingRelease.run, "load-hazelnut-a", "handoff-cold-carrier")
    .kind,
  "completed",
);
assert.equal(
  recipeTask(atPackingRelease.run, "load-hazelnut-a", "finish-product").kind,
  "waiting",
);
const packingReleaseSave = await resumedHost.handle({ kind: "save" });
assert.equal(packingReleaseSave.kind, "saved");
save("before-packing-release.json", packingReleaseSave);
await resumedHost.handle({ kind: "dispose" });

// Reopen at packing release and complete the entire run
const finalHost = await open(
  scenario,
  packingReleaseSave,
  "completed-after-reopen",
);
const completedBoundary = await driveRecipe(finalHost);
const completed = completedBoundary.run;
assert.equal(completed.status.kind, "completed");
assert.deepEqual(completed.lots, baseline.lots);
assert.deepEqual(completed.carriers, baseline.carriers);
assert.deepEqual(processEvents(completed), processEvents(baseline));
save("motion-and-packing-restored.json", completedBoundary);
await finalHost.handle({ kind: "dispose" });

// 3. Refusal checks: incompatible mould profile and incompatible cell fixture/payload
const refusals = [];
const wrongProfileInput = structuredClone(input);
wrongProfileInput.moulds[0].profile = "matsunaga-madeleine-6p";
const wrongProfileResult = await compileFinancierRecipe(
  wrongProfileInput,
  cell,
);
assert.deepEqual(wrongProfileResult, {
  ok: false,
  error: { code: "invalid_recipe" },
});
refusals.push({
  case: "wrong-mould-profile",
  profile: "matsunaga-madeleine-6p",
  result: wrongProfileResult,
});

const wrongMassCell = structuredClone(cell);
wrongMassCell.ingredients.massKg = 2;
const wrongMassResult = await compileFinancierRecipe(input, wrongMassCell);
assert.deepEqual(wrongMassResult, {
  ok: false,
  error: { code: "invalid_recipe" },
});
refusals.push({
  case: "wrong-cell-payload-mass",
  massKg: 2,
  result: wrongMassResult,
});

const wrongClampCell = structuredClone(cell);
wrongClampCell.clampForceN = 80;
const wrongClampResult = await compileFinancierRecipe(input, wrongClampCell);
assert.deepEqual(wrongClampResult, {
  ok: false,
  error: { code: "invalid_recipe" },
});
refusals.push({
  case: "wrong-cell-clamp-force",
  clampForceN: 80,
  result: wrongClampResult,
});

save("refusals.json", refusals);

const summary = {
  result: "passed",
  bundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  manualScenarioDigest: manualAdmitted.digest,
  nativeScenarioDigest: admitted.digest,
  cellId: cell.cellId,
  cellModelHash: cell.modelHash,
  controllerSourceHash: cell.execution.controllerSourceHash,
  completedAtSeconds: completed.position.time / 1_000_000,
  inFlightInterruptSeconds: interruptTime / 1_000_000,
  packingReleaseSaveSeconds: atPackingRelease.run.position.time / 1_000_000,
  reported: baselineBalance.reported,
  remainingBatterMg: baselineBalance.remainingMg,
  refusalCount: refusals.length,
};
save("summary.json", summary);
console.log(JSON.stringify(summary, null, 2));
