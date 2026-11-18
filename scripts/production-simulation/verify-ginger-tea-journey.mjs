import {
  beginRun,
  driveRun,
  evidenceDirectory,
  evidenceWriter,
  inspectPending,
  pendingInspection,
  pinnedEngine,
  processEvents,
  reported,
  value,
} from "./execution-journey.mjs";
import assert from "node:assert/strict";
import {
  gingerBlackTeaRecipeInput,
  compileGingerBlackTeaRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-black-tea.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";

const output = evidenceDirectory();
const save = evidenceWriter(output);
const engine = await pinnedEngine();
const { E } = engine;
const input = gingerBlackTeaRecipeInput();
const scenario = value(await compileGingerBlackTeaRecipe(input));
value(await E.admitScenario(scenario));
save("recipe.json", { kind: "ginger-black-tea-recipe", recipe: input });
save("execution.json", manifest);
save("scenario.json", scenario);

function open(scenario, saved, leg) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells: [],
    runId: "ginger-tea-acceptance",
    executionId: `tea-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved,
  });
}
function drive(host, until = 10_800_000_000) {
  return driveRun(host, {
    until,
    calls: 100,
    bound: "Tea exceeded its execution bound",
  });
}
function task(run, batch, key) {
  for (const entry of run.tasks)
    if (entry.id === `tea-batches#${batch}/${key}`) return entry;
  throw new Error(`Missing ${batch}/${key}`);
}
function inspect(host, view, outcome, checkRefusals) {
  return inspectPending(
    host,
    view,
    outcome,
    checkRefusals,
    "Synthetic extraction review for acceptance",
  );
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
