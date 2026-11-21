import { describe, expect, it } from "vitest";

import {
  decodeCommerceCursor,
  encodeCommerceCursor,
  planCommerceGraphQuery,
} from "../src/commerce/commerce-wasm";

describe("commerce query WASM boundary", function commerceQueryWasmSuite() {
  it("returns the Rust planner outcome and round-trips its cursor codec", function validPlannerOutput() {
    const firstPage = planCommerceGraphQuery(createPlannerRequest(1));

    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok || firstPage.value.kind !== "planned") {
      throw new Error("the first page must compile");
    }

    const cursor = encodeCommerceCursor(
      createCursorPayload(firstPage.value.plan),
    );
    if (!cursor.ok) {
      throw new Error(JSON.stringify(cursor.error));
    }
    expect(cursor.ok).toBe(true);

    const decoded = decodeCommerceCursor(cursor.value);
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        organisationId: "organisation_1",
        merchantId: "merchant_1",
        queryFingerprint: firstPage.value.plan.queryFingerprint,
      },
    });
  });

  it("rejects malformed planner requests before crossing the byte boundary", function malformedPlannerRequest() {
    expect(planCommerceGraphQuery({ query: {} })).toEqual({
      ok: false,
      error: { code: "commerce_wasm_input_invalid" },
    });
  });

  it("returns Rust cursor mismatch and stale outcomes", function cursorSafetyOutcomes() {
    const firstPage = planCommerceGraphQuery(createPlannerRequest(1));
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok || firstPage.value.kind !== "planned") {
      throw new Error("the first page must compile");
    }

    const cursor = encodeCommerceCursor(
      createCursorPayload(firstPage.value.plan),
    );
    if (!cursor.ok) {
      throw new Error(JSON.stringify(cursor.error));
    }
    expect(cursor.ok).toBe(true);

    const changedQuery = planCommerceGraphQuery(
      createPlannerRequest(1, cursor.value, 24),
    );
    expect(changedQuery).toEqual({
      ok: true,
      value: { kind: "cursor_mismatch", reason: "query_fingerprint" },
    });

    const changedWatermark = planCommerceGraphQuery(
      createPlannerRequest(2, cursor.value),
    );
    expect(changedWatermark).toMatchObject({
      ok: true,
      value: {
        kind: "cursor_stale",
        expected: { kind: "commerce_native", merchantRevision: 2 },
        received: { kind: "commerce_native", merchantRevision: 1 },
      },
    });
  });
});

function createPlannerRequest(
  watermarkRevision: number,
  cursor?: string,
  limit = 25,
): unknown {
  return {
    query: {
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit, cursor: cursor ?? null },
      traversal: { maxDepth: 0, resultLimit: limit },
    },
    semantics: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
    projection: {
      attributeIds: [],
      relationshipDefinitions: [],
      includeProvenance: true,
      includeFreshness: true,
    },
    organisationId: "organisation_1",
    merchantId: "merchant_1",
    watermark: {
      kind: "commerce_native",
      merchantRevision: watermarkRevision,
    },
    capabilities: {
      kind: "system_mapped",
      systemEntityKind: "order",
      systemSchemaRevision: 1,
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" },
      },
    },
  };
}

function createCursorPayload(plan: {
  readonly queryFingerprint: string;
  readonly semanticsVersion: string;
  readonly orderingVersion: string;
  readonly effectiveOrdering: {
    readonly leadingKeys: readonly unknown[];
    readonly tieBreaker: unknown;
  };
  readonly watermark: unknown;
}): unknown {
  return {
    organisationId: "organisation_1",
    merchantId: "merchant_1",
    queryFingerprint: plan.queryFingerprint,
    semanticsVersion: plan.semanticsVersion,
    orderingVersion: plan.orderingVersion,
    effectiveOrdering: plan.effectiveOrdering,
    boundary: {
      orderingValues: plan.effectiveOrdering.leadingKeys.map(() => ({
        kind: "null",
      })),
      entityRef: {
        origin: "system",
        typeId: "order",
        entityId: "order_1",
      },
    },
    watermark: plan.watermark,
  };
}
