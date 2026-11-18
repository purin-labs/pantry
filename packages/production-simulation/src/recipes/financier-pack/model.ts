export type FinancierPackLoadPreset = "single-load-8" | "two-accepted-16";
export type FinancierBoxStyle = "patisserie-8" | "atelier-15";
export type FinancierPackCheck = "none" | "warm-demould" | "underweight-box";

export type FinancierPackPhase =
  | "cool-demould"
  | "crumb-check"
  | "pack-giftbox"
  | "seal-release"
  | "completed"
  | "failed";

export type FinancierPackRecipeConfig = Readonly<{
  loadPreset: FinancierPackLoadPreset;
  boxStyle: FinancierBoxStyle;
  coolingMinutes: number;
  crumbSamplePieces: 0 | 1;
  check: FinancierPackCheck;
}>;

export const DEFAULT_FINANCIER_PACK_RECIPE: FinancierPackRecipeConfig = {
  loadPreset: "two-accepted-16",
  boxStyle: "atelier-15",
  coolingMinutes: 10,
  crumbSamplePieces: 1,
  check: "none",
};

export type FinancierPackOutcome =
  | Readonly<{
      kind: "completed";
      bakedPiecesIn: number;
      rejectedBakePieces: number;
      demouldedPieces: number;
      crumbSamplePieces: number;
      crumbSampleG: number;
      packedPieces: number;
      packedNetMassG: number;
      pieceMassG: number;
      mouldsReleasedToWash: number;
      finalCoreTempC: number;
    }>
  | Readonly<{
      kind: "failed";
      reason: string;
    }>;

export type FinancierPackSample = Readonly<{
  step: number;
  timeS: number;
  phase: FinancierPackPhase;
  stage: string;
  scale: Readonly<{
    displayedG: number;
    panDeflectionM: number;
    tared: boolean;
    itemOnScale: "none" | "crumb-sample" | "gift-box";
  }>;
  coolingGrid: Readonly<{
    mouldPosZUp: readonly [number, number, number];
    mouldRollRad: number;
    mouldDemoulded: boolean;
    mouldInWashTray: boolean;
    gridPiecesRemaining: number;
    coreTempC: number;
  }>;
  crumbCheck: Readonly<{
    sampled: boolean;
    sampleCutOpen: boolean;
    sampleMassG: number;
    samplePosZUp: readonly [number, number, number];
  }>;
  giftBox: Readonly<{
    boxStyle: FinancierBoxStyle;
    targetCapacity: number;
    packedCount: number;
    packedNetG: number;
    activePiecePosZUp: readonly [number, number, number] | null;
    lidClosedProgress: number;
    ribbonProgress: number;
    released: boolean;
  }>;
  cobot: Readonly<{
    toolZUp: readonly [number, number, number];
    wristPitchRad: number;
    fingerOpeningM: number;
    holding:
      | "mould"
      | "crumb-piece"
      | "financier-piece"
      | "box-lid"
      | "ribbon"
      | "none";
  }>;
  outcome: FinancierPackOutcome | null;
}>;

export type FinancierPackTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

export function financierPackTimelineStages(): readonly FinancierPackTimelineStage[] {
  return [
    {
      id: "cool-demould",
      label: "1 · Wire-Grid Cool & Matsunaga 8P Demould",
      startS: 0,
      endS: 14,
    },
    {
      id: "crumb-check",
      label: "2 · 10-Min Crumb Check & Ohaus Check-Weigh",
      startS: 14,
      endS: 26,
    },
    {
      id: "pack-giftbox",
      label: "3 · Patisserie Gift-Box Array & Net Weigh",
      startS: 26,
      endS: 44,
    },
    {
      id: "seal-release",
      label: "4 · Lid Closure, Gold Satin Ribbon & Release",
      startS: 44,
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
 * Deterministic thermodynamic, mass-balance, and kinematic simulation engine
 * for Tier 2 · Financier Cooling, Demoulding & Gift-Box Packing.
 */
export class FinancierPackSimulationEngine {
  private stepCount = 0;
  private readonly dt = 0.04;

  constructor(private readonly recipe: FinancierPackRecipeConfig) {}

  initialSample(): FinancierPackSample {
    return this.computeSample(0);
  }

  stepBatch(steps: number): readonly FinancierPackSample[] {
    const out: FinancierPackSample[] = [];
    for (let i = 0; i < steps; i++) {
      this.stepCount += 1;
      const sample = this.computeSample(this.stepCount * this.dt);
      out.push(sample);
      if (sample.outcome !== null) break;
    }
    return out;
  }

  private computeSample(t: number): FinancierPackSample {
    // Z-up coordinates on the stainless patisserie packing table (Z = 0 is bench top)
    // Wire cooling grid with Matsunaga 8P mould on left: [-0.46, -0.14, 0.032]
    const gridMouldZUp: readonly [number, number, number] = [
      -0.46,
      -0.14,
      0.036,
    ];
    // Manual-care wash tray in rear-left: [-0.52, 0.22, 0.028]
    const washTrayZUp: readonly [number, number, number] = [
      -0.52,
      0.22,
      0.028,
    ];
    // Crumb inspection plate at front-center: [-0.06, -0.22, 0.018]
    const crumbPlateZUp: readonly [number, number, number] = [
      -0.06,
      -0.22,
      0.018,
    ];
    // Ohaus Ranger 3000 check-weighing & gift-box packing scale on right: [0.36, -0.14, 0.118]
    const scalePanZUp: readonly [number, number, number] = [
      0.36,
      -0.14,
      0.118,
    ];
    const homeParkZUp: readonly [number, number, number] = [
      -0.12,
      0.12,
      0.38,
    ];

    const pieceMassG = 23.5;
    const isTwoLoad = this.recipe.loadPreset === "two-accepted-16";
    const bakedPiecesIn = isTwoLoad ? 24 : 8;
    const rejectedBakePieces = isTwoLoad ? 8 : 0;
    const demouldedPieces = isTwoLoad ? 16 : 8;
    const crumbSamplePieces = this.recipe.crumbSamplePieces;
    const crumbSampleG = Number((crumbSamplePieces * pieceMassG).toFixed(1));
    const targetPackedPieces = demouldedPieces - crumbSamplePieces;
    const targetPackedNetG = Number(
      (targetPackedPieces * pieceMassG).toFixed(1),
    );
    const mouldsReleasedToWash = isTwoLoad ? 2 : 1;

    let phase: FinancierPackPhase = "cool-demould";
    let stage =
      "Baked Matsunaga 8P financier load staged on wire cooling grid · Ohaus Ranger 3000 tared";

    let displayedG = 0;
    let panDeflectionM = 0;
    let tared = true;
    let itemOnScale: "none" | "crumb-sample" | "gift-box" = "none";

    let mouldPosZUp: readonly [number, number, number] = gridMouldZUp;
    let mouldRollRad = 0;
    let mouldDemoulded = false;
    let mouldInWashTray = false;
    let gridPiecesRemaining = demouldedPieces;
    let coreTempC = 82.4;

    let sampled = false;
    let sampleCutOpen = false;
    let sampleMassG = 0;
    let samplePosZUp: readonly [number, number, number] = gridMouldZUp;

    let packedCount = 0;
    let packedNetG = 0;
    let activePiecePosZUp: readonly [number, number, number] | null = null;
    let lidClosedProgress = 0;
    let ribbonProgress = 0;
    let released = false;

    let toolZUp: readonly [number, number, number] = homeParkZUp;
    const wristPitchRad = Math.PI * 0.46;
    let fingerOpeningM = 0.028;
    let holding:
      | "mould"
      | "crumb-piece"
      | "financier-piece"
      | "box-lid"
      | "ribbon"
      | "none" = "none";
    let outcome: FinancierPackOutcome | null = null;

    if (t <= 0.0001) {
      // Initial review state at t = 0
    } else if (t < 14.0) {
      // STAGE 1: 2–3 Min In-Mould Cooling, Invert Demould onto Wire Grid & Release Mould to Manual Wash (0..14 s)
      phase = "cool-demould";
      const uStage = t / 14.0;
      coreTempC =
        this.recipe.check === "warm-demould"
          ? lerp(82.4, 71.0, uStage)
          : lerp(82.4, 42.0, smoothstep(uStage));

      if (t < 4.5) {
        // Approach Matsunaga 8P mould after 2–3 min in-mould set
        const u = smoothstep(t / 4.5);
        toolZUp = lerpVec3(homeParkZUp, [gridMouldZUp[0], gridMouldZUp[1], gridMouldZUp[2] + 0.055], u);
        fingerOpeningM = lerp(0.03, 0.018, u);
        stage = `2–3 min in-mould cooling on wire grid (core ${coreTempC.toFixed(1)} °C) · FR10 gripping Matsunaga 8P flange`;
      } else if (t < 9.5) {
        // Lift & invert Matsunaga 8P mould 180 deg to release golden financiers onto wire grid
        const u = smoothstep((t - 4.5) / 5.0);
        holding = "mould";
        fingerOpeningM = 0.016;
        mouldPosZUp = [
          gridMouldZUp[0],
          gridMouldZUp[1],
          gridMouldZUp[2] + Math.sin(u * Math.PI) * 0.11 + 0.03,
        ];
        mouldRollRad = u * Math.PI;
        mouldDemoulded = u >= 0.55;
        toolZUp = [mouldPosZUp[0], mouldPosZUp[1], mouldPosZUp[2] + 0.045];

        if (this.recipe.check === "warm-demould" && u >= 0.65) {
          phase = "failed";
          const reason = `Warm demoulding attempted at ${coreTempC.toFixed(1)} °C (> 55 °C release limit) — fragile bosse crowns tore before structure set.`;
          stage = reason;
          outcome = { kind: "failed", reason };
        } else {
          stage = `FR10 inverting silicone-coated Matsunaga 8P mould (${Math.round(u * 180)}°) · releasing ${demouldedPieces} golden financiers (${(demouldedPieces * pieceMassG).toFixed(1)} g)`;
        }
      } else {
        // Place empty Matsunaga 8P mould into manual-care wash tray (no Winterhalter dishwasher cycle)
        const u = smoothstep((t - 9.5) / 4.5);
        holding = u < 0.88 ? "mould" : "none";
        mouldDemoulded = true;
        mouldRollRad = lerp(Math.PI, 0, u);
        const base = lerpVec3(
          [gridMouldZUp[0], gridMouldZUp[1], gridMouldZUp[2] + 0.03],
          washTrayZUp,
          u,
        );
        mouldPosZUp = [base[0], base[1], base[2] + Math.sin(u * Math.PI) * 0.08];
        mouldInWashTray = u >= 0.85;
        toolZUp = [mouldPosZUp[0], mouldPosZUp[1], mouldPosZUp[2] + 0.05];
        stage = `Demould complete · staging ${mouldsReleasedToWash} × Matsunaga 8P mould in manual-care wash basin for reuse`;
      }
    } else if (t < 26.0) {
      // STAGE 2: 10-Minute Crumb Check & Ohaus Ranger 3000 Piece Verification (14..26 s)
      phase = "crumb-check";
      mouldDemoulded = true;
      mouldInWashTray = true;
      mouldPosZUp = washTrayZUp;
      const cT = t - 14.0;
      coreTempC = lerp(42.0, 28.5, smoothstep(cT / 12.0));

      if (crumbSamplePieces === 0) {
        toolZUp = homeParkZUp;
        stage = `10-min wire-grid cooling complete (core ${coreTempC.toFixed(1)} °C) · crumb sample skipped (${demouldedPieces} pcs ready)`;
      } else if (cT < 4.5) {
        // Pick 1 x 23.5 g financier from wire grid and place on Ohaus Ranger 3000 scale
        const u = smoothstep(cT / 4.5);
        holding = "crumb-piece";
        fingerOpeningM = 0.016;
        const base = lerpVec3(gridMouldZUp, scalePanZUp, u);
        samplePosZUp = [base[0], base[1], base[2] + Math.sin(u * Math.PI) * 0.09];
        toolZUp = [samplePosZUp[0], samplePosZUp[1], samplePosZUp[2] + 0.045];
        gridPiecesRemaining = demouldedPieces - 1;
        stage =
          "FR10 transferring 1 financier from cooling grid to Ohaus Ranger 3000 for 23.5 g piece-mass verification";
      } else if (cT < 8.5) {
        // Weigh 23.5 g piece on Ohaus scale, then move to crumb-check plate
        const u = smoothstep((cT - 4.5) / 4.0);
        gridPiecesRemaining = demouldedPieces - 1;
        sampled = true;
        sampleMassG = 23.5;
        if (u < 0.55) {
          itemOnScale = "crumb-sample";
          displayedG = 23.5;
          panDeflectionM = 0.0005;
          samplePosZUp = scalePanZUp;
          toolZUp = [scalePanZUp[0], scalePanZUp[1], scalePanZUp[2] + 0.08];
          stage =
            "Ohaus Ranger 3000 verified 23.5 g baked financier (25.0 g fill − 1.5 g steam loss = 6.0% bake loss)";
        } else {
          const s = smoothstep((u - 0.55) / 0.45);
          holding = "crumb-piece";
          const base = lerpVec3(scalePanZUp, crumbPlateZUp, s);
          samplePosZUp = [base[0], base[1], base[2] + Math.sin(s * Math.PI) * 0.06];
          toolZUp = [samplePosZUp[0], samplePosZUp[1], samplePosZUp[2] + 0.045];
          stage =
            "Moving 23.5 g verification piece to inspection plate for 10-minute internal crumb check";
        }
      } else {
        // Halve sample on inspection plate to verify moist honeycombed beurre noisette crumb
        const u = smoothstep((cT - 8.5) / 3.5);
        gridPiecesRemaining = demouldedPieces - 1;
        sampled = true;
        sampleCutOpen = u >= 0.35;
        sampleMassG = 23.5;
        samplePosZUp = crumbPlateZUp;
        toolZUp = [
          crumbPlateZUp[0],
          crumbPlateZUp[1],
          crumbPlateZUp[2] + 0.05 + u * 0.06,
        ];
        stage = `10-minute crumb check accepted · moist honeycombed hazelnut-butter interior at ${coreTempC.toFixed(1)} °C (${targetPackedPieces} pcs released for packing)`;
      }
    } else if (t < 44.0) {
      // STAGE 3: Patisserie Gift-Box Array & Net Weigh on Ohaus Scale (26..44 s)
      phase = "pack-giftbox";
      mouldDemoulded = true;
      mouldInWashTray = true;
      mouldPosZUp = washTrayZUp;
      sampled = crumbSamplePieces > 0;
      sampleCutOpen = sampled;
      sampleMassG = crumbSampleG;
      samplePosZUp = crumbPlateZUp;
      coreTempC = 26.8;
      itemOnScale = "gift-box";
      tared = true;

      const packElapsed = t - 26.0;
      const visualSlots = 8;
      const slotDuration = 18.0 / visualSlots;
      const slotIdx = Math.min(
        visualSlots - 1,
        Math.floor(packElapsed / slotDuration),
      );
      const withinSlot = (packElapsed - slotIdx * slotDuration) / slotDuration;

      const completedFrac = clamp(
        (slotIdx + clamp(withinSlot / 0.82, 0, 1)) / visualSlots,
        0,
        1,
      );
      packedCount = Math.min(
        targetPackedPieces,
        Math.max(1, Math.round(completedFrac * targetPackedPieces)),
      );
      gridPiecesRemaining = Math.max(
        0,
        demouldedPieces - crumbSamplePieces - packedCount,
      );

      const effectiveNetG =
        this.recipe.check === "underweight-box"
          ? (targetPackedPieces - 1) * pieceMassG
          : targetPackedNetG;
      packedNetG = Number((effectiveNetG * completedFrac).toFixed(1));
      displayedG = packedNetG;
      panDeflectionM = 0.0006 + (packedNetG / 400) * 0.0014;

      // Interpolate active financier piece from cooling grid to gift box slot on Ohaus scale
      const slotCol = slotIdx % 4;
      const slotRow = Math.floor(slotIdx / 4);
      const destZUp: readonly [number, number, number] = [
        scalePanZUp[0] - 0.066 + slotCol * 0.044,
        scalePanZUp[1] - 0.028 + slotRow * 0.056,
        scalePanZUp[2] + 0.022,
      ];
      const uFlight = smoothstep(clamp(withinSlot / 0.85, 0, 1));
      const base = lerpVec3(gridMouldZUp, destZUp, uFlight);
      const arc: readonly [number, number, number] = [
        base[0],
        base[1],
        base[2] + Math.sin(uFlight * Math.PI) * 0.095,
      ];
      activePiecePosZUp = withinSlot < 0.88 ? arc : null;
      holding = withinSlot < 0.88 ? "financier-piece" : "none";
      fingerOpeningM = withinSlot < 0.88 ? 0.015 : 0.026;
      toolZUp = [arc[0], arc[1], arc[2] + 0.045];

      stage = `FR10 arraying financier ${packedCount} / ${targetPackedPieces} into fluted gold ballotin on Ohaus scale (${packedNetG.toFixed(1)} g / ${targetPackedNetG.toFixed(1)} g)`;
    } else {
      // STAGE 4: Lid Closure, Gold Satin Ribbon Band & Final Release Check (44..56 s)
      const endT = clamp(t - 44.0, 0, 12.0);
      mouldDemoulded = true;
      mouldInWashTray = true;
      mouldPosZUp = washTrayZUp;
      sampled = crumbSamplePieces > 0;
      sampleCutOpen = sampled;
      sampleMassG = crumbSampleG;
      samplePosZUp = crumbPlateZUp;
      gridPiecesRemaining = 0;
      coreTempC = 25.4;
      itemOnScale = "gift-box";
      packedCount = targetPackedPieces;
      packedNetG =
        this.recipe.check === "underweight-box"
          ? Number(((targetPackedPieces - 1) * pieceMassG).toFixed(1))
          : targetPackedNetG;
      displayedG = packedNetG;
      panDeflectionM = 0.0018;

      if (this.recipe.check === "underweight-box" && endT >= 3.2) {
        phase = "failed";
        const reason = `Ohaus Ranger 3000 net check-weight ${packedNetG.toFixed(1)} g is 23.5 g below ${targetPackedNetG.toFixed(1)} g release specification (${targetPackedPieces - 1} / ${targetPackedPieces} pieces) — gift box held from release.`;
        stage = reason;
        outcome = { kind: "failed", reason };
      } else if (endT < 5.0) {
        // Seat embossed ivory patisserie box lid
        phase = "seal-release";
        const u = smoothstep(endT / 5.0);
        lidClosedProgress = u;
        holding = "box-lid";
        fingerOpeningM = 0.022;
        const lidStart: readonly [number, number, number] = [
          0.36,
          0.18,
          0.16,
        ];
        const lidEnd: readonly [number, number, number] = [
          scalePanZUp[0],
          scalePanZUp[1],
          scalePanZUp[2] + 0.042,
        ];
        toolZUp = lerpVec3(lidStart, lidEnd, u);
        stage = `Seating embossed patisserie gift-box lid over ${targetPackedPieces} golden financiers (${packedNetG.toFixed(1)} g net)`;
      } else if (endT < 9.5) {
        // Wrap gold satin ribbon band & bow
        phase = "seal-release";
        lidClosedProgress = 1.0;
        const u = smoothstep((endT - 5.0) / 4.5);
        ribbonProgress = u;
        holding = "ribbon";
        fingerOpeningM = 0.014;
        toolZUp = [
          scalePanZUp[0] + Math.sin(u * Math.PI * 2) * 0.06,
          scalePanZUp[1],
          scalePanZUp[2] + 0.055,
        ];
        stage =
          "Fastening gold satin patisserie ribbon & lot seal around closed ballotin";
      } else {
        // Park Cobot arm and issue Plan 61A packaging release receipt
        const u = smoothstep((endT - 9.5) / 2.5);
        lidClosedProgress = 1.0;
        ribbonProgress = 1.0;
        released = true;
        holding = "none";
        toolZUp = lerpVec3(
          [scalePanZUp[0], scalePanZUp[1], scalePanZUp[2] + 0.08],
          homeParkZUp,
          u,
        );

        if (t >= 56.0 - 1e-6) {
          phase = "completed";
          stage = `Packaging release complete · ${packedCount} financiers (${packedNetG.toFixed(1)} g net) sealed in gift box, ${crumbSampleG.toFixed(1)} g crumb sample, ${mouldsReleasedToWash} mould(s) in wash`;
          outcome = {
            kind: "completed",
            bakedPiecesIn,
            rejectedBakePieces,
            demouldedPieces,
            crumbSamplePieces,
            crumbSampleG,
            packedPieces: packedCount,
            packedNetMassG: packedNetG,
            pieceMassG,
            mouldsReleasedToWash,
            finalCoreTempC: coreTempC,
          };
        } else {
          phase = "seal-release";
          stage = `Ohaus Ranger 3000 final net weight ${packedNetG.toFixed(1)} g verified · parking FR10 arm`;
        }
      }
    }

    return {
      step: this.stepCount,
      timeS: Number(t.toFixed(3)),
      phase,
      stage,
      scale: {
        displayedG: Number(displayedG.toFixed(1)),
        panDeflectionM: Number(panDeflectionM.toFixed(5)),
        tared,
        itemOnScale,
      },
      coolingGrid: {
        mouldPosZUp,
        mouldRollRad: Number(mouldRollRad.toFixed(4)),
        mouldDemoulded,
        mouldInWashTray,
        gridPiecesRemaining,
        coreTempC: Number(coreTempC.toFixed(1)),
      },
      crumbCheck: {
        sampled,
        sampleCutOpen,
        sampleMassG: Number(sampleMassG.toFixed(1)),
        samplePosZUp,
      },
      giftBox: {
        boxStyle: this.recipe.boxStyle,
        targetCapacity: targetPackedPieces,
        packedCount,
        packedNetG: Number(packedNetG.toFixed(1)),
        activePiecePosZUp,
        lidClosedProgress: Number(lidClosedProgress.toFixed(3)),
        ribbonProgress: Number(ribbonProgress.toFixed(3)),
        released,
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
