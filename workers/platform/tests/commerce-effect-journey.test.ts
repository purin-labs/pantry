import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { URL as NodeUrl } from "node:url";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  parseEntityPlaneCommand,
  parseCommerceGraphQuery,
} from "@purin-labs/commerce-client";
import type {
  CommerceEntity,
  CommerceEntityPlaneEffect,
} from "@purin-labs/commerce-contracts";
import {
  createFinancierSample,
  FINANCIER_SAMPLE_ID,
} from "@purin-labs/area-kitchen/server/bakery/sample";
import {
  buildCommerceEntityPlaneEffect,
  parseCommerceEntityPlaneEffect,
  proposalFromCommand,
} from "@purin-labs/area-commerce/server/entity-plane/proposals";
import { startCommerceWorker } from "./commerce-fixture-worker";
import { requireOrganisationId } from "./test-ids";

const NOW = "2026-10-24T00:00:00Z";
const EXPIRES = "2030-01-01T00:00:00Z";
const ORGANISATION = requireOrganisationId("organisation_effect_journey");
const MERCHANT = "merchant_effect_journey";
it(
  "retains the receipt for a real entity edit and refuses forged or stale evidence across replay",
  { timeout: 60000 },
  effectJourney,
);

async function effectJourney(): Promise<void> {
  const worker = await startCommerceWorker({ now: NOW });
  try {
    const config = {
      baseUrl: worker.baseUrl,
      serviceToken: worker.serviceToken,
      fetch: worker.fetch,
    };
    const provisioned = await new CommerceAdminClient(
      config,
    ).provisionMerchant({
      schemaVersion: "commerce.provision-merchant.v2",
      externalReference: ORGANISATION,
      merchantId: MERCHANT,
      createdAt: NOW,
    });
    expect(provisioned.ok).toBe(true);
    const client = new CommerceEntityPlaneClient(config);
    const sample = await createFinancierSample({
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "effect_operator",
      expiresAt: EXPIRES,
    });
    expect(sample.ok).toBe(true);
    const before = await readProcedure(client);
    const entity = before.entities[0];
    if (entity === undefined) throw new Error("Missing procedure");
    const request = renameRequest(
      "effect_edit",
      before.merchantRevision,
      entity,
    );
    const result = await client.command(request);
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.status !== "accepted")
      throw new Error(result.value.error.code);
    const proposal = proposalFromCommand(request.command);
    if (proposal === null) throw new Error("Missing effect proposal");
    const effect = buildCommerceEntityPlaneEffect(
      proposal,
      result.value.receipt,
    );
    if (effect === null) throw new Error("Missing delivery evidence");
    const parsed = parseCommerceEntityPlaneEffect(effect);
    expect(parsed).toEqual(effect);
    const restored = parseCommerceEntityPlaneEffect(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(restored).toEqual(effect);
    const after = await readProcedure(client);
    expect(after.entities[0]?.displayName).toBe(
      "Financier procedure accepted for tomorrow",
    );
    expect(after.entities[0]?.revision).toBe(Number(entity.revision) + 1);
    expect(effect.receipt.merchantRevision).toBe(after.merchantRevision);

    const replay = await client.command(request);
    expect(replay).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          deliveryId: effect.receipt.deliveryId,
          merchantRevision: effect.receipt.merchantRevision,
        },
      },
    });
    expect(await readProcedure(client)).toEqual(after);
    const stale = await client.command(
      renameRequest("effect_stale", after.merchantRevision, entity),
    );
    expect(stale).toMatchObject({
      ok: true,
      value: { status: "rejected", error: { code: "revision_conflict" } },
    });
    expect(await readProcedure(client)).toEqual(after);

    const forged = effectWithWrongEntity(effect);
    expect(parseCommerceEntityPlaneEffect(forged)).toBeNull();
    expect(
      parseCommerceEntityPlaneEffect({
        ...effect,
        receipt: { ...effect.receipt, deliveryId: null },
      }),
    ).toBeNull();
    const directory = new NodeUrl("../output/plan-78/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new NodeUrl("effect-receipt-http.json", directory),
      JSON.stringify(
        {
          status: "passed",
          effect: restored,
          entity: after.entities[0],
          boundaries: {
            jsonRestorePreserved: true,
            replayPreserved: true,
            staleEditRefused: true,
            forgedEntityRefused: true,
            missingDeliveryRefused: true,
          },
        },
        integerReplacer,
        2,
      ) + "\n",
    );
  } finally {
    await worker.dispose();
  }
}
function renameRequest(
  commandId: string,
  snapshot: number,
  entity: CommerceEntity,
) {
  if (entity.reference.origin !== "custom" || !("typeRevision" in entity))
    throw new Error("Expected a custom procedure");
  return parseEntityPlaneCommand({
    organisationId: ORGANISATION,
    merchantId: MERCHANT,
    commandId,
    expectedMerchantRevision: snapshot,
    authority: {
      kind: "entity_command",
      context: {
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
        principalId: "effect_operator",
        sensitivityCeiling: "restricted",
        expiresAt: EXPIRES,
        causation: { kind: "command", commandId },
      },
      scope: { kind: "entity", entityRef: entity.reference },
      target: {
        entityRef: entity.reference,
        expectedRevision: entity.revision,
      },
    },
    command: {
      kind: "patch_custom_entity",
      command: {
        entityRef: entity.reference,
        typeRevision: entity.typeRevision,
        expectedRevision: entity.revision,
        attributes: entity.attributes,
        displayName: "Financier procedure accepted for tomorrow",
      },
    },
  });
}
async function readProcedure(client: CommerceEntityPlaneClient) {
  const result = await client.query(
    MERCHANT,
    parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_procedure",
        entityId: FINANCIER_SAMPLE_ID,
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    }),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function effectWithWrongEntity(effect: CommerceEntityPlaneEffect) {
  if (effect.kind !== "patch_custom_entity")
    throw new Error("Expected a patch effect");
  return {
    ...effect,
    entityRef: { ...effect.entityRef, entityId: "unrelated_procedure" },
  };
}
function integerReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
