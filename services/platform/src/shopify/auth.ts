import type { Result } from "../result";
import type { VaultSecret } from "../credential-vault";
import { isRecord } from "@seams/std";

type ShopifyClientCredentials = {
  clientId: string;
  clientSecret: string;
};

type ShopifyAdminAccess = {
  accessToken: string;
  expiresAt: number;
  scopes: readonly string[];
};

export type ShopifyAuthError =
  | { code: "shopify_client_credential_invalid" }
  | { code: "shopify_auth_transport_failed" }
  | { code: "shopify_auth_request_failed"; status: number }
  | { code: "shopify_auth_response_invalid" };

export function parseShopifyClientCredentials(
  secret: VaultSecret,
): Result<ShopifyClientCredentials, ShopifyAuthError> {
  if (
    secret.kind !== "oauth_client_credentials" ||
    !isShopifyClientId(secret.clientId) ||
    !isShopifyClientSecret(secret.clientSecret)
  ) {
    return { ok: false, error: { code: "shopify_client_credential_invalid" } };
  }

  return {
    ok: true,
    value: { clientId: secret.clientId, clientSecret: secret.clientSecret },
  };
}

export async function acquireShopifyAdminAccess(input: {
  shopDomain: string;
  credentials: ShopifyClientCredentials;
  fetcher: typeof fetch;
  now: number;
}): Promise<Result<ShopifyAdminAccess, ShopifyAuthError>> {
  if (
    !isShopifyAdminDomain(input.shopDomain) ||
    !isShopifyClientId(input.credentials.clientId) ||
    !isShopifyClientSecret(input.credentials.clientSecret)
  ) {
    return { ok: false, error: { code: "shopify_client_credential_invalid" } };
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: input.credentials.clientId,
    client_secret: input.credentials.clientSecret,
  });
  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.shopDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
  } catch {
    return { ok: false, error: { code: "shopify_auth_transport_failed" } };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: { code: "shopify_auth_request_failed", status: response.status },
    };
  }

  const raw = await readShopifyAuthJson(response);

  if (
    raw === null ||
    typeof raw.access_token !== "string" ||
    raw.access_token.length < 10 ||
    typeof raw.scope !== "string" ||
    typeof raw.expires_in !== "number" ||
    !Number.isSafeInteger(raw.expires_in) ||
    raw.expires_in <= 0
  ) {
    return { ok: false, error: { code: "shopify_auth_response_invalid" } };
  }

  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      expiresAt: input.now + raw.expires_in * 1_000,
      scopes: parseShopifyScopes(raw.scope),
    },
  };
}

export function isShopifyAdminDomain(raw: string): boolean {
  return raw.length <= 255 && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(raw);
}

export function isShopifyClientId(raw: string): boolean {
  return raw.length >= 16 && raw.length <= 255 && !/\s/u.test(raw);
}

export function isShopifyClientSecret(raw: string): boolean {
  return raw.length >= 16 && raw.length <= 255 && !/\s/u.test(raw);
}

async function readShopifyAuthJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = await response.json();
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function parseShopifyScopes(raw: string): readonly string[] {
  const scopes: string[] = [];

  for (const part of raw.split(",")) {
    const scope = part.trim();

    if (scope.length > 0) {
      scopes.push(scope);
    }
  }

  return scopes;
}
