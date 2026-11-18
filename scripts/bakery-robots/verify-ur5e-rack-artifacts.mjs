import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

assert.equal(
  process.argv.length,
  4,
  "Provide browser and native evidence directories.",
);
const browser = resolve(process.argv[2]);
const native = JSON.parse(
  readFileSync(join(process.argv[3], "racking.json"), "utf8"),
);
const completedFile = readFileSync(join(browser, "completed.json"), "utf8");
const restoredFile = readFileSync(join(browser, "restored.json"), "utf8");
assert.deepEqual(JSON.parse(restoredFile), JSON.parse(completedFile));
const opened = await parseRehearsalWorkcells(completedFile);
assert.equal(opened.kind, "ready", opened.message);
assert.equal(simulateProduction(opened.plan).kind, "complete");
assert.equal(
  opened.plan.cellRobots["cold-cell-1"].robot,
  "universal-robots-ur5e",
);
assert.equal(opened.plan.operations.length, 3);
for (const operation of opened.plan.operations) {
  assert.equal(operation.attempt.kind, "completed");
}
const sequence = opened.plan.operations[2].attempt.recording;
assert.equal(sequence.kind, "bakery-physics-rack-sequence");
const differences = {};
for (const phase of ["loading", "unloading", "racking"]) {
  const actual = sequence[phase];
  const expected = native[phase];
  assert.equal(actual.request.execution.backend, "browser");
  assert.equal(actual.request.robot, "universal-robots-ur5e");
  assert.deepEqual(actual.request.ingredients, expected.request.ingredients);
  assert.equal(actual.outcome.kind, "completed");
  assert.equal(actual.samples.length, expected.samples.length);
  let maximum = 0;
  for (let index = 0; index < expected.samples.length; index++) {
    assert.equal(actual.samples[index].step, expected.samples[index].step);
    for (const field of ["joints", "tray", "tool", "jaw"]) {
      for (let axis = 0; axis < expected.samples[index][field].length; axis++) {
        maximum = Math.max(
          maximum,
          Math.abs(
            actual.samples[index][field][axis] -
              expected.samples[index][field][axis],
          ),
        );
      }
    }
  }
  assert.ok(maximum < 1e-8, `${phase} native/Wasm motion differs: ${maximum}`);
  differences[phase] = maximum;
}
writeFileSync(
  join(browser, "artifact-report.json"),
  JSON.stringify(
    {
      status: "passed",
      robot: "universal-robots-ur5e",
      savedRunRestoredExactly: true,
      scheduler: "complete",
      maximumMotionDifferences: differences,
      placement: sequence.racking.outcome.evidence,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Full browser chain, exact saved-run restore and native/Wasm parity passed.",
);
