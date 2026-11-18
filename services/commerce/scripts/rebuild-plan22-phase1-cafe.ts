import {
  CommerceAdminClient,
  type CommerceClientResult,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import { pathToFileURL } from "node:url";

const OCCURRED_AT = "2026-08-14T09:30:00.000Z";

type RebuildArguments = Readonly<{
  organisationId: string;
  merchantId: string;
  baseUrl: string;
  serviceToken: string;
}>;

type RebuildIdentity = Pick<RebuildArguments, "organisationId" | "merchantId">;
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

if (isMainModule()) await main();

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
  const arguments_ = parseArguments(process.argv.slice(2), process.env);
  const adminClient = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const result = await rebuildPhase1Cafe(adminClient, arguments_);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
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

function clientFailure(
  operation: string,
  result: Readonly<{
    ok: false;
    error: Readonly<{ kind: string; message: string }>;
  }>,
): Error {
  return new Error(
    `${operation} failed: ${result.error.kind}: ${result.error.message}`,
  );
}

function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): RebuildArguments {
  const values = new Map<string, string>();
  const start = argv[0] === "--" ? 1 : 0;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "Usage: rebuild:plan22-phase1-cafe --organisation <organisation_id> --merchant <merchant_id>",
      );
    }
    values.set(flag, value);
  }
  return {
    organisationId: requireIdentity(
      values.get("--organisation"),
      "--organisation",
      "organisation_",
    ),
    merchantId: requireIdentity(
      values.get("--merchant"),
      "--merchant",
      "merchant_",
    ),
    baseUrl: requireUrl(env.UNDERCLERK_BASE_URL),
    serviceToken: requireSecret(env.UNDERCLERK_SERVICE_TOKEN),
  };
}

function requireIdentity(
  value: string | undefined,
  field: string,
  prefix: string,
): string {
  if (
    value === undefined ||
    !value.startsWith(prefix) ||
    value !== value.trim()
  ) {
    throw new Error(`${field} must be a normalized ${prefix} identity`);
  }
  return value;
}

function requireUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("UNDERCLERK_BASE_URL is required");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("UNDERCLERK_BASE_URL must use http or https");
  }
  return parsed.toString();
}

function requireSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("UNDERCLERK_SERVICE_TOKEN is required");
  }
  return value;
}
