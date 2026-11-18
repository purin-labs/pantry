import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { nextProductionExecution } from "../../packages/production-simulation/src/simulator/production-execution.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the files downloaded by verify-rehearsal-browser.js through the
// rehearsal parser and the production scheduler.
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-rehearsal-browser"),
);

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
function operation(plan, id) {
  const found = plan.operations.find((item) => item.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
}
function spans(run) {
  return run.intervals
    .filter((task) => task.kind === "native" || task.kind === "handoff")
    .map((task) => ({ id: task.id, start: task.start, end: task.end }));
}

const authored = await open("authored");
assert.deepEqual(states(authored.plan), {
  "batch:A:native:1": "completed:unknown",
  "batch:B:native:1": "completed:unknown",
  "batch:C:native:1": "awaiting-evidence:unknown",
  "batch:D:native:1": "awaiting-evidence:unknown",
  "batch:E:native:1": "awaiting-evidence:unknown",
  "batch:C:native:1:2": "planned",
  "batch:C:native:1:3": "planned",
  "batch:D:native:1:2": "planned",
  "batch:D:native:1:3": "planned",
  "batch:E:native:1:2": "planned",
  "batch:E:native:1:3": "planned",
});
assert.deepEqual(operation(authored.plan, "batch:E:native:1").dependsOn, [
  "batch:C:native:1:3",
  "batch:D:native:1:3",
]);
assert.deepEqual(operation(authored.plan, "batch:C:native:1").dependsOn, []);
const plannedD = authored.plan.planned.filter((item) => item.batchId === "D");
assert.equal(plannedD[0].earliestStartSeconds, 700);
assert.deepEqual(plannedD[1].skill, { kind: "rack", rackCase: "slip" });

const stopped = await open("stopped");
const stoppedStates = states(stopped.plan);
assert.equal(stoppedStates["batch:C:native:1"], "completed:browser");
// The retrieval request derives from C's browser-built loading request.
assert.equal(stoppedStates["batch:C:native:1:2"], "awaiting-evidence:browser");
const savedC = stopped.raw.trays.find((tray) => tray.batchId === "C");
assert.equal(typeof savedC.steps[0].handoff, "string");
assert.equal(
  operation(stopped.plan, "batch:C:native:1:2").start.kind,
  "continuation",
);

const final = await open("final");
const finalStates = states(final.plan);
for (const id of [
  "batch:C:native:1",
  "batch:C:native:1:2",
  "batch:C:native:1:3",
  "batch:D:native:1",
  "batch:D:native:1:2",
])
  assert.equal(finalStates[id], "completed:browser", id);
assert.equal(finalStates["batch:D:native:1:3"], "recovery-required:browser");
assert.equal(finalStates["batch:E:native:1"], "awaiting-evidence:unknown");
assert.equal(finalStates["batch:E:native:1:2"], "planned");
// Continuing never reran C's accepted loading.
assert.equal(
  operation(final.plan, "batch:C:native:1").attempt.input.request.attemptId,
  operation(stopped.plan, "batch:C:native:1").attempt.input.request.attemptId,
);
const run = simulateProduction(final.plan);
const next = nextProductionExecution(final.plan, run);
assert.equal(next.kind, "stopped");
assert.match(next.message, /step 3 failed/);
const retrievalD = run.intervals.find(
  (task) =>
    task.kind === "native" && task.operation.id === "batch:D:native:1:2",
);
assert.ok(
  retrievalD.start >= 700,
  `D retrieval started at ${retrievalD.start}`,
);
assert.ok(
  !run.intervals.some((task) => task.id === "batch:E:handoff:1-stage"),
  "E must not stage while its join is unmet",
);
const waitsE = run.unresolvedWaits
  .filter((wait) => wait.batch === "E")
  .map((wait) => wait.label);
assert.ok(waitsE.length > 0);
// One chain holds the cell at a time: no two trays' native steps overlap.
const natives = run.intervals
  .filter((task) => task.kind === "native")
  .sort((left, right) => left.start - right.start);
for (let index = 1; index < natives.length; index++)
  if (natives[index].operation.batchId !== natives[index - 1].operation.batchId)
    assert.ok(natives[index].start >= natives[index - 1].end);

const report = {
  status: "passed",
  bytes: {
    authored: authored.bytes,
    stopped: stopped.bytes,
    final: final.bytes,
  },
  stopped: stoppedStates,
  final: finalStates,
  schedule: spans(run),
  waitsE,
  next: next.message,
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
