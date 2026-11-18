import { OpenObject, PositiveInteger } from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { type StrictUnion } from "@seams/type-utils";
import { commerceEntityRefSchema } from "./entity-reference.ts";
import {
  commerceFilterSchema,
  relationshipDefinitionRefSchema,
  type CommerceFilter,
} from "./query-filter.ts";
import { commercePaginationSchema } from "./query-pagination.ts";
import {
  commerceTraversalLimitsSchema,
  commerceFreshnessRequirementSchema,
} from "./query-limits.ts";
import { commerceSortSchema } from "./query-ordering.ts";
import {
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  attributeDefinitionIdSchema,
  queryIdentitySchema,
} from "./query-parts.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";

// Preserve recursive filter types beyond TypeBox's static recursion limit.
const filter = Type.Unsafe<CommerceFilter>(commerceFilterSchema);
const optionalFilter = Type.Union([filter, Type.Null()]);
const seeds = Type.Array(commerceEntityRefSchema, {
  minItems: 1,
  maxItems: 64,
});
const sorts = Type.Array(commerceSortSchema, { maxItems: 8 });
export const commerceAggregationSourceSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("entity_type"),
    entityTypeId: commerceEntityTypeIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("commerce_list"),
    listId: commerceListIdSchema,
  }),
]);
function attributeAggregation<Kind extends string>(kind: Kind) {
  return OpenObject({
    kind: Type.Literal(kind),
    attributeId: attributeDefinitionIdSchema,
  });
}
export const commerceAggregationSchema = Type.Union([
  OpenObject({ kind: Type.Literal("count") }),
  attributeAggregation("grouped_count"),
  attributeAggregation("sum"),
  attributeAggregation("minimum"),
  attributeAggregation("maximum"),
  attributeAggregation("oldest_due_date"),
  OpenObject({
    kind: Type.Literal("age_buckets"),
    attributeId: attributeDefinitionIdSchema,
    bucketDays: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), {
      minItems: 1,
      maxItems: 16,
    }),
  }),
]);
export const commerceSelectorQuerySchema = Type.Union([
  OpenObject({
    kind: Type.Literal("entity_by_ref"),
    reference: commerceEntityRefSchema,
    traversal: commerceTraversalLimitsSchema,
    filter: optionalFilter,
  }),
  OpenObject({
    kind: Type.Literal("entity_type_page"),
    entityTypeId: commerceEntityTypeIdSchema,
    filter,
    sorts,
    pagination: commercePaginationSchema,
    traversal: commerceTraversalLimitsSchema,
  }),
  OpenObject({
    kind: Type.Literal("relationship_traversal"),
    seeds,
    relationshipDefinition: Type.Union([
      relationshipDefinitionRefSchema,
      Type.Null(),
    ]),
    traversal: commerceTraversalLimitsSchema,
    filter: optionalFilter,
  }),
  OpenObject({
    kind: Type.Literal("commerce_list_page"),
    listId: commerceListIdSchema,
    filter,
    sorts,
    pagination: commercePaginationSchema,
  }),
  OpenObject({
    kind: Type.Literal("saved_commerce_view"),
    viewId: savedCommerceViewIdSchema,
    pagination: commercePaginationSchema,
  }),
  OpenObject({
    kind: Type.Literal("search"),
    text: Type.String({ ...trimmedIdentityTextSchema, maxLength: 256 }),
    entityTypeId: Type.Union([commerceEntityTypeIdSchema, Type.Null()]),
    pagination: commercePaginationSchema,
    traversal: commerceTraversalLimitsSchema,
  }),
  OpenObject({
    kind: Type.Literal("aggregation"),
    source: commerceAggregationSourceSchema,
    filter,
    aggregation: commerceAggregationSchema,
  }),
]);
export const selectorIdSchema =
  queryIdentitySchema<"PublishedCommerceSelectorId">();
export const selectorRevisionSchema = Type.Unsafe<
  number & { readonly __brand: "PublishedCommerceSelectorRevision" }
>(PositiveInteger);
export const publishedCommerceSelectorSchema = OpenObject({
  selectorId: selectorIdSchema,
  revision: selectorRevisionSchema,
  query: commerceSelectorQuerySchema,
});
export type PublishedCommerceSelector = StaticDecode<
  typeof publishedCommerceSelectorSchema
>;
export const entitySeedsContextSelectionSchema = OpenObject({
  kind: Type.Literal("entity_seeds"),
  seeds,
});
export const selectorContextSelectionSchema = OpenObject({
  kind: Type.Literal("selector"),
  selector: publishedCommerceSelectorSchema,
});
export const commerceContextSelectionSchema = Type.Union([
  entitySeedsContextSelectionSchema,
  selectorContextSelectionSchema,
]);
export const commerceGraphQuerySchema = Type.Union([
  ...commerceSelectorQuerySchema.anyOf,
  OpenObject({
    kind: Type.Literal("underclerk_context"),
    selection: commerceContextSelectionSchema,
    traversal: commerceTraversalLimitsSchema,
    allowedSensitivity: Type.Enum([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]),
    allowedAttributeIds: Type.Array(attributeDefinitionIdSchema, {
      maxItems: 256,
      uniqueItems: true,
    }),
    freshnessRequirement: commerceFreshnessRequirementSchema,
  }),
]);
export type CommerceGraphQuery = StrictUnion<
  StaticDecode<typeof commerceGraphQuerySchema>
>;
export type CommerceAggregation = StrictUnion<
  StaticDecode<typeof commerceAggregationSchema>
>;
export type CommerceAggregationSource = StrictUnion<
  StaticDecode<typeof commerceAggregationSourceSchema>
>;
export type CommerceContextSelection = StrictUnion<
  StaticDecode<typeof commerceContextSelectionSchema>
>;
