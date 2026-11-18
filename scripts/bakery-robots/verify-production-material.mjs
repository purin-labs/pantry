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
import { productionMaterialAt } from "../../packages/production-simulation/src/recipes/bakery/production-material.ts";
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
const settings = parseSettings({
  ...sampleSettings(),
  batchCount: 2,
  traysPerBatch: 1,
  workerCount: 2,
  horizonMinutes: 240,
});
assert.equal(settings.kind, "valid");
const success = await campaign("nominal", "nominal");
writeFileSync(
  join(output, "pending-run.json"),
  exportProductionWorkcells(success.pending),
);
const pending = simulateProduction(success.pending);
const operation = success.pending.operations[0];
assert.equal(pending.nativeReservations.length, 1);
assert.equal(
  productionMaterialAt(pending, operation, pending.end).kind,
  "awaiting-evidence",
);
assert.equal(
  productionMaterialAt(pending, success.pending.operations[1], pending.end)
    .kind,
  "waiting",
);
const run = simulateProduction(success.plan);
assert.equal(run.kind, "complete");
assert.equal(run.completions.length, 2);
const first = success.plan.operations[0];
const stage = run.intervals.find(stageFor.bind(null, first.id));
const native = run.intervals.find(nativeFor.bind(null, first.id));
const clear = run.intervals.find(clearFor.bind(null, first.id));
assert.ok(stage && native && clear);
const pickup = native.recording.events.find(pickupEvent);
assert.ok(pickup);
assert.equal(productionMaterialAt(run, first, stage.start).kind, "staging");
assert.equal(productionMaterialAt(run, first, native.start).location, "source");
assert.equal(
  productionMaterialAt(
    run,
    first,
    native.start + pickup.step * native.recording.request.timestep + 0.001,
  ).location,
  "gripped",
);
assert.equal(productionMaterialAt(run, first, clear.start).kind, "clearing");
assert.equal(productionMaterialAt(run, first, clear.end).kind, "released");
const reservations = run.nativeReservations;
assert.equal(new Set(reservations.map(materialId)).size, 2);
assert.equal(reservations[0].end, clear.end);
assert.ok(reservations[1].start >= reservations[0].end);
assert.equal(reservations[0].materialId, "batch:A:tray:1");

const rejected = [];
for (const mutation of [
  wrongTool,
  wrongSource,
  wrongDestination,
  closedClamp,
  misalignedJaw,
]) {
  const candidate = JSON.parse(JSON.stringify(success.recordings[0]));
  mutation(candidate);
  writeFileSync(
    join(output, `${mutation.name}-recording.json`),
    JSON.stringify(candidate),
  );
  const parsed = parsePhysicsReplay(JSON.stringify(candidate));
  assert.equal(parsed.kind, "accepted", parsed.message);
  const result = acceptProductionRecording(
    success.pending,
    success.pending.fingerprint,
    first.id,
    parsed.recording,
  );
  assert.equal(result.kind, "rejected", mutation.name);
  rejected.push({ mutation: mutation.name, reason: result.message });
}
assert.equal(success.pending.operations[0].attempt.kind, "awaiting-evidence");
const failure = await campaign("slip", "nominal");
const failedRun = simulateProduction(failure.plan);
assert.equal(failedRun.kind, "blocked");
const held = productionMaterialAt(
  failedRun,
  failure.plan.operations[0],
  failedRun.end,
);
assert.equal(held.kind, "recovery-required");
assert.equal(held.tool, "held");
assert.equal(failedRun.nativeReservations.length, 1);
assert.equal(failedRun.nativeReservations[0].kind, "held");
assert.equal(
  productionMaterialAt(failedRun, failure.plan.operations[1], failedRun.end)
    .kind,
  "waiting",
);

for (const [name, result] of [
  ["completed", success],
  ["failed", failure],
]) {
  const file = exportProductionWorkcells(result.plan);
  writeFileSync(join(output, `${name}-run.json`), file);
  assert.ok(
    parseRunSnapshot({
      name: `${name} material handoff`,
      document: JSON.parse(file),
    }),
  );
  const restored = await parseProductionWorkcells(file);
  assert.equal(restored.kind, "ready", restored.message);
  const restoredRun = simulateProduction(restored.plan);
  const originalRun = simulateProduction(result.plan);
  assert.deepEqual(
    restoredRun.nativeReservations,
    originalRun.nativeReservations,
  );
  assert.deepEqual(
    productionMaterialAt(
      restoredRun,
      restored.plan.operations[0],
      restoredRun.end,
    ),
    productionMaterialAt(
      originalRun,
      result.plan.operations[0],
      originalRun.end,
    ),
  );
}
const report = {
  passed: true,
  checks: [
    "pending material owns exclusive cell",
    "staging, source, grasp and clearance custody",
    "distinct tray identities share one fixture serially",
    "mismatched tooling and source/destination poses rejected without settlement",
    "closed clamp cannot clear material",
    "failed transfer retains material and tooling and blocks successor",
    "completed and held custody survives file and shared-storage envelope round trip",
  ],
  completedBatches: run.completions.length,
  endSeconds: run.end,
  checkpoints: {
    staging: stage.start,
    source: native.start,
    grasp:
      native.start + pickup.step * native.recording.request.timestep + 0.001,
    clearance: clear.start,
    released: clear.end,
    failed: failedRun.end,
  },
  rejected,
  held,
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));

async function campaign(firstCase, secondCase) {
  const assignments = [];
  for (const [batchId, nativeCase] of [
    ["A", firstCase],
    ["B", secondCase],
  ]) {
    const path = join(output, `${firstCase}-${batchId}-prepared.json`);
    execFileSync(binary, ["--output", path, "prepare", "--case", nativeCase], {
      cwd: root,
      timeout: 150000,
    });
    const request = parsePhysicsRequest(readFileSync(path, "utf8"));
    assert.equal(request.kind, "accepted", request.message);
    const input = compileWorkcellInput(request.request, "0", "cold-cell-1");
    assert.equal(input.kind, "ready");
    assignments.push({
      batchId,
      tray: 1,
      workerId: "human-1",
      dependsOn: batchId === "B" ? ["batch:A:native:1"] : [],
      earliestStartSeconds: 0,
      input: input.input,
    });
  }
  const compiled = await compileProductionWorkcells(
    settings.settings,
    "normal",
    assignments,
    { manualTasks: [], procedureFingerprint: null },
  );
  assert.equal(compiled.kind, "ready", compiled.message);
  let plan = compiled.plan;
  const recordings = [];
  for (const operation of plan.operations) {
    const request = join(
      output,
      `${firstCase}-${operation.batchId}-request.json`,
    );
    const path = join(
      output,
      `${firstCase}-${operation.batchId}-recording.json`,
    );
    writeFileSync(
      request,
      exportPhysicsRequest(operation.attempt.input.request),
    );
    execFileSync(binary, ["--output", path, "run", request], {
      cwd: root,
      timeout: 150000,
    });
    const parsed = parsePhysicsReplay(readFileSync(path, "utf8"));
    assert.equal(parsed.kind, "accepted", parsed.message);
    recordings.push(parsed.recording);
    const result = acceptProductionRecording(
      plan,
      plan.fingerprint,
      operation.id,
      parsed.recording,
    );
    assert.equal(result.kind, "ready", result.message);
    plan = result.plan;
  }
  return { pending: compiled.plan, plan, recordings };
}
function stageFor(id, task) {
  return (
    task.kind === "handoff" && task.operationId === id && task.phase === "stage"
  );
}
function clearFor(id, task) {
  return (
    task.kind === "handoff" && task.operationId === id && task.phase === "clear"
  );
}
function nativeFor(id, task) {
  return task.kind === "native" && task.operation.id === id;
}
function pickupEvent(event) {
  return event.kind === "pickup";
}
function materialId(reservation) {
  return reservation.materialId;
}
function clampGeometry(geometry) {
  return geometry.name === "clamp_palm";
}
function wrongTool(recording) {
  recording.geometry.find(clampGeometry).size[0] *= 2;
}
function wrongSource(recording) {
  recording.samples[0].tray[0] += 0.1;
}
function wrongDestination(recording) {
  recording.samples.at(-1).tray[0] += 0.1;
}
function closedClamp(recording) {
  recording.samples.at(-1).jaw = [...recording.samples.at(-1).tool];
}
function misalignedJaw(recording) {
  recording.samples.at(-1).jaw[0] += 0.1;
}
