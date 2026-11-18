import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseSettings, sampleSettings } from "@seams/bakery-model/bakery";
import {
  parsePhysicsReplay,
  exportPhysicsRequest,
} from "@seams/bakery-model/bakery-physics";
import { compileWorkcellInput } from "@seams/production-simulation/recipes/bakery/workcell-input";
import {
  acceptProductionRecording,
  compileProductionWorkcells,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import {
  metrics,
  simulate,
  simulateProduction,
} from "@seams/production-simulation/recipes/bakery/schedule";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
if (process.argv.length !== 3)
  throw new Error("Choose a new campaign output directory.");
const output = resolve(process.argv[2]);
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
if (existsSync(output)) throw new Error("Campaign output already exists.");
mkdirSync(output, { recursive: true });

function nativeResult(name, nativeCase) {
  const requestPath = join(output, `${name}-request.json`);
  const resultPath = join(output, `${name}-recording.json`);
  execFileSync(
    binary,
    ["--output", requestPath, "prepare", "--case", nativeCase],
    {
      cwd: root,
      timeout: 150_000,
    },
  );
  execFileSync(binary, ["--output", resultPath, "run", requestPath], {
    cwd: root,
    timeout: 150_000,
  });
  return readRecording(resultPath);
}

function timedOutNativeResult(name) {
  const requestPath = join(output, `${name}-request.json`);
  const resultPath = join(output, `${name}-recording.json`);
  execFileSync(
    binary,
    ["--output", requestPath, "prepare", "--case", "nominal"],
    {
      cwd: root,
      timeout: 150_000,
    },
  );
  const timeout = spawnSync(
    binary,
    ["--output", resultPath, "run", requestPath],
    {
      cwd: root,
      timeout: 50,
      encoding: "utf8",
    },
  );
  assert.equal(timeout.error?.code, "ETIMEDOUT");
  assert.equal(existsSync(resultPath), false);
  execFileSync(binary, ["--output", resultPath, "run", requestPath], {
    cwd: root,
    timeout: 150_000,
  });
  return {
    recording: readRecording(resultPath),
    timeout: {
      operation: name,
      budgetMs: 50,
      signal: timeout.signal,
      errorCode: timeout.error.code,
      outputCreatedBeforeRetry: false,
    },
  };
}

function readRecording(path) {
  const parsed = parsePhysicsReplay(readFileSync(path, "utf8"));
  assert.equal(parsed.kind, "accepted", parsed.message);
  return parsed.recording;
}

function assigned(batchId, recording, dependsOn = []) {
  const compiled = compileWorkcellInput(recording.request, "0", "cold-cell-1");
  assert.equal(compiled.kind, "ready");
  return {
    batchId,
    tray: 1,
    workerId: batchId === "A" ? "human-1" : "human-2",
    dependsOn,
    earliestStartSeconds: 0,
    input: compiled.input,
  };
}

async function campaignCase(
  settings,
  name,
  first,
  second,
  missingResult = null,
) {
  const compiled = await compileProductionWorkcells(
    settings,
    "normal",
    [assigned("A", first), assigned("B", second, ["batch:A:native:1"])],
    { manualTasks: [], procedureFingerprint: null },
  );
  assert.equal(compiled.kind, "ready", compiled.message);
  let plan = compiled.plan;
  if (missingResult !== "A") {
    const accepted = acceptProductionRecording(
      plan,
      plan.fingerprint,
      "batch:A:native:1",
      executeWorkflowRequest(plan, "batch:A:native:1"),
    );
    assert.equal(accepted.kind, "ready", accepted.message);
    plan = accepted.plan;
  }
  if (missingResult !== "B") {
    const acceptedSecond = acceptProductionRecording(
      plan,
      plan.fingerprint,
      "batch:B:native:1",
      executeWorkflowRequest(plan, "batch:B:native:1"),
    );
    assert.equal(acceptedSecond.kind, "ready", acceptedSecond.message);
    plan = acceptedSecond.plan;
  }
  const start = performance.now();
  const run = simulateProduction(plan);
  const schedulerMs = performance.now() - start;
  const result = metrics(run);
  const completion = {};
  for (const entry of run.completions) completion[entry.batch] = entry.time;
  let overdueUnfinished = 0;
  if (run.kind !== "complete") {
    for (const batch of run.batches)
      if (run.unfinished.includes(batch.id) && batch.deadline < run.end)
        overdueUnfinished++;
  }
  const shouldComplete =
    missingResult === null &&
    first.outcome.kind === "completed" &&
    second.outcome.kind === "completed";
  if (shouldComplete) {
    assert.equal(run.kind, "complete");
    assert.equal(run.nativeHolds.length, 0);
    assert.deepEqual(Object.keys(completion).sort(), ["A", "B", "C"]);
  } else {
    const heldBatch =
      missingResult === "B" || second.outcome.kind !== "completed" ? "B" : "A";
    assert.equal(run.kind, "blocked");
    assert.equal(run.nativeHolds.length, 1);
    assert.equal(
      run.nativeHolds[0].operation.id,
      `batch:${heldBatch}:native:1`,
    );
    if (heldBatch === "A") {
      assert.equal(completion.A, undefined);
      assert.ok(run.unresolvedWaits.some(dependentBatchB));
    } else {
      assert.ok(completion.A !== undefined);
    }
    assert.equal(completion.B, undefined);
    assert.ok(completion.C !== undefined);
    assert.ok(run.nativeReservations.some(activeReservation));
    if (missingResult !== null)
      assert.equal(run.nativeHolds[0].kind, "awaiting-evidence");
    else assert.equal(run.nativeHolds[0].kind, "failed");
  }
  let nativeOutcome = first.outcome;
  if (missingResult !== null) {
    nativeOutcome = `missing-${missingResult.toLowerCase()}-result`;
  } else if (second.outcome.kind !== "completed") {
    nativeOutcome = second.outcome;
  }
  return {
    name,
    nativeOutcome,
    runKind: run.kind,
    endSeconds: run.end,
    completions: completion,
    metrics: result,
    overdueUnfinished,
    unresolvedWaits: run.unresolvedWaits.map(waitSummary),
    schedulerMs,
  };
}

function dependentBatchB(wait) {
  return wait.batch === "B" && wait.reason === "dependency";
}
function activeReservation(reservation) {
  return reservation.kind !== "released";
}
function waitSummary(wait) {
  return { batch: wait.batch, reason: wait.reason, label: wait.label };
}
function numeric(left, right) {
  return left - right;
}

async function schedulerCapacityBenchmark(recording) {
  const parsed = parseSettings({
    ...sampleSettings(),
    batchCount: 4,
    traysPerBatch: 4,
    workerCount: 3,
    rackTrays: 8,
    horizonMinutes: 240,
  });
  assert.equal(parsed.kind, "valid");
  const assignments = [];
  const recordings = [];
  for (const batchId of ["A", "B", "C", "D"]) {
    for (let tray = 1; tray <= 4; tray++) {
      const identity = `${batchId}-${tray}`;
      const raw = structuredClone(recording);
      raw.request.runId = `campaign-${identity}`;
      raw.request.attemptId = `campaign-attempt-${identity}`;
      const variant = parsePhysicsReplay(JSON.stringify(raw));
      assert.equal(variant.kind, "accepted", variant.message);
      recordings.push(variant.recording);
      assignments.push({
        ...assigned(batchId, variant.recording),
        tray,
        workerId: `human-${1 + (assignments.length % 3)}`,
      });
    }
  }
  const compiled = await compileProductionWorkcells(
    parsed.settings,
    "normal",
    assignments,
    { manualTasks: [], procedureFingerprint: null },
  );
  assert.equal(compiled.kind, "ready", compiled.message);
  let plan = compiled.plan;
  for (const [index, assignment] of assignments.entries()) {
    const accepted = acceptProductionRecording(
      plan,
      plan.fingerprint,
      `batch:${assignment.batchId}:native:${assignment.tray}`,
      capacityRecording(
        recordings[index],
        plan.operations[index].attempt.input.request,
      ),
    );
    assert.equal(accepted.kind, "ready", accepted.message);
    plan = accepted.plan;
  }
  const samples = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    const start = performance.now();
    const run = simulateProduction(plan);
    samples.push(performance.now() - start);
    assert.equal(run.kind, "complete");
  }
  samples.sort(numeric);
  return {
    operations: assignments.length,
    trials: samples.length,
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    maxMs: samples.at(-1),
  };
}

const parsedSettings = parseSettings({
  ...sampleSettings(),
  batchCount: 3,
  traysPerBatch: 1,
  workerCount: 2,
});
assert.equal(parsedSettings.kind, "valid");
const settings = parsedSettings.settings;
const baseline = simulate(settings, "normal");
const reference = {
  runKind: baseline.kind,
  endSeconds: baseline.end,
  metrics: metrics(baseline),
};
const nominal = nativeResult("nominal", "nominal");
assert.equal(nominal.outcome.kind, "completed");
const second = nativeResult("second", "nominal");
const timedOutA = timedOutNativeResult("timed-out-a");
const timedOutB = timedOutNativeResult("timed-out-b");
const cases = [
  await campaignCase(settings, "nominal", nominal, second),
  await campaignCase(
    settings,
    "runner-timeout-a",
    timedOutA.recording,
    second,
    "A",
  ),
  await campaignCase(
    settings,
    "after-explicit-a-retry",
    timedOutA.recording,
    second,
  ),
  await campaignCase(
    settings,
    "runner-timeout-b",
    nominal,
    timedOutB.recording,
    "B",
  ),
  await campaignCase(
    settings,
    "after-explicit-b-retry",
    nominal,
    timedOutB.recording,
  ),
  await campaignCase(
    settings,
    "blocked",
    nativeResult("blocked", "blocked"),
    second,
  ),
  await campaignCase(
    settings,
    "unreachable",
    nativeResult("unreachable", "unreachable"),
    second,
  ),
  await campaignCase(settings, "slip", nativeResult("slip", "slip"), second),
  await campaignCase(
    settings,
    "second-blocked",
    nominal,
    nativeResult("second-blocked", "blocked"),
  ),
  await campaignCase(settings, "withheld-first-result", nominal, second, "A"),
  await campaignCase(settings, "withheld-second-result", nominal, second, "B"),
];
for (const result of cases) {
  result.finishDifferenceSeconds =
    result.runKind === "complete"
      ? result.endSeconds - reference.endSeconds
      : null;
  result.waitDifferenceSeconds =
    result.metrics.waiting - reference.metrics.waiting;
  result.lateDifference = result.metrics.late - reference.metrics.late;
  result.lateOrOverdue = result.metrics.late + result.overdueUnfinished;
}
const artifactBytes = {};
for (const name of readdirSync(output)) {
  artifactBytes[name] = statSync(join(output, name)).size;
}
const report = {
  reference,
  nativeTimeouts: [timedOutA.timeout, timedOutB.timeout],
  cases,
  capacityBenchmark: await schedulerCapacityBenchmark(nominal),
  artifactBytes,
};
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function executeWorkflowRequest(plan, operationId) {
  const operation = plan.operations.find(
    matchesOperation.bind(null, operationId),
  );
  assert.ok(operation);
  const request = operation.attempt.input.request;
  const requestPath = join(output, `${request.attemptId}-request.json`);
  const recordingPath = join(output, `${request.attemptId}-recording.json`);
  if (!existsSync(recordingPath)) {
    writeFileSync(requestPath, exportPhysicsRequest(request));
    execFileSync(binary, ["--output", recordingPath, "run", requestPath], {
      cwd: root,
      timeout: 150000,
    });
  }
  return readRecording(recordingPath);
}
function matchesOperation(id, operation) {
  return operation.id === id;
}
function capacityRecording(recording, request) {
  const parsed = parsePhysicsReplay(JSON.stringify({ ...recording, request }));
  assert.equal(parsed.kind, "accepted");
  return parsed.recording;
}
