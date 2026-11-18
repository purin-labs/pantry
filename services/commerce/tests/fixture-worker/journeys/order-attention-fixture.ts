import {
  parseOrder,
  parsePayment,
  parseFulfillment,
  parseShipment,
  parseLocation,
  parseSalesChannel,
  type CommerceOrderV1,
} from "@seams/commerce-client";
import {
  writeOrder,
  writePayment,
  writeFulfillment,
  writeShipment,
  writeLocation,
  writeSalesChannel,
} from "../../../src/commerce-persistence.ts";
import { refreshCommerceAttributeRelation } from "../../../src/entity-plane/commerce-attribute-relation.ts";
import type { CommerceDatabase } from "../../../src/database.ts";

export function seedOrderAttention(
  database: CommerceDatabase,
  merchantId: string,
): void {
  const observedAt = new Date(Date.now() - 3_600_000).toISOString();
  const overdue = new Date(Date.now() - 1_800_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  writeLocation(
    database,
    merchantId,
    parseLocation({
      id: "location_attention",
      revision: 1,
      name: "Dispatch",
      kind: "warehouse",
      lifecycle: { state: "active", activeAt: observedAt },
      occurredAt: observedAt,
    }),
  );
  writeSalesChannel(
    database,
    merchantId,
    parseSalesChannel({
      id: "channel_attention",
      revision: 1,
      name: "Mock shop",
      kind: "marketplace",
      lifecycle: { state: "active", activeAt: observedAt },
      occurredAt: observedAt,
    }),
  );
  for (const role of [
    "failed",
    "recovered",
    "delayed",
    "upcoming",
    "completed",
    "cancelled",
    "exception",
  ]) {
    const orderId = `order_attention_${role}`;
    const lifecycle: CommerceOrderV1["lifecycle"] =
      role === "cancelled"
        ? {
            state: "cancelled",
            cancelledAt: observedAt,
            reason: "Mock cancellation",
          }
        : role === "completed"
          ? { state: "fulfilled", fulfilledAt: observedAt }
          : { state: "confirmed", confirmedAt: observedAt };
    writeOrder(
      database,
      merchantId,
      attentionOrder(orderId, lifecycle, observedAt),
    );
    if (role === "failed" || role === "recovered" || role === "cancelled") {
      attentionPayment(
        database,
        merchantId,
        `payment_${role}_first`,
        orderId,
        "failed",
        observedAt,
      );
    }
    if (role === "failed") {
      attentionPayment(
        database,
        merchantId,
        "payment_failed_retry",
        orderId,
        "failed",
        observedAt,
      );
    } else if (role !== "cancelled") {
      attentionPayment(
        database,
        merchantId,
        `payment_${role}_success`,
        orderId,
        "captured",
        observedAt,
      );
    }
    if (
      role === "delayed" ||
      role === "upcoming" ||
      role === "completed" ||
      role === "exception"
    ) {
      writeFulfillment(
        database,
        merchantId,
        parseFulfillment({
          id: `fulfillment_${role}`,
          revision: 1,
          orderId,
          locationId: "location_attention",
          lineItems: [{ lineItemId: "line_1", quantity: 1 }],
          expectedBy:
            role === "upcoming" || role === "exception" ? future : overdue,
          occurredAt: observedAt,
          kind: role === "completed" ? "pickup" : "shipping",
          binding: { kind: "external", sourceReference: `mock_${role}` },
          lifecycle:
            role === "completed"
              ? { state: "completed", completedAt: observedAt }
              : role === "exception"
                ? {
                    state: "handed_to_carrier",
                    handedOverAt: observedAt,
                    shipmentId: "shipment_exception",
                  }
                : { state: "requested", requestedAt: observedAt },
        }),
      );
    }
    if (role === "exception") {
      writeShipment(
        database,
        merchantId,
        parseShipment({
          id: "shipment_exception",
          revision: 1,
          orderId,
          fulfillmentId: "fulfillment_exception",
          kind: "external",
          carrier: "Mock carrier",
          trackingNumber: "MOCK-39",
          estimatedDeliveryAt: future,
          events: [],
          occurredAt: observedAt,
          lifecycle: {
            state: "delivery_exception",
            occurredAt: observedAt,
            reason: "Carrier customs hold",
          },
        }),
      );
    }
  }
  advanceAttentionRevision(database, merchantId);
}

export function resolveAttentionPayment(
  database: CommerceDatabase,
  merchantId: string,
): void {
  attentionPayment(
    database,
    merchantId,
    "payment_failed_recovery",
    "order_attention_failed",
    "captured",
    new Date().toISOString(),
  );
  advanceAttentionRevision(database, merchantId);
}

function attentionPayment(
  database: CommerceDatabase,
  merchantId: string,
  id: string,
  orderId: string,
  state: "failed" | "captured",
  occurredAt: string,
): void {
  writePayment(
    database,
    merchantId,
    parsePayment({
      id,
      revision: 1,
      orderId,
      amount: { amountMinor: 2500, currency: "JPY" },
      occurredAt,
      lifecycle:
        state === "failed"
          ? { state, failedAt: occurredAt, reason: "Card declined" }
          : { state, capturedAt: occurredAt },
    }),
  );
}

function attentionOrder(
  id: string,
  lifecycle: CommerceOrderV1["lifecycle"],
  occurredAt: string,
): CommerceOrderV1 {
  const zero = { amountMinor: 0, currency: "JPY" };
  const price = { amountMinor: 2500, currency: "JPY" };
  return parseOrder({
    id,
    revision: 1,
    origin: {
      kind: "marketplace",
      salesChannelId: "channel_attention",
      marketplaceOrderId: id,
    },
    buyer: { kind: "guest" },
    lineItems: [
      {
        id: "line_1",
        source: { kind: "source_only", sourceItemReference: "mock-box" },
        sku: "BOX",
        title: "Mock seasonal box",
        quantity: { amount: 1, scale: 0, unit: "each" },
        fulfilledQuantity: {
          amount: lifecycle.state === "fulfilled" ? 1 : 0,
          scale: 0,
          unit: "each",
        },
        unitPrice: price,
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
    lifecycle,
    occurredAt,
  });
}

function advanceAttentionRevision(
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
