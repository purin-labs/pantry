import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Two real MuJoCo cells, one baker, two reusable trays and four orders.
// Save with both arms running, destroy the host, restore, and drain the same run.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import { assertSharedBarrier } from "./shared-barrier.mjs";
import { twoCellScenarios } from "./two-cell-scenario.mjs";

assert.equal(process.argv.length, 3, "Provide an artifact directory");
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
const cells = [
  await prepareCell(runtime, "cold-cell-1"),
  await prepareCell(runtime, "cold-cell-2"),
];
const firstCell = value(E.parseNativeCell(cells[0]));
const secondCell = value(E.parseNativeCell(cells[1]));
function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
function save(name, content) {
  writeFileSync(join(output, name), `${canonicalJson(content)}\n`);
}

const { base, scenario } = await twoCellScenarios(firstCell, secondCell);
save("scenario.json", scenario);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};
async function host() {
  return collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
}
function identity(leg, parent) {
  return {
    runId: "two-cell-journey",
    executionId: `execution-${leg}`,
    hostSession: `host-${leg}`,
    parent,
  };
}
async function begin(engine, leg, saved, input = scenario) {
  const reply = await engine.handle({
    kind: "begin",
    bundle,
    cells,
    identity: identity(
      leg,
      saved === null
        ? null
        : {
            snapshot: saved.document.snapshot,
            execution: saved.document.state.identity.executionId,
          },
    ),
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
function history(events) {
  const result = [];
  for (const { sequence: _sequence, execution: _execution, ...event } of events)
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
async function run(interrupt) {
  let engine = await host();
  await begin(engine, 1, null);
  let continued = false;
  let simultaneous = false;
  let blockedTransfer = false;
  let carrierQueue = false;
  let partialTickRefused = false;
  let ticks = 0;
  let pauseAttempts = 0;
  const started = performance.now();
  for (;;) {
    const reply = await engine.handle({
      kind: "drive",
      turns: partialTickRefused ? 128 : 1,
      until: 600_000_000,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    assertSharedBarrier(reply.view);
    if (!partialTickRefused) {
      for (const cell of reply.view.cells) {
        if (cell.boundary <= reply.view.time) continue;
        const pause = await engine.handle({
          kind: "pause",
          commandId: "partial-tick",
        });
        assert.equal(pause.kind, "commanded");
        assert.equal(pause.receipt.status, "rejected");
        assert.equal(pause.receipt.reason, "boundary_unsettled");
        partialTickRefused = true;
        break;
      }
    }
    ticks += 1;
    const state = await engine.handle({ kind: "state" });
    assert.equal(state.kind, "state");
    const running = [];
    for (const cell of reply.view.cells)
      if (cell.attempt?.lifecycle === "running") running.push(cell);
    if (running.length === 2) simultaneous = true;
    // Each change of the waiting tasks is in the history, whatever the drive
    // returns saw: a cell computes many steps in one call.
    for (const event of state.run.events) {
      if (event.kind !== "waiting-changed") continue;
      for (const wait of event.waiting)
        for (const blocker of wait.blockers) {
          if (wait.task.endsWith("/handoff") && blocker.kind === "cell-slot")
            blockedTransfer = true;
          if (blocker.kind === "carrier") carrierQueue = true;
        }
    }
    if (interrupt && !continued && running.length === 2) {
      const paused = await engine.handle({
        kind: "pause",
        commandId: `pause-${pauseAttempts++}`,
      });
      assert.equal(paused.kind, "commanded");
      if (paused.receipt.status === "rejected") {
        assert.equal(paused.receipt.reason, "boundary_unsettled");
        continue;
      }
      const saved = await engine.handle({ kind: "save" });
      assert.equal(saved.kind, "saved", JSON.stringify(saved));
      save("snapshot.json", saved.document);
      mkdirSync(join(output, "artifacts"), { recursive: true });
      for (const artifact of saved.artifacts)
        writeFileSync(
          join(output, "artifacts", artifact.digest),
          artifact.content,
        );
      await engine.handle({ kind: "dispose" });
      engine = await host();
      await begin(engine, 2, saved);
      // A fresh execution continues at the saved boundary without a resume
      // command addressed to the destroyed execution.
      continued = true;
    }
    if (reply.view.status.kind === "completed") {
      assert.ok(simultaneous, "the two real arms overlapped");
      assert.ok(
        blockedTransfer,
        "an occupied downstream cell blocked a handoff",
      );
      assert.ok(carrierQueue, "finite trays queued incoming orders");
      assert.ok(partialTickRefused, "pause cannot save a partly advanced tick");
      assert.equal(continued, interrupt);
      assert.equal(state.run.instances.length, 4);
      for (const carrier of state.run.carriers)
        assert.deepEqual(carrier.custody, {
          kind: "stored",
          storage: "tray-store",
        });
      await engine.handle({ kind: "dispose" });
      return {
        run: state.run,
        milliseconds: performance.now() - started,
        ticks,
        simultaneous,
        blockedTransfer,
        carrierQueue,
        continued,
      };
    }
    assert.equal(
      reply.view.status.kind,
      "awaiting-execution",
      JSON.stringify(reply.view),
    );
    assert.ok(ticks < 20_000, "journey remains bounded");
  }
}
const reference = await run(false);
const interrupted = await run(true);
assert.deepEqual(
  history(interrupted.run.events),
  history(reference.run.events),
);
assert.deepEqual(world(interrupted.run), world(reference.run));
const coincident = await runCoincident(false);
const reordered = await runCoincident(true);
assert.deepEqual(history(coincident.events), history(reordered.events));
const releaseReference = await runReleaseTimes(false);
const releaseContinued = await runReleaseTimes(true);
assert.deepEqual(
  history(releaseContinued.events),
  history(releaseReference.events),
);
assert.deepEqual(world(releaseContinued), world(releaseReference));
save("release-reference.json", releaseReference);
save("release-continued.json", releaseContinued);
const workerReference = await runWorkerTravel(false);
const workerContinued = await runWorkerTravel(true);
assert.deepEqual(
  history(workerContinued.events),
  history(workerReference.events),
);
assert.deepEqual(world(workerContinued), world(workerReference));
save("worker-reference.json", workerReference);
save("worker-continued.json", workerContinued);
save("coincident.json", coincident);
save("reference.json", reference.run);
save("continued.json", interrupted.run);
save("report.json", {
  result: "passed",
  bundle: bundle.id,
  simulatedSeconds: reference.run.position.time / 1_000_000,
  referenceMilliseconds: reference.milliseconds,
  continuedMilliseconds: interrupted.milliseconds,
  simultaneousArms: true,
  blockedHandoff: true,
  queuedOrders: true,
  reusedCarriers: 2,
  completedOrders: 4,
  sameHistory: true,
  sameState: true,
  sameCheckpoints: true,
  coincidentBoundaries: true,
  independentOfCellEnumeration: true,
  workers: {
    firstAvailableInDeclaredOrder: true,
    pinnedWorkerWaits: true,
    travelFromPreviousEndpoint: true,
    pickupDelayedByTravel: true,
    blockedDestinationClaimsNoWorker: true,
    outageBlocksNewWork: true,
    restoredDuringTravel: [5, 24],
    sameHistoryAndCheckpoints: true,
    simulatedSeconds: workerReference.position.time / 1_000_000,
  },
  releaseTimes: {
    relativeToArrival: true,
    noEarlyReservations: true,
    noEarlyChangeover: true,
    sameTickOutageRespected: true,
    restoredBeforeRelease: [29, 49],
    sameHistoryAndCheckpoints: true,
  },
});
console.log(
  `Two-cell journey passed: ${reference.run.position.time / 1_000_000}s, ${reference.run.events.length} events; ${output}`,
);

async function runCoincident(reverseCells) {
  const input = structuredClone(base);
  input.resources[0].capacity = 2;
  input.resources.push({
    kind: "capacity",
    id: "finishing-arm",
    capacity: 1,
    configuration: null,
  });
  input.cells = structuredClone(scenario.cells);
  if (reverseCells) input.cells.reverse();
  input.storages.push(...structuredClone(scenario.storages.slice(-2)));
  input.arrivals[0].arrivals[0].quantity = 1;
  const second = structuredClone(input.workflows[0]);
  second.id = "second-flow";
  second.tasks[0].carriers[1].to = "second-table";
  second.tasks[1].claims[0].resource = "finishing-arm";
  second.tasks[1].executor.operation.cell = secondCell.cellId;
  second.tasks[1].executor.operation.parameters = secondCell.modelHash;
  second.tasks[1].carriers[0].from = "second-table";
  second.tasks[1].carriers[0].to = "second-rack";
  second.tasks[2].carriers[0].from = "second-rack";
  input.workflows.push(second);
  input.arrivals.push({
    kind: "explicit",
    id: "second-orders",
    workflow: second.id,
    arrivals: [{ time: 0, quantity: 1 }],
  });
  const engine = await host();
  await begin(engine, 1, null, input);
  let preparations = false;
  for (let turn = 0; turn < 10_000; turn += 1) {
    const reply = await engine.handle({
      kind: "drive",
      turns: preparations ? 128 : 1,
      until: 600_000_000,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    assertSharedBarrier(reply.view);
    const state = await engine.handle({ kind: "state" });
    for (const cell of state.run.cells) {
      if (cell.prepared.length === 0) continue;
      const pause = await engine.handle({
        kind: "pause",
        commandId: "during-preparation",
      });
      assert.equal(pause.receipt.reason, "boundary_unsettled");
      preparations = true;
    }
    if (reply.view.status.kind !== "completed") continue;
    assert.ok(
      preparations,
      "coincident admissions prepared both cells before committing",
    );
    const admissions = [];
    for (const event of state.run.events)
      if (event.kind === "cell-committed" && event.time === 12_000_000)
        admissions.push(event);
    assert.equal(admissions.length, 2);
    await engine.handle({ kind: "dispose" });
    return state.run;
  }
  throw new Error("Coincident journey did not drain");
}

function releaseScenario() {
  const input = structuredClone(base);
  input.id = "plan-70-task-release";
  input.limits.horizon = 350_000_000;
  input.arrivals[0].arrivals = [
    { time: 10_000_000, quantity: 1 },
    { time: 200_000_000, quantity: 1 },
  ];
  input.workflows[0].tasks[0].releaseAfter = 20_000_000;
  input.workflows[0].tasks[1].releaseAfter = 40_000_000;
  input.availability = [
    {
      id: "baker-break",
      resource: "baker",
      interval: { start: 30_000_000, end: 34_000_000 },
    },
  ];
  input.resources.push({
    kind: "capacity",
    id: "oven",
    capacity: 1,
    configuration: {
      initial: "warm",
      changeovers: [
        {
          from: "warm",
          to: "hot",
          duration: 5_000_000,
          evidence: "assumed",
          claims: [{ resource: "baker", units: 1, configuration: null }],
        },
      ],
    },
  });
  input.workflows.push({
    id: "oven-work",
    revision: base.workflows[0].revision,
    demand: "production",
    tasks: [
      ovenTask("warm-job", 0, "warm", 50_000_000),
      ovenTask("hot-job", 55_000_000, "hot", 4_000_000),
    ],
  });
  input.arrivals.push({
    id: "oven-orders",
    workflow: "oven-work",
    kind: "explicit",
    arrivals: [{ time: 0, quantity: 1 }],
  });
  return input;
}

function ovenTask(key, releaseAfter, configuration, duration) {
  return {
    key,
    priority: 0,
    releaseAfter,
    prerequisites: [],
    claims: [{ resource: "oven", units: 1, configuration }],
    executor: { kind: "declared", duration, evidence: "assumed" },
    inputs: [],
    outputs: [],
    releases: [],
    carriers: [],
  };
}

async function driveTo(engine, seconds) {
  const until = seconds * 1_000_000;
  for (let turn = 0; turn < 20_000; turn += 1) {
    const reply = await engine.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    assertSharedBarrier(reply.view);
    if (reply.view.time < until && reply.view.status.kind !== "completed")
      continue;
    const state = await engine.handle({ kind: "state" });
    assert.equal(state.kind, "state");
    return state.run;
  }
  throw new Error(`Release journey did not reach ${seconds}s`);
}

function taskState(run, id) {
  const task = run.tasks.find(hasId.bind(null, id));
  assert.ok(task, `Missing task ${id}`);
  return task;
}

function hasId(id, record) {
  return record.id === id;
}

function assertReleasedAt(run, id, seconds) {
  const task = taskState(run, id);
  assert.equal(task.kind, "completed");
  assert.equal(task.startedAt, seconds * 1_000_000, id);
}

function assertUnreserved(run, id) {
  for (const resource of run.resources)
    for (const allocation of resource.allocations)
      assert.notEqual(
        allocation.task,
        id,
        "unreleased task reserves no resource",
      );
  for (const storage of run.storages)
    for (const reservation of storage.reservations)
      assert.notEqual(
        reservation.task,
        id,
        "unreleased task reserves no destination",
      );
  for (const lot of run.lots)
    for (const claim of lot.claims)
      assert.notEqual(claim.task, id, "unreleased task claims no material");
}

async function replaceBeforeRelease(engine, seconds, leg) {
  const paused = await engine.handle({
    kind: "pause",
    commandId: `release-pause-${leg}`,
  });
  assert.equal(paused.kind, "commanded");
  assert.equal(paused.receipt.status, "accepted");
  const saved = await engine.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  save(`release-save-${seconds}.json`, saved);

  // A saved release diagnostic cannot change the task's authored constraint.
  const edited = structuredClone(saved.document);
  const key = seconds === 29 ? "load" : "transfer";
  const waiting = taskState(edited.state, `tray-orders#0/${key}`);
  for (const blocker of waiting.blockers)
    if (blocker.kind === "release") blocker.at += 2000;
  await refuseEditedSave(edited, "release-blocker");

  await engine.handle({ kind: "dispose" });
  const fresh = await host();
  await begin(fresh, leg + 1, saved);
  return fresh;
}

async function runReleaseTimes(interrupt) {
  const input = releaseScenario();
  if (!interrupt) save("release-scenario.json", input);
  let engine = await host();
  await begin(engine, 1, null, input);
  let state = await driveTo(engine, 29);
  assert.deepEqual(taskState(state, "tray-orders#0/load").blockers, [
    { kind: "release", at: 30_000_000 },
  ]);
  assertUnreserved(state, "tray-orders#0/load");
  for (const carrier of state.carriers) assert.equal(carrier.bound, null);
  if (interrupt) engine = await replaceBeforeRelease(engine, 29, 1);

  state = await driveTo(engine, 30);
  assert.deepEqual(taskState(state, "tray-orders#0/load").blockers, [
    { kind: "resource", resource: "baker", reason: "unavailable" },
  ]);
  assertUnreserved(state, "tray-orders#0/load");

  state = await driveTo(engine, 49);
  assert.deepEqual(taskState(state, "tray-orders#0/transfer").blockers, [
    { kind: "release", at: 50_000_000 },
  ]);
  assertUnreserved(state, "tray-orders#0/transfer");
  assert.equal(state.cells[0].attempt, null);
  assert.equal(
    state.cells[0].slot.kind,
    "active",
    "the tray stays in its cell while waiting",
  );
  if (interrupt) engine = await replaceBeforeRelease(engine, 49, 2);

  state = await driveTo(engine, 54);
  assert.equal(
    taskState(state, "tray-orders#0/transfer").startedAt,
    50_000_000,
  );
  const oven = state.resources.find(hasId.bind(null, "oven"));
  assert.equal(
    oven.changeovers,
    0,
    "a future release cannot start a changeover",
  );
  assertUnreserved(state, "oven-orders#0/hot-job");

  state = await driveTo(engine, 350);
  assert.equal(state.status.kind, "completed");
  assertReleasedAt(state, "tray-orders#0/load", 34);
  assertReleasedAt(state, "tray-orders#0/transfer", 50);
  assertReleasedAt(state, "tray-orders#1/load", 220);
  assertReleasedAt(state, "tray-orders#1/transfer", 240);
  assertReleasedAt(state, "oven~1", 55);
  assertReleasedAt(state, "oven-orders#0/hot-job", 60);
  await engine.handle({ kind: "dispose" });
  return state;
}

function workerDefinition(id, initialLocation) {
  const seconds = {
    "home-far": { store: 12, "cell-one": 14, "cell-two": 18, pack: 10 },
    "home-near": { store: 2, "cell-one": 4, "cell-two": 8, pack: 1 },
    store: { "cell-one": 4, "cell-two": 10, pack: 7 },
    "cell-one": { store: 4, "cell-two": 6, pack: 5 },
    "cell-two": { store: 10, "cell-one": 6, pack: 3 },
    pack: { store: 7, "cell-one": 5, "cell-two": 3 },
  };
  const travel = [];
  for (const [from, destinations] of Object.entries(seconds))
    for (const [to, duration] of Object.entries(destinations))
      travel.push({
        from,
        to,
        duration: duration * 1_000_000,
        evidence: "model",
      });
  return {
    kind: "worker",
    id,
    capacity: 1,
    configuration: null,
    initialLocation,
    travel,
  };
}

function attendedTask(key, workers, releaseAfter, start, finish, seconds) {
  return {
    key,
    priority: -2,
    releaseAfter: releaseAfter * 1_000_000,
    prerequisites: [],
    claims: [],
    executor: {
      kind: "attended",
      workers,
      start,
      finish,
      duration: seconds * 1_000_000,
      evidence: "model",
    },
    inputs: [],
    outputs: [],
    releases: [],
    carriers: [],
  };
}

function workerScenario() {
  const input = structuredClone(scenario);
  input.id = "plan-70-worker-travel";
  input.resources[0] = workerDefinition("worker-a", "home-far");
  input.resources.push(workerDefinition("worker-b", "home-near"));
  input.availability = [
    {
      id: "worker-break",
      resource: "worker-b",
      interval: { start: 16_000_000, end: 35_000_000 },
    },
  ];
  const locations = {
    "tray-store": "store",
    "source-table": "cell-one",
    rack: "cell-one",
    "second-table": "cell-two",
    "second-rack": "cell-two",
  };
  for (const task of input.workflows[0].tasks) {
    if (task.executor.kind !== "declared" || task.claims.length === 0) continue;
    const move = task.carriers.find(isMove);
    assert.ok(move);
    assert.ok(locations[move.from] && locations[move.to]);
    task.claims = [];
    task.executor = {
      kind: "attended",
      duration: task.executor.duration,
      evidence: task.executor.evidence,
      workers: ["worker-a", "worker-b"],
      start: locations[move.from],
      finish: locations[move.to],
    };
  }
  input.workflows.push({
    id: "shared-workers",
    revision: base.workflows[0].revision,
    demand: "production",
    tasks: [
      attendedTask(
        "choose-first",
        ["worker-a", "worker-b"],
        0,
        "pack",
        "pack",
        8,
      ),
      attendedTask("pinned-a", ["worker-a"], 1, "store", "store", 5),
      attendedTask("pinned-b", ["worker-b"], 16, "store", "pack", 1),
    ],
  });
  input.arrivals.push({
    kind: "explicit",
    id: "worker-jobs",
    workflow: "shared-workers",
    arrivals: [{ time: 0, quantity: 1 }],
  });
  return input;
}

function isMove(step) {
  return step.kind === "move";
}

function assignedWorker(run, id) {
  const worker = run.resources.find(hasId.bind(null, id));
  assert.equal(worker.position.kind, "assigned");
  return worker.position;
}

async function replaceDuringTravel(engine, seconds, leg) {
  const paused = await engine.handle({
    kind: "pause",
    commandId: `worker-pause-${leg}`,
  });
  assert.equal(paused.receipt.status, "accepted", JSON.stringify(paused));
  const saved = await engine.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  save(`worker-save-${seconds}.json`, saved);
  assert.equal(
    (await E.openResumable(saved.document, "browser", [bundle])).ok,
    true,
  );

  const moved = structuredClone(saved.document);
  assignedWorker(moved.state, "worker-a").from = "home-near";
  await refuseEditedSave(moved, `worker-origin-${seconds}`);
  const shortened = structuredClone(saved.document);
  assignedWorker(shortened.state, "worker-a").arrivesAt -= 2000;
  await refuseEditedSave(shortened, `worker-arrival-${seconds}`);
  if (seconds === 5) {
    const earlyPickup = structuredClone(saved.document);
    for (const pending of earlyPickup.state.scheduled)
      if (
        pending.task === "tray-orders#0/load" &&
        pending.order.boundary === "pickup"
      )
        pending.order.time -= 2000;
    await refuseEditedSave(earlyPickup, "worker-early-pickup");
  }
  await engine.handle({ kind: "dispose" });
  const fresh = await host();
  await begin(fresh, leg + 1, saved);
  return fresh;
}

async function runWorkerTravel(interrupt) {
  const input = workerScenario();
  if (!interrupt) {
    save("worker-scenario.json", input);
    const missingRoute = structuredClone(input);
    missingRoute.resources[0].travel = [];
    const refused = await E.admitScenario(missingRoute);
    assert.equal(refused.ok, false);
    assert.ok(refused.error.some(isMissingWorkerRoute));
    save("worker-missing-route-refusal.json", refused);
  }
  let engine = await host();
  await begin(engine, 1, null, input);
  let state = await driveTo(engine, 5);
  assert.equal(
    assignedWorker(state, "worker-a").task,
    "worker-jobs#0/choose-first",
  );
  assert.equal(assignedWorker(state, "worker-a").arrivesAt, 10_000_000);
  assert.equal(assignedWorker(state, "worker-b").task, "tray-orders#0/load");
  assert.equal(assignedWorker(state, "worker-b").arrivesAt, 2_000_000);
  assert.deepEqual(taskState(state, "worker-jobs#0/pinned-a").blockers, [
    { kind: "workers", workers: ["worker-a"] },
  ]);
  for (const carrier of state.carriers)
    assert.equal(carrier.custody.kind, "stored");
  assert.equal(taskState(state, "tray-orders#1/load").kind, "waiting");
  assertUnreserved(state, "tray-orders#1/load");
  if (interrupt) engine = await replaceDuringTravel(engine, 5, 1);

  state = await driveTo(engine, 24);
  const walk = assignedWorker(state, "worker-a");
  assert.equal(walk.task, "worker-jobs#0/pinned-a");
  assert.equal(walk.from, "pack");
  assert.equal(walk.arrivesAt, 25_000_000);
  assert.equal(walk.completesAt, 30_000_000);
  assert.deepEqual(taskState(state, "worker-jobs#0/pinned-b").blockers, [
    { kind: "workers", workers: ["worker-b"] },
  ]);
  assertUnreserved(state, "worker-jobs#0/pinned-b");
  if (interrupt) engine = await replaceDuringTravel(engine, 24, 2);

  state = await driveTo(engine, 600);
  assert.equal(state.status.kind, "completed");
  assertReleasedAt(state, "worker-jobs#0/pinned-a", 18);
  assertReleasedAt(state, "worker-jobs#0/pinned-b", 35);
  for (const event of state.events)
    if (
      event.kind === "carrier-picked-up" &&
      event.task === "tray-orders#0/load"
    )
      assert.equal(event.time, 6_000_000);
  for (const resource of state.resources)
    if (resource.id === "worker-a" || resource.id === "worker-b")
      assert.equal(resource.position.kind, "idle");
  await engine.handle({ kind: "dispose" });
  return state;
}

function isMissingWorkerRoute(problem) {
  return (
    problem.code === "invalid_worker_route" && problem.reason === "missing"
  );
}

async function refuseEditedSave(document, name) {
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
