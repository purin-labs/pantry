import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSameResult } from "./native-results.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
const output = resolve(process.argv[2] ?? "");
if (process.argv.length !== 3 || existsSync(output))
  throw new Error("Choose a new campaign output directory.");
mkdirSync(output, { recursive: true });
if (!process.env.BAKERY_NATIVE_BINARY)
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      "crates/bakery-native/Cargo.toml",
    ],
    { cwd: root, stdio: "inherit" },
  );

function run(directory, name, mode, pause = null) {
  const path = join(directory, `${name}.json`);
  const args = ["--output", path];
  if (pause !== null) args.push("--pause-after", pause);
  execFileSync(binary, [...args, ...mode], {
    cwd: root,
    timeout: 150_000,
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(path, "utf8"));
}

function reject(directory, name, value, mode = "resume") {
  const source = join(directory, `invalid-${name}.json`);
  const rejected = join(directory, `rejected-${name}.json`);
  writeFileSync(source, JSON.stringify(value), { flag: "wx" });
  const result = spawnSync(binary, ["--output", rejected, mode, source], {
    cwd: root,
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0, `${name} must be rejected`);
  assert.equal(existsSync(rejected), false, `${name} must not create output`);
}

function isPhase(event) {
  return event.kind === "phase";
}
function phaseName(event) {
  return event.label;
}

// The outcome that each case must give. A failed case places nothing; a
// completed one settles inside the physical placement thresholds. The Rust
// runs are then checked against each other: repeat, checkpoint, handoff.
const FAILURES = {
  blocked: "destination-blocked",
  unreachable: "unreachable",
  slip: "lost-grasp",
  "closed-door": "door-obstructed",
};

function checkOutcome(scenario, actual) {
  const reason = FAILURES[scenario];
  if (reason === undefined) {
    successfulPlacement(actual);
  } else {
    assert.equal(actual.outcome.kind, "failed");
    assert.equal(actual.outcome.reason, reason);
    assert.equal(actual.events.some(isPlacement), false);
  }
  return { outcome: actual.outcome };
}

function phaseRecording(expected) {
  switch (expected.kind) {
    case "bakery-physics-sequence":
      return expected.unloading;
    case "bakery-physics-rack-sequence":
      return expected.racking;
    case "bakery-physics-handoff":
      return expected.recording;
    case "bakery-native-rack-handoff":
      return expected.handoff.recording;
    default:
      return expected;
  }
}

function phaseCampaign(directory, expected, mode, prefix = "phase") {
  const recording = phaseRecording(expected);
  const phases = recording.events.filter(isPhase).map(phaseName);
  let current = mode;
  for (const [index, phase] of phases.slice(0, -1).entries()) {
    run(directory, `${prefix}-${index}`, current, phase);
    current = ["resume", join(directory, `${prefix}-${index}.json`)];
  }
  assertSameResult(
    run(directory, `${prefix}-final`, current),
    expected,
    `${prefix} resumed through every phase boundary`,
  );
  return phases.length - 1;
}

function verifyCase(task, scenario, timestep) {
  const directory = join(output, `${task}-${scenario}-${timestep}`);
  mkdirSync(directory);
  console.log(`Verifying ${task} ${scenario} at ${timestep}s`);
  const request = run(directory, "request", [
    "prepare",
    "--task",
    task,
    "--case",
    scenario,
    "--timestep",
    String(timestep),
  ]);
  const requestPath = join(directory, "request.json");
  const native = run(directory, "native", ["run", requestPath]);
  const comparison = checkOutcome(scenario, native);
  assertSameResult(
    run(directory, "repeat", ["run", requestPath]),
    native,
    "repeat run",
  );
  const alteredRequest = structuredClone(request);
  alteredRequest.execution.controllerHash = "0".repeat(64);
  reject(directory, "request-controller", alteredRequest, "run");
  if (scenario === "nominal" || scenario === "slip") {
    const checkpoint = run(
      directory,
      "checkpoint",
      ["run", requestPath],
      "lift",
    );
    assertSameResult(
      run(directory, "resumed", ["resume", join(directory, "checkpoint.json")]),
      native,
      "run resumed after lift",
    );
    for (const field of ["runnerSha256", "runtimeSha256"]) {
      const changed = structuredClone(checkpoint);
      changed.binding[field] = "0".repeat(64);
      reject(directory, field, changed);
    }
    const state = structuredClone(checkpoint);
    state.prefix.integrationState.pop();
    reject(directory, "state", state);
    const progress = structuredClone(checkpoint);
    progress.prefix.progress.step += 1;
    reject(directory, "step", progress);
    const attempt = structuredClone(checkpoint);
    attempt.binding.request.attemptId = "different";
    reject(directory, "attempt", attempt);
    reject(directory, "terminal", native);
    comparison.freshProcessResumeExact = true;
  }
  if (scenario === "nominal") {
    comparison.phaseBoundaryCheckpoints = phaseCampaign(directory, native, [
      "run",
      requestPath,
    ]);
    if (task === "table-to-oven") {
      const handoff = run(directory, "handoff", ["load", requestPath]);
      run(directory, "load-paused", ["load", requestPath], "lift");
      assertSameResult(
        run(directory, "load-resumed", [
          "resume",
          join(directory, "load-paused.json"),
        ]),
        handoff,
        "load resumed after lift",
      );
      const handoffPath = join(directory, "handoff.json");
      const cycle = run(directory, "cycle", ["unload", handoffPath]);
      assertSameResult(
        run(directory, "continuous", ["cycle", requestPath]),
        cycle,
        "continuous cycle",
      );
      assertSameResult(cycle.loading, native, "loading of the cycle");
      for (const field of ["joints", "tray", "tool", "jaw"])
        assert.deepEqual(
          cycle.loading.samples.at(-1)[field],
          cycle.unloading.samples[0][field],
        );
      comparison.unloading = checkOutcome("nominal", cycle.unloading);
      comparison.unloading.phaseBoundaryCheckpoints = phaseCampaign(
        directory,
        cycle,
        ["unload", handoffPath],
        "return",
      );
      const changed = structuredClone(handoff);
      changed.result.integration_state[1] += 0.1;
      reject(directory, "handoff-state", changed, "unload");
      reject(directory, "recording-as-handoff", native, "unload");
    } else {
      reject(directory, "rack-as-handoff", native, "unload");
    }
  } else {
    reject(directory, "failed-as-handoff", native, "unload");
  }
  return {
    task,
    case: scenario,
    timestep,
    execution: request.execution,
    modelHash: request.modelHash,
    ...comparison,
  };
}

function successfulPlacement(recording) {
  assert.equal(recording.outcome.kind, "completed");
  const evidence = recording.outcome.evidence;
  assert.ok(evidence.positionErrorM < 0.01);
  assert.ok(evidence.orientationErrorRad < (5 * Math.PI) / 180);
  assert.ok(evidence.linearSpeedMps < 0.02);
  assert.ok(evidence.angularSpeedRadps < 0.05);
  assert.ok(evidence.settledSeconds >= 0.5);
  return evidence;
}

function verifyCombined(cell, scenario, timestep) {
  const directory = join(output, `${cell}-${scenario}-${timestep}`);
  mkdirSync(directory);
  console.log(`Verifying ${cell} ${scenario} at ${timestep}s`);
  // The FR10 cannot hold the tray in every pose of the combined cell
  // (actuator-limit at step 0); the UR5e completes it.
  const request = run(directory, "request", [
    "prepare",
    "--robot",
    "universal-robots-ur5e",
    "--task",
    "table-to-oven",
    "--cell",
    cell,
    "--timestep",
    String(timestep),
  ]);
  const requestPath = join(directory, "request.json");
  const continuous = run(directory, "continuous", [
    "cycle",
    "--to-rack",
    "--rack-case",
    scenario,
    requestPath,
  ]);
  assert.equal(continuous.kind, "bakery-physics-rack-sequence");
  const loading = run(directory, "loading", ["load", requestPath]);
  const loadingPath = join(directory, "loading.json");
  const returned = run(directory, "returned", [
    "unload",
    "--for-rack",
    loadingPath,
  ]);
  const returnedPath = join(directory, "returned.json");
  const rackMode = ["rack", "--case", scenario, returnedPath];
  assertSameResult(
    run(directory, "handoff", rackMode),
    continuous,
    "rack from the handoff",
  );
  assertSameResult(
    run(directory, "repeat", [
      "cycle",
      "--to-rack",
      "--rack-case",
      scenario,
      requestPath,
    ]),
    continuous,
    "repeat rack cycle",
  );
  for (const [first, second] of [
    [continuous.loading, continuous.unloading],
    [continuous.unloading, continuous.racking],
  ]) {
    for (const field of ["joints", "tray", "tool", "jaw"])
      assert.deepEqual(first.samples.at(-1)[field], second.samples[0][field]);
    assert.equal(first.request.runId, second.request.runId);
    assert.equal(first.request.modelHash, second.request.modelHash);
    assert.notEqual(first.request.attemptId, second.request.attemptId);
  }
  const report = {
    cell,
    case: scenario,
    timestep,
    execution: request.execution,
    modelHash: request.modelHash,
    loading: successfulPlacement(continuous.loading),
    unloading: successfulPlacement(continuous.unloading),
    racking: continuous.racking.outcome,
    continuousAndHandoffExact: true,
  };
  if (cell === "combined" && scenario === "nominal") {
    successfulPlacement(continuous.racking);
    report.phaseBoundaryCheckpoints =
      phaseCampaign(directory, loading, ["load", requestPath], "load-phase") +
      phaseCampaign(
        directory,
        returned,
        ["unload", "--for-rack", loadingPath],
        "unload-phase",
      ) +
      phaseCampaign(directory, continuous, rackMode, "rack-phase");
    const damaged = structuredClone(returned);
    damaged.handoff.result.integration_state[1] += 0.1;
    reject(directory, "rack-state", damaged, "rack");
    const swapped = structuredClone(returned);
    swapped.handoff.loading.recording.request.attemptId = "different";
    reject(directory, "rack-prefix", swapped, "rack");
    reject(directory, "loading-as-rack-handoff", loading, "rack");
    reject(directory, "sequence-as-rack-handoff", continuous, "rack");
    reject(
      directory,
      "continuation-as-fresh-run",
      continuous.racking.request,
      "run",
    );
    const pending = JSON.parse(
      readFileSync(join(directory, "rack-phase-0.json"), "utf8"),
    );
    pending.pending.binding.request.modelHash = "0".repeat(64);
    reject(directory, "rack-checkpoint-model", pending);
  } else {
    const expected =
      scenario === "slip"
        ? "lost-grasp"
        : cell === "blocked-rack"
          ? "destination-blocked"
          : "unreachable";
    assert.equal(continuous.racking.outcome.kind, "failed");
    assert.equal(continuous.racking.outcome.reason, expected);
    assert.equal(continuous.racking.events.some(isPlacement), false);
    const paused = run(directory, "paused", rackMode, "lift");
    if (expected === "unreachable") {
      // The arm checks its reach before it moves: the tray stays on the
      // table, and no lift happens to pause after.
      assert.equal(continuous.racking.outcome.step, 0);
      assert.equal(continuous.racking.outcome.trayDisposition, "source");
      assertSameResult(paused, continuous, "refused rack with a pause");
    } else {
      assertSameResult(
        run(directory, "resumed", ["resume", join(directory, "paused.json")]),
        continuous,
        "failed rack resumed after lift",
      );
    }
    reject(directory, "failed-rack-as-handoff", continuous, "rack");
    report.failedResumeExact = true;
  }
  return report;
}

function isPlacement(event) {
  return event.kind === "placement";
}

const results = [];
for (const task of ["table-to-rack", "table-to-oven"]) {
  for (const scenario of ["nominal", "blocked", "unreachable", "slip"])
    results.push(verifyCase(task, scenario, 0.002));
  results.push(verifyCase(task, "nominal", 0.001));
  if (task === "table-to-oven")
    results.push(verifyCase(task, "closed-door", 0.002));
}
const combined = [
  verifyCombined("combined", "nominal", 0.002),
  verifyCombined("combined", "nominal", 0.001),
  verifyCombined("combined", "slip", 0.002),
  verifyCombined("blocked-rack", "nominal", 0.002),
  verifyCombined("unreachable-rack", "nominal", 0.002),
];
writeFileSync(
  join(output, "comparison.json"),
  JSON.stringify(
    { platform: process.platform, runner: binary, results, combined },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  `Passed ${results.length} single-skill cases and ${combined.length} combined-cell cases, including all three skills at both timesteps.`,
);
