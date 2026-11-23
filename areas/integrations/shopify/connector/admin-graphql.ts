import type { ShopifyResourceEnvelopeV202607 } from "@purin-labs/commerce-contracts";
import type { JsonObject } from "@purin-labs/kernel/http";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { errorMessage, isRecord } from "@purin-labs/std";
import type {
  ShopifyInitialSyncError,
  ShopifyWebhookRegistrationError,
} from "../connector";
import { shopifyRevision } from "./values";
import type { ShopifyRegistrationOperation } from "./webhook-registration";

type ShopifyGraphqlRequest = {
  query: string;
  variables: JsonObject;
};

export const SHOPIFY_ADMIN_API_VERSION = "2026-07";

const SHOPIFY_INITIAL_SYNC_PAGE_SIZE = 100;

export const SHOPIFY_INITIAL_SYNC_MAX_PAGES = 100;

export async function fetchShopifyInitialPage(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly cursor: string | null;
  readonly query: string;
  readonly resource:
    "catalog" | "inventory" | "locations" | "orders" | "publications";
  readonly fetcher: typeof fetch;
}): Promise<Result<JsonObject, ShopifyInitialSyncError>> {
  return fetchShopifyGraphqlSnapshot({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    query: input.query,
    variables: {
      first: SHOPIFY_INITIAL_SYNC_PAGE_SIZE,
      after: input.cursor,
    },
    resource: input.resource,
    fetcher: input.fetcher,
  });
}

export async function fetchShopifyGraphqlSnapshot(input: {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly query: string;
  readonly variables: JsonObject;
  readonly resource:
    "catalog" | "inventory" | "locations" | "orders" | "publications";
  readonly fetcher: typeof fetch;
}): Promise<Result<JsonObject, ShopifyInitialSyncError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": input.accessToken,
        },
        body: JSON.stringify({
          query: input.query,
          variables: input.variables,
        }),
      },
    );
  } catch {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_transport_failed",
        resource: input.resource,
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_http_failed",
        resource: input.resource,
        status: response.status,
      },
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: input.resource,
      },
    };
  }

  if (
    !isRecord(raw) ||
    !isRecord(raw.data) ||
    (Array.isArray(raw.errors) && raw.errors.length > 0)
  ) {
    if (isRecord(raw) && Array.isArray(raw.errors)) {
      console.error("shopify.snapshot_graphql_errors", {
        resource: input.resource,
        errors: summarizeShopifyGraphqlErrors(raw.errors),
      });
    }
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: input.resource,
      },
    };
  }

  return { ok: true, value: raw };
}

function summarizeShopifyGraphqlErrors(
  rawErrors: readonly unknown[],
): readonly {
  readonly message: string;
  readonly path: readonly string[];
}[] {
  const summaries: Array<{
    readonly message: string;
    readonly path: readonly string[];
  }> = [];
  for (const rawError of rawErrors.slice(0, 3)) {
    if (!isRecord(rawError) || typeof rawError.message !== "string") continue;
    const path: string[] = [];
    if (Array.isArray(rawError.path)) {
      for (const segment of rawError.path) {
        if (typeof segment === "string" || typeof segment === "number")
          path.push(String(segment));
      }
    }
    summaries.push({ message: rawError.message, path });
  }
  return summaries;
}

export function isUnpaginatedConnection(raw: JsonObject): boolean {
  return isRecord(raw.pageInfo) && raw.pageInfo.hasNextPage === false;
}

export function initialResourceContext(input: {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly occurredAt: string;
  readonly observedAt: number;
  readonly eventId: string;
  readonly customerReference: string;
}): ShopifyResourceEnvelopeV202607["context"] {
  return {
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    revision: shopifyRevision(input.occurredAt),
    occurredAt: input.occurredAt,
    observedAt: new Date(input.observedAt).toISOString(),
    eventId: input.eventId,
    customerReference: input.customerReference,
  };
}

export function parseInitialPageInfo(
  raw: unknown,
): Result<
  { readonly hasNextPage: boolean; readonly endCursor: string | null },
  null
> {
  if (
    !isRecord(raw) ||
    typeof raw.hasNextPage !== "boolean" ||
    (raw.endCursor !== null && typeof raw.endCursor !== "string")
  ) {
    return { ok: false, error: null };
  }
  return {
    ok: true,
    value: { hasNextPage: raw.hasNextPage, endCursor: raw.endCursor },
  };
}

type ShopifyGidResourceType =
  | "Channel"
  | "Fulfillment"
  | "FulfillmentEvent"
  | "Product"
  | "ProductVariant"
  | "InventoryItem"
  | "Location"
  | "Order"
  | "LineItem"
  | "OrderTransaction"
  | "Publication";

export function shopifyGraphqlGid(
  raw: string,
  resourceType: ShopifyGidResourceType,
): string | null {
  const expectedPrefix = `gid://shopify/${resourceType}/`;
  return raw.startsWith(expectedPrefix) &&
    /^[0-9]+$/u.test(raw.slice(expectedPrefix.length))
    ? raw
    : null;
}

export function shopifyRestGid(
  raw: unknown,
  resourceType: ShopifyGidResourceType,
): string | null {
  if (typeof raw === "string") {
    if (raw.startsWith("gid://shopify/")) {
      return shopifyGraphqlGid(raw, resourceType);
    }
    return /^[0-9]+$/u.test(raw)
      ? `gid://shopify/${resourceType}/${raw}`
      : null;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return null;
  }
  return `gid://shopify/${resourceType}/${raw}`;
}

export async function sendShopifyAdminGraphql(
  input: {
    shopDomain: string;
    accessToken: string;
    fetcher: typeof fetch;
  },
  operation: ShopifyRegistrationOperation,
  request: ShopifyGraphqlRequest,
): Promise<Result<unknown, ShopifyWebhookRegistrationError>> {
  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": input.accessToken,
        },
        body: JSON.stringify(request),
      },
    );
  } catch (error) {
    console.error("shopify.webhook_registration_transport_failed", {
      operation,
      error: errorMessage(error),
    });
    return {
      ok: false,
      error: { code: "shopify_registration_transport_failed", operation },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "shopify_registration_failed",
        operation,
        status: response.status,
      },
    };
  }

  let raw: unknown;

  try {
    raw = await response.json();
  } catch {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation },
    };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation },
    };
  }

  if (Array.isArray(raw.errors) && raw.errors.length > 0) {
    return {
      ok: false,
      error: { code: "shopify_registration_graphql_error", operation },
    };
  }

  return { ok: true, value: raw };
}
