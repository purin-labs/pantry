export type GingerTeaWorkflowMode = "black-tea" | "two-pan-milk-tea";
export type GingerTeaHobModel =
  | "maruzen"
  | "vollrath"
  | "panasonic-kz-ck1402"
  | "rinnai-rsb-150pj";
export type GingerTeaLeaf = "assam" | "ctc";
export type GingerTeaCheck =
  | "none"
  | "late-straining-hold"
  | "dropped-pan-recovery";

export type GingerTeaCobotRecipeConfig = Readonly<{
  mode: GingerTeaWorkflowMode;
  hob: GingerTeaHobModel;
  tea: GingerTeaLeaf;
  simmerSeconds: number;
  steepSeconds: number;
  initialDirtyPan: boolean;
  check: GingerTeaCheck;
}>;

export const DEFAULT_GINGER_TEA_COBOT_RECIPE: GingerTeaCobotRecipeConfig = {
  mode: "two-pan-milk-tea",
  hob: "maruzen",
  tea: "assam",
  simmerSeconds: 420,
  steepSeconds: 180,
  initialDirtyPan: true,
  check: "none",
};

export type GingerTeaCobotPhase =
  | "stage-clean-pans"
  | "weigh-and-simmer-ginger"
  | "extract-tea"
  | "strain-and-inspect"
  | "finish-and-serve"
  | "completed"
  | "failed";

export type GingerTeaCobotOutcome =
  | Readonly<{
      kind: "completed";
      mode: GingerTeaWorkflowMode;
      servings: number;
      servedMassG: number;
      evaporatedG: number;
      retainedSolidsG: number;
      spillG: number;
      finalTempC: number;
      cupPreheatWaterG: number;
      panStagingRecovered: boolean;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
    }>;

export type GingerTeaCobotSample = Readonly<{
  step: number;
  timeS: number;
  mode: GingerTeaWorkflowMode;
  hob: GingerTeaHobModel;
  tea: GingerTeaLeaf;
  phase: GingerTeaCobotPhase;
  stage: string;
  sink: Readonly<{
    tapActive: boolean;
    dirtyPanInSink: boolean;
    panCleaned: boolean;
    cupPreheatWaterG: number;
  }>;
  panStaging: Readonly<{
    trayPosZUp: readonly [number, number, number];
    panBPosZUp: readonly [number, number, number];
    panBTiltRad: number;
    insertSeated: boolean;
    stagedAtReceiver: boolean;
    recoveryAttempt: number;
  }>;
  scale: Readonly<{
    displayedG: number;
    panDeflectionM: number;
    gingerG: number;
    teaG: number;
    sugarG: number;
  }>;
  hobStation: Readonly<{
    powerKw: number;
    coilActive: boolean;
    panAPosZUp: readonly [number, number, number];
    panATiltRad: number;
    panALidSeated: boolean;
    panAMassG: number;
    panATempC: number;
    evaporatedG: number;
    pouringRateGS: number;
  }>;
  straining: Readonly<{
    strainerPosZUp: readonly [number, number, number];
    retainedSolidsG: number;
    spillG: number;
    strainedMassG: number;
    lateSeconds: number;
    disposition: "pending" | "released" | "held";
  }>;
  finishing: Readonly<{
    milkAddedG: number;
    sugarAddedG: number;
    panBMassG: number;
    panBTempC: number;
    servedMassG: number;
    servings: number;
    cupsPreheated: boolean;
  }>;
  cobot: Readonly<{
    toolZUp: readonly [number, number, number];
    wristPitchRad: number;
    fingerOpeningM: number;
    holding:
      | "pan-insert-tray"
      | "pan-a"
      | "pan-b"
      | "strainer"
      | "ginger-bowl"
      | "none";
  }>;
  outcome: GingerTeaCobotOutcome | null;
}>;

export type GingerTeaTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

export function gingerTeaTimelineStages(
  mode: GingerTeaWorkflowMode,
): readonly GingerTeaTimelineStage[] {
  if (mode === "black-tea") {
    return [
      {
        id: "stage-clean-pans",
        label: "1 · FR10 MuJoCo clean-pan & receiver staging",
        startS: 0,
        endS: 12,
      },
      {
        id: "weigh-and-simmer-ginger",
        label: "2 · 15 g ginger + 450 g water simmer on hob",
        startS: 12,
        endS: 24,
      },
      {
        id: "extract-tea",
        label: "3 · Heat-off Assam/CTC steeping & off-hob rest",
        startS: 24,
        endS: 36,
      },
      {
        id: "strain-and-inspect",
        label: "4 · Immediate fine-mesh strain & deadline review",
        startS: 36,
        endS: 48,
      },
      {
        id: "finish-and-serve",
        label: "5 · Dissolve 20 g brown sugar, serve 435 g & wash",
        startS: 48,
        endS: 60,
      },
    ];
  }
  return [
    {
      id: "stage-clean-pans",
      label: "1 · Dirty-pan wash & FR10 rigid-insert pan-b staging",
      startS: 0,
      endS: 12,
    },
    {
      id: "weigh-and-simmer-ginger",
      label: "2 · 15 g ginger + 400 g water simmer in pan-a",
      startS: 12,
      endS: 24,
    },
    {
      id: "extract-tea",
      label: "3 · 9 g Assam gentle 3-min simmer in pan-a",
      startS: 24,
      endS: 36,
    },
    {
      id: "strain-and-inspect",
      label: "4 · Strain pan-a → clean pan-b & deadline review",
      startS: 36,
      endS: 48,
    },
    {
      id: "finish-and-serve",
      label: "5 · 180 g milk + 25 g sugar to 78 °C & 300 g cup preheat",
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
 * Deterministic mass-balance, deadline, and kinematic simulation engine for
 * Plan 61C (Ginger Black Tea) and Plan 61D (Two-Pan Ginger Milk Tea):
 * - Wash sink for initial dirty-pan cleaning and post-extraction pan-a wash
 * - FAIRINO FR10 MuJoCo pan-staging cell (`persistent-pan-staging/1`) moving
 *   the 200 mm saucepan in its rigid 600 × 400 mm tray insert from staging rack
 *   to receiving/prep station (with D5 dropped-pan recovery check)
 * - Ohaus Ranger 3000 scale for ginger (15 g), tea (8–9 g), and sugar (20–25 g)
 * - Maruzen MIH-02C / Vollrath 59500P induction hob + heatproof resting pad
 * - Immediate straining through fine mesh strainer with deadline inspection
 */
export class GingerTeaSimulationEngine {
  private stepCount = 0;
  private readonly dt = 0.04;

  constructor(private readonly recipe: GingerTeaCobotRecipeConfig) {}

  initialSample(): GingerTeaCobotSample {
    return this.computeSample(0);
  }

  stepBatch(steps: number): readonly GingerTeaCobotSample[] {
    const out: GingerTeaCobotSample[] = [];
    for (let i = 0; i < steps; i++) {
      this.stepCount += 1;
      const sample = this.computeSample(this.stepCount * this.dt);
      out.push(sample);
      if (sample.outcome !== null) break;
    }
    return out;
  }

  private computeSample(t: number): GingerTeaCobotSample {
    // Workcell Z-up station coordinates (Z = 0 is bench top)
    const sinkBasinZUp: readonly [number, number, number] = [-0.62, -0.18, 0.04];
    const stagingRackZUp: readonly [number, number, number] = [
      -0.38, -0.36, 0.18,
    ];
    const stagingDropFaultZUp: readonly [number, number, number] = [
      -0.12, -0.34, 0.03,
    ];
    const prepBenchPanAZUp: readonly [number, number, number] = [
      -0.28, -0.16, 0.01,
    ];
    const scalePanZUp: readonly [number, number, number] = [-0.04, -0.18, 0.125];
    const hobCenterZUp: readonly [number, number, number] = [0.22, -0.18, 0.106];
    const heatproofRestZUp: readonly [number, number, number] = [
      0.22, -0.38, 0.015,
    ];
    const receiverStationZUp: readonly [number, number, number] = [
      0.5, -0.2, 0.015,
    ];
    const strainPourZUp: readonly [number, number, number] = [
      0.42, -0.2, 0.22,
    ];
    const serviceCupsPourZUp: readonly [number, number, number] = [
      0.58, -0.38, 0.16,
    ];
    const homeParkZUp: readonly [number, number, number] = [-0.14, 0.08, 0.38];

    const isMilkTea = this.recipe.mode === "two-pan-milk-tea";
    const waterG = isMilkTea ? 400 : 450;
    const gingerGTarget = 15;
    const teaGTarget = isMilkTea ? 9 : 8;
    const sugarGTarget = isMilkTea ? 25 : 20;
    const milkGTarget = isMilkTea ? 180 : 0;
    const evapTargetG = 20;
    const retainedSolidsTargetG = isMilkTea ? 36 : 35;
    const spillTargetG = 3;

    const simmeredExtractG = waterG + gingerGTarget - evapTargetG; // 395 g (61D) or 445 g (61C)
    const infusionG = simmeredExtractG + teaGTarget; // 404 g (61D) or 453 g (61C)
    const strainedYieldG = infusionG - retainedSolidsTargetG - spillTargetG; // 365 g (61D) or 415 g (61C)
    const finishedDrinkG = isMilkTea
      ? strainedYieldG + milkGTarget + sugarGTarget // 570 g
      : strainedYieldG + sugarGTarget; // 435 g

    let phase: GingerTeaCobotPhase = "stage-clean-pans";
    let stage = isMilkTea
      ? "Prepared Two-Pan Ginger Milk Tea station · wash sink, FR10 pan-staging insert, Ohaus scale, Maruzen hob & strainer"
      : "Prepared Ginger Black Tea station · FR10 clean-pan staging, Ohaus scale, Maruzen hob, heatproof rest & serving pot";

    let tapActive = false;
    let dirtyPanInSink = isMilkTea && this.recipe.initialDirtyPan;
    let panCleaned = !dirtyPanInSink;
    let cupPreheatWaterG = 0;

    let trayPosZUp = stagingRackZUp;
    let panBPosZUp = stagingRackZUp;
    let panBTiltRad = 0;
    let insertSeated = true;
    let stagedAtReceiver = false;
    let recoveryAttempt = 0;

    let displayedG = 0;
    let panDeflectionM = 0.0002;
    let gingerG = 0;
    let teaG = 0;
    let sugarG = 0;

    let powerKw = 0;
    let coilActive = false;
    let panAPosZUp = prepBenchPanAZUp;
    let panATiltRad = 0;
    let panALidSeated = false;
    let panAMassG = 0;
    let panATempC = 22.0;
    let evaporatedG = 0;
    let pouringRateGS = 0;

    let strainerPosZUp: readonly [number, number, number] = [0.5, -0.2, 0.095];
    let retainedSolidsG = 0;
    let spillG = 0;
    let strainedMassG = 0;
    let lateSeconds = 0;
    let disposition: "pending" | "released" | "held" = "pending";

    let milkAddedG = 0;
    let sugarAddedG = 0;
    let panBMassG = 0;
    let panBTempC = 22.0;
    let servedMassG = 0;
    let servings = 0;
    let cupsPreheated = false;

    let toolZUp = homeParkZUp;
    let wristPitchRad = Math.PI * 0.45;
    let fingerOpeningM = 0.032;
    let holding:
      | "pan-insert-tray"
      | "pan-a"
      | "pan-b"
      | "strainer"
      | "ginger-bowl"
      | "none" = "none";
    let outcome: GingerTeaCobotOutcome | null = null;

    if (t <= 0.0001) {
      // Initial frame
    } else if (t < 12.0) {
      // STAGE 1: Wash initial dirty pan (if 61D) & FAIRINO FR10 MuJoCo staging of clean pan in rigid tray insert (0..12 s)
      phase = "stage-clean-pans";
      const u = clamp(t / 12.0, 0, 1);

      if (isMilkTea && this.recipe.initialDirtyPan && u < 0.35) {
        const sub = u / 0.35;
        tapActive = true;
        dirtyPanInSink = sub < 0.85;
        panCleaned = sub >= 0.85;
        toolZUp = lerpVec3(homeParkZUp, sinkBasinZUp, smoothstep(sub));
        holding = "pan-b";
        stage = `Washing initially dirty saucepan at wash-sink before two-pan reservation (${Math.round(sub * 100)}% clean)`;
      } else {
        const startU = isMilkTea && this.recipe.initialDirtyPan ? 0.35 : 0.0;
        const sub = clamp((u - startU) / (1 - startU), 0, 1);
        tapActive = false;
        dirtyPanInSink = false;
        panCleaned = true;
        holding = "pan-insert-tray";
        fingerOpeningM = 0.018;

        if (this.recipe.check === "dropped-pan-recovery") {
          if (sub < 0.45) {
            const p = sub / 0.45;
            trayPosZUp = lerpVec3(stagingRackZUp, stagingDropFaultZUp, smoothstep(p));
            panBPosZUp = trayPosZUp;
            insertSeated = p < 0.75;
            panBTiltRad = p >= 0.75 ? 0.38 : 0;
            toolZUp = trayPosZUp;
            stage =
              p < 0.75
                ? "FR10 transferring 200 mm saucepan in rigid 600 × 400 mm tray insert"
                : "D5 Fault injected: pan-b shifted in insert before receiving-station support; extraction blocked";
          } else {
            const p = (sub - 0.45) / 0.55;
            recoveryAttempt = 1;
            insertSeated = p > 0.3;
            panBTiltRad = p < 0.3 ? lerp(0.38, 0, p / 0.3) : 0;
            trayPosZUp =
              p < 0.3
                ? lerpVec3(stagingDropFaultZUp, sinkBasinZUp, smoothstep(p / 0.3))
                : lerpVec3(
                    stagingRackZUp,
                    receiverStationZUp,
                    smoothstep((p - 0.3) / 0.7),
                  );
            panBPosZUp = trayPosZUp;
            tapActive = p < 0.3;
            stagedAtReceiver = p >= 0.92;
            toolZUp = trayPosZUp;
            stage =
              p < 0.3
                ? "D5 Recovery: re-sanitizing displaced pan at wash-sink and re-seating in rigid insert"
                : "D5 Recovery attempt #1: FR10 re-staging clean pan-b to receiving station with verified contact";
          }
        } else {
          trayPosZUp = lerpVec3(
            stagingRackZUp,
            receiverStationZUp,
            smoothstep(sub),
          );
          panBPosZUp = trayPosZUp;
          stagedAtReceiver = sub >= 0.9;
          toolZUp = trayPosZUp;
          stage = isMilkTea
            ? `FR10 MuJoCo pan-staging cell transferring clean receiving pan-b in rigid tray insert (${Math.round(sub * 100)}%)`
            : `FR10 MuJoCo pan-staging cell staging clean saucepan & serving pot to preparation position (${Math.round(sub * 100)}%)`;
        }
      }
    } else if (t < 24.0) {
      // STAGE 2: Weigh 15 g sliced/crushed ginger on Ohaus Ranger 3000 & simmer with water in pan-a on hob (12..24 s)
      phase = "weigh-and-simmer-ginger";
      panCleaned = true;
      dirtyPanInSink = false;
      trayPosZUp = receiverStationZUp;
      panBPosZUp = receiverStationZUp;
      stagedAtReceiver = true;
      if (this.recipe.check === "dropped-pan-recovery") recoveryAttempt = 1;

      const u = clamp((t - 12.0) / 12.0, 0, 1);
      if (u < 0.35) {
        const sub = u / 0.35;
        gingerG = Number((gingerGTarget * smoothstep(sub)).toFixed(1));
        displayedG = gingerG;
        panDeflectionM = 0.0002 + (displayedG / 100) * 0.0012;
        panAPosZUp = lerpVec3(prepBenchPanAZUp, hobCenterZUp, smoothstep(sub));
        panAMassG = waterG + gingerG;
        toolZUp = lerpVec3(receiverStationZUp, scalePanZUp, smoothstep(sub));
        holding = "ginger-bowl";
        stage = `Ohaus Ranger 3000 weighing ${gingerG.toFixed(1)} g sliced & crushed ginger · charging ${waterG} g water into pan-a`;
      } else {
        const sub = (u - 0.35) / 0.65;
        gingerG = gingerGTarget;
        displayedG = gingerGTarget;
        panAPosZUp = hobCenterZUp;
        panALidSeated = true;
        coilActive = true;
        powerKw =
          this.recipe.hob === "maruzen"
            ? 2.0
            : this.recipe.hob === "vollrath"
              ? 1.8
              : this.recipe.hob === "rinnai-rsb-150pj"
                ? 5.23
                : 1.4;
        panATempC = lerp(24.0, 98.0, smoothstep(sub));
        evaporatedG = lerp(0, evapTargetG, sub);
        panAMassG = waterG + gingerGTarget - evaporatedG;
        toolZUp = hobCenterZUp;
        holding = "pan-a";
        const hobLabel =
          this.recipe.hob === "maruzen"
            ? "Maruzen MIH-02C"
            : this.recipe.hob === "vollrath"
              ? "Vollrath 59500P"
              : this.recipe.hob === "rinnai-rsb-150pj"
                ? "Rinnai RSB-150PJ"
                : "Panasonic KZ-CK1402";
        stage = `Simmering ${waterG} g water + 15 g ginger in pan-a on ${hobLabel} (${panATempC.toFixed(0)} °C · ${evaporatedG.toFixed(1)} g steam loss)`;
      }
    } else if (t < 36.0) {
      // STAGE 3: Tea extraction — Plan 61C heat-off steeping on heatproof rest vs Plan 61D 3-min gentle tea simmer on hob (24..36 s)
      phase = "extract-tea";
      panCleaned = true;
      dirtyPanInSink = false;
      trayPosZUp = receiverStationZUp;
      panBPosZUp = receiverStationZUp;
      stagedAtReceiver = true;
      gingerG = gingerGTarget;
      evaporatedG = evapTargetG;
      if (this.recipe.check === "dropped-pan-recovery") recoveryAttempt = 1;

      const u = clamp((t - 24.0) / 12.0, 0, 1);
      teaG = Number((teaGTarget * smoothstep(Math.min(1, u * 3))).toFixed(1));
      displayedG = teaG;
      panDeflectionM = 0.0002 + (displayedG / 100) * 0.001;
      panAMassG = simmeredExtractG + teaG;
      panALidSeated = true;

      if (isMilkTea) {
        // Plan 61D: Gentle simmer of 9 g Assam leaf on the hob for 180 s while pan-b waits at receiving station
        coilActive = true;
        powerKw =
          this.recipe.hob === "maruzen"
            ? 1.1
            : this.recipe.hob === "vollrath"
              ? 1.0
              : this.recipe.hob === "rinnai-rsb-150pj"
                ? 1.8
                : 0.9;
        panAPosZUp = hobCenterZUp;
        panATempC = lerp(98.0, 95.0, u);
        toolZUp = hobCenterZUp;
        holding = "pan-a";
        stage = `Plan 61D gentle tea simmer: +${teaG.toFixed(1)} g Assam in pan-a on hob (${panATempC.toFixed(0)} °C) · clean pan-b reserved at receiver`;
      } else {
        // Plan 61C: Turn off heat, add 8 g Assam/CTC tea, cover and move pan-a off hob to heatproof resting position
        coilActive = false;
        powerKw = 0;
        panAPosZUp = lerpVec3(
          hobCenterZUp,
          heatproofRestZUp,
          smoothstep(Math.min(1, Math.max(0, (u - 0.2) / 0.5))),
        );
        panATempC = lerp(96.0, 88.0, u);
        toolZUp = panAPosZUp;
        holding = "pan-a";
        const teaLabel =
          this.recipe.tea === "assam" ? "8 g Assam leaf" : "8 g fine CTC tea";
        stage = `Plan 61C heat-off steeping (${this.recipe.steepSeconds} s): ${teaLabel} covered in pan-a on heatproof rest · hob freed for Batch 2`;
      }
    } else if (t < 48.0) {
      // STAGE 4: Immediate straining through fine mesh strainer & extraction deadline inspection (36..48 s)
      phase = "strain-and-inspect";
      panCleaned = true;
      dirtyPanInSink = false;
      trayPosZUp = receiverStationZUp;
      panBPosZUp = receiverStationZUp;
      stagedAtReceiver = true;
      gingerG = gingerGTarget;
      teaG = teaGTarget;
      evaporatedG = evapTargetG;
      if (this.recipe.check === "dropped-pan-recovery") recoveryAttempt = 1;

      const u = clamp((t - 36.0) / 12.0, 0, 1);
      const fromPos = isMilkTea ? hobCenterZUp : heatproofRestZUp;

      if (this.recipe.check === "late-straining-hold") {
        lateSeconds = 90;
        disposition = "held";
      } else {
        lateSeconds = 0;
        disposition = u >= 0.75 ? "released" : "pending";
      }

      const pourU = clamp((u - 0.15) / 0.65, 0, 1);
      panAPosZUp = lerpVec3(
        fromPos,
        strainPourZUp,
        smoothstep(Math.min(1, u * 2.2)),
      );
      panATiltRad = lerp(0, 0.95, smoothstep(pourU));
      panALidSeated = false;
      pouringRateGS = pourU > 0.05 && pourU < 0.95 ? 85 : 0;

      strainedMassG = Number((strainedYieldG * smoothstep(pourU)).toFixed(1));
      retainedSolidsG = Number(
        (retainedSolidsTargetG * smoothstep(pourU)).toFixed(1),
      );
      spillG = Number((spillTargetG * smoothstep(pourU)).toFixed(1));
      panAMassG = Math.max(
        0,
        infusionG - strainedMassG - retainedSolidsG - spillG,
      );
      panBMassG = strainedMassG;
      panBTempC = 82.0;
      toolZUp = panAPosZUp;
      wristPitchRad = Math.PI * 0.45 + panATiltRad * 0.45;
      holding = "pan-a";

      if (this.recipe.check === "late-straining-hold" && u >= 0.85) {
        phase = "failed";
        const reason =
          "Extraction deadline exceeded by 90 s (worker occupied at other station); strained lot held for explicit operator release or discard disposition.";
        stage = reason;
        outcome = { kind: "failed", reason };
      } else {
        stage = isMilkTea
          ? `Straining pan-a through fine mesh strainer into clean pan-b (${strainedMassG.toFixed(0)} g extract · ${retainedSolidsG.toFixed(0)} g wet solids)`
          : `Straining pan-a through fine mesh strainer into serving pot (${strainedMassG.toFixed(0)} g tea · ${retainedSolidsG.toFixed(0)} g wet solids)`;
      }
    } else {
      // STAGE 5: Finish & serve — Plan 61C sugar + 2 cups (435 g) vs Plan 61D pan-a wash + 300 g cup preheat + pan-b 180 g milk + 25 g sugar to 78 °C (48..60 s)
      const u = clamp((t - 48.0) / 12.0, 0, 1);
      phase = u >= 1.0 ? "completed" : "finish-and-serve";
      panCleaned = true;
      gingerG = gingerGTarget;
      teaG = teaGTarget;
      evaporatedG = evapTargetG;
      retainedSolidsG = retainedSolidsTargetG;
      spillG = spillTargetG;
      strainedMassG = strainedYieldG;
      disposition = "released";
      if (this.recipe.check === "dropped-pan-recovery") recoveryAttempt = 1;

      const addU = smoothstep(Math.min(1, u / 0.35));
      sugarG = Number((sugarGTarget * addU).toFixed(1));
      sugarAddedG = sugarG;
      displayedG = sugarG + (isMilkTea ? milkGTarget * addU : 0);
      panDeflectionM = 0.0002 + (displayedG / 500) * 0.0015;

      if (isMilkTea) {
        // Wash pan-a at sink, heat 300 g cup-preheat water, move pan-b to hob and heat with 180 g milk + 25 g sugar along 55 -> 68 -> 78 °C
        tapActive = u < 0.35;
        dirtyPanInSink = u < 0.3;
        cupPreheatWaterG = Number((300 * smoothstep(Math.min(1, u / 0.5))).toFixed(0));
        cupsPreheated = u >= 0.55;
        panAPosZUp = sinkBasinZUp;

        milkAddedG = Number((milkGTarget * addU).toFixed(1));
        const heatU = clamp((u - 0.2) / 0.55, 0, 1);
        const pourU = clamp((u - 0.75) / 0.25, 0, 1);

        coilActive = u >= 0.15 && u < 0.78;
        powerKw = coilActive
          ? this.recipe.hob === "maruzen"
            ? 1.4
            : this.recipe.hob === "vollrath"
              ? 1.3
              : this.recipe.hob === "rinnai-rsb-150pj"
                ? 2.1
                : 1.1
          : 0;
        // Declared finishing trace: 55 °C -> 68 °C -> 78 °C (within 75–80 °C)
        panBTempC =
          heatU < 0.5
            ? lerp(55.0, 68.0, heatU * 2)
            : lerp(68.0, 78.0, (heatU - 0.5) * 2);

        if (u < 0.75) {
          panBPosZUp = lerpVec3(
            receiverStationZUp,
            hobCenterZUp,
            smoothstep(Math.min(1, u * 3)),
          );
          panBMassG = strainedYieldG + milkAddedG + sugarAddedG;
          toolZUp = panBPosZUp;
          holding = "pan-b";
          stage = `Pan-b milk finishing on hob: +180 g milk + 25 g sugar → ${panBTempC.toFixed(1)} °C (75–80 °C range) · pan-a washed & 300 g cup preheat`;
        } else {
          panBPosZUp = lerpVec3(
            hobCenterZUp,
            serviceCupsPourZUp,
            smoothstep(Math.min(1, pourU * 1.4)),
          );
          panBTiltRad = lerp(0, 0.86, smoothstep(pourU));
          servedMassG = Number((finishedDrinkG * smoothstep(pourU)).toFixed(1));
          panBMassG = Math.max(0, finishedDrinkG - servedMassG);
          pouringRateGS = pourU > 0.05 && pourU < 0.95 ? 95 : 0;
          servings = u >= 0.95 ? 2 : 1;
          toolZUp = panBPosZUp;
          wristPitchRad = Math.PI * 0.45 + panBTiltRad * 0.4;
          holding = "pan-b";
          stage =
            u >= 1.0
              ? `Served 2 preheated cups (${finishedDrinkG} g Ginger Milk Tea at 78.0 °C) · both pans & strainer washed and returned`
              : `Pouring ${servedMassG.toFixed(0)} / ${finishedDrinkG} g Ginger Milk Tea (78.0 °C) into 2 preheated cups`;
        }
      } else {
        // Plan 61C: Dissolve 20 g brown sugar in strained black tea, pour 435 g (2 servings), wash pan-a at sink
        tapActive = u > 0.3 && u < 0.85;
        dirtyPanInSink = u > 0.25 && u < 0.8;
        panAPosZUp = sinkBasinZUp;
        panBTempC = 82.0;

        const pourU = clamp((u - 0.35) / 0.65, 0, 1);
        panBPosZUp = lerpVec3(
          receiverStationZUp,
          serviceCupsPourZUp,
          smoothstep(Math.min(1, pourU * 1.4)),
        );
        panBTiltRad = lerp(0, 0.84, smoothstep(pourU));
        servedMassG = Number((finishedDrinkG * smoothstep(pourU)).toFixed(1));
        panBMassG = Math.max(0, finishedDrinkG - servedMassG);
        pouringRateGS = pourU > 0.05 && pourU < 0.95 ? 80 : 0;
        servings = u >= 0.95 ? 2 : 1;
        toolZUp = panBPosZUp;
        wristPitchRad = Math.PI * 0.45 + panBTiltRad * 0.4;
        holding = "pan-b";
        stage =
          u >= 1.0
            ? `Served 2 cups (${finishedDrinkG} g Ginger Black Tea at 82.0 °C) · saucepan, receiver & strainer washed and returned`
            : `Dissolving ${sugarAddedG.toFixed(0)} g brown sugar & serving ${servedMassG.toFixed(0)} / ${finishedDrinkG} g Ginger Black Tea`;
      }

      if (u >= 1.0) {
        outcome = {
          kind: "completed",
          mode: this.recipe.mode,
          servings: 2,
          servedMassG: finishedDrinkG,
          evaporatedG: evapTargetG,
          retainedSolidsG: retainedSolidsTargetG,
          spillG: spillTargetG,
          finalTempC: isMilkTea ? 78.0 : 82.0,
          cupPreheatWaterG: isMilkTea ? 300 : 0,
          panStagingRecovered: this.recipe.check === "dropped-pan-recovery",
        };
      }
    }

    return {
      step: this.stepCount,
      timeS: Number(t.toFixed(2)),
      mode: this.recipe.mode,
      hob: this.recipe.hob,
      tea: this.recipe.tea,
      phase,
      stage,
      sink: {
        tapActive,
        dirtyPanInSink,
        panCleaned,
        cupPreheatWaterG,
      },
      panStaging: {
        trayPosZUp,
        panBPosZUp,
        panBTiltRad,
        insertSeated,
        stagedAtReceiver,
        recoveryAttempt,
      },
      scale: {
        displayedG: Number(displayedG.toFixed(1)),
        panDeflectionM,
        gingerG,
        teaG,
        sugarG,
      },
      hobStation: {
        powerKw,
        coilActive,
        panAPosZUp,
        panATiltRad,
        panALidSeated,
        panAMassG: Number(panAMassG.toFixed(1)),
        panATempC: Number(panATempC.toFixed(1)),
        evaporatedG: Number(evaporatedG.toFixed(1)),
        pouringRateGS,
      },
      straining: {
        strainerPosZUp,
        retainedSolidsG,
        spillG,
        strainedMassG,
        lateSeconds,
        disposition,
      },
      finishing: {
        milkAddedG,
        sugarAddedG,
        panBMassG: Number(panBMassG.toFixed(1)),
        panBTempC: Number(panBTempC.toFixed(1)),
        servedMassG: Number(servedMassG.toFixed(1)),
        servings,
        cupsPreheated,
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
