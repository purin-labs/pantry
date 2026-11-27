// Buyer addresses outside Japan and Singapore (Plan 76 phase 5). A general
// international shipping route serves the countries of one zone: Australia,
// the United States or the European Union. Each country keeps the postal code
// form that its post office uses; Australia and the United States also need
// the state.
import {
  COMMERCE_POSTAL_CODES,
  parseInternationalShippingAddressOf,
} from "@purin-labs/commerce-contracts/records/api-international-addresses";
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

const COMMERCE_INTERNATIONAL_SHIPPING_COUNTRIES = [
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

/** Whether `value`, upper-cased, is a postal code of `countryCode`. */
export function isCommercePostalCode(
  countryCode: CommerceInternationalShippingCountry,
  value: string,
): boolean {
  return COMMERCE_POSTAL_CODES[countryCode].test(value.trim().toUpperCase());
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
  return Object.hasOwn(COMMERCE_POSTAL_CODES, value);
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
