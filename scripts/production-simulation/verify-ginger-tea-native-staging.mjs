import {
  beginRun,
  driveRun,
  evidenceDirectory,
  evidenceWriter,
  inspectPending,
  pendingInspection,
  pinnedEngine,
  reported,
  sameId,
  value,
} from "./execution-journey.mjs";
import assert from "node:assert/strict";
import {
  gingerBlackTeaRecipeInput,
  compileGingerBlackTeaRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-black-tea.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell } from "./build-execution-bundle.mjs";

const output = evidenceDirectory("Choose a fresh evidence directory");
const save = evidenceWriter(output);
const engine = await pinnedEngine();
const { E, runtime } = engine;

const cell = await prepareCell(runtime, "tea-pan-cell", {
  fixture: "pan-staging",
});
assert.equal(cell.fixture, "persistent-pan-staging/1");
assert.equal(cell.robot, "fairino-fr10");
save("cell-definition.json", cell);

const input = gingerBlackTeaRecipeInput();
const manualScenario = value(await compileGingerBlackTeaRecipe(input));
const manualAdmitted = value(await E.admitScenario(manualScenario));
assert.equal(manualScenario.cells.length, 0);

const scenario = value(await compileGingerBlackTeaRecipe(input, cell));
const admitted = value(await E.admitScenario(scenario));
assert.equal(scenario.cells.length, 1);
assert.equal(scenario.cells[0].id, "tea-pan-cell");

save("recipe.json", {
  kind: "ginger-black-tea-recipe",
  panStaging: "fairino-fr10",
  recipe: input,
});
save("execution.json", manifest);
save("scenario.json", scenario);

function open(activeScenario, saved, leg) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells: [cell],
    runId: "ginger-black-tea-native-staging-acceptance",
    executionId: `tea-${leg}`,
    hostSession: `host-${leg}`,
    scenario: activeScenario,
    saved,
  });
}

function drive(host, until = 10_800_000_000) {
  return driveRun(host, {
    until,
    calls: 2000,
    bound: "Ginger black tea native-staging run exceeded its execution bound",
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
    "Synthetic extraction review for native staging acceptance",
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
  for (const {
    sequence: _sequence,
    execution: _execution,
    ...event
  } of run.events)
    if (!["command-admitted", "pause-settled"].includes(event.kind))
      events.push(event);
  return events;
}

// 1. On-time two-batch run with native MuJoCo pan staging
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
for (const batch of [0, 1]) {
  assert.equal(task(normal.run, batch, "stage-pan").kind, "completed");
  assert.ok(
    task(normal.run, batch, "stage-pan").completedAt <=
      task(normal.run, batch, "handoff-staged-pan").startedAt,
  );
  assert.ok(
    task(normal.run, batch, "handoff-staged-pan").completedAt <=
      task(normal.run, batch, "prepare-ginger-and-water").startedAt,
  );
}
for (const carrier of normal.run.carriers) {
  assert.equal(carrier.bound, null);
  assert.equal(carrier.custody.kind, "stored");
  assert.match(carrier.custody.storage, /^clean-/);
}
save("on-time.json", await original.handle({ kind: "save" }));
await original.handle({ kind: "dispose" });

// 2. Stop native pan-staging in-flight, save, dispose Wasm worker, and resume without duplicate custody
const stagePan0 = task(normal.run, 0, "stage-pan");
const interruptTime = stagePan0.startedAt + 10_000_000;

const movingHost = await open(scenario, null, "moving");
const moving = await drive(movingHost, interruptTime);
assert.equal(task(moving.run, 0, "stage-pan").kind, "executing");
assert.equal(task(moving.run, 0, "prepare-ginger-and-water").kind, "waiting");
const pan1InFlight = moving.run.carriers.find(sameId.bind(null, "pan-1"));
assert.equal(pan1InFlight.custody.kind, "transport");
assert.equal(pan1InFlight.custody.task, "tea-batches#0/stage-pan");
assert.equal(
  (await movingHost.handle({ kind: "pause", commandId: "pause-pan-in-motion" }))
    .receipt.status,
  "accepted",
);
const movingSave = await movingHost.handle({ kind: "save" });
assert.equal(movingSave.kind, "saved");
save("pan-staging-in-flight.json", movingSave);
await movingHost.handle({ kind: "dispose" });

const resumedMotionHost = await open(scenario, movingSave, "motion-restored");
const resumedMotion = await finish(
  resumedMotionHost,
  await drive(resumedMotionHost),
  true,
);
assert.deepEqual(resumedMotion.run.lots, normal.run.lots);
assert.deepEqual(resumedMotion.run.carriers, normal.run.carriers);
assert.deepEqual(processEvents(resumedMotion.run), processEvents(normal.run));
save("pan-staging-restored.json", resumedMotion);
await resumedMotionHost.handle({ kind: "dispose" });

// 3. Occupied prep bench leaves staged pan supported in the native rack
const occupied = structuredClone(scenario);
occupied.carriers.push(
  { id: "return-pan-1", storage: "prep-bench" },
  { id: "return-pan-2", storage: "prep-bench" },
);
const occupiedHost = await open(occupied, null, "occupied");
const occupiedRun = await drive(occupiedHost);
assert.equal(occupiedRun.run.status.kind, "blocked");
assert.equal(task(occupiedRun.run, 0, "stage-pan").kind, "completed");
assert.equal(task(occupiedRun.run, 0, "handoff-staged-pan").kind, "waiting");
assert.equal(
  task(occupiedRun.run, 0, "prepare-ginger-and-water").kind,
  "waiting",
);
save("occupied-prep-bench.json", await occupiedHost.handle({ kind: "save" }));
await occupiedHost.handle({ kind: "dispose" });

// 4. Worker unavailable across first strain deadline: save during extraction, reopen, save during held review, reopen, reject late Batch 0
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
heldSave.artifacts = [...extractingSave.artifacts, ...heldSave.artifacts];
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

// 5. CTC tea with native pan staging and invalid fixture refusal
const ctcInput = gingerBlackTeaRecipeInput();
ctcInput.tea = "ctc";
ctcInput.steepSeconds = 120;
const ctcScenario = value(await compileGingerBlackTeaRecipe(ctcInput, cell));
const ctcHost = await open(ctcScenario, null, "ctc");
const ctc = await finish(ctcHost, await drive(ctcHost), true);
assert.equal(reported(ctc.run, "servings"), 4);
save("ctc.json", await ctcHost.handle({ kind: "save" }));
await ctcHost.handle({ kind: "dispose" });
ctcInput.steepSeconds = 240;
assert.equal((await compileGingerBlackTeaRecipe(ctcInput, cell)).ok, false);

const wrongFixtureCell = structuredClone(cell);
wrongFixtureCell.fixture = "persistent-rack/1";
const wrongFixtureResult = await compileGingerBlackTeaRecipe(
  input,
  wrongFixtureCell,
);
assert.deepEqual(wrongFixtureResult, {
  ok: false,
  error: { code: "invalid_ginger_black_tea_recipe" },
});
save("refusals.json", [
  {
    case: "ctc-out-of-range-steep-seconds",
    steepSeconds: 240,
  },
  {
    case: "wrong-cell-fixture",
    fixture: "persistent-rack/1",
    result: wrongFixtureResult,
  },
]);

const report = {
  result: "passed",
  scope:
    "Native MuJoCo Wasm clean-pan staging (tea-pan-cell, persistent-pan-staging/1, fairino-fr10) with in-flight checkpoint interruption, fresh-worker restore, extraction deadline delay, and held review",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  manualScenarioDigest: manualAdmitted.digest,
  nativeScenarioDigest: admitted.digest,
  cellId: cell.cellId,
  cellModelHash: cell.modelHash,
  controllerSourceHash: cell.execution.controllerSourceHash,
  inFlightInterruptSeconds: interruptTime / 1_000_000,
  interruptedTransferRestoredExactly: true,
  occupiedPrepBenchBlocksPreparation: true,
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
};
save("report.json", report);
console.log(JSON.stringify(report, null, 2));
