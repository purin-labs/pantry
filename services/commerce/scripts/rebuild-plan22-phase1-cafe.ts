import {
  CommerceAdminClient,
  type CommerceClientResult,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import {
  clientFailure,
  isMainModule,
  parseMerchantScriptArguments,
  type MerchantScriptArguments,
} from "./merchant-script.ts";

const OCCURRED_AT = "2026-08-14T09:30:00.000Z";

type RebuildIdentity = Pick<
  MerchantScriptArguments,
  "organisationId" | "merchantId"
>;
export type Plan22Phase1CafeRebuildResult = Readonly<{
  ok: true;
  organisationId: string;
  merchantId: string;
  storageSchemaVersion: number;
  merchantRevision: number;
  inventoryItems: number;
  inventoryPositions: number;
  movements: number;
  lots: number;
  receiptIdentities: number;
  pendingDeliveries: number;
}>;

if (isMainModule(import.meta.url)) await main();

export async function rebuildPhase1Cafe(
  adminClient: CommerceAdminClient,
  identities: RebuildIdentity,
): Promise<Plan22Phase1CafeRebuildResult> {
  const provisioned = await adminClient.provisionMerchant({
    schemaVersion: "underclerk.provision-merchant.v2",
    externalReference: identities.organisationId,
    merchantId: identities.merchantId,
    createdAt: OCCURRED_AT,
  });
  if (!provisioned.ok)
    throw clientFailure("merchant provisioning", provisioned);

  await requireApplied(
    "cafe location",
    adminClient.createLocation({
      merchantId: identities.merchantId,
      expectedMerchantRevision: 0,
      idempotencyKey: "scenario_cafe_patisserie_v2:open_store:1",
      location: {
        id: "location_cafe",
        revision: 1,
        name: "Cafe / Patisserie",
        kind: "store",
        lifecycle: { state: "active", activeAt: OCCURRED_AT },
        occurredAt: OCCURRED_AT,
      },
    }),
  );
  await requireApplied(
    "cookie inventory item",
    adminClient.createInventoryItem({
      merchantId: identities.merchantId,
      expectedMerchantRevision: 1,
      idempotencyKey: "scenario_cafe_patisserie_v2:create_cookie_item:1",
      inventoryItemId: "inventory_cookie",
      merchantCode: "COOKIE",
      name: "Cookie",
      baseUnit: "each",
      category: "finished_good",
      tracking: { kind: "lot_tracked", expiry: "required" },
    }),
  );
  await requireApplied(
    "cookie inventory position",
    adminClient.openInventoryPosition({
      merchantId: identities.merchantId,
      expectedMerchantRevision: 2,
      idempotencyKey: "scenario_cafe_patisserie_v2:open_cookie_position:1",
      inventoryPositionId: "position_cookie_cafe",
      inventoryItemId: "inventory_cookie",
      inventoryItemRevision: 1,
      locationId: "location_cafe",
      locationRevision: 1,
    }),
  );
  await requireApplied(
    "oat-milk inventory item",
    adminClient.createInventoryItem({
      merchantId: identities.merchantId,
      expectedMerchantRevision: 3,
      idempotencyKey: "scenario_cafe_patisserie_v2:create_oat_milk_item:1",
      inventoryItemId: "inventory_oat_milk",
      merchantCode: "OAT-MILK",
      name: "Oat milk",
      baseUnit: "milliliter",
      category: "ingredient",
      tracking: { kind: "lot_tracked", expiry: "required" },
    }),
  );
  await requireApplied(
    "oat-milk inventory position",
    adminClient.openInventoryPosition({
      merchantId: identities.merchantId,
      expectedMerchantRevision: 4,
      idempotencyKey: "scenario_cafe_patisserie_v2:open_oat_milk_position:1",
      inventoryPositionId: "position_oat_milk_cafe",
      inventoryItemId: "inventory_oat_milk",
      inventoryItemRevision: 1,
      locationId: "location_cafe",
      locationRevision: 1,
    }),
  );
  await requireApplied(
    "oat-milk receipt",
    adminClient.receiveInventory({
      purchase: { kind: "unlinked" },
      merchantId: identities.merchantId,
      expectedMerchantRevision: 5,
      idempotencyKey: "scenario_cafe_patisserie_v2:receive_oat_milk:1",
      receiptId: "receipt_oat_milk",
      receiptLineId: "receipt_line_oat_milk_accepted",
      inventoryItemId: "inventory_oat_milk",
      inventoryItemRevision: 1,
      inventoryPositionId: "position_oat_milk_cafe",
      inventoryPositionRevision: 1,
      locationId: "location_cafe",
      receivedQuantity: { amount: 8_000, scale: 0, unit: "milliliter" },
      lot: {
        kind: "tracked",
        lotId: "lot_receipt_line_oat_milk_accepted",
        lotCode: "OAT-20260814-A",
        expiry: { kind: "expires", expiresAt: "2036-08-21T00:00:00.000Z" },
      },
      receivedAt: OCCURRED_AT,
    }),
  );

  const inventory = await adminClient.readMigrationInventory(
    identities.merchantId,
  );
  if (!inventory.ok)
    throw clientFailure("migration inventory readback", inventory);
  if (
    inventory.value.storageSchemaVersion !== 80 ||
    inventory.value.merchantRevision !== 6 ||
    inventory.value.resources.inventoryItems !== 2 ||
    inventory.value.resources.inventoryPositions !== 2 ||
    inventory.value.inventoryLedger.movements !== 1 ||
    inventory.value.inventoryLedger.lots !== 1 ||
    inventory.value.inventoryLedger.receiptIdentities !== 1
  ) {
    throw new Error(
      "Plan 22 Phase 1 cafe readback did not match the frozen scenario",
    );
  }
  return {
    ok: true,
    organisationId: inventory.value.organisationId,
    merchantId: inventory.value.merchantId,
    storageSchemaVersion: inventory.value.storageSchemaVersion,
    merchantRevision: inventory.value.merchantRevision,
    inventoryItems: inventory.value.resources.inventoryItems,
    inventoryPositions: inventory.value.resources.inventoryPositions,
    movements: inventory.value.inventoryLedger.movements,
    lots: inventory.value.inventoryLedger.lots,
    receiptIdentities: inventory.value.inventoryLedger.receiptIdentities,
    pendingDeliveries: inventory.value.operations.pendingCommerceDeliveries,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseMerchantScriptArguments(
    "rebuild:plan22-phase1-cafe",
    process.argv.slice(2),
    process.env,
  );
  const adminClient = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const result = await rebuildPhase1Cafe(adminClient, arguments_);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function requireApplied(
  operation: string,
  pending: Promise<CommerceClientResult<CommerceMutationResultV1>>,
): Promise<void> {
  const result = await pending;
  if (!result.ok) throw clientFailure(operation, result);
  if (result.value.outcome === "rejected") {
    throw new Error(`${operation} rejected: ${result.value.error.code}`);
  }
}
