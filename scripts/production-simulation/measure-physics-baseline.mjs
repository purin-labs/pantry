// Plan 70E E0: measures the current whole-operation runner before bounded
// stepping replaces it. One cold table-to-rack transfer runs through the native
// CLI and through the browser Wasm build loaded in this Node process.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";
import { WasmHost, program, runProgram } from "./engine-hosts.mjs";

const REPEATS = 5;
const PAUSE_PHASE = "lift";
const root = fileURLToPath(new URL("../../", import.meta.url));
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
const browserPackage = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
if (process.argv.length !== 3)
  throw new Error("Provide a new measurement output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function summary(values) {
  const sorted = [...values].sort(numeric);
  return {
    values,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function numeric(left, right) {
  return left - right;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// macOS reports the child's peak resident set through time(1).
function native(name, args) {
  const file = join(output, name);
  const command = ["--root", root, "--output", file, ...args];
  const started = performance.now();
  const result =
    platform() === "darwin"
      ? spawnSync("/usr/bin/time", ["-l", binary, ...command], {
          encoding: "utf8",
        })
      : spawnSync(binary, command, { encoding: "utf8" });
  const wallMs = round(performance.now() - started);
  assert.equal(result.status, 0, result.stderr);
  const peak = /(\d+)\s+maximum resident set size/.exec(result.stderr);
  return {
    file,
    wallMs,
    peakResidentBytes: peak === null ? null : Number(peak[1]),
  };
}

function timings(runs) {
  const walls = [];
  const peaks = [];
  for (const run of runs) {
    walls.push(run.wallMs);
    if (run.peakResidentBytes !== null) peaks.push(run.peakResidentBytes);
  }
  return {
    wallMs: summary(walls),
    peakResidentBytes: peaks.length === 0 ? null : summary(peaks),
  };
}

function jsonCost(path) {
  const text = readFileSync(path, "utf8");
  const parse = [];
  const stringify = [];
  let value = JSON.parse(text);
  for (let index = 0; index < 20; index++) {
    let started = performance.now();
    value = JSON.parse(text);
    parse.push(round(performance.now() - started));
    started = performance.now();
    JSON.stringify(value);
    stringify.push(round(performance.now() - started));
  }
  return {
    bytes: statSync(path).size,
    parseMs: summary(parse).median,
    stringifyMs: summary(stringify).median,
  };
}

// Native CLI: every invocation loads the model, plans, steps and serializes.
const request = native("request.json", ["prepare"]);
const prepared = JSON.parse(readFileSync(request.file, "utf8"));
assert.equal(prepared.timestep, 0.002);
native("warm-up-recording.json", ["run", request.file]);
const fullRuns = [];
const pauses = [];
const resumes = [];
for (let index = 0; index < REPEATS; index++) {
  fullRuns.push(native(`recording-${index}.json`, ["run", request.file]));
  const paused = native(`checkpoint-${index}.json`, [
    "--pause-after",
    PAUSE_PHASE,
    "run",
    request.file,
  ]);
  pauses.push(paused);
  resumes.push(native(`resumed-${index}.json`, ["resume", paused.file]));
}
const recording = JSON.parse(readFileSync(fullRuns[0].file, "utf8"));
const checkpoint = JSON.parse(readFileSync(pauses[0].file, "utf8"));
const resumed = JSON.parse(readFileSync(resumes[0].file, "utf8"));
assert.equal(recording.outcome.kind, "completed");
assert.equal(resumed.outcome.kind, "completed");
assert.equal(resumed.outcome.step, recording.outcome.step);
const steps = recording.outcome.step;
const pausedSteps = checkpoint.prefix.progress.step;
const fullMedian = timings(fullRuns).wallMs.median;
const resumeMedian = timings(resumes).wallMs.median;
const pauseMedian = timings(pauses).wallMs.median;

// Browser Wasm build under this process's V8. Each repeat is a cold module.
// Refactor 16 step 11: the module has no command line, so the transfer runs
// as the host's `run` program in one call, as the command line ran it.
async function wasmRun(index) {
  let started = performance.now();
  const host = new WasmHost(await runtimeModule(browserPackage));
  const instantiateMs = round(performance.now() - started);
  const initialHeapBytes = heapBytes();
  started = performance.now();
  const { request } = await program(host, {
    op: "prepare",
    preparation: {},
  });
  const prepareMs = round(performance.now() - started);
  started = performance.now();
  const { output: text } = await runProgram(
    host,
    "baseline",
    { kind: "run", request },
    1_000_000_000,
  );
  const runMs = round(performance.now() - started);
  const readMs = 0;
  if (index === 0)
    writeFileSync(join(output, "wasm-recording.json"), `${text}\n`);
  const result = JSON.parse(text);
  assert.equal(result.outcome.kind, "completed");
  return {
    instantiateMs,
    prepareMs,
    runMs,
    readMs,
    steps: result.outcome.step,
    initialHeapBytes,
    heapBytes: heapBytes(),
    execution: result.request.execution,
  };
}
// The build does not export its heap, so capture each instance's memory as
// it is created. Wasm memory only grows: its size after a run is the peak.
const memories = [];
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function captureMemory(...args) {
  const result = await instantiate.apply(WebAssembly, args);
  const instance = result.instance ?? result;
  for (const exported of Object.values(instance.exports))
    if (exported instanceof WebAssembly.Memory) memories.push(exported);
  return result;
};
function heapBytes() {
  const memory = memories[memories.length - 1];
  return memory === undefined ? null : memory.buffer.byteLength;
}
await wasmRun(-1);
const wasmRuns = [];
for (let index = 0; index < REPEATS; index++)
  wasmRuns.push(await wasmRun(index));
function column(runs, key) {
  const values = [];
  for (const run of runs) if (run[key] !== null) values.push(run[key]);
  return values.length === 0 ? null : summary(values);
}
const wasmRunMs = column(wasmRuns, "runMs");

const report = {
  plan: "70E E0 — baseline of the whole-operation runner",
  command: `node ${relative(root, fileURLToPath(import.meta.url))} <new directory>`,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  device: {
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
  },
  repeats: REPEATS,
  operation: {
    task: prepared.bakeryTaskId,
    robot: prepared.robot,
    case: prepared.case,
    timestepSeconds: prepared.timestep,
    modelHash: prepared.modelHash,
    steps,
    simulatedSeconds: steps * prepared.timestep,
    events: recording.events,
  },
  native: {
    binarySha256: sha256(binary),
    execution: prepared.execution,
    prepare: { wallMs: request.wallMs },
    fullRun: timings(fullRuns),
    pauseAfterPhase: {
      phase: PAUSE_PHASE,
      steps: pausedSteps,
      ...timings(pauses),
    },
    resume: { steps: steps - pausedSteps, ...timings(resumes) },
    // Resume neither plans nor repeats the prefix, so its difference from the
    // paused run isolates stepping from startup, planning and serialization.
    derived: {
      microsecondsPerStepFullRun: round((fullMedian * 1000) / steps),
      microsecondsPerStepSteppingOnly: round(
        ((fullMedian - pauseMedian) * 1000) / (steps - pausedSteps),
      ),
      resumeOverheadMs: round(resumeMedian - (fullMedian - pauseMedian)),
      simulatedSecondsPerWallSecond: round(
        (steps * prepared.timestep) / (fullMedian / 1000),
      ),
    },
  },
  wasm: {
    wasmSha256: sha256(join(browserPackage, "bakery_native.wasm")),
    host: "Node V8 in this process; the reference browser is not measured here",
    execution: wasmRuns[0].execution,
    steps: wasmRuns[0].steps,
    instantiateMs: column(wasmRuns, "instantiateMs"),
    prepareMs: column(wasmRuns, "prepareMs"),
    runMs: wasmRunMs,
    readResultMs: column(wasmRuns, "readMs"),
    initialHeapBytes: column(wasmRuns, "initialHeapBytes"),
    heapBytes: column(wasmRuns, "heapBytes"),
    derived: {
      microsecondsPerStepFullRun: round(
        (wasmRunMs.median * 1000) / wasmRuns[0].steps,
      ),
      extrapolatedMillisecondsPer32Steps: round(
        (wasmRunMs.median / wasmRuns[0].steps) * 32,
      ),
    },
  },
  serialization: {
    recording: {
      samples: recording.samples.length,
      ...jsonCost(fullRuns[0].file),
    },
    checkpoint: {
      integrationStateValues: checkpoint.prefix.integrationState.length,
      prefixSamples: checkpoint.prefix.samples.length,
      ...jsonCost(pauses[0].file),
    },
  },
  notMeasured: [
    "Advance-call latency: per-step figures divide a whole operation's time and are not measured calls",
    "Reference-browser worker startup, heap and slice latency",
    "Playback reconstruction error against omitted solver steps: the recorder keeps 30 Hz samples and no dense reference",
    "Cooperative pause latency: the runner pauses only between phases",
  ],
};
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
