import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exportRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { openRehearsalDocument } from "../../packages/production-simulation/src/simulator/rehearsal-conversion.ts";
import { rehearsalSettings } from "../../packages/production-simulation/src/simulator/rehearsal-presets.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";
import { sampleSettings } from "../../packages/bakery-model/src/bakery.ts";
import { parseRunSnapshot } from "../../packages/bakery-model/src/bakery-run-snapshot.ts";

// These browser files were saved by the previous multi-tray engine. Since
// Plan 42F F1d they open through conversion onto the production scheduler.
const settings = rehearsalSettings(sampleSettings());

const directory = resolve(
  process.argv[2] ?? "output/playwright/browser-authored-chain",
);
function read(name) {
  return JSON.parse(readFileSync(`${directory}/${name}.json`, "utf8"));
}
async function restore(document) {
  const opened = await openRehearsalDocument(
    JSON.stringify(document),
    settings,
  );
  assert.equal(opened.kind, "ready", opened.message);
  return opened.conversion.plan;
}
function result(operation) {
  assert.equal(operation.kind, "bound");
  assert.ok(operation.experiment.evidence);
  return operation.experiment.evidence;
}
const plan = read("plan");
assert.equal(plan.schemaVersion, 4);
assert.equal(plan.operations.length, 5);
assert.equal(plan.operations[2].experiment.evidence, null);
assert.equal(plan.operations[3].kind, "awaiting-handoff");
assert.equal(plan.operations[4].kind, "awaiting-handoff");
const stopped = read("stopped-after-loading");
const loading = result(stopped.operations[2]);
assert.equal(loading.request.execution.backend, "browser");
assert.equal(loading.outcome.kind, "completed");
assert.ok(stopped.operations[2].handoff);
assert.equal(stopped.operations[3].experiment.evidence, null);
assert.equal(stopped.operations[4].kind, "awaiting-handoff");
const stoppedPlan = await restore(stopped);
assert.ok(
  stoppedPlan.operations.some(
    (operation) =>
      operation.start.kind === "continuation" &&
      operation.attempt.kind === "awaiting-evidence",
  ),
  "the reopened run resumes retrieval from the saved handoff",
);
const completed = read("completed");
assert.deepEqual(
  completed.operations[2],
  stopped.operations[2],
  "Loading must not rerun after reopening",
);
assert.deepEqual(completed.operations.slice(0, 2), plan.operations.slice(0, 2));
const retrieval = result(completed.operations[3]);
const rack = result(completed.operations[4]);
assert.deepEqual(retrieval.loading, loading);
assert.deepEqual(rack.loading, loading);
assert.deepEqual(rack.unloading, retrieval.unloading);
assert.equal(retrieval.unloading.request.execution.backend, "browser");
assert.equal(rack.racking.request.execution.backend, "browser");
assert.equal(rack.racking.outcome.kind, "completed");
assert.ok(completed.operations[3].handoff);
assert.equal(
  completed.operations[3].start.predecessorId,
  completed.operations[2].id,
);
assert.equal(
  completed.operations[4].start.predecessorId,
  completed.operations[3].id,
);
assert.equal(
  completed.operations[3].start.file,
  undefined,
  "Handoff bytes have one persistence owner",
);
const restored = await restore(completed);
const schedule = simulateProduction(restored);
assert.equal(schedule.kind, "complete");
const last = schedule.intervals.filter((task) => task.kind === "native").at(-1);
assert.equal(last.recording.kind, "bakery-physics-rack-sequence");
assert.equal(
  parseRunSnapshot({
    name: "Browser chain",
    document: JSON.parse(exportRehearsalWorkcells(restored)),
  }).kind,
  "rehearsal",
);
const failed = read("failed-and-blocked");
assert.notEqual(result(failed.operations[4]).racking.outcome.kind, "completed");
assert.equal(failed.operations[5].experiment.evidence, null);
assert.equal(failed.operations[6].kind, "awaiting-handoff");
const failedRun = await restore(failed);
const failureSchedule = simulateProduction(failedRun);
const held = failureSchedule.nativeHolds.find((hold) => hold.kind === "failed");
assert.ok(held, "the slip holds the cell");
assert.equal(failureSchedule.kind, "blocked");
const nextTray = failureSchedule.unresolvedWaits.find(
  (wait) => wait.batch !== held.operation.batchId,
);
assert.ok(nextTray, "the next tray waits for the held cell");
const mismatched = structuredClone(stopped);
mismatched.operations[2].handoff = completed.operations[3].handoff;
assert.equal(
  (await openRehearsalDocument(JSON.stringify(mismatched), settings)).kind,
  "rejected",
);
const report = {
  status: "passed",
  checks: [
    "unexecuted full plan",
    "actual browser backend on every new task",
    "stop and reopen preserve accepted loading and resumable state",
    "exact loading and retrieval prefixes retained",
    "new attempts do not replace prior accepted results",
    "one saved owner per handoff",
    "shared save envelope accepts version 4",
    "timeline and scene follow completed racking",
    "slip holds resources and blocks the next tray after reopen",
    "mismatched saved continuation rejected",
  ],
  endSeconds: schedule.end,
  failureEndSeconds: failureSchedule.end,
  engine: "production scheduler, through conversion",
};
writeFileSync(
  `${directory}/artifact-report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
