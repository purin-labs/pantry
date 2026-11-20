// Plan 78 step 2: the gift card and store credit records that
// packages/commerce-client reads in src/stored-value.ts. Each
// schema follows its hand-written reader; a gift card code is checked and
// then rewritten as `normalizeGiftCardCode` rewrites it.
import { Type, type Static, type TProperties } from "typebox";
import {
  NonNegativeInteger,
  PositiveInteger,
  contractRefusal,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  Nullable,
  positiveWireMoneySchema,
  wireMoneySchema,
} from "./client-wire-fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

export const storedValueMoneySchema = wireMoneySchema;
export type StoredValueMoney = Static<typeof storedValueMoneySchema>;

export const storedValueCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
});
export type StoredValueCommandBase = Static<
  typeof storedValueCommandBaseSchema
>;

/** A command: the base fields and its own, with no other key. */
function storedValueCommand<Properties extends TProperties>(
  properties: Properties,
) {
  return Type.Intersect(
    [storedValueCommandBaseSchema, ReadonlyOpenObject(properties)],
    { unevaluatedProperties: false },
  );
}

/** `normalizeGiftCardCode`: NFKC, upper case, no spaces or hyphens. */
export const giftCardCodeSchema = Type.Codec(
  Type.Refine(Type.String(), isGiftCardCode, giftCardCodeError),
)
  .Decode(normalizeGiftCardCode)
  .Encode(sameText);

function normalizeGiftCardCode(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[\s-]/gu, "");
}

function isGiftCardCode(value: string): boolean {
  return /^[0-9A-Z]{8,32}$/u.test(normalizeGiftCardCode(value));
}

function giftCardCodeError(): string {
  return "must be 8 to 32 letters or digits";
}

function sameText(value: string): string {
  return value;
}

const noteSchema = Nullable(boundedTextSchema(500));

export const issueCommerceGiftCardV1Schema = storedValueCommand({
  schemaVersion: Type.Literal("underclerk.issue-gift-card.v1"),
  accountId: text,
  code: giftCardCodeSchema,
  amount: positiveWireMoneySchema,
  expiresAt: Nullable(utcTimestampSchema),
  note: noteSchema,
});
export type IssueCommerceGiftCardV1 = Static<
  typeof issueCommerceGiftCardV1Schema
>;

export const creditCommerceStoreCreditV1Schema = storedValueCommand({
  schemaVersion: Type.Literal("underclerk.credit-store-credit.v1"),
  customerId: text,
  amount: positiveWireMoneySchema,
  note: noteSchema,
});
export type CreditCommerceStoreCreditV1 = Static<
  typeof creditCommerceStoreCreditV1Schema
>;

export const disableCommerceStoredValueAccountV1Schema = storedValueCommand({
  schemaVersion: Type.Literal("underclerk.disable-stored-value-account.v1"),
  accountId: text,
  expectedRevision: PositiveInteger,
});
export type DisableCommerceStoredValueAccountV1 = Static<
  typeof disableCommerceStoredValueAccountV1Schema
>;

export const commerceStoredValueCommandV1Schema = Type.Union([
  issueCommerceGiftCardV1Schema,
  creditCommerceStoreCreditV1Schema,
  disableCommerceStoredValueAccountV1Schema,
]);
export type CommerceStoredValueCommandV1 = Static<
  typeof commerceStoredValueCommandV1Schema
>;

export const commerceStoredValueKindV1Schema = Type.Union([
  Type.Literal("gift_card"),
  Type.Literal("store_credit"),
]);
export type CommerceStoredValueKindV1 = Static<
  typeof commerceStoredValueKindV1Schema
>;

export const commerceStoredValueAccountV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  kind: commerceStoredValueKindV1Schema,
  lastCharacters: Nullable(text),
  customerId: Nullable(text),
  balance: wireMoneySchema,
  credited: wireMoneySchema,
  status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
  expiresAt: Nullable(utcTimestampSchema),
  note: Nullable(text),
  createdAt: utcTimestampSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceStoredValueAccountV1 = Static<
  typeof commerceStoredValueAccountV1Schema
>;

export const commerceGiftCardBalanceV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.gift-card-balance.v1"),
  lastCharacters: text,
  balance: wireMoneySchema,
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("disabled"),
    Type.Literal("expired"),
  ]),
  expiresAt: Nullable(utcTimestampSchema),
});
export type CommerceGiftCardBalanceV1 = Static<
  typeof commerceGiftCardBalanceV1Schema
>;

export const commerceStoredValueLiabilityV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.stored-value-liability.v1"),
  at: utcTimestampSchema,
  currencies: ImmutableArray(
    ReadonlyStrictObject({
      currency: text,
      giftCards: wireMoneySchema,
      storeCredit: wireMoneySchema,
      accounts: NonNegativeInteger,
    }),
  ),
});
export type CommerceStoredValueLiabilityV1 = Static<
  typeof commerceStoredValueLiabilityV1Schema
>;

/**
 * The stored value of a checkout quote, without the quote total. A gift card
 * tender names its last characters; a store credit tender does not.
 */
export const wireCheckoutStoredValueSchema = Type.Object(
  {
    tenders: Type.Array(
      Type.Union([
        Type.Object(
          {
            accountId: text,
            kind: Type.Literal("gift_card"),
            lastCharacters: text,
            amount: positiveWireMoneySchema,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            accountId: text,
            kind: Type.Literal("store_credit"),
            amount: positiveWireMoneySchema,
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1 },
    ),
    amount: wireMoneySchema,
    due: wireMoneySchema,
  },
  { additionalProperties: false },
);

/** `parseStoredValueAccounts`: the accounts of the list. */
export const commerceStoredValueAccountsV1Schema = Type.Unsafe<
  readonly CommerceStoredValueAccountV1[]
>(
  Type.Codec(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("underclerk.stored-value-accounts.v1"),
      accounts: ImmutableArray(commerceStoredValueAccountV1Schema),
    }),
  )
    .Decode(accountsOfList)
    .Encode(listOfAccounts),
);

function accountsOfList(
  list: Readonly<{ accounts: readonly CommerceStoredValueAccountV1[] }>,
): readonly CommerceStoredValueAccountV1[] {
  return list.accounts;
}

function listOfAccounts(accounts: readonly CommerceStoredValueAccountV1[]) {
  return {
    schemaVersion: "underclerk.stored-value-accounts.v1" as const,
    accounts,
  };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCommerceStoredValueAccountsV1 = wireRecordParser(
  commerceStoredValueAccountsV1Schema,
);
export const parseCreditCommerceStoreCreditV1 = wireRecordParser(
  creditCommerceStoreCreditV1Schema,
);
export const parseDisableCommerceStoredValueAccountV1 = wireRecordParser(
  disableCommerceStoredValueAccountV1Schema,
);
export const parseIssueCommerceGiftCardV1 = wireRecordParser(
  issueCommerceGiftCardV1Schema,
);
export const parseCommerceGiftCardBalanceV1 = wireRecordParser(
  commerceGiftCardBalanceV1Schema,
);
export const parseCommerceStoredValueAccountV1 = wireRecordParser(
  commerceStoredValueAccountV1Schema,
);
export const parseCommerceStoredValueLiabilityV1 = wireRecordParser(
  commerceStoredValueLiabilityV1Schema,
);
const parseWireCheckoutStoredValue = wireRecordParser(
  wireCheckoutStoredValueSchema,
);
export type WireCheckoutStoredValue = Static<
  typeof wireCheckoutStoredValueSchema
>;

/**
 * `parseCheckoutStoredValue` for a quote `total`: distinct accounts, one
 * currency, an amount that sums the tenders and a due amount of the rest.
 */
export function parseCheckoutStoredValueOfTotal(
  total: StoredValueMoney,
  input: unknown,
): ContractDecodeResult<WireCheckoutStoredValue> {
  const parsed = parseWireCheckoutStoredValue(input);
  if (!parsed.ok) return parsed;
  const { tenders, amount, due } = parsed.value;
  let sum = 0;
  for (const tender of tenders) sum += tender.amount.amountMinor;
  const accounts = new Set(tenders.map(tenderAccount));
  if (
    accounts.size === tenders.length &&
    tenders.every(hasCurrency.bind(null, total.currency)) &&
    amount.currency === total.currency &&
    due.currency === total.currency &&
    amount.amountMinor === sum &&
    due.amountMinor === total.amountMinor - sum &&
    due.amountMinor >= 0
  )
    return parsed;
  return contractRefusal({
    code: "invalid_record",
    reason: "the stored value does not match the quote total",
    details: { field: "/" },
  });
}

function tenderAccount(tender: Readonly<{ accountId: string }>): string {
  return tender.accountId;
}

function hasCurrency(
  currency: string,
  tender: Readonly<{ amount: StoredValueMoney }>,
): boolean {
  return tender.amount.currency === currency;
}
