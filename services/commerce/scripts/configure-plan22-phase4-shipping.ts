import type { CommerceCommandInput } from "@purin-labs/commerce-client";
import {
  CommerceAdminClient,
  type ConfigureCommerceShippingStorefrontV1,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type ReceiveCommerceInventoryV3,
} from "@purin-labs/commerce-client";
import {
  applyAtRevision,
  clientFailure,
  isMainModule,
  parseMerchantScriptArguments,
  type MerchantScriptArguments,
} from "./merchant-script.ts";

const REQUESTED_AT = "2026-08-14T09:45:00.000Z";
const EXPECTED_CAFE_REVISION = 93;
const EXPECTED_SHIPPING_REVISION = 100;

type SetupIdentity = Pick<
  MerchantScriptArguments,
  "organisationId" | "merchantId"
>;

export type Plan22Phase4ShippingSetupResult = Readonly<{
  ok: true;
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
  storefrontId: "storefront_cookie_store_sg";
  originCountry: "JP";
  destinationCountry: "SG";
  availableBoxes: 10;
  availableCartons: 10;
}>;

if (isMainModule(import.meta.url)) await main();

export async function configurePhase4Shipping(
  adminClient: CommerceAdminClient,
  identity: SetupIdentity,
): Promise<Plan22Phase4ShippingSetupResult> {
  const initial = await adminClient.readSnapshot(identity.merchantId);
  if (!initial.ok) throw clientFailure("shipping setup readback", initial);
  const cafeRevision =
    initial.value.merchantRevision === 95 ||
    initial.value.merchantRevision === 102
      ? 95
      : EXPECTED_CAFE_REVISION;
  const shippingRevision =
    cafeRevision === EXPECTED_CAFE_REVISION
      ? EXPECTED_SHIPPING_REVISION
      : cafeRevision + 7;
  if (
    (initial.value.merchantRevision < EXPECTED_CAFE_REVISION ||
      initial.value.merchantRevision > shippingRevision) &&
    !shippingSetupIsComplete(initial.value, shippingRevision)
  ) {
    throw new Error(
      "Plan 22 Phase 4 shipping setup requires the canonical Phase 3 cafe state",
    );
  }

  let expectedRevision = cafeRevision;
  expectedRevision = await applyAtRevision(
    adminClient.createInventoryItem(
      inventoryItem(identity, expectedRevision, "cookie_box"),
    ),
    "six-cookie inventory item",
    expectedRevision + 1,
  );
  expectedRevision = await applyAtRevision(
    adminClient.createInventoryItem(
      inventoryItem(identity, expectedRevision, "carton"),
    ),
    "shipping carton inventory item",
    expectedRevision + 1,
  );
  expectedRevision = await applyAtRevision(
    adminClient.configureShippingStorefront(
      shippingStorefront(identity, expectedRevision),
    ),
    "JP to Singapore storefront",
    expectedRevision + 1,
  );
  expectedRevision = await applyAtRevision(
    adminClient.openInventoryPosition(
      inventoryPosition(identity, expectedRevision, "cookie_box"),
    ),
    "six-cookie inventory position",
    expectedRevision + 1,
  );
  expectedRevision = await applyAtRevision(
    adminClient.openInventoryPosition(
      inventoryPosition(identity, expectedRevision, "carton"),
    ),
    "shipping carton inventory position",
    expectedRevision + 1,
  );
  expectedRevision = await applyAtRevision(
    adminClient.receiveInventory(
      receipt(identity, expectedRevision, "cookie_box"),
    ),
    "six-cookie opening stock",
    expectedRevision + 1,
  );
  expectedRevision = await applyAtRevision(
    adminClient.receiveInventory(receipt(identity, expectedRevision, "carton")),
    "shipping carton opening stock",
    expectedRevision + 1,
  );

  const configured = await adminClient.readSnapshot(identity.merchantId);
  if (!configured.ok)
    throw clientFailure("shipping setup verification", configured);
  if (
    expectedRevision !== shippingRevision ||
    !shippingSetupIsComplete(configured.value, shippingRevision)
  ) {
    throw new Error("Plan 22 Phase 4 shipping setup verification failed");
  }
  return {
    ok: true,
    organisationId: identity.organisationId,
    merchantId: identity.merchantId,
    merchantRevision: shippingRevision,
    storefrontId: "storefront_cookie_store_sg",
    originCountry: "JP",
    destinationCountry: "SG",
    availableBoxes: 10,
    availableCartons: 10,
  };
}

function inventoryItem(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  kind: "cookie_box" | "carton",
): CommerceCommandInput<CreateCommerceInventoryItemV1> {
  const cookieBox = kind === "cookie_box";
  return {
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_online_cookie_store_v1:inventory_item:${kind}`,
    inventoryItemId: cookieBox
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton",
    merchantCode: cookieBox ? "COOKIE-BOX-6" : "SHIP-CARTON",
    name: cookieBox ? "Six-cookie box" : "Shipping carton",
    baseUnit: "each",
    category: cookieBox ? "finished_good" : "packaging",
    tracking: cookieBox
      ? { kind: "lot_tracked", expiry: "required" }
      : { kind: "aggregate" },
  };
}

function shippingStorefront(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
): CommerceCommandInput<ConfigureCommerceShippingStorefrontV1> {
  return {
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: "scenario_online_cookie_store_v1:shipping_storefront",
    location: {
      id: "location_tokyo_fulfillment",
      revision: 1,
      name: "Tokyo fulfillment",
      kind: "fulfillment_center",
      lifecycle: { state: "active", activeAt: REQUESTED_AT },
      occurredAt: REQUESTED_AT,
    },
    salesChannel: {
      id: "channel_cookie_store_sg",
      revision: 1,
      name: "Singapore cookie store",
      kind: "online",
      lifecycle: { state: "active", activeAt: REQUESTED_AT },
      occurredAt: REQUESTED_AT,
    },
    product: {
      id: "product_cookie_box",
      revision: 1,
      title: "Six-cookie box",
      description: "Six assorted cookies shipped from Japan.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: REQUESTED_AT,
    },
    variant: {
      id: "variant_cookie_box_6",
      revision: 1,
      productId: "product_cookie_box",
      sku: "COOKIE-BOX-6-SG",
      title: "Box of six",
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: REQUESTED_AT,
    },
    offer: {
      id: "offer_cookie_box_sg",
      revision: 1,
      variantId: "variant_cookie_box_6",
      salesChannelId: "channel_cookie_store_sg",
      price: { amountMinor: 3_600, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "listed", listedAt: REQUESTED_AT },
      occurredAt: REQUESTED_AT,
    },
    storefront: {
      storefrontId: "storefront_cookie_store_sg",
      revision: 1,
      name: "Japan cookie store for Singapore",
      salesChannelId: "channel_cookie_store_sg",
      fulfillment: {
        kind: "shipping",
        originLocationId: "location_tokyo_fulfillment",
        shippingProfileId: "shipping_profile_jp_sg",
      },
      checkout: {
        quoteTtlSeconds: 900,
        tax: {
          kind: "provider_quoted",
          providerAccountReference: "tax_account_sg_test",
        },
      },
      lifecycle: { state: "active", activeAt: REQUESTED_AT },
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan_cookie_box_sg",
      variantId: "variant_cookie_box_6",
      revision: 1,
      scope: { kind: "location", locationId: "location_tokyo_fulfillment" },
      mode: {
        kind: "direct",
        components: [
          {
            inventoryItemId: "inventory_cookie_box_6",
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
          {
            inventoryItemId: "inventory_shipping_carton",
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
        ],
        commitOn: "fulfillment_completed",
      },
      lifecycle: "active",
    },
    shippingProfile: {
      shippingProfileId: "shipping_profile_jp_sg",
      revision: 1,
      name: "Japan to Singapore",
      originLocationId: "location_tokyo_fulfillment",
      routes: [
        {
          kind: "japan_to_singapore",
          routeId: "route_jp_sg_ems",
          zoneId: "zone_singapore",
          carrierRateCapabilityId: "carrier_rate_japan_post_ems_test",
          serviceCodes: ["ems_test", "international_parcel_air_test"],
          dutyCapabilityId: "duty_singapore_test",
          incoterm: "ddp",
        },
      ],
      lifecycle: { state: "active", activeAt: REQUESTED_AT },
    },
    shippingSpecification: {
      variantId: "variant_cookie_box_6",
      variantRevision: 1,
      shippingProfileId: "shipping_profile_jp_sg",
      shippingProfileRevision: 1,
      eligibility: {
        kind: "physical",
        weight: { grams: 1_200 },
        dimensions: {
          lengthMillimeters: 280,
          widthMillimeters: 220,
          heightMillimeters: 100,
        },
        countryOfOrigin: "JP",
        hsCode: "190531",
        description: "Six baked cookies in one retail box",
      },
    },
  };
}

function inventoryPosition(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  kind: "cookie_box" | "carton",
): CommerceCommandInput<OpenCommerceInventoryPositionV1> {
  const cookieBox = kind === "cookie_box";
  return {
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_online_cookie_store_v1:inventory_position:${kind}`,
    inventoryPositionId: cookieBox
      ? "position_cookie_box_tokyo"
      : "position_carton_tokyo",
    inventoryItemId: cookieBox
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton",
    inventoryItemRevision: 1,
    locationId: "location_tokyo_fulfillment",
    locationRevision: 1,
  };
}

function receipt(
  identity: SetupIdentity,
  expectedMerchantRevision: number,
  kind: "cookie_box" | "carton",
): CommerceCommandInput<ReceiveCommerceInventoryV3> {
  const cookieBox = kind === "cookie_box";
  return {
    purchase: { kind: "unlinked" },
    merchantId: identity.merchantId,
    expectedMerchantRevision,
    idempotencyKey: `scenario_online_cookie_store_v1:opening_stock:${kind}`,
    receiptId: "receipt_shipping_opening_stock",
    receiptLineId: cookieBox
      ? "receipt_line_cookie_box"
      : "receipt_line_carton",
    inventoryItemId: cookieBox
      ? "inventory_cookie_box_6"
      : "inventory_shipping_carton",
    inventoryItemRevision: 1,
    inventoryPositionId: cookieBox
      ? "position_cookie_box_tokyo"
      : "position_carton_tokyo",
    inventoryPositionRevision: 1,
    locationId: "location_tokyo_fulfillment",
    receivedQuantity: { amount: 10, scale: 0, unit: "each" },
    lot: cookieBox
      ? {
          kind: "tracked",
          lotId: "lot_cookie_box_tokyo",
          lotCode: "COOKIE-BOX-20260814-A",
          expiry: { kind: "expires", expiresAt: "2036-08-21T00:00:00.000Z" },
        }
      : { kind: "not_tracked" },
    receivedAt: REQUESTED_AT,
  };
}

function shippingSetupIsComplete(
  snapshot: Readonly<{
    merchantRevision: number;
    resources: Readonly<{
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
  }>,
  expectedRevision: number,
): boolean {
  const positionIsAvailable = (inventoryItemId: string): boolean =>
    snapshot.resources.inventoryPositions.some(
      (position) =>
        position.inventoryItemId === inventoryItemId &&
        position.locationId === "location_tokyo_fulfillment" &&
        position.balance.kind === "accounted" &&
        position.balance.available?.amount === 10 &&
        position.balance.available.scale === 0 &&
        position.balance.available.unit === "each",
    );
  return (
    snapshot.merchantRevision === expectedRevision &&
    snapshot.resources.locations.some(
      (location) => location.id === "location_tokyo_fulfillment",
    ) &&
    snapshot.resources.inventoryItems.some(
      (item) => item.id === "inventory_cookie_box_6",
    ) &&
    snapshot.resources.inventoryItems.some(
      (item) => item.id === "inventory_shipping_carton",
    ) &&
    snapshot.resources.variants.some(
      (variant) => variant.id === "variant_cookie_box_6",
    ) &&
    snapshot.resources.offers.some(
      (offer) => offer.id === "offer_cookie_box_sg",
    ) &&
    positionIsAvailable("inventory_cookie_box_6") &&
    positionIsAvailable("inventory_shipping_carton")
  );
}

async function main(): Promise<void> {
  const arguments_ = parseMerchantScriptArguments(
    "configure:plan22-phase4-shipping",
    process.argv.slice(2),
    process.env,
  );
  const client = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const result = await configurePhase4Shipping(client, arguments_);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
