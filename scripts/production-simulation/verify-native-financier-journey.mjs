import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Authored production, repeated use of one physical cell, and fresh-host restore.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  parseSettings,
  sampleSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import { parsePhysicsRequest } from "../../packages/bakery-model/src/bakery-physics.ts";
import { compileWorkcellInput } from "../../packages/production-simulation/src/recipes/bakery/workcell-input.ts";
import {
  compileProductionWorkcells,
  exportProductionWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import { compileProductionFinancier } from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import { WasmHost, program } from "./engine-hosts.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false);
mkdirSync(output, { recursive: true });
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${BAKERY_BROWSER_BUNDLE.id}`,
);
const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const bundle = built.manifest.bundle;
const cell = {
  ...(await prepareCell(runtime, "cold-cell-1")),
  runId: "native-financier-cell",
};
const { request } = await program(new WasmHost(await runtimeModule(runtime)), {
  op: "prepare",
  preparation: {},
});
const parsed = parseSettings({
  ...sampleSettings(),
  batchCount: 3,
  traysPerBatch: 1,
  workerCount: 2,
  rackTrays: 6,
  horizonMinutes: 240,
});
assert.equal(parsed.kind, "valid");
const settings = parsed.settings;
const assignments = [];
for (const batchId of ["A", "B"]) {
  const raw = {
    ...request,
    runId: `financier-${batchId}`,
    attemptId: `request-${batchId}`,
  };
  const checked = parsePhysicsRequest(JSON.stringify(raw));
  assert.equal(checked.kind, "accepted", checked.message);
  const input = compileWorkcellInput(checked.request, "0", "cold-cell-1");
  assert.equal(input.kind, "ready", input.message);
  assignments.push({
    batchId,
    tray: 1,
    workerId: "human-1",
    earliestStartSeconds: 0,
    dependsOn: batchId === "A" ? ["batch:C:process:portion"] : [],
    input: input.input,
  });
}
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
const compiled = await compileProductionWorkcells(
  settings,
  "normal",
  assignments,
  { manualTasks, procedureFingerprint: null },
);
assert.equal(compiled.kind, "ready", compiled.message);
const plan = compiled.plan;
save("definitions.json", {
  cell,
  request: plan.operations[0].attempt.input.request,
});
const scenario = value(await compileProductionFinancier(plan, [cell]));
value(await E.admitScenario(scenario));
save("input.json", {
  scenario,
  cells: [cell],
  plan: JSON.parse(exportProductionWorkcells(plan)),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}
function save(name, content) {
  writeFileSync(join(output, name), `${canonicalJson(content)}\n`);
}
async function open(saved, leg, definition = scenario, nativeCell = cell) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const reply = await host.handle({
    kind: "begin",
    bundle,
    cells: [nativeCell],
    identity: {
      runId: "native-financier",
      executionId: `leg-${leg}`,
      hostSession: `host-${leg}`,
      parent:
        saved === null
          ? null
          : {
              snapshot: saved.document.snapshot,
              execution: saved.document.state.identity.executionId,
            },
    },
    origin:
      saved === null
        ? { kind: "scenario", scenario: definition }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
  });
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  return host;
}
async function drive(host, until) {
  for (let turn = 0; turn < 2000; turn++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (
      reply.view.time >= until ||
      reply.view.status.kind === "completed" ||
      reply.view.status.kind === "blocked"
    ) {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      return state.run;
    }
  }
  throw new Error("Native recipe exceeded its host-call bound");
}
function byId(id, item) {
  return item.id === id;
}
function task(run, id) {
  const found = run.tasks.find(byId.bind(null, id));
  assert.ok(found, id);
  return found;
}
function history(run) {
  const events = [];
  for (const { sequence, execution, ...event } of run.events)
    if (event.kind !== "command-admitted") events.push(event);
  return events;
}
function world(run) {
  const { identity, events, commands, position, ...state } = run;
  return { ...state, time: position.time };
}
function verify(run) {
  assert.equal(run.status.kind, "completed");
  const first = task(run, "batch-A#0/native-1");
  const second = task(run, "batch-B#0/native-1");
  const bStage = task(run, "batch-B#0/stage");
  assert.ok(bStage.startedAt >= Math.max(3_000_000_000, first.completedAt));
  assert.ok(
    task(run, "batch-A#0/handoff-1-stage").startedAt >=
      task(run, "batch-C#0/portion").completedAt,
  );
  assert.ok(task(run, "batch-C#0/pack").startedAt >= bStage.completedAt);
  assert.ok(
    second.startedAt >= task(run, "batch-A#0/handoff-1-clear").completedAt,
  );
  let packed = 0;
  let assignments = 0;
  for (const event of run.events) {
    if (
      event.kind === "quantity-reported" &&
      event.destination === "packed-financiers"
    )
      packed += event.quantity.amount;
    if (event.kind === "worker-assigned" && event.task === bStage.id) {
      assert.equal(event.worker, "human-2");
      assignments++;
    }
  }
  assert.equal(assignments, 1);
  assert.equal(packed, 72);
  assert.equal(run.instances.filter(completedInstance).length, 3);
  for (const carrier of run.carriers) {
    assert.equal(carrier.bound, null);
    assert.equal(carrier.custody.kind, "stored");
    assert.equal(carrier.custody.storage, "dispatch");
  }
  assert.equal(run.cells[0].slot.kind, "inactive");
}
function completedInstance(instance) {
  return instance.kind === "completed";
}
const baselineHost = await open(null, 0);
const baseline = await drive(
  baselineHost,
  settings.horizonMinutes * 60_000_000,
);
verify(baseline);
save("baseline.json", baseline);
await baselineHost.handle({ kind: "dispose" });
const first = task(baseline, "batch-A#0/native-1");
const second = task(baseline, "batch-B#0/native-1");
const stops = [
  first.startedAt + 10_000_000,
  first.completedAt + 5_000_000,
  second.startedAt + 10_000_000,
];
let host = await open(null, 1);
let leg = 1;
for (const stop of stops) {
  const state = await drive(host, stop);
  assert.equal(state.status.kind, "advancing");
  const paused = await host.handle({
    kind: "pause",
    commandId: `pause-${leg}`,
  });
  assert.equal(paused.receipt.status, "accepted");
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  save(`save-${leg}.json`, saved);
  await host.handle({ kind: "dispose" });
  host = await open(saved, ++leg);
}
const continued = await drive(host, settings.horizonMinutes * 60_000_000);
verify(continued);
assert.deepEqual(history(continued), history(baseline));
assert.deepEqual(world(continued), world(baseline));
save("continued.json", continued);
await host.handle({ kind: "dispose" });
const refusals = [];
for (const field of [
  "robot",
  "ingredients",
  "clampForceN",
  "modelHash",
  "execution",
]) {
  const edited = structuredClone(cell);
  if (field === "robot") edited.robot = "ur5e";
  if (field === "ingredients") edited.ingredients.massKg = 2;
  if (field === "clampForceN") edited.clampForceN = 20;
  if (field === "modelHash") edited.modelHash = "0".repeat(64);
  if (field === "execution") edited.execution.runtimeHash = "0".repeat(64);
  const result = await compileProductionFinancier(plan, [edited]);
  assert.equal(result.ok, false, field);
  refusals.push({ field, definition: edited, result });
}
const grouped = parseSettings({ ...settings, traysPerBatch: 2 });
assert.equal(grouped.kind, "valid");
const groupPlan = await compileProductionWorkcells(
  grouped.settings,
  "normal",
  assignments,
  { manualTasks, procedureFingerprint: null },
);
assert.equal(groupPlan.kind, "ready");
const groupResult = await compileProductionFinancier(groupPlan.plan, [cell]);
assert.equal(groupResult.ok, false);
refusals.push({ field: "tray-group", result: groupResult });
save("refusals.json", refusals);
await verifyFailure();
await refuseUnsupportedSkill();
save("report.json", {
  result: "passed",
  bundle: bundle.id,
  simulatedSeconds: baseline.position.time / 1_000_000,
  nativeOperations: 2,
  packed: 72,
  restores: stops,
  refusals: refusals.length,
});
console.log(`Native financier journey passed: ${output}`);

async function verifyFailure() {
  const weakCell = {
    ...cell,
    clampForceN: 20,
    ingredients: { ...cell.ingredients, massKg: 2.5 },
  };
  const weakAssignments = [];
  for (const assignment of assignments) {
    const parsed = parsePhysicsRequest(
      JSON.stringify({
        ...assignment.input.request,
        clampForceN: 20,
        ingredients: weakCell.ingredients,
      }),
    );
    assert.equal(parsed.kind, "accepted");
    const input = compileWorkcellInput(parsed.request, "0", "cold-cell-1");
    assert.equal(input.kind, "ready");
    weakAssignments.push({ ...assignment, input: input.input });
  }
  const authored = await compileProductionWorkcells(
    settings,
    "normal",
    weakAssignments,
    { manualTasks, procedureFingerprint: null },
  );
  assert.equal(authored.kind, "ready");
  const weakScenario = value(
    await compileProductionFinancier(authored.plan, [weakCell]),
  );
  let engine = await open(null, "weak", weakScenario, weakCell);
  const failed = await drive(engine, settings.horizonMinutes * 60_000_000);
  assert.equal(failed.status.kind, "blocked");
  assert.equal(task(failed, "batch-A#0/native-1").kind, "recovery-required");
  assert.equal(task(failed, "batch-B#0/stage").kind, "waiting");
  assert.equal(task(failed, "batch-C#0/pack").kind, "waiting");
  const saved = await engine.handle({ kind: "save" });
  assert.equal(saved.kind, "saved");
  await engine.handle({ kind: "dispose" });
  engine = await open(saved, "weak-restored", weakScenario, weakCell);
  const continued = await drive(engine, settings.horizonMinutes * 60_000_000);
  assert.deepEqual(world(continued), world(failed));
  save("failed-transfer.json", {
    scenario: weakScenario,
    cells: [weakCell],
    failed,
    saved,
    continued,
  });
  await engine.handle({ kind: "dispose" });
  await verifyWorkerRecovery(saved, weakScenario, weakCell);
}

async function verifyWorkerRecovery(failedSave, definition, nativeCell) {
  const command = {
    kind: "recover-with-worker",
    commandId: "worker-recovery",
    task: "batch-A#0/native-1",
    resource: "human-1",
    location: "cool",
    storage: "rejected-tray-groups",
    handling: 5_000_000,
    evidence: "assumed",
    reports: [{ product: "financiers", destination: "rejected-financiers" }],
  };
  let engine = await open(
    failedSave,
    "recovery-reference",
    definition,
    nativeCell,
  );
  for (const invalid of [
    { ...command, location: "unknown-station" },
    { ...command, handling: 300_000_000 },
  ]) {
    const refused = await engine.handle(invalid);
    assert.equal(refused.receipt?.reason, "recovery_unavailable");
  }
  const admitted = await engine.handle(command);
  assert.equal(admitted.receipt?.status, "accepted", JSON.stringify(admitted));
  assert.deepEqual((await engine.handle(command)).receipt, admitted.receipt);
  const assigned = (await engine.handle({ kind: "state" })).run;
  const recovery = task(assigned, command.task).recovery;
  assert.ok(recovery.arrivesAt > recovery.startedAt);
  const stops = [
    recovery.startedAt + 2_000,
    recovery.arrivesAt + 2_000_000,
    recovery.removesAt + 2_000_000,
  ];
  const baseline = await drive(engine, definition.limits.horizon);
  verifyRecoveredFinancier(baseline);
  await engine.handle({ kind: "dispose" });
  engine = await open(failedSave, "recovery-0", definition, nativeCell);
  assert.equal((await engine.handle(command)).receipt?.status, "accepted");
  const saves = [];
  for (const [index, stop] of stops.entries()) {
    const state = await drive(engine, stop);
    const worker = state.resources.find(byId.bind(null, "human-1"));
    const transfer = task(state, command.task);
    assert.equal(transfer.kind, "recovering");
    assert.equal(
      transfer.recovery.phase,
      index === 2 ? "returning" : "handling",
    );
    assert.equal(worker.position.kind, index === 2 ? "idle" : "assigned");
    assert.equal(worker.allocations.length, index === 2 ? 0 : 1);
    const paused = await engine.handle({
      kind: "pause",
      commandId: `recovery-pause-${index}`,
    });
    assert.equal(paused.receipt?.status, "accepted");
    const saved = await engine.handle({ kind: "save" });
    assert.equal(saved.kind, "saved", JSON.stringify(saved));
    save(`worker-recovery-save-${index}.json`, saved);
    await refuseRecoveryTiming(saved);
    saves.push(saved);
    await engine.handle({ kind: "dispose" });
    engine = await open(saved, `recovery-${index + 1}`, definition, nativeCell);
  }
  const continued = await drive(engine, definition.limits.horizon);
  verifyRecoveredFinancier(continued);
  assert.deepEqual(history(continued), history(baseline));
  assert.deepEqual(world(continued), world(baseline));
  save("worker-recovery.json", {
    result: "passed",
    command,
    stops,
    saves,
    baseline,
    continued,
  });
  await engine.handle({ kind: "dispose" });
}

async function refuseRecoveryTiming(saved) {
  const changed = structuredClone(saved.document.state);
  const transfer = task(changed, "batch-A#0/native-1");
  transfer.recovery.arrivesAt += 2_000;
  transfer.recovery.removesAt += 2_000;
  const altered = await E.resumableDocument(
    changed,
    bundle,
    saved.document.artifacts,
  );
  const opened = await E.openResumable(altered, "browser", [bundle]);
  assert.equal(
    opened.ok,
    false,
    "Restore must reject a changed recovery route time",
  );
}

function verifyRecoveredFinancier(run) {
  const transfer = task(run, "batch-A#0/native-1");
  assert.equal(transfer.kind, "failed");
  assert.equal(task(run, "batch-A#0/handoff-1-clear").kind, "cancelled");
  assert.equal(task(run, "batch-B#0/stage").kind, "waiting");
  assert.equal(task(run, "batch-C#0/pack").kind, "waiting");
  assert.equal(run.cells[0].slot.kind, "inactive");
  assert.equal(run.cells[0].attempt, null);
  assert.deepEqual(run.resources.find(byId.bind(null, "human-1")).position, {
    kind: "idle",
    at: "cool",
  });
  const carrier = run.carriers.find(byId.bind(null, "tray-group-A"));
  assert.equal(carrier.bound, null);
  assert.deepEqual(carrier.custody, {
    kind: "stored",
    storage: "rejected-tray-groups",
  });
  let rejected = 0;
  for (const event of run.events)
    if (
      event.kind === "quantity-reported" &&
      event.destination === "rejected-financiers"
    )
      rejected += event.quantity.amount;
  assert.equal(rejected, 24);
}

async function refuseUnsupportedSkill() {
  const unsupported = structuredClone(scenario);
  unsupported.workflows[0].tasks.find(
    byIdKey.bind(null, "native-1"),
  ).executor.operation.skill = "oven-loading";
  const engine = await open(null, "unsupported", unsupported);
  let reply;
  for (let turn = 0; turn < 2000; turn++) {
    reply = await engine.handle({
      kind: "drive",
      turns: 128,
      until: settings.horizonMinutes * 60_000_000,
    });
    if (reply.kind === "refused") break;
  }
  assert.equal(reply.kind, "refused");
  assert.equal(reply.reason, "physics_fault");
  assert.equal(reply.detail.failure.code, "incompatible_start");
  save("unsupported-skill.json", { scenario: unsupported, reply });
}
function byIdKey(key, step) {
  return step.key === key;
}
