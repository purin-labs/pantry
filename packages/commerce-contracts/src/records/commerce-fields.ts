// Field rules of the commerce records that the client reads in
// packages/commerce-client/src/commerce-resources.ts (Plan 78
// step 2). Each rule is the rule of one hand-written reader; the record
// schemas apply it where that reader runs.
import { Type, type TSchema } from "typebox";
import { NonNegativeInteger, OpenObject } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  currencyCodeTextSchema,
  normalizedTextSchema,
} from "./fields.ts";

/**
 * An identity of the checkout profile and payment binding readers
 * (`readIdentity` and `readText`): normalized, at most 255 code units.
 */
export const identityTextSchema = boundedTextSchema(255);

/** Money with a non-negative amount (`parseMoney`); other fields are dropped. */
export const nonNegativeMoneySchema = OpenObject({
  amountMinor: NonNegativeInteger,
  currency: currencyCodeTextSchema,
});

/**
 * A quantity (`parseQuantity`): a non-negative amount and a scale of at most
 * six places, none for `each`. Other fields are dropped.
 */
export function quantityRecordSchema<Unit extends TSchema>(unit: Unit) {
  return Type.Refine(
    OpenObject({
      amount: NonNegativeInteger,
      scale: Type.Integer({ minimum: 0, maximum: 6 }),
      unit,
    }),
    eachHasNoScale,
    eachScaleError,
  );
}

/** Whether every value of a list is distinct. */
export function hasUniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

export function uniqueValuesError(): string {
  return "must not repeat a value";
}

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

/**
 * Converts a shop amount into a market amount: the rate, then half-up
 * rounding to a multiple of the increment, in integer arithmetic. Both
 * currencies must be known and the rate a positive decimal.
 */
export function convertMarketAmount(
  shopMinor: number,
  shopCurrency: string,
  marketCurrency: string,
  rate: string,
  roundingIncrement: number,
): number {
  const shopDigits = CURRENCY_MINOR_UNITS[shopCurrency];
  const marketDigits = CURRENCY_MINOR_UNITS[marketCurrency];
  if (shopDigits === undefined || marketDigits === undefined)
    throw new Error("The currency is not supported");
  const [whole = "0", fraction = ""] = rate.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  const scale = 10n ** BigInt(fraction.length);
  const increment = BigInt(roundingIncrement);
  const top = BigInt(shopMinor) * numerator * 10n ** BigInt(marketDigits);
  const bottom = scale * 10n ** BigInt(shopDigits) * increment;
  const result = ((top * 2n + bottom) / (bottom * 2n)) * increment;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Converted price is too large");
  return Number(result);
}

/** A currency with known minor units (`requireCurrencyCode` in markets.ts). */
export const marketCurrencySchema = Type.Refine(
  normalizedTextSchema,
  isMarketCurrency,
  marketCurrencyError,
);

/** A positive decimal rate (`requireRate` in markets.ts). */
export const marketRateSchema = Type.Refine(
  Type.String({ pattern: "^\\d{1,9}(\\.\\d{1,12})?$" }),
  isNonZeroRate,
  marketRateError,
);

function eachHasNoScale(
  quantity: Readonly<{ scale: number; unit: unknown }>,
): boolean {
  return quantity.unit !== "each" || quantity.scale === 0;
}

function eachScaleError(): string {
  return "an each quantity has no scale";
}

function isMarketCurrency(value: string): boolean {
  return CURRENCY_MINOR_UNITS[value] !== undefined;
}

function marketCurrencyError(): string {
  return "must be a supported currency";
}

function isNonZeroRate(value: string): boolean {
  return !/^0+(\.0+)?$/.test(value);
}

function marketRateError(): string {
  return "must be a positive decimal";
}
