import {
  COST_FORMULA_COLUMNS,
  COST_SCENARIO_LIMITS,
  defaultCostAssumptions,
  defaultWeekUnitsForDaily,
  isValidCostFormulaString,
  normalizeCostForecastPlan,
  normalizeFormulaExpression,
  presetDemandCurveValues,
  scaleWeekUnitsToDaily,
  type CostForecastPlan,
  type CostFormulaColumn,
  type CostScenarioAssumptions,
  type CostUnit,
  type CostValuationBasis,
  type CostsOverview,
  type ForecastDemandCurve,
  type ForecastSupplierTerms,
  type ForecastWeekDemandPct,
  type SupplyCostItem,
  type SupplyLotCost,
  type WeekUnits,
} from "@purin-labs/kitchen-control-api";
import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_DEMAND_CURVE_CELL_KEY,
  FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  FORECAST_SUPPLIER_TERMS_CELL_KEY,
  OVERHEAD_LABOR_CELL_KEY,
  OVERHEAD_RENT_CELL_KEY,
  SCENARIO_BAKE_WASTE_CELL_KEY,
  SCENARIO_BULK_TIERS_CELL_KEY,
  SCENARIO_CHANNEL_FEE_CELL_KEY,
  SCENARIO_INCLUDED_TAX_CELL_KEY,
  SCENARIO_LOT_COST_BASIS_CELL_KEY,
  SCENARIO_PREP_REJECT_CELL_KEY,
  SCENARIO_PRESET_CELL_KEY,
  forecastWeekIndexCellKey,
  isCostsSheetCellEntry,
  lotInvoiceFieldCellKey,
  productCogsCellKey,
  productDailyCellKey,
  productDayCellKey,
  productFormulaCellKey,
  productPriceCellKey,
  productSpoilCellKey,
  productWasteCellKey,
  supplyFieldCellKey,
  type CostsSheetCellChange,
  type CostsSheetLotInvoiceField,
  type CostsSheetSupplyField,
} from "@purin-labs/costs-sheet-crdt";

export type PresetId = "saved" | "weekend" | "rainy" | "custom";

export type SupplyRowDraft = Readonly<{
  packQuantity: string;
  packUnit: CostUnit;
  packPriceMajor: string;
  bulkMin7dQuantity: string;
  bulkPackQuantity: string;
  bulkPackPriceMajor: string;
}>;

export type LotInvoiceRowDraft = Readonly<{
  invoiceReference: string;
  invoiceTotalMajor: string;
}>;

type HydratedPlanState = Readonly<{
  dailyLaborMinor: number;
  dailyRentMinor: number;
  dailyTargets: Readonly<Record<string, number>>;
  weeklyTargets: Readonly<Record<string, WeekUnits>>;
  spoilBpsOverrides: Readonly<Record<string, number | null>>;
  cogsOverridesMinor: Readonly<Record<string, number | null>>;
  wasteOverridesMinor: Readonly<Record<string, number | null>>;
  productFormulas: Readonly<Record<string, Readonly<Record<string, string>>>>;
  forecast: CostForecastPlan;
}>;

export type ProjectedCostsSheet = Readonly<{
  assumptions: CostScenarioAssumptions;
  dailyLaborMinor: number;
  dailyRentMinor: number;
  dailyTargets: Readonly<Record<string, number>>;
  weeklyTargets: Readonly<Record<string, WeekUnits>>;
  spoilBpsOverrides: Readonly<Record<string, number | null>>;
  cogsOverridesMinor: Readonly<Record<string, number | null>>;
  wasteOverridesMinor: Readonly<Record<string, number | null>>;
  productFormulas: Readonly<Record<string, Readonly<Record<string, string>>>>;
  priceOverridesMinor: Readonly<Record<string, number>>;
  supplyEdits: Readonly<Record<string, SupplyRowDraft>>;
  lotEdits: Readonly<Record<string, LotInvoiceRowDraft>>;
  forecast: CostForecastPlan;
  preset: PresetId;
}>;

const SUPPLY_DRAFT_FIELDS: readonly CostsSheetSupplyField[] = [
  "packQuantity",
  "packUnit",
  "packPriceMajor",
  "bulkMin7dQuantity",
  "bulkPackQuantity",
  "bulkPackPriceMajor",
];

const LOT_DRAFT_FIELDS: readonly CostsSheetLotInvoiceField[] = [
  "invoiceReference",
  "invoiceTotalMajor",
];

export function hydrateFromOverview(overview: CostsOverview): HydratedPlanState {
  const savedByProductId = new Map(
    overview.costPlan.products.map((entry) => [entry.productId, entry]),
  );
  const dailyTargets: Record<string, number> = {};
  const weeklyTargets: Record<string, WeekUnits> = {};
  const spoilBpsOverrides: Record<string, number | null> = {};
  const cogsOverridesMinor: Record<string, number | null> = {};
  const wasteOverridesMinor: Record<string, number | null> = {};
  const productFormulas: Record<string, Readonly<Record<string, string>>> = {};

  for (const product of overview.products) {
    const saved = savedByProductId.get(product.productId);
    if (saved !== undefined) {
      weeklyTargets[product.productId] = saved.weekUnits;
      dailyTargets[product.productId] = Math.round(sumWeek(saved.weekUnits) / 7);
      spoilBpsOverrides[product.productId] = saved.spoilBps;
      cogsOverridesMinor[product.productId] = saved.cogsOverrideMinor ?? null;
      wasteOverridesMinor[product.productId] = saved.wasteOverrideMinor ?? null;
      productFormulas[product.productId] = saved.formulas ?? {};
    } else {
      dailyTargets[product.productId] = product.defaultDailyUnits;
      weeklyTargets[product.productId] = defaultWeekUnitsForDaily(
        product.defaultDailyUnits,
      );
      spoilBpsOverrides[product.productId] = null;
      cogsOverridesMinor[product.productId] = null;
      wasteOverridesMinor[product.productId] = null;
      productFormulas[product.productId] = {};
    }
  }

  return {
    dailyLaborMinor: overview.costPlan.dailyLaborMinor,
    dailyRentMinor: overview.costPlan.dailyRentMinor,
    dailyTargets,
    weeklyTargets,
    spoilBpsOverrides,
    cogsOverridesMinor,
    wasteOverridesMinor,
    productFormulas,
    forecast: normalizeCostForecastPlan(
      overview.costPlan.forecast,
      overview.currency,
    ),
  };
}

/**
 * Overlays sparse Yjs cell overrides onto the saved D1 + Commerce baseline.
 */
export function projectCostsSheetDraft(
  overview: CostsOverview,
  cells: Readonly<Record<string, string>>,
): ProjectedCostsSheet {
  const baseline = hydrateFromOverview(overview);
  const baseAssumptions = defaultCostAssumptions(overview);

  const laborRaw = cells[OVERHEAD_LABOR_CELL_KEY];
  const dailyLaborMinor =
    laborRaw !== undefined && Number.isSafeInteger(Number(laborRaw))
      ? Math.max(0, Number(laborRaw))
      : baseline.dailyLaborMinor;

  const rentRaw = cells[OVERHEAD_RENT_CELL_KEY];
  const dailyRentMinor =
    rentRaw !== undefined && Number.isSafeInteger(Number(rentRaw))
      ? Math.max(0, Number(rentRaw))
      : baseline.dailyRentMinor;

  const bakeWasteRaw = cells[SCENARIO_BAKE_WASTE_CELL_KEY];
  const prepRejectRaw = cells[SCENARIO_PREP_REJECT_CELL_KEY];
  const channelFeeRaw = cells[SCENARIO_CHANNEL_FEE_CELL_KEY];
  const includedTaxRaw = cells[SCENARIO_INCLUDED_TAX_CELL_KEY];
  const bulkTiersRaw = cells[SCENARIO_BULK_TIERS_CELL_KEY];
  const lotCostBasisRaw = cells[SCENARIO_LOT_COST_BASIS_CELL_KEY];

  const assumptions: CostScenarioAssumptions = {
    ...baseAssumptions,
    bakeShelfWastePct:
      bakeWasteRaw !== undefined && Number.isFinite(Number(bakeWasteRaw))
        ? clampNumber(Number(bakeWasteRaw), 0, 95)
        : baseAssumptions.bakeShelfWastePct,
    prepRejectPct:
      prepRejectRaw !== undefined && Number.isFinite(Number(prepRejectRaw))
        ? clampNumber(Number(prepRejectRaw), 0, 95)
        : baseAssumptions.prepRejectPct,
    channelFeeBps:
      channelFeeRaw !== undefined && Number.isSafeInteger(Number(channelFeeRaw))
        ? clampNumber(Number(channelFeeRaw), 0, 5_000)
        : baseAssumptions.channelFeeBps,
    includedTaxBps:
      includedTaxRaw !== undefined &&
      Number.isSafeInteger(Number(includedTaxRaw))
        ? clampNumber(Number(includedTaxRaw), 0, 10_000)
        : baseAssumptions.includedTaxBps,
    applyBulkTiers:
      bulkTiersRaw === "true"
        ? true
        : bulkTiersRaw === "false"
          ? false
          : baseAssumptions.applyBulkTiers,
    lotCostBasis: isLotCostBasis(lotCostBasisRaw)
      ? lotCostBasisRaw
      : baseAssumptions.lotCostBasis,
  };

  const presetRaw = cells[SCENARIO_PRESET_CELL_KEY];
  const preset: PresetId =
    presetRaw === "saved" ||
    presetRaw === "weekend" ||
    presetRaw === "rainy" ||
    presetRaw === "custom"
      ? presetRaw
      : "saved";

  const dailyTargets: Record<string, number> = {};
  const weeklyTargets: Record<string, WeekUnits> = {};
  const spoilBpsOverrides: Record<string, number | null> = {};
  const cogsOverridesMinor: Record<string, number | null> = {};
  const wasteOverridesMinor: Record<string, number | null> = {};
  const productFormulas: Record<string, Readonly<Record<string, string>>> = {};
  const priceOverridesMinor: Record<string, number> = {};

  for (const product of overview.products) {
    const productId = product.productId;
    const baseWeek =
      baseline.weeklyTargets[productId] ??
      defaultWeekUnitsForDaily(product.defaultDailyUnits);

    let hasDayCell = false;
    const mergedDays: [number, number, number, number, number, number, number] =
      [
        baseWeek[0],
        baseWeek[1],
        baseWeek[2],
        baseWeek[3],
        baseWeek[4],
        baseWeek[5],
        baseWeek[6],
      ];

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayRaw = cells[productDayCellKey(productId, dayIndex)];
      if (dayRaw !== undefined && Number.isSafeInteger(Number(dayRaw))) {
        mergedDays[dayIndex] = clampNumber(Number(dayRaw), 0, 100_000);
        hasDayCell = true;
      }
    }

    const dailyRaw = cells[productDailyCellKey(productId)];
    if (dailyRaw !== undefined && Number.isSafeInteger(Number(dailyRaw))) {
      const parsedDaily = clampNumber(Number(dailyRaw), 0, 100_000);
      const weekFromDays: WeekUnits = mergedDays;
      const avgFromDays = Math.round(sumWeek(weekFromDays) / 7);
      weeklyTargets[productId] =
        !hasDayCell || avgFromDays !== parsedDaily
          ? scaleWeekUnitsToDaily(weekFromDays, parsedDaily)
          : weekFromDays;
      dailyTargets[productId] = parsedDaily;
    } else if (hasDayCell) {
      weeklyTargets[productId] = mergedDays;
      dailyTargets[productId] = Math.round(sumWeek(mergedDays) / 7);
    } else {
      weeklyTargets[productId] = baseWeek;
      dailyTargets[productId] =
        baseline.dailyTargets[productId] ?? product.defaultDailyUnits;
    }

    const spoilRaw = cells[productSpoilCellKey(productId)];
    if (spoilRaw === "default") {
      spoilBpsOverrides[productId] = null;
    } else if (spoilRaw !== undefined && Number.isSafeInteger(Number(spoilRaw))) {
      spoilBpsOverrides[productId] = clampNumber(Number(spoilRaw), 0, 9_500);
    } else {
      spoilBpsOverrides[productId] =
        baseline.spoilBpsOverrides[productId] ?? null;
    }

    const cogsRaw = cells[productCogsCellKey(productId)];
    if (cogsRaw === "default") {
      cogsOverridesMinor[productId] = null;
    } else if (cogsRaw !== undefined && Number.isSafeInteger(Number(cogsRaw))) {
      cogsOverridesMinor[productId] = clampNumber(
        Number(cogsRaw),
        0,
        1_000_000_000,
      );
    } else {
      cogsOverridesMinor[productId] =
        baseline.cogsOverridesMinor[productId] ?? null;
    }

    const wasteRaw = cells[productWasteCellKey(productId)];
    if (wasteRaw === "default") {
      wasteOverridesMinor[productId] = null;
    } else if (wasteRaw !== undefined && Number.isSafeInteger(Number(wasteRaw))) {
      wasteOverridesMinor[productId] = clampNumber(
        Number(wasteRaw),
        0,
        1_000_000_000,
      );
    } else {
      wasteOverridesMinor[productId] =
        baseline.wasteOverridesMinor[productId] ?? null;
    }

    const baseFormulas = baseline.productFormulas[productId] ?? {};
    const mergedFormulas: Record<string, string> = { ...baseFormulas };
    for (const col of COST_FORMULA_COLUMNS) {
      const fxRaw = cells[productFormulaCellKey(productId, col)];
      if (fxRaw === "default") {
        delete mergedFormulas[col];
      } else if (fxRaw !== undefined && isValidCostFormulaString(fxRaw)) {
        mergedFormulas[col] = normalizeFormulaExpression(fxRaw);
      }
    }
    productFormulas[productId] = mergedFormulas;

    const priceRaw = cells[productPriceCellKey(productId)];
    if (priceRaw !== undefined && Number.isSafeInteger(Number(priceRaw))) {
      const parsedPrice = clampNumber(Number(priceRaw), 0, 1_000_000_000);
      if (parsedPrice !== product.priceMinor) {
        priceOverridesMinor[productId] = parsedPrice;
      }
    }
  }

  const supplyEdits: Record<string, SupplyRowDraft> = {};
  for (const item of overview.items) {
    const baseDraft = supplyDraftFromItem(item, overview.currency);
    let hasFieldOverride = false;
    const draft: Record<CostsSheetSupplyField, string> = {
      packQuantity: baseDraft.packQuantity,
      packUnit: baseDraft.packUnit,
      packPriceMajor: baseDraft.packPriceMajor,
      bulkMin7dQuantity: baseDraft.bulkMin7dQuantity,
      bulkPackQuantity: baseDraft.bulkPackQuantity,
      bulkPackPriceMajor: baseDraft.bulkPackPriceMajor,
    };
    for (const field of SUPPLY_DRAFT_FIELDS) {
      const raw = cells[supplyFieldCellKey(item.id, field)];
      if (raw !== undefined) {
        draft[field] = raw;
        hasFieldOverride = true;
      }
    }
    if (hasFieldOverride) {
      supplyEdits[item.id] = {
        packQuantity: draft.packQuantity,
        packUnit: isCostUnit(draft.packUnit)
          ? draft.packUnit
          : baseDraft.packUnit,
        packPriceMajor: draft.packPriceMajor,
        bulkMin7dQuantity: draft.bulkMin7dQuantity,
        bulkPackQuantity: draft.bulkPackQuantity,
        bulkPackPriceMajor: draft.bulkPackPriceMajor,
      };
    }
  }

  const lotEdits: Record<string, LotInvoiceRowDraft> = {};
  for (const lot of overview.lots ?? []) {
    const baseLotDraft = lotDraftFromLot(lot, overview.currency);
    let hasLotOverride = false;
    const draft: Record<CostsSheetLotInvoiceField, string> = {
      invoiceReference: baseLotDraft.invoiceReference,
      invoiceTotalMajor: baseLotDraft.invoiceTotalMajor,
    };
    for (const field of LOT_DRAFT_FIELDS) {
      const raw = cells[lotInvoiceFieldCellKey(lot.id, field)];
      if (raw !== undefined) {
        draft[field] = raw;
        hasLotOverride = true;
      }
    }
    if (hasLotOverride) {
      lotEdits[lot.id] = {
        invoiceReference: draft.invoiceReference,
        invoiceTotalMajor: draft.invoiceTotalMajor,
      };
    }
  }

  const forecast = projectForecastDraft(baseline.forecast, cells);

  return {
    assumptions,
    dailyLaborMinor,
    dailyRentMinor,
    dailyTargets,
    weeklyTargets,
    spoilBpsOverrides,
    cogsOverridesMinor,
    wasteOverridesMinor,
    productFormulas,
    priceOverridesMinor,
    supplyEdits,
    lotEdits,
    forecast,
    preset,
  };
}

export function changesForLaborMinor(
  overview: CostsOverview,
  minor: number,
): readonly CostsSheetCellChange[] {
  const clamped = clampNumber(Math.round(minor), 0, 1_000_000_000);
  return [
    {
      cellKey: OVERHEAD_LABOR_CELL_KEY,
      value:
        clamped === overview.costPlan.dailyLaborMinor ? null : String(clamped),
    },
  ];
}

export function changesForRentMinor(
  overview: CostsOverview,
  minor: number,
): readonly CostsSheetCellChange[] {
  const clamped = clampNumber(Math.round(minor), 0, 1_000_000_000);
  return [
    {
      cellKey: OVERHEAD_RENT_CELL_KEY,
      value:
        clamped === overview.costPlan.dailyRentMinor ? null : String(clamped),
    },
  ];
}

export function changesForAssumptions(
  overview: CostsOverview,
  next: CostScenarioAssumptions,
): readonly CostsSheetCellChange[] {
  const base = defaultCostAssumptions(overview);
  const limits = COST_SCENARIO_LIMITS;
  const bakePct = clampNumber(
    next.bakeShelfWastePct,
    0,
    limits.bakeShelfWastePct,
  );
  const rejectPct = clampNumber(next.prepRejectPct, 0, limits.prepRejectPct);
  const feeBps = clampNumber(
    Math.round(next.channelFeeBps),
    0,
    limits.channelFeeBps,
  );
  const taxBps = clampNumber(
    Math.round(next.includedTaxBps),
    0,
    limits.includedTaxBps,
  );
  return [
    {
      cellKey: SCENARIO_BAKE_WASTE_CELL_KEY,
      value:
        bakePct === base.bakeShelfWastePct
          ? null
          : formatPctCell(bakePct, limits.bakeShelfWastePct),
    },
    {
      cellKey: SCENARIO_PREP_REJECT_CELL_KEY,
      value:
        rejectPct === base.prepRejectPct
          ? null
          : formatPctCell(rejectPct, limits.prepRejectPct),
    },
    {
      cellKey: SCENARIO_CHANNEL_FEE_CELL_KEY,
      value: feeBps === base.channelFeeBps ? null : String(feeBps),
    },
    {
      cellKey: SCENARIO_INCLUDED_TAX_CELL_KEY,
      value: taxBps === base.includedTaxBps ? null : String(taxBps),
    },
    {
      cellKey: SCENARIO_BULK_TIERS_CELL_KEY,
      value:
        next.applyBulkTiers === base.applyBulkTiers
          ? null
          : String(next.applyBulkTiers),
    },
    {
      cellKey: SCENARIO_LOT_COST_BASIS_CELL_KEY,
      value:
        next.lotCostBasis === base.lotCostBasis ? null : next.lotCostBasis,
    },
  ];
}

export function changesForMultiplierPreset(
  overview: CostsOverview,
  preset: "saved" | "weekend" | "rainy",
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const changes: CostsSheetCellChange[] = [
    {
      cellKey: SCENARIO_PRESET_CELL_KEY,
      value: preset === "saved" ? null : preset,
    },
  ];
  const factor = preset === "weekend" ? 1.5 : preset === "rainy" ? 0.7 : 1;
  for (const product of overview.products) {
    const baseWeek =
      baseline.weeklyTargets[product.productId] ??
      defaultWeekUnitsForDaily(product.defaultDailyUnits);
    changes.push({
      cellKey: productDailyCellKey(product.productId),
      value: null,
    });
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const baseDay = baseWeek[dayIndex] ?? 0;
      const scaled =
        preset === "saved"
          ? baseDay
          : clampNumber(Math.round(baseDay * factor), 0, 100_000);
      changes.push({
        cellKey: productDayCellKey(product.productId, dayIndex),
        value: scaled === baseDay ? null : String(scaled),
      });
    }
  }
  return changes;
}

export function changesForDailyUnits(
  overview: CostsOverview,
  currentWeeklyTargets: Readonly<Record<string, WeekUnits>>,
  productId: string,
  nextDaily: number,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseWeek =
    baseline.weeklyTargets[productId] ?? defaultWeekUnitsForDaily(nextDaily);
  const currentWeek =
    currentWeeklyTargets[productId] ?? defaultWeekUnitsForDaily(nextDaily);
  const clampedDaily = clampNumber(Math.round(nextDaily), 0, 100_000);
  const scaledWeek = scaleWeekUnitsToDaily(currentWeek, clampedDaily);
  const avgFromWeek = Math.round(sumWeek(scaledWeek) / 7);

  const changes: CostsSheetCellChange[] = [
    { cellKey: SCENARIO_PRESET_CELL_KEY, value: "custom" },
    {
      cellKey: productDailyCellKey(productId),
      value: avgFromWeek === clampedDaily ? null : String(clampedDaily),
    },
  ];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const nextDay = scaledWeek[dayIndex] ?? 0;
    const baseDay = baseWeek[dayIndex] ?? 0;
    changes.push({
      cellKey: productDayCellKey(productId, dayIndex),
      value: nextDay === baseDay ? null : String(nextDay),
    });
  }
  return changes;
}

export function changesForWeekDayUnits(
  overview: CostsOverview,
  currentWeeklyTargets: Readonly<Record<string, WeekUnits>>,
  productId: string,
  dayIndex: number,
  nextDayUnits: number,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseWeek =
    baseline.weeklyTargets[productId] ?? [0, 0, 0, 0, 0, 0, 0];
  const currentWeek = currentWeeklyTargets[productId] ?? baseWeek;
  const clamped = clampNumber(Math.round(nextDayUnits), 0, 100_000);

  const changes: CostsSheetCellChange[] = [
    { cellKey: SCENARIO_PRESET_CELL_KEY, value: "custom" },
    { cellKey: productDailyCellKey(productId), value: null },
  ];
  for (let d = 0; d < 7; d += 1) {
    const valueForDay = d === dayIndex ? clamped : (currentWeek[d] ?? 0);
    const baseDay = baseWeek[d] ?? 0;
    changes.push({
      cellKey: productDayCellKey(productId, d),
      value: valueForDay === baseDay ? null : String(valueForDay),
    });
  }
  return changes;
}

export function changesForProductSpoilBps(
  overview: CostsOverview,
  productId: string,
  nextSpoilBps: number | null,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseSpoil = baseline.spoilBpsOverrides[productId] ?? null;
  const baseWaste = baseline.wasteOverridesMinor[productId] ?? null;
  const baseFxSpoil = baseline.productFormulas[productId]?.spoil;
  const normalized =
    nextSpoilBps === null
      ? null
      : clampNumber(Math.round(nextSpoilBps), 0, 9_500);
  return [
    {
      cellKey: productSpoilCellKey(productId),
      value:
        normalized === baseSpoil
          ? null
          : normalized === null
            ? "default"
            : String(normalized),
    },
    {
      cellKey: productFormulaCellKey(productId, "spoil"),
      value: baseFxSpoil !== undefined ? "default" : null,
    },
    {
      cellKey: productWasteCellKey(productId),
      value: baseWaste !== null ? "default" : null,
    },
  ];
}

export function changesForProductPriceMinor(
  overview: CostsOverview,
  productId: string,
  nextPriceMinor: number,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseFxPrice = baseline.productFormulas[productId]?.price;
  const product = overview.products.find((row) => row.productId === productId);
  const clamped = clampNumber(Math.round(nextPriceMinor), 0, 1_000_000_000);
  return [
    {
      cellKey: productPriceCellKey(productId),
      value:
        product !== undefined && clamped === product.priceMinor
          ? null
          : String(clamped),
    },
    {
      cellKey: productFormulaCellKey(productId, "price"),
      value: baseFxPrice !== undefined ? "default" : null,
    },
  ];
}

export function changesForProductCogsMinor(
  overview: CostsOverview,
  productId: string,
  nextCogsMinor: number | null,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseCogs = baseline.cogsOverridesMinor[productId] ?? null;
  const baseFxCogs = baseline.productFormulas[productId]?.cogs;
  const normalized =
    nextCogsMinor === null
      ? null
      : clampNumber(Math.round(nextCogsMinor), 0, 1_000_000_000);
  return [
    {
      cellKey: productCogsCellKey(productId),
      value:
        normalized === baseCogs
          ? null
          : normalized === null
            ? "default"
            : String(normalized),
    },
    {
      cellKey: productFormulaCellKey(productId, "cogs"),
      value: baseFxCogs !== undefined ? "default" : null,
    },
  ];
}

export function changesForProductWasteMinor(
  overview: CostsOverview,
  productId: string,
  nextWasteMinor: number | null,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseWaste = baseline.wasteOverridesMinor[productId] ?? null;
  const baseFxWaste = baseline.productFormulas[productId]?.waste;
  const normalized =
    nextWasteMinor === null
      ? null
      : clampNumber(Math.round(nextWasteMinor), 0, 1_000_000_000);
  return [
    {
      cellKey: productWasteCellKey(productId),
      value:
        normalized === baseWaste
          ? null
          : normalized === null
            ? "default"
            : String(normalized),
    },
    {
      cellKey: productFormulaCellKey(productId, "waste"),
      value: baseFxWaste !== undefined ? "default" : null,
    },
  ];
}

export function changesForProductFormula(
  overview: CostsOverview,
  productId: string,
  column: CostFormulaColumn,
  nextFormula: string | null,
): readonly CostsSheetCellChange[] {
  const baseline = hydrateFromOverview(overview);
  const baseFx = baseline.productFormulas[productId]?.[column] ?? null;
  const normalized =
    nextFormula === null || nextFormula.trim().length === 0
      ? null
      : normalizeFormulaExpression(nextFormula);
  return [
    {
      cellKey: productFormulaCellKey(productId, column),
      value:
        normalized === baseFx
          ? null
          : normalized === null
            ? "default"
            : normalized,
    },
  ];
}

export function changesForSupplyPatch(
  item: SupplyCostItem,
  defaultCurrency: string,
  patch: Partial<SupplyRowDraft>,
): readonly CostsSheetCellChange[] {
  const baseDraft = supplyDraftFromItem(item, defaultCurrency);
  const changes: CostsSheetCellChange[] = [];
  for (const field of SUPPLY_DRAFT_FIELDS) {
    const rawValue = patch[field];
    if (rawValue === undefined) continue;
    const cellKey = supplyFieldCellKey(item.id, field);
    const trimmed = String(rawValue).trim();
    if (trimmed === baseDraft[field].trim()) {
      changes.push({ cellKey, value: null });
    } else if (isCostsSheetCellEntry(cellKey, trimmed)) {
      changes.push({ cellKey, value: trimmed });
    }
  }
  return changes;
}

export function supplyDraftFromItem(
  item: SupplyCostItem,
  defaultCurrency: string,
): SupplyRowDraft {
  const digits = currencyDigits(item.costTerms?.currency ?? defaultCurrency);
  if (item.costTerms === null) {
    return {
      packQuantity: "1",
      packUnit: item.baseUnit,
      packPriceMajor: "",
      bulkMin7dQuantity: "",
      bulkPackQuantity: "",
      bulkPackPriceMajor: "",
    };
  }
  return {
    packQuantity: String(item.costTerms.packQuantity),
    packUnit: item.costTerms.packUnit,
    packPriceMajor: minorToMajorString(item.costTerms.packPriceMinor, digits),
    bulkMin7dQuantity:
      item.costTerms.bulkTier !== null
        ? String(item.costTerms.bulkTier.min7dQuantity)
        : "",
    bulkPackQuantity:
      item.costTerms.bulkTier !== null
        ? String(item.costTerms.bulkTier.packQuantity)
        : "",
    bulkPackPriceMajor:
      item.costTerms.bulkTier !== null
        ? minorToMajorString(item.costTerms.bulkTier.packPriceMinor, digits)
        : "",
  };
}

export function sameSupplyDraft(
  left: SupplyRowDraft,
  right: SupplyRowDraft,
): boolean {
  return (
    left.packQuantity.trim() === right.packQuantity.trim() &&
    left.packUnit === right.packUnit &&
    left.packPriceMajor.trim() === right.packPriceMajor.trim() &&
    left.bulkMin7dQuantity.trim() === right.bulkMin7dQuantity.trim() &&
    left.bulkPackQuantity.trim() === right.bulkPackQuantity.trim() &&
    left.bulkPackPriceMajor.trim() === right.bulkPackPriceMajor.trim()
  );
}

export function lotDraftFromLot(
  lot: SupplyLotCost,
  defaultCurrency: string,
): LotInvoiceRowDraft {
  if (lot.invoiceCost === null) {
    return {
      invoiceReference: "",
      invoiceTotalMajor: "",
    };
  }
  const digits = currencyDigits(lot.invoiceCost.currency || defaultCurrency);
  return {
    invoiceReference: lot.invoiceCost.invoiceReference ?? "",
    invoiceTotalMajor: minorToMajorString(
      lot.invoiceCost.invoiceTotalMinor,
      digits,
    ),
  };
}

export function sameLotDraft(
  left: LotInvoiceRowDraft,
  right: LotInvoiceRowDraft,
): boolean {
  return (
    left.invoiceReference.trim() === right.invoiceReference.trim() &&
    left.invoiceTotalMajor.trim() === right.invoiceTotalMajor.trim()
  );
}

export function changesForLotInvoicePatch(
  lot: SupplyLotCost,
  defaultCurrency: string,
  patch: Partial<LotInvoiceRowDraft>,
): readonly CostsSheetCellChange[] {
  const baseDraft = lotDraftFromLot(lot, defaultCurrency);
  const changes: CostsSheetCellChange[] = [];
  for (const field of LOT_DRAFT_FIELDS) {
    const rawValue = patch[field];
    if (rawValue === undefined) continue;
    const cellKey = lotInvoiceFieldCellKey(lot.id, field);
    const trimmed = String(rawValue).trim();
    if (trimmed === baseDraft[field].trim()) {
      changes.push({ cellKey, value: null });
    } else if (isCostsSheetCellEntry(cellKey, trimmed)) {
      changes.push({ cellKey, value: trimmed });
    }
  }
  return changes;
}

export function sameWeekUnits(left: WeekUnits, right: WeekUnits): boolean {
  for (let d = 0; d < 7; d += 1) {
    if (left[d] !== right[d]) return false;
  }
  return true;
}

export function sameWeekDemandPct(
  left: ForecastWeekDemandPct,
  right: ForecastWeekDemandPct,
): boolean {
  for (let w = 0; w < 12; w += 1) {
    if (left[w] !== right[w]) return false;
  }
  return true;
}

export function sameForecastPlan(
  left: CostForecastPlan,
  right: CostForecastPlan,
): boolean {
  return (
    left.openingCashMinor === right.openingCashMinor &&
    left.demandCurve === right.demandCurve &&
    left.supplierTerms === right.supplierTerms &&
    left.extraShiftThresholdPct === right.extraShiftThresholdPct &&
    left.extraShiftWeeklyMinor === right.extraShiftWeeklyMinor &&
    left.capexMinor === right.capexMinor &&
    sameWeekDemandPct(left.weekDemandPct, right.weekDemandPct)
  );
}

function projectForecastDraft(
  base: CostForecastPlan,
  cells: Readonly<Record<string, string>>,
): CostForecastPlan {
  const openingCashRaw = cells[FORECAST_OPENING_CASH_CELL_KEY];
  const openingCashMinor =
    openingCashRaw !== undefined && Number.isSafeInteger(Number(openingCashRaw))
      ? clampNumber(Number(openingCashRaw), 0, 10_000_000_000)
      : base.openingCashMinor;

  const curveRaw = cells[FORECAST_DEMAND_CURVE_CELL_KEY];
  const demandCurve: ForecastDemandCurve = isForecastDemandCurve(curveRaw)
    ? curveRaw
    : base.demandCurve;

  const baseWeeks: ForecastWeekDemandPct =
    curveRaw !== undefined &&
    demandCurve !== "custom" &&
    demandCurve !== base.demandCurve
      ? presetDemandCurveValues(demandCurve)
      : base.weekDemandPct;

  const mergedWeeks: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ] = [
    baseWeeks[0],
    baseWeeks[1],
    baseWeeks[2],
    baseWeeks[3],
    baseWeeks[4],
    baseWeeks[5],
    baseWeeks[6],
    baseWeeks[7],
    baseWeeks[8],
    baseWeeks[9],
    baseWeeks[10],
    baseWeeks[11],
  ];
  for (let w = 0; w < 12; w += 1) {
    const weekRaw = cells[forecastWeekIndexCellKey(w)];
    if (weekRaw !== undefined && Number.isSafeInteger(Number(weekRaw))) {
      mergedWeeks[w] = clampNumber(Number(weekRaw), 10, 500);
    }
  }

  const termsRaw = cells[FORECAST_SUPPLIER_TERMS_CELL_KEY];
  const supplierTerms: ForecastSupplierTerms = isForecastSupplierTerms(termsRaw)
    ? termsRaw
    : base.supplierTerms;

  const shiftThresholdRaw = cells[FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY];
  const extraShiftThresholdPct =
    shiftThresholdRaw !== undefined &&
    Number.isSafeInteger(Number(shiftThresholdRaw))
      ? clampNumber(Number(shiftThresholdRaw), 101, 400)
      : base.extraShiftThresholdPct;

  const shiftWeeklyRaw = cells[FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY];
  const extraShiftWeeklyMinor =
    shiftWeeklyRaw !== undefined && Number.isSafeInteger(Number(shiftWeeklyRaw))
      ? clampNumber(Number(shiftWeeklyRaw), 0, 10_000_000_000)
      : base.extraShiftWeeklyMinor;

  const capexRaw = cells[FORECAST_CAPEX_MINOR_CELL_KEY];
  const capexMinor =
    capexRaw !== undefined && Number.isSafeInteger(Number(capexRaw))
      ? clampNumber(Number(capexRaw), 0, 10_000_000_000)
      : base.capexMinor;

  return {
    openingCashMinor,
    demandCurve,
    weekDemandPct: mergedWeeks,
    supplierTerms,
    extraShiftThresholdPct,
    extraShiftWeeklyMinor,
    capexMinor,
  };
}

export function changesForForecastDemandCurve(
  overview: CostsOverview,
  nextCurve: Exclude<ForecastDemandCurve, "custom">,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  const presetWeeks = presetDemandCurveValues(nextCurve);
  const changes: CostsSheetCellChange[] = [
    {
      cellKey: FORECAST_DEMAND_CURVE_CELL_KEY,
      value: nextCurve === base.demandCurve ? null : nextCurve,
    },
  ];
  for (let w = 0; w < 12; w += 1) {
    const val = presetWeeks[w] ?? 100;
    const baseVal = base.weekDemandPct[w] ?? 100;
    changes.push({
      cellKey: forecastWeekIndexCellKey(w),
      value: val === baseVal ? null : String(val),
    });
  }
  return changes;
}

export function changesForForecastWeekDemandPct(
  overview: CostsOverview,
  currentForecast: CostForecastPlan,
  weekIndex: number,
  nextPct: number,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  const clamped = clampNumber(Math.round(nextPct), 10, 500);
  const changes: CostsSheetCellChange[] = [
    {
      cellKey: FORECAST_DEMAND_CURVE_CELL_KEY,
      value: base.demandCurve === "custom" ? null : "custom",
    },
  ];
  for (let w = 0; w < 12; w += 1) {
    const val = w === weekIndex ? clamped : (currentForecast.weekDemandPct[w] ?? 100);
    const baseVal = base.weekDemandPct[w] ?? 100;
    changes.push({
      cellKey: forecastWeekIndexCellKey(w),
      value: val === baseVal ? null : String(val),
    });
  }
  return changes;
}

export function changesForForecastSupplierTerms(
  overview: CostsOverview,
  nextTerms: ForecastSupplierTerms,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  return [
    {
      cellKey: FORECAST_SUPPLIER_TERMS_CELL_KEY,
      value: nextTerms === base.supplierTerms ? null : nextTerms,
    },
  ];
}

export function changesForForecastOpeningCashMinor(
  overview: CostsOverview,
  nextMinor: number,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  const clamped = clampNumber(Math.round(nextMinor), 0, 10_000_000_000);
  return [
    {
      cellKey: FORECAST_OPENING_CASH_CELL_KEY,
      value: clamped === base.openingCashMinor ? null : String(clamped),
    },
  ];
}

export function changesForForecastExtraShiftThresholdPct(
  overview: CostsOverview,
  nextPct: number,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  const clamped = clampNumber(Math.round(nextPct), 101, 400);
  return [
    {
      cellKey: FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
      value: clamped === base.extraShiftThresholdPct ? null : String(clamped),
    },
  ];
}

export function changesForForecastExtraShiftWeeklyMinor(
  overview: CostsOverview,
  nextMinor: number,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  const clamped = clampNumber(Math.round(nextMinor), 0, 10_000_000_000);
  return [
    {
      cellKey: FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
      value: clamped === base.extraShiftWeeklyMinor ? null : String(clamped),
    },
  ];
}

export function changesForForecastCapexMinor(
  overview: CostsOverview,
  nextMinor: number,
): readonly CostsSheetCellChange[] {
  const base = hydrateFromOverview(overview).forecast;
  const clamped = clampNumber(Math.round(nextMinor), 0, 10_000_000_000);
  return [
    {
      cellKey: FORECAST_CAPEX_MINOR_CELL_KEY,
      value: clamped === base.capexMinor ? null : String(clamped),
    },
  ];
}

function isForecastDemandCurve(
  value: string | undefined,
): value is ForecastDemandCurve {
  return (
    value === "steady" ||
    value === "seasonal_holiday" ||
    value === "growth_ramp" ||
    value === "winter_dip" ||
    value === "custom"
  );
}

function isForecastSupplierTerms(
  value: string | undefined,
): value is ForecastSupplierTerms {
  return value === "cod" || value === "net_15" || value === "net_30";
}

export function minorToMajorString(amountMinor: number, digits: number): string {
  if (digits === 0) return String(Math.round(amountMinor));
  return (amountMinor / 10 ** digits).toFixed(digits);
}

export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function sumWeek(week: WeekUnits): number {
  return (
    week[0] + week[1] + week[2] + week[3] + week[4] + week[5] + week[6]
  );
}

function formatPctCell(value: number, max: number): string {
  const clamped = clampNumber(value, 0, max);
  return String(Number(clamped.toFixed(2)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isCostUnit(value: string): value is CostUnit {
  return (
    value === "each" ||
    value === "gram" ||
    value === "kilogram" ||
    value === "milliliter" ||
    value === "liter"
  );
}

function isLotCostBasis(value: string | undefined): value is CostValuationBasis {
  return (
    value === "standing" || value === "fifo_lot" || value === "weighted_lot"
  );
}
