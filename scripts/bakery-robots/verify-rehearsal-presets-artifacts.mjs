import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextProductionExecution } from "../../packages/production-simulation/src/simulator/production-execution.ts";
import {
  parseProductionWorkcells,
  parseRehearsalWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the files downloaded by verify-rehearsal-presets-browser.js through
// the rehearsal and production parsers and the production scheduler.
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-rehearsal-presets"),
);

function read(name) {
  return readFileSync(join(evidence, `${name}.json`), "utf8");
}
function states(plan) {
  return plan.operations.map((operation) => [
    operation.id,
    operation.start.kind,
    `${operation.attempt.kind}:${operation.attempt.input.request.execution.backend}`,
  ]);
}
function spans(run) {
  return run.intervals
    .filter((task) => task.kind === "native" || task.kind === "handoff")
    .map((task) => ({ id: task.id, start: task.start, end: task.end }));
}

const chain = await parseRehearsalWorkcells(read("oven-table-rack"));
assert.equal(chain.kind, "ready", chain.message);
assert.deepEqual(
  states(chain.plan).map(([id, , state]) => [id, state]),
  [
    ["batch:A:native:1", "completed:browser"],
    ["batch:A:native:1:2", "completed:browser"],
    ["batch:A:native:1:3", "completed:browser"],
  ],
);
assert.equal(chain.plan.planned.length, 0);
const chainRun = simulateProduction(chain.plan);
assert.equal(chainRun.kind, "complete");
assert.equal(nextProductionExecution(chain.plan, chainRun).kind, "complete");

const financier = await parseProductionWorkcells(read("financier-robot"));
assert.equal(financier.kind, "ready", financier.message);
assert.equal(financier.plan.procedure, "financier");
assert.equal(financier.plan.settings.batchCount, 1);
assert.equal(financier.plan.settings.traysPerBatch, 1);
assert.deepEqual(states(financier.plan), [
  ["batch:A:native:1", "reset", "completed:browser"],
]);
const financierRun = simulateProduction(financier.plan);
assert.equal(financierRun.kind, "complete");
const transfer = financierRun.intervals.find((task) => task.kind === "native");
const cooled = financierRun.intervals.find(
  (task) => task.id === "batch:A:process:cool",
);
assert.ok(transfer.start >= cooled.end, "the transfer follows cooling");

const report = {
  status: "passed",
  chain: { states: states(chain.plan), schedule: spans(chainRun) },
  financier: {
    settings: {
      batchCount: financier.plan.settings.batchCount,
      traysPerBatch: financier.plan.settings.traysPerBatch,
    },
    states: states(financier.plan),
    transfer: { start: transfer.start, end: transfer.end },
    end: financierRun.end,
  },
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
