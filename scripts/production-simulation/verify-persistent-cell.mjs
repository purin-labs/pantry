// Plan 70B/70E: one persistent cold cell. An empty cell admits tray A,
// transfers it, releases it and admits tray B without resetting the world.
// Every boundary crosses a fresh process, two pauses fall inside phases, and
// the result is compared with the same journey run without interruption.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { checkpointFields } from "./engine-hosts.mjs";

const TICK_SECONDS = 0.002;
const PARKED = [0, 0, -10, 1, 0, 0, 0];
// Simulated seconds of ordinary advancement each settled hold is compared with.
const HOLD_SECONDS = (process.env.PLAN_70_HOLD_SECONDS ?? "60,900,14400")
  .split(",")
  .map(Number);
const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
if (process.argv.length !== 3)
  throw new Error("Provide a new acceptance output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });

let files = 0;
function path(name) {
  return join(output, `${String(++files).padStart(3, "0")}-${name}.json`);
}

function invoke(args, name) {
  const file = path(name);
  execFileSync(binary, ["--root", root, "--output", file, ...args], {
    timeout: 1_800_000,
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(file, "utf8"));
}

// One process applies `actions` to a new cell or to an earlier output.
function cell(name, initial, actions) {
  const request = join(
    output,
    `${String(files + 1).padStart(3, "0")}-${name}-request.json`,
  );
  writeFileSync(
    request,
    JSON.stringify({ schemaVersion: 1, initial, actions }),
    { flag: "wx" },
  );
  return withFields(invoke(["cell", request], name));
}

// The output holds the checkpoint envelope and its digest (Refactor 16,
// step 11); the journey reads the checkpoint's fields.
function withFields(result) {
  return {
    ...result,
    stored: result.checkpoint,
    checkpoint: checkpointFields(result.checkpoint),
  };
}

function create(definition) {
  return { kind: "create", definition };
}

// The envelope holds the checkpoint's fields as they stand, so a field that
// a refusal case changes reaches the engine.
function after(earlier) {
  const { digest, ...payload } = earlier.checkpoint;
  return {
    kind: "continue",
    content: JSON.stringify({ ...JSON.parse(earlier.stored.content), payload }),
    digest,
    sequence: earlier.sequence,
  };
}

const rejections = {};
function refuse(name, initial, actions) {
  const request = join(output, `rejected-${name}-request.json`);
  const rejected = join(output, `rejected-${name}.json`);
  writeFileSync(
    request,
    JSON.stringify({ schemaVersion: 1, initial, actions }),
    {
      flag: "wx",
    },
  );
  const result = spawnSync(
    binary,
    ["--root", root, "--output", rejected, "cell", request],
    { timeout: 120_000, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, `${name} must be rejected`);
  assert.equal(existsSync(rejected), false, `${name} must not create output`);
  const lines = result.stderr.trim().split("\n");
  rejections[name] = lines[lines.length - 1];
}

function distance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

// The angle between two unit quaternions, in degrees.
function rotation(left, right) {
  let dot = 0;
  for (let index = 3; index < 7; index++) dot += left[index] * right[index];
  return (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI;
}

function speed(velocity) {
  return {
    linear: Math.hypot(velocity[0], velocity[1], velocity[2]),
    angular: Math.hypot(velocity[3], velocity[4], velocity[5]),
  };
}

function eventsOf(segments, attempt) {
  const events = [];
  for (const segment of segments)
    if (segment.attemptId === attempt) events.push(...segment.events);
  return events;
}

function pickupStep(segments, attempt) {
  for (const event of eventsOf(segments, attempt))
    if (event.kind === "pickup") return event.step;
  throw new Error(`${attempt} recorded no pickup`);
}

// Every sample of the uninterrupted attempt appears unchanged in the
// interrupted one; the additions are the samples taken where it paused.
function assertSameAttempt(whole, parts, attempt, pauses) {
  const segments = parts.filter((segment) => segment.attemptId === attempt);
  const reference = whole.filter((segment) => segment.attemptId === attempt);
  assert.equal(reference.length, 1);
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.sequence, index);
    if (index === 0) continue;
    assert.equal(segment.predecessor, segments[index - 1].checkpoint);
    assert.equal(segment.startStep, segments[index - 1].endStep);
  }
  assert.deepEqual(eventsOf(parts, attempt), reference[0].events);
  const contacts = [];
  for (const segment of segments) {
    assert.equal(segment.contacts.kind, "dense");
    assert.equal(
      segment.contacts.observations.length,
      segment.endStep - segment.startStep,
    );
    contacts.push(...segment.contacts.observations);
  }
  assert.deepEqual(contacts, reference[0].contacts.observations);
  const interrupted = new Map();
  for (const segment of segments)
    for (const sample of segment.samples) interrupted.set(sample.step, sample);
  const sampled = new Set();
  for (const sample of reference[0].samples) {
    assert.deepEqual(interrupted.get(sample.step), sample);
    sampled.add(sample.step);
  }
  for (const step of interrupted.keys())
    assert.ok(sampled.has(step) || pauses.includes(step), `step ${step}`);
  for (const pause of pauses) assert.ok(interrupted.has(pause));
}

// 1. A definition pinned to this runner. A cell off the factory tick is
//    refused when prepared and when a hand-edited definition is created.
const definition = invoke(["prepare-cell"], "definition");
assert.equal(definition.timestep, TICK_SECONDS);
const offTick = spawnSync(
  binary,
  [
    "--root",
    root,
    "--output",
    join(output, "rejected-prepare-1ms.json"),
    "prepare-cell",
    "--timestep",
    "0.001",
  ],
  { encoding: "utf8" },
);
assert.notEqual(offTick.status, 0);
assert.equal(existsSync(join(output, "rejected-prepare-1ms.json")), false);
rejections.prepareOneMillisecondCell = offTick.stderr.trim().split("\n").pop();

// 2. The journey in one process.
const journey = [
  { kind: "admit", carrier: "tray-a" },
  { kind: "start", task: "table-to-rack", attemptId: "attempt-a" },
  { kind: "finish" },
  { kind: "remove", carrier: "tray-a" },
  { kind: "admit", carrier: "tray-b" },
  { kind: "start", task: "table-to-rack", attemptId: "attempt-b" },
  { kind: "finish" },
  { kind: "remove", carrier: "tray-b" },
];
const whole = cell("uninterrupted", create(definition), journey);
assert.deepEqual(
  whole.results.map((result) => result.kind),
  [
    "admitted",
    "started",
    "terminal",
    "removed",
    "admitted",
    "started",
    "terminal",
    "removed",
  ],
);
const [
  admittedA,
  startedA,
  finishedA,
  removedA,
  admittedB,
  startedB,
  finishedB,
  removedB,
] = whole.results;
assert.equal(finishedA.outcome.kind, "completed");
assert.equal(finishedB.outcome.kind, "completed");
// The second transfer begins where the first one left the arm.
assert.deepEqual(startedB.plan.slice(0, 3), [
  "settle",
  "return_lift",
  "return_traverse",
]);
assert.deepEqual(startedB.plan.slice(3), startedA.plan.slice(1));
assert.deepEqual(whole.checkpoint.slot, { kind: "inactive", generation: 2 });
assert.equal(whole.checkpoint.steps, finishedA.steps + finishedB.steps);

// 3. The same journey with every boundary in a fresh process and pauses
//    inside phases: after tray A's pickup, during the return motion, and
//    after tray B's pickup.
const pauseA = pickupStep(whole.segments, "attempt-a") + 671;
const pauseReturn = 1_703;
const pauseB = pickupStep(whole.segments, "attempt-b") + 671;
const steps = [];
steps.push(
  cell("fresh-admit-a", create(definition), [
    { kind: "admit", carrier: "tray-a" },
  ]),
);
function next(name, actions) {
  const result = cell(name, after(steps[steps.length - 1]), actions);
  steps.push(result);
  return result;
}
const pausedA = next("fresh-start-a", [
  { kind: "start", task: "table-to-rack", attemptId: "attempt-a" },
  { kind: "advance", steps: pauseA },
]);
next("fresh-finish-a", [{ kind: "finish" }]);
const emptied = next("fresh-remove-a", [{ kind: "remove", carrier: "tray-a" }]);
next("fresh-admit-b", [{ kind: "admit", carrier: "tray-b" }]);
const pausedReturn = next("fresh-start-b", [
  { kind: "start", task: "table-to-rack", attemptId: "attempt-b" },
  { kind: "advance", steps: pauseReturn },
]);
const pausedB = next("fresh-advance-b", [
  { kind: "advance", steps: pauseB - pauseReturn },
]);
next("fresh-finish-b", [{ kind: "finish" }]);
const final = next("fresh-remove-b", [{ kind: "remove", carrier: "tray-b" }]);

function phaseOf(paused) {
  const operation = paused.checkpoint.operation;
  return operation.plan[operation.progress.nextPhase].name;
}
assert.equal(phaseOf(pausedA), "lift");
assert.equal(pausedA.checkpoint.operation.progress.pickup, true);
assert.ok(pausedA.checkpoint.operation.within.step > 0);
assert.equal(pausedA.sequence, 1);
assert.equal(phaseOf(pausedReturn), "return_traverse");
assert.ok(pausedReturn.checkpoint.operation.within.step > 0);
assert.equal(phaseOf(pausedB), "lift");
assert.equal(pausedB.checkpoint.operation.generation, 2);
assert.equal(pausedB.sequence, 2);

// One digest covers the world, the slot, the servo targets and the clock.
assert.equal(final.checkpoint.digest, whole.checkpoint.digest);
assert.deepEqual(
  final.checkpoint.integrationState,
  whole.checkpoint.integrationState,
);
const parts = steps.flatMap((step) => step.segments);
assertSameAttempt(whole.segments, parts, "attempt-a", [pauseA]);
assertSameAttempt(whole.segments, parts, "attempt-b", [pauseReturn, pauseB]);
for (const attempt of ["attempt-a", "attempt-b"])
  assert.equal(
    eventsOf(parts, attempt).filter((event) => event.kind === "pickup").length,
    1,
  );
// Each boundary change has the same before and after state in both runs.
const boundaries = steps
  .flatMap((step) => step.results)
  .filter((result) => result.kind === "admitted" || result.kind === "removed");
assert.deepEqual(
  boundaries.map((result) => [result.kind, result.before, result.after]),
  [admittedA, removedA, admittedB, removedB].map((result) => [
    result.kind,
    result.before,
    result.after,
  ]),
);

// 4. A boundary change writes the carrier body and nothing else. The arm and
//    the reference body keep their exact state across removal and admission.
assert.deepEqual(removedA.observation.arm, finishedA.observation.arm);
assert.deepEqual(admittedB.observation.arm, finishedA.observation.arm);
assert.deepEqual(
  removedA.observation.reference,
  finishedA.observation.reference,
);
assert.deepEqual(
  admittedB.observation.reference,
  finishedA.observation.reference,
);
assert.deepEqual(removedB.observation.arm, finishedB.observation.arm);
// One carrier body: active with one carrier, or parked with none.
const generations = [];
for (const result of [
  admittedA,
  finishedA,
  removedA,
  admittedB,
  finishedB,
  removedB,
]) {
  const { slot, tray, trayContacts } = result.observation;
  generations.push(slot.generation);
  if (slot.kind === "inactive") {
    assert.deepEqual(tray, PARKED);
    assert.deepEqual(trayContacts, []);
  } else assert.ok(tray[2] > 0.7);
}
assert.deepEqual(generations, [1, 1, 1, 2, 2, 2]);
assert.equal(admittedA.observation.slot.carrier, "tray-a");
assert.equal(admittedB.observation.slot.carrier, "tray-b");
// Tray B is admitted where tray A was, and placed where tray A was placed.
assert.deepEqual(admittedB.observation.tray, admittedA.observation.tray);
const placement = distance(
  finishedA.observation.tray,
  finishedB.observation.tray,
);
assert.ok(placement < 1e-4, `placements differ by ${placement} m`);
// The reference body settles onto the table once and then does not move.
const settled = finishedA.observation.reference;
const referenceDrift = {
  initialSettlingMetres: distance(admittedA.observation.reference, settled),
  afterSettlingMetres: distance(settled, removedB.observation.reference),
  afterSettlingDegrees: rotation(settled, removedB.observation.reference),
};
assert.ok(referenceDrift.initialSettlingMetres < 2e-4);
assert.ok(referenceDrift.afterSettlingMetres < 1e-6);
assert.ok(referenceDrift.afterSettlingDegrees < 1e-3);

// 5. An empty cell passes time with its slot parked: the inactive carrier
//    body neither moves nor touches anything.
const emptyIdle = cell("empty-idle", create(definition), [
  { kind: "advance", steps: 500 },
]);
assert.deepEqual(emptyIdle.observation.tray, PARKED);
assert.deepEqual(emptyIdle.observation.trayContacts, []);
assert.equal(emptyIdle.checkpoint.steps, 500);

// 6. Refused requests. None creates an output.
refuse("admitWhenOccupied", after(steps[0]), [
  { kind: "admit", carrier: "tray-x" },
]);
refuse("removeAnotherCarrier", after(steps[0]), [
  { kind: "remove", carrier: "tray-z" },
]);
refuse("removeWhileGripped", after(pausedA), [
  { kind: "remove", carrier: "tray-a" },
]);
refuse("startWhileRunning", after(pausedA), [
  { kind: "start", task: "table-to-rack", attemptId: "attempt-x" },
]);
refuse("startWithoutCarrier", create(definition), [
  { kind: "start", task: "table-to-rack", attemptId: "attempt-x" },
]);
refuse("removeFromEmptyCell", create(definition), [
  { kind: "remove", carrier: "tray-a" },
]);
const corrupt = structuredClone(steps[0]);
corrupt.checkpoint.integrationState[9] += 1e-9;
refuse("corruptState", after(corrupt), [{ kind: "advance", steps: 1 }]);
const rebound = structuredClone(emptied);
rebound.checkpoint.slot = { kind: "active", generation: 1, carrier: "tray-a" };
refuse("slotRewritten", after(rebound), [{ kind: "advance", steps: 1 }]);
const stale = structuredClone(pausedB);
stale.checkpoint.operation.generation = 1;
refuse("operationRewrittenForEarlierCarrier", after(stale), [
  { kind: "finish" },
]);
refuse("segmentNumberOnIdleCell", { ...after(emptied), sequence: 3 }, [
  { kind: "advance", steps: 1 },
]);
refuse("oneMillisecondCell", create({ ...definition, timestep: 0.001 }), [
  { kind: "advance", steps: 1 },
]);
refuse(
  "anotherBuild",
  create({
    ...definition,
    execution: { ...definition.execution, controllerHash: "0".repeat(64) },
  }),
  [{ kind: "advance", steps: 1 }],
);

// 7. Qualify the settled hold on each support. A hold keeps poses without
//    stepping; it is compared with ordinary 2 ms advancement of the same
//    state, and then by executing the next pickup from both.
function restsOn(observation, supports) {
  const contacts = observation.trayContacts.filter(
    (name) => !name.startsWith("mbco_tray"),
  );
  return (
    contacts.length === supports.length &&
    supports.every((name) => contacts.includes(name))
  );
}

function drift(from, to) {
  return {
    trayMillimetres: distance(from.tray, to.tray) * 1000,
    trayDegrees: rotation(from.tray, to.tray),
    referenceMillimetres: distance(from.reference, to.reference) * 1000,
    armRadians: Math.max(
      ...from.arm.map((angle, index) => Math.abs(angle - to.arm[index])),
    ),
  };
}

// Entry: one second observed with stable support, an open tool, speeds below
// 1e-4 m/s and 1e-4 rad/s and drift below 0.1 mm and 0.01 degrees.
function enterHold(name, state, supports, offered) {
  let before = state;
  for (let window = 1; window <= 5; window++) {
    const observed = cell(`${name}-observe-${window}`, after(before), [
      { kind: "advance", steps: 500 },
    ]);
    const moved = drift(before.observation, observed.observation);
    const moving = speed(observed.observation.traySpeed);
    if (
      restsOn(before.observation, supports) &&
      restsOn(observed.observation, supports) &&
      observed.observation.jawOpening > 0.02 &&
      moving.linear < 1e-4 &&
      moving.angular < 1e-4 &&
      moved.trayMillimetres < 0.1 &&
      moved.trayDegrees < 0.01 &&
      // The controller's own judgement of the same second must agree.
      observed.hold?.support === offered
    )
      return { entry: observed, windows: window, moved, moving };
    before = observed;
  }
  throw new Error(`${name} never met the hold entry criteria`);
}

// Limits a settled hold must meet against ordinary advancement. The arm and
// the reference body must stay put as well, which is all an empty cell has.
const HOLD_LIMITS = {
  trayMillimetres: 0.1,
  trayDegrees: 0.01,
  referenceMillimetres: 0.1,
  armRadians: 1e-4,
};

// Measures one support. A hold that fails a limit is reported as not
// qualified: its tray must keep advancing, and nothing here hides that.
function qualifyHold(name, state, supports, offered, nextPickup) {
  const { entry, windows, moved, moving } = enterHold(
    name,
    state,
    supports,
    offered,
  );
  const durations = [];
  let longest = entry;
  for (const seconds of HOLD_SECONDS) {
    const started = performance.now();
    const advanced = cell(`${name}-advance-${seconds}s`, after(entry), [
      { kind: "advance", steps: Math.round(seconds / TICK_SECONDS) },
    ]);
    const difference = drift(entry.observation, advanced.observation);
    durations.push({
      simulatedSeconds: seconds,
      steps: advanced.checkpoint.steps - entry.checkpoint.steps,
      wallSeconds: Math.round(performance.now() - started) / 1000,
      ...difference,
      trayDeltaMillimetres: [0, 1, 2].map(
        (axis) =>
          (advanced.observation.tray[axis] - entry.observation.tray[axis]) *
          1000,
      ),
      sameSupport: restsOn(advanced.observation, supports),
      withinLimits:
        restsOn(advanced.observation, supports) &&
        difference.trayMillimetres < HOLD_LIMITS.trayMillimetres &&
        difference.trayDegrees < HOLD_LIMITS.trayDegrees &&
        difference.referenceMillimetres < HOLD_LIMITS.referenceMillimetres &&
        difference.armRadians < HOLD_LIMITS.armRadians,
    });
    longest = advanced;
  }
  // The next pickup from the held state and from the advanced state.
  const held = cell(`${name}-pickup-held`, after(entry), nextPickup);
  const stepped = cell(`${name}-pickup-advanced`, after(longest), nextPickup);
  const [heldOutcome, steppedOutcome] = [held, stepped].map(
    (result) => result.results[result.results.length - 1],
  );
  assert.equal(heldOutcome.outcome.kind, "completed");
  const heldEvents = held.segments[0].events;
  const steppedEvents = stepped.segments[0].events;
  const sameEvents =
    JSON.stringify(steppedEvents.map((event) => [event.kind, event.label])) ===
    JSON.stringify(heldEvents.map((event) => [event.kind, event.label]));
  const placementDifference = drift(
    heldOutcome.observation,
    steppedOutcome.observation,
  );
  // The controller accepts a placement within 10 mm; both must agree closer.
  const equivalent =
    steppedOutcome.outcome.kind === "completed" &&
    sameEvents &&
    placementDifference.trayMillimetres < 1;
  return {
    supports,
    qualified:
      durations.every((duration) => duration.withinLimits) && equivalent,
    limits: HOLD_LIMITS,
    entry: { oneSecondWindows: windows, drift: moved, speed: moving },
    durations,
    nextPickup: {
      afterSimulatedSeconds: HOLD_SECONDS[HOLD_SECONDS.length - 1],
      heldOutcome: heldOutcome.outcome.kind,
      advancedOutcome: steppedOutcome.outcome,
      sameEvents,
      largestEventStepDifference: sameEvents
        ? Math.max(
            ...heldEvents.map((event, index) =>
              Math.abs(event.step - steppedEvents[index].step),
            ),
          )
        : null,
      placementDifference,
      equivalent,
    },
  };
}

const holds = {
  // Tray A rests on the rack; the arm has retracted and released it.
  rack: qualifyHold(
    "rack-hold",
    steps[2],
    ["rack_rail_left", "rack_rail_right"],
    "rack",
    [
      { kind: "remove", carrier: "tray-a" },
      { kind: "admit", carrier: "tray-b" },
      { kind: "start", task: "table-to-rack", attemptId: "attempt-b" },
      { kind: "finish" },
    ],
  ),
  // Tray B rests on the source table, admitted and not yet picked up.
  table: qualifyHold("table-hold", steps[4], ["table_top"], "table", [
    { kind: "start", task: "table-to-rack", attemptId: "attempt-b" },
    { kind: "finish" },
  ]),
  // Tray A has left; the cell holds no carrier and the arm waits at the rack.
  empty: qualifyHold("empty-hold", steps[3], [], "empty", [
    { kind: "admit", carrier: "tray-b" },
    { kind: "start", task: "table-to-rack", attemptId: "attempt-b" },
    { kind: "finish" },
  ]),
};

const report = {
  plan: "70B/70E — one persistent cell: admission, removal and carrier reuse",
  result: "passed",
  command: `node ${relative(root, fileURLToPath(import.meta.url))} <new directory>`,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  device: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0].model,
    node: process.version,
  },
  runner: {
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    execution: definition.execution,
  },
  journey: {
    actions: journey,
    steps: whole.checkpoint.steps,
    transferSteps: [finishedA.steps, finishedB.steps],
    returnMotion: startedB.plan.slice(1, 3),
    finalStateDigest: whole.checkpoint.digest,
    freshProcesses: steps.length,
    pauses: [
      { attempt: "attempt-a", step: pauseA, phase: phaseOf(pausedA) },
      { attempt: "attempt-b", step: pauseReturn, phase: phaseOf(pausedReturn) },
      { attempt: "attempt-b", step: pauseB, phase: phaseOf(pausedB) },
    ],
    placementDifferenceMetres: placement,
    referenceDrift,
  },
  rejections,
  holdSeconds: HOLD_SECONDS,
  holdQualification: {
    rack: holds.rack.qualified,
    table: holds.table.qualified,
    empty: holds.empty.qualified,
  },
  holds,
};
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
