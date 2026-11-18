// Refactor 16, step 4: a cached physics result equals a fresh one.
//
//   node --expose-gc scripts/production-simulation/verify-physics-result-cache.mjs NEW_OUTPUT_DIRECTORY
//     [--scenario two-cell|orders-24] [--runtime BUNDLE_DIRECTORY]
//
// Each run goes through the production engine of the current source and the
// Wasm build of the runtime bundle, as the Portal worker runs it. The cache is
// cachedTransport (packages/production-simulation/src/native/result-cache.ts)
// over a memory level and a directory level.
//
//  1. S fresh: the scenario with no cache. This is the reference.
//  2. S cold: the same scenario with an empty cache. It computes every call
//     and stores each result.
//  3. S warm: again with the cache. Every result must come from the cache,
//     and the run must equal run 1: the results, the event history, the
//     final world, every recorded sample, contact and event by step, and the
//     bytes of each operation recording.
//  4. S' fresh: one late input changes. The last order arrives 30 s after
//     the time its first task started in run 1, so its work starts later.
//  5. S' warm: the edited scenario with the cache of runs 2 and 3. It must
//     equal run 4. Each operation that ends before that start time comes
//     from the cache; only operations that end after it are computed.
//  6. S‴ fresh and S‴ warm: the last order arrives in the middle of an
//     operation of an earlier order. Its arrival cuts that operation's
//     segment at another step, so the cache restores a cell inside an
//     operation. The run must equal its fresh run.
//  7. S'' fresh and S'' warm: the first order arrives later, so the first
//     operation starts from another cell state. No operation may come from the
//     cache, and the run must equal its fresh run.
//  8. S disk: a new memory level over the directory level that runs 2–5
//     wrote, as a new process opens it. Every result comes from the disk,
//     and the run equals run 1.
//
// "Run draft" in the Portal runs the applied scenario and the draft from
// zero. Without the cache it costs runs 1 + 4; with the cache it costs runs
// 2 + 5. The report writes both.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import {
  phase1Scenario,
  runFingerprints,
  runToEnd,
} from "./phase-1-scenarios.mjs";
import { directoryResultFiles } from "./result-files-directory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
let runtime = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
let scenarioName = "two-cell";
let output = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--runtime") runtime = resolve(args[++index]);
  else if (args[index] === "--scenario") scenarioName = args[++index];
  else if (output === null) output = resolve(args[index]);
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(output !== null, "Provide a new output directory");
assert.ok(
  scenarioName === "two-cell" || scenarioName === "orders-24",
  "Choose --scenario two-cell or orders-24",
);
assert.ok(!existsSync(output), "Choose a new output directory");
mkdirSync(output, { recursive: true });

const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const MEMORY_BYTES = 1024 * 1024 * 1024;
const DISK_BYTES = 8 * 1024 * 1024 * 1024;

/** The last order arrives at `time` (microseconds) instead. */
function moveLastOrder(scenario, time) {
  const edited = structuredClone(scenario);
  const source = edited.arrivals.at(-1);
  if (source.kind === "explicit") {
    const last = source.arrivals.at(-1);
    assert.ok(time > last.time, "The last order arrives later");
    if (last.quantity > 1) {
      last.quantity -= 1;
      source.arrivals.push({ time, quantity: 1 });
    } else last.time = time;
    return edited;
  }
  assert.equal(
    source.kind,
    "periodic",
    "An arrival source is explicit or periodic",
  );
  assert.equal(source.limit.kind, "count");
  const count = source.limit.count;
  assert.ok(time > source.first + (count - 1) * source.interval);
  source.limit = { kind: "count", count: count - 1 };
  edited.arrivals.push({
    id: `${source.id}-late`,
    workflow: source.workflow,
    kind: "explicit",
    arrivals: [{ time, quantity: 1 }],
  });
  return edited;
}

/** The time of the last arrival the scenario declares. */
function lastArrival(scenario) {
  let time = 0;
  for (const source of scenario.arrivals)
    if (source.kind === "explicit")
      for (const arrival of source.arrivals)
        time = Math.max(time, arrival.time);
    else
      time = Math.max(
        time,
        source.first + (source.limit.count - 1) * source.interval,
      );
  return time;
}

/** When the last order to arrive started its first task. */
function lastOrderStart(events) {
  let instance = null;
  for (const event of events)
    if (event.kind === "instance-arrived") instance = event.instance;
  let start = Infinity;
  for (const event of events)
    if (event.kind === "task-started" && event.task.startsWith(`${instance}/`))
      start = Math.min(start, event.time);
  assert.ok(Number.isFinite(start), "The last order started");
  return { instance, start };
}

/** Every order arrives `delay` microseconds later. */
function delayEveryOrder(scenario, delay) {
  const edited = structuredClone(scenario);
  for (const source of edited.arrivals)
    if (source.kind === "explicit")
      for (const arrival of source.arrivals) arrival.time += delay;
    else source.first += delay;
  return edited;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};
// One Wasm module for the whole journey, as one Portal worker keeps one.
const module = await runtimeModule(runtime);
const text = E.wasmTextTransport(module, codec);
const plain = E.parsedTransport(text);
const namespace = BAKERY_BROWSER_BUNDLE.id;
const diskDirectory = join(output, "results");
let memory = E.memoryResultStore(MEMORY_BYTES);
let disk = await E.packedResultStore(
  await directoryResultFiles(diskDirectory),
  DISK_BYTES,
);
let cached = E.cachedTransport(
  text,
  E.tieredResultStore([memory, disk]),
  namespace,
);

const runs = {};
const histories = {};
let sequence = 0;
async function run(label, scenario, transport) {
  sequence += 1;
  if (transport === cached) cached.reset();
  const result = await runToEnd(
    E,
    transport,
    built.manifest.bundle,
    scenario,
    `${scenarioName}-${sequence}`,
  );
  histories[label] = {
    events: result.state.run.events,
    attempts: attemptTimes(result.state.run.events),
  };
  const prints = await runFingerprints(E, result);
  globalThis.gc?.();
  runs[label] = {
    status: result.view.status.kind,
    ordersCompleted: prints.results.ordersCompleted,
    events: result.state.run.events.length,
    simulatedSeconds: result.state.run.position.time / 1e6,
    beginMs: Math.round(result.beginMs),
    driveMs: Math.round(result.driveMs),
    fingerprint: prints.fingerprint,
    recorded: prints.recorded,
    segments: prints.segments,
    recordingBytes: prints.recordingBytes,
    ...(transport === cached
      ? { cache: cached.counts(), operations: [...cached.operations()] }
      : {}),
  };
  const { operations: _operations, ...shown } = runs[label];
  console.log(label, JSON.stringify(shown));
  writeFileSync(
    join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return runs[label];
}

/** The logical times of the events of each attempt, by controller identity. */
function attemptTimes(events) {
  const times = new Map();
  for (const event of events) {
    const attempt = event.attempt;
    if (
      (event.kind !== "task-started" && event.kind !== "task-completed") ||
      typeof attempt !== "string"
    )
      continue;
    const native = E.nativeIdentity(attempt);
    const known = times.get(native) ?? { first: event.time, last: event.time };
    known.first = Math.min(known.first, event.time);
    known.last = Math.max(known.last, event.time);
    times.set(native, known);
  }
  return times;
}

function assertSame(label, left, right) {
  assert.equal(left.status, right.status, `${label}: status`);
  assert.equal(
    left.fingerprint,
    right.fingerprint,
    `${label}: results, history and world`,
  );
  assert.deepEqual(left.recorded, right.recorded, `${label}: recorded physics`);
  assert.deepEqual(
    left.segments,
    right.segments,
    `${label}: operation recording bytes`,
  );
}

const report = {
  plan: "Refactor 16 step 4: physics result cache",
  command: `node --expose-gc ${relative(root, fileURLToPath(import.meta.url))} ${args.join(" ")}`,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  device: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0].model,
    node: process.version,
  },
  runtime: relative(root, runtime),
  executionBundle: built.manifest.bundle.id,
  scenario: scenarioName,
  runs,
  checks: [],
};

function check(name, detail) {
  report.checks.push({ name, ...detail });
  console.log(`pass: ${name}`, JSON.stringify(detail));
}

const base = await phase1Scenario(E, runtime, scenarioName);
const early = {
  cells: base.cells,
  scenario: delayEveryOrder(base.scenario, 5_000_000),
};

// 1–3: the same scenario, fresh, cold and warm.
const fresh = await run("S fresh", base, plain);
const change = lastOrderStart(histories["S fresh"].events);
const edited = {
  cells: base.cells,
  scenario: moveLastOrder(base.scenario, change.start + 30_000_000),
};
report.edits = {
  late: `the last order (${change.instance}) arrives at ${(change.start + 30_000_000) / 1e6} s; it started at ${change.start / 1e6} s`,
  early: "every order arrives 5 s later",
};
const cold = await run("S cold", base, cached);
assertSame("S cold", cold, fresh);
assert.equal(cold.cache.hits, 0, "An empty cache has no hit");
check("An empty cache changes no result", {
  misses: cold.cache.misses,
  operationsComputed: cold.cache.operationsComputed,
});
const warm = await run("S warm", base, cached);
assertSame("S warm", warm, fresh);
assert.equal(warm.cache.misses, 0, "A repeated run computes nothing");
assert.equal(warm.cache.operationsComputed, 0);
assert.ok(warm.cache.operationsReused > 0);
check("A cached run equals a fresh run, sample for sample", {
  hits: warm.cache.hits,
  operationsReused: warm.cache.operationsReused,
  recordedEntries: warm.recorded.entries,
  operationRecordings: warm.segments.count,
});

/**
 * Runs an edited scenario fresh and with the cache, and checks that they are
 * equal and that each operation that ended before `change` was reused.
 */
async function verifyEdit(label, scenario, change) {
  const editedFresh = await run(`${label} fresh`, scenario, plain);
  assert.notEqual(
    editedFresh.fingerprint,
    fresh.fingerprint,
    "The edit changes the run",
  );
  const editedWarm = await run(`${label} warm`, scenario, cached);
  assertSame(`${label} warm`, editedWarm, editedFresh);
  const times = histories[`${label} warm`].attempts;
  let endedBefore = 0;
  for (const operation of editedWarm.operations) {
    const span = times.get(operation.attempt);
    assert.ok(span !== undefined, `Operation ${operation.attempt} has events`);
    if (span.last >= change) continue;
    endedBefore += 1;
    assert.equal(
      operation.computed,
      false,
      `${operation.attempt} ended before the edit took effect`,
    );
  }
  assert.ok(endedBefore > 0, "Some operations end before the edit");
  assert.ok(editedWarm.cache.operationsComputed > 0, "The edit is computed");
  return { editedFresh, editedWarm };
}

// 4–5: one late input changes.
const { editedFresh, editedWarm } = await verifyEdit(
  "S'",
  edited,
  change.start,
);
check(
  "After one late edit, only the operations after the change are computed",
  {
    changeSeconds: change.start / 1e6,
    operationsReused: editedWarm.cache.operationsReused,
    operationsComputed: editedWarm.cache.operationsComputed,
    hits: editedWarm.cache.hits,
    misses: editedWarm.cache.misses,
    restores: editedWarm.cache.restores,
    replays: editedWarm.cache.replays,
  },
);

// 6: the arrival cuts an operation in progress.
const last = lastArrival(base.scenario);
const spans = [...histories["S fresh"].attempts.values()]
  .filter((span) => span.first > last && span.last - span.first > 2_000_000)
  .sort((left, right) => left.first - right.first);
assert.ok(spans.length > 0, "An operation starts after the last arrival");
const inside = spans[Math.floor(spans.length / 2)];
const middle = Math.round((inside.first + inside.last) / 2_000) * 1_000;
const cut = await verifyEdit(
  "S‴",
  { cells: base.cells, scenario: moveLastOrder(base.scenario, middle) },
  middle,
);
assert.ok(
  cut.editedWarm.cache.restoresInOperation > 0,
  "A cell is restored inside an operation",
);
report.edits.inside = `the last order arrives at ${middle / 1e6} s, inside an operation from ${inside.first / 1e6} s to ${inside.last / 1e6} s`;
check("A restore inside an operation gives the fresh result", {
  arrivalSeconds: middle / 1e6,
  operationsReused: cut.editedWarm.cache.operationsReused,
  operationsComputed: cut.editedWarm.cache.operationsComputed,
  restoresInOperation: cut.editedWarm.cache.restoresInOperation,
});

// 7: another start state must miss.
const earlyFresh = await run("S'' fresh", early, plain);
const earlyWarm = await run("S'' warm", early, cached);
assertSame("S'' warm", earlyWarm, earlyFresh);
assert.equal(
  earlyWarm.cache.operationsReused,
  0,
  "No operation starts from a stored state",
);
check("An operation from another start state misses", {
  operationsComputed: earlyWarm.cache.operationsComputed,
  hits: earlyWarm.cache.hits,
  misses: earlyWarm.cache.misses,
});

// 8: the directory level alone, as a new process opens it.
await disk.flush();
memory = E.memoryResultStore(MEMORY_BYTES);
disk = await E.packedResultStore(
  await directoryResultFiles(diskDirectory),
  DISK_BYTES,
);
cached = E.cachedTransport(
  text,
  E.tieredResultStore([memory, disk]),
  namespace,
);
const fromDisk = await run("S disk", base, cached);
assertSame("S disk", fromDisk, fresh);
assert.equal(fromDisk.cache.misses, 0);
check("The directory level serves a new process", {
  hits: fromDisk.cache.hits,
  diskBytes: disk.bytes(),
});

report.runTimeAfterOneEdit = {
  beforeMs: editedFresh.driveMs,
  afterMs: editedWarm.driveMs,
};
report.runDraft = {
  beforeMs: fresh.driveMs + editedFresh.driveMs,
  afterMs: cold.driveMs + editedWarm.driveMs,
};
report.passed = true;
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    runTimeAfterOneEdit: report.runTimeAfterOneEdit,
    runDraft: report.runDraft,
  }),
);
