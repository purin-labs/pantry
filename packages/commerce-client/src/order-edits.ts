// Order edits (Plan 76A step 2B). Staff change the quantities of an order's
// lines, or add lines, before fulfilment starts. Each edit and each later
// payment is an order change; the order record is the current order.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import {
  type CommerceManualTenderV1,
} from "./draft-orders.ts";
import type { CommerceBuyerQuotedCheckoutV1 } from "./storefront-client.ts";
import { parseEditCommerceOrderV1 as parseEditCommerceOrderV1Record, parseExchangeCommerceOrderLinesV1 as parseExchangeCommerceOrderLinesV1Record, parseOpenCommerceBuyerOrderBalanceV1 as parseOpenCommerceBuyerOrderBalanceV1Record, parseRecordCommerceOrderManualPaymentV1 as parseRecordCommerceOrderManualPaymentV1Record, parseCommerceOrderChangeV1 as parseCommerceOrderChangeV1Record, parseCommerceOrderChangesV1 as parseCommerceOrderChangesV1Record } from "@purin-labs/commerce-contracts/records/api-order-edits";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

/** One order line as an order change accepted it. */
export type CommerceOrderChangeLineV1 = Readonly<{
  orderLineId: string;
  quantity: number;
  lineTotal: Money;
  tax: Money;
  allocationIds: readonly string[];
}>;

export type CommerceOrderEditV1 = Readonly<{
  kind: "edit";
  id: string;
  orderId: string;
  orderRevisionBefore: number;
  orderRevisionAfter: number;
  reason: string;
  lineChanges: readonly Readonly<{
    orderLineId: string;
    quantityBefore: number;
    quantityAfter: number;
  }>[];
  additions: readonly Readonly<{
    orderLineId: string;
    variantId: string;
    quantity: number;
  }>[];
  totalBefore: Money;
  totalAfter: Money;
  /** The lines before the edit, so a later refund can name a removed line. */
  linesBefore: readonly CommerceOrderChangeLineV1[];
  linesAfter: readonly CommerceOrderChangeLineV1[];
  occurredAt: CommerceEngineTimestamp;
}>;

/**
 * A payment that a balance checkout added to the order, or that staff
 * recorded in cash or by bank transfer; only a checkout's payment names it.
 */
export type CommerceOrderPaymentChangeV1 = Readonly<{
  kind: "payment";
  id: string;
  orderId: string;
  orderRevisionBefore: number;
  orderRevisionAfter: number;
  paymentId: string;
  checkoutId?: string;
  amount: Money;
  occurredAt: CommerceEngineTimestamp;
}>;

/**
 * An exchange: the received lines of a return leave the order and new lines
 * join it, handed over in a fulfillment of their own.
 */
export type CommerceOrderExchangeV1 = Omit<CommerceOrderEditV1, "kind"> &
  Readonly<{
    kind: "exchange";
    returnId: string;
    fulfillmentId: string;
  }>;

export type CommerceOrderChangeV1 =
  | CommerceOrderEditV1
  | CommerceOrderExchangeV1
  | CommerceOrderPaymentChangeV1;

/** Staff exchange the received lines of a return for new lines. */
export type ExchangeCommerceOrderLinesV1 = Readonly<{
  schemaVersion: "underclerk.exchange-order-lines.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  exchangeId: string;
  orderId: string;
  expectedOrderRevision: number;
  returnId: string;
  expectedReturnRevision: number;
  additions: readonly Readonly<{ variantId: string; quantity: number }>[];
  reason: string;
}>;

/**
 * What the order owes. `outstanding` is the current total less every captured
 * payment; `refundDue` is what the buyer paid, less refunds, above the total.
 */
export type CommerceOrderBalanceV1 = Readonly<{
  total: Money;
  captured: Money;
  refunded: Money;
  outstanding: Money;
  refundDue: Money;
}>;

export type CommerceOrderChangesV1 = Readonly<{
  schemaVersion: "underclerk.order-changes.v1";
  orderId: string;
  orderRevision: number;
  changes: readonly CommerceOrderChangeV1[];
  balance: CommerceOrderBalanceV1;
}>;

export type EditCommerceOrderV1 = Readonly<{
  schemaVersion: "underclerk.edit-order.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  editId: string;
  orderId: string;
  expectedOrderRevision: number;
  /** A new quantity for an existing line; zero removes the line. */
  lineChanges: readonly Readonly<{ orderLineId: string; quantity: number }>[];
  additions: readonly Readonly<{ variantId: string; quantity: number }>[];
  reason: string;
}>;

/**
 * Staff took what an order still owes in cash or by bank transfer (Plan 77
 * step 2). The amount is the order's outstanding balance at
 * `expectedOrderRevision`.
 */
export type RecordCommerceOrderManualPaymentV1 = Readonly<{
  schemaVersion: "underclerk.record-order-manual-payment.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  orderId: string;
  expectedOrderRevision: number;
  paymentId: string;
  amount: Money;
  tender: CommerceManualTenderV1;
}>;

/** The buyer's request to pay an order balance, sent with the order link. */
export type OpenCommerceBuyerOrderBalanceV1 = Readonly<{
  schemaVersion: "underclerk.open-buyer-order-balance.v1";
}>;

export type CommerceOrderBalanceCheckoutV1 = Readonly<{
  schemaVersion: "underclerk.order-balance-checkout.v1";
  session: Readonly<{ token: string; expiresAt: CommerceEngineTimestamp }>;
  checkout: CommerceBuyerQuotedCheckoutV1;
}>;

export function parseEditOrderCommand(value: unknown): EditCommerceOrderV1 {
  return decodeRecord(parseEditCommerceOrderV1Record, value);
}

export function parseExchangeOrderLinesCommand(value: unknown): ExchangeCommerceOrderLinesV1 {
  return decodeRecord(parseExchangeCommerceOrderLinesV1Record, value);
}

export function parseOpenBuyerOrderBalanceCommand(value: unknown): OpenCommerceBuyerOrderBalanceV1 {
  return decodeRecord(parseOpenCommerceBuyerOrderBalanceV1Record, value);
}

export function parseRecordOrderManualPaymentCommand(value: unknown): RecordCommerceOrderManualPaymentV1 {
  return decodeRecord(parseRecordCommerceOrderManualPaymentV1Record, value);
}

export function parseOrderChange(value: unknown): CommerceOrderChangeV1 {
  return decodeRecord(parseCommerceOrderChangeV1Record, value);
}

export function parseOrderChanges(value: unknown): CommerceOrderChangesV1 {
  return decodeRecord(parseCommerceOrderChangesV1Record, value);
}
