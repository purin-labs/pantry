export type FinancierBakeMode = "convection" | "conventional";
export type FinancierMouldCount = 1 | 2 | 3;
export type FinancierRackSlot = 2 | 3 | 4;
export type FinancierBakeCheck =
  | "none"
  | "carrier-handoff-recovery"
  | "cell-2-restage-recovery"
  | "under-preheated"
  | "over-baked";

export type FinancierHandoffRecoveryPreset =
  | "nominal-handoff"
  | "carrier-slip-recovery"
  | "cell-2-restage-recovery";

export type FinancierHandoffRecovery = Readonly<{
  preset: FinancierHandoffRecoveryPreset;
  slipLateralMm: number;
  reSeatSeconds: number;
  holdReleaseSeconds: number;
  coolingBufferMin: number;
  cellRoute:
    | "cold-cell-1-direct"
    | "cold-cell-1-reseat"
    | "cold-cell-1-to-2-failover";
  summary: string;
}>;

export function buildFinancierHandoffRecovery(
  preset: FinancierHandoffRecoveryPreset,
): FinancierHandoffRecovery {
  switch (preset) {
    case "carrier-slip-recovery":
      return {
        preset: "carrier-slip-recovery",
        slipLateralMm: 14,
        reSeatSeconds: 45,
        holdReleaseSeconds: 120,
        coolingBufferMin: 4,
        cellRoute: "cold-cell-1-reseat",
        summary:
          "14 mm carrier rail slip re-seated by FR10 (+45 s datum check · 120 s hold release · Batch B cell handoff gated on Batch A clearance)",
      };
    case "cell-2-restage-recovery":
      return {
        preset: "cell-2-restage-recovery",
        slipLateralMm: 18,
        reSeatSeconds: 60,
        holdReleaseSeconds: 120,
        coolingBufferMin: 4,
        cellRoute: "cold-cell-1-to-2-failover",
        summary:
          "18 mm carrier clamp hold recovered via Cell 1 → Cell 2 restage failover (+60 s re-registration · 120 s hold release · secondary baker handoff)",
      };
    case "nominal-handoff":
      return {
        preset: "nominal-handoff",
        slipLateralMm: 0,
        reSeatSeconds: 0,
        holdReleaseSeconds: 0,
        coolingBufferMin: 3,
        cellRoute: "cold-cell-1-direct",
        summary:
          "Nominal 0 mm carrier alignment · direct Robot cell 1 cold transfer (3 min in-mould cooling)",
      };
  }
}

export function handoffPresetForBakeCheck(
  check: FinancierBakeCheck,
): FinancierHandoffRecoveryPreset {
  if (check === "carrier-handoff-recovery") return "carrier-slip-recovery";
  if (check === "cell-2-restage-recovery") return "cell-2-restage-recovery";
  return "nominal-handoff";
}

export type FinancierBakePhase =
  | "deposit-moulds"
  | "load-oven"
  | "convection-bake"
  | "unload-cool"
  | "completed"
  | "failed";

export type FinancierBakeRecipeConfig = Readonly<{
  mode: FinancierBakeMode;
  mouldCount: FinancierMouldCount;
  rackSlot: FinancierRackSlot;
  targetOvenTempC: number;
  portionG: number;
  check: FinancierBakeCheck;
}>;

export const DEFAULT_FINANCIER_BAKE_RECIPE: FinancierBakeRecipeConfig = {
  mode: "convection",
  mouldCount: 1,
  rackSlot: 3,
  targetOvenTempC: 170,
  portionG: 25,
  check: "none",
};

export type FinancierBakeOutcome =
  | Readonly<{
      kind: "completed";
      mouldCount: FinancierMouldCount;
      cavitiesFilled: number;
      depositedBatterG: number;
      retainedBatterG: number;
      evaporatedWaterG: number;
      bakedFinanciersG: number;
      pieceMassG: number;
      acceptedPieces: number;
      rackSlot: FinancierRackSlot;
      peakOvenTempC: number;
      finalCoreTempC: number;
      handoffRecovery: FinancierHandoffRecovery;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
    }>;

export type FinancierBakeSample = Readonly<{
  step: number;
  timeS: number;
  phase: FinancierBakePhase;
  stage: string;
  scale: Readonly<{
    displayedG: number;
    panDeflectionM: number;
    tared: boolean;
    mouldOnScale: boolean;
  }>;
  depositor: Readonly<{
    nozzlePosZUp: readonly [number, number, number];
    funnelBatterG: number;
    activeCavityIndex: number;
    pouringRateGS: number;
    cavityFillFractions: readonly number[];
  }>;
  mouldTray: Readonly<{
    trayPosZUp: readonly [number, number, number];
    mouldPosZUp: readonly [number, number, number];
    mouldCount: FinancierMouldCount;
    cavitiesFilled: number;
    depositedG: number;
    currentMassG: number;
    evaporatedG: number;
    bosseRise: number;
    crustBrowning: number;
    coreTempC: number;
  }>;
  oven: Readonly<{
    mode: FinancierBakeMode;
    rackSlot: FinancierRackSlot;
    rackHeightM: number;
    state: "idle" | "running" | "ready" | "fault";
    chamberTempC: number;
    targetTempC: number;
    doorAngleRad: number;
    handleAngleRad: number;
    fanRpm: number;
    lampActive: boolean;
    steamLossG: number;
  }>;
  cobot: Readonly<{
    toolZUp: readonly [number, number, number];
    wristPitchRad: number;
    fingerOpeningM: number;
    holding: "depositor" | "mould" | "carrier-tray" | "oven-handle" | "none";
  }>;
  outcome: FinancierBakeOutcome | null;
}>;

export type FinancierBakeTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

export function financierBakeTimelineStages(): readonly FinancierBakeTimelineStage[] {
  return [
    {
      id: "deposit-moulds",
      label: "1 · Ohaus Tare & Matsunaga 8P Cavity Dosing",
      startS: 0,
      endS: 16,
    },
    {
      id: "load-oven",
      label: "2 · Carrier Transfer & Maruzen MBCO-5E Rack Load",
      startS: 16,
      endS: 28,
    },
    {
      id: "convection-bake",
      label: "3 · MBCO-5E Bake · Bosse Rise & Maillard Crust",
      startS: 28,
      endS: 48,
    },
    {
      id: "unload-cool",
      label: "4 · Inspection, Unload & In-Mould Wire Grid Cool",
      startS: 48,
      endS: 60,
    },
  ];
}

export const RACK_SLOT_HEIGHT_M: Readonly<Record<FinancierRackSlot, number>> = {
  2: 0.269,
  3: 0.357,
  4: 0.445,
};

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
 * for Tier 2 · Financier Bake · Mould Depositing & Maruzen MBCO-5E Oven.
 */
export class FinancierBakeSimulationEngine {
  private stepCount = 0;
  private readonly dt = 0.04;
  private peakOvenTempC = 170;

  constructor(private readonly recipe: FinancierBakeRecipeConfig) {
    this.peakOvenTempC = recipe.targetOvenTempC;
  }

  initialSample(): FinancierBakeSample {
    return this.computeSample(0);
  }

  stepBatch(steps: number): readonly FinancierBakeSample[] {
    const out: FinancierBakeSample[] = [];
    for (let i = 0; i < steps; i++) {
      this.stepCount += 1;
      const sample = this.computeSample(this.stepCount * this.dt);
      out.push(sample);
      if (sample.outcome !== null) break;
    }
    return out;
  }

  private computeSample(t: number): FinancierBakeSample {
    const rackZ = RACK_SLOT_HEIGHT_M[this.recipe.rackSlot];

    // Workcell Z-up coordinates on the stainless patisserie bench (Z = 0 is bench top)
    // Ohaus Ranger 3000 scale on left: [-0.58, -0.18, 0.118]
    const scaleMouldZUp: readonly [number, number, number] = [
      -0.58,
      -0.18,
      0.118,
    ];
    // 600x400 mm carrier tray on cooling/staging wire grid in center-left: [-0.20, -0.18, 0.032]
    const stagingTrayZUp: readonly [number, number, number] = [
      -0.2,
      -0.18,
      0.032,
    ];
    // Maruzen MBCO-5E oven sits at [0.42, 0.04, 0], so its chamber center is at X = +0.32, Y = +0.027
    const ovenFrontEntryZUp: readonly [number, number, number] = [
      0.32,
      -0.46,
      rackZ,
    ];
    const ovenSlotChamberZUp: readonly [number, number, number] = [
      0.32,
      0.027,
      rackZ,
    ];
    const ovenHandleClosedZUp: readonly [number, number, number] = [
      0.55,
      -0.4,
      0.34,
    ];
    const ovenHandleOpenZUp: readonly [number, number, number] = [
      -0.06,
      -0.68,
      0.34,
    ];
    const depositorRestZUp: readonly [number, number, number] = [
      -0.58,
      0.14,
      0.16,
    ];
    const homeParkZUp: readonly [number, number, number] = [
      -0.38,
      0.08,
      0.38,
    ];

    const totalCavities = this.recipe.mouldCount * 8;
    const portionG = this.recipe.portionG;
    const targetDepositedG = Number((totalCavities * portionG).toFixed(1));
    const initialBatterPoolG = 726.0;
    const targetEvapG = Number((targetDepositedG * 0.06).toFixed(1)); // 6% bake moisture loss (12 g per 200 g load)

    let phase: FinancierBakePhase = "deposit-moulds";
    let stage =
      "Prepared Matsunaga 8P silicone-coated mould on Ohaus scale & preheated Maruzen MBCO-5E";

    let tared = true;
    let mouldOnScale = true;
    let displayedG = 0;
    let panDeflectionM = 0.0004;

    let nozzlePosZUp: readonly [number, number, number] = depositorRestZUp;
    let funnelBatterG = initialBatterPoolG;
    let activeCavityIndex = -1;
    let pouringRateGS = 0;
    const cavityFillFractions: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

    let trayPosZUp: readonly [number, number, number] = stagingTrayZUp;
    let mouldPosZUp: readonly [number, number, number] = scaleMouldZUp;
    let depositedG = 0;
    let evaporatedG = 0;
    let bosseRise = 0;
    let crustBrowning = 0;
    let coreTempC = 28.0;

    const baseTargetTempC =
      this.recipe.check === "under-preheated"
        ? 132.0
        : this.recipe.check === "over-baked"
          ? 204.0
          : this.recipe.targetOvenTempC;
    let ovenState: "idle" | "running" | "ready" | "fault" = "running";
    let chamberTempC = baseTargetTempC;
    let doorAngleRad = 0;
    let handleAngleRad = 0;
    let fanRpm = this.recipe.mode === "convection" ? 1450 : 0;
    let lampActive = true;

    let toolZUp: readonly [number, number, number] = homeParkZUp;
    const wristPitchRad = Math.PI * 0.46;
    let fingerOpeningM = 0.028;
    let holding:
      | "depositor"
      | "mould"
      | "carrier-tray"
      | "oven-handle"
      | "none" = "none";
    let outcome: FinancierBakeOutcome | null = null;

    // 8 cavity offsets relative to the 220x300 mm Matsunaga mould center (2 cols along X, 4 rows along Y)
    const cavityOffsets: readonly (readonly [number, number])[] = [
      [-0.048, -0.096],
      [0.048, -0.096],
      [-0.048, -0.032],
      [0.048, -0.032],
      [-0.048, 0.032],
      [0.048, 0.032],
      [-0.048, 0.096],
      [0.048, 0.096],
    ];

    if (t <= 0.0001) {
      this.peakOvenTempC = baseTargetTempC;
    } else if (t < 16.0) {
      // STAGE 1: Ohaus Tare & Confectionery Piston Funnel Dosing across 8 cavities (0..16 s)
      phase = "deposit-moulds";
      holding = "depositor";
      fingerOpeningM = 0.018;

      if (t < 1.2) {
        // Move depositor from rest stand to Cavity 1 over Ohaus scale
        const u = smoothstep(t / 1.2);
        const firstCavity: readonly [number, number, number] = [
          scaleMouldZUp[0] + cavityOffsets[0]![0],
          scaleMouldZUp[1] + cavityOffsets[0]![1],
          scaleMouldZUp[2] + 0.115,
        ];
        nozzlePosZUp = lerpVec3(depositorRestZUp, firstCavity, u);
        toolZUp = [nozzlePosZUp[0], nozzlePosZUp[1] + 0.03, nozzlePosZUp[2] + 0.06];
        stage = `FR10 positioning piston confectionery funnel over Matsunaga 8P Cavity 1 · Ohaus tared (0.0 g)`;
      } else if (t < 13.2) {
        // Dose all 8 visual cavities sequentially over 12.0 s (1.5 s per cavity)
        const doseElapsed = t - 1.2;
        const rawIdx = doseElapsed / 1.5;
        const cIdx = Math.min(7, Math.floor(rawIdx));
        const withinCavity = rawIdx - cIdx;
        activeCavityIndex = cIdx;

        for (let i = 0; i < 8; i++) {
          if (i < cIdx) {
            cavityFillFractions[i] = 1.0;
          } else if (i === cIdx) {
            cavityFillFractions[i] = clamp(withinCavity / 0.78, 0, 1);
          } else {
            cavityFillFractions[i] = 0;
          }
        }

        const currOffset = cavityOffsets[cIdx]!;
        const nextOffset = cavityOffsets[Math.min(7, cIdx + 1)]!;
        const moveFrac =
          withinCavity > 0.78 ? smoothstep((withinCavity - 0.78) / 0.22) : 0;
        const nx = lerp(currOffset[0], nextOffset[0], moveFrac);
        const ny = lerp(currOffset[1], nextOffset[1], moveFrac);

        nozzlePosZUp = [
          scaleMouldZUp[0] + nx,
          scaleMouldZUp[1] + ny,
          scaleMouldZUp[2] + 0.115,
        ];
        toolZUp = [nozzlePosZUp[0], nozzlePosZUp[1] + 0.03, nozzlePosZUp[2] + 0.06];

        const totalFillProgress =
          cavityFillFractions.reduce((acc, v) => acc + v, 0) / 8;
        depositedG = targetDepositedG * totalFillProgress;
        funnelBatterG = initialBatterPoolG - depositedG;
        displayedG = depositedG;
        panDeflectionM = 0.0004 + (depositedG / 600) * 0.0014;
        pouringRateGS = withinCavity <= 0.78 ? (portionG * this.recipe.mouldCount) / 1.17 : 0;

        stage = `Dosing ${portionG.toFixed(0)} g golden financier batter into Matsunaga cavity ${cIdx + 1} / 8 (78% depth · ${depositedG.toFixed(1)} g / ${targetDepositedG.toFixed(0)} g)`;
      } else {
        // 13.2..16.0 s: Return depositor funnel to stand, then transfer filled Matsunaga mould onto 600x400 mm carrier tray
        for (let i = 0; i < 8; i++) cavityFillFractions[i] = 1.0;
        depositedG = targetDepositedG;
        funnelBatterG = initialBatterPoolG - targetDepositedG;

        const sub = (t - 13.2) / 2.8;
        if (sub < 0.45) {
          const u = smoothstep(sub / 0.45);
          const lastCavity: readonly [number, number, number] = [
            scaleMouldZUp[0] + cavityOffsets[7]![0],
            scaleMouldZUp[1] + cavityOffsets[7]![1],
            scaleMouldZUp[2] + 0.092,
          ];
          nozzlePosZUp = lerpVec3(lastCavity, depositorRestZUp, u);
          toolZUp = [nozzlePosZUp[0], nozzlePosZUp[1] + 0.03, nozzlePosZUp[2] + 0.06];
          displayedG = targetDepositedG;
          panDeflectionM = 0.0016;
          stage = `All ${totalCavities} cavities filled (${targetDepositedG.toFixed(1)} g) · parking piston funnel`;
        } else {
          const u = smoothstep((sub - 0.45) / 0.55);
          nozzlePosZUp = depositorRestZUp;
          holding = "mould";
          mouldOnScale = false;
          displayedG = 0;
          panDeflectionM = 0;
          const base = lerpVec3(
            scaleMouldZUp,
            [stagingTrayZUp[0], stagingTrayZUp[1], stagingTrayZUp[2] + 0.006],
            u,
          );
          mouldPosZUp = [
            base[0],
            base[1],
            base[2] + Math.sin(u * Math.PI) * 0.065,
          ];
          toolZUp = [mouldPosZUp[0], mouldPosZUp[1], mouldPosZUp[2] + 0.045];
          stage =
            "FR10 seating filled Matsunaga 8P mould onto 600 × 400 mm Maruzen oven carrier";
        }
      }
    } else if (t < 28.0) {
      // STAGE 2: Unlatch & open Maruzen MBCO-5E door, load 600x400 mm carrier into rack slot, close door (16..28 s)
      phase = "load-oven";
      for (let i = 0; i < 8; i++) cavityFillFractions[i] = 1.0;
      depositedG = targetDepositedG;
      funnelBatterG = initialBatterPoolG - targetDepositedG;
      mouldOnScale = false;
      displayedG = 0;
      panDeflectionM = 0;

      const loadT = t - 16.0;
      if (loadT < 3.2) {
        // 16..19.2 s: Rotate handle & swing Maruzen MBCO-5E door open to 100 deg
        const u = smoothstep(loadT / 3.2);
        handleAngleRad = Math.sin(u * Math.PI) * 0.36;
        doorAngleRad = lerp(0, (100 * Math.PI) / 180, u);
        trayPosZUp = stagingTrayZUp;
        mouldPosZUp = [
          stagingTrayZUp[0],
          stagingTrayZUp[1],
          stagingTrayZUp[2] + 0.006,
        ];
        holding = "oven-handle";
        fingerOpeningM = 0.016;
        toolZUp = lerpVec3(ovenHandleClosedZUp, ovenHandleOpenZUp, u);
        chamberTempC = lerp(baseTargetTempC, baseTargetTempC - 8.0, u);

        if (this.recipe.check === "under-preheated" && loadT >= 2.6) {
          phase = "failed";
          ovenState = "fault";
          const reason = `Maruzen MBCO-5E chamber at ${chamberTempC.toFixed(1)} °C (< 155 °C readiness gate) — carrier load refused until preheat completes.`;
          stage = reason;
          outcome = { kind: "failed", reason };
        } else {
          stage = `FR10 releasing mbco_handle & opening Maruzen MBCO-5E door (${Math.round((doorAngleRad * 180) / Math.PI)}°)`;
        }
      } else if (loadT < 9.2) {
        // 19.2..25.2 s: Lift 600x400 mm carrier tray and slide along Slot rails into chamber
        doorAngleRad = (100 * Math.PI) / 180;
        handleAngleRad = 0;
        holding = "carrier-tray";
        fingerOpeningM = 0.022;
        const slideT = (loadT - 3.2) / 6.0;
        if (slideT < 0.45) {
          const u = smoothstep(slideT / 0.45);
          const base = lerpVec3(stagingTrayZUp, ovenFrontEntryZUp, u);
          trayPosZUp = [base[0], base[1], base[2] + Math.sin(u * Math.PI) * 0.04];
          stage = `Aligning 600 × 400 mm carrier with Maruzen MBCO-5E Slot ${this.recipe.rackSlot} rails (Z = ${(rackZ * 1000).toFixed(0)} mm)`;
        } else {
          const u = smoothstep((slideT - 0.45) / 0.55);
          trayPosZUp = lerpVec3(ovenFrontEntryZUp, ovenSlotChamberZUp, u);
          stage = `Sliding Matsunaga 8P carrier into Maruzen MBCO-5E Slot ${this.recipe.rackSlot} (414 mm upright gap · 7 mm side clearance)`;
        }
        mouldPosZUp = [trayPosZUp[0], trayPosZUp[1], trayPosZUp[2] + 0.006];
        toolZUp = [trayPosZUp[0] - 0.12, trayPosZUp[1] - 0.24, trayPosZUp[2] + 0.03];
        chamberTempC = lerp(baseTargetTempC - 8.0, baseTargetTempC - 14.0, slideT);
      } else {
        // 25.2..28.0 s: Retract arm and swing Maruzen MBCO-5E door closed
        const u = smoothstep((loadT - 9.2) / 2.8);
        trayPosZUp = ovenSlotChamberZUp;
        mouldPosZUp = [
          ovenSlotChamberZUp[0],
          ovenSlotChamberZUp[1],
          ovenSlotChamberZUp[2] + 0.006,
        ];
        doorAngleRad = lerp((100 * Math.PI) / 180, 0, u);
        handleAngleRad = Math.sin(u * Math.PI) * 0.32;
        holding = u < 0.85 ? "oven-handle" : "none";
        toolZUp = lerpVec3(ovenHandleOpenZUp, ovenHandleClosedZUp, u);
        chamberTempC = lerp(baseTargetTempC - 14.0, baseTargetTempC - 10.0, u);
        stage =
          "Closing Maruzen MBCO-5E double-glazed door · starting 12–15 min bake program";
      }
    } else if (t < 48.0) {
      // STAGE 3: Convection Bake · Central Bosse Rise & Hazelnut-Gold Maillard Crust (28..48 s)
      phase = "convection-bake";
      for (let i = 0; i < 8; i++) cavityFillFractions[i] = 1.0;
      depositedG = targetDepositedG;
      funnelBatterG = initialBatterPoolG - targetDepositedG;
      mouldOnScale = false;
      displayedG = 0;
      panDeflectionM = 0;
      trayPosZUp = ovenSlotChamberZUp;
      mouldPosZUp = [
        ovenSlotChamberZUp[0],
        ovenSlotChamberZUp[1],
        ovenSlotChamberZUp[2] + 0.006,
      ];
      doorAngleRad = 0;
      handleAngleRad = 0;
      holding = "none";

      const bakeU = clamp((t - 28.0) / 20.0, 0, 1);
      toolZUp = lerpVec3(
        ovenHandleClosedZUp,
        homeParkZUp,
        smoothstep(clamp((t - 28.0) / 3.0, 0, 1)),
      );

      // Chamber temperature recovers from door-open dip (-10 °C) back to target
      const recoveryU = smoothstep(clamp(bakeU / 0.35, 0, 1));
      chamberTempC = lerp(baseTargetTempC - 10.0, baseTargetTempC, recoveryU);
      this.peakOvenTempC = Math.max(this.peakOvenTempC, chamberTempC);

      // Bosse hump rises strongly during first 65% of bake as steam expands under set rim
      bosseRise = smoothstep(clamp((bakeU - 0.08) / 0.65, 0, 1));
      // Crust Maillard browning accelerates in second half of bake
      crustBrowning =
        this.recipe.check === "over-baked"
          ? clamp(smoothstep((bakeU - 0.12) / 0.72) * 1.35, 0, 1.35)
          : smoothstep(clamp((bakeU - 0.18) / 0.82, 0, 1));
      evaporatedG = targetEvapG * smoothstep(bakeU);
      coreTempC = lerp(28.0, this.recipe.check === "over-baked" ? 106.0 : 96.4, smoothstep(bakeU));

      if (this.recipe.check === "over-baked" && t >= 47.2) {
        phase = "failed";
        ovenState = "fault";
        const reason = `First inspection window rejected load at ${chamberTempC.toFixed(0)} °C — scorched financier rims and bitter Maillard crust (${(targetDepositedG - evaporatedG).toFixed(1)} g sent to reject lot).`;
        stage = reason;
        outcome = { kind: "failed", reason };
      } else if (bakeU < 0.5) {
        stage = `Maruzen MBCO-5E ${this.recipe.mode} bake (${chamberTempC.toFixed(1)} °C) · edge setting & central bosse hump rising (${Math.round(bosseRise * 100)}%)`;
      } else {
        stage = `Maillard crust browning (${Math.round(Math.min(1, crustBrowning) * 100)}%) · ${evaporatedG.toFixed(1)} g moisture evaporated (core ${coreTempC.toFixed(1)} °C)`;
      }
    } else {
      // STAGE 4: First Inspection Window, Unload Carrier to Wire Cooling Grid & Complete (48..60 s)
      const endT = clamp(t - 48.0, 0, 12.0);
      for (let i = 0; i < 8; i++) cavityFillFractions[i] = 1.0;
      depositedG = targetDepositedG;
      funnelBatterG = initialBatterPoolG - targetDepositedG;
      mouldOnScale = false;
      displayedG = 0;
      panDeflectionM = 0;
      evaporatedG = targetEvapG;
      bosseRise = 1.0;
      crustBrowning = 1.0;
      fanRpm = 0;
      ovenState = "ready";

      if (endT < 2.6) {
        // Open Maruzen MBCO-5E door for inspection & extraction
        phase = "unload-cool";
        const u = smoothstep(endT / 2.6);
        handleAngleRad = Math.sin(u * Math.PI) * 0.36;
        doorAngleRad = lerp(0, (100 * Math.PI) / 180, u);
        trayPosZUp = ovenSlotChamberZUp;
        mouldPosZUp = [
          ovenSlotChamberZUp[0],
          ovenSlotChamberZUp[1],
          ovenSlotChamberZUp[2] + 0.006,
        ];
        holding = "oven-handle";
        toolZUp = lerpVec3(homeParkZUp, ovenHandleOpenZUp, u);
        coreTempC = 96.4;
        chamberTempC = lerp(baseTargetTempC, baseTargetTempC - 9.0, u);
        stage =
          "12–15 min inspection window passed · FR10 opening Maruzen MBCO-5E door for carrier unload";
      } else if (endT < 8.4) {
        // Slide 600x400 mm carrier out of Slot and set onto wire cooling grid
        phase = "unload-cool";
        doorAngleRad = (100 * Math.PI) / 180;
        handleAngleRad = 0;
        holding = "carrier-tray";
        const u = smoothstep((endT - 2.6) / 5.8);
        const handoffPreset = handoffPresetForBakeCheck(this.recipe.check);
        const isRecoveryPreset = handoffPreset !== "nominal-handoff";
        const slipMeters =
          handoffPreset === "cell-2-restage-recovery" ? 0.018 : 0.014;
        if (u < 0.5) {
          const s = smoothstep(u / 0.5);
          trayPosZUp = lerpVec3(ovenSlotChamberZUp, ovenFrontEntryZUp, s);
          stage = `Extracting ${(targetDepositedG - targetEvapG).toFixed(1)} g baked financiers (${totalCavities} pieces @ 23.5 g) from Maruzen MBCO-5E Slot ${this.recipe.rackSlot}`;
        } else if (isRecoveryPreset && u < 0.78) {
          const s = smoothstep((u - 0.5) / 0.28);
          const base = lerpVec3(ovenFrontEntryZUp, stagingTrayZUp, s);
          const slipY = Math.sin(s * Math.PI) * slipMeters;
          trayPosZUp = [base[0], base[1] + slipY, base[2] + 0.018];
          stage = `Carrier rail slip detected (+${Math.round(slipMeters * 1000)} mm lateral offset at handoff datum) · FR10 engaging closed-loop clamp recovery`;
        } else if (isRecoveryPreset) {
          const s = smoothstep((u - 0.78) / 0.22);
          const slippedPose: readonly [number, number, number] = [
            stagingTrayZUp[0],
            stagingTrayZUp[1] + slipMeters * (1 - s),
            stagingTrayZUp[2] + (1 - s) * 0.014,
          ];
          trayPosZUp = slippedPose;
          stage =
            handoffPreset === "cell-2-restage-recovery"
              ? "FR10 re-registering 600 × 400 mm carrier datum (0.0 mm) · preparing Cell 1 → Cell 2 restage failover (+60 s re-registration · 120 s hold release)"
              : "FR10 re-seating 600 × 400 mm carrier on wire cooling grid datum (0.0 mm residual offset · +45 s Tier 3 cell handoff buffer)";
        } else {
          const s = smoothstep((u - 0.5) / 0.5);
          const base = lerpVec3(ovenFrontEntryZUp, stagingTrayZUp, s);
          trayPosZUp = [base[0], base[1], base[2] + Math.sin(s * Math.PI) * 0.04];
          stage = `Extracting ${(targetDepositedG - targetEvapG).toFixed(1)} g baked financiers (${totalCavities} pieces @ 23.5 g) to wire cooling grid`;
        }
        mouldPosZUp = [trayPosZUp[0], trayPosZUp[1], trayPosZUp[2] + 0.006];
        toolZUp = [trayPosZUp[0] - 0.12, trayPosZUp[1] - 0.24, trayPosZUp[2] + 0.03];
        coreTempC = lerp(96.4, 88.0, u);
        chamberTempC = baseTargetTempC - 12.0;
      } else {
        // Close oven door and park arm while financiers cool 2–3 min in mould before demoulding
        const u = smoothstep((endT - 8.4) / 3.6);
        trayPosZUp = stagingTrayZUp;
        mouldPosZUp = [
          stagingTrayZUp[0],
          stagingTrayZUp[1],
          stagingTrayZUp[2] + 0.006,
        ];
        doorAngleRad = lerp((100 * Math.PI) / 180, 0, u);
        handleAngleRad = Math.sin(u * Math.PI) * 0.28;
        holding = u < 0.7 ? "oven-handle" : "none";
        toolZUp = lerpVec3(ovenHandleOpenZUp, homeParkZUp, u);
        coreTempC = lerp(88.0, 82.4, u);
        chamberTempC = lerp(baseTargetTempC - 12.0, baseTargetTempC - 6.0, u);
        ovenState = u >= 0.95 ? "idle" : "ready";
        lampActive = u < 0.95;

        const bakedFinanciersG = Number(
          (targetDepositedG - targetEvapG).toFixed(1),
        );
        const pieceMassG = Number((bakedFinanciersG / totalCavities).toFixed(1));
        const handoffRecovery = buildFinancierHandoffRecovery(
          handoffPresetForBakeCheck(this.recipe.check),
        );

        if (t >= 60.0 - 1e-6) {
          phase = "completed";
          stage =
            handoffRecovery.preset === "nominal-handoff"
              ? `Bake & unload complete · ${bakedFinanciersG} g across ${totalCavities} golden financiers (${pieceMassG} g/pc · ${targetEvapG} g steam loss) cooling in mould`
              : `Bake & fault-recovery handoff calibrated · ${bakedFinanciersG} g (${totalCavities} pcs @ ${pieceMassG} g) · ${handoffRecovery.summary}`;
          outcome = {
            kind: "completed",
            mouldCount: this.recipe.mouldCount,
            cavitiesFilled: totalCavities,
            depositedBatterG: targetDepositedG,
            retainedBatterG: Number(
              (initialBatterPoolG - targetDepositedG).toFixed(1),
            ),
            evaporatedWaterG: targetEvapG,
            bakedFinanciersG,
            pieceMassG,
            acceptedPieces: totalCavities,
            rackSlot: this.recipe.rackSlot,
            peakOvenTempC: Number(this.peakOvenTempC.toFixed(1)),
            finalCoreTempC: Number(coreTempC.toFixed(1)),
            handoffRecovery,
          };
        } else {
          phase = "unload-cool";
          stage =
            handoffRecovery.preset === "nominal-handoff"
              ? "Closing Maruzen MBCO-5E door · 2–3 min in-mould cooling on wire grid before demoulding"
              : `Closing Maruzen MBCO-5E door · carrier datum verified (${handoffRecovery.slipLateralMm} mm slip recovered · ${handoffRecovery.coolingBufferMin} min cooling buffer for Tier 3 cell handoff)`;
        }
      }
    }

    const currentMassG = Math.max(0, depositedG - evaporatedG);

    return {
      step: this.stepCount,
      timeS: Number(t.toFixed(3)),
      phase,
      stage,
      scale: {
        displayedG: Number(displayedG.toFixed(1)),
        panDeflectionM: Number(panDeflectionM.toFixed(5)),
        tared,
        mouldOnScale,
      },
      depositor: {
        nozzlePosZUp,
        funnelBatterG: Number(funnelBatterG.toFixed(1)),
        activeCavityIndex,
        pouringRateGS: Number(pouringRateGS.toFixed(1)),
        cavityFillFractions: cavityFillFractions.map((v) =>
          Number(v.toFixed(3)),
        ),
      },
      mouldTray: {
        trayPosZUp,
        mouldPosZUp,
        mouldCount: this.recipe.mouldCount,
        cavitiesFilled: totalCavities,
        depositedG: Number(depositedG.toFixed(1)),
        currentMassG: Number(currentMassG.toFixed(1)),
        evaporatedG: Number(evaporatedG.toFixed(1)),
        bosseRise: Number(bosseRise.toFixed(3)),
        crustBrowning: Number(crustBrowning.toFixed(3)),
        coreTempC: Number(coreTempC.toFixed(1)),
      },
      oven: {
        mode: this.recipe.mode,
        rackSlot: this.recipe.rackSlot,
        rackHeightM: rackZ,
        state: ovenState,
        chamberTempC: Number(chamberTempC.toFixed(1)),
        targetTempC: baseTargetTempC,
        doorAngleRad: Number(doorAngleRad.toFixed(4)),
        handleAngleRad: Number(handleAngleRad.toFixed(4)),
        fanRpm,
        lampActive,
        steamLossG: Number(evaporatedG.toFixed(1)),
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
