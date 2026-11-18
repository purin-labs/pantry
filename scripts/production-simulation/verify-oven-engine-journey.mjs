import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// The production engine composes six physical operations and restores inside each.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  coldCellJourneyAdapter,
  coldCellJourneySnapshot,
} from "../../packages/production-simulation/src/recipes/cold-cell-journey.ts";
import {
  OVEN_CELL,
  buildExecutionBundle,
  runtimeModule,
  prepareCell,
} from "./build-execution-bundle.mjs";

assert.equal(
  process.argv.length,
  4,
  "Provide a runtime bundle and fresh output directory",
);
const runtime = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
assert.equal(existsSync(output), false);
mkdirSync(output, { recursive: true });
const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const bundle = built.manifest.bundle;
const cell = {
  ...(await prepareCell(runtime, "cold-cell-1", OVEN_CELL)),
  runId: "oven-engine-cell",
};
const scenario = structuredClone(await coldScenario(cell));
const workflow = scenario.workflows[0];
const [admission, transfer, removal] = workflow.tasks;
const source = transfer.carriers[0].from;
const rack = transfer.carriers[0].to;
const oven = "oven-slot";
scenario.storages.push({
  id: oven,
  capacity: { kind: "carriers", slots: 1 },
  cell: cell.cellId,
});
scenario.resources.push({
  kind: "batch",
  id: "oven",
  capacity: 1,
  configuration: null,
  storage: oven,
  loadWindow: 0,
  programs: [{ id: "financier", duration: 5_000_000, evidence: "assumed" }],
});
scenario.resources.push({
  kind: "capacity",
  id: "retrieval-access",
  capacity: 1,
  configuration: null,
});
scenario.availability = [
  {
    id: "retrieval-blocked",
    resource: "retrieval-access",
    interval: { start: 0, end: 70_000_000 },
  },
];
const load = physical("oven-load", "oven-loading", source, oven, [
  admission.key,
]);
const wait = {
  key: "oven-wait",
  priority: 0,
  releaseAfter: 0,
  prerequisites: [load.key],
  claims: [],
  executor: {
    kind: "batch",
    resource: "oven",
    program: "financier",
    carrier: transfer.carriers[0].role,
    load: "oven-load",
    unload: "oven-retrieve",
  },
  inputs: [],
  outputs: [],
  releases: [],
  carriers: [],
};
const retrieve = physical("oven-retrieve", "oven-retrieval", oven, source, [
  wait.key,
]);
retrieve.claims = [
  ...retrieve.claims,
  { resource: "retrieval-access", units: 1, configuration: null },
];
const racking = physical(transfer.key, "rack-transfer", source, rack, [
  retrieve.key,
]);
workflow.tasks = [admission, load, wait, retrieve, racking, removal];
value(await E.admitScenario(scenario));
save("scenario.json", { scenario, cell, bundle });
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
function save(name, record) {
  writeFileSync(join(output, name), `${canonicalJson(record)}\n`);
}
function physical(key, skill, from, to, prerequisites) {
  return {
    key,
    priority: 0,
    releaseAfter: 0,
    prerequisites,
    claims: transfer.claims,
    executor: {
      kind: "native",
      operation: { cell: cell.cellId, skill, parameters: cell.modelHash },
    },
    inputs: [],
    outputs: [],
    releases: [],
    carriers: [
      {
        kind: "move",
        role: transfer.carriers[0].role,
        from,
        to,
        timing: { kind: "native" },
      },
    ],
  };
}
async function open(saved, leg, definition = scenario, nativeCell = cell) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const began = await host.handle({
    kind: "begin",
    bundle,
    cells: [nativeCell],
    identity: {
      runId: "oven-engine",
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
  assert.equal(began.kind, "began", JSON.stringify(began));
  return host;
}
async function drive(host, until, expectFailure = false) {
  for (let calls = 0; calls < 2000; calls++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (!expectFailure)
      assert.notEqual(
        reply.view.status.kind,
        "blocked",
        JSON.stringify(reply.view),
      );
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
  assert.fail("The oven journey exceeded its call bound");
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
let host = await open(null, "baseline");
const baseline = await drive(host, scenario.limits.horizon);
assert.equal(baseline.status.kind, "completed");
verifyCycles(baseline);
save("baseline.json", baseline);
await host.handle({ kind: "dispose" });
const stops = [];
for (const task of baseline.tasks)
  if (
    task.kind === "completed" &&
    ["oven-load", "oven-wait", "oven-retrieve", transfer.key].includes(
      task.subject.key,
    )
  )
    stops.push(
      task.startedAt +
        (task.subject.key === "oven-wait" ? 2_000_000 : 10_000_000),
    );
stops.sort(compareTime);
assert.equal(stops.length, 8);
stops.push(50_000_000);
stops.sort(compareTime);
host = await open(null, 0);
for (const [index, stop] of stops.entries()) {
  const state = await drive(host, stop);
  if (stop === 50_000_000) {
    assert.equal(
      state.resources.find(matchesTask.bind(null, "oven")).batch.kind,
      "unloading",
    );
    assert.equal(
      state.storages.find(matchesTask.bind(null, oven)).occupants.length,
      1,
    );
    assert.equal(state.tasks.some(retrievalExecuting), false);
  }
  const paused = await host.handle({
    kind: "pause",
    commandId: `pause-${index}`,
  });
  assert.equal(paused.receipt?.status, "accepted");
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  save(`save-${index}.json`, saved);
  await refuseChangedCycle(saved);
  await host.handle({ kind: "dispose" });
  host = await open(saved, index + 1);
}
const continued = await drive(host, scenario.limits.horizon);
assert.deepEqual(history(continued), history(baseline));
assert.deepEqual(world(continued), world(baseline));
assert.equal(continued.cells[0].slot.kind, "inactive");
assert.equal(continued.instances.length, 2);
save("continued.json", continued);
await host.handle({ kind: "dispose" });
await verifyFailedLoad();
await verifyFailedRetrieval();
save("report.json", {
  result: "passed",
  bundle: bundle.id,
  restores: stops,
  seconds: continued.position.time / 1_000_000,
});
console.log(`Persistent oven engine journey passed: ${output}`);
function compareTime(left, right) {
  return left - right;
}

function verifyCycles(run) {
  const cycles = run.events.filter(isCycleEvent);
  assert.deepEqual(cycles.map(cycleKind), [
    "batch-admitted",
    "batch-started",
    "batch-completed",
    "batch-cleared",
    "batch-admitted",
    "batch-started",
    "batch-completed",
    "batch-cleared",
  ]);
  for (let index = 0; index < 2; index++) {
    const [admitted, started, completed, cleared] = cycles.slice(
      index * 4,
      index * 4 + 4,
    );
    const task = run.tasks.find(matchesTask.bind(null, admitted.task));
    assert.ok(task);
    const instance = task.subject.instance;
    const loading = run.tasks.find(
      matchesTask.bind(null, `${instance}/oven-load`),
    );
    const retrieval = run.tasks.find(
      matchesTask.bind(null, `${instance}/oven-retrieve`),
    );
    assert.equal(admitted.time, loading.startedAt);
    assert.equal(started.time, loading.completedAt);
    assert.equal(completed.time, started.time + 5_000_000);
    assert.equal(retrieval.startedAt, Math.max(70_000_000, completed.time));
    assert.equal(cleared.time, retrieval.completedAt);
  }
}
function isCycleEvent(event) {
  return event.kind.startsWith("batch-");
}
function cycleKind(event) {
  return event.kind;
}
function matchesTask(id, task) {
  return task.id === id;
}

async function refuseChangedCycle(saved) {
  const changed = structuredClone(saved.document.state);
  const resource = changed.resources.find(matchesTask.bind(null, "oven"));
  if (resource.batch.kind === "idle") return;
  resource.batch.members[0].carrier = "tray-b";
  if (
    saved.document.state.resources.find(matchesTask.bind(null, "oven")).batch
      .members[0].carrier === "tray-b"
  )
    resource.batch.members[0].carrier = "tray-a";
  const altered = await E.resumableDocument(
    changed,
    bundle,
    saved.document.artifacts,
  );
  const opened = await E.openResumable(altered, "browser", [bundle]);
  assert.equal(opened.ok, false, "Restore must reject changed oven membership");
}

async function verifyFailedLoad() {
  const weakCell = {
    ...cell,
    clampForceN: 20,
    ingredients: { ...cell.ingredients, massKg: 2 },
  };
  const failureScenario = structuredClone(scenario);
  failureScenario.destinations.push({
    id: "rejected-trays",
    product: "portioned-tray",
    role: "rejected-output",
  });
  let engine = await open(null, "weak", failureScenario, weakCell);
  const failed = await drive(engine, scenario.limits.horizon, true);
  assert.equal(failed.status.kind, "blocked");
  const loading = failed.tasks.find(failedTask);
  assert.ok(loading, "The weak clamp must fail during physical handling");
  assert.equal(loading.subject.key, "oven-load");
  const ovenState = failed.resources.find(matchesTask.bind(null, "oven"));
  assert.equal(ovenState.batch.kind, "loading");
  assert.equal(ovenState.batch.members.length, 1);
  assert.equal(failed.events.some(batchStarted), false);
  const saved = await engine.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  await engine.handle({ kind: "dispose" });
  engine = await open(saved, "weak-restored", failureScenario, weakCell);
  const continued = await drive(engine, scenario.limits.horizon, true);
  assert.deepEqual(world(continued), world(failed));
  save("failed-load.json", {
    scenario: failureScenario,
    cell: weakCell,
    failed,
    saved,
    continued,
  });
  await engine.handle({ kind: "dispose" });
  const recovered = await recoverCycles(
    saved,
    failureScenario,
    weakCell,
    false,
  );
  const restored = await recoverCycles(
    saved,
    failureScenario,
    weakCell,
    true,
    "load",
  );
  assert.deepEqual(history(restored), history(recovered));
  assert.deepEqual(world(restored), world(recovered));
  save("recovered-loads.json", { recovered, restored });
}

async function recoverCycles(initial, definition, nativeCell, interrupt, name) {
  let engine = await open(
    initial,
    `recover-${interrupt}-0`,
    definition,
    nativeCell,
  );
  let run = (await engine.handle({ kind: "state" })).run;
  for (let index = 0; index < 2; index++) {
    const failed = run.tasks.find(failedTask);
    assert.ok(failed);
    const command = {
      kind: "recover",
      commandId: `reject-cycle-member-${index}`,
      task: failed.id,
      resource: "baker",
      storage: "outbound-shelf",
      handling: 5_000_000,
      evidence: "assumed",
      reports: [{ product: "portioned-tray", destination: "rejected-trays" }],
    };
    const receipt = await engine.handle(command);
    assert.equal(receipt.receipt?.status, "accepted", JSON.stringify(receipt));
    assert.deepEqual((await engine.handle(command)).receipt, receipt.receipt);
    const start = run.position.time;
    for (const [phase, offset] of [
      ["handling", 2_000_000],
      ["returning", 7_000_000],
    ]) {
      run = await drive(engine, start + offset, true);
      assert.equal(
        run.tasks.find(matchesTask.bind(null, failed.id)).recovery.phase,
        phase,
      );
      assert.equal(
        run.resources.find(matchesTask.bind(null, "oven")).batch.members.length,
        1,
      );
      assert.equal(run.events.filter(memberRejected).length, index);
      if (!interrupt) continue;
      assert.equal(
        (
          await engine.handle({
            kind: "pause",
            commandId: `pause-recovery-${index}-${phase}`,
          })
        ).receipt?.status,
        "accepted",
      );
      const saved = await engine.handle({ kind: "save" });
      assert.equal(saved.kind, "saved", JSON.stringify(saved));
      save(`${name}-recovery-${index}-${phase}.json`, saved);
      await engine.handle({ kind: "dispose" });
      engine = await open(
        saved,
        `recover-${index}-${phase}`,
        definition,
        nativeCell,
      );
    }
    run = await drive(engine, definition.limits.horizon, true);
    assert.equal(run.events.filter(memberRejected).length, index + 1);
  }
  assert.equal(
    run.resources.find(matchesTask.bind(null, "oven")).batch.kind,
    "idle",
  );
  assert.equal(run.cells[0].slot.kind, "inactive");
  assert.equal(run.cells[0].attempt, null);
  assert.equal(run.instances.filter(failedInstance).length, 2);
  let rejected = 0;
  for (const event of run.events)
    if (
      event.kind === "quantity-reported" &&
      event.destination === "rejected-trays"
    )
      rejected += event.quantity.amount;
  assert.equal(rejected, 2);
  const final = await engine.handle({ kind: "save" });
  assert.equal(final.kind, "saved", JSON.stringify(final));
  await refuseChangedRejection(final);
  await engine.handle({ kind: "dispose" });
  return run;
}
async function verifyFailedRetrieval() {
  // A cold program on the source table uses the existing rack transfer as its
  // physical unload. This isolates the batch retrieval failure boundary.
  const rackCell = await prepareCell(runtime, "cold-cell-1");
  const weakCell = {
    ...rackCell,
    runId: "batch-retrieval-cell",
    clampForceN: 20,
    ingredients: { ...rackCell.ingredients, massKg: 2.5 },
  };
  const definition = structuredClone(await coldScenario(weakCell));
  const workflow = definition.workflows[0];
  const [admission, retrieval, removal] = workflow.tasks;
  definition.destinations.push({
    id: "rejected-trays",
    product: "portioned-tray",
    role: "rejected-output",
  });
  definition.resources.push({
    kind: "batch",
    id: "oven",
    capacity: 1,
    configuration: null,
    storage: retrieval.carriers[0].from,
    loadWindow: 0,
    programs: [
      { id: "cold-process", duration: 5_000_000, evidence: "assumed" },
    ],
  });
  const process = {
    key: "cold-process",
    priority: 0,
    releaseAfter: 0,
    prerequisites: [admission.key],
    claims: [],
    carriers: [],
    inputs: [],
    outputs: [],
    releases: [],
    executor: {
      kind: "batch",
      resource: "oven",
      program: "cold-process",
      carrier: "tray",
      load: admission.key,
      unload: retrieval.key,
    },
  };
  retrieval.prerequisites = [process.key];
  workflow.tasks = [admission, process, retrieval, removal];
  const engine = await open(null, "retrieval-failure", definition, weakCell);
  const failed = await drive(engine, definition.limits.horizon, true);
  assert.equal(failed.tasks.find(failedTask)?.subject.key, retrieval.key);
  assert.equal(
    failed.resources.find(matchesTask.bind(null, "oven")).batch.kind,
    "unloading",
  );
  const saved = await engine.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  save("failed-retrieval.json", {
    scenario: definition,
    cell: weakCell,
    failed,
    saved,
  });
  await engine.handle({ kind: "dispose" });
  const recovered = await recoverCycles(
    saved,
    definition,
    weakCell,
    false,
    "retrieval",
  );
  const restored = await recoverCycles(
    saved,
    definition,
    weakCell,
    true,
    "retrieval",
  );
  assert.deepEqual(history(restored), history(recovered));
  assert.deepEqual(world(restored), world(recovered));
  assert.equal(recovered.events.filter(batchStarted).length, 2);
  save("recovered-retrievals.json", { recovered, restored });
}
function memberRejected(event) {
  return event.kind === "batch-member-rejected";
}
function failedInstance(instance) {
  return instance.kind === "failed";
}
async function refuseChangedRejection(saved) {
  for (const field of ["carrier", "recovery", "time"]) {
    const state = structuredClone(saved.document.state);
    const event = state.events.find(memberRejected);
    if (field === "carrier") event.carrier = "tray-b";
    if (field === "recovery") event.recovery = "tray-orders#1/oven-load";
    if (field === "time") event.time -= 2_000;
    const changed = await E.resumableDocument(
      state,
      bundle,
      saved.document.artifacts,
    );
    assert.equal(
      (await E.openResumable(changed, "browser", [bundle])).ok,
      false,
      field,
    );
  }
}
function failedTask(task) {
  return task.kind === "recovery-required";
}
function batchStarted(event) {
  return event.kind === "batch-started";
}
function retrievalExecuting(task) {
  return task.subject.key === "oven-retrieve" && task.kind === "executing";
}

async function coldScenario(cell) {
  return value(
    coldCellJourneyAdapter.compile(
      await coldCellJourneySnapshot(
        {
          horizonSeconds: 360,
          orders: 2,
          trays: ["tray-a", "tray-b"],
          cell: {
            id: cell.cellId,
            modelHash: cell.modelHash,
            controllerSourceHash: cell.execution.controllerSourceHash,
            timestepSeconds: cell.timestep,
            holdModel: null,
          },
          load: { pickupSeconds: 2, placementSeconds: 4, durationSeconds: 5 },
          unload: { pickupSeconds: 2, placementSeconds: 4, durationSeconds: 5 },
        },
        1,
      ),
    ),
  );
}
