export type BlackSesameHobModel =
  | "maruzen"
  | "vollrath"
  | "panasonic-kz-ck1402"
  | "rinnai-rsb-150pj";
export type BlackSesameRoastMode = "skip" | "refresh";
export type BlackSesameCheck =
  | "none"
  | "overweight-unreconciled"
  | "enclosure-interlock";

export type BlackSesameCobotRecipeConfig = Readonly<{
  hob: BlackSesameHobModel;
  roast: BlackSesameRoastMode;
  sesameG: number;
  waterG: number;
  riceFlourG: number;
  sugarG: number;
  saltG: number;
  milkPerDrinkG: number;
  concentratePerDrinkG: number;
  check: BlackSesameCheck;
}>;

export const DEFAULT_BLACK_SESAME_COBOT_RECIPE: BlackSesameCobotRecipeConfig = {
  hob: "maruzen",
  roast: "skip",
  sesameG: 220,
  waterG: 400,
  riceFlourG: 20,
  sugarG: 120,
  saltG: 2,
  milkPerDrinkG: 210,
  concentratePerDrinkG: 76,
  check: "none",
};

export type BlackSesameCobotPhase =
  | "grind-sesame"
  | "cook-slurry"
  | "blend-standardize"
  | "cold-carrier-transfer"
  | "heated-mixer-service"
  | "completed"
  | "failed";

export type BlackSesameCobotOutcome =
  | Readonly<{
      kind: "completed";
      sesameGroundG: number;
      cookedSlurryG: number;
      evaporatedSteamG: number;
      waterTopUpG: number;
      standardizedConcentrateG: number;
      bottleAMassG: number;
      bottleBMassG: number;
      portionsYield: number;
      servedDrinkG: number;
      servedDrinkTempC: number;
      refrigeratorTempC: number;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
    }>;

export type BlackSesameCobotSample = Readonly<{
  step: number;
  timeS: number;
  hob: BlackSesameHobModel;
  roast: BlackSesameRoastMode;
  phase: BlackSesameCobotPhase;
  stage: string;
  grinder: Readonly<{
    loadIndex: 1 | 2 | 3 | 4;
    rpm: number;
    bladeAngleRad: number;
    coverSeated: boolean;
    sesameGroundG: number;
  }>;
  induction: Readonly<{
    powerKw: number;
    coilActive: boolean;
    panPosZUp: readonly [number, number, number];
    panTiltRad: number;
    slurryMassG: number;
    slurryTempC: number;
    evaporatedG: number;
    pouringRateGS: number;
  }>;
  blender: Readonly<{
    rpm: number;
    bladeAngleRad: number;
    enclosureDoorAngleRad: number;
    containerMassG: number;
    concentrateTempC: number;
    homogenization: number;
  }>;
  scale: Readonly<{
    displayedG: number;
    panDeflectionM: number;
    waterTopUpG: number;
    standardizedMassG: number;
  }>;
  coldCarrier: Readonly<{
    carrierPosZUp: readonly [number, number, number];
    bottleAMassG: number;
    bottleBMassG: number;
    cabinetTempC: number;
    rightDoorAngleRad: number;
    storedInRefrigerator: boolean;
  }>;
  milkMixer: Readonly<{
    jugPosZUp: readonly [number, number, number];
    jugTiltRad: number;
    stirrerRpm: number;
    stirrerAngleRad: number;
    concentrateDosedG: number;
    milkDosedG: number;
    drinkMassG: number;
    drinkTempC: number;
    pouringRateGS: number;
    servedCupG: number;
  }>;
  cobot: Readonly<{
    toolZUp: readonly [number, number, number];
    wristPitchRad: number;
    fingerOpeningM: number;
    holding:
      | "grinder-bowl"
      | "slurry-pan"
      | "vitamix-container"
      | "cold-carrier"
      | "severin-jug"
      | "none";
  }>;
  outcome: BlackSesameCobotOutcome | null;
}>;

export type BlackSesameTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

export function blackSesameTimelineStages(): readonly BlackSesameTimelineStage[] {
  return [
    {
      id: "grind-sesame",
      label: "1 · Waring WSG60 4 × 55 g sesame grind",
      startS: 0,
      endS: 12,
    },
    {
      id: "cook-slurry",
      label: "2 · 542 g rice-flour sweet slurry cook",
      startS: 12,
      endS: 24,
    },
    {
      id: "blend-standardize",
      label: "3 · Vitamix Quiet One blend & 760 g Ohaus tare",
      startS: 24,
      endS: 38,
    },
    {
      id: "cold-carrier-transfer",
      label: "4 · FR10 cold-carrier transfer to Hoshizaki 3 °C",
      startS: 38,
      endS: 48,
    },
    {
      id: "heated-mixer-service",
      label: "5 · Severin SM 3587 76 g + 210 g milk service",
      startS: 48,
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
 * Deterministic mass-balance, thermal, and kinematic simulation engine for the
 * Plan 61B Black Sesame Milk 3D Cobot workcell:
 * - Waring WSG60 spice grinder (4 × 55 g pulse loads = 220 g black sesame)
 * - Maruzen MIH-02C / Vollrath 59500P induction slurry cooking (400 g water +
 *   20 g rice flour + 120 g sugar + 2 g salt)
 * - Vitamix The Quiet One concentrate blending + 760 g standardization on
 *   Ohaus Ranger 3000 scale
 * - FAIRINO FR10 covered cold-container carrier transfer (2 × 380 g bottles)
 *   into Hoshizaki RT-120SNJ refrigerated worktop (3.0 °C)
 * - Severin SM 3587 Spuma 700 Plus heated drink service (76 g concentrate +
 *   210 g milk = 286 g at 65 °C)
 */
export class BlackSesameCobotSimulationEngine {
  private stepCount = 0;
  private readonly dt = 0.04;
  private grinderBladeRad = 0;
  private blenderBladeRad = 0;
  private stirrerAngleRad = 0;

  constructor(private readonly recipe: BlackSesameCobotRecipeConfig) {}

  initialSample(): BlackSesameCobotSample {
    return this.computeSample(0);
  }

  stepBatch(steps: number): readonly BlackSesameCobotSample[] {
    const out: BlackSesameCobotSample[] = [];
    for (let i = 0; i < steps; i++) {
      this.stepCount += 1;
      const sample = this.computeSample(this.stepCount * this.dt);
      out.push(sample);
      if (sample.outcome !== null) break;
    }
    return out;
  }

  private computeSample(t: number): BlackSesameCobotSample {
    // Workcell Z-up station coordinates on the stainless bench (Z = 0 is bench top)
    const grinderZUp: readonly [number, number, number] = [-0.52, -0.18, 0.24];
    const hobPanZUp: readonly [number, number, number] = [-0.22, -0.18, 0.106];
    const blenderPourZUp: readonly [number, number, number] = [
      0.08, -0.16, 0.42,
    ];
    const blenderDoorZUp: readonly [number, number, number] = [
      0.08, -0.32, 0.34,
    ];
    const scalePanZUp: readonly [number, number, number] = [0.36, -0.18, 0.125];
    const coldStagingZUp: readonly [number, number, number] = [
      0.36, -0.38, 0.06,
    ];
    const hoshizakiShelfZUp: readonly [number, number, number] = [
      0.24, -0.34, -0.36,
    ];
    const severinJugHomeZUp: readonly [number, number, number] = [
      0.58, -0.18, 0.14,
    ];
    const serviceCupPourZUp: readonly [number, number, number] = [
      0.58, -0.39, 0.18,
    ];
    const homeParkZUp: readonly [number, number, number] = [-0.14, 0.08, 0.38];

    const sesameTotalG = this.recipe.sesameG;
    const rawSlurryG =
      this.recipe.waterG +
      this.recipe.riceFlourG +
      this.recipe.sugarG +
      this.recipe.saltG;
    const evapTargetG = 12.0;
    const residueAndSpillG = 10.0;
    const cookedSlurryG = rawSlurryG - evapTargetG;
    const blendedPreTopUpG =
      sesameTotalG + cookedSlurryG - residueAndSpillG; // 220 + 530 - 10 = 740 g
    const targetStandardG = 760.0;
    const waterTopUpTargetG = Math.max(0, targetStandardG - blendedPreTopUpG); // 20 g
    const concentratePerDrinkG = this.recipe.concentratePerDrinkG;
    const milkPerDrinkG = this.recipe.milkPerDrinkG;
    const totalDrinkG = concentratePerDrinkG + milkPerDrinkG; // 286 g

    let phase: BlackSesameCobotPhase = "grind-sesame";
    let stage =
      "Prepared Black Sesame Milk bench · Waring WSG60, Maruzen hob, Vitamix Quiet One, Ohaus scale, Hoshizaki RT-120SNJ & Severin SM 3587";

    let loadIndex: 1 | 2 | 3 | 4 = 1;
    let grinderRpm = 0;
    let coverSeated = true;
    let sesameGroundG = 0;

    let powerKw = 0;
    let coilActive = false;
    let panPosZUp = hobPanZUp;
    let panTiltRad = 0;
    let slurryMassG = rawSlurryG;
    let slurryTempC = 24.0;
    let evaporatedG = 0;
    let slurryPourRateGS = 0;

    let blenderRpm = 0;
    let enclosureDoorAngleRad = 0; // 0 = closed, 1.83 rad (105 deg) = open
    let containerMassG = 0;
    let concentrateTempC = 24.0;
    let homogenization = 0;

    let displayedG = 0;
    let panDeflectionM = 0.0002;
    let waterTopUpG = 0;
    let standardizedMassG = 0;

    let carrierPosZUp = coldStagingZUp;
    let bottleAMassG = 0;
    let bottleBMassG = 0;
    const cabinetTempC = 3.0;
    let rightDoorAngleRad = 0;
    let storedInRefrigerator = false;

    let jugPosZUp = severinJugHomeZUp;
    let jugTiltRad = 0;
    let stirrerRpm = 0;
    let concentrateDosedG = 0;
    let milkDosedG = 0;
    let drinkMassG = 0;
    let drinkTempC = 6.0;
    let drinkPourRateGS = 0;
    let servedCupG = 0;

    let toolZUp = homeParkZUp;
    let wristPitchRad = Math.PI * 0.45;
    let fingerOpeningM = 0.032;
    let holding:
      | "grinder-bowl"
      | "slurry-pan"
      | "vitamix-container"
      | "cold-carrier"
      | "severin-jug"
      | "none" = "none";
    let outcome: BlackSesameCobotOutcome | null = null;

    if (t <= 0.0001) {
      this.grinderBladeRad = 0;
      this.blenderBladeRad = 0;
      this.stirrerAngleRad = 0;
    } else if (t < 12.0) {
      // STAGE 1: Waring WSG60 4 × 55 g pulse grinding (0..12 s)
      phase = "grind-sesame";
      const u = clamp(t / 12.0, 0, 1);
      const rawIdx = Math.min(4, Math.floor(u * 4) + 1);
      loadIndex = (
        rawIdx === 1 ? 1 : rawIdx === 2 ? 2 : rawIdx === 3 ? 3 : 4
      ) as 1 | 2 | 3 | 4;
      const loadU = (u * 4) % 1;
      // Pulse grind during middle 70% of each 3 s sub-cycle
      const pulsing = loadU > 0.15 && loadU < 0.85;
      coverSeated = pulsing;
      grinderRpm = pulsing ? 18500 : 0;
      this.grinderBladeRad += ((grinderRpm * 2 * Math.PI) / 60) * this.dt * 0.08;
      sesameGroundG = Number((sesameTotalG * u).toFixed(1));

      // Concurrent induction pre-warm on slurry pan
      coilActive = true;
      powerKw =
        this.recipe.hob === "maruzen"
          ? 1.6
          : this.recipe.hob === "vollrath"
            ? 1.5
            : this.recipe.hob === "rinnai-rsb-150pj"
              ? 2.2
              : 1.2;
      slurryTempC = lerp(24.0, 68.0, u);

      toolZUp = lerpVec3(homeParkZUp, grinderZUp, smoothstep(Math.min(1, t / 2.5)));
      fingerOpeningM = pulsing ? 0.018 : 0.028;
      holding = "grinder-bowl";
      const roastNote =
        this.recipe.roast === "refresh" ? "160 °C refreshed seeds · " : "";
      stage = `Waring WSG60 pulse load ${loadIndex}/4 (${(sesameTotalG / 4).toFixed(0)} g) · ${roastNote}${sesameGroundG.toFixed(0)} / ${sesameTotalG} g milled`;
    } else if (t < 24.0) {
      // STAGE 2: Cook 542 g sweet rice-flour slurry on Maruzen / Vollrath hob & charge Vitamix (12..24 s)
      phase = "cook-slurry";
      sesameGroundG = sesameTotalG;
      const u = clamp((t - 12.0) / 12.0, 0, 1);

      if (u < 0.55) {
        const sub = u / 0.55;
        coilActive = true;
        powerKw =
          this.recipe.hob === "maruzen"
            ? 2.0
            : this.recipe.hob === "vollrath"
              ? 1.8
              : this.recipe.hob === "rinnai-rsb-150pj"
                ? 5.23
                : 1.4;
        slurryTempC = lerp(68.0, 96.0, smoothstep(sub));
        evaporatedG = lerp(0, evapTargetG, sub);
        slurryMassG = rawSlurryG - evaporatedG;
        enclosureDoorAngleRad = lerp(0, 1.83, smoothstep(sub)); // Open Vitamix acoustic enclosure door (105 deg)
        toolZUp = lerpVec3(grinderZUp, blenderDoorZUp, smoothstep(sub));
        holding = "grinder-bowl";
        containerMassG = lerp(0, sesameTotalG, smoothstep(sub));
        stage = `Cooking ${rawSlurryG} g rice-flour sweet slurry (${slurryTempC.toFixed(0)} °C · ${evaporatedG.toFixed(1)} g steam) · charging 220 g milled sesame into Vitamix`;
      } else {
        const sub = (u - 0.55) / 0.45;
        coilActive = false;
        powerKw = 0;
        evaporatedG = evapTargetG;
        slurryTempC = lerp(96.0, 88.0, sub);
        enclosureDoorAngleRad = 1.83;
        holding = "slurry-pan";
        panPosZUp = lerpVec3(hobPanZUp, blenderPourZUp, smoothstep(Math.min(1, sub * 1.4)));
        panTiltRad = sub > 0.25 ? lerp(0, 0.92, smoothstep((sub - 0.25) / 0.75)) : 0;
        const pouredSlurryG =
          sub > 0.25
            ? (cookedSlurryG - residueAndSpillG) *
              smoothstep((sub - 0.25) / 0.75)
            : 0;
        slurryMassG = Math.max(residueAndSpillG, cookedSlurryG - pouredSlurryG);
        slurryPourRateGS = sub > 0.25 && sub < 0.96 ? 110 : 0;
        containerMassG = sesameTotalG + pouredSlurryG;
        toolZUp = panPosZUp;
        wristPitchRad = Math.PI * 0.45 + panTiltRad * 0.45;
        stage = `FR10 streaming ${cookedSlurryG.toFixed(0)} g cooked rice-flour slurry into Vitamix Advance container (${containerMassG.toFixed(0)} g)`;
      }
    } else if (t < 38.0) {
      // STAGE 3: Vitamix The Quiet One high-shear blending & 760 g standardization on Ohaus scale (24..38 s)
      phase = "blend-standardize";
      sesameGroundG = sesameTotalG;
      evaporatedG = evapTargetG;
      slurryMassG = residueAndSpillG;
      const u = clamp((t - 24.0) / 14.0, 0, 1);

      if (u < 0.55) {
        const sub = u / 0.55;
        enclosureDoorAngleRad =
          this.recipe.check === "enclosure-interlock" && sub > 0.45
            ? 0.85
            : lerp(1.83, 0, smoothstep(Math.min(1, sub * 2.5)));
        if (this.recipe.check === "enclosure-interlock" && sub > 0.5) {
          phase = "failed";
          blenderRpm = 0;
          const reason =
            "Vitamix The Quiet One acoustic enclosure door opened during high-shear cycle; safety interlock halted blending.";
          stage = reason;
          outcome = { kind: "failed", reason };
        } else {
          blenderRpm = sub > 0.2 ? 14500 : 0;
          this.blenderBladeRad +=
            ((blenderRpm * 2 * Math.PI) / 60) * this.dt * 0.08;
          containerMassG = blendedPreTopUpG;
          homogenization = smoothstep(Math.max(0, (sub - 0.15) / 0.85));
          concentrateTempC = lerp(74.0, 52.0, sub);
          toolZUp = lerpVec3(blenderPourZUp, blenderDoorZUp, smoothstep(sub));
          stage = `Vitamix The Quiet One blending at ${blenderRpm} RPM (${Math.round(homogenization * 100)}% glossy emulsion)`;
        }
      } else {
        const sub = (u - 0.55) / 0.45;
        homogenization = 1.0;
        enclosureDoorAngleRad = lerp(0, 1.83, smoothstep(Math.min(1, sub * 2.0)));
        holding = "vitamix-container";
        toolZUp = lerpVec3(blenderPourZUp, scalePanZUp, smoothstep(Math.min(1, sub * 1.4)));

        if (this.recipe.check === "overweight-unreconciled") {
          waterTopUpG = 28.0;
          standardizedMassG = 762.0;
          displayedG = standardizedMassG;
          panDeflectionM = 0.0022;
          if (sub >= 0.85) {
            phase = "failed";
            const reason =
              "Concentrate mass balance refused: 762.0 g measured on Ohaus Ranger 3000 exceeds 760.0 g target without excess disposition.";
            stage = reason;
            outcome = { kind: "failed", reason };
          } else {
            stage = `Weighing concentrate on Ohaus Ranger 3000 (${displayedG.toFixed(1)} g > 760.0 g limit)`;
          }
        } else {
          waterTopUpG = Number((waterTopUpTargetG * smoothstep(sub)).toFixed(1));
          standardizedMassG = Number((blendedPreTopUpG + waterTopUpG).toFixed(1));
          displayedG = standardizedMassG;
          panDeflectionM = 0.0002 + (displayedG / 1000) * 0.0022;
          containerMassG = standardizedMassG;
          concentrateTempC = lerp(52.0, 18.0, sub);
          stage = `Ohaus Ranger 3000 standardization: +${waterTopUpG.toFixed(1)} g water top-up → ${standardizedMassG.toFixed(1)} g concentrate`;
        }
      }
    } else if (t < 48.0) {
      // STAGE 4: Fill 2 × 380 g bottles & FAIRINO FR10 cold-carrier transfer into Hoshizaki RT-120SNJ (38..48 s)
      phase = "cold-carrier-transfer";
      sesameGroundG = sesameTotalG;
      evaporatedG = evapTargetG;
      slurryMassG = residueAndSpillG;
      homogenization = 1.0;
      waterTopUpG = waterTopUpTargetG;
      standardizedMassG = targetStandardG;
      displayedG = targetStandardG;
      concentrateTempC = 4.0;

      const u = clamp((t - 38.0) / 10.0, 0, 1);
      if (u < 0.35) {
        const sub = u / 0.35;
        bottleAMassG = Number((380 * smoothstep(sub)).toFixed(1));
        bottleBMassG = Number((380 * smoothstep(sub)).toFixed(1));
        containerMassG = Math.max(0, targetStandardG - bottleAMassG - bottleBMassG);
        rightDoorAngleRad = lerp(0, 1.48, smoothstep(sub));
        toolZUp = lerpVec3(scalePanZUp, coldStagingZUp, smoothstep(sub));
        holding = "cold-carrier";
        stage = `Bottling 2 × 380 g released concentrate lots (bottle-a, bottle-b) into covered cold-container carrier`;
      } else {
        const sub = (u - 0.35) / 0.65;
        bottleAMassG = 380;
        bottleBMassG = 380;
        containerMassG = 0;
        holding = sub < 0.85 ? "cold-carrier" : "none";
        carrierPosZUp = lerpVec3(coldStagingZUp, hoshizakiShelfZUp, smoothstep(Math.min(1, sub * 1.15)));
        toolZUp =
          sub < 0.85
            ? carrierPosZUp
            : lerpVec3(hoshizakiShelfZUp, severinJugHomeZUp, smoothstep((sub - 0.85) / 0.15));
        rightDoorAngleRad =
          sub < 0.82 ? 1.48 : lerp(1.48, 0, smoothstep((sub - 0.82) / 0.18));
        storedInRefrigerator = sub >= 0.8;
        stage = `FR10 transferring covered cold-container carrier (760 g) into Hoshizaki RT-120SNJ shelf (${cabinetTempC.toFixed(1)} °C)`;
      }
    } else {
      // STAGE 5: Severin SM 3587 Spuma 700 Plus heated drink service: 76 g concentrate + 210 g milk = 286 g at 65 °C (48..60 s)
      const u = clamp((t - 48.0) / 12.0, 0, 1);
      phase = u >= 1.0 ? "completed" : "heated-mixer-service";
      sesameGroundG = sesameTotalG;
      evaporatedG = evapTargetG;
      slurryMassG = residueAndSpillG;
      homogenization = 1.0;
      waterTopUpG = waterTopUpTargetG;
      standardizedMassG = targetStandardG;
      carrierPosZUp = hoshizakiShelfZUp;
      storedInRefrigerator = true;

      const doseProgress = smoothstep(Math.min(1, u / 0.3));
      concentrateDosedG = Number((concentratePerDrinkG * doseProgress).toFixed(1));
      milkDosedG = Number((milkPerDrinkG * doseProgress).toFixed(1));
      bottleAMassG = Number((380 - concentrateDosedG).toFixed(1));
      bottleBMassG = 380;
      displayedG = concentrateDosedG + milkDosedG;
      panDeflectionM = 0.0002 + (displayedG / 1000) * 0.0018;

      if (u < 0.7) {
        const heatU = clamp((u - 0.2) / 0.5, 0, 1);
        stirrerRpm = u > 0.2 ? 3200 : 0;
        this.stirrerAngleRad +=
          ((stirrerRpm * 2 * Math.PI) / 60) * this.dt * 0.18;
        drinkTempC = lerp(6.0, 65.0, smoothstep(heatU));
        drinkMassG = concentrateDosedG + milkDosedG;
        servedCupG = 0;
        toolZUp = severinJugHomeZUp;
        holding = "severin-jug";
        stage = `Severin SM 3587 induction frothing ${concentrateDosedG.toFixed(0)} g concentrate + ${milkDosedG.toFixed(0)} g milk (${drinkTempC.toFixed(1)} °C)`;
      } else {
        const pourU = clamp((u - 0.7) / 0.3, 0, 1);
        stirrerRpm = 0;
        drinkTempC = 65.0;
        holding = "severin-jug";
        jugPosZUp = lerpVec3(
          severinJugHomeZUp,
          serviceCupPourZUp,
          smoothstep(Math.min(1, pourU * 1.4)),
        );
        jugTiltRad = lerp(0, 0.88, smoothstep(pourU));
        servedCupG = Number((totalDrinkG * smoothstep(pourU)).toFixed(1));
        drinkMassG = Math.max(0, Number((totalDrinkG - servedCupG).toFixed(1)));
        drinkPourRateGS = pourU > 0.08 && pourU < 0.95 ? 95 : 0;
        toolZUp = jugPosZUp;
        wristPitchRad = Math.PI * 0.45 + jugTiltRad * 0.4;
        stage =
          u >= 1.0
            ? `Served ${totalDrinkG} g Black Sesame Milk at 65.0 °C · 684 g concentrate retained in Hoshizaki RT-120SNJ (9 portions ready)`
            : `Pouring ${servedCupG.toFixed(0)} / ${totalDrinkG} g heated Black Sesame Milk into service cup`;
      }

      if (u >= 1.0) {
        outcome = {
          kind: "completed",
          sesameGroundG: sesameTotalG,
          cookedSlurryG,
          evaporatedSteamG: evapTargetG,
          waterTopUpG: waterTopUpTargetG,
          standardizedConcentrateG: targetStandardG,
          bottleAMassG,
          bottleBMassG,
          portionsYield: Math.floor(targetStandardG / concentratePerDrinkG),
          servedDrinkG: totalDrinkG,
          servedDrinkTempC: 65.0,
          refrigeratorTempC: cabinetTempC,
        };
      }
    }

    return {
      step: this.stepCount,
      timeS: Number(t.toFixed(2)),
      hob: this.recipe.hob,
      roast: this.recipe.roast,
      phase,
      stage,
      grinder: {
        loadIndex,
        rpm: grinderRpm,
        bladeAngleRad: this.grinderBladeRad,
        coverSeated,
        sesameGroundG,
      },
      induction: {
        powerKw,
        coilActive,
        panPosZUp,
        panTiltRad,
        slurryMassG: Number(slurryMassG.toFixed(1)),
        slurryTempC: Number(slurryTempC.toFixed(1)),
        evaporatedG: Number(evaporatedG.toFixed(1)),
        pouringRateGS: slurryPourRateGS,
      },
      blender: {
        rpm: blenderRpm,
        bladeAngleRad: this.blenderBladeRad,
        enclosureDoorAngleRad,
        containerMassG: Number(containerMassG.toFixed(1)),
        concentrateTempC: Number(concentrateTempC.toFixed(1)),
        homogenization: Number(homogenization.toFixed(3)),
      },
      scale: {
        displayedG: Number(displayedG.toFixed(1)),
        panDeflectionM,
        waterTopUpG: Number(waterTopUpG.toFixed(1)),
        standardizedMassG: Number(standardizedMassG.toFixed(1)),
      },
      coldCarrier: {
        carrierPosZUp,
        bottleAMassG,
        bottleBMassG,
        cabinetTempC,
        rightDoorAngleRad,
        storedInRefrigerator,
      },
      milkMixer: {
        jugPosZUp,
        jugTiltRad,
        stirrerRpm,
        stirrerAngleRad: this.stirrerAngleRad,
        concentrateDosedG,
        milkDosedG,
        drinkMassG,
        drinkTempC: Number(drinkTempC.toFixed(1)),
        pouringRateGS: drinkPourRateGS,
        servedCupG,
      },
      cobot: {
        toolZUp,
        wristPitchRad,
        fingerOpeningM,
        holding,
      },
      outcome,
    };
  }
}
