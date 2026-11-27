// Plan 78 step 2: the catalog edit commands that
// packages/commerce-client reads in src/catalog-edits.ts. Each
// schema follows its hand-written reader: exact keys, and changes that name
// at least one field that the record lets staff change.
import { Type, type Static, type TSchema } from "typebox";
import { PositiveInteger } from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  currencyCodeTextSchema,
  httpsUrlSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable, wireMoneySchema } from "./client-wire-fields.ts";
import { storefrontTaxConfigurationSchema } from "./commerce-records.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

const catalogEditBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
});

/** `requireChanges`: the allowed fields only, and at least one of them. */
function changesOf<Properties extends Record<string, TSchema>>(
  properties: Properties,
) {
  return Type.Refine(
    ReadonlyStrictObject(properties),
    namesAChange,
    noChangeError,
  );
}

function namesAChange(changes: object): boolean {
  return Object.keys(changes).length > 0;
}

function noChangeError(): string {
  return "changes must name at least one field";
}

/** `requireBoundedOrEmpty`: empty, or text of at most 255 characters. */
const textOrEmpty = Type.Union([Type.Literal(""), boundedTextSchema(255)]);

/** `requireTags`: at most 250 different tags. */
const tagsSchema = Type.Refine(
  ImmutableArray(boundedTextSchema(255), { maxItems: 250 }),
  hasDistinctItems,
  tagsError,
);

function hasDistinctItems(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}

function tagsError(): string {
  return "changes.tags must be distinct";
}

/** `requireHandle`: lowercase words joined by hyphens. */
const handleSchema = Type.String({
  pattern: "^(?=.{1,255}$)[a-z0-9]+(?:-[a-z0-9]+)*$",
});

const commerceProductChangesV1Schema = changesOf({
  title: Type.Optional(boundedTextSchema(255)),
  description: Type.Optional(Type.String()),
  handle: Type.Optional(Nullable(handleSchema)),
  productType: Type.Optional(textOrEmpty),
  vendor: Type.Optional(textOrEmpty),
  tags: Type.Optional(tagsSchema),
  status: Type.Optional(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("active"),
      Type.Literal("archived"),
    ]),
  ),
});
export type CommerceProductChangesV1 = Static<
  typeof commerceProductChangesV1Schema
>;

const optionSchema = ReadonlyOpenObject({ name: text, value: text });

/** At most three options with different names. */
const optionsSchema = Type.Refine(
  ImmutableArray(optionSchema, { maxItems: 3 }),
  hasDistinctOptionNames,
  optionsError,
);

function hasDistinctOptionNames(
  options: readonly Readonly<{ name: string }>[],
): boolean {
  return new Set(options.map(nameOf)).size === options.length;
}

function nameOf(option: Readonly<{ name: string }>): string {
  return option.name;
}

function optionsError(): string {
  return "changes.options names must be distinct";
}

const mediaSchema = ReadonlyOpenObject({
  kind: Type.Union([
    Type.Literal("image"),
    Type.Literal("video"),
    Type.Literal("model3d"),
  ]),
  url: httpsUrlSchema,
  altText: Type.String(),
});

const commerceVariantChangesV1Schema = changesOf({
  title: Type.Optional(boundedTextSchema(255)),
  sku: Type.Optional(boundedTextSchema(255)),
  barcode: Type.Optional(Nullable(boundedTextSchema(64))),
  options: Type.Optional(optionsSchema),
  media: Type.Optional(ImmutableArray(mediaSchema)),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  ),
});
export type CommerceVariantChangesV1 = Static<
  typeof commerceVariantChangesV1Schema
>;

const commerceOfferChangesV1Schema = changesOf({
  price: Type.Optional(wireMoneySchema),
  compareAtPrice: Type.Optional(
    Nullable(
      ReadonlyOpenObject({
        amountMinor: PositiveInteger,
        currency: currencyCodeTextSchema,
      }),
    ),
  ),
  listing: Type.Optional(
    Type.Union([Type.Literal("listed"), Type.Literal("archived")]),
  ),
});
export type CommerceOfferChangesV1 = Static<
  typeof commerceOfferChangesV1Schema
>;

const updateCommerceProductV1Schema = Type.Intersect(
  [
    catalogEditBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-product.v1"),
      productId: text,
      expectedProductRevision: PositiveInteger,
      changes: commerceProductChangesV1Schema,
    }),
  ],
  exactKeys,
);
export type UpdateCommerceProductV1 = Static<
  typeof updateCommerceProductV1Schema
>;

/** Removes a product that was never sold, with its variants and offers. */
const deleteCommerceProductV1Schema = Type.Intersect(
  [
    catalogEditBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.delete-product.v1"),
      productId: text,
      expectedProductRevision: PositiveInteger,
    }),
  ],
  exactKeys,
);

const updateCommerceVariantV1Schema = Type.Intersect(
  [
    catalogEditBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-variant.v1"),
      variantId: text,
      expectedVariantRevision: PositiveInteger,
      changes: commerceVariantChangesV1Schema,
    }),
  ],
  exactKeys,
);
export type UpdateCommerceVariantV1 = Static<
  typeof updateCommerceVariantV1Schema
>;

const updateCommerceOfferV1Schema = Type.Intersect(
  [
    catalogEditBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-offer.v1"),
      offerId: text,
      expectedOfferRevision: PositiveInteger,
      changes: commerceOfferChangesV1Schema,
    }),
  ],
  exactKeys,
);
export type UpdateCommerceOfferV1 = Static<
  typeof updateCommerceOfferV1Schema
>;

/** Changes the tax rule of a storefront; the storefront gets a new revision. */
const updateCommerceStorefrontTaxV1Schema = Type.Intersect(
  [
    catalogEditBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-storefront-tax.v1"),
      storefrontId: text,
      expectedStorefrontRevision: PositiveInteger,
      tax: storefrontTaxConfigurationSchema,
    }),
  ],
  exactKeys,
);

// Parsers of the client API types (Plan 78 step 2).
export const parseUpdateCommerceStorefrontTaxV1 = wireRecordParser(
  updateCommerceStorefrontTaxV1Schema,
);
export const parseUpdateCommerceOfferV1 = wireRecordParser(
  updateCommerceOfferV1Schema,
);
export const parseUpdateCommerceProductV1 = wireRecordParser(
  updateCommerceProductV1Schema,
);
export const parseDeleteCommerceProductV1 = wireRecordParser(
  deleteCommerceProductV1Schema,
);
export const parseUpdateCommerceVariantV1 = wireRecordParser(
  updateCommerceVariantV1Schema,
);
