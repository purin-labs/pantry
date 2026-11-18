// Refactor 16 step 5: the results of the one-shot transfers (path A) for
// each robot, through one native runner. Two runs with two runners show how
// a change of the world moves each result.
//
//   node scripts/production-simulation/measure-one-shot-results.mjs NEW_OUTPUT.json
//     [--binary PATH] [--compare EARLIER_OUTPUT.json]
//
// Each row is one `prepare` and one `run` (or `load` and `unload` for the
// oven cycle): the outcome, its step, the final position and orientation
// errors, and a SHA-256 of every sample. `--compare` prints, for each row,
// the change of the outcome step and of the errors, and whether the samples
// are equal.
//
// Refactor 16 step 7: each row also asserts the margins against the robot's
// rated limits. A completed transfer keeps every joint below its rated speed
// with no warning; a plan that fails before its first step measured nothing.
// A binary before step 7 reports no margins: name it with --binary and add
// --no-margins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROBOT_IDS } from "../../packages/bakery-model/src/bakery-robots.ts";
import {
  assertAcceptedMargins,
  assertNotMeasured,
} from "./operation-margins.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const output = resolve(args[0] ?? "");
let binary = join(root, "crates/bakery-native/target/release/bakery-native");
let compare = null;
let margins = true;
for (let index = 1; index < args.length; index++) {
  if (args[index] === "--binary") binary = resolve(args[++index]);
  else if (args[index] === "--compare") compare = resolve(args[++index]);
  else if (args[index] === "--no-margins") margins = false;
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(args[0] && !existsSync(output), "Name a new output file");
const scratch = mkdtempSync(join(tmpdir(), "one-shot-"));
let sequence = 0;

function execute(command) {
  const path = join(scratch, `out-${++sequence}.json`);
  const result = spawnSync(
    binary,
    ["--root", root, "--output", path, ...command],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return path;
}

function summary(recording, label) {
  const outcome = recording.outcome;
  let limits = null;
  if (margins && outcome.kind === "completed")
    limits = assertAcceptedMargins(outcome, [], label);
  else if (margins) assertNotMeasured(outcome, label);
  return {
    margins: limits,
    outcome: outcome.kind === "failed" ? outcome.reason : outcome.kind,
    step: outcome.step ?? null,
    positionErrorMm:
      outcome.evidence?.positionErrorM === undefined
        ? null
        : outcome.evidence.positionErrorM * 1000,
    orientationErrorMrad:
      outcome.evidence?.orientationErrorRad === undefined
        ? null
        : outcome.evidence.orientationErrorRad * 1000,
    samples: createHash("sha256")
      .update(JSON.stringify(recording.samples))
      .digest("hex"),
  };
}

const rows = [];
for (const robot of ROBOT_IDS)
  for (const task of ["table-to-rack", "table-to-oven"])
    for (const scenario of ["nominal", "blocked", "unreachable"]) {
      const request = execute([
        "prepare",
        "--robot",
        robot,
        "--task",
        task,
        "--case",
        scenario,
      ]);
      const recording = JSON.parse(
        readFileSync(execute(["run", request]), "utf8"),
      );
      rows.push({
        robot,
        task,
        scenario,
        ...summary(recording, `${robot} ${task} ${scenario}`),
      });
    }
// The oven cycle: loading, then retrieval to the table.
const loading = execute(["prepare", "--task", "table-to-oven"]);
const handoff = execute(["load", loading]);
const sequenceFile = JSON.parse(
  readFileSync(execute(["unload", handoff]), "utf8"),
);
rows.push({
  robot: "fairino-fr10",
  task: "oven-cycle (loading)",
  scenario: "nominal",
  ...summary(sequenceFile.loading, "oven-cycle loading"),
});
rows.push({
  robot: "fairino-fr10",
  task: "oven-cycle (retrieval)",
  scenario: "nominal",
  ...summary(sequenceFile.unloading, "oven-cycle retrieval"),
});
writeFileSync(output, `${JSON.stringify({ binary, rows }, null, 2)}\n`);

if (compare !== null) {
  const earlier = JSON.parse(readFileSync(compare, "utf8")).rows;
  for (const row of rows) {
    const before = earlier.find(
      (other) =>
        other.robot === row.robot &&
        other.task === row.task &&
        other.scenario === row.scenario,
    );
    if (before === undefined) continue;
    const delta = (a, b) =>
      a === null || b === null ? "—" : (a - b).toPrecision(3);
    console.log(
      [
        row.robot,
        row.task,
        row.scenario,
        `${before.outcome} -> ${row.outcome}`,
        `step ${before.step} -> ${row.step}`,
        `position ${delta(row.positionErrorMm, before.positionErrorMm)} mm`,
        `orientation ${delta(row.orientationErrorMrad, before.orientationErrorMrad)} mrad`,
        before.samples === row.samples ? "samples equal" : "samples differ",
      ].join(" | "),
    );
  }
}
