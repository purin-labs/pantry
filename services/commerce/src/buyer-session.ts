import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { CheckoutProfileReference } from "@purin-labs/commerce-contracts";
import type {
  CommerceBuyerContactV1,
  CommerceProtectedBuyerContactV1,
} from "@purin-labs/commerce-client";

import { protectBuyerContact } from "./buyer-contact.ts";
import {
  assertNever,
  hasExactKeys,
  isNormalizedText,
  isRecord,
} from "@purin-labs/std";

type BuyerSessionIdentity =
  | Readonly<{
      kind: "guest";
      protectedCustomerReference?: never;
      protectedCustomerSessionReference?: never;
      contact?: never;
    }>
  | Readonly<{
      kind: "identified_customer";
      protectedCustomerReference: string;
      protectedCustomerSessionReference: string;
      contact: CommerceProtectedBuyerContactV1;
    }>;

export type BuyerSessionClaims = Readonly<{
  version: 4;
  audience: "commerce_storefront";
  sessionId: string;
  merchantId: string;
  storefrontId: string;
  storefrontRevision: number;
  checkoutProfile: CheckoutProfileReference;
  buyer: BuyerSessionIdentity;
  issuedAt: string;
  expiresAt: string;
}>;

type BuyerSessionVerification =
  Readonly<{ ok: true; claims: BuyerSessionClaims }> | Readonly<{ ok: false }>;

type BuyerOrderRecoveryClaims = Readonly<{
  version: 4;
  audience: "commerce_buyer_order";
  sessionId: string;
  merchantId: string;
  storefrontId: string;
  storefrontRevision: number;
  checkoutProfile: CheckoutProfileReference;
  checkoutId: string;
  orderId: string;
  issuedAt: string;
  expiresAt: string;
}>;

type BuyerOrderRecoveryVerification =
  | Readonly<{ ok: true; claims: BuyerOrderRecoveryClaims }>
  | Readonly<{ ok: false }>;

type BuyerSessionAuthorityOptions = Readonly<{
  secret: string;
  now: () => string;
  newSessionId?: () => string;
}>;

const TOKEN_PREFIX = "commerce_buyer_v3";
const ORDER_RECOVERY_TOKEN_PREFIX = "commerce_order_v3";
const DRAFT_INVOICE_TOKEN_PREFIX = "commerce_invoice_v1";
const CUSTOMER_ACCESS_TOKEN_PREFIX = "commerce_customer_v1";
const CUSTOMER_ACCESS_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

/** A signed-in customer, for one storefront, for thirty days. */
type CustomerAccessClaims = Readonly<{
  version: 2;
  audience: "commerce_customer";
  merchantId: string;
  storefrontId: string;
  customerId: string;
  accessId: string;
  issuedAt: string;
  expiresAt: string;
}>;

type DraftInvoiceClaims = Readonly<{
  version: 2;
  audience: "commerce_draft_invoice";
  merchantId: string;
  storefrontId: string;
  draftOrderId: string;
  draftRevision: number;
  issuedAt: string;
  expiresAt: string;
}>;
const SESSION_LIFETIME_MS = 30 * 60 * 1_000;
const ORDER_RECOVERY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

export class BuyerSessionAuthority {
  readonly #secret: string;
  readonly #now: () => string;
  readonly #newSessionId: () => string;

  constructor(options: BuyerSessionAuthorityOptions) {
    this.#secret = requireSecret(options.secret);
    this.#now = options.now;
    this.#newSessionId = options.newSessionId ?? randomUUID;
  }

  issue(
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      storefrontRevision: number;
      checkoutProfile: CheckoutProfileReference;
      buyer:
        | Readonly<{ kind: "guest" }>
        | Readonly<{
            kind: "identified_customer";
            protectedCustomerReference: string;
            protectedCustomerSessionReference: string;
            contact: CommerceBuyerContactV1;
          }>;
      /** A fixed session, so one invoice always reaches the same checkout. */
      sessionId?: string;
    }>,
  ): Readonly<{ token: string; claims: BuyerSessionClaims }> {
    const issuedAt = requireTimestamp(this.#now());
    const sessionId = requireText(input.sessionId ?? this.#newSessionId());
    const claims: BuyerSessionClaims = {
      version: 4,
      audience: "commerce_storefront",
      sessionId,
      merchantId: requireText(input.merchantId),
      storefrontId: requireText(input.storefrontId),
      storefrontRevision: requirePositiveInteger(input.storefrontRevision),
      checkoutProfile: requireCheckoutProfile(input.checkoutProfile),
      buyer: buyerSessionIdentity(input.merchantId, sessionId, input.buyer),
      issuedAt,
      expiresAt: new Date(
        Date.parse(issuedAt) + SESSION_LIFETIME_MS,
      ).toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(this.#secret, payload);
    return { token: `${TOKEN_PREFIX}.${payload}.${signature}`, claims };
  }

  verify(
    token: string,
    expected: Readonly<{
      merchantId: string;
      storefrontId: string;
      storefrontRevision: number;
    }>,
  ): BuyerSessionVerification {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== TOKEN_PREFIX ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      return { ok: false };
    }
    const expectedSignature = Buffer.from(
      sign(this.#secret, parts[1]),
      "base64url",
    );
    const actualSignature = Buffer.from(parts[2], "base64url");
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return { ok: false };
    }
    const claims = parseClaims(parts[1]);
    const now = Date.parse(this.#now());
    if (
      claims === undefined ||
      claims.merchantId !== expected.merchantId ||
      claims.storefrontId !== expected.storefrontId ||
      claims.storefrontRevision !== expected.storefrontRevision ||
      Date.parse(claims.issuedAt) > now ||
      Date.parse(claims.expiresAt) <= Date.parse(claims.issuedAt) ||
      Date.parse(claims.expiresAt) <= now
    ) {
      return { ok: false };
    }
    return { ok: true, claims };
  }

  /** The buyer's link to a draft order invoice, valid until the invoice ends. */
  issueDraftInvoice(
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      draftOrderId: string;
      draftRevision: number;
      expiresAt: string;
    }>,
  ): Readonly<{ token: string; claims: DraftInvoiceClaims }> {
    const claims: DraftInvoiceClaims = {
      version: 2,
      audience: "commerce_draft_invoice",
      merchantId: requireText(input.merchantId),
      storefrontId: requireText(input.storefrontId),
      draftOrderId: requireText(input.draftOrderId),
      draftRevision: requirePositiveInteger(input.draftRevision),
      issuedAt: requireTimestamp(this.#now()),
      expiresAt: requireTimestamp(input.expiresAt),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = signWithPrefix(
      this.#secret,
      DRAFT_INVOICE_TOKEN_PREFIX,
      payload,
    );
    return {
      token: `${DRAFT_INVOICE_TOKEN_PREFIX}.${payload}.${signature}`,
      claims,
    };
  }

  verifyDraftInvoice(
    token: string,
    expected: Readonly<{
      merchantId: string;
      storefrontId: string;
      draftOrderId: string;
    }>,
  ): Readonly<{ ok: true; claims: DraftInvoiceClaims }> | Readonly<{ ok: false }> {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== DRAFT_INVOICE_TOKEN_PREFIX ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      return { ok: false };
    }
    const expectedSignature = Buffer.from(
      signWithPrefix(this.#secret, DRAFT_INVOICE_TOKEN_PREFIX, parts[1]),
      "base64url",
    );
    const actualSignature = Buffer.from(parts[2], "base64url");
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return { ok: false };
    }
    const claims = parseDraftInvoiceClaims(parts[1]);
    const now = Date.parse(this.#now());
    if (
      claims === undefined ||
      claims.merchantId !== expected.merchantId ||
      claims.storefrontId !== expected.storefrontId ||
      claims.draftOrderId !== expected.draftOrderId ||
      Date.parse(claims.issuedAt) > now ||
      Date.parse(claims.expiresAt) <= now
    ) {
      return { ok: false };
    }
    return { ok: true, claims };
  }

  issueCustomerAccess(
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      customerId: string;
    }>,
  ): Readonly<{ token: string; claims: CustomerAccessClaims }> {
    const issuedAt = requireTimestamp(this.#now());
    const claims: CustomerAccessClaims = {
      version: 2,
      audience: "commerce_customer",
      merchantId: requireText(input.merchantId),
      storefrontId: requireText(input.storefrontId),
      customerId: requireText(input.customerId),
      accessId: requireText(this.#newSessionId()),
      issuedAt,
      expiresAt: new Date(
        Date.parse(issuedAt) + CUSTOMER_ACCESS_LIFETIME_MS,
      ).toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = signWithPrefix(
      this.#secret,
      CUSTOMER_ACCESS_TOKEN_PREFIX,
      payload,
    );
    return {
      token: `${CUSTOMER_ACCESS_TOKEN_PREFIX}.${payload}.${signature}`,
      claims,
    };
  }

  verifyCustomerAccess(
    token: string,
    expected: Readonly<{
      merchantId: string;
      storefrontId: string;
    }>,
  ):
    | Readonly<{ ok: true; claims: CustomerAccessClaims }>
    | Readonly<{ ok: false }> {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== CUSTOMER_ACCESS_TOKEN_PREFIX ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      return { ok: false };
    }
    const expectedSignature = Buffer.from(
      signWithPrefix(this.#secret, CUSTOMER_ACCESS_TOKEN_PREFIX, parts[1]),
      "base64url",
    );
    const actualSignature = Buffer.from(parts[2], "base64url");
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return { ok: false };
    }
    const claims = parseCustomerAccessClaims(parts[1]);
    const now = Date.parse(this.#now());
    if (
      claims === undefined ||
      claims.merchantId !== expected.merchantId ||
      claims.storefrontId !== expected.storefrontId ||
      Date.parse(claims.issuedAt) > now ||
      Date.parse(claims.expiresAt) <= now
    ) {
      return { ok: false };
    }
    return { ok: true, claims };
  }

  issueOrderRecovery(
    input: Readonly<{
      sessionId: string;
      merchantId: string;
      storefrontId: string;
      storefrontRevision: number;
      checkoutProfile: CheckoutProfileReference;
      checkoutId: string;
      orderId: string;
      issuedAt: string;
    }>,
  ): Readonly<{ token: string; claims: BuyerOrderRecoveryClaims }> {
    const issuedAt = requireTimestamp(input.issuedAt);
    const claims: BuyerOrderRecoveryClaims = {
      version: 4,
      audience: "commerce_buyer_order",
      sessionId: requireText(input.sessionId),
      merchantId: requireText(input.merchantId),
      storefrontId: requireText(input.storefrontId),
      storefrontRevision: requirePositiveInteger(input.storefrontRevision),
      checkoutProfile: requireCheckoutProfile(input.checkoutProfile),
      checkoutId: requireText(input.checkoutId),
      orderId: requireText(input.orderId),
      issuedAt,
      expiresAt: new Date(
        Date.parse(issuedAt) + ORDER_RECOVERY_LIFETIME_MS,
      ).toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = signWithPrefix(
      this.#secret,
      ORDER_RECOVERY_TOKEN_PREFIX,
      payload,
    );
    return {
      token: `${ORDER_RECOVERY_TOKEN_PREFIX}.${payload}.${signature}`,
      claims,
    };
  }

  verifyOrderRecovery(
    token: string,
    expected: Readonly<{
      merchantId: string;
      storefrontId: string;
      storefrontRevision: number;
      checkoutId: string;
    }>,
  ): BuyerOrderRecoveryVerification {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== ORDER_RECOVERY_TOKEN_PREFIX ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      return { ok: false };
    }
    const expectedSignature = Buffer.from(
      signWithPrefix(this.#secret, ORDER_RECOVERY_TOKEN_PREFIX, parts[1]),
      "base64url",
    );
    const actualSignature = Buffer.from(parts[2], "base64url");
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return { ok: false };
    }
    const claims = parseOrderRecoveryClaims(parts[1]);
    const now = Date.parse(this.#now());
    if (
      claims === undefined ||
      claims.merchantId !== expected.merchantId ||
      claims.storefrontId !== expected.storefrontId ||
      claims.storefrontRevision !== expected.storefrontRevision ||
      claims.checkoutId !== expected.checkoutId ||
      Date.parse(claims.issuedAt) > now ||
      Date.parse(claims.expiresAt) <= Date.parse(claims.issuedAt) ||
      Date.parse(claims.expiresAt) <= now
    ) {
      return { ok: false };
    }
    return { ok: true, claims };
  }
}

function parseDraftInvoiceClaims(
  payload: string,
): DraftInvoiceClaims | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !isRecord(value) ||
      value.version !== 2 ||
      value.audience !== "commerce_draft_invoice"
    ) {
      return undefined;
    }
    return {
      version: 2,
      audience: "commerce_draft_invoice",
      merchantId: requireText(value.merchantId),
      storefrontId: requireText(value.storefrontId),
      draftOrderId: requireText(value.draftOrderId),
      draftRevision: requirePositiveInteger(value.draftRevision),
      issuedAt: requireTimestamp(value.issuedAt),
      expiresAt: requireTimestamp(value.expiresAt),
    };
  } catch {
    return undefined;
  }
}

function parseCustomerAccessClaims(
  payload: string,
): CustomerAccessClaims | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !isRecord(value) ||
      value.version !== 2 ||
      value.audience !== "commerce_customer"
    ) {
      return undefined;
    }
    return {
      version: 2,
      audience: "commerce_customer",
      merchantId: requireText(value.merchantId),
      storefrontId: requireText(value.storefrontId),
      customerId: requireText(value.customerId),
      accessId: requireText(value.accessId),
      issuedAt: requireTimestamp(value.issuedAt),
      expiresAt: requireTimestamp(value.expiresAt),
    };
  } catch {
    return undefined;
  }
}

export function buyerSessionDigest(sessionId: string): string {
  return createHash("sha256").update(requireText(sessionId)).digest("hex");
}

function parseClaims(payload: string): BuyerSessionClaims | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !isRecord(value) ||
      value.version !== 4 ||
      value.audience !== "commerce_storefront"
    ) {
      return undefined;
    }
    return {
      version: 4,
      audience: "commerce_storefront",
      sessionId: requireText(value.sessionId),
      merchantId: requireText(value.merchantId),
      storefrontId: requireText(value.storefrontId),
      storefrontRevision: requirePositiveInteger(value.storefrontRevision),
      checkoutProfile: requireCheckoutProfile(value.checkoutProfile),
      buyer: parseBuyerSessionIdentity(value.buyer),
      issuedAt: requireTimestamp(value.issuedAt),
      expiresAt: requireTimestamp(value.expiresAt),
    };
  } catch {
    return undefined;
  }
}

function parseOrderRecoveryClaims(
  payload: string,
): BuyerOrderRecoveryClaims | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !isRecord(value) ||
      value.version !== 4 ||
      value.audience !== "commerce_buyer_order"
    ) {
      return undefined;
    }
    return {
      version: 4,
      audience: "commerce_buyer_order",
      sessionId: requireText(value.sessionId),
      merchantId: requireText(value.merchantId),
      storefrontId: requireText(value.storefrontId),
      storefrontRevision: requirePositiveInteger(value.storefrontRevision),
      checkoutProfile: requireCheckoutProfile(value.checkoutProfile),
      checkoutId: requireText(value.checkoutId),
      orderId: requireText(value.orderId),
      issuedAt: requireTimestamp(value.issuedAt),
      expiresAt: requireTimestamp(value.expiresAt),
    };
  } catch {
    return undefined;
  }
}

function buyerSessionIdentity(
  merchantId: string,
  sessionId: string,
  buyer:
    | Readonly<{ kind: "guest" }>
    | Readonly<{
        kind: "identified_customer";
        protectedCustomerReference: string;
        protectedCustomerSessionReference: string;
        contact: CommerceBuyerContactV1;
      }>,
): BuyerSessionIdentity {
  switch (buyer.kind) {
    case "guest":
      return { kind: "guest" };
    case "identified_customer":
      return {
        kind: "identified_customer",
        protectedCustomerReference: requireText(
          buyer.protectedCustomerReference,
        ),
        protectedCustomerSessionReference: requireText(
          buyer.protectedCustomerSessionReference,
        ),
        contact: protectBuyerContact({
          merchantId,
          sessionId,
          contact: buyer.contact,
        }),
      };
    default:
      return assertNever(buyer, "Unsupported buyer session identity");
  }
}

function parseBuyerSessionIdentity(value: unknown): BuyerSessionIdentity {
  if (!isRecord(value))
    throw new Error("Buyer session identity must be an object");
  switch (value.kind) {
    case "guest":
      requireExactKeys(value, ["kind"]);
      return { kind: "guest" };
    case "identified_customer":
      requireExactKeys(value, [
        "kind",
        "protectedCustomerReference",
        "protectedCustomerSessionReference",
        "contact",
      ]);
      return {
        kind: "identified_customer",
        protectedCustomerReference: requireText(
          value.protectedCustomerReference,
        ),
        protectedCustomerSessionReference: requireText(
          value.protectedCustomerSessionReference,
        ),
        contact: parseProtectedBuyerContact(value.contact),
      };
    default:
      throw new Error("Buyer session identity is unsupported");
  }
}

function parseProtectedBuyerContact(
  value: unknown,
): CommerceProtectedBuyerContactV1 {
  if (!isRecord(value))
    throw new Error("Protected buyer contact must be an object");
  switch (value.kind) {
    case "email":
      requireExactKeys(value, ["kind", "emailDigest"]);
      return { kind: "email", emailDigest: requireSha256(value.emailDigest) };
    case "email_and_phone":
      requireExactKeys(value, ["kind", "emailDigest", "phoneDigest"]);
      return {
        kind: "email_and_phone",
        emailDigest: requireSha256(value.emailDigest),
        phoneDigest: requireSha256(value.phoneDigest),
      };
    default:
      throw new Error("Protected buyer contact is unsupported");
  }
}

function sign(secret: string, payload: string): string {
  return signWithPrefix(secret, TOKEN_PREFIX, payload);
}

function signWithPrefix(
  secret: string,
  prefix: string,
  payload: string,
): string {
  return createHmac("sha256", secret)
    .update(`${prefix}.${payload}`)
    .digest("base64url");
}

function requireSecret(value: string): string {
  if (value.length < 32 || value !== value.trim()) {
    throw new Error(
      "Buyer session secret must contain at least 32 normalized characters",
    );
  }
  return value;
}

function requireText(value: unknown): string {
  if (!isNormalizedText(value)) {
    throw new Error("Buyer session text must be normalized");
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Buyer session revision must be a positive integer");
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireText(value);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error("Buyer session timestamp is invalid");
  return timestamp;
}

function requireCheckoutProfile(value: unknown): CheckoutProfileReference {
  if (!isRecord(value))
    throw new Error("Buyer session checkout profile must be an object");
  return {
    checkoutProfileId: requireText(value.checkoutProfileId),
    revision: requirePositiveInteger(value.revision),
  };
}

function requireSha256(value: unknown): string {
  const digest = requireText(value);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("Buyer session digest must be lowercase SHA-256");
  }
  return digest;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(value, keys))
    throw new Error("Buyer session object has unsupported fields");
}
