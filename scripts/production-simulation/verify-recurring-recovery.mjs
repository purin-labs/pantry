import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Continue the fixed stress route through congestion, native pickup and source closure.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    (process.argv.length === 4 && process.argv[3] === "--reference") ||
    (process.argv.length === 5 && process.argv[3] === "--verify"),
  "Provide a fresh output directory, or an existing one with --reference or --verify reference-document",
);
const output = resolve(process.argv[2]);
if (process.argv[3] === "--verify") {
  verifyRecovery(output, resolve(process.argv[4]));
  process.exit(0);
}
const referenceOnly = process.argv[3] === "--reference";
assert.ok(referenceOnly || !existsSync(output));
mkdirSync(join(output, "artifacts"), { recursive: true });
const currentRuntime = resolve(
  `apps/portal/public/bakery-physics/bundles/${BAKERY_BROWSER_BUNDLE.id}`,
);
const previous = referenceOnly
  ? JSON.parse(readFileSync(join(output, "report.json"), "utf8"))
  : null;
const retainedDirectory =
  previous === null ? null : join(output, "executions", previous.bundle);
const built =
  retainedDirectory === null
    ? await buildExecutionBundle(currentRuntime, join(output, "executions"))
    : {
        directory: retainedDirectory,
        manifest: JSON.parse(
          readFileSync(join(retainedDirectory, "execution.json"), "utf8"),
        ),
      };
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${built.manifest.runtime.id}`,
);
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);
const cells = referenceOnly
  ? JSON.parse(readFileSync(join(output, "cells.json"), "utf8"))
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
const scenario = await recurringColdCellScenario(definitions, {
  kind: "stress",
  bufferSlots: 1,
});
save("scenario.json", scenario);
save("cells.json", cells);
function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
function save(name, content) {
  writeFileSync(join(output, name), `${canonicalJson(content)}\n`);
}
async function open(saved, execution) {
  const module = await runtimeModule(runtime);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(module, {
      encode: encoder.encode.bind(encoder),
      decode: decoder.decode.bind(decoder),
    }),
  );
  const reply = await host.handle({
    kind: "begin",
    bundle: built.manifest.bundle,
    cells,
    identity: {
      runId: "recurring-logistics",
      executionId: execution,
      hostSession: execution,
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
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  return host;
}
async function persist(host, name) {
  const saved = await host.handle({ kind: "save" });
  if (saved.kind !== "saved") assert.fail(JSON.stringify(saved));
  value(E.checkArtifactIndex(saved.document));
  for (const artifact of saved.artifacts) {
    assert.equal(await sha256Hex(artifact.content), artifact.digest);
    writeFileSync(join(output, "artifacts", artifact.digest), artifact.content);
  }
  save(`${name}.json`, saved.document);
  const document = JSON.parse(
    readFileSync(join(output, `${name}.json`), "utf8"),
  );
  const checkpoints = [];
  for (const entry of document.artifacts) {
    assert.ok(existsSync(join(output, "artifacts", entry.digest)));
    if (entry.role === "cell-checkpoint")
      checkpoints.push({
        digest: entry.digest,
        content: readFileSync(join(output, "artifacts", entry.digest), "utf8"),
      });
  }
  return { document, checkpoints };
}
function afterPickup(run) {
  for (const cell of run.cells) {
    if (cell.attempt === null || cell.attempt.lifecycle.kind !== "running")
      continue;
    for (const carrier of run.carriers)
      if (
        carrier.custody.kind === "transport" &&
        carrier.custody.task === cell.attempt.task
      )
        return true;
  }
  return false;
}
function congestion(run) {
  const buffer = run.storages.find(intermediateBuffer);
  assert.equal(buffer.occupants.length, 1);
  let blocked = false;
  let unassigned = 0;
  for (const task of run.tasks) {
    if (task.kind !== "waiting" || task.subject.kind !== "workflow") continue;
    if (task.subject.key === "to-buffer")
      for (const blocker of task.blockers)
        if (
          blocker.kind === "destination" &&
          blocker.storage === "intermediate-buffer"
        )
          blocked = true;
    if (task.subject.key === "admit") unassigned++;
  }
  assert.ok(blocked, "The occupied buffer blocks source output");
  assert.ok(
    unassigned > 0,
    "Already-arrived demand waits for physical admission",
  );
  return { arrived: run.instances.length, waitingAdmission: unassigned };
}
function intermediateBuffer(storage) {
  return storage.id === "intermediate-buffer";
}
function drained(run, count) {
  assert.equal(run.status.kind, "completed");
  assert.equal(run.instances.length, count);
  const results = E.runResults(run, {
    after: null,
    through: run.position.time,
  });
  assert.equal(results.ordersCompleted, count);
  assert.equal(results.reported[0].amount, count);
  assert.equal(run.carriers.length, 4);
  for (const carrier of run.carriers) {
    assert.deepEqual(carrier.custody, {
      kind: "stored",
      storage: "tray-store",
    });
    assert.equal(carrier.bound, null);
  }
  return results;
}
if (referenceOnly) {
  const reference = await open(null, "reference");
  await driveToEnd(reference);
  const saved = await persist(reference, "reference");
  drained(saved.document.state, 24);
  await reference.handle({ kind: "dispose" });
  verifyRecovery(output, join(output, "reference.json"));
  process.exit(0);
}

async function driveToEnd(host) {
  let lastProgress = performance.now();
  for (;;) {
    const reply = await host.handle({
      kind: "drive",
      turns: 512,
      until: scenario.limits.horizon,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (reply.view.status.kind === "completed") return;
    assert.equal(reply.view.status.kind, "awaiting-execution");
    if (performance.now() - lastProgress > 15000) {
      console.log(`reference/drain: ${reply.view.time / 1e6}s`);
      lastProgress = performance.now();
    }
  }
}

const report = {
  result: "running",
  bundle: built.manifest.bundle.id,
  stops: [],
};
let host = await open(null, "restore-1");
let congested = null;
let stage = "congestion";
let pauseSequence = 0;
let lastProgress = performance.now();
try {
  for (;;) {
    const reply = await host.handle({
      kind: "drive",
      turns: 512,
      until: stage === "congestion" ? 700_000_000 : scenario.limits.horizon,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (performance.now() - lastProgress > 15000) {
      console.log(`${stage}: ${reply.view.time / 1e6}s`);
      lastProgress = performance.now();
    }
    if (reply.view.status.kind === "completed") break;
    if (reply.view.time !== 700_000_000)
      assert.equal(reply.view.status.kind, "awaiting-execution");
    const state = await host.handle({ kind: "state" });
    assert.equal(state.kind, "state");
    const atCongestion =
      stage === "congestion" && reply.view.time === 700_000_000;
    const atPickup =
      stage === "pickup" &&
      reply.view.time > 900_000_000 &&
      afterPickup(state.run);
    if (!atCongestion && !atPickup) continue;
    const pause = await host.handle({
      kind: "pause",
      commandId: `pause-${++pauseSequence}`,
    });
    assert.equal(pause.kind, "commanded");
    if (pause.receipt.status === "rejected") {
      assert.equal(pause.receipt.reason, "boundary_unsettled");
      continue;
    }
    const saved = await persist(host, stage);
    if (atCongestion) {
      report.congestion = congestion(saved.document.state);
      congested = saved;
    }
    report.stops.push({
      kind: stage,
      atSeconds: reply.view.time / 1e6,
      snapshot: saved.document.snapshot,
    });
    await host.handle({ kind: "dispose" });
    host = null;
    globalThis.gc?.();
    host = await open(saved, `restore-${report.stops.length + 1}`);
    stage = atCongestion ? "pickup" : "drain";
  }
  assert.equal(stage, "drain");
  const final = await persist(host, "continued");
  save("continued-results.json", drained(final.document.state, 24));
  await host.handle({ kind: "dispose" });
  host = null;
  globalThis.gc?.();
  assert.ok(congested !== null);
  host = await open(congested, "early-close");
  const close = {
    kind: "close-arrivals",
    commandId: "close-orders",
    source: "orders",
  };
  const accepted = await host.handle(close);
  assert.equal(accepted.kind, "commanded");
  assert.equal(accepted.receipt.status, "accepted");
  const duplicate = await host.handle(close);
  assert.deepEqual(duplicate.receipt, accepted.receipt);
  const conflicting = await host.handle({ ...close, source: "another-source" });
  assert.equal(conflicting.receipt.status, "rejected");
  assert.equal(conflicting.receipt.reason, "conflicting_payload");
  await driveToEnd(host);
  const closed = await persist(host, "closed");
  save(
    "closed-results.json",
    drained(closed.document.state, report.congestion.arrived),
  );
  assert.equal(closed.document.state.arrivals[0].kind, "closed");
  report.closedArrivals = report.congestion.arrived;
  report.duplicateClosureAdmittedOnce = true;
  report.conflictingClosureRefused = true;
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (host !== null) await host.handle({ kind: "dispose" });
  save("report.json", report);
}
console.log(`${report.result}: ${output}`);

function verifyRecovery(directory, referencePath) {
  const continued = JSON.parse(
    readFileSync(join(directory, "continued.json"), "utf8"),
  );
  const reference = JSON.parse(readFileSync(referencePath, "utf8"));
  const histories = [];
  const worlds = [];
  const checkpoints = [];
  for (const document of [continued, reference]) {
    const events = [];
    for (const {
      sequence: _sequence,
      execution: _execution,
      ...event
    } of document.state.events)
      if (event.kind !== "command-admitted") events.push(event);
    histories.push(events);
    const {
      identity: _identity,
      commands: _commands,
      events: _events,
      position,
      ...state
    } = document.state;
    worlds.push({ ...state, time: position.time });
    const native = [];
    for (const artifact of document.artifacts)
      if (artifact.role === "cell-checkpoint") native.push(artifact);
    checkpoints.push(native);
  }
  assert.deepEqual(histories[0], histories[1]);
  assert.deepEqual(worlds[0], worlds[1]);
  assert.deepEqual(checkpoints[0], checkpoints[1]);
  const report = JSON.parse(
    readFileSync(join(directory, "report.json"), "utf8"),
  );
  assert.equal(report.result, "passed");
  writeFileSync(
    join(directory, "continuation-verification.json"),
    `${JSON.stringify(
      {
        result: "passed",
        continuedSnapshot: continued.snapshot,
        referenceSnapshot: reference.snapshot,
        sameEventsAndWorld: true,
        sameTerminalNativeCheckpoints: true,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    "Congestion and pickup restores match uninterrupted events, world and native checkpoints.",
  );
}
