// Buyer addresses outside Japan and Singapore (Plan 76 phase 5). A general
// international shipping route serves the countries of one zone: Australia,
// the United States or the European Union. Each country keeps the postal code
// form that its post office uses; Australia and the United States also need
// the state.
import { parseInternationalShippingAddressOf } from "@seams/commerce-contracts/records/api-international-addresses";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

export const COMMERCE_EUROPEAN_UNION_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;

export const COMMERCE_INTERNATIONAL_SHIPPING_COUNTRIES = [
  "AU",
  "US",
  ...COMMERCE_EUROPEAN_UNION_COUNTRIES,
] as const;

export type CommerceInternationalShippingCountry =
  (typeof COMMERCE_INTERNATIONAL_SHIPPING_COUNTRIES)[number];

/** Every country that a buyer may ship to. */
export type CommerceShippingCountry =
  "JP" | "SG" | CommerceInternationalShippingCountry;

export type CommerceInternationalShippingAddressV1 = Readonly<{
  countryCode: CommerceInternationalShippingCountry;
  recipientName: string;
  addressLine1: string;
  locality: string;
  /** The state in Australia and the United States; absent in the EU. */
  administrativeArea?: string;
  postalCode: string;
}>; // prettier-ignore

/** The postal code form of each country, after upper-casing. */
const POSTAL_CODES: Readonly<
  Record<CommerceInternationalShippingCountry, RegExp>
> = {
  AU: /^\d{4}$/u,
  US: /^\d{5}(?:-\d{4})?$/u,
  AT: /^\d{4}$/u,
  BE: /^\d{4}$/u,
  BG: /^\d{4}$/u,
  CY: /^\d{4}$/u,
  CZ: /^\d{3} ?\d{2}$/u,
  DE: /^\d{5}$/u,
  DK: /^\d{4}$/u,
  EE: /^\d{5}$/u,
  ES: /^\d{5}$/u,
  FI: /^\d{5}$/u,
  FR: /^\d{5}$/u,
  GR: /^\d{3} ?\d{2}$/u,
  HR: /^\d{5}$/u,
  HU: /^\d{4}$/u,
  IE: /^[A-Z]\d[\dW] ?[\dA-Z]{4}$/u,
  IT: /^\d{5}$/u,
  LT: /^(?:LT-)?\d{5}$/u,
  LU: /^(?:L-)?\d{4}$/u,
  LV: /^(?:LV-)?\d{4}$/u,
  MT: /^[A-Z]{3} ?\d{4}$/u,
  NL: /^\d{4} ?[A-Z]{2}$/u,
  PL: /^\d{2}-\d{3}$/u,
  PT: /^\d{4}-\d{3}$/u,
  RO: /^\d{6}$/u,
  SE: /^\d{3} ?\d{2}$/u,
  SI: /^\d{4}$/u,
  SK: /^\d{3} ?\d{2}$/u,
};

/** Whether `value`, upper-cased, is a postal code of `countryCode`. */
export function isCommercePostalCode(
  countryCode: CommerceInternationalShippingCountry,
  value: string,
): boolean {
  return POSTAL_CODES[countryCode].test(value.trim().toUpperCase());
}

/** Australia and the United States need the state in an address. */
export function commerceAddressNeedsState(
  countryCode: CommerceInternationalShippingCountry,
): boolean {
  return countryCode === "AU" || countryCode === "US";
}

export function isCommerceInternationalShippingCountry(
  value: string,
): value is CommerceInternationalShippingCountry {
  return Object.hasOwn(POSTAL_CODES, value);
}

export function parseInternationalShippingAddress(
  object: Record<string, unknown>,
  countryCode: CommerceInternationalShippingCountry,
): CommerceInternationalShippingAddressV1 {
  return decodeRecord(
    parseInternationalShippingAddressOf.bind(null, countryCode),
    object,
  );
}
