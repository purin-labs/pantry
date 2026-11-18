import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextProductionExecution } from "../../packages/production-simulation/src/simulator/production-execution.ts";
import { parseRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the files from verify-native-import-browser.js: the imported tray
// holds each native result, and the exported resume handoff is the imported one.
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-native-import"),
);
function read(name) {
  return readFileSync(join(evidence, `${name}.json`), "utf8");
}

assert.equal(read("exported-loading-handoff"), read("loading-handoff"));
const opened = await parseRehearsalWorkcells(read("final"));
assert.equal(opened.kind, "ready", opened.message);
const plan = opened.plan;
const tray = plan.operations.filter((operation) => operation.batchId === "C");
assert.deepEqual(
  tray.map((operation) => [
    operation.id,
    operation.start.kind,
    operation.attempt.kind,
  ]),
  [
    ["batch:C:native:1", "reset", "completed"],
    ["batch:C:native:1:2", "continued", "completed"],
    ["batch:C:native:1:3", "continued", "completed"],
  ],
);
const racked = JSON.parse(read("racked"));
assert.equal(
  tray[0].attempt.input.request.attemptId,
  racked.loading.request.attemptId,
);
const run = simulateProduction(plan);
assert.equal(run.kind, "complete");
assert.equal(nextProductionExecution(plan, run).kind, "complete");
const report = {
  status: "passed",
  tray: tray.map((operation) => ({
    id: operation.id,
    start: operation.start.kind,
    attempt: operation.attempt.kind,
  })),
  schedule: run.intervals
    .filter((task) => task.batch === "C" && task.kind !== "wait")
    .map((task) => ({ id: task.id, start: task.start, end: task.end })),
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
