// Plan 78 step 2: the payment dispute records that
// packages/commerce-client reads in src/payment-dispute.ts. Each
// schema follows its hand-written reader: exact keys, text of at most 255
// characters, RFC 3339 timestamps kept as written, and a response due after
// the dispute was observed, compared to the nanosecond.
import { Type, type Static } from "typebox";
import { boundedTextSchema } from "./fields.ts";
import { PositiveInteger } from "@purin-labs/contract-schema";
import type {
  PaymentDispute,
  PaymentDisputeLifecycle,
} from "../commerce-domain.ts";
import type { Money } from "./money.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = boundedTextSchema(255);

const RFC3339_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

const timestampSchema = Type.Refine(text, isTimestamp, timestampError);

function isTimestamp(value: string): boolean {
  return RFC3339_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function timestampError(): string {
  return "must be an RFC 3339 timestamp";
}

function timestampNanoseconds(timestamp: string): bigint {
  const fraction = RFC3339_TIMESTAMP.exec(timestamp)?.[2] ?? "";
  const wholeSecond = timestamp.replace(
    /\.\d{1,9}(?=(?:Z|[+-]\d{2}:\d{2})$)/u,
    "",
  );
  return (
    BigInt(Date.parse(wholeSecond)) * 1_000_000n +
    BigInt(fraction.padEnd(9, "0"))
  );
}

/** Exact `{ amountMinor, currency }` with an amount above zero. */
const disputeMoneySchema = Type.Unsafe<Money>(
  ReadonlyStrictObject({
    amountMinor: PositiveInteger,
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  }),
);

/** At most 2,048 characters each, each reference once. */
const evidenceReferencesSchema = Type.Refine(
  Type.Array(boundedTextSchema(2_048)),
  hasDistinctReferences,
  duplicateReferencesError,
);

function hasDistinctReferences(references: readonly string[]): boolean {
  return new Set(references).size === references.length;
}

function duplicateReferencesError(): string {
  return "contains duplicates";
}

function dueAfterObserved(lifecycle: {
  readonly observedAt: string;
  readonly responseDueAt: string;
}): boolean {
  return (
    timestampNanoseconds(lifecycle.responseDueAt) >
    timestampNanoseconds(lifecycle.observedAt)
  );
}

function dueBeforeObservedError(): string {
  return "responseDueAt must follow observedAt";
}

const lifecycleSchema = Type.Unsafe<PaymentDisputeLifecycle>(
  Type.Union([
    Type.Refine(
      ReadonlyStrictObject({
        state: Type.Literal("action_required"),
        observedAt: timestampSchema,
        responseDueAt: timestampSchema,
      }),
      dueAfterObserved,
      dueBeforeObservedError,
    ),
    ReadonlyStrictObject({
      state: Type.Literal("under_review"),
      observedAt: timestampSchema,
    }),
    ReadonlyStrictObject({
      state: Type.Union([Type.Literal("won"), Type.Literal("lost")]),
      resolvedAt: timestampSchema,
    }),
  ]),
);

export const observeCommercePaymentDisputeV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.observe-payment-dispute.v1"),
  organisationId: text,
  merchantId: text,
  providerDeliveryId: text,
  receivedAt: timestampSchema,
  checkoutId: text,
  paymentAttemptId: text,
  providerPaymentReference: text,
  providerDisputeReference: text,
  amount: disputeMoneySchema,
  reason: boundedTextSchema(512),
  evidenceReferences: ImmutableArray(boundedTextSchema(2_048)),
  lifecycle: lifecycleSchema,
});

/** The command with its evidence references each named once. */
const observePaymentDisputeSchema = Type.Refine(
  observeCommercePaymentDisputeV1Schema,
  hasDistinctEvidence,
  duplicateReferencesError,
);
export type ObserveCommercePaymentDisputeV1 = Static<
  typeof observeCommercePaymentDisputeV1Schema
>;

function hasDistinctEvidence(value: {
  readonly evidenceReferences: readonly string[];
}): boolean {
  return hasDistinctReferences(value.evidenceReferences);
}

export const wirePaymentDisputeSchema = Type.Unsafe<PaymentDispute>(
  ReadonlyStrictObject({
    disputeId: text,
    orderId: text,
    paymentId: text,
    revision: PositiveInteger,
    providerDisputeReference: text,
    amount: disputeMoneySchema,
    reason: boundedTextSchema(512),
    evidenceReferences: evidenceReferencesSchema,
    lifecycle: lifecycleSchema,
  }),
);

// Parsers of the client API types (Plan 78 step 2).
export const parseObserveCommercePaymentDisputeV1 = wireRecordParser(
  observePaymentDisputeSchema,
);
export const parseWirePaymentDispute = wireRecordParser(
  wirePaymentDisputeSchema,
);
