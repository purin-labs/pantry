/**
 * The saves of the Costs & margins page: the whole sheet, one lot invoice
 * cost, and the pack terms of one stock item.
 *
 * A sheet save checks every refusal before its first write. Then it writes the
 * offer prices and the pack terms to Commerce, one record at a time, and the
 * lot costs and the plan in one D1 batch. Commerce writes are not undone when
 * a later step fails: the save settles the draft cells of each record that
 * saved and names those records in its refusal, so the page shows what saved
 * and a retry sends only the rest.
 */
import {
  commerceCommandInput,
  type CommerceAdminClient,
  type CommerceEntityPlaneClient,
  type CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import { productPriceCellKey } from "@purin-labs/costs-sheet-crdt";
import type {
  CostsSheetSaved,
  CostsSheetWrite,
  CostsSheetWriteResult,
  LotCostLineWrite,
  OfferPriceWrite,
  SupplyCostLineWrite,
  SupplyCostWrite,
  SupplyLotInvoiceCost,
} from "@purin-labs/kitchen-control-api";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  saveSupplyCostTerms,
  supplyCostWriteProblem,
  type SupplyCostSaveResult,
} from "./cost-commands";
import {
  knownLotsOfSnapshot,
  prepareOrganisationCostPlanSave,
  prepareOrganisationLotInvoiceCostSave,
  readOrganisationCostPlan,
  saveOrganisationLotInvoiceCost,
  type CostPlanSaveResult,
  type LotCostSaveResult,
  type PreparedRowSave,
} from "./cost-plan-store";
import {
  costPlanCellKeys,
  lotInvoiceCellKeys,
  supplyItemCellKeys,
} from "./costs-sheet-cells";

/**
 * Removes the draft cells of saved records from the shared sheet. It reports
 * its own failure: a save that applied stays saved.
 */
export type CostsSheetSettlement = (
  cellKeys: readonly string[],
  clearPriceCells: boolean,
  savedAtMs: number,
) => Promise<void>;

export type CostsSaveRefusal =
  | Readonly<{
      code:
        | "insufficient_role"
        | "commerce_unavailable"
        | "commerce_scope_mismatch"
        | "stale_resource_revision"
        | "supply_cost_busy"
        | "cost_sheet_write_failed";
    }>
  | Readonly<{
      code:
        | "cost_plan_invalid"
        | "lot_cost_invalid"
        | "lot_cost_unit_mismatch"
        | "offer_price_invalid"
        | "supply_cost_invalid"
        | "supply_cost_unit_mismatch";
      detail: string;
    }>;

/** A refused sheet save, with the records that saved before the refusal. */
type CostsSheetSaveError = CostsSaveRefusal &
  Readonly<{ saved: CostsSheetSaved }>;

type CommerceContext = Readonly<{
  adminClient: CommerceAdminClient;
  entityPlaneClient: CommerceEntityPlaneClient;
  db: OrganisationDatabase;
  organisationId: string;
  merchantId: string;
  userId: string;
  idempotencyKey: string;
  nowMs: number;
  settle: CostsSheetSettlement;
}>;

const NOTHING_SAVED: CostsSheetSaved = { offerIds: [], inventoryItemIds: [] };

export async function saveCostsSheet(
  input: CommerceContext &
    Readonly<{ sheet: CostsSheetWrite; canEditPrices: boolean }>,
): Promise<Result<CostsSheetWriteResult, CostsSheetSaveError>> {
  const { sheet } = input;
  if (sheet.priceWrites.length > 0 && !input.canEditPrices) {
    return refused({ code: "insufficient_role" }, NOTHING_SAVED);
  }
  const checked = await checkCostsSheet(input);
  if (!checked.ok) {
    return refused(checked.error, NOTHING_SAVED);
  }
  const { productIdByOfferId, rowSaves } = checked.value;

  const savedOfferIds: string[] = [];
  const savedItemIds: string[] = [];
  let merchantRevision = sheet.merchantRevision;
  let failure: CostsSaveRefusal | null = null;

  for (const write of sheet.priceWrites) {
    const saved = await saveOfferPrice(input, write);
    if (!saved.ok) {
      failure = saved.error;
      break;
    }
    savedOfferIds.push(write.offerId);
    merchantRevision = saved.value;
  }
  for (const [index, line] of sheet.supplyWrites.entries()) {
    if (failure !== null) break;
    const saved = await saveSupplyCostTerms({
      adminClient: input.adminClient,
      entityPlaneClient: input.entityPlaneClient,
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      principalId: input.userId,
      idempotencyKey: `${input.idempotencyKey.slice(0, 72)}:supply:${index}`,
      write: supplyWriteOfLine(sheet, merchantRevision, line),
      nowMs: input.nowMs,
    });
    if (!saved.ok) {
      failure = supplyRefusal(saved);
      break;
    }
    savedItemIds.push(line.inventoryItemId);
    merchantRevision = saved.merchantRevision;
  }
  const rowsSaved =
    failure === null ? await writeRowSaves(input, rowSaves.all) : null;
  if (rowsSaved !== null && !rowsSaved.ok) {
    failure = rowsSaved.error;
  }

  const settledKeys = [
    ...savedOfferIds.flatMap((offerId) => {
      const productId = productIdByOfferId.get(offerId);
      return productId === undefined ? [] : [productPriceCellKey(productId)];
    }),
    ...savedItemIds.flatMap(supplyItemCellKeys),
    ...(rowsSaved?.ok === true ? rowSaves.cellKeys : []),
  ];
  if (settledKeys.length > 0) {
    await input.settle(
      settledKeys,
      failure === null && sheet.priceWrites.length > 0,
      input.nowMs,
    );
  }
  if (failure !== null) {
    return refused(failure, {
      offerIds: savedOfferIds,
      inventoryItemIds: savedItemIds,
    });
  }
  const planRevision =
    rowSaves.plan === null
      ? (await readOrganisationCostPlan(input.db, input.organisationId))
          .revision
      : rowSaves.plan.value.revision;
  return {
    ok: true,
    value: {
      ok: true,
      merchantRevision,
      planRevision,
      updatedOfferCount: sheet.priceWrites.length,
      updatedSupplyCount: sheet.supplyWrites.length,
      updatedLotCount: (sheet.lotWrites ?? []).length,
    },
  };
}

export async function saveLotCost(
  input: Pick<
    CommerceContext,
    | "adminClient"
    | "db"
    | "organisationId"
    | "merchantId"
    | "userId"
    | "nowMs"
    | "settle"
  > &
    Readonly<{ write: LotCostLineWrite }>,
): Promise<
  Result<
    Readonly<{
      lotId: string;
      revision: number;
      invoiceCost: SupplyLotInvoiceCost;
      merchantRevision: number;
    }>,
    CostsSaveRefusal
  >
> {
  const snapshot = await readSnapshot(input);
  if (!snapshot.ok) return snapshot;
  const saved = await saveOrganisationLotInvoiceCost({
    db: input.db,
    organisationId: input.organisationId,
    updatedBy: input.userId,
    nowMs: input.nowMs,
    write: input.write,
    knownLotsById: knownLotsOfSnapshot(snapshot.value),
  });
  if (!saved.ok) return { ok: false, error: rowRefusal(saved) };
  await input.settle(lotInvoiceCellKeys(input.write.lotId), false, input.nowMs);
  return {
    ok: true,
    value: {
      lotId: input.write.lotId,
      revision: saved.revision,
      invoiceCost: saved.invoiceCost,
      merchantRevision: Number(snapshot.value.commerce.merchantRevision),
    },
  };
}

export async function saveSupplyCost(
  input: Omit<CommerceContext, "db"> & Readonly<{ write: SupplyCostWrite }>,
): Promise<
  Result<
    Readonly<{ entryId: string; entryRevision: number; merchantRevision: number }>,
    CostsSaveRefusal
  >
> {
  const saved = await saveSupplyCostTerms({
    adminClient: input.adminClient,
    entityPlaneClient: input.entityPlaneClient,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    principalId: input.userId,
    idempotencyKey: input.idempotencyKey,
    write: input.write,
    nowMs: input.nowMs,
  });
  if (!saved.ok) return { ok: false, error: supplyRefusal(saved) };
  await input.settle(
    supplyItemCellKeys(input.write.inventoryItemId),
    false,
    input.nowMs,
  );
  return {
    ok: true,
    value: {
      entryId: saved.entryId,
      entryRevision: saved.entryRevision,
      merchantRevision: saved.merchantRevision,
    },
  };
}

type RowSaves = Readonly<{
  all: readonly PreparedRowSave<unknown>[];
  plan: PreparedRowSave<Readonly<{ revision: number }>> | null;
  cellKeys: readonly string[];
}>;

/**
 * Every refusal of a sheet save that a read can find: the offers, the stock
 * items of the pack terms, the lots, the plan products, and the lot and plan
 * revisions. It writes nothing.
 */
async function checkCostsSheet(
  input: CommerceContext & Readonly<{ sheet: CostsSheetWrite }>,
): Promise<
  Result<
    Readonly<{
      productIdByOfferId: ReadonlyMap<string, string>;
      rowSaves: RowSaves;
    }>,
    CostsSaveRefusal
  >
> {
  const { sheet } = input;
  const snapshot = await readSnapshot(input);
  if (!snapshot.ok) return snapshot;
  const productIdByOfferId = productIdsOfOffers(snapshot.value);
  for (const write of sheet.priceWrites) {
    if (!productIdByOfferId.has(write.offerId)) {
      return {
        ok: false,
        error: {
          code: "offer_price_invalid",
          detail: `Offer ${write.offerId} was not found.`,
        },
      };
    }
  }
  for (const line of sheet.supplyWrites) {
    const problem = supplyCostWriteProblem(snapshot.value, line);
    if (problem !== null) return { ok: false, error: problem };
  }

  const all: PreparedRowSave<unknown>[] = [];
  const cellKeys: string[] = [];
  const knownLotsById = knownLotsOfSnapshot(snapshot.value);
  for (const write of sheet.lotWrites ?? []) {
    const prepared = await prepareOrganisationLotInvoiceCostSave({
      db: input.db,
      organisationId: input.organisationId,
      updatedBy: input.userId,
      nowMs: input.nowMs,
      write,
      knownLotsById,
    });
    if (!prepared.ok) return { ok: false, error: rowRefusal(prepared) };
    all.push(prepared.save);
    cellKeys.push(...lotInvoiceCellKeys(write.lotId));
  }

  let plan: RowSaves["plan"] = null;
  if (sheet.planWrite !== null) {
    const prepared = await prepareOrganisationCostPlanSave({
      db: input.db,
      organisationId: input.organisationId,
      updatedBy: input.userId,
      nowMs: input.nowMs,
      expectedPlanRevision: sheet.planWrite.expectedPlanRevision,
      dailyLaborMinor: sheet.planWrite.dailyLaborMinor,
      dailyRentMinor: sheet.planWrite.dailyRentMinor,
      products: sheet.planWrite.products,
      ...(sheet.planWrite.forecast !== undefined
        ? { forecast: sheet.planWrite.forecast }
        : {}),
      replaceAllProducts: true,
      knownProductIds: activeProductIds(snapshot.value),
    });
    if (!prepared.ok) return { ok: false, error: rowRefusal(prepared) };
    plan = prepared.save;
    all.push(prepared.save);
    cellKeys.push(
      ...costPlanCellKeys({
        dailyLaborMinor: sheet.planWrite.dailyLaborMinor,
        dailyRentMinor: sheet.planWrite.dailyRentMinor,
        hasForecast: sheet.planWrite.forecast !== undefined,
        productIds: sheet.planWrite.products.map((entry) => entry.productId),
      }),
    );
  }
  return {
    ok: true,
    value: { productIdByOfferId, rowSaves: { all, plan, cellKeys } },
  };
}

/**
 * Applies the lot and plan rows in one batch. The guards come first, so a row
 * that another save changed after the check fails the batch and no row of the
 * batch applies.
 */
async function writeRowSaves(
  input: Pick<CommerceContext, "db" | "organisationId">,
  saves: readonly PreparedRowSave<unknown>[],
): Promise<Result<null, CostsSaveRefusal>> {
  const writes = saves.flatMap((save) => (save.kind === "write" ? [save] : []));
  if (writes.length === 0) return { ok: true, value: null };
  try {
    await input.db.batch([
      ...writes.map((save) => save.guard),
      ...writes.flatMap((save) => save.statements),
    ]);
  } catch (error) {
    traceWarn("kitchen.costs_sheet_rows_not_saved", {
      requestId: newRequestId(),
      organisationId: input.organisationId,
      detail: error instanceof Error ? error.message : "d1_batch_failed",
    });
    return { ok: false, error: { code: "cost_sheet_write_failed" } };
  }
  return { ok: true, value: null };
}

async function saveOfferPrice(
  input: Pick<CommerceContext, "adminClient" | "merchantId" | "idempotencyKey">,
  write: OfferPriceWrite,
): Promise<Result<number, CostsSaveRefusal>> {
  const updated = await input.adminClient.updateOffer(
    commerceCommandInput({
      merchantId: input.merchantId,
      idempotencyKey: `${input.idempotencyKey.slice(0, 80)}:offer:${write.offerId}`,
      offerId: write.offerId,
      expectedOfferRevision: write.expectedOfferRevision,
      changes: {
        price: { amountMinor: write.priceMinor, currency: write.currency },
      },
    }),
  );
  if (!updated.ok) {
    return { ok: false, error: { code: "commerce_unavailable" } };
  }
  if (updated.value.outcome === "rejected") {
    const code = updated.value.error.code;
    return code === "resource_not_found" || code === "invalid_command"
      ? {
          ok: false,
          error: {
            code: "offer_price_invalid",
            detail: `Offer ${write.offerId} rejected (${code}).`,
          },
        }
      : { ok: false, error: { code: "stale_resource_revision" } };
  }
  if (updated.value.receipt.merchantId !== input.merchantId) {
    return { ok: false, error: { code: "commerce_scope_mismatch" } };
  }
  return { ok: true, value: Number(updated.value.receipt.merchantRevision) };
}

async function readSnapshot(
  input: Pick<CommerceContext, "adminClient" | "merchantId">,
): Promise<Result<CommerceStockSnapshot, CostsSaveRefusal>> {
  const snapshot = await input.adminClient.readStockSnapshot(input.merchantId);
  if (!snapshot.ok) {
    return { ok: false, error: { code: "commerce_unavailable" } };
  }
  if (snapshot.value.commerce.merchantId !== input.merchantId) {
    return { ok: false, error: { code: "commerce_scope_mismatch" } };
  }
  return snapshot;
}

function productIdsOfOffers(
  snapshot: CommerceStockSnapshot,
): ReadonlyMap<string, string> {
  const resources = snapshot.commerce.resources;
  const productIdByVariantId = new Map(
    resources.variants.map((variant) => [variant.id, variant.productId]),
  );
  const productIdByOfferId = new Map<string, string>();
  for (const offer of resources.offers) {
    const productId = productIdByVariantId.get(offer.variantId);
    if (productId !== undefined) productIdByOfferId.set(offer.id, productId);
  }
  return productIdByOfferId;
}

function activeProductIds(snapshot: CommerceStockSnapshot): ReadonlySet<string> {
  return new Set(
    snapshot.commerce.resources.products
      .filter((product) => product.status === "active")
      .map((product) => product.id),
  );
}

function supplyWriteOfLine(
  sheet: CostsSheetWrite,
  merchantRevision: number,
  line: SupplyCostLineWrite,
): SupplyCostWrite {
  return { merchantRevision, requestedAt: sheet.requestedAt, ...line };
}

function supplyRefusal(
  saved: Exclude<SupplyCostSaveResult, { ok: true }>,
): CostsSaveRefusal {
  switch (saved.code) {
    case "supply_cost_changed":
      return { code: "stale_resource_revision" };
    case "supply_cost_invalid":
    case "supply_cost_unit_mismatch":
      return { code: saved.code, detail: saved.detail };
    default:
      return { code: saved.code };
  }
}

function rowRefusal(
  saved:
    | Exclude<LotCostSaveResult, { ok: true }>
    | Exclude<CostPlanSaveResult, { ok: true }>,
): CostsSaveRefusal {
  switch (saved.code) {
    case "lot_cost_changed":
    case "cost_plan_changed":
      return { code: "stale_resource_revision" };
    default:
      return { code: saved.code, detail: saved.detail };
  }
}

function refused<T>(
  refusal: CostsSaveRefusal,
  saved: CostsSheetSaved,
): Result<T, CostsSheetSaveError> {
  return { ok: false, error: { ...refusal, saved } };
}
