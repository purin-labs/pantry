// Gift cards and store credit (Plan 76 phase 8). Both are stored value: an
// account with a balance in one currency that pays part or all of a
// checkout. A gift card is found by its code, which the merchant's own
// system makes and gives to the buyer; Commerce keeps only a digest of it
// and its last four characters. Store credit belongs to one customer. A
// checkout holds what it will take, the placed order redeems the hold, and a
// refund of a stored-value payment returns the amount to its account.
import {
  isGiftCardCode,
  normalizeGiftCardCode as normalizeGiftCardCodeText,
  parseCommerceStoredValueAccountsV1,
} from "@purin-labs/commerce-contracts/records/api-stored-value";

import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import { requireString } from "./wire-readers.ts";
import {
  parseCreditCommerceStoreCreditV1 as parseCreditCommerceStoreCreditV1Record,
  parseDisableCommerceStoredValueAccountV1 as parseDisableCommerceStoredValueAccountV1Record,
  parseIssueCommerceGiftCardV1 as parseIssueCommerceGiftCardV1Record,
  parseCommerceGiftCardBalanceV1 as parseCommerceGiftCardBalanceV1Record,
  parseCommerceStoredValueLiabilityV1 as parseCommerceStoredValueLiabilityV1Record,
} from "@purin-labs/commerce-contracts/records/api-stored-value";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type CommerceStoredValueKindV1 = "gift_card" | "store_credit";

export type CommerceStoredValueAccountV1 = Readonly<{
  id: string;
  revision: number;
  kind: CommerceStoredValueKindV1;
  /** The last four characters of a gift card code; null for store credit. */
  lastCharacters: string | null;
  /** The customer that owns store credit; null for a gift card. */
  customerId: string | null;
  /** What the account can pay now: credits less redemptions and holds. */
  balance: Money;
  /** Everything credited to the account so far. */
  credited: Money;
  status: "active" | "disabled";
  expiresAt: CommerceEngineTimestamp | null;
  note: string | null;
  createdAt: CommerceEngineTimestamp;
  occurredAt: CommerceEngineTimestamp;
}>;

type StoredValueCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
}>;

/** Issues a gift card with a code that the caller made. */
export type IssueCommerceGiftCardV1 = StoredValueCommandBase &
  Readonly<{
    schemaVersion: "commerce.issue-gift-card.v1";
    accountId: string;
    /** The code the buyer enters; Commerce keeps only its digest. */
    code: string;
    amount: Money;
    expiresAt: CommerceEngineTimestamp | null;
    note: string | null;
  }>;

/** Adds store credit to a customer's account in the amount's currency. */
export type CreditCommerceStoreCreditV1 = StoredValueCommandBase &
  Readonly<{
    schemaVersion: "commerce.credit-store-credit.v1";
    customerId: string;
    amount: Money;
    note: string | null;
  }>;

/** A disabled account pays nothing; refunds still return to it. */
export type DisableCommerceStoredValueAccountV1 = StoredValueCommandBase &
  Readonly<{
    schemaVersion: "commerce.disable-stored-value-account.v1";
    accountId: string;
    expectedRevision: number;
  }>;

export type CommerceStoredValueCommandV1 =
  | IssueCommerceGiftCardV1
  | CreditCommerceStoreCreditV1
  | DisableCommerceStoredValueAccountV1;

/** What a buyer sees of a gift card from its code. */
export type CommerceGiftCardBalanceV1 = Readonly<{
  schemaVersion: "commerce.gift-card-balance.v1";
  lastCharacters: string;
  balance: Money;
  status: "active" | "disabled" | "expired";
  expiresAt: CommerceEngineTimestamp | null;
}>;

/**
 * Unused stored value at one moment, by currency. Japan's Payment Services
 * Act asks an issuer of prepaid instruments for the unused balance at each
 * 31 March and 30 September.
 */
export type CommerceStoredValueLiabilityV1 = Readonly<{
  schemaVersion: "commerce.stored-value-liability.v1";
  at: CommerceEngineTimestamp;
  currencies: readonly Readonly<{
    currency: string;
    giftCards: Money;
    storeCredit: Money;
    accounts: number;
  }>[];
}>;

// Crockford's base 32: no I, L, O or U, so a code reads back without doubt.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A new gift card code: 16 random characters (80 bits) in four groups. The
 * merchant's system makes the code and gives it to the buyer.
 */
export function generateGiftCardCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const characters = [...bytes].map(
    (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
  );
  return [0, 4, 8, 12]
    .map((start) => characters.slice(start, start + 4).join(""))
    .join("-");
}

/** A code as Commerce compares it (`normalizeGiftCardCode` of the records). */
export function normalizeGiftCardCode(value: unknown, field: string): string {
  const code = requireString(value, field);
  if (!isGiftCardCode(code))
    throw new Error(`${field} must be 8 to 32 letters or digits`);
  return normalizeGiftCardCodeText(code);
}

export function parseIssueGiftCardCommand(
  value: unknown,
): IssueCommerceGiftCardV1 {
  return decodeRecord(parseIssueCommerceGiftCardV1Record, value);
}

export function parseCreditStoreCreditCommand(
  value: unknown,
): CreditCommerceStoreCreditV1 {
  return decodeRecord(parseCreditCommerceStoreCreditV1Record, value);
}

export function parseDisableStoredValueAccountCommand(
  value: unknown,
): DisableCommerceStoredValueAccountV1 {
  return decodeRecord(parseDisableCommerceStoredValueAccountV1Record, value);
}

export function parseStoredValueAccounts(
  value: unknown,
): readonly CommerceStoredValueAccountV1[] {
  return decodeRecord(parseCommerceStoredValueAccountsV1, value);
}

export function parseGiftCardBalance(
  value: unknown,
): CommerceGiftCardBalanceV1 {
  return decodeRecord(parseCommerceGiftCardBalanceV1Record, value);
}

export function parseStoredValueLiability(
  value: unknown,
): CommerceStoredValueLiabilityV1 {
  return decodeRecord(parseCommerceStoredValueLiabilityV1Record, value);
}
