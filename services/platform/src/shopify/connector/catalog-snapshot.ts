import type { ShopifyResourceEnvelopeV202607 } from "@seams/contracts";
import type { JsonObject } from "../../http";
import type { IntegrationAccountId, OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { isRecord } from "@seams/std";
import type {
  ShopifyCommerceCatalogEnvelope,
  ShopifyCommerceInventoryLevelEnvelope,
  ShopifyInitialSyncError,
} from "../connector";
import {
  SHOPIFY_ADMIN_API_VERSION,
  initialResourceContext,
  parseInitialPageInfo,
  shopifyGraphqlGid,
} from "./admin-graphql";
import {
  normalizedShopifyTimestamp,
  safeSignedInteger,
  shopifyRevision,
} from "./values";

export function parseInitialCatalogPage(input: {
  readonly raw: JsonObject;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  {
    readonly items: readonly ShopifyCommerceCatalogEnvelope[];
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  },
  ShopifyInitialSyncError
> {
  const connection = input.raw.data;
  if (
    !isRecord(connection) ||
    !isRecord(connection.products) ||
    !Array.isArray(connection.products.nodes)
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "catalog",
      },
    };
  }
  const pageInfo = parseInitialPageInfo(connection.products.pageInfo);
  if (!pageInfo.ok) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "catalog",
      },
    };
  }

  const items: ShopifyCommerceCatalogEnvelope[] = [];
  for (const node of connection.products.nodes) {
    const item = parseInitialCatalogProduct({
      raw: node,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }

  return { ok: true, value: { items, ...pageInfo.value } };
}

export function parseInitialCatalogProduct(input: {
  readonly raw: unknown;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<ShopifyCommerceCatalogEnvelope, ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    typeof input.raw.title !== "string" ||
    typeof input.raw.updatedAt !== "string" ||
    !isRecord(input.raw.variants) ||
    !Array.isArray(input.raw.variants.nodes)
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "catalog",
      },
    };
  }

  const id = shopifyGraphqlGid(input.raw.id, "Product");
  if (id === null) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "catalog",
      },
    };
  }
  const occurredAt = normalizedShopifyTimestamp(
    input.raw.updatedAt,
    new Date(input.observedAt).toISOString(),
  );
  const variants: Array<
    ShopifyCommerceCatalogEnvelope["product"]["variants"][number]
  > = [];
  for (const rawVariant of input.raw.variants.nodes) {
    if (
      !isRecord(rawVariant) ||
      typeof rawVariant.id !== "string" ||
      typeof rawVariant.title !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "catalog",
        },
      };
    }
    const variantId = shopifyGraphqlGid(rawVariant.id, "ProductVariant");
    const inventoryItemId =
      isRecord(rawVariant.inventoryItem) &&
      typeof rawVariant.inventoryItem.id === "string"
        ? shopifyGraphqlGid(rawVariant.inventoryItem.id, "InventoryItem")
        : null;
    if (variantId === null || inventoryItemId === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "catalog",
        },
      };
    }
    const sku =
      typeof rawVariant.sku === "string" && rawVariant.sku.length > 0
        ? rawVariant.sku
        : null;
    if (sku === null) continue;
    variants.push({
      id: variantId,
      inventoryItemId,
      sku,
      title: rawVariant.title,
    });
  }
  return {
    ok: true,
    value: {
      apiVersion: SHOPIFY_ADMIN_API_VERSION,
      context: {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        revision: shopifyRevision(occurredAt),
        occurredAt,
        observedAt: new Date(input.observedAt).toISOString(),
        eventId: `shopify:initial:product:${id}`,
        customerReference: `shopify-product-${id}`,
      },
      product: {
        id,
        title: input.raw.title,
        description:
          typeof input.raw.descriptionHtml === "string"
            ? input.raw.descriptionHtml
            : "",
        variants,
      },
    },
  };
}

export function parseInitialInventoryPage(input: {
  readonly raw: JsonObject;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  {
    readonly items: readonly ShopifyCommerceInventoryLevelEnvelope[];
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  },
  ShopifyInitialSyncError
> {
  const data = input.raw.data;
  if (
    !isRecord(data) ||
    !isRecord(data.inventoryItems) ||
    !Array.isArray(data.inventoryItems.nodes)
  ) {
    return initialInventoryInvalid();
  }
  const pageInfo = parseInitialPageInfo(data.inventoryItems.pageInfo);
  if (!pageInfo.ok) return initialInventoryInvalid();
  const items: ShopifyCommerceInventoryLevelEnvelope[] = [];
  for (const raw of data.inventoryItems.nodes) {
    const parsed = parseInitialInventoryItem({ ...input, raw });
    if (!parsed.ok) return parsed;
    items.push(...parsed.value);
  }
  return { ok: true, value: { items, ...pageInfo.value } };
}

export function parseInitialInventoryItem(input: {
  readonly raw: unknown;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  readonly ShopifyCommerceInventoryLevelEnvelope[],
  ShopifyInitialSyncError
> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    !isRecord(input.raw.inventoryLevels) ||
    !Array.isArray(input.raw.inventoryLevels.nodes) ||
    !isRecord(input.raw.inventoryLevels.pageInfo) ||
    input.raw.inventoryLevels.pageInfo.hasNextPage !== false
  ) {
    return initialInventoryInvalid();
  }
  const inventoryItemId = shopifyGraphqlGid(input.raw.id, "InventoryItem");
  if (inventoryItemId === null) return initialInventoryInvalid();
  if (typeof input.raw.sku !== "string" || input.raw.sku.length === 0) {
    return { ok: true, value: [] };
  }
  const levels: ShopifyCommerceInventoryLevelEnvelope[] = [];
  for (const rawLevel of input.raw.inventoryLevels.nodes) {
    const parsed = parseInitialInventoryLevel({
      ...input,
      raw: rawLevel,
      inventoryItemId,
    });
    if (!parsed.ok) return parsed;
    levels.push(parsed.value);
  }
  return { ok: true, value: levels };
}

export function parseInitialInventoryLevel(input: {
  readonly raw: unknown;
  readonly inventoryItemId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<ShopifyCommerceInventoryLevelEnvelope, ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    !isRecord(input.raw.location) ||
    typeof input.raw.location.id !== "string" ||
    typeof input.raw.updatedAt !== "string" ||
    !Array.isArray(input.raw.quantities)
  ) {
    return initialInventoryInvalid();
  }
  const locationId = shopifyGraphqlGid(input.raw.location.id, "Location");
  const available = input.raw.quantities.filter(
    (quantity) => isRecord(quantity) && quantity.name === "available",
  );
  if (
    locationId === null ||
    available.length !== 1 ||
    !isRecord(available[0])
  ) {
    return initialInventoryInvalid();
  }
  const quantity = safeSignedInteger(available[0].quantity);
  if (quantity === null) return initialInventoryInvalid();
  const observedAt = new Date(input.observedAt).toISOString();
  const updatedAt = normalizedShopifyTimestamp(input.raw.updatedAt, observedAt);
  return {
    ok: true,
    value: {
      apiVersion: SHOPIFY_ADMIN_API_VERSION,
      context: {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        revision: shopifyRevision(updatedAt),
        occurredAt: updatedAt,
        observedAt,
        eventId: `shopify:initial:inventory-level:${input.inventoryItemId}:${locationId}:${input.observedAt}`,
        customerReference: `shopify-inventory-${input.inventoryItemId}-${locationId}`,
      },
      inventoryItemId: input.inventoryItemId,
      locationId,
      available: quantity,
      updatedAt,
    },
  };
}

export function initialInventoryInvalid(): Result<
  never,
  ShopifyInitialSyncError
> {
  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "inventory",
    },
  };
}

export function parseInitialPublicationsPage(input: {
  readonly raw: JsonObject;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  {
    readonly items: readonly ShopifyResourceEnvelopeV202607[];
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  },
  ShopifyInitialSyncError
> {
  const data = input.raw.data;
  if (
    !isRecord(data) ||
    !isRecord(data.products) ||
    !Array.isArray(data.products.nodes)
  ) {
    return publicationSyncInvalid("products_connection_invalid");
  }
  const pageInfo = parseInitialPageInfo(data.products.pageInfo);
  if (!pageInfo.ok) {
    return publicationSyncInvalid("products_page_info_invalid");
  }

  const items: ShopifyResourceEnvelopeV202607[] = [];
  for (const product of data.products.nodes) {
    const parsed = parseInitialPublicationProduct({
      raw: product,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) {
      return parsed;
    }
    items.push(...parsed.value);
  }
  return { ok: true, value: { items, ...pageInfo.value } };
}

export function parseInitialPublicationProduct(input: {
  readonly raw: unknown;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    typeof input.raw.updatedAt !== "string" ||
    !isRecord(input.raw.priceRangeV2) ||
    !isRecord(input.raw.priceRangeV2.minVariantPrice) ||
    typeof input.raw.priceRangeV2.minVariantPrice.currencyCode !== "string" ||
    !isRecord(input.raw.variants) ||
    !Array.isArray(input.raw.variants.nodes) ||
    !isRecord(input.raw.variants.pageInfo) ||
    input.raw.variants.pageInfo.hasNextPage !== false ||
    !isRecord(input.raw.resourcePublicationsV2) ||
    !Array.isArray(input.raw.resourcePublicationsV2.nodes) ||
    !isRecord(input.raw.resourcePublicationsV2.pageInfo) ||
    input.raw.resourcePublicationsV2.pageInfo.hasNextPage !== false
  ) {
    return publicationSyncInvalid("product_shape_or_nested_pagination_invalid");
  }
  if (shopifyGraphqlGid(input.raw.id, "Product") === null) {
    return publicationSyncInvalid("product_gid_invalid");
  }
  const currency =
    input.raw.priceRangeV2.minVariantPrice.currencyCode.toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    return publicationSyncInvalid("product_currency_invalid");
  }

  const variants = parseInitialPublicationVariants(input.raw.variants.nodes);
  if (!variants.ok) {
    return variants;
  }
  const productUpdatedAt = normalizedShopifyTimestamp(
    input.raw.updatedAt,
    new Date(input.observedAt).toISOString(),
  );
  const items: ShopifyResourceEnvelopeV202607[] = [];
  for (const publicationRecord of input.raw.resourcePublicationsV2.nodes) {
    const parsed = parseOnlineStorePublication({
      raw: publicationRecord,
      variants: variants.value,
      currency,
      productUpdatedAt,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) {
      return parsed;
    }
    items.push(...parsed.value);
  }
  return { ok: true, value: items };
}

export type ShopifyPublicationVariant = {
  readonly id: string;
  readonly sku: string;
  readonly price: string;
  readonly availableForSale: boolean;
};

export function parseInitialPublicationVariants(
  rawVariants: readonly unknown[],
): Result<readonly ShopifyPublicationVariant[], ShopifyInitialSyncError> {
  const variants: ShopifyPublicationVariant[] = [];
  for (const raw of rawVariants) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      (raw.sku !== null && typeof raw.sku !== "string") ||
      typeof raw.price !== "string" ||
      typeof raw.availableForSale !== "boolean"
    ) {
      return publicationSyncInvalid("variant_shape_invalid");
    }
    const id = shopifyGraphqlGid(raw.id, "ProductVariant");
    if (id === null) {
      return publicationSyncInvalid("variant_gid_invalid");
    }
    if (raw.sku === null || raw.sku.length === 0) continue;
    variants.push({
      id,
      sku: raw.sku,
      price: raw.price,
      availableForSale: raw.availableForSale,
    });
  }
  return { ok: true, value: variants };
}

export function parseOnlineStorePublication(input: {
  readonly raw: unknown;
  readonly variants: readonly ShopifyPublicationVariant[];
  readonly currency: string;
  readonly productUpdatedAt: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.isPublished !== "boolean" ||
    (input.raw.publishDate !== null &&
      typeof input.raw.publishDate !== "string") ||
    !isRecord(input.raw.publication) ||
    typeof input.raw.publication.id !== "string" ||
    typeof input.raw.publication.supportsFuturePublishing !== "boolean"
  ) {
    return publicationSyncInvalid("publication_record_shape_invalid");
  }

  if (!input.raw.publication.supportsFuturePublishing) {
    return { ok: true, value: [] };
  }
  if (
    !isRecord(input.raw.publication.channels) ||
    !Array.isArray(input.raw.publication.channels.nodes) ||
    !isRecord(input.raw.publication.channels.pageInfo) ||
    typeof input.raw.publication.channels.pageInfo.hasNextPage !== "boolean"
  ) {
    return { ok: true, value: [] };
  }
  if (
    input.raw.publication.channels.pageInfo.hasNextPage ||
    input.raw.publication.channels.nodes.length !== 1
  ) {
    return { ok: true, value: [] };
  }
  const publicationId = shopifyGraphqlGid(
    input.raw.publication.id,
    "Publication",
  );
  const channel = input.raw.publication.channels.nodes[0];
  if (
    publicationId === null ||
    !isRecord(channel) ||
    typeof channel.id !== "string" ||
    typeof channel.name !== "string" ||
    channel.name.length === 0 ||
    typeof channel.handle !== "string" ||
    channel.handle.length === 0 ||
    shopifyGraphqlGid(channel.id, "Channel") === null
  ) {
    return publicationSyncInvalid("publication_channel_invalid");
  }

  const observedAt = new Date(input.observedAt).toISOString();
  const salesChannel = createInitialShopifyResourceEnvelope({
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    occurredAt: observedAt,
    observedAt: input.observedAt,
    eventId: `shopify:initial:sales-channel:${publicationId}:${input.observedAt}`,
    customerReference: `shopify-sales-channel-${publicationId}`,
    resource: {
      kind: "sales_channel",
      resource: {
        id: publicationId,
        name: channel.name,
        kind: "online",
        active: true,
        updatedAt: observedAt,
      },
    },
  });

  const isPublished = input.raw.isPublished;
  const lifecycleAt = normalizedShopifyTimestamp(
    input.raw.publishDate,
    input.productUpdatedAt,
  );
  const offers: ShopifyResourceEnvelopeV202607[] = [];
  for (const variant of input.variants) {
    offers.push(
      createInitialShopifyOffer({
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        observedAt: input.observedAt,
        productUpdatedAt: input.productUpdatedAt,
        publicationId,
        variant,
        currency: input.currency,
        isPublished,
        lifecycleAt,
      }),
    );
  }
  return { ok: true, value: [salesChannel, ...offers] };
}

export function createInitialShopifyOffer(input: {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly productUpdatedAt: string;
  readonly publicationId: string;
  readonly variant: ShopifyPublicationVariant;
  readonly currency: string;
  readonly isPublished: boolean;
  readonly lifecycleAt: string;
}): ShopifyResourceEnvelopeV202607 {
  return createInitialShopifyResourceEnvelope({
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    occurredAt: input.productUpdatedAt,
    observedAt: input.observedAt,
    eventId: `shopify:initial:offer:${input.variant.id}:${input.publicationId}:${input.observedAt}`,
    customerReference: `shopify-offer-${input.variant.id}-${input.publicationId}`,
    resource: {
      kind: "offer",
      resource: {
        variantGid: input.variant.id,
        publicationGid: input.publicationId,
        price: input.variant.price,
        currency: input.currency,
        available: input.isPublished && input.variant.availableForSale,
        lifecycle: input.isPublished
          ? { state: "listed", listedAt: input.lifecycleAt }
          : { state: "prepared", preparedAt: input.lifecycleAt },
        updatedAt: input.productUpdatedAt,
      },
    },
  });
}

export function createInitialShopifyResourceEnvelope(input: {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly occurredAt: string;
  readonly observedAt: number;
  readonly eventId: string;
  readonly customerReference: string;
  readonly resource: ShopifyResourceEnvelopeV202607["resource"];
}): ShopifyResourceEnvelopeV202607 {
  return {
    apiVersion: SHOPIFY_ADMIN_API_VERSION,
    context: initialResourceContext(input),
    resource: input.resource,
  };
}

export function publicationSyncInvalid(
  reason: string,
): Result<never, ShopifyInitialSyncError> {
  console.error("shopify.publication_snapshot_rejected", { reason });
  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "publications",
    },
  };
}

export function parseInitialLocationsPage(input: {
  readonly raw: JsonObject;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  {
    readonly items: readonly ShopifyResourceEnvelopeV202607[];
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  },
  ShopifyInitialSyncError
> {
  const connection = input.raw.data;
  if (
    !isRecord(connection) ||
    !isRecord(connection.locations) ||
    !Array.isArray(connection.locations.nodes)
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "locations",
      },
    };
  }
  const pageInfo = parseInitialPageInfo(connection.locations.pageInfo);
  if (!pageInfo.ok) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "locations",
      },
    };
  }

  const items: ShopifyResourceEnvelopeV202607[] = [];
  for (const node of connection.locations.nodes) {
    const item = parseInitialLocation({
      raw: node,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }

  return { ok: true, value: { items, ...pageInfo.value } };
}

export function parseInitialLocation(input: {
  readonly raw: unknown;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<ShopifyResourceEnvelopeV202607, ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    typeof input.raw.name !== "string" ||
    typeof input.raw.isActive !== "boolean" ||
    typeof input.raw.updatedAt !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "locations",
      },
    };
  }

  const id = shopifyGraphqlGid(input.raw.id, "Location");
  if (id === null) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "locations",
      },
    };
  }
  const occurredAt = normalizedShopifyTimestamp(
    input.raw.updatedAt,
    new Date(input.observedAt).toISOString(),
  );

  return {
    ok: true,
    value: {
      apiVersion: SHOPIFY_ADMIN_API_VERSION,
      context: {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        revision: shopifyRevision(occurredAt),
        occurredAt,
        observedAt: new Date(input.observedAt).toISOString(),
        eventId: `shopify:initial:location:${id}`,
        customerReference: `shopify-location-${id}`,
      },
      resource: {
        kind: "location",
        resource: {
          id,
          name: input.raw.name,
          classification: { state: "pending" },
          active: input.raw.isActive,
          updatedAt: occurredAt,
        },
      },
    },
  };
}
