// Exercise the complete shared Rust workflow, including rejected placements and recovery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { assertSameResult } from "./native-results.mjs";

assert.equal(process.argv.length, 3, "Provide a new evidence directory.");
const directory = resolve(process.argv[2]);
assert.equal(existsSync(directory), false);
mkdirSync(directory, { recursive: true });
const binary = resolve("crates/bakery-native/target/release/bakery-native");
function run(name, args) {
  const path = join(directory, `${name}.json`);
  execFileSync(binary, ["--output", path, ...args], { timeout: 120000 });
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}
function prepare(name, cell) {
  return run(name, [
    "prepare",
    "--robot",
    "universal-robots-ur5e",
    "--cell",
    cell,
    "--task",
    "table-to-oven",
  ]);
}
const request = prepare("request", "combined");
const cycle = run("cycle", ["cycle", request.path, "--to-rack"]);
for (const phase of ["loading", "unloading", "racking"]) {
  assert.equal(cycle.value[phase].outcome.kind, "completed");
}
const loaded = run("loaded", ["load", request.path]);
const returned = run("returned", ["unload", loaded.path, "--for-rack"]);
const checkpoints = [];
for (const phase of ["lift", "transfer", "release"]) {
  const paused = run(`paused-${phase}`, [
    "--pause-after",
    phase,
    "rack",
    returned.path,
  ]);
  assert.equal(paused.value.kind, "bakery-native-rack-checkpoint");
  const resumed = run(`resumed-${phase}`, ["resume", paused.path]);
  assertSameResult(resumed.value, cycle.value, `rack resumed after ${phase}`);
  checkpoints.push(phase);
}
// The arm checks its reach before it moves, so the rack that is out of reach
// is refused at step 0 and the tray stays on the table.
const rejected = {};
for (const cell of ["blocked-rack", "unreachable-rack"]) {
  const input = prepare(`${cell}-request`, cell);
  const result = run(`${cell}-cycle`, ["cycle", input.path, "--to-rack"]);
  assert.equal(result.value.loading.outcome.kind, "completed");
  assert.equal(result.value.unloading.outcome.kind, "completed");
  assert.equal(result.value.racking.outcome.kind, "failed");
  assert.equal(
    result.value.racking.outcome.reason,
    cell === "blocked-rack" ? "destination-blocked" : "unreachable",
  );
  if (cell === "unreachable-rack") {
    assert.equal(result.value.racking.outcome.step, 0);
    assert.equal(result.value.racking.outcome.trayDisposition, "source");
  }
  rejected[cell] = result.value.racking.outcome;
}
const slip = run("slip", ["rack", returned.path, "--case", "slip"]);
assert.equal(slip.value.racking.outcome.kind, "failed");
assert.equal(slip.value.racking.outcome.reason, "lost-grasp");
writeFileSync(
  join(directory, "report.json"),
  JSON.stringify(
    {
      status: "passed",
      robot: "universal-robots-ur5e",
      rackCenterM: [0.5, -0.45, 0.601],
      placement: cycle.value.racking.outcome.evidence,
      checkpointsResumedExactly: checkpoints,
      rejected,
      slip: slip.value.racking.outcome,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Combined UR5e cooling-rack workflow, rejection and exact recovery passed.",
);
