import { describe, expect, it } from "vitest";

import {
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseSystemSchemaRevision,
  type CommerceEntityPlaneFetch,
} from "@purin-labs/commerce-client";
import type {
  CommerceEntityRef,
  CommerceReadWatermark,
} from "@purin-labs/commerce-contracts";
import { CommerceEngineSource } from "../src/commerce/entity-plane/commerce-source";
import {
  buildCommerceGraphQueryPlanRequest,
  commerceGraphQueryProjection,
} from "../src/commerce/entity-plane/planner";
import { planCommerceGraphQuery } from "../src/commerce/commerce-wasm";

describe("commerce entity-plane Underclerk source", () => {
  it.each([
    [
      "authority",
      { organisationId: "other_organisation" },
      "Underclerk capability metadata authority mismatch",
    ],
    [
      "watermark",
      { watermark: { kind: "underclerk_native", merchantRevision: 3 } },
      "Underclerk capability metadata watermark mismatch",
    ],
  ] as const)(
    "rejects capability metadata with a mismatched %s",
    async (_mismatch, override, message) => {
      const query = parseCommerceGraphQuery({
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "order" },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 10 },
      });
      const client = new CommerceEntityPlaneClient({
        baseUrl: "https://underclerk.example",
        serviceToken: "service-token",
        fetch: async () =>
          new Response(
            JSON.stringify({
              kind: "capability_metadata",
              organisationId: "organisation_source",
              merchantId: "merchant_source",
              merchantRevision: 4,
              watermark: { kind: "underclerk_native", merchantRevision: 4 },
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
              projection: {
                attributeIds: [],
                relationshipDefinitions: [],
                includeProvenance: true,
                includeFreshness: true,
              },
              ...override,
            }),
            { headers: { "content-type": "application/json" } },
          ),
      });
      const source = new CommerceEngineSource({
        organisationId: "organisation_source",
        merchantId: "merchant_source",
        integrationAccountId: "integration_source",
        client,
      });
      expect(await source.readCapabilityMetadata(query)).toEqual({
        ok: false,
        error: { code: "source_invalid", source: "underclerk", message },
      });
    },
  );

  it("rejects malformed capability profiles at the client parser boundary", async () => {
    const query = parseCommerceGraphQuery({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 10, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 10 },
    });
    const client = new CommerceEntityPlaneClient({
      baseUrl: "https://underclerk.example",
      serviceToken: "service-token",
      fetch: async () =>
        new Response(
          JSON.stringify({
            kind: "capability_metadata",
            organisationId: "organisation_source",
            merchantId: "merchant_source",
            merchantRevision: 4,
            watermark: { kind: "underclerk_native", merchantRevision: 4 },
            capabilities: { kind: "system_mapped", systemEntityKind: "order" },
            projection: {
              attributeIds: [],
              relationshipDefinitions: [],
              includeProvenance: true,
              includeFreshness: true,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const source = new CommerceEngineSource({
      organisationId: "organisation_source",
      merchantId: "merchant_source",
      integrationAccountId: "integration_source",
      client,
    });
    expect(await source.readCapabilityMetadata(query)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "source_invalid",
        source: "underclerk",
      }),
    });
  });

  it("hydrates system extensions through the sidecar boundary without reading a canonical row", async () => {
    const requests: Request[] = [];
    const fetcher: CommerceEntityPlaneFetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          merchantId: "merchant_source",
          merchantRevision: 4,
          sidecars: [
            {
              entityRef: {
                origin: "system",
                typeId: "order",
                entityId: "order_1",
              },
              extension: { state: "absent" },
              attributes: [],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const client = new CommerceEntityPlaneClient({
      baseUrl: "https://underclerk.example",
      serviceToken: "service-token",
      fetch: fetcher,
    });
    const source = new CommerceEngineSource({
      organisationId: "organisation_source",
      merchantId: "merchant_source",
      integrationAccountId: "integration_source",
      client,
    });

    const result = await source.hydrateEntityExtensions([
      systemEntityRef("order_1"),
    ]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        merchantRevision: 4,
        sidecars: [
          {
            entityRef: {
              origin: "system",
              typeId: "order",
              entityId: "order_1",
            },
            attributes: [],
            extensionSchemaRevision: null,
          },
        ],
      },
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "https://invalid").pathname).toBe(
      "/v1/internal/merchants/merchant_source/entity-plane/system-extensions",
    );
    expect(await requests[0]?.json()).toEqual({
      organisationId: "organisation_source",
      merchantId: "merchant_source",
      entityRefs: [{ origin: "system", typeId: "order", entityId: "order_1" }],
    });
  });

  it("sends one authoritative plan request for a native relationship step", async () => {
    const planned = requiredRelationshipPlan({
      kind: "underclerk_native",
      merchantRevision: parseCommerceSnapshotRevision(1, "merchantRevision"),
    });
    const requests: Request[] = [];
    const fetcher: CommerceEntityPlaneFetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          kind: "planned",
          organisationId: "organisation_source",
          merchantId: "merchant_source",
          merchantRevision: 1,
          plan: planned.plan,
          result: emptyResponse(),
          hasMore: false,
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const source = new CommerceEngineSource({
      organisationId: "organisation_source",
      merchantId: "merchant_source",
      integrationAccountId: "integration_source",
      client: new CommerceEntityPlaneClient({
        baseUrl: "https://underclerk.example",
        serviceToken: "service-token",
        fetch: fetcher,
      }),
    });
    const result = await source.readRelationshipStep({
      planRequest: planned.planRequest,
      plan: planned.plan,
      frontier: planned.frontier,
      remaining: 10,
    });
    expect(result).toEqual({
      ok: true,
      value: { ...emptyResponse(), merchantRevision: 1 },
    });
    expect(await requests[0]?.json()).toMatchObject({
      planRequest: planned.planRequest,
      plan: planned.plan,
      frontier: planned.frontier,
      remaining: 10,
    });
  });

  it("rejects system facts returned by Underclerk for a provider-backed relationship step", async () => {
    const planned = requiredRelationshipPlan({
      kind: "provider_backed",
      blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
        2,
        "blotterRevision",
      ),
      underclerkExtensionMerchantRevision: parseCommerceSnapshotRevision(
        1,
        "merchantRevision",
      ),
    });
    const fetcher: CommerceEntityPlaneFetch = async () =>
      new Response(
        JSON.stringify({
          kind: "planned",
          organisationId: "organisation_source",
          merchantId: "merchant_source",
          merchantRevision: 1,
          plan: planned.plan,
          result: {
            ...emptyResponse(),
            entities: [
              {
                reference: {
                  origin: "system",
                  typeId: "shipment",
                  entityId: "shipment_1",
                },
                revision: 1,
                displayName: "forged",
                attributes: [],
                provenance: {
                  organisationId: "organisation_source",
                  integrationAccountId: "integration_source",
                  source: "underclerk",
                  resourceType: "shipment",
                  resourceId: "shipment_1",
                  revision: 1,
                  occurredAt: "2026-08-25T00:00:00.000Z",
                  observedAt: "2026-08-25T00:00:00.000Z",
                },
                freshness: {
                  state: "current",
                  observedAt: "2026-08-25T00:00:00.000Z",
                },
              },
            ],
          },
          hasMore: false,
        }),
        { headers: { "content-type": "application/json" } },
      );
    const source = new CommerceEngineSource({
      organisationId: "organisation_source",
      merchantId: "merchant_source",
      integrationAccountId: "integration_source",
      client: new CommerceEntityPlaneClient({
        baseUrl: "https://underclerk.example",
        serviceToken: "service-token",
        fetch: fetcher,
      }),
    });
    const result = await source.readRelationshipStep({
      planRequest: planned.planRequest,
      plan: planned.plan,
      frontier: planned.frontier,
      remaining: 10,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "source_invalid",
        source: "underclerk",
        message:
          "Provider-backed Underclerk relationship step returned system-owned facts",
      },
    });
  });
});

function emptyResponse() {
  return {
    merchantRevision: 1,
    entities: [],
    relationships: [],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  };
}

function systemEntityRef(entityId: string): CommerceEntityRef {
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "system", typeId: "order", entityId },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  if (query.kind !== "entity_by_ref")
    throw new Error("system entity reference fixture changed shape");
  return query.reference;
}

function requiredRelationshipPlan(watermark: CommerceReadWatermark) {
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
  const request = buildCommerceGraphQueryPlanRequest({
    query,
    organisationId: "organisation_source",
    merchantId: "merchant_source",
    watermark,
    capabilities: {
      kind: "system_mapped",
      systemEntityKind: "shipment",
      systemSchemaRevision: parseSystemSchemaRevision(1),
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" },
      },
    },
    projection: commerceGraphQueryProjection(query),
  });
  if (!request.ok) throw new Error(request.error.code);
  const outcome = planCommerceGraphQuery(request.value);
  if (
    !outcome.ok ||
    outcome.value.kind !== "planned" ||
    outcome.value.plan.operation.kind !== "relationship_traversal"
  )
    throw new Error("relationship plan fixture is invalid");
  const seed = outcome.value.plan.operation.seeds[0];
  if (seed === undefined)
    throw new Error("relationship plan fixture has no seed");
  return {
    planRequest: request.value,
    plan: outcome.value.plan,
    frontier: [seed],
  };
}
