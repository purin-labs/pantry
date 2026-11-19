import type {
  CommerceEntityPlaneQueryRequest,
  CommerceEntityPlaneCapabilityMetadataRequest,
  CommerceEntityPlaneCapabilityMetadataResponse,
  CommerceEntityPlaneRelationshipTraversalStepRequest,
} from "@purin-labs/commerce-contracts/entity-plane-queries";
export type {
  CommerceEntityPlaneQueryRequest,
  CommerceEntityPlaneCapabilityMetadataRequest,
  CommerceEntityPlaneCapabilityMetadataResponse,
  CommerceEntityPlaneRelationshipTraversalStepRequest,
} from "@purin-labs/commerce-contracts/entity-plane-queries";
import type {
  CommerceCursor,
  CommerceCursorPayload,
  CommerceGraphQuery,
  CommerceGraphQueryPlanRequest,
  CommerceQueryPlanOutcome,
  PublishedCommerceSelector,
} from "@purin-labs/commerce-contracts";
import { parsePublishedCommerceSelector as parseSelectorContract } from "@purin-labs/commerce-contracts/graph-query";
import { decodeRecord } from "./record-decoding.ts";
import * as queryContracts from "@purin-labs/commerce-contracts/entity-plane-queries";
import * as plannerContracts from "@purin-labs/commerce-contracts/query-planner";
import { parseCommerceGraphQuery as parseQueryContract } from "@purin-labs/commerce-contracts/graph-query";
import { parseCommerceCursorPayload as parseCursorContract } from "@purin-labs/commerce-contracts/cursor-payload";

import { brandText } from "./primitives.ts";
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
