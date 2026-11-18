import { assertNever } from "@seams/std";
import type { GrinderModel } from "../../native/cell-adapter.ts";
import type { TravelRoute } from "../../scenario.ts";
import type { CarryoverMiseEnPlaceLot } from "./mise-en-place.ts";

export type BakeryShiftInput = Readonly<{
  financierLoads: number;
  milkTeaBatches: number;
  customTravel?: readonly TravelRoute[];
}>;

export type BakeryShiftOptions = Readonly<{
  /** 8-cavity loads of each of the four financier flavours. */
  financierLoads: number;
  /** Pies of each type (steak and pepper, beef bourguignon), trays of three. */
  piesPerType: 0 | 3 | 6;
  financierWaves: 1 | 2 | 3;
  waveIntervalMinutes: number;
  /**
   * Minimum shelf units per financier flavour at a replenishment boundary
   * before a stock-driven controller suppresses the next wave.
   */
  reorderThresholdUnits?: number;
  /**
   * Verified refrigerated lots and completion timestamps carried over from the
   * previous afternoon prep run.
   */
  carryoverMiseEnPlace?: readonly CarryoverMiseEnPlaceLot[];
  mouldCount: 2 | 3;
  coolingGridSlots: 2 | 3 | 4;
  demandPreset: "steady" | "rush" | "gift-box-surge";
  shiftBreakPolicy: "staggered-relief" | "fixed-window" | "continuous-no-break";
  walkSpeedPreset: "standard" | "brisk" | "congested-aisle";
  /**
   * Optional floor-plan walk routes computed from the 3D shop layout at shift
   * preparation time. Must cover the exact location pair set of the shift.
   */
  customTravel?: readonly TravelRoute[];
  sesameBatches: number;
  sesameRoast: "skip" | "refresh";
  sesameCoolingSeconds: number;
  sesamePreparation: "baseline" | "early";
  blackTeaBatches: number;
  milkTeaBatches: number;
  espressoOrders: number;
  espressoAppliance: "linea" | "eagle-one";
  pourOverOrders: number;
  coffeeGrinder: GrinderModel;
  workers: 1 | 2;
  hobZones: 1 | 2;
  panCount: 2 | 3 | 4;
  nativeColdHandling: boolean;
  /**
   * "day-before": the sesame concentrate, shortcrust and pie fillings come
   * from the previous afternoon's run and are on hand in the refrigerator.
   * "same-morning": the morning makes them too.
   */
  miseEnPlace: "day-before" | "same-morning";
  /**
   * With two workers: a barista on the bar takes every customer order, and a
   * baker runs production. Without roles, both workers take any task.
   */
  stationRoles: boolean;
  /** With station roles: the barista may take production work when free. */
  baristaHelpsProduction: boolean;
  /** Customer-order tasks dispatch before production at task boundaries. */
  orderPriority: boolean;
  /** Milk jugs for the sesame drinks. */
  milkJugs: 1 | 2 | 3;
  /** Tea strainers shared by the two ginger teas. */
  strainers: 1 | 2;
  /**
   * The bar weighs on its own scale and heats on its own two-zone induction
   * unit, not on the kitchen scale and hob.
   */
  barScale: boolean;
  /**
   * "espresso-tap": milk tea cups warm with the espresso machine's hot water
   * during the simmer. "pan": pan A is washed and boils the cup water.
   */
  cupWarming: "espresso-tap" | "pan";
}>;

export type BakeryServiceShiftInput = BakeryShiftOptions &
  (Readonly<{ kind: "morning-shift" }> | Readonly<{ kind: "six-hour-shift" }>);

export const SIX_HOUR_SHIFT_SECONDS = 21_600;
export const MORNING_SHIFT_SECONDS = 28_800;

export function shiftHorizonSeconds(input: BakeryServiceShiftInput): number {
  switch (input.kind) {
    case "morning-shift":
      return MORNING_SHIFT_SECONDS;
    case "six-hour-shift":
      return SIX_HOUR_SHIFT_SECONDS;
    default:
      return assertNever(input);
  }
}

export function morningShiftRecipeInput(
  overrides: Partial<BakeryShiftOptions> = {},
): BakeryServiceShiftInput {
  return {
    financierLoads: 1,
    piesPerType: 6,
    financierWaves: 1,
    waveIntervalMinutes: 45,
    mouldCount: 2,
    coolingGridSlots: 4,
    demandPreset: "rush",
    shiftBreakPolicy: "staggered-relief",
    walkSpeedPreset: "standard",
    sesameBatches: 2,
    sesameRoast: "refresh",
    sesameCoolingSeconds: 1_500,
    sesamePreparation: "baseline",
    blackTeaBatches: 2,
    milkTeaBatches: 2,
    espressoOrders: 2,
    espressoAppliance: "linea",
    pourOverOrders: 2,
    coffeeGrinder: "option-o-lagom-casa",
    workers: 2,
    hobZones: 1,
    panCount: 4,
    nativeColdHandling: true,
    miseEnPlace: "day-before",
    stationRoles: true,
    orderPriority: true,
    milkJugs: 3,
    strainers: 2,
    barScale: true,
    cupWarming: "espresso-tap",
    baristaHelpsProduction: false,
    ...overrides,
    kind: "morning-shift",
  };
}

/**
 * Full 6-hour (21,600 s) multi-wave bakery and café shift preset: two
 * financier waves across all four flavours, two pie varieties, customer drinks
 * across all six hours, scheduled batch replenishment, and staggered
 * worker relief breaks.
 */
export function sixHourShiftRecipeInput(
  overrides: Partial<BakeryShiftOptions> = {},
): BakeryServiceShiftInput {
  return {
    financierLoads: 1,
    piesPerType: 6,
    financierWaves: 2,
    waveIntervalMinutes: 75,
    mouldCount: 2,
    coolingGridSlots: 4,
    demandPreset: "steady",
    shiftBreakPolicy: "staggered-relief",
    walkSpeedPreset: "standard",
    sesameBatches: 2,
    sesameRoast: "refresh",
    sesameCoolingSeconds: 1_500,
    sesamePreparation: "baseline",
    blackTeaBatches: 3,
    milkTeaBatches: 3,
    espressoOrders: 4,
    espressoAppliance: "linea",
    pourOverOrders: 2,
    coffeeGrinder: "option-o-lagom-casa",
    workers: 2,
    hobZones: 2,
    panCount: 4,
    nativeColdHandling: true,
    miseEnPlace: "day-before",
    stationRoles: true,
    baristaHelpsProduction: false,
    orderPriority: true,
    milkJugs: 3,
    strainers: 2,
    barScale: true,
    cupWarming: "espresso-tap",
    ...overrides,
    kind: "six-hour-shift",
  };
}
