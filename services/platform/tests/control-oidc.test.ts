import { describe, expect, it } from "vitest";

import {
  beginGoogleOidc,
  completeGoogleOidc,
  consumeGoogleApprovalCeremony,
  issueGoogleApprovalGrant,
  verifyGoogleApprovalGrant,
  type GoogleOidcFetcher,
} from "../src/control/oidc";
import {
  approvalActionBindingMatches,
  parseApprovalEvidence,
  parseApprovalProofDigest,
} from "../src/approval-authentication";
import {
  parseUserId,
  parseIntegrationAccountId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_783_987_896_426;
const CONFIG = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://satyr.example/v1/control/auth/google/callback",
} as const;

describe("Google control OIDC", () => {
  it("requests an interactive Google reauthentication for approval step-up", async () => {
    const db = createMigratedDatabase();
    const started = await beginGoogleOidc({
      db,
      config: CONFIG,
      redirectPath: "/portal/organisation",
      authentication: {
        kind: "approval_step_up",
        challenge: approvalChallenge(),
      },
      now: NOW,
    });

    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get("prompt")).toBe("login");
    expect(authorizationUrl.searchParams.get("max_age")).toBe("0");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  it("verifies a signed ID token and consumes state exactly once", async () => {
    const db = createMigratedDatabase();
    const started = await beginGoogleOidc({
      db,
      config: CONFIG,
      redirectPath: "/portal/organisation",
      authentication: { kind: "sign_in" },
      now: NOW,
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    const state = requireSearchParam(authorizationUrl, "state");
    const nonce = requireSearchParam(authorizationUrl, "nonce");
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
    const exportedKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const publicJwk = requireJsonWebKey(exportedKey);
    const idToken = await signIdToken(keyPair.privateKey, nonce);
    const fetcher = createGoogleFetcher(idToken, publicJwk);

    const completed = await completeGoogleOidc({
      db,
      config: CONFIG,
      state,
      code: "authorization-code",
      now: NOW + 1_000,
      fetcher,
    });
    expect(completed).toEqual({
      ok: true,
      value: {
        identityToken: idToken,
        identity: {
          issuer: "https://accounts.google.com",
          subject: "google-subject",
          email: "owner@example.com",
          displayName: "Owner",
          emailVerified: true,
        },
        redirectPath: "/portal/organisation",
        approvalChallenge: null,
        approvalStateHash: expect.any(String),
      },
    });

    await expect(
      completeGoogleOidc({
        db,
        config: CONFIG,
        state,
        code: "authorization-code",
        now: NOW + 2_000,
        fetcher,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "oidc_state_consumed" } });
  });

  it("rejects invalid action-bound approval evidence before provider authority", async () => {
    const db = createMigratedDatabase();
    const challenge = approvalChallenge();
    const started = await beginGoogleOidc({
      db,
      config: CONFIG,
      redirectPath: "/portal/organisation/actions/action_control_oidc",
      authentication: { kind: "approval_step_up", challenge },
      now: NOW,
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    const state = requireSearchParam(authorizationUrl, "state");
    const nonce = requireSearchParam(authorizationUrl, "nonce");
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
    const exportedKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const idToken = await signIdToken(keyPair.privateKey, nonce);
    const completed = await completeGoogleOidc({
      db,
      config: CONFIG,
      state,
      code: "approval-authorization-code",
      now: NOW + 1_000,
      fetcher: createGoogleFetcher(idToken, requireJsonWebKey(exportedKey)),
    });
    if (!completed.ok || completed.value.approvalChallenge === null) {
      throw new Error("approval fixture did not complete");
    }

    expect(
      await consumeGoogleApprovalCeremony({
        db,
        stateHash: completed.value.approvalStateHash,
        challenge: completed.value.approvalChallenge,
      }),
    ).toBe(true);
    expect(
      await consumeGoogleApprovalCeremony({
        db,
        stateHash: completed.value.approvalStateHash,
        challenge: completed.value.approvalChallenge,
      }),
    ).toBe(false);

    const userId = parseUserId(
      "user_35a9eacf-1489-5d2b-ae76-14b63713ff71",
    );
    if (!userId.ok)
      throw new Error("invalid control identity fixture");
    const grant = await issueGoogleApprovalGrant(
      {
        stateHash: completed.value.approvalStateHash,
        userId: userId.value,
        challenge,
      },
      CONFIG.clientSecret,
    );
    await expect(
      verifyGoogleApprovalGrant({
        raw: grant,
        clientSecret: CONFIG.clientSecret,
        now: challenge.expiresAt,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "approval_grant_expired" },
    });

    const action = approvalAction();
    expect(
      approvalActionBindingMatches(challenge, action, challenge.actionDigest),
    ).toBe(true);
    const changedDigest = parseApprovalProofDigest("22".repeat(32));
    if (changedDigest === null)
      throw new Error("invalid changed digest fixture");
    expect(approvalActionBindingMatches(challenge, action, changedDigest)).toBe(
      false,
    );
    expect(
      approvalActionBindingMatches(
        challenge,
        { ...action, organisationId: otherOrganisationId() },
        challenge.actionDigest,
      ),
    ).toBe(false);
    expect(
      approvalActionBindingMatches(
        challenge,
        {
          ...action,
          nonce: { value: "another_action_nonce" },
        },
        challenge.actionDigest,
      ),
    ).toBe(false);

    expect(
      parseApprovalEvidence(
        rawControlApprovalEvidence("operator", "unversioned_default"),
      ).ok,
    ).toBe(false);
    expect(
      parseApprovalEvidence(
        rawControlApprovalEvidence("owner", "versioned_policy"),
      ).ok,
    ).toBe(false);
    expect(
      parseApprovalEvidence({
        kind: "agent_session",
        principal: {
          kind: "agent_session",
          sessionId: "session_requesting_agent",
          role: "approve",
        },
        authentication: { kind: "embedded_harness" },
      }).ok,
    ).toBe(false);
  });
});

function approvalChallenge() {
  const organisationId = parseOrganisationId("organisation_control_oidc");
  const actionDigest = parseApprovalProofDigest("11".repeat(32));
  if (!organisationId.ok || actionDigest === null)
    throw new Error("invalid approval fixture");
  return {
    stepUpId: "fixture:control_oidc",
    organisationId: organisationId.value,
    actionNonce: "action_control_oidc",
    actionDigest,
    policy: { kind: "unversioned_default" as const },
    issuedAt: NOW,
    expiresAt: NOW + 600_000,
  };
}

function approvalAction() {
  const organisationId = parseOrganisationId("organisation_control_oidc");
  const integrationAccountId = parseIntegrationAccountId(
    "integration_control_oidc",
  );
  const sessionId = parseSessionId("session_control_oidc");
  if (!organisationId.ok || !integrationAccountId.ok || !sessionId.ok) {
    throw new Error("invalid approval action fixture");
  }
  return {
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    threadId: "case_control_oidc",
    sessionId: sessionId.value,
    host: "satyr.commerce",
    verb: "commerce.order.cancel",
    path: "/orders/order_control_oidc/cancel?expected_revision=1&reason=customer_requested&refund=none&restock=false&notify_customer=false&note=",
    argsHash: "approval-action-args",
    amount: null,
    nonce: { value: "action_control_oidc" },
    exp: NOW + 600_000,
    resourceKey: "commerce:cancel_order:order_control_oidc",
  };
}

function otherOrganisationId() {
  const organisationId = parseOrganisationId("organisation_control_oidc_other");
  if (!organisationId.ok) throw new Error("invalid cross-organisation fixture");
  return organisationId.value;
}

function rawControlApprovalEvidence(role: string, policyKind: string): unknown {
  return {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: "user_35a9eacf-1489-5d2b-ae76-14b63713ff71",
      personId: "person_approval_boundary",
      role,
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: "control_session_approval_boundary",
      authenticatedAt: NOW,
      challenge: {
        ...approvalChallenge(),
        policy: { kind: policyKind },
      },
    },
  };
}

function createGoogleFetcher(
  idToken: string,
  publicJwk: JsonWebKey,
): GoogleOidcFetcher {
  GoogleFetchStub.configure(idToken, publicJwk);
  return GoogleFetchStub.fetch;
}

class GoogleFetchStub {
  private static idToken: string;
  private static publicJwk: JsonWebKey;

  static configure(idToken: string, publicJwk: JsonWebKey): void {
    GoogleFetchStub.idToken = idToken;
    GoogleFetchStub.publicJwk = publicJwk;
  }

  static async fetch(
    this: unknown,
    input: RequestInfo | URL,
  ): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ id_token: GoogleFetchStub.idToken });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({
        keys: [
          {
            ...GoogleFetchStub.publicJwk,
            kid: "test-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }
    return new Response(null, { status: 404 });
  }
}

function requireCryptoKeyPair(value: CryptoKey | CryptoKeyPair): CryptoKeyPair {
  if (!("publicKey" in value)) {
    throw new Error("expected an RSA key pair");
  }
  return value;
}

function requireJsonWebKey(value: ArrayBuffer | JsonWebKey): JsonWebKey {
  if (value instanceof ArrayBuffer) {
    throw new Error("expected a JWK export");
  }
  return value;
}

async function signIdToken(
  privateKey: CryptoKey,
  nonce: string,
): Promise<string> {
  const nowSeconds = Math.floor(NOW / 1000);
  const header = encodeJson({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const claims = encodeJson({
    iss: "https://accounts.google.com",
    aud: CONFIG.clientId,
    sub: "google-subject",
    exp: nowSeconds + 600,
    iat: nowSeconds,
    nonce,
    email: "owner@example.com",
    email_verified: true,
    name: "Owner",
  });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBytes(new Uint8Array(signature))}`;
}

function encodeJson(value: unknown): string {
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

function requireSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
