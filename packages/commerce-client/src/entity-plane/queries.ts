import type {
  CommerceEntityPlaneQueryRequest,
  CommerceEntityPlaneCapabilityMetadataRequest,
  CommerceEntityPlaneCapabilityMetadataResponse,
  CommerceEntityPlaneRelationshipTraversalStepRequest,
} from "@seams/commerce-contracts/entity-plane-queries";
export type {
  CommerceEntityPlaneQueryRequest,
  CommerceEntityPlaneCapabilityMetadataRequest,
  CommerceEntityPlaneCapabilityMetadataResponse,
  CommerceEntityPlaneRelationshipTraversalStepRequest,
} from "@seams/commerce-contracts/entity-plane-queries";
import type {
  AttributeDefinitionId,
  AttributeFilter,
  CommerceAggregationCapability,
  CommerceCapabilityMatrix,
  CommerceCursor,
  CommerceCursorPayload,
  CommerceFilter,
  CommerceGraphQuery,
  CommerceGraphQueryPlanRequest,
  CommerceListId,
  CommerceListRevision,
  CommerceQueryCapabilityProfile,
  CommerceQueryPlan,
  CommerceQueryPlanOutcome,
  CommerceQuerySemanticsV1,
  CommerceReadWatermark,
  CommerceSavedViewCapabilitySource,
  CommerceSort,
  CommerceSortDirection,
  CommerceSortField,
  CommerceSnapshotRevision,
  CustomCommerceEntityTypeId,
  CustomEntityTypeRevision,
  PublishedCommerceSelector,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
  SystemSchemaRevision,
} from "@seams/commerce-contracts";
import { parsePublishedCommerceSelector as parseSelectorContract } from "@seams/commerce-contracts/graph-query";
import { decodeRecord } from "./record-decoding.ts";
import * as queryContracts from "@seams/commerce-contracts/entity-plane-queries";
import * as plannerContracts from "@seams/commerce-contracts/query-planner";
import { parseCommerceGraphQuery as parseQueryContract } from "@seams/commerce-contracts/graph-query";
import { parseCommerceQueryPlan as parsePlanContract } from "@seams/commerce-contracts/query-plan";
import { parseCommerceCursorPayload as parseCursorContract } from "@seams/commerce-contracts/cursor-payload";

import {
  SYSTEM_KINDS,
  objectValue,
  arrayValue,
  brandText,
  brandRevision,
  brandNonNegativeRevision,
  enumValue,
} from "./primitives.ts";
import {
  parseAttributeFilter as parseAttributeFilterRecord,
  parseCommerceFilter as parseCommerceFilterRecord,
} from "@seams/commerce-contracts/records/entity-plane";
export function parseEntityPlaneQueryRequest(
  value: unknown,
): CommerceEntityPlaneQueryRequest {
  return decodeRecord(queryContracts.parseEntityPlaneQueryRequest, value);
}

export function parseEntityPlaneCapabilityMetadataRequest(
  value: unknown,
): CommerceEntityPlaneCapabilityMetadataRequest {
  return decodeRecord(
    queryContracts.parseEntityPlaneCapabilityMetadataRequest,
    value,
  );
}

export function parseEntityPlaneCapabilityMetadataResponse(
  value: unknown,
): CommerceEntityPlaneCapabilityMetadataResponse {
  return decodeRecord(
    queryContracts.parseEntityPlaneCapabilityMetadataResponse,
    value,
  );
}

export function parsePublishedCommerceSelector(
  value: unknown,
): PublishedCommerceSelector {
  return decodeRecord(parseSelectorContract, value);
}

export function parseEntityPlaneRelationshipTraversalStepRequest(
  value: unknown,
): CommerceEntityPlaneRelationshipTraversalStepRequest {
  return decodeRecord(
    queryContracts.parseEntityPlaneRelationshipTraversalStepRequest,
    value,
  );
}

export function parseCommerceGraphQuery(value: unknown): CommerceGraphQuery {
  return decodeRecord(parseQueryContract, value);
}

export function parseCommerceQueryPlanOutcome(
  value: unknown,
): CommerceQueryPlanOutcome {
  return decodeRecord(plannerContracts.parseCommerceQueryPlanOutcome, value);
}

export function parseCommerceQueryPlan(value: unknown): CommerceQueryPlan {
  return decodeRecord(parsePlanContract, value);
}

export function parseCommerceReadWatermark(
  value: unknown,
): CommerceReadWatermark {
  const object = objectValue(value, "queryPlan.watermark");
  const kind = enumValue(object.kind, "queryPlan.watermark.kind", [
    "underclerk_native",
    "provider_backed",
  ] as const);
  return kind === "underclerk_native"
    ? {
        kind,
        merchantRevision: brandNonNegativeRevision<CommerceSnapshotRevision>(
          object.merchantRevision,
          "queryPlan.watermark.merchantRevision",
        ),
      }
    : {
        kind,
        blotterAcceptedProjectionSequence:
          brandNonNegativeRevision<CommerceSnapshotRevision>(
            object.blotterAcceptedProjectionSequence,
            "queryPlan.watermark.blotterAcceptedProjectionSequence",
          ),
        underclerkExtensionMerchantRevision:
          brandNonNegativeRevision<CommerceSnapshotRevision>(
            object.underclerkExtensionMerchantRevision,
            "queryPlan.watermark.underclerkExtensionMerchantRevision",
          ),
      };
}

export function parseCommerceCursorValue(
  value: unknown,
  field = "commerceCursor",
): CommerceCursor {
  return brandText<CommerceCursor>(value, field);
}

export function parseCommerceCursorPayload(
  value: unknown,
): CommerceCursorPayload {
  return decodeRecord(parseCursorContract, value);
}

export function parseCommerceGraphQueryPlanRequest(
  value: unknown,
): CommerceGraphQueryPlanRequest {
  return decodeRecord(
    queryContracts.parseEntityPlaneGraphQueryPlanRequest,
    value,
  );
}

export function parseCommerceQuerySemantics(
  value: unknown,
): CommerceQuerySemanticsV1 {
  const object = objectValue(value, "commerceGraphQueryPlanRequest.semantics");
  return {
    semanticsVersion: enumValue(
      object.semanticsVersion,
      "semantics.semanticsVersion",
      ["v1"] as const,
    ),
    orderingVersion: enumValue(
      object.orderingVersion,
      "semantics.orderingVersion",
      ["v1"] as const,
    ),
    textNormalization: enumValue(
      object.textNormalization,
      "semantics.textNormalization",
      ["commerce_unicode_v1"] as const,
    ),
    nullPlacement: enumValue(object.nullPlacement, "semantics.nullPlacement", [
      "last",
    ] as const),
  };
}

export function parseCommerceQueryCapabilityProfile(
  value: unknown,
): CommerceQueryCapabilityProfile {
  const object = objectValue(
    value,
    "commerceGraphQueryPlanRequest.capabilities",
  );
  const kind = enumValue(object.kind, "capabilities.kind", [
    "system_mapped",
    "underclerk_custom",
    "commerce_list",
    "saved_commerce_view",
  ] as const);
  switch (kind) {
    case "system_mapped":
      return {
        kind,
        systemEntityKind: enumValue(
          object.systemEntityKind,
          "capabilities.systemEntityKind",
          SYSTEM_KINDS,
        ),
        systemSchemaRevision: brandRevision<SystemSchemaRevision>(
          object.systemSchemaRevision,
          "capabilities.systemSchemaRevision",
        ),
        capability: parseCommerceCapabilityMatrix(object.capability),
      };
    case "underclerk_custom":
      return {
        kind,
        entityTypeId: brandText<CustomCommerceEntityTypeId>(
          object.entityTypeId,
          "capabilities.entityTypeId",
        ),
        publishedRevision: brandRevision<CustomEntityTypeRevision>(
          object.publishedRevision,
          "capabilities.publishedRevision",
        ),
        capability: parseCommerceCapabilityMatrix(object.capability),
      };
    case "commerce_list":
      return {
        kind,
        listId: brandText<CommerceListId>(object.listId, "capabilities.listId"),
        listRevision: brandRevision<CommerceListRevision>(
          object.listRevision,
          "capabilities.listRevision",
        ),
        capability: parseCommerceCapabilityMatrix(object.capability),
      };
    case "saved_commerce_view":
      return {
        kind,
        viewId: brandText<SavedCommerceViewId>(
          object.viewId,
          "capabilities.viewId",
        ),
        viewRevision: brandRevision<SavedCommerceViewRevision>(
          object.viewRevision,
          "capabilities.viewRevision",
        ),
        source: parseCommerceSavedViewCapabilitySource(object.source),
        filter: parseFilter(object.filter),
        sorts: arrayValue(object.sorts, "capabilities.sorts").map(parseSort),
      };
  }
}

export function parseCommerceSavedViewCapabilitySource(
  value: unknown,
): CommerceSavedViewCapabilitySource {
  const object = objectValue(value, "capabilities.source");
  const kind = enumValue(object.kind, "capabilities.source.kind", [
    "system_mapped",
    "underclerk_custom",
    "commerce_list",
  ] as const);
  if (kind === "system_mapped")
    return {
      kind,
      systemEntityKind: enumValue(
        object.systemEntityKind,
        "capabilities.source.systemEntityKind",
        SYSTEM_KINDS,
      ),
      systemSchemaRevision: brandRevision<SystemSchemaRevision>(
        object.systemSchemaRevision,
        "capabilities.source.systemSchemaRevision",
      ),
      capability: parseCommerceCapabilityMatrix(object.capability),
    };
  if (kind === "underclerk_custom")
    return {
      kind,
      entityTypeId: brandText<CustomCommerceEntityTypeId>(
        object.entityTypeId,
        "capabilities.source.entityTypeId",
      ),
      publishedRevision: brandRevision<CustomEntityTypeRevision>(
        object.publishedRevision,
        "capabilities.source.publishedRevision",
      ),
      capability: parseCommerceCapabilityMatrix(object.capability),
    };
  return {
    kind,
    listId: brandText<CommerceListId>(
      object.listId,
      "capabilities.source.listId",
    ),
    listRevision: brandRevision<CommerceListRevision>(
      object.listRevision,
      "capabilities.source.listRevision",
    ),
    capability: parseCommerceCapabilityMatrix(object.capability),
  };
}

function parseCommerceCapabilityMatrix(
  value: unknown,
): CommerceCapabilityMatrix {
  const object = objectValue(value, "capability");
  const filterableAttributeIds = parseCapabilityAttributeIds(
    object.filterableAttributeIds,
    "filterableAttributeIds",
  );
  const sortableAttributeIds = parseCapabilityAttributeIds(
    object.sortableAttributeIds,
    "sortableAttributeIds",
  );
  return {
    filterableAttributeIds,
    sortableAttributeIds,
    aggregation: parseCommerceAggregationCapability(object.aggregation),
  };
}

function parseCommerceAggregationCapability(
  value: unknown,
): CommerceAggregationCapability {
  const object = objectValue(value, "capability.aggregation");
  const kind = enumValue(object.kind, "capability.aggregation.kind", [
    "count_only",
    "count_and_attributes",
  ] as const);
  if (kind === "count_only") return { kind };
  return {
    kind,
    groupedCountAttributeIds: parseCapabilityAttributeIds(
      object.groupedCountAttributeIds,
      "groupedCountAttributeIds",
    ),
    sumAttributeIds: parseCapabilityAttributeIds(
      object.sumAttributeIds,
      "sumAttributeIds",
    ),
    minimumAttributeIds: parseCapabilityAttributeIds(
      object.minimumAttributeIds,
      "minimumAttributeIds",
    ),
    maximumAttributeIds: parseCapabilityAttributeIds(
      object.maximumAttributeIds,
      "maximumAttributeIds",
    ),
    oldestDueDateAttributeIds: parseCapabilityAttributeIds(
      object.oldestDueDateAttributeIds,
      "oldestDueDateAttributeIds",
    ),
    ageBucketAttributeIds: parseCapabilityAttributeIds(
      object.ageBucketAttributeIds,
      "ageBucketAttributeIds",
    ),
  };
}

function parseCapabilityAttributeIds(
  value: unknown,
  field: string,
): AttributeDefinitionId[] {
  const ids = arrayValue(value, `capability.${field}`).map((entry) =>
    brandText<AttributeDefinitionId>(entry, `capability.${field}[]`),
  );
  if (new Set(ids).size !== ids.length)
    throw new Error(`capability.${field} contains duplicates`);
  return ids;
}

export function parseAttributeFilter(value: unknown): AttributeFilter {
  return decodeRecord(parseAttributeFilterRecord, value);
}

function parseFilter(value: unknown): CommerceFilter {
  return decodeRecord(parseCommerceFilterRecord, value);
}

function parseSort(value: unknown): CommerceSort {
  const object = objectValue(value, "sort");
  return {
    field: parseSortField(object.field),
    direction: enumValue(object.direction, "sort.direction", [
      "ascending",
      "descending",
    ] as const) satisfies CommerceSortDirection,
  };
}

function parseSortField(value: unknown): CommerceSortField {
  const object = objectValue(value, "sort.field");
  const kind = enumValue(object.kind, "sort.field.kind", [
    "attribute",
    "display_name",
    "created_at",
    "updated_at",
  ] as const);
  return kind === "attribute"
    ? {
        kind,
        attributeId: brandText<AttributeDefinitionId>(
          object.attributeId,
          "sort.field.attributeId",
        ),
      }
    : { kind };
}
