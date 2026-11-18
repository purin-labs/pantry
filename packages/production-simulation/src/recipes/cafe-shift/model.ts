export type CafeShiftAppliance = "linea" | "eagle-one";

export type CafeShiftGrinder =
  | "miicoffee-df64-gen2"
  | "option-o-lagom-casa"
  | "timemore-bricks-01s"
  | "fellow-opus-2";

export type CafeShiftIceMakerMode =
  | "jet-spray-freezing"
  | "hot-gas-harvest"
  | "bin-full-standby"
  | "door-open-scoop";

export type CafeShiftStaffing = "two-workers" | "single-worker";

export type CafeShiftCheck =
  | "none"
  | "reject-second-load"
  | "interrupted-extraction";

export type CafeShiftPhase =
  | "batter-and-order-1"
  | "deposit-and-order-2"
  | "bake-and-bar-service"
  | "bake-review-and-demould"
  | "crumb-check-and-pack"
  | "completed"
  | "failed";

export type CafeShiftRecipeConfig = Readonly<{
  appliance: CafeShiftAppliance;
  grinder?: CafeShiftGrinder;
  financierLoads: 1 | 2 | 3;
  espressoOrders: 2 | 4;
  staffing: CafeShiftStaffing;
  check: CafeShiftCheck;
}>;

export const DEFAULT_CAFE_SHIFT_RECIPE: CafeShiftRecipeConfig = {
  appliance: "linea",
  grinder: "miicoffee-df64-gen2",
  financierLoads: 1,
  espressoOrders: 2,
  staffing: "two-workers",
  check: "none",
};

export function cafeShiftGrinderLabel(grinder: CafeShiftGrinder): string {
  switch (grinder) {
    case "miicoffee-df64-gen2":
      return "MiiCoffee DF64 II (Gen 2)";
    case "option-o-lagom-casa":
      return "Option-O Lagom Casa";
    case "timemore-bricks-01s":
      return "Timemore Bricks 01S";
    case "fellow-opus-2":
      return "Fellow Opus 2";
  }
}

export function cafeShiftGrinderNominalRpm(grinder: CafeShiftGrinder): number {
  switch (grinder) {
    case "miicoffee-df64-gen2":
      return 1400;
    case "option-o-lagom-casa":
      return 200;
    case "timemore-bricks-01s":
      return 450;
    case "fellow-opus-2":
      return 400;
  }
}

export type CafeShiftSample = Readonly<{
  step: number;
  timeSeconds: number;
  logicalClockS: number;
  phase: CafeShiftPhase;
  phaseProgress: number;
  appliance: CafeShiftAppliance;
  grinder: CafeShiftGrinder;
  grinderRpm: number;
  groundDoseG: number;
  staffing: CafeShiftStaffing;
  financierLoads: 1 | 2 | 3;
  espressoOrders: 2 | 4;
  /** Baker Cobot (FR10 #1) telemetry */
  bakerStatus: string;
  bakerJoints: readonly [number, number, number, number, number, number];
  bakerGripperOpen: number;
  butterTempC: number;
  hobartRpm: number;
  batterPreparedG: number;
  retainedBatterG: number;
  depositedCavities: number;
  ovenTempC: number;
  bakeProgress: number;
  bosseHeightMm: number;
  acceptedLoads: number;
  rejectedLoads: number;
  rejectedFinanciers: number;
  rejectedMassG: number;
  demouldedPieces: number;
  crumbSamplePieces: number;
  crumbSampleMassG: number;
  packedFinanciers: number;
  packedNetMassG: number;
  ribbonSealed: number;
  /** Barista Cobot (FR10 #2) & Espresso telemetry */
  baristaStatus: string;
  baristaJoints: readonly [number, number, number, number, number, number];
  baristaGripperOpen: number;
  activeOrderIndex: number;
  shotState: "idle" | "dispensing" | "complete" | "interrupted";
  shotElapsedS: number;
  brewPressureBar: number;
  coffeeBoilerC: number;
  steamBoilerC: number;
  activeCupMassG: number;
  servedOrders: number;
  servedEspressoG: number;
  discardedEspressoG: number;
  spentPucks: number;
  /** Hoshizaki IM-35P undercounter ice maker telemetry */
  iceMakerMode: CafeShiftIceMakerMode;
  iceMakerPowerW: number;
  iceBinStockKg: number;
  iceDoorAngleRad: number;
  iceWaterPlateAngleRad: number;
  /** Shared clock & contention metrics */
  workerContentionWaitS: number;
  ovenOccupancyPct: number;
  espressoOccupancyPct: number;
  note: string;
}>;

  export type CafeShiftOutcome =
  | Readonly<{
      kind: "completed";
      appliance: CafeShiftAppliance;
      grinder: CafeShiftGrinder;
      staffing: CafeShiftStaffing;
      financierLoads: 1 | 2 | 3;
      espressoOrders: 2 | 4;
      servedOrders: number;
      servedEspressoG: number;
      discardedEspressoG: number;
      packedFinanciers: number;
      packedNetMassG: number;
      crumbSamplePieces: number;
      crumbSampleMassG: number;
      rejectedFinanciers: number;
      rejectedMassG: number;
      retainedBatterG: number;
      logicalClockS: number;
      workerContentionWaitS: number;
      check: CafeShiftCheck;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
      phase: CafeShiftPhase;
    }>;

export type CafeShiftTimelineStage = Readonly<{
  id: Exclude<CafeShiftPhase, "completed" | "failed">;
  label: string;
  shortLabel: string;
  startS: number;
  endS: number;
}>;

export function cafeShiftTimelineStages(
  config: CafeShiftRecipeConfig = DEFAULT_CAFE_SHIFT_RECIPE,
): readonly CafeShiftTimelineStage[] {
  const d1 = 7.0;
  const d2 = 7.0;
  const d3 = config.financierLoads >= 2 ? 9.0 : 7.5;
  const d4 = 6.5;
  const d5 = 6.5;
  const t1 = d1;
  const t2 = t1 + d2;
  const t3 = t2 + d3;
  const t4 = t3 + d4;
  const t5 = t4 + d5;
  return [
    {
      id: "batter-and-order-1",
      label: "1 · Beurre Noisette, HL200 Mix & Espresso Order 1 (36.0 g)",
      shortLabel: "Batter + Shot 1",
      startS: 0,
      endS: t1,
    },
    {
      id: "deposit-and-order-2",
      label: `2 · Matsunaga 8P Depositing (${config.financierLoads * 8} cavities) & Espresso Order 2`,
      shortLabel: "8P Dose + Shot 2",
      startS: t1,
      endS: t2,
    },
    {
      id: "bake-and-bar-service",
      label: "3 · Maruzen MBCO-5E 170 °C Bosse Bake & Bar Service Coasters",
      shortLabel: "170 °C Bake + Bar",
      startS: t2,
      endS: t3,
    },
    {
      id: "bake-review-and-demould",
      label: "4 · Bake Quality Review, 16-Rack Cool & Wire-Grid Demould",
      shortLabel: "Bake Review & Demould",
      startS: t3,
      endS: t4,
    },
    {
      id: "crumb-check-and-pack",
      label: "5 · 23.5 g Ohaus Crumb Sample & Gold-Ribbon Ballotin Pack",
      shortLabel: "Crumb & Gift Box",
      startS: t4,
      endS: t5,
    },
  ];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

function lerpJoints(
  a: readonly [number, number, number, number, number, number],
  b: readonly [number, number, number, number, number, number],
  t: number,
): readonly [number, number, number, number, number, number] {
  const u = clamp01(t);
  const s = u * u * (3 - 2 * u);
  return [
    lerp(a[0], b[0], s),
    lerp(a[1], b[1], s),
    lerp(a[2], b[2], s),
    lerp(a[3], b[3], s),
    lerp(a[4], b[4], s),
    lerp(a[5], b[5], s),
  ];
}

const BAKER_POSE_HOME: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [-0.25, -0.92, -1.48, -0.72, 1.57, 0.15];
const BAKER_POSE_HOB: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [-0.62, -1.04, -1.56, -0.58, 1.57, -0.22];
const BAKER_POSE_MIXER: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [-0.92, -0.88, -1.42, -0.78, 1.57, -0.45];
const BAKER_POSE_DEPOSIT: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [-0.18, -1.08, -1.54, -0.52, 1.57, 0.18];
const BAKER_POSE_OVEN: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.42, -0.96, -1.44, -0.68, 1.57, 0.52];
const BAKER_POSE_RACK: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [-0.48, -0.94, -1.48, -0.66, 1.57, -0.14];
const BAKER_POSE_GIFTBOX: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.14, -1.02, -1.52, -0.58, 1.57, 0.28];

const BARISTA_POSE_HOME: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.35, -0.94, -1.52, -0.66, 1.57, 0.22];
const BARISTA_POSE_GROUP_LEFT: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.12, -1.06, -1.58, -0.54, 1.57, 0.08];
const BARISTA_POSE_GROUP_RIGHT: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.44, -1.04, -1.56, -0.56, 1.57, 0.34];
const BARISTA_POSE_COASTER: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.26, -1.14, -1.62, -0.46, 1.57, 0.18];
const BARISTA_POSE_KNOCKBOX: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
] = [-0.14, -1.08, -1.54, -0.52, 1.57, -0.12];

export class CafeShiftSimulationEngine {
  readonly config: CafeShiftRecipeConfig;
  private readonly stages: readonly CafeShiftTimelineStage[];
  private stepCount = 0;
  private elapsedS = 0;
  private outcomeState: CafeShiftOutcome | null = null;

  constructor(config: CafeShiftRecipeConfig = DEFAULT_CAFE_SHIFT_RECIPE) {
    // Reject-second-load acceptance always uses at least 2 financier loads
    const effectiveLoads =
      config.check === "reject-second-load" && config.financierLoads < 2
        ? 2
        : config.financierLoads;
    this.config = {
      ...config,
      financierLoads: effectiveLoads,
    };
    this.stages = cafeShiftTimelineStages(this.config);
  }

  get outcome(): CafeShiftOutcome | null {
    return this.outcomeState;
  }

  get totalDurationS(): number {
    return this.stages[this.stages.length - 1]!.endS;
  }

  reset(): CafeShiftSample {
    this.stepCount = 0;
    this.elapsedS = 0;
    this.outcomeState = null;
    return this.sampleAt(0, 0);
  }

  step(dtSeconds = 0.05): CafeShiftSample {
    if (this.outcomeState !== null) {
      return this.sampleAt(this.stepCount, this.elapsedS);
    }
    this.stepCount += 1;
    this.elapsedS = Math.min(this.totalDurationS, this.elapsedS + dtSeconds);
    return this.sampleAt(this.stepCount, this.elapsedS);
  }

  seek(timeSeconds: number): CafeShiftSample {
    this.outcomeState = null;
    this.elapsedS = Math.max(0, Math.min(this.totalDurationS, timeSeconds));
    this.stepCount = Math.round(this.elapsedS / 0.05);
    return this.sampleAt(this.stepCount, this.elapsedS);
  }

  private sampleAt(step: number, timeS: number): CafeShiftSample {
    const [s1, s2, s3, s4, s5] = this.stages as [
      CafeShiftTimelineStage,
      CafeShiftTimelineStage,
      CafeShiftTimelineStage,
      CafeShiftTimelineStage,
      CafeShiftTimelineStage,
    ];
    const loads = this.config.financierLoads;
    const grinder: CafeShiftGrinder =
      this.config.grinder ?? "miicoffee-df64-gen2";
    const nominalGrinderRpm = cafeShiftGrinderNominalRpm(grinder);
    const totalCavities = loads * 8;
    const totalBatterG = 726.0;
    const targetDepositG = loads * 200.0;
    const targetRetainedBatterG = Math.max(0, totalBatterG - targetDepositG);
    const orders = this.config.espressoOrders;
    const targetServedEspressoG = orders * 36.0;
    const isSingleWorker = this.config.staffing === "single-worker";
    const maxContentionWaitS = isSingleWorker
      ? 45 * loads + 18 * (orders - 1)
      : 0;

    // Logical shift clock in simulated factory seconds (5,710 s for 1 load, 6,680 s for 2 loads)
    const totalLogicalClockS =
      (loads === 1 ? 5710 : loads === 2 ? 6680 : 7640) + maxContentionWaitS;
    const logicalClockS = Math.round(
      lerp(0, totalLogicalClockS, timeS / s5.endS),
    );

    if (timeS < s1.endS) {
      const p = clamp01((timeS - s1.startS) / (s1.endS - s1.startS));
      const bakerJoints =
        p < 0.5
          ? lerpJoints(BAKER_POSE_HOME, BAKER_POSE_HOB, p / 0.5)
          : lerpJoints(BAKER_POSE_HOB, BAKER_POSE_MIXER, (p - 0.5) / 0.5);
      const baristaJoints =
        p < 0.25
          ? lerpJoints(BARISTA_POSE_HOME, BARISTA_POSE_GROUP_LEFT, p / 0.25)
          : p < 0.82
            ? lerpJoints(
                BARISTA_POSE_GROUP_LEFT,
                BARISTA_POSE_HOME,
                (p - 0.25) / 0.57,
              )
            : lerpJoints(
                BARISTA_POSE_HOME,
                BARISTA_POSE_COASTER,
                (p - 0.82) / 0.18,
              );
      const shotDispensing = p >= 0.2 && p < 0.82;
      const shotP = clamp01((p - 0.2) / 0.62);
      const order1Served = p >= 0.82;

      return {
        step,
        timeSeconds: timeS,
        logicalClockS,
        phase: "batter-and-order-1",
        phaseProgress: p,
        appliance: this.config.appliance,
        grinder,
        grinderRpm: p < 0.2 ? nominalGrinderRpm : 0,
        groundDoseG: lerp(0, 18.0, clamp01(p / 0.2)),
        staffing: this.config.staffing,
        financierLoads: loads,
        espressoOrders: orders,
        bakerStatus:
          p < 0.5
            ? "Browning 240 g butter to 152 °C beurre noisette on Maruzen MIH-02C"
            : "Folding almond-sugar-egg white batter in Hobart HL200 (726.0 g)",
        bakerJoints,
        bakerGripperOpen: 0.45,
        butterTempC: p < 0.5 ? lerp(22, 152, p / 0.5) : lerp(152, 64, (p - 0.5) / 0.5),
        hobartRpm: p >= 0.45 ? 115 : 0,
        batterPreparedG: lerp(0, totalBatterG, p),
        retainedBatterG: lerp(0, totalBatterG, p),
        depositedCavities: 0,
        ovenTempC: 170,
        bakeProgress: 0,
        bosseHeightMm: 0,
        acceptedLoads: 0,
        rejectedLoads: 0,
        rejectedFinanciers: 0,
        rejectedMassG: 0,
        demouldedPieces: 0,
        crumbSamplePieces: 0,
        crumbSampleMassG: 0,
        packedFinanciers: 0,
        packedNetMassG: 0,
        ribbonSealed: 0,
        baristaStatus: shotDispensing
          ? `Extracting Espresso Order 1 on ${this.config.appliance === "linea" ? "Linea Classic S" : "Eagle One"} (9.0 bar · ${(shotP * 36).toFixed(1)} g)`
          : order1Served
            ? "Serving Espresso Order 1 (36.0 g) to brass service coaster #1"
            : "Placing preheated porcelain demitasse #1 on left group grate",
        baristaJoints,
        baristaGripperOpen: shotDispensing ? 0.85 : 0.42,
        activeOrderIndex: 1,
        shotState: shotDispensing
          ? "dispensing"
          : order1Served
            ? "complete"
            : "idle",
        shotElapsedS: shotDispensing ? lerp(0, 18, shotP) : order1Served ? 18 : 0,
        brewPressureBar: shotDispensing ? 9.0 : 0,
        coffeeBoilerC: 93.0,
        steamBoilerC: 125.0,
        activeCupMassG: lerp(0, 36.0, shotP),
        servedOrders: order1Served ? 1 : 0,
        servedEspressoG: order1Served ? 36.0 : 0,
        discardedEspressoG: 0,
        spentPucks: order1Served ? 1 : 0,
        iceMakerMode: "jet-spray-freezing",
        iceMakerPowerW: 195,
        iceBinStockKg: 10.0,
        iceDoorAngleRad: 0,
        iceWaterPlateAngleRad: 0,
        workerContentionWaitS: isSingleWorker ? Math.round(lerp(0, 22, p)) : 0,
        ovenOccupancyPct: 12,
        espressoOccupancyPct: shotDispensing ? 88 : 42,
        note: isSingleWorker
          ? "Single-worker contention: operator alternates between induction butter browning and Espresso Order 1."
          : "Parallel shift clock: Baker Cobot prepares 726.0 g beurre noisette batter while Barista Cobot extracts Espresso Order 1 (36.0 g).",
      };
    }

    if (timeS < s2.endS) {
      const p = clamp01((timeS - s2.startS) / (s2.endS - s2.startS));
      const depositedCavities = Math.min(
        totalCavities,
        Math.floor(p * (totalCavities + 0.8)),
      );
      const depositedG = Math.min(targetDepositG, depositedCavities * 25.0);
      const retainedBatterG = Math.max(
        targetRetainedBatterG,
        totalBatterG - depositedG,
      );
      const bakerJoints =
        p < 0.78
          ? lerpJoints(BAKER_POSE_MIXER, BAKER_POSE_DEPOSIT, p / 0.78)
          : lerpJoints(
              BAKER_POSE_DEPOSIT,
              BAKER_POSE_OVEN,
              (p - 0.78) / 0.22,
            );

      const hasInterruption = this.config.check === "interrupted-extraction";
      const isInterruptedWindow = hasInterruption && p >= 0.42 && p < 0.58;
      const shotDispensing =
        (p >= 0.15 && p < 0.42) || (p >= 0.58 && p < 0.88);
      const order2Served = p >= 0.88;
      const discardedEspressoG =
        hasInterruption && p >= 0.42 ? 18.0 : 0;
      const activeCupMassG = isInterruptedWindow
        ? 18.0
        : p < 0.42
          ? lerp(0, 18.0, clamp01((p - 0.15) / 0.27))
          : lerp(0, 36.0, clamp01((p - 0.58) / 0.3));

      const baristaJoints = isInterruptedWindow
        ? lerpJoints(
            BARISTA_POSE_GROUP_RIGHT,
            BARISTA_POSE_KNOCKBOX,
            (p - 0.42) / 0.16,
          )
        : order2Served
          ? lerpJoints(
              BARISTA_POSE_GROUP_RIGHT,
              BARISTA_POSE_COASTER,
              (p - 0.88) / 0.12,
            )
          : lerpJoints(
              BARISTA_POSE_COASTER,
              BARISTA_POSE_GROUP_RIGHT,
              clamp01(p / 0.35),
            );

      return {
        step,
        timeSeconds: timeS,
        logicalClockS,
        phase: "deposit-and-order-2",
        phaseProgress: p,
        appliance: this.config.appliance,
        grinder,
        grinderRpm: p < 0.15 ? nominalGrinderRpm : 0,
        groundDoseG: 18.0 + lerp(0, 18.0, clamp01(p / 0.15)),
        staffing: this.config.staffing,
        financierLoads: loads,
        espressoOrders: orders,
        bakerStatus:
          p < 0.78
            ? `Depositing 25.0 g/cavity into Matsunaga 8P moulds (${depositedCavities}/${totalCavities} cavities)`
            : `Loading ${loads} Matsunaga 8P mould${loads > 1 ? "s" : ""} into Maruzen MBCO-5E (170 °C)`,
        bakerJoints,
        bakerGripperOpen: 0.38,
        butterTempC: 54,
        hobartRpm: 0,
        batterPreparedG: totalBatterG,
        retainedBatterG,
        depositedCavities,
        ovenTempC: 170,
        bakeProgress: 0,
        bosseHeightMm: 0,
        acceptedLoads: 0,
        rejectedLoads: 0,
        rejectedFinanciers: 0,
        rejectedMassG: 0,
        demouldedPieces: 0,
        crumbSamplePieces: 0,
        crumbSampleMassG: 0,
        packedFinanciers: 0,
        packedNetMassG: 0,
        ribbonSealed: 0,
        baristaStatus: isInterruptedWindow
          ? "Extraction interrupted at 9.0 s (18.0 g held); clearing portafilter & restarting Order 2"
          : order2Served
            ? "Espresso Order 2 (36.0 g) served · 72.0 g cumulative espresso on brass coasters"
            : "Extracting Espresso Order 2 (18.0 g dose → 36.0 g shot at 9.0 bar)",
        baristaJoints,
        baristaGripperOpen: shotDispensing ? 0.82 : 0.42,
        activeOrderIndex: 2,
        shotState: isInterruptedWindow
          ? "interrupted"
          : shotDispensing
            ? "dispensing"
            : order2Served
              ? "complete"
              : "idle",
        shotElapsedS: isInterruptedWindow
          ? 9.0
          : order2Served
            ? 18.0
            : lerp(0, 18.0, clamp01((p - 0.15) / 0.73)),
        brewPressureBar: shotDispensing ? 9.0 : 0,
        coffeeBoilerC: 93.0,
        steamBoilerC: 125.0,
        activeCupMassG,
        servedOrders: order2Served ? 2 : 1,
        servedEspressoG: order2Served ? 72.0 : 36.0,
        discardedEspressoG,
        spentPucks: order2Served ? 2 : 1,
        iceMakerMode: p < 0.65 ? "hot-gas-harvest" : "bin-full-standby",
        iceMakerPowerW: p < 0.65 ? 215 : 6,
        iceBinStockKg: p < 0.65 ? 10.0 : 10.73,
        iceDoorAngleRad: 0,
        iceWaterPlateAngleRad:
          p < 0.65 ? Math.sin((p / 0.65) * Math.PI) * 0.464 : 0,
        workerContentionWaitS: isSingleWorker
          ? Math.round(lerp(22, maxContentionWaitS * 0.72, p))
          : 0,
        ovenOccupancyPct: p >= 0.78 ? 65 : 22,
        espressoOccupancyPct: 86,
        note: isInterruptedWindow
          ? "Process replacement recovery: interrupted 18.0 g shot is discarded and Order 2 re-extracts without duplicating Order 1."
          : `Baker Cobot portions ${depositedG.toFixed(1)} g batter (${retainedBatterG.toFixed(1)} g retained in inventory) while Barista Cobot completes Order 2.`,
      };
    }

    if (timeS < s3.endS) {
      const p = clamp01((timeS - s3.startS) / (s3.endS - s3.startS));
      const extraOrders = orders === 4 ? (p >= 0.85 ? 2 : p >= 0.45 ? 1 : 0) : 0;
      const servedOrders = 2 + extraOrders;
      const servedEspressoG = servedOrders * 36.0;
      const discardedEspressoG =
        this.config.check === "interrupted-extraction" ? 18.0 : 0;
      const bakerJoints = lerpJoints(BAKER_POSE_OVEN, BAKER_POSE_HOME, p);
      const baristaJoints =
        orders === 4 && p < 0.85
          ? lerpJoints(
              BARISTA_POSE_GROUP_LEFT,
              BARISTA_POSE_COASTER,
              (p * 2) % 1,
            )
          : lerpJoints(BARISTA_POSE_COASTER, BARISTA_POSE_HOME, p);

      return {
        step,
        timeSeconds: timeS,
        logicalClockS,
        phase: "bake-and-bar-service",
        phaseProgress: p,
        appliance: this.config.appliance,
        grinder,
        grinderRpm: orders === 4 && p < 0.35 ? nominalGrinderRpm : 0,
        groundDoseG: servedOrders * 18.0,
        staffing: this.config.staffing,
        financierLoads: loads,
        espressoOrders: orders,
        bakerStatus: `Baking ${loads} Matsunaga 8P load${loads > 1 ? "s" : ""} in Maruzen MBCO-5E at 170 °C (bosse crown ${lerp(0, 10.8, p).toFixed(1)} mm)`,
        bakerJoints,
        bakerGripperOpen: 0.75,
        butterTempC: 42,
        hobartRpm: 0,
        batterPreparedG: totalBatterG,
        retainedBatterG: targetRetainedBatterG,
        depositedCavities: totalCavities,
        ovenTempC: lerp(170, 174, Math.sin(p * Math.PI)),
        bakeProgress: p,
        bosseHeightMm: lerp(0, 10.8, p),
        acceptedLoads: 0,
        rejectedLoads: 0,
        rejectedFinanciers: 0,
        rejectedMassG: 0,
        demouldedPieces: 0,
        crumbSamplePieces: 0,
        crumbSampleMassG: 0,
        packedFinanciers: 0,
        packedNetMassG: 0,
        ribbonSealed: 0,
        baristaStatus:
          orders === 4 && servedOrders < 4
            ? `Extracting rush Espresso Order ${servedOrders + 1} (${servedEspressoG.toFixed(1)} g served)`
            : `All ${servedOrders} espresso orders (${servedEspressoG.toFixed(1)} g) served on brass coasters · knock-box cleared`,
        baristaJoints,
        baristaGripperOpen: 0.65,
        activeOrderIndex: servedOrders,
        shotState: orders === 4 && p < 0.85 ? "dispensing" : "complete",
        shotElapsedS: 18.0,
        brewPressureBar: orders === 4 && p < 0.85 ? 9.0 : 0,
        coffeeBoilerC: 93.0,
        steamBoilerC: 125.0,
        activeCupMassG: 36.0,
        servedOrders,
        servedEspressoG,
        discardedEspressoG,
        spentPucks: servedOrders + (discardedEspressoG > 0 ? 1 : 0),
        iceMakerMode:
          p >= 0.3 && p < 0.7 ? "door-open-scoop" : "bin-full-standby",
        iceMakerPowerW: p >= 0.3 && p < 0.7 ? 4 : 6,
        iceBinStockKg: p >= 0.5 ? 9.53 : 10.73,
        iceDoorAngleRad:
          p >= 0.3 && p < 0.7
            ? Math.sin(((p - 0.3) / 0.4) * Math.PI) * 0.908
            : 0,
        iceWaterPlateAngleRad: 0,
        workerContentionWaitS: isSingleWorker
          ? Math.round(lerp(maxContentionWaitS * 0.72, maxContentionWaitS, p))
          : 0,
        ovenOccupancyPct: 96,
        espressoOccupancyPct: orders === 4 ? 92 : 68,
        note: `Maruzen MBCO-5E bakes ${totalCavities} financiers (6.0% moisture loss: 25.0 g → 23.5 g/piece) while ${servedEspressoG.toFixed(1)} g espresso is served.`,
      };
    }

    const rejectSecond = this.config.check === "reject-second-load";
    const rejectedLoads = rejectSecond ? 1 : 0;
    const acceptedLoads = Math.max(1, loads - rejectedLoads);
    const rejectedFinanciers = rejectedLoads * 8;
    const rejectedMassG = rejectedFinanciers * 23.5;
    const acceptedPieces = acceptedLoads * 8;
    const discardedEspressoG =
      this.config.check === "interrupted-extraction" ? 18.0 : 0;

    if (timeS < s4.endS) {
      const p = clamp01((timeS - s4.startS) / (s4.endS - s4.startS));
      const demouldedPieces = Math.min(
        acceptedPieces,
        Math.floor(clamp01((p - 0.25) / 0.75) * (acceptedPieces + 0.8)),
      );
      const bakerJoints =
        p < 0.45
          ? lerpJoints(BAKER_POSE_OVEN, BAKER_POSE_RACK, p / 0.45)
          : lerpJoints(BAKER_POSE_RACK, BAKER_POSE_DEPOSIT, (p - 0.45) / 0.55);

      return {
        step,
        timeSeconds: timeS,
        logicalClockS,
        phase: "bake-review-and-demould",
        phaseProgress: p,
        appliance: this.config.appliance,
        grinder,
        grinderRpm: 0,
        groundDoseG: orders * 18.0,
        staffing: this.config.staffing,
        financierLoads: loads,
        espressoOrders: orders,
        bakerStatus: rejectSecond
          ? `Bake review: Load 1 accepted (8 pcs) · Load 2 rejected (8 pcs · 188.0 g disposed) · Demoulding ${demouldedPieces}/${acceptedPieces}`
          : `Bake review passed (${acceptedLoads} load${acceptedLoads > 1 ? "s" : ""}) · Inverting Matsunaga 8P onto wire cooling grid (${demouldedPieces}/${acceptedPieces} pcs)`,
        bakerJoints,
        bakerGripperOpen: 0.42,
        butterTempC: 35,
        hobartRpm: 0,
        batterPreparedG: totalBatterG,
        retainedBatterG: targetRetainedBatterG,
        depositedCavities: totalCavities,
        ovenTempC: 168,
        bakeProgress: 1,
        bosseHeightMm: 10.8,
        acceptedLoads,
        rejectedLoads,
        rejectedFinanciers,
        rejectedMassG,
        demouldedPieces,
        crumbSamplePieces: 0,
        crumbSampleMassG: 0,
        packedFinanciers: 0,
        packedNetMassG: 0,
        ribbonSealed: 0,
        baristaStatus: `Espresso bar standby · ${targetServedEspressoG.toFixed(1)} g served across ${orders} orders`,
        baristaJoints: BARISTA_POSE_HOME,
        baristaGripperOpen: 0.75,
        activeOrderIndex: orders,
        shotState: "complete",
        shotElapsedS: 18.0,
        brewPressureBar: 0,
        coffeeBoilerC: 93.0,
        steamBoilerC: 125.0,
        activeCupMassG: 36.0,
        servedOrders: orders,
        servedEspressoG: targetServedEspressoG,
        discardedEspressoG,
        spentPucks: orders + (discardedEspressoG > 0 ? 1 : 0),
        iceMakerMode: "jet-spray-freezing",
        iceMakerPowerW: 195,
        iceBinStockKg: 9.53,
        iceDoorAngleRad: 0,
        iceWaterPlateAngleRad: 0,
        workerContentionWaitS: maxContentionWaitS,
        ovenOccupancyPct: 82,
        espressoOccupancyPct: 64,
        note: rejectSecond
          ? "Plan 61E fault journey: Load 2 (8 financiers · 188.0 g) fails bake review and is routed to disposal outside saleable output."
          : `Baker Cobot unloads Maruzen MBCO-5E to the 16-level rack and demoulds ${acceptedPieces} financiers onto the wire cooling grid.`,
      };
    }

    const p = clamp01((timeS - s5.startS) / (s5.endS - s5.startS));
    const crumbSamplePieces = p >= 0.15 ? 1 : 0;
    const crumbSampleMassG = crumbSamplePieces * 23.5;
    const targetPacked = Math.max(0, acceptedPieces - 1);
    const packedFinanciers = Math.min(
      targetPacked,
      Math.floor(clamp01((p - 0.25) / 0.58) * (targetPacked + 0.85)),
    );
    const packedNetMassG = packedFinanciers * 23.5;
    const ribbonSealed = clamp01((p - 0.82) / 0.18);
    const isCompleted = timeS >= s5.endS - 1e-6;

    if (isCompleted && this.outcomeState === null) {
      this.outcomeState = {
        kind: "completed",
        appliance: this.config.appliance,
        grinder,
        staffing: this.config.staffing,
        financierLoads: loads,
        espressoOrders: orders,
        servedOrders: orders,
        servedEspressoG: targetServedEspressoG,
        discardedEspressoG,
        packedFinanciers: targetPacked,
        packedNetMassG: targetPacked * 23.5,
        crumbSamplePieces: 1,
        crumbSampleMassG: 23.5,
        rejectedFinanciers,
        rejectedMassG,
        retainedBatterG: targetRetainedBatterG,
        logicalClockS: totalLogicalClockS,
        workerContentionWaitS: maxContentionWaitS,
        check: this.config.check,
      };
    }

    const bakerJoints =
      p < 0.3
        ? lerpJoints(BAKER_POSE_DEPOSIT, BAKER_POSE_GIFTBOX, p / 0.3)
        : lerpJoints(BAKER_POSE_GIFTBOX, BAKER_POSE_HOME, (p - 0.3) / 0.7);

    return {
      step,
      timeSeconds: timeS,
      logicalClockS,
      phase: isCompleted ? "completed" : "crumb-check-and-pack",
      phaseProgress: isCompleted ? 1 : p,
      appliance: this.config.appliance,
      grinder,
      grinderRpm: 0,
      groundDoseG: orders * 18.0,
      staffing: this.config.staffing,
      financierLoads: loads,
      espressoOrders: orders,
      bakerStatus: isCompleted
        ? `Café shift complete: ${targetPacked} packed financiers (${(targetPacked * 23.5).toFixed(1)} g) + ${targetServedEspressoG.toFixed(1)} g espresso served`
        : `Ohaus 23.5 g crumb sample verified · Packing ${packedFinanciers}/${targetPacked} financiers into gold-ribbon ballotin`,
      bakerJoints,
      bakerGripperOpen: isCompleted ? 0.75 : 0.45,
      butterTempC: 28,
      hobartRpm: 0,
      batterPreparedG: totalBatterG,
      retainedBatterG: targetRetainedBatterG,
      depositedCavities: totalCavities,
      ovenTempC: 162,
      bakeProgress: 1,
      bosseHeightMm: 10.8,
      acceptedLoads,
      rejectedLoads,
      rejectedFinanciers,
      rejectedMassG,
      demouldedPieces: acceptedPieces,
      crumbSamplePieces,
      crumbSampleMassG,
      packedFinanciers: isCompleted ? targetPacked : packedFinanciers,
      packedNetMassG: isCompleted ? targetPacked * 23.5 : packedNetMassG,
      ribbonSealed: isCompleted ? 1 : ribbonSealed,
      baristaStatus: `Service complete: ${orders} cups (${targetServedEspressoG.toFixed(1)} g espresso) on brass coasters`,
      baristaJoints: BARISTA_POSE_HOME,
      baristaGripperOpen: 0.75,
      activeOrderIndex: orders,
      shotState: "complete",
      shotElapsedS: 18.0,
      brewPressureBar: 0,
      coffeeBoilerC: 93.0,
      steamBoilerC: 125.0,
      activeCupMassG: 36.0,
      servedOrders: orders,
      servedEspressoG: targetServedEspressoG,
      discardedEspressoG,
      spentPucks: orders + (discardedEspressoG > 0 ? 1 : 0),
      iceMakerMode: isCompleted ? "bin-full-standby" : "jet-spray-freezing",
      iceMakerPowerW: isCompleted ? 6 : 195,
      iceBinStockKg: isCompleted ? 10.26 : lerp(9.53, 10.26, p),
      iceDoorAngleRad: 0,
      iceWaterPlateAngleRad: 0,
      workerContentionWaitS: maxContentionWaitS,
      ovenOccupancyPct: 74,
      espressoOccupancyPct: 62,
      note: isCompleted
        ? `Accepted Plan 61E café shift: ${targetServedEspressoG.toFixed(1)} g served espresso, ${targetPacked} packed financiers (${(targetPacked * 23.5).toFixed(1)} g), 1 crumb sample (23.5 g)${rejectedFinanciers > 0 ? `, ${rejectedFinanciers} rejected (${rejectedMassG.toFixed(1)} g)` : ""}, and ${targetRetainedBatterG.toFixed(1)} g retained batter.`
        : "Baker Cobot weighs 1 × 23.5 g crumb sample on the Ohaus Ranger 3000 and packs the remaining financiers into the gold-ribbon ballotin.",
    };
  }
}
