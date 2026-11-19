import type { Env } from "../env";
import { jwtClaims } from "../lenient-base64";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import type { GmailAuthorizationProduct } from "./gmail-authorization";
import {
  storeVaultSecret,
  type VaultHandle,
  type VaultOAuthTokens,
} from "../credential-vault";
import { isRecord } from "@purin-labs/std";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const TOKEN_RESPONSE_LIMIT = 64 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const REFRESH_MARGIN_MS = 60_000;

export type GmailOAuthClientEnv = Pick<
  Env,
  "GMAIL_OAUTH_CLIENT_ID" | "GMAIL_OAUTH_CLIENT_SECRET"
>;

type GmailOAuthError =
  | { readonly code: "provider_configuration_missing" }
  | { readonly code: "provider_context_invalid" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
      readonly requestId: string | null;
      /**
       * Google's `error` value. `invalid_grant` on a refresh means that the
       * grant expired or was revoked: only a new sign-in repairs it.
       */
      readonly providerError: GoogleOAuthErrorCode;
    }
  | { readonly code: "provider_oauth_response_invalid" }
  | { readonly code: "provider_identity_unverified" }
  | { readonly code: "provider_credential_store_failed" };

type GoogleOAuthErrorCode =
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized_client"
  | "invalid_request"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "temporarily_unavailable"
  | "server_error"
  | "unrecognized_response"
  | "network_failure";

/** True when Google refused the grant itself, so a retry cannot succeed. */
export function gmailGrantRefused(error: GmailOAuthError): boolean {
  return (
    error.code === "provider_oauth_exchange_failed" &&
    error.providerError === "invalid_grant"
  );
}

type GmailOAuthConnection = {
  readonly tokens: VaultOAuthTokens;
  readonly googleSubject: string;
  readonly email: string;
  readonly grantedScopes: readonly string[];
};

/**
 * Exchanges the callback code directly with Google's token endpoint. The ID
 * token in that response arrives over the server-side TLS channel Pantry
 * opened itself, so claim validation (issuer, audience, expiry) establishes
 * the immutable Google subject without a JWKS round trip; tokens relayed by
 * any other channel must never enter this function.
 */
export async function exchangeGmailOAuthCode(
  input: Readonly<{
    env: GmailOAuthClientEnv;
    code: string;
    product: GmailAuthorizationProduct;
    redirectUri: string;
    pkceVerifier: string | null;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailOAuthConnection, GmailOAuthError>> {
  const configuration = gmailOAuthConfiguration(input.env, input.product);
  if (!configuration.ok) return configuration;
  if (input.pkceVerifier === null) {
    return { ok: false, error: { code: "provider_context_invalid" } };
  }
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.pkceVerifier);
  body.set("client_id", configuration.value.clientId);
  body.set("client_secret", configuration.value.clientSecret);
  const response = await fetchGoogleToken(input.fetcher, body);
  if (!response.ok) return response;
  const raw = await readTokenResponse(response.value);
  if (!raw.ok) return raw;
  if (
    typeof raw.value.refresh_token !== "string" ||
    raw.value.refresh_token.length === 0 ||
    typeof raw.value.id_token !== "string"
  ) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  const tokens = parseAccessTokenGrant(
    raw.value,
    raw.value.refresh_token,
    input.now,
  );
  if (tokens === null) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  const identity = validateGmailIdTokenClaims({
    idToken: raw.value.id_token,
    clientId: configuration.value.clientId,
    now: input.now,
  });
  if (!identity.ok) return identity;
  return {
    ok: true,
    value: {
      tokens,
      googleSubject: identity.value.sub,
      email: identity.value.email,
      grantedScopes: parseGrantedScopes(raw.value.scope),
    },
  };
}

/**
 * Refreshes inside the current credential generation: the refreshed secret
 * overwrites the same Vault handle. Reconnect and explicit rotation create a
 * new generation; a refresh alone never does.
 */
export async function resolveGmailAccessToken(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    handle: VaultHandle;
    tokens: VaultOAuthTokens;
    product: GmailAuthorizationProduct;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<string, GmailOAuthError>> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "provider_context_invalid" } };
  if (
    input.tokens.expiry.kind === "provider_managed" ||
    input.tokens.expiry.expiresAt > input.now + REFRESH_MARGIN_MS
  ) {
    return { ok: true, value: input.tokens.accessToken };
  }
  const refreshed = await refreshGmailTokens({
    env: input.env,
    product: input.product,
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

async function refreshGmailTokens(
  input: Readonly<{
    env: GmailOAuthClientEnv;
    product: GmailAuthorizationProduct;
    refreshToken: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<VaultOAuthTokens, GmailOAuthError>> {
  const configuration = gmailOAuthConfiguration(input.env, input.product);
  if (!configuration.ok) return configuration;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", input.refreshToken);
  body.set("client_id", configuration.value.clientId);
  body.set("client_secret", configuration.value.clientSecret);
  const response = await fetchGoogleToken(input.fetcher, body);
  if (!response.ok) return response;
  const raw = await readTokenResponse(response.value);
  if (!raw.ok) return raw;
  const rotatedRefreshToken =
    typeof raw.value.refresh_token === "string" &&
    raw.value.refresh_token.length > 0
      ? raw.value.refresh_token
      : input.refreshToken;
  const tokens = parseAccessTokenGrant(
    raw.value,
    rotatedRefreshToken,
    input.now,
  );
  return tokens === null
    ? { ok: false, error: { code: "provider_oauth_response_invalid" } }
    : { ok: true, value: tokens };
}

function gmailOAuthConfiguration(
  env: GmailOAuthClientEnv,
  _product: GmailAuthorizationProduct,
): Result<
  { readonly clientId: string; readonly clientSecret: string },
  GmailOAuthError
> {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  return clientId === undefined || clientSecret === undefined
    ? { ok: false, error: { code: "provider_configuration_missing" } }
    : {
        ok: true,
        value: {
          clientId,
          clientSecret,
        },
      };
}

async function fetchGoogleToken(
  fetcher: typeof fetch,
  body: URLSearchParams,
): Promise<Result<Response, GmailOAuthError>> {
  try {
    const response = await fetcher.call(
      globalThis,
      new Request(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    if (response.ok) return { ok: true, value: response };
    const failure = await readTokenResponse(response);
    const providerError = safeGoogleOAuthError(
      failure.ok ? failure.value.error : null,
    );
    console.warn("gmail.oauth_exchange_failed", {
      status: response.status,
      providerError,
    });
    return {
      ok: false,
      error: {
        code: "provider_oauth_exchange_failed",
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        providerError,
      },
    };
  } catch {
    console.warn("gmail.oauth_exchange_failed", {
      status: 503,
      providerError: "network_failure",
    });
    return {
      ok: false,
      error: {
        code: "provider_oauth_exchange_failed",
        status: 503,
        requestId: null,
        providerError: "network_failure",
      },
    };
  }
}

function safeGoogleOAuthError(raw: unknown): GoogleOAuthErrorCode {
  switch (raw) {
    case "invalid_grant":
    case "invalid_client":
    case "unauthorized_client":
    case "invalid_request":
    case "invalid_scope":
    case "unsupported_grant_type":
    case "temporarily_unavailable":
    case "server_error":
      return raw;
    default:
      return "unrecognized_response";
  }
}

async function readTokenResponse(
  response: Response,
): Promise<Result<Record<string, unknown>, GmailOAuthError>> {
  const text = await response.text();
  if (text.length > TOKEN_RESPONSE_LIMIT) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: { code: "provider_oauth_response_invalid" } };
  } catch {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
}

function parseAccessTokenGrant(
  raw: Record<string, unknown>,
  refreshToken: string,
  now: number,
): VaultOAuthTokens | null {
  if (
    typeof raw.access_token !== "string" ||
    raw.access_token.length === 0 ||
    typeof raw.expires_in !== "number" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in <= 0
  ) {
    return null;
  }
  return {
    kind: "oauth_tokens",
    accessToken: raw.access_token,
    refreshToken,
    expiry: {
      kind: "expires",
      expiresAt: now + Math.floor(raw.expires_in * 1000),
    },
  };
}

function validateGmailIdTokenClaims(
  input: Readonly<{
    idToken: string;
    clientId: string;
    now: number;
  }>,
): Result<{ readonly sub: string; readonly email: string }, GmailOAuthError> {
  const parts = input.idToken.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  const claims = jwtClaims(input.idToken);
  if (
    claims === null ||
    typeof claims.iss !== "string" ||
    typeof claims.aud !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number" ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    typeof claims.email !== "string" ||
    claims.email.length === 0
  ) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  const nowSeconds = Math.floor(input.now / 1000);
  const valid =
    GOOGLE_ISSUERS.has(claims.iss) &&
    claims.aud === input.clientId &&
    claims.exp + CLOCK_SKEW_SECONDS > nowSeconds &&
    claims.iat - CLOCK_SKEW_SECONDS <= nowSeconds;
  return valid
    ? { ok: true, value: { sub: claims.sub, email: claims.email } }
    : { ok: false, error: { code: "provider_identity_unverified" } };
}

function parseGrantedScopes(raw: unknown): readonly string[] {
  return typeof raw === "string"
    ? raw.split(" ").filter((scope) => scope.length > 0)
    : [];
}
