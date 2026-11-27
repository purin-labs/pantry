import {
  StrictObject,
  OpenObject,
  parseContract,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@purin-labs/std";

import { invalidShape, queryRefusal } from "./query-parts.ts";
import {
  commerceQueryPlanOperationSchema,
  parseCommerceQueryPlanOperation,
} from "./query-operation.ts";
import {
  commerceQueryFingerprintSchema,
  commerceQuerySemanticsVersionSchema,
  commerceOrderingVersionSchema,
  commerceReadWatermarkSchema,
  parseCommerceQueryFingerprint,
  parseCommerceReadWatermark,
} from "./query-metadata.ts";
import {
  commerceEffectiveOrderingSchema,
  parseCommerceEffectiveOrdering,
} from "./query-ordering.ts";
import {
  commerceNormalizedPredicateSchema,
  commerceQueryProjectionSchema,
  parseCommerceNormalizedPredicate,
  parseCommerceQueryProjection,
  type CommerceNormalizedPredicate,
} from "./query-plan-parts.ts";
import {
  commerceCursorBoundarySchema,
  parseCommerceCursorBoundary,
  type CommerceCursorBoundary,
} from "./cursor-payload.ts";

const commerceQueryLimitSchema = Type.Unsafe<
  number & { readonly __brand: "CommerceQueryLimit" }
>(Type.Integer({ minimum: 1, maximum: 500 }));
export const commerceQueryPlanSchema = StrictObject({
  operation: commerceQueryPlanOperationSchema,
  queryFingerprint: commerceQueryFingerprintSchema,
  semanticsVersion: commerceQuerySemanticsVersionSchema,
  orderingVersion: commerceOrderingVersionSchema,
  watermark: commerceReadWatermarkSchema,
  effectiveOrdering: commerceEffectiveOrderingSchema,
  predicate: Type.Unsafe<CommerceNormalizedPredicate>(
    commerceNormalizedPredicateSchema,
  ),
  projection: commerceQueryProjectionSchema,
  limit: commerceQueryLimitSchema,
  boundary: Type.Union([commerceCursorBoundarySchema, Type.Null()]),
});
export type CommerceQueryPlan = StaticDecode<typeof commerceQueryPlanSchema>;
const planWire = StrictObject({
  operation: Type.Unknown(),
  queryFingerprint: Type.String(),
  semanticsVersion: commerceQuerySemanticsVersionSchema,
  orderingVersion: commerceOrderingVersionSchema,
  watermark: Type.Unknown(),
  effectiveOrdering: Type.Unknown(),
  predicate: Type.Unknown(),
  projection: Type.Unknown(),
  limit: Type.Integer({ minimum: 0, maximum: 65535 }),
  boundary: Type.Optional(
    Type.Union([
      OpenObject({
        orderingValues: Type.Array(Type.Unknown()),
        entityRef: Type.Unknown(),
      }),
      Type.Null(),
    ]),
  ),
});
export function parseCommerceQueryPlan(
  input: unknown,
): ContractDecodeResult<CommerceQueryPlan> {
  const parsed = parseContract(planWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const plan = parsed.value;
  const operation = parseCommerceQueryPlanOperation(plan.operation);
  if (!operation.ok) return operation;
  const fingerprint = parseCommerceQueryFingerprint(plan.queryFingerprint);
  if (!fingerprint.ok) return fingerprint;
  const ordering = parseCommerceEffectiveOrdering(plan.effectiveOrdering);
  if (!ordering.ok) return ordering;
  const predicate = parseCommerceNormalizedPredicate(plan.predicate);
  if (!predicate.ok) return predicate;
  const projection = parseCommerceQueryProjection(plan.projection);
  if (!projection.ok) return projection;
  const limit = plan.limit;
  if (!Value.Check(commerceQueryLimitSchema, limit)) return queryRefusal();
  const watermark = parseCommerceReadWatermark(plan.watermark);
  if (!watermark.ok) return watermark;
  let boundary: CommerceCursorBoundary | null = null;
  if (plan.boundary !== null && plan.boundary !== undefined) {
    switch (operation.value.kind) {
      case "entity_type_page":
      case "commerce_list_page":
      case "saved_commerce_view":
      case "search":
        break;
      case "entity_by_ref":
      case "relationship_traversal":
      case "aggregation":
      case "commerce_context":
        return queryRefusal();
      default:
        return assertNever(operation.value);
    }
    const parsedBoundary = parseCommerceCursorBoundary(
      plan.boundary,
      ordering.value,
    );
    if (!parsedBoundary.ok) return parsedBoundary;
    boundary = parsedBoundary.value;
  }
  return {
    ok: true,
    value: {
      operation: operation.value,
      queryFingerprint: fingerprint.value,
      semanticsVersion: plan.semanticsVersion,
      orderingVersion: plan.orderingVersion,
      watermark: watermark.value,
      effectiveOrdering: ordering.value,
      predicate: predicate.value,
      projection: projection.value,
      limit,
      boundary,
    },
  };
}
