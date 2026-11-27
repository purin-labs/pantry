import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../packages/std/src/index.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/financier.ts";
import {
  blackSesameRecipeInput,
  compileBlackSesameRecipe,
} from "../../packages/production-simulation/src/recipes/bakery/black-sesame-milk.ts";
import {
  compileGingerBlackTeaRecipe,
  compileGingerMilkTeaRecipe,
  gingerBlackTeaRecipeInput,
  gingerMilkTeaRecipeInput,
  teaStrainTiming,
} from "../../packages/production-simulation/src/recipes/bakery/tea.ts";
import {
  compileBakeryShift,
  morningShiftRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import {
  defaultMorningShiftFaultInjections,
  evaluatePendingInspectionGate,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
} from "../../packages/production-simulation/src/recipes/bakery/appliance-execution.ts";
import { recipeApplianceTasks } from "../../packages/production-simulation/src/recipes/bakery/appliance-task-table.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { defineCell, runtimeModule } from "./build-execution-bundle.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";

const output = resolve(
  process.argv[2] ?? "output/plan-61-appliance-wasm-evidence",
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const engineDirectory = resolve(
  `apps/portal/public/bakery-physics/executions/${manifest.bundle.id}`,
);
const runtimeDir = resolve(
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

const prepModule = await runtimeModule(runtimeDir);
const rackCell = defineCell(prepModule, "cold-rack-cell");
const panCell = defineCell(prepModule, "tea-pan-cell", {
  fixture: "pan-staging",
});

function unwrap(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}

async function runScenarioToCompletion(name, scenario, cells) {
  const host = collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtimeDir), codec),
  );
  const began = await host.handle({
    kind: "begin",
    bundle: manifest.bundle,
    cells,
    identity: {
      runId: `${name}-run`,
      executionId: `${name}-exec`,
      hostSession: `host-${name}`,
      parent: null,
    },
    origin: { kind: "scenario", scenario },
  });
  assert.equal(began.kind, "began", JSON.stringify(began));

  const horizonUs = scenario.limits.horizon;
  for (let turn = 0; turn < 6000; turn++) {
    const reply = await host.handle({
      kind: "drive",
      turns: 128,
      until: horizonUs,
    });
    assert.equal(reply.kind, "drove", JSON.stringify(reply));
    if (reply.view.status.kind === "awaiting-inspection") {
      const pending = reply.view.inspections.find(
        (entry) => entry.kind === "pending",
      );
      assert.ok(pending, "Expected pending inspection");
      const timing = teaStrainTiming(
        scenario,
        reply.view.resourceHistory,
        pending.task,
      );
      const gateDecision = evaluatePendingInspectionGate(pending.task, {
        strainTimingKind: timing.kind,
      });
      const outcome = gateDecision.recommendedOutcome;
      const commanded = await host.handle({
        kind: "inspect",
        commandId: `inspect-${turn}-${pending.task.replace(/[^a-z0-9-]/gi, "-")}`,
        expectedControlRevision: reply.view.controlRevision,
        task: pending.task,
        definition: pending.definition,
        lots: pending.lots,
        outcome,
        note: `${gateDecision.gateKind} (${outcome}): ${gateDecision.rationale}`,
      });
      assert.equal(commanded.kind, "commanded");
      assert.equal(commanded.receipt.status, "accepted");
      continue;
    }
    if (reply.view.status.kind === "completed") {
      const state = await host.handle({ kind: "state" });
      assert.equal(state.kind, "state");
      await host.handle({ kind: "dispose" });
      return state.run;
    }
    if (
      reply.view.status.kind === "blocked" ||
      reply.view.status.kind === "stopped-at-limit"
    ) {
      throw new Error(
        `Scenario ${name} stopped in ${JSON.stringify(reply.view.status)}`,
      );
    }
  }
  throw new Error(`Scenario ${name} exceeded turn bound`);
}

function verifyApplianceReport(planName, report, expectedCategories) {
  assert.ok(report.taskCount > 0, `${planName}: expected bound tasks`);
  const lastDigestByAppliance = new Map();
  const seenCategories = new Set();
  const seenAppliances = new Set();

  for (const record of report.records) {
    assert.equal(
      record.result.outcome.kind,
      "completed",
      `${planName}: ${record.taskId} failed`,
    );
    assert.ok(
      record.sampleCount >= 2,
      `${planName}: ${record.taskId} missing MuJoCo samples`,
    );
    assert.ok(
      record.simulatedSeconds > 0,
      `${planName}: ${record.taskId} did not advance simulation time`,
    );
    assert.match(record.recordingDigest, /^[a-f0-9]{64}$/u);
    assert.match(record.checkpointDigest, /^[a-f0-9]{64}$/u);

    const expectedPrior = lastDigestByAppliance.get(record.appliance) ?? null;
    assert.equal(
      record.resumedFromCheckpointDigest,
      expectedPrior,
      `${planName}: broken checkpoint continuation chain on ${record.appliance} at ${record.taskId}`,
    );
    lastDigestByAppliance.set(record.appliance, record.checkpointDigest);

    if (record.inputBatch !== null) {
      assert.equal(
        record.transferred.length,
        1,
        `${planName}: ${record.taskId} did not transfer batch out of ${record.appliance}`,
      );
      assert.ok(
        Math.abs(record.transferred[0].mass_kg - record.inputBatch.mass_kg) <
          1e-6,
        `${planName}: ${record.taskId} batch mass mismatch`,
      );
    }

    assert.ok(
      record.coupledPhysics !== undefined && record.coupledPhysics !== null,
      `${planName}: ${record.taskId} missing coupledPhysics`,
    );
    assert.ok(
      Number.isFinite(record.coupledPhysics.entryTemperatureC),
      `${planName}: ${record.taskId} invalid entryTemperatureC`,
    );
    assert.ok(
      Number.isFinite(record.coupledPhysics.exitTemperatureC),
      `${planName}: ${record.taskId} invalid exitTemperatureC`,
    );
    assert.ok(
      Number.isFinite(record.coupledPhysics.enthalpyDeltaJoules),
      `${planName}: ${record.taskId} invalid enthalpyDeltaJoules`,
    );
    assert.ok(
      Number.isFinite(record.coupledPhysics.apparentViscosityPas) &&
        record.coupledPhysics.apparentViscosityPas >= 0,
      `${planName}: ${record.taskId} invalid apparentViscosityPas`,
    );
    assert.ok(
      Number.isFinite(record.coupledPhysics.durationCouplingFactor) &&
        record.coupledPhysics.durationCouplingFactor >= 0.75 &&
        record.coupledPhysics.durationCouplingFactor <= 1.35,
      `${planName}: ${record.taskId} invalid durationCouplingFactor`,
    );
    if (
      record.taskKey === "brown-butter" ||
      record.taskKey === "roast-sesame" ||
      record.taskKey === "bake"
    ) {
      assert.ok(
        record.coupledPhysics.maillardBrowningIndex > 0,
        `${planName}: ${record.taskId} expected positive Maillard browning index, got ${record.coupledPhysics.maillardBrowningIndex}`,
      );
    }
    if (
      record.taskKey === "simmer-ginger" ||
      record.taskKey === "simmer-tea" ||
      record.taskKey === "extract-espresso" ||
      record.taskKey === "brew-pour-over"
    ) {
      assert.ok(
        record.coupledPhysics.extractionSolidsYieldPercent > 0,
        `${planName}: ${record.taskId} expected positive extraction solids yield, got ${record.coupledPhysics.extractionSolidsYieldPercent}`,
      );
    }
    assert.ok(
      record.coupledPhysics.inspectionDecision !== undefined &&
        record.coupledPhysics.acousticNoiseDba > 35 &&
        record.coupledPhysics.vibrationMmPerSecRms > 0 &&
        record.coupledPhysics.massAccounting !== undefined &&
        record.coupledPhysics.massAccounting.inputMassGrams > 0,
      `${planName}: ${record.taskId} missing coupledPhysics.inspectionDecision, acoustic/vibration, or massAccounting`,
    );
    // The second tray sits on the oven's middle-rear hotspot deck: the
    // second hazelnut tray alone, the coffee tray in the four-flavour shift.
    if (
      record.taskId === "load-hazelnut-b#0/bake" ||
      record.taskId === "load-coffee-a#0/bake"
    ) {
      assert.equal(
        record.coupledPhysics.inspectionDecision.recommendedOutcome,
        "reject",
        `${planName}: expected ${record.taskId} middle-rear deck hotspot to recommend reject`,
      );
      assert.equal(
        record.coupledPhysics.massAccounting.rejectedScrapGrams,
        188,
        `${planName}: expected ${record.taskId} to record 188 g rejected scrap`,
      );
      assert.equal(
        record.coupledPhysics.massAccounting.acceptedYieldGrams,
        0,
        `${planName}: expected ${record.taskId} to record 0 g accepted yield`,
      );
      assert.equal(
        record.coupledPhysics.massAccounting.reworkRequired,
        true,
        `${planName}: expected ${record.taskId} to require rework`,
      );
    }
    if (record.taskKey === "bake-pies") {
      assert.equal(
        record.coupledPhysics.inspectionDecision.recommendedOutcome,
        "accept",
        `${planName}: expected ${record.taskId} egg-washed lids within the golden-brown spec`,
      );
    }

    if (
      record.appliance === "hoshizaki-rt-120snj" ||
      record.category === "chiller"
    ) {
      assert.ok(
        record.coupledPhysics.chillerTelemetry !== null &&
          record.coupledPhysics.chillerTelemetry.doorOpenCount === 2 &&
          record.coupledPhysics.chillerTelemetry.doorInfiltrationTotalJoules >
            1000 &&
          record.coupledPhysics.chillerTelemetry.moistureIngressGrams > 0.5 &&
          record.coupledPhysics.chillerTelemetry.cabinetAirInfiltrationPeakC >
            record.coupledPhysics.chillerTelemetry.cabinetAirBaseC,
        `${planName}: ${record.taskId} invalid chillerTelemetry`,
      );
    }

    if (
      record.appliance === "winterhalter-uc-l" ||
      record.category === "dishwasher"
    ) {
      assert.ok(
        record.coupledPhysics.dishwasherTelemetry !== null &&
          record.coupledPhysics.dishwasherTelemetry.detergentDosedMl >= 7.0 &&
          record.coupledPhysics.dishwasherTelemetry.rinseAidDosedMl >= 0.8 &&
          record.coupledPhysics.dishwasherTelemetry.sanitizerConcentrationPpm >=
            65 &&
          record.coupledPhysics.dishwasherTelemetry.nsfThermalDisinfectionHue >=
            3600 &&
          record.coupledPhysics.dishwasherTelemetry.greywaterHeatRecoveredKj >
            200 &&
          record.coupledPhysics.dishwasherTelemetry
            .heatRecoveryEfficiencyPercent > 50,
        `${planName}: ${record.taskId} invalid dishwasherTelemetry`,
      );
    }

    if (
      record.appliance === "la-marzocco-linea-classic-s-2g" ||
      record.category === "espresso"
    ) {
      assert.ok(
        record.coupledPhysics.espressoTelemetry !== null &&
          record.coupledPhysics.espressoTelemetry.groupheadEntryTempC >= 92.0 &&
          record.coupledPhysics.espressoTelemetry.groupheadMinTempC >= 91.5 &&
          record.coupledPhysics.espressoTelemetry.groupheadThermalDipC > 0.3 &&
          record.coupledPhysics.espressoTelemetry.pidRecoverySeconds > 3.0 &&
          record.coupledPhysics.espressoTelemetry.steamBoilerPressureBar >=
            1.05,
        `${planName}: ${record.taskId} invalid espressoTelemetry`,
      );
    }

    if (record.appliance === "maruzen-mbco-5e" || record.category === "oven") {
      assert.ok(
        record.coupledPhysics.ovenVentingTelemetry !== null &&
          record.coupledPhysics.ovenVentingTelemetry
            .deckRadiantHeatFluxKwPerSqM > 1.5 &&
          record.coupledPhysics.ovenVentingTelemetry.totalDeckHeatFluxKwPerSqM >
            3.0 &&
          record.coupledPhysics.ovenVentingTelemetry
            .crustMoistureDiffusivitySqMPerSec > 1e-10 &&
          record.coupledPhysics.ovenVentingTelemetry.surfaceWaterActivityAw >
            0.25 &&
          record.coupledPhysics.ovenVentingTelemetry.surfaceWaterActivityAw <
            0.7,
        `${planName}: ${record.taskId} invalid ovenVentingTelemetry`,
      );
    }

    if (record.category === "hob") {
      assert.ok(
        record.coupledPhysics.hobTelemetry !== null &&
          record.coupledPhysics.hobTelemetry.couplingEfficiencyPercent >=
            45.0 &&
          record.coupledPhysics.hobTelemetry.panBaseRadialGradientC >= 4.5 &&
          record.coupledPhysics.hobTelemetry.boilOffVaporRateGramsPerSec >=
            0.35 &&
          record.coupledPhysics.hobTelemetry.cumulativeBoilOffGrams > 2.0,
        `${planName}: ${record.taskId} invalid hobTelemetry`,
      );
    }

    if (
      record.category === "weigh" ||
      record.appliance === "ohaus-ranger-3000"
    ) {
      assert.ok(
        record.coupledPhysics.scaleTelemetry !== null &&
          record.coupledPhysics.scaleTelemetry.loadCellSettlingTimeSeconds >=
            0.7 &&
          record.coupledPhysics.scaleTelemetry.loadCellSettlingTimeSeconds <=
            1.5 &&
          record.coupledPhysics.scaleTelemetry.zeroTareDriftMg > 0 &&
          record.coupledPhysics.scaleTelemetry.airDraftDisturbanceMgPeak >=
            35.0 &&
          record.coupledPhysics.scaleTelemetry.digitalFilterRejectionDb >= 35.0,
        `${planName}: ${record.taskId} invalid scaleTelemetry`,
      );
    }

    if (record.category === "mixer" || record.appliance === "hobart-hl200") {
      assert.ok(
        record.coupledPhysics.mixerTelemetry !== null &&
          record.coupledPhysics.mixerTelemetry.specificWorkInputWhPerKg >=
            0.15 &&
          record.coupledPhysics.mixerTelemetry.meanShaftTorqueNm >= 3.5 &&
          record.coupledPhysics.mixerTelemetry.shaftTorqueRippleNmPeakToPeak >=
            0.5 &&
          record.coupledPhysics.mixerTelemetry.emulsionDevelopmentIndex >= 0.7,
        `${planName}: ${record.taskId} invalid mixerTelemetry`,
      );
    }

    if (
      record.category === "milk-frother" ||
      record.appliance === "severin-sm-3587"
    ) {
      assert.ok(
        record.coupledPhysics.frotherTelemetry !== null &&
          record.coupledPhysics.frotherTelemetry.vortexShearRateInverseSec >=
            1400 &&
          record.coupledPhysics.frotherTelemetry.microfoamOverrunPercent >=
            35.0 &&
          record.coupledPhysics.frotherTelemetry
            .betaLactoglobulinDenaturationPercent >= 55.0,
        `${planName}: ${record.taskId} invalid frotherTelemetry`,
      );
    }

    if (
      record.category === "pastry-bench" ||
      record.appliance === "pastry-bench"
    ) {
      const lastSample = record.result.samples.at(-1);
      const pt = record.coupledPhysics.pastryTelemetry;
      const modeValid =
        pt !== null &&
        (pt.taskMode === "press-dough-block"
          ? pt.doughBlockVertexCount === 75 &&
            pt.doughBlockTriangleCount === 128 &&
            pt.doughBlockHeightMm <= 24.5 &&
            pt.doughBlockSpanMm >= 78.0
          : pt.vertexCount === 81 &&
            pt.triangleCount === 128 &&
            pt.cavityDrapeMm >= 14.0 &&
            pt.sealCoveragePct >= 75.0);
      assert.ok(
        pt !== null &&
          modeValid &&
          pt.benchTempC <= 21.0 &&
          lastSample !== undefined &&
          lastSample.flexMeshes.length === 2 &&
          lastSample.flexMeshes[0].name === "pastry_sheet" &&
          lastSample.flexMeshes[1].name === "dough_block",
        `${planName}: ${record.taskId} invalid pastryTelemetry or flexMeshes: ${JSON.stringify(pt)}`,
      );
    }

    seenCategories.add(record.category);
    seenAppliances.add(record.appliance);
  }

  assert.ok(
    report.facilityUtilities !== undefined &&
      report.facilityUtilities.peakTotalPowerWatts > 1200 &&
      report.facilityUtilities.minLineVoltageVolts <= 208 &&
      report.facilityUtilities.minWaterManifoldPressureBar <= 3.5 &&
      report.facilityUtilities.totalElectricalEnergyWh > 0 &&
      report.facilityUtilities.hvacPsychrometrics !== undefined &&
      report.facilityUtilities.hvacPsychrometrics.peakDryBulbC >= 21.0 &&
      report.facilityUtilities.hvacPsychrometrics.peakRelativeHumidityPercent >=
        48.0 &&
      report.facilityUtilities.hvacPsychrometrics.peakCanopyHoodExhaustCfm >=
        460 &&
      report.facilityUtilities.hvacPsychrometrics.peakSpecificEnthalpyKjPerKg >
        40 &&
      report.facilityUtilities.acousticsAndVibration !== undefined &&
      report.facilityUtilities.acousticsAndVibration.peakRoomNoiseDba > 60 &&
      report.facilityUtilities.acousticsAndVibration.peakVibrationMmPerSecRms >
        1.5 &&
      report.facilityUtilities.chillerColdCell !== undefined &&
      report.facilityUtilities.chillerColdCell.totalDoorOpenings >= 2 &&
      report.facilityUtilities.chillerColdCell.totalInfiltrationHeatKj > 0 &&
      report.facilityUtilities.chillerColdCell.peakCabinetAirSpikeC > 5.0 &&
      report.facilityUtilities.chillerColdCell.defrostCycleCount >= 1 &&
      report.facilityUtilities.chillerColdCell.totalCondensateDrainedGrams >
        0 &&
      report.facilityUtilities.dishwasherWarewash !== undefined &&
      report.facilityUtilities.dishwasherWarewash.totalWashCycles >= 1 &&
      report.facilityUtilities.dishwasherWarewash.totalDetergentDosedMl >=
        7.0 &&
      report.facilityUtilities.dishwasherWarewash.minSanitizerPpm >= 65 &&
      report.facilityUtilities.dishwasherWarewash.totalGreywaterRecoveredKj >
        200 &&
      report.facilityUtilities.dishwasherWarewash
        .meanHeatRecoveryEfficiencyPercent > 50 &&
      report.facilityUtilities.espressoBoiler !== undefined &&
      (!expectedCategories.includes("espresso") ||
        (report.facilityUtilities.espressoBoiler.totalExtractedShots >= 1 &&
          report.facilityUtilities.espressoBoiler.minGroupheadTempC >= 91.5 &&
          report.facilityUtilities.espressoBoiler.maxGroupheadThermalDipC >
            0.3 &&
          report.facilityUtilities.espressoBoiler.minSteamBoilerPressureBar >=
            1.05)) &&
      report.facilityUtilities.ovenVentingRadiant !== undefined &&
      (!expectedCategories.includes("oven") ||
        (report.facilityUtilities.ovenVentingRadiant.totalOvenCycles >= 1 &&
          report.facilityUtilities.ovenVentingRadiant
            .nominalDeckHeatFluxKwPerSqM > 3.0 &&
          report.facilityUtilities.ovenVentingRadiant
            .peakSteamVentingRateGramsPerSec > 0.4 &&
          report.facilityUtilities.ovenVentingRadiant
            .minSurfaceWaterActivityAw < 0.7)) &&
      report.facilityUtilities.hobCoilThermal !== undefined &&
      report.facilityUtilities.hobCoilThermal.totalHobCycles >= 1 &&
      report.facilityUtilities.hobCoilThermal.meanCouplingEfficiencyPercent >=
        80.0 &&
      report.facilityUtilities.hobCoilThermal.maxPanBaseRadialGradientC >=
        4.5 &&
      report.facilityUtilities.hobCoilThermal.peakBoilOffVaporRateGramsPerSec >=
        0.35 &&
      report.facilityUtilities.precisionScale !== undefined &&
      report.facilityUtilities.precisionScale.totalWeighings >= 1 &&
      report.facilityUtilities.precisionScale.meanSettlingTimeSeconds >= 0.7 &&
      report.facilityUtilities.precisionScale.maxZeroTareDriftMg > 0 &&
      report.facilityUtilities.precisionScale.meanFilterRejectionDb >= 35.0 &&
      report.facilityUtilities.planetaryMixer !== undefined &&
      report.facilityUtilities.planetaryMixer.totalMixCycles >= 1 &&
      report.facilityUtilities.planetaryMixer.totalSpecificWorkWhPerKg >= 0.3 &&
      report.facilityUtilities.planetaryMixer.maxTorqueRippleNmPeakToPeak >=
        0.5 &&
      report.facilityUtilities.planetaryMixer.meanEmulsionIndex >= 0.7 &&
      report.facilityUtilities.milkFrother !== undefined &&
      report.facilityUtilities.milkFrother.totalFrothCycles >= 1 &&
      report.facilityUtilities.milkFrother.meanMicrofoamOverrunPercent >=
        35.0 &&
      report.facilityUtilities.milkFrother.peakVortexShearRateInverseSec >=
        1400 &&
      report.facilityUtilities.milkFrother.meanWheyDenaturationPercent >=
        55.0 &&
      report.massBalance !== undefined &&
      report.massBalance.totalAcceptedYieldGrams > 0,
    `${planName}: invalid facilityUtilities, hvacPsychrometrics, acousticsAndVibration, chillerColdCell, dishwasherWarewash, espressoBoiler, ovenVentingRadiant, hobCoilThermal, precisionScale, planetaryMixer, milkFrother, or massBalance summary: ${JSON.stringify({ u: report.facilityUtilities, m: report.massBalance })}`,
  );

  assert.ok(
    report.carrierReturnSummary &&
      report.carrierReturnSummary.waveCount >= 1 &&
      report.carrierReturnSummary.totalCarrierReturns > 0 &&
      report.carrierReturnSummary.overallReuseRatio > 0 &&
      report.carrierReturnSummary.pools.length === 6,
    `${planName}: invalid carrierReturnSummary`,
  );

  for (const category of expectedCategories) {
    assert.ok(
      seenCategories.has(category),
      `${planName}: missing expected category ${category}`,
    );
  }

  return {
    plan: planName,
    runId: report.runId,
    taskCount: report.taskCount,
    applianceCount: report.applianceCount,
    categories: [...seenCategories].sort(),
    appliances: [...seenAppliances].sort(),
    facilityUtilities: report.facilityUtilities,
    massBalance: report.massBalance,
    carrierReturnSummary: report.carrierReturnSummary,
    finalCheckpointDigests: report.checkpointDigests,
    records: report.records.map((r) => ({
      index: r.index,
      taskId: r.taskId,
      workflowId: r.workflowId,
      taskKey: r.taskKey,
      category: r.category,
      appliance: r.appliance,
      startedAtSeconds: r.startedAtUs / 1_000_000,
      completedAtSeconds: r.completedAtUs / 1_000_000,
      simulatedSeconds: r.simulatedSeconds,
      sampleCount: r.sampleCount,
      resumedFromCheckpointDigest: r.resumedFromCheckpointDigest,
      checkpointDigest: r.checkpointDigest,
      recordingDigest: r.recordingDigest,
      inputMassKg: r.inputBatch?.mass_kg ?? null,
      inputTemperatureC: r.inputBatch?.temperature_c ?? null,
      outputMassKg: r.transferred[0]?.mass_kg ?? null,
      outputTemperatureC:
        r.transferred[0] !== undefined
          ? Number(r.transferred[0].temperature_c.toFixed(3))
          : null,
      coupledPhysics: r.coupledPhysics,
    })),
  };
}

const wasmApplianceModule = () => runtimeModule(runtimeDir);

// 1. Plan 61A Financier
const financierScenario = unwrap(
  await compileFinancierRecipe(financierRecipeInput(2, 2, 900), rackCell),
);
const financierRun = await runScenarioToCompletion(
  "plan-61a-financier",
  financierScenario,
  [rackCell],
);
const financierReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(financierRun),
  wasmApplianceModule,
  { runId: "plan-61a-financier" },
);
const financierSummary = verifyApplianceReport(
  "61A-financier",
  financierReport,
  ["weigh", "hob", "mixer", "oven", "chiller", "dishwasher"],
);
writeFileSync(
  join(output, "financier-appliances.json"),
  `${canonicalJson(financierSummary)}\n`,
);
console.log(
  `Plan 61A Financier: ${financierSummary.taskCount} tasks across ${financierSummary.applianceCount} appliances verified.`,
);

// 2. Plan 61B Black Sesame Milk (with roasting enabled so oven + chiller + grinder + hob + blender + frother + scale + dishwasher all run)
const sesameInput = blackSesameRecipeInput();
sesameInput.roast = "refresh";
sesameInput.batchArrivalsSeconds = [0];
sesameInput.orderArrivalsSeconds = [1800, 1860];
const sesameScenario = unwrap(
  await compileBlackSesameRecipe(sesameInput, rackCell),
);
const sesameRun = await runScenarioToCompletion(
  "plan-61b-black-sesame",
  sesameScenario,
  [rackCell],
);
const sesameReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(sesameRun),
  wasmApplianceModule,
  { runId: "plan-61b-black-sesame" },
);
const sesameSummary = verifyApplianceReport(
  "61B-black-sesame-milk",
  sesameReport,
  [
    "weigh",
    "oven",
    "chiller",
    "grinder",
    "hob",
    "blender",
    "milk-frother",
    "dishwasher",
  ],
);
writeFileSync(
  join(output, "black-sesame-appliances.json"),
  `${canonicalJson(sesameSummary)}\n`,
);
console.log(
  `Plan 61B Black Sesame Milk: ${sesameSummary.taskCount} tasks across ${sesameSummary.applianceCount} appliances verified.`,
);

// 3. Plan 61C Ginger Black Tea
const blackTeaScenario = unwrap(
  await compileGingerBlackTeaRecipe(gingerBlackTeaRecipeInput(), panCell),
);
const blackTeaRun = await runScenarioToCompletion(
  "plan-61c-ginger-black-tea",
  blackTeaScenario,
  [panCell],
);
const blackTeaReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(blackTeaRun),
  wasmApplianceModule,
  { runId: "plan-61c-ginger-black-tea" },
);
const blackTeaSummary = verifyApplianceReport(
  "61C-ginger-black-tea",
  blackTeaReport,
  ["weigh", "hob", "dishwasher"],
);
writeFileSync(
  join(output, "ginger-black-tea-appliances.json"),
  `${canonicalJson(blackTeaSummary)}\n`,
);
console.log(
  `Plan 61C Ginger Black Tea: ${blackTeaSummary.taskCount} tasks across ${blackTeaSummary.applianceCount} appliances verified.`,
);

// 4. Plan 61D Ginger Milk Tea
const milkTeaScenario = unwrap(
  await compileGingerMilkTeaRecipe(gingerMilkTeaRecipeInput(), panCell),
);
const milkTeaRun = await runScenarioToCompletion(
  "plan-61d-ginger-milk-tea",
  milkTeaScenario,
  [panCell],
);
const milkTeaReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(milkTeaRun),
  wasmApplianceModule,
  { runId: "plan-61d-ginger-milk-tea" },
);
const milkTeaSummary = verifyApplianceReport(
  "61D-ginger-milk-tea",
  milkTeaReport,
  ["weigh", "hob", "dishwasher"],
);
writeFileSync(
  join(output, "ginger-milk-tea-appliances.json"),
  `${canonicalJson(milkTeaSummary)}\n`,
);
console.log(
  `Plan 61D Ginger Milk Tea: ${milkTeaSummary.taskCount} tasks across ${milkTeaSummary.applianceCount} appliances verified.`,
);

// 5. Plan 61E Full Six-Recipe Morning Shift (2 Continuous Production Waves with Closed-Loop Carrier Return)
// The same-morning shift makes the sesame concentrate, ginger decoctions,
// shortcrust and fillings too, so every recipe step meets its appliance. Two
// production waves need the barista to help the baker to finish in 8 h.
const shiftInput = morningShiftRecipeInput({
  miseEnPlace: "same-morning",
  baristaHelpsProduction: true,
  financierWaves: 2,
  waveIntervalMinutes: 45,
  mouldCount: 2,
  coolingGridSlots: 2,
  demandPreset: "rush",
  workers: 2,
  hobZones: 2,
  panCount: 3,
  sesamePreparation: "early",
});
const shiftScenario = unwrap(await compileBakeryShift(shiftInput, panCell));
const shiftRun = await runScenarioToCompletion(
  "plan-61e-morning-shift",
  shiftScenario,
  [panCell],
);
const shiftReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(shiftRun),
  wasmApplianceModule,
  {
    runId: "plan-61e-morning-shift",
    scheduledTasks: extractScheduledTasks(shiftRun),
  },
);
const shiftSummary = verifyApplianceReport("61E-morning-shift", shiftReport, [
  "weigh",
  "hob",
  "mixer",
  "grinder",
  "blender",
  "milk-frother",
  "espresso",
  "oven",
  "chiller",
  "dishwasher",
  "pastry-bench",
]);
assert.ok(
  shiftReport.carrierReturnSummary.waveCount >= 2 &&
    shiftReport.carrierReturnSummary.overallReuseRatio >= 2.0,
  `Expected multi-wave closed-loop carrier reuse in 61E Morning Shift, got ${JSON.stringify(shiftReport.carrierReturnSummary)}`,
);
const mouldPool = shiftReport.carrierReturnSummary.pools.find(
  (p) => p.poolId === "moulds",
);
const gridPool = shiftReport.carrierReturnSummary.pools.find(
  (p) => p.poolId === "cooling-grids",
);
assert.ok(
  mouldPool && mouldPool.returns >= 6 && mouldPool.reuseRatio >= 3.0,
  `Expected at least 6 mould returns (3.0x reuse across 2 waves), got ${JSON.stringify(mouldPool)}`,
);
assert.ok(
  gridPool && gridPool.returns >= 6 && gridPool.reuseRatio >= 3.0,
  `Expected at least 6 cooling-grid returns (3.0x reuse across 2 waves), got ${JSON.stringify(gridPool)}`,
);
for (const pie of ["steak-and-pepper", "beef-bourguignon"]) {
  for (const key of [
    "sear-beef",
    "braise-filling",
    "chill-filling",
    "line-tins-a",
    "lid-pies-a",
    "bake-pies",
  ])
    assert.ok(
      shiftSummary.records.some(
        (r) => r.taskId.startsWith(`${pie}-`) && r.taskKey === key,
      ),
      `Expected the ${pie} ${key} step on its MuJoCo appliance`,
    );
}
assert.ok(
  shiftSummary.facilityUtilities.pastryBench.totalPastryCycles >= 9 &&
    shiftSummary.facilityUtilities.pastryBench.doughBlockPressCycles >= 1 &&
    shiftSummary.facilityUtilities.pastryBench.minDoughBlockHeightMm <= 24.5 &&
    shiftSummary.facilityUtilities.pastryBench.peakCavityDrapeMm >= 18.0,
  `Expected >= 9 deformable pastry-bench cycles (including 3D dough-block press) in 61E Morning Shift, got ${JSON.stringify(shiftSummary.facilityUtilities.pastryBench)}`,
);
assert.ok(
  shiftSummary.records.some(
    (r) =>
      r.taskKey === "wrap-and-chill-shortcrust" &&
      r.appliance === "pastry-bench",
  ),
  "Expected wrap-and-chill-shortcrust 3D dough press on pastry-bench",
);
assert.ok(
  shiftSummary.records.some(
    (r) => r.taskKey === "mix-shortcrust" && r.appliance === "hobart-hl200",
  ),
  "Expected the shortcrust mix on the HL200",
);
for (const mixIn of [
  "weigh-roasted-hazelnut-flour",
  "weigh-instant-espresso",
  "weigh-matcha",
  "weigh-black-sesame-paste",
])
  assert.ok(
    shiftSummary.records.some(
      (r) => r.taskKey === mixIn && r.appliance === "ohaus-ranger-3000",
    ),
    `Expected the ${mixIn} mix-in weighed on the Ohaus scale`,
  );
const crossWorkflowHandoffs = shiftSummary.records.filter(
  (r) => r.coupledPhysics.upstreamSourceInstanceId !== null,
);
assert.ok(
  crossWorkflowHandoffs.length >= 4,
  `Expected at least 4 cross-workflow thermal handoffs in 61E Morning Shift, got ${crossWorkflowHandoffs.length}`,
);
writeFileSync(
  join(output, "morning-shift-appliances.json"),
  `${canonicalJson(shiftSummary)}\n`,
);
console.log(
  `Plan 61E Morning Shift: ${shiftSummary.taskCount} tasks across ${shiftSummary.applianceCount} appliances verified.`,
);

// 6. Plan 61E Mid-Cycle Appliance Fault & Checkpoint-Restore Journey
const faultRestoreReport = await executeRecipeApplianceTasks(
  recipeApplianceTasks(shiftRun),
  wasmApplianceModule,
  {
    runId: "plan-61e-fault-restore",
    faultInjections: defaultMorningShiftFaultInjections(),
    scheduledTasks: extractScheduledTasks(shiftRun),
  },
);
const faultRestoreSummary = verifyApplianceReport(
  "61E-morning-shift-fault-restore",
  faultRestoreReport,
  [
    "weigh",
    "hob",
    "mixer",
    "grinder",
    "blender",
    "milk-frother",
    "espresso",
    "oven",
    "chiller",
    "dishwasher",
    "pastry-bench",
  ],
);
assert.equal(
  faultRestoreReport.faultRestores.length,
  5,
  `Expected 5 mid-cycle appliance fault-restore records, got ${faultRestoreReport.faultRestores.length}`,
);
assert.ok(
  faultRestoreReport.faultRestores.some(
    (fr) =>
      fr.appliance === "pastry-bench" &&
      fr.faultKind === "pastry-bench-unfloured",
  ),
  "Expected pastry-bench-unfloured fault-restore record",
);
for (const fr of faultRestoreReport.faultRestores) {
  assert.match(fr.faultRecordingDigest, /^[a-f0-9]{64}$/u);
  assert.match(fr.faultCheckpointDigest, /^[a-f0-9]{64}$/u);
  assert.match(fr.restoredRecordingDigest, /^[a-f0-9]{64}$/u);
  assert.match(fr.restoredCheckpointDigest, /^[a-f0-9]{64}$/u);
  assert.equal(fr.resumedFromFaultCheckpointDigest, fr.faultCheckpointDigest);
  assert.notEqual(fr.restoredCheckpointDigest, fr.faultCheckpointDigest);
  assert.ok(fr.faultSampleCount >= 2);
  assert.ok(fr.faultSimulatedSeconds > 0);
  assert.ok(fr.restoredSampleCount >= 2);
  assert.equal(fr.transferredCount, 1);
}
assert.equal(
  faultRestoreReport.faultCascades.length,
  5,
  `Expected 5 multi-batch fault-cascade records, got ${faultRestoreReport.faultCascades.length}`,
);
const cascadedCellsSeen = new Set();
for (const fc of faultRestoreReport.faultCascades) {
  assert.ok(fc.recoveryDelaySeconds > 0);
  assert.ok(
    fc.affectedBatches.length >= 2,
    `Expected fault cascade on ${fc.faultTaskId} to span at least 2 batches, got ${fc.affectedBatches.length}`,
  );
  assert.ok(
    fc.affectedCells.length >= 1,
    `Expected fault cascade on ${fc.faultTaskId} to reach linked cobot cells`,
  );
  assert.ok(fc.shiftedTaskCount > 0);
  assert.ok(fc.linkedCellTransfers.length > 0);
  for (const cell of fc.affectedCells) {
    cascadedCellsSeen.add(cell);
  }
  for (const transfer of fc.linkedCellTransfers) {
    assert.ok(transfer.cascadedStartSeconds > transfer.baselineStartSeconds);
    assert.equal(transfer.status, "recovered");
    assert.equal(
      transfer.releasedByCheckpointDigest,
      fc.restoredCheckpointDigest,
    );
  }
}
for (const expectedCell of [
  "tea-pan-cell",
  "espresso-cell",
  "pour-over-cell",
]) {
  assert.ok(
    cascadedCellsSeen.has(expectedCell),
    `Expected multi-batch fault cascades to cover linked cobot cell ${expectedCell}`,
  );
}
writeFileSync(
  join(output, "morning-shift-fault-restore.json"),
  `${canonicalJson({
    ...faultRestoreSummary,
    faultRestores: faultRestoreReport.faultRestores,
    faultCascades: faultRestoreReport.faultCascades,
  })}\n`,
);
console.log(
  `Plan 61E Fault & Checkpoint-Restore: ${faultRestoreReport.faultRestores.length} mid-cycle appliance faults injected, ${faultRestoreReport.faultCascades.length} multi-batch cascades recovered across ${[...cascadedCellsSeen].join(", ")} (${faultRestoreSummary.taskCount} shift tasks).`,
);

const overallReport = {
  passed: true,
  executionBundleId: manifest.bundle.id,
  runtimeBundleId: manifest.runtime.id,
  plans: {
    "61A": {
      taskCount: financierSummary.taskCount,
      applianceCount: financierSummary.applianceCount,
      appliances: financierSummary.appliances,
      categories: financierSummary.categories,
      finalCheckpointDigests: financierSummary.finalCheckpointDigests,
    },
    "61B": {
      taskCount: sesameSummary.taskCount,
      applianceCount: sesameSummary.applianceCount,
      appliances: sesameSummary.appliances,
      categories: sesameSummary.categories,
      finalCheckpointDigests: sesameSummary.finalCheckpointDigests,
    },
    "61C": {
      taskCount: blackTeaSummary.taskCount,
      applianceCount: blackTeaSummary.applianceCount,
      appliances: blackTeaSummary.appliances,
      categories: blackTeaSummary.categories,
      finalCheckpointDigests: blackTeaSummary.finalCheckpointDigests,
    },
    "61D": {
      taskCount: milkTeaSummary.taskCount,
      applianceCount: milkTeaSummary.applianceCount,
      appliances: milkTeaSummary.appliances,
      categories: milkTeaSummary.categories,
      finalCheckpointDigests: milkTeaSummary.finalCheckpointDigests,
    },
    "61E": {
      taskCount: shiftSummary.taskCount,
      applianceCount: shiftSummary.applianceCount,
      appliances: shiftSummary.appliances,
      categories: shiftSummary.categories,
      facilityUtilities: shiftSummary.facilityUtilities,
      carrierReturnSummary: shiftSummary.carrierReturnSummary,
      finalCheckpointDigests: shiftSummary.finalCheckpointDigests,
      faultRestoreJourney: {
        faultCount: faultRestoreReport.faultRestores.length,
        faultRestores: faultRestoreReport.faultRestores.map((fr) => ({
          taskId: fr.taskId,
          appliance: fr.appliance,
          faultKind: fr.faultKind,
          faultMessage: fr.faultMessage,
          faultCheckpointDigest: fr.faultCheckpointDigest,
          resumedFromFaultCheckpointDigest: fr.resumedFromFaultCheckpointDigest,
          restoredCheckpointDigest: fr.restoredCheckpointDigest,
          transferredCount: fr.transferredCount,
        })),
        faultCascades: faultRestoreReport.faultCascades.map((fc) => ({
          faultTaskId: fc.faultTaskId,
          appliance: fc.appliance,
          faultKind: fc.faultKind,
          recoveryDelaySeconds: fc.recoveryDelaySeconds,
          affectedBatches: fc.affectedBatches,
          affectedCells: fc.affectedCells,
          shiftedTaskCount: fc.shiftedTaskCount,
          linkedCellTransferCount: fc.linkedCellTransfers.length,
          restoredCheckpointDigest: fc.restoredCheckpointDigest,
        })),
        finalCheckpointDigests: faultRestoreSummary.finalCheckpointDigests,
      },
    },
  },
};

writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(overallReport, null, 2)}\n`,
);
console.log(JSON.stringify(overallReport, null, 2));
