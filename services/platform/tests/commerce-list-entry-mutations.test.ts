import { describe, expect, it } from "vitest";
import {
  parseCommerceCommandId,
  CommerceEntityPlaneClient,
} from "@seams/commerce-client";

import { patchPublishedCommerceListEntry } from "../src/commerce/entity-plane/list-entry-mutations";
import { parseCommerceListEntryPatchRouteBody } from "../src/commerce/entity-plane/routes";
import { buildCommerceListEntryCommandAuthority } from "../src/commerce/entity-plane/authority";

describe("human Commerce List entry mutations", () => {
  it("does not issue a command when the exact entry is unpublished", async () => {
    const requests: unknown[] = [];
    const result = await patchPublishedCommerceListEntry({
      client: clientFor(requests, 404),
      organisationId: "organisation_patch",
      merchantId: "merchant_patch",
      commandId: parseCommerceCommandId("patch_entry_missing"),
      authority: listEntryAuthority("patch_entry_missing"),
      command: patchCommand(),
    });
    expect(result).toEqual({ ok: false, error: { code: "not_published" } });
    expect(requests).toHaveLength(1);
  });

  it("rejects a receipt that does not advance the exact entry revision", async () => {
    const result = await patchPublishedCommerceListEntry({
      client: clientFor([], 200, 5),
      organisationId: "organisation_patch",
      merchantId: "merchant_patch",
      commandId: parseCommerceCommandId("patch_entry_bad_receipt"),
      authority: listEntryAuthority("patch_entry_bad_receipt"),
      command: patchCommand(),
    });
    expect(result).toEqual({ ok: false, error: { code: "receipt_mismatch" } });
  });

  it("returns the current entry revision when the published entry changed", async () => {
    const requests: unknown[] = [];
    const result = await patchPublishedCommerceListEntry({
      client: clientFor(requests, 200, 5, 4),
      organisationId: "organisation_patch",
      merchantId: "merchant_patch",
      commandId: parseCommerceCommandId("patch_entry_stale"),
      authority: listEntryAuthority("patch_entry_stale"),
      command: patchCommand(),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "revision_conflict", expected: 4, actual: 3 },
    });
    expect(requests).toHaveLength(1);
  });
});

function listEntryAuthority(commandId: string) {
  const command = patchCommand();
  const authority = buildCommerceListEntryCommandAuthority({
    organisationId: "organisation_patch",
    merchantId: "merchant_patch",
    principalId: "identity_patch",
    expiresAt: "2099-01-01T00:00:00.000Z",
    commandId,
    entry: command.command.target.entry,
  });
  if (!authority.ok) throw new Error("list-entry authority fixture is invalid");
  return authority.value;
}

function patchCommand() {
  const parsed = parseCommerceListEntryPatchRouteBody(
    {
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
    },
    "entry_1",
  );
  if (!parsed.ok) throw new Error("patch command fixture is invalid");
  return parsed.value;
}

function clientFor(
  requests: unknown[],
  metadataStatus = 200,
  receiptRevision = 4,
  metadataRevision = 3,
): CommerceEntityPlaneClient {
  return new CommerceEntityPlaneClient({
    baseUrl: "https://underclerk.example",
    serviceToken: "service-token",
    fetch: async (request, init) => {
      const url = String(request);
      const body =
        init?.body === undefined ? null : JSON.parse(String(init.body));
      requests.push(body);
      if (url.endsWith("/published-resources")) {
        if (metadataStatus !== 200)
          return jsonResponse({ error: "not found" }, metadataStatus);
        return jsonResponse({
          kind: "resolved",
          organisationId: "organisation_patch",
          merchantId: "merchant_patch",
          merchantRevision: 7,
          resource: {
            kind: "commerce_list_entry",
            entry: {
              entryId: "entry_1",
              listId: "export_coordination",
              revision: metadataRevision,
            },
            listRevision: 1,
            entityTypeId: { origin: "system", typeId: "shipment" },
            entityRef: {
              origin: "system",
              typeId: "shipment",
              entityId: "shipment_1",
            },
          },
        });
      }
      return jsonResponse({
        status: "accepted",
        receipt: {
          commandId: body.commandId,
          outcome: "applied",
          target: {
            kind: "commerce_list_entry",
            entry: {
              entryId: "entry_1",
              listId: "export_coordination",
              revision: receiptRevision,
            },
            revision: receiptRevision,
          },
          merchantRevision: 8,
          committedAt: "2026-08-26T00:00:00.000Z",
          deliveryId: "delivery_patch_entry_1",
          signer: {
            keyId: "key_patch",
            algorithm: "ed25519",
            signature: "signature_patch",
          },
        },
      });
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
