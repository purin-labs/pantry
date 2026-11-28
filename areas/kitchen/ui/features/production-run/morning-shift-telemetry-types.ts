import type { ApplianceCategory } from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";

export type MorningShiftApplianceCode =
  | "ohaus-ranger-3000"
  | "hobart-hl200"
  | "waring-wsg60"
  | "vitamix-quiet-one"
  | "maruzen-mih-02c"
  | "vollrath-59500p"
  | "maruzen-mbco-5e"
  | "hoshizaki-rt-120snj"
  | "winterhalter-uc-l"
  | "severin-sm-3587"
  | "la-marzocco-linea-classic-s-2g"
  | "pastry-bench";

export type ApplianceFaultRecord = Readonly<{
  appliance: MorningShiftApplianceCode;
  code: string;
  reason: string;
  remediation: string;
  faultedAtSeconds: number;
  checkpointDigest: string;
  restored: boolean;
  restoredAtSeconds: number | null;
}>;

export type SynchronizedApplianceState = Readonly<{
  appliance: MorningShiftApplianceCode;
  displayName: string;
  category: ApplianceCategory;
  stationId: string;
  status: "idle" | "active" | "completed" | "fault";
  activeTaskId: string | null;
  lastTaskId: string | null;
  label: string;
  programSummary: string;
  temperatureC: number;
  rpm: number;
  massG: number;
  powerWatts: number;
  pressureBar: number;
  torqueNm: number;
  viscosityPas: number;
  acousticNoiseDba: number;
  vibrationMmPerSecRms: number;
  peakAcousticNoiseDba: number;
  peakVibrationMmPerSecRms: number;
  isRotary: boolean;
  doorOpenRatio: number;
  thermalPlumeIntensity: number;
  liquidColorHex: number;
  progress: number;
  completedCount: number;
  totalCount: number;
  fault: ApplianceFaultRecord | null;
}>;

type CobotCascadeHoldRecord = Readonly<{
  heldByAppliance: MorningShiftApplianceCode;
  heldByFaultCode: string;
  affectedBatches: readonly string[];
  delaySeconds: number;
  restored: boolean;
  checkpointDigest: string;
}>;

type MorningShiftBatchCascadeItem = Readonly<{
  batchId: string;
  workflowLabel: string;
  cellId: "tea-pan-cell" | "espresso-cell" | "pour-over-cell";
  delaySeconds: number;
  status: "held" | "recovered";
}>;

export type MorningShiftFaultCascadeSummary = Readonly<{
  activeFaultCount: number;
  restoredFaultCount: number;
  totalRecoveryDelaySeconds: number;
  status: "nominal" | "held" | "recovered";
  heldCells: readonly ("tea-pan-cell" | "espresso-cell" | "pour-over-cell")[];
  recoveredCells: readonly (
    "tea-pan-cell" | "espresso-cell" | "pour-over-cell"
  )[];
  affectedBatches: readonly MorningShiftBatchCascadeItem[];
  sourceFaults: readonly ApplianceFaultRecord[];
}>;

export type MorningShiftLotMassRecord = Readonly<{
  batchId: string;
  workflowLabel: string;
  gateTaskId: string;
  gateKind:
    | "bake-maillard-gate"
    | "tea-extraction-gate"
    | "drink-dose-gate"
    | "espresso-extraction-gate"
    | "pour-over-extraction-gate";
  measuredMetric: string;
  outcome: "accepted" | "rejected-rework";
  inputMassGrams: number;
  acceptedYieldGrams: number;
  rejectedScrapGrams: number;
  qcSampleGrams: number;
  byproductOrLossGrams: number;
  reworkAction: string;
}>;

export type MorningShiftMassAccountingSummary = Readonly<{
  evaluatedLots: number;
  acceptedLots: number;
  rejectedLots: number;
  totalInputGrams: number;
  totalAcceptedGrams: number;
  totalRejectedScrapGrams: number;
  totalQcSampleGrams: number;
  totalByproductOrLossGrams: number;
  firstPassYieldPercent: number;
  reworkLoopCount: number;
  lots: readonly MorningShiftLotMassRecord[];
}>;

export type HvacPsychrometricTelemetry = Readonly<{
  roomDryBulbC: number;
  relativeHumidityPercent: number;
  wetBulbC: number;
  dewPointC: number;
  humidityRatioGPerKg: number;
  specificEnthalpyKjPerKg: number;
  sensibleHeatRejectionWatts: number;
  latentMoistureGramsPerMin: number;
  canopyHoodExhaustCfm: number;
  hvacCoolingLoadWatts: number;
  airChangesPerHour: number;
  status: "nominal" | "humid-plume" | "high-sensible-load";
}>;

export type FacilityAcousticVibrationTelemetry = Readonly<{
  roomCompositeNoiseDba: number;
  peakApplianceNoiseDba: number;
  peakVibrationMmPerSecRms: number;
  dominantRotaryAppliance: MorningShiftApplianceCode;
  activeRotaryCount: number;
  isoVibrationClass: "nominal" | "elevated-rotary" | "iso-alert";
}>;

export type MorningShiftChillerDoorInfiltrationEvent = Readonly<{
  cycleIndex: number;
  taskId: string;
  batchLabel: string;
  phase:
    | "refrigerating"
    | "door-infiltration-pulldown"
    | "defrost-active"
    | "post-defrost-recovery";
  doorOpenSeconds: number;
  infiltrationHeatKj: number;
  moistureIngressGrams: number;
  cabinetPeakC: number;
  cabinetExitC: number;
  evaporatorCoilC: number;
  frostAccumulatedGrams: number;
  defrostTriggered: boolean;
  condensateDrainedMl: number;
}>;

export type MorningShiftChillerColdCellTelemetry = Readonly<{
  phase:
    | "refrigerating"
    | "door-infiltration-pulldown"
    | "defrost-active"
    | "post-defrost-recovery";
  cabinetAirC: number;
  cabinetInfiltrationPeakC: number;
  evaporatorCoilC: number;
  evaporatorFrostGrams: number;
  peakFrostGrams: number;
  defrostCycleCount: number;
  totalCondensateDrainedMl: number;
  doorOpeningsCount: number;
  totalInfiltrationHeatKj: number;
  compressorRpm: number;
  compressorDutyPercent: number;
  defrostHeaterWatts: number;
  copEfficiency: number;
  events: readonly MorningShiftChillerDoorInfiltrationEvent[];
}>;

export type MorningShiftDishwasherCycleEvent = Readonly<{
  cycleIndex: number;
  taskId: string;
  vesselLabel: string;
  soilLoadCategory:
    | "brown-butter-mould"
    | "sesame-oil-vessel"
    | "tannin-tea-pan"
    | "carafe-and-jug";
  washTankC: number;
  rinseBoilerC: number;
  detergentDosedMl: number;
  rinseAidDosedMl: number;
  washBathPh: number;
  sanitizerPpm: number;
  thermalHue: number;
  incomingWaterC: number;
  preheatedWaterC: number;
  greywaterDrainC: number;
  heatRecoveredKj: number;
  recoveryEfficiencyPercent: number;
}>;

export type MorningShiftDishwasherTelemetry = Readonly<{
  status: "sanitizing-nominal" | "high-soil-dosing" | "heat-recovery-active";
  completedCycles: number;
  totalCycles: number;
  washTankC: number;
  rinseBoilerC: number;
  detergentConcentrationGPerL: number;
  totalDetergentDosedMl: number;
  totalRinseAidDosedMl: number;
  sanitizerPpm: number;
  washBathPh: number;
  thermalHue: number;
  incomingMakeupWaterC: number;
  preheatedWaterC: number;
  greywaterDrainC: number;
  totalGreywaterRecoveredKj: number;
  totalRecoveredWh: number;
  heatRecoveryEfficiencyPercent: number;
  cycles: readonly MorningShiftDishwasherCycleEvent[];
}>;

export type MorningShiftEspressoShotEvent = Readonly<{
  shotIndex: number;
  taskId: string;
  orderLabel: string;
  grouphead: "left" | "right";
  brewBoilerC: number;
  groupheadEntryC: number;
  groupheadMinC: number;
  thermalDipC: number;
  pidRecoverySeconds: number;
  pidDutyPercent: number;
  steamBoilerPressureBar: number;
  steamDropBar: number;
  steamRecoverySeconds: number;
}>;

export type MorningShiftEspressoBoilerTelemetry = Readonly<{
  status: "pid-locked" | "back-to-back-recovery" | "steam-draw-recovery";
  brewBoilerSetpointC: number;
  brewBoilerTempC: number;
  minGroupheadTempC: number;
  maxGroupheadThermalDipC: number;
  meanPidRecoverySeconds: number;
  steamBoilerSetpointC: number;
  steamBoilerPressureBar: number;
  maxSteamDropBar: number;
  meanSteamRecoverySeconds: number;
  shots: readonly MorningShiftEspressoShotEvent[];
}>;

export type MorningShiftOvenDeckEvent = Readonly<{
  cycleIndex: number;
  taskId: string;
  batchLabel: string;
  deckZone: "front-lower-nominal" | "middle-rear-hotspot" | "upper-deck";
  chamberC: number;
  chamberRhPercent: number;
  damperOpenRatio: number;
  steamInjectionMl: number;
  steamVentingGps: number;
  radiantFluxKwPerSqM: number;
  convectiveFluxKwPerSqM: number;
  totalFluxKwPerSqM: number;
  moistureDiffusivitySqMPerSec: number;
  surfaceWaterActivityAw: number;
}>;

export type MorningShiftOvenVentingRadiantTelemetry = Readonly<{
  status: "damper-venting" | "steam-pulse-closed" | "hotspot-scorching-alert";
  nominalDeckFluxKwPerSqM: number;
  hotspotDeckFluxKwPerSqM: number;
  peakSteamVentingGps: number;
  totalSteamInjectedMl: number;
  peakMoistureDiffusivitySqMPerSec: number;
  minSurfaceWaterActivityAw: number;
  decks: readonly MorningShiftOvenDeckEvent[];
}>;

export type MorningShiftHobCycleEvent = Readonly<{
  cycleIndex: number;
  taskId: string;
  appliance: "maruzen-mih-02c" | "vollrath-59500p";
  vesselLabel: string;
  coilFrequencyKhz: number;
  couplingEfficiencyPercent: number;
  panCenterC: number;
  panRimC: number;
  radialGradientC: number;
  boilOffGps: number;
  evaporatedGrams: number;
}>;

export type MorningShiftHobCoilThermalTelemetry = Readonly<{
  status: "igbt-coupled" | "browning-high-gradient" | "simmer-duty-modulated";
  meanCouplingEfficiencyPercent: number;
  maxRadialGradientC: number;
  peakPanCenterC: number;
  peakBoilOffGps: number;
  totalEvaporatedGrams: number;
  cycles: readonly MorningShiftHobCycleEvent[];
}>;

export type MorningShiftScaleWeighEvent = Readonly<{
  weighIndex: number;
  taskId: string;
  ingredientLabel: string;
  targetGrams: number;
  settledGrams: number;
  settlingTimeSeconds: number;
  zeroTareDriftMg: number;
  airDraftPeakMg: number;
  filterRejectionDb: number;
  stabilityStatus: "locked-stable" | "draft-filtered";
}>;

export type MorningShiftPrecisionScaleTelemetry = Readonly<{
  status: "locked-stable" | "draft-filtered";
  totalWeighings: number;
  meanSettlingTimeSeconds: number;
  maxSettlingTimeSeconds: number;
  maxZeroTareDriftMg: number;
  peakAirDraftDisturbanceMg: number;
  meanFilterRejectionDb: number;
  weighings: readonly MorningShiftScaleWeighEvent[];
}>;

export type MorningShiftMixerCycleEvent = Readonly<{
  cycleIndex: number;
  taskId: string;
  batchLabel: string;
  mixStage: "dry-blend-speed1" | "batter-emulsify-speed2";
  agitatorRpm: number;
  specificWorkWhPerKg: number;
  meanShaftTorqueNm: number;
  torqueRippleNmPeakToPeak: number;
  viscousHeatingWatts: number;
  bowlWallHeatWatts: number;
  emulsionIndex: number;
}>;

export type MorningShiftPlanetaryMixerTelemetry = Readonly<{
  status: "emulsifying" | "guard-interlock-open" | "homogenized-ready";
  totalSpecificWorkWhPerKg: number;
  peakShaftTorqueNm: number;
  maxTorqueRippleNmPeakToPeak: number;
  peakViscousHeatingWatts: number;
  meanEmulsionIndex: number;
  cycles: readonly MorningShiftMixerCycleEvent[];
}>;

export type MorningShiftFrotherCycleEvent = Readonly<{
  cycleIndex: number;
  taskId: string;
  drinkLabel: string;
  whiskRpm: number;
  vortexShearRateInverseSec: number;
  microfoamOverrunPercent: number;
  bubbleDiameterMicrons: number;
  pitcherExitC: number;
  wheyDenaturationPercent: number;
  windowStatus: "optimal-microfoam-window" | "under-aerated" | "scald-risk";
}>;

export type MorningShiftMilkFrotherTelemetry = Readonly<{
  status: "optimal-microfoam-window" | "vortex-aerating";
  meanMicrofoamOverrunPercent: number;
  peakVortexShearRateInverseSec: number;
  meanBubbleDiameterMicrons: number;
  meanWheyDenaturationPercent: number;
  maxPitcherExitTempC: number;
  cycles: readonly MorningShiftFrotherCycleEvent[];
}>;

type MorningShiftCarrierPoolId =
  | "moulds"
  | "cooling-grids"
  | "shared-pans"
  | "mixing-bowls"
  | "tea-receivers"
  | "beverage-jugs";

export type MorningShiftCarrierPoolRecord = Readonly<{
  poolId: MorningShiftCarrierPoolId;
  label: string;
  carrierCount: number;
  inUseCount: number;
  washingCount: number;
  cleanAvailableCount: number;
  acquisitions: number;
  washCycles: number;
  returns: number;
  reuseRatio: number;
  meanTurnaroundSeconds: number;
  status: "closed-loop-cycling" | "washing-return" | "ready";
}>;

export type MorningShiftContinuousWaveTelemetry = Readonly<{
  status: "multi-wave-active" | "carrier-return-cycling" | "wave-settled";
  activeWaveIndex: number;
  waveCount: number;
  completedWaveCount: number;
  waveCadenceMinutes: number;
  totalCarrierAcquisitions: number;
  totalWashCycles: number;
  totalCarrierReturns: number;
  overallReuseRatio: number;
  meanTurnaroundSeconds: number;
  peakTurnaroundSeconds: number;
  pools: readonly MorningShiftCarrierPoolRecord[];
}>;

type MorningShiftFactoryStationId =
  | "station-oven"
  | "station-chiller"
  | "station-wash"
  | "station-hob"
  | "station-mixer"
  | "station-scale"
  | "station-sesame-prep";

export type MorningShiftHandoffEvent = Readonly<{
  handoffId: string;
  stationId: MorningShiftFactoryStationId;
  stationLabel: string;
  outgoingOperator: string;
  incomingOperator: string;
  windowStartSeconds: number;
  handoffDurationSeconds: number;
  activeBatchId: string;
  checklistNote: string;
  status: "completed" | "relieved-active" | "scheduled";
}>;

export type MorningShiftBreakHandoffTelemetry = Readonly<{
  status: "nominal" | "relief-active" | "handoff-pending";
  breakPolicy: "staggered-relief" | "fixed-window" | "continuous-no-break";
  scheduledBreakWindows: number;
  completedBreakMinutes: number;
  reliefCoveragePercent: number;
  totalStationHandoffs: number;
  meanHandoffDurationSeconds: number;
  unattendedThermalViolations: number;
  handoffs: readonly MorningShiftHandoffEvent[];
}>;

export type MorningShiftAisleTransitEvent = Readonly<{
  transitId: string;
  corridorLabel: string;
  fromStation: string;
  toStation: string;
  operatorLabel: string;
  distanceMeters: number;
  nominalWalkSeconds: number;
  congestionYieldSeconds: number;
  effectiveSpeedMps: number;
  yieldReason: string;
}>;

export type MorningShiftWalkCongestionTelemetry = Readonly<{
  status: "free-flow" | "bidirectional-yield" | "aisle-congested";
  walkSpeedPreset: "standard" | "brisk" | "congested-aisle";
  nominalWalkSpeedMps: number;
  effectiveWalkSpeedMps: number;
  aisleClearWidthMeters: number;
  totalCrossAisleTransits: number;
  totalDistanceWalkedMeters: number;
  aisleYieldEvents: number;
  totalCongestionWaitSeconds: number;
  transitOverheadPercent: number;
  transits: readonly MorningShiftAisleTransitEvent[];
}>;

export type FacilityUtilityTelemetry = Readonly<{
  totalPowerWatts: number;
  ratedBusCapacityWatts: number;
  breakerUtilizationPercent: number;
  phaseLoadsWatts: Readonly<{ l1: number; l2: number; l3: number }>;
  phaseImbalancePercent: number;
  lineVoltageVolts: number;
  waterStaticSupplyBar: number;
  waterFlowLpm: number;
  waterManifoldPressureBar: number;
  hvacPsychrometrics: HvacPsychrometricTelemetry;
  acousticsAndVibration: FacilityAcousticVibrationTelemetry;
  chillerColdCell: MorningShiftChillerColdCellTelemetry;
  dishwasherWarewash: MorningShiftDishwasherTelemetry;
  espressoBoiler: MorningShiftEspressoBoilerTelemetry;
  ovenVentingRadiant: MorningShiftOvenVentingRadiantTelemetry;
  hobCoilThermal: MorningShiftHobCoilThermalTelemetry;
  precisionScale: MorningShiftPrecisionScaleTelemetry;
  planetaryMixer: MorningShiftPlanetaryMixerTelemetry;
  milkFrother: MorningShiftMilkFrotherTelemetry;
  continuousWaveCarrierReturn: MorningShiftContinuousWaveTelemetry;
  shiftBreakAndHandoff: MorningShiftBreakHandoffTelemetry;
  aisleLocomotionAndCongestion: MorningShiftWalkCongestionTelemetry;
  status: "nominal" | "high-draw" | "voltage-sag";
}>;

export type SynchronizedCobotTransferState = Readonly<{
  cellId: string;
  robot: string;
  status: "idle" | "executing" | "handoff" | "recovery" | "cascade-held";
  taskId: string | null;
  label: string;
  step: number;
  committedSeconds: number;
  completedTransfers: number;
  totalTransfers: number;
  progress: number;
  phase: string;
  jointAnglesRad: readonly [number, number, number, number, number, number];
  endEffectorPoseMeters: readonly [number, number, number];
  gripperWidthMm: number;
  gripperForceNewtons: number;
  payloadMassKg: number;
  shoulderTorqueNm: number;
  cascadeHold: CobotCascadeHoldRecord | null;
}>;
