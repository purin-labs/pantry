import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Shared processing, finite buffers, fresh hosts and real MuJoCo upstream work.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import {
  coldCellJourneyAdapter,
  coldCellJourneySnapshot,
} from "../../packages/production-simulation/src/recipes/cold-cell-journey.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh artifact directory");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${BAKERY_BROWSER_BUNDLE.id}`,
);
const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const bundle = built.manifest.bundle;
const cellDocument = await prepareCell(runtime, "cold-cell-1");
const cell = value(E.parseNativeCell(cellDocument));
const base = value(
  coldCellJourneyAdapter.compile(
    await coldCellJourneySnapshot(
      {
        horizonSeconds: 600,
        orders: 3,
        trays: ["tray-a", "tray-b"],
        cell: {
          id: cell.cellId,
          modelHash: cell.modelHash,
          controllerSourceHash: cell.controllerSourceHash,
          timestepSeconds: 0.002,
          holdModel: "cold-cell-rest.1",
        },
        load: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
        unload: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
      },
      1,
    ),
  ),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};

function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
function save(name, content) {
  writeFileSync(join(output, name), `${canonicalJson(content)}\n`);
}
async function host() {
  return collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
}
async function begin(engine, input, saved, leg) {
  const parent =
    saved === null
      ? null
      : {
          snapshot: saved.document.snapshot,
          execution: saved.document.state.identity.executionId,
        };
  const reply = await engine.handle({
    kind: "begin",
    bundle,
    cells: [cellDocument],
    identity: {
      runId: input.id,
      executionId: `execution-${leg}`,
      hostSession: `host-${leg}`,
      parent,
    },
    origin:
      saved === null
        ? { kind: "scenario", scenario: input }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
  });
  assert.equal(reply.kind, "began", JSON.stringify(reply));
}
async function driveTo(engine, seconds) {
  for (let turn = 0; turn < 20_000; turn += 1) {
    const reply = await engine.handle({
      kind: "drive",
      turns: 128,
      until: seconds * 1_000_000,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (
      reply.view.time >= seconds * 1_000_000 ||
      reply.view.status.kind === "completed"
    ) {
      const state = await engine.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      return state.run;
    }
    if (reply.view.status.kind === "blocked") {
      const state = await engine.handle({ kind: "state" });
      save("blocked.json", state);
    }
    assert.notEqual(
      reply.view.status.kind,
      "blocked",
      JSON.stringify(reply.view),
    );
  }
  throw new Error("Batch journey exceeded its turn bound");
}
function byId(id, item) {
  return item.id === id;
}
function task(run, id) {
  const found = run.tasks.find(byId.bind(null, id));
  assert.ok(found, id);
  return found;
}
function batch(run) {
  return run.resources.find(byId.bind(null, "oven")).batch;
}
function history(run) {
  const result = [];
  for (const {
    sequence: _sequence,
    execution: _execution,
    ...event
  } of run.events)
    if (event.kind !== "command-admitted") result.push(event);
  return result;
}
function world(run) {
  const {
    identity: _identity,
    commands: _commands,
    events: _events,
    position,
    ...state
  } = run;
  return { ...state, time: position.time };
}
function oven(loadWindow) {
  return {
    kind: "batch",
    id: "oven",
    capacity: 2,
    configuration: null,
    storage: "oven",
    loadWindow: loadWindow * 1_000_000,
    programs: [
      { id: "standard", duration: 20_000_000, evidence: "model" },
      { id: "gentle", duration: 10_000_000, evidence: "model" },
    ],
  };
}
function step(key, prerequisites, duration, carriers) {
  return {
    key,
    priority: 0,
    releaseAfter: 0,
    prerequisites,
    claims: [],
    executor: {
      kind: "declared",
      duration: duration * 1_000_000,
      evidence: "model",
    },
    inputs: [],
    outputs: [],
    releases: [],
    carriers,
  };
}
function move(from, to, placement) {
  return {
    kind: "move",
    role: "tray",
    from,
    to,
    timing: {
      kind: "declared",
      pickupAfter: 1_000_000,
      placementAfter: placement * 1_000_000,
    },
  };
}
function workflow(id, program, loading) {
  return {
    id,
    revision: base.workflows[0].revision,
    demand: "order",
    tasks: [
      step("load", [], loading, [
        { kind: "acquire", role: "tray", from: "tray-store" },
        move("tray-store", "oven", loading - 1),
      ]),
      {
        ...step("bake", ["load"], 0, []),
        executor: {
          kind: "batch",
          resource: "oven",
          program,
          carrier: "tray",
          load: "load",
          unload: "unload",
        },
      },
      step("unload", ["bake"], 4, [move("oven", "cooling", 3)]),
      step("clear", ["unload"], 4, [
        move("cooling", "tray-store", 3),
        { kind: "release", role: "tray" },
      ]),
    ],
  };
}
function arrival(id, workflow, seconds) {
  return {
    kind: "explicit",
    id,
    workflow,
    arrivals: [{ time: seconds * 1_000_000, quantity: 1 }],
  };
}
function controlledScenario() {
  const input = structuredClone(base);
  input.id = "shared-oven-boundaries";
  input.resources = [oven(10)];
  input.storages[0].capacity.slots = 3;
  input.storages.push(
    { id: "oven", capacity: { kind: "carriers", slots: 2 }, cell: null },
    { id: "cooling", capacity: { kind: "carriers", slots: 1 }, cell: null },
    { id: "parking", capacity: { kind: "carriers", slots: 1 }, cell: null },
  );
  input.carriers.push(
    { id: "tray-c", storage: "tray-store" },
    { id: "blocker", storage: "cooling" },
  );
  input.workflows = [
    workflow("standard", "standard", 5),
    workflow("slow-load", "standard", 15),
    workflow("gentle", "gentle", 5),
    {
      id: "maintenance",
      revision: base.workflows[0].revision,
      demand: "production",
      tasks: [
        step("clear", [], 5, [
          { kind: "acquire", role: "tray", from: "cooling" },
          move("cooling", "parking", 4),
          { kind: "release", role: "tray" },
        ]),
      ],
    },
  ];
  input.arrivals = [
    arrival("first", "standard", 0),
    arrival("incompatible", "gentle", 6),
    arrival("second", "slow-load", 8),
    arrival("late", "standard", 10),
    arrival("maintenance", "maintenance", 70),
  ];
  input.availability = [
    {
      id: "oven-outage",
      resource: "oven",
      interval: { start: 20_000_000, end: 27_000_000 },
    },
  ];
  return input;
}
function assertNoClaims(run, id) {
  for (const resource of run.resources)
    for (const allocation of resource.allocations)
      assert.notEqual(allocation.task, id);
  for (const storage of run.storages)
    for (const reservation of storage.reservations)
      assert.notEqual(reservation.task, id);
}
async function rejectEdited(document, name) {
  const { snapshot: _snapshot, ...content } = document;
  document.snapshot = await sha256Hex(canonicalJson(content));
  const result = await E.openResumable(document, "browser", [bundle]);
  assert.deepEqual(
    result,
    { ok: false, error: { code: "invalid_document" } },
    name,
  );
  save(`${name}-refused.json`, { document, result });
}
async function replace(engine, input, leg, name) {
  const paused = await engine.handle({
    kind: "pause",
    commandId: `pause-${leg}`,
  });
  assert.equal(paused.receipt.status, "accepted", JSON.stringify(paused));
  const saved = await engine.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  save(`${name}-save.json`, saved);
  assert.equal(
    (await E.openResumable(saved.document, "browser", [bundle])).ok,
    true,
  );
  const edited = structuredClone(saved.document);
  batch(edited.state).members.pop();
  await rejectEdited(edited, `${name}-member`);
  const shortened = structuredClone(saved.document);
  const cycle = batch(shortened.state);
  if (cycle.kind === "loading") cycle.closeAt -= 2000;
  if (cycle.kind === "running") cycle.completesAt -= 2000;
  if (cycle.kind === "unloading") cycle.completedAt -= 2000;
  await rejectEdited(shortened, `${name}-clock`);
  if (cycle.kind === "running") {
    const missing = structuredClone(saved.document);
    missing.state.scheduled = missing.state.scheduled.filter(
      otherTask.bind(null, cycle.members[0].task),
    );
    await rejectEdited(missing, `${name}-missing-completion`);
  }
  await engine.handle({ kind: "dispose" });
  const next = await host();
  await begin(next, input, saved, leg + 1);
  return next;
}
async function controlled(interrupt) {
  const input = controlledScenario();
  let engine = await host();
  await begin(engine, input, null, 1);
  let leg = 1;
  for (const seconds of [6, 12, 35, 50, 73, 77]) {
    const state = await driveTo(engine, seconds);
    save(
      `controlled-${interrupt ? "continued" : "reference"}-${seconds}.json`,
      state,
    );
    if (seconds === 6) {
      assert.equal(batch(state).kind, "loading");
      assert.deepEqual(task(state, "incompatible#0/load").blockers, [
        { kind: "batch-cycle", resource: "oven", reason: "program" },
      ]);
    }
    if (seconds === 12) {
      assert.equal(batch(state).kind, "loading");
      assert.equal(batch(state).members.length, 2);
      assert.equal(task(state, "second#0/load").kind, "executing");
      assert.equal(task(state, "late#0/load").kind, "waiting");
      assertNoClaims(state, "late#0/load");
    }
    if (seconds === 35) {
      assert.equal(batch(state).kind, "running");
      assert.equal(task(state, "first#0/bake").startedAt, 27_000_000);
      assert.equal(task(state, "second#0/bake").completesAt, 47_000_000);
    }
    if (seconds >= 50) {
      assert.equal(batch(state).kind, "unloading");
      assert.equal(task(state, "incompatible#0/load").kind, "waiting");
      assertNoClaims(state, "incompatible#0/load");
    }
    if (seconds === 77)
      assert.equal(
        state.storages.find(byId.bind(null, "oven")).occupants.length,
        0,
      );
    if (interrupt)
      engine = await replace(engine, input, leg++, `controlled-${seconds}`);
  }
  const run = await driveTo(engine, 300);
  assert.equal(run.status.kind, "completed");
  assert.equal(run.position.time, 132_000_000);
  const starts = [];
  for (const event of run.events)
    if (event.kind === "batch-started")
      starts.push([event.time, event.program, event.completesAt]);
  assert.deepEqual(starts, [
    [27_000_000, "standard", 47_000_000],
    [85_000_000, "gentle", 95_000_000],
    [104_000_000, "standard", 124_000_000],
  ]);
  assert.equal(task(run, "incompatible#0/load").startedAt, 80_000_000);
  await engine.handle({ kind: "dispose" });
  return run;
}

function nativeScenario() {
  const input = structuredClone(base);
  input.id = "native-transfer-shared-oven";
  input.resources.push(oven(200));
  input.storages.push({
    id: "oven",
    capacity: { kind: "carriers", slots: 2 },
    cell: null,
  });
  const [load, transfer, unload] = input.workflows[0].tasks;
  const ovenLoad = structuredClone(unload);
  ovenLoad.key = "oven-load";
  ovenLoad.inputs = [];
  ovenLoad.outputs = [];
  ovenLoad.carriers = [{ ...ovenLoad.carriers[0], to: "oven" }];
  const bake = {
    ...step("bake", ["oven-load"], 0, []),
    executor: {
      kind: "batch",
      resource: "oven",
      program: "standard",
      carrier: "tray",
      load: "oven-load",
      unload: "unload",
    },
  };
  unload.prerequisites = ["bake"];
  unload.carriers[0].from = "oven";
  unload.carriers[0].to = "tray-store";
  input.workflows[0].tasks = [load, transfer, ovenLoad, bake, unload];
  return input;
}

async function nativeJourney(input, restoreAt) {
  let engine = await host();
  await begin(engine, input, null, 1);
  if (restoreAt !== null) {
    const running = await driveTo(engine, restoreAt);
    assert.equal(batch(running).kind, "running");
    assert.equal(batch(running).members.length, 2);
    engine = await replace(engine, input, 1, "native-running");
  }
  const state = await driveTo(engine, 600);
  assert.equal(state.status.kind, "completed");
  assert.equal(batch(state).sequence, 2);
  assert.equal(batch(state).kind, "idle");
  const cohorts = new Map();
  let nativeCompletions = 0;
  for (const event of state.events) {
    if (event.kind === "batch-admitted")
      cohorts.set(event.cycle, (cohorts.get(event.cycle) ?? 0) + 1);
    if (event.kind === "task-completed" && event.attempt !== null)
      nativeCompletions += 1;
  }
  assert.deepEqual([...cohorts.values()], [2, 1]);
  assert.equal(nativeCompletions, 3);
  for (const carrier of state.carriers) {
    assert.equal(carrier.bound, null);
    assert.deepEqual(carrier.custody, {
      kind: "stored",
      storage: "tray-store",
    });
  }
  await engine.handle({ kind: "dispose" });
  return state;
}

async function checkInvalidScenarios() {
  const wrongStorage = controlledScenario();
  wrongStorage.storages.find(byId.bind(null, "oven")).capacity.slots = 3;
  const invalidCapacity = await E.admitScenario(wrongStorage);
  assert.equal(invalidCapacity.ok, false);
  const bypass = controlledScenario();
  bypass.workflows[0].tasks[1].executor = {
    kind: "declared",
    duration: 20_000_000,
    evidence: "model",
  };
  const invalidRoute = await E.admitScenario(bypass);
  assert.equal(invalidRoute.ok, false);
  save("scenario-refusals.json", { invalidCapacity, invalidRoute });
}

await checkInvalidScenarios();
save("controlled-scenario.json", controlledScenario());
const reference = await controlled(false);
const continued = await controlled(true);
assert.deepEqual(history(continued), history(reference));
assert.deepEqual(world(continued), world(reference));
const scheduling = E.schedulingHistory(reference, {
  after: null,
  through: reference.position.time,
});
assert.deepEqual(
  E.schedulingHistory(continued, {
    after: null,
    through: continued.position.time,
  }),
  scheduling,
);
const outageStates = E.schedulingHistory(reference, {
  after: 20_000_000,
  through: 27_000_000,
});
assert.equal(outageStates.resources[0].unitSeconds.unavailable, 14);
const blockedUnloading = E.schedulingHistory(reference, {
  after: 47_000_000,
  through: 70_000_000,
});
assert.equal(blockedUnloading.resources[0].unitSeconds.unloading, 46);
assert.ok(blockedUnloading.waits.some(waitsForCooling));
const partialCycle = E.schedulingHistory(reference, {
  after: 85_000_000,
  through: 95_000_000,
});
assert.equal(partialCycle.resources[0].unitSeconds.running, 10);
assert.equal(partialCycle.resources[0].unitSeconds.unavailable, 10);
assert.equal(partialCycle.resources[0].unitSeconds.idle, 0);
save("scheduling-history.json", {
  scheduling,
  outageStates,
  blockedUnloading,
  partialCycle,
});
save("controlled-reference.json", reference);
save("controlled-continued.json", continued);
const nativeInput = nativeScenario();
save("native-scenario.json", nativeInput);
const nativeReference = await nativeJourney(nativeInput, null);
const firstCycle = nativeReference.events.find(isBatchStart);
assert.ok(firstCycle);
const restoredAt = firstCycle.time / 1_000_000 + 5;
const nativeContinued = await nativeJourney(nativeInput, restoredAt);
assert.deepEqual(history(nativeContinued), history(nativeReference));
assert.deepEqual(world(nativeContinued), world(nativeReference));
save("native-reference.json", nativeReference);
save("native-continued.json", nativeContinued);
save("report.json", {
  result: "passed",
  bundle: bundle.id,
  simulatedSeconds: reference.position.time / 1_000_000,
  restoredAt: [6, 12, 35, 50, 73, 77],
  sharedCompletion: true,
  slowLoading: true,
  halfOpenAdmission: true,
  distinctPrograms: true,
  outage: true,
  blockedRetrieval: true,
  earlyTail: true,
  sameHistoryStateAndCheckpoints: true,
  capacityCategories: {
    outageDuringLoading: true,
    blockedUnloading: true,
    unusedBatchSlots: true,
    restored: true,
  },
  native: {
    transfers: 3,
    cohorts: [2, 1],
    restoredAt,
    simulatedSeconds: nativeReference.position.time / 1_000_000,
    sameHistoryStateAndCheckpoints: true,
  },
});
console.log(`Shared batch journey passed: ${output}`);

function isBatchStart(event) {
  return event.kind === "batch-started";
}

function waitsForCooling(wait) {
  return wait.blockers.some(coolingBlocker);
}
function coolingBlocker(blocker) {
  return blocker.kind === "destination" && blocker.storage === "cooling";
}

function otherTask(id, event) {
  return event.task !== id;
}
