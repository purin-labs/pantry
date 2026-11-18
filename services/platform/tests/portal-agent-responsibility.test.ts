import { describe, expect, it } from "vitest";

import { parseEntityPlanePublishedResourceMetadataResponse } from "@seams/commerce-client";
import { parseAgentOperationForm, parseAgentOperationsResponse } from "@seams/control-api/portal/agent-operations";

describe("portal agent responsibility-scope boundary", () => {
  it("parses and displays every published responsibility-scope branch", () => {
    const snapshot = parseAgentOperationsResponse({
      ok: true,
      operations: {
        areas: [],
        responsibilityScopes: [
          scopeRecord("entity", {
            kind: "entity_type",
            entityTypeId: { origin: "system", typeId: "product" },
          }),
          scopeRecord("relationship", {
            kind: "relationship",
            relationship: {
              origin: "system",
              relationshipId: "relationship_1",
              definition: {
                origin: "system",
                definitionId: "order_shipment",
                revision: 1,
              },
              revision: 1,
            },
          }),
          scopeRecord("list", { kind: "commerce_list", listId: "list_1" }),
          scopeRecord("entry", {
            kind: "commerce_list_entry",
            entry: { entryId: "entry_1", listId: "list_1", revision: 1 },
          }),
          scopeRecord("selector", {
            kind: "saved_selector",
            selector: {
              selectorId: "view_1",
              revision: 3,
              query: {
                kind: "saved_commerce_view",
                viewId: "view_1",
                pagination: { limit: 50, cursor: null },
              },
            },
          }),
        ],
        definitions: [],
        installations: [],
        skills: [],
        bindings: [],
        cueBindings: [],
        scheduleBindings: [],
        governance: [],
        escalationPolicies: [],
        configurationProposals: [],
        activeCases: [],
        commerceExceptions: {
          kind: "unavailable",
          reason: "commerce_system_unavailable",
        },
        actionLedger: [],
      },
    });

    expect(
      snapshot.responsibilityScopes.map((record) => record.scope.kind),
    ).toEqual([
      "entity_type",
      "relationship",
      "commerce_list",
      "commerce_list_entry",
      "saved_selector",
    ]);
    expect(() =>
      parseAgentOperationsResponse({
        ok: true,
        operations: {
          areas: [],
          responsibilityScopes: [
            scopeRecord("extra", {
              kind: "commerce_list",
              listId: "list_1",
              extra: true,
            }),
          ],
          definitions: [],
          installations: [],
          skills: [],
          bindings: [],
          cueBindings: [],
          scheduleBindings: [],
          governance: [],
          escalationPolicies: [],
          configurationProposals: [],
          activeCases: [],
          commerceExceptions: {
            kind: "unavailable",
            reason: "commerce_system_unavailable",
          },
          actionLedger: [],
        },
      }),
    ).toThrow("Agent responsibility scope response is invalid.");
  });

  it("accepts only current published selections and builds a bounded saved selector", () => {
    const metadata = parseEntityPlanePublishedResourceMetadataResponse({
      kind: "enumerated",
      organisationId: "organisation_portal",
      merchantId: "merchant_portal",
      merchantRevision: 12,
      entityTypes: [
        {
          origin: "custom",
          typeId: "trade_partner",
          publishedRevision: 1,
        },
      ],
      lists: [
        {
          listId: "list_1",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
          name: "Partner queue",
          membership: "unique_entity",
          entryAttributeDefinitions: [],
          publishedRevision: 1,
        },
      ],
      views: [
        {
          viewId: "view_1",
          name: "Partner follow-up",
          source: {
            kind: "entity_type",
            entityTypeId: { origin: "custom", typeId: "trade_partner" },
          },
          filter: { kind: "all" },
          sorts: [],
          visibleAttributeIds: ["status"],
          relationshipColumns: [],
          grouping: null,
          presentation: {
            kind: "table",
            configuration: { density: "comfortable", showRowNumbers: true },
          },
          revision: 3,
        },
      ],
    });
    if (metadata.kind !== "enumerated")
      throw new Error("expected an enumerated metadata response");
    const values = new FormData();
    values.set("areaId", "area_catalog");
    values.set("resourceKey", "saved_selector:view_1");

    expect(
      parseAgentOperationForm("publish_responsibility_scope", values, {
        publishedResources: metadata,
      }),
    ).toEqual({
      ok: true,
      command: {
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: {
          kind: "saved_selector",
          selector: {
            selectorId: "view_1",
            revision: 3,
            query: {
              kind: "saved_commerce_view",
              viewId: "view_1",
              pagination: { limit: 50, cursor: null },
            },
          },
        },
      },
    });

    const entityValues = new FormData();
    entityValues.set("areaId", "area_catalog");
    entityValues.set("resourceKey", "entity_type:custom:trade_partner");
    expect(
      parseAgentOperationForm("publish_responsibility_scope", entityValues, {
        publishedResources: metadata,
      }),
    ).toEqual({
      ok: true,
      command: {
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
        },
      },
    });

    const listValues = new FormData();
    listValues.set("areaId", "area_catalog");
    listValues.set("resourceKey", "commerce_list:list_1");
    expect(
      parseAgentOperationForm("publish_responsibility_scope", listValues, {
        publishedResources: metadata,
      }),
    ).toEqual({
      ok: true,
      command: {
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: { kind: "commerce_list", listId: "list_1" },
      },
    });

    values.set("resourceId", "view_1");
    values.delete("resourceKey");
    expect(
      parseAgentOperationForm("publish_responsibility_scope", values, {
        publishedResources: metadata,
      }),
    ).toEqual({
      ok: false,
      message: "Complete the required operation fields.",
    });
  });
});

function scopeRecord(
  scopeId: string,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  return {
    scopeId,
    organisationId: "organisation_portal",
    areaId: "area_catalog",
    scope,
    lifecycle: "published",
    revision: 1,
    publishedAt: 100,
  };
}
