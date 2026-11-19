import type { EspressoMachine } from "@purin-labs/bakery-model/bakery-physics";

export type LatteProcessCheck =
  | "none"
  | "overheated-milk"
  | "low-steam-pressure";

export type LatteRecipeConfig = Readonly<{
  revision: 1;
  appliance: EspressoMachine;
  milkG: number;
  targetMilkC: number;
  check: LatteProcessCheck;
}>;

export type LattePhase =
  | "place-cup"
  | "espresso-shot"
  | "transfer-cup"
  | "grasp-pitcher"
  | "steam-stretch"
  | "steam-whirlpool"
  | "pour-latte"
  | "return-pitcher"
  | "completed"
  | "failed";

export type LatteOutcome =
  | Readonly<{
      kind: "completed";
      espressoG: number;
      steamedMilkG: number;
      condensedSteamG: number;
      totalBeverageG: number;
      finalCupTempC: number;
      peakMilkTempC: number;
      microfoamExpansion: number;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
    }>;

export type LatteSample = Readonly<{
  step: number;
  timeS: number;
  appliance: EspressoMachine;
  phase: LattePhase;
  stage: string;
  espresso: Readonly<{
    brewPressureBar: number;
    shotElapsedS: number;
    shotDurationS: number;
    coffeeBoilerC: number;
    steamBoilerC: number;
    steamPressureBar: number;
    steamValveOpen: boolean;
    wandAngleDeg: number;
  }>;
  cup: Readonly<{
    /** Z-up station coordinates `[mx, my, mz]`. */
    posZUp: readonly [number, number, number];
    espressoMassG: number;
    milkMassG: number;
    totalMassG: number;
    temperatureC: number;
    cremaCoverage: number;
    latteArtProgress: number;
  }>;
  pitcher: Readonly<{
    /** Z-up station coordinates `[mx, my, mz]`. */
    posZUp: readonly [number, number, number];
    /** Pitch tilt in radians around X/Y for steaming and pouring. */
    tiltRad: number;
    /** Roll angle in radians for lateral rosetta oscillation. */
    wobbleRad: number;
    milkMassG: number;
    temperatureC: number;
    foamExpansion: number;
    vortexRadPerS: number;
    pouringRateGS: number;
  }>;
  cobot: Readonly<{
    /** Z-up end-effector target `[mx, my, mz]`. */
    toolZUp: readonly [number, number, number];
    wristPitchRad: number;
    fingerOpeningM: number;
    holding: "cup" | "pitcher" | "none";
  }>;
  outcome: LatteOutcome | null;
}>;

export type LatteTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

export function latteTimelineStages(): readonly LatteTimelineStage[] {
  return [
    { id: "espresso", label: "1 · Place cup & 9-bar shot", startS: 0, endS: 20 },
    {
      id: "stretch",
      label: "2 · Pitcher grasp & steam stretch",
      startS: 20,
      endS: 31,
    },
    {
      id: "whirlpool",
      label: "3 · Whirlpool microfoam roll",
      startS: 31,
      endS: 41,
    },
    {
      id: "pour",
      label: "4 · Rosetta free-pour latte art",
      startS: 41,
      endS: 53,
    },
    {
      id: "serve",
      label: "5 · Return pitcher & serve latte",
      startS: 53,
      endS: 56,
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
 * Deterministic thermodynamic & kinematic simulation engine for the FAIRINO FR10
 * Caffe Latte station (9-bar espresso extraction + 1.35-bar steam wand aeration
 * & whirlpool texturing + rosetta free-pour latte art).
 */
export class LatteSimulationEngine {
  private stepCount = 0;
  private readonly dt = 0.04;
  private milkTempC = 4.0;
  private pitcherMilkG: number;
  private condensedSteamG = 0;
  private foamExpansion = 1.0;
  private vortexRadPerS = 0;
  private cupEspressoG = 0;
  private cupMilkG = 0;
  private cupTempC = 22.0;
  private peakMilkTempC = 4.0;
  private latteArtProgress = 0;

  constructor(private readonly recipe: LatteRecipeConfig) {
    this.pitcherMilkG = recipe.milkG;
  }

  initialSample(): LatteSample {
    return this.computeSample(0);
  }

  stepBatch(steps: number): readonly LatteSample[] {
    const out: LatteSample[] = [];
    for (let i = 0; i < steps; i++) {
      this.stepCount += 1;
      const sample = this.advanceOneStep();
      out.push(sample);
      if (sample.outcome !== null) break;
    }
    return out;
  }

  private advanceOneStep(): LatteSample {
    const t = this.stepCount * this.dt;
    return this.computeSample(t);
  }

  private computeSample(t: number): LatteSample {
    const isLinea = this.recipe.appliance === "linea";
    const dripCupZUp: readonly [number, number, number] = isLinea
      ? [-0.12, -0.195, 0.225]
      : [-0.094, -0.17, 0.168];
    const coasterCupZUp: readonly [number, number, number] = isLinea
      ? [-0.12, -0.375, 0.225]
      : [-0.094, -0.35, 0.168];
    const rinserPitcherZUp: readonly [number, number, number] = isLinea
      ? [0.28, -0.355, 0.225]
      : [0.25, -0.335, 0.168];
    const wandSteamZUp: readonly [number, number, number] = isLinea
      ? [0.308, -0.228, 0.242]
      : [0.265, -0.21, 0.195];
    const brewButtonZUp: readonly [number, number, number] = isLinea
      ? [-0.08, -0.248, 0.415]
      : [-0.071, -0.216, 0.345];
    const hoverZUp: readonly [number, number, number] = isLinea
      ? [-0.14, -0.33, 0.32]
      : [-0.12, -0.3, 0.27];

    let phase: LattePhase = "place-cup";
    let stage = "Prepared station · porcelain latte bowl & chilled milk pitcher";
    let brewPressureBar = 0;
    let shotElapsedS = 0;
    const shotDurationS = 16;
    let coffeeBoilerC = 93.0;
    let steamBoilerC =
      this.recipe.check === "low-steam-pressure" ? 107.5 : 126.0;
    let steamPressureBar =
      this.recipe.check === "low-steam-pressure" ? 0.42 : 1.38;
    let steamValveOpen = false;
    let wandAngleDeg = 0;

    let cupPosZUp = coasterCupZUp;
    let pitcherPosZUp = rinserPitcherZUp;
    let pitcherTiltRad = 0;
    let pitcherWobbleRad = 0;
    let pouringRateGS = 0;

    let toolZUp = coasterCupZUp;
    let wristPitchRad = Math.PI * 0.44;
    let fingerOpeningM = 0.022;
    let holding: "cup" | "pitcher" | "none" = "cup";
    let outcome: LatteOutcome | null = null;

    if (t <= 0.0001) {
      this.milkTempC = 4.0;
      this.pitcherMilkG = this.recipe.milkG;
      this.condensedSteamG = 0;
      this.foamExpansion = 1.0;
      this.vortexRadPerS = 0;
      this.cupEspressoG = 0;
      this.cupMilkG = 0;
      this.cupTempC = 22.0;
      this.peakMilkTempC = 4.0;
      this.latteArtProgress = 0;
    } else if (t < 2.4) {
      // 1a. Place porcelain latte bowl onto left group drip grate (0..2.4 s)
      phase = "place-cup";
      const u = smoothstep(t / 2.4);
      cupPosZUp = lerpVec3(coasterCupZUp, dripCupZUp, u);
      toolZUp = [cupPosZUp[0], cupPosZUp[1], cupPosZUp[2] + 0.004];
      holding = "cup";
      fingerOpeningM = 0.024;
      stage = "FR10 placing 240 mL porcelain latte bowl on drip grate";
    } else if (t < 18.4) {
      // 1b. 16-second 9-bar double espresso extraction (2.4..18.4 s)
      phase = "espresso-shot";
      cupPosZUp = dripCupZUp;
      shotElapsedS = clamp(t - 2.4, 0, shotDurationS);
      brewPressureBar =
        shotElapsedS < 1.2
          ? lerp(0, 9.0, shotElapsedS / 1.2)
          : shotElapsedS > shotDurationS - 0.6
            ? lerp(9.0, 0, (shotElapsedS - (shotDurationS - 0.6)) / 0.6)
            : 9.0;
      this.cupEspressoG = clamp((shotElapsedS / shotDurationS) * 36.0, 0, 36.0);
      this.cupTempC = lerp(22.0, 64.0, shotElapsedS / shotDurationS);
      coffeeBoilerC = 93.0 - Math.sin((shotElapsedS / shotDurationS) * Math.PI) * 0.45;

      if (shotElapsedS < 0.6) {
        const u = smoothstep(shotElapsedS / 0.6);
        toolZUp = lerpVec3(dripCupZUp, brewButtonZUp, u);
        fingerOpeningM = 0.01;
        holding = "none";
        stage = "Cup seated · pressing left group brew button";
      } else if (shotElapsedS < 1.8) {
        const u = smoothstep((shotElapsedS - 0.6) / 1.2);
        toolZUp = lerpVec3(brewButtonZUp, hoverZUp, u);
        fingerOpeningM = lerp(0.01, 0.036, u);
        holding = "none";
        stage = `9-bar double espresso extraction (${shotElapsedS.toFixed(1)} s / ${shotDurationS} s)`;
      } else if (shotElapsedS < shotDurationS - 1.1) {
        toolZUp = hoverZUp;
        fingerOpeningM = 0.036;
        holding = "none";
        stage = `9-bar double espresso extraction (${shotElapsedS.toFixed(1)} s / ${shotDurationS} s)`;
      } else {
        const u = smoothstep((shotElapsedS - (shotDurationS - 1.1)) / 1.1);
        toolZUp = lerpVec3(hoverZUp, dripCupZUp, u);
        fingerOpeningM = lerp(0.036, 0.024, u);
        holding = "cup";
        stage = "Completing 36 g espresso base · grasping latte bowl";
      }
    } else if (t < 20.6) {
      // 1c. Transfer espresso bowl to front brass coaster (18.4..20.6 s)
      phase = "transfer-cup";
      shotElapsedS = shotDurationS;
      this.cupEspressoG = 36.0;
      const u = smoothstep((t - 18.4) / 2.2);
      cupPosZUp = lerpVec3(dripCupZUp, coasterCupZUp, u);
      toolZUp = [cupPosZUp[0], cupPosZUp[1], cupPosZUp[2] + 0.004];
      holding = "cup";
      fingerOpeningM = 0.024;
      stage = "FR10 transferring 36 g espresso bowl to front service coaster";
    } else if (t < 23.2) {
      // 2a. Move across bar, grasp 600 mL stainless milk pitcher, and position at right steam wand (20.6..23.2 s)
      phase = "grasp-pitcher";
      shotElapsedS = shotDurationS;
      cupPosZUp = coasterCupZUp;
      const sub = (t - 20.6) / 2.6;
      if (sub < 0.55) {
        const u = smoothstep(sub / 0.55);
        const arcZ = Math.sin(u * Math.PI) * 0.07;
        const base = lerpVec3(coasterCupZUp, rinserPitcherZUp, u);
        toolZUp = [base[0], base[1], base[2] + arcZ];
        pitcherPosZUp = rinserPitcherZUp;
        fingerOpeningM = lerp(0.038, 0.025, u);
        holding = u > 0.85 ? "pitcher" : "none";
        stage = "FR10 moving to grasp 600 mL stainless milk pitcher (4.0 °C)";
      } else {
        const u = smoothstep((sub - 0.55) / 0.45);
        pitcherPosZUp = lerpVec3(rinserPitcherZUp, wandSteamZUp, u);
        pitcherTiltRad = lerp(0, 0.14, u);
        wandAngleDeg = lerp(0, 22, u);
        toolZUp = [pitcherPosZUp[0] - 0.02, pitcherPosZUp[1] - 0.03, pitcherPosZUp[2] + 0.01];
        fingerOpeningM = 0.025;
        holding = "pitcher";
        stage = "Submerging right steam wand tip below chilled milk meniscus";
      }
    } else if (t < 31.0) {
      // 2b. Steam stretch / paper-tearing microfoam aeration (23.2..31.0 s)
      phase = "steam-stretch";
      shotElapsedS = shotDurationS;
      cupPosZUp = coasterCupZUp;
      steamValveOpen = true;
      wandAngleDeg = 22;
      const stretchProgress = clamp((t - 23.2) / 7.8, 0, 1);
      pitcherPosZUp = [
        wandSteamZUp[0],
        wandSteamZUp[1],
        wandSteamZUp[2] - stretchProgress * 0.008,
      ];
      pitcherTiltRad = 0.16;
      toolZUp = [
        pitcherPosZUp[0] - 0.02,
        pitcherPosZUp[1] - 0.03,
        pitcherPosZUp[2] + 0.01,
      ];
      holding = "pitcher";
      fingerOpeningM = 0.025;

      const targetStretchC =
        this.recipe.check === "low-steam-pressure" ? 21.0 : 37.5;
      this.milkTempC = lerp(4.0, targetStretchC, stretchProgress);
      this.peakMilkTempC = Math.max(this.peakMilkTempC, this.milkTempC);
      this.condensedSteamG = stretchProgress * 4.2;
      this.foamExpansion =
        this.recipe.check === "low-steam-pressure"
          ? lerp(1.0, 1.06, stretchProgress)
          : this.recipe.check === "overheated-milk"
            ? lerp(1.0, 1.48, stretchProgress)
            : lerp(1.0, 1.28, stretchProgress);
      this.vortexRadPerS = lerp(2.0, 9.5, stretchProgress);
      steamBoilerC =
        this.recipe.check === "low-steam-pressure"
          ? 106.2
          : 126.0 - stretchProgress * 0.6;
      steamPressureBar =
        this.recipe.check === "low-steam-pressure"
          ? 0.38
          : 1.38 - stretchProgress * 0.06;
      stage = `Steam aeration stretch · entraining microfoam (${this.milkTempC.toFixed(1)} °C · ${Math.round((this.foamExpansion - 1) * 100)}% expansion)`;
    } else if (t < 41.0) {
      // 3. Whirlpool texturing roll to target sweetness temperature (31.0..41.0 s)
      phase = "steam-whirlpool";
      shotElapsedS = shotDurationS;
      cupPosZUp = coasterCupZUp;
      const rollProgress = clamp((t - 31.0) / 10.0, 0, 1);
      steamValveOpen = rollProgress < 0.88;
      wandAngleDeg = rollProgress < 0.88 ? 22 : lerp(22, 0, (rollProgress - 0.88) / 0.12);

      pitcherPosZUp = [
        wandSteamZUp[0],
        wandSteamZUp[1],
        wandSteamZUp[2] + 0.006,
      ];
      pitcherTiltRad = 0.22;
      toolZUp = [
        pitcherPosZUp[0] - 0.02,
        pitcherPosZUp[1] - 0.03,
        pitcherPosZUp[2] + 0.01,
      ];
      holding = "pitcher";
      fingerOpeningM = 0.025;

      const finalTargetC =
        this.recipe.check === "overheated-milk"
          ? 74.5
          : this.recipe.check === "low-steam-pressure"
            ? 38.0
            : this.recipe.targetMilkC;
      const startRollC =
        this.recipe.check === "low-steam-pressure" ? 21.0 : 37.5;
      this.milkTempC = lerp(startRollC, finalTargetC, smoothstep(rollProgress));
      this.peakMilkTempC = Math.max(this.peakMilkTempC, this.milkTempC);
      this.condensedSteamG = 4.2 + rollProgress * 5.4;
      this.vortexRadPerS = steamValveOpen ? 16.5 : lerp(16.5, 4.0, (rollProgress - 0.88) / 0.12);

      if (this.recipe.check === "low-steam-pressure" && rollProgress > 0.72) {
        phase = "failed";
        steamValveOpen = false;
        const reason =
          "Steam boiler pressure dropped to 0.35 bar (milk reached only 36.2 °C; minimum 58 °C required for service).";
        stage = reason;
        outcome = { kind: "failed", reason };
      } else {
        stage = `Whirlpool microfoam texturing roll (${this.milkTempC.toFixed(1)} °C / ${finalTargetC.toFixed(0)} °C)`;
      }
    } else if (t < 53.0) {
      // 4. Free-pour Rosetta latte art into the 36 g espresso bowl (41.0..53.0 s)
      phase = "pour-latte";
      shotElapsedS = shotDurationS;
      cupPosZUp = coasterCupZUp;
      wandAngleDeg = 0;
      steamValveOpen = false;
      const pourWindow = (t - 41.0) / 12.0;

      // Pitcher spout targets just above the cup rim `[-0.055, -0.375, 0.305 -> 0.276]`.
      const highPourZUp: readonly [number, number, number] = [
        coasterCupZUp[0] + 0.068,
        coasterCupZUp[1],
        coasterCupZUp[2] + 0.088,
      ];
      const lowArtPourZUp: readonly [number, number, number] = [
        coasterCupZUp[0] + 0.056,
        coasterCupZUp[1],
        coasterCupZUp[2] + 0.052,
      ];

      if (pourWindow < 0.18) {
        // Transfer steamed pitcher from right steam wand to above the espresso cup.
        const u = smoothstep(pourWindow / 0.18);
        const arc = Math.sin(u * Math.PI) * 0.045;
        const base = lerpVec3(wandSteamZUp, highPourZUp, u);
        pitcherPosZUp = [base[0], base[1], base[2] + arc];
        pitcherTiltRad = lerp(0.18, 0.52, u);
        pouringRateGS = 0;
        this.vortexRadPerS = lerp(5.0, 2.0, u);
        stage = "Swirling microfoam & positioning pitcher spout over espresso crema";
      } else if (pourWindow < 0.54) {
        // High canvas pour: sink steamed milk beneath the golden crema.
        const u = clamp((pourWindow - 0.18) / 0.36, 0, 1);
        pitcherPosZUp = lerpVec3(highPourZUp, lowArtPourZUp, smoothstep(u));
        pitcherTiltRad = lerp(0.55, 0.84, u);
        pouringRateGS = 18.5;
        const pouredFraction = u * 0.48;
        this.cupMilkG = this.recipe.milkG * pouredFraction;
        this.pitcherMilkG = Math.max(
          0,
          this.recipe.milkG + this.condensedSteamG - this.cupMilkG,
        );
        this.latteArtProgress = u * 0.22;
        stage = `High canvas pour · sinking steamed milk under espresso crema (${(36 + this.cupMilkG).toFixed(0)} g)`;
      } else {
        // Low close-in Rosetta oscillation pour + pull-through stem!
        const u = clamp((pourWindow - 0.54) / 0.46, 0, 1);
        const pullThrough = u > 0.78 ? smoothstep((u - 0.78) / 0.22) : 0;
        pitcherPosZUp = [
          lowArtPourZUp[0] - pullThrough * 0.028,
          lowArtPourZUp[1] + Math.sin(t * 15.0) * (1 - pullThrough) * 0.0055,
          lowArtPourZUp[2] + pullThrough * 0.024,
        ];
        pitcherTiltRad = lerp(0.84, 1.12, u);
        pitcherWobbleRad = Math.sin(t * 15.0) * (1 - pullThrough) * 0.14;
        pouringRateGS = lerp(19.5, 8.0, pullThrough);
        const pouredFraction = 0.48 + u * 0.52;
        this.cupMilkG = this.recipe.milkG * pouredFraction;
        this.pitcherMilkG = Math.max(
          0,
          (this.recipe.milkG + this.condensedSteamG) * (1 - pouredFraction),
        );
        this.latteArtProgress = clamp(0.22 + u * 0.78, 0, 1);
        stage =
          pullThrough > 0.1
            ? "Pulling fine milk stream through Rosetta leaves to form heart stem"
            : "Pitcher spout lowered · oscillating wrist for Rosetta microfoam leaves";
      }

      this.cupTempC =
        (36 * 61.0 + this.cupMilkG * (this.milkTempC - 1.2)) /
        Math.max(36, 36 + this.cupMilkG);
      toolZUp = [
        pitcherPosZUp[0] + 0.015,
        pitcherPosZUp[1] - 0.025,
        pitcherPosZUp[2] + 0.012,
      ];
      wristPitchRad = Math.PI * 0.44 + pitcherTiltRad * 0.35;
      holding = "pitcher";
      fingerOpeningM = 0.025;
    } else {
      // 5. Return empty stainless pitcher to counter rinser & retract Cobot (53.0..56.0 s)
      const rawU = clamp((t - 53.0) / 3.0, 0, 1);
      shotElapsedS = shotDurationS;
      cupPosZUp = coasterCupZUp;
      const pourEndZUp: readonly [number, number, number] = [
        coasterCupZUp[0] + 0.032,
        coasterCupZUp[1],
        coasterCupZUp[2] + 0.076,
      ];
      const placeU = smoothstep(clamp(rawU / 0.56, 0, 1));
      pitcherPosZUp = lerpVec3(pourEndZUp, rinserPitcherZUp, placeU);
      pitcherTiltRad = lerp(0.95, 0, placeU);
      pouringRateGS = 0;
      this.cupEspressoG = 36.0;
      this.cupMilkG = this.recipe.milkG;
      this.pitcherMilkG = 0;
      this.latteArtProgress = 1.0;
      this.cupTempC =
        (36 * 61.0 + this.recipe.milkG * (this.milkTempC - 1.5)) /
        (36 + this.recipe.milkG);

      const rinserGripZUp: readonly [number, number, number] = [
        rinserPitcherZUp[0] - 0.015,
        rinserPitcherZUp[1] - 0.025,
        rinserPitcherZUp[2] + 0.01,
      ];
      const homeParkZUp: readonly [number, number, number] = [
        -0.28,
        -0.37,
        0.28,
      ];

      if (rawU <= 0.56) {
        toolZUp = [
          pitcherPosZUp[0] - 0.015,
          pitcherPosZUp[1] - 0.025,
          pitcherPosZUp[2] + 0.01,
        ];
        holding = rawU < 0.5 ? "pitcher" : "none";
        fingerOpeningM = lerp(0.025, 0.038, placeU);
      } else {
        const retractU = smoothstep((rawU - 0.56) / 0.44);
        const arcZ = Math.sin(retractU * Math.PI) * 0.08;
        const base = lerpVec3(rinserGripZUp, homeParkZUp, retractU);
        toolZUp = [base[0], base[1], base[2] + arcZ];
        holding = "none";
        fingerOpeningM = 0.036;
      }

      if (t >= 56.0 - 1e-6) {
        if (this.recipe.check === "overheated-milk") {
          phase = "failed";
          const reason =
            "Milk overheated to 74.5 °C during steaming (lactose scorched and microfoam separated above 70 °C limit).";
          stage = reason;
          outcome = { kind: "failed", reason };
        } else {
          phase = "completed";
          stage = "Caffe Latte served · Rosetta microfoam art on front coaster";
          outcome = {
            kind: "completed",
            espressoG: 36.0,
            steamedMilkG: this.recipe.milkG,
            condensedSteamG: Number(this.condensedSteamG.toFixed(1)),
            totalBeverageG: 36.0 + this.recipe.milkG,
            finalCupTempC: Number(this.cupTempC.toFixed(1)),
            peakMilkTempC: Number(this.peakMilkTempC.toFixed(1)),
            microfoamExpansion: Number(this.foamExpansion.toFixed(2)),
          };
        }
      } else {
        phase = "return-pitcher";
        stage = "Returning stainless milk pitcher to counter rinser pad";
      }
    }

    return {
      step: this.stepCount,
      timeS: Number(t.toFixed(3)),
      appliance: this.recipe.appliance,
      phase,
      stage,
      espresso: {
        brewPressureBar: Number(brewPressureBar.toFixed(2)),
        shotElapsedS: Number(shotElapsedS.toFixed(2)),
        shotDurationS,
        coffeeBoilerC: Number(coffeeBoilerC.toFixed(1)),
        steamBoilerC: Number(steamBoilerC.toFixed(1)),
        steamPressureBar: Number(steamPressureBar.toFixed(2)),
        steamValveOpen,
        wandAngleDeg: Number(wandAngleDeg.toFixed(1)),
      },
      cup: {
        posZUp: cupPosZUp,
        espressoMassG: Number(this.cupEspressoG.toFixed(1)),
        milkMassG: Number(this.cupMilkG.toFixed(1)),
        totalMassG: Number((this.cupEspressoG + this.cupMilkG).toFixed(1)),
        temperatureC: Number(this.cupTempC.toFixed(1)),
        cremaCoverage: clamp(this.cupEspressoG / 12, 0, 1),
        latteArtProgress: Number(this.latteArtProgress.toFixed(3)),
      },
      pitcher: {
        posZUp: pitcherPosZUp,
        tiltRad: Number(pitcherTiltRad.toFixed(4)),
        wobbleRad: Number(pitcherWobbleRad.toFixed(4)),
        milkMassG: Number(this.pitcherMilkG.toFixed(1)),
        temperatureC: Number(this.milkTempC.toFixed(1)),
        foamExpansion: Number(this.foamExpansion.toFixed(2)),
        vortexRadPerS: Number(this.vortexRadPerS.toFixed(2)),
        pouringRateGS: Number(pouringRateGS.toFixed(1)),
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
