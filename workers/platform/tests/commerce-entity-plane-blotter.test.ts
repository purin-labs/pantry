import { describe, expect, it } from "vitest";

import type {
  CommerceGraphQueryPlanRequest,
  CommerceEntity,
  CommerceProjection,
  CommerceQueryCapabilityProfile,
  CommerceQueryPlan,
  SystemCommerceEntityKind,
  SystemCommerceEntityRef,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceGraphQueryPlanRequest,
  parseCommerceSnapshotRevision,
  parseSystemSchemaRevision,
} from "@purin-labs/commerce-client";
import { BlotterSource } from "@purin-labs/area-commerce/server/entity-plane/blotter-source";
import {
  buildCommerceGraphQueryPlanRequest,
  commerceGraphQueryProjection,
  planSafeCommerceQuery,
} from "@purin-labs/area-commerce/server/entity-plane/planner";
import { decodeCommerceCursor } from "@purin-labs/area-commerce/server/commerce-wasm";
import { parseCommerceGraphQuery } from "@purin-labs/area-commerce/server/entity-plane/routes";
import type {
  CommerceProjectionKind,
  CommerceProjectionRecord,
} from "@purin-labs/area-commerce/server/actors/commerce-projection";
import { planCommerceGraphQuery } from "@purin-labs/area-commerce/server/commerce-wasm";
import type { CommerceRelationshipRelationRow } from "@purin-labs/area-commerce/server/actors/commerce-query-schema";
import type { Variant } from "@purin-labs/type-utils";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";

describe("commerce entity-plane Blotter source", () => {
  it("mints a Lexicon cursor from the last retained relation row", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_blotter_cursor",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_graph_blotter_cursor",
    );
    const record = recordFor(
      fixture(
        "commerce_order",
        {
          buyer: { kind: "guest" },
          totals: { total: { amountMinor: 1200, currency: "JPY" } },
          lifecycle: { state: "open" },
        },
        "order_cursor",
      ),
      "order_cursor",
    );
    const query = parseCommerceGraphQuery({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 1, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 1 },
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    const planned = planSafeCommerceQuery({
      query: query.value,
      organisationId,
      merchantId: "merchant_graph_blotter_cursor",
      watermark: {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
          4,
          "blotterRevision",
        ),
        commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
          8,
          "commerceRevision",
        ),
      },
      capabilities: systemCapabilities("order"),
    });
    expect(planned.ok && planned.value.kind === "planned").toBe(true);
    if (!planned.ok || planned.value.kind !== "planned") return;
    const source = new BlotterSource({
      organisationId,
      merchantId: "merchant_graph_blotter_cursor",
      integrationAccountId,
      organisation: {
        readCommerceQueryPlan: async () => ({
          ok: true,
          value: {
            kind: "rows",
            rows: [
              {
                merchant_id: integrationAccountId,
                entity_origin: "system" as const,
                entity_type: "order",
                entity_id: "order_cursor",
                revision: record.revision,
                updated_at: record.updatedAt,
                display_name: "order_cursor",
                display_name_folded: "order_cursor",
                search_text_folded: "order_cursor",
                payload_json: JSON.stringify(record.projection),
              },
            ],
            records: [record],
            hasMore: true,
          },
        }),
        readAcceptedCommerceProjectionSequence: async () => ({
          ok: true,
          value: 4,
        }),
        readCommerceRelationshipStep: async () => ({ ok: true, value: [] }),
        readExactCommerceProjectionReference: async () => ({
          ok: true,
          value: null,
        }),
      },
    });

    const planRequest = parseCommerceGraphQueryPlanRequest({
      query: query.value,
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
      organisationId,
      merchantId: "merchant_graph_blotter_cursor",
      watermark: planned.value.plan.watermark,
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
    });
    const result = await source.queryPlan({
      planRequest,
      plan: planned.value.plan,
    });
    expect(result.ok && result.value.nextCursor !== null).toBe(true);
    if (!result.ok || result.value.nextCursor === null) return;
    const decoded = decodeCommerceCursor(result.value.nextCursor);
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        queryFingerprint: planned.value.plan.queryFingerprint,
        boundary: { entityRef: { entityId: "order_cursor" } },
        watermark: planned.value.plan.watermark,
      },
    });
  });

  it("returns a count aggregation without entity rows or a cursor", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_blotter_count",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_graph_blotter_count",
    );
    const planned = requiredPlannedCount(
      organisationId,
      "merchant_graph_blotter_count",
    );
    const source = new BlotterSource({
      organisationId,
      merchantId: "merchant_graph_blotter_count",
      integrationAccountId,
      organisation: {
        readCommerceQueryPlan: async () => ({
          ok: true,
          value: { kind: "count", aggregation: { kind: "count", value: 3n } },
        }),
        readAcceptedCommerceProjectionSequence: async () => ({
          ok: true,
          value: 0,
        }),
        readCommerceRelationshipStep: async () => ({ ok: true, value: [] }),
        readExactCommerceProjectionReference: async () => ({
          ok: true,
          value: null,
        }),
      },
    });

    const result = await source.queryPlan(planned);

    expect(result).toEqual({
      ok: true,
      value: {
        merchantRevision: null,
        entities: [],
        relationships: [],
        listEntries: [],
        aggregations: [{ kind: "count", value: 3n }],
        nextCursor: null,
        provenance: [],
        freshness: [],
      },
    });
  });

  it("hydrates one-hop relation rows returned by the shared traversal compiler", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_blotter_relationship",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_graph_blotter_relationship",
    );
    const planned = requiredPlannedRelationship(
      organisationId,
      "merchant_graph_blotter_relationship",
    );
    const plan = planned.plan;
    const frontier = requiredRelationshipFrontier(plan);
    const exactRecords = [
      recordFor(
        fixture(
          "commerce_order",
          {
            buyer: { kind: "guest" },
            totals: { total: { amountMinor: 1200, currency: "JPY" } },
            lifecycle: { state: "open" },
          },
          "order_1",
        ),
        "order_1",
      ),
      recordFor(
        fixture(
          "shipment",
          { lifecycle: { state: "in_transit" } },
          "shipment_1",
        ),
        "shipment_1",
      ),
    ];
    const row: CommerceRelationshipRelationRow = {
      merchant_id: integrationAccountId,
      relationship_origin: "system",
      relationship_id: "system:order_shipment:order_1:shipment_1",
      relationship_revision: 3,
      definition_origin: "system",
      definition_id: "order_shipment",
      definition_revision: 1,
      sensitivity: "internal",
      source_origin: "system",
      source_type_id: "order",
      source_entity_id: "order_1",
      target_origin: "system",
      target_type_id: "shipment",
      target_entity_id: "shipment_1",
      payload_json: JSON.stringify({
        relationshipId: "system:order_shipment:order_1:shipment_1",
        relationshipRevision: 3,
      }),
      provenance_json: JSON.stringify({
        organisationId,
        integrationAccountId,
        source: "shopify",
        resourceType: "commerce_order",
        resourceId: "order_1",
        revision: 3,
        occurredAt: "2026-08-25T14:00:00.000Z",
        observedAt: "2026-08-25T14:00:00.000Z",
      }),
    };
    const source = new BlotterSource({
      organisationId,
      merchantId: "merchant_graph_blotter_relationship",
      integrationAccountId,
      organisation: {
        readCommerceQueryPlan: async () => ({
          ok: true,
          value: { kind: "rows", rows: [], records: [], hasMore: false },
        }),
        readAcceptedCommerceProjectionSequence: async () => ({
          ok: true,
          value: 0,
        }),
        readCommerceRelationshipStep: async (input) => {
          expect(input.plan).toEqual(plan);
          expect(input.frontier).toEqual(frontier);
          expect(input.remaining).toBe(10);
          return { ok: true, value: [row] };
        },
        readExactCommerceProjectionReference: async (input) => ({
          ok: true,
          value:
            exactRecords.find(
              (record) => record.canonicalId === input.canonicalId,
            ) ?? null,
        }),
      },
    });

    const result = await source.readRelationshipStep({
      planRequest: planned.planRequest,
      plan,
      frontier,
      remaining: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relationships).toHaveLength(1);
    expect(result.value.relationships[0]).toMatchObject({
      relationshipId: "system:order_shipment:order_1:shipment_1",
      definition: { definitionId: "order_shipment", revision: 1 },
      source: { typeId: "order", entityId: "order_1" },
      target: { typeId: "shipment", entityId: "shipment_1" },
      revision: 3,
    });
  });

  it("maps every retained projection branch to a system entity and known canonical edges", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_blotter_parity",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_graph_blotter_parity",
    );
    const records = projectionFixtures();
    const planned = requiredPlannedPage(
      organisationId,
      "merchant_graph_blotter_parity",
      "product",
    );
    const source = new BlotterSource({
      organisationId,
      merchantId: "merchant_graph_blotter_parity",
      integrationAccountId,
      organisation: {
        readCommerceQueryPlan: async () => ({
          ok: true,
          value: { kind: "rows", rows: [], records, hasMore: false },
        }),
        readAcceptedCommerceProjectionSequence: async () => ({
          ok: true,
          value: 0,
        }),
        readCommerceRelationshipStep: async () => ({ ok: true, value: [] }),
        readExactCommerceProjectionReference: async () => ({
          ok: true,
          value: null,
        }),
      },
      now: () => Date.parse("2026-08-25T15:00:00.000Z"),
    });

    const result = await source.queryPlan(planned);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(20);
    expect(
      new Set(result.value.entities.map((entity) => entity.reference.typeId)),
    ).toEqual(
      new Set([
        "product",
        "sellable_variant",
        "inventory_item",
        "location",
        "sales_channel",
        "offer",
        "inventory_position",
        "inventory_movement",
        "inventory_lot",
        "order",
        "payment",
        "fulfillment",
        "shipment",
        "menu",
        "modifier_group_revision",
        "recipe_revision",
        "preparation_station",
        "preparation_ticket",
        "production_batch",
        "stock_policy",
      ]),
    );
    expect(
      result.value.relationships.map(
        (relationship) => relationship.definition.definitionId,
      ),
    ).toEqual(
      expect.arrayContaining([
        "order_fulfillment",
        "order_shipment",
        "fulfillment_shipment",
        "recipe_revision_production_batch",
      ]),
    );
    expect(
      result.value.relationships.some(
        (relationship) =>
          relationship.definition.definitionId === "shipment_production_batch",
      ),
    ).toBe(true);
    expect(result.value.freshness).toHaveLength(20);
    expect(result.value.freshness).toEqual(
      expect.arrayContaining([
        {
          state: "stale",
          observedAt: "2026-08-25T14:00:00.000Z",
          staleSince: "2026-08-25T14:15:00.000Z",
        },
      ]),
    );
    expect(
      findEntityByType(result.value.entities, "fulfillment")?.attributes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributeId: "order_id",
          value: { kind: "short_text", value: "order_1" },
        }),
        expect.objectContaining({
          attributeId: "expected_by",
          value: { kind: "timestamp", value: "2026-08-26T00:00:00.000Z" },
        }),
      ]),
    );
    expect(
      findEntityByType(result.value.entities, "shipment")?.attributes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributeId: "order_id",
          value: { kind: "short_text", value: "order_1" },
        }),
        expect.objectContaining({
          attributeId: "fulfillment_id",
          value: { kind: "short_text", value: "fulfillment_1" },
        }),
        expect.objectContaining({
          attributeId: "tracking_number",
          value: { kind: "short_text", value: "JP123456789" },
        }),
      ]),
    );
  });
});

function requiredPlannedRelationship(
  organisationId: ReturnType<typeof requireOrganisationId>,
  merchantId: string,
): { plan: CommerceQueryPlan; planRequest: CommerceGraphQueryPlanRequest } {
  const query = parseCommerceGraphQuery({
    kind: "relationship_traversal",
    seeds: [{ origin: "system", typeId: "shipment", entityId: "shipment_1" }],
    relationshipDefinition: {
      origin: "system",
      definitionId: "order_shipment",
      revision: 1,
    },
    traversal: { maxDepth: 1, resultLimit: 10 },
    filter: null,
  });
  if (!query.ok || query.value.kind !== "relationship_traversal")
    throw new Error("invalid relationship query fixture");
  const request = parseCommerceGraphQueryPlanRequest({
    query: query.value,
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
    organisationId,
    merchantId,
    watermark: {
      kind: "provider_backed",
      blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
        1,
        "blotterRevision",
      ),
      commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
        1,
        "commerceRevision",
      ),
    },
    capabilities: {
      kind: "system_mapped",
      systemEntityKind: "shipment",
      systemSchemaRevision: 1,
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" },
      },
    },
  });
  const planned = planCommerceGraphQuery(request);
  if (!planned.ok || planned.value.kind !== "planned")
    throw new Error("Lexicon did not plan relationship fixture");
  return { plan: planned.value.plan, planRequest: request };
}

function requiredRelationshipFrontier(
  plan: CommerceQueryPlan,
): readonly SystemCommerceEntityRef[] {
  if (plan.operation.kind !== "relationship_traversal")
    throw new Error("relationship plan operation missing");
  const seed = plan.operation.seeds[0];
  if (seed === undefined || seed.origin !== "system")
    throw new Error("system relationship seed missing");
  return [seed];
}

function requiredPlannedPage(
  organisationId: ReturnType<typeof requireOrganisationId>,
  merchantId: string,
  typeId: import("@purin-labs/commerce-contracts").SystemCommerceEntityKind,
): { plan: CommerceQueryPlan; planRequest: CommerceGraphQueryPlanRequest } {
  const query = parseCommerceGraphQuery({
    kind: "entity_type_page",
    entityTypeId: { origin: "system", typeId },
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 100, cursor: null },
    traversal: { maxDepth: 0, resultLimit: 100 },
  });
  if (!query.ok) throw new Error("invalid planned page fixture");
  const planRequest = buildCommerceGraphQueryPlanRequest({
    query: query.value,
    organisationId,
    merchantId,
    watermark: {
      kind: "provider_backed",
      blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
        1,
        "blotterRevision",
      ),
      commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
        1,
        "commerceRevision",
      ),
    },
    capabilities: systemCapabilities(typeId),
    projection: commerceGraphQueryProjection(query.value),
  });
  if (!planRequest.ok) throw new Error(planRequest.error.code);
  const planned = planCommerceGraphQuery(planRequest.value);
  if (!planned.ok || planned.value.kind !== "planned")
    throw new Error("Lexicon did not plan the page fixture");
  return { plan: planned.value.plan, planRequest: planRequest.value };
}

function systemCapabilities(
  systemEntityKind: SystemCommerceEntityKind,
): CommerceQueryCapabilityProfile {
  return {
    kind: "system_mapped",
    systemEntityKind,
    systemSchemaRevision: parseSystemSchemaRevision(1),
    capability: {
      filterableAttributeIds: [],
      sortableAttributeIds: [],
      aggregation: { kind: "count_only" },
    },
  };
}

function requiredPlannedCount(
  organisationId: ReturnType<typeof requireOrganisationId>,
  merchantId: string,
): { plan: CommerceQueryPlan; planRequest: CommerceGraphQueryPlanRequest } {
  const query = parseCommerceGraphQuery({
    kind: "aggregation",
    source: {
      kind: "entity_type",
      entityTypeId: { origin: "system", typeId: "order" },
    },
    filter: { kind: "all" },
    aggregation: { kind: "count" },
  });
  if (!query.ok) throw new Error("invalid planned count fixture");
  const planRequest = buildCommerceGraphQueryPlanRequest({
    query: query.value,
    organisationId,
    merchantId,
    watermark: {
      kind: "provider_backed",
      blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
        1,
        "blotterRevision",
      ),
      commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
        1,
        "commerceRevision",
      ),
    },
    capabilities: systemCapabilities("order"),
    projection: commerceGraphQueryProjection(query.value),
  });
  if (!planRequest.ok) throw new Error(planRequest.error.code);
  const planned = planCommerceGraphQuery(planRequest.value);
  if (!planned.ok || planned.value.kind !== "planned")
    throw new Error("Lexicon did not plan the count fixture");
  return { plan: planned.value.plan, planRequest: planRequest.value };
}

function projectionFixtures(): readonly CommerceProjectionRecord[] {
  const provenance = {
    organisationId: "organisation_graph_blotter_parity",
    integrationAccountId: "integration_graph_blotter_parity",
    source: "shopify",
    resourceType: "product",
    resourceId: "resource",
    revision: 1,
    occurredAt: "2026-08-25T14:00:00.000Z",
    observedAt: "2026-08-25T14:00:00.000Z",
  };
  return [
    fixture("product", { title: "Product", description: "" }),
    fixture("sellable_variant", {
      title: "Variant",
      sku: "SKU",
      productId: "product_1",
    }),
    fixture("inventory_item", {
      name: "Inventory",
      merchantCode: "INV",
      lifecycle: { state: "active" },
    }),
    fixture("location", { name: "Location", lifecycle: { state: "active" } }),
    fixture("sales_channel", {
      name: "Channel",
      lifecycle: { state: "active" },
    }),
    fixture("offer", { lifecycle: { state: "listed" } }),
    fixture("inventory_position", {}),
    fixture("inventory_movement", {}),
    fixture("inventory_lot", {
      lotCode: "LOT",
      lifecycle: { state: "active" },
    }),
    fixture(
      "commerce_order",
      {
        buyer: { kind: "guest" },
        totals: { total: { amountMinor: 1200, currency: "JPY" } },
        lifecycle: { state: "open" },
      },
      "order_1",
    ),
    fixture("payment", {
      orderId: "order_1",
      lifecycle: { state: "captured" },
    }),
    fixture(
      "fulfillment",
      {
        kind: "shipping",
        orderId: "order_1",
        lineItems: [],
        locationId: "location_1",
        expectedBy: "2026-08-26T00:00:00.000Z",
        binding: { kind: "external", sourceReference: "fulfillment_1" },
        lifecycle: {
          state: "requested",
          requestedAt: "2026-08-25T14:00:00.000Z",
        },
      },
      "fulfillment_1",
    ),
    fixture(
      "shipment",
      {
        kind: "first_party",
        orderId: "order_1",
        fulfillmentId: "fulfillment_1",
        package: {
          packageId: "package_1",
          weight: { grams: 100 },
          dimensions: {
            lengthMillimeters: 100,
            widthMillimeters: 100,
            heightMillimeters: 100,
          },
          lineQuantities: [],
          customsLines: [],
        },
        lifecycle: {
          state: "label_purchased",
          labelAttemptId: "label_attempt_1",
          trackingNumber: "JP123456789",
          purchasedAt: "2026-08-25T14:00:00.000Z",
        },
        events: [],
      },
      "shipment_1",
    ),
    fixture("menu", { name: "Menu", lifecycle: { state: "active" } }),
    fixture("modifier_group_revision", { lifecycle: { state: "active" } }),
    fixture("recipe_revision", { lifecycle: { state: "active" } }),
    fixture("preparation_station", { lifecycle: "active" }),
    fixture("preparation_ticket", { lifecycle: { state: "pending" } }),
    fixture("production_batch", {
      recipeId: "recipe_1",
      demand: { kind: "shipment", shipmentId: "shipment_1" },
    }),
    fixture("stock_policy", { lifecycle: { state: "active" } }),
  ].map((projection, index) => ({
    organisationId: "organisation_graph_blotter_parity",
    kind: projection.kind,
    canonicalId:
      projection.kind === "commerce_order"
        ? "order_1"
        : projection.kind === "fulfillment"
          ? "fulfillment_1"
          : projection.kind === "shipment"
            ? "shipment_1"
            : `${projection.kind}_${index}`,
    integrationAccountId: "integration_graph_blotter_parity",
    revision: 1,
    lifecycle: "active",
    projection: {
      ...projection,
      projection: {
        ...projection.projection,
        provenance: {
          ...provenance,
          resourceType:
            projection.kind === "commerce_order"
              ? "commerce_order"
              : projection.kind,
          resourceId:
            projection.kind === "commerce_order"
              ? "order_1"
              : projection.kind === "fulfillment"
                ? "fulfillment_1"
                : projection.kind === "shipment"
                  ? "shipment_1"
                  : `${projection.kind}_${index}`,
        },
      },
    },
    updatedAt: 1,
    validatedAt: 1,
    labRunId: null,
  })) as unknown as readonly CommerceProjectionRecord[];
}

function fixture(
  kind: CommerceProjectionKind,
  projection: Record<string, unknown>,
  canonicalId?: string,
): Variant<CommerceProjection, CommerceProjectionKind> {
  return {
    kind,
    projection: {
      ...projection,
      provenance: { resourceId: canonicalId ?? `${kind}_1` },
    },
  } as unknown as Variant<CommerceProjection, CommerceProjectionKind>;
}

function recordFor(
  projection: Variant<CommerceProjection, CommerceProjectionKind>,
  canonicalId: string,
): CommerceProjectionRecord {
  return {
    organisationId: "organisation_graph_blotter_aggregation",
    kind: projection.kind,
    canonicalId,
    integrationAccountId: "integration_graph_blotter_aggregation",
    revision: 1,
    lifecycle: "active",
    projection: {
      ...projection,
      projection: {
        ...projection.projection,
        provenance: {
          ...projection.projection.provenance,
          organisationId: "organisation_graph_blotter_aggregation",
          integrationAccountId: "integration_graph_blotter_aggregation",
          source: "shopify",
          resourceType: projection.kind,
          resourceId: canonicalId,
          revision: 1,
          occurredAt: "2026-08-25T14:00:00.000Z",
          observedAt: "2026-08-25T14:00:00.000Z",
        },
      },
    },
    updatedAt: 1,
    validatedAt: 1,
    labRunId: null,
  } as unknown as CommerceProjectionRecord;
}

function findEntityByType(
  entities: readonly CommerceEntity[],
  typeId: SystemCommerceEntityKind,
): CommerceEntity | undefined {
  return entities.find(entityHasType.bind(null, typeId));
}

function entityHasType(
  typeId: SystemCommerceEntityKind,
  entity: CommerceEntity,
): boolean {
  return (
    entity.reference.origin === "system" && entity.reference.typeId === typeId
  );
}
