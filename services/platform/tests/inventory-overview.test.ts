import { expect, it } from "vitest";
import { parseInventory } from "@purin-labs/commerce-contracts";
import type { InventoryConsumptionPlan } from "@purin-labs/commerce-contracts";
import type {
  CommerceInventoryItemV1,
  CommerceVariantV1,
} from "@purin-labs/commerce-client";
import {
  saleOffers,
  connectedStockOverview,
  inventoryOverview,
  inventoryStockStatus,
} from "../src/kitchen/contract/inventory-overview";
import type {
  CommerceOfferV1,
  CommerceSalesChannelV1,
} from "@purin-labs/commerce-client";

it(
  "uses ecommerce offers rather than inventory ingredients to select sale products",
  checkEcommerceProducts,
);

function checkEcommerceProducts() {
  const resources = stockSnapshot().commerce.resources;
  const product = resources.products[0];
  const variant = resources.variants[0];
  if (product === undefined || variant === undefined)
    throw new Error("Sale fixture missing");
  const offers = saleOffers({
    salesChannels: [
      salesChannel("web", "online"),
      salesChannel("counter", "point_of_sale"),
    ],
    products: [
      { ...product, id: "active", status: "active" },
      { ...product, id: "retired", status: "archived" },
    ],
    variants: [
      { ...variant, id: "cookie", productId: "active" },
      { ...variant, id: "made-to-order-tea", productId: "active" },
      { ...variant, id: "counter-only", productId: "active" },
      { ...variant, id: "archived-cookie", productId: "retired" },
    ],
    offers: [
      saleOffer("cookie", "web"),
      saleOffer("made-to-order-tea", "web"),
      saleOffer("counter-only", "counter"),
      saleOffer("archived-cookie", "web"),
    ],
  });
  expect([...offers.keys()]).toEqual(["cookie", "made-to-order-tea"]);
  expect(offers.has("flour")).toBe(false);
}

function salesChannel(
  id: string,
  kind: CommerceSalesChannelV1["kind"],
): CommerceSalesChannelV1 {
  return {
    id,
    kind,
    revision: 1,
    name: id,
    lifecycle: { state: "active", activeAt: "2026-09-20T00:00:00Z" },
    occurredAt: "2026-09-20T00:00:00Z",
  };
}

function saleOffer(
  variantId: string,
  salesChannelId: string,
): CommerceOfferV1 {
  return {
    id: `offer-${variantId}`,
    revision: 1,
    variantId,
    salesChannelId,
    price: { amountMinor: 450, currency: "JPY" },
    compareAtPrice: null,
    availability: { state: "available" },
    lifecycle: { state: "listed", listedAt: "2026-09-20T00:00:00Z" },
    occurredAt: "2026-09-20T00:00:00Z",
  };
}

it(
  "compares stock thresholds across compatible units and distinguishes missing counts",
  checkThresholds,
);
it(
  "keeps location balances separate and never invents on-hand quantities",
  checkBalances,
);

function checkThresholds() {
  expect(
    inventoryStockStatus(
      { amount: 15, scale: 1, unit: "kilogram" },
      { amount: 1500, scale: 0, unit: "gram" },
    ),
  ).toBe("low");
  expect(
    inventoryStockStatus(
      { amount: 2, scale: 0, unit: "liter" },
      { amount: 1500, scale: 0, unit: "milliliter" },
    ),
  ).toBe("healthy");
  expect(
    inventoryStockStatus(
      { amount: 2, scale: 0, unit: "each" },
      { amount: 1500, scale: 0, unit: "gram" },
    ),
  ).toBe("unconfigured");
  expect(inventoryStockStatus(null, null)).toBe("uncounted");
  expect(
    inventoryStockStatus({ amount: 0, scale: 0, unit: "each" }, null),
  ).toBe("out");
}

function checkBalances() {
  const rows = inventoryOverview(
    {
      inventoryItems: [
        {
          id: "flour",
          revision: 1,
          merchantCode: "flour",
          name: "Flour",
          baseUnit: "gram",
          category: "ingredient",
          tracking: { kind: "aggregate" },
          lifecycle: "active",
          occurredAt: "2026-09-20T00:00:00Z",
        },
        {
          id: "sugar",
          revision: 1,
          merchantCode: "sugar",
          name: "Sugar",
          baseUnit: "gram",
          category: "ingredient",
          tracking: { kind: "aggregate" },
          lifecycle: "active",
          occurredAt: "2026-09-20T00:00:00Z",
        },
      ],
      locations: [],
      inventoryPositions: [
        {
          id: "flour-kitchen",
          revision: 1,
          inventoryItemId: "flour",
          locationId: "kitchen",
          balance: {
            kind: "available_only",
            available: { amount: 125, scale: 2, unit: "kilogram" },
          },
          occurredAt: "2026-09-20T00:00:00Z",
        },
        {
          id: "flour-store",
          revision: 1,
          inventoryItemId: "flour",
          locationId: "store",
          balance: {
            kind: "accounted",
            onHand: { amount: 10, scale: 0, unit: "kilogram" },
            allocated: { amount: 2, scale: 0, unit: "kilogram" },
            available: { amount: 8, scale: 0, unit: "kilogram" },
          },
          occurredAt: "2026-09-20T00:00:00Z",
        },
      ],
    },
    [],
  );
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    onHand: null,
    allocated: null,
    available: "1.25 kg",
    status: "unconfigured",
  });
  expect(rows[1]).toMatchObject({
    onHand: "10 kg",
    allocated: "2 kg",
    available: "8 kg",
  });
  expect(rows[2]).toMatchObject({
    name: "Sugar",
    available: null,
    status: "uncounted",
  });
}

it(
  "projects distinct sale variants and supplies without hiding untracked siblings",
  checkConnectedViews,
);

function checkConnectedViews() {
  const snapshot = stockSnapshot();
  const overview = connectedStockOverview(snapshot);
  expect(overview.rows.map(rowIdentity)).toEqual([
    { kind: "supply", name: "Flour" },
    { kind: "product", name: "Cookie · Small" },
    { kind: "product", name: "Cookie · Large" },
    { kind: "unlinked_product", name: "Unsold output" },
  ]);
  expect(overview.untrackedProducts).toEqual([
    expect.objectContaining({
      productId: "cookie",
      variantId: "gift-box",
      price: { amountMinor: 450, currency: "JPY" },
      description: expect.any(String),
      image: null,
      name: "Cookie · Gift box",
      madeToOrder: false,
    }),
  ]);
  // A location-specific plan replaces the organisation plan, including untracked mode.
  snapshot.consumptionPlans.push({
    consumptionPlanId: "local",
    variantId: "small",
    revision: 1,
    scope: { kind: "location", locationId: "kitchen" },
    mode: { kind: "untracked" },
    lifecycle: "active",
  });
  const overridden = connectedStockOverview(snapshot);
  expect(overridden.rows.map(rowIdentity)).toEqual([
    { kind: "supply", name: "Flour" },
    { kind: "product", name: "Cookie · Large" },
    { kind: "unlinked_product", name: "Unsold output" },
  ]);
  expect(overridden.untrackedProducts).toHaveLength(2);
}

function rowIdentity(
  row: ReturnType<typeof connectedStockOverview>["rows"][number],
) {
  return { kind: row.kind, name: row.name };
}

function stockSnapshot() {
  const consumptionPlans: InventoryConsumptionPlan[] = [
    stockPlan("small"),
    stockPlan("large"),
  ];
  return {
    commerce: {
      schemaVersion: "underclerk.commerce-snapshot.v2" as const,
      organisationId: "organisation",
      merchantId: "merchant",
      merchantRevision: 1,
      deliverySigner: {
        keyId: "key",
        algorithm: "ed25519" as const,
        publicKeyB64: "test",
      },
      resources: {
        products: [
          {
            id: "cookie",
            revision: 1,
            title: "Cookie",
            description: "",
            handle: null,
            productType: "",
            vendor: "",
            tags: [],
            status: "active" as const,
            occurredAt: "2026-09-20T00:00:00Z",
          },
        ],
        variants: [
          saleVariant("small", "Small"),
          saleVariant("large", "Large"),
          saleVariant("gift-box", "Gift box"),
        ],
        salesChannels: [salesChannel("web", "online")],
        offers: [
          saleOffer("small", "web"),
          saleOffer("large", "web"),
          saleOffer("gift-box", "web"),
        ],
        inventoryItems: [
          stockItem("flour", "Flour", "ingredient"),
          stockItem("cookie-stock", "Internal batch name", "finished_good"),
          stockItem("unlinked", "Unsold output", "finished_good"),
        ],
        inventoryPositions: [
          {
            id: "cookie-kitchen",
            revision: 1,
            inventoryItemId: "cookie-stock",
            locationId: "kitchen",
            balance: {
              kind: "accounted" as const,
              onHand: { amount: 12, scale: 0, unit: "each" as const },
              allocated: { amount: 2, scale: 0, unit: "each" as const },
              available: { amount: 10, scale: 0, unit: "each" as const },
            },
            occurredAt: "2026-09-20T00:00:00Z",
          },
        ],
        locations: [],
        orders: [],
        payments: [],
        fulfillments: [],
        shipments: [],
      },
    },
    foodService: {
      schemaVersion: "underclerk.food-service-snapshot.v2" as const,
      organisationId: "organisation",
      merchantId: "merchant",
      merchantRevision: 1,
      deliverySigner: {
        keyId: "key",
        algorithm: "ed25519" as const,
        publicKeyB64: "test",
      },
      resources: {
        menus: [],
        modifierGroupRevisions: [],
        recipeRevisions: [],
        preparationStations: [],
        preparationTickets: [],
        productionBatches: [],
        stockPolicies: [],
      },
    },
    lots: [],
    movements: [],
    allocations: [],
    usable: [
      {
        positionId: "cookie-kitchen",
        quantity: { amount: 10, scale: 0, unit: "each" as const },
      },
    ],
    consumptionPlans,
  };
}

function stockItem(
  id: string,
  name: string,
  category: CommerceInventoryItemV1["category"],
): CommerceInventoryItemV1 {
  return {
    id,
    name,
    category,
    revision: 1,
    merchantCode: id,
    baseUnit: "each",
    tracking: { kind: "aggregate" },
    lifecycle: "active",
    occurredAt: "2026-09-20T00:00:00Z",
  };
}

function saleVariant(id: string, title: string): CommerceVariantV1 {
  return {
    id,
    title,
    revision: 1,
    productId: "cookie",
    sku: id,
    options: [],
    media: [],
    barcode: null,
    status: "active",
    occurredAt: "2026-09-20T00:00:00Z",
  };
}

function stockPlan(variantId: string): InventoryConsumptionPlan {
  return {
    consumptionPlanId: variantId,
    variantId,
    revision: 1,
    scope: { kind: "organisation" },
    mode: {
      kind: "direct",
      components: [
        {
          inventoryItemId: "cookie-stock",
          quantity: { amount: 1, scale: 0, unit: "each" },
        },
      ],
      commitOn: "order_placed",
    },
    lifecycle: "active",
  };
}

it(
  "validates the shared stock response and rejects mixed product/supply rows",
  checkStockBoundary,
);

function checkStockBoundary() {
  const overview = connectedStockOverview(stockSnapshot());
  expect(parseInventory({ ok: true, ...overview })).toEqual(overview);
  const supply = overview.rows[0];
  expect(
    parseInventory.bind(null, {
      ok: true,
      rows: [{ ...supply, kind: "product" }],
      untrackedProducts: [],
      archivedProducts: [],
    }),
  ).toThrow("Invalid stock row kind");
}
