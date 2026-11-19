import {
  parseOrder,
  parseSalesChannel,
  type CommerceOrderV1,
} from "@purin-labs/commerce-client";
import type { AttributeDefinition } from "@purin-labs/commerce-contracts";
import {
  writeOrder,
  writeSalesChannel,
} from "../../../src/commerce-persistence.ts";
import { refreshCommerceAttributeRelation } from "../../../src/entity-plane/commerce-attribute-relation.ts";
import {
  createSystemExtensionSchema,
  publishSystemExtensionSchema,
} from "../../../src/entity-plane/entities.ts";
import { parseAttributeDefinition } from "../../../src/entity-plane/parsers.ts";
import type { CommerceDatabase } from "../../../src/database.ts";

export function seedOrderCapacity(
  database: CommerceDatabase,
  merchantId: string,
): void {
  const now = new Date().toISOString();
  writeSalesChannel(
    database,
    merchantId,
    parseSalesChannel({
      id: "channel_capacity",
      revision: 1,
      name: "Synthetic capacity shop",
      kind: "marketplace",
      lifecycle: { state: "active", activeAt: now },
      occurredAt: now,
    }),
  );
  const definitions = [
    integerDefinition("ext_ordered_boxes"),
    integerDefinition("ext_fulfilled_boxes"),
    integerDefinition("ext_pieces_per_box"),
    integerDefinition("ext_recipe_revision"),
    textDefinition("ext_recipe_id"),
  ];
  createSystemExtensionSchema(
    database,
    merchantId,
    "order",
    1,
    definitions,
    now,
  );
  publishSystemExtensionSchema(database, merchantId, "order", 1, now);
  const orders = [
    capacityOrder(
      "order_capacity_upcoming",
      8,
      0,
      {
        state: "confirmed",
        confirmedAt: now,
      },
      now,
    ),
    capacityOrder(
      "order_capacity_partial",
      5,
      3,
      {
        state: "partially_fulfilled",
        since: now,
        fulfilledLineItemIds: [],
      },
      now,
    ),
    capacityOrder(
      "order_capacity_cancelled",
      10,
      0,
      {
        state: "cancelled",
        cancelledAt: now,
        reason: "Synthetic cancelled demand",
      },
      now,
    ),
  ];
  for (const order of orders) {
    writeOrder(database, merchantId, order);
    const line = order.lineItems[0];
    if (line === undefined) throw new Error("Missing capacity fixture line");
    for (const [attributeId, value] of [
      ["ext_ordered_boxes", line.quantity.amount],
      ["ext_fulfilled_boxes", line.fulfilledQuantity.amount],
      ["ext_pieces_per_box", 12],
      ["ext_recipe_revision", 1],
    ] as const) {
      database
        .prepare(
          `INSERT INTO system_entity_extension_value (
          merchant_id, system_entity_type_id, system_entity_id,
          extension_schema_revision, attribute_id, value_kind, integer_value
        ) VALUES (?, 'order', ?, 1, ?, 'integer', ?)`,
        )
        .run(merchantId, order.id, attributeId, value);
    }
    database
      .prepare(
        `INSERT INTO system_entity_extension_value (
        merchant_id, system_entity_type_id, system_entity_id,
        extension_schema_revision, attribute_id, value_kind, short_text_value
      ) VALUES (?, 'order', ?, 1, 'ext_recipe_id', 'short_text', 'financier')`,
      )
      .run(merchantId, order.id);
  }
  refreshCommerceAttributeRelation(database, merchantId);
  database
    .prepare(
      "UPDATE merchant SET revision = revision + 1 WHERE merchant_id = ?",
    )
    .run(merchantId);
}

function integerDefinition(id: string): AttributeDefinition {
  return parseAttributeDefinition({
    id,
    scope: {
      kind: "merchant_extension",
      entityTypeId: "order",
      schemaRevision: 1,
    },
    label: id,
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind: { kind: "integer", minimum: 0, maximum: null },
    revision: 1,
  });
}

function textDefinition(id: string): AttributeDefinition {
  return parseAttributeDefinition({
    id,
    scope: {
      kind: "merchant_extension",
      entityTypeId: "order",
      schemaRevision: 1,
    },
    label: id,
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind: { kind: "short_text", maxLength: 80 },
    revision: 1,
  });
}

function capacityOrder(
  id: string,
  boxes: number,
  fulfilledBoxes: number,
  lifecycle: CommerceOrderV1["lifecycle"],
  now: string,
): CommerceOrderV1 {
  const zero = { amountMinor: 0, currency: "JPY" };
  const price = { amountMinor: 2500, currency: "JPY" };
  const total = { amountMinor: boxes * 2500, currency: "JPY" };
  return parseOrder({
    id,
    revision: 1,
    origin: {
      kind: "marketplace",
      salesChannelId: "channel_capacity",
      marketplaceOrderId: id,
    },
    buyer: { kind: "guest" },
    lineItems: [
      {
        id: "line_financier_box",
        source: {
          kind: "source_only",
          sourceItemReference: "financier-box-12",
        },
        sku: "FINANCIER_BOX_12",
        title: "Synthetic financier box — 12 pieces",
        quantity: { amount: boxes, scale: 0, unit: "each" },
        fulfilledQuantity: { amount: fulfilledBoxes, scale: 0, unit: "each" },
        unitPrice: price,
        tax: zero,
        discount: zero,
        lineTotal: total,
      },
    ],
    totals: {
      subtotal: total,
      discount: zero,
      tax: zero,
      duty: zero,
      shipping: zero,
      serviceFee: zero,
      tip: zero,
      rounding: zero,
      total,
    },
    adjustments: [],
    lifecycle,
    occurredAt: now,
  });
}
