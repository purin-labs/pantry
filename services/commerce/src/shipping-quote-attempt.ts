import { createHash } from "node:crypto";

import type { ShippingQuoteSnapshot } from "@seams/commerce-contracts";
import { parseShippingQuoteSnapshot } from "@seams/commerce-client";

import type { CommerceDatabase } from "./database.ts";
import {
  DurableCarrierRateQuoteProvider,
  DurableCheckoutChargeQuoteProvider,
} from "./checkout-charge-attempt.ts";
import type {
  RegionalShipping,
  ShippingQuoteRequest,
  ShippingQuoteResult,
} from "./regional-shipping.ts";
import type { VariantBy } from "@seams/type-utils";
import { hasExactKeys, isNormalizedText, isRecord } from "@seams/std";

type ShippingQuoteAttemptBase = Readonly<{
  attemptId: string;
  merchantId: string;
  storefrontId: string;
  checkoutId: string;
  checkoutRevision: number;
  buyerSessionDigest: string;
  idempotencyKey: string;
  inputDigest: string;
  createdAt: string;
  expiresAt: string;
}>;

export type ShippingQuoteAttempt =
  | (ShippingQuoteAttemptBase &
      Readonly<{
        state: "pending";
        quote?: never;
        resultKind?: never;
        field?: never;
        retryAfter?: never;
      }>)
  | (ShippingQuoteAttemptBase &
      Readonly<{
        state: "quoted";
        quote: ShippingQuoteSnapshot;
        resultKind?: never;
        field?: never;
        retryAfter?: never;
      }>)
  | (ShippingQuoteAttemptBase &
      Readonly<{
        state: "rejected";
        resultKind: "invalid_address" | "unavailable_route";
        field: string;
        quote?: never;
        retryAfter?: never;
      }>)
  | (ShippingQuoteAttemptBase &
      Readonly<{
        state: "indeterminate";
        field: string;
        retryAfter: string;
        quote?: never;
        resultKind?: never;
      }>);

export type QuoteShippingWithAttemptInput = Readonly<{
  database: CommerceDatabase;
  merchantId: string;
  storefrontId: string;
  checkoutId: string;
  checkoutRevision: number;
  buyerSessionDigest: string;
  idempotencyKey: string;
  shipping: RegionalShipping;
  request: ShippingQuoteRequest;
}>;

type ShippingQuoteAttemptRow = Readonly<{
  lifecycleState: ShippingQuoteAttempt["state"];
  attemptJson: string;
}>;

export function quoteShippingWithAttempt(
  input: QuoteShippingWithAttemptInput,
): ShippingQuoteResult {
  const attemptId = shippingQuoteAttemptId(input);
  const inputDigest = shippingQuoteInputDigest(input.request);
  const pending = pendingShippingQuoteAttempt(input, attemptId, inputDigest);
  insertPendingShippingQuoteAttempt(input.database, pending);
  const stored = readShippingQuoteAttempt(
    input.database,
    input.merchantId,
    attemptId,
  );
  if (
    stored === undefined ||
    !shippingQuoteAttemptInputMatches(stored, pending)
  ) {
    return {
      kind: "unavailable_route",
      field: "shippingQuote.attemptIdentity",
    };
  }
  switch (stored.state) {
    case "quoted":
    case "rejected":
      return shippingQuoteAttemptResult(stored);
    case "indeterminate":
      if (timestampBefore(input.request.quotedAt, stored.retryAfter)) {
        return shippingQuoteAttemptResult(stored);
      }
      return executePendingShippingQuoteAttempt(input, stored);
    case "pending":
      return executePendingShippingQuoteAttempt(input, stored);
  }
}

export function readShippingQuoteAttempt(
  database: CommerceDatabase,
  merchantId: string,
  attemptId: string,
): ShippingQuoteAttempt | undefined {
  const row = database
    .prepare(
      `SELECT lifecycle_state AS lifecycleState, attempt_json AS attemptJson
     FROM shipping_quote_attempt
     WHERE merchant_id = ? AND attempt_id = ?`,
    )
    .get<ShippingQuoteAttemptRow>(merchantId, attemptId);
  if (row === undefined) return undefined;
  const attempt = parseStoredShippingQuoteAttempt(row.attemptJson);
  if (attempt.state !== row.lifecycleState) {
    throw new Error("Stored shipping quote attempt lifecycle is inconsistent");
  }
  return attempt;
}

function pendingShippingQuoteAttempt(
  input: QuoteShippingWithAttemptInput,
  attemptId: string,
  inputDigest: string,
): VariantBy<ShippingQuoteAttempt, "state", "pending"> {
  return {
    attemptId,
    merchantId: requireText(input.merchantId, "merchantId"),
    storefrontId: requireText(input.storefrontId, "storefrontId"),
    checkoutId: requireText(input.checkoutId, "checkoutId"),
    checkoutRevision: requirePositiveInteger(
      input.checkoutRevision,
      "checkoutRevision",
    ),
    buyerSessionDigest: requireDigest(
      input.buyerSessionDigest,
      "buyerSessionDigest",
    ),
    idempotencyKey: requireText(input.idempotencyKey, "idempotencyKey"),
    inputDigest,
    createdAt: requireTimestamp(input.request.quotedAt, "quotedAt"),
    expiresAt: shippingQuoteExpiry(input.request),
    state: "pending",
  };
}

function insertPendingShippingQuoteAttempt(
  database: CommerceDatabase,
  attempt: VariantBy<ShippingQuoteAttempt, "state", "pending">,
): void {
  database
    .prepare(
      `INSERT INTO shipping_quote_attempt (
       merchant_id, attempt_id, checkout_id, checkout_revision,
       buyer_session_digest, idempotency_key, input_digest,
       lifecycle_state, attempt_json, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    )
    .run(
      attempt.merchantId,
      attempt.attemptId,
      attempt.checkoutId,
      attempt.checkoutRevision,
      attempt.buyerSessionDigest,
      attempt.idempotencyKey,
      attempt.inputDigest,
      attempt.state,
      JSON.stringify(attempt),
      attempt.createdAt,
      attempt.expiresAt,
    );
}

function executePendingShippingQuoteAttempt(
  input: QuoteShippingWithAttemptInput,
  attempt: VariantBy<
    ShippingQuoteAttempt,
    "state",
    "pending" | "indeterminate"
  >,
): ShippingQuoteResult {
  if (!timestampBefore(input.request.quotedAt, attempt.expiresAt)) {
    const expired = rejectedShippingQuoteAttempt(
      attempt,
      "unavailable_route",
      "shippingQuote.attemptExpired",
    );
    return persistTerminalShippingQuoteAttempt(
      input.database,
      attempt.state,
      expired,
    );
  }
  let result: ShippingQuoteResult;
  try {
    result = input.shipping.quote(
      providerRequestAt(input.request, attempt.createdAt),
      {
        carrierRateQuoteProvider: durableCarrierRateQuoteProvider(
          input,
          attempt,
        ),
        chargeQuoteProvider: durableChargeQuoteProvider(input, attempt),
      },
    );
  } catch {
    const indeterminate = indeterminateShippingQuoteAttempt(attempt);
    persistShippingQuoteAttempt(input.database, attempt.state, indeterminate);
    return shippingQuoteAttemptResult(indeterminate);
  }
  switch (result.kind) {
    case "quoted": {
      if (result.quote.expiresAt !== attempt.expiresAt) {
        throw new Error(
          "Shipping quote attempt expiry does not match its provider result",
        );
      }
      const quoted: VariantBy<ShippingQuoteAttempt, "state", "quoted"> = {
        ...shippingQuoteAttemptBase(attempt),
        state: "quoted",
        quote: result.quote,
      };
      return persistTerminalShippingQuoteAttempt(
        input.database,
        attempt.state,
        quoted,
      );
    }
    case "invalid_address":
    case "unavailable_route": {
      const rejected = rejectedShippingQuoteAttempt(
        attempt,
        result.kind,
        result.field,
      );
      return persistTerminalShippingQuoteAttempt(
        input.database,
        attempt.state,
        rejected,
      );
    }
    case "indeterminate": {
      const indeterminate: VariantBy<
        ShippingQuoteAttempt,
        "state",
        "indeterminate"
      > = {
        ...shippingQuoteAttemptBase(attempt),
        state: "indeterminate",
        field: result.field,
        retryAfter: result.retryAfter,
      };
      persistShippingQuoteAttempt(input.database, attempt.state, indeterminate);
      return shippingQuoteAttemptResult(indeterminate);
    }
  }
}

function durableChargeQuoteProvider(
  input: QuoteShippingWithAttemptInput,
  attempt: VariantBy<
    ShippingQuoteAttempt,
    "state",
    "pending" | "indeterminate"
  >,
): DurableCheckoutChargeQuoteProvider {
  return new DurableCheckoutChargeQuoteProvider({
    database: input.database,
    merchantId: attempt.merchantId,
    parentAttemptId: attempt.attemptId,
    checkoutId: attempt.checkoutId,
    checkoutRevision: attempt.checkoutRevision,
    buyerSessionDigest: attempt.buyerSessionDigest,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    provider: input.shipping.charges,
  });
}

function durableCarrierRateQuoteProvider(
  input: QuoteShippingWithAttemptInput,
  attempt: VariantBy<
    ShippingQuoteAttempt,
    "state",
    "pending" | "indeterminate"
  >,
): DurableCarrierRateQuoteProvider {
  return new DurableCarrierRateQuoteProvider({
    database: input.database,
    merchantId: attempt.merchantId,
    parentAttemptId: attempt.attemptId,
    checkoutId: attempt.checkoutId,
    checkoutRevision: attempt.checkoutRevision,
    buyerSessionDigest: attempt.buyerSessionDigest,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    provider: input.shipping.carrierRates,
  });
}

function persistTerminalShippingQuoteAttempt(
  database: CommerceDatabase,
  expectedState: "pending" | "indeterminate",
  attempt: VariantBy<ShippingQuoteAttempt, "state", "quoted" | "rejected">,
): ShippingQuoteResult {
  persistShippingQuoteAttempt(database, expectedState, attempt);
  const stored = readShippingQuoteAttempt(
    database,
    attempt.merchantId,
    attempt.attemptId,
  );
  if (
    stored === undefined ||
    !shippingQuoteAttemptInputMatches(stored, attempt)
  ) {
    return {
      kind: "unavailable_route",
      field: "shippingQuote.attemptPersistence",
    };
  }
  return shippingQuoteAttemptResult(stored);
}

function persistShippingQuoteAttempt(
  database: CommerceDatabase,
  expectedState: "pending" | "indeterminate",
  attempt: ShippingQuoteAttempt,
): void {
  database
    .prepare(
      `UPDATE shipping_quote_attempt
     SET lifecycle_state = ?, attempt_json = ?, expires_at = ?
     WHERE merchant_id = ? AND attempt_id = ? AND lifecycle_state = ?`,
    )
    .run(
      attempt.state,
      JSON.stringify(attempt),
      attempt.expiresAt,
      attempt.merchantId,
      attempt.attemptId,
      expectedState,
    );
}

function shippingQuoteAttemptResult(
  attempt: ShippingQuoteAttempt,
): ShippingQuoteResult {
  switch (attempt.state) {
    case "quoted":
      return { kind: "quoted", quote: attempt.quote };
    case "rejected":
      return { kind: attempt.resultKind, field: attempt.field };
    case "indeterminate":
      return {
        kind: "indeterminate",
        field: attempt.field,
        retryAfter: attempt.retryAfter,
      };
    case "pending":
      return {
        kind: "indeterminate",
        field: "shippingQuote.pending",
        retryAfter: attempt.createdAt,
      };
  }
}

function rejectedShippingQuoteAttempt(
  attempt: ShippingQuoteAttempt,
  resultKind: "invalid_address" | "unavailable_route",
  field: string,
): VariantBy<ShippingQuoteAttempt, "state", "rejected"> {
  return {
    ...shippingQuoteAttemptBase(attempt),
    state: "rejected",
    resultKind,
    field,
  };
}

function indeterminateShippingQuoteAttempt(
  attempt: ShippingQuoteAttempt,
): VariantBy<ShippingQuoteAttempt, "state", "indeterminate"> {
  const retryAt = Date.parse(attempt.createdAt) + 30_000;
  const expiresAt = Date.parse(attempt.expiresAt);
  return {
    ...shippingQuoteAttemptBase(attempt),
    state: "indeterminate",
    field: "shippingQuote.providerIndeterminate",
    retryAfter: new Date(Math.min(retryAt, expiresAt)).toISOString(),
  };
}

function shippingQuoteAttemptBase(
  attempt: ShippingQuoteAttempt,
): ShippingQuoteAttemptBase {
  return {
    attemptId: attempt.attemptId,
    merchantId: attempt.merchantId,
    storefrontId: attempt.storefrontId,
    checkoutId: attempt.checkoutId,
    checkoutRevision: attempt.checkoutRevision,
    buyerSessionDigest: attempt.buyerSessionDigest,
    idempotencyKey: attempt.idempotencyKey,
    inputDigest: attempt.inputDigest,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
  };
}

function shippingQuoteAttemptInputMatches(
  left: ShippingQuoteAttempt,
  right: ShippingQuoteAttempt,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.merchantId === right.merchantId &&
    left.storefrontId === right.storefrontId &&
    left.checkoutId === right.checkoutId &&
    left.checkoutRevision === right.checkoutRevision &&
    left.buyerSessionDigest === right.buyerSessionDigest &&
    left.idempotencyKey === right.idempotencyKey &&
    left.inputDigest === right.inputDigest
  );
}

function shippingQuoteAttemptId(
  input: Pick<
    QuoteShippingWithAttemptInput,
    "merchantId" | "buyerSessionDigest" | "idempotencyKey"
  >,
): string {
  return `shipping_quote_attempt_${sha256(
    JSON.stringify([
      input.merchantId,
      input.buyerSessionDigest,
      input.idempotencyKey,
    ]),
  )}`;
}

function shippingQuoteInputDigest(request: ShippingQuoteRequest): string {
  return sha256(
    JSON.stringify({
      shippingQuoteId: request.shippingQuoteId,
      packageId: request.packageId,
      // The route kind, as the field was named before regional extensions.
      route: request.routeBinding.kind,
      routeBinding: request.routeBinding,
      serviceCode: request.serviceCode,
      taxCalculation: request.taxCalculation,
      lines: request.lines,
      addressAuthority: {
        kind: request.addressAuthority.kind,
        addressDigest: sha256(JSON.stringify(request.addressAuthority.address)),
        addressValidationReference:
          request.addressAuthority.addressValidationReference,
        protectedAddressReference:
          request.addressAuthority.kind === "saved_address"
            ? request.addressAuthority.protectedAddressReference
            : undefined,
      },
      quoteTtlSeconds: request.quoteTtlSeconds,
    }),
  );
}

function shippingQuoteExpiry(request: ShippingQuoteRequest): string {
  if (
    !Number.isSafeInteger(request.quoteTtlSeconds) ||
    request.quoteTtlSeconds < 1
  ) {
    throw new Error("quoteTtlSeconds must be a positive integer");
  }
  return new Date(
    Date.parse(requireTimestamp(request.quotedAt, "quotedAt")) +
      request.quoteTtlSeconds * 1_000,
  ).toISOString();
}

function providerRequestAt(
  request: ShippingQuoteRequest,
  quotedAt: string,
): ShippingQuoteRequest {
  return { ...request, quotedAt };
}

function parseStoredShippingQuoteAttempt(value: string): ShippingQuoteAttempt {
  const parsed: unknown = JSON.parse(value);
  const object = requireRecord(parsed, "shippingQuoteAttempt");
  const state = requireText(object.state, "shippingQuoteAttempt.state");
  const base = parseShippingQuoteAttemptBase(object);
  switch (state) {
    case "pending":
      requireExactKeys(object, [...shippingQuoteAttemptBaseKeys(), "state"]);
      return { ...base, state };
    case "quoted": {
      requireExactKeys(object, [
        ...shippingQuoteAttemptBaseKeys(),
        "state",
        "quote",
      ]);
      const quote = parseShippingQuoteSnapshot(object.quote);
      if (quote.expiresAt !== base.expiresAt) {
        throw new Error("Stored shipping quote attempt expiry is invalid");
      }
      return { ...base, state, quote };
    }
    case "rejected":
      requireExactKeys(object, [
        ...shippingQuoteAttemptBaseKeys(),
        "state",
        "resultKind",
        "field",
      ]);
      return {
        ...base,
        state,
        resultKind: requireQuoteRejectionKind(object.resultKind),
        field: requireText(object.field, "shippingQuoteAttempt.field"),
      };
    case "indeterminate":
      requireExactKeys(object, [
        ...shippingQuoteAttemptBaseKeys(),
        "state",
        "field",
        "retryAfter",
      ]);
      return {
        ...base,
        state,
        field: requireText(object.field, "shippingQuoteAttempt.field"),
        retryAfter: requireTimestamp(
          object.retryAfter,
          "shippingQuoteAttempt.retryAfter",
        ),
      };
    default:
      throw new Error("Stored shipping quote attempt state is invalid");
  }
}

function parseShippingQuoteAttemptBase(
  object: Record<string, unknown>,
): ShippingQuoteAttemptBase {
  return {
    attemptId: requireText(object.attemptId, "shippingQuoteAttempt.attemptId"),
    merchantId: requireText(
      object.merchantId,
      "shippingQuoteAttempt.merchantId",
    ),
    storefrontId: requireText(
      object.storefrontId,
      "shippingQuoteAttempt.storefrontId",
    ),
    checkoutId: requireText(
      object.checkoutId,
      "shippingQuoteAttempt.checkoutId",
    ),
    checkoutRevision: requirePositiveInteger(
      object.checkoutRevision,
      "shippingQuoteAttempt.checkoutRevision",
    ),
    buyerSessionDigest: requireDigest(
      object.buyerSessionDigest,
      "shippingQuoteAttempt.buyerSessionDigest",
    ),
    idempotencyKey: requireText(
      object.idempotencyKey,
      "shippingQuoteAttempt.idempotencyKey",
    ),
    inputDigest: requireDigest(
      object.inputDigest,
      "shippingQuoteAttempt.inputDigest",
    ),
    createdAt: requireTimestamp(
      object.createdAt,
      "shippingQuoteAttempt.createdAt",
    ),
    expiresAt: requireTimestamp(
      object.expiresAt,
      "shippingQuoteAttempt.expiresAt",
    ),
  };
}

function shippingQuoteAttemptBaseKeys(): readonly string[] {
  return [
    "attemptId",
    "merchantId",
    "storefrontId",
    "checkoutId",
    "checkoutRevision",
    "buyerSessionDigest",
    "idempotencyKey",
    "inputDigest",
    "createdAt",
    "expiresAt",
  ];
}

function requireQuoteRejectionKind(
  value: unknown,
): "invalid_address" | "unavailable_route" {
  if (value === "invalid_address" || value === "unavailable_route")
    return value;
  throw new Error("Stored shipping quote rejection kind is invalid");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(object, keys))
    throw new Error("Stored shipping quote attempt fields are invalid");
}

function requireText(value: unknown, field: string): string {
  if (!isNormalizedText(value)) {
    throw new Error(`${field} must be normalized text`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireText(value, field);
  if (!/^[0-9a-f]{64}$/u.test(digest))
    throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireText(value, field);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${field} must be a timestamp`);
  return timestamp;
}

function timestampBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
