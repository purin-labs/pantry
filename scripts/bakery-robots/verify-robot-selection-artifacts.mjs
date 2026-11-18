import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parsePhysicsRequest,
  parsePhysicsReplay,
  workcellModelHash,
} from "../../packages/bakery-model/src/bakery-physics.ts";
import { assessRobotLoad } from "../../packages/bakery-model/src/bakery-load-assessment.ts";
import { ROBOT_IDS } from "../../packages/bakery-model/src/bakery-robots.ts";
import { parseRehearsalWorkcells } from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

// The native runner and the Wasm build run the same Rust source on two MuJoCo
// 4.0.0 builds, so their first samples already differ by one or two ulps.
// Since Refactor 16 step 5 (the stiff table top in every world), a transfer
// grows that difference: to 1.1e-8 for the FANUC baseline and to 1.1e-6 for
// the offset load (the FR10 loses its grasp); before step 5 it stayed below
// 6.5e-10. A load that differs by 1 mm or 10 g moves the motion by 4.5e-5 or
// more, so this bound still finds a request that the page changed.
const MOTION_TOLERANCE = 1e-5;

assert.equal(process.argv.length, 3, "Provide the browser evidence directory.");
const browser = resolve(process.argv[2]);
const comparison = JSON.parse(
  readFileSync(join(browser, "comparison.json"), "utf8"),
);
assert.equal(comparison.entries.length, ROBOT_IDS.length * 2);
const loadComparison = JSON.parse(
  readFileSync(join(browser, "ingredient-comparison.json"), "utf8"),
);
assert.equal(loadComparison.entries.length, ROBOT_IDS.length * 2);
const nativeLoads = mkdtempSync(join(browser, "native-ingredients-"));
const binary = resolve("crates/bakery-native/target/release/bakery-native");
for (const kind of ["near-chart", "above-chart"]) {
  const entry = JSON.parse(readFileSync(join(browser, `${kind}.json`), "utf8"))
    .entries[0];
  const parsed = parsePhysicsReplay(JSON.stringify(entry.recording));
  assert.equal(parsed.kind, "accepted", parsed.message);
  assert.equal(entry.loadAssessment.kind, kind);
  assert.deepEqual(
    entry.loadAssessment,
    await assessRobotLoad(parsed.recording.request),
  );
  const expected = nativeRecording(entry.recording, kind);
  assert.ok(motionDifference(entry.recording, expected) < MOTION_TOLERANCE);
}
const loadDifferences = [];
for (const robot of ROBOT_IDS) {
  const rows = loadComparison.entries.filter(matchesRobot.bind(null, robot));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].recording.samples, rows[1].recording.samples);
  const actual = rows[0].recording;
  assert.deepEqual(actual.request.ingredients, {
    massKg: 0.75,
    forwardMm: -100,
    lateralMm: 60,
  });
  assert.deepEqual(
    rows[0].loadAssessment,
    await assessRobotLoad(actual.request),
  );
  const expected = nativeRecording(actual, "offset");
  assert.equal(actual.outcome.kind, expected.outcome.kind);
  assert.equal(actual.outcome.reason, expected.outcome.reason);
  assert.deepEqual(
    actual.events.map(eventStep),
    expected.events.map(eventStep),
  );
  assert.equal(actual.samples.length, expected.samples.length);
  const loadDifference = motionDifference(actual, expected);
  assert.ok(
    loadDifference < MOTION_TOLERANCE,
    `${robot}: load-specific native/Wasm mismatch`,
  );
  loadDifferences.push({ robot, maximumDifference: loadDifference });
}
const differences = [];
for (const robot of ROBOT_IDS) {
  const entries = comparison.entries.filter(matchesRobot.bind(null, robot));
  assert.deepEqual(entries.map(repetition), [1, 2]);
  const [first, repeated] = entries;
  for (const entry of entries) {
    const parsed = parsePhysicsReplay(JSON.stringify(entry.recording));
    assert.equal(parsed.kind, "accepted", parsed.message);
    assert.equal(parsed.recording.request.robot, robot);
    assert.equal(parsed.recording.request.execution.backend, "browser");
    assert.equal(
      parsed.recording.request.modelHash,
      await workcellModelHash(robot, "separate"),
    );
    if (robot !== "universal-robots-ur5e")
      assert.deepEqual(entry.loadAssessment, {
        kind: "unassessed",
        reason: "unsupported-robot",
      });
  }
  assert.deepEqual(first.recording.samples, repeated.recording.samples);
  assert.deepEqual(first.recording.events, repeated.recording.events);
  assert.deepEqual(first.recording.outcome, repeated.recording.outcome);
  assert.deepEqual(
    first.loadAssessment,
    await assessRobotLoad(first.recording.request),
  );
  const reference = nativeRecording(first.recording, "baseline");
  assert.equal(
    first.recording.request.execution.controllerSourceHash,
    reference.request.execution.controllerSourceHash,
  );
  assert.equal(first.recording.outcome.kind, reference.outcome.kind);
  assert.equal(first.recording.samples.length, reference.samples.length);
  const maximumDifference = motionDifference(first.recording, reference);
  assert.ok(
    maximumDifference < MOTION_TOLERANCE,
    `${robot}: native/browser motion differs`,
  );
  differences.push({ robot, maximumDifference });
  if (robot === "universal-robots-ur5e") {
    assert.equal(first.loadAssessment.kind, "below-chart");
    const changedModel = parsePhysicsRequest(
      JSON.stringify({ ...first.recording.request, modelHash: "0".repeat(64) }),
    );
    assert.equal(changedModel.kind, "accepted", changedModel.message);
    assert.deepEqual(await assessRobotLoad(changedModel.request), {
      kind: "unassessed",
      reason: "unverified-model",
    });
  }
  const missingRobot = structuredClone(first.recording.request);
  delete missingRobot.robot;
  assert.equal(
    parsePhysicsRequest(JSON.stringify(missingRobot)).kind,
    "rejected",
  );
  const unknownRobot = { ...first.recording.request, robot: "unknown-arm" };
  assert.equal(
    parsePhysicsRequest(JSON.stringify(unknownRobot)).kind,
    "rejected",
  );
  const wrongVisual = structuredClone(first.recording);
  wrongVisual.provenance.robotGlbSha256 = "0".repeat(64);
  assert.equal(
    parsePhysicsReplay(JSON.stringify(wrongVisual)).kind,
    "rejected",
  );
}
const oven = JSON.parse(readFileSync(join(browser, "fr10-oven.json"), "utf8"))
  .entries[0].recording;
const ovenParsed = parsePhysicsReplay(JSON.stringify(oven));
assert.equal(ovenParsed.kind, "accepted", ovenParsed.message);
assert.equal(oven.outcome.kind, "completed");
const nativeOven = nativeRecording(oven, "selected");
assert.equal(
  oven.request.execution.controllerSourceHash,
  nativeOven.request.execution.controllerSourceHash,
);
const ovenDifference = motionDifference(oven, nativeOven);
assert.ok(
  ovenDifference < MOTION_TOLERANCE,
  "FR10 oven native/Wasm motion differs",
);
const savedFile = readFileSync(join(browser, "saved-run.json"), "utf8");
const restored = await parseRehearsalWorkcells(savedFile);
assert.equal(restored.kind, "ready", restored.message);
assert.equal(restored.plan.operations.length, 1);
const operation = restored.plan.operations[0];
assert.equal(operation.attempt.kind, "completed");
assert.deepEqual(restored.plan.cellRobots["cold-cell-1"], {
  kind: "assigned",
  robot: "universal-robots-ur5e",
});
assert.equal(operation.attempt.input.request.robot, "universal-robots-ur5e");
assert.equal(
  operation.attempt.recording.request.robot,
  "universal-robots-ur5e",
);
assert.equal(operation.attempt.input.request.execution.backend, "browser");
assert.equal(operation.attempt.input.request.bakeryTaskId, "table-to-oven");
const spacer = operation.attempt.recording.geometry.find(isWristSpacer);
assert.ok(spacer, "UR5e recording must include the wrist spacer");
assert.equal(spacer.body, "tool", "The spacer must follow tool playback");
assert.equal(spacer.shape, "cylinder");
assert.deepEqual(spacer.size, [0.019, 0.052, 0]);
assert.equal(simulateProduction(restored.plan).kind, "complete");
const restoredRequest = parsePhysicsRequest(
  readFileSync(join(browser, "restored-request.json"), "utf8"),
);
assert.equal(restoredRequest.kind, "accepted", restoredRequest.message);
assert.deepEqual(restoredRequest.request, operation.attempt.input.request);
const report = {
  status: "passed",
  arms: ROBOT_IDS.length,
  browserComparisonRuns: ROBOT_IDS.length * 4,
  ingredientLoad: { massKg: 0.75, forwardMm: -100, lateralMm: 60 },
  ingredientLoadNativeParity: true,
  ingredientLoadDifferences: loadDifferences,
  motionTolerance: MOTION_TOLERANCE,
  differences,
  fr10OvenMaximumDifference: ovenDifference,
  savedRobot: operation.attempt.input.request.robot,
  savedRunSha256: createHash("sha256").update(savedFile).digest("hex"),
  checks: [
    "native/Wasm parity",
    "repeatability",
    "required robot identity",
    "visual hash rejection",
    "saved-run restore and scheduler completion",
    "load assessment included in exported comparisons",
    "below, near and above chart estimates use nominal-frame model properties",
  ],
};
writeFileSync(
  join(browser, "artifact-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));

function matchesRobot(robot, entry) {
  return entry.robot === robot;
}
function repetition(entry) {
  return entry.repetition;
}
function eventStep(event) {
  return `${event.step}:${event.kind}`;
}

function motionDifference(actualRecording, reference) {
  assert.equal(actualRecording.samples.length, reference.samples.length);
  let maximumDifference = 0;
  for (let index = 0; index < reference.samples.length; index++) {
    const actual = actualRecording.samples[index];
    const expected = reference.samples[index];
    assert.equal(actual.step, expected.step);
    for (const field of ["joints", "tray", "tool", "jaw"]) {
      for (let axis = 0; axis < expected[field].length; axis++) {
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(actual[field][axis] - expected[field][axis]),
        );
      }
    }
  }
  return maximumDifference;
}

function isWristSpacer(geometry) {
  return geometry.name === "clamp_mount_spacer";
}

function nativeRecording(actual, condition) {
  const stem = `${actual.request.robot}-${condition}`;
  const request = join(nativeLoads, `${stem}.request.json`);
  const recording = join(nativeLoads, `${stem}.recording.json`);
  const load = actual.request.ingredients;
  execFileSync(binary, [
    "--output",
    request,
    "prepare",
    "--robot",
    actual.request.robot,
    "--task",
    actual.request.bakeryTaskId,
    "--case",
    actual.request.case,
    "--ingredient-mass-kg",
    String(load.massKg),
    "--ingredient-forward-mm",
    String(load.forwardMm),
    "--ingredient-lateral-mm",
    String(load.lateralMm),
  ]);
  execFileSync(binary, ["--output", recording, "run", request]);
  return JSON.parse(readFileSync(recording, "utf8"));
}
