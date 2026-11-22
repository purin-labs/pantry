// Refactor 16 step 7: an operation over a robot's limits fails or warns,
// and the engine's own motion produces the result.
//
//   node scripts/production-simulation/verify-robot-limits.mjs NEW_OUTPUT_DIRECTORY
//     [--runtime BUNDLE_DIRECTORY]
//
// Each case runs as a host program, through the native `serve` host and
// through the Wasm module of the runtime bundle:
//
//  1. Speed failure. The FANUC CRX-10iA/L moves a tray from the table to the
//     oven. Its J2 peaks at about 70 % of its rated 120 °/s. The same request
//     with the test-only `speedRatingScale` 0.5 must fail with `joint-speed`
//     at the first step where a joint passes half its rating: the margins
//     name the joint, its peak and the scaled rating, the peak is the speed
//     of that last step, and every sample before it equals the nominal run.
//  2. Clamp warning. The UR5e moves a tray with 2 kg of ingredients from the
//     table to the rack. The transfer completes, and wrist_1_joint stays at
//     its 28 N·m clamp for longer than the 50 ms bound: a warning.
//  3. Short clamp. The same load to the oven holds that clamp for a few
//     milliseconds only, which is below the bound: no warning.
//  4. Penetration warning. The FANUC with 2 kg to the oven presses a
//     contact deeper than 1 mm: a warning, and the transfer completes.
//  5. The scale can never raise a rating: 1, 1.5 and 0 are refused.
//  6. The agent's answer. The Portal turns a browser result into the output
//     of `simulate_workcell` (`simulation-result.ts`), and the shared
//     contract that the platform reads checks it. For a transfer, an oven
//     cycle and a rack cycle, the output names each operation's margins as
//     the robot comparison shows them, with the warning lines.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";
import { NativeHost, WasmHost, program, runProgram } from "./engine-hosts.mjs";
import { assertAcceptedMargins, assertMargins } from "./operation-margins.mjs";
import {
  parseOperationMargins,
  summarizeMargins,
} from "../../packages/bakery-model/src/bakery-margins.ts";
import { parsePhysicsReplay } from "../../packages/bakery-model/src/bakery-physics.ts";
import { parseSimulationOutput } from "../../packages/bakery-model/src/bakery-simulation-output.ts";
import { simulationResult } from "../../areas/kitchen/ui/features/workflow-simulator/simulation-result.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = join(root, "crates/bakery-native/target/release/bakery-native");
const args = process.argv.slice(2);
let runtime = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
let output = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--runtime") runtime = resolve(args[++index]);
  else if (output === null) output = resolve(args[index]);
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(
  output !== null && !existsSync(output),
  "Name a new output directory",
);
mkdirSync(output, { recursive: true });

let jobs = 0;
async function transfer(host, request) {
  const run = await runProgram(
    host,
    `limits-${++jobs}`,
    { kind: "run", request },
    4096,
  );
  return JSON.parse(run.output);
}

async function prepare(host, preparation) {
  return (await program(host, { op: "prepare", preparation })).request;
}

function sampleAt(samples) {
  return new Map(samples.map((sample) => [sample.step, sample]));
}

const report = { runtime: BAKERY_BROWSER_BUNDLE.id, hosts: {} };
for (const [name, open] of [
  ["native", () => new NativeHost(root, binary, output)],
  ["wasm", async () => new WasmHost(await runtimeModule(runtime))],
]) {
  const host = await open();
  const rows = {};

  // 1. Speed failure, against the nominal motion of the same request.
  const oven = await prepare(host, {
    robot: "fanuc-crx10ial",
    task: "table-to-oven",
  });
  const nominal = await transfer(host, oven);
  rows.nominal = assertAcceptedMargins(nominal.outcome, [], `${name} nominal`);
  const scaled = await transfer(host, { ...oven, speedRatingScale: 0.5 });
  const failed = scaled.outcome;
  assert.equal(failed.kind, "failed", JSON.stringify(failed).slice(0, 400));
  assert.equal(failed.reason, "joint-speed");
  const margins = parseOperationMargins(failed.margins);
  assert.equal(margins.speedRatingScale, 0.5);
  const overspeed = margins.overspeed;
  assert.ok(overspeed !== null, "The failure names the joint");
  const joint = margins.joints.find((entry) => entry.joint === overspeed.joint);
  assert.ok(joint && joint.ratedSpeed.kind === "rated");
  assert.equal(overspeed.ratedRadS, joint.ratedSpeed.value * 0.5);
  assert.ok(overspeed.peakRadS > overspeed.ratedRadS);
  // The operation stops at the first step over the limit, so the peak is
  // that step's speed, and the motion before it is the nominal motion.
  assert.equal(joint.peakSpeedRadS, overspeed.peakRadS);
  assert.ok(failed.step > 0 && failed.step < nominal.outcome.step);
  const expected = sampleAt(nominal.samples);
  let compared = 0;
  for (const sample of scaled.samples) {
    if (sample.step >= failed.step) continue;
    assert.deepEqual(
      sample,
      expected.get(sample.step),
      `sample ${sample.step}`,
    );
    compared += 1;
  }
  assert.ok(
    compared > 100,
    "The failed run shares its motion with the nominal run",
  );
  rows.speedFailure = {
    joint: overspeed.joint,
    peakRadS: overspeed.peakRadS,
    limitRadS: overspeed.ratedRadS,
    ratedRadS: joint.ratedSpeed.value,
    failedAtStep: failed.step,
    nominalSteps: nominal.outcome.step,
    equalSamplesBefore: compared,
  };

  // 2. and 3. The UR5e's wrist with 2 kg: a long clamp warns, a short one
  // does not.
  const heavy = { robot: "universal-robots-ur5e", ingredientMassKg: 2 };
  const rack = await transfer(
    host,
    await prepare(host, { ...heavy, task: "table-to-rack" }),
  );
  rows.longClamp = assertAcceptedMargins(
    rack.outcome,
    ["torque-clamp"],
    `${name} UR5e rack`,
  );
  const [clamp] = rack.outcome.margins.warnings;
  assert.equal(clamp.joint, "wrist_1_joint");
  assert.ok(clamp.seconds > clamp.boundSeconds);
  const ur5eOven = await transfer(
    host,
    await prepare(host, { ...heavy, task: "table-to-oven" }),
  );
  rows.shortClamp = assertAcceptedMargins(
    ur5eOven.outcome,
    [],
    `${name} UR5e oven`,
  );
  assert.ok(
    rows.shortClamp.longestClampSeconds > 0 &&
      rows.shortClamp.longestClampSeconds <= clamp.boundSeconds,
    "A short clamp stays below the bound",
  );

  // 4. A deep contact warns.
  const deep = await transfer(
    host,
    await prepare(host, {
      robot: "fanuc-crx10ial",
      task: "table-to-oven",
      ingredientMassKg: 2,
    }),
  );
  rows.penetration = assertAcceptedMargins(
    deep.outcome,
    ["penetration"],
    `${name} FANUC 2 kg oven`,
  );
  assert.ok(rows.penetration.peakPenetrationMm > 1);

  // 5. A scale cannot raise a rating.
  const refused = [];
  for (const [index, scale] of [1, 1.5, 0].entries()) {
    const reply = await host.send({
      op: "program",
      command: {
        op: "open",
        job: `refused-${index}`,
        program: { kind: "run", request: { ...oven, speedRatingScale: scale } },
      },
    });
    assert.equal(reply.kind, "failed", JSON.stringify(reply).slice(0, 300));
    assert.match(reply.message, /speed rating scale/u);
    refused.push(scale);
  }
  rows.refusedScales = refused;
  // Against the true ratings, the failed motion stayed below every one.
  assertMargins(
    { ...failed, margins: { ...margins, overspeed: null } },
    [],
    `${name} failed run against the true ratings`,
  );

  // 6. The agent's answer, from the recordings of three program kinds.
  const agent = {};
  for (const [mode, value] of [
    [
      "transfer",
      {
        kind: "run",
        request: await prepare(host, { ...heavy, task: "table-to-rack" }),
      },
    ],
    ["oven-cycle", { kind: "cycle", request: oven, toRack: false }],
    [
      "rack-cycle",
      {
        kind: "cycle",
        request: await prepare(host, {
          robot: "universal-robots-ur5e",
          task: "table-to-oven",
          cell: "combined",
        }),
        toRack: true,
        rackCase: "nominal",
      },
    ],
  ]) {
    const run = await runProgram(host, `agent-${++jobs}`, value, 4096);
    const replay = parsePhysicsReplay(run.output);
    assert.equal(replay.kind, "accepted", replay.message);
    const result = simulationResult(replay.recording);
    const output = parseSimulationOutput({
      kind: "simulation",
      mode,
      recordingDigest: "0".repeat(64),
      bytes: run.output.length,
      elapsedMs: 1,
      ...result,
    });
    assert.ok(output !== null, `${mode}: the shared contract takes the output`);
    assert.ok(output.margins !== undefined);
    for (const entry of output.margins)
      assert.equal(
        entry.margins.kind,
        "measured",
        `${mode} ${entry.operation}`,
      );
    agent[mode] = {
      operations: output.margins.map((entry) => entry.operation),
      lines: output.margins.flatMap((entry) =>
        entry.margins.kind === "measured" ? entry.margins.lines : [],
      ),
      marginBytes: JSON.stringify(output.margins).length,
    };
  }
  assert.deepEqual(agent.transfer.operations, ["transfer"]);
  assert.match(
    agent.transfer.lines.join(" "),
    /wrist_1_joint stayed at its torque limit/u,
  );
  assert.deepEqual(agent["oven-cycle"].operations, ["loading", "unloading"]);
  assert.deepEqual(agent["oven-cycle"].lines, []);
  assert.deepEqual(agent["rack-cycle"].operations, [
    "loading",
    "unloading",
    "racking",
  ]);
  assert.match(
    agent["rack-cycle"].lines.join(" "),
    /went 1\.1 mm deep \(clamp_pad_right on mbco_tray_right\)/u,
  );
  // The agent's summary is the comparison's summary of the same outcome.
  assert.deepEqual(
    summarizeMargins(rack.outcome.margins).lines,
    agent.transfer.lines,
  );
  rows.agent = agent;

  report.hosts[name] = rows;
  await host.close();
  console.log(
    `pass: ${name}: ${overspeed.joint} failed at ${overspeed.peakRadS.toFixed(3)} rad/s over ${overspeed.ratedRadS.toFixed(3)}; ` +
      `wrist_1_joint clamp ${(clamp.seconds * 1000).toFixed(0)} ms warns; ` +
      `${(rows.shortClamp.longestClampSeconds * 1000).toFixed(0)} ms does not; ` +
      `penetration ${rows.penetration.peakPenetrationMm.toFixed(2)} mm warns`,
  );
}
// Native and Wasm arithmetic differ in the last digits, so the two hosts
// must agree on each result, not on each number.
const verdicts = (rows) => ({
  failedJoint: rows.speedFailure.joint,
  warnings: [rows.longClamp, rows.shortClamp, rows.penetration].map(
    (row) => row.warnings,
  ),
});
assert.deepEqual(
  verdicts(report.hosts.native),
  verdicts(report.hosts.wasm),
  "The native host and the Wasm module give the same results",
);
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`Report: ${join(output, "report.json")}`);
