import { describe, expect, it } from "vitest";

import {
  parseGmailPushEnvelope,
  readGmailPushBody,
  verifyGooglePushToken,
} from "@purin-labs/surface-email/server/gateway/google-pubsub";

const NOW = 1_784_016_325_277;
const AUDIENCE = "https://pantry.example/hook/email/google";
const SERVICE_ACCOUNT = "gmail-push@pantry-project.iam.gserviceaccount.com";

describe("google pubsub push boundary", googlePubsubSuite);

function googlePubsubSuite(): void {
  it(
    "accepts a Google-signed push token for the configured audience",
    acceptTest,
  );
  it("rejects missing, foreign, and tampered tokens", rejectTest);
  it("parses and bounds Gmail push envelopes", envelopeTest);
}

async function acceptTest(): Promise<void> {
  const signer = await createSigner();
  const token = await signer.sign(claims());
  const verified = await verifyGooglePushToken({
    authorizationHeader: `Bearer ${token}`,
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(verified).toEqual({ ok: true, value: null });
}

async function rejectTest(): Promise<void> {
  const signer = await createSigner();
  const missing = await verifyGooglePushToken({
    authorizationHeader: null,
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(missing).toEqual({
    ok: false,
    error: { code: "pubsub_token_missing" },
  });

  const unconfigured = await verifyGooglePushToken({
    authorizationHeader: `Bearer ${await signer.sign(claims())}`,
    audience: undefined,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(unconfigured).toEqual({
    ok: false,
    error: { code: "pubsub_configuration_missing" },
  });

  const wrongAudience = await verifyGooglePushToken({
    authorizationHeader: `Bearer ${await signer.sign(claims({ aud: "https://other.example" }))}`,
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(wrongAudience).toEqual({
    ok: false,
    error: { code: "pubsub_identity_unverified" },
  });

  const wrongAccount = await verifyGooglePushToken({
    authorizationHeader: `Bearer ${await signer.sign(claims({ email: "spoof@example.com" }))}`,
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(wrongAccount).toEqual({
    ok: false,
    error: { code: "pubsub_identity_unverified" },
  });

  const expired = await verifyGooglePushToken({
    authorizationHeader: `Bearer ${await signer.sign(claims({ exp: Math.floor(NOW / 1000) - 3600 }))}`,
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(expired).toEqual({
    ok: false,
    error: { code: "pubsub_identity_unverified" },
  });

  const valid = await signer.sign(claims());
  const tampered = `${valid.slice(0, valid.lastIndexOf(".") + 1)}AAAA`;
  const badSignature = await verifyGooglePushToken({
    authorizationHeader: `Bearer ${tampered}`,
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    fetcher: signer.jwksFetcher,
  });
  expect(badSignature).toEqual({
    ok: false,
    error: { code: "pubsub_identity_unverified" },
  });
}

function envelopeTest(): void {
  const data = btoa(
    JSON.stringify({ emailAddress: "owner@example.com", historyId: 12_345 }),
  );
  const parsed = parseGmailPushEnvelope({
    message: { messageId: "pubsub-1", data },
    subscription: "projects/pantry/subscriptions/gmail",
  });
  expect(parsed).toEqual({
    ok: true,
    value: {
      emailAddress: "owner@example.com",
      historyId: "12345",
      notificationId: "pubsub-1",
    },
  });
  expect(
    parseGmailPushEnvelope({ message: { messageId: "x", data: btoa("{}") } })
      .ok,
  ).toBe(false);
  expect(parseGmailPushEnvelope(null).ok).toBe(false);
  expect(readGmailPushBody("not json")).toBeNull();
  expect(readGmailPushBody("x".repeat(65 * 1024))).toBeNull();
}

function claims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000) - 10,
    sub: "1234567890",
    ...overrides,
  };
}

type Signer = {
  sign(payload: Record<string, unknown>): Promise<string>;
  jwksFetcher: typeof fetch;
};

async function createSigner(): Promise<Signer> {
  const generatedKey = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const keyPair = requireCryptoKeyPair(generatedKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = {
    keys: [{ ...publicJwk, kid: "push-key", alg: "RS256", use: "sig" }],
  };
  return {
    async sign(payload: Record<string, unknown>): Promise<string> {
      const header = encodeSegment({
        alg: "RS256",
        kid: "push-key",
        typ: "JWT",
      });
      const body = encodeSegment(payload);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${body}`),
      );
      return `${header}.${body}.${encodeBytes(new Uint8Array(signature))}`;
    },
    jwksFetcher: (async () => Response.json(jwks)) as typeof fetch,
  };
}

function requireCryptoKeyPair(key: CryptoKey | CryptoKeyPair): CryptoKeyPair {
  if ("publicKey" in key && "privateKey" in key) return key;
  throw new Error("RSA key generation did not return a key pair");
}

function encodeSegment(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
