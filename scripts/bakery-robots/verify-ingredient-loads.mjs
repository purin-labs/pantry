// Canonical requests exercise the same Rust execution contract used by browser workers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parsePhysicsReplay,
  parsePhysicsRequest,
  sameIngredientLoad,
} from "../../packages/bakery-model/src/bakery-physics.ts";

assert.equal(
  process.argv.length,
  3,
  "Provide the prepared ingredient study directory.",
);
import { assessRobotLoad } from "../../packages/bakery-model/src/bakery-load-assessment.ts";
import { assertAcceptedMargins } from "../production-simulation/operation-margins.mjs";

// Refactor 16 step 7: each leg's margins against the UR5e's rated limits.
// Every retrieval warns: the right clamp pad presses about 1.1 mm into the
// tray's side wall. In three off-centre loads the left fork presses 1.0 to
// 1.2 mm into the tray's floor as the tray goes onto the rack.
const RACKING_PENETRATION = new Set([
  "contents-0.5-x100-y60",
  "contents-0.75-x-100-y60",
  "contents-1-x0-y-60",
]);
function expectedWarnings(name, leg) {
  if (leg === 1) return ["penetration"];
  if (leg === 2 && RACKING_PENETRATION.has(name)) return ["penetration"];
  return [];
}

const directory = resolve(process.argv[2]);
const binary = resolve("crates/bakery-native/target/release/bakery-native");
const cases = JSON.parse(readFileSync(join(directory, "loads.json"), "utf8"));
for (const row of cases) {
  const request = join(directory, `${row.name}.request.json`);
  const input = parsePhysicsRequest(readFileSync(request, "utf8"));
  assert.equal(input.kind, "accepted", input.message);
  const assessment = await assessRobotLoad(input.request);
  assert.notEqual(assessment.kind, "unassessed");
  assert.ok(Math.abs(assessment.totalMassKg - row.totalCarriedMassKg) < 1e-9);
  assert.ok(
    Math.abs(assessment.centerOfMassDistanceMm - row.centerOfMassDistanceMm) <
      0.001,
  );
  for (let axis = 0; axis < 3; axis++)
    assert.ok(
      Math.abs(
        assessment.flangeCenterOfMassM[axis] - row.flangeCenterOfMassM[axis],
      ) < 1e-6,
    );
  row.loadAssessment = assessment;
  let baseline;
  for (let repetition = 0; repetition < 2; repetition++) {
    const path = join(directory, `${row.name}.run-${repetition}.json`);
    execFileSync(binary, ["--output", path, "cycle", request, "--to-rack"], {
      timeout: 125000,
    });
    const text = readFileSync(path, "utf8");
    if (repetition === 0) baseline = text;
    else assert.equal(text, baseline, `${row.name} did not repeat exactly`);
  }
  const parsed = parsePhysicsReplay(baseline);
  assert.equal(parsed.kind, "accepted", parsed.message);
  const replay = parsed.recording;
  const legs =
    replay.kind === "bakery-physics-recording"
      ? [replay]
      : replay.kind === "bakery-physics-sequence"
        ? [replay.loading, replay.unloading]
        : [replay.loading, replay.unloading, replay.racking];
  for (const leg of legs) {
    assert.ok(
      sameIngredientLoad(leg.request.ingredients, input.request.ingredients),
    );
    const contents = leg.geometry.find(isContents);
    if (row.contentsKg === 0) assert.equal(contents, undefined);
    else {
      assert.ok(contents);
      assert.ok(contents.pose[0] === -row.contentsOffsetWorldMm[1] / 1000);
      assert.equal(contents.pose[1], row.contentsOffsetWorldMm[0] / 1000);
    }
  }
  row.motion = legs.map(outcome);
  row.limits = legs.map((leg, index) =>
    leg.outcome.kind === "completed"
      ? assertAcceptedMargins(
          leg.outcome,
          expectedWarnings(row.name, index),
          `${row.name} leg ${index + 1}`,
        )
      : null,
  );
  row.completedFullCycle = legs.length === 3 && legs.every(completed);
  row.repeatedExactly = true;
  console.log(row.name, row.completedFullCycle, row.motion.at(-1));
}
writeFileSync(
  join(directory, "report.json"),
  JSON.stringify(
    {
      status: "simulation study; physical validation pending",
      cases,
      completed: cases.filter(passed).length,
      total: cases.length,
      execution:
        "canonical Rust request, cycle and recording; no modified fixture controller",
    },
    null,
    2,
  ) + "\n",
);
function isContents(geometry) {
  return geometry.name === "cold_contents";
}
function outcome(leg) {
  return leg.outcome;
}
function completed(leg) {
  return leg.outcome.kind === "completed";
}
function passed(row) {
  return row.completedFullCycle;
}
assert.ok(
  cases.every(passed),
  "Some ingredient cases failed; inspect report.json.",
);
