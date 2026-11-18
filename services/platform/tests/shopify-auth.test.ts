/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  acquireShopifyAdminAccess,
  parseShopifyClientCredentials,
} from "../src/shopify/auth";

let capturedAuthReceiver: unknown = null;

describe("Shopify client-credentials authentication", function shopifyAuthSuite() {
  it(
    "mints a bounded Admin access token from encrypted client credentials",
    mintsToken,
  );
  it(
    "rejects an OAuth error before any Admin API request can run",
    rejectsOauthError,
  );
});

async function mintsToken(): Promise<void> {
  capturedAuthReceiver = null;
  const credentials = parseShopifyClientCredentials({
    kind: "oauth_client_credentials",
    clientId: "shopify-client-id-fixture",
    clientSecret: "shopify-client-secret-fixture",
  });

  if (!credentials.ok) {
    throw new Error(credentials.error.code);
  }

  const access = await acquireShopifyAdminAccess({
    shopDomain: "fixture.myshopify.com",
    credentials: credentials.value,
    fetcher: successfulAuthFetch,
    now: 1_000,
  });

  expect(capturedAuthReceiver).toBeUndefined();
  expect(access).toEqual({
    ok: true,
    value: {
      accessToken: "shopify-admin-token-fixture",
      expiresAt: 86_400_000,
      scopes: ["read_orders", "write_orders"],
    },
  });
}

async function rejectsOauthError(): Promise<void> {
  const access = await acquireShopifyAdminAccess({
    shopDomain: "fixture.myshopify.com",
    credentials: {
      clientId: "shopify-client-id-fixture",
      clientSecret: "shopify-client-secret-fixture",
    },
    fetcher: rejectedAuthFetch,
    now: 1_000,
  });

  expect(access).toEqual({
    ok: false,
    error: { code: "shopify_auth_request_failed", status: 401 },
  });
}

async function successfulAuthFetch(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  capturedAuthReceiver = this;
  expect(String(input)).toBe(
    "https://fixture.myshopify.com/admin/oauth/access_token",
  );
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("content-type")).toBe(
    "application/x-www-form-urlencoded",
  );
  const body = new URLSearchParams(String(init?.body));
  expect(body.get("grant_type")).toBe("client_credentials");
  expect(body.get("client_id")).toBe("shopify-client-id-fixture");
  expect(body.get("client_secret")).toBe("shopify-client-secret-fixture");
  return Response.json({
    access_token: "shopify-admin-token-fixture",
    scope: "read_orders,write_orders",
    expires_in: 86_399,
  });
}

async function rejectedAuthFetch(): Promise<Response> {
  return Response.json({ error: "invalid_client" }, { status: 401 });
}
