import { Type, type Static } from "typebox";
import {
  recordParser,
  NonNegativeInteger,
  PositiveInteger,
} from "@purin-labs/contract-schema";
import { recipeRevisionResourceSchema } from "@purin-labs/commerce-contracts/records/api-food-service";
import {
  evaluateCostFormula,
  isCostFormulaColumn,
  isValidCostFormulaString,
} from "./costs-formulas.ts";
import { costForecastPlanSchema } from "./costs-forecast.ts";
export * from "./costs-formulas.ts";

const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
const revision = PositiveInteger;
const nonNegativeInt = NonNegativeInteger;

export const costUnitSchema = Type.Union([
  Type.Literal("each"),
  Type.Literal("gram"),
  Type.Literal("kilogram"),
  Type.Literal("milliliter"),
  Type.Literal("liter"),
]);

export type CostUnit = Static<typeof costUnitSchema>;

export const supplyCostBulkTierSchema = Type.Object({
  min7dQuantity: Type.Number({ exclusiveMinimum: 0 }),
  packQuantity: Type.Number({ exclusiveMinimum: 0 }),
  packPriceMinor: nonNegativeInt,
});

export type SupplyCostBulkTier = Static<typeof supplyCostBulkTierSchema>;

export const supplyCostTermsSchema = Type.Object({
  entryId: text,
  entryRevision: revision,
  currency: text,
  packQuantity: Type.Number({ exclusiveMinimum: 0 }),
  packUnit: costUnitSchema,
  packPriceMinor: nonNegativeInt,
  supplierId: nullableText,
  bulkTier: Type.Union([supplyCostBulkTierSchema, Type.Null()]),
  notes: nullableText,
});

export type SupplyCostTerms = Static<typeof supplyCostTermsSchema>;

export const supplyCostItemSchema = Type.Object({
  id: text,
  merchantCode: Type.String(),
  name: text,
  category: Type.Union([
    Type.Literal("ingredient"),
    Type.Literal("packaging"),
    Type.Literal("finished_good"),
    Type.Literal("operating_supply"),
  ]),
  baseUnit: costUnitSchema,
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
  costTerms: Type.Union([supplyCostTermsSchema, Type.Null()]),
  onHandQuantity: Type.Optional(
    Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  ),
});

export type SupplyCostItem = Static<typeof supplyCostItemSchema>;

const directPackagingInputSchema = Type.Object({
  inventoryItemId: text,
  quantity: Type.Object({
    amount: PositiveInteger,
    scale: nonNegativeInt,
    unit: costUnitSchema,
  }),
});

export const costProductLinkSchema = Type.Object({
  productId: text,
  productTitle: text,
  productType: Type.String(),
  variantId: text,
  variantTitle: text,
  offerId: text,
  offerRevision: revision,
  priceMinor: nonNegativeInt,
  currency: text,
  fulfillmentKind: Type.Union([
    Type.Literal("stocked"),
    Type.Literal("prepared"),
  ]),
  recipeId: nullableText,
  finishedGoodItemId: nullableText,
  directPackagingInputs: Type.Array(directPackagingInputSchema),
  defaultDailyUnits: nonNegativeInt,
  imageUrl: Type.Optional(nullableText),
});

export type CostProductLink = Static<typeof costProductLinkSchema>;

export const weekUnitsSchema = Type.Tuple([
  nonNegativeInt,
  nonNegativeInt,
  nonNegativeInt,
  nonNegativeInt,
  nonNegativeInt,
  nonNegativeInt,
  nonNegativeInt,
]);

export type WeekUnits = Static<typeof weekUnitsSchema>;

export const productCostFormulasSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 24 }),
  Type.String({ minLength: 1, maxLength: 160 }),
);

export const productCostPlanEntrySchema = Type.Object({
  productId: text,
  weekUnits: weekUnitsSchema,
  spoilBps: Type.Union([
    Type.Integer({ minimum: 0, maximum: 9_500 }),
    Type.Null(),
  ]),
  cogsOverrideMinor: Type.Optional(
    Type.Union([nonNegativeInt, Type.Null()]),
  ),
  wasteOverrideMinor: Type.Optional(
    Type.Union([nonNegativeInt, Type.Null()]),
  ),
  formulas: Type.Optional(productCostFormulasSchema),
});

export type ProductCostPlanEntry = Static<typeof productCostPlanEntrySchema>;

export const organisationCostPlanSchema = Type.Object({
  revision: Type.Union([revision, Type.Null()]),
  dailyLaborMinor: nonNegativeInt,
  dailyRentMinor: nonNegativeInt,
  products: Type.Array(productCostPlanEntrySchema),
  forecast: Type.Optional(costForecastPlanSchema),
});

export type OrganisationCostPlan = Static<typeof organisationCostPlanSchema>;

export const measuredWasteSummarySchema = Type.Object({
  windowDays: revision,
  stockedUnitsProduced: Type.Number({ minimum: 0 }),
  stockedUnitsWasted: Type.Number({ minimum: 0 }),
  measuredShelfWastePct: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  plannedBatchUnits: Type.Number({ minimum: 0 }),
  actualBatchUnits: Type.Number({ minimum: 0 }),
  measuredBatchRejectPct: Type.Union([
    Type.Number({ minimum: 0 }),
    Type.Null(),
  ]),
  supplyLossMovementsCount: nonNegativeInt,
});

export type MeasuredWasteSummary = Static<typeof measuredWasteSummarySchema>;

export const costValuationBasisSchema = Type.Union([
  Type.Literal("standing"),
  Type.Literal("fifo_lot"),
  Type.Literal("weighted_lot"),
]);

export type CostValuationBasis = Static<typeof costValuationBasisSchema>;

export const supplyLotInvoiceCostSchema = Type.Object({
  source: Type.Union([
    Type.Literal("lot_invoice"),
    Type.Literal("supplier_payable"),
  ]),
  invoiceReference: nullableText,
  supplierId: nullableText,
  currency: text,
  invoicedQuantity: Type.Number({ exclusiveMinimum: 0 }),
  invoicedUnit: costUnitSchema,
  invoiceTotalMinor: nonNegativeInt,
  revision: revision,
});

export type SupplyLotInvoiceCost = Static<typeof supplyLotInvoiceCostSchema>;

export const supplyLotCostSchema = Type.Object({
  id: text,
  inventoryItemId: text,
  locationId: text,
  lotCode: text,
  receivedAt: text,
  expiresAt: nullableText,
  receivedQuantity: Type.Number({ minimum: 0 }),
  remainingQuantity: Type.Number({ minimum: 0 }),
  baseUnit: costUnitSchema,
  lifecycle: Type.Union([
    Type.Literal("active"),
    Type.Literal("depleted"),
    Type.Literal("expired"),
  ]),
  sourceMovementId: text,
  receiptId: nullableText,
  purchaseRequestId: nullableText,
  invoiceCost: Type.Union([supplyLotInvoiceCostSchema, Type.Null()]),
});

export type SupplyLotCost = Static<typeof supplyLotCostSchema>;

export const actualsWindowDaysSchema = Type.Union([
  Type.Literal(7),
  Type.Literal(30),
]);

export type ActualsWindowDays = Static<typeof actualsWindowDaysSchema>;

export const productActualsObservationSchema = Type.Object({
  productId: text,
  unitsSold: Type.Number({ minimum: 0 }),
  posUnitsSold: Type.Number({ minimum: 0 }),
  onlineUnitsSold: Type.Number({ minimum: 0 }),
  grossSalesMinor: Type.Number({ minimum: 0 }),
  includedTaxMinor: Type.Number({ minimum: 0 }),
  batchCount: nonNegativeInt,
  plannedBatchUnits: Type.Number({ minimum: 0 }),
  actualBatchUnits: Type.Number({ minimum: 0 }),
  stockedUnitsProduced: Type.Number({ minimum: 0 }),
  stockedUnitsWasted: Type.Number({ minimum: 0 }),
});

export type ProductActualsObservation = Static<
  typeof productActualsObservationSchema
>;

export const supplyActualLossObservationSchema = Type.Object({
  inventoryItemId: text,
  movementCount: nonNegativeInt,
  wastedBaseQuantity: Type.Number({ minimum: 0 }),
});

export type SupplyActualLossObservation = Static<
  typeof supplyActualLossObservationSchema
>;

export const costsActualsWindowSnapshotSchema = Type.Object({
  windowDays: actualsWindowDaysSchema,
  windowStartAt: text,
  windowEndAt: text,
  orderCount: nonNegativeInt,
  posOrderCount: nonNegativeInt,
  onlineOrderCount: nonNegativeInt,
  grossSalesMinor: Type.Number({ minimum: 0 }),
  includedTaxMinor: Type.Number({ minimum: 0 }),
  refundsMinor: Type.Number({ minimum: 0 }),
  settledPayablesMinor: Type.Number({ minimum: 0 }),
  openPayablesMinor: Type.Number({ minimum: 0 }),
  payableCount: nonNegativeInt,
  products: Type.Array(productActualsObservationSchema),
  supplyLosses: Type.Array(supplyActualLossObservationSchema),
});

export type CostsActualsWindowSnapshot = Static<
  typeof costsActualsWindowSnapshotSchema
>;

export const costsActualsSnapshotSchema = Type.Object({
  windows: Type.Array(costsActualsWindowSnapshotSchema),
});

export type CostsActualsSnapshot = Static<typeof costsActualsSnapshotSchema>;

export const costsOverviewSchema = Type.Object({
  ok: Type.Literal(true),
  merchantRevision: nonNegativeInt,
  currency: text,
  canEditPrices: Type.Boolean(),
  defaultIncludedTaxBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  includedTaxSource: Type.Union([
    Type.Literal("checkout_profile"),
    Type.Literal("orders"),
    Type.Literal("jpy_food_default"),
    Type.Literal("none"),
  ]),
  recipes: Type.Array(recipeRevisionResourceSchema),
  items: Type.Array(supplyCostItemSchema),
  products: Type.Array(costProductLinkSchema),
  measuredWaste: measuredWasteSummarySchema,
  costPlan: organisationCostPlanSchema,
  lots: Type.Optional(Type.Array(supplyLotCostSchema)),
  actuals: Type.Optional(costsActualsSnapshotSchema),
});

export type CostsOverview = Static<typeof costsOverviewSchema>;

export const supplyCostWriteSchema = Type.Object({
  merchantRevision: nonNegativeInt,
  requestedAt: text,
  inventoryItemId: text,
  expectedEntryRevision: Type.Union([revision, Type.Null()]),
  currency: text,
  packQuantity: Type.Number({ exclusiveMinimum: 0 }),
  packUnit: costUnitSchema,
  packPriceMinor: nonNegativeInt,
  supplierId: nullableText,
  bulkTier: Type.Union([supplyCostBulkTierSchema, Type.Null()]),
  notes: nullableText,
});

export type SupplyCostWrite = Static<typeof supplyCostWriteSchema>;

export const lotCostLineWriteSchema = Type.Object({
  lotId: text,
  inventoryItemId: text,
  expectedRevision: Type.Union([revision, Type.Null()]),
  currency: text,
  invoicedQuantity: Type.Number({ exclusiveMinimum: 0 }),
  invoicedUnit: costUnitSchema,
  invoiceTotalMinor: nonNegativeInt,
  invoiceReference: nullableText,
  supplierId: nullableText,
});

export type LotCostLineWrite = Static<typeof lotCostLineWriteSchema>;

export const lotCostWriteSchema = Type.Object({
  kind: Type.Literal("save_lot_cost"),
  merchantRevision: nonNegativeInt,
  requestedAt: text,
  lotId: text,
  inventoryItemId: text,
  expectedRevision: Type.Union([revision, Type.Null()]),
  currency: text,
  invoicedQuantity: Type.Number({ exclusiveMinimum: 0 }),
  invoicedUnit: costUnitSchema,
  invoiceTotalMinor: nonNegativeInt,
  invoiceReference: nullableText,
  supplierId: nullableText,
});

export type LotCostWrite = Static<typeof lotCostWriteSchema>;

export const offerPriceWriteSchema = Type.Object({
  offerId: text,
  expectedOfferRevision: revision,
  currency: text,
  priceMinor: nonNegativeInt,
});

export type OfferPriceWrite = Static<typeof offerPriceWriteSchema>;

export const costPlanWriteSchema = Type.Object({
  expectedPlanRevision: Type.Union([revision, Type.Null()]),
  dailyLaborMinor: nonNegativeInt,
  dailyRentMinor: nonNegativeInt,
  products: Type.Array(productCostPlanEntrySchema),
  forecast: Type.Optional(costForecastPlanSchema),
});

export type CostPlanWrite = Static<typeof costPlanWriteSchema>;

export const supplyCostLineWriteSchema = Type.Object({
  inventoryItemId: text,
  expectedEntryRevision: Type.Union([revision, Type.Null()]),
  currency: text,
  packQuantity: Type.Number({ exclusiveMinimum: 0 }),
  packUnit: costUnitSchema,
  packPriceMinor: nonNegativeInt,
  supplierId: nullableText,
  bulkTier: Type.Union([supplyCostBulkTierSchema, Type.Null()]),
  notes: nullableText,
});

export type SupplyCostLineWrite = Static<typeof supplyCostLineWriteSchema>;

export const costsSheetWriteSchema = Type.Object({
  kind: Type.Literal("save_sheet"),
  merchantRevision: nonNegativeInt,
  requestedAt: text,
  planWrite: Type.Union([costPlanWriteSchema, Type.Null()]),
  priceWrites: Type.Array(offerPriceWriteSchema),
  supplyWrites: Type.Array(supplyCostLineWriteSchema),
  lotWrites: Type.Optional(Type.Array(lotCostLineWriteSchema)),
});

export type CostsSheetWrite = Static<typeof costsSheetWriteSchema>;

export const costsSheetWriteResultSchema = Type.Object({
  ok: Type.Literal(true),
  merchantRevision: nonNegativeInt,
  planRevision: Type.Union([revision, Type.Null()]),
  updatedOfferCount: nonNegativeInt,
  updatedSupplyCount: nonNegativeInt,
  updatedLotCount: Type.Optional(nonNegativeInt),
});

export type CostsSheetWriteResult = Static<typeof costsSheetWriteResultSchema>;

const decodeOverview = recordParser(costsOverviewSchema);
const decodeSupplyWrite = recordParser(supplyCostWriteSchema);
const decodeLotCostWrite = recordParser(lotCostWriteSchema);
const decodeSheetWrite = recordParser(costsSheetWriteSchema);
const decodeSheetWriteResult = recordParser(costsSheetWriteResultSchema);

const DEFAULT_WEEK_WEIGHTS: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] = [0.75, 0.8, 0.85, 0.95, 1.1, 1.35, 1.2];

export function parseCostsOverview(value: unknown): CostsOverview {
  const result = decodeOverview(value);
  if (!result.ok) {
    throw new Error("Costs and margins could not be read.");
  }
  return result.value;
}

function validateSupplyLineFields(line: SupplyCostLineWrite): void {
  if (!/^[A-Z]{3}$/u.test(line.currency)) {
    throw new Error("Currency must be a 3-letter ISO code such as JPY.");
  }
  if (!Number.isFinite(line.packQuantity) || line.packQuantity <= 0) {
    throw new Error("Enter a positive pack quantity.");
  }
  if (line.bulkTier !== null) {
    if (
      !Number.isFinite(line.bulkTier.min7dQuantity) ||
      line.bulkTier.min7dQuantity <= 0 ||
      !Number.isFinite(line.bulkTier.packQuantity) ||
      line.bulkTier.packQuantity <= 0
    ) {
      throw new Error("Enter positive 7-day tier quantities.");
    }
  }
}

function validateLotCostLineFields(line: LotCostLineWrite): void {
  if (!/^[A-Z]{3}$/u.test(line.currency)) {
    throw new Error("Currency must be a 3-letter ISO code such as JPY.");
  }
  if (!Number.isFinite(line.invoicedQuantity) || line.invoicedQuantity <= 0) {
    throw new Error("Enter a positive invoiced quantity.");
  }
  if (
    line.invoiceReference !== null &&
    line.invoiceReference.trim().length === 0
  ) {
    throw new Error("Enter a supplier invoice reference.");
  }
}

export function parseSupplyCostWrite(value: unknown): SupplyCostWrite {
  const result = decodeSupplyWrite(value);
  if (!result.ok) {
    throw new Error("The supply cost terms are invalid.");
  }
  if (!Number.isFinite(Date.parse(result.value.requestedAt))) {
    throw new Error("The supply cost save time is invalid.");
  }
  validateSupplyLineFields(result.value);
  return result.value;
}

export function parseLotCostWrite(value: unknown): LotCostWrite {
  const result = decodeLotCostWrite(value);
  if (!result.ok) {
    throw new Error("The lot invoice cost fields are invalid.");
  }
  if (!Number.isFinite(Date.parse(result.value.requestedAt))) {
    throw new Error("The lot invoice save time is invalid.");
  }
  validateLotCostLineFields(result.value);
  return result.value;
}

export function parseCostsSheetWrite(value: unknown): CostsSheetWrite {
  const result = decodeSheetWrite(value);
  if (!result.ok) {
    throw new Error("The cost sheet changes are invalid.");
  }
  const sheet = result.value;
  if (!Number.isFinite(Date.parse(sheet.requestedAt))) {
    throw new Error("The cost sheet save time is invalid.");
  }
  const lotWrites = sheet.lotWrites ?? [];
  if (
    sheet.planWrite === null &&
    sheet.priceWrites.length === 0 &&
    sheet.supplyWrites.length === 0 &&
    lotWrites.length === 0
  ) {
    throw new Error("There are no changes to save.");
  }
  const seenOffers = new Set<string>();
  for (const priceWrite of sheet.priceWrites) {
    if (!/^[A-Z]{3}$/u.test(priceWrite.currency)) {
      throw new Error("Currency must be a 3-letter ISO code such as JPY.");
    }
    if (seenOffers.has(priceWrite.offerId)) {
      throw new Error("Each offer may appear only once in a save.");
    }
    seenOffers.add(priceWrite.offerId);
  }
  const seenSupplies = new Set<string>();
  for (const supplyWrite of sheet.supplyWrites) {
    validateSupplyLineFields(supplyWrite);
    if (seenSupplies.has(supplyWrite.inventoryItemId)) {
      throw new Error("Each supply item may appear only once in a save.");
    }
    seenSupplies.add(supplyWrite.inventoryItemId);
  }
  const seenLots = new Set<string>();
  for (const lotWrite of lotWrites) {
    validateLotCostLineFields(lotWrite);
    if (seenLots.has(lotWrite.lotId)) {
      throw new Error("Each inventory lot may appear only once in a save.");
    }
    seenLots.add(lotWrite.lotId);
  }
  if (sheet.planWrite !== null) {
    const seenProducts = new Set<string>();
    for (const entry of sheet.planWrite.products) {
      if (seenProducts.has(entry.productId)) {
        throw new Error("Each product may appear only once in a cost plan.");
      }
      seenProducts.add(entry.productId);
    }
  }
  return sheet;
}

export function parseCostsSheetWriteResult(
  value: unknown,
): CostsSheetWriteResult {
  const result = decodeSheetWriteResult(value);
  if (!result.ok) {
    throw new Error("The cost sheet save receipt is invalid.");
  }
  return result.value;
}

export function defaultWeekUnitsForDaily(dailyUnits: number): WeekUnits {
  const clamped = clampInteger(dailyUnits, 0, 100_000);
  if (clamped === 0) {
    return [0, 0, 0, 0, 0, 0, 0];
  }
  return allocateWeekUnits(DEFAULT_WEEK_WEIGHTS, clamped * 7);
}

export function scaleWeekUnitsToDaily(
  current: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
  dailyUnits: number,
): WeekUnits {
  const clamped = clampInteger(dailyUnits, 0, 100_000);
  if (clamped === 0) {
    return [0, 0, 0, 0, 0, 0, 0];
  }
  const currentTotal = current.reduce((sum, day) => sum + Math.max(0, day), 0);
  const weights = currentTotal > 0 ? current : DEFAULT_WEEK_WEIGHTS;
  return allocateWeekUnits(weights, clamped * 7);
}

function allocateWeekUnits(
  weights: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
  sevenDayTotal: number,
): WeekUnits {
  const totalWeight = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (totalWeight <= 0 || sevenDayTotal <= 0) {
    return [0, 0, 0, 0, 0, 0, 0];
  }
  const raw = weights.map((w) => (Math.max(0, w) / totalWeight) * sevenDayTotal);
  const floors = raw.map((val) => Math.floor(val));
  let remainderUnits =
    sevenDayTotal - floors.reduce((sum, val) => sum + val, 0);
  const order = raw
    .map((val, idx) => ({ idx, frac: val - (floors[idx] ?? 0) }))
    .sort((left, right) => right.frac - left.frac || left.idx - right.idx);
  for (let i = 0; i < order.length && remainderUnits > 0; i += 1) {
    const entry = order[i];
    if (entry !== undefined) {
      floors[entry.idx] = (floors[entry.idx] ?? 0) + 1;
      remainderUnits -= 1;
    }
  }
  return [
    floors[0] ?? 0,
    floors[1] ?? 0,
    floors[2] ?? 0,
    floors[3] ?? 0,
    floors[4] ?? 0,
    floors[5] ?? 0,
    floors[6] ?? 0,
  ];
}

export function backSolveGrossPriceMinorForMargin(input: Readonly<{
  fixedUnitCostMinor: number;
  includedTaxBps: number;
  channelFeeBps: number;
  targetNetMarginPct: number;
}>): number | null {
  const targetPct = clampNumber(input.targetNetMarginPct, -200, 95);
  const taxBps = clampInteger(input.includedTaxBps, 0, 10_000);
  const feeBps = clampInteger(input.channelFeeBps, 0, 3_000);
  const fixedCost = Math.max(0, input.fixedUnitCostMinor);
  if (fixedCost === 0) {
    return 0;
  }
  const taxShare = taxBps > 0 ? taxBps / (10_000 + taxBps) : 0;
  const feeShare = feeBps / 10_000;
  const keepRatio = 1 - taxShare - feeShare - targetPct / 100;
  if (keepRatio <= 0.01) {
    return null;
  }
  const approx = Math.max(1, Math.ceil(fixedCost / keepRatio));
  const start = Math.max(1, approx - 4);
  const end = Math.min(100_000_000, approx + 8);
  for (let candidate = start; candidate <= end; candidate += 1) {
    const taxMinor =
      taxBps > 0 ? Math.round((candidate * taxBps) / (10_000 + taxBps)) : 0;
    const feeMinor = (candidate * feeBps) / 10_000;
    const netMinor = candidate - fixedCost - taxMinor - feeMinor;
    const pct = (netMinor / candidate) * 100;
    if (pct + 1e-9 >= targetPct) {
      return candidate;
    }
  }
  return clampInteger(approx, 1, 100_000_000);
}

export function areCostUnitsCompatible(
  left: CostUnit,
  right: CostUnit,
): boolean {
  return convertCostQuantity(1, left, right) !== null;
}

export function convertCostQuantity(
  amount: number,
  from: CostUnit,
  to: CostUnit,
): number | null {
  if (from === to) {
    return amount;
  }
  if (from === "kilogram" && to === "gram") {
    return amount * 1_000;
  }
  if (from === "gram" && to === "kilogram") {
    return amount / 1_000;
  }
  if (from === "liter" && to === "milliliter") {
    return amount * 1_000;
  }
  if (from === "milliliter" && to === "liter") {
    return amount / 1_000;
  }
  return null;
}

export function scaledQuantityAmount(
  quantity: Readonly<{ amount: number; scale: number }>,
): number {
  return quantity.amount / 10 ** quantity.scale;
}

export type CostScenarioAssumptions = Readonly<{
  bakeShelfWastePct: number;
  prepRejectPct: number;
  channelFeeBps: number;
  includedTaxBps: number;
  applyBulkTiers: boolean;
  lotCostBasis: CostValuationBasis;
  operatingDaysPerMonth: number;
}>;

export type SupplyCostSourceKind =
  | "standing_pack"
  | "bulk_tier"
  | "fifo_lot"
  | "weighted_lot"
  | "unpriced";

export type CalculatedSupplySkuImpact = Readonly<{
  productId: string;
  productTitle: string;
  quantityPerUnit: number;
  unit: CostUnit;
  unitCostMinor: number;
  currentMarginPct: number;
  lotUnitDeltaMinor: number | null;
  lotMarginDeltaPct: number | null;
  tenPctHikeUnitDeltaMinor: number;
  tenPctHikeMarginDeltaPct: number;
}>;

export type CalculatedProductBomLine = Readonly<{
  inventoryItemId: string;
  merchantCode: string;
  name: string;
  category: SupplyCostItem["category"];
  source: "recipe" | "direct_packaging";
  quantityPerBatch: number;
  quantityPerUnit: number;
  unit: CostUnit;
  baseUnit: CostUnit;
  activePackQuantity: number | null;
  activePackUnit: CostUnit | null;
  activePackPriceMinor: number | null;
  effectiveRatePerBaseUnitMinor: number | null;
  costPerBatchMinor: number;
  costPerUnitMinor: number;
  shareOfBomPct: number;
  bulkUnlocked: boolean;
  hasCostTerms: boolean;
  costSource: SupplyCostSourceKind;
  lotCostVariancePct: number | null;
  reorderSuggested: boolean;
}>;

export type CalculatedSupplyUsage = Readonly<{
  inventoryItemId: string;
  merchantCode: string;
  name: string;
  category: SupplyCostItem["category"];
  baseUnit: CostUnit;
  costTerms: SupplyCostTerms | null;
  dailyBaseUsage: number;
  sevenDayBaseUsage: number;
  sevenDayPackUnitUsage: number | null;
  standardCostPerBaseUnitMinor: number | null;
  effectiveCostPerBaseUnitMinor: number | null;
  bulkUnlocked: boolean;
  activeLotCount: number;
  pricedLotCount: number;
  availableLotBaseQuantity: number;
  onHandBaseQuantity: number | null;
  daysOfSupply: number | null;
  reorderSuggested: boolean;
  fifoLotCostPerBaseUnitMinor: number | null;
  weightedLotCostPerBaseUnitMinor: number | null;
  fifoEquivalentPackPriceMinor: number | null;
  weightedEquivalentPackPriceMinor: number | null;
  lotCostVariancePct: number | null;
  costSource: SupplyCostSourceKind;
  dailySpendMinor: number;
  dailyTierSavingsMinor: number;
  usedInProductCount: number;
  weeklyLotVarianceImpactMinor: number | null;
  tenPctHikeWeeklyImpactMinor: number;
  skuImpacts: readonly CalculatedSupplySkuImpact[];
}>;

export type CalculatedRecipeInputLine = Readonly<{
  inventoryItemId: string;
  name: string;
  category: SupplyCostItem["category"];
  quantityPerBatch: number;
  unit: CostUnit;
  costPerBatchMinor: number;
  bulkUnlocked: boolean;
  hasCostTerms: boolean;
  costSource: SupplyCostSourceKind;
}>;

export type CalculatedRecipeCost = Readonly<{
  recipeId: string;
  recipeRevision: number;
  name: string;
  outputKind: "stocked" | "immediate";
  batchYield: number;
  outputUnit: CostUnit;
  dailyTargetUnits: number;
  batchesPerDay: number;
  producedUnits: number;
  unsoldAndRejectedUnits: number;
  ingredientBatchCostMinor: number;
  packagingBatchCostMinor: number;
  totalBatchCostMinor: number;
  rawUnitCostMinor: number;
  missingCostItemIds: readonly string[];
  lines: readonly CalculatedRecipeInputLine[];
}>;

export type CalculatedProductMargin = Readonly<{
  productId: string;
  productTitle: string;
  productType: string;
  imageUrl: string | null;
  variantId: string;
  variantTitle: string;
  offerId: string;
  offerRevision: number;
  currency: string;
  fulfillmentKind: "stocked" | "prepared";
  recipeId: string | null;
  recipeRevision: number | null;
  recipeName: string | null;
  batchYield: number;
  effectiveSpoilagePct: number;
  weekUnits: WeekUnits;
  sevenDayUnits: number;
  sevenDayBatches: number;
  dailyTargetUnits: number;
  batchesPerDay: number;
  producedUnits: number;
  unsoldAndRejectedUnits: number;
  grossPriceMinor: number;
  includedTaxMinor: number;
  netExTaxPriceMinor: number;
  ingredientUnitCostMinor: number;
  packagingUnitCostMinor: number;
  bomUnitCostMinor: number;
  effectiveCogsUnitMinor: number;
  hasCogsOverride: boolean;
  formulaWasteUnitMinor: number;
  wasteAndSurplusUnitMinor: number;
  hasWasteOverride: boolean;
  activeFormulas: Readonly<Record<string, string>>;
  channelFeeMinor: number;
  allInUnitCostMinor: number;
  netContributionUnitMinor: number;
  netMarginPct: number;
  dailyGrossRevenueMinor: number;
  dailyNetExTaxRevenueMinor: number;
  dailyAllInCostMinor: number;
  dailyNetContributionMinor: number;
  sevenDayGrossRevenueMinor: number;
  sevenDayNetContributionMinor: number;
  missingCostItemIds: readonly string[];
  bomLines: readonly CalculatedProductBomLine[];
}>;

export type BakeryCostSummary = Readonly<{
  currency: string;
  dailyUnitsSold: number;
  dailyGrossRevenueMinor: number;
  dailyIncludedTaxMinor: number;
  dailyNetExTaxRevenueMinor: number;
  dailyIngredientSpendMinor: number;
  dailyPackagingSpendMinor: number;
  dailyWasteSpendMinor: number;
  dailyChannelFeeMinor: number;
  dailyTierSavingsMinor: number;
  unlockedBulkTierCount: number;
  missingSupplyCostCount: number;
  dailyNetContributionMinor: number;
  netMarginPct: number;
  netMarginExTaxPct: number;
  dailyLaborMinor: number;
  dailyRentMinor: number;
  dailyFixedCostMinor: number;
  dailyOperatingProfitMinor: number;
  operatingMarginPct: number;
  breakEvenUnitsPerDay: number | null;
  monthlyGrossRevenueMinor: number;
  monthlyNetContributionMinor: number;
  monthlyFixedCostMinor: number;
  monthlyOperatingProfitMinor: number;
}>;

export type BakeryCostCalculation = Readonly<{
  assumptions: CostScenarioAssumptions;
  supplies: readonly CalculatedSupplyUsage[];
  recipes: readonly CalculatedRecipeCost[];
  products: readonly CalculatedProductMargin[];
  summary: BakeryCostSummary;
}>;

export function defaultCostAssumptions(
  overview: Pick<CostsOverview, "defaultIncludedTaxBps" | "measuredWaste">,
): CostScenarioAssumptions {
  const shelfWaste =
    overview.measuredWaste.measuredShelfWastePct !== null
      ? clampNumber(
          Math.round(overview.measuredWaste.measuredShelfWastePct * 10) / 10,
          0,
          45,
        )
      : 7;
  const reject =
    overview.measuredWaste.measuredBatchRejectPct !== null
      ? clampNumber(
          Math.round(overview.measuredWaste.measuredBatchRejectPct * 10) / 10,
          0,
          30,
        )
      : 2;
  return {
    bakeShelfWastePct: shelfWaste,
    prepRejectPct: reject,
    channelFeeBps: 320,
    includedTaxBps: clampInteger(overview.defaultIncludedTaxBps, 0, 10_000),
    applyBulkTiers: true,
    lotCostBasis: "standing",
    operatingDaysPerMonth: 26,
  };
}

export function calculateBakeryCostsAndMargins(
  input: Readonly<{
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
    };
    dailyTargets?: Readonly<Record<string, number>>;
    weeklyTargets?: Readonly<Record<string, readonly number[]>>;
    demandMode?: "daily" | "weekly";
    productSpoilagePctOverrides?: Readonly<Record<string, number>>;
    priceOverridesMinor?: Readonly<Record<string, number>>;
    cogsOverridesMinor?: Readonly<Record<string, number | null>>;
    wasteOverridesMinor?: Readonly<Record<string, number | null>>;
    productFormulas?: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
    dailyLaborMinor?: number;
    dailyRentMinor?: number;
    assumptions?: Partial<CostScenarioAssumptions>;
  }>,
): BakeryCostCalculation {
  const defaults = defaultCostAssumptions(input.overview);
  const rawBasis = input.assumptions?.lotCostBasis;
  const lotCostBasis: CostValuationBasis =
    rawBasis === "fifo_lot" ||
    rawBasis === "weighted_lot" ||
    rawBasis === "standing"
      ? rawBasis
      : defaults.lotCostBasis;
  const assumptions: CostScenarioAssumptions = {
    bakeShelfWastePct: clampNumber(
      input.assumptions?.bakeShelfWastePct ?? defaults.bakeShelfWastePct,
      0,
      95,
    ),
    prepRejectPct: clampNumber(
      input.assumptions?.prepRejectPct ?? defaults.prepRejectPct,
      0,
      50,
    ),
    channelFeeBps: clampInteger(
      input.assumptions?.channelFeeBps ?? defaults.channelFeeBps,
      0,
      3_000,
    ),
    includedTaxBps: clampInteger(
      input.assumptions?.includedTaxBps ?? defaults.includedTaxBps,
      0,
      10_000,
    ),
    applyBulkTiers:
      input.assumptions?.applyBulkTiers ?? defaults.applyBulkTiers,
    lotCostBasis,
    operatingDaysPerMonth: clampInteger(
      input.assumptions?.operatingDaysPerMonth ??
        defaults.operatingDaysPerMonth,
      1,
      31,
    ),
  };

  const demandMode = input.demandMode ?? "daily";
  const savedProductPlans = new Map(
    (input.overview.costPlan?.products ?? []).map((entry) => [
      entry.productId,
      entry,
    ]),
  );

  const itemsById = new Map(input.overview.items.map((item) => [item.id, item]));
  const activeRecipes = input.overview.recipes.filter(
    (recipe) => recipe.lifecycle.state === "active",
  );
  const productsByRecipeId = new Map<string, CostProductLink[]>();
  for (const product of input.overview.products) {
    if (product.recipeId === null) {
      continue;
    }
    const list = productsByRecipeId.get(product.recipeId) ?? [];
    list.push(product);
    productsByRecipeId.set(product.recipeId, list);
  }

  const defaultShelfFactor = Math.max(
    0.05,
    1 - assumptions.bakeShelfWastePct / 100,
  );
  const rejectFactor = Math.max(0.05, 1 - assumptions.prepRejectPct / 100);
  const prepMultiplier = 1 / rejectFactor;

  const productTargets = new Map<string, number>();
  const productWeeks = new Map<string, WeekUnits>();
  const productSpoilagePct = new Map<string, number>();

  for (const product of input.overview.products) {
    const savedEntry = savedProductPlans.get(product.productId);
    const explicitDaily =
      input.dailyTargets?.[product.variantId] ??
      input.dailyTargets?.[product.productId] ??
      input.dailyTargets?.[product.offerId] ??
      (product.recipeId !== null
        ? input.dailyTargets?.[product.recipeId]
        : undefined);
    const explicitWeekRaw =
      input.weeklyTargets?.[product.variantId] ??
      input.weeklyTargets?.[product.productId] ??
      input.weeklyTargets?.[product.offerId];

    let weekUnits: WeekUnits;
    if (explicitWeekRaw !== undefined && explicitWeekRaw.length === 7) {
      weekUnits = [
        clampInteger(explicitWeekRaw[0] ?? 0, 0, 100_000),
        clampInteger(explicitWeekRaw[1] ?? 0, 0, 100_000),
        clampInteger(explicitWeekRaw[2] ?? 0, 0, 100_000),
        clampInteger(explicitWeekRaw[3] ?? 0, 0, 100_000),
        clampInteger(explicitWeekRaw[4] ?? 0, 0, 100_000),
        clampInteger(explicitWeekRaw[5] ?? 0, 0, 100_000),
        clampInteger(explicitWeekRaw[6] ?? 0, 0, 100_000),
      ];
    } else if (explicitDaily !== undefined) {
      weekUnits = defaultWeekUnitsForDaily(explicitDaily);
    } else if (savedEntry !== undefined) {
      weekUnits = [
        clampInteger(savedEntry.weekUnits[0], 0, 100_000),
        clampInteger(savedEntry.weekUnits[1], 0, 100_000),
        clampInteger(savedEntry.weekUnits[2], 0, 100_000),
        clampInteger(savedEntry.weekUnits[3], 0, 100_000),
        clampInteger(savedEntry.weekUnits[4], 0, 100_000),
        clampInteger(savedEntry.weekUnits[5], 0, 100_000),
        clampInteger(savedEntry.weekUnits[6], 0, 100_000),
      ];
    } else {
      weekUnits = defaultWeekUnitsForDaily(product.defaultDailyUnits);
    }

    const sevenDaySum =
      weekUnits[0] +
      weekUnits[1] +
      weekUnits[2] +
      weekUnits[3] +
      weekUnits[4] +
      weekUnits[5] +
      weekUnits[6];

    const resolvedDaily =
      explicitDaily !== undefined && explicitWeekRaw === undefined
        ? clampInteger(explicitDaily, 0, 100_000)
        : explicitWeekRaw !== undefined || savedEntry !== undefined
          ? Math.round(sevenDaySum / 7)
          : clampInteger(product.defaultDailyUnits, 0, 100_000);

    productWeeks.set(product.variantId, weekUnits);
    productTargets.set(product.variantId, resolvedDaily);

    const spoilOverride =
      input.productSpoilagePctOverrides?.[product.variantId] ??
      input.productSpoilagePctOverrides?.[product.productId] ??
      input.productSpoilagePctOverrides?.[product.offerId];
    const effectiveSpoil =
      product.fulfillmentKind === "stocked"
        ? clampNumber(
            spoilOverride ??
              (savedEntry?.spoilBps != null
                ? savedEntry.spoilBps / 100
                : assumptions.bakeShelfWastePct),
            0,
            95,
          )
        : 0;
    productSpoilagePct.set(product.variantId, effectiveSpoil);
  }

  const recipeDemand = new Map<
    string,
    Readonly<{
      dailyTargetUnits: number;
      sevenDayTargetUnits: number;
      batchYield: number;
      batchesPerDay: number;
      sevenDayBatches: number;
      producedUnits: number;
      unsoldAndRejectedUnits: number;
    }>
  >();

  for (const recipe of activeRecipes) {
    const linkedProducts = productsByRecipeId.get(recipe.recipeId) ?? [];
    const explicitRecipeTarget = input.dailyTargets?.[recipe.recipeId];
    const batchYield =
      recipe.output.kind === "stocked"
        ? Math.max(0.000_001, scaledQuantityAmount(recipe.output.yieldQuantity))
        : 1;

    if (linkedProducts.length > 0 && explicitRecipeTarget === undefined) {
      let sumDailyUnits = 0;
      let sumDailyRawRequired = 0;
      const dayUnits: [number, number, number, number, number, number, number] =
        [0, 0, 0, 0, 0, 0, 0];
      const dayRawRequired: [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ] = [0, 0, 0, 0, 0, 0, 0];

      for (const product of linkedProducts) {
        const target = productTargets.get(product.variantId) ?? 0;
        const week =
          productWeeks.get(product.variantId) ?? [0, 0, 0, 0, 0, 0, 0];
        const spoilPct =
          productSpoilagePct.get(product.variantId) ??
          assumptions.bakeShelfWastePct;
        const pShelfFactor = Math.max(0.05, 1 - spoilPct / 100);
        sumDailyUnits += target;
        if (target > 0) {
          sumDailyRawRequired += target / pShelfFactor / rejectFactor;
        }
        for (let d = 0; d < 7; d += 1) {
          const u = week[d] ?? 0;
          dayUnits[d] = (dayUnits[d] ?? 0) + u;
          if (u > 0) {
            dayRawRequired[d] =
              (dayRawRequired[d] ?? 0) + u / pShelfFactor / rejectFactor;
          }
        }
      }

      const sevenDayTargetUnits = dayUnits.reduce((acc, u) => acc + u, 0);
      if (recipe.output.kind === "stocked") {
        let sevenDayBatches = 0;
        for (let d = 0; d < 7; d += 1) {
          const rawDay = dayRawRequired[d] ?? 0;
          if ((dayUnits[d] ?? 0) > 0) {
            sevenDayBatches += Math.max(1, Math.ceil(rawDay / batchYield));
          }
        }
        const singleDayBatches =
          sumDailyUnits === 0
            ? 0
            : Math.max(1, Math.ceil(sumDailyRawRequired / batchYield));
        const batchesPerDay =
          demandMode === "weekly"
            ? Math.round((sevenDayBatches / 7) * 100) / 100
            : singleDayBatches;
        const effectiveDailyUnits =
          demandMode === "weekly" ? sevenDayTargetUnits / 7 : sumDailyUnits;
        const producedUnits =
          demandMode === "weekly"
            ? (sevenDayBatches * batchYield) / 7
            : singleDayBatches * batchYield;
        recipeDemand.set(recipe.recipeId, {
          dailyTargetUnits: Math.round(effectiveDailyUnits),
          sevenDayTargetUnits,
          batchYield,
          batchesPerDay,
          sevenDayBatches,
          producedUnits,
          unsoldAndRejectedUnits: Math.max(
            0,
            producedUnits - effectiveDailyUnits,
          ),
        });
      } else {
        const effectiveDailyUnits =
          demandMode === "weekly" ? sevenDayTargetUnits / 7 : sumDailyUnits;
        const producedUnits =
          effectiveDailyUnits === 0
            ? 0
            : Math.round(effectiveDailyUnits * prepMultiplier * 100) / 100;
        recipeDemand.set(recipe.recipeId, {
          dailyTargetUnits: Math.round(effectiveDailyUnits),
          sevenDayTargetUnits,
          batchYield: 1,
          batchesPerDay: effectiveDailyUnits,
          sevenDayBatches: sevenDayTargetUnits,
          producedUnits,
          unsoldAndRejectedUnits: Math.max(
            0,
            producedUnits - effectiveDailyUnits,
          ),
        });
      }
    } else {
      const dailyTargetUnits = clampInteger(
        explicitRecipeTarget ??
          (recipe.output.kind === "stocked" ? Math.round(batchYield) : 12),
        0,
        100_000,
      );
      const sevenDayTargetUnits = dailyTargetUnits * 7;
      if (recipe.output.kind === "stocked") {
        const requiredRaw =
          dailyTargetUnits === 0
            ? 0
            : dailyTargetUnits / defaultShelfFactor / rejectFactor;
        const batchesPerDay =
          dailyTargetUnits === 0
            ? 0
            : Math.max(1, Math.ceil(requiredRaw / batchYield));
        const producedUnits = batchesPerDay * batchYield;
        recipeDemand.set(recipe.recipeId, {
          dailyTargetUnits,
          sevenDayTargetUnits,
          batchYield,
          batchesPerDay,
          sevenDayBatches: batchesPerDay * 7,
          producedUnits,
          unsoldAndRejectedUnits: Math.max(
            0,
            producedUnits - dailyTargetUnits,
          ),
        });
      } else {
        const producedUnits =
          dailyTargetUnits === 0
            ? 0
            : Math.round(dailyTargetUnits * prepMultiplier * 100) / 100;
        recipeDemand.set(recipe.recipeId, {
          dailyTargetUnits,
          sevenDayTargetUnits,
          batchYield: 1,
          batchesPerDay: dailyTargetUnits,
          sevenDayBatches: sevenDayTargetUnits,
          producedUnits,
          unsoldAndRejectedUnits: Math.max(
            0,
            producedUnits - dailyTargetUnits,
          ),
        });
      }
    }
  }

  // Accumulate 7-day usage in each supply item's baseUnit across all recipes & products.
  const sevenDayUsageByItem = new Map<string, number>();
  const addSevenDayUsage = (
    inventoryItemId: string,
    amountSevenDay: number,
    unit: CostUnit,
  ): void => {
    if (amountSevenDay <= 0) {
      return;
    }
    const item = itemsById.get(inventoryItemId);
    if (item === undefined) {
      return;
    }
    const converted = convertCostQuantity(amountSevenDay, unit, item.baseUnit);
    if (converted === null) {
      return;
    }
    sevenDayUsageByItem.set(
      inventoryItemId,
      (sevenDayUsageByItem.get(inventoryItemId) ?? 0) + converted,
    );
  };

  for (const recipe of activeRecipes) {
    const demand = recipeDemand.get(recipe.recipeId);
    if (demand === undefined) {
      continue;
    }
    const activeSevenDayUnits =
      demandMode === "weekly"
        ? demand.sevenDayTargetUnits
        : demand.dailyTargetUnits * 7;
    const activeSevenDayBatches =
      demandMode === "weekly"
        ? demand.sevenDayBatches
        : demand.batchesPerDay * 7;
    if (activeSevenDayUnits <= 0 && activeSevenDayBatches <= 0) {
      continue;
    }
    for (const line of recipe.inputs) {
      const item = itemsById.get(line.inventoryItemId);
      const qtyPerBatch = scaledQuantityAmount(line.quantity);
      if (recipe.output.kind === "stocked") {
        const sevenDayMultiplier =
          item?.category === "packaging"
            ? activeSevenDayUnits / demand.batchYield
            : activeSevenDayBatches;
        addSevenDayUsage(
          line.inventoryItemId,
          qtyPerBatch * sevenDayMultiplier,
          line.quantity.unit,
        );
      } else {
        addSevenDayUsage(
          line.inventoryItemId,
          qtyPerBatch * activeSevenDayUnits * prepMultiplier,
          line.quantity.unit,
        );
      }
    }
  }

  for (const product of input.overview.products) {
    const week = productWeeks.get(product.variantId) ?? [0, 0, 0, 0, 0, 0, 0];
    const sevenDayUnits =
      demandMode === "weekly"
        ? week[0] +
          week[1] +
          week[2] +
          week[3] +
          week[4] +
          week[5] +
          week[6]
        : (productTargets.get(product.variantId) ?? 0) * 7;
    if (sevenDayUnits <= 0) {
      continue;
    }
    for (const pack of product.directPackagingInputs) {
      addSevenDayUsage(
        pack.inventoryItemId,
        scaledQuantityAmount(pack.quantity) * sevenDayUnits,
        pack.quantity.unit,
      );
    }
  }

  const lotsByItemId = new Map<string, SupplyLotCost[]>();
  for (const lot of input.overview.lots ?? []) {
    const bucket = lotsByItemId.get(lot.inventoryItemId) ?? [];
    bucket.push(lot);
    lotsByItemId.set(lot.inventoryItemId, bucket);
  }

  const supplies: CalculatedSupplyUsage[] = [];
  const supplyRates = new Map<string, CalculatedSupplyUsage>();
  let dailyTierSavingsMinor = 0;
  let unlockedBulkTierCount = 0;
  let missingSupplyCostCount = 0;

  for (const item of input.overview.items) {
    if (item.category === "finished_good") {
      continue;
    }
    const sevenDayBaseUsage = sevenDayUsageByItem.get(item.id) ?? 0;
    const dailyBaseUsage = sevenDayBaseUsage / 7;
    const terms = item.costTerms;
    let packInBase: number | null = null;
    let sevenDayPackUnitUsage: number | null = null;
    let standardCostPerBaseUnitMinor: number | null = null;
    let standingOrBulkRateMinor: number | null = null;
    let bulkUnlocked = false;
    let itemSavingsMinor = 0;

    if (terms !== null) {
      packInBase = convertCostQuantity(
        terms.packQuantity,
        terms.packUnit,
        item.baseUnit,
      );
      sevenDayPackUnitUsage = convertCostQuantity(
        sevenDayBaseUsage,
        item.baseUnit,
        terms.packUnit,
      );
      if (packInBase !== null && packInBase > 0) {
        standardCostPerBaseUnitMinor = terms.packPriceMinor / packInBase;
        standingOrBulkRateMinor = standardCostPerBaseUnitMinor;
        if (
          assumptions.applyBulkTiers &&
          terms.bulkTier !== null &&
          sevenDayPackUnitUsage !== null &&
          sevenDayPackUnitUsage >= terms.bulkTier.min7dQuantity
        ) {
          const bulkPackInBase = convertCostQuantity(
            terms.bulkTier.packQuantity,
            terms.packUnit,
            item.baseUnit,
          );
          if (bulkPackInBase !== null && bulkPackInBase > 0) {
            const bulkRate = terms.bulkTier.packPriceMinor / bulkPackInBase;
            bulkUnlocked = true;
            standingOrBulkRateMinor = bulkRate;
            unlockedBulkTierCount += 1;
            itemSavingsMinor = Math.max(
              0,
              dailyBaseUsage * (standardCostPerBaseUnitMinor - bulkRate),
            );
            dailyTierSavingsMinor += itemSavingsMinor;
          }
        }
      }
    }

    const itemLots = lotsByItemId.get(item.id) ?? [];
    let activeLotCount = 0;
    let availableLotBaseQuantity = 0;
    const pricedLots: Array<
      Readonly<{
        lotId: string;
        occurredAtMs: number;
        remainingBase: number;
        unitCostMinorPerBaseUnit: number;
      }>
    > = [];

    for (const lot of itemLots) {
      if (lot.lifecycle !== "active" || lot.remainingQuantity <= 0) {
        continue;
      }
      const remInBase = convertCostQuantity(
        lot.remainingQuantity,
        lot.baseUnit,
        item.baseUnit,
      );
      if (remInBase === null || remInBase <= 0) {
        continue;
      }
      activeLotCount += 1;
      availableLotBaseQuantity += remInBase;
      if (lot.invoiceCost !== null && lot.invoiceCost.invoicedQuantity > 0) {
        const invInBase = convertCostQuantity(
          lot.invoiceCost.invoicedQuantity,
          lot.invoiceCost.invoicedUnit,
          item.baseUnit,
        );
        if (invInBase !== null && invInBase > 0) {
          const parsedTime = Date.parse(lot.receivedAt);
          pricedLots.push({
            lotId: lot.id,
            occurredAtMs: Number.isFinite(parsedTime) ? parsedTime : 0,
            remainingBase: remInBase,
            unitCostMinorPerBaseUnit:
              lot.invoiceCost.invoiceTotalMinor / invInBase,
          });
        }
      }
    }

    pricedLots.sort(
      (left, right) =>
        left.occurredAtMs - right.occurredAtMs ||
        left.lotId.localeCompare(right.lotId),
    );
    const pricedLotCount = pricedLots.length;
    let fifoLotCostPerBaseUnitMinor: number | null = null;
    let weightedLotCostPerBaseUnitMinor: number | null = null;

    if (pricedLotCount > 0) {
      let totalPricedRem = 0;
      let totalPricedValMinor = 0;
      for (const lot of pricedLots) {
        totalPricedRem += lot.remainingBase;
        totalPricedValMinor +=
          lot.remainingBase * lot.unitCostMinorPerBaseUnit;
      }
      if (totalPricedRem > 0) {
        weightedLotCostPerBaseUnitMinor = totalPricedValMinor / totalPricedRem;
      }

      if (sevenDayBaseUsage <= 0) {
        fifoLotCostPerBaseUnitMinor =
          pricedLots[0]!.unitCostMinorPerBaseUnit;
      } else {
        let needed = sevenDayBaseUsage;
        let coveredQty = 0;
        let coveredCostMinor = 0;
        for (const lot of pricedLots) {
          if (needed <= 0) break;
          const take = Math.min(needed, lot.remainingBase);
          coveredQty += take;
          coveredCostMinor += take * lot.unitCostMinorPerBaseUnit;
          needed -= take;
        }
        if (needed > 0 && standingOrBulkRateMinor !== null) {
          fifoLotCostPerBaseUnitMinor =
            (coveredCostMinor + needed * standingOrBulkRateMinor) /
            sevenDayBaseUsage;
        } else if (coveredQty > 0) {
          fifoLotCostPerBaseUnitMinor = coveredCostMinor / coveredQty;
        }
      }
    }

    const equivPackScale =
      packInBase !== null && packInBase > 0 ? packInBase : 1;
    const fifoEquivalentPackPriceMinor =
      fifoLotCostPerBaseUnitMinor !== null
        ? Math.round(fifoLotCostPerBaseUnitMinor * equivPackScale)
        : null;
    const weightedEquivalentPackPriceMinor =
      weightedLotCostPerBaseUnitMinor !== null
        ? Math.round(weightedLotCostPerBaseUnitMinor * equivPackScale)
        : null;

    const comparisonLotRate =
      assumptions.lotCostBasis === "weighted_lot"
        ? (weightedLotCostPerBaseUnitMinor ?? fifoLotCostPerBaseUnitMinor)
        : (fifoLotCostPerBaseUnitMinor ?? weightedLotCostPerBaseUnitMinor);
    const lotCostVariancePct =
      comparisonLotRate !== null &&
      standardCostPerBaseUnitMinor !== null &&
      standardCostPerBaseUnitMinor > 0
        ? ((comparisonLotRate - standardCostPerBaseUnitMinor) /
            standardCostPerBaseUnitMinor) *
          100
        : null;

    let effectiveCostPerBaseUnitMinor: number | null = null;
    let costSource: SupplyCostSourceKind = "unpriced";

    if (
      assumptions.lotCostBasis === "fifo_lot" &&
      fifoLotCostPerBaseUnitMinor !== null
    ) {
      effectiveCostPerBaseUnitMinor = fifoLotCostPerBaseUnitMinor;
      costSource = "fifo_lot";
    } else if (
      assumptions.lotCostBasis === "weighted_lot" &&
      weightedLotCostPerBaseUnitMinor !== null
    ) {
      effectiveCostPerBaseUnitMinor = weightedLotCostPerBaseUnitMinor;
      costSource = "weighted_lot";
    } else if (standingOrBulkRateMinor !== null) {
      effectiveCostPerBaseUnitMinor = standingOrBulkRateMinor;
      costSource = bulkUnlocked ? "bulk_tier" : "standing_pack";
    }

    const dailySpendMinor =
      effectiveCostPerBaseUnitMinor !== null
        ? dailyBaseUsage * effectiveCostPerBaseUnitMinor
        : 0;
    if (effectiveCostPerBaseUnitMinor === null && item.lifecycle === "active") {
      missingSupplyCostCount += 1;
    }

    const onHandBaseQuantity: number | null =
      item.onHandQuantity !== undefined && item.onHandQuantity !== null
        ? Math.max(0, item.onHandQuantity)
        : itemLots.length > 0
          ? availableLotBaseQuantity
          : null;
    const daysOfSupply: number | null =
      onHandBaseQuantity !== null && dailyBaseUsage > 0
        ? onHandBaseQuantity / dailyBaseUsage
        : null;
    const reorderSuggested = daysOfSupply !== null && daysOfSupply < 4;
    const weeklyLotVarianceImpactMinor =
      comparisonLotRate !== null &&
      standardCostPerBaseUnitMinor !== null &&
      sevenDayBaseUsage > 0
        ? -((comparisonLotRate - standardCostPerBaseUnitMinor) * sevenDayBaseUsage)
        : null;
    const tenPctHikeWeeklyImpactMinor = -dailySpendMinor * 7 * 0.1;

    const calculated: CalculatedSupplyUsage = {
      inventoryItemId: item.id,
      merchantCode: item.merchantCode,
      name: item.name,
      category: item.category,
      baseUnit: item.baseUnit,
      costTerms: terms,
      dailyBaseUsage,
      sevenDayBaseUsage,
      sevenDayPackUnitUsage,
      standardCostPerBaseUnitMinor,
      effectiveCostPerBaseUnitMinor,
      bulkUnlocked,
      activeLotCount,
      pricedLotCount,
      availableLotBaseQuantity,
      onHandBaseQuantity,
      daysOfSupply,
      reorderSuggested,
      fifoLotCostPerBaseUnitMinor,
      weightedLotCostPerBaseUnitMinor,
      fifoEquivalentPackPriceMinor,
      weightedEquivalentPackPriceMinor,
      lotCostVariancePct,
      costSource,
      dailySpendMinor,
      dailyTierSavingsMinor: itemSavingsMinor,
      usedInProductCount: 0,
      weeklyLotVarianceImpactMinor,
      tenPctHikeWeeklyImpactMinor,
      skuImpacts: [],
    };
    supplies.push(calculated);
    supplyRates.set(item.id, calculated);
  }

  const recipes: CalculatedRecipeCost[] = [];
  const recipeCostsById = new Map<string, CalculatedRecipeCost>();

  for (const recipe of activeRecipes) {
    const demand = recipeDemand.get(recipe.recipeId) ?? {
      dailyTargetUnits: 0,
      sevenDayTargetUnits: 0,
      batchYield: 1,
      batchesPerDay: 0,
      sevenDayBatches: 0,
      producedUnits: 0,
      unsoldAndRejectedUnits: 0,
    };
    let ingredientBatchCostMinor = 0;
    let packagingBatchCostMinor = 0;
    const missingCostItemIds: string[] = [];
    const lines: CalculatedRecipeInputLine[] = [];

    for (const line of recipe.inputs) {
      const item = itemsById.get(line.inventoryItemId);
      const supplyRate = supplyRates.get(line.inventoryItemId);
      const qtyPerBatch = scaledQuantityAmount(line.quantity);
      const qtyInBase =
        item === undefined
          ? null
          : convertCostQuantity(qtyPerBatch, line.quantity.unit, item.baseUnit);
      const hasCostTerms =
        supplyRate?.effectiveCostPerBaseUnitMinor !== null &&
        supplyRate?.effectiveCostPerBaseUnitMinor !== undefined &&
        qtyInBase !== null;
      const costPerBatchMinor =
        hasCostTerms && supplyRate?.effectiveCostPerBaseUnitMinor != null
          ? qtyInBase * supplyRate.effectiveCostPerBaseUnitMinor
          : 0;
      if (!hasCostTerms) {
        missingCostItemIds.push(line.inventoryItemId);
      }
      const category = item?.category ?? "ingredient";
      if (category === "packaging") {
        packagingBatchCostMinor += costPerBatchMinor;
      } else {
        ingredientBatchCostMinor += costPerBatchMinor;
      }
      lines.push({
        inventoryItemId: line.inventoryItemId,
        name: item?.name ?? line.inventoryItemId,
        category,
        quantityPerBatch: qtyPerBatch,
        unit: line.quantity.unit,
        costPerBatchMinor,
        bulkUnlocked: supplyRate?.bulkUnlocked ?? false,
        hasCostTerms,
        costSource: supplyRate?.costSource ?? "unpriced",
      });
    }

    const totalBatchCostMinor =
      ingredientBatchCostMinor + packagingBatchCostMinor;
    const calculatedRecipe: CalculatedRecipeCost = {
      recipeId: recipe.recipeId,
      recipeRevision: recipe.revision,
      name: recipe.name,
      outputKind: recipe.output.kind,
      batchYield: demand.batchYield,
      outputUnit:
        recipe.output.kind === "stocked"
          ? recipe.output.yieldQuantity.unit
          : "each",
      dailyTargetUnits: demand.dailyTargetUnits,
      batchesPerDay: demand.batchesPerDay,
      producedUnits: demand.producedUnits,
      unsoldAndRejectedUnits: demand.unsoldAndRejectedUnits,
      ingredientBatchCostMinor,
      packagingBatchCostMinor,
      totalBatchCostMinor,
      rawUnitCostMinor: totalBatchCostMinor / demand.batchYield,
      missingCostItemIds,
      lines,
    };
    recipes.push(calculatedRecipe);
    recipeCostsById.set(recipe.recipeId, calculatedRecipe);
  }

  const products: CalculatedProductMargin[] = [];
  const skuImpactsByItemId = new Map<
    string,
    Array<Readonly<{ impact: CalculatedSupplySkuImpact; weight: number }>>
  >();
  let dailyUnitsSold = 0;
  let dailyGrossRevenueMinor = 0;
  let dailyIncludedTaxMinor = 0;
  let dailyNetExTaxRevenueMinor = 0;
  let dailyIngredientSpendMinor = 0;
  let dailyPackagingSpendMinor = 0;
  let dailyWasteSpendMinor = 0;
  let dailyChannelFeeMinor = 0;
  let dailyNetContributionMinor = 0;

  for (let productIdx = 0; productIdx < input.overview.products.length; productIdx += 1) {
    const product = input.overview.products[productIdx]!;
    const savedEntry = savedProductPlans.get(product.productId);
    const mergedFormulas: Record<string, string> = {};
    if (savedEntry?.formulas !== undefined) {
      for (const [colKey, expr] of Object.entries(savedEntry.formulas)) {
        if (isCostFormulaColumn(colKey) && isValidCostFormulaString(expr)) {
          mergedFormulas[colKey] = expr;
        }
      }
    }
    const inputFormulaMap =
      input.productFormulas?.[product.productId] ??
      input.productFormulas?.[product.variantId];
    if (inputFormulaMap !== undefined) {
      for (const [colKey, expr] of Object.entries(inputFormulaMap)) {
        if (!isCostFormulaColumn(colKey)) continue;
        if (expr.length === 0) {
          delete mergedFormulas[colKey];
        } else if (isValidCostFormulaString(expr)) {
          mergedFormulas[colKey] = expr;
        }
      }
    }

    const weekUnits =
      productWeeks.get(product.variantId) ?? [0, 0, 0, 0, 0, 0, 0];
    const sevenDayUnits =
      weekUnits[0] +
      weekUnits[1] +
      weekUnits[2] +
      weekUnits[3] +
      weekUnits[4] +
      weekUnits[5] +
      weekUnits[6];
    const singleDayTargetUnits = productTargets.get(product.variantId) ?? 0;
    let effectiveDailyUnits =
      demandMode === "weekly" ? sevenDayUnits / 7 : singleDayTargetUnits;
    let dailyTargetUnits =
      demandMode === "weekly"
        ? Math.round(sevenDayUnits / 7)
        : singleDayTargetUnits;

    let effectiveSpoilagePct =
      productSpoilagePct.get(product.variantId) ?? 0;
    let productShelfFactor = Math.max(0.05, 1 - effectiveSpoilagePct / 100);

    let grossPriceMinor = clampInteger(
      input.priceOverridesMinor?.[product.variantId] ??
        input.priceOverridesMinor?.[product.productId] ??
        input.priceOverridesMinor?.[product.offerId] ??
        product.priceMinor,
      0,
      100_000_000,
    );

    const recipe =
      product.recipeId === null
        ? undefined
        : recipeCostsById.get(product.recipeId);
    const missingCostSet = new Set<string>(recipe?.missingCostItemIds ?? []);

    let directPackagingUnitCostMinor = 0;
    for (const pack of product.directPackagingInputs) {
      const item = itemsById.get(pack.inventoryItemId);
      const supplyRate = supplyRates.get(pack.inventoryItemId);
      const qty = scaledQuantityAmount(pack.quantity);
      const qtyInBase =
        item === undefined
          ? null
          : convertCostQuantity(qty, pack.quantity.unit, item.baseUnit);
      if (
        qtyInBase !== null &&
        supplyRate?.effectiveCostPerBaseUnitMinor != null
      ) {
        directPackagingUnitCostMinor +=
          qtyInBase * supplyRate.effectiveCostPerBaseUnitMinor;
      } else {
        missingCostSet.add(pack.inventoryItemId);
      }
    }

    const ingredientUnitCostMinor =
      recipe === undefined
        ? 0
        : recipe.ingredientBatchCostMinor / recipe.batchYield;
    const packagingUnitCostMinor =
      (recipe === undefined
        ? 0
        : recipe.packagingBatchCostMinor / recipe.batchYield) +
      directPackagingUnitCostMinor;
    const bomUnitCostMinor = ingredientUnitCostMinor + packagingUnitCostMinor;

    const digits = currencyMinorDigits(product.currency);
    const minorScale = 10 ** digits;
    const taxRateFraction =
      assumptions.includedTaxBps > 0
        ? assumptions.includedTaxBps / (10_000 + assumptions.includedTaxBps)
        : 0;
    const feeRateFraction = assumptions.channelFeeBps / 10_000;

    const buildFormulaCtx = (state: Readonly<{
      units: number;
      spoilPct: number;
      priceMinor: number;
      cogsMinor: number;
      wasteMinor: number;
      taxMinor: number;
      feeMinor: number;
      unitNetMinor: number;
      marginPct: number;
      netDayMinor: number;
      batchesPerDay: number;
    }>) => ({
      rowNumber: productIdx + 1,
      fulfillmentKind: product.fulfillmentKind,
      units: state.units,
      spoilPct: state.spoilPct,
      rejectPct: assumptions.prepRejectPct,
      priceMajor: state.priceMinor / minorScale,
      bomMajor: bomUnitCostMinor / minorScale,
      ingrMajor: ingredientUnitCostMinor / minorScale,
      packMajor: packagingUnitCostMinor / minorScale,
      cogsMajor: state.cogsMinor / minorScale,
      wasteMajor: state.wasteMinor / minorScale,
      taxMajor: state.taxMinor / minorScale,
      feeMajor: state.feeMinor / minorScale,
      taxFeeMajor: (state.taxMinor + state.feeMinor) / minorScale,
      taxPct: assumptions.includedTaxBps / 100,
      feePct: assumptions.channelFeeBps / 100,
      taxRate: taxRateFraction,
      feeRate: feeRateFraction,
      unitNetMajor: state.unitNetMinor / minorScale,
      marginPct: state.marginPct,
      netDayMajor: state.netDayMinor / minorScale,
      batchYield: recipe?.batchYield ?? 1,
      batchesPerDay: state.batchesPerDay,
    });

    if (mergedFormulas.units !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.units,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: bomUnitCostMinor,
          wasteMinor: 0,
          taxMinor: 0,
          feeMinor: 0,
          unitNetMinor: grossPriceMinor - bomUnitCostMinor,
          marginPct: 0,
          netDayMinor: 0,
          batchesPerDay: 1,
        }),
      );
      if (evaluated.ok) {
        dailyTargetUnits = clampInteger(evaluated.value, 0, 100_000);
        effectiveDailyUnits = dailyTargetUnits;
      }
    }

    if (mergedFormulas.spoil !== undefined && product.fulfillmentKind === "stocked") {
      const evaluated = evaluateCostFormula(
        mergedFormulas.spoil,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: bomUnitCostMinor,
          wasteMinor: 0,
          taxMinor: 0,
          feeMinor: 0,
          unitNetMinor: grossPriceMinor - bomUnitCostMinor,
          marginPct: 0,
          netDayMinor: 0,
          batchesPerDay: 1,
        }),
      );
      if (evaluated.ok) {
        effectiveSpoilagePct = clampNumber(evaluated.value, 0, 95);
        productShelfFactor = Math.max(0.05, 1 - effectiveSpoilagePct / 100);
      }
    }

    let formulaWasteUnitMinor = 0;
    let batchesPerDay = 0;
    let sevenDayBatches = 0;
    let producedUnits = 0;
    let unsoldAndRejectedUnits = 0;

    if (recipe !== undefined) {
      if (recipe.outputKind === "stocked") {
        for (let d = 0; d < 7; d += 1) {
          const dayU = weekUnits[d] ?? 0;
          if (dayU > 0) {
            const rawDay = dayU / productShelfFactor / rejectFactor;
            sevenDayBatches += Math.max(1, Math.ceil(rawDay / recipe.batchYield));
          }
        }
        if (demandMode === "weekly" && mergedFormulas.units === undefined) {
          batchesPerDay = Math.round((sevenDayBatches / 7) * 100) / 100;
          producedUnits = (sevenDayBatches * recipe.batchYield) / 7;
          unsoldAndRejectedUnits = Math.max(
            0,
            producedUnits - effectiveDailyUnits,
          );
          if (sevenDayUnits > 0) {
            const totalSevenDayIngredientCost =
              sevenDayBatches * recipe.ingredientBatchCostMinor;
            formulaWasteUnitMinor = Math.max(
              0,
              totalSevenDayIngredientCost / sevenDayUnits -
                ingredientUnitCostMinor,
            );
          } else {
            formulaWasteUnitMinor =
              ingredientUnitCostMinor *
              (1 / (productShelfFactor * rejectFactor) - 1);
          }
        } else if (dailyTargetUnits > 0) {
          const requiredRaw =
            dailyTargetUnits / productShelfFactor / rejectFactor;
          batchesPerDay = Math.max(
            1,
            Math.ceil(requiredRaw / recipe.batchYield),
          );
          producedUnits = batchesPerDay * recipe.batchYield;
          unsoldAndRejectedUnits = Math.max(
            0,
            producedUnits - dailyTargetUnits,
          );
          const totalBatchIngredientCost =
            batchesPerDay * recipe.ingredientBatchCostMinor;
          formulaWasteUnitMinor = Math.max(
            0,
            totalBatchIngredientCost / dailyTargetUnits -
              ingredientUnitCostMinor,
          );
        } else {
          formulaWasteUnitMinor =
            ingredientUnitCostMinor *
            (1 / (productShelfFactor * rejectFactor) - 1);
        }
      } else {
        sevenDayBatches = sevenDayUnits;
        batchesPerDay = effectiveDailyUnits;
        producedUnits =
          effectiveDailyUnits === 0
            ? 0
            : Math.round(effectiveDailyUnits * prepMultiplier * 100) / 100;
        unsoldAndRejectedUnits = Math.max(
          0,
          producedUnits - effectiveDailyUnits,
        );
        formulaWasteUnitMinor =
          (ingredientUnitCostMinor + packagingUnitCostMinor) *
          (prepMultiplier - 1);
      }
    } else {
      sevenDayBatches = sevenDayUnits;
    }

    const explicitCogsOverride =
      input.cogsOverridesMinor !== undefined &&
      product.productId in input.cogsOverridesMinor
        ? input.cogsOverridesMinor[product.productId] ?? null
        : savedEntry?.cogsOverrideMinor ?? null;

    let effectiveCogsUnitMinor =
      explicitCogsOverride !== null
        ? clampInteger(explicitCogsOverride, 0, 100_000_000)
        : bomUnitCostMinor;
    let hasCogsOverride = explicitCogsOverride !== null;

    if (mergedFormulas.cogs !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.cogs,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: effectiveCogsUnitMinor,
          wasteMinor: formulaWasteUnitMinor,
          taxMinor: 0,
          feeMinor: 0,
          unitNetMinor: 0,
          marginPct: 0,
          netDayMinor: 0,
          batchesPerDay,
        }),
      );
      if (evaluated.ok) {
        effectiveCogsUnitMinor = clampInteger(
          evaluated.value * minorScale,
          0,
          100_000_000,
        );
        hasCogsOverride = true;
      }
    }

    const explicitWasteOverride =
      input.wasteOverridesMinor !== undefined &&
      product.productId in input.wasteOverridesMinor
        ? input.wasteOverridesMinor[product.productId] ?? null
        : savedEntry?.wasteOverrideMinor ?? null;

    let wasteAndSurplusUnitMinor =
      explicitWasteOverride !== null
        ? clampInteger(explicitWasteOverride, 0, 100_000_000)
        : formulaWasteUnitMinor;
    let hasWasteOverride = explicitWasteOverride !== null;

    if (mergedFormulas.waste !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.waste,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: effectiveCogsUnitMinor,
          wasteMinor: wasteAndSurplusUnitMinor,
          taxMinor: 0,
          feeMinor: 0,
          unitNetMinor: 0,
          marginPct: 0,
          netDayMinor: 0,
          batchesPerDay,
        }),
      );
      if (evaluated.ok) {
        wasteAndSurplusUnitMinor = clampInteger(
          evaluated.value * minorScale,
          0,
          100_000_000,
        );
        hasWasteOverride = true;
      }
    }

    if (mergedFormulas.price !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.price,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: effectiveCogsUnitMinor,
          wasteMinor: wasteAndSurplusUnitMinor,
          taxMinor: 0,
          feeMinor: 0,
          unitNetMinor: 0,
          marginPct: 0,
          netDayMinor: 0,
          batchesPerDay,
        }),
      );
      if (evaluated.ok) {
        grossPriceMinor = clampInteger(
          evaluated.value * minorScale,
          0,
          100_000_000,
        );
      }
    }

    const includedTaxMinor =
      assumptions.includedTaxBps > 0
        ? Math.round(
            (grossPriceMinor * assumptions.includedTaxBps) /
              (10_000 + assumptions.includedTaxBps),
          )
        : 0;
    const netExTaxPriceMinor = grossPriceMinor - includedTaxMinor;
    const channelFeeMinor =
      (grossPriceMinor * assumptions.channelFeeBps) / 10_000;

    const allInUnitCostMinor =
      effectiveCogsUnitMinor +
      wasteAndSurplusUnitMinor +
      includedTaxMinor +
      channelFeeMinor;
    let netContributionUnitMinor = grossPriceMinor - allInUnitCostMinor;

    if (mergedFormulas.unitNet !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.unitNet,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: effectiveCogsUnitMinor,
          wasteMinor: wasteAndSurplusUnitMinor,
          taxMinor: includedTaxMinor,
          feeMinor: channelFeeMinor,
          unitNetMinor: netContributionUnitMinor,
          marginPct:
            grossPriceMinor > 0
              ? (netContributionUnitMinor / grossPriceMinor) * 100
              : 0,
          netDayMinor: netContributionUnitMinor * effectiveDailyUnits,
          batchesPerDay,
        }),
      );
      if (evaluated.ok) {
        netContributionUnitMinor = Math.round(evaluated.value * minorScale);
      }
    }

    let netMarginPct =
      grossPriceMinor > 0
        ? (netContributionUnitMinor / grossPriceMinor) * 100
        : 0;

    if (mergedFormulas.margin !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.margin,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: effectiveCogsUnitMinor,
          wasteMinor: wasteAndSurplusUnitMinor,
          taxMinor: includedTaxMinor,
          feeMinor: channelFeeMinor,
          unitNetMinor: netContributionUnitMinor,
          marginPct: netMarginPct,
          netDayMinor: netContributionUnitMinor * effectiveDailyUnits,
          batchesPerDay,
        }),
      );
      if (evaluated.ok) {
        netMarginPct = clampNumber(evaluated.value, -500, 100);
      }
    }

    const itemDailyGross = grossPriceMinor * effectiveDailyUnits;
    const itemDailyTax = includedTaxMinor * effectiveDailyUnits;
    const itemDailyExTax = netExTaxPriceMinor * effectiveDailyUnits;
    const cogsScaleRatio =
      bomUnitCostMinor > 0 ? effectiveCogsUnitMinor / bomUnitCostMinor : 1;
    const itemDailyIngredient =
      (bomUnitCostMinor > 0
        ? ingredientUnitCostMinor * cogsScaleRatio
        : effectiveCogsUnitMinor) * effectiveDailyUnits;
    const itemDailyPackaging =
      (bomUnitCostMinor > 0 ? packagingUnitCostMinor * cogsScaleRatio : 0) *
      effectiveDailyUnits;
    const itemDailyWaste = wasteAndSurplusUnitMinor * effectiveDailyUnits;
    const itemDailyFee = channelFeeMinor * effectiveDailyUnits;
    const itemDailyAllIn = allInUnitCostMinor * effectiveDailyUnits;
    let itemDailyNet = netContributionUnitMinor * effectiveDailyUnits;

    if (mergedFormulas.netDay !== undefined) {
      const evaluated = evaluateCostFormula(
        mergedFormulas.netDay,
        buildFormulaCtx({
          units: dailyTargetUnits,
          spoilPct: effectiveSpoilagePct,
          priceMinor: grossPriceMinor,
          cogsMinor: effectiveCogsUnitMinor,
          wasteMinor: wasteAndSurplusUnitMinor,
          taxMinor: includedTaxMinor,
          feeMinor: channelFeeMinor,
          unitNetMinor: netContributionUnitMinor,
          marginPct: netMarginPct,
          netDayMinor: itemDailyNet,
          batchesPerDay,
        }),
      );
      if (evaluated.ok) {
        itemDailyNet = Math.round(evaluated.value * minorScale);
      }
    }

    const sevenDayGrossRevenueMinor = grossPriceMinor * sevenDayUnits;
    const sevenDayNetContributionMinor =
      netContributionUnitMinor * sevenDayUnits;

    dailyUnitsSold += effectiveDailyUnits;
    dailyGrossRevenueMinor += itemDailyGross;
    dailyIncludedTaxMinor += itemDailyTax;
    dailyNetExTaxRevenueMinor += itemDailyExTax;
    dailyIngredientSpendMinor += itemDailyIngredient;
    dailyPackagingSpendMinor += itemDailyPackaging;
    dailyWasteSpendMinor += itemDailyWaste;
    dailyChannelFeeMinor += itemDailyFee;
    dailyNetContributionMinor += itemDailyNet;

    const batchYieldForBom = recipe?.batchYield ?? 1;
    const rawBomLines: Array<
      Omit<CalculatedProductBomLine, "shareOfBomPct">
    > = [];
    if (recipe !== undefined) {
      for (const rLine of recipe.lines) {
        const item = itemsById.get(rLine.inventoryItemId);
        const sRate = supplyRates.get(rLine.inventoryItemId);
        const packInfo = resolveSupplyActivePack(item, sRate);
        const costPerUnitMinor = rLine.costPerBatchMinor / batchYieldForBom;
        rawBomLines.push({
          inventoryItemId: rLine.inventoryItemId,
          merchantCode: item?.merchantCode ?? "",
          name: rLine.name,
          category: rLine.category,
          source: "recipe",
          quantityPerBatch: rLine.quantityPerBatch,
          quantityPerUnit: rLine.quantityPerBatch / batchYieldForBom,
          unit: rLine.unit,
          baseUnit: item?.baseUnit ?? rLine.unit,
          activePackQuantity: packInfo.activePackQuantity,
          activePackUnit: packInfo.activePackUnit,
          activePackPriceMinor: packInfo.activePackPriceMinor,
          effectiveRatePerBaseUnitMinor:
            sRate?.effectiveCostPerBaseUnitMinor ?? null,
          costPerBatchMinor: rLine.costPerBatchMinor,
          costPerUnitMinor,
          bulkUnlocked: rLine.bulkUnlocked,
          hasCostTerms: rLine.hasCostTerms,
          costSource: rLine.costSource,
          lotCostVariancePct: sRate?.lotCostVariancePct ?? null,
          reorderSuggested: sRate?.reorderSuggested ?? false,
        });
      }
    }
    for (const pack of product.directPackagingInputs) {
      const item = itemsById.get(pack.inventoryItemId);
      const sRate = supplyRates.get(pack.inventoryItemId);
      const packInfo = resolveSupplyActivePack(item, sRate);
      const qtyPerUnit = scaledQuantityAmount(pack.quantity);
      const qtyInBase =
        item === undefined
          ? null
          : convertCostQuantity(qtyPerUnit, pack.quantity.unit, item.baseUnit);
      const hasCostTerms =
        qtyInBase !== null && sRate?.effectiveCostPerBaseUnitMinor != null;
      const costPerUnitMinor =
        hasCostTerms && sRate?.effectiveCostPerBaseUnitMinor != null
          ? qtyInBase * sRate.effectiveCostPerBaseUnitMinor
          : 0;
      rawBomLines.push({
        inventoryItemId: pack.inventoryItemId,
        merchantCode: item?.merchantCode ?? "",
        name: item?.name ?? pack.inventoryItemId,
        category: item?.category ?? "packaging",
        source: "direct_packaging",
        quantityPerBatch: qtyPerUnit * batchYieldForBom,
        quantityPerUnit: qtyPerUnit,
        unit: pack.quantity.unit,
        baseUnit: item?.baseUnit ?? pack.quantity.unit,
        activePackQuantity: packInfo.activePackQuantity,
        activePackUnit: packInfo.activePackUnit,
        activePackPriceMinor: packInfo.activePackPriceMinor,
        effectiveRatePerBaseUnitMinor:
          sRate?.effectiveCostPerBaseUnitMinor ?? null,
        costPerBatchMinor: costPerUnitMinor * batchYieldForBom,
        costPerUnitMinor,
        bulkUnlocked: sRate?.bulkUnlocked ?? false,
        hasCostTerms,
        costSource: sRate?.costSource ?? "unpriced",
        lotCostVariancePct: sRate?.lotCostVariancePct ?? null,
        reorderSuggested: sRate?.reorderSuggested ?? false,
      });
    }

    const bomLines: CalculatedProductBomLine[] = rawBomLines.map((entry) => ({
      ...entry,
      shareOfBomPct:
        bomUnitCostMinor > 0
          ? (entry.costPerUnitMinor / bomUnitCostMinor) * 100
          : 0,
    }));

    const itemUsageInProduct = new Map<
      string,
      {
        displayQty: number;
        displayUnit: CostUnit;
        unitBomCostMinor: number;
        effectiveSoldBaseQty: number;
      }
    >();
    for (const bLine of bomLines) {
      const existing = itemUsageInProduct.get(bLine.inventoryItemId);
      const qtyInBase =
        convertCostQuantity(
          bLine.quantityPerUnit,
          bLine.unit,
          bLine.baseUnit,
        ) ?? 0;
      const wasteMult =
        product.fulfillmentKind === "stocked"
          ? bLine.category === "packaging"
            ? 1
            : 1 / (productShelfFactor * rejectFactor)
          : prepMultiplier;
      const soldBase = qtyInBase * wasteMult;
      if (existing === undefined) {
        itemUsageInProduct.set(bLine.inventoryItemId, {
          displayQty: bLine.quantityPerUnit,
          displayUnit: bLine.unit,
          unitBomCostMinor: bLine.costPerUnitMinor,
          effectiveSoldBaseQty: soldBase,
        });
      } else {
        const convDisplay =
          convertCostQuantity(
            bLine.quantityPerUnit,
            bLine.unit,
            existing.displayUnit,
          ) ?? 0;
        itemUsageInProduct.set(bLine.inventoryItemId, {
          displayQty: existing.displayQty + convDisplay,
          displayUnit: existing.displayUnit,
          unitBomCostMinor: existing.unitBomCostMinor + bLine.costPerUnitMinor,
          effectiveSoldBaseQty: existing.effectiveSoldBaseQty + soldBase,
        });
      }
    }

    for (const [itemId, agg] of itemUsageInProduct) {
      const sRate = supplyRates.get(itemId);
      const compLotRate =
        assumptions.lotCostBasis === "weighted_lot"
          ? (sRate?.weightedLotCostPerBaseUnitMinor ??
            sRate?.fifoLotCostPerBaseUnitMinor ??
            null)
          : (sRate?.fifoLotCostPerBaseUnitMinor ??
            sRate?.weightedLotCostPerBaseUnitMinor ??
            null);
      const lotUnitDeltaMinor =
        compLotRate !== null && sRate?.standardCostPerBaseUnitMinor != null
          ? agg.effectiveSoldBaseQty *
            (compLotRate - sRate.standardCostPerBaseUnitMinor)
          : null;
      const lotMarginDeltaPct =
        lotUnitDeltaMinor !== null && grossPriceMinor > 0
          ? (-lotUnitDeltaMinor / grossPriceMinor) * 100
          : null;
      const allInSupplyUnitMinor =
        sRate?.effectiveCostPerBaseUnitMinor != null
          ? agg.effectiveSoldBaseQty * sRate.effectiveCostPerBaseUnitMinor
          : agg.unitBomCostMinor;
      const tenPctHikeUnitDeltaMinor = allInSupplyUnitMinor * 0.1;
      const tenPctHikeMarginDeltaPct =
        grossPriceMinor > 0
          ? (-tenPctHikeUnitDeltaMinor / grossPriceMinor) * 100
          : 0;
      const impact: CalculatedSupplySkuImpact = {
        productId: product.productId,
        productTitle: product.productTitle,
        quantityPerUnit: agg.displayQty,
        unit: agg.displayUnit,
        unitCostMinor: agg.unitBomCostMinor,
        currentMarginPct: netMarginPct,
        lotUnitDeltaMinor,
        lotMarginDeltaPct,
        tenPctHikeUnitDeltaMinor,
        tenPctHikeMarginDeltaPct,
      };
      const list = skuImpactsByItemId.get(itemId) ?? [];
      list.push({
        impact,
        weight:
          Math.max(1, sevenDayUnits) * Math.max(0.01, allInSupplyUnitMinor),
      });
      skuImpactsByItemId.set(itemId, list);
    }

    products.push({
      productId: product.productId,
      productTitle: product.productTitle,
      productType: product.productType,
      imageUrl: product.imageUrl ?? null,
      variantId: product.variantId,
      variantTitle: product.variantTitle,
      offerId: product.offerId,
      offerRevision: product.offerRevision,
      currency: product.currency,
      fulfillmentKind: product.fulfillmentKind,
      recipeId: product.recipeId,
      recipeRevision: recipe?.recipeRevision ?? null,
      recipeName: recipe?.name ?? null,
      batchYield: recipe?.batchYield ?? 1,
      effectiveSpoilagePct,
      weekUnits,
      sevenDayUnits,
      sevenDayBatches,
      dailyTargetUnits,
      batchesPerDay,
      producedUnits,
      unsoldAndRejectedUnits,
      grossPriceMinor,
      includedTaxMinor,
      netExTaxPriceMinor,
      ingredientUnitCostMinor,
      packagingUnitCostMinor,
      bomUnitCostMinor,
      effectiveCogsUnitMinor,
      hasCogsOverride,
      formulaWasteUnitMinor,
      wasteAndSurplusUnitMinor,
      hasWasteOverride,
      activeFormulas: mergedFormulas,
      channelFeeMinor,
      allInUnitCostMinor,
      netContributionUnitMinor,
      netMarginPct,
      dailyGrossRevenueMinor: itemDailyGross,
      dailyNetExTaxRevenueMinor: itemDailyExTax,
      dailyAllInCostMinor: itemDailyAllIn,
      dailyNetContributionMinor: itemDailyNet,
      sevenDayGrossRevenueMinor,
      sevenDayNetContributionMinor,
      missingCostItemIds: [...missingCostSet],
      bomLines,
    });
  }

  const enrichedSupplies: CalculatedSupplyUsage[] = supplies.map((supply) => {
    const entries = skuImpactsByItemId.get(supply.inventoryItemId) ?? [];
    const sorted = [...entries]
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          left.impact.productTitle.localeCompare(right.impact.productTitle),
      )
      .map((entry) => entry.impact);
    return {
      ...supply,
      usedInProductCount: sorted.length,
      skuImpacts: sorted,
    };
  });

  const netMarginPct =
    dailyGrossRevenueMinor > 0
      ? (dailyNetContributionMinor / dailyGrossRevenueMinor) * 100
      : 0;
  const netMarginExTaxPct =
    dailyNetExTaxRevenueMinor > 0
      ? (dailyNetContributionMinor / dailyNetExTaxRevenueMinor) * 100
      : 0;

  const dailyLaborMinor = clampInteger(
    input.dailyLaborMinor ?? input.overview.costPlan?.dailyLaborMinor ?? 0,
    0,
    1_000_000_000,
  );
  const dailyRentMinor = clampInteger(
    input.dailyRentMinor ?? input.overview.costPlan?.dailyRentMinor ?? 0,
    0,
    1_000_000_000,
  );
  const dailyFixedCostMinor = dailyLaborMinor + dailyRentMinor;
  const dailyOperatingProfitMinor =
    dailyNetContributionMinor - dailyFixedCostMinor;
  const operatingMarginPct =
    dailyGrossRevenueMinor > 0
      ? (dailyOperatingProfitMinor / dailyGrossRevenueMinor) * 100
      : 0;
  const breakEvenUnitsPerDay =
    dailyFixedCostMinor === 0
      ? 0
      : dailyUnitsSold > 0 && dailyNetContributionMinor > 0
        ? Math.ceil(
            dailyFixedCostMinor / (dailyNetContributionMinor / dailyUnitsSold),
          )
        : null;

  return {
    assumptions,
    supplies: enrichedSupplies,
    recipes,
    products,
    summary: {
      currency: input.overview.currency,
      dailyUnitsSold: Math.round(dailyUnitsSold * 100) / 100,
      dailyGrossRevenueMinor,
      dailyIncludedTaxMinor,
      dailyNetExTaxRevenueMinor,
      dailyIngredientSpendMinor,
      dailyPackagingSpendMinor,
      dailyWasteSpendMinor,
      dailyChannelFeeMinor,
      dailyTierSavingsMinor,
      unlockedBulkTierCount,
      missingSupplyCostCount,
      dailyNetContributionMinor,
      netMarginPct,
      netMarginExTaxPct,
      dailyLaborMinor,
      dailyRentMinor,
      dailyFixedCostMinor,
      dailyOperatingProfitMinor,
      operatingMarginPct,
      breakEvenUnitsPerDay,
      monthlyGrossRevenueMinor:
        dailyGrossRevenueMinor * assumptions.operatingDaysPerMonth,
      monthlyNetContributionMinor:
        dailyNetContributionMinor * assumptions.operatingDaysPerMonth,
      monthlyFixedCostMinor:
        dailyFixedCostMinor * assumptions.operatingDaysPerMonth,
      monthlyOperatingProfitMinor:
        dailyOperatingProfitMinor * assumptions.operatingDaysPerMonth,
    },
  };
}

const ZERO_DECIMAL_CURRENCY_CODES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
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

function resolveSupplyActivePack(
  item: SupplyCostItem | undefined,
  supplyRate: CalculatedSupplyUsage | undefined,
): Readonly<{
  activePackQuantity: number | null;
  activePackUnit: CostUnit | null;
  activePackPriceMinor: number | null;
}> {
  if (
    supplyRate === undefined ||
    supplyRate.effectiveCostPerBaseUnitMinor === null
  ) {
    return {
      activePackQuantity: null,
      activePackUnit: null,
      activePackPriceMinor: null,
    };
  }
  const terms = item?.costTerms ?? null;
  if (
    supplyRate.costSource === "fifo_lot" &&
    supplyRate.fifoEquivalentPackPriceMinor !== null
  ) {
    return terms !== null
      ? {
          activePackQuantity: terms.packQuantity,
          activePackUnit: terms.packUnit,
          activePackPriceMinor: supplyRate.fifoEquivalentPackPriceMinor,
        }
      : {
          activePackQuantity: 1,
          activePackUnit: supplyRate.baseUnit,
          activePackPriceMinor: Math.round(
            supplyRate.effectiveCostPerBaseUnitMinor,
          ),
        };
  }
  if (
    supplyRate.costSource === "weighted_lot" &&
    supplyRate.weightedEquivalentPackPriceMinor !== null
  ) {
    return terms !== null
      ? {
          activePackQuantity: terms.packQuantity,
          activePackUnit: terms.packUnit,
          activePackPriceMinor: supplyRate.weightedEquivalentPackPriceMinor,
        }
      : {
          activePackQuantity: 1,
          activePackUnit: supplyRate.baseUnit,
          activePackPriceMinor: Math.round(
            supplyRate.effectiveCostPerBaseUnitMinor,
          ),
        };
  }
  if (supplyRate.costSource === "bulk_tier" && terms?.bulkTier != null) {
    return {
      activePackQuantity: terms.bulkTier.packQuantity,
      activePackUnit: terms.packUnit,
      activePackPriceMinor: terms.bulkTier.packPriceMinor,
    };
  }
  if (terms !== null) {
    return {
      activePackQuantity: terms.packQuantity,
      activePackUnit: terms.packUnit,
      activePackPriceMinor: terms.packPriceMinor,
    };
  }
  return {
    activePackQuantity: null,
    activePackUnit: null,
    activePackPriceMinor: null,
  };
}

function currencyMinorDigits(currency: string): number {
  return ZERO_DECIMAL_CURRENCY_CODES.has(currency.toUpperCase()) ? 0 : 2;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export * from "./costs-actuals.ts";
export * from "./costs-forecast.ts";
