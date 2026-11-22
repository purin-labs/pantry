import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { describe, expect, it } from "vitest";

import { handleControlRequest } from "../src/control-router";
import { issueControlSession, upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { registerEmailMailboxAccount } from "../src/data/email-mailbox";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import { type IntegrationAccountId, type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireIntegrationAccountId, requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_784_016_325_277;
const ORIGIN = "https://pantry.example";

describe("agent mailbox control routes", agentMailboxControlSuite);

function agentMailboxControlSuite(): void {
  it("refuses an enabled policy before any assignment", unassignedPolicyTest);
  it("rejects invalid policy publishes and unknown mailboxes", rejectionTest);
  it("resumes paused processing through explicit policy actions", resumeTest);
  it(
    "reconnects by standing the runtime down before re-establishing it",
    reconnectTest,
  );
  it(
    "disables processing as an explicit operator policy revision",
    disableTest,
  );
  it(
    "refuses revocation that is not authorized before touching the mailbox",
    revokeGuardTest,
  );
  it(
    "keeps each connected mailbox's binding and policy independent",
    multiMailboxTest,
  );
}

/**
 * Two mailboxes in one organisation are two separate configurations. A support
 * address and a billing address will not share an agent or a set of limits,
 * and pausing or disabling one must not silently stop the other.
 */
async function multiMailboxTest(): Promise<void> {
  const fixture = await createFixture("multi");
  const second = await connectSecondMailbox(fixture, "billing");
  await seedInstallation(fixture, "install_support");
  await seedInstallation(fixture, "install_billing");

  await postMailbox(fixture, "bind", "bind-multi-01", {
    installationId: "install_support",
  });
  await postAccountMailbox(fixture, second, "bind", "bind-multi-02", {
    installationId: "install_billing",
  });

  const supportPolicy = await postMailbox(
    fixture,
    "policy",
    "policy-multi-01",
    {
      policy: enabledPolicy(),
    },
  );
  expect(supportPolicy.status).toBe(200);
  const billingPolicy = await postAccountMailbox(
    fixture,
    second,
    "policy",
    "policy-multi-02",
    {
      policy: {
        ...enabledPolicy(),
        maxActiveCases: 9,
        dailyTokenBudget: 500_000,
      },
    },
  );
  expect(billingPolicy.status).toBe(200);

  // Each mailbox reports its own agent and its own limits.
  const support = await readMailbox(fixture, fixture.integrationAccountId);
  const billing = await readMailbox(fixture, second);
  expect(support.binding.installation_id).toBe("install_support");
  expect(billing.binding.installation_id).toBe("install_billing");
  expect(support.policy).toMatchObject({ kind: "enabled", maxActiveCases: 3 });
  expect(billing.policy).toMatchObject({ kind: "enabled", maxActiveCases: 9 });

  // Each activates its own Connector, so limits never leak between them.
  const activations = fixture.connector.calls.filter(
    (call) => call.method === "activateEmailProcessing",
  );
  expect(activations).toHaveLength(2);
  expect(
    new Set(activations.map((call) => String(call.input.integrationAccountId)))
      .size,
  ).toBe(2);

  // Disabling one leaves the other running.
  const disabled = await postAccountMailbox(
    fixture,
    second,
    "disable",
    "disable-multi-01",
    {},
  );
  expect(disabled.status).toBe(200);
  expect((await readMailbox(fixture, second)).policy.kind).toBe(
    "disabled_by_operator",
  );
  expect(
    (await readMailbox(fixture, fixture.integrationAccountId)).policy.kind,
  ).toBe("enabled");
}

async function connectSecondMailbox(
  fixture: Fixture,
  slug: string,
): Promise<string> {
  const connected = await createConnectedIntegration(
    fixture.db,
    gmailSeed(
      fixture.organisationId,
      fixture.userId,
      `G-${slug.toUpperCase()}`,
      NOW + 1,
    ),
  );
  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 2,
  });
  const registered = await registerEmailMailboxAccount({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: `google-sub-${slug}`,
    observedAddress: `${slug}@example.com`,
    now: NOW + 3,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return connected.account.integrationAccountId;
}

async function postAccountMailbox(
  fixture: Fixture,
  integrationAccountId: string,
  action: string,
  idempotencyKey: string,
  body: unknown,
): Promise<Response> {
  return handleControlRequest(
    mailboxRequest(
      fixture,
      `${integrationAccountId}/${action}`,
      idempotencyKey,
      body,
    ),
    fixture.env,
  );
}

async function readMailbox(
  fixture: Fixture,
  integrationAccountId: string,
): Promise<{
  readonly binding: { readonly installation_id: string };
  readonly policy: { readonly kind: string; readonly maxActiveCases?: number };
}> {
  const response = await handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/agent-mailboxes/${integrationAccountId}`,
      { headers: sessionHeaders(fixture) },
    ),
    fixture.env,
  );
  const body = (await response.json()) as {
    readonly mailbox: {
      readonly binding: { readonly installation_id: string };
      readonly policy: {
        readonly kind: string;
        readonly maxActiveCases?: number;
      };
    };
  };
  return body.mailbox;
}

async function reconnectTest(): Promise<void> {
  const fixture = await createFixture("reconnect");
  await seedInstallation(fixture, "install_reconnect");
  await postMailbox(fixture, "bind", "bind-reconnect-01", {
    installationId: "install_reconnect",
  });
  await postMailbox(fixture, "policy", "policy-reconnect-01", {
    policy: enabledPolicy(),
  });
  fixture.connector.calls.length = 0;

  // A credential reconnection keeps the cursor: mail that arrived while
  // authorization was broken sits behind it and must still be caught up.
  const reconnected = await postMailbox(
    fixture,
    "reconnect",
    "reconnect-route-01",
    {},
  );
  expect(reconnected.status).toBe(200);
  await expect(reconnected.json()).resolves.toMatchObject({
    processing: "scheduled",
    cursor_reset: false,
  });
  const kept = fixture.connector.calls.find(
    (call) => call.method === "reconnectEmailProcessing",
  );
  expect(kept?.input).toMatchObject({ resetCursor: false, policyVersion: 1 });
  const lifecycle = await fixture.db
    .prepare(
      `SELECT lifecycle, lifecycle_reason_code AS reasonCode
       FROM integration_account WHERE integration_account_id = ?`,
    )
    .bind(fixture.integrationAccountId)
    .first<{
      readonly lifecycle: string;
      readonly reasonCode: string | null;
    }>();
  expect(lifecycle).toEqual({ lifecycle: "active", reasonCode: null });

  // A cursor Gmail can no longer serve cannot be caught up, so that case — and
  // only that case — takes a fresh floor.
  await setIntegrationAccountLifecycle({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: requireIntegrationAccountId(
      fixture.integrationAccountId,
    ),
    lifecycle: { kind: "degraded", reasonCode: "gmail_history_expired" },
    now: NOW + 10,
  });
  fixture.connector.calls.length = 0;
  const afterExpiry = await postMailbox(
    fixture,
    "reconnect",
    "reconnect-route-02",
    {},
  );
  expect(afterExpiry.status).toBe(200);
  await expect(afterExpiry.json()).resolves.toMatchObject({
    cursor_reset: true,
  });
  const reset = fixture.connector.calls.find(
    (call) => call.method === "reconnectEmailProcessing",
  );
  expect(reset?.input).toMatchObject({ resetCursor: true });

  const rejectsBody = await postMailbox(
    fixture,
    "reconnect",
    "reconnect-route-03",
    { force: true },
  );
  expect(rejectsBody.status).toBe(422);
}

async function disableTest(): Promise<void> {
  const fixture = await createFixture("disable");
  await seedInstallation(fixture, "install_disable");
  await postMailbox(fixture, "bind", "bind-disable-01", {
    installationId: "install_disable",
  });
  await postMailbox(fixture, "policy", "policy-disable-01", {
    policy: enabledPolicy(),
  });

  const disabled = await postMailbox(
    fixture,
    "disable",
    "disable-route-01",
    {},
  );
  expect(disabled.status).toBe(200);
  await expect(disabled.json()).resolves.toMatchObject({
    policy: { kind: "disabled_by_operator", policyVersion: 2 },
    processing: "waiting",
  });
  expect(
    fixture.connector.calls.some(
      (call) => call.method === "disableEmailProcessing",
    ),
  ).toBe(true);

  // The disabled state is a published revision, so reading the mailbox back
  // reports it rather than inferring it from a silent runtime.
  const read = await handleControlRequest(readRequest(fixture), fixture.env);
  const projection = (await read.json()) as {
    readonly mailbox: { readonly policy: { readonly kind: string } };
  };
  expect(projection.mailbox.policy.kind).toBe("disabled_by_operator");
}

async function revokeGuardTest(): Promise<void> {
  const fixture = await createFixture("revoke");
  await seedInstallation(fixture, "install_revoke");
  await postMailbox(fixture, "bind", "bind-revoke-01", {
    installationId: "install_revoke",
  });
  await postMailbox(fixture, "policy", "policy-revoke-01", {
    policy: enabledPolicy(),
  });
  fixture.connector.calls.length = 0;

  // Revocation is destructive, so it carries the same configuration-version
  // precondition as every other destructive account mutation.
  const unversioned = await postMailbox(
    fixture,
    "revoke",
    "revoke-route-01",
    {},
  );
  expect(unversioned.status).toBe(422);

  const stale = await handleControlRequest(
    versionedMailboxRequest(fixture, "revoke", "revoke-route-02", 999),
    fixture.env,
  );
  expect(stale.status).toBe(409);

  // Nothing may be torn down until revocation is authorized.
  expect(
    fixture.connector.calls.some(
      (call) => call.method === "revokeEmailMailbox",
    ),
  ).toBe(false);
}

function versionedMailboxRequest(
  fixture: Fixture,
  action: string,
  idempotencyKey: string,
  configurationVersion: number,
): Request {
  return new Request(
    `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/agent-mailboxes/${fixture.integrationAccountId}/${action}`,
    {
      method: "POST",
      headers: {
        ...sessionHeaders(fixture),
        "content-type": "application/json",
        origin: ORIGIN,
        "x-pantry-csrf": fixture.csrfToken,
        "idempotency-key": idempotencyKey,
        "x-pantry-configuration-version": String(configurationVersion),
      },
      body: "{}",
    },
  );
}

async function resumeTest(): Promise<void> {
  const fixture = await createFixture("resume");
  const installation = await seedInstallation(fixture, "install_resume");
  const bound = await postMailbox(fixture, "bind", "bind-resume-01", {
    installationId: installation,
  });
  expect(bound.status).toBe(200);
  const published = await postMailbox(fixture, "policy", "policy-resume-01", {
    policy: enabledPolicy(),
  });
  expect(published.status).toBe(200);

  const resumed = await postMailbox(fixture, "resume", "resume-route-01", {});
  expect(resumed.status).toBe(200);
  await expect(resumed.json()).resolves.toMatchObject({
    processing: "scheduled",
  });
  const resumeCall = fixture.connector.calls.find(
    (call) => call.method === "resumeEmailProcessing",
  );
  expect(resumeCall?.input).toMatchObject({
    policyVersion: 1,
    skipProviderMessageId: null,
  });

  const skipped = await postMailbox(
    fixture,
    "skip-and-resume",
    "skip-route-01",
    {
      providerMessageId: "message-oversized",
    },
  );
  expect(skipped.status).toBe(200);
  const skipCall = fixture.connector.calls
    .filter((call) => call.method === "resumeEmailProcessing")
    .at(-1);
  expect(skipCall?.input).toMatchObject({
    skipProviderMessageId: "message-oversized",
  });

  fixture.connector.resumeOutcome = {
    ok: false,
    code: "connector_email_not_paused",
  };
  const notPaused = await postMailbox(fixture, "resume", "resume-route-02", {});
  expect(notPaused.status).toBe(409);
  await expect(notPaused.json()).resolves.toMatchObject({
    error: "agent_mailbox_not_paused",
  });
}

async function unassignedPolicyTest(): Promise<void> {
  const fixture = await createFixture("unassigned");
  const refused = await postMailbox(fixture, "policy", "policy-unassigned", {
    policy: enabledPolicy(),
  });
  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({
    error: "agent_mailbox_unassigned",
  });

  const disabled = await postMailbox(fixture, "policy", "policy-disabled", {
    policy: { kind: "disabled_by_operator" },
  });
  expect(disabled.status).toBe(200);
  await expect(disabled.json()).resolves.toMatchObject({
    policy: { kind: "disabled_by_operator", policyVersion: 1 },
  });
}

async function rejectionTest(): Promise<void> {
  const fixture = await createFixture("rejection");
  const invalid = await postMailbox(fixture, "policy", "policy-invalid", {
    policy: { kind: "enabled", maxActiveCases: 0 },
  });
  expect(invalid.status).toBe(422);

  const unknown = await handleControlRequest(
    mailboxRequest(fixture, "integration_missing/bind", "bind-route-unknown", {
      installationId: "install_missing",
    }),
    fixture.env,
  );
  expect(unknown.status).toBe(404);

  const wrongMethod = await handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/agent-mailboxes/${fixture.integrationAccountId}/bind`,
      { headers: sessionHeaders(fixture) },
    ),
    fixture.env,
  );
  expect(wrongMethod.status).toBe(405);
}

type ConnectorCall = {
  readonly method: string;
  readonly input: Record<string, unknown>;
};

type FakeConnector = {
  readonly calls: ConnectorCall[];
  resumeOutcome:
    { readonly ok: true } | { readonly ok: false; readonly code: string };
};

type Fixture = {
  readonly env: UnitTestEnv;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly userId: UserId;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly connector: FakeConnector;
};

function fakeConnectorNamespace(connector: FakeConnector): unknown {
  const runtimeSnapshot = (
    processing: Record<string, unknown>,
  ): Record<string, unknown> => ({
    organisationId: "organisation",
    integrationAccountId: "integration",
    policyVersion: 1,
    limits: {},
    activationFloor: "1",
    acceptedHistoryId: "1",
    highestObservedHistoryId: "1",
    watchExpiresAt: null,
    processing,
    lastEvaluationStartedAt: null,
    disabledAt: null,
  });
  const stub = {
    async activate() {
      return { ok: true, value: { stateVersion: 1 } };
    },
    async activateEmailProcessing(input: Record<string, unknown>) {
      connector.calls.push({ method: "activateEmailProcessing", input });
      return {
        ok: true,
        value: runtimeSnapshot({ kind: "scheduled", at: NOW }),
      };
    },
    async disableEmailProcessing(input: Record<string, unknown>) {
      connector.calls.push({ method: "disableEmailProcessing", input });
      return { ok: true, value: null };
    },
    async reconnectEmailProcessing(input: Record<string, unknown>) {
      connector.calls.push({ method: "reconnectEmailProcessing", input });
      return {
        ok: true,
        value: runtimeSnapshot({ kind: "scheduled", at: NOW }),
      };
    },
    async revokeEmailMailbox(input: Record<string, unknown>) {
      connector.calls.push({ method: "revokeEmailMailbox", input });
      return { ok: true, value: { watchStopped: true, disposals: [] } };
    },
    async resumeEmailProcessing(input: Record<string, unknown>) {
      connector.calls.push({ method: "resumeEmailProcessing", input });
      return connector.resumeOutcome.ok
        ? { ok: true, value: runtimeSnapshot({ kind: "scheduled", at: NOW }) }
        : { ok: false, error: { code: connector.resumeOutcome.code } };
    },
    async inspectEmailRuntime() {
      connector.calls.push({ method: "inspectEmailRuntime", input: {} });
      return {
        ok: true,
        value: {
          ...runtimeSnapshot({ kind: "scheduled", at: NOW }),
          usage: {
            activeCases: 1,
            admittedLastHour: 2,
            tokens: { reserved: 5_000, consumed: 12_000 },
            nextEvaluationAt: NOW + 60_000,
          },
        },
      };
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return namespace;
}

async function createFixture(slug: string): Promise<Fixture> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `${slug}-owner`,
      email: `${slug}@example.com`,
      displayName: `${slug} owner`,
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: `Mailbox Route ${slug}`,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const connected = await createConnectedIntegration(
    db,
    gmailSeed(
      organisation.organisationId,
      owner.userId,
      `G-${slug.toUpperCase()}`,
      NOW + 1,
    ),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 2,
  });
  const registered = await registerEmailMailboxAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: `google-sub-${slug}`,
    observedAddress: `owner-${slug}@example.com`,
    now: NOW + 3,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  const issued = await issueControlSession({
    db,
    userId: owner.userId,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  const connector: FakeConnector = { calls: [], resumeOutcome: { ok: true } };
  const testEnv = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    PANTRY_PUBLIC_ORIGIN: ORIGIN,
    CONNECTOR: fakeConnectorNamespace(connector),
  });
  return {
    env: testEnv,
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    userId: owner.userId,
    sessionToken: issued.token,
    csrfToken: issued.csrfToken,
    connector,
  };
}

async function postMailbox(
  fixture: Fixture,
  action:
    | "bind"
    | "policy"
    | "resume"
    | "skip-and-resume"
    | "reconnect"
    | "disable"
    | "revoke",
  idempotencyKey: string,
  body: unknown,
): Promise<Response> {
  return handleControlRequest(
    mailboxRequest(
      fixture,
      `${fixture.integrationAccountId}/${action}`,
      idempotencyKey,
      body,
    ),
    fixture.env,
  );
}

function mailboxRequest(
  fixture: Fixture,
  path: string,
  idempotencyKey: string,
  body: unknown,
): Request {
  return new Request(
    `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/agent-mailboxes/${path}`,
    {
      method: "POST",
      headers: {
        ...sessionHeaders(fixture),
        "content-type": "application/json",
        origin: ORIGIN,
        "x-pantry-csrf": fixture.csrfToken,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}

function readRequest(fixture: Fixture): Request {
  return new Request(
    `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/agent-mailboxes/${fixture.integrationAccountId}`,
    { headers: sessionHeaders(fixture) },
  );
}

function sessionHeaders(fixture: Fixture): Record<string, string> {
  return {
    cookie: `pantry_session=${fixture.sessionToken}; pantry_csrf=${fixture.csrfToken}`,
  };
}

async function seedInstallation(
  fixture: Fixture,
  installationId: string,
): Promise<string> {
  const definitionId = `${installationId}_definition`;
  await fixture.db
    .prepare(
      `INSERT INTO agent_definition (
       agent_definition_id, organisation_id, display_name, role, purpose, lifecycle,
       current_revision, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, 'Mailbox Agent', 'assistant', 'email replies', 'active', 1, ?, ?, ?)`,
    )
    .bind(definitionId, fixture.organisationId, fixture.userId, NOW, NOW)
    .run();
  await fixture.db
    .prepare(
      `INSERT INTO agent_definition_revision (
       agent_definition_id, organisation_id, revision, instructions,
       requested_capabilities_json, skill_refs_json, content_digest,
       authored_by_user_id, created_at
     ) VALUES (?, ?, 1, 'reply politely', '[]', '[]', ?, ?, ?)`,
    )
    .bind(
      definitionId,
      fixture.organisationId,
      "0".repeat(64),
      fixture.userId,
      NOW,
    )
    .run();
  await fixture.db
    .prepare(
      `INSERT INTO agent_installation (
       installation_id, organisation_id, agent_definition_id, definition_revision,
       policy_revision, granted_capabilities_json, lifecycle,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, '["commerce_entity_context"]', 'active', ?, ?, ?)`,
    )
    .bind(
      installationId,
      fixture.organisationId,
      definitionId,
      fixture.userId,
      NOW,
      NOW,
    )
    .run();
  return installationId;
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

function enabledPolicy(): Record<string, unknown> {
  return {
    kind: "enabled",
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 250_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    overflow: "pause_and_notify",
  };
}
