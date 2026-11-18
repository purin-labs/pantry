import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextProductionExecution } from "../../packages/production-simulation/src/simulator/production-execution.ts";
import {
  editRehearsalWorkcells,
  parseRehearsalWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import {
  compareRuns,
  summarizeRun,
} from "../../packages/production-simulation/src/simulator/run-comparison.ts";
import { NO_FAULTS } from "../../packages/production-simulation/src/recipes/bakery/run-faults.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the files downloaded by verify-rehearsal-faults-browser.js through
// the rehearsal parser and the production scheduler.
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-rehearsal-faults"),
);
const expected = {
  outage: { resource: "fr10-1", start: 60, end: 400 },
  failure: { bakeryTaskId: "batch:B:handoff:1-stage", afterSeconds: 10 },
  recovery: { bakeryTaskId: "batch:B:handoff:1-stage", seconds: 60 },
};

async function open(name) {
  const text = readFileSync(join(evidence, `${name}.json`), "utf8");
  const result = await parseRehearsalWorkcells(text);
  assert.equal(result.kind, "ready", `${name}: ${result.message}`);
  return { plan: result.plan, raw: JSON.parse(text), bytes: text.length };
}
function states(plan) {
  return Object.fromEntries([
    ...plan.operations.map((operation) => [
      operation.id,
      `${operation.attempt.kind}:${operation.attempt.input.request.execution.backend}`,
    ]),
    ...plan.planned.map((operation) => [operation.id, "planned"]),
  ]);
}
function spans(run) {
  return run.intervals
    .filter((task) => task.kind === "native" || task.kind === "handoff")
    .map((task) => ({
      id: task.id,
      start: task.start,
      end: task.end,
      ...(task.kind === "handoff" ? { outcome: task.outcome } : {}),
    }));
}

const authored = await open("authored");
assert.equal(authored.raw.schemaVersion, 2);
assert.deepEqual(authored.raw.faults, expected);
assert.deepEqual(authored.plan.faults, expected);

const final = await open("final");
assert.deepEqual(final.plan.faults, expected);
const finalStates = states(final.plan);
for (const id of [
  "batch:C:native:1",
  "batch:C:native:1:2",
  "batch:C:native:1:3",
])
  assert.equal(finalStates[id], "completed:browser", id);

const run = simulateProduction(final.plan);
assert.equal(run.kind, "blocked");
assert.deepEqual(run.unfinished, ["B"]);
const [failure] = run.handlingFailures;
assert.equal(failure.task.id, "batch:B:handoff:1-stage");
assert.equal(failure.failedAt, failure.task.start + 10);
assert.equal(failure.recoveredAt, failure.failedAt + 60);
// No work that needs the arm starts during its outage; running work finishes.
for (const task of run.intervals)
  if (
    (task.kind === "native" ||
      (task.kind === "handoff" && task.phase === "stage")) &&
    task.start >= 60 &&
    task.start < 400
  )
    assert.fail(`${task.id} started during the FR10 arm outage`);
const stageC = run.intervals.find(
  (task) => task.id === "batch:C:handoff:1-stage",
);
assert.ok(stageC.start >= failure.recoveredAt);
assert.equal(stageC.executor, failure.task.executor);
const next = nextProductionExecution(final.plan, run);
assert.equal(next.kind, "stopped");
assert.match(next.message, /Tray B staging failed; the recovery released/);

// The same trays and evidence without faults are the comparison baseline.
const baseline = await editRehearsalWorkcells(final.plan, {
  kind: "faults",
  faults: NO_FAULTS,
});
assert.equal(baseline.kind, "ready", baseline.message);
const baselineRun = simulateProduction(baseline.plan);
assert.equal(baselineRun.kind, "complete");
const comparison = compareRuns(
  summarizeRun(baselineRun),
  summarizeRun(run),
  "tray",
);
assert.match(comparison, /1 more unfinished tray\. 1 more failed task\./);

const report = {
  status: "passed",
  bytes: { authored: authored.bytes, final: final.bytes },
  final: finalStates,
  failure: {
    task: failure.task.id,
    failedAt: failure.failedAt,
    recoveredAt: failure.recoveredAt,
  },
  schedule: spans(run),
  baselineSchedule: spans(baselineRun),
  comparison,
  next: next.message,
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
