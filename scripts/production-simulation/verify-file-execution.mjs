// A saved run does not pin a build (Refactor 16, step 8). Separate Node
// processes run the 24-order route:
// - release A (an older engine) saves the run at a pause;
// - release B (the present engine) holds no file of release A. It runs the
//   inputs of that save again to the pause, and it completes the run;
// - the result equals a run that release B makes from the start;
// - inside release B a save restores its checkpoints, also after the loss
//   of the host process, and a replay equals the saved recording.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(
  process.argv.length,
  6,
  "Provide case directory, old bundle ID, new bundle ID and output.",
);
const [caseDirectory, oldId, newId, destination] = process.argv.slice(2);
const output = resolve(destination);
const publicAssets = resolve("apps/portal/public/bakery-physics");
const PAUSE_AT = 160_000_000;
await mkdir(output, { recursive: false });
const oldManifest = await readJson(
  join(publicAssets, "executions", oldId, "execution.json"),
);
const newManifest = await readJson(
  join(publicAssets, "executions", newId, "execution.json"),
);
assert.notEqual(oldManifest.bundle.engineHash, newManifest.bundle.engineHash);
assert.notEqual(
  oldManifest.bundle.controllerHash,
  newManifest.bundle.controllerHash,
);
const releaseA = join(output, "release-a");
const releaseB = join(output, "release-b");
await retain(releaseA, oldManifest);
await retain(releaseB, newManifest);
assert.equal(
  existsSync(join(releaseB, "executions", oldId)),
  false,
  "Release B must hold no engine of release A.",
);
assert.equal(
  existsSync(join(releaseB, "bundles", oldManifest.runtime.id)),
  false,
  "Release B must hold no runtime of release A.",
);
const scenario = await readJson(join(caseDirectory, "scenario.json"));
// The cells as the runtime of release A defined them.
const cells = await readJson(join(caseDirectory, "cells.json"));
const input = join(output, "input.json");
await writeJson(input, { scenario, cells });
const horizon = scenario.limits.horizon;

// 1. Release A saves the run at a pause.
const crossStore = join(output, "across-releases");
const savedA = await run(releaseA, oldId, input, crossStore, PAUSE_AT);
const documentA = await readJson(savedA.snapshot);
assert.equal(documentA.bundle.id, oldId);
assert.equal(documentA.state.status.kind, "paused");
assert.equal(
  documentA.state.cells.find(isReceivingCell).attempt.lifecycle.kind,
  "running",
  "The save must stop inside a native operation.",
);

// 2. Release B continues that save on its own engine.
const continued = await run(
  releaseB,
  newId,
  savedA.snapshot,
  crossStore,
  horizon,
);
assert.equal(continued.bundle.id, newId);
assert.equal(continued.origin, "replay");
assert.equal(continued.replay.state, "replayed");
assert.equal(continued.replay.snapshot, documentA.snapshot);
assert.equal(continued.replay.commands, documentA.state.commands.length);
assert.equal(continued.replay.applied, documentA.state.commands.length);
assert.deepEqual(continued.replay.refused, []);
assert.deepEqual(continued.replay.saved, {
  time: documentA.state.position.time,
  status: "paused",
});
assert.equal(continued.replay.status, "paused");
assert.notEqual(continued.executionId, savedA.executionId);
const continuedDocument = await readJson(continued.snapshot);
assert.equal(continuedDocument.state.status.kind, "completed");
assert.equal(continuedDocument.state.identity.bundle, newId);
assert.equal(
  continuedDocument.state.identity.runId,
  documentA.state.identity.runId,
);
assert.deepEqual(continuedDocument.state.identity.parent, {
  snapshot: documentA.snapshot,
  execution: documentA.state.identity.executionId,
});

// 3. The continued run equals a run that release B makes from the start. The
// cells of the input name release A, so release B defines them again.
const reference = await run(
  releaseB,
  newId,
  input,
  join(output, "reference"),
  horizon,
);
const referenceDocument = await readJson(reference.snapshot);
assert.equal(referenceDocument.state.status.kind, "completed");
assert.deepEqual(
  history(continuedDocument.state),
  history(referenceDocument.state),
);
assert.deepEqual(
  world(continuedDocument.state),
  world(referenceDocument.state),
);

// 4. Inside one release a save restores its checkpoints. Lose the entire
// process after it writes a later pack, without publishing a save.
const interruptedStore = join(output, "interrupted");
const paused = await run(releaseB, newId, input, interruptedStore, PAUSE_AT);
const checkpoint = await readJson(paused.snapshot);
assert.equal(
  checkpoint.state.cells.find(isReceivingCell).attempt.lifecycle.kind,
  "running",
);
const before = (await readdir(join(interruptedStore, "artifacts"))).length;
const abandoned = start(
  releaseB,
  newId,
  paused.snapshot,
  interruptedStore,
  horizon,
);
const closed = once(abandoned, "close");
const deadline = Date.now() + 60_000;
while ((await readdir(join(interruptedStore, "artifacts"))).length <= before) {
  assert.equal(
    abandoned.exitCode,
    null,
    "The unfinished process must remain alive.",
  );
  assert.ok(
    Date.now() < deadline,
    "The unfinished process must produce a later recording pack.",
  );
  await delay(50);
}
abandoned.kill("SIGKILL");
const [, signal] = await closed;
assert.equal(signal, "SIGKILL");
assert.deepEqual(
  await readJson(paused.snapshot),
  checkpoint,
  "The published boundary survives host loss.",
);
const restored = await run(
  releaseB,
  newId,
  paused.snapshot,
  interruptedStore,
  horizon,
);
assert.equal(restored.origin, "snapshot");
assert.equal(restored.replay, null);
assert.notEqual(restored.executionId, paused.executionId);
const restoredDocument = await readJson(restored.snapshot);
assert.equal(restoredDocument.state.status.kind, "completed");
assert.deepEqual(
  history(restoredDocument.state),
  history(referenceDocument.state),
);
assert.deepEqual(world(restoredDocument.state), world(referenceDocument.state));
assert.deepEqual(restoredDocument.state.identity.parent, {
  snapshot: checkpoint.snapshot,
  execution: checkpoint.state.identity.executionId,
});

// 5. On one engine, a replay equals the saved recording: each task has the
// times of the save, and the run stops at the same pause.
const replayed = await run(
  releaseB,
  newId,
  paused.snapshot,
  interruptedStore,
  checkpoint.state.position.time,
  "replay",
);
assert.equal(replayed.origin, "replay");
assert.equal(replayed.replay.state, "replayed");
assert.deepEqual(replayed.replay.refused, []);
assert.equal(replayed.replay.difference, null);
assert.equal(replayed.replay.time, checkpoint.state.position.time);
const replayedDocument = await readJson(replayed.snapshot);
assert.equal(replayedDocument.state.status.kind, "paused");
assert.deepEqual(
  history(replayedDocument.state),
  history(checkpoint.state),
  "The replayed events must be the saved events.",
);

// Every rejection uses isolated copies of real retained bytes or real saved data.
const enginePath = join(releaseB, "executions", newId, newManifest.engine.file);
await rename(enginePath, `${enginePath}.retained`);
const missingEngine = await refused(
  releaseB,
  newId,
  paused.snapshot,
  interruptedStore,
);
await rename(`${enginePath}.retained`, enginePath);
const engineBytes = await readFile(enginePath);
await writeFile(
  enginePath,
  Buffer.concat([engineBytes, Buffer.from("\n// altered\n")]),
);
const alteredEngine = await refused(
  releaseB,
  newId,
  paused.snapshot,
  interruptedStore,
);
await writeFile(enginePath, engineBytes);
const entry = checkpoint.artifacts.find(isCheckpoint);
const artifactPath = join(interruptedStore, "artifacts", entry.digest);
const originalArtifact = await readFile(artifactPath);
await writeFile(
  artifactPath,
  Buffer.concat([originalArtifact, Buffer.from(" ")]),
);
const alteredCheckpoint = await refused(
  releaseB,
  newId,
  paused.snapshot,
  interruptedStore,
);
await writeFile(artifactPath, originalArtifact);
// A save of another build is its inputs. An edited input is not that save.
const edited = structuredClone(documentA);
edited.state.commands[0].receipt.effectiveAt += 2_000;
const editedPath = join(output, "edited-save.json");
await writeJson(editedPath, edited);
const alteredInputs = await refused(releaseB, newId, editedPath, crossStore);
assert.match(alteredInputs, /snapshot_differs/u);

const report = {
  result: "passed",
  oldBundle: oldManifest.bundle,
  newBundle: newManifest.bundle,
  savedUnderOldBundle: savedA,
  continuedOnNewBundle: continued,
  reference,
  paused,
  restored,
  replayed,
  processKilled: signal,
  // Release A's recording against release B's replay of the same inputs.
  differenceAcrossReleases: continued.replay.difference,
  continuedEqualsFreshRun: true,
  restoredEqualsFreshRun: true,
  replayEqualsRecordingOnOneEngine: true,
  refusals: { missingEngine, alteredEngine, alteredCheckpoint, alteredInputs },
};
await writeJson(join(output, "report.json"), report);
console.log(`Saved runs continue across releases: ${output}`);

async function retain(root, manifest) {
  await mkdir(join(root, "executions"), { recursive: true });
  await mkdir(join(root, "bundles"), { recursive: true });
  await cp(
    join(publicAssets, "executions", manifest.bundle.id),
    join(root, "executions", manifest.bundle.id),
    { recursive: true },
  );
  await cp(
    join(publicAssets, "bundles", manifest.runtime.id),
    join(root, "bundles", manifest.runtime.id),
    { recursive: true },
  );
}
function start(root, bundle, input, store, until, ...mode) {
  return spawn(
    process.execPath,
    [
      "scripts/production-simulation/run-file-execution.mjs",
      root,
      bundle,
      input,
      store,
      String(until),
      ...mode,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}
async function run(root, bundle, input, store, until, ...mode) {
  const child = start(root, bundle, input, store, until, ...mode);
  const out = [];
  const errors = [];
  child.stdout.on("data", out.push.bind(out));
  child.stderr.on("data", errors.push.bind(errors));
  const [code] = await once(child, "close");
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const report = JSON.parse(
    Buffer.concat(out).toString().trim().split("\n").at(-1),
  );
  console.log(
    `${store}: ${report.time / 1e6}s in ${Math.round(report.elapsedMs)}ms (${report.origin})`,
  );
  return report;
}
async function refused(root, bundle, input, store) {
  const child = start(root, bundle, input, store, 18000_000_000);
  const errors = [];
  child.stderr.on("data", errors.push.bind(errors));
  child.stdout.resume();
  const [code] = await once(child, "close");
  assert.notEqual(
    code,
    0,
    "Corrupted or missing input must refuse continuation.",
  );
  return Buffer.concat(errors).toString();
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
function isReceivingCell(cell) {
  return cell.id === "receiving-cell";
}
function isCheckpoint(entry) {
  return entry.role === "cell-checkpoint";
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
