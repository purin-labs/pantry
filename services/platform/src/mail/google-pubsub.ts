import { paddedStandardBase64 } from "../lenient-base64";
import type { Result } from "../result";
import { decodeBase64, isRecord, parseJsonOrNull } from "@seams/std";

/**
 * Google Cloud Pub/Sub push authentication. Push requests carry a
 * Google-signed OIDC token; unlike the server-side token-endpoint exchange,
 * this JWT arrives over an untrusted channel, so the gateway verifies the
 * RS256 signature against Google's JWKS and requires the configured audience
 * and the expected push service-account identity. Audience and identity are
 * deployment configuration, never Vault secrets.
 */

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const CLOCK_SKEW_SECONDS = 60;
const ENVELOPE_LIMIT = 64 * 1024;

type GooglePushVerificationError =
  | { readonly code: "pubsub_token_missing" }
  | { readonly code: "pubsub_token_invalid" }
  | { readonly code: "pubsub_identity_unverified" }
  | { readonly code: "pubsub_configuration_missing" };

type GmailPushHint = {
  readonly emailAddress: string;
  readonly historyId: string;
  readonly notificationId: string;
};

export async function verifyGooglePushToken(
  input: Readonly<{
    authorizationHeader: string | null;
    audience: string | undefined;
    serviceAccountEmail: string | undefined;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<null, GooglePushVerificationError>> {
  if (input.audience === undefined || input.serviceAccountEmail === undefined) {
    return { ok: false, error: { code: "pubsub_configuration_missing" } };
  }
  const token = readBearerToken(input.authorizationHeader);
  if (token === null)
    return { ok: false, error: { code: "pubsub_token_missing" } };
  const parts = token.split(".");
  if (parts.length !== 3)
    return { ok: false, error: { code: "pubsub_token_invalid" } };
  const header = decodeJson(parts[0] ?? "");
  const claims = decodeJson(parts[1] ?? "");
  if (
    !isRecord(header) ||
    typeof header.kid !== "string" ||
    header.alg !== "RS256" ||
    !isRecord(claims)
  ) {
    return { ok: false, error: { code: "pubsub_token_invalid" } };
  }
  const nowSeconds = Math.floor(input.now / 1000);
  const claimsValid =
    typeof claims.iss === "string" &&
    GOOGLE_ISSUERS.has(claims.iss) &&
    claims.aud === input.audience &&
    claims.email === input.serviceAccountEmail &&
    claims.email_verified === true &&
    typeof claims.exp === "number" &&
    claims.exp + CLOCK_SKEW_SECONDS > nowSeconds &&
    typeof claims.iat === "number" &&
    claims.iat - CLOCK_SKEW_SECONDS <= nowSeconds;
  if (!claimsValid) {
    return { ok: false, error: { code: "pubsub_identity_unverified" } };
  }
  const jwk = await fetchGoogleJwk(input.fetcher, header.kid);
  if (jwk === null)
    return { ok: false, error: { code: "pubsub_token_invalid" } };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = decodeBase64(paddedStandardBase64(parts[2] ?? ""));
    verified =
      signature !== null &&
      (await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ));
  } catch {
    verified = false;
  }
  return verified
    ? { ok: true, value: null }
    : { ok: false, error: { code: "pubsub_identity_unverified" } };
}

export function parseGmailPushEnvelope(
  raw: unknown,
): Result<GmailPushHint, { readonly code: "pubsub_envelope_invalid" }> {
  if (
    !isRecord(raw) ||
    !isRecord(raw.message) ||
    typeof raw.message.messageId !== "string" ||
    raw.message.messageId.length === 0 ||
    typeof raw.message.data !== "string"
  ) {
    return { ok: false, error: { code: "pubsub_envelope_invalid" } };
  }
  const decoded = decodeJson(raw.message.data);
  if (
    !isRecord(decoded) ||
    typeof decoded.emailAddress !== "string" ||
    decoded.emailAddress.length === 0 ||
    !isHistoryId(decoded.historyId)
  ) {
    return { ok: false, error: { code: "pubsub_envelope_invalid" } };
  }
  return {
    ok: true,
    value: {
      emailAddress: decoded.emailAddress,
      historyId: normalizeHistoryId(decoded.historyId),
      notificationId: raw.message.messageId,
    },
  };
}

export function readGmailPushBody(text: string): unknown {
  if (text.length > ENVELOPE_LIMIT) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/u.exec(header);
  return match?.[1] ?? null;
}

async function fetchGoogleJwk(
  fetcher: typeof fetch,
  kid: string,
): Promise<JsonWebKey | null> {
  try {
    const response = await fetcher(new Request(GOOGLE_JWKS_URL));
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    if (!isRecord(raw) || !Array.isArray(raw.keys)) return null;
    for (const key of raw.keys) {
      if (isRecord(key) && key.kid === kid && key.kty === "RSA") {
        return key as unknown as JsonWebKey;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isHistoryId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && /^[0-9]+$/u.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function normalizeHistoryId(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

/** Pub/Sub message data is padded standard base64; token segments are not. */
function decodeJson(segment: string): unknown {
  const bytes = decodeBase64(paddedStandardBase64(segment));
  return bytes === null
    ? null
    : parseJsonOrNull(new TextDecoder().decode(bytes));
}
