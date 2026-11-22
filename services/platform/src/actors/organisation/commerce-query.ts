import type {
  CommerceQueryPlan,
  CommerceGraphQueryPlanRequest,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceGraphQueryPlanRequest,
  parseCommerceSnapshotRevision,
} from "@purin-labs/commerce-client";
import type { CommerceSqliteRelationshipTraversalPlan } from "@purin-labs/commerce-query-sqlite";
import type { Result } from "@purin-labs/kernel/result";
import type { CommerceProjectionKind } from "../commerce-projection";
import {
  assertCommerceQueryPlanWithLexicon,
  planCommerceGraphQuery,
} from "../../commerce/commerce-wasm";
import type { CommerceQueryPlanReadError } from "./commerce-types";

export function commerceRelationshipTraversalPlan(
  plan: CommerceQueryPlan,
): CommerceSqliteRelationshipTraversalPlan | null {
  if (plan.operation.kind !== "relationship_traversal") return null;
  return {
    operation: plan.operation,
    queryFingerprint: plan.queryFingerprint,
    semanticsVersion: plan.semanticsVersion,
    orderingVersion: plan.orderingVersion,
    watermark: plan.watermark,
    effectiveOrdering: plan.effectiveOrdering,
    predicate: plan.predicate,
    projection: plan.projection,
    limit: plan.limit,
    boundary: plan.boundary,
  };
}

export function validateOrganisationCommercePlan(
  rawRequest: unknown,
  rawPlan: unknown,
  acceptedProjectionSequence: number,
): Result<CommerceQueryPlan, CommerceQueryPlanReadError> {
  let request: CommerceGraphQueryPlanRequest;
  let suppliedPlan: CommerceQueryPlan;
  try {
    request = parseCommerceGraphQueryPlanRequest(rawRequest);
    assertCommerceQueryPlanWithLexicon(rawPlan);
    suppliedPlan = rawPlan;
  } catch {
    return { ok: false, error: { code: "commerce_query_plan_invalid" } };
  }
  if (
    request.watermark.kind === "provider_backed" &&
    Number(request.watermark.blotterAcceptedProjectionSequence) !==
      acceptedProjectionSequence
  ) {
    const expectedSequence = parseCommerceSnapshotRevision(
      acceptedProjectionSequence,
      "acceptedProjectionSequence",
    );
    return {
      ok: false,
      error: {
        code: "commerce_query_plan_stale",
        expected: {
          ...request.watermark,
          blotterAcceptedProjectionSequence: expectedSequence,
        },
        received: request.watermark,
      },
    };
  }
  const planned = planCommerceGraphQuery(request);
  if (!planned.ok)
    return { ok: false, error: { code: "commerce_query_plan_invalid" } };
  if (planned.value.kind === "unsupported_query") {
    return {
      ok: false,
      error: {
        code: "commerce_query_plan_unsupported",
        capability: planned.value.capability,
      },
    };
  }
  if (planned.value.kind === "cursor_stale") {
    return {
      ok: false,
      error: {
        code: "commerce_query_plan_stale",
        expected: planned.value.expected,
        received: planned.value.received,
      },
    };
  }
  if (
    planned.value.kind !== "planned" ||
    !samePlan(planned.value.plan, suppliedPlan)
  ) {
    return { ok: false, error: { code: "commerce_query_plan_invalid" } };
  }
  return { ok: true, value: planned.value.plan };
}

// Plans carry i64 attribute values as bigints, which may exceed the JSON-safe
// range @purin-labs/std's sameJson enforces, so they compare as decimal text.
function samePlan(left: CommerceQueryPlan, right: CommerceQueryPlan): boolean {
  return planText(left) === planText(right);
}

function planText(plan: CommerceQueryPlan): string {
  return JSON.stringify(plan, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function parseCommerceQueryCount(
  rows: readonly Record<string, SqlStorageValue>[],
): bigint | null {
  if (rows.length !== 1) return null;
  const rawCount: unknown = rows[0]?.aggregate_count;
  if (typeof rawCount === "bigint") {
    return rawCount >= 0n ? rawCount : null;
  }
  return typeof rawCount === "number" &&
    Number.isSafeInteger(rawCount) &&
    rawCount >= 0
    ? BigInt(rawCount)
    : null;
}

export function commerceProjectionKindForRelationType(
  value: string,
): CommerceProjectionKind | null {
  switch (value) {
    case "order":
      return "commerce_order";
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "payment":
    case "fulfillment":
    case "shipment":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return value;
    default:
      return null;
  }
}
