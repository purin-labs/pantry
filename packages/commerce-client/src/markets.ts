// Markets and currencies (Plan 76A step 4A). A market sells to some
// countries in one currency, from a fixed price list or from the shop price
// at a rate the merchant sets. Every amount stays in integer minor units; a
// conversion always uses a stored rate with its time and source.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import {
  requireText,
} from "./wire-readers.ts";
import { parseCreateCommerceMarketV1 as parseCreateCommerceMarketV1Record, parseCommerceMarketV1 as parseCommerceMarketV1Record, parseUpdateCommerceMarketV1 as parseUpdateCommerceMarketV1Record, parseCommerceMarketsV1 as parseCommerceMarketsV1Record, parseCommerceOrderMarketV1 as parseCommerceOrderMarketV1Record } from "@seams/commerce-contracts/records/api-markets";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import { convertMarketAmount } from "@seams/commerce-contracts/records/commerce-fields";

/** ISO 4217 minor units for the currencies Commerce sells in. */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  AUD: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  IDR: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  MYR: 2,
  NZD: 2,
  PHP: 2,
  SGD: 2,
  THB: 2,
  TWD: 2,
  USD: 2,
  VND: 0,
};

export function currencyMinorUnits(currency: string): number {
  const units = CURRENCY_MINOR_UNITS[currency];
  if (units === undefined) throw new Error(`${currency} is not a supported currency`);
  return units;
}

export type CommerceMarketRateV1 = Readonly<{
  /** Market currency for one unit of shop currency, as a decimal string. */
  value: string;
  setAt: CommerceEngineTimestamp;
  source: string;
}>;

export type CommerceMarketPricingV1 =
  | Readonly<{
      kind: "price_list";
      prices: readonly Readonly<{ variantId: string; amountMinor: number }>[];
    }>
  | Readonly<{
      kind: "converted";
      rate: CommerceMarketRateV1;
      /** Prices round half up to a multiple of this many minor units. */
      roundingIncrement: number;
    }>;

export type CommerceMarketV1 = Readonly<{
  id: string;
  revision: number;
  name: string;
  countries: readonly string[];
  currency: string;
  storefrontIds: readonly string[];
  pricing: CommerceMarketPricingV1;
  status: "active" | "inactive";
  occurredAt: CommerceEngineTimestamp;
}>;

type MarketCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  marketId: string;
}>;

export type CreateCommerceMarketV1 = MarketCommandBase &
  Readonly<{
    schemaVersion: "underclerk.create-market.v1";
    name: string;
    countries: readonly string[];
    currency: string;
    storefrontIds: readonly string[];
    pricing: CommerceMarketPricingV1;
  }>;

export type UpdateCommerceMarketV1 = MarketCommandBase &
  Readonly<{
    schemaVersion: "underclerk.update-market.v1";
    expectedRevision: number;
    changes: Readonly<{
      name?: string;
      countries?: readonly string[];
      storefrontIds?: readonly string[];
      pricing?: CommerceMarketPricingV1;
      status?: "active" | "inactive";
    }>;
  }>;

export type CommerceMarketCommandV1 =
  | CreateCommerceMarketV1
  | UpdateCommerceMarketV1;

/** What an order keeps of its market: the shop currency and the rate. */
export type CommerceOrderMarketV1 = Readonly<{
  marketId: string;
  marketRevision: number;
  shopCurrency: string;
  /** The rate the checkout used, or null for a price list. */
  rate: string | null;
  /** The same lines at shop prices, before discounts and tax. */
  shopSubtotal: Readonly<{ amountMinor: number; currency: string }>;
  /** The rounding of a converted rate; quotes from before it have none. */
  roundingIncrement?: number;
}>;

export function parseCreateMarketCommand(value: unknown): CreateCommerceMarketV1 {
  return decodeRecord(parseCreateCommerceMarketV1Record, value);
}

export function parseUpdateMarketCommand(value: unknown): UpdateCommerceMarketV1 {
  return decodeRecord(parseUpdateCommerceMarketV1Record, value);
}

export function parseMarket(value: unknown): CommerceMarketV1 {
  return decodeRecord(parseCommerceMarketV1Record, value);
}

export function parseMarkets(value: unknown): readonly CommerceMarketV1[] {
  return decodeRecord(parseCommerceMarketsV1Record, value);
}

export function parseOrderMarket(value: unknown, field: string): CommerceOrderMarketV1 {
  return decodeRecord(parseCommerceOrderMarketV1Record, value);
}

/**
 * Converts a shop price into a market price: the stored rate, then half-up
 * rounding to the market's increment. Integer arithmetic only.
 */
export function convertPrice(
  shopMinor: number,
  shopCurrency: string,
  marketCurrency: string,
  rate: string,
  roundingIncrement: number,
): number {
  currencyMinorUnits(shopCurrency);
  currencyMinorUnits(marketCurrency);
  return convertMarketAmount(
    shopMinor,
    shopCurrency,
    marketCurrency,
    requireRate(rate, "rate"),
    roundingIncrement,
  );
}

function requireRate(value: unknown, field: string): string {
  const rate = requireText(value, field);
  if (!/^\d{1,9}(\.\d{1,12})?$/.test(rate) || /^0+(\.0+)?$/.test(rate))
    throw new Error(`${field} must be a positive decimal`);
  return rate;
}
