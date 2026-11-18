import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Plan 70C: one fixed route, six controls, and portable saves from real Wasm cells.
// --profile measures the first 350 seconds of the unchanged 24-order baseline.
import { assertSharedBarrier } from "./shared-barrier.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index.ts";
import { recurringColdCellScenario } from "../../packages/production-simulation/src/recipes/recurring-cold-cell.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";

assert.ok(
  process.argv.length === 3 ||
    (process.argv.length === 4 &&
      ["--profile", "--verify", "--continue"].includes(process.argv[3])),
  "Provide an artifact directory and optional --profile, --verify or --continue",
);
const output = resolve(process.argv[2]);
if (process.argv[3] === "--verify") {
  await verifyCampaign(output);
  process.exit(0);
}
const continuing = process.argv[3] === "--continue";
const previous = continuing ? readJson(join(output, "report.json")) : null;
assert.ok(continuing || !existsSync(output), "Choose a new artifact directory");
if (previous !== null) {
  assert.equal(previous.mode, "campaign");
}
mkdirSync(output, { recursive: true });
const profile = process.argv[3] === "--profile";
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${previous === null ? BAKERY_BROWSER_BUNDLE.id : previous.runtime}`,
);
const built =
  previous === null
    ? await buildExecutionBundle(runtime, join(output, "executions"))
    : {
        directory: join(output, "executions", previous.bundle),
        manifest: readJson(
          join(output, "executions", previous.bundle, "execution.json"),
        ),
      };
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const cells = continuing
  ? readJson(join(output, "balanced-baseline", "cells.json"))
  : [
      await prepareCell(runtime, "source-cell"),
      await prepareCell(runtime, "receiving-cell"),
    ];
const definitions = [];
for (const raw of cells) {
  const cell = value(E.parseNativeCell(raw));
  definitions.push({
    id: cell.cellId,
    modelHash: cell.modelHash,
    controllerSourceHash: cell.controllerSourceHash,
    timestepMicroseconds: 2000,
    carrierSlots: 1,
    holdModel: "cold-cell-rest.1",
  });
}
const cases = [
  {
    name: "balanced-baseline",
    input: { kind: "balanced", bufferSlots: 1, receivingHold: false },
  },
  {
    name: "balanced-hold",
    input: { kind: "balanced", bufferSlots: 1, receivingHold: true },
  },
  {
    name: "balanced-buffer",
    input: { kind: "balanced", bufferSlots: 2, receivingHold: false },
  },
  {
    name: "balanced-hold-buffer",
    input: { kind: "balanced", bufferSlots: 2, receivingHold: true },
  },
  { name: "stress-one-slot", input: { kind: "stress", bufferSlots: 1 } },
  { name: "stress-two-slots", input: { kind: "stress", bufferSlots: 2 } },
];

function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
function save(directory, name, content) {
  writeFileSync(join(directory, name), `${canonicalJson(content)}\n`);
}
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
  return { ...state, time: position.time };
}
async function open(scenario, saved, execution) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const module = await runtimeModule(runtime);
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(module, {
      encode: encoder.encode.bind(encoder),
      decode: decoder.decode.bind(decoder),
    }),
  );
  const began = await host.handle({
    kind: "begin",
    bundle: built.manifest.bundle,
    cells,
    identity: {
      runId: "recurring-logistics",
      executionId: `execution-${execution}`,
      hostSession: `host-${execution}`,
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
        ? { kind: "scenario", scenario }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.checkpoints,
          },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));
  return { host, module };
}
async function persist(host, directory, name) {
  const saved = await host.handle({ kind: "save" });
  if (saved.kind !== "saved") assert.fail(JSON.stringify(saved));
  save(directory, `${name}.json`, saved.document);
  for (const artifact of saved.artifacts) {
    assert.equal(await sha256Hex(artifact.content), artifact.digest);
    if (artifact.role === "recording-segment") {
      const decoded = value(E.readRecordingPack(artifact.content));
      for (const record of decoded.records) {
        const content = decoded.body.slice(
          record.offset,
          record.offset + record.byteLength,
        );
        assert.equal(
          await sha256Hex(content),
          record.digest,
          "Compression preserves every native record byte",
        );
      }
    }
    writeFileSync(
      join(directory, "artifacts", artifact.digest),
      artifact.content,
    );
  }
  // Read the portable snapshot and checkpoint bytes back from disk.
  const document = JSON.parse(
    readFileSync(join(directory, `${name}.json`), "utf8"),
  );
  const checkpoints = [];
  for (const entry of document.artifacts) {
    const path = join(directory, "artifacts", entry.digest);
    assert.ok(existsSync(path), `Missing retained artifact ${entry.digest}`);
    if (entry.role === "cell-checkpoint")
      checkpoints.push({
        digest: entry.digest,
        content: readFileSync(path, "utf8"),
      });
  }
  value(E.checkArtifactIndex(document));
  return { document, checkpoints };
}
async function run(scenario, directory, interrupted) {
  mkdirSync(join(directory, "artifacts"), { recursive: true });
  let execution = 1;
  let current = await open(scenario, null, execution);
  let resumed = false;
  let saved = null;
  let driveCalls = 0;
  let peakHeap = 0;
  let peakWasm = 0;
  let lastProgress = performance.now();
  const started = performance.now();
  const end = profile ? 350_000_000 : scenario.limits.horizon;
  for (;;) {
    const until = interrupted && !resumed ? 160_000_000 : end;
    const reply = await current.host.handle({
      kind: "drive",
      turns: 512,
      until,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    driveCalls += 1;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    peakWasm = Math.max(peakWasm, current.module.HEAPU8.byteLength);
    assertSharedBarrier(reply.view);
    if (performance.now() - lastProgress > 15000) {
      console.log(
        `${directory}: ${(reply.view.time / 1e6).toFixed(1)} simulated seconds`,
      );
      lastProgress = performance.now();
    }
    const atStop =
      reply.view.time >= until || reply.view.status.kind === "completed";
    if (!atStop) {
      assert.equal(
        reply.view.status.kind,
        "awaiting-execution",
        JSON.stringify(reply.view),
      );
      continue;
    }
    if (reply.view.status.kind !== "completed") {
      const pause = await current.host.handle({
        kind: "pause",
        commandId: `pause-${until}`,
      });
      assert.equal(pause.kind, "commanded", JSON.stringify(pause));
      assert.equal(pause.receipt.status, "accepted", JSON.stringify(pause));
    }
    saved = await persist(current.host, directory, `save-${execution}`);
    if (interrupted && !resumed) {
      const active = saved.document.state.cells.find(isReceivingCell);
      assert.equal(active.attempt.lifecycle.kind, "running");
      await current.host.handle({ kind: "dispose" });
      current = null;
      globalThis.gc?.();
      execution += 1;
      current = await open(scenario, saved, execution);
      resumed = true;
      continue;
    }
    const state = await current.host.handle({ kind: "state" });
    assert.equal(state.kind, "state");
    const results = E.runResults(state.run, {
      after: null,
      through: state.run.position.time,
    });
    assert.equal(results.ordersCompleted, profile ? 1 : 24);
    assert.equal(results.reported[0].amount, profile ? 1 : 24);
    for (const carrier of state.run.carriers) {
      assert.deepEqual(carrier.custody, {
        kind: "stored",
        storage: "tray-store",
      });
      assert.equal(carrier.bound, null);
    }
    for (const order of results.orders) {
      if (
        order.kind !== "completed" ||
        scenario.availability.length > 0 ||
        scenario.arrivals[0].interval !== 360_000_000
      )
        continue;
      assert.ok(
        order.leadTime < 360_000_000,
        "Balanced service returns the tray before the next arrival",
      );
    }
    save(directory, "results.json", results);
    save(directory, "final-state.json", state.run);
    const measurements = {
      simulatedSeconds: state.run.position.time / 1e6,
      milliseconds: performance.now() - started,
      driveCalls,
      peakNodeHeapBytes: peakHeap,
      peakWasmHeapBytes: peakWasm,
      recordingBytes: saved.document.artifacts
        .filter(isRecording)
        .reduce(addBytes, 0),
      snapshotArtifactBytes: saved.document.artifacts.reduce(addBytes, 0),
      artifactCount: saved.document.artifacts.length,
      completedOrders: results.ordersCompleted,
      restoredAfterPickup: resumed,
    };
    await current.host.handle({ kind: "dispose" });
    return { run: state.run, measurements };
  }
}
function isReceivingCell(cell) {
  return cell.id === "receiving-cell";
}
function isRecording(artifact) {
  return artifact.role === "recording-segment";
}
function addBytes(total, artifact) {
  return total + artifact.byteLength;
}

const report = previous ?? {
  result: "running",
  mode: profile ? "profile" : "campaign",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  runtime: BAKERY_BROWSER_BUNDLE.id,
  bundle: built.manifest.bundle.id,
  device: {
    cpu: cpus()[0].model,
    platform: platform(),
    release: release(),
    node: process.version,
  },
  cases: [],
};
report.result = "running";
delete report.failure;
try {
  for (const item of profile ? cases.slice(0, 1) : cases) {
    let completed = false;
    for (const entry of report.cases)
      if (entry.name === item.name) completed = true;
    if (completed) continue;
    const directory = join(output, item.name);
    mkdirSync(directory, { recursive: true });
    const scenario = await recurringColdCellScenario(definitions, item.input);
    save(directory, "scenario.json", scenario);
    save(directory, "cells.json", cells);
    const reference = await run(scenario, join(directory, "reference"), false);
    globalThis.gc?.();
    const entry = { name: item.name, reference: reference.measurements };
    if (profile || item.name === "stress-one-slot") {
      const interrupted = await run(
        scenario,
        join(directory, "interrupted"),
        true,
      );
      assert.deepEqual(history(interrupted.run), history(reference.run));
      assert.deepEqual(world(interrupted.run), world(reference.run));
      entry.recovery = {
        measurements: interrupted.measurements,
        sameEventsAndWorld: true,
      };
    }
    report.cases.push(entry);
    save(output, "report.json", report);
    console.log(
      `${item.name} passed: ${reference.measurements.completedOrders} completed orders`,
    );
  }
  report.result = profile ? "profile-passed" : "passed";
} catch (error) {
  report.result = "failed";
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  save(output, "report.json", report);
}
if (report.result === "passed") await verifyCampaign(output);
console.log(`${report.result}: ${output}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sumWaits(waits, key, kind, target) {
  let total = 0;
  for (const wait of waits) {
    if (!wait.task.endsWith(`/${key}`)) continue;
    for (const blocker of wait.blockers) {
      if (
        blocker.kind !== kind ||
        (blocker.storage ?? blocker.store) !== target
      )
        continue;
      total += wait.end - wait.start;
      break;
    }
  }
  return total / 1e6;
}

async function verifyCampaign(directory) {
  const report = readJson(join(directory, "report.json"));
  assert.equal(
    report.result,
    "passed",
    "All six real-physics cases must finish before comparison acceptance",
  );
  assert.equal(report.cases.length, 6);
  const retained = await import(
    pathToFileURL(
      join(directory, "executions", report.bundle, "production-engine.mjs"),
    ).href
  );
  const comparisons = [];
  for (const entry of report.cases) {
    const path = join(directory, entry.name);
    const document = readJson(join(path, "reference", "save-1.json"));
    const opened = value(
      await retained.openResumable(document, "browser", [document.bundle]),
    );
    const run = opened.state;
    assert.equal(run.status.kind, "completed");
    const results = retained.runResults(run, {
      after: null,
      through: run.position.time,
    });
    assert.equal(
      canonicalJson(results),
      canonicalJson(readJson(join(path, "reference", "results.json"))),
    );
    assert.equal(results.ordersCompleted, 24);
    for (const stock of results.stock) {
      assert.equal(stock.remaining, 0);
      assert.equal(stock.held, 0);
    }
    assert.equal(run.carriers.length, 4);
    const buffer = results.storageHistory.storages.find(intermediateBuffer);
    const baker = results.resources.find(sharedBaker);
    assert.equal(baker.occupiedUnitSeconds, 24 * 260);
    const waits = results.schedulingHistory.waits;
    let leadTime = 0;
    let maximumLeadTime = 0;
    let finalArrival = 0;
    for (const order of results.orders) {
      assert.equal(order.kind, "completed");
      leadTime += order.leadTime;
      maximumLeadTime = Math.max(maximumLeadTime, order.leadTime);
      finalArrival = Math.max(finalArrival, order.arrivedAt);
    }
    const result = {
      name: entry.name,
      family: entry.name.startsWith("stress") ? "overloaded" : "balanced",
      completed: results.ordersCompleted,
      endSeconds: run.position.time / 1e6,
      meanLeadSeconds: leadTime / results.orders.length / 1e6,
      maximumLeadSeconds: maximumLeadTime / 1e6,
      drainAfterLastArrivalSeconds: (run.position.time - finalArrival) / 1e6,
      fullBufferSeconds: buffer.fullSeconds,
      occupiedBufferSlotSeconds: buffer.occupiedSlotSeconds,
      sourceBlockedByBufferSeconds: sumWaits(
        waits,
        "to-buffer",
        "destination",
        "intermediate-buffer",
      ),
      waitingForCarrierSeconds: sumWaits(
        waits,
        "admit",
        "carrier",
        "tray-store",
      ),
      bakerOccupiedSeconds: baker.occupiedUnitSeconds,
    };
    if (entry.name === "balanced-baseline" || entry.name === "balanced-buffer")
      assert.ok(
        result.maximumLeadSeconds < 360,
        "The unheld control must finish each route before the next arrival",
      );
    if (entry.name === "stress-one-slot") {
      assert.ok(
        result.sourceBlockedByBufferSeconds > 0,
        "A full buffer blocks source output",
      );
      assert.ok(
        result.maximumLeadSeconds > 360,
        "Overloaded arrivals accumulate demand before physical admission",
      );
    }
    comparisons.push(result);
  }
  save(directory, "comparisons.json", {
    result: "passed",
    bundle: report.bundle,
    cases: comparisons,
  });
  console.log(`Verified six retained cases and causal metrics: ${directory}`);
}
function intermediateBuffer(storage) {
  return storage.storage === "intermediate-buffer";
}
function sharedBaker(resource) {
  return resource.resource === "baker";
}
