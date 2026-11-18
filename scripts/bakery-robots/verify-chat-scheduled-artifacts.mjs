import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextProductionExecution } from "../../packages/production-simulation/src/simulator/production-execution.ts";
import { parseRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the run saved by verify-chat-scheduled-browser.js through the
// rehearsal parser and the production scheduler.
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-chat-scheduled"),
);
const result = JSON.parse(
  readFileSync(join(evidence, "report.json"), "utf8"),
).checks;
assert.equal(result.result, "passed");
assert.ok(result.settledCommands.includes("edit_rehearsal"));
assert.deepEqual(result.reviewedChanges.ingredients, {
  massKg: 0.5,
  forwardMm: 0,
  lateralMm: 0,
});
assert.equal(result.reviewedChanges.unaffectedTrayResults, 1);
// Each chat edit changes the plan once.
assert.deepEqual(
  result.edits.map((edit) => [edit.edit, edit.epochs[1] - edit.epochs[0]]),
  [
    ["add_tray_chain", 1],
    ["set_prerequisites", 1],
    ["set_baker", 1],
  ],
);
const text = readFileSync(
  join(evidence, "chat-exported-rehearsal.json"),
  "utf8",
);
writeFileSync(join(evidence, "saved.json"), text);
const opened = await parseRehearsalWorkcells(text);
assert.equal(opened.kind, "ready", opened.message);
const plan = opened.plan;
assert.deepEqual(plan.faults, result.faults.saved);
assert.deepEqual(result.faults.rejections, ["stale_surface", "invalid_edit"]);
assert.equal(result.faults.operatorRecoverySeconds, 90);
assert.equal(result.baseline.rejection, "stale_surface");
assert.equal(result.baseline.cleared, true);
assert.equal(result.reviewedChanges.clearDiscarded, true);
assert.equal(result.reviewedChanges.removedTrays, 1);
assert.equal(result.reviewedChanges.presetTrays, 2);
assert.ok(result.reviewedChanges.clearedOperation);
assert.notDeepEqual(result.baseline.pinned, result.baseline.changed);
const states = plan.operations.map((operation) => [
  operation.id,
  operation.start.kind,
  `${operation.attempt.kind}:${operation.attempt.input.request.execution.backend}`,
]);
assert.deepEqual(states, [
  ["batch:A:native:1", "reset", "completed:browser"],
  ["batch:B:native:1", "reset", "completed:browser"],
  ["batch:B:native:1:2", "continued", "completed:browser"],
  ["batch:B:native:1:3", "continued", "completed:browser"],
]);
// Fault edits and the compact save/reopen boundary preserve each accepted recording.
for (const [index, operation] of plan.operations.entries()) {
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(operation.attempt.recording))
      .digest("hex"),
    result.steps[index].recordingDigest,
    `${operation.id} accepted recording changed`,
  );
}
const trayB = plan.operations[1];
assert.equal(trayB.workerId, "human-2");
assert.deepEqual(trayB.dependsOn, ["batch:A:native:1"]);
const layout = plan.operations[0].attempt.input.request.layout;
assert.deepEqual(layout, { kind: "rack-translation", xMm: 100, yMm: 0 });
const run = simulateProduction(plan);
assert.equal(run.kind, "complete");
assert.equal(nextProductionExecution(plan, run).kind, "complete");
// First steps adopt a browser request before their candidate (+2); a
// continuation's request is already bound (+1).
assert.deepEqual(
  result.steps.map((step) => step.epochs[1] - step.epochs[0]),
  [2, 2, 1, 1],
);
const report = {
  status: "passed",
  steps: result.steps,
  edits: result.edits,
  faults: plan.faults,
  baseline: result.baseline,
  reviewedChanges: result.reviewedChanges,
  trayB: { workerId: trayB.workerId, dependsOn: trayB.dependsOn },
  save: result.save,
  bytes: text.length,
  states,
  layout,
  schedule: run.intervals
    .filter((task) => task.kind !== "wait")
    .map((task) => ({ id: task.id, start: task.start, end: task.end })),
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
