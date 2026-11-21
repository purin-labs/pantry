import { describe, expect, it, vi } from "vitest";
import { isSystemCommerceEntity } from "@purin-labs/commerce-contracts";

import {
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseCommerceGraphQueryPlanRequest,
  parseCommerceGraphResponse,
  type CommerceEntityPlaneFetch,
} from "@purin-labs/commerce-client";
import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceEntity,
  CommerceEntityRef,
  CommerceGraphQueryResult,
  CommerceRelationship,
} from "@purin-labs/commerce-contracts";

import { assembleCommerceContext } from "../src/commerce/entity-plane/context-read";
import { buildSavedSelectorCommerceReadAuthority } from "../src/commerce/entity-plane/authority";
import {
  handleCommerceGraphRoute,
  parseCommerceGraphRouteBody,
} from "../src/commerce/entity-plane/routes";
import { CommerceGraphReader } from "../src/commerce/entity-plane/graph-reader";
import { CommerceEngineSource } from "../src/commerce/entity-plane/commerce-source";
import { parseOrganisationId as parsePlatformOrganisationId } from "../src/ids";
import { planCommerceGraphQuery } from "../src/commerce/commerce-wasm";
import { isRecord } from "@purin-labs/std";

const ORGANISATION_ID = "organisation_phase4_context";
const MERCHANT_ID = "merchant_phase4_context";
const INTEGRATION_ID = "integration_phase4_context";
const NOW = "2026-08-26T00:00:00.000Z";
const OBSERVED_AT = "2026-08-25T00:00:00.000Z";

describe("commerce entity-plane context parity", () => {
  it("uses the same authorized export subgraph for portal and private Agent context boundaries", async () => {
    const graph = exportGraph();
    const organisationId = required(
      parsePlatformOrganisationId(ORGANISATION_ID),
    );
    const portalBody = {
      query: {
        kind: "relationship_traversal",
        seeds: [
          { origin: "system", typeId: "shipment", entityId: "shipment_export" },
        ],
        relationshipDefinition: null,
        traversal: { maxDepth: 2, resultLimit: 20 },
        filter: null,
      },
    };
    const parsedPortal = parseCommerceGraphRouteBody(portalBody);
    expect(parsedPortal.ok).toBe(true);
    if (!parsedPortal.ok) return;
    const portalAuthority = buildSavedSelectorCommerceReadAuthority({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      principalId: "principal_phase4_context",
      sensitivityCeiling: "internal",
      expiresAt: "2026-08-27T00:00:00.000Z",
      commandId: "command_phase4_context",
      selectorId: "selector_phase4_context",
      selectorRevision: 1,
      query: parsedPortal.value,
    });
    expect(portalAuthority.ok).toBe(true);
    if (!portalAuthority.ok) return;

    const contextParsed = parseCommerceGraphQuery({
      kind: "commerce_context",
      selection: {
        kind: "selector",
        selector: {
          selectorId: "selector_phase4_context",
          revision: 1,
          query: portalBody.query,
        },
      },
      traversal: { maxDepth: 0, resultLimit: 20 },
      allowedSensitivity: "internal",
      allowedAttributeIds: [],
      freshnessRequirement: "any",
    });
    expect(contextParsed.kind).toBe("commerce_context");
    if (contextParsed.kind !== "commerce_context") return;
    if (contextParsed.selection.kind !== "selector") return;
    const { kind: _kind, ...contextRequest } = contextParsed;
    const requestAuthority: RequestAuthority = {
      kind: "workflow",
      organisationId,
      workflowId: "workflow_phase4_context",
      workflowRevision: 1,
    };
    const contextGrant = {
      grantId: "grant_phase4_context",
      organisationId,
      subject: {
        kind: "workflow" as const,
        workflowKind: "cue_subscription" as const,
        workflowId: requestAuthority.workflowId,
        workflowRevision: requestAuthority.workflowRevision,
      },
      target: {
        kind: "commerce_read" as const,
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        scope: {
          kind: "saved_selector" as const,
          selector: contextParsed.selection.selector,
        },
      },
      provenance: {
        kind: "integration_setup" as const,
        integrationAccountId: INTEGRATION_ID,
        setupRevision: 1,
        materializationReceiptId: "receipt_phase4_context",
      },
      lifecycle: { kind: "active" as const, revision: 1, activatedAt: 1 },
    };

    const client = new CommerceEntityPlaneClient({
      baseUrl: "https://commerce.phase4.test",
      serviceToken: "phase4-test-token",
      fetch: commerceFetch(graph),
    });
    const commerceEngine = new CommerceEngineSource({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      integrationAccountId: INTEGRATION_ID,
      client,
    });
    const reader = new CommerceGraphReader({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      commerce: commerceEngine,
    });

    const portal = await handleCommerceGraphRoute({
      body: portalBody,
      reader,
      authority: portalAuthority.value,
      now: NOW,
    });
    const agent = await assembleCommerceContext({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      grants: [contextGrant],
      requestAuthority,
      causationId: "turn_phase4_context",
      request: contextRequest,
      reader,
      now: NOW,
    });
    expect(portal.ok).toBe(true);
    expect(agent.ok).toBe(true);
    if (!portal.ok || !agent.ok) return;
    expect(portal.value.entities).toHaveLength(5);
    expect(portal.value.relationships).toHaveLength(4);
    expect(canonicalGraph(portal.value)).toEqual(canonicalGraph(agent.value));
    expect(canonicalGraph(portal.value).provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: "order_export", revision: 1 }),
        expect.objectContaining({ resourceId: "shipment_export", revision: 1 }),
        expect.objectContaining({
          resourceId: "production_batch_export",
          revision: 1,
        }),
      ]),
    );

    const readerQuery = vi.spyOn(reader, "query");
    readerQuery.mockClear();
    const missingGrant = await assembleCommerceContext({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      grants: [],
      requestAuthority,
      causationId: "turn_phase4_context_missing",
      request: contextRequest,
      reader,
      now: NOW,
    });
    expect(missingGrant).toEqual({
      ok: false,
      error: { code: "commerce_context_authority_denied" },
    });
    expect(readerQuery).not.toHaveBeenCalled();

    const mismatchedGrant = await assembleCommerceContext({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      grants: [
        {
          ...contextGrant,
          subject: {
            kind: "workflow",
            workflowKind: "cue_subscription",
            workflowId: "other_workflow",
            workflowRevision: 1,
          },
        },
      ],
      requestAuthority,
      causationId: "turn_phase4_context_mismatch",
      request: contextRequest,
      reader,
      now: NOW,
    });
    expect(mismatchedGrant).toEqual({
      ok: false,
      error: { code: "commerce_context_authority_denied" },
    });
    expect(readerQuery).not.toHaveBeenCalled();
  });
});

function commerceFetch(
  graph: CommerceGraphQueryResult,
): CommerceEntityPlaneFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/system-extensions")) {
      return jsonResponse({
        merchantId: MERCHANT_ID,
        merchantRevision: 7,
        sidecars: [],
      });
    }
    const body = await request.json();
    if (path.endsWith("/capability-metadata")) {
      return jsonResponse({
        kind: "capability_metadata",
        organisationId: ORGANISATION_ID,
        merchantId: MERCHANT_ID,
        merchantRevision: 7,
        watermark: { kind: "commerce_native", merchantRevision: 7 },
        capabilities: systemCapabilities("shipment"),
        projection: {
          attributeIds: [],
          relationshipDefinitions: [],
          includeProvenance: true,
          includeFreshness: true,
        },
      });
    }
    const planRequestValue =
      isRecord(body) && isRecord(body.planRequest) ? body.planRequest : body;
    const planRequest = parseCommerceGraphQueryPlanRequest(planRequestValue);
    const planned = planCommerceGraphQuery(planRequest);
    if (!planned.ok || planned.value.kind !== "planned") {
      throw new Error("Lexicon did not plan the context proof request");
    }
    return jsonResponse({
      kind: "planned",
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      merchantRevision: 7,
      plan: planned.value.plan,
      result: graph,
      hasMore: false,
    });
  };
}

function systemCapabilities(systemEntityKind: "shipment") {
  return {
    kind: "system_mapped" as const,
    systemEntityKind,
    systemSchemaRevision: 1,
    capability: {
      filterableAttributeIds: [],
      sortableAttributeIds: [],
      aggregation: { kind: "count_only" as const },
    },
  };
}

function exportGraph(): CommerceGraphQueryResult {
  const parsed = parseCommerceGraphResponse({
    merchantRevision: 7,
    entities: [
      {
        reference: {
          origin: "custom",
          typeId: "trade_partner",
          entityId: "trade_partner_東京",
        },
        revision: 1,
        displayName: "東京 Trade Partner",
        attributes: [],
        typeRevision: 1,
        state: { state: "active" },
        sensitivity: "internal",
      },
      systemEntity("order", "order_export", "Export order", "commerce_order"),
      systemEntity(
        "shipment",
        "shipment_export",
        "Export shipment",
        "shipment",
      ),
      {
        reference: {
          origin: "custom",
          typeId: "export_document",
          entityId: "export_document_é",
        },
        revision: 1,
        displayName: "Export document é",
        attributes: [],
        typeRevision: 1,
        state: { state: "active" },
        sensitivity: "internal",
      },
      systemEntity(
        "production_batch",
        "production_batch_export",
        "Export batch",
        "production_batch",
      ),
    ],
    relationships: [
      customRelationship(
        "trade_partner_orders",
        {
          origin: "custom",
          typeId: "trade_partner",
          entityId: "trade_partner_東京",
        },
        { origin: "system", typeId: "order", entityId: "order_export" },
        "trade_partner_orders",
      ),
      systemRelationship(
        "order_shipment",
        { origin: "system", typeId: "order", entityId: "order_export" },
        { origin: "system", typeId: "shipment", entityId: "shipment_export" },
        "order_shipment",
      ),
      customRelationship(
        "shipment_export_documents",
        { origin: "system", typeId: "shipment", entityId: "shipment_export" },
        {
          origin: "custom",
          typeId: "export_document",
          entityId: "export_document_é",
        },
        "shipment_export_documents",
      ),
      systemRelationship(
        "shipment_production_batch",
        { origin: "system", typeId: "shipment", entityId: "shipment_export" },
        {
          origin: "system",
          typeId: "production_batch",
          entityId: "production_batch_export",
        },
        "shipment_production_batch",
      ),
    ],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  });
  const systemEntities = parsed.entities.filter(isSystemCommerceEntity);
  return {
    ...parsed,
    provenance: systemEntities.map(entityProvenance),
    freshness: systemEntities.map(entityFreshness),
  };
}
function entityProvenance(
  entity: Extract<CommerceEntity, { reference: { origin: "system" } }>,
) {
  return entity.provenance;
}
function entityFreshness(
  entity: Extract<CommerceEntity, { reference: { origin: "system" } }>,
) {
  return entity.freshness;
}

function systemEntity(
  typeId: "order" | "shipment" | "production_batch",
  entityId: string,
  displayName: string,
  resourceType: "commerce_order" | "shipment" | "production_batch",
) {
  return {
    reference: { origin: "system" as const, typeId, entityId },
    revision: 1,
    displayName,
    attributes: [],
    provenance: {
      organisationId: ORGANISATION_ID,
      integrationAccountId: INTEGRATION_ID,
      source: "commerce" as const,
      resourceType,
      resourceId: entityId,
      revision: 1,
      occurredAt: OBSERVED_AT,
      observedAt: OBSERVED_AT,
    },
    freshness: { state: "current" as const, observedAt: OBSERVED_AT },
  };
}

function customRelationship(
  definitionId: string,
  source: RawEntityReference,
  target: RawEntityReference,
  relationshipId: string,
) {
  return {
    origin: "custom" as const,
    relationshipId,
    definition: { origin: "custom" as const, definitionId, revision: 1 },
    sensitivity: "internal" as const,
    source,
    target,
    revision: 1,
  };
}

function systemRelationship(
  definitionId: "order_shipment" | "shipment_production_batch",
  source: RawSystemEntityReference,
  target: RawSystemEntityReference,
  relationshipId: string,
) {
  return {
    origin: "system" as const,
    relationshipId: `system:${relationshipId}:${source.entityId}:${target.entityId}`,
    definition: { origin: "system" as const, definitionId, revision: 1 },
    sensitivity: "internal" as const,
    source,
    target,
    revision: 1,
    provenance: {
      organisationId: ORGANISATION_ID,
      integrationAccountId: INTEGRATION_ID,
      source: "commerce" as const,
      resourceType:
        definitionId === "order_shipment"
          ? ("commerce_order" as const)
          : ("shipment" as const),
      resourceId: source.entityId,
      revision: 1,
      occurredAt: OBSERVED_AT,
      observedAt: OBSERVED_AT,
    },
  };
}

function canonicalGraph(result: CommerceGraphQueryResult) {
  return {
    merchantRevision: result.merchantRevision,
    entities: [...result.entities].sort(compareEntities),
    relationships: [...result.relationships].sort(compareRelationships),
    provenance: [...result.provenance].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    ),
    freshness: [...result.freshness].sort((left, right) =>
      freshnessKey(left).localeCompare(freshnessKey(right)),
    ),
  };
}

type RawEntityReference = Readonly<{
  origin: "custom" | "system";
  typeId: string;
  entityId: string;
}>;

type RawSystemEntityReference = RawEntityReference &
  Readonly<{ origin: "system" }>;

function freshnessKey(
  freshness: CommerceGraphQueryResult["freshness"][number],
): string {
  switch (freshness.state) {
    case "current":
    case "stale":
      return freshness.observedAt;
    case "unavailable":
      return freshness.reason;
  }
}

function compareEntities(left: CommerceEntity, right: CommerceEntity): number {
  return entityKey(left.reference).localeCompare(entityKey(right.reference));
}

function compareRelationships(
  left: CommerceRelationship,
  right: CommerceRelationship,
): number {
  return String(left.relationshipId).localeCompare(
    String(right.relationshipId),
  );
}

function entityKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
