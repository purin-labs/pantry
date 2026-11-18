import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { CommerceMutationReceiptV1 } from "@seams/commerce-contracts";
import {
  parseCommerceDelivery,
  parseCommerceEntityPlaneCommand,
  parseCommerceGraphResponse,
  parseCommerceMerchantId,
  parseEntityPlaneCommand as parseClientEntityPlaneCommandRequest,
  parseEntityPlaneCommandResult,
  parseEntityPlaneSystemExtensionResponse,
  parseSavedCommerceViewRevision,
} from "@seams/commerce-client";

import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { EntityPlaneService } from "../src/entity-plane/service.ts";
import {
  parseAttributeDefinition,
  parseCustomEntityTypeDraft,
  parseEntityPlaneCommandRequest,
  parseEntityRef,
  parsePositiveRevision,
  parseRelationshipDefinition,
  parseSavedCommerceView,
} from "../src/entity-plane/parsers.ts";
import {
  listRelationshipDefinitions,
  relationshipCardinalityConflict,
  relationshipReplacementCardinalityConflict,
} from "../src/entity-plane/relationships.ts";
import { writeCommerceEntityRelationText } from "../src/entity-plane/relation-text.ts";
import { validateCommandAuthorityWithLexicon } from "../src/entity-plane/lexicon.ts";

const NOW = "2026-08-25T00:00:00.000Z";
const TEST_SIGNER = {
  keyId: "entity-plane-test",
  publicKeyB64: "entity-plane-test-public-key",
  sign: (payload: Uint8Array): string =>
    Buffer.from(payload).toString("base64url"),
};

it("keeps saved-view labels and unknown-field rejection aligned at both TypeScript boundaries", () => {
  const view = {
    viewId: "long_label_view",
    name: "Long label view",
    source: { kind: "commerce_list", listId: "export_coordination" },
    filter: { kind: "all" },
    sorts: [],
    visibleAttributeIds: ["stage"],
    relationshipColumns: [
      {
        relationshipDefinition: {
          origin: "system",
          definitionId: "order_shipment",
          revision: 1,
        },
        label: "x".repeat(121),
      },
    ],
    grouping: null,
    presentation: {
      kind: "table",
      configuration: { density: "comfortable", showRowNumbers: true },
    },
    revision: 1,
  };
  expect(
    parseSavedCommerceView(view).relationshipColumns[0]?.label,
  ).toHaveLength(121);
  expect(
    parseCommerceEntityPlaneCommand({
      kind: "publish_saved_commerce_view",
      command: { view },
    }),
  ).toMatchObject({ kind: "publish_saved_commerce_view" });
  expect(() => parseSavedCommerceView({ ...view, unexpected: true })).toThrow(
    "saved commerce view rejected by Lexicon",
  );
  expect(() =>
    parseCommerceEntityPlaneCommand({
      kind: "publish_saved_commerce_view",
      command: {
        view: {
          ...view,
          presentation: { ...view.presentation, unexpected: true },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    parseCommerceEntityPlaneCommand({
      kind: "patch_commerce_list_entry",
      command: {
        target: {
          entry: { entryId: "entry_1", listId: "list_1", revision: 2 },
          expectedRevision: 1,
        },
        expectedListRevision: 1,
        attributeValues: [],
      },
    }),
  ).toThrow("revision_conflict");
});

it("binds saved-view administration to the exact prior publication revision", () => {
  const command = {
    kind: "publish_saved_commerce_view",
    command: {
      view: {
        viewId: "export_board",
        name: "Export board",
        source: { kind: "commerce_list", listId: "export_coordination" },
        filter: { kind: "all" },
        sorts: [],
        visibleAttributeIds: ["stage"],
        relationshipColumns: [],
        grouping: null,
        presentation: {
          kind: "table",
          configuration: { density: "comfortable", showRowNumbers: true },
        },
        revision: 3,
      },
    },
  };
  const request = parseClientEntityPlaneCommandRequest({
    organisationId: "organisation_view_authority",
    merchantId: "merchant_view_authority",
    commandId: "publish_view_revision_3",
    expectedMerchantRevision: 8,
    authority: {
      kind: "saved_view_administration",
      context: {
        organisationId: "organisation_view_authority",
        merchantId: "merchant_view_authority",
        principalId: "principal_view_authority",
        sensitivityCeiling: "restricted",
        expiresAt: "2030-01-01T00:00:00.000Z",
        causation: { kind: "command", commandId: "publish_view_revision_3" },
      },
      scope: { kind: "saved_view", viewId: "export_board" },
      target: { viewId: "export_board", expectedRevision: 2 },
    },
    command,
  });
  expect(
    validateCommandAuthorityWithLexicon({
      ...request,
      merchantId: parseCommerceMerchantId(request.merchantId),
      now: NOW,
    }),
  ).toEqual({ kind: "ok" });
  if (request.authority.kind !== "saved_view_administration") {
    throw new Error("saved-view authority fixture is invalid");
  }
  expect(
    validateCommandAuthorityWithLexicon({
      ...request,
      merchantId: parseCommerceMerchantId(request.merchantId),
      authority: {
        ...request.authority,
        target: {
          viewId: request.authority.target.viewId,
          expectedRevision: parseSavedCommerceViewRevision(1),
        },
      },
      now: NOW,
    }),
  ).toMatchObject({ kind: "error" });
});

it("rejects mismatched and expired command authority before any mutation", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_authority", "organisation_authority", NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  const command = {
    kind: "create_custom_entity_type",
    command: {
      draft: {
        typeId: "authority_type",
        label: "Authority type",
        description: "Authority test type",
        attributes: [],
        revision: 1,
      },
    },
  };
  const validAuthority = authorityForCommand(
    command,
    "authority_valid",
    "organisation_authority",
    "merchant_authority",
  );
  const before = database
    .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
    .get("merchant_authority");
  expect(
    service.command({
      organisationId: "organisation_authority",
      merchantId: "merchant_authority",
      commandId: "authority_wrong_organisation",
      expectedMerchantRevision: 0,
      authority: {
        ...validAuthority,
        context: {
          ...validAuthority.context,
          organisationId: "other_organisation",
        },
      },
      command,
    }),
  ).toMatchObject({
    status: "rejected",
    error: { code: "authority_out_of_scope" },
  });
  expect(
    service.command({
      organisationId: "organisation_authority",
      merchantId: "merchant_authority",
      commandId: "authority_wrong_target",
      expectedMerchantRevision: 0,
      authority: { ...validAuthority, target: { typeId: "other_type" } },
      command,
    }),
  ).toMatchObject({
    status: "rejected",
    error: { code: "authority_out_of_scope" },
  });
  expect(
    service.command({
      organisationId: "organisation_authority",
      merchantId: "merchant_authority",
      commandId: "authority_expired",
      expectedMerchantRevision: 0,
      authority: {
        ...validAuthority,
        context: {
          ...validAuthority.context,
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      },
      command,
    }),
  ).toMatchObject({ status: "rejected", error: { code: "authority_expired" } });
  expect(
    database
      .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
      .get("merchant_authority"),
  ).toEqual(before);
  expect(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM custom_entity_type WHERE merchant_id = ?",
      )
      .get("merchant_authority"),
  ).toEqual({ count: 0 });
  database.close();
});

it("keeps nothing when a command fails while it writes its receipt, then applies and replays it", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_rollback", "organisation_rollback", NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  const request = parseEntityPlaneCommandRequest(
    commandWithAuthority({
      organisationId: "organisation_rollback",
      merchantId: "merchant_rollback",
      commandId: "rollback_create",
      expectedMerchantRevision: 0,
      command: {
        kind: "create_custom_entity_type",
        command: {
          draft: {
            typeId: "rollback_type",
            label: "Rollback type",
            description: "Rollback test type",
            attributes: [],
            revision: 1,
          },
        },
      },
    }),
    NOW,
  );
  const state = () => ({
    merchant: database
      .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
      .get("merchant_rollback"),
    types: database
      .prepare(
        "SELECT COUNT(*) AS count FROM custom_entity_type WHERE merchant_id = ?",
      )
      .get("merchant_rollback"),
  });

  database.exec(
    "CREATE TRIGGER interrupt_receipt BEFORE INSERT ON command_receipt WHEN NEW.idempotency_key = 'rollback_create' BEGIN SELECT RAISE(ABORT, 'interrupted'); END;",
  );
  expect(() => service.command(request)).toThrow("interrupted");
  expect(state()).toEqual({ merchant: { revision: 0 }, types: { count: 0 } });
  database.exec("DROP TRIGGER interrupt_receipt");

  expect(service.command(request)).toMatchObject({
    status: "accepted",
    receipt: { outcome: "applied", merchantRevision: 1 },
  });
  expect(service.command(request)).toMatchObject({
    status: "accepted",
    receipt: { outcome: "already_applied", merchantRevision: 1 },
  });
  expect(state()).toEqual({ merchant: { revision: 1 }, types: { count: 1 } });
  database.close();
});

it("publishes custom types, fences entity revisions, and round-trips list/view queries", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_test", "organisation_test", NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  expect(listRelationshipDefinitions(database, "merchant_test")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        origin: "system",
        definitionId: "shipment_production_batch",
      }),
    ]),
  );
  expect(
    parseRelationshipDefinition({
      origin: "system",
      definitionId: "shipment_production_batch",
      sourceLabel: "Production batches",
      inverseLabel: "Shipment",
      cardinality: "one_to_many",
      deletionBehavior: "detach",
      sensitivity: "internal",
      revision: 1,
    }),
  ).toMatchObject({
    origin: "system",
    definitionId: "shipment_production_batch",
  });
  expect(
    parseEntityPlaneCommandResult({
      status: "rejected",
      error: { code: "provenance_identity_mismatch" },
    }),
  ).toEqual({
    status: "rejected",
    error: { code: "provenance_identity_mismatch" },
  });
  expect(() => parsePositiveRevision(0, "merchantRevision")).toThrow(
    "must be positive",
  );
  const type = parseCustomEntityTypeDraft({
    typeId: "trade_partner",
    label: "Trade partner",
    description: "A partner in the export graph",
    attributes: [
      {
        id: "name",
        scope: {
          kind: "custom",
          entityTypeId: "trade_partner",
          typeRevision: 1,
        },
        label: "Name",
        helpText: null,
        required: true,
        sensitivity: "internal",
        kind: { kind: "short_text", maxLength: 120 },
        revision: 1,
      },
    ],
  });
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "create_trade_partner_type",
    {
      kind: "create_custom_entity_type",
      command: { draft: { ...type, revision: 1 } },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "publish_trade_partner_type",
    {
      kind: "publish_custom_entity_type",
      command: { target: { typeId: type.typeId, revision: 1 } },
    },
  );

  const created = service.command(
    commandRequest("create_partner", 2, {
      kind: "create_custom_entity",
      command: {
        entityId: "partner_a",
        typeId: "trade_partner",
        typeRevision: 1,
        displayName: "Partner A",
        sensitivity: "internal",
        attributes: [
          {
            attributeId: "name",
            scope: {
              kind: "custom",
              entityTypeId: "trade_partner",
              typeRevision: 1,
            },
            definitionRevision: 1,
            sensitivity: "internal",
            value: { kind: "short_text", value: "Partner A" },
          },
        ],
      },
    }),
  );
  expect(created).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 3 },
  });
  const createdReceipt = parseEntityPlaneCommandResult(created);
  if (createdReceipt.status !== "accepted")
    throw new Error("custom entity receipt fixture was rejected");
  const createdReplay = parseEntityPlaneCommandResult(
    service.command(
      commandRequest("create_partner", 2, {
        kind: "create_custom_entity",
        command: {
          entityId: "partner_a",
          typeId: "trade_partner",
          typeRevision: 1,
          displayName: "Partner A",
          sensitivity: "internal",
          attributes: [
            {
              attributeId: "name",
              scope: {
                kind: "custom",
                entityTypeId: "trade_partner",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "Partner A" },
            },
          ],
        },
      }),
    ),
  );
  if (createdReplay.status !== "accepted")
    throw new Error("custom entity replay fixture was rejected");
  expect(createdReplay.receipt).toMatchObject({
    outcome: "already_applied",
    target: { kind: "custom_entity" },
  });
  expectValidTestReceiptSignature(createdReplay.receipt);
  const storedReceipt = database
    .prepare(
      "SELECT receipt_json AS receiptJson FROM command_receipt WHERE merchant_id = ? AND idempotency_key = ?",
    )
    .get<Readonly<{ receiptJson: string }>>("merchant_test", "create_partner");
  const receiptPayload = JSON.parse(storedReceipt?.receiptJson ?? "null");
  expect(receiptPayload.deliveryId).toBe(
    "entity_plane:merchant_test:3:create_partner",
  );
  expect(receiptPayload.signer).toMatchObject({
    keyId: "entity-plane-test",
    algorithm: "ed25519",
  });
  expect(receiptPayload.signer.signature).toBeTruthy();
  const storedDelivery = database
    .prepare(
      "SELECT delivery_json AS deliveryJson FROM observation_outbox WHERE delivery_id = ?",
    )
    .get<Readonly<{ deliveryJson: string }>>(receiptPayload.deliveryId);
  const deliveryPayload = JSON.parse(storedDelivery?.deliveryJson ?? "null");
  expect(deliveryPayload.signer).toMatchObject({
    keyId: "entity-plane-test",
    algorithm: "ed25519",
  });
  expect(deliveryPayload.observations).toEqual([
    expect.objectContaining({
      kind: "custom_entity_changed",
      observationId: "create_partner",
    }),
  ]);
  expect(parseCommerceDelivery(deliveryPayload).observations).toEqual(
    deliveryPayload.observations,
  );

  const read = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      traversal: { maxDepth: 1, resultLimit: 10 },
      filter: null,
    },
  });
  expect(read.entities[0]).toMatchObject({
    displayName: "Partner A",
    reference: { origin: "custom", entityId: "partner_a" },
  });
  expect(parseCommerceGraphResponse(read).entities[0]).toMatchObject({
    displayName: "Partner A",
    reference: { origin: "custom", entityId: "partner_a" },
  });

  const patched = service.command(
    commandRequest("patch_partner", 3, {
      kind: "patch_custom_entity",
      command: {
        entityRef: {
          origin: "custom",
          typeId: "trade_partner",
          entityId: "partner_a",
        },
        typeRevision: 1,
        expectedRevision: 1,
        displayName: "Partner A Updated",
        attributes: [
          {
            attributeId: "name",
            scope: {
              kind: "custom",
              entityTypeId: "trade_partner",
              typeRevision: 1,
            },
            definitionRevision: 1,
            sensitivity: "internal",
            value: { kind: "short_text", value: "Partner A Updated" },
          },
        ],
      },
    }),
  );
  expect(patched).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 4 },
  });
  const beforeStale = database
    .prepare(
      `SELECT
       (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision,
       (SELECT revision FROM custom_entity WHERE merchant_id = ? AND entity_id = ?) AS entityRevision,
       (SELECT COUNT(*) FROM command_receipt WHERE merchant_id = ?) AS receiptCount,
       (SELECT COUNT(*) FROM observation_outbox WHERE merchant_id = ?) AS deliveryCount,
       (SELECT COUNT(*) FROM entity_plane_change WHERE merchant_id = ?) AS changeCount`,
    )
    .get<
      Readonly<{
        merchantRevision: number;
        entityRevision: number;
        receiptCount: number;
        deliveryCount: number;
        changeCount: number;
      }>
    >(
      "merchant_test",
      "merchant_test",
      "partner_a",
      "merchant_test",
      "merchant_test",
      "merchant_test",
    );
  expect(
    service.command(
      commandRequest("stale_patch", 4, {
        kind: "patch_custom_entity",
        command: {
          entityRef: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          typeRevision: 1,
          expectedRevision: 1,
          displayName: "Stale",
          attributes: [
            {
              attributeId: "name",
              scope: {
                kind: "custom",
                entityTypeId: "trade_partner",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "Stale" },
            },
          ],
        },
      }),
    ),
  ).toMatchObject({
    status: "rejected",
    error: { code: "revision_conflict", expected: 1n, received: 2n },
  });
  const afterStale = database
    .prepare(
      `SELECT
       (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision,
       (SELECT revision FROM custom_entity WHERE merchant_id = ? AND entity_id = ?) AS entityRevision,
       (SELECT COUNT(*) FROM command_receipt WHERE merchant_id = ?) AS receiptCount,
       (SELECT COUNT(*) FROM observation_outbox WHERE merchant_id = ?) AS deliveryCount,
       (SELECT COUNT(*) FROM entity_plane_change WHERE merchant_id = ?) AS changeCount`,
    )
    .get<
      Readonly<{
        merchantRevision: number;
        entityRevision: number;
        receiptCount: number;
        deliveryCount: number;
        changeCount: number;
      }>
    >(
      "merchant_test",
      "merchant_test",
      "partner_a",
      "merchant_test",
      "merchant_test",
      "merchant_test",
    );
  expect(afterStale).toEqual(beforeStale);

  const definition = parseRelationshipDefinition({
    origin: "custom",
    definitionId: "partner_connection",
    sourceType: { origin: "custom", typeId: "trade_partner" },
    targetType: { origin: "custom", typeId: "trade_partner" },
    sourceLabel: "Connected to",
    inverseLabel: "Connected from",
    cardinality: "many_to_many",
    deletionBehavior: "detach",
    sensitivity: "internal",
    revision: 1,
  });
  if (definition.origin !== "custom")
    throw new Error("custom relationship definition expected");
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "create_partner_connection_definition",
    {
      kind: "create_custom_relationship_definition",
      command: { draft: definition },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "publish_partner_connection_definition",
    {
      kind: "publish_custom_relationship_definition",
      command: {
        target: { definitionId: definition.definitionId, revision: 1 },
      },
    },
  );

  const second = service.command(
    commandRequest("create_partner_b", 6, {
      kind: "create_custom_entity",
      command: {
        entityId: "partner_b",
        typeId: "trade_partner",
        typeRevision: 1,
        displayName: "Partner B",
        sensitivity: "internal",
        attributes: [
          {
            attributeId: "name",
            scope: {
              kind: "custom",
              entityTypeId: "trade_partner",
              typeRevision: 1,
            },
            definitionRevision: 1,
            sensitivity: "internal",
            value: { kind: "short_text", value: "Partner B" },
          },
        ],
      },
    }),
  );
  expect(second).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 7 },
  });
  expect(
    service.command(
      commandRequest("mixed_relationship", 7, {
        kind: "create_custom_relationship",
        command: {
          target: {
            relationshipId: "partner_mixed",
            definition: {
              origin: "custom",
              definitionId: "partner_connection",
              revision: 1,
            },
            source: {
              origin: "custom",
              typeId: "trade_partner",
              entityId: "partner_a",
            },
            target: {
              origin: "system",
              typeId: "product",
              entityId: "product_1",
            },
          },
        },
      }),
    ),
  ).toMatchObject({
    status: "rejected",
    error: { code: "invalid_relationship_endpoint" },
  });
  const partnerOrderDefinition = parseRelationshipDefinition({
    origin: "custom",
    definitionId: "partner_order",
    sourceType: { origin: "custom", typeId: "trade_partner" },
    targetType: { origin: "system", typeId: "order" },
    sourceLabel: "Orders",
    inverseLabel: "Trade partner",
    cardinality: "one_to_many",
    deletionBehavior: "detach",
    sensitivity: "internal",
    revision: 1,
  });
  if (partnerOrderDefinition.origin !== "custom")
    throw new Error("custom relationship definition expected");
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "create_partner_order_definition",
    {
      kind: "create_custom_relationship_definition",
      command: { draft: partnerOrderDefinition },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "publish_partner_order_definition",
    {
      kind: "publish_custom_relationship_definition",
      command: {
        target: {
          definitionId: partnerOrderDefinition.definitionId,
          revision: 1,
        },
      },
    },
  );
  database
    .prepare(
      `INSERT INTO sales_channel (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'online', 'active', ?, ?)`,
    )
    .run(
      "merchant_test",
      "channel_test",
      "Online",
      JSON.stringify({ state: "active" }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO commerce_order (
       merchant_id, resource_id, revision, sales_channel_id, origin_kind,
       buyer_kind, lifecycle_state, order_snapshot_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'online', 'guest', 'confirmed', ?, ?)`,
    )
    .run(
      "merchant_test",
      "order_1",
      "channel_test",
      JSON.stringify({ id: "order_1", state: "confirmed" }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO commerce_order (
       merchant_id, resource_id, revision, sales_channel_id, origin_kind,
       buyer_kind, lifecycle_state, order_snapshot_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'online', 'guest', 'confirmed', ?, ?)`,
    )
    .run(
      "merchant_test",
      "order_2",
      "channel_test",
      JSON.stringify({ id: "order_2", state: "confirmed" }),
      NOW,
    );
  writeCommerceEntityRelationText(
    database,
    "merchant_test",
    "system",
    "order",
    "order_1",
    1,
    NOW,
    "order_1",
  );
  writeCommerceEntityRelationText(
    database,
    "merchant_test",
    "system",
    "order",
    "order_2",
    1,
    NOW,
    "order_2",
  );
  database
    .prepare(
      `INSERT INTO location (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'warehouse', 'active', ?, ?)`,
    )
    .run(
      "merchant_test",
      "location_test",
      "Warehouse",
      JSON.stringify({ state: "active" }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO fulfillment (
       merchant_id, resource_id, revision, order_id, location_id,
       fulfillment_kind, lifecycle_state, fulfillment_snapshot_json, occurred_at
     ) VALUES (?, ?, 1, ?, ?, 'shipping', 'requested', ?, ?)`,
    )
    .run(
      "merchant_test",
      "fulfillment_1",
      "order_1",
      "location_test",
      JSON.stringify({ id: "fulfillment_1", state: "requested" }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO shipment (
       merchant_id, resource_id, revision, order_id, fulfillment_id,
       lifecycle_state, shipment_snapshot_json, occurred_at
     ) VALUES (?, ?, 1, ?, ?, 'ready', ?, ?)`,
    )
    .run(
      "merchant_test",
      "shipment_1",
      "order_1",
      "fulfillment_1",
      JSON.stringify({ id: "shipment_1", state: "ready" }),
      NOW,
    );
  const canonicalOrderGraph = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "entity_by_ref",
      reference: { origin: "system", typeId: "order", entityId: "order_1" },
      traversal: { maxDepth: 1, resultLimit: 10 },
      filter: null,
    },
  });
  const firstOrderPage = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 1, cursor: null },
      traversal: { maxDepth: 1, resultLimit: 10 },
    },
  });
  expect(firstOrderPage.entities.length).toBeGreaterThanOrEqual(1);
  expect(firstOrderPage.nextCursor).toBeTruthy();
  const terminalOrderPage = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "order" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 1, cursor: firstOrderPage.nextCursor },
      traversal: { maxDepth: 1, resultLimit: 10 },
    },
  });
  expect(terminalOrderPage.entities.length).toBeGreaterThanOrEqual(1);
  expect(terminalOrderPage.nextCursor).toBeNull();
  const canonicalShipmentRelationship = canonicalOrderGraph.relationships.find(
    (relationship) =>
      relationship.origin === "system" &&
      relationship.definition.definitionId === "order_shipment",
  );
  expect(canonicalShipmentRelationship).toBeDefined();
  if (canonicalShipmentRelationship?.origin !== "system")
    throw new Error("canonical shipment relationship expected");
  expect(canonicalShipmentRelationship.provenance.organisationId).toBe(
    "organisation_test",
  );
  expect(canonicalShipmentRelationship.provenance.organisationId).not.toBe(
    "merchant_test",
  );
  expect(canonicalShipmentRelationship.provenance.resourceType).toBe(
    "commerce_order",
  );
  expect(canonicalShipmentRelationship.provenance.resourceId).toBe("order_1");
  const mixedOrderRelationship = service.command(
    commandRequest("partner_order_relationship", 9, {
      kind: "create_custom_relationship",
      command: {
        target: {
          relationshipId: "partner_order_link",
          definition: {
            origin: "custom",
            definitionId: "partner_order",
            revision: 1,
          },
          source: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          target: { origin: "system", typeId: "order", entityId: "order_1" },
        },
      },
    }),
  );
  expect(mixedOrderRelationship).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 10 },
  });
  const partnerGraph = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      traversal: { maxDepth: 1, resultLimit: 10 },
      filter: null,
    },
  });
  expect(partnerGraph.relationships).toContainEqual(
    expect.objectContaining({
      relationshipId: "partner_order_link",
      source: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      target: { origin: "system", typeId: "order", entityId: "order_1" },
    }),
  );
  const beforeCardinalityConflict = database
    .prepare(
      `SELECT
       (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision,
       (SELECT COUNT(*) FROM commerce_relationship WHERE merchant_id = ?) AS relationshipCount,
       (SELECT COUNT(*) FROM observation_outbox WHERE merchant_id = ?) AS deliveryCount,
       (SELECT COUNT(*) FROM entity_plane_change WHERE merchant_id = ?) AS changeCount`,
    )
    .get<
      Readonly<{
        merchantRevision: number;
        relationshipCount: number;
        deliveryCount: number;
        changeCount: number;
      }>
    >("merchant_test", "merchant_test", "merchant_test", "merchant_test");
  expect(
    relationshipCardinalityConflict(
      database,
      "merchant_test",
      partnerOrderDefinition,
      parseEntityRef({
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      }),
      parseEntityRef({
        origin: "system",
        typeId: "order",
        entityId: "order_2",
      }),
    ),
  ).toBeUndefined();
  expect(
    service.command(
      commandRequest("partner_order_cardinality_conflict", 10, {
        kind: "create_custom_relationship",
        command: {
          target: {
            relationshipId: "partner_order_link_second",
            definition: {
              origin: "custom",
              definitionId: "partner_order",
              revision: 1,
            },
            source: {
              origin: "custom",
              typeId: "trade_partner",
              entityId: "partner_b",
            },
            target: { origin: "system", typeId: "order", entityId: "order_1" },
          },
        },
      }),
    ),
  ).toMatchObject({
    status: "rejected",
    error: { code: "duplicate_identity" },
  });
  const afterCardinalityConflict = database
    .prepare(
      `SELECT
       (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision,
       (SELECT COUNT(*) FROM commerce_relationship WHERE merchant_id = ?) AS relationshipCount,
       (SELECT COUNT(*) FROM observation_outbox WHERE merchant_id = ?) AS deliveryCount,
       (SELECT COUNT(*) FROM entity_plane_change WHERE merchant_id = ?) AS changeCount`,
    )
    .get<
      Readonly<{
        merchantRevision: number;
        relationshipCount: number;
        deliveryCount: number;
        changeCount: number;
      }>
    >("merchant_test", "merchant_test", "merchant_test", "merchant_test");
  expect(afterCardinalityConflict).toEqual(beforeCardinalityConflict);
  const existingOrderTarget = parseEntityRef({
    origin: "system",
    typeId: "order",
    entityId: "order_1",
  });
  const existingPartner = parseEntityRef({
    origin: "custom",
    typeId: "trade_partner",
    entityId: "partner_a",
  });
  const existingRelationship = parseClientEntityPlaneCommandRequest(
    commandRequest("replacement_scope", 10, {
      kind: "replace_custom_relationship",
      command: {
        target: {
          relationship: {
            origin: "custom",
            relationshipId: "partner_order_link",
            definition: {
              origin: "custom",
              definitionId: "partner_order",
              revision: 1,
            },
            revision: 1,
          },
          replacementTarget: {
            origin: "system",
            typeId: "order",
            entityId: "order_2",
          },
        },
      },
    }),
  );
  if (
    existingRelationship.command.kind !== "replace_custom_relationship" ||
    existingRelationship.authority.kind !== "relationship_replacement"
  )
    throw new Error("Invalid replacement fixture");
  expect(
    relationshipReplacementCardinalityConflict(
      database,
      "merchant_test",
      partnerOrderDefinition,
      existingPartner,
      existingOrderTarget,
      existingRelationship.command.command.target.relationship.relationshipId,
    ),
  ).toBeUndefined();
  expect(
    service.execute({
      ...existingRelationship,
      authority: {
        ...existingRelationship.authority,
        target: {
          relationship: existingRelationship.authority.target.relationship,
          replacementTarget: existingOrderTarget,
        },
      },
    }),
  ).toMatchObject({
    status: "rejected",
    error: { code: "authority_out_of_scope" },
  });
  const relationshipCommand = commandRequest("partner_relationship", 10, {
    kind: "create_custom_relationship",
    command: {
      target: {
        relationshipId: "partner_link",
        definition: {
          origin: "custom",
          definitionId: "partner_connection",
          revision: 1,
        },
        source: {
          origin: "custom",
          typeId: "trade_partner",
          entityId: "partner_a",
        },
        target: {
          origin: "custom",
          typeId: "trade_partner",
          entityId: "partner_b",
        },
      },
    },
  });
  const relationship = service.command(relationshipCommand);
  expect(relationship).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 11 },
  });
  const relationshipReceiptResult = parseEntityPlaneCommandResult(relationship);
  if (relationshipReceiptResult.status !== "accepted")
    throw new Error("relationship receipt fixture was rejected");
  const relationshipReplayBefore = replayEvidenceCounts(database, {
    kind: "relationship",
    relationshipId: "partner_link",
    changeResourceId: "partner_link",
    commandId: "partner_relationship",
    deliveryId: relationshipReceiptResult.receipt.deliveryId,
  });
  const relationshipReplay = service.command(relationshipCommand);
  expect(relationshipReplay).toMatchObject({
    status: "accepted",
    receipt: {
      commandId: "partner_relationship",
      outcome: "already_applied",
      deliveryId: relationshipReceiptResult.receipt.deliveryId,
    },
  });
  expect(
    replayEvidenceCounts(database, {
      kind: "relationship",
      relationshipId: "partner_link",
      changeResourceId: "partner_link",
      commandId: "partner_relationship",
      deliveryId: relationshipReceiptResult.receipt.deliveryId,
    }),
  ).toEqual(relationshipReplayBefore);
  const relationshipRevisionTwo = parseRelationshipDefinition({
    origin: "custom",
    definitionId: "partner_connection",
    sourceType: { origin: "custom", typeId: "trade_partner" },
    targetType: { origin: "custom", typeId: "trade_partner" },
    sourceLabel: "Connected to v2",
    inverseLabel: "Connected from v2",
    cardinality: "many_to_many",
    deletionBehavior: "detach",
    sensitivity: "internal",
    revision: 2,
  });
  if (relationshipRevisionTwo.origin !== "custom")
    throw new Error("custom relationship definition expected");
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "create_partner_connection_definition_v2",
    {
      kind: "create_custom_relationship_definition",
      command: { draft: relationshipRevisionTwo },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_test",
    "merchant_test",
    "publish_partner_connection_definition_v2",
    {
      kind: "publish_custom_relationship_definition",
      command: {
        target: {
          definitionId: relationshipRevisionTwo.definitionId,
          revision: 2,
        },
      },
    },
  );
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "entity_by_ref",
        reference: {
          origin: "custom",
          typeId: "trade_partner",
          entityId: "partner_a",
        },
        traversal: { maxDepth: 1, resultLimit: 10 },
        filter: null,
      },
    }).relationships,
  ).toContainEqual(
    expect.objectContaining({
      relationshipId: "partner_link",
      definition: {
        origin: "custom",
        definitionId: "partner_connection",
        revision: 1,
      },
    }),
  );

  const list = service.command(
    commandRequest("partner_list", 13, {
      kind: "create_commerce_list",
      command: {
        listId: "partner_list",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
        name: "Partners",
        membership: "unique_entity",
        entryAttributeDefinitions: [],
        publishedRevision: 1,
      },
    }),
  );
  expect(list).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 14 },
  });
  const listReplay = parseEntityPlaneCommandResult(
    service.command(
      commandRequest("partner_list", 13, {
        kind: "create_commerce_list",
        command: {
          listId: "partner_list",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
          name: "Partners",
          membership: "unique_entity",
          entryAttributeDefinitions: [],
          publishedRevision: 1,
        },
      }),
    ),
  );
  if (listReplay.status !== "accepted")
    throw new Error("Commerce List replay fixture was rejected");
  expect(listReplay.receipt).toMatchObject({
    outcome: "already_applied",
    target: { kind: "commerce_list" },
  });
  expectValidTestReceiptSignature(listReplay.receipt);
  const listEntryCommand = commandRequest("partner_entry", 14, {
    kind: "add_commerce_list_entry",
    command: {
      entryId: "partner_entry_a",
      listId: "partner_list",
      expectedListRevision: 1,
      entityRef: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      attributeValues: [],
      revision: 1,
    },
  });
  const listEntry = service.command(listEntryCommand);
  expect(listEntry).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 15 },
  });
  const listEntryReceiptResult = parseEntityPlaneCommandResult(listEntry);
  if (listEntryReceiptResult.status !== "accepted")
    throw new Error("list-entry receipt fixture was rejected");
  const listEntryReplayBefore = replayEvidenceCounts(database, {
    kind: "list_entry",
    entryId: "partner_entry_a",
    listId: "partner_list",
    changeResourceId: "partner_entry_a",
    commandId: "partner_entry",
    deliveryId: listEntryReceiptResult.receipt.deliveryId,
  });
  const listEntryReplay = service.command(listEntryCommand);
  expect(listEntryReplay).toMatchObject({
    status: "accepted",
    receipt: {
      commandId: "partner_entry",
      outcome: "already_applied",
      deliveryId: listEntryReceiptResult.receipt.deliveryId,
    },
  });
  expect(
    replayEvidenceCounts(database, {
      kind: "list_entry",
      entryId: "partner_entry_a",
      listId: "partner_list",
      changeResourceId: "partner_entry_a",
      commandId: "partner_entry",
      deliveryId: listEntryReceiptResult.receipt.deliveryId,
    }),
  ).toEqual(listEntryReplayBefore);
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "commerce_list_page",
        listId: "partner_list",
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
      },
    }).listEntries,
  ).toHaveLength(1);
  const beforeInvalidListEntryMutations = database
    .prepare(
      `SELECT revision, lifecycle_state AS lifecycleState,
            (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision
       FROM commerce_list_entry
      WHERE merchant_id = ? AND entry_id = ?`,
    )
    .get<
      Readonly<{
        revision: number;
        lifecycleState: string;
        merchantRevision: number;
      }>
    >("merchant_test", "merchant_test", "partner_entry_a");
  expect(
    service.command(
      commandRequest("wrong_list_patch", 15, {
        kind: "patch_commerce_list_entry",
        command: {
          target: {
            entry: {
              entryId: "partner_entry_a",
              listId: "wrong_list",
              revision: 1,
            },
            expectedRevision: 1,
          },
          expectedListRevision: 1,
          attributeValues: [],
        },
      }),
    ),
  ).toMatchObject({ status: "rejected", error: { code: "not_found" } });
  expect(
    service.command(
      commandRequest("stale_entry_patch", 15, {
        kind: "patch_commerce_list_entry",
        command: {
          target: {
            entry: {
              entryId: "partner_entry_a",
              listId: "partner_list",
              revision: 2,
            },
            expectedRevision: 2,
          },
          expectedListRevision: 1,
          attributeValues: [],
        },
      }),
    ),
  ).toMatchObject({ status: "rejected", error: { code: "revision_conflict" } });
  expect(
    service.command(
      commandRequest("wrong_list_remove", 15, {
        kind: "remove_commerce_list_entry",
        command: {
          target: {
            entry: {
              entryId: "partner_entry_a",
              listId: "wrong_list",
              revision: 1,
            },
            expectedRevision: 1,
          },
        },
      }),
    ),
  ).toMatchObject({ status: "rejected", error: { code: "not_found" } });
  expect(
    database
      .prepare(
        `SELECT revision, lifecycle_state AS lifecycleState,
            (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision
       FROM commerce_list_entry
      WHERE merchant_id = ? AND entry_id = ?`,
      )
      .get<
        Readonly<{
          revision: number;
          lifecycleState: string;
          merchantRevision: number;
        }>
      >("merchant_test", "merchant_test", "partner_entry_a"),
  ).toEqual(beforeInvalidListEntryMutations);

  expect(
    service.command(
      commandRequest("partner_view", 15, {
        kind: "publish_saved_commerce_view",
        command: {
          view: {
            viewId: "partner_view",
            name: "Partners",
            source: { kind: "commerce_list", listId: "partner_list" },
            filter: { kind: "all" },
            sorts: [],
            visibleAttributeIds: ["name"],
            relationshipColumns: [],
            grouping: null,
            presentation: {
              kind: "table",
              configuration: { density: "comfortable", showRowNumbers: true },
            },
            revision: 1,
          },
        },
      }),
    ),
  ).toMatchObject({
    status: "rejected",
    error: { code: "invalid_view_source" },
  });
  expect(
    service.command(
      commandRequest("partner_list_revision_two", 15, {
        kind: "create_commerce_list",
        command: {
          listId: "partner_list",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
          name: "Partners v2",
          membership: "unique_entity",
          entryAttributeDefinitions: [],
          publishedRevision: 2,
        },
      }),
    ),
  ).toMatchObject({ status: "accepted", receipt: { merchantRevision: 16 } });
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "commerce_list_page",
        listId: "partner_list",
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
      },
    }).listEntries[0],
  ).toMatchObject({ listRevision: 1, entryId: "partner_entry_a" });
  const publishedViewCommand = commandRequest("partner_view_revision_two", 16, {
    kind: "publish_saved_commerce_view",
    command: {
      view: {
        viewId: "partner_view",
        name: "Partners v2",
        source: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
        },
        filter: { kind: "all" },
        sorts: [],
        visibleAttributeIds: ["name"],
        relationshipColumns: [],
        grouping: null,
        presentation: {
          kind: "table",
          configuration: { density: "comfortable", showRowNumbers: true },
        },
        revision: 2,
      },
    },
  });
  expect(service.command(publishedViewCommand)).toMatchObject({
    status: "accepted",
    receipt: { merchantRevision: 17 },
  });
  const viewReplay = parseEntityPlaneCommandResult(
    service.command(publishedViewCommand),
  );
  if (viewReplay.status !== "accepted")
    throw new Error("saved Commerce View replay fixture was rejected");
  expect(viewReplay.receipt).toMatchObject({
    outcome: "already_applied",
    target: { kind: "saved_commerce_view" },
  });
  expectValidTestReceiptSignature(viewReplay.receipt);
  const currentPartnerView = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "saved_commerce_view",
      viewId: "partner_view",
      pagination: { limit: 10, cursor: null },
    },
  });
  expect(currentPartnerView.listEntries).toHaveLength(0);
  expect(
    currentPartnerView.entities.map((entity) => entity.reference.entityId),
  ).toEqual(["partner_a", "partner_b"]);
  const statusDefinition = parseAttributeDefinition({
    id: "state",
    scope: { kind: "custom", entityTypeId: "trade_partner", typeRevision: 1 },
    label: "State",
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind: {
      kind: "status",
      options: [
        { id: "ready", label: "Ready" },
        { id: "blocked", label: "Blocked" },
      ],
    },
    revision: 1,
  });
  expect(
    service.command(
      commandRequest("typed_partner_list", 17, {
        kind: "create_commerce_list",
        command: {
          listId: "typed_partner_list",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
          name: "Typed partners",
          membership: "unique_entity",
          entryAttributeDefinitions: [
            { attributeId: "name", definition: type.attributes[0] },
            { attributeId: "state", definition: statusDefinition },
          ],
          publishedRevision: 1,
        },
      }),
    ),
  ).toMatchObject({ status: "accepted", receipt: { merchantRevision: 18 } });
  expect(
    service.command(
      commandRequest("typed_partner_entry", 18, {
        kind: "add_commerce_list_entry",
        command: {
          entryId: "typed_partner_entry",
          listId: "typed_partner_list",
          expectedListRevision: 1,
          entityRef: {
            origin: "custom",
            typeId: "trade_partner",
            entityId: "partner_a",
          },
          attributeValues: [
            {
              attributeId: "name",
              scope: {
                kind: "custom",
                entityTypeId: "trade_partner",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "Partner A in list" },
            },
            {
              attributeId: "state",
              scope: {
                kind: "custom",
                entityTypeId: "trade_partner",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "status", value: "ready" },
            },
          ],
          revision: 1,
        },
      }),
    ),
  ).toMatchObject({ status: "accepted", receipt: { merchantRevision: 19 } });
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "commerce_list_page",
        listId: "typed_partner_list",
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
      },
    }).listEntries[0]?.attributeValues[0],
  ).toMatchObject({
    attributeId: "name",
    value: { kind: "short_text", value: "Partner A in list" },
  });
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "commerce_list_page",
        listId: "typed_partner_list",
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
      },
    }).listEntries[0]?.attributeValues,
  ).toContainEqual(
    expect.objectContaining({
      attributeId: "state",
      value: { kind: "status", value: "ready" },
    }),
  );
  expect(
    database
      .prepare(
        `SELECT attribute_id, value_kind, comparable_text
       FROM commerce_entity_attribute_relation
      WHERE merchant_id = ? AND subject_kind = 'list_entry'
        AND list_id = ? AND entry_id = ?`,
      )
      .all<
        Readonly<{
          attribute_id: string;
          value_kind: string;
          comparable_text: string | null;
        }>
      >("merchant_test", "typed_partner_list", "typed_partner_entry"),
  ).toContainEqual({
    attribute_id: "state",
    value_kind: "status",
    comparable_text: "ready",
  });
  const attributeExplain = database
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT attribute_id FROM commerce_entity_attribute_relation
      WHERE merchant_id = ? AND subject_kind = 'list_entry'
        AND entity_origin = 'custom' AND entity_type = 'trade_partner'
        AND entity_id = ? AND list_id = ? AND entry_id = ? AND attribute_id = ?`,
    )
    .all<Readonly<{ detail: string }>>(
      "merchant_test",
      "partner_a",
      "typed_partner_list",
      "typed_partner_entry",
      "state",
    )
    .map((row) => row.detail);
  expect(
    attributeExplain.some((detail) =>
      detail.includes("commerce_entity_attribute_relation_filter_idx"),
    ),
  ).toBe(true);
  const context = service.query({
    merchantId: "merchant_test",
    query: {
      kind: "underclerk_context",
      selection: {
        kind: "selector",
        selector: {
          selectorId: "partner_view",
          revision: 1,
          query: {
            kind: "commerce_list_page",
            listId: "partner_list",
            filter: { kind: "all" },
            sorts: [],
            pagination: { limit: 10, cursor: null },
          },
        },
      },
      traversal: { maxDepth: 1, resultLimit: 10 },
      allowedSensitivity: "internal",
      allowedAttributeIds: ["name"],
      freshnessRequirement: "any",
    },
  });
  expect(context.listEntries).toHaveLength(1);
  expect(context.entities.map((entity) => entity.reference.entityId)).toEqual(
    expect.arrayContaining(["partner_a", "partner_b", "order_1"]),
  );
  expect(context.relationships.length).toBeGreaterThanOrEqual(2);
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "aggregation",
        source: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
        },
        filter: { kind: "all" },
        aggregation: { kind: "count" },
      },
    }).aggregations,
  ).toEqual([{ kind: "count", value: 2n }]);
  expect(() =>
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "entity_type_page",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 0, cursor: null },
        traversal: { maxDepth: 1, resultLimit: 10 },
      },
    }),
  ).toThrow("invalid_query");
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "entity_type_page",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
        filter: {
          kind: "attribute",
          filter: {
            attributeId: "name",
            operator: "equals",
            value: { kind: "short_text", value: "Partner A Updated" },
          },
        },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 10 },
      },
    }).entities,
  ).toHaveLength(1);
  expect(
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "aggregation",
        source: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
        },
        filter: {
          kind: "attribute",
          filter: {
            attributeId: "name",
            operator: "equals",
            value: { kind: "short_text", value: "Partner A Updated" },
          },
        },
        aggregation: { kind: "count" },
      },
    }).aggregations,
  ).toEqual([{ kind: "count", value: 1n }]);
  expect(() =>
    service.query({
      merchantId: "merchant_test",
      query: {
        kind: "search",
        text: "Partner",
        entityTypeId: null,
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 1, resultLimit: 10 },
      },
    }),
  ).toThrow("source_mapping");
  database.close();
});

it("reads exact published system-extension revisions without a canonical system row", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_extensions", "organisation_extensions", NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  const firstDefinition = parseAttributeDefinition({
    id: "ext_external_sku",
    scope: {
      kind: "merchant_extension",
      entityTypeId: "product",
      schemaRevision: 1,
    },
    label: "External SKU",
    helpText: null,
    required: false,
    sensitivity: "internal",
    kind: { kind: "short_text", maxLength: 80 },
    revision: 1,
  });
  const secondDefinition = parseAttributeDefinition({
    ...firstDefinition,
    scope: {
      kind: "merchant_extension",
      entityTypeId: "product",
      schemaRevision: 2,
    },
    label: "External SKU v2",
    revision: 2,
  });
  schemaCommand(
    service,
    database,
    "organisation_extensions",
    "merchant_extensions",
    "create_product_extension_schema_v1",
    {
      kind: "create_system_entity_extension_schema",
      command: {
        draft: {
          entityTypeId: "product",
          schemaRevision: 1,
          attributes: [firstDefinition],
        },
      },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_extensions",
    "merchant_extensions",
    "publish_product_extension_schema_v1",
    {
      kind: "publish_system_entity_extension_schema",
      command: { target: { entityTypeId: "product", revision: 1 } },
    },
  );
  database
    .prepare(
      `INSERT INTO system_entity_extension_value (
       merchant_id, system_entity_type_id, system_entity_id,
       extension_schema_revision, attribute_id, value_kind, short_text_value
     ) VALUES (?, ?, ?, 1, ?, 'short_text', ?)`,
    )
    .run(
      "merchant_extensions",
      "product",
      "provider_product_1",
      "ext_external_sku",
      "old-value",
    );
  schemaCommand(
    service,
    database,
    "organisation_extensions",
    "merchant_extensions",
    "create_product_extension_schema_v2",
    {
      kind: "create_system_entity_extension_schema",
      command: {
        draft: {
          entityTypeId: "product",
          schemaRevision: 2,
          attributes: [secondDefinition],
        },
      },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_extensions",
    "merchant_extensions",
    "publish_product_extension_schema_v2",
    {
      kind: "publish_system_entity_extension_schema",
      command: { target: { entityTypeId: "product", revision: 2 } },
    },
  );
  database
    .prepare(
      `INSERT INTO system_entity_extension_value (
       merchant_id, system_entity_type_id, system_entity_id,
       extension_schema_revision, attribute_id, value_kind, short_text_value
     ) VALUES (?, ?, ?, 2, ?, 'short_text', ?)`,
    )
    .run(
      "merchant_extensions",
      "product",
      "provider_product_1",
      "ext_external_sku",
      "current-value",
    );
  const productReference = parseEntityRef({
    origin: "system",
    typeId: "product",
    entityId: "provider_product_1",
  });
  if (productReference.origin !== "system")
    throw new Error("system product reference expected");

  const sidecars = service.readSystemExtensionSidecars({
    organisationId: "organisation_extensions",
    merchantId: "merchant_extensions",
    entityRefs: [productReference],
  });
  expect(sidecars.merchantRevision).toBe(4);
  expect(sidecars.sidecars).toEqual([
    expect.objectContaining({
      entityRef: {
        origin: "system",
        typeId: "product",
        entityId: "provider_product_1",
      },
      extension: { state: "published", revision: 2 },
      attributes: [
        expect.objectContaining({
          value: { kind: "short_text", value: "current-value" },
          definitionRevision: 2,
        }),
      ],
    }),
  ]);
  expect(
    parseEntityPlaneSystemExtensionResponse(sidecars).sidecars[0]?.attributes[0]
      ?.value,
  ).toEqual({ kind: "short_text", value: "current-value" });
  database.close();
});

it("keeps a published custom revision readable after a database restart", () => {
  const databasePath = join(
    tmpdir(),
    `underclerk-entity-plane-${randomUUID()}.sqlite3`,
  );
  let database = new NodeCommerceDatabase(databasePath);
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_restart", "organisation_restart", NOW, NOW);
  let service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  const definition = parseCustomEntityTypeDraft({
    typeId: "restart_type",
    label: "Restart type",
    description: "A persisted published type",
    attributes: [],
  });
  schemaCommand(
    service,
    database,
    "organisation_restart",
    "merchant_restart",
    "create_restart_type_v1",
    {
      kind: "create_custom_entity_type",
      command: { draft: { ...definition, revision: 1 } },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_restart",
    "merchant_restart",
    "publish_restart_type_v1",
    {
      kind: "publish_custom_entity_type",
      command: { target: { typeId: definition.typeId, revision: 1 } },
    },
  );
  const result = service.command(
    parseEntityPlaneCommandRequest(
      {
        organisationId: "organisation_restart",
        merchantId: "merchant_restart",
        commandId: "restart_entity",
        expectedMerchantRevision: 2,
        authority: authorityForCommand(
          {
            kind: "create_custom_entity",
            command: {
              entityId: "restart_entity",
              typeId: "restart_type",
              typeRevision: 1,
              displayName: "Restart entity",
              attributes: [],
              sensitivity: "internal",
            },
          },
          "restart_entity",
          "organisation_restart",
          "merchant_restart",
        ),
        command: {
          kind: "create_custom_entity",
          command: {
            entityId: "restart_entity",
            typeId: "restart_type",
            typeRevision: 1,
            displayName: "Restart entity",
            attributes: [],
            sensitivity: "internal",
          },
        },
      },
      NOW,
    ),
  );
  expect(result).toMatchObject({ status: "accepted" });
  const revisionTwo = parseCustomEntityTypeDraft({
    typeId: "restart_type",
    label: "Restart type v2",
    description: "A second immutable published revision",
    attributes: [],
  });
  schemaCommand(
    service,
    database,
    "organisation_restart",
    "merchant_restart",
    "create_restart_type_v2",
    {
      kind: "create_custom_entity_type",
      command: { draft: { ...revisionTwo, revision: 2 } },
    },
  );
  schemaCommand(
    service,
    database,
    "organisation_restart",
    "merchant_restart",
    "publish_restart_type_v2",
    {
      kind: "publish_custom_entity_type",
      command: { target: { typeId: revisionTwo.typeId, revision: 2 } },
    },
  );
  expect(
    database
      .prepare(
        `SELECT revision, lifecycle_state AS lifecycleState
     FROM custom_entity_type
     WHERE merchant_id = ? AND entity_type_id = ? ORDER BY revision`,
      )
      .all<Readonly<{ revision: number; lifecycleState: string }>>(
        "merchant_restart",
        "restart_type",
      ),
  ).toEqual([
    { revision: 1, lifecycleState: "published" },
    { revision: 2, lifecycleState: "published" },
  ]);
  database.close();

  database = new NodeCommerceDatabase(databasePath);
  service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  expect(
    service.query({
      merchantId: "merchant_restart",
      query: {
        kind: "entity_by_ref",
        reference: {
          origin: "custom",
          typeId: "restart_type",
          entityId: "restart_entity",
        },
        traversal: { maxDepth: 1, resultLimit: 10 },
        filter: null,
      },
    }).entities[0],
  ).toMatchObject({
    typeRevision: 1,
    reference: { entityId: "restart_entity" },
  });
  expect(service.listEntityTypes("merchant_restart")).toContainEqual({
    origin: "custom",
    typeId: "restart_type",
  });
  expect(
    service.command(
      parseEntityPlaneCommandRequest(
        {
          organisationId: "organisation_restart",
          merchantId: "merchant_restart",
          commandId: "replay_old_restart_publish",
          expectedMerchantRevision: 5,
          authority: authorityForCommand(
            {
              kind: "publish_custom_entity_type",
              command: { target: { typeId: definition.typeId, revision: 1 } },
            },
            "replay_old_restart_publish",
            "organisation_restart",
            "merchant_restart",
          ),
          command: {
            kind: "publish_custom_entity_type",
            command: { target: { typeId: definition.typeId, revision: 1 } },
          },
        },
        NOW,
      ),
    ),
  ).toMatchObject({ status: "rejected", error: { code: "revision_conflict" } });
  database.close();
});

it("resolves a published export board selector and returns the bounded shipment graph", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_p0", "organisation_p0", NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });
  service.seedExportCoordinationPreset("merchant_p0");
  database
    .prepare(
      `INSERT INTO sales_channel (
       merchant_id, resource_id, revision, name, kind,
       lifecycle_state, lifecycle_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'online', 'active', ?, ?)`,
    )
    .run(
      "merchant_p0",
      "channel_p0",
      "Online",
      JSON.stringify({ state: "active" }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO commerce_order (
       merchant_id, resource_id, revision, sales_channel_id, origin_kind,
       buyer_kind, lifecycle_state, order_snapshot_json, occurred_at
     ) VALUES (?, ?, 1, ?, 'online', 'guest', 'confirmed', ?, ?)`,
    )
    .run(
      "merchant_p0",
      "order_p0",
      "channel_p0",
      JSON.stringify({ id: "order_p0", state: "confirmed" }),
      NOW,
    );
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO shipment (
       merchant_id, resource_id, revision, order_id, fulfillment_id,
       lifecycle_state, shipment_snapshot_json, occurred_at
     ) VALUES (?, ?, 1, ?, ?, 'ready', ?, ?)`,
    )
    .run(
      "merchant_p0",
      "shipment_p0",
      "order_p0",
      "fulfillment_p0",
      JSON.stringify({ id: "shipment_p0", state: "ready" }),
      NOW,
    );
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO food_service_resource (
       merchant_id, resource_kind, resource_id, revision,
       lifecycle_state, resource_json
     ) VALUES (?, 'production_batch', ?, 1, 'active', ?)`,
    )
    .run(
      "merchant_p0",
      "batch_p0",
      JSON.stringify({
        id: "batch_p0",
        demand: { kind: "shipment", shipmentId: "shipment_p0" },
        occurredAt: NOW,
      }),
    );
  writeCommerceEntityRelationText(
    database,
    "merchant_p0",
    "system",
    "order",
    "order_p0",
    1,
    NOW,
    "order_p0",
  );
  writeCommerceEntityRelationText(
    database,
    "merchant_p0",
    "system",
    "shipment",
    "shipment_p0",
    1,
    NOW,
    "shipment_p0",
  );
  writeCommerceEntityRelationText(
    database,
    "merchant_p0",
    "system",
    "production_batch",
    "batch_p0",
    1,
    NOW,
    "batch_p0",
  );

  const tradePartner = service.command(
    commandWithAuthority({
      organisationId: "organisation_p0",
      merchantId: "merchant_p0",
      commandId: "p0_partner",
      expectedMerchantRevision: 13,
      command: {
        kind: "create_custom_entity",
        command: {
          entityId: "partner_p0",
          typeId: "trade_partner",
          typeRevision: 1,
          displayName: "Trade partner P0",
          sensitivity: "internal",
          attributes: [
            {
              attributeId: "legal_name",
              scope: {
                kind: "custom",
                entityTypeId: "trade_partner",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "Partner P0" },
            },
          ],
        },
      },
    }),
  );
  expect(tradePartner).toMatchObject({ status: "accepted" });
  const exportDocument = service.command(
    commandWithAuthority({
      organisationId: "organisation_p0",
      merchantId: "merchant_p0",
      commandId: "p0_document",
      expectedMerchantRevision: 14,
      command: {
        kind: "create_custom_entity",
        command: {
          entityId: "document_p0",
          typeId: "export_document",
          typeRevision: 1,
          displayName: "Export document P0",
          sensitivity: "internal",
          attributes: [
            {
              attributeId: "document_number",
              scope: {
                kind: "custom",
                entityTypeId: "export_document",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "short_text", value: "DOC-P0" },
            },
            {
              attributeId: "document_type",
              scope: {
                kind: "custom",
                entityTypeId: "export_document",
                typeRevision: 1,
              },
              definitionRevision: 1,
              sensitivity: "internal",
              value: { kind: "status", value: "commercial_invoice" },
            },
          ],
        },
      },
    }),
  );
  expect(exportDocument).toMatchObject({ status: "accepted" });
  expect(
    service.command(
      commandWithAuthority({
        organisationId: "organisation_p0",
        merchantId: "merchant_p0",
        commandId: "p0_partner_order",
        expectedMerchantRevision: 15,
        command: {
          kind: "create_custom_relationship",
          command: {
            target: {
              relationshipId: "partner_order_p0",
              definition: {
                origin: "custom",
                definitionId: "trade_partner_order",
                revision: 1,
              },
              source: {
                origin: "custom",
                typeId: "trade_partner",
                entityId: "partner_p0",
              },
              target: {
                origin: "system",
                typeId: "order",
                entityId: "order_p0",
              },
            },
          },
        },
      }),
    ),
  ).toMatchObject({ status: "accepted" });
  expect(
    service.command(
      commandWithAuthority({
        organisationId: "organisation_p0",
        merchantId: "merchant_p0",
        commandId: "p0_document_relationship",
        expectedMerchantRevision: 16,
        command: {
          kind: "create_custom_relationship",
          command: {
            target: {
              relationshipId: "shipment_document_p0",
              definition: {
                origin: "custom",
                definitionId: "shipment_export_document",
                revision: 1,
              },
              source: {
                origin: "system",
                typeId: "shipment",
                entityId: "shipment_p0",
              },
              target: {
                origin: "custom",
                typeId: "export_document",
                entityId: "document_p0",
              },
            },
          },
        },
      }),
    ),
  ).toMatchObject({ status: "accepted" });
  expect(
    service.command(
      commandWithAuthority({
        organisationId: "organisation_p0",
        merchantId: "merchant_p0",
        commandId: "p0_export_board_entry",
        expectedMerchantRevision: 17,
        command: {
          kind: "add_commerce_list_entry",
          command: {
            entryId: "export_coordination_shipment_p0",
            listId: "export_coordination",
            expectedListRevision: 1,
            entityRef: {
              origin: "system",
              typeId: "shipment",
              entityId: "shipment_p0",
            },
            attributeValues: [
              {
                attributeId: "stage",
                scope: {
                  kind: "system",
                  entityTypeId: "shipment",
                  schemaRevision: 1,
                },
                definitionRevision: 1,
                sensitivity: "internal",
                value: { kind: "status", value: "ready" },
              },
              {
                attributeId: "owner",
                scope: {
                  kind: "system",
                  entityTypeId: "shipment",
                  schemaRevision: 1,
                },
                definitionRevision: 1,
                sensitivity: "internal",
                value: {
                  kind: "merchant_operator_reference",
                  value: {
                    principalId: "operator_p0",
                    displayName: "Operator P0",
                  },
                },
              },
              {
                attributeId: "due_at",
                scope: {
                  kind: "system",
                  entityTypeId: "shipment",
                  schemaRevision: 1,
                },
                definitionRevision: 1,
                sensitivity: "internal",
                value: { kind: "timestamp", value: NOW },
              },
              {
                attributeId: "priority",
                scope: {
                  kind: "system",
                  entityTypeId: "shipment",
                  schemaRevision: 1,
                },
                definitionRevision: 1,
                sensitivity: "internal",
                value: { kind: "status", value: "high" },
              },
              {
                attributeId: "exception_reason",
                scope: {
                  kind: "system",
                  entityTypeId: "shipment",
                  schemaRevision: 1,
                },
                definitionRevision: 1,
                sensitivity: "internal",
                value: {
                  kind: "long_text",
                  value: "Awaiting export documents",
                },
              },
            ],
            revision: 1,
          },
        },
      }),
    ),
  ).toMatchObject({ status: "accepted" });

  const result = service.query({
    merchantId: "merchant_p0",
    query: {
      kind: "underclerk_context",
      selection: {
        kind: "selector",
        selector: {
          selectorId: "export_board",
          revision: 1,
          query: {
            kind: "saved_commerce_view",
            viewId: "export_board",
            pagination: { limit: 20, cursor: null },
          },
        },
      },
      traversal: { maxDepth: 2, resultLimit: 20 },
      allowedSensitivity: "internal",
      allowedAttributeIds: [
        "stage",
        "owner",
        "due_at",
        "priority",
        "exception_reason",
      ],
      freshnessRequirement: "any",
    },
  });
  expect(result.listEntries).toHaveLength(1);
  expect(result.listEntries[0]?.attributeValues).toHaveLength(5);
  expect(result.listEntries[0]?.attributeValues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        attributeId: "stage",
        value: { kind: "status", value: "ready" },
      }),
      expect.objectContaining({
        attributeId: "owner",
        value: {
          kind: "merchant_operator_reference",
          value: { principalId: "operator_p0", displayName: "Operator P0" },
        },
      }),
      expect.objectContaining({
        attributeId: "due_at",
        value: { kind: "timestamp", value: NOW },
      }),
      expect.objectContaining({
        attributeId: "priority",
        value: { kind: "status", value: "high" },
      }),
      expect.objectContaining({
        attributeId: "exception_reason",
        value: { kind: "long_text", value: "Awaiting export documents" },
      }),
    ]),
  );
  expect(result.entities).toHaveLength(5);
  expect(result.relationships).toHaveLength(4);
  expect(result.relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        origin: "system",
        definition: expect.objectContaining({
          definitionId: "shipment_production_batch",
        }),
      }),
      expect.objectContaining({
        origin: "custom",
        definition: expect.objectContaining({
          definitionId: "shipment_export_document",
        }),
      }),
    ]),
  );
  database.close();
});

it("replays every schema receipt target without duplicating durable evidence", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run("merchant_schema_replay", "organisation_schema_replay", NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: () => NOW,
    signer: TEST_SIGNER,
  });

  replaySchemaCommand(
    service,
    database,
    "schema_type_create",
    {
      kind: "create_custom_entity_type",
      command: {
        draft: {
          typeId: "schema_partner",
          label: "Schema partner",
          description: "Replay fixture",
          attributes: [],
          revision: 1,
        },
      },
    },
    "custom_entity_type",
  );
  replaySchemaCommand(
    service,
    database,
    "schema_type_publish",
    {
      kind: "publish_custom_entity_type",
      command: { target: { typeId: "schema_partner", revision: 1 } },
    },
    "custom_entity_type",
  );
  replaySchemaCommand(
    service,
    database,
    "schema_relationship_create",
    {
      kind: "create_custom_relationship_definition",
      command: {
        draft: {
          origin: "custom",
          definitionId: "schema_partner_order",
          sourceType: { origin: "custom", typeId: "schema_partner" },
          targetType: { origin: "system", typeId: "order" },
          sourceLabel: "Orders",
          inverseLabel: "Partner",
          cardinality: "one_to_many",
          deletionBehavior: "detach",
          sensitivity: "internal",
          revision: 1,
        },
      },
    },
    "custom_relationship_definition",
  );
  replaySchemaCommand(
    service,
    database,
    "schema_relationship_publish",
    {
      kind: "publish_custom_relationship_definition",
      command: {
        target: { definitionId: "schema_partner_order", revision: 1 },
      },
    },
    "custom_relationship_definition",
  );
  replaySchemaCommand(
    service,
    database,
    "schema_extension_create",
    {
      kind: "create_system_entity_extension_schema",
      command: {
        draft: { entityTypeId: "shipment", schemaRevision: 1, attributes: [] },
      },
    },
    "system_entity_extension_schema",
  );
  replaySchemaCommand(
    service,
    database,
    "schema_extension_publish",
    {
      kind: "publish_system_entity_extension_schema",
      command: { target: { entityTypeId: "shipment", revision: 1 } },
    },
    "system_entity_extension_schema",
  );
  database.close();
});

type ReplayEvidenceInput = Readonly<{
  readonly commandId: string;
  readonly changeResourceId: string;
  readonly deliveryId: string | null;
}> &
  (
    | Readonly<{
        readonly kind: "relationship";
        readonly relationshipId: string;
      }>
    | Readonly<{
        readonly kind: "list_entry";
        readonly listId: string;
        readonly entryId: string;
      }>
  );

type ReplayEvidenceCounts = Readonly<{
  readonly rowCount: number;
  readonly changeCount: number;
  readonly receiptCount: number;
  readonly deliveryCount: number;
}>;

function replayEvidenceCounts(
  database: NodeCommerceDatabase,
  input: ReplayEvidenceInput,
): ReplayEvidenceCounts {
  if (input.deliveryId === null)
    throw new Error("entity-plane replay fixture must carry a delivery");
  const rowCount =
    input.kind === "relationship"
      ? (database
          .prepare(
            "SELECT COUNT(*) AS count FROM commerce_relationship WHERE merchant_id = ? AND relationship_id = ?",
          )
          .get<Readonly<{ count: number }>>(
            "merchant_test",
            input.relationshipId,
          )?.count ?? 0)
      : (database
          .prepare(
            "SELECT COUNT(*) AS count FROM commerce_list_entry WHERE merchant_id = ? AND list_id = ? AND entry_id = ?",
          )
          .get<Readonly<{ count: number }>>(
            "merchant_test",
            input.listId,
            input.entryId,
          )?.count ?? 0);
  return {
    rowCount,
    changeCount:
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM entity_plane_change WHERE merchant_id = ? AND resource_id = ?",
        )
        .get<Readonly<{ count: number }>>(
          "merchant_test",
          input.changeResourceId,
        )?.count ?? 0,
    receiptCount:
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM command_receipt WHERE merchant_id = ? AND idempotency_key = ?",
        )
        .get<Readonly<{ count: number }>>("merchant_test", input.commandId)
        ?.count ?? 0,
    deliveryCount:
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM observation_outbox WHERE merchant_id = ? AND delivery_id = ?",
        )
        .get<Readonly<{ count: number }>>("merchant_test", input.deliveryId)
        ?.count ?? 0,
  };
}

type AuthorityFixture = Readonly<{
  kind: string;
  context: Readonly<Record<string, unknown>>;
  scope: Readonly<Record<string, unknown>>;
  target?: Readonly<Record<string, unknown>>;
}>;

function authorityForCommand(
  command: unknown,
  commandId: string,
  organisationId: string,
  merchantId: string,
): AuthorityFixture {
  const parsed = parseCommerceEntityPlaneCommand(command);
  const context = {
    organisationId,
    merchantId,
    principalId: "principal_test",
    sensitivityCeiling: "restricted",
    expiresAt: "2030-01-01T00:00:00.000Z",
    causation: { kind: "command", commandId },
  };
  switch (parsed.kind) {
    case "create_custom_entity_type": {
      const target = { typeId: parsed.command.draft.typeId };
      return {
        kind: "custom_entity_type_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: target.typeId },
        },
        target,
      };
    }
    case "publish_custom_entity_type": {
      const target = parsed.command.target;
      return {
        kind: "custom_entity_type_publish",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: target.typeId },
        },
        target,
      };
    }
    case "create_custom_relationship_definition": {
      const target = { definitionId: parsed.command.draft.definitionId };
      return {
        kind: "custom_relationship_definition_create",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: {
            origin: "custom",
            definitionId: target.definitionId,
            revision: parsed.command.draft.revision,
          },
        },
        target,
      };
    }
    case "publish_custom_relationship_definition": {
      const target = parsed.command.target;
      return {
        kind: "custom_relationship_definition_publish",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: {
            origin: "custom",
            definitionId: target.definitionId,
            revision: target.revision,
          },
        },
        target,
      };
    }
    case "create_system_entity_extension_schema": {
      const target = { entityTypeId: parsed.command.draft.entityTypeId };
      return {
        kind: "system_entity_extension_schema_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId: target.entityTypeId },
        },
        target,
      };
    }
    case "publish_system_entity_extension_schema": {
      const target = parsed.command.target;
      return {
        kind: "system_entity_extension_schema_publish",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId: target.entityTypeId },
        },
        target,
      };
    }
    case "create_custom_entity": {
      const target = {
        entityId: parsed.command.entityId,
        typeId: parsed.command.typeId,
      };
      return {
        kind: "entity_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: target.typeId },
        },
        target,
      };
    }
    case "patch_custom_entity":
    case "archive_custom_entity": {
      const target = {
        entityRef: parsed.command.entityRef,
        expectedRevision: parsed.command.expectedRevision,
      };
      return {
        kind: "entity_command",
        context,
        scope: { kind: "entity", entityRef: target.entityRef },
        target,
      };
    }
    case "create_custom_relationship": {
      const target = parsed.command.target;
      return {
        kind: "relationship_create",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: target.definition,
        },
        target,
      };
    }
    case "delete_custom_relationship": {
      const target = parsed.command.target;
      return {
        kind: "relationship_command",
        context,
        scope: { kind: "relationship", relationship: target.relationship },
        target,
      };
    }
    case "replace_custom_relationship": {
      const target = parsed.command.target;
      return {
        kind: "relationship_replacement",
        context,
        scope: { kind: "relationship", relationship: target.relationship },
        target,
      };
    }
    case "create_commerce_list": {
      const target = {
        listId: parsed.command.listId,
        entityTypeId: parsed.command.entityTypeId,
      };
      return {
        kind: "commerce_list_create",
        context,
        scope: { kind: "commerce_list", listId: target.listId },
        target,
      };
    }
    case "add_commerce_list_entry": {
      const target = {
        entry: {
          entryId: parsed.command.entryId,
          listId: parsed.command.listId,
          revision: parsed.command.revision,
        },
        listRevision: parsed.command.expectedListRevision,
        entityTypeId:
          parsed.command.entityRef.origin === "custom"
            ? { origin: "custom", typeId: parsed.command.entityRef.typeId }
            : { origin: "system", typeId: parsed.command.entityRef.typeId },
        entityRef: parsed.command.entityRef,
      };
      return {
        kind: "commerce_list_entry_create",
        context,
        scope: { kind: "commerce_list", listId: target.entry.listId },
        target,
      };
    }
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry": {
      const target = parsed.command.target;
      return {
        kind: "commerce_list_entry_command",
        context,
        scope: { kind: "commerce_list_entry", entry: target.entry },
        target,
      };
    }
    case "publish_saved_commerce_view": {
      const target = { viewId: parsed.command.view.viewId };
      return {
        kind: "saved_view_create",
        context,
        scope: { kind: "saved_view", viewId: target.viewId },
        target,
      };
    }
    case "archive_saved_commerce_view": {
      const target = parsed.command.target;
      return {
        kind: "saved_view_administration",
        context,
        scope: { kind: "saved_view", viewId: target.viewId },
        target,
      };
    }
  }
}

function commandRequest(
  commandId: string,
  expectedMerchantRevision: number,
  command: unknown,
): unknown {
  return {
    organisationId: "organisation_test",
    merchantId: "merchant_test",
    commandId,
    expectedMerchantRevision,
    authority: authorityForCommand(
      command,
      commandId,
      "organisation_test",
      "merchant_test",
    ),
    command,
  };
}

function commandWithAuthority(
  request: Readonly<{
    organisationId: string;
    merchantId: string;
    commandId: string;
    expectedMerchantRevision: number;
    command: unknown;
  }>,
): unknown {
  return {
    ...request,
    authority: authorityForCommand(
      request.command,
      request.commandId,
      request.organisationId,
      request.merchantId,
    ),
  };
}

function schemaCommand(
  service: EntityPlaneService,
  database: NodeCommerceDatabase,
  organisationId: string,
  merchantId: string,
  commandId: string,
  command: unknown,
): void {
  const merchant = database
    .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
    .get<Readonly<{ revision: number }>>(merchantId);
  if (merchant === undefined)
    throw new Error(`Merchant not found: ${merchantId}`);
  const result = service.command(
    parseEntityPlaneCommandRequest(
      {
        organisationId,
        merchantId,
        commandId,
        expectedMerchantRevision: merchant.revision,
        authority: authorityForCommand(
          command,
          commandId,
          organisationId,
          merchantId,
        ),
        command,
      },
      NOW,
    ),
  );
  expect(result).toMatchObject({ status: "accepted" });
}

function replaySchemaCommand(
  service: EntityPlaneService,
  database: NodeCommerceDatabase,
  commandId: string,
  command: unknown,
  targetKind: string,
): void {
  const merchant = database
    .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
    .get<Readonly<{ revision: number }>>("merchant_schema_replay");
  if (merchant === undefined)
    throw new Error("schema replay merchant is missing");
  const request = parseEntityPlaneCommandRequest(
    {
      organisationId: "organisation_schema_replay",
      merchantId: "merchant_schema_replay",
      commandId,
      expectedMerchantRevision: merchant.revision,
      authority: authorityForCommand(
        command,
        commandId,
        "organisation_schema_replay",
        "merchant_schema_replay",
      ),
      command,
    },
    NOW,
  );
  const applied = parseEntityPlaneCommandResult(service.command(request));
  if (applied.status !== "accepted")
    throw new Error(`schema replay command ${commandId} was rejected`);
  expect(applied.receipt).toMatchObject({
    commandId,
    outcome: "applied",
    deliveryId: null,
    target: { kind: targetKind },
  });
  const beforeReplay = schemaReplayEvidence(database);
  const replayed = parseEntityPlaneCommandResult(service.command(request));
  if (replayed.status !== "accepted")
    throw new Error(`schema replay command ${commandId} replay was rejected`);
  expect(replayed.receipt).toMatchObject({
    commandId,
    outcome: "already_applied",
    deliveryId: null,
    target: { kind: targetKind },
  });
  expectValidTestReceiptSignature(replayed.receipt);
  expect(schemaReplayEvidence(database)).toEqual(beforeReplay);
}

function expectValidTestReceiptSignature(
  receipt: CommerceMutationReceiptV1,
): void {
  const signedEnvelope = JSON.parse(
    Buffer.from(receipt.signer.signature, "base64url").toString("utf8"),
  );
  const expectedEnvelope = JSON.parse(
    JSON.stringify(
      {
        commandId: receipt.commandId,
        outcome: receipt.outcome,
        target: receipt.target,
        merchantRevision: receipt.merchantRevision,
        committedAt: receipt.committedAt,
        deliveryId: receipt.deliveryId,
      },
      testJsonReplacer,
    ),
  );
  expect(signedEnvelope).toEqual(expectedEnvelope);
}

function testJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function schemaReplayEvidence(database: NodeCommerceDatabase): Readonly<{
  merchantRevision: number;
  changeCount: number;
  receiptCount: number;
  deliveryCount: number;
}> {
  return database
    .prepare(
      `SELECT
       (SELECT revision FROM merchant WHERE merchant_id = ?) AS merchantRevision,
       (SELECT COUNT(*) FROM entity_plane_change WHERE merchant_id = ?) AS changeCount,
       (SELECT COUNT(*) FROM command_receipt WHERE merchant_id = ?) AS receiptCount,
       (SELECT COUNT(*) FROM observation_outbox WHERE merchant_id = ?) AS deliveryCount`,
    )
    .get<
      Readonly<{
        merchantRevision: number;
        changeCount: number;
        receiptCount: number;
        deliveryCount: number;
      }>
    >(
      "merchant_schema_replay",
      "merchant_schema_replay",
      "merchant_schema_replay",
      "merchant_schema_replay",
    )!;
}
