import type { UnitTestEnv } from "./worker-fakes";
import { createActiveOrganisationFixture } from "./fixtures/organisation-activation";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import type {
  CommerceEntityTypeId,
  CommerceGraphQuery,
  CommerceListId,
  CommerceQueryCapabilityProfile,
  CommerceReadWatermark,
  CustomCommerceEntityTypeId,
  SystemCommerceEntityKind,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceGraphQueryPlanRequest,
  parseEntityPlaneCapabilityMetadataResponse,
  parseCommerceSnapshotRevision,
} from "@purin-labs/commerce-client";
import { OrganisationDO } from "../src/actors/organisation";
import {
  materializeCommerceRelationText,
  rebuildCommerceRelationshipRelationsForOwner,
} from "../src/actors/commerce-query-schema";
import {
  buildCommerceGraphQueryPlanRequest,
  commerceGraphQueryProjection,
  planSafeCommerceQuery,
} from "../src/commerce/entity-plane/planner";
import { parseCommerceGraphQuery } from "../src/commerce/entity-plane/routes";
import { planCommerceGraphQuery } from "../src/commerce/commerce-wasm";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";

describe("OrganisationActor normalized commerce relation", () => {
  it("materializes typed lifecycle and low-stock attributes with an indexed normalized relation", () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    const ctx = {
      storage: {
        sql,
        transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
      },
    } as unknown as DurableObjectState;
    new OrganisationDO(ctx, {} as UnitTestEnv);
    sql.exec(
      `INSERT INTO commerce_projection (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         revision, lifecycle, projection_json, updated_at, validated_at
       ) VALUES
         ('organisation_attribute_schema', 'inventory_position', 'position_1', 'integration_attributes', 1,
          'active', ?, 10, 10),
         ('organisation_attribute_schema', 'stock_policy', 'policy_1', 'integration_attributes', 1,
          'active', ?, 10, 10)`,
      JSON.stringify({
        projection: {
          inventoryItemId: "item_1",
          locationId: "location_1",
          balance: { available: { amount: 2, scale: 0, unit: "each" } },
        },
      }),
      JSON.stringify({
        projection: {
          lifecycle: "active",
          inventoryItemId: "item_1",
          locationId: "location_1",
          replenishment: {
            kind: "threshold",
            reorderPoint: { amount: 3, scale: 0, unit: "each" },
          },
        },
      }),
    );
    rebuildCommerceRelationshipRelationsForOwner(sql, "integration_attributes");

    expect(
      sql
        .exec<{
          readonly attribute_id: string;
          readonly value_kind: string;
          readonly comparable_boolean: number | null;
          readonly comparable_text: string | null;
        }>(
          `SELECT attribute_id, value_kind, comparable_boolean, comparable_text
         FROM commerce_entity_attribute_relation
        WHERE merchant_id = ? AND entity_type = 'stock_policy'
        ORDER BY attribute_id`,
          "integration_attributes",
        )
        .toArray(),
    ).toEqual([
      {
        attribute_id: "lifecycle",
        value_kind: "status",
        comparable_boolean: null,
        comparable_text: "active",
      },
      {
        attribute_id: "low_stock",
        value_kind: "boolean",
        comparable_boolean: 1,
        comparable_text: null,
      },
    ]);
  });

  it("rejects a structurally valid plan carrying a fake fingerprint at the Organisation RPC boundary", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    const organisationId = requireOrganisationId(
      "organisation_query_plan_parser",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_query_plan_parser",
    );
    const ctx = {
      storage: {
        sql,
        transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
      },
    } as unknown as DurableObjectState;
    new OrganisationDO(ctx, {} as UnitTestEnv);
    sql.exec(
      `INSERT INTO organisation_meta (organisation_id, name, plan, status, created_at)
       VALUES (?, 'Query parser', 'beta', 'active', 1)`,
      organisationId,
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
      merchantId: "merchant_query_plan_parser",
      watermark: {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
          0,
          "blotterRevision",
        ),
        commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
          0,
          "commerceRevision",
        ),
      },
      capabilities: capabilitiesForQuery(query.value),
    });
    expect(planned.ok && planned.value.kind === "planned").toBe(true);
    if (!planned.ok || planned.value.kind !== "planned") return;
    const fakePlan = {
      ...planned.value.plan,
      queryFingerprint: "f".repeat(64),
    };
    const activeOrganisation = await createActiveOrganisationFixture(
      ctx,
      organisationId,
    );
    const result = await activeOrganisation.readCommerceQueryPlan({
      organisationId,
      integrationAccountId,
      planRequest: safePlanRequest(
        query.value,
        organisationId,
        "merchant_query_plan_parser",
        planned.value.plan.watermark,
      ),
      plan: fakePlan,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_query_plan_invalid" },
    });
  });

  it("executes a Lexicon count plan as an aggregation result", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    const organisationId = requireOrganisationId(
      "organisation_query_plan_count",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_query_plan_count",
    );
    const ctx = {
      storage: {
        sql,
        transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
      },
    } as unknown as DurableObjectState;
    new OrganisationDO(ctx, {} as UnitTestEnv);
    sql.exec(
      `INSERT INTO organisation_meta (organisation_id, name, plan, status, created_at)
       VALUES (?, 'Query count', 'beta', 'active', 1)`,
      organisationId,
    );
    const query = parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "count" },
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    const planned = planSafeCommerceQuery({
      query: query.value,
      organisationId,
      merchantId: "merchant_query_plan_count",
      watermark: {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
          0,
          "blotterRevision",
        ),
        commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
          0,
          "commerceRevision",
        ),
      },
      capabilities: capabilitiesForQuery(query.value),
    });
    expect(planned.ok && planned.value.kind === "planned").toBe(true);
    if (!planned.ok || planned.value.kind !== "planned") return;

    const activeOrganisation = await createActiveOrganisationFixture(
      ctx,
      organisationId,
    );
    const result = await activeOrganisation.readCommerceQueryPlan({
      organisationId,
      integrationAccountId,
      planRequest: safePlanRequest(
        query.value,
        organisationId,
        "merchant_query_plan_count",
        planned.value.plan.watermark,
      ),
      plan: planned.value.plan,
    });

    expect(result).toEqual({
      ok: true,
      value: { kind: "count", aggregation: { kind: "count", value: 0n } },
    });
  });

  it("materializes canonical relationship edges and reads one exact definition step", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    const organisationId = requireOrganisationId(
      "organisation_query_relationship",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_query_relationship",
    );
    const ctx = {
      storage: {
        sql,
        transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
      },
    } as unknown as DurableObjectState;
    const organisation = await createActiveOrganisationFixture(
      ctx,
      organisationId,
    );
    sql.exec(
      `INSERT INTO organisation_meta (organisation_id, name, plan, status, created_at)
       VALUES (?, 'Relationship query', 'beta', 'active', 1)`,
      organisationId,
    );
    sql.exec(
      `INSERT INTO commerce_projection (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         revision, lifecycle, projection_json, updated_at, validated_at
       ) VALUES (?, 'shipment', 'shipment_1', ?, 3, 'in_transit', ?, 30, 30)`,
      organisationId,
      integrationAccountId,
      JSON.stringify({
        kind: "shipment",
        projection: {
          orderId: "order_1",
          fulfillmentId: "fulfillment_1",
          provenance: {
            organisationId,
            integrationAccountId,
            source: "shopify",
            resourceType: "shipment",
            resourceId: "shipment_1",
            revision: 3,
            occurredAt: "2026-08-25T14:00:00.000Z",
            observedAt: "2026-08-25T14:00:00.000Z",
          },
        },
      }),
    );
    sql.exec(
      `INSERT INTO commerce_projection (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         revision, lifecycle, projection_json, updated_at, validated_at
       ) VALUES (?, 'production_batch', 'batch_2', ?, 4, 'in_progress', ?, 40, 40)`,
      organisationId,
      integrationAccountId,
      JSON.stringify({
        kind: "production_batch",
        projection: {
          recipeId: "recipe_2",
          demand: { kind: "shipment", shipmentId: "shipment_2" },
          provenance: {
            organisationId,
            integrationAccountId,
            source: "shopify",
            resourceType: "production_batch",
            resourceId: "batch_2",
            revision: 4,
            occurredAt: "2026-08-25T14:00:00.000Z",
            observedAt: "2026-08-25T14:00:00.000Z",
          },
        },
      }),
    );
    rebuildCommerceRelationshipRelationsForOwner(sql, integrationAccountId);

    expect(
      sql
        .exec<{ readonly definition_id: string }>(
          `SELECT DISTINCT definition_id
         FROM commerce_relationship_relation
        WHERE merchant_id = ?
        ORDER BY definition_id`,
          integrationAccountId,
        )
        .toArray(),
    ).toEqual([
      { definition_id: "fulfillment_shipment" },
      { definition_id: "order_shipment" },
      { definition_id: "recipe_revision_production_batch" },
      { definition_id: "shipment_production_batch" },
    ]);
    expect(
      sql
        .exec<{
          readonly source_entity_id: string;
          readonly target_entity_id: string;
        }>(
          `SELECT source_entity_id, target_entity_id
         FROM commerce_relationship_relation
        WHERE merchant_id = ?
          AND relationship_id = ?`,
          integrationAccountId,
          "system:shipment_production_batch:shipment_2:batch_2",
        )
        .toArray(),
    ).toEqual([
      { source_entity_id: "shipment_2", target_entity_id: "batch_2" },
    ]);

    const relationshipQuery = parseCommerceGraphQuery({
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
    expect(relationshipQuery.ok).toBe(true);
    if (
      !relationshipQuery.ok ||
      relationshipQuery.value.kind !== "relationship_traversal"
    )
      return;
    const seed = relationshipQuery.value.seeds[0];
    const relationshipDefinition =
      relationshipQuery.value.relationshipDefinition;
    if (
      seed === undefined ||
      seed.origin !== "system" ||
      relationshipDefinition === null ||
      relationshipDefinition.origin !== "system"
    )
      return;
    const plannedRelationship = requiredPlannedRelationship(
      organisationId,
      "merchant_query_relationship",
      relationshipQuery.value,
    );
    const plan = plannedRelationship.plan;
    const result = await organisation.readCommerceRelationshipStep({
      organisationId,
      integrationAccountId,
      planRequest: plannedRelationship.planRequest,
      plan,
      frontier: [seed],
      remaining: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      relationship_id: "system:order_shipment:order_1:shipment_1",
      relationship_revision: 3,
      source_type_id: "order",
      source_entity_id: "order_1",
      target_type_id: "shipment",
      target_entity_id: "shipment_1",
    });
  });

  it("materializes the locked Unicode fold corpus through contracts Wasm", () => {
    expect(
      materializeCommerceRelationText("Cafe\u0301", "Straße STRASSE ＡＢ"),
    ).toEqual({
      ok: true,
      value: {
        displayNameFolded: "café",
        searchTextFolded: "strasse strasse ab",
      },
    });
  });
});

function safePlanRequest(
  query: CommerceGraphQuery,
  organisationId: ReturnType<typeof requireOrganisationId>,
  merchantId: string,
  watermark: CommerceReadWatermark,
) {
  const request = buildCommerceGraphQueryPlanRequest({
    query,
    organisationId,
    merchantId,
    watermark,
    capabilities: capabilitiesForQuery(query),
    projection: commerceGraphQueryProjection(query),
  });
  if (!request.ok) throw new Error(request.error.code);
  return request.value;
}

function capabilitiesForQuery(
  query: CommerceGraphQuery,
): CommerceQueryCapabilityProfile {
  switch (query.kind) {
    case "entity_by_ref":
      return capabilitiesForEntityType(query.reference);
    case "entity_type_page":
    case "search":
      if (query.entityTypeId === null)
        throw new Error("query fixture requires an entity type");
      return capabilitiesForEntityType(query.entityTypeId);
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
        throw new Error("query fixture requires uniform relationship seeds");
      }
      return capabilitiesForEntityType(seed);
    }
    case "commerce_list_page":
      return listCapabilities(query.listId);
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
        ? listCapabilities(query.source.listId)
        : capabilitiesForEntityType(query.source.entityTypeId);
    case "commerce_context":
      return query.selection.kind === "entity_seeds"
        ? capabilitiesForQuery({
            kind: "relationship_traversal",
            seeds: query.selection.seeds,
            relationshipDefinition: null,
            traversal: query.traversal,
            filter: null,
          })
        : capabilitiesForQuery(query.selection.selector.query);
    default:
      return assertNever(query, "Unexpected query fixture");
  }
}

function capabilitiesForEntityType(
  entityType: CommerceEntityTypeId,
): CommerceQueryCapabilityProfile {
  return entityType.origin === "system"
    ? systemCapabilities(entityType.typeId)
    : customCapabilities(entityType.typeId);
}

function systemCapabilities(
  systemEntityKind: SystemCommerceEntityKind,
): CommerceQueryCapabilityProfile {
  return parseCapabilityProfile({
    kind: "system_mapped",
    systemEntityKind,
    systemSchemaRevision: 1,
    capability: {
      filterableAttributeIds: [],
      sortableAttributeIds: [],
      aggregation: { kind: "count_only" },
    },
  });
}

function customCapabilities(
  entityTypeId: CustomCommerceEntityTypeId,
): CommerceQueryCapabilityProfile {
  return parseCapabilityProfile({
    kind: "commerce_custom",
    entityTypeId,
    publishedRevision: 1,
    capability: {
      filterableAttributeIds: [],
      sortableAttributeIds: [],
      aggregation: { kind: "count_only" },
    },
  });
}

function listCapabilities(
  listId: CommerceListId,
): CommerceQueryCapabilityProfile {
  return parseCapabilityProfile({
    kind: "commerce_list",
    listId,
    listRevision: 1,
    capability: {
      filterableAttributeIds: [],
      sortableAttributeIds: [],
      aggregation: { kind: "count_only" },
    },
  });
}

function capabilitySourceForEntityType(
  entityType: CommerceEntityTypeId,
): Variant<CommerceQueryCapabilityProfile, "saved_commerce_view">["source"] {
  const profile = capabilitiesForEntityType(entityType);
  if (
    profile.kind === "system_mapped" ||
    profile.kind === "commerce_custom" ||
    profile.kind === "commerce_list"
  )
    return profile;
  throw new Error("query fixture produced an invalid saved-view source");
}

function parseCapabilityProfile(
  capabilities: unknown,
): CommerceQueryCapabilityProfile {
  return parseEntityPlaneCapabilityMetadataResponse({
    kind: "capability_metadata",
    organisationId: "organisation_query_schema",
    merchantId: "merchant_query_schema",
    merchantRevision: 1,
    watermark: { kind: "commerce_native", merchantRevision: 1 },
    capabilities,
    projection: {
      attributeIds: [],
      relationshipDefinitions: [],
      includeProvenance: true,
      includeFreshness: true,
    },
  }).capabilities;
}

function requiredPlannedRelationship(
  organisationId: ReturnType<typeof requireOrganisationId>,
  merchantId: string,
  query: Variant<
    import("@purin-labs/commerce-contracts").CommerceGraphQuery,
    "relationship_traversal"
  >,
): {
  plan: import("@purin-labs/commerce-contracts").CommerceQueryPlan;
  planRequest: ReturnType<typeof parseCommerceGraphQueryPlanRequest>;
} {
  const request = parseCommerceGraphQueryPlanRequest({
    query,
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
        0,
        "blotterRevision",
      ),
      commerceExtensionMerchantRevision: parseCommerceSnapshotRevision(
        0,
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
  const outcome = planCommerceGraphQuery(request);
  if (!outcome.ok) throw new Error(outcome.error.code);
  if (outcome.value.kind !== "planned")
    throw new Error(`expected planned relationship, got ${outcome.value.kind}`);
  return { plan: outcome.value.plan, planRequest: request };
}
