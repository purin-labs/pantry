import type { CommerceCommandInput } from "@seams/commerce-client";
import {
  CommerceAdminClient,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type PlaceCommerceChannelListingV1,
  type ReceiveCommerceInventoryV3,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import { pathToFileURL } from "node:url";

const REQUESTED_AT = "2026-08-14T10:00:00.000Z";
const LOT_EXPIRES_AT = "2036-08-21T00:00:00.000Z";
const SALES_CHANNEL_ID = "channel_cookie_store_sg";
const SHIPPING_PROFILE_ID = "shipping_profile_jp_sg";
const LOCATION_ID = "location_tokyo_fulfillment";
const CARTON_INVENTORY_ITEM_ID = "inventory_shipping_carton";
const OPENING_STOCK_PER_FLAVOR = 10;

type SetupArguments = Readonly<{
  organisationId: string;
  merchantId: string;
  baseUrl: string;
  serviceToken: string;
}>;

type SetupIdentity = Pick<SetupArguments, "organisationId" | "merchantId">;

export type FlavorKey = "sesame" | "ginger" | "taro" | "matcha";

type FlavorDefinition = Readonly<{
  key: FlavorKey;
  title: string;
  description: string;
  priceMinor: number;
  weightGrams: number;
  customsDescription: string;
}>;

export const PLAN23_FLAVORS: readonly FlavorDefinition[] = [
  {
    key: "sesame",
    title: "Black sesame cookie box",
    description: "Six black sesame cookies shipped from Japan.",
    priceMinor: 3_600,
    weightGrams: 1_250,
    customsDescription: "Six black sesame cookies in one retail box",
  },
  {
    key: "ginger",
    title: "Ginger cookie box",
    description: "Six ginger cookies shipped from Japan.",
    priceMinor: 3_600,
    weightGrams: 1_220,
    customsDescription: "Six ginger cookies in one retail box",
  },
  {
    key: "taro",
    title: "Taro cookie box",
    description: "Six taro cookies shipped from Japan.",
    priceMinor: 3_800,
    weightGrams: 1_240,
    customsDescription: "Six taro cookies in one retail box",
  },
  {
    key: "matcha",
    title: "Matcha cookie box",
    description: "Six matcha cookies shipped from Japan.",
    priceMinor: 4_200,
    weightGrams: 1_210,
    customsDescription: "Six matcha cookies in one retail box",
  },
];

export type Plan23FlavoredCatalogSetupResult = Readonly<{
  ok: true;
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
  storefrontId: "storefront_cookie_store_sg";
  flavors: readonly FlavorKey[];
  availableBoxesPerFlavor: 10;
}>;

if (isMainModule()) await main();

export async function configurePlan23FlavoredCatalog(
  adminClient: CommerceAdminClient,
  identity: SetupIdentity,
): Promise<Plan23FlavoredCatalogSetupResult> {
  const initial = await adminClient.readSnapshot(identity.merchantId);
  if (!initial.ok) throw clientFailure("flavored catalog readback", initial);
  if (!shippingBaseIsPresent(initial.value.resources)) {
    throw new Error(
      "Plan 23 flavored catalog requires the accepted Plan 22 Phase 4 shipping state",
    );
  }
  if (flavoredCatalogIsComplete(initial.value.resources)) {
    return summary(identity, initial.value.merchantRevision);
  }

  let expectedRevision = initial.value.merchantRevision;
  for (const flavor of PLAN23_FLAVORS) {
    expectedRevision = await apply(
      adminClient.createInventoryItem(
        inventoryItem(identity, expectedRevision, flavor),
      ),
      `${flavor.key} box inventory item`,
      expectedRevision + 1,
    );
  }
  for (const flavor of PLAN23_FLAVORS) {
    expectedRevision = await apply(
      adminClient.placeChannelListing(
        channelListing(identity, expectedRevision, flavor),
      ),
      `${flavor.key} box channel listing`,
      expectedRevision + 1,
    );
  }
  for (const flavor of PLAN23_FLAVORS) {
    expectedRevision = await apply(
      adminClient.openInventoryPosition(
        inventoryPosition(identity, expectedRevision, flavor),
      ),
      `${flavor.key} box inventory position`,
      expectedRevision + 1,
    );
  }
  for (const flavor of PLAN23_FLAVORS) {
    expectedRevision = await apply(
      adminClient.receiveInventory(receipt(identity, expectedRevision, flavor)),
      `${flavor.key} box opening stock`,
      expectedRevision + 1,
    );
  }

  const configured = await adminClient.readSnapshot(identity.merchantId);
  if (!configured.ok)
    throw clientFailure("flavored catalog verification", configured);
  if (
    configured.value.merchantRevision !== expectedRevision ||
    !flavoredCatalogIsComplete(configured.value.resources) ||
    !PLAN23_FLAVORS.every((flavor) =>
      openingStockIsAvailable(configured.value.resources, flavor),
    )
  ) {
    throw new Error("Plan 23 flavored catalog verification failed");
  }
  return summary(identity, expectedRevision);
}

function summary(
  identity: SetupIdentity,
  merchantRevision: number,
): Plan23FlavoredCatalogSetupResult {
  return {
    ok: true,
    organisationId: identity.organisationId,
    merchantId: identity.merchantId,
    merchantRevision,
    storefrontId: "storefront_cookie_store_sg",
    flavors: PLAN23_FLAVORS.map((flavor) => flavor.key),
    availableBoxesPerFlavor: OPENING_STOCK_PER_FLAVOR,
  };
}

function inventoryItem(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  flavor: FlavorDefinition,
): CommerceCommandInput<CreateCommerceInventoryItemV1> {
  return {
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_flavored_export_v1:inventory_item:${flavor.key}`,
    inventoryItemId: `inventory_${flavor.key}_box_6`,
    merchantCode: `${flavor.key.toUpperCase()}-BOX-6`,
    name: flavor.title,
    baseUnit: "each",
    category: "finished_good",
    tracking: { kind: "lot_tracked", expiry: "required" },
  };
}

function channelListing(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  flavor: FlavorDefinition,
): CommerceCommandInput<PlaceCommerceChannelListingV1> {
  return {
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_flavored_export_v1:channel_listing:${flavor.key}`,
    salesChannelId: SALES_CHANNEL_ID,
    catalog: {
      kind: "new_product",
      product: {
        id: `product_${flavor.key}_box`,
        revision: 1,
        title: flavor.title,
        description: flavor.description,
        handle: null,
        productType: "",
        vendor: "",
        tags: [],
        status: "active",
        occurredAt: REQUESTED_AT,
      },
      variant: {
        id: `variant_${flavor.key}_box_6`,
        revision: 1,
        productId: `product_${flavor.key}_box`,
        sku: `${flavor.key.toUpperCase()}-BOX-6-SG`,
        title: "Box of six",
        options: [],
        media: [],
        barcode: null,
        status: "active",
        occurredAt: REQUESTED_AT,
      },
      consumptionPlan: {
        consumptionPlanId: `consumption_plan_${flavor.key}_box_sg`,
        variantId: `variant_${flavor.key}_box_6`,
        revision: 1,
        scope: { kind: "location", locationId: LOCATION_ID },
        mode: {
          kind: "direct",
          components: [
            {
              inventoryItemId: `inventory_${flavor.key}_box_6`,
              quantity: { amount: 1, scale: 0, unit: "each" },
            },
            {
              inventoryItemId: CARTON_INVENTORY_ITEM_ID,
              quantity: { amount: 1, scale: 0, unit: "each" },
            },
          ],
          commitOn: "fulfillment_completed",
        },
        lifecycle: "active",
      },
    },
    offer: {
      id: `offer_${flavor.key}_box_sg`,
      revision: 1,
      variantId: `variant_${flavor.key}_box_6`,
      salesChannelId: SALES_CHANNEL_ID,
      price: { amountMinor: flavor.priceMinor, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: REQUESTED_AT },
      occurredAt: REQUESTED_AT,
    },
    shippingSpecification: {
      variantId: `variant_${flavor.key}_box_6`,
      variantRevision: 1,
      shippingProfileId: SHIPPING_PROFILE_ID,
      shippingProfileRevision: 1,
      eligibility: {
        kind: "physical",
        weight: { grams: flavor.weightGrams },
        dimensions: {
          lengthMillimeters: 280,
          widthMillimeters: 220,
          heightMillimeters: 100,
        },
        countryOfOrigin: "JP",
        hsCode: "190531",
        description: flavor.customsDescription,
      },
    },
  };
}

function inventoryPosition(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  flavor: FlavorDefinition,
): CommerceCommandInput<OpenCommerceInventoryPositionV1> {
  return {
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_flavored_export_v1:inventory_position:${flavor.key}`,
    inventoryPositionId: `position_${flavor.key}_box_tokyo`,
    inventoryItemId: `inventory_${flavor.key}_box_6`,
    inventoryItemRevision: 1,
    locationId: LOCATION_ID,
    locationRevision: 1,
  };
}

function receipt(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  flavor: FlavorDefinition,
): CommerceCommandInput<ReceiveCommerceInventoryV3> {
  return {
    purchase: { kind: "unlinked" },
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_flavored_export_v1:opening_stock:${flavor.key}`,
    receiptId: "receipt_flavored_opening_stock",
    receiptLineId: `receipt_line_${flavor.key}_box`,
    inventoryItemId: `inventory_${flavor.key}_box_6`,
    inventoryItemRevision: 1,
    inventoryPositionId: `position_${flavor.key}_box_tokyo`,
    inventoryPositionRevision: 1,
    locationId: LOCATION_ID,
    receivedQuantity: {
      amount: OPENING_STOCK_PER_FLAVOR,
      scale: 0,
      unit: "each",
    },
    lot: {
      kind: "tracked",
      lotId: `lot_${flavor.key}_box_tokyo`,
      lotCode: `${flavor.key.toUpperCase()}-BOX-20260814-A`,
      expiry: { kind: "expires", expiresAt: LOT_EXPIRES_AT },
    },
    receivedAt: REQUESTED_AT,
  };
}

type SnapshotResources = Readonly<{
  inventoryItems: readonly Readonly<{ id: string }>[];
  inventoryPositions: readonly Readonly<{
    inventoryItemId: string;
    locationId: string;
    balance: Readonly<{
      kind: string;
      available?: Readonly<{ amount: number; scale: number; unit: string }>;
    }>;
  }>[];
  locations: readonly Readonly<{ id: string }>[];
  offers: readonly Readonly<{ id: string }>[];
  variants: readonly Readonly<{ id: string }>[];
}>;

function shippingBaseIsPresent(resources: SnapshotResources): boolean {
  return (
    resources.locations.some((location) => location.id === LOCATION_ID) &&
    resources.inventoryItems.some(
      (item) => item.id === CARTON_INVENTORY_ITEM_ID,
    ) &&
    resources.variants.some((variant) => variant.id === "variant_cookie_box_6")
  );
}

function flavoredCatalogIsComplete(resources: SnapshotResources): boolean {
  return PLAN23_FLAVORS.every(
    (flavor) =>
      resources.inventoryItems.some(
        (item) => item.id === `inventory_${flavor.key}_box_6`,
      ) &&
      resources.variants.some(
        (variant) => variant.id === `variant_${flavor.key}_box_6`,
      ) &&
      resources.offers.some(
        (offer) => offer.id === `offer_${flavor.key}_box_sg`,
      ) &&
      resources.inventoryPositions.some(
        (position) =>
          position.inventoryItemId === `inventory_${flavor.key}_box_6` &&
          position.locationId === LOCATION_ID,
      ),
  );
}

function openingStockIsAvailable(
  resources: SnapshotResources,
  flavor: FlavorDefinition,
): boolean {
  return resources.inventoryPositions.some(
    (position) =>
      position.inventoryItemId === `inventory_${flavor.key}_box_6` &&
      position.locationId === LOCATION_ID &&
      position.balance.kind === "accounted" &&
      position.balance.available?.amount === OPENING_STOCK_PER_FLAVOR &&
      position.balance.available.scale === 0 &&
      position.balance.available.unit === "each",
  );
}

async function apply(
  pending: Promise<
    Readonly<
      | { ok: true; value: CommerceMutationResultV1 }
      | { ok: false; error: Readonly<{ kind: string; message: string }> }
    >
  >,
  operation: string,
  expectedRevision: number,
): Promise<number> {
  const result = await pending;
  if (!result.ok) throw clientFailure(operation, result);
  if (result.value.outcome === "rejected") {
    throw new Error(
      `${operation} was rejected: ${JSON.stringify(result.value.error)}`,
    );
  }
  if (result.value.receipt.merchantRevision !== expectedRevision) {
    throw new Error(`${operation} produced an unexpected merchant revision`);
  }
  return expectedRevision;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2), process.env);
  const client = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const result = await configurePlan23FlavoredCatalog(client, {
    organisationId: arguments_.organisationId,
    merchantId: arguments_.merchantId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
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
): SetupArguments {
  const values = new Map<string, string>();
  const start = argv[0] === "--" ? 1 : 0;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "Usage: configure:plan23-flavored-catalog --organisation <organisation_id> --merchant <merchant_id>",
      );
    }
    values.set(flag, value);
  }
  return {
    organisationId: requireIdentity(values.get("--organisation"), "--organisation", "organisation_"),
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
