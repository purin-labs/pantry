/// <reference types="@cloudflare/workers-types" />

// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { describe, expect, it } from "vitest";
import type {
  CanonicalCommerceObservation,
  CommerceProjection,
} from "@purin-labs/commerce-contracts";

import {
  createCueQueueMessage,
  parseCueQueueMessage,
  parseCueSnapshot,
  renderCueProposal,
} from "@purin-labs/agent/cues/engine";
import {
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import {
  parseShopifyCommerceCatalogEnvelopeBody,
  parseShopifyCommerceInventoryLevelEnvelopeBody,
  parseShopifyCommerceProductDeletionBody,
  parseShopifyCommerceRefreshTarget,
  parseShopifyCueEvent,
} from "@purin-labs/area-integrations/shopify/connector/webhook-ingress";
import {
  fetchShopifyInitialCommerce,
  fetchShopifyOrderCommerceRefresh,
} from "@purin-labs/area-integrations/shopify/connector/initial-sync";
import { registerShopifyWebhooks } from "@purin-labs/area-integrations/shopify/connector/webhook-registration";
import {
  normalizeShopifyCommerceCatalogDelivery,
  normalizeShopifyCommerceInventoryDelivery,
  normalizeShopifyCommerceOrderDelivery,
  normalizeShopifyCommerceResourceDelivery,
} from "@purin-labs/area-integrations/shopify/delivery-normalizers";
import { isRecord } from "@purin-labs/std";

type CapturedShopifyRequest = {
  url: string;
  method: string;
  body: Record<string, unknown>;
};

let capturedShopifyRequests: CapturedShopifyRequest[] = [];
let capturedShopifyFetcherReceiver: unknown = null;

describe("Shopify cue webhook boundary", function shopifyCueWebhookSuite() {
  it(
    "retains and creates the exact Shopify cue subscriptions idempotently",
    registersShopifyWebhooks,
  );
  it(
    "registers inventory when protected order webhooks are unavailable",
    registersInventoryWithoutProtectedOrders,
  );
  it(
    "updates a stale same-topic webhook instead of creating a duplicate name",
    updatesStaleShopifyWebhook,
  );
  it(
    "normalizes order and inventory deliveries into closed cue events",
    normalizesShopifyEvents,
  );
  it(
    "normalizes a complete product webhook into a canonical projection",
    normalizesShopifyCommerceCatalogWebhook,
  );
  it(
    "normalizes an inventory-level webhook into a canonical position",
    normalizesShopifyCommerceInventoryWebhook,
  );
  it(
    "separates incomplete order refresh from product deletion",
    separatesRefreshAndDeletion,
  );
  it(
    "normalizes Shopify source-fact resource envelopes across the remaining CK1 records",
    normalizesShopifyCommerceResources,
  );
  it("fetches an initial catalog and order snapshot", fetchesInitialCommerce);
  it(
    "refreshes one incomplete signed order through the snapshot mapper",
    fetchesOrderRefresh,
  );
  it(
    "skips Location fields when the grant exposes inventory only",
    skipsInitialLocationsWithoutScope,
  );
  it(
    "matches and renders a Shopify subscription from a KV snapshot",
    matchesShopifySubscription,
  );
});

async function fetchesOrderRefresh(): Promise<void> {
  const refreshed = await fetchShopifyOrderCommerceRefresh({
    shopDomain: "pantry-test.myshopify.com",
    accessToken: "shopify-test-token-42",
    organisationId: requireOrganisationId(),
    integrationAccountId: requireIntegrationAccountId(),
    observedAt: Date.parse("2026-08-04T00:00:03Z"),
    orderGid: "gid://shopify/Order/42",
    webhookId: "webhook_order_42",
    fetcher: shopifyOrderRefreshFetcher,
  });
  expect(refreshed).toMatchObject({
    ok: true,
    value: {
      order: {
        context: {
          eventId: "shopify:webhook_order_42:order:gid://shopify/Order/42",
          revision: 1785801602,
        },
        order: { id: "gid://shopify/Order/42", checkoutId: "#42" },
      },
      resources: [],
    },
  });
}

async function registersShopifyWebhooks(): Promise<void> {
  capturedShopifyRequests = [];
  capturedShopifyFetcherReceiver = null;
  const endpointUrl =
    "https://example.test/hook/shopify/organisation_T0BGQSSG45N";
  const registration = await registerShopifyWebhooks({
    shopDomain: "pantry-test.myshopify.com",
    accessToken: "shopify-test-token-42",
    endpointUrl,
    fetcher: shopifyWebhookFetcher,
  });
  const createRequest = capturedShopifyRequests[2];

  expect(registration).toEqual({
    ok: true,
    value: {
      kind: "configured",
      ordersCreate: {
        kind: "live",
        subscription: {
          kind: "existing",
          topic: "ORDERS_CREATE",
          subscriptionId: "gid://shopify/WebhookSubscription/order",
          uri: endpointUrl,
        },
      },
      ordersUpdated: {
        kind: "live",
        subscription: {
          kind: "created",
          topic: "ORDERS_UPDATED",
          subscriptionId: "gid://shopify/WebhookSubscription/orders-updated",
          uri: endpointUrl,
        },
      },
      inventoryLevelsUpdate: {
        kind: "created",
        topic: "INVENTORY_LEVELS_UPDATE",
        subscriptionId:
          "gid://shopify/WebhookSubscription/inventory-levels-update",
        uri: endpointUrl,
      },
      productsCreate: {
        kind: "created",
        topic: "PRODUCTS_CREATE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-create",
        uri: endpointUrl,
      },
      productsDelete: {
        kind: "created",
        topic: "PRODUCTS_DELETE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-delete",
        uri: endpointUrl,
      },
      productsUpdate: {
        kind: "created",
        topic: "PRODUCTS_UPDATE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-update",
        uri: endpointUrl,
      },
    },
  });
  expect(capturedShopifyRequests).toHaveLength(6);
  expect(createRequest?.url).toBe(
    "https://pantry-test.myshopify.com/admin/api/2026-07/graphql.json",
  );
  expect(createRequest?.method).toBe("POST");
  expect(createRequest?.body).toMatchObject({
    variables: {
      topic: "INVENTORY_LEVELS_UPDATE",
      webhookSubscription: {
        uri: endpointUrl,
        format: "JSON",
        name: "pantry-inventory-levels-update",
      },
    },
  });
  expect(capturedShopifyFetcherReceiver).toBeUndefined();
}

async function registersInventoryWithoutProtectedOrders(): Promise<void> {
  capturedShopifyRequests = [];
  const endpointUrl =
    "https://example.test/hook/shopify/organisation_T0BGQSSG45N";
  const registration = await registerShopifyWebhooks({
    shopDomain: "pantry-test.myshopify.com",
    accessToken: "shopify-test-token-42",
    endpointUrl,
    fetcher: shopifyProtectedOrderFetcher,
  });

  expect(registration).toEqual({
    ok: true,
    value: {
      kind: "configured",
      ordersCreate: {
        kind: "unavailable",
        reasonCode: "provider_rejected",
      },
      ordersUpdated: {
        kind: "live",
        subscription: {
          kind: "created",
          topic: "ORDERS_UPDATED",
          subscriptionId: "gid://shopify/WebhookSubscription/orders-updated",
          uri: endpointUrl,
        },
      },
      inventoryLevelsUpdate: {
        kind: "created",
        topic: "INVENTORY_LEVELS_UPDATE",
        subscriptionId:
          "gid://shopify/WebhookSubscription/inventory-levels-update",
        uri: endpointUrl,
      },
      productsCreate: {
        kind: "created",
        topic: "PRODUCTS_CREATE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-create",
        uri: endpointUrl,
      },
      productsDelete: {
        kind: "created",
        topic: "PRODUCTS_DELETE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-delete",
        uri: endpointUrl,
      },
      productsUpdate: {
        kind: "created",
        topic: "PRODUCTS_UPDATE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-update",
        uri: endpointUrl,
      },
    },
  });
  expect(capturedShopifyRequests).toHaveLength(7);
}

async function updatesStaleShopifyWebhook(): Promise<void> {
  capturedShopifyRequests = [];
  const endpointUrl =
    "https://example.test/hook/shopify/organisation_T0BGQSSG45N";
  const registration = await registerShopifyWebhooks({
    shopDomain: "pantry-test.myshopify.com",
    accessToken: "shopify-test-token-42",
    endpointUrl,
    fetcher: shopifyStaleWebhookFetcher,
  });

  expect(registration).toMatchObject({
    ok: true,
    value: {
      productsCreate: {
        kind: "updated",
        topic: "PRODUCTS_CREATE",
        subscriptionId: "gid://shopify/WebhookSubscription/products-create",
        uri: endpointUrl,
      },
    },
  });
  expect(capturedShopifyRequests).toHaveLength(7);
  expect(capturedShopifyRequests[4]?.body).toMatchObject({
    variables: {
      id: "gid://shopify/WebhookSubscription/products-create",
      webhookSubscription: {
        uri: endpointUrl,
        format: "JSON",
        name: "pantry-products-create",
      },
    },
  });
}

function normalizesShopifyEvents(): void {
  const organisationId = requireOrganisationId();
  const integrationAccountId = requireIntegrationAccountId();
  const order = parseShopifyCueEvent({
    rawBody: JSON.stringify({
      id: 42,
      name: "#1042",
      total_price: "125.50",
      currency: "USD",
      financial_status: "paid",
    }),
    headers: shopifyHeaders("orders/create", "wh_order_1"),
    organisationId,
    integrationAccountId,
    receivedAt: 1_000,
  });
  expect(order).toMatchObject({
    ok: true,
    value: {
      source: "shopify",
      nativeId: "wh_order_1",
      eventType: "orders/create",
      payload: { orderId: "42", totalPriceMinor: 12_550, currency: "USD" },
    },
  });
  if (!order.ok) throw new Error("Shopify order fixture failed");

  expect(
    parseCueQueueMessage(
      createCueQueueMessage({
        requestId: requireRequestId(),
        receivedAt: 1_000,
        event: order.value,
      }),
    ),
  ).toEqual({
    ok: true,
    value: createCueQueueMessage({
      requestId: requireRequestId(),
      receivedAt: 1_000,
      event: order.value,
    }),
  });

  expect(
    parseShopifyCueEvent({
      rawBody: JSON.stringify({
        inventory_item_id: 501,
        location_id: 77,
        available: 8,
        updated_at: "2026-07-13T00:00:00Z",
      }),
      headers: shopifyHeaders("inventory_levels/update", "wh_inventory_1"),
      organisationId,
      integrationAccountId,
      receivedAt: 2_000,
    }),
  ).toMatchObject({
    ok: true,
    value: {
      eventType: "inventory_levels/update",
      payload: { inventoryItemId: "501", locationId: "77", available: 8 },
    },
  });
}

function separatesRefreshAndDeletion(): void {
  const organisationId = requireOrganisationId();
  const integrationAccountId = requireIntegrationAccountId();
  expect(
    parseShopifyCommerceRefreshTarget({
      body: { id: 42 },
      headers: shopifyHeaders("orders/create", "wh_order_refresh"),
    }),
  ).toEqual({
    ok: true,
    value: { kind: "order", orderGid: "gid://shopify/Order/42" },
  });
  expect(
    parseShopifyCommerceProductDeletionBody({
      body: { id: 7001 },
      headers: shopifyHeaders("products/delete", "wh_product_delete"),
      organisationId,
      integrationAccountId,
      receivedAt: 1_000,
    }),
  ).toMatchObject({
    ok: true,
    value: {
      providerDeliveryId: "shopify:wh_product_delete",
      observations: [
        {
          kind: "delete",
          provenance: {
            resourceType: "product",
            resourceId: "gid://shopify/Product/7001",
          },
        },
      ],
    },
  });
}

function normalizesShopifyCommerceCatalogWebhook(): void {
  const organisationId = requireOrganisationId();
  const integrationAccountId = requireIntegrationAccountId();
  const envelope = parseShopifyCommerceCatalogEnvelopeBody({
    body: {
      id: 7001,
      title: "Field Watch",
      body_html: "<p>Automatic field watch</p>",
      currency: "USD",
      updated_at: "2026-08-04T00:00:00Z",
      variants: [
        {
          id: 7002,
          inventory_item_id: 7003,
          title: "Black / 40mm",
          sku: "WATCH-BLK-40",
          price: "199.00",
          inventory_quantity: 4,
        },
      ],
    },
    headers: shopifyHeaders("products/update", "wh_product_7001"),
    organisationId,
    integrationAccountId,
    receivedAt: Date.parse("2026-08-04T00:00:01Z"),
  });

  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error("complete Shopify catalog fixture failed");

  const normalized = normalizeShopifyCommerceCatalogDelivery(envelope.value);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error("Shopify catalog normalization failed");

  expect(normalized.value.providerDeliveryId).toBe("shopify:wh_product_7001");
  expect(normalized.value.observations[0]).toMatchObject({
    projection: {
      kind: "product",
      projection: {
        provenance: {
          organisationId,
          integrationAccountId,
          resourceId: "gid://shopify/Product/7001",
        },
        title: "Field Watch",
      },
    },
  });
  expect(
    normalized.value.observations.map(
      (observation) => upsertProjection(observation).kind,
    ),
  ).toEqual(["product", "sellable_variant", "inventory_item"]);
  expect(upsertProjection(normalized.value.observations[1])).toMatchObject({
    kind: "sellable_variant",
    projection: {
      provenance: {
        resourceId: "gid://shopify/ProductVariant/7002",
        resourceType: "sellable_variant",
      },
      productId: "gid://shopify/Product/7001",
      variantId: "gid://shopify/ProductVariant/7002",
    },
  });
}

function normalizesShopifyCommerceInventoryWebhook(): void {
  const envelope = parseShopifyCommerceInventoryLevelEnvelopeBody({
    body: {
      inventory_item_id: 7003,
      location_id: 8001,
      available: 4,
      updated_at: "2026-08-04T00:00:00Z",
    },
    headers: shopifyHeaders(
      "inventory_levels/update",
      "wh_inventory_7003_8001",
    ),
    organisationId: requireOrganisationId(),
    integrationAccountId: requireIntegrationAccountId(),
    receivedAt: Date.parse("2026-08-04T00:00:01Z"),
  });

  expect(envelope.ok).toBe(true);
  if (!envelope.ok)
    throw new Error("complete Shopify inventory fixture failed");
  const normalized = normalizeShopifyCommerceInventoryDelivery(envelope.value);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error("Shopify inventory normalization failed");
  expect(normalized.value).toMatchObject({
    providerDeliveryId: "shopify:wh_inventory_7003_8001",
    observations: [
      {
        projection: {
          kind: "inventory_position",
          projection: {
            inventoryItemId: "gid://shopify/InventoryItem/7003",
            locationId: "gid://shopify/Location/8001",
            balance: {
              kind: "available_only",
              available: { amount: 4, scale: 0, unit: "each" },
            },
          },
        },
      },
    ],
  });
}

function normalizesShopifyCommerceResources(): void {
  const context = {
    organisationId: requireOrganisationId(),
    integrationAccountId: requireIntegrationAccountId(),
    revision: 7,
    occurredAt: "2026-08-04T00:00:00Z",
    observedAt: "2026-08-04T00:00:01Z",
    eventId: "shopify:resource-fixture",
    customerReference: "shopify-resource-fixture",
  };
  const resources: readonly [string, unknown][] = [
    [
      "location",
      {
        kind: "location",
        resource: {
          id: "gid://shopify/Location/8001",
          name: "Tokyo Fulfillment Center",
          classification: { state: "assigned", kind: "fulfillment_center" },
          active: true,
          updatedAt: "2026-08-04T00:00:00Z",
        },
      },
    ],
    [
      "sales_channel",
      {
        kind: "sales_channel",
        resource: {
          id: "gid://shopify/Publication/8101",
          name: "Online Store",
          kind: "online",
          active: true,
          updatedAt: "2026-08-04T00:00:00Z",
        },
      },
    ],
    [
      "offer",
      {
        kind: "offer",
        resource: {
          variantGid: "gid://shopify/ProductVariant/7002",
          publicationGid: "gid://shopify/Publication/8101",
          price: "199.00",
          currency: "USD",
          available: true,
          lifecycle: { state: "listed", listedAt: "2026-08-04T00:00:00Z" },
          updatedAt: "2026-08-04T00:00:00Z",
        },
      },
    ],
    [
      "payment",
      {
        kind: "payment",
        resource: {
          id: "gid://shopify/OrderTransaction/8301",
          orderId: "gid://shopify/Order/9001",
          amount: "199.00",
          currency: "USD",
          lifecycle: { state: "captured", capturedAt: "2026-08-04T00:00:00Z" },
          updatedAt: "2026-08-04T00:00:00Z",
        },
      },
    ],
    [
      "fulfillment",
      {
        kind: "fulfillment",
        resource: {
          id: "gid://shopify/Fulfillment/8401",
          orderId: "gid://shopify/Order/9001",
          locationId: "gid://shopify/Location/8001",
          expectedBy: "2026-08-05T00:00:00Z",
          lineItems: [
            { lineItemId: "gid://shopify/LineItem/9002", quantity: 1 },
          ],
          lifecycle: {
            state: "requested",
            requestedAt: "2026-08-04T00:00:00Z",
          },
          updatedAt: "2026-08-04T00:00:00Z",
        },
      },
    ],
    [
      "shipment",
      {
        kind: "shipment",
        resource: {
          id: "gid://shopify/Shipment/8501",
          orderId: "gid://shopify/Order/9001",
          fulfillmentId: "gid://shopify/Fulfillment/8401",
          carrier: "Example Carrier",
          trackingNumber: "TRACK-8501",
          estimatedDeliveryAt: "2026-08-06T00:00:00Z",
          events: [
            {
              id: "gid://shopify/TrackingEvent/8502",
              occurredAt: "2026-08-04T00:00:00Z",
              kind: { state: "label_created" },
              location: "Tokyo",
            },
          ],
          lifecycle: {
            state: "label_created",
            createdAt: "2026-08-04T00:00:00Z",
          },
          updatedAt: "2026-08-04T00:00:00Z",
        },
      },
    ],
  ];

  for (const [kind, resource] of resources) {
    const normalized = normalizeShopifyCommerceResourceDelivery({
      apiVersion: "2026-07",
      context,
      resource,
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok)
      throw new Error(`Shopify ${kind} resource normalization failed`);
    expect(upsertProjection(normalized.value.observations[0]).kind).toBe(kind);
    if (kind === "offer") {
      expect(upsertProjection(normalized.value.observations[0])).toMatchObject({
        kind: "offer",
        projection: {
          provenance: {
            resourceId:
              "shopify:offer:gid://shopify/ProductVariant/7002:gid://shopify/Publication/8101",
          },
          variantId: "gid://shopify/ProductVariant/7002",
          salesChannelId: "gid://shopify/Publication/8101",
        },
      });
    }
  }

  const pending = normalizeShopifyCommerceResourceDelivery({
    apiVersion: "2026-07",
    context,
    resource: {
      kind: "location",
      resource: {
        id: "gid://shopify/Location/8002",
        name: "Unclassified Shopify Location",
        classification: { state: "pending" },
        active: true,
        updatedAt: "2026-08-04T00:00:00Z",
      },
    },
  });
  expect(pending).toEqual({
    ok: false,
    error: {
      code: "commerce_wasm_rejected",
      reason: "location_classification_required",
    },
  });
}

async function fetchesInitialCommerce(): Promise<void> {
  capturedShopifyFetcherReceiver = null;
  const snapshot = await fetchShopifyInitialCommerce({
    shopDomain: "pantry-test.myshopify.com",
    accessToken: "shopify-test-token-42",
    organisationId: requireOrganisationId(),
    integrationAccountId: requireIntegrationAccountId(),
    observedAt: Date.parse("2026-08-04T00:00:01Z"),
    locationAccess: { kind: "read_locations", scope: "read_locations" },
    publicationAccess: {
      kind: "read_publications",
      scope: "read_publications",
    },
    fetcher: shopifyInitialSyncFetcher,
  });

  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("initial Shopify sync fixture failed");
  expect(snapshot.value.catalog).toHaveLength(2);
  expect(snapshot.value.inventory).toHaveLength(1);
  expect(snapshot.value.locations).toHaveLength(1);
  expect(snapshot.value.locationQuery).toBe("queried");
  expect(snapshot.value.orders).toHaveLength(1);
  expect(snapshot.value.publicationQuery).toBe("queried");
  expect(snapshot.value.resources).toHaveLength(5);
  expect(snapshot.value.catalog[0]?.context.eventId).toBe(
    "shopify:initial:product:gid://shopify/Product/7001",
  );
  expect(snapshot.value.catalog[1]).toMatchObject({
    product: { id: "gid://shopify/Product/7004", variants: [] },
  });
  expect(snapshot.value.locations[0]?.context.eventId).toBe(
    "shopify:initial:location:gid://shopify/Location/8001",
  );
  expect(snapshot.value.orders[0]?.context.eventId).toBe(
    "shopify:initial:order:gid://shopify/Order/9001",
  );
  expect(snapshot.value.inventory[0]).toMatchObject({
    inventoryItemId: "gid://shopify/InventoryItem/7003",
    locationId: "gid://shopify/Location/8001",
    available: 4,
  });
  expect(
    snapshot.value.resources.map((resource) => resource.resource.kind),
  ).toEqual(["offer", "sales_channel", "payment", "fulfillment", "shipment"]);
  expect(snapshot.value.resources[0]?.resource).toMatchObject({
    kind: "offer",
    resource: {
      variantGid: "gid://shopify/ProductVariant/7002",
      publicationGid: "gid://shopify/Publication/8101",
      lifecycle: { state: "listed" },
    },
  });
  expect(snapshot.value.resources[1]?.resource).toMatchObject({
    kind: "sales_channel",
    resource: {
      id: "gid://shopify/Publication/8101",
      name: "Online Store",
      kind: "online",
    },
  });
  expect(snapshot.value.resources[3]?.resource).toMatchObject({
    kind: "fulfillment",
    resource: {
      id: "gid://shopify/Fulfillment/9004",
      locationId: "gid://shopify/Location/8001",
      lifecycle: {
        state: "handed_to_carrier",
        shipmentId: "gid://shopify/Fulfillment/9004/shipment/TRACK-9004",
      },
    },
  });
  expect(snapshot.value.resources[4]?.resource).toMatchObject({
    kind: "shipment",
    resource: {
      id: "gid://shopify/Fulfillment/9004/shipment/TRACK-9004",
      carrier: "Example Carrier",
      trackingNumber: "TRACK-9004",
      lifecycle: { state: "in_transit" },
    },
  });
  expect(capturedShopifyFetcherReceiver).toBeUndefined();

  const catalog = normalizeShopifyCommerceCatalogDelivery(
    snapshot.value.catalog[0],
  );
  const skuLessCatalog = normalizeShopifyCommerceCatalogDelivery(
    snapshot.value.catalog[1],
  );
  const inventory = normalizeShopifyCommerceInventoryDelivery(
    snapshot.value.inventory[0],
  );
  const order = normalizeShopifyCommerceOrderDelivery(snapshot.value.orders[0]);
  const fulfillment = normalizeShopifyCommerceResourceDelivery(
    snapshot.value.resources[3],
  );
  const shipment = normalizeShopifyCommerceResourceDelivery(
    snapshot.value.resources[4],
  );
  expect(catalog.ok).toBe(true);
  expect(skuLessCatalog.ok).toBe(true);
  expect(inventory.ok).toBe(true);
  expect(order.ok).toBe(true);
  expect(
    fulfillment.ok
      ? upsertProjection(fulfillment.value.observations[0]).kind
      : null,
  ).toBe("fulfillment");
  expect(shipment).toMatchObject({ ok: true });
  expect(
    shipment.ok ? upsertProjection(shipment.value.observations[0]).kind : null,
  ).toBe("shipment");
  expect(
    catalog.ok ? upsertProjection(catalog.value.observations[0]).kind : null,
  ).toBe("product");
  expect(
    catalog.ok ? upsertProjection(catalog.value.observations[1]).kind : null,
  ).toBe("sellable_variant");
  expect(
    skuLessCatalog.ok ? skuLessCatalog.value.observations.length : null,
  ).toBe(1);
  expect(
    inventory.ok
      ? upsertProjection(inventory.value.observations[0]).kind
      : null,
  ).toBe("inventory_position");
  expect(
    order.ok ? upsertProjection(order.value.observations[0]).kind : null,
  ).toBe("commerce_order");
  expect(snapshot.value.locations[0]?.resource.kind).toBe("location");
}

async function skipsInitialLocationsWithoutScope(): Promise<void> {
  capturedShopifyRequests = [];
  const snapshot = await fetchShopifyInitialCommerce({
    shopDomain: "pantry-test.myshopify.com",
    accessToken: "shopify-test-token-42",
    organisationId: requireOrganisationId(),
    integrationAccountId: requireIntegrationAccountId(),
    observedAt: Date.parse("2026-08-04T00:00:01Z"),
    locationAccess: { kind: "inventory_only", scope: "read_inventory" },
    publicationAccess: {
      kind: "scope_missing",
      requiredScope: "read_publications",
    },
    fetcher: shopifyInitialSyncFetcher,
  });

  expect(snapshot).toMatchObject({
    ok: true,
    value: {
      locations: [],
      locationQuery: "skipped_scope",
      publicationQuery: "skipped_scope",
    },
  });
  expect(
    capturedShopifyRequests.every(
      (request) =>
        typeof request.body.query !== "string" ||
        (!request.body.query.includes("locations(first") &&
          !request.body.query.includes("PantryInitialPublications")),
    ),
  ).toBe(true);
}

function matchesShopifySubscription(): void {
  const organisationId = requireOrganisationId();
  const integrationAccountId = requireIntegrationAccountId();
  const snapshot = parseCueSnapshot({
    organisationId,
    version: 1,
    subscriptions: [
      {
        subscriptionId: "shopify-order-created-main",
        organisationId,
        version: 1,
        surfaceScope: {
          kind: "slack",
          workspaceId: "T0BGQSSG45N",
          channelId: "C0BG0P4JF25",
          threadKey: "slack:T0BGQSSG45N:C0BG0P4JF25:channel",
        },
        source: "shopify",
        eventType: "orders/create",
        action: {
          kind: "propose",
          template: "A Shopify order was created.",
          delivery: { kind: "immediate" },
        },
        tier: 1,
        debounceMs: 0,
        maxPerHour: 20,
        enabled: true,
      },
    ],
    createdAt: 1_000,
  });
  const event = parseShopifyCueEvent({
    rawBody: JSON.stringify({
      id: "gid://shopify/Order/42",
      name: "#1042",
      total_price: "10.00",
      currency: "USD",
      financial_status: null,
    }),
    headers: shopifyHeaders("orders/create", "wh_order_match"),
    organisationId,
    integrationAccountId,
    receivedAt: 1_000,
  });

  if (!snapshot.ok || !event.ok)
    throw new Error("invalid Shopify match fixture");
  const subscription = snapshot.value.subscriptions[0];
  if (subscription === undefined)
    throw new Error("missing Shopify subscription fixture");
  expect(renderCueProposal(subscription, event.value)).toContain("#1042");
}

function shopifyHeaders(topic: string, webhookId: string) {
  return {
    topic,
    webhookId,
    shopDomain: "pantry-test.myshopify.com",
    triggeredAt: "2026-07-13T00:00:00Z",
  };
}

async function shopifyWebhookFetcher(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  capturedShopifyFetcherReceiver = this;
  const url = input instanceof Request ? input.url : String(input);
  const body = parseCapturedShopifyBody(init?.body);
  capturedShopifyRequests.push({
    url,
    method: init?.method ?? "GET",
    body,
  });

  if (
    typeof body.query === "string" &&
    body.query.includes("webhookSubscriptions")
  ) {
    return Response.json({
      data: {
        webhookSubscriptions: {
          nodes: [
            {
              id: "gid://shopify/WebhookSubscription/order",
              topic: "ORDERS_CREATE",
              uri: "https://example.test/hook/shopify/organisation_T0BGQSSG45N",
              format: "JSON",
            },
          ],
        },
      },
    });
  }

  const variables = body.variables;
  const topic =
    isRecord(variables) && typeof variables.topic === "string"
      ? variables.topic
      : null;

  if (topic === null) {
    throw new Error("Shopify webhook topic is missing");
  }

  return Response.json({
    data: {
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: `gid://shopify/WebhookSubscription/${topic.toLowerCase().replaceAll("_", "-")}`,
          topic,
          uri: "https://example.test/hook/shopify/organisation_T0BGQSSG45N",
        },
        userErrors: [],
      },
    },
  });
}

async function shopifyProtectedOrderFetcher(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const body = parseCapturedShopifyBody(init?.body);
  capturedShopifyRequests.push({
    url,
    method: init?.method ?? "GET",
    body,
  });

  if (
    typeof body.query === "string" &&
    body.query.includes("webhookSubscriptions")
  ) {
    return Response.json({ data: { webhookSubscriptions: { nodes: [] } } });
  }

  const variables = body.variables;
  if (!isRecord(variables) || typeof variables.topic !== "string") {
    throw new Error("Shopify registration variables are invalid");
  }

  if (variables.topic === "ORDERS_CREATE") {
    return Response.json({
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [
            {
              field: ["topic"],
              message: "This subscription topic is not available to this app.",
            },
          ],
        },
      },
    });
  }

  return Response.json({
    data: {
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: `gid://shopify/WebhookSubscription/${variables.topic.toLowerCase().replaceAll("_", "-")}`,
          topic: variables.topic,
          uri: "https://example.test/hook/shopify/organisation_T0BGQSSG45N",
        },
        userErrors: [],
      },
    },
  });
}

async function shopifyStaleWebhookFetcher(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const body = parseCapturedShopifyBody(init?.body);
  capturedShopifyRequests.push({
    url,
    method: init?.method ?? "GET",
    body,
  });

  if (
    typeof body.query === "string" &&
    body.query.includes("webhookSubscriptions")
  ) {
    return Response.json({
      data: {
        webhookSubscriptions: {
          nodes: [
            {
              id: "gid://shopify/WebhookSubscription/products-create",
              topic: "PRODUCTS_CREATE",
              uri: "https://old.example.test/hook/shopify/organisation_T0BGQSSG45N",
              format: "JSON",
            },
          ],
        },
      },
    });
  }

  const variables = body.variables;
  if (!isRecord(variables)) {
    throw new Error("Shopify webhook topic is missing");
  }
  const topic =
    typeof variables.topic === "string"
      ? variables.topic
      : isRecord(variables.webhookSubscription) &&
          typeof variables.webhookSubscription.name === "string"
        ? variables.webhookSubscription.name
            .replace(/^pantry-/u, "")
            .replaceAll("-", "_")
            .toUpperCase()
        : null;
  if (topic === null) {
    throw new Error("Shopify webhook topic is missing");
  }
  const mutation =
    typeof body.query === "string" &&
    body.query.includes("webhookSubscriptionUpdate")
      ? "webhookSubscriptionUpdate"
      : "webhookSubscriptionCreate";
  return Response.json({
    data: {
      [mutation]: {
        webhookSubscription: {
          id: `gid://shopify/WebhookSubscription/${topic.toLowerCase().replaceAll("_", "-")}`,
          topic,
          uri: "https://example.test/hook/shopify/organisation_T0BGQSSG45N",
        },
        userErrors: [],
      },
    },
  });
}

async function shopifyInitialSyncFetcher(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  capturedShopifyFetcherReceiver = this;
  const url = input instanceof Request ? input.url : String(input);
  expect(url).toBe(
    "https://pantry-test.myshopify.com/admin/api/2026-07/graphql.json",
  );
  const body = parseCapturedShopifyBody(init?.body);
  expect(body.variables).toMatchObject({ first: 100, after: null });
  if (typeof body.query !== "string") {
    throw new Error("Shopify initial sync query is missing");
  }
  if (body.query.includes("PantryInitialPublications")) {
    return Response.json({
      data: {
        products: {
          nodes: [
            {
              id: "gid://shopify/Product/7001",
              updatedAt: "2026-08-04T00:00:00Z",
              priceRangeV2: { minVariantPrice: { currencyCode: "USD" } },
              variants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/7002",
                    sku: "WATCH-BLK-40",
                    price: "199.00",
                    availableForSale: true,
                  },
                  {
                    id: "gid://shopify/ProductVariant/7006",
                    sku: null,
                    price: "49.00",
                    availableForSale: true,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
              resourcePublicationsV2: {
                nodes: [
                  {
                    isPublished: true,
                    publishDate: "2026-08-03T00:00:00Z",
                    publication: {
                      id: "gid://shopify/Publication/8101",
                      supportsFuturePublishing: true,
                      channels: {
                        nodes: [
                          {
                            id: "gid://shopify/Channel/8102",
                            name: "Online Store",
                            handle: "online-store",
                          },
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  },
                  {
                    isPublished: true,
                    publishDate: null,
                    publication: {
                      id: "gid://shopify/Publication/8201",
                      supportsFuturePublishing: false,
                      channels: null,
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (body.query.includes("PantryInitialInventory")) {
    return Response.json({
      data: {
        inventoryItems: {
          nodes: [
            {
              id: "gid://shopify/InventoryItem/7003",
              sku: "WATCH-BLK-40",
              inventoryLevels: {
                nodes: [
                  {
                    location: { id: "gid://shopify/Location/8001" },
                    quantities: [
                      {
                        name: "available",
                        quantity: 4,
                        updatedAt: "2026-08-04T00:00:00Z",
                      },
                    ],
                    updatedAt: "2026-08-04T00:00:00Z",
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
            {
              id: "gid://shopify/InventoryItem/7005",
              sku: "",
              inventoryLevels: {
                nodes: [
                  {
                    location: { id: "gid://shopify/Location/8001" },
                    quantities: [
                      {
                        name: "available",
                        quantity: 2,
                        updatedAt: "2026-08-04T00:00:00Z",
                      },
                    ],
                    updatedAt: "2026-08-04T00:00:00Z",
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (body.query.includes("products(first")) {
    return Response.json({
      data: {
        products: {
          nodes: [
            {
              id: "gid://shopify/Product/7001",
              title: "Field Watch",
              descriptionHtml: "<p>Automatic field watch</p>",
              updatedAt: "2026-08-04T00:00:00Z",
              priceRangeV2: { minVariantPrice: { currencyCode: "USD" } },
              variants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/7002",
                    inventoryItem: { id: "gid://shopify/InventoryItem/7003" },
                    title: "Black / 40mm",
                    sku: "WATCH-BLK-40",
                    price: "199.00",
                    inventoryQuantity: 4,
                  },
                ],
              },
            },
            {
              id: "gid://shopify/Product/7004",
              title: "SKU-less sample",
              descriptionHtml: "",
              updatedAt: "2026-08-04T00:00:00Z",
              variants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/7005",
                    inventoryItem: { id: "gid://shopify/InventoryItem/7005" },
                    title: "Default Title",
                    sku: "",
                  },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (body.query.includes("locations(first")) {
    return Response.json({
      data: {
        locations: {
          nodes: [
            {
              id: "gid://shopify/Location/8001",
              name: "Main Shopify Location",
              isActive: true,
              updatedAt: "2026-08-04T00:00:00Z",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  return Response.json({
    data: {
      orders: {
        nodes: [
          {
            id: "gid://shopify/Order/9001",
            name: "#9001",
            createdAt: "2026-08-04T00:00:00Z",
            updatedAt: "2026-08-04T00:00:01Z",
            cancelledAt: null,
            displayFulfillmentStatus: "UNFULFILLED",
            currentTotalPriceSet: {
              shopMoney: { amount: "199.00", currencyCode: "USD" },
            },
            transactions: [
              {
                id: "gid://shopify/OrderTransaction/9003",
                kind: "SALE",
                status: "SUCCESS",
                amountSet: {
                  shopMoney: { amount: "199.00", currencyCode: "USD" },
                },
                createdAt: "2026-08-04T00:00:00Z",
                processedAt: "2026-08-04T00:00:01Z",
              },
            ],
            fulfillments: [
              {
                id: "gid://shopify/Fulfillment/9004",
                createdAt: "2026-08-04T00:00:00Z",
                updatedAt: "2026-08-04T00:00:01Z",
                deliveredAt: null,
                inTransitAt: "2026-08-04T00:00:01Z",
                estimatedDeliveryAt: "2026-08-06T00:00:00Z",
                displayStatus: "IN_TRANSIT",
                status: "SUCCESS",
                location: { id: "gid://shopify/Location/8001" },
                fulfillmentLineItems: {
                  nodes: [
                    {
                      quantity: 1,
                      lineItem: { id: "gid://shopify/LineItem/9002" },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
                trackingInfo: [
                  { company: "Example Carrier", number: "TRACK-9004" },
                ],
                events: {
                  nodes: [
                    {
                      id: "gid://shopify/FulfillmentEvent/9005",
                      happenedAt: "2026-08-04T00:00:01Z",
                      status: "IN_TRANSIT",
                      message: "Departed carrier facility",
                      address1: null,
                      city: "Tokyo",
                      province: "Tokyo",
                      country: "Japan",
                      zip: null,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            ],
            lineItems: {
              nodes: [
                {
                  id: "gid://shopify/LineItem/9002",
                  title: "Field Watch",
                  quantity: 1,
                  sku: "WATCH-BLK-40",
                  originalUnitPriceSet: {
                    shopMoney: { amount: "199.00", currencyCode: "USD" },
                  },
                  variant: { id: "gid://shopify/ProductVariant/7002" },
                },
              ],
            },
          },
          {
            id: "gid://shopify/Order/9006",
            name: "#9006",
            createdAt: "2026-08-04T00:00:00Z",
            updatedAt: "2026-08-04T00:00:01Z",
            cancelledAt: null,
            displayFulfillmentStatus: "UNFULFILLED",
            currentTotalPriceSet: {
              shopMoney: { amount: "1.00", currencyCode: "USD" },
            },
            transactions: [],
            fulfillments: [],
            lineItems: {
              nodes: [
                {
                  id: "gid://shopify/LineItem/9007",
                  title: "Custom item without SKU",
                  quantity: 1,
                  sku: null,
                  originalUnitPriceSet: {
                    shopMoney: { amount: "1.00", currencyCode: "USD" },
                  },
                  variant: null,
                },
              ],
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
}

async function shopifyOrderRefreshFetcher(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  expect(url).toBe(
    "https://pantry-test.myshopify.com/admin/api/2026-07/graphql.json",
  );
  const body = parseCapturedShopifyBody(init?.body);
  expect(body.variables).toEqual({ id: "gid://shopify/Order/42" });
  return Response.json({
    data: {
      order: {
        id: "gid://shopify/Order/42",
        name: "#42",
        createdAt: "2026-08-04T00:00:00Z",
        updatedAt: "2026-08-04T00:00:02Z",
        cancelledAt: null,
        displayFulfillmentStatus: "UNFULFILLED",
        currentTotalPriceSet: {
          shopMoney: { amount: "42.00", currencyCode: "USD" },
        },
        lineItems: {
          nodes: [
            {
              id: "gid://shopify/LineItem/4201",
              title: "Field Watch",
              quantity: 1,
              sku: "WATCH-42",
              originalUnitPriceSet: {
                shopMoney: { amount: "42.00", currencyCode: "USD" },
              },
              variant: { id: "gid://shopify/ProductVariant/7002" },
            },
          ],
        },
      },
    },
  });
}

function parseCapturedShopifyBody(
  raw: BodyInit | null | undefined,
): Record<string, unknown> {
  if (typeof raw !== "string") {
    throw new Error("Shopify registration request body is missing");
  }

  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error("Shopify registration request body is invalid");
  }

  return parsed;
}

function requireOrganisationId() {
  const parsed = parseOrganisationId("organisation_T0BGQSSG45N");
  if (!parsed.ok) throw new Error("invalid Shopify organisation fixture");
  return parsed.value;
}

function requireRequestId() {
  const parsed = parseRequestId("req_shopify_fixture");
  if (!parsed.ok) throw new Error("invalid Shopify request fixture");
  return parsed.value;
}

function requireIntegrationAccountId() {
  const parsed = parseIntegrationAccountId("integration_shopify_webhook");
  if (!parsed.ok)
    throw new Error("invalid Shopify integration account fixture");
  return parsed.value;
}

function upsertProjection(
  observation: CanonicalCommerceObservation | undefined,
): CommerceProjection {
  if (observation === undefined || observation.kind !== "upsert") {
    throw new Error("Shopify fixture did not normalize to an upsert");
  }
  return observation.projection;
}
