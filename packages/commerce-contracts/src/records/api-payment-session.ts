// Plan 78 step 2: the payment provider records that
// packages/commerce-client reads in src/payment-session.ts. Each
// schema follows its hand-written reader: exact keys, text of at most 255
// characters unless a reader names another bound, and a URL rewritten as
// `new URL(value).toString()`.
import { Type, type Static } from "typebox";
import { PositiveInteger } from "../schema.ts";
import { boundedTextSchema, utcTimestampSchema } from "./fields.ts";
import {
  commerceMutationErrorV1Schema,
  commerceMutationReceiptV1Schema,
} from "./api-mutations.ts";
import { ReadonlyStrictObject, wireRecordParser } from "./wire-objects.ts";

// The runtime global used below; the package compiles with ES types only.
declare const URL: new (input: string) => {
  protocol: string;
  hostname: string;
};

const text = boundedTextSchema(255);

/** `requireTimestamp` of payment-session.ts: any text `Date.parse` reads. */
const timestampSchema = Type.Refine(text, isTimestamp, timestampError);

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function timestampError(): string {
  return "must be a timestamp";
}

/** `requireUrl`: HTTPS or localhost, as `new URL(value).toString()`. */
const urlSchema = Type.Codec(
  Type.Refine(boundedTextSchema(2048), isPaymentUrl, paymentUrlError),
)
  .Decode(normalizedUrl)
  .Encode(sameText);

function isPaymentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function paymentUrlError(): string {
  return "must use HTTPS";
}

function normalizedUrl(value: string): string {
  return new URL(value).toString();
}

function sameText(value: string): string {
  return value;
}

export const commercePaymentMoneyV1Schema = ReadonlyStrictObject({
  amountMinor: PositiveInteger,
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
});
export type CommercePaymentMoneyV1 = Static<
  typeof commercePaymentMoneyV1Schema
>;

export const commercePaymentClientConfirmationV1Schema = Type.Union([
  ReadonlyStrictObject({ kind: Type.Literal("provider_ui_completed") }),
  ReadonlyStrictObject({
    kind: Type.Literal("square_source_token"),
    sourceToken: boundedTextSchema(512),
  }),
]);
export type CommercePaymentClientConfirmationV1 = Static<
  typeof commercePaymentClientConfirmationV1Schema
>;

export const commercePaymentPublicConfigurationV1Schema = Type.Union([
  ReadonlyStrictObject({
    provider: Type.Literal("stripe_online"),
    clientSecret: boundedTextSchema(512),
    publishableKey: boundedTextSchema(256),
    connectedAccountId: text,
  }),
  ReadonlyStrictObject({
    provider: Type.Literal("gmo_pg_online"),
    shopId: text,
  }),
  ReadonlyStrictObject({
    provider: Type.Literal("square_online"),
    applicationId: text,
    locationId: text,
    environment: Type.Union([
      Type.Literal("development"),
      Type.Literal("production"),
    ]),
  }),
]);
export type CommercePaymentPublicConfigurationV1 = Static<
  typeof commercePaymentPublicConfigurationV1Schema
>;

export const commercePaymentPublicSessionV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("embedded_public_session"),
    providerSessionReference: text,
    publicConfiguration: commercePaymentPublicConfigurationV1Schema,
    expiresAt: timestampSchema,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("hosted_redirect"),
    providerSessionReference: text,
    redirectUrl: urlSchema,
    returnUrl: urlSchema,
    expiresAt: timestampSchema,
  }),
]);
export type CommercePaymentPublicSessionV1 = Static<
  typeof commercePaymentPublicSessionV1Schema
>;

export const commercePaymentSessionResultV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.payment-session-result.v1"),
    kind: Type.Literal("ready"),
    paymentAttemptId: text,
    session: commercePaymentPublicSessionV1Schema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.payment-session-result.v1"),
    kind: Type.Literal("unavailable"),
    reason: text,
    retryAfter: timestampSchema,
  }),
]);
export type CommercePaymentSessionResultV1 = Static<
  typeof commercePaymentSessionResultV1Schema
>;

export const commerceInPersonCollectionSessionV1Schema = ReadonlyStrictObject(
  {
    kind: Type.Literal("server_terminal_checkout"),
    providerCheckoutReference: text,
    deviceId: text,
    expiresAt: timestampSchema,
  },
);
export type CommerceInPersonCollectionSessionV1 = Static<
  typeof commerceInPersonCollectionSessionV1Schema
>;

export const commerceInPersonCollectionResultV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.in-person-collection-result.v1"),
    kind: Type.Literal("ready"),
    paymentAttemptId: text,
    session: commerceInPersonCollectionSessionV1Schema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.in-person-collection-result.v1"),
    kind: Type.Literal("unavailable"),
    reason: text,
    retryAfter: timestampSchema,
  }),
]);
export type CommerceInPersonCollectionResultV1 = Static<
  typeof commerceInPersonCollectionResultV1Schema
>;

export const commercePaymentRefundResultV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.payment-refund-result.v1"),
    kind: Type.Literal("refunded"),
    providerRefundReference: text,
    money: commercePaymentMoneyV1Schema,
    refundedAt: timestampSchema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.payment-refund-result.v1"),
    kind: Type.Literal("processing"),
    reconciliationIdentity: text,
    reconcileAfter: timestampSchema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.payment-refund-result.v1"),
    kind: Type.Literal("rejected"),
    reason: boundedTextSchema(512),
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.payment-refund-result.v1"),
    kind: Type.Literal("indeterminate"),
    reconciliationIdentity: text,
    reconcileAfter: timestampSchema,
  }),
]);
export type CommercePaymentRefundResultV1 = Static<
  typeof commercePaymentRefundResultV1Schema
>;

export const createCommerceBuyerPaymentSessionV1Schema = ReadonlyStrictObject(
  {
    schemaVersion: Type.Literal("underclerk.create-buyer-payment-session.v1"),
    idempotencyKey: text,
    checkoutRevision: PositiveInteger,
    quoteDigest: text,
    returnUrl: urlSchema,
  },
);
export type CreateCommerceBuyerPaymentSessionV1 = Static<
  typeof createCommerceBuyerPaymentSessionV1Schema
>;

export const reconcileCommerceBuyerPaymentV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.reconcile-buyer-payment.v1"),
  idempotencyKey: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
  confirmation: commercePaymentClientConfirmationV1Schema,
});
export type ReconcileCommerceBuyerPaymentV1 = Static<
  typeof reconcileCommerceBuyerPaymentV1Schema
>;

export const commerceBuyerPaymentSessionV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.buyer-payment-session.v1"),
    state: Type.Literal("ready"),
    checkoutId: text,
    checkoutRevision: PositiveInteger,
    paymentAttemptId: text,
    session: commercePaymentPublicSessionV1Schema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.buyer-payment-session.v1"),
    state: Type.Literal("unavailable"),
    checkoutId: text,
    retryAfter: timestampSchema,
  }),
]);
export type CommerceBuyerPaymentSessionV1 = Static<
  typeof commerceBuyerPaymentSessionV1Schema
>;

/**
 * `parseInPersonCheckoutPaymentCollection` in admin-client.ts: the checkout
 * mutation and, when it is ready, the terminal session that collects it.
 * Its text and timestamps follow the admin readers in wire-readers.ts.
 */
export const commerceInPersonCheckoutPaymentCollectionV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal(
      "underclerk.in-person-checkout-payment-collection.v1",
    ),
    outcome: Type.Literal("ready"),
    mutationOutcome: Type.Union([
      Type.Literal("applied"),
      Type.Literal("replayed"),
    ]),
    receipt: commerceMutationReceiptV1Schema,
    paymentAttemptId: text,
    session: commerceInPersonCollectionSessionV1Schema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal(
      "underclerk.in-person-checkout-payment-collection.v1",
    ),
    outcome: Type.Literal("unavailable"),
    mutationOutcome: Type.Union([
      Type.Literal("applied"),
      Type.Literal("replayed"),
    ]),
    receipt: commerceMutationReceiptV1Schema,
    retryAfter: utcTimestampSchema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal(
      "underclerk.in-person-checkout-payment-collection.v1",
    ),
    outcome: Type.Literal("rejected"),
    error: commerceMutationErrorV1Schema,
  }),
]);
export type CommerceInPersonCheckoutPaymentCollectionV1 = Static<
  typeof commerceInPersonCheckoutPaymentCollectionV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceBuyerPaymentSessionV1 = wireRecordParser(
  createCommerceBuyerPaymentSessionV1Schema,
);
export const parseReconcileCommerceBuyerPaymentV1 = wireRecordParser(
  reconcileCommerceBuyerPaymentV1Schema,
);
export const parseCommerceBuyerPaymentSessionV1 = wireRecordParser(
  commerceBuyerPaymentSessionV1Schema,
);
export const parseCommerceInPersonCollectionResultV1 = wireRecordParser(
  commerceInPersonCollectionResultV1Schema,
);
export const parseCommercePaymentRefundResultV1 = wireRecordParser(
  commercePaymentRefundResultV1Schema,
);
export const parseCommercePaymentSessionResultV1 = wireRecordParser(
  commercePaymentSessionResultV1Schema,
);
export const parseCommerceInPersonCheckoutPaymentCollectionV1 =
  wireRecordParser(commerceInPersonCheckoutPaymentCollectionV1Schema);
