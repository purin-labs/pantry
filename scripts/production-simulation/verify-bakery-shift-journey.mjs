import { collectingExecutionHost } from "./collecting-execution-host.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import { compileBakeryShift } from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh evidence directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false);
mkdirSync(output, { recursive: true });
const engineDirectory = resolve(
  `apps/portal/public/bakery-physics/executions/${manifest.bundle.id}`,
);
const runtime = resolve(
  `apps/portal/public/bakery-physics/bundles/${manifest.runtime.id}`,
);
const E = await import(
  pathToFileURL(join(engineDirectory, manifest.engine.file)).href
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = {
  encode: encoder.encode.bind(encoder),
  decode: decoder.decode.bind(decoder),
};
const cell = await prepareCell(runtime, "tea-pan-cell", {
  fixture: "pan-staging",
});
save("cell-definition.json", cell);
const input = { financierLoads: 2, milkTeaBatches: 2 };
const scenario = value(await compileBakeryShift(input, cell));
value(await E.admitScenario(scenario));
save("recipe.json", { kind: "bakery-shift-recipe", recipe: input });
save("execution.json", manifest);
save("scenario.json", scenario);

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}
function save(name, data) {
  writeFileSync(join(output, name), `${canonicalJson(data)}\n`);
}
async function open(scenario, saved, leg) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtime), codec),
  );
  const reply = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells: [cell],
    identity: {
      runId: "bakery-mvp-acceptance",
      executionId: `tea-${leg}`,
      hostSession: `host-${leg}`,
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
  return host;
}
async function drive(host, until = 14_400_000_000) {
  for (let turn = 0; turn < 2000; turn++) {
    const reply = await host.handle({ kind: "drive", turns: 128, until });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (
      reply.view.time >= until ||
      [
        "completed",
        "blocked",
        "stopped-at-limit",
        "awaiting-inspection",
      ].includes(reply.view.status.kind)
    ) {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      return { run: state.run, view: reply.view };
    }
  }
  throw new Error("Tea exceeded its execution bound");
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
function task(run, batch, key) {
  for (const entry of run.tasks)
    if (entry.id === `milk-tea-batches#${batch}/${key}`) return entry;
  throw new Error(`Missing ${batch}/${key}`);
}
async function inspect(host, view, outcome, checkRefusals) {
  const pending = view.inspections.find(pendingInspection);
  assert.ok(pending);
  const request = {
    kind: "inspect",
    commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/g, "-")}`,
    expectedControlRevision: view.controlRevision,
    task: pending.task,
    definition: pending.definition,
    lots: pending.lots,
    outcome,
    note: "Synthetic extraction review for acceptance",
  };
  if (checkRefusals) {
    const wrong = await host.handle({
      ...request,
      commandId: "wrong-tea-lot",
      lots: ["wrong-lot"],
    });
    assert.equal(wrong.receipt.reason, "inspection_binding_mismatch");
  }
  const reply = await host.handle(request);
  assert.equal(reply.kind, "commanded", JSON.stringify(reply));
  assert.equal(reply.receipt.status, "accepted", JSON.stringify(reply));
  const duplicate = await host.handle(request);
  assert.deepEqual(duplicate.receipt, reply.receipt);
}
async function finish(host, first, rejectLate) {
  let boundary = first;
  const timings = [];
  for (let reviews = 0; reviews < 6; reviews++) {
    if (boundary.run.status.kind !== "awaiting-inspection") break;
    const pending = boundary.view.inspections.find(pendingInspection);
    const timing = teaStrainTiming(
      boundary.run.definition.scenario,
      boundary.view.resourceHistory,
      pending.task,
    );
    if (pending.task.endsWith("/inspect-strained-tea"))
      assert.notEqual(timing.kind, "unavailable");
    timings.push({ task: pending.task, ...timing });
    for (const id of pending.lots) {
      let held = false;
      for (const lot of boundary.run.lots)
        if (lot.id === id) held = lot.disposition === "held";
      assert.equal(held, true);
    }
    await inspect(
      host,
      boundary.view,
      rejectLate && pending.task === "milk-tea-batches#0/inspect-strained-tea"
        ? "reject"
        : "accept",
      reviews === 0,
    );
    boundary = await drive(host);
  }
  assert.equal(
    boundary.run.status.kind,
    "completed",
    JSON.stringify(boundary.run.status),
  );
  return { ...boundary, timings };
}

function processEvents(run) {
  const events = [];
  for (const { sequence, execution, ...event } of run.events)
    if (!["command-admitted", "pause-settled"].includes(event.kind))
      events.push(event);
  return events;
}
function checkFinished(run) {
  assert.equal(reported(run, "packed-pieces"), 15);
  assert.equal(reported(run, "servings"), 2);
  assert.equal(reported(run, "rejected-servings"), 2);
  assert.equal(reported(run, "rejected-extract"), 365000);
  for (const carrier of run.carriers) assert.equal(carrier.bound, null);
  let mass = 0;
  for (const lot of run.lots)
    if (lot.remaining.unit === "milligram") mass += lot.remaining.amount;
  for (const event of run.events)
    if (
      event.kind === "quantity-reported" &&
      event.role !== "intermediate-stock" &&
      event.quantity.unit === "milligram"
    )
      mass += event.quantity.amount;
  assert.equal(mass, 2374667);
}
const controlHost = await open(scenario, null, "control");
const control = await finish(controlHost, await drive(controlHost), true);
checkFinished(control.run);
save("control.json", await controlHost.handle({ kind: "save" }));
await controlHost.handle({ kind: "dispose" });
const host = await open(scenario, null, "interrupted");
const stop = task(control.run, 0, "stage-pan-b").startedAt + 10000000;
let moving = await drive(host, stop);
while (moving.run.status.kind === "awaiting-inspection") {
  await inspect(host, moving.view, "accept", false);
  moving = await drive(host, stop);
}
assert.equal(task(moving.run, 0, "stage-pan-b").kind, "executing");
assert.equal(
  (await host.handle({ kind: "pause", commandId: "pause-shift" })).receipt
    .status,
  "accepted",
);
const saved = await host.handle({ kind: "save" });
assert.equal(saved.kind, "saved");
save("paused.json", saved);
await host.handle({ kind: "dispose" });
const restored = await open(scenario, saved, "continued");
const finished = await finish(restored, await drive(restored), true);
checkFinished(finished.run);
assert.deepEqual(finished.run.lots, control.run.lots);
assert.deepEqual(finished.run.carriers, control.run.carriers);
assert.deepEqual(processEvents(finished.run), processEvents(control.run));
const completed = await restored.handle({ kind: "save" });
assert.equal(completed.kind, "saved");
completed.artifacts = [...saved.artifacts, ...completed.artifacts];
save("completed.json", completed);
assert.ok(
  Buffer.byteLength(JSON.stringify(completed)) < 16 * 1024 * 1024,
  "The bounded MVP must fit the existing shared-save limit",
);
await restored.handle({ kind: "dispose" });
save("report.json", {
  result: "passed",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  input,
  packedFinanciers: 15,
  teaServings: 2,
  rejectedTeaServings: 2,
  massMg: 2374667,
  exactContinuation: true,
  sharedSaveBytes: Buffer.byteLength(JSON.stringify(completed)),
  scope:
    "Shared worker, pans, hob, scale and sink. Native empty-pan staging; declared recipe process values.",
});
console.log(`Bakery MVP acceptance passed: ${output}`);
