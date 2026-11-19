import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseCommerceExportPresetDigestPayload } from "@purin-labs/commerce-contracts/entity-plane-export";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";

import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import { EntityPlaneService } from "../src/entity-plane/service.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { DeterministicPaymentGateway } from "../src/payments/provider.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const SERVICE_TOKEN = "entity-plane-export-preset-service-token";
const SIGNER = {
  keyId: "entity-plane-export-preset-test",
  publicKeyB64: "entity-plane-export-preset-test-public-key",
  sign: (payload: Uint8Array): string =>
    Buffer.from(payload).toString("base64url"),
};

describe("Underclerk export preset publication", () => {
  it("publishes authoritative evidence and replays without advancing the merchant", async () => {
    const fixture = createFixture();
    const request = exportPresetRequest(
      "organisation_export",
      "merchant_export",
    );

    const first = await fixture.service.publishEntityPlaneExportPreset(request);
    const second =
      await fixture.service.publishEntityPlaneExportPreset(request);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      kind: "published",
      organisationId: "organisation_export",
      merchantId: "merchant_export",
      presetId: "export_coordination",
      presetVersion: 1,
      merchantRevision: 13,
    });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      first.evidence.customEntityTypes.map((entry) => entry.typeId),
    ).toEqual(["trade_partner", "export_document"]);
    expect(
      first.evidence.relationshipDefinitions.map((entry) => entry.definitionId),
    ).toEqual(["trade_partner_order", "shipment_export_document"]);
    expect(
      first.evidence.lists.map((entry) => [
        entry.listId,
        entry.publishedRevision,
      ]),
    ).toEqual([["export_coordination", 1]]);
    expect(
      first.evidence.views.map((entry) => [entry.viewId, entry.revision]),
    ).toEqual([
      ["export_board", 1],
      ["missing_documents", 1],
      ["handoff_due", 1],
      ["trade_partner_follow_up", 1],
    ]);
    expect(
      fixture.database
        .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
        .get("merchant_export"),
    ).toEqual({ revision: 13 });
    fixture.database.close();
  });

  it(
    "publishes and replays export evidence through the authenticated HTTP boundary",
    publishExportJourney,
  );

  it("rejects organisation mismatch and definition drift", async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.publishEntityPlaneExportPreset(
        exportPresetRequest("organisation_other", "merchant_export"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.service.publishEntityPlaneExportPreset(
      exportPresetRequest("organisation_export", "merchant_export"),
    );
    fixture.database
      .prepare(
        "UPDATE relationship_definition SET definition_json = ? WHERE merchant_id = ? AND relationship_definition_id = ? AND revision = ?",
      )
      .run(
        JSON.stringify({
          origin: "custom",
          definitionId: "shipment_export_document",
          sourceType: { origin: "system", typeId: "shipment" },
          targetType: { origin: "custom", typeId: "export_document" },
          sourceLabel: "Drifted documents",
          inverseLabel: "Shipment",
          cardinality: "one_to_many",
          deletionBehavior: "detach",
          sensitivity: "internal",
          revision: 1,
        }),
        "merchant_export",
        "shipment_export_document",
        1,
      );
    await expect(
      fixture.service.publishEntityPlaneExportPreset(
        exportPresetRequest("organisation_export", "merchant_export"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    fixture.database.close();
  });
});

async function publishExportJourney(): Promise<void> {
  const fixture = createFixture();
  const client = new CommerceEntityPlaneClient({
    baseUrl: "https://underclerk.test",
    serviceToken: SERVICE_TOKEN,
    fetch: fixture.api.fetch,
  });
  const request = exportPresetRequest("organisation_export", "merchant_export");
  try {
    const published = await client.publishExportPreset(request);
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.error.message);
    expect(
      published.value.evidence.relationshipDefinitions.map(definitionId),
    ).toEqual(["trade_partner_order", "shipment_export_document"]);
    const payload = parseCommerceExportPresetDigestPayload(published.value);
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error(payload.error.reason);
    expect(createHash("sha256").update(payload.value).digest("hex")).toBe(
      published.value.digest,
    );
    const replay = await client.publishExportPreset(request);
    expect(replay).toEqual(published);
    const wrongOrganisation = await client.publishExportPreset({
      ...request,
      organisationId: "organisation_other",
    });
    expect(wrongOrganisation).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const unauthorized = await fixture.api.fetch(
      "https://underclerk.test/v1/admin/merchants/merchant_export/entity-plane/export-preset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    expect(unauthorized.status).toBe(401);
    const malformed = await fixture.api.fetch(
      "https://underclerk.test/v1/admin/merchants/merchant_export/entity-plane/export-preset",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request, presetId: "other_preset" }),
      },
    );
    expect(malformed.status).toBe(400);
    expect(await client.publishExportPreset(request)).toEqual(published);
    const directory = new URL("../output/plan-78/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new URL("export-preset-http.json", directory),
      `${JSON.stringify(
        {
          status: "passed",
          published: published.value,
          replayPreserved: true,
          wrongOrganisationRefused: true,
          malformedStatus: malformed.status,
          unauthorizedStatus: unauthorized.status,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fixture.database.close();
  }
}
function definitionId(value: { definitionId: string }): string {
  return value.definitionId;
}

function exportPresetRequest(organisationId: string, merchantId: string) {
  return {
    organisationId,
    merchantId,
    presetId: "export_coordination" as const,
    presetVersion: 1 as const,
  };
}

function createFixture(): Readonly<{
  database: NodeCommerceDatabase;
  service: EntityPlaneService;
  api: CommerceHttpApi;
}> {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  const authority = new CommerceAuthority({
    database,
    signer: SIGNER,
    paymentGateway: new DeterministicPaymentGateway(),
    now: () => NOW,
    shippingGateway: createJapanShippingGateway(
      "entity-plane-export-preset-shipping-key",
    ),
  });
  authority.provisionMerchant({
    schemaVersion: "underclerk.provision-merchant.v2",
    externalReference: "organisation_export",
    merchantId: "merchant_export",
    createdAt: NOW,
  });
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: SIGNER,
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "entity-plane-export-preset-buyer-secret",
      now: () => NOW,
    }),
    serviceToken: SERVICE_TOKEN,
    entityPlane: service,
  });
  return { database, service, api };
}
