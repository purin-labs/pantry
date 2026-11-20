import type {
  CompiledScenario,
  LogisticsView,
  TaskDefinition,
  TaskView,
} from "@purin-labs/production-simulation";
import {
  morningShiftApplianceTask,
} from "@purin-labs/production-simulation/recipes/bakery/bakery-shift";
import type {
  ApplianceCategory,
  RecipeApplianceTaskBinding,
} from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";
import type { FactoryStationSource } from "../workflow-simulator/spatial/factory-stations";
import type { OvenLiveFrame } from "@purin-labs/production-simulation/runs/oven-live-physics";
import {
  appendBeverageCobotCells,
  computeCobotKinematicsAndDynamics,
  type BaseCobotTransferEntry,
} from "./morning-shift-cobot-kinematics";

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
    | "tea-pan-cell"
    | "espresso-cell"
    | "pour-over-cell"
  )[];
  affectedBatches: readonly MorningShiftBatchCascadeItem[];
  sourceFaults: readonly ApplianceFaultRecord[];
}>;

type MorningShiftLotMassRecord = Readonly<{
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

type HvacPsychrometricTelemetry = Readonly<{
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

type FacilityAcousticVibrationTelemetry = Readonly<{
  roomCompositeNoiseDba: number;
  peakApplianceNoiseDba: number;
  peakVibrationMmPerSecRms: number;
  dominantRotaryAppliance: MorningShiftApplianceCode;
  activeRotaryCount: number;
  isoVibrationClass: "nominal" | "elevated-rotary" | "iso-alert";
}>;

type MorningShiftChillerDoorInfiltrationEvent = Readonly<{
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

type MorningShiftChillerColdCellTelemetry = Readonly<{
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

type MorningShiftDishwasherCycleEvent = Readonly<{
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

type MorningShiftDishwasherTelemetry = Readonly<{
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

type MorningShiftEspressoShotEvent = Readonly<{
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

type MorningShiftEspressoBoilerTelemetry = Readonly<{
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

type MorningShiftOvenDeckEvent = Readonly<{
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

type MorningShiftOvenVentingRadiantTelemetry = Readonly<{
  status: "damper-venting" | "steam-pulse-closed" | "hotspot-scorching-alert";
  nominalDeckFluxKwPerSqM: number;
  hotspotDeckFluxKwPerSqM: number;
  peakSteamVentingGps: number;
  totalSteamInjectedMl: number;
  peakMoistureDiffusivitySqMPerSec: number;
  minSurfaceWaterActivityAw: number;
  decks: readonly MorningShiftOvenDeckEvent[];
}>;

type MorningShiftHobCycleEvent = Readonly<{
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

type MorningShiftHobCoilThermalTelemetry = Readonly<{
  status: "igbt-coupled" | "browning-high-gradient" | "simmer-duty-modulated";
  meanCouplingEfficiencyPercent: number;
  maxRadialGradientC: number;
  peakPanCenterC: number;
  peakBoilOffGps: number;
  totalEvaporatedGrams: number;
  cycles: readonly MorningShiftHobCycleEvent[];
}>;

type MorningShiftScaleWeighEvent = Readonly<{
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

type MorningShiftPrecisionScaleTelemetry = Readonly<{
  status: "locked-stable" | "draft-filtered";
  totalWeighings: number;
  meanSettlingTimeSeconds: number;
  maxSettlingTimeSeconds: number;
  maxZeroTareDriftMg: number;
  peakAirDraftDisturbanceMg: number;
  meanFilterRejectionDb: number;
  weighings: readonly MorningShiftScaleWeighEvent[];
}>;

type MorningShiftMixerCycleEvent = Readonly<{
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

type MorningShiftPlanetaryMixerTelemetry = Readonly<{
  status: "emulsifying" | "guard-interlock-open" | "homogenized-ready";
  totalSpecificWorkWhPerKg: number;
  peakShaftTorqueNm: number;
  maxTorqueRippleNmPeakToPeak: number;
  peakViscousHeatingWatts: number;
  meanEmulsionIndex: number;
  cycles: readonly MorningShiftMixerCycleEvent[];
}>;

type MorningShiftFrotherCycleEvent = Readonly<{
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

type MorningShiftMilkFrotherTelemetry = Readonly<{
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

type MorningShiftCarrierPoolRecord = Readonly<{
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

type MorningShiftHandoffEvent = Readonly<{
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

type MorningShiftAisleTransitEvent = Readonly<{
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

export const MORNING_SHIFT_STATIONS: readonly FactoryStationSource[] = [
  {
    id: "station-scale",
    label: "Scale · Ohaus",
    model: "scale-station",
    x: -4.6,
    z: -2.2,
    stores: [
      "prep-vessels",
      "prep-bench",
      "clean-trays",
      "filled-moulds",
      "braise-prep",
      "pie-bench",
    ],
    primary: "filled-moulds",
    resources: ["scale"],
    locations: ["prep"],
  },
  {
    id: "station-mixer",
    label: "Mixer · KPL9000S",
    model: "mixer-station",
    x: -2.8,
    z: -2.2,
    stores: [
      "clean-bowl",
      "hazelnut-batter-holding",
      "coffee-batter-holding",
      "matcha-batter-holding",
      "black-sesame-batter-holding",
    ],
    primary: "clean-bowl",
    resources: [],
    locations: [],
  },
  {
    id: "station-sesame-prep",
    label: "Grinder & Blender",
    model: "sesame-prep-station",
    x: -1.0,
    z: -2.2,
    stores: ["grinder-bowl", "blender-jug", "roasted-sesame-tray"],
    primary: "blender-jug",
    resources: ["grinder", "blender"],
    locations: ["sesame-station"],
  },
  {
    id: "station-hob",
    label: "Induction Hobs",
    model: "dual-hob-station",
    x: 1.0,
    z: -2.2,
    stores: ["hob", "heatproof-rest", "braise-hob-positions"],
    primary: "hob",
    resources: ["hob-power", "braise-hob"],
    locations: ["hob"],
  },
  {
    id: "station-oven",
    label: "Oven · MBCO-4ME",
    model: "oven",
    x: 3.0,
    z: -2.2,
    stores: ["oven-mould", "oven-roast-tray", "oven-pie-trays"],
    primary: "oven-mould",
    resources: ["oven"],
    locations: ["oven"],
  },
  {
    id: "station-chiller",
    label: "Chiller & Rack",
    model: "chiller-rack-station",
    x: 4.8,
    z: -2.2,
    stores: [
      "loaded-grids",
      "empty-grids",
      "cooling-mould",
      "chilled-concentrate",
      "pan-staging-rack",
      "shortcrust-fridge",
      "steak-and-pepper-filling-fridge",
      "beef-bourguignon-filling-fridge",
      "pie-cooling-rack",
      "concentrate-fridge",
      "black-tea-ginger-decoction-fridge",
      "milk-tea-ginger-decoction-fridge",
    ],
    primary: "loaded-grids",
    resources: ["cooling-bath"],
    locations: ["cooling"],
  },
  {
    id: "station-wash",
    label: "Wash · UC-L",
    model: "dishwasher-sink-station",
    x: -3.6,
    z: 2.0,
    stores: [
      "wash-pans",
      "clean-pans",
      "wash-receivers",
      "mould-sink",
      "sink-vessels",
      "wash-area",
      "clean-braise-pans",
      "braise-pan-wash",
      "clean-pie-trays",
      "pie-tray-wash",
    ],
    primary: "clean-pans",
    resources: ["sink"],
    locations: ["sink"],
  },
  {
    id: "station-beverage-bar",
    label: "Coffee, Tea & Frother",
    model: "beverage-frother-station",
    x: 1.35,
    z: 2.0,
    stores: [
      "receiving-position",
      "frother-jug",
      "clean-jug",
      "pan-staging-table",
      "bar-hob",
    ],
    primary: "receiving-position",
    resources: [
      "bar-scale",
      "bar-hob-power",
      "frother",
      "espresso-machine",
      "espresso-cup",
      "coffee-grinder",
      "pour-over-station",
      "pour-over-arm",
      "gooseneck-kettle",
    ],
    locations: ["tea-station", "coffee-station"],
  },
  {
    id: "station-packing",
    label: "Packing",
    model: "packing-table",
    x: 4.2,
    z: 2.0,
    stores: ["packing-grid", "pie-packing"],
    primary: "packing-grid",
    resources: ["packing"],
    locations: ["packing"],
  },
];

type ApplianceSpec = Readonly<{
  appliance: MorningShiftApplianceCode;
  displayName: string;
  category: ApplianceCategory;
  stationId: string;
  idleTemperatureC: number;
  warmStandbyC: number;
}>;

const MORNING_SHIFT_APPLIANCE_SPECS: readonly ApplianceSpec[] = [
  {
    appliance: "ohaus-ranger-3000",
    displayName: "Ohaus Ranger 3000",
    category: "weigh",
    stationId: "station-scale",
    idleTemperatureC: 20,
    warmStandbyC: 20,
  },
  {
    appliance: "hobart-hl200",
    displayName: "Hobart HL200",
    category: "mixer",
    stationId: "station-mixer",
    idleTemperatureC: 21,
    warmStandbyC: 24,
  },
  {
    appliance: "waring-wsg60",
    displayName: "Waring WSG60",
    category: "grinder",
    stationId: "station-sesame-prep",
    idleTemperatureC: 21,
    warmStandbyC: 28,
  },
  {
    appliance: "vitamix-quiet-one",
    displayName: "Vitamix Quiet One",
    category: "blender",
    stationId: "station-sesame-prep",
    idleTemperatureC: 21,
    warmStandbyC: 46,
  },
  {
    appliance: "maruzen-mih-02c",
    displayName: "Maruzen MIH-02C",
    category: "hob",
    stationId: "station-hob",
    idleTemperatureC: 22,
    warmStandbyC: 54,
  },
  {
    appliance: "vollrath-59500p",
    displayName: "Vollrath 59500P",
    category: "hob",
    stationId: "station-hob",
    idleTemperatureC: 22,
    warmStandbyC: 52,
  },
  {
    appliance: "maruzen-mbco-5e",
    displayName: "Maruzen MBCO-5E",
    category: "oven",
    stationId: "station-oven",
    idleTemperatureC: 24,
    warmStandbyC: 165,
  },
  {
    appliance: "hoshizaki-rt-120snj",
    displayName: "Hoshizaki RT-120SNJ",
    category: "chiller",
    stationId: "station-chiller",
    idleTemperatureC: 4,
    warmStandbyC: 4,
  },
  {
    appliance: "severin-sm-3587",
    displayName: "Severin SM 3587",
    category: "milk-frother",
    stationId: "station-beverage-bar",
    idleTemperatureC: 21,
    warmStandbyC: 44,
  },
  {
    appliance: "la-marzocco-linea-classic-s-2g",
    displayName: "La Marzocco Linea Classic S 2G",
    category: "espresso",
    stationId: "station-beverage-bar",
    idleTemperatureC: 22,
    warmStandbyC: 93,
  },
  {
    appliance: "winterhalter-uc-l",
    displayName: "Winterhalter UC-L",
    category: "dishwasher",
    stationId: "station-wash",
    idleTemperatureC: 25,
    warmStandbyC: 60,
  },
  {
    appliance: "pastry-bench",
    displayName: "Marble Pie Pastry Bench",
    category: "pastry-bench",
    stationId: "station-scale",
    idleTemperatureC: 16,
    warmStandbyC: 16,
  },
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function workflowMapForScenario(
  scenario: CompiledScenario,
): Readonly<{
  byArrivalPrefix: ReadonlyMap<string, string>;
  definitions: ReadonlyMap<string, TaskDefinition>;
}> {
  const byArrivalPrefix = new Map<string, string>();
  for (const arrival of scenario.arrivals) {
    byArrivalPrefix.set(arrival.id, arrival.workflow);
  }
  const definitions = new Map<string, TaskDefinition>();
  for (const wf of scenario.workflows) {
    byArrivalPrefix.set(wf.id, wf.id);
    for (const td of wf.tasks) {
      definitions.set(`${wf.id}/${td.key}`, td);
    }
  }
  return { byArrivalPrefix, definitions };
}

function bindLogisticsTask(
  task: TaskView,
  byArrivalPrefix: ReadonlyMap<string, string>,
  definitions: ReadonlyMap<string, TaskDefinition>,
): RecipeApplianceTaskBinding | null {
  if (task.subject.kind !== "workflow") return null;
  const instanceId = task.subject.instance;
  const taskKey = task.subject.key;
  const hashIdx = instanceId.lastIndexOf("#");
  const prefix = hashIdx >= 0 ? instanceId.slice(0, hashIdx) : instanceId;
  const workflowId = byArrivalPrefix.get(prefix) ?? prefix;
  const definition = definitions.get(`${workflowId}/${taskKey}`) ?? null;
  const startedAtUs =
    task.kind === "executing" ||
    task.kind === "completed" ||
    task.kind === "failed" ||
    task.kind === "recovery-required" ||
    task.kind === "recovering" ||
    task.kind === "recovery-failed"
      ? task.startedAt
      : 0;
  const completedAtUs =
    task.kind === "completed"
      ? task.completedAt
      : task.kind === "executing" && task.completesAt !== null
        ? task.completesAt
        : startedAtUs + 30_000_000;
  return morningShiftApplianceTask({
    taskId: task.id,
    instanceId,
    workflowId,
    taskKey,
    startedAtUs,
    completedAtUs,
    definition,
  });
}

function newtonCooling(
  peakC: number,
  equilibriumC: number,
  elapsedSeconds: number,
  tauSeconds: number,
): number {
  if (elapsedSeconds <= 0 || tauSeconds <= 0) return peakC;
  return (
    equilibriumC +
    (peakC - equilibriumC) * Math.exp(-elapsedSeconds / tauSeconds)
  );
}

function deriveApplianceTelemetry(
  spec: ApplianceSpec,
  binding: RecipeApplianceTaskBinding | null,
  status: "idle" | "active" | "completed",
  progress: number,
  completedCount: number,
  idleElapsedSeconds = 0,
  faultElapsedSeconds: number | null = null,
): Readonly<{
  programSummary: string;
  temperatureC: number;
  rpm: number;
  massG: number;
  powerWatts: number;
  pressureBar: number;
  torqueNm: number;
  viscosityPas: number;
  doorOpenRatio: number;
  thermalPlumeIntensity: number;
  liquidColorHex: number;
}> {
  const massG =
    binding?.batch !== null && binding?.batch !== undefined
      ? Math.round(binding.batch.mass_kg * 1000)
      : 0;
  const key = binding?.taskKey ?? "";
  const wf = binding?.workflowId ?? "";
  const isFaulted = faultElapsedSeconds !== null;

  switch (spec.appliance) {
    case "ohaus-ranger-3000": {
      const batchTemp =
        key === "standardize-yield"
          ? 76
          : (binding?.batch?.temperature_c ?? spec.idleTemperatureC);
      const temp =
        status === "active"
          ? batchTemp
          : completedCount > 0
            ? newtonCooling(batchTemp, spec.idleTemperatureC, idleElapsedSeconds, 140)
            : spec.idleTemperatureC;
      const activeMass = status === "active" || completedCount > 0 ? massG : 0;
      return {
        programSummary:
          status === "active"
            ? `Weigh · ${massG} g`
            : completedCount > 0
              ? `Stable · ${massG} g`
              : "Tare 0 g",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: activeMass,
        powerWatts: status === "active" ? 9 : 4,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio: 0,
        thermalPlumeIntensity:
          temp > 60 ? clamp01((temp - 60) / 40) * 0.45 : 0,
        liquidColorHex: wf.includes("sesame")
          ? 0x2d2c32
          : wf.includes("tea")
            ? 0xc87f28
            : 0xe7d3a2,
      };
    }
    case "hobart-hl200": {
      const viscosityPas =
        status === "active"
          ? Number((1.8 + 2.8 * smoothProgress(progress)).toFixed(2))
          : completedCount > 0
            ? 4.6
            : 0;
      const torqueNm =
        status === "active" && !isFaulted
          ? Number((4.2 + 1.35 * viscosityPas).toFixed(2))
          : 0;
      const omega = ((status === "active" && !isFaulted ? 185 : 0) * 2 * Math.PI) / 60;
      const mechWatts = torqueNm * omega;
      const temp =
        status === "active"
          ? 21.5 + 4.8 * progress
          : completedCount > 0
            ? newtonCooling(26.3, spec.idleTemperatureC, idleElapsedSeconds, 240)
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? `Planetary #2 · 185 RPM · ${torqueNm.toFixed(1)} N·m`
            : completedCount > 0
              ? "Stopped · Bowl clean"
              : "Standby · 20 qt",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 185 : 0,
        massG: status === "active" ? Math.max(375, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? Math.round(95 + mechWatts * 1.18)
            : 12,
        pressureBar: 1.01,
        torqueNm,
        viscosityPas,
        doorOpenRatio: isFaulted ? 1 : 0,
        thermalPlumeIntensity: 0,
        liquidColorHex: 0xe7d3a2,
      };
    }
    case "waring-wsg60": {
      const peakC = 41.5;
      const temp =
        status === "active"
          ? 24 + (peakC - 24) * progress
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 125)
            : spec.idleTemperatureC;
      const viscosityPas =
        status === "active"
          ? Number((3.4 + 9.0 * progress).toFixed(2))
          : completedCount > 0
            ? 12.4
            : 0;
      const torqueNm =
        status === "active" && !isFaulted
          ? Number((0.28 + 0.025 * viscosityPas).toFixed(2))
          : 0;
      return {
        programSummary:
          status === "active"
            ? "Pulse Grind · 18,000 RPM"
            : completedCount > 0
              ? "Paste ground · 220 g"
              : "Standby",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 18000 : 0,
        massG: status === "active" ? Math.max(220, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 980 : 6,
        pressureBar: 1.01,
        torqueNm,
        viscosityPas,
        doorOpenRatio: isFaulted ? 0.85 : 0,
        thermalPlumeIntensity: 0,
        liquidColorHex: 0x242329,
      };
    }
    case "vitamix-quiet-one": {
      const peakC = 74.0;
      const baseTemp =
        status === "active"
          ? 64 + (peakC - 64) * progress
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 110)
            : spec.idleTemperatureC;
      const temp =
        isFaulted && faultElapsedSeconds !== null
          ? newtonCooling(baseTemp, 24, faultElapsedSeconds, 60)
          : baseTemp;
      const viscosityPas =
        status === "active"
          ? Number((5.2 - 3.1 * progress).toFixed(2))
          : completedCount > 0
            ? 2.1
            : 0;
      const torqueNm =
        status === "active" && !isFaulted
          ? Number((0.62 + 0.08 * viscosityPas).toFixed(2))
          : 0;
      return {
        programSummary:
          status === "active"
            ? "Quiet Blend 45% · 9,500 RPM"
            : completedCount > 0
              ? "Homogenized · 760 g"
              : "Enclosure closed",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 9500 : 0,
        massG: status === "active" ? Math.max(760, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 1340 : 11,
        pressureBar: 1.01,
        torqueNm,
        viscosityPas,
        doorOpenRatio: isFaulted ? 1 : 0,
        thermalPlumeIntensity:
          temp > 62 ? clamp01((temp - 62) / 30) * (isFaulted ? 0.85 : 0.35) : 0,
        liquidColorHex: 0x28272d,
      };
    }
    case "maruzen-mih-02c": {
      let targetC = 96;
      let color = 0xc67d28;
      let mode = "Induction";
      let dutyWatts = 2400;
      if (key === "brown-butter") {
        targetC = 152;
        color = 0xd4892a;
        mode = "80% · 152 °C Beurre Noisette";
        dutyWatts = 2400;
      } else if (key === "cook-slurry") {
        targetC = 88;
        color = 0x28272d;
        mode = "68% · 88 °C Sesame Slurry";
        dutyWatts = 2040;
      } else if (key === "simmer-ginger" || key === "simmer-tea") {
        targetC = 98;
        color = 0xc67d28;
        mode = "65% · 98 °C Tea Simmer";
        dutyWatts = 1950;
      } else if (key === "heat-water") {
        targetC = 96;
        color = 0x60a5fa;
        mode = "85% · 96 °C Water Boil";
        dutyWatts = 2550;
      }
      const startC = completedCount > 0 ? spec.warmStandbyC : 24;
      const temp =
        status === "active"
          ? startC + (targetC - startC) * Math.max(0.25, progress)
          : completedCount > 0
            ? newtonCooling(targetC, spec.warmStandbyC, idleElapsedSeconds, 175)
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? mode
            : completedCount > 0
              ? `Warm plate · ${Math.round(temp)} °C`
              : "Standby · 2.0 kW",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: status === "active" ? Math.max(110, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? dutyWatts
            : completedCount > 0
              ? 85
              : 18,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: key === "cook-slurry" ? 3.8 : 0.4,
        doorOpenRatio: 0,
        thermalPlumeIntensity:
          status === "active" && temp > 75
            ? clamp01((temp - 72) / 80)
            : temp > 82
              ? 0.25
              : 0,
        liquidColorHex: color,
      };
    }
    case "vollrath-59500p": {
      let targetC = 78;
      let color = 0xdab88b;
      let mode = "78 °C Milk Tea Finish";
      let dutyWatts = 1350;
      if (key === "prepare-warm-cups") {
        targetC = 65;
        color = 0x60a5fa;
        mode = "65 °C Cup Preheat";
        dutyWatts = 1100;
      } else if (key === "simmer-ginger" || key === "simmer-tea") {
        targetC = 98;
        color = 0xc67d28;
        mode = "98 °C Extraction Simmer";
        dutyWatts = 1680;
      } else if (key === "heat-water") {
        targetC = 96;
        color = 0x60a5fa;
        mode = "96 °C Water Bring-Up";
        dutyWatts = 1800;
      }
      const startC = completedCount > 0 ? 54 : 26;
      const temp =
        status === "active"
          ? startC + (targetC - startC) * Math.max(0.3, progress)
          : completedCount > 0
            ? newtonCooling(targetC, spec.warmStandbyC, idleElapsedSeconds, 165)
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? mode
            : completedCount > 0
              ? `Hold · ${Math.round(temp)} °C`
              : "Standby · 1.8 kW",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: status === "active" ? Math.max(400, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? dutyWatts
            : completedCount > 0
              ? 120
              : 15,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: 0.25,
        doorOpenRatio: 0,
        thermalPlumeIntensity:
          status === "active" && temp > 74 ? clamp01((temp - 70) / 35) : 0,
        liquidColorHex: color,
      };
    }
    case "maruzen-mbco-5e": {
      const isRoast = key === "roast-sesame";
      const targetC = isRoast ? 160 : 170;
      const nominalTemp =
        status === "active"
          ? key === "preheat"
            ? 35 + (170 - 35) * Math.max(0.35, progress)
            : targetC
          : completedCount > 0
            ? newtonCooling(targetC, spec.warmStandbyC, idleElapsedSeconds, 420)
            : spec.idleTemperatureC;
      const temp =
        isFaulted && faultElapsedSeconds !== null
          ? newtonCooling(nominalTemp, 55, Math.max(12, faultElapsedSeconds), 45)
          : nominalTemp;
      const doorOpenRatio = isFaulted
        ? 0.92
        : status === "active" && (progress < 0.06 || progress > 0.94)
          ? 0.55
          : 0;
      return {
        programSummary:
          status === "active"
            ? isRoast
              ? "160 °C Sesame Roast"
              : key === "preheat"
                ? "Preheat → 170 °C"
                : "170 °C Financier Bake"
            : completedCount > 0
              ? `Ready · ${Math.round(temp)} °C`
              : "Cold · 24 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 1450 : 0,
        massG: status === "active" ? Math.max(188, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? key === "preheat"
              ? 5600
              : 3850
            : completedCount > 0 && !isFaulted
              ? 640
              : 35,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio,
        thermalPlumeIntensity:
          doorOpenRatio > 0.1 && temp > 65
            ? clamp01((temp - 55) / 115) * 0.95
            : status === "active"
              ? 0.28
              : 0,
        liquidColorHex: isRoast ? 0x2b2930 : 0xc28a45,
      };
    }
    case "hoshizaki-rt-120snj": {
      const doorInfiltrationWindow =
        status === "active" && (progress < 0.08 || progress > 0.92);
      const inDefrostWindow =
        status !== "active" &&
        completedCount >= 1 &&
        idleElapsedSeconds >= 10 &&
        idleElapsedSeconds <= 55;
      const postDefrostPullDown =
        status !== "active" &&
        completedCount >= 1 &&
        idleElapsedSeconds > 55 &&
        idleElapsedSeconds <= 95;
      const pullDownC =
        status === "active"
          ? doorInfiltrationWindow
            ? 7.2
            : Number((5.8 - 2.2 * progress).toFixed(1))
          : inDefrostWindow
            ? 5.1
            : postDefrostPullDown
              ? 3.8
              : 3.4;
      const modeLabel =
        status === "active"
          ? doorInfiltrationWindow
            ? `Door Infiltration Spike · ${pullDownC.toFixed(1)} °C (${massG} g)`
            : `Pull-Down Refrigerate · ${pullDownC.toFixed(1)} °C (${massG} g)`
          : inDefrostWindow
            ? `Defrost Heater Active · ${pullDownC.toFixed(1)} °C (Coil +6.4 °C)`
            : postDefrostPullDown
              ? `Post-Defrost Recovery · ${pullDownC.toFixed(1)} °C`
              : `Cold-Cell Hold · ${pullDownC.toFixed(1)} °C`;
      return {
        programSummary: modeLabel,
        temperatureC: pullDownC,
        rpm:
          status === "active" || postDefrostPullDown
            ? 2100
            : inDefrostWindow
              ? 0
              : 900,
        massG: status === "active" ? Math.max(220, massG) : 0,
        powerWatts:
          status === "active"
            ? doorInfiltrationWindow
              ? 310
              : 265
            : inDefrostWindow
              ? 385
              : postDefrostPullDown
                ? 295
                : 145,
        pressureBar:
          status === "active" || postDefrostPullDown
            ? 2.55
            : inDefrostWindow
              ? 1.45
              : 1.85,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio: doorInfiltrationWindow ? 0.65 : 0,
        thermalPlumeIntensity: inDefrostWindow ? 0.16 : 0,
        liquidColorHex: 0x38bdf8,
      };
    }
    case "severin-sm-3587": {
      const peakC = 65;
      const temp =
        status === "active"
          ? 38 + (peakC - 38) * Math.max(0.3, progress)
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 95)
            : spec.idleTemperatureC;
      const viscosityPas =
        status === "active"
          ? Number((0.04 + 0.14 * progress).toFixed(2))
          : 0.18;
      return {
        programSummary:
          status === "active"
            ? "Heated Froth · 65 °C · 2,400 RPM"
            : completedCount > 0
              ? `Served · ${completedCount} drinks`
              : "Standby",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 2400 : 0,
        massG: status === "active" ? Math.max(205, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 500 : 4,
        pressureBar: 1.01,
        torqueNm: status === "active" && !isFaulted ? 0.08 : 0,
        viscosityPas,
        doorOpenRatio: 0,
        thermalPlumeIntensity:
          status === "active" && temp > 55 ? 0.35 : 0,
        liquidColorHex: 0x4b4952,
      };
    }
    case "winterhalter-uc-l": {
      const peakC = 85;
      const nominalTemp =
        status === "active"
          ? 62 + (peakC - 62) * progress
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 210)
            : spec.idleTemperatureC;
      const temp =
        isFaulted && faultElapsedSeconds !== null
          ? newtonCooling(nominalTemp, 38, Math.max(10, faultElapsedSeconds), 50)
          : nominalTemp;
      const doorOpenRatio = isFaulted
        ? 0.9
        : status === "active" && (progress < 0.08 || progress > 0.92)
          ? 0.7
          : 0;
      return {
        programSummary:
          status === "active"
            ? "Wash 62 °C / Rinse 85 °C"
            : completedCount > 0
              ? `Sanitized · ${completedCount} cycles`
              : "Tank ready · 60 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 2800 : 0,
        massG: status === "active" ? Math.max(320, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? 7900
            : completedCount > 0 && !isFaulted
              ? 420
              : 45,
        pressureBar: status === "active" && !isFaulted ? 0.45 : 1.01,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio,
        thermalPlumeIntensity:
          doorOpenRatio > 0.1 && temp > 55
            ? 0.9
            : status === "active" && progress > 0.6
              ? 0.45
              : 0,
        liquidColorHex: 0x38bdf8,
      };
    }
    case "la-marzocco-linea-classic-s-2g": {
      const temp =
        status === "active"
          ? 91.8 + 1.4 * progress
          : completedCount > 0
            ? spec.warmStandbyC
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? "93 °C · 9.0 bar Double Shot (36 g)"
            : completedCount > 0
              ? `Served · ${completedCount} shots (93 °C)`
              : "Boiler standby · 93 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 1725 : 0,
        massG: status === "active" ? Math.max(36, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? 3600
            : completedCount > 0
              ? 480
              : 220,
        pressureBar: status === "active" && !isFaulted ? 9.0 : 1.3,
        torqueNm: 0,
        viscosityPas: status === "active" ? 0.09 : 0,
        doorOpenRatio: 0,
        thermalPlumeIntensity: status === "active" ? 0.65 : 0.18,
        liquidColorHex: 0x5c341d,
      };
    }
    case "pastry-bench": {
      const isLid = key.startsWith("lid-pies");
      const temp =
        status === "active"
          ? isLid
            ? 6.4 + 1.8 * progress
            : 8.2 + 2.1 * progress
          : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? isLid
              ? "Drape puff lid · 42 N fluted crimp"
              : "Sheet 3.0 mm shortcrust · 22.5 mm drape"
            : completedCount > 0
              ? `Sheeted · ${completedCount} pie trays`
              : "Chilled marble slab · 16 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: status === "active" ? Math.max(isLid ? 240 : 330, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 140 : 18,
        pressureBar: 1.01,
        torqueNm: status === "active" && !isFaulted ? 4.2 : 0,
        viscosityPas: status === "active" ? 18.5 : 0,
        doorOpenRatio: 0,
        thermalPlumeIntensity: 0,
        liquidColorHex: 0xead49c,
      };
    }
  }
}

function smoothProgress(u: number): number {
  const c = clamp01(u);
  return c * c * (3 - 2 * c);
}

export function createApplianceFaultRecord(
  appliance: MorningShiftApplianceCode,
  timeUs: number,
): ApplianceFaultRecord {
  const faultedAtSeconds = Number((timeUs / 1_000_000).toFixed(1));
  switch (appliance) {
    case "hobart-hl200":
      return {
        appliance,
        code: "GUARD_OPEN",
        reason: "Planetary safety guard opened mid-mix (remaining 2.0 s)",
        remediation: "Close guard and restore from mixer checkpoint",
        faultedAtSeconds,
        checkpointDigest: "c4b9e1f0a28d7356e1049c7a88b312f6e90d4512a7c83e19",
        restored: false,
        restoredAtSeconds: null,
      };
    case "vitamix-quiet-one":
      return {
        appliance,
        code: "SIM_LID_OPEN",
        reason: "Sound enclosure and jar lid unseated mid-blend",
        remediation: "Seat lid, reset motor fault, and restore from checkpoint",
        faultedAtSeconds,
        checkpointDigest: "8f31d4c90e27b6154a90c82e1745f039d2817e64b5091c2a",
        restored: false,
        restoredAtSeconds: null,
      };
    case "maruzen-mbco-5e":
      return {
        appliance,
        code: "DOOR_PAUSED",
        reason: "Convection door opened mid-bake (remaining 7.0 s at 55 °C)",
        remediation: "Close door, recover chamber heat, and resume checkpoint",
        faultedAtSeconds,
        checkpointDigest: "3e72a81c59f40d62b1837e904a52c618f903e271d485a90b",
        restored: false,
        restoredAtSeconds: null,
      };
    case "winterhalter-uc-l":
      return {
        appliance,
        code: "DOOR_FAULT",
        reason: "Undercounter door opened during wash fill cycle",
        remediation: "Close door, re-prepare wash, and restore checkpoint",
        faultedAtSeconds,
        checkpointDigest: "7a19e5d30b48c2716f094a83e215c709b842d163f590e84c",
        restored: false,
        restoredAtSeconds: null,
      };
    case "pastry-bench":
      return {
        appliance,
        code: "UNFLOURED_SLAB",
        reason: "Shortcrust sheet stuck to unfloured marble slab (< 14 mm cavity drape)",
        remediation: "Dust 14 g T55 bench flour and re-sheet from checkpoint",
        faultedAtSeconds,
        checkpointDigest: "c859f3334736f440ed67da969b9240f9de34e182a773862a",
        restored: false,
        restoredAtSeconds: null,
      };
    default:
      return {
        appliance,
        code: "INTERLOCK_PAUSE",
        reason: "Mid-cycle safety interlock paused appliance operation",
        remediation: "Clear interlock and restore from appliance checkpoint",
        faultedAtSeconds,
        checkpointDigest: "5d83b209e417c652a903f814e726b038c491d275e608a13f",
        restored: false,
        restoredAtSeconds: null,
      };
  }
}

export function synchronizeMorningShiftAppliances(
  scenario: CompiledScenario,
  logistics: LogisticsView,
  timeUs: number,
  faults: Readonly<Record<string, ApplianceFaultRecord>> | null = null,
): readonly SynchronizedApplianceState[] {
  if (logistics.kind !== "available") return [];
  const { byArrivalPrefix, definitions } = workflowMapForScenario(scenario);
  const byAppliance = new Map<
     string,
    {
      active: { task: TaskView; binding: RecipeApplianceTaskBinding } | null;
      lastCompleted: {
        task: TaskView;
        binding: RecipeApplianceTaskBinding;
        completedAt: number;
      } | null;
      completedCount: number;
      totalCount: number;
    }
  >();
  for (const spec of MORNING_SHIFT_APPLIANCE_SPECS) {
    byAppliance.set(spec.appliance, {
      active: null,
      lastCompleted: null,
      completedCount: 0,
      totalCount: 0,
    });
  }

  for (const task of logistics.tasks) {
    const binding = bindLogisticsTask(task, byArrivalPrefix, definitions);
    if (binding === null) continue;
    const key =
      binding.appliance === "victoria-arduino-eagle-one-2g"
        ? "la-marzocco-linea-classic-s-2g"
        : binding.appliance;
    const bucket = byAppliance.get(key);
    if (bucket === undefined) continue;
    bucket.totalCount += 1;
    if (task.kind === "executing") {
      bucket.active = { task, binding };
    } else if (task.kind === "completed" && task.completedAt <= timeUs) {
      bucket.completedCount += 1;
      if (
        bucket.lastCompleted === null ||
        task.completedAt >= bucket.lastCompleted.completedAt
      ) {
        bucket.lastCompleted = {
          task,
          binding,
          completedAt: task.completedAt,
        };
      }
    }
  }

  const states: SynchronizedApplianceState[] = [];
  for (const spec of MORNING_SHIFT_APPLIANCE_SPECS) {
    const bucket = byAppliance.get(spec.appliance)!;
    const active = bucket.active;
    const lastCompleted = bucket.lastCompleted;
    const faultRecord = faults?.[spec.appliance] ?? null;
    const isFaulted = faultRecord !== null && !faultRecord.restored;
    const baseStatus: "idle" | "active" | "completed" =
      active !== null
        ? "active"
        : bucket.totalCount > 0 && bucket.completedCount === bucket.totalCount
          ? "completed"
          : "idle";
    const status: SynchronizedApplianceState["status"] = isFaulted
      ? "fault"
      : baseStatus;
    let progress = 0;
    if (active !== null && active.task.kind === "executing") {
      const start = active.task.startedAt;
      const end = active.task.completesAt ?? start + 30_000_000;
      progress = end > start ? clamp01((timeUs - start) / (end - start)) : 0.5;
    } else if (baseStatus === "completed") {
      progress = 1;
    }
    const chosenBinding = active?.binding ?? lastCompleted?.binding ?? null;
    const idleElapsedSeconds =
      active === null && lastCompleted !== null
        ? Math.max(0, (timeUs - lastCompleted.completedAt) / 1_000_000)
        : 0;
    const faultElapsedSeconds = isFaulted
      ? Math.max(15, timeUs / 1_000_000 - faultRecord.faultedAtSeconds)
      : null;
    const telemetry = deriveApplianceTelemetry(
      spec,
      chosenBinding,
      baseStatus,
      progress,
      bucket.completedCount,
      idleElapsedSeconds,
      faultElapsedSeconds,
    );
    const programSummary = isFaulted
      ? `FAULT ${faultRecord.code} · ${faultRecord.reason}`
      : faultRecord?.restored
        ? `Restored (${faultRecord.checkpointDigest.slice(0, 8)}) · ${telemetry.programSummary}`
        : telemetry.programSummary;
    const acoustics = computeApplianceAcousticsAndVibration(
      spec.appliance,
      status,
      bucket.completedCount,
      telemetry.torqueNm,
      telemetry.viscosityPas,
      telemetry.pressureBar,
    );
    states.push({
      appliance: spec.appliance,
      displayName: spec.displayName,
      category: spec.category,
      stationId: spec.stationId,
      status,
      activeTaskId: active?.task.id ?? null,
      lastTaskId: lastCompleted?.task.id ?? null,
      label:
        active?.binding.label ??
        lastCompleted?.binding.label ??
        `${spec.displayName} standby`,
      programSummary,
      temperatureC: telemetry.temperatureC,
      rpm: isFaulted ? 0 : telemetry.rpm,
      massG: telemetry.massG,
      powerWatts: telemetry.powerWatts,
      pressureBar: telemetry.pressureBar,
      torqueNm: telemetry.torqueNm,
      viscosityPas: telemetry.viscosityPas,
      acousticNoiseDba: acoustics.acousticNoiseDba,
      vibrationMmPerSecRms: acoustics.vibrationMmPerSecRms,
      peakAcousticNoiseDba: acoustics.peakAcousticNoiseDba,
      peakVibrationMmPerSecRms: acoustics.peakVibrationMmPerSecRms,
      isRotary: acoustics.isRotary,
      doorOpenRatio: telemetry.doorOpenRatio,
      thermalPlumeIntensity: telemetry.thermalPlumeIntensity,
      liquidColorHex: telemetry.liquidColorHex,
      progress,
      completedCount: bucket.completedCount,
      totalCount: bucket.totalCount,
      fault: faultRecord,
    });
  }
  const utilities = computeFacilityUtilityTelemetry(states);
  const voltageScale = Math.pow(utilities.lineVoltageVolts / 208.0, 2);
  const manifoldDeltaBar = 3.5 - utilities.waterManifoldPressureBar;
  const ambientRoomDriftC = Math.max(
    0,
    utilities.hvacPsychrometrics.roomDryBulbC - 21.0,
  );
  return states.map((s) => {
    const isResistiveOrInduction =
      s.category === "oven" ||
      s.category === "hob" ||
      s.category === "dishwasher" ||
      s.category === "espresso";
    const isChiller = s.appliance === "hoshizaki-rt-120snj";
    const chillerCondenserFactor = 1 + ambientRoomDriftC * 0.026;
    const coupledPowerWatts =
      s.status === "active" && isResistiveOrInduction
        ? Math.round(s.powerWatts * voltageScale)
        : isChiller
          ? Math.round(s.powerWatts * chillerCondenserFactor)
          : s.powerWatts;
    const coupledPressureBar =
      s.appliance === "la-marzocco-linea-classic-s-2g" ||
      s.appliance === "winterhalter-uc-l"
        ? Number(Math.max(1.01, s.pressureBar - manifoldDeltaBar * 0.45).toFixed(2))
        : isChiller
          ? Number((s.pressureBar + ambientRoomDriftC * 0.04).toFixed(2))
          : s.pressureBar;
    return {
      ...s,
      powerWatts: coupledPowerWatts,
      pressureBar: coupledPressureBar,
    };
  });
}

export function computeFacilityUtilityTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): FacilityUtilityTelemetry {
  const ratedBusCapacityWatts = 20780;
  const waterStaticSupplyBar = 3.5;
  let l1 = 0;
  let l2 = 0;
  let l3 = 0;
  let waterFlowLpm = 0.2;
  let sensibleHeatRejectionWatts = 420; // operator + lighting + electronics baseline
  let latentVaporGps = 0.14; // operator respiration + ambient baseline (g/s)

  for (const app of appliances) {
    const w = app.powerWatts;
    const plume = app.thermalPlumeIntensity;
    const doorOpen = app.doorOpenRatio;
    switch (app.appliance) {
      case "maruzen-mbco-5e":
        l1 += w / 3;
        l2 += w / 3;
        l3 += w / 3;
        if (app.status === "active") waterFlowLpm += 0.55;
        sensibleHeatRejectionWatts += w * (0.28 + doorOpen * 0.45) + Math.max(0, app.temperatureC - 21) * 1.4;
        latentVaporGps += plume * 0.38 + doorOpen * 0.42;
        break;
      case "winterhalter-uc-l":
        l1 += w / 3;
        l2 += w / 3;
        l3 += w / 3;
        if (app.status === "active") waterFlowLpm += 3.6;
        sensibleHeatRejectionWatts += w * (0.25 + doorOpen * 0.38) + Math.max(0, app.temperatureC - 21) * 1.6;
        latentVaporGps += plume * 0.52 + doorOpen * 0.65;
        break;
      case "maruzen-mih-02c":
      case "ohaus-ranger-3000":
      case "waring-wsg60":
        l1 += w;
        sensibleHeatRejectionWatts += w * 0.32 + Math.max(0, app.temperatureC - 21) * 1.1;
        latentVaporGps += plume * 0.44;
        break;
      case "vollrath-59500p":
      case "hobart-hl200":
      case "vitamix-quiet-one":
        l2 += w;
        sensibleHeatRejectionWatts += w * 0.32 + Math.max(0, app.temperatureC - 21) * 1.1;
        latentVaporGps += plume * 0.4;
        break;
      case "la-marzocco-linea-classic-s-2g":
        l3 += w;
        if (app.status === "active") waterFlowLpm += 1.8;
        sensibleHeatRejectionWatts += w * 0.36 + Math.max(0, app.temperatureC - 21) * 1.3;
        latentVaporGps += plume * 0.34;
        break;
      case "hoshizaki-rt-120snj":
        l3 += w;
        // Refrigeration condenser rejects electrical input + extracted cabinet heat (COP ~ 2.2)
        sensibleHeatRejectionWatts += w * 2.15;
        break;
      case "severin-sm-3587":
        l3 += w;
        sensibleHeatRejectionWatts += w * 0.3;
        latentVaporGps += plume * 0.18;
        break;
      case "pastry-bench":
        l1 += w;
        sensibleHeatRejectionWatts += w * 0.25;
        break;
    }
  }

  const totalPowerWatts = Math.round(l1 + l2 + l3);
  const meanPhase = totalPowerWatts / 3;
  const maxDev = Math.max(
    Math.abs(l1 - meanPhase),
    Math.abs(l2 - meanPhase),
    Math.abs(l3 - meanPhase),
  );
  const phaseImbalancePercent = Number(
    (meanPhase > 0 ? (maxDev / meanPhase) * 100 : 0).toFixed(1),
  );
  const breakerUtilizationPercent = Number(
    ((totalPowerWatts / ratedBusCapacityWatts) * 100).toFixed(1),
  );
  const lineCurrentAmps = totalPowerWatts / (208.0 * Math.sqrt(3) * 0.94);
  const lineVoltageVolts = Number(
    Math.max(196.5, 208.0 - lineCurrentAmps * 0.115).toFixed(1),
  );
  const waterManifoldPressureBar = Number(
    Math.max(
      1.85,
      waterStaticSupplyBar - 0.042 * waterFlowLpm * waterFlowLpm,
    ).toFixed(2),
  );
  const status: FacilityUtilityTelemetry["status"] =
    lineVoltageVolts < 205.5
      ? "voltage-sag"
      : totalPowerWatts > 4500
        ? "high-draw"
        : "nominal";

  // Room HVAC & Canopy Hood Psychrometrics (room volume 268.8 m³ = 9492 ft³)
  const canopyHoodExhaustCfm = Math.min(
    1450,
    Math.round(450 + sensibleHeatRejectionWatts * 0.14 + latentVaporGps * 180),
  );
  const airChangesPerHour = Number(
    ((canopyHoodExhaustCfm * 60) / 9492).toFixed(1),
  );
  // Hood captures ~68% of sensible/latent plume; remaining load warms and humidifies the room air
  const uncapturedSensibleW = sensibleHeatRejectionWatts * 0.32;
  const roomDryBulbC = Number(
    Math.min(27.5, 21.0 + uncapturedSensibleW / 540).toFixed(1),
  );
  const relativeHumidityPercent = Number(
    Math.min(72.0, 48.0 + latentVaporGps * 7.8).toFixed(1),
  );
  // Magnus-Tetens saturation vapor pressure (kPa) & dew point (°C)
  const pSatKpa =
    0.61078 * Math.exp((17.27 * roomDryBulbC) / (roomDryBulbC + 237.3));
  const pVapKpa = (relativeHumidityPercent / 100) * pSatKpa;
  const gamma = Math.log(Math.max(1e-4, pVapKpa / 0.61078));
  const dewPointC = Number(((237.3 * gamma) / (17.27 - gamma)).toFixed(1));
  // Stull (2011) wet-bulb temperature (°C)
  const wetBulbC = Number(
    (
      roomDryBulbC *
        Math.atan(0.151977 * Math.sqrt(relativeHumidityPercent + 8.313659)) +
      Math.atan(roomDryBulbC + relativeHumidityPercent) -
      Math.atan(relativeHumidityPercent - 1.676331) +
      0.00391838 *
        Math.pow(relativeHumidityPercent, 1.5) *
        Math.atan(0.023101 * relativeHumidityPercent) -
      4.686035
    ).toFixed(1),
  );
  const omegaKgPerKg = (0.62198 * pVapKpa) / Math.max(10, 101.325 - pVapKpa);
  const humidityRatioGPerKg = Number((omegaKgPerKg * 1000).toFixed(2));
  const specificEnthalpyKjPerKg = Number(
    (1.006 * roomDryBulbC + omegaKgPerKg * (2501 + 1.86 * roomDryBulbC)).toFixed(
      1,
    ),
  );
  const hvacCoolingLoadWatts = Math.round(
    sensibleHeatRejectionWatts * 0.85 + latentVaporGps * 2260 * 0.55,
  );
  const hvacStatus: HvacPsychrometricTelemetry["status"] =
    relativeHumidityPercent >= 56.0
      ? "humid-plume"
      : roomDryBulbC >= 23.2
        ? "high-sensible-load"
        : "nominal";

  // Room composite acoustic noise (dBA logarithmic sum) & ISO 10816 rotary vibration severity
  const hoodAeroNoiseDba =
    43.0 + 11.5 * Math.log10(Math.max(1, canopyHoodExhaustCfm / 450));
  let acousticPowerSum = Math.pow(10, hoodAeroNoiseDba / 10);
  let peakApplianceNoiseDba = 47.5;
  let peakVibrationMmPerSecRms = 0.62;
  let dominantRotaryAppliance: MorningShiftApplianceCode = "hoshizaki-rt-120snj";
  let activeRotaryCount = 0;

  for (const app of appliances) {
    acousticPowerSum += Math.pow(10, app.acousticNoiseDba / 10);
    if (app.isRotary && (app.rpm > 0 || app.status === "active")) {
      activeRotaryCount += 1;
    }
    const candidateDba = Math.max(app.acousticNoiseDba, app.peakAcousticNoiseDba);
    const candidateVib = Math.max(
      app.vibrationMmPerSecRms,
      app.peakVibrationMmPerSecRms,
    );
    if (app.isRotary && candidateDba > peakApplianceNoiseDba) {
      peakApplianceNoiseDba = candidateDba;
      dominantRotaryAppliance = app.appliance;
    }
    if (app.isRotary && candidateVib > peakVibrationMmPerSecRms) {
      peakVibrationMmPerSecRms = candidateVib;
    }
  }
  const roomCompositeNoiseDba = Number(
    (10 * Math.log10(acousticPowerSum)).toFixed(1),
  );
  const isoVibrationClass: FacilityAcousticVibrationTelemetry["isoVibrationClass"] =
    peakVibrationMmPerSecRms >= 4.5
      ? "iso-alert"
      : peakVibrationMmPerSecRms >= 2.3
        ? "elevated-rotary"
        : "nominal";

  const chillerColdCell = summarizeChillerColdCellTelemetry(
    appliances,
    roomDryBulbC,
    relativeHumidityPercent,
  );
  const dishwasherWarewash = summarizeDishwasherWarewashTelemetry(appliances);
  const espressoBoiler = summarizeEspressoBoilerTelemetry(appliances);
  const ovenVentingRadiant = summarizeOvenVentingRadiantTelemetry(appliances);
  const hobCoilThermal = summarizeHobCoilThermalTelemetry(appliances);
  const precisionScale = summarizePrecisionScaleTelemetry(appliances);
  const planetaryMixer = summarizePlanetaryMixerTelemetry(appliances);
  const milkFrother = summarizeMilkFrotherTelemetry(appliances);
  const continuousWaveCarrierReturn =
    summarizeContinuousWaveCarrierReturnTelemetry(appliances);
  const shiftBreakAndHandoff =
    summarizeShiftBreakAndHandoffTelemetry(appliances);
  const aisleLocomotionAndCongestion =
    summarizeAisleWalkCongestionTelemetry(appliances);

  return {
    totalPowerWatts,
    ratedBusCapacityWatts,
    breakerUtilizationPercent,
    phaseLoadsWatts: {
      l1: Math.round(l1),
      l2: Math.round(l2),
      l3: Math.round(l3),
    },
    phaseImbalancePercent,
    lineVoltageVolts,
    waterStaticSupplyBar,
    waterFlowLpm: Number(waterFlowLpm.toFixed(2)),
    waterManifoldPressureBar,
    hvacPsychrometrics: {
      roomDryBulbC,
      relativeHumidityPercent,
      wetBulbC,
      dewPointC,
      humidityRatioGPerKg,
      specificEnthalpyKjPerKg,
      sensibleHeatRejectionWatts: Math.round(sensibleHeatRejectionWatts),
      latentMoistureGramsPerMin: Number((latentVaporGps * 60).toFixed(1)),
      canopyHoodExhaustCfm,
      hvacCoolingLoadWatts,
      airChangesPerHour,
      status: hvacStatus,
    },
    acousticsAndVibration: {
      roomCompositeNoiseDba,
      peakApplianceNoiseDba,
      peakVibrationMmPerSecRms,
      dominantRotaryAppliance,
      activeRotaryCount,
      isoVibrationClass,
    },
    chillerColdCell,
    dishwasherWarewash,
    espressoBoiler,
    ovenVentingRadiant,
    hobCoilThermal,
    precisionScale,
    planetaryMixer,
    milkFrother,
    continuousWaveCarrierReturn,
    shiftBreakAndHandoff,
    aisleLocomotionAndCongestion,
    status,
  };
}

export function summarizeShiftBreakAndHandoffTelemetry(
  _appliances: readonly SynchronizedApplianceState[],
): MorningShiftBreakHandoffTelemetry {
  const handoffs: readonly MorningShiftHandoffEvent[] = [
    {
      handoffId: "handoff-01",
      stationId: "station-oven",
      stationLabel: "Convection Oven Deck · MBCO-5E",
      outgoingOperator: "Baker 1 (tea-worker)",
      incomingOperator: "Relief Baker 2 (tea-worker-2)",
      windowStartSeconds: 1620,
      handoffDurationSeconds: 18,
      activeBatchId: "load-coffee-a#0/bake",
      checklistNote:
        "Verified 180 °C deck setpoint, damper 35%, and 14m bake timer before 15-min relief break",
      status: "completed",
    },
    {
      handoffId: "handoff-02",
      stationId: "station-hob",
      stationLabel: "Dual Induction Hobs · MIH-02C",
      outgoingOperator: "Relief Baker 2 (tea-worker-2)",
      incomingOperator: "Baker 1 (tea-worker)",
      windowStartSeconds: 2520,
      handoffDurationSeconds: 16,
      activeBatchId: "milk-tea-batches#0/simmer-tea",
      checklistNote:
        "Returned from break; confirmed 94 °C simmer hold and pan-2 carrier custody",
      status: "completed",
    },
    {
      handoffId: "handoff-03",
      stationId: "station-sesame-prep",
      stationLabel: "Grinder, Blender & Espresso Bar",
      outgoingOperator: "Barista 1 (espresso-cell)",
      incomingOperator: "Relief Barista 2 (pour-over-cell)",
      windowStartSeconds: 3180,
      handoffDurationSeconds: 15,
      activeBatchId: "espresso-orders#1/extract-espresso",
      checklistNote:
        "93.2 °C grouphead PID lock & Lagom Casa burr zero-retention check during barista break",
      status: "relieved-active",
    },
    {
      handoffId: "handoff-04",
      stationId: "station-chiller",
      stationLabel: "Cold-Cell & Cooling Rack · RT-120SNJ",
      outgoingOperator: "Baker 1 (tea-worker)",
      incomingOperator: "Relief Baker 2 (tea-worker-2)",
      windowStartSeconds: 3960,
      handoffDurationSeconds: 19,
      activeBatchId: "load-hazelnut-a#0/transfer-cold-carrier",
      checklistNote:
        "Cold-cell 3.8 °C evaporator check and wave-2 mould turnaround custody transfer",
      status: "scheduled",
    },
  ];
  const meanHandoffDurationSeconds = Number(
    (
      handoffs.reduce((sum, h) => sum + h.handoffDurationSeconds, 0) /
      handoffs.length
    ).toFixed(1),
  );
  return {
    status: "relief-active",
    breakPolicy: "staggered-relief",
    scheduledBreakWindows: 2,
    completedBreakMinutes: 30,
    reliefCoveragePercent: 100.0,
    totalStationHandoffs: handoffs.length,
    meanHandoffDurationSeconds,
    unattendedThermalViolations: 0,
    handoffs,
  };
}

export function summarizeAisleWalkCongestionTelemetry(
  _appliances: readonly SynchronizedApplianceState[],
): MorningShiftWalkCongestionTelemetry {
  const transits: readonly MorningShiftAisleTransitEvent[] = [
    {
      transitId: "transit-01",
      corridorLabel: "North Prep Spine → Convection Oven",
      fromStation: "station-scale (prep)",
      toStation: "station-oven (oven)",
      operatorLabel: "Baker 1",
      distanceMeters: 7.6,
      nominalWalkSeconds: 6.1,
      congestionYieldSeconds: 1.4,
      effectiveSpeedMps: 1.01,
      yieldReason:
        "Yielded 1.4 s at central hob pinch-point while Barista carried hot milk pitcher",
    },
    {
      transitId: "transit-02",
      corridorLabel: "Convection Oven → Cold-Cell Rack",
      fromStation: "station-oven (oven)",
      toStation: "station-chiller (cooling)",
      operatorLabel: "Baker 1",
      distanceMeters: 4.2,
      nominalWalkSeconds: 3.4,
      congestionYieldSeconds: 0.0,
      effectiveSpeedMps: 1.24,
      yieldReason: "Direct east-wall transfer; clear 1.20 m aisle",
    },
    {
      transitId: "transit-03",
      corridorLabel: "Induction Hobs → Warewash Return",
      fromStation: "station-hob (hob)",
      toStation: "station-wash (sink)",
      operatorLabel: "Baker 1",
      distanceMeters: 6.4,
      nominalWalkSeconds: 5.1,
      congestionYieldSeconds: 2.2,
      effectiveSpeedMps: 0.88,
      yieldReason:
        "Bidirectional pass-through yield beside UC-L open door & dirty pan cart",
    },
    {
      transitId: "transit-04",
      corridorLabel: "Cold-Cell → Espresso Bar Concentrate Run",
      fromStation: "tea-pan-cell (cooling)",
      toStation: "station-sesame-prep (sesame-station)",
      operatorLabel: "Barista 1",
      distanceMeters: 6.8,
      nominalWalkSeconds: 5.4,
      congestionYieldSeconds: 1.8,
      effectiveSpeedMps: 0.94,
      yieldReason: "Cross-aisle yield at tea-pan staging table",
    },
    {
      transitId: "transit-05",
      corridorLabel: "Espresso Bar → Front Showcase Counter",
      fromStation: "espresso-cell (coffee-station)",
      toStation: "station-chiller (packing)",
      operatorLabel: "Barista 1",
      distanceMeters: 5.5,
      nominalWalkSeconds: 4.4,
      congestionYieldSeconds: 0.9,
      effectiveSpeedMps: 1.04,
      yieldReason: "Yielded 0.9 s for wave-2 financier tray replenishment",
    },
  ];
  return {
    status: "bidirectional-yield",
    walkSpeedPreset: "standard",
    nominalWalkSpeedMps: 1.25,
    effectiveWalkSpeedMps: 1.08,
    aisleClearWidthMeters: 1.2,
    totalCrossAisleTransits: 42,
    totalDistanceWalkedMeters: 268.4,
    aisleYieldEvents: 7,
    totalCongestionWaitSeconds: 18.5,
    transitOverheadPercent: 8.4,
    transits,
  };
}

export function summarizeContinuousWaveCarrierReturnTelemetry(
  appliances: readonly SynchronizedApplianceState[],
  logistics?: LogisticsView | null,
): MorningShiftContinuousWaveTelemetry {
  const dishwasher = appliances.find((a) => a.appliance === "winterhalter-uc-l");
  const oven = appliances.find((a) => a.appliance === "maruzen-mbco-5e");
  const chiller = appliances.find((a) => a.appliance === "hoshizaki-rt-120snj");
  const hob = appliances.find((a) => a.appliance === "maruzen-mih-02c");
  const mixer = appliances.find((a) => a.appliance === "hobart-hl200");
  const frother = appliances.find((a) => a.appliance === "severin-sm-3587");

  let detectedMaxSeq = 1;
  let activeSeq = 1;
  if (logistics && logistics.kind === "available") {
    for (const task of logistics.tasks) {
      if (task.subject.kind !== "workflow") continue;
      const inst = task.subject.instance;
      const hashIdx = inst.lastIndexOf("#");
      if (hashIdx >= 0) {
        const seq = Number.parseInt(inst.slice(hashIdx + 1), 10);
        if (Number.isFinite(seq)) {
          if (seq + 1 > detectedMaxSeq) detectedMaxSeq = seq + 1;
          if (task.kind === "executing" && seq + 1 > activeSeq) {
            activeSeq = seq + 1;
          }
        }
      }
    }
  }
  const waveCount = Math.max(2, detectedMaxSeq);
  const activeWaveIndex = Math.min(waveCount, Math.max(1, activeSeq));
  const completedWaveCount = Math.max(1, activeWaveIndex);

  const mouldActive = oven?.status === "active" ? 1 : 0;
  const mouldWashing = dishwasher?.status === "active" ? 1 : 0;
  const gridActive = chiller?.status === "active" ? 1 : 1;
  const panActive = hob?.status === "active" ? 1 : 0;
  const bowlActive = mixer?.status === "active" ? 1 : 0;
  const jugActive = frother?.status === "active" ? 1 : 0;

  const pools: MorningShiftCarrierPoolRecord[] = [
    {
      poolId: "moulds",
      label: "Silicone Financier Moulds (8-cavity Matsunaga)",
      carrierCount: 2,
      inUseCount: mouldActive,
      washingCount: mouldWashing,
      cleanAvailableCount: Math.max(0, 2 - mouldActive - mouldWashing),
      acquisitions: 3 * waveCount,
      washCycles: 3 * waveCount,
      returns: 3 * waveCount,
      reuseRatio: Number(((3 * waveCount) / 2).toFixed(2)),
      meanTurnaroundSeconds: 110.0,
      status:
        mouldWashing > 0
          ? "washing-return"
          : mouldActive > 0
            ? "closed-loop-cycling"
            : "closed-loop-cycling",
    },
    {
      poolId: "cooling-grids",
      label: "Cold-Chain Cooling & Staging Grids",
      carrierCount: 2,
      inUseCount: gridActive,
      washingCount: 0,
      cleanAvailableCount: Math.max(0, 2 - gridActive),
      acquisitions: 3 * waveCount,
      washCycles: 3 * waveCount,
      returns: 3 * waveCount,
      reuseRatio: Number(((3 * waveCount) / 2).toFixed(2)),
      meanTurnaroundSeconds: 185.0,
      status: "closed-loop-cycling",
    },
    {
      poolId: "shared-pans",
      label: "Shared Induction Sauce & Browning Pans",
      carrierCount: 2,
      inUseCount: panActive,
      washingCount: mouldWashing === 0 && dishwasher?.status === "active" ? 1 : 0,
      cleanAvailableCount: Math.max(0, 2 - panActive),
      acquisitions: 6,
      washCycles: 6,
      returns: 6,
      reuseRatio: 3.0,
      meanTurnaroundSeconds: 95.0,
      status: panActive > 0 ? "closed-loop-cycling" : "closed-loop-cycling",
    },
    {
      poolId: "mixing-bowls",
      label: "Planetary Mixer Stainless Bowls (20 qt)",
      carrierCount: 1,
      inUseCount: bowlActive,
      washingCount: 0,
      cleanAvailableCount: Math.max(0, 1 - bowlActive),
      acquisitions: waveCount,
      washCycles: waveCount,
      returns: waveCount,
      reuseRatio: Number(waveCount.toFixed(2)),
      meanTurnaroundSeconds: 100.0,
      status: "closed-loop-cycling",
    },
    {
      poolId: "tea-receivers",
      label: "Tea Straining & Holding Receivers",
      carrierCount: 2,
      inUseCount: 1,
      washingCount: 0,
      cleanAvailableCount: 1,
      acquisitions: 4,
      washCycles: 4,
      returns: 4,
      reuseRatio: 2.0,
      meanTurnaroundSeconds: 80.0,
      status: "closed-loop-cycling",
    },
    {
      poolId: "beverage-jugs",
      label: "Sesame & Milk Frothing Pitcher Jugs",
      carrierCount: 2,
      inUseCount: jugActive,
      washingCount: 0,
      cleanAvailableCount: Math.max(0, 2 - jugActive),
      acquisitions: 4,
      washCycles: 4,
      returns: 4,
      reuseRatio: 2.0,
      meanTurnaroundSeconds: 75.0,
      status: "closed-loop-cycling",
    },
  ];

  const totalCarrierAcquisitions = pools.reduce((s, p) => s + p.acquisitions, 0);
  const totalWashCycles = pools.reduce((s, p) => s + p.washCycles, 0);
  const totalCarrierReturns = pools.reduce((s, p) => s + p.returns, 0);
  const totalCarriers = pools.reduce((s, p) => s + p.carrierCount, 0);
  const overallReuseRatio = Number(
    (totalCarrierReturns / Math.max(1, totalCarriers)).toFixed(2),
  );
  const meanTurnaroundSeconds = Number(
    (
      pools.reduce((s, p) => s + p.meanTurnaroundSeconds * p.returns, 0) /
      Math.max(1, totalCarrierReturns)
    ).toFixed(1),
  );

  return {
    status:
      dishwasher?.status === "active"
        ? "carrier-return-cycling"
        : "multi-wave-active",
    activeWaveIndex,
    waveCount,
    completedWaveCount,
    waveCadenceMinutes: 45,
    totalCarrierAcquisitions,
    totalWashCycles,
    totalCarrierReturns,
    overallReuseRatio,
    meanTurnaroundSeconds,
    peakTurnaroundSeconds: 185.0,
    pools,
  };
}

function summarizePlanetaryMixerTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftPlanetaryMixerTelemetry {
  const mixer = appliances.find((a) => a.appliance === "hobart-hl200");
  const cycles: MorningShiftMixerCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/mix",
      batchLabel: "Hazelnut Financier Batter #1 (Speed 1)",
      mixStage: "dry-blend-speed1",
      agitatorRpm: 107,
      specificWorkWhPerKg: 0.42,
      meanShaftTorqueNm: 4.18,
      torqueRippleNmPeakToPeak: 0.67,
      viscousHeatingWatts: 46.8,
      bowlWallHeatWatts: -3.2,
      emulsionIndex: 0.78,
    },
    {
      cycleIndex: 2,
      taskId: "coffee-preparation-batches#0/mix",
      batchLabel: "Coffee Financier Batter #1 (Speed 2)",
      mixStage: "batter-emulsify-speed2",
      agitatorRpm: 198,
      specificWorkWhPerKg: 1.06,
      meanShaftTorqueNm: 6.84,
      torqueRippleNmPeakToPeak: 1.44,
      viscousHeatingWatts: 141.8,
      bowlWallHeatWatts: 18.4,
      emulsionIndex: 0.94,
    },
  ];
  const status: MorningShiftPlanetaryMixerTelemetry["status"] =
    mixer?.status === "fault"
      ? "guard-interlock-open"
      : mixer?.status === "active"
        ? "emulsifying"
        : "homogenized-ready";
  return {
    status,
    totalSpecificWorkWhPerKg: 1.48,
    peakShaftTorqueNm: 6.84,
    maxTorqueRippleNmPeakToPeak: 1.44,
    peakViscousHeatingWatts: 141.8,
    meanEmulsionIndex: 0.86,
    cycles,
  };
}

function summarizeMilkFrotherTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftMilkFrotherTelemetry {
  const frother = appliances.find((a) => a.appliance === "severin-sm-3587");
  const cycles: MorningShiftFrotherCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "sesame-orders#0/heat-and-mix",
      drinkLabel: "Black Sesame Latte Microfoam #1 (Severin SM 3587)",
      whiskRpm: 2420,
      vortexShearRateInverseSec: 1604,
      microfoamOverrunPercent: 41.2,
      bubbleDiameterMicrons: 45.6,
      pitcherExitC: 63.6,
      wheyDenaturationPercent: 61.5,
      windowStatus: "optimal-microfoam-window",
    },
    {
      cycleIndex: 2,
      taskId: "sesame-orders#1/heat-and-mix",
      drinkLabel: "Black Sesame Latte Microfoam #2 (Severin SM 3587)",
      whiskRpm: 2390,
      vortexShearRateInverseSec: 1508,
      microfoamOverrunPercent: 42.6,
      bubbleDiameterMicrons: 44.4,
      pitcherExitC: 64.2,
      wheyDenaturationPercent: 63.2,
      windowStatus: "optimal-microfoam-window",
    },
  ];
  const status: MorningShiftMilkFrotherTelemetry["status"] =
    frother?.status === "active"
      ? "vortex-aerating"
      : "optimal-microfoam-window";
  return {
    status,
    meanMicrofoamOverrunPercent: 41.9,
    peakVortexShearRateInverseSec: 1604,
    meanBubbleDiameterMicrons: 45.0,
    meanWheyDenaturationPercent: 62.4,
    maxPitcherExitTempC: 64.2,
    cycles,
  };
}

function summarizeHobCoilThermalTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftHobCoilThermalTelemetry {
  const mih = appliances.find((a) => a.appliance === "maruzen-mih-02c");
  const vollrath = appliances.find((a) => a.appliance === "vollrath-59500p");
  const cycles: MorningShiftHobCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/brown-butter",
      appliance: "maruzen-mih-02c",
      vesselLabel: "Beurre Noisette Pan #1 (Maruzen MIH-02C)",
      coilFrequencyKhz: 24.8,
      couplingEfficiencyPercent: 88.4,
      panCenterC: 148.5,
      panRimC: 140.1,
      radialGradientC: 8.4,
      boilOffGps: 0.62,
      evaporatedGrams: 11.2,
    },
    {
      cycleIndex: 2,
      taskId: "tea-batches#0/heat-to-simmer",
      appliance: "maruzen-mih-02c",
      vesselLabel: "Ginger Decoction Reheat Pan #1 (Maruzen MIH-02C)",
      coilFrequencyKhz: 24.8,
      couplingEfficiencyPercent: 88.4,
      panCenterC: 102.6,
      panRimC: 95.8,
      radialGradientC: 6.8,
      boilOffGps: 0.88,
      evaporatedGrams: 14.1,
    },
    {
      cycleIndex: 3,
      taskId: "tea-batches#0/steep",
      appliance: "vollrath-59500p",
      vesselLabel: "Assam Black Tea Infusion Pan #1 (Vollrath 59500P)",
      coilFrequencyKhz: 28.5,
      couplingEfficiencyPercent: 86.2,
      panCenterC: 96.4,
      panRimC: 91.2,
      radialGradientC: 5.2,
      boilOffGps: 0.46,
      evaporatedGrams: 7.4,
    },
    {
      cycleIndex: 4,
      taskId: "milk-tea-batches#0/heat-and-stir-to-78c",
      appliance: "vollrath-59500p",
      vesselLabel: "Ginger Milk Tea Finishing Pan #1 (Vollrath 59500P)",
      coilFrequencyKhz: 28.5,
      couplingEfficiencyPercent: 86.2,
      panCenterC: 92.8,
      panRimC: 87.6,
      radialGradientC: 5.2,
      boilOffGps: 0.46,
      evaporatedGrams: 6.4,
    },
  ];
  const status: MorningShiftHobCoilThermalTelemetry["status"] =
    mih?.status === "active"
      ? "browning-high-gradient"
      : vollrath?.status === "active"
        ? "simmer-duty-modulated"
        : "igbt-coupled";
  return {
    status,
    meanCouplingEfficiencyPercent: 87.3,
    maxRadialGradientC: 8.4,
    peakPanCenterC: 148.5,
    peakBoilOffGps: 0.88,
    totalEvaporatedGrams: 39.1,
    cycles,
  };
}

function summarizePrecisionScaleTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftPrecisionScaleTelemetry {
  const scale = appliances.find((a) => a.appliance === "ohaus-ranger-3000");
  const weighings: MorningShiftScaleWeighEvent[] = [
    {
      weighIndex: 1,
      taskId: "hazelnut-preparation-batches#0/weigh-butter",
      ingredientLabel: "Unsalted Cultured Butter (Financier #1)",
      targetGrams: 150.0,
      settledGrams: 150.02,
      settlingTimeSeconds: 0.89,
      zeroTareDriftMg: 6.6,
      airDraftPeakMg: 56.5,
      filterRejectionDb: 39.8,
      stabilityStatus: "locked-stable",
    },
    {
      weighIndex: 2,
      taskId: "sesame-orders#0/dose",
      ingredientLabel: "Black Sesame Latte Dose #1 (concentrate + milk)",
      targetGrams: 286.0,
      settledGrams: 286.05,
      settlingTimeSeconds: 0.96,
      zeroTareDriftMg: 8.7,
      airDraftPeakMg: 71.0,
      filterRejectionDb: 41.4,
      stabilityStatus: "draft-filtered",
    },
    {
      weighIndex: 3,
      taskId: "espresso-orders#0/weigh-espresso-beans",
      ingredientLabel: "Espresso Single-Origin Dose #1",
      targetGrams: 18.0,
      settledGrams: 18.01,
      settlingTimeSeconds: 0.84,
      zeroTareDriftMg: 4.5,
      airDraftPeakMg: 42.0,
      filterRejectionDb: 38.2,
      stabilityStatus: "locked-stable",
    },
    {
      weighIndex: 4,
      taskId: "pour-over-order#0/weigh-pour-over-beans",
      ingredientLabel: "V60 Pour-Over Filter Dose #1",
      targetGrams: 22.0,
      settledGrams: 22.02,
      settlingTimeSeconds: 0.91,
      zeroTareDriftMg: 10.8,
      airDraftPeakMg: 85.5,
      filterRejectionDb: 41.4,
      stabilityStatus: "draft-filtered",
    },
  ];
  const status: MorningShiftPrecisionScaleTelemetry["status"] =
    scale?.status === "active" ? "draft-filtered" : "locked-stable";
  return {
    status,
    totalWeighings: Math.max(4, scale?.completedCount ?? 4),
    meanSettlingTimeSeconds: 0.9,
    maxSettlingTimeSeconds: 0.96,
    maxZeroTareDriftMg: 10.8,
    peakAirDraftDisturbanceMg: 85.5,
    meanFilterRejectionDb: 40.2,
    weighings,
  };
}

function summarizeEspressoBoilerTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftEspressoBoilerTelemetry {
  const linea = appliances.find(
    (a) => a.appliance === "la-marzocco-linea-classic-s-2g",
  );
  const shots: MorningShiftEspressoShotEvent[] = [
    {
      shotIndex: 1,
      taskId: "espresso-orders#0/extract-espresso",
      orderLabel: "Double Shot #1 (18 g dose → 36 g yield)",
      grouphead: "left",
      brewBoilerC: 93.2,
      groupheadEntryC: 93.2,
      groupheadMinC: 92.82,
      thermalDipC: 0.38,
      pidRecoverySeconds: 10.6,
      pidDutyPercent: 82.5,
      steamBoilerPressureBar: 1.16,
      steamDropBar: 0.16,
      steamRecoverySeconds: 13.3,
    },
    {
      shotIndex: 2,
      taskId: "espresso-orders#1/extract-espresso",
      orderLabel: "Double Shot #2 Back-to-Back (18 g → 36 g)",
      grouphead: "right",
      brewBoilerC: 93.07,
      groupheadEntryC: 93.11,
      groupheadMinC: 92.61,
      thermalDipC: 0.5,
      pidRecoverySeconds: 11.7,
      pidDutyPercent: 89.0,
      steamBoilerPressureBar: 1.1,
      steamDropBar: 0.22,
      steamRecoverySeconds: 14.6,
    },
  ];
  const status: MorningShiftEspressoBoilerTelemetry["status"] =
    linea?.status === "active" ? "back-to-back-recovery" : "pid-locked";
  return {
    status,
    brewBoilerSetpointC: 93.2,
    brewBoilerTempC: linea?.temperatureC ?? 93.1,
    minGroupheadTempC: 92.61,
    maxGroupheadThermalDipC: 0.5,
    meanPidRecoverySeconds: 11.2,
    steamBoilerSetpointC: 124.5,
    steamBoilerPressureBar: 1.16,
    maxSteamDropBar: 0.22,
    meanSteamRecoverySeconds: 14.0,
    shots,
  };
}

function summarizeOvenVentingRadiantTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftOvenVentingRadiantTelemetry {
  const oven = appliances.find((a) => a.appliance === "maruzen-mbco-5e");
  const decks: MorningShiftOvenDeckEvent[] = [
    {
      cycleIndex: 1,
      taskId: "steak-and-pepper-pie-batches#0/bake-pies",
      batchLabel: "Steak and pepper pie tray (Upper Deck)",
      deckZone: "upper-deck",
      chamberC: 200.0,
      chamberRhPercent: 9.5,
      damperOpenRatio: 0.62,
      steamInjectionMl: 0,
      steamVentingGps: 0.88,
      radiantFluxKwPerSqM: 3.42,
      convectiveFluxKwPerSqM: 2.46,
      totalFluxKwPerSqM: 5.88,
      moistureDiffusivitySqMPerSec: 4.2e-9,
      surfaceWaterActivityAw: 0.4,
    },
    {
      cycleIndex: 2,
      taskId: "load-hazelnut-a#0/bake",
      batchLabel: "Hazelnut financier tray (Front-Lower Nominal Deck)",
      deckZone: "front-lower-nominal",
      chamberC: 170.0,
      chamberRhPercent: 18.6,
      damperOpenRatio: 0.78,
      steamInjectionMl: 35.0,
      steamVentingGps: 0.74,
      radiantFluxKwPerSqM: 2.42,
      convectiveFluxKwPerSqM: 1.96,
      totalFluxKwPerSqM: 4.38,
      moistureDiffusivitySqMPerSec: 3.58e-9,
      surfaceWaterActivityAw: 0.48,
    },
    {
      cycleIndex: 3,
      taskId: "load-coffee-a#0/bake",
      batchLabel: "Coffee financier tray (Middle-Rear Hotspot Deck)",
      deckZone: "middle-rear-hotspot",
      chamberC: 184.0,
      chamberRhPercent: 14.2,
      damperOpenRatio: 0.78,
      steamInjectionMl: 35.0,
      steamVentingGps: 0.82,
      radiantFluxKwPerSqM: 3.88,
      convectiveFluxKwPerSqM: 2.54,
      totalFluxKwPerSqM: 6.42,
      moistureDiffusivitySqMPerSec: 5.21e-9,
      surfaceWaterActivityAw: 0.36,
    },
    {
      cycleIndex: 4,
      taskId: "load-matcha-a#0/bake",
      batchLabel: "Matcha financier tray (Front-Lower Nominal Deck)",
      deckZone: "front-lower-nominal",
      chamberC: 170.0,
      chamberRhPercent: 18.6,
      damperOpenRatio: 0.78,
      steamInjectionMl: 35.0,
      steamVentingGps: 0.74,
      radiantFluxKwPerSqM: 2.42,
      convectiveFluxKwPerSqM: 1.96,
      totalFluxKwPerSqM: 4.38,
      moistureDiffusivitySqMPerSec: 3.58e-9,
      surfaceWaterActivityAw: 0.48,
    },
  ];
  const status: MorningShiftOvenVentingRadiantTelemetry["status"] =
    oven?.status === "active"
      ? "damper-venting"
      : "hotspot-scorching-alert";
  return {
    status,
    nominalDeckFluxKwPerSqM: 4.38,
    hotspotDeckFluxKwPerSqM: 6.42,
    peakSteamVentingGps: 0.82,
    totalSteamInjectedMl: 105.0,
    peakMoistureDiffusivitySqMPerSec: 5.21e-9,
    minSurfaceWaterActivityAw: 0.32,
    decks,
  };
}

function summarizeDishwasherWarewashTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftDishwasherTelemetry {
  const dishwasher = appliances.find((a) => a.appliance === "winterhalter-uc-l");
  const completedCycles = dishwasher?.completedCount ?? 4;
  const totalCycles = Math.max(completedCycles, dishwasher?.totalCount ?? 12);
  const cycles: MorningShiftDishwasherCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/clean",
      vesselLabel: "Beurre Noisette Induction Pan #1",
      soilLoadCategory: "brown-butter-mould",
      washTankC: 62.4,
      rinseBoilerC: 85.2,
      detergentDosedMl: 8.4,
      rinseAidDosedMl: 0.84,
      washBathPh: 11.15,
      sanitizerPpm: 74.2,
      thermalHue: 4120,
      incomingWaterC: 15.5,
      preheatedWaterC: 41.8,
      greywaterDrainC: 34.2,
      heatRecoveredKj: 264.1,
      recoveryEfficiencyPercent: 56.6,
    },
    {
      cycleIndex: 2,
      taskId: "load-hazelnut-a#0/clean-mould",
      vesselLabel: "Financier 8-Cavity Silicone/Steel Mould A",
      soilLoadCategory: "brown-butter-mould",
      washTankC: 62.6,
      rinseBoilerC: 85.3,
      detergentDosedMl: 8.4,
      rinseAidDosedMl: 0.84,
      washBathPh: 11.12,
      sanitizerPpm: 72.8,
      thermalHue: 4180,
      incomingWaterC: 15.5,
      preheatedWaterC: 42.1,
      greywaterDrainC: 34.0,
      heatRecoveredKj: 267.1,
      recoveryEfficiencyPercent: 57.0,
    },
    {
      cycleIndex: 3,
      taskId: "sesame-orders#0/wash-jug",
      vesselLabel: "Black Sesame Latte Jug",
      soilLoadCategory: "sesame-oil-vessel",
      washTankC: 62.5,
      rinseBoilerC: 85.1,
      detergentDosedMl: 8.4,
      rinseAidDosedMl: 0.84,
      washBathPh: 11.18,
      sanitizerPpm: 71.5,
      thermalHue: 4090,
      incomingWaterC: 15.5,
      preheatedWaterC: 41.9,
      greywaterDrainC: 34.1,
      heatRecoveredKj: 265.1,
      recoveryEfficiencyPercent: 56.7,
    },
    {
      cycleIndex: 4,
      taskId: "tea-batches#0/wash-equipment",
      vesselLabel: "Ginger Black Tea Simmer Pan & Strainer",
      soilLoadCategory: "tannin-tea-pan",
      washTankC: 62.1,
      rinseBoilerC: 85.2,
      detergentDosedMl: 7.2,
      rinseAidDosedMl: 0.84,
      washBathPh: 10.94,
      sanitizerPpm: 75.6,
      thermalHue: 4150,
      incomingWaterC: 15.5,
      preheatedWaterC: 41.6,
      greywaterDrainC: 33.9,
      heatRecoveredKj: 262.1,
      recoveryEfficiencyPercent: 56.5,
    },
  ];

  const totalDetergentDosedMl = Number(
    cycles.reduce((sum, c) => sum + c.detergentDosedMl, 0).toFixed(2),
  );
  const totalRinseAidDosedMl = Number(
    cycles.reduce((sum, c) => sum + c.rinseAidDosedMl, 0).toFixed(2),
  );
  const totalGreywaterRecoveredKj = Number(
    cycles.reduce((sum, c) => sum + c.heatRecoveredKj, 0).toFixed(1),
  );
  const totalRecoveredWh = Number((totalGreywaterRecoveredKj / 3.6).toFixed(1));
  const heatRecoveryEfficiencyPercent = Number(
    (
      cycles.reduce((sum, c) => sum + c.recoveryEfficiencyPercent, 0) /
      cycles.length
    ).toFixed(1),
  );
  const status: MorningShiftDishwasherTelemetry["status"] =
    dishwasher?.status === "active"
      ? "heat-recovery-active"
      : "sanitizing-nominal";

  return {
    status,
    completedCycles,
    totalCycles,
    washTankC: 62.4,
    rinseBoilerC: 85.2,
    detergentConcentrationGPerL: 3.35,
    totalDetergentDosedMl,
    totalRinseAidDosedMl,
    sanitizerPpm: 73.5,
    washBathPh: 11.1,
    thermalHue: 4135,
    incomingMakeupWaterC: 15.5,
    preheatedWaterC: 41.9,
    greywaterDrainC: 34.1,
    totalGreywaterRecoveredKj,
    totalRecoveredWh,
    heatRecoveryEfficiencyPercent,
    cycles,
  };
}

function summarizeChillerColdCellTelemetry(
  appliances: readonly SynchronizedApplianceState[],
  roomDryBulbC = 22.1,
  relativeHumidityPercent = 52.0,
): MorningShiftChillerColdCellTelemetry {
  const chiller = appliances.find((a) => a.appliance === "hoshizaki-rt-120snj");
  const summary = chiller?.programSummary ?? "";
  const phase: MorningShiftChillerColdCellTelemetry["phase"] =
    summary.includes("Defrost Heater")
      ? "defrost-active"
      : summary.includes("Post-Defrost")
        ? "post-defrost-recovery"
        : summary.includes("Door Infiltration") || (chiller?.doorOpenRatio ?? 0) > 0
          ? "door-infiltration-pulldown"
          : "refrigerating";

  const roomHumidityFactor = Number(
    (1 + Math.max(0, relativeHumidityPercent - 48) * 0.015).toFixed(3),
  );
  const roomDeltaFactor = Number(
    (1 + Math.max(0, roomDryBulbC - 21) * 0.025).toFixed(3),
  );

  const events: MorningShiftChillerDoorInfiltrationEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/store-batter",
      batchLabel: "Financier Batter Cold Rest #1 (600 g)",
      phase: "door-infiltration-pulldown",
      doorOpenSeconds: 8.4,
      infiltrationHeatKj: Number((4.85 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((1.42 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 7.4,
      cabinetExitC: 3.4,
      evaporatorCoilC: -6.2,
      frostAccumulatedGrams: 1.7,
      defrostTriggered: false,
      condensateDrainedMl: 0,
    },
    {
      cycleIndex: 2,
      taskId: "sesame-orders#0/dose",
      batchLabel: "Day-Before Sesame Concentrate Pick #1 (door only)",
      phase: "defrost-active",
      doorOpenSeconds: 4.2,
      infiltrationHeatKj: Number((2.57 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((0.77 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 6.3,
      cabinetExitC: 4.2,
      evaporatorCoilC: 6.4,
      frostAccumulatedGrams: 0.26,
      defrostTriggered: true,
      condensateDrainedMl: 2.92,
    },
    {
      cycleIndex: 3,
      taskId: "load-hazelnut-a#0/transfer-cold-carrier",
      batchLabel: "Financier Tray Cold-Cell Stabilization (188 g)",
      phase: "post-defrost-recovery",
      doorOpenSeconds: 7.6,
      infiltrationHeatKj: Number((4.38 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((1.28 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 6.9,
      cabinetExitC: 3.3,
      evaporatorCoilC: -6.5,
      frostAccumulatedGrams: 1.39,
      defrostTriggered: false,
      condensateDrainedMl: 0,
    },
    {
      cycleIndex: 4,
      taskId: "sesame-orders#1/dose",
      batchLabel: "Day-Before Sesame Concentrate Pick #2 (door only)",
      phase: "defrost-active",
      doorOpenSeconds: 4.0,
      infiltrationHeatKj: Number((2.45 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((0.73 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 6.2,
      cabinetExitC: 4.1,
      evaporatorCoilC: 6.4,
      frostAccumulatedGrams: 0.24,
      defrostTriggered: true,
      condensateDrainedMl: 2.77,
    },
  ];

  const totalInfiltrationHeatKj = Number(
    events.reduce((sum, e) => sum + e.infiltrationHeatKj, 0).toFixed(2),
  );
  const totalCondensateDrainedMl = Number(
    events.reduce((sum, e) => sum + e.condensateDrainedMl, 0).toFixed(2),
  );
  const defrostCycleCount = events.filter((e) => e.defrostTriggered).length;
  const doorOpeningsCount = events.length * 2;
  const cabinetAirC = chiller?.temperatureC ?? 3.4;
  const cabinetInfiltrationPeakC = Math.max(
    cabinetAirC,
    ...events.map((e) => e.cabinetPeakC),
  );
  const evaporatorFrostGrams =
    phase === "defrost-active"
      ? 0.28
      : phase === "post-defrost-recovery"
        ? 0.64
        : 1.72;
  const peakFrostGrams = 3.18;
  const evaporatorCoilC =
    phase === "defrost-active"
      ? 6.4
      : phase === "door-infiltration-pulldown"
        ? -5.4
        : -6.5;
  const compressorRpm = chiller?.rpm ?? 900;
  const defrostHeaterWatts = phase === "defrost-active" ? 360 : 0;
  const compressorDutyPercent =
    phase === "defrost-active"
      ? 94.0
      : phase === "door-infiltration-pulldown" || chiller?.status === "active"
        ? 88.5
        : 64.0;
  const copEfficiency = Number(
    Math.max(
      1.68,
      2.28 - (roomDryBulbC - 21) * 0.045 - evaporatorFrostGrams * 0.08,
    ).toFixed(2),
  );

  return {
    phase,
    cabinetAirC,
    cabinetInfiltrationPeakC,
    evaporatorCoilC,
    evaporatorFrostGrams,
    peakFrostGrams,
    defrostCycleCount,
    totalCondensateDrainedMl,
    doorOpeningsCount,
    totalInfiltrationHeatKj,
    compressorRpm,
    compressorDutyPercent,
    defrostHeaterWatts,
    copEfficiency,
    events,
  };
}

function computeApplianceAcousticsAndVibration(
  appliance: MorningShiftApplianceCode,
  status: SynchronizedApplianceState["status"],
  completedCount: number,
  torqueNm: number,
  viscosityPas: number,
  pressureBar: number,
): Readonly<{
  acousticNoiseDba: number;
  vibrationMmPerSecRms: number;
  peakAcousticNoiseDba: number;
  peakVibrationMmPerSecRms: number;
  isRotary: boolean;
}> {
  const hasCycleHistory = status === "active" || completedCount > 0 || status === "fault";
  switch (appliance) {
    case "waring-wsg60": {
      // 18,000 RPM commercial spice/paste grinder
      const activeDba = Number(
        (83.6 + torqueNm * 1.8 + Math.min(12, viscosityPas) * 0.14).toFixed(1),
      );
      const activeVib = Number(
        (2.85 + Math.min(12, viscosityPas) * 0.22 + torqueNm * 1.35).toFixed(2),
      );
      const peakDba = hasCycleHistory ? Math.max(85.8, activeDba) : 38.0;
      const peakVib = hasCycleHistory ? Math.max(5.95, activeVib) : 0.08;
      if (status === "fault") {
        return {
          acousticNoiseDba: 72.4,
          vibrationMmPerSecRms: 3.15,
          peakAcousticNoiseDba: peakDba,
          peakVibrationMmPerSecRms: peakVib,
          isRotary: true,
        };
      }
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 44.2 : 38.0,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.34 : 0.08,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "vitamix-quiet-one": {
      // 9,500 RPM blender with magnetic sound enclosure (or +10 dBA / unseated jar vibration when lid-faulted)
      const activeDba = Number(
        (66.4 + torqueNm * 2.2 + Math.min(8, viscosityPas) * 0.32).toFixed(1),
      );
      const activeVib = Number(
        (1.75 + Math.min(8, viscosityPas) * 0.26 + torqueNm * 0.85).toFixed(2),
      );
      if (status === "fault") {
        return {
          acousticNoiseDba: 78.6,
          vibrationMmPerSecRms: 4.85,
          peakAcousticNoiseDba: 78.6,
          peakVibrationMmPerSecRms: 4.85,
          isRotary: true,
        };
      }
      const peakDba = hasCycleHistory ? Math.max(69.2, activeDba) : 38.5;
      const peakVib = hasCycleHistory ? Math.max(3.42, activeVib) : 0.09;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 43.8 : 38.5,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.28 : 0.09,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "hobart-hl200": {
      // 185 RPM 20-qt planetary mixer gearhead
      const activeDba = Number(
        (64.5 + torqueNm * 0.65 + Math.min(6, viscosityPas) * 0.4).toFixed(1),
      );
      const activeVib = Number(
        (1.45 + torqueNm * 0.24 + Math.min(6, viscosityPas) * 0.18).toFixed(2),
      );
      if (status === "fault") {
        // Interlock brake trip & safety cage alarm
        return {
          acousticNoiseDba: 74.8,
          vibrationMmPerSecRms: 3.42,
          peakAcousticNoiseDba: 74.8,
          peakVibrationMmPerSecRms: 4.65,
          isRotary: true,
        };
      }
      const peakDba = hasCycleHistory ? Math.max(72.8, activeDba) : 39.0;
      const peakVib = hasCycleHistory ? Math.max(4.52, activeVib) : 0.1;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 45.6 : 39.0,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.42 : 0.1,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "la-marzocco-linea-classic-s-2g": {
      // 1,725 RPM 9-bar brass rotary vane pump
      const activeDba = Number((63.8 + pressureBar * 0.62).toFixed(1));
      const activeVib = Number((1.25 + pressureBar * 0.16).toFixed(2));
      const peakDba = hasCycleHistory ? Math.max(69.4, activeDba) : 43.5;
      const peakVib = hasCycleHistory ? Math.max(2.69, activeVib) : 0.18;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 46.8 : 43.5,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.36 : 0.18,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "severin-sm-3587": {
      // 2,400 RPM magnetic induction milk frother
      const activeDba = Number((56.4 + viscosityPas * 4.5).toFixed(1));
      const activeVib = Number((0.92 + viscosityPas * 0.8).toFixed(2));
      const peakDba = hasCycleHistory ? Math.max(57.2, activeDba) : 37.5;
      const peakVib = hasCycleHistory ? Math.max(1.06, activeVib) : 0.06;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 40.2 : 37.5,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.14 : 0.06,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "maruzen-mbco-5e": {
      // 1,450 RPM reversing convection blower
      const liveDba =
        status === "fault"
          ? 66.2
          : status === "active"
            ? 59.5
            : completedCount > 0
              ? 48.4
              : 41.0;
      const liveVib =
        status === "active" ? 1.18 : completedCount > 0 ? 0.45 : 0.14;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? Math.max(59.5, liveDba) : 41.0,
        peakVibrationMmPerSecRms: hasCycleHistory ? 1.18 : 0.14,
        isRotary: true,
      };
    }
    case "hoshizaki-rt-120snj": {
      // 2,100 / 900 RPM hermetic rotary refrigeration compressor
      const liveDba = Number(
        (status === "active"
          ? 54.2 + (pressureBar - 1.8) * 2.5
          : 47.5 + (pressureBar - 1.8) * 1.8
        ).toFixed(1),
      );
      const liveVib = status === "active" ? 1.38 : 0.62;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: Math.max(55.7, liveDba),
        peakVibrationMmPerSecRms: 1.38,
        isRotary: true,
      };
    }
    case "winterhalter-uc-l": {
      // 2,800 RPM undercounter wash circulation pump
      const liveDba =
        status === "fault"
          ? 64.5
          : status === "active"
            ? 63.4
            : completedCount > 0
              ? 44.5
              : 42.0;
      const liveVib =
        status === "active" ? 1.95 : completedCount > 0 ? 0.28 : 0.15;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? 63.4 : 42.0,
        peakVibrationMmPerSecRms: hasCycleHistory ? 1.95 : 0.15,
        isRotary: true,
      };
    }
    case "maruzen-mih-02c":
    case "vollrath-59500p": {
      const liveDba =
        status === "active" ? 54.8 : completedCount > 0 ? 42.5 : 39.5;
      const liveVib =
        status === "active" ? 0.56 : completedCount > 0 ? 0.12 : 0.08;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? 54.8 : 39.5,
        peakVibrationMmPerSecRms: hasCycleHistory ? 0.56 : 0.08,
        isRotary: false,
      };
    }
    case "ohaus-ranger-3000":
      return {
        acousticNoiseDba: 36.5,
        vibrationMmPerSecRms: 0.04,
        peakAcousticNoiseDba: 36.5,
        peakVibrationMmPerSecRms: 0.04,
        isRotary: false,
      };
    case "pastry-bench": {
      const liveDba =
        status === "active" ? 48.2 : completedCount > 0 ? 38.4 : 37.0;
      const liveVib =
        status === "active" ? 0.34 : completedCount > 0 ? 0.06 : 0.04;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? 48.2 : 37.0,
        peakVibrationMmPerSecRms: hasCycleHistory ? 0.34 : 0.04,
        isRotary: false,
      };
    }
  }
}

function recoveryDelayForAppliance(
  appliance: MorningShiftApplianceCode,
): number {
  switch (appliance) {
    case "hobart-hl200":
      return 34;
    case "vitamix-quiet-one":
      return 34;
    case "maruzen-mbco-5e":
      return 48;
    case "winterhalter-uc-l":
      return 32;
    case "pastry-bench":
      return 30;
    default:
      return 30;
  }
}

const CASCADE_BATCH_TEMPLATE: readonly Readonly<{
  batchId: string;
  workflowLabel: string;
  cellId: "tea-pan-cell" | "espresso-cell" | "pour-over-cell";
}>[] = [
  {
    batchId: "load-hazelnut-a#0",
    workflowLabel: "Hazelnut financier tray",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "load-coffee-a#0",
    workflowLabel: "Coffee financier tray",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "load-matcha-a#0",
    workflowLabel: "Matcha financier tray",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "tea-batches#0",
    workflowLabel: "Ginger Black Tea #1",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "milk-tea-batches#0",
    workflowLabel: "Ginger Milk Tea #1",
    cellId: "tea-pan-cell",
  },
  {
    batchId: "espresso-orders#0",
    workflowLabel: "Espresso Order #1",
    cellId: "espresso-cell",
  },
  {
    batchId: "espresso-orders#1",
    workflowLabel: "Espresso Order #2",
    cellId: "espresso-cell",
  },
  {
    batchId: "pour-over-order#0",
    workflowLabel: "Pour-Over V60 #1",
    cellId: "pour-over-cell",
  },
  {
    batchId: "pour-over-order#1",
    workflowLabel: "Pour-Over V60 #2",
    cellId: "pour-over-cell",
  },
];

export function summarizeMorningShiftMassAccounting(
  logistics?: LogisticsView | null,
): MorningShiftMassAccountingSummary {
  const executedOrCompletedTasks = new Set<string>();
  if (logistics?.kind === "available") {
    for (const t of logistics.tasks) {
      if (t.kind === "executing" || t.kind === "completed") {
        executedOrCompletedTasks.add(t.id);
      }
    }
  }
  // The tea has one step after its inspection, for an accepted or a rejected
  // batch. The milk tea's finishing steps run only after an accepted batch.
  const tea0Accepted = executedOrCompletedTasks.has(
    "tea-batches#0/serve-or-discard",
  );
  const milkTea0Accepted = executedOrCompletedTasks.has(
    "milk-tea-batches#0/add-milk-and-sugar-at-55c",
  );

  const lots: MorningShiftLotMassRecord[] = [
    {
      batchId: "load-hazelnut-a#0",
      workflowLabel: "Hazelnut financier tray",
      gateTaskId: "load-hazelnut-a#0/inspect-bake",
      gateKind: "bake-maillard-gate",
      measuredMetric: "0.214 Maillard",
      outcome: "accepted",
      inputMassGrams: 200.0,
      acceptedYieldGrams: 164.5,
      rejectedScrapGrams: 0,
      qcSampleGrams: 23.5,
      byproductOrLossGrams: 12.0,
      reworkAction: "7 pieces packed (164.5 g) · 1 QC sample (23.5 g)",
    },
    {
      batchId: "load-coffee-a#0",
      workflowLabel: "Coffee financier tray",
      gateTaskId: "load-coffee-a#0/inspect-bake",
      gateKind: "bake-maillard-gate",
      measuredMetric: "0.418 Maillard (> 0.350)",
      outcome: "rejected-rework",
      inputMassGrams: 200.0,
      acceptedYieldGrams: 0,
      rejectedScrapGrams: 188.0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 12.0,
      reworkAction: "Scrap 188 g scorched tray → wash mould & re-queue",
    },
    {
      batchId: "load-matcha-a#0",
      workflowLabel: "Matcha financier tray",
      gateTaskId: "load-matcha-a#0/inspect-bake",
      gateKind: "bake-maillard-gate",
      measuredMetric: "0.208 Maillard",
      outcome: "accepted",
      inputMassGrams: 200.0,
      acceptedYieldGrams: 188.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 12.0,
      reworkAction: "8 pieces packed (188.0 g)",
    },
    {
      batchId: "tea-batches#0",
      workflowLabel: "Ginger Black Tea #1",
      gateTaskId: "tea-batches#0/inspect-strained-tea",
      gateKind: "tea-extraction-gate",
      measuredMetric: tea0Accepted ? "18.6% EY" : "22.4% EY (> 21.0% late strain)",
      outcome: tea0Accepted ? "accepted" : "rejected-rework",
      inputMassGrams: 506.0,
      acceptedYieldGrams: tea0Accepted ? 435.0 : 0,
      rejectedScrapGrams: tea0Accepted ? 0 : 435.0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 71.0,
      reworkAction: tea0Accepted
        ? "2 tea servings accepted (435.0 g)"
        : "Scrap 435 g astringent extract → wash pan & re-brew",
    },
    {
      batchId: "milk-tea-batches#0",
      workflowLabel: "Ginger Milk Tea #1",
      gateTaskId: "milk-tea-batches#0/inspect-strained-tea",
      gateKind: "tea-extraction-gate",
      measuredMetric: milkTea0Accepted
        ? "18.9% EY"
        : "21.8% EY (> 21.0% late strain)",
      outcome: milkTea0Accepted ? "accepted" : "rejected-rework",
      inputMassGrams: 436.0,
      acceptedYieldGrams: milkTea0Accepted ? 365.0 : 0,
      rejectedScrapGrams: milkTea0Accepted ? 0 : 365.0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 71.0,
      reworkAction: milkTea0Accepted
        ? "Milk tea base accepted (365.0 g)"
        : "Scrap 365 g over-steeped base → wash pan & re-steep",
    },
    {
      batchId: "sesame-orders#0",
      workflowLabel: "Black Sesame Latte #1",
      gateTaskId: "sesame-orders#0/dose",
      gateKind: "drink-dose-gate",
      measuredMetric: "286.05 g dose",
      outcome: "accepted",
      inputMassGrams: 286.0,
      acceptedYieldGrams: 286.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 0,
      reworkAction: "Dose from the day-before concentrate served (286.0 g)",
    },
    {
      batchId: "espresso-orders#0",
      workflowLabel: "Espresso Double Shot #1",
      gateTaskId: "espresso-orders#0/extract-espresso",
      gateKind: "espresso-extraction-gate",
      measuredMetric: "19.8% EY (9.0 bar)",
      outcome: "accepted",
      inputMassGrams: 54.0,
      acceptedYieldGrams: 36.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 18.0,
      reworkAction: "Double shot served (36.0 g · 18.0 g spent puck)",
    },
    {
      batchId: "pour-over-order#0",
      workflowLabel: "Pour-Over V60 #1",
      gateTaskId: "pour-over-order#0/brew-pour-over",
      gateKind: "pour-over-extraction-gate",
      measuredMetric: "19.2% EY (V60 drawdown)",
      outcome: "accepted",
      inputMassGrams: 377.0,
      acceptedYieldGrams: 310.0,
      rejectedScrapGrams: 0,
      qcSampleGrams: 0,
      byproductOrLossGrams: 67.0,
      reworkAction: "Carafe served (310.0 g · 45.0 g spent coffee bed)",
    },
  ];

  let acceptedLots = 0;
  let rejectedLots = 0;
  let totalInputGrams = 0;
  let totalAcceptedGrams = 0;
  let totalRejectedScrapGrams = 0;
  let totalQcSampleGrams = 0;
  let totalByproductOrLossGrams = 0;

  for (const lot of lots) {
    if (lot.outcome === "accepted") acceptedLots += 1;
    else rejectedLots += 1;
    totalInputGrams += lot.inputMassGrams;
    totalAcceptedGrams += lot.acceptedYieldGrams;
    totalRejectedScrapGrams += lot.rejectedScrapGrams;
    totalQcSampleGrams += lot.qcSampleGrams;
    totalByproductOrLossGrams += lot.byproductOrLossGrams;
  }

  const netEvaluatedGrams = totalAcceptedGrams + totalRejectedScrapGrams;
  const firstPassYieldPercent = Number(
    (netEvaluatedGrams > 0
      ? (totalAcceptedGrams / netEvaluatedGrams) * 100
      : 100
    ).toFixed(1),
  );

  return {
    evaluatedLots: lots.length,
    acceptedLots,
    rejectedLots,
    totalInputGrams: Number(totalInputGrams.toFixed(1)),
    totalAcceptedGrams: Number(totalAcceptedGrams.toFixed(1)),
    totalRejectedScrapGrams: Number(totalRejectedScrapGrams.toFixed(1)),
    totalQcSampleGrams: Number(totalQcSampleGrams.toFixed(1)),
    totalByproductOrLossGrams: Number(totalByproductOrLossGrams.toFixed(1)),
    firstPassYieldPercent,
    reworkLoopCount: rejectedLots,
    lots,
  };
}

export function summarizeMorningShiftFaultCascade(
  faults: Readonly<Record<string, ApplianceFaultRecord>> | null | undefined,
): MorningShiftFaultCascadeSummary {
  const sourceFaults = Object.values(faults ?? {});
  const activeFaults = sourceFaults.filter((f) => !f.restored);
  const restoredFaults = sourceFaults.filter((f) => f.restored);
  const totalRecoveryDelaySeconds = sourceFaults.reduce(
    (sum, f) => sum + recoveryDelayForAppliance(f.appliance),
    0,
  );
  const allCells: readonly (
    | "tea-pan-cell"
    | "espresso-cell"
    | "pour-over-cell"
  )[] = ["tea-pan-cell", "espresso-cell", "pour-over-cell"];
  if (activeFaults.length > 0) {
    return {
      activeFaultCount: activeFaults.length,
      restoredFaultCount: restoredFaults.length,
      totalRecoveryDelaySeconds,
      status: "held",
      heldCells: allCells,
      recoveredCells: [],
      affectedBatches: CASCADE_BATCH_TEMPLATE.map((item) => ({
        ...item,
        delaySeconds: totalRecoveryDelaySeconds,
        status: "held",
      })),
      sourceFaults,
    };
  }
  if (restoredFaults.length > 0) {
    return {
      activeFaultCount: 0,
      restoredFaultCount: restoredFaults.length,
      totalRecoveryDelaySeconds,
      status: "recovered",
      heldCells: [],
      recoveredCells: allCells,
      affectedBatches: CASCADE_BATCH_TEMPLATE.map((item) => ({
        ...item,
        delaySeconds: totalRecoveryDelaySeconds,
        status: "recovered",
      })),
      sourceFaults,
    };
  }
  return {
    activeFaultCount: 0,
    restoredFaultCount: 0,
    totalRecoveryDelaySeconds: 0,
    status: "nominal",
    heldCells: [],
    recoveredCells: [],
    affectedBatches: [],
    sourceFaults: [],
  };
}

export function synchronizeCobotTransfers(
  cells: readonly Readonly<{
    scene: Readonly<{ cell: Readonly<{ cellId: string; robot: string }> }>;
    frame: OvenLiveFrame | null;
  }>[],
  logistics: LogisticsView,
  scenario?: CompiledScenario,
  timeUs = 0,
  faults: Readonly<Record<string, ApplianceFaultRecord>> | null = null,
): readonly SynchronizedCobotTransferState[] {
  let completedTransfers = 0;
  let totalTransfers = 0;
  let executingTransferTask: TaskView | null = null;
  if (logistics.kind === "available") {
    for (const task of logistics.tasks) {
      if (task.subject.kind !== "workflow") continue;
      const key = task.subject.key;
      if (
        key === "stage-pan" ||
        key === "stage-pan-b" ||
        key === "transfer-cold-carrier" ||
        key.includes("oven") ||
        key.includes("rack")
      ) {
        totalTransfers += 1;
        if (task.kind === "completed") completedTransfers += 1;
        else if (task.kind === "executing") executingTransferTask = task;
      }
    }
  }
  const frameByCell = new Map<string, OvenLiveFrame | null>();
  for (const c of cells) {
    frameByCell.set(c.scene.cell.cellId, c.frame);
  }
  const results: BaseCobotTransferEntry[] = cells.map(
    ({ scene, frame }) => {
      if (frame === null) {
        return {
          cellId: scene.cell.cellId,
          robot: scene.cell.robot,
          status: executingTransferTask !== null ? "executing" : "idle",
          taskId: executingTransferTask?.id ?? null,
          label:
            executingTransferTask?.id ??
            "Baker pan & cold-carrier station ready",
          step: 0,
          committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
          completedTransfers,
          totalTransfers,
          progress: executingTransferTask !== null ? 0.5 : 0,
          phase: executingTransferTask !== null ? "transfer" : "idle",
          cascadeHold: null,
        };
      }
      const status: SynchronizedCobotTransferState["status"] =
        frame.purpose === "operation"
          ? "executing"
          : frame.purpose === "recovery"
            ? "recovery"
            : frame.purpose === "admission" || frame.purpose === "removal"
              ? "handoff"
              : "idle";
      const taskId =
        frame.purpose === "operation" || frame.purpose === "recovery"
          ? frame.task
          : (executingTransferTask?.id ?? null);
      const motion =
        frame.purpose === "admission" || frame.purpose === "removal"
          ? frame.after.motion
          : frame.motion;
      const lastSample =
        motion !== undefined
          ? motion.samples[motion.samples.length - 1]
          : undefined;
      return {
        cellId: scene.cell.cellId,
        robot: scene.cell.robot,
        status,
        taskId,
        label:
          frame.purpose === "operation" || frame.purpose === "recovery"
            ? frame.task
            : frame.purpose === "admission" || frame.purpose === "removal"
              ? `${frame.purpose}: ${frame.boundary}`
              : (executingTransferTask?.id ?? "Idle between carrier transfers"),
        step: lastSample?.step ?? 0,
        committedSeconds: Number((frame.committedAt / 1_000_000).toFixed(1)),
        completedTransfers,
        totalTransfers,
        progress: status === "executing" ? 0.5 : completedTransfers > 0 ? 1 : 0,
        phase: frame.purpose,
        cascadeHold: null,
      };
    },
  );

  appendBeverageCobotCells(results, logistics, scenario, timeUs);

  const faultValues = Object.values(faults ?? {});
  const activeFault = faultValues.find((f) => !f.restored) ?? null;
  const restoredFault = faultValues.find((f) => f.restored) ?? null;
  if (activeFault !== null) {
    const delaySeconds = faultValues
      .filter((f) => !f.restored)
      .reduce((sum, f) => sum + recoveryDelayForAppliance(f.appliance), 0);
    return results.map((entry) => {
      const affectedBatches =
        entry.cellId === "espresso-cell"
          ? ["espresso-orders#0", "espresso-orders#1", "sesame-orders#0"]
          : entry.cellId === "pour-over-cell"
            ? ["pour-over-order#0", "pour-over-order#1"]
            : [
                "load-hazelnut-a#0",
                "load-coffee-a#0",
                "load-matcha-a#0",
                "tea-batches#0",
                "milk-tea-batches#0",
              ];
      const phase = `cascade-held:${activeFault.appliance}`;
      return {
        ...entry,
        status: "cascade-held",
        label: `HELD (${activeFault.code}) · ${entry.label}`,
        phase,
        ...computeCobotKinematicsAndDynamics(
          entry.cellId,
          "cascade-held",
          phase,
          entry.progress,
          frameByCell.get(entry.cellId) ?? null,
        ),
        cascadeHold: {
          heldByAppliance: activeFault.appliance,
          heldByFaultCode: activeFault.code,
          affectedBatches,
          delaySeconds,
          restored: false,
          checkpointDigest: activeFault.checkpointDigest,
        },
      };
    });
  }
  if (restoredFault !== null) {
    const delaySeconds = faultValues.reduce(
      (sum, f) => sum + recoveryDelayForAppliance(f.appliance),
      0,
    );
    return results.map((entry) => {
      const affectedBatches =
        entry.cellId === "espresso-cell"
          ? ["espresso-orders#0", "espresso-orders#1", "sesame-orders#0"]
          : entry.cellId === "pour-over-cell"
            ? ["pour-over-order#0", "pour-over-order#1"]
            : [
                "load-hazelnut-a#0",
                "load-coffee-a#0",
                "load-matcha-a#0",
                "tea-batches#0",
                "milk-tea-batches#0",
              ];
      return {
        ...entry,
        label: `Recovered (+${delaySeconds}s) · ${entry.label}`,
        ...computeCobotKinematicsAndDynamics(
          entry.cellId,
          entry.status,
          entry.phase,
          entry.progress,
          frameByCell.get(entry.cellId) ?? null,
        ),
        cascadeHold: {
          heldByAppliance: restoredFault.appliance,
          heldByFaultCode: restoredFault.code,
          affectedBatches,
          delaySeconds,
          restored: true,
          checkpointDigest: restoredFault.checkpointDigest,
        },
      };
    });
  }

  return results.map((entry) => ({
    ...entry,
    ...computeCobotKinematicsAndDynamics(
      entry.cellId,
      entry.status,
      entry.phase,
      entry.progress,
      frameByCell.get(entry.cellId) ?? null,
    ),
  }));
}
