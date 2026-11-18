import { assertNever } from "@seams/std";
import type { CommerceGraphQuery } from "./graph-query-schema.ts";
import type { CommerceQueryCapabilityProfile } from "./query-capabilities.ts";
import type { CommerceQueryPlanOperation } from "./query-operation.ts";
import type { CommerceFilter } from "./query-filter.ts";
import type { CommerceOrderingIntent } from "./query-plan-parts.ts";
import type { CommerceCursor } from "./query-pagination.ts";
export type CommerceQueryConstruction = {
  operation: CommerceQueryPlanOperation;
  filter: CommerceFilter;
  intent: CommerceOrderingIntent;
  limit: number;
  cursor: CommerceCursor | null;
};
export function constructCommerceQuery(
  query: CommerceGraphQuery,
  capabilities: CommerceQueryCapabilityProfile,
): CommerceQueryConstruction | null {
  switch (query.kind) {
    case "entity_by_ref":
      return {
        operation: {
          kind: "entity_by_ref",
          reference: query.reference,
          traversal: query.traversal,
        },
        filter: query.filter ?? { kind: "all" },
        intent: { kind: "scan" },
        limit: query.traversal.resultLimit,
        cursor: null,
      };
    case "entity_type_page":
      return {
        operation: {
          kind: "entity_type_page",
          entityTypeId: query.entityTypeId,
          traversal: query.traversal,
        },
        filter: query.filter,
        intent: { kind: "presentation", requestedSorts: query.sorts },
        limit: query.pagination.limit,
        cursor: query.pagination.cursor,
      };
    case "relationship_traversal":
      return {
        operation: {
          kind: "relationship_traversal",
          seeds: query.seeds,
          subject:
            query.relationshipDefinition === null
              ? { kind: "all" }
              : {
                  kind: "definition",
                  relationshipDefinition: query.relationshipDefinition,
                },
          traversal: query.traversal,
        },
        filter: query.filter ?? { kind: "all" },
        intent: { kind: "scan" },
        limit: query.traversal.resultLimit,
        cursor: null,
      };
    case "commerce_list_page":
      return {
        operation: { kind: "commerce_list_page", listId: query.listId },
        filter: query.filter,
        intent: { kind: "presentation", requestedSorts: query.sorts },
        limit: query.pagination.limit,
        cursor: query.pagination.cursor,
      };
    case "saved_commerce_view":
      if (capabilities.kind !== "saved_commerce_view") return null;
      return {
        operation: {
          kind: "saved_commerce_view",
          viewId: query.viewId,
          source: capabilities.source,
        },
        filter: capabilities.filter,
        intent: { kind: "presentation", requestedSorts: capabilities.sorts },
        limit: query.pagination.limit,
        cursor: query.pagination.cursor,
      };
    case "search":
      if (query.entityTypeId === null) return null;
      return {
        operation: {
          kind: "search",
          entityTypeId: query.entityTypeId,
          traversal: query.traversal,
        },
        filter: { kind: "search", text: query.text },
        intent: { kind: "scan" },
        limit: query.pagination.limit,
        cursor: query.pagination.cursor,
      };
    case "aggregation":
      return {
        operation: {
          kind: "aggregation",
          source: query.source,
          aggregation: query.aggregation,
        },
        filter: query.filter,
        intent: { kind: "scan" },
        limit: 500,
        cursor: null,
      };
    case "underclerk_context":
      return {
        operation: {
          kind: "underclerk_context",
          selection: query.selection,
          traversal: query.traversal,
          allowedSensitivity: query.allowedSensitivity,
          allowedAttributeIds: query.allowedAttributeIds,
          freshnessRequirement: query.freshnessRequirement,
        },
        filter: { kind: "all" },
        intent: { kind: "scan" },
        limit: query.traversal.resultLimit,
        cursor: null,
      };
    default:
      return assertNever(query);
  }
}
