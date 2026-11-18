import {
  beginRun,
  driveRun,
  evidenceDirectory,
  evidenceWriter,
  inspectPending,
  pendingInspection,
  pinnedEngine,
  processEvents,
  reported,
  value,
} from "./execution-journey.mjs";
import assert from "node:assert/strict";
import { compileBakeryShift } from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell } from "./build-execution-bundle.mjs";

const output = evidenceDirectory();
const save = evidenceWriter(output);
const engine = await pinnedEngine();
const { E, runtime } = engine;
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

function open(scenario, saved, leg) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells: [cell],
    runId: "bakery-mvp-acceptance",
    executionId: `tea-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved,
  });
}
function drive(host, until = 14_400_000_000) {
  return driveRun(host, {
    until,
    calls: 2000,
    bound: "Tea exceeded its execution bound",
  });
}
function task(run, batch, key) {
  for (const entry of run.tasks)
    if (entry.id === `milk-tea-batches#${batch}/${key}`) return entry;
  throw new Error(`Missing ${batch}/${key}`);
}
function inspect(host, view, outcome, checkRefusals) {
  return inspectPending(
    host,
    view,
    outcome,
    checkRefusals,
    "Synthetic extraction review for acceptance",
  );
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
