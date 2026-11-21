import { describe, expect, it } from "vitest";

import {
  parseCommerceActivityRouteBody,
  parseCommerceGraphChangesRequest,
  parseCommerceGraphQuery,
  parseCommerceGraphRouteBody,
  parseCommerceListEntryPatchRouteBody,
} from "../src/commerce/entity-plane/routes";

describe("commerce entity-plane route boundary", () => {
  it("accepts only the exact path-bound list-entry patch branch", () => {
    const command = {
      kind: "patch_commerce_list_entry",
      command: {
        target: {
          entry: {
            entryId: "entry_1",
            listId: "export_coordination",
            revision: 3,
          },
          expectedRevision: 3,
        },
        expectedListRevision: 1,
        attributeValues: [
          {
            attributeId: "ext_stage",
            scope: {
              kind: "merchant_extension",
              entityTypeId: "shipment",
              schemaRevision: 1,
            },
            definitionRevision: 1,
            sensitivity: "internal",
            value: { kind: "status", value: "documents_ready" },
          },
        ],
      },
    };
    expect(
      parseCommerceListEntryPatchRouteBody(command, "entry_1"),
    ).toMatchObject({
      ok: true,
      value: { kind: "patch_commerce_list_entry" },
    });
    expect(parseCommerceListEntryPatchRouteBody(command, "entry_2")).toEqual({
      ok: false,
      error: { code: "invalid_query" },
    });
    expect(
      parseCommerceListEntryPatchRouteBody(
        { ...command, unexpected: true },
        "entry_1",
      ),
    ).toEqual({
      ok: false,
      error: { code: "invalid_query" },
    });
  });

  it("parses bounded merchant revision change cursors", () => {
    expect(parseCommerceGraphChangesRequest(new URLSearchParams())).toEqual({
      ok: true,
      value: { after: 0, limit: 100 },
    });
    expect(
      parseCommerceGraphChangesRequest(new URLSearchParams("after=7&limit=25")),
    ).toEqual({
      ok: true,
      value: { after: 7, limit: 25 },
    });
    expect(
      parseCommerceGraphChangesRequest(new URLSearchParams("after=-1")),
    ).toEqual({
      ok: false,
      error: { code: "invalid_query" },
    });
    expect(
      parseCommerceGraphChangesRequest(new URLSearchParams("limit=101")),
    ).toEqual({
      ok: false,
      error: { code: "invalid_query" },
    });
  });

  it("parses a complete entity page query at the request boundary", () => {
    const parsed = parseCommerceGraphRouteBody({
      query: {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "order" },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 1, resultLimit: 25 },
      },
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "order" },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 1, resultLimit: 25 },
      },
    });
  });

  it("rejects malformed identity, pagination, and sensitivity input", () => {
    expect(
      parseCommerceGraphQuery({
        kind: "entity_by_ref",
        reference: { origin: "system", typeId: "unknown", entityId: "order_1" },
        traversal: { maxDepth: 1, resultLimit: 10 },
        filter: null,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_query" } });

    expect(
      parseCommerceGraphQuery({
        kind: "commerce_context",
        selection: { kind: "entity_seeds", seeds: [] },
        traversal: { maxDepth: 1, resultLimit: 10 },
        allowedSensitivity: "restricted",
        allowedAttributeIds: [],
        freshnessRequirement: "any",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_query" } });
  });

  it("parses exact entity, custom relationship, and list-entry activity references", () => {
    expect(
      parseCommerceActivityRouteBody({
        resource: {
          kind: "entity",
          reference: { origin: "system", typeId: "order", entityId: "order_1" },
        },
        limit: 25,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        resource: {
          kind: "entity",
          reference: { origin: "system", typeId: "order", entityId: "order_1" },
        },
        limit: 25,
      },
    });
    expect(
      parseCommerceActivityRouteBody({
        resource: {
          kind: "relationship",
          reference: {
            origin: "custom",
            relationshipId: "relationship_1",
            definition: {
              origin: "custom",
              definitionId: "definition_1",
              revision: 2,
            },
            revision: 3,
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        resource: {
          kind: "relationship",
          reference: { origin: "custom", relationshipId: "relationship_1" },
        },
        limit: 50,
      },
    });
    expect(
      parseCommerceActivityRouteBody({
        resource: {
          kind: "relationship",
          reference: {
            origin: "custom",
            relationshipId: "relationship_1",
            definition: {
              origin: "custom",
              definitionId: "definition_1",
              revision: 2,
            },
            revision: 3,
            unexpected: true,
          },
        },
      }),
    ).toEqual({ ok: false, error: { code: "invalid_query" } });
    expect(
      parseCommerceActivityRouteBody({
        resource: {
          kind: "list_entry",
          reference: {
            listId: "export_coordination",
            entryId: "entry_1",
            revision: 2,
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        resource: {
          kind: "list_entry",
          reference: {
            listId: "export_coordination",
            entryId: "entry_1",
            revision: 2,
          },
        },
        limit: 50,
      },
    });
  });
});
