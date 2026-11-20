import type { ShopifyResourceEnvelopeV202607 } from "@purin-labs/commerce-contracts";
import type { IntegrationAccountId, OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { isRecord } from "@purin-labs/std";
import type {
  ShopifyCommerceCatalogEnvelope,
  ShopifyCommerceInventoryLevelEnvelope,
  ShopifyCommerceOrderEnvelope,
  ShopifyInitialCommerceSnapshot,
  ShopifyInitialOrdersSnapshot,
  ShopifyInitialSyncError,
  ShopifyLocationSnapshotAccess,
  ShopifyPublicationSnapshotAccess,
} from "../connector";
import {
  SHOPIFY_INITIAL_SYNC_MAX_PAGES,
  fetchShopifyGraphqlSnapshot,
  fetchShopifyInitialPage,
  shopifyGraphqlGid,
} from "./admin-graphql";
import {
  initialInventoryInvalid,
  parseInitialCatalogPage,
  parseInitialInventoryPage,
  parseInitialLocationsPage,
  parseInitialPublicationsPage,
} from "./catalog-snapshot";
import { parseInitialOrder, parseInitialOrdersPage } from "./order-snapshot";
import { validShopDomain } from "./values";

const SHOPIFY_INITIAL_CATALOG_QUERY = `
  query SatyrInitialCatalog($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        descriptionHtml
        updatedAt
        variants(first: 100) {
          nodes { id title sku inventoryItem { id } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SHOPIFY_INITIAL_ORDERS_QUERY = `
  query SatyrInitialOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        updatedAt
        cancelledAt
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        transactions(first: 100) {
          id
          kind
          status
          amountSet { shopMoney { amount currencyCode } }
          createdAt
          processedAt
        }
        fulfillments(first: 250) {
          id
          createdAt
          updatedAt
          deliveredAt
          inTransitAt
          estimatedDeliveryAt
          displayStatus
          status
          location { id }
          fulfillmentLineItems(first: 100) {
            nodes { quantity lineItem { id } }
            pageInfo { hasNextPage }
          }
          trackingInfo(first: 2) { company number }
          events(first: 100) {
            nodes {
              id
              happenedAt
              status
              message
              address1
              city
              province
              country
              zip
            }
            pageInfo { hasNextPage }
          }
        }
        lineItems(first: 100) {
          nodes {
            id
            title
            quantity
            sku
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            variant { id }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SHOPIFY_ORDER_REFRESH_QUERY = `
  query SatyrOrderRefresh($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      updatedAt
      cancelledAt
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      transactions(first: 100) {
        id
        kind
        status
        amountSet { shopMoney { amount currencyCode } }
        createdAt
        processedAt
      }
      fulfillments(first: 250) {
        id
        createdAt
        updatedAt
        deliveredAt
        inTransitAt
        estimatedDeliveryAt
        displayStatus
        status
        location { id }
        fulfillmentLineItems(first: 100) {
          nodes { quantity lineItem { id } }
          pageInfo { hasNextPage }
        }
        trackingInfo(first: 2) { company number }
        events(first: 100) {
          nodes {
            id
            happenedAt
            status
            message
            address1
            city
            province
            country
            zip
          }
          pageInfo { hasNextPage }
        }
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          quantity
          sku
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          variant { id }
        }
      }
    }
  }
`;

const SHOPIFY_INITIAL_LOCATIONS_QUERY = `
  query SatyrInitialLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true, includeLegacy: true) {
      nodes {
        id
        name
        isActive
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SHOPIFY_INITIAL_INVENTORY_QUERY = `
  query SatyrInitialInventory($first: Int!, $after: String) {
    inventoryItems(first: $first, after: $after) {
      nodes {
        id
        sku
        inventoryLevels(first: 100, includeInactive: false) {
          nodes {
            location { id }
            quantities(names: ["available"]) { name quantity updatedAt }
            updatedAt
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SHOPIFY_INITIAL_PUBLICATIONS_QUERY = `
  query SatyrInitialPublications($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        updatedAt
        priceRangeV2 { minVariantPrice { currencyCode } }
        variants(first: 100) {
          nodes { id sku price availableForSale }
          pageInfo { hasNextPage }
        }
        resourcePublicationsV2(first: 100, onlyPublished: false) {
          nodes {
            isPublished
            publishDate
            publication {
              id
              supportsFuturePublishing
              channels(first: 2) {
                nodes { id name handle }
                pageInfo { hasNextPage }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function fetchShopifyInitialCommerce(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly locationAccess: ShopifyLocationSnapshotAccess;
  readonly publicationAccess: ShopifyPublicationSnapshotAccess;
  readonly fetcher: typeof fetch;
}): Promise<Result<ShopifyInitialCommerceSnapshot, ShopifyInitialSyncError>> {
  if (!validShopDomain(input.shopDomain) || input.accessToken.length < 10) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "catalog",
      },
    };
  }

  const catalog = await fetchInitialCatalog(input);
  if (!catalog.ok) {
    return catalog;
  }

  const inventory = await fetchInitialInventory(input);
  if (!inventory.ok) {
    return inventory;
  }

  const locations =
    input.locationAccess.kind === "inventory_only"
      ? {
          ok: true as const,
          value: [] as readonly ShopifyResourceEnvelopeV202607[],
        }
      : await fetchInitialLocations(input);
  if (!locations.ok) {
    return locations;
  }

  const publications =
    input.publicationAccess.kind === "scope_missing"
      ? {
          ok: true as const,
          value: [] as readonly ShopifyResourceEnvelopeV202607[],
        }
      : await fetchInitialPublications(input);
  if (!publications.ok) {
    return publications;
  }

  const orders = await fetchInitialOrders(input);
  if (!orders.ok) {
    return orders;
  }

  return {
    ok: true,
    value: {
      catalog: catalog.value,
      inventory: inventory.value,
      locations: locations.value,
      locationQuery:
        input.locationAccess.kind === "inventory_only"
          ? "skipped_scope"
          : "queried",
      orders: orders.value.orders,
      publicationQuery:
        input.publicationAccess.kind === "scope_missing"
          ? "skipped_scope"
          : "queried",
      resources: [...publications.value, ...orders.value.resources],
    },
  };
}

export async function fetchShopifyOrderCommerceRefresh(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly orderGid: string;
  readonly webhookId: string;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<
    {
      readonly order: ShopifyCommerceOrderEnvelope;
      readonly resources: readonly ShopifyResourceEnvelopeV202607[];
    },
    ShopifyInitialSyncError
  >
> {
  if (
    !validShopDomain(input.shopDomain) ||
    input.accessToken.length < 10 ||
    shopifyGraphqlGid(input.orderGid, "Order") === null
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }
  const response = await fetchShopifyGraphqlSnapshot({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    query: SHOPIFY_ORDER_REFRESH_QUERY,
    variables: { id: input.orderGid },
    resource: "orders",
    fetcher: input.fetcher,
  });
  if (!response.ok) return response;
  const data = response.value.data;
  if (!isRecord(data) || !isRecord(data.order)) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }
  const parsed = parseInitialOrder({
    raw: data.order,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    observedAt: input.observedAt,
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      order: {
        ...parsed.value.order,
        context: {
          ...parsed.value.order.context,
          eventId: `shopify:${input.webhookId}:order:${input.orderGid}`,
        },
      },
      resources: parsed.value.resources.map((resource) => ({
        ...resource,
        context: {
          ...resource.context,
          eventId: `shopify:${input.webhookId}:${resource.resource.kind}:${resource.context.customerReference}`,
        },
      })),
    },
  };
}

async function fetchInitialInventory(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<
    readonly ShopifyCommerceInventoryLevelEnvelope[],
    ShopifyInitialSyncError
  >
> {
  const inventory: ShopifyCommerceInventoryLevelEnvelope[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < SHOPIFY_INITIAL_SYNC_MAX_PAGES; page += 1) {
    const response = await fetchShopifyInitialPage({
      ...input,
      query: SHOPIFY_INITIAL_INVENTORY_QUERY,
      resource: "inventory",
      cursor,
    });
    if (!response.ok) return response;
    const parsed = parseInitialInventoryPage({
      raw: response.value,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) return parsed;
    inventory.push(...parsed.value.items);
    if (!parsed.value.hasNextPage) return { ok: true, value: inventory };
    cursor = parsed.value.endCursor;
    if (cursor === null) return initialInventoryInvalid();
  }
  return initialInventoryInvalid();
}

async function fetchInitialPublications(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError>
> {
  const salesChannels = new Map<string, ShopifyResourceEnvelopeV202607>();
  const offers = new Map<string, ShopifyResourceEnvelopeV202607>();
  let cursor: string | null = null;

  for (let page = 0; page < SHOPIFY_INITIAL_SYNC_MAX_PAGES; page += 1) {
    const response = await fetchShopifyInitialPage({
      ...input,
      query: SHOPIFY_INITIAL_PUBLICATIONS_QUERY,
      resource: "publications",
      cursor,
    });
    if (!response.ok) {
      return response;
    }

    const parsed = parseInitialPublicationsPage({
      raw: response.value,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) {
      return parsed;
    }
    for (const item of parsed.value.items) {
      const target =
        item.resource.kind === "sales_channel" ? salesChannels : offers;
      const identity = item.context.customerReference;
      const existing = target.get(identity);
      if (
        existing !== undefined &&
        JSON.stringify(existing.resource) !== JSON.stringify(item.resource)
      ) {
        return {
          ok: false,
          error: {
            code: "shopify_initial_sync_response_invalid",
            resource: "publications",
          },
        };
      }
      target.set(identity, item);
    }
    if (!parsed.value.hasNextPage) {
      return {
        ok: true,
        value: [...salesChannels.values(), ...offers.values()].sort(
          compareShopifyResourceEnvelope,
        ),
      };
    }
    cursor = parsed.value.endCursor;
    if (cursor === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "publications",
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "publications",
    },
  };
}

function compareShopifyResourceEnvelope(
  left: ShopifyResourceEnvelopeV202607,
  right: ShopifyResourceEnvelopeV202607,
): number {
  return left.context.customerReference.localeCompare(
    right.context.customerReference,
  );
}

async function fetchInitialLocations(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError>
> {
  const locations: ShopifyResourceEnvelopeV202607[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < SHOPIFY_INITIAL_SYNC_MAX_PAGES; page += 1) {
    const response = await fetchShopifyInitialPage({
      ...input,
      query: SHOPIFY_INITIAL_LOCATIONS_QUERY,
      resource: "locations",
      cursor,
    });
    if (!response.ok) {
      return response;
    }

    const parsed = parseInitialLocationsPage({
      raw: response.value,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) {
      return parsed;
    }

    locations.push(...parsed.value.items);
    if (!parsed.value.hasNextPage) {
      return { ok: true, value: locations };
    }
    cursor = parsed.value.endCursor;
    if (cursor === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "locations",
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "locations",
    },
  };
}

async function fetchInitialCatalog(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<readonly ShopifyCommerceCatalogEnvelope[], ShopifyInitialSyncError>
> {
  const products: ShopifyCommerceCatalogEnvelope[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < SHOPIFY_INITIAL_SYNC_MAX_PAGES; page += 1) {
    const response = await fetchShopifyInitialPage({
      ...input,
      query: SHOPIFY_INITIAL_CATALOG_QUERY,
      resource: "catalog",
      cursor,
    });
    if (!response.ok) {
      return response;
    }

    const parsed = parseInitialCatalogPage({
      raw: response.value,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) {
      return parsed;
    }

    products.push(...parsed.value.items);
    if (!parsed.value.hasNextPage) {
      return { ok: true, value: products };
    }
    cursor = parsed.value.endCursor;
    if (cursor === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "catalog",
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "catalog",
    },
  };
}

async function fetchInitialOrders(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly fetcher: typeof fetch;
}): Promise<Result<ShopifyInitialOrdersSnapshot, ShopifyInitialSyncError>> {
  const orders: ShopifyCommerceOrderEnvelope[] = [];
  const resources: ShopifyResourceEnvelopeV202607[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < SHOPIFY_INITIAL_SYNC_MAX_PAGES; page += 1) {
    const response = await fetchShopifyInitialPage({
      ...input,
      query: SHOPIFY_INITIAL_ORDERS_QUERY,
      resource: "orders",
      cursor,
    });
    if (!response.ok) {
      return response;
    }

    const parsed = parseInitialOrdersPage({
      raw: response.value,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) {
      return parsed;
    }

    orders.push(...parsed.value.items.map((item) => item.order));
    resources.push(...parsed.value.items.flatMap((item) => item.resources));
    if (!parsed.value.hasNextPage) {
      return { ok: true, value: { orders, resources } };
    }
    cursor = parsed.value.endCursor;
    if (cursor === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "orders",
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "orders",
    },
  };
}
