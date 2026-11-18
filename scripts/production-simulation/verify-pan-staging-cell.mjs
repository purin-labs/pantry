// Qualify empty-cell holds and a blocked placement using the shared Rust runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

assert.equal(process.argv.length, 3, "Provide a fresh evidence directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false);
mkdirSync(output, { recursive: true });
const binary = resolve("crates/bakery-native/target/release/bakery-native");
const HOLD_SECONDS = 14_400;

function invoke(name, args) {
  const file = join(output, `${name}.json`);
  execFileSync(binary, ["--root", resolve("."), "--output", file, ...args], {
    timeout: 1_800_000,
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(file, "utf8"));
}
function save(name, data) {
  writeFileSync(
    join(output, `${name}.json`),
    JSON.stringify(data, null, 2) + "\n",
  );
}
// The output holds the checkpoint envelope and its digest (Refactor 16,
// step 11).
function continueFrom(state) {
  return {
    kind: "continue",
    content: state.checkpoint.content,
    digest: state.checkpoint.digest,
    sequence: state.sequence,
  };
}
function cell(name, initial, actions) {
  save(`${name}-request`, { schemaVersion: 1, initial, actions });
  return invoke(name, ["cell", join(output, `${name}-request.json`)]);
}
function positionDelta(first, second) {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++)
    squared += (first[axis] - second[axis]) ** 2;
  return Math.sqrt(squared);
}
function qualify(name, start) {
  const entry = cell(`${name}-entry`, continueFrom(start), [
    { kind: "advance", steps: 1000 },
  ]);
  assert.equal(entry.hold?.support, "empty");
  assert.equal(entry.hold.qualifiedSteps, HOLD_SECONDS / 0.002);
  const advanced = cell(`${name}-four-hours`, continueFrom(entry), [
    { kind: "advance", steps: HOLD_SECONDS / 0.002 },
  ]);
  let armRadians = 0;
  for (let joint = 0; joint < 6; joint++)
    armRadians = Math.max(
      armRadians,
      Math.abs(entry.observation.arm[joint] - advanced.observation.arm[joint]),
    );
  const referenceMetres = positionDelta(
    entry.observation.reference,
    advanced.observation.reference,
  );
  assert.ok(armRadians < 1e-4, `Arm drift: ${armRadians}`);
  assert.ok(referenceMetres < 1e-4, `Reference drift: ${referenceMetres}`);
  assert.deepEqual(advanced.observation.tray, entry.observation.tray);
  const actions = [
    { kind: "admit", carrier: "receiving-pan" },
    { kind: "start", attemptId: "stage-pan", task: "table-to-rack" },
    { kind: "finish" },
  ];
  const held = cell(`${name}-held-transfer`, continueFrom(entry), actions);
  const stepped = cell(
    `${name}-stepped-transfer`,
    continueFrom(advanced),
    actions,
  );
  assert.equal(held.results.at(-1).outcome.kind, "completed");
  assert.equal(stepped.results.at(-1).outcome.kind, "completed");
  const placementMetres = positionDelta(
    held.observation.tray,
    stepped.observation.tray,
  );
  assert.ok(
    placementMetres < 0.001,
    `Placement difference: ${placementMetres}`,
  );
  assert.deepEqual(
    held.segments.flatMap(eventKinds),
    stepped.segments.flatMap(eventKinds),
  );
  assert.equal(held.hold, null, "A supported pan has no qualified hold");
  return {
    held,
    report: {
      seconds: HOLD_SECONDS,
      armRadians,
      referenceMetres,
      placementMetres,
    },
  };
}
function eventKinds(segment) {
  return segment.events.map(eventKind);
}
function eventKind(event) {
  return [event.kind, event.label];
}

const definition = invoke("definition", [
  "prepare-cell",
  "--fixture",
  "pan-staging",
  "--cell",
  "tea-pan-cell",
]);
const initial = cell("created", { kind: "create", definition }, [
  { kind: "advance", steps: 1 },
]);
const ready = qualify("ready", initial);
const cleared = cell("cleared", continueFrom(ready.held), [
  { kind: "remove", carrier: "receiving-pan" },
]);
const returned = qualify("cleared", cleared);
invoke("blocked-request", [
  "prepare",
  "--cell",
  "pan-staging",
  "--ingredient-mass-kg",
  "0",
  "--case",
  "blocked",
]);
const blocked = invoke("blocked-placement", [
  "run",
  join(output, "blocked-request.json"),
]);
assert.notEqual(blocked.outcome.kind, "completed");
assert.equal(blocked.events.some(isPlacement), false);
save("report", {
  result: "passed",
  fixture: definition.fixture,
  ready: ready.report,
  cleared: returned.report,
  blocked: blocked.outcome,
  limitations:
    "Empty pan fixed to an assumed insert; no bare-pan grasp or liquid transport. Loaded holds remain disabled.",
});
console.log(`Pan staging cell passed: ${output}`);

function isPlacement(event) {
  return event.kind === "placement";
}
