/**
 * Day-before mise en place for the morning and six-hour shifts. The previous
 * afternoon's production run makes the black sesame concentrate, the ginger
 * decoctions for the teas, the shortcrust dough and both pie fillings, and
 * holds them in the Hoshizaki refrigerator. The next shift starts with these
 * lots on hand and keeps only the work that must be fresh: financier batter and
 * bakes, pie assembly and baking, and drinks.
 *
 * `extractCarryoverMiseEnPlace` transfers released refrigerated lots and their
 * actual completion timestamps from an executed prep run into the next shift's
 * opening stock, checking that every lot remains within its refrigerated hold
 * through the end of the receiving shift.
 */

import { err, ok, type Result } from "../../result.ts";
import type { RunState } from "../../state.ts";

/** The afternoon run starts at 13:00 on the day before a 07:00 shift. */
export const AFTERNOON_PREP_START_SECONDS_BEFORE_SHIFT = 18 * 3_600;

export type MiseEnPlaceLot = Readonly<{
  /** Opening stock lot id in the morning scenario. */
  lot: string;
  product: string;
  storage: string;
  quantityMg: number;
  /** The afternoon workflow and task whose output this lot is. */
  madeBy: Readonly<{ workflow: string; task: string }>;
  /**
   * Longest refrigerated hold, an assumption: 48 h for the cooked sesame
   * concentrate and the raw butter dough, 72 h for cooked, chilled meat
   * fillings held at 5 °C or colder.
   */
  holdHours: number;
}>;

export type CarryoverMiseEnPlaceLot = MiseEnPlaceLot &
  Readonly<{
    madeAtSeconds: number;
    elapsedBeforeShiftSeconds: number;
  }>;

export type CarryoverMiseEnPlaceError = Readonly<{
  code:
    | "missing_carryover_lot"
    | "insufficient_carryover_quantity"
    | "uncompleted_carryover_task"
    | "expired_carryover_hold";
  lot: string;
}>;

export function miseEnPlaceLots(
  piesPerType: number,
  pieTypes: readonly string[],
  decoctions: readonly Readonly<{ product: string; quantityMg: number }>[],
): readonly MiseEnPlaceLot[] {
  const lots: MiseEnPlaceLot[] = [
    // One chilled ginger decoction for each morning tea batch.
    ...decoctions.map((decoction) => ({
      lot: `${decoction.product}-on-hand`,
      product: decoction.product,
      storage: `${decoction.product}-fridge`,
      quantityMg: decoction.quantityMg,
      madeBy: { workflow: decoction.product, task: "chill-decoction" },
      holdHours: 48,
    })),
    {
      lot: "sesame-concentrate-on-hand",
      product: "concentrate",
      storage: "concentrate-fridge",
      // Two 760 g batches, bottled 4 × 380 g; twelve orders use 912 g.
      quantityMg: 2 * 760_000,
      madeBy: { workflow: "sesame-batch", task: "wash-and-fill-bottle-b" },
      holdHours: 48,
    },
  ];
  if (piesPerType === 0) return lots;
  lots.push({
    lot: "shortcrust-dough-on-hand",
    product: "shortcrust-dough",
    storage: "shortcrust-fridge",
    quantityMg: 110_000 * piesPerType * pieTypes.length,
    madeBy: { workflow: "shortcrust", task: "rest-shortcrust" },
    holdHours: 48,
  });
  for (const pie of pieTypes)
    lots.push({
      lot: `${pie}-filling-on-hand`,
      product: `${pie}-filling`,
      storage: `${pie}-filling-fridge`,
      quantityMg: 260_000 * piesPerType,
      madeBy: { workflow: `${pie}-filling`, task: "chill-filling" },
      holdHours: 72,
    });
  return lots;
}

/**
 * True when a lot made `madeAtSeconds` after the afternoon run starts is still
 * inside its hold at the end of a shift of `shiftSeconds`.
 */
export function withinHold(
  lot: MiseEnPlaceLot,
  madeAtSeconds: number,
  shiftSeconds: number,
  elapsedBeforeShiftSeconds: number = AFTERNOON_PREP_START_SECONDS_BEFORE_SHIFT,
): boolean {
  const ageAtShiftEnd =
    elapsedBeforeShiftSeconds - madeAtSeconds + shiftSeconds;
  return ageAtShiftEnd >= 0 && ageAtShiftEnd <= lot.holdHours * 3_600;
}

/**
 * Extracts released refrigerated lots and their completion times from an
 * executed afternoon prep run so the next shift opens with verified stock and
 * lot ages.
 */
export function extractCarryoverMiseEnPlace(
  prepRun: RunState,
  options: Readonly<{
    piesPerType: number;
    pieTypes: readonly string[];
    decoctions: readonly Readonly<{ product: string; quantityMg: number }>[];
    elapsedBeforeShiftSeconds?: number;
    shiftHorizonSeconds?: number;
  }>,
): Result<readonly CarryoverMiseEnPlaceLot[], CarryoverMiseEnPlaceError> {
  const elapsedBeforeShiftSeconds =
    options.elapsedBeforeShiftSeconds ??
    AFTERNOON_PREP_START_SECONDS_BEFORE_SHIFT;
  const shiftHorizonSeconds = options.shiftHorizonSeconds ?? 0;
  const expected = miseEnPlaceLots(
    options.piesPerType,
    options.pieTypes,
    options.decoctions,
  );
  const carried: CarryoverMiseEnPlaceLot[] = [];
  for (const lot of expected) {
    let availableMg = 0;
    for (const entry of prepRun.lots) {
      if (
        entry.product === lot.product &&
        entry.disposition === "released" &&
        entry.remaining.unit === "milligram"
      ) {
        availableMg += entry.remaining.amount;
      }
    }
    if (availableMg === 0)
      return err({ code: "missing_carryover_lot", lot: lot.lot });
    if (availableMg < lot.quantityMg)
      return err({ code: "insufficient_carryover_quantity", lot: lot.lot });
    let madeAtSeconds = -1;
    let instanceCount = 0;
    for (const instance of prepRun.instances) {
      if (instance.workflow !== lot.madeBy.workflow) continue;
      instanceCount += 1;
      const taskId = `${instance.id}/${lot.madeBy.task}`;
      const task = prepRun.tasks.find((candidate) => candidate.id === taskId);
      if (task?.kind !== "completed")
        return err({ code: "uncompleted_carryover_task", lot: lot.lot });
      madeAtSeconds = Math.max(madeAtSeconds, task.completedAt / 1_000_000);
    }
    if (instanceCount === 0 || madeAtSeconds < 0)
      return err({ code: "uncompleted_carryover_task", lot: lot.lot });
    if (
      !withinHold(
        lot,
        madeAtSeconds,
        shiftHorizonSeconds,
        elapsedBeforeShiftSeconds,
      )
    )
      return err({ code: "expired_carryover_hold", lot: lot.lot });
    carried.push({
      ...lot,
      quantityMg: availableMg,
      madeAtSeconds,
      elapsedBeforeShiftSeconds,
    });
  }
  return ok(carried);
}
