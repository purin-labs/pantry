// Refactor 16 phase 1 targets, headless: the speed with one moving cell and
// with two, and the run time of the 24-order run.
//
//   node --expose-gc scripts/production-simulation/measure-phase-1-targets.mjs NEW_OUTPUT_DIRECTORY
//     [--runtime BUNDLE_DIRECTORY] [--only one-cell,two-cell,orders-24]
//
// Each run goes through the production engine of the runtime bundle and its
// Wasm build in this Node process, as the Portal worker runs it. The runs and
// the fingerprints are those of phase-1-scenarios.mjs. A run starts from the
// scenario and drives to its end without a pause. The report gives wall
// time, simulated time, simulated seconds per wall second, the recording
// bytes of a save at the end, and the fingerprints. It also counts the
// controller calls of each kind, with their time, so that the report gives
// the calls for each simulated second and the share of the drive time spent
// outside the Wasm module. The run time after one edit is measured by
// verify-physics-result-cache.mjs (Refactor 16, step 4).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  buildExecutionBundle,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import { physics } from "./physics-fingerprint.mjs";
import {
  PHASE_1_RUNS,
  history,
  phase1Scenario,
  runFingerprints,
  runToEnd,
} from "./phase-1-scenarios.mjs";

const RUNS = PHASE_1_RUNS;
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
let runtime = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
let only = RUNS;
let output = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--runtime") runtime = resolve(args[++index]);
  else if (args[index] === "--only") only = args[++index].split(",");
  else if (output === null) output = resolve(args[index]);
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(output !== null, "Provide a new output directory");
assert.ok(
  only.every((name) => RUNS.includes(name)),
  `Choose from ${RUNS}`,
);
assert.ok(!existsSync(output), "Choose a new output directory");
mkdirSync(output, { recursive: true });

const built = await buildExecutionBundle(runtime, join(output, "executions"));
const E = await import(
  pathToFileURL(join(built.directory, "production-engine.mjs")).href
);

// Counts each controller call and the time it takes inside the module.
function counted(transport) {
  const calls = {};
  return {
    calls,
    transport: {
      async send(command) {
        const started = performance.now();
        const reply = await transport.send(command);
        // An advance of an idle cell is a rest.
        const kind =
          command.op === "advance" && reply?.stop === "idle"
            ? "rest"
            : command.op;
        const entry = (calls[kind] ??= { calls: 0, ms: 0 });
        entry.calls += 1;
        entry.ms += performance.now() - started;
        return reply;
      },
    },
  };
}

async function measure(name) {
  const scenario = await phase1Scenario(E, runtime, name);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const module = await runtimeModule(runtime);
  const { calls, transport } = counted(
    E.wasmTransport(module, {
      encode: encoder.encode.bind(encoder),
      decode: decoder.decode.bind(decoder),
    }),
  );
  // Count the calls of the drive alone.
  const run = await runToEnd(
    E,
    transport,
    built.manifest.bundle,
    scenario,
    name,
    () => {
      for (const kind of Object.keys(calls)) delete calls[kind];
    },
  );
  const driveCalls = structuredClone(calls);
  const { state, view, beginMs, driveMs, drives } = run;
  const prints = await runFingerprints(E, run);
  const {
    identity: _identity,
    commands: _commands,
    events: _events,
    ...world
  } = state.run;
  // The fingerprinted content, for a diff between two builds.
  writeFileSync(
    join(output, `${name}-physics.json`),
    canonicalJson(
      physics({
        results: prints.results,
        history: history(state.run.events),
        world,
      }),
    ),
  );
  globalThis.gc?.();
  const simulatedSeconds = state.run.position.time / 1e6;
  let callCount = 0;
  let moduleMs = 0;
  for (const entry of Object.values(driveCalls)) {
    callCount += entry.calls;
    moduleMs += entry.ms;
    entry.ms = Math.round(entry.ms);
  }
  return {
    status: view.status.kind,
    ordersCompleted: prints.results.ordersCompleted,
    events: state.run.events.length,
    simulatedSeconds,
    beginMs: Math.round(beginMs),
    driveMs: Math.round(driveMs),
    drives,
    simulatedSecondsPerWallSecond:
      Math.round((simulatedSeconds / (driveMs / 1000)) * 100) / 100,
    recordingBytes: prints.recordingBytes,
    recordings: prints.recordings,
    recorded: prints.recorded,
    calls: driveCalls,
    callsPerSimulatedSecond:
      Math.round((callCount / simulatedSeconds) * 10) / 10,
    moduleMs: Math.round(moduleMs),
    outsideModuleShare: Math.round((1 - moduleMs / driveMs) * 1000) / 1000,
    fingerprint: prints.fingerprint,
  };
}

const report = {
  plan: "Refactor 16 phase 1 targets, headless",
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
  runs: {},
};
for (const name of only) {
  report.runs[name] = await measure(name);
  console.log(name, JSON.stringify(report.runs[name]));
  writeFileSync(
    join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
