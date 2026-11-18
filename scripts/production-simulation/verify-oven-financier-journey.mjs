import {
  beginRequest,
  evidenceWriter,
  executionHost,
  sameId,
  textCodec,
  value,
} from "./execution-journey.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Authored full recipe through one persistent oven cell, cooling congestion,
// fresh-host continuation, and failed loading with material rejection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import { parsePersistentCell } from "../../packages/bakery-model/src/bakery-physics.ts";
import {
  parseProductionScenario,
  productionDefinitionFingerprint,
} from "../../packages/bakery-model/src/bakery-production-scenario.ts";
import {
  parseSettings,
  sampleSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import {
  compileOvenFinancier,
  compileSavedOvenFinancier,
} from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import { resolveAuthoredFinancierRun } from "../../packages/production-simulation/src/recipes/bakery/schedule.ts";
import { parseHostView } from "../../packages/production-simulation/src/execution-view.ts";
import {
  readPhysicsView,
  readCellPhysicsViews,
} from "../../packages/production-simulation/src/physics-view.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  OVEN_CELL,
  buildExecutionBundle,
  defineCell,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const output = resolve(process.argv[2]);
const save = evidenceWriter(output);
const liveObservations = new Map();
const hostCells = new WeakMap();
let liveReplies = 0;
let gapReplies = 0;
let maximumPreviewBytes = 0;
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
const cell = await prepareCell(runtime, "cold-cell-1", OVEN_CELL);
const settings = checkedSettings({
  batchCount: 2,
  traysPerBatch: 1,
  ovenTrays: 1,
  rackTrays: 1,
  workerCount: 2,
  stage: 1,
  portion: 1,
  bake: 1,
  cool: 1,
  demould: 1,
  finishCooling: 1,
  pack: 1,
  loadSeconds: 10,
  unloadSeconds: 10,
  loadWindow: 0,
  horizonMinutes: 30,
});
const manualTasks = [
  {
    bakeryTaskId: "batch:B:process:stage",
    workerId: "human-2",
    earliestStartSeconds: 150,
    dependsOn: ["batch:A:process:portion"],
  },
  {
    bakeryTaskId: "batch:A:transfer:portion:bake",
    workerId: "human-1",
    earliestStartSeconds: 0,
    dependsOn: [],
  },
  {
    bakeryTaskId: "batch:A:transfer:cool:pack",
    workerId: "human-1",
    earliestStartSeconds: 900,
    dependsOn: [],
  },
];
const input = value(
  resolveAuthoredFinancierRun(settings, "normal", manualTasks),
);
const pinnedCell = parsePersistentCell(cell);
assert.ok(pinnedCell);
assert.equal(pinnedCell.fixture, "persistent-oven-rack/1");
const route = {
  route: "oven-rack",
  cell: pinnedCell,
  executionBundleId: bundle.id,
};
const sourceFingerprint = await sha256Hex("financier-source-fixture");
const authoredDefinition = {
  id: "oven-financier",
  name: "Physical oven recipe",
  note: "One persistent oven cell",
  procedureId: "financier",
  sourceFingerprint,
  definitionFingerprint: await productionDefinitionFingerprint(
    sourceFingerprint,
    settings,
    "normal",
    [],
    input.manualTasks,
    route,
  ),
  settings,
  variant: "normal",
  assignments: [],
  manualTasks: input.manualTasks,
  presentation: {},
  route: "oven-rack",
  cell: pinnedCell,
  executionBundleId: bundle.id,
};
save("shared-definition.json", authoredDefinition);
const reopened = parseProductionScenario(
  JSON.parse(JSON.stringify(authoredDefinition)),
);
assert.equal(reopened?.route, "oven-rack");
const scenario = value(await compileSavedOvenFinancier(reopened));
assert.deepEqual(scenario, value(await compileOvenFinancier(input, cell)));
const edited = parseProductionScenario({
  ...authoredDefinition,
  cell: { ...pinnedCell, clampForceN: 20 },
});
assert.equal(edited?.route, "oven-rack");
assert.equal(
  (await compileSavedOvenFinancier(edited)).error?.code,
  "invalid_definition",
);
assert.equal(
  parseProductionScenario({ ...authoredDefinition, cell: undefined }),
  null,
);
assert.equal(
  parseProductionScenario({
    ...authoredDefinition,
    assignments: [
      {
        batchId: "A",
        tray: 1,
        workerId: "human-1",
        dependsOn: [],
        earliestStartSeconds: 0,
      },
    ],
  }),
  null,
);
value(await E.admitScenario(scenario));
save("input.json", { settings, manualTasks, cell, scenario, bundle });
const codec = textCodec();
const engine = { E, runtime, codec };
const snapshotViews = new Map();
const continuedArtifacts = new Map();

function checkedSettings(overrides) {
  const result = parseSettings({ ...sampleSettings(), ...overrides });
  assert.equal(result.kind, "valid", JSON.stringify(result));
  return result.settings;
}
function task(run, batch, key) {
  const found = run.tasks.find(sameId.bind(null, `batch-${batch}#0/${key}`));
  assert.ok(found, `${batch}/${key}`);
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
async function open(saved, leg, definition = scenario, nativeCell = cell) {
  const host = await executionHost(engine);
  hostCells.set(host, nativeCell);
  const reply = await host.handle(
    beginRequest({
      bundle,
      cells: [nativeCell],
      runId: "oven-financier",
      executionId: `leg-${leg}`,
      hostSession: `host-${leg}`,
      scenario: definition,
      saved,
    }),
  );
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  const view = value(parseHostView(reply.view));
  assert.equal(view.logistics.kind, "available");
  if (saved !== null) {
    const before = snapshotViews.get(saved.document.snapshot);
    assert.ok(before);
    assert.deepEqual(view.logistics, before.logistics);
    assert.deepEqual(view.resourceHistory, before.resourceHistory);
    assert.deepEqual(view.storageHistory, before.storageHistory);
    assert.deepEqual(view.schedulingHistory, before.schedulingHistory);
  }
  return host;
}
async function drive(host, until) {
  for (let call = 0; call < 4000; call++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    assert.equal(
      parseHostView(reply.view).ok,
      true,
      `Invalid observation at ${reply.view.time}`,
    );
    await verifyLiveReply(reply, hostCells.get(host));
    if (
      reply.view.time >= until ||
      ["completed", "blocked"].includes(reply.view.status.kind)
    ) {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      const view = value(parseHostView(state.view));
      assert.equal(view.logistics.tasks.length, state.run.tasks.length);
      for (const projected of view.logistics.tasks) {
        const actual = state.run.tasks.find(sameId.bind(null, projected.id));
        assert.equal(projected.kind, actual.kind);
      }
      return state.run;
    }
  }
  throw new Error("Recipe exceeded its host-call bound");
}
function quantity(run, destination) {
  let amount = 0;
  for (const event of run.events)
    if (event.kind === "quantity-reported" && event.destination === destination)
      amount += event.quantity.amount;
  return amount;
}
function verify(run) {
  assert.equal(run.status.kind, "completed");
  for (const batch of ["A", "B"]) {
    const keys = [
      "stage",
      "transfer-stage-portion",
      "portion",
      "transfer-portion-bake",
      "oven-load",
      "bake",
      "oven-retrieve",
      "oven-rack",
      "transfer-bake-cool",
      "cool",
      "demould",
      "finishCooling",
      "transfer-cool-pack",
      "pack",
    ];
    let previous = 0;
    for (const key of keys) {
      const step = task(run, batch, key);
      assert.equal(step.kind, "completed", key);
      assert.ok(step.startedAt >= previous, key);
      previous = step.completedAt;
    }
    assert.equal(
      task(run, batch, "bake").completedAt - task(run, batch, "bake").startedAt,
      60_000_000,
    );
  }
  const bStage = task(run, "B", "stage");
  assert.ok(
    bStage.startedAt >=
      Math.max(150_000_000, task(run, "A", "portion").completedAt),
  );
  let removedAt = null;
  for (const event of run.events)
    if (
      event.kind === "carrier-picked-up" &&
      event.task === "batch-A#0/transfer-bake-cool"
    )
      removedAt = event.time;
  assert.notEqual(removedAt, null);
  assert.ok(task(run, "B", "transfer-portion-bake").startedAt >= removedAt);
  assert.ok(task(run, "B", "transfer-bake-cool").startedAt >= 900_000_000);
  assert.ok(task(run, "B", "oven-rack").completedAt < 900_000_000);
  let assigned = 0;
  for (const event of run.events)
    if (event.kind === "worker-assigned" && event.task === bStage.id) {
      assert.equal(event.worker, "human-2");
      assigned++;
    }
  assert.equal(assigned, 1);
  assert.equal(quantity(run, "packed-financiers"), 48);
  assert.equal(quantity(run, "rejected-financiers"), 0);
  assert.equal(run.cells[0].slot.kind, "inactive");
  for (const carrier of run.carriers) {
    assert.equal(carrier.bound, null);
    assert.deepEqual(carrier.custody, { kind: "stored", storage: "dispatch" });
  }
  verifyResourceHistory(run);
  verifyStorageHistory(run);
  verifySchedulingHistory(run);
}

function verifySchedulingHistory(run) {
  const interval = { after: null, through: run.position.time };
  const result = E.schedulingHistory(run, interval);
  assert.equal(result.kind, "available");
  assert.deepEqual(
    result,
    value(parseHostView(E.executionView(run))).schedulingHistory,
  );
  for (const resource of result.resources) {
    let total = 0;
    for (const kind of E.CAPACITY_CATEGORIES)
      total += resource.unitSeconds[kind];
    assert.ok(
      Math.abs(total - (resource.capacity * run.position.time) / 1_000_000) <
        1e-8,
    );
    for (const span of resource.intervals) {
      let units = 0;
      for (const kind of E.CAPACITY_CATEGORIES) units += span.units[kind];
      assert.equal(units, resource.capacity);
    }
  }
  const oven = result.resources.find(resourceNamed.bind(null, "oven"));
  const cycles = new Map();
  for (const event of run.events) {
    if (event.resource !== "oven") continue;
    if (event.kind === "batch-admitted" && !cycles.has(event.cycle))
      cycles.set(event.cycle, { admitted: event.time });
    const cycle = cycles.get(event.cycle);
    if (event.kind === "batch-started") cycle.started = event.time;
    if (event.kind === "batch-completed") cycle.completed = event.time;
    if (event.kind === "batch-cleared") cycle.cleared = event.time;
  }
  let loading = 0;
  let unloading = 0;
  for (const cycle of cycles.values()) {
    loading += cycle.started - cycle.admitted;
    unloading += cycle.cleared - cycle.completed;
  }
  assert.equal(oven.unitSeconds.running, 120);
  assert.equal(oven.unitSeconds.loading, loading / 1_000_000);
  assert.equal(oven.unitSeconds.unloading, unloading / 1_000_000);
  assert.ok(loading > 0 && unloading > 0);
  const coolingWait = result.waits.find(coolingDestinationWait);
  assert.ok(coolingWait);
  assert.equal(coolingWait.task, "batch-B#0/transfer-bake-cool");
  const split = E.logicalTime(600_000_000).value;
  const first = E.schedulingHistory(run, { after: null, through: split });
  const rest = E.schedulingHistory(run, {
    after: split,
    through: run.position.time,
  });
  for (const resource of result.resources) {
    const before = first.resources.find(
      resourceNamed.bind(null, resource.resource),
    );
    const after = rest.resources.find(
      resourceNamed.bind(null, resource.resource),
    );
    for (const kind of E.CAPACITY_CATEGORIES)
      assert.ok(
        Math.abs(
          before.unitSeconds[kind] +
            after.unitSeconds[kind] -
            resource.unitSeconds[kind],
        ) < 1e-8,
      );
  }
}

function coolingDestinationWait(wait) {
  return wait.blockers.some(coolingDestinationBlocker);
}
function coolingDestinationBlocker(blocker) {
  return blocker.kind === "destination" && blocker.storage === "cool";
}

function verifyResourceHistory(run) {
  const resources = E.runResults(run, {
    after: null,
    through: run.position.time,
  }).resources;
  const oven = resources.find(resourceNamed.bind(null, "oven"));
  assert.equal(
    oven.occupiedUnitSeconds,
    120,
    "Two 60-second cycles claim one oven slot",
  );
  assert.equal(oven.heldUnitSeconds, 0);
  assert.equal(oven.intervals.length, 2);
  const worker = resources.find(resourceNamed.bind(null, "human-2"));
  const stage = task(run, "B", "stage");
  const assignment = run.events.find(workerAssigned.bind(null, stage.id));
  assert.ok(assignment.arrivesAt > assignment.time);
  assert.ok(worker.travelUnitSeconds > 0);
  assert.ok(worker.handlingUnitSeconds > 0);
  const travel = worker.intervals.find(
    taskPhase.bind(null, stage.id, "travel"),
  );
  const handling = worker.intervals.find(
    taskPhase.bind(null, stage.id, "handling"),
  );
  assert.equal(travel.start, assignment.time);
  assert.equal(travel.end, assignment.arrivesAt);
  assert.equal(handling.start, assignment.arrivesAt);
  assert.equal(handling.end, stage.completedAt);
  for (const resource of resources) {
    assert.ok(
      Math.abs(
        resource.capacityUnitSeconds -
          resource.occupiedUnitSeconds -
          resource.reservedUnitSeconds -
          resource.heldUnitSeconds -
          resource.unallocatedUnitSeconds,
      ) < 0.000001,
    );
    assert.ok(resource.intervals.every(closedInterval));
  }
  const split = task(run, "A", "bake").startedAt + 30_000_000;
  const first = E.resourceUsage(run, { after: null, through: split });
  const rest = E.resourceUsage(run, {
    after: split,
    through: run.position.time,
  });
  assert.equal(
    first.find(resourceNamed.bind(null, "oven")).occupiedUnitSeconds,
    30,
  );
  assert.equal(
    rest.find(resourceNamed.bind(null, "oven")).occupiedUnitSeconds,
    90,
  );
  const zero = E.resourceUsage(run, { after: split, through: split });
  for (const resource of zero) {
    assert.equal(resource.claimedShare, null);
    assert.equal(resource.intervals.length, 0);
  }
  save("resource-history.json", { resources, split, first, rest, zero });
}

function verifyStorageHistory(run) {
  const interval = { after: null, through: run.position.time };
  const history = E.runResults(run, interval).storageHistory;
  assert.equal(history.kind, "available");
  assert.equal(
    history.storages.length,
    10,
    "Material stores use separate accounting",
  );
  const cool = history.storages.find(storageNamed.bind(null, "cool"));
  const aTransfer = task(run, "A", "transfer-bake-cool");
  const bTransfer = task(run, "B", "transfer-bake-cool");
  const aPlaced = run.events.find(
    carrierBoundary.bind(null, aTransfer.id, "carrier-placed"),
  );
  const bPlaced = run.events.find(
    carrierBoundary.bind(null, bTransfer.id, "carrier-placed"),
  );
  const aPickedUp = run.events.find(
    carrierBoundary.bind(
      null,
      "batch-A#0/transfer-cool-pack",
      "carrier-picked-up",
    ),
  );
  const bPickedUp = run.events.find(
    carrierBoundary.bind(
      null,
      "batch-B#0/transfer-cool-pack",
      "carrier-picked-up",
    ),
  );
  const reserved =
    (aPlaced.time - aTransfer.startedAt + bPlaced.time - bTransfer.startedAt) /
    1_000_000;
  const occupied =
    (aPickedUp.time - aPlaced.time + bPickedUp.time - bPlaced.time) / 1_000_000;
  assert.equal(cool.reservedSlotSeconds, reserved);
  assert.equal(cool.occupiedSlotSeconds, occupied);
  assert.equal(cool.fullSeconds, occupied + reserved);
  assert.equal(cool.peakOccupiedSlots, 1);
  assert.equal(cool.peakReservedSlots, 1);
  assert.equal(cool.peakCommittedSlots, 1);
  assert.equal(
    aPickedUp.time,
    bTransfer.startedAt,
    "Pickup releases a slot before same-timestamp reservation",
  );
  const pool = history.storages.find(
    storageNamed.bind(null, "empty-tray-groups"),
  );
  assert.equal(
    pool.peakOccupiedSlots,
    2,
    "Initial carriers contribute to elapsed occupancy",
  );
  for (const storage of history.storages) {
    assert.ok(
      Math.abs(
        (storage.slots * run.position.time) / 1_000_000 -
          storage.occupiedSlotSeconds -
          storage.reservedSlotSeconds -
          storage.freeSlotSeconds,
      ) < 0.000001,
    );
    assert.ok(storage.intervals.every(positiveInterval));
  }
  const split = aPickedUp.time;
  const first = E.storageHistory(run, { after: null, through: split });
  const rest = E.storageHistory(run, {
    after: split,
    through: run.position.time,
  });
  const zero = E.storageHistory(run, { after: split, through: split });
  for (const storage of history.storages) {
    const before = first.storages.find(
      storageNamed.bind(null, storage.storage),
    );
    const after = rest.storages.find(storageNamed.bind(null, storage.storage));
    assert.equal(
      before.occupiedSlotSeconds + after.occupiedSlotSeconds,
      storage.occupiedSlotSeconds,
    );
    assert.equal(
      before.reservedSlotSeconds + after.reservedSlotSeconds,
      storage.reservedSlotSeconds,
    );
    assert.equal(before.fullSeconds + after.fullSeconds, storage.fullSeconds);
  }
  for (const storage of zero.storages) {
    assert.equal(storage.intervals.length, 0);
    assert.equal(storage.fullSeconds, 0);
    assert.equal(storage.peakCommittedSlots, 0);
  }
  assert.throws(
    E.storageHistory.bind(null, run, {
      after: null,
      through: run.position.time + 2_000,
    }),
  );
  save("storage-history.json", { history, split, first, rest, zero });
}

function storageNamed(name, storage) {
  return storage.storage === name;
}
function carrierBoundary(task, kind, event) {
  return event.task === task && event.kind === kind;
}
function positiveInterval(span) {
  return span.end > span.start;
}

function resourceNamed(name, resource) {
  return resource.resource === name;
}
function workerAssigned(task, event) {
  return event.kind === "worker-assigned" && event.task === task;
}
function taskPhase(task, phase, interval) {
  return interval.task === task && interval.kind === phase;
}
function closedInterval(interval) {
  return !interval.ongoing;
}

function retainArtifacts(index, saved) {
  for (const artifact of saved.artifacts) index.set(artifact.digest, artifact);
}

function boundaryEvent(boundary, event) {
  return event.kind === "cell-committed" && event.boundary === boundary;
}

async function verifyCellRecordings(saved, artifacts) {
  const idleSamples = createHash("sha256");
  const idleContacts = createHash("sha256");
  let idleSampleCount = 0;
  let previousSample = null;
  const handoffs = [];
  let idleSteps = 0;
  let idleRecords = 0;
  let mappedAfterHold = false;
  let recordingBytes = 0;
  for (const entry of saved.document.artifacts) {
    if (entry.role !== "recording-segment") continue;
    recordingBytes += entry.byteLength;
    const artifact = artifacts.get(entry.digest);
    assert.ok(artifact, "Every saved pack remains available after restore");
    assert.equal(await sha256Hex(artifact.content), entry.digest);
    for (const stored of value(E.unpackRecordings(artifact.content))) {
      const raw = JSON.parse(stored.content);
      if (raw.kind !== "accepted-cell-recording") continue;
      assert.equal(await sha256Hex(stored.content), stored.digest);
      const record = E.readCellRecordingDocument(raw);
      const native = JSON.parse(record.native);
      const motion = native.motion;
      assert.equal(record.runId, saved.document.state.identity.runId);
      assert.equal(record.bundle, bundle.id);
      assert.equal(record.cellId, cell.cellId);
      assert.equal(native.cellId, cell.cellId);
      assert.equal(native.runId, cell.runId);
      assert.equal(native.modelHash, cell.modelHash);
      assert.equal(native.runnerSha256, cell.execution.controllerHash);
      assert.equal(native.runtimeSha256, cell.execution.runtimeHash);
      assert.equal(motion.kind, record.time.kind);
      if (record.time.kind === "idle") {
        idleRecords++;
        const steps = motion.endStep - motion.startStep;
        idleSteps += steps;
        assert.ok(steps >= 1 && steps <= 32);
        assert.equal(record.time.through - record.time.after, steps * 2000);
        assert.ok(record.time.through <= saved.document.state.position.time);
        assert.equal(motion.sampleStride, 1);
        assert.equal(motion.samples.length, steps + 1);
        assert.equal(motion.contacts.kind, "dense");
        assert.equal(motion.contacts.observations.length, steps);
        assert.equal(motion.samples[0].step, motion.startStep);
        assert.equal(motion.samples.at(-1).step, motion.endStep);
        if (record.time.after > motion.startStep * 2000) mappedAfterHold = true;
        for (const sample of motion.samples) {
          const at =
            record.time.after + (sample.step - motion.startStep) * 2000;
          const encoded = canonicalJson({ at, sample });
          if (encoded === previousSample) continue;
          idleSamples.update(encoded);
          idleSamples.update("\n");
          idleSampleCount += 1;
          previousSample = encoded;
        }
        for (const contact of motion.contacts.observations) {
          const at =
            record.time.after + (contact.step - motion.startStep) * 2000;
          idleContacts.update(canonicalJson({ at, contact }));
          idleContacts.update("\n");
        }
      } else {
        const event = saved.document.state.events.find(
          boundaryEvent.bind(null, record.time.boundary),
        );
        assert.ok(event, "Only committed handoffs enter durable packs");
        assert.equal(event.time, record.time.at);
        assert.equal(event.checkpoint, native.checkpoint);
        assert.equal(motion.before.step, motion.step);
        assert.equal(motion.after.step, motion.step);
        for (const key of ["joints", "tool", "jaw"])
          assert.deepEqual(motion.before[key], motion.after[key]);
        assert.notDeepEqual(motion.before.tray, motion.after.tray);
        if (motion.kind === "admission") {
          assert.equal(motion.beforeSlot.kind, "inactive");
          assert.equal(motion.afterSlot.kind, "active");
          assert.equal(
            motion.afterSlot.generation,
            motion.beforeSlot.generation + 1,
          );
        } else {
          assert.equal(motion.beforeSlot.kind, "active");
          assert.equal(motion.afterSlot.kind, "inactive");
          assert.equal(
            motion.afterSlot.generation,
            motion.beforeSlot.generation,
          );
        }
        handoffs.push({ time: record.time, native });
        liveObservations.set(record.time.boundary, {
          observation: {
            kind: "cell-recorded",
            version: 1,
            cell: record.cellId,
            at: record.time.at,
            digest: stored.digest,
            content: stored.content,
          },
          committedAt: record.time.at,
          cellDefinition: cell,
        });
      }
    }
  }
  assert.ok(idleRecords > 0);
  assert.equal(handoffs.length, 4, "Two admissions and two removals");
  assert.ok(
    recordingBytes < 256 * 1024 * 1024,
    "The full recipe must keep dense operation evidence within 256 MiB",
  );
  return {
    idleRecords,
    idleSteps,
    mappedAfterHold,
    recordingBytes,
    idleSamples: { count: idleSampleCount, sha256: idleSamples.digest("hex") },
    idleContactsSha256: idleContacts.digest("hex"),
    handoffs,
  };
}

let host = await open(null, "baseline");
const baseline = await drive(host, scenario.limits.horizon);
save("baseline.json", baseline);
verify(baseline);
const baselineSave = await host.handle({ kind: "save" });
assert.equal(baselineSave.kind, "saved");
save("baseline-save.json", baselineSave);
const baselineArtifacts = new Map();
retainArtifacts(baselineArtifacts, baselineSave);
const baselineCellRecords = await verifyCellRecordings(
  baselineSave,
  baselineArtifacts,
);
await host.handle({ kind: "dispose" });
const stops = [];
for (const batch of ["A", "B"])
  for (const key of ["oven-load", "bake", "oven-retrieve", "oven-rack"])
    stops.push(task(baseline, batch, key).startedAt + 2_000_000);
stops.push(task(baseline, "B", "oven-rack").completedAt + 2_000_000);
stops.sort(ascending);
function ascending(left, right) {
  return left - right;
}
host = await open(null, 0);
for (const [leg, until] of stops.entries()) {
  const state = await drive(host, until);
  assert.equal(state.status.kind, "advancing");
  if (leg === stops.length - 1) {
    assert.equal(task(state, "B", "transfer-bake-cool").kind, "waiting");
    assert.equal(state.cells[0].slot.kind, "active");
  }
  assert.equal(
    (await host.handle({ kind: "pause", commandId: `pause-${leg}` })).receipt
      .status,
    "accepted",
  );
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  retainArtifacts(continuedArtifacts, saved);
  const view = value(
    parseHostView((await host.handle({ kind: "state" })).view),
  );
  snapshotViews.set(saved.document.snapshot, view);
  save(`view-${leg}.json`, view);
  if (leg === stops.length - 1) verifyCoolingQueue(view);
  save(`save-${leg}.json`, saved);
  await host.handle({ kind: "dispose" });
  host = await open(saved, leg + 1);
}
const continued = await drive(host, scenario.limits.horizon);
verify(continued);
assert.deepEqual(history(continued), history(baseline));
assert.deepEqual(world(continued), world(baseline));
assert.deepEqual(
  E.resourceUsage(continued, { after: null, through: continued.position.time }),
  E.resourceUsage(baseline, { after: null, through: baseline.position.time }),
);
assert.deepEqual(
  E.storageHistory(continued, {
    after: null,
    through: continued.position.time,
  }),
  E.storageHistory(baseline, { after: null, through: baseline.position.time }),
);
save("continued.json", continued);
assert.deepEqual(
  E.schedulingHistory(continued, {
    after: null,
    through: continued.position.time,
  }),
  E.schedulingHistory(baseline, {
    after: null,
    through: baseline.position.time,
  }),
);
save(
  "scheduling-history.json",
  E.schedulingHistory(continued, {
    after: null,
    through: continued.position.time,
  }),
);
const continuedSave = await host.handle({ kind: "save" });
assert.equal(continuedSave.kind, "saved");
retainArtifacts(continuedArtifacts, continuedSave);
await verifyStorageHistoryRefusals(continuedSave);
await verifySchedulingHistoryRefusals(continuedSave);
save("continued-save.json", {
  ...continuedSave,
  artifacts: [...continuedArtifacts.values()],
});
const continuedCellRecords = await verifyCellRecordings(
  continuedSave,
  continuedArtifacts,
);
assert.deepEqual(
  continuedCellRecords.idleSamples,
  baselineCellRecords.idleSamples,
);
assert.deepEqual(continuedCellRecords.handoffs, baselineCellRecords.handoffs);
assert.equal(
  continuedCellRecords.idleContactsSha256,
  baselineCellRecords.idleContactsSha256,
);
assert.equal(continuedCellRecords.idleSteps, baselineCellRecords.idleSteps);
save("cell-recordings.json", {
  baseline: await cellRecordingSummary(baselineCellRecords),
  continued: await cellRecordingSummary(continuedCellRecords),
});
await host.handle({ kind: "dispose" });

const refusals = [];
for (const overrides of [
  { ovenTrays: 2 },
  { traysPerBatch: 2, ovenTrays: 2, rackTrays: 2 },
]) {
  const altered = value(
    resolveAuthoredFinancierRun(
      checkedSettings({ ...settings, ...overrides }),
      "normal",
      manualTasks,
    ),
  );
  const refused = await compileOvenFinancier(altered, cell);
  assert.equal(refused.ok, false);
  refusals.push(refused);
}
const wrongFixture = await compileOvenFinancier(input, {
  ...cell,
  fixture: "persistent-rack/1",
});
assert.equal(wrongFixture.ok, false);
refusals.push(wrongFixture);
save("refusals.json", refusals);
await verifyRecovery();
assert.ok(
  liveObservations.has("cell/idle"),
  "The host must publish idle samples",
);
assert.equal(
  liveObservations.size,
  13,
  "Six operations, two recoveries, idle motion and four handoffs",
);
save("live-observations.json", [...liveObservations.values()]);
await verifyRetainedObservations();
save("report.json", {
  result: "passed",
  bundle: bundle.id,
  route: "oven-rack",
  simulatedSeconds: baseline.position.time / 1_000_000,
  packed: 48,
  nativeOperations: 6,
  cellRecordings: {
    idleRecords: baselineCellRecords.idleRecords,
    idleSteps: baselineCellRecords.idleSteps,
    uniqueIdleSamples: baselineCellRecords.idleSamples.count,
    idleContactsIdentical: true,
    recordingBytes: baselineCellRecords.recordingBytes,
    committedHandoffs: baselineCellRecords.handoffs.length,
    identicalAfterNineRestores: true,
    qualifiedHolds: baselineCellRecords.mappedAfterHold,
  },
  restores: stops,
  refusals: refusals.length,
  livePhysics: {
    replies: liveReplies,
    gapReplies,
    maximumPreviewBytes,
    operationAndRecoverySamples: 8,
    idleSamples: true,
    handoffEndpoints: 4,
  },
  logistics: {
    coolingQueue: true,
    restoredViews: stops.length,
    retainedViewUnavailable: true,
    retainedDependenciesUnavailable: true,
    crossBatchDependencies: true,
    unknownObservationVersionRefused: true,
    unknownTaskSubjectRefused: true,
  },
  storageHistory: {
    restored: true,
    initialOccupancy: true,
    reservationToOccupancy: true,
    sameTimestampReuse: true,
    recoveryCleanup: true,
    clippedIntervals: true,
    zeroDuration: true,
    retainedHistoryUnavailable: true,
    contradictorySaveRefused: true,
  },
  resourceHistory: {
    restored: true,
    releasedClaims: true,
    workerTravel: true,
    failureHolds: true,
    clippedIntervals: true,
    zeroDuration: true,
    retainedHistoryUnavailable: true,
  },
  schedulingHistory: {
    restored: true,
    capacityConserved: true,
    batchPhases: true,
    clippedIntervals: true,
    coolingBlockers: true,
    retainedHistoryUnavailable: true,
    contradictorySaveRefused: true,
  },
});
console.log(`Full-route financier journey passed: ${output}`);

async function cellRecordingSummary(record) {
  return {
    idleRecords: record.idleRecords,
    idleSteps: record.idleSteps,
    canonicalIdleSamples: record.idleSamples.count,
    recordingBytes: record.recordingBytes,
    idleSamplesSha256: record.idleSamples.sha256,
    idleContactsSha256: record.idleContactsSha256,
    handoffs: record.handoffs,
  };
}

async function verifyLiveReply(reply, cellDefinition) {
  const [view] = readCellPhysicsViews(reply.physics, reply.view.time);
  assert.ok(view);
  if (view.kind === "unavailable") return;
  liveReplies++;
  if (view.at < reply.view.time) gapReplies++;
  maximumPreviewBytes = Math.max(maximumPreviewBytes, view.content.length);
  const raw = JSON.parse(view.content);
  assert.equal(await sha256Hex(view.content), view.digest);
  if (view.kind === "cell-recorded") {
    const document = E.readCellRecordingDocument(raw);
    const motion = JSON.parse(document.native).motion;
    if (document.time.kind === "idle") {
      assert.equal(view.at, document.time.through);
      assert.equal(
        document.time.through - document.time.after,
        (motion.endStep - motion.startStep) * 2000,
      );
      assert.equal(motion.samples[0].step, motion.startStep);
      assert.equal(motion.samples.at(-1).step, motion.endStep);
    } else {
      assert.equal(view.at, document.time.at);
      assert.equal(motion.before.step, motion.after.step);
    }
  } else {
    assert.equal(view.at, view.startedAt + raw.endStep * 2000);
    assert.ok(raw.endStep - raw.startStep <= 32);
    assert.equal(raw.samples[0].step, raw.startStep);
    assert.equal(raw.samples.at(-1).step, raw.endStep);
  }
  assert.equal(view.cell, reply.view.cells[0].id);
  assert.throws(
    readPhysicsView.bind(null, { ...view, version: 99 }, reply.view.time),
  );
  assert.throws(
    readPhysicsView.bind(
      null,
      { ...view, at: reply.view.time + 2000 },
      reply.view.time,
    ),
  );
  let key;
  if (view.kind === "recorded") key = `${view.task}/${view.purpose}`;
  else if (raw.time.kind === "idle") key = "cell/idle";
  else key = raw.time.boundary;
  liveObservations.set(key, {
    observation: view,
    committedAt: reply.view.time,
    cellDefinition,
  });
}

async function verifyRecovery() {
  const weakCell = {
    ...cell,
    clampForceN: 20,
    ingredients: { ...cell.ingredients, massKg: 2 },
  };
  const compiled = value(await compileOvenFinancier(input, weakCell));
  const definition = {
    ...compiled,
    resources: [
      ...compiled.resources,
      {
        kind: "capacity",
        id: "oven-access",
        capacity: 1,
        configuration: null,
      },
    ],
    workflows: compiled.workflows.map(withAccessWorkflow),
  };
  let engine = await open(null, "weak", definition, weakCell);
  for (const batch of ["A", "B"]) {
    const failed = await drive(engine, definition.limits.horizon);
    assert.equal(failed.status.kind, "blocked");
    const load = task(failed, batch, "oven-load");
    assert.equal(load.kind, "recovery-required");
    const claims = failed.events.filter(failedClaim.bind(null, load.id));
    assert.ok(
      claims.length > 0,
      "Native failure must accept held resource claims",
    );
    const saved = await engine.handle({ kind: "save" });
    assert.equal(saved.kind, "saved");
    const view = value(
      parseHostView((await engine.handle({ kind: "state" })).view),
    );
    snapshotViews.set(saved.document.snapshot, view);
    save(`failed-view-${batch}.json`, view);
    save(`failed-${batch}.json`, {
      scenario: definition,
      cell: weakCell,
      failed,
      saved,
    });
    await engine.handle({ kind: "dispose" });
    engine = await open(saved, `weak-${batch}`, definition, weakCell);
    const command = {
      kind: "recover-with-worker",
      commandId: `reject-${batch}`,
      task: load.id,
      resource: "human-1",
      location: "bake",
      storage: "rejected-tray-groups",
      handling: 5_000_000,
      evidence: "assumed",
      reports: [{ product: "financiers", destination: "rejected-financiers" }],
    };
    const admitted = await engine.handle(command);
    assert.equal(
      admitted.receipt?.status,
      "accepted",
      JSON.stringify(admitted),
    );
    assert.deepEqual((await engine.handle(command)).receipt, admitted.receipt);
  }
  const recovered = await drive(engine, definition.limits.horizon);
  for (const batch of ["A", "B"]) {
    assert.equal(task(recovered, batch, "oven-load").kind, "failed");
    assert.equal(task(recovered, batch, "bake").kind, "cancelled");
    assert.equal(task(recovered, batch, "pack").kind, "cancelled");
  }
  assert.equal(quantity(recovered, "packed-financiers"), 0);
  assert.equal(quantity(recovered, "rejected-financiers"), 48);
  assert.equal(recovered.cells[0].slot.kind, "inactive");
  assert.equal(
    recovered.resources.find(sameId.bind(null, "oven")).batch.kind,
    "idle",
  );
  save("recovered.json", recovered);
  const usage = E.resourceUsage(recovered, {
    after: null,
    through: recovered.position.time,
  });
  assert.ok(usage.some(hasHeldTime));
  const human = usage.find(resourceNamed.bind(null, "human-1"));
  const handoff = human.intervals.filter(
    taskPhase.bind(null, "batch-A#0/oven-load", "handling"),
  );
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].end - handoff[0].start, 5_000_000);
  assert.ok(usage.every(noOpenClaims));
  save("recovery-resource-history.json", usage);
  const history = E.storageHistory(recovered, {
    after: null,
    through: recovered.position.time,
  });
  const rejected = history.storages.find(
    storageNamed.bind(null, "rejected-tray-groups"),
  );
  assert.equal(rejected.peakOccupiedSlots, 2);
  assert.equal(rejected.intervals.at(-1).occupants.length, 2);
  assert.equal(rejected.intervals.at(-1).reservations.length, 0);
  let reservedSeconds = 0;
  for (const batch of ["A", "B"]) {
    const id = `batch-${batch}#0/oven-load`;
    const started = recovered.events.find(
      carrierBoundary.bind(null, id, "recovery-started"),
    );
    const assigned = recovered.events.find(workerAssigned.bind(null, id));
    reservedSeconds +=
      (assigned.arrivesAt + 5_000_000 - started.time) / 1_000_000;
  }
  assert.equal(rejected.reservedSlotSeconds, reservedSeconds);
  for (const storage of recovered.storages)
    assert.equal(storage.reservations.length, 0);
  save("recovery-storage-history.json", history);
  await engine.handle({ kind: "dispose" });
}

function failedClaim(task, event) {
  return (
    event.kind === "resource-claimed" &&
    event.task === task &&
    event.allocation === "held"
  );
}
function hasHeldTime(resource) {
  return resource.heldUnitSeconds > 0;
}
function noOpenClaims(resource) {
  return resource.intervals.every(closedInterval);
}

function withAccessWorkflow(workflow) {
  return { ...workflow, tasks: workflow.tasks.map(withAccessClaim) };
}

function withAccessClaim(task) {
  if (task.key !== "oven-load") return task;
  return {
    ...task,
    claims: [{ resource: "oven-access", units: 1, configuration: null }],
  };
}

function verifyCoolingQueue(raw) {
  const view = value(parseHostView(raw));
  const logistics = view.logistics;
  assert.equal(logistics.kind, "available");
  const queue = logistics.queues.find(sameId.bind(null, "cool"));
  assert.deepEqual(queue, {
    kind: "storage",
    id: "cool",
    tasks: ["batch-B#0/transfer-bake-cool"],
  });
  assert.deepEqual(
    logistics.carrierStores.find(sameId.bind(null, "cool")).occupants,
    ["tray-group-A"],
  );
  assert.deepEqual(
    logistics.carrierStores.find(sameId.bind(null, "oven-rack")).occupants,
    ["tray-group-B"],
  );
  assert.equal(
    logistics.resources.find(sameId.bind(null, "oven")).batchPhase,
    "idle",
  );
  assert.equal(logistics.version, 2);
  assert.ok(logistics.dependencies.some(isCrossBatchDependency));
  assert.ok(logistics.dependencies.some(isLoadDependency));
  const unknownVersion = structuredClone(view);
  unknownVersion.logistics.version = 3;
  assert.equal(parseHostView(unknownVersion).ok, false);
  const unknownHistory = structuredClone(view);
  unknownHistory.resourceHistory.version = 2;
  assert.equal(parseHostView(unknownHistory).ok, false);
  const futureHistory = structuredClone(view);
  futureHistory.resourceHistory.through += 2_000;
  assert.equal(parseHostView(futureHistory).ok, false);
  assert.equal(view.storageHistory.kind, "available");
  const unknownStorage = structuredClone(view);
  unknownStorage.storageHistory.version = 99;
  assert.equal(parseHostView(unknownStorage).ok, false);
  const futureStorage = structuredClone(view);
  futureStorage.storageHistory.through += 2_000;
  assert.equal(parseHostView(futureStorage).ok, false);
  const overfull = structuredClone(view);
  overfull.storageHistory.storages[0].peakCommittedSlots = 999;
  assert.equal(parseHostView(overfull).ok, false);
  save("cooling-logistics.json", view);
  const unknownSubject = structuredClone(view);
  unknownSubject.logistics.tasks[0].subject = {
    kind: "future-task",
    resource: "oven",
    from: "program-a",
    to: "program-b",
    cause: "batch-B#0/transfer-bake-cool",
  };
  const refused = parseHostView(unknownSubject);
  assert.equal(refused.ok, false);
  save("unknown-task-subject-refusal.json", { view: unknownSubject, refused });
}

async function verifyRetainedObservations() {
  await verifyRetainedObservationBuild(
    "0dfc48575c54c058c2bcea9e6527842397585a4cc40900836d2818fee8d85f3a",
    false,
  );
  await verifyRetainedObservationBuild(
    "b6abbf692de2913d2240ec260ec562611a127cdf92d3b5b2c98e5550598117ce",
    true,
  );
}

async function verifyRetainedObservationBuild(bundleId, hasLogistics) {
  const directory = resolve(
    `apps/portal/public/bakery-physics/executions/${bundleId}`,
  );
  const retained = await import(
    pathToFileURL(join(directory, "production-engine.mjs")).href
  );
  const manifest = JSON.parse(
    readFileSync(join(directory, "execution.json"), "utf8"),
  );
  const retainedRuntime = resolve(
    `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
  );
  const module = await runtimeModule(retainedRuntime);
  const retainedCell = defineCell(module, "cold-cell-1", OVEN_CELL);
  const retainedScenario = value(
    await compileOvenFinancier(input, retainedCell),
  );
  const engine = collectingExecutionHost(
    retained,
    retained.wasmTransport(module, codec),
  );
  const began = await engine.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells: [retainedCell],
    identity: {
      runId: "retained-observations",
      executionId: "retained-1",
      hostSession: "retained-host",
      parent: null,
    },
    origin: { kind: "scenario", scenario: retainedScenario },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));
  const drove = await engine.handle({
    kind: "drive",
    turns: 16,
    until: 2_000_000,
  });
  assert.equal(drove.kind, "drove");
  const view = value(parseHostView(drove.view));
  assert.deepEqual(view.resourceHistory, { kind: "unavailable" });
  assert.deepEqual(view.storageHistory, { kind: "unavailable" });
  assert.deepEqual(view.schedulingHistory, { kind: "unavailable" });
  if (hasLogistics) {
    assert.equal(view.logistics.kind, "available");
    assert.equal(view.logistics.version, 2);
    assert.equal(view.logistics.dependencies, null);
    assert.ok(view.logistics.tasks.length > 0);
  } else {
    assert.deepEqual(view.logistics, { kind: "unavailable" });
  }
  assert.ok(view.time > 0);
  save(`retained-view-${hasLogistics ? "v1" : "absent"}.json`, {
    bundle: manifest.bundle.id,
    view,
  });
  await engine.handle({ kind: "dispose" });
}

function isCrossBatchDependency(edge) {
  return (
    edge.task === "batch-B#0/stage" && edge.prerequisite === "batch-A#0/portion"
  );
}
function isLoadDependency(edge) {
  return (
    edge.task === "batch-B#0/oven-load" &&
    edge.prerequisite === "batch-B#0/transfer-portion-bake"
  );
}

async function verifyStorageHistoryRefusals(saved) {
  const changed = structuredClone(saved.document.state);
  const last = changed.events.findLast(storageEvent.bind(null, "dispatch"));
  last.occupants = [];
  const contradictory = await E.resumableDocument(
    changed,
    bundle,
    saved.document.artifacts,
  );
  const refused = await E.openResumable(contradictory, "browser", [bundle]);
  assert.equal(
    refused.ok,
    false,
    "Valid content hashes cannot admit contradictory history",
  );
  const partial = structuredClone(saved.document.state);
  const initial = partial.events.findIndex(storageEvent.bind(null, "cool"));
  partial.events.splice(initial, 1);
  for (const [index, event] of partial.events.entries())
    event.sequence = index + 1;
  partial.position.eventSequence = partial.events.length;
  const incomplete = await E.resumableDocument(
    partial,
    bundle,
    saved.document.artifacts,
  );
  const missing = await E.openResumable(incomplete, "browser", [bundle]);
  assert.equal(
    missing.ok,
    false,
    "A partial history cannot replace its missing initial state",
  );
  save("storage-history-refusals.json", {
    contradictory: refused,
    missingInitial: missing,
  });
}
function storageEvent(storage, event) {
  return event.kind === "storage-changed" && event.storage === storage;
}

async function verifySchedulingHistoryRefusals(saved) {
  const changed = structuredClone(saved.document.state);
  const firstWait = changed.events.find(nonemptyWaiting);
  const last = changed.events.findLast(waitingEvent);
  last.waiting = firstWait.waiting;
  const document = await E.resumableDocument(
    changed,
    bundle,
    saved.document.artifacts,
  );
  const refused = await E.openResumable(document, "browser", [bundle]);
  assert.equal(
    refused.ok,
    false,
    "A completed run cannot retain a waiting snapshot",
  );
  const view = E.executionView(saved.document.state);
  const invalidVersion = structuredClone(view);
  invalidVersion.schedulingHistory.version = 99;
  assert.equal(parseHostView(invalidVersion).ok, false);
  const invalidCapacity = structuredClone(view);
  invalidCapacity.schedulingHistory.resources[0].intervals[0].units.idle += 1;
  assert.equal(parseHostView(invalidCapacity).ok, false);
  const invalidTotal = structuredClone(view);
  invalidTotal.schedulingHistory.resources[0].unitSeconds.running += 1;
  assert.equal(parseHostView(invalidTotal).ok, false);
  save("scheduling-history-refusals.json", {
    refused,
    invalidVersion: true,
    invalidCapacity: true,
    invalidTotal: true,
  });
}
function waitingEvent(event) {
  return event.kind === "waiting-changed";
}
function nonemptyWaiting(event) {
  return waitingEvent(event) && event.waiting.length > 0;
}
