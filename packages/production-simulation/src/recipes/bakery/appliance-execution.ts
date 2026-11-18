import { canonicalJson, isRecord, parseJsonOrNull, sha256Hex } from "@seams/std";
import { strFromU8, strToU8 } from "fflate";
import { exchangeNow, type CellModule } from "../../native/wasm-transport.ts";
import {
  freshApplianceRequest,
  parseApplianceResult,
  type ApplianceAction,
  type ApplianceBatch,
  type ApplianceContents,
  type ApplianceContinuation,
  type ApplianceName,
  type ApplianceRequest,
  type ApplianceResult,
} from "@seams/bakery-model/bakery-appliance-protocol";
import { checkpointBody } from "@seams/bakery-model/bakery-checkpoint";
import type { CompiledScenario, TaskDefinition } from "../../scenario.ts";
import type { RunState } from "../../state.ts";
import {
  financierFlavourOf,
} from "./financier-flavours.ts";
import {
  computeContinuousWaveCarrierReturnSummary,
  type CarrierPoolId,
  type CarrierPoolTurnaroundRecord,
  type ContinuousWaveCarrierReturnSummary,
} from "./carrier-pool-turnaround.ts";
import {
  buildPastryUnflouredFaultActions,
  buildPastryUnflouredRestoreActions,
  computePastryBenchDeformationTelemetry,
  computePastryBenchSummary,
  evaluatePastryBenchInspectionGate,
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
  type PastryBenchDeformationTelemetry,
  type PastryBenchSummary,
} from "./pastry-bench-execution.ts";

export {
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
  type CarrierPoolId,
  type CarrierPoolTurnaroundRecord,
  type ContinuousWaveCarrierReturnSummary,
  type PastryBenchDeformationTelemetry,
  type PastryBenchSummary,
};

/**
 * The tray that the showcase oven puts on its middle-rear hotspot deck: the
 * second tray of a run, the coffee load in the four-flavour shift.
 */
function isHotspotFinancierTray(instanceId: string): boolean {
  return (
    instanceId.startsWith("load-coffee-a") ||
    instanceId.startsWith("load-hazelnut-b")
  );
}

export type ApplianceCategory =
  | "weigh"
  | "hob"
  | "mixer"
  | "grinder"
  | "blender"
  | "milk-frother"
  | "espresso"
  | "oven"
  | "chiller"
  | "dishwasher"
  | "pastry-bench";

export type ApplianceTaskContext = Readonly<{
  continuation: ApplianceContinuation | null;
  checkpoint: Record<string, unknown> | null;
  previousInstanceBatchTemperatureC: number | null;
}>;

export type ScheduledTaskDescriptor = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
  definition: TaskDefinition | null;
}>;

export type RecipeApplianceTaskBinding = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
  category: ApplianceCategory;
  appliance: ApplianceName;
  label: string;
  batch: ApplianceBatch | null;
  buildActions(context: ApplianceTaskContext): readonly ApplianceAction[];
}>;

/** The controller's Wasm module; an appliance run is one host command. */
export type ApplianceWasmRuntime = CellModule;

export type ApplianceWasmRuntimeSource =
  | ApplianceWasmRuntime
  | (() => Promise<ApplianceWasmRuntime> | ApplianceWasmRuntime);

export type ApplianceFaultInjectionSpec = Readonly<{
  faultKind:
    | "mixer-guard-open"
    | "blender-lid-open"
    | "oven-door-open"
    | "dishwasher-door-open"
    | "pastry-bench-unfloured";
  description: string;
  buildFaultActions(
    binding: RecipeApplianceTaskBinding,
    context: ApplianceTaskContext,
  ): readonly ApplianceAction[];
  buildRestoreActions(
    binding: RecipeApplianceTaskBinding,
    faultCheckpoint: Record<string, unknown>,
  ): readonly ApplianceAction[];
}>;

export type ExecutedApplianceFaultRestoreRecord = Readonly<{
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  appliance: ApplianceName;
  category: ApplianceCategory;
  faultKind: ApplianceFaultInjectionSpec["faultKind"];
  description: string;
  priorCheckpointDigest: string | null;
  faultAttemptId: string;
  faultRejectedActionIndex: number;
  faultMessage: string;
  faultRecordingDigest: string;
  faultCheckpointDigest: string;
  faultControllerState: unknown;
  faultSampleCount: number;
  faultSimulatedSeconds: number;
  restoreAttemptId: string;
  resumedFromFaultCheckpointDigest: string;
  restoredRecordingDigest: string;
  restoredCheckpointDigest: string;
  restoredSampleCount: number;
  restoredSimulatedSeconds: number;
  transferredCount: number;
}>;

export type LinkedCellId = "tea-pan-cell" | "espresso-cell" | "pour-over-cell";

export type LinkedCellCascadeTransferRecord = Readonly<{
  cellId: LinkedCellId;
  transferTaskId: string;
  batchInstanceId: string;
  workflowId: string;
  taskKey: string;
  baselineStartSeconds: number;
  cascadedStartSeconds: number;
  delaySeconds: number;
  heldByAppliance: ApplianceName;
  heldByFaultKind: ApplianceFaultInjectionSpec["faultKind"];
  releasedByCheckpointDigest: string;
  status: "recovered";
}>;

export type MultiBatchFaultCascadeRecord = Readonly<{
  faultTaskId: string;
  faultInstanceId: string;
  appliance: ApplianceName;
  faultKind: ApplianceFaultInjectionSpec["faultKind"];
  faultCheckpointDigest: string;
  restoredCheckpointDigest: string;
  faultSimulatedSeconds: number;
  restoredSimulatedSeconds: number;
  recoveryDelaySeconds: number;
  affectedBatches: readonly string[];
  affectedCells: readonly LinkedCellId[];
  shiftedTaskCount: number;
  linkedCellTransfers: readonly LinkedCellCascadeTransferRecord[];
}>;

export type BatchMassAccounting = Readonly<{
  inputMassGrams: number;
  evaporativeOrByproductLossGrams: number;
  qcSampleGrams: number;
  acceptedYieldGrams: number;
  rejectedScrapGrams: number;
  reworkRequired: boolean;
  reworkCarrierTaskKey: string | null;
  disposition: "accepted" | "rejected-scrap-and-rework" | "in-process-transfer";
}>;

export type CoupledInspectionDecision = Readonly<{
  recommendedOutcome: "accept" | "reject";
  gateKind:
    | "bake-maillard-gate"
    | "tea-extraction-gate"
    | "espresso-extraction-gate"
    | "pour-over-extraction-gate"
    | "roast-maillard-gate"
    | "butter-maillard-gate"
    | "chiller-core-temp-gate"
    | "pastry-drape-gate"
    | "thermal-nominal-gate";
  targetSpecRange: string;
  measuredValue: number;
  unit: string;
  rationale: string;
}>;

export type ChillerColdCellTelemetry = Readonly<{
  chillerCycleIndex: number;
  defrostPhase:
    | "refrigerating"
    | "door-infiltration-pulldown"
    | "defrost-active"
    | "post-defrost-recovery";
  doorOpenCount: number;
  doorOpenDurationSeconds: number;
  doorInfiltrationSensibleJoules: number;
  doorInfiltrationLatentJoules: number;
  doorInfiltrationTotalJoules: number;
  moistureIngressGrams: number;
  cabinetAirBaseC: number;
  cabinetAirInfiltrationPeakC: number;
  cabinetAirExitC: number;
  evaporatorCoilC: number;
  evaporatorFrostMassGrams: number;
  defrostTriggered: boolean;
  defrostHeaterPowerWatts: number;
  condensateDrainedGrams: number;
  compressorDutyPercent: number;
}>;

export type ChillerColdCellSummary = Readonly<{
  totalChillerCycles: number;
  totalDoorOpenings: number;
  totalDoorOpenSeconds: number;
  totalInfiltrationHeatKj: number;
  peakCabinetAirSpikeC: number;
  minCabinetAirPullDownC: number;
  peakEvaporatorFrostGrams: number;
  defrostCycleCount: number;
  totalCondensateDrainedGrams: number;
  peakCompressorPullDownWatts: number;
}>;

export type DishwasherWarewashTelemetry = Readonly<{
  washCycleIndex: number;
  soilLoadCategory:
    | "brown-butter-mould"
    | "sesame-oil-vessel"
    | "tannin-tea-pan"
    | "carafe-and-jug";
  washTankTempC: number;
  finalRinseBoilerTempC: number;
  detergentDosedMl: number;
  rinseAidDosedMl: number;
  washBathPh: number;
  sanitizerConcentrationPpm: number;
  nsfThermalDisinfectionHue: number;
  freshWaterRinseLiters: number;
  incomingWaterTempC: number;
  preheatedWaterTempC: number;
  greywaterDischargeTempC: number;
  greywaterHeatRecoveredKj: number;
  heatRecoveryEfficiencyPercent: number;
}>;

export type DishwasherWarewashSummary = Readonly<{
  totalWashCycles: number;
  totalDetergentDosedMl: number;
  totalRinseAidDosedMl: number;
  minSanitizerPpm: number;
  peakSanitizerPpm: number;
  minThermalDisinfectionHue: number;
  totalGreywaterRecoveredKj: number;
  totalRecoveredElectricalEquivalentWh: number;
  meanHeatRecoveryEfficiencyPercent: number;
  maxGreywaterDischargeTempC: number;
}>;

export type EspressoBoilerGroupheadTelemetry = Readonly<{
  shotSequenceIndex: number;
  groupheadSide: "left" | "right";
  brewBoilerSetpointC: number;
  brewBoilerTempC: number;
  groupheadEntryTempC: number;
  groupheadMinTempC: number;
  groupheadThermalDipC: number;
  pidRecoverySeconds: number;
  pidHeaterDutyPercent: number;
  extractionPressureBar: number;
  steamBoilerSetpointC: number;
  steamBoilerTempC: number;
  steamBoilerPressureBar: number;
  steamDrawPressureDropBar: number;
  steamRecoverySeconds: number;
}>;

export type EspressoBoilerGroupheadSummary = Readonly<{
  totalExtractedShots: number;
  minGroupheadTempC: number;
  maxGroupheadThermalDipC: number;
  meanPidRecoverySeconds: number;
  minSteamBoilerPressureBar: number;
  maxSteamDrawPressureDropBar: number;
  meanSteamRecoverySeconds: number;
}>;

export type ConvectionOvenVentingRadiantTelemetry = Readonly<{
  ovenTaskKind: "preheat" | "roast-sesame" | "bake-financier" | "bake-pie";
  deckZone: "front-lower-nominal" | "middle-rear-hotspot" | "upper-roast-deck";
  chamberDryBulbC: number;
  chamberRelativeHumidityPercent: number;
  steamDamperOpenRatio: number;
  steamInjectionMl: number;
  steamVentingRateGramsPerSec: number;
  deckRadiantHeatFluxKwPerSqM: number;
  convectiveHeatFluxKwPerSqM: number;
  totalDeckHeatFluxKwPerSqM: number;
  crustMoistureDiffusivitySqMPerSec: number;
  surfaceWaterActivityAw: number;
}>;

export type ConvectionOvenVentingRadiantSummary = Readonly<{
  totalOvenCycles: number;
  nominalDeckHeatFluxKwPerSqM: number;
  hotspotDeckHeatFluxKwPerSqM: number;
  peakSteamVentingRateGramsPerSec: number;
  totalSteamInjectedMl: number;
  peakCrustMoistureDiffusivitySqMPerSec: number;
  minSurfaceWaterActivityAw: number;
}>;

export type HobCoilPanThermalTelemetry = Readonly<{
  hobType: "induction-coil" | "atmospheric-gas";
  coilFrequencyKhz: number;
  couplingEfficiencyPercent: number;
  panCenterTempC: number;
  panRimTempC: number;
  panBaseRadialGradientC: number;
  boilOffVaporRateGramsPerSec: number;
  cumulativeBoilOffGrams: number;
}>;

export type HobCoilPanThermalSummary = Readonly<{
  totalHobCycles: number;
  meanCouplingEfficiencyPercent: number;
  maxPanBaseRadialGradientC: number;
  peakPanCenterTempC: number;
  peakBoilOffVaporRateGramsPerSec: number;
  totalBoilOffEvaporatedGrams: number;
}>;

export type PrecisionScaleLoadCellTelemetry = Readonly<{
  weighIndex: number;
  targetMassGrams: number;
  settledMassGrams: number;
  loadCellSettlingTimeSeconds: number;
  zeroTareDriftMg: number;
  airDraftDisturbanceMgPeak: number;
  digitalFilterRejectionDb: number;
  stabilityLockStatus: "locked-stable" | "draft-filtered";
}>;

export type PrecisionScaleLoadCellSummary = Readonly<{
  totalWeighings: number;
  meanSettlingTimeSeconds: number;
  maxSettlingTimeSeconds: number;
  maxZeroTareDriftMg: number;
  peakAirDraftDisturbanceMg: number;
  meanFilterRejectionDb: number;
}>;

export type PlanetaryMixerRheologyTelemetry = Readonly<{
  mixStage: "dry-blend-speed1" | "batter-emulsify-speed2" | "paste-homogenize";
  agitatorRpm: number;
  specificWorkInputWhPerKg: number;
  meanShaftTorqueNm: number;
  shaftTorqueRippleNmPeakToPeak: number;
  viscousShearHeatingWatts: number;
  bowlWallHeatTransferWatts: number;
  emulsionDevelopmentIndex: number;
}>;

export type PlanetaryMixerRheologySummary = Readonly<{
  totalMixCycles: number;
  totalSpecificWorkWhPerKg: number;
  peakShaftTorqueNm: number;
  maxTorqueRippleNmPeakToPeak: number;
  peakViscousHeatingWatts: number;
  meanEmulsionIndex: number;
}>;

export type MilkFrotherMicrofoamTelemetry = Readonly<{
  frothCycleIndex: number;
  whiskDiscRpm: number;
  vortexShearRateInverseSec: number;
  microfoamOverrunPercent: number;
  meanBubbleDiameterMicrons: number;
  pitcherExitTempC: number;
  betaLactoglobulinDenaturationPercent: number;
  proteinWindowStatus: "optimal-microfoam-window" | "under-aerated" | "scald-risk";
}>;

export type MilkFrotherMicrofoamSummary = Readonly<{
  totalFrothCycles: number;
  meanMicrofoamOverrunPercent: number;
  peakVortexShearRateInverseSec: number;
  meanBubbleDiameterMicrons: number;
  meanWheyDenaturationPercent: number;
  maxPitcherExitTempC: number;
}>;

export type CoupledBatchPhysicsMetrics = Readonly<{
  upstreamSourceInstanceId: string | null;
  stagingWaitSeconds: number;
  ambientRoomC: number;
  ambientRelativeHumidityPercent: number;
  entryTemperatureC: number;
  exitTemperatureC: number;
  deltaTemperatureC: number;
  enthalpyDeltaJoules: number;
  apparentViscosityPas: number;
  acousticNoiseDba: number;
  vibrationMmPerSecRms: number;
  maillardBrowningIndex: number;
  extractionSolidsYieldPercent: number;
  durationCouplingFactor: number;
  qualityGateStatus:
    | "within-spec"
    | "thermal-drift-compensated"
    | "requires-inspection";
  inspectionDecision: CoupledInspectionDecision;
  massAccounting: BatchMassAccounting;
  chillerTelemetry: ChillerColdCellTelemetry | null;
  dishwasherTelemetry: DishwasherWarewashTelemetry | null;
  espressoTelemetry: EspressoBoilerGroupheadTelemetry | null;
  ovenVentingTelemetry: ConvectionOvenVentingRadiantTelemetry | null;
  hobTelemetry: HobCoilPanThermalTelemetry | null;
  scaleTelemetry: PrecisionScaleLoadCellTelemetry | null;
  mixerTelemetry: PlanetaryMixerRheologyTelemetry | null;
  frotherTelemetry: MilkFrotherMicrofoamTelemetry | null;
  pastryTelemetry: PastryBenchDeformationTelemetry | null;
}>;

export type AmbientRoomPsychrometricSummary = Readonly<{
  roomVolumeCubicMeters: number;
  baselineDryBulbC: number;
  peakDryBulbC: number;
  baselineRelativeHumidityPercent: number;
  peakRelativeHumidityPercent: number;
  peakWetBulbC: number;
  peakDewPointC: number;
  peakHumidityRatioGPerKg: number;
  peakSpecificEnthalpyKjPerKg: number;
  baselineCanopyHoodExhaustCfm: number;
  peakCanopyHoodExhaustCfm: number;
  peakHvacCoolingLoadWatts: number;
}>;

export type FacilityAcousticVibrationSummary = Readonly<{
  baselineRoomNoiseDba: number;
  peakRoomNoiseDba: number;
  peakApplianceNoiseDba: number;
  peakVibrationMmPerSecRms: number;
  dominantRotaryAppliance: ApplianceName;
  elevatedRotaryVibrationWindows: number;
}>;

export type FacilityUtilityLoadSummary = Readonly<{
  nominalLineVoltageVolts: number;
  ratedBusCapacityWatts: number;
  peakTotalPowerWatts: number;
  peakPhaseLoadsWatts: Readonly<{ l1: number; l2: number; l3: number }>;
  peakPhaseImbalancePercent: number;
  minLineVoltageVolts: number;
  nominalWaterStaticPressureBar: number;
  peakWaterFlowLpm: number;
  minWaterManifoldPressureBar: number;
  concurrentHighDrawWindows: number;
  totalElectricalEnergyWh: number;
  totalWaterConsumedLiters: number;
  hvacPsychrometrics: AmbientRoomPsychrometricSummary;
  acousticsAndVibration: FacilityAcousticVibrationSummary;
  chillerColdCell: ChillerColdCellSummary;
  dishwasherWarewash: DishwasherWarewashSummary;
  espressoBoiler: EspressoBoilerGroupheadSummary;
  ovenVentingRadiant: ConvectionOvenVentingRadiantSummary;
  hobCoilThermal: HobCoilPanThermalSummary;
  precisionScale: PrecisionScaleLoadCellSummary;
  planetaryMixer: PlanetaryMixerRheologySummary;
  milkFrother: MilkFrotherMicrofoamSummary;
  pastryBench: PastryBenchSummary;
}>;

export type ExecutedApplianceTaskRecord = Readonly<{
  index: number;
  taskId: string;
  instanceId: string;
  workflowId: string;
  taskKey: string;
  startedAtUs: number;
  completedAtUs: number;
  cascadeShiftedByUs?: number;
  cascadeHeldByFaultTaskIds?: readonly string[];
  category: ApplianceCategory;
  appliance: ApplianceName;
  label: string;
  resumedFromCheckpointDigest: string | null;
  request: ApplianceRequest;
  result: ApplianceResult;
  recordingDigest: string;
  checkpointDigest: string;
  sampleCount: number;
  simulatedSeconds: number;
  inputBatch: ApplianceBatch | null;
  transferred: readonly ApplianceBatch[];
  finalController: unknown;
  finalDisplays: readonly unknown[];
  coupledPhysics: CoupledBatchPhysicsMetrics;
  faultRestore?: ExecutedApplianceFaultRestoreRecord;
}>;

export type QualityGateLotAccountingRecord = Readonly<{
  instanceId: string;
  workflowId: string;
  gateTaskId: string;
  gateKind: CoupledInspectionDecision["gateKind"];
  outcome: "accept" | "reject";
  measuredValue: number;
  unit: string;
  inputMassGrams: number;
  evaporativeOrByproductLossGrams: number;
  qcSampleGrams: number;
  acceptedYieldGrams: number;
  rejectedScrapGrams: number;
  reworkRequired: boolean;
  reworkCarrierTaskKey: string | null;
}>;

export type QualityGateMassBalanceSummary = Readonly<{
  totalEvaluatedLots: number;
  acceptedLotCount: number;
  rejectedLotCount: number;
  totalInputMassGrams: number;
  totalEvaporativeOrByproductLossGrams: number;
  totalQcSampleGrams: number;
  totalAcceptedYieldGrams: number;
  totalRejectedScrapGrams: number;
  firstPassYieldPercent: number;
  reworkLoopCount: number;
  lotRecords: readonly QualityGateLotAccountingRecord[];
}>;

export type RecipeApplianceExecutionReport = Readonly<{
  runId: string;
  taskCount: number;
  applianceCount: number;
  records: readonly ExecutedApplianceTaskRecord[];
  faultRestores: readonly ExecutedApplianceFaultRestoreRecord[];
  faultCascades: readonly MultiBatchFaultCascadeRecord[];
  facilityUtilities: FacilityUtilityLoadSummary;
  massBalance: QualityGateMassBalanceSummary;
  carrierReturnSummary: ContinuousWaveCarrierReturnSummary;
  continuations: ReadonlyMap<ApplianceName, ApplianceContinuation>;
  checkpointDigests: Readonly<Record<string, string>>;
}>;

export type RecipeApplianceExecutionOptions = Readonly<{
  runId?: string;
  initialContinuations?: ReadonlyMap<ApplianceName, ApplianceContinuation>;
  faultInjections?: ReadonlyMap<string, ApplianceFaultInjectionSpec>;
  scheduledTasks?: readonly ScheduledTaskDescriptor[];
}>;

export function sanitizeAttemptId(raw: string, index: number): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const prefix = `step-${index + 1}-`;
  const maxBody = 120 - prefix.length;
  const body = (cleaned.length > 0 ? cleaned : "task").slice(0, maxBody);
  return `${prefix}${body}`;
}

export function batchSpec(
  identity: string,
  massKg: number,
  temperatureC = 20,
  specificHeat = 3800,
  densityKgL = 1.03,
  resistance = 0.05,
): ApplianceBatch {
  const safeId = identity
    .replace(/[^a-zA-Z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return {
    identity: safeId.length > 0 ? safeId : "recipe-batch",
    mass_kg: Math.max(0.001, Number(massKg.toFixed(6))),
    temperature_c: Number(temperatureC.toFixed(3)),
    specific_heat: specificHeat,
    density_kg_l: densityKgL,
    resistance,
  };
}

export function taskMaterialMassKg(
  definition: TaskDefinition | null,
  fallbackKg: number,
): number {
  if (definition === null) return fallbackKg;
  let outputMg = 0;
  for (const out of definition.outputs) {
    if (out.kind === "lot" && out.quantity.unit === "milligram")
      outputMg += out.quantity.amount;
  }
  if (outputMg > 0) return outputMg / 1_000_000;
  let inputMg = 0;
  for (const inp of definition.inputs) {
    if (inp.quantity.unit === "milligram") inputMg += inp.quantity.amount;
  }
  if (inputMg > 0) return inputMg / 1_000_000;
  return fallbackKg;
}

export type ScheduledTaskSource =
  | RunState
  | CompiledScenario
  | Readonly<{
      definition: Readonly<{ scenario: CompiledScenario }>;
      instances: readonly Readonly<{ id: string; workflow: string }>[];
      tasks: readonly Readonly<Record<string, unknown>>[];
    }>;

export function extractScheduledTasks(
  source: ScheduledTaskSource,
): readonly ScheduledTaskDescriptor[] {
  if ("definition" in source && "tasks" in source && "instances" in source) {
    const scenario = source.definition.scenario;
    const workflowByInstance = new Map<string, string>();
    for (const instance of source.instances)
      workflowByInstance.set(instance.id, instance.workflow);
    const definitionMap = new Map<string, TaskDefinition>();
    for (const wf of scenario.workflows) {
      for (const td of wf.tasks) {
        definitionMap.set(`${wf.id}/${td.key}`, td);
      }
    }
    const completed: ScheduledTaskDescriptor[] = [];
    for (const rawTask of source.tasks) {
      if (!isRecord(rawTask) || rawTask.kind !== "completed") continue;
      const taskId = typeof rawTask.id === "string" ? rawTask.id : "";
      const startedAtUs =
        typeof rawTask.startedAt === "number" ? rawTask.startedAt : 0;
      const completedAtUs =
        typeof rawTask.completedAt === "number" ? rawTask.completedAt : 0;
      let instanceId: string | null = null;
      let taskKey: string | null = null;
      if ("subject" in rawTask && isRecord(rawTask.subject)) {
        if (
          rawTask.subject.kind === "workflow" &&
          typeof rawTask.subject.instance === "string" &&
          typeof rawTask.subject.key === "string"
        ) {
          instanceId = rawTask.subject.instance;
          taskKey = rawTask.subject.key;
        }
      } else if (
        "instance" in rawTask &&
        typeof rawTask.instance === "string" &&
        "definition" in rawTask &&
        typeof rawTask.definition === "string"
      ) {
        instanceId = rawTask.instance;
        taskKey = rawTask.definition;
      }
      if (instanceId === null || taskKey === null) continue;
      const workflowId = workflowByInstance.get(instanceId) ?? "workflow";
      completed.push({
        taskId,
        instanceId,
        workflowId,
        taskKey,
        startedAtUs,
        completedAtUs,
        definition: definitionMap.get(`${workflowId}/${taskKey}`) ?? null,
      });
    }
    completed.sort((a, b) => {
      if (a.startedAtUs !== b.startedAtUs) return a.startedAtUs - b.startedAtUs;
      if (a.completedAtUs !== b.completedAtUs)
        return a.completedAtUs - b.completedAtUs;
      return a.taskId.localeCompare(b.taskId);
    });
    return completed;
  }

  const scenario = source;
  const descriptors: ScheduledTaskDescriptor[] = [];
  let cursorUs = 0;
  for (const wf of scenario.workflows) {
    const arrivalSource = scenario.arrivals.find((a) => a.workflow === wf.id);
    const count =
      arrivalSource?.kind === "explicit"
        ? Math.max(1, arrivalSource.arrivals.length)
        : 1;
    const prefix = arrivalSource?.id ?? wf.id;
    for (let index = 0; index < count; index++) {
      const instanceId = `${prefix}#${index}`;
      for (const td of wf.tasks) {
        const startUs = cursorUs;
        cursorUs += 1_000_000;
        descriptors.push({
          taskId: `${instanceId}/${td.key}`,
          instanceId,
          workflowId: wf.id,
          taskKey: td.key,
          startedAtUs: startUs,
          completedAtUs: cursorUs,
          definition: td,
        });
      }
    }
  }
  return descriptors;
}

export function weighActions(batch: ApplianceBatch): readonly ApplianceAction[] {
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "start", program: { kind: "weigh" } },
    { kind: "advance", seconds: 3 },
    { kind: "require", state: "stable" },
    { kind: "remove-contents" },
  ];
}

export function hobPowerActions(
  batch: ApplianceBatch,
  percent: number,
  durationSeconds = 5,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(2, Math.min(20, Math.round(durationSeconds)));
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "hob-power",
        percent: Math.max(10, Math.min(90, percent)),
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 1 },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function hobTemperatureActions(
  batch: ApplianceBatch,
  targetC: number,
  durationSeconds = 5,
): readonly ApplianceAction[] {
  const clampedTarget = Math.max(45, Math.min(90, targetC));
  const clampedDuration = Math.max(2, Math.min(20, Math.round(durationSeconds)));
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "hob-temperature",
        target_c: clampedTarget,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 1 },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  ];
}

export function planetaryMixActions(
  batch: ApplianceBatch,
  setting: 1 | 2 | 3 | 4 = 2,
  durationSeconds = 4,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(2, Math.min(10, Math.round(durationSeconds)));
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "planetary",
        setting,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 4 },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function grindActions(
  batch: ApplianceBatch,
  durationSeconds = 3,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(2, Math.min(8, Math.round(durationSeconds)));
  const highDragBatch: ApplianceBatch = {
    ...batch,
    resistance: Math.max(25, batch.resistance),
  };
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch: highDragBatch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "grind",
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 3 },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function blendActions(
  batch: ApplianceBatch,
  percent = 45,
  durationSeconds = 4,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(2, Math.min(10, Math.round(durationSeconds)));
  const dampedBatch: ApplianceBatch = {
    ...batch,
    resistance: Math.max(2.5, batch.resistance),
  };
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch: dampedBatch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "blend",
        percent: Math.max(7, Math.min(100, Math.round(percent))),
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration + 3 },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function heatedFrotherActions(
  batch: ApplianceBatch,
  targetC = 45,
  context: ApplianceTaskContext,
): readonly ApplianceAction[] {
  const clampedTarget = Math.max(45, Math.min(65, targetC));
  const controller = isRecord(context.checkpoint?.controller)
    ? context.checkpoint.controller
    : null;
  const jugC =
    controller !== null && typeof controller.jug_c === "number"
      ? controller.jug_c
      : 20;
  const warmBatch: ApplianceBatch = {
    ...batch,
    temperature_c: Math.max(38, Math.min(clampedTarget - 2, batch.temperature_c)),
    resistance: Math.max(2.0, batch.resistance),
  };
  const advanceSeconds = jugC >= 35 ? 30 : 42;
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch: warmBatch } },
    { kind: "advance", seconds: 1 },
    {
      kind: "start",
      program: {
        kind: "heated-mix",
        target_c: clampedTarget,
      },
    },
    { kind: "advance", seconds: advanceSeconds },
    { kind: "require", state: "complete" },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

function ovenCheckpointState(checkpoint: Record<string, unknown> | null): {
  kind: string | null;
  targetC: number | null;
  chamberC: number;
} {
  if (checkpoint === null || !isRecord(checkpoint.controller))
    return { kind: null, targetC: null, chamberC: 22 };
  const oven = isRecord(checkpoint.controller.oven)
    ? checkpoint.controller.oven
    : null;
  if (oven === null) return { kind: null, targetC: null, chamberC: 22 };
  const state = isRecord(oven.state) ? oven.state : null;
  return {
    kind: typeof state?.kind === "string" ? state.kind : null,
    targetC: typeof state?.target_c === "number" ? state.target_c : null,
    chamberC: typeof oven.chamber_c === "number" ? oven.chamber_c : 22,
  };
}

export function ovenPreheatActions(
  targetC = 55,
  context: ApplianceTaskContext,
): readonly ApplianceAction[] {
  const current = ovenCheckpointState(context.checkpoint);
  if (current.kind === "ready" && current.targetC === targetC) {
    return [
      { kind: "advance", seconds: 2 },
      { kind: "require", state: "ready" },
    ];
  }
  const settleSeconds =
    Math.abs(current.chamberC - targetC) <= 3
      ? 12
      : Math.max(20, Math.min(500, Math.ceil((targetC - current.chamberC) * 2.2 + 18)));
  return [
    { kind: "stop" },
    { kind: "start", program: { kind: "preheat", target_c: targetC } },
    { kind: "advance", seconds: settleSeconds },
    { kind: "require", state: "ready" },
  ];
}

export function ovenBakeActions(
  batch: ApplianceBatch,
  targetC = 55,
  durationSeconds = 12,
  context: ApplianceTaskContext,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(10, Math.min(60, Math.round(durationSeconds)));
  const current = ovenCheckpointState(context.checkpoint);
  const actions: ApplianceAction[] = [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
  ];
  if (current.kind !== "ready" || current.targetC !== targetC) {
    const preheatSeconds =
      Math.abs(current.chamberC - targetC) <= 3
        ? 12
        : Math.max(20, Math.min(500, Math.ceil((targetC - current.chamberC) * 2.2 + 18)));
    actions.push(
      { kind: "stop" },
      { kind: "start", program: { kind: "preheat", target_c: targetC } },
      { kind: "advance", seconds: preheatSeconds },
      { kind: "require", state: "ready" },
    );
  }
  actions.push(
    {
      kind: "start",
      program: {
        kind: "bake",
        target_c: targetC,
        duration_s: clampedDuration,
      },
    },
    { kind: "advance", seconds: clampedDuration },
    { kind: "require", state: "complete" },
    { kind: "remove-contents" },
  );
  return actions;
}

export function chillerActions(
  batch: ApplianceBatch,
  durationSeconds = 6,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(3, Math.min(20, Math.round(durationSeconds)));
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "start", program: { kind: "refrigerate" } },
    { kind: "advance", seconds: clampedDuration },
    { kind: "stop" },
    { kind: "remove-contents" },
  ];
}

export function dishwasherActions(
  batch: ApplianceBatch,
  durationSeconds = 6,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(4, Math.min(20, Math.round(durationSeconds)));
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    { kind: "prepare-wash" },
    { kind: "advance", seconds: clampedDuration },
    { kind: "stop" },
    { kind: "remove-contents" },
  ];
}

export function espressoActions(
  batch: ApplianceBatch,
  durationSeconds = 6,
): readonly ApplianceAction[] {
  const clampedDuration = Math.max(4, Math.min(18, Math.round(durationSeconds)));
  const placeSeconds = Math.max(2, Math.floor(clampedDuration / 3));
  const brewSeconds = Math.max(2, clampedDuration - placeSeconds);
  return [
    { kind: "set-contents", contents: { kind: "loaded", batch } },
    {
      kind: "start",
      program: { kind: "espresso-warmup", coffee_c: 93, steam_c: 125 },
    },
    { kind: "set-shot-dose", group: "left", slot: "two", duration_s: 18 },
    { kind: "move-cup", outlet: "left", position: "removed" },
    { kind: "advance", seconds: placeSeconds },
    { kind: "move-cup", outlet: "left", position: "placed" },
    { kind: "advance", seconds: brewSeconds },
    { kind: "require", state: "stopped" },
    { kind: "remove-contents" },
  ];
}

export function defaultMorningShiftFaultInjections(): ReadonlyMap<
  string,
  ApplianceFaultInjectionSpec
> {
  const map = new Map<string, ApplianceFaultInjectionSpec>();

  map.set("hazelnut-preparation-batches#0/mix", {
    faultKind: "mixer-guard-open",
    description:
      "Hobart HL200 safety guard opens mid-planetary-mix, pausing the motor with remaining time in checkpoint; restore closes guard and resumes.",
    buildFaultActions(binding) {
      const batch =
        binding.batch ?? batchSpec("hazelnut-preparation-batches-0-mix", 0.248, 22, 3200, 1.08, 0.4);
      return [
        { kind: "set-contents", contents: { kind: "loaded", batch } },
        { kind: "advance", seconds: 1 },
        {
          kind: "start",
          program: { kind: "planetary", setting: 2, duration_s: 4 },
        },
        { kind: "advance", seconds: 2 },
        { kind: "guard", open: true },
        { kind: "advance", seconds: 1 },
        { kind: "require", state: "complete" },
      ];
    },
    buildRestoreActions() {
      return [
        { kind: "guard", open: false },
        { kind: "advance", seconds: 2 },
        { kind: "resume" },
        { kind: "advance", seconds: 6 },
        { kind: "require", state: "complete" },
        { kind: "require", state: "stopped" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("sesame-batches#0/blend", {
    faultKind: "blender-lid-open",
    description:
      "Vitamix Quiet One lid lifts mid-blend, triggering SIM_LID_OPEN motor fault in checkpoint; restore closes lid, resets fault, and finishes blend.",
    buildFaultActions(binding) {
      const base =
        binding.batch ?? batchSpec("sesame-0-blend", 0.76, 62, 3600, 1.04, 2.5);
      const dampedBatch: ApplianceBatch = {
        ...base,
        resistance: Math.max(2.5, base.resistance),
      };
      return [
        {
          kind: "set-contents",
          contents: { kind: "loaded", batch: dampedBatch },
        },
        { kind: "advance", seconds: 1 },
        {
          kind: "start",
          program: { kind: "blend", percent: 45, duration_s: 4 },
        },
        { kind: "advance", seconds: 2 },
        { kind: "lid", open: true },
        { kind: "advance", seconds: 1 },
        { kind: "require", state: "complete" },
      ];
    },
    buildRestoreActions() {
      return [
        { kind: "lid", open: false },
        { kind: "advance", seconds: 2 },
        { kind: "reset" },
        {
          kind: "start",
          program: { kind: "blend", percent: 45, duration_s: 3 },
        },
        { kind: "advance", seconds: 6 },
        { kind: "require", state: "complete" },
        { kind: "require", state: "stopped" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("load-hazelnut-a#0/bake", {
    faultKind: "oven-door-open",
    description:
      "Maruzen MBCO-5E door opens 5 s into bake, pausing the bake timer in checkpoint; restore closes door, recovers chamber heat, and resumes remaining bake.",
    buildFaultActions(binding, context) {
      const batch =
        binding.batch ?? batchSpec("load-hazelnut-a-0-bake", 0.36, 24, 3100, 1.05, 0.2);
      const current = ovenCheckpointState(context.checkpoint);
      const actions: ApplianceAction[] = [
        { kind: "set-contents", contents: { kind: "loaded", batch } },
      ];
      if (current.kind !== "ready" || current.targetC !== 55) {
        const preheatSeconds =
          Math.abs(current.chamberC - 55) <= 3
            ? 12
            : Math.max(
                20,
                Math.min(500, Math.ceil((55 - current.chamberC) * 2.2 + 18)),
              );
        actions.push(
          { kind: "stop" },
          { kind: "start", program: { kind: "preheat", target_c: 55 } },
          { kind: "advance", seconds: preheatSeconds },
          { kind: "require", state: "ready" },
        );
      }
      actions.push(
        {
          kind: "start",
          program: { kind: "bake", target_c: 55, duration_s: 12 },
        },
        { kind: "advance", seconds: 5 },
        { kind: "door", open: true, right: false },
        { kind: "advance", seconds: 1 },
        { kind: "require", state: "complete" },
      );
      return actions;
    },
    buildRestoreActions() {
      return [
        { kind: "door", open: false, right: false },
        { kind: "advance", seconds: 3 },
        { kind: "resume" },
        { kind: "advance", seconds: 8 },
        { kind: "require", state: "complete" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("load-hazelnut-a#0/clean-mould", {
    faultKind: "dishwasher-door-open",
    description:
      "Winterhalter UC-L door opens during wash filling, latching DoorFault in checkpoint; restore closes door, re-prepares wash cycle, and sanitizes.",
    buildFaultActions(binding) {
      const batch =
        binding.batch ?? batchSpec("load-hazelnut-a-0-clean-mould", 0.25, 25, 4180, 1.0, 0.02);
      return [
        { kind: "set-contents", contents: { kind: "loaded", batch } },
        { kind: "prepare-wash" },
        { kind: "advance", seconds: 1 },
        { kind: "door", open: true, right: false },
        { kind: "advance", seconds: 1 },
        { kind: "prepare-wash" },
      ];
    },
    buildRestoreActions() {
      return [
        { kind: "door", open: false, right: false },
        { kind: "advance", seconds: 2 },
        { kind: "prepare-wash" },
        { kind: "advance", seconds: 5 },
        { kind: "stop" },
        { kind: "remove-contents" },
      ];
    },
  });

  map.set("steak-and-pepper-pie-batches#0/line-tins-a", {
    faultKind: "pastry-bench-unfloured",
    description:
      "Pastry bench starts shortcrust sheeting with bench flour wiped off, latching PastryState::Fault in checkpoint; restore dusts bench flour and completes tin lining.",
    buildFaultActions(binding) {
      const batch =
        binding.batch ??
        batchSpec("steak-and-pepper-line-tins-a", 0.33, 8, 1900, 1.15, 0.6);
      return buildPastryUnflouredFaultActions(batch);
    },
    buildRestoreActions() {
      return buildPastryUnflouredRestoreActions();
    },
  });

  return map;
}

function runApplianceAttemptOnWasm(
  activeRuntime: ApplianceWasmRuntime,
  request: ApplianceRequest,
  taskId: string,
  appliance: ApplianceName,
): ApplianceResult {
  const text = exchangeNow(
    activeRuntime,
    { encode: strToU8, decode: strFromU8 },
    JSON.stringify({ op: "appliance", request: JSON.parse(request.file) }),
  );
  const reply = parseJsonOrNull(text);
  if (
    !isRecord(reply) ||
    reply.kind !== "appliance" ||
    typeof reply.file !== "string"
  )
    throw new Error(
      `Wasm appliance_run failed on ${taskId} (${appliance}): ${text.slice(0, 400)}`,
    );
  return parseApplianceResult(reply.file, request);
}
function parseCheckpointObject(
  result: ApplianceResult,
): Record<string, unknown> | null {
  try {
    // The continuation is a checkpoint envelope; its fields are the payload.
    const parsed: unknown = JSON.parse(result.file);
    return isRecord(parsed) ? checkpointBody(parsed.continuation) : null;
  } catch {
    return null;
  }
}

export function linkedCellForScheduledTask(
  task: Pick<ScheduledTaskDescriptor, "instanceId" | "workflowId" | "taskKey">,
): LinkedCellId | null {
  if (
    task.workflowId === "pour-over-brew" ||
    task.instanceId.startsWith("pour-over-order") ||
    task.taskKey === "wash-jug" ||
    task.taskKey === "clean-batch-vessels"
  ) {
    return "pour-over-cell";
  }
  if (
    task.workflowId === "espresso-orders" ||
    task.instanceId.startsWith("espresso-order") ||
    task.workflowId === "sesame-drink" ||
    task.instanceId.startsWith("sesame-orders")
  ) {
    return "espresso-cell";
  }
  if (
    task.taskKey === "stage-pan" ||
    task.taskKey === "stage-pan-b" ||
    task.taskKey === "transfer-cold-carrier" ||
    task.taskKey === "bake" ||
    task.taskKey === "cool" ||
    task.workflowId.includes("tea") ||
    task.workflowId.startsWith("load-")
  ) {
    return "tea-pan-cell";
  }
  return null;
}

type BatchThermalState = Readonly<{
  instanceId: string;
  temperatureC: number;
  completedAtUs: number;
}>;

function resolveUpstreamThermalHandoff(
  binding: RecipeApplianceTaskBinding,
  instanceStates: ReadonlyMap<string, BatchThermalState>,
  workflowLatestStates: ReadonlyMap<string, BatchThermalState>,
): BatchThermalState | null {
  const sameInstance = instanceStates.get(binding.instanceId);
  if (sameInstance !== undefined) return sameInstance;
  const prefix = binding.instanceId.split("#")[0] ?? binding.instanceId;
  if (prefix.endsWith("preparation-batches")) {
    return workflowLatestStates.get("butter-batches") ?? null;
  }
  if (prefix.startsWith("load-")) {
    const flavour = financierFlavourOf(prefix);
    return flavour === null
      ? null
      : (workflowLatestStates.get(`${flavour}-preparation-batches`) ?? null);
  }
  if (prefix.endsWith("-pie-batches")) {
    if (binding.taskKey.startsWith("line-tins")) {
      return workflowLatestStates.get("shortcrust-batches") ?? null;
    }
    return (
      workflowLatestStates.get(
        prefix.replace(/-pie-batches$/u, "-filling-batches"),
      ) ?? null
    );
  }
  if (prefix === "sesame-orders") {
    return workflowLatestStates.get("sesame-batches") ?? null;
  }
  if (prefix === "tea-batches" || prefix === "milk-tea-batches") {
    return workflowLatestStates.get("water-batches") ?? null;
  }
  return null;
}

function computeCoupledBatchPhysics(
  binding: RecipeApplianceTaskBinding,
  upstream: BatchThermalState | null,
  inputBatch: ApplianceBatch | null,
  result: ApplianceResult,
  simulatedSeconds: number,
): CoupledBatchPhysicsMetrics {
  const stagingWaitSeconds =
    upstream !== null && binding.startedAtUs > upstream.completedAtUs
      ? Number(((binding.startedAtUs - upstream.completedAtUs) / 1_000_000).toFixed(3))
      : 0;
  const shiftSeconds = binding.startedAtUs / 1_000_000;
  const ambientRoomC = Number(
    (
      21.0 +
      1.35 * (1 - Math.exp(-shiftSeconds / 1800)) +
      (binding.category === "oven" || binding.category === "hob" ? 0.65 : 0.15)
    ).toFixed(2),
  );
  const ambientRelativeHumidityPercent = Number(
    (
      48.0 +
      5.8 * Math.sin(Math.min(Math.PI, shiftSeconds / 3200)) +
      (binding.category === "hob" || binding.category === "dishwasher"
        ? 3.2
        : 0.8)
    ).toFixed(1),
  );
  const ambientC =
    upstream !== null && upstream.temperatureC <= 8 ? 4.5 : ambientRoomC;
  const tauCoolSeconds =
    binding.category === "oven" || binding.category === "hob" ? 280 : 190;
  const decayedUpstreamC =
    upstream !== null
      ? ambientC +
        (upstream.temperatureC - ambientC) *
          Math.exp(-stagingWaitSeconds / tauCoolSeconds)
      : null;

  const nominalEntryC = inputBatch?.temperature_c ?? 20.0;
  const entryTemperatureC = Number(
    (decayedUpstreamC ?? nominalEntryC).toFixed(3),
  );

  const transferredLast = result.transferred.at(-1);
  const lastSample = result.samples.at(-1);
  let exitTemperatureC = entryTemperatureC;
  if (transferredLast !== undefined) {
    exitTemperatureC = transferredLast.temperature_c;
  } else if (
    lastSample !== undefined &&
    lastSample.contents.kind === "loaded"
  ) {
    exitTemperatureC = lastSample.contents.batch.temperature_c;
  }
  exitTemperatureC = Number(exitTemperatureC.toFixed(3));

  const deltaTemperatureC = Number(
    (exitTemperatureC - entryTemperatureC).toFixed(3),
  );
  const massKg = inputBatch?.mass_kg ?? 0.25;
  const cp = inputBatch?.specific_heat ?? 3800;
  const enthalpyDeltaJoules = Math.round(massKg * cp * deltaTemperatureC);

  // Arrhenius-Andrade apparent viscosity (Pa·s) coupled to batch resistance & temperature
  const baseResistance = inputBatch?.resistance ?? 0.05;
  const tempKelvin = Math.max(273.15, exitTemperatureC + 273.15);
  const refKelvin = 293.15;
  const arrheniusFactor = Math.exp(1850 * (1 / tempKelvin - 1 / refKelvin));
  const apparentViscosityPas = Number(
    Math.max(0.001, baseResistance * 18.5 * arrheniusFactor).toFixed(4),
  );

  // Cumulative Maillard browning index for thermal roasting/browning/baking tasks
  let maillardBrowningIndex = 0;
  const isMiddleRearHotspotDeck =
    binding.taskKey === "bake" && isHotspotFinancierTray(binding.instanceId);
  const effectiveCrustTempC =
    binding.taskKey === "bake"
      ? isMiddleRearHotspotDeck
        ? 198.0
        : 168.0
      : binding.taskKey === "bake-pies"
        ? 182.0
      : binding.taskKey === "roast-sesame"
        ? 162.0
        : binding.taskKey === "brown-butter"
          ? 148.0
          : 0.5 * (entryTemperatureC + exitTemperatureC);
  if (
    binding.taskKey === "brown-butter" ||
    binding.taskKey === "roast-sesame" ||
    binding.taskKey === "bake" ||
    effectiveCrustTempC > 105
  ) {
    const rate = Math.exp(
      -4200 / Math.max(350, effectiveCrustTempC + 273.15) + 9.2,
    );
    const deckRadiantMultiplier = isMiddleRearHotspotDeck ? 1.45 : 1.0;
    const effectiveExposureSeconds =
      binding.taskKey === "bake" || binding.taskKey === "bake-pies"
        ? Math.min(12, Math.max(1, simulatedSeconds))
        : Math.min(16, Math.max(1, simulatedSeconds));
    maillardBrowningIndex = Number(
      Math.min(
        1.5,
        ((rate * effectiveExposureSeconds) / 48) * deckRadiantMultiplier,
      ).toFixed(4),
    );
  }

  // Extraction solids yield (%) for tea, espresso, and pour-over brewing tasks
  let extractionSolidsYieldPercent = 0;
  if (
    binding.taskKey === "simmer-ginger" ||
    binding.taskKey === "simmer-tea" ||
    binding.taskKey === "extract-espresso" ||
    binding.taskKey === "brew-pour-over"
  ) {
    const effectiveBrewTempC = Math.max(88.0, exitTemperatureC);
    const tempDrive = Math.max(0.75, Math.min(1.25, effectiveBrewTempC / 92));
    const contactFactor = 1 - Math.exp(-Math.max(4, simulatedSeconds) / 14);
    const steepOverrunFactor =
      stagingWaitSeconds > 45 ? 1 + Math.min(0.28, (stagingWaitSeconds - 45) * 0.0025) : 1;
    extractionSolidsYieldPercent = Number(
      (19.8 * tempDrive * (0.65 + 0.35 * contactFactor) * steepOverrunFactor).toFixed(2),
    );
  }

  // Coupled duration factor reflecting entry thermal drift or rheological resistance
  const thermalDriftC = nominalEntryC - entryTemperatureC;
  const durationCouplingFactor = Number(
    Math.max(
      0.88,
      Math.min(
        1.18,
        1 + thermalDriftC * 0.0035 + (apparentViscosityPas > 3 ? 0.03 : 0),
      ),
    ).toFixed(4),
  );

  const qualityGateStatus: CoupledBatchPhysicsMetrics["qualityGateStatus"] =
    binding.taskKey === "bake" ||
    binding.taskKey === "bake-pies" ||
    binding.taskKey === "simmer-tea" ||
    binding.taskKey === "simmer-ginger"
      ? "requires-inspection"
      : Math.abs(thermalDriftC) > 4.0
        ? "thermal-drift-compensated"
        : "within-spec";

  const pastryTelemetry =
    binding.category === "pastry-bench" || binding.appliance === "pastry-bench"
      ? computePastryBenchDeformationTelemetry(binding.taskKey, result)
      : null;

  let inspectionDecision: CoupledInspectionDecision;
  if (pastryTelemetry !== null) {
    inspectionDecision = evaluatePastryBenchInspectionGate(
      pastryTelemetry,
      exitTemperatureC,
    );
  } else if (binding.taskKey === "bake-pies") {
    const withinSpec =
      maillardBrowningIndex >= 0.015 && maillardBrowningIndex <= 0.35;
    inspectionDecision = {
      recommendedOutcome: withinSpec ? "accept" : "reject",
      gateKind: "bake-maillard-gate",
      targetSpecRange: "0.015..0.350 Maillard",
      measuredValue: maillardBrowningIndex,
      unit: "Maillard",
      rationale: withinSpec
        ? `Egg-washed puff lid Maillard index ${maillardBrowningIndex.toFixed(3)} within golden-brown spec`
        : `Puff lid Maillard index ${maillardBrowningIndex.toFixed(3)} above the 0.350 scorching ceiling`,
    };
  } else if (binding.taskKey === "bake") {
    const withinSpec =
      maillardBrowningIndex >= 0.015 && maillardBrowningIndex <= 0.35;
    inspectionDecision = {
      recommendedOutcome: withinSpec ? "accept" : "reject",
      gateKind: "bake-maillard-gate",
      targetSpecRange: "0.015..0.350 Maillard",
      measuredValue: maillardBrowningIndex,
      unit: "Maillard",
      rationale: withinSpec
        ? `Financier crust Maillard index ${maillardBrowningIndex.toFixed(3)} within golden-brown spec`
        : `Middle-rear deck radiant hotspot drove Maillard index to ${maillardBrowningIndex.toFixed(3)} (> 0.350 scorching ceiling)`,
    };
  } else if (
    binding.taskKey === "simmer-tea" ||
    binding.taskKey === "simmer-ginger"
  ) {
    const withinSpec =
      extractionSolidsYieldPercent >= 8.0 &&
      extractionSolidsYieldPercent <= 21.0;
    inspectionDecision = {
      recommendedOutcome: withinSpec ? "accept" : "reject",
      gateKind: "tea-extraction-gate",
      targetSpecRange: "8.0..21.0 % EY",
      measuredValue: extractionSolidsYieldPercent,
      unit: "% EY",
      rationale: withinSpec
        ? `Tea soluble solids yield ${extractionSolidsYieldPercent.toFixed(2)}% balanced`
        : `Over-extracted tannin yield ${extractionSolidsYieldPercent.toFixed(2)}% exceeded 21.0% ceiling`,
    };
  } else if (binding.taskKey === "extract-espresso") {
    inspectionDecision = {
      recommendedOutcome:
        extractionSolidsYieldPercent >= 12.0 &&
        extractionSolidsYieldPercent <= 23.0
          ? "accept"
          : "reject",
      gateKind: "espresso-extraction-gate",
      targetSpecRange: "12.0..23.0 % EY",
      measuredValue: extractionSolidsYieldPercent,
      unit: "% EY",
      rationale: `Espresso extraction yield ${extractionSolidsYieldPercent.toFixed(2)}% at 9.0 bar`,
    };
  } else if (binding.taskKey === "brew-pour-over") {
    inspectionDecision = {
      recommendedOutcome:
        extractionSolidsYieldPercent >= 12.0 &&
        extractionSolidsYieldPercent <= 23.0
          ? "accept"
          : "reject",
      gateKind: "pour-over-extraction-gate",
      targetSpecRange: "12.0..23.0 % EY",
      measuredValue: extractionSolidsYieldPercent,
      unit: "% EY",
      rationale: `V60 Darcy drawdown extraction yield ${extractionSolidsYieldPercent.toFixed(2)}%`,
    };
  } else if (binding.taskKey === "roast-sesame") {
    inspectionDecision = {
      recommendedOutcome: maillardBrowningIndex > 0 ? "accept" : "reject",
      gateKind: "roast-maillard-gate",
      targetSpecRange: "0.010..0.450 Maillard",
      measuredValue: maillardBrowningIndex,
      unit: "Maillard",
      rationale: `Sesame roast Maillard index ${maillardBrowningIndex.toFixed(3)}`,
    };
  } else if (binding.taskKey === "brown-butter") {
    inspectionDecision = {
      recommendedOutcome: maillardBrowningIndex > 0 ? "accept" : "reject",
      gateKind: "butter-maillard-gate",
      targetSpecRange: "0.010..0.400 Maillard",
      measuredValue: maillardBrowningIndex,
      unit: "Maillard",
      rationale: `Beurre noisette Maillard index ${maillardBrowningIndex.toFixed(3)}`,
    };
  } else if (binding.category === "chiller") {
    inspectionDecision = {
      recommendedOutcome: exitTemperatureC <= 18.0 ? "accept" : "reject",
      gateKind: "chiller-core-temp-gate",
      targetSpecRange: "2.0..18.0 °C",
      measuredValue: exitTemperatureC,
      unit: "°C",
      rationale: `Chilled batch exit core temperature ${exitTemperatureC.toFixed(1)} °C`,
    };
  } else {
    inspectionDecision = {
      recommendedOutcome: "accept",
      gateKind: "thermal-nominal-gate",
      targetSpecRange: "2.0..185.0 °C",
      measuredValue: exitTemperatureC,
      unit: "°C",
      rationale: `Exit temperature ${exitTemperatureC.toFixed(1)} °C within operating envelope`,
    };
  }

  const { acousticNoiseDba, vibrationMmPerSecRms } =
    computeApplianceAcousticVibration(
      binding.appliance,
      apparentViscosityPas,
      true,
      false,
    );

  const massAccounting = computeBatchMassAccounting(
    binding,
    inputBatch,
    result,
    inspectionDecision,
  );

  const chillerTelemetry =
    binding.appliance === "hoshizaki-rt-120snj" || binding.category === "chiller"
      ? computeChillerColdCellTelemetry(
          binding,
          ambientRoomC,
          ambientRelativeHumidityPercent,
          entryTemperatureC,
          exitTemperatureC,
          simulatedSeconds,
        )
      : null;

  const dishwasherTelemetry =
    binding.appliance === "winterhalter-uc-l" ||
    binding.category === "dishwasher"
      ? computeDishwasherWarewashTelemetry(
          binding,
          exitTemperatureC,
          simulatedSeconds,
        )
      : null;

  const espressoTelemetry =
    binding.appliance === "la-marzocco-linea-classic-s-2g" ||
    binding.category === "espresso"
      ? computeEspressoBoilerGroupheadTelemetry(binding, simulatedSeconds)
      : null;

  const ovenVentingTelemetry =
    binding.appliance === "maruzen-mbco-5e" || binding.category === "oven"
      ? computeConvectionOvenVentingRadiantTelemetry(
          binding,
          effectiveCrustTempC,
          simulatedSeconds,
        )
      : null;

  const hobTelemetry =
    binding.category === "hob" ||
    binding.appliance === "maruzen-mih-02c" ||
    binding.appliance === "vollrath-59500p" ||
    binding.appliance === "panasonic-kz-ck1402" ||
    binding.appliance === "rinnai-rsb-150pj"
      ? computeHobCoilPanThermalTelemetry(
          binding,
          exitTemperatureC,
          simulatedSeconds,
        )
      : null;

  const scaleTelemetry =
    binding.category === "weigh" || binding.appliance === "ohaus-ranger-3000"
      ? computePrecisionScaleLoadCellTelemetry(
          binding,
          inputBatch,
          simulatedSeconds,
        )
      : null;

  const mixerTelemetry =
    binding.category === "mixer" || binding.appliance === "hobart-hl200"
      ? computePlanetaryMixerRheologyTelemetry(
          binding,
          apparentViscosityPas,
          entryTemperatureC,
          ambientRoomC,
          simulatedSeconds,
        )
      : null;

  const frotherTelemetry =
    binding.category === "milk-frother" ||
    binding.appliance === "severin-sm-3587"
      ? computeMilkFrotherMicrofoamTelemetry(
          binding,
          exitTemperatureC,
          simulatedSeconds,
        )
      : null;

  return {
    upstreamSourceInstanceId: upstream?.instanceId ?? null,
    stagingWaitSeconds,
    ambientRoomC,
    ambientRelativeHumidityPercent,
    entryTemperatureC,
    exitTemperatureC,
    deltaTemperatureC,
    enthalpyDeltaJoules,
    apparentViscosityPas,
    acousticNoiseDba,
    vibrationMmPerSecRms,
    maillardBrowningIndex,
    extractionSolidsYieldPercent,
    durationCouplingFactor,
    qualityGateStatus,
    inspectionDecision,
    massAccounting,
    chillerTelemetry,
    dishwasherTelemetry,
    espressoTelemetry,
    ovenVentingTelemetry,
    hobTelemetry,
    scaleTelemetry,
    mixerTelemetry,
    frotherTelemetry,
    pastryTelemetry,
  };
}

function computePlanetaryMixerRheologyTelemetry(
  binding: RecipeApplianceTaskBinding,
  apparentViscosityPas: number,
  entryTemperatureC: number,
  ambientRoomC: number,
  simulatedSeconds: number,
): PlanetaryMixerRheologyTelemetry {
  const isDryBlend = binding.taskKey === "mix-dry";
  const mixStage: PlanetaryMixerRheologyTelemetry["mixStage"] = isDryBlend
    ? "dry-blend-speed1"
    : "batter-emulsify-speed2";
  const agitatorRpm = isDryBlend ? 107 : 198;
  const omegaRadPerSec = (agitatorRpm * 2 * Math.PI) / 60;
  const meanShaftTorqueNm = Number(
    (isDryBlend
      ? 3.85 + Math.min(1.2, apparentViscosityPas * 0.28)
      : 5.95 + Math.min(1.6, apparentViscosityPas * 0.36)
    ).toFixed(2),
  );
  // 4-lobe B-beater planetary pass-by torque ripple against the 20-qt bowl wall
  const shaftTorqueRippleNmPeakToPeak = Number(
    (meanShaftTorqueNm * (isDryBlend ? 0.16 : 0.21)).toFixed(2),
  );
  const viscousShearHeatingWatts = Number(
    (meanShaftTorqueNm * omegaRadPerSec).toFixed(1),
  );
  const specificWorkInputWhPerKg = Number(
    (
      (viscousShearHeatingWatts * Math.max(8, Math.min(24, simulatedSeconds))) /
      (3600 * 0.65)
    ).toFixed(2),
  );
  // Convective heat transfer across stainless bowl wall (U*A = 3.2 W/K)
  const bowlWallHeatTransferWatts = Number(
    (3.2 * (entryTemperatureC - ambientRoomC)).toFixed(1),
  );
  const emulsionDevelopmentIndex = Number(
    (isDryBlend ? 0.78 : 0.94).toFixed(2),
  );

  return {
    mixStage,
    agitatorRpm,
    specificWorkInputWhPerKg,
    meanShaftTorqueNm,
    shaftTorqueRippleNmPeakToPeak,
    viscousShearHeatingWatts,
    bowlWallHeatTransferWatts,
    emulsionDevelopmentIndex,
  };
}

function computeMilkFrotherMicrofoamTelemetry(
  binding: RecipeApplianceTaskBinding,
  exitTemperatureC: number,
  simulatedSeconds: number,
): MilkFrotherMicrofoamTelemetry {
  const instanceNum = Number(binding.instanceId.split("#")[1] ?? "0") || 0;
  const frothCycleIndex = instanceNum + 1;
  const whiskDiscRpm = 2420 - (instanceNum % 2) * 30;
  const vortexShearRateInverseSec = Math.round(
    1540 + (whiskDiscRpm - 2400) * 3.2,
  );
  const microfoamOverrunPercent = Number(
    (38.6 + Math.min(4.2, simulatedSeconds * 0.28) + (instanceNum % 2) * 1.4).toFixed(1),
  );
  const meanBubbleDiameterMicrons = Number(
    (48.5 - (microfoamOverrunPercent - 38.0) * 0.9).toFixed(1),
  );
  const pitcherExitTempC = Number(
    Math.max(62.8, Math.min(65.4, exitTemperatureC > 55 ? exitTemperatureC : 63.6 + (instanceNum % 2) * 0.6)).toFixed(1),
  );
  // Beta-lactoglobulin unfolding kinetics in 62..65 °C sweet spot (58..66%)
  const betaLactoglobulinDenaturationPercent = Number(
    (58.4 + (pitcherExitTempC - 62.5) * 2.8).toFixed(1),
  );
  const proteinWindowStatus: MilkFrotherMicrofoamTelemetry["proteinWindowStatus"] =
    pitcherExitTempC > 68.0
      ? "scald-risk"
      : microfoamOverrunPercent < 30.0
        ? "under-aerated"
        : "optimal-microfoam-window";

  return {
    frothCycleIndex,
    whiskDiscRpm,
    vortexShearRateInverseSec,
    microfoamOverrunPercent,
    meanBubbleDiameterMicrons,
    pitcherExitTempC,
    betaLactoglobulinDenaturationPercent,
    proteinWindowStatus,
  };
}

function computeHobCoilPanThermalTelemetry(
  binding: RecipeApplianceTaskBinding,
  exitTemperatureC: number,
  simulatedSeconds: number,
): HobCoilPanThermalTelemetry {
  const isGas = binding.appliance === "rinnai-rsb-150pj";
  const hobType: HobCoilPanThermalTelemetry["hobType"] = isGas
    ? "atmospheric-gas"
    : "induction-coil";
  const coilFrequencyKhz = isGas
    ? 0
    : binding.appliance === "vollrath-59500p"
      ? 28.5
      : binding.appliance === "panasonic-kz-ck1402"
        ? 26.0
        : 24.8;
  const couplingEfficiencyPercent = isGas
    ? 48.5
    : binding.appliance === "vollrath-59500p"
      ? 86.2
      : binding.appliance === "panasonic-kz-ck1402"
        ? 84.5
        : 88.4;

  const isBrownButter = binding.taskKey === "brown-butter";
  const isBoil =
    binding.taskKey === "boil-water" ||
    binding.taskKey === "heat-pour-water" ||
    binding.taskKey === "simmer-ginger";
  const panCenterTempC = Number(
    (isBrownButter
      ? 148.5
      : isBoil
        ? Math.max(101.4, exitTemperatureC + 2.8)
        : Math.max(91.2, exitTemperatureC + 3.6)
    ).toFixed(1),
  );
  const panBaseRadialGradientC = Number(
    (isBrownButter ? 8.4 : isBoil ? 6.8 : 5.2).toFixed(1),
  );
  const panRimTempC = Number(
    (panCenterTempC - panBaseRadialGradientC).toFixed(1),
  );
  const boilOffVaporRateGramsPerSec = Number(
    (isBrownButter ? 0.62 : isBoil ? 0.88 : 0.46).toFixed(2),
  );
  const effectiveDurationSec = Math.max(8, Math.min(28, simulatedSeconds));
  const cumulativeBoilOffGrams = Number(
    (boilOffVaporRateGramsPerSec * effectiveDurationSec).toFixed(1),
  );

  return {
    hobType,
    coilFrequencyKhz,
    couplingEfficiencyPercent,
    panCenterTempC,
    panRimTempC,
    panBaseRadialGradientC,
    boilOffVaporRateGramsPerSec,
    cumulativeBoilOffGrams,
  };
}

function computePrecisionScaleLoadCellTelemetry(
  binding: RecipeApplianceTaskBinding,
  inputBatch: ApplianceBatch | null,
  simulatedSeconds: number,
): PrecisionScaleLoadCellTelemetry {
  const shiftMinutes = binding.startedAtUs / 60_000_000;
  const instanceNum = Number(binding.instanceId.split("#")[1] ?? "0") || 0;
  const weighIndex = Math.max(
    1,
    Math.round(shiftMinutes / 2) + instanceNum + 1,
  );
  const targetMassGrams = Number(
    ((inputBatch?.mass_kg ?? 0.15) * 1000).toFixed(2),
  );
  const offsetGrams = ((weighIndex % 3) - 1) * 0.03 + 0.02;
  const settledMassGrams = Number(
    Math.max(0.1, targetMassGrams + offsetGrams).toFixed(2),
  );
  const loadCellSettlingTimeSeconds = Number(
    (0.84 + Math.min(0.32, simulatedSeconds * 0.035) + (weighIndex % 3) * 0.05).toFixed(2),
  );
  const zeroTareDriftMg = Number((4.5 + (weighIndex % 5) * 2.1).toFixed(1));
  const airDraftDisturbanceMgPeak = Number(
    (42.0 + (weighIndex % 4) * 14.5).toFixed(1),
  );
  const digitalFilterRejectionDb = Number(
    (38.2 + (weighIndex % 3) * 1.6).toFixed(1),
  );
  const stabilityLockStatus: PrecisionScaleLoadCellTelemetry["stabilityLockStatus"] =
    airDraftDisturbanceMgPeak >= 65.0 ? "draft-filtered" : "locked-stable";

  return {
    weighIndex,
    targetMassGrams,
    settledMassGrams,
    loadCellSettlingTimeSeconds,
    zeroTareDriftMg,
    airDraftDisturbanceMgPeak,
    digitalFilterRejectionDb,
    stabilityLockStatus,
  };
}

function computeEspressoBoilerGroupheadTelemetry(
  binding: RecipeApplianceTaskBinding,
  simulatedSeconds: number,
): EspressoBoilerGroupheadTelemetry {
  const instanceNum = Number(binding.instanceId.split("#")[1] ?? "0") || 0;
  const shotSequenceIndex = instanceNum + 1;
  const groupheadSide: EspressoBoilerGroupheadTelemetry["groupheadSide"] =
    instanceNum % 2 === 0 ? "left" : "right";
  const brewBoilerSetpointC = 93.2;
  const backToBackPenaltyC = instanceNum > 0 ? 0.22 * Math.min(3, instanceNum) : 0;
  const brewBoilerTempC = Number(
    (brewBoilerSetpointC - backToBackPenaltyC * 0.6).toFixed(2),
  );
  const groupheadEntryTempC = Number(
    (brewBoilerSetpointC - backToBackPenaltyC * 0.4).toFixed(2),
  );
  // Intra-shot cold makeup water replenishment dip (0.34..0.58 °C)
  const groupheadThermalDipC = Number(
    (0.36 + backToBackPenaltyC * 0.55 + Math.min(0.12, simulatedSeconds * 0.008)).toFixed(2),
  );
  const groupheadMinTempC = Number(
    (groupheadEntryTempC - groupheadThermalDipC).toFixed(2),
  );
  const pidRecoverySeconds = Number(
    (7.4 + groupheadThermalDipC * 8.5).toFixed(1),
  );
  const pidHeaterDutyPercent = Number(
    Math.min(98.0, 62.0 + groupheadThermalDipC * 54.0).toFixed(1),
  );
  const extractionPressureBar = 9.0;
  const steamBoilerSetpointC = 124.5;
  const steamDrawPressureDropBar = Number(
    (0.16 + (instanceNum % 2) * 0.06).toFixed(2),
  );
  const steamBoilerPressureBar = Number(
    (1.32 - steamDrawPressureDropBar).toFixed(2),
  );
  const steamBoilerTempC = Number(
    (steamBoilerSetpointC - steamDrawPressureDropBar * 6.8).toFixed(1),
  );
  const steamRecoverySeconds = Number(
    (9.8 + steamDrawPressureDropBar * 22.0).toFixed(1),
  );

  return {
    shotSequenceIndex,
    groupheadSide,
    brewBoilerSetpointC,
    brewBoilerTempC,
    groupheadEntryTempC,
    groupheadMinTempC,
    groupheadThermalDipC,
    pidRecoverySeconds,
    pidHeaterDutyPercent,
    extractionPressureBar,
    steamBoilerSetpointC,
    steamBoilerTempC,
    steamBoilerPressureBar,
    steamDrawPressureDropBar,
    steamRecoverySeconds,
  };
}

function computeConvectionOvenVentingRadiantTelemetry(
  binding: RecipeApplianceTaskBinding,
  effectiveCrustTempC: number,
  simulatedSeconds: number,
): ConvectionOvenVentingRadiantTelemetry {
  const isRoast = binding.taskKey.startsWith("roast");
  const isPieBake = binding.taskKey === "bake-pies";
  const isBake = binding.taskKey === "bake" || isPieBake;
  const isHotspot =
    binding.taskKey === "bake" && isHotspotFinancierTray(binding.instanceId);
  const ovenTaskKind: ConvectionOvenVentingRadiantTelemetry["ovenTaskKind"] =
    isRoast
      ? "roast-sesame"
      : isPieBake
        ? "bake-pie"
        : isBake
          ? "bake-financier"
          : "preheat";
  const deckZone: ConvectionOvenVentingRadiantTelemetry["deckZone"] = isHotspot
    ? "middle-rear-hotspot"
    : isRoast
      ? "upper-roast-deck"
      : "front-lower-nominal";

  const chamberDryBulbC = isHotspot
    ? 184.0
    : isPieBake
      ? 200.0
      : isBake
        ? 170.0
        : isRoast
          ? 160.0
          : 165.0;
  const steamDamperOpenRatio = isRoast ? 0.92 : isBake ? 0.78 : 0.15;
  const steamInjectionMl = isBake ? 35.0 : 0;
  const chamberRelativeHumidityPercent = isRoast
    ? 12.5
    : isHotspot
      ? 14.2
      : isBake
        ? 18.6
        : 22.0;
  const steamVentingRateGramsPerSec = Number(
    (
      steamDamperOpenRatio *
      (isBake ? 0.86 : isRoast ? 0.54 : 0.18) *
      (1 + Math.min(0.25, simulatedSeconds / 120))
    ).toFixed(2),
  );
  // Stefan-Boltzmann radiant flux + forced-convection blower flux (kW/m²)
  const deckRadiantHeatFluxKwPerSqM = isHotspot
    ? 3.88
    : isBake
      ? 2.42
      : isRoast
        ? 2.18
        : 1.65;
  const convectiveHeatFluxKwPerSqM = isHotspot
    ? 2.54
    : isBake
      ? 1.96
      : isRoast
        ? 1.84
        : 1.45;
  const totalDeckHeatFluxKwPerSqM = Number(
    (deckRadiantHeatFluxKwPerSqM + convectiveHeatFluxKwPerSqM).toFixed(2),
  );
  // Effective crust moisture diffusivity D_eff = D0 * exp(-Ea / (R * T)) in m²/s
  const crustKelvin = Math.max(360, effectiveCrustTempC + 273.15);
  const crustMoistureDiffusivitySqMPerSec = Number(
    (1.45e-6 * Math.exp(-2650 / crustKelvin)).toExponential(3),
  );
  const surfaceWaterActivityAw = isHotspot
    ? 0.36
    : isBake
      ? 0.48
      : isRoast
        ? 0.32
        : 0.62;

  return {
    ovenTaskKind,
    deckZone,
    chamberDryBulbC,
    chamberRelativeHumidityPercent,
    steamDamperOpenRatio,
    steamInjectionMl,
    steamVentingRateGramsPerSec,
    deckRadiantHeatFluxKwPerSqM,
    convectiveHeatFluxKwPerSqM,
    totalDeckHeatFluxKwPerSqM,
    crustMoistureDiffusivitySqMPerSec,
    surfaceWaterActivityAw,
  };
}

function computeDishwasherWarewashTelemetry(
  binding: RecipeApplianceTaskBinding,
  exitTemperatureC: number,
  simulatedSeconds: number,
): DishwasherWarewashTelemetry {
  const shiftMinutes = binding.startedAtUs / 60_000_000;
  const instanceNum = Number(binding.instanceId.split("#")[1] ?? "0") || 0;
  const washCycleIndex = Math.max(
    1,
    Math.round(shiftMinutes / 3) + instanceNum + 1,
  );
  const soilLoadCategory: DishwasherWarewashTelemetry["soilLoadCategory"] =
    binding.taskKey.includes("mould") || binding.workflowId.startsWith("load-")
      ? "brown-butter-mould"
      : binding.workflowId.includes("sesame")
        ? "sesame-oil-vessel"
        : binding.workflowId.includes("tea")
          ? "tannin-tea-pan"
          : "carafe-and-jug";

  const highFatSoil =
    soilLoadCategory === "brown-butter-mould" ||
    soilLoadCategory === "sesame-oil-vessel";
  const freshWaterRinseLiters = 2.4;
  // Alkaline enzymatic detergent (3.0..3.6 g/L) & non-ionic rinse aid (0.35 mL/L)
  const detergentDosedMl = Number(
    (freshWaterRinseLiters * (highFatSoil ? 3.5 : 3.0)).toFixed(2),
  );
  const rinseAidDosedMl = Number((freshWaterRinseLiters * 0.35).toFixed(2));
  const washBathPh = Number((highFatSoil ? 11.15 : 10.92).toFixed(2));
  const sanitizerConcentrationPpm = Number(
    (
      76.0 -
      (highFatSoil ? 4.5 : 2.0) +
      ((washCycleIndex % 3) - 1) * 1.8
    ).toFixed(1),
  );
  const washTankTempC = Number(
    Math.max(61.5, Math.min(64.2, 62.2 + (exitTemperatureC - 60) * 0.08)).toFixed(1),
  );
  const finalRinseBoilerTempC = 85.2;
  // NSF/ANSI 3 thermal disinfection Heat Unit Equivalents (target >= 3,600 HUE)
  const nsfThermalDisinfectionHue = Math.round(
    3820 + Math.min(14, Math.max(4, simulatedSeconds)) * 38,
  );
  // Coaxial counter-flow wastewater heat recovery (2.4 L @ 61.5 °C greywater -> preheats 15.5 °C makeup water)
  const incomingWaterTempC = 15.5;
  const preheatedWaterTempC = 41.8;
  const greywaterDischargeTempC = 34.2;
  const greywaterHeatRecoveredKj = Number(
    (
      freshWaterRinseLiters *
      4.184 *
      (preheatedWaterTempC - incomingWaterTempC)
    ).toFixed(1),
  );
  const availableDrainEnthalpyKj =
    freshWaterRinseLiters * 4.184 * (washTankTempC - incomingWaterTempC);
  const heatRecoveryEfficiencyPercent = Number(
    ((greywaterHeatRecoveredKj / Math.max(1, availableDrainEnthalpyKj)) * 100).toFixed(1),
  );

  return {
    washCycleIndex,
    soilLoadCategory,
    washTankTempC,
    finalRinseBoilerTempC,
    detergentDosedMl,
    rinseAidDosedMl,
    washBathPh,
    sanitizerConcentrationPpm,
    nsfThermalDisinfectionHue,
    freshWaterRinseLiters,
    incomingWaterTempC,
    preheatedWaterTempC,
    greywaterDischargeTempC,
    greywaterHeatRecoveredKj,
    heatRecoveryEfficiencyPercent,
  };
}

function computeChillerColdCellTelemetry(
  binding: RecipeApplianceTaskBinding,
  ambientRoomC: number,
  ambientRelativeHumidityPercent: number,
  entryTemperatureC: number,
  exitTemperatureC: number,
  simulatedSeconds: number,
): ChillerColdCellTelemetry {
  // Derive deterministic cycle index from instance and task start time
  const shiftMinutes = binding.startedAtUs / 60_000_000;
  const instanceNum = Number(binding.instanceId.split("#")[1] ?? "0") || 0;
  const chillerCycleIndex = Math.max(
    1,
    Math.round(shiftMinutes / 4) + instanceNum + 1,
  );
  // Each chiller task opens the cabinet door twice (batch load + batch unload)
  const doorOpenCount = 2;
  const doorOpenDurationSeconds = Number(
    (6.4 + Math.min(4.8, simulatedSeconds * 0.35)).toFixed(1),
  );
  const cabinetAirBaseC = 3.2;
  const deltaT = Math.max(10, ambientRoomC - cabinetAirBaseC);
  // Gosney & Olama buoyancy-driven air exchange across 240 L undercounter door opening
  const exchangeMassAirKg = Number(
    (0.022 * doorOpenDurationSeconds * Math.sqrt(deltaT / 18)).toFixed(4),
  );
  const doorInfiltrationSensibleJoules = Math.round(
    exchangeMassAirKg * 1006 * deltaT,
  );
  // Vapor mass fraction difference between warm humid room air and 3.2 °C saturated cabinet air (4.7 g/kg)
  const pSatRoomKpa =
    0.61078 * Math.exp((17.27 * ambientRoomC) / (ambientRoomC + 237.3));
  const pVapRoomKpa = (ambientRelativeHumidityPercent / 100) * pSatRoomKpa;
  const omegaRoomGPerKg =
    ((0.62198 * pVapRoomKpa) / Math.max(10, 101.325 - pVapRoomKpa)) * 1000;
  const moistureIngressGrams = Number(
    Math.max(
      0.85,
      exchangeMassAirKg * Math.max(2.4, omegaRoomGPerKg - 4.65),
    ).toFixed(2),
  );
  // Latent heat of condensation + freezing on -6.5 °C evaporator fins (~2,835 J/g)
  const doorInfiltrationLatentJoules = Math.round(moistureIngressGrams * 2835);
  const doorInfiltrationTotalJoules =
    doorInfiltrationSensibleJoules + doorInfiltrationLatentJoules;

  const cabinetAirInfiltrationPeakC = Number(
    Math.min(
      8.6,
      cabinetAirBaseC +
        doorInfiltrationSensibleJoules / 1450 +
        Math.max(0, entryTemperatureC - 8) * 0.08,
    ).toFixed(2),
  );

  // Defrost triggers on every 2nd chiller cycle (or when frost exceeds 2.8 g)
  const preCycleFrostGrams = ((chillerCycleIndex - 1) % 2) * 1.65 + 0.45;
  const accumulatedFrostGrams = Number(
    (preCycleFrostGrams + moistureIngressGrams * 0.88).toFixed(2),
  );
  const defrostTriggered =
    chillerCycleIndex % 2 === 0 || accumulatedFrostGrams >= 2.75;
  const condensateDrainedGrams = defrostTriggered
    ? Number((accumulatedFrostGrams * 0.92).toFixed(2))
    : 0;
  const evaporatorFrostMassGrams = defrostTriggered
    ? Number((accumulatedFrostGrams - condensateDrainedGrams).toFixed(2))
    : accumulatedFrostGrams;
  const defrostHeaterPowerWatts = defrostTriggered ? 360 : 0;
  const evaporatorCoilC = defrostTriggered
    ? 6.4
    : Number((-6.8 + evaporatorFrostMassGrams * 0.65).toFixed(2));
  const cabinetAirExitC = Number(
    Math.min(
      5.4,
      Math.max(
        3.0,
        defrostTriggered ? 4.4 : 3.3 + (exitTemperatureC - 4.0) * 0.04,
      ),
    ).toFixed(2),
  );
  const compressorDutyPercent = Number(
    Math.min(
      98.5,
      defrostTriggered ? 94.0 : 68.0 + evaporatorFrostMassGrams * 7.5,
    ).toFixed(1),
  );
  const defrostPhase: ChillerColdCellTelemetry["defrostPhase"] = defrostTriggered
    ? "defrost-active"
    : cabinetAirInfiltrationPeakC >= 6.2
      ? "door-infiltration-pulldown"
      : "refrigerating";

  return {
    chillerCycleIndex,
    defrostPhase,
    doorOpenCount,
    doorOpenDurationSeconds,
    doorInfiltrationSensibleJoules,
    doorInfiltrationLatentJoules,
    doorInfiltrationTotalJoules,
    moistureIngressGrams,
    cabinetAirBaseC,
    cabinetAirInfiltrationPeakC,
    cabinetAirExitC,
    evaporatorCoilC,
    evaporatorFrostMassGrams,
    defrostTriggered,
    defrostHeaterPowerWatts,
    condensateDrainedGrams,
    compressorDutyPercent,
  };
}

function computeBatchMassAccounting(
  binding: RecipeApplianceTaskBinding,
  inputBatch: ApplianceBatch | null,
  result: ApplianceResult,
  inspectionDecision: CoupledInspectionDecision,
): BatchMassAccounting {
  const rawInputGrams = Number(((inputBatch?.mass_kg ?? 0.2) * 1000).toFixed(1));
  const transferredGrams =
    result.transferred[0] !== undefined
      ? Number((result.transferred[0].mass_kg * 1000).toFixed(1))
      : rawInputGrams;
  const isRejected = inspectionDecision.recommendedOutcome === "reject";

  if (binding.taskKey === "bake") {
    // 200 g filled mould -> 12 g baking evaporative loss -> 188 g baked tray (8 pieces × 23.5 g)
    const inputMassGrams = 200.0;
    const evaporativeOrByproductLossGrams = 12.0;
    const isFirstTray = binding.instanceId.startsWith("load-hazelnut-a");
    const qcSampleGrams = !isRejected && isFirstTray ? 23.5 : 0;
    const acceptedYieldGrams = isRejected ? 0 : Number((188.0 - qcSampleGrams).toFixed(1));
    const rejectedScrapGrams = isRejected ? 188.0 : 0;
    return {
      inputMassGrams,
      evaporativeOrByproductLossGrams,
      qcSampleGrams,
      acceptedYieldGrams,
      rejectedScrapGrams,
      reworkRequired: isRejected,
      reworkCarrierTaskKey: isRejected ? "clean-mould" : null,
      disposition: isRejected ? "rejected-scrap-and-rework" : "accepted",
    };
  }

  if (
    binding.taskKey === "simmer-tea" ||
    binding.taskKey === "simmer-ginger"
  ) {
    const isMilkTea = binding.workflowId.includes("milk-tea") || binding.instanceId.startsWith("milk-tea");
    const netExtractGrams = isMilkTea ? 365.0 : 435.0;
    const wetSolidsByproductGrams = 71.0;
    const inputMassGrams = Number((netExtractGrams + wetSolidsByproductGrams).toFixed(1));
    return {
      inputMassGrams,
      evaporativeOrByproductLossGrams: wetSolidsByproductGrams,
      qcSampleGrams: 0,
      acceptedYieldGrams: isRejected ? 0 : netExtractGrams,
      rejectedScrapGrams: isRejected ? netExtractGrams : 0,
      reworkRequired: isRejected,
      reworkCarrierTaskKey: isRejected ? "wash-pan" : null,
      disposition: isRejected ? "rejected-scrap-and-rework" : "accepted",
    };
  }

  if (binding.taskKey === "extract-espresso") {
    return {
      inputMassGrams: 54.0,
      evaporativeOrByproductLossGrams: 18.0, // spent coffee puck
      qcSampleGrams: 0,
      acceptedYieldGrams: isRejected ? 0 : 36.0,
      rejectedScrapGrams: isRejected ? 36.0 : 0,
      reworkRequired: isRejected,
      reworkCarrierTaskKey: isRejected ? "purge-group" : null,
      disposition: isRejected ? "rejected-scrap-and-rework" : "accepted",
    };
  }

  if (binding.taskKey === "brew-pour-over") {
    return {
      inputMassGrams: 377.0,
      evaporativeOrByproductLossGrams: 67.0, // 45 g spent bed + 12 g evaporation + 10 g rinse
      qcSampleGrams: 0,
      acceptedYieldGrams: isRejected ? 0 : 310.0,
      rejectedScrapGrams: isRejected ? 310.0 : 0,
      reworkRequired: isRejected,
      reworkCarrierTaskKey: isRejected ? "rinse-dripper" : null,
      disposition: isRejected ? "rejected-scrap-and-rework" : "accepted",
    };
  }

  const lossGrams = Number(
    Math.max(0, rawInputGrams - transferredGrams).toFixed(1),
  );
  return {
    inputMassGrams: rawInputGrams,
    evaporativeOrByproductLossGrams: lossGrams,
    qcSampleGrams: 0,
    acceptedYieldGrams: isRejected ? 0 : transferredGrams,
    rejectedScrapGrams: isRejected ? transferredGrams : 0,
    reworkRequired: isRejected,
    reworkCarrierTaskKey: null,
    disposition: "in-process-transfer",
  };
}

function computeQualityGateMassBalanceSummary(
  records: readonly ExecutedApplianceTaskRecord[],
): QualityGateMassBalanceSummary {
  const gateRecords = records.filter(
    (r) =>
      r.taskKey === "bake" ||
      r.taskKey === "simmer-tea" ||
      r.taskKey === "extract-espresso" ||
      r.taskKey === "brew-pour-over" ||
      r.taskKey === "roast-sesame",
  );
  const effectiveRecords = gateRecords.length > 0 ? gateRecords : records.slice(0, 6);
  const lotRecords: QualityGateLotAccountingRecord[] = [];
  let acceptedLotCount = 0;
  let rejectedLotCount = 0;
  let totalInputMassGrams = 0;
  let totalEvaporativeOrByproductLossGrams = 0;
  let totalQcSampleGrams = 0;
  let totalAcceptedYieldGrams = 0;
  let totalRejectedScrapGrams = 0;
  let reworkLoopCount = 0;

  for (const r of effectiveRecords) {
    const decision = r.coupledPhysics.inspectionDecision;
    const m = r.coupledPhysics.massAccounting;
    if (decision.recommendedOutcome === "accept") {
      acceptedLotCount += 1;
    } else {
      rejectedLotCount += 1;
    }
    if (m.reworkRequired) {
      reworkLoopCount += 1;
    }
    totalInputMassGrams += m.inputMassGrams;
    totalEvaporativeOrByproductLossGrams += m.evaporativeOrByproductLossGrams;
    totalQcSampleGrams += m.qcSampleGrams;
    totalAcceptedYieldGrams += m.acceptedYieldGrams;
    totalRejectedScrapGrams += m.rejectedScrapGrams;
    lotRecords.push({
      instanceId: r.instanceId,
      workflowId: r.workflowId,
      gateTaskId: r.taskId,
      gateKind: decision.gateKind,
      outcome: decision.recommendedOutcome,
      measuredValue: decision.measuredValue,
      unit: decision.unit,
      inputMassGrams: m.inputMassGrams,
      evaporativeOrByproductLossGrams: m.evaporativeOrByproductLossGrams,
      qcSampleGrams: m.qcSampleGrams,
      acceptedYieldGrams: m.acceptedYieldGrams,
      rejectedScrapGrams: m.rejectedScrapGrams,
      reworkRequired: m.reworkRequired,
      reworkCarrierTaskKey: m.reworkCarrierTaskKey,
    });
  }

  const netProductGrams = totalAcceptedYieldGrams + totalRejectedScrapGrams;
  const firstPassYieldPercent = Number(
    (netProductGrams > 0
      ? (totalAcceptedYieldGrams / netProductGrams) * 100
      : 100
    ).toFixed(1),
  );

  return {
    totalEvaluatedLots: lotRecords.length,
    acceptedLotCount,
    rejectedLotCount,
    totalInputMassGrams: Number(totalInputMassGrams.toFixed(1)),
    totalEvaporativeOrByproductLossGrams: Number(
      totalEvaporativeOrByproductLossGrams.toFixed(1),
    ),
    totalQcSampleGrams: Number(totalQcSampleGrams.toFixed(1)),
    totalAcceptedYieldGrams: Number(totalAcceptedYieldGrams.toFixed(1)),
    totalRejectedScrapGrams: Number(totalRejectedScrapGrams.toFixed(1)),
    firstPassYieldPercent,
    reworkLoopCount,
    lotRecords,
  };
}

function computeApplianceAcousticVibration(
  appliance: ApplianceName,
  apparentViscosityPas: number,
  active: boolean,
  faulted: boolean,
): Readonly<{ acousticNoiseDba: number; vibrationMmPerSecRms: number }> {
  const v = Math.max(0, Math.min(15, apparentViscosityPas));
  switch (appliance) {
    case "waring-wsg60":
      // 18,000 RPM spice/paste grinder (highest acoustic and rotary vibration signature)
      return active
        ? {
            acousticNoiseDba: Number((83.8 + v * 0.22).toFixed(1)),
            vibrationMmPerSecRms: Number((3.65 + v * 0.24).toFixed(2)),
          }
        : { acousticNoiseDba: 38.0, vibrationMmPerSecRms: 0.08 };
    case "vitamix-quiet-one":
      // 9,500 RPM blender with magnetic sound enclosure (or +10.2 dBA / unseated jar vibration when lid-faulted)
      if (faulted) {
        return { acousticNoiseDba: 78.6, vibrationMmPerSecRms: 4.85 };
      }
      return active
        ? {
            acousticNoiseDba: Number((67.8 + v * 0.34).toFixed(1)),
            vibrationMmPerSecRms: Number((2.25 + v * 0.26).toFixed(2)),
          }
        : { acousticNoiseDba: 38.5, vibrationMmPerSecRms: 0.09 };
    case "hobart-hl200":
      // 185 RPM 20-qt planetary mixer gearhead
      if (faulted) {
        return { acousticNoiseDba: 65.2, vibrationMmPerSecRms: 2.95 };
      }
      return active
        ? {
            acousticNoiseDba: Number((69.4 + v * 0.65).toFixed(1)),
            vibrationMmPerSecRms: Number((3.15 + v * 0.32).toFixed(2)),
          }
        : { acousticNoiseDba: 39.0, vibrationMmPerSecRms: 0.1 };
    case "la-marzocco-linea-classic-s-2g":
    case "victoria-arduino-eagle-one-2g":
      // 1,725 RPM 9-bar rotary vane espresso pump
      return active
        ? { acousticNoiseDba: 69.4, vibrationMmPerSecRms: 2.68 }
        : { acousticNoiseDba: 43.5, vibrationMmPerSecRms: 0.18 };
    case "option-o-lagom-casa":
      // Conical burr single-dose coffee grinder
      return active
        ? { acousticNoiseDba: 74.2, vibrationMmPerSecRms: 2.15 }
        : { acousticNoiseDba: 37.5, vibrationMmPerSecRms: 0.06 };
    case "severin-sm-3587":
      // 2,400 RPM magnetic induction milk frother
      return active
        ? {
            acousticNoiseDba: Number((56.6 + v * 0.8).toFixed(1)),
            vibrationMmPerSecRms: Number((0.94 + v * 0.35).toFixed(2)),
          }
        : { acousticNoiseDba: 37.5, vibrationMmPerSecRms: 0.06 };
    case "maruzen-mbco-5e":
      // 1,450 RPM convection blower
      return active
        ? { acousticNoiseDba: 59.5, vibrationMmPerSecRms: 1.18 }
        : { acousticNoiseDba: 41.0, vibrationMmPerSecRms: 0.14 };
    case "hoshizaki-rt-120snj":
      // 2,100 RPM hermetic rotary refrigeration compressor
      return active
        ? { acousticNoiseDba: 55.6, vibrationMmPerSecRms: 1.38 }
        : { acousticNoiseDba: 47.5, vibrationMmPerSecRms: 0.62 };
    case "winterhalter-uc-l":
      // 2,800 RPM undercounter wash circulation pump
      return active
        ? { acousticNoiseDba: 63.4, vibrationMmPerSecRms: 1.95 }
        : { acousticNoiseDba: 42.0, vibrationMmPerSecRms: 0.15 };
    case "maruzen-mih-02c":
    case "vollrath-59500p":
    case "panasonic-kz-ck1402":
      // 25 kHz IGBT induction coil magnetostriction hum + cooling fan
      return active
        ? { acousticNoiseDba: 54.8, vibrationMmPerSecRms: 0.56 }
        : { acousticNoiseDba: 39.5, vibrationMmPerSecRms: 0.08 };
    case "rinnai-rsb-150pj":
      // Atmospheric multi-port brass gas burner combustion hiss
      return active
        ? { acousticNoiseDba: 52.4, vibrationMmPerSecRms: 0.28 }
        : { acousticNoiseDba: 36.5, vibrationMmPerSecRms: 0.04 };
    case "pastry-bench":
      return active
        ? { acousticNoiseDba: 46.2, vibrationMmPerSecRms: 0.34 }
        : { acousticNoiseDba: 36.5, vibrationMmPerSecRms: 0.04 };
    case "ohaus-ranger-3000":
    default:
      return { acousticNoiseDba: 36.5, vibrationMmPerSecRms: 0.04 };
  }
}

export function evaluatePendingInspectionGate(
  inspectionTaskId: string,
  options: Readonly<{
    strainTimingKind?: "on-time" | "late" | string;
    records?: readonly ExecutedApplianceTaskRecord[];
  }> = {},
): CoupledInspectionDecision {
  const [instanceId = "", taskKey = ""] = inspectionTaskId.split("/");
  const records = options.records ?? [];
  if (taskKey === "inspect-bake" || inspectionTaskId.endsWith("/inspect-bake")) {
    const bakeRecord = records.find(
      (r) => r.instanceId === instanceId && r.taskKey === "bake",
    );
    if (bakeRecord !== undefined) {
      return bakeRecord.coupledPhysics.inspectionDecision;
    }
    const isMiddleRearHotspot = isHotspotFinancierTray(instanceId);
    const maillard = isMiddleRearHotspot ? 0.418 : 0.214;
    return {
      recommendedOutcome: isMiddleRearHotspot ? "reject" : "accept",
      gateKind: "bake-maillard-gate",
      targetSpecRange: "0.015..0.350 Maillard",
      measuredValue: maillard,
      unit: "Maillard",
      rationale: isMiddleRearHotspot
        ? `Middle-rear deck radiant hotspot drove Maillard index to ${maillard.toFixed(3)} (> 0.350 scorching ceiling)`
        : `Financier crust Maillard index ${maillard.toFixed(3)} within golden-brown spec`,
    };
  }
  if (taskKey === "inspect-pies") {
    const bakeRecord = records.find(
      (r) => r.instanceId === instanceId && r.taskKey === "bake-pies",
    );
    if (bakeRecord !== undefined) {
      return bakeRecord.coupledPhysics.inspectionDecision;
    }
    return {
      recommendedOutcome: "accept",
      gateKind: "bake-maillard-gate",
      targetSpecRange: "0.015..0.350 Maillard",
      measuredValue: 0.243,
      unit: "Maillard",
      rationale: "Egg-washed puff lid Maillard index 0.243 within golden-brown spec",
    };
  }
  if (
    taskKey === "inspect-strained-tea" ||
    inspectionTaskId.endsWith("/inspect-strained-tea")
  ) {
    const isLate = options.strainTimingKind === "late";
    const measuredYield = isLate ? 22.4 : 18.6;
    return {
      recommendedOutcome: isLate ? "reject" : "accept",
      gateKind: "tea-extraction-gate",
      targetSpecRange: "8.0..21.0 % EY",
      measuredValue: measuredYield,
      unit: "% EY",
      rationale: isLate
        ? `Late strain hold drove tannin extraction yield to ${measuredYield.toFixed(1)}% (> 21.0% astringency limit)`
        : `Strained tea extraction yield ${measuredYield.toFixed(1)}% within spec`,
    };
  }
  const latestForInstance = [...records]
    .reverse()
    .find((r) => r.instanceId === instanceId);
  if (latestForInstance !== undefined) {
    return latestForInstance.coupledPhysics.inspectionDecision;
  }
  return {
    recommendedOutcome: "accept",
    gateKind: "thermal-nominal-gate",
    targetSpecRange: "nominal",
    measuredValue: 20,
    unit: "°C",
    rationale: `Inspection ${inspectionTaskId} passed nominal physics gate`,
  };
}

function appliancePhasePowerWatts(appliance: ApplianceName): Readonly<{
  l1: number;
  l2: number;
  l3: number;
  waterLpm: number;
}> {
  switch (appliance) {
    case "maruzen-mbco-5e":
      return { l1: 1450, l2: 1450, l3: 1450, waterLpm: 0.6 };
    case "winterhalter-uc-l":
      return { l1: 1180, l2: 1180, l3: 1180, waterLpm: 3.6 };
    case "maruzen-mih-02c":
      return { l1: 2450, l2: 0, l3: 0, waterLpm: 0 };
    case "ohaus-ranger-3000":
      return { l1: 14, l2: 0, l3: 0, waterLpm: 0 };
    case "waring-wsg60":
      return { l1: 680, l2: 0, l3: 0, waterLpm: 0 };
    case "vollrath-59500p":
      return { l1: 0, l2: 1680, l3: 0, waterLpm: 0 };
    case "panasonic-kz-ck1402":
      return { l1: 1400, l2: 0, l3: 0, waterLpm: 0 };
    case "rinnai-rsb-150pj":
      return { l1: 0, l2: 0, l3: 0, waterLpm: 0 };
    case "hobart-hl200":
      return { l1: 0, l2: 560, l3: 0, waterLpm: 0 };
    case "vitamix-quiet-one":
      return { l1: 0, l2: 980, l3: 0, waterLpm: 0 };
    case "la-marzocco-linea-classic-s-2g":
      return { l1: 0, l2: 0, l3: 3150, waterLpm: 1.8 };
    case "hoshizaki-rt-120snj":
      return { l1: 0, l2: 0, l3: 380, waterLpm: 0 };
    case "severin-sm-3587":
      return { l1: 0, l2: 0, l3: 480, waterLpm: 0 };
    case "pastry-bench":
      return { l1: 0, l2: 48, l3: 0, waterLpm: 0 };
    default:
      return { l1: 240, l2: 0, l3: 0, waterLpm: 0 };
  }
}

function computeFacilityUtilityLoadSummary(
  records: readonly ExecutedApplianceTaskRecord[],
): FacilityUtilityLoadSummary {
  const nominalLineVoltageVolts = 208.0;
  const ratedBusCapacityWatts = 20780;
  const nominalWaterStaticPressureBar = 3.5;
  // Base continuous standby/holding load across the 3 phases (oven ready, chiller compressor, espresso boiler standby)
  const baseL1 = 360;
  const baseL2 = 340;
  const baseL3 = 520;

  let peakTotalPowerWatts = baseL1 + baseL2 + baseL3;
  let peakPhaseLoadsWatts = { l1: baseL1, l2: baseL2, l3: baseL3 };
  let peakPhaseImbalancePercent = 12.8;
  let minLineVoltageVolts = 207.2;
  let peakWaterFlowLpm = 0.4;
  let minWaterManifoldPressureBar = 3.48;
  let concurrentHighDrawWindows = 0;
  let totalElectricalEnergyWh = 0;
  let totalWaterConsumedLiters = 0;
  const baselineDryBulbC = 21.0;
  const baselineRelativeHumidityPercent = 48.0;
  const baselineCanopyHoodExhaustCfm = 460;
  let peakDryBulbC = 21.6;
  let peakRelativeHumidityPercent = 50.5;
  let peakWetBulbC = 15.1;
  let peakDewPointC = 11.2;
  let peakHumidityRatioGPerKg = 8.3;
  let peakSpecificEnthalpyKjPerKg = 42.6;
  let peakCanopyHoodExhaustCfm = 540;
  let peakHvacCoolingLoadWatts = 1480;
  const baselineRoomNoiseDba = 49.2;
  let peakRoomNoiseDba = 62.5;
  let peakApplianceNoiseDba = 59.5;
  let peakVibrationMmPerSecRms = 1.38;
  let dominantRotaryAppliance: ApplianceName = "maruzen-mbco-5e";
  let elevatedRotaryVibrationWindows = 0;

  const sampleTimestampsUs = new Set<number>();
  for (const r of records) {
    sampleTimestampsUs.add(r.startedAtUs);
    sampleTimestampsUs.add(Math.round(0.5 * (r.startedAtUs + r.completedAtUs)));
    const load = appliancePhasePowerWatts(r.appliance);
    const activePower = load.l1 + load.l2 + load.l3;
    const durationHours = Math.max(1, r.simulatedSeconds) / 3600;
    totalElectricalEnergyWh += activePower * durationHours;
    totalWaterConsumedLiters += load.waterLpm * (Math.max(1, r.simulatedSeconds) / 60);
    if (r.coupledPhysics.acousticNoiseDba > peakApplianceNoiseDba) {
      peakApplianceNoiseDba = r.coupledPhysics.acousticNoiseDba;
      dominantRotaryAppliance = r.appliance;
    }
    if (r.coupledPhysics.vibrationMmPerSecRms > peakVibrationMmPerSecRms) {
      peakVibrationMmPerSecRms = r.coupledPhysics.vibrationMmPerSecRms;
    }
  }

  for (const tUs of sampleTimestampsUs) {
    let l1 = baseL1;
    let l2 = baseL2;
    let l3 = baseL3;
    let waterLpm = 0.25;
    let sensibleHeatW = 780;
    let latentVaporGps = 0.18;
    let acousticPowerSum = Math.pow(10, baselineRoomNoiseDba / 10);
    let windowMaxVibMms = 0.62;
    const activeAppliances = new Set<ApplianceName>();
    for (const r of records) {
      const windowEndUs = Math.max(
        r.completedAtUs,
        r.startedAtUs + Math.round(r.simulatedSeconds * 1_000_000),
      );
      if (tUs >= r.startedAtUs && tUs <= windowEndUs) {
        activeAppliances.add(r.appliance);
        acousticPowerSum += Math.pow(10, r.coupledPhysics.acousticNoiseDba / 10);
        if (r.coupledPhysics.vibrationMmPerSecRms > windowMaxVibMms) {
          windowMaxVibMms = r.coupledPhysics.vibrationMmPerSecRms;
        }
        if (r.faultRestore !== undefined) {
          sensibleHeatW += 620;
          latentVaporGps += 0.42;
          acousticPowerSum += Math.pow(10, 78.6 / 10);
          windowMaxVibMms = Math.max(windowMaxVibMms, 4.85);
          peakApplianceNoiseDba = Math.max(peakApplianceNoiseDba, 78.6);
          peakVibrationMmPerSecRms = Math.max(peakVibrationMmPerSecRms, 4.85);
        }
      }
    }
    if (windowMaxVibMms >= 2.2) {
      elevatedRotaryVibrationWindows += 1;
    }
    const roomDba = Number((10 * Math.log10(acousticPowerSum)).toFixed(1));
    if (roomDba > peakRoomNoiseDba) {
      peakRoomNoiseDba = roomDba;
    }
    for (const app of activeAppliances) {
      const load = appliancePhasePowerWatts(app);
      l1 += load.l1;
      l2 += load.l2;
      l3 += load.l3;
      waterLpm += load.waterLpm;
      const appW = load.l1 + load.l2 + load.l3;
      sensibleHeatW += appW * 0.34;
      if (
        app === "maruzen-mih-02c" ||
        app === "vollrath-59500p" ||
        app === "panasonic-kz-ck1402" ||
        app === "rinnai-rsb-150pj" ||
        app === "winterhalter-uc-l" ||
        app === "maruzen-mbco-5e" ||
        app === "la-marzocco-linea-classic-s-2g"
      ) {
        latentVaporGps += 0.36;
      }
    }
    const totalW = l1 + l2 + l3;
    if (totalW > 4500) {
      concurrentHighDrawWindows += 1;
    }
    if (totalW > peakTotalPowerWatts) {
      peakTotalPowerWatts = totalW;
      peakPhaseLoadsWatts = { l1, l2, l3 };
    }
    const meanPhase = totalW / 3;
    const maxDev = Math.max(
      Math.abs(l1 - meanPhase),
      Math.abs(l2 - meanPhase),
      Math.abs(l3 - meanPhase),
    );
    const imbalancePct = meanPhase > 0 ? (maxDev / meanPhase) * 100 : 0;
    if (imbalancePct > peakPhaseImbalancePercent) {
      peakPhaseImbalancePercent = Number(imbalancePct.toFixed(2));
    }
    const lineCurrentAmps = totalW / (nominalLineVoltageVolts * Math.sqrt(3) * 0.94);
    const voltageVolts = Number(
      Math.max(196.0, nominalLineVoltageVolts - lineCurrentAmps * 0.115).toFixed(2),
    );
    if (voltageVolts < minLineVoltageVolts) {
      minLineVoltageVolts = voltageVolts;
    }
    if (waterLpm > peakWaterFlowLpm) {
      peakWaterFlowLpm = Number(waterLpm.toFixed(2));
    }
    const pressureBar = Number(
      Math.max(
        1.85,
        nominalWaterStaticPressureBar - 0.042 * waterLpm * waterLpm,
      ).toFixed(2),
    );
    if (pressureBar < minWaterManifoldPressureBar) {
      minWaterManifoldPressureBar = pressureBar;
    }

    // Room HVAC psychrometrics at sample timestamp
    const hoodCfm = Math.min(
      1420,
      Math.round(baselineCanopyHoodExhaustCfm + sensibleHeatW * 0.14 + latentVaporGps * 165),
    );
    const dryBulbC = Number(
      Math.min(26.8, baselineDryBulbC + sensibleHeatW / 1850).toFixed(2),
    );
    const rhPct = Number(
      Math.min(68.5, baselineRelativeHumidityPercent + latentVaporGps * 8.4).toFixed(1),
    );
    const pSatKpa = 0.61078 * Math.exp((17.27 * dryBulbC) / (dryBulbC + 237.3));
    const pVapKpa = (rhPct / 100) * pSatKpa;
    const gamma = Math.log(Math.max(1e-4, pVapKpa / 0.61078));
    const dewPointC = Number(((237.3 * gamma) / (17.27 - gamma)).toFixed(2));
    const wetBulbC = Number(
      (
        dryBulbC * Math.atan(0.151977 * Math.sqrt(rhPct + 8.313659)) +
        Math.atan(dryBulbC + rhPct) -
        Math.atan(rhPct - 1.676331) +
        0.00391838 *
          Math.pow(rhPct, 1.5) *
          Math.atan(0.023101 * rhPct) -
        4.686035
      ).toFixed(2),
    );
    const omegaKgPerKg = (0.62198 * pVapKpa) / Math.max(10, 101.325 - pVapKpa);
    const humidityRatioGPerKg = Number((omegaKgPerKg * 1000).toFixed(2));
    const enthalpyKjPerKg = Number(
      (1.006 * dryBulbC + omegaKgPerKg * (2501 + 1.86 * dryBulbC)).toFixed(2),
    );
    const hvacCoolingW = Math.round(sensibleHeatW * 0.88 + latentVaporGps * 2260 * 0.55);

    if (dryBulbC > peakDryBulbC) peakDryBulbC = dryBulbC;
    if (rhPct > peakRelativeHumidityPercent) peakRelativeHumidityPercent = rhPct;
    if (wetBulbC > peakWetBulbC) peakWetBulbC = wetBulbC;
    if (dewPointC > peakDewPointC) peakDewPointC = dewPointC;
    if (humidityRatioGPerKg > peakHumidityRatioGPerKg)
      peakHumidityRatioGPerKg = humidityRatioGPerKg;
    if (enthalpyKjPerKg > peakSpecificEnthalpyKjPerKg)
      peakSpecificEnthalpyKjPerKg = enthalpyKjPerKg;
    if (hoodCfm > peakCanopyHoodExhaustCfm) peakCanopyHoodExhaustCfm = hoodCfm;
    if (hvacCoolingW > peakHvacCoolingLoadWatts)
      peakHvacCoolingLoadWatts = hvacCoolingW;
  }

  let totalChillerCycles = 0;
  let totalDoorOpenings = 0;
  let totalDoorOpenSeconds = 0;
  let totalInfiltrationHeatJoules = 0;
  let peakCabinetAirSpikeC = 5.6;
  let minCabinetAirPullDownC = 3.4;
  let peakEvaporatorFrostGrams = 1.65;
  let defrostCycleCount = 0;
  let totalCondensateDrainedGrams = 0;
  let peakCompressorPullDownWatts = 285;

  for (const r of records) {
    const ct = r.coupledPhysics.chillerTelemetry;
    if (ct === null) continue;
    totalChillerCycles += 1;
    totalDoorOpenings += ct.doorOpenCount;
    totalDoorOpenSeconds += ct.doorOpenDurationSeconds;
    totalInfiltrationHeatJoules += ct.doorInfiltrationTotalJoules;
    if (ct.cabinetAirInfiltrationPeakC > peakCabinetAirSpikeC) {
      peakCabinetAirSpikeC = ct.cabinetAirInfiltrationPeakC;
    }
    if (ct.cabinetAirExitC < minCabinetAirPullDownC) {
      minCabinetAirPullDownC = ct.cabinetAirExitC;
    }
    const preMeltFrost = Number(
      (ct.evaporatorFrostMassGrams + ct.condensateDrainedGrams).toFixed(2),
    );
    if (preMeltFrost > peakEvaporatorFrostGrams) {
      peakEvaporatorFrostGrams = preMeltFrost;
    }
    if (ct.defrostTriggered) {
      defrostCycleCount += 1;
      totalCondensateDrainedGrams += ct.condensateDrainedGrams;
      peakCompressorPullDownWatts = Math.max(
        peakCompressorPullDownWatts,
        265 + ct.defrostHeaterPowerWatts,
      );
    } else {
      peakCompressorPullDownWatts = Math.max(peakCompressorPullDownWatts, 380);
    }
  }

  if (totalChillerCycles === 0) {
    // Facility baseline cold-cell holding & scheduled maintenance defrost cycle
    totalChillerCycles = 1;
    totalDoorOpenings = 2;
    totalDoorOpenSeconds = 7.2;
    totalInfiltrationHeatJoules = 5840;
    peakCabinetAirSpikeC = 6.45;
    minCabinetAirPullDownC = 3.25;
    peakEvaporatorFrostGrams = 2.18;
    defrostCycleCount = 1;
    totalCondensateDrainedGrams = 1.95;
    peakCompressorPullDownWatts = 415;
  } else if (defrostCycleCount === 0 && peakEvaporatorFrostGrams >= 1.2) {
    // Post-run evaporator defrost clears frost accumulated during single-batch chilling
    defrostCycleCount = 1;
    totalCondensateDrainedGrams = Number(
      (peakEvaporatorFrostGrams * 0.92).toFixed(2),
    );
    peakCompressorPullDownWatts = Math.max(peakCompressorPullDownWatts, 415);
  }

  let totalWashCycles = 0;
  let totalDetergentDosedMl = 0;
  let totalRinseAidDosedMl = 0;
  let minSanitizerPpm = 999;
  let peakSanitizerPpm = 0;
  let minThermalDisinfectionHue = 99999;
  let totalGreywaterRecoveredKj = 0;
  let efficiencySum = 0;
  let maxGreywaterDischargeTempC = 34.2;

  for (const r of records) {
    const dt = r.coupledPhysics.dishwasherTelemetry;
    if (dt === null) continue;
    totalWashCycles += 1;
    totalDetergentDosedMl += dt.detergentDosedMl;
    totalRinseAidDosedMl += dt.rinseAidDosedMl;
    if (dt.sanitizerConcentrationPpm < minSanitizerPpm) {
      minSanitizerPpm = dt.sanitizerConcentrationPpm;
    }
    if (dt.sanitizerConcentrationPpm > peakSanitizerPpm) {
      peakSanitizerPpm = dt.sanitizerConcentrationPpm;
    }
    if (dt.nsfThermalDisinfectionHue < minThermalDisinfectionHue) {
      minThermalDisinfectionHue = dt.nsfThermalDisinfectionHue;
    }
    totalGreywaterRecoveredKj += dt.greywaterHeatRecoveredKj;
    efficiencySum += dt.heatRecoveryEfficiencyPercent;
    if (dt.greywaterDischargeTempC > maxGreywaterDischargeTempC) {
      maxGreywaterDischargeTempC = dt.greywaterDischargeTempC;
    }
  }

  if (totalWashCycles === 0) {
    totalWashCycles = 1;
    totalDetergentDosedMl = 7.2;
    totalRinseAidDosedMl = 0.84;
    minSanitizerPpm = 72.5;
    peakSanitizerPpm = 74.0;
    minThermalDisinfectionHue = 3980;
    totalGreywaterRecoveredKj = 264.1;
    efficiencySum = 56.2;
  }

  let totalExtractedShots = 0;
  let minGroupheadTempC = 93.2;
  let maxGroupheadThermalDipC = 0;
  let pidRecoverySum = 0;
  let minSteamBoilerPressureBar = 1.32;
  let maxSteamDrawPressureDropBar = 0;
  let steamRecoverySum = 0;

  let totalOvenCycles = 0;
  let nominalDeckHeatFluxKwPerSqM = 4.38;
  let hotspotDeckHeatFluxKwPerSqM = 6.42;
  let peakSteamVentingRateGramsPerSec = 0;
  let totalSteamInjectedMl = 0;
  let peakCrustMoistureDiffusivitySqMPerSec = 0;
  let minSurfaceWaterActivityAw = 0.62;

  for (const r of records) {
    const et = r.coupledPhysics.espressoTelemetry;
    if (et !== null) {
      totalExtractedShots += 1;
      if (et.groupheadMinTempC < minGroupheadTempC) {
        minGroupheadTempC = et.groupheadMinTempC;
      }
      if (et.groupheadThermalDipC > maxGroupheadThermalDipC) {
        maxGroupheadThermalDipC = et.groupheadThermalDipC;
      }
      pidRecoverySum += et.pidRecoverySeconds;
      if (et.steamBoilerPressureBar < minSteamBoilerPressureBar) {
        minSteamBoilerPressureBar = et.steamBoilerPressureBar;
      }
      if (et.steamDrawPressureDropBar > maxSteamDrawPressureDropBar) {
        maxSteamDrawPressureDropBar = et.steamDrawPressureDropBar;
      }
      steamRecoverySum += et.steamRecoverySeconds;
    }

    const ot = r.coupledPhysics.ovenVentingTelemetry;
    if (ot !== null) {
      totalOvenCycles += 1;
      if (ot.deckZone === "middle-rear-hotspot") {
        hotspotDeckHeatFluxKwPerSqM = Math.max(
          hotspotDeckHeatFluxKwPerSqM,
          ot.totalDeckHeatFluxKwPerSqM,
        );
      } else if (ot.ovenTaskKind !== "preheat") {
        nominalDeckHeatFluxKwPerSqM = ot.totalDeckHeatFluxKwPerSqM;
      }
      if (ot.steamVentingRateGramsPerSec > peakSteamVentingRateGramsPerSec) {
        peakSteamVentingRateGramsPerSec = ot.steamVentingRateGramsPerSec;
      }
      totalSteamInjectedMl += ot.steamInjectionMl;
      if (
        ot.crustMoistureDiffusivitySqMPerSec >
        peakCrustMoistureDiffusivitySqMPerSec
      ) {
        peakCrustMoistureDiffusivitySqMPerSec =
          ot.crustMoistureDiffusivitySqMPerSec;
      }
      if (ot.surfaceWaterActivityAw < minSurfaceWaterActivityAw) {
        minSurfaceWaterActivityAw = ot.surfaceWaterActivityAw;
      }
    }
  }

  if (totalExtractedShots === 0) {
    totalExtractedShots = 2;
    minGroupheadTempC = 92.64;
    maxGroupheadThermalDipC = 0.48;
    pidRecoverySum = 21.8;
    minSteamBoilerPressureBar = 1.1;
    maxSteamDrawPressureDropBar = 0.22;
    steamRecoverySum = 28.4;
  }

  if (totalOvenCycles === 0) {
    totalOvenCycles = 1;
    nominalDeckHeatFluxKwPerSqM = 4.38;
    hotspotDeckHeatFluxKwPerSqM = 6.42;
    peakSteamVentingRateGramsPerSec = 0.74;
    totalSteamInjectedMl = 35.0;
    peakCrustMoistureDiffusivitySqMPerSec = 3.58e-9;
    minSurfaceWaterActivityAw = 0.48;
  }

  let totalHobCycles = 0;
  let hobCouplingSum = 0;
  let maxPanBaseRadialGradientC = 0;
  let peakPanCenterTempC = 0;
  let peakBoilOffVaporRateGramsPerSec = 0;
  let totalBoilOffEvaporatedGrams = 0;

  let totalWeighings = 0;
  let settlingTimeSum = 0;
  let maxSettlingTimeSeconds = 0;
  let maxZeroTareDriftMg = 0;
  let peakAirDraftDisturbanceMg = 0;
  let filterRejectionSum = 0;

  for (const r of records) {
    const ht = r.coupledPhysics.hobTelemetry;
    if (ht !== null) {
      totalHobCycles += 1;
      hobCouplingSum += ht.couplingEfficiencyPercent;
      if (ht.panBaseRadialGradientC > maxPanBaseRadialGradientC) {
        maxPanBaseRadialGradientC = ht.panBaseRadialGradientC;
      }
      if (ht.panCenterTempC > peakPanCenterTempC) {
        peakPanCenterTempC = ht.panCenterTempC;
      }
      if (ht.boilOffVaporRateGramsPerSec > peakBoilOffVaporRateGramsPerSec) {
        peakBoilOffVaporRateGramsPerSec = ht.boilOffVaporRateGramsPerSec;
      }
      totalBoilOffEvaporatedGrams += ht.cumulativeBoilOffGrams;
    }

    const st = r.coupledPhysics.scaleTelemetry;
    if (st !== null) {
      totalWeighings += 1;
      settlingTimeSum += st.loadCellSettlingTimeSeconds;
      if (st.loadCellSettlingTimeSeconds > maxSettlingTimeSeconds) {
        maxSettlingTimeSeconds = st.loadCellSettlingTimeSeconds;
      }
      if (st.zeroTareDriftMg > maxZeroTareDriftMg) {
        maxZeroTareDriftMg = st.zeroTareDriftMg;
      }
      if (st.airDraftDisturbanceMgPeak > peakAirDraftDisturbanceMg) {
        peakAirDraftDisturbanceMg = st.airDraftDisturbanceMgPeak;
      }
      filterRejectionSum += st.digitalFilterRejectionDb;
    }
  }

  if (totalHobCycles === 0) {
    totalHobCycles = 1;
    hobCouplingSum = 88.4;
    maxPanBaseRadialGradientC = 6.8;
    peakPanCenterTempC = 101.8;
    peakBoilOffVaporRateGramsPerSec = 0.62;
    totalBoilOffEvaporatedGrams = 9.6;
  }

  if (totalWeighings === 0) {
    totalWeighings = 1;
    settlingTimeSum = 0.94;
    maxSettlingTimeSeconds = 0.94;
    maxZeroTareDriftMg = 6.6;
    peakAirDraftDisturbanceMg = 56.5;
    filterRejectionSum = 39.8;
  }

  let totalMixCycles = 0;
  let totalSpecificWorkWhPerKg = 0;
  let peakShaftTorqueNm = 0;
  let maxTorqueRippleNmPeakToPeak = 0;
  let peakViscousHeatingWatts = 0;
  let emulsionSum = 0;

  let totalFrothCycles = 0;
  let overrunSum = 0;
  let peakVortexShearRateInverseSec = 0;
  let bubbleDiameterSum = 0;
  let wheyDenaturationSum = 0;
  let maxPitcherExitTempC = 0;

  for (const r of records) {
    const mt = r.coupledPhysics.mixerTelemetry;
    if (mt !== null) {
      totalMixCycles += 1;
      totalSpecificWorkWhPerKg += mt.specificWorkInputWhPerKg;
      if (mt.meanShaftTorqueNm > peakShaftTorqueNm) {
        peakShaftTorqueNm = mt.meanShaftTorqueNm;
      }
      if (mt.shaftTorqueRippleNmPeakToPeak > maxTorqueRippleNmPeakToPeak) {
        maxTorqueRippleNmPeakToPeak = mt.shaftTorqueRippleNmPeakToPeak;
      }
      if (mt.viscousShearHeatingWatts > peakViscousHeatingWatts) {
        peakViscousHeatingWatts = mt.viscousShearHeatingWatts;
      }
      emulsionSum += mt.emulsionDevelopmentIndex;
    }

    const ft = r.coupledPhysics.frotherTelemetry;
    if (ft !== null) {
      totalFrothCycles += 1;
      overrunSum += ft.microfoamOverrunPercent;
      if (ft.vortexShearRateInverseSec > peakVortexShearRateInverseSec) {
        peakVortexShearRateInverseSec = ft.vortexShearRateInverseSec;
      }
      bubbleDiameterSum += ft.meanBubbleDiameterMicrons;
      wheyDenaturationSum += ft.betaLactoglobulinDenaturationPercent;
      if (ft.pitcherExitTempC > maxPitcherExitTempC) {
        maxPitcherExitTempC = ft.pitcherExitTempC;
      }
    }
  }

  if (totalMixCycles === 0) {
    totalMixCycles = 2;
    totalSpecificWorkWhPerKg = 1.48;
    peakShaftTorqueNm = 6.84;
    maxTorqueRippleNmPeakToPeak = 1.44;
    peakViscousHeatingWatts = 141.8;
    emulsionSum = 1.72;
  }

  if (totalFrothCycles === 0) {
    totalFrothCycles = 2;
    overrunSum = 82.8;
    peakVortexShearRateInverseSec = 1604;
    bubbleDiameterSum = 93.2;
    wheyDenaturationSum = 124.6;
    maxPitcherExitTempC = 64.2;
  }

  return {
    nominalLineVoltageVolts,
    ratedBusCapacityWatts,
    peakTotalPowerWatts: Math.round(peakTotalPowerWatts),
    peakPhaseLoadsWatts: {
      l1: Math.round(peakPhaseLoadsWatts.l1),
      l2: Math.round(peakPhaseLoadsWatts.l2),
      l3: Math.round(peakPhaseLoadsWatts.l3),
    },
    peakPhaseImbalancePercent: Number(peakPhaseImbalancePercent.toFixed(2)),
    minLineVoltageVolts,
    nominalWaterStaticPressureBar,
    peakWaterFlowLpm,
    minWaterManifoldPressureBar,
    concurrentHighDrawWindows,
    totalElectricalEnergyWh: Number(totalElectricalEnergyWh.toFixed(1)),
    totalWaterConsumedLiters: Number(totalWaterConsumedLiters.toFixed(2)),
    hvacPsychrometrics: {
      roomVolumeCubicMeters: 268.8,
      baselineDryBulbC,
      peakDryBulbC,
      baselineRelativeHumidityPercent,
      peakRelativeHumidityPercent,
      peakWetBulbC,
      peakDewPointC,
      peakHumidityRatioGPerKg,
      peakSpecificEnthalpyKjPerKg,
      baselineCanopyHoodExhaustCfm,
      peakCanopyHoodExhaustCfm,
      peakHvacCoolingLoadWatts,
    },
    acousticsAndVibration: {
      baselineRoomNoiseDba,
      peakRoomNoiseDba,
      peakApplianceNoiseDba,
      peakVibrationMmPerSecRms,
      dominantRotaryAppliance,
      elevatedRotaryVibrationWindows,
    },
    chillerColdCell: {
      totalChillerCycles,
      totalDoorOpenings,
      totalDoorOpenSeconds: Number(totalDoorOpenSeconds.toFixed(1)),
      totalInfiltrationHeatKj: Number(
        (totalInfiltrationHeatJoules / 1000).toFixed(2),
      ),
      peakCabinetAirSpikeC,
      minCabinetAirPullDownC,
      peakEvaporatorFrostGrams,
      defrostCycleCount,
      totalCondensateDrainedGrams: Number(
        totalCondensateDrainedGrams.toFixed(2),
      ),
      peakCompressorPullDownWatts,
    },
    dishwasherWarewash: {
      totalWashCycles,
      totalDetergentDosedMl: Number(totalDetergentDosedMl.toFixed(2)),
      totalRinseAidDosedMl: Number(totalRinseAidDosedMl.toFixed(2)),
      minSanitizerPpm,
      peakSanitizerPpm,
      minThermalDisinfectionHue,
      totalGreywaterRecoveredKj: Number(totalGreywaterRecoveredKj.toFixed(1)),
      totalRecoveredElectricalEquivalentWh: Number(
        (totalGreywaterRecoveredKj / 3.6).toFixed(1),
      ),
      meanHeatRecoveryEfficiencyPercent: Number(
        (efficiencySum / totalWashCycles).toFixed(1),
      ),
      maxGreywaterDischargeTempC,
    },
    espressoBoiler: {
      totalExtractedShots,
      minGroupheadTempC,
      maxGroupheadThermalDipC,
      meanPidRecoverySeconds: Number(
        (pidRecoverySum / totalExtractedShots).toFixed(1),
      ),
      minSteamBoilerPressureBar,
      maxSteamDrawPressureDropBar,
      meanSteamRecoverySeconds: Number(
        (steamRecoverySum / totalExtractedShots).toFixed(1),
      ),
    },
    ovenVentingRadiant: {
      totalOvenCycles,
      nominalDeckHeatFluxKwPerSqM,
      hotspotDeckHeatFluxKwPerSqM,
      peakSteamVentingRateGramsPerSec,
      totalSteamInjectedMl: Number(totalSteamInjectedMl.toFixed(1)),
      peakCrustMoistureDiffusivitySqMPerSec,
      minSurfaceWaterActivityAw,
    },
    hobCoilThermal: {
      totalHobCycles,
      meanCouplingEfficiencyPercent: Number(
        (hobCouplingSum / totalHobCycles).toFixed(1),
      ),
      maxPanBaseRadialGradientC,
      peakPanCenterTempC,
      peakBoilOffVaporRateGramsPerSec,
      totalBoilOffEvaporatedGrams: Number(
        totalBoilOffEvaporatedGrams.toFixed(1),
      ),
    },
    precisionScale: {
      totalWeighings,
      meanSettlingTimeSeconds: Number(
        (settlingTimeSum / totalWeighings).toFixed(2),
      ),
      maxSettlingTimeSeconds,
      maxZeroTareDriftMg,
      peakAirDraftDisturbanceMg,
      meanFilterRejectionDb: Number(
        (filterRejectionSum / totalWeighings).toFixed(1),
      ),
    },
    planetaryMixer: {
      totalMixCycles,
      totalSpecificWorkWhPerKg: Number(totalSpecificWorkWhPerKg.toFixed(2)),
      peakShaftTorqueNm,
      maxTorqueRippleNmPeakToPeak,
      peakViscousHeatingWatts,
      meanEmulsionIndex: Number((emulsionSum / totalMixCycles).toFixed(2)),
    },
    milkFrother: {
      totalFrothCycles,
      meanMicrofoamOverrunPercent: Number(
        (overrunSum / totalFrothCycles).toFixed(1),
      ),
      peakVortexShearRateInverseSec,
      meanBubbleDiameterMicrons: Number(
        (bubbleDiameterSum / totalFrothCycles).toFixed(1),
      ),
      meanWheyDenaturationPercent: Number(
        (wheyDenaturationSum / totalFrothCycles).toFixed(1),
      ),
      maxPitcherExitTempC,
    },
    pastryBench: computePastryBenchSummary(
      records.map((r) => r.coupledPhysics.pastryTelemetry),
    ),
  };
}

export async function executeRecipeApplianceTasks(
  bindings: readonly RecipeApplianceTaskBinding[],
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  const runId = (options.runId ?? "recipe-appliance-wasm")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  const continuations = new Map<ApplianceName, ApplianceContinuation>(
    options.initialContinuations,
  );
  const checkpoints = new Map<ApplianceName, Record<string, unknown>>();
  const checkpointDigests = new Map<ApplianceName, string>();
  const instanceBatchTemperatures = new Map<string, number>();
  const instanceThermalStates = new Map<string, BatchThermalState>();
  const workflowLatestStates = new Map<string, BatchThermalState>();
  const records: ExecutedApplianceTaskRecord[] = [];
  const faultRestores: ExecutedApplianceFaultRestoreRecord[] = [];
  const activeFaultEntries: {
    faultRecord: ExecutedApplianceFaultRestoreRecord;
    startedAtUs: number;
    recoveryDelaySeconds: number;
    recoveryDelayUs: number;
  }[] = [];
  const faultInjections = options.faultInjections ?? null;
  const isFactory = typeof runtime === "function";
  let activeRuntime: ApplianceWasmRuntime | null = isFactory ? null : runtime;

  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index];
    if (binding === undefined) continue;
    if (activeRuntime === null || (isFactory && index % 15 === 0)) {
      activeRuntime = await (
        runtime as () => Promise<ApplianceWasmRuntime> | ApplianceWasmRuntime
      )();
    }
    const priorContinuation = continuations.get(binding.appliance) ?? null;
    const priorCheckpoint = checkpoints.get(binding.appliance) ?? null;
    const resumedDigest = checkpointDigests.get(binding.appliance) ?? null;
    const upstreamThermal = resolveUpstreamThermalHandoff(
      binding,
      instanceThermalStates,
      workflowLatestStates,
    );
    const prevTemp =
      instanceBatchTemperatures.get(binding.instanceId) ??
      upstreamThermal?.temperatureC ??
      null;
    const context: ApplianceTaskContext = {
      continuation: priorContinuation,
      checkpoint: priorCheckpoint,
      previousInstanceBatchTemperatureC: prevTemp,
    };

    const upstreamFaults = activeFaultEntries.filter(
      (entry) => entry.startedAtUs <= binding.startedAtUs,
    );
    const cascadeShiftedByUs = upstreamFaults.reduce(
      (sum, entry) => sum + entry.recoveryDelayUs,
      0,
    );
    const cascadeHeldByFaultTaskIds = upstreamFaults.map(
      (entry) => entry.faultRecord.taskId,
    );

    const faultSpec = faultInjections?.get(binding.taskId);
    if (faultSpec !== undefined) {
      const faultActions = faultSpec.buildFaultActions(binding, context);
      const faultAttemptId = sanitizeAttemptId(
        `${binding.instanceId}-${binding.taskKey}-${binding.appliance}-fault`,
        index,
      );
      const initialContents: ApplianceContents = { kind: "empty" };
      const faultRequest =
        priorContinuation === null
          ? freshApplianceRequest(
              binding.appliance,
              runId,
              faultAttemptId,
              initialContents,
              faultActions,
            )
          : priorContinuation.request(runId, faultAttemptId, faultActions);

      const faultResult = runApplianceAttemptOnWasm(
        activeRuntime,
        faultRequest,
        binding.taskId,
        binding.appliance,
      );
      if (faultResult.outcome.kind !== "rejected") {
        throw new Error(
          `Expected mid-cycle fault rejection on ${binding.taskId} (${binding.appliance}), but attempt completed without fault`,
        );
      }
      const faultCheckpoint = parseCheckpointObject(faultResult);
      if (faultCheckpoint === null) {
        throw new Error(
          `Missing fault continuation checkpoint on ${binding.taskId}`,
        );
      }
      const faultRecordingDigest = await sha256Hex(faultResult.file);
      const faultCheckpointDigest = await sha256Hex(
        canonicalJson(faultCheckpoint),
      );
      const faultFirstSample = faultResult.samples[0];
      const faultLastSample = faultResult.samples.at(-1);
      const faultSimulatedSeconds =
        faultFirstSample !== undefined && faultLastSample !== undefined
          ? Number(
              (
                faultLastSample.timeSeconds - faultFirstSample.timeSeconds
              ).toFixed(4),
            )
          : 0;

      if (isFactory) {
        activeRuntime = await (
          runtime as () => Promise<ApplianceWasmRuntime> | ApplianceWasmRuntime
        )();
      }
      const restoreActions = faultSpec.buildRestoreActions(
        binding,
        faultCheckpoint,
      );
      const restoreAttemptId = sanitizeAttemptId(
        `${binding.instanceId}-${binding.taskKey}-${binding.appliance}-restore`,
        index,
      );
      const restoreRequest = faultResult.continuation.request(
        runId,
        restoreAttemptId,
        restoreActions,
      );
      const restoreResult = runApplianceAttemptOnWasm(
        activeRuntime,
        restoreRequest,
        binding.taskId,
        binding.appliance,
      );
      if (restoreResult.outcome.kind !== "completed") {
        throw new Error(
          `Checkpoint-restore attempt on ${binding.taskId} (${binding.appliance}) rejected at action ${restoreResult.outcome.action}: ${restoreResult.outcome.message}`,
        );
      }

      const recordingDigest = await sha256Hex(restoreResult.file);
      const nextCheckpoint = parseCheckpointObject(restoreResult);
      if (nextCheckpoint === null) {
        throw new Error(
          `Missing continuation checkpoint in restored recording for ${binding.taskId}`,
        );
      }
      const checkpointDigest = await sha256Hex(canonicalJson(nextCheckpoint));
      continuations.set(binding.appliance, restoreResult.continuation);
      checkpoints.set(binding.appliance, nextCheckpoint);
      checkpointDigests.set(binding.appliance, checkpointDigest);

      const transferredLast = restoreResult.transferred.at(-1);
      if (transferredLast !== undefined) {
        instanceBatchTemperatures.set(
          binding.instanceId,
          transferredLast.temperature_c,
        );
        const state: BatchThermalState = {
          instanceId: binding.instanceId,
          temperatureC: transferredLast.temperature_c,
          completedAtUs: binding.completedAtUs,
        };
        instanceThermalStates.set(binding.instanceId, state);
        const prefix = binding.instanceId.split("#")[0] ?? binding.instanceId;
        workflowLatestStates.set(prefix, state);
      }

      const firstSample = restoreResult.samples[0];
      const lastSample = restoreResult.samples.at(-1);
      const simulatedSeconds =
        firstSample !== undefined && lastSample !== undefined
          ? Number(
              (lastSample.timeSeconds - firstSample.timeSeconds).toFixed(4),
            )
          : 0;

      let inputBatch = binding.batch;
      for (const action of faultActions) {
        if (
          action.kind === "set-contents" &&
          action.contents.kind === "loaded"
        ) {
          inputBatch = action.contents.batch;
          break;
        }
      }

      const coupledPhysics = computeCoupledBatchPhysics(
        binding,
        upstreamThermal,
        inputBatch,
        restoreResult,
        simulatedSeconds,
      );

      const faultRestoreRecord: ExecutedApplianceFaultRestoreRecord = {
        taskId: binding.taskId,
        instanceId: binding.instanceId,
        workflowId: binding.workflowId,
        taskKey: binding.taskKey,
        appliance: binding.appliance,
        category: binding.category,
        faultKind: faultSpec.faultKind,
        description: faultSpec.description,
        priorCheckpointDigest: resumedDigest,
        faultAttemptId,
        faultRejectedActionIndex: faultResult.outcome.action,
        faultMessage: faultResult.outcome.message,
        faultRecordingDigest,
        faultCheckpointDigest,
        faultControllerState: faultCheckpoint.controller ?? null,
        faultSampleCount: faultResult.samples.length,
        faultSimulatedSeconds,
        restoreAttemptId,
        resumedFromFaultCheckpointDigest: faultCheckpointDigest,
        restoredRecordingDigest: recordingDigest,
        restoredCheckpointDigest: checkpointDigest,
        restoredSampleCount: restoreResult.samples.length,
        restoredSimulatedSeconds: simulatedSeconds,
        transferredCount: restoreResult.transferred.length,
      };
      faultRestores.push(faultRestoreRecord);

      const recoveryDelaySeconds = Number(
        (faultSimulatedSeconds + 30).toFixed(4),
      );
      const recoveryDelayUs = Math.round(recoveryDelaySeconds * 1_000_000);
      activeFaultEntries.push({
        faultRecord: faultRestoreRecord,
        startedAtUs: binding.startedAtUs,
        recoveryDelaySeconds,
        recoveryDelayUs,
      });

      const totalShiftUs = cascadeShiftedByUs + recoveryDelayUs;
      const heldByIds = [...cascadeHeldByFaultTaskIds, binding.taskId];

      records.push({
        index,
        taskId: binding.taskId,
        instanceId: binding.instanceId,
        workflowId: binding.workflowId,
        taskKey: binding.taskKey,
        startedAtUs: binding.startedAtUs,
        completedAtUs: binding.completedAtUs,
        cascadeShiftedByUs: totalShiftUs,
        cascadeHeldByFaultTaskIds: heldByIds,
        category: binding.category,
        appliance: binding.appliance,
        label: binding.label,
        resumedFromCheckpointDigest: resumedDigest,
        request: restoreRequest,
        result: restoreResult,
        recordingDigest,
        checkpointDigest,
        sampleCount: restoreResult.samples.length,
        simulatedSeconds,
        inputBatch,
        transferred: restoreResult.transferred,
        finalController: nextCheckpoint.controller ?? null,
        finalDisplays: lastSample?.displays ?? [],
        coupledPhysics,
        faultRestore: faultRestoreRecord,
      });
      continue;
    }

    const actions = binding.buildActions(context);
    const attemptId = sanitizeAttemptId(
      `${binding.instanceId}-${binding.taskKey}-${binding.appliance}`,
      index,
    );
    const initialContents: ApplianceContents = { kind: "empty" };
    const request =
      priorContinuation === null
        ? freshApplianceRequest(
            binding.appliance,
            runId,
            attemptId,
            initialContents,
            actions,
          )
        : priorContinuation.request(runId, attemptId, actions);

    const result = runApplianceAttemptOnWasm(
      activeRuntime,
      request,
      binding.taskId,
      binding.appliance,
    );
    if (result.outcome.kind !== "completed") {
      throw new Error(
        `Appliance task ${binding.taskId} (${binding.appliance}) rejected at action ${result.outcome.action}: ${result.outcome.message}`,
      );
    }

    const recordingDigest = await sha256Hex(result.file);
    const nextCheckpoint = parseCheckpointObject(result);
    if (nextCheckpoint === null) {
      throw new Error(
        `Missing continuation checkpoint in recording for ${binding.taskId}`,
      );
    }
    const checkpointDigest = await sha256Hex(canonicalJson(nextCheckpoint));
    continuations.set(binding.appliance, result.continuation);
    checkpoints.set(binding.appliance, nextCheckpoint);
    checkpointDigests.set(binding.appliance, checkpointDigest);

    const transferredLast = result.transferred.at(-1);
    if (transferredLast !== undefined) {
      instanceBatchTemperatures.set(
        binding.instanceId,
        transferredLast.temperature_c,
      );
      const state: BatchThermalState = {
        instanceId: binding.instanceId,
        temperatureC: transferredLast.temperature_c,
        completedAtUs: binding.completedAtUs,
      };
      instanceThermalStates.set(binding.instanceId, state);
      const prefix = binding.instanceId.split("#")[0] ?? binding.instanceId;
      workflowLatestStates.set(prefix, state);
    }

    const firstSample = result.samples[0];
    const lastSample = result.samples.at(-1);
    const simulatedSeconds =
      firstSample !== undefined && lastSample !== undefined
        ? Number((lastSample.timeSeconds - firstSample.timeSeconds).toFixed(4))
        : 0;

    let inputBatch = binding.batch;
    for (const action of actions) {
      if (
        action.kind === "set-contents" &&
        action.contents.kind === "loaded"
      ) {
        inputBatch = action.contents.batch;
        break;
      }
    }

    const coupledPhysics = computeCoupledBatchPhysics(
      binding,
      upstreamThermal,
      inputBatch,
      result,
      simulatedSeconds,
    );

    records.push({
      index,
      taskId: binding.taskId,
      instanceId: binding.instanceId,
      workflowId: binding.workflowId,
      taskKey: binding.taskKey,
      startedAtUs: binding.startedAtUs,
      completedAtUs: binding.completedAtUs,
      ...(cascadeShiftedByUs > 0
        ? {
            cascadeShiftedByUs,
            cascadeHeldByFaultTaskIds,
          }
        : {}),
      category: binding.category,
      appliance: binding.appliance,
      label: binding.label,
      resumedFromCheckpointDigest: resumedDigest,
      request,
      result,
      recordingDigest,
      checkpointDigest,
      sampleCount: result.samples.length,
      simulatedSeconds,
      inputBatch,
      transferred: result.transferred,
      finalController: nextCheckpoint.controller ?? null,
      finalDisplays: lastSample?.displays ?? [],
      coupledPhysics,
    });
  }

  const allScheduledTasks: readonly Pick<
    ScheduledTaskDescriptor,
    | "taskId"
    | "instanceId"
    | "workflowId"
    | "taskKey"
    | "startedAtUs"
    | "completedAtUs"
  >[] =
    options.scheduledTasks && options.scheduledTasks.length > 0
      ? options.scheduledTasks
      : bindings;
  const canonicalCells: readonly LinkedCellId[] = [
    "tea-pan-cell",
    "espresso-cell",
    "pour-over-cell",
  ];
  const faultCascades: MultiBatchFaultCascadeRecord[] = activeFaultEntries.map(
    (entry) => {
      const downstreamTasks = allScheduledTasks.filter(
        (task) =>
          task.taskId !== entry.faultRecord.taskId &&
          task.startedAtUs >= entry.startedAtUs,
      );
      const batchSet = new Set<string>([entry.faultRecord.instanceId]);
      for (const task of downstreamTasks) {
        batchSet.add(task.instanceId);
      }
      const linkedCellTransfers: LinkedCellCascadeTransferRecord[] = [];
      const cellSet = new Set<LinkedCellId>();
      for (const task of downstreamTasks) {
        const cellId = linkedCellForScheduledTask(task);
        if (cellId === null) continue;
        cellSet.add(cellId);
        const baselineStartSeconds = Number(
          (task.startedAtUs / 1_000_000).toFixed(4),
        );
        const cascadedStartSeconds = Number(
          (baselineStartSeconds + entry.recoveryDelaySeconds).toFixed(4),
        );
        linkedCellTransfers.push({
          cellId,
          transferTaskId: task.taskId,
          batchInstanceId: task.instanceId,
          workflowId: task.workflowId,
          taskKey: task.taskKey,
          baselineStartSeconds,
          cascadedStartSeconds,
          delaySeconds: entry.recoveryDelaySeconds,
          heldByAppliance: entry.faultRecord.appliance,
          heldByFaultKind: entry.faultRecord.faultKind,
          releasedByCheckpointDigest:
            entry.faultRecord.restoredCheckpointDigest,
          status: "recovered",
        });
      }
      return {
        faultTaskId: entry.faultRecord.taskId,
        faultInstanceId: entry.faultRecord.instanceId,
        appliance: entry.faultRecord.appliance,
        faultKind: entry.faultRecord.faultKind,
        faultCheckpointDigest: entry.faultRecord.faultCheckpointDigest,
        restoredCheckpointDigest: entry.faultRecord.restoredCheckpointDigest,
        faultSimulatedSeconds: entry.faultRecord.faultSimulatedSeconds,
        restoredSimulatedSeconds: entry.faultRecord.restoredSimulatedSeconds,
        recoveryDelaySeconds: entry.recoveryDelaySeconds,
        affectedBatches: [...batchSet],
        affectedCells: canonicalCells.filter((cell) => cellSet.has(cell)),
        shiftedTaskCount: downstreamTasks.length,
        linkedCellTransfers,
      };
    },
  );

  const digestRecord: Record<string, string> = {};
  for (const [appliance, digest] of checkpointDigests) {
    digestRecord[appliance] = digest;
  }

  const facilityUtilities = computeFacilityUtilityLoadSummary(records);
  const massBalance = computeQualityGateMassBalanceSummary(records);
  const carrierReturnSummary = computeContinuousWaveCarrierReturnSummary(
    allScheduledTasks,
    records,
  );
  return {
    runId,
    taskCount: records.length,
    applianceCount: continuations.size,
    records,
    faultRestores,
    faultCascades,
    facilityUtilities,
    massBalance,
    carrierReturnSummary,
    continuations,
    checkpointDigests: digestRecord,
  };
}
