import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sampleSettings,
  parseSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import {
  parsePhysicsRequest,
  parsePhysicsReplay,
  exportPhysicsRequest,
} from "../../packages/bakery-model/src/bakery-physics.ts";
import { compileWorkcellInput } from "../../packages/production-simulation/src/recipes/bakery/workcell-input.ts";
import {
  compileProductionWorkcells,
  acceptProductionRecording,
  exportProductionWorkcells,
  parseProductionWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { simulateProduction } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";
import { parseRunSnapshot } from "../../packages/bakery-model/src/bakery-run-snapshot.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
if (process.argv.length !== 3)
  throw new Error("Provide a new acceptance output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });
const settingsResult = parseSettings({
  ...sampleSettings(),
  batchCount: 3,
  traysPerBatch: 1,
  workerCount: 2,
  horizonMinutes: 240,
});
assert.equal(settingsResult.kind, "valid");
const settings = settingsResult.settings;
const manualTasks = [
  {
    bakeryTaskId: "batch:B:process:stage",
    workerId: "human-2",
    dependsOn: ["batch:A:native:1"],
    earliestStartSeconds: 3000,
  },
  {
    bakeryTaskId: "batch:C:process:pack",
    workerId: "human-1",
    dependsOn: ["batch:B:process:stage"],
    earliestStartSeconds: 0,
  },
];
const inputPath = join(output, "prepared.json");
execFileSync(binary, ["--output", inputPath, "prepare"], {
  cwd: root,
  timeout: 150000,
});
const parsed = parsePhysicsRequest(readFileSync(inputPath, "utf8"));
assert.equal(parsed.kind, "accepted", parsed.message);
const input = compileWorkcellInput(parsed.request, "0", "cold-cell-1");
assert.equal(input.kind, "ready", input.message);
const assignments = [
  {
    batchId: "A",
    tray: 1,
    workerId: "human-1",
    dependsOn: ["batch:C:process:portion"],
    earliestStartSeconds: 0,
    input: input.input,
  },
];
const compiled = await compileProductionWorkcells(
  settings,
  "normal",
  assignments,
  { manualTasks, procedureFingerprint: null },
);
assert.equal(compiled.kind, "ready", compiled.message);
let plan = compiled.plan;
const pending = simulateProduction(plan);
assert.equal(pending.kind, "blocked");
assert.equal(pending.intervals.some(isBatchBStage), false);
const request = plan.operations[0].attempt.input.request;
const requestPath = join(output, "workflow-request.json");
writeFileSync(requestPath, exportPhysicsRequest(request));
const recordingPath = join(output, "recording.json");
execFileSync(binary, ["--output", recordingPath, "run", requestPath], {
  cwd: root,
  timeout: 150000,
});
const recorded = parsePhysicsReplay(readFileSync(recordingPath, "utf8"));
assert.equal(recorded.kind, "accepted", recorded.message);
const accepted = acceptProductionRecording(
  plan,
  plan.fingerprint,
  plan.operations[0].id,
  recorded.recording,
);
assert.equal(accepted.kind, "ready", accepted.message);
plan = accepted.plan;
const run = simulateProduction(plan);
assert.equal(run.kind, "complete");
const native = run.intervals.find(isNative);
const stage = run.intervals.find(isBatchBStage);
assert.ok(native && stage);
assert.equal(stage.executor, "human-2");
assert.ok(stage.start >= native.end && stage.start >= 3000);
const batchCPack = run.intervals.find(isBatchCPack);
assert.ok(batchCPack && batchCPack.start >= stage.end);

const saved = exportProductionWorkcells(plan);
writeFileSync(join(output, "accepted-run.json"), saved);
assert.ok(
  parseRunSnapshot({
    name: "Cross-operation acceptance",
    document: JSON.parse(saved),
  }),
);
const reopened = await parseProductionWorkcells(saved);
assert.equal(reopened.kind, "ready", reopened.message);
assert.equal(simulateProduction(reopened.plan).end, run.end);
assert.deepEqual(reopened.plan.manualTasks, plan.manualTasks);

const changedRules = [
  {
    bakeryTaskId: manualTasks[0].bakeryTaskId,
    workerId: "human-1",
    dependsOn: manualTasks[0].dependsOn,
    earliestStartSeconds: 3200,
  },
  manualTasks[1],
];
const changed = await compileProductionWorkcells(
  settings,
  "normal",
  assignments,
  { manualTasks: changedRules, procedureFingerprint: null },
);
assert.equal(changed.kind, "ready", changed.message);
assert.notEqual(
  changed.plan.operations[0].attempt.input.request.attemptId,
  request.attemptId,
);
assert.equal(
  acceptProductionRecording(
    changed.plan,
    changed.plan.fingerprint,
    changed.plan.operations[0].id,
    recorded.recording,
  ).kind,
  "rejected",
);
const changedProcedure = await compileProductionWorkcells(
  settings,
  "normal",
  assignments,
  { manualTasks, procedureFingerprint: "f".repeat(64) },
);
assert.equal(changedProcedure.kind, "ready");
assert.equal(
  acceptProductionRecording(
    changedProcedure.plan,
    changedProcedure.plan.fingerprint,
    changedProcedure.plan.operations[0].id,
    recorded.recording,
  ).kind,
  "rejected",
);
const cycle = await compileProductionWorkcells(
  settings,
  "normal",
  assignments,
  {
    manualTasks: [
      {
        bakeryTaskId: "batch:A:process:stage",
        workerId: null,
        dependsOn: ["batch:A:native:1"],
        earliestStartSeconds: 0,
      },
    ],
    procedureFingerprint: null,
  },
);
assert.equal(cycle.kind, "rejected");
const mutated = JSON.parse(saved);
mutated.manualTasks[0].earliestStartSeconds += 1;
assert.equal(
  (await parseProductionWorkcells(JSON.stringify(mutated))).kind,
  "rejected",
);
const report = {
  passed: true,
  checks: [
    "manual-to-native prerequisite",
    "native-to-manual prerequisite",
    "cross-batch manual prerequisite",
    "assigned baker and earliest start",
    "actual native execution and exact acceptance",
    "saved snapshot and evidence round trip",
    "changed workflow rejects prior evidence",
    "changed procedure rejects prior evidence",
    "material-order cycle rejected",
    "modified snapshot rejected",
  ],
  fingerprint: plan.fingerprint,
  requestId: request.attemptId,
  completedBatches: run.completions.length,
  endSeconds: run.end,
  changedAttemptId: changed.plan.operations[0].attempt.input.request.attemptId,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));

function isNative(task) {
  return task.kind === "native";
}
function isBatchBStage(task) {
  return (
    task.kind === "process" && task.batch === "B" && task.operation === "stage"
  );
}
function isBatchCPack(task) {
  return (
    task.kind === "process" && task.batch === "C" && task.operation === "pack"
  );
}
