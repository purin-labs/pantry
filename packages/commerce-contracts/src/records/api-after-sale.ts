// Plan 78 step 2: the cancellation and refund records that
// packages/commerce-client reads in src/after-sale.ts. Each schema
// follows its hand-written reader: exact keys, text of at most 255
// characters unless a reader names another bound, and a refund allocation in
// one currency whose parts add up to the refund.
import { Type, type Static } from "typebox";
import { boundedTextSchema } from "./fields.ts";
import { NonNegativeInteger, PositiveInteger } from "../schema.ts";
import type { RefundAllocation, RefundAttempt } from "../commerce-domain.ts";
import type { Money } from "./money.ts";
import {
  commerceMutationErrorV1Schema,
  commerceMutationResultV1Schema,
} from "./api-mutations.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = boundedTextSchema(255);

/** `requireTimestamp` of after-sale.ts: text that `Date.parse` reads. */
const timestampSchema = Type.Refine(text, isTimestamp, timestampError);

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function timestampError(): string {
  return "must be a timestamp";
}

function money(amountMinor: typeof NonNegativeInteger) {
  return Type.Unsafe<Money>(
    ReadonlyStrictObject({
      amountMinor,
      currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    }),
  );
}

/** `parseMoney(…, false)`: an amount above zero. */
const positiveMoneySchema = money(PositiveInteger);
/** `parseMoney(…, true)`: zero or more. */
const moneySchema = money(NonNegativeInteger);

const lineAllocationSchema = ReadonlyStrictObject({
  orderLineId: text,
  amount: positiveMoneySchema,
});

type LineAllocation = Readonly<{ orderLineId: string; amount: Money }>;
type AllocationFields = Readonly<{
  lineAllocations: readonly LineAllocation[];
  taxAllocations: readonly LineAllocation[];
  dutyAllocations: readonly LineAllocation[];
  shippingAllocation: Money;
}>;

/** The currency and total of an allocation that is valid, or undefined. */
function allocationTotal(
  allocation: AllocationFields,
): Readonly<{ currency: string; totalMinor: number }> | undefined {
  const currency = allocation.shippingAllocation.currency;
  let totalMinor = allocation.shippingAllocation.amountMinor;
  for (const list of [
    allocation.lineAllocations,
    allocation.taxAllocations,
    allocation.dutyAllocations,
  ]) {
    if (new Set(list.map(lineIdOf)).size !== list.length) return undefined;
  }
  for (const part of [
    ...allocation.lineAllocations,
    ...allocation.taxAllocations,
    ...allocation.dutyAllocations,
  ]) {
    if (part.amount.currency !== currency) return undefined;
    totalMinor += part.amount.amountMinor;
    if (!Number.isSafeInteger(totalMinor)) return undefined;
  }
  return totalMinor > 0 ? { currency, totalMinor } : undefined;
}

function lineIdOf(allocation: LineAllocation): string {
  return allocation.orderLineId;
}

function isAllocation(value: unknown): boolean {
  return allocationTotal(value as AllocationFields) !== undefined;
}

function allocationError(): string {
  return "the allocation must be positive, in one currency, each line once";
}

export const wireRefundAllocationSchema = Type.Unsafe<RefundAllocation>(
  Type.Refine(
    ReadonlyStrictObject({
      lineAllocations: Type.Array(lineAllocationSchema),
      taxAllocations: Type.Array(lineAllocationSchema),
      dutyAllocations: Type.Array(lineAllocationSchema),
      shippingAllocation: moneySchema,
    }),
    isAllocation,
    allocationError,
  ),
);

/** A command whose allocation adds up to its amount, in its currency. */
function allocationMatchesAmount(value: unknown): boolean {
  const command = value as Readonly<{
    amount: Money;
    allocation: AllocationFields;
  }>;
  const total = allocationTotal(command.allocation);
  return (
    total !== undefined &&
    total.currency === command.amount.currency &&
    total.totalMinor === command.amount.amountMinor
  );
}

function allocationMismatch(): string {
  return "allocation must equal amount";
}

export const cancelCommerceOrderV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.cancel-order.v1"),
  merchantId: text,
  expectedMerchantRevision: NonNegativeInteger,
  idempotencyKey: text,
  requestedAt: timestampSchema,
  orderId: text,
  orderRevision: PositiveInteger,
  paymentId: text,
  paymentRevision: PositiveInteger,
  fulfillmentId: text,
  fulfillmentRevision: PositiveInteger,
  refundAttemptId: text,
  reason: boundedTextSchema(512),
});
export type CancelCommerceOrderV1 = Static<
  typeof cancelCommerceOrderV1Schema
>;

export const refundCommerceOrderV1Schema = Type.Refine(
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.refund-order.v1"),
    merchantId: text,
    expectedMerchantRevision: NonNegativeInteger,
    idempotencyKey: text,
    requestedAt: timestampSchema,
    orderId: text,
    orderRevision: PositiveInteger,
    paymentId: text,
    paymentRevision: PositiveInteger,
    refundAttemptId: text,
    refundPolicyId: text,
    amount: positiveMoneySchema,
    allocation: wireRefundAllocationSchema,
    reason: boundedTextSchema(512),
    destination: Type.Optional(Type.Literal("store_credit")),
  }),
  allocationMatchesAmount,
  allocationMismatch,
);
export type RefundCommerceOrderV1 = Static<
  typeof refundCommerceOrderV1Schema
>;

export const recordCounterManualCashRefundV1Schema = Type.Refine(
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.record-counter-manual-cash-refund.v1"),
    merchantId: text,
    expectedMerchantRevision: NonNegativeInteger,
    idempotencyKey: text,
    requestedAt: timestampSchema,
    orderId: text,
    orderRevision: PositiveInteger,
    paymentId: text,
    paymentRevision: PositiveInteger,
    refundAttemptId: text,
    refundPolicyId: text,
    amount: positiveMoneySchema,
    allocation: wireRefundAllocationSchema,
    reason: boundedTextSchema(512),
  }),
  allocationMatchesAmount,
  allocationMismatch,
);
export type RecordCommerceCounterManualCashRefundV1 = Static<
  typeof recordCounterManualCashRefundV1Schema
>;

const tenderSchema = ReadonlyStrictObject({
  paymentId: text,
  amount: positiveMoneySchema,
});

/** Named tenders: each payment once, in the amount's currency, adding up. */
function tendersMatchAmount(value: unknown): boolean {
  const command = value as Readonly<{
    amount: Money;
    tenders?: readonly Readonly<{ paymentId: string; amount: Money }>[];
  }>;
  if (command.tenders === undefined) return true;
  const tenders = command.tenders;
  if (
    tenders.length === 0 ||
    new Set(tenders.map(paymentIdOf)).size !== tenders.length
  )
    return false;
  let named = 0;
  for (const tender of tenders) {
    if (tender.amount.currency !== command.amount.currency) return false;
    named += tender.amount.amountMinor;
    if (!Number.isSafeInteger(named)) return false;
  }
  return named === command.amount.amountMinor;
}

function paymentIdOf(tender: Readonly<{ paymentId: string }>): string {
  return tender.paymentId;
}

function tendersMismatch(): string {
  return "tenders must name each payment once and add up to amount";
}

export const refundCommerceOrderTendersV1Schema = Type.Refine(
  Type.Refine(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("underclerk.refund-order-tenders.v1"),
      merchantId: text,
      idempotencyKey: text,
      requestedAt: timestampSchema,
      orderId: text,
      refundId: boundedTextSchema(200),
      refundPolicyId: text,
      amount: positiveMoneySchema,
      allocation: wireRefundAllocationSchema,
      reason: boundedTextSchema(512),
      tenders: Type.Optional(ImmutableArray(tenderSchema)),
    }),
    allocationMatchesAmount,
    allocationMismatch,
  ),
  tendersMatchAmount,
  tendersMismatch,
);
export type RefundCommerceOrderTendersV1 = Static<
  typeof refundCommerceOrderTendersV1Schema
>;

export const commerceTenderRefundPartV1Schema = ReadonlyStrictObject({
  paymentId: text,
  refundAttemptId: text,
  amount: positiveMoneySchema,
  result: commerceMutationResultV1Schema,
});
export type CommerceTenderRefundPartV1 = Static<
  typeof commerceTenderRefundPartV1Schema
>;

export const commerceTenderRefundV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.tender-refund.v1"),
    outcome: Type.Literal("rejected"),
    error: commerceMutationErrorV1Schema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.tender-refund.v1"),
    outcome: Type.Literal("split"),
    orderId: text,
    parts: ImmutableArray(commerceTenderRefundPartV1Schema),
  }),
]);
export type CommerceTenderRefundV1 = Static<
  typeof commerceTenderRefundV1Schema
>;

const refundReasonSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("cancellation"),
    reason: boundedTextSchema(512),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("order_refund"),
    policyId: text,
    reason: boundedTextSchema(512),
  }),
]);

const refundLifecycleSchema = Type.Union([
  ReadonlyStrictObject({
    state: Type.Literal("requested"),
    requestedAt: timestampSchema,
  }),
  ReadonlyStrictObject({
    state: Type.Union([
      Type.Literal("processing"),
      Type.Literal("indeterminate"),
    ]),
    reconciliationIdentity: text,
    reconcileAfter: timestampSchema,
  }),
  ReadonlyStrictObject({
    state: Type.Literal("succeeded"),
    providerRefundReference: text,
    refundedAt: timestampSchema,
  }),
  ReadonlyStrictObject({
    state: Type.Literal("failed"),
    reason: boundedTextSchema(512),
    failedAt: timestampSchema,
  }),
]);

export const wireRefundAttemptSchema = Type.Unsafe<RefundAttempt>(
  ReadonlyStrictObject({
    refundAttemptId: text,
    orderId: text,
    paymentId: text,
    revision: PositiveInteger,
    reason: refundReasonSchema,
    allocation: wireRefundAllocationSchema,
    idempotencyIdentity: text,
    lifecycle: refundLifecycleSchema,
  }),
);

// Parsers of the client API types (Plan 78 step 2).
export const parseCancelCommerceOrderV1 = wireRecordParser(
  cancelCommerceOrderV1Schema,
);
export const parseRefundCommerceOrderTendersV1 = wireRecordParser(
  refundCommerceOrderTendersV1Schema,
);
export const parseRefundCommerceOrderV1 = wireRecordParser(
  refundCommerceOrderV1Schema,
);
export const parseRecordCounterManualCashRefundV1 = wireRecordParser(
  recordCounterManualCashRefundV1Schema,
);
export const parseCommerceTenderRefundV1 = wireRecordParser(
  commerceTenderRefundV1Schema,
);
export const parseWireRefundAttempt = wireRecordParser(wireRefundAttemptSchema);
