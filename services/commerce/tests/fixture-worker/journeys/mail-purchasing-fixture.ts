import type { CommerceDatabase } from "../../../src/database.ts";
import type { EntityPlaneService } from "../../../src/entity-plane/service.ts";
import { writeCommerceEntityRelationText } from "../../../src/entity-plane/relation-text.ts";
import { refreshCommerceAttributeRelation } from "../../../src/entity-plane/commerce-attribute-relation.ts";
import { parseOrder, parseSalesChannel } from "@purin-labs/commerce-client";
import {
  writeOrder,
  writeSalesChannel,
} from "../../../src/commerce-persistence.ts";

export function seedMailPurchasing(
  database: CommerceDatabase,
  service: EntityPlaneService,
  merchantId: string,
  organisationId: string,
): void {
  service.seedPurchasingPreset(merchantId);
  const now = new Date().toISOString();
  for (const [supplierId, address, displayName] of [
    ["supplier_packaging", "supplier@example.test", "Packaging supplier"],
    ["supplier_hidden", "hidden@example.test", "Hidden supplier"],
  ]) {
    if (
      supplierId === undefined ||
      address === undefined ||
      displayName === undefined
    )
      throw new Error("Incomplete purchasing fixture");
    seedSupplier(database, merchantId, supplierId, address, displayName, now);
    const stockPolicyId = `stock_${supplierId}`;
    database
      .prepare(
        "INSERT INTO food_service_resource (merchant_id, resource_kind, resource_id, revision, lifecycle_state, resource_json) VALUES (?, 'stock_policy', ?, 1, 'active', ?)",
      )
      .run(
        merchantId,
        stockPolicyId,
        JSON.stringify({
          provenance: {
            organisationId,
            integrationAccountId: "commerce",
            source: "commerce",
            resourceType: "stock_policy",
            resourceId: stockPolicyId,
            revision: 1,
            occurredAt: now,
            observedAt: now,
          },
          stockPolicyId,
          inventoryItemId: `item_${supplierId}`,
          locationId: "cafe",
          revision: 1,
          replenishment: {
            kind: "threshold",
            reorderPoint: { amount: 10, scale: 0, unit: "each" },
            targetQuantity: { amount: 20, scale: 0, unit: "each" },
          },
          lifecycle: "active",
        }),
      );
    writeCommerceEntityRelationText(
      database,
      merchantId,
      "system",
      "stock_policy",
      stockPolicyId,
      1,
      now,
      stockPolicyId,
    );
    const entryId = `request_${supplierId}`;
    database
      .prepare(
        "INSERT INTO commerce_list_entry (merchant_id, entry_id, list_id, list_revision, entity_origin, entity_type_id, entity_id, revision, lifecycle_state, created_at, updated_at, updated_at_ms, membership_kind) VALUES (?, ?, 'replenishment_queue', 1, 'system', 'stock_policy', ?, 1, 'active', ?, ?, ?, 'repeatable_entity')",
      )
      .run(merchantId, entryId, stockPolicyId, now, now, Date.parse(now));
    insertTextAttribute(
      database,
      merchantId,
      entryId,
      "supplier_id",
      supplierId,
    );
    insertTextAttribute(
      database,
      merchantId,
      entryId,
      "purchase_request_id",
      "PR-A",
    );
    insertTextAttribute(
      database,
      merchantId,
      entryId,
      "owner",
      "Purchasing operator",
    );
    insertTextAttribute(
      database,
      merchantId,
      entryId,
      "inventory_item_id",
      `item_${supplierId}`,
    );
    insertTextAttribute(database, merchantId, entryId, "location_id", "cafe");
    insertTextAttribute(database, merchantId, entryId, "quantity_unit", "each");
    database
      .prepare(
        "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, timestamp_value) VALUES (?, ?, 1, 'opened_at', 1, 'timestamp', ?)",
      )
      .run(merchantId, entryId, now);
    for (const [attributeId, unscaled] of [
      ["available_quantity", 0],
      ["reorder_point", 10],
      ["target_quantity", 20],
      ["required_quantity", 20],
      ["received_quantity", 0],
    ] as const) {
      database
        .prepare(
          "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, decimal_value) VALUES (?, ?, 1, ?, 1, 'decimal', ?)",
        )
        .run(
          merchantId,
          entryId,
          attributeId,
          JSON.stringify({ unscaled: unscaled * 1_000_000, scale: 6 }),
        );
    }
    database
      .prepare(
        "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, status_value) VALUES (?, ?, 1, 'status', 1, 'status', 'late')",
      )
      .run(merchantId, entryId);
    database
      .prepare(
        "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, timestamp_value) VALUES (?, ?, 1, 'expected_delivery_at', 1, 'timestamp', ?)",
      )
      .run(merchantId, entryId, "2026-09-29T03:00:00.000Z");
    database
      .prepare(
        "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, long_text_value) VALUES (?, ?, 1, 'notes', 1, 'long_text', ?)",
      )
      .run(
        merchantId,
        entryId,
        supplierId === "supplier_hidden"
          ? "HIDDEN_PURCHASING_NOTE"
          : "INTERNAL_PURCHASING_NOTE",
      );
  }
  advanceMerchant(database, merchantId);
}

export function makeMailSupplierAmbiguous(
  database: CommerceDatabase,
  merchantId: string,
): void {
  seedSupplier(
    database,
    merchantId,
    "supplier_duplicate",
    "supplier@example.test",
    "Second packaging supplier",
    new Date().toISOString(),
  );
  advanceMerchant(database, merchantId);
}

function seedSupplier(
  database: CommerceDatabase,
  merchantId: string,
  supplierId: string,
  address: string,
  displayName: string,
  now: string,
): void {
  database
    .prepare(
      "INSERT INTO custom_entity (merchant_id, entity_id, entity_type_id, entity_type_revision, revision, lifecycle_state, display_name, sensitivity, created_at, updated_at) VALUES (?, ?, 'trade_partner', 1, 1, 'active', ?, 'internal', ?, ?)",
    )
    .run(merchantId, supplierId, displayName, now, now);
  database
    .prepare(
      "INSERT INTO custom_entity_attribute_value (merchant_id, entity_id, entity_revision, attribute_id, value_kind, short_text_value) VALUES (?, ?, 1, 'legal_name', 'short_text', ?)",
    )
    .run(merchantId, supplierId, supplierId);
  const entryId = `directory_${supplierId}`;
  database
    .prepare(
      "INSERT INTO commerce_list_entry (merchant_id, entry_id, list_id, list_revision, entity_origin, entity_type_id, entity_id, revision, lifecycle_state, created_at, updated_at, updated_at_ms, membership_kind) VALUES (?, ?, 'supplier_directory', 1, 'custom', 'trade_partner', ?, 1, 'active', ?, ?, ?, 'unique_entity')",
    )
    .run(merchantId, entryId, supplierId, now, now, Date.parse(now));
  insertTextAttribute(database, merchantId, entryId, "email", address);
  database
    .prepare(
      "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, integer_value) VALUES (?, ?, 1, 'lead_time_days', 1, 'integer', 3)",
    )
    .run(merchantId, entryId);
  writeCommerceEntityRelationText(
    database,
    merchantId,
    "custom",
    "trade_partner",
    supplierId,
    1,
    now,
    displayName,
  );
}
function insertTextAttribute(
  database: CommerceDatabase,
  merchantId: string,
  entryId: string,
  attributeId: string,
  value: string,
): void {
  database
    .prepare(
      "INSERT INTO commerce_list_entry_attribute_value (merchant_id, entry_id, entry_revision, attribute_id, definition_revision, value_kind, short_text_value) VALUES (?, ?, 1, ?, 1, 'short_text', ?)",
    )
    .run(merchantId, entryId, attributeId, value);
}
function advanceMerchant(
  database: CommerceDatabase,
  merchantId: string,
): void {
  refreshCommerceAttributeRelation(database, merchantId);
  database
    .prepare(
      "UPDATE merchant SET revision = revision + 1 WHERE merchant_id = ?",
    )
    .run(merchantId);
}

/**
 * The customer order that a mail sources journey cites. The journey's own
 * support module, which runs in the Worker, names the same identity.
 */
const MAIL_SOURCE_ORDER_ID = "order_1042";

/** One confirmed shop order, written as Commerce writes an order. */
export function seedMailOrder(
  database: CommerceDatabase,
  merchantId: string,
): void {
  const occurredAt = new Date(Date.now() - 86_400_000).toISOString();
  writeSalesChannel(
    database,
    merchantId,
    parseSalesChannel({
      id: "channel_mail_orders",
      revision: 1,
      name: "Online shop",
      kind: "marketplace",
      lifecycle: { state: "active", activeAt: occurredAt },
      occurredAt,
    }),
  );
  const zero = { amountMinor: 0, currency: "JPY" };
  const price = { amountMinor: 4800, currency: "JPY" };
  writeOrder(
    database,
    merchantId,
    parseOrder({
      id: MAIL_SOURCE_ORDER_ID,
      revision: 1,
      origin: {
        kind: "marketplace",
        salesChannelId: "channel_mail_orders",
        marketplaceOrderId: MAIL_SOURCE_ORDER_ID,
      },
      buyer: { kind: "guest" },
      lineItems: [
        {
          id: "line_1",
          source: { kind: "source_only", sourceItemReference: "financier-box" },
          sku: "FIN-12",
          title: "Ginger financier box",
          quantity: { amount: 2, scale: 0, unit: "each" },
          fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
          unitPrice: { amountMinor: 2400, currency: "JPY" },
          tax: zero,
          discount: zero,
          lineTotal: price,
        },
      ],
      totals: {
        subtotal: price,
        discount: zero,
        tax: zero,
        duty: zero,
        shipping: zero,
        serviceFee: zero,
        tip: zero,
        rounding: zero,
        total: price,
      },
      adjustments: [],
      lifecycle: { state: "confirmed", confirmedAt: occurredAt },
      occurredAt,
    }),
  );
  advanceMerchant(database, merchantId);
}
