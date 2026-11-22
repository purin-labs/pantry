import type {
  CommerceResourcesV1,
  CommerceInventoryItemV1,
  CommerceOfferV1,
  CommerceProductV1,
  CommerceVariantV1,
} from "@purin-labs/commerce-client";

const PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP = "2026-08-11T09:00:00Z";

type StorefrontDemoItem = Readonly<{
  slug: string;
  sku: string;
  title: string;
  description: string;
  priceMinor: number;
  available: number;
}>;

const STOREFRONT_DEMO_MANIFEST = {
  schemaVersion: "pantry.storefront-demo-manifest.v1",
  profiles: {
    cafe_patisserie: {
      authority: "builtin_commerce",
      scenario: "prepared_item_pickup",
    },
    pantry_ecommerce: {
      authority: "builtin_commerce",
      scenario: "japan_to_singapore_cookie_delivery",
    },
  },
  ecommerceCatalog: [
    {
      slug: "six_cookie_box",
      sku: "COOKIE-BOX-6",
      title: "Six-cookie box",
      description:
        "Six cafe cookies packed for the Japan-to-Singapore storefront scenario.",
      priceMinor: 3200,
      available: 8,
    },
  ] satisfies readonly StorefrontDemoItem[],
} as const;

const PANTRY_ECOMMERCE_ITEMS: readonly StorefrontDemoItem[] =
  STOREFRONT_DEMO_MANIFEST.ecommerceCatalog;

export function ecommerceDemoFixtureIdempotencyKey(): string {
  return "commerce_demo_pantry_ecommerce_v1";
}

export function buildEcommerceDemoResources(): CommerceResourcesV1 {
  return buildPantryEcommerceResources();
}

export function hasEcommerceDemoFixture(
  resources: CommerceResourcesV1,
): boolean {
  return hasPantryEcommerceFixture(resources);
}

export function hasCommerceResources(
  resources: CommerceResourcesV1,
): boolean {
  return (
    resources.locations.length > 0 ||
    resources.salesChannels.length > 0 ||
    resources.products.length > 0 ||
    resources.variants.length > 0 ||
    resources.inventoryItems.length > 0 ||
    resources.offers.length > 0 ||
    resources.inventoryPositions.length > 0 ||
    resources.orders.length > 0 ||
    resources.payments.length > 0 ||
    resources.fulfillments.length > 0 ||
    resources.shipments.length > 0
  );
}

function buildPantryEcommerceResources(): CommerceResourcesV1 {
  const products: CommerceProductV1[] = [];
  const variants: CommerceVariantV1[] = [];
  const inventoryItems: CommerceInventoryItemV1[] = [];
  const offers: CommerceOfferV1[] = [];
  const inventoryPositions: CommerceResourcesV1["inventoryPositions"][number][] =
    [];
  for (const item of PANTRY_ECOMMERCE_ITEMS) {
    const productId = productIdFor(item);
    const variantId = variantIdFor(item);
    const inventoryItemId = inventoryItemIdFor(item);
    products.push({
      id: productId,
      revision: 1,
      title: item.title,
      description: item.description,
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
    });
    variants.push({
      id: variantId,
      revision: 1,
      productId,
      sku: item.sku,
      title: "Standard",
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
    });
    inventoryItems.push({
      id: inventoryItemId,
      revision: 1,
      merchantCode: item.sku,
      name: item.title,
      baseUnit: "each",
      category: "finished_good",
      tracking: { kind: "aggregate" },
      lifecycle: "active",
      occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
    });
    offers.push({
      id: offerIdFor(item),
      revision: 1,
      variantId,
      salesChannelId: "channel_pantry_ecommerce_online",
      price: { amountMinor: item.priceMinor, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: {
        state: "prepared",
        preparedAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
      },
      occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
    });
    inventoryPositions.push({
      id: positionIdFor(item),
      revision: 1,
      inventoryItemId,
      locationId: "location_pantry_ecommerce_fulfillment",
      balance: {
        kind: "accounted",
        onHand: { amount: item.available, scale: 0, unit: "each" },
        allocated: { amount: 0, scale: 0, unit: "each" },
        available: { amount: item.available, scale: 0, unit: "each" },
      },
      occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
    });
  }
  return {
    locations: [
      {
        id: "location_pantry_ecommerce_fulfillment",
        revision: 1,
        name: "Purin Pantry Demo Fulfillment",
        kind: "fulfillment_center",
        lifecycle: {
          state: "active",
          activeAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
        },
        occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
      },
    ],
    salesChannels: [
      {
        id: "channel_pantry_ecommerce_online",
        revision: 1,
        name: "Purin Checkout Demo Storefront",
        kind: "online",
        lifecycle: {
          state: "active",
          activeAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
        },
        occurredAt: PANTRY_ECOMMERCE_FIXTURE_TIMESTAMP,
      },
    ],
    products,
    variants,
    inventoryItems,
    offers,
    inventoryPositions,
    orders: [],
    payments: [],
    fulfillments: [],
    shipments: [],
  };
}

function hasPantryEcommerceFixture(
  resources: CommerceResourcesV1,
): boolean {
  if (!resources.locations.some(hasEcommerceLocation)) return false;
  if (!resources.salesChannels.some(hasEcommerceChannel)) return false;
  const item = PANTRY_ECOMMERCE_ITEMS[0];
  if (item === undefined) return false;
  return (
    resources.products.some((resource) => resource.id === productIdFor(item)) &&
    resources.variants.some((resource) => resource.id === variantIdFor(item)) &&
    resources.inventoryItems.some(
      (resource) => resource.id === inventoryItemIdFor(item),
    ) &&
    resources.offers.some((resource) => resource.id === offerIdFor(item)) &&
    resources.inventoryPositions.some(
      (resource) => resource.id === positionIdFor(item),
    )
  );
}

function hasEcommerceLocation(
  resource: CommerceResourcesV1["locations"][number],
): boolean {
  return resource.id === "location_pantry_ecommerce_fulfillment";
}

function hasEcommerceChannel(
  resource: CommerceResourcesV1["salesChannels"][number],
): boolean {
  return resource.id === "channel_pantry_ecommerce_online";
}

function productIdFor(item: StorefrontDemoItem): string {
  return `product_${item.slug}`;
}

function variantIdFor(item: StorefrontDemoItem): string {
  return `variant_${item.slug}`;
}

function inventoryItemIdFor(item: StorefrontDemoItem): string {
  return `inventory_${item.slug}`;
}

function offerIdFor(item: StorefrontDemoItem): string {
  return `offer_${item.slug}`;
}

function positionIdFor(item: StorefrontDemoItem): string {
  return `position_${item.slug}_pantry_ecommerce`;
}
