import { describe, expect, it } from "vitest";

import {
  exchangeExternalRecordsOAuthCode,
  type ExternalOAuthClientEnv,
} from "@purin-labs/area-integrations/server/external-records/oauth";

const NOW = 1_787_241_600_000;
const ENV: ExternalOAuthClientEnv = {
  AIRTABLE_OAUTH_CLIENT_ID: "airtable-client",
  AIRTABLE_OAUTH_CLIENT_SECRET: "airtable-secret",
  NOTION_OAUTH_CLIENT_ID: "notion-client",
  NOTION_OAUTH_CLIENT_SECRET: "notion-secret",
};

describe("external records OAuth", externalRecordsOAuthSuite);

function externalRecordsOAuthSuite(): void {
  it(
    "exchanges an Airtable authorization code with PKCE",
    exchangeAirtableCode,
  );
  it(
    "exchanges a Notion authorization code with Basic authentication",
    exchangeNotionCode,
  );
  it("rejects an Airtable exchange without a PKCE verifier", rejectMissingPkce);
}

async function exchangeAirtableCode(): Promise<void> {
  const result = await exchangeExternalRecordsOAuthCode({
    env: ENV,
    provider: "airtable",
    code: "airtable-code",
    redirectUri: "https://pantry.example/v1/control/providers/airtable/callback",
    pkceVerifier: "pkce-verifier",
    now: NOW,
    fetcher: airtableExchangeFetcher,
  });
  expect(result).toEqual({
    ok: true,
    value: {
      kind: "oauth_tokens",
      accessToken: "airtable-access",
      refreshToken: "airtable-refresh",
      expiry: { kind: "expires", expiresAt: NOW + 3_600_000 },
    },
  });
}

async function exchangeNotionCode(): Promise<void> {
  const result = await exchangeExternalRecordsOAuthCode({
    env: ENV,
    provider: "notion",
    code: "notion-code",
    redirectUri: "https://pantry.example/v1/control/providers/notion/callback",
    pkceVerifier: null,
    now: NOW,
    fetcher: notionExchangeFetcher,
  });
  expect(result).toEqual({
    ok: true,
    value: {
      kind: "oauth_tokens",
      accessToken: "notion-access",
      refreshToken: "notion-refresh",
      expiry: { kind: "provider_managed" },
    },
  });
}

async function rejectMissingPkce(): Promise<void> {
  const result = await exchangeExternalRecordsOAuthCode({
    env: ENV,
    provider: "airtable",
    code: "airtable-code",
    redirectUri: "https://pantry.example/v1/control/providers/airtable/callback",
    pkceVerifier: null,
    now: NOW,
    fetcher: unexpectedFetcher,
  });
  expect(result).toEqual({
    ok: false,
    error: { code: "provider_context_invalid" },
  });
}

async function airtableExchangeFetcher(
  request: RequestInfo | URL,
): Promise<Response> {
  const normalized = new Request(request);
  expect(normalized.url).toBe("https://airtable.com/oauth2/v1/token");
  expect(normalized.headers.get("authorization")).toBe(
    `Basic ${btoa("airtable-client:airtable-secret")}`,
  );
  expect(await normalized.text()).toBe(
    "grant_type=authorization_code&code=airtable-code&redirect_uri=https%3A%2F%2Fpantry.example%2Fv1%2Fcontrol%2Fproviders%2Fairtable%2Fcallback&code_verifier=pkce-verifier",
  );
  return Response.json({
    access_token: "airtable-access",
    refresh_token: "airtable-refresh",
    expires_in: 3600,
  });
}

async function notionExchangeFetcher(
  request: RequestInfo | URL,
): Promise<Response> {
  const normalized = new Request(request);
  expect(normalized.url).toBe("https://api.notion.com/v1/oauth/token");
  expect(normalized.headers.get("notion-version")).toBe("2026-03-11");
  expect(normalized.headers.get("authorization")).toBe(
    `Basic ${btoa("notion-client:notion-secret")}`,
  );
  expect(await normalized.json()).toEqual({
    grant_type: "authorization_code",
    code: "notion-code",
    redirect_uri: "https://pantry.example/v1/control/providers/notion/callback",
  });
  return Response.json({
    access_token: "notion-access",
    refresh_token: "notion-refresh",
  });
}

async function unexpectedFetcher(): Promise<Response> {
  throw new Error("fetch should not be called");
}
