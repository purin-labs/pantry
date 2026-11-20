// Kitchen Costs & margins (Plan 86): supplier pack prices and 7-day bulk
// tiers in Commerce's purchasing preset, deterministic batch and margin math
// across the 24 shop.seams.tokyo products, 30-day measured waste comparison,
// HTTP control plane role and revision fencing, and Portal chat agent parity.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  FORECAST_SUPPLIER_TERMS_CELL_KEY,
  META_SAVED_AT_CELL_KEY,
  OVERHEAD_LABOR_CELL_KEY,
  OVERHEAD_RENT_CELL_KEY,
  SCENARIO_CHANNEL_FEE_CELL_KEY,
  forecastWeekIndexCellKey,
  productCogsCellKey,
  productDayCellKey,
  productFormulaCellKey,
  productPriceCellKey,
  productSpoilCellKey,
  productWasteCellKey,
  supplyFieldCellKey,
} from "@purin-labs/costs-sheet-crdt";
import {
  backSolveDailyUnitsForNetDay,
  backSolveGrossPriceMinorForMargin,
  backSolveGrossPriceMinorForUnitNet,
  calculateBakery12WeekForecast,
  calculateBakeryCostsAndMargins,
  calculateBakeryPlanVsActuals,
  defaultCostAssumptions,
  parseCostsOverview,
  parseCostsSheetWriteResult,
  presetDemandCurveValues,
  type CostForecastPlan,
  type CostsOverview,
  type CostsSheetWrite,
  type ProductCostPlanEntry,
} from "@purin-labs/control-api";
import { newConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import {
  PATISSERIE_ITEMS,
  PATISSERIE_SUPPLIES,
  CommerceEntityPlaneClient,
  CommerceStorefrontClient,
  configurePatisserieMenu,
  includeStorefrontTax,
  patisserieRecipeId,
} from "@purin-labs/commerce-client";

import { accessControlPath } from "./access-route-support";
import { publishCafeMenu } from "./cafe-order-support";
import {
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { commerceHeaders, connectCommerceFixture } from "./commerce-support";
import { CostsSheetRoomClient } from "./costs-sheet-room-support";
import {
  controlReadHeaders,
  expectPong,
  openSocket,
} from "./hibernatable-socket-support";
import {
  createConversation,
  installMemoryFixture,
  post,
  workKind,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { network } from "./network";
import { allowAsPortal } from "./permission-request-support";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { providerClient } from "./pi-sdk-effect-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";
import {
  agentReceipts,
  chatDirect,
  finished,
  messageWord,
  startChat,
} from "./chat-journey-support";

declare module "vitest" {
  interface TaskMeta {
    costsAndMarginsEvidence?: Record<string, unknown>;
  }
}

const MERCHANT_ID = "merchant_costs_margins";
const STOPPED = "Seams Pantry stopped this step";

type SupplyCostArgs = Readonly<{
  inventoryItemId: string;
  expectedEntryRevision: number | null;
  currency: string;
  packQuantity: number;
  packUnit: string;
  packPriceMinor: number;
  supplierId: string | null;
  bulkTier: Readonly<{
    min7dQuantity: number;
    packQuantity: number;
    packPriceMinor: number;
  }> | null;
  notes: string | null;
}>;

type CostsPlanArgs = Readonly<{
  expectedPlanRevision: number | null;
  dailyLaborMinor: number | null;
  dailyRentMinor: number | null;
  products: readonly ProductCostPlanEntry[] | null;
  forecast?: Partial<CostForecastPlan> | null;
}>;

type LotCostArgs = Readonly<{
  lotId: string;
  inventoryItemId: string;
  expectedRevision: number | null;
  currency: string;
  invoicedQuantity: number;
  invoicedUnit: string;
  invoiceTotalMinor: number;
  invoiceReference: string | null;
  supplierId: string | null;
}>;

type Script = Readonly<{
  tool: string;
  args: () => Record<string, unknown>;
  ask?: Readonly<{ capabilityIds: readonly string[] }>;
}>;

type Journey = {
  readonly outputs: Record<string, string[]>;
  modelRequests: number;
  weekendTargetProductId: string;
  saveArgs: SupplyCostArgs | null;
  staleArgs: SupplyCostArgs | null;
  wrongUnitArgs: SupplyCostArgs | null;
  savePlanArgs: CostsPlanArgs | null;
  stalePlanArgs: CostsPlanArgs | null;
  saveLotArgs: LotCostArgs | null;
  staleLotArgs: LotCostArgs | null;
  editSheetArgs: Readonly<{
    changes: readonly Readonly<{ cellKey: string; value: string | null }>[];
  }> | null;
  demoteBeforeTool?: () => Promise<void>;
};

function scripts(journey: Journey): Readonly<Record<string, Script>> {
  const requireArgs = <T>(read: () => T | null): (() => T) => {
    return () => {
      const value = read();
      if (value === null) {throw new Error("Script missing tool arguments");}
      return value;
    };
  };
  return {
    READCOSTS: {
      tool: "costs_read",
      args: () => ({
        dailyTargets: null,
        bakeShelfWastePct: null,
        prepRejectPct: null,
        channelFeeBps: null,
        includedTaxBps: null,
        applyBulkTiers: null,
        lotCostBasis: null,
      }),
    },
    WEEKENDCOSTS: {
      tool: "costs_read",
      args: () => ({
        dailyTargets: [
          { targetId: journey.weekendTargetProductId, unitsPerDay: 25 },
        ],
        bakeShelfWastePct: 12,
        prepRejectPct: 4,
        channelFeeBps: 325,
        includedTaxBps: 800,
        applyBulkTiers: true,
        lotCostBasis: null,
      }),
    },
    FIFOCOSTS: {
      tool: "costs_read",
      args: () => ({
        dailyTargets: null,
        bakeShelfWastePct: null,
        prepRejectPct: null,
        channelFeeBps: null,
        includedTaxBps: null,
        applyBulkTiers: false,
        lotCostBasis: "fifo_lot",
      }),
    },
    ACTUALSCOSTS: {
      tool: "costs_read",
      args: () => ({
        dailyTargets: null,
        bakeShelfWastePct: null,
        prepRejectPct: null,
        channelFeeBps: null,
        includedTaxBps: null,
        applyBulkTiers: false,
        lotCostBasis: "fifo_lot",
        actualsWindowDays: 7,
      }),
    },
    FORECASTCOSTS: {
      tool: "costs_read",
      args: () => ({
        dailyTargets: null,
        bakeShelfWastePct: null,
        prepRejectPct: null,
        channelFeeBps: null,
        includedTaxBps: null,
        applyBulkTiers: true,
        lotCostBasis: null,
        actualsWindowDays: null,
        forecast: {
          openingCashMinor: 6_400_000,
          demandCurve: "seasonal_holiday",
          supplierTerms: "net_30",
          extraShiftThresholdPct: 125,
          extraShiftWeeklyMinor: 116_000,
          capexMinor: 800_000,
        },
      }),
    },
    SAVEFORECASTPLAN: {
      tool: "costs_plan_save",
      args: requireArgs(() => journey.savePlanArgs),
    },
    SAVESUPPLYCOST: {
      tool: "supply_cost_save",
      args: requireArgs(() => journey.saveArgs),
      ask: { capabilityIds: ["commerce.supply_cost.save"] },
    },
    STALESUPPLYCOST: {
      tool: "supply_cost_save",
      args: requireArgs(() => journey.staleArgs),
    },
    WRONGUNITSUPPLYCOST: {
      tool: "supply_cost_save",
      args: requireArgs(() => journey.wrongUnitArgs),
    },
    SAVECOSTSPLAN: {
      tool: "costs_plan_save",
      args: requireArgs(() => journey.savePlanArgs),
      ask: { capabilityIds: ["commerce.supply_cost.save"] },
    },
    STALECOSTSPLAN: {
      tool: "costs_plan_save",
      args: requireArgs(() => journey.stalePlanArgs),
    },
    SAVELOTCOST: {
      tool: "lot_cost_save",
      args: requireArgs(() => journey.saveLotArgs),
      ask: { capabilityIds: ["commerce.supply_cost.save"] },
    },
    STALELOTCOST: {
      tool: "lot_cost_save",
      args: requireArgs(() => journey.staleLotArgs),
    },
    EDITSHEET: {
      tool: "costs_sheet_edit",
      args: requireArgs(() => journey.editSheetArgs),
      ask: { capabilityIds: ["commerce.supply_cost.save"] },
    },
    VIEWERSUPPLYCOST: {
      tool: "supply_cost_save",
      args: requireArgs(() => journey.saveArgs),
    },
  };
}

it(
  "models 24 shop.seams.tokyo recipes, batch yields, 7-day bulk tiers, measured waste and margins across Portal HTTP and the chat agent",
  { timeout: 480_000 },
  async ({ task }: TestContext): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, reviewer, viewer, outsider, paths } = fixture;
    await connectCommerceFixture(
      author.organisationId,
      author.userId,
      MERCHANT_ID,
    );

    const now = new Date();
    const native = providerClient();
    const demo = await native.provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: author.organisationId,
      merchantId: MERCHANT_ID,
      profile: "cafe_patisserie",
      createdAt: now.toISOString(),
    });
    if (!demo.ok) {throw new Error(JSON.stringify(demo.error));}
    await publishCafeMenu(MERCHANT_ID);

    const entityPlane = new CommerceEntityPlaneClient({
      baseUrl: "http://underclerk.test",
      serviceToken: "underclerk-e2e-token",
      fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    });
    const storefront = new CommerceStorefrontClient({
      baseUrl: "http://underclerk.test",
      fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    });

    const configured = await configurePatisserieMenu(
      native,
      MERCHANT_ID,
      now,
      14,
      {
        entityPlane: {
          client: entityPlane,
          organisationId: String(author.organisationId),
          principalId: author.userId,
        },
      },
    );
    expect(configured.items).toBe(24);
    expect(configured.recipes).toBeGreaterThanOrEqual(24);
    expect(configured.supplyCostsSeeded).toBe(PATISSERIE_SUPPLIES.length);

    await includeStorefrontTax(native, storefront, MERCHANT_ID, 800);

    // Record real production batch reject loss (24 planned -> 22 actual) and
    // 3 units of showcase spoilage on Black sesame financier so measuredWaste
    // reflects genuine 30-day shop movements.
    const sesameItem = PATISSERIE_ITEMS.find(
      (entry) => entry.slug === "financier_black_sesame",
    );
    const espressoItem = PATISSERIE_ITEMS.find(
      (entry) => entry.slug === "drink_espresso",
    );
    if (sesameItem === undefined || espressoItem === undefined) {
      throw new Error("Missing seeded patisserie definitions");
    }
    const sesameProductId = `product_patisserie_${sesameItem.slug}`;
    const espressoProductId = `product_patisserie_${espressoItem.slug}`;
    const sesameRecipeId = patisserieRecipeId(sesameItem);
    await recordPlainFinancierBatchAndWaste(native, sesameRecipeId, now);

    // Attach a photo on the Products endpoint so Costs & margins reads the same image URL.
    const photoForm = new FormData();
    photoForm.set("productId", sesameProductId);
    photoForm.set("expectedPhotoRevision", "0");
    photoForm.set("altText", "Black sesame financier");
    photoForm.set(
      "photo",
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])],
        "sesame.png",
        { type: "image/png" },
      ),
    );
    const photoHeaders = commerceHeaders(author.session);
    photoHeaders.delete("content-type");
    photoHeaders.set("idempotency-key", `costs-photo-${crypto.randomUUID()}`);
    const photoAdded = await exports.default.fetch(
      `https://localhost${paths.organisation}/commerce/products/photos/add`,
      {
        method: "POST",
        headers: photoHeaders,
        body: photoForm,
      },
    );
    expect(photoAdded.status, await photoAdded.clone().text()).toBe(200);

    // 1. Portal HTTP GET /commerce/costs: owner and viewer read the full model;
    //    un-admitted outsider is refused.
    const outsiderRead = await fetchCosts(outsider, paths.organisation, "GET");
    expect([401, 403, 404]).toContain(outsiderRead.status);

    const viewerRead = await fetchCosts(viewer, paths.organisation, "GET");
    expect(viewerRead.status).toBe(200);
    const viewerOverview = parseCostsOverview(await viewerRead.json());

    const initialOverview = await readPortalCosts(author, paths.organisation);
    expect(viewerOverview.merchantRevision).toBe(
      initialOverview.merchantRevision,
    );
    expect(initialOverview.canEditPrices).toBe(true);
    expect(viewerOverview.canEditPrices).toBe(false);
    expect(initialOverview.costPlan).toEqual({
      revision: null,
      dailyLaborMinor: 0,
      dailyRentMinor: 0,
      products: [],
    });
    expect(initialOverview.currency).toBe("JPY");
    expect(initialOverview.defaultIncludedTaxBps).toBe(800);
    expect(initialOverview.products.length).toBeGreaterThanOrEqual(24);
    expect(initialOverview.recipes.length).toBeGreaterThanOrEqual(24);

    const patisserieProducts = initialOverview.products.filter((product) =>
      product.productId.startsWith("product_patisserie_"),
    );
    expect(patisserieProducts).toHaveLength(24);
    const itemsWithTerms = initialOverview.items.filter(
      (item) => item.costTerms !== null,
    );
    expect(itemsWithTerms.length).toBeGreaterThanOrEqual(
      PATISSERIE_SUPPLIES.length,
    );

    expect(initialOverview.measuredWaste.plannedBatchUnits).toBe(24);
    expect(initialOverview.measuredWaste.actualBatchUnits).toBe(22);
    expect(initialOverview.measuredWaste.measuredBatchRejectPct).toBeCloseTo(
      8.33,
      1,
    );
    expect(initialOverview.measuredWaste.stockedUnitsWasted).toBe(3);
    expect(
      initialOverview.measuredWaste.measuredShelfWastePct ?? 0,
    ).toBeGreaterThan(0);

    // 2. Deterministic batch rounding, 7-day bulk tier unlock, waste & tax math.
    const plainProduct = initialOverview.products.find(
      (product) => product.productId === sesameProductId,
    );
    const espressoProduct = initialOverview.products.find(
      (product) => product.productId === espressoProductId,
    );
    if (plainProduct === undefined || espressoProduct === undefined) {
      throw new Error("Missing seeded patisserie products");
    }

    const baseAssumptions = defaultCostAssumptions(initialOverview);
    const withBulk = calculateBakeryCostsAndMargins({
      overview: initialOverview,
      dailyTargets: {
        [plainProduct.productId]: 25,
        [espressoProduct.productId]: 19,
      },
      assumptions: { ...baseAssumptions, applyBulkTiers: true },
    });
    const withoutBulk = calculateBakeryCostsAndMargins({
      overview: initialOverview,
      dailyTargets: {
        [plainProduct.productId]: 25,
        [espressoProduct.productId]: 19,
      },
      assumptions: { ...baseAssumptions, applyBulkTiers: false },
    });

    const plainRow = withBulk.products.find(
      (row) => row.productId === plainProduct.productId,
    );
    const espressoRow = withBulk.products.find(
      (row) => row.productId === espressoProduct.productId,
    );
    if (plainRow === undefined || espressoRow === undefined) {
      throw new Error("Missing calculated product rows");
    }
    expect(plainProduct.imageUrl).toMatch(
      /^https?:\/\/underclerk\.test\/v1\/public\/merchants\/.+\/media\/media_/u,
    );
    expect(plainRow.imageUrl).toBe(plainProduct.imageUrl);
    expect(espressoRow.imageUrl).toBeNull();
    // Plain financier yields 24/batch -> 25 daily demand requires 2 whole batches (48 units).
    expect(plainRow.batchYield).toBe(24);
    expect(plainRow.batchesPerDay).toBe(2);
    expect(plainRow.producedUnits).toBe(48);
    // 8% included consumption tax on ¥330 extracts ¥24 tax -> ¥306 net ex-tax sale.
    expect(plainRow.grossPriceMinor).toBe(330);
    expect(plainRow.includedTaxMinor).toBe(24);
    expect(plainRow.netExTaxPriceMinor).toBe(306);

    // Forward BOM wholesale cost chain connects supplier packs -> recipe batch -> unit COGS.
    expect(plainRow.recipeRevision).toBeGreaterThanOrEqual(1);
    expect(plainRow.bomLines.length).toBeGreaterThan(0);
    const plainBomSum = plainRow.bomLines.reduce(
      (acc, line) => acc + line.costPerUnitMinor,
      0,
    );
    expect(plainBomSum).toBeCloseTo(plainRow.bomUnitCostMinor, 4);
    const plainButterLine = plainRow.bomLines.find(
      (line) => line.inventoryItemId === "inventory_cultured_butter",
    );
    expect(plainButterLine).toMatchObject({
      inventoryItemId: "inventory_cultured_butter",
      source: "recipe",
      hasCostTerms: true,
    });
    expect(plainButterLine?.activePackPriceMinor ?? 0).toBeGreaterThan(0);

    // Reverse supply coverage & downstream SKU margin impact connect stock -> 7d burn -> SKUs.
    const butterUsageInitial = withBulk.supplies.find(
      (supply) => supply.inventoryItemId === "inventory_cultured_butter",
    );
    expect(butterUsageInitial).toBeDefined();
    expect(butterUsageInitial?.onHandBaseQuantity).not.toBeNull();
    expect(butterUsageInitial?.daysOfSupply).not.toBeNull();
    expect(butterUsageInitial?.usedInProductCount ?? 0).toBeGreaterThan(0);
    expect(butterUsageInitial?.tenPctHikeWeeklyImpactMinor ?? 0).toBeLessThan(0);
    expect(
      butterUsageInitial?.skuImpacts.some(
        (impact) => impact.productId === plainProduct.productId,
      ),
    ).toBe(true);

    // Prepared drink scales 1-to-1 per order, plus prep reject allowance when non-zero.
    expect(espressoRow.fulfillmentKind).toBe("prepared");
    expect(espressoRow.dailyTargetUnits).toBe(19);
    expect(espressoRow.batchesPerDay).toBe(19);
    expect(espressoRow.producedUnits).toBeGreaterThan(19);

    // 7-day bulk tiers unlock across shared patisserie supplies and lower daily spend.
    const supplySpendWithBulk =
      withBulk.summary.dailyIngredientSpendMinor +
      withBulk.summary.dailyPackagingSpendMinor;
    const supplySpendWithoutBulk =
      withoutBulk.summary.dailyIngredientSpendMinor +
      withoutBulk.summary.dailyPackagingSpendMinor;
    expect(withBulk.summary.unlockedBulkTierCount).toBeGreaterThan(0);
    expect(withBulk.summary.dailyTierSavingsMinor).toBeGreaterThan(0);
    expect(supplySpendWithBulk).toBeLessThan(supplySpendWithoutBulk);
    expect(withBulk.summary.dailyNetContributionMinor).toBeGreaterThan(
      withoutBulk.summary.dailyNetContributionMinor,
    );

    // 3. Portal HTTP POST /commerce/costs: viewer refusal, unit check, idempotent
    //    replay, live batch cost propagation, and stale revision 409.
    const butterBefore = initialOverview.items.find(
      (item) => item.id === "inventory_cultured_butter",
    );
    if (butterBefore === undefined || butterBefore.costTerms === null) {
      throw new Error("Missing cultured butter cost terms");
    }
    const plainUnitCostBefore = plainRow.allInUnitCostMinor;

    const viewerSave = await fetchCosts(viewer, paths.organisation, "POST", {
      merchantRevision: initialOverview.merchantRevision,
      requestedAt: new Date().toISOString(),
      inventoryItemId: butterBefore.id,
      expectedEntryRevision: butterBefore.costTerms.entryRevision,
      currency: "JPY",
      packQuantity: 450,
      packUnit: "gram",
      packPriceMinor: 1_350,
      supplierId: null,
      bulkTier: butterBefore.costTerms.bulkTier,
      notes: "Viewer attempt",
    });
    expect(viewerSave.status).toBe(404);

    const wrongUnitHttp = await fetchCosts(author, paths.organisation, "POST", {
      merchantRevision: initialOverview.merchantRevision,
      requestedAt: new Date().toISOString(),
      inventoryItemId: butterBefore.id,
      expectedEntryRevision: butterBefore.costTerms.entryRevision,
      currency: "JPY",
      packQuantity: 1,
      packUnit: "liter",
      packPriceMinor: 1_350,
      supplierId: null,
      bulkTier: null,
      notes: "Incompatible unit",
    });
    expect(wrongUnitHttp.status).toBe(422);
    expect(await wrongUnitHttp.json()).toMatchObject({
      ok: false,
      error: "supply_cost_unit_mismatch",
    });

    const butterIdempotencyKey = crypto.randomUUID();
    const butterBody = {
      merchantRevision: initialOverview.merchantRevision,
      requestedAt: new Date().toISOString(),
      inventoryItemId: butterBefore.id,
      expectedEntryRevision: butterBefore.costTerms.entryRevision,
      currency: "JPY",
      packQuantity: 450,
      packUnit: "gram",
      packPriceMinor: 1_530,
      supplierId: null,
      bulkTier: {
        min7dQuantity: 4_500,
        packQuantity: 4_500,
        packPriceMinor: 13_500,
      },
      notes: "Autumn butter contract",
    };
    const firstSave = await fetchCosts(
      author,
      paths.organisation,
      "POST",
      butterBody,
      butterIdempotencyKey,
    );
    expect(firstSave.status, await firstSave.clone().text()).toBe(200);
    const firstSaveJson: unknown = await firstSave.json();
    expect(firstSaveJson).toMatchObject({
      ok: true,
      entryRevision: butterBefore.costTerms.entryRevision + 1,
    });

    const replayedSave = await fetchCosts(
      author,
      paths.organisation,
      "POST",
      butterBody,
      butterIdempotencyKey,
    );
    expect(replayedSave.status).toBe(200);
    expect(await replayedSave.json()).toEqual(firstSaveJson);

    const staleHttp = await fetchCosts(author, paths.organisation, "POST", {
      ...butterBody,
      packPriceMinor: 1_600,
    });
    expect(staleHttp.status).toBe(409);
    expect(await staleHttp.json()).toMatchObject({
      error: "stale_resource_revision",
    });

    const afterButterOverview = await readPortalCosts(
      author,
      paths.organisation,
    );
    const afterButterCalc = calculateBakeryCostsAndMargins({
      overview: afterButterOverview,
      dailyTargets: { [plainProduct.productId]: 25 },
      assumptions: { ...baseAssumptions, applyBulkTiers: true },
    });
    const plainRowAfterButter = afterButterCalc.products.find(
      (row) => row.productId === plainProduct.productId,
    );
    expect(plainRowAfterButter?.allInUnitCostMinor ?? 0).toBeGreaterThan(
      plainUnitCostBefore,
    );
    // Live offer price stays untouched.
    expect(plainRowAfterButter?.grossPriceMinor).toBe(330);

    // 3b. Phase 2 spreadsheet save_sheet: Margin % -> Price ¥ back-solve, live Offer
    //     price writes, regional D1 Labor/Rent/Mon-Sun plan writes, supply writes,
    //     idempotent replay, stale Offer & Plan 409 fencing, and operator vs owner role separation.
    if (plainRowAfterButter === undefined) {
      throw new Error("Missing plain row after butter update");
    }
    const solvedGrossPriceMinor = backSolveGrossPriceMinorForMargin({
      fixedUnitCostMinor:
        plainRowAfterButter.ingredientUnitCostMinor +
        plainRowAfterButter.packagingUnitCostMinor +
        plainRowAfterButter.wasteAndSurplusUnitMinor,
      targetNetMarginPct: 45,
      includedTaxBps: 800,
      channelFeeBps: baseAssumptions.channelFeeBps,
    });
    if (solvedGrossPriceMinor === null) {
      throw new Error("Back-solve failed for 45% target margin");
    }
    expect(solvedGrossPriceMinor).toBeGreaterThan(330);

    const plainBeforeSheet = afterButterOverview.products.find(
      (product) => product.productId === plainProduct.productId,
    );
    const sesameSupplyBefore = afterButterOverview.items.find(
      (item) => item.id === "inventory_black_sesame",
    );
    if (
      plainBeforeSheet === undefined ||
      sesameSupplyBefore === undefined ||
      sesameSupplyBefore.costTerms === null
    ) {
      throw new Error("Missing plain product or black sesame supply before sheet save");
    }

    const sheetIdempotencyKey = crypto.randomUUID();
    const sheetBody: CostsSheetWrite = {
      kind: "save_sheet",
      merchantRevision: afterButterOverview.merchantRevision,
      requestedAt: new Date().toISOString(),
      priceWrites: [
        {
          offerId: plainBeforeSheet.offerId,
          expectedOfferRevision: plainBeforeSheet.offerRevision,
          currency: "JPY",
          priceMinor: solvedGrossPriceMinor,
        },
      ],
      planWrite: {
        expectedPlanRevision: null,
        dailyLaborMinor: 16_000,
        dailyRentMinor: 11_000,
        products: [
          {
            productId: plainProduct.productId,
            weekUnits: [20, 20, 22, 24, 30, 48, 46],
            spoilBps: 600,
          },
          {
            productId: espressoProduct.productId,
            weekUnits: [18, 18, 20, 20, 25, 36, 31],
            spoilBps: null,
          },
        ],
      },
      supplyWrites: [
        {
          inventoryItemId: sesameSupplyBefore.id,
          expectedEntryRevision: sesameSupplyBefore.costTerms.entryRevision,
          currency: "JPY",
          packQuantity: sesameSupplyBefore.costTerms.packQuantity,
          packUnit: sesameSupplyBefore.costTerms.packUnit,
          packPriceMinor: sesameSupplyBefore.costTerms.packPriceMinor + 120,
          supplierId: sesameSupplyBefore.costTerms.supplierId,
          bulkTier: sesameSupplyBefore.costTerms.bulkTier,
          notes: "Spreadsheet batch supply update",
        },
      ],
    };

    const firstSheetSave = await fetchCosts(
      author,
      paths.organisation,
      "POST",
      sheetBody,
      sheetIdempotencyKey,
    );
    expect(firstSheetSave.status, await firstSheetSave.clone().text()).toBe(200);
    const firstSheetResult = parseCostsSheetWriteResult(
      await firstSheetSave.json(),
    );
    expect(firstSheetResult).toMatchObject({
      ok: true,
      planRevision: 1,
      updatedOfferCount: 1,
      updatedSupplyCount: 1,
    });

    const replayedSheetSave = await fetchCosts(
      author,
      paths.organisation,
      "POST",
      sheetBody,
      sheetIdempotencyKey,
    );
    expect(replayedSheetSave.status).toBe(200);
    expect(parseCostsSheetWriteResult(await replayedSheetSave.json())).toEqual(
      firstSheetResult,
    );

    const afterSheetOverview = await readPortalCosts(
      author,
      paths.organisation,
    );
    const plainAfterSheet = afterSheetOverview.products.find(
      (product) => product.productId === plainProduct.productId,
    );
    expect(plainAfterSheet).toMatchObject({
      priceMinor: solvedGrossPriceMinor,
      offerRevision: plainBeforeSheet.offerRevision + 1,
    });
    expect(afterSheetOverview.costPlan).toMatchObject({
      revision: 1,
      dailyLaborMinor: 16_000,
      dailyRentMinor: 11_000,
    });
    expect(afterSheetOverview.costPlan.products).toHaveLength(2);

    const weeklySheetCalc = calculateBakeryCostsAndMargins({
      overview: afterSheetOverview,
      demandMode: "weekly",
      assumptions: defaultCostAssumptions(afterSheetOverview),
    });
    const plainWeeklyRow = weeklySheetCalc.products.find(
      (row) => row.productId === plainProduct.productId,
    );
    expect(plainWeeklyRow).toMatchObject({
      grossPriceMinor: solvedGrossPriceMinor,
      effectiveSpoilagePct: 6,
      sevenDayUnits: 210,
      dailyTargetUnits: 30,
    });
    // Back-solved price achieves >= 45% net margin (before sesame +120 pack bump it was exact;
    // with 6% spoilage override instead of 8.33% default, net margin stays above 44%).
    expect(plainWeeklyRow?.netMarginPct ?? 0).toBeGreaterThan(44);
    expect(weeklySheetCalc.summary.dailyLaborMinor).toBe(16_000);
    expect(weeklySheetCalc.summary.dailyRentMinor).toBe(11_000);
    expect(weeklySheetCalc.summary.dailyFixedCostMinor).toBe(27_000);
    expect(weeklySheetCalc.summary.dailyOperatingProfitMinor).toBeCloseTo(
      weeklySheetCalc.summary.dailyNetContributionMinor - 27_000,
      2,
    );
    expect(weeklySheetCalc.summary.breakEvenUnitsPerDay ?? 0).toBeGreaterThan(0);

    // Stale expectedPlanRevision and stale expectedOfferRevision each refuse with 409.
    const stalePlanHttp = await fetchCosts(author, paths.organisation, "POST", {
      kind: "save_sheet",
      merchantRevision: afterSheetOverview.merchantRevision,
      requestedAt: new Date().toISOString(),
      priceWrites: [],
      planWrite: {
        expectedPlanRevision: null,
        dailyLaborMinor: 19_000,
        dailyRentMinor: 11_000,
        products: afterSheetOverview.costPlan.products,
      },
      supplyWrites: [],
    });
    expect(stalePlanHttp.status).toBe(409);
    expect(await stalePlanHttp.json()).toMatchObject({
      error: "stale_resource_revision",
    });

    const staleOfferHttp = await fetchCosts(author, paths.organisation, "POST", {
      kind: "save_sheet",
      merchantRevision: afterSheetOverview.merchantRevision,
      requestedAt: new Date().toISOString(),
      priceWrites: [
        {
          offerId: plainBeforeSheet.offerId,
          expectedOfferRevision: plainBeforeSheet.offerRevision,
          currency: "JPY",
          priceMinor: solvedGrossPriceMinor + 10,
        },
      ],
      planWrite: null,
      supplyWrites: [],
    });
    expect(staleOfferHttp.status).toBe(409);
    expect(await staleOfferHttp.json()).toMatchObject({
      error: "stale_resource_revision",
    });

    // Operator role separation: operator reads canEditPrices: false, is refused on
    // priceWrites (403), and saves Labor/Rent/Mon-Sun planWrite (200, planRevision: 2).
    const scopeForRoles = await requireOrganisationExecutionScope(
      env,
      fixture.organisationId,
    );
    await scopeForRoles.database
      .prepare(
        "UPDATE service_role_grant SET role = 'operator' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(fixture.organisationId, reviewer.userId)
      .run();
    try {
      const operatorOverview = await readPortalCosts(
        reviewer,
        paths.organisation,
      );
      expect(operatorOverview.canEditPrices).toBe(false);

      const operatorPriceAttempt = await fetchCosts(
        reviewer,
        paths.organisation,
        "POST",
        {
          kind: "save_sheet",
          merchantRevision: operatorOverview.merchantRevision,
          requestedAt: new Date().toISOString(),
          priceWrites: [
            {
              offerId: plainBeforeSheet.offerId,
              expectedOfferRevision: plainBeforeSheet.offerRevision + 1,
              currency: "JPY",
              priceMinor: solvedGrossPriceMinor + 20,
            },
          ],
          planWrite: null,
          supplyWrites: [],
        },
      );
      expect(operatorPriceAttempt.status).toBe(403);
      expect(await operatorPriceAttempt.json()).toMatchObject({
        error: "insufficient_role",
      });

      const operatorPlanSave = await fetchCosts(
        reviewer,
        paths.organisation,
        "POST",
        {
          kind: "save_sheet",
          merchantRevision: operatorOverview.merchantRevision,
          requestedAt: new Date().toISOString(),
          priceWrites: [],
          planWrite: {
            expectedPlanRevision: 1,
            dailyLaborMinor: 17_500,
            dailyRentMinor: 11_000,
            products: operatorOverview.costPlan.products,
          },
          supplyWrites: [],
        },
      );
      expect(
        operatorPlanSave.status,
        await operatorPlanSave.clone().text(),
      ).toBe(200);
      expect(
        parseCostsSheetWriteResult(await operatorPlanSave.json()),
      ).toMatchObject({
        ok: true,
        planRevision: 2,
        updatedOfferCount: 0,
        updatedSupplyCount: 0,
      });
    } finally {
      await scopeForRoles.database
        .prepare(
          "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
        )
        .bind(fixture.organisationId, reviewer.userId)
        .run();
    }

    // 4. Portal chat agent parity: costs_read, supply_cost_save, and costs_plan_save
    //    with prompts, private-chat exit hold, durable receipts, concurrency refusal, and viewer refusal.
    const beforeAgentOverview = await readPortalCosts(
      author,
      paths.organisation,
    );
    const almondBefore = beforeAgentOverview.items.find(
      (item) => item.id === "inventory_almond_flour",
    );
    if (almondBefore === undefined || almondBefore.costTerms === null) {
      throw new Error("Missing almond flour cost terms");
    }

    const baseAlmondSaveArgs: SupplyCostArgs = {
      inventoryItemId: almondBefore.id,
      expectedEntryRevision: almondBefore.costTerms.entryRevision,
      currency: "JPY",
      packQuantity: 1_000,
      packUnit: "gram",
      packPriceMinor: 2_650,
      supplierId: null,
      bulkTier: {
        min7dQuantity: 5_000,
        packQuantity: 5_000,
        packPriceMinor: 11_900,
      },
      notes: "Agent updated Marcona almond contract",
    };

    const journey: Journey = {
      outputs: {},
      modelRequests: 0,
      weekendTargetProductId: plainProduct.productId,
      saveArgs: baseAlmondSaveArgs,
      staleArgs: null,
      wrongUnitArgs: null,
      savePlanArgs: {
        expectedPlanRevision: 2,
        dailyLaborMinor: 18_200,
        dailyRentMinor: null,
        products: [
          {
            productId: plainProduct.productId,
            weekUnits: [24, 24, 24, 24, 36, 48, 44],
            spoilBps: 550,
          },
        ],
      },
      stalePlanArgs: null,
      saveLotArgs: null,
      staleLotArgs: null,
      editSheetArgs: null,
    };

    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey),
      ),
    );
    const lastOutput = (word: string): string => {
      const output = journey.outputs[word]?.at(-1);
      if (output === undefined) {throw new Error(`No output for ${word}`);}
      return output;
    };

    await chatThrough(fixture, author, "GETREADY", {});

    // 4a. First costs_read asks in one combined prompt for stock levels, prices and recipes.
    const readPrompt = await chatThrough(fixture, author, "READCOSTS", {
      action: "Read stock levels, read prices and read recipes",
    });
    const agentBaselineText = lastOutput("READCOSTS");
    expect(agentBaselineText).not.toContain("Output truncated");
    expect(agentBaselineText).toContain(sesameProductId);
    expect(agentBaselineText).toContain("inventory_cultured_butter");
    expect(agentBaselineText).toContain("dailyLaborMinor");
    expect(agentBaselineText).toContain("17500");
    expect(agentBaselineText).toContain("breakEvenUnitsPerDay");
    expect(agentBaselineText).toContain("weekUnits");

    // 4b. Scenario what-if costs_read runs without prompts and mutates nothing.
    const stockBeforeWhatIf = await native.readStockSnapshot(MERCHANT_ID);
    if (!stockBeforeWhatIf.ok) {throw new Error("Snapshot unavailable");}
    await chatDirect(fixture, author, "WEEKENDCOSTS");
    const weekendText = lastOutput("WEEKENDCOSTS");
    expect(weekendText).not.toContain("Output truncated");
    const weekendFirst: unknown = JSON.parse(weekendText);
    const weekendParsed: unknown =
      typeof weekendFirst === "string"
        ? JSON.parse(weekendFirst)
        : weekendFirst;
    if (!isRecord(weekendParsed) || !isRecord(weekendParsed.code_mode_value)) {
      throw new Error("Invalid weekend costs_read payload");
    }
    expect(weekendParsed.code_mode_value.assumptions).toMatchObject({
      bakeShelfWastePct: 12,
      prepRejectPct: 4,
      channelFeeBps: 325,
    });
    const weekendProducts = Array.isArray(weekendParsed.code_mode_value.products)
      ? weekendParsed.code_mode_value.products
      : [];
    const weekendSesame = weekendProducts.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.productId === sesameProductId,
    );
    expect(weekendSesame).toMatchObject({
      targetUnits: 25,
      batchesPerDay: 2,
      producedUnits: 48,
    });
    expect(
      Array.isArray(weekendSesame?.bomLines) && weekendSesame.bomLines.length > 0,
    ).toBe(true);
    const weekendSupplies = Array.isArray(weekendParsed.code_mode_value.supplies)
      ? weekendParsed.code_mode_value.supplies
      : [];
    const weekendButter = weekendSupplies.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.id === "inventory_cultured_butter",
    );
    expect(typeof weekendButter?.usedInProductCount).toBe("number");
    expect(Number(weekendButter?.usedInProductCount ?? 0)).toBeGreaterThan(0);
    expect(typeof weekendButter?.daysOfSupply).toBe("number");
    const stockAfterWhatIf = await native.readStockSnapshot(MERCHANT_ID);
    if (!stockAfterWhatIf.ok) {throw new Error("Snapshot unavailable");}
    expect(stockAfterWhatIf.value.commerce.merchantRevision).toBe(
      stockBeforeWhatIf.value.commerce.merchantRevision,
    );

    // 4c. supply_cost_save asks once for capability, holds at private-chat exit,
    //     and once allowed saves and writes one agent receipt.
    const savePrompt = await chatThrough(fixture, author, "SAVESUPPLYCOST", {
      action: "Save supplier pack prices and cost plan",
    });
    expect(lastOutput("SAVESUPPLYCOST")).toContain(STOPPED);
    expect(
      (await readPortalCosts(author, paths.organisation)).items.find(
        (item) => item.id === almondBefore.id,
      )?.costTerms?.entryRevision,
    ).toBe(almondBefore.costTerms.entryRevision);

    await allowHeldStep(fixture);
    await chatDirect(fixture, author, "SAVESUPPLYCOST");
    expect(lastOutput("SAVESUPPLYCOST")).toContain("receiptId");

    const afterAgentSave = await readPortalCosts(author, paths.organisation);
    const almondAfter = afterAgentSave.items.find(
      (item) => item.id === almondBefore.id,
    );
    expect(almondAfter?.costTerms).toMatchObject({
      entryRevision: almondBefore.costTerms.entryRevision + 1,
      packPriceMinor: 2_650,
      notes: "Agent updated Marcona almond contract",
    });

    // 4d. Stale expectedEntryRevision and incompatible unit are refused in prose
    //     with no extra receipt.
    journey.staleArgs = {
      ...baseAlmondSaveArgs,
      packPriceMinor: 2_900,
    };
    await chatApproved(fixture, "STALESUPPLYCOST");
    expect(lastOutput("STALESUPPLYCOST")).toContain(
      "changed after you read it",
    );

    journey.wrongUnitArgs = {
      ...baseAlmondSaveArgs,
      expectedEntryRevision: almondBefore.costTerms.entryRevision + 1,
      packUnit: "milliliter",
    };
    await chatApproved(fixture, "WRONGUNITSUPPLYCOST");
    expect(lastOutput("WRONGUNITSUPPLYCOST")).toContain("not compatible");

    // 4d-2. costs_plan_save holds at private-chat exit before mutating D1,
    //       commits revision 3 with one durable receipt once approved, preserves
    //       untouched product plans and dailyRentMinor, and refuses stale revision.
    await chatDirect(fixture, author, "SAVECOSTSPLAN");
    expect(lastOutput("SAVECOSTSPLAN")).toContain(STOPPED);
    expect(
      (await readPortalCosts(author, paths.organisation)).costPlan.revision,
    ).toBe(2);

    // A person has the sheet open while the agent saves the plan. The save
    // stamps the sheet, so that the open tab reloads the saved plan.
    const saveWatcher = new CostsSheetRoomClient(
      await openSocket(
        `https://localhost${paths.organisation}/commerce/costs/sheet/socket`,
        reviewer.session,
      ),
    );
    try {
      await saveWatcher.sync();
      await allowHeldStep(fixture);
      await chatDirect(fixture, author, "SAVECOSTSPLAN");
      expect(lastOutput("SAVECOSTSPLAN")).toContain("receiptId");
      await expect
        .poll(() => typeof saveWatcher.cells()[META_SAVED_AT_CELL_KEY])
        .toBe("string");
    } finally {
      await saveWatcher.close();
    }

    const afterAgentPlanSave = await readPortalCosts(
      author,
      paths.organisation,
    );
    expect(afterAgentPlanSave.costPlan).toMatchObject({
      revision: 3,
      dailyLaborMinor: 18_200,
      dailyRentMinor: 11_000,
    });
    expect(afterAgentPlanSave.costPlan.products).toHaveLength(2);
    expect(
      afterAgentPlanSave.costPlan.products.find(
        (entry) => entry.productId === plainProduct.productId,
      ),
    ).toEqual({
      productId: plainProduct.productId,
      weekUnits: [24, 24, 24, 24, 36, 48, 44],
      spoilBps: 550,
    });

    journey.stalePlanArgs = {
      expectedPlanRevision: 2,
      dailyLaborMinor: 21_000,
      dailyRentMinor: null,
      products: null,
    };
    await chatApproved(fixture, "STALECOSTSPLAN");
    expect(lastOutput("STALECOSTSPLAN")).toContain("changed after you read it");
    expect(
      (await readPortalCosts(author, paths.organisation)).costPlan.revision,
    ).toBe(3);

    // 4e. A viewer cannot start a Portal chat (404), and an operator demoted
    //     to viewer mid-turn loses live turn authority before supply_cost_save
    //     can mutate pack prices or write a receipt.
    const viewerConvId = newConversationId();
    await createConversation(viewer, viewerConvId, fixture.route);
    const viewerChatAttempt = await post(viewer, paths.chat, {
      kind: "message",
      conversationId: viewerConvId,
      requestId: `request_${viewerConvId}_VIEWER`,
      model: fixture.route.model,
      text: "VIEWERSUPPLYCOST now.",
      surfaceContext: null,
      browserContext: { kind: "unavailable" },
    });
    expect(viewerChatAttempt.status).toBe(404);
    expect(await viewerChatAttempt.json()).toMatchObject({
      ok: false,
      error: "organisation_role_insufficient",
    });

    const scopeForDemote = await requireOrganisationExecutionScope(
      env,
      fixture.organisationId,
    );
    journey.saveArgs = {
      ...baseAlmondSaveArgs,
      expectedEntryRevision: almondBefore.costTerms.entryRevision + 1,
      packPriceMinor: 3_100,
      notes: "Should never apply after viewer demotion",
    };
    let demotedBeforeTool = false;
    journey.demoteBeforeTool = async () => {
      demotedBeforeTool = true;
      await scopeForDemote.database
        .prepare(
          "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
        )
        .bind(fixture.organisationId, author.userId)
        .run();
    };
    try {
      const demotedConvId = await startChat(fixture, author, "VIEWERSUPPLYCOST");
      await expect
        .poll(workKind.bind(null, author, demotedConvId), { timeout: 60_000 })
        .toBe("failed");
      expect(demotedBeforeTool).toBe(true);
    } finally {
      await scopeForDemote.database
        .prepare(
          "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
        )
        .bind(fixture.organisationId, author.userId)
        .run();
    }
    const almondAfterViewerAttempt = (
      await readPortalCosts(author, paths.organisation)
    ).items.find((item) => item.id === almondBefore.id);
    expect(almondAfterViewerAttempt?.costTerms).toMatchObject({
      entryRevision: almondBefore.costTerms.entryRevision + 1,
      packPriceMinor: 2_650,
    });

    // 5. Plan 86 Phase 3 Full Multiplayer: hibernatable WebSocket Yjs room,
    //    Origin & outsider refusal, viewer read-only enforcement, Figma live
    //    pointers & colored cell focus borders, concurrent cell merge, chat
    //    agent costs_sheet_edit + IFC shared-draft exit gate + live agent
    //    cursor, Save changes partial settlement + meta:savedAt, and Reset.
    const sheetHttpUrl = `https://localhost${paths.organisation}/commerce/costs/sheet`;
    const sheetSocketUrl = `${sheetHttpUrl}/socket`;
    const sheetResetUrl = `${sheetHttpUrl}/reset`;

    const outsiderSocketAttempt = await exports.default.fetch(sheetSocketUrl, {
      headers: {
        ...controlReadHeaders(outsider.session),
        Upgrade: "websocket",
        Origin: "https://localhost",
      },
    });
    expect([401, 403, 404]).toContain(outsiderSocketAttempt.status);

    const badOriginAttempt = await exports.default.fetch(sheetSocketUrl, {
      headers: {
        ...controlReadHeaders(author.session),
        Upgrade: "websocket",
        Origin: "https://evil.example",
      },
    });
    expect(badOriginAttempt.status).toBe(403);

    const authorRoom = new CostsSheetRoomClient(
      await openSocket(sheetSocketUrl, author.session),
    );
    const reviewerRoom = new CostsSheetRoomClient(
      await openSocket(sheetSocketUrl, reviewer.session),
    );
    const viewerRoom = new CostsSheetRoomClient(
      await openSocket(sheetSocketUrl, viewer.session),
    );

    let storedSheets: unknown = [];
    let viewerRoomRefusal = "";
    try {
      expect(await authorRoom.sync()).toMatchObject({
        access: "edit",
        generation: 1,
      });
      expect(await reviewerRoom.sync()).toMatchObject({
        access: "edit",
        generation: 1,
      });
      expect(await viewerRoom.sync()).toMatchObject({
        access: "read",
        generation: 1,
      });
      await expectPong(authorRoom.socket);

      // A viewer who claims to edit a cell still shows to the others as
      // viewing, with no cell. Its pointer follows the claim on the same
      // socket, so the room has read the claim when the pointer shows.
      viewerRoom.sendPresence("editing", {
        sheet: "supplies",
        cellKey: OVERHEAD_LABOR_CELL_KEY,
      });
      viewerRoom.sendPointer({ x: 0.5, y: 0.5 });
      const viewerEntry = () =>
        authorRoom.participants.find((p) => p.userId === viewer.userId);
      await expect
        .poll(() => viewerEntry()?.pointer?.position ?? null)
        .toEqual({ x: 0.5, y: 0.5 });
      expect([viewerEntry()?.state, viewerEntry()?.selection]).toEqual([
        "viewing",
        null,
      ]);

      // Concurrent Yjs cell edits from two teammates merge without conflict.
      const authorPriceKey = productPriceCellKey(plainProduct.productId);
      const reviewerDayKey = productDayCellKey(espressoProduct.productId, 5);
      const butterPackPriceKey = supplyFieldCellKey(
        butterBefore.id,
        "packPriceMajor",
      );
      await Promise.all([
        authorRoom.submit(
          "author-multiplayer-1",
          authorRoom.setCells([
            { cellKey: authorPriceKey, value: "580" },
            { cellKey: OVERHEAD_LABOR_CELL_KEY, value: "19500" },
            { cellKey: SCENARIO_CHANNEL_FEE_CELL_KEY, value: "350" },
          ]),
        ),
        reviewerRoom.submit(
          "reviewer-multiplayer-1",
          reviewerRoom.setCells([
            { cellKey: reviewerDayKey, value: "48" },
            { cellKey: butterPackPriceKey, value: "1590" },
          ]),
        ),
      ]);

      const expectedConcurrentCells = {
        [authorPriceKey]: "580",
        [OVERHEAD_LABOR_CELL_KEY]: "19500",
        [SCENARIO_CHANNEL_FEE_CELL_KEY]: "350",
        [reviewerDayKey]: "48",
        [butterPackPriceKey]: "1590",
        // The agent's plan save stamped the sheet while it was open.
        [META_SAVED_AT_CELL_KEY]: expect.any(String),
      };
      for (const room of [authorRoom, reviewerRoom, viewerRoom]) {
        await expect.poll(() => room.cells()).toEqual(expectedConcurrentCells);
      }

      const snapshotResp = await exports.default.fetch(sheetHttpUrl, {
        headers: controlReadHeaders(viewer.session),
      });
      expect(snapshotResp.status).toBe(200);
      const snapshotJson: unknown = await snapshotResp.json();
      expect(snapshotJson).toMatchObject({
        ok: true,
        value: {
          documentId: "costs-sheet",
          generation: 1,
        },
      });

      // Chat agent costs_sheet_edit holds at private-chat -> shared-draft IFC exit,
      // then broadcasts live agent cell cursor + Yjs update once approved.
      const plainSpoilKey = productSpoilCellKey(plainProduct.productId);
      const plainCogsKey = productCogsCellKey(plainProduct.productId);
      const plainWasteKey = productWasteCellKey(plainProduct.productId);
      const plainCogsFxKey = productFormulaCellKey(
        plainProduct.productId,
        "cogs",
      );
      const espressoPriceFxKey = productFormulaCellKey(
        espressoProduct.productId,
        "price",
      );
      journey.editSheetArgs = {
        changes: [
          { cellKey: OVERHEAD_RENT_CELL_KEY, value: "12500" },
          { cellKey: plainSpoilKey, value: "500" },
          { cellKey: plainCogsKey, value: "98" },
          { cellKey: plainWasteKey, value: "14" },
          { cellKey: plainCogsFxKey, value: "= ROUND(BOM * 0.9, 0)" },
          {
            cellKey: espressoPriceFxKey,
            value: "= CEIL(COGS / (1 - 65% - TAX_RATE - FEE_RATE))",
          },
        ],
      };
      await chatDirect(fixture, author, "EDITSHEET");
      expect(lastOutput("EDITSHEET")).toContain(STOPPED);
      expect(authorRoom.cells()[OVERHEAD_RENT_CELL_KEY]).toBeUndefined();

      await allowHeldStep(fixture);
      await chatDirect(fixture, author, "EDITSHEET");
      expect(lastOutput("EDITSHEET")).toContain("costs-sheet");

      const expectedAfterAgentCells = {
        ...expectedConcurrentCells,
        [OVERHEAD_RENT_CELL_KEY]: "12500",
        [plainSpoilKey]: "500",
        [plainCogsKey]: "98",
        [plainWasteKey]: "14",
        [plainCogsFxKey]: "= ROUND(BOM * 0.9, 0)",
        [espressoPriceFxKey]: "= CEIL(COGS / (1 - 65% - TAX_RATE - FEE_RATE))",
      };
      for (const room of [authorRoom, reviewerRoom, viewerRoom]) {
        await expect.poll(() => room.cells()).toEqual(expectedAfterAgentCells);
      }

      // costs_read surfaces non-empty draftCells from the multiplayer room.
      await chatDirect(fixture, author, "READCOSTS");
      expect(lastOutput("READCOSTS")).toContain("draftCells");
      expect(lastOutput("READCOSTS")).toContain(OVERHEAD_RENT_CELL_KEY);

      // Authoritative Save changes commits Offer price + D1 cost plan (including
      // COGS/Waste overrides and `=...` formulas) + supply pack price,
      // clears committed draft cells across open sockets, preserves scenario:channelFeeBps,
      // and stamps meta:savedAt so remote tabs reload baseline overview.
      const preSettleOverview = await readPortalCosts(
        author,
        paths.organisation,
      );
      const plainPreSettle = preSettleOverview.products.find(
        (product) => product.productId === plainProduct.productId,
      );
      const butterPreSettle = preSettleOverview.items.find(
        (item) => item.id === butterBefore.id,
      );
      if (
        plainPreSettle === undefined ||
        butterPreSettle === undefined ||
        butterPreSettle.costTerms === null
      ) {
        throw new Error("Missing pre-settle product or butter supply");
      }

      const settleSaveResp = await fetchCosts(
        author,
        paths.organisation,
        "POST",
        {
          kind: "save_sheet",
          merchantRevision: preSettleOverview.merchantRevision,
          requestedAt: new Date().toISOString(),
          priceWrites: [
            {
              offerId: plainPreSettle.offerId,
              expectedOfferRevision: plainPreSettle.offerRevision,
              currency: "JPY",
              priceMinor: 580,
            },
          ],
          planWrite: {
            expectedPlanRevision: preSettleOverview.costPlan.revision,
            dailyLaborMinor: 19_500,
            dailyRentMinor: 12_500,
            products: [
              {
                productId: plainProduct.productId,
                weekUnits: [24, 24, 24, 24, 36, 48, 44],
                spoilBps: 500,
                cogsOverrideMinor: 98,
                wasteOverrideMinor: 14,
                formulas: {
                  cogs: "= ROUND(BOM * 0.9, 0)",
                },
              },
              {
                productId: espressoProduct.productId,
                weekUnits: [18, 18, 20, 20, 25, 48, 31],
                spoilBps: null,
                formulas: {
                  price: "= CEIL(COGS / (1 - 65% - TAX_RATE - FEE_RATE))",
                },
              },
            ],
          },
          supplyWrites: [
            {
              inventoryItemId: butterPreSettle.id,
              expectedEntryRevision: butterPreSettle.costTerms.entryRevision,
              currency: "JPY",
              packQuantity: butterPreSettle.costTerms.packQuantity,
              packUnit: butterPreSettle.costTerms.packUnit,
              packPriceMinor: 1_590,
              supplierId: butterPreSettle.costTerms.supplierId,
              bulkTier: butterPreSettle.costTerms.bulkTier,
              notes: "Multiplayer workbook committed contract",
            },
          ],
        },
      );
      expect(
        settleSaveResp.status,
        await settleSaveResp.clone().text(),
      ).toBe(200);

      // Verify persisted regional D1 overrides & Excel-style formulas evaluate in calculateBakeryCostsAndMargins,
      // and verify two-way solvers (Unit net -> Price, Net / day -> Units / d).
      const postSettleOverview = await readPortalCosts(
        author,
        paths.organisation,
      );
      const savedPlainPlan = postSettleOverview.costPlan.products.find(
        (entry) => entry.productId === plainProduct.productId,
      );
      expect(savedPlainPlan).toEqual({
        productId: plainProduct.productId,
        weekUnits: [24, 24, 24, 24, 36, 48, 44],
        spoilBps: 500,
        cogsOverrideMinor: 98,
        wasteOverrideMinor: 14,
        formulas: {
          cogs: "= ROUND(BOM * 0.9, 0)",
        },
      });
      const postSettleCalc = calculateBakeryCostsAndMargins({
        overview: postSettleOverview,
        assumptions: defaultCostAssumptions(postSettleOverview),
      });
      const postPlainRow = postSettleCalc.products.find(
        (row) => row.productId === plainProduct.productId,
      );
      const postEspressoRow = postSettleCalc.products.find(
        (row) => row.productId === espressoProduct.productId,
      );
      if (postPlainRow === undefined || postEspressoRow === undefined) {
        throw new Error("Missing post-settle calculated rows");
      }
      expect(postPlainRow.effectiveCogsUnitMinor).toBe(
        Math.round(postPlainRow.bomUnitCostMinor * 0.9),
      );
      expect(postPlainRow.wasteAndSurplusUnitMinor).toBe(14);
      expect(postPlainRow.activeFormulas.cogs).toBe("= ROUND(BOM * 0.9, 0)");
      expect(postEspressoRow.activeFormulas.price).toBe(
        "= CEIL(COGS / (1 - 65% - TAX_RATE - FEE_RATE))",
      );
      expect(postEspressoRow.netMarginPct).toBeGreaterThanOrEqual(62);

      const solvedPriceFromUnitNet = backSolveGrossPriceMinorForUnitNet({
        fixedUnitCostMinor:
          postPlainRow.effectiveCogsUnitMinor +
          postPlainRow.wasteAndSurplusUnitMinor,
        includedTaxBps: 800,
        channelFeeBps: 325,
        targetUnitNetMinor: 250,
      });
      expect(solvedPriceFromUnitNet).toBeGreaterThan(350);
      const solvedUnitsFromNetDay = backSolveDailyUnitsForNetDay({
        targetDailyNetMinor: 15_000,
        unitNetContributionMinor: postPlainRow.netContributionUnitMinor,
      });
      expect(solvedUnitsFromNetDay).toBe(
        Math.ceil(15_000 / postPlainRow.netContributionUnitMinor),
      );

      for (const room of [authorRoom, reviewerRoom]) {
        await expect
          .poll(() => {
            const cells = room.cells();
            return {
              channelFee: cells[SCENARIO_CHANNEL_FEE_CELL_KEY] ?? null,
              hasSavedAt: typeof cells[META_SAVED_AT_CELL_KEY] === "string",
              keyCount: Object.keys(cells).length,
            };
          })
          .toEqual({
            channelFee: "350",
            hasSavedAt: true,
            keyCount: 2,
          });
      }

      // Reset route refuses viewer (404) and clears remaining scenario draft cells for editors.
      const viewerReset = await exports.default.fetch(sheetResetUrl, {
        method: "POST",
        headers: commerceHeaders(viewer.session),
      });
      expect(viewerReset.status).toBe(404);

      const reviewerReset = await exports.default.fetch(sheetResetUrl, {
        method: "POST",
        headers: commerceHeaders(reviewer.session),
      });
      expect(
        reviewerReset.status,
        await reviewerReset.clone().text(),
      ).toBe(200);

      for (const room of [authorRoom, reviewerRoom, viewerRoom]) {
        await expect
          .poll(() => Object.keys(room.cells()))
          .toEqual([META_SAVED_AT_CELL_KEY]);
      }

      // Viewer cannot mutate the shared Yjs workbook over WebSocket.
      viewerRoomRefusal = await viewerRoom.refused(
        "viewer-forbidden-edit",
        viewerRoom.setCells([
          { cellKey: OVERHEAD_LABOR_CELL_KEY, value: "99999" },
        ]),
      );
      expect(viewerRoomRefusal).toBe("access_revoked");
      expect(Object.keys(authorRoom.cells())).toEqual([META_SAVED_AT_CELL_KEY]);

      storedSheets = await runInDurableObject(
        fixture.organisation,
        (_actor: unknown, durable: DurableObjectState) =>
          durable.storage.sql
            .exec(
              "SELECT singleton_id, generation, revision FROM costs_sheet_draft",
            )
            .toArray(),
      );
      expect(storedSheets).toEqual([
        {
          singleton_id: "costs-sheet",
          generation: 1,
          revision: expect.any(Number),
        },
      ]);
    } finally {
      await Promise.all([
        authorRoom.close(),
        reviewerRoom.close(),
        viewerRoom.close(),
      ]);
    }

    // 6. Phase 5: Lot costs from purchase invoices (HTTP save_lot_cost, save_sheet lotWrites,
    //    FIFO & weighted-average lot valuation, and chat agent lot_cost_save + costs_read).
    const stockForLots = await native.readStockSnapshot(MERCHANT_ID);
    if (!stockForLots.ok) {
      throw new Error("Stock snapshot for lot costs unavailable");
    }
    const butterItem = stockForLots.value.commerce.resources.inventoryItems.find(
      (item) => item.id === "inventory_cultured_butter",
    );
    const butterPosition =
      stockForLots.value.commerce.resources.inventoryPositions.find(
        (pos) => pos.inventoryItemId === "inventory_cultured_butter",
      );
    if (butterItem === undefined || butterPosition === undefined) {
      throw new Error("Missing cultured butter item or position for lot costs");
    }
    const secondLotReceipt = await native.receiveInventory({
      merchantId: MERCHANT_ID,
      expectedMerchantRevision: stockForLots.value.commerce.merchantRevision,
      idempotencyKey: "costs_e2e_butter_lot_2",
      purchase: { kind: "unlinked" },
      receiptId: "receipt_butter_lot_2",
      receiptLineId: "receipt_line_butter_lot_2",
      inventoryItemId: butterItem.id,
      inventoryItemRevision: butterItem.revision,
      inventoryPositionId: butterPosition.id,
      inventoryPositionRevision: butterPosition.revision,
      locationId: butterPosition.locationId,
      receivedQuantity: { amount: 1_000, scale: 0, unit: "gram" },
      lot: {
        kind: "tracked",
        lotId: "lot_butter_invoice_2",
        lotCode: "BUTTER-INV-2",
        expiry: {
          kind: "expires",
          expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
        },
      },
      receivedAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    expect(secondLotReceipt, JSON.stringify(secondLotReceipt)).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });

    const overviewBeforeLotInvoices = await readPortalCosts(
      author,
      paths.organisation,
    );
    const butterLotsBefore = (overviewBeforeLotInvoices.lots ?? []).filter(
      (lot) =>
        lot.inventoryItemId === "inventory_cultured_butter" &&
        lot.lifecycle === "active",
    );
    expect(butterLotsBefore).toHaveLength(2);
    const [butterLot1, butterLot2] = butterLotsBefore;
    if (butterLot1 === undefined || butterLot2 === undefined) {
      throw new Error("Expected two active cultured butter lots");
    }
    expect(butterLot2.id).toBe("lot_butter_invoice_2");
    expect(butterLot1.invoiceCost).toBeNull();
    expect(butterLot2.invoiceCost).toBeNull();

    // Save Lot 1 purchase invoice cost via HTTP save_lot_cost: ¥1,350 for 450g (3.00 ¥/g).
    const lot1SavePayload = {
      kind: "save_lot_cost" as const,
      merchantRevision: overviewBeforeLotInvoices.merchantRevision,
      requestedAt: new Date().toISOString(),
      lotId: butterLot1.id,
      inventoryItemId: "inventory_cultured_butter",
      expectedRevision: null,
      currency: "JPY",
      invoicedQuantity: 450,
      invoicedUnit: "gram" as const,
      invoiceTotalMinor: 1_350,
      invoiceReference: "INV-2026-B1",
      supplierId: "sup_takanashi",
    };
    const lot1SaveResp = await fetchCosts(
      author,
      paths.organisation,
      "POST",
      lot1SavePayload,
      "costs-lot-1-save",
    );
    expect(lot1SaveResp.status, await lot1SaveResp.clone().text()).toBe(200);
    expect(await lot1SaveResp.json()).toMatchObject({
      ok: true,
      lotId: butterLot1.id,
      revision: 1,
    });

    // Idempotent replay with expectedRevision: null returns 200 and revision 1.
    const lot1ReplayResp = await fetchCosts(
      author,
      paths.organisation,
      "POST",
      lot1SavePayload,
    );
    expect(lot1ReplayResp.status).toBe(200);

    // Stale expectedRevision: null with different invoiceTotalMinor returns 409.
    const lot1StaleResp = await fetchCosts(author, paths.organisation, "POST", {
      ...lot1SavePayload,
      invoiceTotalMinor: 1_500,
    });
    expect(lot1StaleResp.status).toBe(409);

    // Save Lot 2 purchase invoice cost via HTTP save_sheet lotWrites: ¥1,800 for 450g (4.00 ¥/g).
    const lot2SheetResp = await fetchCosts(author, paths.organisation, "POST", {
      kind: "save_sheet",
      merchantRevision: overviewBeforeLotInvoices.merchantRevision,
      requestedAt: new Date().toISOString(),
      priceWrites: [],
      planWrite: null,
      supplyWrites: [],
      lotWrites: [
        {
          lotId: butterLot2.id,
          inventoryItemId: "inventory_cultured_butter",
          expectedRevision: null,
          currency: "JPY",
          invoicedQuantity: 450,
          invoicedUnit: "gram",
          invoiceTotalMinor: 1_800,
          invoiceReference: "INV-2026-B2",
          supplierId: "sup_takanashi",
        },
      ],
    });
    expect(lot2SheetResp.status, await lot2SheetResp.clone().text()).toBe(200);
    expect(parseCostsSheetWriteResult(await lot2SheetResp.json())).toMatchObject({
      ok: true,
      updatedLotCount: 1,
    });

    const overviewWithLotInvoices = await readPortalCosts(
      author,
      paths.organisation,
    );
    const lowUsageDailyTargets: Record<string, number> = {};
    for (const prod of overviewWithLotInvoices.products) {
      lowUsageDailyTargets[prod.productId] = 0;
    }
    for (const rec of overviewWithLotInvoices.recipes) {
      lowUsageDailyTargets[rec.recipeId] = 0;
    }
    const standingNoBulkCalc = calculateBakeryCostsAndMargins({
      overview: overviewWithLotInvoices,
      dailyTargets: lowUsageDailyTargets,
      assumptions: {
        ...defaultCostAssumptions(overviewWithLotInvoices),
        applyBulkTiers: false,
        lotCostBasis: "standing",
      },
    });
    const fifoLotCalc = calculateBakeryCostsAndMargins({
      overview: overviewWithLotInvoices,
      dailyTargets: lowUsageDailyTargets,
      assumptions: {
        ...defaultCostAssumptions(overviewWithLotInvoices),
        applyBulkTiers: false,
        lotCostBasis: "fifo_lot",
      },
    });
    const weightedLotCalc = calculateBakeryCostsAndMargins({
      overview: overviewWithLotInvoices,
      dailyTargets: lowUsageDailyTargets,
      assumptions: {
        ...defaultCostAssumptions(overviewWithLotInvoices),
        applyBulkTiers: false,
        lotCostBasis: "weighted_lot",
      },
    });

    const butterStanding = standingNoBulkCalc.supplies.find(
      (s) => s.inventoryItemId === "inventory_cultured_butter",
    );
    const butterFifo = fifoLotCalc.supplies.find(
      (s) => s.inventoryItemId === "inventory_cultured_butter",
    );
    const butterWeighted = weightedLotCalc.supplies.find(
      (s) => s.inventoryItemId === "inventory_cultured_butter",
    );
    expect(butterStanding).toMatchObject({
      costSource: "standing_pack",
      activeLotCount: 2,
      pricedLotCount: 2,
    });
    expect(butterStanding?.effectiveCostPerBaseUnitMinor).toBeCloseTo(
      1_590 / 450,
      4,
    );
    expect(butterFifo).toMatchObject({
      costSource: "fifo_lot",
      activeLotCount: 2,
      pricedLotCount: 2,
      effectiveCostPerBaseUnitMinor: 3,
      fifoEquivalentPackPriceMinor: 1_350,
    });
    expect(butterWeighted?.costSource).toBe("weighted_lot");
    expect(butterWeighted?.effectiveCostPerBaseUnitMinor).toBeGreaterThan(3);
    expect(butterWeighted?.effectiveCostPerBaseUnitMinor).toBeLessThan(4);
    expect(butterWeighted?.weightedEquivalentPackPriceMinor).toBeGreaterThan(1_350);
    expect(butterWeighted?.lotCostVariancePct).not.toBeNull();

    // Active weekly demand with FIFO lot invoices propagates lot basis into BOM lines & 7d variance impact.
    const fifoActiveDemandCalc = calculateBakeryCostsAndMargins({
      overview: overviewWithLotInvoices,
      demandMode: "weekly",
      assumptions: {
        ...defaultCostAssumptions(overviewWithLotInvoices),
        applyBulkTiers: false,
        lotCostBasis: "fifo_lot",
      },
    });
    const butterFifoActive = fifoActiveDemandCalc.supplies.find(
      (s) => s.inventoryItemId === "inventory_cultured_butter",
    );
    expect(butterFifoActive?.weeklyLotVarianceImpactMinor).not.toBeNull();
    const plainFifoRow = fifoActiveDemandCalc.products.find(
      (row) => row.productId === plainProduct.productId,
    );
    expect(
      plainFifoRow?.bomLines.find(
        (line) => line.inventoryItemId === "inventory_cultured_butter",
      )?.costSource,
    ).toBe("fifo_lot");

    // Chat agent lot_cost_save (holds at exit, commits revision 2 with receipt, refuses stale)
    // and costs_read with lotCostBasis: "fifo_lot".
    journey.saveLotArgs = {
      lotId: butterLot1.id,
      inventoryItemId: "inventory_cultured_butter",
      expectedRevision: 1,
      currency: "JPY",
      invoicedQuantity: 450,
      invoicedUnit: "gram",
      invoiceTotalMinor: 1_440,
      invoiceReference: "INV-2026-B1-REV",
      supplierId: "sup_takanashi",
    };
    await chatDirect(fixture, author, "SAVELOTCOST");
    expect(lastOutput("SAVELOTCOST")).toContain(STOPPED);
    await allowHeldStep(fixture);
    await chatDirect(fixture, author, "SAVELOTCOST");
    expect(lastOutput("SAVELOTCOST")).toContain("receiptId");

    journey.staleLotArgs = {
      ...journey.saveLotArgs,
      expectedRevision: 1,
      invoiceTotalMinor: 1_530,
    };
    await chatApproved(fixture, "STALELOTCOST");
    expect(lastOutput("STALELOTCOST")).toContain("changed after you read it");

    await chatDirect(fixture, author, "FIFOCOSTS");
    const fifoAgentText = lastOutput("FIFOCOSTS");
    expect(fifoAgentText).not.toContain("Output truncated");
    expect(fifoAgentText).toContain("fifo_lot");
    expect(fifoAgentText).toContain("INV-2026-B1-REV");
    expect(fifoAgentText).toContain("lot_butter_invoice_2");
    expect(fifoAgentText).toContain("weeklyLotVarianceImpactMinor");

    // 7. Plan vs Actuals & Margin Variance Bridge (Phase 7):
    //    Before buyer orders exist, comparisonMode is "costs_and_waste_only"
    //    attributing butter invoice hikes and financier batch/shelf waste cleanly.
    const overviewBeforeOrders = await readPortalCosts(
      author,
      paths.organisation,
    );
    const preOrderActuals = calculateBakeryPlanVsActuals({
      overview: overviewBeforeOrders,
      windowDays: 7,
    });
    expect(preOrderActuals.summary.comparisonMode).toBe("costs_and_waste_only");
    expect(preOrderActuals.summary.orderCount).toBe(0);
    expect(
      preOrderActuals.drivers.some((driver) => driver.kind === "lot_invoice"),
    ).toBe(true);
    expect(
      preOrderActuals.drivers.some((driver) => driver.kind === "product_waste"),
    ).toBe(true);

    //    Place paid buyer pickup orders on storefront_cafe and record a real
    //    ceremonial matcha bar over-portion/spill waste movement.
    const matchaLatteItem = PATISSERIE_ITEMS.find(
      (entry) => entry.title === "Matcha latte",
    );
    const hotcakeItem = PATISSERIE_ITEMS.find(
      (entry) => entry.slug === "hotcake_financier",
    );
    if (matchaLatteItem === undefined || hotcakeItem === undefined) {
      throw new Error("Missing Matcha latte or Hotcake financier definition");
    }
    const matchaLatteProductId = `product_patisserie_${matchaLatteItem.slug}`;
    const hotcakeProductId = `product_patisserie_${hotcakeItem.slug}`;

    const placedOrderId1 = await placePatisserieBuyerOrder(storefront, [
      { slug: sesameItem.slug, quantity: 6 },
      { slug: matchaLatteItem.slug, quantity: 5 },
    ]);
    const placedOrderId2 = await placePatisserieBuyerOrder(storefront, [
      { slug: hotcakeItem.slug, quantity: 4 },
      { slug: matchaLatteItem.slug, quantity: 3 },
    ]);
    expect(placedOrderId1.length).toBeGreaterThan(0);
    expect(placedOrderId2.length).toBeGreaterThan(0);

    await recordSupplyWasteMovement(native, "inventory_matcha_powder", 35);

    const overviewWithActuals = await readPortalCosts(
      author,
      paths.organisation,
    );
    const window7d = overviewWithActuals.actuals?.windows.find(
      (entry) => entry.windowDays === 7,
    );
    const window30d = overviewWithActuals.actuals?.windows.find(
      (entry) => entry.windowDays === 30,
    );
    expect(window7d).toBeDefined();
    expect(window30d).toBeDefined();
    expect(window7d?.orderCount).toBe(2);
    expect(window7d?.onlineOrderCount).toBe(2);
    expect(window7d?.grossSalesMinor ?? 0).toBeGreaterThan(0);
    expect(window7d?.includedTaxMinor ?? 0).toBeGreaterThan(0);
    expect(
      window7d?.supplyLosses.find(
        (loss) => loss.inventoryItemId === "inventory_matcha_powder",
      ),
    ).toMatchObject({
      inventoryItemId: "inventory_matcha_powder",
      movementCount: 1,
      wastedBaseQuantity: 35,
    });

    const actuals7d = calculateBakeryPlanVsActuals({
      overview: overviewWithActuals,
      windowDays: 7,
    });
    expect(actuals7d.summary.comparisonMode).toBe("orders_and_costs");
    expect(actuals7d.summary.orderCount).toBe(2);
    expect(actuals7d.summary.actualUnitsSold).toBe(18);
    expect(actuals7d.summary.supplyLossMinor).toBeGreaterThan(0);
    expect(actuals7d.summary.actualWasteMinor).toBeGreaterThan(0);

    const sesameActualRow = actuals7d.products.find(
      (row) => row.productId === sesameProductId,
    );
    const matchaActualRow = actuals7d.products.find(
      (row) => row.productId === matchaLatteProductId,
    );
    const hotcakeActualRow = actuals7d.products.find(
      (row) => row.productId === hotcakeProductId,
    );
    expect(sesameActualRow?.actualUnitsSold).toBe(6);
    expect(sesameActualRow?.plannedBatchUnits).toBe(24);
    expect(sesameActualRow?.actualBatchUnits).toBe(22);
    expect(sesameActualRow?.stockedUnitsWasted).toBe(3);
    expect(sesameActualRow?.actualUnitCogsMinor ?? 0).toBeGreaterThan(
      sesameActualRow?.theoreticalUnitCogsMinor ?? 0,
    );
    expect(matchaActualRow?.actualUnitsSold).toBe(8);
    expect(matchaActualRow?.allocatedSupplyLossMinor ?? 0).toBeGreaterThan(0);
    expect(hotcakeActualRow?.actualUnitsSold).toBe(4);
    expect(
      actuals7d.drivers.some(
        (driver) =>
          driver.kind === "supply_loss" &&
          driver.inventoryItemId === "inventory_matcha_powder",
      ),
    ).toBe(true);
    expect(
      actuals7d.drivers.some(
        (driver) =>
          driver.kind === "lot_invoice" &&
          driver.inventoryItemId === "inventory_cultured_butter",
      ),
    ).toBe(true);

    //    Chat agent costs_read({ actualsWindowDays: 7 }) gates on "Read customer orders",
    //    admits order report observations, and returns compact margin bridge + rows.
    const actualsReadPrompt = await chatThrough(
      fixture,
      author,
      "ACTUALSCOSTS",
      {
        action: "Read customer orders",
      },
    );
    const actualsAgentText = lastOutput("ACTUALSCOSTS");
    expect(actualsAgentText).not.toContain("Output truncated");
    expect(actualsAgentText).toContain("orders_and_costs");
    expect(actualsAgentText).toContain("supply_loss:inventory_matcha_powder");
    expect(actualsAgentText).toContain("lot_invoice:inventory_cultured_butter");
    expect(actualsAgentText).toContain(matchaLatteProductId);

    // 8. Plan 86 Phase 8 (Layer 3): 12-week rolling P&L, cash runway, step labor,
    //    organic peak bulk-tier unlocks, supplier payment terms, and capex payback.
    const forecastHoliday = calculateBakery12WeekForecast({
      overview: overviewWithActuals,
      forecastPlan: {
        openingCashMinor: 6_400_000,
        demandCurve: "seasonal_holiday",
        supplierTerms: "net_30",
        extraShiftThresholdPct: 125,
        extraShiftWeeklyMinor: 116_000,
        capexMinor: 600_000,
      },
      startDateIso: "2026-11-10T00:00:00.000Z",
    });
    expect(forecastHoliday.weeks).toHaveLength(12);
    expect(forecastHoliday.summary.peakDemandWeekCode).toBe("W6");
    expect(forecastHoliday.summary.peakDemandIndexPct).toBe(142);
    expect(forecastHoliday.summary.extraShiftWeeksCount).toBe(2);
    expect(forecastHoliday.weeks[4]?.extraShiftActive).toBe(true);
    expect(forecastHoliday.weeks[5]?.extraShiftActive).toBe(true);
    expect(forecastHoliday.weeks[0]?.extraShiftActive).toBe(false);
    expect(
      forecastHoliday.weeks[5]?.unlockedBulkTierCount ?? 0,
    ).toBeGreaterThanOrEqual(
      forecastHoliday.weeks[0]?.unlockedBulkTierCount ?? 0,
    );
    expect(forecastHoliday.weeks[0]?.capexCashOutMinor).toBe(600_000);
    expect(forecastHoliday.weeks[1]?.capexCashOutMinor).toBe(0);
    // Monthly rent settles on W3 (w=2), W7 (w=6), W11 (w=10) totalling 12w accrual rent.
    expect(forecastHoliday.weeks[0]?.rentCashOutMinor).toBe(0);
    expect(forecastHoliday.weeks[2]?.rentCashOutMinor).toBeGreaterThan(0);
    const totalRentCashPaid = forecastHoliday.weeks.reduce(
      (sum, wk) => sum + wk.rentCashOutMinor,
      0,
    );
    expect(totalRentCashPaid).toBe(forecastHoliday.summary.totalAccrualRentMinor);
    expect(forecastHoliday.summary.capexPaybackWeeks).not.toBeNull();
    expect(forecastHoliday.summary.endingPayablesBalanceMinor).toBeGreaterThan(0);

    const forecastCod = calculateBakery12WeekForecast({
      overview: overviewWithActuals,
      forecastPlan: {
        openingCashMinor: 6_400_000,
        demandCurve: "seasonal_holiday",
        supplierTerms: "cod",
        extraShiftThresholdPct: 125,
        extraShiftWeeklyMinor: 116_000,
        capexMinor: 600_000,
      },
      startDateIso: "2026-11-10T00:00:00.000Z",
    });
    expect(forecastCod.weeks[0]?.supplierCashOutMinor).toBeGreaterThan(0);
    expect(forecastHoliday.weeks[0]?.supplierCashOutMinor).toBe(0);
    expect(forecastHoliday.weeks[2]?.supplierCashOutMinor).toBeGreaterThan(
      forecastCod.weeks[2]?.supplierCashOutMinor ?? 0,
    );
    expect(forecastCod.summary.endingPayablesBalanceMinor).toBe(0);

    //    8b. Multiplayer CRDT sync for forecast cells + HTTP save_sheet persistence & settlement.
    const ownerForecastRoom = new CostsSheetRoomClient(
      await openSocket(
        `https://localhost${paths.organisation}/commerce/costs/sheet/socket`,
        author.session,
      ),
    );
    const reviewerForecastRoom = new CostsSheetRoomClient(
      await openSocket(
        `https://localhost${paths.organisation}/commerce/costs/sheet/socket`,
        reviewer.session,
      ),
    );
    try {
      await ownerForecastRoom.sync();
      await reviewerForecastRoom.sync();

      ownerForecastRoom.sendPresence("editing", {
        sheet: "forecast",
        cellKey: forecastWeekIndexCellKey(4),
      });
      await expect
        .poll(
          () =>
            reviewerForecastRoom.participants.find(
              (p) => p.userId === author.userId,
            )?.selection,
        )
        .toEqual({
          sheet: "forecast",
          cellKey: forecastWeekIndexCellKey(4),
        });

      await ownerForecastRoom.submit(
        "author-forecast-1",
        ownerForecastRoom.setCells([
          { cellKey: FORECAST_OPENING_CASH_CELL_KEY, value: "5800000" },
          { cellKey: FORECAST_SUPPLIER_TERMS_CELL_KEY, value: "net_15" },
          { cellKey: FORECAST_CAPEX_MINOR_CELL_KEY, value: "950000" },
          { cellKey: forecastWeekIndexCellKey(4), value: "140" },
        ]),
      );

      await expect
        .poll(() => ({
          opening: reviewerForecastRoom.cells()[FORECAST_OPENING_CASH_CELL_KEY],
          terms: reviewerForecastRoom.cells()[FORECAST_SUPPLIER_TERMS_CELL_KEY],
          capex: reviewerForecastRoom.cells()[FORECAST_CAPEX_MINOR_CELL_KEY],
          w5: reviewerForecastRoom.cells()[forecastWeekIndexCellKey(4)],
        }))
        .toEqual({
          opening: "5800000",
          terms: "net_15",
          capex: "950000",
          w5: "140",
        });

      const beforeForecastHttpSave = await readPortalCosts(
        author,
        paths.organisation,
      );
      const customWeeks = [...presetDemandCurveValues("seasonal_holiday")] as [
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
      ];
      customWeeks[4] = 140;

      const saveForecastSheetBody: CostsSheetWrite = {
        kind: "save_sheet",
        merchantRevision: beforeForecastHttpSave.merchantRevision,
        requestedAt: new Date().toISOString(),
        planWrite: {
          expectedPlanRevision: beforeForecastHttpSave.costPlan.revision,
          dailyLaborMinor: beforeForecastHttpSave.costPlan.dailyLaborMinor,
          dailyRentMinor: beforeForecastHttpSave.costPlan.dailyRentMinor,
          products: beforeForecastHttpSave.costPlan.products,
          forecast: {
            openingCashMinor: 5_800_000,
            demandCurve: "custom",
            weekDemandPct: customWeeks,
            supplierTerms: "net_15",
            extraShiftThresholdPct: 125,
            extraShiftWeeklyMinor: 116_000,
            capexMinor: 950_000,
          },
        },
        priceWrites: [],
        supplyWrites: [],
      };
      const forecastSheetResp = await fetchCosts(
        author,
        paths.organisation,
        "POST",
        saveForecastSheetBody,
        "costs_e2e_forecast_save_sheet",
      );
      expect(
        forecastSheetResp.status,
        await forecastSheetResp.clone().text(),
      ).toBe(200);
      const forecastSheetResult = parseCostsSheetWriteResult(
        await forecastSheetResp.json(),
      );
      expect(forecastSheetResult.planRevision).toBe(
        (beforeForecastHttpSave.costPlan.revision ?? 0) + 1,
      );

      // Forecast CRDT draft cells settle on save.
      await expect
        .poll(() => ({
          opening: reviewerForecastRoom.cells()[FORECAST_OPENING_CASH_CELL_KEY],
          terms: reviewerForecastRoom.cells()[FORECAST_SUPPLIER_TERMS_CELL_KEY],
          capex: reviewerForecastRoom.cells()[FORECAST_CAPEX_MINOR_CELL_KEY],
          w5: reviewerForecastRoom.cells()[forecastWeekIndexCellKey(4)],
        }))
        .toEqual({
          opening: undefined,
          terms: undefined,
          capex: undefined,
          w5: undefined,
        });
    } finally {
      await ownerForecastRoom.close();
      await reviewerForecastRoom.close();
    }

    const afterForecastHttpSave = await readPortalCosts(
      author,
      paths.organisation,
    );
    expect(afterForecastHttpSave.costPlan.forecast).toEqual({
      openingCashMinor: 5_800_000,
      demandCurve: "custom",
      weekDemandPct: [100, 103, 105, 118, 140, 142, 86, 98, 100, 102, 108, 120],
      supplierTerms: "net_15",
      extraShiftThresholdPct: 125,
      extraShiftWeeklyMinor: 116_000,
      capexMinor: 950_000,
    });

    //    8c. Chat agent costs_read({ forecast }) + costs_plan_save({ forecast }) parity.
    await chatDirect(fixture, author, "FORECASTCOSTS");
    const forecastAgentText = lastOutput("FORECASTCOSTS");
    expect(forecastAgentText).not.toContain("Output truncated");
    expect(forecastAgentText).toContain("seasonal_holiday");
    expect(forecastAgentText).toContain("lowestCashMinor");
    expect(forecastAgentText).toContain("capexPaybackWeeks");
    const forecastAgentOuter: unknown = JSON.parse(forecastAgentText);
    const forecastAgentBody: unknown =
      typeof forecastAgentOuter === "string"
        ? JSON.parse(forecastAgentOuter)
        : forecastAgentOuter;
    expect(isRecord(forecastAgentBody)).toBe(true);
    if (
      isRecord(forecastAgentBody) &&
      isRecord(forecastAgentBody.code_mode_value) &&
      isRecord(forecastAgentBody.code_mode_value.forecast) &&
      Array.isArray(forecastAgentBody.code_mode_value.forecast.weeks)
    ) {
      expect(forecastAgentBody.code_mode_value.forecast.weeks).toHaveLength(12);
      expect(forecastAgentBody.code_mode_value.forecast.weeks[4]).toMatchObject({
        weekCode: "W5",
        demandIndexPct: 135,
        extraShiftActive: true,
      });
    } else {
      throw new Error(`Missing forecast payload in costs_read: ${forecastAgentText}`);
    }

    journey.savePlanArgs = {
      expectedPlanRevision: afterForecastHttpSave.costPlan.revision,
      dailyLaborMinor: null,
      dailyRentMinor: null,
      products: null,
      forecast: {
        openingCashMinor: 6_200_000,
        demandCurve: "growth_ramp",
        weekDemandPct: presetDemandCurveValues("growth_ramp"),
        supplierTerms: "net_30",
        extraShiftThresholdPct: 125,
        extraShiftWeeklyMinor: 116_000,
        capexMinor: 750_000,
      },
    };
    await chatApproved(fixture, "SAVEFORECASTPLAN");
    expect(lastOutput("SAVEFORECASTPLAN")).toContain("receiptId");
    const afterForecastAgentSave = await readPortalCosts(
      author,
      paths.organisation,
    );
    expect(afterForecastAgentSave.costPlan.forecast).toMatchObject({
      openingCashMinor: 6_200_000,
      demandCurve: "growth_ramp",
      supplierTerms: "net_30",
      capexMinor: 750_000,
    });

    const receipts = await agentReceipts(
      fixture,
      `${paths.organisation}/commerce/costs`,
    );
    expect(receipts).toEqual([
      { operation: "costs.plan.save", n: 2 },
      { operation: "lot_cost.save", n: 1 },
      { operation: "supply_cost.save", n: 1 },
    ]);

    for (const outputs of Object.values(journey.outputs)) {
      for (const text of outputs) {
        expect(text).not.toContain("access controls");
      }
    }

    task.meta.costsAndMarginsEvidence = {
      patisserieProductsCount: patisserieProducts.length,
      supplyCostsSeededCount: configured.supplyCostsSeeded,
      defaultIncludedTaxBps: initialOverview.defaultIncludedTaxBps,
      measuredWaste: initialOverview.measuredWaste,
      plainFinancierMath: {
        batchYield: plainRow.batchYield,
        batchesFor25Units: plainRow.batchesPerDay,
        producedUnits: plainRow.producedUnits,
        grossPriceMinor: plainRow.grossPriceMinor,
        includedTaxMinor: plainRow.includedTaxMinor,
        netExTaxPriceMinor: plainRow.netExTaxPriceMinor,
        unitCogsBeforeButterUpdateMinor: plainUnitCostBefore,
        unitCogsAfterButterUpdateMinor: plainRowAfterButter?.allInUnitCostMinor,
        solvedGrossPriceFor45PctMarginMinor: solvedGrossPriceMinor,
      },
      spreadsheetSheetSave: {
        ownerResult: firstSheetResult,
        weeklyOperatingProfitMinor:
          weeklySheetCalc.summary.dailyOperatingProfitMinor,
        breakEvenUnitsPerDay: weeklySheetCalc.summary.breakEvenUnitsPerDay,
        finalCostPlan: afterAgentPlanSave.costPlan,
      },
      bulkTiers: {
        unlockedBulkTierCount: withBulk.summary.unlockedBulkTierCount,
        dailyTierSavingsMinor: withBulk.summary.dailyTierSavingsMinor,
        dailySupplySpendWithBulkMinor: supplySpendWithBulk,
        dailySupplySpendWithoutBulkMinor: supplySpendWithoutBulk,
      },
      prompts: {
        readCostsAction: readPrompt.action,
        saveSupplyCostAction: savePrompt.action,
        readActualsAction: actualsReadPrompt.action,
      },
      planVsActuals7d: {
        orderIds: [placedOrderId1, placedOrderId2],
        summary: actuals7d.summary,
        drivers: actuals7d.drivers,
      },
      forecast12w: {
        holidaySummary: forecastHoliday.summary,
        codSummary: forecastCod.summary,
        savedForecastPlan: afterForecastAgentSave.costPlan.forecast,
      },
      agentReceipts: receipts,
      staleRefusal: lastOutput("STALESUPPLYCOST"),
      stalePlanRefusal: lastOutput("STALECOSTSPLAN"),
      wrongUnitRefusal: lastOutput("WRONGUNITSUPPLYCOST"),
      viewerRefusal: {
        viewerChatStatus: viewerChatAttempt.status,
        demotedTurnWorkKind: "failed",
        packPriceUnchangedMinor: almondAfterViewerAttempt?.costTerms?.packPriceMinor,
      },
      multiplayerWorkbook: {
        outsiderSocketStatus: outsiderSocketAttempt.status,
        badOriginSocketStatus: badOriginAttempt.status,
        viewerRoomRefusal,
        storedSheets,
      },
      modelRequests: journey.modelRequests,
    };
  },
);

async function recordPlainFinancierBatchAndWaste(
  native: ReturnType<typeof providerClient>,
  recipeId: string,
  now: Date,
): Promise<void> {
  const before = await native.readStockSnapshot(MERCHANT_ID);
  if (!before.ok) {throw new Error("Stock snapshot unavailable");}
  const recipe = before.value.foodService.resources.recipeRevisions.find(
    (entry) => entry.recipeId === recipeId,
  );
  if (recipe === undefined || recipe.output.kind !== "stocked") {
    throw new Error(`Missing stocked recipe ${recipeId}`);
  }
  const outputItemId = recipe.output.inventoryItemId;
  const yieldQty = recipe.output.yieldQuantity;
  const outputPosition = before.value.commerce.resources.inventoryPositions.find(
    (position) => position.inventoryItemId === outputItemId,
  );
  if (outputPosition === undefined) {
    throw new Error("Missing plain financier inventory position");
  }
  const scaleFactor = 10 ** yieldQty.scale;
  const actualYield = {
    ...yieldQty,
    amount: yieldQty.amount - 2 * scaleFactor,
  };
  const batch = await native.completeProductionBatch({
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: before.value.commerce.merchantRevision,
    idempotencyKey: "costs_e2e_plain_batch",
    productionBatchId: "batch_costs_plain_1",
    demand: { kind: "stock" },
    outputLotId: "lot_costs_plain_1",
    outputInventoryPositionId: outputPosition.id,
    recipeId: recipe.recipeId,
    recipeRevision: recipe.revision,
    stationId: "station_bakery",
    locationId: outputPosition.locationId,
    plannedYield: yieldQty,
    actualYield,
    outputLotCode: "COSTS-PLAIN-1",
    outputExpiresAt: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
    expectedInputPositionRevisions: recipe.inputs.map((input) => {
      const pos = before.value.commerce.resources.inventoryPositions.find(
        (candidate) => candidate.inventoryItemId === input.inventoryItemId,
      );
      if (pos === undefined) {
        throw new Error(`Missing position for ${input.inventoryItemId}`);
      }
      return { inventoryPositionId: pos.id, revision: pos.revision };
    }),
    expectedOutputPositionRevision: outputPosition.revision,
  });
  expect(batch, JSON.stringify(batch)).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });

  const afterBatch = await native.readStockSnapshot(MERCHANT_ID);
  if (!afterBatch.ok) {throw new Error("Stock snapshot after batch unavailable");}
  const updatedPosition =
    afterBatch.value.commerce.resources.inventoryPositions.find(
      (position) => position.id === outputPosition.id,
    );
  const producedLot = afterBatch.value.lots.find(
    (lot) => lot.id === "lot_costs_plain_1",
  );
  if (updatedPosition === undefined || producedLot === undefined) {
    throw new Error("Missing produced lot after batch");
  }

  const waste = await native.reconcileInventory({
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: afterBatch.value.commerce.merchantRevision,
    idempotencyKey: "costs_e2e_plain_waste",
    inventoryPositionId: updatedPosition.id,
    inventoryPositionRevision: updatedPosition.revision,
    target: {
      kind: "lot",
      lotId: producedLot.id,
      lotRevision: producedLot.revision,
    },
    change: {
      kind: "adjustment",
      direction: "decrease",
      quantity: {
        amount: 3 * scaleFactor,
        scale: yieldQty.scale,
        unit: yieldQty.unit,
      },
      reason: "waste",
      explanation: "End-of-day showcase spoilage",
    },
  });
  expect(waste, JSON.stringify(waste)).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });
}

async function placePatisserieBuyerOrder(
  storefront: CommerceStorefrontClient,
  lines: readonly Readonly<{ slug: string; quantity: number }>[],
): Promise<string> {
  const storefrontId = "storefront_cafe";
  const key = `costs_actuals_${crypto.randomUUID()}`;
  const session = await storefront.createSession(MERCHANT_ID, storefrontId, {
    schemaVersion: "underclerk.create-buyer-session.v1",
    buyer: { kind: "guest" },
  });
  if (!session.ok) {
    throw new Error(`Buyer session failed: ${JSON.stringify(session.error)}`);
  }
  const cart = await storefront.createCart(
    MERCHANT_ID,
    storefrontId,
    session.value.token,
    {
      schemaVersion: "underclerk.create-buyer-cart.v1",
      idempotencyKey: `${key}_cart`,
      lines: lines.map((entry) => ({
        kind: "menu" as const,
        menuId: "menu_cafe_main",
        menuEntryId: `menu_entry_patisserie_${entry.slug}`,
        modifierOptionIds: [],
        quantity: entry.quantity,
      })),
    },
  );
  if (!cart.ok) {
    throw new Error(`Buyer cart failed: ${JSON.stringify(cart.error)}`);
  }
  const checkout = await storefront.createPickupCheckout(
    MERCHANT_ID,
    storefrontId,
    session.value.token,
    {
      schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
      idempotencyKey: `${key}_checkout`,
      cartId: cart.value.cartId,
      cartRevision: cart.value.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: "bakery-guest@example.test" },
      },
    },
  );
  if (!checkout.ok) {
    throw new Error(`Buyer checkout failed: ${JSON.stringify(checkout.error)}`);
  }
  const paymentKey = `${key}_payment`;
  const payment = await storefront.createPaymentSession(
    MERCHANT_ID,
    storefrontId,
    checkout.value.checkoutId,
    session.value.token,
    {
      schemaVersion: "underclerk.create-buyer-payment-session.v1",
      idempotencyKey: paymentKey,
      checkoutRevision: checkout.value.revision,
      quoteDigest: checkout.value.quote.quoteDigest,
      returnUrl: "https://underclerk.test/return",
    },
  );
  if (!payment.ok || payment.value.state !== "ready") {
    throw new Error(`Buyer payment session failed: ${JSON.stringify(payment)}`);
  }
  const placed = await storefront.reconcilePayment(
    MERCHANT_ID,
    storefrontId,
    checkout.value.checkoutId,
    session.value.token,
    {
      schemaVersion: "underclerk.reconcile-buyer-payment.v1",
      idempotencyKey: paymentKey,
      checkoutRevision: payment.value.checkoutRevision,
      quoteDigest: checkout.value.quote.quoteDigest,
      confirmation: { kind: "provider_ui_completed" },
    },
  );
  if (!placed.ok || placed.value.state !== "placed") {
    throw new Error(`Buyer payment reconcile failed: ${JSON.stringify(placed)}`);
  }
  return placed.value.orderId;
}

async function recordSupplyWasteMovement(
  native: ReturnType<typeof providerClient>,
  inventoryItemId: string,
  wasteGrams: number,
): Promise<void> {
  const snapshot = await native.readStockSnapshot(MERCHANT_ID);
  if (!snapshot.ok) {
    throw new Error("Stock snapshot unavailable for supply waste");
  }
  const position = snapshot.value.commerce.resources.inventoryPositions.find(
    (candidate) => candidate.inventoryItemId === inventoryItemId,
  );
  if (position === undefined) {
    throw new Error(`Missing inventory position for ${inventoryItemId}`);
  }
  const activeLot = snapshot.value.lots.find(
    (lot) =>
      lot.inventoryItemId === inventoryItemId &&
      lot.locationId === position.locationId &&
      lot.lifecycle.state === "available",
  );
  const reconciled = await native.reconcileInventory({
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: snapshot.value.commerce.merchantRevision,
    idempotencyKey: `costs_e2e_supply_waste_${inventoryItemId}`,
    inventoryPositionId: position.id,
    inventoryPositionRevision: position.revision,
    target:
      activeLot !== undefined
        ? {
            kind: "lot",
            lotId: activeLot.id,
            lotRevision: activeLot.revision,
          }
        : { kind: "aggregate" },
    change: {
      kind: "adjustment",
      direction: "decrease",
      quantity: {
        amount: wasteGrams,
        scale: 0,
        unit: "gram",
      },
      reason: "waste",
      explanation: "Bar sifter & whisk over-portion waste",
    },
  });
  expect(reconciled, JSON.stringify(reconciled)).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });
}

async function fetchCosts(
  person: Member,
  organisationPath: string,
  method: "GET" | "POST",
  body?: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  const headers = commerceHeaders(person.session);
  if (method === "POST") {
    headers.set("idempotency-key", idempotencyKey ?? crypto.randomUUID());
  }
  return exports.default.fetch(
    `https://localhost${organisationPath}/commerce/costs`,
    {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
}

async function readPortalCosts(
  person: Member,
  organisationPath: string,
): Promise<CostsOverview> {
  const response = await fetchCosts(person, organisationPath, "GET");
  expect(response.status, await response.clone().text()).toBe(200);
  return parseCostsOverview(await response.json());
}

async function allowHeldStep(fixture: MemoryFixture): Promise<void> {
  const base = accessControlPath(fixture.organisationId);
  const headers = commerceHeaders(fixture.author.session);
  const list = await exports.default.fetch(`${base}/permission-requests`, {
    headers,
  });
  expect(list.status).toBe(200);
  const body: unknown = await list.json();
  if (!isRecord(body) || !Array.isArray(body.heldOutputs)) {
    throw new Error("Pending list invalid");
  }
  const held: unknown = body.heldOutputs.at(-1);
  if (!isRecord(held) || typeof held.requestId !== "string")
    {throw new Error("No held step");}
  const decided = await exports.default.fetch(
    `${base}/held-outputs/${held.requestId}/decision`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "allow" }),
    },
  );
  expect(decided.status, await decided.clone().text()).toBe(200);
}

async function chatApproved(
  fixture: MemoryFixture,
  word: string,
): Promise<void> {
  await chatDirect(fixture, fixture.author, word);
  await allowHeldStep(fixture);
  await chatDirect(fixture, fixture.author, word);
}

async function chatThrough(
  fixture: MemoryFixture,
  person: Member,
  word: string,
  options: Readonly<{ action?: string }>,
): Promise<Readonly<{ action: unknown }>> {
  const conversationId = await startChat(fixture, person, word);
  const pause = await pausedRequest(person, fixture.paths.chat, conversationId);
  if (options.action !== undefined)
    {expect(pause.permission).toMatchObject({ action: options.action });}
  const allowed = await allowAsPortal(
    person.organisationId,
    person.session,
    pause.id,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await resumeChat(
    person,
    fixture.paths.chat,
    conversationId,
    pause.id,
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await finished(person, conversationId);
  return { action: pause.permission.action };
}

async function replyToModel(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) {throw new Error("Invalid model request");}
  journey.modelRequests += 1;
  const id = `costs_${String(journey.modelRequests)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  const called = lastCalledTool(body);
  const all = scripts(journey);
  const word = messageWord(body, ["GETREADY", ...Object.keys(all)]);
  if (word === "GETREADY")
    {return called === null
      ? openRouterToolCall(
          "request_permission",
          {
            capabilityIds: ["commerce.entity_plane.context"],
            entityTypeReads: [],
          },
          `call_${id}`,
        )
      : reply("Ready.");}
  const script = all[word];
  if (script === undefined) {
    throw new Error(`No script for ${word}`);
  }
  const callTool = async (): Promise<Response> => {
    if (
      word === "VIEWERSUPPLYCOST" &&
      journey.demoteBeforeTool !== undefined
    ) {
      await journey.demoteBeforeTool();
    }
    return openRouterToolCall(script.tool, script.args(), `call_${id}`);
  };
  if (called === null)
    {return offeredToolNames(body).includes(script.tool)
      ? await callTool()
      : openRouterToolCall(
          "tool_search",
          { query: script.tool, limit: 1 },
          `call_${id}`,
        );}
  const output = requireLastToolOutput(body);
  switch (called) {
    case "tool_search":
      if (offeredToolNames(body).includes(script.tool)) {return await callTool();}
      if (script.ask === undefined)
        {throw new Error(`${word} found no ${script.tool}: ${output}`);}
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: script.ask.capabilityIds, entityTypeReads: [] },
        `call_${id}`,
      );
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return reply("I asked for permission.");
    case script.tool: {
      if (output.includes("Allow prompt")) {
        expect(output).not.toContain("access controls");
        return reply("I asked for permission.");
      }
      journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
      return reply(`Finished ${word}.`);
    }
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}
