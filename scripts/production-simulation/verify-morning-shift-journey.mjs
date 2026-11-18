import {
  beginRun,
  driveRun,
  evidenceDirectory,
  evidenceWriter,
  pendingInspection,
  pinnedEngine,
  processEvents,
  reported,
  value,
} from "./execution-journey.mjs";
import assert from "node:assert/strict";
import {
  compileAfternoonPrep,
  compileBakeryShift,
  morningShiftRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import {
  decoctionMass,
  gingerDecoctions,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-decoction.ts";
import {
  AFTERNOON_PREP_START_SECONDS_BEFORE_SHIFT,
  miseEnPlaceLots,
  withinHold,
} from "../../packages/production-simulation/src/recipes/bakery/mise-en-place.ts";
import {
  FINANCIER_FLAVOURS,
  financierFlavourOf,
} from "../../packages/production-simulation/src/recipes/bakery/financier-flavours.ts";
import { PIE_TYPES } from "../../packages/production-simulation/src/recipes/bakery/pie-products.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell } from "./build-execution-bundle.mjs";

const output = evidenceDirectory(
  (path) => `Output directory already exists: ${path}`,
);
const save = evidenceWriter(output);
const engine = await pinnedEngine();
const { E, runtime } = engine;

const cell = await prepareCell(runtime, "tea-pan-cell", {
  fixture: "pan-staging",
});
save("cell-definition.json", cell);
save("execution.json", manifest);

function open(scenario, saved, leg, cells = [cell]) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells,
    runId: "morning-shift-acceptance",
    executionId: `shift-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved,
  });
}

const HORIZON_US = 28_800_000_000;

function drive(host, until = HORIZON_US) {
  return driveRun(host, {
    until,
    calls: 5000,
    bound: "Morning shift exceeded its execution bound",
  });
}

/** Packed financiers of each flavour, read from the packing task's load. */
function packedByFlavour(run) {
  const packed = {};
  for (const flavour of FINANCIER_FLAVOURS) packed[flavour] = 0;
  for (const event of run.events)
    if (
      event.kind === "quantity-reported" &&
      event.destination === "packed-pieces"
    ) {
      const flavour = financierFlavourOf(event.task);
      assert.ok(flavour, `Packed financiers without a flavour: ${event.task}`);
      packed[flavour] += event.quantity.amount;
    }
  return packed;
}

function packedPies(run) {
  const packed = {};
  for (const pie of PIE_TYPES)
    packed[pie] = reported(run, `packed-${pie}-pies`);
  return packed;
}

function findTask(run, taskId) {
  for (const entry of run.tasks) if (entry.id === taskId) return entry;
  throw new Error(`Missing task ${taskId}`);
}

// The operator rejects the coffee financier tray at bake inspection.
const REJECTED_TRAY = "load-coffee-a#0/inspect-bake";

function inspectionOutcomeFor(pending, timing) {
  if (pending.task === REJECTED_TRAY) return "reject";
  // Explicit disposition for any missed tea extraction deadline.
  if (pending.task.endsWith("/inspect-strained-tea") && timing.kind === "late")
    return "reject";
  return "accept";
}

async function inspect(host, view, outcome, checkRefusals = false) {
  const pending = view.inspections.find(pendingInspection);
  assert.ok(pending);
  const request = {
    kind: "inspect",
    commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/gi, "-")}`,
    expectedControlRevision: view.controlRevision,
    task: pending.task,
    definition: pending.definition,
    lots: pending.lots,
    outcome,
    note: `Morning shift acceptance review (${outcome})`,
  };
  if (checkRefusals) {
    const wrong = await host.handle({
      ...request,
      commandId: "wrong-inspection-lot",
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

async function finishShift(host, first, checkFirstRefusal = false) {
  let boundary = first;
  const inspections = [];
  for (let reviews = 0; reviews < 24; reviews++) {
    if (boundary.run.status.kind !== "awaiting-inspection") break;
    const pending = boundary.view.inspections.find(pendingInspection);
    assert.ok(pending);
    const timing = teaStrainTiming(
      boundary.run.definition.scenario,
      boundary.view.resourceHistory,
      pending.task,
    );
    if (pending.task.endsWith("/inspect-strained-tea"))
      assert.notEqual(timing.kind, "unavailable");
    for (const id of pending.lots) {
      let held = false;
      for (const lot of boundary.run.lots)
        if (lot.id === id) held = lot.disposition === "held";
      assert.equal(
        held,
        true,
        `Expected lot ${id} to be held before inspection`,
      );
    }
    const outcome = inspectionOutcomeFor(pending, timing);
    inspections.push({
      task: pending.task,
      atSeconds: boundary.run.position.time / 1_000_000,
      outcome,
      timing,
    });
    await inspect(
      host,
      boundary.view,
      outcome,
      checkFirstRefusal && reviews === 0,
    );
    boundary = await drive(host);
  }
  assert.equal(
    boundary.run.status.kind,
    "completed",
    `Expected completed status, got ${JSON.stringify(boundary.run.status)} at t=${boundary.run.position.time / 1_000_000}s`,
  );
  return { ...boundary, inspections };
}

function totalMassMg(run) {
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
  return mass;
}

// Every customer drink order: the workflow, and the destination that counts
// one served drink. A rejected tea reports to its rejected destination, so it
// counts as not served.
const ORDER_SERVINGS = {
  "sesame-drink": "drinks-served",
  "ginger-tea-batch": "servings",
  "ginger-milk-tea-batch": "servings",
  "espresso-orders": "espresso-servings",
  "pour-over-brew": "pour-over-servings",
};
const SERVICE_TARGET_SECONDS = 900;

function drinkOrders(run) {
  const orders = [];
  for (const instance of run.instances) {
    const destination = ORDER_SERVINGS[instance.workflow];
    if (destination === undefined) continue;
    const arrivedSeconds = instance.arrival.time / 1_000_000;
    let servedSeconds = null;
    for (const event of run.events)
      if (
        event.kind === "quantity-reported" &&
        event.destination === destination &&
        event.task.startsWith(`${instance.id}/`)
      )
        servedSeconds = event.time / 1_000_000;
    const waitSeconds =
      servedSeconds === null ? null : servedSeconds - arrivedSeconds;
    orders.push({
      order: instance.id,
      drink: instance.workflow,
      arrivedSeconds,
      servedSeconds,
      waitSeconds,
      late: waitSeconds === null || waitSeconds > SERVICE_TARGET_SECONDS,
    });
  }
  return orders;
}

function waitStats(orders) {
  const waits = orders
    .filter((order) => order.waitSeconds !== null)
    .map((order) => order.waitSeconds);
  return {
    orders: orders.length,
    served: waits.length,
    lateOrders: orders.filter((order) => order.late).length,
    avgWaitSeconds: Number(
      (waits.reduce((sum, wait) => sum + wait, 0) / waits.length).toFixed(1),
    ),
    maxWaitSeconds: Math.max(...waits),
  };
}

function summarizeRun(name, input, run, view, inspections) {
  const shiftEndSeconds = run.position.time / 1_000_000;
  const orders = drinkOrders(run);
  const sesame = orders.filter((order) => order.drink === "sesame-drink");

  // Resource occupancy from resourceHistory.
  const occupancy = {};
  if (view.resourceHistory.kind === "available") {
    for (const res of view.resourceHistory.resources) {
      let busyUs = 0;
      let changeoverUs = 0;
      let travelUs = 0;
      for (const span of res.intervals) {
        const dur = span.end - span.start;
        if (span.kind === "handling" || span.kind === "occupied") busyUs += dur;
        else if (span.kind === "changeover") changeoverUs += dur;
        else if (span.kind === "travel") travelUs += dur;
      }
      occupancy[res.resource] = {
        busySeconds: busyUs / 1_000_000,
        changeoverSeconds: changeoverUs / 1_000_000,
        travelSeconds: travelUs / 1_000_000,
        utilizationRatio: Number(
          ((busyUs + changeoverUs + travelUs) / run.position.time).toFixed(4),
        ),
      };
    }
  }

  const wasteByReasonMg = {
    financierRejectedMassMg: reported(run, "rejected-mass"),
    financierSampleMassMg: reported(run, "sample-mass"),
    financierBakingLossMg: reported(run, "baking-loss"),
    butterEvaporationMg: reported(run, "butter-evaporation"),
    mixingResidueMg: reported(run, "mixing-residue"),
    mixingSpillMg: reported(run, "mixing-spill"),
    shortcrustResidueMg: reported(run, "shortcrust-residue"),
    pieFillingEvaporationMg: reported(run, "filling-evaporation"),
    pieFillingResidueMg: reported(run, "filling-residue"),
    pieBakeLossMg: reported(run, "pie-bake-loss"),
    sharedEvaporationMg: reported(run, "evaporation"),
    sharedSpillMg: reported(run, "spill"),
    sharedResidueMg: reported(run, "residue"),
    teaWetSolidsMg: reported(run, "wet-solids"),
    cupPreheatWaterMg: reported(run, "cup-preheat-water"),
    blackTeaRejectedMassMg: reported(run, "rejected-tea-mass"),
    milkTeaRejectedExtractMg: reported(run, "rejected-extract"),
    espressoSpentCoffeeMg: reported(run, "spent-coffee"),
    pourOverSpentCoffeeBedMg: reported(run, "spent-coffee-bed"),
    pourOverEvaporatedWaterMg: reported(run, "evaporated-water"),
    pourOverSpilledWaterMg: reported(run, "spilled-water"),
  };

  for (const carrier of run.carriers) {
    assert.equal(
      carrier.bound,
      null,
      `Carrier ${carrier.id} still bound at end of ${name}`,
    );
  }

  return {
    variant: name,
    input,
    shiftCompletionSeconds: shiftEndSeconds,
    outputs: {
      packedFinanciers: reported(run, "packed-pieces"),
      financiersByFlavour: packedByFlavour(run),
      piesByType: packedPies(run),
      packedPieMassMg: PIE_TYPES.reduce(
        (sum, pie) => sum + reported(run, `packed-${pie}-pie-mass`),
        0,
      ),
      rejectedFinanciers: reported(run, "rejected-pieces"),
      sampledFinanciers: reported(run, "sample-pieces"),
      sesameDrinksServed: reported(run, "drinks-served"),
      teaServingsAccepted: reported(run, "servings"),
      teaServingsRejected: reported(run, "rejected-servings"),
      espressoServings: reported(run, "espresso-servings"),
      espressoServedMassMg: reported(run, "served-espresso"),
      pourOverServings: reported(run, "pour-over-servings"),
      pourOverServedMassMg: reported(run, "served-pour-over"),
    },
    drinkOrders: { ...waitStats(orders), details: orders },
    sesameOrders: waitStats(sesame),
    inspections,
    wasteByReasonMg,
    totalMassBalanceMg: totalMassMg(run),
    occupancy,
  };
}

// 1. The previous afternoon's mise en place, run on the same engine.
const afternoonScenario = value(await compileAfternoonPrep({ piesPerType: 6 }));
value(await E.admitScenario(afternoonScenario));
save("afternoon-prep-scenario.json", afternoonScenario);
console.log("Running the previous afternoon's mise en place...");
const afternoonHost = await open(afternoonScenario, null, "afternoon-prep", []);
const afternoon = await drive(afternoonHost);
assert.equal(afternoon.run.status.kind, "completed");
save("afternoon-prep.json", await afternoonHost.handle({ kind: "save" }));
await afternoonHost.handle({ kind: "dispose" });

// 2. Baseline scenario compilation & admission: the optimised shift.
const baselineInput = morningShiftRecipeInput();
const baselineScenario = value(await compileBakeryShift(baselineInput, cell));
value(await E.admitScenario(baselineScenario));
save("baseline-recipe.json", {
  kind: "bakery-shift-recipe",
  recipe: baselineInput,
});
save("baseline-scenario.json", baselineScenario);

// The morning's opening stock is exactly what the afternoon left in the
// refrigerator, and each lot is inside its hold at the end of the shift.
const decoctionLots = gingerDecoctions().map((decoction) => ({
  product: decoction.product,
  quantityMg: decoctionMass(decoction) * 2,
}));
const provenance = [];
for (const lot of miseEnPlaceLots(6, PIE_TYPES, decoctionLots)) {
  const opening = baselineScenario.stock.find((entry) => entry.id === lot.lot);
  assert.ok(opening, `Morning opening stock lacks ${lot.lot}`);
  assert.equal(opening.quantity.amount, lot.quantityMg);
  let made = 0;
  for (const remaining of afternoon.run.lots)
    if (remaining.product === lot.product) made += remaining.remaining.amount;
  assert.equal(
    made,
    lot.quantityMg,
    `The afternoon makes the ${lot.product} that the morning opens with`,
  );
  let madeAtSeconds = 0;
  for (const instance of afternoon.run.instances)
    if (instance.workflow === lot.madeBy.workflow) {
      const task = findTask(afternoon.run, `${instance.id}/${lot.madeBy.task}`);
      madeAtSeconds = Math.max(madeAtSeconds, task.completedAt / 1_000_000);
    }
  assert.ok(
    withinHold(lot, madeAtSeconds, 28_800),
    `${lot.product} exceeds its ${lot.holdHours} h hold`,
  );
  provenance.push({
    lot: lot.lot,
    product: lot.product,
    quantityMg: lot.quantityMg,
    madeBy: lot.madeBy,
    madeAtAfternoonSeconds: madeAtSeconds,
    ageAtShiftEndHours: Number(
      (
        (AFTERNOON_PREP_START_SECONDS_BEFORE_SHIFT - madeAtSeconds + 28_800) /
        3_600
      ).toFixed(2),
    ),
    holdHours: lot.holdHours,
  });
}
save("mise-en-place-provenance.json", {
  afternoonCompletedSeconds: afternoon.run.position.time / 1_000_000,
  lots: provenance,
});

// 3. Uninterrupted baseline control run
console.log("Running baseline control shift...");
const controlHost = await open(baselineScenario, null, "baseline-control");
const control = await finishShift(controlHost, await drive(controlHost), true);
const baselineSummary = summarizeRun(
  "baseline",
  baselineInput,
  control.run,
  control.view,
  control.inspections,
);
// Four flavours, one 8-cavity tray each. The coffee tray is rejected and
// one hazelnut financier is the crumb sample.
const EXPECTED_FINANCIERS = {
  hazelnut: 7,
  coffee: 0,
  matcha: 8,
  "black-sesame": 8,
};
// Six 12 cm pies of each type; each bakes from 455 g to 430 g.
const EXPECTED_PIES = { "steak-and-pepper": 6, "beef-bourguignon": 6 };
function assertShopProducts(summary) {
  assert.equal(summary.outputs.packedFinanciers, 23);
  assert.deepEqual(summary.outputs.financiersByFlavour, EXPECTED_FINANCIERS);
  assert.equal(summary.outputs.rejectedFinanciers, 8);
  assert.deepEqual(summary.outputs.piesByType, EXPECTED_PIES);
  assert.equal(summary.outputs.packedPieMassMg, 12 * 430_000);
  assert.equal(summary.outputs.sesameDrinksServed, 12);
  assert.equal(
    summary.outputs.teaServingsAccepted + summary.outputs.teaServingsRejected,
    8,
  );
  assert.equal(summary.outputs.espressoServings, 2);
  assert.equal(summary.outputs.pourOverServings, 2);
}
assertShopProducts(baselineSummary);
assert.equal(baselineSummary.outputs.sampledFinanciers, 1);
assert.equal(baselineSummary.outputs.espressoServedMassMg, 72_000);
assert.equal(baselineSummary.outputs.pourOverServedMassMg, 620_000);
// Every customer drink is served within 900 s of its order, and every tea
// is strained on time, so none is discarded.
assert.equal(baselineSummary.drinkOrders.orders, 20);
assert.equal(
  baselineSummary.drinkOrders.lateOrders,
  0,
  `Late drink orders: ${JSON.stringify(baselineSummary.drinkOrders.details.filter((order) => order.late))}`,
);
assert.equal(baselineSummary.outputs.teaServingsRejected, 0);
// The sesame drinks pour the day-before concentrate.
const firstDose = control.run.lots.find(
  (entry) => entry.id === "sesame-orders#0/dose",
);
assert.ok(
  firstDose.lineage.includes("sesame-concentrate-on-hand"),
  `The first sesame drink uses the day-before concentrate: ${JSON.stringify(firstDose.lineage)}`,
);
save("baseline-control.json", await controlHost.handle({ kind: "save" }));
await controlHost.handle({ kind: "dispose" });

// 4. Interrupted native cold-carrier transfer of the first financier tray,
// saved and reopened in a fresh session (E5).
console.log("Running interrupted native cold-carrier transfer journey...");
const TRANSFER = "load-hazelnut-a#0/transfer-cold-carrier";
const interruptedHost = await open(baselineScenario, null, "interrupted");
const transferTask = findTask(control.run, TRANSFER);
const interruptAtUs = transferTask.startedAt + 20_000_000;
let midFlight = await drive(interruptedHost, interruptAtUs);
while (midFlight.run.status.kind === "awaiting-inspection") {
  const pending = midFlight.view.inspections.find(pendingInspection);
  const timing = teaStrainTiming(
    midFlight.run.definition.scenario,
    midFlight.view.resourceHistory,
    pending.task,
  );
  await inspect(
    interruptedHost,
    midFlight.view,
    inspectionOutcomeFor(pending, timing),
    false,
  );
  midFlight = await drive(interruptedHost, interruptAtUs);
}
assert.equal(
  findTask(midFlight.run, TRANSFER).kind,
  "executing",
  `Expected ${TRANSFER} to be executing at the interruption point`,
);
// The cooling grid is in the robot's custody, the arm stays allocated and
// none of the tray's financiers is packed before the transfer ends.
const grid = midFlight.run.carriers.find(
  (entry) =>
    entry.custody.kind === "transport" && entry.custody.task === TRANSFER,
);
assert.ok(
  grid,
  `A cooling grid is in transport custody during the transfer: ${JSON.stringify(midFlight.run.carriers.filter((entry) => entry.id.startsWith("grid")))}`,
);
assert.deepEqual(grid.custody, {
  kind: "transport",
  task: TRANSFER,
  from: "pan-staging-table",
  to: "pan-staging-rack",
});
const stagingArm = midFlight.run.resources.find(
  (entry) => entry.id === "staging-arm",
);
assert.equal(
  stagingArm.allocations.length,
  1,
  "Staging arm must remain allocated while native transfer is interrupted",
);
assert.equal(
  packedByFlavour(midFlight.run).hazelnut,
  0,
  "No hazelnut financier may be packed before its tray's transfer completes",
);
assert.equal(
  (
    await interruptedHost.handle({
      kind: "pause",
      commandId: "pause-cold-carrier-transfer",
    })
  ).receipt.status,
  "accepted",
);
const savedInterrupted = await interruptedHost.handle({ kind: "save" });
assert.equal(savedInterrupted.kind, "saved");
save("interrupted-transfer.json", savedInterrupted);
await interruptedHost.handle({ kind: "dispose" });

// Reopen in a fresh Wasm worker session and complete the shift
const restoredHost = await open(baselineScenario, savedInterrupted, "restored");
const restoredResult = await finishShift(
  restoredHost,
  await drive(restoredHost),
  false,
);
const restoredSummary = summarizeRun(
  "restored",
  baselineInput,
  restoredResult.run,
  restoredResult.view,
  restoredResult.inspections,
);
assert.equal(
  restoredSummary.totalMassBalanceMg,
  baselineSummary.totalMassBalanceMg,
);
assert.deepEqual(restoredResult.run.lots, control.run.lots);
assert.deepEqual(restoredResult.run.carriers, control.run.carriers);
assert.deepEqual(processEvents(restoredResult.run), processEvents(control.run));
const savedCompleted = await restoredHost.handle({ kind: "save" });
assert.equal(savedCompleted.kind, "saved");
savedCompleted.artifacts = [
  ...savedInterrupted.artifacts,
  ...savedCompleted.artifacts,
];
save("restored-completed.json", savedCompleted);
const savedDocumentBytes = Buffer.byteLength(
  JSON.stringify(savedCompleted.document),
);
assert.ok(
  savedDocumentBytes < 16 * 1024 * 1024,
  "Saved morning shift document must fit the 16 MiB document limit",
);
assert.ok(
  savedCompleted.artifacts.length <= 512,
  "Saved morning shift artifacts must fit the 512-artifact limit",
);
await restoredHost.handle({ kind: "dispose" });

// 5. Ablations (E4): each removes one lever of the optimised shift.
const variantSpecs = [
  {
    id: "without-day-before-prep",
    description:
      "The morning makes the sesame concentrate, ginger decoctions, shortcrust and pie fillings itself",
    overrides: { miseEnPlace: "same-morning" },
  },
  {
    id: "one-worker",
    description: "One worker runs the bar and production",
    overrides: { workers: 1 },
  },
  {
    id: "no-station-roles",
    description: "Two workers share every task; no barista or baker role",
    overrides: { stationRoles: false },
  },
  {
    id: "no-order-priority",
    description: "Customer-order steps dispatch like production work",
    overrides: { orderPriority: false },
  },
  {
    id: "original-bar-equipment",
    description:
      "Two shared pans, one milk jug, one strainer, the kitchen scale and hob, and cups warmed in pan A",
    overrides: {
      panCount: 2,
      milkJugs: 1,
      strainers: 1,
      barScale: false,
      cupWarming: "pan",
    },
  },
];

const comparisons = [
  {
    ...baselineSummary,
    description:
      "Optimised shift: day-before mise en place, barista and baker roles, order priority, bar equipment",
  },
];

for (const spec of variantSpecs) {
  console.log(`Running ablation: ${spec.id}...`);
  const variantInput = morningShiftRecipeInput(spec.overrides);
  const variantScenario = value(await compileBakeryShift(variantInput, cell));
  value(await E.admitScenario(variantScenario));
  save(`scenario-${spec.id}.json`, variantScenario);
  const variantHost = await open(variantScenario, null, spec.id);
  const finishedVariant = await finishShift(
    variantHost,
    await drive(variantHost),
    false,
  );
  const summary = summarizeRun(
    spec.id,
    variantInput,
    finishedVariant.run,
    finishedVariant.view,
    finishedVariant.inspections,
  );
  assertShopProducts(summary);
  comparisons.push({
    ...summary,
    description: spec.description,
    deltaShiftCompletionSeconds:
      summary.shiftCompletionSeconds - baselineSummary.shiftCompletionSeconds,
  });
  await variantHost.handle({ kind: "dispose" });
}

save("comparison-table.json", comparisons);
save("report.json", {
  result: "passed",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  cellId: cell.cellId,
  fixture: cell.fixture,
  modelHash: cell.modelHash,
  controllerSourceHash: cell.execution.controllerSourceHash,
  exactContinuationAfterNativeInterruption: true,
  savedDocumentBytes,
  afternoonPrepCompletedSeconds: afternoon.run.position.time / 1_000_000,
  baseline: baselineSummary,
  comparisons: comparisons.map((entry) => ({
    variant: entry.variant,
    description: entry.description,
    shiftCompletionSeconds: entry.shiftCompletionSeconds,
    deltaShiftCompletionSeconds: entry.deltaShiftCompletionSeconds ?? 0,
    drinkOrders: {
      lateOrders: entry.drinkOrders.lateOrders,
      avgWaitSeconds: entry.drinkOrders.avgWaitSeconds,
      maxWaitSeconds: entry.drinkOrders.maxWaitSeconds,
    },
    sesameOrders: entry.sesameOrders,
    financiersByFlavour: entry.outputs.financiersByFlavour,
    piesByType: entry.outputs.piesByType,
    teaServingsAccepted: entry.outputs.teaServingsAccepted,
    teaServingsRejected: entry.outputs.teaServingsRejected,
  })),
});

console.log(
  `Plan 61E morning shift acceptance & ablations passed: ${baselineSummary.drinkOrders.lateOrders} late of ${baselineSummary.drinkOrders.orders} drink orders (avg ${baselineSummary.drinkOrders.avgWaitSeconds} s, max ${baselineSummary.drinkOrders.maxWaitSeconds} s): ${output}`,
);
