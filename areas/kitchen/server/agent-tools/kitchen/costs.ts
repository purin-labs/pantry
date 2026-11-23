import {
  META_SAVED_AT_CELL_KEY,
  isCostsSheetCellEntry,
  isCostsSheetCellKey,
  type CostsSheetCell,
  type CostsSheetCellChange,
} from "@purin-labs/costs-sheet-crdt";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  COST_SCENARIO_LIMITS,
  normalizeCostForecastPlan,
  type ActualsWindowDays,
  type BakeryCostCalculation,
  type CalculatedSupplyUsage,
  type CostForecastPlan,
  type CostUnit,
  type CostValuationBasis,
  type CostsOverview,
  type ForecastDemandCurve,
  type ForecastSummary,
  type ForecastSupplierTerms,
  type OrganisationCostPlan,
  type PlanVsActualStatusTone,
  type PlanVsActualSummary,
  type PlanVsActualVarianceDriver,
  type ProductCostPlanEntry,
  type SupplyCostBulkTier,
  type SupplyCostItem,
  type SupplyLotCost,
  type WeekUnits,
} from "@purin-labs/kitchen-control-api";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { defineKitchenTool } from "./services";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

const COST_UNITS: ReadonlySet<string> = new Set([
  "each",
  "gram",
  "kilogram",
  "milliliter",
  "liter",
]);

const LOT_COST_BASES: ReadonlySet<string> = new Set([
  "standing",
  "fifo_lot",
  "weighted_lot",
]);

type CostsReadTarget = Readonly<{
  targetId: string;
  unitsPerDay: number;
}>;

type CostsReadForecastScenario = Readonly<{
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
  invoiceReference: string | null;
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

export const costsRead = defineKitchenTool({
  name: "costs_read",
  description:
    "Read and model the shop's recipe sourcing costs, supply stock coverage (daysOfSupply, reorderSuggested) and SKU reach (usedInProductCount), Mon-Sun and daily batch budgets, fixed daily labor and rent, break-even volume, waste, included consumption tax, product margins, 7-day or 30-day Plan vs Actuals variance, and the 12-Week P&L & Cash Runway forecast (seasonal demand curves, bulk tier unlocks, step-shift labor, Net-30 payables + monthly rent cash troughs, and equipment capex payback), as staff see them on the Kitchen Costs & margins spreadsheet. " +
    "Set optional what-if fields to null to use the shop's saved plan and defaults, pass actualsWindowDays (7 or 30) to read Plan vs Actuals margin leaks against live POS and online orders, pass forecast ({} for saved/default 12-week cash runway, or scenario overrides such as openingCashMinor, demandCurve, supplierTerms, extraShiftThresholdPct, extraShiftWeeklyMinor, capexMinor), or pass dailyTargets (1-8 targets focuses products with per-ingredient bomLines and enriches supplies with daysOfSupply, reorderSuggested and usedInProductCount), bakeShelfWastePct, prepRejectPct, channelFeeBps, includedTaxBps or applyBulkTiers to model a scenario without changing live stock or prices.",
  input: jsonSchema({
    type: "object",
    properties: {
      dailyTargets: {
        type: ["array", "null"],
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            targetId: {
              type: "string",
              pattern: "^[A-Za-z0-9_:-]{1,128}$",
            },
            unitsPerDay: {
              type: "integer",
              minimum: 0,
              maximum: 100000,
            },
          },
          required: ["targetId", "unitsPerDay"],
          additionalProperties: false,
        },
      },
      bakeShelfWastePct: {
        type: ["number", "null"],
        minimum: 0,
        maximum: COST_SCENARIO_LIMITS.bakeShelfWastePct,
      },
      prepRejectPct: {
        type: ["number", "null"],
        minimum: 0,
        maximum: COST_SCENARIO_LIMITS.prepRejectPct,
      },
      channelFeeBps: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: COST_SCENARIO_LIMITS.channelFeeBps,
      },
      includedTaxBps: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: COST_SCENARIO_LIMITS.includedTaxBps,
      },
      applyBulkTiers: {
        type: ["boolean", "null"],
      },
      lotCostBasis: {
        type: ["string", "null"],
        enum: ["standing", "fifo_lot", "weighted_lot", null],
      },
      actualsWindowDays: {
        type: ["integer", "null"],
        enum: [7, 30, null],
      },
      forecast: {
        type: ["object", "null"],
        properties: {
          openingCashMinor: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: 10000000000,
          },
          demandCurve: {
            type: ["string", "null"],
            enum: [
              "steady",
              "seasonal_holiday",
              "growth_ramp",
              "winter_dip",
              "custom",
              null,
            ],
          },
          supplierTerms: {
            type: ["string", "null"],
            enum: ["cod", "net_15", "net_30", null],
          },
          extraShiftThresholdPct: {
            type: ["integer", "null"],
            minimum: 101,
            maximum: 400,
          },
          extraShiftWeeklyMinor: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: 10000000000,
          },
          capexMinor: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: 10000000000,
          },
        },
        additionalProperties: false,
      },
    },
    required: [
      "dailyTargets",
      "bakeShelfWastePct",
      "prepRejectPct",
      "channelFeeBps",
      "includedTaxBps",
      "applyBulkTiers",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseCostsReadArgs,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "costs read is unavailable",
  handler: ({ readCosts }) =>
    readCosts === undefined ? undefined : (request) => readCosts(request),
});

export const supplyCostSave = defineKitchenTool({
  name: "supply_cost_save",
  description:
    "Save one stock item's supplier pack price, unit and optional 7-day bulk tier, as staff do on the Kitchen Costs & margins spreadsheet. " +
    "Use inventoryItemId and expectedEntryRevision from costs_read (null when the item has no costTerms yet). packUnit must match the item's baseUnit family (weight with weight, volume with volume, each with each). " +
    "Say what you will change before you save, unless the person gave the exact change. A save moves no stock and pays nothing.",
  input: jsonSchema({
    type: "object",
    properties: {
      inventoryItemId: {
        type: "string",
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      expectedEntryRevision: {
        type: ["integer", "null"],
        minimum: 1,
      },
      currency: {
        type: "string",
        pattern: "^[A-Z]{3}$",
      },
      packQuantity: {
        type: "number",
        exclusiveMinimum: 0,
      },
      packUnit: {
        type: "string",
        enum: ["each", "gram", "kilogram", "milliliter", "liter"],
      },
      packPriceMinor: {
        type: "integer",
        minimum: 0,
      },
      supplierId: {
        type: ["string", "null"],
        maxLength: 128,
      },
      bulkTier: {
        type: ["object", "null"],
        properties: {
          min7dQuantity: {
            type: "number",
            exclusiveMinimum: 0,
          },
          packQuantity: {
            type: "number",
            exclusiveMinimum: 0,
          },
          packPriceMinor: {
            type: "integer",
            minimum: 0,
          },
        },
        required: ["min7dQuantity", "packQuantity", "packPriceMinor"],
        additionalProperties: false,
      },
      notes: {
        type: ["string", "null"],
        maxLength: 500,
      },
    },
    required: [
      "inventoryItemId",
      "expectedEntryRevision",
      "currency",
      "packQuantity",
      "packUnit",
      "packPriceMinor",
      "supplierId",
      "bulkTier",
      "notes",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseSupplyCostSaveArgs,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The receipt answers a repeat. Lost before the receipt, the recipe that it saved answers, and a supplier's commands replay under their keys.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceSupplyCostSave,
  },
  unavailable: "supply cost save is unavailable",
  prepare: ({ saveSupplyCost }) =>
    saveSupplyCost === undefined
      ? undefined
      : (request, call) => saveSupplyCost(request, call.operationId),
});

export const lotCostSave = defineKitchenTool({
  name: "lot_cost_save",
  description:
    "Record or update one received inventory lot's purchase invoice cost (invoiceTotalMinor, invoicedQuantity, invoicedUnit, optional invoiceReference and supplierId) for FIFO or weighted-average lot cost valuation on the Kitchen Costs & margins spreadsheet. " +
    "Use lotId, inventoryItemId and expectedRevision from costs_read.lots (expectedRevision is null when the lot has no saved lot_invoice record yet). invoicedUnit must match the item's baseUnit family. " +
    "Say what you will change before you save, unless the person gave the exact change. A save moves no stock and pays nothing.",
  input: jsonSchema({
    type: "object",
    properties: {
      lotId: {
        type: "string",
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      inventoryItemId: {
        type: "string",
        pattern: "^[A-Za-z0-9_:-]{1,128}$",
      },
      expectedRevision: {
        type: ["integer", "null"],
        minimum: 1,
      },
      currency: {
        type: "string",
        pattern: "^[A-Z]{3}$",
      },
      invoicedQuantity: {
        type: "number",
        exclusiveMinimum: 0,
      },
      invoicedUnit: {
        type: "string",
        enum: ["each", "gram", "kilogram", "milliliter", "liter"],
      },
      invoiceTotalMinor: {
        type: "integer",
        minimum: 0,
      },
      invoiceReference: {
        type: ["string", "null"],
        maxLength: 160,
      },
      supplierId: {
        type: ["string", "null"],
        maxLength: 128,
      },
    },
    required: [
      "lotId",
      "inventoryItemId",
      "expectedRevision",
      "currency",
      "invoicedQuantity",
      "invoicedUnit",
      "invoiceTotalMinor",
      "invoiceReference",
      "supplierId",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseLotCostSaveArgs,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The receipt answers a repeat, and saveOrganisationLotInvoiceCost replays an identical expectedRevision + 1.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceSupplyCostSave,
  },
  unavailable: "lot cost save is unavailable",
  prepare: ({ saveLotCost }) =>
    saveLotCost === undefined
      ? undefined
      : (request, call) => saveLotCost(request, call.operationId),
});

export const costsPlanSave = defineKitchenTool({
  name: "costs_plan_save",
  description:
    "Save the shop's fixed daily labor cost, fixed daily rent cost, and per-product Mon-Sun unit plans or spoilage overrides on the Kitchen Costs & margins spreadsheet. " +
    "Pass expectedPlanRevision from costs_read.costPlan.revision (null when no plan has been saved yet). Set dailyLaborMinor, dailyRentMinor, or products to null to keep the saved values for those fields. " +
    "Each entry in products sets weekUnits as [Mon, Tue, Wed, Thu, Fri, Sat, Sun] and optional spoilBps (basis points, e.g. 800 for 8%, or null to use the shop default). To change a buyer-facing menu or offer price, propose it with menu_board_propose_price or commerce_propose_action instead.",
  input: jsonSchema({
    type: "object",
    properties: {
      expectedPlanRevision: {
        type: ["integer", "null"],
        minimum: 1,
      },
      dailyLaborMinor: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: 1000000000,
      },
      dailyRentMinor: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: 1000000000,
      },
      products: {
        type: ["array", "null"],
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              pattern: "^[A-Za-z0-9_:-]{1,160}$",
            },
            weekUnits: {
              type: "array",
              minItems: 7,
              maxItems: 7,
              items: {
                type: "integer",
                minimum: 0,
                maximum: 100000,
              },
            },
            spoilBps: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 9500,
            },
          },
          required: ["productId", "weekUnits", "spoilBps"],
          additionalProperties: false,
        },
      },
      forecast: {
        type: ["object", "null"],
        properties: {
          openingCashMinor: {
            type: "integer",
            minimum: 0,
            maximum: 10000000000,
          },
          demandCurve: {
            type: "string",
            enum: [
              "steady",
              "seasonal_holiday",
              "growth_ramp",
              "winter_dip",
              "custom",
            ],
          },
          weekDemandPct: {
            type: "array",
            minItems: 12,
            maxItems: 12,
            items: {
              type: "integer",
              minimum: 10,
              maximum: 500,
            },
          },
          supplierTerms: {
            type: "string",
            enum: ["cod", "net_15", "net_30"],
          },
          extraShiftThresholdPct: {
            type: "integer",
            minimum: 101,
            maximum: 400,
          },
          extraShiftWeeklyMinor: {
            type: "integer",
            minimum: 0,
            maximum: 10000000000,
          },
          capexMinor: {
            type: "integer",
            minimum: 0,
            maximum: 10000000000,
          },
        },
        required: [
          "openingCashMinor",
          "demandCurve",
          "weekDemandPct",
          "supplierTerms",
          "extraShiftThresholdPct",
          "extraShiftWeeklyMinor",
          "capexMinor",
        ],
        additionalProperties: false,
      },
    },
    required: [
      "expectedPlanRevision",
      "dailyLaborMinor",
      "dailyRentMinor",
      "products",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseCostsPlanSaveArgs,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The receipt answers a repeat, and saveOrganisationCostPlan replays an identical expectedPlanRevision + 1.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceSupplyCostSave,
  },
  unavailable: "costs plan save is unavailable",
  prepare: ({ saveCostsPlan }) =>
    saveCostsPlan === undefined
      ? undefined
      : (request, call) => saveCostsPlan(request, call.operationId),
});

export const costsSheetEdit = defineKitchenTool({
  name: "costs_sheet_edit",
  description:
    "Edit cells in the Organisation's shared multiplayer Costs & margins workbook draft so open Portal tabs see the changes and your cursor immediately before anyone clicks Save changes. " +
    "Pass changes as [{ cellKey, value }], where value is a string or null to clear the draft override back to the saved baseline. " +
    `Valid cellKey values: 'overhead:dailyLabor' (minor integer), 'overhead:dailyRent' (minor integer), 'scenario:bakeShelfWastePct' (0-${COST_SCENARIO_LIMITS.bakeShelfWastePct}), 'scenario:prepRejectPct' (0-${COST_SCENARIO_LIMITS.prepRejectPct}), 'scenario:channelFeeBps' (0-${COST_SCENARIO_LIMITS.channelFeeBps}), 'scenario:includedTaxBps' (0-${COST_SCENARIO_LIMITS.includedTaxBps}), 'scenario:applyBulkTiers' ('true'|'false'), ` +
    "'product:<productId>:daily' (0-100000), 'product:<productId>:day:<0..6>' (Mon=0..Sun=6), 'product:<productId>:spoil' ('default' or 0-9500 bps), 'product:<productId>:price' (minor integer), " +
    "'product:<productId>:cogs' ('default' or minor integer override), 'product:<productId>:waste' ('default' or minor integer override), 'product:<productId>:fx:<units|spoil|price|cogs|waste|unitNet|margin|netDay>' ('default' or '=...' formula), " +
    "'forecast:<opening_cash|demand_curve|supplier_terms|extra_shift_pct|extra_shift_minor|capex_minor>', 'forecast:week_idx:<0..11>' (10-500%), or " +
    "'supply:<inventoryItemId>:<packQuantity|packUnit|packPriceMajor|bulkMin7dQuantity|bulkPackQuantity|bulkPackPriceMajor>'. " +
    "This edits the shared working draft only; live Offer prices and saved plans change only when staff click Save changes or when you call costs_plan_save / supply_cost_save.",
  input: jsonSchema({
    type: "object",
    properties: {
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            cellKey: {
              type: "string",
              minLength: 1,
              maxLength: 220,
            },
            value: {
              type: ["string", "null"],
              maxLength: 160,
            },
          },
          required: ["cellKey", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseCostsSheetEditArgs,
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceSupplyCostSave,
  },
  unavailable: "costs sheet edit is unavailable",
  prepare: ({ editCostsSheet }) =>
    editCostsSheet === undefined
      ? undefined
      : (request, call) =>
          editCostsSheet(request, call.operationId, call.execution),
});

function isCostUnit(value: unknown): value is CostUnit {
  return typeof value === "string" && COST_UNITS.has(value);
}

function isLotCostBasis(value: unknown): value is CostValuationBasis {
  return typeof value === "string" && LOT_COST_BASES.has(value);
}

const REQUIRED_COSTS_READ_KEYS = [
  "dailyTargets",
  "bakeShelfWastePct",
  "prepRejectPct",
  "channelFeeBps",
  "includedTaxBps",
  "applyBulkTiers",
] as const;

const ALLOWED_COSTS_READ_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_COSTS_READ_KEYS,
  "lotCostBasis",
  "actualsWindowDays",
  "forecast",
]);

const FORECAST_DEMAND_CURVES: ReadonlySet<string> = new Set([
  "steady",
  "seasonal_holiday",
  "growth_ramp",
  "winter_dip",
  "custom",
]);

const FORECAST_SUPPLIER_TERMS: ReadonlySet<string> = new Set([
  "cod",
  "net_15",
  "net_30",
]);

const ALLOWED_FORECAST_READ_KEYS: ReadonlySet<string> = new Set([
  "openingCashMinor",
  "demandCurve",
  "supplierTerms",
  "extraShiftThresholdPct",
  "extraShiftWeeklyMinor",
  "capexMinor",
]);

function parseCostsReadArgs(input: unknown): CostsReadRequest {
  if (
    !isRecord(input) ||
    !REQUIRED_COSTS_READ_KEYS.every((key) => Object.hasOwn(input, key)) ||
    !Object.keys(input).every((key) => ALLOWED_COSTS_READ_KEYS.has(key))
  ) {
    throw new TypeError("costs_read arguments are invalid");
  }
  const dailyTargets =
    input.dailyTargets === null
      ? null
      : Array.isArray(input.dailyTargets)
        ? input.dailyTargets.map((entry: unknown) => {
            if (
              !isRecord(entry) ||
              !hasExactKeys(entry, ["targetId", "unitsPerDay"]) ||
              typeof entry.targetId !== "string" ||
              entry.targetId.trim().length === 0 ||
              !Number.isSafeInteger(entry.unitsPerDay) ||
              Number(entry.unitsPerDay) < 0
            ) {
              throw new TypeError("costs_read dailyTargets are invalid");
            }
            return {
              targetId: entry.targetId.trim(),
              unitsPerDay: Number(entry.unitsPerDay),
            };
          })
        : undefined;
  if (dailyTargets === undefined) {
    throw new TypeError("costs_read dailyTargets are invalid");
  }
  const parsePct = (
    value: unknown,
    max: number,
    field: string,
  ): number | null => {
    if (value === null) {
      return null;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > max
    ) {
      throw new TypeError(`costs_read ${field} is invalid`);
    }
    return value;
  };
  const parseBps = (
    value: unknown,
    max: number,
    field: string,
  ): number | null => {
    if (value === null) {
      return null;
    }
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      Number(value) > max
    ) {
      throw new TypeError(`costs_read ${field} is invalid`);
    }
    return Number(value);
  };
  if (
    input.applyBulkTiers !== null &&
    typeof input.applyBulkTiers !== "boolean"
  ) {
    throw new TypeError("costs_read applyBulkTiers is invalid");
  }
  const lotCostBasis =
    input.lotCostBasis === undefined || input.lotCostBasis === null
      ? null
      : isLotCostBasis(input.lotCostBasis)
        ? input.lotCostBasis
        : undefined;
  if (lotCostBasis === undefined) {
    throw new TypeError("costs_read lotCostBasis is invalid");
  }
  const actualsWindowDays =
    input.actualsWindowDays === undefined || input.actualsWindowDays === null
      ? null
      : input.actualsWindowDays === 7 || input.actualsWindowDays === 30
        ? input.actualsWindowDays
        : undefined;
  if (actualsWindowDays === undefined) {
    throw new TypeError("costs_read actualsWindowDays is invalid");
  }
  let forecast: CostsReadForecastScenario | null = null;
  if (input.forecast !== undefined && input.forecast !== null) {
    if (
      !isRecord(input.forecast) ||
      !Object.keys(input.forecast).every((key) =>
        ALLOWED_FORECAST_READ_KEYS.has(key),
      )
    ) {
      throw new TypeError("costs_read forecast is invalid");
    }
    const parseNonNegMinor = (v: unknown, field: string): number | null => {
      if (v === undefined || v === null) return null;
      if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 10_000_000_000) {
        throw new TypeError(`costs_read forecast.${field} is invalid`);
      }
      return Number(v);
    };
    const rawCurve = input.forecast.demandCurve;
    if (
      rawCurve !== undefined &&
      rawCurve !== null &&
      (typeof rawCurve !== "string" || !FORECAST_DEMAND_CURVES.has(rawCurve))
    ) {
      throw new TypeError("costs_read forecast.demandCurve is invalid");
    }
    const rawTerms = input.forecast.supplierTerms;
    if (
      rawTerms !== undefined &&
      rawTerms !== null &&
      (typeof rawTerms !== "string" || !FORECAST_SUPPLIER_TERMS.has(rawTerms))
    ) {
      throw new TypeError("costs_read forecast.supplierTerms is invalid");
    }
    const rawShiftPct = input.forecast.extraShiftThresholdPct;
    if (
      rawShiftPct !== undefined &&
      rawShiftPct !== null &&
      (!Number.isSafeInteger(rawShiftPct) ||
        Number(rawShiftPct) < 101 ||
        Number(rawShiftPct) > 400)
    ) {
      throw new TypeError(
        "costs_read forecast.extraShiftThresholdPct is invalid",
      );
    }
    forecast = {
      openingCashMinor: parseNonNegMinor(
        input.forecast.openingCashMinor,
        "openingCashMinor",
      ),
      demandCurve:
        rawCurve === undefined || rawCurve === null
          ? null
          : (rawCurve as ForecastDemandCurve),
      supplierTerms:
        rawTerms === undefined || rawTerms === null
          ? null
          : (rawTerms as ForecastSupplierTerms),
      extraShiftThresholdPct:
        rawShiftPct === undefined || rawShiftPct === null
          ? null
          : Number(rawShiftPct),
      extraShiftWeeklyMinor: parseNonNegMinor(
        input.forecast.extraShiftWeeklyMinor,
        "extraShiftWeeklyMinor",
      ),
      capexMinor: parseNonNegMinor(input.forecast.capexMinor, "capexMinor"),
    };
  }
  return {
    dailyTargets,
    bakeShelfWastePct: parsePct(
      input.bakeShelfWastePct,
      COST_SCENARIO_LIMITS.bakeShelfWastePct,
      "bakeShelfWastePct",
    ),
    prepRejectPct: parsePct(
      input.prepRejectPct,
      COST_SCENARIO_LIMITS.prepRejectPct,
      "prepRejectPct",
    ),
    channelFeeBps: parseBps(
      input.channelFeeBps,
      COST_SCENARIO_LIMITS.channelFeeBps,
      "channelFeeBps",
    ),
    includedTaxBps: parseBps(
      input.includedTaxBps,
      COST_SCENARIO_LIMITS.includedTaxBps,
      "includedTaxBps",
    ),
    applyBulkTiers: input.applyBulkTiers,
    ...(lotCostBasis !== null ? { lotCostBasis } : {}),
    ...(actualsWindowDays !== null ? { actualsWindowDays } : {}),
    ...(forecast !== null ? { forecast } : {}),
  };
}

function parseLotCostSaveArgs(input: unknown): LotCostSaveRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "lotId",
      "inventoryItemId",
      "expectedRevision",
      "currency",
      "invoicedQuantity",
      "invoicedUnit",
      "invoiceTotalMinor",
      "invoiceReference",
      "supplierId",
    ]) ||
    typeof input.lotId !== "string" ||
    input.lotId.trim().length === 0 ||
    typeof input.inventoryItemId !== "string" ||
    input.inventoryItemId.trim().length === 0 ||
    (input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) ||
        Number(input.expectedRevision) < 1)) ||
    typeof input.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(input.currency) ||
    typeof input.invoicedQuantity !== "number" ||
    !Number.isFinite(input.invoicedQuantity) ||
    input.invoicedQuantity <= 0 ||
    !isCostUnit(input.invoicedUnit) ||
    !Number.isSafeInteger(input.invoiceTotalMinor) ||
    Number(input.invoiceTotalMinor) < 0 ||
    (input.invoiceReference !== null &&
      typeof input.invoiceReference !== "string") ||
    (input.supplierId !== null && typeof input.supplierId !== "string")
  ) {
    throw new TypeError("lot_cost_save arguments are invalid");
  }

  const invoiceReference =
    input.invoiceReference === null ||
    input.invoiceReference.trim().length === 0
      ? null
      : input.invoiceReference.trim();
  const supplierId =
    input.supplierId === null || input.supplierId.trim().length === 0
      ? null
      : input.supplierId.trim();

  return {
    lotId: input.lotId.trim(),
    inventoryItemId: input.inventoryItemId.trim(),
    expectedRevision:
      input.expectedRevision === null ? null : Number(input.expectedRevision),
    currency: input.currency,
    invoicedQuantity: input.invoicedQuantity,
    invoicedUnit: input.invoicedUnit,
    invoiceTotalMinor: Number(input.invoiceTotalMinor),
    invoiceReference,
    supplierId,
  };
}

function parseSupplyCostSaveArgs(input: unknown): SupplyCostSaveRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "inventoryItemId",
      "expectedEntryRevision",
      "currency",
      "packQuantity",
      "packUnit",
      "packPriceMinor",
      "supplierId",
      "bulkTier",
      "notes",
    ]) ||
    typeof input.inventoryItemId !== "string" ||
    input.inventoryItemId.trim().length === 0 ||
    (input.expectedEntryRevision !== null &&
      (!Number.isSafeInteger(input.expectedEntryRevision) ||
        Number(input.expectedEntryRevision) < 1)) ||
    typeof input.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(input.currency) ||
    typeof input.packQuantity !== "number" ||
    !Number.isFinite(input.packQuantity) ||
    input.packQuantity <= 0 ||
    !isCostUnit(input.packUnit) ||
    !Number.isSafeInteger(input.packPriceMinor) ||
    Number(input.packPriceMinor) < 0 ||
    (input.supplierId !== null && typeof input.supplierId !== "string") ||
    (input.notes !== null && typeof input.notes !== "string")
  ) {
    throw new TypeError("supply_cost_save arguments are invalid");
  }

  let bulkTier: SupplyCostBulkTier | null = null;
  if (input.bulkTier !== null) {
    if (
      !isRecord(input.bulkTier) ||
      !hasExactKeys(input.bulkTier, [
        "min7dQuantity",
        "packQuantity",
        "packPriceMinor",
      ]) ||
      typeof input.bulkTier.min7dQuantity !== "number" ||
      !Number.isFinite(input.bulkTier.min7dQuantity) ||
      input.bulkTier.min7dQuantity <= 0 ||
      typeof input.bulkTier.packQuantity !== "number" ||
      !Number.isFinite(input.bulkTier.packQuantity) ||
      input.bulkTier.packQuantity <= 0 ||
      !Number.isSafeInteger(input.bulkTier.packPriceMinor) ||
      Number(input.bulkTier.packPriceMinor) < 0
    ) {
      throw new TypeError("supply_cost_save bulkTier is invalid");
    }
    bulkTier = {
      min7dQuantity: input.bulkTier.min7dQuantity,
      packQuantity: input.bulkTier.packQuantity,
      packPriceMinor: Number(input.bulkTier.packPriceMinor),
    };
  }

  const supplierId =
    input.supplierId === null || input.supplierId.trim().length === 0
      ? null
      : input.supplierId.trim();
  const notes =
    input.notes === null || input.notes.trim().length === 0
      ? null
      : input.notes.trim();

  return {
    inventoryItemId: input.inventoryItemId.trim(),
    expectedEntryRevision:
      input.expectedEntryRevision === null
        ? null
        : Number(input.expectedEntryRevision),
    currency: input.currency,
    packQuantity: input.packQuantity,
    packUnit: input.packUnit,
    packPriceMinor: Number(input.packPriceMinor),
    supplierId,
    bulkTier,
    notes,
  };
}

const REQUIRED_PLAN_SAVE_KEYS = [
  "expectedPlanRevision",
  "dailyLaborMinor",
  "dailyRentMinor",
  "products",
] as const;

const ALLOWED_PLAN_SAVE_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_PLAN_SAVE_KEYS,
  "forecast",
]);

function parseCostsPlanSaveArgs(input: unknown): CostsPlanSaveRequest {
  if (
    !isRecord(input) ||
    !REQUIRED_PLAN_SAVE_KEYS.every((key) => Object.hasOwn(input, key)) ||
    !Object.keys(input).every((key) => ALLOWED_PLAN_SAVE_KEYS.has(key)) ||
    (input.expectedPlanRevision !== null &&
      (!Number.isSafeInteger(input.expectedPlanRevision) ||
        Number(input.expectedPlanRevision) < 1)) ||
    (input.dailyLaborMinor !== null &&
      (!Number.isSafeInteger(input.dailyLaborMinor) ||
        Number(input.dailyLaborMinor) < 0 ||
        Number(input.dailyLaborMinor) > 1_000_000_000)) ||
    (input.dailyRentMinor !== null &&
      (!Number.isSafeInteger(input.dailyRentMinor) ||
        Number(input.dailyRentMinor) < 0 ||
        Number(input.dailyRentMinor) > 1_000_000_000))
  ) {
    throw new TypeError("costs_plan_save arguments are invalid");
  }

  let products: ProductCostPlanEntry[] | null = null;
  if (input.products !== null) {
    if (!Array.isArray(input.products) || input.products.length > 200) {
      throw new TypeError("costs_plan_save products are invalid");
    }
    const seen = new Set<string>();
    products = input.products.map((rawEntry: unknown) => {
      if (
        !isRecord(rawEntry) ||
        !hasExactKeys(rawEntry, ["productId", "weekUnits", "spoilBps"]) ||
        typeof rawEntry.productId !== "string" ||
        rawEntry.productId.trim().length === 0 ||
        rawEntry.productId.trim().length > 160 ||
        !Array.isArray(rawEntry.weekUnits) ||
        rawEntry.weekUnits.length !== 7 ||
        (rawEntry.spoilBps !== null &&
          (!Number.isSafeInteger(rawEntry.spoilBps) ||
            Number(rawEntry.spoilBps) < 0 ||
            Number(rawEntry.spoilBps) > 9_500))
      ) {
        throw new TypeError("costs_plan_save product entry is invalid");
      }
      const productId = rawEntry.productId.trim();
      if (seen.has(productId)) {
        throw new TypeError(
          `costs_plan_save duplicate productId: ${productId}`,
        );
      }
      seen.add(productId);
      const parsedWeek = rawEntry.weekUnits.map((dayVal: unknown) => {
        if (
          !Number.isSafeInteger(dayVal) ||
          Number(dayVal) < 0 ||
          Number(dayVal) > 100_000
        ) {
          throw new TypeError(
            "costs_plan_save weekUnits must be integers >= 0",
          );
        }
        return Number(dayVal);
      });
      const weekUnits: WeekUnits = [
        parsedWeek[0] ?? 0,
        parsedWeek[1] ?? 0,
        parsedWeek[2] ?? 0,
        parsedWeek[3] ?? 0,
        parsedWeek[4] ?? 0,
        parsedWeek[5] ?? 0,
        parsedWeek[6] ?? 0,
      ];
      return {
        productId,
        weekUnits,
        spoilBps: rawEntry.spoilBps === null ? null : Number(rawEntry.spoilBps),
      };
    });
  }

  let forecast: CostForecastPlan | null | undefined;
  if (input.forecast !== undefined) {
    if (input.forecast === null) {
      forecast = null;
    } else {
      if (
        !isRecord(input.forecast) ||
        !hasExactKeys(input.forecast, [
          "openingCashMinor",
          "demandCurve",
          "weekDemandPct",
          "supplierTerms",
          "extraShiftThresholdPct",
          "extraShiftWeeklyMinor",
          "capexMinor",
        ]) ||
        !Number.isSafeInteger(input.forecast.openingCashMinor) ||
        Number(input.forecast.openingCashMinor) < 0 ||
        typeof input.forecast.demandCurve !== "string" ||
        !FORECAST_DEMAND_CURVES.has(input.forecast.demandCurve) ||
        !Array.isArray(input.forecast.weekDemandPct) ||
        input.forecast.weekDemandPct.length !== 12 ||
        !input.forecast.weekDemandPct.every(
          (v: unknown) =>
            Number.isSafeInteger(v) && Number(v) >= 10 && Number(v) <= 500,
        ) ||
        typeof input.forecast.supplierTerms !== "string" ||
        !FORECAST_SUPPLIER_TERMS.has(input.forecast.supplierTerms) ||
        !Number.isSafeInteger(input.forecast.extraShiftThresholdPct) ||
        Number(input.forecast.extraShiftThresholdPct) < 101 ||
        Number(input.forecast.extraShiftThresholdPct) > 400 ||
        !Number.isSafeInteger(input.forecast.extraShiftWeeklyMinor) ||
        Number(input.forecast.extraShiftWeeklyMinor) < 0 ||
        !Number.isSafeInteger(input.forecast.capexMinor) ||
        Number(input.forecast.capexMinor) < 0
      ) {
        throw new TypeError("costs_plan_save forecast is invalid");
      }
      forecast = normalizeCostForecastPlan(
        input.forecast as Partial<CostForecastPlan>,
      );
    }
  }

  if (
    input.dailyLaborMinor === null &&
    input.dailyRentMinor === null &&
    (products === null || products.length === 0) &&
    forecast === undefined
  ) {
    throw new TypeError(
      "costs_plan_save requires dailyLaborMinor, dailyRentMinor, forecast, or at least one product entry",
    );
  }

  return {
    expectedPlanRevision:
      input.expectedPlanRevision === null
        ? null
        : Number(input.expectedPlanRevision),
    dailyLaborMinor:
      input.dailyLaborMinor === null ? null : Number(input.dailyLaborMinor),
    dailyRentMinor:
      input.dailyRentMinor === null ? null : Number(input.dailyRentMinor),
    products,
    ...(forecast !== undefined ? { forecast } : {}),
  };
}

function parseCostsSheetEditArgs(input: unknown): CostsSheetEditRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["changes"]) ||
    !Array.isArray(input.changes) ||
    input.changes.length === 0 ||
    input.changes.length > 100
  ) {
    throw new TypeError("costs_sheet_edit arguments are invalid");
  }
  const changes: CostsSheetCellChange[] = input.changes.map((raw: unknown) => {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["cellKey", "value"]) ||
      typeof raw.cellKey !== "string"
    ) {
      throw new TypeError("costs_sheet_edit change entry is invalid");
    }
    const cellKey = raw.cellKey.trim();
    if (cellKey === META_SAVED_AT_CELL_KEY || !isCostsSheetCellKey(cellKey)) {
      throw new TypeError(`costs_sheet_edit cellKey is invalid: ${cellKey}`);
    }
    if (raw.value === null) {
      return { cellKey, value: null };
    }
    if (typeof raw.value !== "string") {
      throw new TypeError(`costs_sheet_edit value for ${cellKey} is invalid`);
    }
    const trimmed = raw.value.trim();
    if (!isCostsSheetCellEntry(cellKey, trimmed)) {
      throw new TypeError(
        `costs_sheet_edit value '${trimmed}' is invalid for ${cellKey}`,
      );
    }
    return { cellKey, value: trimmed };
  });
  return { changes };
}
