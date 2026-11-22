import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import type { CanonicalCommerceDelivery } from "@purin-labs/commerce-contracts";
import { listLiveProviderWebhookContexts } from "../../data/integration-account";
import type { JsonObject } from "@purin-labs/kernel/http";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  ShopifyCueEvent,
  ShopifyInventoryLevelUpdatedCueEvent,
  ShopifyOrderCreatedCueEvent,
} from "../../cues/engine";
import { resolveProviderWebhookCredential } from "../../credential-vault";
import { decodeBase64, isRecord } from "@purin-labs/std";
import type {
  ShopifyCommerceCatalogEnvelope,
  ShopifyCommerceInventoryLevelEnvelope,
  ShopifyCommerceRefreshTarget,
  ShopifyWebhookError,
  ShopifyWebhookHeaders,
  ShopifyWebhookSecret,
} from "../connector";
import { SHOPIFY_ADMIN_API_VERSION, shopifyRestGid } from "./admin-graphql";
import {
  decimalToMinorUnits,
  normalizedShopifyTimestamp,
  nullableSafeInteger,
  nullableString,
  providerId,
  safeSignedInteger,
  shopifyProductDescription,
  shopifyRevision,
  validShopDomain,
} from "./values";

export async function resolveShopifyWebhookSecret(
  env: Env,
  scope: OrganisationExecutionScope,
  shopDomain: string,
): Promise<Result<ShopifyWebhookSecret, ShopifyWebhookError>> {
  const organisationId = scope.organisationId;
  const contexts = await listLiveProviderWebhookContexts({
    db: scope.database,
    organisationId,
    provider: "shopify",
    providerAccountId: shopDomain,
  });
  const contextsByBinding = new Map<string, (typeof contexts)[number]>();

  for (const context of contexts) {
    contextsByBinding.set(
      `${context.integrationAccountId}:${context.signingSecretRef}`,
      context,
    );
  }

  if (contextsByBinding.size === 0) {
    return { ok: false, error: { code: "shopify_connector_missing" } };
  }

  if (contextsByBinding.size !== 1) {
    return { ok: false, error: { code: "shopify_connector_ambiguous" } };
  }

  const context = contextsByBinding.values().next().value;

  if (context === undefined) {
    throw new Error("Shopify webhook account cardinality invariant failed");
  }

  const secret = await resolveProviderWebhookCredential({
    db: scope.database,
    keys: env,
    organisationId,
    provider: "shopify",
    context,
  });

  if (!secret.ok) {
    if (secret.error.code === "webhook_binding_inactive") {
      return { ok: false, error: { code: "shopify_connector_inactive" } };
    }

    return { ok: false, error: secret.error };
  }

  return secret.value.kind === "header" &&
    secret.value.header === "x-shopify-hmac-sha256" &&
    secret.value.value.length > 0
    ? {
        ok: true,
        value: {
          integrationAccountId: context.integrationAccountId,
          signingSecret: secret.value.value,
        },
      }
    : { ok: false, error: { code: "shopify_webhook_secret_invalid" } };
}

export async function verifyShopifyWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  signingSecret: string;
}): Promise<Result<null, ShopifyWebhookError>> {
  if (input.signatureHeader === null) {
    return { ok: false, error: { code: "shopify_signature_missing" } };
  }

  const provided = decodeBase64(input.signatureHeader);

  if (provided === null) {
    return { ok: false, error: { code: "shopify_signature_invalid" } };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computed = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(input.rawBody),
    ),
  );
  return constantTimeBytesEqual(provided, computed)
    ? { ok: true, value: null }
    : { ok: false, error: { code: "shopify_signature_invalid" } };
}

export function parseShopifyCueEvent(input: {
  rawBody: string;
  headers: ShopifyWebhookHeaders;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  receivedAt: number;
}): Result<ShopifyCueEvent, ShopifyWebhookError> {
  const body = parseShopifyWebhookBody(input.rawBody);

  if (!body.ok) {
    return body;
  }

  return parseShopifyCueEventBody({
    body: body.value,
    headers: input.headers,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    receivedAt: input.receivedAt,
  });
}

export function parseShopifyCueEventBody(input: {
  body: JsonObject;
  headers: ShopifyWebhookHeaders;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  receivedAt: number;
}): Result<ShopifyCueEvent, ShopifyWebhookError> {
  if (
    input.headers.webhookId === null ||
    input.headers.webhookId.length === 0 ||
    !validShopDomain(input.headers.shopDomain)
  ) {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }

  const at = parseTriggeredAt(input.headers.triggeredAt, input.receivedAt);

  switch (input.headers.topic) {
    case "orders/create":
      return parseShopifyOrderCreated(
        input.body,
        input.organisationId,
        input.integrationAccountId,
        input.headers.webhookId,
        at,
      );
    case "inventory_levels/update":
      return parseShopifyInventoryUpdated(
        input.body,
        input.organisationId,
        input.integrationAccountId,
        input.headers.webhookId,
        at,
      );
    default:
      return { ok: false, error: { code: "shopify_event_unsupported" } };
  }
}

export function parseShopifyCommerceRefreshTarget(input: {
  readonly body: JsonObject;
  readonly headers: ShopifyWebhookHeaders;
}): Result<ShopifyCommerceRefreshTarget, ShopifyWebhookError> {
  if (
    (input.headers.topic !== "orders/create" &&
      input.headers.topic !== "orders/updated") ||
    input.headers.webhookId === null ||
    !validShopDomain(input.headers.shopDomain)
  ) {
    return { ok: false, error: { code: "shopify_event_unsupported" } };
  }
  const orderGid = shopifyRestGid(input.body.id, "Order");
  return orderGid === null
    ? { ok: false, error: { code: "shopify_event_invalid" } }
    : { ok: true, value: { kind: "order", orderGid } };
}

export function parseShopifyCommerceProductDeletionBody(input: {
  readonly body: JsonObject;
  readonly headers: ShopifyWebhookHeaders;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly receivedAt: number;
}): Result<CanonicalCommerceDelivery, ShopifyWebhookError> {
  if (
    input.headers.topic !== "products/delete" ||
    input.headers.webhookId === null ||
    !validShopDomain(input.headers.shopDomain)
  ) {
    return { ok: false, error: { code: "shopify_event_unsupported" } };
  }
  const productGid = shopifyRestGid(input.body.id, "Product");
  if (productGid === null) {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }
  const observedAt = new Date(input.receivedAt).toISOString();
  const occurredAt = normalizedShopifyTimestamp(
    input.headers.triggeredAt,
    observedAt,
  );
  const revision = shopifyRevision(occurredAt);
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      providerDeliveryId: `shopify:${input.headers.webhookId}`,
      observations: [
        {
          kind: "delete",
          observationId: `shopify:${input.headers.webhookId}:product:${productGid}:${revision}`,
          provenance: {
            organisationId: input.organisationId,
            integrationAccountId: input.integrationAccountId,
            source: "shopify",
            resourceType: "product",
            resourceId: productGid,
            revision,
            occurredAt,
            observedAt,
          },
        },
      ],
    },
  };
}

export function parseShopifyCommerceInventoryLevelEnvelopeBody(input: {
  body: JsonObject;
  headers: ShopifyWebhookHeaders;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  receivedAt: number;
}): Result<ShopifyCommerceInventoryLevelEnvelope, ShopifyWebhookError> {
  if (
    input.headers.topic !== "inventory_levels/update" ||
    input.headers.webhookId === null ||
    !validShopDomain(input.headers.shopDomain)
  ) {
    return { ok: false, error: { code: "shopify_event_unsupported" } };
  }

  const inventoryItemId = shopifyRestGid(
    input.body.inventory_item_id,
    "InventoryItem",
  );
  const locationId = shopifyRestGid(input.body.location_id, "Location");
  const available = safeSignedInteger(input.body.available);
  if (inventoryItemId === null || locationId === null || available === null) {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }

  const observedAt = new Date(input.receivedAt).toISOString();
  const occurredAt = normalizedShopifyTimestamp(
    input.body.updated_at,
    observedAt,
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
        observedAt,
        eventId: `shopify:${input.headers.webhookId}`,
        customerReference: `shopify-inventory-${inventoryItemId}-${locationId}`,
      },
      inventoryItemId,
      locationId,
      available,
      updatedAt: occurredAt,
    },
  };
}

export function parseShopifyCommerceCatalogEnvelopeBody(input: {
  body: JsonObject;
  headers: ShopifyWebhookHeaders;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  receivedAt: number;
}): Result<ShopifyCommerceCatalogEnvelope, ShopifyWebhookError> {
  if (
    (input.headers.topic !== "products/create" &&
      input.headers.topic !== "products/update") ||
    input.headers.webhookId === null ||
    !validShopDomain(input.headers.shopDomain)
  ) {
    return { ok: false, error: { code: "shopify_event_unsupported" } };
  }

  const id = shopifyRestGid(input.body.id, "Product");
  const title =
    typeof input.body.title === "string" && input.body.title.length > 0
      ? input.body.title
      : null;
  const variants = parseShopifyCommerceCatalogVariants(
    input.body.variants,
    input.body,
  );

  if (id === null || title === null || variants === null) {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }

  const observedAt = new Date(input.receivedAt).toISOString();
  const occurredAt = normalizedShopifyTimestamp(
    input.body.updated_at ?? input.body.created_at,
    observedAt,
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
        observedAt,
        eventId: `shopify:${input.headers.webhookId}`,
        customerReference: `shopify-product-${id}`,
      },
      product: {
        id,
        title,
        description: shopifyProductDescription(input.body),
        variants,
      },
    },
  };
}

function parseShopifyCommerceCatalogVariants(
  raw: unknown,
  product: JsonObject,
): ShopifyCommerceCatalogEnvelope["product"]["variants"] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const variants: Array<
    ShopifyCommerceCatalogEnvelope["product"]["variants"][number]
  > = [];

  for (const entry of raw) {
    if (!isRecord(entry)) {
      return null;
    }

    const id = shopifyRestGid(entry.id, "ProductVariant");
    const title =
      typeof entry.title === "string" && entry.title.length > 0
        ? entry.title
        : null;
    const inventoryItemId = shopifyRestGid(
      entry.inventory_item_id,
      "InventoryItem",
    );
    const sku =
      typeof entry.sku === "string" && entry.sku.length > 0 ? entry.sku : null;
    if (id === null || inventoryItemId === null || title === null) {
      return null;
    }
    if (sku === null) continue;

    variants.push({ id, inventoryItemId, sku, title });
  }

  return variants;
}

function parseShopifyOrderCreated(
  body: JsonObject,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  nativeId: string,
  at: number,
): Result<ShopifyOrderCreatedCueEvent, ShopifyWebhookError> {
  const orderId = providerId(body.id);
  const totalPriceMinor =
    typeof body.total_price === "string" && typeof body.currency === "string"
      ? decimalToMinorUnits(body.total_price, body.currency)
      : null;

  if (
    orderId === null ||
    typeof body.name !== "string" ||
    totalPriceMinor === null ||
    typeof body.currency !== "string" ||
    !nullableString(body.financial_status)
  ) {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }

  return {
    ok: true,
    value: {
      organisationId,
      integrationAccountId,
      source: "shopify",
      nativeId,
      eventType: "orders/create",
      payload: {
        orderId,
        orderName: body.name,
        totalPriceMinor,
        currency: body.currency,
        financialStatus: body.financial_status,
      },
      at,
    },
  };
}

function parseShopifyInventoryUpdated(
  body: JsonObject,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  nativeId: string,
  at: number,
): Result<ShopifyInventoryLevelUpdatedCueEvent, ShopifyWebhookError> {
  const inventoryItemId = providerId(body.inventory_item_id);
  const locationId = providerId(body.location_id);

  if (
    inventoryItemId === null ||
    locationId === null ||
    !nullableSafeInteger(body.available) ||
    !nullableString(body.updated_at)
  ) {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }

  return {
    ok: true,
    value: {
      organisationId,
      integrationAccountId,
      source: "shopify",
      nativeId,
      eventType: "inventory_levels/update",
      payload: {
        inventoryItemId,
        locationId,
        available: body.available,
        updatedAt: body.updated_at,
      },
      at,
    },
  };
}

export function parseShopifyWebhookBody(
  rawBody: string,
): Result<JsonObject, ShopifyWebhookError> {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isRecord(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, error: { code: "shopify_event_invalid" } };
  } catch {
    return { ok: false, error: { code: "shopify_event_invalid" } };
  }
}

function parseTriggeredAt(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }

  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}
