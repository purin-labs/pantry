// Plan 70 J1: the production engine drives one persistent cold cell. Two
// orders each carry a tray in, have the arm rack it and carry it out. The
// journey runs once without interruption, then again through five native
// host processes: it is paused, saved and its host destroyed four times,
// twice inside a controller phase, and each time a fresh process continues
// it under a new execution identity. Both runs must end in the same state.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  CELL_CHECKPOINT_SCHEMA_VERSION,
  RECORDING_PACK_TARGET_BYTES,
  RECORDING_PACK_SCHEMA_VERSION,
  packRecordings,
  parseExecutionBundle,
  parseExecutionManifest,
  parseId,
  unpackRecordings,
  resolveExecution,
  timeFromSeconds,
} from "../../packages/production-simulation/src/index.ts";
import * as currentEngine from "../../packages/production-simulation/src/execution-entry.ts";
import {
  ENGINE_FILE,
  MANIFEST_FILE,
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import {
  coldCellJourneyAdapter,
  coldCellJourneySnapshot,
} from "../../packages/production-simulation/src/recipes/cold-cell-journey.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
if (process.argv.length !== 3)
  throw new Error("Provide a new acceptance output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(join(output, "artifacts"), { recursive: true });
// With a browser runtime bundle the journey runs through its Wasm build and
// through retained execution bundles; otherwise through the native runner.
const runtimeDirectory =
  process.env.PLAN_70_BROWSER_BUNDLE === undefined
    ? null
    : resolve(process.env.PLAN_70_BROWSER_BUNDLE);
const backend = runtimeDirectory === null ? "headless" : "browser";
const retainedDirectory = join(output, "executions");
// The engine this host calls. The headless journey calls its own source. A
// browser host calls only the retained module its bundle or saved run names.
let E = currentEngine;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function save(name, value) {
  writeFileSync(join(output, name), `${canonicalJson(value)}\n`, {
    flag: "wx",
  });
}

function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}

function id(kind, literal) {
  return value(parseId(kind, literal));
}

// One native process that keeps cells resident and answers one command per
// line. Destroying it loses every world it holds.
// Advances are timed apart from the commands that load a model or plan.
function timed(transport) {
  const timing = { commands: 0, milliseconds: 0, operations: {} };
  return {
    timing,
    transport: {
      async send(command) {
        const started = performance.now();
        const reply = await transport.send(command);
        const taken = performance.now() - started;
        timing.commands += 1;
        timing.milliseconds += taken;
        const operation = (timing.operations[command.op] ??= {
          commands: 0,
          milliseconds: 0,
          slowest: 0,
          samples: [],
        });
        operation.commands += 1;
        operation.milliseconds += taken;
        operation.samples.push(taken);
        if (taken > operation.slowest) operation.slowest = taken;
        return reply;
      },
    },
  };
}

function latency(timing) {
  const summary = {};
  for (const [name, operation] of Object.entries(timing.operations)) {
    const sorted = operation.samples.toSorted((left, right) => left - right);
    summary[name] = {
      commands: operation.commands,
      meanMilliseconds: operation.milliseconds / operation.commands,
      p95Milliseconds: sorted[Math.ceil(sorted.length * 0.95) - 1],
      slowestMilliseconds: operation.slowest,
    };
  }
  return summary;
}

// One fresh instance of the Wasm module stands for one browser worker.
// Dropping it loses every world it holds, as terminating a worker does.
async function wasmHost() {
  const codec = {
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    encode(text) {
      return this.encoder.encode(text);
    },
    decode(bytes) {
      return this.decoder.decode(bytes);
    },
  };
  const module = await runtimeModule(runtimeDirectory);
  return {
    ...timed(E.wasmTransport(module, codec)),
    async close() {},
    async destroy() {},
  };
}

async function physicsHost(name) {
  return backend === "browser" ? wasmHost() : nativeHost(name);
}

function nativeHost(name) {
  const child = spawn(
    binary,
    ["--root", root, "--output", join(output, `${name}-closing.json`), "serve"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const waiting = [];
  createInterface({ input: child.stdout }).on("line", (line) =>
    waiting.shift()?.resolve(JSON.parse(line)),
  );
  child.on("exit", () => {
    for (const exchange of waiting.splice(0))
      exchange.reject(new Error("The native host exited"));
  });
  return {
    ...timed({
      send(command) {
        return new Promise((resolve, reject) => {
          waiting.push({ resolve, reject });
          child.stdin.write(`${JSON.stringify(command)}\n`);
        });
      },
    }),
    async close() {
      child.stdin.end();
      await once(child, "exit");
    },
    async destroy() {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

// The cell's world definition, pinned by the runner to its own build.
const definitionFile = join(output, "cell-definition.json");
if (backend === "browser")
  writeFileSync(
    definitionFile,
    JSON.stringify(await prepareCell(runtimeDirectory, "cold-cell-1")),
  );
else
  execFileSync(binary, [
    "--root",
    root,
    "--output",
    definitionFile,
    "prepare-cell",
    "--cell",
    "cold-cell-1",
  ]);

// --- Retained execution bundles (browser backend) ---------------------------
// Every retained manifest, read from disk and checked against its identity.
async function retainedManifests(directory) {
  const manifests = [];
  for (const id of readdirSync(directory).sort())
    manifests.push(
      value(
        await parseExecutionManifest(
          JSON.parse(readFileSync(join(directory, id, MANIFEST_FILE), "utf8")),
        ),
      ),
    );
  return manifests;
}

// What this host finds where a retained file should be.
function measureIn(engines, runtime) {
  return async function measure(manifest, file, part) {
    const path =
      part === "engine"
        ? join(engines, manifest.bundle.id, file.file)
        : join(runtime, file.file);
    if (!existsSync(path)) return null;
    if (
      part === "runtime" &&
      JSON.parse(readFileSync(join(runtime, "bundle.json"), "utf8")).id !==
        manifest.runtime.id
    )
      return null;
    const bytes = readFileSync(path);
    return { sha256: sha256(bytes), byteLength: bytes.length };
  };
}

// Finds the bundle a claim names among those retained, verifies its files
// and loads its engine module. Each load is a separate module instance.
let loads = 0;
async function resolveEngine(claim) {
  const manifest = value(
    await resolveExecution(
      claim,
      "browser",
      await retainedManifests(retainedDirectory),
      measureIn(retainedDirectory, runtimeDirectory),
    ),
  );
  const file = join(retainedDirectory, manifest.bundle.id, ENGINE_FILE);
  loads += 1;
  return {
    manifest,
    engine: await import(`${pathToFileURL(file).href}?load=${loads}`),
  };
}

// The build a save resumes through. The browser journey builds two retained
// bundles: A, which the run uses, and B, a later build with another engine.
let bundle;
let later = null;
if (backend === "browser") {
  const built = await buildExecutionBundle(runtimeDirectory, retainedDirectory);
  later = (
    await buildExecutionBundle(
      runtimeDirectory,
      retainedDirectory,
      "/* a later engine build */",
    )
  ).manifest;
  assert.notEqual(later.bundle.id, built.manifest.bundle.id);
  bundle = built.manifest.bundle;
  E = (await resolveEngine(bundle)).engine;
} else {
  const engineSource = join(root, "packages/production-simulation/src");
  const engineHash = createHash("sha256");
  for (const file of readdirSync(engineSource, { recursive: true }).sort())
    if (file.endsWith(".ts"))
      engineHash.update(file).update(readFileSync(join(engineSource, file)));
  const definition = JSON.parse(readFileSync(definitionFile, "utf8"));
  const bundleContent = {
    backend,
    protocolVersion: E.HOST_PROTOCOL_VERSION,
    checkpointSchemaVersion: CELL_CHECKPOINT_SCHEMA_VERSION,
    engineHash: engineHash.digest("hex"),
    controllerSourceHash: definition.execution.controllerSourceHash,
    controllerHash: definition.execution.controllerHash,
    runtimeHash: definition.execution.runtimeHash,
  };
  bundle = { id: sha256(canonicalJson(bundleContent)), ...bundleContent };
}
const nativeCell = value(
  E.parseNativeCell(JSON.parse(readFileSync(definitionFile, "utf8"))),
);

const VALUES = {
  horizonSeconds: 600,
  orders: 2,
  trays: ["tray-a", "tray-b"],
  cell: {
    id: nativeCell.cellId,
    modelHash: nativeCell.modelHash,
    controllerSourceHash: nativeCell.controllerSourceHash,
    timestepSeconds: 0.002,
    // The settled hold the controller offers a rested, idle cell.
    holdModel: "cold-cell-rest.1",
  },
  load: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
  unload: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
};
const scenario = value(
  coldCellJourneyAdapter.compile(await coldCellJourneySnapshot(VALUES, 1)),
);
const definition = value(await E.admitScenario(scenario));
save("scenario.json", { digest: definition.digest, scenario });
const horizon = value(timeFromSeconds(VALUES.horizonSeconds));
const cellId = definition.scenario.cells[0].id;
const runId = id("run", "plan-70-j1");

function identity(execution, parent) {
  return {
    runId:
      typeof execution === "string"
        ? id("run", `plan-70-j1-${execution}`)
        : runId,
    executionId: id("execution", `headless-${execution}`),
    hostSession: id("host-session", `host-${execution}`),
    bundle: bundle.id,
    parent,
  };
}

// Recordings and checkpoints are stored once, under the digest of their bytes.
const artifacts = new Map();
function store(role, digest, content, binding) {
  assert.equal(sha256(content), digest, `${role} content is what it names`);
  const file = join(output, "artifacts", `${digest}.json`);
  if (!existsSync(file)) writeFileSync(file, content);
  const entry = {
    role,
    digest,
    byteLength: Buffer.byteLength(content),
    schemaVersion:
      role === "cell-checkpoint"
        ? bundle.checkpointSchemaVersion
        : RECORDING_PACK_SCHEMA_VERSION,
    binding,
  };
  artifacts.set(digest, entry);
  return entry;
}

// One run's recordings: accepted segments gather in an open pack, which is
// stored as one artifact when it reaches its target size or a save needs it.
function recordingStore() {
  const packs = [];
  const cells = [];
  let open = [];
  let openBytes = 0;
  function close() {
    if (open.length === 0) return;
    const content = value(packRecordings(open));
    packs.push(store("recording-segment", sha256(content), content, null));
    open = [];
    openBytes = 0;
  }
  return {
    packs,
    cells,
    close,
    add(digest, recording) {
      open.push({ digest, content: recording });
      openBytes += recording.length;
      if (openBytes >= RECORDING_PACK_TARGET_BYTES) close();
    },
  };
}

function observer(segments, recordings, taken) {
  return {
    async segment(segment, recording) {
      recordings.add(segment.recording.digest, recording);
      segments.push(segment);
    },
    cellRecording: storeObservedCellRecording.bind(null, recordings),
    yield: taken,
  };
}

async function storeObservedCellRecording(recordings, recording) {
  recordings.cells.push(
    E.readCellRecordingDocument(JSON.parse(recording.content)),
  );
  recordings.add(recording.digest, recording.content);
}

// Every accepted segment's recording is stored once and reads back intact.
function storedBytes(segments, recordings) {
  const contents = new Map();
  for (const pack of recordings.packs) {
    const content = readFileSync(
      join(output, "artifacts", `${pack.digest}.json`),
      "utf8",
    );
    for (const record of value(unpackRecordings(content)))
      contents.set(record.digest, record.content);
  }
  let bytes = 0;
  for (const segment of segments) {
    const found = contents.get(segment.recording.digest);
    assert.ok(found !== undefined, `segment ${segment.sequence} is stored`);
    assert.equal(sha256(found), segment.recording.digest);
    assert.equal(found.length, segment.recording.byteLength);
    bytes += found.length;
  }
  return bytes;
}

function never() {
  return false;
}

function results(run) {
  return E.runResults(run, { after: null, through: run.position.time });
}

function cellOf(run) {
  return run.cells[0];
}

function seconds(time) {
  return time / 1_000_000;
}

// What a run did, apart from which execution did it and when it was paused.
function history(run) {
  const events = [];
  for (const {
    sequence: _sequence,
    execution: _execution,
    ...event
  } of run.events)
    if (event.kind !== "command-admitted") events.push(event);
  return events;
}

function world(run) {
  const {
    identity: _identity,
    commands: _commands,
    events: _events,
    position,
    ...state
  } = run;
  return {
    ...state,
    position: { time: position.time, horizon: position.horizon },
  };
}

// --- The uninterrupted journey ---------------------------------------------
const referenceStarted = performance.now();
const referenceHost = await physicsHost("reference-host");
const referenceAdapter = E.cellAdapter(referenceHost.transport, bundle, [
  nativeCell,
]);
const referenceOpened = value(
  await referenceAdapter.open(cellId, {
    kind: "create",
    modelHash: nativeCell.modelHash,
  }),
);
const referenceSegments = [];
const referenceRecordings = recordingStore();
const reference = value(
  await E.driveRun(
    value(
      E.startRun(definition, identity(1, null), [
        { cell: cellId, checkpoint: referenceOpened },
      ]),
    ),
    referenceAdapter,
    horizon,
    observer(referenceSegments, referenceRecordings, never),
  ),
).run;
referenceRecordings.close();
const referenceFinal = value(await referenceAdapter.exportCheckpoint(cellId));
await referenceAdapter.dispose(cellId);
await referenceHost.close();
const referenceMilliseconds = performance.now() - referenceStarted;
assert.equal(
  reference.status.kind,
  "completed",
  JSON.stringify(reference.status),
);
assert.equal(
  referenceFinal.checkpoint.digest,
  cellOf(reference).committed.checkpoint.digest,
  "the engine's committed checkpoint is the cell's real state",
);
save("reference-events.json", reference.events);
save("reference-final-state.json", reference);
save("reference-results.json", results(reference));

// --- The interrupted journey ------------------------------------------------
// Each interruption names the state it waits for. `inside` is the attempt it
// must fall within, or null for a cell at rest between operations.
const INTERRUPTIONS = [
  {
    name: "tray-a-after-pickup",
    inside: "tray-orders#0/transfer@1",
    steps: 4_700,
  },
  // Inside the second of rest the empty cell is observed for before it holds.
  { name: "empty-cell-at-rest", inside: null, afterSeconds: 48 },
  {
    name: "tray-b-returning",
    inside: "tray-orders#1/transfer@1",
    steps: 1_700,
  },
  {
    name: "tray-b-after-pickup",
    inside: "tray-orders#1/transfer@1",
    steps: 8_200,
  },
];

function reached(interruption, run) {
  const cell = cellOf(run);
  if (run.status.kind !== "awaiting-execution") return false;
  if (interruption.inside === null)
    return (
      run.status.need.kind === "rest" &&
      cell.slot.kind === "inactive" &&
      seconds(run.position.time) >= interruption.afterSeconds
    );
  return (
    run.status.need.kind === "advance" &&
    cell.attempt?.id === interruption.inside &&
    cell.attempt.steps >= interruption.steps
  );
}

const rejections = {};
function refused(name, result, reason) {
  assert.equal(result.ok, false, `${name} is refused`);
  assert.equal(result.error, reason, name);
  rejections[name] = result.error;
}

// Evidence that does not match what the run waits for changes nothing.
function refuseMismatchedEvidence(run, lastSegment) {
  const need = run.status.need;
  const cell = cellOf(run);
  const fake = "f".repeat(64);
  if (need.kind === "advance" && lastSegment !== null) {
    const next = {
      ...lastSegment.segment,
      sequence: cell.attempt.segments.length,
      predecessor: cell.committed.checkpoint.digest,
      steps: {
        start: cell.attempt.steps,
        end: cell.attempt.steps + need.steps,
      },
      events: [],
      checkpoint: {
        digest: fake,
        byteLength: 1,
        step: cell.committed.checkpoint.step + need.steps,
      },
    };
    assert.equal(
      value(E.acceptSegment(run, lastSegment.segment, lastSegment.digest)),
      run,
      "an identical accepted segment changes nothing",
    );
    refused(
      "conflictingDuplicateSegment",
      E.acceptSegment(run, lastSegment.segment, fake),
      "conflicting_duplicate",
    );
    refused(
      "segmentAfterAGap",
      E.acceptSegment(run, { ...next, sequence: next.sequence + 3 }, fake),
      "sequence_gap",
    );
    refused(
      "segmentFromAnotherState",
      E.acceptSegment(run, { ...next, predecessor: fake }, fake),
      "predecessor_differs",
    );
    refused(
      "segmentFromAnotherModel",
      E.acceptSegment(run, { ...next, modelHash: fake }, fake),
      "model_differs",
    );
    refused(
      "segmentFromAnotherBundle",
      E.acceptSegment(run, { ...next, bundle: fake }, fake),
      "bundle_differs",
    );
    refused(
      "segmentBeyondItsAllowance",
      E.acceptSegment(
        run,
        {
          ...next,
          steps: { start: next.steps.start, end: next.steps.end + 1 },
          checkpoint: { ...next.checkpoint, step: next.checkpoint.step + 1 },
        },
        fake,
      ),
      "exceeds_allowance",
    );
    refused(
      "eventInsideASegment",
      E.acceptSegment(
        run,
        {
          ...next,
          events: [
            { kind: "pickup", step: next.steps.end - 1, controllerSequence: 0 },
          ],
        },
        fake,
      ),
      "event_inside_segment",
    );
    refused(
      "terminalBeforeItsSegments",
      E.acceptTerminal(run, {
        runId: next.runId,
        executionId: next.executionId,
        cellId: next.cellId,
        attemptId: next.attemptId,
        kind: "terminal",
        sequence: next.sequence,
        steps: next.steps.end,
        segments: [],
        outcome: "completed",
        checkpoint: cell.committed.checkpoint,
      }),
      "steps_differ",
    );
    refused(
      "restWhileAnAttemptRuns",
      E.acceptRest(run, {
        cellId: cell.id,
        predecessor: cell.committed.checkpoint.digest,
        checkpoint: next.checkpoint,
      }),
      "not_awaited",
    );
  }
  if (need.kind === "boundary") {
    const candidate = {
      boundary: need.request.boundary,
      cellId: cell.id,
      predecessor: need.request.predecessor,
      checkpoint: { ...cell.committed.checkpoint, digest: fake },
      slot: {
        kind: "active",
        generation: need.request.slot.generation + 1,
        carrier: need.request.operation.carrier,
      },
      digest: fake,
    };
    refused(
      "candidateFromAnotherState",
      E.supplyBoundary(run, { ...candidate, predecessor: fake }),
      "predecessor_differs",
    );
    refused(
      "candidateForAnotherCarrier",
      E.supplyBoundary(run, {
        ...candidate,
        slot: { ...candidate.slot, carrier: "tray-z" },
      }),
      "slot_differs",
    );
    refused(
      "candidateThatStepped",
      E.supplyBoundary(run, {
        ...candidate,
        checkpoint: {
          ...candidate.checkpoint,
          step: candidate.checkpoint.step + 1,
        },
      }),
      "steps_differ",
    );
    refused(
      "candidateForAnotherBoundary",
      E.supplyBoundary(run, {
        ...candidate,
        boundary: `${candidate.boundary}x`,
      }),
      "not_awaited",
    );
    const paused = E.submitCommand(run, {
      kind: "pause",
      commandId: id("command", "pause-at-an-unsettled-boundary"),
      runId: run.identity.runId,
      executionId: run.identity.executionId,
      hostSession: run.identity.hostSession,
      expectedControlRevision: run.position.controlRevision,
    });
    // A held cell has one real state however far time has passed, so a
    // pause settles there. A stepping cell must first reach the boundary.
    if (cell.hold.kind === "settled") {
      assert.equal(paused.receipt.status, "accepted");
      rejections.pauseAtABoundaryOfAHeldCell = "accepted";
    } else {
      assert.equal(paused.receipt.status, "rejected");
      assert.equal(paused.receipt.reason, "boundary_unsettled");
      rejections.pauseBeforeABoundarySettles = paused.receipt.reason;
    }
  }
}

const legs = [];
const observations = [];
let run = null;
let saved = null;
let lastSegment = null;
let sourceSegment = null;
let boundaryChecked = false;
let segmentChecked = false;
const interruptedSegments = [];
const interruptedRecordings = recordingStore();
const interruptedStarted = performance.now();

for (let leg = 1; leg <= INTERRUPTIONS.length + 1; leg += 1) {
  const legStarted = performance.now();
  const host = await physicsHost(`leg-${leg}-host`);
  let adapter = E.cellAdapter(host.transport, bundle, [nativeCell]);
  let restoreMilliseconds = null;
  if (saved === null) {
    const opened = value(
      await adapter.open(cellId, {
        kind: "create",
        modelHash: nativeCell.modelHash,
      }),
    );
    run = value(
      E.startRun(definition, identity(leg, null), [
        { cell: cellId, checkpoint: opened },
      ]),
    );
  } else {
    // A fresh host knows only what is on disk. A browser host first finds
    // the retained bundle the save names and loads that bundle's engine.
    const restoreStarted = performance.now();
    const raw = JSON.parse(readFileSync(saved.file, "utf8"));
    if (backend === "browser") {
      const claim = parseExecutionBundle(raw.bundle);
      assert.ok(claim !== null, "the save names its bundle");
      const resolved = await resolveEngine(claim);
      assert.equal(resolved.manifest.bundle.id, bundle.id);
      assert.notEqual(resolved.engine, E, "a separately loaded engine module");
      E = resolved.engine;
      adapter = E.cellAdapter(host.transport, bundle, [nativeCell]);
    }
    const document = value(await E.openResumable(raw, backend, [bundle]));
    const cell = cellOf(document.state);
    const content = readFileSync(
      join(output, "artifacts", `${cell.committed.checkpoint.digest}.json`),
      "utf8",
    );
    const attempt = cell.attempt;
    const restored = value(
      await adapter.open(cellId, {
        kind: "restore",
        checkpoint: cell.committed.checkpoint,
        content,
        operation:
          attempt === null
            ? null
            : { attempt: attempt.id, sequence: attempt.segments.length },
      }),
    );
    assert.deepEqual(restored, cell.committed.checkpoint);
    const source = document.state;
    run = value(
      E.continueRun(
        source,
        identity(leg, {
          snapshot: document.snapshot,
          execution: source.identity.executionId,
        }),
      ),
    );
    restoreMilliseconds = performance.now() - restoreStarted;

    if (leg === 2) {
      // What belonged to the source execution has no authority here.
      refused(
        "segmentFromTheSourceExecution",
        E.acceptSegment(
          E.advanceRun(run, horizon),
          sourceSegment.segment,
          sourceSegment.digest,
        ),
        "stale_attempt",
      );
      const stale = E.submitCommand(run, {
        kind: "close-arrivals",
        source: definition.scenario.arrivals[0].id,
        commandId: id("command", "command-to-the-source-execution"),
        runId,
        executionId: source.identity.executionId,
        hostSession: source.identity.hostSession,
        expectedControlRevision: run.position.controlRevision,
      });
      assert.equal(stale.receipt.status, "rejected");
      assert.equal(stale.receipt.reason, "wrong_execution");
      rejections.commandToTheSourceExecution = stale.receipt.reason;
      refused(
        "continuationUnderTheSameExecution",
        E.continueRun(source, {
          ...source.identity,
          parent: run.identity.parent,
        }),
        "execution_not_new",
      );
      refused(
        "continuationWithoutItsParent",
        E.continueRun(source, { ...run.identity, parent: null }),
        "parent_differs",
      );
      refused(
        "continuationThroughAnotherBundle",
        E.continueRun(source, { ...run.identity, bundle: "0".repeat(64) }),
        "bundle_differs",
      );
    }
  }

  const interruption = INTERRUPTIONS[leg - 1] ?? null;
  const stop = value(
    await E.driveRun(
      run,
      adapter,
      horizon,
      observer(interruptedSegments, interruptedRecordings, (current) => {
        const need = current.status.need;
        if (!boundaryChecked && need.kind === "boundary") {
          refuseMismatchedEvidence(current, null);
          boundaryChecked = true;
        }
        if (
          !segmentChecked &&
          need.kind === "advance" &&
          cellOf(current).attempt.segments.length > 2
        ) {
          const segment = interruptedSegments.at(-1);
          refuseMismatchedEvidence(current, {
            segment,
            digest: cellOf(current).attempt.segments.at(-1),
          });
          segmentChecked = true;
        }
        return interruption !== null && reached(interruption, current);
      }),
    ),
  );
  run = stop.run;

  interruptedRecordings.close();
  if (interruption === null) {
    assert.equal(run.status.kind, "completed", JSON.stringify(run.status));
    const final = value(await adapter.exportCheckpoint(cellId));
    assert.equal(final.checkpoint.digest, referenceFinal.checkpoint.digest);
    await adapter.dispose(cellId);
    await host.close();
    legs.push({
      leg,
      execution: run.identity.executionId,
      restoreMilliseconds,
      wallMilliseconds: performance.now() - legStarted,
      host: {
        commands: host.timing.commands,
        milliseconds: host.timing.milliseconds,
        operations: latency(host.timing),
      },
    });
    break;
  }

  assert.ok(stop.yielded, `${interruption.name} was reached`);
  const cell = cellOf(run);
  const attempt = cell.attempt;
  if (attempt !== null) {
    lastSegment = {
      segment: interruptedSegments.at(-1),
      digest: attempt.segments.at(-1),
    };
    if (leg === 1) sourceSegment = lastSegment;
  }

  // Pause is admitted at once and settles at the cell's real state.
  const pauseStarted = performance.now();
  const paused = E.submitCommand(run, {
    kind: "pause",
    commandId: id("command", `pause-${leg}`),
    runId,
    executionId: run.identity.executionId,
    hostSession: run.identity.hostSession,
    expectedControlRevision: run.position.controlRevision,
  });
  assert.equal(
    paused.receipt.status,
    "accepted",
    JSON.stringify(paused.receipt),
  );
  assert.equal(paused.run.status.kind, "paused");
  assert.equal(paused.run.status.boundary, cell.committed.boundary);
  observations.push(E.observationView(paused.run, paused.run.position.time));

  // Save: the checkpoint first, then the document that references it.
  const exported = value(await adapter.exportCheckpoint(cellId));
  assert.deepEqual(exported.checkpoint, cell.committed.checkpoint);
  const pauseMilliseconds = performance.now() - pauseStarted;
  store("cell-checkpoint", exported.checkpoint.digest, exported.content, {
    cell: cellId,
    attempt: attempt?.id ?? null,
  });
  const index = [
    artifacts.get(exported.checkpoint.digest),
    ...interruptedRecordings.packs,
  ];
  const document = await E.resumableDocument(paused.run, bundle, index);
  assert.equal(
    (await E.resumableDocument(paused.run, bundle, index)).snapshot,
    document.snapshot,
    "saving the same state again names the same snapshot",
  );
  const file = join(output, `snapshot-${leg}-${interruption.name}.json`);
  const encoded = `${canonicalJson(document)}\n`;
  writeFileSync(file, encoded, { flag: "wx" });
  saved = { file, document };

  // The owning process is destroyed without warning; its worlds are gone.
  await host.destroy();
  assert.ok(!existsSync(join(output, `leg-${leg}-host-closing.json`)));
  legs.push({
    leg,
    execution: run.identity.executionId,
    interruption: interruption.name,
    pausedAtSeconds: seconds(paused.run.position.time),
    attempt: attempt?.id ?? null,
    attemptSteps: attempt?.steps ?? null,
    cellSteps: cell.committed.checkpoint.step,
    slot: cell.slot,
    snapshot: document.snapshot,
    documentBytes: Buffer.byteLength(encoded),
    checkpointBytes: exported.checkpoint.byteLength,
    indexedArtifacts: index.length,
    restoreMilliseconds,
    pauseAndExportMilliseconds: pauseMilliseconds,
    wallMilliseconds: performance.now() - legStarted,
    host: {
      commands: host.timing.commands,
      milliseconds: host.timing.milliseconds,
      operations: latency(host.timing),
    },
  });
}
const interruptedMilliseconds = performance.now() - interruptedStarted;
assert.ok(
  boundaryChecked && segmentChecked,
  "mismatched evidence was exercised",
);
save("interrupted-events.json", run.events);
save("interrupted-final-state.json", run);
save("interrupted-results.json", results(run));

// A finished run must reproduce the logistics and quantities observed before
// each host was destroyed. Later arrivals and outcomes must stay in the future.
function comparableObservation(observation) {
  const copy = structuredClone(observation);
  for (const task of copy.logistics.tasks)
    if (task.kind === "executing") task.completesAt = null;
  return copy;
}
const historicalObservations = [];
for (const observation of observations) {
  const historical = E.observationView(run, observation.time);
  assert.deepEqual(
    comparableObservation(historical),
    comparableObservation(observation),
    `historical observation reproduces the saved boundary at ${observation.time}`,
  );
  assert.ok(E.parseObservationView(historical).ok);
  historicalObservations.push(historical);
}
save("historical-observations.json", historicalObservations);

// Accepted events never step back in time, pauses and holds included.
function ordered(events) {
  for (const [index, event] of events.entries()) {
    assert.equal(event.sequence, index + 1);
    if (index > 0) assert.ok(event.time >= events[index - 1].time, event.kind);
  }
}
ordered(reference.events);
ordered(run.events);

// --- The two journeys agree -------------------------------------------------
assert.deepEqual(history(run), history(reference), "the same accepted history");
assert.deepEqual(
  world(run),
  world(reference),
  "the same final production state",
);
assert.deepEqual(results(run), results(reference));
assert.equal(
  cellOf(run).committed.checkpoint.digest,
  cellOf(reference).committed.checkpoint.digest,
);
const executions = new Set();
for (const event of run.events) executions.add(event.execution);
assert.equal(
  executions.size,
  legs.length,
  "each leg wrote under its own execution",
);
assert.equal(
  run.events.length - reference.events.length,
  INTERRUPTIONS.length,
  "the only additional events are the admitted pauses",
);

// Segments tile each attempt exactly once across every execution.
function coverage(segments) {
  const attempts = new Map();
  for (const segment of segments) {
    const steps = attempts.get(segment.attemptId) ?? 0;
    assert.equal(
      segment.steps.start,
      steps,
      `${segment.attemptId} is contiguous`,
    );
    attempts.set(segment.attemptId, segment.steps.end);
  }
  return Object.fromEntries(attempts);
}
assert.deepEqual(coverage(interruptedSegments), coverage(referenceSegments));

function count(events, kind) {
  let total = 0;
  for (const event of events) if (event.kind === kind) total += 1;
  return total;
}
for (const kind of ["carrier-picked-up", "carrier-placed", "task-completed"])
  assert.equal(count(run.events, kind), count(reference.events, kind), kind);
assert.equal(count(run.events, "order-completed"), VALUES.orders);
assert.equal(count(run.events, "task-failed"), 0);
for (const carrier of run.carriers) {
  assert.deepEqual(carrier.custody, {
    kind: "stored",
    storage: "outbound-shelf",
  });
  assert.equal(carrier.bound, null);
}
assert.deepEqual(cellOf(run).slot, {
  kind: "inactive",
  generation: VALUES.orders,
});

// --- Holding instead of stepping --------------------------------------------
// The same scenario with no hold declared steps its cell through every tick.
// Holding must change how much the cell steps and nothing the factory sees.
const steppedHost = await physicsHost("stepped-host");
const steppedAdapter = E.cellAdapter(steppedHost.transport, bundle, [
  nativeCell,
]);
const steppedDefinition = value(
  await E.admitScenario(
    value(
      coldCellJourneyAdapter.compile(
        await coldCellJourneySnapshot(
          { ...VALUES, cell: { ...VALUES.cell, holdModel: null } },
          1,
        ),
      ),
    ),
  ),
);
const stepped = value(
  await E.driveRun(
    value(
      E.startRun(steppedDefinition, identity("stepped", null), [
        {
          cell: cellId,
          checkpoint: value(
            await steppedAdapter.open(cellId, {
              kind: "create",
              modelHash: nativeCell.modelHash,
            }),
          ),
        },
      ]),
    ),
    steppedAdapter,
    horizon,
    observer([], recordingStore(), (current) => {
      if (
        rejections.pauseBeforeABoundarySettles === undefined &&
        current.status.need.kind === "boundary"
      )
        refuseMismatchedEvidence(current, null);
      return false;
    }),
  ),
).run;
assert.equal(rejections.pauseBeforeABoundarySettles, "boundary_unsettled");
await steppedHost.close();
// The factory's history apart from the cell's own state: a held cell and a
// stepped one have taken different numbers of steps, so their checkpoints
// differ while everything the factory accepted is the same.
function withoutHolds(events) {
  return history({ events })
    .filter((event) => event.kind !== "cell-hold")
    .map(({ checkpoint: _checkpoint, ...event }) => event);
}
assert.equal(stepped.status.kind, "completed");
assert.equal(count(stepped.events, "cell-hold"), 0);
assert.deepEqual(withoutHolds(reference.events), withoutHolds(stepped.events));
for (const part of ["tasks", "carriers", "storages", "lots", "resources"])
  assert.deepEqual(reference[part], stepped[part], part);
const heldCell = cellOf(reference);
const steppedCell = cellOf(stepped);
assert.equal(steppedCell.committed.clock.held, 0);
assert.equal(
  steppedCell.committed.clock.steps * 2000,
  stepped.position.time,
  "an unheld cell steps through every tick",
);
// Held time and stepped time together account for the whole run.
assert.equal(
  heldCell.committed.clock.steps * 2000 +
    heldCell.committed.clock.held +
    (heldCell.hold.kind === "settled"
      ? reference.position.time - heldCell.committed.boundary
      : 0),
  reference.position.time,
);
const holding = {
  model: VALUES.cell.holdModel,
  holdsEntered: count(reference.events, "cell-hold") / 2,
  cellSteps: heldCell.committed.clock.steps,
  cellStepsWithoutHolds: steppedCell.committed.clock.steps,
  heldSeconds:
    (reference.position.time - heldCell.committed.clock.steps * 2000) /
    1_000_000,
  intervals: reference.events
    .filter((event) => event.kind === "cell-hold")
    .map((event) => ({ seconds: seconds(event.time), state: event.state })),
  sameFactoryHistory: true,
};
let idleAfterHold = false;
for (const record of referenceRecordings.cells) {
  const native = JSON.parse(record.native);
  assert.equal(record.time.kind, native.motion.kind);
  if (record.time.kind === "idle") {
    assert.equal(
      record.time.through - record.time.after,
      (native.motion.endStep - native.motion.startStep) * 2000,
    );
    if (record.time.after > native.motion.startStep * 2000)
      idleAfterHold = true;
  } else {
    const event = reference.events.find(
      committedRecordingBoundary.bind(null, record.time.boundary),
    );
    assert.ok(event);
    assert.equal(record.time.at, event.time);
    assert.equal(native.checkpoint, event.checkpoint);
  }
}
assert.ok(
  idleAfterHold,
  "Idle observations retain factory time after a qualified hold",
);
holding.idleRecordingAfterHold = true;

function committedRecordingBoundary(boundary, event) {
  return event.kind === "cell-committed" && event.boundary === boundary;
}

// --- A saved document that cannot be continued ------------------------------
const lastSaved = saved.document;
async function unopened(name, raw, approved, code) {
  const opened = await E.openResumable(raw, backend, approved);
  assert.equal(opened.ok, false, name);
  assert.equal(opened.error.code, code, name);
  rejections[name] = opened.error.reason ?? opened.error.code;
}
// The tray in transport is recorded as already racked.
const moved = structuredClone(lastSaved);
assert.equal(moved.state.carriers[1].custody.kind, "transport");
moved.state.carriers[1].custody = { kind: "stored", storage: "rack" };
await unopened(
  "documentWithAnEditedRecord",
  moved,
  [bundle],
  "snapshot_differs",
);
// Recomputing integrity must not make an invalid state executable.
const malformed = [];
malformed.push(["rehashedCustodyMismatch", moved]);
const missingTask = structuredClone(lastSaved);
missingTask.state.tasks.pop();
malformed.push(["rehashedMissingTask", missingTask]);
const invalidBranch = structuredClone(lastSaved);
invalidBranch.state.carriers[0].custody.task = "unexpected-task";
malformed.push(["rehashedInvalidBranch", invalidBranch]);
const offGrid = structuredClone(lastSaved);
offGrid.state.position.time += 1;
malformed.push(["rehashedOffGridClock", offGrid]);
const duplicateCarrier = structuredClone(lastSaved);
duplicateCarrier.state.carriers.push(duplicateCarrier.state.carriers[0]);
malformed.push(["rehashedDuplicateCarrier", duplicateCarrier]);
const invalidScenario = structuredClone(lastSaved);
invalidScenario.state.definition.scenario.workflows = null;
malformed.push(["rehashedMalformedScenario", invalidScenario]);
const wrongClock = structuredClone(lastSaved);
wrongClock.state.cells[0].committed.clock.held += 2000;
malformed.push(["rehashedInconsistentCellClock", wrongClock]);
for (const [name, document] of malformed) {
  const { snapshot: _snapshot, ...content } = document;
  document.snapshot = sha256(canonicalJson(content));
  await unopened(name, document, [bundle], "invalid_document");
}
await unopened("bundleThisHostDoesNotHold", lastSaved, [], "inspection_only");
await unopened(
  "bundleWithAnotherController",
  lastSaved,
  [{ ...bundle, controllerHash: "0".repeat(64) }],
  "inspection_only",
);
const other = await E.openResumable(
  lastSaved,
  backend === "browser" ? "headless" : "browser",
  [bundle],
);
assert.equal(other.error?.reason, "backend_differs");
rejections.snapshotOpenedByAnotherBackend = other.error.reason;
const unindexed = await E.resumableDocument(
  lastSaved.state,
  bundle,
  lastSaved.artifacts.slice(1),
);
await unopened(
  "documentWithoutItsCheckpoint",
  unindexed,
  [bundle],
  "artifact_index",
);

// The controller refuses a checkpoint whose content is not what it names.
const probeHost = await physicsHost("probe-host");
const probe = E.cellAdapter(probeHost.transport, bundle, [nativeCell]);
const probeCell = cellOf(lastSaved.state);
const probeContent = readFileSync(
  join(output, "artifacts", `${probeCell.committed.checkpoint.digest}.json`),
  "utf8",
);
const probeOperation =
  probeCell.attempt === null
    ? null
    : {
        attempt: probeCell.attempt.id,
        sequence: probeCell.attempt.segments.length,
      };
const corrupted = await probe.open(cellId, {
  kind: "restore",
  checkpoint: probeCell.committed.checkpoint,
  content: probeContent.replace(/"steps":(\d+)/u, '"steps":1$1'),
  operation: probeOperation,
});
assert.equal(corrupted.ok, false);
rejections.checkpointWithChangedContent = corrupted.error;
if (probeOperation !== null) {
  const misbound = await probe.open(cellId, {
    kind: "restore",
    checkpoint: probeCell.committed.checkpoint,
    content: probeContent,
    operation: { ...probeOperation, attempt: "tray-orders#9/transfer@1" },
  });
  assert.equal(misbound.ok, false);
  rejections.checkpointOfAnotherAttempt = misbound.error;
}
const foreign = await E.cellAdapter(
  probeHost.transport,
  { ...bundle, controllerHash: "0".repeat(64) },
  [nativeCell],
).open(cellId, { kind: "create", modelHash: nativeCell.modelHash });
assert.equal(foreign.ok, false);
rejections.cellPinnedToAnotherBuild = foreign.error;
await verifyCellRecordingRefusals(probeHost.transport);
await probeHost.close();

async function recordingProbeSend(state, command) {
  const reply = await state.transport.send(command);
  if (state.fault === "missing-idle-sample" && reply.kind === "advanced")
    reply.recording.motion.samples.pop();
  if (state.fault === "changed-arm" && reply.kind === "prepared")
    reply.recording.motion.after.joints[0] += 0.01;
  return reply;
}

async function verifyCellRecordingRefusals(transport) {
  const state = { transport, fault: "none" };
  const adapter = E.cellAdapter(
    { send: recordingProbeSend.bind(null, state) },
    bundle,
    [nativeCell],
  );
  const opened = value(
    await adapter.open(cellId, {
      kind: "create",
      modelHash: nativeCell.modelHash,
    }),
  );
  const rested = value(await adapter.rest(cellId, opened.digest, 32));
  const before = value(await adapter.exportCheckpoint(cellId));
  const request = {
    boundary: id("boundary", "recording-probe"),
    runId: identity("probe", null).runId,
    executionId: identity("probe", null).executionId,
    cellId,
    predecessor: before.checkpoint.digest,
    slot: { kind: "inactive", generation: 0 },
    operation: {
      kind: "admission",
      carrier: id("carrier", "probe-tray"),
      storage: id("storage", "table"),
    },
  };
  const candidate = value(await adapter.prepareBoundary(request));
  assert.equal(candidate.recording.kind, "admission");
  const discarded = value(await adapter.discardBoundary(candidate));
  assert.equal(discarded.digest, before.checkpoint.digest);
  assert.deepEqual(value(await adapter.exportCheckpoint(cellId)), before);
  state.fault = "changed-arm";
  const altered = await adapter.prepareBoundary(request);
  assert.equal(altered.ok, false);
  assert.deepEqual(value(await adapter.exportCheckpoint(cellId)), before);
  rejections.handoffRecordingWithChangedArm = altered.error;
  state.fault = "missing-idle-sample";
  const missing = await adapter.rest(cellId, before.checkpoint.digest, 32);
  assert.equal(missing.ok, false);
  rejections.idleRecordingWithoutItsBoundarySample = missing.error;
  await adapter.dispose(cellId);
  state.fault = "none";
  value(
    await adapter.open(cellId, {
      kind: "restore",
      checkpoint: before.checkpoint,
      content: before.content,
      operation: null,
    }),
  );
  const committed = value(await adapter.prepareBoundary(request));
  value(await adapter.commitBoundary(committed));
  const admittedCheckpoint = value(await adapter.exportCheckpoint(cellId));
  const sparseSamples = new Map();
  let settledCheckpoint = committed.checkpoint;
  for (let interval = 0; interval < 16; interval++) {
    const intervalResult = value(
      await adapter.rest(cellId, settledCheckpoint.digest, 32),
    );
    settledCheckpoint = intervalResult.checkpoint;
    for (const sample of JSON.parse(intervalResult.recording.content).motion
      .samples)
      sparseSamples.set(sample.step, sample);
  }
  await adapter.dispose(cellId);
  value(
    await adapter.open(cellId, {
      kind: "restore",
      checkpoint: admittedCheckpoint.checkpoint,
      content: admittedCheckpoint.content,
      operation: null,
    }),
  );
  let denseCheckpoint = admittedCheckpoint.checkpoint;
  const denseSamples = new Map();
  for (let step = 0; step < 512; step++) {
    const intervalResult = value(
      await adapter.rest(cellId, denseCheckpoint.digest, 1),
    );
    denseCheckpoint = intervalResult.checkpoint;
    for (const sample of JSON.parse(intervalResult.recording.content).motion
      .samples)
      denseSamples.set(sample.step, sample);
  }
  assert.equal(denseCheckpoint.digest, settledCheckpoint.digest);
  for (const [step, sample] of sparseSamples)
    assert.deepEqual(sample, denseSamples.get(step));
  const removal = value(
    await adapter.prepareBoundary({
      ...request,
      boundary: id("boundary", "recording-probe-removal"),
      predecessor: settledCheckpoint.digest,
      slot: committed.slot,
      operation: { ...request.operation, kind: "removal" },
    }),
  );
  assert.equal(removal.recording.kind, "removal");
  assert.equal(removal.recording.step, settledCheckpoint.step);
  value(await adapter.commitBoundary(removal));
  save("cell-recording-boundaries.json", {
    idle: JSON.parse(rested.recording.content),
    admission: JSON.parse(committed.recording.content),
    removal: JSON.parse(removal.recording.content),
    discardedCheckpoint: discarded,
    unchangedAfterDiscard: true,
    malformedHandoffDiscarded: true,
    capture: {
      stride: 8,
      solverSteps: 512,
      sparseSamples: sparseSamples.size,
      denseSamples: denseSamples.size,
      identicalStoredPoses: true,
      sameCheckpoint: true,
      sparse: [...sparseSamples.values()],
      dense: [...denseSamples.values()],
    },
  });
  await adapter.dispose(cellId);
}

// --- A transfer that fails after pickup -------------------------------------
// The same scenario in a cell whose clamp is too weak for its load: the arm
// lifts the tray and loses its grip. The failure is evidence like any other.
const weakDefinition = JSON.parse(readFileSync(definitionFile, "utf8"));
weakDefinition.clampForceN = 20;
weakDefinition.ingredients.massKg = 2.5;
const weakCell = value(E.parseNativeCell(weakDefinition));
assert.equal(weakCell.modelHash, nativeCell.modelHash);
const failureHost = await physicsHost("failure-host");
const failureAdapter = E.cellAdapter(failureHost.transport, bundle, [weakCell]);
const failureSegments = [];
const failureRecordings = recordingStore();
const failed = value(
  await E.driveRun(
    value(
      E.startRun(definition, identity("failure", null), [
        {
          cell: cellId,
          checkpoint: value(
            await failureAdapter.open(cellId, {
              kind: "create",
              modelHash: weakCell.modelHash,
            }),
          ),
        },
      ]),
    ),
    failureAdapter,
    horizon,
    observer(failureSegments, failureRecordings, never),
  ),
).run;
failureRecordings.close();
const failureCheckpoint = value(await failureAdapter.exportCheckpoint(cellId));
await failureHost.close();
save("failure-events.json", failed.events);
save("failure-final-state.json", failed);

const failedTask = "tray-orders#0/transfer";
const failure = failed.events.find((event) => event.kind === "task-failed");
const failedCell = cellOf(failed);
assert.equal(failed.status.kind, "blocked");
assert.equal(failure.task, failedTask);
assert.equal(failure.disposition, "tool");
// Its pickup stays accepted, and nothing claims the tray reached the rack.
const pickup = failed.events.find(
  (event) => event.kind === "carrier-picked-up" && event.task === failedTask,
);
assert.ok(pickup.time < failure.time);
assert.equal(
  failed.events.some(
    (event) => event.kind === "carrier-placed" && event.task === failedTask,
  ),
  false,
);
assert.equal(count(failed.events, "order-completed"), 0);
assert.deepEqual(failed.carriers[0].custody, {
  kind: "transport",
  task: failedTask,
  from: "source-table",
  to: "rack",
});
// The arm, the rack position and the cell stay held for an explicit recovery.
const arm = failed.resources.find((resource) => resource.id === "transfer-arm");
assert.deepEqual(arm.allocations, [
  { task: failedTask, units: 1, kind: "held", since: failure.time },
]);
assert.deepEqual(
  failed.storages.find((storage) => storage.id === "rack").reservations,
  [{ task: failedTask, carrier: "tray-a" }],
);
assert.equal(failedCell.hold.kind, "unresolved");
assert.equal(failedCell.slot.kind, "active");
assert.equal(failedCell.attempt.lifecycle.kind, "failed");
assert.equal(
  failedCell.attempt.lifecycle.retained.checkpoint.digest,
  failureCheckpoint.checkpoint.digest,
);
const failedState = failed.tasks.find((task) => task.id === failedTask);
assert.equal(failedState.kind, "recovery-required");
// The next order waits on the cell's state, not on a clock.
const waiting = failed.tasks.find((task) => task.id === "tray-orders#1/load");
assert.equal(waiting.kind, "waiting");
assert.ok(waiting.blockers.some((blocker) => blocker.kind === "cell-state"));
const failureBranch = {
  failedAtSeconds: seconds(failure.time),
  pickedUpAtSeconds: seconds(pickup.time),
  attemptSteps: failedCell.attempt.steps,
  disposition: failure.disposition,
  status: failed.status,
  heldResource: arm.allocations,
  carrierCustody: failed.carriers[0].custody,
  waitingBlockers: waiting.blockers,
  retainedCheckpoint: failureCheckpoint.checkpoint,
};

// --- A bundle that does not resolve (browser backend) -----------------------
let retention = null;
if (backend === "browser") {
  const claim = lastSaved.bundle;
  async function unresolved(name, claimed, engines, runtime, code) {
    const resolved = await resolveExecution(
      claimed,
      "browser",
      await retainedManifests(engines),
      measureIn(engines, runtime),
    );
    assert.equal(resolved.ok, false, name);
    assert.equal(resolved.error.code, code, name);
    rejections[name] =
      resolved.error.reason ?? `${resolved.error.code}: ${resolved.error.file}`;
  }
  // A host that retains only the later build cannot continue the save.
  const onlyLater = join(output, "retention-only-later");
  cpSync(
    join(retainedDirectory, later.bundle.id),
    join(onlyLater, later.bundle.id),
    { recursive: true },
  );
  await unresolved(
    "onlyALaterBuildRetained",
    claim,
    onlyLater,
    runtimeDirectory,
    "inspection_only",
  );
  // The later build's identity with this save's engine does not resolve.
  await unresolved(
    "laterBuildClaimedWithThisEngine",
    { ...later.bundle, engineHash: claim.engineHash },
    retainedDirectory,
    runtimeDirectory,
    "inspection_only",
  );
  const edited = join(output, "retention-edited-engine");
  cpSync(retainedDirectory, edited, { recursive: true });
  const engineFile = join(edited, claim.id, ENGINE_FILE);
  writeFileSync(engineFile, `${readFileSync(engineFile, "utf8")}\n`);
  await unresolved(
    "retainedEngineEdited",
    claim,
    edited,
    runtimeDirectory,
    "file_altered",
  );
  rmSync(engineFile);
  await unresolved(
    "retainedEngineMissing",
    claim,
    edited,
    runtimeDirectory,
    "file_missing",
  );
  // A runtime whose solver differs by one byte, under the same descriptor.
  const swapped = join(output, "retention-edited-runtime");
  cpSync(runtimeDirectory, swapped, { recursive: true });
  const wasm = readFileSync(join(swapped, "bakery_native.wasm"));
  wasm[wasm.length - 1] ^= 1;
  writeFileSync(join(swapped, "bakery_native.wasm"), wasm);
  await unresolved(
    "retainedSolverEdited",
    claim,
    retainedDirectory,
    swapped,
    "file_altered",
  );
  rmSync(swapped, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(retainedDirectory, claim.id, MANIFEST_FILE), "utf8"),
  );
  manifest.bundle.protocolVersion += 1;
  const reparsed = await parseExecutionManifest(manifest);
  assert.equal(reparsed.error?.code, "identity_differs");
  rejections.manifestEdited = reparsed.error.code;
  retention = {
    runtime: manifest.runtime.id,
    used: claim.id,
    later: later.bundle.id,
    engineBytes: manifest.engine.byteLength,
    engineModulesLoaded: loads,
  };
}

// --- What happened, and what it cost ----------------------------------------
function timeline(events) {
  const lines = [];
  for (const event of events)
    if (
      event.kind === "task-started" ||
      event.kind === "task-completed" ||
      event.kind === "carrier-picked-up" ||
      event.kind === "carrier-placed" ||
      event.kind === "cell-committed" ||
      event.kind === "order-completed"
    )
      lines.push({
        seconds: seconds(event.time),
        kind: event.kind,
        subject: event.task ?? event.carrier ?? event.cell ?? event.instance,
        detail: event.boundary ?? event.from ?? event.to ?? null,
        execution: event.execution,
      });
  return lines;
}

const finalCell = cellOf(run);
const report = {
  plan: "70 J1",
  backend,
  result: "passed",
  command: `node ${relative(root, fileURLToPath(import.meta.url))} ${relative(root, output)}`,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  device: {
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0].model,
    node: process.version,
  },
  bundle,
  scenario: { digest: definition.digest, values: VALUES },
  journey: {
    completedAtSeconds: seconds(run.status.completedAt),
    events: reference.events.length,
    cellSteps: finalCell.committed.checkpoint.step,
    finalCheckpoint: finalCell.committed.checkpoint.digest,
    attemptSteps: coverage(referenceSegments),
    segments: referenceSegments.length,
    results: results(run),
    timeline: timeline(run.events),
  },
  legs,
  agreement: {
    sameHistory: true,
    sameFinalState: true,
    sameFinalCheckpoint: true,
    additionalEvents: `${INTERRUPTIONS.length} admitted pauses`,
    executions: [...executions],
  },
  rejections,
  holding,
  retention,
  failureBranch,
  measurements: {
    referenceWallMilliseconds: referenceMilliseconds,
    interruptedWallMilliseconds: interruptedMilliseconds,
    referenceHost: {
      commands: referenceHost.timing.commands,
      milliseconds: referenceHost.timing.milliseconds,
      operations: latency(referenceHost.timing),
    },
    simulatedSecondsPerWallSecond:
      seconds(run.status.completedAt) / (referenceMilliseconds / 1000),
    recordings: {
      segments: interruptedSegments.length,
      packs: interruptedRecordings.packs.length,
      bytes: storedBytes(interruptedSegments, interruptedRecordings),
      referenceBytes: storedBytes(referenceSegments, referenceRecordings),
    },
  },
};
save("report.json", report);
console.log(
  `J1 passed: ${report.journey.events} events, ${report.journey.cellSteps} cell steps, ${legs.length} executions; artifact in ${output}`,
);
