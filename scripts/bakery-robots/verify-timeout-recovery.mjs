import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
  parsePhysicsRackSequence,
  rackPlanFromSequence,
} from "../../packages/bakery-model/src/bakery-physics.ts";
import {
  compileRackCycleInput,
  workcellResource,
} from "../../packages/production-simulation/src/recipes/bakery/workcell-input.ts";
import {
  reserveWorkcell,
  settleWorkcell,
  workcellResourceAt,
  workcellTasks,
} from "../../packages/production-simulation/src/recipes/bakery/workcell-attempt.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
const output = resolve(process.argv[2] ?? "");
const startedAt = new Date().toISOString();
const started = performance.now();
if (process.argv.length !== 3 || existsSync(output))
  throw new Error("Choose a new campaign output directory.");
if (!existsSync(binary))
  throw new Error("Build the bakery-native release binary first.");
mkdirSync(output, { recursive: true });

const requestPath = join(output, "request.json");
const timedOutPath = join(output, "timed-out.json");
const completedPath = join(output, "completed.json");
const loadingCheckpointPath = join(output, "loading-checkpoint.json");
const timedOutResumePath = join(output, "timed-out-resume.json");
const loadingHandoffPath = join(output, "loading-handoff.json");
const returnHandoffPath = join(output, "return-handoff.json");
const resumedPath = join(output, "resumed.json");
const failedPath = join(output, "failed-rack.json");
// The FR10 cannot hold the tray in every pose of the combined cell, so its
// rack cycle stops at step 0 (actuator-limit); the UR5e completes it.
run(requestPath, [
  "prepare",
  "--robot",
  "universal-robots-ur5e",
  "--task",
  "table-to-oven",
  "--cell",
  "combined",
]);

const timeout = spawnSync(
  binary,
  ["--output", timedOutPath, "cycle", "--to-rack", requestPath],
  { cwd: root, timeout: 50, encoding: "utf8" },
);
assert.equal(timeout.error?.code, "ETIMEDOUT");
assert.equal(
  existsSync(timedOutPath),
  false,
  "Timeout must not create accepted evidence",
);

run(completedPath, ["cycle", "--to-rack", requestPath]);
const completedBytes = readFileSync(completedPath);
const parsed = parsePhysicsRackSequence(completedBytes.toString("utf8"));
assert.equal(parsed.kind, "accepted", parsed.message);
const compiled = compileRackCycleInput(
  rackPlanFromSequence(parsed.sequence),
  "0",
  "cold-cell-1",
);
assert.equal(compiled.kind, "ready", compiled.message);
const reservation = reserveWorkcell({ kind: "empty" }, compiled.input);
assert.equal(reservation.kind, "reserved", reservation.message);

const waitingTasks = workcellTasks(reservation.attempt, 80);
const heldBeforeAcceptance = workcellResourceAt(
  reservation.attempt,
  80,
  workcellResource("fr10-1"),
);
assert.equal(heldBeforeAcceptance, "reserved");
assert.ok(waitingTasks.some((task) => task.status !== "completed"));

const settled = settleWorkcell(reservation.attempt, parsed.sequence);
assert.equal(settled.kind, "accepted", settled.message);
assert.equal(settled.attempt.kind, "completed");
const completedTasks = workcellTasks(settled.attempt, 200);
assert.ok(completedTasks.every((task) => task.status === "completed"));

run(loadingCheckpointPath, ["--pause-after", "lift", "load", requestPath]);
const checkpointSha256 = sha256(readFileSync(loadingCheckpointPath));
const interruptedResume = spawnSync(
  binary,
  ["--output", timedOutResumePath, "resume", loadingCheckpointPath],
  { cwd: root, timeout: 50, encoding: "utf8" },
);
assert.equal(interruptedResume.error?.code, "ETIMEDOUT");
assert.equal(existsSync(timedOutResumePath), false);
assert.equal(sha256(readFileSync(loadingCheckpointPath)), checkpointSha256);
run(loadingHandoffPath, ["resume", loadingCheckpointPath]);
run(returnHandoffPath, ["unload", "--for-rack", loadingHandoffPath]);
run(resumedPath, ["rack", returnHandoffPath]);
const resumed = parsePhysicsRackSequence(readFileSync(resumedPath, "utf8"));
assert.equal(resumed.kind, "accepted", resumed.message);
assert.deepEqual(resumed.sequence, parsed.sequence);

run(failedPath, ["rack", "--case", "slip", returnHandoffPath]);
const failed = parsePhysicsRackSequence(readFileSync(failedPath, "utf8"));
assert.equal(failed.kind, "accepted", failed.message);
const failedInput = compileRackCycleInput(
  rackPlanFromSequence(failed.sequence),
  "0",
  "cold-cell-1",
);
assert.equal(failedInput.kind, "ready", failedInput.message);
const failedReservation = reserveWorkcell({ kind: "empty" }, failedInput.input);
assert.equal(failedReservation.kind, "reserved", failedReservation.message);
const failedSettlement = settleWorkcell(
  failedReservation.attempt,
  failed.sequence,
);
assert.equal(failedSettlement.kind, "accepted", failedSettlement.message);
assert.equal(failedSettlement.attempt.kind, "recovery-required");
const failedTasks = workcellTasks(failedSettlement.attempt, 200);
assert.deepEqual(failedTasks.map(taskStatus), [
  "completed",
  "completed",
  "recovery-required",
]);
const heldAfterFailure = workcellResourceAt(
  failedSettlement.attempt,
  200,
  workcellResource("fr10-1"),
);
assert.equal(heldAfterFailure, "held");

const interruptions = [];
for (const phase of ["loading", "unloading", "racking"]) {
  const checkpoint = join(output, `${phase}-host-checkpoint.json`);
  const source = {
    loading: ["load", requestPath],
    unloading: ["unload", "--for-rack", loadingHandoffPath],
    racking: ["rack", returnHandoffPath],
  }[phase];
  run(checkpoint, ["--pause-after", "lift", ...source]);
  const checkpointDigest = sha256(readFileSync(checkpoint));
  for (const signal of ["SIGINT", "SIGKILL"]) {
    const resultPath = join(output, `${phase}-${signal}.json`);
    const interruption = await interrupt(checkpoint, resultPath, signal);
    assert.equal(existsSync(resultPath), false);
    assert.equal(sha256(readFileSync(checkpoint)), checkpointDigest);
    interruptions.push({ phase, ...interruption, checkpointDigest });
  }
  const recoveredPath = join(output, `${phase}-host-recovered.json`);
  run(recoveredPath, ["resume", checkpoint]);
  const reference = {
    loading: loadingHandoffPath,
    unloading: returnHandoffPath,
    racking: completedPath,
  }[phase];
  assert.deepEqual(
    JSON.parse(readFileSync(recoveredPath, "utf8")),
    JSON.parse(readFileSync(reference, "utf8")),
  );
}

// A durable result alone cannot settle the portal's still-pending reservation.
assert.equal(reservation.attempt.kind, "awaiting-evidence");
const recoveredResult = parsePhysicsRackSequence(
  readFileSync(completedPath, "utf8"),
);
assert.equal(recoveredResult.kind, "accepted", recoveredResult.message);
const recoveredSettlement = settleWorkcell(
  reservation.attempt,
  recoveredResult.sequence,
);
assert.equal(recoveredSettlement.kind, "accepted", recoveredSettlement.message);
assert.deepEqual(recoveredSettlement.attempt, settled.attempt);

const report = {
  kind: "bakery-native-timeout-recovery-e2e",
  startedAt,
  elapsedMs: performance.now() - started,
  host: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0].model,
    memoryBytes: totalmem(),
    node: process.version,
    binarySha256: sha256(readFileSync(binary)),
  },
  hostInterruptions: interruptions,
  unknownResult: {
    preservedPendingUntilExplicitAcceptance: true,
    recoveredResultMatchesOriginalSettlement: true,
  },
  requestSha256: sha256(readFileSync(requestPath)),
  completedSha256: sha256(completedBytes),
  timeout: {
    budgetMs: 50,
    signal: timeout.signal,
    errorCode: timeout.error?.code,
    outputCreated: existsSync(timedOutPath),
  },
  beforeAcceptance: {
    fr10: heldBeforeAcceptance,
    tasks: waitingTasks.map(taskState),
  },
  afterAcceptance: {
    outcome: parsed.sequence.racking.outcome.kind,
    tasks: completedTasks.map(taskState),
  },
  interruptedCheckpoint: {
    phase: "loading lift",
    checkpointSha256,
    timeoutErrorCode: interruptedResume.error?.code,
    outputCreated: existsSync(timedOutResumePath),
    resumedSequenceMatchesContinuous: true,
  },
  failedRack: {
    outcome: failed.sequence.racking.outcome.kind,
    fr10: heldAfterFailure,
    tasks: failedTasks.map(taskState),
  },
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
  {
    flag: "wx",
  },
);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

function run(path, mode) {
  const result = spawnSync(binary, ["--output", path, ...mode], {
    cwd: root,
    timeout: 150_000,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
  assert.equal(existsSync(path), true);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function taskState(task) {
  return { name: task.name, status: task.status };
}

function taskStatus(task) {
  return task.status;
}

async function interrupt(checkpoint, resultPath, signal) {
  const completion = Promise.withResolvers();
  const child = spawn(binary, ["--output", resultPath, "resume", checkpoint], {
    cwd: root,
    stdio: "ignore",
  });
  const state = { child, signal, delivered: false, completion };
  child.once("error", completion.reject);
  child.once("exit", interruptedExit.bind(null, state));
  const timer = setTimeout(deliverSignal.bind(null, state), 50);
  const watchdog = setTimeout(forceExit.bind(null, state), 10_000);
  try {
    const result = await completion.promise;
    assert.equal(state.delivered, true);
    assert.equal(result.signal, signal);
    assert.equal(result.code, null);
    return { signal, delivered: true, delayMs: 50, outputCreated: false };
  } finally {
    clearTimeout(timer);
    clearTimeout(watchdog);
  }
}

function deliverSignal(state) {
  state.delivered = state.child.kill(state.signal);
}

function interruptedExit(state, code, signal) {
  state.completion.resolve({ code, signal });
}

function forceExit(state) {
  state.child.kill("SIGKILL");
  state.completion.reject(
    new Error("Interrupted native process did not exit."),
  );
}
