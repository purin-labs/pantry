// Plan 70C C0: executes the recipe contract example through the production
// engine with no browser and no recipe-specific branch, then checks the six
// conditions the plan sets and the control commands a live run accepts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  admitScenario,
  advanceRun,
  drainStatus,
  interval,
  parseId,
  runResults,
  schedulingHistory,
  CAPACITY_CATEGORIES,
  startRun,
  submitCommand,
  timeFromSeconds,
} from "../../packages/production-simulation/src/index.ts";
import {
  CONTRACT_EXAMPLE,
  contractExampleAdapter,
  contractExampleSnapshot,
} from "../../packages/production-simulation/src/recipes/contract-example.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 3)
  throw new Error("Provide a new acceptance output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });

function save(name, value) {
  writeFileSync(join(output, name), `${canonicalJson(value)}\n`);
}

function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}

function at(seconds) {
  return value(timeFromSeconds(seconds));
}

function grams(amount) {
  return amount * 1000;
}

const identity = {
  runId: value(parseId("run", "plan-70c-contract-example")),
  executionId: value(parseId("execution", "headless-1")),
  hostSession: value(parseId("host-session", "headless-host-1")),
  bundle: null,
  parent: null,
};

async function admitted(values) {
  const snapshot = await contractExampleSnapshot(values, 1);
  return value(
    await admitScenario(value(contractExampleAdapter.compile(snapshot))),
  );
}

function events(run, kind) {
  const found = [];
  for (const event of run.events) if (event.kind === kind) found.push(event);
  return found;
}

function only(run, kind, matches) {
  const found = events(run, kind).filter(matches);
  assert.equal(found.length, 1, `${kind}: ${JSON.stringify(found)}`);
  return found[0];
}

function task(run, id) {
  for (const candidate of run.tasks) if (candidate.id === id) return candidate;
  throw new Error(`No task ${id}`);
}

function lot(run, id) {
  for (const candidate of run.lots) if (candidate.id === id) return candidate;
  throw new Error(`No lot ${id}`);
}

function reported(results, destination) {
  for (const entry of results.reported)
    if (entry.destination === destination) return entry;
  throw new Error(`No destination ${destination}`);
}

function whole(run) {
  return runResults(run, { after: null, through: run.position.time });
}

const definition = await admitted(CONTRACT_EXAMPLE);
const horizon = definition.scenario.limits.horizon;
const start = value(startRun(definition, identity, []));
assert.equal(start.status.kind, "ready");

// Baseline: one call to the horizon.
const run = advanceRun(start, horizon);
assert.equal(run.status.kind, "completed");
assert.equal(run.position.time, at(4_620));
assert.equal(drainStatus(run).kind, "drained");

// The same run in 60-second slices, each saved and read back between calls.
// Advancing continues from accepted state and reaches the identical result.
let sliced = start;
let slices = 0;
for (let until = 0; sliced.status.kind !== "completed"; until += 60) {
  sliced = advanceRun(JSON.parse(JSON.stringify(sliced)), at(until));
  slices += 1;
}
assert.equal(canonicalJson(sliced), canonicalJson(run));
for (const [index, event] of run.events.entries()) {
  assert.equal(event.sequence, index + 1);
  assert.ok(index === 0 || event.time >= run.events[index - 1].time);
  assert.equal(event.execution, identity.executionId);
}

// 1. The first ten portions are reserved and consumed from the one batch.
const firstBatch = "concentrate-batches#0/concentrate";
const secondBatch = "concentrate-batches#1/concentrate";
const consumed = { [firstBatch]: [], [secondBatch]: [] };
for (const event of events(run, "lot-consumed"))
  if (event.lot in consumed) consumed[event.lot].push(event);
assert.equal(consumed[firstBatch].length, 10);
for (const [index, event] of consumed[firstBatch].entries()) {
  assert.equal(event.task, `drink-orders#${index}/prepare-drink`);
  assert.deepEqual(event.quantity, { amount: grams(76), unit: "milligram" });
}
assert.equal(lot(run, firstBatch).remaining.amount, 0);
assert.equal(
  only(run, "lot-produced", (event) => event.lot === firstBatch).quantity
    .amount,
  grams(760),
);

// 2. Two orders wait, with their arrival times kept, until the second batch
//    releases usable material. Held concentrate fulfils no claim.
const waiting = advanceRun(start, at(4_200));
for (const [order, arrival] of [
  [10, 3_900],
  [11, 4_020],
]) {
  const instance = `drink-orders#${order}`;
  assert.equal(
    only(waiting, "instance-arrived", (event) => event.instance === instance)
      .time,
    at(arrival),
  );
  const state = task(waiting, `${instance}/prepare-drink`);
  assert.equal(state.kind, "waiting");
  assert.equal(state.since, at(arrival));
  assert.deepEqual(state.blockers, [
    {
      kind: "material",
      product: "sesame-concentrate",
      missing: { amount: grams(76), unit: "milligram" },
    },
  ]);
}
assert.equal(lot(waiting, secondBatch).disposition, "held");
assert.equal(lot(waiting, secondBatch).remaining.amount, grams(760));
assert.equal(lot(waiting, firstBatch).remaining.amount, 0);
save("waiting-for-second-batch.json", {
  time: waiting.position.time,
  tasks: waiting.tasks.filter((state) => state.kind === "waiting"),
  lots: waiting.lots.filter((state) => state.product === "sesame-concentrate"),
});

// 3. Those orders complete after the release, and material reconciles.
const release = only(run, "lot-released", (event) => event.lot === secondBatch);
assert.equal(release.time, at(4_500));
assert.equal(
  only(
    run,
    "task-started",
    (event) => event.task === "drink-orders#10/prepare-drink",
  ).time,
  at(4_500),
);
assert.equal(
  only(
    run,
    "task-started",
    (event) => event.task === "drink-orders#11/prepare-drink",
  ).time,
  at(4_560),
);
assert.equal(consumed[secondBatch].length, 2);
assert.equal(lot(run, secondBatch).remaining.amount, grams(608));
assert.equal(events(run, "order-completed").length, 12);
// Every product: initial stock plus production, less consumption, remains.
const initial = new Map();
for (const stock of definition.scenario.stock)
  initial.set(stock.product, stock.quantity.amount);
const balance = new Map(initial);
for (const event of events(run, "lot-produced"))
  balance.set(
    event.product,
    (balance.get(event.product) ?? 0) + event.quantity.amount,
  );
const products = new Map();
for (const state of run.lots) products.set(state.id, state.product);
for (const event of events(run, "lot-consumed")) {
  const product = products.get(event.lot);
  balance.set(product, balance.get(product) - event.quantity.amount);
}
const results = whole(run);
for (const stock of results.stock) {
  assert.equal(stock.remaining, balance.get(stock.product) ?? 0, stock.product);
  assert.ok(stock.remaining >= 0);
  assert.equal(stock.held, 0);
}
const stockOf = new Map();
for (const stock of results.stock) stockOf.set(stock.product, stock.remaining);
assert.equal(stockOf.get("sesame-concentrate"), grams(608));
assert.equal(stockOf.get("milk"), 0);

// 4. The roast cannot share the oven's bake although trays are free.
const baking = advanceRun(start, at(600));
const roast = task(baking, "sesame-roasts#0/roast");
assert.equal(roast.kind, "waiting");
assert.deepEqual(roast.blockers, [
  {
    kind: "configuration",
    resource: "oven",
    required: "sesame-roast",
    current: "financier-bake",
  },
]);
const oven = baking.resources.find((resource) => resource.id === "oven");
assert.deepEqual(
  oven.allocations.map((allocation) => [allocation.task, allocation.units]),
  [["financier-bakes#0/bake", 2]],
);
save("roast-waiting-for-configuration.json", {
  time: baking.position.time,
  roast,
  oven,
});

// 5. The changeover runs as its own task before the next configuration.
const changeover = task(run, "oven~1");
assert.deepEqual(changeover.subject, {
  kind: "changeover",
  resource: "oven",
  from: "financier-bake",
  to: "sesame-roast",
  cause: "sesame-roasts#0/roast",
});
assert.equal(changeover.startedAt, at(780));
assert.equal(changeover.completedAt, at(1_380));
const configured = only(run, "configuration-changed", () => true);
assert.equal(configured.time, at(1_380));
assert.equal(configured.task, "oven~1");
assert.equal(
  only(run, "task-started", (event) => event.task === "sesame-roasts#0/roast")
    .time,
  at(1_380),
);
assert.equal(
  only(run, "task-started", (event) => event.task === "oven~1").time,
  at(780),
);
// While it ran, the changeover held the whole oven.
const changing = advanceRun(start, at(1_000));
assert.deepEqual(
  changing.resources.find((resource) => resource.id === "oven").allocations,
  [{ task: "oven~1", units: 5, kind: "occupied", since: at(780) }],
);

// 6. Twelve completed orders and their drinks are final output. Concentrate
//    is intermediate production, and none of it counts as a finished drink.
assert.equal(results.ordersCompleted, 12);
assert.equal(results.orders.length, 12);
for (const order of results.orders) assert.equal(order.kind, "completed");
assert.deepEqual(
  results.orders.map((order) => order.leadTime / 1_000_000),
  [60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 660, 600],
);
const drinks = reported(results, "drinks-served");
assert.deepEqual(
  [drinks.role, drinks.unit, drinks.amount],
  ["final-output", "each", 12],
);
const concentrate = reported(results, "concentrate-made");
assert.deepEqual(
  [concentrate.role, concentrate.unit, concentrate.amount],
  ["intermediate-stock", "milligram", grams(1_520)],
);
assert.equal(reported(results, "concentrate-process-loss").amount, grams(4));
for (const entry of results.reported)
  if (entry.role === "final-output")
    assert.equal(entry.product, "sesame-drink");
// An interval counts only what crossed its boundary inside it.
const early = runResults(run, { after: null, through: at(3_000) });
assert.equal(early.ordersCompleted, 3);
assert.equal(reported(early, "drinks-served").amount, 3);
const late = runResults(run, { after: at(3_000), through: at(4_620) });
assert.equal(late.ordersCompleted, 9);
assert.equal(reported(late, "concentrate-made").amount, 0);
const ovenUsage = results.resources.find(resourceNamed.bind(null, "oven"));
assert.equal(ovenUsage.capacityUnitSeconds, 5 * 4_620);
assert.equal(ovenUsage.changeoverUnitSeconds, 5 * 600);
const clippedChangeover = runResults(run, {
  after: at(1_000),
  through: at(1_100),
}).resources.find(resourceNamed.bind(null, "oven"));
assert.equal(clippedChangeover.changeoverUnitSeconds, 500);
assert.equal(clippedChangeover.unallocatedUnitSeconds, 0);
assert.equal(clippedChangeover.claimedShare, 1);
function resourceNamed(name, resource) {
  return resource.resource === name;
}

// Control commands on a live run.
function command(live, kind, id, fields = {}, target = {}) {
  return {
    commandId: value(parseId("command", id)),
    runId: live.identity.runId,
    executionId: live.identity.executionId,
    hostSession: live.identity.hostSession,
    expectedControlRevision: live.position.controlRevision,
    kind,
    ...fields,
    ...target,
  };
}
const receipts = {};
function refuse(live, name, candidate, reason) {
  const result = submitCommand(live, candidate);
  assert.equal(result.receipt.status, "rejected", name);
  assert.equal(result.receipt.reason, reason, name);
  assert.equal(result.run, live, `${name} must not change the run`);
  receipts[name] = result.receipt;
}
function accept(live, name, candidate) {
  const result = submitCommand(live, candidate);
  assert.equal(result.receipt.status, "accepted", name);
  receipts[name] = result.receipt;
  return result;
}
const orders = value(parseId("arrival-source", "drink-orders"));
const batches = value(parseId("arrival-source", "concentrate-batches"));
const baker = value(parseId("resource", "baker"));

// A. Close arrivals while one arrived order still waits for material. It
//    stays eligible and completes; no later order is created.
const congested = advanceRun(start, at(3_950));
assert.equal(task(congested, "drink-orders#10/prepare-drink").kind, "waiting");
const close = command(congested, "close-arrivals", "close-drink-orders", {
  source: orders,
});
refuse(
  congested,
  "staleControlRevision",
  { ...close, expectedControlRevision: 5 },
  "stale_control_revision",
);
refuse(
  congested,
  "anotherExecution",
  { ...close, executionId: value(parseId("execution", "headless-2")) },
  "wrong_execution",
);
refuse(
  congested,
  "obsoleteHostSession",
  { ...close, hostSession: value(parseId("host-session", "earlier-host")) },
  "wrong_host_session",
);
refuse(
  congested,
  "unknownSource",
  { ...close, source: value(parseId("arrival-source", "walk-ins")) },
  "unknown_target",
);
const closing = accept(congested, "closeArrivals", close);
// The receipt returns before the run finishes and names its effective tick.
assert.equal(closing.run.status.kind, "advancing");
assert.equal(closing.receipt.effectiveAt, congested.position.time + 2_000);
assert.equal(closing.receipt.controlRevision, 1);
// Redelivery returns the first receipt and changes nothing.
const redelivered = submitCommand(closing.run, close);
assert.deepEqual(redelivered.receipt, closing.receipt);
assert.equal(redelivered.run, closing.run);
refuse(
  closing.run,
  "conflictingPayload",
  { ...close, source: batches },
  "conflicting_payload",
);
const closed = advanceRun(closing.run, horizon);
assert.equal(closed.status.kind, "completed");
assert.equal(drainStatus(closed).kind, "drained");
assert.equal(only(closed, "arrivals-closed", () => true).source, orders);
assert.equal(events(closed, "instance-arrived").filter(isOrder).length, 11);
const closedResults = whole(closed);
assert.equal(closedResults.ordersCompleted, 11);
assert.equal(closedResults.orders[10].arrivedAt, at(3_900));
assert.equal(closedResults.orders[10].leadTime, at(660));
assert.equal(reported(closedResults, "drinks-served").amount, 11);

// B. Withhold the baker. Work already executing completes; no task that
//    claims the baker starts inside the interval, and the queue drains after.
const before = advanceRun(start, at(2_000));
refuse(
  before,
  "insideAcceptedHistory",
  command(before, "withhold-resource", "withhold-earlier", {
    resource: baker,
    interval: value(interval(at(1_000), at(1_300))),
  }),
  "inside_accepted_history",
);
const withholding = accept(
  before,
  "withholdBaker",
  command(before, "withhold-resource", "withhold-baker", {
    resource: baker,
    interval: value(interval(at(2_700), at(3_000))),
  }),
);
const withheld = advanceRun(withholding.run, horizon);
assert.equal(withheld.status.kind, "completed");
assert.equal(
  only(
    withheld,
    "task-completed",
    (event) => event.task === "concentrate-batches#1/prepare",
  ).time,
  at(2_700),
);
for (const event of events(withheld, "task-started"))
  if (event.task.endsWith("/prepare-drink"))
    assert.ok(event.time < at(2_700) || event.time >= at(3_000), event.task);
assert.deepEqual(
  events(withheld, "availability-changed").map((event) => [
    event.time / 1_000_000,
    event.available,
    event.cause,
  ]),
  [
    [2_700, false, "withhold-baker"],
    [3_000, true, "withhold-baker"],
  ],
);
const withheldResults = whole(withheld);
assert.equal(withheldResults.ordersCompleted, 12);
assert.equal(withheldResults.orders[0].leadTime, at(360));
assert.equal(lot(withheld, secondBatch).remaining.amount, grams(608));
const overlapping = accept(
  withholding.run,
  "overlappingWithhold",
  command(withholding.run, "withhold-resource", "withhold-baker-overlap", {
    resource: baker,
    interval: value(interval(at(2_600), at(2_900))),
  }),
);
const overlappingRun = advanceRun(overlapping.run, horizon);
const overlappingUsage = whole(overlappingRun).resources.find(
  resourceNamed.bind(null, "baker"),
);
assert.equal(
  overlappingUsage.withheldUnitSeconds,
  400,
  "Overlapping withholding counts once",
);
const activeDuringWithholding = runResults(overlappingRun, {
  after: at(2_600),
  through: at(2_700),
}).resources.find(resourceNamed.bind(null, "baker"));
assert.equal(
  activeDuringWithholding.occupiedUnitSeconds,
  100,
  "Withholding does not interrupt admitted work",
);
assert.equal(activeDuringWithholding.withheldUnitSeconds, 100);
assert.equal(activeDuringWithholding.unallocatedUnitSeconds, 0);
save("resource-history.json", {
  ovenUsage,
  clippedChangeover,
  overlappingUsage,
  activeDuringWithholding,
});

// Classify simultaneous capacity claims, configuration queues and material waits.
const scheduling = results.schedulingHistory;
assert.equal(scheduling.kind, "available");
const ovenStates = schedulingHistory(run, {
  after: at(100),
  through: at(200),
}).resources.find(resourceNamed.bind(null, "oven"));
assert.equal(ovenStates.unitSeconds.running, 200);
assert.equal(ovenStates.unitSeconds.blocked, 100);
assert.equal(ovenStates.unitSeconds.idle, 200);
const mixerStates = scheduling.resources.find(
  resourceNamed.bind(null, "heated-mixer"),
);
assert.equal(mixerStates.unitSeconds.starved, 600);
const materialWaits = scheduling.waits.filter(isMaterialWait);
assert.deepEqual(materialWaits.map(waitBounds), [
  ["drink-orders#10/prepare-drink", at(3900), at(4500)],
  ["drink-orders#11/prepare-drink", at(4020), at(4500)],
]);
assert.equal(materialWaits.reduce(sumWaitSeconds, 0), 1080);
const overlappingStates = schedulingHistory(overlappingRun, {
  after: at(2600),
  through: at(3000),
}).resources.find(resourceNamed.bind(null, "baker"));
assert.equal(overlappingStates.unitSeconds.running, 100);
assert.equal(overlappingStates.unitSeconds.unavailable, 300);
assert.equal(overlappingStates.unitSeconds.starved, 0);
assert.deepEqual(
  schedulingHistory(sliced, { after: null, through: sliced.position.time }),
  scheduling,
);
for (const resource of scheduling.resources) {
  let total = 0;
  for (const kind of CAPACITY_CATEGORIES) total += resource.unitSeconds[kind];
  assert.equal(total, (resource.capacity * run.position.time) / 1_000_000);
}
const zeroScheduling = schedulingHistory(run, {
  after: at(100),
  through: at(100),
});
assert.equal(zeroScheduling.waits.length, 0);
for (const resource of zeroScheduling.resources) {
  assert.equal(resource.intervals.length, 0);
  for (const kind of CAPACITY_CATEGORIES)
    assert.equal(resource.unitSeconds[kind], 0);
}
save("scheduling-history.json", {
  scheduling,
  ovenStates,
  overlappingStates,
  zeroScheduling,
});

function isMaterialWait(wait) {
  return wait.blockers.some(materialBlocker);
}
function materialBlocker(blocker) {
  return blocker.kind === "material";
}
function waitBounds(wait) {
  return [wait.task, wait.start, wait.end];
}
function sumWaitSeconds(total, wait) {
  return total + (wait.end - wait.start) / 1_000_000;
}

// C. Pause stops advancement at a boundary; resume continues the same run.
const midway = advanceRun(start, at(3_000));
const pausing = accept(midway, "pause", command(midway, "pause", "pause-1"));
assert.deepEqual(pausing.run.status, {
  kind: "paused",
  command: "pause-1",
  boundary: midway.position.time,
});
assert.equal(advanceRun(pausing.run, horizon), pausing.run);
refuse(
  pausing.run,
  "pauseWhilePaused",
  command(pausing.run, "pause", "pause-2"),
  "already_paused",
);
const resuming = accept(
  pausing.run,
  "resume",
  command(pausing.run, "resume", "resume-1"),
);
const resumed = advanceRun(resuming.run, horizon);
assert.equal(resumed.status.kind, "completed");
assert.equal(resumed.position.time, run.position.time);
assert.deepEqual(whole(resumed).reported, results.reported);
assert.deepEqual(whole(resumed).orders, results.orders);
refuse(
  resumed,
  "commandAfterCompletion",
  command(resumed, "pause", "pause-3"),
  "run_finished",
);

// D. A run stops at its horizon with unfinished work and persistent state.
//    Extending the horizon continues it to the baseline result.
const shortDefinition = await admitted({
  ...CONTRACT_EXAMPLE,
  horizonSeconds: 3_000,
});
const stopped = advanceRun(
  value(startRun(shortDefinition, identity, [])),
  horizon,
);
assert.equal(stopped.status.kind, "stopped-at-limit");
assert.equal(stopped.status.limit, "horizon");
assert.ok(stopped.status.unfinished.length > 0);
assert.equal(stopped.position.time, at(3_000));
assert.equal(advanceRun(stopped, horizon), stopped);
refuse(
  stopped,
  "horizonNotExtended",
  command(stopped, "extend-horizon", "extend-0", { horizon: at(3_000) }),
  "horizon_not_extended",
);
const extending = accept(
  stopped,
  "extendHorizon",
  command(stopped, "extend-horizon", "extend-1", { horizon }),
);
const extended = advanceRun(extending.run, horizon);
assert.equal(extended.status.kind, "completed");
assert.equal(extended.position.time, run.position.time);
assert.deepEqual(whole(extended).reported, results.reported);
assert.deepEqual(whole(extended).orders, results.orders);

save("scenario.json", definition.scenario);
save("events.json", run.events);
save("final-state.json", run);
save("results.json", results);
save("early-close-results.json", closedResults);
save("withheld-baker-results.json", withheldResults);
save("receipts.json", receipts);
save("report.json", {
  plan: "70C C0 — recipe composition through the production engine",
  result: "passed",
  command: `node ${relative(root, fileURLToPath(import.meta.url))} <new directory>`,
  node: process.version,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  engineSourceDigest: engineSourceDigest(),
  definitionDigest: definition.digest,
  baseline: {
    status: run.status,
    events: run.events.length,
    slicesWithIdenticalResult: slices,
    ordersCompleted: results.ordersCompleted,
    leadTimesSeconds: results.orders.map((order) => order.leadTime / 1_000_000),
    reported: results.reported,
    stock: results.stock,
    changeover: {
      task: changeover.id,
      startedAtSeconds: changeover.startedAt / 1_000_000,
      completedAtSeconds: changeover.completedAt / 1_000_000,
    },
  },
  commands: {
    earlyClose: {
      closedAtSeconds: closing.receipt.effectiveAt / 1_000_000,
      ordersArrived: closedResults.orders.length,
      ordersCompleted: closedResults.ordersCompleted,
    },
    withheldBaker: {
      intervalSeconds: [2_700, 3_000],
      firstOrderLeadTimeSeconds: withheldResults.orders[0].leadTime / 1_000_000,
      ordersCompleted: withheldResults.ordersCompleted,
    },
    horizon: {
      stoppedAtSeconds: stopped.position.time / 1_000_000,
      unfinishedTasks: stopped.status.unfinished.length,
      completedAfterExtension: extended.status.kind === "completed",
    },
    receipts: Object.fromEntries(
      Object.entries(receipts).map(([name, receipt]) => [
        name,
        receipt.status === "accepted" ? "accepted" : receipt.reason,
      ]),
    ),
  },
});
console.log(
  `Contract example executed: ${run.events.length} events, ${results.ordersCompleted} orders; artifact in ${output}`,
);

function isOrder(event) {
  return event.source === "drink-orders";
}

// The package is not yet versioned; its tracked and untracked sources are.
function engineSourceDigest() {
  const directory = join(root, "packages/production-simulation/src");
  const hash = createHash("sha256");
  const files = readdirSync(directory, { recursive: true }).sort();
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(directory, file)));
  }
  return hash.digest("hex");
}
