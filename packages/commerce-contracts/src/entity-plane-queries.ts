import {
  OpenObject,
  parseContract,
  parseContractArray,
  type ContractDecodeResult,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import {
  commerceGraphQuerySchema,
  type CommerceGraphQuery,
} from "./graph-query-schema.ts";
import { parseCommerceGraphQuery } from "./graph-query.ts";
import {
  commerceEntityRefSchema,
  type CommerceEntityRef,
} from "./entity-reference.ts";
import {
  commerceReadWatermarkSchema,
  commerceSnapshotRevisionSchema,
  parseCommerceReadWatermark,
} from "./query-metadata.ts";
import {
  commerceQueryCapabilityProfileSchema,
  parseCommerceQueryCapabilityProfile,
  type CommerceQueryCapabilityProfile,
} from "./query-capabilities.ts";
import {
  commerceQueryProjectionSchema,
  parseCommerceQueryProjection,
} from "./query-plan-parts.ts";
import {
  commerceQueryPlanSchema,
  parseCommerceQueryPlan,
  type CommerceQueryPlan,
} from "./query-plan.ts";
import {
  commerceGraphQueryPlanRequestSchema,
  parseCommerceGraphQueryPlanRequest,
  type CommerceGraphQueryPlanRequest,
} from "./query-planner.ts";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";
import { queryIdentitySchema, invalidShape } from "./query-parts.ts";
import { parseEntityPlaneEntityReference } from "./entity-plane-resources.ts";
import { cursorRefusal } from "./cursor-values.ts";

const querySchema = Type.Unsafe<CommerceGraphQuery>(commerceGraphQuerySchema);
export const entityPlaneQueryRequestSchema = OpenObject({
  merchantId: javascriptTrimmedTextSchema,
  query: querySchema,
});
export type CommerceEntityPlaneQueryRequest = Readonly<
  StaticDecode<typeof entityPlaneQueryRequestSchema>
>;
export const entityPlaneCapabilityMetadataRequestSchema = OpenObject({
  organisationId: javascriptTrimmedTextSchema,
  ...entityPlaneQueryRequestSchema.properties,
});
export type CommerceEntityPlaneCapabilityMetadataRequest = Readonly<
  StaticDecode<typeof entityPlaneCapabilityMetadataRequestSchema>
>;
export const entityPlaneCapabilityMetadataResponseSchema = OpenObject({
  kind: Type.Literal("capability_metadata"),
  organisationId: javascriptTrimmedTextSchema,
  merchantId: queryIdentitySchema<"CommerceMerchantId">(),
  merchantRevision: commerceSnapshotRevisionSchema,
  watermark: commerceReadWatermarkSchema,
  capabilities: Type.Unsafe<CommerceQueryCapabilityProfile>(
    commerceQueryCapabilityProfileSchema,
  ),
  projection: commerceQueryProjectionSchema,
});
export type CommerceEntityPlaneCapabilityMetadataResponse = Readonly<
  StaticDecode<typeof entityPlaneCapabilityMetadataResponseSchema>
>;
export const entityPlaneRelationshipTraversalStepRequestSchema = OpenObject({
  organisationId: javascriptTrimmedTextSchema,
  merchantId: javascriptTrimmedTextSchema,
  planRequest: Type.Unsafe<CommerceGraphQueryPlanRequest>(
    commerceGraphQueryPlanRequestSchema,
  ),
  plan: Type.Unsafe<CommerceQueryPlan>(commerceQueryPlanSchema),
  frontier: Type.Unsafe<readonly CommerceEntityRef[]>(
    Type.Array(commerceEntityRefSchema, { minItems: 1, maxItems: 500 }),
  ),
  remaining: Type.Integer({ minimum: 1, maximum: 500 }),
});
export type CommerceEntityPlaneRelationshipTraversalStepRequest = Readonly<
  StaticDecode<typeof entityPlaneRelationshipTraversalStepRequestSchema>
>;
const queryRequestWire = OpenObject({
  merchantId: javascriptTrimmedTextSchema,
  query: Type.Unknown(),
});
const capabilityRequestWire = OpenObject({
  organisationId: javascriptTrimmedTextSchema,
  ...queryRequestWire.properties,
});
const capabilityResponseWire = OpenObject({
  ...entityPlaneCapabilityMetadataResponseSchema.properties,
  watermark: Type.Unknown(),
  capabilities: Type.Unknown(),
  projection: Type.Unknown(),
});
const traversalWire = OpenObject({
  ...entityPlaneRelationshipTraversalStepRequestSchema.properties,
  planRequest: Type.Unknown(),
  plan: Type.Unknown(),
  frontier: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 500 }),
});
const planRequestWire = OpenObject({
  ...commerceGraphQueryPlanRequestSchema.properties,
  query: Type.Unknown(),
  semantics: Type.Unknown(),
  projection: Type.Unknown(),
  watermark: Type.Unknown(),
  capabilities: Type.Unknown(),
});

export function parseEntityPlaneQueryRequest(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneQueryRequest> {
  const parsed = parseContract(queryRequestWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const query = parseCommerceGraphQuery(parsed.value.query);
  if (!query.ok) return query;
  return {
    ok: true,
    value: { merchantId: parsed.value.merchantId, query: query.value },
  };
}
export function parseEntityPlaneCapabilityMetadataRequest(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneCapabilityMetadataRequest> {
  const parsed = parseContract(capabilityRequestWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const query = parseCommerceGraphQuery(parsed.value.query);
  if (!query.ok) return query;
  return {
    ok: true,
    value: {
      organisationId: parsed.value.organisationId,
      merchantId: parsed.value.merchantId,
      query: query.value,
    },
  };
}
export function parseEntityPlaneCapabilityMetadataResponse(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneCapabilityMetadataResponse> {
  const parsed = parseContract(capabilityResponseWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  const watermark = parseCommerceReadWatermark(response.watermark);
  if (!watermark.ok) return watermark;
  const capabilities = parseCommerceQueryCapabilityProfile(
    response.capabilities,
  );
  if (!capabilities.ok) return capabilities;
  const projection = parseCommerceQueryProjection(response.projection);
  if (!projection.ok) return projection;
  return {
    ok: true,
    value: {
      kind: response.kind,
      organisationId: response.organisationId,
      merchantId: response.merchantId,
      merchantRevision: response.merchantRevision,
      watermark: watermark.value,
      capabilities: capabilities.value,
      projection: projection.value,
    },
  };
}
export function parseEntityPlaneGraphQueryPlanRequest(
  input: unknown,
): ContractDecodeResult<CommerceGraphQueryPlanRequest> {
  // The HTTP envelope ignores extra fields before the strict planner boundary.
  const parsed = parseContract(planRequestWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  return parseCommerceGraphQueryPlanRequest({
    query: request.query,
    semantics: request.semantics,
    projection: request.projection,
    organisationId: request.organisationId,
    merchantId: request.merchantId,
    watermark: request.watermark,
    capabilities: request.capabilities,
  });
}
export function parseEntityPlaneRelationshipTraversalStepRequest(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneRelationshipTraversalStepRequest> {
  const parsed = parseContract(traversalWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const planRequest = parseEntityPlaneGraphQueryPlanRequest(
    request.planRequest,
  );
  if (!planRequest.ok) return planRequest;
  if (
    planRequest.value.organisationId !== request.organisationId ||
    planRequest.value.merchantId !== request.merchantId
  )
    return cursorRefusal("authority_out_of_scope");
  const plan = parseCommerceQueryPlan(request.plan);
  if (!plan.ok) return plan;
  const frontier = parseContractArray(
    request.frontier,
    parseEntityPlaneEntityReference,
  );
  if (!frontier.ok) return frontier;
  return {
    ok: true,
    value: {
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      planRequest: planRequest.value,
      plan: plan.value,
      frontier: frontier.value,
      remaining: request.remaining,
    },
  };
}
