// The robotic pour-over brew through the production engine and the Rust/MuJoCo
// station, native or Wasm. One case per operator outcome:
//
//   node --experimental-strip-types scripts/production-simulation/verify-pour-over-journey.mjs OUTPUT [CASE...]
//
// CASE is nominal, interrupted, kettle-420, kettle-700, grip-fault or
// slow-drainage; all run when none is named. PLAN_70_BROWSER_BUNDLE selects a
// retained browser runtime instead of the native runner.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as currentEngine from "../../packages/production-simulation/src/execution-entry.ts";
import { CELL_CHECKPOINT_SCHEMA_VERSION } from "../../packages/production-simulation/src/execution-bundle.ts";
import { checkpointBody } from "../../packages/bakery-model/src/bakery-checkpoint.ts";
import {
  POUR_OVER_SCHEDULE,
  compilePourOver,
} from "../../packages/production-simulation/src/recipes/bakery/pour-over.ts";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";

const output = resolve(process.argv[2]);
const CASES = [
  "nominal",
  "interrupted",
  "kettle-420",
  "kettle-700",
  "grip-fault",
  "slow-drainage",
];
const selected = process.argv.length > 3 ? process.argv.slice(3) : CASES;
for (const name of selected) assert.ok(CASES.includes(name), name);
mkdirSync(output, { recursive: false });
const root = process.cwd();
const binary = resolve("crates/bakery-native/target/release/bakery-native");
const runtimeDirectory = process.env.PLAN_70_BROWSER_BUNDLE
  ? resolve(process.env.PLAN_70_BROWSER_BUNDLE)
  : null;
let E = currentEngine;
let retained = null;
if (runtimeDirectory !== null) {
  retained = await buildExecutionBundle(
    runtimeDirectory,
    join(output, "executions"),
  );
  E = await import(
    pathToFileURL(join(retained.directory, "production-engine.mjs")).href
  );
}
const MS = 1e6;
/** The pause lands inside the second pour's regulated flow. */
const PAUSE_SECONDS = 56;
const HORIZON_SECONDS = 420;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const selectedGrinder = process.env.POUR_OVER_GRINDER ?? null;
assert.ok(
  selectedGrinder === null ||
    selectedGrinder === "option-o-lagom-casa" ||
    selectedGrinder === "timemore-bricks-01s" ||
    selectedGrinder === "fellow-opus-2" ||
    selectedGrinder === "miicoffee-df64-gen2",
);

async function prepare(caseDirectory, station) {
  const file = join(caseDirectory, "definition.json");
  const args = [
    "prepare-pour-over-cell",
    "--cell",
    "pour-over-cell",
    "--kettle-water-g",
    String(station.kettleWaterG),
    "--drainage",
    station.drainage,
    "--fault",
    station.fault,
    ...(station.grinder === undefined ? [] : ["--grinder", station.grinder]),
  ];
  if (runtimeDirectory === null)
    execFileSync(binary, ["--root", root, "--output", file, ...args]);
  else
    writeFileSync(
      file,
      JSON.stringify(
        await prepareCell(runtimeDirectory, "pour-over-cell", {
          fixture: "pour-over",
          kettleWaterG: station.kettleWaterG,
          drainage: station.drainage,
          fault: station.fault,
          ...(station.grinder === undefined
            ? {}
            : { grinder: station.grinder }),
        }),
      ),
    );
  return JSON.parse(readFileSync(file, "utf8"));
}

const engineSource = createHash("sha256");
for (const file of readdirSync("packages/production-simulation/src", {
  recursive: true,
}).sort())
  if (file.endsWith(".ts"))
    engineSource
      .update(file)
      .update(readFileSync(join("packages/production-simulation/src", file)));
const engineHash = engineSource.digest("hex");

function bundleFor(definition) {
  if (retained !== null) return retained.manifest.bundle;
  const identity = {
    backend: "headless",
    protocolVersion: E.HOST_PROTOCOL_VERSION,
    checkpointSchemaVersion: CELL_CHECKPOINT_SCHEMA_VERSION,
    engineHash,
    controllerSourceHash: definition.execution.controllerSourceHash,
    controllerHash: definition.execution.controllerHash,
    runtimeHash: definition.execution.runtimeHash,
  };
  return { id: sha256(canonicalJson(identity)), ...identity };
}

class NativeTransport {
  pending = [];
  constructor(file) {
    this.child = spawn(binary, ["--root", root, "--output", file, "serve"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.child.stdout }).on(
      "line",
      this.receive.bind(this),
    );
    this.child.on("exit", this.exited.bind(this));
  }
  receive(line) {
    this.pending.shift()?.resolve(JSON.parse(line));
  }
  exited() {
    for (const pending of this.pending.splice(0))
      pending.reject(new Error("Native process exited"));
  }
  send(command) {
    const pending = Promise.withResolvers();
    this.pending.push(pending);
    this.child.stdin.write(JSON.stringify(command) + "\n");
    return pending.promise;
  }
  /** Ends the execution host's process without a closing exchange. */
  async terminate() {
    const done = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await done;
  }
}
class WasmTransport {
  constructor(module) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    this.transport = E.wasmTransport(module, {
      encode: encoder.encode.bind(encoder),
      decode: decoder.decode.bind(decoder),
    });
  }
  send(command) {
    return this.transport.send(command);
  }
  /** A Wasm host ends with its module; nothing of it survives. */
  async terminate() {
    this.transport = null;
  }
}

class Brew {
  constructor(caseDirectory, definition, scenario) {
    this.caseDirectory = caseDirectory;
    this.definition = definition;
    this.scenario = scenario;
    this.bundle = bundleFor(definition);
    this.artifacts = new Map();
  }
  async open(name, saved) {
    const transport =
      runtimeDirectory === null
        ? new NativeTransport(join(this.caseDirectory, `${name}-closed.json`))
        : new WasmTransport(await runtimeModule(runtimeDirectory));
    const host = collectingExecutionHost(E, transport);
    const reply = await host.handle({
      kind: "begin",
      bundle: this.bundle,
      cells: [this.definition],
      identity: {
        runId: "pour-over-acceptance",
        executionId: name,
        hostSession: `host-${name}`,
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
          ? { kind: "scenario", scenario: this.scenario }
          : {
              kind: "snapshot",
              document: saved.document,
              checkpoints: saved.artifacts,
            },
    });
    assert.equal(reply.kind, "began", JSON.stringify(reply));
    return { host, transport, latest: null };
  }
  async drive(session, until) {
    for (let count = 0; count < 20000; count++) {
      const reply = await session.host.handle({
        kind: "drive",
        turns: 64,
        until: until * MS,
      });
      assert.equal(reply.kind, "drove", JSON.stringify(reply).slice(0, 2000));
      for (const observation of reply.physics?.observations ?? [])
        if (observation.kind !== "unavailable")
          session.latest = JSON.parse(observation.content);
      const current = await session.host.handle({ kind: "state" });
      assert.equal(current.kind, "state");
      const status = current.run.status.kind;
      if (
        status === "completed" ||
        status === "held" ||
        status === "blocked" ||
        current.run.position.time >= until * MS
      )
        return current.run;
    }
    throw new Error("The scheduler did not reach its bound");
  }
  async save(session, name) {
    const saved = await session.host.handle({ kind: "save" });
    assert.equal(saved.kind, "saved", JSON.stringify(saved).slice(0, 2000));
    for (const artifact of saved.artifacts)
      this.artifacts.set(artifact.digest, artifact);
    const artifacts = [];
    for (const entry of saved.document.artifacts) {
      const artifact = this.artifacts.get(entry.digest);
      assert.ok(artifact, `Missing saved artifact ${entry.digest}`);
      artifacts.push(artifact);
    }
    const portable = { kind: "saved", document: saved.document, artifacts };
    const text = JSON.stringify(portable);
    writeFileSync(join(this.caseDirectory, `${name}.json`), text);
    return { ...portable, sha256: sha256(text), bytes: text.length };
  }
}

function nativeWorld(saved) {
  const digest = saved.document.state.cells[0].committed.checkpoint.digest;
  for (const artifact of saved.artifacts)
    if (artifact.digest === digest)
      return { digest, world: checkpointBody(JSON.parse(artifact.content)) };
  throw new Error("The saved station checkpoint is missing");
}

function reportOf(session) {
  const sample = session.latest?.samples?.at(-1);
  assert.ok(sample?.report, "The terminal sample carries the brew report");
  return { report: sample.report, sample };
}

function eventsOf(run, kind) {
  return run.events.filter((event) => event.kind === kind);
}

function produced(run, product) {
  return eventsOf(run, "lot-produced").filter(
    (event) => event.product === product,
  );
}

/** Water and coffee stay accounted, whatever the outcome. */
function waterBalance(world, station) {
  const water = world.water;
  const total =
    water.kettleKg +
    water.airborne.reduce((sum, parcel) => sum + parcel.massKg, 0) +
    water.absorbedKg +
    water.freeKg +
    water.serverKg +
    water.spillKg +
    water.evaporatedKg;
  assert.ok(Math.abs(total - station.kettleWaterG / 1000) < 1e-9);
  return {
    kettleG: water.kettleKg * 1000,
    airborneG:
      water.airborne.reduce((sum, parcel) => sum + parcel.massKg, 0) * 1000,
    bedG: (water.absorbedKg + water.freeKg) * 1000,
    serverG: water.serverKg * 1000,
    spillG: water.spillKg * 1000,
    evaporatedG: water.evaporatedKg * 1000,
    totalG: total * 1000,
  };
}

/** The brew met the published schedule within the declared tolerances. */
function checkPours(report) {
  assert.equal(report.pours.length, POUR_OVER_SCHEDULE.length);
  for (const [index, pour] of report.pours.entries()) {
    const schedule = POUR_OVER_SCHEDULE[index];
    assert.equal(pour.targetG, schedule.cumulativeG);
    assert.ok(Math.abs(pour.finalG - schedule.cumulativeG) <= 1, "mass");
    assert.ok(Math.abs(pour.detectedS - schedule.startS) <= 1, "start");
    assert.ok(Math.abs(pour.durationS - 10) <= 2, "duration");
    assert.ok(pour.maxLandingRadiusM <= 0.04, "bed area");
    assert.equal(pour.offBedG, 0);
    assert.equal(pour.spillG, 0);
  }
}

function checkCompleted(run, world, station) {
  assert.equal(run.status.kind, "completed");
  for (const resource of run.resources)
    assert.equal(resource.allocations.length, 0);
  assert.equal(eventsOf(run, "order-completed").length, 1);
  const beverage = produced(run, "brewed-coffee");
  assert.equal(beverage.length, 1, "exactly one beverage output");
  const lots = eventsOf(run, "lot-produced");
  const exits = eventsOf(run, "quantity-reported").filter(
    (event) => event.role === "loss",
  );
  const measured =
    lots.reduce((sum, event) => sum + event.quantity.amount, 0) +
    exits.reduce((sum, event) => sum + event.quantity.amount, 0);
  assert.equal(measured, station.kettleWaterG * 1000 + 27000);
  // The beverage stays in the server: it is stock, not served output.
  assert.equal(
    eventsOf(run, "quantity-reported").filter(
      (event) => event.role === "final-output",
    ).length,
    0,
  );
  assert.equal(world.status, "brewed");
  if (station.grinder !== undefined) {
    assert.equal(world.grinder.appliance, station.grinder);
    assert.equal(world.grinder.contents.kind, "empty");
    assert.equal(world.grinder.controller.motor.state.kind, "complete");
    assert.ok(world.grinder.controller.motor.work_j > 0);
    assert.ok(world.grinder.controller.motor.load_work_j > 0);
    assert.ok(world.grinder.controller.motor.turns > 0);
  }
  return {
    beverageMg: beverage[0].quantity.amount,
    measuredMg: measured,
    lots: lots.map((event) => ({
      product: event.product,
      mg: event.quantity.amount,
    })),
    losses: exits.map((event) => ({
      product: event.product,
      mg: event.quantity.amount,
    })),
  };
}

function checkKettleRests(sample) {
  // The kettle base rests on its stand and the fingers are open.
  assert.ok(Math.abs(sample.kettle[2] - 0.83) < 0.002, "kettle on stand");
  assert.ok(
    sample.fingers.every((finger) => finger > 0.01),
    "fingers open",
  );
}

const results = {};
for (const name of selected) {
  const caseDirectory = join(output, name);
  mkdirSync(caseDirectory);
  const station = {
    kettleWaterG:
      name === "kettle-420" ? 420 : name === "kettle-700" ? 700 : 500,
    drainage: name === "slow-drainage" ? "reduced" : "nominal",
    fault: name === "grip-fault" ? "lost-grip" : "none",
    ...(selectedGrinder === null ? {} : { grinder: selectedGrinder }),
  };
  const recipe = { revision: 1, ...station };
  writeFileSync(
    join(caseDirectory, "recipe.json"),
    JSON.stringify({ kind: "pour-over-recipe", recipe }, null, 2),
  );
  const definition = await prepare(caseDirectory, station);
  const cell = E.parseNativeCell(definition);
  assert.ok(cell.ok, JSON.stringify(cell));
  const scenario = await compilePourOver(recipe, cell.value);
  writeFileSync(
    join(caseDirectory, "scenario.json"),
    JSON.stringify(scenario, null, 2),
  );
  const brew = new Brew(caseDirectory, definition, scenario);
  const started = Date.now();
  if (name === "interrupted") {
    const direct = await brew.open("uninterrupted", null);
    const whole = await brew.drive(direct, HORIZON_SECONDS);
    const wholeSave = await brew.save(direct, "uninterrupted");
    await direct.transport.terminate();
    const first = await brew.open("first", null);
    await brew.drive(first, PAUSE_SECONDS);
    const paused = await first.host.handle({
      kind: "pause",
      commandId: "pause-pour-2",
    });
    assert.equal(paused.kind, "commanded", JSON.stringify(paused));
    const checkpoint = await brew.save(first, "paused");
    const pausedWorld = nativeWorld(checkpoint).world;
    assert.equal(pausedWorld.operation.kind, "running");
    assert.equal(pausedWorld.operation.controller.phase.kind, "pour");
    assert.equal(pausedWorld.operation.controller.phase.index, 1);
    const inFlight = pausedWorld.water.airborne.length;
    // End the execution host; the save is all that continues.
    await first.transport.terminate();
    const restored = await brew.open("restored", checkpoint);
    const resumed = await restored.host.handle({
      kind: "resume",
      commandId: "resume-pour-2",
    });
    assert.equal(resumed.kind, "commanded", JSON.stringify(resumed));
    const completed = await brew.drive(restored, HORIZON_SECONDS);
    const restoredSave = await brew.save(restored, "restored");
    await restored.transport.terminate();
    const a = nativeWorld(wholeSave);
    const b = nativeWorld(restoredSave);
    assert.equal(b.digest, a.digest, "identical final station checkpoint");
    assert.deepEqual(b.world, a.world);
    assert.deepEqual(completed.lots, whole.lots);
    const wholeSummary = checkCompleted(whole, a.world, station);
    const summary = checkCompleted(completed, b.world, station);
    assert.deepEqual(summary, wholeSummary);
    const { report, sample } = reportOf(restored);
    checkPours(report);
    checkKettleRests(sample);
    results[name] = {
      pausedSeconds: PAUSE_SECONDS,
      pausedPhase: pausedWorld.operation.controller.phase,
      pausedReadingG: pausedWorld.operation.controller.scale.readingG,
      parcelsInFlight: inFlight,
      finalCheckpoint: b.digest,
      identicalToUninterrupted: true,
      ...summary,
      report,
      water: waterBalance(b.world, station),
      saves: {
        uninterrupted: wholeSave.sha256,
        paused: checkpoint.sha256,
        restored: restoredSave.sha256,
      },
    };
  } else {
    const session = await brew.open("brew", null);
    const run = await brew.drive(session, HORIZON_SECONDS);
    if (name === "grip-fault") {
      assert.equal(eventsOf(run, "task-failed").length, 1);
      assert.equal(produced(run, "brewed-coffee").length, 0);
      assert.equal(eventsOf(run, "order-completed").length, 0);
      assert.ok(run.resources.some((resource) => resource.allocations.length));
      const { report } = reportOf(session);
      const world = (
        await session.transport.send({
          op: "pour-over",
          command: { op: "export", cell: "pour-over-cell" },
        })
      ).reply;
      const station_world = checkpointBody(JSON.parse(world.content));
      assert.equal(station_world.status, "held");
      assert.equal(station_world.model.gripEnabled, false);
      results[name] = {
        status: run.status.kind,
        failed: eventsOf(run, "task-failed")[0],
        faultStep: report.faultStep,
        report,
        water: waterBalance(station_world, station),
        checkpoint: world.checkpoint.digest,
      };
      writeFileSync(
        join(caseDirectory, "failed-checkpoint.json"),
        world.content,
      );
    } else {
      const saved = await brew.save(session, "completed");
      const { digest, world } = nativeWorld(saved);
      const summary = checkCompleted(run, world, station);
      const { report, sample } = reportOf(session);
      checkPours(report);
      checkKettleRests(sample);
      if (name === "slow-drainage") {
        assert.ok(report.brewS > 210, "slow brew");
        assert.deepEqual(
          report.deviations.map((deviation) => deviation.kind),
          ["brew-time"],
        );
      } else {
        assert.ok(report.brewS >= 150 && report.brewS <= 210, "brew window");
        assert.deepEqual(report.deviations, []);
      }
      results[name] = {
        ...summary,
        report,
        water: waterBalance(world, station),
        finalCheckpoint: digest,
        save: saved.sha256,
        saveBytes: saved.bytes,
      };
    }
    await session.transport.terminate();
  }
  results[name].wallSeconds = (Date.now() - started) / 1000;
  writeFileSync(
    join(caseDirectory, "result.json"),
    JSON.stringify(results[name], null, 2),
  );
  console.log(name, "passed", results[name].wallSeconds, "s");
}
const summary = {
  passed: true,
  backend: runtimeDirectory === null ? "native" : "wasm",
  definitionExecution: JSON.parse(
    readFileSync(join(output, selected[0], "definition.json"), "utf8"),
  ).execution,
  bundle: retained?.manifest.bundle.id ?? null,
  cases: results,
};
writeFileSync(join(output, "report.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ passed: true, cases: Object.keys(results) }));
