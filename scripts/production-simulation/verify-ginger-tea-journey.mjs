import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  gingerBlackTeaRecipeInput,
  compileGingerBlackTeaRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-black-tea.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh evidence directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false);
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
const input = gingerBlackTeaRecipeInput();
const scenario = value(await compileGingerBlackTeaRecipe(input));
value(await E.admitScenario(scenario));
save("recipe.json", { kind: "ginger-black-tea-recipe", recipe: input });
save("execution.json", manifest);
save("scenario.json", scenario);

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}
function save(name, data) {
  writeFileSync(join(output, name), `${canonicalJson(data)}\n`);
}
async function open(scenario, saved, leg) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const reply = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells: [],
    identity: {
      runId: "ginger-tea-acceptance",
      executionId: `tea-${leg}`,
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
        ? { kind: "scenario", scenario }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
  });
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  return host;
}
async function drive(host, until = 10_800_000_000) {
  for (let turn = 0; turn < 100; turn++) {
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
  throw new Error("Tea exceeded its execution bound");
}
function pendingInspection(item) {
  return item.kind === "pending";
}
function reported(run, destination) {
  let amount = 0;
  for (const event of run.events)
    if (event.kind === "quantity-reported" && event.destination === destination)
      amount += event.quantity.amount;
  return amount;
}
function task(run, batch, key) {
  for (const entry of run.tasks)
    if (entry.id === `tea-batches#${batch}/${key}`) return entry;
  throw new Error(`Missing ${batch}/${key}`);
}
async function inspect(host, view, outcome, checkRefusals) {
  const pending = view.inspections.find(pendingInspection);
  assert.ok(pending);
  const request = {
    kind: "inspect",
    commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/g, "-")}`,
    expectedControlRevision: view.controlRevision,
    task: pending.task,
    definition: pending.definition,
    lots: pending.lots,
    outcome,
    note: "Synthetic extraction review for acceptance",
  };
  if (checkRefusals) {
    const wrong = await host.handle({
      ...request,
      commandId: "wrong-tea-lot",
      lots: ["wrong-lot"],
    });
    assert.equal(wrong.receipt.reason, "inspection_binding_mismatch");
  }
  const reply = await host.handle(request);
  assert.equal(reply.kind, "commanded", JSON.stringify(reply));
  assert.equal(reply.receipt.status, "accepted", JSON.stringify(reply));
  const duplicate = await host.handle(request);
  assert.deepEqual(duplicate.receipt, reply.receipt);
}
async function finish(host, first, rejectLate) {
  let boundary = first;
  const timings = [];
  for (let reviews = 0; reviews < 6; reviews++) {
    if (boundary.run.status.kind !== "awaiting-inspection") break;
    const pending = boundary.view.inspections.find(pendingInspection);
    const timing = teaStrainTiming(
      boundary.run.definition.scenario,
      boundary.view.resourceHistory,
      pending.task,
    );
    assert.notEqual(timing.kind, "unavailable");
    timings.push({ task: pending.task, ...timing });
    for (const id of pending.lots) {
      let held = false;
      for (const lot of boundary.run.lots)
        if (lot.id === id) held = lot.disposition === "held";
      assert.equal(held, true);
    }
    await inspect(
      host,
      boundary.view,
      rejectLate && timing.kind === "late" ? "reject" : "accept",
      reviews === 0,
    );
    boundary = await drive(host);
  }
  if (boundary.run.status.kind !== "completed")
    save("failed-run.json", boundary);
  assert.equal(
    boundary.run.status.kind,
    "completed",
    JSON.stringify(boundary.run.status),
  );
  return { ...boundary, timings };
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
  assert.equal(amount, 986_000);
}
function processEvents(run) {
  const events = [];
  for (const { sequence, execution, ...event } of run.events)
    if (!["command-admitted", "pause-settled"].includes(event.kind))
      events.push(event);
  return events;
}

const original = await open(scenario, null, "on-time");
const first = await drive(original);
assert.equal(first.run.status.kind, "awaiting-inspection");
assert.equal(reported(first.run, "servings"), 0);
assert.equal(
  teaStrainTiming(
    scenario,
    first.view.resourceHistory,
    first.view.inspections[0].task,
  ).kind,
  "on-time",
);
assert.ok(
  task(first.run, 1, "heat-to-simmer").startedAt <
    task(first.run, 0, "strain-and-sweeten").startedAt,
);
assert.ok(
  task(first.run, 1, "place-pan-on-hob").startedAt >=
    task(first.run, 0, "move-pan-off-hob").startedAt,
);
const normal = await finish(original, first, true);
assert.equal(reported(normal.run, "servings"), 4);
assert.equal(reported(normal.run, "tea-mass"), 870_000);
massBalance(normal.run);
save("on-time.json", await original.handle({ kind: "save" }));
await original.handle({ kind: "dispose" });

// The existing availability calendar occupies the worker across the first
// strain deadline. Extraction continues on the same logical clock.
const due = normal.timings[0].dueAt;
const congested = structuredClone(scenario);
congested.availability = [
  {
    id: "worker-at-other-station",
    resource: "tea-worker",
    interval: { start: due - 1_000_000, end: due + 90_000_000 },
  },
];
value(await E.admitScenario(congested));
save("congested-scenario.json", congested);
const lateHost = await open(congested, null, "late");
const extracting = await drive(lateHost, due - 10_000_000);
assert.equal(extracting.run.position.time, due - 10_000_000);
assert.equal(task(extracting.run, 0, "steep").kind, "executing");
const paused = await lateHost.handle({
  kind: "pause",
  commandId: "pause-extraction",
});
assert.equal(paused.kind, "commanded", JSON.stringify(paused));
assert.equal(paused.view.status.kind, "paused");
const extractingSave = await lateHost.handle({ kind: "save" });
assert.equal(extractingSave.kind, "saved");
save("extracting.json", extractingSave);
await lateHost.handle({ kind: "dispose" });

const reopened = await open(congested, extractingSave, "extracting-restored");
const late = await drive(reopened);
const lateTiming = teaStrainTiming(
  congested,
  late.view.resourceHistory,
  late.view.inspections[0].task,
);
assert.equal(lateTiming.kind, "late");
assert.equal(lateTiming.lateSeconds, 90);
assert.equal(reported(late.run, "servings"), 0);
const heldSave = await reopened.handle({ kind: "save" });
assert.equal(heldSave.kind, "saved");
save("late-held.json", heldSave);
await reopened.handle({ kind: "dispose" });

const restored = await open(congested, heldSave, "held-restored");
const restoredHeld = await drive(restored);
assert.deepEqual(
  teaStrainTiming(
    congested,
    restoredHeld.view.resourceHistory,
    restoredHeld.view.inspections[0].task,
  ),
  lateTiming,
);
const rejected = await finish(restored, restoredHeld, true);
assert.equal(reported(rejected.run, "servings"), 2);
assert.equal(reported(rejected.run, "rejected-servings"), 2);
assert.equal(reported(rejected.run, "tea-mass"), 435_000);
assert.equal(reported(rejected.run, "rejected-tea-mass"), 435_000);
massBalance(rejected.run);
for (const carrier of rejected.run.carriers) {
  assert.equal(carrier.bound, null);
  assert.equal(carrier.custody.kind, "stored");
  assert.match(carrier.custody.storage, /^clean-/);
}
save("completed.json", await restored.handle({ kind: "save" }));
await restored.handle({ kind: "dispose" });

const controlHost = await open(congested, null, "uninterrupted");
const control = await finish(controlHost, await drive(controlHost), true);
assert.deepEqual(rejected.run.lots, control.run.lots);
assert.deepEqual(rejected.run.carriers, control.run.carriers);
assert.deepEqual(processEvents(rejected.run), processEvents(control.run));
await controlHost.handle({ kind: "dispose" });

const ctcInput = gingerBlackTeaRecipeInput();
ctcInput.tea = "ctc";
ctcInput.steepSeconds = 120;
const ctcScenario = value(await compileGingerBlackTeaRecipe(ctcInput));
const ctcHost = await open(ctcScenario, null, "ctc");
const ctc = await finish(ctcHost, await drive(ctcHost), true);
assert.equal(reported(ctc.run, "servings"), 4);
save("ctc.json", await ctcHost.handle({ kind: "save" }));
await ctcHost.handle({ kind: "dispose" });
ctcInput.steepSeconds = 240;
assert.equal((await compileGingerBlackTeaRecipe(ctcInput)).ok, false);
save("report.json", {
  result: "passed",
  scope:
    "Declared process and custody; no native pan handling, liquid physics or measured extraction quality",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  normalServings: 4,
  lateServingsRejected: 2,
  lateSeconds: lateTiming.lateSeconds,
  lateRunServings: 2,
  massMg: 986_000,
  exactContinuation: true,
  savedDuringExtraction: true,
  savedDuringHold: true,
  ctcServings: 4,
  wrongLotRefused: true,
  duplicateDecisionIdempotent: true,
  normalTimings: normal.timings,
  lateTimings: rejected.timings,
});
console.log(`Ginger tea acceptance passed: ${output}`);
