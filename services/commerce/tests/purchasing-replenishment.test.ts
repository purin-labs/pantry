import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  CommerceEntityPlaneClient,
  parseCommerceEntityPlaneCommand,
  parseEntityPlaneCommand,
  parseListEntryReadRequest,
} from "@purin-labs/commerce-client";

import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import { EntityPlaneService } from "../src/entity-plane/service.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";
import { writeCommerceEntityRelationText } from "../src/entity-plane/relation-text.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { DeterministicPaymentGateway } from "../src/payments/provider.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { isRecord } from "@purin-labs/std";

const NOW = "2026-08-29T00:00:00.000Z";
const MERCHANT_ID = "merchant_purchasing";
const ORGANISATION_ID = "organisation_purchasing";
const SERVICE_TOKEN = "purchasing-service-token";
const TEST_SIGNER = {
  keyId: "purchasing-test",
  publicKeyB64: "purchasing-test-public-key",
  sign: (payload: Uint8Array): string =>
    Buffer.from(payload).toString("base64url"),
};

it("opens one evidence-backed requirement and closes it from accepted receipts", () => {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  database
    .prepare(
      `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    )
    .run(MERCHANT_ID, ORGANISATION_ID, NOW, NOW);
  const service = new EntityPlaneService({
    database,
    now: currentTime,
    signer: TEST_SIGNER,
  });

  service.seedPurchasingPreset(MERCHANT_ID);
  insertSupplierFixture(database);
  insertLowStockFixture(database);

  expect(service.reconcilePurchasingForMerchant(MERCHANT_ID)).toEqual({
    kind: "reconciled",
    opened: 1,
    updated: 0,
    received: 0,
  });
  expect(service.reconcilePurchasingForMerchant(MERCHANT_ID)).toEqual({
    kind: "reconciled",
    opened: 0,
    updated: 0,
    received: 0,
  });
  expect(queueEntryFacts(database)).toMatchObject({
    status: "needs_review",
    availableQuantity: 5_000_000,
    reorderPoint: 10_000_000,
    targetQuantity: 20_000_000,
    requiredQuantity: 15_000_000,
    receivedQuantity: 0,
    supplierId: "supplier_packaging",
    owner: "Café purchasing",
    closedAt: null,
  });

  setExpectedDeliveryInPast(database);
  expect(service.reconcilePurchasingForMerchant(MERCHANT_ID)).toEqual({
    kind: "reconciled",
    opened: 0,
    updated: 1,
    received: 0,
  });
  expect(queueEntryFacts(database)).toMatchObject({
    status: "late",
    receivedQuantity: 0,
    closedAt: null,
  });

  insertReceiptMovement(database, "receipt_partial", "line_partial", 5, 2);
  expect(service.reconcilePurchasingForMerchant(MERCHANT_ID)).toEqual({
    kind: "reconciled",
    opened: 0,
    updated: 1,
    received: 0,
  });
  expect(queueEntryFacts(database)).toMatchObject({
    status: "partial",
    receivedQuantity: 5_000_000,
    closedAt: null,
  });

  insertReceiptMovement(database, "receipt_complete", "line_complete", 10, 3);
  expect(service.reconcilePurchasingForMerchant(MERCHANT_ID)).toEqual({
    kind: "reconciled",
    opened: 0,
    updated: 1,
    received: 1,
  });
  expect(queueEntryFacts(database)).toMatchObject({
    status: "received",
    receivedQuantity: 15_000_000,
    closedAt: NOW,
  });
  expect(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM entity_plane_change
      WHERE merchant_id = ? AND change_kind = 'commerce_list_entry'`,
      )
      .get(MERCHANT_ID),
  ).toEqual({ count: 4 });
  expect(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM observation_outbox
      WHERE merchant_id = ? AND delivery_id LIKE 'entity_plane:%'`,
      )
      .get(MERCHANT_ID),
  ).toEqual({ count: 4 });
  expect(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM command_receipt
      WHERE merchant_id = ? AND idempotency_key LIKE 'recipe:replenishment:%'`,
      )
      .get(MERCHANT_ID),
  ).toEqual({ count: 4 });
  database.close();
});

it(
  "publishes and reconciles purchasing through the authenticated client boundary",
  purchasingHttpJourney,
);
async function purchasingHttpJourney(): Promise<void> {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  const authority = new CommerceAuthority({
    database,
    signer: TEST_SIGNER,
    paymentGateway: new DeterministicPaymentGateway(),
    now: currentTime,
    shippingGateway: createJapanShippingGateway("purchasing-shipping-key"),
  });
  authority.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    createdAt: NOW,
  });
  const service = new EntityPlaneService({
    database,
    now: currentTime,
    signer: TEST_SIGNER,
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "purchasing-buyer-session-secret-0001",
      now: currentTime,
    }),
    serviceToken: SERVICE_TOKEN,
    entityPlane: service,
  });
  const client = new CommerceEntityPlaneClient({
    baseUrl: "https://commerce.test",
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });

  const request = { organisationId: ORGANISATION_ID, merchantId: MERCHANT_ID };
  try {
    const inactive = await client.reconcilePurchasing(request);
    expect(inactive).toMatchObject({ ok: true, value: { kind: "inactive" } });
    const published = await client.publishPurchasingPreset(request);
    expect(published).toMatchObject({
      ok: true,
      value: {
        kind: "published",
        organisationId: ORGANISATION_ID,
        merchantId: MERCHANT_ID,
      },
    });
    expect(await client.publishPurchasingPreset(request)).toEqual(published);
    const productionDemand =
      await client.publishProductionDemandPreset(request);
    expect(productionDemand).toMatchObject({
      ok: true,
      value: { kind: "published" },
    });
    expect(await client.publishProductionDemandPreset(request)).toEqual(
      productionDemand,
    );
    const metadata = await client.publishedResourceMetadata({
      kind: "enumerate",
      ...request,
    });
    expect(metadata.ok).toBe(true);
    if (!metadata.ok || metadata.value.kind !== "enumerated")
      throw new Error("Purchasing metadata missing");
    const listIds = metadata.value.lists.map(purchasingListId);
    expect(listIds).toEqual(
      expect.arrayContaining([
        "supplier_directory",
        "replenishment_queue",
        "supply_cost_terms",
      ]),
    );
    const reconciled = await client.reconcilePurchasing(request);
    expect(reconciled).toMatchObject({
      ok: true,
      value: { kind: "reconciled", opened: 0, updated: 0, received: 0 },
    });
    const wrongOrganisation = await client.reconcilePurchasing({
      ...request,
      organisationId: "organisation_other",
    });
    expect(wrongOrganisation).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const unauthorized = await api.fetch(
      `https://commerce.test/v1/admin/merchants/${MERCHANT_ID}/entity-plane/purchasing-reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    expect(unauthorized.status).toBe(401);
    const malformed = await api.fetch(
      `https://commerce.test/v1/admin/merchants/${MERCHANT_ID}/entity-plane/purchasing-reconcile`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request, opened: 1 }),
      },
    );
    expect(malformed.status).toBe(400);
    expect(await client.reconcilePurchasing(request)).toEqual(reconciled);
    const directory = new URL("../output/plan-78/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new URL("purchasing-envelope-http.json", directory),
      `${JSON.stringify(
        {
          status: "passed",
          inactive,
          published,
          productionDemand,
          reconciled,
          listIds,
          replayPreserved: true,
          wrongOrganisationRefused: true,
          unauthorizedStatus: unauthorized.status,
          malformedStatus: malformed.status,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    database.close();
  }
}
// Refactor 15, refactor 7: a purchase request's status follows its machine
// and the receipts that name it. A person who moves the request to Received
// on the board with no delivery is refused, so the real delivery is still
// taken; a second receipt for the same delivery, before the reconciler runs,
// is refused, so the stock counts the delivery once.
it(
  "refuses a board move to received with no stock, and a second receipt for a covered request",
  purchaseRequestJourney,
);
async function purchaseRequestJourney(): Promise<void> {
  const database = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(database, NOW);
  const authority = new CommerceAuthority({
    database,
    signer: TEST_SIGNER,
    paymentGateway: new DeterministicPaymentGateway(),
    now: currentTime,
    shippingGateway: createJapanShippingGateway("purchasing-shipping-key"),
  });
  authority.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    createdAt: NOW,
  });
  const service = new EntityPlaneService({
    database,
    now: currentTime,
    signer: TEST_SIGNER,
  });
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: "purchasing-buyer-session-secret-0001",
      now: currentTime,
    }),
    serviceToken: SERVICE_TOKEN,
    entityPlane: service,
  });
  const client = new CommerceEntityPlaneClient({
    baseUrl: "https://commerce.test",
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });
  const request = { organisationId: ORGANISATION_ID, merchantId: MERCHANT_ID };
  try {
    expect(await client.publishPurchasingPreset(request)).toMatchObject({
      ok: true,
    });
    insertSupplierFixture(database);
    insertLowStockFixture(database);
    expect(await client.reconcilePurchasing(request)).toMatchObject({
      ok: true,
      value: { kind: "reconciled", opened: 1 },
    });
    const entryId = queueEntryId(database);

    // A person drags the request to Received before any delivery.
    const read = await client.readListEntry(
      parseListEntryReadRequest({
        merchantId: MERCHANT_ID,
        listId: "replenishment_queue",
        entryId,
      }),
    );
    if (!read.ok || read.value.kind !== "found")
      throw new Error("The purchase request cannot be read");
    const entry = read.value.entry;
    const target = {
      entry: {
        entryId,
        listId: "replenishment_queue",
        revision: entry.revision,
      },
      expectedRevision: entry.revision,
    };
    const board = await client.command(
      parseEntityPlaneCommand({
        ...request,
        commandId: "board_move_received",
        expectedMerchantRevision: merchantRevision(database),
        authority: {
          kind: "commerce_list_entry_command",
          context: {
            ...request,
            principalId: "operator",
            sensitivityCeiling: "restricted",
            expiresAt: "2099-01-01T00:00:00Z",
            causation: { kind: "command", commandId: "board_move_received" },
          },
          scope: { kind: "commerce_list_entry", entry: target.entry },
          target,
        },
        command: parseCommerceEntityPlaneCommand({
          kind: "patch_commerce_list_entry",
          command: {
            target,
            expectedListRevision: read.value.listRevision,
            attributeValues: entry.attributeValues.map((value) =>
              value.attributeId === "status"
                ? { ...value, value: { kind: "status", value: "received" } }
                : value,
            ),
          },
        }),
      }),
    );
    expect(board).toMatchObject({
      ok: true,
      value: {
        status: "rejected",
        error: { code: "invalid_attribute_value", attributeId: "status" },
      },
    });
    expect(queueEntryFacts(database)).toMatchObject({
      status: "needs_review",
      receivedQuantity: 0,
    });

    // The supplier delivers the whole request, and the receipt is taken.
    const receive = (receiptId: string) =>
      authority.receiveInventory({
        schemaVersion: "commerce.receive-inventory.v3",
        merchantId: MERCHANT_ID,
        expectedMerchantRevision: merchantRevision(database),
        idempotencyKey: `receive_${receiptId}`,
        requestedAt: NOW,
        purchase: { kind: "replenishment", entryId, entryRevision: 1 },
        receiptId,
        receiptLineId: `${receiptId}_cups`,
        inventoryItemId: "packaging_cups",
        inventoryItemRevision: 1,
        inventoryPositionId: "position_packaging_cups",
        inventoryPositionRevision: positionRevision(database),
        locationId: "cafe",
        receivedQuantity: { amount: 15, scale: 0, unit: "each" },
        lot: { kind: "not_tracked" },
        receivedAt: NOW,
      });
    expect(receive("delivery_note_1")).toMatchObject({ outcome: "applied" });
    // The same delivery scanned again under a second receipt is refused.
    expect(receive("delivery_note_1_again")).toMatchObject({
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "purchase.entryId",
      },
    });
    expect(onHand(database)).toBe(20);

    // The reconciler closes the request from the one receipt.
    expect(await client.reconcilePurchasing(request)).toMatchObject({
      ok: true,
      value: { kind: "reconciled", updated: 1, received: 1 },
    });
    expect(queueEntryFacts(database)).toMatchObject({
      status: "received",
      receivedQuantity: 15_000_000,
    });
  } finally {
    database.close();
  }
}

function merchantRevision(database: NodeCommerceDatabase): number {
  const row = database
    .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
    .get<{ revision: number }>(MERCHANT_ID);
  if (row === undefined) throw new Error("Merchant missing");
  return row.revision;
}

function positionRevision(database: NodeCommerceDatabase): number {
  const row = database
    .prepare(
      `SELECT revision FROM inventory_position
       WHERE merchant_id = ? AND inventory_position_id = 'position_packaging_cups'`,
    )
    .get<{ revision: number }>(MERCHANT_ID);
  if (row === undefined) throw new Error("Position missing");
  return row.revision;
}

function onHand(database: NodeCommerceDatabase): number {
  const row = database
    .prepare(
      `SELECT on_hand_amount AS onHand FROM inventory_position
       WHERE merchant_id = ? AND inventory_position_id = 'position_packaging_cups'`,
    )
    .get<{ onHand: number }>(MERCHANT_ID);
  if (row === undefined) throw new Error("Position missing");
  return row.onHand;
}

function purchasingListId(value: { listId: string }): string {
  return value.listId;
}

function currentTime(): string {
  return NOW;
}

function insertSupplierFixture(database: NodeCommerceDatabase): void {
  database
    .prepare(
      `INSERT INTO custom_entity (
       merchant_id, entity_id, entity_type_id, entity_type_revision,
       revision, lifecycle_state, display_name, sensitivity, created_at, updated_at
     ) VALUES (?, 'supplier_packaging', 'trade_partner', 1, 1, 'active',
               'Packaging Supply Co.', 'internal', ?, ?)`,
    )
    .run(MERCHANT_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO custom_entity_attribute_value (
       merchant_id, entity_id, entity_revision, attribute_id, value_kind,
       short_text_value
     ) VALUES (?, 'supplier_packaging', 1, 'legal_name', 'short_text',
               'Packaging Supply Co.')`,
    )
    .run(MERCHANT_ID);
  database
    .prepare(
      `INSERT INTO commerce_list_entry (
       merchant_id, entry_id, list_id, list_revision, entity_origin,
       entity_type_id, entity_id, revision, lifecycle_state,
       created_at, updated_at, updated_at_ms, membership_kind
       ) VALUES (?, 'supplier_directory_packaging', 'supplier_directory', 1,
               'custom', 'trade_partner', 'supplier_packaging', 1, 'active', ?, ?, ?, 'unique_entity')`,
    )
    .run(MERCHANT_ID, NOW, NOW, Date.parse(NOW));
  database
    .prepare(
      `INSERT INTO commerce_list_entry_attribute_value (
       merchant_id, entry_id, entry_revision, attribute_id,
       definition_revision, value_kind, integer_value
     ) VALUES (?, 'supplier_directory_packaging', 1, 'lead_time_days',
               1, 'integer', 3)`,
    )
    .run(MERCHANT_ID);
  writeCommerceEntityRelationText(
    database,
    MERCHANT_ID,
    "custom",
    "trade_partner",
    "supplier_packaging",
    1,
    NOW,
    "Packaging Supply Co.",
  );
}

function insertLowStockFixture(database: NodeCommerceDatabase): void {
  database
    .prepare(
      `INSERT INTO location (
       merchant_id, resource_id, revision, name, kind, lifecycle_state,
       lifecycle_json, occurred_at
     ) VALUES (?, 'cafe', 1, 'Cafe', 'store', 'active', ?, ?)`,
    )
    .run(MERCHANT_ID, JSON.stringify({ state: "active", activeAt: NOW }), NOW);
  database
    .prepare(
      `INSERT INTO inventory_item (
       merchant_id, inventory_item_id, revision, merchant_code, name, base_unit,
       category, tracking_kind, expiry_policy, lifecycle, occurred_at
     ) VALUES (?, 'packaging_cups', 1, 'CUPS', 'Takeaway cups', 'each',
               'packaging', 'aggregate', NULL, 'active', ?)`,
    )
    .run(MERCHANT_ID, NOW);
  database
    .prepare(
      `INSERT INTO inventory_position (
       merchant_id, inventory_position_id, inventory_item_id, location_id,
       revision, balance_kind, on_hand_amount, allocated_amount, available_amount,
       quantity_scale, quantity_unit, observed_at
     ) VALUES (?, 'position_packaging_cups', 'packaging_cups', 'cafe',
               1, 'accounted', 5, 0, 5, 0, 'each', ?)`,
    )
    .run(MERCHANT_ID, NOW);
  database
    .prepare(
      `INSERT INTO food_service_resource (
       merchant_id, resource_kind, resource_id, revision, lifecycle_state, resource_json
     ) VALUES (?, 'stock_policy', 'stock_policy_packaging_cups', 1, 'active', ?)`,
    )
    .run(MERCHANT_ID, JSON.stringify(stockPolicyFixture()));
  database
    .prepare(
      `INSERT INTO commerce_relationship (
       merchant_id, relationship_id, relationship_definition_id,
       relationship_definition_revision, revision, lifecycle_state,
       source_origin, source_type_id, source_entity_id,
       target_origin, target_type_id, target_entity_id, created_at, updated_at
     ) VALUES (?, 'supplier_packaging_cups', 'supplier_inventory_item', 1, 1,
               'active', 'custom', 'trade_partner', 'supplier_packaging',
               'system', 'inventory_item', 'packaging_cups', ?, ?)`,
    )
    .run(MERCHANT_ID, NOW, NOW);
  writeCommerceEntityRelationText(
    database,
    MERCHANT_ID,
    "system",
    "inventory_item",
    "packaging_cups",
    1,
    NOW,
    "Takeaway cups",
  );
  writeCommerceEntityRelationText(
    database,
    MERCHANT_ID,
    "system",
    "stock_policy",
    "stock_policy_packaging_cups",
    1,
    NOW,
    "Takeaway cups stock policy",
  );
}

function stockPolicyFixture() {
  return {
    provenance: {
      organisationId: ORGANISATION_ID,
      integrationAccountId: "commerce",
      source: "commerce",
      resourceType: "stock_policy",
      resourceId: "stock_policy_packaging_cups",
      revision: 1,
      occurredAt: NOW,
      observedAt: NOW,
    },
    stockPolicyId: "stock_policy_packaging_cups",
    inventoryItemId: "packaging_cups",
    locationId: "cafe",
    revision: 1,
    replenishment: {
      kind: "threshold",
      reorderPoint: { amount: 10, scale: 0, unit: "each" },
      targetQuantity: { amount: 20, scale: 0, unit: "each" },
    },
    lifecycle: "active",
  };
}

function insertReceiptMovement(
  database: NodeCommerceDatabase,
  receiptId: string,
  lineId: string,
  quantity: number,
  positionRevision: number,
): void {
  database
    .prepare(
      `INSERT INTO stock_movement (
       merchant_id, movement_id, inventory_item_id, inventory_position_id,
       location_id, direction,
       quantity_amount, quantity_scale, quantity_unit, reason_kind,
       receipt_id, receipt_line_id, occurred_at, idempotency_key, reason_json
     ) VALUES (?, ?, 'packaging_cups', 'position_packaging_cups', 'cafe', 'increase', ?, 0, 'each',
               'receipt', ?, ?, ?, ?, ?)`,
    )
    .run(
      MERCHANT_ID,
      `movement_${receiptId}`,
      quantity,
      receiptId,
      lineId,
      NOW,
      `idempotency_${receiptId}`,
      JSON.stringify({
        kind: "receipt",
        receiptId,
        receiptLineId: lineId,
        purchase: {
          kind: "replenishment",
          entryId: queueEntryId(database),
          entryRevision: 1,
        },
      }),
    );
  database
    .prepare(
      `UPDATE inventory_position
        SET revision = ?, on_hand_amount = on_hand_amount + ?,
            available_amount = available_amount + ?, observed_at = ?
      WHERE merchant_id = ? AND inventory_position_id = 'position_packaging_cups'`,
    )
    .run(positionRevision, quantity, quantity, NOW, MERCHANT_ID);
}

function setExpectedDeliveryInPast(database: NodeCommerceDatabase): void {
  const entry = database
    .prepare(
      `SELECT entry_id AS entryId, revision
       FROM commerce_list_entry
      WHERE merchant_id = ? AND list_id = 'replenishment_queue'
      ORDER BY created_at DESC LIMIT 1`,
    )
    .get<Readonly<{ entryId: string; revision: number }>>(MERCHANT_ID);
  if (entry === undefined)
    throw new Error("Replenishment queue entry is missing");
  database
    .prepare(
      `UPDATE commerce_list_entry_attribute_value
        SET status_value = 'expected'
      WHERE merchant_id = ? AND entry_id = ? AND entry_revision = ? AND attribute_id = 'status'`,
    )
    .run(MERCHANT_ID, entry.entryId, entry.revision);
  database
    .prepare(
      `INSERT INTO commerce_list_entry_attribute_value (
       merchant_id, entry_id, entry_revision, attribute_id,
       definition_revision, value_kind, timestamp_value
     ) VALUES (?, ?, ?, 'expected_delivery_at', 1, 'timestamp', '2026-08-28T00:00:00.000Z')`,
    )
    .run(MERCHANT_ID, entry.entryId, entry.revision);
}

function queueEntryFacts(database: NodeCommerceDatabase) {
  const entry = database
    .prepare(
      `SELECT entry_id AS entryId, revision
       FROM commerce_list_entry
      WHERE merchant_id = ? AND list_id = 'replenishment_queue'
      ORDER BY created_at DESC LIMIT 1`,
    )
    .get<Readonly<{ entryId: string; revision: number }>>(MERCHANT_ID);
  if (entry === undefined)
    throw new Error("Replenishment queue entry is missing");
  const rows = database
    .prepare(
      `SELECT attribute_id AS attributeId, value_kind AS valueKind,
            short_text_value AS shortTextValue, decimal_value AS decimalValue,
            status_value AS statusValue, timestamp_value AS timestampValue
       FROM commerce_list_entry_attribute_value
      WHERE merchant_id = ? AND entry_id = ? AND entry_revision = ?`,
    )
    .all<
      Readonly<{
        attributeId: string;
        valueKind: string;
        shortTextValue: string | null;
        decimalValue: string | null;
        statusValue: string | null;
        timestampValue: string | null;
      }>
    >(MERCHANT_ID, entry.entryId, entry.revision);
  const values = new Map<string, (typeof rows)[number]>();
  for (const row of rows) values.set(row.attributeId, row);
  return {
    status: requiredValue(values, "status").statusValue,
    availableQuantity: decimalUnscaled(
      requiredValue(values, "available_quantity"),
    ),
    reorderPoint: decimalUnscaled(requiredValue(values, "reorder_point")),
    targetQuantity: decimalUnscaled(requiredValue(values, "target_quantity")),
    requiredQuantity: decimalUnscaled(
      requiredValue(values, "required_quantity"),
    ),
    receivedQuantity: decimalUnscaled(
      requiredValue(values, "received_quantity"),
    ),
    supplierId: requiredValue(values, "supplier_id").shortTextValue,
    owner: requiredValue(values, "owner").shortTextValue,
    closedAt: values.get("closed_at")?.timestampValue ?? null,
  };
}

function requiredValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (value === undefined)
    throw new Error(`Replenishment fixture is missing ${key}`);
  return value;
}

function decimalUnscaled(
  value: Readonly<{ decimalValue: string | null }>,
): number {
  if (value.decimalValue === null)
    throw new Error("Replenishment decimal fixture is missing");
  const parsed: unknown = JSON.parse(value.decimalValue);
  if (!isRecord(parsed) || !Number.isSafeInteger(parsed.unscaled)) {
    throw new Error("Replenishment decimal fixture is invalid");
  }
  return Number(parsed.unscaled);
}

function queueEntryId(database: NodeCommerceDatabase): string {
  const entry = database
    .prepare(
      "SELECT entry_id AS id FROM commerce_list_entry WHERE merchant_id = ? AND list_id = 'replenishment_queue'",
    )
    .get<{ id: string }>(MERCHANT_ID);
  if (entry === undefined) throw new Error("Purchase request fixture missing");
  return entry.id;
}
