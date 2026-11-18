import { runtimeFetch } from "../runtime-fetch";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Env } from "../env";
import type { ExternalRecordsProvider } from "./records";
import type { OrganisationId } from "../ids";
import type { IntegrationAccountId } from "../ids";
import {
  resolveActiveProviderAccountContext,
  requireConnectionCredentialAuthority,
} from "../data/integration-account";
import { resolveActiveProviderConnectionCredential } from "../credential-vault/provider-connection-resolution";
import type { Result } from "../result";
import {
  storeVaultSecret,
  type VaultHandle,
  type VaultOAuthTokens,
} from "../credential-vault";
import { isRecord } from "@seams/std";

const NOTION_API_VERSION = "2026-03-11";
const TOKEN_RESPONSE_LIMIT = 64 * 1024;
const AIRTABLE_TOKEN_URL = "https://airtable.com/oauth2/v1/token";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export async function resolveAirtableAccountToken(
  env: Env,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  operation: "read" | "write",
): Promise<string> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok) throw new Error(execution.error.code);
  const scope = execution.value;
  const context = await resolveActiveProviderAccountContext({
    db: scope.database,
    organisationId,
    integrationAccountId,
  });
  if (!context.ok) {
    console.warn(
      JSON.stringify({
        event: "airtable.connection_unavailable",
        organisationId,
        integrationAccountId,
        code: context.error.code,
      }),
    );
    throw new Error("Airtable connection unavailable");
  }
  if (context.value.account.provider !== "airtable")
    throw new Error("Airtable connection unavailable");
  if (
    operation === "write" &&
    !context.value.account.capabilities.includes("airtable.api.write")
  )
    throw new Error(
      "Reconnect Airtable to grant schema and record write access",
    );
  const credential = await resolveActiveProviderConnectionCredential({
    db: scope.database,
    keys: env,
    context: context.value,
    expectedProvider: "airtable",
  });
  if (!credential.ok) {
    console.warn(
      JSON.stringify({
        event: "airtable.credential_unavailable",
        organisationId,
        integrationAccountId,
        code: credential.error.code,
      }),
    );
    throw new Error("Airtable credential unavailable");
  }
  if (credential.value.kind === "bearer") return credential.value.value;
  if (credential.value.kind !== "oauth_tokens")
    throw new Error("Airtable credential type invalid");
  const token = await resolveExternalRecordsAccessToken({
    env,
    provider: "airtable",
    scope,
    handle: requireConnectionCredentialAuthority(context.value.connection)
      .credentialRef,
    tokens: credential.value,
    now: Date.now(),
    fetcher: runtimeFetch,
  });
  if (!token.ok) {
    console.warn(
      JSON.stringify({
        event: "airtable.refresh_failed",
        organisationId,
        integrationAccountId,
        code: token.error.code,
      }),
    );
    throw new Error("Airtable credential refresh failed");
  }
  return token.value;
}

export type ExternalOAuthClientEnv = Pick<
  Env,
  | "AIRTABLE_OAUTH_CLIENT_ID"
  | "AIRTABLE_OAUTH_CLIENT_SECRET"
  | "NOTION_OAUTH_CLIENT_ID"
  | "NOTION_OAUTH_CLIENT_SECRET"
>;

type ExternalOAuthError =
  | { readonly code: "provider_configuration_missing" }
  | { readonly code: "provider_context_invalid" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
      readonly requestId: string | null;
    }
  | { readonly code: "provider_oauth_response_invalid" }
  | { readonly code: "provider_credential_store_failed" };

export async function exchangeExternalRecordsOAuthCode(
  input: Readonly<{
    env: ExternalOAuthClientEnv;
    provider: ExternalRecordsProvider;
    code: string;
    redirectUri: string;
    pkceVerifier: string | null;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<VaultOAuthTokens, ExternalOAuthError>> {
  const configuration = externalOAuthConfiguration(input.env, input.provider);
  if (!configuration.ok) return configuration;
  if (input.provider === "airtable" && input.pkceVerifier === null) {
    return { ok: false, error: { code: "provider_context_invalid" } };
  }
  const request =
    input.provider === "airtable"
      ? airtableTokenRequest({
          credentials: configuration.value,
          grant: {
            kind: "authorization_code",
            code: input.code,
            redirectUri: input.redirectUri,
            codeVerifier: requirePkceVerifier(input.pkceVerifier),
          },
        })
      : notionTokenRequest({
          credentials: configuration.value,
          grant: {
            kind: "authorization_code",
            code: input.code,
            redirectUri: input.redirectUri,
          },
        });
  const response = await fetchToken(input.fetcher, request);
  if (!response.ok) return response;
  return parseTokenResponse(input.provider, response.value, input.now);
}

export async function resolveExternalRecordsAccessToken(
  input: Readonly<{
    env: Env;
    provider: ExternalRecordsProvider;
    scope: OrganisationExecutionScope;
    handle: VaultHandle;
    tokens: VaultOAuthTokens;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<string, ExternalOAuthError>> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "provider_context_invalid" } };
  if (
    input.tokens.expiry.kind === "provider_managed" ||
    input.tokens.expiry.expiresAt > input.now + 60_000
  ) {
    return { ok: true, value: input.tokens.accessToken };
  }
  const refreshed = await refreshExternalRecordsTokens({
    env: input.env,
    provider: input.provider,
    refreshToken: input.tokens.refreshToken,
    now: input.now,
    fetcher: input.fetcher,
  });
  if (!refreshed.ok) return refreshed;
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "provider_context_invalid" } };
  const stored = await storeVaultSecret({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.scope.organisationId,
    handle: input.handle,
    secret: refreshed.value,
    now: input.now,
  });
  return stored.ok
    ? { ok: true, value: refreshed.value.accessToken }
    : { ok: false, error: { code: "provider_credential_store_failed" } };
}

async function refreshExternalRecordsTokens(
  input: Readonly<{
    env: ExternalOAuthClientEnv;
    provider: ExternalRecordsProvider;
    refreshToken: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<VaultOAuthTokens, ExternalOAuthError>> {
  const configuration = externalOAuthConfiguration(input.env, input.provider);
  if (!configuration.ok) return configuration;
  const request =
    input.provider === "airtable"
      ? airtableTokenRequest({
          credentials: configuration.value,
          grant: { kind: "refresh_token", refreshToken: input.refreshToken },
        })
      : notionTokenRequest({
          credentials: configuration.value,
          grant: { kind: "refresh_token", refreshToken: input.refreshToken },
        });
  const response = await fetchToken(input.fetcher, request);
  if (!response.ok) return response;
  return parseTokenResponse(input.provider, response.value, input.now);
}

type OAuthClientCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

type AirtableGrant =
  | Readonly<{
      kind: "authorization_code";
      code: string;
      redirectUri: string;
      codeVerifier: string;
    }>
  | Readonly<{ kind: "refresh_token"; refreshToken: string }>;

type NotionGrant =
  | Readonly<{ kind: "authorization_code"; code: string; redirectUri: string }>
  | Readonly<{ kind: "refresh_token"; refreshToken: string }>;

function externalOAuthConfiguration(
  env: ExternalOAuthClientEnv,
  provider: ExternalRecordsProvider,
): Result<OAuthClientCredentials, ExternalOAuthError> {
  const clientId =
    provider === "airtable"
      ? env.AIRTABLE_OAUTH_CLIENT_ID
      : env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret =
    provider === "airtable"
      ? env.AIRTABLE_OAUTH_CLIENT_SECRET
      : env.NOTION_OAUTH_CLIENT_SECRET;
  return clientId === undefined || clientSecret === undefined
    ? { ok: false, error: { code: "provider_configuration_missing" } }
    : { ok: true, value: { clientId, clientSecret } };
}

function airtableTokenRequest(
  input: Readonly<{
    credentials: OAuthClientCredentials;
    grant: AirtableGrant;
  }>,
): Request {
  const body = new URLSearchParams();
  body.set("grant_type", input.grant.kind);
  if (input.grant.kind === "authorization_code") {
    body.set("code", input.grant.code);
    body.set("redirect_uri", input.grant.redirectUri);
    body.set("code_verifier", input.grant.codeVerifier);
  } else {
    body.set("refresh_token", input.grant.refreshToken);
  }
  return new Request(AIRTABLE_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuthorization(input.credentials),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

function notionTokenRequest(
  input: Readonly<{
    credentials: OAuthClientCredentials;
    grant: NotionGrant;
  }>,
): Request {
  const body =
    input.grant.kind === "authorization_code"
      ? {
          grant_type: input.grant.kind,
          code: input.grant.code,
          redirect_uri: input.grant.redirectUri,
        }
      : {
          grant_type: input.grant.kind,
          refresh_token: input.grant.refreshToken,
        };
  return new Request(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuthorization(input.credentials),
      "content-type": "application/json",
      "notion-version": NOTION_API_VERSION,
    },
    body: JSON.stringify(body),
  });
}

function basicAuthorization(credentials: OAuthClientCredentials): string {
  return `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`;
}

async function fetchToken(
  fetcher: typeof fetch,
  request: Request,
): Promise<Result<Response, ExternalOAuthError>> {
  try {
    const response = await fetcher(request);
    return response.ok
      ? { ok: true, value: response }
      : {
          ok: false,
          error: {
            code: "provider_oauth_exchange_failed",
            status: response.status,
            requestId: response.headers.get("x-request-id"),
          },
        };
  } catch {
    return {
      ok: false,
      error: {
        code: "provider_oauth_exchange_failed",
        status: 503,
        requestId: null,
      },
    };
  }
}

async function parseTokenResponse(
  provider: ExternalRecordsProvider,
  response: Response,
  now: number,
): Promise<Result<VaultOAuthTokens, ExternalOAuthError>> {
  const text = await response.text();
  if (text.length > TOKEN_RESPONSE_LIMIT) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  if (
    !isRecord(raw) ||
    typeof raw.access_token !== "string" ||
    raw.access_token.length === 0 ||
    typeof raw.refresh_token !== "string" ||
    raw.refresh_token.length === 0
  ) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  if (provider === "airtable") {
    return typeof raw.expires_in === "number" &&
      Number.isFinite(raw.expires_in) &&
      raw.expires_in > 0
      ? {
          ok: true,
          value: {
            kind: "oauth_tokens",
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            expiry: {
              kind: "expires",
              expiresAt: now + Math.floor(raw.expires_in * 1000),
            },
          },
        }
      : { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  return {
    ok: true,
    value: {
      kind: "oauth_tokens",
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiry: { kind: "provider_managed" },
    },
  };
}

function requirePkceVerifier(value: string | null): string {
  if (value === null) throw new Error("PKCE verifier is missing");
  return value;
}
