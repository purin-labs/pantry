import {
  StrictObject,
  OpenObject,
  contractRefusal,
  parseContract,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { commerceGraphQueryWireSchema } from "./query-wire.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import {
  commerceGraphQuerySchema,
  type CommerceGraphQuery,
} from "./graph-query-schema.ts";
import { parseCommerceGraphQuery } from "./graph-query.ts";
import {
  commerceQueryCapabilityProfileSchema,
  parseCommerceQueryCapabilityProfile,
  profileWire,
} from "./query-capabilities.ts";
import {
  commerceQuerySemanticsV1Schema,
  commerceQueryProjectionSchema,
  parseCommerceQuerySemantics,
  parseCommerceQueryProjection,
  effectiveCommerceOrdering,
  normalizeCommercePredicate,
  projectionWire,
} from "./query-plan-parts.ts";
import {
  commerceQueryPlanSchema,
  parseCommerceQueryPlan,
  type CommerceQueryPlan,
} from "./query-plan.ts";
import {
  commerceReadWatermarkSchema,
  parseCommerceReadWatermark,
} from "./query-metadata.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { queryIdentitySchema, invalidShape } from "./query-parts.ts";

import {
  decodeCommerceCursor,
  type CommerceCursorBoundary,
} from "./cursor-payload.ts";
import { commerceQueryFingerprint } from "./query-encoders.ts";
import { constructCommerceQuery } from "./query-construction.ts";
import { unsupportedCommerceCapability } from "./query-support.ts";

const merchantIdSchema = queryIdentitySchema<"CommerceMerchantId">();
export const commerceGraphQueryPlanRequestSchema = StrictObject({
  query: Type.Unsafe<CommerceGraphQuery>(commerceGraphQuerySchema),
  semantics: commerceQuerySemanticsV1Schema,
  projection: commerceQueryProjectionSchema,
  organisationId: trimmedIdentityTextSchema,
  merchantId: merchantIdSchema,
  watermark: commerceReadWatermarkSchema,
  capabilities: commerceQueryCapabilityProfileSchema,
});
export type CommerceGraphQueryPlanRequest = Static<
  typeof commerceGraphQueryPlanRequestSchema
>;
export const commerceCursorMismatchReasonSchema = Type.Enum([
  "organisation",
  "merchant",
  "query_fingerprint",
  "semantics_version",
  "ordering_version",
  "watermark_kind",
  "effective_ordering",
]);
export const commerceQueryPlanErrorCapabilitySchema = Type.Union([
  OpenObject({ kind: Type.Literal("source_mapping") }),
  OpenObject({ kind: Type.Literal("all_entity_types_search") }),
  OpenObject({ kind: Type.Literal("attribute_filter") }),
  OpenObject({ kind: Type.Literal("attribute_sort") }),
  OpenObject({ kind: Type.Literal("grouped_aggregation") }),
  OpenObject({ kind: Type.Literal("sum_aggregation") }),
  OpenObject({ kind: Type.Literal("minimum_aggregation") }),
  OpenObject({ kind: Type.Literal("maximum_aggregation") }),
  OpenObject({ kind: Type.Literal("oldest_due_date_aggregation") }),
  OpenObject({ kind: Type.Literal("age_buckets_aggregation") }),
]);
export const commerceUnplannedQueryOutcomeSchemas = [
  OpenObject({
    kind: Type.Literal("cursor_mismatch"),
    reason: commerceCursorMismatchReasonSchema,
  }),
  OpenObject({
    kind: Type.Literal("cursor_stale"),
    expected: commerceReadWatermarkSchema,
    received: commerceReadWatermarkSchema,
  }),
  OpenObject({
    kind: Type.Literal("unsupported_query"),
    capability: commerceQueryPlanErrorCapabilitySchema,
  }),
  OpenObject({ kind: Type.Literal("invalid") }),
] as const;
export const commerceQueryPlanOutcomeSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("planned"),
    plan: Type.Unsafe<CommerceQueryPlan>(commerceQueryPlanSchema),
  }),
  ...commerceUnplannedQueryOutcomeSchemas,
]);
export type CommerceQueryPlanOutcome = StrictUnion<
  Static<typeof commerceQueryPlanOutcomeSchema>
>;
export type CommerceQueryPlanErrorCapability = StrictUnion<
  Static<typeof commerceQueryPlanErrorCapabilitySchema>
>;
export type CommerceCursorMismatchReason = Static<
  typeof commerceCursorMismatchReasonSchema
>;
const outcomeWire = Type.Union([
  OpenObject({ kind: Type.Literal("planned"), plan: Type.Unknown() }),
  ...commerceUnplannedQueryOutcomeSchemas,
]);
export function parseCommerceQueryPlanOutcome(
  input: unknown,
): ContractDecodeResult<CommerceQueryPlanOutcome> {
  const parsed = parseContract(outcomeWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const outcome = parsed.value;
  switch (outcome.kind) {
    case "planned": {
      const plan = parseCommerceQueryPlan(outcome.plan);
      if (!plan.ok) return plan;
      return { ok: true, value: { kind: outcome.kind, plan: plan.value } };
    }
    case "cursor_mismatch":
      return {
        ok: true,
        value: { kind: outcome.kind, reason: outcome.reason },
      };
    case "cursor_stale": {
      const expected = parseCommerceReadWatermark(outcome.expected);
      if (!expected.ok) return expected;
      const received = parseCommerceReadWatermark(outcome.received);
      if (!received.ok) return received;
      return {
        ok: true,
        value: {
          kind: outcome.kind,
          expected: expected.value,
          received: received.value,
        },
      };
    }
    case "unsupported_query":
      return {
        ok: true,
        value: {
          kind: outcome.kind,
          capability: { kind: outcome.capability.kind },
        },
      };
    case "invalid":
      return { ok: true, value: { kind: outcome.kind } };
    default:
      return assertNever(outcome);
  }
}
const requestWire = StrictObject({
  query: commerceGraphQueryWireSchema,
  semantics: commerceQuerySemanticsV1Schema,
  projection: projectionWire,
  organisationId: Type.String(),
  merchantId: Type.String(),
  watermark: commerceReadWatermarkSchema,
  capabilities: profileWire,
});
export function parseCommerceGraphQueryPlanRequest(
  input: unknown,
): ContractDecodeResult<CommerceGraphQueryPlanRequest> {
  const raw = parseContract(requestWire, input, invalidShape);
  if (!raw.ok) return raw;
  const request = raw.value;
  const query = parseCommerceGraphQuery(request.query);
  if (!query.ok) return query;
  const semantics = parseCommerceQuerySemantics(request.semantics);
  if (!semantics.ok) return semantics;
  const projection = parseCommerceQueryProjection(request.projection);
  if (!projection.ok) return projection;
  const organisationId = request.organisationId;
  if (!Value.Check(trimmedIdentityTextSchema, organisationId))
    return invalidIdentity("organisation_id");
  const merchantId = request.merchantId;
  if (!Value.Check(merchantIdSchema, merchantId))
    return invalidIdentity("CommerceMerchantId");
  const watermark = parseCommerceReadWatermark(request.watermark);
  if (!watermark.ok) return watermark;
  const capabilities = parseCommerceQueryCapabilityProfile(
    request.capabilities,
  );
  if (!capabilities.ok) return capabilities;
  return {
    ok: true,
    value: {
      query: query.value,
      semantics: semantics.value,
      projection: projection.value,
      organisationId,
      merchantId,
      watermark: watermark.value,
      capabilities: capabilities.value,
    },
  };
}
function invalidIdentity(field: string): ContractDecodeResult<never> {
  return contractRefusal({
    code: "invalid_identity",
    reason: "invalid planner identity",
    details: { field },
  });
}
/** The JSON request boundary preserves validation errors separately from planner outcomes. */
export function planCommerceGraphQuery(
  input: unknown,
): ContractDecodeResult<CommerceQueryPlanOutcome> {
  const parsed = parseCommerceGraphQueryPlanRequest(input);
  if (!parsed.ok) {
    if (parsed.error.code === "parse")
      return contractRefusal({
        code: "invalid_request",
        reason: parsed.error.reason,
        details: null,
      });
    return parsed;
  }
  return { ok: true, value: compileCommerceGraphQuery(parsed.value) };
}
function compileCommerceGraphQuery(
  request: CommerceGraphQueryPlanRequest,
): CommerceQueryPlanOutcome {
  const query = request.query;
  if (query.kind === "search" && query.entityTypeId === null)
    return {
      kind: "unsupported_query",
      capability: { kind: "all_entity_types_search" },
    };
  if (
    query.kind === "saved_commerce_view" &&
    (request.capabilities.kind !== "saved_commerce_view" ||
      query.viewId !== request.capabilities.viewId)
  )
    return {
      kind: "unsupported_query",
      capability: { kind: "source_mapping" },
    };
  const parts = constructCommerceQuery(query, request.capabilities);
  if (parts === null) return { kind: "invalid" };
  const unsupported = unsupportedCommerceCapability(
    parts.operation,
    parts.filter,
    parts.intent,
    request.capabilities,
  );
  if (unsupported !== null)
    return { kind: "unsupported_query", capability: unsupported };
  const predicate = normalizeCommercePredicate(parts.filter);
  const ordering = effectiveCommerceOrdering(parts.intent);
  if (!ordering.ok) return { kind: "invalid" };
  const fingerprint = commerceQueryFingerprint(query);
  let boundary: CommerceCursorBoundary | null = null;
  if (parts.cursor !== null) {
    const decoded = decodeCommerceCursor(parts.cursor);
    if (!decoded.ok) return { kind: "invalid" };
    const cursor = decoded.value;
    if (cursor.organisationId !== request.organisationId)
      return { kind: "cursor_mismatch", reason: "organisation" };
    if (cursor.merchantId !== request.merchantId)
      return { kind: "cursor_mismatch", reason: "merchant" };
    if (cursor.queryFingerprint !== fingerprint)
      return { kind: "cursor_mismatch", reason: "query_fingerprint" };
    if (cursor.semanticsVersion !== request.semantics.semanticsVersion)
      return { kind: "cursor_mismatch", reason: "semantics_version" };
    if (cursor.orderingVersion !== request.semantics.orderingVersion)
      return { kind: "cursor_mismatch", reason: "ordering_version" };
    if (cursor.watermark.kind !== request.watermark.kind)
      return { kind: "cursor_mismatch", reason: "watermark_kind" };
    if (
      canonicalJsonByCodePoint(cursor.effectiveOrdering) !==
      canonicalJsonByCodePoint(ordering.value)
    )
      return { kind: "cursor_mismatch", reason: "effective_ordering" };
    if (
      canonicalJsonByCodePoint(cursor.watermark) !==
      canonicalJsonByCodePoint(request.watermark)
    )
      return {
        kind: "cursor_stale",
        expected: request.watermark,
        received: cursor.watermark,
      };
    boundary = cursor.boundary;
  }
  const plan = parseCommerceQueryPlan({
    operation: parts.operation,
    queryFingerprint: fingerprint,
    semanticsVersion: request.semantics.semanticsVersion,
    orderingVersion: request.semantics.orderingVersion,
    watermark: request.watermark,
    effectiveOrdering: ordering.value,
    predicate,
    projection: request.projection,
    limit: parts.limit,
    boundary,
  });
  if (!plan.ok) return { kind: "invalid" };
  return { kind: "planned", plan: plan.value };
}
