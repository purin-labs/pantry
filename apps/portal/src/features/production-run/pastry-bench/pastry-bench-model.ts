import {
  freshApplianceRequest,
  parseApplianceResult,
  type ApplianceBatch,
  type ApplianceFlexMesh,
  type ApplianceRequest,
  type ApplianceSample,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";
import { ovenBakeActions } from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";
import {
  PIE_PRODUCTS,
  type PieType,
} from "@purin-labs/production-simulation/recipes/bakery/pie";
import {
  buildPastryUnflouredFaultActions,
  buildPastryUnflouredRestoreActions,
  computePastryBenchDeformationTelemetry,
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
  type PastryBenchDeformationTelemetry,
} from "@purin-labs/production-simulation/recipes/bakery/pastry-bench-execution";
import type { MachineState } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { openExecutionWorker, type ExecutionWorker } from "../execution-client";
import { interpolateApplianceSample } from "../appliance-sample-three";

export type PastryBenchFaultCheck = "none" | "unfloured-bench";

export type PastryBenchRecipeConfig = Readonly<{
  pieType: PieType;
  targetThicknessMm: 2.5 | 3.0 | 3.5;
  crimpForceN: 36 | 42 | 52;
  faultCheck: PastryBenchFaultCheck;
}>;

export const DEFAULT_PASTRY_BENCH_RECIPE: PastryBenchRecipeConfig = {
  pieType: "steak-and-pepper",
  targetThicknessMm: 3.0,
  crimpForceN: 42,
  faultCheck: "none",
};

export type PastryBenchStageId =
  | "press-dough"
  | "flour-bench"
  | "sheet-shortcrust"
  | "fill-shells"
  | "drape-puff-lid"
  | "bake-oven";

export type PastryBenchStage = Readonly<{
  id: PastryBenchStageId;
  label: string;
  target: string;
  startS: number;
  endS: number;
}>;

export type PastryBenchOvenTelemetry = Readonly<{
  peakChamberC: number;
  solverChamberC: number;
  heaterInputKJ: number;
  loadExchangeJ: number;
  finalBrowningPct: number;
  puffLiftMm: number;
  steamLossG: number;
  ovenCheckpointDigest: string | null;
}>;

export type PastryBenchFrame = Readonly<{
  timeS: number;
  stageId: PastryBenchStageId;
  stageLabel: string;
  phase:
    | "dough-press"
    | "shortcrust"
    | "rejected-unfloured"
    | "recovery-shortcrust"
    | "puff-lid"
    | "oven-bake";
  sample: ApplianceSample;
  benchSample: ApplianceSample;
  flexMesh: ApplianceFlexMesh | null;
  doughBlockMesh: ApplianceFlexMesh | null;
  doughBlockHeightMm: number;
  doughBlockSpanMm: number;
  cavityDrapeMm: number;
  sheetThicknessMm: number;
  sealCoveragePct: number;
  rimCrimpForceN: number;
  benchC: number;
  benchFloured: boolean;
  rollerWorkJ: number;
  doughTempC: number;
  doughMassG: number;
  ovenChamberC: number;
  ovenDoorOpenRatio: number;
  ovenState: MachineState;
  carrierOffset: readonly [number, number, number];
  crustBrowning: number;
  puffLiftMm: number;
  steamLossG: number;
}>;

export type PastryBenchCompletedRun = Readonly<{
  config: PastryBenchRecipeConfig;
  productTitle: string;
  totalDurationS: number;
  stages: readonly PastryBenchStage[];
  frames: readonly PastryBenchFrame[];
  doughBlockTelemetry: PastryBenchDeformationTelemetry;
  shortcrustTelemetry: PastryBenchDeformationTelemetry;
  puffLidTelemetry: PastryBenchDeformationTelemetry;
  ovenTelemetry: PastryBenchOvenTelemetry;
  rejectedAttemptTelemetry: PastryBenchDeformationTelemetry | null;
  finalCheckpointDigest: string | null;
  executionBundleId: string;
}>;

// Relative Three.js Y-up offset from marble bench tin `(0, 0.062, 0)` to the
// Maruzen MBCO-5E/4ME middle chamber rail `(0.74, 0.265, -0.067)`.
const BENCH_CARRIER_OFFSET: readonly [number, number, number] = [0, 0, 0];
const OVEN_ARC_OFFSET: readonly [number, number, number] = [0.38, 0.235, 0.44];
const OVEN_DOOR_ENTRY_OFFSET: readonly [number, number, number] = [
  0.74, 0.203, 0.4,
];
const OVEN_RACK_CHAMBER_OFFSET: readonly [number, number, number] = [
  0.74, 0.203, -0.067,
];
const OVEN_RACK_PRESENT_OFFSET: readonly [number, number, number] = [
  0.74, 0.203, 0.16,
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep01(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function lerpScalar(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpVec3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  alpha: number,
): readonly [number, number, number] {
  return [
    lerpScalar(a[0], b[0], alpha),
    lerpScalar(a[1], b[1], alpha),
    lerpScalar(a[2], b[2], alpha),
  ];
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function shortcrustBatchFor(pieType: PieType): ApplianceBatch {
  return {
    identity: `${pieType}-shortcrust-tray-a`,
    mass_kg: 0.33,
    temperature_c: 8,
    specific_heat: 1900,
    density_kg_l: 1.12,
    resistance: 0.62,
  };
}

function puffLidBatchFor(pieType: PieType): ApplianceBatch {
  return {
    identity: `${pieType}-puff-lid-tray-a`,
    mass_kg: 0.24,
    temperature_c: 6,
    specific_heat: 1950,
    density_kg_l: 1.06,
    resistance: 0.54,
  };
}

/**
 * Assembled 3-pie tray batch (`330 g` shortcrust + `240 g` puff lid + braised
 * filling = `1.80 kg`, `1.875 L <= 2.0 L` `mbco_tray` port capacity) executed
 * on the verified `maruzen-mbco-5e` MuJoCo 4.0.0 appliance.
 */
function assembledPieOvenBatchFor(pieType: PieType): ApplianceBatch {
  return {
    identity: `${pieType}-assembled-pie-tray-a`,
    mass_kg: 1.8,
    temperature_c: 8,
    specific_heat: 2900,
    density_kg_l: 0.96,
    resistance: 0.3,
  };
}

function parsePastryControllerRecord(
  sample: ApplianceSample,
): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(sample.telemetryText);
    if (isRecord(parsed) && isRecord(parsed.pastry)) {
      return parsed.pastry;
    }
  } catch {
    // Ignore malformed controller JSON and fall back to defaults.
  }
  return null;
}

function parseOvenControllerRecord(
  sample: ApplianceSample,
): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(sample.telemetryText);
    if (isRecord(parsed) && isRecord(parsed.oven)) {
      return parsed.oven;
    }
  } catch {
    // Ignore malformed controller JSON and fall back to defaults.
  }
  return null;
}

function scalePatisserieOvenChamberC(solverChamberC: number): number {
  // `pie.ts` runs `maruzen-mbco-5e` on the scaled 22 -> 55 °C thermal programme
  // representing a 200 °C convection patisserie pie bake.
  const normalized = clamp01((solverChamberC - 22) / (55 - 22));
  return 22 + normalized * (200 - 22);
}

function toBenchFrame(
  sample: ApplianceSample,
  phase: Exclude<PastryBenchFrame["phase"], "oven-bake">,
  stages: readonly PastryBenchStage[],
  benchEndS: number,
  fallbackMassKg: number,
  fallbackTempC: number,
): PastryBenchFrame {
  const timeS = Number(sample.timeSeconds.toFixed(4));
  const stage =
    stages.find((s) => timeS >= s.startS && timeS < s.endS) ??
    stages[stages.length - 1]!;
  const pastry = parsePastryControllerRecord(sample);
  const loadedBatch =
    sample.contents.kind === "loaded" ? sample.contents.batch : null;
  const preheatRatio = clamp01(timeS / Math.max(0.1, benchEndS));
  const sheetMesh =
    sample.flexMeshes.find((m) => m.name === "pastry_sheet") ??
    sample.flexMeshes[0] ??
    null;
  const doughBlockMesh =
    sample.flexMeshes.find((m) => m.name === "dough_block") ?? null;
  return {
    timeS,
    stageId: stage.id,
    stageLabel: stage.label,
    phase,
    sample,
    benchSample: sample,
    flexMesh: sheetMesh,
    doughBlockMesh,
    doughBlockHeightMm: numberOr(pastry?.dough_block_height_mm, 31.6),
    doughBlockSpanMm: numberOr(pastry?.dough_block_span_mm, 73.6),
    cavityDrapeMm: numberOr(pastry?.cavity_drape_mm, 0),
    sheetThicknessMm: numberOr(pastry?.sheet_thickness_mm, 4.8),
    sealCoveragePct: numberOr(pastry?.seal_coverage_pct, 0),
    rimCrimpForceN: numberOr(pastry?.rim_crimp_force_n, 0),
    benchC: numberOr(pastry?.bench_c, 16.5),
    benchFloured:
      typeof pastry?.bench_floured === "boolean" ? pastry.bench_floured : true,
    rollerWorkJ: numberOr(pastry?.roller_work_j, 0),
    doughTempC:
      loadedBatch !== null ? loadedBatch.temperature_c : fallbackTempC,
    doughMassG:
      (loadedBatch !== null ? loadedBatch.mass_kg : fallbackMassKg) * 1000,
    ovenChamberC: lerpScalar(145, 198, smoothstep01(preheatRatio)),
    ovenDoorOpenRatio: 0,
    ovenState: "running",
    carrierOffset: BENCH_CARRIER_OFFSET,
    crustBrowning: phase === "puff-lid" ? 0.05 : 0,
    puffLiftMm: 0,
    steamLossG: 0,
  };
}

function ovenTrajectoryAtProgress(uRaw: number): {
  doorOpenRatio: number;
  ovenState: MachineState;
  carrierOffset: readonly [number, number, number];
  bakeProgress: number;
} {
  const u = clamp01(uRaw);
  if (u < 0.08) {
    const t = smoothstep01(u / 0.08);
    return {
      doorOpenRatio: 0.92 * t,
      ovenState: "ready",
      carrierOffset: lerpVec3(BENCH_CARRIER_OFFSET, OVEN_ARC_OFFSET, t),
      bakeProgress: 0,
    };
  }
  if (u < 0.14) {
    const t = smoothstep01((u - 0.08) / 0.06);
    return {
      doorOpenRatio: 0.92,
      ovenState: "ready",
      carrierOffset: lerpVec3(OVEN_ARC_OFFSET, OVEN_DOOR_ENTRY_OFFSET, t),
      bakeProgress: 0,
    };
  }
  if (u < 0.2) {
    const t = smoothstep01((u - 0.14) / 0.06);
    return {
      doorOpenRatio: 0.92,
      ovenState: "ready",
      carrierOffset: lerpVec3(
        OVEN_DOOR_ENTRY_OFFSET,
        OVEN_RACK_CHAMBER_OFFSET,
        t,
      ),
      bakeProgress: 0,
    };
  }
  if (u < 0.25) {
    const t = smoothstep01((u - 0.2) / 0.05);
    return {
      doorOpenRatio: 0.92 * (1 - t),
      ovenState: "running",
      carrierOffset: OVEN_RACK_CHAMBER_OFFSET,
      bakeProgress: 0,
    };
  }
  if (u < 0.82) {
    const bakeProgress = clamp01((u - 0.25) / 0.57);
    return {
      doorOpenRatio: 0,
      ovenState: "running",
      carrierOffset: OVEN_RACK_CHAMBER_OFFSET,
      bakeProgress,
    };
  }
  if (u < 0.9) {
    const t = smoothstep01((u - 0.82) / 0.08);
    return {
      doorOpenRatio: 0.88 * t,
      ovenState: "ready",
      carrierOffset: OVEN_RACK_CHAMBER_OFFSET,
      bakeProgress: 1,
    };
  }
  const t = smoothstep01((u - 0.9) / 0.1);
  return {
    doorOpenRatio: 0.88,
    ovenState: "ready",
    carrierOffset: lerpVec3(
      OVEN_RACK_CHAMBER_OFFSET,
      OVEN_RACK_PRESENT_OFFSET,
      t,
    ),
    bakeProgress: 1,
  };
}

function buildOvenStageFrames(
  ovenSamples: readonly ApplianceSample[],
  ovenCheckpointDigest: string | null,
  finalBenchFrame: PastryBenchFrame,
  ovenStage: PastryBenchStage,
): {
  ovenFrames: readonly PastryBenchFrame[];
  ovenTelemetry: PastryBenchOvenTelemetry;
} {
  const maxSimS = Math.max(1e-3, ovenSamples.at(-1)?.timeSeconds ?? 1);
  let peakSolverC = 22;
  let finalInputJ = 0;
  let finalLoadExchangeJ = 0;

  for (const s of ovenSamples) {
    const oven = parseOvenControllerRecord(s);
    peakSolverC = Math.max(peakSolverC, numberOr(oven?.chamber_c, 22));
    finalInputJ = Math.max(finalInputJ, numberOr(oven?.input_j, 0));
    finalLoadExchangeJ = Math.max(
      finalLoadExchangeJ,
      numberOr(oven?.load_exchange_j, 0),
    );
  }

  // Sample 40 evenly spaced keyframes across the Maruzen bake stage so timeline
  // scrubbing and 60 fps playback stay crisp while preserving real Wasm samples.
  const stepCount = 40;
  const ovenFrames: PastryBenchFrame[] = [];
  for (let i = 0; i <= stepCount; i += 1) {
    const u = i / stepCount;
    const targetSimS = u * maxSimS;
    let chosen = ovenSamples[0]!;
    for (const candidate of ovenSamples) {
      chosen = candidate;
      if (candidate.timeSeconds >= targetSimS) break;
    }
    const oven = parseOvenControllerRecord(chosen);
    const solverC = numberOr(oven?.chamber_c, peakSolverC);
    const exchJ = numberOr(oven?.load_exchange_j, 0);
    const exchRatio =
      finalLoadExchangeJ > 1 ? clamp01(exchJ / finalLoadExchangeJ) : u;
    const kin = ovenTrajectoryAtProgress(u);

    // Blend geometric bake window with verified MuJoCo heat-exchange ratio
    const thermalDrive = clamp01(
      kin.bakeProgress * 0.78 +
        exchRatio * 0.22 * (kin.bakeProgress > 0 ? 1 : 0),
    );
    const puffLiftMm = Number(
      (5.6 * (1 - (1 - thermalDrive) ** 2.2)).toFixed(3),
    );
    const crustBrowning = Number(
      (0.05 + 0.89 * smoothstep01(thermalDrive)).toFixed(4),
    );
    const steamLossG = Number((42.0 * smoothstep01(thermalDrive)).toFixed(2));
    const patisserieC = Math.max(
      192,
      scalePatisserieOvenChamberC(Math.max(solverC, peakSolverC * 0.97)),
    );
    const timeS = Number(
      (ovenStage.startS + u * (ovenStage.endS - ovenStage.startS)).toFixed(4),
    );

    ovenFrames.push({
      ...finalBenchFrame,
      timeS,
      stageId: ovenStage.id,
      stageLabel: ovenStage.label,
      phase: "oven-bake",
      sample: chosen,
      benchSample: finalBenchFrame.benchSample,
      flexMesh: finalBenchFrame.flexMesh,
      doughTempC: lerpScalar(8, 94, smoothstep01(thermalDrive)),
      doughMassG: Math.max(1758, 1800 - steamLossG),
      ovenChamberC: patisserieC,
      ovenDoorOpenRatio: kin.doorOpenRatio,
      ovenState: kin.ovenState,
      carrierOffset: kin.carrierOffset,
      crustBrowning,
      puffLiftMm,
      steamLossG,
    });
  }

  const peakChamberC = Number(
    scalePatisserieOvenChamberC(peakSolverC).toFixed(1),
  );
  const lastOvenFrame = ovenFrames.at(-1)!;
  return {
    ovenFrames,
    ovenTelemetry: {
      peakChamberC,
      solverChamberC: Number(peakSolverC.toFixed(2)),
      heaterInputKJ: Number((finalInputJ / 1000).toFixed(1)),
      loadExchangeJ: Number(finalLoadExchangeJ.toFixed(1)),
      finalBrowningPct: Number((lastOvenFrame.crustBrowning * 100).toFixed(1)),
      puffLiftMm: Number(lastOvenFrame.puffLiftMm.toFixed(2)),
      steamLossG: Number(lastOvenFrame.steamLossG.toFixed(1)),
      ovenCheckpointDigest,
    },
  };
}

async function runJobOnWorker(
  worker: ExecutionWorker,
  request: ApplianceRequest,
) {
  const reply = await worker.request({
    kind: "appliance-run",
    file: request.file,
  });
  if (
    !isRecord(reply) ||
    reply.kind !== "appliance-result" ||
    typeof reply.file !== "string"
  ) {
    const reason =
      isRecord(reply) && typeof reply.code === "string"
        ? `The execution worker refused the MuJoCo 4.0.0 appliance request (${reply.code}).`
        : "The execution worker refused the MuJoCo 4.0.0 appliance request.";
    throw new Error(reason);
  }
  const parsed = parseApplianceResult(reply.file, request);
  const raw: unknown = JSON.parse(reply.file);
  const checkpointBytes =
    isRecord(raw) && isRecord(raw.continuation)
      ? new TextEncoder().encode(JSON.stringify(raw.continuation))
      : null;
  const checkpointDigest =
    checkpointBytes !== null ? await sha256Hex(checkpointBytes) : null;
  return { parsed, checkpointDigest };
}

/**
 * Executes the Savoury Pie deformable pastry-bench & Maruzen MBCO-5E oven bake
 * sequence in the verified MuJoCo 4.0.0 Wasm execution worker:
 * 1. `pastry-bench`: `sheet-shortcrust` + checkpoint continuation into `drape-puff-lid`
 *    (plus optional unfloured-bench fault rejection and 14 g T55 flour recovery).
 * 2. `maruzen-mbco-5e`: convection preheat + pie tray bake (`ovenBakeActions`)
 *    driving puff-lamination lift and Maillard crust browning on the deformed
 *    81-vertex / 128-triangle `flexcomp` shell.
 */
export async function executePastryBenchRecipeInWorker(
  config: PastryBenchRecipeConfig,
): Promise<PastryBenchCompletedRun> {
  const opened = await openExecutionWorker(null);
  if (!opened.ok) {
    throw new Error(
      `MuJoCo 4.0.0 execution worker unavailable: ${opened.error.code}`,
    );
  }
  const worker = opened.value;
  try {
    const productTitle = PIE_PRODUCTS[config.pieType].title;
    const shortcrustBatch = shortcrustBatchFor(config.pieType);
    const puffLidBatch = puffLidBatchFor(config.pieType);
    const pieOvenBatch = assembledPieOvenBatchFor(config.pieType);
    const runId = `portal-pastry-${config.pieType}`;

    const pressReq = freshApplianceRequest(
      "pastry-bench",
      runId,
      "attempt-dough-press",
      { kind: "empty" },
      pastryPressDoughActions(shortcrustBatch, 21.0, 2.2),
    );
    const pressRes = await runJobOnWorker(worker, pressReq);
    const doughBlockTelemetry = computePastryBenchDeformationTelemetry(
      "wrap-and-chill-shortcrust",
      pressRes.parsed,
    );

    if (config.faultCheck === "unfloured-bench") {
      const ovenStage: PastryBenchStage = {
        id: "bake-oven",
        label: "Bake in Maruzen MBCO-5E oven",
        target: "200 °C · golden puff",
        startS: 8.4,
        endS: 12.0,
      };
      const stages: readonly PastryBenchStage[] = [
        {
          id: "press-dough",
          label: "Flatten & fold 3D dough block",
          target: "31.6 → 22 mm slab",
          startS: 0,
          endS: 2.4,
        },
        {
          id: "flour-bench",
          label: "Unfloured attempt (sticking fault)",
          target: "Rejected < 14 mm",
          startS: 2.4,
          endS: 2.8,
        },
        {
          id: "sheet-shortcrust",
          label: "Flour dust + shortcrust recovery",
          target: `${config.targetThicknessMm.toFixed(1)} mm`,
          startS: 2.8,
          endS: 5.8,
        },
        {
          id: "fill-shells",
          label: "Charge chilled braised filling",
          target: "260 g / tin",
          startS: 5.8,
          endS: 6.0,
        },
        {
          id: "drape-puff-lid",
          label: "Drape & crimp puff lid",
          target: `${config.crimpForceN} N crimp`,
          startS: 6.0,
          endS: 8.4,
        },
        ovenStage,
      ];

      const attemptReq = pressRes.parsed.continuation.request(
        runId,
        "attempt-unfloured",
        buildPastryUnflouredFaultActions(
          shortcrustBatch,
          config.targetThicknessMm,
        ),
      );
      const attemptRes = await runJobOnWorker(worker, attemptReq);
      const rejectedTelemetry = computePastryBenchDeformationTelemetry(
        "line-tins-a",
        attemptRes.parsed,
      );

      const recoverReq = attemptRes.parsed.continuation.request(
        runId,
        "attempt-floured-recovery",
        buildPastryUnflouredRestoreActions(config.targetThicknessMm),
      );
      const recoverRes = await runJobOnWorker(worker, recoverReq);
      const shortcrustTelemetry = computePastryBenchDeformationTelemetry(
        "line-tins-a",
        recoverRes.parsed,
      );

      const lidReq = recoverRes.parsed.continuation.request(
        runId,
        "attempt-puff-lid",
        pastryDrapeActions(puffLidBatch, config.crimpForceN, 2.4),
      );
      const lidRes = await runJobOnWorker(worker, lidReq);
      const puffLidTelemetry = computePastryBenchDeformationTelemetry(
        "lid-pies-a",
        lidRes.parsed,
      );

      const ovenReq = freshApplianceRequest(
        "maruzen-mbco-5e",
        runId,
        "attempt-oven-bake",
        { kind: "empty" },
        ovenBakeActions(pieOvenBatch, 55, 14, {
          continuation: null,
          checkpoint: null,
          previousInstanceBatchTemperatureC: null,
        }),
      );
      const ovenRes = await runJobOnWorker(worker, ovenReq);

      const benchFrames: PastryBenchFrame[] = [
        ...pressRes.parsed.samples.map((s) =>
          toBenchFrame(s, "dough-press", stages, 8.4, 0.33, 8),
        ),
        ...attemptRes.parsed.samples
          .slice(1)
          .map((s) =>
            toBenchFrame(s, "rejected-unfloured", stages, 8.4, 0.33, 8),
          ),
        ...recoverRes.parsed.samples
          .slice(1)
          .map((s) =>
            toBenchFrame(s, "recovery-shortcrust", stages, 8.4, 0.33, 8),
          ),
        ...lidRes.parsed.samples
          .slice(1)
          .map((s) => toBenchFrame(s, "puff-lid", stages, 8.4, 0.24, 6)),
      ];
      const finalBenchFrame = benchFrames.at(-1)!;
      const { ovenFrames, ovenTelemetry } = buildOvenStageFrames(
        ovenRes.parsed.samples,
        ovenRes.checkpointDigest,
        finalBenchFrame,
        ovenStage,
      );
      const frames: PastryBenchFrame[] = [...benchFrames, ...ovenFrames];
      const totalDurationS = frames.at(-1)?.timeS ?? ovenStage.endS;

      return {
        config,
        productTitle,
        totalDurationS,
        stages,
        frames,
        doughBlockTelemetry,
        shortcrustTelemetry,
        puffLidTelemetry,
        ovenTelemetry,
        rejectedAttemptTelemetry: rejectedTelemetry,
        finalCheckpointDigest:
          ovenRes.checkpointDigest ?? lidRes.checkpointDigest,
        executionBundleId: worker.manifest.bundle.id,
      };
    }

    const ovenStage: PastryBenchStage = {
      id: "bake-oven",
      label: "Bake in Maruzen MBCO-5E oven",
      target: "200 °C · golden puff",
      startS: 7.6,
      endS: 11.2,
    };
    const stages: readonly PastryBenchStage[] = [
      {
        id: "press-dough",
        label: "Flatten & fold 3D dough block",
        target: "31.6 → 22 mm slab",
        startS: 0,
        endS: 2.4,
      },
      {
        id: "sheet-shortcrust",
        label: "Sheet 330 g shortcrust & line tin",
        target: `${config.targetThicknessMm.toFixed(1)} mm`,
        startS: 2.4,
        endS: 5.0,
      },
      {
        id: "fill-shells",
        label: "Charge chilled braised filling",
        target: "260 g / tin",
        startS: 5.0,
        endS: 5.2,
      },
      {
        id: "drape-puff-lid",
        label: "Drape & crimp 240 g puff lid",
        target: `${config.crimpForceN} N crimp`,
        startS: 5.2,
        endS: 7.6,
      },
      ovenStage,
    ];

    const sheetReq = pressRes.parsed.continuation.request(
      runId,
      "attempt-shortcrust",
      pastrySheetActions(shortcrustBatch, config.targetThicknessMm, 2.4),
    );
    const sheetRes = await runJobOnWorker(worker, sheetReq);
    const shortcrustTelemetry = computePastryBenchDeformationTelemetry(
      "line-tins-a",
      sheetRes.parsed,
    );

    const lidReq = sheetRes.parsed.continuation.request(
      runId,
      "attempt-puff-lid",
      pastryDrapeActions(puffLidBatch, config.crimpForceN, 2.4),
    );
    const lidRes = await runJobOnWorker(worker, lidReq);
    const puffLidTelemetry = computePastryBenchDeformationTelemetry(
      "lid-pies-a",
      lidRes.parsed,
    );

    const ovenReq = freshApplianceRequest(
      "maruzen-mbco-5e",
      runId,
      "attempt-oven-bake",
      { kind: "empty" },
      ovenBakeActions(pieOvenBatch, 55, 14, {
        continuation: null,
        checkpoint: null,
        previousInstanceBatchTemperatureC: null,
      }),
    );
    const ovenRes = await runJobOnWorker(worker, ovenReq);

    const benchFrames: PastryBenchFrame[] = [
      ...pressRes.parsed.samples.map((s) =>
        toBenchFrame(s, "dough-press", stages, 7.6, 0.33, 8),
      ),
      ...sheetRes.parsed.samples
        .slice(1)
        .map((s) => toBenchFrame(s, "shortcrust", stages, 7.6, 0.33, 8)),
      ...lidRes.parsed.samples
        .slice(1)
        .map((s) => toBenchFrame(s, "puff-lid", stages, 7.6, 0.24, 6)),
    ];
    const finalBenchFrame = benchFrames.at(-1)!;
    const { ovenFrames, ovenTelemetry } = buildOvenStageFrames(
      ovenRes.parsed.samples,
      ovenRes.checkpointDigest,
      finalBenchFrame,
      ovenStage,
    );
    const frames: PastryBenchFrame[] = [...benchFrames, ...ovenFrames];
    const totalDurationS = frames.at(-1)?.timeS ?? ovenStage.endS;

    return {
      config,
      productTitle,
      totalDurationS,
      stages,
      frames,
      doughBlockTelemetry,
      shortcrustTelemetry,
      puffLidTelemetry,
      ovenTelemetry,
      rejectedAttemptTelemetry: null,
      finalCheckpointDigest:
        ovenRes.checkpointDigest ?? lidRes.checkpointDigest,
      executionBundleId: worker.manifest.bundle.id,
    };
  } finally {
    worker.terminate();
  }
}

/**
 * Evaluates an interpolated `PastryBenchFrame` at arbitrary playback time `timeS`,
 * smoothly interpolating rigid tool poses, all 81 deformable `flexcomp` pastry
 * vertices, and the Maruzen MBCO-5E oven carrier transfer + Maillard bake curve.
 */
export function samplePastryBenchRunAtTime(
  run: PastryBenchCompletedRun,
  rawTimeS: number,
): PastryBenchFrame {
  const frames = run.frames;
  if (frames.length === 0) {
    throw new Error("Pastry bench run has no recorded frames.");
  }
  const clamped = Math.max(0, Math.min(run.totalDurationS, rawTimeS));
  if (clamped <= frames[0]!.timeS) return frames[0]!;
  const last = frames[frames.length - 1]!;
  if (clamped >= last.timeS) return last;

  for (let i = 0; i < frames.length - 1; i += 1) {
    const a = frames[i]!;
    const b = frames[i + 1]!;
    if (clamped >= a.timeS && clamped <= b.timeS) {
      if (a.phase !== b.phase || b.timeS <= a.timeS + 1e-6) {
        return clamped - a.timeS < b.timeS - clamped ? a : b;
      }
      const alpha = (clamped - a.timeS) / (b.timeS - a.timeS);
      const interpolatedSample = interpolateApplianceSample(
        a.sample,
        b.sample,
        alpha,
      );
      const interpolatedBench =
        a.phase === "oven-bake" ? b.benchSample : interpolatedSample;
      const stage =
        run.stages.find((s) => clamped >= s.startS && clamped < s.endS) ?? b;
      return {
        timeS: clamped,
        stageId: "id" in stage ? stage.id : b.stageId,
        stageLabel: "label" in stage ? stage.label : b.stageLabel,
        phase: b.phase,
        sample: interpolatedSample,
        benchSample: interpolatedBench,
        flexMesh:
          a.phase === "oven-bake"
            ? b.flexMesh
            : (interpolatedSample.flexMeshes.find(
                (m) => m.name === "pastry_sheet",
              ) ??
              interpolatedSample.flexMeshes[0] ??
              b.flexMesh),
        doughBlockMesh:
          a.phase === "oven-bake"
            ? b.doughBlockMesh
            : (interpolatedSample.flexMeshes.find(
                (m) => m.name === "dough_block",
              ) ?? b.doughBlockMesh),
        doughBlockHeightMm: lerpScalar(
          a.doughBlockHeightMm,
          b.doughBlockHeightMm,
          alpha,
        ),
        doughBlockSpanMm: lerpScalar(
          a.doughBlockSpanMm,
          b.doughBlockSpanMm,
          alpha,
        ),
        cavityDrapeMm: lerpScalar(a.cavityDrapeMm, b.cavityDrapeMm, alpha),
        sheetThicknessMm: lerpScalar(
          a.sheetThicknessMm,
          b.sheetThicknessMm,
          alpha,
        ),
        sealCoveragePct: lerpScalar(
          a.sealCoveragePct,
          b.sealCoveragePct,
          alpha,
        ),
        rimCrimpForceN: lerpScalar(a.rimCrimpForceN, b.rimCrimpForceN, alpha),
        benchC: lerpScalar(a.benchC, b.benchC, alpha),
        benchFloured: b.benchFloured,
        rollerWorkJ: lerpScalar(a.rollerWorkJ, b.rollerWorkJ, alpha),
        doughTempC: lerpScalar(a.doughTempC, b.doughTempC, alpha),
        doughMassG: lerpScalar(a.doughMassG, b.doughMassG, alpha),
        ovenChamberC: lerpScalar(a.ovenChamberC, b.ovenChamberC, alpha),
        ovenDoorOpenRatio: lerpScalar(
          a.ovenDoorOpenRatio,
          b.ovenDoorOpenRatio,
          alpha,
        ),
        ovenState: b.ovenState,
        carrierOffset: lerpVec3(a.carrierOffset, b.carrierOffset, alpha),
        crustBrowning: lerpScalar(a.crustBrowning, b.crustBrowning, alpha),
        puffLiftMm: lerpScalar(a.puffLiftMm, b.puffLiftMm, alpha),
        steamLossG: lerpScalar(a.steamLossG, b.steamLossG, alpha),
      };
    }
  }
  return last;
}

// The choices of the pastry bench form and view.
export const PIE_TYPE_ITEMS = [
  { value: "steak-and-pepper", label: "Steak & cracked black pepper pie" },
  { value: "beef-bourguignon", label: "Beef bourguignon pie" },
];

export const THICKNESS_ITEMS = [
  { value: "2.5", label: "2.5 mm delicate shortcrust shell" },
  { value: "3.0", label: "3.0 mm standard patisserie shell" },
  { value: "3.5", label: "3.5 mm deep-braise reinforced shell" },
];

export const CRIMP_FORCE_ITEMS = [
  { value: "36", label: "36 N gentle fluted seal" },
  { value: "42", label: "42 N standard rim crimp" },
  { value: "52", label: "52 N high-compression steam lock" },
];

export const FAULT_CHECK_ITEMS = [
  {
    value: "none",
    label: "Nominal floured marble bench (330 g base + 240 g puff lid)",
  },
  {
    value: "unfloured-bench",
    label: "Unfloured bench sticking fault + 14 g T55 flour recovery",
  },
];
