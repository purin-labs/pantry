import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  parseOrganisationId,
  parseConnectorId,
  parseSessionId,
  parseIntegrationAccountId,
} from "../src/ids";
import { buildAgentMailboxAuthority } from "../src/request-authority";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { activateConnectorFixture } from "./fixtures/connector-activation";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectorMocks = vi.hoisted(() => ({
  resolveConnectorGmailAccess: vi.fn(),
  readAgentMailboxBinding: vi.fn(),
  createEmailProposalDraft: vi.fn(),
  authorizeSessionTurnExecution: vi.fn(),
}));

vi.mock("../src/chat/turn-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chat/turn-access")>()),
  authorizeSessionTurnExecution: connectorMocks.authorizeSessionTurnExecution,
}));

vi.mock("../src/actors/connector-email-evaluation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/connector-email-evaluation")
  >()),
  resolveConnectorGmailAccess: connectorMocks.resolveConnectorGmailAccess,
}));
vi.mock("../src/data/email-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/email-mailbox")>()),
  readAgentMailboxBinding: connectorMocks.readAgentMailboxBinding,
}));
vi.mock("../src/actors/email-case-processing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/email-case-processing")
  >()),
  createEmailProposalDraft: connectorMocks.createEmailProposalDraft,
}));

import { ConnectorDO } from "../src/actors/connector";
import {
  activateEmailRuntime,
  recordEmailDraftOperation,
  type EmailIngressLimits,
} from "../src/actors/connector-email";
import { digestEmailBody } from "../src/mail/reply-target";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const NOW = 1_788_544_800_000;
const ORGANISATION = "organisation_email_slack";
const ACCOUNT = "integration_gmail_slack";
const CONNECTOR = `connector_gmail_${ACCOUNT}`;
const CASE = "case_slack_email_request";

describe("Connector Slack email boundary", connectorEmailSlackSuite);

function connectorEmailSlackSuite(): void {
  beforeEach(resetConnectorMocks);

  it(
    "creates one idempotent approval draft for a Slack reply proposal",
    proposalTest,
  );
}

async function proposalTest(): Promise<void> {
  const harness = await setupConnector();
  const request = {
    identity: { organisationId: ORGANISATION, connectorId: CONNECTOR },
    execution: fixtureExecution(),
    caseId: CASE,
    proposalId: "proposal_email_slack_turn_m1",
    messageId: "m1",
    threadId: "t1",
    body: "Thank you. We have noted the delivery date.",
    sources: { sources: [], dropped: 0 },
    chatSources: [],
    chatContext: { memory: [], projects: [] },
    now: NOW,
  };
  const first = await harness.connector.createEmailReplyProposal(request);
  const second = await harness.connector.createEmailReplyProposal(request);
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    ok: true,
    value: {
      record: {
        proposalId: request.proposalId,
        providerDraftId: "draft-1",
        lifecycle: { kind: "awaiting_approval" },
      },
    },
  });
  expect(connectorMocks.createEmailProposalDraft).toHaveBeenCalledOnce();
}

function fixtureExecution() {
  const organisationId = parseOrganisationId(ORGANISATION);
  const accountId = parseIntegrationAccountId(ACCOUNT);
  const sessionId = parseSessionId("session_email_slack_fixture");
  if (!organisationId.ok || !accountId.ok || !sessionId.ok)
    throw new Error("Invalid email execution fixture");
  return {
    sessionId: sessionId.value,
    turnId: "turn_email_slack_fixture",
    requestAuthority: buildAgentMailboxAuthority({
      organisationId: organisationId.value,
      integrationAccountId: accountId.value,
      mailboxBindingId: "binding-slack",
      bindingRevision: 2,
      mailboxPolicyVersion: 3,
    }).requestAuthority,
  };
}

async function setupConnector(): Promise<
  Readonly<{
    connector: ConnectorDO;
    sql: ReturnType<typeof sqlStorage>;
  }>
> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const storage = new TestStorage(fixture.database, sql);
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'email-slack', 'Email Slack', 0)",
    )
    .bind(ORGANISATION)
    .run();
  const organisationId = parseOrganisationId(ORGANISATION);
  const connectorId = parseConnectorId(CONNECTOR);
  if (!organisationId.ok || !connectorId.ok)
    throw new Error("Invalid Connector fixture identity");
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisationId.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const env = platformEnv({
    DB: db,
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const connector = new ConnectorDO(
    { storage, waitUntil: vi.fn() } as unknown as DurableObjectState,
    env,
  );
  await activateConnectorFixture(
    connector,
    env,
    organisationId.value,
    connectorId.value,
  );
  activateEmailRuntime(sql, {
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
    policyVersion: 3,
    limits: limits(),
    activationFloor: "1000",
    watchExpiresAt: NOW + 86_400_000,
    now: NOW,
  });
  return { connector, sql };
}

function resetConnectorMocks(): void {
  vi.clearAllMocks();
  connectorMocks.authorizeSessionTurnExecution.mockResolvedValue(true);
  connectorMocks.resolveConnectorGmailAccess.mockResolvedValue({
    ok: true,
    value: "gmail-access-token",
  });
  connectorMocks.readAgentMailboxBinding.mockResolvedValue({
    ok: true,
    value: {
      binding: { mailboxBindingId: "mailbox_binding_slack" },
      currentRevision: { revision: 4 },
    },
  });
  connectorMocks.createEmailProposalDraft.mockImplementation(
    recordDraftProposal,
  );
}

async function recordDraftProposal(
  _env: UnitTestEnv,
  input: Parameters<
    typeof import("../src/actors/email-case-processing").createEmailProposalDraft
  >[1],
  proposal: Parameters<
    typeof import("../src/actors/email-case-processing").createEmailProposalDraft
  >[2],
): Promise<
  Awaited<
    ReturnType<
      typeof import("../src/actors/email-case-processing").createEmailProposalDraft
    >
  >
> {
  const bodyDigest = await digestEmailBody(proposal.body);
  const targetDigest = "a".repeat(64);
  const snapshotDigest = "b".repeat(64);
  recordEmailDraftOperation(input.connectorSql, {
    proposalId: proposal.proposalId,
    version: proposal.version,
    caseId: input.caseId,
    threadId: input.threadId,
    draftId: "draft-1",
    draftMessageId: "draft-message-1",
    triggeringMessageId: proposal.triggeringMessageId,
    targetDigest,
    bodyDigest,
    snapshotDigest,
    policyVersion: input.policyVersion,
    expiresAt: NOW + 72 * 3_600_000,
    now: NOW,
  });
  return {
    ok: true,
    value: {
      record: {
        evidence: { kind: "source_only" },
        proposalId: proposal.proposalId,
        version: proposal.version,
        caseId: input.caseId,
        threadId: input.threadId,
        providerDraftId: "draft-1",
        providerDraftMessageId: "draft-message-1",
        triggeringProviderMessageId: proposal.triggeringMessageId,
        mailboxBindingId: input.mailboxBindingId,
        bindingRevision: input.bindingRevision,
        policyVersion: input.policyVersion,
        targetDigest,
        bodyDigest,
        snapshotDigest,
        createdAt: NOW,
        expiresAt: NOW + 72 * 3_600_000,
        lifecycle: { kind: "awaiting_approval" },
      },
    },
  };
}

function limits(): EmailIngressLimits {
  return {
    maxActiveCases: 5,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 200_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
  };
}

class TestStorage {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: SqlStorage,
  ) {}

  transactionSync<Value>(callback: () => Value): Value {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
