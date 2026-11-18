import { describe, expect, it } from "vitest";

import {
  composeCommerceActivity,
  readCommerceActivity,
} from "../src/commerce/entity-plane/activity";
import { parseCommerceEntityPlaneEffect } from "../src/commerce/entity-plane/proposals";
import type { CommerceActivityResource } from "@seams/control-api";
import { requireOrganisationId } from "./test-ids";

describe("commerce entity-plane activity", () => {
  it("composes only records for the exact entity reference", () => {
    const resource = entityResource("order", "order_1");
    const activity = composeCommerceActivity({
      resource,
      sources: {
        blotterHistory: [
          {
            resource,
            entry: {
              eventId: "event_1",
              disposition: "applied",
              projectionKind: "commerce_order",
              canonicalId: "order_1",
              revision: 2,
              occurredAt: "2026-08-25T10:00:00.000Z",
              processedAt: 1,
              lastSeenAt: 1,
              deliveryCount: 1,
            },
          },
          {
            resource: entityResource("order", "order_2"),
            entry: {
              eventId: "event_2",
              disposition: "applied",
              projectionKind: "commerce_order",
              canonicalId: "order_2",
              revision: 3,
              occurredAt: "2026-08-25T11:00:00.000Z",
              processedAt: 1,
              lastSeenAt: 1,
              deliveryCount: 1,
            },
          },
        ],
        cases: [
          {
            resource,
            caseId: "case_1",
            state: "open",
            occurredAt: "2026-08-25T12:00:00.000Z",
          },
        ],
        proposals: [
          {
            resource,
            proposalId: "proposal_1",
            state: "confirmed",
            occurredAt: "2026-08-25T13:00:00.000Z",
          },
        ],
        approvals: [],
        effects: [],
        underclerkReceipts: [],
        actionLedger: [],
      },
    });

    expect(activity.map((item) => item.kind)).toEqual([
      "proposal",
      "case",
      "blotter_history",
    ]);
    expect(
      activity.every(
        (item) =>
          item.resource.kind === "entity" &&
          item.resource.reference.entityId === "order_1",
      ),
    ).toBe(true);
  });

  it("matches list entries by list, entry, and revision", () => {
    const resource = listEntryResource("export_coordination", "entry_1", 4);
    const activity = composeCommerceActivity({
      resource,
      sources: {
        blotterHistory: [],
        cases: [
          {
            resource,
            caseId: "case_1",
            state: "open",
            occurredAt: "2026-08-25T10:00:00.000Z",
          },
          {
            resource: listEntryResource("export_coordination", "entry_1", 3),
            caseId: "case_old",
            state: "open",
            occurredAt: "2026-08-25T11:00:00.000Z",
          },
        ],
        proposals: [],
        approvals: [],
        effects: [],
        underclerkReceipts: [],
        actionLedger: [],
      },
    });

    expect(activity).toHaveLength(1);
    expect(activity[0]?.kind).toBe("case");
    expect(activity[0]?.resource).toEqual(resource);
  });

  it("reads retained history and governed activity by the exact entity reference", async () => {
    const organisationId = requireOrganisationId(
      "organisation_entity_activity_reader",
    );
    const resource = entityResource("offer", "offer_1");
    const action = {
      action: {
        nonce: { value: "nonce_1" },
        resourceKey: "commerce:publish_catalog_listing:offer_1",
      },
      caseId: "case_1",
      proposalId: "proposal_1",
      state: "confirmed",
      createdAt: Date.parse("2026-08-25T12:00:00.000Z"),
      updatedAt: Date.parse("2026-08-25T13:00:00.000Z"),
      providerResult: JSON.stringify({
        kind: "commerce_provider_receipt",
        provider: "underclerk",
        receiptId: "receipt_1",
        effectId: "effect_1",
        actionNonce: "nonce_1",
        flowBindingDigest: "a".repeat(64),
        decisionDigest: "b".repeat(64),
        eventId: "event_1",
        resourceId: "offer_1",
        projectionKind: "offer",
        revision: 2,
        status: "accepted",
        merchantId: "merchant_1",
        merchantRevision: 4,
        observedAt: "2026-08-25T14:00:00.000Z",
      }),
      commerceEffect: null,
    };
    const organisation = {
      readCommerceProjectionHistory: async () => ({
        ok: true,
        value: [
          {
            eventId: "history_1",
            disposition: "applied",
            projectionKind: "offer",
            canonicalId: "offer_1",
            revision: 2,
            occurredAt: "2026-08-25T10:00:00.000Z",
            processedAt: 1,
            lastSeenAt: 1,
            deliveryCount: 1,
          },
        ],
      }),
      readActionActivity: async () => ({ ok: true, value: [action] }),
    };
    const result = await readCommerceActivity({
      organisationId,
      resource,
      organisation: organisation as never,
      caseReader: {
        read: async () =>
          ({
            identity: { organisationId, caseId: "case_1" },
            lifecycle: { kind: "open", openedAt: 1 },
            commerceApprovals: [
              {
                kind: "waiting",
                request: {
                  caseId: "case_1",
                  proposalId: "proposal_1",
                  actionNonce: "nonce_1",
                  expectedCaseRevision: 1,
                  requestedAt: 2,
                },
              },
            ],
          }) as never,
      },
      limit: 20,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unsupportedSources).toEqual([]);
    expect(result.value.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "underclerk_receipt",
        "proposal",
        "case",
        "approval",
        "action_ledger",
        "blotter_history",
      ]),
    );
  });

  it("reads exact entity-plane effects and signed receipts for relationships", async () => {
    const organisationId = requireOrganisationId(
      "organisation_relationship_activity_reader",
    );
    const effect = parseCommerceEntityPlaneEffect({
      kind: "create_custom_relationship",
      relationshipId: "relationship_1",
      definition: {
        origin: "custom",
        definitionId: "customer_order",
        revision: 1,
      },
      source: { origin: "custom", typeId: "customer", entityId: "customer_1" },
      target: { origin: "system", typeId: "order", entityId: "order_1" },
      receipt: {
        commandId: "command_1",
        outcome: "applied",
        target: {
          kind: "custom_relationship",
          relationship: {
            origin: "custom",
            relationshipId: "relationship_1",
            definition: {
              origin: "custom",
              definitionId: "customer_order",
              revision: 1,
            },
            revision: 1,
          },
        },
        merchantRevision: 2,
        committedAt: "2026-08-25T14:00:00.000Z",
        deliveryId: "entity_plane:merchant_relationship:2:command_1",
        signer: {
          keyId: "key_1",
          algorithm: "ed25519",
          signature: "signature_1",
        },
      },
    });
    if (
      effect === null ||
      effect.receipt.target.kind !== "custom_relationship"
    ) {
      throw new Error("invalid relationship effect fixture");
    }
    const resource: CommerceActivityResource = {
      kind: "relationship",
      reference: effect.receipt.target.relationship,
    };
    const action = {
      action: {
        nonce: { value: "nonce_1" },
        resourceKey: "commerce:entity_plane:relationship_1",
      },
      caseId: "case_1",
      proposalId: "proposal_1",
      state: "confirmed",
      createdAt: Date.parse("2026-08-25T12:00:00.000Z"),
      updatedAt: Date.parse("2026-08-25T14:00:00.000Z"),
      providerResult: null,
      commerceEffect: effect,
    };
    const result = await readCommerceActivity({
      organisationId,
      resource,
      organisation: {
        readCommerceProjectionHistory: async () => ({ ok: true, value: [] }),
        readActionActivity: async () => ({ ok: true, value: [action] }),
      } as never,
      caseReader: {
        read: async () =>
          ({
            identity: { organisationId, caseId: "case_1" },
            lifecycle: { kind: "open", openedAt: 1 },
            commerceApprovals: [],
          }) as never,
      },
      limit: 20,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unsupportedSources).toEqual(["blotter_history"]);
    expect(result.value.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "entity_plane_effect",
        "underclerk_observation",
        "underclerk_receipt",
        "proposal",
        "case",
        "action_ledger",
      ]),
    );
    expect(
      result.value.events.find((event) => event.kind === "entity_plane_effect"),
    ).toMatchObject({
      effect: {
        receipt: { commandId: "command_1", signer: { algorithm: "ed25519" } },
      },
    });
    expect(
      result.value.events.find(
        (event) => event.kind === "underclerk_observation",
      ),
    ).toMatchObject({
      observationId: "command_1",
      deliveryId: "entity_plane:merchant_relationship:2:command_1",
      merchantRevision: 2,
    });
  });
});

function entityResource(
  typeId: string,
  entityId: string,
): CommerceActivityResource {
  return {
    kind: "entity",
    reference: { origin: "system", typeId, entityId },
  } as CommerceActivityResource;
}

function listEntryResource(
  listId: string,
  entryId: string,
  revision: number,
): CommerceActivityResource {
  return {
    kind: "list_entry",
    reference: { listId, entryId, revision },
  } as CommerceActivityResource;
}
