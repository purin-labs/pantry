import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import type { SecretsStoreSecret } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

import {
  exchangeGmailOAuthCode,
  resolveGmailAccessToken,
  type GmailOAuthClientEnv,
} from "../src/mail/gmail-oauth";
import { type VaultOAuthTokens } from "../src/credential-vault";
import { resolveVaultHandle } from "../src/credential-vault/service";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_787_241_600_000;
const CLIENT_ENV: GmailOAuthClientEnv = {
  GMAIL_OAUTH_CLIENT_ID: "gmail-client",
  GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret",
};
const REDIRECT_URI =
  "https://satyr.example/v1/control/providers/gmail/callback";

describe("gmail OAuth", gmailOAuthSuite);

function gmailOAuthSuite(): void {
  it("logs only allowlisted OAuth failure diagnostics", sanitizedFailureTest);
  it(
    "exchanges the authorization code with PKCE and validates identity claims",
    exchangeTest,
  );
  it(
    "uses the shared OAuth application credentials for send-only grants",
    sendOnlyExchangeTest,
  );
  it("rejects an exchange without a PKCE verifier", missingPkceTest);
  it(
    "rejects token responses without offline refresh tokens",
    missingRefreshTokenTest,
  );
  it("rejects identity tokens for a different audience", wrongAudienceTest);
  it("rejects expired identity tokens", expiredIdentityTest);
  it(
    "refreshes access tokens in place inside the current credential generation",
    refreshInPlaceTest,
  );
}

async function sanitizedFailureTest(): Promise<void> {
  const warning = vi.spyOn(console, "warn").mockImplementation(ignoreWarning);
  try {
    const result = await exchangeGmailOAuthCode({
      env: CLIENT_ENV,
      code: "private-code",
      product: "full_mailbox_pilot",
      redirectUri: REDIRECT_URI,
      pkceVerifier: "private-verifier",
      now: NOW,
      fetcher: rejectedGrantFetcher,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_oauth_exchange_failed", status: 400 },
    });
    expect(warning).toHaveBeenCalledOnce();
    // Neither the caller nor the log may carry the authorization code, the
    // PKCE verifier, a token or the provider's free-text detail.
    const exposed = JSON.stringify([result, warning.mock.calls]);
    for (const secret of [
      "private-code",
      "private-verifier",
      "private-token",
      "private-provider-detail",
    ]) {
      expect(exposed).not.toContain(secret);
    }
  } finally {
    warning.mockRestore();
  }
}

function ignoreWarning(): void {}

async function rejectedGrantFetcher(): Promise<Response> {
  return Response.json(
    {
      error: "invalid_grant",
      error_description: "private-provider-detail",
      refresh_token: "private-token",
    },
    { status: 400 },
  );
}

async function exchangeTest(): Promise<void> {
  const result = await exchangeGmailOAuthCode({
    env: CLIENT_ENV,
    code: "gmail-code",
    product: "full_mailbox_pilot",
    redirectUri: REDIRECT_URI,
    pkceVerifier: "pkce-verifier",
    now: NOW,
    fetcher: exchangeFetcher(),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.googleSubject).toBe("google-sub-123");
    expect(result.value.email).toBe("owner@example.com");
    expect(result.value.grantedScopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ]);
    expect(result.value.tokens).toEqual({
      kind: "oauth_tokens",
      accessToken: "gmail-access",
      refreshToken: "gmail-refresh",
      expiry: { kind: "expires", expiresAt: NOW + 3_599_000 },
    });
  }
}

async function sendOnlyExchangeTest(): Promise<void> {
  const result = await exchangeGmailOAuthCode({
    env: CLIENT_ENV,
    code: "gmail-code",
    product: "send_only",
    redirectUri: REDIRECT_URI,
    pkceVerifier: "pkce-verifier",
    now: NOW,
    fetcher: exchangeFetcher(),
  });
  expect(result.ok).toBe(true);
}

async function missingPkceTest(): Promise<void> {
  const result = await exchangeGmailOAuthCode({
    env: CLIENT_ENV,
    code: "gmail-code",
    product: "full_mailbox_pilot",
    redirectUri: REDIRECT_URI,
    pkceVerifier: null,
    now: NOW,
    fetcher: unexpectedFetcher,
  });
  expect(result).toEqual({
    ok: false,
    error: { code: "provider_context_invalid" },
  });
}

async function missingRefreshTokenTest(): Promise<void> {
  const result = await exchangeGmailOAuthCode({
    env: CLIENT_ENV,
    code: "gmail-code",
    product: "full_mailbox_pilot",
    redirectUri: REDIRECT_URI,
    pkceVerifier: "pkce-verifier",
    now: NOW,
    fetcher: exchangeFetcher({ omitRefreshToken: true }),
  });
  expect(result).toEqual({
    ok: false,
    error: { code: "provider_oauth_response_invalid" },
  });
}

async function wrongAudienceTest(): Promise<void> {
  const result = await exchangeGmailOAuthCode({
    env: CLIENT_ENV,
    code: "gmail-code",
    product: "full_mailbox_pilot",
    redirectUri: REDIRECT_URI,
    pkceVerifier: "pkce-verifier",
    now: NOW,
    fetcher: exchangeFetcher({ audience: "another-client" }),
  });
  expect(result).toEqual({
    ok: false,
    error: { code: "provider_identity_unverified" },
  });
}

async function expiredIdentityTest(): Promise<void> {
  const result = await exchangeGmailOAuthCode({
    env: CLIENT_ENV,
    code: "gmail-code",
    product: "full_mailbox_pilot",
    redirectUri: REDIRECT_URI,
    pkceVerifier: "pkce-verifier",
    now: NOW,
    fetcher: exchangeFetcher({ expiredIdentity: true }),
  });
  expect(result).toEqual({
    ok: false,
    error: { code: "provider_identity_unverified" },
  });
}

async function refreshInPlaceTest(): Promise<void> {
  const env = vaultEnv();
  const organisationId = requireOrganisationId("organisation_gmail_refresh");
  await env.DB.prepare(
    "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'Gmail Refresh', ?)",
  )
    .bind(organisationId, NOW)
    .run();
  const placed = await ensureInitialOrganisationPlacement({
    db: env.DB,
    organisationId,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  if (!placed.ok) throw new Error(placed.error.code);
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const handle = requireHandle(
    "vault:organisation_gmail_refresh:gmail:sub:oauth:g1",
  );
  const expiring: VaultOAuthTokens = {
    kind: "oauth_tokens",
    accessToken: "stale-access",
    refreshToken: "gmail-refresh",
    expiry: { kind: "expires", expiresAt: NOW + 10_000 },
  };

  const fresh = await resolveGmailAccessToken({
    env,
    scope,
    handle,
    product: "full_mailbox_pilot",
    tokens: {
      ...expiring,
      expiry: { kind: "expires", expiresAt: NOW + 3_600_000 },
    },
    now: NOW,
    fetcher: unexpectedFetcher,
  });
  expect(fresh).toEqual({ ok: true, value: "stale-access" });

  const refreshed = await resolveGmailAccessToken({
    env,
    scope,
    handle,
    product: "full_mailbox_pilot",
    tokens: expiring,
    now: NOW,
    fetcher: refreshFetcher,
  });
  expect(refreshed).toEqual({ ok: true, value: "rotated-access" });

  const stored = await resolveVaultHandle({
    db: env.DB,
    keys: env,
    organisationId,
    handle,
  });
  expect(stored.ok).toBe(true);
  if (stored.ok) {
    expect(stored.value).toEqual({
      kind: "oauth_tokens",
      accessToken: "rotated-access",
      refreshToken: "gmail-refresh",
      expiry: { kind: "expires", expiresAt: NOW + 1_800_000 },
    });
  }

  const generations = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM vault_secret WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ readonly total: number }>();
  expect(generations?.total).toBe(1);
}

function exchangeFetcher(
  options: {
    readonly omitRefreshToken?: boolean;
    readonly audience?: string;
    readonly expiredIdentity?: boolean;
  } = {},
): typeof fetch {
  return (async (request: RequestInfo | URL) => {
    const normalized = new Request(request as Request);
    expect(normalized.url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(await normalized.text());
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("gmail-code");
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(body.get("client_id")).toBe("gmail-client");
    expect(body.get("client_secret")).toBe("gmail-secret");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    return Response.json({
      access_token: "gmail-access",
      ...(options.omitRefreshToken === true
        ? {}
        : { refresh_token: "gmail-refresh" }),
      expires_in: 3599,
      // Real Google responses grant the canonical userinfo.email identifier
      // (never the requested "email" shorthand) and reorder the scopes.
      scope:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email openid",
      id_token: makeIdToken({
        aud: options.audience ?? "gmail-client",
        exp:
          options.expiredIdentity === true
            ? Math.floor(NOW / 1000) - 3_600
            : Math.floor(NOW / 1000) + 3_600,
      }),
    });
  }) as typeof fetch;
}

async function refreshFetcher(
  this: unknown,
  request: RequestInfo | URL,
): Promise<Response> {
  expect(this).toBe(globalThis);
  const normalized = new Request(request as Request);
  const body = new URLSearchParams(await normalized.text());
  expect(body.get("grant_type")).toBe("refresh_token");
  expect(body.get("refresh_token")).toBe("gmail-refresh");
  return Response.json({ access_token: "rotated-access", expires_in: 1800 });
}

async function unexpectedFetcher(): Promise<Response> {
  throw new Error("no provider request expected");
}

function makeIdToken(options: {
  readonly aud: string;
  readonly exp: number;
}): string {
  const header = encodeSegment({ alg: "RS256", kid: "test-key" });
  const payload = encodeSegment({
    iss: "https://accounts.google.com",
    aud: options.aud,
    exp: options.exp,
    iat: Math.floor(NOW / 1000) - 10,
    sub: "google-sub-123",
    email: "owner@example.com",
    email_verified: true,
  });
  return `${header}.${payload}.signature`;
}

function encodeSegment(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function vaultEnv(): UnitTestEnv {
  return platformEnv({
    DB: createMigratedDatabase(),
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: testRoot(7),
    GMAIL_OAUTH_CLIENT_ID: "gmail-client",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret",
  });
}

function testRoot(fill: number): SecretsStoreSecret {
  const bytes = new Uint8Array(32);
  bytes.fill(fill);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return { get: async () => btoa(binary) };
}

function requireHandle(raw: string): ReturnType<typeof requireVaultHandle> {
  return requireVaultHandle(raw);
}
