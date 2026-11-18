// Plan 78 step 2: the buyer addresses outside Japan and Singapore that
// packages/commerce-client reads in src/international-addresses.ts.
// The schema of each country follows `parseInternationalShippingAddress`:
// exact keys, the postal code form of the country, the state in Australia and
// the United States, both in upper case, and the field order that an address
// digest hashes.
import { Type, type Static } from "typebox";
import { OpenObject, type ContractDecodeResult } from "../schema.ts";
import { normalizedTextSchema } from "./fields.ts";
import { wireRecordParser } from "./wire-objects.ts";

export const commerceInternationalShippingCountrySchema = Type.Union([
  Type.Literal("AU"),
  Type.Literal("US"),
  Type.Literal("AT"),
  Type.Literal("BE"),
  Type.Literal("BG"),
  Type.Literal("CY"),
  Type.Literal("CZ"),
  Type.Literal("DE"),
  Type.Literal("DK"),
  Type.Literal("EE"),
  Type.Literal("ES"),
  Type.Literal("FI"),
  Type.Literal("FR"),
  Type.Literal("GR"),
  Type.Literal("HR"),
  Type.Literal("HU"),
  Type.Literal("IE"),
  Type.Literal("IT"),
  Type.Literal("LT"),
  Type.Literal("LU"),
  Type.Literal("LV"),
  Type.Literal("MT"),
  Type.Literal("NL"),
  Type.Literal("PL"),
  Type.Literal("PT"),
  Type.Literal("RO"),
  Type.Literal("SE"),
  Type.Literal("SI"),
  Type.Literal("SK"),
]);
export type CommerceInternationalShippingCountry = Static<
  typeof commerceInternationalShippingCountrySchema
>;

export const commerceInternationalShippingAddressV1Schema = OpenObject({
  countryCode: Type.Readonly(commerceInternationalShippingCountrySchema),
  recipientName: Type.Readonly(Type.String()),
  addressLine1: Type.Readonly(Type.String()),
  locality: Type.Readonly(Type.String()),
  administrativeArea: Type.Optional(Type.Readonly(Type.String())),
  postalCode: Type.Readonly(Type.String()),
});
export type CommerceInternationalShippingAddressV1 = Static<
  typeof commerceInternationalShippingAddressV1Schema
>;

export const commerceShippingCountrySchema = Type.Union([
  Type.Literal("JP"),
  Type.Literal("SG"),
  commerceInternationalShippingCountrySchema,
]);
export type CommerceShippingCountry = Static<
  typeof commerceShippingCountrySchema
>;

const AUSTRALIAN_STATES: ReadonlySet<string> = new Set([
  "ACT",
  "NSW",
  "NT",
  "QLD",
  "SA",
  "TAS",
  "VIC",
  "WA",
]);

const UNITED_STATES_STATES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
]); // prettier-ignore

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

function upperCaseMatches(pattern: RegExp, value: string): boolean {
  return pattern.test(value.toUpperCase());
}

function isStateOf(states: ReadonlySet<string>, value: string): boolean {
  return states.has(value.toUpperCase());
}

function postalCodeError(): string {
  return "is not a postal code of the country";
}

function stateError(): string {
  return "is not a state of the country";
}

type AddressFields = Readonly<{
  countryCode: unknown;
  recipientName: string;
  addressLine1: string;
  locality: string;
  administrativeArea?: string;
  postalCode: string;
}>;

/** The address in the field order that an address digest hashes. */
function orderedAddress(
  countryCode: CommerceInternationalShippingCountry,
  fields: AddressFields,
): CommerceInternationalShippingAddressV1 {
  const base = {
    countryCode,
    recipientName: fields.recipientName,
    addressLine1: fields.addressLine1,
    locality: fields.locality,
  };
  const postalCode = fields.postalCode.toUpperCase();
  return fields.administrativeArea === undefined
    ? { ...base, postalCode }
    : {
        ...base,
        administrativeArea: fields.administrativeArea.toUpperCase(),
        postalCode,
      };
}

function addressFields(
  address: CommerceInternationalShippingAddressV1,
): AddressFields {
  return address;
}

/** The address schema of one country. The `countryCode` key is not read. */
function internationalAddressSchema(
  countryCode: CommerceInternationalShippingCountry,
) {
  const states =
    countryCode === "AU"
      ? AUSTRALIAN_STATES
      : countryCode === "US"
        ? UNITED_STATES_STATES
        : undefined;
  const fields = {
    countryCode: Type.Unknown(),
    recipientName: normalizedTextSchema,
    addressLine1: normalizedTextSchema,
    locality: normalizedTextSchema,
    postalCode: Type.Refine(
      normalizedTextSchema,
      upperCaseMatches.bind(null, POSTAL_CODES[countryCode]),
      postalCodeError,
    ),
  };
  const shape =
    states === undefined
      ? Type.Object(fields, { additionalProperties: false })
      : Type.Object(
          {
            ...fields,
            administrativeArea: Type.Refine(
              normalizedTextSchema,
              isStateOf.bind(null, states),
              stateError,
            ),
          },
          { additionalProperties: false },
        );
  return Type.Unsafe<CommerceInternationalShippingAddressV1>(
    Type.Codec(shape)
      .Decode(orderedAddress.bind(null, countryCode))
      .Encode(addressFields),
  );
}

const addressParsers = new Map<
  CommerceInternationalShippingCountry,
  (
    input: unknown,
  ) => ContractDecodeResult<CommerceInternationalShippingAddressV1>
>();

/** `parseInternationalShippingAddress` for an address of `countryCode`. */
export function parseInternationalShippingAddressOf(
  countryCode: CommerceInternationalShippingCountry,
  input: unknown,
): ContractDecodeResult<CommerceInternationalShippingAddressV1> {
  let parse = addressParsers.get(countryCode);
  if (parse === undefined) {
    parse = wireRecordParser(internationalAddressSchema(countryCode));
    addressParsers.set(countryCode, parse);
  }
  return parse(input);
}
