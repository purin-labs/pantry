import type {
  CostsSheetCell,
  CostsSheetCellChange,
} from "@purin-labs/costs-sheet-crdt";
import type {
  ActualsWindowDays,
  BakeryCostCalculation,
  CalculatedSupplyUsage,
  CostForecastPlan,
  CostUnit,
  CostValuationBasis,
  CostsOverview,
  ForecastDemandCurve,
  ForecastSummary,
  ForecastSupplierTerms,
  OrganisationCostPlan,
  PlanVsActualStatusTone,
  PlanVsActualSummary,
  PlanVsActualVarianceDriver,
  ProductCostPlanEntry,
  SupplyCostBulkTier,
  SupplyCostItem,
  SupplyLotCost,
  WeekUnits,
} from "@purin-labs/kitchen-control-api";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

// The requests and the reads of the Kitchen Costs & margins tools, as the
// Kitchen tool services name them. A part of the Kitchen contract.

type CostsReadTarget = Readonly<{
  targetId: string;
  unitsPerDay: number;
}>;

export type CostsReadForecastScenario = Readonly<{
  openingCashMinor?: number | null;
  demandCurve?: ForecastDemandCurve | null;
  supplierTerms?: ForecastSupplierTerms | null;
  extraShiftThresholdPct?: number | null;
  extraShiftWeeklyMinor?: number | null;
  capexMinor?: number | null;
}>;

export type CostsReadRequest = Readonly<{
  dailyTargets: readonly CostsReadTarget[] | null;
  bakeShelfWastePct: number | null;
  prepRejectPct: number | null;
  channelFeeBps: number | null;
  includedTaxBps: number | null;
  applyBulkTiers: boolean | null;
  lotCostBasis?: CostValuationBasis | null;
  actualsWindowDays?: ActualsWindowDays | null;
  forecast?: CostsReadForecastScenario | null;
}>;

export type CostsToolRead = Readonly<{
  currency: string;
  merchantRevision: number;
  defaultIncludedTaxBps: number;
  includedTaxSource: CostsOverview["includedTaxSource"];
  measuredWaste: CostsOverview["measuredWaste"];
  costPlan: OrganisationCostPlan;
  assumptions: BakeryCostCalculation["assumptions"];
  summary: BakeryCostCalculation["summary"] &
    Readonly<{ reorderSupplyCount?: number }>;
  supplies: readonly Readonly<{
    id: string;
    name: string;
    category: SupplyCostItem["category"];
    baseUnit: CostUnit;
    expectedEntryRevision: number | null;
    packQty?: number | null;
    packUnit?: CostUnit | null;
    packPriceMinor?: number | null;
    bulkTier?: SupplyCostBulkTier;
    dailyQty: number;
    sevenDayQty: number;
    dailyCostMinor: number;
    daysOfSupply?: number;
    reorderSuggested?: true;
    usedInProductCount?: number;
    bulkUnlocked?: true;
    costSource?: CalculatedSupplyUsage["costSource"];
    activeLotCount?: number;
    pricedLotCount?: number;
    fifoEquivalentPackPriceMinor?: number | null;
    weightedEquivalentPackPriceMinor?: number | null;
    lotCostVariancePct?: number | null;
    weeklyLotVarianceImpactMinor?: number;
  }>[];
  lots?: readonly Readonly<{
    id: SupplyLotCost["id"];
    inventoryItemId: SupplyLotCost["inventoryItemId"];
    lotCode: SupplyLotCost["lotCode"];
    receivedAt: SupplyLotCost["receivedAt"];
    remainingQuantity: SupplyLotCost["remainingQuantity"];
    baseUnit: SupplyLotCost["baseUnit"];
    lifecycle: SupplyLotCost["lifecycle"];
    invoiceCost: Readonly<{
      revision: number;
      currency: string;
      invoicedQuantity: number;
      invoicedUnit: CostUnit;
      invoiceTotalMinor: number;
      invoiceReference: string | null;
      supplierId: string | null;
    }> | null;
  }>[];
  products: readonly Readonly<{
    productId: string;
    title: string;
    kind: "stocked" | "prepared";
    batchYield?: number;
    spoilPct?: number;
    weekUnits: WeekUnits;
    targetUnits: number;
    batchesPerDay?: number;
    producedUnits: number;
    priceMinor: number;
    bomUnitCostMinor?: number;
    unitCostMinor: number;
    marginPct: number;
    dailyMarginMinor: number;
    bomLines?: readonly Readonly<{
      itemId: string;
      qtyPerUnit: number;
      unit: CostUnit;
      unitCostMinor: number;
    }>[];
    missingCosts?: readonly string[];
  }>[];
  unlinkedRecipes: readonly Readonly<{
    recipeId: string;
    name: string;
    outputKind: "stocked" | "immediate";
    batchYield: number;
    totalBatchCostMinor: number;
    rawUnitCostMinor: number;
  }>[];
  actuals?: Readonly<{
    windowDays: ActualsWindowDays;
    summary: PlanVsActualSummary;
    drivers: readonly PlanVsActualVarianceDriver[];
    products: readonly Readonly<{
      productId: string;
      title: string;
      plannedUnits: number;
      actualUnitsSold: number;
      volumeDeltaUnits: number;
      theoreticalUnitCogsMinor: number;
      actualUnitCogsMinor: number;
      plannedWastePct: number;
      actualWastePct: number | null;
      plannedMarginPct: number;
      actualMarginPct: number | null;
      profitDeltaMinor: number;
      statusTone: PlanVsActualStatusTone;
      primaryNote: string;
    }>[];
  }>;
  forecast?: Readonly<{
    summary: ForecastSummary;
    weeks: readonly Readonly<{
      weekCode: string;
      demandIndexPct: number;
      grossSalesMinor: number;
      cogsMinor: number;
      laborMinor: number;
      extraShiftActive?: true;
      extraBulkTiersUnlocked?: number;
      operatingProfitMinor: number;
      lumpOutflowMinor: number;
      endingCashMinor: number;
    }>[];
  }>;
  draftCells?: readonly CostsSheetCell[];
}>;

export type CostsReadTool = (
  request: CostsReadRequest,
) => Promise<CostsToolRead>;

export type SupplyCostSaveRequest = Readonly<{
  inventoryItemId: string;
  expectedEntryRevision: number | null;
  currency: string;
  packQuantity: number;
  packUnit: CostUnit;
  packPriceMinor: number;
  supplierId: string | null;
  bulkTier: SupplyCostBulkTier | null;
  notes: string | null;
}>;

export type SupplyCostSaveTool = (
  request: SupplyCostSaveRequest,
  operationId: string,
) => Promise<PreparedEffect>;

export type LotCostSaveRequest = Readonly<{
  lotId: string;
  inventoryItemId: string;
  expectedRevision: number | null;
  currency: string;
  invoicedQuantity: number;
  invoicedUnit: CostUnit;
  invoiceTotalMinor: number;
  invoiceReference: string;
  supplierId: string | null;
}>;

export type LotCostSaveTool = (
  request: LotCostSaveRequest,
  operationId: string,
) => Promise<PreparedEffect>;

export type CostsPlanSaveRequest = Readonly<{
  expectedPlanRevision: number | null;
  dailyLaborMinor: number | null;
  dailyRentMinor: number | null;
  products: readonly ProductCostPlanEntry[] | null;
  forecast?: CostForecastPlan | null;
}>;

export type CostsPlanSaveTool = (
  request: CostsPlanSaveRequest,
  operationId: string,
) => Promise<PreparedEffect>;

export type CostsSheetEditRequest = Readonly<{
  changes: readonly CostsSheetCellChange[];
}>;

export type CostsSheetEditResult = Readonly<{
  documentId: "costs-sheet";
  revision: number;
  generation: number;
  cells: readonly CostsSheetCell[];
}>;

export type CostsSheetEditTool = (
  request: CostsSheetEditRequest,
  operationId: string,
  execution: CatalogExecutionContext,
) => Promise<PreparedEffect>;
