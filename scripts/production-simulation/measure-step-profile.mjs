// Refactor 16 step 2: the cost of one physics step, and where it goes.
//
//   node scripts/production-simulation/measure-step-profile.mjs NEW_OUTPUT_DIRECTORY
//     [--binary PATH] [--runtime BUNDLE_DIRECTORY] [--no-sample] [--no-wasm]
//
// Four workloads run through the native runner and through a Wasm runtime
// bundle in this Node process:
//   transfer-program  one table-to-rack transfer as a host program (the one-shot path)
//   transfer-cell     two rack transfers in one persistent cell (path B)
//   espresso          one espresso cycle in the persistent espresso cell
//   pour-over         one pour-over brew in the persistent pour-over cell
// The report gives microseconds per physics step for each workload. On macOS
// it also samples the native process with /usr/bin/sample and splits the
// stepping time into MuJoCo calls, contact scans, name lookups, samples and
// JSON. Each workload writes a fingerprint: the SHA-256 of every sample,
// contact, event and outcome, without build identities and digests. Two
// builds with equal fingerprints produced the same physics, sample for sample.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";
import { Fingerprint } from "./physics-fingerprint.mjs";

const REPEATS = 5;
// Runs with the sampler attached are not timed: the sampler slows them.
const SAMPLED_SESSIONS = 3;
const ALLOWANCE = 32;
const root = fileURLToPath(new URL("../../", import.meta.url));
const options = parseArguments(process.argv.slice(2));
const output = resolve(options.output ?? ".");
const binary = resolve(
  options.binary ??
    join(root, "crates/bakery-native/target/release/bakery-native"),
);
const runtime = resolve(
  options.runtime ??
    join(
      root,
      "apps/portal/public/bakery-physics/bundles",
      BAKERY_BROWSER_BUNDLE.id,
    ),
);

function parseArguments(args) {
  const parsed = { sample: platform() === "darwin", wasm: true, native: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--binary") parsed.binary = args[++index];
    else if (arg === "--runtime") parsed.runtime = args[++index];
    else if (arg === "--no-sample") parsed.sample = false;
    else if (arg === "--no-wasm") parsed.wasm = false;
    else if (arg === "--no-native") parsed.native = false;
    else if (arg === "--parse") {
      parsed.parse = args.slice(index + 1);
      return parsed;
    } else if (parsed.output === undefined && !arg.startsWith("--"))
      parsed.output = arg;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (parsed.output === undefined && parsed.parse === undefined)
    throw new Error("Provide a new output directory.");
  return parsed;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------- native

let files = 0;
function path(name) {
  return join(output, `${String(++files).padStart(3, "0")}-${name}.json`);
}

/** `sample` on macOS, attached to a running native process. */
function startSampling(pid, name) {
  if (!options.sample) return null;
  const file = join(output, `${name}.sample.txt`);
  const child = spawn(
    "/usr/bin/sample",
    [String(pid), "600", "1", "-mayDie", "-file", file],
    { stdio: "ignore" },
  );
  return { child, file };
}
async function stopSampling(sampling) {
  if (sampling === null) return null;
  const done = once(sampling.child, "exit");
  sampling.child.kill("SIGINT");
  await done;
  return existsSync(sampling.file) ? sampling.file : null;
}

class NativeHost {
  pending = [];
  constructor(name) {
    this.child = spawn(
      binary,
      ["--root", root, "--output", path(`${name}-closed`), "serve"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    createInterface({ input: this.child.stdout }).on("line", (line) =>
      this.pending.shift()?.resolve(JSON.parse(line)),
    );
  }
  send(command) {
    const pending = Promise.withResolvers();
    this.pending.push(pending);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return pending.promise;
  }
  async close() {
    const done = once(this.child, "exit");
    this.child.stdin.end();
    await done;
  }
}

class WasmHost {
  constructor(module) {
    this.module = module;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }
  send(command) {
    const module = this.module;
    const bytes = this.encoder.encode(JSON.stringify(command));
    const pointer = module._bakery_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    const code = module._bakery_cell_command(pointer, bytes.length);
    module._bakery_free(pointer, bytes.length);
    const start = module._bakery_response_pointer();
    const text = this.decoder.decode(
      module.HEAPU8.subarray(start, start + module._bakery_response_length()),
    );
    if (code !== 0) throw new Error(text);
    return JSON.parse(text);
  }
  close() {}
}

// ------------------------------------------------------------- workloads
// Each workload opens its world, then `run` advances it to its end. Only the
// advance calls are timed: they hold the physics steps.

async function advanceLoop(host, wrap, cell, fingerprint, stopAt) {
  let steps = 0;
  let micros = 0;
  let calls = 0;
  for (;;) {
    const started = performance.now();
    const reply = unwrap(
      await host.send(wrap({ op: "advance", cell, steps: ALLOWANCE })),
    );
    micros += (performance.now() - started) * 1000;
    calls += 1;
    assert.equal(reply.kind, "advanced", JSON.stringify(reply).slice(0, 400));
    const segment = reply.segment ?? reply.recording;
    const span = segment.endStep - segment.startStep;
    assert.ok(span > 0 && span <= ALLOWANCE);
    steps += span;
    fingerprint.add(segment);
    fingerprint.count(segment.samples?.length ?? 0);
    if (reply.outcome !== undefined && reply.outcome !== null)
      fingerprint.add(reply.outcome);
    if (stopAt(reply)) return { steps, micros, calls, reply };
  }
}

function unwrap(reply) {
  return reply.kind === "espresso" || reply.kind === "pour-over"
    ? reply.reply
    : reply;
}

const stationWorkloads = {
  espresso: {
    op: "espresso",
    definition: { fixture: "espresso", cell: "espresso-cell", appliance: "linea" },
    cell: "espresso-cell",
    task: "espresso-cycle",
  },
  "pour-over": {
    op: "pour-over",
    definition: {
      fixture: "pour-over",
      cell: "pour-over-cell",
      kettleWaterG: 500,
      drainage: "nominal",
      fault: "none",
    },
    cell: "pour-over-cell",
    task: "pour-over-brew",
  },
};

async function stationRun(host, workload, definition) {
  const wrap = (command) => ({ op: workload.op, command });
  const opened = unwrap(
    await host.send(
      wrap({
        op: "open",
        cell: workload.cell,
        opening: { kind: "create", definition },
      }),
    ),
  );
  assert.notEqual(opened.kind, "failed", JSON.stringify(opened));
  const started = unwrap(
    await host.send(
      wrap({
        op: "start",
        cell: workload.cell,
        attemptId: "profile",
        task: workload.task,
      }),
    ),
  );
  assert.equal(started.kind, "started", JSON.stringify(started));
  const fingerprint = new Fingerprint();
  const run = await advanceLoop(
    host,
    wrap,
    workload.cell,
    fingerprint,
    (reply) => reply.stop === "terminal",
  );
  assert.equal(
    run.reply.outcome?.kind,
    "completed",
    JSON.stringify(run.reply.outcome),
  );
  await host.send(wrap({ op: "dispose", cell: workload.cell }));
  return { ...run, fingerprint };
}

async function cellRun(host, definition) {
  const wrap = (command) => command;
  const cell = definition.cellId;
  const opened = await host.send({
    op: "open",
    cell,
    opening: { kind: "create", definition },
  });
  assert.equal(opened.kind, "opened", JSON.stringify(opened));
  const fingerprint = new Fingerprint();
  const total = { steps: 0, micros: 0, calls: 0 };
  for (const carrier of ["tray-a", "tray-b"]) {
    for (const [op, kind] of [
      ["prepare", "admission"],
      ["commit", null],
    ]) {
      const reply = await host.send(
        op === "prepare"
          ? {
              op,
              cell,
              boundary: `admit-${carrier}`,
              change: { kind, carrier },
            }
          : { op, cell, boundary: `admit-${carrier}` },
      );
      assert.notEqual(reply.kind, "failed", JSON.stringify(reply));
      fingerprint.add(reply);
    }
    const started = await host.send({
      op: "start",
      cell,
      attemptId: `profile-${carrier}`,
      task: "table-to-rack",
    });
    assert.equal(started.kind, "started", JSON.stringify(started));
    const run = await advanceLoop(
      host,
      wrap,
      cell,
      fingerprint,
      (reply) => reply.stop === "terminal",
    );
    assert.equal(run.reply.outcome?.kind, "completed");
    total.steps += run.steps;
    total.micros += run.micros;
    total.calls += run.calls;
    for (const [op, kind] of [
      ["prepare", "removal"],
      ["commit", null],
    ]) {
      const reply = await host.send(
        op === "prepare"
          ? {
              op,
              cell,
              boundary: `remove-${carrier}`,
              change: { kind, carrier },
            }
          : { op, cell, boundary: `remove-${carrier}` },
      );
      assert.notEqual(reply.kind, "failed", JSON.stringify(reply));
      fingerprint.add(reply);
    }
  }
  await host.send({ op: "dispose", cell });
  return { ...total, fingerprint };
}

/** One one-shot transfer as a host program, in calls of ALLOWANCE steps. */
async function programRun(host) {
  const program = (command) => host.send({ op: "program", command });
  const prepared = await program({ op: "prepare", preparation: {} });
  assert.equal(prepared.kind, "program", JSON.stringify(prepared));
  let reply = (
    await program({
      op: "open",
      job: "profile",
      program: { kind: "run", request: prepared.reply.request },
    })
  ).reply;
  let micros = 0;
  let calls = 0;
  while (reply.kind === "running") {
    const started = performance.now();
    reply = (
      await program({ op: "advance", job: "profile", steps: ALLOWANCE })
    ).reply;
    micros += (performance.now() - started) * 1000;
    calls += 1;
  }
  assert.equal(reply.kind, "finished", JSON.stringify(reply).slice(0, 400));
  const recording = JSON.parse(reply.output);
  const fingerprint = sessionFingerprint(recording);
  return {
    steps: recording.outcome.step,
    micros,
    calls,
    samples: fingerprint.samples,
    fingerprint: fingerprint.digest(),
  };
}

/** A cell definition from the host, as the Portal worker asks for one. */
async function hostDefinition(host, name) {
  const definition =
    name === "transfer-cell"
      ? { fixture: "rack", cell: "profile-cell", robot: "fairino-fr10" }
      : stationWorkloads[name].definition;
  const reply = await host.send({ op: "define", definition });
  assert.equal(reply.kind, "defined", JSON.stringify(reply));
  return reply.definition;
}

function sessionFingerprint(result) {
  const fingerprint = new Fingerprint();
  fingerprint.add(result.samples ?? result.segment?.samples ?? result);
  fingerprint.add(result.events ?? []);
  fingerprint.add(result.outcome ?? null);
  fingerprint.count(result.samples?.length ?? 0);
  return fingerprint;
}

function timingSummary(runs) {
  const perStep = runs.map((run) => run.micros / run.steps);
  const fingerprints = new Set(runs.map((run) => run.fingerprint));
  assert.equal(fingerprints.size, 1, "Repeated runs gave different physics");
  return {
    steps: runs[0].steps,
    calls: runs[0].calls,
    samples: runs[0].samples,
    microsecondsPerStep: round(median(perStep)),
    microsecondsPerStepRuns: perStep.map(round),
    simulatedSecondsPerWallSecond: round(0.002 / (median(perStep) / 1e6)),
    fingerprint: runs[0].fingerprint,
  };
}

async function nativeWorkloads() {
  const results = {};
  const profiles = {};

  // The one-shot path: a transfer as a host program, through `serve`.
  const runs = [];
  for (let index = 0; index <= REPEATS + SAMPLED_SESSIONS; index++) {
    const host = new NativeHost(`transfer-program-${index}`);
    // One transfer takes about 0.4 s: sample each timed run and add them.
    const sampled = index > REPEATS;
    const sampling = sampled
      ? startSampling(host.child.pid, `transfer-program-${index}`)
      : null;
    const run = await programRun(host);
    const file = await stopSampling(sampling);
    await host.close();
    if (file !== null) (profiles["transfer-program"] ??= []).push(file);
    if (index === 0 || sampled) continue; // warm-up and sampled runs
    runs.push(run);
  }
  results["transfer-program"] = timingSummary(runs);

  // Path B and the station cells, through `serve` as the engine drives them.
  const definitions = {};
  const definer = new NativeHost("definitions");
  for (const name of ["transfer-cell", "espresso", "pour-over"])
    definitions[name] = await hostDefinition(definer, name);
  await definer.close();
  for (const name of ["transfer-cell", "espresso", "pour-over"]) {
    const runs = [];
    for (let index = 0; index <= REPEATS; index++) {
      const host = new NativeHost(`${name}-${index}`);
      const sampled = index === REPEATS;
      const sampling = sampled ? startSampling(host.child.pid, name) : null;
      const run =
        name === "transfer-cell"
          ? await cellRun(host, definitions[name])
          : await stationRun(host, stationWorkloads[name], definitions[name]);
      const file = await stopSampling(sampling);
      if (file !== null) profiles[name] = [file];
      await host.close();
      const measured = {
        ...run,
        samples: run.fingerprint.samples,
        fingerprint: run.fingerprint.digest(),
      };
      if (sampled) assert.equal(measured.fingerprint, runs[0].fingerprint);
      else runs.push(measured);
    }
    results[name] = timingSummary(runs);
  }
  const breakdown = {};
  for (const [name, list] of Object.entries(profiles))
    breakdown[name] = profileBreakdown(
      list.map((file) => readFileSync(file, "utf8")).join("\n"),
      name,
    );
  return { results, breakdown };
}

// ------------------------------------------------------------------ wasm

async function wasmWorkloads() {
  const results = {};
  const transfer = [];
  for (let index = 0; index <= REPEATS; index++) {
    const run = await programRun(new WasmHost(await runtimeModule(runtime)));
    if (index > 0) transfer.push(run);
  }
  results["transfer-program"] = timingSummary(transfer);

  for (const name of ["transfer-cell", "espresso", "pour-over"]) {
    const runs = [];
    for (let index = 0; index < REPEATS; index++) {
      const host = new WasmHost(await runtimeModule(runtime));
      const definition = await hostDefinition(host, name);
      const run =
        name === "transfer-cell"
          ? await cellRun(host, definition)
          : await stationRun(host, stationWorkloads[name], definition);
      runs.push({
        ...run,
        samples: run.fingerprint.samples,
        fingerprint: run.fingerprint.digest(),
      });
    }
    results[name] = timingSummary(runs);
  }
  return results;
}

// ------------------------------------------------------------- profiling
// `sample` writes a call tree: each line has an indent, a sample count and a
// frame. A category counts the samples of its outermost matching frame, so a
// frame inside another frame of the same category is not counted twice. The
// shares are of the samples inside the advance handler, which holds the steps.

// mj_forward is a thin call to mj_forwardSkip, so the sampler shows the
// second forward of a step as mj_forwardSkip outside mj_step. The categories
// overlap: a serde_json frame that allocates counts in both.
const CATEGORIES = [
  // `integrate` is mj_step, or mj_step without its position and velocity
  // stages when the forward after the last step computed them.
  ["mj_step", /^mj_step$|::native::integrate$/],
  [
    "mj_forward after mj_step",
    /^mj_forward(Skip)?$/,
    { parent: /::(Engine|ApplianceEngine|StationEngine)::step$/ },
  ],
  ["inverse kinematics", /::solve_ik$/],
  ["mj_setConst", /^mj_setConst$/],
  ["name lookups", /^mj_(name2id|id2name)$|::(id|site|geom_name_of)$/],
  ["contact scans", /contact/i, { rust: true }],
  ["samples", /::sample$|::capture$|::body_poses$/, { rust: true }],
  ["serde_json", /serde_json|serde_core/],
  ["SHA-256", /^sha2::/],
  [
    "allocation, free and copy",
    /malloc|^_?free|free_tiny|_szone_free|realloc|^alloc::|drop_glue|_platform_mem(move|set)/,
  ],
];
const ACTIVE = /Host::answer|bakery_cell_command/;

// Rust v0 symbols (`_RNv…`) hold each name as a decimal length and the name.
// Their names in order, joined with `::`, are enough to match a frame.
function readable(frame) {
  if (!frame.startsWith("_R")) return frame;
  // Crate and impl disambiguators (`Cs8u1g…_`) are not names.
  frame = frame.replace(/[CMX]s[0-9A-Za-z]*_/g, "");
  const names = [];
  for (let index = 2; index < frame.length;) {
    const digits = /^\d+/.exec(frame.slice(index));
    if (digits === null) {
      index += 1;
      continue;
    }
    const start =
      index +
      digits[0].length +
      (frame[index + digits[0].length] === "_" ? 1 : 0);
    const length = Number(digits[0]);
    const name = frame.slice(start, start + length);
    if (length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      names.push(name);
      index = start + length;
    } else index += digits[0].length;
  }
  return names.join("::");
}

function profileBreakdown(text, name) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const match = /^([\s+!:|]*)(\d+)\s+(.+?)\s+\(in ([^)]+)\)/.exec(raw);
    if (match === null) continue;
    lines.push({
      depth: match[1].length,
      count: Number(match[2]),
      frame: readable(match[3].trim()),
      library: match[4],
    });
  }
  let active = 0;
  const counts = Object.fromEntries(CATEGORIES.map(([label]) => [label, 0]));
  const stack = [];
  for (const line of lines) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= line.depth)
      stack.pop();
    const insideActive = stack.some((entry) => entry.active);
    const isActive = ACTIVE.test(line.frame);
    if (isActive && !insideActive) active += line.count;
    const entry = {
      depth: line.depth,
      active: isActive,
      categories: new Set(),
    };
    if (insideActive || isActive) {
      for (const [label, pattern, rule = {}] of CATEGORIES) {
        if (!pattern.test(line.frame)) continue;
        if (rule.rust && line.library.includes("libmujoco")) continue;
        if (
          rule.parent &&
          !rule.parent.test(stack[stack.length - 1]?.frame ?? "")
        )
          continue;
        if (
          rule.inside &&
          !stack.some((parent) => rule.inside.test(parent.frame))
        )
          continue;
        if (stack.some((parent) => parent.categories.has(label))) continue;
        counts[label] += line.count;
        entry.categories.add(label);
      }
    }
    entry.frame = line.frame;
    for (const parent of stack)
      for (const label of parent.categories) entry.categories.add(label);
    stack.push(entry);
  }
  const shares = {};
  for (const [label, count] of Object.entries(counts))
    shares[label] = active === 0 ? null : round((100 * count) / active);
  return { workload: name, activeSamples: active, percentOfActive: shares };
}

// ------------------------------------------------------------------ main

if (options.parse !== undefined) {
  // Read sample files of an earlier run again, for a new category list.
  for (const file of options.parse)
    console.log(
      JSON.stringify(profileBreakdown(readFileSync(file, "utf8"), file)),
    );
  process.exit(0);
}
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });

const report = {
  plan: "Refactor 16 step 2 — the cost of one physics step",
  command: `node ${relative(root, fileURLToPath(import.meta.url))} ${process.argv.slice(2).join(" ")}`,
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  device: {
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpu: cpus()[0].model,
    node: process.version,
  },
  allowance: ALLOWANCE,
  repeats: REPEATS,
  binary: {
    path: relative(root, binary),
    sha256: sha256(readFileSync(binary)),
  },
  runtime: relative(root, runtime),
};
if (options.native) {
  const nativeResult = await nativeWorkloads();
  report.native = nativeResult.results;
  report.nativeProfile = nativeResult.breakdown;
}
if (options.wasm) report.wasm = await wasmWorkloads();
report.notMeasured = [
  "Wasm stack shares: the Wasm workloads are timed but not sampled",
  "The reference browser: Wasm runs under Node's V8 in this process",
  "Shares come from a 1 ms sampler; a frame that the compiler inlined counts in its caller",
];
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
const table = [];
for (const name of [
  "transfer-program",
  "transfer-cell",
  "espresso",
  "pour-over",
]) {
  table.push({
    workload: name,
    steps: (report.native ?? report.wasm)[name].steps,
    nativeMicrosPerStep: report.native?.[name].microsecondsPerStep ?? null,
    wasmMicrosPerStep: report.wasm?.[name].microsecondsPerStep ?? null,
    nativeFingerprint: report.native?.[name].fingerprint.slice(0, 12) ?? null,
    wasmFingerprint: report.wasm?.[name].fingerprint.slice(0, 12) ?? null,
  });
}
console.table(table);
for (const profile of Object.values(report.nativeProfile ?? {}))
  console.log(profile.workload, JSON.stringify(profile.percentOfActive));
