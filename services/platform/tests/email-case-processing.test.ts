import { seedNativeProviderAccount } from "./real-provider-execution-fixture";
import { upsertUser } from "@purin-labs/tenancy/data/control-plane";
import {
  registerEmailMailboxAccount,
  assignAgentMailbox,
  publishMailboxIngressPolicy,
} from "../src/data/email-mailbox";
import { requireIntegrationAccountId } from "./test-ids";
import { createActorExecutionBarrierSchema } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { defaultDenyPolicy } from "@purin-labs/authority/policy-snapshot";
import { ensureInitialOrganisationPlacement } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import { createMigratedDatabase } from "./sqlite-d1";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it, vi } from "vitest";

const orchestratorMocks = vi.hoisted(() => ({
  resolveActiveCaseActor: vi.fn(),
  resolveActiveSessionActor: vi.fn(),
  requireActiveOrganisationActor: vi.fn(),
  prepareTransientEmailAssignment: vi.fn(),
  settleTransientEmailAssignment: vi.fn(),
  prepareTurnContext: vi.fn(),
  prepareTurnAuthority: vi.fn(),
  resolveOrganisationModelRoute: vi.fn(),
  readGmailInferenceEligibility: vi.fn(),
  loadOrganisationPolicyOrDefaultDeny: vi.fn(),
  ensureOrganisationDefaultWorkspace: vi.fn(),
  resolveConnectorGmailAccess: vi.fn(),
  resolveCaseTurnAgentProfile: vi.fn(),
  gmailGetMessageContent: vi.fn(),
  gmailCreateDraft: vi.fn(),
  previewEmailProposal: vi.fn(),
  dispatchEmailReply: vi.fn(),
}));

vi.mock("../src/mail-inbox/contract/gmail-inference-eligibility", () => ({
  readGmailInferenceEligibility:
    orchestratorMocks.readGmailInferenceEligibility,
}));

vi.mock(
  "@purin-labs/actor-runtime/actors/actor-router",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@purin-labs/actor-runtime/actors/actor-router")
    >()),
    resolveActiveCaseActor: orchestratorMocks.resolveActiveCaseActor,
    resolveActiveSessionActor: orchestratorMocks.resolveActiveSessionActor,
    requireActiveOrganisationActor:
      orchestratorMocks.requireActiveOrganisationActor,
  }),
);
vi.mock("../src/actors/case-walking-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/case-walking-path")>()),
  prepareTransientEmailAssignment:
    orchestratorMocks.prepareTransientEmailAssignment,
  settleTransientEmailAssignment:
    orchestratorMocks.settleTransientEmailAssignment,
}));
vi.mock("../src/context/turn-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context/turn-context")>()),
  prepareTurnContext: orchestratorMocks.prepareTurnContext,
  prepareTurnAuthority: orchestratorMocks.prepareTurnAuthority,
}));
vi.mock("../src/models/route", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models/route")>()),
  resolveOrganisationModelRoute:
    orchestratorMocks.resolveOrganisationModelRoute,
}));
vi.mock("@purin-labs/authority/policy-snapshot", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/authority/policy-snapshot")
  >()),
  loadOrganisationPolicyOrDefaultDeny:
    orchestratorMocks.loadOrganisationPolicyOrDefaultDeny,
}));
vi.mock("../src/data/organisation-workspace", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/organisation-workspace")
  >()),
  ensureOrganisationDefaultWorkspace:
    orchestratorMocks.ensureOrganisationDefaultWorkspace,
}));
vi.mock("../src/actors/connector-email-evaluation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/connector-email-evaluation")
  >()),
  resolveConnectorGmailAccess: orchestratorMocks.resolveConnectorGmailAccess,
}));
vi.mock("../src/data/pinned-agent-profile", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/pinned-agent-profile")
  >()),
  resolveCaseTurnAgentProfile: orchestratorMocks.resolveCaseTurnAgentProfile,
}));
vi.mock(
  "@purin-labs/connections/mail/gmail-adapter",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@purin-labs/connections/mail/gmail-adapter")
    >()),
    gmailGetMessageContent: orchestratorMocks.gmailGetMessageContent,
    gmailCreateDraft: orchestratorMocks.gmailCreateDraft,
  }),
);
vi.mock("../src/actors/connector-email-proposal", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/connector-email-proposal")
  >()),
  previewEmailProposal: orchestratorMocks.previewEmailProposal,
  dispatchEmailReply: orchestratorMocks.dispatchEmailReply,
}));

import {
  createConnectorEmailSchema,
  emailTokenWindowTotals,
  readEmailRuntime,
  activateEmailRuntime,
  utcDayKey,
  type EmailIngressLimits,
} from "../src/actors/connector-email";
import { createConnectorEvalSchema } from "../src/actors/connector-eval";
import { processEmailThreadTurn } from "../src/actors/email-case-processing";
import { claimMailResponseOwner } from "../src/mail-inbox/response-store";
import { platformEnv } from "./worker-fakes";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import {
  FlowBinding,
  InformationFlowContext,
} from "@purin-labs/authority/policy/information-flow/index";
import { isRecord } from "@purin-labs/std";

const NOW = 1_784_016_325_277;
const ORGANISATION = "organisation_email_turn";
const ACCOUNT = "integration_gmail_turn";
const CASE_ID = "case_gmail_integration_gmail_turn_t1";

describe("transient email thread turn", emailThreadTurnSuite);

function emailThreadTurnSuite(): void {
  it(
    "blocks an unevidenced inference route before preparing a session",
    blockedInferenceTest,
  );
  it("closes irrelevant Cue work without creating a draft", ignoredEmailTest);
  it("settles usage and pauses the mailbox on content breaches", breachTest);
}

async function blockedInferenceTest(): Promise<void> {
  const harness = setup({ ok: false, error: { code: "must_not_run" } });
  orchestratorMocks.readGmailInferenceEligibility.mockResolvedValue({
    kind: "blocked",
  });
  const callsBefore = harness.session.runTransientEmailTurn.mock.calls.length;
  const input = await turnInput(harness.sql);
  const outcome = await processEmailThreadTurn(input.env, input);
  expect(outcome).toEqual({
    ok: false,
    error: { code: "gmail_inference_route_blocked" },
  });
  expect(harness.session.runTransientEmailTurn.mock.calls.length).toBe(
    callsBefore,
  );
  expect(emailTokenWindowTotals(harness.sql, utcDayKey(NOW)).reserved).toBe(0);
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

function setup(turnOutcome: unknown): {
  readonly sql: ReturnType<typeof sqlStorage>;
  readonly caseActor: {
    acceptEmailProposal: ReturnType<typeof vi.fn>;
    transitionEmailProposal: ReturnType<typeof vi.fn>;
  };
  readonly session: { runTransientEmailTurn: ReturnType<typeof vi.fn> };
} {
  vi.clearAllMocks();
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorEmailSchema(sql, createConnectorEvalSchema);
  createActorExecutionBarrierSchema(sql);
  for (const messageId of ["m1", "m2"]) {
    claimMailResponseOwner(sql, null, {
      messageId,
      threadId: "t1",
      historyId: "1001",
    });
  }
  activateEmailRuntime(sql, {
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
    policyVersion: 1,
    limits: limits(),
    activationFloor: "1000",
    watchExpiresAt: NOW + 86_400_000,
    now: NOW - 3_600_000,
  });
  const caseActor = {
    acceptSessionProposal: vi.fn().mockResolvedValue({
      ok: true,
      value: { disposition: { kind: "accepted" } },
    }),
    acceptEmailProposal: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { kind: "accepted" } }),
    transitionEmailProposal: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { kind: "updated" } }),
  };
  const session = {
    runTransientEmailTurn: vi
      .fn()
      .mockImplementation(sourcedTurnOutcome.bind(null, turnOutcome)),
  };
  orchestratorMocks.requireActiveOrganisationActor.mockResolvedValue({
    prepareCaseContextCollectionEvidence: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { kind: "source_only" } }),
  });
  orchestratorMocks.resolveActiveCaseActor.mockResolvedValue({
    ok: true,
    value: caseActor,
  });
  orchestratorMocks.resolveActiveSessionActor.mockResolvedValue({
    ok: true,
    value: session,
  });
  orchestratorMocks.resolveOrganisationModelRoute.mockResolvedValue({
    ok: true,
    value: {
      provider: "openai-compatible",
      keySource: "platform",
      model: "test-model",
    },
  });
  orchestratorMocks.readGmailInferenceEligibility.mockResolvedValue({
    kind: "eligible",
    evidenceReference: "test-evidence",
    reviewExpiresAt: NOW + 86_400_000,
  });
  orchestratorMocks.loadOrganisationPolicyOrDefaultDeny.mockResolvedValue({
    snapshot: {
      version: 4,
      egress: {},
      authz: {
        maxBudget: { maxTokens: 150_000, maxWallMs: 120_000, maxToolCalls: 20 },
      },
      conversationRisk: {},
    },
  });
  orchestratorMocks.ensureOrganisationDefaultWorkspace.mockResolvedValue({
    ok: true,
    value: { revision: "workspace_rev_1" },
  });
  orchestratorMocks.prepareTurnContext.mockResolvedValue({
    ok: true,
    value: {
      turnAuthority: {
        requestAuthority: {},
        authorityPartition: { digest: "d".repeat(64) },
      },
      context: {
        bundle: {
          organisationId: "organisation_1",
          caseId: "case_1",
          assignmentId: "assignment_1",
          sessionId: "session_1",
          policyVersion: "1",
          assemblyStrategyVersion: "context_assembly_v1",
          assembledAt: 1,
          items: [],
          usage: { items: 0, estimatedTokens: 0 },
          disposition: { kind: "complete" },
          memory: { kind: "none" },
        },
        bundleDigest: "b".repeat(64),
        modelContext: {
          assemblyStrategyVersion: "context_assembly_v1",
          items: [],
          disposition: { kind: "complete" },
        },
      },
    },
  });
  orchestratorMocks.prepareTurnAuthority.mockResolvedValue({
    ok: true,
    value: { authorityPartition: { digest: "d".repeat(64) } },
  });
  orchestratorMocks.prepareTransientEmailAssignment.mockResolvedValue({
    ok: true,
    value: {
      assignment: {
        caseId: CASE_ID,
        assignmentId: `assignment_${CASE_ID}_m2`,
        sessionId: `session_${CASE_ID}`,
        caseRevision: 3,
        authority: { authorityPartitionDigest: "d".repeat(64) },
      },
      startId: "start_turn_email_m2",
      budget: {
        budgetRevision: "budget_4",
        maxTokens: 150_000,
        maxWallMs: 120_000,
        maxToolCalls: 20,
      },
    },
  });
  orchestratorMocks.settleTransientEmailAssignment.mockResolvedValue({
    ok: true,
    value: null,
  });
  orchestratorMocks.resolveCaseTurnAgentProfile.mockResolvedValue({
    kind: "resolved",
    profile: {
      installationId: "installation_turn",
      displayName: "Mail agent",
      role: "Operator",
      purpose: "Mail",
      instructions: "Use the installed playbook.",
      skills: [],
      grantedCapabilities: [],
    },
  });
  orchestratorMocks.resolveConnectorGmailAccess.mockResolvedValue({
    ok: true,
    value: "token",
  });
  orchestratorMocks.gmailGetMessageContent.mockResolvedValue({
    ok: true,
    value: {
      messageId: "m2",
      threadId: "t1",
      headers: {
        messageIdHeader: "<origin@sender.example>",
        from: "Customer <customer@sender.example>",
        replyTo: null,
        subject: "Order status?",
        references: null,
        date: "Mon, 24 Aug 2026 10:00:00 +0000",
      },
      bodyText: "",
      decodedBodyBytes: 0,
      attachments: [],
    },
  });
  orchestratorMocks.gmailCreateDraft.mockResolvedValue({
    ok: true,
    value: { draftId: "draft-1", draftMessageId: "draft-msg-1" },
  });
  orchestratorMocks.previewEmailProposal.mockResolvedValue({
    ok: true,
    value: {
      kind: "current",
      preview: { currentVersion: 1, snapshotDigest: "a".repeat(64) },
    },
  });
  orchestratorMocks.dispatchEmailReply.mockResolvedValue({
    ok: true,
    value: { kind: "sent", version: 1, providerMessageId: "ack-message-1" },
  });
  return { sql, caseActor, session };
}

async function sourcedTurnOutcome(outcome: unknown): Promise<unknown> {
  if (!isRecord(outcome) || outcome.ok !== true || !isRecord(outcome.value))
    return outcome;
  const context = await InformationFlowContext.create({
    organisationId: ORGANISATION,
    sessionId: `session_${CASE_ID}`,
    authorityPartitionDigest: "d".repeat(64),
  });
  if (!context.ok) throw new Error(context.error.code);
  return {
    ok: true,
    value: {
      ...outcome.value,
      flowBinding: FlowBinding.fromContext(
        context.value,
        "turn_email_m2",
      ).toJSON(),
      memory: [],
      sources: { sources: [], dropped: 0 },
    },
  };
}

async function turnInput(sql: ReturnType<typeof sqlStorage>) {
  const db = createMigratedDatabase();
  const organisationId = parseOrganisationId(ORGANISATION);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'test-organisation', 'Test organisation', 0)",
    )
    .bind(organisationId.value)
    .run();
  await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisationId.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  // Each reply is held to the organisation's current policy, so the
  // organisation has one that allows the mailbox to propose a reply.
  const policy = defaultDenyPolicy({ now: 0 });
  policy.version = 4;
  policy.authz.allowedTools = [CAPABILITY_KEYS.emailReplyPropose];
  await db
    .prepare(
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 4, ?, 0, 'email-turn-fixture')",
    )
    .bind(organisationId.value, JSON.stringify(policy))
    .run();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "email-turn-owner",
      email: "email-owner@example.test",
      displayName: "Email owner",
      emailVerified: true,
    },
    now: Date.now(),
  });
  await db.batch([
    db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_email_owner', 'Email owner')",
      )
      .bind(organisationId.value),
    db
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, 'person_email_owner', 'owner', 'active', 1)",
      )
      .bind(organisationId.value, owner.userId),
    db
      .prepare(
        "INSERT INTO organisation_onboarding (organisation_id, environment, lifecycle, capability_profile, configuration_version, projection_revision, activation_receipt_id, activated_at, updated_at) VALUES (?, 'development', 'active', 'read_and_propose', 1, 1, 'email-turn-fixture', 1, 1)",
      )
      .bind(organisationId.value),
    db
      .prepare(
        "INSERT INTO agent_definition (agent_definition_id, organisation_id, display_name, role, purpose, lifecycle, current_revision, created_by_user_id, created_at, updated_at) VALUES ('definition_email_turn', ?, 'Email agent', 'assistant', 'Email replies', 'active', 1, ?, 1, 1)",
      )
      .bind(organisationId.value, owner.userId),
    db
      .prepare(
        "INSERT INTO agent_definition_revision (agent_definition_id, organisation_id, revision, instructions, requested_capabilities_json, skill_refs_json, content_digest, authored_by_user_id, created_at) VALUES ('definition_email_turn', ?, 1, 'Reply politely', '[]', '[]', ?, ?, 1)",
      )
      .bind(organisationId.value, "0".repeat(64), owner.userId),
    db
      .prepare(
        "INSERT INTO agent_installation (installation_id, organisation_id, agent_definition_id, definition_revision, policy_revision, granted_capabilities_json, lifecycle, created_by_user_id, created_at, updated_at) VALUES ('installation_turn', ?, 'definition_email_turn', 1, 1, '[]', 'active', ?, 1, 1)",
      )
      .bind(organisationId.value, owner.userId),
  ]);
  const integrationAccountId = requireIntegrationAccountId(ACCOUNT);
  await seedNativeProviderAccount(
    db,
    organisationId.value,
    integrationAccountId,
    "gmail",
    owner.userId,
  );
  const registered = await registerEmailMailboxAccount({
    db,
    organisationId: organisationId.value,
    integrationAccountId,
    environment: "development",
    googleSubject: "email-turn-mailbox",
    observedAddress: "shop@example.com",
    now: 1,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  for (const now of [1, 2]) {
    const assigned = await assignAgentMailbox({
      db,
      organisationId: organisationId.value,
      integrationAccountId,
      mailboxBindingId: "mailbox_binding_turn",
      installationId: "installation_turn",
      grantsDigest: "0".repeat(64),
      policyDigest: "1".repeat(64),
      createdBy: owner.userId,
      now,
    });
    if (!assigned.ok) throw new Error(assigned.error.code);
  }
  const published = await publishMailboxIngressPolicy({
    db,
    organisationId: organisationId.value,
    integrationAccountId,
    environment: "development",
    request: {
      kind: "enabled",
      maxActiveCases: 10,
      maxMessagesPerHour: 100,
      dailyTokenBudget: 1000000,
      maxMessageBytes: 100000,
      maxAttachmentBytes: 1000000,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
    publishedBy: owner.userId,
    now: 2,
  });
  if (!published.ok) throw new Error(published.error.code);
  const testEnv = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const scope = await requireOrganisationExecutionScope(
    testEnv,
    organisationId.value,
  );
  return {
    env: testEnv,
    scope,
    connectorSql: sql,
    responsePolicy: "cue_routed" as const,
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
    threadId: "t1",
    caseId: CASE_ID,
    messageIds: ["m1", "m2"],
    mailboxBindingId: "mailbox_binding_turn",
    bindingRevision: 2,
    policyVersion: 1,
    limits: limits(),
    now: NOW,
  };
}

async function ignoredEmailTest(): Promise<void> {
  const harness = setup({
    ok: true,
    value: {
      outcome: { kind: "ignore" },
      modelUsage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15,
      },
      commerceEvidence: [],
      breaches: [],
    },
  });
  const input = await turnInput(harness.sql);
  const outcome = await processEmailThreadTurn(input.env, input);
  expect(outcome).toEqual({
    ok: true,
    value: { kind: "skipped", reason: "cue_irrelevant" },
  });
  expect(orchestratorMocks.gmailCreateDraft).not.toHaveBeenCalled();
}

async function breachTest(): Promise<void> {
  const harness = setup({
    ok: true,
    value: {
      outcome: { kind: "approval_required", body: "Reply text." },
      modelUsage: {
        modelCalls: 1,
        callsWithUsage: 1,
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 10,
      },
      commerceEvidence: [],
      breaches: [
        {
          kind: "message_too_large",
          providerMessageId: "m2",
          providerAttachmentId: null,
          observedBytes: 999_999,
          limitBytes: 262_144,
        },
      ],
    },
  });
  const input = await turnInput(harness.sql);
  const outcome = await processEmailThreadTurn(input.env, input);
  expect(outcome).toEqual({
    ok: true,
    value: { kind: "skipped", reason: "email_content_over_limit" },
  });
  expect(emailTokenWindowTotals(harness.sql, utcDayKey(NOW))).toEqual({
    reserved: 0,
    consumed: 10,
  });
  expect(orchestratorMocks.gmailCreateDraft).not.toHaveBeenCalled();
  const runtime = readEmailRuntime(harness.sql);
  expect(runtime?.processing.kind).toBe("paused");
  if (runtime?.processing.kind === "paused") {
    expect(runtime.processing.reason).toMatchObject({
      kind: "message_too_large",
      providerMessageId: "m2",
    });
  }
}
