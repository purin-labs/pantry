import { describe, expect, it } from "vitest";
import {
  parseCommerceGraphQuery,
  parseEntityPlaneCapabilityMetadataResponse,
  parseCommerceSnapshotRevision,
} from "@seams/commerce-client";

import { planSafeCommerceQuery } from "../src/commerce/entity-plane/planner";

describe("commerce entity-plane planner surface", () => {
  it("lets Lexicon seal exact-definition relationship traversal", () => {
    const outcome = planSafeCommerceQuery({
      organisationId: "organisation_relationship_plan",
      merchantId: "merchant_relationship_plan",
      watermark: nativeWatermark(3),
      capabilities: systemCapabilities("shipment"),
      query: parseCommerceGraphQuery({
        kind: "relationship_traversal",
        seeds: [
          { origin: "system", typeId: "shipment", entityId: "shipment_1" },
        ],
        relationshipDefinition: {
          origin: "system",
          definitionId: "shipment_production_batch",
          revision: 1,
        },
        traversal: { maxDepth: 2, resultLimit: 20 },
        filter: null,
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      kind: "planned",
      plan: {
        operation: {
          kind: "relationship_traversal",
          subject: {
            kind: "definition",
            relationshipDefinition: {
              definitionId: "shipment_production_batch",
            },
          },
        },
        projection: {
          relationshipDefinitions: [
            { definitionId: "shipment_production_batch" },
          ],
        },
      },
    });
  });

  it("rejects traversal whose system seeds have different entity types", () => {
    const outcome = planSafeCommerceQuery({
      organisationId: "organisation_relationship_plan",
      merchantId: "merchant_relationship_plan",
      watermark: nativeWatermark(3),
      capabilities: systemCapabilities("shipment"),
      query: parseCommerceGraphQuery({
        kind: "relationship_traversal",
        seeds: [
          { origin: "system", typeId: "shipment", entityId: "shipment_1" },
          { origin: "system", typeId: "order", entityId: "order_1" },
        ],
        relationshipDefinition: null,
        traversal: { maxDepth: 1, resultLimit: 20 },
        filter: null,
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      error: { code: "commerce_query_surface_unsupported" },
    });
  });

  it("plans an all-custom traversal with the Underclerk capability profile", () => {
    const outcome = planSafeCommerceQuery({
      organisationId: "organisation_custom_relationship_plan",
      merchantId: "merchant_custom_relationship_plan",
      watermark: nativeWatermark(3),
      capabilities: customCapabilities("trade_partner"),
      query: parseCommerceGraphQuery({
        kind: "relationship_traversal",
        seeds: [
          { origin: "custom", typeId: "trade_partner", entityId: "partner_1" },
        ],
        relationshipDefinition: {
          origin: "custom",
          definitionId: "partner_export_document",
          revision: 1,
        },
        traversal: { maxDepth: 1, resultLimit: 20 },
        filter: null,
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      kind: "planned",
      plan: { operation: { kind: "relationship_traversal" } },
    });
  });
});

function nativeWatermark(revision: number) {
  return {
    kind: "underclerk_native" as const,
    merchantRevision: parseCommerceSnapshotRevision(
      revision,
      "merchantRevision",
    ),
  };
}

function systemCapabilities(systemEntityKind: "shipment" | "order") {
  return parseEntityPlaneCapabilityMetadataResponse({
    kind: "capability_metadata",
    organisationId: "organisation_relationship_plan",
    merchantId: "merchant_relationship_plan",
    merchantRevision: 1,
    watermark: { kind: "underclerk_native", merchantRevision: 1 },
    capabilities: {
      kind: "system_mapped" as const,
      systemEntityKind,
      systemSchemaRevision: 1,
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" as const },
      },
    },
    projection: {
      attributeIds: [],
      relationshipDefinitions: [],
      includeProvenance: true,
      includeFreshness: true,
    },
  }).capabilities;
}

function customCapabilities(entityTypeId: "trade_partner") {
  return parseEntityPlaneCapabilityMetadataResponse({
    kind: "capability_metadata",
    organisationId: "organisation_custom_relationship_plan",
    merchantId: "merchant_custom_relationship_plan",
    merchantRevision: 1,
    watermark: { kind: "underclerk_native", merchantRevision: 1 },
    capabilities: {
      kind: "underclerk_custom" as const,
      entityTypeId,
      publishedRevision: 1,
      capability: {
        filterableAttributeIds: [],
        sortableAttributeIds: [],
        aggregation: { kind: "count_only" as const },
      },
    },
    projection: {
      attributeIds: [],
      relationshipDefinitions: [],
      includeProvenance: true,
      includeFreshness: true,
    },
  }).capabilities;
}
