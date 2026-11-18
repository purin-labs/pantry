import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProductionWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { nextProductionExecution } from "../../packages/production-simulation/src/simulator/production-execution.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// Verifies the files downloaded by verify-production-browser.js through the
// production parser, and compares a browser nominal transfer with native.
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-production-browser"),
);
const PARITY_TOLERANCE = 1e-6;

async function open(name) {
  const result = await parseProductionWorkcells(
    readFileSync(join(evidence, `${name}.json`), "utf8"),
  );
  assert.equal(result.kind, "ready", `${name}: ${result.message}`);
  return result.plan;
}
function states(plan) {
  return plan.operations.map((operation) => ({
    id: operation.id,
    attempt: operation.attempt.kind,
    backend: operation.attempt.input.request.execution.backend,
    case: operation.attempt.input.request.case,
  }));
}
function values(value) {
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(values);
  return [value];
}
function maximumDifference(left, right, field) {
  let maximum = 0;
  for (let index = 0; index < left.samples.length; index++) {
    const a = values(left.samples[index][field]);
    const b = values(right.samples[index][field]);
    assert.equal(a.length, b.length);
    for (let item = 0; item < a.length; item++)
      maximum = Math.max(maximum, Math.abs(a[item] - b[item]));
  }
  return maximum;
}

const stopped = await open("stopped");
const stoppedStates = states(stopped);
const accepted = stoppedStates.filter((state) => state.attempt === "completed");
assert.ok(accepted.length >= 1, "Stop must keep an accepted result.");
assert.ok(
  accepted.length < stoppedStates.length,
  "Stop must leave later operations pending.",
);
for (const state of accepted) assert.equal(state.backend, "browser");

const completed = await open("completed");
const completedStates = states(completed);
for (const state of completedStates) {
  assert.equal(state.attempt, "completed");
  assert.equal(state.backend, "browser");
}
// Continuing never reran an accepted operation: its request is unchanged.
for (const state of accepted) {
  const before = stopped.operations.find((item) => item.id === state.id);
  const after = completed.operations.find((item) => item.id === state.id);
  assert.equal(
    after.attempt.input.request.attemptId,
    before.attempt.input.request.attemptId,
  );
}
const completedRun = simulateProduction(completed);
assert.equal(completedRun.kind, "complete");
assert.equal(nextProductionExecution(completed, completedRun).kind, "complete");

const replaced = await open("replaced");
assert.equal(replaced.variant, "normal");
for (const state of states(replaced))
  assert.equal(state.attempt, "awaiting-evidence");

const failed = await open("failed");
const failedStates = states(failed);
assert.deepEqual(
  failedStates.map((state) => `${state.id}:${state.case}:${state.attempt}`),
  [
    "batch:A:native:1:nominal:completed",
    "batch:B:native:1:slip:recovery-required",
    "batch:C:native:1:nominal:awaiting-evidence",
  ],
);
const failedRun = simulateProduction(failed);
assert.ok(failedRun.nativeHolds.some((hold) => hold.kind === "failed"));
assert.equal(nextProductionExecution(failed, failedRun).kind, "stopped");

const native = JSON.parse(
  readFileSync(
    join(root, "assets/bakery-mujoco/fr10-workcell/recordings/nominal.json"),
    "utf8",
  ),
);
const browser = completed.operations[0].attempt.recording;
assert.equal(browser.request.case, native.request.case);
assert.equal(browser.request.modelHash, native.request.modelHash);
assert.equal(browser.request.timestep, native.request.timestep);
assert.equal(browser.outcome.kind, native.outcome.kind);
assert.equal(browser.outcome.step, native.outcome.step);
assert.deepEqual(
  browser.events.map((event) => `${event.kind}@${event.step}`),
  native.events.map((event) => `${event.kind}@${event.step}`),
);
assert.equal(browser.samples.length, native.samples.length);
const parity = {
  tolerance: PARITY_TOLERANCE,
  samples: native.samples.length,
  maximumTrayDifference: maximumDifference(native, browser, "tray"),
  maximumJointDifference: maximumDifference(native, browser, "joints"),
  placementErrorM: {
    native: native.outcome.evidence.positionErrorM,
    browser: browser.outcome.evidence.positionErrorM,
  },
};
assert.ok(parity.maximumTrayDifference <= PARITY_TOLERANCE);
assert.ok(parity.maximumJointDifference <= PARITY_TOLERANCE);

const report = {
  status: "passed",
  stopped: stoppedStates,
  completed: {
    fingerprint: completed.fingerprint,
    end: completedRun.end,
    operations: completedStates,
  },
  replaced: { variant: replaced.variant, fingerprint: replaced.fingerprint },
  failed: { operations: failedStates, end: failedRun.end },
  parity,
  bytes: Object.fromEntries(
    ["stopped", "completed", "replaced", "failed"].map((name) => [
      name,
      readFileSync(join(evidence, `${name}.json`)).length,
    ]),
  ),
};
writeFileSync(
  join(evidence, "artifact-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
