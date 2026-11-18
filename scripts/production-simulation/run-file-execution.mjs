// node run-file-execution.mjs RETAINED_ROOT INPUT_JSON STORE UNTIL_MICROSECONDS
// RETAINED_ROOT contains executions/ and bundles/, as the Portal assets do.
// INPUT_JSON is a saved document or { bundle, scenario, cells } for a new run.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openFileExecution } from "./file-execution-host.mjs";
import { MAX_DOCUMENT_BYTES } from "../../packages/production-simulation/src/saved-run.ts";
import { checkpointBody } from "../../packages/bakery-model/src/bakery-checkpoint.ts";

if (process.argv.length !== 6)
  throw new Error(
    "Provide retained assets, input JSON, store and stop time in microseconds.",
  );
const [root, input, store] = process.argv.slice(2, 5).map(resolvePath);
const until = Number(process.argv[5]);
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
  raw.bundle,
  join(store, "artifacts"),
);
const origin =
  raw.kind === "resumable"
    ? await host.readSnapshot(raw)
    : { kind: "scenario", scenario: raw.scenario };
const cells = [];
if (origin.kind === "snapshot") {
  // A checkpoint since Refactor 16 step 6 is an envelope; the shared
  // reader takes both shapes, as the Portal does.
  for (const checkpoint of origin.checkpoints) {
    const body = checkpointBody(JSON.parse(checkpoint.content));
    if (body === null) throw new Error("A checkpoint has no definition.");
    cells.push(body.definition);
  }
} else {
  if (!Array.isArray(raw.cells))
    throw new Error("A new run requires cell definitions.");
  cells.push(...raw.cells);
}
const executionId = `execution-${randomUUID()}`;
const began = await host.handle({
  kind: "begin",
  bundle: host.manifest.bundle,
  cells,
  identity: {
    runId:
      origin.kind === "snapshot"
        ? origin.document.state.identity.runId
        : `run-${randomUUID()}`,
    executionId,
    hostSession: `host-${randomUUID()}`,
    parent:
      origin.kind === "snapshot"
        ? {
            snapshot: origin.document.snapshot,
            execution: origin.document.state.identity.executionId,
          }
        : null,
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
