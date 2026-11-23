import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseListEntryReadRequest,
} from "@purin-labs/commerce-client";

import {
  createSupplier,
  parseSupplierCreation,
} from "@purin-labs/area-kitchen/server/purchasing/supplier-creation";
import {
  startCommerceWorker,
  type CommerceWorker,
} from "./commerce-fixture-worker";

const NOW = "2026-08-29T00:00:00.000Z";
const AUTHORITY_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const ORGANISATION_ID = "organisation_supplier_creation";
const MERCHANT_ID = "merchant_supplier_creation";

let commerceEngine: CommerceWorker;

beforeAll(async () => {
  commerceEngine = await startCommerceWorker({ now: NOW });
}, 30_000);

afterAll(async () => {
  await commerceEngine.dispose();
});

it("creates one supplier, directory entry, and supplied-item relationship through ordinary commands", async () => {
  const fixture = await createFixture();
  const published = await fixture.client.publishPurchasingPreset({
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
  });
  expect(published.ok).toBe(true);
  await createInventoryItem(fixture.admin);
  const supplier = parseSupplierCreation(supplierInput());
  if (!supplier.ok) throw new Error("Supplier fixture is invalid");

  const first = await createSupplier({
    client: fixture.client,
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    principalId: "app_user_supplier_operator",
    idempotencyKey: "supplier-create-idempotency-0001",
    expiresAt: AUTHORITY_EXPIRES_AT,
    supplier: supplier.value,
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  expect(first).toMatchObject({
    ok: true,
    value: {
      supplierId: "packaging_supply",
      entryId: "supplier:packaging_supply",
      receipts: [
        { outcome: "applied" },
        { outcome: "applied" },
        { outcome: "applied" },
      ],
    },
  });
  const replay = await createSupplier({
    client: fixture.client,
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    principalId: "app_user_supplier_operator",
    idempotencyKey: "supplier-create-idempotency-0001",
    expiresAt: AUTHORITY_EXPIRES_AT,
    supplier: supplier.value,
  });
  expect(replay).toMatchObject({
    ok: true,
    value: {
      supplierId: "packaging_supply",
      entryId: "supplier:packaging_supply",
      merchantRevision: first.value.merchantRevision,
      receipts: [
        { outcome: "already_applied" },
        { outcome: "already_applied" },
        { outcome: "already_applied" },
      ],
    },
  });
  const supplierEntity = await fixture.client.query(
    MERCHANT_ID,
    parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "packaging_supply",
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    }),
  );
  expect(supplierEntity).toMatchObject({
    ok: true,
    value: { entities: [{ displayName: "Packaging Supply Co." }] },
  });
  const changes = await fixture.client.changes(
    MERCHANT_ID,
    parseCommerceSnapshotRevision(0),
  );
  if (!changes.ok) throw new Error(JSON.stringify(changes.error));
  expect(changes.value.changes).toContainEqual(
    expect.objectContaining({
      operation: "created",
      resource: {
        kind: "custom_relationship",
        ref: expect.objectContaining({
          relationshipId: "supplier_item:packaging_supply:cups_12oz",
          definition: expect.objectContaining({
            definitionId: "supplier_inventory_item",
          }),
        }),
      },
    }),
  );
  const directoryEntry = await fixture.client.readListEntry(
    parseListEntryReadRequest({
      merchantId: MERCHANT_ID,
      listId: "supplier_directory",
      entryId: "supplier:packaging_supply",
    }),
  );
  expect(directoryEntry).toMatchObject({
    ok: true,
    value: { kind: "found", entry: { listId: "supplier_directory" } },
  });
}, 30_000);

it("rejects incomplete minimum-order and empty supplied-item input", () => {
  expect(
    parseSupplierCreation({ ...supplierInput(), minimumOrderUnit: null }).ok,
  ).toBe(false);
  expect(
    parseSupplierCreation({ ...supplierInput(), inventoryItemIds: [] }).ok,
  ).toBe(false);
  expect(
    parseSupplierCreation({ ...supplierInput(), email: "invalid" }).ok,
  ).toBe(false);
});

function supplierInput(): Readonly<Record<string, unknown>> {
  return {
    supplierId: "packaging_supply",
    displayName: "Packaging Supply Co.",
    legalName: "Packaging Supply Company Limited",
    countryCode: "JP",
    contactName: "Aiko Mori",
    email: "orders@packaging.example",
    phone: "+81-3-5555-0100",
    leadTimeDays: 3,
    minimumOrderQuantity: "10.000",
    minimumOrderUnit: "case",
    purchasingNotes: "Order before Tuesday cutoff.",
    inventoryItemIds: ["cups_12oz"],
  };
}

async function createFixture(): Promise<
  Readonly<{
    admin: CommerceAdminClient;
    client: CommerceEntityPlaneClient;
  }>
> {
  const config = {
    baseUrl: commerceEngine.baseUrl,
    serviceToken: commerceEngine.serviceToken,
    fetch: commerceEngine.fetch,
  };
  const admin = new CommerceAdminClient(config);
  const provisioned = await admin.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    createdAt: NOW,
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  return { admin, client: new CommerceEntityPlaneClient(config) };
}

async function createInventoryItem(admin: CommerceAdminClient): Promise<void> {
  const snapshot = await admin.readSnapshot(MERCHANT_ID);
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.error));
  const created = await admin.createInventoryItem({
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: "inventory-item-cups-12oz",
    inventoryItemId: "cups_12oz",
    merchantCode: "CUPS-12",
    name: "12 oz cups",
    baseUnit: "each",
    category: "packaging",
    tracking: { kind: "aggregate" },
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
}
