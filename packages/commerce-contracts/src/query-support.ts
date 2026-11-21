import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import type { CommerceEntityRef } from "./entity-reference.ts";
import type {
  CommerceGraphQuery,
  CommerceContextSelection,
  CommerceAggregation,
} from "./graph-query-schema.ts";
import type { CommerceQueryPlanOperation } from "./query-operation.ts";
import type {
  CommerceQueryCapabilityProfile,
  CommerceAggregationCapability,
} from "./query-capabilities.ts";
import type { CommerceOrderingIntent } from "./query-plan-parts.ts";
import type { CommerceFilter } from "./query-filter.ts";
import type { CommerceQueryPlanErrorCapability } from "./query-planner.ts";

type Origin = "system" | "custom";
function seedType(
  seeds: CommerceEntityRef[],
  origin: Origin,
  mode: "all_seeds" | "matching_origin",
): string | null {
  let first: string | null = null;
  for (const seed of seeds) {
    if (seed.origin !== origin) {
      if (mode === "all_seeds") return null;
      continue;
    }
    if (first !== null && seed.typeId !== first) return null;
    first = seed.typeId;
  }
  return first;
}
function selectorType(
  query: CommerceGraphQuery,
  origin: Origin,
): string | null {
  switch (query.kind) {
    case "entity_by_ref":
      return query.reference.origin === origin ? query.reference.typeId : null;
    case "entity_type_page":
      return query.entityTypeId.origin === origin
        ? query.entityTypeId.typeId
        : null;
    case "relationship_traversal":
      return seedType(query.seeds, origin, "all_seeds");
    case "aggregation":
      return query.source.kind === "entity_type" &&
        query.source.entityTypeId.origin === origin
        ? query.source.entityTypeId.typeId
        : null;
    case "commerce_context":
      return contextType(query.selection, origin);
    case "commerce_list_page":
    case "saved_commerce_view":
    case "search":
      return null;
    default:
      return assertNever(query);
  }
}
function contextType(
  selection: CommerceContextSelection,
  origin: Origin,
): string | null {
  switch (selection.kind) {
    case "entity_seeds":
      return seedType(selection.seeds, origin, "all_seeds");
    case "selector":
      return selectorType(selection.selector.query, origin);
    default:
      return assertNever(selection);
  }
}
function operationType(
  operation: CommerceQueryPlanOperation,
  origin: Origin,
): string | null {
  switch (operation.kind) {
    case "entity_by_ref":
      return operation.reference.origin === origin
        ? operation.reference.typeId
        : null;
    case "entity_type_page":
    case "search":
      return operation.entityTypeId.origin === origin
        ? operation.entityTypeId.typeId
        : null;
    case "relationship_traversal":
      return seedType(operation.seeds, origin, "matching_origin");
    case "aggregation":
      return operation.source.kind === "entity_type" &&
        operation.source.entityTypeId.origin === origin
        ? operation.source.entityTypeId.typeId
        : null;
    case "commerce_context":
      return contextType(operation.selection, origin);
    case "commerce_list_page":
    case "saved_commerce_view":
      return null;
    default:
      return assertNever(operation);
  }
}
function selectorList(query: CommerceGraphQuery): string | null {
  switch (query.kind) {
    case "commerce_list_page":
      return query.listId;
    case "aggregation":
      return query.source.kind === "commerce_list" ? query.source.listId : null;
    case "commerce_context":
      return query.selection.kind === "selector"
        ? selectorList(query.selection.selector.query)
        : null;
    case "entity_by_ref":
    case "entity_type_page":
    case "relationship_traversal":
    case "saved_commerce_view":
    case "search":
      return null;
    default:
      return assertNever(query);
  }
}
function operationList(operation: CommerceQueryPlanOperation): string | null {
  switch (operation.kind) {
    case "commerce_list_page":
      return operation.listId;
    case "aggregation":
      return operation.source.kind === "commerce_list"
        ? operation.source.listId
        : null;
    case "commerce_context":
      return operation.selection.kind === "selector"
        ? selectorList(operation.selection.selector.query)
        : null;
    case "entity_by_ref":
    case "entity_type_page":
    case "relationship_traversal":
    case "saved_commerce_view":
    case "search":
      return null;
    default:
      return assertNever(operation);
  }
}
function supportsOperation(
  profile: CommerceQueryCapabilityProfile,
  operation: CommerceQueryPlanOperation,
): boolean {
  switch (profile.kind) {
    case "system_mapped":
      return operationType(operation, "system") === profile.systemEntityKind;
    case "commerce_custom":
      return operationType(operation, "custom") === profile.entityTypeId;
    case "commerce_list":
      return operationList(operation) === profile.listId;
    case "saved_commerce_view":
      if (operation.kind === "saved_commerce_view")
        return (
          operation.viewId === profile.viewId &&
          canonicalJsonByCodePoint(operation.source) ===
            canonicalJsonByCodePoint(profile.source)
        );
      if (
        operation.kind === "commerce_context" &&
        operation.selection.kind === "selector"
      ) {
        const selector = operation.selection.selector;
        return (
          String(selector.selectorId) === String(profile.viewId) &&
          Number(selector.revision) === Number(profile.viewRevision) &&
          selector.query.kind === "saved_commerce_view" &&
          selector.query.viewId === profile.viewId
        );
      }
      return false;
    default:
      return assertNever(profile);
  }
}
function unsupportedFilter(
  filter: CommerceFilter,
  allowed: readonly string[],
): boolean {
  switch (filter.kind) {
    case "attribute":
      return !allowed.includes(filter.filter.attributeId);
    case "any":
      for (const child of filter.filters)
        if (unsupportedFilter(child, allowed)) return true;
      return false;
    case "not":
      return unsupportedFilter(filter.filter, allowed);
    case "entity":
    case "relationship":
    case "search":
    case "all":
      return false;
    default:
      return assertNever(filter);
  }
}
function unsupportedAggregation(
  aggregation: CommerceAggregation,
  capability: CommerceAggregationCapability,
): CommerceQueryPlanErrorCapability | null {
  if (aggregation.kind === "count") return null;
  switch (aggregation.kind) {
    case "grouped_count":
      return capability.kind === "count_and_attributes" &&
        capability.groupedCountAttributeIds.includes(aggregation.attributeId)
        ? null
        : { kind: "grouped_aggregation" };
    case "sum":
      return capability.kind === "count_and_attributes" &&
        capability.sumAttributeIds.includes(aggregation.attributeId)
        ? null
        : { kind: "sum_aggregation" };
    case "minimum":
      return capability.kind === "count_and_attributes" &&
        capability.minimumAttributeIds.includes(aggregation.attributeId)
        ? null
        : { kind: "minimum_aggregation" };
    case "maximum":
      return capability.kind === "count_and_attributes" &&
        capability.maximumAttributeIds.includes(aggregation.attributeId)
        ? null
        : { kind: "maximum_aggregation" };
    case "oldest_due_date":
      return capability.kind === "count_and_attributes" &&
        capability.oldestDueDateAttributeIds.includes(aggregation.attributeId)
        ? null
        : { kind: "oldest_due_date_aggregation" };
    case "age_buckets":
      return capability.kind === "count_and_attributes" &&
        capability.ageBucketAttributeIds.includes(aggregation.attributeId)
        ? null
        : { kind: "age_buckets_aggregation" };
    default:
      return assertNever(aggregation);
  }
}
export function unsupportedCommerceCapability(
  operation: CommerceQueryPlanOperation,
  filter: CommerceFilter,
  intent: CommerceOrderingIntent,
  profile: CommerceQueryCapabilityProfile,
): CommerceQueryPlanErrorCapability | null {
  if (!supportsOperation(profile, operation)) return { kind: "source_mapping" };
  const matrix =
    profile.kind === "saved_commerce_view"
      ? profile.source.capability
      : profile.capability;
  if (intent.kind === "presentation") {
    for (const sort of intent.requestedSorts)
      if (
        sort.field.kind === "attribute" &&
        !matrix.sortableAttributeIds.includes(sort.field.attributeId)
      )
        return { kind: "attribute_sort" };
  }
  if (unsupportedFilter(filter, matrix.filterableAttributeIds))
    return { kind: "attribute_filter" };
  if (
    operation.kind === "aggregation" &&
    operation.source.kind === "commerce_list" &&
    filter.kind === "search"
  )
    return { kind: "source_mapping" };
  if (operation.kind === "aggregation")
    return unsupportedAggregation(operation.aggregation, matrix.aggregation);
  return null;
}
