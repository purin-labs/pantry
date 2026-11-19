import { createHash } from "node:crypto";

import type {
  CommerceBuyerShippingAddressAcceptanceV1,
  CommerceBuyerShippingAddressV1,
  CommerceBuyerShippingAddressValidationV1,
} from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "./database.ts";
import { assertNever, isNormalizedText, isRecord } from "@purin-labs/std";

type AddressValidationProviderResult =
  | Readonly<{
      state: "accepted";
      providerValidationReference: string;
      address: CommerceBuyerShippingAddressV1;
      proposedAddress?: never;
      reason?: never;
      retryAfter?: never;
    }>
  | Readonly<{
      state: "correction_required";
      providerValidationReference: string;
      proposedAddress: CommerceBuyerShippingAddressV1;
      address?: never;
      reason?: never;
      retryAfter?: never;
    }>
  | Readonly<{
      state: "unserviceable";
      providerValidationReference: string;
      reason: string;
      address?: never;
      proposedAddress?: never;
      retryAfter?: never;
    }>
  | Readonly<{
      state: "indeterminate";
      providerValidationReference: string;
      retryAfter: string;
      address?: never;
      proposedAddress?: never;
      reason?: never;
    }>;

type AddressValidationProvider = Readonly<{
  providerAccountReference: string;
  validate: (
    input: Readonly<{
      attemptId: string;
      address: CommerceBuyerShippingAddressV1;
    }>,
  ) => Promise<AddressValidationProviderResult>;
}>;

type AddressValidationAttemptBase = Readonly<{
  attemptId: string;
  merchantId: string;
  storefrontId: string;
  buyerSessionDigest: string;
  idempotencyKey: string;
  inputAddressDigest: string;
  providerAccountReference: string;
  providerValidationReference: string;
  createdAt: string;
  expiresAt: string;
}>;

type AddressValidationAttempt = AddressValidationAttemptBase &
  (
    | Readonly<{
        state: "accepted";
        acceptedAddressDigest: string;
        proposedAddressDigest?: never;
        reason?: never;
        retryAfter?: never;
      }>
    | Readonly<{
        state: "correction_required";
        proposedAddressDigest: string;
        acceptedAddressDigest?: never;
        reason?: never;
        retryAfter?: never;
      }>
    | Readonly<{
        state: "unserviceable";
        reason: string;
        acceptedAddressDigest?: never;
        proposedAddressDigest?: never;
        retryAfter?: never;
      }>
    | Readonly<{
        state: "indeterminate";
        retryAfter: string;
        acceptedAddressDigest?: never;
        proposedAddressDigest?: never;
        reason?: never;
      }>
  );

type AddressValidationServiceResult =
  | Readonly<{
      kind: "resolved";
      value: CommerceBuyerShippingAddressValidationV1;
    }>
  | Readonly<{ kind: "idempotency_conflict" }>;

type AcceptedProvidedShippingAddress = Readonly<{
  address: CommerceBuyerShippingAddressV1;
  addressValidationReference: string;
}>;

type ShippingAddressValidationServiceOptions = Readonly<{
  database: CommerceDatabase;
  provider: AddressValidationProvider;
  now: () => string;
  validitySeconds: number;
}>;

type AddressValidationAttemptRow = Readonly<{ attemptJson: string }>;

export class ShippingAddressValidationService {
  readonly #database: CommerceDatabase;
  readonly #provider: AddressValidationProvider;
  readonly #now: () => string;
  readonly #validitySeconds: number;

  constructor(options: ShippingAddressValidationServiceOptions) {
    if (
      !Number.isSafeInteger(options.validitySeconds) ||
      options.validitySeconds < 1
    ) {
      throw new Error(
        "Address validation validitySeconds must be a positive integer",
      );
    }
    this.#database = options.database;
    this.#provider = options.provider;
    this.#now = options.now;
    this.#validitySeconds = options.validitySeconds;
  }

  async validate(
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      buyerSessionDigest: string;
      idempotencyKey: string;
      address: CommerceBuyerShippingAddressV1;
    }>,
  ): Promise<AddressValidationServiceResult> {
    const inputAddressDigest = addressDigest(input.address);
    const attemptId = addressValidationAttemptId(input);
    const existing = readAddressValidationAttempt(
      this.#database,
      input.merchantId,
      attemptId,
    );
    if (
      existing !== undefined &&
      !attemptInputMatches(existing, input, inputAddressDigest)
    ) {
      return { kind: "idempotency_conflict" };
    }
    const providerResult = await this.#provider.validate({
      attemptId,
      address: input.address,
    });
    const createdAt = existing?.createdAt ?? this.#now();
    const attempt = toAddressValidationAttempt({
      ...input,
      attemptId,
      inputAddressDigest,
      providerAccountReference: this.#provider.providerAccountReference,
      providerResult,
      createdAt,
      expiresAt:
        existing?.expiresAt ??
        timestampAfterSeconds(createdAt, this.#validitySeconds),
    });
    if (existing !== undefined && !attemptReplayMatches(existing, attempt)) {
      throw new Error(
        "Address validation provider changed an idempotent attempt",
      );
    }
    writeAddressValidationAttempt(this.#database, attempt);
    return {
      kind: "resolved",
      value: toBuyerAddressValidation(attempt, providerResult),
    };
  }

  accept(
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      buyerSessionDigest: string;
      address: CommerceBuyerShippingAddressV1;
      acceptance: CommerceBuyerShippingAddressAcceptanceV1;
    }>,
  ): AcceptedProvidedShippingAddress | undefined {
    const attempt = readAddressValidationAttempt(
      this.#database,
      input.merchantId,
      input.acceptance.addressValidationReference,
    );
    if (
      attempt === undefined ||
      !attemptScopeMatches(attempt, input) ||
      Date.parse(attempt.expiresAt) <= Date.parse(this.#now())
    ) {
      return undefined;
    }
    const digest = addressDigest(input.address);
    switch (input.acceptance.kind) {
      case "accepted_as_entered":
        return attempt.state === "accepted" &&
          attempt.acceptedAddressDigest === digest
          ? {
              address: input.address,
              addressValidationReference: attempt.attemptId,
            }
          : undefined;
      case "accepted_correction":
        return attempt.state === "correction_required" &&
          attempt.proposedAddressDigest === digest
          ? {
              address: input.address,
              addressValidationReference: attempt.attemptId,
            }
          : undefined;
      default:
        return assertNever(
          input.acceptance,
          "Unsupported address validation branch",
        );
    }
  }
}

export const localAddressValidationProvider: AddressValidationProvider = {
  providerAccountReference: "underclerk_local_address_validation_v1",
  validate: validateLocalAddress,
};

export function createLocalShippingAddressValidationService(
  database: CommerceDatabase,
  now: () => string,
): ShippingAddressValidationService {
  return new ShippingAddressValidationService({
    database,
    provider: localAddressValidationProvider,
    now,
    validitySeconds: 1_800,
  });
}

async function validateLocalAddress(
  input: Readonly<{
    attemptId: string;
    address: CommerceBuyerShippingAddressV1;
  }>,
): Promise<AddressValidationProviderResult> {
  const proposedAddress = normalizeAddressWhitespace(input.address);
  const providerValidationReference = `local_${sha256(
    JSON.stringify([input.attemptId, addressDigest(proposedAddress)]),
  )}`;
  return addressDigest(proposedAddress) === addressDigest(input.address)
    ? {
        state: "accepted",
        providerValidationReference,
        address: proposedAddress,
      }
    : {
        state: "correction_required",
        providerValidationReference,
        proposedAddress,
      };
}

function normalizeAddressWhitespace(
  address: CommerceBuyerShippingAddressV1,
): CommerceBuyerShippingAddressV1 {
  switch (address.countryCode) {
    case "JP":
      return {
        countryCode: "JP",
        recipientName: collapseWhitespace(address.recipientName),
        addressLine1: collapseWhitespace(address.addressLine1),
        locality: collapseWhitespace(address.locality),
        administrativeArea: collapseWhitespace(address.administrativeArea),
        postalCode: address.postalCode,
      };
    case "SG":
      return {
        countryCode: "SG",
        recipientName: collapseWhitespace(address.recipientName),
        addressLine1: collapseWhitespace(address.addressLine1),
        locality: "Singapore",
        postalCode: address.postalCode,
      };
    default:
      return {
        countryCode: address.countryCode,
        recipientName: collapseWhitespace(address.recipientName),
        addressLine1: collapseWhitespace(address.addressLine1),
        locality: collapseWhitespace(address.locality),
        ...(address.administrativeArea === undefined
          ? {}
          : {
              administrativeArea: collapseWhitespace(
                address.administrativeArea,
              ),
            }),
        postalCode: address.postalCode,
      };
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ");
}

function toAddressValidationAttempt(
  input: Readonly<{
    attemptId: string;
    merchantId: string;
    storefrontId: string;
    buyerSessionDigest: string;
    idempotencyKey: string;
    inputAddressDigest: string;
    providerAccountReference: string;
    providerResult: AddressValidationProviderResult;
    createdAt: string;
    expiresAt: string;
  }>,
): AddressValidationAttempt {
  const base: AddressValidationAttemptBase = {
    attemptId: input.attemptId,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    buyerSessionDigest: input.buyerSessionDigest,
    idempotencyKey: input.idempotencyKey,
    inputAddressDigest: input.inputAddressDigest,
    providerAccountReference: input.providerAccountReference,
    providerValidationReference:
      input.providerResult.providerValidationReference,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  switch (input.providerResult.state) {
    case "accepted": {
      const acceptedAddressDigest = addressDigest(input.providerResult.address);
      if (acceptedAddressDigest !== input.inputAddressDigest) {
        throw new Error(
          "Address validation provider accepted a different address",
        );
      }
      return {
        ...base,
        state: "accepted",
        acceptedAddressDigest,
      };
    }
    case "correction_required": {
      const proposedAddressDigest = addressDigest(
        input.providerResult.proposedAddress,
      );
      if (proposedAddressDigest === input.inputAddressDigest) {
        throw new Error(
          "Address validation provider proposed the original address",
        );
      }
      return {
        ...base,
        state: "correction_required",
        proposedAddressDigest,
      };
    }
    case "unserviceable":
      return {
        ...base,
        state: "unserviceable",
        reason: input.providerResult.reason,
      };
    case "indeterminate":
      return {
        ...base,
        state: "indeterminate",
        retryAfter: input.providerResult.retryAfter,
      };
    default:
      return assertNever(
        input.providerResult,
        "Unsupported address validation branch",
      );
  }
}

function toBuyerAddressValidation(
  attempt: AddressValidationAttempt,
  providerResult: AddressValidationProviderResult,
): CommerceBuyerShippingAddressValidationV1 {
  const base = {
    schemaVersion: "underclerk.buyer-shipping-address-validation.v1" as const,
    validationReference: attempt.attemptId,
    expiresAt: attempt.expiresAt,
  };
  switch (providerResult.state) {
    case "accepted":
      return { ...base, state: "accepted", address: providerResult.address };
    case "correction_required":
      return {
        ...base,
        state: "correction_required",
        proposedAddress: providerResult.proposedAddress,
      };
    case "unserviceable":
      return { ...base, state: "unserviceable", reason: providerResult.reason };
    case "indeterminate":
      return {
        ...base,
        state: "indeterminate",
        retryAfter: providerResult.retryAfter,
      };
    default:
      return assertNever(
        providerResult,
        "Unsupported address validation branch",
      );
  }
}

function writeAddressValidationAttempt(
  database: CommerceDatabase,
  attempt: AddressValidationAttempt,
): void {
  database
    .prepare(
      `INSERT INTO address_validation_attempt (
       merchant_id, attempt_id, buyer_session_digest, idempotency_key,
       lifecycle_state, attempt_json, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, attempt_id) DO UPDATE SET
       lifecycle_state = excluded.lifecycle_state,
       attempt_json = excluded.attempt_json,
       expires_at = excluded.expires_at`,
    )
    .run(
      attempt.merchantId,
      attempt.attemptId,
      attempt.buyerSessionDigest,
      attempt.idempotencyKey,
      attempt.state,
      JSON.stringify(attempt),
      attempt.createdAt,
      attempt.expiresAt,
    );
}

function readAddressValidationAttempt(
  database: CommerceDatabase,
  merchantId: string,
  attemptId: string,
): AddressValidationAttempt | undefined {
  const row = database
    .prepare(
      `SELECT attempt_json AS attemptJson
     FROM address_validation_attempt
     WHERE merchant_id = ? AND attempt_id = ?`,
    )
    .get<AddressValidationAttemptRow>(merchantId, attemptId);
  return row === undefined
    ? undefined
    : parseStoredAddressValidationAttempt(row.attemptJson);
}

function parseStoredAddressValidationAttempt(
  value: string,
): AddressValidationAttempt {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed))
    throw new Error("Stored address validation attempt is invalid");
  const state = parsed.state;
  const base = parseAttemptBase(parsed);
  switch (state) {
    case "accepted":
      return {
        ...base,
        state,
        acceptedAddressDigest: requireDigest(parsed.acceptedAddressDigest),
      };
    case "correction_required":
      return {
        ...base,
        state,
        proposedAddressDigest: requireDigest(parsed.proposedAddressDigest),
      };
    case "unserviceable":
      return { ...base, state, reason: requireText(parsed.reason) };
    case "indeterminate":
      return {
        ...base,
        state,
        retryAfter: requireTimestamp(parsed.retryAfter),
      };
    default:
      throw new Error("Stored address validation attempt state is invalid");
  }
}

function parseAttemptBase(
  value: Record<string, unknown>,
): AddressValidationAttemptBase {
  return {
    attemptId: requireText(value.attemptId),
    merchantId: requireText(value.merchantId),
    storefrontId: requireText(value.storefrontId),
    buyerSessionDigest: requireDigest(value.buyerSessionDigest),
    idempotencyKey: requireText(value.idempotencyKey),
    inputAddressDigest: requireDigest(value.inputAddressDigest),
    providerAccountReference: requireText(value.providerAccountReference),
    providerValidationReference: requireText(value.providerValidationReference),
    createdAt: requireTimestamp(value.createdAt),
    expiresAt: requireTimestamp(value.expiresAt),
  };
}

function attemptInputMatches(
  attempt: AddressValidationAttempt,
  input: Readonly<{
    merchantId: string;
    storefrontId: string;
    buyerSessionDigest: string;
    idempotencyKey: string;
  }>,
  inputAddressDigest: string,
): boolean {
  return (
    attempt.merchantId === input.merchantId &&
    attempt.storefrontId === input.storefrontId &&
    attempt.buyerSessionDigest === input.buyerSessionDigest &&
    attempt.idempotencyKey === input.idempotencyKey &&
    attempt.inputAddressDigest === inputAddressDigest
  );
}

function attemptScopeMatches(
  attempt: AddressValidationAttempt,
  input: Readonly<{
    merchantId: string;
    storefrontId: string;
    buyerSessionDigest: string;
  }>,
): boolean {
  return (
    attempt.merchantId === input.merchantId &&
    attempt.storefrontId === input.storefrontId &&
    attempt.buyerSessionDigest === input.buyerSessionDigest
  );
}

function attemptReplayMatches(
  existing: AddressValidationAttempt,
  next: AddressValidationAttempt,
): boolean {
  if (existing.state === "indeterminate")
    return attemptInputMatches(existing, next, next.inputAddressDigest);
  return JSON.stringify(existing) === JSON.stringify(next);
}

function addressValidationAttemptId(
  input: Readonly<{
    merchantId: string;
    storefrontId: string;
    buyerSessionDigest: string;
    idempotencyKey: string;
  }>,
): string {
  return `address_validation_${sha256(
    JSON.stringify([
      input.merchantId,
      input.storefrontId,
      input.buyerSessionDigest,
      input.idempotencyKey,
    ]),
  )}`;
}

function addressDigest(address: CommerceBuyerShippingAddressV1): string {
  return sha256(JSON.stringify(address));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestampAfterSeconds(value: string, seconds: number): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error("Address validation clock is invalid");
  return new Date(milliseconds + seconds * 1_000).toISOString();
}

function requireText(value: unknown): string {
  if (!isNormalizedText(value)) {
    throw new Error("Stored address validation text is invalid");
  }
  return value;
}

function requireDigest(value: unknown): string {
  const digest = requireText(value);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("Stored address validation digest is invalid");
  }
  return digest;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireText(value);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("Stored address validation timestamp is invalid");
  }
  return timestamp;
}
