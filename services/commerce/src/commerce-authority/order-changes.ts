// Order changes (Plan 76A step 2.0). The order record is the current order.
// An edit or a later payment writes an order change in the same transaction,
// so the after-sale checks can compare the order with what was accepted: the
// checkout quote for an order that never changed, else the last edit.
import {
  orderOriginCheckoutId,
  parseOrder,
  parseOrderChange,
  type CommerceOrderChangeV1,
  type CommerceOrderEditV1,
  type CommerceOrderExchangeV1,
  type CommerceOrderPaymentChangeV1,
  type CommerceOrderV1,
} from "@seams/commerce-client";

import type { Checkout } from "@seams/commerce-contracts";

import { readCheckout } from "../checkout-persistence.ts";
import { writeOrder } from "../commerce-persistence.ts";
import type { CommerceDatabase } from "../database.ts";
import { findResource, orderLineIdFor, sameMoney } from "./checkout-shared.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type AcceptedOrderLine = Readonly<{
  orderLineId: string;
  quantity: number;
  lineTotal: Money;
  allocationIds: readonly string[];
}>;

/** The lines and totals that the order's last accepted change agreed. */
export type AcceptedOrder = Readonly<{
  lines: readonly AcceptedOrderLine[];
  subtotal: Money;
  tax: Money;
  duty: Money;
  shipping: Money;
  total: Money;
  /** True when an edit or an exchange, not the checkout quote, set the lines. */
  edited: boolean;
}>;

export function listOrderChanges(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): readonly CommerceOrderChangeV1[] {
  return database
    .prepare(
      `SELECT change_json AS changeJson FROM order_change
       WHERE merchant_id = ? AND order_id = ?
       ORDER BY order_revision_before`,
    )
    .all<Readonly<{ changeJson: string }>>(merchantId, orderId)
    .map((row) => parseOrderChange(JSON.parse(row.changeJson)));
}

export function readPaymentChange(
  database: CommerceDatabase,
  merchantId: string,
  paymentId: string,
): CommerceOrderPaymentChangeV1 | undefined {
  const row = database
    .prepare(
      `SELECT change_json AS changeJson FROM order_change
       WHERE merchant_id = ? AND payment_id = ?`,
    )
    .get<Readonly<{ changeJson: string }>>(merchantId, paymentId);
  if (row === undefined) return undefined;
  const change = parseOrderChange(JSON.parse(row.changeJson));
  if (change.kind !== "payment") throw new Error("A payment change lost its kind");
  return change;
}

export function insertOrderChange(
  database: CommerceDatabase,
  merchantId: string,
  change: CommerceOrderChangeV1,
): void {
  database
    .prepare(
      `INSERT INTO order_change (
         merchant_id, change_id, order_id, kind, order_revision_before,
         order_revision_after, payment_id, change_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      change.id,
      change.orderId,
      change.kind,
      change.orderRevisionBefore,
      change.orderRevisionAfter,
      change.kind === "payment" ? change.paymentId : null,
      JSON.stringify(change),
      change.occurredAt,
    );
}

/** Writes the order only if no other write moved it since it was read. */
export function writeOrderAfterRevision(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
  previousRevision: number,
): void {
  const row = database
    .prepare(
      `SELECT revision FROM commerce_order
       WHERE merchant_id = ? AND resource_id = ?`,
    )
    .get<Readonly<{ revision: number }>>(merchantId, order.id);
  if (row?.revision !== previousRevision)
    throw new Error(`Order ${order.id} moved during the write`);
  writeOrder(database, merchantId, order);
}

export function readAcceptedOrder(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
): AcceptedOrder | undefined {
  const originCheckoutId = orderOriginCheckoutId(order.origin);
  if (originCheckoutId === undefined) return undefined;
  const checkout = readCheckout(database, merchantId, originCheckoutId);
  if (
    checkout?.lifecycle.state !== "accepted" ||
    checkout.lifecycle.orderId !== order.id
  )
    return undefined;
  const quote = checkout.lifecycle.quote;
  const edit = lastEdit(listOrderChanges(database, merchantId, order.id));
  if (edit === undefined) {
    return {
      lines: quote.lines.map((line) => ({
        orderLineId: orderLineIdFor(order.id, line.checkoutLineId),
        quantity: line.quantity.amount,
        lineTotal: line.lineTotal,
        allocationIds: line.allocationIds,
      })),
      subtotal: quote.totals.subtotal,
      tax: quote.totals.tax,
      duty: quote.totals.duty,
      shipping: quote.totals.shipping,
      total: quote.totals.total,
      edited: false,
    };
  }
  const currency = edit.totalAfter.currency;
  return {
    lines: edit.linesAfter.map((line) => ({
      orderLineId: line.orderLineId,
      quantity: line.quantity,
      lineTotal: line.lineTotal,
      allocationIds: line.allocationIds,
    })),
    subtotal: {
      amountMinor: sumMinor(edit.linesAfter.map((line) => line.lineTotal)),
      currency,
    },
    tax: {
      amountMinor: sumMinor(edit.linesAfter.map((line) => line.tax)),
      currency,
    },
    duty: quote.totals.duty,
    shipping: quote.totals.shipping,
    total: edit.totalAfter,
    edited: true,
  };
}

/** Whether the order record still shows what its last change accepted. */
export function orderMatchesAccepted(
  order: CommerceOrderV1,
  accepted: AcceptedOrder,
): boolean {
  if (
    !sameMoney(accepted.subtotal, order.totals.subtotal) ||
    !sameMoney(accepted.tax, order.totals.tax) ||
    !sameMoney(accepted.duty, order.totals.duty) ||
    !sameMoney(accepted.shipping, order.totals.shipping) ||
    !sameMoney(accepted.total, order.totals.total) ||
    accepted.lines.length !== order.lineItems.length
  ) {
    return false;
  }
  for (const line of accepted.lines) {
    const orderLine = findResource(order.lineItems, line.orderLineId);
    if (
      orderLine === undefined ||
      !sameMoney(orderLine.lineTotal, line.lineTotal) ||
      orderLine.quantity.amount !== line.quantity ||
      orderLine.quantity.scale !== 0 ||
      orderLine.quantity.unit !== "each"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The most each line and each total has ever been. A refund after an edit may
 * name a line that the edit removed or made smaller.
 */
export type RefundCeilings = Readonly<{
  lineTotals: ReadonlyMap<string, number>;
  lineTaxes: ReadonlyMap<string, number>;
  subtotal: number;
  tax: number;
}>;

export function refundCeilings(
  database: CommerceDatabase,
  merchantId: string,
  order: CommerceOrderV1,
): RefundCeilings {
  const lineTotals = new Map<string, number>();
  const lineTaxes = new Map<string, number>();
  const raise = (map: Map<string, number>, id: string, amount: number) =>
    map.set(id, Math.max(map.get(id) ?? 0, amount));
  for (const line of order.lineItems) {
    raise(lineTotals, line.id, line.lineTotal.amountMinor);
    raise(lineTaxes, line.id, line.tax.amountMinor);
  }
  let subtotal = order.totals.subtotal.amountMinor;
  let tax = order.totals.tax.amountMinor;
  for (const change of listOrderChanges(database, merchantId, order.id)) {
    if (change.kind === "payment") continue;
    for (const line of change.linesBefore) {
      raise(lineTotals, line.orderLineId, line.lineTotal.amountMinor);
      raise(lineTaxes, line.orderLineId, line.tax.amountMinor);
    }
    subtotal = Math.max(
      subtotal,
      sumMinor(change.linesBefore.map((line) => line.lineTotal)),
    );
    tax = Math.max(tax, sumMinor(change.linesBefore.map((line) => line.tax)));
  }
  return { lineTotals, lineTaxes, subtotal, tax };
}

/** The order one revision later, as a payment added to it leaves it. */
export function orderWithAddedPayment(
  order: CommerceOrderV1,
  occurredAt: string,
): CommerceOrderV1 {
  return parseOrder({ ...order, revision: order.revision + 1, occurredAt });
}

/** The order a balance checkout pays, or undefined for any other checkout. */
export function balanceCheckoutOrder(
  checkout: Checkout,
): Readonly<{ orderId: string; orderRevision: number }> | undefined {
  const lines = checkout.lifecycle.quote.lines;
  const line = lines[0];
  return lines.length === 1 && line?.source.kind === "order_balance"
    ? { orderId: line.source.orderId, orderRevision: line.source.orderRevision }
    : undefined;
}

// The last change that set the lines: an edit or an exchange.
function lastEdit(
  changes: readonly CommerceOrderChangeV1[],
): CommerceOrderEditV1 | CommerceOrderExchangeV1 | undefined {
  let edit: CommerceOrderEditV1 | CommerceOrderExchangeV1 | undefined;
  for (const change of changes) if (change.kind !== "payment") edit = change;
  return edit;
}

function sumMinor(monies: readonly Money[]): number {
  let total = 0;
  for (const money of monies) {
    total += money.amountMinor;
    if (!Number.isSafeInteger(total))
      throw new Error("Order change total exceeds safe money");
  }
  return total;
}
