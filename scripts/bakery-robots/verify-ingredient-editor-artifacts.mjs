import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acceptProductionRecording,
  parseRehearsalWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

assert.equal(process.argv.length, 3, "Provide the browser evidence directory.");
const directory = resolve(process.argv[2]);
function read(name) {
  return readFileSync(join(directory, `${name}.json`), "utf8");
}
async function plan(name) {
  const result = await parseRehearsalWorkcells(read(name));
  assert.equal(result.kind, "ready", result.message);
  return result.plan;
}
const before = await plan("before-edit");
assert.deepEqual(
  JSON.parse(read("unchanged")),
  JSON.parse(read("before-edit")),
);
assert.deepEqual(
  JSON.parse(read("invalid-kept")),
  JSON.parse(read("before-edit")),
);
const edited = await plan("edited");
assert.notEqual(edited.fingerprint, before.fingerprint);
assert.equal(edited.operations.length, 1);
assert.equal(edited.planned.length, 2);
const root = edited.operations[0];
assert.equal(root.attempt.kind, "awaiting-evidence");
assert.equal(root.handoff, null);
const ingredients = { massKg: 0.5, forwardMm: 100, lateralMm: -60 };
assert.deepEqual(root.attempt.input.request.ingredients, ingredients);
const previous = before.operations[0];
assert.equal(previous.attempt.kind, "completed");
const stale = acceptProductionRecording(
  edited,
  edited.fingerprint,
  root.id,
  previous.attempt.recording,
);
assert.equal(stale.kind, "rejected");
const completed = await plan("completed");
assert.equal(simulateProduction(completed).kind, "complete");
assert.equal(completed.operations.length, 3);
for (const operation of completed.operations) {
  assert.equal(operation.attempt.kind, "completed");
  assert.deepEqual(operation.attempt.input.request.ingredients, ingredients);
}
assert.deepEqual(JSON.parse(read("restored")), JSON.parse(read("completed")));
const sequence = completed.operations[2].attempt.recording;
assert.equal(sequence.kind, "bakery-physics-rack-sequence");
for (const leg of [sequence.loading, sequence.unloading, sequence.racking]) {
  assert.deepEqual(leg.request.ingredients, ingredients);
  assert.equal(leg.request.execution.backend, "browser");
  const contents = leg.geometry.find(isContents);
  assert.ok(contents);
  assert.equal(contents.pose[0], 0.06);
  assert.equal(contents.pose[1], 0.1);
}
function isContents(geometry) {
  return geometry.name === "cold_contents";
}
writeFileSync(
  join(directory, "artifact-report.json"),
  JSON.stringify(
    {
      status: "passed",
      ingredients,
      checks: [
        "unchanged and invalid edits preserve the complete saved run",
        "changed load clears results and handoffs",
        "previous result rejected after edit",
        "all three Wasm operations preserve mass and offsets",
        "recording geometry matches the edited offsets",
        "completed scheduler and exact saved-run restore",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log("Ingredient editor artifacts verified.");
