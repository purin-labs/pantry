import {
  beginRun,
  driveRun,
  evidenceDirectory,
  evidenceWriter,
  pinnedEngine,
  reported,
  value,
} from "./execution-journey.mjs";
import assert from "node:assert/strict";
import {
  blackSesameRecipeInput,
  compileBlackSesameRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/black-sesame.ts";
import { PRODUCTION_EXECUTION_MANIFEST } from "../../packages/production-simulation/src/execution-manifest.generated.ts";

const output = evidenceDirectory();
const save = evidenceWriter(output);
const manifest = PRODUCTION_EXECUTION_MANIFEST;
const engine = await pinnedEngine();
const { E } = engine;
const input = blackSesameRecipeInput();
const scenario = value(await compileBlackSesameRecipe(input));
value(await E.admitScenario(scenario));
save("recipe.json", { kind: "black-sesame-recipe", recipe: input });
save("execution.json", manifest);
save("scenario.json", scenario);

function open(scenario, saved, leg) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells: [],
    runId: "black-sesame-acceptance",
    executionId: `sesame-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved,
  });
}
async function drive(host, until) {
  return (
    await driveRun(host, {
      until,
      calls: 100,
      bound: "Recipe exceeded its execution bound",
      stops: ["completed", "blocked", "stopped-at-limit"],
    })
  ).run;
}
function bottles(run) {
  const result = [];
  for (const lot of run.lots)
    if (lot.product === "concentrate") {
      assert.equal(lot.holder.kind, "storage");
      assert.ok(lot.remaining.amount >= 0 && lot.remaining.amount <= 380_000);
      result.push({
        lot: lot.id,
        bottle: lot.holder.storage,
        remainingMg: lot.remaining.amount,
        lineage: lot.lineage,
      });
    }
  return result;
}
function massBalance(run) {
  let amount = 0;
  for (const lot of run.lots)
    if (lot.remaining.unit === "milligram") amount += lot.remaining.amount;
  for (const event of run.events)
    if (
      event.kind === "quantity-reported" &&
      event.role !== "intermediate-stock" &&
      event.quantity.unit === "milligram"
    )
      amount += event.quantity.amount;
  return amount;
}
function withoutHostEvents(run) {
  const events = [];
  for (const { sequence, execution, ...event } of run.events)
    if (!["command-admitted", "pause-settled"].includes(event.kind))
      events.push(event);
  return events;
}

const original = await open(scenario, null, "original");
const cooling = await drive(original, 1_500_000_000);
assert.equal(reported(cooling, "drinks-served"), 0);
assert.equal(bottles(cooling).length, 0);
const partial = await drive(original, 2_200_000_000);
assert.ok(reported(partial, "drinks-served") > 0);
assert.ok(bottles(partial).some(partiallyUsed));
function partiallyUsed(bottle) {
  return bottle.remainingMg > 0 && bottle.remainingMg < 380_000;
}
const paused = await original.handle({
  kind: "pause",
  commandId: "pause-partial-bottle",
  expectedControlRevision: partial.position.controlRevision,
});
assert.equal(paused.kind, "commanded", JSON.stringify(paused));
assert.equal(paused.view.status.kind, "paused");
const saved = await original.handle({ kind: "save" });
assert.equal(saved.kind, "saved");
save("partial-bottle.json", saved);
await original.handle({ kind: "dispose" });
const restored = await open(scenario, saved, "restored");
const waiting = await drive(restored, 6_000_000_000);
assert.equal(reported(waiting, "drinks-served"), 10);
assert.equal(bottles(waiting).reduce(sumBottle, 0), 0);
function sumBottle(total, bottle) {
  return total + bottle.remainingMg;
}
let shortages = 0;
for (const task of waiting.tasks)
  if (
    task.kind === "waiting" &&
    task.subject.key === "dose" &&
    task.blockers.some(concentrateShortage)
  )
    shortages++;
function concentrateShortage(blocker) {
  return blocker.kind === "material" && blocker.product === "concentrate";
}
assert.equal(shortages, 2);
save("shortage.json", await restored.handle({ kind: "save" }));
const final = await drive(restored, 21_600_000_000);
assert.equal(final.status.kind, "completed");
assert.equal(reported(final, "drinks-served"), 12);
assert.equal(reported(final, "drink-mass"), 3_432_000);
assert.equal(bottles(final).reduce(sumBottle, 0), 608_000);
assert.equal(massBalance(final), 4_084_000);
for (const carrier of final.carriers) assert.equal(carrier.bound, null);
save("completed.json", await restored.handle({ kind: "save" }));
await restored.handle({ kind: "dispose" });

const uninterrupted = await open(scenario, null, "uninterrupted");
const control = await drive(uninterrupted, 21_600_000_000);
assert.deepEqual(withoutHostEvents(final), withoutHostEvents(control));
assert.deepEqual(final.lots, control.lots);
assert.deepEqual(final.carriers, control.carriers);
await uninterrupted.handle({ kind: "dispose" });

// Early replenishment must wait for an empty bottle before washing and filling it.
const congestedInput = blackSesameRecipeInput();
congestedInput.batchArrivalsSeconds = [0, 0];
congestedInput.orderArrivalsSeconds = [];
for (let order = 0; order < 12; order++)
  congestedInput.orderArrivalsSeconds.push(4_000 + order * 15);
const congested = await open(
  value(await compileBlackSesameRecipe(congestedInput)),
  null,
  "congested",
);
const congestedFinal = await drive(congested, 21_600_000_000);
assert.equal(congestedFinal.status.kind, "completed");
for (const bottle of ["bottle-a", "bottle-b"]) {
  let emptied = 0;
  for (const event of congestedFinal.events)
    if (
      event.kind === "lot-consumed" &&
      event.lot === `sesame-batches#0/${bottle}`
    )
      emptied = Math.max(emptied, event.time);
  const refill = congestedFinal.tasks.find(refillTask.bind(null, bottle));
  assert.ok(refill.startedAt >= emptied && emptied > 0);
}
function refillTask(bottle, task) {
  return task.id === `sesame-batches#1/wash-and-fill-${bottle}`;
}
save("bottle-congestion.json", {
  input: congestedInput,
  saved: await congested.handle({ kind: "save" }),
});
await congested.handle({ kind: "dispose" });

const overweight = blackSesameRecipeInput();
overweight.evaporationMg = 0;
overweight.residueMg = 0;
overweight.spillMg = 0;
overweight.waterAddedMg = 0;
assert.deepEqual(await compileBlackSesameRecipe(overweight), {
  ok: false,
  error: { code: "concentrate_mass_balance" },
});
overweight.excessDiscardedMg = 2_000;
overweight.roast = "refresh";
const excessScenario = value(await compileBlackSesameRecipe(overweight));
const excess = await open(excessScenario, null, "excess");
const excessFinal = await drive(excess, 21_600_000_000);
assert.equal(excessFinal.status.kind, "completed");
assert.equal(reported(excessFinal, "excess-discarded"), 4_000);
assert.equal(reported(excessFinal, "drinks-served"), 12);
assert.equal(massBalance(excessFinal), 4_044_000);
save("excess-disposition.json", {
  input: overweight,
  saved: await excess.handle({ kind: "save" }),
});
await excess.handle({ kind: "dispose" });

const report = {
  result: "passed",
  scope:
    "Declared manual process; no native container handling or measured cooling",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  firstBatchServed: 10,
  waitingForSecondBatch: shortages,
  drinksServed: 12,
  inputMassMg: 4_084_000,
  servedMassMg: 3_432_000,
  retainedConcentrateMg: 608_000,
  partialBottles: bottles(partial),
  finalBottles: bottles(final),
  exactContinuation: true,
  bottleReuseWaitsForEmpty: true,
  excessAdmissionRefused: true,
  excessDiscardedMg: 4_000,
};
save("report.json", report);
console.log(JSON.stringify(report, null, 2));
