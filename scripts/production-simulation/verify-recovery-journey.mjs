import { collectingExecutionHost } from "./collecting-execution-host.mjs";
// Two weak-clamp transfers fail. A shared baker handles each rejected tray,
// and each arm return runs from the failed physical state. Two fresh processes
// continue saves taken during handling and return. Their final state must equal
// the uninterrupted run, including the native checkpoint and material totals.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import * as sourceEngine from "../../packages/production-simulation/src/execution-entry.ts";
import {
  coldCellJourneyAdapter,
  coldCellJourneySnapshot,
} from "../../packages/production-simulation/src/recipes/cold-cell-journey.ts";
import {
  buildExecutionBundle,
  prepareCell,
  runtimeModule,
} from "./build-execution-bundle.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert.equal(
  process.argv.length,
  3,
  "Provide a new acceptance output directory",
);
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false, "Preserve earlier evidence");
mkdirSync(join(output, "artifacts"), { recursive: true });
const binary =
  process.env.BAKERY_NATIVE_BINARY ??
  join(root, "crates/bakery-native/target/release/bakery-native");
const runtime = process.env.PLAN_70_BROWSER_BUNDLE;
const backend = runtime === undefined ? "headless" : "browser";
const definitionFile = join(output, "native-cell.json");
let native;
let E = sourceEngine;
let bundle;
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function value(result) {
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.value;
}
function save(name, record) {
  writeFileSync(join(output, name), `${canonicalJson(record)}\n`, {
    flag: "wx",
  });
}

if (runtime === undefined) {
  execFileSync(binary, [
    "--root",
    root,
    "--output",
    definitionFile,
    "prepare-cell",
    "--cell",
    "cold-cell-1",
  ]);
  native = JSON.parse(readFileSync(definitionFile, "utf8"));
  const engineDirectory = join(root, "packages/production-simulation/src");
  const hash = createHash("sha256");
  for (const file of readdirSync(engineDirectory, { recursive: true }).sort())
    if (file.endsWith(".ts"))
      hash.update(file).update(readFileSync(join(engineDirectory, file)));
  const content = {
    backend,
    protocolVersion: E.HOST_PROTOCOL_VERSION,
    checkpointSchemaVersion: E.CELL_CHECKPOINT_SCHEMA_VERSION,
    engineHash: hash.digest("hex"),
    controllerSourceHash: native.execution.controllerSourceHash,
    controllerHash: native.execution.controllerHash,
    runtimeHash: native.execution.runtimeHash,
  };
  bundle = { id: digest(canonicalJson(content)), ...content };
} else {
  native = await prepareCell(runtime, "cold-cell-1");
  save("native-cell.json", native);
  const built = await buildExecutionBundle(runtime, join(output, "executions"));
  bundle = built.manifest.bundle;
  E = await import(
    pathToFileURL(join(built.directory, "production-engine.mjs")).href
  );
}
native.clampForceN = 20;
native.ingredients.massKg = 2.5;
const compiled = value(
  coldCellJourneyAdapter.compile(
    await coldCellJourneySnapshot(
      {
        horizonSeconds: 240,
        orders: 2,
        trays: ["tray-a", "tray-b"],
        cell: {
          id: native.cellId,
          modelHash: native.modelHash,
          controllerSourceHash: native.execution.controllerSourceHash,
          timestepSeconds: 0.002,
          holdModel: "cold-cell-rest.1",
        },
        load: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
        unload: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
      },
      1,
    ),
  ),
);
// The baker is unavailable when the first transfer fails. The failed world
// must keep integrating while factory time reaches the baker's return.
const scenario = {
  ...compiled,
  resources: [
    ...compiled.resources,
    {
      kind: "batch",
      id: "shared-oven",
      capacity: 1,
      configuration: null,
      storage: "shared-oven",
      loadWindow: 10_000_000,
      programs: [{ id: "bake", duration: 20_000_000, evidence: "model" }],
    },
  ],
  destinations: [
    ...compiled.destinations,
    {
      id: "rejected-trays",
      role: "rejected-output",
      product: "portioned-tray",
    },
  ],
  storages: [
    ...compiled.storages,
    { id: "shared-oven", capacity: { kind: "carriers", slots: 1 }, cell: null },
    {
      id: "reject-shelf",
      capacity: { kind: "carriers", slots: 2 },
      cell: null,
    },
    { id: "full-shelf", capacity: { kind: "carriers", slots: 1 }, cell: null },
  ],
  carriers: [
    ...compiled.carriers,
    { id: "unrelated-tray", storage: "full-shelf" },
  ],
  availability: [
    {
      id: "baker-break",
      resource: "baker",
      interval: { start: 15_000_000, end: 30_000_000 },
    },
  ],
};
value(await E.admitScenario(scenario));
save("scenario.json", scenario);

class NativeHost {
  waiting = [];
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
    this.waiting.shift()?.resolve(JSON.parse(line));
  }
  exited() {
    for (const pending of this.waiting.splice(0))
      pending.reject(new Error("Native host exited"));
  }
  send(command) {
    const pending = Promise.withResolvers();
    this.waiting.push(pending);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return pending.promise;
  }
  async destroy() {
    const ended = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await ended;
  }
}
class WasmHost {
  constructor(module) {
    this.transport = E.wasmTransport(module, {
      encoder: new TextEncoder(),
      decoder: new TextDecoder(),
      encode,
      decode,
    });
  }
  send(command) {
    return this.transport.send(command);
  }
  async destroy() {
    this.transport = null;
  }
}
function encode(text) {
  return this.encoder.encode(text);
}
function decode(bytes) {
  return this.decoder.decode(bytes);
}
async function createHost(name) {
  const physics =
    runtime === undefined
      ? new NativeHost(name)
      : new WasmHost(await runtimeModule(runtime));
  return { physics, engine: collectingExecutionHost(E, physics) };
}
async function reply(host, request, kind) {
  const result = await host.engine.handle(request);
  assert.equal(result.kind, kind, JSON.stringify(result));
  return result;
}
function identity(number, parent) {
  return {
    runId: "recovery-journey",
    executionId: `execution-${number}`,
    hostSession: `host-${number}`,
    parent,
  };
}
async function runState(host) {
  return (await reply(host, { kind: "state" }, "state")).run;
}
async function drive(host, until = 240_000_000) {
  let result;
  for (let calls = 0; calls < 10_000; calls += 1) {
    result = await reply(host, { kind: "drive", turns: 1000, until }, "drove");
    if (
      result.view.time >= until ||
      ["blocked", "completed", "stopped-at-limit"].includes(
        result.view.status.kind,
      )
    )
      return runState(host);
  }
  throw new Error("The recovery journey exceeded its host-call cap");
}
function recoveryCommand(task, index) {
  return {
    kind: "recover",
    commandId: `recover-${index}`,
    task: task.id,
    resource: "baker",
    storage: "reject-shelf",
    handling: 5_000_000,
    evidence: "assumed",
    reports: [{ product: "portioned-tray", destination: "rejected-trays" }],
  };
}
async function commanded(host, request, status, reason) {
  const result = await reply(host, request, "commanded");
  assert.equal(result.receipt.status, status, JSON.stringify(result.receipt));
  if (reason !== undefined) assert.equal(result.receipt.reason, reason);
  return result.receipt;
}
const artifacts = new Map();
async function checkpoint(host, name) {
  const saved = await reply(host, { kind: "save" }, "saved");
  for (const artifact of saved.artifacts) {
    assert.equal(digest(artifact.content), artifact.digest);
    artifacts.set(artifact.digest, artifact.content);
    const file = join(output, "artifacts", `${artifact.digest}.json`);
    if (!existsSync(file)) writeFileSync(file, artifact.content);
  }
  value(await E.openResumable(saved.document, backend, [bundle]));
  save(`${name}.json`, saved.document);
  return saved.document;
}
async function restart(host, name, number) {
  await commanded(
    host,
    { kind: "pause", commandId: `pause-${number}` },
    "accepted",
  );
  const document = await checkpoint(host, `${name}-save-${number}`);
  await rejectAlteredRecovery(document, `${name}-${number}`);
  const before = await runState(host);
  await host.physics.destroy();
  const fresh = await createHost(`${name}-${number}`);
  const checkpoints = [];
  for (const cell of before.cells)
    checkpoints.push({
      digest: cell.committed.checkpoint.digest,
      content: artifacts.get(cell.committed.checkpoint.digest),
    });
  await reply(
    fresh,
    {
      kind: "begin",
      bundle,
      cells: [native],
      identity: identity(number, {
        snapshot: document.snapshot,
        execution: before.identity.executionId,
      }),
      origin: { kind: "snapshot", document, checkpoints },
    },
    "began",
  );
  return fresh;
}
async function rejectAlteredRecovery(document, name) {
  const changedClaim = structuredClone(document.state);
  changedClaim.tasks.find(isRecovering).recovery.resource = "transfer-arm";
  const changedStage = structuredClone(document.state);
  const recovery = changedStage.tasks.find(isRecovering).recovery;
  recovery.phase = recovery.phase === "handling" ? "returning" : "handling";
  for (const [suffix, state] of [
    ["claim", changedClaim],
    ["phase", changedStage],
  ]) {
    // Recompute the document digest, so the state decoder must reject the
    // invalid claim or phase instead of only detecting changed bytes.
    const altered = await E.resumableDocument(
      state,
      bundle,
      document.artifacts,
    );
    const opened = await E.openResumable(altered, backend, [bundle]);
    assert.equal(opened.ok, false, "An altered recovery cannot resume");
    save(`${name}-refused-${suffix}.json`, {
      document: altered,
      result: opened,
    });
  }
}
async function journey(name, interrupt) {
  let host = await createHost(`${name}-0`);
  try {
    await reply(
      host,
      {
        kind: "begin",
        bundle,
        cells: [native],
        identity: identity(0, null),
        origin: { kind: "scenario", scenario },
      },
      "began",
    );
    let state = await drive(host, 23_000_000);
    const failed = state.tasks.find(isFailedTransfer);
    assert.ok(failed);
    assert.equal(state.cells[0].committed.boundary, state.position.time);
    assert.ok(
      state.position.time > failed.failedAt,
      "Failed physics advances while the baker is away",
    );
    const first = recoveryCommand(failed, 1);
    await commanded(host, first, "rejected", "recovery_resource_busy");
    state = await drive(host);
    assert.equal(state.status.kind, "blocked");
    assert.equal(state.position.time, 30_000_000);
    const failedView = (await reply(host, { kind: "state" }, "state")).view;
    assert.ok(E.parseHostView(failedView).ok);
    assert.deepEqual(failedView.recoveries[0].contents, {
      kind: "available",
      carrier: "tray-a",
      products: [
        { product: "portioned-tray", destinations: ["rejected-trays"] },
      ],
    });
    const failedDocument = await checkpoint(host, `${name}-failed`);
    const failedArtifacts = [];
    for (const entry of failedDocument.artifacts)
      failedArtifacts.push({
        digest: entry.digest,
        content: artifacts.get(entry.digest),
      });
    save(`${name}-failure-file.json`, {
      kind: "saved",
      document: failedDocument,
      artifacts: failedArtifacts,
    });
    await commanded(
      host,
      { ...first, storage: "shared-oven" },
      "rejected",
      "recovery_unavailable",
    );
    await commanded(
      host,
      { ...first, resource: "shared-oven" },
      "rejected",
      "recovery_unavailable",
    );
    await commanded(
      host,
      { ...first, storage: "full-shelf" },
      "rejected",
      "recovery_destination_full",
    );
    await commanded(
      host,
      { ...first, reports: [] },
      "rejected",
      "recovery_unavailable",
    );
    const before = await host.physics.send({
      op: "observe",
      cell: native.cellId,
    });
    const accepted = await commanded(host, first, "accepted");
    assert.deepEqual(await commanded(host, first, "accepted"), accepted);
    await commanded(
      host,
      { ...first, handling: 6_000_000 },
      "rejected",
      "conflicting_payload",
    );
    state = await drive(host, 31_000_000);
    assert.equal(state.tasks.find(isRecovering).recovery.phase, "handling");
    if (interrupt) host = await restart(host, name, 1);
    state = await drive(host, 38_000_000);
    assert.equal(state.tasks.find(isRecovering).recovery.phase, "returning");
    assert.equal(state.cells[0].slot.kind, "inactive");
    const returning = await host.physics.send({
      op: "observe",
      cell: native.cellId,
    });
    assert.notDeepEqual(
      returning.observation.arm,
      before.observation.arm,
      "The arm physically moves during recovery",
    );
    if (interrupt) host = await restart(host, name, 2);
    state = await drive(host);
    const second = state.tasks.find(isFailedTransfer);
    assert.ok(
      second && second.id !== failed.id,
      "The next order uses the recovered cell",
    );
    assert.equal(state.tasks.filter(isResolvedFailure).length, 1);
    await commanded(host, recoveryCommand(second, 2), "accepted");
    state = await drive(host);
    assert.equal(state.status.kind, "completed");
    assert.equal(E.drainStatus(state).kind, "drained");
    assert.equal(state.tasks.filter(isResolvedFailure).length, 2);
    assert.equal(state.tasks.filter(isCancelled).length, 2);
    assert.equal(state.events.filter(isRecoveryCompleted).length, 2);
    assert.equal(state.events.filter(isRecoveryFailed).length, 0);
    assert.ok(state.resources.every(isFree));
    assert.equal(state.storages.find(isRejectShelf).occupants.length, 2);
    assert.ok(state.storages.every(noReservations));
    const results = E.runResults(state, {
      after: null,
      through: state.position.time,
    });
    assert.equal(results.ordersCompleted, 0);
    assert.equal(results.reported.find(isRejectedOutput).amount, 2);
    assert.ok(results.stock.every(isEmptyStock));
    assert.ok(results.orders.every(isFailedOrder));
    const beforeRecovery = E.observationView(state, 30_000_000);
    assert.ok(beforeRecovery.results.orders.every(isOpenOrder));
    assert.ok(beforeRecovery.results.stock.some(hasUnresolvedContents));
    save(`${name}-before-recovery-observation.json`, beforeRecovery);
    await checkpoint(host, `${name}-final-save`);
    save(`${name}-state.json`, state);
    save(`${name}-results.json`, results);
    return state;
  } finally {
    await host.physics.destroy();
  }
}
function isFailedTransfer(task) {
  return task.kind === "recovery-required";
}
function isRecovering(task) {
  return task.kind === "recovering";
}
function isResolvedFailure(task) {
  return task.kind === "failed";
}
function isCancelled(task) {
  return task.kind === "cancelled";
}
function isRecoveryCompleted(event) {
  return event.kind === "recovery-completed";
}
function isRecoveryFailed(event) {
  return event.kind === "recovery-failed";
}
function isFree(resource) {
  return resource.allocations.length === 0;
}
function isRejectShelf(storage) {
  return storage.id === "reject-shelf";
}
function noReservations(storage) {
  return storage.reservations.length === 0;
}
function isRejectedOutput(report) {
  return report.role === "rejected-output";
}
function isEmptyStock(stock) {
  return stock.remaining === 0;
}
function isFailedOrder(order) {
  return order.kind === "failed";
}
function isOpenOrder(order) {
  return order.kind === "open";
}
function hasUnresolvedContents(stock) {
  return stock.product === "portioned-tray" && stock.remaining === 1;
}
function domainEvents(state) {
  const result = [];
  for (const { sequence, execution, ...event } of state.events)
    if (event.kind !== "command-admitted") result.push(event);
  return result;
}
const reference = await journey("reference", false);
const continued = await journey("continued", true);
assert.deepEqual(domainEvents(continued), domainEvents(reference));
for (const key of [
  "tasks",
  "instances",
  "carriers",
  "lots",
  "resources",
  "storages",
  "cells",
  "status",
])
  assert.deepEqual(continued[key], reference[key], key);
save("acceptance.json", {
  verdict: "passed",
  backend,
  bundle: bundle.id,
  simulatedSeconds: reference.position.time / 1_000_000,
  recoveries: 2,
  freshHosts: 2,
  rejectedTrays: 2,
  automaticRetries: 0,
  checkpoint: reference.cells[0].committed.checkpoint,
  domainEvents: domainEvents(reference).length,
  reproduction: `node scripts/production-simulation/verify-recovery-journey.mjs NEW_OUTPUT_DIRECTORY`,
  runtime: runtime ?? null,
});
console.log(
  `Recovery journey passed (${backend}): two failed orders, two recoveries, two fresh hosts. Artifact: ${output}`,
);
