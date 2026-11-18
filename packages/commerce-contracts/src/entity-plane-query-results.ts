import { relationshipTraversalQueryPlanOperationSchema } from "./query-operation.ts";
import {
  OpenObject,
  StrictObject,
  parseContract,
  parseContractArray,
  type ContractDecodeResult,
  SafeInteger as safeInteger,
  PositiveInteger as positiveInteger,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { assertNever } from "@seams/std";
import { type StrictUnion } from "@seams/type-utils";
import { commerceIntegerSchema, cursorRefusal } from "./cursor-values.ts";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";
import {
  attributeValueSchema,
  parseAttributeValue,
  type AttributeValue,
} from "./attribute-value.ts";
import {
  commerceEntitySchema,
  parseCommerceEntityShape,
  type CommerceEntity,
} from "./entity-record.ts";
import {
  commerceRelationshipSchema,
  parseCommerceRelationshipShape,
  type CommerceRelationship,
} from "./relationships.ts";
import {
  commerceListEntrySchema,
  parseCommerceListEntryShape,
  type CommerceListEntry,
} from "./list-records.ts";
import {
  sourceProvenanceSchema,
  parseEntityProvenance,
  type CommerceFreshness,
} from "./entity-state.ts";
import { commerceSnapshotRevisionSchema } from "./query-metadata.ts";
import {
  commerceQueryPlanSchema,
  parseCommerceQueryPlan,
  type CommerceQueryPlan,
} from "./query-plan.ts";

import {
  commerceUnplannedQueryOutcomeSchemas,
  parseCommerceQueryPlanOutcome,
} from "./query-planner.ts";
import { queryIdentitySchema, invalidShape } from "./query-parts.ts";

const freshnessWire = Type.Union([
  OpenObject({
    state: Type.Literal("current"),
    observedAt: javascriptTrimmedTextSchema,
  }),
  OpenObject({
    state: Type.Literal("stale"),
    observedAt: javascriptTrimmedTextSchema,
    staleSince: javascriptTrimmedTextSchema,
  }),
  OpenObject({
    state: Type.Literal("unavailable"),
    reason: javascriptTrimmedTextSchema,
  }),
]);
export const commerceAggregationGroupSchema = OpenObject({
  value: Type.Unsafe<AttributeValue>(attributeValueSchema),
  count: commerceIntegerSchema,
});
export type CommerceAggregationGroup = StaticDecode<
  typeof commerceAggregationGroupSchema
>;
export const commerceAgeBucketSchema = OpenObject({
  minimumAgeDays: positiveInteger,
  maximumAgeDays: Type.Union([positiveInteger, Type.Null()]),
  count: commerceIntegerSchema,
});
export type CommerceAgeBucket = StaticDecode<typeof commerceAgeBucketSchema>;
export const commerceAggregationResultSchema = Type.Union([
  OpenObject({ kind: Type.Literal("count"), value: commerceIntegerSchema }),
  OpenObject({
    kind: Type.Literal("grouped_count"),
    groups: Type.Array(commerceAggregationGroupSchema),
  }),
  OpenObject({ kind: Type.Literal("number"), value: commerceIntegerSchema }),
  OpenObject({
    kind: Type.Literal("date"),
    value: Type.Union([javascriptTrimmedTextSchema, Type.Null()]),
  }),
  OpenObject({
    kind: Type.Literal("age_buckets"),
    buckets: Type.Array(commerceAgeBucketSchema),
  }),
]);
export type CommerceAggregationResult = StrictUnion<
  StaticDecode<typeof commerceAggregationResultSchema>
>;
const cursorSchema = Type.Unsafe<
  string & { readonly __brand: "CommerceCursor" }
>(javascriptTrimmedTextSchema);
export const commerceGraphQueryResultSchema = OpenObject({
  merchantRevision: commerceSnapshotRevisionSchema,
  entities: Type.Array(Type.Unsafe<CommerceEntity>(commerceEntitySchema)),
  relationships: Type.Array(
    Type.Unsafe<CommerceRelationship>(commerceRelationshipSchema),
  ),
  listEntries: Type.Array(
    Type.Unsafe<CommerceListEntry>(commerceListEntrySchema),
  ),
  aggregations: Type.Array(
    Type.Unsafe<CommerceAggregationResult>(commerceAggregationResultSchema),
  ),
  nextCursor: Type.Union([cursorSchema, Type.Null()]),
  provenance: Type.Array(sourceProvenanceSchema),
  freshness: Type.Array(Type.Unsafe<CommerceFreshness>(freshnessWire)),
});
export type CommerceGraphQueryResult = StaticDecode<
  typeof commerceGraphQueryResultSchema
>;
const plannedFields = {
  kind: Type.Literal("planned"),
  organisationId: javascriptTrimmedTextSchema,
  merchantId: queryIdentitySchema<"CommerceMerchantId">(),
  merchantRevision: commerceSnapshotRevisionSchema,
  plan: Type.Unsafe<CommerceQueryPlan>(commerceQueryPlanSchema),
  result: Type.Unsafe<CommerceGraphQueryResult>(commerceGraphQueryResultSchema),
  hasMore: Type.Boolean(),
};
export const entityPlanePlannedQueryResponseSchema = Type.Union([
  OpenObject(plannedFields),
  ...commerceUnplannedQueryOutcomeSchemas,
]);
export type CommerceEntityPlanePlannedQueryResponse = StrictUnion<
  Readonly<StaticDecode<typeof entityPlanePlannedQueryResponseSchema>>
>;
export const entityPlaneRelationshipTraversalStepResponseSchema = Type.Union([
  OpenObject({
    ...plannedFields,
    merchantId: javascriptTrimmedTextSchema,
    hasMore: Type.Literal(false),
    plan: Type.Unsafe<CommerceQueryPlan>(
      StrictObject({
        ...commerceQueryPlanSchema.properties,
        operation: relationshipTraversalQueryPlanOperationSchema,
      }),
    ),
  }),
  ...commerceUnplannedQueryOutcomeSchemas,
]);
export type CommerceEntityPlaneRelationshipTraversalStepResponse =
  StrictUnion<
    Readonly<
      StaticDecode<typeof entityPlaneRelationshipTraversalStepResponseSchema>
    >
  >;
const aggregationWire = Type.Union([
  OpenObject({ kind: Type.Enum(["count", "number"]), value: safeInteger }),
  OpenObject({
    kind: Type.Literal("grouped_count"),
    groups: Type.Array(Type.Unknown()),
  }),
  OpenObject({
    kind: Type.Literal("date"),
    value: Type.Optional(
      Type.Union([javascriptTrimmedTextSchema, Type.Null()]),
    ),
  }),
  OpenObject({
    kind: Type.Literal("age_buckets"),
    buckets: Type.Array(Type.Unknown()),
  }),
]);
const groupWire = OpenObject({ value: Type.Unknown(), count: safeInteger });
const bucketWire = OpenObject({
  minimumAgeDays: positiveInteger,
  maximumAgeDays: Type.Optional(Type.Union([positiveInteger, Type.Null()])),
  count: safeInteger,
});
const graphResultWire = OpenObject({
  merchantRevision: commerceSnapshotRevisionSchema,
  entities: Type.Array(Type.Unknown()),
  relationships: Type.Array(Type.Unknown()),
  listEntries: Type.Array(Type.Unknown()),
  aggregations: Type.Array(Type.Unknown()),
  nextCursor: Type.Optional(Type.Union([cursorSchema, Type.Null()])),
  provenance: Type.Array(Type.Unknown()),
  freshness: Type.Array(Type.Unknown()),
});
const responseWire = Type.Union([
  OpenObject({
    ...plannedFields,
    plan: Type.Unknown(),
    result: Type.Unknown(),
  }),
  ...commerceUnplannedQueryOutcomeSchemas,
]);
export function parseCommerceAggregationGroup(
  input: unknown,
): ContractDecodeResult<CommerceAggregationGroup> {
  const parsed = parseContract(groupWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const value = parseAttributeValue(parsed.value.value);
  if (!value.ok) return value;
  return {
    ok: true,
    value: { value: value.value, count: BigInt(parsed.value.count) },
  };
}
function parseAgeBucket(
  input: unknown,
): ContractDecodeResult<CommerceAgeBucket> {
  const parsed = parseContract(bucketWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      minimumAgeDays: parsed.value.minimumAgeDays,
      maximumAgeDays: parsed.value.maximumAgeDays ?? null,
      count: BigInt(parsed.value.count),
    },
  };
}
export function parseCommerceAggregationResult(
  input: unknown,
): ContractDecodeResult<CommerceAggregationResult> {
  const parsed = parseContract(aggregationWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  switch (result.kind) {
    case "count":
    case "number":
      return {
        ok: true,
        value: { kind: result.kind, value: BigInt(result.value) },
      };
    case "date":
      return {
        ok: true,
        value: { kind: result.kind, value: result.value ?? null },
      };
    case "grouped_count": {
      const groups = parseContractArray(
        result.groups,
        parseCommerceAggregationGroup,
      );
      if (!groups.ok) return groups;
      return { ok: true, value: { kind: result.kind, groups: groups.value } };
    }
    case "age_buckets": {
      const buckets = parseContractArray(result.buckets, parseAgeBucket);
      if (!buckets.ok) return buckets;
      return { ok: true, value: { kind: result.kind, buckets: buckets.value } };
    }
    default:
      return assertNever(result);
  }
}
function parseResultFreshness(
  input: unknown,
): ContractDecodeResult<CommerceFreshness> {
  const parsed = parseContract(freshnessWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const freshness = parsed.value;
  switch (freshness.state) {
    case "current":
      return {
        ok: true,
        value: { state: freshness.state, observedAt: freshness.observedAt },
      };
    case "stale":
      return {
        ok: true,
        value: {
          state: freshness.state,
          observedAt: freshness.observedAt,
          staleSince: freshness.staleSince,
        },
      };
    case "unavailable":
      return {
        ok: true,
        value: { state: freshness.state, reason: freshness.reason },
      };
    default:
      return assertNever(freshness);
  }
}
export function parseCommerceGraphQueryResult(
  input: unknown,
): ContractDecodeResult<CommerceGraphQueryResult> {
  const parsed = parseContract(graphResultWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  const entities = parseContractArray(
    response.entities,
    parseCommerceEntityShape,
  );
  if (!entities.ok) return entities;
  const relationships = parseContractArray(
    response.relationships,
    parseCommerceRelationshipShape,
  );
  if (!relationships.ok) return relationships;
  const listEntries = parseContractArray(
    response.listEntries,
    parseCommerceListEntryShape,
  );
  if (!listEntries.ok) return listEntries;
  const aggregations = parseContractArray(
    response.aggregations,
    parseCommerceAggregationResult,
  );
  if (!aggregations.ok) return aggregations;
  const provenance = parseContractArray(
    response.provenance,
    parseEntityProvenance,
  );
  if (!provenance.ok) return provenance;
  const freshness = parseContractArray(
    response.freshness,
    parseResultFreshness,
  );
  if (!freshness.ok) return freshness;
  return {
    ok: true,
    value: {
      merchantRevision: response.merchantRevision,
      entities: entities.value,
      relationships: relationships.value,
      listEntries: listEntries.value,
      aggregations: aggregations.value,
      nextCursor: response.nextCursor ?? null,
      provenance: provenance.value,
      freshness: freshness.value,
    },
  };
}
export function parseCommerceEntityPlanePlannedQueryResponse(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlanePlannedQueryResponse> {
  const parsed = parseContract(responseWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  if (response.kind !== "planned") {
    const outcome = parseCommerceQueryPlanOutcome(response);
    if (!outcome.ok) return outcome;
    if (outcome.value.kind === "planned") return cursorRefusal("parse");
    return { ok: true, value: outcome.value };
  }
  const plan = parseCommerceQueryPlan(response.plan);
  if (!plan.ok) return plan;
  const result = parseCommerceGraphQueryResult(response.result);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      kind: response.kind,
      organisationId: response.organisationId,
      merchantId: response.merchantId,
      merchantRevision: response.merchantRevision,
      plan: plan.value,
      result: result.value,
      hasMore: response.hasMore,
    },
  };
}
export function parseEntityPlaneRelationshipTraversalStepResponse(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneRelationshipTraversalStepResponse> {
  const parsed = parseCommerceEntityPlanePlannedQueryResponse(input);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  if (response.kind !== "planned") return { ok: true, value: response };
  if (
    response.hasMore ||
    response.plan.operation.kind !== "relationship_traversal"
  )
    return cursorRefusal("invalid_query");
  return {
    ok: true,
    value: {
      kind: response.kind,
      organisationId: response.organisationId,
      merchantId: response.merchantId,
      merchantRevision: response.merchantRevision,
      plan: response.plan,
      result: response.result,
      hasMore: false,
    },
  };
}
