import {
  systemEntityTypeIdSchema,
  attributeDefinitionIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  queryIdentitySchema,
  invalidShape,
  identityRefusal,
  queryRefusal,
  parseSorts,
  sortWire,
} from "./query-parts.ts";
import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "@purin-labs/contract-schema";
import { commerceFilterWireSchema } from "./query-wire.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cleanValue } from "@purin-labs/contract-schema/sorted-unions";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

import {
  commerceFilterSchema,
  parseCommerceFilter,
  type CommerceFilter,
} from "./query-filter.ts";
import { commerceSortSchema } from "./query-ordering.ts";
import { effectiveCommerceOrdering } from "./query-plan-parts.ts";
import { cursorRefusal } from "./cursor-values.ts";
import { revisionSchema } from "./entity-record.ts";

const capabilityIds = Type.Array(attributeDefinitionIdSchema, {
  maxItems: 256,
  uniqueItems: true,
});
const commerceAggregationCapabilitySchema = Type.Union([
  OpenObject({ kind: Type.Literal("count_only") }),
  OpenObject({
    kind: Type.Literal("count_and_attributes"),
    groupedCountAttributeIds: capabilityIds,
    sumAttributeIds: capabilityIds,
    minimumAttributeIds: capabilityIds,
    maximumAttributeIds: capabilityIds,
    oldestDueDateAttributeIds: capabilityIds,
    ageBucketAttributeIds: capabilityIds,
  }),
]);
const commerceCapabilityMatrixSchema = OpenObject({
  filterableAttributeIds: capabilityIds,
  sortableAttributeIds: capabilityIds,
  aggregation: commerceAggregationCapabilitySchema,
});
const systemMappedSavedViewCapabilitySourceSchema = OpenObject({
  kind: Type.Literal("system_mapped"),
  systemEntityKind: systemEntityTypeIdSchema.properties.typeId,
  systemSchemaRevision: revisionSchema<"SystemSchemaRevision">(),
  capability: commerceCapabilityMatrixSchema,
});
const commerceCustomSavedViewCapabilitySourceSchema = OpenObject({
  kind: Type.Literal("underclerk_custom"),
  entityTypeId: queryIdentitySchema<"CustomCommerceEntityTypeId">(),
  publishedRevision: revisionSchema<"CustomEntityTypeRevision">(),
  capability: commerceCapabilityMatrixSchema,
});
const commerceListSavedViewCapabilitySourceSchema = OpenObject({
  kind: Type.Literal("commerce_list"),
  listId: commerceListIdSchema,
  listRevision: revisionSchema<"CommerceListRevision">(),
  capability: commerceCapabilityMatrixSchema,
});
export const commerceSavedViewCapabilitySourceSchema = Type.Union([
  systemMappedSavedViewCapabilitySourceSchema,
  commerceCustomSavedViewCapabilitySourceSchema,
  commerceListSavedViewCapabilitySourceSchema,
]);
const viewRevisionSchema = revisionSchema<"SavedCommerceViewRevision">();
export const commerceQueryCapabilityProfileSchema = Type.Union([
  ...commerceSavedViewCapabilitySourceSchema.anyOf,
  OpenObject({
    kind: Type.Literal("saved_commerce_view"),
    viewId: savedCommerceViewIdSchema,
    viewRevision: viewRevisionSchema,
    source: commerceSavedViewCapabilitySourceSchema,
    filter: Type.Unsafe<CommerceFilter>(commerceFilterSchema),
    sorts: Type.Array(commerceSortSchema, { maxItems: 8 }),
  }),
]);
export type CommerceAggregationCapability = StrictUnion<
  Static<typeof commerceAggregationCapabilitySchema>
>;
export type CommerceCapabilityMatrix = Static<
  typeof commerceCapabilityMatrixSchema
>;
export type CommerceSavedViewCapabilitySource = StrictUnion<
  Static<typeof commerceSavedViewCapabilitySourceSchema>
>;
export type CommerceQueryCapabilityProfile = StrictUnion<
  Static<typeof commerceQueryCapabilityProfileSchema>
>;
const idsWire = Type.Array(Type.String());
const aggregationWire = Type.Union([
  OpenObject({ kind: Type.Literal("count_only") }),
  OpenObject({
    kind: Type.Literal("count_and_attributes"),
    groupedCountAttributeIds: idsWire,
    sumAttributeIds: idsWire,
    minimumAttributeIds: idsWire,
    maximumAttributeIds: idsWire,
    oldestDueDateAttributeIds: idsWire,
    ageBucketAttributeIds: idsWire,
  }),
]);
const matrixWire = OpenObject({
  filterableAttributeIds: idsWire,
  sortableAttributeIds: idsWire,
  aggregation: aggregationWire,
});

const sourceWire = Type.Union([
  OpenObject({
    kind: Type.Literal("system_mapped"),
    systemEntityKind: systemEntityTypeIdSchema.properties.typeId,
    systemSchemaRevision: revisionWire,
    capability: matrixWire,
  }),
  OpenObject({
    kind: Type.Literal("underclerk_custom"),
    entityTypeId: Type.String(),
    publishedRevision: revisionWire,
    capability: matrixWire,
  }),
  OpenObject({
    kind: Type.Literal("commerce_list"),
    listId: Type.String(),
    listRevision: revisionWire,
    capability: matrixWire,
  }),
]);
export const profileWire = Type.Union([
  ...sourceWire.anyOf,
  OpenObject({
    kind: Type.Literal("saved_commerce_view"),
    viewId: Type.String(),
    viewRevision: revisionWire,
    source: sourceWire,
    filter: commerceFilterWireSchema,
    sorts: Type.Array(sortWire),
  }),
]);
function validateIds(ids: string[]): ContractDecodeResult<null> {
  if (ids.length > 256) return queryRefusal();
  const seen = new Set<string>();
  for (const id of ids) {
    if (!Value.Check(attributeDefinitionIdSchema, id))
      return identityRefusal("AttributeDefinitionId");
    if (seen.has(id)) return cursorRefusal("duplicate_identity");
    seen.add(id);
  }
  return { ok: true, value: null };
}
function parseMatrix(
  input: unknown,
): ContractDecodeResult<CommerceCapabilityMatrix> {
  const parsed = parseContract(matrixWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const matrix = parsed.value;
  const filterable = validateIds(matrix.filterableAttributeIds);
  if (!filterable.ok) return filterable;
  const sortable = validateIds(matrix.sortableAttributeIds);
  if (!sortable.ok) return sortable;
  const aggregation = matrix.aggregation;
  if (aggregation.kind === "count_and_attributes") {
    for (const ids of [
      aggregation.groupedCountAttributeIds,
      aggregation.sumAttributeIds,
      aggregation.minimumAttributeIds,
      aggregation.maximumAttributeIds,
      aggregation.oldestDueDateAttributeIds,
      aggregation.ageBucketAttributeIds,
    ]) {
      const checked = validateIds(ids);
      if (!checked.ok) return checked;
    }
  }
  const clean = cleanValue(commerceCapabilityMatrixSchema, Value.Clone(matrix));
  return parseContract(commerceCapabilityMatrixSchema, clean, invalidShape);
}
export function parseCommerceSavedViewCapabilitySource(
  input: unknown,
): ContractDecodeResult<CommerceSavedViewCapabilitySource> {
  const parsed = parseContract(sourceWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  switch (source.kind) {
    case "system_mapped":
      if (source.systemSchemaRevision === 0)
        return invalidRevision("SystemSchemaRevision");
      break;
    case "underclerk_custom":
      if (
        !Value.Check(
          commerceCustomSavedViewCapabilitySourceSchema.properties
            .entityTypeId,
          source.entityTypeId,
        )
      )
        return identityRefusal("CustomCommerceEntityTypeId");
      if (source.publishedRevision === 0)
        return invalidRevision("CustomEntityTypeRevision");
      break;
    case "commerce_list":
      if (!Value.Check(commerceListIdSchema, source.listId))
        return identityRefusal("CommerceListId");
      if (source.listRevision === 0)
        return invalidRevision("CommerceListRevision");
      break;
    default:
      return assertNever(source);
  }
  const matrix = parseMatrix(source.capability);
  if (!matrix.ok) return matrix;
  const clean = cleanValue(
    commerceSavedViewCapabilitySourceSchema,
    Value.Clone(source),
  );
  return parseContract(
    commerceSavedViewCapabilitySourceSchema,
    clean,
    invalidShape,
  );
}
export function parseCommerceQueryCapabilityProfile(
  input: unknown,
): ContractDecodeResult<CommerceQueryCapabilityProfile> {
  const parsed = parseContract(profileWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const profile = parsed.value;
  if (profile.kind !== "saved_commerce_view")
    return parseCommerceSavedViewCapabilitySource(profile);
  const viewId = profile.viewId;
  if (!Value.Check(savedCommerceViewIdSchema, viewId))
    return identityRefusal("SavedCommerceViewId");
  const viewRevision = profile.viewRevision;
  if (!Value.Check(viewRevisionSchema, viewRevision))
    return invalidRevision("SavedCommerceViewRevision");
  const source = parseCommerceSavedViewCapabilitySource(profile.source);
  if (!source.ok) return source;
  const filter = parseCommerceFilter(profile.filter);
  if (!filter.ok) return filter;
  const sorts = parseSorts(profile.sorts);
  if (!sorts.ok) return sorts;
  const ordering = effectiveCommerceOrdering({
    kind: "presentation",
    requestedSorts: sorts.value,
  });
  if (!ordering.ok) return ordering;
  return {
    ok: true,
    value: {
      kind: "saved_commerce_view",
      viewId,
      viewRevision,
      source: source.value,
      filter: filter.value,
      sorts: sorts.value,
    },
  };
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}
