// Plan 78 step 2: the market records that packages/commerce-client
// reads in src/markets.ts. Each schema follows its hand-written reader: exact
// keys, the currencies that Commerce sells in, unique countries and ids,
// and a positive decimal rate.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable } from "./client-wire-fields.ts";
import { marketCurrencySchema, marketRateSchema } from "./commerce-fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

function hasUniqueItems(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}

function uniqueItemsError(): string {
  return "must name unique items";
}

const countriesSchema = Type.Refine(
  ImmutableArray(Type.String({ pattern: "^[A-Z]{2}$" }), { minItems: 1 }),
  hasUniqueItems,
  uniqueItemsError,
);

const idsSchema = Type.Refine(
  ImmutableArray(text, { minItems: 1 }),
  hasUniqueItems,
  uniqueItemsError,
);

export const commerceMarketRateV1Schema = ReadonlyStrictObject({
  value: marketRateSchema,
  setAt: utcTimestampSchema,
  source: boundedTextSchema(100),
});
export type CommerceMarketRateV1 = Static<
  typeof commerceMarketRateV1Schema
>;

function hasUniqueVariants(
  prices: readonly Readonly<{ variantId: string }>[],
): boolean {
  return new Set(prices.map(variantIdOf)).size === prices.length;
}

function variantIdOf(price: Readonly<{ variantId: string }>): string {
  return price.variantId;
}

export const commerceMarketPricingV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("price_list"),
    prices: Type.Refine(
      ImmutableArray(
        ReadonlyStrictObject({ variantId: text, amountMinor: PositiveInteger }),
      ),
      hasUniqueVariants,
      uniqueItemsError,
    ),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("converted"),
    rate: commerceMarketRateV1Schema,
    roundingIncrement: PositiveInteger,
  }),
]);
export type CommerceMarketPricingV1 = Static<
  typeof commerceMarketPricingV1Schema
>;

export const marketCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  marketId: text,
});
export type MarketCommandBase = Static<typeof marketCommandBaseSchema>;

const statusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);

export const createCommerceMarketV1Schema = Type.Intersect(
  [
    marketCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.create-market.v1"),
      name: boundedTextSchema(100),
      countries: countriesSchema,
      currency: marketCurrencySchema,
      storefrontIds: idsSchema,
      pricing: commerceMarketPricingV1Schema,
    }),
  ],
  exactKeys,
);
export type CreateCommerceMarketV1 = Static<
  typeof createCommerceMarketV1Schema
>;

function namesAChange(changes: object): boolean {
  return Object.keys(changes).length > 0;
}

function noChangeError(): string {
  return "changes must name at least one field";
}

export const updateCommerceMarketV1Schema = Type.Intersect(
  [
    marketCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-market.v1"),
      expectedRevision: PositiveInteger,
      changes: Type.Refine(
        ReadonlyStrictObject({
          name: Type.Optional(boundedTextSchema(100)),
          countries: Type.Optional(countriesSchema),
          storefrontIds: Type.Optional(idsSchema),
          pricing: Type.Optional(commerceMarketPricingV1Schema),
          status: Type.Optional(statusSchema),
        }),
        namesAChange,
        noChangeError,
      ),
    }),
  ],
  exactKeys,
);
export type UpdateCommerceMarketV1 = Static<
  typeof updateCommerceMarketV1Schema
>;

export const commerceMarketCommandV1Schema = Type.Union([
  createCommerceMarketV1Schema,
  updateCommerceMarketV1Schema,
]);
export type CommerceMarketCommandV1 = Static<
  typeof commerceMarketCommandV1Schema
>;

export const commerceMarketV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  name: text,
  countries: countriesSchema,
  currency: marketCurrencySchema,
  storefrontIds: idsSchema,
  pricing: commerceMarketPricingV1Schema,
  status: statusSchema,
  occurredAt: utcTimestampSchema,
});
export type CommerceMarketV1 = Static<typeof commerceMarketV1Schema>;

export const commerceOrderMarketV1Schema = ReadonlyStrictObject({
  marketId: text,
  marketRevision: PositiveInteger,
  shopCurrency: marketCurrencySchema,
  rate: Nullable(marketRateSchema),
  shopSubtotal: ReadonlyStrictObject({
    amountMinor: NonNegativeInteger,
    currency: marketCurrencySchema,
  }),
  roundingIncrement: Type.Optional(PositiveInteger),
});
export type CommerceOrderMarketV1 = Static<
  typeof commerceOrderMarketV1Schema
>;

type MarketList = Readonly<{
  schemaVersion: "commerce.markets.v1";
  markets: readonly CommerceMarketV1[];
}>;

/** `parseMarkets`: the list of a merchant's markets. */
const marketListSchema = Type.Unsafe<readonly CommerceMarketV1[]>(
  Type.Codec(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("commerce.markets.v1"),
      markets: ImmutableArray(commerceMarketV1Schema),
    }),
  )
    .Decode(marketsOf)
    .Encode(marketList),
);

function marketsOf(list: MarketList): readonly CommerceMarketV1[] {
  return list.markets;
}

function marketList(markets: readonly CommerceMarketV1[]): MarketList {
  return { schemaVersion: "commerce.markets.v1", markets };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceMarketV1 = wireRecordParser(
  createCommerceMarketV1Schema,
);
export const parseCommerceMarketV1 = wireRecordParser(
  commerceMarketV1Schema,
);
export const parseUpdateCommerceMarketV1 = wireRecordParser(
  updateCommerceMarketV1Schema,
);
export const parseCommerceOrderMarketV1 = wireRecordParser(
  commerceOrderMarketV1Schema,
);
export const parseCommerceMarketsV1 = wireRecordParser(marketListSchema);
