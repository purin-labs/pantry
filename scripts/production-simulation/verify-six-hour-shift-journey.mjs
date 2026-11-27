import {
  beginRun,
  driveRun,
  evidenceDirectory,
  evidenceWriter,
  pendingInspection,
  pinnedEngine,
  reported,
  value,
} from "./execution-journey.mjs";
import { createHash } from "node:crypto";
import { reportBakeryShift } from "../../packages/production-simulation/src/recipes/bakery/shift-report.ts";
import {
  blankMeasuredSixHourShiftTemplate,
  compareMeasuredSixHourShift,
  compareShiftCohort,
  compareShiftMetric,
  parseMeasuredSixHourShift,
} from "../../packages/production-simulation/src/recipes/bakery/shift-metrics.ts";
import { bakeryShiftDemand } from "../../packages/production-simulation/src/recipes/bakery/shift-demand.ts";
import {
  carryoverRetailStock,
  evaluateFinancierReplenishmentWave,
  financierReplenishmentWaveTimesSeconds,
  reportShiftInventory,
} from "../../packages/production-simulation/src/recipes/bakery/shift-inventory.ts";
import {
  buildShiftRunTrace,
  findShiftTracePath,
} from "../../packages/production-simulation/src/recipes/bakery/shift-trace.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SIX_HOUR_SHIFT_SECONDS,
  compileAfternoonPrep,
  compileBakeryShift,
  extractCarryoverMiseEnPlace,
  morningShiftRecipeInput,
  sixHourShiftRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import {
  defaultMorningShiftFaultInjections,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
} from "../../packages/production-simulation/src/recipes/bakery/appliance-execution.ts";
import { recipeApplianceTasks } from "../../packages/production-simulation/src/recipes/bakery/appliance-task-table.ts";
import {
  decoctionMass,
  gingerDecoctions,
} from "../../packages/production-simulation/src/recipes/bakery/ginger-decoction.ts";
import {
  FINANCIER_FLAVOURS,
  financierFlavourOf,
} from "../../packages/production-simulation/src/recipes/bakery/financier-flavours.ts";
import { PIE_TYPES } from "../../packages/production-simulation/src/recipes/bakery/pie-products.ts";
import { teaStrainTiming } from "../../packages/production-simulation/src/recipes/bakery/tea-process.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";

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

function open(scenario, leg, cells = [cell]) {
  return beginRun(engine, {
    bundle: manifest.bundle,
    cells,
    runId: "six-hour-shift-acceptance",
    executionId: `six-hour-${leg}`,
    hostSession: `host-${leg}`,
    scenario,
    saved: null,
  });
}

const HORIZON_US = SIX_HOUR_SHIFT_SECONDS * 1e6;

function drive(host, until = HORIZON_US) {
  return driveRun(host, {
    until,
    calls: 12000,
    bound: "6-hour shift exceeded its execution bound",
  });
}

const REJECTED_TRAY = "load-coffee-a#0/inspect-bake";

function inspectionOutcomeFor(pending, timing) {
  if (pending.task === REJECTED_TRAY) return "reject";
  if (pending.task.endsWith("/inspect-strained-tea") && timing.kind === "late")
    return "reject";
  return "accept";
}

async function inspect(host, view, outcome) {
  const pending = view.inspections.find(pendingInspection);
  assert.ok(pending);
  const reply = await host.handle({
    kind: "inspect",
    commandId: `inspect-${pending.task.replace(/[^a-z0-9-]/gi, "-")}`,
    expectedControlRevision: view.controlRevision,
    task: pending.task,
    definition: pending.definition,
    lots: pending.lots,
    outcome,
    note: `6-hour shift inspection (${outcome})`,
  });
  assert.equal(reply.kind, "commanded", JSON.stringify(reply));
  assert.equal(reply.receipt.status, "accepted", JSON.stringify(reply));
}

async function finishShift(host, first) {
  let boundary = first;
  const inspections = [];
  for (let reviews = 0; reviews < 96; reviews++) {
    if (boundary.run.status.kind !== "awaiting-inspection") break;
    const pending = boundary.view.inspections.find(pendingInspection);
    assert.ok(pending);
    const timing = teaStrainTiming(
      boundary.run.definition.scenario,
      boundary.view.resourceHistory,
      pending.task,
    );
    const outcome = inspectionOutcomeFor(pending, timing);
    inspections.push({
      task: pending.task,
      atSeconds: boundary.run.position.time / 1_000_000,
      outcome,
      timing,
    });
    await inspect(host, boundary.view, outcome);
    boundary = await drive(host);
  }
  assert.equal(
    boundary.run.status.kind,
    "completed",
    `Expected completed status, got ${JSON.stringify(boundary.run.status)} at t=${boundary.run.position.time / 1_000_000}s`,
  );
  return { ...boundary, inspections };
}

async function finishShiftWithStockReplenishment(
  host,
  shiftInput,
  retailOrders,
  openingStock = {},
) {
  const waveTimes = financierReplenishmentWaveTimesSeconds(shiftInput);
  const reorderThresholdUnits = shiftInput.reorderThresholdUnits ?? 4;
  const waveDecisions = [];
  const closedReceipts = [];
  let nextWaveCursor = 0;
  const inspections = [];

  for (let step = 0; step < 192; step++) {
    const nextWaveSeconds = waveTimes[nextWaveCursor];
    const checkTargetUs =
      nextWaveSeconds !== undefined ? (nextWaveSeconds - 1) * 1e6 : HORIZON_US;
    const boundary = await drive(host, checkTargetUs);
    if (boundary.run.status.kind === "awaiting-inspection") {
      const pending = boundary.view.inspections.find(pendingInspection);
      assert.ok(pending);
      const timing = teaStrainTiming(
        boundary.run.definition.scenario,
        boundary.view.resourceHistory,
        pending.task,
      );
      const outcome = inspectionOutcomeFor(pending, timing);
      inspections.push({
        task: pending.task,
        atSeconds: boundary.run.position.time / 1_000_000,
        outcome,
        timing,
      });
      await inspect(host, boundary.view, outcome);
      continue;
    }
    if (
      nextWaveSeconds !== undefined &&
      boundary.run.position.time >= checkTargetUs
    ) {
      const waveIndex = nextWaveCursor + 1;
      const decision = evaluateFinancierReplenishmentWave(
        boundary.run,
        retailOrders,
        {
          waveIndex,
          waveArrivalSeconds: nextWaveSeconds,
          reorderThresholdUnits,
          openingStock,
        },
      );
      waveDecisions.push(decision);
      nextWaveCursor += 1;
      let expectedControlRevision = boundary.view.controlRevision;
      for (const source of decision.closedSources) {
        const closed = await host.handle({
          kind: "close-arrivals",
          commandId: `close-wave-${waveIndex}-${source}`,
          expectedControlRevision,
          source,
        });
        assert.equal(closed.kind, "commanded", JSON.stringify(closed));
        assert.equal(closed.receipt.status, "accepted", JSON.stringify(closed));
        expectedControlRevision = closed.view.controlRevision;
        closedReceipts.push(closed.receipt);
      }
      if (decision.action === "suppress-wave") {
        nextWaveCursor = waveTimes.length;
      }
      continue;
    }
    assert.equal(
      boundary.run.status.kind,
      "completed",
      `Expected completed status, got ${JSON.stringify(boundary.run.status)} at t=${boundary.run.position.time / 1_000_000}s`,
    );
    return { ...boundary, inspections, waveDecisions, closedReceipts };
  }
  throw new Error("Stock-driven shift exceeded its step bound");
}

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

function reportOf(done) {
  assert.equal(done.view.production.kind, "available");
  const report = reportBakeryShift(
    done.run.definition.scenario,
    done.view.logistics,
    done.view.resourceHistory,
    done.view.production,
    done.view.time,
    "complete",
  );
  assert.equal(report.kind, "available");
  return report;
}

function verifyInventory(inventory) {
  assert.equal(
    inventory.openingUnits + inventory.producedUnits,
    inventory.soldUnits + inventory.remainingUnits,
  );
  const totalEndingBySku = Object.values(inventory.stockBySku).reduce(
    (sum, units) => sum + units,
    0,
  );
  assert.equal(totalEndingBySku, inventory.remainingUnits);
  const fulfilledBySku = new Map();
  for (const receipt of inventory.receipts) {
    let available = inventory.openingStock[receipt.order.sku] ?? 0;
    for (const supply of inventory.supply) {
      if (
        supply.sku === receipt.order.sku &&
        supply.atSeconds <= receipt.order.atSeconds
      )
        available += supply.units;
    }
    const previouslySold = fulfilledBySku.get(receipt.order.sku) ?? 0;
    assert.equal(receipt.stockBefore, available - previouslySold);
    assert.equal(
      receipt.fulfilledUnits + receipt.stockedOutUnits,
      receipt.order.units,
    );
    fulfilledBySku.set(
      receipt.order.sku,
      previouslySold + receipt.fulfilledUnits,
    );
  }
}

function verifyPath(graph, path) {
  assert.equal(path.kind, "resolved");
  assert.equal(path.hopCount, path.nodeIds.length - 1);
  for (let index = 1; index < path.nodeIds.length; index++) {
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.from === path.nodeIds[index - 1] &&
          edge.to === path.nodeIds[index],
      ),
    );
  }
}

function sourceDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const evaluatorFiles = [
  "mise-en-place.ts",
  "shift-preset.ts",
  "shift-demand.ts",
  "shift-inventory.ts",
  "shift-metrics.ts",
  "shift-trace.ts",
  "shift-report.ts",
  "bakery-shift.ts",
  "appliance-execution.ts",
  "appliance-telemetry.ts",
  "appliance-task-table.ts",
];
const sourceDigests = {};
for (const file of evaluatorFiles)
  sourceDigests[file] = sourceDigest(
    `packages/production-simulation/src/recipes/bakery/${file}`,
  );
sourceDigests["acceptance-script"] = sourceDigest(
  "scripts/production-simulation/verify-six-hour-shift-journey.mjs",
);

console.log(
  "Running six-hour shift with rejected coffee tray and accepted native execution...",
);
const input = sixHourShiftRecipeInput();
const demand = bakeryShiftDemand(input);
const scenario = value(await compileBakeryShift(input, cell));
value(await E.admitScenario(scenario));
assert.equal(scenario.limits.horizon, HORIZON_US);
save("input.json", { input, demand });
save("scenario.json", scenario);
const host = await open(scenario, "primary");
const initial = await host.handle({ kind: "state" });
assert.equal(initial.kind, "state");
const initialTrace = buildShiftRunTrace(initial.run);
assert.equal(
  findShiftTracePath(
    initialTrace,
    "lot:hazelnut-preparation-batches#1/prepared-batter",
    "task-end:load-hazelnut-a#1/finish-product",
  ).kind,
  "unavailable",
);
const done = await finishShift(host, await drive(host));
save("run.json", done.run);
save("view.json", done.view);
save("inspections.json", done.inspections);
const report = reportOf(done);
save("shift-report.json", report);
const inventory = reportShiftInventory(done.run, demand.retailOrders);
verifyInventory(inventory);
assert.equal(inventory.producedUnits, 66);
assert.ok(inventory.receipts.some((receipt) => receipt.stockedOutUnits > 0));
assert.ok(inventory.receipts.some((receipt) => receipt.fulfilledUnits > 0));
assert.equal(inventory.pendingOrders.length, 0);
save("inventory.json", inventory);
assert.deepEqual(packedByFlavour(done.run), {
  hazelnut: 14,
  coffee: 8,
  matcha: 16,
  "black-sesame": 16,
});
assert.equal(reported(done.run, "rejected-pieces"), 8);
assert.equal(reported(done.run, "sample-pieces"), 2);
for (const pie of PIE_TYPES)
  assert.equal(reported(done.run, `packed-${pie}-pies`), 6);
assert.equal(reported(done.run, "drinks-served"), 12);
assert.equal(reported(done.run, "servings"), 12);
assert.equal(reported(done.run, "rejected-servings"), 0);
assert.equal(reported(done.run, "espresso-servings"), 4);
assert.equal(reported(done.run, "pour-over-servings"), 2);
for (const carrier of done.run.carriers) assert.equal(carrier.bound, null);
assert.ok(done.run.position.time <= HORIZON_US);

const graph = buildShiftRunTrace(done.run);
assert.equal(graph.kind, "available");
const path = findShiftTracePath(
  graph,
  "lot:hazelnut-preparation-batches#1/prepared-batter",
  "task-end:load-hazelnut-a#1/finish-product",
);
verifyPath(graph, path);
assert.ok(path.hopCount >= 3);
const missing = findShiftTracePath(
  graph,
  "lot:pistachio-batter",
  "task-end:load-hazelnut-a#1/finish-product",
);
assert.equal(missing.kind, "unavailable");
const disconnected = findShiftTracePath(
  {
    kind: "available",
    coverage: graph.coverage,
    nodes: graph.nodes,
    edges: [],
  },
  path.nodeIds[0],
  path.nodeIds.at(-1),
);
assert.equal(disconnected.kind, "unavailable");
save("trace.json", graph);
save("trace-queries.json", { path, missing, disconnected });

// Missing measurements must remain unavailable. These assertions exercise
// the same report path as the Portal, using a real run with evidence withheld.
const withheld = reportBakeryShift(
  scenario,
  {
    kind: "available",
    version: 2,
    dependencies: [],
    tasks: [],
    queues: [],
    resources: [],
    carrierStores: [],
  },
  { kind: "unavailable" },
  { orders: [], ordersCompleted: 0, reported: [], stock: [] },
  0,
  "partial",
);
assert.equal(withheld.kind, "available");
assert.equal(withheld.trace.kind, "unavailable");
assert.ok(
  withheld.measurements.metrics.every(
    (metric) => metric.measurement.kind === "unavailable",
  ),
);
assert.equal(compareShiftCohort([]).kind, "unavailable");
save("withheld-evidence-report.json", withheld);

// Modes remain stable when operators change demand or wave counts.
const morning = value(
  await compileBakeryShift(
    morningShiftRecipeInput({ demandPreset: "steady" }),
    cell,
  ),
);
assert.equal(morning.availability.length, 0);
assert.equal(morning.limits.horizon, 28800e6);
const singleWave = value(
  await compileBakeryShift(
    sixHourShiftRecipeInput({ financierWaves: 1, demandPreset: "rush" }),
    cell,
  ),
);
assert.equal(singleWave.availability.length, 2);
assert.equal(singleWave.limits.horizon, HORIZON_US);

console.log("Running delayed production and fixed-break variants...");
const cohorts = [report.measurements];
const variants = [
  { id: "delayed-baker", input, delay: true },
  {
    id: "fixed-window",
    input: sixHourShiftRecipeInput({ shiftBreakPolicy: "fixed-window" }),
    delay: false,
  },
];
for (const variant of variants) {
  const compiled = value(await compileBakeryShift(variant.input, cell));
  const variantScenario = variant.delay
    ? {
        ...compiled,
        availability: [
          ...compiled.availability,
          {
            id: "delayed-opening",
            resource: "baker",
            interval: { start: 0, end: 1800e6 },
          },
        ],
      }
    : compiled;
  value(await E.admitScenario(variantScenario));
  const variantHost = await open(variantScenario, variant.id);
  const completed = await finishShift(variantHost, await drive(variantHost));
  const variantReport = reportOf(completed);
  const variantInventory = reportShiftInventory(
    completed.run,
    demand.retailOrders,
  );
  verifyInventory(variantInventory);
  if (variant.delay) {
    const baselineFirst = inventory.supply.find(
      (supply) => supply.sku === "hazelnut-financier",
    );
    const delayedFirst = variantInventory.supply.find(
      (supply) => supply.sku === "hazelnut-financier",
    );
    assert.ok(
      baselineFirst &&
        delayedFirst &&
        delayedFirst.atSeconds > baselineFirst.atSeconds,
    );
    // One fixed customer arrives between the observed baseline and delayed
    // completion times. Both reports use this identical demand input.
    const probeOrder = {
      id: "delay-sensitive-customer",
      atSeconds: baselineFirst.atSeconds,
      sku: "hazelnut-financier",
      units: 1,
    };
    const baselineReceipt = reportShiftInventory(done.run, [probeOrder])
      .receipts[0];
    const delayedReceipt = reportShiftInventory(completed.run, [probeOrder])
      .receipts[0];
    assert.equal(baselineReceipt.fulfilledUnits, 1);
    assert.equal(delayedReceipt.stockedOutUnits, 1);
    save("delay-sensitive-order.json", {
      order: probeOrder,
      baselineReceipt,
      delayedReceipt,
    });
  }
  cohorts.push(variantReport.measurements);
  save(`${variant.id}.json`, {
    input: variant.input,
    scenario: variantScenario,
    run: completed.run,
    view: completed.view,
    report: variantReport,
    inventory: variantInventory,
  });
  await variantHost.handle({ kind: "dispose" });
}
const cohort = compareShiftCohort(cohorts);
assert.equal(cohort.kind, "observed");
save("cohort.json", cohort);

console.log(
  "Running afternoon prep carryover and stock-driven replenishment checks...",
);
const afternoonScenario = value(
  await compileAfternoonPrep({ piesPerType: 6, batchesPerTea: 3 }),
);
value(await E.admitScenario(afternoonScenario));
const afternoonHost = await open(afternoonScenario, "afternoon-prep", []);
const afternoonDone = await drive(afternoonHost, 28_800e6);
assert.equal(afternoonDone.run.status.kind, "completed");
const decoctionExpected = gingerDecoctions().map((decoction) => ({
  product: decoction.product,
  quantityMg: decoctionMass(decoction) * 3,
}));
const carryoverLots = value(
  extractCarryoverMiseEnPlace(afternoonDone.run, {
    piesPerType: 6,
    pieTypes: PIE_TYPES,
    decoctions: decoctionExpected,
    shiftHorizonSeconds: SIX_HOUR_SHIFT_SECONDS,
  }),
);
assert.equal(carryoverLots.length, 6);
const carryoverShiftScenario = value(
  await compileBakeryShift(
    sixHourShiftRecipeInput({ carryoverMiseEnPlace: carryoverLots }),
    cell,
  ),
);
value(await E.admitScenario(carryoverShiftScenario));
const expiredCarryover = extractCarryoverMiseEnPlace(afternoonDone.run, {
  piesPerType: 6,
  pieTypes: PIE_TYPES,
  decoctions: decoctionExpected,
  elapsedBeforeShiftSeconds: 46 * 3_600,
  shiftHorizonSeconds: SIX_HOUR_SHIFT_SECONDS,
});
assert.equal(expiredCarryover.ok, false);
assert.equal(expiredCarryover.error.code, "expired_carryover_hold");
const expiredCompile = await compileBakeryShift(
  sixHourShiftRecipeInput({
    carryoverMiseEnPlace: carryoverLots.map((lot) => ({
      ...lot,
      elapsedBeforeShiftSeconds: 46 * 3_600,
    })),
  }),
  cell,
);
assert.equal(expiredCompile.ok, false);
assert.equal(expiredCompile.error.code, "invalid_bakery_shift");
await afternoonHost.handle({ kind: "dispose" });

// Cross-shift retail stock carryover from Shift 1 into Shift 2:
const carriedRetailStock = carryoverRetailStock(inventory);
assert.deepEqual(carriedRetailStock, {
  "hazelnut-financier": 5,
  "coffee-financier": 2,
  "matcha-financier": 10,
  "black-sesame-financier": 10,
  "steak-and-pepper-pie": 4,
  "beef-bourguignon-pie": 6,
});
const nextShiftInventory = reportShiftInventory(
  done.run,
  demand.retailOrders,
  carriedRetailStock,
);
verifyInventory(nextShiftInventory);
assert.equal(nextShiftInventory.openingUnits, 37);
assert.ok(nextShiftInventory.soldUnits > inventory.soldUnits);
assert.ok(nextShiftInventory.stockedOutUnits < inventory.stockedOutUnits);
save("cross-shift-carryover.json", {
  afternoonCompletedSeconds: afternoonDone.run.position.time / 1e6,
  carryoverMiseEnPlace: carryoverLots,
  expiredCarryoverError: expiredCarryover.error,
  carriedRetailStock,
  nextShiftInventory,
});

// Stock-driven replenishment dispatch:
// 1. With zero opening stock, wave 1 at 5,100 s sees 0 < 4 units on the shelf
//    and dispatches the replenishment wave.
const stockedInput = sixHourShiftRecipeInput({ reorderThresholdUnits: 4 });
const stockedScenario = value(await compileBakeryShift(stockedInput, cell));
const dispatchHost = await open(stockedScenario, "stock-driven-dispatch");
const dispatchCheck = await drive(dispatchHost, 5_099e6);
while (dispatchCheck.run.status.kind === "awaiting-inspection") {
  const pending = dispatchCheck.view.inspections.find(pendingInspection);
  const timing = teaStrainTiming(
    dispatchCheck.run.definition.scenario,
    dispatchCheck.view.resourceHistory,
    pending.task,
  );
  await inspect(
    dispatchHost,
    dispatchCheck.view,
    inspectionOutcomeFor(pending, timing),
  );
  const next = await drive(dispatchHost, 5_099e6);
  dispatchCheck.run = next.run;
  dispatchCheck.view = next.view;
}
const dispatchDecision = evaluateFinancierReplenishmentWave(
  dispatchCheck.run,
  demand.retailOrders,
  {
    waveIndex: 1,
    waveArrivalSeconds: 5_100,
    reorderThresholdUnits: 4,
  },
);
assert.equal(dispatchDecision.action, "dispatch-wave");
assert.equal(dispatchDecision.closedSources.length, 0);
assert.deepEqual(dispatchDecision.flavoursBelowThreshold, [
  "hazelnut",
  "coffee",
  "matcha",
  "black-sesame",
]);
await dispatchHost.handle({ kind: "dispose" });

// 2. With 8 carried-over units per financier flavour (32 opening units),
//    after the early orders (3 units per flavour), 5 >= 4 units remain on
//    the shelf at 5,099 s, so the controller closes the financier arrival
//    sources via `close-arrivals` and suppresses wave 1.
const ampleOpeningStock = {
  "hazelnut-financier": 8,
  "coffee-financier": 8,
  "matcha-financier": 8,
  "black-sesame-financier": 8,
};
const suppressedHost = await open(stockedScenario, "stock-driven-suppressed");
const suppressedDone = await finishShiftWithStockReplenishment(
  suppressedHost,
  stockedInput,
  demand.retailOrders,
  ampleOpeningStock,
);
assert.equal(suppressedDone.waveDecisions.length, 1);
assert.equal(suppressedDone.waveDecisions[0].action, "suppress-wave");
assert.equal(suppressedDone.waveDecisions[0].closedSources.length, 8);
assert.equal(suppressedDone.closedReceipts.length, 8);
const closedEvents = suppressedDone.run.events.filter(
  (event) => event.kind === "arrivals-closed",
);
assert.equal(closedEvents.length, 8);
const suppressedInventory = reportShiftInventory(
  suppressedDone.run,
  demand.retailOrders,
  ampleOpeningStock,
);
verifyInventory(suppressedInventory);
assert.equal(suppressedInventory.openingUnits, 32);
assert.equal(suppressedInventory.producedUnits, 35);
assert.ok(suppressedInventory.producedUnits < inventory.producedUnits);
save("stock-driven-replenishment.json", {
  dispatchDecision,
  suppressedWaveDecisions: suppressedDone.waveDecisions,
  closedReceipts: suppressedDone.closedReceipts,
  closedEventsCount: closedEvents.length,
  suppressedInventory,
});
await suppressedHost.handle({ kind: "dispose" });

// Measured 6-hour shift intake and comparison verification:
const blankTemplate = blankMeasuredSixHourShiftTemplate();
save("blank-six-hour-template.json", blankTemplate);
const blankParsed = parseMeasuredSixHourShift(JSON.stringify(blankTemplate));
assert.equal(blankParsed.ok, false);
const syntheticMeasuredRaw = {
  kind: "bakery-six-hour-measured-shift",
  schemaVersion: 1,
  shiftId: "synthetic-intake-rehearsal-01",
  site: "pantry-kitchen-rehearsal-bench",
  startTime: "2026-11-01T06:00:00+09:00",
  operatorId: "operator-rehearsal",
  measurementMethod: "synthetic-intake-verification-not-real-shop",
  evidenceRef: "docs/plan-42-calibration-worksheet.md",
  recipeRevision: "plan-61E-rev1",
  metrics: {
    "shift-span-seconds": { kind: "observed", value: 20100, sampleCount: 1 },
    "financier-bake-duration-seconds": {
      kind: "observed",
      value: 930,
      sampleCount: 8,
    },
    "financier-cool-in-mould-seconds": {
      kind: "observed",
      value: 180,
      sampleCount: 8,
    },
    "financier-demould-seconds": {
      kind: "observed",
      value: 52,
      sampleCount: 8,
    },
    "financier-pack-seconds": {
      kind: "observed",
      value: 68,
      sampleCount: 8,
    },
    "worker-walk-transition-seconds": {
      kind: "observed",
      value: 14.5,
      sampleCount: 95,
    },
    "drink-order-mean-wait-seconds": {
      kind: "observed",
      value: 245,
      sampleCount: 24,
    },
    "drink-order-p95-wait-seconds": {
      kind: "observed",
      value: 710,
      sampleCount: 24,
    },
    "baker-utilization-percent": {
      kind: "observed",
      value: 66.5,
      sampleCount: 1,
    },
    "barista-utilization-percent": {
      kind: "observed",
      value: 34.5,
      sampleCount: 1,
    },
    "mould-reuse-ratio": { kind: "observed", value: 4, sampleCount: 8 },
    "saleable-financier-share-percent": {
      kind: "observed",
      value: 87.1,
      sampleCount: 62,
    },
  },
  carryover: {
    reorderThresholdUnits: 4,
    openingRetailUnits: 37,
    endingRetailUnits: 29,
    maxRefrigeratedHoldHoursObserved: 23.85,
  },
};
save("synthetic-measured-six-hour-shift.json", syntheticMeasuredRaw);
const expiredMeasuredParsed = parseMeasuredSixHourShift(
  JSON.stringify({
    ...syntheticMeasuredRaw,
    carryover: {
      ...syntheticMeasuredRaw.carryover,
      maxRefrigeratedHoldHoursObserved: 75,
    },
  }),
);
assert.equal(expiredMeasuredParsed.ok, false);
const validMeasuredParsed = parseMeasuredSixHourShift(
  JSON.stringify(syntheticMeasuredRaw),
);
assert.equal(validMeasuredParsed.ok, true);
const measuredComparison = compareMeasuredSixHourShift(
  report.measurements,
  validMeasuredParsed.value,
);
assert.equal(
  measuredComparison.calibrationStatus,
  "Assumed timings / Uncalibrated (single-shift comparison; separate fitting and validation runs required)",
);
const spanComparison = measuredComparison.metrics.find(
  (m) => m.id === "shift-span-seconds",
);
assert.equal(spanComparison?.signedError, 19956.5 - 20100);
save("measured-six-hour-comparison.json", measuredComparison);

console.log("Executing actual Wasm appliance runs and checkpoint recovery...");
function wasmApplianceModule() {
  return runtimeModule(runtime);
}
const shiftApplianceBindings = recipeApplianceTasks(done.run);
const shiftScheduledTasks = extractScheduledTasks(done.run);
const appliance = await executeRecipeApplianceTasks(
  shiftApplianceBindings,
  wasmApplianceModule,
  { runId: "six-hour-appliances", scheduledTasks: shiftScheduledTasks },
);
const recovery = await executeRecipeApplianceTasks(
  shiftApplianceBindings,
  wasmApplianceModule,
  {
    runId: "six-hour-recovery",
    faultInjections: defaultMorningShiftFaultInjections(),
    scheduledTasks: shiftScheduledTasks,
  },
);
// The shift's mixer, oven, mould wash and pie bench each fault once and resume.
// The sesame blender does not run: the morning opens with concentrate on hand.
assert.deepEqual(recovery.faultRestores.map((fault) => fault.taskId).sort(), [
  "hazelnut-preparation-batches#0/mix",
  "load-hazelnut-a#0/bake",
  "load-hazelnut-a#0/clean-mould",
  "steak-and-pepper-pie-batches#0/line-tins-a",
]);
for (const fault of recovery.faultRestores) {
  assert.equal(
    fault.resumedFromFaultCheckpointDigest,
    fault.faultCheckpointDigest,
  );
  assert.notEqual(fault.restoredCheckpointDigest, fault.faultCheckpointDigest);
  assert.ok(fault.restoredSampleCount > 0);
}
save("appliances.json", {
  ...appliance,
  continuations: [...appliance.continuations],
});
save("appliance-recovery.json", {
  ...recovery,
  continuations: [...recovery.continuations],
});
await host.handle({ kind: "dispose" });
save("report.json", {
  result: "passed",
  executionBundle: manifest.bundle.id,
  runtime: manifest.runtime.id,
  sourceDigests,
  shiftCompletionSeconds: done.run.position.time / 1e6,
  producedUnits: inventory.producedUnits,
  soldUnits: inventory.soldUnits,
  stockoutUnits: inventory.stockedOutUnits,
  carryoverNextShiftSoldUnits: nextShiftInventory.soldUnits,
  carryoverNextShiftStockoutUnits: nextShiftInventory.stockedOutUnits,
  suppressedWaveProducedUnits: suppressedInventory.producedUnits,
  trace: {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    verifiedPathHops: path.hopCount,
  },
  recoveredAppliances: recovery.faultRestores.length,
  calibration: "Assumed timings / Uncalibrated",
  outOfRangeMetrics: report.measurements.metrics.filter(
    (metric) => compareShiftMetric(metric) === "outside-assumption",
  ),
  evidence: [
    "input.json",
    "scenario.json",
    "run.json",
    "view.json",
    "trace.json",
    "shift-report.json",
    "inventory.json",
    "cross-shift-carryover.json",
    "stock-driven-replenishment.json",
    "blank-six-hour-template.json",
    "synthetic-measured-six-hour-shift.json",
    "measured-six-hour-comparison.json",
    "appliances.json",
    "appliance-recovery.json",
    "withheld-evidence-report.json",
    "cohort.json",
  ],
});
console.log(`Six-hour execution and evidence checks passed: ${output}`);
