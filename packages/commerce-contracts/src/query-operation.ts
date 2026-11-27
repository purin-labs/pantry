import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import {
  commerceEntityTypeIdSchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  attributeDefinitionIdSchema,
  parseCommerceEntityTypeId,
  parseTraversal,
  parseFreshnessRequirement,
  invalidShape,
  identityRefusal,
  queryRefusal,
} from "./query-parts.ts";
import {
  commerceTraversalLimitsSchema,
  commerceFreshnessRequirementSchema,
} from "./query-limits.ts";
import {
  commerceContextSelectionSchema,
  commerceAggregationSchema,
  commerceAggregationSourceSchema,
} from "./graph-query-schema.ts";
import {
  parseCommerceQuerySeeds,
  parseCommerceAggregation,
  parseCommerceAggregationSource,
  parseCommerceContextSelection,
} from "./graph-query.ts";
import {
  relationshipDefinitionRefSchema,
  parseRelationshipDefinitionRef,
} from "./query-filter.ts";
import {
  commerceSavedViewCapabilitySourceSchema,
  parseCommerceSavedViewCapabilitySource,
} from "./query-capabilities.ts";

import { cursorRefusal } from "./cursor-values.ts";

const commerceRelationshipTraversalSubjectSchema = Type.Union([
  OpenObject({ kind: Type.Literal("all") }),
  OpenObject({
    kind: Type.Literal("definition"),
    relationshipDefinition: relationshipDefinitionRefSchema,
  }),
]);
const entityByRefQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("entity_by_ref"),
  reference: commerceEntityRefSchema,
  traversal: commerceTraversalLimitsSchema,
});
const entityTypePageQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("entity_type_page"),
  entityTypeId: commerceEntityTypeIdSchema,
  traversal: commerceTraversalLimitsSchema,
});
const searchQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("search"),
  entityTypeId: commerceEntityTypeIdSchema,
  traversal: commerceTraversalLimitsSchema,
});
export const relationshipTraversalQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("relationship_traversal"),
  seeds: Type.Array(commerceEntityRefSchema, { minItems: 1, maxItems: 64 }),
  subject: commerceRelationshipTraversalSubjectSchema,
  traversal: commerceTraversalLimitsSchema,
});
const commerceListPageQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("commerce_list_page"),
  listId: commerceListIdSchema,
});
const savedCommerceViewQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("saved_commerce_view"),
  viewId: savedCommerceViewIdSchema,
  source: commerceSavedViewCapabilitySourceSchema,
});
const aggregationQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("aggregation"),
  source: commerceAggregationSourceSchema,
  aggregation: commerceAggregationSchema,
});
const commerceContextQueryPlanOperationSchema = OpenObject({
  kind: Type.Literal("commerce_context"),
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
});
export const commerceQueryPlanOperationSchema = Type.Union([
  entityByRefQueryPlanOperationSchema,
  entityTypePageQueryPlanOperationSchema,
  searchQueryPlanOperationSchema,
  relationshipTraversalQueryPlanOperationSchema,
  commerceListPageQueryPlanOperationSchema,
  savedCommerceViewQueryPlanOperationSchema,
  aggregationQueryPlanOperationSchema,
  commerceContextQueryPlanOperationSchema,
]);
export type CommerceQueryPlanOperation = StrictUnion<
  StaticDecode<typeof commerceQueryPlanOperationSchema>
>;
type CommerceRelationshipTraversalSubject = StrictUnion<
  StaticDecode<typeof commerceRelationshipTraversalSubjectSchema>
>;
const subjectWire = Type.Union([
  OpenObject({ kind: Type.Literal("all") }),
  OpenObject({
    kind: Type.Literal("definition"),
    relationshipDefinition: Type.Unknown(),
  }),
]);
const operationWire = Type.Union([
  OpenObject({
    kind: Type.Literal("entity_by_ref"),
    reference: Type.Unknown(),
    traversal: Type.Unknown(),
  }),
  OpenObject({
    kind: Type.Enum(["entity_type_page", "search"]),
    entityTypeId: Type.Unknown(),
    traversal: Type.Unknown(),
  }),
  OpenObject({
    kind: Type.Literal("relationship_traversal"),
    seeds: Type.Array(Type.Unknown()),
    subject: subjectWire,
    traversal: Type.Unknown(),
  }),
  OpenObject({
    kind: Type.Literal("commerce_list_page"),
    listId: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("saved_commerce_view"),
    viewId: Type.String(),
    source: Type.Unknown(),
  }),
  OpenObject({
    kind: Type.Literal("aggregation"),
    source: Type.Unknown(),
    aggregation: Type.Unknown(),
  }),
  OpenObject({
    kind: Type.Literal("commerce_context"),
    selection: Type.Unknown(),
    traversal: Type.Unknown(),
    allowedSensitivity: Type.Enum([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]),
    allowedAttributeIds: Type.Array(Type.String()),
    freshnessRequirement: Type.Unknown(),
  }),
]);
export function parseCommerceQueryPlanOperation(
  input: unknown,
): ContractDecodeResult<CommerceQueryPlanOperation> {
  const parsed = parseContract(operationWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const operation = parsed.value;
  switch (operation.kind) {
    case "entity_by_ref": {
      const reference = parseCommerceEntityRef(operation.reference);
      if (!reference.ok) return reference;
      const traversal = parseTraversal(operation.traversal);
      if (!traversal.ok) return traversal;
      return {
        ok: true,
        value: {
          kind: "entity_by_ref",
          reference: reference.value,
          traversal: traversal.value,
        },
      };
    }
    case "entity_type_page":
    case "search": {
      const entityTypeId = parseCommerceEntityTypeId(operation.entityTypeId);
      if (!entityTypeId.ok) return entityTypeId;
      const traversal = parseTraversal(operation.traversal);
      if (!traversal.ok) return traversal;
      return {
        ok: true,
        value: {
          kind: operation.kind,
          entityTypeId: entityTypeId.value,
          traversal: traversal.value,
        },
      };
    }
    case "relationship_traversal": {
      const seeds = parseCommerceQuerySeeds(operation.seeds);
      if (!seeds.ok) return seeds;
      const subject = parseSubject(operation.subject);
      if (!subject.ok) return subject;
      const traversal = parseTraversal(operation.traversal);
      if (!traversal.ok) return traversal;
      return {
        ok: true,
        value: {
          kind: "relationship_traversal",
          seeds: seeds.value,
          subject: subject.value,
          traversal: traversal.value,
        },
      };
    }
    case "commerce_list_page": {
      const listId = operation.listId;
      if (!Value.Check(commerceListIdSchema, listId))
        return identityRefusal("CommerceListId");
      return { ok: true, value: { kind: "commerce_list_page", listId } };
    }
    case "saved_commerce_view": {
      const viewId = operation.viewId;
      if (!Value.Check(savedCommerceViewIdSchema, viewId))
        return identityRefusal("SavedCommerceViewId");
      const source = parseCommerceSavedViewCapabilitySource(operation.source);
      if (!source.ok) return source;
      return {
        ok: true,
        value: { kind: "saved_commerce_view", viewId, source: source.value },
      };
    }
    case "aggregation": {
      const source = parseCommerceAggregationSource(operation.source);
      if (!source.ok) return source;
      const aggregation = parseCommerceAggregation(operation.aggregation);
      if (!aggregation.ok) return aggregation;
      return {
        ok: true,
        value: {
          kind: "aggregation",
          source: source.value,
          aggregation: aggregation.value,
        },
      };
    }
    case "commerce_context": {
      const traversal = parseTraversal(operation.traversal);
      if (!traversal.ok) return traversal;
      const selection = parseCommerceContextSelection(operation.selection);
      if (!selection.ok) return selection;
      if (operation.allowedAttributeIds.length > 256) return queryRefusal();
      const seen = new Set<string>();
      const allowedAttributeIds = [];
      for (const id of operation.allowedAttributeIds) {
        if (!Value.Check(attributeDefinitionIdSchema, id))
          return identityRefusal("AttributeDefinitionId");
        if (seen.has(id)) return cursorRefusal("duplicate_identity");
        seen.add(id);
        allowedAttributeIds.push(id);
      }
      const freshness = parseFreshnessRequirement(
        operation.freshnessRequirement,
      );
      if (!freshness.ok) return freshness;
      return {
        ok: true,
        value: {
          kind: "commerce_context",
          selection: selection.value,
          traversal: traversal.value,
          allowedSensitivity: operation.allowedSensitivity,
          allowedAttributeIds,
          freshnessRequirement: freshness.value,
        },
      };
    }
    default:
      return assertNever(operation);
  }
}
function parseSubject(
  input: unknown,
): ContractDecodeResult<CommerceRelationshipTraversalSubject> {
  const parsed = parseContract(subjectWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === "all") return { ok: true, value: { kind: "all" } };
  const definition = parseRelationshipDefinitionRef(
    parsed.value.relationshipDefinition,
  );
  if (!definition.ok) return definition;
  return {
    ok: true,
    value: { kind: "definition", relationshipDefinition: definition.value },
  };
}
