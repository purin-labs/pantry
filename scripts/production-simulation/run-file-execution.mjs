// node run-file-execution.mjs RETAINED_ROOT BUNDLE_ID INPUT_JSON STORE UNTIL_MICROSECONDS [replay]
// RETAINED_ROOT contains executions/ and bundles/, as the Portal assets do.
// BUNDLE_ID is the execution bundle of this release: the one build it runs.
// INPUT_JSON is a saved document or { scenario, cells } for a new run. A save
// of this build restores its checkpoints. A save of another build, or any
// save with "replay", gives its inputs to this build, which runs them again
// to the place where the save stopped (Refactor 16, step 8).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openFileExecution } from "./file-execution-host.mjs";
import { MAX_DOCUMENT_BYTES } from "../../packages/production-simulation/src/saved-run.ts";

if (
  (process.argv.length !== 7 && process.argv.length !== 8) ||
  (process.argv.length === 8 && process.argv[7] !== "replay")
)
  throw new Error(
    "Provide retained assets, the bundle, input JSON, store, the stop time in microseconds and, to run a save again, replay.",
  );
const [root, , input, store] = process.argv.slice(2, 6).map(resolvePath);
const until = Number(process.argv[6]);
if (!Number.isSafeInteger(until) || until < 0 || until % 2000 !== 0)
  throw new Error("The stop time must be on the 2 ms grid.");
if ((await stat(input)).size > MAX_DOCUMENT_BYTES)
  throw new Error(
    "Supply the run document and its separate artifact directory. The input exceeds the document limit.",
  );
const raw = JSON.parse(await readFile(input, "utf8"));
const started = performance.now();
const host = await openFileExecution(
  { executions: join(root, "executions"), runtimes: join(root, "bundles") },
  process.argv[3],
  join(store, "artifacts"),
);
const save =
  raw.kind === "resumable"
    ? await host.readSave(raw, process.argv.length === 8)
    : null;
if (save === null && !Array.isArray(raw.cells))
  throw new Error("A new run requires cell definitions.");
const origin = save?.origin ?? { kind: "scenario", scenario: raw.scenario };
const executionId = `execution-${randomUUID()}`;
const began = await host.handle({
  kind: "begin",
  bundle: host.manifest.bundle,
  cells: save?.cells ?? raw.cells,
  identity: {
    runId: save?.document.state.identity.runId ?? `run-${randomUUID()}`,
    executionId,
    hostSession: `host-${randomUUID()}`,
    parent:
      save === null
        ? null
        : {
            snapshot: save.document.snapshot,
            execution: save.document.state.identity.executionId,
          },
  },
  origin,
});
requireReply(began, "began");
let view = began.view;
const startupMs = performance.now() - started;
const peak = { heapUsed: 0, arrayBuffers: 0, rss: 0, wasm: 0 };
recordMemory(peak, host);
let driveCalls = 0;
let driveMaxMs = 0;
// The inputs of a save of another build run first, to where the save stopped.
let replay = began.replay ?? null;
let replayMs = null;
while (replay?.state === "replaying") {
  const before = performance.now();
  const reply = await host.handle({ kind: "drive", turns: 256, until });
  requireReply(reply, "drove");
  driveMaxMs = Math.max(driveMaxMs, performance.now() - before);
  driveCalls += 1;
  view = reply.view;
  replay = reply.replay;
  recordMemory(peak, host);
}
if (replay !== null) {
  replayMs = performance.now() - started;
  replay = { ...replay, time: view.time, status: view.status.kind };
  // A person resumes a replayed run in the Portal. This host goes on at once.
  if (view.status.kind === "paused" && view.time < until) {
    const resumed = await host.handle({
      kind: "resume",
      commandId: `resume-${randomUUID()}`,
    });
    requireReply(resumed, "commanded");
    view = resumed.view;
  }
}
while (view.time < until && canAdvance(view.status.kind)) {
  const before = performance.now();
  const reply = await host.handle({ kind: "drive", turns: 256, until });
  requireReply(reply, "drove");
  driveMaxMs = Math.max(driveMaxMs, performance.now() - before);
  driveCalls += 1;
  view = reply.view;
  recordMemory(peak, host);
}
if (canAdvance(view.status.kind)) view = await pause(host, until);
const saved = await host.handle({ kind: "save" });
requireReply(saved, "saved");
const snapshot = await host.publish(saved.document, join(store, "snapshots"));
recordMemory(peak, host);
const elapsedMs = performance.now() - started;
// An explicit --expose-gc run measures retained data after the timed journey.
let retainedMemory = null;
if (typeof globalThis.gc === "function") {
  globalThis.gc();
  retainedMemory = process.memoryUsage();
}
await host.handle({ kind: "dispose" });
const report = {
  result: "passed",
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  bundle: host.manifest.bundle,
  executionId,
  snapshot,
  time: view.time,
  status: view.status,
  origin: origin.kind,
  replay,
  replayMs,
  startupMs,
  elapsedMs,
  driveCalls,
  driveMaxMs,
  peak,
  retainedMemory,
  nativeAdvances: host.advanceMetrics,
  processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
  processCpuMs:
    (process.resourceUsage().userCPUTime +
      process.resourceUsage().systemCPUTime) /
    1000,
  writtenArtifactBytes: host.writtenBytes,
  peakArtifactBytes: host.peakArtifactBytes,
};
await mkdir(join(store, "reports"), { recursive: true });
await writeFile(
  join(store, "reports", `${executionId}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));

function resolvePath(path) {
  return resolve(path);
}
function requireReply(reply, kind) {
  if (reply.kind !== kind) throw new Error(JSON.stringify(reply));
}
function canAdvance(kind) {
  return (
    kind === "ready" || kind === "awaiting-execution" || kind === "advancing"
  );
}
function recordMemory(peak, host) {
  const memory = process.memoryUsage();
  for (const key of ["heapUsed", "arrayBuffers", "rss"])
    peak[key] = Math.max(peak[key], memory[key]);
  peak.wasm = Math.max(peak.wasm, host.wasmBytes);
}
async function pause(host, until) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reply = await host.handle({
      kind: "pause",
      commandId: `pause-${randomUUID()}`,
    });
    requireReply(reply, "commanded");
    if (reply.view.status.kind === "paused") return reply.view;
    if (reply.receipt.status !== "rejected")
      throw new Error(JSON.stringify(reply));
    const advanced = await host.handle({
      kind: "drive",
      turns: 1,
      until: until + 2000,
    });
    requireReply(advanced, "drove");
  }
  throw new Error("The host did not settle at a shared physics boundary.");
}
