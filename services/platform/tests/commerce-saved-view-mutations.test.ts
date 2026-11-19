import { describe, expect, it } from "vitest";
import {
  parseCommerceCommandId,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";

import { publishSavedCommerceViewPresentation } from "../src/commerce/entity-plane/saved-view-mutations";
import { parseSavedCommerceViewPresentationPatchRouteBody } from "../src/commerce/entity-plane/routes";
import { buildSavedViewAdministrationAuthority } from "../src/commerce/entity-plane/authority";

describe("saved Commerce view presentation mutations", () => {
  it("publishes the next exact view revision and retains integer filters across JSON", async () => {
    const requests: unknown[] = [];
    const result = await publishSavedCommerceViewPresentation({
      client: clientFor(requests),
      organisationId: "organisation_view",
      merchantId: "merchant_view",
      commandId: parseCommerceCommandId("publish_view_3"),
      authority: savedViewAuthority("publish_view_3", 2),
      patch: viewPatch(2),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        commandId: "publish_view_3",
        target: {
          kind: "saved_commerce_view",
          viewId: "export_board",
          revision: 3,
        },
        merchantRevision: 9,
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedMerchantRevision: 8,
      command: {
        kind: "publish_saved_commerce_view",
        command: {
          view: {
            viewId: "export_board",
            revision: 3,
            filter: { filter: { value: { kind: "integer", value: 2 } } },
            presentation: {
              kind: "table",
              configuration: { density: "spacious", showRowNumbers: true },
            },
          },
        },
      },
    });
  });

  it("rejects a stale view revision before issuing a command", async () => {
    const requests: unknown[] = [];
    const result = await publishSavedCommerceViewPresentation({
      client: clientFor(requests),
      organisationId: "organisation_view",
      merchantId: "merchant_view",
      commandId: parseCommerceCommandId("publish_view_stale"),
      authority: savedViewAuthority("publish_view_stale", 1),
      patch: viewPatch(1),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "revision_conflict", expected: 2, actual: 1 },
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects malformed and path-independent presentation patches", () => {
    expect(
      parseSavedCommerceViewPresentationPatchRouteBody(
        {
          expectedRevision: 2,
          presentation: {
            kind: "table",
            configuration: { density: "compact", showRowNumbers: false },
          },
        },
        "export_board",
      ),
    ).toMatchObject({
      ok: true,
      value: { viewId: "export_board", expectedRevision: 2 },
    });
    expect(
      parseSavedCommerceViewPresentationPatchRouteBody(
        {
          expectedRevision: 2,
          presentation: {
            kind: "board",
            configuration: { laneAttributeId: "stage", cardAttributeIds: [] },
          },
        },
        "export_board",
      ),
    ).toEqual({ ok: false, error: { code: "invalid_query" } });
    expect(
      parseSavedCommerceViewPresentationPatchRouteBody(
        {
          expectedRevision: 2,
          presentation: {
            kind: "table",
            configuration: { density: "compact", showRowNumbers: false },
          },
          filter: { kind: "all" },
        },
        "export_board",
      ),
    ).toEqual({ ok: false, error: { code: "invalid_query" } });
  });
});

function savedViewAuthority(commandId: string, revision: number) {
  const patch = viewPatch(revision);
  const authority = buildSavedViewAdministrationAuthority({
    organisationId: "organisation_view",
    merchantId: "merchant_view",
    principalId: "identity_view",
    expiresAt: "2099-01-01T00:00:00.000Z",
    commandId,
    viewId: patch.viewId,
    expectedRevision: patch.expectedRevision,
  });
  if (!authority.ok) throw new Error("saved-view authority fixture is invalid");
  return authority.value;
}

function viewPatch(expectedRevision: number) {
  const parsed = parseSavedCommerceViewPresentationPatchRouteBody(
    {
      expectedRevision,
      presentation: {
        kind: "table",
        configuration: { density: "spacious", showRowNumbers: true },
      },
    },
    "export_board",
  );
  if (!parsed.ok) throw new Error("saved-view patch fixture is invalid");
  return parsed.value;
}

function clientFor(requests: unknown[]): CommerceEntityPlaneClient {
  return new CommerceEntityPlaneClient({
    baseUrl: "https://underclerk.example",
    serviceToken: "service-token",
    fetch: async (request, init) => {
      const body =
        init?.body === undefined ? null : JSON.parse(String(init.body));
      requests.push(body);
      if (String(request).endsWith("/published-resources")) {
        return jsonResponse({
          kind: "enumerated",
          organisationId: "organisation_view",
          merchantId: "merchant_view",
          merchantRevision: 8,
          entityTypes: [],
          lists: [],
          views: [
            {
              viewId: "export_board",
              name: "Export board",
              source: {
                kind: "entity_type",
                entityTypeId: { origin: "system", typeId: "shipment" },
              },
              filter: {
                kind: "attribute",
                filter: {
                  attributeId: "priority",
                  operator: "equals",
                  value: { kind: "integer", value: 2 },
                },
              },
              sorts: [],
              visibleAttributeIds: ["priority"],
              relationshipColumns: [],
              grouping: null,
              presentation: {
                kind: "table",
                configuration: { density: "compact", showRowNumbers: false },
              },
              revision: 2,
            },
          ],
        });
      }
      return jsonResponse({
        status: "accepted",
        receipt: {
          commandId: body.commandId,
          outcome: "applied",
          target: {
            kind: "saved_commerce_view",
            viewId: "export_board",
            revision: 3,
          },
          merchantRevision: 9,
          committedAt: "2026-08-26T00:00:00.000Z",
          deliveryId: null,
          signer: {
            keyId: "key_view",
            algorithm: "ed25519",
            signature: "signature_view",
          },
        },
      });
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
