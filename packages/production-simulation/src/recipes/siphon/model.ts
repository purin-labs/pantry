import { ROBOTS } from "@seams/bakery-model/bakery-robots";
import type { StationPose } from "../pour-over/sample.ts";
import {
  fr10Links,
  fr10ToolKinematics,
  quatRotateExpanded as quatRotate,
} from "../../kinematics/fr10.ts";

export type SiphonProcessCheck =
  | "none"
  | "unsealed-gasket"
  | "clogged-filter"
  | "lost-grip";

export type SiphonRecipeConfig = Readonly<{
  revision: number;
  waterG: number;
  coffeeG: number;
  steepSeconds: number;
  check: SiphonProcessCheck;
}>;

export type SiphonPhase =
  | "preheat-seal"
  | "upflow"
  | "fold-in"
  | "steep"
  | "whirlpool"
  | "drawdown"
  | "completed"
  | "failed";

export type SiphonDeviation = Readonly<{
  kind: "unsealed-gasket" | "slow-drawdown" | "lost-paddle-grip";
  atStep: number;
  detail: string;
}>;

export type SiphonOutcome =
  | Readonly<{
      kind: "completed";
      beverageMg: number;
      spentBedMg: number;
      retainedLowerMg: number;
      evaporatedMg: number;
      tdsPct: number;
      extractionYieldPct: number;
    }>
  | Readonly<{
      kind: "failed";
      reason: "unsealed-gasket-leak" | "lost-paddle-grip";
    }>;

export type SiphonSample = Readonly<{
  step: number;
  timeS: number;
  joints: readonly number[];
  fingers: readonly [number, number];
  gripper: StationPose;
  lowerBowl: StationPose;
  upperBowl: StationPose;
  paddle: StationPose;
  heater: Readonly<{
    mode: "high-350w" | "hold-110w" | "off";
    powerW: number;
    radiativeW: number;
    glow: number;
  }>;
  thermo: Readonly<{
    lowerC: number;
    upperC: number;
    pressureKPa: number;
    vaporPressureKPa: number;
    vacuumKPa: number;
    bubbleRate: number;
    swirlRadS: number;
  }>;
  extraction: Readonly<{
    coffeeDoseG: number;
    wettingFraction: number;
    tdsPct: number;
    extractionYieldPct: number;
    solublesMg: number;
    co2FoamMm: number;
    crustBuoyancy: number;
  }>;
  water: Readonly<{
    initialG: number;
    lowerG: number;
    stemG: number;
    upperFreeG: number;
    absorbedG: number;
    beverageG: number;
    evaporatedG: number;
    flowGS: number;
    domeHeightM: number;
  }>;
  control: Readonly<{
    phase: SiphonPhase;
    stage: string;
    brewS: number;
    steepRemainingS: number | null;
    stirCount: number;
    sealed: boolean;
    deviations: readonly SiphonDeviation[];
  }>;
  outcome: SiphonOutcome | null;
}>;

export type SiphonBody =
  | "world"
  | "si_lower_bowl"
  | "si_upper_bowl"
  | "si_paddle"
  | "po_gripper"
  | "po_finger_left"
  | "po_finger_right";

export type SiphonSetup = Readonly<{
  robotBase: StationPose;
  robotGlbSha256: string;
  geometry: readonly Readonly<{
    name: string;
    body: SiphonBody;
    shape: "box" | "cylinder" | "capsule";
    size: readonly [number, number, number];
    pose: StationPose;
    rgba: readonly [number, number, number, number];
  }>[];
  fingers: Readonly<
    Record<
      "left" | "right",
      Readonly<{ pose: StationPose; axis: readonly [number, number, number] }>
    >
  >;
}>;

/** Exact MuJoCo 3.13.0 station setup from `scripts/bakery-robots/siphon_station.py`. */
export const SIPHON_STATION_SETUP: SiphonSetup = {
  robotBase: [0, 0, 0.75, 1, 0, 0, 0],
  robotGlbSha256: ROBOTS["fairino-fr10"].glbSha256,
  geometry: [
    {
      name: "pedestal_column",
      body: "world",
      shape: "box",
      size: [0.1, 0.1, 0.35],
      pose: [0, 0, 0.35, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "pedestal_plate",
      body: "world",
      shape: "box",
      size: [0.18, 0.18, 0.025],
      pose: [0, 0, 0.725, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "si_bench_top",
      body: "world",
      shape: "box",
      size: [0.3, 0.42, 0.02],
      pose: [0.62, 0, 0.78, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "si_bench_leg_1",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.36, -0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "si_bench_leg_2",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.36, 0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "si_bench_leg_3",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.88, -0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "si_bench_leg_4",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.88, 0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "po_grip_adapter",
      body: "po_gripper",
      shape: "cylinder",
      size: [0.04, 0.012, 0],
      pose: [0.012, 0, 0, 0.707107, 0, 0.707107, 0],
      rgba: [0.65, 0.7, 0.72, 1],
    },
    {
      name: "po_grip_palm",
      body: "po_gripper",
      shape: "box",
      size: [0.015, 0.05, 0.03],
      pose: [0.045, 0, 0, 1, 0, 0, 0],
      rgba: [0.12, 0.38, 0.4, 1],
    },
    {
      name: "po_finger_left_link",
      body: "po_finger_left",
      shape: "box",
      size: [0.024, 0.004, 0.012],
      pose: [0.084, 0.004, 0, 1, 0, 0, 0],
      rgba: [0.12, 0.38, 0.4, 1],
    },
    {
      name: "po_finger_left_pad",
      body: "po_finger_left",
      shape: "box",
      size: [0.016, 0.005, 0.025],
      pose: [0.13, 0, 0, 1, 0, 0, 0],
      rgba: [0.12, 0.14, 0.14, 1],
    },
    {
      name: "po_finger_left_pad_front",
      body: "po_finger_left",
      shape: "capsule",
      size: [0.002, 0.022, 0],
      pose: [0.138, -0.004, 0, 0, 1, 0, 0],
      rgba: [0.08, 0.09, 0.09, 1],
    },
    {
      name: "po_finger_left_pad_back",
      body: "po_finger_left",
      shape: "capsule",
      size: [0.002, 0.022, 0],
      pose: [0.122, -0.004, 0, 0, 1, 0, 0],
      rgba: [0.08, 0.09, 0.09, 1],
    },
    {
      name: "po_finger_right_link",
      body: "po_finger_right",
      shape: "box",
      size: [0.024, 0.004, 0.012],
      pose: [0.084, -0.004, 0, 1, 0, 0, 0],
      rgba: [0.12, 0.38, 0.4, 1],
    },
    {
      name: "po_finger_right_pad",
      body: "po_finger_right",
      shape: "box",
      size: [0.016, 0.005, 0.025],
      pose: [0.13, 0, 0, 1, 0, 0, 0],
      rgba: [0.12, 0.14, 0.14, 1],
    },
    {
      name: "po_finger_right_pad_front",
      body: "po_finger_right",
      shape: "capsule",
      size: [0.002, 0.022, 0],
      pose: [0.138, 0.004, 0, 0, 1, 0, 0],
      rgba: [0.08, 0.09, 0.09, 1],
    },
    {
      name: "po_finger_right_pad_back",
      body: "po_finger_right",
      shape: "capsule",
      size: [0.002, 0.022, 0],
      pose: [0.122, 0.004, 0, 0, 1, 0, 0],
      rgba: [0.08, 0.09, 0.09, 1],
    },
  ],
  fingers: {
    left: {
      pose: [0, 0.014, 0, 1, 0, 0, 0],
      axis: [0, 1, 0],
    },
    right: {
      pose: [0, -0.014, 0, 1, 0, 0, 0],
      axis: [0, -1, 0],
    },
  },
};

type JointVector = readonly [number, number, number, number, number, number];
type Quat = readonly [number, number, number, number];
type Vec3 = readonly [number, number, number];

type Waypoint = Readonly<{
  joints: JointVector;
  gripper: StationPose;
  tool: Vec3;
}>;
const waypointFromJoints: (joints: JointVector) => Waypoint = fr10ToolKinematics(fr10Links([0, 0, 0.75]));

/**
 * MuJoCo 3.13.0 inverse-kinematics joint configurations solved by `siphon_station.py`
 * for the FAIRINO FR10 arm (`< 1e-9` residual error, zero unintended contacts).
 */
const JOINT_TARGETS: Readonly<Record<string, JointVector>> = {
  ready: [-0.28665, -1.45532, -2.68072, -2.14715, -1.85744, 1.57079],
  flask_approach: [0.38912, -1.51562, -2.82017, -1.94739, -1.18167, 1.57079],
  flask_grasp: [0.23849, -1.69777, -2.61735, -1.96806, -1.33231, 1.57079],
  flask_lift: [0.23849, -1.34637, -2.43201, -2.50481, -1.33231, 1.57079],
  flask_carry: [0.74917, -1.44873, -2.35612, -2.47834, -0.82163, 1.57079],
  flask_place: [0.74917, -1.61884, -2.46845, -2.1959, -0.82163, 1.57079],
  seal_press: [0.74917, -1.6377, -2.47706, -2.16842, -0.82163, 1.57079],
  seal_retract: [1.04865, -1.45434, -2.65086, -2.17799, -0.52215, 1.57079],
  paddle_hover: [-0.2003, -2.04139, -1.87014, -3.94246, -1.57079, 1.37049],
  paddle_grasp: [-0.20031, -2.15601, -1.9132, -3.78477, -1.57079, 1.37049],
  paddle_lift_topdown: [-0.2003, -1.92299, -1.77811, -4.15288, -1.57079, 1.37049],
  paddle_tilt: [0.09589, -1.46454, -2.005, -3.60135, -1.50304, 1.6387],
  stir_hover: [0.74917, -1.35686, -2.24451, -2.68181, -0.82163, 1.57079],
};

/** 8-point MuJoCo IK ring centered at `[0.62, 0.14, 1.132]` (`r = 0.018 m`) inside the BU-ECA-3 upper bowl. */
const STIR_RING_JOINTS: readonly JointVector[] = [
  [0.71792, -1.50033, -2.3519, -2.43095, -0.85288, 1.57079],
  [0.75082, -1.4994, -2.35274, -2.43106, -0.81998, 1.57079],
  [0.78329, -1.48298, -2.3671, -2.43311, -0.78751, 1.57079],
  [0.79748, -1.45951, -2.38691, -2.43678, -0.77332, 1.57079],
  [0.78315, -1.44272, -2.40055, -2.43991, -0.78765, 1.57079],
  [0.74735, -1.44382, -2.39968, -2.4397, -0.82345, 1.57079],
  [0.71328, -1.46202, -2.38483, -2.43634, -0.85752, 1.57079],
  [0.70198, -1.48534, -2.36506, -2.43279, -0.86882, 1.57079],
];

const FLASK_TABLE_LOWER_POSE: StationPose = [0.58, -0.08, 0.8, 1, 0, 0, 0];
const FLASK_BURNER_LOWER_POSE: StationPose = [0.62, 0.14, 0.87, 1, 0, 0, 0];
const PADDLE_REST_POSE: StationPose = [
  0.505,
  -0.28,
  0.8086,
  0.7071067811865476,
  0,
  0.7071067811865476,
  0,
];
const FINGER_OPEN_M = 0.016;
const FINGER_OPEN_BOWL_M = 0.042;
const FINGER_CLOSED_BOWL_M = 0.0355;
const FINGER_CLOSED_PADDLE_M = 0.0;
const STEP_DT_S = 0.02;
const ATM_KPA = 101.325;

/** Antoine equation for water saturated vapor pressure in kPa (valid 1..100 °C). */
export function saturatedVaporPressureKPa(tempC: number): number {
  const clamped = Math.max(20, Math.min(102, tempC));
  const mmHg = Math.pow(10, 8.07131 - 1730.63 / (233.426 + clamped));
  return mmHg * 0.133322368;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(
    0,
    Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)),
  );
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolateJoints(a: JointVector, b: JointVector, alpha: number): Waypoint {
  const s = smoothstep(0, 1, alpha);
  return waypointFromJoints([
    lerp(a[0], b[0], s),
    lerp(a[1], b[1], s),
    lerp(a[2], b[2], s),
    lerp(a[3], b[3], s),
    lerp(a[4], b[4], s),
    lerp(a[5], b[5], s),
  ]);
}

function circularStirWaypoint(turns: number): Waypoint {
  const n = STIR_RING_JOINTS.length;
  const wrapped = ((turns % 1) + 1) % 1;
  const scaled = wrapped * n;
  const i0 = Math.floor(scaled) % n;
  const i1 = (i0 + 1) % n;
  const frac = scaled - Math.floor(scaled);
  const a = STIR_RING_JOINTS[i0]!;
  const b = STIR_RING_JOINTS[i1]!;
  return waypointFromJoints([
    lerp(a[0], b[0], frac),
    lerp(a[1], b[1], frac),
    lerp(a[2], b[2], frac),
    lerp(a[3], b[3], frac),
    lerp(a[4], b[4], frac),
    lerp(a[5], b[5], frac),
  ]);
}

/**
 * First-principles 20 ms thermo-siphon, Darcy filtration, coffee extraction,
 * and FR10 kinematics simulator for the Hario Syphon Technica TCA-3 station.
 */
export class SiphonSimulationEngine {
  private stepCount = 0;
  private radiativeW = 140;
  private lowerC = 89.5;
  private upperC = 28.0;
  private pressureKPa = ATM_KPA;
  private lowerG: number;
  private stemG = 0;
  private upperFreeG = 0;
  private absorbedG = 0;
  private evaporatedG = 0;
  private upperSealZ = 0.01;
  private sealed = false;
  private stirCount = 0;
  private swirlRadS = 0;
  private wettingFraction = 0;
  private solublesG = 0;
  private co2GasRemaining = 1.0;
  private co2FoamMm = 0;
  private crustBuoyancy = 1.0;
  private deviations: SiphonDeviation[] = [];
  private outcome: SiphonOutcome | null = null;
  private droppedPaddleZ: number | null = null;

  constructor(readonly config: SiphonRecipeConfig) {
    this.lowerG = config.waterG;
  }

  currentSample(): SiphonSample {
    return this.buildSample(0);
  }

  /** Advances the simulation by `count` 20 ms steps and returns all samples. */
  stepBatch(count: number): readonly SiphonSample[] {
    const samples: SiphonSample[] = [];
    for (let i = 0; i < count; i++) {
      if (this.outcome !== null) {
        samples.push(this.buildSample(0));
        break;
      }
      this.stepCount++;
      const sample = this.advanceOneStep();
      samples.push(sample);
      if (sample.outcome !== null) break;
    }
    return samples;
  }

  private advanceOneStep(): SiphonSample {
    const t = this.stepCount * STEP_DT_S;
    const steepEndS = 48 + this.config.steepSeconds;
    const whirlpoolEndS = steepEndS + 16;
    const maxRetentionG = this.config.coffeeG * 1.85;
    const minHeelG = 26;
    const maxSolublesG = this.config.coffeeG * 0.285;

    // 1. Halogen quartz filament thermal response (tau = 1.8 s).
    const electricalW = t < 48 ? 350 : t < steepEndS ? 110 : 0;
    const targetRadiativeW = electricalW * 0.86;
    this.radiativeW +=
      ((targetRadiativeW - this.radiativeW) / 1.8) * STEP_DT_S;

    let flowGS = 0;
    const pSatLower = saturatedVaporPressureKPa(this.lowerC);

    if (t < 10) {
      // Phase 1: BGS-400 heats lower bulb; FR10 presses upper bowl to seat silicone gasket.
      const heatCapacityJPerC = Math.max(140, this.lowerG * 4.184 + 180);
      const lossW = 0.42 * (this.lowerC - 24.0);
      this.lowerC = Math.min(
        96.4,
        this.lowerC + ((this.radiativeW - lossW) / heatCapacityJPerC) * STEP_DT_S,
      );

      if (t >= 6.8 && t <= 8.4 && this.config.check !== "unsealed-gasket") {
        const sealProgress = smoothstep(6.8, 8.2, t);
        this.upperSealZ = lerp(0.01, 0, sealProgress);
        if (this.upperSealZ < 0.001) this.sealed = true;
      } else if (t >= 6.8 && this.config.check === "unsealed-gasket") {
        this.upperSealZ = lerp(0.01, 0.006, smoothstep(6.8, 8.2, t));
        this.sealed = false;
      }

      // Dalton headspace pressure = trapped air partial pressure + Antoine vapor pressure.
      const pSatSeal = saturatedVaporPressureKPa(90.5);
      const excessVapor = Math.max(0, pSatLower - pSatSeal);
      this.pressureKPa = this.sealed
        ? ATM_KPA + excessVapor * 0.24
        : ATM_KPA + excessVapor * 0.04;
    } else if (t < 28) {
      // Phase 2: Vapor-driven upflow through the 140 mm glass stem into upper chamber.
      this.lowerC = Math.min(97.2, this.lowerC + 0.19 * STEP_DT_S);
      if (this.config.check === "unsealed-gasket") {
        this.pressureKPa = 101.85;
        if (
          t >= 18 &&
          !this.deviations.some((d) => d.kind === "unsealed-gasket")
        ) {
          this.deviations = [
            ...this.deviations,
            {
              kind: "unsealed-gasket",
              atStep: this.stepCount,
              detail:
                "Silicone neck gasket failed to seal at 101.9 kPa; steam escaped around the lower neck.",
            },
          ];
          this.outcome = {
            kind: "failed",
            reason: "unsealed-gasket-leak",
          };
        }
      } else {
        // Hydrostatic head of upper column (~1.8 kPa) + pipe friction (~1.4 kPa).
        const pSatSeal = saturatedVaporPressureKPa(90.5);
        this.pressureKPa = Math.min(
          104.8,
          ATM_KPA + 1.2 + Math.max(0, pSatLower - pSatSeal) * 0.21,
        );
        const targetStemG = t < 25 ? 4.2 : lerp(4.2, 0.15, (t - 25) / 3);
        const stemDelta = targetStemG - this.stemG;
        this.stemG += stemDelta;
        if (stemDelta >= 0) {
          this.lowerG = Math.max(minHeelG, this.lowerG - stemDelta);
        } else {
          this.upperFreeG += -stemDelta;
        }

        const availableToRise = Math.max(0, this.lowerG - minHeelG);
        const drivingOverpressure = Math.max(0, this.pressureKPa - 102.4);
        const desiredRate =
          (16.8 + drivingOverpressure * 5.2) * smoothstep(10, 12.4, t);
        const upflowStepG = Math.min(availableToRise, desiredRate * STEP_DT_S);
        this.lowerG -= upflowStepG;
        this.upperFreeG += upflowStepG;
        flowGS = upflowStepG / STEP_DT_S;

        // Rising hot water equilibrates with upper borosilicate bowl and starts surface washing of coffee bed.
        const riseFraction = Math.min(
          1,
          this.upperFreeG / Math.max(1, this.config.waterG - minHeelG),
        );
        this.upperC = lerp(78.0, 92.8, riseFraction);
        this.wettingFraction = Math.min(0.42, riseFraction * 0.42);
        this.co2FoamMm = riseFraction * 1.8;
      }
    } else if (t < 48) {
      // Phase 3: Fold-in stir with BA-15 bamboo paddle (3 circular revolutions).
      this.lowerC = 96.8;
      this.pressureKPa = 103.9;
      const evap = 0.008 * STEP_DT_S;
      this.evaporatedG += evap;
      this.upperFreeG = Math.max(0, this.upperFreeG - evap);

      if (t >= 35.5 && t <= 43.5) {
        const turns = ((t - 35.5) / 8.0) * 3;
        this.stirCount = Math.min(3, Math.floor(turns) + 1);
        this.swirlRadS = 4.6;
        // Shearing the dry crust into 92.5 °C water rapidly wets the grounds and triggers CO2 bloom foam.
        this.wettingFraction = Math.min(
          0.98,
          this.wettingFraction + 0.095 * STEP_DT_S,
        );
        this.co2FoamMm = Math.min(4.8, this.co2FoamMm + 0.42 * STEP_DT_S);
      } else {
        this.swirlRadS = Math.max(0, this.swirlRadS - 2.1 * STEP_DT_S);
      }

      // Water absorption into cellular coffee matrix proportional to wetting fraction.
      const targetAbsorbed = maxRetentionG * this.wettingFraction;
      const absorbStep = Math.min(
        this.upperFreeG,
        Math.max(0, targetAbsorbed - this.absorbedG),
        4.2 * STEP_DT_S,
      );
      this.upperFreeG -= absorbStep;
      this.absorbedG += absorbStep;
      this.upperC = 92.4;
    } else if (t < steepEndS) {
      // Phase 4: Immersion steep on BGS-400 110 W hold mode; grounds form a buoyant 3-layer crust.
      this.lowerC = 96.4;
      this.pressureKPa = 103.6 + 0.15 * Math.sin(t * 2.4);
      const evap = 0.007 * STEP_DT_S;
      this.evaporatedG += evap;
      this.upperFreeG = Math.max(0, this.upperFreeG - evap);
      this.wettingFraction = Math.min(1.0, this.wettingFraction + 0.01 * STEP_DT_S);

      const absorbStep = Math.min(
        this.upperFreeG,
        Math.max(0, maxRetentionG - this.absorbedG),
        0.9 * STEP_DT_S,
      );
      this.upperFreeG -= absorbStep;
      this.absorbedG += absorbStep;
      this.upperC = Math.max(91.0, this.upperC - 0.018 * STEP_DT_S);
      this.swirlRadS = Math.max(0.15, this.swirlRadS - 0.7 * STEP_DT_S);

      // Slow CO2 degassing during steep gradually reduces foam and buoyancy.
      this.co2GasRemaining = Math.max(
        0.25,
        this.co2GasRemaining - 0.008 * STEP_DT_S,
      );
      this.co2FoamMm = Math.max(2.4, this.co2FoamMm - 0.022 * STEP_DT_S);
      this.crustBuoyancy = 0.72 + 0.25 * this.co2GasRemaining;
    } else if (t < whirlpoolEndS) {
      // Phase 5: Heater off (0 W) + 3 whirlpool stirs to degas crust and center the dome.
      const elapsed = t - steepEndS;
      const heatLossC = (0.28 + (1 - this.radiativeW / 110) * 0.12) * STEP_DT_S;
      this.lowerC = Math.max(91.8, this.lowerC - heatLossC);
      this.pressureKPa = lerp(103.4, 100.4, elapsed / 16);
      this.upperC = Math.max(89.6, this.upperC - 0.035 * STEP_DT_S);

      if (elapsed >= 1.8 && elapsed <= 9.4) {
        const turns = ((elapsed - 1.8) / 7.6) * 3;
        this.stirCount = 3 + Math.min(3, Math.floor(turns) + 1);
        this.swirlRadS = 5.6;
        // Whirlpool agitation knocks out trapped CO2 bubbles so grounds begin settling toward the filter center.
        this.crustBuoyancy = Math.max(
          0.22,
          this.crustBuoyancy - 0.075 * STEP_DT_S,
        );
        this.co2FoamMm = Math.max(1.4, this.co2FoamMm - 0.12 * STEP_DT_S);

        if (this.config.check === "lost-grip" && elapsed >= 5.2) {
          this.droppedPaddleZ = 0.83;
          this.deviations = [
            ...this.deviations,
            {
              kind: "lost-paddle-grip",
              atStep: this.stepCount,
              detail:
                "Gripper lost the BA-15 bamboo paddle collar during whirlpool stir 2.",
            },
          ];
          this.outcome = {
            kind: "failed",
            reason: "lost-paddle-grip",
          };
        }
      } else {
        this.swirlRadS = Math.max(0.9, this.swirlRadS - 0.85 * STEP_DT_S);
      }
    } else {
      // Phase 6: Vacuum drawdown governed by Antoine steam condensation + Darcy filtration through F-103S cloth & coffee bed.
      const drawElapsed = t - whirlpoolEndS;
      this.lowerC = Math.max(83.2, this.lowerC - 0.25 * STEP_DT_S);
      this.upperC = Math.max(86.4, this.upperC - 0.055 * STEP_DT_S);
      this.swirlRadS = Math.max(0, this.swirlRadS - 0.42 * STEP_DT_S);
      this.crustBuoyancy = Math.max(0, this.crustBuoyancy - 0.04 * STEP_DT_S);
      this.co2FoamMm = Math.max(0.4, this.co2FoamMm - 0.05 * STEP_DT_S);

      const clogged = this.config.check === "clogged-filter";
      if (
        clogged &&
        drawElapsed >= 14 &&
        !this.deviations.some((d) => d.kind === "slow-drawdown")
      ) {
        this.deviations = [
          ...this.deviations,
          {
            kind: "slow-drawdown",
            atStep: this.stepCount,
            detail:
              "Fine grounds partially blinded the F-103S cloth filter; Darcy permeability dropped by 38%.",
          },
        ];
      }

      if (this.upperFreeG > 0.05 || this.stemG > 0.05) {
        // Condensing vapor in the cooling lower bulb pulls a partial vacuum (94.6..96.4 kPa).
        const vacuumBuild = Math.min(1, drawElapsed / 6.0);
        const targetVacKPa = clogged ? 6.6 : 5.2;
        this.pressureKPa = ATM_KPA - targetVacKPa * vacuumBuild;

        // Darcy's Law: flow rate = Area * DeltaP / (mu * (R_cloth + R_bed(compaction))).
        const initialUpper = Math.max(1, this.config.waterG - minHeelG);
        const settledFraction =
          1 - this.upperFreeG / initialUpper;
        const bedResistance = 0.35 + 0.65 * settledFraction;
        const filterConductance = clogged ? 1.15 : 2.15;
        const darcyFlowGS =
          (targetVacKPa * vacuumBuild * filterConductance) / bedResistance;

        const fromUpper = Math.min(this.upperFreeG, darcyFlowGS * STEP_DT_S);
        this.upperFreeG -= fromUpper;
        this.stemG += fromUpper;
        const targetStemHoldG =
          this.upperFreeG > 4.0
            ? Math.min(3.6, 0.8 + darcyFlowGS * 0.22)
            : (this.upperFreeG / 4.0) * 1.4;
        const toLower = Math.max(
          0,
          this.stemG - targetStemHoldG,
          this.upperFreeG <= 0.1 ? Math.min(this.stemG, 5.5 * STEP_DT_S) : 0,
        );
        const actualToLower = Math.min(this.stemG, toLower);
        this.stemG -= actualToLower;
        this.lowerG += actualToLower;
        flowGS = -actualToLower / STEP_DT_S;
      } else {
        // Final vacuum equalizer bubble kick once air breaks through the domed bed.
        const drainTotal = this.upperFreeG + this.stemG;
        this.lowerG += drainTotal;
        this.upperFreeG = 0;
        this.stemG = 0;
        this.pressureKPa = lerp(this.pressureKPa, ATM_KPA, 0.18);
        if (drawElapsed >= (clogged ? 52 : 36)) {
          const finalTdsPct =
            (this.solublesG / Math.max(1, this.lowerG + this.solublesG)) * 100;
          const finalEyPct =
            (this.solublesG / Math.max(1, this.config.coffeeG)) * 100;
          this.outcome = {
            kind: "completed",
            beverageMg: Math.round(this.lowerG * 1000),
            spentBedMg: Math.round(
              (this.config.coffeeG + this.absorbedG) * 1000,
            ),
            retainedLowerMg: Math.round(minHeelG * 1000),
            evaporatedMg: Math.round(this.evaporatedG * 1000),
            tdsPct: Number(finalTdsPct.toFixed(2)),
            extractionYieldPct: Number(finalEyPct.toFixed(1)),
          };
        }
      }
    }

    // 2. Two-stage Noyes-Whitney Coffee Extraction Kinetics (fast surface wash + slower intra-particle diffusion).
    if (this.wettingFraction > 0.01 && (this.upperFreeG > 2 || this.absorbedG > 2)) {
      const tempFactor = Math.exp(-2400 * (1 / (this.upperC + 273.15) - 1 / 365.15));
      const agitationFactor = 1 + 0.32 * this.swirlRadS;
      const surfaceWashBoost = this.solublesG < maxSolublesG * 0.24 ? 2.4 : 0.86;
      const kExt =
        0.0098 *
        surfaceWashBoost *
        tempFactor *
        agitationFactor *
        this.wettingFraction;
      const dSol = kExt * Math.max(0, maxSolublesG - this.solublesG) * STEP_DT_S;
      this.solublesG = Math.min(maxSolublesG, this.solublesG + dSol);
    }

    return this.buildSample(flowGS);
  }

  private buildSample(flowGS: number): SiphonSample {
    const t = this.stepCount * STEP_DT_S;
    const steepEndS = 48 + this.config.steepSeconds;
    const whirlpoolEndS = steepEndS + 16;

    const {
      waypoint,
      fingers,
      lowerBowlPose,
      upperBowlPose,
      paddlePose,
      phase,
      stage,
    } = this.computeKinematics(t, steepEndS, whirlpoolEndS);

    const heaterMode: SiphonSample["heater"]["mode"] =
      t < 48 ? "high-350w" : t < steepEndS ? "hold-110w" : "off";
    const powerW =
      heaterMode === "high-350w" ? 350 : heaterMode === "hold-110w" ? 110 : 0;
    const glow = Math.max(0, Math.min(1, this.radiativeW / 300));

    const vacuumKPa = Math.max(0, ATM_KPA - this.pressureKPa);
    const bubbleRate =
      phase === "upflow"
        ? 0.95
        : phase === "fold-in" || phase === "steep"
          ? 0.48
          : phase === "drawdown" &&
              this.upperFreeG <= 1.2 &&
              t < whirlpoolEndS + 40
            ? 0.82
            : 0;

    const totalInitialWater = Math.max(1, this.config.waterG - 26);
    const drawdownFraction =
      phase === "drawdown" || phase === "completed"
        ? Math.max(0, Math.min(1, 1 - this.upperFreeG / totalInitialWater))
        : 0;
    const domeHeightM = 0.008 + drawdownFraction * 0.019;

    const activeLiquidG = Math.max(
      40,
      this.upperFreeG + this.absorbedG + (phase === "drawdown" || phase === "completed" ? this.lowerG : 0),
    );
    const tdsPct = (this.solublesG / (activeLiquidG + this.solublesG)) * 100;
    const extractionYieldPct =
      (this.solublesG / Math.max(1, this.config.coffeeG)) * 100;

    return {
      step: this.stepCount,
      timeS: t,
      joints: waypoint.joints,
      fingers,
      gripper: waypoint.gripper,
      lowerBowl: lowerBowlPose,
      upperBowl: upperBowlPose,
      paddle: paddlePose,
      heater: {
        mode: heaterMode,
        powerW,
        radiativeW: this.radiativeW,
        glow,
      },
      thermo: {
        lowerC: this.lowerC,
        upperC: this.upperC,
        pressureKPa: this.pressureKPa,
        vaporPressureKPa: saturatedVaporPressureKPa(this.lowerC),
        vacuumKPa,
        bubbleRate,
        swirlRadS: this.swirlRadS,
      },
      extraction: {
        coffeeDoseG: this.config.coffeeG,
        wettingFraction: this.wettingFraction,
        tdsPct,
        extractionYieldPct,
        solublesMg: Math.round(this.solublesG * 1000),
        co2FoamMm: this.co2FoamMm,
        crustBuoyancy: this.crustBuoyancy,
      },
      water: {
        initialG: this.config.waterG,
        lowerG: this.lowerG,
        stemG: this.stemG,
        upperFreeG: this.upperFreeG,
        absorbedG: this.absorbedG,
        beverageG:
          phase === "drawdown" || phase === "completed" ? this.lowerG : 0,
        evaporatedG: this.evaporatedG,
        flowGS,
        domeHeightM,
      },
      control: {
        phase:
          this.outcome?.kind === "failed"
            ? "failed"
            : this.outcome?.kind === "completed"
              ? "completed"
              : phase,
        stage,
        brewS: t,
        steepRemainingS:
          phase === "steep" ? Math.max(0, Math.ceil(steepEndS - t)) : null,
        stirCount: this.stirCount,
        sealed: this.sealed,
        deviations: this.deviations,
      },
      outcome: this.outcome,
    };
  }

  private computeKinematics(
    t: number,
    steepEndS: number,
    whirlpoolEndS: number,
  ): Readonly<{
    waypoint: Waypoint;
    fingers: readonly [number, number];
    lowerBowlPose: StationPose;
    upperBowlPose: StationPose;
    paddlePose: StationPose;
    phase: SiphonPhase;
    stage: string;
  }> {
    const ready = JOINT_TARGETS.ready!;
    const flaskApproach = JOINT_TARGETS.flask_approach!;
    const flaskGrasp = JOINT_TARGETS.flask_grasp!;
    const flaskLift = JOINT_TARGETS.flask_lift!;
    const flaskCarry = JOINT_TARGETS.flask_carry!;
    const flaskPlace = JOINT_TARGETS.flask_place!;
    const sealPress = JOINT_TARGETS.seal_press!;
    const sealRetract = JOINT_TARGETS.seal_retract!;
    const paddleHover = JOINT_TARGETS.paddle_hover!;
    const paddleGrasp = JOINT_TARGETS.paddle_grasp!;
    const paddleLiftTopdown = JOINT_TARGETS.paddle_lift_topdown!;
    const paddleTilt = JOINT_TARGETS.paddle_tilt!;
    const stirHover = JOINT_TARGETS.stir_hover!;
    const stirStart = STIR_RING_JOINTS[0]!;

    let waypoint = waypointFromJoints(ready);
    let fingerOpen = FINGER_OPEN_M;
    let holdingFlask = false;
    let flaskOnBurner = t >= 6.8;
    let holdingPaddle = false;
    let phase: SiphonPhase = "preheat-seal";
    let stage = "Heating ECA-3-B electric heater (350 W max)";

    if (t < 10) {
      phase = "preheat-seal";
      if (t < 1.2) {
        waypoint = interpolateJoints(ready, flaskApproach, t / 1.2);
        fingerOpen = lerp(FINGER_OPEN_M, FINGER_OPEN_BOWL_M, t / 1.2);
        stage = "Approaching siphon flask on workbench";
      } else if (t < 2.4) {
        waypoint = interpolateJoints(
          flaskApproach,
          flaskGrasp,
          (t - 1.2) / 1.2,
        );
        fingerOpen = lerp(
          FINGER_OPEN_BOWL_M,
          FINGER_CLOSED_BOWL_M,
          smoothstep(1.8, 2.4, t),
        );
        stage = "Grasping siphon flask on workbench";
      } else if (t < 3.8) {
        waypoint = interpolateJoints(flaskGrasp, flaskLift, (t - 2.4) / 1.4);
        fingerOpen = FINGER_CLOSED_BOWL_M;
        holdingFlask = true;
        stage = "Lifting siphon flask off workbench";
      } else if (t < 5.4) {
        waypoint = interpolateJoints(flaskLift, flaskCarry, (t - 3.8) / 1.6);
        fingerOpen = FINGER_CLOSED_BOWL_M;
        holdingFlask = true;
        stage = "Carrying siphon flask over ECA-3-B heater";
      } else if (t < 6.8) {
        waypoint = interpolateJoints(flaskCarry, flaskPlace, (t - 5.4) / 1.4);
        fingerOpen = FINGER_CLOSED_BOWL_M;
        holdingFlask = true;
        stage = "Placing siphon flask on top of ECA-3-B heater";
      } else if (t < 8.2) {
        waypoint = interpolateJoints(flaskPlace, sealPress, (t - 6.8) / 1.4);
        fingerOpen = FINGER_CLOSED_BOWL_M;
        flaskOnBurner = true;
        stage = "Pressing upper bowl down to seat silicone gasket";
      } else if (t < 9.1) {
        waypoint = interpolateJoints(sealPress, sealRetract, (t - 8.2) / 0.9);
        fingerOpen = lerp(
          FINGER_CLOSED_BOWL_M,
          FINGER_OPEN_BOWL_M,
          smoothstep(8.2, 8.5, t),
        );
        flaskOnBurner = true;
        stage = "Releasing flask on burner and retracting jaws";
      } else {
        waypoint = interpolateJoints(sealRetract, ready, (t - 9.1) / 0.9);
        fingerOpen = lerp(FINGER_OPEN_BOWL_M, FINGER_OPEN_M, (t - 9.1) / 0.9);
        flaskOnBurner = true;
        stage = "Flask seated on burner · returning arm to ready";
      }
    } else if (t < 28) {
      phase = "upflow";
      waypoint = waypointFromJoints(ready);
      stage = "Vapor pressure driving hot water up glass downstem";
    } else if (t < 48) {
      phase = "fold-in";
      if (t < 30.0) {
        waypoint = interpolateJoints(ready, paddleHover, (t - 28) / 2.0);
        stage = "Approaching BA-15 stirring rod on table";
      } else if (t < 31.8) {
        waypoint = interpolateJoints(
          paddleHover,
          paddleGrasp,
          (t - 30.0) / 1.8,
        );
        fingerOpen = lerp(
          FINGER_OPEN_M,
          FINGER_CLOSED_PADDLE_M,
          smoothstep(31.0, 31.8, t),
        );
        stage = "Grasping BA-15 stirring rod from table";
      } else if (t < 33.0) {
        waypoint = interpolateJoints(
          paddleGrasp,
          paddleLiftTopdown,
          (t - 31.8) / 1.2,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Lifting BA-15 stirring rod off table";
      } else if (t < 34.2) {
        waypoint = interpolateJoints(
          paddleLiftTopdown,
          paddleTilt,
          (t - 33.0) / 1.2,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Rotating stirring rod vertical over bench";
      } else if (t < 35.1) {
        waypoint = interpolateJoints(
          paddleTilt,
          stirHover,
          (t - 34.2) / 0.9,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Positioning bamboo blade above upper bowl";
      } else if (t < 35.5) {
        waypoint = interpolateJoints(
          stirHover,
          stirStart,
          (t - 35.1) / 0.4,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Submerging bamboo blade into upper bowl";
      } else if (t <= 43.5) {
        const turns = ((t - 35.5) / 8.0) * 3;
        waypoint = circularStirWaypoint(turns);
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = `Fold-in circular stir ${Math.min(3, Math.floor(turns) + 1)} of 3`;
      } else if (t < 45.5) {
        waypoint = interpolateJoints(
          stirStart,
          stirHover,
          (t - 43.5) / 2.0,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Lifting paddle blade clear of upper bowl";
      } else {
        waypoint = interpolateJoints(
          stirHover,
          paddleTilt,
          (t - 45.5) / 2.5,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Retracting bamboo paddle clear of steam plume";
      }
    } else if (t < steepEndS) {
      phase = "steep";
      waypoint = waypointFromJoints(paddleTilt);
      fingerOpen = FINGER_CLOSED_PADDLE_M;
      holdingPaddle = true;
      stage = "Steeping 3-layer coffee crust on ECA-3-B mid hold (110 W)";
    } else if (t < whirlpoolEndS) {
      phase = "whirlpool";
      const elapsed = t - steepEndS;
      if (elapsed < 1.0) {
        waypoint = interpolateJoints(paddleTilt, stirHover, elapsed / 1.0);
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Heater off · bringing paddle in for whirlpool stir";
      } else if (elapsed < 1.8) {
        waypoint = interpolateJoints(
          stirHover,
          stirStart,
          (elapsed - 1.0) / 0.8,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Heater off · dipping paddle into upper bowl";
      } else if (elapsed <= 9.4) {
        const turns = ((elapsed - 1.8) / 7.6) * 3;
        waypoint = circularStirWaypoint(turns);
        fingerOpen =
          this.droppedPaddleZ !== null ? FINGER_OPEN_M : FINGER_CLOSED_PADDLE_M;
        holdingPaddle = this.droppedPaddleZ === null;
        stage = `Whirlpool stir ${Math.min(3, Math.floor(turns) + 1)} of 3`;
      } else if (elapsed < 11.0) {
        waypoint = interpolateJoints(
          stirStart,
          stirHover,
          (elapsed - 9.4) / 1.6,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Lifting bamboo paddle out of vortex";
      } else if (elapsed < 12.2) {
        waypoint = interpolateJoints(
          stirHover,
          paddleTilt,
          (elapsed - 11.0) / 1.2,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Tilting stirring rod toward workbench";
      } else if (elapsed < 13.4) {
        waypoint = interpolateJoints(
          paddleTilt,
          paddleLiftTopdown,
          (elapsed - 12.2) / 1.2,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Lowering stirring rod over workbench";
      } else if (elapsed < 14.6) {
        waypoint = interpolateJoints(
          paddleLiftTopdown,
          paddleGrasp,
          (elapsed - 13.4) / 1.2,
        );
        fingerOpen = FINGER_CLOSED_PADDLE_M;
        holdingPaddle = true;
        stage = "Placing stirring rod onto workbench";
      } else {
        waypoint = interpolateJoints(
          paddleGrasp,
          ready,
          (elapsed - 14.6) / 1.4,
        );
        fingerOpen = FINGER_OPEN_M;
        holdingPaddle = false;
        stage = "Releasing stirring rod on table and returning to ready";
      }
    } else {
      phase = "drawdown";
      waypoint = waypointFromJoints(ready);
      fingerOpen = FINGER_OPEN_M;
      holdingPaddle = false;
      stage =
        this.upperFreeG > 1.0
          ? "Darcy vacuum drawdown through F-103S cloth filter"
          : "Final vacuum equalizer bubble kick and domed bed settling";
    }

    let lowerBowlPose: StationPose = flaskOnBurner
      ? FLASK_BURNER_LOWER_POSE
      : FLASK_TABLE_LOWER_POSE;
    let upperBowlPose: StationPose = [
      lowerBowlPose[0],
      lowerBowlPose[1],
      lowerBowlPose[2] + 0.088 + this.upperSealZ,
      1,
      0,
      0,
      0,
    ];
    if (holdingFlask) {
      lowerBowlPose = [
        waypoint.tool[0],
        waypoint.tool[1],
        waypoint.tool[2] - 0.17,
        1,
        0,
        0,
        0,
      ];
      upperBowlPose = [
        waypoint.tool[0],
        waypoint.tool[1],
        waypoint.tool[2] - 0.072,
        1,
        0,
        0,
        0,
      ];
    }

    let paddlePose: StationPose = PADDLE_REST_POSE;
    if (this.droppedPaddleZ !== null) {
      paddlePose = [0.62, 0.14, this.droppedPaddleZ, 1, 0, 0, 0];
    } else if (holdingPaddle) {
      const gQuat: Quat = [
        waypoint.gripper[3],
        waypoint.gripper[4],
        waypoint.gripper[5],
        waypoint.gripper[6],
      ];
      const offset = quatRotate(gQuat, [0.13, 0, -0.075]);
      paddlePose = [
        waypoint.gripper[0] + offset[0],
        waypoint.gripper[1] + offset[1],
        waypoint.gripper[2] + offset[2],
        gQuat[0],
        gQuat[1],
        gQuat[2],
        gQuat[3],
      ];
    }

    return {
      waypoint,
      fingers: [fingerOpen, fingerOpen],
      lowerBowlPose,
      upperBowlPose,
      paddlePose,
      phase,
      stage,
    };
  }
}
