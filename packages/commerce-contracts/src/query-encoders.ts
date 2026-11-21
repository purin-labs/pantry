import { assertNever, sha256HexSync } from "@purin-labs/std";
import type { AttributeFilter } from "./records/entity-plane.ts";
import type { AttributeValue } from "./attribute-value.ts";
import type { CommerceAggregation } from "./graph-query-schema.ts";
import type { CommerceAggregationSource } from "./graph-query-schema.ts";
import type { CommerceContextSelection } from "./graph-query-schema.ts";
import type { CommerceCursorPayload } from "./cursor-payload.ts";
import type { CommerceEntityRef } from "./entity-reference.ts";
import type { CommerceEntityTypeId } from "./query-parts.ts";
import type { CommerceFilter } from "./query-filter.ts";
import type { CommerceFreshnessRequirement } from "./query-limits.ts";
import type { CommerceGraphQuery } from "./graph-query-schema.ts";
import type { CommerceOrderingLeadingKey } from "./query-ordering.ts";
import type { CommerceOrderingValue } from "./cursor-values.ts";
import type { CommerceReadWatermark } from "./query-metadata.ts";
import type { CommerceSort } from "./query-ordering.ts";
import type { CommerceSortField } from "./query-ordering.ts";
import type { CommerceTraversalLimits } from "./query-limits.ts";
import type { RelationshipDefinitionRef } from "./records/entity-plane.ts";

declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/** Preserve serde's enum tags, declaration order and top-level cursor removal. */
export function encodeCommerceQueryFingerprint(
  query: CommerceGraphQuery,
): string {
  return JSON.stringify(orderedQuery(query, "fingerprint"));
}

/** Synchronous, so that a Durable Object read can plan inside its SQL transaction. */
export function commerceQueryFingerprint(query: CommerceGraphQuery): string {
  return sha256HexSync(encodeCommerceQueryFingerprint(query));
}

export function encodeCommerceCursorPayload(
  payload: CommerceCursorPayload,
): string {
  return JSON.stringify({
    organisationId: payload.organisationId,
    merchantId: payload.merchantId,
    queryFingerprint: payload.queryFingerprint,
    semanticsVersion: payload.semanticsVersion,
    orderingVersion: payload.orderingVersion,
    effectiveOrdering: {
      leadingKeys: payload.effectiveOrdering.leadingKeys.map(orderedLeadingKey),
      tieBreaker: { kind: payload.effectiveOrdering.tieBreaker.kind },
    },
    boundary: {
      orderingValues: payload.boundary.orderingValues.map(orderedOrderingValue),
      entityRef: orderedReference(payload.boundary.entityRef),
    },
    watermark: orderedWatermark(payload.watermark),
  });
}

export function encodeCommerceCursor(payload: CommerceCursorPayload): string {
  const bytes = new TextEncoder().encode(encodeCommerceCursorPayload(payload));
  let encoded = "v1_";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

function orderedQuery(
  query: CommerceGraphQuery,
  purpose: "fingerprint" | "selector",
): unknown {
  switch (query.kind) {
    case "entity_by_ref":
      return {
        kind: query.kind,
        reference: orderedReference(query.reference),
        traversal: orderedTraversal(query.traversal),
        filter: query.filter === null ? null : orderedFilter(query.filter),
      };
    case "entity_type_page":
      return {
        kind: query.kind,
        entityTypeId: orderedEntityType(query.entityTypeId),
        filter: orderedFilter(query.filter),
        sorts: query.sorts.map(orderedSort),
        pagination: {
          limit: query.pagination.limit,
          cursor: purpose === "fingerprint" ? null : query.pagination.cursor,
        },
        traversal: orderedTraversal(query.traversal),
      };
    case "relationship_traversal":
      return {
        kind: query.kind,
        seeds: query.seeds.map(orderedReference),
        relationshipDefinition:
          query.relationshipDefinition === null
            ? null
            : orderedRelationshipDefinition(query.relationshipDefinition),
        traversal: orderedTraversal(query.traversal),
        filter: query.filter === null ? null : orderedFilter(query.filter),
      };
    case "commerce_list_page":
      return {
        kind: query.kind,
        listId: query.listId,
        filter: orderedFilter(query.filter),
        sorts: query.sorts.map(orderedSort),
        pagination: {
          limit: query.pagination.limit,
          cursor: purpose === "fingerprint" ? null : query.pagination.cursor,
        },
      };
    case "saved_commerce_view":
      return {
        kind: query.kind,
        viewId: query.viewId,
        pagination: {
          limit: query.pagination.limit,
          cursor: purpose === "fingerprint" ? null : query.pagination.cursor,
        },
      };
    case "search":
      return {
        kind: query.kind,
        text: query.text,
        entityTypeId:
          query.entityTypeId === null
            ? null
            : orderedEntityType(query.entityTypeId),
        pagination: {
          limit: query.pagination.limit,
          cursor: purpose === "fingerprint" ? null : query.pagination.cursor,
        },
        traversal: orderedTraversal(query.traversal),
      };
    case "aggregation":
      return {
        kind: query.kind,
        source: orderedAggregationSource(query.source),
        filter: orderedFilter(query.filter),
        aggregation: orderedAggregation(query.aggregation),
      };
    case "commerce_context":
      return {
        kind: query.kind,
        selection: orderedSelection(query.selection),
        traversal: orderedTraversal(query.traversal),
        allowedSensitivity: query.allowedSensitivity,
        allowedAttributeIds: query.allowedAttributeIds,
        freshnessRequirement: orderedFreshness(query.freshnessRequirement),
      };
    default:
      return assertNever(query);
  }
}

function orderedTraversal(
  traversal: CommerceTraversalLimits,
): CommerceTraversalLimits {
  return { maxDepth: traversal.maxDepth, resultLimit: traversal.resultLimit };
}

function orderedReference(reference: CommerceEntityRef): unknown {
  switch (reference.origin) {
    case "system":
      return {
        typeId: reference.typeId,
        origin: reference.origin,
        entityId: reference.entityId,
      };
    case "custom":
      return {
        origin: reference.origin,
        typeId: reference.typeId,
        entityId: reference.entityId,
      };
    default:
      return assertNever(reference);
  }
}

function orderedEntityType(type: CommerceEntityTypeId): unknown {
  return { origin: type.origin, typeId: type.typeId };
}

function orderedFilter(filter: CommerceFilter): unknown {
  switch (filter.kind) {
    case "all":
      return { kind: filter.kind };
    case "entity":
      return {
        kind: filter.kind,
        reference: orderedReference(filter.reference),
      };
    case "any":
      return { kind: filter.kind, filters: filter.filters.map(orderedFilter) };
    case "not":
      return { kind: filter.kind, filter: orderedFilter(filter.filter) };
    case "attribute":
      return {
        kind: filter.kind,
        filter: orderedAttributeFilter(filter.filter),
      };
    case "relationship":
      return {
        kind: filter.kind,
        filter: {
          relationshipDefinition: orderedRelationshipDefinition(
            filter.filter.relationshipDefinition,
          ),
          operator: filter.filter.operator,
        },
      };
    case "search":
      return { kind: filter.kind, text: filter.text };
    default:
      return assertNever(filter);
  }
}

function orderedRelationshipDefinition(
  definition: RelationshipDefinitionRef,
): unknown {
  return {
    origin: definition.origin,
    definitionId: definition.definitionId,
    revision: definition.revision,
  };
}

function orderedAttributeFilter(filter: AttributeFilter): unknown {
  switch (filter.operator) {
    case "equals":
    case "not_equals":
    case "less_than":
    case "less_than_or_equal":
    case "greater_than":
    case "greater_than_or_equal":
    case "contains":
      return {
        operator: filter.operator,
        attributeId: filter.attributeId,
        value: orderedAttributeValue(filter.value),
      };
    case "is_empty":
    case "is_not_empty":
      return { operator: filter.operator, attributeId: filter.attributeId };
    default:
      return assertNever(filter);
  }
}

function orderedAttributeValue(attribute: AttributeValue): unknown {
  switch (attribute.kind) {
    case "short_text":
    case "long_text":
    case "boolean":
    case "date":
    case "timestamp":
    case "status":
      return { kind: attribute.kind, value: attribute.value };
    case "integer":
      return { kind: attribute.kind, value: safeJsonInteger(attribute.value) };
    case "decimal":
      return {
        kind: attribute.kind,
        value: {
          unscaled: attribute.value.unscaled,
          scale: attribute.value.scale,
        },
      };
    case "choice":
      return { kind: attribute.kind, values: attribute.values };
    case "money":
      return {
        kind: attribute.kind,
        value: {
          amountMinor: attribute.value.amountMinor,
          currency: attribute.value.currency,
        },
      };
    case "merchant_operator_reference":
      return {
        kind: attribute.kind,
        value: {
          principalId: attribute.value.principalId,
          displayName: attribute.value.displayName,
        },
      };
    case "external_resource_reference":
      return {
        kind: attribute.kind,
        value: {
          source: attribute.value.source,
          resourceId: attribute.value.resourceId,
          label: attribute.value.label,
        },
      };
    default:
      return assertNever(attribute);
  }
}

function orderedSort(sort: CommerceSort): unknown {
  return { field: orderedSortField(sort.field), direction: sort.direction };
}

function orderedSortField(field: CommerceSortField): unknown {
  switch (field.kind) {
    case "attribute":
      return { kind: field.kind, attributeId: field.attributeId };
    case "display_name":
    case "created_at":
    case "updated_at":
      return { kind: field.kind };
    default:
      return assertNever(field);
  }
}

function orderedAggregationSource(source: CommerceAggregationSource): unknown {
  switch (source.kind) {
    case "entity_type":
      return {
        kind: source.kind,
        entityTypeId: orderedEntityType(source.entityTypeId),
      };
    case "commerce_list":
      return { kind: source.kind, listId: source.listId };
    default:
      return assertNever(source);
  }
}

function orderedAggregation(aggregation: CommerceAggregation): unknown {
  switch (aggregation.kind) {
    case "count":
      return { kind: aggregation.kind };
    case "grouped_count":
    case "sum":
    case "minimum":
    case "maximum":
    case "oldest_due_date":
      return { kind: aggregation.kind, attributeId: aggregation.attributeId };
    case "age_buckets":
      return {
        kind: aggregation.kind,
        attributeId: aggregation.attributeId,
        bucketDays: aggregation.bucketDays,
      };
    default:
      return assertNever(aggregation);
  }
}

function orderedSelection(selection: CommerceContextSelection): unknown {
  switch (selection.kind) {
    case "selector":
      return {
        kind: selection.kind,
        selector: {
          selectorId: selection.selector.selectorId,
          revision: selection.selector.revision,
          query: orderedQuery(selection.selector.query, "selector"),
        },
      };
    case "entity_seeds":
      return {
        kind: selection.kind,
        seeds: selection.seeds.map(orderedReference),
      };
    default:
      return assertNever(selection);
  }
}

function orderedFreshness(freshness: CommerceFreshnessRequirement): unknown {
  if (typeof freshness === "string") return freshness;
  return {
    observed_within_seconds: {
      seconds: freshness.observed_within_seconds.seconds,
    },
  };
}

function orderedLeadingKey(key: CommerceOrderingLeadingKey): unknown {
  return {
    field: orderedSortField(key.field),
    direction: key.direction,
    nulls: key.nulls,
  };
}

function orderedOrderingValue(value: CommerceOrderingValue): unknown {
  switch (value.kind) {
    case "null":
      return { kind: value.kind };
    case "text":
    case "boolean":
    case "date":
    case "timestamp":
      return { kind: value.kind, value: value.value };
    case "integer":
      return { kind: value.kind, value: safeJsonInteger(value.value) };
    case "decimal":
      return {
        kind: value.kind,
        value: { unscaled: value.value.unscaled, scale: value.value.scale },
      };
    default:
      return assertNever(value);
  }
}

function orderedWatermark(watermark: CommerceReadWatermark): unknown {
  switch (watermark.kind) {
    case "commerce_native":
      return {
        kind: watermark.kind,
        merchantRevision: watermark.merchantRevision,
      };
    case "provider_backed":
      return {
        kind: watermark.kind,
        blotterAcceptedProjectionSequence:
          watermark.blotterAcceptedProjectionSequence,
        commerceExtensionMerchantRevision:
          watermark.commerceExtensionMerchantRevision,
      };
    default:
      return assertNever(watermark);
  }
}

/** Only safe JSON integers can cross the existing JavaScript boundary. */
function safeJsonInteger(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError("invalid_json_integer");
  return number;
}
