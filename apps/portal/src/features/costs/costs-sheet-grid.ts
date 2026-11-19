import type React from "react";
import {
  COST_FORMULA_COLUMNS,
  defaultWeekUnitsForDaily,
  isFormulaExpression,
  presetDemandCurveValues,
  type CostPlanWrite,
  type CostsOverview,
  type LotCostLineWrite,
  type OfferPriceWrite,
  type ProductCostPlanEntry,
  type SupplyCostBulkTier,
  type SupplyCostLineWrite,
  type SupplyCostTerms,
} from "@purin-labs/control-api";
import {
  buildLotWritesForSheet,
  inspectDirtyLots,
} from "./costs-lots-drawer";
import {
  currencyDigits,
  hydrateFromOverview,
  sameForecastPlan,
  sameSupplyDraft,
  sameWeekDemandPct,
  sameWeekUnits,
  supplyDraftFromItem,
  type ProjectedCostsSheet,
  type SupplyRowDraft,
} from "./costs-sheet-draft";

type SheetCellElement =
  | HTMLInputElement
  | HTMLButtonElement
  | HTMLElement;

/**
 * Handles Excel-style 2D keyboard navigation across spreadsheet cells:
 * - ArrowUp / Shift+Enter: move up one row in the same column
 * - ArrowDown / Enter: move down one row in the same column
 * - ArrowLeft: move left one column in the same row (unless moving the caret inside an active `=` formula)
 * - ArrowRight: move right one column in the same row (unless moving the caret inside an active `=` formula)
 * - Tab / Shift+Tab: move right/left and wrap to the next/previous row at row boundaries
 */
export function handleSheetKeyDown(
  event: React.KeyboardEvent<SheetCellElement>,
  rowIndex: number,
  colKey: string,
  onCommit?: () => void,
): void {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = event;
  if (altKey || ctrlKey || metaKey) {
    return;
  }

  const current = event.currentTarget;
  if (
    (key === "ArrowLeft" || key === "ArrowRight") &&
    current instanceof HTMLInputElement &&
    shouldKeepCaretInFormulaInput(current, key)
  ) {
    return;
  }

  const scope: ParentNode = current.closest("table") ?? document;

  if (key === "ArrowUp" || (key === "Enter" && shiftKey)) {
    event.preventDefault();
    onCommit?.();
    focusVerticalNeighbor(scope, rowIndex, colKey, -1);
    return;
  }

  if (key === "ArrowDown" || (key === "Enter" && !shiftKey)) {
    event.preventDefault();
    onCommit?.();
    focusVerticalNeighbor(scope, rowIndex, colKey, 1);
    return;
  }

  if (key === "ArrowLeft") {
    event.preventDefault();
    onCommit?.();
    focusHorizontalNeighbor(scope, rowIndex, colKey, -1, false);
    return;
  }

  if (key === "ArrowRight") {
    event.preventDefault();
    onCommit?.();
    focusHorizontalNeighbor(scope, rowIndex, colKey, 1, false);
    return;
  }

  if (key === "Tab") {
    const moved = focusHorizontalNeighbor(
      scope,
      rowIndex,
      colKey,
      shiftKey ? -1 : 1,
      true,
      onCommit,
    );
    if (moved) {
      event.preventDefault();
    }
  }
}

function shouldKeepCaretInFormulaInput(
  input: HTMLInputElement,
  key: "ArrowLeft" | "ArrowRight",
): boolean {
  const val = input.value;
  if (!isFormulaExpression(val)) {
    return false;
  }
  try {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || end === null) {
      return false;
    }
    // When the entire cell text is selected, arrow keys navigate to the adjacent cell
    if (start === 0 && end === val.length && val.length > 0) {
      return false;
    }
    if (start !== end) {
      return true;
    }
    return key === "ArrowLeft" ? start > 0 : end < val.length;
  } catch {
    return false;
  }
}

function collectSheetPosition(scope: ParentNode): Readonly<{
  columns: readonly string[];
  maxRow: number;
}> {
  const seenCols = new Set<string>();
  const columns: string[] = [];
  let maxRow = 0;
  const nodes = scope.querySelectorAll<HTMLElement>(
    "[data-sheet-row][data-sheet-col]",
  );
  for (const node of nodes) {
    const col = node.dataset.sheetCol;
    const rowAttr = node.dataset.sheetRow;
    if (col !== undefined && !seenCols.has(col)) {
      seenCols.add(col);
      columns.push(col);
    }
    if (rowAttr !== undefined) {
      const parsed = Number(rowAttr);
      if (Number.isFinite(parsed) && parsed > maxRow) {
        maxRow = parsed;
      }
    }
  }
  return { columns, maxRow };
}

function findFocusableCell(
  scope: ParentNode,
  rowIndex: number,
  colKey: string,
): HTMLElement | null {
  const target = scope.querySelector<HTMLElement>(
    `[data-sheet-row="${rowIndex}"][data-sheet-col="${colKey}"]`,
  );
  if (target === null) return null;
  if (
    (target instanceof HTMLInputElement ||
      target instanceof HTMLButtonElement) &&
    target.disabled
  ) {
    return null;
  }
  return target;
}

function activateSheetCell(target: HTMLElement): void {
  target.focus();
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (target instanceof HTMLInputElement) {
    try {
      target.select();
    } catch {
      // number inputs do not support select() in some browsers
    }
  }
}

function focusVerticalNeighbor(
  scope: ParentNode,
  rowIndex: number,
  colKey: string,
  deltaRow: -1 | 1,
): boolean {
  const { maxRow } = collectSheetPosition(scope);
  for (
    let r = rowIndex + deltaRow;
    deltaRow < 0 ? r >= 0 : r <= maxRow;
    r += deltaRow
  ) {
    const target = findFocusableCell(scope, r, colKey);
    if (target !== null) {
      activateSheetCell(target);
      return true;
    }
  }
  return false;
}

function focusHorizontalNeighbor(
  scope: ParentNode,
  rowIndex: number,
  colKey: string,
  deltaCol: -1 | 1,
  wrapRows: boolean,
  onBeforeMove?: () => void,
): boolean {
  const { columns, maxRow } = collectSheetPosition(scope);
  const startColIdx = columns.indexOf(colKey);
  if (startColIdx === -1) return false;

  // Search along the current row first
  for (
    let c = startColIdx + deltaCol;
    deltaCol < 0 ? c >= 0 : c < columns.length;
    c += deltaCol
  ) {
    const candidateCol = columns[c];
    if (candidateCol === undefined) continue;
    const target = findFocusableCell(scope, rowIndex, candidateCol);
    if (target !== null) {
      onBeforeMove?.();
      activateSheetCell(target);
      return true;
    }
  }

  if (!wrapRows) {
    return false;
  }

  // Wrap to next/previous row when Tab / Shift+Tab hits row edge
  for (
    let r = rowIndex + deltaCol;
    deltaCol < 0 ? r >= 0 : r <= maxRow;
    r += deltaCol
  ) {
    const startWrapCol = deltaCol > 0 ? 0 : columns.length - 1;
    for (
      let c = startWrapCol;
      deltaCol < 0 ? c >= 0 : c < columns.length;
      c += deltaCol
    ) {
      const candidateCol = columns[c];
      if (candidateCol === undefined) continue;
      const target = findFocusableCell(scope, r, candidateCol);
      if (target !== null) {
        onBeforeMove?.();
        activateSheetCell(target);
        return true;
      }
    }
  }

  return false;
}

/**
 * When the user clicks anywhere inside a full-cell `.costs-cell-box` (e.g. on
 * the currency prefix, percent suffix, margin bar, or cell whitespace), focus
 * and select the cell's inner control.
 */
export function handleCellBoxMouseDown(
  event: React.MouseEvent<HTMLElement>,
): void {
  const clicked = event.target;
  if (
    clicked instanceof HTMLInputElement ||
    clicked instanceof HTMLButtonElement
  ) {
    return;
  }
  const inner = event.currentTarget.querySelector<
    HTMLInputElement | HTMLButtonElement
  >("input, button");
  if (inner !== null && !inner.disabled) {
    event.preventDefault();
    activateSheetCell(inner);
  }
}

export type DirtyInspection = Readonly<{
  laborDirty: boolean;
  rentDirty: boolean;
  forecastDirty: boolean;
  dirtyForecastCount: number;
  dirtyUnitProducts: ReadonlySet<string>;
  dirtySpoilProducts: ReadonlySet<string>;
  dirtyPriceProducts: ReadonlySet<string>;
  dirtyCogsProducts: ReadonlySet<string>;
  dirtyWasteProducts: ReadonlySet<string>;
  dirtyFormulaCellKeys: ReadonlySet<string>;
  dirtySupplies: ReadonlySet<string>;
  dirtyLots: ReadonlySet<string>;
  whatIfPriceCount: number;
  saveableDirtyCount: number;
  totalDirtyCount: number;
}>;

export function inspectDirtyCells(
  overview: CostsOverview,
  projected: ProjectedCostsSheet,
): DirtyInspection {
  const baseline = hydrateFromOverview(overview);
  const laborDirty = projected.dailyLaborMinor !== baseline.dailyLaborMinor;
  const rentDirty = projected.dailyRentMinor !== baseline.dailyRentMinor;
  const forecastDirty = !sameForecastPlan(
    projected.forecast,
    baseline.forecast,
  );
  const dirtyForecastCount = countDirtyForecastFields(
    projected.forecast,
    baseline.forecast,
  );
  const dirtyUnitProducts = new Set<string>();
  const dirtySpoilProducts = new Set<string>();
  const dirtyPriceProducts = new Set<string>();
  const dirtyCogsProducts = new Set<string>();
  const dirtyWasteProducts = new Set<string>();
  const dirtyFormulaCellKeys = new Set<string>();
  const dirtySupplies = new Set<string>();

  for (const product of overview.products) {
    const curWeek =
      projected.weeklyTargets[product.productId] ??
      baseline.weeklyTargets[product.productId];
    const baseWeek = baseline.weeklyTargets[product.productId];
    if (
      curWeek !== undefined &&
      baseWeek !== undefined &&
      !sameWeekUnits(curWeek, baseWeek)
    ) {
      dirtyUnitProducts.add(product.productId);
    }
    const curSpoil = projected.spoilBpsOverrides[product.productId] ?? null;
    const baseSpoil = baseline.spoilBpsOverrides[product.productId] ?? null;
    if (curSpoil !== baseSpoil) {
      dirtySpoilProducts.add(product.productId);
    }
    const priceOverride = projected.priceOverridesMinor[product.productId];
    if (priceOverride !== undefined && priceOverride !== product.priceMinor) {
      dirtyPriceProducts.add(product.productId);
    }
    const curCogs = projected.cogsOverridesMinor[product.productId] ?? null;
    const baseCogs = baseline.cogsOverridesMinor[product.productId] ?? null;
    if (curCogs !== baseCogs) {
      dirtyCogsProducts.add(product.productId);
    }
    const curWaste = projected.wasteOverridesMinor[product.productId] ?? null;
    const baseWaste = baseline.wasteOverridesMinor[product.productId] ?? null;
    if (curWaste !== baseWaste) {
      dirtyWasteProducts.add(product.productId);
    }
    const curFx = projected.productFormulas[product.productId] ?? {};
    const baseFx = baseline.productFormulas[product.productId] ?? {};
    for (const col of COST_FORMULA_COLUMNS) {
      if ((curFx[col] ?? null) !== (baseFx[col] ?? null)) {
        dirtyFormulaCellKeys.add(`${product.productId}:${col}`);
      }
    }
  }

  for (const item of overview.items) {
    const edit = projected.supplyEdits[item.id];
    if (edit === undefined) continue;
    const baselineDraft = supplyDraftFromItem(item, overview.currency);
    if (!sameSupplyDraft(edit, baselineDraft)) {
      dirtySupplies.add(item.id);
    }
  }

  const dirtyLots = inspectDirtyLots(overview, projected);

  const planCellCount =
    (laborDirty ? 1 : 0) +
    (rentDirty ? 1 : 0) +
    dirtyForecastCount +
    dirtyUnitProducts.size +
    dirtySpoilProducts.size +
    dirtyCogsProducts.size +
    dirtyWasteProducts.size +
    dirtyFormulaCellKeys.size;
  const saveablePriceCount = overview.canEditPrices
    ? dirtyPriceProducts.size
    : 0;
  const whatIfPriceCount = overview.canEditPrices
    ? 0
    : dirtyPriceProducts.size;
  const saveableDirtyCount =
    planCellCount + saveablePriceCount + dirtySupplies.size + dirtyLots.size;
  const totalDirtyCount = saveableDirtyCount + whatIfPriceCount;

  return {
    laborDirty,
    rentDirty,
    forecastDirty,
    dirtyForecastCount,
    dirtyUnitProducts,
    dirtySpoilProducts,
    dirtyPriceProducts,
    dirtyCogsProducts,
    dirtyWasteProducts,
    dirtyFormulaCellKeys,
    dirtySupplies,
    dirtyLots,
    whatIfPriceCount,
    saveableDirtyCount,
    totalDirtyCount,
  };
}

function countDirtyForecastFields(
  cur: ProjectedCostsSheet["forecast"],
  base: ProjectedCostsSheet["forecast"],
): number {
  let count = 0;
  if (cur.openingCashMinor !== base.openingCashMinor) count += 1;
  if (cur.supplierTerms !== base.supplierTerms) count += 1;
  if (cur.extraShiftThresholdPct !== base.extraShiftThresholdPct) count += 1;
  if (cur.extraShiftWeeklyMinor !== base.extraShiftWeeklyMinor) count += 1;
  if (cur.capexMinor !== base.capexMinor) count += 1;
  if (
    cur.demandCurve !== "custom" &&
    cur.demandCurve !== base.demandCurve &&
    sameWeekDemandPct(cur.weekDemandPct, presetDemandCurveValues(cur.demandCurve))
  ) {
    count += 1;
  } else {
    let weekDiffs = 0;
    for (let w = 0; w < 12; w += 1) {
      if (cur.weekDemandPct[w] !== base.weekDemandPct[w]) {
        weekDiffs += 1;
      }
    }
    if (weekDiffs > 0) {
      count += weekDiffs;
    } else if (cur.demandCurve !== base.demandCurve) {
      count += 1;
    }
  }
  return count;
}

export function buildSheetWritePayload(
  overview: CostsOverview,
  projected: ProjectedCostsSheet,
):
  | Readonly<{
      ok: true;
      planWrite: CostPlanWrite | null;
      priceWrites: readonly OfferPriceWrite[];
      supplyWrites: readonly SupplyCostLineWrite[];
      lotWrites: readonly LotCostLineWrite[];
    }>
  | Readonly<{ ok: false; error: string }> {
  const dirty = inspectDirtyCells(overview, projected);

  const priceWrites: OfferPriceWrite[] = [];
  if (overview.canEditPrices) {
    for (const product of overview.products) {
      if (!dirty.dirtyPriceProducts.has(product.productId)) continue;
      const nextPrice = projected.priceOverridesMinor[product.productId];
      if (nextPrice === undefined) continue;
      priceWrites.push({
        offerId: product.offerId,
        expectedOfferRevision: product.offerRevision,
        currency: product.currency,
        priceMinor: nextPrice,
      });
    }
  }

  let planWrite: CostPlanWrite | null = null;
  if (
    dirty.laborDirty ||
    dirty.rentDirty ||
    dirty.forecastDirty ||
    dirty.dirtyUnitProducts.size > 0 ||
    dirty.dirtySpoilProducts.size > 0 ||
    dirty.dirtyCogsProducts.size > 0 ||
    dirty.dirtyWasteProducts.size > 0 ||
    dirty.dirtyFormulaCellKeys.size > 0
  ) {
    const entries: ProductCostPlanEntry[] = overview.products.map(
      (product) => {
        const fx = projected.productFormulas[product.productId];
        return {
          productId: product.productId,
          weekUnits:
            projected.weeklyTargets[product.productId] ??
            defaultWeekUnitsForDaily(product.defaultDailyUnits),
          spoilBps: projected.spoilBpsOverrides[product.productId] ?? null,
          cogsOverrideMinor:
            projected.cogsOverridesMinor[product.productId] ?? null,
          wasteOverrideMinor:
            projected.wasteOverridesMinor[product.productId] ?? null,
          ...(fx !== undefined && Object.keys(fx).length > 0
            ? { formulas: fx }
            : {}),
        };
      },
    );
    const includeForecast =
      dirty.forecastDirty || overview.costPlan.forecast !== undefined;
    planWrite = {
      expectedPlanRevision: overview.costPlan.revision,
      dailyLaborMinor: projected.dailyLaborMinor,
      dailyRentMinor: projected.dailyRentMinor,
      products: entries,
      ...(includeForecast ? { forecast: projected.forecast } : {}),
    };
  }

  const supplyWrites: SupplyCostLineWrite[] = [];
  const digits = currencyDigits(overview.currency);
  for (const item of overview.items) {
    if (!dirty.dirtySupplies.has(item.id)) continue;
    const edit = projected.supplyEdits[item.id];
    if (edit === undefined) continue;
    const packQuantity = Number(edit.packQuantity);
    const packPriceMajor = Number(edit.packPriceMajor);
    if (
      !Number.isFinite(packQuantity) ||
      packQuantity <= 0 ||
      !Number.isFinite(packPriceMajor) ||
      packPriceMajor < 0
    ) {
      return {
        ok: false,
        error: `Enter a positive pack quantity and price for ${item.name}.`,
      };
    }
    const hasAnyBulk =
      edit.bulkMin7dQuantity.trim().length > 0 ||
      edit.bulkPackQuantity.trim().length > 0 ||
      edit.bulkPackPriceMajor.trim().length > 0;
    let bulkTier: SupplyCostBulkTier | null = null;
    if (hasAnyBulk) {
      const min7d = Number(edit.bulkMin7dQuantity);
      const bulkQty = Number(edit.bulkPackQuantity);
      const bulkMajor = Number(edit.bulkPackPriceMajor);
      if (
        !Number.isFinite(min7d) ||
        min7d <= 0 ||
        !Number.isFinite(bulkQty) ||
        bulkQty <= 0 ||
        !Number.isFinite(bulkMajor) ||
        bulkMajor < 0
      ) {
        return {
          ok: false,
          error: `Complete all three 7-day bulk tier cells (or clear all three) for ${item.name}.`,
        };
      }
      bulkTier = {
        min7dQuantity: min7d,
        packQuantity: bulkQty,
        packPriceMinor: Math.round(bulkMajor * 10 ** digits),
      };
    }

    supplyWrites.push({
      inventoryItemId: item.id,
      expectedEntryRevision: item.costTerms?.entryRevision ?? null,
      currency: item.costTerms?.currency ?? overview.currency,
      packQuantity,
      packUnit: edit.packUnit,
      packPriceMinor: Math.round(packPriceMajor * 10 ** digits),
      supplierId: item.costTerms?.supplierId ?? null,
      bulkTier,
      notes: item.costTerms?.notes ?? null,
    });
  }

  const builtLots = buildLotWritesForSheet(overview, projected, dirty.dirtyLots);
  if (!builtLots.ok) {
    return builtLots;
  }

  return {
    ok: true,
    planWrite,
    priceWrites,
    supplyWrites,
    lotWrites: builtLots.lotWrites,
  };
}

export function applyPreviewSupplyEdits(
  overview: CostsOverview,
  edits: Readonly<Record<string, SupplyRowDraft>>,
): CostsOverview {
  if (Object.keys(edits).length === 0) return overview;
  const digits = currencyDigits(overview.currency);
  const items = overview.items.map((item) => {
    const edit = edits[item.id];
    if (edit === undefined) return item;
    const packQuantity = Number(edit.packQuantity);
    const packPriceMajor = Number(edit.packPriceMajor);
    if (
      !Number.isFinite(packQuantity) ||
      packQuantity <= 0 ||
      !Number.isFinite(packPriceMajor) ||
      packPriceMajor < 0
    ) {
      return item;
    }
    const min7d = Number(edit.bulkMin7dQuantity);
    const bulkQty = Number(edit.bulkPackQuantity);
    const bulkMajor = Number(edit.bulkPackPriceMajor);
    const bulkTier: SupplyCostBulkTier | null =
      edit.bulkMin7dQuantity.trim().length > 0 &&
      edit.bulkPackQuantity.trim().length > 0 &&
      edit.bulkPackPriceMajor.trim().length > 0 &&
      Number.isFinite(min7d) &&
      min7d > 0 &&
      Number.isFinite(bulkQty) &&
      bulkQty > 0 &&
      Number.isFinite(bulkMajor) &&
      bulkMajor >= 0
        ? {
            min7dQuantity: min7d,
            packQuantity: bulkQty,
            packPriceMinor: Math.round(bulkMajor * 10 ** digits),
          }
        : null;
    const previewTerms: SupplyCostTerms = {
      entryId: item.costTerms?.entryId ?? `preview:${item.id}`,
      entryRevision: item.costTerms?.entryRevision ?? 1,
      currency: item.costTerms?.currency ?? overview.currency,
      packQuantity,
      packUnit: edit.packUnit,
      packPriceMinor: Math.round(packPriceMajor * 10 ** digits),
      supplierId: item.costTerms?.supplierId ?? null,
      bulkTier,
      notes: item.costTerms?.notes ?? null,
    };
    return { ...item, costTerms: previewTerms };
  });
  return { ...overview, items };
}
