import type { SingleDatabase } from "../src/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

const credentialMocks = vi.hoisted(() => ({
  resolveActiveProviderAccountContext: vi.fn(),
  resolveActiveProviderConnectionCredential: vi.fn(),
  resolveGmailAccessToken: vi.fn(),
}));
const admissionMocks = vi.hoisted(() => ({
  admitEmailThreadCase: vi.fn(),
}));

vi.mock("../src/actors/email-case-admission", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/email-case-admission")
  >()),
  admitEmailThreadCase: admissionMocks.admitEmailThreadCase,
}));

vi.mock("../src/data/integration-account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/integration-account")>()),
  resolveActiveProviderAccountContext:
    credentialMocks.resolveActiveProviderAccountContext,
}));
vi.mock(
  "../src/credential-vault/provider-connection-resolution",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/credential-vault/provider-connection-resolution")
    >()),
    resolveActiveProviderConnectionCredential:
      credentialMocks.resolveActiveProviderConnectionCredential,
  }),
);
vi.mock("../src/mail/gmail-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail/gmail-oauth")>()),
  resolveGmailAccessToken: credentialMocks.resolveGmailAccessToken,
}));

import {
  activateEmailRuntime,
  acceptEmailHint,
  completeEmailCaseContextDiscovery,
  dueEmailCaseContextDiscovery,
  reserveEmailTokens,
  recordEmailAdmissions,
  recordEmailCaseContextDiscovery,
  retryEmailCaseContextDiscovery,
  utcDayKey,
  createConnectorEmailSchema,
  emailMessageDisposition,
  readEmailRuntime,
  type EmailIngressLimits,
} from "../src/actors/connector-email";
import { createConnectorEvalSchema } from "../src/actors/connector-eval";
import { runConnectorEmailEvaluation } from "../src/actors/connector-email-evaluation";
import { upsertUser } from "../src/data/control-plane";
import {
  assignAgentMailbox,
  readEmailThreadCase,
  registerEmailMailboxAccount,
} from "../src/data/email-mailbox";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import {
  parseIntegrationAccountId,
  type UserId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../src/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_784_016_325_277;

describe("connector email evaluation", connectorEmailEvaluationSuite);

function connectorEmailEvaluationSuite(): void {
  it(
    "reconciles history, coalesces threads, and projects admissions",
    admissionTest,
  );
  it(
    "pauses before an oversized message without advancing the cursor",
    oversizedPauseTest,
  );
  it(
    "degrades the account when Gmail no longer retains the cursor",
    cursorExpiryTest,
  );
  it(
    "names the exact admission limit that stopped processing",
    admissionLimitMatrixTest,
  );
  it(
    "fails closed when Gmail authorization expires, and defers when it may not have",
    authorizationExpiryTest,
  );
  it(
    "refuses to initialize mailbox evaluation for a send-only connection",
    sendOnlyConnectionTest,
  );
  it(
    "durably retries CaseContextCollection discovery work",
    caseContextDiscoveryWorkTest,
  );
}

function caseContextDiscoveryWorkTest(): void {
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createConnectorEmailSchema(sql, createConnectorEvalSchema);
  recordEmailCaseContextDiscovery(sql, {
    organisationId: "organisation_case_context_collection_queue",
    integrationAccountId: "gmail_case_context_collection_queue",
    caseId: "case_context_collection_queue",
    threadId: "thread_case_context_collection_queue",
    messageIds: ["message_1", "message_2"],
    policyVersion: 3,
    now: NOW,
  });
  const work = dueEmailCaseContextDiscovery(sql, NOW);
  expect(work).toMatchObject({
    organisationId: "organisation_case_context_collection_queue",
    integrationAccountId: "gmail_case_context_collection_queue",
    providerMessageId: "message_2",
    caseId: "case_context_collection_queue",
    messageIds: ["message_1", "message_2"],
    policyVersion: 3,
    admittedAt: NOW,
    attempts: 0,
  });
  if (work === null)
    throw new Error("missing CaseContextCollection discovery work");
  expect(retryEmailCaseContextDiscovery(sql, { work, now: NOW })).toBe(
    "scheduled",
  );
  expect(dueEmailCaseContextDiscovery(sql, NOW)).toBeNull();
  const retry = dueEmailCaseContextDiscovery(sql, NOW + 30_000);
  expect(retry).toMatchObject({ attempts: 1 });
  if (retry === null)
    throw new Error("missing CaseContextCollection discovery retry");
  completeEmailCaseContextDiscovery(sql, retry);
  expect(dueEmailCaseContextDiscovery(sql, NOW + 30_000)).toBeNull();
  sqlite.database.close();
}

async function sendOnlyConnectionTest(): Promise<void> {
  const fixture = await createFixture("send-only");
  credentialMocks.resolveGmailAccessToken.mockClear();
  credentialMocks.resolveActiveProviderAccountContext.mockResolvedValue({
    ok: true,
    value: {
      account: { provider: "gmail" },
      connection: {
        provider: "gmail",
        authorizationProduct: { kind: "gmail", product: "send_only" },
        authority: {
          kind: "connection_credential",
          credentialGeneration: 1,
          credentialRef: "vault:organisation:gmail:send-only:oauth:g1",
        },
      },
    },
  });
  const storage = fakeStorage();
  activate(storage, fixture);
  acceptEmailHint(storage.sql, {
    notificationId: "n-send-only",
    historyId: "1200",
    now: NOW,
  });
  const outcome = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5,
    fetcher: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  expect(outcome).toMatchObject({
    kind: "deferred",
    reason: "connector_email_credential_invalid",
  });
  expect(credentialMocks.resolveGmailAccessToken).not.toHaveBeenCalled();
}

/**
 * An expired refresh token answers 400 on every retry, so deferring hourly
 * would leave the mailbox unattended while looking merely quiet. A 503 might
 * succeed next hour, so it must not pause and demand human attention. The
 * distinction is the whole point of classifying the failure.
 */
async function authorizationExpiryTest(): Promise<void> {
  const expired = await accessFailure("expired", {
    code: "provider_oauth_exchange_failed",
    status: 400,
    requestId: null,
  });
  expect(expired.outcome).toEqual({
    kind: "paused",
    reason: "authorization_expired",
  });
  expect(expired.processing).toMatchObject({
    kind: "paused",
    reason: {
      kind: "authorization_expired",
      reasonCode: "connector_email_authorization_expired",
    },
  });
  // The cursor is untouched, so reconnecting catches up on the outage.
  expect(expired.acceptedHistoryId).toBe("1000");

  const transient = await accessFailure("transient", {
    code: "provider_oauth_exchange_failed",
    status: 503,
    requestId: null,
  });
  expect(transient.outcome).toMatchObject({ kind: "deferred" });
  expect(transient.processing?.kind).not.toBe("paused");
}

async function accessFailure(
  slug: string,
  error: Readonly<{ code: string; status?: number; requestId?: string | null }>,
): Promise<{
  readonly outcome: unknown;
  readonly processing: { readonly kind: string } | undefined;
  readonly acceptedHistoryId: string | undefined;
}> {
  const fixture = await createFixture(slug);
  const storage = fakeStorage();
  activate(storage, fixture);
  acceptEmailHint(storage.sql, {
    notificationId: "n1",
    historyId: "1200",
    now: NOW,
  });
  credentialMocks.resolveGmailAccessToken.mockResolvedValue({
    ok: false,
    error,
  });
  const outcome = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5,
    fetcher: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  const runtime = readEmailRuntime(storage.sql);
  return {
    outcome,
    processing: runtime?.processing,
    acceptedHistoryId: runtime?.acceptedHistoryId,
  };
}

/**
 * Every admission-time limit, each proven to stop processing and name itself.
 * The order matters and is asserted implicitly: budget before rate, rate
 * before size, size before Case count. A pause that misnamed its cause would
 * send the operator to the wrong control, so each reason carries the observed
 * value and the limit it crossed.
 */
async function admissionLimitMatrixTest(): Promise<void> {
  const hourly = await pauseFor({
    slug: "hourly",
    overrides: { maxMessagesPerHour: 1 },
    admitted: 1,
  });
  expect(hourly).toMatchObject({
    kind: "hourly_message_limit",
    observed: 1,
    limit: 1,
  });

  const budget = await pauseFor({
    slug: "budget",
    overrides: { dailyTokenBudget: 1 },
    reserve: 1,
  });
  expect(budget).toMatchObject({
    kind: "daily_token_budget",
    limit: 1,
    consumed: 0,
  });

  const oversized = await pauseFor({
    slug: "size",
    overrides: { maxMessageBytes: 1_024 },
    sizeEstimate: 4_096,
  });
  expect(oversized).toMatchObject({
    kind: "message_too_large",
    providerMessageId: "m1",
    observedBytes: 4_096,
    limitBytes: 1_024,
  });

  const cases = await pauseFor({
    slug: "cases",
    overrides: { maxActiveCases: 1 },
    admitted: 1,
  });
  expect(cases).toMatchObject({
    kind: "active_case_limit",
    observed: 1,
    limit: 1,
  });
}

async function pauseFor(
  input: Readonly<{
    slug: string;
    overrides: Partial<EmailIngressLimits>;
    sizeEstimate?: number;
    reserve?: number;
    admitted?: number;
  }>,
): Promise<unknown> {
  const fixture = await createFixture(input.slug);
  const storage = fakeStorage();
  activate(storage, fixture, input.overrides);
  if (input.reserve !== undefined) {
    reserveEmailTokens(storage.sql, {
      reservationId: `reserve_${input.slug}`,
      utcDay: utcDayKey(NOW),
      tokens: input.reserve,
      limit: Number.MAX_SAFE_INTEGER,
      now: NOW,
    });
  }
  if (input.admitted !== undefined) {
    recordEmailAdmissions(storage.sql, {
      admitted: Array.from({ length: input.admitted }, (_, index) => ({
        providerMessageId: `prior-${index}`,
        threadId: `prior-thread-${index}`,
        caseId: `case_prior_${index}`,
      })),
      policyVersion: 1,
      now: NOW,
    });
  }
  acceptEmailHint(storage.sql, {
    notificationId: "n1",
    historyId: "1200",
    now: NOW,
  });
  const gmail = gmailFixture({
    history: [{ messageId: "m1", threadId: "thread-1" }],
    latestHistoryId: "1200",
    metadata: {
      m1: {
        sizeEstimate: input.sizeEstimate ?? 2_048,
        internalDate: 1,
        labelIds: ["INBOX"],
      },
    },
  });
  const outcome = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5,
    fetcher: gmail.fetcher,
  });
  expect(outcome.kind).toBe("paused");

  // A pause never advances the cursor: the message stays in Gmail, unread by
  // any agent, until the operator resumes.
  expect(readEmailRuntime(storage.sql)?.acceptedHistoryId).toBe("1000");
  const processing = readEmailRuntime(storage.sql)?.processing;
  return processing?.kind === "paused" ? processing.reason : null;
}

/**
 * Gmail retains history for a bounded window. Once the stored cursor falls
 * outside it, Pantry cannot know what it missed, so the mailbox degrades and
 * stops rather than silently resuming from "now" — resuming would skip mail
 * the operator believes was processed, which is the one failure this design
 * refuses to hide.
 */
async function cursorExpiryTest(): Promise<void> {
  const fixture = await createFixture("expiry");
  const storage = fakeStorage();
  activate(storage, fixture);
  acceptEmailHint(storage.sql, {
    notificationId: "n1",
    historyId: "9000",
    now: NOW,
  });

  const expired = {
    fetcher: (async (request: RequestInfo | URL) => {
      const url = new URL(new Request(request as Request).url);
      if (url.pathname.endsWith("/history")) {
        return new Response("historyId is no longer valid", { status: 404 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch,
  };
  const outcome = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5,
    fetcher: expired.fetcher,
  });
  expect(outcome).toEqual({
    kind: "degraded",
    reason: "gmail_history_expired",
  });

  // The account carries the reason so the Portal can explain it, and the
  // cursor is left untouched rather than jumped forward.
  const account = await fixture.env.DB.prepare(
    `SELECT lifecycle, lifecycle_reason_code AS reasonCode
       FROM integration_account WHERE integration_account_id = ?`,
  )
    .bind(fixture.integrationAccountId)
    .first<{
      readonly lifecycle: string;
      readonly reasonCode: string | null;
    }>();
  expect(account).toEqual({
    lifecycle: "degraded",
    reasonCode: "gmail_history_expired",
  });
  expect(readEmailRuntime(storage.sql)?.acceptedHistoryId).toBe("1000");
  expect(admissionMocks.admitEmailThreadCase).not.toHaveBeenCalled();
}

async function admissionTest(): Promise<void> {
  const fixture = await createFixture("admit");
  const storage = fakeStorage();
  activate(storage, fixture);
  acceptEmailHint(storage.sql, {
    notificationId: "n1",
    historyId: "1200",
    now: NOW,
  });

  const gmail = gmailFixture({
    history: [
      { messageId: "m1", threadId: "thread-1" },
      { messageId: "m2", threadId: "thread-1" },
      { messageId: "m3", threadId: "thread-2" },
    ],
    latestHistoryId: "1200",
    metadata: {
      m1: { sizeEstimate: 2_048, internalDate: 1, labelIds: ["INBOX"] },
      m2: { sizeEstimate: 2_048, internalDate: 2, labelIds: ["INBOX"] },
      m3: { sizeEstimate: 2_048, internalDate: 3, labelIds: ["INBOX"] },
    },
  });
  const outcome = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5,
    fetcher: gmail.fetcher,
  });
  expect(outcome).toMatchObject({
    kind: "evaluated",
    admitted: 3,
    deduplicated: 0,
  });
  if (outcome.kind === "evaluated") {
    expect(outcome.threads).toEqual([
      {
        threadId: "thread-1",
        caseId: `case_gmail_${fixture.integrationAccountId}_thread-1`,
        messageIds: ["m1", "m2"],
      },
      {
        threadId: "thread-2",
        caseId: `case_gmail_${fixture.integrationAccountId}_thread-2`,
        messageIds: ["m3"],
      },
    ]);
  }
  const runtime = readEmailRuntime(storage.sql);
  expect(runtime?.acceptedHistoryId).toBe("1200");
  expect(emailMessageDisposition(storage.sql, "m2")).toBe("admitted");
  const mappedCase = await readEmailThreadCase({
    db: fixture.env.DB,
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    gmailThreadId: "thread-1",
  });
  expect(mappedCase).toBe(
    `case_gmail_${fixture.integrationAccountId}_thread-1`,
  );
  const receipts = await fixture.env.DB.prepare(
    "SELECT COUNT(*) AS total FROM email_message_receipt WHERE integration_account_id = ?",
  )
    .bind(fixture.integrationAccountId)
    .first<{ readonly total: number }>();
  expect(receipts?.total).toBe(3);

  acceptEmailHint(storage.sql, {
    notificationId: "n2",
    historyId: "1200",
    now: NOW + 10,
  });
  const again = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5 + 3_600_000,
    fetcher: gmail.fetcher,
  });
  expect(again).toMatchObject({
    kind: "evaluated",
    admitted: 0,
    deduplicated: 3,
    threads: [],
  });
}

async function oversizedPauseTest(): Promise<void> {
  const fixture = await createFixture("pause");
  const storage = fakeStorage();
  activate(storage, fixture, { maxMessageBytes: 1_024 });
  acceptEmailHint(storage.sql, {
    notificationId: "n1",
    historyId: "1300",
    now: NOW,
  });

  const gmail = gmailFixture({
    history: [
      { messageId: "small", threadId: "thread-a" },
      { messageId: "huge", threadId: "thread-b" },
    ],
    latestHistoryId: "1300",
    metadata: {
      small: { sizeEstimate: 512, internalDate: 1, labelIds: ["INBOX"] },
      huge: { sizeEstimate: 8_192, internalDate: 2, labelIds: ["INBOX"] },
    },
  });
  const outcome = await runConnectorEmailEvaluation({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    storage,
    env: fixture.env,
    now: NOW + 5,
    fetcher: gmail.fetcher,
  });
  expect(outcome).toEqual({ kind: "paused", reason: "message_too_large" });
  const runtime = readEmailRuntime(storage.sql);
  expect(runtime?.acceptedHistoryId).toBe("1000");
  expect(runtime?.processing.kind).toBe("paused");
  if (runtime?.processing.kind === "paused") {
    expect(runtime.processing.reason).toMatchObject({
      kind: "message_too_large",
      providerMessageId: "huge",
      observedBytes: 8_192,
      limitBytes: 1_024,
    });
  }
  expect(emailMessageDisposition(storage.sql, "small")).toBe("admitted");
  expect(emailMessageDisposition(storage.sql, "huge")).toBeNull();
}

type Fixture = {
  readonly env: UnitTestEnv;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
};

function activate(
  storage: DurableObjectStorage,
  fixture: Fixture,
  overrides: Partial<EmailIngressLimits> = {},
): void {
  createConnectorEmailSchema(storage.sql, createConnectorEvalSchema);
  const activated = activateEmailRuntime(storage.sql, {
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    policyVersion: 1,
    limits: {
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 100_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      ...overrides,
    },
    activationFloor: "1000",
    watchExpiresAt: NOW + 7 * 86_400_000,
    now: NOW - 3_600_000,
  });
  if (!activated.ok) throw new Error(activated.error.code);
}

function fakeStorage(): DurableObjectStorage {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createActorExecutionBarrierSchema(sql);
  return {
    sql,
    transactionSync: <T>(closure: () => T): T => closure(),
  } as unknown as DurableObjectStorage;
}

function gmailFixture(
  input: Readonly<{
    history: readonly {
      readonly messageId: string;
      readonly threadId: string;
    }[];
    latestHistoryId: string;
    metadata: Readonly<
      Record<
        string,
        {
          readonly sizeEstimate: number;
          readonly internalDate: number;
          readonly labelIds: readonly string[];
        }
      >
    >;
  }>,
): { readonly fetcher: typeof fetch } {
  return {
    fetcher: (async (request: RequestInfo | URL) => {
      const url = new URL(new Request(request as Request).url);
      if (url.pathname.endsWith("/history")) {
        return Response.json({
          historyId: input.latestHistoryId,
          history: input.history.map((entry) => ({
            id: input.latestHistoryId,
            messagesAdded: [
              { message: { id: entry.messageId, threadId: entry.threadId } },
            ],
          })),
        });
      }
      const messageId = url.pathname.split("/").at(-1) ?? "";
      const metadata = input.metadata[messageId];
      if (metadata === undefined)
        return new Response("missing", { status: 404 });
      return Response.json({
        id: messageId,
        threadId:
          input.history.find((entry) => entry.messageId === messageId)
            ?.threadId ?? "",
        sizeEstimate: metadata.sizeEstimate,
        labelIds: [...metadata.labelIds],
        internalDate: String(metadata.internalDate),
      });
    }) as typeof fetch,
  };
}

async function createFixture(slug: string): Promise<Fixture> {
  admissionMocks.admitEmailThreadCase.mockClear();
  admissionMocks.admitEmailThreadCase.mockResolvedValue({
    ok: true,
    value: { kind: "accepted" },
  });
  credentialMocks.resolveActiveProviderAccountContext.mockResolvedValue({
    ok: true,
    value: {
      account: { provider: "gmail" },
      connection: {
        provider: "gmail",
        authorizationProduct: {
          kind: "gmail",
          product: "full_mailbox_pilot",
        },
        authority: {
          kind: "connection_credential",
          credentialGeneration: 1,
          credentialRef: `vault:organisation:gmail:${slug}:oauth:g1`,
        },
      },
    },
  });
  credentialMocks.resolveActiveProviderConnectionCredential.mockResolvedValue({
    ok: true,
    value: {
      kind: "oauth_tokens",
      accessToken: "access",
      refreshToken: "refresh",
      expiry: { kind: "expires", expiresAt: NOW + 3_600_000 },
    },
  });
  credentialMocks.resolveGmailAccessToken.mockResolvedValue({
    ok: true,
    value: "access",
  });

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
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: `Evaluation ${slug}`,
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
  await seedInstallation(
    db,
    organisation.organisationId,
    owner.userId,
    `install_${slug}`,
  );
  const bound = await assignAgentMailbox({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    mailboxBindingId: `mailbox_binding_${slug}`,
    installationId: `install_${slug}`,
    grantsDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    createdBy: owner.userId,
    now: NOW + 4,
  });
  if (!bound.ok) throw new Error(bound.error.code);
  return {
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        TEST_ORGANISATION_PLACEMENT_PROFILE,
    }),
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
  };
}

async function seedInstallation(
  db: SingleDatabase,
  organisationId: OrganisationId,
  userId: UserId,
  installationId: string,
): Promise<void> {
  const definitionId = `${installationId}_definition`;
  await db
    .prepare(
      `INSERT INTO agent_definition (
       agent_definition_id, organisation_id, display_name, role, purpose, lifecycle,
       current_revision, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, 'Mailbox Agent', 'assistant', 'email replies', 'active', 1, ?, ?, ?)`,
    )
    .bind(definitionId, organisationId, userId, NOW, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO agent_definition_revision (
       agent_definition_id, organisation_id, revision, instructions,
       requested_capabilities_json, skill_refs_json, content_digest,
       authored_by_user_id, created_at
     ) VALUES (?, ?, 1, 'reply politely', '[]', '[]', ?, ?, ?)`,
    )
    .bind(definitionId, organisationId, "0".repeat(64), userId, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO agent_installation (
       installation_id, organisation_id, agent_definition_id, definition_revision,
       policy_revision, granted_capabilities_json, lifecycle,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, '[]', 'active', ?, ?, ?)`,
    )
    .bind(installationId, organisationId, definitionId, userId, NOW, NOW)
    .run();
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
    authMode: "shared_satyr_app",
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

void parseIntegrationAccountId;
