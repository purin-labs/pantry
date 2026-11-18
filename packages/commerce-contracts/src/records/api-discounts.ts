// Plan 78 step 2: the discount records that packages/commerce-client
// reads in src/discounts.ts. Each schema follows its hand-written reader:
// exact keys, and codes trimmed and in upper case, each code once.
import { Type, type Static } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "../schema.ts";
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
const exactKeys = { unevaluatedProperties: false } as const;

export const discountsMoneySchema = wireMoneySchema;
export type DiscountsMoney = Static<typeof discountsMoneySchema>;

/** `normalizeDiscountCode`: trimmed and in upper case. */
const discountCodeSchema = Type.Codec(
  Type.Refine(Type.String(), isDiscountCode, discountCodeError),
)
  .Decode(normalizeDiscountCode)
  .Encode(sameText);

function normalizeDiscountCode(value: string): string {
  return value.trim().toUpperCase();
}

function isDiscountCode(value: string): boolean {
  return /^[A-Z0-9_-]{3,40}$/.test(normalizeDiscountCode(value));
}

function discountCodeError(): string {
  return "must be 3 to 40 letters, digits, - or _";
}

function sameText(value: string): string {
  return value;
}

/** At least one code, each code once as Commerce compares them. */
const codesSchema = Type.Refine(
  ImmutableArray(discountCodeSchema, { minItems: 1 }),
  hasUniqueCodes,
  codesError,
);

function hasUniqueCodes(codes: readonly string[]): boolean {
  return new Set(codes.map(normalizeDiscountCode)).size === codes.length;
}

function codesError(): string {
  return "method.codes must name unique codes";
}

export const commerceDiscountMethodV1Schema = Type.Union([
  ReadonlyStrictObject({ kind: Type.Literal("code"), codes: codesSchema }),
  ReadonlyStrictObject({ kind: Type.Literal("automatic") }),
]);
export type CommerceDiscountMethodV1 = Static<
  typeof commerceDiscountMethodV1Schema
>;

export const commerceDiscountValueV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("percentage"),
    basisPoints: Type.Integer({ minimum: 1, maximum: 10_000 }),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("fixed_amount"),
    amount: positiveWireMoneySchema,
  }),
]);
export type CommerceDiscountValueV1 = Static<
  typeof commerceDiscountValueV1Schema
>;

export const commerceDiscountRuleV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("amount_off_order"),
    value: commerceDiscountValueV1Schema,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("amount_off_products"),
    value: commerceDiscountValueV1Schema,
    productIds: ImmutableArray(text, { minItems: 1 }),
  }),
]);
export type CommerceDiscountRuleV1 = Static<
  typeof commerceDiscountRuleV1Schema
>;

export const commerceDiscountConditionsV1Schema = ReadonlyStrictObject({
  minimumSubtotal: Nullable(wireMoneySchema),
  startsAt: utcTimestampSchema,
  endsAt: Nullable(utcTimestampSchema),
  usageLimit: Nullable(PositiveInteger),
  oncePerCustomer: Type.Boolean(),
});
export type CommerceDiscountConditionsV1 = Static<
  typeof commerceDiscountConditionsV1Schema
>;

export const discountCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  discountId: text,
});
export type DiscountCommandBase = Static<typeof discountCommandBaseSchema>;

export const createCommerceDiscountV1Schema = Type.Intersect(
  [
    discountCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.create-discount.v1"),
      title: boundedTextSchema(200),
      method: commerceDiscountMethodV1Schema,
      rule: commerceDiscountRuleV1Schema,
      conditions: commerceDiscountConditionsV1Schema,
    }),
  ],
  exactKeys,
);
export type CreateCommerceDiscountV1 = Static<
  typeof createCommerceDiscountV1Schema
>;

export const deactivateCommerceDiscountV1Schema = Type.Intersect(
  [
    discountCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("underclerk.deactivate-discount.v1"),
      expectedRevision: PositiveInteger,
    }),
  ],
  exactKeys,
);
export type DeactivateCommerceDiscountV1 = Static<
  typeof deactivateCommerceDiscountV1Schema
>;

export const commerceDiscountCommandV1Schema = Type.Union([
  createCommerceDiscountV1Schema,
  deactivateCommerceDiscountV1Schema,
]);
export type CommerceDiscountCommandV1 = Static<
  typeof commerceDiscountCommandV1Schema
>;

export const commerceDiscountV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  title: text,
  method: commerceDiscountMethodV1Schema,
  rule: commerceDiscountRuleV1Schema,
  conditions: commerceDiscountConditionsV1Schema,
  status: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
  redeemed: NonNegativeInteger,
  occurredAt: utcTimestampSchema,
});
export type CommerceDiscountV1 = Static<typeof commerceDiscountV1Schema>;

type DiscountList = Readonly<{
  schemaVersion: "underclerk.discounts.v1";
  discounts: readonly CommerceDiscountV1[];
}>;

/** `parseDiscounts`: the list of a merchant's discounts. */
const discountListSchema = Type.Unsafe<readonly CommerceDiscountV1[]>(
  Type.Codec(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("underclerk.discounts.v1"),
      discounts: ImmutableArray(commerceDiscountV1Schema),
    }),
  )
    .Decode(discountsOf)
    .Encode(discountList),
);

function discountsOf(list: DiscountList): readonly CommerceDiscountV1[] {
  return list.discounts;
}

function discountList(
  discounts: readonly CommerceDiscountV1[],
): DiscountList {
  return { schemaVersion: "underclerk.discounts.v1", discounts };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceDiscountV1 = wireRecordParser(
  createCommerceDiscountV1Schema,
);
export const parseDeactivateCommerceDiscountV1 = wireRecordParser(
  deactivateCommerceDiscountV1Schema,
);
export const parseCommerceDiscountV1 = wireRecordParser(
  commerceDiscountV1Schema,
);
export const parseCommerceDiscountsV1 = wireRecordParser(discountListSchema);
