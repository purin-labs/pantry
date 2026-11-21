// Plan 78 step 2: the collection records that packages/commerce-client
// reads in src/collections.ts. Each schema follows its hand-written reader:
// exact keys, descriptions of at most 5,000 characters, and rules of one to
// twenty conditions.
import { Type, type Static } from "typebox";
import {
  NonNegativeInteger,
  OpenObject,
  PositiveInteger,
  SafeInteger,
} from "@purin-labs/contract-schema";
import {
  boundedTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import { Nullable, wireMoneySchema } from "./client-wire-fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const exactKeys = { unevaluatedProperties: false } as const;

export const collectionsMoneySchema = wireMoneySchema;
export type CollectionsMoney = Static<typeof collectionsMoneySchema>;

/** `requireDescription`: any text of at most 5,000 characters. */
const descriptionSchema = Type.Refine(
  Type.String(),
  isDescription,
  descriptionError,
);

function isDescription(value: string): boolean {
  return value.length <= 5_000;
}

function descriptionError(): string {
  return "description must be text of 5,000 characters or fewer";
}

export const collectionCommandBaseSchema = ReadonlyOpenObject({
  merchantId: text,
  idempotencyKey: text,
  requestedAt: utcTimestampSchema,
  collectionId: text,
});
export type CollectionCommandBase = Static<typeof collectionCommandBaseSchema>;

export const commerceCollectionSortOrderSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("title"),
  Type.Literal("price_ascending"),
  Type.Literal("price_descending"),
  Type.Literal("newest"),
]);
export type CommerceCollectionSortOrder = Static<
  typeof commerceCollectionSortOrderSchema
>;

export const commerceCollectionConditionV1Schema = Type.Union([
  ReadonlyStrictObject({
    field: Type.Union([
      Type.Literal("tag"),
      Type.Literal("product_type"),
      Type.Literal("vendor"),
    ]),
    equals: text,
  }),
  ReadonlyStrictObject({ field: Type.Literal("title"), contains: text }),
  ReadonlyStrictObject({
    field: Type.Literal("price"),
    below: NonNegativeInteger,
  }),
  ReadonlyStrictObject({
    field: Type.Literal("price"),
    atLeast: NonNegativeInteger,
  }),
]);
export type CommerceCollectionConditionV1 = Static<
  typeof commerceCollectionConditionV1Schema
>;

export const commerceCollectionRuleV1Schema = ReadonlyStrictObject({
  match: Type.Union([Type.Literal("all"), Type.Literal("any")]),
  conditions: ImmutableArray(commerceCollectionConditionV1Schema, {
    minItems: 1,
    maxItems: 20,
  }),
});
export type CommerceCollectionRuleV1 = Static<
  typeof commerceCollectionRuleV1Schema
>;

function hasUniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

function uniqueIdsError(): string {
  return "selection.productIds must be unique";
}

export const commerceCollectionSelectionV1Schema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("manual"),
    productIds: Type.Refine(ImmutableArray(text), hasUniqueIds, uniqueIdsError),
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("automated"),
    rule: commerceCollectionRuleV1Schema,
  }),
]);
export type CommerceCollectionSelectionV1 = Static<
  typeof commerceCollectionSelectionV1Schema
>;

const statusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("draft"),
]);

/** Only a manual collection can keep a manual order. */
function keepsManualOrder(value: unknown): boolean {
  const command = value as Readonly<{
    sortOrder: string;
    selection: Readonly<{ kind: string }>;
  }>;
  return command.sortOrder !== "manual" || command.selection.kind === "manual";
}

function manualOrderError(): string {
  return "only a manual collection can keep a manual order";
}

export const createCommerceCollectionV1Schema = Type.Refine(
  Type.Intersect(
    [
      collectionCommandBaseSchema,
      ReadonlyOpenObject({
        schemaVersion: Type.Literal("commerce.create-collection.v1"),
        handle: Type.String({
          pattern: "^(?=.{1,100}$)[a-z0-9]+(?:-[a-z0-9]+)*$",
        }),
        title: boundedTextSchema(200),
        description: descriptionSchema,
        salesChannelId: text,
        sortOrder: commerceCollectionSortOrderSchema,
        status: statusSchema,
        selection: commerceCollectionSelectionV1Schema,
      }),
    ],
    exactKeys,
  ),
  keepsManualOrder,
  manualOrderError,
);
export type CreateCommerceCollectionV1 = Static<
  typeof createCommerceCollectionV1Schema
>;

function namesAChange(changes: object): boolean {
  return Object.keys(changes).length > 0;
}

function noChangeError(): string {
  return "changes must name at least one field";
}

export const updateCommerceCollectionV1Schema = Type.Intersect(
  [
    collectionCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.update-collection.v1"),
      expectedRevision: PositiveInteger,
      changes: Type.Refine(
        ReadonlyStrictObject({
          title: Type.Optional(boundedTextSchema(200)),
          description: Type.Optional(descriptionSchema),
          sortOrder: Type.Optional(commerceCollectionSortOrderSchema),
          status: Type.Optional(statusSchema),
          selection: Type.Optional(commerceCollectionSelectionV1Schema),
        }),
        namesAChange,
        noChangeError,
      ),
    }),
  ],
  exactKeys,
);
export type UpdateCommerceCollectionV1 = Static<
  typeof updateCommerceCollectionV1Schema
>;

export const deleteCommerceCollectionV1Schema = Type.Intersect(
  [
    collectionCommandBaseSchema,
    ReadonlyOpenObject({
      schemaVersion: Type.Literal("commerce.delete-collection.v1"),
      expectedRevision: PositiveInteger,
    }),
  ],
  exactKeys,
);
export type DeleteCommerceCollectionV1 = Static<
  typeof deleteCommerceCollectionV1Schema
>;

export const commerceCollectionCommandV1Schema = Type.Union([
  createCommerceCollectionV1Schema,
  updateCommerceCollectionV1Schema,
  deleteCommerceCollectionV1Schema,
]);
export type CommerceCollectionCommandV1 = Static<
  typeof commerceCollectionCommandV1Schema
>;

export const commerceBuyerCollectionSummaryV1Schema = ReadonlyStrictObject({
  handle: text,
  title: text,
  description: descriptionSchema,
});
export type CommerceBuyerCollectionSummaryV1 = Static<
  typeof commerceBuyerCollectionSummaryV1Schema
>;

export const commerceBuyerCollectionProductV1Schema = ReadonlyStrictObject({
  productId: text,
  title: text,
  handle: Nullable(text),
  price: wireMoneySchema,
  available: Type.Boolean(),
  tags: ImmutableArray(text),
});
export type CommerceBuyerCollectionProductV1 = Static<
  typeof commerceBuyerCollectionProductV1Schema
>;

export const commerceBuyerCollectionPageV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.buyer-collection-page.v1"),
  collection: commerceBuyerCollectionSummaryV1Schema,
  products: ImmutableArray(commerceBuyerCollectionProductV1Schema),
  nextCursor: Nullable(text),
});
export type CommerceBuyerCollectionPageV1 = Static<
  typeof commerceBuyerCollectionPageV1Schema
>;

export const commerceBuyerCollectionsV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.buyer-collections.v1"),
  collections: ImmutableArray(commerceBuyerCollectionSummaryV1Schema),
});
export type CommerceBuyerCollectionsV1 = Static<
  typeof commerceBuyerCollectionsV1Schema
>;

/** A filter that the client writes; no reader checks it. */
export const commerceCollectionPageFilterV1Schema = OpenObject({
  after: Type.Optional(Type.Readonly(Type.String())),
  limit: Type.Optional(Type.Readonly(SafeInteger)),
  tag: Type.Optional(Type.Readonly(Type.String())),
  minimumPrice: Type.Optional(Type.Readonly(SafeInteger)),
  maximumPrice: Type.Optional(Type.Readonly(SafeInteger)),
  availableOnly: Type.Optional(
    Type.Readonly(Type.Union([Type.Literal(false), Type.Literal(true)])),
  ),
});
export type CommerceCollectionPageFilterV1 = Static<
  typeof commerceCollectionPageFilterV1Schema
>;

export const commerceCollectionV1Schema = ReadonlyStrictObject({
  id: text,
  revision: PositiveInteger,
  handle: text,
  title: text,
  description: descriptionSchema,
  salesChannelId: text,
  sortOrder: commerceCollectionSortOrderSchema,
  status: statusSchema,
  selection: commerceCollectionSelectionV1Schema,
  productIds: ImmutableArray(text),
  occurredAt: utcTimestampSchema,
});
export type CommerceCollectionV1 = Static<
  typeof commerceCollectionV1Schema
>;

type CollectionList = Readonly<{
  schemaVersion: "commerce.collections.v1";
  collections: readonly CommerceCollectionV1[];
}>;

/** `parseCollections`: the list of a merchant's collections. */
const collectionListSchema = Type.Unsafe<readonly CommerceCollectionV1[]>(
  Type.Codec(
    ReadonlyStrictObject({
      schemaVersion: Type.Literal("commerce.collections.v1"),
      collections: ImmutableArray(commerceCollectionV1Schema),
    }),
  )
    .Decode(collectionsOf)
    .Encode(collectionList),
);

function collectionsOf(
  list: CollectionList,
): readonly CommerceCollectionV1[] {
  return list.collections;
}

function collectionList(
  collections: readonly CommerceCollectionV1[],
): CollectionList {
  return { schemaVersion: "commerce.collections.v1", collections };
}

// Parsers of the client API types (Plan 78 step 2).
export const parseCreateCommerceCollectionV1 = wireRecordParser(
  createCommerceCollectionV1Schema,
);
export const parseDeleteCommerceCollectionV1 = wireRecordParser(
  deleteCommerceCollectionV1Schema,
);
export const parseCommerceBuyerCollectionPageV1 = wireRecordParser(
  commerceBuyerCollectionPageV1Schema,
);
export const parseCommerceBuyerCollectionsV1 = wireRecordParser(
  commerceBuyerCollectionsV1Schema,
);
export const parseCommerceCollectionV1 = wireRecordParser(
  commerceCollectionV1Schema,
);
export const parseUpdateCommerceCollectionV1 = wireRecordParser(
  updateCommerceCollectionV1Schema,
);
export const parseCommerceCollectionsV1 =
  wireRecordParser(collectionListSchema);
