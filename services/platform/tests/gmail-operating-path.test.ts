import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/integration-gateway";
import { upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { registerEmailMailboxAccount } from "../src/data/email-mailbox";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { testExecutionContext, type UnitTestEnv } from "./worker-fakes";

const AUDIENCE = "https://pantry.example/hook/email/google";
const SERVICE_ACCOUNT = "gmail-push@pantry-project.iam.gserviceaccount.com";
const ADDRESS = "support@example.com";

describe("gmail operating path ingress", ingressSuite);

afterEach(() => {
  vi.unstubAllGlobals();
});

function ingressSuite(): void {
  it(
    "carries one verified push through the queue into the mailbox Connector",
    deliveryTest,
  );
  it(
    "drops unroutable and malformed hints without asking Google to retry",
    droppableTest,
  );
  it(
    "refuses unsigned pushes and reports missing configuration distinctly",
    rejectionTest,
  );
  it(
    "routes each organisation mailbox independently when several are connected",
    multiMailboxTest,
  );
}

/**
 * An organisation may connect more than one Gmail account, and a hint names only the
 * mailbox it belongs to. Routing has to reach that mailbox's own Connector:
 * delivering a support mailbox's mail to the billing mailbox's agent would be
 * a cross-mailbox disclosure inside one organisation, and each mailbox carries its
 * own binding and policy.
 */
async function multiMailboxTest(): Promise<void> {
  const fixture = await createFixture("multi");
  const second = await connectAdditionalMailbox(
    fixture,
    "billing",
    "billing@example.com",
  );

  const toFirst = await fixture.push({
    emailAddress: ADDRESS,
    historyId: "5100",
  });
  expect(toFirst.status).toBe(200);
  const toSecond = await fixture.push({
    emailAddress: "billing@example.com",
    historyId: "5200",
  });
  expect(toSecond.status).toBe(200);

  expect(fixture.queued).toHaveLength(2);
  expect(fixture.queued[0]).toMatchObject({
    integrationAccountId: fixture.integrationAccountId,
    historyId: "5100",
  });
  expect(fixture.queued[1]).toMatchObject({
    integrationAccountId: second,
    historyId: "5200",
  });
  expect(second).not.toBe(fixture.integrationAccountId);

  // Each mailbox reaches its own Connector, keyed by its own account id, so
  // one mailbox's cursor and limits can never be advanced by another's mail.
  await fixture.drainQueue();
  const accepted = fixture.connector.calls.filter(
    (call) => call.method === "acceptEmailChange",
  );
  expect(accepted).toHaveLength(2);
  const connectorIds = accepted.map((call) => {
    const identity = call.input.identity as { readonly connectorId: string };
    return identity.connectorId;
  });
  expect(new Set(connectorIds).size).toBe(2);
  expect(connectorIds[0]).toContain(fixture.integrationAccountId);
  expect(connectorIds[1]).toContain(second);
  expect(fixture.retried).toBe(0);
}

async function connectAdditionalMailbox(
  fixture: Fixture,
  slug: string,
  address: string,
): Promise<string> {
  const owner = await upsertUser({
    db: fixture.db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "multi-owner",
      email: "multi@example.com",
      displayName: "multi owner",
      emailVerified: true,
    },
    now: Date.now(),
  });
  const connected = await createConnectedIntegration(
    fixture.db,
    gmailSeed(
      fixture.organisationId,
      owner.userId,
      `P-${slug.toUpperCase()}`,
      Date.now(),
    ),
  );
  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: Date.now(),
  });
  const registered = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: `google-sub-${slug}`,
    observedAddress: address,
    now: Date.now(),
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return connected.account.integrationAccountId;
}

/**
 * A Pub/Sub push is a hint, not data: it names a mailbox and a history point.
 * This exercises the real boundary — signature, audience, service account,
 * routing, durable enqueue, and Connector admission — because every later
 * guarantee assumes a hint can only arrive from Google and can only reach the
 * mailbox it names.
 */
async function deliveryTest(): Promise<void> {
  const fixture = await createFixture("delivery");
  const pushed = await fixture.push({
    emailAddress: ADDRESS,
    historyId: "9100",
  });
  expect(pushed.status).toBe(200);
  await expect(pushed.json()).resolves.toEqual({ kind: "accepted" });

  expect(fixture.queued).toHaveLength(1);
  expect(fixture.queued[0]).toMatchObject({
    type: "email.change.v1",
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    historyId: "9100",
  });
  // The hint carries identifiers only — never a subject, sender, or body.
  expect(JSON.stringify(fixture.queued[0])).not.toContain(ADDRESS);

  await fixture.drainQueue();
  const accepted = fixture.connector.calls.find(
    (call) => call.method === "acceptEmailChange",
  );
  expect(accepted?.input).toMatchObject({
    historyId: "9100",
    identity: { organisationId: fixture.organisationId },
  });
  expect(fixture.retried).toBe(0);
}

async function droppableTest(): Promise<void> {
  const fixture = await createFixture("droppable");

  const unroutable = await fixture.push({
    emailAddress: "nobody@elsewhere.example",
    historyId: "10",
  });
  expect(unroutable.status).toBe(200);
  await expect(unroutable.json()).resolves.toEqual({ kind: "ignored" });

  const malformed = await fixture.pushRaw(
    JSON.stringify({ message: { messageId: "n1" } }),
  );
  expect(malformed.status).toBe(200);
  await expect(malformed.json()).resolves.toEqual({ kind: "ignored" });

  // A hint Pantry cannot route is acknowledged, never retried: Pub/Sub would
  // redeliver it forever and the mailbox cursor already covers the gap.
  expect(fixture.queued).toHaveLength(0);
}

async function rejectionTest(): Promise<void> {
  const fixture = await createFixture("rejection");

  const unsigned = await fixture.pushRaw(
    JSON.stringify({ message: { messageId: "n1", data: "e30=" } }),
    null,
  );
  expect(unsigned.status).toBe(401);

  const foreign = await fixture.push(
    { emailAddress: ADDRESS, historyId: "11" },
    { email: "attacker@evil.example" },
  );
  expect(foreign.status).toBe(401);

  const wrongAudience = await fixture.push(
    { emailAddress: ADDRESS, historyId: "12" },
    { aud: "https://other.example" },
  );
  expect(wrongAudience.status).toBe(401);

  // An unconfigured deployment is a 503, not a 401: the push is not the fault.
  const unconfigured = await fixture.push(
    { emailAddress: ADDRESS, historyId: "13" },
    {},
    { GMAIL_PUBSUB_SERVICE_ACCOUNT: undefined },
  );
  expect(unconfigured.status).toBe(503);
  expect(fixture.queued).toHaveLength(0);
}

type ConnectorCall = {
  readonly method: string;
  readonly input: Record<string, unknown>;
};

type Fixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: string;
  readonly connector: { readonly calls: ConnectorCall[] };
  readonly queued: Record<string, unknown>[];
  retried: number;
  push: (
    hint: Readonly<{ emailAddress: string; historyId: string }>,
    claimOverrides?: Record<string, unknown>,
    envOverrides?: Partial<Record<string, string | undefined>>,
  ) => Promise<Response>;
  pushRaw: (
    body: string,
    authorization?: string | null,
    envOverrides?: Partial<Record<string, string | undefined>>,
  ) => Promise<Response>;
  drainQueue: () => Promise<void>;
};

async function createFixture(slug: string): Promise<Fixture> {
  const db = createMigratedDatabase();
  const signer = await createSigner();
  vi.stubGlobal("fetch", signer.jwksFetcher);

  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `${slug}-owner`,
      email: `${slug}@example.com`,
      displayName: `${slug} owner`,
      emailVerified: true,
    },
    now: Date.now(),
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: `Gmail path ${slug}`,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, Date.now()),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: Date.now(),
  });
  const connected = await createConnectedIntegration(
    db,
    gmailSeed(
      organisation.organisationId,
      owner.userId,
      `P-${slug.toUpperCase()}`,
      Date.now(),
    ),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: Date.now(),
  });
  const registered = await registerEmailMailboxAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: `google-sub-${slug}`,
    observedAddress: ADDRESS,
    now: Date.now(),
  });
  if (!registered.ok) throw new Error(registered.error.code);

  const calls: ConnectorCall[] = [];
  const queued: Record<string, unknown>[] = [];
  const fixture: Fixture = {
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    connector: { calls },
    queued,
    retried: 0,
    push: async (hint, claimOverrides = {}, envOverrides = {}) => {
      const data = btoa(JSON.stringify(hint))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
      const token = await signer.sign({ ...pushClaims(), ...claimOverrides });
      return fixture.pushRaw(
        JSON.stringify({
          message: { messageId: `notif-${hint.historyId}`, data },
        }),
        `Bearer ${token}`,
        envOverrides,
      );
    },
    pushRaw: async (body, authorization, envOverrides = {}) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (authorization === undefined) {
        headers.authorization = `Bearer ${await signer.sign(pushClaims())}`;
      } else if (authorization !== null) {
        headers.authorization = authorization;
      }
      return worker.fetch(
        new Request(`${AUDIENCE}`, { method: "POST", headers, body }),
        env(envOverrides),
        executionContext(),
      );
    },
    drainQueue: async () => {
      const messages = queued.splice(0, queued.length).map((body) => ({
        id: "m1",
        timestamp: new Date(0),
        body,
        attempts: 1,
        ack: () => undefined,
        retry: () => {
          fixture.retried += 1;
        },
      }));
      await worker.queue(
        {
          queue: "pantry-events",
          messages,
          ackAll: () => undefined,
          retryAll: () => undefined,
        } as never,
        env({}),
      );
    },
  };

  function env(
    overrides: Partial<Record<string, string | undefined>>,
  ): UnitTestEnv {
    const base: Record<string, unknown> = {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
      GMAIL_PUBSUB_AUDIENCE: AUDIENCE,
      GMAIL_PUBSUB_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
      EVENT_Q: {
        send: async (body: Record<string, unknown>) => {
          queued.push(body);
        },
      },
      CONNECTOR: fakeConnectorNamespace(calls),
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete base[key];
      else base[key] = value;
    }
    return base as unknown as UnitTestEnv;
  }

  return fixture;
}

function fakeConnectorNamespace(calls: ConnectorCall[]): unknown {
  const stub = {
    async activate() {
      return { ok: true, value: { stateVersion: 1 } };
    },
    async acceptEmailChange(input: Record<string, unknown>) {
      calls.push({ method: "acceptEmailChange", input });
      return { ok: true, value: { kind: "scheduled", at: 1 } };
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return namespace;
}

function executionContext(): ExecutionContext {
  return testExecutionContext({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  });
}

function pushClaims(): Record<string, unknown> {
  const seconds = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    iat: seconds - 10,
    exp: seconds + 3600,
  };
}

type Signer = {
  sign: (payload: Record<string, unknown>) => Promise<string>;
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
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function gmailSeed(
  organisationId: OrganisationId,
  userId: UserId,
  providerAccountId: string,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "gmail",
    providerSubjectId: providerAccountId,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: requireVaultHandle(
        `vault:organisation:gmail:${providerAccountId.toLowerCase()}:oauth:g1`,
      ),
    },
    grantedScopes: ["openid", "email"],
    createdByUserId: userId,
    providerAccountId,
    accountKind: "mailbox",
    displayName: providerAccountId,
    capabilities: ["mailbox.ingress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}
