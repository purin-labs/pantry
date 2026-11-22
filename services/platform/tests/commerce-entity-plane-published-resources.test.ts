import { describe, expect, it } from "vitest";
import { parseCommerceRelationshipRef } from "@purin-labs/commerce-client";

import {
  createPublishedResourceClient,
  enumeratePublishedResources,
  resolvePublishedResponsibilityScope,
} from "@purin-labs/area-commerce/server/entity-plane/published-resources";

const ORGANISATION = "organisation_published_resources";
const MERCHANT = "merchant_published_resources";

describe("Platform published-resource boundary", () => {
  it("returns resolved evidence only for the exact entity-type reference", async () => {
    const client = clientFor({
      kind: "resolved",
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      merchantRevision: 8,
      resource: {
        kind: "entity_type",
        entityType: {
          origin: "custom",
          typeId: "trade_partner",
          publishedRevision: 3,
        },
      },
    });
    const result = await resolvePublishedResponsibilityScope({
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "resolved", resource: { kind: "entity_type" } },
    });
  });

  it("compares the complete custom relationship reference", async () => {
    const client = clientFor({
      kind: "resolved",
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      merchantRevision: 9,
      resource: {
        kind: "relationship",
        relationship: {
          origin: "custom",
          relationshipId: "partner_document",
          definition: {
            origin: "custom",
            definitionId: "partner_document",
            revision: 2,
          },
          sensitivity: "internal",
          source: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          target: {
            origin: "custom",
            typeId: "export_document",
            entityId: "document_a",
          },
          revision: 4,
        },
      },
    });
    const exact = await resolvePublishedResponsibilityScope({
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      scope: {
        kind: "relationship",
        relationship: parseCommerceRelationshipRef({
          origin: "custom",
          relationshipId: "partner_document",
          definition: {
            origin: "custom",
            definitionId: "partner_document",
            revision: 2,
          },
          revision: 4,
        }),
      },
    });
    expect(exact.ok).toBe(true);

    const wrongDefinition = await resolvePublishedResponsibilityScope({
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      scope: {
        kind: "relationship",
        relationship: parseCommerceRelationshipRef({
          origin: "custom",
          relationshipId: "partner_document",
          definition: {
            origin: "custom",
            definitionId: "partner_document",
            revision: 3,
          },
          revision: 4,
        }),
      },
    });
    expect(wrongDefinition).toEqual({
      ok: false,
      error: { code: "not_published" },
    });
  });

  it("fails closed for a missing published resource and a cross-organisation response", async () => {
    const missing = await resolvePublishedResponsibilityScope({
      client: clientFor({ ok: false }, 404),
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      scope: { kind: "commerce_list", listId: "missing_list" },
    });
    expect(missing).toEqual({ ok: false, error: { code: "not_published" } });

    const crossOrganisation = await enumeratePublishedResources({
      client: clientFor({
        kind: "enumerated",
        organisationId: "organisation_other",
        merchantId: MERCHANT,
        merchantRevision: 1,
        entityTypes: [],
        lists: [],
        views: [],
      }),
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
    });
    expect(crossOrganisation).toEqual({
      ok: false,
      error: { code: "organisation_mismatch" },
    });
  });
});

function clientFor(body: unknown, status = 200) {
  const client = createPublishedResourceClient({
    baseUrl: "https://commerce.example",
    serviceToken: "service-token",
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
  if (client === null) throw new Error("client fixture failed");
  return client;
}
