// The governed action that refunds an order (Plan 81 slice 5). The proposal
// freezes the payment, the amount and how it spreads over the order, so that
// an approval signs exact money. Commerce refuses the refund if the order
// changed after the proposal, or if the amount is more than it can return.
import { isRecord } from "@purin-labs/std";
import type {
  CommerceOrderV1,
  CommercePaymentV1,
} from "@purin-labs/commerce-client";

import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { Result } from "@purin-labs/kernel/result";

export const ORDER_REFUND_VERB = "commerce.order.refund";

/** A refusal that the agent can act on, returned as the tool's words. */
export class OrderRefundRequestError extends ToolRequestError {}

type OrderRefundLine = Readonly<{
  orderLineId: string;
  title: string;
  amountMinor: number;
}>;

export type OrderRefundAction = Readonly<{
  kind: "refund_order";
  /** The canonical order id, as the action ledger names a record. */
  orderId: string;
  providerOrderId: string;
  expectedOrderRevision: number;
  reason: string;
  paymentId: string;
  refundPolicyId: string;
  amountMinor: number;
  currency: string;
  wholeOrder: boolean;
  lines: readonly OrderRefundLine[];
  taxes: readonly Readonly<{ orderLineId: string; amountMinor: number }>[];
  shippingMinor: number;
}>;

export type OrderRefundLineRequest = Readonly<{
  orderLineId: string;
  /** The money back for this line, tax included; null for the whole line. */
  amountMinor: number | null;
}>;

type OrderRefundPlan = Pick<
  OrderRefundAction,
  | "paymentId"
  | "amountMinor"
  | "currency"
  | "wholeOrder"
  | "lines"
  | "taxes"
  | "shippingMinor"
>;

/**
 * Spreads a refund over the order, as Commerce's rules ask: a price that
 * includes tax already holds it, so tax is named only when it was added on
 * top. A refund of the whole order returns shipping too. A part of a line
 * returns its share of the tax, and the line amount takes the remainder.
 */
export function planOrderRefund(
  order: CommerceOrderV1,
  payments: readonly CommercePaymentV1[],
  refundLines: readonly OrderRefundLineRequest[] | null,
): OrderRefundPlan {
  const refundable = payments.filter(
    (payment) =>
      payment.orderId === order.id &&
      (payment.lifecycle.state === "captured" ||
        payment.lifecycle.state === "partially_refunded"),
  );
  if (refundable.length === 0)
    throw new OrderRefundRequestError(
      "This order has no payment that can take a refund.",
    );
  if (refundable.length > 1)
    throw new OrderRefundRequestError(
      "This order has more than one payment. A person must refund it from the order in the Portal.",
    );
  const payment = refundable[0] as CommercePaymentV1;
  const addedTax = order.totals.taxIncluded !== true;
  const currency = order.totals.total.currency;
  const requested =
    refundLines ??
    order.lineItems.map((line) => ({
      orderLineId: line.id,
      amountMinor: null,
    }));
  const seen = new Set<string>();
  const lines: OrderRefundLine[] = [];
  const taxes: { orderLineId: string; amountMinor: number }[] = [];
  for (const request of requested) {
    const line = order.lineItems.find(
      (candidate) => candidate.id === request.orderLineId,
    );
    if (line === undefined || seen.has(request.orderLineId))
      throw new OrderRefundRequestError(
        `Order line ${request.orderLineId} is not on this order, or is named twice. Read the order again.`,
      );
    seen.add(request.orderLineId);
    const lineTax = addedTax ? line.tax.amountMinor : 0;
    const whole = line.lineTotal.amountMinor + lineTax;
    const amount = request.amountMinor ?? whole;
    if (amount < 1 || amount > whole)
      throw new OrderRefundRequestError(
        `The refund for "${line.title}" must be from 1 to ${whole} in minor units.`,
      );
    const tax = Math.floor((amount * lineTax) / whole);
    lines.push({
      orderLineId: line.id,
      title: line.title,
      amountMinor: amount - tax,
    });
    if (tax > 0) taxes.push({ orderLineId: line.id, amountMinor: tax });
  }
  const wholeOrder = refundLines === null;
  const shippingMinor = wholeOrder ? order.totals.shipping.amountMinor : 0;
  const amountMinor =
    shippingMinor +
    lines.reduce((sum, line) => sum + line.amountMinor, 0) +
    taxes.reduce((sum, tax) => sum + tax.amountMinor, 0);
  if (wholeOrder) {
    // Duty, a tip or an earlier refund cannot spread by this rule.
    if (
      payment.lifecycle.state !== "captured" ||
      amountMinor !== payment.amount.amountMinor
    )
      throw new OrderRefundRequestError(
        "This order cannot take a whole refund, because of an earlier refund or a part that is not on a line. Name the lines to refund.",
      );
  } else if (amountMinor > payment.amount.amountMinor) {
    throw new OrderRefundRequestError(
      "The refund is more than the payment. Check the amounts.",
    );
  }
  return {
    paymentId: payment.id,
    amountMinor,
    currency,
    wholeOrder,
    lines,
    taxes,
    shippingMinor,
  };
}

/** The allocation of the Commerce refund command. */
export function orderRefundAllocation(action: OrderRefundAction) {
  const money = (amountMinor: number) => ({
    amountMinor,
    currency: action.currency,
  });
  return {
    lineAllocations: action.lines.map((line) => ({
      orderLineId: line.orderLineId,
      amount: money(line.amountMinor),
    })),
    taxAllocations: action.taxes.map((tax) => ({
      orderLineId: tax.orderLineId,
      amount: money(tax.amountMinor),
    })),
    dutyAllocations: [],
    shippingAllocation: money(action.shippingMinor),
  };
}

type ParseError = Readonly<{ code: "commerce_action_invalid"; field: string }>;

function invalid(field: string): Result<never, ParseError> {
  return { ok: false, error: { code: "commerce_action_invalid", field } };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseOrderRefundAction(
  raw: Record<string, unknown>,
): Result<OrderRefundAction, ParseError> {
  if (!isText(raw.orderId)) return invalid("orderId");
  if (!isText(raw.providerOrderId)) return invalid("providerOrderId");
  if (!isPositive(raw.expectedOrderRevision))
    return invalid("expectedOrderRevision");
  if (!isText(raw.reason) || raw.reason.length > 256) return invalid("reason");
  if (!isText(raw.paymentId)) return invalid("paymentId");
  if (!isText(raw.refundPolicyId)) return invalid("refundPolicyId");
  if (!isPositive(raw.amountMinor)) return invalid("amountMinor");
  if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/u.test(raw.currency))
    return invalid("currency");
  if (typeof raw.wholeOrder !== "boolean") return invalid("wholeOrder");
  if (!isNonNegative(raw.shippingMinor)) return invalid("shippingMinor");
  if (!Array.isArray(raw.lines) || raw.lines.length === 0)
    return invalid("lines");
  const lines: OrderRefundLine[] = [];
  for (const line of raw.lines as unknown[]) {
    if (
      !isRecord(line) ||
      !isText(line.orderLineId) ||
      typeof line.title !== "string" ||
      !isNonNegative(line.amountMinor)
    )
      return invalid("lines");
    lines.push({
      orderLineId: line.orderLineId,
      title: line.title,
      amountMinor: line.amountMinor,
    });
  }
  if (!Array.isArray(raw.taxes)) return invalid("taxes");
  const taxes: { orderLineId: string; amountMinor: number }[] = [];
  for (const tax of raw.taxes as unknown[]) {
    if (
      !isRecord(tax) ||
      !isText(tax.orderLineId) ||
      !isPositive(tax.amountMinor)
    )
      return invalid("taxes");
    taxes.push({ orderLineId: tax.orderLineId, amountMinor: tax.amountMinor });
  }
  return {
    ok: true,
    value: {
      kind: "refund_order",
      orderId: raw.orderId,
      providerOrderId: raw.providerOrderId,
      expectedOrderRevision: raw.expectedOrderRevision,
      reason: raw.reason,
      paymentId: raw.paymentId,
      refundPolicyId: raw.refundPolicyId,
      amountMinor: raw.amountMinor,
      currency: raw.currency,
      wholeOrder: raw.wholeOrder,
      lines,
      taxes,
      shippingMinor: raw.shippingMinor,
    },
  };
}

export function orderRefundActionPath(action: OrderRefundAction): string {
  const params = new URLSearchParams({ definition: JSON.stringify(action) });
  return `/orders/${encodeURIComponent(action.orderId)}/refund?${params.toString()}`;
}

/** Null when this is not a refund action. */
export function parseOrderRefundActionPath(
  verb: string,
  url: URL,
): Result<OrderRefundAction, ParseError> | null {
  if (verb !== ORDER_REFUND_VERB) return null;
  const definition = url.searchParams.get("definition");
  if (definition === null) return invalid("path");
  let raw: unknown;
  try {
    raw = JSON.parse(definition);
  } catch {
    return invalid("path");
  }
  if (!isRecord(raw) || raw.kind !== "refund_order") return invalid("path");
  const parsed = parseOrderRefundAction(raw);
  if (!parsed.ok) return parsed;
  return url.pathname ===
    `/orders/${encodeURIComponent(parsed.value.orderId)}/refund`
    ? parsed
    : invalid("path");
}
