// Run two different arms through the scheduler, save/restore, and reject a
// conflicting cell edit. Evidence includes the accepted requests and recordings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertSameResult } from "./native-results.mjs";
import {
  sampleSettings,
  parseSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import {
  parsePhysicsRequest,
  parsePhysicsReplay,
  exportPhysicsRequest,
} from "../../packages/bakery-model/src/bakery-physics.ts";
import { parseRunSnapshot } from "../../packages/bakery-model/src/bakery-run-snapshot.ts";
import { compileWorkcellInput } from "../../packages/production-simulation/src/recipes/bakery/workcell-input.ts";
import {
  compileRehearsalWorkcells,
  compileProductionWorkcells,
  exportProductionWorkcells,
  parseProductionWorkcells,
  acceptProductionRecording,
  exportRehearsalWorkcells,
  parseRehearsalWorkcells,
  editRehearsalWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";

const output = resolve(process.argv[2] ?? "");
assert.equal(process.argv.length, 3, "Provide a new evidence directory.");
assert.equal(existsSync(output), false);
mkdirSync(output, { recursive: true });
const binary = resolve("crates/bakery-native/target/release/bakery-native");
const settingsResult = parseSettings({
  ...sampleSettings(),
  batchCount: 2,
  traysPerBatch: 1,
  workerCount: 2,
  horizonMinutes: 240,
});
assert.equal(settingsResult.kind, "valid");
const settings = settingsResult.settings;
const first = prepare("fairino-fr10", "cold-cell-1", "A");
const second = prepare("fanuc-crx10ial", "cold-cell-2", "B");
const compiled = await compileRehearsalWorkcells(settings, [first, second]);
assert.equal(compiled.kind, "ready", compiled.message);
let plan = compiled.plan;
assert.deepEqual(plan.cellRobots, {
  "cold-cell-1": { kind: "assigned", robot: "fairino-fr10" },
  "cold-cell-2": { kind: "assigned", robot: "fanuc-crx10ial" },
});
const conflict = await editRehearsalWorkcells(plan, {
  kind: "cell",
  batchId: "B",
  cellId: "cold-cell-1",
});
assert.equal(conflict.kind, "rejected");
assert.match(conflict.message, /already uses FAIRINO FR10/);
assert.equal(simulateProduction(plan).kind, "blocked");
plan = executePlan(plan, "rehearsal");
const production = await verifyProduction(settings, [first, second]);
const oven = {
  "fairino-fr10": verifyOvenCycle("fairino-fr10", "separate"),
  "dobot-cr10": verifyOvenCycle("dobot-cr10", "separate"),
  "universal-robots-ur5e": verifyOvenCycle("universal-robots-ur5e", "separate"),
  "universal-robots-ur5e-combined": verifyOvenCycle(
    "universal-robots-ur5e",
    "combined",
  ),
};
const run = simulateProduction(plan);
assert.equal(run.kind, "complete");
const saved = exportRehearsalWorkcells(plan);
writeFileSync(join(output, "saved-run.json"), saved);
assert.ok(
  parseRunSnapshot({
    name: "Two assigned robot cells",
    document: JSON.parse(saved),
  }),
);
const restored = await parseRehearsalWorkcells(saved);
assert.equal(restored.kind, "ready", restored.message);
assert.deepEqual(restored.plan.cellRobots, plan.cellRobots);
assert.deepEqual(simulateProduction(restored.plan), run);
const tampered = JSON.parse(saved);
tampered.cellRobots["cold-cell-2"].robot = "fairino-fr10";
const rejected = await parseRehearsalWorkcells(JSON.stringify(tampered));
assert.equal(rejected.kind, "rejected");
assert.match(rejected.message, /cell robots differ/);
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(
    {
      passed: true,
      oven,
      production,
      cellRobots: plan.cellRobots,
      rejectedCellMove: conflict.message,
      rejectedSavedAssignment: rejected.message,
      scheduler: run.kind,
      savedRunRestoredExactly: true,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Two-cell execution, conflict rejection and saved-run restore passed.",
);

function prepare(robot, cell, batchId) {
  const path = join(output, `${batchId}-prepared.json`);
  execFileSync(binary, ["--output", path, "prepare", "--robot", robot], {
    timeout: 120000,
  });
  const parsed = parsePhysicsRequest(readFileSync(path, "utf8"));
  assert.equal(parsed.kind, "accepted", parsed.message);
  const compiled = compileWorkcellInput(parsed.request, "0", cell);
  assert.equal(compiled.kind, "ready", compiled.message);
  return {
    batchId,
    workerId: batchId === "A" ? "human-1" : "human-2",
    dependsOn: [],
    earliestStartSeconds: 0,
    input: compiled.input,
    successors: [],
  };
}

function nativeResult(name, args) {
  const path = join(output, `${name}.json`);
  execFileSync(binary, ["--output", path, ...args], { timeout: 120000 });
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}
function verifyOvenCycle(robot, cell) {
  const request = nativeResult(`${robot}-${cell}-oven-request`, [
    "prepare",
    "--robot",
    robot,
    "--cell",
    cell,
    "--task",
    "table-to-oven",
  ]);
  const cycle = nativeResult(`${robot}-${cell}-oven-cycle`, [
    "cycle",
    request.path,
  ]);
  assert.equal(cycle.value.loading.outcome.kind, "completed");
  assert.equal(cycle.value.unloading.outcome.kind, "completed");
  const loaded = nativeResult(`${robot}-${cell}-oven-loaded`, [
    "load",
    request.path,
  ]);
  const paused = nativeResult(`${robot}-${cell}-oven-aligned-checkpoint`, [
    "--pause-after",
    "align_oven",
    "load",
    request.path,
  ]);
  const resumed = nativeResult(`${robot}-${cell}-oven-resumed-loading`, [
    "resume",
    paused.path,
  ]);
  assertSameResult(
    resumed.value,
    loaded.value,
    `${robot} ${cell}: loading resumed after align_oven`,
  );
  const extracting = nativeResult(
    `${robot}-${cell}-oven-extracted-checkpoint`,
    ["--pause-after", "extract_oven", "unload", loaded.path],
  );
  const returned = nativeResult(`${robot}-${cell}-oven-resumed-unloading`, [
    "resume",
    extracting.path,
  ]);
  assertSameResult(
    returned.value,
    cycle.value,
    `${robot} ${cell}: retrieval resumed after extract_oven`,
  );
  const closedRequest = nativeResult(`${robot}-${cell}-oven-closed-request`, [
    "prepare",
    "--robot",
    robot,
    "--cell",
    cell,
    "--task",
    "table-to-oven",
    "--case",
    "closed-door",
  ]);
  const closed = nativeResult(`${robot}-${cell}-oven-closed-result`, [
    "run",
    closedRequest.path,
  ]);
  assert.equal(closed.value.outcome.kind, "failed");
  return {
    loading: "completed",
    retrieval: "completed",
    alignedLoadingResumedExactly: true,
    extractedRetrievalResumedExactly: true,
    closedDoor: closed.value.outcome.reason,
  };
}

function executePlan(plan, prefix) {
  for (const operation of plan.operations) {
    const requestPath = join(
      output,
      `${prefix}-${operation.batchId}-request.json`,
    );
    const recordingPath = join(
      output,
      `${prefix}-${operation.batchId}-recording.json`,
    );
    writeFileSync(
      requestPath,
      exportPhysicsRequest(operation.attempt.input.request),
    );
    execFileSync(binary, ["--output", recordingPath, "run", requestPath], {
      timeout: 120000,
    });
    const parsed = parsePhysicsReplay(readFileSync(recordingPath, "utf8"));
    assert.equal(parsed.kind, "accepted", parsed.message);
    assert.equal(parsed.recording.outcome.kind, "completed");
    const accepted = acceptProductionRecording(
      plan,
      plan.fingerprint,
      operation.id,
      parsed.recording,
    );
    assert.equal(accepted.kind, "ready", accepted.message);
    plan = accepted.plan;
  }
  return plan;
}

function productionAssignment(tray) {
  return {
    batchId: tray.batchId,
    tray: 1,
    workerId: tray.workerId,
    dependsOn: tray.dependsOn,
    earliestStartSeconds: 0,
    input: tray.input,
  };
}
async function verifyProduction(settings, trays) {
  const compiled = await compileProductionWorkcells(
    settings,
    "normal",
    trays.map(productionAssignment),
    { manualTasks: [], procedureFingerprint: null },
  );
  assert.equal(compiled.kind, "ready", compiled.message);
  for (const operation of compiled.plan.operations)
    assert.equal(
      operation.material.resources.cell,
      operation.attempt.input.bindings.cell,
    );
  const completed = executePlan(compiled.plan, "production");
  assert.equal(simulateProduction(completed).kind, "complete");
  const saved = exportProductionWorkcells(completed);
  writeFileSync(join(output, "production-run.json"), saved);
  assert.ok(
    parseRunSnapshot({
      name: "Two production robot cells",
      document: JSON.parse(saved),
    }),
  );
  const restored = await parseProductionWorkcells(saved);
  assert.equal(restored.kind, "ready", restored.message);
  assert.deepEqual(
    simulateProduction(restored.plan),
    simulateProduction(completed),
  );
  assert.deepEqual(restored.plan.cellRobots, completed.cellRobots);
  return {
    scheduler: "complete",
    restoredExactly: true,
    materialCellsMatch: true,
  };
}
