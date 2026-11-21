import type { OrganisationDatabase } from "../database-handles";
import {
  areCostUnitsCompatible,
  convertCostQuantity,
  scaledQuantityAmount,
  type ActualsWindowDays,
  type CostProductLink,
  type CostUnit,
  type CostsActualsSnapshot,
  type CostsActualsWindowSnapshot,
  type CostsOverview,
  type MeasuredWasteSummary,
  type ProductActualsObservation,
  type SupplyActualLossObservation,
  type SupplyCostItem,
  type SupplyCostTerms,
  type SupplyCostWrite,
  type SupplyLotCost,
  type SupplyLotInvoiceCost,
} from "@purin-labs/kitchen-control-api";
import {
  selectInventoryConsumptionPlan,
  type ProductPhotos,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  SUPPLY_COST_TERMS_LIST_ID,
  type CommerceAdminClient,
  type CommerceEntityPlaneClient,
  type CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import {
  emptyOrganisationCostPlan,
  readOrganisationCostPlan,
  readOrganisationLotInvoiceCosts,
  readReplenishmentSupplierPayables,
  type ReplenishmentPayableSummary,
} from "./cost-plan-store";
import { productPhotos, saleOffers } from "../kitchen/contract/inventory-overview";

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const QUANTITY_SCALE = 6;
const SAVE_ATTEMPT_LIMIT = 4;

type CostReadError =
  | Readonly<{ code: "commerce_unavailable" }>
  | Readonly<{ code: "commerce_scope_mismatch" }>;

export type SupplyCostSaveResult =
  | Readonly<{
      ok: true;
      entryId: string;
      entryRevision: number;
      merchantRevision: number;
    }>
  | Readonly<{
      ok: false;
      code:
        | "commerce_unavailable"
        | "commerce_scope_mismatch"
        | "supply_cost_changed"
        | "supply_cost_busy";
    }>
  | Readonly<{
      ok: false;
      code: "supply_cost_invalid" | "supply_cost_unit_mismatch";
      detail: string;
    }>;

export async function readCostsOverview(
  input: Readonly<{
    adminClient: CommerceAdminClient;
    entityPlaneClient: CommerceEntityPlaneClient;
    organisationId: string;
    merchantId: string;
    nowMs: number;
    db?: OrganisationDatabase;
    canEditPrices?: boolean;
    commerceBaseUrl?: string | undefined;
  }>,
): Promise<
  | Readonly<{ ok: true; value: CostsOverview }>
  | Readonly<{ ok: false; error: CostReadError }>
> {
  const base = input.commerceBaseUrl?.trim().replace(/\/+$/u, "");
  const hasPublicBase = base !== undefined && base.length > 0;
  const [
    snapshotResult,
    metadataResult,
    profilesResult,
    activationsResult,
    costPlan,
    lotInvoiceCosts,
    replenishmentPayables,
    mediaLibraryResult,
    storefrontsResult,
  ] = await Promise.all([
    input.adminClient.readStockSnapshot(input.merchantId),
    input.entityPlaneClient.publishedResourceMetadata({
      kind: "enumerate",
      organisationId: input.organisationId,
      merchantId: input.merchantId,
    }),
    input.adminClient.listCheckoutProfiles(input.merchantId),
    input.adminClient.listCheckoutProfileActivations(input.merchantId),
    input.db !== undefined
      ? readOrganisationCostPlan(input.db, input.organisationId)
      : Promise.resolve(emptyOrganisationCostPlan()),
    input.db !== undefined
      ? readOrganisationLotInvoiceCosts(input.db, input.organisationId)
      : Promise.resolve(new Map<string, SupplyLotInvoiceCost>()),
    input.db !== undefined
      ? readReplenishmentSupplierPayables(
          input.db,
          input.organisationId,
          input.merchantId,
        )
      : Promise.resolve(new Map<string, ReplenishmentPayableSummary>()),
    hasPublicBase
      ? input.adminClient.listMedia(input.merchantId)
      : Promise.resolve(null),
    hasPublicBase
      ? input.adminClient.listStorefrontIds(input.merchantId)
      : Promise.resolve(null),
  ]);

  if (!snapshotResult.ok)
    {return { ok: false, error: { code: "commerce_unavailable" } };}
  if (snapshotResult.value.commerce.merchantId !== input.merchantId)
    {return { ok: false, error: { code: "commerce_scope_mismatch" } };}

  const termsByItemId = new Map<string, SupplyCostTerms>();
  if (metadataResult.ok && metadataResult.value.kind === "enumerated") {
    if (
      metadataResult.value.organisationId !== input.organisationId ||
      metadataResult.value.merchantId !== input.merchantId
    ) {
      return { ok: false, error: { code: "commerce_scope_mismatch" } };
    }
    const costList = metadataResult.value.lists.find(
      (list) => String(list.listId) === SUPPLY_COST_TERMS_LIST_ID,
    );
    if (costList !== undefined) {
      const loaded = await loadSupplyCostTermsMap(
        input.entityPlaneClient,
        input.merchantId,
        costList.listId,
      );
      if (!loaded.ok)
        {return { ok: false, error: { code: "commerce_unavailable" } };}
      for (const [itemId, terms] of loaded.value) {
        termsByItemId.set(itemId, terms);
      }
    }
  }

  const snapshot = snapshotResult.value;
  const onHandByItemId = computeSupplyOnHandByItemId(snapshot);
  const items: SupplyCostItem[] = snapshot.commerce.resources.inventoryItems.map(
    (item) => ({
      id: item.id,
      merchantCode: item.merchantCode,
      name: item.name,
      category: item.category,
      baseUnit: item.baseUnit,
      lifecycle: item.lifecycle,
      costTerms: termsByItemId.get(item.id) ?? null,
      onHandQuantity: onHandByItemId.get(item.id) ?? null,
    }),
  );

  const storefrontId =
    storefrontsResult !== null && storefrontsResult.ok
      ? storefrontsResult.value[0]
      : undefined;
  const photos =
    hasPublicBase &&
    mediaLibraryResult !== null &&
    mediaLibraryResult.ok &&
    storefrontId !== undefined
      ? productPhotos(
          mediaLibraryResult.value,
          `${base}/v1/public/merchants/${encodeURIComponent(input.merchantId)}/storefronts/${encodeURIComponent(storefrontId)}/media`,
        )
      : undefined;

  const products = buildCostProductLinks(snapshot, photos);
  const currency = detectPrimaryCurrency(products, items);
  const tax = detectIncludedTax(
    snapshot,
    currency,
    profilesResult.ok ? profilesResult.value : [],
    activationsResult.ok ? activationsResult.value : [],
  );
  const measuredWaste = summarizeMeasuredWaste(snapshot, input.nowMs);
  const lots = buildSupplyLotCosts(
    snapshot,
    lotInvoiceCosts,
    replenishmentPayables,
    input.nowMs,
  );
  const actuals = summarizeCostsActuals(
    snapshot,
    products,
    replenishmentPayables,
    currency,
    input.nowMs,
  );

  return {
    ok: true,
    value: {
      ok: true,
      merchantRevision: snapshot.commerce.merchantRevision,
      currency,
      canEditPrices: input.canEditPrices ?? false,
      defaultIncludedTaxBps: tax.basisPoints,
      includedTaxSource: tax.source,
      recipes: [...snapshot.foodService.resources.recipeRevisions],
      items,
      products,
      measuredWaste,
      costPlan,
      lots,
      actuals,
    },
  };
}

export async function saveSupplyCostTerms(
  input: Readonly<{
    adminClient: CommerceAdminClient;
    entityPlaneClient: CommerceEntityPlaneClient;
    organisationId: string;
    merchantId: string;
    principalId: string;
    idempotencyKey: string;
    write: SupplyCostWrite;
    nowMs: number;
  }>,
): Promise<SupplyCostSaveResult> {
  const snapshotResult = await input.adminClient.readStockSnapshot(
    input.merchantId,
  );
  if (!snapshotResult.ok)
    {return { ok: false, code: "commerce_unavailable" };}
  if (snapshotResult.value.commerce.merchantId !== input.merchantId)
    {return { ok: false, code: "commerce_scope_mismatch" };}

  const item = snapshotResult.value.commerce.resources.inventoryItems.find(
    (candidate) => candidate.id === input.write.inventoryItemId,
  );
  if (item === undefined || item.lifecycle !== "active") {
    return {
      ok: false,
      code: "supply_cost_invalid",
      detail: `Supply item ${input.write.inventoryItemId} is not active.`,
    };
  }
  if (item.category === "finished_good") {
    return {
      ok: false,
      code: "supply_cost_invalid",
      detail:
        "Finished goods derive their cost from recipes rather than supplier pack terms.",
    };
  }
  if (!areCostUnitsCompatible(input.write.packUnit, item.baseUnit)) {
    return {
      ok: false,
      code: "supply_cost_unit_mismatch",
      detail: `Pack unit ${input.write.packUnit} is not compatible with ${item.name} (${item.baseUnit}).`,
    };
  }

  for (let attempt = 0; attempt < SAVE_ATTEMPT_LIMIT; attempt += 1) {
    const ensured = await ensureSupplyCostList(
      input.entityPlaneClient,
      input.organisationId,
      input.merchantId,
    );
    if (!ensured.ok) {return ensured.error;}

    const existingEntries = await loadSupplyCostRawEntries(
      input.entityPlaneClient,
      input.merchantId,
      ensured.listId,
    );
    if (!existingEntries.ok)
      {return { ok: false, code: "commerce_unavailable" };}

    const existing = existingEntries.value.find(
      (entry) => String(entry.entityRef.entityId) === input.write.inventoryItemId,
    );
    const parsedExisting =
      existing === undefined ? null : decodeSupplyCostEntry(existing);

    if (input.write.expectedEntryRevision === null) {
      if (existing !== undefined) {
        if (parsedExisting !== null && sameTerms(parsedExisting, input.write)) {
          return {
            ok: true,
            entryId: String(existing.entryId),
            entryRevision: Number(existing.revision),
            merchantRevision: ensured.merchantRevision,
          };
        }
        return { ok: false, code: "supply_cost_changed" };
      }
    } else {
      if (existing === undefined)
        {return { ok: false, code: "supply_cost_changed" };}
      const currentRevision = Number(existing.revision);
      if (currentRevision !== input.write.expectedEntryRevision) {
        if (
          currentRevision === input.write.expectedEntryRevision + 1 &&
          parsedExisting !== null &&
          sameTerms(parsedExisting, input.write)
        ) {
          return {
            ok: true,
            entryId: String(existing.entryId),
            entryRevision: currentRevision,
            merchantRevision: ensured.merchantRevision,
          };
        }
        return { ok: false, code: "supply_cost_changed" };
      }
    }

    const commandId = `${input.idempotencyKey.slice(0, 88)}:supply_cost:${attempt}`;
    const expiresAt = new Date(input.nowMs + 5 * 60_000).toISOString();
    const attributeValues = buildSupplyCostAttributes(input.write);
    const entryId =
      existing !== undefined
        ? String(existing.entryId)
        : `supply_cost:${input.write.inventoryItemId}`;

    const request =
      existing === undefined
        ? parseEntityPlaneCommand({
            organisationId: input.organisationId,
            merchantId: input.merchantId,
            expectedMerchantRevision: parseCommerceSnapshotRevision(
              ensured.merchantRevision,
            ),
            commandId,
            authority: {
              kind: "commerce_list_entry_create",
              context: {
                organisationId: input.organisationId,
                merchantId: input.merchantId,
                principalId: input.principalId,
                sensitivityCeiling: "restricted",
                expiresAt,
                causation: { kind: "command", commandId },
              },
              scope: {
                kind: "commerce_list",
                listId: SUPPLY_COST_TERMS_LIST_ID,
              },
              target: {
                entry: {
                  entryId,
                  listId: SUPPLY_COST_TERMS_LIST_ID,
                  revision: 1,
                },
                listRevision: ensured.listRevision,
                entityTypeId: { origin: "system", typeId: "inventory_item" },
                entityRef: {
                  origin: "system",
                  typeId: "inventory_item",
                  entityId: input.write.inventoryItemId,
                },
              },
            },
            command: {
              kind: "add_commerce_list_entry",
              command: {
                entryId,
                listId: SUPPLY_COST_TERMS_LIST_ID,
                expectedListRevision: ensured.listRevision,
                entityRef: {
                  origin: "system",
                  typeId: "inventory_item",
                  entityId: input.write.inventoryItemId,
                },
                attributeValues,
                revision: 1,
              },
            },
          })
        : parseEntityPlaneCommand({
            organisationId: input.organisationId,
            merchantId: input.merchantId,
            expectedMerchantRevision: parseCommerceSnapshotRevision(
              ensured.merchantRevision,
            ),
            commandId,
            authority: {
              kind: "commerce_list_entry_command",
              context: {
                organisationId: input.organisationId,
                merchantId: input.merchantId,
                principalId: input.principalId,
                sensitivityCeiling: "restricted",
                expiresAt,
                causation: { kind: "command", commandId },
              },
              scope: {
                kind: "commerce_list_entry",
                entry: {
                  entryId,
                  listId: SUPPLY_COST_TERMS_LIST_ID,
                  revision: Number(existing.revision),
                },
              },
              target: {
                entry: {
                  entryId,
                  listId: SUPPLY_COST_TERMS_LIST_ID,
                  revision: Number(existing.revision),
                },
                expectedRevision: Number(existing.revision),
              },
            },
            command: {
              kind: "patch_commerce_list_entry",
              command: {
                target: {
                  entry: {
                    entryId,
                    listId: SUPPLY_COST_TERMS_LIST_ID,
                    revision: Number(existing.revision),
                  },
                  expectedRevision: Number(existing.revision),
                },
                expectedListRevision: ensured.listRevision,
                attributeValues,
              },
            },
          });

    const executed = await input.entityPlaneClient.command(request);
    if (!executed.ok) {return { ok: false, code: "commerce_unavailable" };}
    if (executed.value.status === "accepted") {
      const receipt = executed.value.receipt;
      const nextEntryRevision =
        receipt.target.kind === "commerce_list_entry"
          ? Number(receipt.target.entry.revision)
          : (existing === undefined ? 1 : Number(existing.revision) + 1);
      return {
        ok: true,
        entryId,
        entryRevision: nextEntryRevision,
        merchantRevision: Number(receipt.merchantRevision),
      };
    }
    if (executed.value.error.code === "revision_conflict") {
      continue;
    }
    return {
      ok: false,
      code: "supply_cost_invalid",
      detail: `Supply cost save rejected (${executed.value.error.code}).`,
    };
  }
  return { ok: false, code: "supply_cost_busy" };
}

async function ensureSupplyCostList(
  client: CommerceEntityPlaneClient,
  organisationId: string,
  merchantId: string,
): Promise<
  | Readonly<{
      ok: true;
      listId: string;
      listRevision: number;
      merchantRevision: number;
    }>
  | Readonly<{ ok: false; error: SupplyCostSaveResult }>
> {
  let metadata = await client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId,
    merchantId,
  });
  if (!metadata.ok || metadata.value.kind !== "enumerated") {
    return {
      ok: false,
      error: { ok: false, code: "commerce_unavailable" },
    };
  }
  if (
    metadata.value.organisationId !== organisationId ||
    metadata.value.merchantId !== merchantId
  ) {
    return {
      ok: false,
      error: { ok: false, code: "commerce_scope_mismatch" },
    };
  }
  let list = metadata.value.lists.find(
    (candidate) => String(candidate.listId) === SUPPLY_COST_TERMS_LIST_ID,
  );
  if (list === undefined) {
    const published = await client.publishPurchasingPreset({
      organisationId,
      merchantId,
    });
    if (!published.ok) {
      return {
        ok: false,
        error: { ok: false, code: "commerce_unavailable" },
      };
    }
    metadata = await client.publishedResourceMetadata({
      kind: "enumerate",
      organisationId,
      merchantId,
    });
    if (!metadata.ok || metadata.value.kind !== "enumerated") {
      return {
        ok: false,
        error: { ok: false, code: "commerce_unavailable" },
      };
    }
    list = metadata.value.lists.find(
      (candidate) => String(candidate.listId) === SUPPLY_COST_TERMS_LIST_ID,
    );
    if (list === undefined) {
      return {
        ok: false,
        error: { ok: false, code: "commerce_unavailable" },
      };
    }
  }
  return {
    ok: true,
    listId: String(list.listId),
    listRevision: Number(list.publishedRevision),
    merchantRevision: Number(metadata.value.merchantRevision),
  };
}

type RawListEntry = Awaited<
  ReturnType<CommerceEntityPlaneClient["query"]>
> extends infer Response
  ? Response extends { ok: true; value: { listEntries: readonly (infer E)[] } }
    ? E
    : never
  : never;

async function loadSupplyCostRawEntries(
  client: CommerceEntityPlaneClient,
  merchantId: string,
  listId: string,
): Promise<
  | Readonly<{ ok: true; value: readonly RawListEntry[] }>
  | Readonly<{ ok: false }>
> {
  const entries: RawListEntry[] = [];
  let cursor: import("@purin-labs/commerce-contracts").CommerceCursor | null = null;
  for (let page = 0; page < 20; page += 1) {
    const query = parseCommerceGraphQuery({
      kind: "commerce_list_page",
      listId,
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 500, cursor },
    });
    const response = await client.query(merchantId, query);
    if (!response.ok) {return { ok: false };}
    entries.push(...response.value.listEntries);
    if (response.value.nextCursor === null) {return { ok: true, value: entries };}
    cursor = response.value.nextCursor;
  }
  return { ok: false };
}

async function loadSupplyCostTermsMap(
  client: CommerceEntityPlaneClient,
  merchantId: string,
  listId: string,
): Promise<
  | Readonly<{ ok: true; value: ReadonlyMap<string, SupplyCostTerms> }>
  | Readonly<{ ok: false }>
> {
  const loaded = await loadSupplyCostRawEntries(client, merchantId, listId);
  if (!loaded.ok) {return loaded;}
  const map = new Map<string, SupplyCostTerms>();
  for (const entry of loaded.value) {
    const decoded = decodeSupplyCostEntry(entry);
    if (decoded !== null) {
      map.set(String(entry.entityRef.entityId), decoded);
    }
  }
  return { ok: true, value: map };
}

function decodeSupplyCostEntry(entry: RawListEntry): SupplyCostTerms | null {
  const currency = readShortText(entry, "currency");
  const packQuantity = readDecimal(entry, "pack_quantity");
  const packUnitRaw = readShortText(entry, "pack_unit");
  const packPriceMinor = readInteger(entry, "pack_price_minor");
  const packUnit = parseCostUnitOrNull(packUnitRaw);
  if (
    currency === null ||
    packQuantity === null ||
    packQuantity <= 0 ||
    packUnit === null ||
    packPriceMinor === null ||
    packPriceMinor < 0
  ) {
    return null;
  }
  const supplierId = readShortText(entry, "supplier_id");
  const notes = readLongText(entry, "notes");
  const min7d = readDecimal(entry, "bulk_min_7d_quantity");
  const bulkPackQty = readDecimal(entry, "bulk_pack_quantity");
  const bulkPrice = readInteger(entry, "bulk_pack_price_minor");
  const bulkTier =
    min7d !== null &&
    min7d > 0 &&
    bulkPackQty !== null &&
    bulkPackQty > 0 &&
    bulkPrice !== null &&
    bulkPrice >= 0
      ? {
          min7dQuantity: min7d,
          packQuantity: bulkPackQty,
          packPriceMinor: bulkPrice,
        }
      : null;

  return {
    entryId: String(entry.entryId),
    entryRevision: Number(entry.revision),
    currency,
    packQuantity,
    packUnit,
    packPriceMinor,
    supplierId,
    bulkTier,
    notes,
  };
}

function sameTerms(current: SupplyCostTerms, write: SupplyCostWrite): boolean {
  const sameBulk =
    current.bulkTier === null && write.bulkTier === null
      ? true
      : current.bulkTier !== null &&
        write.bulkTier !== null &&
        Math.abs(current.bulkTier.min7dQuantity - write.bulkTier.min7dQuantity) <
          1e-6 &&
        Math.abs(current.bulkTier.packQuantity - write.bulkTier.packQuantity) <
          1e-6 &&
        current.bulkTier.packPriceMinor === write.bulkTier.packPriceMinor;
  return (
    current.currency === write.currency &&
    Math.abs(current.packQuantity - write.packQuantity) < 1e-6 &&
    current.packUnit === write.packUnit &&
    current.packPriceMinor === write.packPriceMinor &&
    current.supplierId === write.supplierId &&
    current.notes === write.notes &&
    sameBulk
  );
}

function buildSupplyCostAttributes(
  write: SupplyCostWrite,
): readonly Readonly<Record<string, unknown>>[] {
  const scope = {
    kind: "system",
    entityTypeId: "inventory_item",
    schemaRevision: 1,
  };
  const values: Readonly<Record<string, unknown>>[] = [
    listAttr(scope, "currency", { kind: "short_text", value: write.currency }),
    listAttr(scope, "pack_quantity", {
      kind: "decimal",
      value: toScaledDecimal(write.packQuantity),
    }),
    listAttr(scope, "pack_unit", { kind: "short_text", value: write.packUnit }),
    listAttr(scope, "pack_price_minor", {
      kind: "integer",
      value: BigInt(write.packPriceMinor),
    }),
  ];
  if (write.supplierId !== null) {
    values.push(
      listAttr(scope, "supplier_id", {
        kind: "short_text",
        value: write.supplierId,
      }),
    );
  }
  if (write.bulkTier !== null) {
    values.push(
      listAttr(scope, "bulk_min_7d_quantity", {
        kind: "decimal",
        value: toScaledDecimal(write.bulkTier.min7dQuantity),
      }),
      listAttr(scope, "bulk_pack_quantity", {
        kind: "decimal",
        value: toScaledDecimal(write.bulkTier.packQuantity),
      }),
      listAttr(scope, "bulk_pack_price_minor", {
        kind: "integer",
        value: BigInt(write.bulkTier.packPriceMinor),
      }),
    );
  }
  if (write.notes !== null) {
    values.push(
      listAttr(scope, "notes", { kind: "long_text", value: write.notes }),
    );
  }
  return values;
}

function listAttr(
  scope: Readonly<Record<string, unknown>>,
  attributeId: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    attributeId,
    scope,
    definitionRevision: 1,
    sensitivity: "internal",
    value,
  };
}

function toScaledDecimal(
  amount: number,
): Readonly<{ unscaled: number; scale: number }> {
  return {
    unscaled: Math.round(amount * 10 ** QUANTITY_SCALE),
    scale: QUANTITY_SCALE,
  };
}

function readShortText(entry: RawListEntry, attributeId: string): string | null {
  const found = entry.attributeValues.find(
    (attr) => attr.attributeId === attributeId,
  );
  return found?.value.kind === "short_text" ? String(found.value.value) : null;
}

function readLongText(entry: RawListEntry, attributeId: string): string | null {
  const found = entry.attributeValues.find(
    (attr) => attr.attributeId === attributeId,
  );
  return found?.value.kind === "long_text" ? String(found.value.value) : null;
}

function readInteger(entry: RawListEntry, attributeId: string): number | null {
  const found = entry.attributeValues.find(
    (attr) => attr.attributeId === attributeId,
  );
  return found?.value.kind === "integer" ? Number(found.value.value) : null;
}

function readDecimal(entry: RawListEntry, attributeId: string): number | null {
  const found = entry.attributeValues.find(
    (attr) => attr.attributeId === attributeId,
  );
  if (found?.value.kind !== "decimal") {return null;}
  return (
    Number(found.value.value.unscaled) / 10 ** Number(found.value.value.scale)
  );
}

function parseCostUnitOrNull(value: string | null): CostUnit | null {
  switch (value) {
    case "each":
    case "gram":
    case "kilogram":
    case "milliliter":
    case "liter":
      return value;
    default:
      return null;
  }
}

function buildCostProductLinks(
  snapshot: CommerceStockSnapshot,
  photos: ReadonlyMap<string, ProductPhotos> = new Map(),
): CostProductLink[] {
  const resources = snapshot.commerce.resources;
  const offers = saleOffers(resources);
  const productsById = new Map(
    resources.products.map((product) => [product.id, product]),
  );
  const itemsById = new Map(
    resources.inventoryItems.map((item) => [item.id, item]),
  );
  const stockedRecipeByOutputItem = new Map<string, string>();
  const recipeBatchYieldById = new Map<string, number>();

  for (const recipe of snapshot.foodService.resources.recipeRevisions) {
    if (recipe.lifecycle.state !== "active") {continue;}
    if (recipe.output.kind === "stocked") {
      stockedRecipeByOutputItem.set(
        recipe.output.inventoryItemId,
        recipe.recipeId,
      );
      recipeBatchYieldById.set(
        recipe.recipeId,
        Math.max(1, Math.round(scaledQuantityAmount(recipe.output.yieldQuantity))),
      );
    } else {
      recipeBatchYieldById.set(recipe.recipeId, 1);
    }
  }

  const defaultLocationId = resources.locations[0]?.id ?? null;
  const links: CostProductLink[] = [];

  for (const variant of resources.variants) {
    const offer = offers.get(variant.id);
    if (offer === undefined) {continue;}
    const product = productsById.get(variant.productId);
    if (product === undefined || product.status !== "active") {continue;}

    const plan =
      selectInventoryConsumptionPlan(
        snapshot.consumptionPlans,
        variant.id,
        defaultLocationId,
      ) ??
      snapshot.consumptionPlans.find(
        (candidate) =>
          candidate.variantId === variant.id && candidate.lifecycle === "active",
      );

    let fulfillmentKind: "stocked" | "prepared" = "stocked";
    let recipeId: string | null = null;
    let finishedGoodItemId: string | null = null;
    const directPackagingInputs: CostProductLink["directPackagingInputs"] = [];

    if (plan?.mode.kind === "prepared") {
      fulfillmentKind = "prepared";
      recipeId = plan.mode.recipeId;
    } else if (plan?.mode.kind === "direct") {
      fulfillmentKind = "stocked";
      for (const component of plan.mode.components) {
        const componentItem = itemsById.get(component.inventoryItemId);
        if (componentItem?.category === "packaging") {
          directPackagingInputs.push({
            inventoryItemId: component.inventoryItemId,
            quantity: component.quantity,
          });
        } else if (finishedGoodItemId === null) {
          finishedGoodItemId = component.inventoryItemId;
          recipeId =
            stockedRecipeByOutputItem.get(component.inventoryItemId) ?? null;
        }
      }
    }

    const defaultDailyUnits = suggestDefaultDailyUnits(
      product.productType,
      fulfillmentKind,
      recipeId === null ? null : (recipeBatchYieldById.get(recipeId) ?? null),
    );

    const imageUrl =
      variantImageUrl(variant) ?? photos.get(product.id)?.items[0]?.url ?? null;

    links.push({
      productId: product.id,
      productTitle: product.title,
      productType: product.productType,
      variantId: variant.id,
      variantTitle: variant.title,
      offerId: offer.id,
      offerRevision: offer.revision,
      priceMinor: offer.price.amountMinor,
      currency: offer.price.currency,
      fulfillmentKind,
      recipeId,
      finishedGoodItemId,
      directPackagingInputs,
      defaultDailyUnits,
      imageUrl,
    });
  }

  return links;
}

function variantImageUrl(
  variant: CommerceStockSnapshot["commerce"]["resources"]["variants"][number],
): string | null {
  for (const media of variant.media) {
    if (media.kind === "image" && media.url.length > 0) {
      return media.url;
    }
  }
  return null;
}

function suggestDefaultDailyUnits(
  productType: string,
  fulfillmentKind: "stocked" | "prepared",
  batchYield: number | null,
): number {
  const normalized = productType.toLowerCase();
  if (normalized.includes("financier") && !normalized.includes("hotcake"))
    {return 32;}
  if (normalized.includes("hotcake")) {return 10;}
  if (normalized.includes("pie")) {return 16;}
  if (normalized.includes("pastr")) {return 18;}
  if (fulfillmentKind === "prepared" || normalized.includes("drink")) {return 28;}
  if (batchYield !== null && batchYield > 0) {return batchYield;}
  return 20;
}

function detectPrimaryCurrency(
  products: readonly CostProductLink[],
  items: readonly SupplyCostItem[],
): string {
  for (const product of products) {
    if (product.currency.length > 0) {return product.currency;}
  }
  for (const item of items) {
    if (item.costTerms !== null && item.costTerms.currency.length > 0)
      {return item.costTerms.currency;}
  }
  return "JPY";
}

function detectIncludedTax(
  snapshot: CommerceStockSnapshot,
  currency: string,
  profiles: readonly Readonly<{
    checkoutProfileId: string;
    revision: number;
    configuration: Readonly<{
      taxPolicy:
        | Readonly<{
            kind: "merchant_inclusive";
            jurisdictionPolicyId: string;
          }>
        | Readonly<{ kind: "provider_quoted" }>;
    }>;
  }>[],
  activations: readonly Readonly<{
    checkoutProfileId: string;
    checkoutProfileRevision: number;
  }>[],
): Readonly<{
  basisPoints: number;
  source: CostsOverview["includedTaxSource"];
}> {
  for (const order of snapshot.commerce.resources.orders) {
    if (
      order.totals.taxIncluded &&
      order.totals.subtotal.amountMinor > 0 &&
      order.totals.tax.amountMinor > 0
    ) {
      const net =
        order.totals.subtotal.amountMinor - order.totals.tax.amountMinor;
      if (net > 0) {
        const bps = Math.round((order.totals.tax.amountMinor * 10_000) / net);
        return {
          basisPoints: Math.round(bps / 50) * 50,
          source: "orders",
        };
      }
    }
  }
  for (const activation of activations) {
    const profile = profiles.find(
      (candidate) =>
        candidate.checkoutProfileId === activation.checkoutProfileId &&
        candidate.revision === activation.checkoutProfileRevision,
    );
    const taxPolicy = profile?.configuration.taxPolicy;
    if (taxPolicy?.kind === "merchant_inclusive") {
      const parsedBps = /(\d{3,4})$/u.exec(taxPolicy.jurisdictionPolicyId);
      const basisPoints =
        parsedBps !== null
          ? Number(parsedBps[1])
          : currency === "JPY"
            ? 800
            : 0;
      if (basisPoints > 0 && basisPoints <= 10_000) {
        return { basisPoints, source: "checkout_profile" };
      }
    }
  }
  if (currency === "JPY") {
    return { basisPoints: 800, source: "jpy_food_default" };
  }
  return { basisPoints: 0, source: "none" };
}

function summarizeMeasuredWaste(
  snapshot: CommerceStockSnapshot,
  nowMs: number,
): MeasuredWasteSummary {
  const cutoffMs = nowMs - WINDOW_DAYS * DAY_MS;
  const itemCategoryById = new Map(
    snapshot.commerce.resources.inventoryItems.map((item) => [
      item.id,
      item.category,
    ]),
  );

  let stockedUnitsProduced = 0;
  let stockedUnitsWasted = 0;
  let supplyLossMovementsCount = 0;

  for (const movement of snapshot.movements) {
    const occurredMs = Date.parse(movement.occurredAt);
    if (Number.isFinite(occurredMs) && occurredMs < cutoffMs) {continue;}
    const category = itemCategoryById.get(movement.inventoryItemId);
    const amount = scaledQuantityAmount(movement.change.quantity);
    if (category === "finished_good") {
      if (
        movement.change.kind === "increase" &&
        (movement.change.reason.kind === "production" ||
          movement.change.reason.kind === "receipt")
      ) {
        stockedUnitsProduced += amount;
      } else if (
        movement.change.kind === "decrease" &&
        (movement.change.reason.kind === "waste" ||
          movement.change.reason.kind === "damage")
      ) {
        stockedUnitsWasted += amount;
      }
    } else if (
      movement.change.kind === "decrease" &&
      (movement.change.reason.kind === "waste" ||
        movement.change.reason.kind === "damage")
    ) {
      supplyLossMovementsCount += 1;
    }
  }

  for (const lot of snapshot.lots) {
    const category = itemCategoryById.get(lot.inventoryItemId);
    if (category !== "finished_good") {continue;}
    if (lot.lifecycle.state === "expired") {
      stockedUnitsWasted += scaledQuantityAmount(lot.remainingQuantity);
    }
  }

  let plannedBatchUnits = 0;
  let actualBatchUnits = 0;
  for (const batch of snapshot.foodService.resources.productionBatches) {
    const completedMs = Date.parse(batch.completedAt);
    if (Number.isFinite(completedMs) && completedMs < cutoffMs) {continue;}
    plannedBatchUnits += scaledQuantityAmount(batch.plannedYield);
    actualBatchUnits += scaledQuantityAmount(batch.actualYield);
  }

  const measuredShelfWastePct =
    stockedUnitsProduced > 0 && stockedUnitsWasted > 0
      ? Math.min(100, (stockedUnitsWasted / stockedUnitsProduced) * 100)
      : stockedUnitsWasted > 0
        ? Math.min(100, stockedUnitsWasted)
        : null;

  const measuredBatchRejectPct =
    plannedBatchUnits > 0
      ? Math.max(
          0,
          Math.min(
            100,
            ((plannedBatchUnits - actualBatchUnits) / plannedBatchUnits) * 100,
          ),
        )
      : null;

  return {
    windowDays: WINDOW_DAYS,
    stockedUnitsProduced: roundMetric(stockedUnitsProduced),
    stockedUnitsWasted: roundMetric(stockedUnitsWasted),
    measuredShelfWastePct:
      measuredShelfWastePct === null ? null : roundMetric(measuredShelfWastePct),
    plannedBatchUnits: roundMetric(plannedBatchUnits),
    actualBatchUnits: roundMetric(actualBatchUnits),
    measuredBatchRejectPct:
      measuredBatchRejectPct === null
        ? null
        : roundMetric(measuredBatchRejectPct),
    supplyLossMovementsCount,
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeSupplyOnHandByItemId(
  snapshot: CommerceStockSnapshot,
): ReadonlyMap<string, number | null> {
  const usableByPositionId = new Map(
    snapshot.usable.map((entry) => [entry.positionId, entry.quantity]),
  );
  const positionsByItemId = new Map<
    string,
    CommerceStockSnapshot["commerce"]["resources"]["inventoryPositions"][number][]
  >();
  for (const pos of snapshot.commerce.resources.inventoryPositions) {
    const list = positionsByItemId.get(pos.inventoryItemId) ?? [];
    list.push(pos);
    positionsByItemId.set(pos.inventoryItemId, list);
  }
  const itemBaseUnit = new Map(
    snapshot.commerce.resources.inventoryItems.map((i) => [i.id, i.baseUnit]),
  );
  const lotStatsByItemId = new Map<
    string,
    Readonly<{ totalBase: number; lotCount: number }>
  >();
  for (const lot of snapshot.lots) {
    const baseUnit = itemBaseUnit.get(lot.inventoryItemId);
    if (baseUnit === undefined) continue;
    const prev = lotStatsByItemId.get(lot.inventoryItemId) ?? {
      totalBase: 0,
      lotCount: 0,
    };
    const remBase =
      lot.lifecycle.state === "available"
        ? convertCostQuantity(
            scaledQuantityAmount(lot.remainingQuantity),
            lot.remainingQuantity.unit,
            baseUnit,
          )
        : 0;
    lotStatsByItemId.set(lot.inventoryItemId, {
      totalBase: prev.totalBase + Math.max(0, remBase ?? 0),
      lotCount: prev.lotCount + 1,
    });
  }

  const out = new Map<string, number | null>();
  for (const item of snapshot.commerce.resources.inventoryItems) {
    if (item.category === "finished_good") {
      out.set(item.id, null);
      continue;
    }
    const positions = positionsByItemId.get(item.id) ?? [];
    let counted = false;
    let sumBase = 0;
    for (const pos of positions) {
      const usableQty = usableByPositionId.has(pos.id)
        ? (usableByPositionId.get(pos.id) ?? null)
        : pos.balance.available;
      if (usableQty === null) continue;
      const converted = convertCostQuantity(
        scaledQuantityAmount(usableQty),
        usableQty.unit,
        item.baseUnit,
      );
      if (converted === null) continue;
      counted = true;
      sumBase += Math.max(0, converted);
    }
    if (counted) {
      out.set(item.id, roundMetric(sumBase));
      continue;
    }
    const lotStats = lotStatsByItemId.get(item.id);
    if (lotStats !== undefined && lotStats.lotCount > 0) {
      out.set(item.id, roundMetric(lotStats.totalBase));
    } else {
      out.set(item.id, null);
    }
  }
  return out;
}

function buildSupplyLotCosts(
  snapshot: CommerceStockSnapshot,
  lotInvoiceCosts: ReadonlyMap<string, SupplyLotInvoiceCost>,
  replenishmentPayables: ReadonlyMap<string, ReplenishmentPayableSummary>,
  nowMs: number,
): SupplyLotCost[] {
  const itemsById = new Map(
    snapshot.commerce.resources.inventoryItems.map((item) => [item.id, item]),
  );
  const movementsById = new Map(
    snapshot.movements.map((movement) => [movement.id, movement]),
  );
  const fallbackIso = new Date(nowMs).toISOString();
  const out: SupplyLotCost[] = [];

  for (const lot of snapshot.lots) {
    const item = itemsById.get(lot.inventoryItemId);
    if (item === undefined || item.category === "finished_good") {
      continue;
    }
    const movement = movementsById.get(lot.sourceMovementId);
    const receivedAt = movement?.occurredAt ?? fallbackIso;
    const expiresAt =
      lot.expiry.kind === "expires" ? lot.expiry.expiresAt : null;
    const receivedQuantity = Math.max(
      0.000_001,
      roundMetric(scaledQuantityAmount(lot.receivedQuantity)),
    );
    const remainingQuantity = Math.max(
      0,
      roundMetric(scaledQuantityAmount(lot.remainingQuantity)),
    );
    const lifecycle: SupplyLotCost["lifecycle"] =
      lot.lifecycle.state === "available"
        ? "active"
        : lot.lifecycle.state === "depleted"
          ? "depleted"
          : "expired";

    let receiptId: string | null = null;
    let purchaseRequestId: string | null = null;
    if (
      movement?.change.kind === "increase" &&
      movement.change.reason.kind === "receipt"
    ) {
      receiptId = String(movement.change.reason.receiptId);
      if (movement.change.reason.purchase.kind === "replenishment") {
        purchaseRequestId = String(movement.change.reason.purchase.entryId);
      }
    }

    const explicitInvoice = lotInvoiceCosts.get(lot.id) ?? null;
    const payable =
      explicitInvoice === null && purchaseRequestId !== null
        ? (replenishmentPayables.get(purchaseRequestId) ?? null)
        : null;
    const invoiceCost: SupplyLotInvoiceCost | null =
      explicitInvoice ??
      (payable !== null
        ? {
            revision: payable.revision,
            source: "supplier_payable",
            currency: payable.currency,
            invoicedQuantity: receivedQuantity,
            invoicedUnit: lot.receivedQuantity.unit,
            invoiceTotalMinor: payable.grossAmountMinor,
            invoiceReference: payable.payableId,
            supplierId: payable.supplierId,
          }
        : null);

    out.push({
      id: lot.id,
      inventoryItemId: lot.inventoryItemId,
      locationId: lot.locationId,
      lotCode: lot.lotCode,
      receivedAt,
      expiresAt,
      receivedQuantity,
      remainingQuantity,
      baseUnit: item.baseUnit,
      lifecycle,
      sourceMovementId: lot.sourceMovementId,
      receiptId,
      purchaseRequestId,
      invoiceCost,
    });
  }

  return out.sort(
    (left, right) =>
      left.receivedAt.localeCompare(right.receivedAt) ||
      left.id.localeCompare(right.id),
  );
}

type MutableProductActuals = {
  unitsSold: number;
  posUnitsSold: number;
  onlineUnitsSold: number;
  grossSalesMinor: number;
  includedTaxMinor: number;
  batchCount: number;
  plannedBatchUnits: number;
  actualBatchUnits: number;
  stockedUnitsProduced: number;
  stockedUnitsWasted: number;
};

function summarizeCostsActuals(
  snapshot: CommerceStockSnapshot,
  products: readonly CostProductLink[],
  replenishmentPayables: ReadonlyMap<string, ReplenishmentPayableSummary>,
  currency: string,
  nowMs: number,
): CostsActualsSnapshot {
  const productIdByVariantId = new Map<string, string>();
  const productIdByOfferId = new Map<string, string>();
  const productIdsByRecipeId = new Map<string, string[]>();
  const productIdsByFinishedGoodItemId = new Map<string, string[]>();

  for (const link of products) {
    productIdByVariantId.set(link.variantId, link.productId);
    productIdByOfferId.set(link.offerId, link.productId);
    if (link.recipeId !== null) {
      const list = productIdsByRecipeId.get(link.recipeId) ?? [];
      list.push(link.productId);
      productIdsByRecipeId.set(link.recipeId, list);
    }
    if (link.finishedGoodItemId !== null) {
      const list =
        productIdsByFinishedGoodItemId.get(link.finishedGoodItemId) ?? [];
      list.push(link.productId);
      productIdsByFinishedGoodItemId.set(link.finishedGoodItemId, list);
    }
  }

  const itemsById = new Map(
    snapshot.commerce.resources.inventoryItems.map((item) => [item.id, item]),
  );

  const windowSpans: readonly ActualsWindowDays[] = [7, 30];
  const windows: CostsActualsWindowSnapshot[] = windowSpans.map(
    (windowDays) => {
      const cutoffMs = nowMs - windowDays * DAY_MS;
      const windowStartAt = new Date(cutoffMs).toISOString();
      const windowEndAt = new Date(nowMs).toISOString();

      const byProductId = new Map<string, MutableProductActuals>();
      const ensureProduct = (productId: string): MutableProductActuals => {
        let existing = byProductId.get(productId);
        if (existing === undefined) {
          existing = {
            unitsSold: 0,
            posUnitsSold: 0,
            onlineUnitsSold: 0,
            grossSalesMinor: 0,
            includedTaxMinor: 0,
            batchCount: 0,
            plannedBatchUnits: 0,
            actualBatchUnits: 0,
            stockedUnitsProduced: 0,
            stockedUnitsWasted: 0,
          };
          byProductId.set(productId, existing);
        }
        return existing;
      };

      let orderCount = 0;
      let posOrderCount = 0;
      let onlineOrderCount = 0;
      let grossSalesMinor = 0;
      let includedTaxMinor = 0;
      let refundsMinor = 0;

      for (const order of snapshot.commerce.resources.orders) {
        if (order.lifecycle.state === "cancelled") {
          continue;
        }
        const occurredMs = Date.parse(order.occurredAt);
        if (Number.isFinite(occurredMs) && occurredMs < cutoffMs) {
          continue;
        }
        if (order.totals.total.currency !== currency) {
          continue;
        }

        orderCount += 1;
        const isPos = order.origin.kind === "point_of_sale";
        if (isPos) {
          posOrderCount += 1;
        } else {
          onlineOrderCount += 1;
        }

        const taxIncluded = order.totals.taxIncluded === true;
        grossSalesMinor += Math.max(
          0,
          order.totals.subtotal.amountMinor - order.totals.discount.amountMinor,
        );
        if (taxIncluded) {
          includedTaxMinor += order.totals.tax.amountMinor;
        }

        for (const adjustment of order.adjustments) {
          if (
            adjustment.status === "completed" &&
            (adjustment.kind === "refund" ||
              adjustment.kind === "credit" ||
              adjustment.kind === "price_adjustment") &&
            adjustment.amount.currency === currency
          ) {
            refundsMinor += adjustment.amount.amountMinor;
          }
        }

        for (const line of order.lineItems) {
          if (
            line.source.kind !== "catalog" &&
            line.source.kind !== "food_service"
          ) {
            continue;
          }
          const productId =
            productIdByVariantId.get(line.source.variantId) ??
            productIdByOfferId.get(line.source.offerId);
          if (productId === undefined) {
            continue;
          }
          const qty = Math.max(0, scaledQuantityAmount(line.quantity));
          const acc = ensureProduct(productId);
          acc.unitsSold += qty;
          if (isPos) {
            acc.posUnitsSold += qty;
          } else {
            acc.onlineUnitsSold += qty;
          }
          acc.grossSalesMinor += line.lineTotal.amountMinor;
          if (taxIncluded) {
            acc.includedTaxMinor += line.tax.amountMinor;
          }
        }
      }

      for (const batch of snapshot.foodService.resources.productionBatches) {
        const completedMs = Date.parse(batch.completedAt);
        if (Number.isFinite(completedMs) && completedMs < cutoffMs) {
          continue;
        }
        const linkedIds = productIdsByRecipeId.get(batch.recipeId) ?? [];
        if (linkedIds.length === 0) {
          continue;
        }
        const share = 1 / linkedIds.length;
        const planned =
          Math.max(0, scaledQuantityAmount(batch.plannedYield)) * share;
        const actual =
          Math.max(0, scaledQuantityAmount(batch.actualYield)) * share;
        for (const pid of linkedIds) {
          const acc = ensureProduct(pid);
          acc.batchCount += 1;
          acc.plannedBatchUnits += planned;
          acc.actualBatchUnits += actual;
        }
      }

      const supplyLossMap = new Map<
        string,
        { movementCount: number; wastedBaseQuantity: number }
      >();
      const addSupplyLoss = (itemId: string, baseQty: number) => {
        if (baseQty <= 0) {
          return;
        }
        const prev = supplyLossMap.get(itemId) ?? {
          movementCount: 0,
          wastedBaseQuantity: 0,
        };
        supplyLossMap.set(itemId, {
          movementCount: prev.movementCount + 1,
          wastedBaseQuantity: prev.wastedBaseQuantity + baseQty,
        });
      };

      for (const movement of snapshot.movements) {
        const occurredMs = Date.parse(movement.occurredAt);
        if (Number.isFinite(occurredMs) && occurredMs < cutoffMs) {
          continue;
        }
        const item = itemsById.get(movement.inventoryItemId);
        if (item === undefined) {
          continue;
        }
        const rawQty = Math.max(0, scaledQuantityAmount(movement.change.quantity));
        if (rawQty <= 0) {
          continue;
        }
        if (item.category === "finished_good") {
          const linkedIds = productIdsByFinishedGoodItemId.get(item.id) ?? [];
          if (linkedIds.length === 0) {
            continue;
          }
          const shareQty = rawQty / linkedIds.length;
          if (
            movement.change.kind === "increase" &&
            (movement.change.reason.kind === "production" ||
              movement.change.reason.kind === "receipt")
          ) {
            for (const pid of linkedIds) {
              ensureProduct(pid).stockedUnitsProduced += shareQty;
            }
          } else if (
            movement.change.kind === "decrease" &&
            (movement.change.reason.kind === "waste" ||
              movement.change.reason.kind === "damage")
          ) {
            for (const pid of linkedIds) {
              ensureProduct(pid).stockedUnitsWasted += shareQty;
            }
          }
        } else if (
          movement.change.kind === "decrease" &&
          (movement.change.reason.kind === "waste" ||
            movement.change.reason.kind === "damage")
        ) {
          const converted =
            convertCostQuantity(
              rawQty,
              movement.change.quantity.unit,
              item.baseUnit,
            ) ?? rawQty;
          addSupplyLoss(item.id, converted);
        }
      }

      for (const lot of snapshot.lots) {
        if (lot.lifecycle.state !== "expired") {
          continue;
        }
        const expiredMs =
          lot.expiry.kind === "expires"
            ? Date.parse(lot.expiry.expiresAt)
            : Number.NaN;
        if (Number.isFinite(expiredMs) && expiredMs < cutoffMs) {
          continue;
        }
        const item = itemsById.get(lot.inventoryItemId);
        if (item === undefined) {
          continue;
        }
        const remQty = Math.max(0, scaledQuantityAmount(lot.remainingQuantity));
        if (remQty <= 0) {
          continue;
        }
        if (item.category === "finished_good") {
          const linkedIds = productIdsByFinishedGoodItemId.get(item.id) ?? [];
          for (const pid of linkedIds) {
            ensureProduct(pid).stockedUnitsWasted += remQty / linkedIds.length;
          }
        } else {
          const converted =
            convertCostQuantity(
              remQty,
              lot.remainingQuantity.unit,
              item.baseUnit,
            ) ?? remQty;
          addSupplyLoss(item.id, converted);
        }
      }

      let settledPayablesMinor = 0;
      let openPayablesMinor = 0;
      let payableCount = 0;
      for (const payable of replenishmentPayables.values()) {
        if (payable.currency !== currency) {
          continue;
        }
        if (payable.updatedAtMs > 0 && payable.updatedAtMs < cutoffMs) {
          continue;
        }
        payableCount += 1;
        settledPayablesMinor += payable.settledMinor;
        openPayablesMinor += Math.max(
          0,
          payable.grossAmountMinor - payable.settledMinor,
        );
      }

      const productObservations: ProductActualsObservation[] = [
        ...byProductId.entries(),
      ]
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
        .map(([productId, acc]) => ({
          productId,
          unitsSold: roundMetric(acc.unitsSold),
          posUnitsSold: roundMetric(acc.posUnitsSold),
          onlineUnitsSold: roundMetric(acc.onlineUnitsSold),
          grossSalesMinor: Math.round(acc.grossSalesMinor),
          includedTaxMinor: Math.round(acc.includedTaxMinor),
          batchCount: acc.batchCount,
          plannedBatchUnits: roundMetric(acc.plannedBatchUnits),
          actualBatchUnits: roundMetric(acc.actualBatchUnits),
          stockedUnitsProduced: roundMetric(acc.stockedUnitsProduced),
          stockedUnitsWasted: roundMetric(acc.stockedUnitsWasted),
        }));

      const supplyLosses: SupplyActualLossObservation[] = [
        ...supplyLossMap.entries(),
      ]
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
        .map(([inventoryItemId, entry]) => ({
          inventoryItemId,
          movementCount: entry.movementCount,
          wastedBaseQuantity: roundMetric(entry.wastedBaseQuantity),
        }));

      return {
        windowDays,
        windowStartAt,
        windowEndAt,
        orderCount,
        posOrderCount,
        onlineOrderCount,
        grossSalesMinor: Math.round(grossSalesMinor),
        includedTaxMinor: Math.round(includedTaxMinor),
        refundsMinor: Math.round(refundsMinor),
        settledPayablesMinor,
        openPayablesMinor,
        payableCount,
        products: productObservations,
        supplyLosses,
      };
    },
  );

  return { windows };
}
