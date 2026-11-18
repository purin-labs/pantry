// Separate Node processes execute the unchanged 24-order route through retained
// release A, then resume A's snapshot from release B with a changed controller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
await retain(releaseB, oldManifest);
await retain(releaseB, newManifest);
const scenario = await readJson(join(caseDirectory, "scenario.json"));
const cells = await readJson(join(caseDirectory, "cells.json"));
const input = join(output, "input.json");
await writeJson(input, { bundle: oldManifest.bundle, scenario, cells });
const referenceStore = join(output, "reference");
const interruptedStore = join(output, "interrupted");
const reference = await run(
  releaseA,
  input,
  referenceStore,
  scenario.limits.horizon,
);
const paused = await run(releaseA, input, interruptedStore, 160_000_000);
const checkpoint = await readJson(paused.snapshot);
const receiving = checkpoint.state.cells.find(isReceivingCell);
assert.equal(receiving.attempt.lifecycle.kind, "running");

// Lose the entire process after it writes a later pack, without publishing a save.
const before = (await readdir(join(interruptedStore, "artifacts"))).length;
const abandoned = start(
  releaseB,
  paused.snapshot,
  interruptedStore,
  scenario.limits.horizon,
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
const continued = await run(
  releaseB,
  paused.snapshot,
  interruptedStore,
  scenario.limits.horizon,
);
assert.equal(
  continued.bundle.id,
  oldId,
  "Release B must use the saved engine and controller.",
);
assert.notEqual(continued.executionId, paused.executionId);
const referenceDocument = await readJson(reference.snapshot);
const continuedDocument = await readJson(continued.snapshot);
assert.equal(referenceDocument.state.status.kind, "completed");
assert.equal(continuedDocument.state.status.kind, "completed");
assert.deepEqual(
  history(continuedDocument.state),
  history(referenceDocument.state),
);
assert.deepEqual(
  world(continuedDocument.state),
  world(referenceDocument.state),
);
assert.deepEqual(continuedDocument.state.identity.parent, {
  snapshot: checkpoint.snapshot,
  execution: checkpoint.state.identity.executionId,
});

// Every rejection uses isolated copies of real retained bytes or real saved data.
const enginePath = join(releaseB, "executions", oldId, oldManifest.engine.file);
await rename(enginePath, `${enginePath}.retained`);
const missingEngine = await refused(
  releaseB,
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
  paused.snapshot,
  interruptedStore,
);
await writeFile(artifactPath, originalArtifact);
const report = {
  result: "passed",
  oldBundle: oldManifest.bundle,
  newBundle: newManifest.bundle,
  reference,
  paused,
  continued,
  processKilled: signal,
  equivalentEvents: true,
  equivalentWorlds: true,
  priorRecordingFilesReused: checkpoint.artifacts.filter(isRecording).length,
  refusals: { missingEngine, alteredEngine, alteredCheckpoint },
};
await writeJson(join(output, "report.json"), report);
console.log(`Retained file host passed: ${output}`);

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
function start(root, input, store, until) {
  return spawn(
    process.execPath,
    [
      "scripts/production-simulation/run-file-execution.mjs",
      root,
      input,
      store,
      String(until),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}
async function run(root, input, store, until) {
  const child = start(root, input, store, until);
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
    `${store}: ${report.time / 1e6}s in ${Math.round(report.elapsedMs)}ms`,
  );
  return report;
}
async function refused(root, input, store) {
  const child = start(root, input, store, 18000_000_000);
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
function isRecording(entry) {
  return entry.role === "recording-segment";
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
