import { pathToFileURL } from "node:url";
import {
  buildExecutionBundle,
  prepareCell,
  runAppliance,
  runtimeModule,
} from "./build-execution-bundle.mjs";
// Real Rust/MuJoCo execution through the production scheduler, including process loss.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import * as currentEngine from "../../packages/production-simulation/src/execution-entry.ts";
import { CELL_CHECKPOINT_SCHEMA_VERSION } from "../../packages/production-simulation/src/execution-bundle.ts";
import { checkpointBody } from "../../packages/bakery-model/src/bakery-checkpoint.ts";
import { compileCafeShift } from "../../packages/production-simulation/src/recipes/bakery/cafe-shift.ts";
import { compileEspresso } from "../../packages/production-simulation/src/recipes/bakery/espresso.ts";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";

const appliance = process.argv[3] ?? "linea";
const mode = process.argv[4] ?? "espresso";
const grinder = process.argv[5] ?? null;
assert.ok(mode === "espresso" || mode === "cafe-shift");
assert.ok(appliance === "linea" || appliance === "eagle-one");
assert.ok(
  grinder === null ||
    grinder === "option-o-lagom-casa" ||
    grinder === "timemore-bricks-01s" ||
    grinder === "fellow-opus-2" ||
    grinder === "miicoffee-df64-gen2",
);
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: false });
const root = process.cwd();
const binary = resolve("crates/bakery-native/target/release/bakery-native");
const definitionFile = join(output, "definition.json");
const runtimeDirectory = process.env.PLAN_70_BROWSER_BUNDLE
  ? resolve(process.env.PLAN_70_BROWSER_BUNDLE)
  : null;
let E = currentEngine;
let retained = null;
const grinderArgs = grinder === null ? [] : ["--grinder", grinder];
if (runtimeDirectory !== null) {
  retained = await buildExecutionBundle(
    runtimeDirectory,
    join(output, "executions"),
  );
  E = await import(
    pathToFileURL(join(retained.directory, "production-engine.mjs")).href
  );
  writeFileSync(
    definitionFile,
    JSON.stringify(
      await prepareCell(runtimeDirectory, "espresso-cell", {
        fixture: "espresso",
        appliance,
        ...(grinder === null ? {} : { grinder }),
      }),
    ),
  );
} else
  execFileSync(binary, [
    "--root",
    root,
    "--output",
    definitionFile,
    "prepare-espresso-cell",
    "--appliance",
    appliance,
    "--cell",
    "espresso-cell",
    ...grinderArgs,
  ]);
const definition = JSON.parse(readFileSync(definitionFile, "utf8"));
assert.equal(definition.appliance, appliance);
if (grinder !== null) assert.equal(definition.grinder, grinder);
const parsed = E.parseNativeCell(definition);
assert.ok(parsed.ok, JSON.stringify(parsed));
const espressoRecipe = {
  revision: 1,
  orders: 2,
  appliance,
  ...(grinder === null ? {} : { grinder }),
};
const scenario =
  mode === "cafe-shift"
    ? await compileCafeShift(
        { espresso: espressoRecipe, financierLoads: 2 },
        parsed.value,
      )
    : await compileEspresso(espressoRecipe, parsed.value);
const finishSeconds = mode === "cafe-shift" ? 21600 : 56;
writeFileSync(
  join(output, "recipe.json"),
  JSON.stringify(
    mode === "cafe-shift"
      ? {
          kind: "cafe-shift-recipe",
          recipe: { espresso: espressoRecipe, financierLoads: 2 },
        }
      : { kind: "espresso-recipe", recipe: espressoRecipe },
    null,
    2,
  ),
);

writeFileSync(join(output, "scenario.json"), JSON.stringify(scenario, null, 2));
function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}
const source = createHash("sha256");
for (const file of readdirSync("packages/production-simulation/src", {
  recursive: true,
}).sort()) {
  if (file.endsWith(".ts"))
    source
      .update(file)
      .update(readFileSync(join("packages/production-simulation/src", file)));
}
const identity = {
  backend: "headless",
  protocolVersion: E.HOST_PROTOCOL_VERSION,
  checkpointSchemaVersion: CELL_CHECKPOINT_SCHEMA_VERSION,
  engineHash: source.digest("hex"),
  controllerSourceHash: definition.execution.controllerSourceHash,
  controllerHash: definition.execution.controllerHash,
  runtimeHash: definition.execution.runtimeHash,
};
const bundle =
  retained === null
    ? { id: hash(canonicalJson(identity)), ...identity }
    : retained.manifest.bundle;

class NativeTransport {
  pending = [];
  constructor(name) {
    this.child = spawn(
      binary,
      [
        "--root",
        root,
        "--output",
        join(output, `${name}-closed.json`),
        "serve",
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
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
  async close() {
    const done = once(this.child, "exit");
    this.child.stdin.end();
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
  async close() {
    await this.send({
      op: "espresso",
      command: { op: "dispose", cell: "espresso-cell" },
    });
  }
}
async function open(name, saved) {
  const transport =
    runtimeDirectory === null
      ? new NativeTransport(name)
      : new WasmTransport(await runtimeModule(runtimeDirectory));
  const host = collectingExecutionHost(E, transport);
  const reply = await host.handle({
    kind: "begin",
    bundle,
    cells: [definition],
    identity: {
      runId: "espresso-acceptance",
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
        ? { kind: "scenario", scenario }
        : {
            kind: "snapshot",
            document: saved.document,
            checkpoints: saved.artifacts,
          },
  });
  assert.equal(reply.kind, "began", JSON.stringify(reply));
  return { host, transport };
}
async function drive(host, until) {
  for (let count = 0; count < 2000; count++) {
    const reply = await host.handle({
      kind: "drive",
      turns: 128,
      until: until * 1e6,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    const current = await host.handle({ kind: "state" });
    assert.equal(current.kind, "state");
    if (mode === "cafe-shift" && count % 100 === 0)
      console.log({
        turn: count,
        seconds: current.run.position.time / 1e6,
        status: current.run.status.kind,
      });
    if (current.run.status.kind === "awaiting-inspection") {
      assert.equal(mode, "cafe-shift");
      const pending = reply.view.inspections.find(pendingInspection);
      assert.ok(pending);
      const request = {
        kind: "inspect",
        commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/g, "-")}`,
        expectedControlRevision: reply.view.controlRevision,
        task: pending.task,
        definition: pending.definition,
        lots: pending.lots,
        outcome: pending.task.startsWith("load-hazelnut-b#")
          ? "reject"
          : "accept",
        note: "Synthetic quality decision for the cafe shift acceptance journey",
      };
      const accepted = await host.handle(request);
      assert.equal(accepted.kind, "commanded");
      assert.equal(accepted.receipt.status, "accepted");
      const duplicate = await host.handle(request);
      assert.deepEqual(duplicate.receipt, accepted.receipt);
    }
    if (current.run.status.kind === "held")
      throw new Error(JSON.stringify(current.run.status));
    if (
      current.run.status.kind === "completed" ||
      current.run.position.time >= until * 1e6
    )
      return current.run;
  }
  throw new Error("Scheduler did not reach its bound");
}
const retainedArtifacts = new Map();
async function save(host, name) {
  const saved = await host.handle({ kind: "save" });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  for (const artifact of saved.artifacts)
    retainedArtifacts.set(artifact.digest, artifact);
  const artifacts = [];
  for (const entry of saved.document.artifacts) {
    const artifact = retainedArtifacts.get(entry.digest);
    assert.ok(artifact, `Missing saved artifact ${entry.digest}`);
    artifacts.push(artifact);
  }
  const portable = { kind: "saved", document: saved.document, artifacts };
  writeFileSync(join(output, `${name}.json`), JSON.stringify(portable));
  return portable;
}
const direct = await open("direct", null);
const uninterrupted = await drive(direct.host, finishSeconds);
assert.equal(uninterrupted.status.kind, "completed");
const directSave = await save(direct.host, "uninterrupted");
await direct.transport.close();
const first = await open("first", null);
await drive(first.host, 9);
const paused = await first.host.handle({
  kind: "pause",
  commandId: "pause-espresso",
});
assert.equal(paused.kind, "commanded", JSON.stringify(paused));
const checkpoint = await save(first.host, "paused");
await first.transport.close();
const restored = await open("restored", checkpoint);
assert.equal(
  (await restored.host.handle({ kind: "resume", commandId: "resume-espresso" }))
    .kind,
  "commanded",
);
const completed = await drive(restored.host, finishSeconds);
assert.equal(completed.status.kind, "completed");
const restoredSave = await save(restored.host, "restored");
const directWorld = await nativeWorld(directSave);
const restoredWorld = await nativeWorld(restoredSave);
assert.deepEqual(restoredWorld, directWorld);
if (mode === "espresso") {
  assert.equal(completed.tasks.filter(completedTask).length, 2);
  assert.equal(completed.tasks[1].startedAt, completed.tasks[0].completedAt);
} else {
  assert.deepEqual(completed.lots, uninterrupted.lots);
  assert.deepEqual(completed.carriers, uninterrupted.carriers);
  assert.equal(reported(completed, "packed-pieces"), 7);
  assert.equal(reported(completed, "rejected-pieces"), 8);
  assert.equal(reported(completed, "packed-mass"), 164500);
  assert.equal(reported(completed, "rejected-mass"), 188000);
}
for (const resource of completed.resources)
  assert.equal(resource.allocations.length, 0);
const espresso = restoredWorld.appliance.controller.espresso;
assert.equal(espresso.cups[0].mass_g, 0);
assert.equal(espresso.discarded_g, 0);
assert.ok(Math.abs(espresso.served_g - 72) < 1e-6);
assert.ok(
  Math.abs(espresso.drawn_water_g - espresso.served_g - espresso.drain_g) <
    1e-6,
);
assert.equal(restoredWorld.appliance.contents.kind, "empty");
if (grinder !== null) {
  assert.equal(restoredWorld.grinder.appliance, grinder);
  assert.equal(restoredWorld.grinder.contents.kind, "empty");
  assert.equal(restoredWorld.grinder.controller.motor.state.kind, "complete");
  assert.ok(restoredWorld.grinder.controller.motor.work_j > 0);
  assert.ok(restoredWorld.grinder.controller.motor.load_work_j > 0);
  assert.ok(restoredWorld.grinder.controller.motor.turns > 0);
}
let served = 0;
for (const event of completed.events)
  if (
    event.kind === "quantity-reported" &&
    event.destination === "served-espresso"
  )
    served += event.quantity.amount;
assert.equal(served, 72000);
const report = {
  passed: true,
  backend: runtimeDirectory === null ? "native" : "wasm",
  scope:
    mode === "cafe-shift"
      ? "Two financier loads and two espresso orders share one persistent run. Recovery during extraction preserves materials. Repeated quality decisions reject one load without duplicate output."
      : "Two espresso orders share the machine, cup and operator. A new native process resumes during the first extraction.",
  mode,
  finalSeconds: completed.position.time / 1e6,
  exactNativeContinuation: true,
  artifactCount: restoredSave.document.artifacts.length,
  artifactBytes: restoredSave.document.artifacts.reduce(sumArtifactBytes, 0),
  bundle: bundle.id,
};
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(report);
await restored.transport.close();
function sumArtifactBytes(total, artifact) {
  return total + artifact.byteLength;
}
function pendingInspection(item) {
  return item.kind === "pending";
}
function reported(run, destination) {
  let amount = 0;
  for (const event of run.events)
    if (event.kind === "quantity-reported" && event.destination === destination)
      amount += event.quantity.amount;
  return amount;
}
function completedTask(task) {
  return task.kind === "completed";
}
async function nativeWorld(saved) {
  // This journey defines exactly one espresso station.
  const digest = saved.document.state.cells[0].committed.checkpoint.digest;
  for (const artifact of saved.artifacts) {
    if (artifact.digest === digest)
      return checkpointBody(JSON.parse(artifact.content));
  }
  throw new Error("Saved native checkpoint is missing");
}

// Capture a real browser-controller rehearsal for the shared archive route journey.
if (runtimeDirectory !== null && mode === "espresso") {
  const { freshApplianceRequest, parseApplianceResult } =
    await import("../../packages/bakery-model/src/bakery-appliance-protocol.ts");
  const { prepareEspressoRun, saveEspressoRun } =
    await import("../../packages/bakery-model/src/espresso-rehearsal-file.ts");
  const module = await runtimeModule(runtimeDirectory);
  const name =
    appliance === "linea"
      ? "la-marzocco-linea-classic-s-2g"
      : "victoria-arduino-eagle-one-2g";
  let accepted = null;
  let request = freshApplianceRequest(
    name,
    "shared-espresso-acceptance",
    "warmup",
    { kind: "empty" },
    [
      {
        kind: "start",
        program: { kind: "espresso-warmup", coffee_c: 93, steam_c: 125 },
      },
    ],
  );
  for (let index = 0; index < 13; index++) {
    accepted = parseApplianceResult(
      runAppliance(module, request.file),
      request,
    );
    assert.equal(accepted.outcome.kind, "completed");
    request = accepted.continuation.request(accepted.runId, `warm-${index}`, [
      { kind: "advance", seconds: 120 },
    ]);
  }
  request = accepted.continuation.request(accepted.runId, "active-water", [
    { kind: "set-hot-water-dose", duration_s: 8 },
    { kind: "start", program: { kind: "espresso-hot-water-preset" } },
    { kind: "advance", seconds: 3 },
  ]);
  accepted = parseApplianceResult(runAppliance(module, request.file), request);
  assert.equal(accepted.outcome.kind, "completed");
  const saved = prepareEspressoRun(request, accepted);
  assert.equal(saved.telemetry.at(-1).hotWaterDose, 8);
  assert.ok(Math.abs(saved.telemetry.at(-1).cups[2].mass_g - 30) < 1e-6);
  writeFileSync(join(output, "appliance-save.json"), saveEspressoRun(saved));
}
