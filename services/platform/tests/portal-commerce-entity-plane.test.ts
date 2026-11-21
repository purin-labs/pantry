// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { parseCommerceEntityPlaneCommand } from "@purin-labs/commerce-client";
import type {
  CommerceBoardViewConfiguration,
  CommerceList,
} from "@purin-labs/commerce-contracts";

import {
  buildCommerceBoardModel,
  buildCommerceEntityDossierModel,
  buildCommerceListTableModel,
  buildEntityTypeTableModel,
  parseCommerceActivityResponse,
  parseCommerceGraphQueryResult,
  patchCommerceListEntryStatus,
  readPublishedCommerceResources,
} from "../../../apps/portal/src/features/commerce";
import { updateCommerceBoardPresence } from "../../../apps/portal/src/features/commerce/entity-plane/api";
import { parseCommerceListEntryPatchResponse } from "@purin-labs/commerce-control-api/portal/entity-plane";
import {
  OrderCancellationControl,
  proposeOrderCancellation,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/features/commerce/entity-plane/route";
import type { CommerceOperationsTransport } from "../../../apps/portal/src/features/commerce/operations";

async function validCommercePresenceTransport(): Promise<unknown> {
  return commercePresenceResponse(false);
}

async function invalidCommercePresenceTransport(): Promise<unknown> {
  return commercePresenceResponse(true);
}

function commercePresenceResponse(includeExtraField: boolean): unknown {
  const entry = {
    userId: "user_42d8499b-4f02-53e2-a0bc-6af86a5b4eb3",
    displayName: "Operator One",
    resourceKey: "commerce_list:export_coordination",
    selection: {
      kind: "list_entry",
      entryId: "entry_1",
      listId: "export_coordination",
    },
    dragPreview: {
      kind: "moving",
      entryId: "entry_1",
      desiredStatusId: "documents_ready",
    },
    observedAt: 1_777_000_000_000,
  };
  return {
    ok: true,
    presence: [includeExtraField ? { ...entry, persisted: true } : entry],
  };
}

describe("portal commerce entity-plane presentation", () => {
  it("parses ephemeral board presence and rejects extra contract fields", async () => {
    await expect(
      updateCommerceBoardPresence(
        "organisation_export",
        "commerce_list:export_coordination",
        { kind: "none" },
        { kind: "idle" },
        validCommercePresenceTransport,
      ),
    ).resolves.toMatchObject([
      { userId: "user_42d8499b-4f02-53e2-a0bc-6af86a5b4eb3" },
    ]);
    await expect(
      updateCommerceBoardPresence(
        "organisation_export",
        "commerce_list:export_coordination",
        { kind: "none" },
        { kind: "idle" },
        invalidCommercePresenceTransport,
      ),
    ).rejects.toThrow("presence entry is invalid");
  });

  it("fails closed when published-resource metadata is returned for another organisation", async () => {
    await expect(
      readPublishedCommerceResources("organisation_export", async () =>
        Response.json({
          ok: true,
          metadata: {
            kind: "enumerated",
            organisationId: "organisation_other",
            merchantId: "merchant_other",
            merchantRevision: 0,
            entityTypes: [],
            lists: [],
            views: [],
          },
        }),
      ),
    ).rejects.toThrow("belongs to another organisation");
  });

  it("binds an Order dossier cancellation to its exact source revision", async () => {
    const graph = requireParsedGraph();
    const order = requireEntity(graph.entities.find(hasOrderReference));
    const proposeAction = vi.fn(proposedCancellationResponse);
    const transport: CommerceOperationsTransport = {
      previewTrackingBatch: unusedTrackingPreview,
      proposeAction,
    };
    const formData = new FormData();
    formData.set("reason", "inventory_unavailable");

    const action = await proposeOrderCancellation({
      organisationId: "organisation_export",
      entity: order,
      formData,
      transport,
    });

    expect(proposeAction).toHaveBeenCalledWith(
      "organisation_export",
      {
        kind: "cancel_order",
        resourceId: "order_1",
        expectedRevision: 1,
        reason: "inventory_unavailable",
        refund: "full",
        restock: true,
        notifyCustomer: false,
        note: null,
      },
      "commerce-order-cancel:order_1:1",
    );
    expect(action).toMatchObject({
      state: "approval_requested",
      details: {
        kind: "cancel_order",
        execution: { kind: "commerce_full_refund" },
      },
    });

    const reviewerMarkup = renderToStaticMarkup(
      React.createElement(OrderCancellationControl, {
        organisationId: "organisation_export",
        page: "orders",
        entity: order,
        canPropose: false,
        commerceOperations: transport,
        onActionProposed: vi.fn(),
        actionBusy: false,
      }),
    );
    const disconnectedMarkup = renderToStaticMarkup(
      React.createElement(OrderCancellationControl, {
        organisationId: "organisation_export",
        page: "orders",
        entity: order,
        canPropose: true,
        commerceOperations: undefined,
        onActionProposed: vi.fn(),
        actionBusy: false,
      }),
    );
    const operatorMarkup = renderToStaticMarkup(
      React.createElement(OrderCancellationControl, {
        organisationId: "organisation_export",
        page: "orders",
        entity: order,
        canPropose: true,
        commerceOperations: transport,
        onActionProposed: vi.fn(),
        actionBusy: false,
      }),
    );
    expect(reviewerMarkup).toBe("");
    expect(disconnectedMarkup).toBe("");
    expect(operatorMarkup).toContain("Cancel order");
    expect(operatorMarkup).toContain("Review cancellation");
    expect(operatorMarkup).toContain("Full refund");
  });

  it("parses exact-resource activity at the portal boundary", () => {
    const activity = parseCommerceActivityResponse({
      ok: true,
      events: [
        {
          kind: "case",
          resource: {
            kind: "entity",
            reference: {
              origin: "system",
              typeId: "order",
              entityId: "order_1",
            },
          },
          caseId: "case_1",
          state: "open",
          occurredAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      unsupportedSources: [],
    });
    expect(activity.events[0]).toEqual(
      expect.objectContaining({
        kind: "case",
        caseId: "case_1",
        state: "open",
        resource: {
          kind: "entity",
          reference: { origin: "system", typeId: "order", entityId: "order_1" },
        },
      }),
    );
    expect(() =>
      parseCommerceActivityResponse({
        events: [],
        unsupportedSources: ["legacy"],
      }),
    ).toThrow();
  });

  it("retains every branch payload and rejects lossy activity records", () => {
    const resource = {
      kind: "entity" as const,
      reference: {
        origin: "custom" as const,
        typeId: "customer",
        entityId: "customer_1",
      },
    };
    const receipt = {
      commandId: "activity_command",
      outcome: "applied",
      target: {
        kind: "custom_entity",
        entityRef: resource.reference,
        revision: 2,
      },
      merchantRevision: 2,
      committedAt: "2026-08-26T00:00:00.000Z",
      deliveryId: "activity_delivery",
      signer: {
        keyId: "activity_key",
        algorithm: "ed25519",
        signature: "activity_signature",
      },
    };
    const activity = parseCommerceActivityResponse({
      events: [
        {
          kind: "blotter_history",
          resource,
          eventId: "event_1",
          disposition: "applied",
          revision: 2,
          occurredAt: "2026-08-26T00:00:00.000Z",
          processedAt: 2,
          deliveryCount: 1,
        },
        {
          kind: "case",
          resource,
          caseId: "case_1",
          state: "open",
          occurredAt: "2026-08-26T00:00:01.000Z",
        },
        {
          kind: "proposal",
          resource,
          proposalId: "proposal_1",
          state: "confirmed",
          occurredAt: "2026-08-26T00:00:02.000Z",
        },
        {
          kind: "approval",
          resource,
          approvalId: "nonce_1",
          state: "decided",
          occurredAt: "2026-08-26T00:00:03.000Z",
        },
        {
          kind: "entity_plane_effect",
          resource,
          effect: {
            kind: "patch_custom_entity",
            entityRef: resource.reference,
            typeRevision: 1,
            expectedRevision: 1,
            receipt,
          },
          occurredAt: "2026-08-26T00:00:04.000Z",
        },
        {
          kind: "commerce_observation",
          resource,
          observationId: "activity_command",
          deliveryId: "activity_delivery",
          merchantRevision: 2,
          occurredAt: "2026-08-26T00:00:04.000Z",
        },
        {
          kind: "commerce_receipt",
          resource,
          receiptId: "activity_command",
          outcome: "applied",
          occurredAt: "2026-08-26T00:00:04.000Z",
        },
        {
          kind: "action_ledger",
          resource,
          actionNonce: "nonce_1",
          caseId: "case_1",
          proposalId: "proposal_1",
          state: "confirmed",
          occurredAt: "2026-08-26T00:00:05.000Z",
          providerResult: '{"outcome":"applied"}',
        },
      ],
      unsupportedSources: ["blotter_history"],
    });
    expect(activity.events).toHaveLength(8);
    expect(activity.events[4]).toEqual(
      expect.objectContaining({
        kind: "entity_plane_effect",
        effect: expect.objectContaining({
          kind: "patch_custom_entity",
          receipt: expect.objectContaining({
            commandId: "activity_command",
            signer: expect.objectContaining({ keyId: "activity_key" }),
          }),
        }),
      }),
    );
    expect(activity.events[5]).toEqual(
      expect.objectContaining({
        kind: "commerce_observation",
        deliveryId: "activity_delivery",
      }),
    );
    expect(activity.events[7]).toEqual(
      expect.objectContaining({ providerResult: '{"outcome":"applied"}' }),
    );
    expect(activity.unsupportedSources).toEqual(["blotter_history"]);
    expect(() =>
      parseCommerceActivityResponse({
        events: [
          {
            kind: "proposal",
            resource,
            proposalId: "proposal_1",
            state: "confirmed",
            occurredAt: "2026-08-26T00:00:02.000Z",
          },
        ],
        unsupportedSources: [],
      }),
    ).not.toThrow();
    expect(() =>
      parseCommerceActivityResponse({
        events: [
          {
            kind: "proposal",
            resource,
            proposalId: "proposal_1",
            state: "unknown",
            occurredAt: "2026-08-26T00:00:02.000Z",
          },
        ],
        unsupportedSources: [],
      }),
    ).toThrow();
  });

  it("turns the locked export graph and list-entry attributes into dossier and board models", () => {
    const graph = parseCommerceGraphQueryResult(exportGraphResult());
    expect(graph).toEqual(expect.objectContaining({ ok: true }));
    if (!graph.ok) return;

    const shipment = requireEntity(
      graph.value.entities.find(
        (entity) =>
          entity.reference.origin === "system" &&
          entity.reference.typeId === "shipment",
      ),
    ).reference;
    const entityTable = buildEntityTypeTableModel(graph.value, {
      origin: "system",
      typeId: "shipment",
    });
    expect(entityTable.rows).toHaveLength(1);
    expect(entityTable.rows[0]?.relationships).toHaveLength(3);

    const dossier = buildCommerceEntityDossierModel(graph.value, shipment);
    expect(dossier).toEqual(expect.objectContaining({ ok: true }));
    if (!dossier.ok) return;

    expect(dossier.value.traversal.entities).toHaveLength(5);
    expect(dossier.value.traversal.relationships).toHaveLength(4);
    expect(dossier.value.contextualListEntries).toHaveLength(1);
    expect(
      dossier.value.contextualListEntries[0]?.attributeValues.map(
        (attribute) => attribute.attributeId,
      ),
    ).toEqual(["stage", "owner", "due_at", "priority", "exception_reason"]);

    const list = exportCommerceList();
    expect(
      list.entryAttributeDefinitions.map((entry) => entry.attributeId),
    ).toEqual(["stage", "owner", "due_at", "priority", "exception_reason"]);
    expect(
      list.entryAttributeDefinitions.every(
        (entry) =>
          entry.definition.scope.kind === "system" &&
          entry.definition.scope.entityTypeId === "shipment" &&
          entry.definition.scope.schemaRevision === 1,
      ),
    ).toBe(true);

    const table = buildCommerceListTableModel(graph.value, list);
    expect(table).toEqual(expect.objectContaining({ ok: true }));
    if (!table.ok) return;
    expect(table.value.rows).toHaveLength(1);
    expect(table.value.rows[0]?.entity.reference).toEqual(shipment);
    expect(table.value.rows[0]?.contextualAttributes).toHaveLength(5);
    expect(
      buildCommerceListTableModel(
        graph.value,
        commerceListFixture("other_list", "Other", []),
      ),
    ).toMatchObject({ ok: true, value: { rows: [] } });

    const stage = requireValue(table.value.rows[0]?.contextualAttributes[0]);
    const configuration: CommerceBoardViewConfiguration = {
      laneAttributeId: stage.attributeId,
      cardAttributeIds: [stage.attributeId],
    };
    const board = buildCommerceBoardModel(graph.value, list, configuration);
    expect(board).toEqual(expect.objectContaining({ ok: true }));
    if (!board.ok) return;
    expect(board.value.lanes).toHaveLength(1);
    expect(board.value.lanes[0]?.key).toBe("ready");
    expect(board.value.lanes[0]?.rows[0]?.contextualAttributes).toHaveLength(5);
  });

  it("rejects malformed graph results", () => {
    const invalid = parseCommerceGraphQueryResult({
      merchantRevision: -1,
      entities: [],
      relationships: [],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: [],
      freshness: [],
    });
    expect(invalid).toEqual({
      ok: false,
      error: { kind: "invalid_response", path: "response" },
    });
  });

  it("moves one live board card with the exact entry and list revisions", async () => {
    const graph = requireParsedGraph();
    const entry = requireValue(graph.listEntries[0]);
    const list = exportCommerceList();
    let requestBody: unknown = null;
    const outcome = await patchCommerceListEntryStatus(
      "organisation_export",
      list,
      entry,
      list.entryAttributeDefinitions[0]!.attributeId,
      "in_transit",
      async (path, body, intent) => {
        expect(path).toBe(
          "/v1/control/organisations/organisation_export/commerce/list-entries/entry_shipment_1/patch",
        );
        expect(intent).toBe(
          "commerce-list-entry:entry_shipment_1:1:in_transit",
        );
        requestBody = body;
        return {
          ok: true,
          receipt: {
            commandId: "portal_move_entry_1",
            outcome: "applied",
            target: {
              kind: "commerce_list_entry",
              entry: {
                entryId: "entry_shipment_1",
                listId: "export_coordination",
                revision: 2,
              },
              revision: 2,
            },
            merchantRevision: 8,
            committedAt: "2026-08-26T00:00:00.000Z",
            deliveryId: "delivery_portal_move_entry_1",
            signer: {
              keyId: "key_portal",
              algorithm: "ed25519",
              signature: "signature_portal",
            },
          },
        };
      },
    );
    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed")
      throw new Error("expected executed list-entry patch outcome");
    expect(requestBody).toMatchObject({
      kind: "patch_commerce_list_entry",
      command: {
        target: {
          entry: { entryId: "entry_shipment_1", revision: 1 },
          expectedRevision: 1,
        },
        expectedListRevision: 1,
        attributeValues: expect.arrayContaining([
          expect.objectContaining({
            attributeId: "stage",
            value: { kind: "status", value: "in_transit" },
          }),
          expect.objectContaining({ attributeId: "owner" }),
        ]),
      },
    });
    expect(outcome.receipt.target).toMatchObject({
      kind: "commerce_list_entry",
      revision: 2,
    });
    await expect(
      patchCommerceListEntryStatus(
        "organisation_export",
        list,
        entry,
        list.entryAttributeDefinitions[0]!.attributeId,
        "fabricated_lane",
        async () => ({ ok: false }),
      ),
    ).rejects.toThrow("not a published status option");
  });

  it("parses approval-requested list-entry patches and rejects malformed outcomes", async () => {
    const graph = requireParsedGraph();
    const entry = requireValue(graph.listEntries[0]);
    const list = exportCommerceList();
    const approvalResponse = {
      ok: true,
      effect: "approval_requested",
      action: {
        nonce: { value: "action_nonce_1" },
        caseId: "case_list_entry_patch_1",
        proposalId: "proposal_list_entry_patch_1",
        state: "approval_requested",
        verb: "commerce.list_entry.patch",
        resourceKey:
          "commerce:list_entry:export_coordination:entry_shipment_1:1",
      },
      approval: { kind: "required", next: "approve_action" },
      requestedAt: 1_777_000_000_000,
    };
    const outcome = await patchCommerceListEntryStatus(
      "organisation_export",
      list,
      entry,
      list.entryAttributeDefinitions[0]!.attributeId,
      "in_transit",
      async () => approvalResponse,
    );
    expect(outcome).toEqual({
      kind: "approval_requested",
      action: {
        nonce: "action_nonce_1",
        caseId: "case_list_entry_patch_1",
        proposalId: "proposal_list_entry_patch_1",
        state: "approval_requested",
        verb: "commerce.list_entry.patch",
        resourceKey:
          "commerce:list_entry:export_coordination:entry_shipment_1:1",
      },
      approval: { kind: "required", next: "approve_action" },
      requestedAt: 1_777_000_000_000,
    });
    expect(parseCommerceListEntryPatchResponse(approvalResponse)).toEqual(
      outcome,
    );
    expect(() =>
      parseCommerceListEntryPatchResponse({
        ok: true,
        effect: "approval_requested",
        action: {
          nonce: { value: "action_nonce_1" },
          caseId: "case_list_entry_patch_1",
          proposalId: "proposal_list_entry_patch_1",
          state: "approval_requested",
          verb: "commerce.list_entry.patch",
          resourceKey:
            "commerce:list_entry:export_coordination:entry_shipment_1:1",
        },
        approval: { kind: "required", next: "approve_action" },
        requestedAt: 1_777_000_000_000,
        unexpected: true,
      }),
    ).toThrow("response is invalid");
    expect(() =>
      parseCommerceListEntryPatchResponse({
        ok: true,
        receipt: null,
      }),
    ).toThrow();
  });
});

function exportGraphResult(): unknown {
  return {
    merchantRevision: 7,
    entities: [
      systemEntity("order", "order_1", "Order 1", "commerce_order"),
      systemEntity("shipment", "shipment_1", "Shipment 1", "shipment"),
      systemEntity(
        "production_batch",
        "batch_1",
        "Batch 1",
        "production_batch",
      ),
      customEntity("trade_partner", "partner_1", "Trade Partner"),
      customEntity("export_document", "document_1", "Export Document"),
    ],
    relationships: [
      systemRelationship(
        "order_shipment",
        "order_1",
        "shipment_1",
        "order",
        "shipment",
      ),
      customRelationship(
        "trade_partner_order",
        "partner_1",
        "order_1",
        "trade_partner",
        "order",
      ),
      customRelationship(
        "shipment_export_document",
        "shipment_1",
        "document_1",
        "shipment",
        "export_document",
      ),
      systemRelationship(
        "shipment_production_batch",
        "shipment_1",
        "batch_1",
        "shipment",
        "production_batch",
      ),
    ],
    listEntries: [
      {
        entryId: "entry_shipment_1",
        listId: "export_coordination",
        listRevision: 1,
        entityRef: systemReference("shipment", "shipment_1"),
        attributeValues: [
          contextualAttribute("stage", { kind: "status", value: "ready" }),
          contextualAttribute("owner", { kind: "short_text", value: "ops" }),
          contextualAttribute("due_at", { kind: "date", value: "2026-08-25" }),
          contextualAttribute("priority", { kind: "integer", value: 2 }),
          contextualAttribute("exception_reason", {
            kind: "long_text",
            value: "No exception",
          }),
        ],
        revision: 1,
      },
    ],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  };
}

function systemEntity(
  typeId: string,
  entityId: string,
  displayName: string,
  resourceType: string,
): unknown {
  return {
    reference: systemReference(typeId, entityId),
    revision: 1,
    displayName,
    attributes: [],
    provenance: {
      organisationId: "organisation_export",
      integrationAccountId: "integration_export",
      source: "commerce",
      resourceType,
      resourceId: entityId,
      revision: 1,
      occurredAt: "2026-08-25T09:00:00.000Z",
      observedAt: "2026-08-25T09:00:01.000Z",
    },
    freshness: { state: "current", observedAt: "2026-08-25T09:00:01.000Z" },
  };
}

function hasOrderReference(
  entity: ReturnType<typeof requireParsedGraph>["entities"][number],
): boolean {
  return (
    entity.reference.origin === "system" && entity.reference.typeId === "order"
  );
}

async function unusedTrackingPreview(): Promise<never> {
  throw new Error("unused");
}

async function proposedCancellationResponse(): Promise<unknown> {
  return {
    ok: true,
    action: {
      nonce: { value: "00000000-0000-4000-8000-000000000010" },
      caseId: "case_order_cancellation",
      proposalId: "proposal_order_cancellation",
      state: "approval_requested",
      verb: "commerce.order.cancel",
      resourceKey: "commerce:cancel_order:order_1",
      amount: { value: 12.5, currency: "USD" },
      commerceSystem: {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: 3,
      },
      details: {
        kind: "cancel_order",
        resourceId: "order_1",
        expectedRevision: 1,
        reason: "inventory_unavailable",
        refund: "full",
        restock: true,
        notifyCustomer: false,
        note: null,
        execution: {
          kind: "commerce_full_refund",
          merchantRevision: 9,
          paymentId: "payment_order_1",
          paymentRevision: 2,
          fulfillmentId: "fulfillment_order_1",
          fulfillmentRevision: 3,
          checkoutProfileId: "checkout_profile_order_1",
          checkoutProfileRevision: 4,
          refundPolicyId: "refund_policy_order_1",
          refundAmountMinor: 1250,
          refundCurrency: "USD",
          refundGovernance: "approval_required",
        },
      },
      providerResult: null,
    },
  };
}

function customEntity(
  typeId: string,
  entityId: string,
  displayName: string,
): unknown {
  return {
    reference: { origin: "custom", typeId, entityId },
    revision: 1,
    displayName,
    attributes: [],
    typeRevision: 1,
    state: { state: "active" },
    sensitivity: "internal",
  };
}

function systemReference(typeId: string, entityId: string): unknown {
  return { origin: "system", typeId, entityId };
}

function systemRelationship(
  definitionId: string,
  sourceId: string,
  targetId: string,
  sourceType: string,
  targetType: string,
): unknown {
  return {
    origin: "system",
    relationshipId: `${definitionId}_${sourceId}_${targetId}`,
    definition: { origin: "system", definitionId, revision: 1 },
    sensitivity: "internal",
    source: systemReference(sourceType, sourceId),
    target: systemReference(targetType, targetId),
    revision: 1,
    provenance: {
      organisationId: "organisation_export",
      integrationAccountId: "integration_export",
      source: "commerce",
      resourceType: sourceType === "order" ? "commerce_order" : sourceType,
      resourceId: sourceId,
      revision: 1,
      occurredAt: "2026-08-25T09:00:00.000Z",
      observedAt: "2026-08-25T09:00:01.000Z",
    },
  };
}

function customRelationship(
  definitionId: string,
  sourceId: string,
  targetId: string,
  sourceType: string,
  targetType: string,
): unknown {
  return {
    origin: "custom",
    relationshipId: `${definitionId}_${sourceId}_${targetId}`,
    definition: { origin: "custom", definitionId, revision: 1 },
    sensitivity: "internal",
    source:
      sourceType === "order" || sourceType === "shipment"
        ? systemReference(sourceType, sourceId)
        : { origin: "custom", typeId: sourceType, entityId: sourceId },
    target:
      targetType === "order" || targetType === "shipment"
        ? systemReference(targetType, targetId)
        : { origin: "custom", typeId: targetType, entityId: targetId },
    revision: 1,
  };
}

function contextualAttribute(attributeId: string, value: unknown): unknown {
  return {
    attributeId,
    scope: {
      kind: "system",
      entityTypeId: "shipment",
      schemaRevision: 1,
    },
    definitionRevision: 1,
    sensitivity: "internal",
    value,
  };
}

function requireEntity<
  T extends { reference: { origin: string; typeId: string; entityId: string } },
>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture entity is missing");
  return value;
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture value is missing");
  return value;
}

function requireParsedGraph() {
  const parsed = parseCommerceGraphQueryResult(exportGraphResult());
  if (!parsed.ok) throw new Error(parsed.error.path);
  return parsed.value;
}

function exportCommerceList(): CommerceList {
  return commerceListFixture("export_coordination", "Export Coordination", [
    listEntryDefinition("stage", "Stage", {
      kind: "status",
      options: [
        { id: "pending", label: "Pending" },
        { id: "ready", label: "Ready" },
        { id: "in_transit", label: "In transit" },
      ],
    }),
    listEntryDefinition("owner", "Owner", {
      kind: "short_text",
      maxLength: 128,
    }),
    listEntryDefinition("due_at", "Due at", { kind: "date" }),
    listEntryDefinition("priority", "Priority", {
      kind: "integer",
      minimum: null,
      maximum: null,
    }),
    listEntryDefinition("exception_reason", "Exception reason", {
      kind: "long_text",
      maxLength: 500,
    }),
  ]);
}

function commerceListFixture(
  listId: string,
  name: string,
  entryAttributeDefinitions: readonly unknown[],
): CommerceList {
  const command = parseCommerceEntityPlaneCommand({
    kind: "create_commerce_list",
    command: {
      listId,
      entityTypeId: { origin: "system", typeId: "shipment" },
      name,
      membership: "unique_entity",
      entryAttributeDefinitions,
      publishedRevision: 1,
    },
  });
  if (command.kind !== "create_commerce_list")
    throw new Error("fixture command kind changed");
  const list = command.command satisfies CommerceList;
  return list;
}

function listEntryDefinition(
  attributeId: string,
  label: string,
  kind: unknown,
): unknown {
  return {
    attributeId,
    definition: {
      id: attributeId,
      scope: { kind: "system", entityTypeId: "shipment", schemaRevision: 1 },
      label,
      helpText: null,
      required: false,
      sensitivity: "internal",
      kind,
      revision: 1,
    },
  };
}
