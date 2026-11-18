export type FinancierHobModel =
  | "maruzen"
  | "vollrath"
  | "panasonic-kz-ck1402"
  | "rinnai-rsb-150pj";
export type FinancierMixerTool = "beater" | "whip";
export type FinancierBatterCheck =
  | "none"
  | "burnt-butter"
  | "guard-interlock";

export type FinancierBatterRecipeConfig = Readonly<{
  hob: FinancierHobModel;
  tool: FinancierMixerTool;
  butterG: number;
  dryMixG: number;
  eggWhitesG: number;
  targetButterC: number;
  check: FinancierBatterCheck;
}>;

export const DEFAULT_FINANCIER_BATTER_RECIPE: FinancierBatterRecipeConfig = {
  hob: "maruzen",
  tool: "beater",
  butterG: 180,
  dryMixG: 395,
  eggWhitesG: 181,
  targetButterC: 152,
  check: "none",
};

export type FinancierBatterPhase =
  | "brown-butter"
  | "charge-dry-whites"
  | "mix-paste"
  | "temper-butter"
  | "homogenize"
  | "completed"
  | "failed";

export type FinancierBatterOutcome =
  | Readonly<{
      kind: "completed";
      rawButterG: number;
      brownedButterG: number;
      evaporatedWaterG: number;
      panResidueG: number;
      dryMixG: number;
      eggWhitesG: number;
      totalBatterG: number;
      peakButterTempC: number;
      finalBatterTempC: number;
      emulsificationPct: number;
      mouldCavitiesYield: number;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
    }>;

export type FinancierBatterSample = Readonly<{
  step: number;
  timeS: number;
  hob: FinancierHobModel;
  tool: FinancierMixerTool;
  phase: FinancierBatterPhase;
  stage: string;
  scale: Readonly<{
    displayedG: number;
    panDeflectionM: number;
    tared: boolean;
    dryVesselOnScale: boolean;
  }>;
  induction: Readonly<{
    powerKw: number;
    coilActive: boolean;
    panPosZUp: readonly [number, number, number];
    panTiltRad: number;
    butterMassG: number;
    butterTempC: number;
    evaporatedG: number;
    browningProgress: number;
    foamIntensity: number;
    pouringRateGS: number;
  }>;
  mixer: Readonly<{
    speedSetting: 0 | 1 | 2;
    rpm: number;
    orbitAngleRad: number;
    spinAngleRad: number;
    bowlLiftM: number;
    guardAngleRad: number;
    bowlMassG: number;
    dryChargedG: number;
    whitesChargedG: number;
    butterChargedG: number;
    batterTempC: number;
    emulsification: number;
  }>;
  dryVessel: Readonly<{
    posZUp: readonly [number, number, number];
    tiltRad: number;
    massG: number;
    pouringRateGS: number;
  }>;
  whitesVessel: Readonly<{
    posZUp: readonly [number, number, number];
    tiltRad: number;
    massG: number;
    pouringRateGS: number;
  }>;
  cobot: Readonly<{
    toolZUp: readonly [number, number, number];
    wristPitchRad: number;
    fingerOpeningM: number;
    holding: "dry-vessel" | "whites-vessel" | "pan" | "none";
  }>;
  outcome: FinancierBatterOutcome | null;
}>;

export type FinancierBatterTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

export function financierBatterTimelineStages(): readonly FinancierBatterTimelineStage[] {
  return [
    {
      id: "brown-butter",
      label: "1 · Scale tare & 152 °C beurre noisette",
      startS: 0,
      endS: 14,
    },
    {
      id: "charge-dry-whites",
      label: "2 · Charge 395 g almond-sugar & 181 g whites",
      startS: 14,
      endS: 28,
    },
    {
      id: "mix-paste",
      label: "3 · Guard lock, bowl lift & Speed 2 paste mix",
      startS: 28,
      endS: 40,
    },
    {
      id: "temper-butter",
      label: "4 · Stream 150 g warm beurre noisette",
      startS: 40,
      endS: 51,
    },
    {
      id: "homogenize",
      label: "5 · Speed 1 ribbon fold & batter release",
      startS: 51,
      endS: 60,
    },
  ];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(u: number): number {
  const c = clamp(u, 0, 1);
  return c * c * (3 - 2 * c);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): readonly [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Deterministic thermodynamic, mass-balance, and kinematic simulation engine
 * for the FAIRINO FR10 Financier Batter prep workcell (Ohaus Ranger 3000 weighing,
 * Maruzen MIH-02C / Vollrath 59500P beurre noisette Maillard browning, and
 * Hobart HL200 20 qt planetary mixing).
 */
export class FinancierBatterSimulationEngine {
  private stepCount = 0;
  private readonly dt = 0.04;
  private orbitAngleRad = 0;
  private spinAngleRad = 0;
  private peakButterTempC = 64.0;

  constructor(private readonly recipe: FinancierBatterRecipeConfig) {}

  initialSample(): FinancierBatterSample {
    return this.computeSample(0);
  }

  stepBatch(steps: number): readonly FinancierBatterSample[] {
    const out: FinancierBatterSample[] = [];
    for (let i = 0; i < steps; i++) {
      this.stepCount += 1;
      const sample = this.computeSample(this.stepCount * this.dt);
      out.push(sample);
      if (sample.outcome !== null) break;
    }
    return out;
  }

  private computeSample(t: number): FinancierBatterSample {
    // Workcell Z-up station coordinates on the 0.902 m stainless prep table (Z = 0 is table top)
    const scalePanZUp: readonly [number, number, number] = [-0.42, -0.16, 0.125];
    const scaleTareBtnZUp: readonly [number, number, number] = [
      -0.33, -0.31, 0.075,
    ];
    const whitesRestZUp: readonly [number, number, number] = [
      -0.42, -0.41, 0.055,
    ];
    const hobPanZUp: readonly [number, number, number] = [-0.02, -0.18, 0.106];
    // Bowl rim pour target above Hobart HL200 bowl (centered at X = +0.38, Y = -0.22)
    const bowlPourZUp: readonly [number, number, number] = [0.22, -0.25, 0.45];
    const guardHandleZUp: readonly [number, number, number] = [
      0.26, -0.32, 0.45,
    ];
    const liftLeverZUp: readonly [number, number, number] = [0.51, -0.05, 0.49];
    const homeParkZUp: readonly [number, number, number] = [
      -0.22, 0.08, 0.38,
    ];

    const rawButterG = this.recipe.butterG;
    const targetEvapG = Number((rawButterG * (22 / 180)).toFixed(1));
    const residueG = 8.0;
    const netBrownedButterG = Math.max(
      100,
      Number((rawButterG - targetEvapG - residueG).toFixed(1)),
    );
    const dryMixG = this.recipe.dryMixG;
    const eggWhitesG = this.recipe.eggWhitesG;

    let phase: FinancierBatterPhase = "brown-butter";
    let stage =
      "Prepared patisserie bench · Ohaus scale, Maruzen induction pan & Hobart HL200";
    let tared = false;
    let dryVesselOnScale = true;
    let displayedG = dryMixG;
    let panDeflectionM = 0.0014;

    let powerKw = 0;
    let coilActive = false;
    let panPosZUp = hobPanZUp;
    let panTiltRad = 0;
    let butterMassG = rawButterG;
    let butterTempC = 64.0;
    let evaporatedG = 0;
    let browningProgress = 0;
    let foamIntensity = 0;
    let butterPourRateGS = 0;

    let speedSetting: 0 | 1 | 2 = 0;
    let rpm = 0;
    let bowlLiftM = -0.02; // lowered for ingredient charging
    let guardAngleRad = -1.95; // open (-112 deg) for charging
    let dryChargedG = 0;
    let whitesChargedG = 0;
    let butterChargedG = 0;
    let batterTempC = 22.0;
    let emulsification = 0;

    let dryPosZUp = scalePanZUp;
    let dryTiltRad = 0;
    let dryRemainingG = dryMixG;
    let dryPourRateGS = 0;

    let whitesPosZUp = whitesRestZUp;
    let whitesTiltRad = 0;
    let whitesRemainingG = eggWhitesG;
    let whitesPourRateGS = 0;

    let toolZUp = homeParkZUp;
    let wristPitchRad = Math.PI * 0.45;
    let fingerOpeningM = 0.032;
    let holding: "dry-vessel" | "whites-vessel" | "pan" | "none" = "none";
    let outcome: FinancierBatterOutcome | null = null;

    if (t <= 0.0001) {
      this.orbitAngleRad = 0;
      this.spinAngleRad = 0;
      this.peakButterTempC = 64.0;
    } else if (t < 14.0) {
      // STAGE 1: Tare Ohaus scale, verify 395 g tant-pour-tant dry blend & brown butter to 152 °C (0..14 s)
      phase = "brown-butter";
      const u = clamp(t / 14.0, 0, 1);
      coilActive = true;
      powerKw =
        this.recipe.hob === "maruzen"
          ? 2.0
          : this.recipe.hob === "vollrath"
            ? 1.8
            : this.recipe.hob === "rinnai-rsb-150pj"
              ? 5.23
              : 1.4;

      const peakTargetC =
        this.recipe.check === "burnt-butter"
          ? 181.0
          : this.recipe.targetButterC;
      // Realistic two-slope heating curve: water boiling plateau around 108..120 °C, then Maillard climb to 152 °C
      if (u < 0.45) {
        const sub = u / 0.45;
        butterTempC = lerp(64.0, 114.0, sub);
        evaporatedG = lerp(0, targetEvapG * 0.72, sub);
        foamIntensity = Math.sin(sub * Math.PI) * 0.95;
        browningProgress = sub * 0.18;
      } else {
        const sub = (u - 0.45) / 0.55;
        butterTempC = lerp(114.0, peakTargetC, smoothstep(sub));
        evaporatedG = lerp(targetEvapG * 0.72, targetEvapG, sub);
        foamIntensity = lerp(0.85, 0.35, sub);
        browningProgress = clamp(0.18 + sub * 0.82, 0, 1);
      }
      butterMassG = rawButterG - evaporatedG;
      this.peakButterTempC = Math.max(this.peakButterTempC, butterTempC);

      // Cobot tares scale and grasps dry vessel handle
      if (t < 3.2) {
        const moveU = smoothstep(t / 3.2);
        toolZUp = lerpVec3(homeParkZUp, scaleTareBtnZUp, moveU);
        tared = t > 2.2;
        stage = `FR10 verifying 395 g almond-sugar tare on Ohaus scale · butter foaming (${butterTempC.toFixed(0)} °C)`;
      } else if (t < 7.0) {
        tared = true;
        const moveU = smoothstep((t - 3.2) / 3.8);
        toolZUp = lerpVec3(scaleTareBtnZUp, scalePanZUp, moveU);
        fingerOpeningM = lerp(0.032, 0.024, moveU);
        stage = `Water evaporating from butter (${evaporatedG.toFixed(1)} g steam) · milk solids toasting (${butterTempC.toFixed(0)} °C)`;
      } else {
        tared = true;
        toolZUp = scalePanZUp;
        fingerOpeningM = 0.022;
        holding = "dry-vessel";
        if (this.recipe.check === "burnt-butter" && t >= 13.2) {
          phase = "failed";
          coilActive = false;
          powerKw = 0;
          const reason = `Beurre noisette overheated to ${butterTempC.toFixed(1)} °C (> 170 °C limit; milk solids blackened and bitter).`;
          stage = reason;
          outcome = { kind: "failed", reason };
        } else {
          stage = `Hazelnut Maillard peak reached (${butterTempC.toFixed(1)} °C · ${ (rawButterG - evaporatedG).toFixed(0)} g amber beurre noisette)`;
        }
      }
    } else if (t < 28.0) {
      // STAGE 2: Charge 395 g almond-sugar dry blend & 181 g egg whites into Hobart HL200 bowl (14..28 s)
      phase = "charge-dry-whites";
      tared = true;
      evaporatedG = targetEvapG;
      butterMassG = rawButterG - targetEvapG;
      browningProgress = 1.0;
      foamIntensity = 0.15;
      butterTempC = lerp(this.recipe.targetButterC, 143.0, (t - 14.0) / 14.0);

      const subT = t - 14.0;
      if (subT < 7.0) {
        // 14..21 s: Lift dry vessel off Ohaus scale, pour 395 g into Hobart bowl, return vessel
        dryVesselOnScale = false;
        displayedG = 0;
        panDeflectionM = 0;
        holding = "dry-vessel";
        fingerOpeningM = 0.022;
        if (subT < 2.0) {
          const u = smoothstep(subT / 2.0);
          const arcZ = Math.sin(u * Math.PI) * 0.08;
          const base = lerpVec3(scalePanZUp, bowlPourZUp, u);
          dryPosZUp = [base[0], base[1], base[2] + arcZ];
          dryTiltRad = lerp(0, 0.45, u);
          stage =
            "FR10 lifting 395 g sifted almond flour & icing sugar to Hobart HL200 bowl";
        } else if (subT < 5.2) {
          const pourU = clamp((subT - 2.0) / 3.2, 0, 1);
          dryPosZUp = bowlPourZUp;
          dryTiltRad = lerp(0.55, 1.18, smoothstep(pourU));
          dryPourRateGS = 123.0;
          dryChargedG = dryMixG * pourU;
          dryRemainingG = dryMixG * (1 - pourU);
          stage = `Charging tant-pour-tant almond-sugar blend into 20 qt bowl (${dryChargedG.toFixed(0)} g / ${dryMixG} g)`;
        } else {
          const retU = smoothstep((subT - 5.2) / 1.8);
          dryPosZUp = lerpVec3(bowlPourZUp, scalePanZUp, retU);
          dryTiltRad = lerp(1.18, 0, retU);
          dryChargedG = dryMixG;
          dryRemainingG = 0;
          dryVesselOnScale = retU > 0.9;
          holding = retU < 0.85 ? "dry-vessel" : "none";
          stage = "Dry blend charged (395 g) · returning stainless vessel to scale";
        }
        toolZUp = [dryPosZUp[0] - 0.03, dryPosZUp[1] - 0.02, dryPosZUp[2] + 0.02];
      } else {
        // 21..28 s: Grasp 181 g egg-whites vessel, pour into Hobart bowl, return vessel
        dryVesselOnScale = true;
        displayedG = 0;
        panDeflectionM = 0.0003;
        dryChargedG = dryMixG;
        dryRemainingG = 0;
        const wT = subT - 7.0;
        holding = "whites-vessel";
        fingerOpeningM = 0.022;
        if (wT < 1.8) {
          const u = smoothstep(wT / 1.8);
          const base = lerpVec3(whitesRestZUp, bowlPourZUp, u);
          whitesPosZUp = [base[0], base[1], base[2] + Math.sin(u * Math.PI) * 0.07];
          whitesTiltRad = lerp(0, 0.45, u);
          stage = "FR10 transferring 181 g tempered egg whites & vanilla to Hobart HL200";
        } else if (wT < 5.0) {
          const pourU = clamp((wT - 1.8) / 3.2, 0, 1);
          whitesPosZUp = bowlPourZUp;
          whitesTiltRad = lerp(0.55, 1.2, smoothstep(pourU));
          whitesPourRateGS = 56.5;
          whitesChargedG = eggWhitesG * pourU;
          whitesRemainingG = eggWhitesG * (1 - pourU);
          stage = `Streaming tempered egg whites into almond-sugar blend (${whitesChargedG.toFixed(0)} g / ${eggWhitesG} g)`;
        } else {
          const retU = smoothstep((wT - 5.0) / 2.0);
          whitesPosZUp = lerpVec3(bowlPourZUp, whitesRestZUp, retU);
          whitesTiltRad = lerp(1.2, 0, retU);
          whitesChargedG = eggWhitesG;
          whitesRemainingG = 0;
          holding = retU < 0.85 ? "whites-vessel" : "none";
          stage = "576 g almond-egg base charged · returning egg-white vessel";
        }
        toolZUp = [
          whitesPosZUp[0] - 0.03,
          whitesPosZUp[1] - 0.02,
          whitesPosZUp[2] + 0.02,
        ];
      }
    } else if (t < 40.0) {
      // STAGE 3: Close wire guard, lift bowl carriage & run Speed 1 -> Speed 2 planetary mixing (28..40 s)
      phase = "mix-paste";
      tared = true;
      displayedG = 0;
      panDeflectionM = 0.0003;
      evaporatedG = targetEvapG;
      butterMassG = rawButterG - targetEvapG;
      browningProgress = 1.0;
      butterTempC = lerp(143.0, 136.0, (t - 28.0) / 12.0);
      dryChargedG = dryMixG;
      dryRemainingG = 0;
      whitesChargedG = eggWhitesG;
      whitesRemainingG = 0;

      const mixT = t - 28.0;
      if (mixT < 2.4) {
        // Close wire safety guard & raise bowl lift
        const u = smoothstep(mixT / 2.4);
        guardAngleRad = lerp(-1.95, 0, u);
        bowlLiftM = lerp(-0.02, 0, u);
        toolZUp = lerpVec3(guardHandleZUp, liftLeverZUp, u);
        fingerOpeningM = 0.016;
        stage =
          "FR10 closing Hobart HL200 wire safety cage & raising 20 qt bowl lift (+20 mm)";
      } else {
        bowlLiftM = 0;
        const runT = mixT - 2.4;
        speedSetting = runT < 3.0 ? 1 : 2;
        rpm = speedSetting === 1 ? 59 : 107;
        const omega = (rpm * 2 * Math.PI) / 60;
        this.orbitAngleRad += omega * this.dt;
        this.spinAngleRad = -4 * this.orbitAngleRad;
        emulsification = lerp(0.05, 0.52, clamp(runT / 9.6, 0, 1));
        batterTempC = 23.5;
        toolZUp = lerpVec3(liftLeverZUp, [-0.08, -0.32, 0.28], smoothstep(clamp(runT / 2.5, 0, 1)));
        fingerOpeningM = 0.03;

        if (this.recipe.check === "guard-interlock" && runT > 4.8) {
          guardAngleRad = -0.65;
          speedSetting = 0;
          rpm = 0;
          phase = "failed";
          const reason =
            "Hobart HL200 wire guard interlock tripped during Speed 2 (107 RPM) agitation — motor halted immediately.";
          stage = reason;
          outcome = { kind: "failed", reason };
        } else {
          guardAngleRad = 0;
          stage = `Hobart HL200 Speed ${speedSetting} (${rpm} RPM planetary / ${rpm * 4} RPM ${this.recipe.tool}) · hydrating almond-egg paste (${Math.round(emulsification * 100)}%)`;
        }
      }
    } else if (t < 51.0) {
      // STAGE 4: Grasp induction pan & stream 150 g warm beurre noisette into Hobart HL200 on Speed 1 (40..51 s)
      phase = "temper-butter";
      tared = true;
      displayedG = 0;
      panDeflectionM = 0.0003;
      evaporatedG = targetEvapG;
      browningProgress = 1.0;
      dryChargedG = dryMixG;
      dryRemainingG = 0;
      whitesChargedG = eggWhitesG;
      whitesRemainingG = 0;
      bowlLiftM = 0;
      guardAngleRad = -1.45; // Chute clearance for pouring warm butter stream
      speedSetting = 1;
      rpm = 59;
      const omega = (rpm * 2 * Math.PI) / 60;
      this.orbitAngleRad += omega * this.dt;
      this.spinAngleRad = -4 * this.orbitAngleRad;

      const subT = t - 40.0;
      const panPourZUp: readonly [number, number, number] = [0.19, -0.25, 0.46];

      if (subT < 2.2) {
        const u = smoothstep(subT / 2.2);
        const arcZ = Math.sin(u * Math.PI) * 0.07;
        const base = lerpVec3(hobPanZUp, panPourZUp, u);
        panPosZUp = [base[0], base[1], base[2] + arcZ];
        panTiltRad = lerp(0, 0.42, u);
        butterMassG = rawButterG - targetEvapG;
        butterTempC = 135.0;
        emulsification = 0.52;
        batterTempC = 23.5;
        stage =
          "FR10 lifting 200 mm stainless pan of warm amber beurre noisette (135 °C) to mixer";
      } else if (subT < 8.8) {
        const pourU = clamp((subT - 2.2) / 6.6, 0, 1);
        panPosZUp = panPourZUp;
        panTiltRad = lerp(0.48, 1.08, smoothstep(pourU));
        butterPourRateGS = netBrownedButterG / 6.6;
        butterChargedG = netBrownedButterG * pourU;
        butterMassG = residueG + netBrownedButterG * (1 - pourU);
        butterTempC = lerp(135.0, 128.0, pourU);
        emulsification = lerp(0.52, 0.86, pourU);
        batterTempC = lerp(23.5, 38.8, pourU);
        stage = `Streaming warm beurre noisette into Speed 1 planetary fold (${butterChargedG.toFixed(0)} g / ${netBrownedButterG.toFixed(0)} g · ${batterTempC.toFixed(1)} °C)`;
      } else {
        const retU = smoothstep((subT - 8.8) / 2.2);
        panPosZUp = lerpVec3(panPourZUp, hobPanZUp, retU);
        panTiltRad = lerp(1.08, 0, retU);
        butterChargedG = netBrownedButterG;
        butterMassG = residueG;
        butterTempC = 96.0;
        emulsification = 0.86;
        batterTempC = 38.8;
        stage =
          "150 g beurre noisette incorporated (8 g toasted residue retained in pan) · returning pan";
      }
      holding = "pan";
      fingerOpeningM = 0.018;
      toolZUp = [panPosZUp[0] - 0.16, panPosZUp[1] - 0.02, panPosZUp[2] + 0.05];
    } else {
      // STAGE 5: Final Speed 1 ribbon homogenization, lower bowl & complete (51..60 s)
      const endT = clamp(t - 51.0, 0, 9.0);
      tared = true;
      displayedG = 0;
      panDeflectionM = 0.0003;
      evaporatedG = targetEvapG;
      browningProgress = 1.0;
      dryChargedG = dryMixG;
      dryRemainingG = 0;
      whitesChargedG = eggWhitesG;
      whitesRemainingG = 0;
      butterChargedG = netBrownedButterG;
      butterMassG = residueG;
      butterTempC = 78.0;
      panPosZUp = hobPanZUp;
      panTiltRad = 0;

      if (endT < 6.2) {
        phase = "homogenize";
        const u = clamp(endT / 6.2, 0, 1);
        guardAngleRad = lerp(-0.78, 0, smoothstep(clamp(endT / 1.2, 0, 1)));
        bowlLiftM = 0;
        speedSetting = 1;
        rpm = 59;
        const omega = (rpm * 2 * Math.PI) / 60;
        this.orbitAngleRad += omega * this.dt;
        this.spinAngleRad = -4 * this.orbitAngleRad;
        emulsification = lerp(0.86, 1.0, u);
        batterTempC = lerp(38.8, 36.4, u);
        toolZUp = lerpVec3(
          [hobPanZUp[0] - 0.16, hobPanZUp[1] - 0.02, hobPanZUp[2] + 0.05],
          homeParkZUp,
          smoothstep(u),
        );
        fingerOpeningM = 0.032;
        holding = "none";
        stage = `Final Speed 1 (59 RPM) ribbon fold · glossy golden financier batter (${Math.round(emulsification * 100)}% homogenized)`;
      } else {
        const finishU = smoothstep(clamp((endT - 6.2) / 2.8, 0, 1));
        speedSetting = 0;
        rpm = 0;
        bowlLiftM = lerp(0, -0.02, finishU);
        guardAngleRad = lerp(0, -1.65, finishU);
        emulsification = 1.0;
        batterTempC = 36.2;
        toolZUp = homeParkZUp;
        fingerOpeningM = 0.032;
        holding = "none";

        const totalBatterG = Number(
          (dryMixG + eggWhitesG + netBrownedButterG).toFixed(1),
        );
        const mouldCavitiesYield = Math.floor(totalBatterG / 25);

        if (t >= 60.0 - 1e-6) {
          phase = "completed";
          stage = `Financier batter complete · ${totalBatterG} g glossy noisette batter (${mouldCavitiesYield} cavities @ 25 g)`;
          outcome = {
            kind: "completed",
            rawButterG,
            brownedButterG: netBrownedButterG,
            evaporatedWaterG: targetEvapG,
            panResidueG: residueG,
            dryMixG,
            eggWhitesG,
            totalBatterG,
            peakButterTempC: Number(this.peakButterTempC.toFixed(1)),
            finalBatterTempC: Number(batterTempC.toFixed(1)),
            emulsificationPct: 100,
            mouldCavitiesYield,
          };
        } else {
          phase = "homogenize";
          stage =
            "Stopping Hobart HL200 planetary drive · lowering 20 qt bowl & opening guard";
        }
      }
    }

    const bowlMassG = dryChargedG + whitesChargedG + butterChargedG;

    return {
      step: this.stepCount,
      timeS: Number(t.toFixed(3)),
      hob: this.recipe.hob,
      tool: this.recipe.tool,
      phase,
      stage,
      scale: {
        displayedG: Number(displayedG.toFixed(1)),
        panDeflectionM: Number(panDeflectionM.toFixed(5)),
        tared,
        dryVesselOnScale,
      },
      induction: {
        powerKw: Number(powerKw.toFixed(2)),
        coilActive,
        panPosZUp,
        panTiltRad: Number(panTiltRad.toFixed(4)),
        butterMassG: Number(butterMassG.toFixed(1)),
        butterTempC: Number(butterTempC.toFixed(1)),
        evaporatedG: Number(evaporatedG.toFixed(1)),
        browningProgress: Number(browningProgress.toFixed(3)),
        foamIntensity: Number(foamIntensity.toFixed(3)),
        pouringRateGS: Number(butterPourRateGS.toFixed(1)),
      },
      mixer: {
        speedSetting,
        rpm,
        orbitAngleRad: Number(this.orbitAngleRad.toFixed(4)),
        spinAngleRad: Number(this.spinAngleRad.toFixed(4)),
        bowlLiftM: Number(bowlLiftM.toFixed(4)),
        guardAngleRad: Number(guardAngleRad.toFixed(4)),
        bowlMassG: Number(bowlMassG.toFixed(1)),
        dryChargedG: Number(dryChargedG.toFixed(1)),
        whitesChargedG: Number(whitesChargedG.toFixed(1)),
        butterChargedG: Number(butterChargedG.toFixed(1)),
        batterTempC: Number(batterTempC.toFixed(1)),
        emulsification: Number(emulsification.toFixed(3)),
      },
      dryVessel: {
        posZUp: dryPosZUp,
        tiltRad: Number(dryTiltRad.toFixed(4)),
        massG: Number(dryRemainingG.toFixed(1)),
        pouringRateGS: Number(dryPourRateGS.toFixed(1)),
      },
      whitesVessel: {
        posZUp: whitesPosZUp,
        tiltRad: Number(whitesTiltRad.toFixed(4)),
        massG: Number(whitesRemainingG.toFixed(1)),
        pouringRateGS: Number(whitesPourRateGS.toFixed(1)),
      },
      cobot: {
        toolZUp,
        wristPitchRad: Number(wristPitchRad.toFixed(4)),
        fingerOpeningM: Number(fingerOpeningM.toFixed(4)),
        holding,
      },
      outcome,
    };
  }
}
