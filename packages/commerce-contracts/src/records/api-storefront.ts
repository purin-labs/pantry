// The Commerce storefront API records that packages/commerce-client
// reads in storefront-client.ts (Plan 78 step 2). Each schema follows its
// hand-written reader. Where the reader rewrites a value (an email domain in
// lower case, a postal code, a code in upper case, a field order that a digest
// hashes), a codec rewrites it the same way after the check.
import { Type, type Static } from "typebox";
import type { CheckoutProfileConfiguration } from "../commerce-domain.ts";
import { parseCheckoutProfileConfiguration } from "../checkout-profile.ts";
import { PositiveInteger } from "@purin-labs/contract-schema";
import { normalizedTextSchema, utcTimestampSchema } from "./fields.ts";
import {
  discountCodeSchema,
  wireCheckoutProfileReferenceSchema,
} from "./api-admin.ts";
import {
  Absent,
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";
import type { Variant } from "@purin-labs/type-utils";

const text = normalizedTextSchema;

export const createBuyerSessionCommandSchema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.create-buyer-session.v1"),
    buyer: ReadonlyStrictObject({
      kind: Type.Literal("guest"),
      customerAccessToken: Absent,
    }),
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.create-buyer-session.v1"),
    buyer: ReadonlyStrictObject({
      kind: Type.Literal("identified_customer"),
      customerAccessToken: text,
    }),
  }),
]);

/** `parseCheckoutProfileConfiguration` from the contracts package. */
const checkoutProfileConfigurationSchema =
  Type.Unsafe<CheckoutProfileConfiguration>(
    Type.Refine(
      Type.Unknown(),
      isCheckoutProfileConfiguration,
      invalidConfiguration,
    ),
  );

function isCheckoutProfileConfiguration(value: unknown): boolean {
  return parseCheckoutProfileConfiguration(value).ok;
}

function invalidConfiguration(): string {
  return "the checkout profile configuration is invalid";
}

export const buyerSessionSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.buyer-session.v4"),
  token: text,
  expiresAt: utcTimestampSchema,
  storefrontRevision: PositiveInteger,
  checkoutProfile: wireCheckoutProfileReferenceSchema,
  checkoutProfileConfiguration: checkoutProfileConfigurationSchema,
  buyer: Type.Union([
    ReadonlyStrictObject({ kind: Type.Literal("guest") }),
    ReadonlyStrictObject({ kind: Type.Literal("identified_customer") }),
  ]),
});

/** `parseBuyerPickupCheckoutLine`: modifier options are distinct. */
export const buyerPickupCheckoutLineSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("catalog"),
    variantId: text,
    quantity: PositiveInteger,
    menuId: Absent,
    menuEntryId: Absent,
    modifierOptionIds: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("menu"),
    menuId: text,
    menuEntryId: text,
    modifierOptionIds: ImmutableArray(text, { uniqueItems: true }),
    quantity: PositiveInteger,
    variantId: Absent,
  }),
]);

const buyerLines = ImmutableArray(buyerPickupCheckoutLineSchema, {
  minItems: 1,
});

export const createBuyerCartCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.create-buyer-cart.v1"),
  idempotencyKey: text,
  lines: buyerLines,
});

export const replaceBuyerCartCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.replace-buyer-cart.v1"),
  idempotencyKey: text,
  cartRevision: PositiveInteger,
  lines: buyerLines,
});

export const refreshBuyerPickupCheckoutCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.refresh-buyer-pickup-checkout.v1"),
  idempotencyKey: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
  lines: buyerLines,
});

export const placeBuyerStoredValueCheckoutCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal(
    "underclerk.place-buyer-stored-value-checkout.v1",
  ),
  idempotencyKey: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
});

/** `normalizeEmailAddress`: the domain in lower case. */
const emailAddressSchema = Type.Codec(
  Type.Refine(text, isEmailAddress, emailAddressError),
)
  .Decode(normalizeEmailAddress)
  .Encode(sameText);

function isEmailAddress(value: string): boolean {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) return false;
  return (
    /^[^\s@]+$/u.test(value.slice(0, separator)) &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(
      value.slice(separator + 1).toLowerCase(),
    )
  );
}

function normalizeEmailAddress(value: string): string {
  const separator = value.lastIndexOf("@");
  return `${value.slice(0, separator)}@${value.slice(separator + 1).toLowerCase()}`;
}

function emailAddressError(): string {
  return "must be an email address";
}

function sameText(value: string): string {
  return value;
}

/** `requireE164Phone`. */
const e164PhoneSchema = Type.String({
  ...text,
  pattern: "^\\+[1-9]\\d{7,14}$",
});

export const buyerContactSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("email"),
    email: emailAddressSchema,
    phone: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("email_and_phone"),
    email: emailAddressSchema,
    phone: e164PhoneSchema,
  }),
]);

export const buyerCheckoutIdentitySchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("guest"),
    contact: buyerContactSchema,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("identified_customer"),
    contact: Absent,
  }),
]);

/** `normalizeGiftCardCode`: NFKC, upper case, no spaces or hyphens. */
const giftCardCodeSchema = Type.Codec(
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
  return "a gift card code must be 8 to 32 letters or digits";
}

/** Five different gift card codes or fewer, compared after normalization. */
const giftCardCodesSchema = Type.Refine(
  ImmutableArray(giftCardCodeSchema, { maxItems: 5 }),
  hasDistinctGiftCardCodes,
  giftCardCodesError,
);

function hasDistinctGiftCardCodes(codes: readonly string[]): boolean {
  return new Set(codes.map(normalizeGiftCardCode)).size === codes.length;
}

function giftCardCodesError(): string {
  return "giftCardCodes must name five different codes or fewer";
}

const checkoutCodes = {
  discountCodes: Type.Optional(
    ImmutableArray(discountCodeSchema, { maxItems: 5 }),
  ),
  giftCardCodes: Type.Optional(giftCardCodesSchema),
  storeCredit: Type.Optional(Type.Boolean()),
};

/** As `parseCheckoutCodes`, a command keeps `storeCredit` only when true. */
function withoutStoreCreditFalse<
  Command extends { readonly storeCredit?: boolean },
>(command: Command): Command {
  if (command.storeCredit !== false) return command;
  const { storeCredit: _absent, ...rest } = command;
  return rest as Command;
}

export const createBuyerPickupCheckoutCommandSchema = Type.Codec(
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("underclerk.create-buyer-pickup-checkout.v1"),
    idempotencyKey: text,
    cartId: text,
    cartRevision: PositiveInteger,
    buyer: buyerCheckoutIdentitySchema,
    ...checkoutCodes,
    marketId: Type.Optional(text),
    pickupAt: Type.Optional(utcTimestampSchema),
  }),
)
  .Decode((command) => withoutStoreCreditFalse(command))
  .Encode((command) => command);

// Shipping addresses. The readers write each address in one field order; an
// address digest hashes its JSON text.

const EUROPEAN_UNION_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
] as const; // prettier-ignore

export type WireInternationalShippingCountry =
  "AU" | "US" | (typeof EUROPEAN_UNION_COUNTRIES)[number];

/** `CommerceInternationalShippingAddressV1`. */
export type WireInternationalShippingAddress = Readonly<{
  countryCode: WireInternationalShippingCountry;
  recipientName: string;
  addressLine1: string;
  locality: string;
  administrativeArea?: string;
  postalCode: string;
}>;

const AUSTRALIAN_STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];

const UNITED_STATES_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
]; // prettier-ignore

/** The postal code form of each country, after upper-casing. */
const POSTAL_CODES: Readonly<Record<WireInternationalShippingCountry, string>> =
  {
    AU: "^\\d{4}$",
    US: "^\\d{5}(?:-\\d{4})?$",
    AT: "^\\d{4}$",
    BE: "^\\d{4}$",
    BG: "^\\d{4}$",
    CY: "^\\d{4}$",
    CZ: "^\\d{3} ?\\d{2}$",
    DE: "^\\d{5}$",
    DK: "^\\d{4}$",
    EE: "^\\d{5}$",
    ES: "^\\d{5}$",
    FI: "^\\d{5}$",
    FR: "^\\d{5}$",
    GR: "^\\d{3} ?\\d{2}$",
    HR: "^\\d{5}$",
    HU: "^\\d{4}$",
    IE: "^[A-Z]\\d[\\dW] ?[\\dA-Z]{4}$",
    IT: "^\\d{5}$",
    LT: "^(?:LT-)?\\d{5}$",
    LU: "^(?:L-)?\\d{4}$",
    LV: "^(?:LV-)?\\d{4}$",
    MT: "^[A-Z]{3} ?\\d{4}$",
    NL: "^\\d{4} ?[A-Z]{2}$",
    PL: "^\\d{2}-\\d{3}$",
    PT: "^\\d{4}-\\d{3}$",
    RO: "^\\d{6}$",
    SE: "^\\d{3} ?\\d{2}$",
    SI: "^\\d{4}$",
    SK: "^\\d{3} ?\\d{2}$",
  };

/** A postal code that matches `pattern` once it is in upper case. */
function postalCodeSchema(pattern: string) {
  const form = new RegExp(pattern, "u");
  return Type.Codec(
    Type.Refine(
      text,
      (value: string) => form.test(value.toUpperCase()),
      postalCodeError,
    ),
  )
    .Decode(upperCase)
    .Encode(sameText);
}

/** A state code from `states` once it is in upper case. */
function stateSchema(states: readonly string[]) {
  return Type.Codec(
    Type.Refine(
      text,
      (value: string) => states.includes(value.toUpperCase()),
      stateError,
    ),
  )
    .Decode(upperCase)
    .Encode(sameText);
}

function upperCase(value: string): string {
  return value.toUpperCase();
}

function postalCodeError(): string {
  return "is not a postal code of the country";
}

function stateError(): string {
  return "is not a state of the country";
}

function internationalAddress(countryCode: WireInternationalShippingCountry) {
  const states =
    countryCode === "AU"
      ? AUSTRALIAN_STATES
      : countryCode === "US"
        ? UNITED_STATES_STATES
        : undefined;
  return ReadonlyStrictObject({
    countryCode: Type.Literal(countryCode),
    recipientName: text,
    addressLine1: text,
    locality: text,
    ...(states === undefined
      ? {}
      : { administrativeArea: stateSchema(states) }),
    postalCode: postalCodeSchema(POSTAL_CODES[countryCode]),
  });
}

/** `parseJapanShippingAddress`: the postal code written as `123-4567`. */
const japanPostalCodeSchema = Type.Codec(
  Type.Refine(text, isJapanPostalCode, japanPostalCodeError),
)
  .Decode(formatJapanPostalCode)
  .Encode(sameText);

function isJapanPostalCode(value: string): boolean {
  return /^\d{7}$/u.test(value.replace("-", ""));
}

function formatJapanPostalCode(value: string): string {
  const digits = value.replace("-", "");
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function japanPostalCodeError(): string {
  return "must contain seven Japanese postal digits";
}

/** `CommerceBuyerShippingAddressV1`. */
export type WireBuyerShippingAddress =
  | Readonly<{
      countryCode: "JP";
      recipientName: string;
      addressLine1: string;
      locality: string;
      administrativeArea: string;
      postalCode: string;
    }>
  | Readonly<{
      countryCode: "SG";
      recipientName: string;
      addressLine1: string;
      locality: "Singapore";
      postalCode: string;
      administrativeArea?: never;
    }>
  | WireInternationalShippingAddress;

const INTERNATIONAL_COUNTRIES: readonly WireInternationalShippingCountry[] = [
  "AU",
  "US",
  ...EUROPEAN_UNION_COUNTRIES,
];

export const buyerShippingAddressSchema = Type.Unsafe<WireBuyerShippingAddress>(
  Type.Codec(
    Type.Union([
      ReadonlyStrictObject({
        countryCode: Type.Literal("JP"),
        recipientName: text,
        addressLine1: text,
        locality: text,
        administrativeArea: text,
        postalCode: japanPostalCodeSchema,
      }),
      ReadonlyStrictObject({
        countryCode: Type.Literal("SG"),
        recipientName: text,
        addressLine1: text,
        locality: Type.Literal("Singapore"),
        postalCode: Type.String({ ...text, pattern: "^\\d{6}$" }),
        administrativeArea: Absent,
      }),
      ...INTERNATIONAL_COUNTRIES.map(internationalAddress),
    ]),
  )
    .Decode(orderedAddress)
    // Encoding is never used; the schema only decodes what a buyer sends.
    .Encode((address) => address as never),
);

function orderedAddress(
  address: WireBuyerShippingAddress,
): WireBuyerShippingAddress {
  const ordered = {
    countryCode: address.countryCode,
    recipientName: address.recipientName,
    addressLine1: address.addressLine1,
    locality: address.locality,
    ...(address.administrativeArea === undefined
      ? {}
      : { administrativeArea: address.administrativeArea }),
    postalCode: address.postalCode,
  };
  return ordered as WireBuyerShippingAddress;
}

export const buyerShippingAddressAcceptanceSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("accepted_as_entered"),
    addressValidationReference: text,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("accepted_correction"),
    addressValidationReference: text,
  }),
]);

export const buyerShippingDestinationSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("provided_address"),
    address: buyerShippingAddressSchema,
    acceptance: buyerShippingAddressAcceptanceSchema,
    savedAddressReference: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("saved_address"),
    savedAddressReference: text,
    address: Absent,
    acceptance: Absent,
  }),
]);

type BuyerCheckoutIdentity = Static<typeof buyerCheckoutIdentitySchema>;
type BuyerShippingDestination = Static<typeof buyerShippingDestinationSchema>;

/** `CreateCommerceBuyerShippingCheckoutV1`. */
export type WireCreateBuyerShippingCheckout = Readonly<{
  schemaVersion: "underclerk.create-buyer-shipping-checkout.v1";
  idempotencyKey: string;
  cartId: string;
  cartRevision: number;
  shippingServiceCode: string;
  discountCodes?: readonly string[];
  giftCardCodes?: readonly string[];
  storeCredit?: boolean;
  /** The buyer's market, which must have a converted rate. */
  marketId?: string;
}> &
  (
    | Readonly<{
        buyer: Variant<BuyerCheckoutIdentity, "guest">;
        shippingDestination: Variant<
          BuyerShippingDestination,
          "provided_address"
        >;
      }>
    | Readonly<{
        buyer: Variant<BuyerCheckoutIdentity, "identified_customer">;
        shippingDestination: BuyerShippingDestination;
      }>
  );

/** A guest gives an address; only a customer may use a saved one. */
export const createBuyerShippingCheckoutCommandSchema =
  Type.Unsafe<WireCreateBuyerShippingCheckout>(
    Type.Codec(
      Type.Refine(
        ReadonlyStrictObject({
          schemaVersion: Type.Literal(
            "underclerk.create-buyer-shipping-checkout.v1",
          ),
          idempotencyKey: text,
          cartId: text,
          cartRevision: PositiveInteger,
          buyer: buyerCheckoutIdentitySchema,
          shippingServiceCode: text,
          shippingDestination: buyerShippingDestinationSchema,
          ...checkoutCodes,
          marketId: Type.Optional(text),
        }),
        isGuestWithAddress,
        guestAddressError,
      ),
    )
      .Decode((command) => withoutStoreCreditFalse(command))
      .Encode((command) => command),
  );

function isGuestWithAddress(command: {
  readonly buyer: { readonly kind: string };
  readonly shippingDestination: { readonly kind: string };
}): boolean {
  return (
    command.buyer.kind !== "guest" ||
    command.shippingDestination.kind === "provided_address"
  );
}

function guestAddressError(): string {
  return "Guest checkout cannot use a saved address";
}

export const validateBuyerShippingAddressCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.validate-buyer-shipping-address.v1"),
  idempotencyKey: text,
  address: buyerShippingAddressSchema,
});

export const buyerShippingCheckoutLineSchema = ReadonlyStrictObject({
  variantId: text,
  quantity: PositiveInteger,
});

/** `parseBuyerShippingCheckoutLines`: one line for each variant. */
const shippingCheckoutLines = Type.Refine(
  ImmutableArray(buyerShippingCheckoutLineSchema, { minItems: 1 }),
  hasDistinctVariants,
  distinctVariantsError,
);

function hasDistinctVariants(
  lines: readonly { readonly variantId: string }[],
): boolean {
  return new Set(lines.map(variantIdOf)).size === lines.length;
}

function variantIdOf(line: { readonly variantId: string }): string {
  return line.variantId;
}

function distinctVariantsError(): string {
  return "lines must contain each variant once";
}

export const refreshBuyerShippingCheckoutCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.refresh-buyer-shipping-checkout.v1"),
  idempotencyKey: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
  lines: shippingCheckoutLines,
  shippingServiceCode: text,
  shippingDestination: buyerShippingDestinationSchema,
});

// The client types of the records above.
export type CreateCommerceBuyerSessionV1 = Static<
  typeof createBuyerSessionCommandSchema
>;
export type CommerceBuyerSessionV4 = Static<typeof buyerSessionSchema>;
export type CommerceBuyerPickupCheckoutLineV1 = Static<
  typeof buyerPickupCheckoutLineSchema
>;
export type CreateCommerceBuyerCartV1 = Static<
  typeof createBuyerCartCommandSchema
>;
export type ReplaceCommerceBuyerCartV1 = Static<
  typeof replaceBuyerCartCommandSchema
>;
export type RefreshCommerceBuyerPickupCheckoutV1 = Static<
  typeof refreshBuyerPickupCheckoutCommandSchema
>;
export type PlaceCommerceBuyerStoredValueCheckoutV1 = Static<
  typeof placeBuyerStoredValueCheckoutCommandSchema
>;
export type CommerceBuyerContactV1 = Static<typeof buyerContactSchema>;
export type CommerceBuyerCheckoutIdentityV1 = BuyerCheckoutIdentity;
export type CreateCommerceBuyerPickupCheckoutV1 = Static<
  typeof createBuyerPickupCheckoutCommandSchema
>;
export type CommerceBuyerShippingAddressV1 = WireBuyerShippingAddress;
export type CommerceBuyerShippingAddressAcceptanceV1 = Static<
  typeof buyerShippingAddressAcceptanceSchema
>;
export type CommerceBuyerShippingDestinationV1 = BuyerShippingDestination;
export type CreateCommerceBuyerShippingCheckoutV1 =
  WireCreateBuyerShippingCheckout;
export type ValidateCommerceBuyerShippingAddressV1 = Static<
  typeof validateBuyerShippingAddressCommandSchema
>;
export type CommerceBuyerShippingCheckoutLineV1 = Static<
  typeof buyerShippingCheckoutLineSchema
>;
export type RefreshCommerceBuyerShippingCheckoutV1 = Static<
  typeof refreshBuyerShippingCheckoutCommandSchema
>;

// Parsers of the records above.
export const parseCreateBuyerSessionCommandRecord = wireRecordParser(
  createBuyerSessionCommandSchema,
);
export const parseCommerceBuyerSessionV4Record =
  wireRecordParser(buyerSessionSchema);
export const parseCreateBuyerCartCommandRecord = wireRecordParser(
  createBuyerCartCommandSchema,
);
export const parseReplaceBuyerCartCommandRecord = wireRecordParser(
  replaceBuyerCartCommandSchema,
);
export const parseRefreshBuyerPickupCheckoutCommandRecord = wireRecordParser(
  refreshBuyerPickupCheckoutCommandSchema,
);
export const parsePlaceBuyerStoredValueCheckoutCommandRecord = wireRecordParser(
  placeBuyerStoredValueCheckoutCommandSchema,
);
export const parseCreateBuyerPickupCheckoutCommandRecord = wireRecordParser(
  createBuyerPickupCheckoutCommandSchema,
);
export const parseCreateBuyerShippingCheckoutCommandRecord = wireRecordParser(
  createBuyerShippingCheckoutCommandSchema,
);
export const parseValidateBuyerShippingAddressCommandRecord = wireRecordParser(
  validateBuyerShippingAddressCommandSchema,
);
export const parseRefreshBuyerShippingCheckoutCommandRecord = wireRecordParser(
  refreshBuyerShippingCheckoutCommandSchema,
);
