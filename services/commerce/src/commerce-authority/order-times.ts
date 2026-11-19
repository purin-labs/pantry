// How long the orders of a window took (spec section 14). The order keeps when
// it was last changed, so the time that it was placed comes from its checkout.
// Rows come newest first by insertion, so the scan stops at the first order that
// is older than the window, and the read stays small however many orders the
// merchant has sold.
import {
  orderOriginCheckoutId,
  parseFulfillment,
  parseOrder,
  commercePickupCode,
  type CommerceOrderTimeV1,
  type CommerceOrderTimesV1,
} from "@purin-labs/commerce-client";
import { readCheckout } from "../checkout-persistence.ts";
import type { CommerceDatabase } from "../database.ts";

export type OrderTimesWindow = Readonly<{ start: string; end: string }>;

/** The orders that one read returns. */
const ORDER_LIMIT = 200;
/** The rows that one read looks at, the most recent first. */
const SCAN_LIMIT = 2_000;

type Order = ReturnType<typeof parseOrder>;
type Fulfillment = ReturnType<typeof parseFulfillment>;

export function readOrderTimes(
  database: CommerceDatabase,
  merchantId: string,
  merchantRevision: number,
  window: OrderTimesWindow,
): CommerceOrderTimesV1 {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const rows = database
    .prepare(
      `SELECT order_snapshot_json AS orderJson FROM commerce_order
       WHERE merchant_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all<Readonly<{ orderJson: string }>>(merchantId, SCAN_LIMIT);
  const orders: CommerceOrderTimeV1[] = [];
  let ended = false;
  for (const row of rows) {
    const order = parseOrder(JSON.parse(row.orderJson));
    const placedAt = placedTime(database, merchantId, order);
    const at = Date.parse(placedAt);
    if (at < start) {
      ended = true;
      break;
    }
    if (at >= end) continue;
    if (orders.length === ORDER_LIMIT) {
      return result(merchantId, merchantRevision, orders, true);
    }
    orders.push(orderTime(database, merchantId, order, placedAt));
  }
  return result(
    merchantId,
    merchantRevision,
    orders,
    !ended && rows.length === SCAN_LIMIT,
  );
}

function result(
  merchantId: string,
  merchantRevision: number,
  orders: readonly CommerceOrderTimeV1[],
  truncated: boolean,
): CommerceOrderTimesV1 {
  return {
    schemaVersion: "underclerk.order-times.v1",
    merchantId,
    merchantRevision,
    truncated,
    orders,
  };
}

function placedTime(
  database: CommerceDatabase,
  merchantId: string,
  order: Order,
): string {
  const checkoutId = orderOriginCheckoutId(order.origin);
  const checkout =
    checkoutId === undefined
      ? undefined
      : readCheckout(database, merchantId, checkoutId);
  return checkout?.lifecycle.state === "accepted"
    ? checkout.lifecycle.acceptedAt
    : order.occurredAt;
}

function orderTime(
  database: CommerceDatabase,
  merchantId: string,
  order: Order,
  placedAt: string,
): CommerceOrderTimeV1 {
  const fulfillments = database
    .prepare(
      `SELECT fulfillment_snapshot_json AS fulfillmentJson FROM fulfillment
       WHERE merchant_id = ? AND order_id = ?`,
    )
    .all<Readonly<{ fulfillmentJson: string }>>(merchantId, order.id)
    .map((row) => parseFulfillment(JSON.parse(row.fulfillmentJson)));
  const expected = fulfillments
    .map((fulfillment) => fulfillment.expectedBy)
    .sort((first, second) => Date.parse(first) - Date.parse(second))[0];
  return {
    orderId: order.id,
    code: commercePickupCode(order.id),
    channel: order.origin.kind === "online" ? "online" : "counter",
    amount: {
      amountMinor: order.totals.total.amountMinor,
      currency: order.totals.total.currency,
    },
    placedAt,
    expectedBy: expected ?? null,
    ...progress(order, fulfillments),
    lines: order.lineItems.map((line) => ({
      title: line.title,
      quantity: line.quantity.amount,
    })),
  };
}

/** How far the order has come: the last of its fulfillments decides. */
function progress(
  order: Order,
  fulfillments: readonly Fulfillment[],
): Pick<CommerceOrderTimeV1, "stage" | "stageAt"> {
  if (order.lifecycle.state === "cancelled")
    return { stage: "cancelled", stageAt: order.lifecycle.cancelledAt };
  let ready: string | null = null;
  let finished: string | null = null;
  for (const fulfillment of fulfillments) {
    const lifecycle = fulfillment.lifecycle;
    switch (lifecycle.state) {
      case "ready_for_pickup":
        ready = later(ready, lifecycle.readyAt);
        break;
      case "completed":
        finished = later(finished, lifecycle.completedAt);
        break;
      case "handed_to_carrier":
        finished = later(finished, lifecycle.handedOverAt);
        break;
      case "cancelled":
        break;
      default:
        return { stage: "preparing", stageAt: null };
    }
  }
  if (ready !== null) return { stage: "ready", stageAt: ready };
  if (finished !== null) return { stage: "finished", stageAt: finished };
  return { stage: "preparing", stageAt: null };
}

function later(first: string | null, second: string): string {
  return first === null || Date.parse(second) > Date.parse(first)
    ? second
    : first;
}
