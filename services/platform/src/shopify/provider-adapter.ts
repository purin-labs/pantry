import { isShopifyAdminDomain } from "./auth";
import type { Result } from "@purin-labs/kernel/result";
import { configuredValue, SHORT_PROVIDER_STATE_TTL_MS } from "../provider-adapters/authorization";
import {
  providerHttpFailure,
  type ProviderCleanupAdapter,
  type ProviderCleanupResult,
  type ProviderOnboardingAdapter,
} from "../integrations/contract/provider-adapter";
import { bytesToHex, isRecord } from "@purin-labs/std";

const MANUAL_INSTRUCTION = "remove_shopify_app_in_shopify" as const;
const SHOPIFY_SCOPES = [
  "read_inventory",
  "read_orders",
  "read_products",
  "read_publications",
  "write_inventory",
  "write_orders",
] as const;

type ShopifyProtocolError =
  | { readonly code: "provider_oauth_response_invalid" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
      readonly requestId: string | null;
    };

type ShopifyAuthorizationGrant = {
  readonly accessToken: string;
  readonly scopes: readonly string[];
};

type ShopifyIdentity = {
  readonly shopId: string;
  readonly myshopifyDomain: string;
  readonly displayName: string;
  readonly planDisplayName: string;
  readonly environment: "development" | "production";
};

export const shopifyCleanupAdapter: ProviderCleanupAdapter<"shopify"> = {
  provider: "shopify",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: uninstallShopifyApplication,
};

export const shopifyOnboardingAdapter: ProviderOnboardingAdapter<"shopify"> = {
  provider: "shopify",
  requiredScopes: SHOPIFY_SCOPES,
  stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseShopifyStartContext,
  configurationIsValid: shopifyConfigurationIsValid,
  authorizationSecret: shopifyAuthorizationSecret,
  authorizationUrl: shopifyAuthorizationUrl,
  scopeIsGranted: shopifyScopeIsGranted,
};

function parseShopifyStartContext(
  raw: unknown,
): { readonly provider: "shopify"; readonly shopDomain: string } | null {
  return isRecord(raw) &&
    raw.provider === "shopify" &&
    typeof raw.shopDomain === "string" &&
    isShopifyAdminDomain(raw.shopDomain)
    ? { provider: "shopify", shopDomain: raw.shopDomain }
    : null;
}

export async function exchangeShopifyAuthorizationCode(
  input: Readonly<{
    shopDomain: string;
    clientId: string;
    clientSecret: string;
    code: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<ShopifyAuthorizationGrant, ShopifyProtocolError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.shopDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
        }),
      },
    );
  } catch {
    return exchangeFailure(503, null);
  }
  if (!response.ok) {
    return exchangeFailure(response.status, response.headers.get("request-id"));
  }
  return parseShopifyToken(await readJson(response));
}

export async function verifyShopifyCallback(
  url: URL,
  clientSecret: string,
): Promise<boolean> {
  const supplied = url.searchParams.get("hmac");
  if (supplied === null || !/^[a-f0-9]{64}$/u.test(supplied)) return false;
  const pairs: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "hmac")
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  pairs.sort();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(pairs.join("&")),
  );
  return timingSafeHexEqual(supplied, bytesToHex(new Uint8Array(signature)));
}

export async function discoverShopifyIdentity(
  input: Readonly<{
    fetcher: typeof fetch;
    shopDomain: string;
    accessToken: string;
  }>,
): Promise<Result<ShopifyIdentity, ShopifyProtocolError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.shopDomain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": input.accessToken,
        },
        body: JSON.stringify({
          query:
            "query PantryOnboardingShop { shop { id name myshopifyDomain plan { displayName partnerDevelopment } } }",
        }),
      },
    );
  } catch {
    return exchangeFailure(502, null);
  }
  if (!response.ok) {
    return exchangeFailure(
      response.status,
      response.headers.get("x-request-id"),
    );
  }
  return parseShopifyIdentityResponse(await readJson(response));
}

export function parseShopifyIdentityResponse(
  raw: unknown,
): Result<ShopifyIdentity, ShopifyProtocolError> {
  if (
    !isRecord(raw) ||
    !isRecord(raw.data) ||
    !isRecord(raw.data.shop) ||
    !isRecord(raw.data.shop.plan) ||
    typeof raw.data.shop.id !== "string" ||
    typeof raw.data.shop.name !== "string" ||
    typeof raw.data.shop.myshopifyDomain !== "string" ||
    typeof raw.data.shop.plan.displayName !== "string" ||
    typeof raw.data.shop.plan.partnerDevelopment !== "boolean" ||
    !isShopifyAdminDomain(raw.data.shop.myshopifyDomain)
  ) {
    return invalidResponse();
  }
  return {
    ok: true,
    value: {
      shopId: raw.data.shop.id,
      myshopifyDomain: raw.data.shop.myshopifyDomain,
      displayName: raw.data.shop.name,
      planDisplayName: raw.data.shop.plan.displayName,
      environment: raw.data.shop.plan.partnerDevelopment
        ? "development"
        : "production",
    },
  };
}

function shopifyConfigurationIsValid(
  env: Parameters<typeof shopifyAuthorizationSecret>[0],
): boolean {
  return (
    configuredValue(env.SHOPIFY_CLIENT_ID) !== null &&
    shopifyAuthorizationSecret(env) !== null
  );
}

function shopifyAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"shopify">["configurationIsValid"]
  >[0],
): string | null {
  return configuredValue(env.SHOPIFY_CLIENT_SECRET);
}

async function shopifyAuthorizationUrl(
  input: Parameters<
    ProviderOnboardingAdapter<"shopify">["authorizationUrl"]
  >[0],
): Promise<string> {
  if (!isShopifyAdminDomain(input.context.shopDomain)) {
    throw new Error("Shopify shop domain is invalid");
  }
  const url = new URL(
    `https://${input.context.shopDomain}/admin/oauth/authorize`,
  );
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

function shopifyScopeIsGranted(
  requiredScope: string,
  grantedScopes: ReadonlySet<string>,
): boolean {
  if (grantedScopes.has(requiredScope)) return true;
  switch (requiredScope) {
    case "read_inventory":
      return grantedScopes.has("write_inventory");
    case "read_orders":
      return grantedScopes.has("write_orders");
    case "read_products":
      return grantedScopes.has("write_products");
    default:
      return false;
  }
}

async function uninstallShopifyApplication(
  input: Parameters<ProviderCleanupAdapter<"shopify">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const token = input.credentials.bearer;
  if (token === null)
    return permanentFailure("provider_cleanup_credential_missing");
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(
      input.cleanup.providerAccountId,
    )
  ) {
    return permanentFailure("provider_cleanup_response_invalid");
  }
  let response: Response;
  try {
    response = await input.fetcher(
      `https://${input.cleanup.providerAccountId}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": token.value,
        },
        body: JSON.stringify({
          query: `mutation PantryUninstallApp {
            appUninstall {
              app { id }
              userErrors { field message }
            }
          }`,
        }),
      },
    );
  } catch {
    return {
      kind: "retryable_failure",
      reason: "provider_cleanup_http_unavailable",
    };
  }
  if (!response.ok)
    return providerHttpFailure(response.status, MANUAL_INSTRUCTION);
  const raw: unknown = await response.json().catch(() => null);
  return shopifyUninstallSucceeded(raw)
    ? { kind: "removed" }
    : permanentFailure("provider_cleanup_response_invalid");
}

function shopifyUninstallSucceeded(raw: unknown): boolean {
  if (
    !isRecord(raw) ||
    !isRecord(raw.data) ||
    !isRecord(raw.data.appUninstall)
  ) {
    return false;
  }
  const app = raw.data.appUninstall.app;
  const errors = raw.data.appUninstall.userErrors;
  return (
    isRecord(app) &&
    typeof app.id === "string" &&
    app.id.length > 0 &&
    Array.isArray(errors) &&
    errors.length === 0
  );
}

function permanentFailure(
  reason:
    "provider_cleanup_credential_missing" | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return { kind: "permanent_failure", reason, instruction: MANUAL_INSTRUCTION };
}

function parseShopifyToken(
  raw: unknown,
): Result<ShopifyAuthorizationGrant, ShopifyProtocolError> {
  if (
    !isRecord(raw) ||
    typeof raw.access_token !== "string" ||
    typeof raw.scope !== "string"
  ) {
    return invalidResponse();
  }
  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      scopes: raw.scope.split(",").map(trimScope).filter(nonEmptyScope),
    },
  };
}

function exchangeFailure(
  status: number,
  requestId: string | null,
): Result<never, ShopifyProtocolError> {
  return {
    ok: false,
    error: { code: "provider_oauth_exchange_failed", status, requestId },
  };
}

function invalidResponse<T>(): Result<T, ShopifyProtocolError> {
  return { ok: false, error: { code: "provider_oauth_response_invalid" } };
}

function trimScope(scope: string): string {
  return scope.trim();
}

function nonEmptyScope(scope: string): boolean {
  return scope.length > 0;
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
