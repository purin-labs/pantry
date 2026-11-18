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
  gingerMilkTeaRecipeInput,
  compileGingerMilkTeaRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-milk-tea.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import {
  compileMixedTeaRecipe,
  mixedTeaRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/mixed-tea.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell } from "./build-execution-bundle.mjs";

const output = evidenceDirectory();
const save = evidenceWriter(output);
const engine = await pinnedEngine();
const { E, runtime } = engine;
const cell = await prepareCell(runtime, "tea-pan-cell", {
  fixture: "pan-staging",
});
save("cell-definition.json", cell);
const input = gingerMilkTeaRecipeInput();
const scenario = value(await compileGingerMilkTeaRecipe(input, cell));
value(await E.admitScenario(scenario));
save("recipe.json", { kind: "ginger-milk-tea-recipe", recipe: input });
save("execution.json", manifest);
save("scenario.json", scenario);

function open(scenario, saved, leg) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells: [cell],
    runId: "ginger-milk-tea-acceptance",
    executionId: `tea-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved,
  });
}
function drive(host, until = 14_400_000_000) {
  return driveRun(host, {
    until,
    calls: 2000,
    bound: "Tea exceeded its execution bound",
  });
}
function task(run, batch, key) {
  for (const entry of run.tasks)
    if (entry.id === `milk-tea-batches#${batch}/${key}`) return entry;
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
  assert.equal(
    boundary.run.status.kind,
    "completed",
    JSON.stringify(boundary.run.status),
  );
  return { ...boundary, timings };
}
function massBalance(run, expected = 1_858_000) {
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
  assert.equal(amount, expected);
}

function remaining(run, id) {
  for (const lot of run.lots)
    if (lot.id === `stock-${id}`) return lot.remaining.amount;
  throw new Error(`Missing stock ${id}`);
}
function heatTasks(run, batch) {
  const result = [];
  for (const step of run.tasks)
    if (step.id.startsWith(`milk-tea-batches#${batch}/heat-and-stir-to-`))
      result.push(step);
  return result;
}
function assertClean(run) {
  for (const carrier of run.carriers) {
    assert.equal(carrier.bound, null);
    assert.equal(carrier.custody.kind, "stored");
    assert.match(carrier.custody.storage, /^clean-/);
  }
}
function assertNoMilkBeforeReview(run) {
  assert.equal(remaining(run, "milk"), 360_000);
  assert.equal(remaining(run, "sugar"), 50_000);
  for (const step of heatTasks(run, 0)) assert.equal(step.kind, "waiting");
}

const original = await open(scenario, null, "on-time");
const first = await drive(original);
assert.equal(first.run.status.kind, "awaiting-inspection");
assertNoMilkBeforeReview(first.run);
const normal = await finish(original, first, false);
assert.equal(reported(normal.run, "servings"), 4);
assert.equal(reported(normal.run, "milk-tea-mass"), 1_140_000);
assert.equal(task(normal.run, 0, "stage-both-pans").startedAt, 70_000_000);
assert.ok(
  task(normal.run, 0, "stage-both-pans").completedAt <
    task(normal.run, 0, "add-tea").startedAt,
);
assert.ok(
  task(normal.run, 1, "stage-both-pans").startedAt >=
    task(normal.run, 0, "return-clean-pan-b-and-strainer").completedAt,
);
for (const batch of [0, 1]) {
  assert.equal(task(normal.run, batch, "discard-extract").kind, "skipped");
  assert.equal(
    task(normal.run, batch, "warm-cups-and-drain-water").kind,
    "completed",
  );
  for (const step of heatTasks(normal.run, batch))
    assert.equal(step.kind, "completed");
}
for (const batch of [0, 1]) {
  assert.equal(task(normal.run, batch, "stage-pan-b").kind, "completed");
  assert.ok(
    task(normal.run, batch, "stage-pan-b").completedAt <=
      task(normal.run, batch, "handoff-staged-pan-b").startedAt,
  );
  assert.ok(
    task(normal.run, batch, "handoff-staged-pan-b").completedAt <=
      task(normal.run, batch, "prepare-ginger-and-water").startedAt,
  );
}
assertClean(normal.run);
massBalance(normal.run);
save("on-time.json", await original.handle({ kind: "save" }));
await original.handle({ kind: "dispose" });

// Pause while the pan is airborne, discard its worker, then resume the same world.
const movingHost = await open(scenario, null, "moving");
const moving = await drive(
  movingHost,
  task(normal.run, 0, "stage-pan-b").startedAt + 10_000_000,
);
assert.equal(task(moving.run, 0, "stage-pan-b").kind, "executing");
assert.equal(task(moving.run, 0, "prepare-ginger-and-water").kind, "waiting");
assert.equal(remaining(moving.run, "ginger"), 30_000);
assert.equal(
  (await movingHost.handle({ kind: "pause", commandId: "pause-pan-in-motion" }))
    .receipt.status,
  "accepted",
);
const movingSave = await movingHost.handle({ kind: "save" });
assert.equal(movingSave.kind, "saved");
save("pan-in-motion.json", movingSave);
await movingHost.handle({ kind: "dispose" });
const resumedMotionHost = await open(scenario, movingSave, "motion-restored");
const resumedMotion = await finish(
  resumedMotionHost,
  await drive(resumedMotionHost),
  false,
);
assert.deepEqual(resumedMotion.run.lots, normal.run.lots);
assert.deepEqual(resumedMotion.run.carriers, normal.run.carriers);
assert.deepEqual(processEvents(resumedMotion.run), processEvents(normal.run));
save("motion-restored.json", resumedMotion);
await resumedMotionHost.handle({ kind: "dispose" });

// An occupied receiving position must leave the staged pan supported in the cell.
const occupied = structuredClone(scenario);
occupied.carriers.push({ id: "return-pan", storage: "receiving-position" });
const occupiedHost = await open(occupied, null, "occupied");
const occupiedRun = await drive(occupiedHost);
assert.equal(occupiedRun.run.status.kind, "blocked");
assert.equal(task(occupiedRun.run, 0, "stage-pan-b").kind, "completed");
assert.equal(task(occupiedRun.run, 0, "handoff-staged-pan-b").kind, "waiting");
assert.equal(
  task(occupiedRun.run, 0, "prepare-ginger-and-water").kind,
  "waiting",
);
assert.equal(remaining(occupiedRun.run, "water"), 1_400_000);
assert.equal(remaining(occupiedRun.run, "ginger"), 30_000);
save(
  "occupied-receiving-position.json",
  await occupiedHost.handle({ kind: "save" }),
);
await occupiedHost.handle({ kind: "dispose" });

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
const straining = await drive(lateHost, due + 120_000_000);
assert.equal(task(straining.run, 0, "strain-into-pan-b").kind, "completed");
assert.notEqual(task(straining.run, 0, "wash-pan-a").kind, "completed");
const extract = straining.run.lots.find(
  (lot) => lot.product === "strained-tea",
);
assert.equal(extract.disposition, "held");
assert.equal(extract.holder.kind, "carrier");
assert.equal(extract.holder.carrier, "pan-2");
assert.deepEqual(extract.lineage, ["milk-tea-batches#0/infusion"]);
save("just-strained.json", straining);
const late = await drive(lateHost);
assertNoMilkBeforeReview(late.run);
const lateTiming = teaStrainTiming(
  congested,
  late.view.resourceHistory,
  late.view.inspections[0].task,
);
assert.equal(lateTiming.kind, "late");
assert.equal(lateTiming.lateSeconds, 90);
const heldSave = await lateHost.handle({ kind: "save" });
assert.equal(heldSave.kind, "saved", JSON.stringify(heldSave));
save("late-held.json", heldSave);
await lateHost.handle({ kind: "dispose" });

const restored = await open(congested, heldSave, "held-restored");
const restoredHeld = await drive(restored);
assertNoMilkBeforeReview(restoredHeld.run);
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
assert.equal(reported(rejected.run, "milk-tea-mass"), 570_000);
assert.equal(reported(rejected.run, "rejected-extract"), 365_000);
assert.equal(remaining(rejected.run, "milk"), 180_000);
assert.equal(remaining(rejected.run, "sugar"), 25_000);
assert.equal(remaining(rejected.run, "water"), 300_000);
for (const key of [
  "add-milk-and-sugar-at-55c",
  "warm-cups-and-drain-water",
  "serve-milk-tea",
])
  assert.equal(task(rejected.run, 0, key).kind, "skipped");
for (const step of heatTasks(rejected.run, 0)) {
  assert.equal(step.kind, "skipped");
  assert.equal(step.outcome, "reject");
  for (const resource of rejected.view.resourceHistory.resources)
    for (const interval of resource.intervals)
      assert.notEqual(interval.task, step.id);
}
assertClean(rejected.run);
massBalance(rejected.run);
const completed = await restored.handle({ kind: "save" });
assert.equal(completed.kind, "saved", JSON.stringify(completed));
save("completed.json", completed);
await restored.handle({ kind: "dispose" });
const completedHost = await open(congested, completed, "completed-restored");
assert.equal((await drive(completedHost)).run.status.kind, "completed");
await completedHost.handle({ kind: "dispose" });

const controlHost = await open(congested, null, "uninterrupted");
const control = await finish(controlHost, await drive(controlHost), true);
assert.deepEqual(rejected.run.lots, control.run.lots);
assert.deepEqual(rejected.run.carriers, control.run.carriers);
assert.deepEqual(processEvents(rejected.run), processEvents(control.run));
await controlHost.handle({ kind: "dispose" });

// A single available pan cannot start the atomic two-pan reservation.
const missingPanInput = gingerMilkTeaRecipeInput();
missingPanInput.initialDirtyPan = false;
const missingPan = value(
  await compileGingerMilkTeaRecipe(missingPanInput, cell),
);
missingPan.carriers = missingPan.carriers.filter(
  (carrier) => carrier.id !== "pan-2",
);
const blockedHost = await open(missingPan, null, "missing-pan");
const blocked = await drive(blockedHost);
assert.equal(blocked.run.status.kind, "blocked");
for (const step of blocked.run.tasks) assert.equal(step.kind, "waiting");
save("missing-pan.json", blocked);
await blockedHost.handle({ kind: "dispose" });

const boiling = gingerMilkTeaRecipeInput();
boiling.finishingTrace[2].celsius = 100;
assert.equal((await compileGingerMilkTeaRecipe(boiling, cell)).ok, false);
// The boundary refuses an unconditional consumer of material that can be skipped.
const invalidConsumer = structuredClone(scenario);
const serve = invalidConsumer.workflows[0].tasks.find(
  (step) => step.key === "serve-milk-tea",
);
serve.executor = serve.executor.work;
assert.equal((await E.admitScenario(invalidConsumer)).ok, false);
// Opposite decisions may share input; the same decision may not consume it twice.
const doubleConsumption = structuredClone(scenario);
const discard = doubleConsumption.workflows[0].tasks.find(
  (step) => step.key === "discard-extract",
);
discard.executor.outcome = "accept";
assert.equal((await E.admitScenario(doubleConsumption)).ok, false);

// Overlapping black and milk orders share exactly two pans and one worker.
const mixedInput = mixedTeaRecipeInput();
const mixed = value(await compileMixedTeaRecipe(mixedInput, cell));
value(await E.admitScenario(mixed));
save("mixed-recipe.json", { kind: "mixed-tea-recipe", recipe: mixedInput });
save("mixed-scenario.json", mixed);
const mixedHost = await open(mixed, null, "mixed-control");
const mixedNormal = await finish(mixedHost, await drive(mixedHost), false);
assert.equal(reported(mixedNormal.run, "servings"), 6);
assert.equal(mixedNormal.run.carriers.length, 5);
const blackClean = mixedNormal.run.tasks.find(blackCleanTask);
assert.equal(blackClean.kind, "completed");
assert.ok(
  task(mixedNormal.run, 0, "stage-both-pans").startedAt >=
    blackClean.completedAt,
);
assert.ok(
  task(mixedNormal.run, 1, "stage-both-pans").startedAt >=
    task(mixedNormal.run, 0, "return-clean-pan-b-and-strainer").completedAt,
);
assertClean(mixedNormal.run);
massBalance(mixedNormal.run, 2_351_000);
save("mixed-on-time.json", await mixedHost.handle({ kind: "save" }));
await mixedHost.handle({ kind: "dispose" });

const milkTiming = mixedNormal.timings.find(firstMilkTiming);
assert.equal(milkTiming.kind, "on-time");
const mixedLate = structuredClone(mixed);
mixedLate.availability = [
  {
    id: "shared-worker-at-other-station",
    resource: "tea-worker",
    interval: {
      start: milkTiming.dueAt - 1_000_000,
      end: milkTiming.dueAt + 90_000_000,
    },
  },
];
save("mixed-late-scenario.json", mixedLate);
const mixedMovingHost = await open(mixedLate, null, "mixed-moving");
const blackReview = await drive(mixedMovingHost);
assert.equal(
  blackReview.view.inspections.find(pendingInspection).task,
  "tea-batches#0/inspect-strained-tea",
);
await inspect(mixedMovingHost, blackReview.view, "accept", false);
const mixedMoving = await drive(
  mixedMovingHost,
  task(mixedNormal.run, 0, "stage-pan-b").startedAt + 10_000_000,
);
assert.equal(task(mixedMoving.run, 0, "stage-pan-b").kind, "executing");
assert.equal(
  task(mixedMoving.run, 0, "prepare-ginger-and-water").kind,
  "waiting",
);
assert.equal(remaining(mixedMoving.run, "ginger"), 30_000);
assert.equal(
  (
    await mixedMovingHost.handle({
      kind: "pause",
      commandId: "pause-mixed-pan",
    })
  ).receipt.status,
  "accepted",
);
const mixedMovingSave = await mixedMovingHost.handle({ kind: "save" });
assert.equal(mixedMovingSave.kind, "saved");
save("mixed-pan-in-motion.json", mixedMovingSave);
await mixedMovingHost.handle({ kind: "dispose" });

const mixedRestoredHost = await open(
  mixedLate,
  mixedMovingSave,
  "mixed-motion-restored",
);
const mixedHeld = await drive(mixedRestoredHost);
assertNoMilkBeforeReview(mixedHeld.run);
const mixedHeldTiming = teaStrainTiming(
  mixedLate,
  mixedHeld.view.resourceHistory,
  mixedHeld.view.inspections.find(pendingInspection).task,
);
assert.equal(mixedHeldTiming.kind, "late");
assert.equal(mixedHeldTiming.lateSeconds, 90);
const mixedHeldSave = await mixedRestoredHost.handle({ kind: "save" });
assert.equal(mixedHeldSave.kind, "saved");
// The portable artifact includes the earlier native recording after worker replacement.
mixedHeldSave.artifacts = [
  ...mixedMovingSave.artifacts,
  ...mixedHeldSave.artifacts,
];
save("mixed-late-held.json", mixedHeldSave);
await mixedRestoredHost.handle({ kind: "dispose" });
const mixedHeldHost = await open(
  mixedLate,
  mixedHeldSave,
  "mixed-held-restored",
);
const mixedFinished = await finish(
  mixedHeldHost,
  await drive(mixedHeldHost),
  true,
);
assert.equal(reported(mixedFinished.run, "servings"), 4);
assert.equal(reported(mixedFinished.run, "rejected-servings"), 2);
assert.equal(reported(mixedFinished.run, "rejected-extract"), 365_000);
assert.equal(remaining(mixedFinished.run, "milk"), 180_000);
assert.equal(remaining(mixedFinished.run, "sugar"), 25_000);
assert.equal(remaining(mixedFinished.run, "water"), 300_000);
assertClean(mixedFinished.run);
massBalance(mixedFinished.run, 2_351_000);
save("mixed-restored.json", mixedFinished);
await mixedHeldHost.handle({ kind: "dispose" });
const mixedControlHost = await open(mixedLate, null, "mixed-uninterrupted");
const mixedControl = await finish(
  mixedControlHost,
  await drive(mixedControlHost),
  true,
);
assert.deepEqual(mixedFinished.run.lots, mixedControl.run.lots);
assert.deepEqual(mixedFinished.run.carriers, mixedControl.run.carriers);
assert.deepEqual(
  processEvents(mixedFinished.run),
  processEvents(mixedControl.run),
);
await mixedControlHost.handle({ kind: "dispose" });

function blackCleanTask(step) {
  return step.id === "tea-batches#0/return-clean-equipment";
}
function firstMilkTiming(timing) {
  return timing.task === "milk-tea-batches#0/inspect-strained-tea";
}

save("report.json", {
  result: "passed",
  scope:
    "FR10 empty-pan staging on a rigid insert; declared two-pan process. No bare-pan grasp, liquid physics, measured temperature or cup cooling",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  nativeStagingBeforeExtraction: true,
  mixedTea: {
    normalServings: 6,
    lateRunServings: 4,
    rejectedServings: 2,
    lateSeconds: 90,
    massMg: 2_351_000,
    exactContinuation: true,
  },
  interruptedTransferRestoredExactly: true,
  occupiedReceivingPositionBlocksExtraction: true,
  normalServings: 4,
  lateServingsRejected: 2,
  lateSeconds: 90,
  lateRunServings: 2,
  massMg: 1_858_000,
  exactContinuation: true,
  savedBeforeMilk: true,
  completedSkipRestored: true,
  dirtyPanCleanedBeforeUse: true,
  separatePanCustody: true,
  missingPanBlocked: true,
  milkPreservedOnRejectionMg: 180_000,
  sugarPreservedOnRejectionMg: 25_000,
  wrongLotRefused: true,
  duplicateDecisionIdempotent: true,
  finishingRangeC: input.finishRangeC,
  assumedFinishingTrace: input.finishingTrace,
  normalTimings: normal.timings,
  lateTimings: rejected.timings,
});
console.log(`Ginger milk tea acceptance passed: ${output}`);
