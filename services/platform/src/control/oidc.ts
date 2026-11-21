import type { GlobalDatabase } from "../database-handles";
import {
  hashOpaqueSecret,
  type VerifiedOidcIdentity,
} from "../data/control-plane";
import { parseOrganisationId } from "../ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import {
  parseApprovalProofDigest,
  type ApprovalActionBinding,
} from "../approval-authentication";
import type { Result } from "../result";
import type { VariantBy } from "@purin-labs/type-utils";
import { decodeBase64Url, encodeBase64Url, isRecord } from "@purin-labs/std";
import { paddedStandardBase64 } from "../lenient-base64";

export type GoogleOidcConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

type GoogleOidcStart = {
  readonly state: string;
  readonly authorizationUrl: string;
  readonly expiresAt: number;
};

type GoogleOidcAuthentication =
  | { readonly kind: "sign_in" }
  | {
      readonly kind: "approval_step_up";
      readonly challenge: ApprovalActionBinding;
    };

type GoogleApprovalGrant = {
  readonly stateHash: string;
  readonly userId: UserId;
  readonly challenge: ApprovalActionBinding;
};

export type GoogleOidcFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type GoogleOidcError =
  | { readonly code: "oidc_state_missing" }
  | { readonly code: "oidc_state_expired" }
  | { readonly code: "oidc_state_consumed" }
  | { readonly code: "oidc_exchange_failed" }
  | { readonly code: "oidc_token_invalid" }
  | { readonly code: "oidc_identity_unverified" };

type OidcStateRow = {
  provider: unknown;
  pkceVerifier: unknown;
  oidcNonceHash: unknown;
  redirectPath: unknown;
  expiresAt: unknown;
  consumedAt: unknown;
};

type JwtHeader = {
  readonly alg: "RS256";
  readonly kid: string;
};

type GoogleClaims = {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly nonce: string;
  readonly email: string;
  readonly email_verified: true;
  readonly name: string;
};

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const REDIRECT_ORIGIN = "https://satyr.invalid";
const APPROVAL_STATE_PARAM = "_satyr_approval";
const APPROVAL_GRANT_VERSION = "v1";

export async function beginGoogleOidc(input: {
  readonly db: GlobalDatabase;
  readonly config: GoogleOidcConfig;
  readonly redirectPath: string;
  readonly authentication: GoogleOidcAuthentication;
  readonly now: number;
}): Promise<GoogleOidcStart> {
  const state = randomToken();
  const nonce = randomToken();
  const pkceVerifier = randomToken();
  const pkceChallenge = await hashOpaqueSecret(pkceVerifier);
  const expiresAt = input.now + OIDC_STATE_TTL_MS;

  await input.db
    .prepare(
      `INSERT INTO control_oidc_state (
         state_hash, provider, pkce_verifier, oidc_nonce_hash, redirect_path,
         created_at, expires_at, consumed_at
       ) VALUES (?, 'google', ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      await hashOpaqueSecret(state),
      pkceVerifier,
      await hashOpaqueSecret(nonce),
      encodeApprovalRedirectPath(input.redirectPath, input.authentication),
      input.now,
      expiresAt,
    )
    .run();

  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.authentication.kind === "approval_step_up") {
    url.searchParams.set("prompt", "login");
    url.searchParams.set("max_age", "0");
  } else {
    url.searchParams.set("prompt", "select_account");
  }

  return { state, authorizationUrl: url.toString(), expiresAt };
}

export async function completeGoogleOidc(input: {
  readonly db: GlobalDatabase;
  readonly config: GoogleOidcConfig;
  readonly state: string;
  readonly code: string;
  readonly now: number;
  readonly fetcher: GoogleOidcFetcher;
}): Promise<
  Result<
    {
      readonly identity: VerifiedOidcIdentity;
      readonly identityToken: string;
      readonly redirectPath: string;
      readonly approvalChallenge: ApprovalActionBinding | null;
      readonly approvalStateHash: string;
    },
    GoogleOidcError
  >
> {
  const fetcher = input.fetcher.bind(globalThis);
  const stateHash = await hashOpaqueSecret(input.state);
  const row = await input.db
    .prepare(
      `SELECT
         provider,
         pkce_verifier AS pkceVerifier,
         oidc_nonce_hash AS oidcNonceHash,
         redirect_path AS redirectPath,
         expires_at AS expiresAt,
         consumed_at AS consumedAt
       FROM control_oidc_state
       WHERE state_hash = ?`,
    )
    .bind(stateHash)
    .first<OidcStateRow>();

  const stateRecord = parseOidcState(row, input.now);
  if (!stateRecord.ok) {
    return stateRecord;
  }

  const consumed = await input.db
    .prepare(
      `UPDATE control_oidc_state
       SET consumed_at = ?
       WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(input.now, stateHash, input.now)
    .run();
  if (consumed.meta.changes !== 1) {
    return { ok: false, error: { code: "oidc_state_consumed" } };
  }

  const token = await exchangeGoogleCode({
    config: input.config,
    code: input.code,
    pkceVerifier: stateRecord.value.pkceVerifier,
    fetcher,
  });
  if (!token.ok) {
    return token;
  }

  const claims = await verifyGoogleIdToken({
    idToken: token.value,
    clientId: input.config.clientId,
    expectedNonceHash: stateRecord.value.oidcNonceHash,
    now: input.now,
    fetcher,
  });
  if (!claims.ok) {
    return claims;
  }

  return {
    ok: true,
    value: {
      identity: {
        issuer: claims.value.iss,
        subject: claims.value.sub,
        email: claims.value.email,
        displayName: claims.value.name,
        emailVerified: true,
      },
      identityToken: token.value,
      redirectPath: stateRecord.value.redirectPath,
      approvalChallenge: stateRecord.value.approvalChallenge,
      approvalStateHash: stateHash,
    },
  };
}

export async function issueGoogleApprovalGrant(
  grant: GoogleApprovalGrant,
  clientSecret: string,
): Promise<string> {
  const key = await importGrantKey(clientSecret);
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(grant)),
  );
  const signingInput = `${APPROVAL_GRANT_VERSION}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyGoogleApprovalGrant(input: {
  readonly raw: string;
  readonly clientSecret: string;
  readonly now: number;
}): Promise<
  Result<
    GoogleApprovalGrant,
    { readonly code: "approval_grant_invalid" | "approval_grant_expired" }
  >
> {
  const parts = input.raw.split(".");
  if (parts.length !== 3 || parts[0] !== APPROVAL_GRANT_VERSION) {
    return { ok: false, error: { code: "approval_grant_invalid" } };
  }
  const payload = parts[1];
  const signature = decodeBase64Url(parts[2] ?? "");
  if (payload === undefined || signature === null) {
    return { ok: false, error: { code: "approval_grant_invalid" } };
  }
  const key = await importGrantKey(input.clientSecret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(`${APPROVAL_GRANT_VERSION}.${payload}`),
  );
  if (!valid) {
    return { ok: false, error: { code: "approval_grant_invalid" } };
  }
  const decoded = decodeBase64Url(payload);
  if (decoded === null) {
    return { ok: false, error: { code: "approval_grant_invalid" } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return { ok: false, error: { code: "approval_grant_invalid" } };
  }
  const grant = parseGoogleApprovalGrant(raw);
  if (grant === null) {
    return { ok: false, error: { code: "approval_grant_invalid" } };
  }
  if (grant.challenge.expiresAt <= input.now) {
    return { ok: false, error: { code: "approval_grant_expired" } };
  }
  return { ok: true, value: grant };
}

export async function consumeGoogleApprovalCeremony(input: {
  readonly db: GlobalDatabase;
  readonly stateHash: string;
  readonly challenge: ApprovalActionBinding;
}): Promise<boolean> {
  const row = await input.db
    .prepare(
      "SELECT redirect_path AS redirectPath FROM control_oidc_state WHERE state_hash = ? AND consumed_at IS NOT NULL",
    )
    .bind(input.stateHash)
    .first<{ readonly redirectPath: unknown }>();
  if (typeof row?.redirectPath !== "string") {
    return false;
  }
  const parsed = parseApprovalRedirectPath(row.redirectPath);
  if (
    parsed === null ||
    parsed.challenge === null ||
    !sameChallenge(parsed.challenge, input.challenge)
  ) {
    return false;
  }
  const result = await input.db
    .prepare(
      "UPDATE control_oidc_state SET redirect_path = ? WHERE state_hash = ? AND consumed_at IS NOT NULL AND redirect_path = ?",
    )
    .bind(parsed.redirectPath, input.stateHash, row.redirectPath)
    .run();
  return result.meta.changes === 1;
}

async function exchangeGoogleCode(input: {
  readonly config: GoogleOidcConfig;
  readonly code: string;
  readonly pkceVerifier: string;
  readonly fetcher: GoogleOidcFetcher;
}): Promise<
  Result<string, VariantBy<GoogleOidcError, "code", "oidc_exchange_failed">>
> {
  const body = new URLSearchParams();
  body.set("client_id", input.config.clientId);
  body.set("client_secret", input.config.clientSecret);
  body.set("code", input.code);
  body.set("code_verifier", input.pkceVerifier);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", input.config.redirectUri);

  const response = await input.fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    return { ok: false, error: { code: "oidc_exchange_failed" } };
  }

  const payload: unknown = await response.json();
  const idToken = isRecord(payload) ? payload.id_token : undefined;
  return typeof idToken === "string"
    ? { ok: true, value: idToken }
    : { ok: false, error: { code: "oidc_exchange_failed" } };
}

async function verifyGoogleIdToken(input: {
  readonly idToken: string;
  readonly clientId: string;
  readonly expectedNonceHash: string;
  readonly now: number;
  readonly fetcher: GoogleOidcFetcher;
}): Promise<Result<GoogleClaims, GoogleOidcError>> {
  const parts = input.idToken.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: { code: "oidc_token_invalid" } };
  }

  const header = parseJwtHeader(decodeJson(parts[0] ?? ""));
  const claims = parseGoogleClaims(decodeJson(parts[1] ?? ""));
  if (!header.ok || !claims.ok) {
    return { ok: false, error: { code: "oidc_token_invalid" } };
  }

  const validClaims =
    GOOGLE_ISSUERS.has(claims.value.iss) &&
    claims.value.aud === input.clientId &&
    claims.value.exp + CLOCK_SKEW_SECONDS > Math.floor(input.now / 1000) &&
    claims.value.iat - CLOCK_SKEW_SECONDS <= Math.floor(input.now / 1000) &&
    (await hashOpaqueSecret(claims.value.nonce)) === input.expectedNonceHash;
  if (!validClaims) {
    return { ok: false, error: { code: "oidc_identity_unverified" } };
  }

  const jwk = await fetchGoogleJwk(input.fetcher, header.value.kid);
  if (jwk === null) {
    return { ok: false, error: { code: "oidc_token_invalid" } };
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeLenientBase64Url(parts[2] ?? ""),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );

  return verified
    ? claims
    : { ok: false, error: { code: "oidc_token_invalid" } };
}

async function fetchGoogleJwk(
  fetcher: GoogleOidcFetcher,
  kid: string,
): Promise<JsonWebKey | null> {
  const response = await fetcher(GOOGLE_JWKS_URL);
  if (!response.ok) {
    return null;
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    return null;
  }
  const keys = payload.keys;
  if (!Array.isArray(keys)) {
    return null;
  }
  for (const key of keys) {
    const parsed = parseRsaJwk(key);
    if (parsed !== null && parsed.kid === kid) {
      return parsed;
    }
  }
  return null;
}

function parseOidcState(
  row: OidcStateRow | null,
  now: number,
): Result<
  {
    readonly pkceVerifier: string;
    readonly oidcNonceHash: string;
    readonly redirectPath: string;
    readonly approvalChallenge: ApprovalActionBinding | null;
  },
  GoogleOidcError
> {
  if (row === null) {
    return { ok: false, error: { code: "oidc_state_missing" } };
  }
  if (row.consumedAt !== null) {
    return { ok: false, error: { code: "oidc_state_consumed" } };
  }
  if (typeof row.expiresAt !== "number" || row.expiresAt <= now) {
    return { ok: false, error: { code: "oidc_state_expired" } };
  }
  if (
    row.provider !== "google" ||
    typeof row.pkceVerifier !== "string" ||
    typeof row.oidcNonceHash !== "string" ||
    typeof row.redirectPath !== "string"
  ) {
    return { ok: false, error: { code: "oidc_state_missing" } };
  }
  const redirect = parseApprovalRedirectPath(row.redirectPath);
  if (redirect === null) {
    return { ok: false, error: { code: "oidc_state_missing" } };
  }
  return {
    ok: true,
    value: {
      pkceVerifier: row.pkceVerifier,
      oidcNonceHash: row.oidcNonceHash,
      redirectPath: redirect.redirectPath,
      approvalChallenge: redirect.challenge,
    },
  };
}

function parseJwtHeader(raw: unknown): Result<JwtHeader, { code: "invalid" }> {
  return isRecord(raw) && raw.alg === "RS256" && typeof raw.kid === "string"
    ? { ok: true, value: { alg: raw.alg, kid: raw.kid } }
    : { ok: false, error: { code: "invalid" } };
}

function parseGoogleClaims(
  raw: unknown,
): Result<GoogleClaims, { code: "invalid" }> {
  if (
    !isRecord(raw) ||
    typeof raw.iss !== "string" ||
    typeof raw.aud !== "string" ||
    typeof raw.sub !== "string" ||
    typeof raw.exp !== "number" ||
    typeof raw.iat !== "number" ||
    typeof raw.nonce !== "string" ||
    typeof raw.email !== "string" ||
    raw.email_verified !== true ||
    typeof raw.name !== "string"
  ) {
    return { ok: false, error: { code: "invalid" } };
  }
  return {
    ok: true,
    value: {
      iss: raw.iss,
      aud: raw.aud,
      sub: raw.sub,
      exp: raw.exp,
      iat: raw.iat,
      nonce: raw.nonce,
      email: raw.email,
      email_verified: true,
      name: raw.name,
    },
  };
}

function parseRsaJwk(
  raw: unknown,
): (JsonWebKey & { readonly kid: string }) | null {
  if (
    !isRecord(raw) ||
    raw.kty !== "RSA" ||
    typeof raw.kid !== "string" ||
    typeof raw.n !== "string" ||
    typeof raw.e !== "string"
  ) {
    return null;
  }
  return {
    kty: "RSA",
    kid: raw.kid,
    n: raw.n,
    e: raw.e,
    alg: "RS256",
    use: "sig",
  };
}

function decodeJson(encoded: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeLenientBase64Url(encoded)));
  } catch {
    return null;
  }
}

/**
 * Lenient base64url for the Google ID token: like atob it also takes padding
 * and the standard alphabet, and it throws on input that atob refuses.
 */
function decodeLenientBase64Url(encoded: string): Uint8Array {
  return Uint8Array.from(atob(paddedStandardBase64(encoded)), charCode);
}

function charCode(value: string): number {
  return value.charCodeAt(0);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function normalizeRedirectPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    !path.startsWith("/") ||
    path.startsWith("//")
  ) {
    return "/portal";
  }
  let parsed: URL;
  try {
    parsed = new URL(path, REDIRECT_ORIGIN);
  } catch {
    return "/portal";
  }
  if (
    parsed.origin !== REDIRECT_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.host !== "satyr.invalid" ||
    parsed.pathname.includes("\\")
  ) {
    return "/portal";
  }
  try {
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath.includes("\\") || decodedPath.startsWith("//")) {
      return "/portal";
    }
  } catch {
    return "/portal";
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function encodeApprovalRedirectPath(
  path: string,
  authentication: GoogleOidcAuthentication,
): string {
  const normalized = normalizeRedirectPath(path);
  const parsed = new URL(normalized, REDIRECT_ORIGIN);
  parsed.searchParams.delete(APPROVAL_STATE_PARAM);
  if (authentication.kind === "sign_in") {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  parsed.searchParams.set(
    APPROVAL_STATE_PARAM,
    encodeBase64Url(
      new TextEncoder().encode(JSON.stringify(authentication.challenge)),
    ),
  );
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function parseApprovalRedirectPath(path: string): {
  readonly redirectPath: string;
  readonly challenge: ApprovalActionBinding | null;
} | null {
  const normalized = normalizeRedirectPath(path);
  if (
    normalized === "/portal" &&
    path !== "/portal" &&
    !path.startsWith("/portal?")
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized, REDIRECT_ORIGIN);
  } catch {
    return null;
  }
  const marker = parsed.searchParams.get(APPROVAL_STATE_PARAM);
  parsed.searchParams.delete(APPROVAL_STATE_PARAM);
  const challenge =
    marker === null ? null : parseApprovalChallengeMarker(marker);
  if (marker !== null && challenge === null) {
    return null;
  }
  return {
    redirectPath: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    challenge,
  };
}

function parseApprovalChallengeMarker(
  raw: string,
): ApprovalActionBinding | null {
  const decoded = decodeBase64Url(raw);
  if (decoded === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
    if (
      !isRecord(parsed) ||
      typeof parsed.stepUpId !== "string" ||
      typeof parsed.organisationId !== "string" ||
      typeof parsed.actionNonce !== "string" ||
      typeof parsed.actionDigest !== "string" ||
      !isRecord(parsed.policy) ||
      parsed.policy.kind !== "unversioned_default" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    const organisationResult = parseOrganisationId(parsed.organisationId);
    const organisationId = organisationResult.ok
      ? organisationResult.value
      : null;
    const actionDigest = parseApprovalProofDigest(parsed.actionDigest);
    if (
      organisationId === null ||
      actionDigest === null ||
      !Number.isSafeInteger(parsed.issuedAt) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= parsed.issuedAt ||
      parsed.stepUpId.length === 0 ||
      parsed.stepUpId.length > 128 ||
      parsed.actionNonce.length === 0 ||
      parsed.actionNonce.length > 128
    ) {
      return null;
    }
    return {
      stepUpId: parsed.stepUpId,
      organisationId,
      actionNonce: parsed.actionNonce,
      actionDigest,
      policy: { kind: "unversioned_default" },
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function sameChallenge(
  left: ApprovalActionBinding,
  right: ApprovalActionBinding,
): boolean {
  return (
    left.stepUpId === right.stepUpId &&
    left.organisationId === right.organisationId &&
    left.actionNonce === right.actionNonce &&
    left.actionDigest === right.actionDigest &&
    left.policy.kind === right.policy.kind &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt
  );
}

function parseGoogleApprovalGrant(raw: unknown): GoogleApprovalGrant | null {
  if (
    !isRecord(raw) ||
    typeof raw.stateHash !== "string" ||
    typeof raw.userId !== "string" ||
    !isRecord(raw.challenge)
  ) {
    return null;
  }
  const userId = parseUserId(raw.userId);
  if (!userId.ok) {
    return null;
  }
  const challenge = parseApprovalChallengeMarker(
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(raw.challenge))),
  );
  return challenge === null
    ? null
    : {
        stateHash: raw.stateHash,
        userId: userId.value,
        challenge,
      };
}

async function importGrantKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

