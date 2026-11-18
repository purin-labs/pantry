// Repeatable workcell comparison through the existing native workflow executable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ROBOT_IDS,
  ROBOTS,
} from "../../packages/bakery-model/src/bakery-robots.ts";
import {
  parsePhysicsReplay,
  parsePhysicsRequest,
} from "../../packages/bakery-model/src/bakery-physics.ts";

const root = resolve(new URL("../../", import.meta.url).pathname);
const output = resolve(process.argv[2] ?? "");
if (process.argv.length !== 3 || existsSync(output))
  throw new Error("Provide a new comparison output directory.");
mkdirSync(output, { recursive: true });
const binary = join(root, "crates/bakery-native/target/release/bakery-native");
const rows = [];
const conditions = [
  { name: "baseline", ingredientMassKg: 1, clampForceN: 100, xMm: 0, yMm: 0 },
  { name: "payload-1kg", ingredientMassKg: 2, clampForceN: 100, xMm: 0, yMm: 0 },
  { name: "clamp-40n", ingredientMassKg: 1, clampForceN: 40, xMm: 0, yMm: 0 },
  {
    name: "payload-1kg-clamp-60n",
    ingredientMassKg: 2,
    clampForceN: 60,
    xMm: 0,
    yMm: 0,
  },
  { name: "rack-nearer", ingredientMassKg: 1, clampForceN: 100, xMm: -100, yMm: 0 },
  { name: "rack-farther", ingredientMassKg: 1, clampForceN: 100, xMm: 100, yMm: 0 },
];

function execute(path, args) {
  const result = spawnSync(
    binary,
    ["--root", root, "--output", path, ...args],
    {
      timeout: 120000,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  if (result.stderr.trim()) writeFileSync(`${path}.stderr.txt`, result.stderr);
  return JSON.parse(readFileSync(path, "utf8"));
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function metrics(recording) {
  let travel = 0;
  let peakSampledJointSpeed = 0;
  for (let index = 1; index < recording.samples.length; index++) {
    const current = recording.samples[index];
    const previous = recording.samples[index - 1];
    const seconds = (current.step - previous.step) * recording.request.timestep;
    travel += Math.hypot(
      current.tool[0] - previous.tool[0],
      current.tool[1] - previous.tool[1],
      current.tool[2] - previous.tool[2],
    );
    for (let joint = 0; joint < 6; joint++)
      peakSampledJointSpeed = Math.max(
        peakSampledJointSpeed,
        Math.abs(current.joints[joint] - previous.joints[joint]) / seconds,
      );
  }
  return {
    simulatedSeconds: recording.outcome.step * recording.request.timestep,
    toolTravelM: travel,
    peakSampledJointSpeedRadS: peakSampledJointSpeed,
  };
}

for (const robot of ROBOT_IDS) {
  for (const task of ["table-to-rack", "table-to-oven"]) {
    for (const condition of conditions) {
      if (task === "table-to-oven" && condition.xMm !== 0) continue;
      const scenarios =
        condition.name === "baseline"
          ? ["nominal", "blocked", "unreachable"]
          : ["nominal"];
      for (const scenario of scenarios) {
        const stem = `${robot}-${task}-${scenario}${condition.name === "baseline" ? "" : `-${condition.name}`}`;
        const directory = join(output, stem);
        mkdirSync(directory);
        const requestPath = join(directory, "request.json");
        const request = execute(requestPath, [
          "prepare",
          "--robot",
          robot,
          "--task",
          task,
          "--case",
          scenario,
          "--ingredient-mass-kg",
          String(condition.ingredientMassKg),
          "--clamp-force-n",
          String(condition.clampForceN),
          "--rack-x-mm",
          String(condition.xMm),
          "--rack-y-mm",
          String(condition.yMm),
        ]);
        assert.equal(
          parsePhysicsRequest(JSON.stringify(request)).kind,
          "accepted",
        );
        const resultPath = join(directory, "recording.json");
        const recording = execute(resultPath, ["run", requestPath]);
        const parsed = parsePhysicsReplay(JSON.stringify(recording));
        assert.equal(parsed.kind, "accepted", parsed.message);
        assert.equal(recording.request.robot, robot);
        assert.equal(
          recording.provenance.robotGlbSha256,
          ROBOTS[robot].glbSha256,
        );
        const repeat = execute(join(directory, "repeat.json"), [
          "run",
          requestPath,
        ]);
        assert.deepEqual(
          repeat,
          recording,
          "Repeated execution changed its evidence",
        );
        if (scenario !== "nominal")
          assert.equal(
            recording.outcome.kind,
            "failed",
            "Fault case must fail",
          );
        const differentRobot = ROBOT_IDS.find(otherRobot.bind(null, robot));
        const changed = { ...request, robot: differentRobot };
        const changedPath = join(directory, "wrong-robot.json");
        writeFileSync(changedPath, JSON.stringify(changed));
        const rejected = spawnSync(binary, [
          "--root",
          root,
          "--output",
          join(directory, "rejected.json"),
          "run",
          changedPath,
        ]);
        assert.notEqual(
          rejected.status,
          0,
          "Robot change must invalidate the model binding",
        );
        assert.equal(existsSync(join(directory, "rejected.json")), false);
        let resumed = false;
        if (recording.outcome.kind === "completed") {
          const checkpointPath = join(directory, "checkpoint.json");
          execute(checkpointPath, [
            "--pause-after",
            "lift",
            "run",
            requestPath,
          ]);
          const restored = execute(join(directory, "resumed.json"), [
            "resume",
            checkpointPath,
          ]);
          assert.deepEqual(
            restored,
            recording,
            "Fresh-process resume changed its evidence",
          );
          resumed = true;
        }
        rows.push({
          robot,
          task,
          scenario,
          condition,
          outcome: recording.outcome,
          sampledTrayOpeningGapM: trayOpeningGap(recording),
          planningFailure:
            recording.outcome.kind === "failed" && recording.outcome.step === 0
              ? recording.outcome.reason
              : null,
          ...metrics(recording),
          repeatedExactly: true,
          freshProcessResume: resumed,
          requestSha256: digest(requestPath),
          recordingSha256: digest(resultPath),
          recording: `${stem}/recording.json`,
        });
        console.log(
          robot,
          task,
          scenario,
          condition.name,
          recording.outcome.kind,
          recording.outcome.reason ?? "",
        );
      }
    }
  }
}

// Conservative tray bounding-box clearance between the oven uprights, sampled
// at recording frames. This is not continuous collision clearance for the arm.
function trayOpeningGap(recording) {
  const left = recording.geometry.find(
    named.bind(null, "mbco_rack_upright_left_front"),
  );
  const right = recording.geometry.find(
    named.bind(null, "mbco_rack_upright_right_front"),
  );
  const rear = recording.geometry.find(
    named.bind(null, "mbco_rack_upright_left_rear"),
  );
  if (!left || !right || !rear) return null;
  const lower = right.pose[1] + right.size[0];
  const upper = left.pose[1] - left.size[0];
  const insertion = recording.events.find(phaseNamed.bind(null, "insert_oven"));
  const release = recording.events.find(phaseNamed.bind(null, "release"));
  if (!insertion) return null;
  let minimum = Infinity;
  for (const sample of recording.samples) {
    if (sample.step < insertion.step || (release && sample.step > release.step))
      continue;
    const bounds = trayBounds(sample.tray);
    if (
      bounds.max[0] < left.pose[0] - left.size[1] ||
      bounds.min[0] > rear.pose[0] + rear.size[1]
    )
      continue;
    if (
      bounds.max[2] < left.pose[2] - left.size[2] ||
      bounds.min[2] > left.pose[2] + left.size[2]
    )
      continue;
    minimum = Math.min(minimum, bounds.min[1] - lower, upper - bounds.max[1]);
  }
  return Number.isFinite(minimum) ? minimum : null;
}
function phaseNamed(name, event) {
  return event.kind === "phase" && event.label === name;
}
function named(name, geometry) {
  return geometry.name === name;
}
function trayBounds(pose) {
  const [cx, cy, cz, w, qx, qy, qz] = pose;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const x of [-0.2, 0.2])
    for (const y of [-0.3, 0.3])
      for (const z of [-0.001, 0.019]) {
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        const point = [
          cx + x + w * tx + qy * tz - qz * ty,
          cy + y + w * ty + qz * tx - qx * tz,
          cz + z + w * tz + qx * ty - qy * tx,
        ];
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
  return { min, max };
}

function otherRobot(robot, candidate) {
  return candidate !== robot;
}
const report = {
  schemaVersion: 2,
  kind: "bakery-arm-comparison",
  passed: true,
  runnerSha256: digest(binary),
  assetsSha256: digest(
    join(root, "assets/bakery-mujoco/fr10-workcell/native/assets.json"),
  ),
  timestep: 0.002,
  conditions:
    "Same pedestal, source and nominal mounting assumptions. Vary rack position, ingredient mass at the tray center, and prototype clamp force. Oven fixture moved 150 mm in X and 200 mm in Y toward the arm to avoid FR10 shoulder saturation. No fitted hardware dynamics.",
  interpretation:
    "Unreachable means bounded IK found no continuous solution. Actuator-limit means a candidate path exceeded static gravity torque and no feasible branch was found. Tray opening gap is a conservative sampled lateral bound during insertion and placement, not full-arm clearance. Clamp variations use the same prototype geometry; no commercial gripper is validated. Failed runs are not speed scores.",
  rows,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const markdown = [
  "# Repeatable arm comparison",
  "",
  report.conditions,
  "",
  report.interpretation,
  "",
  "| Robot | Task | Case / condition | Outcome | Simulated seconds | Opening gap (mm) | Repeat |",
  "| --- | --- | --- | --- | ---: | ---: | --- |",
];
for (const row of rows)
  markdown.push(
    `| ${ROBOTS[row.robot].label} | ${row.task} | ${row.scenario} / ${row.condition.name} | ${row.outcome.kind === "failed" ? row.outcome.reason : row.outcome.kind} | ${row.simulatedSeconds.toFixed(2)} | ${row.sampledTrayOpeningGapM === null ? "—" : (row.sampledTrayOpeningGapM * 1000).toFixed(2)} | Exact |`,
  );
writeFileSync(join(output, "README.md"), markdown.join("\n") + "\n");
