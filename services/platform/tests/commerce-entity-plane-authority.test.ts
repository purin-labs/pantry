import { describe, expect, it } from "vitest";
import {
  parseCommerceGraphQuery,
  parseCommerceGraphResponse,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCapabilityMetadataResponse,
} from "@purin-labs/commerce-client";

import {
  buildSavedSelectorCommerceReadAuthority,
  filterCommerceGraphSensitivity,
  type CommerceGraphReadAuthority,
} from "../src/commerce/entity-plane/authority";
import {
  CommerceGraphReader,
  type CommerceGraphBlotterSource,
  type CommerceGraphHydratingSource,
  type CommerceGraphSource,
  type CommerceGraphCommerceSource,
} from "../src/commerce/entity-plane/graph-reader";
import type {
  CommerceGraphPlannedSourceResult,
  CommerceGraphSourceResult,
} from "../src/commerce/entity-plane/commerce-source";
import { planCommerceGraphQuery } from "../src/commerce/commerce-wasm";
import { commerceGraphQueryProjection } from "../src/commerce/entity-plane/planner";
import type {
  AttributeDefinitionId,
  AttributeDefinitionRevision,
  CommerceEntityTypeId,
  CommerceEntityRef,
  SystemCommerceEntityRef,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceQueryCapabilityProfile,
  CommerceSensitivity,
  MerchantExtensionSchemaRevision,
  CommerceSnapshotRevision,
} from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { requireOrganisationId } from "./test-ids";

describe("commerce entity-plane authority", () => {
  it("rejects a value-revealing aggregation below the complete sensitivity ceiling before source execution", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_aggregate_sensitivity",
    );
    // A sum reports an attribute value rather than a population size, so it
    // stays behind the complete ceiling even over system records.
    const query = parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "sum", attributeId: "total_minor" },
    });
    let sourceReads = 0;
    const source: CommerceGraphCommerceSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readCapabilityMetadata: async () => {
        sourceReads += 1;
        return capabilityMetadata(query, merchantRevision(1));
      },
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: source,
    });
    expect(
      await reader.query({
        query,
        authority: authority(
          organisationId,
          query,
          "2099-01-01T00:00:00.000Z",
          "internal",
        ),
        now: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "sensitivity_denied" } });
    expect(sourceReads).toBe(0);
  });

  it("allows a plain count of system records under an internal ceiling", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_aggregate_count",
    );
    // The same authority may already page through this population row by row,
    // so refusing to tell it how many rows there are hid nothing. A scheduled
    // brief needs exactly this.
    const query = parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: {
        kind: "attribute",
        filter: {
          operator: "equals",
          attributeId: "lifecycle",
          value: { kind: "status", value: "open" },
        },
      },
      aggregation: { kind: "count" },
    });
    let sourceReads = 0;
    const source: CommerceGraphCommerceSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readCapabilityMetadata: async () => {
        sourceReads += 1;
        return capabilityMetadata(query, merchantRevision(1));
      },
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: source,
    });
    const result = await reader.query({
      query,
      authority: authority(
        organisationId,
        query,
        "2099-01-01T00:00:00.000Z",
        "internal",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    // The ceiling no longer refuses it; whatever the source says next is the
    // source's answer, not an authority refusal.
    expect(result.ok || result.error.code !== "sensitivity_denied").toBe(true);
    expect(sourceReads).toBeGreaterThan(0);
  });

  it("checks authority before touching a source", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_authority",
    );
    const query = entityQuery("order_1");
    let reads = 0;
    const source: CommerceGraphCommerceSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readSnapshotRevision: async () => {
        reads += 1;
        return { ok: true, value: merchantRevision(1) };
      },
      readCapabilityMetadata: async (query) => {
        reads += 1;
        return capabilityMetadata(query, merchantRevision(1));
      },
      queryPlanned: async () => {
        reads += 1;
        return { ok: true, value: { kind: "invalid" } };
      },
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: source,
    });
    const result = await reader.query({
      query,
      authority: authority(organisationId, query, new Date(1).toISOString()),
      now: new Date(2).toISOString(),
    });

    expect(result).toEqual({ ok: false, error: { code: "authority_expired" } });
    expect(reads).toBe(0);
  });

  it("filters over-ceiling custom entities after source traversal", () => {
    const authorityValue = authority(
      "organisation_graph_sensitivity",
      entityQuery("order_1"),
      "2099-01-01T00:00:00.000Z",
    );
    const result = parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_1",
          },
          revision: 1,
          displayName: "Partner",
          attributes: [],
          typeRevision: 1,
          state: { state: "active" },
          sensitivity: "restricted",
        },
      ],
    });
    const filtered = filterCommerceGraphSensitivity(result, authorityValue);
    expect(filtered.entities).toHaveLength(0);
  });

  it("filters attributes by owner type and field sensitivity", () => {
    const authorityValue = authority(
      "organisation_graph_attribute_sensitivity",
      entityQuery("order_1"),
      "2099-01-01T00:00:00.000Z",
    );
    const result = parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: { origin: "system", typeId: "order", entityId: "order_1" },
          revision: 1,
          displayName: "Order",
          attributes: [
            {
              attributeId: "buyer",
              scope: {
                kind: "system",
                entityTypeId: "order",
                schemaRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "Guest" },
            },
            {
              attributeId: "private_note",
              scope: {
                kind: "system",
                entityTypeId: "order",
                schemaRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "restricted",
              value: { kind: "short_text", value: "secret" },
            },
          ],
          provenance: {
            organisationId: "organisation_graph_attribute_sensitivity",
            integrationAccountId: "integration_shopify_graph",
            source: "shopify",
            resourceType: "commerce_order",
            resourceId: "order_1",
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
    });

    const filtered = filterCommerceGraphSensitivity(result, authorityValue);
    expect(
      filtered.entities[0]?.attributes.map(
        (attribute) => attribute.attributeId,
      ),
    ).toEqual(["buyer"]);

    expect(() =>
      parseCommerceGraphResponse({
        ...emptyResult().value,
        entities: [
          {
            reference: {
              origin: "system",
              typeId: "order",
              entityId: "order_1",
            },
            revision: 1,
            displayName: "Order",
            attributes: [
              {
                attributeId: "wrong_owner",
                scope: {
                  kind: "system",
                  entityTypeId: "product",
                  schemaRevision: 1,
                },
                definitionRevision: 1,
                sensitivity: "public",
                value: { kind: "short_text", value: "leak" },
              },
            ],
            provenance: {
              organisationId: "organisation_graph_attribute_sensitivity",
              integrationAccountId: "integration_shopify_graph",
              source: "shopify",
              resourceType: "commerce_order",
              resourceId: "order_1",
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
      }),
    ).toThrow(/attribute_definition_mismatch/u);
  });

  it("treats an explicit empty context allow-list as allow-none", () => {
    const authorityValue = authority(
      "organisation_graph_empty_attributes",
      entityQuery("order_1"),
      "2099-01-01T00:00:00.000Z",
    );
    const result = parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: { origin: "system", typeId: "order", entityId: "order_1" },
          revision: 1,
          displayName: "Order",
          attributes: [
            {
              attributeId: "buyer",
              scope: {
                kind: "system",
                entityTypeId: "order",
                schemaRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "Guest" },
            },
          ],
          provenance: {
            organisationId: "organisation_graph_empty_attributes",
            integrationAccountId: "integration_shopify_graph",
            source: "shopify",
            resourceType: "commerce_order",
            resourceId: "order_1",
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
    });

    expect(
      filterCommerceGraphSensitivity(result, authorityValue, []).entities[0]
        ?.attributes,
    ).toEqual([]);
  });

  it("keeps a validated hybrid custom/system relationship at its sensitivity ceiling", () => {
    const query = entityQuery("order_hybrid");
    const result = parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_1",
          },
          revision: 1,
          displayName: "Partner",
          attributes: [],
          typeRevision: 1,
          state: { state: "active" },
          sensitivity: "internal",
        },
        systemOrderEntity("order_hybrid"),
      ],
      relationships: [
        {
          origin: "custom",
          relationshipId: "trade_partner_order",
          definition: {
            origin: "custom",
            definitionId: "trade_partner_order",
            revision: 1,
          },
          sensitivity: "internal",
          source: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_1",
          },
          target: {
            origin: "system",
            typeId: "order",
            entityId: "order_hybrid",
          },
          revision: 1,
        },
      ],
    });

    expect(
      filterCommerceGraphSensitivity(
        result,
        authority(
          "organisation_graph_hybrid",
          query,
          "2099-01-01T00:00:00.000Z",
          "internal",
        ),
      ).relationships,
    ).toHaveLength(1);
    expect(
      filterCommerceGraphSensitivity(
        result,
        authority(
          "organisation_graph_hybrid",
          query,
          "2099-01-01T00:00:00.000Z",
          "public",
        ),
      ).relationships,
    ).toHaveLength(0);
  });

  it("bounds saved-selector entity authority to the selector query", async () => {
    const organisationId = requireOrganisationId("organisation_graph_selector");
    let sourceReads = 0;
    const source: CommerceGraphCommerceSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readCapabilityMetadata: async (query) => {
        sourceReads += 1;
        return capabilityMetadata(query, merchantRevision(1));
      },
      queryPlanned: async () => {
        sourceReads += 1;
        return { ok: true, value: { kind: "invalid" } };
      },
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: source,
    });

    expect(
      await reader.query({
        query: entityQuery("order_2"),
        authority: authority(
          organisationId,
          entityQuery("order_1"),
          "2099-01-01T00:00:00.000Z",
        ),
        now: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "authority_out_of_scope" } });
    expect(sourceReads).toBe(0);
  });

  it("lets Underclerk own Shopify Commerce List membership while Blotter hydrates system rows", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_shopify_list",
    );
    const query = parseCommerceGraphQuery({
      kind: "commerce_list_page",
      listId: "export_coordination",
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 10, cursor: null },
    });
    const commerceResult = {
      ...emptyResult().value,
      entities: [
        {
          ...systemShipmentEntity("shipment_list"),
          displayName: "Underclerk shipment",
        },
      ],
    };
    let plannedReads = 0;
    let exactHydrations = 0;
    const commerceEngine: CommerceGraphHydratingSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      queryPlanned: async (request) => {
        plannedReads += 1;
        return plannedCommerceResult(request, commerceResult);
      },
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(1), sidecars: [] },
      }),
    };
    const blotter: CommerceGraphBlotterSource = {
      ...sourceStub("blotter", async () => emptyResult()),
      queryPlan: async () => {
        throw new Error(
          "Underclerk-owned list must not invoke Blotter page membership",
        );
      },
      hydrateSystemEntities: async () => {
        exactHydrations += 1;
        return {
          ok: true,
          value: {
            ...emptyResult().value,
            merchantRevision: null,
            entities: [systemShipmentEntity("shipment_list")],
          },
        };
      },
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceEngine,
      blotter,
    });

    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-26T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { entities: [{ displayName: "Shipment" }] },
    });
    expect(plannedReads).toBe(1);
    expect(exactHydrations).toBe(1);
  });

  it("fails closed when Blotter omits an Underclerk-returned system reference", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_shopify_missing_hydration",
    );
    const query = parseCommerceGraphQuery({
      kind: "commerce_list_page",
      listId: "export_coordination",
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 10, cursor: null },
    });
    const commerceEngine: CommerceGraphHydratingSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      queryPlanned: async (request) =>
        plannedCommerceResult(request, {
          ...emptyResult().value,
          entities: [systemShipmentEntity("shipment_missing_hydration")],
        }),
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(1), sidecars: [] },
      }),
    };
    const blotter: CommerceGraphBlotterSource = {
      ...sourceStub("blotter", async () => emptyResult()),
      hydrateSystemEntities: async () => ({
        ok: true,
        value: { ...emptyResult().value, merchantRevision: null, entities: [] },
      }),
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceEngine,
      blotter,
    });

    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-26T00:00:00.000Z",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "source_invalid",
        source: "blotter",
        message: "Blotter exact system hydration omitted a requested reference",
      },
    });
  });

  it("keeps saved system views on Blotter and saved list views on Underclerk", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_shopify_saved_views",
    );
    const systemQuery = parseCommerceGraphQuery({
      kind: "saved_commerce_view",
      viewId: "export_system_board",
      pagination: { limit: 10, cursor: null },
    });
    const listQuery = parseCommerceGraphQuery({
      kind: "saved_commerce_view",
      viewId: "export_list_board",
      pagination: { limit: 10, cursor: null },
    });
    let blotterReads = 0;
    const systemCommerce: CommerceGraphHydratingSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readCapabilityMetadata: async () => ({
        ok: true,
        value: {
          organisationId: "organisation_graph",
          merchantId: "merchant_graph",
          merchantRevision: merchantRevision(1),
          watermark: {
            kind: "underclerk_native" as const,
            merchantRevision: merchantRevision(1),
          },
          capabilities: parseCapabilityProfile({
            kind: "saved_commerce_view",
            viewId: "export_system_board",
            viewRevision: 1,
            source: {
              kind: "system_mapped",
              systemEntityKind: "shipment",
              systemSchemaRevision: 1,
              capability: emptyCapabilityMatrix(),
            },
            filter: { kind: "all" },
            sorts: [],
          }),
          projection: commerceGraphQueryProjection(systemQuery),
        },
      }),
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(1), sidecars: [] },
      }),
      queryPlanned: async () => ({ ok: true, value: { kind: "invalid" } }),
    };
    const listCommerce: CommerceGraphHydratingSource = {
      ...systemCommerce,
      readCapabilityMetadata: async () => ({
        ok: true,
        value: {
          organisationId: "organisation_graph",
          merchantId: "merchant_graph",
          merchantRevision: merchantRevision(1),
          watermark: {
            kind: "underclerk_native" as const,
            merchantRevision: merchantRevision(1),
          },
          capabilities: parseCapabilityProfile({
            kind: "saved_commerce_view",
            viewId: "export_list_board",
            viewRevision: 1,
            source: {
              kind: "commerce_list",
              listId: "export_coordination",
              listRevision: 1,
              capability: emptyCapabilityMatrix(),
            },
            filter: { kind: "all" },
            sorts: [],
          }),
          projection: commerceGraphQueryProjection(listQuery),
        },
      }),
      queryPlanned: async (request) =>
        plannedCommerceResult(request, {
          ...emptyResult().value,
          entities: [
            {
              ...systemShipmentEntity("shipment_saved_list"),
              displayName: "Underclerk saved-list shipment",
            },
          ],
        }),
    };
    const blotter: CommerceGraphBlotterSource = {
      ...sourceStub("blotter", async () => emptyResult()),
      queryPlan: async () => {
        blotterReads += 1;
        return {
          ok: true,
          value: {
            ...emptyResult().value,
            entities: [systemShipmentEntity("shipment_saved_system")],
          },
        };
      },
      hydrateSystemEntities: async () => ({
        ok: true,
        value: {
          ...emptyResult().value,
          merchantRevision: null,
          entities: [systemShipmentEntity("shipment_saved_list")],
        },
      }),
    };
    const systemReader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: systemCommerce,
      blotter,
    });
    const systemResult = await systemReader.query({
      query: systemQuery,
      authority: authority(
        organisationId,
        systemQuery,
        "2099-01-01T00:00:00.000Z",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(systemResult).toMatchObject({
      ok: true,
      value: {
        entities: [{ reference: { entityId: "shipment_saved_system" } }],
      },
    });

    const listReader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: listCommerce,
      blotter,
    });
    const listResult = await listReader.query({
      query: listQuery,
      authority: authority(
        organisationId,
        listQuery,
        "2099-01-01T00:00:00.000Z",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(listResult).toMatchObject({
      ok: true,
      value: { entities: [{ displayName: "Shipment" }] },
    });
    expect(blotterReads).toBe(1);
  });

  it("intersects provider capabilities with Blotter attributes while native reads retain them", async () => {
    const providerOrganisationId = requireOrganisationId(
      "organisation_graph_provider_capabilities",
    );
    const providerQuery = parseCommerceGraphQuery({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: {
        kind: "attribute",
        filter: { operator: "is_empty", attributeId: "merchant_note" },
      },
      sorts: [],
      pagination: { limit: 10, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 10 },
    });
    const extensionProfile = parseCapabilityProfile({
      kind: "system_mapped",
      systemEntityKind: "order",
      systemSchemaRevision: 1,
      capability: {
        filterableAttributeIds: ["merchant_note"],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" },
      },
    });
    const providerCommerce: CommerceGraphHydratingSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readCapabilityMetadata: async () => ({
        ok: true,
        value: {
          organisationId: "organisation_graph",
          merchantId: "merchant_graph",
          merchantRevision: merchantRevision(1),
          watermark: {
            kind: "underclerk_native" as const,
            merchantRevision: merchantRevision(1),
          },
          capabilities: extensionProfile,
          projection: commerceGraphQueryProjection(providerQuery),
        },
      }),
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(1), sidecars: [] },
      }),
    };
    const providerReader = new CommerceGraphReader({
      organisationId: providerOrganisationId,
      merchantId: "merchant_graph",
      underclerk: providerCommerce,
      blotter: sourceStub("blotter", async () => emptyResult()),
    });
    const providerResult = await providerReader.query({
      query: providerQuery,
      authority: authority(
        providerOrganisationId,
        providerQuery,
        "2099-01-01T00:00:00.000Z",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(providerResult).toEqual({
      ok: false,
      error: {
        code: "commerce_query_unsupported",
        capability: { kind: "attribute_filter" },
      },
    });

    const nativeOrganisationId = requireOrganisationId(
      "organisation_graph_native_capabilities",
    );
    const nativeQuery = parseCommerceGraphQuery({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: {
        kind: "attribute",
        filter: { operator: "is_empty", attributeId: "lifecycle" },
      },
      sorts: [],
      pagination: { limit: 10, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 10 },
    });
    const nativeCommerce: CommerceGraphCommerceSource = {
      ...sourceStub("underclerk", async () => emptyResult()),
      readCapabilityMetadata: async () => ({
        ok: true,
        value: {
          organisationId: "organisation_graph",
          merchantId: "merchant_graph",
          merchantRevision: merchantRevision(1),
          watermark: {
            kind: "underclerk_native" as const,
            merchantRevision: merchantRevision(1),
          },
          capabilities: parseCapabilityProfile({
            kind: "system_mapped",
            systemEntityKind: "order",
            systemSchemaRevision: 1,
            capability: {
              filterableAttributeIds: ["lifecycle"],
              sortableAttributeIds: [],
              aggregation: { kind: "count_only" },
            },
          }),
          projection: commerceGraphQueryProjection(nativeQuery),
        },
      }),
      queryPlanned: async (request) =>
        plannedCommerceResult(request, emptyResult().value),
    };
    const nativeReader = new CommerceGraphReader({
      organisationId: nativeOrganisationId,
      merchantId: "merchant_graph",
      underclerk: nativeCommerce,
    });
    const nativeResult = await nativeReader.query({
      query: nativeQuery,
      authority: authority(
        nativeOrganisationId,
        nativeQuery,
        "2099-01-01T00:00:00.000Z",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(nativeResult.ok).toBe(true);
  });

  it("resolves stale presentation pages and scan reads to distinct typed outcomes", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_stale_operation",
    );
    const pageQuery = entityQuery("order_stale_presentation");
    const aggregationQuery = parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "count" },
    });
    const stale = {
      kind: "cursor_stale" as const,
      expected: {
        kind: "underclerk_native" as const,
        merchantRevision: merchantRevision(2),
      },
      received: {
        kind: "underclerk_native" as const,
        merchantRevision: merchantRevision(1),
      },
    };
    const source: CommerceGraphCommerceSource = {
      source: "underclerk",
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(2),
      }),
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(1)),
      queryPlanned: async () => ({ ok: true, value: stale }),
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: source,
    });
    const presentation = await reader.query({
      query: pageQuery,
      authority: authority(
        organisationId,
        pageQuery,
        "2099-01-01T00:00:00.000Z",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    const scan = await reader.query({
      query: aggregationQuery,
      authority: authority(
        organisationId,
        aggregationQuery,
        "2099-01-01T00:00:00.000Z",
        "restricted",
      ),
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(presentation).toEqual({
      ok: false,
      error: {
        code: "commerce_results_changed",
        expected: stale.expected,
        received: stale.received,
      },
    });
    expect(scan).toEqual({
      ok: false,
      error: {
        code: "commerce_read_stale",
        expected: stale.expected,
        received: stale.received,
        restart: true,
      },
    });
  });

  it("keeps the Underclerk merchant cursor ahead of provider revisions", async () => {
    const organisationId = requireOrganisationId("organisation_graph_revision");
    const query = entityQuery("order_1");
    const commerceEngine = sourceStub("underclerk", async () => ({
      ok: true,
      value: { ...emptyResult().value, merchantRevision: merchantRevision(3) },
    }));
    const commerceWithHydration: CommerceGraphHydratingSource = {
      ...commerceEngine,
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(3),
      }),
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(3)),
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(3), sidecars: [] },
      }),
    };
    const blotter = sourceStub("blotter", async () => ({
      ok: true,
      value: { ...emptyResult().value, merchantRevision: merchantRevision(99) },
    }));
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceWithHydration,
      blotter,
    });

    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-25T00:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: true, value: { merchantRevision: 3 } });
  });

  it("attaches exact-reference Underclerk sidecars to the Blotter system entity", async () => {
    const organisationId = requireOrganisationId("organisation_graph_sidecar");
    const query = entityQuery("order_sidecar");
    const commerceEngine = sourceStub("underclerk", async () => emptyResult());
    const commerceWithHydration: CommerceGraphHydratingSource = {
      ...commerceEngine,
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(7),
      }),
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(7)),
      hydrateEntityExtensions: async (references) => ({
        ok: true,
        value: {
          merchantRevision: merchantRevision(7),
          sidecars: references.map((entityRef) => ({
            entityRef: systemEntityReference(entityRef),
            extensionSchemaRevision: 2 as MerchantExtensionSchemaRevision,
            attributes: [
              {
                attributeId: "merchant_note" as AttributeDefinitionId,
                scope: {
                  kind: "merchant_extension",
                  entityTypeId: "order",
                  schemaRevision: 2 as MerchantExtensionSchemaRevision,
                },
                definitionRevision: 2 as AttributeDefinitionRevision,
                sensitivity: "internal",
                value: { kind: "short_text", value: "extension" },
              },
            ],
          })),
        },
      }),
    };
    const blotter = sourceStub("blotter", async () => ({
      ok: true,
      value: {
        ...emptyResult().value,
        merchantRevision: null,
        entities: [systemOrderEntity("order_sidecar")],
      },
    }));
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceWithHydration,
      blotter,
    });

    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-25T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        merchantRevision: 7,
        entities: [{ attributes: [{ attributeId: "merchant_note" }] }],
      },
    });
  });

  it("traverses a provider-backed hybrid graph across two bounded depths", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_hybrid_traversal",
    );
    const query = parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [{ origin: "system", typeId: "shipment", entityId: "shipment_1" }],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "shipment_trade_partner",
        revision: 1,
      },
      traversal: { maxDepth: 2, resultLimit: 10 },
      filter: null,
    });
    const shipment = systemShipmentEntity("shipment_1");
    const tradePartner = customGraphEntity(
      "trade_partner",
      "partner_1",
      "Partner",
    );
    const exportDocument = customGraphEntity(
      "export_document",
      "document_1",
      "Export document",
    );
    const commerceEngine: CommerceGraphHydratingSource = {
      source: "underclerk",
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(1),
      }),
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(1)),
      queryPlanned: async () => ({ ok: true, value: { kind: "invalid" } }),
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(1), sidecars: [] },
      }),
      readRelationshipStep: async ({ frontier }) =>
        frontier[0]?.origin === "system"
          ? {
              ok: true,
              value: hybridStepValue(
                1,
                [tradePartner],
                [
                  customGraphRelationship(
                    "shipment_trade_partner",
                    shipment.reference,
                    tradePartner.reference,
                  ),
                ],
              ),
            }
          : {
              ok: true,
              value: hybridStepValue(
                1,
                [exportDocument],
                [
                  customGraphRelationship(
                    "trade_partner_export_document",
                    tradePartner.reference,
                    exportDocument.reference,
                  ),
                ],
              ),
            },
    };
    const blotter: CommerceGraphBlotterSource = {
      source: "blotter",
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(2),
      }),
      queryPlan: async () => ({ ok: true, value: emptyResult().value }),
      readRelationshipStep: async ({ frontier }) => ({
        ok: true,
        value: {
          ...emptyResult().value,
          merchantRevision: null,
          entities: frontier.some((ref) => ref.origin === "system")
            ? [shipment]
            : [],
        },
      }),
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceEngine,
      blotter,
    });
    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-26T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.entities.map((entity) => entity.reference.entityId),
    ).toEqual(["shipment_1", "partner_1", "document_1"]);
    expect(
      result.value.relationships.map(
        (relationship) => relationship.relationshipId,
      ),
    ).toEqual(["shipment_trade_partner", "trade_partner_export_document"]);
  });

  it("plans and reads an all-custom initial dossier through Underclerk", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_custom_seed",
    );
    const seed = customGraphEntity(
      "trade_partner",
      "partner_seed",
      "Seed partner",
    );
    const document = customGraphEntity(
      "export_document",
      "document_seed",
      "Export document",
    );
    const query = parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [seed.reference],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "partner_export_document",
        revision: 1,
      },
      traversal: { maxDepth: 1, resultLimit: 10 },
      filter: null,
    });
    let steps = 0;
    const commerceEngine: CommerceGraphCommerceSource = {
      source: "underclerk",
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(4),
      }),
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(4)),
      queryPlanned: async () => ({ ok: true, value: { kind: "invalid" } }),
      readRelationshipStep: async ({ frontier, planRequest }) => {
        expect(planRequest.capabilities.kind).toBe("underclerk_custom");
        if (steps++ > 0) return { ok: true, value: emptyResult().value };
        expect(frontier).toEqual([seed.reference]);
        return {
          ok: true,
          value: hybridStepValue(
            4,
            [seed, document],
            [
              customGraphRelationship(
                "partner_export_document",
                seed.reference,
                document.reference,
              ),
            ],
          ),
        };
      },
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceEngine,
    });

    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-26T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.entities.map((entity) => entity.reference.entityId),
    ).toEqual(["partner_seed", "document_seed"]);
    expect(
      result.value.relationships.map(
        (relationship) => relationship.relationshipId,
      ),
    ).toEqual(["partner_export_document"]);
  });

  it("hydrates a system endpoint from Blotter after a custom provider seed", async () => {
    const organisationId = requireOrganisationId(
      "organisation_graph_custom_system_hydration",
    );
    const seed = customGraphEntity(
      "trade_partner",
      "partner_seed",
      "Seed partner",
    );
    const shipment = systemShipmentEntity("shipment_from_partner");
    const query = parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [seed.reference],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "partner_shipment",
        revision: 1,
      },
      traversal: { maxDepth: 1, resultLimit: 10 },
      filter: null,
    });
    let blotterFrontiers: CommerceEntityRef[][] = [];
    const commerceEngine: CommerceGraphHydratingSource = {
      source: "underclerk",
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(5),
      }),
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(5)),
      queryPlanned: async () => ({ ok: true, value: { kind: "invalid" } }),
      hydrateEntityExtensions: async () => ({
        ok: true,
        value: { merchantRevision: merchantRevision(5), sidecars: [] },
      }),
      readRelationshipStep: async ({ frontier }) => ({
        ok: true,
        value: hybridStepValue(
          5,
          [seed],
          [
            customGraphRelationship(
              "partner_shipment",
              seed.reference,
              shipment.reference,
            ),
          ],
        ),
      }),
    };
    const blotter: CommerceGraphBlotterSource = {
      source: "blotter",
      readSnapshotRevision: async () => ({
        ok: true,
        value: merchantRevision(8),
      }),
      queryPlan: async () => ({ ok: true, value: emptyResult().value }),
      readRelationshipStep: async ({ frontier }) => {
        blotterFrontiers.push([...frontier]);
        return {
          ok: true,
          value: { ...emptyResult().value, merchantRevision: null },
        };
      },
      hydrateSystemEntities: async (references) => ({
        ok: true,
        value: {
          ...emptyResult().value,
          merchantRevision: null,
          entities: references.map(() => shipment),
        },
      }),
    };
    const reader = new CommerceGraphReader({
      organisationId,
      merchantId: "merchant_graph",
      underclerk: commerceEngine,
      blotter,
    });

    const result = await reader.query({
      query,
      authority: authority(organisationId, query, "2099-01-01T00:00:00.000Z"),
      now: "2026-08-26T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.entities.map((entity) => entity.reference.entityId),
    ).toEqual(["partner_seed", "shipment_from_partner"]);
    expect(
      result.value.relationships.map(
        (relationship) => relationship.relationshipId,
      ),
    ).toEqual(["partner_shipment"]);
    expect(blotterFrontiers.length).toBeGreaterThan(0);
    expect(
      blotterFrontiers.every((frontier) =>
        frontier.every((reference) => reference.origin === "system"),
      ),
    ).toBe(true);
  });
});

function entityQuery(entityId: string): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "system", typeId: "order", entityId },
    traversal: { maxDepth: 0, resultLimit: 10 },
    filter: null,
  });
}

function authority(
  organisationId: string,
  query: CommerceGraphQuery,
  expiresAt: string,
  sensitivityCeiling: CommerceSensitivity = "internal",
): CommerceGraphReadAuthority {
  const built = buildSavedSelectorCommerceReadAuthority({
    organisationId,
    merchantId: "merchant_graph",
    principalId: "principal_graph",
    sensitivityCeiling,
    expiresAt,
    commandId: "request_graph",
    selectorId: "selector_graph",
    selectorRevision: 1,
    query,
  });
  if (!built.ok)
    throw new Error(`authority fixture is invalid: ${built.error.code}`);
  return built.value;
}

function sourceStub(
  source: "underclerk",
  result: () => Promise<CommerceGraphSourceResult>,
): CommerceGraphCommerceSource &
  Readonly<{
    readSnapshotRevision: NonNullable<
      CommerceGraphSource["readSnapshotRevision"]
    >;
  }>;
function sourceStub(
  source: "blotter",
  result: () => Promise<CommerceGraphSourceResult>,
): CommerceGraphBlotterSource;
function sourceStub(
  source: "underclerk" | "blotter",
  result: () => Promise<CommerceGraphSourceResult>,
): CommerceGraphCommerceSource | CommerceGraphBlotterSource {
  const readSnapshotRevision = async () => ({
    ok: true as const,
    value: merchantRevision(1),
  });
  if (source === "underclerk") {
    return {
      source,
      readSnapshotRevision,
      readCapabilityMetadata: async (query) =>
        capabilityMetadata(query, merchantRevision(1)),
      queryPlanned: async () => ({ ok: true, value: { kind: "invalid" } }),
    };
  }
  return {
    source,
    readSnapshotRevision,
    queryPlan: async () => ({
      ...(await result()),
    }),
  };
}

function capabilityMetadata(
  query: CommerceGraphQuery,
  revision: CommerceSnapshotRevision,
) {
  return {
    ok: true as const,
    value: {
      organisationId: "organisation_graph",
      merchantId: "merchant_graph",
      merchantRevision: revision,
      watermark: {
        kind: "underclerk_native" as const,
        merchantRevision: revision,
      },
      capabilities: capabilityProfile(query),
      projection: commerceGraphQueryProjection(query),
    },
  };
}

function capabilityProfile(
  query: CommerceGraphQuery,
): CommerceQueryCapabilityProfile {
  switch (query.kind) {
    case "entity_by_ref":
      return profileForEntityType(query.reference);
    case "entity_type_page":
    case "search":
      if (query.entityTypeId === null)
        throw new Error("authority fixture requires an entity type");
      return profileForEntityType(query.entityTypeId);
    case "relationship_traversal": {
      const seed = query.seeds[0];
      if (
        seed === undefined ||
        query.seeds.some(
          (candidate) =>
            candidate.origin !== seed.origin ||
            candidate.typeId !== seed.typeId,
        )
      ) {
        throw new Error(
          "authority fixture requires uniform relationship seeds",
        );
      }
      return profileForEntityType(seed);
    }
    case "commerce_list_page":
      return parseCapabilityProfile({
        kind: "commerce_list",
        listId: query.listId,
        listRevision: 1,
        capability: emptyCapabilityMatrix(),
      });
    case "saved_commerce_view":
      return parseCapabilityProfile({
        kind: "saved_commerce_view",
        viewId: query.viewId,
        viewRevision: 1,
        source: capabilitySourceForEntityType({
          origin: "system",
          typeId: "order",
        }),
        filter: { kind: "all" },
        sorts: [],
      });
    case "aggregation":
      return query.source.kind === "commerce_list"
        ? parseCapabilityProfile({
            kind: "commerce_list",
            listId: query.source.listId,
            listRevision: 1,
            capability: emptyCapabilityMatrix(),
          })
        : profileForEntityType(query.source.entityTypeId);
    case "underclerk_context":
      if (query.selection.kind === "entity_seeds") {
        const seed = query.selection.seeds[0];
        const entityType: CommerceEntityTypeId =
          seed === undefined
            ? { origin: "system", typeId: "order" }
            : seed.origin === "system"
              ? { origin: "system", typeId: seed.typeId }
              : { origin: "custom", typeId: seed.typeId };
        return profileForEntityType(entityType);
      }
      return capabilityProfile(query.selection.selector.query);
    default:
      return assertNever(query, "Unexpected authority query fixture");
  }
}

function profileForEntityType(
  entityType: CommerceEntityTypeId,
): CommerceQueryCapabilityProfile {
  const capabilities =
    entityType.origin === "system"
      ? {
          kind: "system_mapped",
          systemEntityKind: entityType.typeId,
          systemSchemaRevision: 1,
          capability: emptyCapabilityMatrix(),
        }
      : {
          kind: "underclerk_custom",
          entityTypeId: entityType.typeId,
          publishedRevision: 1,
          capability: emptyCapabilityMatrix(),
        };
  return parseEntityPlaneCapabilityMetadataResponse({
    kind: "capability_metadata",
    organisationId: "organisation_graph",
    merchantId: "merchant_graph",
    merchantRevision: 1,
    watermark: { kind: "underclerk_native", merchantRevision: 1 },
    capabilities,
    projection: commerceGraphQueryProjection(
      entityQuery("order_projection_fixture"),
    ),
  }).capabilities;
}

function capabilitySourceForEntityType(
  entityType: CommerceEntityTypeId,
): Variant<CommerceQueryCapabilityProfile, "saved_commerce_view">["source"] {
  const profile = profileForEntityType(entityType);
  if (
    profile.kind === "system_mapped" ||
    profile.kind === "underclerk_custom" ||
    profile.kind === "commerce_list"
  )
    return profile;
  throw new Error("authority fixture produced an invalid saved-view source");
}

function parseCapabilityProfile(
  capabilities: unknown,
): CommerceQueryCapabilityProfile {
  return parseEntityPlaneCapabilityMetadataResponse({
    kind: "capability_metadata",
    organisationId: "organisation_graph",
    merchantId: "merchant_graph",
    merchantRevision: 1,
    watermark: { kind: "underclerk_native", merchantRevision: 1 },
    capabilities,
    projection: commerceGraphQueryProjection(
      entityQuery("order_projection_fixture"),
    ),
  }).capabilities;
}

function emptyCapabilityMatrix() {
  return {
    filterableAttributeIds: [],
    sortableAttributeIds: [],
    aggregation: { kind: "count_only" as const },
  };
}

function plannedCommerceResult(
  request: Parameters<CommerceGraphCommerceSource["queryPlanned"]>[0],
  result: CommerceGraphQueryResult,
): CommerceGraphPlannedSourceResult {
  const planned = planCommerceGraphQuery(request);
  if (!planned.ok || planned.value.kind !== "planned")
    return { ok: true, value: { kind: "invalid" } };
  const merchantRevision =
    request.watermark.kind === "underclerk_native"
      ? request.watermark.merchantRevision
      : result.merchantRevision;
  if (merchantRevision === null)
    return { ok: true, value: { kind: "invalid" } };
  return {
    ok: true,
    value: {
      kind: "planned",
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      merchantRevision,
      plan: planned.value.plan,
      result,
      hasMore: false,
    },
  };
}

function emptyResult(): { ok: true; value: CommerceGraphQueryResult } {
  return {
    ok: true,
    value: parseCommerceGraphResponse({
      merchantRevision: 1,
      entities: [],
      relationships: [],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: [],
      freshness: [],
    }),
  };
}

function merchantRevision(value: number): CommerceSnapshotRevision {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid merchant revision fixture");
  return parseCommerceSnapshotRevision(value, "merchantRevision");
}



function systemEntityReference(
  reference: CommerceEntityRef,
): SystemCommerceEntityRef {
  if (reference.origin !== "system")
    throw new Error("system entity fixture required");
  return reference;
}

function systemOrderEntity(
  entityId: string,
): CommerceGraphQueryResult["entities"][number] {
  return (
    parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: { origin: "system", typeId: "order", entityId },
          revision: 1,
          displayName: "Order",
          attributes: [],
          provenance: {
            organisationId: "organisation_graph_sidecar",
            integrationAccountId: "integration_shopify_graph",
            source: "shopify",
            resourceType: "commerce_order",
            resourceId: entityId,
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
    }).entities[0] ??
    (() => {
      throw new Error("missing order entity fixture");
    })()
  );
}

function systemShipmentEntity(
  entityId: string,
): CommerceGraphQueryResult["entities"][number] {
  return (
    parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: { origin: "system", typeId: "shipment", entityId },
          revision: 1,
          displayName: "Shipment",
          attributes: [],
          provenance: {
            organisationId: "organisation_graph_hybrid_traversal",
            integrationAccountId: "integration_shopify_graph",
            source: "shopify",
            resourceType: "shipment",
            resourceId: entityId,
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
    }).entities[0] ??
    (() => {
      throw new Error("missing shipment entity fixture");
    })()
  );
}

function customGraphEntity(
  typeId: string,
  entityId: string,
  displayName: string,
): CommerceGraphQueryResult["entities"][number] {
  return (
    parseCommerceGraphResponse({
      ...emptyResult().value,
      entities: [
        {
          reference: { origin: "custom", typeId, entityId },
          revision: 1,
          displayName,
          attributes: [],
          typeRevision: 1,
          state: { state: "active" },
          sensitivity: "internal",
        },
      ],
    }).entities[0] ??
    (() => {
      throw new Error("missing custom entity fixture");
    })()
  );
}

function customGraphRelationship(
  relationshipId: string,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
): CommerceGraphQueryResult["relationships"][number] {
  return (
    parseCommerceGraphResponse({
      ...emptyResult().value,
      relationships: [
        {
          origin: "custom",
          relationshipId,
          definition: {
            origin: "custom",
            definitionId: relationshipId,
            revision: 1,
          },
          sensitivity: "internal",
          source,
          target,
          revision: 1,
        },
      ],
    }).relationships[0] ??
    (() => {
      throw new Error("missing relationship fixture");
    })()
  );
}

function hybridStepValue(
  merchantRevisionValue: number,
  entities: readonly CommerceGraphQueryResult["entities"][number][],
  relationships: readonly CommerceGraphQueryResult["relationships"][number][],
): CommerceGraphQueryResult {
  return {
    merchantRevision: merchantRevision(merchantRevisionValue),
    entities: [...entities],
    relationships: [...relationships],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  };
}
