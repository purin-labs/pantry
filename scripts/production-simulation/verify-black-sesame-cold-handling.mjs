import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  blackSesameRecipeInput,
  compileBlackSesameRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/black-sesame.ts";
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

const cell = await prepareCell(runtime, "sesame-cold-cell");
assert.equal(cell.fixture, "persistent-rack/1");
assert.equal(cell.robot, "fairino-fr10");
assert.deepEqual(cell.ingredients, {
  massKg: 1,
  forwardMm: 0,
  lateralMm: 0,
});
assert.equal(cell.clampForceN, 100);
save("cell-definition.json", cell);

const input = blackSesameRecipeInput();
const manualScenario = value(await compileBlackSesameRecipe(input));
const manualAdmitted = value(await E.admitScenario(manualScenario));
assert.equal(manualScenario.cells.length, 0);

const scenario = value(await compileBlackSesameRecipe(input, cell));
const admitted = value(await E.admitScenario(scenario));
assert.equal(scenario.cells.length, 1);
assert.equal(scenario.cells[0].id, "sesame-cold-cell");

save("recipe.json", {
  kind: "black-sesame-recipe",
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
      runId: "black-sesame-cold-carrier-acceptance",
      executionId: `sesame-${leg}`,
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

async function drive(host, until) {
  for (let turn = 0; turn < 2000; turn++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (
      reply.view.time >= until ||
      ["completed", "blocked", "stopped-at-limit"].includes(
        reply.view.status.kind,
      )
    ) {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      return state.run;
    }
  }
  throw new Error(
    "Black sesame cold-handling run exceeded its execution bound",
  );
}

function sameId(id, item) {
  return item.id === id;
}
function batchTask(run, batchIndex, key) {
  const id = `sesame-batches#${batchIndex}/${key}`;
  const found = run.tasks.find(sameId.bind(null, id));
  assert.ok(found, `Missing task ${id}`);
  return found;
}
function reported(run, destination) {
  let amount = 0;
  for (const event of run.events)
    if (event.kind === "quantity-reported" && event.destination === destination)
      amount += event.quantity.amount;
  return amount;
}
function bottles(run) {
  const result = [];
  for (const lot of run.lots)
    if (lot.product === "concentrate") {
      assert.equal(lot.holder.kind, "storage");
      assert.ok(lot.remaining.amount >= 0 && lot.remaining.amount <= 380_000);
      result.push({
        lot: lot.id,
        bottle: lot.holder.storage,
        remainingMg: lot.remaining.amount,
        lineage: lot.lineage,
      });
    }
  return result;
}
function sumBottle(total, bottle) {
  return total + bottle.remainingMg;
}
function partiallyUsed(bottle) {
  return bottle.remainingMg > 0 && bottle.remainingMg < 380_000;
}
function concentrateShortage(blocker) {
  return blocker.kind === "material" && blocker.product === "concentrate";
}
function massBalance(run) {
  let amount = 0;
  for (const lot of run.lots)
    if (lot.remaining.unit === "milligram") amount += lot.remaining.amount;
  for (const event of run.events)
    if (
      event.kind === "quantity-reported" &&
      event.role !== "intermediate-stock" &&
      event.quantity.unit === "milligram"
    )
      amount += event.quantity.amount;
  return amount;
}
function withoutHostEvents(run) {
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

// 1. Baseline uninterrupted run with native Wasm cold-carrier transfer
const uninterrupted = await open(scenario, null, "uninterrupted");
const control = await drive(uninterrupted, 21_600_000_000);
assert.equal(control.status.kind, "completed");
assert.equal(reported(control, "drinks-served"), 12);
assert.equal(reported(control, "drink-mass"), 3_432_000);
assert.equal(bottles(control).reduce(sumBottle, 0), 608_000);
assert.equal(massBalance(control), 4_084_000);

for (const batchIndex of [0, 1]) {
  const coolingRelease = batchTask(
    control,
    batchIndex,
    "assumed-cooling-release",
  );
  const stageCold = batchTask(control, batchIndex, "stage-cold-carrier");
  const transferCold = batchTask(control, batchIndex, "transfer-cold-carrier");
  const handoffCold = batchTask(control, batchIndex, "handoff-cold-carrier");
  const fillBottleA = batchTask(control, batchIndex, "wash-and-fill-bottle-a");
  const fillBottleB = batchTask(control, batchIndex, "wash-and-fill-bottle-b");

  assert.equal(transferCold.kind, "completed");
  assert.ok(stageCold.startedAt >= coolingRelease.completedAt);
  assert.ok(transferCold.startedAt >= stageCold.completedAt);
  assert.ok(handoffCold.startedAt >= transferCold.completedAt);
  assert.ok(fillBottleA.startedAt >= handoffCold.completedAt);
  assert.ok(fillBottleB.startedAt >= handoffCold.completedAt);
}
for (const carrier of control.carriers) {
  assert.equal(carrier.bound, null);
  assert.equal(carrier.custody.kind, "stored");
}
save("baseline.json", await uninterrupted.handle({ kind: "save" }));
await uninterrupted.handle({ kind: "dispose" });

// 2. Interrupt native cold-carrier transfer in-flight after pickup, save, dispose Wasm worker, restore, and pause/reopen at partial bottle
const transfer0 = batchTask(control, 0, "transfer-cold-carrier");
const interruptTime = transfer0.startedAt + 10_000_000;

const original = await open(scenario, null, "in-flight");
const inFlight = await drive(original, interruptTime);
assert.equal(batchTask(inFlight, 0, "transfer-cold-carrier").kind, "executing");
const coldCarrierInFlight = inFlight.carriers.find(
  sameId.bind(null, "cold-container-carrier"),
);
assert.equal(coldCarrierInFlight.custody.kind, "transport");
assert.equal(
  coldCarrierInFlight.custody.task,
  "sesame-batches#0/transfer-cold-carrier",
);
assert.equal(reported(inFlight, "drinks-served"), 0);
assert.equal(bottles(inFlight).length, 0);

const pausedInFlight = await original.handle({
  kind: "pause",
  commandId: "pause-cold-carrier-in-flight",
  expectedControlRevision: inFlight.position.controlRevision,
});
assert.equal(pausedInFlight.kind, "commanded", JSON.stringify(pausedInFlight));
assert.equal(pausedInFlight.view.status.kind, "paused");
const inFlightSaved = await original.handle({ kind: "save" });
assert.equal(inFlightSaved.kind, "saved");
save("cold-carrier-in-flight.json", inFlightSaved);
await original.handle({ kind: "dispose" });

// Reopen from in-flight cold-carrier transfer in a fresh Wasm worker and drive to partial bottle
const resumedFromTransfer = await open(
  scenario,
  inFlightSaved,
  "resumed-from-transfer",
);
const partial = await drive(resumedFromTransfer, 2_250_000_000);
assert.ok(reported(partial, "drinks-served") > 0);
assert.ok(bottles(partial).some(partiallyUsed));
const pausedPartial = await resumedFromTransfer.handle({
  kind: "pause",
  commandId: "pause-partial-bottle",
  expectedControlRevision: partial.position.controlRevision,
});
assert.equal(pausedPartial.kind, "commanded", JSON.stringify(pausedPartial));
assert.equal(pausedPartial.view.status.kind, "paused");
const partialSaved = await resumedFromTransfer.handle({ kind: "save" });
assert.equal(partialSaved.kind, "saved");
save("partial-bottle.json", partialSaved);
await resumedFromTransfer.handle({ kind: "dispose" });

// Reopen from partial bottle and drive through Batch 1 exhaustion (10 drinks served, 2 waiting on Batch 2)
const restored = await open(scenario, partialSaved, "restored");
const waiting = await drive(restored, 6_000_000_000);
assert.equal(reported(waiting, "drinks-served"), 10);
assert.equal(bottles(waiting).reduce(sumBottle, 0), 0);
let shortages = 0;
for (const task of waiting.tasks)
  if (
    task.kind === "waiting" &&
    task.subject.key === "dose" &&
    task.blockers.some(concentrateShortage)
  )
    shortages++;
assert.equal(shortages, 2);
save("shortage.json", await restored.handle({ kind: "save" }));

// Complete the run and prove exact equivalence with uninterrupted baseline
const final = await drive(restored, 21_600_000_000);
assert.equal(final.status.kind, "completed");
assert.equal(reported(final, "drinks-served"), 12);
assert.equal(reported(final, "drink-mass"), 3_432_000);
assert.equal(bottles(final).reduce(sumBottle, 0), 608_000);
assert.equal(massBalance(final), 4_084_000);
for (const carrier of final.carriers) assert.equal(carrier.bound, null);
assert.deepEqual(withoutHostEvents(final), withoutHostEvents(control));
assert.deepEqual(final.lots, control.lots);
assert.deepEqual(final.carriers, control.carriers);
save("completed.json", await restored.handle({ kind: "save" }));
await restored.handle({ kind: "dispose" });

// 3. Early replenishment must wait for an empty bottle and released cold-carrier
const congestedInput = blackSesameRecipeInput();
congestedInput.batchArrivalsSeconds = [0, 0];
congestedInput.orderArrivalsSeconds = [];
for (let order = 0; order < 12; order++)
  congestedInput.orderArrivalsSeconds.push(4_200 + order * 15);
const congested = await open(
  value(await compileBlackSesameRecipe(congestedInput, cell)),
  null,
  "congested",
);
const congestedFinal = await drive(congested, 21_600_000_000);
assert.equal(congestedFinal.status.kind, "completed");
for (const bottle of ["bottle-a", "bottle-b"]) {
  let emptied = 0;
  for (const event of congestedFinal.events)
    if (
      event.kind === "lot-consumed" &&
      event.lot === `sesame-batches#0/${bottle}`
    )
      emptied = Math.max(emptied, event.time);
  const refill = batchTask(congestedFinal, 1, `wash-and-fill-${bottle}`);
  assert.ok(refill.startedAt >= emptied && emptied > 0);
}
save("bottle-congestion.json", {
  input: congestedInput,
  saved: await congested.handle({ kind: "save" }),
});
await congested.handle({ kind: "dispose" });

// 4. Overweight batch refusal and explicit excess disposition + roast refresh
const overweight = blackSesameRecipeInput();
overweight.evaporationMg = 0;
overweight.residueMg = 0;
overweight.spillMg = 0;
overweight.waterAddedMg = 0;
const overweightRefused = await compileBlackSesameRecipe(overweight, cell);
assert.deepEqual(overweightRefused, {
  ok: false,
  error: { code: "concentrate_mass_balance" },
});
overweight.excessDiscardedMg = 2_000;
overweight.roast = "refresh";
const excessScenario = value(await compileBlackSesameRecipe(overweight, cell));
const excess = await open(excessScenario, null, "excess");
const excessFinal = await drive(excess, 21_600_000_000);
assert.equal(excessFinal.status.kind, "completed");
assert.equal(reported(excessFinal, "excess-discarded"), 4_000);
assert.equal(reported(excessFinal, "drinks-served"), 12);
assert.equal(massBalance(excessFinal), 4_044_000);
save("excess-disposition.json", {
  input: overweight,
  saved: await excess.handle({ kind: "save" }),
});
await excess.handle({ kind: "dispose" });

// 5. Invalid cell fixture/payload/clamp refusals
const refusals = [
  {
    case: "unreconciled-concentrate-mass-balance",
    result: overweightRefused,
  },
];
const wrongMassCell = structuredClone(cell);
wrongMassCell.ingredients.massKg = 2;
const wrongMassResult = await compileBlackSesameRecipe(input, wrongMassCell);
assert.deepEqual(wrongMassResult, {
  ok: false,
  error: { code: "invalid_black_sesame_recipe" },
});
refusals.push({
  case: "wrong-cell-payload-mass",
  massKg: 2,
  result: wrongMassResult,
});

const wrongClampCell = structuredClone(cell);
wrongClampCell.clampForceN = 80;
const wrongClampResult = await compileBlackSesameRecipe(input, wrongClampCell);
assert.deepEqual(wrongClampResult, {
  ok: false,
  error: { code: "invalid_black_sesame_recipe" },
});
refusals.push({
  case: "wrong-cell-clamp-force",
  clampForceN: 80,
  result: wrongClampResult,
});
save("refusals.json", refusals);

const report = {
  result: "passed",
  scope:
    "Native MuJoCo Wasm cold-container carrier transfer (sesame-cold-cell, persistent-rack/1, fairino-fr10) with checkpoint interruption, resume, bottle contention, and mass balance",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  manualScenarioDigest: manualAdmitted.digest,
  nativeScenarioDigest: admitted.digest,
  cellId: cell.cellId,
  cellModelHash: cell.modelHash,
  controllerSourceHash: cell.execution.controllerSourceHash,
  inFlightInterruptSeconds: interruptTime / 1_000_000,
  firstBatchServed: 10,
  waitingForSecondBatch: shortages,
  drinksServed: 12,
  inputMassMg: 4_084_000,
  servedMassMg: 3_432_000,
  retainedConcentrateMg: 608_000,
  partialBottles: bottles(partial),
  finalBottles: bottles(final),
  exactContinuationFromMidTransferAndPartialBottle: true,
  bottleReuseWaitsForEmpty: true,
  excessAdmissionRefused: true,
  excessDiscardedMg: 4_000,
  refusalCount: refusals.length,
};
save("report.json", report);
console.log(JSON.stringify(report, null, 2));
