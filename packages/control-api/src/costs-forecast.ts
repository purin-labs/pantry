import { Type, type Static } from "typebox";
import {
  calculateBakeryCostsAndMargins,
  defaultCostAssumptions,
  type CostScenarioAssumptions,
  type CostsOverview,
  type OrganisationCostPlan,
  type SupplyLotCost,
} from "./costs";

const nonNegativeInt = Type.Integer({ minimum: 0 });

export const FORECAST_HORIZON_WEEKS = 12;

export const forecastDemandCurveSchema = Type.Union([
  Type.Literal("steady"),
  Type.Literal("seasonal_holiday"),
  Type.Literal("growth_ramp"),
  Type.Literal("winter_dip"),
  Type.Literal("custom"),
]);

export type ForecastDemandCurve = Static<typeof forecastDemandCurveSchema>;

export const forecastSupplierTermsSchema = Type.Union([
  Type.Literal("cod"),
  Type.Literal("net_15"),
  Type.Literal("net_30"),
]);

export type ForecastSupplierTerms = Static<typeof forecastSupplierTermsSchema>;

const weekDemandPctItem = Type.Integer({ minimum: 10, maximum: 500 });

export const forecastWeekDemandPctSchema = Type.Tuple([
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
  weekDemandPctItem,
]);

export type ForecastWeekDemandPct = Static<typeof forecastWeekDemandPctSchema>;

export const costForecastPlanSchema = Type.Object({
  openingCashMinor: nonNegativeInt,
  demandCurve: forecastDemandCurveSchema,
  weekDemandPct: forecastWeekDemandPctSchema,
  supplierTerms: forecastSupplierTermsSchema,
  extraShiftThresholdPct: Type.Integer({ minimum: 101, maximum: 400 }),
  extraShiftWeeklyMinor: nonNegativeInt,
  capexMinor: nonNegativeInt,
});

export type CostForecastPlan = Static<typeof costForecastPlanSchema>;

const ZERO_DECIMAL_FORECAST_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export const PRESET_FORECAST_DEMAND_CURVES: Readonly<
  Record<Exclude<ForecastDemandCurve, "custom">, ForecastWeekDemandPct>
> = {
  steady: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  seasonal_holiday: [
    100, 103, 105, 118, 135, 142, 86, 98, 100, 102, 108, 120,
  ],
  growth_ramp: [100, 103, 106, 109, 112, 115, 118, 121, 124, 127, 130, 134],
  winter_dip: [100, 96, 92, 88, 85, 85, 88, 92, 95, 98, 100, 102],
};

export function presetDemandCurveValues(
  curve: Exclude<ForecastDemandCurve, "custom">,
): ForecastWeekDemandPct {
  const src = PRESET_FORECAST_DEMAND_CURVES[curve];
  return [
    src[0],
    src[1],
    src[2],
    src[3],
    src[4],
    src[5],
    src[6],
    src[7],
    src[8],
    src[9],
    src[10],
    src[11],
  ];
}

export function defaultCostForecastPlan(currency = "JPY"): CostForecastPlan {
  const isZeroDecimal = ZERO_DECIMAL_FORECAST_CURRENCIES.has(
    currency.toUpperCase(),
  );
  return {
    openingCashMinor: isZeroDecimal ? 6_400_000 : 4_500_000,
    demandCurve: "seasonal_holiday",
    weekDemandPct: presetDemandCurveValues("seasonal_holiday"),
    supplierTerms: "net_30",
    extraShiftThresholdPct: 125,
    extraShiftWeeklyMinor: isZeroDecimal ? 116_000 : 80_000,
    capexMinor: 0,
  };
}

export function normalizeCostForecastPlan(
  raw: Partial<CostForecastPlan> | null | undefined,
  currency = "JPY",
): CostForecastPlan {
  const fallback = defaultCostForecastPlan(currency);
  if (raw === null || raw === undefined) {
    return fallback;
  }
  const demandCurve: ForecastDemandCurve =
    raw.demandCurve === "steady" ||
    raw.demandCurve === "seasonal_holiday" ||
    raw.demandCurve === "growth_ramp" ||
    raw.demandCurve === "winter_dip" ||
    raw.demandCurve === "custom"
      ? raw.demandCurve
      : fallback.demandCurve;

  const weekDemandPct: ForecastWeekDemandPct =
    demandCurve !== "custom"
      ? presetDemandCurveValues(demandCurve)
      : [
          clampForecastInt(
            raw.weekDemandPct?.[0] ?? fallback.weekDemandPct[0],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[1] ?? fallback.weekDemandPct[1],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[2] ?? fallback.weekDemandPct[2],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[3] ?? fallback.weekDemandPct[3],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[4] ?? fallback.weekDemandPct[4],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[5] ?? fallback.weekDemandPct[5],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[6] ?? fallback.weekDemandPct[6],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[7] ?? fallback.weekDemandPct[7],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[8] ?? fallback.weekDemandPct[8],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[9] ?? fallback.weekDemandPct[9],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[10] ?? fallback.weekDemandPct[10],
            10,
            500,
          ),
          clampForecastInt(
            raw.weekDemandPct?.[11] ?? fallback.weekDemandPct[11],
            10,
            500,
          ),
        ];

  const supplierTerms: ForecastSupplierTerms =
    raw.supplierTerms === "cod" ||
    raw.supplierTerms === "net_15" ||
    raw.supplierTerms === "net_30"
      ? raw.supplierTerms
      : fallback.supplierTerms;

  return {
    openingCashMinor: clampForecastInt(
      raw.openingCashMinor ?? fallback.openingCashMinor,
      0,
      10_000_000_000,
    ),
    demandCurve,
    weekDemandPct,
    supplierTerms,
    extraShiftThresholdPct: clampForecastInt(
      raw.extraShiftThresholdPct ?? fallback.extraShiftThresholdPct,
      101,
      400,
    ),
    extraShiftWeeklyMinor: clampForecastInt(
      raw.extraShiftWeeklyMinor ?? fallback.extraShiftWeeklyMinor,
      0,
      10_000_000_000,
    ),
    capexMinor: clampForecastInt(
      raw.capexMinor ?? fallback.capexMinor,
      0,
      10_000_000_000,
    ),
  };
}

export type ForecastWeekColumn = Readonly<{
  weekIndex: number;
  weekCode: string;
  shortLabel: string;
  milestoneTag: string | null;
  demandIndexPct: number;
  plannedUnits: number;
  grossSalesMinor: number;
  includedTaxMinor: number;
  channelFeeMinor: number;
  cogsMinor: number;
  wasteMinor: number;
  wasteTaxFeeMinor: number;
  grossContributionMinor: number;
  laborMinor: number;
  extraShiftActive: boolean;
  accrualRentMinor: number;
  operatingProfitMinor: number;
  operatingMarginPct: number;
  unlockedBulkTierCount: number;
  extraBulkTiersUnlocked: number;
  weeklyTierSavingsMinor: number;
  cashInMinor: number;
  supplierCashOutMinor: number;
  rentCashOutMinor: number;
  capexCashOutMinor: number;
  lumpOutflowMinor: number;
  netCashFlowMinor: number;
  endingCashMinor: number;
}>;

export type ForecastSummary = Readonly<{
  currency: string;
  horizonWeeks: number;
  openingCashMinor: number;
  demandCurve: ForecastDemandCurve;
  supplierTerms: ForecastSupplierTerms;
  extraShiftThresholdPct: number;
  extraShiftWeeklyMinor: number;
  capexMinor: number;
  openPayablesIncludedMinor: number;
  averageDemandIndexPct: number;
  peakDemandWeekCode: string;
  peakDemandIndexPct: number;
  totalPlannedUnits: number;
  totalGrossSalesMinor: number;
  totalCogsMinor: number;
  totalWasteTaxFeeMinor: number;
  totalGrossContributionMinor: number;
  totalLaborMinor: number;
  extraShiftWeeksCount: number;
  totalAccrualRentMinor: number;
  totalOperatingProfitMinor: number;
  operatingMarginPct: number;
  totalBulkTierSavingsMinor: number;
  peakExtraBulkTiersUnlocked: number;
  lowestCashMinor: number;
  lowestCashWeekIndex: number;
  lowestCashWeekCode: string;
  lowestCashReason: string;
  hasCashShortfall: boolean;
  endingCashMinor: number;
  netCashBuildMinor: number;
  endingPayablesBalanceMinor: number;
  weeklyBreakEvenUnits: number | null;
  capexPaybackWeeks: number | null;
}>;

export type Bakery12WeekForecastCalculation = Readonly<{
  plan: CostForecastPlan;
  weeks: readonly ForecastWeekColumn[];
  summary: ForecastSummary;
}>;

export type Bakery12WeekForecastInput = Readonly<{
  overview: Pick<
    CostsOverview,
    | "currency"
    | "defaultIncludedTaxBps"
    | "recipes"
    | "items"
    | "products"
    | "measuredWaste"
  > & {
    readonly costPlan?: OrganisationCostPlan;
    readonly lots?: readonly SupplyLotCost[];
    readonly actuals?: CostsOverview["actuals"];
  };
  forecastPlan?: Partial<CostForecastPlan>;
  weeklyTargets?: Readonly<Record<string, readonly number[]>>;
  productSpoilagePctOverrides?: Readonly<Record<string, number>>;
  priceOverridesMinor?: Readonly<Record<string, number>>;
  cogsOverridesMinor?: Readonly<Record<string, number | null>>;
  wasteOverridesMinor?: Readonly<Record<string, number | null>>;
  productFormulas?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  dailyLaborMinor?: number;
  dailyRentMinor?: number;
  assumptions?: Partial<CostScenarioAssumptions>;
  startDateIso?: string;
}>;

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function calculateBakery12WeekForecast(
  input: Bakery12WeekForecastInput,
): Bakery12WeekForecastCalculation {
  const { currency } = input.overview;
  const mergedPlan = normalizeCostForecastPlan(
    {
      ...input.overview.costPlan?.forecast,
      ...input.forecastPlan,
    },
    currency,
  );
  const defaults = defaultCostAssumptions(input.overview);
  const assumptions: CostScenarioAssumptions = {
    ...defaults,
    ...input.assumptions,
  };

  const baseDailyLaborMinor = clampForecastInt(
    input.dailyLaborMinor ?? input.overview.costPlan?.dailyLaborMinor ?? 0,
    0,
    1_000_000_000,
  );
  const baseDailyRentMinor = clampForecastInt(
    input.dailyRentMinor ?? input.overview.costPlan?.dailyRentMinor ?? 0,
    0,
    1_000_000_000,
  );

  // Baseline 100% weekly calculation to capture each SKU's Mon..Sun unit baseline & bulk tiers.
  const baselineCalc = calculateBakeryCostsAndMargins({
    overview: input.overview,
    demandMode: "weekly",
    ...(input.weeklyTargets !== undefined
      ? { weeklyTargets: input.weeklyTargets }
      : {}),
    ...(input.productSpoilagePctOverrides !== undefined
      ? { productSpoilagePctOverrides: input.productSpoilagePctOverrides }
      : {}),
    ...(input.priceOverridesMinor !== undefined
      ? { priceOverridesMinor: input.priceOverridesMinor }
      : {}),
    ...(input.cogsOverridesMinor !== undefined
      ? { cogsOverridesMinor: input.cogsOverridesMinor }
      : {}),
    ...(input.wasteOverridesMinor !== undefined
      ? { wasteOverridesMinor: input.wasteOverridesMinor }
      : {}),
    ...(input.productFormulas !== undefined
      ? { productFormulas: input.productFormulas }
      : {}),
    dailyLaborMinor: baseDailyLaborMinor,
    dailyRentMinor: baseDailyRentMinor,
    assumptions,
  });

  const baseWeekUnitsByProduct = new Map<string, readonly number[]>();
  for (const prod of baselineCalc.products) {
    baseWeekUnitsByProduct.set(prod.productId, prod.weekUnits);
  }

  const baselineSupplyPurchaseMinor = Math.round(
    (baselineCalc.summary.dailyIngredientSpendMinor +
      baselineCalc.summary.dailyPackagingSpendMinor +
      baselineCalc.summary.dailyWasteSpendMinor) *
      7,
  );
  const baselineUnlockedBulkCount = baselineCalc.summary.unlockedBulkTierCount;
  const weeklyBreakEvenUnits =
    baselineCalc.summary.breakEvenUnitsPerDay !== null
      ? Math.ceil(baselineCalc.summary.breakEvenUnitsPerDay * 7)
      : null;

  // Existing open D1 supplier payables settle on the first payable cycle.
  const openPayablesIncludedMinor = Math.round(
    input.overview.actuals?.windows.find((w) => w.windowDays === 30)
      ?.openPayablesMinor ??
      input.overview.actuals?.windows[0]?.openPayablesMinor ??
      0,
  );

  const anchorMs = resolveForecastStartMondayMs(
    input.startDateIso ??
      input.overview.actuals?.windows[0]?.windowEndAt ??
      null,
  );

  // First pass: compute weekly accrual P&L and supply purchase requirements across W1..W12.
  const rawWeeks: Array<{
    weekIndex: number;
    weekCode: string;
    shortLabel: string;
    demandIndexPct: number;
    plannedUnits: number;
    grossSalesMinor: number;
    includedTaxMinor: number;
    channelFeeMinor: number;
    cogsMinor: number;
    wasteMinor: number;
    wasteTaxFeeMinor: number;
    grossContributionMinor: number;
    laborMinor: number;
    extraShiftActive: boolean;
    accrualRentMinor: number;
    operatingProfitMinor: number;
    operatingMarginPct: number;
    unlockedBulkTierCount: number;
    extraBulkTiersUnlocked: number;
    weeklyTierSavingsMinor: number;
    supplyPurchaseMinor: number;
  }> = [];

  for (let w = 0; w < FORECAST_HORIZON_WEEKS; w += 1) {
    const demandIndexPct = mergedPlan.weekDemandPct[w] ?? 100;
    const scale = demandIndexPct / 100;

    const scaledWeeklyTargets: Record<string, readonly number[]> = {};
    for (const [productId, days] of baseWeekUnitsByProduct) {
      scaledWeeklyTargets[productId] = days.map((u) =>
        Math.max(0, Math.round(u * scale)),
      );
    }

    const scaledFormulaOverrides: Record<string, Record<string, string>> = {};
    for (const prod of baselineCalc.products) {
      if (prod.activeFormulas.units !== undefined) {
        const rest: Record<string, string> = {};
        for (const [col, expr] of Object.entries(prod.activeFormulas)) {
          if (col !== "units") {
            rest[col] = expr;
          }
        }
        scaledFormulaOverrides[prod.productId] = rest;
      } else if (Object.keys(prod.activeFormulas).length > 0) {
        scaledFormulaOverrides[prod.productId] = { ...prod.activeFormulas };
      }
    }

    const weekCalc = calculateBakeryCostsAndMargins({
      overview: input.overview,
      demandMode: "weekly",
      weeklyTargets: scaledWeeklyTargets,
      ...(input.productSpoilagePctOverrides !== undefined
        ? { productSpoilagePctOverrides: input.productSpoilagePctOverrides }
        : {}),
      ...(input.priceOverridesMinor !== undefined
        ? { priceOverridesMinor: input.priceOverridesMinor }
        : {}),
      ...(input.cogsOverridesMinor !== undefined
        ? { cogsOverridesMinor: input.cogsOverridesMinor }
        : {}),
      ...(input.wasteOverridesMinor !== undefined
        ? { wasteOverridesMinor: input.wasteOverridesMinor }
        : {}),
      productFormulas: scaledFormulaOverrides,
      dailyLaborMinor: 0,
      dailyRentMinor: 0,
      assumptions,
    });

    const plannedUnits = weekCalc.products.reduce(
      (sum, row) => sum + row.weekUnits.reduce((s, d) => s + d, 0),
      0,
    );
    const grossSalesMinor = Math.round(
      weekCalc.summary.dailyGrossRevenueMinor * 7,
    );
    const netExTaxMinor = Math.round(
      weekCalc.summary.dailyNetExTaxRevenueMinor * 7,
    );
    const includedTaxMinor = Math.max(0, grossSalesMinor - netExTaxMinor);
    const channelFeeMinor = Math.round(
      weekCalc.summary.dailyChannelFeeMinor * 7,
    );
    const cogsMinor = Math.round(
      (weekCalc.summary.dailyIngredientSpendMinor +
        weekCalc.summary.dailyPackagingSpendMinor) *
        7,
    );
    const wasteMinor = Math.round(weekCalc.summary.dailyWasteSpendMinor * 7);
    const wasteTaxFeeMinor = wasteMinor + includedTaxMinor + channelFeeMinor;
    const grossContributionMinor =
      grossSalesMinor - cogsMinor - wasteTaxFeeMinor;

    const extraShiftActive =
      demandIndexPct >= mergedPlan.extraShiftThresholdPct &&
      mergedPlan.extraShiftWeeklyMinor > 0;
    const laborMinor =
      baseDailyLaborMinor * 7 +
      (extraShiftActive ? mergedPlan.extraShiftWeeklyMinor : 0);
    const accrualRentMinor = baseDailyRentMinor * 7;
    const operatingProfitMinor =
      grossContributionMinor - laborMinor - accrualRentMinor;
    const operatingMarginPct =
      grossSalesMinor > 0
        ? roundForecast2((operatingProfitMinor / grossSalesMinor) * 100)
        : 0;

    const unlockedBulkTierCount = weekCalc.summary.unlockedBulkTierCount;
    const extraBulkTiersUnlocked = Math.max(
      0,
      unlockedBulkTierCount - baselineUnlockedBulkCount,
    );
    const weeklyTierSavingsMinor = Math.round(
      weekCalc.summary.dailyTierSavingsMinor * 7,
    );

    const weekStart = new Date(anchorMs + w * 7 * 86_400_000);
    const monthName = MONTH_ABBR[weekStart.getUTCMonth()] ?? "Jan";
    const dayNum = weekStart.getUTCDate();
    const weekCode = `W${w + 1}`;
    const shortLabel = `${weekCode} ${monthName} ${dayNum}`;

    rawWeeks.push({
      weekIndex: w,
      weekCode,
      shortLabel,
      demandIndexPct,
      plannedUnits,
      grossSalesMinor,
      includedTaxMinor,
      channelFeeMinor,
      cogsMinor,
      wasteMinor,
      wasteTaxFeeMinor,
      grossContributionMinor,
      laborMinor,
      extraShiftActive,
      accrualRentMinor,
      operatingProfitMinor,
      operatingMarginPct,
      unlockedBulkTierCount,
      extraBulkTiersUnlocked,
      weeklyTierSavingsMinor,
      supplyPurchaseMinor: cogsMinor + wasteMinor,
    });
  }

  // Find peak week for milestone tagging.
  let peakIdx = 0;
  for (let w = 1; w < rawWeeks.length; w += 1) {
    if ((rawWeeks[w]?.demandIndexPct ?? 0) > (rawWeeks[peakIdx]?.demandIndexPct ?? 0)) {
      peakIdx = w;
    }
  }

  // Second pass: simulate weekly bank cash inflows, supplier terms, monthly rent lump sums, and capex.
  const weeks: ForecastWeekColumn[] = [];
  let runningCashMinor = mergedPlan.openingCashMinor;
  let lowestCashMinor = mergedPlan.openingCashMinor;
  let lowestCashWeekIndex = 0;
  let lowestCashReason = "Opening balance";
  let cumulativeOpCashForCapex = 0;
  let capexPaybackWeeks: number | null = null;
  let totalSupplyPurchasedMinor = 0;
  let totalNewSupplyPaidMinor = 0;

  for (let w = 0; w < rawWeeks.length; w += 1) {
    const rw = rawWeeks[w]!;
    totalSupplyPurchasedMinor += rw.supplyPurchaseMinor;

    // Monthly rent pays on 4-week month-end cycle: W3 (w=2), W7 (w=6), W11 (w=10).
    const isRentWeek = w === 2 || w === 6 || w === 10;
    const rentCashOutMinor = isRentWeek ? baseDailyRentMinor * 28 : 0;

    let supplierCashOutMinor = 0;
    if (mergedPlan.supplierTerms === "cod") {
      supplierCashOutMinor =
        rw.supplyPurchaseMinor + (w === 0 ? openPayablesIncludedMinor : 0);
      totalNewSupplyPaidMinor += rw.supplyPurchaseMinor;
    } else if (mergedPlan.supplierTerms === "net_15") {
      if (w === 0) {
        supplierCashOutMinor = baselineSupplyPurchaseMinor;
      } else if (w === 1) {
        supplierCashOutMinor =
          baselineSupplyPurchaseMinor + openPayablesIncludedMinor;
      } else {
        const settled = rawWeeks[w - 2]!.supplyPurchaseMinor;
        supplierCashOutMinor = settled;
        totalNewSupplyPaidMinor += settled;
      }
    } else {
      // net_30: monthly closing & month-end settlement on W3, W7, W11 alongside monthly rent.
      if (w === 2) {
        const w0w1 =
          (rawWeeks[0]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[1]?.supplyPurchaseMinor ?? 0);
        supplierCashOutMinor =
          baselineSupplyPurchaseMinor * 2 + w0w1 + openPayablesIncludedMinor;
        totalNewSupplyPaidMinor += w0w1;
      } else if (w === 6) {
        const w2to5 =
          (rawWeeks[2]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[3]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[4]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[5]?.supplyPurchaseMinor ?? 0);
        supplierCashOutMinor = w2to5;
        totalNewSupplyPaidMinor += w2to5;
      } else if (w === 10) {
        const w6to9 =
          (rawWeeks[6]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[7]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[8]?.supplyPurchaseMinor ?? 0) +
          (rawWeeks[9]?.supplyPurchaseMinor ?? 0);
        supplierCashOutMinor = w6to9;
        totalNewSupplyPaidMinor += w6to9;
      }
    }

    const capexCashOutMinor = w === 0 ? mergedPlan.capexMinor : 0;
    const cashInMinor =
      rw.grossSalesMinor - rw.includedTaxMinor - rw.channelFeeMinor;
    const totalCashOutMinor =
      rw.laborMinor +
      supplierCashOutMinor +
      rentCashOutMinor +
      capexCashOutMinor;
    const netCashFlowMinor = cashInMinor - totalCashOutMinor;
    runningCashMinor += netCashFlowMinor;

    const lumpOutflowMinor =
      rentCashOutMinor +
      capexCashOutMinor +
      (mergedPlan.supplierTerms === "net_30" ? supplierCashOutMinor : 0);

    if (w === 0 || runningCashMinor < lowestCashMinor) {
      lowestCashMinor = runningCashMinor;
      lowestCashWeekIndex = w;
      if (capexCashOutMinor > 0 && w === 0) {
        lowestCashReason = "Equipment capex outflow";
      } else if (isRentWeek && mergedPlan.supplierTerms === "net_30") {
        lowestCashReason = "Monthly rent + Net-30 bills";
      } else if (isRentWeek) {
        lowestCashReason = "Monthly rent payment";
      } else if (rw.operatingProfitMinor < 0) {
        lowestCashReason = "Operating loss week";
      } else {
        lowestCashReason = "Seasonal working capital";
      }
    }

    if (mergedPlan.capexMinor > 0 && capexPaybackWeeks === null) {
      if (rw.operatingProfitMinor > 0) {
        const prevCum = cumulativeOpCashForCapex;
        cumulativeOpCashForCapex += rw.operatingProfitMinor;
        if (cumulativeOpCashForCapex >= mergedPlan.capexMinor) {
          const needed = mergedPlan.capexMinor - prevCum;
          capexPaybackWeeks = roundForecast2(
            w + needed / rw.operatingProfitMinor,
          );
        }
      }
    }

    let milestoneTag: string | null = null;
    if (w === peakIdx && rw.demandIndexPct > 100) {
      milestoneTag = "Peak";
    } else if (rw.extraShiftActive) {
      milestoneTag = "+Shift";
    } else if (isRentWeek) {
      milestoneTag = "Rent";
    } else if (capexCashOutMinor > 0) {
      milestoneTag = "Capex";
    }

    weeks.push({
      weekIndex: rw.weekIndex,
      weekCode: rw.weekCode,
      shortLabel: rw.shortLabel,
      milestoneTag,
      demandIndexPct: rw.demandIndexPct,
      plannedUnits: rw.plannedUnits,
      grossSalesMinor: rw.grossSalesMinor,
      includedTaxMinor: rw.includedTaxMinor,
      channelFeeMinor: rw.channelFeeMinor,
      cogsMinor: rw.cogsMinor,
      wasteMinor: rw.wasteMinor,
      wasteTaxFeeMinor: rw.wasteTaxFeeMinor,
      grossContributionMinor: rw.grossContributionMinor,
      laborMinor: rw.laborMinor,
      extraShiftActive: rw.extraShiftActive,
      accrualRentMinor: rw.accrualRentMinor,
      operatingProfitMinor: rw.operatingProfitMinor,
      operatingMarginPct: rw.operatingMarginPct,
      unlockedBulkTierCount: rw.unlockedBulkTierCount,
      extraBulkTiersUnlocked: rw.extraBulkTiersUnlocked,
      weeklyTierSavingsMinor: rw.weeklyTierSavingsMinor,
      cashInMinor,
      supplierCashOutMinor,
      rentCashOutMinor,
      capexCashOutMinor,
      lumpOutflowMinor,
      netCashFlowMinor,
      endingCashMinor: runningCashMinor,
    });
  }

  const totalPlannedUnits = weeks.reduce((s, w) => s + w.plannedUnits, 0);
  const totalGrossSalesMinor = weeks.reduce((s, w) => s + w.grossSalesMinor, 0);
  const totalCogsMinor = weeks.reduce((s, w) => s + w.cogsMinor, 0);
  const totalWasteTaxFeeMinor = weeks.reduce(
    (s, w) => s + w.wasteTaxFeeMinor,
    0,
  );
  const totalGrossContributionMinor = weeks.reduce(
    (s, w) => s + w.grossContributionMinor,
    0,
  );
  const totalLaborMinor = weeks.reduce((s, w) => s + w.laborMinor, 0);
  const extraShiftWeeksCount = weeks.filter((w) => w.extraShiftActive).length;
  const totalAccrualRentMinor = weeks.reduce(
    (s, w) => s + w.accrualRentMinor,
    0,
  );
  const totalOperatingProfitMinor = weeks.reduce(
    (s, w) => s + w.operatingProfitMinor,
    0,
  );
  const operatingMarginPct =
    totalGrossSalesMinor > 0
      ? roundForecast2((totalOperatingProfitMinor / totalGrossSalesMinor) * 100)
      : 0;
  const totalBulkTierSavingsMinor = weeks.reduce(
    (s, w) => s + w.weeklyTierSavingsMinor,
    0,
  );
  const peakExtraBulkTiersUnlocked = weeks.reduce(
    (max, w) => Math.max(max, w.extraBulkTiersUnlocked),
    0,
  );
  const averageDemandIndexPct = roundForecast2(
    weeks.reduce((s, w) => s + w.demandIndexPct, 0) / weeks.length,
  );
  const endingPayablesBalanceMinor = Math.max(
    0,
    totalSupplyPurchasedMinor - totalNewSupplyPaidMinor,
  );

  return {
    plan: mergedPlan,
    weeks,
    summary: {
      currency,
      horizonWeeks: FORECAST_HORIZON_WEEKS,
      openingCashMinor: mergedPlan.openingCashMinor,
      demandCurve: mergedPlan.demandCurve,
      supplierTerms: mergedPlan.supplierTerms,
      extraShiftThresholdPct: mergedPlan.extraShiftThresholdPct,
      extraShiftWeeklyMinor: mergedPlan.extraShiftWeeklyMinor,
      capexMinor: mergedPlan.capexMinor,
      openPayablesIncludedMinor,
      averageDemandIndexPct,
      peakDemandWeekCode: weeks[peakIdx]?.weekCode ?? "W1",
      peakDemandIndexPct: weeks[peakIdx]?.demandIndexPct ?? 100,
      totalPlannedUnits,
      totalGrossSalesMinor,
      totalCogsMinor,
      totalWasteTaxFeeMinor,
      totalGrossContributionMinor,
      totalLaborMinor,
      extraShiftWeeksCount,
      totalAccrualRentMinor,
      totalOperatingProfitMinor,
      operatingMarginPct,
      totalBulkTierSavingsMinor,
      peakExtraBulkTiersUnlocked,
      lowestCashMinor,
      lowestCashWeekIndex,
      lowestCashWeekCode: weeks[lowestCashWeekIndex]?.weekCode ?? "W1",
      lowestCashReason,
      hasCashShortfall: lowestCashMinor < 0,
      endingCashMinor: runningCashMinor,
      netCashBuildMinor: runningCashMinor - mergedPlan.openingCashMinor,
      endingPayablesBalanceMinor,
      weeklyBreakEvenUnits,
      capexPaybackWeeks,
    },
  };
}

function resolveForecastStartMondayMs(isoOrNull: string | null): number {
  const parsed = isoOrNull !== null ? Date.parse(isoOrNull) : Number.NaN;
  const base = Number.isFinite(parsed) ? new Date(parsed) : new Date(Date.UTC(2026, 10, 9));
  const utcMidnight = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
  );
  const dayOfWeek = new Date(utcMidnight).getUTCDay(); // 0=Sun, 1=Mon...
  const daysUntilNextMonday = dayOfWeek === 1 ? 0 : dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  return utcMidnight + daysUntilNextMonday * 86_400_000;
}

function clampForecastInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function roundForecast2(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}
