import { isRecord } from "@purin-labs/std";
import type {
  ApplianceAction,
  ApplianceBatch,
  ApplianceResult,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";

export type PastryBenchDeformationTelemetry = Readonly<{
  taskMode: "press-dough-block" | "sheet-shortcrust" | "drape-puff-lid";
  benchFloured: boolean;
  targetThicknessMm: number;
  sheetThicknessMm: number;
  sheetSpanMm: number;
  cavityDrapeMm: number;
  rimCrimpForceN: number;
  sealCoveragePct: number;
  doughBlockHeightMm: number;
  doughBlockSpanMm: number;
  doughBlockVertexCount: number;
  doughBlockTriangleCount: number;
  rollerWorkJoules: number;
  benchTempC: number;
  vertexCount: number;
  triangleCount: number;
}>;

export type PastryBenchSummary = Readonly<{
  totalPastryCycles: number;
  doughBlockPressCycles: number;
  shortcrustSheetCycles: number;
  puffLidDrapeCycles: number;
  minDoughBlockHeightMm: number;
  meanSheetThicknessMm: number;
  peakCavityDrapeMm: number;
  meanSealCoveragePct: number;
  totalRollerWorkJoules: number;
  minBenchTempC: number;
  maxBenchTempC: number;
}>;

export function pastryPressDoughActions(
  batch: ApplianceBatch,
  targetHeightMm = 21.0,
  durationSeconds = 2.2,
): readonly ApplianceAction[] {
  const clampedHeight = Math.max(
    16.0,
    Math.min(28.0, Number(targetHeightMm.toFixed(2))),
  );
  const clampedDuration = Math.max(
    1.0,
    Math.min(12.0, Number(durationSeconds.toFixed(2))),
  );
  return [
    { kind: "bench-flour", dusted: true },
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    {
      kind: "start",
      program: {
        kind: "press-dough-block",
        target_height_mm: clampedHeight,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: Number((clampedDuration + 0.2).toFixed(2)) },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function pastrySheetActions(
  batch: ApplianceBatch,
  targetThicknessMm = 3.0,
  durationSeconds = 2.4,
): readonly ApplianceAction[] {
  const clampedThickness = Math.max(
    1.8,
    Math.min(6.0, Number(targetThicknessMm.toFixed(2))),
  );
  const clampedDuration = Math.max(
    1.2,
    Math.min(12.0, Number(durationSeconds.toFixed(2))),
  );
  return [
    { kind: "bench-flour", dusted: true },
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    {
      kind: "start",
      program: {
        kind: "sheet-shortcrust",
        target_thickness_mm: clampedThickness,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: Number((clampedDuration + 0.2).toFixed(2)) },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function pastryDrapeActions(
  batch: ApplianceBatch,
  crimpForceN = 42.0,
  durationSeconds = 2.4,
): readonly ApplianceAction[] {
  const clampedForce = Math.max(
    18.0,
    Math.min(95.0, Number(crimpForceN.toFixed(1))),
  );
  const clampedDuration = Math.max(
    1.2,
    Math.min(12.0, Number(durationSeconds.toFixed(2))),
  );
  return [
    { kind: "bench-flour", dusted: true },
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    {
      kind: "start",
      program: {
        kind: "drape-puff-lid",
        crimp_force_n: clampedForce,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: Number((clampedDuration + 0.2).toFixed(2)) },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function computePastryBenchDeformationTelemetry(
  taskKey: string,
  result: ApplianceResult,
): PastryBenchDeformationTelemetry {
  const taskMode: PastryBenchDeformationTelemetry["taskMode"] =
    taskKey.startsWith("wrap") || taskKey.startsWith("press")
      ? "press-dough-block"
      : taskKey.startsWith("lid-pies")
        ? "drape-puff-lid"
        : "sheet-shortcrust";
  const lastSample = result.samples.at(-1);
  let rawController: unknown = null;
  if (lastSample !== undefined) {
    try {
      rawController = JSON.parse(lastSample.telemetryText);
    } catch {
      rawController = null;
    }
  }
  const pastry =
    isRecord(rawController) && isRecord(rawController.pastry)
      ? rawController.pastry
      : null;
  const sheetMesh =
    lastSample?.flexMeshes.find((m) => m.name === "pastry_sheet") ??
    lastSample?.flexMeshes[0];
  const blockMesh = lastSample?.flexMeshes.find(
    (m) => m.name === "dough_block",
  );
  const num = (value: unknown, fallback: number, digits = 2): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Number(value.toFixed(digits))
      : fallback;

  return {
    taskMode,
    benchFloured:
      typeof pastry?.bench_floured === "boolean" ? pastry.bench_floured : true,
    targetThicknessMm: num(pastry?.target_thickness_mm, 3.0, 2),
    sheetThicknessMm: num(pastry?.sheet_thickness_mm, 3.0, 2),
    sheetSpanMm: num(pastry?.sheet_span_mm, 148.0, 1),
    cavityDrapeMm: num(pastry?.cavity_drape_mm, 0.0, 2),
    rimCrimpForceN: num(pastry?.rim_crimp_force_n, 9.4, 2),
    sealCoveragePct: num(pastry?.seal_coverage_pct, 0.0, 1),
    doughBlockHeightMm: num(pastry?.dough_block_height_mm, 31.6, 2),
    doughBlockSpanMm: num(pastry?.dough_block_span_mm, 73.6, 2),
    doughBlockVertexCount: blockMesh?.vertexCount ?? 0,
    doughBlockTriangleCount:
      blockMesh !== undefined ? blockMesh.faces.length / 3 : 0,
    rollerWorkJoules: num(pastry?.roller_work_j, 2.5, 2),
    benchTempC: num(pastry?.bench_c, 16.5, 2),
    vertexCount: sheetMesh?.vertexCount ?? 0,
    triangleCount: sheetMesh !== undefined ? sheetMesh.faces.length / 3 : 0,
  };
}

export function evaluatePastryBenchInspectionGate(
  telemetry: PastryBenchDeformationTelemetry,
  exitTemperatureC: number,
): Readonly<{
  recommendedOutcome: "accept" | "reject";
  gateKind: "pastry-drape-gate";
  targetSpecRange: string;
  measuredValue: number;
  unit: string;
  rationale: string;
}> {
  if (telemetry.taskMode === "press-dough-block") {
    const withinSpec =
      telemetry.doughBlockHeightMm <= 24.5 &&
      telemetry.doughBlockSpanMm >= 78.0 &&
      exitTemperatureC <= 21.0;
    return {
      recommendedOutcome: withinSpec ? "accept" : "reject",
      gateKind: "pastry-drape-gate",
      targetSpecRange: "18.0..24.5 mm slab",
      measuredValue: telemetry.doughBlockHeightMm,
      unit: "mm",
      rationale: withinSpec
        ? `3D shortcrust block pressed to ${telemetry.doughBlockHeightMm.toFixed(1)} mm (${telemetry.doughBlockSpanMm.toFixed(1)} mm span) at ${exitTemperatureC.toFixed(1)} °C`
        : `3D dough block height ${telemetry.doughBlockHeightMm.toFixed(1)} mm outside resting slab spec`,
    };
  }
  const withinSpec =
    telemetry.cavityDrapeMm >= 14.0 &&
    telemetry.sealCoveragePct >= 75.0 &&
    exitTemperatureC <= 21.0;
  return {
    recommendedOutcome: withinSpec ? "accept" : "reject",
    gateKind: "pastry-drape-gate",
    targetSpecRange: "14.0..28.0 mm drape",
    measuredValue: telemetry.cavityDrapeMm,
    unit: "mm",
    rationale: withinSpec
      ? `Pastry sheet draped ${telemetry.cavityDrapeMm.toFixed(1)} mm into 12 cm fluted tin with ${telemetry.sealCoveragePct.toFixed(0)}% rim seal at ${exitTemperatureC.toFixed(1)} °C`
      : `Pastry drape ${telemetry.cavityDrapeMm.toFixed(1)} mm or seal ${telemetry.sealCoveragePct.toFixed(0)}% outside tin-lining spec`,
  };
}

export function computePastryBenchSummary(
  telemetries: readonly (PastryBenchDeformationTelemetry | null)[],
): PastryBenchSummary {
  let totalPastryCycles = 0;
  let doughBlockPressCycles = 0;
  let shortcrustSheetCycles = 0;
  let puffLidDrapeCycles = 0;
  let minDoughBlockHeightMm = 80;
  let thicknessSum = 0;
  let sheetOrDrapeCycles = 0;
  let peakCavityDrapeMm = 0;
  let sealSum = 0;
  let maxCumulativeWorkJ = 0;
  let minBenchTempC = 60;
  let maxBenchTempC = -10;

  for (const item of telemetries) {
    if (item === null) continue;
    totalPastryCycles += 1;
    if (item.doughBlockHeightMm < minDoughBlockHeightMm) {
      minDoughBlockHeightMm = item.doughBlockHeightMm;
    }
    if (item.taskMode === "press-dough-block") {
      doughBlockPressCycles += 1;
    } else {
      sheetOrDrapeCycles += 1;
      if (item.taskMode === "sheet-shortcrust") {
        shortcrustSheetCycles += 1;
      } else {
        puffLidDrapeCycles += 1;
      }
      thicknessSum += item.sheetThicknessMm;
      if (item.cavityDrapeMm > peakCavityDrapeMm) {
        peakCavityDrapeMm = item.cavityDrapeMm;
      }
      sealSum += item.sealCoveragePct;
    }
    if (item.rollerWorkJoules > maxCumulativeWorkJ) {
      maxCumulativeWorkJ = item.rollerWorkJoules;
    }
    if (item.benchTempC < minBenchTempC) minBenchTempC = item.benchTempC;
    if (item.benchTempC > maxBenchTempC) maxBenchTempC = item.benchTempC;
  }

  if (totalPastryCycles === 0) {
    return {
      totalPastryCycles: 0,
      doughBlockPressCycles: 0,
      shortcrustSheetCycles: 0,
      puffLidDrapeCycles: 0,
      minDoughBlockHeightMm: 31.6,
      meanSheetThicknessMm: 0,
      peakCavityDrapeMm: 0,
      meanSealCoveragePct: 0,
      totalRollerWorkJoules: 0,
      minBenchTempC: 16.5,
      maxBenchTempC: 16.5,
    };
  }

  const sheetDenom = Math.max(1, sheetOrDrapeCycles);
  return {
    totalPastryCycles,
    doughBlockPressCycles,
    shortcrustSheetCycles,
    puffLidDrapeCycles,
    minDoughBlockHeightMm: Number(minDoughBlockHeightMm.toFixed(2)),
    meanSheetThicknessMm: Number((thicknessSum / sheetDenom).toFixed(2)),
    peakCavityDrapeMm: Number(peakCavityDrapeMm.toFixed(2)),
    meanSealCoveragePct: Number((sealSum / sheetDenom).toFixed(1)),
    totalRollerWorkJoules: Number(maxCumulativeWorkJ.toFixed(2)),
    minBenchTempC: Number(minBenchTempC.toFixed(2)),
    maxBenchTempC: Number(maxBenchTempC.toFixed(2)),
  };
}

export function buildPastryUnflouredFaultActions(
  batch: ApplianceBatch,
  targetThicknessMm = 3.0,
): readonly ApplianceAction[] {
  const clampedThickness = Math.max(
    1.8,
    Math.min(6.0, Number(targetThicknessMm.toFixed(2))),
  );
  return [
    { kind: "bench-flour", dusted: false },
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 0.4 },
    {
      kind: "start",
      program: {
        kind: "sheet-shortcrust",
        target_thickness_mm: clampedThickness,
        duration_s: 2.4,
      },
    },
  ];
}

export function buildPastryUnflouredRestoreActions(
  targetThicknessMm = 3.0,
): readonly ApplianceAction[] {
  const clampedThickness = Math.max(
    1.8,
    Math.min(6.0, Number(targetThicknessMm.toFixed(2))),
  );
  return [
    { kind: "bench-flour", dusted: true },
    { kind: "advance", seconds: 0.4 },
    {
      kind: "start",
      program: {
        kind: "sheet-shortcrust",
        target_thickness_mm: clampedThickness,
        duration_s: 2.4,
      },
    },
    { kind: "advance", seconds: 2.6 },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}
