import type {
  Money,
  RefundAllocation,
  RefundAttempt,
} from "@seams/commerce-contracts";

import {
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "./mutations.ts";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseCancelCommerceOrderV1 as parseCancelCommerceOrderV1Record,
  parseRecordCounterManualCashRefundV1 as parseRecordCounterManualCashRefundV1Record,
  parseRefundCommerceOrderTendersV1 as parseRefundCommerceOrderTendersV1Record,
  parseRefundCommerceOrderV1 as parseRefundCommerceOrderV1Record,
  parseCommerceTenderRefundV1 as parseCommerceTenderRefundV1Record,
  parseWireRefundAttempt as parseRefundAttemptRecord,
} from "@seams/commerce-contracts/records/api-after-sale";

export type CancelCommerceOrderV1 = Readonly<{
  schemaVersion: "underclerk.cancel-order.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  orderId: string;
  orderRevision: number;
  paymentId: string;
  paymentRevision: number;
  fulfillmentId: string;
  fulfillmentRevision: number;
  refundAttemptId: string;
  reason: string;
}>;

export type RefundCommerceOrderV1 = Readonly<{
  schemaVersion: "underclerk.refund-order.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  orderId: string;
  orderRevision: number;
  paymentId: string;
  paymentRevision: number;
  refundAttemptId: string;
  refundPolicyId: string;
  amount: Money;
  allocation: RefundAllocation;
  reason: string;
  /**
   * Where the money goes: back to the payment (the default), or to the
   * order's customer as store credit, with no payment provider refund.
   */
  destination?: "store_credit";
}>;

export type RecordCommerceCounterManualCashRefundV1 = Readonly<{
  schemaVersion: "underclerk.record-counter-manual-cash-refund.v1";
  merchantId: string;
  expectedMerchantRevision: number;
  idempotencyKey: string;
  requestedAt: string;
  orderId: string;
  orderRevision: number;
  paymentId: string;
  paymentRevision: number;
  refundAttemptId: string;
  refundPolicyId: string;
  amount: Money;
  allocation: RefundAllocation;
  reason: string;
}>;

/**
 * One refund that Commerce splits over the order's payments (Plan 77 step
 * 2). Named tenders take the amounts given, in that order. With none named,
 * card and manual payments come first, then gift cards and store credit,
 * each up to what it can still refund. Each part is an ordinary refund of
 * one payment, with the refund attempt `<refundId>_<digest of paymentId>`.
 */
export type RefundCommerceOrderTendersV1 = Readonly<{
  schemaVersion: "underclerk.refund-order-tenders.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: string;
  orderId: string;
  refundId: string;
  refundPolicyId: string;
  amount: Money;
  allocation: RefundAllocation;
  reason: string;
  tenders?: readonly Readonly<{ paymentId: string; amount: Money }>[];
}>;

export type CommerceTenderRefundPartV1 = Readonly<{
  paymentId: string;
  refundAttemptId: string;
  amount: Money;
  result: CommerceMutationResultV1;
}>;

/**
 * The parts of a split refund, in the order they ran. A part that is
 * refused stops the parts after it; the same command again resumes there.
 */
export type CommerceTenderRefundV1 =
  | Readonly<{
      schemaVersion: "underclerk.tender-refund.v1";
      outcome: "rejected";
      error: CommerceMutationErrorV1;
    }>
  | Readonly<{
      schemaVersion: "underclerk.tender-refund.v1";
      outcome: "split";
      orderId: string;
      parts: readonly CommerceTenderRefundPartV1[];
    }>;

export function parseRefundOrderTendersCommand(
  raw: unknown,
): RefundCommerceOrderTendersV1 {
  return decodeRecord(parseRefundCommerceOrderTendersV1Record, raw);
}

export function parseTenderRefund(raw: unknown): CommerceTenderRefundV1 {
  return decodeRecord(parseCommerceTenderRefundV1Record, raw);
}

export function parseCancelOrderCommand(raw: unknown): CancelCommerceOrderV1 {
  return decodeRecord(parseCancelCommerceOrderV1Record, raw);
}

export function parseRefundOrderCommand(raw: unknown): RefundCommerceOrderV1 {
  return decodeRecord(parseRefundCommerceOrderV1Record, raw);
}

export function parseRecordCounterManualCashRefundCommand(
  raw: unknown,
): RecordCommerceCounterManualCashRefundV1 {
  return decodeRecord(parseRecordCounterManualCashRefundV1Record, raw);
}

export function parseRefundAttempt(raw: unknown): RefundAttempt {
  return decodeRecord(parseRefundAttemptRecord, raw);
}
