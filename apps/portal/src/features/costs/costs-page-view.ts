import type {
  Bakery12WeekForecastCalculation,
  BakeryCostCalculation,
  BakeryPlanVsActualsCalculation,
  CalculatedProductMargin,
  MeasuredWasteSummary,
  PortalPageViewFact,
  PortalPageViewSection,
  PortalPageViewV1,
  ProductPlanVsActualRow,
  SupplyCostItem,
} from "@seams/control-api";
import type { CostsSheetTab } from "@seams/costs-sheet-crdt";
import { formatMoneyMinor } from "../../formatting";
import {
  registerSurfaceView,
  type SurfaceCommandOutcome,
  type SurfaceViewSource,
} from "../surface-observation";
import type { CostsViewCommand } from "@seams/control-api";
import { COSTS_COMMANDS } from "./costs-view-commands";
import { formatCostQuantity } from "./api";
import type { PresetId, ProjectedCostsSheet } from "./costs-sheet-draft";

/** The values that the Costs & margins page computes for one render. */
export type CostsPageSnapshot = Readonly<{
  state: Readonly<{
    tab: CostsSheetTab;
    sectionFilter: string;
    search: string;
    bomOpen: boolean;
    expandedProductIds?: ReadonlySet<string>;
    overview: Readonly<{ measuredWaste: MeasuredWasteSummary }>;
  }>;
  projected: ProjectedCostsSheet;
  calculation: BakeryCostCalculation;
  selectedProduct: CalculatedProductMargin | null;
  /** True when the sheet holds edits that are not saved. */
  unsaved: boolean;
  /** The product rows after the category filter and the search. */
  products: readonly CalculatedProductMargin[];
  /** Plan vs actuals calculation and filtered rows when available. */
  actuals?: BakeryPlanVsActualsCalculation;
  actualsRows?: readonly ProductPlanVsActualRow[];
  /** 12-week rolling P&L and cash runway calculation when available. */
  forecast?: Bakery12WeekForecastCalculation;
  /** The supply rows after the search. */
  supplies: readonly SupplyCostItem[];
}>;

/**
 * The Costs & margins page as the chat sees it. The page sets the snapshot
 * on each render; the chat reads it when the person sends a message.
 */
export class CostsPageViewSource implements SurfaceViewSource {
  snapshot: CostsPageSnapshot | null = null;
  private unregisterView: (() => void) | null = null;

  constructor(
    private readonly page: Readonly<{
      props: Readonly<{ organisationId: string }>;
      runViewCommand(command: CostsViewCommand): Promise<SurfaceCommandOutcome>;
    }>,
  ) {}

  surfaceCommands(): readonly string[] {
    return this.snapshot === null ? [] : COSTS_COMMANDS;
  }

  runSurfaceCommand(command: CostsViewCommand): Promise<SurfaceCommandOutcome> {
    return this.page.runViewCommand(command);
  }

  pageOrganisationId(): string {
    return this.page.props.organisationId;
  }

  surfacePage(): "costs" {
    return "costs";
  }

  capturePageView(): PortalPageViewV1 | null {
    return this.snapshot === null
      ? null
      : costsPageView(this.snapshot, window.location.pathname);
  }

  register(): void {
    this.unregisterView ??= registerSurfaceView(this);
  }

  unregister(): void {
    this.unregisterView?.();
    this.unregisterView = null;
    this.snapshot = null;
  }
}

const TAB_TITLES: Readonly<Record<CostsSheetTab, string>> = {
  margins: "1. Product Margins",
  weekly: "2. Mon–Sun Plan (7d)",
  actuals: "3. Plan vs Actuals",
  forecast: "4. 12-Week P&L & Cash",
  supplies: "5. Supplier Pack Prices",
};

const PRESET_TITLES: Readonly<Record<PresetId, string>> = {
  saved: "Saved plan",
  weekend: "Weekend ×1.5",
  rainy: "Rainy ×0.7",
  custom: "Custom",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Every tab of the page, also the ones that are not open. The relevance check
 * of Plan 87 section 3A reads only section titles, so the title names the
 * tabs: a question about supplier packs matches the page from any tab.
 */
const TABS_SECTION: PortalPageViewSection = {
  title:
    "Tabs: Product margins, Weekly plan, Plan vs actuals, 12-week P&L & cash, Supplier packs",
  facts: [
    {
      label: "Product margins",
      value: "price, COGS, waste, tax and margin for each product",
    },
    { label: "Weekly plan", value: "units for each weekday, Mon to Sun" },
    {
      label: "Plan vs actuals",
      value:
        "7d and 30d margin bridge comparing planned targets against POS + online orders, lot invoices and bake/shelf waste",
    },
    {
      label: "12-week P&L & cash",
      value:
        "12-week rolling seasonality demand, bulk-tier unlocks, step shift labor, supplier terms, monthly rent, cash trough and equipment capex payback",
    },
    {
      label: "Supplier packs",
      value:
        "supplier pack prices, volume tiers, stock coverage, SKU reach and lot costs",
    },
  ],
  table: null,
};

export function costsPageView(
  snapshot: CostsPageSnapshot,
  path: string,
): PortalPageViewV1 {
  return {
    kind: "portal-page-view",
    schemaVersion: 1,
    page: "costs",
    title: "Costs & margins",
    path,
    capturedAt: Date.now(),
    sections: [
      viewSection(snapshot),
      TABS_SECTION,
      scenarioSection(snapshot),
      summarySection(snapshot.calculation),
      tableSection(snapshot),
    ],
  };
}

function viewSection(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const state = snapshot.state;
  const facts: PortalPageViewFact[] = [
    { label: "Open tab", value: TAB_TITLES[state.tab] },
    {
      label: "Category filter",
      value: state.sectionFilter === "all" ? "All" : state.sectionFilter,
    },
    { label: "Search", value: state.search.trim() || "(none)" },
    {
      label: "Unsaved changes",
      value: snapshot.unsaved
        ? "Yes: the values below include edits that are not saved"
        : "No: the values below match the saved plan",
    },
  ];
  if (snapshot.selectedProduct !== null)
    facts.push({
      label: state.bomOpen ? "BOM Inspector open for" : "Selected product",
      value: snapshot.selectedProduct.productTitle,
    });
  if (state.expandedProductIds !== undefined && state.expandedProductIds.size > 0) {
    const expandedTitles = snapshot.calculation.products
      .filter((product) => state.expandedProductIds?.has(product.productId))
      .map((product) => product.productTitle);
    if (expandedTitles.length > 0) {
      facts.push({
        label: "Inline cost chain expanded for",
        value: expandedTitles.join(", "),
      });
    }
  }
  return { title: "Page state", facts, table: null };
}

function scenarioSection(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const assumptions = snapshot.projected.assumptions;
  const measured = snapshot.state.overview.measuredWaste;
  const currency = snapshot.calculation.summary.currency;
  return {
    title: "Scenario inputs",
    facts: [
      {
        label: "Demand preset",
        value: PRESET_TITLES[snapshot.projected.preset],
      },
      {
        label: "Shelf waste (spoil)",
        value: `${assumptions.bakeShelfWastePct}%`,
      },
      { label: "Prep reject", value: `${assumptions.prepRejectPct}%` },
      { label: "Channel fee", value: `${assumptions.channelFeeBps / 100}%` },
      { label: "Included tax", value: `${assumptions.includedTaxBps / 100}%` },
      {
        label: "7d bulk tiers",
        value: assumptions.applyBulkTiers ? "On" : "Off",
      },
      {
        label: "Operating days per month",
        value: String(assumptions.operatingDaysPerMonth),
      },
      {
        label: "Daily labor",
        value: formatMoneyMinor(snapshot.projected.dailyLaborMinor, currency),
      },
      {
        label: "Daily rent",
        value: formatMoneyMinor(snapshot.projected.dailyRentMinor, currency),
      },
      {
        label: "Measured 30d shelf waste",
        value:
          measured.measuredShelfWastePct === null
            ? "none recorded"
            : `${measured.measuredShelfWastePct.toFixed(1)}%`,
      },
      {
        label: "Measured 30d batch reject",
        value:
          measured.measuredBatchRejectPct === null
            ? "none recorded"
            : `${measured.measuredBatchRejectPct.toFixed(1)}%`,
      },
    ],
    table: null,
  };
}

function summarySection(
  calculation: BakeryCostCalculation,
): PortalPageViewSection {
  const summary = calculation.summary;
  const money = (minor: number): string =>
    formatMoneyMinor(minor, summary.currency);
  return {
    title: "Totals for the whole plan",
    facts: [
      { label: "Units sold per day", value: String(summary.dailyUnitsSold) },
      {
        label: "Daily gross revenue",
        value: money(summary.dailyGrossRevenueMinor),
      },
      {
        label: "Daily included tax",
        value: money(summary.dailyIncludedTaxMinor),
      },
      {
        label: "Daily ingredient spend",
        value: money(summary.dailyIngredientSpendMinor),
      },
      {
        label: "Daily packaging spend",
        value: money(summary.dailyPackagingSpendMinor),
      },
      {
        label: "Daily waste spend",
        value: money(summary.dailyWasteSpendMinor),
      },
      {
        label: "Daily channel fees",
        value: money(summary.dailyChannelFeeMinor),
      },
      {
        label: "Daily net contribution",
        value: money(summary.dailyNetContributionMinor),
      },
      { label: "Net margin", value: percent(summary.netMarginPct) },
      { label: "Net margin ex tax", value: percent(summary.netMarginExTaxPct) },
      { label: "Daily fixed costs", value: money(summary.dailyFixedCostMinor) },
      {
        label: "Daily operating profit",
        value: money(summary.dailyOperatingProfitMinor),
      },
      { label: "Operating margin", value: percent(summary.operatingMarginPct) },
      {
        label: "Break-even units per day",
        value:
          summary.breakEvenUnitsPerDay === null
            ? "not reachable"
            : String(summary.breakEvenUnitsPerDay),
      },
      {
        label: "Monthly gross revenue",
        value: money(summary.monthlyGrossRevenueMinor),
      },
      {
        label: "Monthly operating profit",
        value: money(summary.monthlyOperatingProfitMinor),
      },
      {
        label: "Bulk tiers unlocked",
        value: String(summary.unlockedBulkTierCount),
      },
      {
        label: "Daily bulk tier savings",
        value: money(summary.dailyTierSavingsMinor),
      },
      {
        label: "Supplies with no cost",
        value: String(summary.missingSupplyCostCount),
      },
      {
        label: "Supplies needing reorder (<4d)",
        value: String(
          calculation.supplies.filter((supply) => supply.reorderSuggested)
            .length,
        ),
      },
    ],
    table: null,
  };
}

function tableSection(snapshot: CostsPageSnapshot): PortalPageViewSection {
  switch (snapshot.state.tab) {
    case "margins":
      return marginsTable(snapshot);
    case "weekly":
      return weeklyTable(snapshot);
    case "actuals":
      return actualsTable(snapshot);
    case "forecast":
      return forecastTable(snapshot);
    case "supplies":
      return suppliesTable(snapshot);
  }
}

function forecastTable(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const forecast = snapshot.forecast;
  const currency = snapshot.calculation.summary.currency;
  const money = (minor: number): string => formatMoneyMinor(minor, currency);
  if (forecast === undefined) {
    return {
      title: "12-week P&L & cash table",
      facts: [],
      table: null,
    };
  }
  const s = forecast.summary;
  const facts: PortalPageViewFact[] = [
    { label: "Opening bank cash", value: money(s.openingCashMinor) },
    { label: "Demand curve", value: s.demandCurve },
    { label: "Supplier terms", value: s.supplierTerms },
    {
      label: "Extra shift threshold",
      value: `${s.extraShiftThresholdPct}% (${money(s.extraShiftWeeklyMinor)}/wk)`,
    },
    { label: "Equipment capex", value: money(s.capexMinor) },
    { label: "12w projected sales", value: money(s.totalGrossSalesMinor) },
    {
      label: "12w operating profit",
      value: `${money(s.totalOperatingProfitMinor)} (${percent(s.operatingMarginPct)})`,
    },
    {
      label: "Lowest cash trough",
      value: `${money(s.lowestCashMinor)} on ${s.lowestCashWeekCode} (${s.lowestCashReason})`,
    },
    {
      label: "Ending bank cash (W12)",
      value: `${money(s.endingCashMinor)} (build ${money(s.netCashBuildMinor)})`,
    },
    ...(s.capexPaybackWeeks !== null
      ? [{ label: "Capex payback", value: `${s.capexPaybackWeeks} weeks` }]
      : []),
  ];
  const rows = forecast.weeks.map((wk) => [
    wk.shortLabel,
    `${wk.demandIndexPct}%`,
    String(wk.plannedUnits),
    money(wk.grossSalesMinor),
    money(wk.cogsMinor),
    money(wk.wasteTaxFeeMinor),
    money(wk.grossContributionMinor),
    wk.extraShiftActive ? `${money(wk.laborMinor)} (+shift)` : money(wk.laborMinor),
    money(wk.accrualRentMinor),
    money(wk.operatingProfitMinor),
    money(wk.endingCashMinor),
  ]);
  return {
    title: "12-week P&L & cash table",
    facts,
    table: {
      columns: [
        "Week",
        "Demand idx",
        "Units",
        "Gross sales",
        "COGS",
        "Waste + tax + fees",
        "Gross contrib",
        "Labor",
        "Rent",
        "Operating profit",
        "Ending cash",
      ],
      rows,
      totalRows: rows.length,
    },
  };
}

function actualsTable(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const actuals = snapshot.actuals;
  const rowsSource = snapshot.actualsRows ?? actuals?.products ?? [];
  const currency = snapshot.calculation.summary.currency;
  const money = (minor: number): string => formatMoneyMinor(minor, currency);
  const facts: PortalPageViewFact[] =
    actuals === undefined
      ? []
      : [
          { label: "Window", value: `${actuals.windowDays}d` },
          {
            label: "Orders in window",
            value: `${actuals.summary.orderCount} (${actuals.summary.posOrderCount} POS · ${actuals.summary.onlineOrderCount} online)`,
          },
          {
            label: "Actual net sales",
            value: money(actuals.summary.actualNetSalesMinor),
          },
          {
            label: "Realized COGS (invoices)",
            value: money(actuals.summary.actualCogsMinor),
          },
          {
            label: "Realized bake & shelf waste",
            value: money(actuals.summary.actualWasteMinor),
          },
          {
            label: "Realized operating profit",
            value: `${money(actuals.summary.actualOperatingProfitMinor)} (Δ ${money(actuals.summary.operatingProfitDeltaMinor)})`,
          },
          ...actuals.drivers.slice(0, 4).map((driver, idx) => ({
            label: `Margin bridge #${idx + 1}`,
            value: `${driver.label} (${money(driver.profitImpactMinor)})`,
          })),
        ];
  const rows = rowsSource.map((row) => [
    row.productId,
    row.productTitle,
    String(row.plannedUnits),
    String(row.actualUnitsSold),
    String(row.volumeDeltaUnits),
    money(row.theoreticalUnitCogsMinor),
    money(row.actualUnitCogsMinor),
    row.actualWastePct === null
      ? `${row.plannedWastePct}% -> -`
      : `${row.plannedWastePct}% -> ${row.actualWastePct}%`,
    row.actualMarginPct === null
      ? `(plan ${percent(row.plannedMarginPct)})`
      : `${percent(row.actualMarginPct)} (plan ${percent(row.plannedMarginPct)})`,
    money(row.profitDeltaMinor),
    row.primaryNote,
  ]);
  return {
    title: "Plan vs actuals table (rows in view)",
    facts,
    table: {
      columns: [
        "Product id",
        "Product",
        "Plan units",
        "Actual units",
        "Volume delta",
        "Theo COGS",
        "Actual COGS",
        "Waste (Plan -> Actual)",
        "Actual margin",
        "Profit delta",
        "Note",
      ],
      rows,
      totalRows: rows.length,
    },
  };
}

function marginsTable(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const rows = snapshot.products.map(function marginRow(product) {
    const money = (minor: number): string =>
      formatMoneyMinor(minor, product.currency);
    return [
      product.productId,
      product.productTitle,
      product.productType,
      product.recipeName ?? "no recipe linked",
      String(product.dailyTargetUnits),
      String(product.batchesPerDay),
      `${product.effectiveSpoilagePct}%`,
      money(product.grossPriceMinor),
      money(product.ingredientUnitCostMinor),
      money(product.packagingUnitCostMinor),
      money(product.wasteAndSurplusUnitMinor),
      money(product.channelFeeMinor),
      money(product.allInUnitCostMinor),
      money(product.netContributionUnitMinor),
      percent(product.netMarginPct),
      money(product.dailyNetContributionMinor),
      String(product.missingCostItemIds.length),
    ];
  });
  return {
    title: "Product margins table (rows in view)",
    facts: [],
    table: {
      columns: [
        "Product id",
        "Product",
        "Category",
        "Recipe",
        "Units per day",
        "Runs per day",
        "Spoil",
        "Price",
        "Ingredients per unit",
        "Packaging per unit",
        "Waste per unit",
        "Channel fee per unit",
        "All-in cost per unit",
        "Net contribution per unit",
        "Net margin",
        "Daily net contribution",
        "Supplies with no cost",
      ],
      rows,
      totalRows: rows.length,
    },
  };
}

function weeklyTable(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const rows = snapshot.products.map(function weekRow(product) {
    return [
      product.productId,
      product.productTitle,
      ...product.weekUnits.map(String),
      String(product.sevenDayUnits),
      String(product.sevenDayBatches),
      formatMoneyMinor(product.sevenDayGrossRevenueMinor, product.currency),
      formatMoneyMinor(product.sevenDayNetContributionMinor, product.currency),
    ];
  });
  return {
    title: "Mon–Sun plan table (rows in view)",
    facts: [],
    table: {
      columns: [
        "Product id",
        "Product",
        ...WEEKDAYS,
        "7d units",
        "7d batches",
        "7d gross revenue",
        "7d net contribution",
      ],
      rows,
      totalRows: rows.length,
    },
  };
}

function suppliesTable(snapshot: CostsPageSnapshot): PortalPageViewSection {
  const usage = new Map(
    snapshot.calculation.supplies.map((supply) => [
      supply.inventoryItemId,
      supply,
    ]),
  );
  const rows = snapshot.supplies.map(function supplyRow(item) {
    const terms = item.costTerms;
    const used = usage.get(item.id);
    const coverageText =
      used === undefined || used.onHandBaseQuantity === null
        ? "uncounted"
        : used.daysOfSupply !== null
          ? used.reorderSuggested
            ? `${used.daysOfSupply.toFixed(1)}d left (reorder)`
            : `${used.daysOfSupply.toFixed(1)}d on hand`
          : formatCostQuantity(used.onHandBaseQuantity, item.baseUnit);
    return [
      item.name,
      item.merchantCode,
      item.category,
      terms === null
        ? "no cost"
        : `${formatCostQuantity(terms.packQuantity, terms.packUnit)} for ${formatMoneyMinor(terms.packPriceMinor, terms.currency)}`,
      terms?.bulkTier == null
        ? "none"
        : `${formatCostQuantity(terms.bulkTier.packQuantity, terms.packUnit)} for ${formatMoneyMinor(terms.bulkTier.packPriceMinor, terms.currency)} from ${formatCostQuantity(terms.bulkTier.min7dQuantity, item.baseUnit)} per 7d`,
      used === undefined
        ? "not used"
        : formatCostQuantity(used.sevenDayBaseUsage, item.baseUnit),
      coverageText,
      String(used?.usedInProductCount ?? 0),
      used === undefined ? "no" : used.bulkUnlocked ? "yes" : "no",
      used === undefined || terms === null
        ? "-"
        : formatMoneyMinor(used.dailySpendMinor, terms.currency),
    ];
  });
  return {
    title: "Supplier pack prices table (rows in view)",
    facts: [],
    table: {
      columns: [
        "Supply",
        "Code",
        "Category",
        "Pack",
        "Bulk tier",
        "7d usage",
        "Stock coverage",
        "Used in SKUs",
        "Bulk unlocked",
        "Daily spend",
      ],
      rows,
      totalRows: rows.length,
    },
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}
