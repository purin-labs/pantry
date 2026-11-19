// Removes a product that was never sold. The order, checkout and price records
// hold a variant in JSON, so no foreign key protects them: each refusal below
// is the protection.
import {
  productDeleteBlock,
  type DeleteCommerceProductV1,
  type ProductDeleteRefusal,
  type CommerceResourcesV1,
  type CommerceInventoryItemV1,
  type CommerceMenuV1,
  type CommerceMutationErrorV1,
  type CommerceOfferV1,
  type CommerceProductV1,
  type CommerceVariantV1,
} from "@purin-labs/commerce-client";

import { listConsumptionPlansForVariant } from "../checkout-persistence.ts";
import type { CommerceDatabase } from "../database.ts";
import { refreshCommerceRelationshipRelation } from "../entity-plane/commerce-relationship-relation.ts";
import {
  deleteCommerceEntityRelationText,
  writeCommerceEntityRelationText,
} from "../entity-plane/relation-text.ts";
import {
  removeProductFromCollections,
  type CollectionAuthority,
} from "../plugins/collections/index.ts";
import { companyCitesVariant } from "../plugins/companies/index.ts";
import { discountCitesProduct } from "../plugins/discounts/index.ts";
import { draftOrderCitesVariant } from "../plugins/draft-orders/index.ts";
import { deleteVariantSoldOutMarks } from "../plugins/food-service/index.ts";
import { marketCitesVariant } from "../plugins/markets/index.ts";
import { removeProductMedia } from "../plugins/media/index.ts";
import type { CommerceMutation, MerchantRow } from "./ledger.ts";

export type ProductDeletionPlan = Readonly<{
  command: DeleteCommerceProductV1;
  product: CommerceProductV1;
  variants: readonly CommerceVariantV1[];
  offers: readonly CommerceOfferV1[];
  consumptionPlanIds: readonly string[];
  retiredItems: readonly CommerceInventoryItemV1[];
}>;

type ProductDeletionPlanResult =
  | Readonly<{ kind: "planned"; value: ProductDeletionPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planProductDeletion(
  database: CommerceDatabase,
  command: DeleteCommerceProductV1,
  resources: CommerceResourcesV1,
  menus: readonly CommerceMenuV1[],
  now: string,
): ProductDeletionPlanResult {
  const { merchantId, productId } = command;
  const product = resources.products.find((item) => item.id === productId);
  if (product === undefined)
    return {
      kind: "rejected",
      error: { code: "resource_not_found", kind: "product", id: productId },
    };
  if (product.revision !== command.expectedProductRevision)
    return {
      kind: "rejected",
      error: {
        code: "stale_resource_revision",
        kind: "product",
        id: productId,
        expected: command.expectedProductRevision,
        actual: product.revision,
      },
    };
  const variants = resources.variants.filter(
    (variant) => variant.productId === productId,
  );
  const variantIds = new Set(variants.map((variant) => variant.id));
  const offers = resources.offers.filter((offer) =>
    variantIds.has(offer.variantId),
  );
  const consumptionPlans = variants.flatMap((variant) =>
    listConsumptionPlansForVariant(database, merchantId, variant.id),
  );
  const consumptionPlanIds = consumptionPlans.map(
    (plan) => plan.consumptionPlanId,
  );
  const retiredItems = itemsOnlyThisProductConsumes(
    database,
    merchantId,
    resources,
    consumptionPlans.flatMap((plan) =>
      plan.mode.kind === "direct"
        ? plan.mode.components.map((part) => part.inventoryItemId)
        : [],
    ),
    consumptionPlanIds,
  );
  const reason =
    productDeleteBlock(productId, resources, menus) ??
    openRecordRefusal(
      database,
      merchantId,
      productId,
      [...variantIds],
      offers.map((offer) => offer.id),
      retiredItems,
      now,
    );
  if (reason !== null)
    return {
      kind: "rejected",
      error: { code: "product_delete_refused", productId, reason },
    };
  return {
    kind: "planned",
    value: {
      command,
      product,
      variants,
      offers,
      consumptionPlanIds,
      retiredItems,
    },
  };
}

/** The finished goods that have no consumer left after this product goes. */
function itemsOnlyThisProductConsumes(
  database: CommerceDatabase,
  merchantId: string,
  resources: CommerceResourcesV1,
  itemIds: readonly string[],
  consumptionPlanIds: readonly string[],
): readonly CommerceInventoryItemV1[] {
  const ownPlans = new Set(consumptionPlanIds);
  return resources.inventoryItems.filter((item) => {
    if (
      !itemIds.includes(item.id) ||
      item.category !== "finished_good" ||
      item.lifecycle !== "active"
    )
      return false;
    const consumers = database
      .prepare(
        `SELECT consumption_plan_id AS consumptionPlanId
         FROM inventory_consumption_requirement
         WHERE merchant_id = ? AND inventory_item_id = ?`,
      )
      .all<Readonly<{ consumptionPlanId: string }>>(merchantId, item.id);
    return consumers.every((row) => ownPlans.has(row.consumptionPlanId));
  });
}

function openRecordRefusal(
  database: CommerceDatabase,
  merchantId: string,
  productId: string,
  variantIds: readonly string[],
  offerIds: readonly string[],
  retiredItems: readonly CommerceInventoryItemV1[],
  now: string,
): ProductDeleteRefusal | null {
  const exists = (sql: string, ...bindings: readonly string[]): boolean =>
    database.prepare(sql).get(merchantId, ...bindings) !== undefined;
  for (const variantId of variantIds) {
    // An order older than 180 days moves to R2; its accepted checkout stays.
    if (
      exists(
        `SELECT 1 FROM buyer_checkout
         WHERE merchant_id = ? AND instr(checkout_json, ?) > 0
           AND lifecycle_state = 'accepted' LIMIT 1`,
        variantId,
      )
    )
      return "sold";
    if (
      exists(
        `SELECT 1 FROM buyer_checkout
         WHERE merchant_id = ? AND instr(checkout_json, ?) > 0 AND (
           lifecycle_state = 'payment_pending' OR
           (lifecycle_state = 'quoted' AND
            json_extract(checkout_json, '$.lifecycle.quote.expiresAt') > ?)
         ) LIMIT 1`,
        variantId,
        now,
      )
    )
      return "open_checkout";
    if (draftOrderCitesVariant(database, merchantId, variantId))
      return "draft_order";
    if (
      marketCitesVariant(database, merchantId, variantId) ||
      companyCitesVariant(database, merchantId, variantId)
    )
      return "price_list";
  }
  for (const item of retiredItems)
    if (
      exists(
        `SELECT 1 FROM inventory_allocation
         WHERE merchant_id = ? AND inventory_item_id = ?
           AND lifecycle_state IN ('held', 'allocated_to_order') LIMIT 1`,
        item.id,
      )
    )
      return "reserved_stock";
  if (discountCitesProduct(database, merchantId, productId)) return "discount";
  for (const entityId of [productId, ...variantIds, ...offerIds])
    if (
      exists(
        `SELECT 1 FROM commerce_list_entry
         WHERE merchant_id = ? AND entity_id = ?
           AND lifecycle_state = 'active' LIMIT 1`,
        entityId,
      ) ||
      exists(
        `SELECT 1 FROM commerce_relationship
         WHERE merchant_id = ? AND lifecycle_state = 'active'
           AND (source_entity_id = ? OR target_entity_id = ?) LIMIT 1`,
        entityId,
        entityId,
      )
    )
      return "linked_record";
  return null;
}

export function productDeletionMutation(
  merchant: MerchantRow,
  plan: ProductDeletionPlan,
  committedAt: string,
  collections: CollectionAuthority,
): CommerceMutation {
  const { command, product } = plan;
  const retiredItems = plan.retiredItems.map((item) => ({
    ...item,
    revision: item.revision + 1,
    lifecycle: "inactive" as const,
    occurredAt: committedAt,
  }));
  return {
    command,
    merchant,
    committedAt,
    commandKind: "delete_product",
    resource: {
      kind: "product",
      id: product.id,
      revision: product.revision + 1,
    },
    observations: retiredItems.map((resource) => ({
      kind: "inventory_item" as const,
      resource,
    })),
    write: (database) => {
      writeDeletion(database, plan, retiredItems);
      // Automated collection members change with the catalog, under the
      // same receipt.
      collections.refreshAutomated(command.merchantId);
    },
  };
}

function writeDeletion(
  database: CommerceDatabase,
  plan: ProductDeletionPlan,
  retiredItems: readonly CommerceInventoryItemV1[],
): void {
  const merchantId = plan.command.merchantId;
  const remove = (sql: string, ...bindings: readonly string[]): void => {
    database.prepare(sql).run(merchantId, ...bindings);
  };
  for (const offer of plan.offers) {
    remove(
      "DELETE FROM offer_price_policy WHERE merchant_id = ? AND offer_id = ?",
      offer.id,
    );
    remove(
      "DELETE FROM offer WHERE merchant_id = ? AND resource_id = ?",
      offer.id,
    );
    removeEntity(database, merchantId, "offer", offer.id);
  }
  for (const consumptionPlanId of plan.consumptionPlanIds) {
    remove(
      `DELETE FROM inventory_consumption_requirement
       WHERE merchant_id = ? AND consumption_plan_id = ?`,
      consumptionPlanId,
    );
    remove(
      `DELETE FROM inventory_consumption_plan
       WHERE merchant_id = ? AND consumption_plan_id = ?`,
      consumptionPlanId,
    );
  }
  for (const variant of plan.variants) {
    remove(
      `DELETE FROM variant_shipping_specification
       WHERE merchant_id = ? AND variant_id = ?`,
      variant.id,
    );
    deleteVariantSoldOutMarks(database, merchantId, variant.id);
    database
      .prepare(
        `UPDATE buyer_cart SET revision = revision + 1
         WHERE merchant_id = ?1 AND cart_id IN (
           SELECT cart_id FROM buyer_cart_line
           WHERE merchant_id = ?1 AND variant_id = ?2
         )`,
      )
      .run(merchantId, variant.id);
    remove(
      "DELETE FROM buyer_cart_line WHERE merchant_id = ? AND variant_id = ?",
      variant.id,
    );
    remove(
      "DELETE FROM sellable_variant WHERE merchant_id = ? AND resource_id = ?",
      variant.id,
    );
    removeEntity(database, merchantId, "sellable_variant", variant.id);
  }
  const productId = plan.product.id;
  removeProductFromCollections(database, merchantId, productId);
  removeProductMedia(database, merchantId, productId);
  remove(
    "DELETE FROM product WHERE merchant_id = ? AND resource_id = ?",
    productId,
  );
  removeEntity(database, merchantId, "product", productId);
  for (const item of retiredItems) {
    database
      .prepare(
        `UPDATE inventory_item SET revision = ?, lifecycle = ?, occurred_at = ?
         WHERE merchant_id = ? AND inventory_item_id = ?`,
      )
      .run(item.revision, item.lifecycle, item.occurredAt, merchantId, item.id);
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "system",
      "inventory_item",
      item.id,
      item.revision,
      item.occurredAt,
      item.name,
    );
  }
  refreshCommerceRelationshipRelation(database, merchantId);
}

function removeEntity(
  database: CommerceDatabase,
  merchantId: string,
  entityType: "product" | "sellable_variant" | "offer",
  entityId: string,
): void {
  database
    .prepare(
      `DELETE FROM system_entity_extension_value
       WHERE merchant_id = ? AND system_entity_type_id = ? AND system_entity_id = ?`,
    )
    .run(merchantId, entityType, entityId);
  deleteCommerceEntityRelationText(
    database,
    merchantId,
    "system",
    entityType,
    entityId,
  );
}
