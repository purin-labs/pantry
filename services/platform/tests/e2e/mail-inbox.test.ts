import {
  readEmailRuntime,
  EMAIL_RESOLVE_GRACE_MS,
} from "../../src/actors/connector-email";
import { fixtureDatabase } from "./organisation-database";
import { projectMailClassifications } from "../../src/mail-inbox/store";
import { opaqueCaseReference } from "../../src/access-control/references";
import {
  compareEvalRun,
  evalConfigurationVerdict,
  isSettledEvalRun,
  parseCaseContextCollectionMetadataResponse,
  parseEvalListResponse,
  parseEvalSenderChoicesResponse,
  parseEvalRunCommandReceipt,
  parseEvalRunListResponse,
  type CaseExecutionNode,
  type EvalConfiguration,
  type EvalContent,
  type EvalRoute,
  type EvalRunResult,
  type EvalScenario,
  type EvalTaskResult,
  type MemoryCommand,
  type MemoryContent,
  parseMailReplySources,
} from "@purin-labs/control-api";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";
import { readSessionTurnMemoryRecords } from "../../src/actors/actor-journal/transactions";
import { createMailboxTurnMemoryReader } from "../../src/memory/mailbox-turn";
import {
  canonicalFlowLabel,
  joinFlowLabels,
} from "../../src/policy/information-flow";
import { createCurrentSourceFlowLabel } from "../../src/policy/information-flow";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import {
  prepareWorkspaceRevisionMutation,
  commitWorkspaceRevision,
} from "../../src/workspace-revision-store";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";
import type { OrganisationDO } from "../../src/actors/organisation";
import type { MailEvaluationInput } from "../../src/mail-inbox/evaluation";
import { createTransientGoalExecution } from "../../src/actors/session-goal-usage";
import { parsePersistedHarnessTurnLease } from "../../src/actors/agent-session-harness-authority";
import {
  openRouterText,
  openRouterToolCall,
  openRouterStream,
} from "./slack-journey-support";
import {
  executionShape,
  incoming,
  openNodes,
  readCaseExecution,
  readCaseExecutionDetail,
  readCaseTimeline,
  storedContent,
} from "./case-execution-support";
import {
  attachSharedAccountNativeOrganisation,
} from "./shared-account-platform-fixture";
import {
  FakeChatGpt,
  signInToChatGpt,
  textAnswer,
  toolOutputs,
  type ChatGptAnswer,
  type ChatGptModelRequest,
} from "./chatgpt-subscription-support";
import { registerOperationalEmailContact } from "../../src/data/email-operational";
import { publishContactVerification } from "../../src/data/contact-verification";
import {
  recordEmailMessageReceipt,
  bindEmailMessageReceiptContact,
} from "../../src/data/email-mailbox";
import {
  recordCaseContextCollectionSuggestion,
  decideCaseContextCollectionRelationship,
  type CaseContextCollectionScope,
} from "../../src/case-context-discovery/relationships";
import { parseCaseContextDiscoveryPolicy } from "../../src/case-context-discovery/policy";
import { readEmailProposalFlow } from "../../src/actors/email-case-context-collection-evidence";
import {
  MEMORY_HEADING,
  MEMORY_LIMITATION_NOTICE,
} from "../../src/actors/model-context-prompt";
import {
  recordEmailProposalFlow,
  authorizeEmailProposalFlow,
  claimEmailCaseContextCollectionDraft,
  emailTurnDestinationMayReceive,
  readPlainReplyRecipient,
} from "../../src/actors/email-case-context-collection-evidence";
import {
  FlowBinding,
  FlowLabel,
  InformationFlowContext,
  digestFlowBinding,
  type FlowPolicyInput,
} from "../../src/policy/information-flow";
import type { CaseContextCollectionEffectAttempt } from "../../src/case-context-discovery/evidence";
import { sourceReaderForAuthority } from "../../src/policy/information-flow/source-readers";
import type { RequestAuthority } from "@purin-labs/contracts";
import {
  previewEmailProposal,
  dispatchEmailReply,
} from "../../src/actors/connector-email-proposal";
import { admitEmailThreadCase } from "../../src/actors/email-case-admission";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import {
  grantOwnerOrderRead,
  MAIL_OWNER_ORDER_GRANT,
  MAIL_SOURCE_ORDER_ID,
  seedMailOrderAccess,
  seedPurchasingContext,
  purchasingFixture,
} from "./mail-purchasing-support";
import {
  readEmailProposalSourceOutcome,
  readEmailProposalSources,
} from "../../src/actors/email-proposal-sources";
import {
  EmailSupplierContext,
  readEmailCommerceEvidence,
} from "../../src/mail-inbox/supplier-context";
import { buildAgentMailboxAuthority } from "../../src/request-authority";
import { admitControlTurnFixture } from "../organisation-execution-fixture";
import type { SessionTurnExecution } from "../../src/chat/turn-access";
import { gmailGetMessageContent } from "../../src/mail/gmail-adapter";
import {
  emailTurnSessionId,
  processEmailThreadTurn,
  type EmailThreadTurnInput,
} from "../../src/actors/email-case-processing";
import { resolveCaseTurnAgentProfile } from "../../src/data/pinned-agent-profile";
import { authorizeMailSource } from "../../src/mail-inbox/authorization";
import { buildControlAuthority } from "../../src/request-authority";
import { readActiveOrganisationMembershipRevision } from "../../src/data/control-plane";
import {
  digestModelRoute,
  resolveOrganisationModelRoute,
  resolveOrganisationModelRouteForSelection,
} from "../../src/models/route";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { env, exports } from "cloudflare:workers";
import {
  runInDurableObject,
  runDurableObjectAlarm,
  evictDurableObject,
} from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { bypass, http, HttpResponse, type HttpResponseResolver } from "msw";
import {
  parseMailInboxResult,
  parseMailOrganizationView,
  type CaseTimelineCase,
  type MailOrganizationCommand,
  type MailRule,
  type MailInboxCommand,
  type MailInboxResult,
} from "@purin-labs/control-api";
import {
  assertNever,
  isRecord,
  encodeBase64,
  encodeBase64Url,
  decodeBase64,
} from "@purin-labs/std";
import { network } from "./network";
import {
  bootstrapOrganisation,
  issueControlSession,
  revokeControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  createAccessGrant,
  revokeAccessGrant,
} from "../../src/data/access-grants";
import { requireVaultHandle } from "../test-ids";
import { storeVaultSecret } from "../../src/credential-vault";
import { parseInitialOrganisationPlacement } from "../../src/placement";
import {
  defaultDenyPolicy,
  readCurrentOrganisationPolicySnapshot,
} from "../../src/policy-snapshot";
import {
  GMAIL_FULL_MAILBOX_SCOPES,
  GMAIL_SEND_ONLY_SCOPES,
} from "../../src/mail/gmail-authorization";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import {
  parseIntegrationAccountId,
  type ConnectorId,
  type OrganisationId,
} from "../../src/ids";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import {
  gmailConnectorId,
  registerEmailMailboxAccount,
} from "../../src/data/email-mailbox";
import { resolveActiveProviderAccountContext } from "../../src/data/integration-account";
import { digestCanonical } from "../../src/policy/information-flow/digest";
import {
  readMailHead,
  claimMailWork,
  writeMailHead,
} from "../../src/mail-inbox/store";
import { mailEvaluationInput } from "../../src/mail-inbox/connector-runtime";
import { runMailOrganization } from "../../src/mail-inbox/connector-runtime";
import { runConnectorEmailEvaluation } from "../../src/actors/connector-email-evaluation";
import {
  readMailResponseOwner,
  claimMailResponseOwner,
} from "../../src/mail-inbox/response-store";
import type { InboxResponseOwner } from "../../src/mail-inbox/response-store";
import {
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import {
  parseCaseId,
  parseOrganisationId,
  parseSessionId,
  type IntegrationAccountId,
  type CaseId,
} from "../../src/ids";
import {
  recordEmailThreadCase,
  projectEmailReplyProposal,
  assignAgentMailbox,
  publishMailboxIngressPolicy,
} from "../../src/data/email-mailbox";
import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "../../src/data/agent-operations";
import {
  activateEmailRuntime,
  acceptEmailHint,
  nextEmailCorrectionLearningAt,
  recordEmailCorrectionLearning,
  recordEmailDraftOperation,
  latestEmailDraftOperation,
  emailTokenWindowTotals,
  reserveEmailTokens,
  utcDayKey,
} from "../../src/actors/connector-email";
import { readEmailProposalMemory } from "../../src/actors/email-proposal-memory";
import {
  dispatchRfcMessageId,
  deriveGmailReplyTarget,
  digestGmailReplyTarget,
  digestEmailBody,
  digestEmailSnapshot,
} from "../../src/mail/reply-target";
import type { CaseAssignment } from "@purin-labs/contracts";
import type { CaseGmailReplyProposal } from "../../src/actors/case/types";
import { decodeRaw } from "./gmail-mailbox-support";
import { controlFetch, modelToolResults } from "./chat-journey-support";
import type { OrganisationActorStub } from "../../src/env";

async function prepareMailBudgetJourney() {
  const owner = await client("mail-budget-pi-owner");
  const organisationId = await workspace(owner);
  // The account authority knows this Organisation and its owner, so each
  // control request passes the real account check.
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Mail budget acceptance",
    plan: "beta",
    status: "active",
    createdAt: Date.now(),
  });
  const rawAccountId = await mailbox(
    organisationId,
    owner,
    "budget",
    "full_mailbox_pilot",
  );
  const account = parseIntegrationAccountId(rawAccountId);
  if (!account.ok) throw new Error(account.error.code);
  const accountId = account.value;
  const now = Date.now();
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    environment: "development",
    googleSubject: "budget",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  await installWorkMailbox(organisationId, accountId, owner.identity.userId, now);
  const grant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: "grant_budget_context",
    subject: {
      kind: "agent_mailbox",
      integrationAccountId: accountId,
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
    },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "mail-budget-e2e",
    },
    now,
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const policy = await publishMailboxIngressPolicy({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    environment: "development",
    request: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 10_000,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
    publishedBy: owner.identity.userId,
    now,
  });
  if (!policy.ok || policy.value.kind !== "enabled")
    throw new Error("Missing budget policy");
  const writes = { count: 0 };
  network.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/*", gmailFixture),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      rejectBudgetProviderWrite.bind(null, writes),
    ),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      rejectBudgetProviderWrite.bind(null, writes),
    ),
  );
  const selection = await readOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId,
  });
  if (selection === null) throw new Error("Missing budget inference selection");
  const selected = await selectOrganisationInferenceSelection({
    db: fixtureDatabase(),
    organisationId,
    selection: { kind: "satyr_platform" },
    expectedConfigurationVersion: selection.configurationVersion,
    selectedByUserId: owner.identity.userId,
    now,
  });
  if (!selected.ok) throw new Error(selected.error.code);
  const route = await resolveOrganisationModelRoute({ env, organisationId, now });
  if (!route.ok) throw new Error(route.error.code);
  await fixtureDatabase().prepare(
    "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'mail-budget-e2e', 'synthetic-reviewer', ?, 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
  )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      "openrouter",
      now,
      now + 3600000,
      now,
    )
    .run();
  const connectorId = gmailConnectorId(accountId);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) throw new Error(connector.error.code);
  return {
    owner,
    organisationId,
    accountId,
    policyVersion: policy.value.policyVersion,
    now,
    connector,
    writes,
  };
}

it(
  "stops Pi mail work at the daily token budget, rejects an overrun without a draft and settles reported failed usage across real Actors",
  mailBudgetJourney,
  90_000,
);

/**
 * The daily token budget of a mailbox on Pi. A turn that fails after a
 * model response settles the usage that the provider reported. A turn that
 * spends more than its allowance makes no further model request, and its
 * reply never becomes a draft. When the day's budget is spent, the next
 * message gets no model turn. Nothing reaches Gmail.
 */
async function mailBudgetJourney(context: TestContext): Promise<void> {
  const {
    owner,
    organisationId,
    accountId,
    policyVersion,
    now,
    connector,
    writes,
  } = await prepareMailBudgetJourney();
  const model = new MailBudgetModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const outcomes: unknown[] = [];
  const budgets: unknown[] = [];
  for (const turn of [1, 2, 3] as const) {
    const caseId = parseCaseId(`case_gmail_${accountId}_budget_${turn}`);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const threadId = `budget_${turn}`;
    const messageId = `budget_message_${turn}`;
    const admitted = await admitEmailThreadCase(env, {
      scope: await requireMailFixtureScope(organisationId),
      organisationId,
      integrationAccountId: accountId,
      gmailThreadId: threadId,
      caseId: caseId.value,
      messageIds: [messageId],
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      policyVersion: policyVersion,
      receivedAt: now,
      subject: null,
    });
    if (!admitted.ok) throw new Error(admitted.error.code);
    const mapped = await recordEmailThreadCase({
      scope: await requireMailFixtureScope(organisationId),
      integrationAccountId: accountId,
      gmailThreadId: threadId,
      caseId: caseId.value,
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      now,
    });
    if (!mapped.ok) throw new Error(mapped.error.code);
    const fixture: DraftTurnFixture = {
      organisationId,
      integrationAccountId: accountId,
      threadId,
      caseId: caseId.value,
      messageIds: [messageId],
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      policyVersion: policyVersion,
      limits: {
        maxActiveCases: 5,
        maxMessagesPerHour: 20,
        dailyTokenBudget: 10_000,
        maxMessageBytes: 262144,
        maxAttachmentBytes: 5242880,
        debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      },
      responsePolicy: "cue_routed",
    };
    if (turn === 1)
      await runInDurableObject(
        connector.value,
        seedDraftRuntime.bind(null, fixture),
      );
    model.turn = turn;
    await runInDurableObject(
      connector.value,
      claimBudgetResponse.bind(null, { messageId, threadId }),
    );
    const outcome = await runInDurableObject(
      connector.value,
      executeDraftTurn.bind(null, fixture),
    );
    const budget = await runInDurableObject(
      connector.value,
      inspectDraftBudget,
    );
    outcomes.push(outcome);
    budgets.push(budget);
    if (turn === 1) {
      // The provider failed after one answer that reported 1,200 tokens.
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        ok: false,
        error: { code: "transient_email_turn_failed" },
      });
      expect(budget).toEqual({ reserved: 0, consumed: 1_200 });
    } else if (turn === 2) {
      // The first answer used 9,000 of the 8,800 tokens left for the day.
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        ok: false,
        error: { code: "transient_email_token_budget_exhausted" },
      });
      expect(budget).toEqual({ reserved: 0, consumed: 10_200 });
    } else {
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        ok: true,
        value: { kind: "skipped", reason: "daily_token_budget_exhausted" },
      });
      expect(budget).toEqual({ reserved: 0, consumed: 10_200 });
    }
    if (turn !== 3)
      // The operator sees a failed assignment and no reply for the thread.
      expect(
        await result(
          await send(organisationId, owner.session, {
            kind: "work",
            integrationAccountId: accountId,
            threadId,
          }),
        ),
      ).toMatchObject({
        kind: "work",
        work: {
          kind: "linked",
          assignments: [{ kind: "failed" }],
          replies: [],
        },
      });
    await evictDurableObject(connector.value);
  }
  // Turn 1 asked twice, turn 2 once: no request followed the spent
  // allowance, and the spent day asked nothing.
  expect(model.requests.map(requestTurn)).toEqual([1, 1, 2]);
  expect(writes.count).toBe(0);
  const evidence = {
    evidence: "mail_pi_budget_boundaries",
    providers: "synthetic OpenRouter on the platform route",
    dailyTokenBudget: 10_000,
    outcomes,
    budgets,
    modelRequests: model.requests,
    providerDraftOrSendWrites: writes.count,
  };
  Object.assign(context.task.meta, { mailPiBudget: evidence });
}

type MailBudgetRequest = {
  readonly turn: number;
  readonly toolResults: number;
};

function requestTurn(request: MailBudgetRequest): number {
  return request.turn;
}

/**
 * The platform model for the budget journey. Turn 1 reads its message and
 * then the provider fails. Turn 2 proposes a reply with a large answer.
 */
class MailBudgetModel {
  turn = 0;
  readonly requests: MailBudgetRequest[] = [];

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const toolResults = modelToolResults(await request.json());
    this.requests.push({ turn: this.turn, toolResults });
    if (this.turn === 1 && toolResults === 0)
      return budgetToolCall("read_email_case", {}, "budget_read", 1_200);
    if (this.turn === 1)
      return HttpResponse.json(
        { error: { message: "Upstream provider failed" } },
        { status: 500 },
      );
    if (this.turn === 2 && toolResults === 0)
      return budgetToolCall(
        "email_reply_for_approval",
        { body: "Over-budget reply must not become a draft.", sources: null },
        "budget_reply",
        9_000,
      );
    throw new Error(`Unexpected budget model request in turn ${this.turn}`);
  }
}

function budgetToolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
  totalTokens: number,
): Response {
  return openRouterStream([
    {
      id,
      object: "chat.completion.chunk",
      created: 1787500000,
      model: "moonshotai/kimi-k3",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1787500000,
      model: "moonshotai/kimi-k3",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: totalTokens - 100,
        completion_tokens: 100,
        total_tokens: totalTokens,
      },
    },
  ]);
}

it(
  "accounts for transient Pi mail goals through threshold stops, receipt replay and unknown usage without retaining content",
  transientPiGoalJourney,
  90_000,
);

async function transientPiGoalJourney(context: TestContext): Promise<void> {
  const { organisationId, accountId, policyVersion, now, connector, writes } =
    await prepareMailBudgetJourney();
  const model = new TransientGoalProvider();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const evidence: unknown[] = [];
  for (const phase of ["limit", "unknown"] as const) {
    model.phase = phase;
    const caseId = parseCaseId(`case_gmail_${accountId}_goal_${phase}`);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const threadId = `goal_${phase}`;
    const messageId = `goal_message_${phase}`;
    const admitted = await admitEmailThreadCase(env, {
      scope: await requireMailFixtureScope(organisationId),
      organisationId,
      integrationAccountId: accountId,
      gmailThreadId: threadId,
      caseId: caseId.value,
      messageIds: [messageId],
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      policyVersion: policyVersion,
      receivedAt: now,
      subject: null,
    });
    if (!admitted.ok) throw new Error(admitted.error.code);
    const goal = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId,
      caseId: caseId.value,
      now,
    });
    if (!goal.ok) throw new Error(goal.error.code);
    const identity = { organisationId, caseId: caseId.value };
    expect(
      await goal.value.applyGoalCommand({
        ...identity,
        commandId: `transient_goal_${phase}`,
        expectedRevision: 0,
        command: {
          kind: "set",
          objective: "Review supplier mail",
          tokenBudget: phase === "limit" ? 10 : 1000,
        },
      }),
    ).toMatchObject({ ok: true });
    const fixture: DraftTurnFixture = {
      organisationId,
      integrationAccountId: accountId,
      threadId,
      caseId: caseId.value,
      messageIds: [messageId],
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      policyVersion: policyVersion,
      limits: {
        maxActiveCases: 5,
        maxMessagesPerHour: 20,
        dailyTokenBudget: 10000,
        maxMessageBytes: 262144,
        maxAttachmentBytes: 5242880,
        debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      },
      responsePolicy: "cue_routed",
    };
    if (phase === "limit")
      await runInDurableObject(
        connector.value,
        seedDraftRuntime.bind(null, fixture),
      );
    await runInDurableObject(
      connector.value,
      claimBudgetResponse.bind(null, { messageId, threadId }),
    );
    const result = await runInDurableObject(
      connector.value,
      executeDraftTurn.bind(null, fixture),
    );
    expect(result.ok).toBe(false);
    const snapshot = await goal.value.readGoal(identity);
    if (phase === "limit") {
      expect(result).toMatchObject({
        error: { code: "transient_goal_stopped" },
      });
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          goal: {
            tokensUsed: 25,
            unknownOperations: 0,
            state: { kind: "budget_limited" },
          },
        },
      });
      expect(
        await runInDurableObject(connector.value, inspectDraftBudget),
      ).toEqual({ reserved: 0, consumed: 25 });
    } else {
      expect(snapshot).toMatchObject({
        ok: true,
        value: { goal: { tokensUsed: 0, unknownOperations: 1 } },
      });
      expect(
        await goal.value.applyGoalCommand({
          ...identity,
          commandId: "resume_unknown_transient",
          expectedRevision: 2,
          command: { kind: "resume" },
        }),
      ).toMatchObject({ ok: false, error: { code: "goal_usage_pending" } });
    }
    const row = await fixtureDatabase().prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active' ORDER BY reserved_at DESC",
    )
      .bind(organisationId)
      .first<{ name: string }>();
    if (row === null) throw new Error("Missing transient Session");
    const session = env.SESSION.getByName(row.name);
    const stored = await runInDurableObject(session, storedContent);
    expect(stored).not.toContain("TRANSIENT_GOAL_PRIVATE_CONTENT");
    if (phase === "limit") {
      expect(await runInDurableObject(session, loseTransientGoalReceipt)).toBe(
        1,
      );
      await evictDurableObject(session);
      expect(await runDurableObjectAlarm(session)).toBe(true);
      expect(await goal.value.readGoal(identity)).toEqual(snapshot);
    }
    await evictDurableObject(goal.value);
    expect(await goal.value.readGoal(identity)).toEqual(snapshot);
    evidence.push({ phase, goal: snapshot, calls: model.calls });
    if (phase === "limit") {
      expect(
        await goal.value.applyGoalCommand({
          ...identity,
          commandId: "raise_transient_goal",
          expectedRevision: 2,
          command: { kind: "update_budget", tokenBudget: 1000 },
        }),
      ).toMatchObject({ ok: true });
      expect(
        await goal.value.applyGoalCommand({
          ...identity,
          commandId: "resume_transient_goal",
          expectedRevision: 3,
          command: { kind: "resume" },
        }),
      ).toMatchObject({ ok: true });
      await runInDurableObject(
        session,
        abandonTransientGoalExecution.bind(null, caseId.value, "tracked"),
      );
      await evictDurableObject(session);
      expect(await runDurableObjectAlarm(session)).toBe(true);
      const recovered = await goal.value.readGoal(identity);
      expect(recovered).toMatchObject({
        ok: true,
        value: { goal: { tokensUsed: 25, unknownOperations: 1 } },
      });
      expect(
        await goal.value.applyGoalCommand({
          ...identity,
          commandId: "resume_abandoned_transient",
          expectedRevision: 5,
          command: { kind: "resume" },
        }),
      ).toMatchObject({ ok: false, error: { code: "goal_usage_pending" } });
      evidence.push({
        phase: "abandoned_dispatch",
        goal: recovered,
        calls: model.calls,
      });
      if (!recovered.ok) throw new Error(recovered.error.code);
      const cleared = await goal.value.applyGoalCommand({
        ...identity,
        commandId: "clear_before_enrollment_recovery",
        expectedRevision: recovered.value.revision,
        command: { kind: "clear" },
      });
      if (!cleared.ok) throw new Error(cleared.error.code);
      await runInDurableObject(
        session,
        abandonTransientGoalExecution.bind(null, caseId.value, "untracked"),
      );
      const replacement = {
        ...identity,
        commandId: "enroll_after_binding_recovery",
        expectedRevision: cleared.value.revision,
        command: {
          kind: "set" as const,
          objective: "Review the next message",
          tokenBudget: 1000,
        },
      };
      expect(await goal.value.applyGoalCommand(replacement)).toMatchObject({
        ok: false,
        error: { code: "goal_execution_running" },
      });
      await evictDurableObject(session);
      expect(await runDurableObjectAlarm(session)).toBe(true);
      const enrolled = await goal.value.applyGoalCommand(replacement);
      expect(enrolled).toMatchObject({
        ok: true,
        value: { goal: { tokensUsed: 0 } },
      });
      evidence.push({
        phase: "abandoned_untracked_binding",
        goal: enrolled,
        calls: model.calls,
      });
    }
  }
  expect(model.calls).toBe(2);
  expect(writes.count).toBe(0);
  Object.assign(context.task.meta, {
    transientGoalEvidence: {
      phases: evidence,
      providerWrites: writes.count,
      privateContentRetained: false,
    },
  });
}

function breakStream(controller: ReadableStreamDefaultController): void {
  controller.error(new Error("Response lost"));
}

class TransientGoalProvider {
  phase: "limit" | "unknown" = "limit";
  calls = 0;
  respond(): Response {
    this.calls += 1;
    // A lost answer: the stream starts with 200 and breaks before any
    // usage, so the tokens are unknown. An error status would count as zero.
    if (this.phase === "unknown")
      return new Response(new ReadableStream({ start: breakStream }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    return openRouterStream([
      {
        id: "transient_goal",
        object: "chat.completion.chunk",
        created: 1787500000,
        model: "moonshotai/kimi-k3",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "TRANSIENT_GOAL_PRIVATE_CONTENT",
              tool_calls: [
                {
                  index: 0,
                  id: "transient_no_reply",
                  type: "function",
                  function: { name: "email_no_reply", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "transient_goal",
        object: "chat.completion.chunk",
        created: 1787500000,
        model: "moonshotai/kimi-k3",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);
  }
}

async function abandonTransientGoalExecution(
  caseId: string,
  kind: "tracked" | "untracked",
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const row = state.storage.sql
    .exec<{ lease: string }>(
      "SELECT json_extract(request_envelope, '$.lease') AS lease FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) throw new Error("Missing transient lease");
  const raw: unknown = JSON.parse(row.lease);
  if (!isRecord(raw) || !isRecord(raw.turn))
    throw new Error("Invalid transient lease fixture");
  // A new message after clear has a new input identity; retries retain the old goal.
  if (kind === "untracked") raw.turn.inputId = "input_new_untracked_mail";
  const lease = parsePersistedHarnessTurnLease(raw);
  if (lease === null) throw new Error("Invalid transient lease");
  const execution = await createTransientGoalExecution(
    { env, storage: state.storage, liveRuns: new Set() },
    lease,
    caseId,
    1000,
  );
  expect(execution.control.kind).toBe(kind);
  if (execution.control.kind === "untracked") return;
  expect(await execution.control.begin()).toMatchObject({ ok: true });
  // Interrupt at the persisted dispatch boundary before a usage receipt exists.
}

function loseTransientGoalReceipt(
  _actor: unknown,
  state: DurableObjectState,
): number {
  const rows = state.storage.sql
    .exec<{ effect_id: string; state_projection: string }>(
      "SELECT effect_id, state_projection FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' AND state_kind = 'settled' AND json_extract(state_projection, '$.outcome.tokens') > 0",
    )
    .toArray();
  for (const row of rows)
    state.storage.sql.exec(
      "UPDATE actor_outbox SET state_kind = 'pending', state_projection = json_set(state_projection, '$.kind', 'settling') WHERE effect_id = ?",
      row.effect_id,
    );
  return rows.length;
}

function claimBudgetResponse(
  message: { messageId: string; threadId: string },
  _actor: unknown,
  state: DurableObjectState,
): void {
  claimMailResponseOwner(state.storage.sql, null, {
    ...message,
    historyId: "101",
  });
}

function rejectBudgetProviderWrite(writes: { count: number }): Response {
  writes.count++;
  return Response.json(
    { error: "Budget failure must never create or send mail" },
    { status: 500 },
  );
}

it(
  "publishes a supplier reply rule, fences historical reads and competing Cue admission, and coalesces future arrivals into one review draft across restart",
  draftOnlyJourney,
  90_000,
);

it(
  "atomically fences mail admission and workspace writes across relocation and evicted target recovery",
  draftWorkspacePlacementJourney,
  120_000,
);

it(
  "drains an issued supplier draft receipt during freeze and reuses it after target eviction",
  draftExecutionPlacementJourney,
  120_000,
);

it.for(["initialization", "begin"] as const)(
  "recovers supplier assignment preparation after freeze at %s and target eviction",
  { timeout: 120_000 },
  draftAssignmentPlacementJourney,
);

type MailboxPlacementBoundary =
  "watch_reset" | "watch_stop" | "watch_retry" | "mailbox_search";

it.for(["watch_reset", "watch_stop", "watch_retry", "mailbox_search"] as const)(
  "drains mailbox lifecycle %s across relocation and recovers durable watch state after eviction",
  { timeout: 120_000 },
  mailboxPlacementJourney,
);

function mailboxPlacementJourney(
  boundary: MailboxPlacementBoundary,
  context: TestContext,
): Promise<void> {
  return runDraftOnlyJourney(boundary, context);
}

type MailboxPlacementProvider = {
  starts: number;
  stops: number;
  deletes: number;
  protectedReads: number;
  expiration: number;
};

async function verifyMailboxPlacement(
  boundary: MailboxPlacementBoundary,
  input: ProposalPlacementFixture,
): Promise<void> {
  const inspected = await input.connector.inspectEmailRuntime();
  if (!inspected.ok || inspected.value === null)
    throw new Error("Missing mailbox runtime");
  const runtime = inspected.value;
  const provider: MailboxPlacementProvider = {
    starts: 0,
    stops: 0,
    deletes: 0,
    protectedReads: 0,
    expiration: Date.now() + 2 * 86_400_000,
  };
  const pause: DraftPreparationPause = { phase: "armed" };
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      pausedMailboxProvider.bind(null, boundary, pause, input, provider),
    ),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      pausedMailboxProvider.bind(null, boundary, pause, input, provider),
    ),
    http.delete(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
      deleteMailboxDraft.bind(null, provider),
    ),
  );
  if (boundary === "mailbox_search") {
    network.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        listMailboxSearch,
      ),
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1",
        pausedMailboxProvider.bind(null, boundary, pause, input, provider),
      ),
    );
  }
  if (boundary === "watch_reset") {
    network.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        freshMailboxProfile,
      ),
    );
  }
  const work = runMailboxPlacementCommand(
    boundary,
    input.connector,
    input,
    runtime,
  );
  let relocation: Promise<unknown> | null = null;
  try {
    await expect
      .poll(draftPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: input.identity.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    relocation = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, input.connector), {
        timeout: 10_000,
      })
      .toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
      )
        .bind(started.value.relocationId)
        .first(),
    ).toEqual({ total: 0 });
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: {
        code:
          boundary === "mailbox_search"
            ? "connector_execution_authority_inactive"
            : "connector_placement_conflict",
      },
    });
    const frozen = await runInDurableObject(
      input.connector,
      inspectMailboxPlacementState,
    );
    if (boundary === "watch_stop") {
      expect(frozen).toMatchObject({
        cleanupAt: null,
        runtime: { watchExpiresAt: null },
      });
    } else if (boundary === "watch_retry") {
      expect(frozen.cleanupAt).toBeTypeOf("number");
    }
    if (boundary === "watch_reset") {
      expect(frozen.runtime).toMatchObject({
        activationFloor: "200",
        acceptedHistoryId: "200",
      });
    }
    await relocation;
    await evictDurableObject(input.connector);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: input.identity.organisationId,
      connectorId: input.identity.connectorId,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    expect(
      await runInDurableObject(recovered.value, inspectMailboxPlacementState),
    ).toEqual(frozen);
    await evictDurableObject(recovered.value);
    if (boundary === "watch_retry") {
      expect(
        await recovered.value.activateEmailProcessing({
          identity: input.identity,
          integrationAccountId: runtime.integrationAccountId,
          policyVersion: runtime.policyVersion,
          limits: runtime.limits,
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "connector_email_watch_cleanup_pending" },
      });
      await runInDurableObject(recovered.value, advanceWatchCleanupClock);
      await runDurableObjectAlarm(recovered.value);
    } else if (boundary === "mailbox_search") {
      expect(
        await runMailboxPlacementCommand(
          boundary,
          recovered.value,
          input,
          runtime,
        ),
      ).toMatchObject({
        ok: true,
        value: {
          messages: [
            {
              messageId: "m1",
              bodyText: "Private body: packaging delivery delayed for PR-A.",
            },
          ],
        },
      });
    }
    if (boundary === "watch_stop" || boundary === "watch_retry") {
      expect(
        await recovered.value.revokeEmailMailbox({
          identity: input.identity,
          kind: "stand_down",
          integrationAccountId: runtime.integrationAccountId,
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: true,
        value: { watchStopped: true, disposals: [] },
      });
      expect(
        await runInDurableObject(recovered.value, inspectMailboxPlacementState),
      ).toMatchObject({ cleanupAt: null, runtime: { watchExpiresAt: null } });
    } else {
      expect(await recovered.value.inspectEmailRuntime()).toMatchObject({
        ok: true,
        value: { disabledAt: null },
      });
    }
    await verifyRetiredMailbox(input, runtime);
    await evictDurableObject(recovered.value);
    await runDurableObjectAlarm(recovered.value);
    await runDurableObjectAlarm(input.connector);
    const expectedStops =
      boundary === "watch_retry" ? 2 : boundary === "watch_stop" ? 1 : 0;
    const expectedDeletes =
      boundary === "watch_stop" || boundary === "watch_retry" ? 1 : 0;
    expect(provider).toMatchObject({
      starts: boundary === "watch_reset" ? 1 : 0,
      stops: expectedStops,
      deletes: expectedDeletes,
    });
    expect(input.model).toMatchObject({
      calls: 4,
      drafts: 1,
      sends: 0,
      edits: 0,
    });
    const retained = await runInDurableObject(recovered.value, storedContent);
    expect(retained).not.toContain("DRAFT_PRIVATE_REPLY");
    Object.assign(input.context.task.meta, {
      mailboxPlacement: {
        boundary,
        exportsWhilePaused: 0,
        frozenOutputWithheld: true,
        targetRecoveredAfterEviction: true,
        retiredSourceRejected: true,
        providerStarts: provider.starts,
        providerStops: provider.stops,
        providerDeletes: provider.deletes,
        modelCalls: 4,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(relocation === null ? [work] : [work, relocation]);
  }
}

function runMailboxPlacementCommand(
  boundary: MailboxPlacementBoundary,
  connector: ProposalPlacementFixture["connector"],
  input: ProposalPlacementFixture,
  runtime: import("../../src/actors/connector-email").EmailRuntimeSnapshot,
) {
  const request = { identity: input.identity, now: Date.now() };
  switch (boundary) {
    case "watch_reset":
      return connector.reconnectEmailProcessing({
        ...request,
        integrationAccountId: runtime.integrationAccountId,
        policyVersion: runtime.policyVersion,
        limits: runtime.limits,
        resetCursor: true,
      });
    case "watch_stop":
    case "watch_retry":
      return connector.revokeEmailMailbox({
        identity: input.identity,
        kind: "stand_down",
        integrationAccountId: runtime.integrationAccountId,
        now: Date.now(),
      });
    case "mailbox_search":
      return connector.searchEmailMailbox({
        ...request,
        execution: input.execution,
        query: "in:inbox",
        limit: 1,
      });
    default:
      return assertNever(boundary);
  }
}

async function verifyRetiredMailbox(
  input: ProposalPlacementFixture,
  runtime: import("../../src/actors/connector-email").EmailRuntimeSnapshot,
): Promise<void> {
  const request = { identity: input.identity, now: Date.now() };
  const activation = {
    ...request,
    integrationAccountId: runtime.integrationAccountId,
    policyVersion: runtime.policyVersion,
    limits: runtime.limits,
  };
  const denied = { ok: false, error: { code: "connector_placement_conflict" } };
  expect(
    await input.connector.activateEmailProcessing(activation),
  ).toMatchObject(denied);
  expect(await input.connector.disableEmailProcessing(request)).toMatchObject(
    denied,
  );
  expect(
    await input.connector.resumeEmailProcessing({
      ...activation,
      skipProviderMessageId: null,
    }),
  ).toMatchObject(denied);
  expect(
    await input.connector.reconnectEmailProcessing({
      ...activation,
      resetCursor: false,
    }),
  ).toMatchObject(denied);
  expect(
    await input.connector.reconnectEmailProcessing({
      ...activation,
      resetCursor: true,
    }),
  ).toMatchObject(denied);
  expect(await input.connector.renewEmailWatch(request)).toMatchObject(denied);
  expect(
    await input.connector.revokeEmailMailbox({
      identity: input.identity,
      kind: "stand_down",
      integrationAccountId: runtime.integrationAccountId,
      now: Date.now(),
    }),
  ).toMatchObject(denied);
  expect(
    await input.connector.acceptEmailChange({
      ...request,
      notificationId: "retired_hint",
      historyId: "103",
    }),
  ).toMatchObject(denied);
  expect(
    await input.connector.searchEmailMailbox({
      ...request,
      execution: input.execution,
      query: "in:inbox",
      limit: 1,
    }),
  ).toMatchObject(denied);
  expect(await input.connector.inspectEmailRuntime()).toMatchObject(denied);
}

async function pausedMailboxProvider(
  boundary: MailboxPlacementBoundary,
  pause: DraftPreparationPause,
  input: ProposalPlacementFixture,
  provider: MailboxPlacementProvider,
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const path = new URL(request.request.url).pathname;
  let response: Response;
  if (path.endsWith("/watch")) {
    provider.starts++;
    response = HttpResponse.json({
      historyId: "100",
      expiration: String(provider.expiration),
    });
  } else if (path.endsWith("/stop")) {
    provider.stops++;
    response =
      boundary === "watch_retry" && provider.stops === 1
        ? new Response("Synthetic watch stop failure", { status: 503 })
        : new Response(null, { status: 204 });
  } else {
    provider.protectedReads++;
    response = draftOnlyGmailRead(input.model, request);
  }
  if (pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return response;
}

function deleteMailboxDraft(provider: MailboxPlacementProvider): Response {
  provider.deletes++;
  return new Response(null, { status: 204 });
}

function freshMailboxProfile(): Response {
  return HttpResponse.json({
    emailAddress: "shop@example.test",
    historyId: "200",
  });
}

function listMailboxSearch(): Response {
  return HttpResponse.json({ messages: [{ id: "m1", threadId: "t1" }] });
}

function inspectMailboxPlacementState(
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    runtime: readEmailRuntime(state.storage.sql),
    cleanupAt:
      state.storage.sql
        .exec<{ at: number }>(
          "SELECT available_at AS at FROM connector_email_watch_cleanup WHERE singleton = 1",
        )
        .toArray()[0]?.at ?? null,
  };
}

function advanceWatchCleanupClock(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE connector_email_watch_cleanup SET available_at = ?",
    Date.now() - 1,
  );
}

type ProposalPlacementBoundary =
  "review" | "edit" | "correction" | "send" | "reconcile" | "cleanup";

it.for([
  "review",
  "edit",
  "correction",
  "send",
  "reconcile",
  "cleanup",
] as const)(
  "drains supplier proposal %s across freeze and recovers on the evicted target without duplicate effects",
  { timeout: 120_000 },
  proposalPlacementJourney,
);

function proposalPlacementJourney(
  boundary: ProposalPlacementBoundary,
  context: TestContext,
): Promise<void> {
  return runDraftOnlyJourney(boundary, context);
}

function draftOnlyJourney(context: TestContext): Promise<void> {
  return runDraftOnlyJourney("full", context);
}

function draftWorkspacePlacementJourney(context: TestContext): Promise<void> {
  return runDraftOnlyJourney("workspace", context);
}

function draftExecutionPlacementJourney(context: TestContext): Promise<void> {
  return runDraftOnlyJourney("execution", context);
}

function draftAssignmentPlacementJourney(
  boundary: "initialization" | "begin",
  context: TestContext,
): Promise<void> {
  return runDraftOnlyJourney(boundary, context);
}

type DraftPreparationPause = {
  phase: "armed" | "paused" | "released";
};

type ProposalPlacementFixture = Readonly<{
  execution: SessionTurnExecution;
  connector: DurableObjectStub<
    import("../../src/actors/connector").ConnectorDO
  >;
  identity: Readonly<{ organisationId: OrganisationId; connectorId: ConnectorId }>;
  proposalId: string;
  authority: Extract<RequestAuthority, { kind: "control" }>;
  model: DraftModelFixture;
  context: TestContext;
}>;

type ProposalPlacementCommand =
  | Readonly<{
      kind: Exclude<ProposalPlacementBoundary, "correction">;
      snapshot: import("../../src/actors/connector-email-proposal").EmailProposalPreview;
      correction?: never;
    }>
  | Readonly<{
      kind: "correction";
      correction: import("@purin-labs/control-api").MailReplyCorrection;
      snapshot?: never;
    }>;

async function prepareProposalPlacementCommand(
  boundary: ProposalPlacementBoundary,
  input: ProposalPlacementFixture,
  snapshot: import("../../src/actors/connector-email-proposal").EmailProposalPreview,
): Promise<ProposalPlacementCommand> {
  if (boundary !== "correction") return { kind: boundary, snapshot };
  const selected = await input.connector.previewEmailRelationship({
    identity: input.identity,
    proposalId: input.proposalId,
    authority: input.authority,
    lookup: {
      kind: "purchase_request",
      supplierEntryId: "directory_supplier_packaging",
      purchaseRequestId: "PR-A",
    },
    now: Date.now(),
  });
  if (!selected.ok || selected.value.kind !== "purchase_request")
    throw new Error("Missing relationship correction evidence");
  return {
    kind: "correction",
    correction: {
      version: selected.value.version,
      snapshotDigest: selected.value.snapshotDigest,
      relationshipDigest: selected.value.relationshipDigest,
      supplierEntryId: "directory_supplier_packaging",
      purchaseRequestId: "PR-A",
      body: "CORRECTED_PRIVATE_REPLY: PR-A requires 20 each; none received. Please confirm the revised arrival.",
      challenge: "fixture-verified-before-RPC",
    },
  };
}

async function startProposalReceiptMove(organisationId: OrganisationId) {
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.path);
  return startActorRelocation({
    env,
    organisationId,
    target: target.value,
    now: Date.now(),
  });
}

function settleProposalReceipt(
  relocationId: string,
  receipt: unknown,
  token: string | undefined,
): Promise<Response> {
  return exports.default.fetch(
    new Request("https://localhost/v1/admin/state-object-relocation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "reconcile_mail_receipt",
        relocationId,
        receipt,
      }),
    }),
  );
}

async function verifyProposalPlacement(
  boundary: ProposalPlacementBoundary,
  input: ProposalPlacementFixture,
): Promise<void> {
  const preview = await input.connector.previewEmailProposal({
    identity: input.identity,
    proposalId: input.proposalId,
    now: Date.now(),
  });
  if (!preview.ok || preview.value.kind !== "current")
    throw new Error("Missing supplier review snapshot");
  const snapshot = preview.value.preview;
  const command = await prepareProposalPlacementCommand(
    boundary,
    input,
    snapshot,
  );
  const delivery: ReviewDeliveryFixture = {
    sends: 0,
    sentRaw: "",
    found: boundary !== "reconcile",
    deletes: 0,
  };
  const pause: DraftPreparationPause = { phase: "armed" };
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      successfulProposalSend.bind(null, input.model),
    ),
    http.delete(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
      deleteReviewedDraft.bind(null, delivery),
    ),
  );
  const reservedMove =
    boundary === "send" || boundary === "reconcile"
      ? await startProposalReceiptMove(input.identity.organisationId)
      : null;
  if (boundary === "reconcile") {
    network.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        loseProposalSend.bind(null, input.model),
      ),
    );
    expect(
      await input.connector.dispatchReviewedEmailReply({
        identity: input.identity,
        proposalId: input.proposalId,
        authority: input.authority,
        approvedVersion: snapshot.currentVersion,
        approvedSnapshotDigest: snapshot.snapshotDigest,
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true, value: { kind: "send_indeterminate" } });
    network.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        pausedProposalResponse.bind(null, boundary, pause, input, delivery),
      ),
    );
  } else if (boundary === "edit" || boundary === "correction") {
    network.use(
      http.put(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
        pausedProposalResponse.bind(null, boundary, pause, input, delivery),
      ),
    );
  } else if (boundary === "send") {
    network.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        pausedProposalResponse.bind(null, boundary, pause, input, delivery),
      ),
    );
  } else if (boundary === "cleanup") {
    network.use(
      http.delete(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
        pausedProposalResponse.bind(null, boundary, pause, input, delivery),
      ),
    );
  } else {
    network.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
        pausedProposalResponse.bind(null, boundary, pause, input, delivery),
      ),
    );
  }
  const work = runProposalPlacementCommand(command, input.connector, input);
  let relocation: Promise<unknown> | null = null;
  try {
    await expect
      .poll(draftPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const started =
      reservedMove ?? (await startProposalReceiptMove(input.identity.organisationId));
    if (!started.ok) throw new Error(started.error.code);
    relocation = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, input.connector), {
        timeout: 10_000,
      })
      .toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
      )
        .bind(started.value.relocationId)
        .first(),
    ).toEqual({ total: 0 });
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    expect(input.model.calls).toBe(4);
    expect(input.model.drafts).toBe(1);
    expect(delivery.deletes).toBe(boundary === "cleanup" ? 1 : 0);
    if (boundary === "reconcile") {
      expect(await relocation).toMatchObject({
        ok: false,
        error: { code: "relocation_provider_work_unresolved" },
      });
      const state = await runInDurableObject(
        input.connector,
        inspectMailboxPlacementState,
      );
      if (state.runtime === null)
        throw new Error("Missing frozen mailbox runtime");
      const receipt = {
        kind: "reply",
        connectorId: input.identity.connectorId,
        integrationAccountId: state.runtime.integrationAccountId,
        proposalId: input.proposalId,
        version: snapshot.currentVersion,
        snapshotDigest: snapshot.snapshotDigest,
        rfcMessageId: dispatchRfcMessageId(
          input.proposalId,
          snapshot.currentVersion,
          "shop@example.test",
        ),
        providerMessageId: "gmail_reviewed_receipt",
        providerThreadId: snapshot.threadId,
      };
      expect(
        (
          await settleProposalReceipt(
            started.value.relocationId,
            receipt,
            "invalid-admin-token",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await settleProposalReceipt(
            started.value.relocationId,
            { ...receipt, snapshotDigest: "0".repeat(64) },
            env.ORGANISATION_ADMIN_TOKEN,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await settleProposalReceipt(
            started.value.relocationId,
            receipt,
            env.ORGANISATION_ADMIN_TOKEN,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await settleProposalReceipt(
            started.value.relocationId,
            receipt,
            env.ORGANISATION_ADMIN_TOKEN,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await settleProposalReceipt(
            started.value.relocationId,
            { ...receipt, providerMessageId: "conflicting-receipt" },
            env.ORGANISATION_ADMIN_TOKEN,
          )
        ).status,
      ).toBe(409);
      relocation = resumeActorRelocation({
        env,
        relocationId: started.value.relocationId,
        now: Date.now(),
      });
      expect(await relocation).toMatchObject({ ok: true, value: { status: "retained" } });
      expect((await settleProposalReceipt(started.value.relocationId, receipt, env.ORGANISATION_ADMIN_TOKEN)).status).toBe(409);
    }
    const frozen = await runInDurableObject(
      input.connector,
      inspectProposalPlacementReceipt.bind(null, input.proposalId),
    );
    let frozenState = "awaiting_approval";
    let frozenSendReceipt: string | null = null;
    if (boundary === "send" || boundary === "reconcile") {
      frozenState = "cleanup_pending";
      frozenSendReceipt = "gmail_reviewed_receipt";
    } else if (boundary === "correction") {
      frozenState = "invalidated";
    } else if (boundary === "cleanup") {
      frozenState = "deleted";
    }
    expect(frozen).toMatchObject({
      version: boundary === "correction" ? 2 : 1,
      state: frozenState,
      sentMessageId: frozenSendReceipt,
    });
    expect(
      await fixtureDatabase().prepare(
        "SELECT current_version AS version, lifecycle_kind AS lifecycle FROM email_reply_proposal WHERE organisation_id = ? AND proposal_id = ?",
      )
        .bind(input.identity.organisationId, input.proposalId)
        .first(),
    ).toEqual({ version: 1, lifecycle: "awaiting_approval" });
    expect(await relocation).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(input.connector);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: input.identity.organisationId,
      connectorId: input.identity.connectorId,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    await runInDurableObject(
      recovered.value,
      inspectProposalPlacementReceipt.bind(null, input.proposalId),
    );
    await evictDurableObject(recovered.value);
    if (boundary === "send" || boundary === "reconcile") {
      await runInDurableObject(
        recovered.value,
        advanceProposalMaintenance.bind(null, input.proposalId),
      );
      await runDurableObjectAlarm(recovered.value);
      expect(
        await fixtureDatabase().prepare(
          "SELECT lifecycle_kind AS lifecycle FROM email_reply_proposal WHERE organisation_id = ? AND proposal_id = ?",
        )
          .bind(input.identity.organisationId, input.proposalId)
          .first(),
      ).toEqual({ lifecycle: "sent" });
    }
    if (command.kind === "correction") {
      const current = await recovered.value.previewEmailProposal({
        identity: input.identity,
        proposalId: input.proposalId,
        now: Date.now(),
      });
      expect(current).toMatchObject({
        ok: true,
        value: {
          kind: "current",
          preview: {
            currentVersion: 2,
            body: command.correction.body,
            state: "awaiting_approval",
          },
        },
      });
      if (!current.ok || current.value.kind !== "current")
        throw new Error("Correction did not recover");
      expect(
        await recovered.value.dispatchReviewedEmailReply({
          identity: input.identity,
          proposalId: input.proposalId,
          authority: input.authority,
          approvedVersion: snapshot.currentVersion,
          approvedSnapshotDigest: snapshot.snapshotDigest,
          now: Date.now(),
        }),
      ).toMatchObject({ ok: true, value: { kind: "stale_approval" } });
      expect(
        await recovered.value.dispatchReviewedEmailReply({
          identity: input.identity,
          proposalId: input.proposalId,
          authority: input.authority,
          approvedVersion: current.value.preview.currentVersion,
          approvedSnapshotDigest: current.value.preview.snapshotDigest,
          now: Date.now(),
        }),
      ).toMatchObject({ ok: true, value: { kind: "sent", version: 2 } });
      expect(
        await runProposalPlacementCommand(command, recovered.value, input),
      ).toMatchObject({ ok: false });
    } else if (boundary === "edit") {
      expect(
        await recovered.value.previewEmailProposal({
          identity: input.identity,
          proposalId: input.proposalId,
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: true,
        value: {
          kind: "current",
          preview: {
            currentVersion: 2,
            body: "Edited supplier reply after exact review.",
          },
        },
      });
      expect(
        await runProposalPlacementCommand(command, recovered.value, input),
      ).toMatchObject({ ok: false, error: { code: "email_reply_edit_stale" } });
    } else {
      const resumed = await runProposalPlacementCommand(
        command,
        recovered.value,
        input,
      );
      expect(resumed.ok).toBe(true);
      if (boundary === "send") {
        expect(resumed).toMatchObject({
          value: { kind: "sent", providerMessageId: "gmail_reviewed_receipt" },
        });
        await recovered.value.resolveEmailProposal({
          identity: input.identity,
          proposalId: input.proposalId,
          dispatchVersion: 1,
          now: Date.now(),
        });
      }
    }
    const expectedSends =
      boundary === "send" ||
      boundary === "reconcile" ||
      boundary === "correction"
        ? 1
        : 0;
    const expectedDeletes =
      expectedSends === 1 || boundary === "cleanup" ? 1 : 0;
    expect(input.model.sends).toBe(expectedSends);
    expect(delivery.deletes).toBe(expectedDeletes);
    expect(input.model.edits).toBe(
      boundary === "edit" || boundary === "correction" ? 1 : 0,
    );
    expect(
      await runProposalPlacementCommand(command, input.connector, input),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    await evictDurableObject(recovered.value);
    await runProposalPlacementCommand(command, recovered.value, input);
    await runDurableObjectAlarm(input.connector);
    expect({
      sends: input.model.sends,
      deletes: delivery.deletes,
      edits: input.model.edits,
      drafts: input.model.drafts,
      calls: input.model.calls,
    }).toEqual({
      sends: expectedSends,
      deletes: expectedDeletes,
      edits: boundary === "edit" || boundary === "correction" ? 1 : 0,
      drafts: 1,
      calls: 4,
    });
    const retained = await runInDurableObject(recovered.value, storedContent);
    expect(retained).not.toContain("Edited supplier reply after exact review.");
    expect(retained).not.toContain("DRAFT_PRIVATE_REPLY");
    expect(retained).not.toContain("CORRECTED_PRIVATE_REPLY");
    Object.assign(input.context.task.meta, {
      supplierProposalPlacement: {
        boundary,
        exportsWhilePaused: 0,
        frozenOutputWithheld: true,
        frozenCleanupWithheld: boundary !== "cleanup",
        targetRecoveredAfterEviction: true,
        retiredSourceRejected: true,
        providerSends: expectedSends,
        providerDeletes: expectedDeletes,
        providerEdits: input.model.edits,
        providerDrafts: 1,
        modelCalls: 4,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(relocation === null ? [work] : [work, relocation]);
  }
}

function runProposalPlacementCommand(
  command: ProposalPlacementCommand,
  connector: ProposalPlacementFixture["connector"],
  input: ProposalPlacementFixture,
) {
  const request = {
    identity: input.identity,
    proposalId: input.proposalId,
    now: Date.now(),
  };
  switch (command.kind) {
    case "review":
      return connector.previewEmailProposal(request);
    case "edit":
      return connector.editReviewedEmailReply({
        identity: input.identity,
        proposalId: input.proposalId,
        now: request.now,
        authority: input.authority,
        edit: {
          version: command.snapshot.currentVersion,
          snapshotDigest: command.snapshot.snapshotDigest,
          body: "Edited supplier reply after exact review.",
          challenge: "fixture-verified-before-RPC",
        },
      });
    case "send":
      return connector.dispatchReviewedEmailReply({
        identity: input.identity,
        proposalId: input.proposalId,
        now: request.now,
        authority: input.authority,
        approvedVersion: command.snapshot.currentVersion,
        approvedSnapshotDigest: command.snapshot.snapshotDigest,
      });
    case "correction":
      return connector.correctEmailRelationship({
        ...request,
        authority: input.authority,
        correction: command.correction,
      });
    case "reconcile":
      return connector.resolveEmailProposal({
        identity: input.identity,
        proposalId: input.proposalId,
        now: request.now,
        dispatchVersion: 1,
      });
    case "cleanup":
      return connector.disposeEmailProposal(request);
    default:
      return assertNever(command);
  }
}

async function pausedProposalResponse(
  boundary: ProposalPlacementBoundary,
  pause: DraftPreparationPause,
  input: ProposalPlacementFixture,
  delivery: ReviewDeliveryFixture,
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  let response: Response;
  switch (boundary) {
    case "review":
      response = draftOnlyGmailRead(input.model, request);
      break;
    case "edit":
    case "correction":
      response = await updatePurchasingDraft(input.model, request);
      break;
    case "send":
      response = await successfulProposalSend(input.model, request);
      break;
    case "reconcile":
      response = findReviewedSend(input.proposalId, 1, delivery, request);
      break;
    case "cleanup":
      response = deleteReviewedDraft(delivery);
      break;
    default:
      return assertNever(boundary);
  }
  if (pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return response;
}

async function successfulProposalSend(
  model: DraftModelFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.raw !== "string" || body.threadId !== "t1")
    throw new Error("Invalid immutable supplier send");
  const sent = atob(body.raw.replaceAll("-", "+").replaceAll("_", "/"));
  const drafted = atob(model.raw.replaceAll("-", "+").replaceAll("_", "/"));
  expect(sent).toContain("To: supplier@example.test\r\n");
  const expectedBody =
    model.editedBody ??
    atob(drafted.split("\r\n\r\n")[1]?.replaceAll(/\s/gu, "") ?? "");
  expect(atob(sent.split("\r\n\r\n")[1]?.replaceAll(/\s/gu, "") ?? "")).toBe(
    expectedBody,
  );
  model.sends++;
  return HttpResponse.json({ id: "gmail_reviewed_receipt", threadId: "t1" });
}

async function loseProposalSend(
  model: DraftModelFixture,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  await successfulProposalSend(model, input);
  return new Response("Synthetic lost send receipt", { status: 503 });
}

function inspectProposalPlacementReceipt(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  return state.storage.sql
    .exec<{ version: number; state: string; sentMessageId: string | null }>(
      "SELECT version, state, sent_message_id AS sentMessageId FROM connector_email_draft WHERE proposal_id = ? ORDER BY version DESC LIMIT 1",
      proposalId,
    )
    .one();
}

function advanceProposalMaintenance(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE connector_email_draft SET updated_at = ? WHERE proposal_id = ?",
    Date.now() - EMAIL_RESOLVE_GRACE_MS - 1,
    proposalId,
  );
  state.storage.sql.exec("DELETE FROM connector_email_maintenance");
}

async function verifyDraftAssignmentPlacement(
  boundary: "initialization" | "begin",
  input: Readonly<{
    connector: DurableObjectStub<
      import("../../src/actors/connector").ConnectorDO
    >;
    organisationId: OrganisationId;
    connectorId: import("../../src/ids").ConnectorId;
    caseId: CaseId;
    model: DraftModelFixture;
    context: TestContext;
  }>,
): Promise<void> {
  const pause: DraftPreparationPause = { phase: "armed" };
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: input.organisationId,
    caseId: input.caseId,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  // The turn answers the newer of the two arrivals on the thread.
  const sessionId = parseSessionId(emailTurnSessionId(input.caseId, "m1"));
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const session = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: input.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!session.ok) throw new Error(session.error.code);
  if (boundary === "initialization")
    await runInDurableObject(
      session.value,
      pauseActorResponse.bind(null, pause, "initializeCaseSession"),
    );
  else
    await runInDurableObject(
      caseActor.value,
      pauseActorResponse.bind(null, pause, "beginAssignment"),
    );
  await runInDurableObject(input.connector, advanceObservationClock);
  const work = runDurableObjectAlarm(input.connector);
  let relocation: Promise<unknown> | null = null;
  try {
    await expect
      .poll(draftPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual({ calls: 0, drafts: 0, sends: 0 });
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: input.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    relocation = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, input.connector), {
        timeout: 10_000,
      })
      .toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
      )
        .bind(started.value.relocationId)
        .first(),
    ).toEqual({ total: 0 });
    pause.phase = "released";
    await work;
    expect(
      await runInDurableObject(caseActor.value, inspectAssignmentPreparation),
    ).toEqual({
      assignments: 1,
      kind: boundary === "begin" ? "settled" : "assigned",
    });
    expect(
      await runInDurableObject(session.value, inspectAssignmentInitialization),
    ).toEqual({ parents: 1, initializations: 1 });
    expect(
      await runInDurableObject(input.connector, inspectDraftOwner),
    ).toMatchObject({
      kind: "inbox",
      state:
        boundary === "begin"
          ? { kind: "complete", outcome: "failed" }
          : { kind: "ready" },
    });
    const budget = await runInDurableObject(
      input.connector,
      inspectDraftBudget,
    );
    expect(budget).toMatchObject({ reserved: 0, consumed: 0 });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM email_reply_proposal WHERE organisation_id = ?",
      )
        .bind(input.organisationId)
        .first(),
    ).toEqual({ total: 0 });
    await relocation;
    await evictDurableObject(input.connector);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: input.organisationId,
      connectorId: input.connectorId,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    await runInDurableObject(recovered.value, inspectDraftOwner);
    await evictDurableObject(recovered.value);
    await runDurableObjectAlarm(recovered.value);
    const targetCase = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: input.organisationId,
      caseId: input.caseId,
      now: Date.now(),
    });
    const targetSession = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: input.organisationId,
      sessionId: sessionId.value,
      now: Date.now(),
    });
    if (!targetCase.ok || !targetSession.ok)
      throw new Error("Missing target preparation Actors");
    expect(
      await runInDurableObject(targetCase.value, inspectAssignmentPreparation),
    ).toEqual({ assignments: 1, kind: "settled" });
    expect(
      await runInDurableObject(
        targetSession.value,
        inspectAssignmentInitialization,
      ),
    ).toEqual({ parents: 1, initializations: 1 });
    expect(
      await runInDurableObject(targetCase.value, admittedMailTriggerCount),
    ).toBe(1);
    const expected =
      boundary === "begin"
        ? { calls: 0, drafts: 0, sends: 0 }
        : { calls: 4, drafts: 1, sends: 0 };
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual(expected);
    await evictDurableObject(recovered.value);
    await runDurableObjectAlarm(recovered.value);
    await runDurableObjectAlarm(input.connector);
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual(expected);
    Object.assign(input.context.task.meta, {
      supplierAssignmentPlacement: {
        boundary,
        exportsWhilePaused: 0,
        frozenModelCalls: 0,
        frozenDrafts: 0,
        frozenReplyProjections: 0,
        assignmentCount: 1,
        sessionInitializationCount: 1,
        targetRecoveredAfterEviction: true,
        retiredSourceAlarmHadNoEffects: true,
        targetDrafts: expected.drafts,
        providerSends: 0,
        reservedTokens: budget.reserved,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(relocation === null ? [work] : [work, relocation]);
  }
}

function inspectAssignmentPreparation(
  _actor: unknown,
  state: DurableObjectState,
) {
  return state.storage.sql
    .exec<{ assignments: number; kind: string }>(
      "SELECT COUNT(*) AS assignments, MAX(json_extract(lifecycle_json, '$.kind')) AS kind FROM case_assignment",
    )
    .one();
}

function inspectAssignmentInitialization(
  _actor: unknown,
  state: DurableObjectState,
) {
  const parent = state.storage.sql
    .exec<{ parents: number }>(
      "SELECT COUNT(*) AS parents FROM session_case_parent",
    )
    .one();
  const journal = state.storage.sql
    .exec<{ initializations: number }>(
      "SELECT COUNT(*) AS initializations FROM actor_journal WHERE json_extract(envelope, '$.body.kind') = 'session_initialized'",
    )
    .one();
  return { parents: parent.parents, initializations: journal.initializations };
}

async function verifyDraftExecutionPlacement(
  input: Readonly<{
    connector: DurableObjectStub<
      import("../../src/actors/connector").ConnectorDO
    >;
    organisationId: OrganisationId;
    connectorId: import("../../src/ids").ConnectorId;
    caseId: CaseId;
    integrationAccountId: IntegrationAccountId;
    model: DraftModelFixture;
    context: TestContext;
  }>,
): Promise<void> {
  const scope = await requireMailFixtureScope(input.organisationId);
  const pause: DraftPreparationPause = { phase: "armed" };
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      pausedIssuedReplyDraft.bind(null, pause, input.model),
    ),
  );
  await runInDurableObject(input.connector, advanceObservationClock);
  const work = runDurableObjectAlarm(input.connector);
  let relocation: Promise<unknown> | null = null;
  try {
    await expect
      .poll(draftPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual({ calls: 4, drafts: 1, sends: 0 });
    const sourceCase = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: input.organisationId,
      caseId: input.caseId,
      now: Date.now(),
    });
    if (!sourceCase.ok) throw new Error(sourceCase.error.code);
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: input.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    relocation = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, input.connector), {
        timeout: 10_000,
      })
      .toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
      )
        .bind(started.value.relocationId)
        .first(),
    ).toEqual({ total: 0 });
    await verifyFrozenReplyProjection(
      scope,
      input.integrationAccountId,
      input.caseId,
    );
    pause.phase = "released";
    await work;
    expect(
      await runInDurableObject(input.connector, inspectDraftOwner),
    ).toMatchObject({
      kind: "inbox",
      state: { kind: "complete", outcome: "failed" },
    });
    expect(
      await runInDurableObject(sourceCase.value, inspectFrozenReplyCase),
    ).toEqual({
      proposals: 0,
      assignment: "settled",
      code: "connector_placement_conflict",
    });
    const budget = await runInDurableObject(
      input.connector,
      inspectDraftBudget,
    );
    expect(budget.reserved).toBe(0);
    expect(budget.consumed).toBe(25);
    expect(
      await runInDurableObject(input.connector, inspectIssuedReplyReceipt),
    ).toEqual({
      drafts: 1,
      draftId: "draft_only",
      state: "awaiting_approval",
    });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM email_reply_proposal WHERE organisation_id = ?",
      )
        .bind(input.organisationId)
        .first(),
    ).toEqual({ total: 0 });
    await relocation;
    await evictDurableObject(input.connector);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: input.organisationId,
      connectorId: input.connectorId,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    await runInDurableObject(recovered.value, inspectIssuedReplyReceipt);
    await evictDurableObject(recovered.value);
    await runDurableObjectAlarm(recovered.value);
    expect(
      await runInDurableObject(recovered.value, inspectIssuedReplyReceipt),
    ).toEqual({
      drafts: 1,
      draftId: "draft_only",
      state: "awaiting_approval",
    });
    const recoverySessionId = parseSessionId(
      emailTurnSessionId(input.caseId, "m1"),
    );
    if (!recoverySessionId.ok) throw new Error(recoverySessionId.error.code);
    const request = {
      identity: { organisationId: input.organisationId, connectorId: input.connectorId },
      execution: {
        sessionId: recoverySessionId.value,
        turnId: "turn_reply_receipt_recovery",
        requestAuthority: buildAgentMailboxAuthority({
          organisationId: input.organisationId,
          integrationAccountId: input.integrationAccountId,
          mailboxBindingId: "binding_work",
          bindingRevision: 1,
          mailboxPolicyVersion: 1,
        }).requestAuthority,
      },
      proposalId: `proposal_${input.caseId}_m1`,
      caseId: input.caseId,
      messageId: "m1",
      threadId: "t1",
      body: "DRAFT_PRIVATE_REPLY: PR-A is recorded late, expected 29 September. Please confirm the revised packaging arrival.",
      sources: { sources: [], dropped: 0 },
      chatSources: [],
      chatContext: { memory: [], projects: [] },
      now: Date.now(),
    };
    expect(
      await input.connector.createEmailReplyProposal(request),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    const reused = await recovered.value.createEmailReplyProposal(request);
    if (!reused.ok) throw new Error(reused.error.code);
    expect(reused.value.record.providerDraftId).toBe("draft_only");
    await verifyFrozenReplyProjection(
      scope,
      input.integrationAccountId,
      input.caseId,
    );
    const targetCase = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: input.organisationId,
      caseId: input.caseId,
      now: Date.now(),
    });
    if (!targetCase.ok) throw new Error(targetCase.error.code);
    expect(
      await targetCase.value.acceptEmailProposal(reused.value.record),
    ).toMatchObject({ ok: true, value: { kind: "accepted" } });
    expect(
      await projectEmailReplyProposal({
        scope: await requireMailFixtureScope(input.organisationId),
        integrationAccountId: input.integrationAccountId,
        proposalId: reused.value.record.proposalId,
        caseId: input.caseId,
        gmailThreadId: "t1",
        currentVersion: 1,
        lifecycleKind: "awaiting_approval",
        now: Date.now(),
      }),
    ).toEqual({ ok: true, value: null });
    await evictDurableObject(recovered.value);
    expect(
      await recovered.value.createEmailReplyProposal(request),
    ).toMatchObject({
      ok: true,
      value: { record: { providerDraftId: "draft_only" } },
    });
    expect(
      await targetCase.value.acceptEmailProposal(reused.value.record),
    ).toMatchObject({ ok: true, value: { kind: "duplicate" } });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM email_reply_proposal WHERE organisation_id = ?",
      )
        .bind(input.organisationId)
        .first(),
    ).toEqual({ total: 1 });
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual({ calls: 4, drafts: 1, sends: 0 });
    Object.assign(input.context.task.meta, {
      supplierReplyExecutionPlacement: {
        exportsWhilePaused: 0,
        modelCalls: 4,
        providerDrafts: 1,
        providerSends: 0,
        frozenCaseProposals: 0,
        frozenReplyProjections: 0,
        receiptImportedAfterEviction: true,
        retiredSourceRejected: true,
        duplicateDraftSuppressed: true,
        canonicalTargetProposals: 1,
        reservedTokens: budget.reserved,
        consumedTokens: budget.consumed,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(relocation === null ? [work] : [work, relocation]);
  }
}

async function pausedIssuedReplyDraft(
  pause: DraftPreparationPause,
  model: DraftModelFixture,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const response = await draftOnlyGmailWrite(model, input);
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
  return response;
}

function inspectIssuedReplyReceipt(_actor: unknown, state: DurableObjectState) {
  const draft = state.storage.sql
    .exec<{ total: number; draftId: string; state: string }>(
      "SELECT COUNT(*) AS total, MAX(draft_id) AS draftId, MAX(state) AS state FROM connector_email_draft",
    )
    .one();
  return {
    drafts: draft.total,
    draftId: draft.draftId,
    state: draft.state,
  };
}

function inspectFrozenReplyCase(_actor: unknown, state: DurableObjectState) {
  const proposal = state.storage.sql
    .exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM case_email_proposal",
    )
    .one();
  const assignment = state.storage.sql
    .exec<{ kind: string; code: string }>(
      "SELECT json_extract(lifecycle_json, '$.kind') AS kind, json_extract(lifecycle_json, '$.disposition.code') AS code FROM case_assignment LIMIT 1",
    )
    .one();
  return {
    proposals: proposal.total,
    assignment: assignment.kind,
    code: assignment.code,
  };
}

async function verifyFrozenReplyProjection(
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
  caseId: CaseId,
): Promise<void> {
  expect(
    await projectEmailReplyProposal({
      scope,
      integrationAccountId,
      caseId,
      proposalId: `proposal_${caseId}_m1`,
      gmailThreadId: "t1",
      currentVersion: 1,
      lifecycleKind: "awaiting_approval",
      now: Date.now(),
    }),
  ).toEqual({ ok: false, error: { code: "organisation_placement_conflict" } });
}

async function verifyDraftReplyPlacement(
  input: Readonly<{
    connector: DurableObjectStub<
      import("../../src/actors/connector").ConnectorDO
    >;
    organisationId: OrganisationId;
    connectorId: import("../../src/ids").ConnectorId;
    model: DraftModelFixture;
    context: TestContext;
  }>,
): Promise<void> {
  const pause: DraftPreparationPause = { phase: "armed" };
  const workspaceCommit = await startPausedWorkspaceRevision(
    input.organisationId,
  );
  const head = await runInDurableObject(input.connector, readObservationHead);
  const caseId = parseCaseId(`case_gmail_${head.integrationAccountId}_t1`);
  if (!caseId.ok) throw new Error(caseId.error.code);
  await fixtureDatabase().prepare(
    "DELETE FROM organisation_default_workspace WHERE organisation_id = ?",
  )
    .bind(input.organisationId)
    .run();
  pauseWorkspaceWriteBatch(
    pause,
    workspaceCommit.scope.database,
    "INSERT OR IGNORE INTO organisation_workspace",
  );
  await runInDurableObject(input.connector, advanceObservationClock);
  const work = runDurableObjectAlarm(input.connector);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(draftPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: input.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    completion = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, input.connector), {
        timeout: 10_000,
      })
      .toBe(1);
    const exported = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
    )
      .bind(started.value.relocationId)
      .first<{ total: number }>();
    expect(exported?.total).toBe(0);
    workspaceCommit.pause.phase = "released";
    expect(await workspaceCommit.work).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    await verifyFrozenMailAdmissionWrites(
      workspaceCommit.scope,
      head.integrationAccountId,
      caseId.value,
    );
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM workspace_revision WHERE organisation_id = ? AND workspace_id = 'workspace_frozen_mail'",
      )
        .bind(input.organisationId)
        .first(),
    ).toMatchObject({ total: 0 });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM email_message_receipt WHERE organisation_id = ? AND provider_message_id = 'm1'",
      )
        .bind(input.organisationId)
        .first(),
    ).toMatchObject({ total: 0 });
    pause.phase = "released";
    await work;
    expect(
      await runInDurableObject(input.connector, inspectDraftOwner),
    ).toMatchObject({ kind: "inbox", state: { kind: "ready" } });
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual({ calls: 0, drafts: 0, sends: 0 });
    const frozenCases = await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS total FROM email_thread_case WHERE organisation_id = ? AND gmail_thread_id = 't1'",
    )
      .bind(input.organisationId)
      .first<{ total: number }>();
    expect(frozenCases?.total).toBe(0);
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM organisation_default_workspace WHERE organisation_id = ?",
      )
        .bind(input.organisationId)
        .first(),
    ).toMatchObject({ total: 0 });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(input.connector);
    expect(
      await input.connector.readMailOrganization({
        identity: { organisationId: input.organisationId, connectorId: input.connectorId },
        integrationAccountId: head.integrationAccountId,
        authority: head.authority,
        messageIds: ["m1"],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    expect(input.model.calls).toBe(0);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: input.organisationId,
      connectorId: input.connectorId,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    await runInDurableObject(recovered.value, inspectDraftOwner);
    await evictDurableObject(recovered.value);
    const alarmRan = await runDurableObjectAlarm(recovered.value);
    expect(alarmRan).toBe(true);
    const recoveredOwner = await runInDurableObject(
      recovered.value,
      inspectDraftOwner,
    );
    expect(
      recoveredOwner,
      JSON.stringify({
        recoveredOwner,
        alarmRan,
        modelCalls: input.model.calls,
        drafts: input.model.drafts,
      }),
    ).toMatchObject({
      kind: "inbox",
      state: { kind: "complete", outcome: "draft" },
    });
    expect({
      calls: input.model.calls,
      drafts: input.model.drafts,
      sends: input.model.sends,
    }).toEqual({ calls: 4, drafts: 1, sends: 0 });
    const targetCase = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: input.organisationId,
      caseId: caseId.value,
      now: Date.now(),
    });
    if (!targetCase.ok) throw new Error(targetCase.error.code);
    expect(
      await runInDurableObject(targetCase.value, admittedMailTriggerCount),
    ).toBe(1);
    await evictDurableObject(recovered.value);
    await runDurableObjectAlarm(recovered.value);
    expect(input.model.drafts).toBe(1);
    const targetScope = await requireMailFixtureScope(input.organisationId);
    const prepared = await prepareWorkspaceRevisionMutation(
      targetScope,
      { kind: "placement" },
      env.ARCHIVE,
      workspaceCommit.proposal,
    );
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(
      await commitWorkspaceRevision(env.ARCHIVE, { ...prepared.value }),
    ).toMatchObject({
      ok: false,
      error: { code: "workspace_revision_input_invalid" },
    });
    expect(
      await commitWorkspaceRevision(env.ARCHIVE, prepared.value),
    ).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(
      await commitWorkspaceRevision(env.ARCHIVE, prepared.value),
    ).toMatchObject({ ok: true, value: { kind: "duplicate" } });
    expect(
      await commitWorkspaceRevision(env.ARCHIVE, workspaceCommit.prepared),
    ).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    await verifyFrozenMailAdmissionWrites(
      workspaceCommit.scope,
      head.integrationAccountId,
      caseId.value,
    );
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM workspace_revision_receipt WHERE organisation_id = ? AND workspace_id = 'workspace_frozen_mail'",
      )
        .bind(input.organisationId)
        .first(),
    ).toMatchObject({ total: 1 });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM organisation_default_workspace WHERE organisation_id = ?",
      )
        .bind(input.organisationId)
        .first(),
    ).toMatchObject({ total: 1 });
    expect(
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS total FROM email_message_receipt WHERE organisation_id = ? AND provider_message_id = 'm1'",
      )
        .bind(input.organisationId)
        .first(),
    ).toMatchObject({ total: 1 });
    Object.assign(input.context.task.meta, {
      supplierReplyPreparationPlacement: {
        boundary: "workspace",
        exportsWhilePaused: 0,
        frozenDrafts: 0,
        frozenCases: 0,
        readyWorkRecovered: true,
        recoveryAlarmRestored: true,
        retiredSourceRejected: true,
        targetDraftsAfterEviction: 1,
        targetTriggers: 1,
        atomicWorkspaceWrites: true,
        atomicEmailProjections: true,
        sends: 0,
      },
    });
  } finally {
    pause.phase = "released";
    workspaceCommit.pause.phase = "released";
    await Promise.allSettled([workspaceCommit.work]);
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

async function startPausedWorkspaceRevision(organisationId: OrganisationId) {
  const scope = await requireMailFixtureScope(organisationId);
  const proposal = {
    kind: "genesis" as const,
    organisationId,
    workspaceId: "workspace_frozen_mail",
    idempotencyKey: "frozen-mail-genesis",
    files: [
      {
        path: "workspace.yaml",
        mediaType: "application/yaml",
        content: "name: Frozen mail acceptance\n",
      },
    ],
    correlationId: "frozen-mail-genesis",
    causation: { kind: "command" as const, commandId: "frozen-mail-genesis" },
    committedAt: 0,
  };
  const prepared = await prepareWorkspaceRevisionMutation(
    scope,
    { kind: "placement" },
    env.ARCHIVE,
    proposal,
  );
  if (!prepared.ok) throw new Error(prepared.error.code);
  const pause: DraftPreparationPause = { phase: "armed" };
  const batch = Reflect.get(scope.database, "batch");
  Object.defineProperty(scope.database, "batch", {
    configurable: true,
    value: pauseWorkspaceBatch.bind(null, pause, scope.database, batch),
  });
  const work = commitWorkspaceRevision(env.ARCHIVE, prepared.value);
  try {
    await expect
      .poll(draftPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
  } catch (error) {
    pause.phase = "released";
    const completed = await work;
    throw new Error(
      `${String(error)}; workspace commit: ${JSON.stringify(completed)}`,
    );
  }
  return { scope, proposal, prepared: prepared.value, pause, work };
}

function pauseWorkspaceWriteBatch(
  pause: DraftPreparationPause,
  database: D1Database,
  statementPrefix: string,
): void {
  const original = Reflect.get(database, "prepare");
  Object.defineProperty(database, "prepare", {
    configurable: true,
    value: interceptWorkspaceBinding.bind(
      null,
      pause,
      database,
      statementPrefix,
      original,
    ),
  });
}

function interceptWorkspaceBinding(
  pause: DraftPreparationPause,
  database: D1Database,
  statementPrefix: string,
  original: Function,
  query: string,
) {
  if (query.includes(statementPrefix)) {
    Object.defineProperty(database, "prepare", {
      configurable: true,
      value: original,
    });
    const batch = Reflect.get(database, "batch");
    Object.defineProperty(database, "batch", {
      configurable: true,
      value: pauseWorkspaceBatch.bind(null, pause, database, batch),
    });
  }
  return Reflect.apply(original, database, [query]);
}

async function pauseWorkspaceBatch(
  pause: DraftPreparationPause,
  database: D1Database,
  original: Function,
  statements: D1PreparedStatement[],
) {
  Object.defineProperty(database, "batch", {
    configurable: true,
    value: original,
  });
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
  return Reflect.apply(original, database, [statements]);
}

async function verifyFrozenMailAdmissionWrites(
  scope: OrganisationExecutionScope,
  integrationAccountId: string,
  caseId: CaseId,
): Promise<void> {
  const account = parseIntegrationAccountId(integrationAccountId);
  if (!account.ok) throw new Error(account.error.code);
  expect(
    await recordEmailThreadCase({
      scope,
      integrationAccountId: account.value,
      gmailThreadId: "t1",
      caseId,
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: false, error: { code: "organisation_placement_conflict" } });
  expect(
    await recordEmailMessageReceipt({
      scope,
      integrationAccountId: account.value,
      gmailThreadId: "t1",
      providerMessageId: "m1",
      caseId,
      policyVersion: 1,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: false, error: { code: "organisation_placement_conflict" } });
}

function pauseActorResponse(
  pause: DraftPreparationPause,
  method: "initializeCaseSession" | "beginAssignment",
  actor: object,
): void {
  const original = Reflect.get(actor, method);
  if (typeof original !== "function")
    throw new Error(`Missing Actor ${method}`);
  const prototype = Object.getPrototypeOf(actor);
  const pausedPrototype = Object.create(prototype);
  // Native RPC rejects methods defined directly on an Actor instance.
  Object.defineProperty(pausedPrototype, method, {
    configurable: true,
    value: settlePausedActorResponse.bind(
      null,
      pause,
      actor,
      prototype,
      original,
    ),
  });
  Object.setPrototypeOf(actor, pausedPrototype);
}

async function settlePausedActorResponse(
  pause: DraftPreparationPause,
  actor: object,
  prototype: object,
  original: Function,
  input: unknown,
): Promise<unknown> {
  Object.setPrototypeOf(actor, prototype);
  const result = await Reflect.apply(original, actor, [input]);
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
  return result;
}

function admittedMailTriggerCount(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM case_journal WHERE entry_id = 'trigger:trigger_email_m1'",
    )
    .one().total;
}

function draftPreparationPhase(
  pause: DraftPreparationPause,
): DraftPreparationPause["phase"] {
  return pause.phase;
}

type DraftTurnFixture = Omit<
  EmailThreadTurnInput,
  "connectorSql" | "now" | "scope"
>;
type DraftModelFixture = {
  phase: "draft" | "hostile" | "indeterminate";
  phaseCalls: number;
  calls: number;
  drafts: number;
  sends: number;
  raw: string;
  editedBody: string | null;
  edits: number;
  history: "empty" | "arrivals" | "hostile" | "indeterminate";
  revokeOperatorOnDraftRead: boolean;
};

async function runDraftOnlyJourney(
  scenario:
    | "full"
    | "workspace"
    | "execution"
    | "initialization"
    | "begin"
    | ProposalPlacementBoundary
    | MailboxPlacementBoundary,
  testContext: TestContext,
): Promise<void> {
  const owner = await client("mail-draft-owner");
  const organisationId = await workspace(owner);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const rawAccount = await mailbox(
    organisationId,
    owner,
    "draft-only",
    "full_mailbox_pilot",
  );
  const account = parseIntegrationAccountId(rawAccount);
  const caseId = parseCaseId(`case_gmail_${rawAccount}_t1`);
  if (!account.ok || !caseId.ok)
    throw new Error("Invalid draft fixture identity");
  const now = Date.now();
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    googleSubject: "draft-only",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  await installWorkMailbox(organisationId, account.value, owner.identity.userId, now);
  const merchantId = await seedPurchasingContext(
    organisationId,
    owner.identity.userId,
    account.value,
  );
  const otherAgentCommands: AgentOperationCommand[] = [
    {
      kind: "create_agent_definition",
      operationId: "agent_other",
      actorUserId: owner.identity.userId,
      now,
      displayName: "Other agent",
      role: "research",
      purpose: "Unbound fixture",
      instructions: "Different agent instructions",
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_other",
      actorUserId: owner.identity.userId,
      now,
      agentDefinitionId: "agent_other",
      definitionRevision: 1,
      areaId: "area_work",
      responsibility: "Other work",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of otherAgentCommands) {
    const applied = await applyAgentOperation(fixtureDatabase(), organisationId, command);
    if (!applied.ok) throw new Error(applied.error.code);
  }
  expect(
    await resolveCaseTurnAgentProfile(await requireMailFixtureScope(organisationId), {
      caseId: caseId.value,
      assignmentId: "assignment_selection_probe",
      assignment: "new",
      selection: { kind: "automatic" },
      now,
    }),
  ).toEqual({ kind: "unselected" });
  const policy = await publishMailboxIngressPolicy({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    request: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 10_000,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
    publishedBy: owner.identity.userId,
    now,
  });
  if (!policy.ok || policy.value.kind !== "enabled")
    throw new Error("Missing fixture ingress policy");
  const contextGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: "grant_draft_context",
    subject: {
      kind: "agent_mailbox",
      integrationAccountId: account.value,
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
    },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "draft-e2e",
    },
    now,
  });
  if (!contextGrant.ok) throw new Error(contextGrant.error.code);
  await fixtureDatabase().prepare(
    "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
  )
    .bind(organisationId, owner.identity.userId, now)
    .run();
  const route = await resolveOrganisationModelRoute({ env, organisationId, now });
  if (!route.ok) throw new Error(route.error.code);
  await fixtureDatabase().prepare(
    "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'synthetic-draft-only-e2e', 'synthetic-reviewer', 'openrouter', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
  )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      now,
      now + 3600000,
      now,
    )
    .run();
  const fixture: DraftTurnFixture = {
    organisationId,
    integrationAccountId: account.value,
    threadId: "t1",
    caseId: caseId.value,
    messageIds: ["m0", "m1"],
    mailboxBindingId: "binding_work",
    bindingRevision: 1,
    policyVersion: policy.value.policyVersion,
    limits: {
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 10000,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    },
    responsePolicy: "draft_only",
  };
  const connectorId = gmailConnectorId(account.value);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) throw new Error(connector.error.code);
  await runInDurableObject(
    connector.value,
    seedDraftRuntime.bind(null, fixture),
  );
  const model: DraftModelFixture = {
    phase: "draft",
    phaseCalls: 0,
    calls: 0,
    drafts: 0,
    sends: 0,
    raw: "",
    editedBody: null,
    edits: 0,
    history: "empty",
    revokeOperatorOnDraftRead: false,
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      draftOnlyModel.bind(null, model),
    ),
  );
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      draftOnlyGmailRead.bind(null, model),
    ),
  );
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      draftOnlyGmailWrite.bind(null, model),
    ),
  );
  const organisation = await requireActiveOrganisationActor({ env, organisationId, now });
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      investigationClassificationFixture,
    ),
  );
  await organisation.ensureOrganisation({
    organisationId,
    name: "Supplier reply rules",
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  const connected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: "typesafe-mail-e2e-key-000000",
    },
  );
  expect(connected.status, await connected.clone().text()).toBe(200);
  const context = await resolveActiveProviderAccountContext({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
  });
  if (!context.ok) throw new Error(context.error.code);
  const sourcePin = await digestCanonical({
    providerConnectionId: context.value.connection.providerConnectionId,
    authority: context.value.connection.authority,
    updatedAt: context.value.connection.updatedAt,
  });
  await fixtureDatabase().prepare(
    `INSERT INTO mail_classification_eligibility
    (organisation_id,integration_account_id,source_pin,connection_revision,model,purpose,evidence_reference,evidence_owner,disclosed_recipient,reviewed_at,review_expires_at,revoked_at)
    VALUES (?, ?, ?, 1, 'jev-1.13.0', 'mail_classification', 'fixture-review', 'fixture-owner', 'typesafe', ?, ?, NULL)`,
  )
    .bind(organisationId, account.value, sourcePin, now, now + 3600000)
    .run();
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      investigationClassificationFixture,
    ),
  );
  const actionRule: MailRule = {
    kind: "investigate_supplier_delay",
    ruleId: "supplier_reply",
    instruction: "Supplier explicitly reports a packaging delivery delay",
  };
  expect(
    (
      await organizationSend(organisationId, owner.session, account.value, {
        kind: "publish",
        expectedRevision: 0,
        rules: [actionRule],
        consent: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await organizationSend(organisationId, owner.session, account.value, {
        kind: "classify",
        expectedRevision: 1,
        messageIds: ["m2"],
      })
    ).status,
  ).toBe(200);
  await runInDurableObject(connector.value, reconcileDraftOrganization);
  expect(
    await runInDurableObject(
      connector.value,
      executeDraftTurn.bind(null, { ...fixture, responsePolicy: "cue_routed" }),
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "email_response_owner_conflict" },
  });
  expect({
    calls: model.calls,
    drafts: model.drafts,
    sends: model.sends,
  }).toEqual({ calls: 0, drafts: 0, sends: 0 });
  expect(
    await result(
      await send(organisationId, owner.session, {
        kind: "work",
        integrationAccountId: account.value,
        threadId: "t2",
      }),
    ),
  ).toMatchObject({ kind: "work", work: { kind: "unlinked" } });
  model.history = "arrivals";
  const cue = await runInDurableObject(connector.value, reconcileDraftCue);
  expect(cue).toMatchObject({ kind: "evaluated", admitted: 0, threads: [] });
  expect(
    await runInDurableObject(connector.value, inspectDraftOwner),
  ).toMatchObject({ kind: "inbox", state: { kind: "classifying" } });
  if (
    scenario === "initialization" ||
    scenario === "begin" ||
    scenario === "execution" ||
    scenario === "workspace"
  ) {
    if (scenario === "initialization" || scenario === "begin") {
      await verifyDraftAssignmentPlacement(scenario, {
        connector: connector.value,
        organisationId,
        connectorId: connectorId.value,
        caseId: caseId.value,
        model,
        context: testContext,
      });
      return;
    }
    if (scenario === "execution") {
      await verifyDraftExecutionPlacement({
        connector: connector.value,
        organisationId,
        connectorId: connectorId.value,
        caseId: caseId.value,
        integrationAccountId: account.value,
        model,
        context: testContext,
      });
      return;
    }
    await verifyDraftReplyPlacement({
      connector: connector.value,
      organisationId,
      connectorId: connectorId.value,
      model,
      context: testContext,
    });
    return;
  }
  await evictDurableObject(connector.value);
  await runInDurableObject(connector.value, advanceObservationClock);
  await runInDurableObject(connector.value, reconcileDraftOrganization);
  expect(
    await runInDurableObject(connector.value, inspectDraftOwner),
  ).toMatchObject({
    kind: "inbox",
    state: { kind: "complete", outcome: "draft" },
  });
  expect(model.calls).toBe(4);
  expect(model.drafts).toBe(1);
  expect(model.sends).toBe(0);
  if (scenario !== "full") {
    const membershipRevision = await readActiveOrganisationMembershipRevision({
      db: fixtureDatabase(),
      organisationId,
    });
    const person = await fixtureDatabase().prepare(
      "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
    )
      .bind(organisationId, owner.identity.userId)
      .first<{ personId: string }>();
    if (membershipRevision === null || person === null)
      throw new Error("Missing supplier review authority");
    const authority = buildControlAuthority({
      organisationId,
      userId: owner.identity.userId,
      membershipRevision,
      requesterPersonId: person.personId,
      role: "owner",
    }).requestAuthority;
    const placementFixture: ProposalPlacementFixture = {
      connector: connector.value,
      identity: { organisationId, connectorId: connectorId.value },
      proposalId: `proposal_${caseId.value}_m1`,
      authority,
      execution: await admitControlTurnFixture(
        env,
        authority,
        owner.session.session.controlSessionId,
      ),
      model,
      context: testContext,
    };
    if (
      scenario === "watch_reset" ||
      scenario === "watch_stop" ||
      scenario === "watch_retry" ||
      scenario === "mailbox_search"
    ) {
      await verifyMailboxPlacement(scenario, placementFixture);
    } else {
      await verifyProposalPlacement(scenario, placementFixture);
    }
    return;
  }
  const rawEmail = atob(model.raw.replaceAll("-", "+").replaceAll("_", "/"));
  expect(rawEmail).toContain("To: supplier@example.test\r\n");
  const separator = rawEmail.indexOf("\r\n\r\n");
  expect(separator).toBeGreaterThan(0);
  expect(atob(rawEmail.slice(separator + 4).replaceAll(/\s/gu, ""))).toBe(
    "DRAFT_PRIVATE_REPLY: PR-A is recorded late, expected 29 September. Please confirm the revised packaging arrival.",
  );
  const work = await result(
    await send(organisationId, owner.session, {
      kind: "work",
      integrationAccountId: account.value,
      threadId: "t1",
    }),
  );
  expect(work).toMatchObject({
    kind: "work",
    work: {
      kind: "linked",
      assignments: [{ kind: "completed" }],
      replies: [{ version: 1, state: { kind: "awaiting_approval" } }],
    },
  });
  const preview = await result(
    await send(organisationId, owner.session, {
      kind: "reply",
      integrationAccountId: account.value,
      threadId: "t1",
      proposalId: `proposal_${caseId.value}_m1`,
    }),
  );
  expect(preview).toMatchObject({
    kind: "reply",
    preview: {
      kind: "current",
      body: "DRAFT_PRIVATE_REPLY: PR-A is recorded late, expected 29 September. Please confirm the revised packaging arrival.",
    },
  });
  const reviewed = await controlFetch(
    organisationId,
    owner.session,
    `email-replies/proposal_${caseId.value}_m1`,
    null,
  );
  expect(reviewed.status).toBe(200);
  const reviewedBody: unknown = await reviewed.json();
  if (
    !isRecord(reviewedBody) ||
    !isRecord(reviewedBody.proposal) ||
    typeof reviewedBody.proposal.snapshot_digest !== "string" ||
    typeof reviewedBody.challenge !== "string"
  )
    throw new Error("Missing purchasing approval snapshot");
  const approvedSnapshotDigest = reviewedBody.proposal.snapshot_digest;
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'operator purchasing acceptance revocation' WHERE organisation_id = ? AND grant_id = 'grant_mail_operator_supplier_directory'",
  )
    .bind(organisationId)
    .run();
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "reply",
        integrationAccountId: account.value,
        threadId: "t1",
        proposalId: `proposal_${caseId.value}_m1`,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await controlFetch(
        organisationId,
        owner.session,
        `email-replies/proposal_${caseId.value}_m1`,
        null,
      )
    ).status,
  ).toBe(403);
  const deniedApproval = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/email-replies/proposal_${caseId.value}_m1/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://localhost",
        cookie: `satyr_control_session=${owner.session.token}; satyr_control_csrf=${owner.session.csrfToken}`,
        "x-satyr-csrf": owner.session.csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        version: 1,
        snapshotDigest: approvedSnapshotDigest,
        challenge: reviewedBody.challenge,
      }),
    },
  );
  expect(deniedApproval.status).toBe(403);
  expect(model.sends).toBe(0);
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'active', revision = revision + 1, reason = NULL WHERE organisation_id = ? AND grant_id = 'grant_mail_operator_supplier_directory'",
  )
    .bind(organisationId)
    .run();
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
      revokePurchasingDuringDraftRead.bind(null, organisationId, model),
    ),
  );
  model.revokeOperatorOnDraftRead = true;
  const interruptedApproval = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/email-replies/proposal_${caseId.value}_m1/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://localhost",
        cookie: `satyr_control_session=${owner.session.token}; satyr_control_csrf=${owner.session.csrfToken}`,
        "x-satyr-csrf": owner.session.csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        version: 1,
        snapshotDigest: approvedSnapshotDigest,
        challenge: reviewedBody.challenge,
      }),
    },
  );
  expect(interruptedApproval.status).toBe(502);
  expect(await interruptedApproval.json()).toMatchObject({
    error: "email_commerce_unavailable",
  });
  expect(model.revokeOperatorOnDraftRead).toBe(false);
  expect(model.sends).toBe(0);
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'active', revision = revision + 1, reason = NULL WHERE organisation_id = ? AND grant_id = 'grant_mail_operator_supplier_directory'",
  )
    .bind(organisationId)
    .run();
  const pin = await fixtureDatabase().prepare(
    "SELECT installation_id AS installationId, definition_revision AS revision FROM case_assignment_pin WHERE organisation_id = ? AND assignment_id = ?",
  )
    .bind(organisationId, `assignment_${caseId.value}_m1`)
    .first();
  expect(pin).toEqual({ installationId: "installation_work", revision: 1 });
  const update = await applyAgentOperation(fixtureDatabase(), organisationId, {
    kind: "publish_agent_definition_revision",
    operationId: "draft_agent_update",
    actorUserId: owner.identity.userId,
    now: Date.now(),
    agentDefinitionId: "agent_work",
    expectedRevision: 1,
    instructions: "Updated purchasing instructions",
    requestedCapabilities: [],
    skillRefs: [],
  });
  if (!update.ok) throw new Error(update.error.code);
  const activated = await applyAgentOperation(fixtureDatabase(), organisationId, {
    kind: "activate_agent_definition_revision",
    operationId: "draft_agent_activate",
    actorUserId: owner.identity.userId,
    now: Date.now(),
    installationId: "installation_work",
    expectedDefinitionRevision: 1,
    definitionRevision: 2,
    skillRefs: [],
  });
  if (!activated.ok) throw new Error(activated.error.code);
  const pinned = await resolveCaseTurnAgentProfile(await requireMailFixtureScope(organisationId), {
    caseId: caseId.value,
    assignmentId: `assignment_${caseId.value}_m1`,
    assignment: "existing",
    selection: { kind: "installed", installationId: "installation_work" },
    now: Date.now(),
  });
  expect(pinned).toMatchObject({
    kind: "resolved",
    profile: {
      definitionRevision: 1,
      instructions: "Review supplier delivery updates",
    },
  });
  const evidence = await runInDurableObject(
    connector.value,
    inspectPurchasingEvidence.bind(null, `proposal_${caseId.value}_m1`),
  );
  expect(evidence).toHaveLength(2);
  expect(evidence[0]?.merchantId).toBe(merchantId);
  expect(JSON.stringify(evidence)).not.toContain("supplier@example.test");
  const wrongAgent = await resolveCaseTurnAgentProfile(await requireMailFixtureScope(organisationId), {
    caseId: caseId.value,
    assignmentId: `assignment_${caseId.value}_m1`,
    assignment: "existing",
    selection: { kind: "installed", installationId: "installation_other" },
    now: Date.now(),
  });
  expect(wrongAgent).toEqual({
    kind: "unavailable",
    error: { code: "pinned_agent_selection_changed" },
  });
  await evictDurableObject(connector.value);
  const duplicate = await runInDurableObject(
    connector.value,
    executeDraftTurn.bind(null, fixture),
  );
  expect(duplicate).toMatchObject({
    ok: false,
    error: { code: "email_response_owner_conflict" },
  });
  const competing = await runInDurableObject(
    connector.value,
    executeDraftTurn.bind(null, { ...fixture, responsePolicy: "cue_routed" }),
  );
  expect(competing).toMatchObject({
    ok: false,
    error: { code: "email_response_owner_conflict" },
  });
  expect({
    calls: model.calls,
    drafts: model.drafts,
    sends: model.sends,
  }).toEqual({ calls: 4, drafts: 1, sends: 0 });
  const hostileCaseId = parseCaseId(`case_gmail_${rawAccount}_t2`);
  if (!hostileCaseId.ok) throw new Error("Invalid hostile fixture identity");
  const hostileFixture: DraftTurnFixture = {
    ...fixture,
    caseId: hostileCaseId.value,
    threadId: "t2",
    messageIds: ["m4"],
  };
  model.phase = "hostile";
  model.phaseCalls = 0;
  model.history = "hostile";
  await runInDurableObject(connector.value, advanceObservationClock);
  await runInDurableObject(connector.value, reconcileDraftOrganization);
  const hostile = await result(
    await send(organisationId, owner.session, {
      kind: "work",
      integrationAccountId: account.value,
      threadId: hostileFixture.threadId,
    }),
  );
  expect(hostile).toMatchObject({
    kind: "work",
    work: { kind: "linked", assignments: [{ kind: "failed" }], replies: [] },
  });
  expect({
    calls: model.calls,
    drafts: model.drafts,
    sends: model.sends,
  }).toMatchObject({ drafts: 1, sends: 0 });
  model.phase = "indeterminate";
  model.phaseCalls = 0;
  model.history = "indeterminate";
  await runInDurableObject(connector.value, advanceObservationClock);
  await runInDurableObject(connector.value, reconcileDraftOrganization);
  expect(
    await result(
      await send(organisationId, owner.session, {
        kind: "work",
        integrationAccountId: account.value,
        threadId: "t3",
      }),
    ),
  ).toMatchObject({
    kind: "work",
    work: { kind: "linked", assignments: [{ kind: "failed" }], replies: [] },
  });
  expect({
    calls: model.calls,
    drafts: model.drafts,
    sends: model.sends,
  }).toMatchObject({ drafts: 2, sends: 0 });
  const settledCalls = model.calls;
  await runInDurableObject(connector.value, interruptAcceptedDraftReceipt);
  await evictDurableObject(connector.value);
  await runInDurableObject(connector.value, advanceObservationClock);
  await runInDurableObject(connector.value, reconcileDraftOrganization);
  expect({
    calls: model.calls,
    drafts: model.drafts,
    sends: model.sends,
  }).toEqual({ calls: settledCalls, drafts: 2, sends: 0 });
  expect(
    await runInDurableObject(connector.value, inspectInterruptedDraft),
  ).toMatchObject({ state: { kind: "complete", outcome: "interrupted" } });
  const accounting = await runInDurableObject(
    connector.value,
    inspectDraftBudget,
  );
  // Three completed text responses each report 25 tokens.
  expect(accounting).toEqual({ reserved: 0, consumed: 75 });
  const ambiguous = await purchasingFixture(organisationId, merchantId, "ambiguous");
  expect(ambiguous.status).toBe(200);
  const content = await gmailGetMessageContent({
    accessToken: "fixture-token",
    messageId: "m1",
    fetcher: fetch,
  });
  if (!content.ok) throw new Error(content.error.code);
  const supplierContext = new EmailSupplierContext(
    env,
    buildAgentMailboxAuthority({
      organisationId,
      integrationAccountId: account.value,
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
      mailboxPolicyVersion: policy.value.policyVersion,
    }).requestAuthority,
    caseId.value,
  );
  expect(
    await supplierContext.read(
      content.value,
      JSON.stringify({ purchaseRequestId: "PR-A" }),
    ),
  ).toEqual({ ok: false, error: { code: "email_supplier_needs_review" } });
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "reply",
        integrationAccountId: account.value,
        threadId: "t1",
        proposalId: `proposal_${caseId.value}_m1`,
      })
    ).status,
  ).toBe(409);
  const blockedSend = await connector.value.dispatchEmailReply({
    identity: { organisationId, connectorId: connectorId.value },
    proposalId: `proposal_${caseId.value}_m1`,
    approvedVersion: 1,
    approvedSnapshotDigest,
    now: Date.now(),
  });
  expect(blockedSend).toMatchObject({
    ok: false,
    error: { code: "email_commerce_changed" },
  });
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'purchasing acceptance revocation' WHERE organisation_id = ? AND grant_id = 'grant_mail_supplier_directory'",
  )
    .bind(organisationId)
    .run();
  expect(
    await supplierContext.read(
      content.value,
      JSON.stringify({ purchaseRequestId: "PR-A" }),
    ),
  ).toEqual({ ok: false, error: { code: "email_commerce_unavailable" } });
  expect(model.sends).toBe(0);
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'active', revision = revision + 1, reason = NULL WHERE organisation_id = ? AND grant_id = 'grant_mail_supplier_directory'",
  )
    .bind(organisationId)
    .run();
  await acceptPurchasingCorrection(
    organisationId,
    owner.session,
    `proposal_${caseId.value}_m1`,
    connector.value,
    model,
  );
  const retainedAccount = await mailbox(
    organisationId,
    owner,
    "retained-after-exit",
    "full_mailbox_pilot",
  );
  await fixtureDatabase().prepare(
    `INSERT INTO mail_classification (
      organisation_id, integration_account_id, rule_revision, message_id, thread_id,
      rule_id, outcome, source, evaluated_at, evaluation_id, content_digest
    ) VALUES (?, ?, 1, 'retained-message', 'retained-thread', 'retained-rule',
      'matched', 'operator', ?, 'retained-evaluation', ?)`,
  )
    .bind(organisationId, retainedAccount, Date.now(), "a".repeat(64))
    .run();
  const exited = await connector.value.revokeEmailMailbox({
    identity: { organisationId, connectorId: connectorId.value },
    kind: "erase",
    integrationAccountId: account.value,
    now: Date.now(),
  });
  expect(exited).toMatchObject({ ok: true, value: { watchStopped: true } });
  await evictDurableObject(connector.value);
  expect(
    await runInDurableObject(connector.value, inspectInboxErasure),
  ).toEqual({ rules: 0, classifications: 0, responses: 0, disabled: true });
  for (const table of [
    "mail_classification",
    "mail_classification_eligibility",
    "mail_assistant_eligibility",
  ]) {
    expect(
      await fixtureDatabase().prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE organisation_id = ? AND integration_account_id = ?`,
      )
        .bind(organisationId, account.value)
        .first("count"),
    ).toBe(0);
  }
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM mail_classification WHERE organisation_id = ? AND integration_account_id = ?",
    )
      .bind(organisationId, retainedAccount)
      .first("count"),
  ).toBe(1);
  Object.assign(testContext.task.meta, {
    mailboxExit: {
      watchStopped: true,
      erasedInboxTables: 6,
      retainedOtherMailboxClassifications: 1,
      recoveredAfterEviction: true,
    },
  });
  const placements = await fixtureDatabase().prepare(
    "SELECT object_kind AS kind, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind IN ('case', 'session', 'connector')",
  )
    .bind(organisationId)
    .all<{ kind: string; name: string }>();
  for (const row of placements.results) {
    const actor = draftFixtureActor(row);
    const stored = await runInDurableObject(actor, storedContent);
    expect(stored).not.toContain("DRAFT_PRIVATE_REPLY");
    expect(stored).not.toContain("Private body");
  }
  console.log(
    "MAIL_SUPPLIER_INVESTIGATION_E2E: published supplier rule; two arrivals create one canonical purchasing review draft; exact sender and supplier-bound purchase request; hidden supplier and notes excluded; reference-only receipts survive eviction; operator source revocation blocks Inbox preview, shared review, approval and in-flight send; changed purchasing snapshot blocks preview and final send; ambiguous sender requires review; revoked mailbox purchasing grant denies investigation; historical and competing Cue paths fenced; indeterminate draft is never repeated; canonical relationship corrected after ambiguity; replacement reply exact-version approved once and reconciled after eviction; bodies absent from Actor storage",
  );
}

function inspectInboxErasure(
  _actor: unknown,
  state: DurableObjectState,
): {
  rules: number;
  classifications: number;
  responses: number;
  disabled: boolean;
} {
  const runtime = readEmailRuntime(state.storage.sql);
  if (runtime === null) throw new Error("Missing mailbox runtime after exit");
  return {
    rules: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_organization",
      )
      .one().count,
    classifications: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_classification_work",
      )
      .one().count,
    responses: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_response_owner",
      )
      .one().count,
    disabled: runtime.disabledAt !== null,
  };
}

async function acceptPurchasingCorrection(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  proposalId: string,
  connector: Parameters<typeof evictDurableObject>[0],
  model: DraftModelFixture,
): Promise<void> {
  console.log("MAIL_CORRECTION_STEP: suppliers");
  const suppliers = await reviewResult(
    await reviewSend(organisationId, session, proposalId, "relationship", {
      kind: "suppliers",
    }),
  );
  expect(suppliers).toMatchObject({
    kind: "suppliers",
    suppliers: expect.arrayContaining([
      {
        entryId: "directory_supplier_packaging",
        supplierId: "supplier_packaging",
        displayName: "Packaging supplier",
      },
      {
        entryId: "directory_supplier_duplicate",
        supplierId: "supplier_duplicate",
        displayName: "Second packaging supplier",
      },
    ]),
  });
  expect(JSON.stringify(suppliers)).not.toContain("supplier_hidden");
  expect(
    (
      await reviewSend(organisationId, session, proposalId, "relationship", {
        kind: "purchase_request",
        supplierEntryId: "directory_supplier_duplicate",
        purchaseRequestId: "PR-A",
      })
    ).status,
  ).toBe(409);
  console.log("MAIL_CORRECTION_STEP: current evidence");
  const selected = await reviewResult(
    await reviewSend(organisationId, session, proposalId, "relationship", {
      kind: "purchase_request",
      supplierEntryId: "directory_supplier_packaging",
      purchaseRequestId: "PR-A",
    }),
  );
  if (
    typeof selected.version !== "number" ||
    typeof selected.snapshotDigest !== "string" ||
    typeof selected.relationshipDigest !== "string" ||
    typeof selected.challenge !== "string"
  )
    throw new Error("Missing relationship correction challenge");
  expect(selected).toMatchObject({
    kind: "purchase_request",
    supplierId: "supplier_packaging",
    supplierName: "Packaging supplier",
    purchaseRequestEntryId: "request_supplier_packaging",
  });
  expect(JSON.stringify(selected)).not.toContain("PURCHASING_NOTE");
  console.log("MAIL_CORRECTION_STEP: evidence received");
  const correction = {
    version: selected.version,
    snapshotDigest: selected.snapshotDigest,
    relationshipDigest: selected.relationshipDigest,
    challenge: selected.challenge,
    supplierEntryId: "directory_supplier_packaging",
    purchaseRequestId: "PR-A",
    body: "CORRECTED_PRIVATE_REPLY: PR-A requires 20 each; none received. Please confirm the revised arrival.",
  };
  network.use(
    http.put(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
      updatePurchasingDraft.bind(null, model),
    ),
  );
  expect(
    (
      await reviewSend(organisationId, session, proposalId, "correct", {
        ...correction,
        supplierEntryId: "directory_supplier_duplicate",
      })
    ).status,
  ).toBe(409);
  expect(model.edits).toBe(0);
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'correction acceptance revocation' WHERE organisation_id = ? AND grant_id = 'grant_mail_operator_replenishment_queue'",
  )
    .bind(organisationId)
    .run();
  expect(
    (await reviewSend(organisationId, session, proposalId, "correct", correction))
      .status,
  ).toBe(409);
  expect(model.edits).toBe(0);
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'active', revision = revision + 1, reason = NULL WHERE organisation_id = ? AND grant_id = 'grant_mail_operator_replenishment_queue'",
  )
    .bind(organisationId)
    .run();
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "correct", correction),
    ),
  ).toMatchObject({ kind: "corrected", version: 2 });
  console.log("MAIL_CORRECTION_STEP: replacement saved");
  expect(model.edits).toBe(1);
  expect(
    (await reviewSend(organisationId, session, proposalId, "correct", correction))
      .status,
  ).toBe(409);
  console.log("MAIL_CORRECTION_STEP: fresh review");
  const approved = await reviewSnapshot(
    await reviewSend(organisationId, session, proposalId, null, {}),
  );
  expect(approved.version).toBe(2);
  console.log("MAIL_CORRECTION_STEP: reviewed");
  const delivery: ReviewDeliveryFixture = {
    sends: 0,
    sentRaw: "",
    found: false,
    deletes: 0,
  };
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      loseReviewedSendReceipt.bind(null, delivery),
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      findReviewedSend.bind(null, proposalId, 2, delivery),
    ),
    http.delete(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_only",
      deleteReviewedDraft.bind(null, delivery),
    ),
  );
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "approve", approved),
    ),
  ).toMatchObject({ kind: "send_indeterminate" });
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "approve", approved),
    ),
  ).toMatchObject({ kind: "send_indeterminate" });
  // Refactor 15: the uncertain send outlives the reply's expiry. A review
  // read then finds the draft expired, but a reply that Gmail may have sent
  // stays an uncertain send in the queue and on the Case: it does not expire.
  expect(await queuedReplyLifecycle(organisationId, proposalId)).toBe(
    "send_indeterminate",
  );
  await runInDurableObject(
    connector,
    shiftReplyExpiry.bind(null, proposalId, -REPLY_EXPIRY_SHIFT_MS),
  );
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, null, {}),
    ),
  ).toMatchObject({ kind: "expired" });
  expect(await queuedReplyLifecycle(organisationId, proposalId)).toBe(
    "send_indeterminate",
  );
  await runInDurableObject(
    connector,
    shiftReplyExpiry.bind(null, proposalId, REPLY_EXPIRY_SHIFT_MS),
  );
  console.log("MAIL_CORRECTION_STEP: delivery reconciled");
  expect(delivery.sends).toBe(1);
  const raw = new TextDecoder().decode(
    decodeBase64(delivery.sentRaw.replaceAll("-", "+").replaceAll("_", "/")) ??
      new Uint8Array(),
  );
  expect(raw).toContain("To: supplier@example.test\r\n");
  const body = decodeBase64(raw.split("\r\n\r\n")[1]?.trim() ?? "");
  expect(new TextDecoder().decode(body ?? new Uint8Array())).toBe(
    correction.body,
  );
  await evictDurableObject(connector);
  delivery.found = true;
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "resolve", {
        dispatchVersion: 2,
      }),
    ),
  ).toMatchObject({ kind: "sent" });
  console.log("MAIL_CORRECTION_STEP: delivery reconciled");
  expect(delivery.sends).toBe(1);
  expect(delivery.deletes).toBe(1);
  const stored = await runInDurableObject(connector, storedContent);
  expect(stored).toContain("directory_supplier_packaging");
  expect(stored).not.toContain("CORRECTED_PRIVATE_REPLY");
  expect(stored).not.toContain("Packaging supplier");
  expect(stored).not.toContain("supplier@example.test");
}

/** Ten years: a shift that takes any reply past its expiry and back. */
const REPLY_EXPIRY_SHIFT_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Moves the expiry of every version of a reply, as the clock would. */
function shiftReplyExpiry(
  proposalId: string,
  shiftMs: number,
  _instance: unknown,
  ctx: DurableObjectState,
): void {
  ctx.storage.sql.exec(
    "UPDATE connector_email_draft SET expires_at = expires_at + ? WHERE proposal_id = ?",
    shiftMs,
    proposalId,
  );
}

/** The state that the reply queue shows for a proposal. */
async function queuedReplyLifecycle(
  organisationId: OrganisationId,
  proposalId: string,
): Promise<unknown> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT lifecycle_kind FROM email_reply_proposal WHERE organisation_id = ? AND proposal_id = ?",
    )
    .bind(organisationId, proposalId)
    .first<{ lifecycle_kind: string }>();
  return row?.lifecycle_kind ?? null;
}

async function executeDraftTurn(
  input: DraftTurnFixture,
  _actor: unknown,
  state: DurableObjectState,
) {
  const organisationId = parseOrganisationId(input.organisationId);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  return processEmailThreadTurn(env, {
    ...input,
    scope: await requireMailFixtureScope(organisationId.value),
    connectorSql: state.storage.sql,
    now: Date.now(),
  });
}
function inspectPurchasingEvidence(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  return readEmailCommerceEvidence(state.storage.sql, proposalId);
}

function seedDraftRuntime(
  input: DraftTurnFixture,
  _actor: unknown,
  state: DurableObjectState,
): void {
  activateEmailRuntime(state.storage.sql, {
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    policyVersion: input.policyVersion,
    limits: input.limits,
    activationFloor: "100",
    watchExpiresAt: Date.now() + 3600000,
    now: Date.now(),
  });
}

function inspectDraftBudget(_actor: unknown, state: DurableObjectState) {
  return emailTokenWindowTotals(state.storage.sql, utcDayKey(Date.now()));
}
async function reconcileDraftOrganization(
  _actor: unknown,
  state: DurableObjectState,
) {
  const head = readMailHead(state.storage.sql);
  if (head === null) throw new Error("Missing mail organization");
  const scope = await OrganisationExecutionScope.resolve(env, head.organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  return runMailOrganization({
    env,
    storage: state.storage,
    scope: scope.value,
  });
}
async function reconcileDraftCue(_actor: unknown, state: DurableObjectState) {
  const now = Date.now();
  acceptEmailHint(state.storage.sql, {
    notificationId: "draft-rule-arrivals",
    historyId: "102",
    now,
  });
  const runtime = readEmailRuntime(state.storage.sql);
  if (runtime === null) throw new Error("Missing mail runtime");
  const organisationId = parseOrganisationId(runtime.organisationId);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  return runConnectorEmailEvaluation({
    scope: await requireMailFixtureScope(organisationId.value),
    env,
    storage: state.storage,
    now: now + 30_001,
    fetcher: fetch,
  });
}
function inspectDraftOwner(_actor: unknown, state: DurableObjectState) {
  return readMailResponseOwner(state.storage.sql, "m1");
}
function interruptAcceptedDraftReceipt(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const owner = readMailResponseOwner(state.storage.sql, "m5");
  if (
    owner === null ||
    owner.kind !== "inbox" ||
    owner.state.kind !== "complete"
  )
    throw new Error("Missing indeterminate draft owner");
  const interrupted: InboxResponseOwner = {
    kind: "inbox",
    messageId: owner.messageId,
    threadId: owner.threadId,
    ruleRevision: owner.ruleRevision,
    ruleId: owner.ruleId,
    state: {
      kind: "processing",
      caseId: owner.state.caseId,
      startedAt: Date.now() - 360001,
    },
  };
  state.storage.sql.exec(
    "UPDATE mail_response_owner SET body = ?, phase = 'processing' WHERE message_id = ?",
    JSON.stringify(interrupted),
    owner.messageId,
  );
}
function inspectInterruptedDraft(_actor: unknown, state: DurableObjectState) {
  return readMailResponseOwner(state.storage.sql, "m5");
}
async function investigationClassificationFixture({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const raw: unknown = await request.json();
  if (!isRecord(raw) || !isRecord(raw.questions))
    throw new Error("Invalid investigation classification");
  if (raw.questions.in_transit !== undefined)
    return HttpResponse.json({
      model: "jev-1.13.0",
      answers: { in_transit: { type: "noul", noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(raw.questions))
    answers[key] = { type: "choice", choice: "matched" };
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 50, output_tokens: 2 },
  });
}

function draftFixtureActor(row: { kind: string; name: string }) {
  if (row.kind === "case") return env.CASE.getByName(row.name);
  if (row.kind === "session") return env.SESSION.getByName(row.name);
  return env.CONNECTOR.getByName(row.name);
}

async function draftOnlyModel(
  state: DraftModelFixture,
  { request }: { request: { json(): Promise<unknown> } },
): Promise<Response> {
  const input: unknown = await request.json();
  if (!isRecord(input) || !Array.isArray(input.tools))
    throw new Error("Missing email tool catalogue");
  const names = input.tools.map(draftToolName);
  expect(names).toContain("email_reply_for_approval");
  expect(names).not.toContain("email_reply_now");
  expect(JSON.stringify(input.messages)).toContain(
    state.phase === "draft"
      ? "Review supplier delivery updates"
      : "Updated purchasing instructions",
  );
  state.calls++;
  state.phaseCalls++;
  switch (state.phaseCalls) {
    case 1:
      return openRouterToolCall("read_email_case", {}, "draft_read");
    case 2:
      if (state.phase === "hostile")
        return openRouterToolCall(
          "email_reply_now",
          { body: "Unapproved commitment" },
          "draft_hostile",
        );
      if (state.phase === "draft")
        return openRouterToolCall(
          "read_supplier_delay_context",
          { purchaseRequestId: "PR-A" },
          "draft_purchasing",
        );
      return openRouterToolCall(
        "email_reply_for_approval",
        {
          body: "DRAFT_PRIVATE_REPLY: PR-A is recorded late, expected 29 September. Please confirm the revised packaging arrival.",
          sources: null,
        },
        "draft_review",
      );
    case 3:
      if (state.phase !== "draft")
        return openRouterText("Prepared for operator review.", "draft_done");
      expect(JSON.stringify(input.messages)).toContain(
        "supplier_purchase_request",
      );
      expect(JSON.stringify(input.messages)).toContain(
        "2026-09-29T03:00:00.000Z",
      );
      expect(JSON.stringify(input.messages)).not.toContain("supplier_hidden");
      expect(JSON.stringify(input.messages)).not.toContain("PURCHASING_NOTE");
      return openRouterToolCall(
        "email_reply_for_approval",
        {
          body: "DRAFT_PRIVATE_REPLY: PR-A is recorded late, expected 29 September. Please confirm the revised packaging arrival.",
          sources: null,
        },
        "draft_review",
      );
    default:
      return openRouterText("Prepared for operator review.", "draft_done");
  }
}

function draftToolName(value: unknown): string | null {
  return isRecord(value) &&
    isRecord(value.function) &&
    typeof value.function.name === "string"
    ? value.function.name
    : null;
}

function draftOnlyGmailRead(
  state: DraftModelFixture,
  {
    request,
  }: {
    request: { url: string };
  },
): Response {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/profile"))
    return HttpResponse.json({
      emailAddress: "shop@example.test",
      historyId: "100",
    });
  if (url.pathname.endsWith("/history")) {
    if (state.history === "empty")
      return HttpResponse.json({ historyId: "100" });
    const historyId =
      state.history === "indeterminate"
        ? "104"
        : state.history === "hostile"
          ? "103"
          : "102";
    const start = url.searchParams.get("startHistoryId") ?? "100";
    if (BigInt(start) >= BigInt(historyId))
      return HttpResponse.json({ historyId });
    const messages =
      state.history === "indeterminate"
        ? [{ id: "m5", threadId: "t3" }]
        : state.history === "hostile"
          ? [{ id: "m4", threadId: "t2" }]
          : [
              { id: "m0", threadId: "t1" },
              { id: "m1", threadId: "t1" },
            ];
    return HttpResponse.json({
      historyId,
      history: [
        { id: historyId, messagesAdded: messages.map(draftAddedMessage) },
      ],
    });
  }
  if (
    url.pathname.endsWith("/messages/m0") ||
    url.pathname.endsWith("/messages/m1") ||
    url.pathname.endsWith("/messages/m2") ||
    url.pathname.endsWith("/messages/m4") ||
    url.pathname.endsWith("/messages/m5")
  )
    return HttpResponse.json({
      ...gmailMessage(
        url.pathname.split("/").at(-1) ?? "",
        draftFixtureThread(url.pathname),
        true,
      ),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Supplier <supplier@example.test>" },
          { name: "Subject", value: "Packaging delivery delayed" },
          { name: "Message-ID", value: "<supplier-draft@example.test>" },
        ],
        body: {
          data: encodeBase64Url(
            new TextEncoder().encode(
              "Private body: packaging delivery delayed for PR-A.",
            ),
          ),
        },
      },
    });
  if (url.pathname.endsWith("/drafts/draft_only"))
    return HttpResponse.json({
      id: "draft_only",
      message: {
        id: "draft_only_message",
        threadId: "t1",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "To", value: "supplier@example.test" },
            { name: "Subject", value: "Re: Packaging delivery delayed" },
          ],
          body: {
            data: encodeBase64Url(
              new TextEncoder().encode(
                state.editedBody ??
                  "DRAFT_PRIVATE_REPLY: PR-A is recorded late, expected 29 September. Please confirm the revised packaging arrival.",
              ),
            ),
          },
        },
      },
    });
  return new Response("missing", { status: 404 });
}

async function updatePurchasingDraft(
  state: DraftModelFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const input: unknown = await request.json();
  if (
    !isRecord(input) ||
    !isRecord(input.message) ||
    typeof input.message.raw !== "string" ||
    input.message.threadId !== "t1"
  )
    throw new Error("Invalid corrected purchasing draft");
  const decoded = decodeBase64(
    input.message.raw.replaceAll("-", "+").replaceAll("_", "/"),
  );
  if (decoded === null) throw new Error("Invalid corrected purchasing MIME");
  const raw = new TextDecoder().decode(decoded);
  expect(raw).toContain("To: supplier@example.test\r\n");
  expect(raw).toContain("Subject: Re: Packaging delivery delayed\r\n");
  const encodedBody = raw.split("\r\n\r\n")[1];
  const bytes =
    encodedBody === undefined ? null : decodeBase64(encodedBody.trim());
  if (bytes === null) throw new Error("Missing corrected purchasing body");
  state.editedBody = new TextDecoder().decode(bytes);
  state.edits++;
  return HttpResponse.json({
    id: "draft_only",
    message: { id: "draft_only_message" },
  });
}

async function revokePurchasingDuringDraftRead(
  organisationId: OrganisationId,
  model: DraftModelFixture,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (model.revokeOperatorOnDraftRead) {
    model.revokeOperatorOnDraftRead = false;
    await fixtureDatabase().prepare(
      "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'in-flight purchasing acceptance revocation' WHERE organisation_id = ? AND grant_id = 'grant_mail_operator_supplier_directory'",
    )
      .bind(organisationId)
      .run();
  }
  return draftOnlyGmailRead(model, input);
}
function draftAddedMessage(message: { id: string; threadId: string }) {
  return { message };
}
function draftFixtureThread(path: string): string {
  if (path.endsWith("/m5")) return "t3";
  if (path.endsWith("/m0") || path.endsWith("/m1")) return "t1";
  return "t2";
}

async function draftOnlyGmailWrite(
  state: DraftModelFixture,
  { request }: { request: { url: string; json(): Promise<unknown> } },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/watch"))
    return HttpResponse.json({
      historyId: "100",
      expiration: String(Date.now() + 86400000),
    });
  if (url.pathname.endsWith("/stop"))
    return new Response(null, { status: 204 });
  if (!url.pathname.endsWith("/drafts")) {
    state.sends++;
    return new Response("unexpected send", { status: 500 });
  }
  const input: unknown = await request.json();
  if (
    !isRecord(input) ||
    !isRecord(input.message) ||
    typeof input.message.raw !== "string"
  )
    throw new Error("Invalid draft payload");
  state.raw = input.message.raw;
  state.drafts++;
  if (state.phase === "indeterminate")
    return new Response("accepted but receipt lost", { status: 500 });
  return HttpResponse.json({
    id: "draft_only",
    message: { id: "draft_only_message", threadId: "t1" },
  });
}

it(
  "surfaces existing thread work and fresh draft versions while fencing mailbox, proposal and in-flight access changes",
  workJourney,
  60_000,
);

it(
  "names the mail that a waiting reply draft answers in the review queue, only while the person may read its mailbox",
  reviewQueueHeadlineJourney,
  60_000,
);

async function reviewQueueHeadlineJourney(): Promise<void> {
  const owner = await client("mail-queue-owner");
  const ungranted = await client("mail-queue-ungranted");
  const organisationId = await workspace(owner);
  const rawAccount = await mailbox(
    organisationId,
    owner,
    "work",
    "full_mailbox_pilot",
  );
  await fixtureDatabase().prepare(
    "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_queue_ungranted', 'Ungranted viewer')",
  )
    .bind(organisationId)
    .run();
  await fixtureDatabase().prepare(
    "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_queue_ungranted', 'viewer', 'active', ?, NULL)",
  )
    .bind(organisationId, ungranted.identity.userId, Date.now())
    .run();
  // The account authority admits both people, so each refusal below comes
  // from Pantry's own mailbox grant check.
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator: ungranted },
  });
  const account = parseIntegrationAccountId(rawAccount);
  const parsedCase = parseCaseId(`case_gmail_${rawAccount}_work`);
  if (!account.ok || !parsedCase.ok) throw new Error("Invalid queue identity");
  const accountId = account.value;
  const now = Date.now();
  const state: WorkGmailFixture = {
    body: "Private reply: please confirm the Friday arrival.",
    revokeDuringRead: false,
    reads: 0,
    writes: 0,
  };
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      workGmail.bind(null, organisationId, state),
    ),
  );
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    environment: "development",
    googleSubject: "work",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  const proposal = await workProposal(parsedCase.value, now, state.body);
  await projectWorkReply(organisationId, accountId, proposal, now);
  // A sent reply in the same thread waits for nobody.
  await projectWorkReply(
    organisationId,
    accountId,
    {
      ...proposal,
      proposalId: "proposal_work_sent",
      lifecycle: {
        kind: "sent",
        providerMessageId: "gmail_existing_receipt",
        sentAt: now,
      },
    },
    now,
  );
  await readWorkQueueHeadlines(organisationId, owner.session, state, {
    waiting: proposal.proposalId,
    settled: ["proposal_work_sent"],
  });
  // A member without the mailbox's read grant sees the draft and no mail.
  const reads = state.threadReads;
  const isolated = await readReviewQueue(organisationId, ungranted.session);
  expect(reviewHeadline(isolated, proposal.proposalId)).toBeNull();
  expect(JSON.stringify(isolated)).not.toContain("Packaging");
  expect(state.threadReads).toBe(reads);
}

async function workJourney(): Promise<void> {
  const owner = await client("mail-work-owner");
  const organisationId = await workspace(owner);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const rawAccount = await mailbox(
    organisationId,
    owner,
    "work",
    "full_mailbox_pilot",
  );
  const account = parseIntegrationAccountId(rawAccount);
  const parsedCase = parseCaseId(`case_gmail_${rawAccount}_work`);
  if (!account.ok || !parsedCase.ok) throw new Error("Invalid work identity");
  const accountId = account.value;
  const caseId = parsedCase.value;
  const command = {
    kind: "work",
    integrationAccountId: accountId,
    threadId: "t1",
  } as const;
  expect(await result(await send(organisationId, owner.session, command))).toEqual({
    kind: "work",
    threadId: "t1",
    work: { kind: "unlinked" },
  });
  const now = Date.now();
  const state: WorkGmailFixture = {
    body: "Private reply: please confirm the Friday arrival.",
    revokeDuringRead: false,
    reads: 0,
    writes: 0,
  };
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      workGmail.bind(null, organisationId, state),
    ),
  );
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      forbiddenWorkWrite.bind(null, state),
    ),
  );
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    environment: "development",
    googleSubject: "work",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  await installWorkMailbox(organisationId, accountId, owner.identity.userId, now);
  const actor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId,
    now,
  });
  if (!actor.ok) throw new Error(actor.error.code);
  const ensured = await actor.value.ensure({
    identity: { organisationId, caseId },
    purpose: "Private work objective marker",
    workspaceRevision: "workspace_work",
    lifecycle: { kind: "open", openedAt: now },
  });
  if (!ensured.ok) throw new Error(ensured.error.code);
  const assignment = workAssignment(
    organisationId,
    accountId,
    caseId,
    ensured.value.revision,
  );
  const assigned = await actor.value.assignSession(assignment);
  if (!assigned.ok) throw new Error(assigned.error.code);
  expect(
    (
      await actor.value.beginAssignment({
        caseId,
        assignmentId: assignment.assignmentId,
        sessionId: assignment.sessionId,
        expectedCaseRevision: assignment.caseRevision,
        start: {
          startId: "start_work",
          sessionId: assignment.sessionId,
          acceptedAt: now,
        },
      })
    ).ok,
  ).toBe(true);
  const mapped = await recordEmailThreadCase({
    scope: await requireMailFixtureScope(organisationId),
    integrationAccountId: accountId,
    gmailThreadId: "t1",
    caseId,
    mailboxBindingId: "binding_work",
    bindingRevision: 1,
    now,
  });
  if (!mapped.ok) throw new Error(mapped.error.code);
  const proposal = await workProposal(caseId, now, state.body);
  expect((await actor.value.acceptEmailProposal(proposal)).ok).toBe(true);
  await projectWorkReply(organisationId, accountId, proposal, now);
  const connectorId = gmailConnectorId(accountId);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) throw new Error(connector.error.code);
  await runInDurableObject(
    connector.value,
    seedWorkDraft.bind(null, { organisationId, accountId, proposal, now }),
  );
  const work = await result(await send(organisationId, owner.session, command));
  expect(work).toMatchObject({
    kind: "work",
    work: {
      kind: "linked",
      caseId,
      state: { kind: "open" },
      assignments: [{ kind: "running" }],
      replies: [
        {
          proposalId: proposal.proposalId,
          version: 1,
          state: { kind: "awaiting_approval" },
        },
      ],
    },
  });
  expect(JSON.stringify(work)).not.toContain("Private");
  expect(state.reads).toBe(0);
  const previewCommand = {
    kind: "reply",
    integrationAccountId: accountId,
    threadId: "t1",
    proposalId: proposal.proposalId,
  } as const;
  const response = await send(organisationId, owner.session, previewCommand);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await result(response)).toMatchObject({
    kind: "reply",
    preview: {
      kind: "current",
      version: 1,
      bodyEdited: false,
      to: "supplier@example.test",
      body: state.body,
    },
  });
  await previewClarificationPurchasing(
    organisationId,
    accountId,
    owner,
    proposal.proposalId,
    connector.value,
  );
  const beforeEdit = await reviewSnapshot(
    await reviewSend(organisationId, owner.session, proposal.proposalId, null, {}),
  );
  state.body = "Private edited reply: please also confirm the quantity.";
  expect(
    await result(await send(organisationId, owner.session, previewCommand)),
  ).toMatchObject({
    kind: "reply",
    preview: {
      kind: "current",
      version: 2,
      bodyEdited: true,
      body: state.body,
    },
  });
  expect(
    (await send(organisationId, owner.session, { ...previewCommand, threadId: "t2" }))
      .status,
  ).toBe(404);
  const otherAccount = await mailbox(
    organisationId,
    owner,
    "work-other",
    "full_mailbox_pilot",
  );
  const foreignAccount = parseIntegrationAccountId(otherAccount);
  if (!foreignAccount.ok) throw new Error("Invalid second work mailbox");
  const foreignMailbox = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: foreignAccount.value,
    environment: "development",
    googleSubject: "work-other",
    observedAddress: "other@example.test",
    now,
  });
  if (!foreignMailbox.ok) throw new Error(foreignMailbox.error.code);
  const foreignProposal: CaseGmailReplyProposal = {
    ...proposal,
    proposalId: "proposal_other_mailbox",
    lifecycle: {
      kind: "sent",
      providerMessageId: "foreign_gmail_receipt",
      sentAt: now,
    },
  };
  expect((await actor.value.acceptEmailProposal(foreignProposal)).ok).toBe(
    true,
  );
  await projectWorkReply(organisationId, foreignAccount.value, foreignProposal, now);
  expect(
    (
      await send(organisationId, owner.session, {
        ...previewCommand,
        integrationAccountId: otherAccount,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await actor.value.settleAssignment({
        caseId,
        assignmentId: assignment.assignmentId,
        sessionId: assignment.sessionId,
        expectedCaseRevision: assignment.caseRevision,
        expectedStartId: "start_work",
        disposition: {
          kind: "failed",
          code: "Private failure detail marker",
          settledAt: now + 1,
        },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await actor.value.acceptEmailProposal({
        ...proposal,
        proposalId: "proposal_work_sent",
        lifecycle: {
          kind: "sent",
          providerMessageId: "gmail_existing_receipt",
          sentAt: now,
        },
      })
    ).ok,
  ).toBe(true);
  await projectWorkReply(
    organisationId,
    accountId,
    {
      ...proposal,
      proposalId: "proposal_work_sent",
      lifecycle: {
        kind: "sent",
        providerMessageId: "gmail_existing_receipt",
        sentAt: now,
      },
    },
    now,
  );
  const settled = await result(await send(organisationId, owner.session, command));
  expect(settled).toMatchObject({
    kind: "work",
    work: {
      assignments: [{ kind: "failed" }],
      replies: [
        {
          state: { kind: "sent", providerMessageId: "gmail_existing_receipt" },
        },
        { state: { kind: "awaiting_approval" } },
      ],
    },
  });
  expect(JSON.stringify(settled)).not.toContain("Private");
  expect(JSON.stringify(settled)).not.toContain("foreign_gmail_receipt");
  expect(
    (
      await send(organisationId, owner.session, {
        ...previewCommand,
        proposalId: foreignProposal.proposalId,
      })
    ).status,
  ).toBe(404);
  const readsBeforeSettledPreview = state.reads;
  expect(
    (
      await send(organisationId, owner.session, {
        ...previewCommand,
        proposalId: "proposal_work_sent",
      })
    ).status,
  ).toBe(409);
  expect(state.reads).toBe(readsBeforeSettledPreview);
  state.revokeDuringRead = true;
  const fenced = await send(organisationId, owner.session, previewCommand);
  expect(fenced.status).toBe(404);
  expect(await fenced.text()).not.toContain("Private edited reply");
  expect((await send(organisationId, owner.session, command)).status).toBe(404);
  const admissions = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM email_message_receipt WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ count: number }>();
  expect(admissions?.count).toBe(0);
  expect(state.writes).toBe(0);
  await reviewWorkReply(
    organisationId,
    owner.session,
    accountId,
    proposal.proposalId,
    beforeEdit,
    state,
    command,
    connector.value,
  );
  console.log(
    "MAIL_WORK_E2E: unlinked browse stays unadmitted; existing Case running/failed state and provider receipt surfaced without private journal/context; fresh edited Gmail draft advances preview version; wrong thread/mailbox rejected; mid-read revocation withholds content; shared exact-version review rejects stale approval; mailbox revocation blocks review and effects; edited version survives lost send receipt and Connector eviction; repeated approval never sends again; Inbox body-only edit advances version 3; reconciliation returns version-3 receipt; reference-only storage",
  );
}

async function previewClarificationPurchasing(
  organisationId: OrganisationId,
  accountId: IntegrationAccountId,
  owner: Awaited<ReturnType<typeof client>>,
  proposalId: string,
  connector: Parameters<typeof runInDurableObject>[0],
): Promise<void> {
  expect(
    await runInDurableObject(
      connector,
      inspectPurchasingEvidence.bind(null, proposalId),
    ),
  ).toEqual([]);
  await seedPurchasingContext(organisationId, owner.identity.userId, accountId);
  const policy = await publishMailboxIngressPolicy({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    environment: "development",
    request: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 100000,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
    publishedBy: owner.identity.userId,
    now: Date.now(),
  });
  if (!policy.ok || policy.value.kind !== "enabled")
    throw new Error("Missing clarification mailbox policy");
  const selected = await reviewResult(
    await reviewSend(organisationId, owner.session, proposalId, "relationship", {
      kind: "purchase_request",
      supplierEntryId: "directory_supplier_packaging",
      purchaseRequestId: "PR-A",
    }),
  );
  expect(selected).toMatchObject({
    kind: "purchase_request",
    version: 1,
    supplierId: "supplier_packaging",
    purchaseRequestEntryId: "request_supplier_packaging",
  });
  expect(JSON.stringify(selected)).not.toContain("PURCHASING_NOTE");
  expect(JSON.stringify(selected)).not.toContain("supplier_hidden");
  console.log(
    "MAIL_CLARIFICATION_CORRECTION_E2E: draft without prior purchasing receipts reads current supplier-bound request through the live mailbox authority; unrelated suppliers and private notes withheld; lookup leaves the review version unchanged",
  );
}

type ReviewSnapshot = Readonly<{
  version: number;
  snapshotDigest: string;
  challenge: string;
}>;

async function reviewSnapshot(response: Response): Promise<ReviewSnapshot> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const raw: unknown = await response.json();
  if (
    !isRecord(raw) ||
    raw.kind !== "current" ||
    !isRecord(raw.proposal) ||
    !Number.isSafeInteger(raw.proposal.version) ||
    typeof raw.proposal.version !== "number" ||
    typeof raw.proposal.snapshot_digest !== "string" ||
    typeof raw.challenge !== "string"
  )
    throw new Error("Invalid review snapshot");
  return {
    version: raw.proposal.version,
    snapshotDigest: raw.proposal.snapshot_digest,
    challenge: raw.challenge,
  };
}

async function reviewResult(
  response: Response,
): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw) || raw.ok !== true)
    throw new Error("Invalid review result");
  return raw;
}

function reviewSend(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  proposalId: string,
  action:
    | "approve"
    | "reject"
    | "resolve"
    | "edit"
    | "relationship"
    | "correct"
    | null,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${organisationId}/email-replies/${proposalId}${action === null ? "" : `/${action}`}`,
      {
        method: action === null ? "GET" : "POST",
        headers: {
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          origin: "https://localhost",
          "content-type": "application/json",
          "x-satyr-csrf": session.csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        body: action === null ? null : JSON.stringify(body),
      },
    ),
  );
}

async function reviewWorkReply(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  accountId: IntegrationAccountId,
  proposalId: string,
  beforeEdit: ReviewSnapshot,
  state: WorkGmailFixture,
  workCommand: MailInboxCommand,
  connector: Parameters<typeof evictDurableObject>[0],
): Promise<void> {
  for (const action of [null, "approve", "reject", "resolve", "edit"] as const)
    expect(
      (await reviewSend(organisationId, session, proposalId, action, beforeEdit))
        .status,
    ).toBe(404);
  expect(state.writes).toBe(0);
  await restoreWorkMailboxGrant(organisationId);
  state.revokeDuringRead = false;
  expect(
    (await reviewSend(organisationId, session, proposalId, "approve", beforeEdit))
      .status,
  ).toBe(409);
  expect(state.writes).toBe(0);
  const reviewed = await reviewSnapshot(
    await reviewSend(organisationId, session, proposalId, null, {}),
  );
  expect(reviewed.version).toBe(2);
  state.revokeDuringRead = true;
  expect(
    (await reviewSend(organisationId, session, proposalId, "approve", reviewed))
      .status,
  ).toBe(502);
  expect(state.writes).toBe(0);
  await restoreWorkMailboxGrant(organisationId);
  state.revokeDuringRead = false;
  network.use(
    http.put(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_work",
      updateWorkDraft.bind(null, state),
    ),
  );
  expect(
    (
      await reviewSend(organisationId, session, proposalId, "edit", {
        ...reviewed,
        body: "Private Inbox edited reply: please confirm Saturday arrival.",
        to: "attacker@example.test",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await reviewSend(organisationId, session, proposalId, "edit", {
        ...beforeEdit,
        body: "Private stale reply",
      })
    ).status,
  ).toBe(409);
  expect(state.writes).toBe(0);
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "edit", {
        ...reviewed,
        body: "Private Inbox edited reply: please confirm Saturday arrival.",
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 3 });
  expect(state.writes).toBe(1);
  expect(
    (await reviewSend(organisationId, session, proposalId, "approve", reviewed))
      .status,
  ).toBe(409);
  const savedReview = await reviewSnapshot(
    await reviewSend(organisationId, session, proposalId, null, {}),
  );
  expect(savedReview.version).toBe(3);
  await evictDurableObject(connector);
  const delivery: ReviewDeliveryFixture = {
    sends: 0,
    sentRaw: "",
    found: false,
    deletes: 0,
  };
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      loseReviewedSendReceipt.bind(null, delivery),
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      findReviewedSend.bind(null, proposalId, 3, delivery),
    ),
    http.delete(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_work",
      deleteReviewedDraft.bind(null, delivery),
    ),
  );
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "approve", savedReview),
    ),
  ).toMatchObject({ kind: "send_indeterminate" });
  const bytes = decodeBase64(
    delivery.sentRaw.replaceAll("-", "+").replaceAll("_", "/"),
  );
  if (bytes === null) throw new Error("Invalid immutable Gmail send");
  const sentMessage = new TextDecoder().decode(bytes);
  const encodedBody = sentMessage.split("\r\n\r\n")[1];
  if (encodedBody === undefined)
    throw new Error("Reviewed MIME body is missing");
  const bodyBytes = decodeBase64(encodedBody.trim());
  if (bodyBytes === null) throw new Error("Reviewed MIME body is invalid");
  expect(new TextDecoder().decode(bodyBytes)).toBe(state.body);
  expect(sentMessage).toContain("To: supplier@example.test");
  expect(sentMessage).toContain("In-Reply-To: <supplier-work@example.test>");
  expect(sentMessage).toContain(
    dispatchRfcMessageId(proposalId, 3, "shop@example.test"),
  );
  const pending = await result(await send(organisationId, session, workCommand));
  expect(pending).toMatchObject({
    work: {
      replies: expect.arrayContaining([
        {
          proposalId,
          version: 3,
          createdAt: expect.any(Number),
          expiresAt: expect.any(Number),
          state: {
            kind: "send_indeterminate",
            rfcMessageId: dispatchRfcMessageId(
              proposalId,
              3,
              "shop@example.test",
            ),
          },
        },
      ]),
    },
  });
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "approve", savedReview),
    ),
  ).toMatchObject({ kind: "send_indeterminate" });
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "resolve", {
        dispatchVersion: 3,
      }),
    ),
  ).toMatchObject({ kind: "unresolved" });
  expect(delivery.sends).toBe(1);
  await evictDurableObject(connector);
  delivery.found = true;
  expect(
    await reviewResult(
      await reviewSend(organisationId, session, proposalId, "resolve", {
        dispatchVersion: 3,
      }),
    ),
  ).toMatchObject({ kind: "sent" });
  const settled = await result(await send(organisationId, session, workCommand));
  expect(settled).toMatchObject({
    work: {
      replies: expect.arrayContaining([
        expect.objectContaining({
          proposalId,
          version: 3,
          state: {
            kind: "sent",
            providerMessageId: "gmail_reviewed_receipt",
            sentAt: expect.any(Number),
          },
        }),
      ]),
    },
  });
  expect(delivery.sends).toBe(1);
  expect(delivery.deletes).toBe(1);
  await runInDurableObject(connector, assertReviewedReplyStorage);
  const admissions = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM email_message_receipt WHERE organisation_id = ? AND integration_account_id = ?",
  )
    .bind(organisationId, accountId)
    .first<{ count: number }>();
  expect(admissions?.count).toBe(0);
}

async function restoreWorkMailboxGrant(organisationId: OrganisationId): Promise<void> {
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'active', revision = revision + 1, reason = NULL WHERE organisation_id = ? AND grant_id = 'grant_mail_work'",
  )
    .bind(organisationId)
    .run();
}

type ReviewDeliveryFixture = {
  sends: number;
  sentRaw: string;
  found: boolean;
  deletes: number;
};

async function loseReviewedSendReceipt(
  state: ReviewDeliveryFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const raw: unknown = await request.json();
  if (!isRecord(raw) || typeof raw.raw !== "string" || raw.threadId !== "t1")
    throw new Error("Invalid reviewed send request");
  state.sends++;
  state.sentRaw = raw.raw;
  return new Response("Synthetic lost send receipt", { status: 503 });
}

function findReviewedSend(
  proposalId: string,
  version: number,
  state: ReviewDeliveryFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Response {
  expect(new URL(request.url).searchParams.get("q")).toBe(
    `rfc822msgid:${dispatchRfcMessageId(proposalId, version, "shop@example.test")}`,
  );
  return HttpResponse.json({
    messages: state.found
      ? [{ id: "gmail_reviewed_receipt", threadId: "t1" }]
      : [],
  });
}

function deleteReviewedDraft(state: ReviewDeliveryFixture): Response {
  state.deletes++;
  return new Response(null, { status: 204 });
}

function assertReviewedReplyStorage(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const operations = state.storage.sql
    .exec("SELECT * FROM connector_email_draft")
    .toArray();
  expect(JSON.stringify(operations)).not.toContain("Private reply");
  expect(JSON.stringify(operations)).not.toContain("Private edited reply");
  expect(JSON.stringify(operations)).not.toContain(
    "Private Inbox edited reply",
  );
  expect(JSON.stringify(operations)).not.toContain("supplier@example.test");
}

type WorkGmailFixture = {
  body: string;
  revokeDuringRead: boolean;
  reads: number;
  writes: number;
  /** Reads of the thread's headers, which the review queue makes. */
  threadReads?: number;
  revokeDuringThreadRead?: boolean;
};

/**
 * The review queue names the mail that a waiting draft answers: the newest
 * thread message that the mailbox did not write. It reads it from Gmail under
 * the mailbox's read grant, for each request, and names nothing when the
 * grant ends before or during the read.
 */
async function readWorkQueueHeadlines(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  state: WorkGmailFixture,
  proposals: Readonly<{ waiting: string; settled: readonly string[] }>,
): Promise<void> {
  const reads = state.threadReads ?? 0;
  const allowed = await readReviewQueue(organisationId, session);
  expect(reviewHeadline(allowed, proposals.waiting)).toEqual({
    sender_name: "Supplier",
    subject: "Packaging delivery delayed",
    received_at: 1790726400000,
  });
  for (const settled of proposals.settled)
    expect(reviewHeadline(allowed, settled)).toBeNull();
  // One read for the one thread whose draft waits.
  expect(state.threadReads).toBe(reads + 1);
  state.revokeDuringThreadRead = true;
  const revokedDuringRead = await readReviewQueue(organisationId, session);
  expect(reviewHeadline(revokedDuringRead, proposals.waiting)).toBeNull();
  expect(JSON.stringify(revokedDuringRead)).not.toContain("Packaging");
  expect(JSON.stringify(revokedDuringRead)).not.toContain("Supplier");
  expect(state.threadReads).toBe(reads + 2);
  state.revokeDuringThreadRead = false;
  const revoked = await readReviewQueue(organisationId, session);
  expect(reviewHeadline(revoked, proposals.waiting)).toBeNull();
  expect(state.threadReads).toBe(reads + 2);
  await restoreWorkMailboxGrant(organisationId);
  expect(
    reviewHeadline(
      await readReviewQueue(organisationId, session),
      proposals.waiting,
    ),
  ).not.toBeNull();
  console.log(
    "MAIL_REVIEW_QUEUE_HEADLINE_E2E: a waiting draft names the sender, subject and time of the newest thread message that the mailbox did not write; settled drafts name none; a grant revoked during the Gmail read and a revoked grant both withhold it, the second without a Gmail read; a restored grant names it again",
  );
}

async function readReviewQueue(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<readonly Record<string, unknown>[]> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/email-reviews`,
    {
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: "https://localhost",
      },
    },
  );
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.reviews))
    throw new Error("Invalid review queue");
  return raw.reviews.filter(isRecord);
}

function reviewHeadline(
  reviews: readonly Record<string, unknown>[],
  proposalId: string,
): unknown {
  const review = reviews.find(function named(entry) {
    return entry.proposal_id === proposalId;
  });
  if (review === undefined) throw new Error(`No queue item ${proposalId}`);
  return review.headline;
}

async function updateWorkDraft(
  state: WorkGmailFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const input: unknown = await request.json();
  if (
    !isRecord(input) ||
    !isRecord(input.message) ||
    typeof input.message.raw !== "string" ||
    input.message.threadId !== "t1"
  )
    throw new Error("Invalid Inbox draft edit");
  const decoded = decodeBase64(
    input.message.raw.replaceAll("-", "+").replaceAll("_", "/"),
  );
  if (decoded === null) throw new Error("Invalid Inbox draft encoding");
  const raw = new TextDecoder().decode(decoded);
  expect(raw).toContain("To: supplier@example.test\r\n");
  expect(raw).toContain("Subject: Re: Packaging delivery delayed\r\n");
  expect(raw).toContain("In-Reply-To: <supplier-work@example.test>\r\n");
  const encodedBody = raw.split("\r\n\r\n")[1];
  const body =
    encodedBody === undefined ? null : decodeBase64(encodedBody.trim());
  if (body === null) throw new Error("Missing edited body");
  state.body = new TextDecoder().decode(body);
  state.writes++;
  return HttpResponse.json({
    id: "draft_work",
    message: { id: "draft_message_work" },
  });
}

function forbiddenWorkWrite(state: WorkGmailFixture): Response {
  state.writes++;
  return new Response("Inbox work must not write Gmail", { status: 500 });
}

async function installWorkMailbox(
  organisationId: OrganisationId,
  accountId: IntegrationAccountId,
  actorUserId: string,
  now: number,
): Promise<void> {
  const commands: AgentOperationCommand[] = [
    {
      kind: "create_area",
      operationId: "area_work",
      actorUserId,
      now,
      name: "Purchasing",
      purpose: "Work read fixture",
    },
    {
      kind: "create_agent_definition",
      operationId: "agent_work",
      actorUserId,
      now,
      displayName: "Supplier agent",
      role: "research",
      purpose: "Work read fixture",
      instructions: "Review supplier delivery updates",
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_work",
      actorUserId,
      now,
      agentDefinitionId: "agent_work",
      definitionRevision: 1,
      areaId: "area_work",
      responsibility: "Purchasing",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of commands) {
    const applied = await applyAgentOperation(fixtureDatabase(), organisationId, command);
    if (!applied.ok) throw new Error(applied.error.code);
  }
  const assigned = await assignAgentMailbox({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    mailboxBindingId: "binding_work",
    installationId: "installation_work",
    grantsDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    createdBy: actorUserId,
    now,
  });
  if (!assigned.ok) throw new Error(assigned.error.code);
}

async function projectWorkReply(
  organisationId: OrganisationId,
  accountId: IntegrationAccountId,
  proposal: CaseGmailReplyProposal,
  now: number,
): Promise<void> {
  const projected = await projectEmailReplyProposal({
    scope: await requireMailFixtureScope(organisationId),
    integrationAccountId: accountId,
    proposalId: proposal.proposalId,
    caseId: proposal.caseId,
    gmailThreadId: proposal.threadId,
    currentVersion: proposal.version,
    lifecycleKind: proposal.lifecycle.kind,
    now,
  });
  if (!projected.ok) throw new Error(projected.error.code);
}

async function workGmail(
  organisationId: OrganisationId,
  state: WorkGmailFixture,
  { request }: { request: { url: string } },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/drafts/draft_work")) {
    state.reads++;
    if (state.revokeDuringRead)
      await fixtureDatabase().prepare(
        "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'work in-flight revocation' WHERE organisation_id = ?",
      )
        .bind(organisationId)
        .run();
    return HttpResponse.json({
      id: "draft_work",
      message: {
        id: "draft_message_work",
        threadId: "t1",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "To", value: "supplier@example.test" },
            { name: "Subject", value: "Re: Packaging delivery delayed" },
          ],
          body: { data: encodeBase64Url(new TextEncoder().encode(state.body)) },
        },
      },
    });
  }
  if (url.pathname.endsWith("/threads/t1")) {
    state.threadReads = (state.threadReads ?? 0) + 1;
    if (state.revokeDuringThreadRead)
      await fixtureDatabase().prepare(
        "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'queue in-flight revocation' WHERE organisation_id = ? AND grant_id = 'grant_mail_work'",
      )
        .bind(organisationId)
        .run();
    // The mailbox's acknowledgement and its draft come after the mail.
    const own = {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Shop <shop@example.test>" },
        { name: "Subject", value: "Re: Packaging delivery delayed" },
      ],
    };
    return HttpResponse.json({
      id: "t1",
      messages: [
        gmailMessage("m1", "t1", false),
        {
          ...gmailMessage("m_ack", "t1", false, ["SENT"]),
          internalDate: "1790726460000",
          payload: own,
        },
        {
          ...gmailMessage("draft_message_work", "t1", false, ["DRAFT"]),
          internalDate: "1790726520000",
          payload: own,
        },
      ],
    });
  }
  if (url.pathname.endsWith("/messages/m1"))
    return HttpResponse.json({
      ...gmailMessage("m1", "t1", true),
      payload: {
        ...gmailMessage("m1", "t1", true).payload,
        headers: [
          { name: "From", value: "Supplier <supplier@example.test>" },
          { name: "Subject", value: "Packaging delivery delayed" },
          { name: "Message-ID", value: "<supplier-work@example.test>" },
        ],
      },
    });
  return new Response("missing", { status: 404 });
}

function workAssignment(
  organisationId: OrganisationId,
  accountId: IntegrationAccountId,
  caseId: CaseId,
  revision: number,
): CaseAssignment {
  return {
    assignmentId: "assignment_work",
    caseId,
    caseRevision: revision,
    sessionId: "session_work",
    role: "research",
    objective: { instruction: "Private assignment objective marker" },
    authority: {
      capabilityProfile: "read_and_propose",
      authorityPartitionDigest: "a".repeat(64),
    },
    authorityPartition: {
      digest: "a".repeat(64),
      key: {
        kind: "agent_mailbox",
        organisationId,
        integrationAccountId: accountId,
        mailboxBindingId: "binding_work",
        bindingRevision: 1,
        mailboxPolicyVersion: 1,
        replyScope: { kind: "source_only" },
      },
      selectedGrantSetDigest: "b".repeat(64),
      capabilityKeys: [
        `provider:${CAPABILITY_KEYS.emailMailboxRead}:1:${accountId}:mailbox`,
      ],
      policyVersion: "policy_1",
    },
    budget: {
      budgetRevision: "budget_work",
      maxTokens: 1000,
      maxWallMs: 30000,
      maxToolCalls: 5,
    },
    context: {
      evidenceDependency: { kind: "source_only" },
      caseId,
      revision,
      journalCursor: { kind: "before_first" },
      workspaceRevision: "workspace_work",
      entries: [],
    },
  };
}

async function workProposal(
  caseId: CaseId,
  now: number,
  body: string,
): Promise<CaseGmailReplyProposal> {
  const expiresAt = now + 3_600_000;
  const target = deriveGmailReplyTarget({
    accountAddress: "shop@example.test",
    sourceMessageId: "m1",
    threadId: "t1",
    headers: {
      messageIdHeader: "<supplier-work@example.test>",
      from: "Supplier <supplier@example.test>",
      replyTo: null,
      subject: "Packaging delivery delayed",
      references: null,
      date: "",
    },
    policyVersion: 1,
    expiresAt,
  });
  if (!target.ok) throw new Error(target.error.code);
  const targetDigest = await digestGmailReplyTarget(target.value);
  const bodyDigest = await digestEmailBody(body);
  const snapshotDigest = await digestEmailSnapshot({
    targetDigest,
    bodyDigest,
    proposalId: "proposal_work",
    version: 1,
  });
  return {
    proposalId: "proposal_work",
    version: 1,
    caseId,
    evidence: { kind: "source_only" },
    threadId: "t1",
    providerDraftId: "draft_work",
    providerDraftMessageId: "draft_message_work",
    triggeringProviderMessageId: "m1",
    mailboxBindingId: "binding_work",
    bindingRevision: 1,
    policyVersion: 1,
    targetDigest,
    bodyDigest,
    snapshotDigest,
    createdAt: now,
    expiresAt,
    lifecycle: { kind: "awaiting_approval" },
  };
}

function seedWorkDraft(
  input: Readonly<{
    organisationId: OrganisationId;
    accountId: IntegrationAccountId;
    proposal: CaseGmailReplyProposal;
    now: number;
  }>,
  _actor: unknown,
  state: DurableObjectState,
): void {
  activateEmailRuntime(state.storage.sql, {
    organisationId: input.organisationId,
    integrationAccountId: input.accountId,
    policyVersion: 1,
    limits: {
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 100000,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    },
    activationFloor: "10",
    watchExpiresAt: input.now + 86400000,
    now: input.now,
  });
  const proposal = input.proposal;
  recordEmailDraftOperation(state.storage.sql, {
    proposalId: proposal.proposalId,
    version: proposal.version,
    caseId: proposal.caseId,
    threadId: proposal.threadId,
    draftId: proposal.providerDraftId,
    draftMessageId: proposal.providerDraftMessageId,
    triggeringMessageId: proposal.triggeringProviderMessageId,
    targetDigest: proposal.targetDigest,
    bodyDigest: proposal.bodyDigest,
    snapshotDigest: proposal.snapshotDigest,
    policyVersion: proposal.policyVersion,
    expiresAt: proposal.expiresAt,
    now: input.now,
  });
}

it(
  "browses private Gmail through the Worker with pagination, isolation, revocation and no Case admission",
  inboxJourney,
);

async function inboxJourney(): Promise<void> {
  network.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/*", gmailFixture),
  );
  const owner = await client("mail-owner");
  const outsider = await client("mail-outsider");
  const ungranted = await client("mail-ungranted");
  const organisationId = await workspace(owner);
  const accountId = await mailbox(
    organisationId,
    owner,
    "inbox",
    "full_mailbox_pilot",
  );
  await mailbox(organisationId, owner, "send-only", "send_only");
  await fixtureDatabase().prepare(
    "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_mail_ungranted', 'Ungranted viewer')",
  )
    .bind(organisationId)
    .run();
  await fixtureDatabase().prepare(
    "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_mail_ungranted', 'viewer', 'active', ?, NULL)",
  )
    .bind(organisationId, ungranted.identity.userId, Date.now())
    .run();
  // The account authority admits the owner and the viewer, so each refusal
  // below comes from Pantry's own mailbox grant check.
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator: ungranted },
  });
  const listed = await result(await send(organisationId, owner.session, null));
  expect(listed).toEqual({
    kind: "accounts",
    accounts: [{ integrationAccountId: accountId, displayName: "inbox", access: "readable" }],
  });
  expect(await result(await send(organisationId, ungranted.session, null))).toEqual({
    kind: "accounts",
    accounts: [],
  });
  const pageCommand: MailInboxCommand = {
    kind: "page",
    integrationAccountId: accountId,
    query: "",
    cursor: null,
  };
  expect((await send(organisationId, outsider.session, pageCommand)).status).toBe(
    404,
  );
  expect((await send(organisationId, ungranted.session, pageCommand)).status).toBe(
    404,
  );
  const pageResponse = await send(organisationId, owner.session, pageCommand);
  expect(pageResponse.headers.get("cache-control")).toBe("no-store");
  const first = await result(pageResponse);
  if (first.kind !== "page" || first.nextCursor === null)
    throw new Error("Expected first page cursor");
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]?.subject).toBe("Packaging delivery delayed");
  expect(JSON.stringify(first)).not.toContain("Private body");
  expect(first.nextCursor).not.toContain("provider-next-page");
  const second = await result(
    await send(organisationId, owner.session, {
      kind: "page",
      integrationAccountId: accountId,
      query: "",
      cursor: first.nextCursor,
    }),
  );
  expect(second).toMatchObject({
    kind: "page",
    nextCursor: null,
    messages: [{ messageId: "m2" }],
  });
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "page",
        integrationAccountId: accountId,
        query: "changed",
        cursor: first.nextCursor,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "page",
        integrationAccountId: accountId,
        query: "",
        cursor: "tampered",
      })
    ).status,
  ).toBe(422);
  // Spam lists only what Gmail still holds in Spam. A message moved to the
  // inbox between the list and its read is left out.
  const spamCommand: MailInboxCommand = {
    kind: "spamPage",
    integrationAccountId: accountId,
    cursor: null,
  };
  expect(
    (await send(organisationId, outsider.session, spamCommand)).status,
  ).toBe(404);
  expect(
    (await send(organisationId, ungranted.session, spamCommand)).status,
  ).toBe(404);
  const spam = await result(
    await send(organisationId, owner.session, spamCommand),
  );
  if (spam.kind !== "page" || spam.nextCursor === null)
    throw new Error("Expected a Spam page cursor");
  expect(spam.messages).toEqual([
    {
      messageId: "s1",
      threadId: "ts1",
      from: "Supplier <supplier@example.test>",
      subject: "Packaging delivery delayed",
      receivedAt: 1790726400000,
      unread: true,
    },
  ]);
  expect(spam.nextCursor).not.toContain("provider-spam-next");
  // A cursor opens only the list that sealed it.
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "page",
        integrationAccountId: accountId,
        query: "",
        cursor: spam.nextCursor,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "spamPage",
        integrationAccountId: accountId,
        cursor: first.nextCursor,
      })
    ).status,
  ).toBe(422);
  expect(
    await result(
      await send(organisationId, owner.session, {
        kind: "spamPage",
        integrationAccountId: accountId,
        cursor: spam.nextCursor,
      }),
    ),
  ).toMatchObject({
    kind: "page",
    nextCursor: null,
    messages: [{ messageId: "s3", unread: false }],
  });
  const thread = await result(
    await send(organisationId, owner.session, {
      kind: "thread",
      integrationAccountId: accountId,
      threadId: "t1",
    }),
  );
  expect(thread).toMatchObject({
    kind: "thread",
    messages: [
      {
        messageId: "m1",
        body: "Private body: packaging arrives Friday.",
        unread: true,
      },
    ],
  });
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'e2e revocation' WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .run();
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "thread",
        integrationAccountId: accountId,
        threadId: "t1",
      })
    ).status,
  ).toBe(404);
  expect(await result(await send(organisationId, owner.session, null))).toEqual({
    kind: "accounts",
    accounts: [],
  });
  const admissions = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM email_message_receipt WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ count: number }>();
  expect(admissions?.count).toBe(0);
  const cases = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM email_thread_case WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ count: number }>();
  expect(cases?.count).toBe(0);
  const proposals = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM email_reply_proposal WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .first<{ count: number }>();
  expect(proposals?.count).toBe(0);
  console.log(
    "MAIL_INBOX_E2E: authorized paging + thread reading; Spam listed read only with fenced cursors and mail moved out of Spam left out; foreign and ungranted users denied; send-only excluded; cursors fenced; revoked reads denied; zero email admissions/proposals",
  );
}

async function client(subject: string) {
  const now = Date.now();
  const identity = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.test`,
      displayName: subject,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.userId,
    now,
    ttlMs: 1_800_000,
  });
  return { identity, session };
}

async function workspace(
  owner: Awaited<ReturnType<typeof client>>,
): Promise<OrganisationId> {
  const now = Date.now();
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const result = await bootstrapOrganisation({
    env,
    owner: owner.identity,
    organisationName: "Mail inbox",
    environment: "development",
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.identity.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: crypto.randomUUID(),
        requestHash: "mail-inbox-e2e",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "mail-inbox-e2e",
        causationId: crypto.randomUUID(),
        now,
      }),
    },
  });
  if (!result.ok) throw new Error(result.error.code);
  const created = result.value;
  await fixtureDatabase().prepare(
    "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'mail-e2e', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
  )
    .bind(now, now, created.organisationId)
    .run();
  const policy = defaultDenyPolicy({ now });
  policy.version = 1;
  policy.authz.allowedTools = [
    CAPABILITY_KEYS.emailMailboxRead,
    CONTEXT_CASE_READ_CAPABILITY,
    CAPABILITY_KEYS.caseContextCollectionMetadataRead,
  ];
  policy.authz.maxBudget = {
    maxTokens: 5000,
    maxWallMs: 30000,
    maxToolCalls: 5,
  };
  await fixtureDatabase().prepare(
    "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, ?, 'mail-e2e')",
  )
    .bind(created.organisationId, JSON.stringify(policy), now)
    .run();
  await env.POLICY_KV.put(
    `policy:${created.organisationId}:latest`,
    JSON.stringify(policy),
  );
  await env.POLICY_KV.put(
    `policy:${created.organisationId}:v1`,
    JSON.stringify(policy),
  );
  return created.organisationId;
}

async function mailbox(
  organisationId: OrganisationId,
  owner: Awaited<ReturnType<typeof client>>,
  name: string,
  product: "full_mailbox_pilot" | "send_only",
): Promise<string> {
  const now = Date.now();
  const handle = requireVaultHandle(
    `vault:${organisationId.toLowerCase()}:gmail:${name}:oauth:g1`,
  );
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId,
    handle,
    now,
    secret: {
      kind: "oauth_tokens",
      accessToken: "mail-inbox-e2e-token",
      refreshToken: "mail-inbox-e2e-refresh",
      expiry: { kind: "expires", expiresAt: now + 3_600_000 },
    },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId,
    provider: "gmail",
    authorizationProduct: product,
    providerSubjectId: name,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes:
      product === "full_mailbox_pilot"
        ? GMAIL_FULL_MAILBOX_SCOPES
        : GMAIL_SEND_ONLY_SCOPES,
    createdByUserId: owner.identity.userId,
    providerAccountId: name,
    accountKind: "mailbox",
    displayName: name,
    capabilities: [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const granted = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: `grant_mail_${name}`,
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "provider_resource",
      capabilityId: CAPABILITY_KEYS.emailMailboxRead,
      capabilityVersion: 1,
      integrationAccountId: connected.account.integrationAccountId,
      resourceScope: "mailbox",
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "mail-e2e",
    },
    now,
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return connected.account.integrationAccountId;
}

function send(
  organisationId: string,
  session: IssuedControlSession,
  body: MailInboxCommand | null,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/mail-inbox`,
    {
      method: body === null ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: body === null ? null : JSON.stringify(body),
    },
  );
}

async function result(response: Response): Promise<MailInboxResult> {
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  const parsed = parseMailInboxResult(raw);
  if (parsed === null) throw new Error("Invalid Inbox response");
  return parsed;
}

function gmailFixture({
  request,
}: {
  request: { url: string; headers: Headers };
}): Response {
  expect(request.headers.get("authorization")).toBe(
    "Bearer mail-inbox-e2e-token",
  );
  const url = new URL(request.url);
  if (url.pathname.endsWith("/messages")) {
    if (url.searchParams.get("labelIds") === "SPAM") {
      // Gmail leaves Spam out of a list that does not ask for it.
      expect(url.searchParams.get("includeSpamTrash")).toBe("true");
      expect(url.searchParams.has("q")).toBe(false);
      if (url.searchParams.has("pageToken")) {
        expect(url.searchParams.get("pageToken")).toBe("provider-spam-next");
        return HttpResponse.json({ messages: [{ id: "s3", threadId: "ts3" }] });
      }
      return HttpResponse.json({
        messages: [
          { id: "s1", threadId: "ts1" },
          { id: "s2", threadId: "ts2" },
        ],
        nextPageToken: "provider-spam-next",
      });
    }
    expect(url.searchParams.get("labelIds")).toBe("INBOX");
    expect(url.searchParams.has("includeSpamTrash")).toBe(false);
    if (url.searchParams.has("pageToken")) {
      expect(url.searchParams.get("pageToken")).toBe("provider-next-page");
      return HttpResponse.json({ messages: [{ id: "m2", threadId: "t2" }] });
    }
    return HttpResponse.json({
      messages: [{ id: "m1", threadId: "t1" }],
      nextPageToken: "provider-next-page",
    });
  }
  if (url.pathname.endsWith("/threads/t1"))
    return HttpResponse.json({
      id: "t1",
      messages: [gmailMessage("m1", "t1", true)],
    });
  if (url.pathname.endsWith("/messages/m1"))
    return HttpResponse.json(gmailMessage("m1", "t1", false));
  if (url.pathname.endsWith("/messages/m2"))
    return HttpResponse.json(gmailMessage("m2", "t2", false));
  if (url.pathname.endsWith("/messages/s1"))
    return HttpResponse.json(
      gmailMessage("s1", "ts1", false, ["SPAM", "UNREAD"]),
    );
  // The person chose "Not spam" in Gmail after the list was read.
  if (url.pathname.endsWith("/messages/s2"))
    return HttpResponse.json(gmailMessage("s2", "ts2", false, ["INBOX"]));
  if (url.pathname.endsWith("/messages/s3"))
    return HttpResponse.json(gmailMessage("s3", "ts3", false, ["SPAM"]));
  return new Response("missing", { status: 404 });
}

function gmailMessage(
  id: string,
  threadId: string,
  full: boolean,
  labelIds: readonly string[] = ["INBOX", "UNREAD"],
) {
  return {
    id,
    threadId,
    internalDate: "1790726400000",
    sizeEstimate: 200,
    labelIds,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Supplier <supplier@example.test>" },
        { name: "Subject", value: "Packaging delivery delayed" },
      ],
      body: full
        ? {
            data: encodeBase64Url(
              new TextEncoder().encode(
                "Private body: packaging arrives Friday.",
              ),
            ),
          }
        : {},
    },
  };
}

it(
  "publishes JEV rules and recovers settled classifications across actor eviction without replaying inference or admitting Cases",
  organizationJourney,
  90_000,
);

it(
  "fences mail publication and classification preparation across repeated Connector relocation",
  connectorMailCommandPlacementJourney,
  180_000,
);

type MailCommandPause = {
  operation: "publish" | "classify";
  phase: "armed" | "paused" | "released";
  watchCalls: number;
};

async function connectorMailCommandPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const fixture = await installMailPlacementFixture();
  const accountId = fixture.request.integrationAccountId;
  expect(
    (
      await registerEmailMailboxAccount({
        db: fixtureDatabase(),
        organisationId: fixture.organisationId,
        integrationAccountId: accountId,
        environment: "development",
        googleSubject: "p55-mail",
        observedAddress: "organization@example.test",
        now: Date.now(),
      })
    ).ok,
  ).toBe(true);
  await organizationView(fixture.organisationId, fixture.owner.session, accountId);
  const connectorId = gmailConnectorId(accountId);
  if (!connectorId.ok) throw new Error("Invalid fixture connector");
  const initial = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId: fixture.organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!initial.ok) throw new Error(initial.error.code);
  let connector = initial.value;
  const pause: MailCommandPause = {
    operation: "publish",
    phase: "released",
    watchCalls: 0,
  };
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      pausedMailWatch.bind(null, pause),
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      pausedMailMetadata.bind(null, pause),
    ),
  );
  for (const operation of ["publish", "classify"] as const) {
    pause.operation = operation;
    pause.phase = "armed";
    const command: MailOrganizationCommand =
      operation === "publish"
        ? {
            kind: "publish",
            expectedRevision: 0,
            rules: fixture.request.rules,
            consent: true,
          }
        : { kind: "classify", expectedRevision: 1, messageIds: ["m1"] };
    const input = {
      identity: { organisationId: fixture.organisationId, connectorId: connectorId.value },
      integrationAccountId: accountId,
      authority: fixture.request.authority,
      command,
    };
    const work = connector.manageMailOrganization(input);
    let completion: Promise<unknown> | null = null;
    try {
      await expect
        .poll(mailCommandPausePhase.bind(null, pause), { timeout: 10_000 })
        .toBe("paused");
      const target = parseOrganisationPlacementMoveTarget({
        kind: "affinity",
        placementCellId:
          operation === "publish"
            ? "e2e-policy-snapshot"
            : "e2e-policy-activation",
        locationHint: "wnam",
      });
      if (!target.ok) throw new Error(target.error.path);
      const started = await startActorRelocation({
        env,
        organisationId: fixture.organisationId,
        target: target.value,
        now: Date.now(),
      });
      if (!started.ok) throw new Error(started.error.code);
      completion = resumeActorRelocation({
        env,
        relocationId: started.value.relocationId,
        now: Date.now(),
      });
      await expect
        .poll(readMailConnectorBarrier.bind(null, connector), {
          timeout: 10_000,
        })
        .toBe(1);
      const exported = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
      )
        .bind(started.value.relocationId)
        .first<{ total: number }>();
      expect(exported?.total).toBe(0);
      pause.phase = "released";
      expect(await work).toMatchObject({
        ok: false,
        error: { code: "connector_placement_conflict" },
      });
      expect(await completion).toMatchObject({
        ok: true,
        value: { status: "retained" },
      });
      await evictDurableObject(connector);
      expect(await connector.manageMailOrganization(input)).toMatchObject({
        ok: false,
        error: { code: "connector_placement_conflict" },
      });
      const recovered = await resolveActiveConnectorActor({
        env,
        namespace: env.CONNECTOR,
        organisationId: fixture.organisationId,
        connectorId: connectorId.value,
        now: Date.now(),
      });
      if (!recovered.ok) throw new Error(recovered.error.code);
      connector = recovered.value;
      expect(await runInDurableObject(connector, readMailCommandState)).toEqual(
        { revision: operation === "publish" ? 0 : 1, work: 0 },
      );
      await evictDurableObject(connector);
      expect(await connector.manageMailOrganization(input)).toMatchObject({
        ok: true,
      });
      expect(await runInDurableObject(connector, readMailCommandState)).toEqual(
        { revision: 1, work: operation === "publish" ? 0 : 1 },
      );
    } finally {
      pause.phase = "released";
      await Promise.allSettled(
        completion === null ? [work] : [work, completion],
      );
    }
  }
  expect(pause.watchCalls).toBe(2);
  Object.assign(task.meta, {
    connectorMailCommands: {
      relocations: 2,
      exportsWhilePaused: 0,
      frozenPublicationPrevented: true,
      frozenQueueCommitPrevented: true,
      recoveredRevision: 1,
      recoveredWorkItems: 1,
      watchAttempts: pause.watchCalls,
    },
  });
}
function mailCommandPausePhase(pause: MailCommandPause): string {
  return pause.phase;
}
async function pausedMailWatch(pause: MailCommandPause): Promise<Response> {
  pause.watchCalls += 1;
  if (pause.operation === "publish" && pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return watchFixture();
}
async function pausedMailMetadata(
  pause: MailCommandPause,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (
    pause.operation === "classify" &&
    pause.phase === "armed" &&
    new URL(input.request.url).pathname.endsWith("/messages/m1")
  ) {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return organizationGmailFixture(input);
}
function readMailCommandState(_actor: unknown, state: DurableObjectState) {
  return {
    revision: readMailHead(state.storage.sql)?.view.revision ?? 0,
    work: state.storage.sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM mail_classification_work",
      )
      .one().total,
  };
}

it(
  "withholds Connector mail decisions during relocation and restores protected reads on the evicted target",
  connectorMailReadPlacementJourney,
  90_000,
);

it(
  "preserves the mail history cursor during relocation and classifies arrivals on the evicted target",
  connectorMailObservationPlacementJourney,
  90_000,
);

function observationPlacementState(_actor: unknown, state: DurableObjectState) {
  const head = readMailHead(state.storage.sql);
  return {
    historyId:
      head?.observation.kind === "watching" ? head.observation.historyId : null,
    pending: state.storage.sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM mail_classification_work",
      )
      .one().total,
  };
}

async function pausedMailHistory(
  pause: MailPlacementPause,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const url = new URL(input.request.url);
  if (url.pathname.endsWith("/history")) {
    if (pause.phase === "armed") {
      pause.phase = "paused";
      while (pause.phase === "paused") await scheduler.wait(5);
    }
    return HttpResponse.json({
      historyId: "11",
      history: [
        {
          id: "11",
          messagesAdded: [
            { message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } },
          ],
        },
      ],
    });
  }
  return organizationGmailFixture(input);
}

async function connectorMailObservationPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const fixture = await installMailPlacementFixture();
  const pause: MailPlacementPause = {
    boundary: "source",
    phase: "released",
    inferenceCalls: 0,
  };
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      placementInferenceResponse.bind(null, pause),
    ),
  );
  const accountId = fixture.request.integrationAccountId;
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId: fixture.organisationId,
    integrationAccountId: accountId,
    environment: "development",
    googleSubject: "p55-mail",
    observedAddress: "organization@example.test",
    now: Date.now(),
  });
  expect(registered.ok).toBe(true);
  const published = await organizationSend(
    fixture.organisationId,
    fixture.owner.session,
    accountId,
    {
      kind: "publish",
      expectedRevision: 0,
      rules: fixture.request.rules,
      consent: true,
    },
  );
  expect(published.status, JSON.stringify(await published.json())).toBe(200);
  const connectorId = gmailConnectorId(accountId);
  if (!connectorId.ok) throw new Error("Invalid fixture connector");
  const source = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId: fixture.organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!source.ok) throw new Error(source.error.code);
  const scope = await OrganisationExecutionScope.resolve(env, fixture.organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  const head = await runInDurableObject(source.value, readObservationHead);
  const input = {
    identity: { organisationId: fixture.organisationId, connectorId: connectorId.value },
    integrationAccountId: accountId,
    authority: fixture.request.authority,
  };
  pause.phase = "armed";
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      pausedMailHistory.bind(null, pause),
    ),
  );
  await runInDurableObject(source.value, advanceObservationClock);
  const work = runDurableObjectAlarm(source.value);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(mailPausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: fixture.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    completion = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, source.value), {
        timeout: 10_000,
      })
      .toBe(1);
    const exported = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
    )
      .bind(started.value.relocationId)
      .first<{ total: number }>();
    expect(exported?.total).toBe(0);
    await attemptFrozenMailProjection(scope.value, head);
    const frozenRows = await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS total FROM mail_classification WHERE organisation_id = ?",
    )
      .bind(fixture.organisationId)
      .first<{ total: number }>();
    expect(frozenRows?.total).toBe(0);
    pause.phase = "released";
    await work;
    expect(
      await runInDurableObject(source.value, observationPlacementState),
    ).toEqual({ historyId: "10", pending: 0 });
    expect(pause.inferenceCalls).toBe(0);
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(source.value);
    await verifyMailReadPlacement(source.value, input, false);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: fixture.organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    await runInDurableObject(recovered.value, advanceObservationClock);
    await evictDurableObject(recovered.value);
    await runDurableObjectAlarm(recovered.value);
    await attemptFrozenMailProjection(scope.value, head);
    await verifyMailReadPlacement(recovered.value, input, true);
    const outcome = await recovered.value.readMailOrganization({
      ...input,
      messageIds: ["m1"],
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: { classifications: [{ outcome: "matched" }] },
    });
    expect(pause.inferenceCalls).toBe(1);
    Object.assign(task.meta, {
      connectorMailObservationPlacement: {
        frozenCursorPreserved: true,
        frozenWorkCount: 0,
        frozenProjectionRows: 0,
        retiredProjectionOverwriteRejected: true,
        exportsWhilePaused: 0,
        retiredSourceReadsRejected: 3,
        recoveredReadsAfterEviction: 3,
        inferenceCalls: pause.inferenceCalls,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

async function connectorMailReadPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const fixture = await installMailPlacementFixture();
  const pause: MailPlacementPause = {
    boundary: "source",
    phase: "released",
    inferenceCalls: 0,
  };
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      placementInferenceResponse.bind(null, pause),
    ),
  );
  const accountId = fixture.request.integrationAccountId;
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId: fixture.organisationId,
    integrationAccountId: accountId,
    environment: "development",
    googleSubject: "p55-mail",
    observedAddress: "organization@example.test",
    now: Date.now(),
  });
  expect(registered.ok).toBe(true);
  const published = await organizationSend(
    fixture.organisationId,
    fixture.owner.session,
    accountId,
    {
      kind: "publish",
      expectedRevision: 0,
      rules: fixture.request.rules,
      consent: true,
    },
  );
  expect(published.status, JSON.stringify(await published.json())).toBe(200);
  const queued = await organizationSend(
    fixture.organisationId,
    fixture.owner.session,
    accountId,
    { kind: "classify", expectedRevision: 1, messageIds: ["m1"] },
  );
  expect(queued.status).toBe(200);
  const connectorId = gmailConnectorId(accountId);
  if (!connectorId.ok) throw new Error("Invalid fixture connector");
  const source = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId: fixture.organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!source.ok) throw new Error(source.error.code);
  const evaluation = await runInDurableObject(
    source.value,
    settleBeforeProjection,
  );
  expect(
    await fixture.organisation.evaluateMailClassification(evaluation),
  ).toMatchObject({ ok: true });
  await runInDurableObject(source.value, expireWorkLease);
  await runDurableObjectAlarm(source.value);
  const input = {
    identity: { organisationId: fixture.organisationId, connectorId: connectorId.value },
    integrationAccountId: accountId,
    authority: fixture.request.authority,
  };
  const decision = {
    ...input,
    expectedRevision: 1,
    messageId: "m1",
    ruleId: "rule_supplier",
  };
  const initialOrganization = await source.value.readMailOrganization({
    ...input,
    messageIds: ["m1"],
  });
  expect(
    initialOrganization,
    JSON.stringify({
      initialOrganization,
      inferenceCalls: pause.inferenceCalls,
    }),
  ).toMatchObject({
    ok: true,
    value: { classifications: [{ messageId: "m1" }] },
  });
  const initialDecision = await source.value.readMailDecision(decision);
  expect(initialDecision, JSON.stringify(initialDecision)).toMatchObject({
    ok: true,
    value: { evidence: "current" },
  });
  pause.phase = "armed";
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      placementGmailResponse.bind(null, pause),
    ),
  );
  const work = source.value.readMailDecision(decision);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(mailPausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: fixture.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    completion = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailConnectorBarrier.bind(null, source.value), {
        timeout: 10_000,
      })
      .toBe(1);
    const exported = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
    )
      .bind(started.value.relocationId)
      .first<{ total: number }>();
    expect(exported?.total).toBe(0);
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(source.value);
    await verifyMailReadPlacement(source.value, input, false);
    const recovered = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: fixture.organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!recovered.ok) throw new Error(recovered.error.code);
    await verifyMailReadPlacement(recovered.value, input, true);
    await evictDurableObject(recovered.value);
    await verifyMailReadPlacement(recovered.value, input, true);
    expect(pause.inferenceCalls).toBe(1);
    Object.assign(task.meta, {
      connectorMailReadPlacement: {
        withheldDecision: true,
        exportsWhilePaused: 0,
        retiredSourceReadsRejected: 3,
        recoveredReadsAfterEviction: 3,
        inferenceCalls: pause.inferenceCalls,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

async function verifyMailReadPlacement(
  connector: DurableObjectStub<
    import("../../src/actors/connector").ConnectorDO
  >,
  input: import("../../src/mail-inbox/commands").MailOrganizationActorInput,
  active: boolean,
): Promise<void> {
  const organization = await connector.readMailOrganization({
    ...input,
    messageIds: ["m1"],
  });
  const page = await connector.readMailClassifiedPage({
    ...input,
    expectedRevision: 1,
    filter: { kind: "category", ruleId: "rule_supplier" },
    after: null,
  });
  const decision = await connector.readMailDecision({
    ...input,
    expectedRevision: 1,
    messageId: "m1",
    ruleId: "rule_supplier",
  });
  if (!active) {
    for (const result of [organization, page, decision])
      expect(result).toMatchObject({
        ok: false,
        error: { code: "connector_placement_conflict" },
      });
    return;
  }
  expect(organization).toMatchObject({
    ok: true,
    value: { classifications: [{ messageId: "m1" }] },
  });
  expect(page).toMatchObject({
    ok: true,
    value: { references: [{ messageId: "m1" }] },
  });
  expect(decision).toMatchObject({
    ok: true,
    value: { evidence: "current", classification: { messageId: "m1" } },
  });
}
function readMailConnectorBarrier(
  connector: DurableObjectStub<
    import("../../src/actors/connector").ConnectorDO
  >,
): Promise<number> {
  return runInDurableObject(connector, readMailConnectorBarrierSql);
}
function readMailConnectorBarrierSql(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec("SELECT 1 FROM state_object_cleanup_export_barrier")
    .toArray().length;
}

type MailPlacementPause = {
  readonly boundary: "source" | "inference";
  phase: "armed" | "paused" | "released";
  inferenceCalls: number;
};

it(
  "fences mail classification after a paused source read and recovers on the evicted Organisation",
  mailSourcePlacementJourney,
  70_000,
);
it(
  "drains issued mail inference before Organisation export while withholding frozen results",
  mailInferencePlacementJourney,
  70_000,
);

function mailSourcePlacementJourney(context: TestContext): Promise<void> {
  return mailPlacementJourney("source", context);
}
function mailInferencePlacementJourney(context: TestContext): Promise<void> {
  return mailPlacementJourney("inference", context);
}

async function mailPlacementJourney(
  boundary: MailPlacementPause["boundary"],
  { task }: TestContext,
): Promise<void> {
  const fixture = await installMailPlacementFixture();
  const pause: MailPlacementPause = {
    boundary,
    phase: "armed",
    inferenceCalls: 0,
  };
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      placementGmailResponse.bind(null, pause),
    ),
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      placementInferenceResponse.bind(null, pause),
    ),
  );
  const work = fixture.organisation.evaluateMailClassification(fixture.request);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(mailPausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.path);
    const started = await startActorRelocation({
      env,
      organisationId: fixture.organisationId,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    completion = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    await expect
      .poll(readMailOrganisationBarrier.bind(null, fixture.organisation), {
        timeout: 10_000,
      })
      .toBe(1);
    const exported = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
    )
      .bind(started.value.relocationId)
      .first<{ total: number }>();
    expect(exported?.total).toBe(0);
    expect(pause.inferenceCalls).toBe(boundary === "inference" ? 1 : 0);
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(fixture.organisation);
    expect(
      await fixture.organisation.evaluateMailClassification(fixture.request),
    ).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    const recovered = await requireActiveOrganisationActor({
      env,
      organisationId: fixture.organisationId,
      now: Date.now(),
    });
    const settled = await runInDurableObject(
      recovered,
      readMailPlacementSettlement,
    );
    expect(settled.results).toBe(0);
    expect(settled.pending).toBe(0);
    expect(settled.charged).toBe(boundary === "inference" ? 1 : 0);
    await evictDurableObject(recovered);
    const request = { ...fixture.request, evaluationId: "p55_recovered_mail" };
    expect(await recovered.evaluateMailClassification(request)).toMatchObject({
      ok: true,
      value: { classifications: [{ outcome: "matched" }] },
    });
    const calls = pause.inferenceCalls;
    await evictDurableObject(recovered);
    expect(await recovered.evaluateMailClassification(request)).toMatchObject({
      ok: true,
    });
    expect(pause.inferenceCalls).toBe(calls);
    Object.assign(task.meta, {
      mailPlacement: {
        boundary,
        exportedWhilePaused: 0,
        withheldSourceResult: true,
        settlement: settled,
        inferenceCalls: calls,
        replayedWithoutInference: true,
      },
    });
  } finally {
    pause.phase = "released";
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

async function installMailPlacementFixture() {
  network.use(
    http.post("https://api.typesafe.ai/v1/systemone", classificationFixture),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      organizationGmailFixture,
    ),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      watchFixture,
    ),
  );
  const owner = await client("p55-mail-owner");
  const organisationId = await workspace(owner);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const parsed = parseIntegrationAccountId(
    await mailbox(organisationId, owner, "p55-mail", "full_mailbox_pilot"),
  );
  if (!parsed.ok) throw new Error("Invalid fixture mailbox");
  const integrationAccountId = parsed.value;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Mail placement",
    plan: "beta",
    status: "active",
    createdAt: Date.now(),
  });
  const connected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: "typesafe-mail-e2e-key-000000",
    },
  );
  expect(connected.status, JSON.stringify(await connected.json())).toBe(200);
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId,
  });
  const person = await fixtureDatabase().prepare(
    "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(organisationId, owner.identity.userId)
    .first<{ personId: string }>();
  if (membershipRevision === null || person === null)
    throw new Error("Missing fixture membership");
  const authority = buildControlAuthority({
    organisationId,
    userId: owner.identity.userId,
    membershipRevision,
    requesterPersonId: person.personId,
    role: "owner",
  }).requestAuthority;
  const source = await authorizeMailSource(
    env,
    authority,
    integrationAccountId,
  );
  if (source === null) throw new Error("Missing fixture mail source");
  await fixtureDatabase().prepare(
    `INSERT INTO mail_classification_eligibility
    (organisation_id,integration_account_id,source_pin,connection_revision,model,purpose,evidence_reference,evidence_owner,disclosed_recipient,reviewed_at,review_expires_at,revoked_at)
    VALUES (?, ?, ?, 1, 'jev-1.13.0', 'mail_classification', 'p55-native', 'fixture-owner', 'typesafe', ?, ?, NULL)`,
  )
    .bind(
      organisationId,
      integrationAccountId,
      source.sourcePin,
      Date.now(),
      Date.now() + 3_600_000,
    )
    .run();
  const request: MailEvaluationInput = {
    organisationId,
    integrationAccountId,
    evaluationId: "p55_frozen_mail",
    revision: 1,
    messageId: "m1",
    rules: [
      {
        kind: "categorize",
        ruleId: "rule_supplier",
        category: "Suppliers",
        instruction: "Emails from a supplier about deliveries",
      },
    ],
    authority,
    sourcePin: source.sourcePin,
  };
  return { organisation, organisationId, request, owner };
}
function mailPausePhase(pause: MailPlacementPause): string {
  return pause.phase;
}
async function placementGmailResponse(
  pause: MailPlacementPause,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const response = organizationGmailFixture(input);
  if (
    pause.boundary === "source" &&
    pause.phase === "armed" &&
    new URL(input.request.url).pathname.endsWith("/messages/m1")
  ) {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return response;
}
async function placementInferenceResponse(
  pause: MailPlacementPause,
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  pause.inferenceCalls += 1;
  await input.request.json();
  if (pause.boundary === "inference" && pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers: { rule_0: { type: "choice", choice: "matched" } },
    usage: { input_tokens: 100, output_tokens: 1 },
  });
}
function readMailOrganisationBarrier(
  organisation: DurableObjectStub<OrganisationDO>,
): Promise<number> {
  return runInDurableObject(organisation, readMailOrganisationBarrierSql);
}
function readMailOrganisationBarrierSql(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec("SELECT 1 FROM state_object_policy_export_barrier")
    .toArray().length;
}
function readMailPlacementSettlement(
  _actor: unknown,
  state: DurableObjectState,
) {
  return state.storage.sql
    .exec<{ results: number; pending: number; charged: number }>(
      `SELECT
    (SELECT COUNT(*) FROM mail_evaluation_result) AS results,
    (SELECT COUNT(*) FROM typesafe_evaluation WHERE settlement_state = 'pending') AS pending,
    (SELECT COUNT(*) FROM typesafe_evaluation WHERE settlement_state = 'settled' AND estimated_cost_microusd > 0) AS charged`,
    )
    .one();
}

async function organizationJourney(): Promise<void> {
  mailInferenceCalls = 0;
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      organizationGmailFixture,
    ),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      watchFixture,
    ),
    http.post("https://api.typesafe.ai/v1/systemone", classificationFixture),
  );
  const owner = await client("organization-owner");
  const outsider = await client("organization-outsider");
  const organisationId = await workspace(owner);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const accountIdRaw = await mailbox(
    organisationId,
    owner,
    "organization",
    "full_mailbox_pilot",
  );
  const parsedAccountId = parseIntegrationAccountId(accountIdRaw);
  if (!parsedAccountId.ok) throw new Error("Invalid fixture account");
  const accountId = parsedAccountId.value;
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
    environment: "development",
    googleSubject: "organization",
    observedAddress: "organization@example.test",
    now: Date.now(),
  });
  expect(registered.ok).toBe(true);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Mail organization",
    plan: "beta",
    status: "active",
    createdAt: Date.now(),
  });
  const connected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: "typesafe-mail-e2e-key-000000",
    },
  );
  expect(connected.status, JSON.stringify(await connected.json())).toBe(200);
  const rules: readonly MailRule[] = [
    {
      kind: "categorize",
      ruleId: "rule_supplier",
      category: "Suppliers",
      instruction: "Emails from a supplier about deliveries",
    },
    {
      kind: "prioritize",
      ruleId: "rule_important",
      instruction: "A supplier explicitly reports a delivery delay",
    },
  ];
  const previewCommand: MailOrganizationCommand = {
    kind: "preview",
    rules,
    messageIds: ["m1"],
    consent: true,
  };
  expect(
    (await organizationSend(organisationId, owner.session, accountId, previewCommand))
      .status,
  ).toBe(409);
  const context = await resolveActiveProviderAccountContext({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId,
  });
  if (!context.ok) throw new Error(context.error.code);
  const sourcePin = await digestCanonical({
    providerConnectionId: context.value.connection.providerConnectionId,
    authority: context.value.connection.authority,
    updatedAt: context.value.connection.updatedAt,
  });
  await fixtureDatabase().prepare(
    `INSERT INTO mail_classification_eligibility
    (organisation_id,integration_account_id,source_pin,connection_revision,model,purpose,evidence_reference,evidence_owner,disclosed_recipient,reviewed_at,review_expires_at,revoked_at)
    VALUES (?, ?, ?, 1, 'jev-1.13.0', 'mail_classification', 'fixture-review', 'fixture-owner', 'typesafe', ?, ?, NULL)`,
  )
    .bind(organisationId, accountId, sourcePin, Date.now(), Date.now() + 3_600_000)
    .run();
  const preview = await organizationSend(
    organisationId,
    owner.session,
    accountId,
    previewCommand,
  );
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    kind: "preview",
    classifications: [{ outcome: "matched" }, { outcome: "matched" }],
  });
  expect(
    (
      await fixtureDatabase().prepare(
        "SELECT COUNT(*) AS count FROM mail_classification",
      ).first<{ count: number }>()
    )?.count,
  ).toBe(0);
  expect(
    (await organizationSend(organisationId, outsider.session, accountId, null))
      .status,
  ).toBe(404);
  const publish: MailOrganizationCommand = {
    kind: "publish",
    expectedRevision: 0,
    rules,
    consent: true,
  };
  expect(
    (await organizationSend(organisationId, owner.session, accountId, publish))
      .status,
  ).toBe(200);
  expect(
    (await organizationSend(organisationId, owner.session, accountId, publish))
      .status,
  ).toBe(409);
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "classify",
        expectedRevision: 1,
        messageIds: ["m1"],
      })
    ).status,
  ).toBe(200);
  const connectorId = gmailConnectorId(accountId);
  if (!connectorId.ok) throw new Error("Invalid connector");
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  const request = await runInDurableObject(
    connector.value,
    settleBeforeProjection,
  );
  const evaluated = await organisation.evaluateMailClassification(request);
  expect(evaluated.ok).toBe(true);
  // A crash after the settled provider receipt leaves Connector work pending.
  await evictDurableObject(organisation);
  await evictDurableObject(connector.value);
  await runInDurableObject(connector.value, expireWorkLease);
  network.use(
    http.post("https://api.typesafe.ai/v1/systemone", unexpectedInference),
  );
  await runDurableObjectAlarm(connector.value);
  const classified = await organizationView(organisationId, owner.session, accountId);
  expect(classified.classifications).toHaveLength(2);
  expect(classified.pending).toBe(0);
  const classifiedCursor = await classifiedViewsJourney(
    organisationId,
    owner.session,
    outsider.session,
    accountId,
  );
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "correct",
        expectedRevision: 1,
        messageId: "m1",
        ruleId: "rule_important",
        outcome: "not_matched",
      })
    ).status,
  ).toBe(200);
  const corrected = await organizationView(organisationId, owner.session, accountId);
  expect(corrected.classifications).toContainEqual(
    expect.objectContaining({
      ruleId: "rule_important",
      outcome: "not_matched",
      source: "operator",
    }),
  );
  expect(
    await result(
      await send(organisationId, owner.session, {
        kind: "decision",
        integrationAccountId: accountId,
        expectedRevision: 1,
        messageId: "m1",
        ruleId: "rule_important",
      }),
    ),
  ).toMatchObject({
    kind: "decision",
    decision: {
      classification: { source: "operator", outcome: "not_matched" },
      evidence: "current",
    },
  });
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
      arrivingHistoryFixture,
    ),
    http.post("https://api.typesafe.ai/v1/systemone", classificationFixture),
  );
  const hint = {
    identity: { organisationId, connectorId: connectorId.value },
    notificationId: "future-mail-notification",
    historyId: "12",
    now: Date.now(),
  };
  expect((await connector.value.acceptEmailChange(hint)).ok).toBe(true);
  expect((await connector.value.acceptEmailChange(hint)).ok).toBe(true);
  await runInDurableObject(connector.value, advanceObservationClock);
  await runDurableObjectAlarm(connector.value);
  const firstArrival = await organizationView(
    organisationId,
    owner.session,
    accountId,
  );
  expect(firstArrival.classifications.filter(messageTwo)).toHaveLength(2);
  expect(mailInferenceCalls).toBe(3);
  // Simulate the shared ledger's daily cost ceiling before the second history page.
  await runInDurableObject(organisation, exhaustMailBudget);
  await runInDurableObject(connector.value, advanceObservationClock);
  await runDurableObjectAlarm(connector.value);
  const budgetPaused = await organizationView(
    organisationId,
    owner.session,
    accountId,
  );
  expect(budgetPaused.pending).toBe(1);
  expect(budgetPaused.budgetPaused).toBe(1);
  expect(mailInferenceCalls).toBe(3);
  const covered = await runInDurableObject(connector.value, inspectObservation);
  expect(covered).toMatchObject({
    kind: "watching",
    historyId: "12",
    historyPageToken: null,
  });
  await evictDurableObject(connector.value);
  await runInDurableObject(organisation, restoreMailBudget);
  await runInDurableObject(connector.value, advanceBudgetClock);
  await runDurableObjectAlarm(connector.value);
  const resumed = await organizationView(organisationId, owner.session, accountId);
  expect(resumed.pending).toBe(0);
  expect(resumed.budgetPaused).toBe(0);
  expect(resumed.classifications).toHaveLength(6);
  expect(mailInferenceCalls).toBe(4);
  await runInDurableObject(connector.value, advanceObservationClock);
  await runDurableObjectAlarm(connector.value);
  expect(mailInferenceCalls).toBe(4);
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
      expiredHistoryFixture,
    ),
  );
  await runInDurableObject(connector.value, advanceObservationClock);
  await runDurableObjectAlarm(connector.value);
  expect(
    (await organizationView(organisationId, owner.session, accountId)).readiness,
  ).toBe("history_expired");
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "pause",
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  const paused = await organizationView(organisationId, owner.session, accountId);
  expect(paused.rules.kind).toBe("paused");
  expect(paused.classifications).toHaveLength(6);
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "classifiedPage",
        integrationAccountId: accountId,
        expectedRevision: 2,
        filter: { kind: "category", ruleId: "rule_supplier" },
        cursor: classifiedCursor,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "decision",
        integrationAccountId: accountId,
        expectedRevision: 1,
        messageId: "m1",
        ruleId: "rule_supplier",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "classify",
        expectedRevision: 2,
        messageIds: ["m2"],
      })
    ).status,
  ).toBe(409);
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      resumedProfileFixture,
    ),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      resumedWatchFixture,
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
      resumedHistoryFixture,
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m4",
      resumedMessageFixture,
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m_paused",
      unexpectedPausedHydration,
    ),
    http.post("https://api.typesafe.ai/v1/systemone", classificationFixture),
  );
  await evictDurableObject(connector.value);
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "resume",
        expectedRevision: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "resume",
        expectedRevision: 2,
      })
    ).status,
  ).toBe(200);
  const automatic = await organizationView(organisationId, owner.session, accountId);
  expect(automatic.rules).toMatchObject({
    kind: "published",
    revision: 3,
    rules,
  });
  expect(automatic.classifications).toEqual(paused.classifications);
  expect(mailInferenceCalls).toBe(4);
  await runInDurableObject(organisation, restoreMailBudget);
  await runInDurableObject(connector.value, advanceObservationClock);
  await runDurableObjectAlarm(connector.value);
  const future = await organizationView(organisationId, owner.session, accountId);
  expect(future.classifications).toHaveLength(8);
  expect(
    future.classifications.filter(classificationForResumedArrival),
  ).toHaveLength(2);
  expect(
    future.classifications.filter(classificationForPausedArrival),
  ).toHaveLength(0);
  expect(mailInferenceCalls).toBe(5);
  expect(
    (
      await organizationSend(organisationId, owner.session, accountId, {
        kind: "pause",
        expectedRevision: 3,
      })
    ).status,
  ).toBe(200);
  await evictDurableObject(connector.value);
  await runDurableObjectAlarm(connector.value);
  expect(
    (await organizationView(organisationId, owner.session, accountId)).rules.kind,
  ).toBe("paused");
  expect(mailInferenceCalls).toBe(5);
  console.log(
    "MAIL_PROCESSING_TOGGLE_E2E: pause and resume survive eviction; stale changes fenced; saved classifications retained; resume reads profile cursor 99 despite watch cursor 98; history starts at 99, excludes paused arrival at 88, classifies future m4 at 100; paused alarm performs no inference; no Case or reply admission",
  );
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1",
      revokeDuringHydration.bind(null, organisationId),
    ),
  );
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "classifiedPage",
        integrationAccountId: accountId,
        expectedRevision: 4,
        filter: { kind: "category", ruleId: "rule_supplier" },
        cursor: null,
      })
    ).status,
  ).toBe(404);
  expect(
    (await organizationSend(organisationId, owner.session, accountId, null)).status,
  ).toBe(404);
  expect(
    (
      await send(organisationId, owner.session, {
        kind: "decision",
        integrationAccountId: accountId,
        expectedRevision: 4,
        messageId: "m1",
        ruleId: "rule_supplier",
      })
    ).status,
  ).toBe(404);
  for (const table of [
    "email_message_receipt",
    "email_thread_case",
    "email_reply_proposal",
  ]) {
    const row = await fixtureDatabase().prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).first<{ count: number }>();
    expect(row?.count).toBe(0);
  }
  const metadata = await fixtureDatabase().prepare(
    "SELECT * FROM mail_classification",
  ).all();
  expect(JSON.stringify(metadata)).not.toContain("Private body");
}

async function revokeDuringHydration(organisationId: OrganisationId): Promise<Response> {
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'revoked', revision = revision + 1, reason = 'fixture revoked during read' WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .run();
  return HttpResponse.json(gmailMessage("m1", "t1", false));
}

function classificationForResumedArrival(classification: {
  messageId: string;
}): boolean {
  return classification.messageId === "m4";
}

function classificationForPausedArrival(classification: {
  messageId: string;
}): boolean {
  return classification.messageId === "m_paused";
}

function resumedProfileFixture(): Response {
  return HttpResponse.json({
    emailAddress: "organization@example.test",
    historyId: "99",
  });
}

function resumedWatchFixture(): Response {
  return HttpResponse.json({
    historyId: "98",
    expiration: String(Date.now() + 86_400_000),
  });
}

function resumedHistoryFixture({
  request,
}: {
  request: { url: string };
}): Response {
  const url = new URL(request.url);
  expect(url.searchParams.get("startHistoryId")).toBe("99");
  expect(url.searchParams.getAll("historyTypes")).toContain("messageAdded");
  const history = [
    {
      id: "88",
      messagesAdded: [
        {
          message: {
            id: "m_paused",
            threadId: "t_paused",
            labelIds: ["INBOX"],
          },
        },
      ],
    },
    {
      id: "100",
      messagesAdded: [
        { message: { id: "m4", threadId: "t4", labelIds: ["INBOX"] } },
      ],
    },
  ];
  return HttpResponse.json({
    historyId: "100",
    history: history.filter(
      historyAfterCursor.bind(
        null,
        BigInt(url.searchParams.get("startHistoryId") ?? "0"),
      ),
    ),
  });
}

function historyAfterCursor(cursor: bigint, history: { id: string }): boolean {
  return BigInt(history.id) > cursor;
}

function unexpectedPausedHydration(): Response {
  throw new Error(
    "Mail received while paused must not be hydrated after resume",
  );
}

function resumedMessageFixture(): Response {
  return HttpResponse.json(gmailMessage("m4", "t4", true));
}

async function classifiedViewsJourney(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  outsider: IssuedControlSession,
  accountId: string,
): Promise<string> {
  const statements: D1PreparedStatement[] = [];
  const references = ["zdeleted", "zarchived"];
  for (let index = 1; index <= 230; index++)
    references.push(`b${String(index).padStart(3, "0")}`);
  for (const id of references)
    statements.push(
      fixtureDatabase().prepare(
        `INSERT INTO mail_classification
      (organisation_id, integration_account_id, rule_revision, message_id, thread_id, rule_id, outcome, source, evaluated_at, evaluation_id, content_digest)
      SELECT organisation_id, integration_account_id, rule_revision, ?, ?, rule_id, outcome, source, evaluated_at + 1000, evaluation_id, content_digest
      FROM mail_classification WHERE organisation_id = ? AND integration_account_id = ? AND message_id = 'm1'`,
      ).bind(id, `t_${id}`, organisationId, accountId),
    );
  await fixtureDatabase().batch(statements);
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      classifiedGmailFixture.bind(null, organisationId, accountId),
    ),
  );
  // Displayed mail keeps its decisions even after hundreds of newer projections.
  expect(
    (await organizationView(organisationId, session, accountId)).classifications,
  ).toHaveLength(2);
  const command = {
    kind: "classifiedPage",
    integrationAccountId: accountId,
    expectedRevision: 1,
    filter: { kind: "category", ruleId: "rule_supplier" },
    cursor: null,
  } as const;
  expect((await send(organisationId, outsider, command)).status).toBe(404);
  const firstResponse = await send(organisationId, session, command);
  expect(firstResponse.headers.get("cache-control")).toBe("no-store");
  const first = await result(firstResponse);
  if (first.kind !== "page" || first.nextCursor === null)
    throw new Error("Missing category cursor");
  expect(first.messages).toHaveLength(18);
  expect(JSON.stringify(first)).not.toContain("Private body");
  expect(
    (
      await send(organisationId, session, {
        ...command,
        filter: { kind: "important" },
        cursor: first.nextCursor,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await send(organisationId, session, {
        ...command,
        cursor: `${first.nextCursor}corrupt`,
      })
    ).status,
  ).toBe(422);
  const secondSession = (await client("organization-owner")).session;
  expect(
    (
      await send(organisationId, secondSession, {
        ...command,
        cursor: first.nextCursor,
      })
    ).status,
  ).toBe(422);
  const seen = new Set(first.messages.map(inboxMessageId));
  let cursor: string | null = first.nextCursor;
  let pages = 1;
  while (cursor !== null) {
    expect(pages).toBeLessThan(15);
    const page = await result(
      await send(organisationId, session, { ...command, cursor }),
    );
    if (page.kind !== "page") throw new Error("Invalid category page");
    for (const message of page.messages) {
      expect(seen.has(message.messageId)).toBe(false);
      seen.add(message.messageId);
    }
    cursor = page.nextCursor;
    pages++;
  }
  expect(seen.size).toBe(231);
  expect(seen.has("m1")).toBe(true);
  expect(seen.has("zarchived")).toBe(false);
  expect(seen.has("zdeleted")).toBe(false);
  const refreshed = await result(await send(organisationId, session, command));
  if (refreshed.kind !== "page")
    throw new Error("Invalid refreshed category page");
  expect(refreshed.messages.map(inboxMessageId)).toContain("zzarrival");
  const detailCommand = {
    kind: "decision",
    integrationAccountId: accountId,
    expectedRevision: 1,
    messageId: "m1",
    ruleId: "rule_supplier",
  } as const;
  const details = await result(await send(organisationId, session, detailCommand));
  expect(details).toMatchObject({
    kind: "decision",
    decision: {
      rule: { instruction: "Emails from a supplier about deliveries" },
      evidence: "current",
    },
  });
  expect(JSON.stringify(details)).not.toContain("Private body");
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1",
      changedMessageFixture,
    ),
  );
  expect(
    await result(await send(organisationId, session, detailCommand)),
  ).toMatchObject({ kind: "decision", decision: { evidence: "changed" } });
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      organizationGmailFixture,
    ),
  );
  await fixtureDatabase().prepare(
    "DELETE FROM mail_classification WHERE organisation_id = ? AND integration_account_id = ? AND message_id NOT IN ('m1', 'm2', 'm3')",
  )
    .bind(organisationId, accountId)
    .run();
  return first.nextCursor;
}

function inboxMessageId(message: Readonly<{ messageId: string }>): string {
  return message.messageId;
}

async function classifiedGmailFixture(
  organisationId: OrganisationId,
  accountId: string,
  input: {
    request: { url: string; headers: Headers };
  },
): Promise<Response> {
  const url = new URL(input.request.url);
  const id = url.pathname.split("/").at(-1) ?? "";
  if (id === "b230")
    await fixtureDatabase().prepare(
      `INSERT OR IGNORE INTO mail_classification
      (organisation_id, integration_account_id, rule_revision, message_id, thread_id, rule_id, outcome, source, evaluated_at, evaluation_id, content_digest)
      SELECT organisation_id, integration_account_id, rule_revision, 'zzarrival', 't_zzarrival', rule_id, outcome, source, evaluated_at, evaluation_id, content_digest
      FROM mail_classification WHERE organisation_id = ? AND integration_account_id = ? AND message_id = 'm1'`,
    )
      .bind(organisationId, accountId)
      .run();
  if (id === "zdeleted") return new Response("missing", { status: 404 });
  if (id === "zarchived")
    return HttpResponse.json({
      ...gmailMessage(id, `t_${id}`, false),
      labelIds: [],
    });
  if (/^b\d{3}$/.test(id) || id === "zzarrival")
    return HttpResponse.json(
      gmailMessage(id, `t_${id}`, url.searchParams.get("format") === "full"),
    );
  return organizationGmailFixture(input);
}

function changedMessageFixture(): Response {
  const message = gmailMessage("m1", "t1", true);
  return HttpResponse.json({
    ...message,
    payload: {
      ...message.payload,
      body: {
        data: encodeBase64Url(
          new TextEncoder().encode(
            "Private body: corrected delivery is Monday.",
          ),
        ),
      },
    },
  });
}
function settleBeforeProjection(_actor: unknown, state: DurableObjectState) {
  const head = readMailHead(state.storage.sql);
  const work = state.storage.transactionSync(
    claimMailWork.bind(null, state.storage.sql, Date.now()),
  );
  if (head === null || work === null)
    throw new Error("Missing classification work");
  return mailEvaluationInput(head, work);
}
function expireWorkLease(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE mail_classification_work SET due_at = 0 WHERE state = 'evaluating'",
  );
}
function advanceObservationClock(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec("UPDATE mail_organization SET observe_at = 0");
}
function inspectObservation(_actor: unknown, state: DurableObjectState) {
  return readMailHead(state.storage.sql)?.observation;
}
function exhaustMailBudget(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE typesafe_evaluation SET estimated_cost_microusd = 300000 WHERE purpose = 'mail_classification'",
  );
}
function restoreMailBudget(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE typesafe_evaluation SET estimated_cost_microusd = 3 WHERE purpose = 'mail_classification'",
  );
}
function advanceBudgetClock(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE mail_classification_work SET due_at = 0 WHERE state = 'budget_paused'",
  );
}
function messageTwo(result: { messageId: string }): boolean {
  return result.messageId === "m2";
}
function arrivingHistoryFixture({
  request,
}: {
  request: { url: string };
}): Response {
  const url = new URL(request.url);
  expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
  if (url.searchParams.get("startHistoryId") === "12")
    return HttpResponse.json({ historyId: "12" });
  expect(url.searchParams.get("startHistoryId")).toBe("10");
  const second = url.searchParams.get("pageToken") === "mail-history-next";
  const message = second
    ? { id: "m3", threadId: "t3" }
    : { id: "m2", threadId: "t2" };
  return HttpResponse.json({
    historyId: "12",
    history: [{ id: "11", messagesAdded: [{ message }, { message }] }],
    ...(second ? {} : { nextPageToken: "mail-history-next" }),
  });
}
function expiredHistoryFixture(): Response {
  return new Response("history expired", { status: 404 });
}
function watchFixture(): Response {
  return HttpResponse.json({
    historyId: "10",
    expiration: String(Date.now() + 86_400_000),
  });
}
function organizationGmailFixture(input: {
  request: { url: string; headers: Headers };
}): Response {
  if (new URL(input.request.url).pathname.endsWith("/profile"))
    return HttpResponse.json({
      emailAddress: "organization@example.test",
      historyId: "10",
    });
  const url = new URL(input.request.url);
  if (url.pathname.endsWith("/history"))
    return HttpResponse.json({ historyId: "10" });
  if (/\/messages\/m[123]$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-1) ?? "";
    return HttpResponse.json(
      gmailMessage(
        id,
        `t${id.slice(1)}`,
        url.searchParams.get("format") === "full",
      ),
    );
  }
  return gmailFixture(input);
}
let mailInferenceCalls = 0;
async function classificationFixture({
  request,
}: {
  request: { json: () => Promise<unknown> };
}): Promise<Response> {
  const raw = await request.json();
  if (!isRecord(raw) || !isRecord(raw.questions))
    throw new Error("Invalid fixture inference request");
  if (raw.questions.in_transit !== undefined)
    return HttpResponse.json({
      model: "jev-1.13.0",
      answers: { in_transit: { type: "noul", noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
  expect(JSON.stringify(raw)).toContain("Private body");
  mailInferenceCalls++;
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers: {
      rule_0: { type: "choice", choice: "matched" },
      rule_1: { type: "choice", choice: "matched" },
    },
    usage: { input_tokens: 50, output_tokens: 2 },
  });
}
function unexpectedInference(): Response {
  throw new Error("Settled inference must replay its receipt");
}
function organizationSend(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  accountId: string,
  body: MailOrganizationCommand | null,
): Promise<Response> {
  return controlFetch(
    organisationId,
    session,
    `mail-inbox/${accountId}/organization`,
    body,
  );
}
async function organizationView(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  accountId: string,
) {
  const response = await controlFetch(
    organisationId,
    session,
    `mail-inbox/${accountId}/organization?messageId=m1&messageId=m2&messageId=m3&messageId=m4`,
    null,
  );
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  const view = parseMailOrganizationView(raw);
  if (view === null) throw new Error("Invalid organization view");
  return view;
}
it(
  "proposes a rule through transient Inbox assistance, fences processing revocation and leaves no content or effects in durable state",
  assistantJourney,
  60000,
);

async function assistantJourney(context: TestContext): Promise<void> {
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      organizationGmailFixture,
    ),
  );
  const owner = await client("assistant-owner");
  const organisationId = await workspace(owner);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const accountId = await mailbox(
    organisationId,
    owner,
    "assistant",
    "full_mailbox_pilot",
  );
  const command = {
    kind: "proposeRule",
    modelRouteDigest: "0".repeat(64),
    prompt:
      "Prioritize delayed packaging orders. Private operator marker: ASSISTANT_PRIVATE_REQUEST",
    consent: true,
  };
  expect(
    (await assistantSend(organisationId, accountId, owner.session, command))
      .status,
  ).toBe(409);
  await fixtureDatabase().prepare(
    "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
  )
    .bind(organisationId, owner.identity.userId, Date.now())
    .run();
  const contextGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: "grant_assistant_context",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "assistant-e2e",
    },
    now: Date.now(),
  });
  if (!contextGrant.ok) throw new Error(contextGrant.error.code);
  const membership = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId,
  });
  if (membership === null) throw new Error("Missing owner membership");
  const person = await fixtureDatabase().prepare(
    "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(organisationId, owner.identity.userId)
    .first<{ personId: string }>();
  if (person === null) throw new Error("Missing owner person");
  const authority = buildControlAuthority({
    organisationId,
    userId: owner.identity.userId,
    membershipRevision: membership,
    requesterPersonId: person.personId,
    role: "owner",
  }).requestAuthority;
  const account = parseIntegrationAccountId(accountId);
  if (!account.ok) throw new Error("Invalid mailbox");
  const source = await authorizeMailSource(env, authority, account.value);
  const model = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now: Date.now(),
  });
  if (source === null || !model.ok) throw new Error("Missing assistant route");
  command.modelRouteDigest = await digestModelRoute(model.value);
  await fixtureDatabase().prepare(
    `INSERT INTO mail_assistant_eligibility (organisation_id, integration_account_id, source_pin, model_route_digest, purpose, disclosed_recipient, evidence_reference, owner, consent_reference, reviewed_at, review_expires_at, revoked_at) VALUES (?, ?, ?, ?, 'mail_inbox_assistance', 'openrouter', 'synthetic-assistant-e2e', 'synthetic-reviewer', 'synthetic-consent', ?, ?, NULL)`,
  )
    .bind(
      organisationId,
      accountId,
      source.sourcePin,
      await digestModelRoute(model.value),
      Date.now() - 1000,
      Date.now() + 3600000,
    )
    .run();
  const modelState = {
    calls: 0,
    revoke: false,
    revokeSession: false,
    controlSession: owner.session.session,
    explanation: false,
    mutate: false,
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      assistantModel.bind(null, organisationId, modelState),
    ),
  );
  const response = await assistantSend(
    organisationId,
    accountId,
    owner.session,
    command,
  );
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  expect(raw).toMatchObject({
    kind: "ruleProposal",
    rule: {
      kind: "prioritize",
      instruction:
        "ASSISTANT_GENERATED_CRITERIA: supplier delays affecting packaging deliveries.",
    },
  });
  expect(modelState.calls).toBe(1);
  const connectorId = gmailConnectorId(account.value);
  if (!connectorId.ok) throw new Error("Missing connector identity");
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  await runInDurableObject(
    connector.value,
    seedAssistantDecision.bind(null, {
      organisationId,
      accountId: account.value,
      authority,
      sourcePin: source.sourcePin,
    }),
  );
  await fixtureDatabase().prepare(
    `INSERT INTO mail_classification (organisation_id, integration_account_id, rule_revision, message_id, thread_id, rule_id, outcome, source, evaluated_at, evaluation_id, content_digest) VALUES (?, ?, 1, 'm1', 't1', 'rule_explain', 'matched', 'operator', ?, 'fixture_explanation', ?)`,
  )
    .bind(organisationId, accountId, Date.now(), "0".repeat(64))
    .run();
  modelState.explanation = true;
  const explain = {
    kind: "explainDecision",
    modelRouteDigest: command.modelRouteDigest,
    messageId: "m1",
    ruleId: "rule_explain",
    expectedRevision: 1,
    consent: true,
  };
  const explained = await assistantSend(
    organisationId,
    accountId,
    owner.session,
    explain,
  );
  expect(explained.status, JSON.stringify(await explained.clone().json())).toBe(
    200,
  );
  expect(await explained.json()).toMatchObject({
    kind: "explanation",
    evidence: "changed",
    text: expect.stringContaining("ASSISTANT_GENERATED_EXPLANATION"),
  });
  modelState.mutate = true;
  expect(
    (await assistantSend(organisationId, accountId, owner.session, explain))
      .status,
  ).toBe(409);
  modelState.mutate = false;
  modelState.explanation = false;
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      organizationGmailFixture,
    ),
  );
  // Proposing does not publish criteria, admit historical mail, draft or send.
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM email_thread_case WHERE organisation_id = ?",
    )
      .bind(organisationId)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM email_reply_proposal WHERE organisation_id = ?",
    )
      .bind(organisationId)
      .first(),
  ).toEqual({ count: 0 });
  const placements = await fixtureDatabase().prepare(
    "SELECT object_kind AS kind, physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind IN ('case', 'session')",
  )
    .bind(organisationId)
    .all<{ kind: string; name: string }>();
  expect(placements.results.length).toBe(6);
  for (const row of placements.results) {
    const actor =
      row.kind === "case"
        ? env.CASE.getByName(row.name)
        : env.SESSION.getByName(row.name);
    const stored = await runInDurableObject(actor, storedContent);
    expect(stored).not.toContain("ASSISTANT_PRIVATE_REQUEST");
    expect(stored).not.toContain("ASSISTANT_GENERATED_CRITERIA");
    expect(stored).not.toContain("ASSISTANT_GENERATED_EXPLANATION");
    expect(stored).not.toContain("Private body");
  }
  modelState.revoke = true;
  expect(
    (await assistantSend(organisationId, accountId, owner.session, command))
      .status,
  ).toBe(409);
  expect(modelState.calls).toBe(4);
  expect(
    (await assistantSend(organisationId, accountId, owner.session, command))
      .status,
  ).toBe(409);
  expect(modelState.calls).toBe(4);
  await fixtureDatabase().prepare(
    "UPDATE mail_assistant_eligibility SET revoked_at = NULL WHERE organisation_id = ?",
  )
    .bind(organisationId)
    .run();
  modelState.revoke = false;
  modelState.revokeSession = true;
  expect(
    (await assistantSend(organisationId, accountId, owner.session, command))
      .status,
  ).toBe(404);
  expect(modelState.calls).toBe(5);
  expect(
    (await assistantSend(organisationId, accountId, owner.session, command))
      .status,
  ).toBe(401);
  expect(modelState.calls).toBe(5);
  Object.assign(context.task.meta, {
    assistantAcceptance: {
      modelRequestCount: modelState.calls,
      transientContentRetained: false,
      emailEffects: 0,
      processingRevocationWithheld: true,
      controlSessionRevocationWithheld: true,
      revokedSessionRedispatchBlocked: true,
    },
  });
  console.log(
    "MAIL_ASSISTANT_E2E: real Worker + D1 + Connector + Case + Session + Pi; reviewed rule proposal transient; no retained prompt/output/email or email effects; revoked processing withheld and fresh dispatch blocked",
  );
}
async function assistantModel(
  organisationId: OrganisationId,
  state: {
    calls: number;
    revoke: boolean;
    revokeSession: boolean;
    controlSession: IssuedControlSession["session"];
    explanation: boolean;
    mutate: boolean;
  },
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const raw: unknown = await request.json();
  expect(isRecord(raw) ? (raw.tools ?? []) : null).toEqual([]);
  expect(JSON.stringify(raw)).toContain(
    state.explanation
      ? "Private body: packaging arrives Friday."
      : "ASSISTANT_PRIVATE_REQUEST",
  );
  if (state.explanation)
    expect(JSON.stringify(raw)).toContain('\\"source\\":\\"operator\\"');
  if (state.mutate)
    network.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1",
        changedMessageFixture,
      ),
    );
  state.calls += 1;
  if (state.revokeSession)
    await revokeControlSession({
      db: env.DB,
      session: state.controlSession,
      now: Date.now(),
    });
  if (state.revoke)
    await fixtureDatabase().prepare(
      "UPDATE mail_assistant_eligibility SET revoked_at = ? WHERE organisation_id = ?",
    )
      .bind(Date.now(), organisationId)
      .run();
  return openRouterText(
    JSON.stringify(
      state.explanation
        ? {
            kind: "explanation",
            evidence: "changed",
            text: "ASSISTANT_GENERATED_EXPLANATION: This was an operator correction; the changed email cannot establish the original rationale.",
          }
        : {
            kind: "ruleProposal",
            rule: {
              kind: "prioritize",
              ruleId: "rule_assistant_fixture",
              instruction:
                "ASSISTANT_GENERATED_CRITERIA: supplier delays affecting packaging deliveries.",
            },
          },
    ),
    `assistant_${state.calls}`,
  );
}
function assistantSend(
  organisationId: string,
  accountId: string,
  session: IssuedControlSession,
  command: unknown,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/mail-inbox/${accountId}/assistant`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify(command),
    },
  );
}
function seedAssistantDecision(
  input: Readonly<{
    organisationId: OrganisationId;
    accountId: import("../../src/ids").IntegrationAccountId;
    authority: Extract<
      import("@purin-labs/contracts").RequestAuthority,
      { kind: "control" }
    >;
    sourcePin: string;
  }>,
  _actor: unknown,
  state: DurableObjectState,
): void {
  writeMailHead(
    state.storage.sql,
    {
      organisationId: input.organisationId,
      integrationAccountId: input.accountId,
      authority: input.authority,
      sourcePin: input.sourcePin,
      classificationRevision: 1,
      action: { kind: "none" },
      observation: {
        kind: "watching",
        historyId: "100",
        historyPageToken: null,
        watchExpiresAt: Date.now() + 3600000,
      },
      view: {
        kind: "published",
        revision: 1,
        activatedAt: Date.now(),
        rules: [
          {
            kind: "prioritize",
            ruleId: "rule_explain",
            instruction: "Supplier reports a packaging delivery delay",
          },
        ],
      },
    },
    Date.now(),
  );
}

it(
  "hides CaseContextCollection existence behind source permission and fences inspector review across revocation and Actor eviction",
  caseContextCollectionMetadataJourney,
  60_000,
);
it(
  "gives the mailbox agent the accepted Memory for its verified supplier, records what it rendered and stops after revocation",
  supplierMemoryMailboxJourney,
  60_000,
);
it(
  "shows the order and the Memory that a reply draft cites, only to a person who may read them, and drops what the turn never read",
  replySourcesJourney,
  90_000,
);
it(
  "keeps a waiting reply draft across a change of the mailbox limits and ends it when processing stops",
  mailboxSettingsDraftJourney,
  120_000,
);
it(
  "compares the accepted and a candidate Memory on reviewed scenarios as one Case, and keeps an interrupted turn's result unknown",
  supplierEvalRunJourney,
  240_000,
);
// The real model answers each Eval turn. It needs PANTRY_PI_ACCEPTANCE_API_KEY.
it.skipIf(env.OPENROUTER_API_KEY === "openrouter-e2e-key")(
  "runs the reviewed Eval three times on the real pinned Pi route and records what the model did",
  supplierLiveEvalRunJourney,
  540_000,
);
it.skipIf(env.OPENROUTER_API_KEY === "openrouter-e2e-key")(
  "lets the real pinned Pi route learn from a corrected reply and records what it proposed",
  supplierLiveLearningJourney,
  240_000,
);
it(
  "recovers an accepted CaseContextCollection reply after a lost provider response and correction",
  caseContextCollectionReplyDispatchJourney,
  60_000,
);
it(
  "fences an CaseContextCollection reply when Gmail deletes its selected source after preview",
  caseContextCollectionReplyProviderErasureJourney,
  60_000,
);
it(
  "cleans an accepted CaseContextCollection draft with a lost response after its source is erased",
  caseContextCollectionReplyLostDraftJourney,
  60_000,
);
it(
  "rejects confirmed CaseContextCollection evidence with a merchant-private source label before model access",
  caseContextCollectionReplySourceLabelJourney,
  60_000,
);

type CaseContextCollectionReplyScenario =
  | "metadata"
  | "accepted_send"
  | "provider_erasure"
  | "lost_draft"
  | "source_label"
  | "memory"
  | "sources"
  | "mailbox_settings"
  | "evals"
  | "evals_live"
  | "learning_live";

/**
 * The second administrator that a reply journey adds late. The account
 * authority must know each person when the Organisation is attached.
 */
const REPLY_JOURNEY_COLLEAGUES: Partial<
  Record<
    CaseContextCollectionReplyScenario,
    Readonly<{ subject: string; personId: string }>
  >
> = {
  memory: {
    subject: "mail-turn-memory-member",
    personId: "person_mail_turn_member",
  },
  evals: { subject: "eval-run-stranger", personId: "person_eval_stranger" },
  evals_live: {
    subject: "eval-run-stranger",
    personId: "person_eval_stranger",
  },
};

async function caseContextCollectionMetadataJourney(context: TestContext): Promise<void> {
  await caseContextCollectionReplyJourney(context, "metadata");
}
async function supplierMemoryMailboxJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "memory");
}
async function replySourcesJourney(context: TestContext): Promise<void> {
  await caseContextCollectionReplyJourney(context, "sources");
}
async function mailboxSettingsDraftJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "mailbox_settings");
}
async function supplierEvalRunJourney(context: TestContext): Promise<void> {
  await caseContextCollectionReplyJourney(context, "evals");
}
async function supplierLiveEvalRunJourney(context: TestContext): Promise<void> {
  await caseContextCollectionReplyJourney(context, "evals_live");
}
async function supplierLiveLearningJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "learning_live");
}
async function caseContextCollectionReplyDispatchJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "accepted_send");
}
async function caseContextCollectionReplyProviderErasureJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "provider_erasure");
}
async function caseContextCollectionReplyLostDraftJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "lost_draft");
}
async function caseContextCollectionReplySourceLabelJourney(
  context: TestContext,
): Promise<void> {
  await caseContextCollectionReplyJourney(context, "source_label");
}

async function caseContextCollectionReplyJourney(
  context: TestContext,
  scenario: CaseContextCollectionReplyScenario,
): Promise<void> {
  const owner = await client("case-context-collection-reply-owner");
  const organisationId = await workspace(owner);
  const rawAccount = await mailbox(
    organisationId,
    owner,
    "case-context-collection-reply",
    "full_mailbox_pilot",
  );
  const account = parseIntegrationAccountId(rawAccount);
  if (!account.ok) throw new Error(account.error.code);
  const now = Date.now();
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    googleSubject: "case-context-collection-reply",
    observedAddress: "shop@example.test",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  await installWorkMailbox(organisationId, account.value, owner.identity.userId, now);
  // The account authority knows this Organisation, its owner and the agent
  // of the mailbox, so each control request and each mailbox turn passes the
  // real account check. It also knows the second administrator of the Memory
  // and the Eval journeys, who gets a role in Pantry late in those journeys.
  const colleague = REPLY_JOURNEY_COLLEAGUES[scenario];
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members:
      colleague === undefined
        ? {}
        : {
            operator: {
              client: await client(colleague.subject),
              laterPersonId: colleague.personId,
            },
          },
  });
  const merchantId = await seedPurchasingContext(
    organisationId,
    owner.identity.userId,
    account.value,
  );
  if (scenario === "sources")
    await seedMailOrderAccess(organisationId, merchantId, account.value);
  const target = {
    kind: "supplier_contact" as const,
    supplierId: "supplier_case_context_collection",
    contactId: "contact_case_context_collection",
    contactRevision: 1,
  };
  expect(
    await registerOperationalEmailContact({
      db: fixtureDatabase(),
      organisationId,
      target,
      address: "supplier@example.test",
      displayName: "Synthetic supplier",
      state: "active",
      relationshipState: "active",
      now,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await publishContactVerification({
      db: fixtureDatabase(),
      organisationId,
      actorId: owner.identity.userId,
      now,
      command: {
        kind: "verify",
        commandId: "verify_case_context_collection",
        verificationId: "verification_case_context_collection",
        expectedRevision: 0,
        integrationAccountId: account.value,
        target,
        endpoint: { channel: "gmail", address: "supplier@example.test" },
        evidenceRef: "synthetic:verified-supplier",
      },
    }),
  ).toMatchObject({ ok: true });
  // A real model uses about 3,500 tokens for one Eval turn, and the live
  // run makes 24 of them.
  const dailyTokenBudget =
    scenario === "evals_live" || scenario === "learning_live" ? 400_000 : 20000;
  const published = await publishMailboxIngressPolicy({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: account.value,
    environment: "development",
    publishedBy: owner.identity.userId,
    now,
    request: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
  });
  if (!published.ok || published.value.kind !== "enabled")
    throw new Error("Missing mailbox ingress policy");
  const fixture: DraftTurnFixture = {
    organisationId,
    integrationAccountId: account.value,
    threadId: "case_context_collection_anchor",
    caseId: `case_gmail_${rawAccount}_case_context_collection_anchor`,
    messageIds: ["case_context_collection_anchor_message"],
    mailboxBindingId: "binding_work",
    bindingRevision: 1,
    policyVersion: published.value.policyVersion,
    limits: {
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget,
      maxMessageBytes: 262144,
      maxAttachmentBytes: 5242880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    },
    responsePolicy: "cue_routed",
  };
  const contextGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: "grant_case_context_collection_context",
    now,
    subject: {
      kind: "agent_mailbox",
      integrationAccountId: account.value,
      mailboxBindingId: "binding_work",
      bindingRevision: 1,
    },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "case-context-collection-e2e",
    },
  });
  if (!contextGrant.ok) throw new Error(contextGrant.error.code);
  await fixtureDatabase().prepare(
    "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
  )
    .bind(organisationId, owner.identity.userId, now)
    .run();
  const route = await resolveOrganisationModelRoute({ env, organisationId, now });
  if (!route.ok) throw new Error(route.error.code);
  await fixtureDatabase().prepare(
    "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'synthetic-case-context-discovery-e2e', 'synthetic-reviewer', 'openrouter', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
  )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      now,
      now + 3600000,
      now,
    )
    .run();
  const connectorId = gmailConnectorId(account.value);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) throw new Error(connector.error.code);
  await runInDurableObject(
    connector.value,
    seedCaseContextCollectionRuntime.bind(null, fixture),
  );
  const organisation = await requireActiveOrganisationActor({ env, organisationId, now });
  await organisation.ensureOrganisation({
    organisationId,
    name: "CaseContextCollection supplier acceptance",
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  const state = new CaseContextCollectionReplyProvider();
  state.loseDraftResponse = scenario === "lost_draft";
  network.use(
    http.post("https://api.typesafe.ai/v1/systemone", caseContextCollectionConnectionProbe),
  );
  expect(
    await organisation.manageTypeSafeConnection({
      organisationId,
      actorId: owner.identity.userId,
      body: {
        operation: "connect",
        expectedRevision: 0,
        provider: "typesafe",
        apiKey: "apikey_case-context-discovery-synthetic-1234567890",
      },
    }),
  ).toMatchObject({ ok: true });
  for (const message of ["anchor", "related"]) {
    const caseId = parseCaseId(`case_gmail_${rawAccount}_case_context_collection_${message}`);
    if (!caseId.ok) throw new Error(caseId.error.code);
    expect(
      await admitEmailThreadCase(env, {
        scope: await requireMailFixtureScope(organisationId),
        organisationId,
        integrationAccountId: account.value,
        gmailThreadId: `case_context_collection_${message}`,
        caseId: caseId.value,
        messageIds: [`case_context_collection_${message}_message`],
        mailboxBindingId: "binding_work",
        bindingRevision: 1,
        policyVersion: published.value.policyVersion,
        receivedAt: now,
        // The Subject header of the fixture's messages, as the connector
        // reads it.
        subject: MAIL_SUBJECT,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await recordEmailMessageReceipt({
        scope: await requireMailFixtureScope(organisationId),
        integrationAccountId: account.value,
        providerMessageId: `case_context_collection_${message}_message`,
        gmailThreadId: `case_context_collection_${message}`,
        caseId: caseId.value,
        policyVersion: published.value.policyVersion,
        now,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await bindEmailMessageReceiptContact({
        scope: await requireMailFixtureScope(organisationId),
        integrationAccountId: account.value,
        providerMessageId: `case_context_collection_${message}_message`,
        caseId: caseId.value,
        admittedAt: now,
        verificationId: "verification_case_context_collection",
        verificationRevision: 1,
      }),
    ).toMatchObject({ ok: true });
  }
  const privateAuthority = await seedPrivateCaseContextCollectionNote(
    organisationId,
    owner.identity.userId,
    fixture.caseId,
  );
  if (scenario === "source_label") {
    const relatedCaseId = parseCaseId(
      `case_gmail_${rawAccount}_case_context_collection_related`,
    );
    if (!relatedCaseId.ok) throw new Error(relatedCaseId.error.code);
    const relatedCase = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId,
      caseId: relatedCaseId.value,
      now,
    });
    if (!relatedCase.ok) throw new Error(relatedCase.error.code);
    await runInDurableObject(
      relatedCase.value,
      restrictCaseContextCollectionSourceLabel.bind(null, privateAuthority),
    );
  }
  const scope: CaseContextCollectionScope = {
    organisationId,
    merchantId,
    party: { kind: "supplier", id: target.supplierId },
    issueKind: "delivery_delay",
    issueInstance: "PR-842-delivery",
  };
  await runInDurableObject(
    organisation,
    seedReplyCaseContextCollection.bind(null, scope, rawAccount, now),
  );
  const policy = replyCaseContextDiscoveryPolicy(rawAccount);
  expect(
    await organisation.publishCaseContextDiscoveryConfiguration({
      organisationId,
      actorId: owner.identity.userId,
      body: { commandId: "publish_reply", expectedRevision: 0, policy },
    }),
  ).toMatchObject({ ok: true, value: { revision: 1 } });
  if (scenario === "metadata") {
    await verifyCaseContextCollectionInspector(context, owner, fixture, organisation, state);
    return;
  }
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      state.model.bind(state),
    ),
  );
  network.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      state.read.bind(state),
    ),
  );
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      state.write.bind(state),
    ),
  );
  network.use(
    http.delete(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      state.remove.bind(state),
    ),
  );
  if (scenario === "mailbox_settings") {
    await verifyDraftsAcrossMailboxSettings({
      context,
      organisationId,
      owner,
      account: account.value,
      rawAccount,
      connector: connector.value,
      fixture,
      state,
    });
    return;
  }
  const supplierMemory =
    scenario === "memory" || scenario === "sources"
      ? await seedSupplierMemory({
          organisation,
          organisationId,
          rawAccount,
          merchantId,
          supplierId: target.supplierId,
        })
      : null;
  const outcome = await runInDurableObject(
    connector.value,
    executeDraftTurn.bind(null, fixture),
  );
  if (scenario === "source_label") {
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "email_evidence_admission_denied" },
    });
    expect(state.modelCalls).toBe(0);
    expect(state.draftCreates).toBe(0);
    expect(state.sends).toBe(0);
    await context.annotate(
      JSON.stringify({
        scenario,
        confirmedLink: true,
        originalPrivateLabelPreserved: true,
        modelCalls: state.modelCalls,
        visibleDrafts: state.draftCreates,
        sends: state.sends,
      }),
      "plan46-e2-evidence",
    );
    return;
  }
  if (scenario === "lost_draft")
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "gmail_unavailable" },
    });
  else
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      ok: true,
      value: { kind: "proposed", acknowledgement: "sent" },
    });
  expect(state.modelInputs.join("\n")).toContain(
    "AUTHORIZED_DELIVERY_FACT: PR-842 arrives Friday",
  );
  expect(state.modelInputs.join("\n")).not.toContain("FOREIGN_CUSTOMER_SECRET");
  expect(state.modelInputs.join("\n")).not.toContain("MERCHANT_PRIVATE_MARGIN");
  expect(state.foreignReads).toBe(0);
  const proposalId = `proposal_${fixture.caseId}_case_context_collection_anchor_message`;
  const protectedFlow = await runInDurableObject(
    connector.value,
    inspectCaseContextCollectionProposalFlow.bind(null, proposalId),
  );
  expect(protectedFlow).toMatchObject({
    dependency: { kind: "case_context_collection_evidence", caseContextCollectionRevision: 2 },
    binding: {
      flowLabel: {
        policies: expect.arrayContaining([
          expect.objectContaining({
            owner: expect.objectContaining({ kind: "recipient_constraint" }),
          }),
        ]),
      },
    },
  });
  if (scenario === "learning_live") {
    await verifySupplierReplyCorrection({
      organisationId,
      owner,
      account: account.value,
      connector: connector.value,
      connectorId: connectorId.value,
      fixture,
      state,
      proposalId,
      merchantId,
      supplierId: target.supplierId,
      liveLearning: context,
    });
    return;
  }
  if (scenario === "evals" || scenario === "evals_live") {
    await verifySupplierEvalRuns({
      context,
      live: scenario === "evals_live",
      organisationId,
      owner,
      account: account.value,
      connector: connector.value,
      connectorId: connectorId.value,
      state,
      correction: await verifySupplierReplyCorrection({
        organisationId,
        owner,
        account: account.value,
        connector: connector.value,
        connectorId: connectorId.value,
        fixture,
        state,
        proposalId,
        merchantId,
        supplierId: target.supplierId,
      }),
    });
    return;
  }
  if (scenario === "sources" && supplierMemory !== null) {
    await verifyReplySources({
      context,
      organisationId,
      owner,
      account: account.value,
      rawAccount,
      connector: connector.value,
      state,
      supplierMemory,
      merchantId,
      correction: await verifySupplierReplyCorrection({
        organisationId,
        owner,
        account: account.value,
        connector: connector.value,
        connectorId: connectorId.value,
        fixture,
        state,
        proposalId,
        merchantId,
        supplierId: target.supplierId,
      }),
    });
    return;
  }
  if (supplierMemory !== null) {
    const correction = await verifySupplierReplyCorrection({
      organisationId,
      owner,
      account: account.value,
      connector: connector.value,
      connectorId: connectorId.value,
      fixture,
      state,
      proposalId,
      merchantId,
      supplierId: target.supplierId,
    });
    const admission = await verifySupplierAdmissionBinding({
      organisationId,
      account: account.value,
      rawAccount,
      connector: connector.value,
      state,
      supplierMemory,
    });
    await verifySupplierMemoryTurn({
      context,
      organisation,
      organisationId,
      owner,
      admission,
      account: account.value,
      fixture,
      state,
      protectedFlow,
      supplierMemory,
      correction,
      rawAccount,
      connector: connector.value,
      supplierId: target.supplierId,
    });
    return;
  }
  if (scenario === "lost_draft") {
    expect(
      await runInDurableObject(
        connector.value,
        repeatCaseContextCollectionDraftClaim.bind(null, proposalId),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "email_draft_creation_indeterminate" },
    });
    expect(
      await organisation.eraseCaseContextCollectionSource({
        organisationId,
        selection: caseContextCollectionReplySelection(organisationId, rawAccount, "related", now),
      }),
    ).toMatchObject({ ok: true });
    await evictDurableObject(organisation);
    await evictDurableObject(connector.value);
    await runDurableObjectAlarm(organisation);
    await runDurableObjectAlarm(connector.value);
    expect(state.drafts.size).toBe(0);
    expect(state.draftCreates).toBe(1);
    expect(state.sends).toBe(0);
    await context.annotate(
      JSON.stringify({
        scenario,
        acceptedDraftRecoveredByExactMessageId: true,
        deletedAfterSourceErasure: true,
        draftCreates: state.draftCreates,
        sends: state.sends,
      }),
      "plan46-e2-evidence",
    );
    return;
  }
  const preview = await runInDurableObject(
    connector.value,
    previewCaseContextCollectionReply.bind(null, proposalId),
  );
  expect(preview).toMatchObject({ ok: true, value: { kind: "current" } });
  await runInDurableObject(
    connector.value,
    denyContaminatedCaseContextCollectionReply.bind(null, proposalId, fixture),
  );
  let attempt: CaseContextCollectionEffectAttempt | null = null;
  if (scenario === "accepted_send") {
    state.loseSendResponse = true;
    const interrupted = await runInDurableObject(
      connector.value,
      dispatchCaseContextCollectionReply.bind(null, proposalId, preview),
    );
    expect(interrupted).toMatchObject({
      ok: true,
      value: { kind: "send_indeterminate" },
    });
    attempt = await runInDurableObject(
      connector.value,
      readCaseContextCollectionSendAttempt.bind(null, proposalId),
    );
    expect(
      await organisation.commitCaseContextCollectionEffectFence({ organisationId, attempt }),
    ).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(
      await organisation.reviewCaseContextCollectionRelationship({
        organisationId,
        actorId: owner.identity.userId,
        caseContextCollectionId: "case_context_collection_supplier_reply",
        body: {
          commandId: "detach_case_context_collection",
          expectedRevision: 2,
          decision: {
            kind: "detach",
            relationshipId: "relationship_supplier_reply",
          },
        },
      }),
    ).toMatchObject({ ok: true, value: { revision: 3 } });
  } else {
    // Gmail deletes the selected related source after the preview. The send
    // passes the Organisation's evidence checks, reads the source again from
    // Gmail, erases it in the Organisation and is refused.
    state.relatedSourceDeleted = true;
  }
  await evictDurableObject(organisation);
  await evictDurableObject(connector.value);
  const stale = await runInDurableObject(
    connector.value,
    dispatchCaseContextCollectionReply.bind(null, proposalId, preview),
  );
  if (scenario !== "accepted_send") {
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "case_context_collection_evidence_stale" },
    });
    expect(state.sends).toBe(1);
    const beforeCleanup = await runInDurableObject(
      connector.value,
      previewCaseContextCollectionReply.bind(null, proposalId),
    );
    expect(beforeCleanup).toMatchObject({
      ok: false,
      error: { code: "case_context_collection_evidence_stale" },
    });
    await runDurableObjectAlarm(organisation);
    await runDurableObjectAlarm(connector.value);
    expect(state.drafts.size).toBe(1);
  } else {
    expect(stale).toMatchObject({
      ok: true,
      value: { kind: "sent", providerMessageId: "sent_case_context_collection_2" },
    });
    expect(state.sends).toBe(2);
    if (attempt === null) throw new Error("Missing exact send attempt");
    expect(
      await organisation.commitCaseContextCollectionEffectFence({ organisationId, attempt }),
    ).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(
      await organisation.commitCaseContextCollectionEffectFence({
        organisationId,
        attempt: { ...attempt, contentDigest: "f".repeat(64) },
      }),
    ).toMatchObject({ ok: false, error: { code: "case_context_collection_effect_conflict" } });
    expect(
      await runInDurableObject(
        connector.value,
        dispatchCaseContextCollectionReply.bind(null, proposalId, preview),
      ),
    ).toMatchObject({ ok: true, value: { kind: "sent" } });
    expect(state.sends).toBe(2);
  }
  await context.annotate(
    JSON.stringify({
      scenario,
      caseContextCollectionRevision: 2,
      correctedRevision: scenario === "accepted_send" ? 3 : null,
      relatedEvidenceObserved: true,
      foreignProviderReads: state.foreignReads,
      staleReplyDenied: scenario === "provider_erasure",
      sends: state.sends,
      protectedReplySends: scenario === "accepted_send" ? 1 : 0,
      contaminatedSurfacesDenied: ["draft", "preview", "send"],
      providerRestore: "native Actor eviction",
    }),
    "plan46-e2-evidence",
  );
}

async function verifyCaseContextCollectionInspector(
  context: TestContext,
  owner: Awaited<ReturnType<typeof client>>,
  fixture: DraftTurnFixture,
  organisation: DurableObjectStub<OrganisationDO>,
  provider: CaseContextCollectionReplyProvider,
): Promise<void> {
  const organisationIdentity = parseOrganisationId(fixture.organisationId);
  if (!organisationIdentity.ok) throw new Error(organisationIdentity.error.code);
  const base = `/v1/control/organisations/${fixture.organisationId}/case-context-discovery`;
  const caseContextCollectionPath = `${base}/caseContextCollections/case_context_collection_supplier_reply`;
  const casePath = `${base}/cases/${fixture.caseId}`;
  expect((await caseContextCollectionInspectorRequest(owner.session, casePath)).status).toBe(
    200,
  );
  expect(
    parseCaseContextCollectionMetadataResponse(
      await (await caseContextCollectionInspectorRequest(owner.session, casePath)).json(),
    ),
  ).toEqual([]);
  expect(
    (await caseContextCollectionInspectorRequest(owner.session, caseContextCollectionPath)).status,
  ).toBe(404);
  expect(
    await createAccessGrant({
      db: fixtureDatabase(),
      organisationId: organisationIdentity.value,
      grantId: "grant_case_context_collection_inspector",
      now: Date.now(),
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "platform_capability",
        capabilityId: CAPABILITY_KEYS.caseContextCollectionMetadataRead,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "case-context-collection-inspector-e2e",
      },
    }),
  ).toMatchObject({ ok: true });
  const label = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: fixtureDatabase(),
    organisationId: organisationIdentity.value,
    integrationAccountId: fixture.integrationAccountId,
    capabilityId: CAPABILITY_KEYS.emailMailboxRead,
    resourceScope: "mailbox",
    grantIds: ["grant_mail_case-context-collection-reply"],
  });
  if (!label.ok) throw new Error(label.error.code);
  // Model an accepted archive whose original source readers include the operator.
  for (const part of ["anchor", "related"]) {
    const caseId = parseCaseId(
      `case_gmail_${fixture.integrationAccountId}_case_context_collection_${part}`,
    );
    if (!caseId.ok) throw new Error(caseId.error.code);
    const actor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: organisationIdentity.value,
      caseId: caseId.value,
      now: Date.now(),
    });
    if (!actor.ok) throw new Error(actor.error.code);
    await runInDurableObject(
      actor.value,
      seedInspectorSourceLabel.bind(null, part, label.value.toJSON()),
    );
  }
  const visible = parseCaseContextCollectionMetadataResponse(
    await (await caseContextCollectionInspectorRequest(owner.session, caseContextCollectionPath)).json(),
  );
  expect(visible).toMatchObject([
    {
      revision: 2,
      issueInstance: "PR-842-delivery",
      relationships: [{ kind: "attached" }],
    },
  ]);
  const operatorRead = await exports.default.fetch(
    new Request(`https://localhost${caseContextCollectionPath}`, {
      headers: { authorization: "Bearer organisation-admin-e2e-token-000000000000" },
    }),
  );
  expect(operatorRead.status).toBe(404);
  const caseId = parseCaseId(fixture.caseId);
  if (!caseId.ok) throw new Error(caseId.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: organisationIdentity.value,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const reference = await opaqueCaseReference(
    organisationIdentity.value,
    caseId.value,
  );
  const inspectorPath = `${base}/inspector?case_ref=${reference}&revision=${snapshot.value.revision}`;
  expect(
    parseCaseContextCollectionMetadataResponse(
      await (
        await caseContextCollectionInspectorRequest(owner.session, inspectorPath)
      ).json(),
    ),
  ).toEqual(visible);
  const secondSession = await issueControlSession({
    db: env.DB,
    userId: owner.identity.userId,
    now: Date.now(),
    ttlMs: 1800000,
  });
  const body = {
    commandId: "inspector_detach",
    expectedRevision: 2,
    decision: { kind: "detach", relationshipId: "relationship_supplier_reply" },
  };
  const reviewPath = `${caseContextCollectionPath}/review`;
  const reviewed = await caseContextCollectionInspectorRequest(
    owner.session,
    reviewPath,
    body,
  );
  expect(reviewed.status, await reviewed.clone().text()).toBe(200);
  const receipt: unknown = await reviewed.json();
  await evictDurableObject(organisation);
  expect(
    await (
      await caseContextCollectionInspectorRequest(owner.session, reviewPath, body)
    ).json(),
  ).toEqual(receipt);
  const stale = await caseContextCollectionInspectorRequest(secondSession, reviewPath, {
    ...body,
    commandId: "inspector_stale",
  });
  expect(stale.status).toBe(409);
  expect(
    parseCaseContextCollectionMetadataResponse(
      await (await caseContextCollectionInspectorRequest(owner.session, caseContextCollectionPath)).json(),
    ),
  ).toMatchObject([{ revision: 3, relationships: [{ kind: "detached" }] }]);
  expect(
    await revokeAccessGrant({
      db: fixtureDatabase(),
      organisationId: organisationIdentity.value,
      grantId: "grant_mail_case-context-collection-reply",
      expectedRevision: 1,
      reason: "Inspector source revoked",
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true });
  expect(
    parseCaseContextCollectionMetadataResponse(
      await (await caseContextCollectionInspectorRequest(owner.session, casePath)).json(),
    ),
  ).toEqual([]);
  expect(
    (await caseContextCollectionInspectorRequest(owner.session, caseContextCollectionPath)).status,
  ).toBe(404);
  expect(
    (await caseContextCollectionInspectorRequest(secondSession, reviewPath, body)).status,
  ).toBe(404);
  expect(
    await organisation.readCaseContextCollection({
      organisationId: organisationIdentity.value,
      caseContextCollectionId: "case_context_collection_supplier_reply",
    }),
  ).toMatchObject({ ok: true, value: { revision: 3 } });
  expect(provider.modelCalls).toBe(0);
  expect(provider.sends).toBe(0);
  await context.annotate(
    JSON.stringify({
      missingMetadataGrant: "hidden",
      retainedMailboxOnlyLabel: "hidden",
      authorizedArchive: "visible",
      opaqueInspector: "same projection",
      reviewReceiptAfterEviction: "replayed",
      staleSecondSession: "conflict",
      revokedSource: "existence and review hidden",
      modelCalls: provider.modelCalls,
      sends: provider.sends,
    }),
    "plan46-inspector-evidence",
  );
}

function seedInspectorSourceLabel(
  part: string,
  label: unknown,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE case_journal SET flow_label_json = ? WHERE entry_id = ?",
    JSON.stringify(label),
    `trigger:trigger_email_case_context_collection_${part}_message`,
  );
}

function caseContextCollectionInspectorRequest(
  session: IssuedControlSession,
  path: string,
  body: Record<string, unknown> | null = null,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://localhost${path}`, {
      method: body === null ? "GET" : "POST",
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: "https://localhost",
        "x-satyr-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function repeatCaseContextCollectionDraftClaim(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  const row = state.storage.sql
    .exec<{
      request_digest: string;
      rfc_message_id: string;
      expires_at: number;
    }>(
      "SELECT request_digest, rfc_message_id, expires_at FROM email_case_context_collection_draft_attempt WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("Missing unknown draft claim");
  return claimEmailCaseContextCollectionDraft(
    state.storage.sql,
    proposalId,
    row.request_digest,
    row.rfc_message_id,
    row.expires_at,
  );
}

async function seedPrivateCaseContextCollectionNote(
  organisationId: OrganisationId,
  userId: string,
  rawCaseId: string,
): Promise<Extract<RequestAuthority, { kind: "control" }>> {
  const membership = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId,
  });
  const person = await fixtureDatabase().prepare(
    "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(organisationId, userId)
    .first<{ personId: string }>();
  const caseId = parseCaseId(rawCaseId);
  if (membership === null || person === null || !caseId.ok)
    throw new Error("Missing private note authority");
  const actor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  const authority = buildControlAuthority({
    organisationId,
    userId,
    membershipRevision: membership,
    requesterPersonId: person.personId,
    role: "owner",
  }).requestAuthority;
  expect(
    await actor.value.acceptTrigger({
      triggerId: "trigger_merchant_private",
      caseId: caseId.value,
      source: { kind: "api", commandId: "command_merchant_private" },
      requestAuthority: authority,
      content: {
        kind: "text",
        text: "MERCHANT_PRIVATE_MARGIN: our gross margin is 79 percent",
      },
      acceptedAt: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { kind: "accepted" } });
  return authority;
}

async function restrictCaseContextCollectionSourceLabel(
  authority: Extract<RequestAuthority, { kind: "control" }>,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const row = state.storage.sql
    .exec<{ flow_label_json: string }>(
      "SELECT flow_label_json FROM case_journal WHERE entry_id = 'trigger:trigger_email_case_context_collection_related_message'",
    )
    .toArray()[0];
  if (row === undefined) throw new Error("Missing original source label");
  const original = await FlowLabel.restore(JSON.parse(row.flow_label_json));
  if (!original.ok) throw new Error(original.error.code);
  const narrowed = await FlowLabel.create([
    ...original.value.policies,
    {
      owner: { kind: "organisation", organisationId: authority.organisationId },
      readers: [sourceReaderForAuthority(authority)],
    },
  ]);
  if (!narrowed.ok) throw new Error(narrowed.error.code);
  state.storage.sql.exec(
    "UPDATE case_journal SET flow_label_json = ? WHERE entry_id = 'trigger:trigger_email_case_context_collection_related_message'",
    JSON.stringify(narrowed.value.toJSON()),
  );
}

function seedCaseContextCollectionRuntime(
  input: DraftTurnFixture,
  actor: unknown,
  state: DurableObjectState,
): void {
  seedDraftRuntime(input, actor, state);
  const owner = {
    kind: "cue",
    messageId: "case_context_collection_anchor_message",
    threadId: "case_context_collection_anchor",
  };
  state.storage.sql.exec(
    "INSERT INTO mail_response_owner (message_id, body, phase) VALUES (?, ?, 'cue')",
    owner.messageId,
    JSON.stringify(owner),
  );
}

function seedReplyCaseContextCollection(
  scope: CaseContextCollectionScope,
  accountId: string,
  now: number,
  _actor: unknown,
  state: DurableObjectState,
): void {
  const selection = caseContextCollectionReplySelection(
    scope.organisationId,
    accountId,
    "related",
    now,
  );
  expect(
    recordCaseContextCollectionSuggestion({
      sql: state.storage.sql,
      transaction: state.storage.transactionSync.bind(state.storage),
      organisationId: scope.organisationId,
      commandId: "suggest_reply",
      requestDigest: "a".repeat(64),
      caseContextCollectionId: "case_context_collection_supplier_reply",
      relationshipId: "relationship_supplier_reply",
      expectedRevision: 0,
      scope,
      sourceScope: scope,
      anchorSelection: caseContextCollectionReplySelection(
        scope.organisationId,
        accountId,
        "anchor",
        now,
      ),
      selection,
      evaluationId: "evaluation_reply",
      outcome: "same_issue",
      confidence: 1,
      expiresAt: now + 3600000,
      now,
    }),
  ).toMatchObject({ ok: true });
  expect(
    decideCaseContextCollectionRelationship({
      sql: state.storage.sql,
      transaction: state.storage.transactionSync.bind(state.storage),
      organisationId: scope.organisationId,
      commandId: "confirm_reply",
      requestDigest: "b".repeat(64),
      caseContextCollectionId: "case_context_collection_supplier_reply",
      expectedRevision: 1,
      actorId: "synthetic-admin",
      now,
      decision: {
        kind: "confirm",
        relationshipId: "relationship_supplier_reply",
        sourceScope: scope,
      },
    }),
  ).toMatchObject({ ok: true });
}

function replyCaseContextDiscoveryPolicy(accountId: string) {
  const parsed = parseCaseContextDiscoveryPolicy({
    mode: "party_context",
    route: {
      provider: "typesafe",
      funding: "organisation_byo",
      credentialRef: "organisation_typesafe",
      connectionRevision: 1,
    },
    sources: [{ source: "gmail", integrationAccountId: accountId }],
    limits: {
      maxEvaluations: 20,
      maxInputTokens: 327680,
      maxConcurrentEvaluations: 1,
      maxInputBytes: 122880,
      maxWallMs: 50000,
      maxCostMicrousd: 50000,
      reservationMicrousd: 10000,
      requestTimeoutMs: 10000,
    },
  });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function caseContextCollectionReplySelection(
  _organisationId: OrganisationId,
  accountId: string,
  part: string,
  now: number,
): import("../../src/case-context-discovery/relationships").CaseContextCollectionSelection {
  return {
    caseId: `case_gmail_${accountId}_case_context_collection_${part}`,
    source: "gmail",
    integrationAccountId: accountId,
    reference: `case_context_collection_${part}_message`,
    sourceRevision: now,
    verificationId: "verification_case_context_collection",
    verificationRevision: 1,
  };
}
function inspectCaseContextCollectionProposalFlow(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  return readEmailProposalFlow(state.storage.sql, proposalId);
}
async function previewCaseContextCollectionReply(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  const runtime = readEmailRuntime(state.storage.sql);
  if (runtime === null) throw new Error("Missing CaseContextCollection reply runtime");
  const organisationId = parseOrganisationId(runtime.organisationId);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  const scope = await requireMailFixtureScope(organisationId.value);

  return previewEmailProposal({
    env,
    scope,
    sql: state.storage.sql,
    proposalId,
    now: Date.now(),
    fetcher: fetch,
  });
}
async function dispatchCaseContextCollectionReply(
  proposalId: string,
  preview: Awaited<ReturnType<typeof previewEmailProposal>>,
  _actor: unknown,
  state: DurableObjectState,
) {
  const runtime = readEmailRuntime(state.storage.sql);
  if (runtime === null) throw new Error("Missing CaseContextCollection reply runtime");
  const organisationId = parseOrganisationId(runtime.organisationId);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  const scope = await requireMailFixtureScope(organisationId.value);

  if (!preview.ok || preview.value.kind !== "current")
    throw new Error("Missing accepted preview");
  return dispatchEmailReply({
    env,
    scope,
    sql: state.storage.sql,
    proposalId,
    approvedVersion: preview.value.preview.currentVersion,
    approvedSnapshotDigest: preview.value.preview.snapshotDigest,
    now: Date.now(),
    fetcher: fetch,
  });
}

async function denyContaminatedCaseContextCollectionReply(
  proposalId: string,
  fixture: DraftTurnFixture,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const organisationId = parseOrganisationId(fixture.organisationId);
  const accountId = parseIntegrationAccountId(fixture.integrationAccountId);
  if (!organisationId.ok || !accountId.ok) throw new Error("Invalid mailbox fixture");
  const stored = readEmailProposalFlow(state.storage.sql, proposalId);
  if (stored === null || stored.dependency.kind !== "case_context_collection_evidence")
    throw new Error("Missing CaseContextCollection flow");
  const binding = await FlowBinding.restore(stored.binding);
  if (!binding.ok) throw new Error(binding.error.code);
  const contaminants: readonly FlowPolicyInput[] = [
    {
      // Another person's private content. Internal content from elsewhere
      // may go out, because a person reads each reply before it leaves.
      owner: { kind: "organisation", organisationId: fixture.organisationId },
      readers: [{ kind: "person", personId: "person_foreign" }],
    },
    {
      owner: {
        kind: "recipient_constraint",
        organisationId: fixture.organisationId,
        recipient: {
          organisationId: fixture.organisationId,
          merchantId: stored.dependency.recipient.merchantId,
          integrationAccountId: fixture.integrationAccountId,
          partyKind: "customer",
          partyId: "foreign_customer",
          contactId: "foreign_contact",
          contactRevision: 1,
          verificationId: "foreign_verification",
          verificationRevision: 1,
          endpointDigest: "f".repeat(64),
          purpose: "customer_reply",
        },
      },
      readers: [
        {
          kind: "agent_mailbox",
          integrationAccountId: fixture.integrationAccountId,
          mailboxBindingId: fixture.mailboxBindingId,
          bindingRevision: fixture.bindingRevision,
        },
      ],
    },
  ];
  for (const contaminant of contaminants) {
    const contaminatedProposalId = `proposal_contaminated_${contaminant.owner.kind}`;
    const label = await FlowLabel.create([
      ...binding.value.flowLabel.policies,
      contaminant,
    ]);
    if (!label.ok) throw new Error(label.error.code);
    const context = await InformationFlowContext.fromState({
      organisationId: binding.value.organisationId,
      sessionId: binding.value.sessionId,
      authorityPartitionDigest: binding.value.authorityPartitionDigest,
      workLabel: label.value,
      observationDigests: [],
      revision: binding.value.contextRevision + 1,
    });
    if (!context.ok) throw new Error(context.error.code);
    const contaminated = FlowBinding.fromContext(
      context.value,
      binding.value.turnId,
    );
    const restored = await FlowBinding.restore(contaminated.toJSON());
    if (!restored.ok) throw new Error(restored.error.code);
    expect(
      recordEmailProposalFlow(
        state.storage.sql,
        contaminatedProposalId,
        stored.dependency,
        restored.value.toJSON(),
      ),
    ).toMatchObject({ ok: true });
    for (const surface of ["draft", "preview", "send"] as const) {
      expect(
        await authorizeEmailProposalFlow({
          env,
          sql: state.storage.sql,
          proposalId: contaminatedProposalId,
          authority: buildAgentMailboxAuthority({
            organisationId: organisationId.value,
            integrationAccountId: accountId.value,
            mailboxBindingId: fixture.mailboxBindingId,
            bindingRevision: fixture.bindingRevision,
            mailboxPolicyVersion: fixture.policyVersion,
          }).requestAuthority,
          surface,
          to: "supplier@example.test",
          approvalSatisfied: true,
          caseId: fixture.caseId,
          triggeringMessageId: fixture.messageIds.at(-1) ?? "",
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "email_disclosure_denied" },
      });
    }
  }
}

async function readCaseContextCollectionSendAttempt(
  proposalId: string,
  _actor: unknown,
  state: DurableObjectState,
): Promise<CaseContextCollectionEffectAttempt> {
  const flow = readEmailProposalFlow(state.storage.sql, proposalId);
  const operation = latestEmailDraftOperation(state.storage.sql, proposalId);
  if (
    flow === null ||
    flow.dependency.kind !== "case_context_collection_evidence" ||
    operation === null
  )
    throw new Error("Missing protected operation");
  const binding = await FlowBinding.restore(flow.binding);
  if (!binding.ok) throw new Error(binding.error.code);
  return {
    attemptId: `${proposalId}.${operation.version}.send`,
    caseId: operation.caseId,
    proposalId,
    proposalVersion: operation.version,
    effect: "send",
    targetDigest: operation.targetDigest,
    contentDigest: operation.bodyDigest,
    flowBindingDigest: await digestFlowBinding(binding.value),
    dependency: flow.dependency,
    expiresAt: operation.expiresAt,
  };
}

function isMessageIdHeader(line: string): boolean {
  return line.startsWith("Message-ID: ");
}
async function caseContextCollectionConnectionProbe({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const raw: unknown = await request.json();
  if (!isRecord(raw) || !isRecord(raw.questions))
    throw new Error("Missing connection questions");
  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(raw.questions))
    answers[key] = { type: "noul", noul: 1 };
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 10, output_tokens: 1, cost: 0 },
  });
}

const SUPPLIER_MEMORY_FACT =
  "MEMORY_SUPPLIER_FACT: this supplier confirmed PR-842 arrives Friday.";
const PRIVATE_MEMORY_FACT =
  "MEMORY_PRIVATE_NOTE: ask this supplier for a discount.";
const OTHER_SUPPLIER_MEMORY_FACT =
  "MEMORY_OTHER_SUPPLIER_FACT: another supplier delivers on Mondays.";

const MEMORY_REVIEWERS = { kind: "organisation_role", role: "admin" } as const;

type SupplierMemoryFixture = Awaited<ReturnType<typeof seedSupplierMemory>>;

/**
 * Accepted Memory about the verified supplier, learned from that supplier's
 * earlier email. The agent proposal path and Portal review of mailbox Memory
 * are not built, so the Actor commands stand in for both.
 */
async function seedSupplierMemory(
  input: Readonly<{
    organisation: OrganisationActorStub;
    organisationId: OrganisationId;
    rawAccount: string;
    merchantId: string;
    supplierId: string;
  }>,
) {
  const relatedCaseId = parseCaseId(
    `case_gmail_${input.rawAccount}_case_context_collection_related`,
  );
  if (!relatedCaseId.ok) throw new Error(relatedCaseId.error.code);
  const relatedCase = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: input.organisationId,
    caseId: relatedCaseId.value,
    now: Date.now(),
  });
  if (!relatedCase.ok) throw new Error(relatedCase.error.code);
  // The supplier's earlier email, as its Case recorded it.
  const entryId =
    "trigger:trigger_email_case_context_collection_related_message";
  const email = await relatedCase.value.readMetadata({
    organisationId: input.organisationId,
    caseId: relatedCaseId.value,
    entryId,
  });
  if (!email.ok) throw new Error(email.error.code);
  const evidence = {
    kind: "case_observation",
    caseId: relatedCaseId.value,
    entryId,
    digest: email.value.contentDigest,
  } as const;
  const supplier = (entityId: string): MemoryContent["applicability"] => ({
    kind: "commerce_entity",
    merchantId: input.merchantId,
    entity: parseEntityRef({
      origin: "custom",
      typeId: SUPPLIER_ENTITY_TYPE_ID,
      entityId,
    }),
  });
  const privateLabel = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: input.organisationId },
      readers: [{ kind: "person", personId: "person_memory_private" }],
    },
  ]);
  if (!privateLabel.ok) throw new Error(privateLabel.error.code);
  // The shared Memory was reviewed by administrators, so its label joins the
  // supplier email's label with a clause naming them beside the mailbox. No
  // other source in this turn carries that clause.
  const emailLabel = await FlowLabel.restore(email.value.inputLabel);
  if (!emailLabel.ok) throw new Error(emailLabel.error.code);
  const reviewClause = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: input.organisationId },
      readers: [
        ...emailLabel.value.policies.flatMap((policy) => policy.readers),
        MEMORY_REVIEWERS,
      ],
    },
  ]);
  if (!reviewClause.ok) throw new Error(reviewClause.error.code);
  const reviewedLabel = await joinFlowLabels(
    emailLabel.value,
    reviewClause.value,
  );
  if (!reviewedLabel.ok) throw new Error(reviewedLabel.error.code);
  const proposed = async (
    name: string,
    statement: string,
    applicability: MemoryContent["applicability"],
    flowLabel: unknown,
    cited: MemoryContent["evidence"][number] = evidence,
  ): Promise<string> => {
    const candidate = await input.organisation.commandMemory({
      organisationId: input.organisationId,
      principal: {
        kind: "agent",
        caseId: relatedCaseId.value,
        assignmentId: "assignment_supplier_memory",
        sessionId: "session_supplier_memory",
      },
      body: {
        commandId: `supplier_memory_propose_${name}`,
        expectedRevision: 0,
        kind: "propose",
        memoryId: null,
        submission: "own_input",
        content: {
          memoryKind: "fact",
          statement,
          applicability,
          validity: {
            timezone: "Australia/Sydney",
            effectiveFrom: "2026-01-01",
            effectiveUntil: null,
            dependsOn: [cited],
          },
          evidence: [cited],
          sourceCaseId: relatedCaseId.value,
        },
      } satisfies MemoryCommand,
      flowLabel,
    });
    if (!candidate.ok) throw new Error(JSON.stringify(candidate.error));
    return candidate.value.memoryId;
  };
  const accepted = async (
    ...candidate: Parameters<typeof proposed>
  ): Promise<string> => {
    const memoryId = await proposed(...candidate);
    const decided = await input.organisation.commandMemory({
      organisationId: input.organisationId,
      principal: { kind: "operator", personId: "person_memory_reviewer" },
      body: {
        commandId: `supplier_memory_accept_${candidate[0]}`,
        expectedRevision: 1,
        kind: "accept",
        memoryId,
        revision: 1,
      } satisfies MemoryCommand,
      flowLabel: null,
    });
    if (!decided.ok) throw new Error(JSON.stringify(decided.error));
    return memoryId;
  };
  return {
    proposed,
    accepted,
    supplierScope: supplier(input.supplierId),
    relatedCaseId: relatedCaseId.value,
    // Carries the supplier email's label and the reviewers' clause.
    shared: await accepted(
      "shared",
      SUPPLIER_MEMORY_FACT,
      supplier(input.supplierId),
      canonicalFlowLabel(reviewedLabel.value),
    ),
    // Readable by one person only; a reply on the mailbox cannot carry it.
    privateNote: await accepted(
      "private",
      PRIVATE_MEMORY_FACT,
      supplier(input.supplierId),
      canonicalFlowLabel(privateLabel.value),
    ),
    otherSupplier: await accepted(
      "other",
      OTHER_SUPPLIER_MEMORY_FACT,
      supplier("supplier_unrelated"),
      email.value.inputLabel,
    ),
  };
}

function memoryRequest(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  body: MemoryCommand | null,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${organisationId}/memories${body === null ? "" : "/commands"}`,
      {
        method: body === null ? "GET" : "POST",
        headers: {
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          origin: "https://localhost",
          "content-type": "application/json",
          "x-satyr-csrf": session.csrfToken,
        },
        body: body === null ? null : JSON.stringify(body),
      },
    ),
  );
}

async function memoryCommand(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  body: MemoryCommand,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await memoryRequest(organisationId, session, body);
  return { status: response.status, body: await response.json() };
}

/** The Memory identities this person's Portal lists. */
async function listedMemories(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<readonly string[]> {
  const response = await memoryRequest(organisationId, session, null);
  const raw: unknown = await response.json();
  if (response.status !== 200 || !isRecord(raw) || !Array.isArray(raw.memories))
    throw new Error(JSON.stringify(raw));
  return raw.memories.map((memory: { memoryId: string }) => memory.memoryId);
}

const LEARNED_FACT =
  "Next-day orders close at noon. Changes after noon are refused.";
/** The Memory that the sources journey's reply cites, learned from a correction. */
const SOURCES_MEMORY_FACT = "Orders for this supplier ship on Fridays.";
const SOURCES_ORDER_WORDS = "Your order order_1042 is confirmed.";
const SOURCES_MEMORY_WORDS = "We ship it on Friday.";
const SOURCES_REPLY = `${SOURCES_ORDER_WORDS} It holds two Ginger financier boxes. ${SOURCES_MEMORY_WORDS}`;
/** The reply after the operator removes the order's sentence. */
const SOURCES_EDITED_REPLY = `It holds two Ginger financier boxes. ${SOURCES_MEMORY_WORDS}`;
/** The message the synthetic agent writes as a test of what it learned. */
const LEARNED_CHECK = {
  subject: "Change to tomorrow's order",
  body: "Please add ten cases of butter to tomorrow's delivery.",
};
const FOLLOW_UP_REPLY =
  "Tomorrow's order closed at noon, so we cannot change it now.";
const ACKNOWLEDGEMENT =
  "Thanks for your email. We've received your message and will get back to you shortly.";
const LONG_CORRECTION_MARK = "LONG-CORRECTION";
const RESTART_CORRECTION =
  "RESTART-CORRECTION We deliver to this address on Tuesdays only.";
const RESTART_FACT = "Deliveries to this supplier's address are on Tuesdays.";
/** The reply sent at once to one message of the automatic thread. */
/** The reply that an unverified sender's message makes the agent choose. */
const STRANGER_REPLY = "Confirmed: we send the refund today.";

function automaticReply(messageId: string): string {
  return `Received. Your delivery slot is confirmed. Reference ${messageId}.`;
}
/** A corrected reply longer than a mailbox turn's whole prompt budget. */
const LONG_CORRECTION =
  `${LONG_CORRECTION_MARK} ${"We confirm the standing delivery terms for this order. ".repeat(240)}`.trim();
const CORRECTED_REPLY =
  "We cannot change tomorrow's order: orders for the next day close at noon.";

/**
 * An operator corrects the drafted reply on the review surface. The Connector
 * records the correction against the exact version it produced, with the
 * body digests, the editor and the proposal's own binding. An edit made on
 * top of a change in Gmail has no such record.
 */
async function verifySupplierReplyCorrection(
  input: Readonly<{
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    account: IntegrationAccountId;
    connector: DurableObjectStub<
      import("../../src/actors/connector").ConnectorDO
    >;
    connectorId: ConnectorId;
    fixture: DraftTurnFixture;
    state: CaseContextCollectionReplyProvider;
    proposalId: string;
    merchantId: string;
    supplierId: string;
    /** The real model runs the learning turn, and the journey ends there. */
    liveLearning?: TestContext;
  }>,
) {
  const { organisationId, owner, proposalId, state } = input;
  state.liveLearning = input.liveLearning !== undefined;
  network.use(
    http.put(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/:draftId",
      state.update.bind(state),
    ),
  );
  const review = () =>
    reviewSend(organisationId, owner.session, proposalId, null, {}).then(
      reviewSnapshot,
    );
  const correctionOf = (version: number) =>
    input.connector.readEmailReplyCorrection({
      identity: { organisationId, connectorId: input.connectorId },
      proposalId,
      version,
      now: Date.now(),
    });
  const editor = await fixtureDatabase().prepare(
    "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(organisationId, owner.identity.userId)
    .first<{ personId: string }>();
  const drafted = await review();
  expect(drafted.version).toBe(1);
  // This reply drew on no commerce record, so reviewing it rests on the
  // operator's mailbox grant alone.
  expect(
    await runInDurableObject(
      input.connector,
      inspectPurchasingEvidence.bind(null, proposalId),
    ),
  ).toEqual([]);
  expect(await correctionOf(1)).toEqual({ ok: true, value: null });
  expect(
    await reviewResult(
      await reviewSend(organisationId, owner.session, proposalId, "edit", {
        ...drafted,
        body: CORRECTED_REPLY,
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 2 });
  const recorded = await correctionOf(2);
  if (!recorded.ok || recorded.value === null)
    throw new Error(JSON.stringify(recorded));
  const { flowBindingJson, ...correction } = recorded.value;
  expect(correction).toMatchObject({
    proposalId,
    version: 2,
    caseId: input.fixture.caseId,
    correctedVersion: 1,
    bodyDigest: await digestEmailBody(CORRECTED_REPLY),
    editorPersonId: editor?.personId,
  });
  expect(correction.correctedBodyDigest).not.toBe(correction.bodyDigest);
  // The record carries the proposal's binding, recipient constraint included.
  expect(JSON.parse(flowBindingJson)).toEqual(
    await runInDurableObject(
      input.connector,
      inspectCaseContextCollectionProposalFlow.bind(null, proposalId),
    ).then((flow) => flow?.binding),
  );
  const evidence = {
    kind: "proposal_correction",
    caseId: input.fixture.caseId,
    integrationAccountId: input.account,
    proposalId,
    version: 2,
    digest: correction.bodyDigest,
  } as const;
  const cite = (
    commandId: string,
    cited: Extract<
      MemoryContent["evidence"][number],
      { kind: "proposal_correction" }
    >,
  ) =>
    memoryCommand(organisationId, owner.session, {
      commandId,
      expectedRevision: 0,
      kind: "propose",
      memoryId: null,
      submission: "own_input",
      content: {
        memoryKind: "fact",
        statement: "Next-day orders for this supplier close at noon.",
        applicability: {
          kind: "commerce_entity",
          merchantId: input.merchantId,
          entity: parseEntityRef({
            origin: "custom",
            typeId: SUPPLIER_ENTITY_TYPE_ID,
            entityId: input.supplierId,
          }),
        },
        validity: {
          timezone: "Australia/Sydney",
          effectiveFrom: "2026-10-01",
          effectiveUntil: null,
          dependsOn: [cited],
        },
        evidence: [cited],
        sourceCaseId: cited.caseId,
      },
    });
  // The operator may review this mailbox's replies, so on that review
  // surface they may read the correction and cite it. Their own words are
  // private input, so this candidate is theirs alone. A version that does
  // not exist and a body the Connector never recorded are refused alike.
  const cited = await cite("supplier_correction_cite", evidence);
  expect(cited, JSON.stringify(cited)).toMatchObject({
    status: 200,
    body: { receipt: { revision: 1, state: "candidate" } },
  });
  const refused = {
    status: 404,
    body: { ok: false, error: "memory_unavailable" },
  };
  expect(
    await cite("supplier_correction_other_body", {
      ...evidence,
      digest: correction.correctedBodyDigest,
    }),
  ).toEqual(refused);
  expect(
    await cite("supplier_correction_no_version", { ...evidence, version: 3 }),
  ).toEqual(refused);
  // The mailbox agent learns from the recorded correction in its own turn,
  // which the Connector's alarm runs. It reads the thread, is given the
  // corrected reply with its request, and proposes one candidate for the
  // verified supplier. The candidate cites the exact correction. The edit
  // armed that alarm, so the journey waits for the candidate.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const learnedFrom = async () => {
    const stored = await organisation.readMemories({ organisationId });
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    return stored.value.filter((memory) =>
      memory.revisions.some(
        (revision) =>
          revision.proposedBy.kind === "agent" &&
          revision.evidence.some(
            (cited) =>
              cited.kind === "proposal_correction" &&
              cited.proposalId === proposalId &&
              cited.version === 2,
          ),
      ),
    );
  };
  if (input.liveLearning !== undefined) {
    // The real model reads the thread and the corrected reply. It may
    // propose one Memory with a test message, or it may decline. The journey
    // waits until the Connector holds no learning work.
    await expect
      .poll(
        () =>
          runInDurableObject(
            input.connector,
            (_actor: unknown, durable: DurableObjectState) =>
              nextEmailCorrectionLearningAt(durable.storage.sql),
          ),
        { timeout: 180_000, interval: 1_000 },
      )
      .toBeNull();
    const proposed = await learnedFrom();
    const revision = proposed[0]?.revisions[0];
    const opened = parseEvalListResponse(
      await (await evalRequest(organisationId, owner.session, "", null)).json(),
    );
    // The record is kept before any check.
    Object.assign(input.liveLearning.task.meta, {
      liveLearning: JSON.parse(
        JSON.stringify({
          substituted: [
            "Gmail",
            "Underclerk supplier records",
            "the reply turn before the correction",
          ],
          real: ["model provider (OpenRouter), for the learning turn"],
          correctedReply: CORRECTED_REPLY,
          modelRequests: state.liveLearningAnswers,
          proposed:
            revision === undefined
              ? null
              : {
                  kind: revision.kind,
                  memoryKind: revision.memoryKind,
                  statement: revision.statement,
                  applicability: revision.applicability,
                  validity: revision.validity,
                },
          checks: opened.map((entry) =>
            entry.revisions.map((candidate) => candidate.scenarios),
          ),
        }),
      ),
    });
    expect(state.liveLearningAnswers.length).toBeGreaterThan(0);
    expect(state.liveLearningAnswers.map((answer) => answer.status)).toEqual(
      state.liveLearningAnswers.map(() => 200),
    );
    // At most one candidate, and what a real model proposed is held to the
    // same bounds as the synthetic one: the verified supplier, the exact
    // correction as its evidence, and a candidate that waits for review.
    expect(proposed.length).toBeLessThanOrEqual(1);
    if (revision !== undefined)
      expect(revision).toMatchObject({
        kind: "candidate",
        evidence: [evidence],
        validity: { dependsOn: [evidence] },
        applicability: {
          kind: "commerce_entity",
          merchantId: input.merchantId,
          entity: { entityId: input.supplierId },
        },
        proposedBy: { kind: "agent", caseId: input.fixture.caseId },
      });
    return {
      evidence,
      correction,
      label: JSON.parse(flowBindingJson).flowLabel as unknown,
      learned: {
        memoryId: proposed[0]?.memoryId ?? "",
        statement: revision?.statement,
        proposedBy: revision?.proposedBy,
        modelRequests: state.learningInputs.length,
      },
      portalCitation: cited,
      unrecordedCitation: refused,
      unrecordedVersions: [],
    };
  }
  await expect
    .poll(async () => (await learnedFrom()).length, { timeout: 20_000 })
    .toBe(1);
  const learned = await learnedFrom();
  expect(state.learningInputs).toHaveLength(3);
  expect(state.learningInputs[0]).toContain(CORRECTED_REPLY);
  const candidate = learned[0]?.revisions[0];
  expect(candidate).toMatchObject({
    kind: "candidate",
    statement: LEARNED_FACT,
    evidence: [evidence],
    validity: { dependsOn: [evidence] },
    applicability: {
      kind: "commerce_entity",
      merchantId: input.merchantId,
      entity: { entityId: input.supplierId },
    },
    proposedBy: {
      kind: "agent",
      caseId: input.fixture.caseId,
      assignmentId: `assignment_${input.fixture.caseId}_${input.fixture.messageIds.at(-1)}_learn_2`,
    },
  });
  // The candidate carries the proposal's label, recipient constraint
  // included, so it reaches no reader the corrected draft could not reach.
  expect(candidate?.flowLabel.policies).toEqual(
    expect.arrayContaining(
      (
        JSON.parse(flowBindingJson) as {
          flowLabel: { policies: unknown[] };
        }
      ).flowLabel.policies,
    ),
  );
  // Processing the same correction again proposes nothing new and asks the
  // model nothing: the Case already settled that assignment.
  await runInDurableObject(
    input.connector,
    (_actor: unknown, durable: DurableObjectState) => {
      recordEmailCorrectionLearning(durable.storage.sql, {
        proposalId,
        version: 2,
        now: Date.now(),
      });
      return durable.storage.setAlarm(Date.now());
    },
  );
  await expect
    .poll(
      () =>
        runInDurableObject(
          input.connector,
          (_actor: unknown, durable: DurableObjectState) =>
            nextEmailCorrectionLearningAt(durable.storage.sql),
        ),
      { timeout: 20_000 },
    )
    .toBeNull();
  expect(state.learningInputs).toHaveLength(3);
  expect((await learnedFrom()).map((memory) => memory.memoryId)).toEqual(
    learned.map((memory) => memory.memoryId),
  );
  // The draft is then changed in Gmail, where no editor is on record. The
  // reviewed edit that follows is saved as the next version. Neither is
  // recorded as a correction, because the words under it cannot be attributed.
  const [draftId, encoded] = [...state.drafts][0] ?? ["", ""];
  const [headers] = decodeRaw(encoded).split("\r\n\r\n");
  state.drafts.set(
    draftId,
    encodeBase64Url(
      new TextEncoder().encode(
        `${headers}\r\n\r\n${btoa("Changed in Gmail outside review.")}`,
      ),
    ),
  );
  const changedInGmail = await review();
  expect(changedInGmail.version).toBe(3);
  expect(
    await reviewResult(
      await reviewSend(organisationId, owner.session, proposalId, "edit", {
        ...changedInGmail,
        body: `${CORRECTED_REPLY} Please confirm.`,
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 4 });
  expect(await correctionOf(3)).toEqual({ ok: true, value: null });
  expect(await correctionOf(4)).toEqual({ ok: true, value: null });
  // An edit that records no correction gives the agent nothing to learn
  // from: no learning turn is queued and the model is not asked.
  expect(
    await runInDurableObject(
      input.connector,
      (_actor: unknown, durable: DurableObjectState) =>
        nextEmailCorrectionLearningAt(durable.storage.sql),
    ),
  ).toBeNull();
  expect(state.learningInputs).toHaveLength(3);
  return {
    evidence,
    correction,
    label: JSON.parse(flowBindingJson).flowLabel as unknown,
    learned: {
      memoryId: learned[0]?.memoryId ?? "",
      statement: candidate?.statement,
      proposedBy: candidate?.proposedBy,
      modelRequests: state.learningInputs.length,
    },
    portalCitation: cited,
    unrecordedCitation: refused,
    unrecordedVersions: [3, 4],
  };
}

const EVAL_CANDIDATE_FACT =
  "Next-day orders close at 2 pm. Changes after 2 pm are refused.";
const EVAL_ESCALATION =
  "This change is after the cutoff, so I have asked the team to confirm it.";
const EVAL_CONFIRMATION = "Confirmed. We will add it to tomorrow's order.";
const EVAL_OTHER_VERIFICATION = "verification_eval_other_supplier";

/**
 * An Eval turn is asked what a turn for arrived mail is asked. The journey
 * tells the two apart by the admitted message: the message of an Eval has an
 * identity in Gmail's form, and no mail of these journeys has one.
 */
const EVAL_TURN_MESSAGE =
  /Admitted message ids \(oldest first\): ([0-9a-f]{16})\./u;

/** The hold that stops the first model request of the nth Eval turn. */
function evalTurn(ordinal: number): string {
  return `eval turn ${String(ordinal)}`;
}

/** What the synthetic agent does with one scenario, from what it was shown. */
type EvalAgentChoice = Readonly<{
  tool: "email_reply_now" | "email_reply_for_approval";
  body: string;
}>;

/**
 * What the synthetic agent does with one scenario. It answers as the Memory
 * it was shown says: a change at or after the cutoff that Memory states goes
 * to a person, and anything else is confirmed. Both synthetic transports use
 * it, so both routes are given the same agent.
 */
function evalAgentChoice(shown: string): EvalAgentChoice {
  const cutoff = shown.includes("close at 2 pm")
    ? 14
    : shown.includes("close at noon")
      ? 12
      : null;
  const hour = Number(
    /(\d{2}):\d{2} \(Australia\/Sydney\)/u.exec(shown)?.[1] ?? "NaN",
  );
  return cutoff !== null && hour >= cutoff
    ? { tool: "email_reply_for_approval", body: EVAL_ESCALATION }
    : { tool: "email_reply_now", body: EVAL_CONFIRMATION };
}

/** The subscription route's agent: the same choices, through ChatGPT. */
function evalSubscriptionAnswer(
  starts: string[],
  request: ChatGptModelRequest,
): ChatGptAnswer {
  const text = JSON.stringify(request.body);
  const outputs = toolOutputs(request);
  if (outputs.length === 0) {
    starts.push(text);
    return {
      kind: "tool_call",
      name: "read_email_case",
      arguments: {},
      callId: "eval_case",
    };
  }
  if (outputs.length > 1) return textAnswer("Settled.");
  const choice = evalAgentChoice(text);
  return {
    kind: "tool_call",
    name: choice.tool,
    arguments:
      choice.tool === "email_reply_for_approval"
        ? { body: choice.body, sources: null }
        : { body: choice.body },
    callId: "eval_choice",
  };
}

function evalRequest(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${organisationId}/evals${path}`,
      {
        method: body === null ? "GET" : "POST",
        headers: {
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          origin: "https://localhost",
          "content-type": "application/json",
          "x-satyr-csrf": session.csrfToken,
        },
        body: body === null ? null : JSON.stringify(body),
      },
    ),
  );
}

/** Brings the eval tasks the Connector holds due now, as passing time does. */
async function wakeForEvalTasks(_actor: unknown, state: DurableObjectState) {
  state.storage.sql.exec(
    "UPDATE connector_eval_task SET available_at = 0 WHERE state != 'settled'",
  );
  await state.storage.setAlarm(Date.now());
}

/** The Subject header of the fixture's mail, which titles its Case. */
const MAIL_SUBJECT = "PR-842 delivery";

/** The Cases of the last week on one person's Activity timeline. */
async function timelineCases(
  organisationId: OrganisationId,
  session: Awaited<ReturnType<typeof client>>["session"],
): Promise<readonly CaseTimelineCase[]> {
  const read = await readCaseTimeline(organisationId, session, {
    from: Date.now() - 6 * 86_400_000,
    to: Date.now() + 60_000,
  });
  expect(read.status).toBe(200);
  return read.timeline?.cases ?? [];
}

/**
 * Makes a person a member of the organisation's default Project. Provisioning
 * does this for the organisation's owner.
 */
function joinDefaultProject(
  organisationId: OrganisationId,
  userId: string,
  role: "owner" | "viewer",
) {
  return fixtureDatabase().prepare(
    `INSERT OR IGNORE INTO project_member (organisation_id, project_id, user_id, role)
     SELECT organisation_id, project_id, ?, ?
     FROM organisation_default_project WHERE organisation_id = ?`,
  )
    .bind(userId, role, organisationId)
    .run();
}

/**
 * What an operator reads of Memory for a mail turn, in the execution read of
 * the mail Case.
 *
 * A mail turn keeps no turn record. Its Session records the context it gave
 * the turn, and the read shows the turn from that record: with the Memory
 * result, and with no state and no start. The turn hangs from the assignment
 * its context names, and the proposal that names the turn hangs from it. A
 * person who may review the mailbox's replies reads the result: its kind and
 * the count of revisions, and no Memory identity or text. A member who may
 * not review them reads what came from the mailbox, which belongs to the
 * whole Organisation: the email's trigger with its subject, and the reply
 * proposal (Plan 27C). The owner's private instruction in the Case, and all
 * work that followed it, stay withheld from them, and the withheld turn
 * carries its kind and nothing else.
 */
async function verifyMailTurnMemoryExecution(
  input: Readonly<{
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    caseId: string;
    sessionId: string;
    turnId: string;
    /** The revisions the Session's own record says the model was given. */
    shown: readonly Readonly<{ memoryId: string; revision: number }>[];
    /** Memory text that the read must not hold. */
    statements: readonly string[];
  }>,
) {
  const { organisationId, owner, caseId } = input;
  await joinDefaultProject(organisationId, owner.identity.userId, "owner");
  const reviewer = await readCaseExecution(
    organisationId,
    owner.session,
    caseId,
    100,
  );
  const turn = openNodes(reviewer, "turn").find(
    (candidate) => candidate.turnId === input.turnId,
  );
  if (turn === undefined)
    throw new Error(`mail turn missing: ${JSON.stringify(reviewer.nodes)}`);
  // The email's subject names the Case, on its trigger and on the Activity
  // timeline, for a person who may review the mailbox.
  expect(openNodes(reviewer, "trigger").map((node) => node.title)).toContain(
    MAIL_SUBJECT,
  );
  const reviewerEvent = (
    await timelineCases(organisationId, owner.session)
  ).find((event) => event.caseId === caseId);
  expect(reviewerEvent?.title).toBe(MAIL_SUBJECT);
  expect(turn).toEqual({
    nodeId: turn.nodeId,
    access: "open",
    kind: "turn",
    sessionId: input.sessionId,
    turnId: input.turnId,
    state: "unrecorded",
    startedAt: null,
    failureCode: null,
    memory: { kind: "admitted", revisions: input.shown.length },
  });
  // The recorded links of the turn: the assignment its context names, and
  // the proposal that names the turn.
  expect(incoming(reviewer, turn.nodeId)).toEqual(["assignment:assignment"]);
  const assignment = openNodes(reviewer, "assignment").find(
    (candidate) => candidate.sessionId === input.sessionId,
  );
  expect(
    reviewer.edges
      .filter((edge) => edge.to === turn.nodeId)
      .map((edge) => edge.from),
  ).toEqual([assignment?.nodeId]);
  const made = reviewer.edges
    .filter((edge) => edge.from === turn.nodeId)
    .map((edge) => ({
      basis: edge.basis,
      to: openNodes(reviewer, "proposal").find(
        (proposal) => proposal.nodeId === edge.to,
      )?.proposalKind,
    }));
  expect(made).toEqual([{ basis: "turn", to: "observation" }]);
  const detail = await readCaseExecutionDetail(
    organisationId,
    owner.session,
    caseId,
    turn.nodeId,
  );
  expect(detail.detail).toEqual({
    caseId,
    node: turn,
    content: [],
    context: [],
  });
  const read = JSON.stringify([reviewer.nodes, detail]);
  for (const hidden of [
    ...input.shown.map((revision) => revision.memoryId),
    ...input.statements,
  ])
    expect(read).not.toContain(hidden);

  // An administrator who may not review this mailbox's replies.
  const member = await client("mail-turn-memory-member");
  await fixtureDatabase().prepare(
    "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_mail_turn_member', 'Project member')",
  )
    .bind(organisationId)
    .run();
  await fixtureDatabase().prepare(
    "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_mail_turn_member', 'admin', 'active', ?, NULL)",
  )
    .bind(organisationId, member.identity.userId, Date.now())
    .run();
  await joinDefaultProject(organisationId, member.identity.userId, "viewer");
  const restricted = await readCaseExecution(
    organisationId,
    member.session,
    caseId,
    100,
  );
  expect(restricted.nodes).toEqual(memberViewOfMailCase(reviewer.nodes));
  expect(restricted.edges).toEqual(reviewer.edges);
  expect(JSON.stringify(restricted)).not.toContain(input.turnId);
  // The member's timeline names the Case with the email's subject.
  const memberTimeline = await timelineCases(organisationId, member.session);
  expect(memberTimeline.find((event) => event.caseId === caseId)?.title).toBe(
    MAIL_SUBJECT,
  );
  const refused = await readCaseExecutionDetail(
    organisationId,
    member.session,
    caseId,
    turn.nodeId,
  );
  expect(refused).toEqual({ status: 404, detail: null });
  return {
    caseId,
    reviewer: {
      shape: executionShape(reviewer),
      turns: openNodes(reviewer, "turn"),
      turnLinks: { from: incoming(reviewer, turn.nodeId), to: made },
      limitations: reviewer.limitations,
    },
    reviewerTimelineTitle: reviewerEvent?.title ?? null,
    memberTimelineTitle:
      memberTimeline.find((event) => event.caseId === caseId)?.title ?? null,
    memberWithoutReview: {
      ...executionShape(restricted),
      turn: restricted.nodes.find((node) => node.nodeId === turn.nodeId),
      turnDetail: refused.status,
    },
  };
}

/**
 * What a member who may not review the mailbox reads of a mail Case (Plan
 * 27C): what came from the mailbox, which belongs to the whole Organisation,
 * that is the email's trigger and the reply proposal. The owner's private
 * instruction in the Case, and all work that followed it, stay withheld.
 */
function memberViewOfMailCase(
  nodes: readonly CaseExecutionNode[],
): CaseExecutionNode[] {
  return nodes.map((node) =>
    node.access === "open" &&
    ((node.kind === "trigger" && node.title === MAIL_SUBJECT) ||
      (node.kind === "proposal" && node.proposalKind === "mail_reply"))
      ? node
      : { nodeId: node.nodeId, kind: node.kind, access: "withheld" },
  );
}

/**
 * The execution projection of a mail Case and of an Eval run's Case.
 *
 * A person who may review the mailbox's replies reads the mail Case in the
 * open, through the same review authorization that shows them the reply. The
 * reply turn and the learning turn are each one assignment. The learning
 * assignment was given what the reply turn proposed. The mail reply proposal
 * names no turn and no tool call, so it has no edge, and the read says so. A
 * mail turn keeps no turn record. Its Session records the context it gave
 * the turn, and the read shows the turn from that record, with its Memory
 * result and no state. The proposal that names the turn hangs from it.
 *
 * A member who may not review those replies, with no seat in the Case's
 * Project, reads what came from the mailbox (`memberViewOfMailCase`). An
 * Eval run's Case is shape only for everyone here: its records carry the
 * Eval's label, which the Portal rule does not open.
 */
async function verifyMailCaseExecution(
  input: Readonly<{
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    stranger: Awaited<ReturnType<typeof client>>;
    mailCaseId: string;
    evalCaseId: string;
    evalAssignments: number;
  }>,
) {
  const { organisationId, owner, stranger } = input;
  // Provisioning makes the organisation's owner a member of its default
  // Project. This fixture does the same.
  await joinDefaultProject(organisationId, owner.identity.userId, "owner");
  const mail = await readCaseExecution(
    organisationId,
    owner.session,
    input.mailCaseId,
    100,
  );
  expect(mail.nodes.map((node) => node.access)).toEqual(
    mail.nodes.map(() => "open"),
  );
  const assignments = openNodes(mail, "assignment");
  const proposals = openNodes(mail, "proposal");
  expect(executionShape(mail).open).toEqual({
    trigger: 2,
    assignment: 2,
    turn: 2,
    proposal: 3,
    delivery: 2,
  });
  expect(
    proposals.map((proposal) => [
      proposal.proposalKind,
      proposal.state,
      incoming(mail, proposal.nodeId),
    ]),
  ).toEqual([
    ["observation", "accepted", ["turn:turn"]],
    ["observation", "accepted", ["turn:turn"]],
    ["mail_reply", "awaiting_approval", []],
  ]);
  // Each assignment has the one turn that its Session recorded a context
  // for. No Memory was accepted when these two turns ran.
  const turns = openNodes(mail, "turn");
  expect(
    turns.map((turn) => [
      turn.sessionId,
      turn.state,
      turn.memory,
      incoming(mail, turn.nodeId),
    ]),
  ).toEqual(
    assignments.map((assignment) => [
      assignment.sessionId,
      "unrecorded",
      { kind: "none" },
      ["assignment:assignment"],
    ]),
  );
  expect(
    assignments.map((assignment) => incoming(mail, assignment.nodeId)),
  ).toEqual([
    ["context_entry:trigger", "context_entry:trigger"],
    ["context_entry:proposal"],
  ]);
  expect(mail.limitations).toEqual([
    "delivery_attempts_unrecorded",
    "mail_proposal_origin_unrecorded",
  ]);
  const elsewhere = await readCaseExecution(
    organisationId,
    stranger.session,
    input.mailCaseId,
    100,
  );
  expect(elsewhere.nodes).toEqual(memberViewOfMailCase(mail.nodes));
  expect(elsewhere.edges).toEqual(mail.edges);
  const run = await readCaseExecution(
    organisationId,
    owner.session,
    input.evalCaseId,
    100,
  );
  expect(executionShape(run)).toMatchObject({
    open: {},
    withheld: {
      assignment: input.evalAssignments,
      proposal: input.evalAssignments,
    },
  });
  return {
    mailCase: {
      caseId: input.mailCaseId,
      reviewer: {
        shape: executionShape(mail),
        nodes: mail.nodes,
        edges: mail.edges,
        limitations: mail.limitations,
      },
      memberWithoutReview: executionShape(elsewhere),
    },
    evalRunCase: {
      caseId: input.evalCaseId,
      shape: executionShape(run),
      pages: run.pages,
    },
  };
}

/**
 * The correction becomes a reviewed Eval, and a candidate replacement of the
 * learned Memory is compared with the accepted revision on its scenarios.
 *
 * The run is one Case with one assignment for each scenario under each
 * configuration on each inference authority that could run it. A route with
 * no credential ends its tasks as unavailable, with no verdict. The candidate
 * is seen only inside the run. A turn stopped with its Actors ends its task
 * as indeterminate and is not run again. The passing candidate is then
 * accepted through the Memory command, and the revision it replaces names it.
 */
async function verifySupplierEvalRuns(
  input: Readonly<{
    context: TestContext;
    /** The real model answers the Eval turns, on the platform route only. */
    live: boolean;
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    account: IntegrationAccountId;
    connector: FollowUpInput["connector"];
    connectorId: ConnectorId;
    state: CaseContextCollectionReplyProvider;
    correction: Awaited<ReturnType<typeof verifySupplierReplyCorrection>>;
  }>,
): Promise<void> {
  const { organisationId, owner, state, correction } = input;
  const now = Date.now();
  const memoryId = correction.learned.memoryId;
  const send = async (
    session: IssuedControlSession,
    path: string,
    body: unknown,
  ) => {
    const response = await evalRequest(organisationId, session, path, body);
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const memoryStates = async () => {
    // The journey stops the Organisation's instance during a run, and a stub
    // to a stopped instance stays broken. Each read finds the active one.
    const current = await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    });
    const stored = await current.readMemories({ organisationId });
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    const memory = stored.value.find((entry) => entry.memoryId === memoryId);
    if (memory === undefined) throw new Error("learned Memory missing");
    return memory.revisions;
  };

  // The operator accepts what the agent learned, then proposes a replacement
  // that moves the cutoff. The accepted revision stays in force.
  expect(
    await memoryCommand(organisationId, owner.session, {
      commandId: "eval_memory_accept",
      expectedRevision: 1,
      kind: "accept",
      memoryId,
      revision: 1,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "accepted" } } });
  const accepted = (await memoryStates())[0];
  if (accepted === undefined || accepted.proposedBy.kind !== "agent")
    throw new Error("learned revision missing");
  expect(
    await memoryCommand(organisationId, owner.session, {
      commandId: "eval_memory_replace",
      expectedRevision: 1,
      kind: "propose",
      memoryId,
      submission: "shared_review",
      content: {
        memoryKind: accepted.memoryKind,
        statement: EVAL_CANDIDATE_FACT,
        applicability: accepted.applicability,
        validity: accepted.validity,
        evidence: accepted.evidence,
        sourceCaseId: accepted.sourceCaseId,
      },
    }),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, state: "candidate" } },
  });

  // A second supplier's contact is verified on the same mailbox, for the
  // control that the lesson must leave alone.
  const other = {
    kind: "supplier_contact" as const,
    supplierId: "supplier_eval_other",
    contactId: "contact_eval_other",
    contactRevision: 1,
  };
  expect(
    await registerOperationalEmailContact({
      db: fixtureDatabase(),
      organisationId,
      target: other,
      address: "other-supplier@example.test",
      displayName: "Other synthetic supplier",
      state: "active",
      relationshipState: "active",
      now,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await publishContactVerification({
      db: fixtureDatabase(),
      organisationId,
      actorId: owner.identity.userId,
      now,
      command: {
        kind: "verify",
        commandId: "verify_eval_other_supplier",
        verificationId: EVAL_OTHER_VERIFICATION,
        expectedRevision: 0,
        integrationAccountId: input.account,
        target: other,
        endpoint: { channel: "gmail", address: "other-supplier@example.test" },
        evidenceRef: "synthetic:verified-other-supplier",
      },
    }),
  ).toMatchObject({ ok: true });

  // The organisation also holds a ChatGPT subscription that mailbox
  // inference may use. Its selected authority stays the platform route. On
  // the subscription, Pi asks the ChatGPT backend; each turn reads its
  // scenario, chooses once and settles, as on the platform route.
  const chatgpt = new FakeChatGpt();
  const subscriptionStarts: string[] = [];
  chatgpt.answer = evalSubscriptionAnswer.bind(null, subscriptionStarts);
  chatgpt.install();
  await signInToChatGpt(chatgpt, {
    organisationId,
    userId: owner.identity.userId,
    reconnect: false,
  });
  const subscription = await resolveOrganisationModelRouteForSelection({
    env,
    scope: await requireMailFixtureScope(organisationId),
    now,
    selection: { kind: "codex_subscription" },
  });
  if (!subscription.ok) throw new Error(subscription.error.code);
  await fixtureDatabase().prepare(
    "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'eval-runs-e2e', 'synthetic-reviewer', 'openai', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
  )
    .bind(
      organisationId,
      subscription.value.keySource,
      subscription.value.provider,
      subscription.value.model,
      now,
      now + 3_600_000,
      now,
    )
    .run();

  // Sydney is eleven hours ahead of UTC on the scenario's date.
  const scenario = (
    scenarioId: string,
    role: EvalScenario["role"],
    title: string,
    sydney: readonly [number, number],
    verificationId: string,
    criteria: EvalScenario["criteria"],
  ): EvalScenario => ({
    scenarioId,
    role,
    title,
    sender: { verificationId, revision: 1 },
    message: {
      subject: "Change to tomorrow's order",
      body: "Please add ten cases of butter to tomorrow's delivery.",
      receivedAt: Date.UTC(2026, 9, 12, sydney[0] - 11, sydney[1]),
      timezone: "Australia/Sydney",
    },
    criteria,
  });
  const supplier = "verification_case_context_collection";
  const answers = {
    criterionId: "answers",
    kind: "outcome",
    expected: "reply_now",
  } as const;
  const late = scenario(
    "late_change",
    "target",
    "Order change after the cutoff",
    [15, 30],
    supplier,
    [
      {
        criterionId: "escalates",
        kind: "outcome",
        expected: "approval_required",
      },
      // A real model words its reply as it likes, so the live run does not
      // hold it to one word.
      ...(input.live
        ? []
        : [
            {
              criterionId: "names_cutoff",
              kind: "reply_includes",
              text: "cutoff",
            } as const,
          ]),
    ],
  );
  const reviewed = [
    late,
    scenario(
      "midday_change",
      "target",
      "Order change before the corrected cutoff",
      [13, 0],
      supplier,
      [answers],
    ),
    scenario(
      "early_change",
      "control",
      "Order change in the morning",
      [9, 30],
      supplier,
      [answers],
    ),
    scenario(
      "other_supplier",
      "control",
      "The same request from another supplier",
      [15, 30],
      EVAL_OTHER_VERIFICATION,
      [
        answers,
        { criterionId: "no_cutoff", kind: "reply_excludes", text: "cutoff" },
      ],
    ),
  ];
  const content = (scenarios: readonly EvalScenario[]): EvalContent => ({
    title: "Next-day order cutoff",
    subject: { kind: "mailbox_reply", integrationAccountId: input.account },
    scenarios,
    evidence: [correction.evidence],
    sourceCaseId: correction.evidence.caseId,
  });
  // Pantry opened the Eval in the learning turn, beside the Memory, from the
  // same corrected reply. It holds the one message the agent wrote as a test,
  // from the supplier whose reply was corrected, and it expects only that a
  // person is asked. It waits for review like the Memory.
  const opened = parseEvalListResponse(
    (await send(owner.session, "", null)).body,
  );
  expect(opened).toMatchObject([
    {
      headRevision: 1,
      revisions: [
        {
          revision: 1,
          kind: "candidate",
          proposedBy: accepted.proposedBy,
          subject: {
            kind: "mailbox_reply",
            integrationAccountId: input.account,
          },
          evidence: [correction.evidence],
          sourceCaseId: correction.evidence.caseId,
          scenarios: [
            {
              scenarioId: "corrected_request",
              role: "target",
              sender: { verificationId: supplier, revision: 1 },
              message: { ...LEARNED_CHECK, timezone: "UTC" },
              criteria: [
                {
                  criterionId: "asks_for_approval",
                  kind: "outcome",
                  expected: "approval_required",
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  expect(opened).toHaveLength(1);
  const evalId = opened[0]?.evalId;
  if (evalId === undefined) throw new Error("the agent's Eval is missing");

  // The scenario editor offers the contacts whose verification stands for
  // this mailbox. The owner reviews the Eval, so both are listed, each with
  // the exact verification revision that a scenario names.
  const senders = await send(owner.session, `/${evalId}/contacts`, null);
  expect(senders.status, JSON.stringify(senders.body)).toBe(200);
  const choices = parseEvalSenderChoicesResponse(senders.body);
  expect(choices).toHaveLength(2);
  expect(choices).toContainEqual({
    verificationId: EVAL_OTHER_VERIFICATION,
    revision: 1,
    address: "other-supplier@example.test",
  });
  expect(
    choices.find((choice) => choice.verificationId === supplier),
  ).toMatchObject({ revision: 1 });

  // The operator adds a second target and the two controls, and accepts the
  // criteria. Criteria that no person has accepted are not run.
  expect(
    await send(owner.session, "/commands", {
      commandId: "eval_supplier_revise",
      evalId,
      expectedRevision: 1,
      kind: "revise",
      content: content(reviewed),
    }),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, state: "candidate" } },
  });
  const candidate = {
    kind: "candidate",
    memory: { memoryId, revision: 2 },
  } as const;
  const start = (
    commandId: string,
    routes: readonly EvalRoute[],
    configurations: readonly EvalConfiguration[],
  ) =>
    send(owner.session, "/runs", {
      commandId,
      kind: "start",
      eval: { evalId, revision: 2 },
      routes,
      configurations,
    });
  expect(
    await start(
      "eval_run_unreviewed",
      ["satyr_platform"],
      [{ kind: "current" }],
    ),
  ).toMatchObject({ status: 409, body: { error: "eval_conflict" } });
  expect(
    await send(owner.session, "/commands", {
      commandId: "eval_supplier_accept",
      evalId,
      expectedRevision: 2,
      kind: "accept",
      revision: 2,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "accepted" } } });

  const receiptOf = (started: Readonly<{ status: number; body: unknown }>) => {
    const receipt =
      started.status === 200 && isRecord(started.body)
        ? parseEvalRunCommandReceipt(started.body.receipt)
        : null;
    if (receipt === null) throw new Error(JSON.stringify(started));
    return receipt;
  };
  const runs = async () =>
    parseEvalRunListResponse(
      (await send(owner.session, `/${evalId}/runs`, null)).body,
    );
  const settledRun = async (runId: string): Promise<EvalRunResult | null> => {
    const run = (await runs()).find((entry) => entry.runId === runId);
    return run !== undefined && isSettledEvalRun(run) ? run : null;
  };
  const assignmentsOf = async (rawCaseId: string) => {
    const caseId = parseCaseId(rawCaseId);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const caseActor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId,
      caseId: caseId.value,
      now: Date.now(),
    });
    if (!caseActor.ok) throw new Error(caseActor.error.code);
    const snapshot = await caseActor.value.inspect();
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    return snapshot.value.assignmentLifecycles.map((lifecycle) => ({
      assignmentId: lifecycle.assignment.assignmentId,
      sessionId: lifecycle.assignment.sessionId,
      end:
        lifecycle.kind !== "settled"
          ? lifecycle.kind
          : lifecycle.disposition.kind === "failed"
            ? `failed:${lifecycle.disposition.code}`
            : lifecycle.disposition.kind,
    }));
  };
  const ended = (task: EvalTaskResult | null): string => {
    if (task === null) return "absent";
    const { outcome } = task;
    switch (outcome.kind) {
      case "assessed":
        return outcome.verdict;
      case "unavailable":
        return `unavailable:${outcome.reason}`;
      case "failed":
      case "indeterminate":
        return `${outcome.kind}:${outcome.code}`;
      case "cancelled":
        return "cancelled";
      default:
        return assertNever(outcome);
    }
  };

  if (input.live) {
    // The real model answers each task on the platform route. One run is one
    // Case with one assignment for each scenario and configuration. A model
    // does not answer the same way each time, so the run is made three times.
    const liveBefore = { sends: state.sends, drafts: state.draftCreates };
    state.liveEvals = true;
    const trials: {
      trial: number;
      caseId: string;
      run: EvalRunResult;
      assignments: Awaited<ReturnType<typeof assignmentsOf>>;
    }[] = [];
    for (const trial of [1, 2, 3]) {
      const live = receiptOf(
        await start(
          `eval_run_live_${String(trial)}`,
          ["satyr_platform"],
          [{ kind: "current" }, candidate],
        ),
      );
      await expect
        .poll(async () => (await settledRun(live.runId)) !== null, {
          timeout: 150_000,
          interval: 1_000,
        })
        .toBe(true);
      const run = await settledRun(live.runId);
      if (run === null) throw new Error("live run missing");
      trials.push({
        trial,
        caseId: live.caseId,
        run,
        assignments: await assignmentsOf(live.caseId),
      });
    }
    // What the model did, counted over the trials: how each scenario ended
    // under each configuration, and how many replies state a cutoff time.
    const statesCutoff = (reply: string | null): boolean =>
      reply !== null &&
      /\bnoon\b|\b12\s?(?:pm|:00)|\b2\s?pm\b|\b14:00/iu.test(reply);
    const observed: Record<string, Record<string, number>> = {};
    const cutoffStated: Record<string, number> = {};
    for (const { run } of trials)
      for (const task of run.tasks) {
        const key = `${task.scenarioId}.${task.configuration}`;
        const how =
          task.outcome.kind === "assessed"
            ? task.outcome.observation.outcome
            : ended(task);
        const counts = (observed[key] ??= {});
        counts[how] = (counts[how] ?? 0) + 1;
        if (
          task.outcome.kind === "assessed" &&
          statesCutoff(task.outcome.observation.reply)
        )
          cutoffStated[key] = (cutoffStated[key] ?? 0) + 1;
      }
    // The record is kept before any check, so a run that fails a check still
    // shows what the model did.
    Object.assign(input.context.task.meta, {
      liveEvalRun: JSON.parse(
        JSON.stringify({
          substituted: [
            "Gmail",
            "Underclerk supplier records",
            "the turns before the runs (reply, correction and learning)",
          ],
          real: ["model provider (OpenRouter), for each Eval turn"],
          route: "satyr_platform",
          memory: { accepted: LEARNED_FACT, candidate: EVAL_CANDIDATE_FACT },
          modelRequests: {
            count: state.liveEvalAnswers.length,
            statuses: [
              ...new Set(state.liveEvalAnswers.map((answer) => answer.status)),
            ],
            models: [
              ...new Set(state.liveEvalAnswers.map((answer) => answer.model)),
            ],
          },
          observed,
          cutoffStated,
          trials: trials.map(({ trial, caseId, run, assignments }) => ({
            trial,
            caseId,
            state: run.state,
            assignments: assignments.length,
            verdicts: Object.fromEntries(
              compareEvalRun(run).map((row) => [
                row.scenarioId,
                {
                  current: ended(row.current),
                  candidate: ended(row.candidate),
                },
              ]),
            ),
            tasks: run.tasks.map((task) => ({
              taskId: task.taskId,
              model: task.pins?.model ?? null,
              totalTokens: task.totalTokens,
              outcome: task.outcome,
            })),
          })),
        }),
      ),
    });
    for (const { trial, run, assignments } of trials) {
      expect(run.state, `trial ${String(trial)}`).toBe("completed");
      expect(assignments).toHaveLength(8);
      expect(new Set(assignments.map((entry) => entry.sessionId)).size).toBe(8);
      // Every task reached an outcome through the mail tools, and its real
      // usage is recorded.
      expect(run.tasks.map((task) => [task.taskId, task.outcome.kind])).toEqual(
        run.tasks.map((task) => [task.taskId, "assessed"]),
      );
      for (const task of run.tasks) {
        expect(task.totalTokens ?? 0, task.taskId).toBeGreaterThan(0);
        // Each turn was shown the revision its configuration names. The
        // other supplier's turns were shown none.
        expect(
          task.outcome.kind === "assessed"
            ? task.outcome.observation.memory
            : null,
          task.taskId,
        ).toEqual(
          task.scenarioId === "other_supplier"
            ? []
            : [
                {
                  memoryId,
                  revision: task.configuration === "candidate" ? 2 : 1,
                },
              ],
        );
      }
    }
    expect(state.liveEvalAnswers.map((answer) => answer.status)).toEqual(
      state.liveEvalAnswers.map(() => 200),
    );
    // No draft and no send reached Gmail for a scenario.
    expect([state.sends, state.draftCreates]).toEqual([
      liveBefore.sends,
      liveBefore.drafts,
    ]);
    return;
  }

  // The comparison: both configurations, on the platform route, on the
  // organisation's ChatGPT subscription, and on a route the organisation
  // holds no credential for.
  const before = {
    sends: state.sends,
    drafts: state.draftCreates,
    requests: state.evalInputs.length,
  };
  const compare = () =>
    start(
      "eval_run_compare",
      ["satyr_platform", "codex_subscription", "organisation_openai_api_key"],
      [{ kind: "current" }, candidate],
    );
  const started = await compare();
  const comparison = receiptOf(started);
  // The same command sent again names the same run, and its identity
  // carries no other request.
  expect(await compare()).toEqual(started);
  expect(
    await start("eval_run_compare", ["satyr_platform"], [{ kind: "current" }]),
  ).toMatchObject({ status: 409, body: { error: "eval_command_conflict" } });
  await expect
    .poll(async () => (await settledRun(comparison.runId)) !== null, {
      timeout: 90_000,
    })
    .toBe(true);
  const compared = await settledRun(comparison.runId);
  if (compared === null) throw new Error("comparison missing");
  expect(compared.state, JSON.stringify(compared.tasks.map(ended))).toBe(
    "completed",
  );
  const byScenario = (route: EvalRoute) =>
    Object.fromEntries(
      compareEvalRun(compared)
        .filter((row) => row.route === route)
        .map((row) => [
          row.scenarioId,
          { current: ended(row.current), candidate: ended(row.candidate) },
        ]),
    );
  // Under the accepted revision the midday change is escalated, which the
  // reviewed criteria say is wrong. Under the candidate every scenario
  // passes, and the other supplier is handled as before under both.
  const available = ["satyr_platform", "codex_subscription"] as const;
  for (const route of available) {
    expect(byScenario(route), route).toEqual({
      late_change: { current: "passed", candidate: "passed" },
      midday_change: { current: "failed", candidate: "passed" },
      early_change: { current: "passed", candidate: "passed" },
      other_supplier: { current: "passed", candidate: "passed" },
    });
    expect(evalConfigurationVerdict(compared, "current", route)).toBe("failed");
    expect(evalConfigurationVerdict(compared, "candidate", route)).toBe(
      "passed",
    );
  }
  // The route with no credential tried nothing. Its tasks are unavailable:
  // they carry no verdict, ran on no other authority, and leave the
  // configuration's answer across all routes incomplete.
  const absent = "unavailable:authority_unavailable";
  expect(byScenario("organisation_openai_api_key")).toEqual({
    late_change: { current: absent, candidate: absent },
    midday_change: { current: absent, candidate: absent },
    early_change: { current: absent, candidate: absent },
    other_supplier: { current: absent, candidate: absent },
  });
  expect(evalConfigurationVerdict(compared, "candidate")).toBe("incomplete");
  const ran = compared.tasks.filter(
    (task) => task.route !== "organisation_openai_api_key",
  );
  const notRun = compared.tasks.filter(
    (task) => task.route === "organisation_openai_api_key",
  );
  expect(
    notRun.map((task) => [task.execution, task.pins, task.totalTokens]),
  ).toEqual(notRun.map(() => [null, null, null]));
  // Each task that ran shows the revision its configuration names for the
  // supplier the lesson is about, and no Memory for the other supplier.
  expect(
    Object.fromEntries(
      ran.map((task) => [
        task.taskId,
        task.outcome.kind === "assessed"
          ? task.outcome.observation.memory
          : null,
      ]),
    ),
  ).toEqual(
    Object.fromEntries(
      ran.map((task) => [
        task.taskId,
        task.scenarioId === "other_supplier"
          ? []
          : [
              {
                memoryId,
                revision: task.configuration === "candidate" ? 2 : 1,
              },
            ],
      ]),
    ),
  );
  // Each task that ran names what it ran against. A route is one model and
  // one authority, and the two routes differ in both.
  expect(ran.every((task) => task.pins !== null)).toBe(true);
  for (const pin of ["model", "modelRouteDigest"] as const) {
    expect(
      available.map(
        (route) =>
          new Set(
            ran
              .filter((task) => task.route === route)
              .map((task) => task.pins?.[pin]),
          ).size,
      ),
    ).toEqual([1, 1]);
    expect(new Set(ran.map((task) => task.pins?.[pin])).size).toBe(2);
  }
  // One Case holds one assignment for each task that ran, each in its own
  // Session, and each completed.
  const assignments = await assignmentsOf(comparison.caseId);
  expect(assignments.map((entry) => entry.assignmentId).sort()).toEqual(
    ran.map((task) => task.execution?.assignmentId).sort(),
  );
  expect(assignments).toHaveLength(16);
  expect(new Set(assignments.map((entry) => entry.sessionId)).size).toBe(16);
  expect(assignments.every((entry) => entry.end === "completed")).toBe(true);
  // On each route each turn read its scenario and chose once: three model
  // requests.
  expect(state.evalInputs.length - before.requests).toBe(24);
  expect(chatgpt.modelRequestCount()).toBe(24);
  // Nothing that an Eval turn shows the model names the Eval, its scenario
  // or its run, on either route. The agent reads the request of a turn for
  // arrived mail.
  expect(
    [...state.evalInputs, ...subscriptionStarts].flatMap((shown) =>
      Array.from(
        shown.matchAll(/.{0,60}(?:\beval|scenario).{0,60}/giu),
        String,
      ),
    ),
  ).toEqual([]);
  expect(state.evalMessages).toHaveLength(8);
  expect(subscriptionStarts).toHaveLength(8);
  // Nothing reached the mailbox, and the candidate is still a candidate.
  expect({
    sends: state.sends - before.sends,
    drafts: state.draftCreates - before.drafts,
  }).toEqual({ sends: 0, drafts: 0 });
  expect((await memoryStates()).map((revision) => revision.kind)).toEqual([
    "accepted",
    "candidate",
  ]);
  // The mailbox's own budget paid for each task that ran.
  expect(
    await runInDurableObject(
      input.connector,
      (_actor: unknown, durable: DurableObjectState) =>
        durable.storage.sql
          .exec<{ state: string; reservations: number }>(
            `SELECT state, COUNT(*) AS reservations FROM connector_email_reservation
             WHERE substr(reservation_id, 1, 5) = 'eval_' GROUP BY state`,
          )
          .toArray(),
    ),
  ).toEqual([{ state: "settled", reservations: 16 }]);

  // A second run is stopped during its first turn: the Session's instance
  // ends, then the Connector's. While it is in progress the run shows how
  // far it is and no result.
  const held = state.holdAt("model", evalTurn(1));
  const interrupted = receiptOf(
    await start(
      "eval_run_interrupted",
      ["satyr_platform"],
      [{ kind: "current" }],
    ),
  );
  await expect.poll(() => held.phase, { timeout: 30_000 }).toBe("reached");
  const inProgress = (await runs()).find(
    (run) => run.runId === interrupted.runId,
  );
  expect(inProgress).toMatchObject({
    state: "running",
    tasks: [
      { taskId: "late_change.current.satyr_platform", state: "running" },
      { state: "pending" },
      { state: "pending" },
      { state: "pending" },
    ],
  });
  expect(JSON.stringify(inProgress)).not.toMatch(/outcome|reply/u);
  const stopped = parseSessionId(
    `session_eval_${interrupted.runId.slice("evalrun_".length)}_0`,
  );
  if (!stopped.ok) throw new Error(stopped.error.code);
  const stoppedSession = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: stopped.value,
    now: Date.now(),
  });
  if (!stoppedSession.ok) throw new Error(stoppedSession.error.code);
  const stop = (_actor: unknown, durable: DurableObjectState) => {
    durable.abort("the instance stopped");
  };
  await runInDurableObject(stoppedSession.value, stop).catch(() => undefined);
  await runInDurableObject(input.connector, stop).catch(() => undefined);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: input.connectorId,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  held.phase = "released";
  await runInDurableObject(connector.value, wakeForEvalTasks);
  // The stopped turn's result is unknown, so its task ends as indeterminate
  // and is not run again. The other tasks run, and the run is one run still.
  await expect
    .poll(async () => (await settledRun(interrupted.runId)) !== null, {
      timeout: 90_000,
    })
    .toBe(true);
  const afterStop = await settledRun(interrupted.runId);
  if (afterStop === null) throw new Error("interrupted run missing");
  expect(afterStop.state, JSON.stringify(afterStop.tasks.map(ended))).toBe(
    "indeterminate",
  );
  expect(afterStop.tasks.map(ended)).toEqual([
    "indeterminate:eval_turn_interrupted",
    "failed",
    "passed",
    "passed",
  ]);
  expect(evalConfigurationVerdict(afterStop, "current")).toBe("incomplete");
  const afterStopAssignments = await assignmentsOf(interrupted.caseId);
  expect(afterStopAssignments.map((entry) => entry.end)).toEqual([
    "failed:eval_turn_interrupted",
    "completed",
    "completed",
    "completed",
  ]);
  expect(
    new Set(afterStopAssignments.map((entry) => entry.assignmentId)).size,
  ).toBe(4);
  expect((await runs()).map((run) => run.runId).sort()).toEqual(
    [comparison.runId, interrupted.runId].sort(),
  );

  // A third run loses the Case's instance and the Organisation's instance
  // during its second turn. The Connector and the turn's Session go on.
  const beforeReplacement = state.evalInputs.length;
  const heldForReplacement = state.holdAt("model", evalTurn(2));
  const replaced = receiptOf(
    await start("eval_run_replaced", ["satyr_platform"], [{ kind: "current" }]),
  );
  await expect
    .poll(() => heldForReplacement.phase, { timeout: 60_000 })
    .toBe("reached");
  const replacedCaseId = parseCaseId(replaced.caseId);
  if (!replacedCaseId.ok) throw new Error(replacedCaseId.error.code);
  const replacedCase = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: replacedCaseId.value,
    now: Date.now(),
  });
  if (!replacedCase.ok) throw new Error(replacedCase.error.code);
  await runInDurableObject(replacedCase.value, stop).catch(() => undefined);
  await runInDurableObject(
    await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    }),
    stop,
  ).catch(() => undefined);
  heldForReplacement.phase = "released";
  await expect
    .poll(async () => (await settledRun(replaced.runId)) !== null, {
      timeout: 180_000,
      interval: 1_000,
    })
    .toBe(true);
  const afterReplacement = await settledRun(replaced.runId);
  if (afterReplacement === null) throw new Error("replaced run missing");
  // The turn that was running went on in its Session and asked the model its
  // three requests. Its result was lost with the Case's instance, so the
  // task ends as unknown and is not run a second time. The other tasks run.
  expect(afterReplacement.state).toBe("indeterminate");
  expect(afterReplacement.tasks.map(ended)).toEqual([
    "passed",
    "indeterminate:eval_turn_interrupted",
    "passed",
    "passed",
  ]);
  expect(state.evalInputs.length - beforeReplacement).toBe(12);
  const afterReplacementAssignments = await assignmentsOf(replaced.caseId);
  expect(afterReplacementAssignments.map((entry) => entry.end)).toEqual([
    "completed",
    "failed:eval_turn_interrupted",
    "completed",
    "completed",
  ]);
  expect(
    new Set(afterReplacementAssignments.map((entry) => entry.assignmentId))
      .size,
  ).toBe(4);
  // The new instance of the Organisation holds each run one time.
  expect((await runs()).map((run) => run.runId).sort()).toEqual(
    [comparison.runId, interrupted.runId, replaced.runId].sort(),
  );

  // A fourth run meets a provider that refuses the key: no credit is left on
  // it. Each task ends as unavailable and not as a verdict. Each task asked
  // the pinned route one time, and nothing asked another route.
  const beforeSpent = {
    requests: state.evalInputs.length,
    subscriptionStarts: subscriptionStarts.length,
  };
  state.evalCreditSpent = true;
  const spent = receiptOf(
    await start("eval_run_spent", ["satyr_platform"], [{ kind: "current" }]),
  );
  await expect
    .poll(async () => (await settledRun(spent.runId)) !== null, {
      timeout: 120_000,
      interval: 1_000,
    })
    .toBe(true);
  state.evalCreditSpent = false;
  const afterSpent = await settledRun(spent.runId);
  if (afterSpent === null) throw new Error("spent run missing");
  expect(afterSpent.tasks.map(ended)).toEqual(
    afterSpent.tasks.map(() => "unavailable:authority_unavailable"),
  );
  expect(afterSpent.tasks.map((task) => task.totalTokens)).toEqual([
    0, 0, 0, 0,
  ]);
  expect(evalConfigurationVerdict(afterSpent, "current")).toBe("incomplete");
  expect({
    requests: state.evalInputs.length - beforeSpent.requests,
    subscriptionStarts: subscriptionStarts.length - beforeSpent.subscriptionStarts,
  }).toEqual({ requests: 4, subscriptionStarts: 0 });

  // The operator accepts the passing candidate through the Memory command.
  // The revision it replaces names it, and a run can no longer name it as a
  // candidate.
  expect(
    await memoryCommand(organisationId, owner.session, {
      commandId: "eval_memory_accept_candidate",
      expectedRevision: 2,
      kind: "accept",
      memoryId,
      revision: 2,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "accepted" } } });
  const decided = await memoryStates();
  expect(decided[0]).toMatchObject({
    kind: "superseded",
    supersession: { replacementRevision: 2 },
  });
  expect(decided[1]).toMatchObject({
    kind: "accepted",
    statement: EVAL_CANDIDATE_FACT,
  });
  expect(
    await start("eval_run_decided", ["satyr_platform"], [candidate]),
  ).toMatchObject({ status: 409, body: { error: "eval_conflict" } });
  // The command that began the comparison named it while it was a candidate.
  // Sent again now, it still gets its first answer.
  expect(await compare()).toEqual(started);

  // A candidate that a turn may not be shown gives no verdict. The operator
  // proposes a revision that takes effect in a later year. A run that names
  // it tries nothing for the supplier it applies to, and asks the model
  // nothing for those scenarios. The other supplier's scenario does not
  // depend on it, so it is assessed.
  const inForce = decided[1];
  if (inForce === undefined) throw new Error("accepted revision missing");
  expect(
    await memoryCommand(organisationId, owner.session, {
      commandId: "eval_memory_later",
      expectedRevision: 2,
      kind: "propose",
      memoryId,
      submission: "shared_review",
      content: {
        memoryKind: inForce.memoryKind,
        statement: "Next-day orders close at 4 pm.",
        applicability: inForce.applicability,
        validity: { ...inForce.validity, effectiveFrom: "2099-01-01" },
        evidence: inForce.evidence,
        sourceCaseId: inForce.sourceCaseId,
      },
    }),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 3, state: "candidate" } },
  });
  const requestsBeforeLater = state.evalInputs.length;
  const later = receiptOf(
    await start(
      "eval_run_later",
      ["satyr_platform"],
      [{ kind: "candidate", memory: { memoryId, revision: 3 } }],
    ),
  );
  // A cancel that names another Eval changes nothing of this run, whose
  // tasks are still to start.
  // The journey stopped the first Connector instance, so it uses the one
  // that replaced it.
  expect(
    await connector.value.cancelEvalRun({
      identity: { organisationId, connectorId: input.connectorId },
      now: Date.now(),
      evalId: "eval_of_another_subject",
      runId: later.runId,
    }),
  ).toEqual({ ok: true, value: null });
  await expect
    .poll(async () => (await settledRun(later.runId)) !== null, {
      timeout: 60_000,
    })
    .toBe(true);
  const laterRun = await settledRun(later.runId);
  if (laterRun === null) throw new Error("later run missing");
  const notShown = Object.fromEntries(
    laterRun.tasks.map((task) => [task.scenarioId, ended(task)]),
  );
  expect(notShown).toEqual({
    late_change: "unavailable:memory_unavailable",
    midday_change: "unavailable:memory_unavailable",
    early_change: "unavailable:memory_unavailable",
    other_supplier: "passed",
  });
  expect(evalConfigurationVerdict(laterRun, "candidate")).toBe("incomplete");
  expect(state.evalInputs.length - requestsBeforeLater).toBe(3);
  expect(
    laterRun.tasks.map((task) => [task.scenarioId, task.totalTokens]),
  ).toEqual(
    laterRun.tasks.map((task) => [
      task.scenarioId,
      task.scenarioId === "other_supplier" ? task.totalTokens : null,
    ]),
  );
  Object.assign(input.context.task.meta, {
    candidateNotShown: {
      memory: { memoryId, revision: 3, effectiveFrom: "2099-01-01" },
      runId: later.runId,
      tasks: notShown,
      modelRequests: state.evalInputs.length - requestsBeforeLater,
    },
  });

  // A member who may not review this mailbox's replies reads the same Evals
  // and runs as the owner: the mailbox belongs to the whole Organisation
  // (Plan 27C).
  const stranger = await client("eval-run-stranger");
  await fixtureDatabase().prepare(
    "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_eval_stranger', 'Eval stranger')",
  )
    .bind(organisationId)
    .run();
  await fixtureDatabase().prepare(
    "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_eval_stranger', 'admin', 'active', ?, NULL)",
  )
    .bind(organisationId, stranger.identity.userId, Date.now())
    .run();
  const strangerEvals = await send(stranger.session, "", null);
  const strangerRuns = await send(stranger.session, `/${evalId}/runs`, null);
  expect(strangerEvals).toEqual(await send(owner.session, "", null));
  expect(strangerRuns.status).toBe(200);
  expect(strangerRuns).toEqual(
    await send(owner.session, `/${evalId}/runs`, null),
  );
  // The stranger reads the same contacts of that mailbox's Eval.
  const strangerSenders = await send(
    stranger.session,
    `/${evalId}/contacts`,
    null,
  );
  expect(strangerSenders.status).toBe(200);
  expect(strangerSenders).toEqual(
    await send(owner.session, `/${evalId}/contacts`, null),
  );

  const caseExecution = await verifyMailCaseExecution({
    organisationId,
    owner,
    stranger,
    mailCaseId: correction.evidence.caseId,
    evalCaseId: comparison.caseId,
    evalAssignments: assignments.length,
  });
  Object.assign(input.context.task.meta, {
    caseExecution,
    supplierEvalRuns: {
      substituted: [
        "model provider on the platform route (deterministic OpenRouter transport)",
        "ChatGPT backend on the subscription route (deterministic transport)",
        "Gmail",
      ],
      eval: {
        evalId,
        openedBy: {
          principal: "agent",
          correction: {
            proposalId: correction.evidence.proposalId,
            version: correction.evidence.version,
          },
          scenario: "corrected_request",
        },
        revision: 2,
        scenarios: reviewed.map((entry) => ({
          scenarioId: entry.scenarioId,
          role: entry.role,
          sender: entry.sender,
          receivedAt: entry.message.receivedAt,
          timezone: entry.message.timezone,
          criteria: entry.criteria,
        })),
      },
      memory: { memoryId, current: 1, candidate: 2, acceptedAfterRun: 2 },
      comparison: {
        runId: comparison.runId,
        caseId: comparison.caseId,
        state: compared.state,
        scorer: compared.scorer,
        tasks: compared.tasks.map((task) => ({
          taskId: task.taskId,
          end: ended(task),
          execution: task.execution,
          pins: task.pins,
          totalTokens: task.totalTokens,
          memory:
            task.outcome.kind === "assessed"
              ? task.outcome.observation.memory
              : null,
        })),
        assignments,
      },
      interrupted: {
        runId: interrupted.runId,
        caseId: interrupted.caseId,
        state: afterStop.state,
        tasks: afterStop.tasks.map((task) => ({
          taskId: task.taskId,
          end: ended(task),
          execution: task.execution,
        })),
        assignments: afterStopAssignments,
      },
      replaced: {
        runId: replaced.runId,
        caseId: replaced.caseId,
        stopped: ["CaseActor", "OrganisationActor"],
        state: afterReplacement.state,
        tasks: afterReplacement.tasks.map((task) => ({
          taskId: task.taskId,
          end: ended(task),
          execution: task.execution,
        })),
        assignments: afterReplacementAssignments,
        modelRequests: 12,
      },
      spent: {
        runId: spent.runId,
        caseId: spent.caseId,
        substituted: "the provider's answer to a key with no credit (HTTP 402)",
        state: afterSpent.state,
        tasks: afterSpent.tasks.map((task) => ({
          taskId: task.taskId,
          end: ended(task),
          totalTokens: task.totalTokens,
        })),
        modelRequests: 4,
        requestsOnAnotherRoute: 0,
      },
      strangerReads: {
        evals: strangerEvals.status,
        runs: strangerRuns.status,
      },
    },
  });
}

/**
 * One push notification and the evaluation it schedules. The evaluation runs
 * on a clock past the coalescing delay, so it is due.
 */
async function admitArrivals(
  hint: Readonly<{ notificationId: string; historyId: string; delay: number }>,
  _actor: unknown,
  state: DurableObjectState,
) {
  const now = Date.now();
  acceptEmailHint(state.storage.sql, {
    notificationId: hint.notificationId,
    historyId: hint.historyId,
    now,
  });
  const runtime = readEmailRuntime(state.storage.sql);
  if (runtime === null) throw new Error("Missing mail runtime");
  const organisationId = parseOrganisationId(runtime.organisationId);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  return runConnectorEmailEvaluation({
    scope: await requireMailFixtureScope(organisationId.value),
    env,
    storage: state.storage,
    now: now + hint.delay,
    fetcher: fetch,
  });
}
/** The reply turns the Connector owes, as it stores them. */
function readReplyTurns(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{
      messageId: string;
      attempts: number;
      claimed: number;
      disposition: string | null;
    }>(
      `SELECT provider_message_id AS messageId, attempts,
              claimed_by IS NOT NULL AS claimed, disposition
       FROM connector_email_reply_turn ORDER BY provider_message_id`,
    )
    .toArray();
}
/**
 * The admission ran on a later clock, and a retry waits for its delay. This
 * brings the turns nobody holds due on the journey's clock and wakes the
 * Connector, as the passing of that time does.
 */
async function wakeForReplyTurns(_actor: unknown, state: DurableObjectState) {
  state.storage.sql.exec(
    "UPDATE connector_email_reply_turn SET available_at = 0 WHERE claimed_by IS NULL",
  );
  await state.storage.setAlarm(Date.now());
}
function readDiscoveryAttempts(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ messageId: string; attempts: number }>(
      "SELECT provider_message_id AS messageId, attempts FROM connector_email_case_context_discovery ORDER BY provider_message_id",
    )
    .toArray();
}

/**
 * Two messages arrive and are admitted by the Connector's own evaluation.
 * Admission binds the supplier's message to that sender's verified contact,
 * with no fixture binding and before collection discovery has run. The
 * message from an address with no verification is admitted unbound. The
 * supplier's turn is then offered the supplier's Memory, and the other is
 * offered nothing.
 */
async function verifySupplierAdmissionBinding(
  input: Readonly<{
    organisationId: OrganisationId;
    account: IntegrationAccountId;
    rawAccount: string;
    connector: DurableObjectStub<
      import("../../src/actors/connector").ConnectorDO
    >;
    state: CaseContextCollectionReplyProvider;
    supplierMemory: SupplierMemoryFixture;
  }>,
) {
  const { organisationId, state } = input;
  state.arrive(1001, [
    {
      id: "supplier_followup_message",
      threadId: "supplier_followup",
      from: "Synthetic supplier <supplier@example.test>",
    },
    {
      id: "stranger_message",
      threadId: "stranger_thread",
      from: "Someone else <stranger@example.test>",
    },
  ]);
  const evaluated = await runInDurableObject(
    input.connector,
    admitArrivals.bind(null, {
      notificationId: "memory-admission-arrivals",
      historyId: "1002",
      delay: 30_001,
    }),
  );
  expect(evaluated, JSON.stringify(evaluated)).toMatchObject({
    kind: "evaluated",
    admitted: 2,
  });
  state.arrivals = [];
  // Each admitted burst is owed a reply turn from this moment. The work is
  // stored with the admission, before any turn runs.
  const owed = await runInDurableObject(input.connector, readReplyTurns);
  expect(owed).toEqual([
    {
      messageId: "stranger_message",
      attempts: 0,
      claimed: 0,
      disposition: null,
    },
    {
      messageId: "supplier_followup_message",
      attempts: 0,
      claimed: 0,
      disposition: null,
    },
  ]);
  const receipts = await fixtureDatabase().prepare(
    `SELECT provider_message_id AS messageId, case_id AS caseId,
            contact_verification_id AS verificationId,
            contact_verification_revision AS verificationRevision
     FROM email_message_receipt
     WHERE organisation_id = ? AND provider_message_id IN ('supplier_followup_message', 'stranger_message')
     ORDER BY provider_message_id`,
  )
    .bind(organisationId)
    .all<{
      messageId: string;
      caseId: string;
      verificationId: string | null;
      verificationRevision: number | null;
    }>();
  expect(receipts.results).toEqual([
    {
      messageId: "stranger_message",
      caseId: `case_gmail_${input.rawAccount}_stranger_thread`,
      verificationId: null,
      verificationRevision: null,
    },
    {
      messageId: "supplier_followup_message",
      caseId: `case_gmail_${input.rawAccount}_supplier_followup`,
      verificationId: "verification_case_context_collection",
      verificationRevision: 1,
    },
  ]);
  // Discovery was queued for both and has not run.
  const discovery = (
    await runInDurableObject(input.connector, readDiscoveryAttempts)
  ).filter(
    (work) =>
      work.messageId === "supplier_followup_message" ||
      work.messageId === "stranger_message",
  );
  expect(discovery).toEqual([
    { messageId: "stranger_message", attempts: 0 },
    { messageId: "supplier_followup_message", attempts: 0 },
  ]);
  const execution = await requireMailFixtureScope(organisationId);
  const offeredTo = async (messageId: string, threadId: string) => {
    const caseId = parseCaseId(`case_gmail_${input.rawAccount}_${threadId}`);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const read = await createMailboxTurnMemoryReader({
      env,
      execution,
      organisationId,
      integrationAccountId: input.account,
      caseId: caseId.value,
      messageId,
      skillIds: [],
      destinationMayReceive: async () => "allow",
      now: Date.now(),
    }).read({ limit: 12, admits: async () => true });
    if (read.kind !== "read") throw new Error(JSON.stringify(read));
    return read.candidates.map((candidate) => candidate.memoryId);
  };
  const offeredToSupplier = await offeredTo(
    "supplier_followup_message",
    "supplier_followup",
  );
  expect(offeredToSupplier).toContain(input.supplierMemory.shared);
  expect(offeredToSupplier).not.toContain(input.supplierMemory.otherSupplier);
  const offeredToStranger = await offeredTo(
    "stranger_message",
    "stranger_thread",
  );
  expect(offeredToStranger).toEqual([]);
  return {
    receipts: receipts.results,
    replyTurnsOwed: owed,
    discoveryAttempts: discovery,
    offeredToSupplier,
    offeredToStranger,
  };
}

const SETTINGS_EDITED_REPLY =
  "Tomorrow's order closed at noon. We can add the change to Thursday's order.";

function readMailProcessingKind(_actor: unknown, state: DurableObjectState) {
  return readEmailRuntime(state.storage.sql)?.processing.kind ?? null;
}

/**
 * A reply draft that waits for approval rests on the mailbox authority of the
 * turn that made it. The operator changes the mailbox limits, stops
 * processing and starts it again, each through the mailbox settings route.
 * A change of the limits ends nothing: a draft that waited is reviewed,
 * edited and sent, and a turn that was running finishes its draft. A stop
 * ends every draft from before it, and a restart does not bring one back.
 * Mail that arrives after the restart gets a draft that opens. A new agent
 * assignment ends each authority that names the earlier assignment.
 */
async function verifyDraftsAcrossMailboxSettings(
  input: Readonly<{
    context: TestContext;
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    account: IntegrationAccountId;
    rawAccount: string;
    connector: DurableObjectStub<
      import("../../src/actors/connector").ConnectorDO
    >;
    fixture: DraftTurnFixture;
    state: CaseContextCollectionReplyProvider;
  }>,
) {
  const { organisationId, owner, state } = input;
  network.use(
    http.put(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/:draftId",
      state.update.bind(state),
    ),
  );
  const execution = await requireMailFixtureScope(organisationId);
  // The fixture published this version and turned processing on.
  const admittedUnder = input.fixture.policyVersion;
  const proposalOf = (thread: string) =>
    `proposal_case_gmail_${input.rawAccount}_${thread}_${thread}_message`;
  const arrive = async (thread: string, historyId: number, delay: number) => {
    state.arrive(historyId, [
      {
        id: `${thread}_message`,
        threadId: thread,
        from: "Synthetic supplier <supplier@example.test>",
      },
    ]);
    const evaluated = await runInDurableObject(
      input.connector,
      admitArrivals.bind(null, {
        notificationId: `mailbox-settings-${thread}`,
        historyId: String(historyId + 1),
        delay,
      }),
    );
    expect(evaluated, JSON.stringify(evaluated)).toMatchObject({
      kind: "evaluated",
      admitted: 1,
    });
    state.arrivals = [];
  };
  const wake = () => runInDurableObject(input.connector, wakeForReplyTurns);
  const owed = () => runInDurableObject(input.connector, readReplyTurns);
  const requestsFor = (thread: string) =>
    state.followUpInputs.filter((request) =>
      request.includes(`Gmail thread ${thread}.`),
    ).length;
  /** The operator's mailbox settings route: limits, a stop or an assignment. */
  const settings = async (
    action: "policy" | "disable" | "bind",
    body: unknown,
  ) => {
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId}/agent-mailboxes/${input.account}/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://localhost",
          cookie: `satyr_control_session=${owner.session.token}; satyr_control_csrf=${owner.session.csrfToken}`,
          "x-satyr-csrf": owner.session.csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
    );
    const raw: unknown = await response.json();
    expect(response.status, JSON.stringify(raw)).toBe(200);
    return raw;
  };
  const raisedLimits = {
    kind: "enabled",
    maxActiveCases: 10,
    maxMessagesPerHour: 20,
    dailyTokenBudget: input.fixture.limits.dailyTokenBudget,
    maxMessageBytes: 262144,
    maxAttachmentBytes: 5242880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    overflow: "pause_and_notify",
  };
  const review = (proposalId: string) =>
    reviewSend(organisationId, owner.session, proposalId, null, {});
  const approve = (proposalId: string, reviewed: ReviewSnapshot) =>
    reviewSend(organisationId, owner.session, proposalId, "approve", reviewed);
  const answer = async (response: Response) => {
    const body: unknown = await response.json();
    return { status: response.status, body };
  };
  /** The draft as the Connector holds it, and the version its turn ran under. */
  const draftOf = (proposalId: string) =>
    runInDurableObject(
      input.connector,
      (_actor: unknown, durable: DurableObjectState) => {
        const operation = latestEmailDraftOperation(
          durable.storage.sql,
          proposalId,
        );
        return operation === null
          ? null
          : {
              version: operation.version,
              state: operation.state,
              madeUnderPolicyVersion: operation.policyVersion,
              sentMessageId: operation.sentMessageId,
            };
      },
    );
  /** Whether a mailbox authority admitted under each version is live now. */
  const standing = (versions: readonly number[]) =>
    Promise.all(
      versions.map(async (mailboxPolicyVersion) => {
        const label = await createCurrentSourceFlowLabel({
          kind: "ingress",
          db: execution.database,
          authority: buildAgentMailboxAuthority({
            organisationId,
            integrationAccountId: input.account,
            mailboxBindingId: input.fixture.mailboxBindingId,
            bindingRevision: input.fixture.bindingRevision,
            mailboxPolicyVersion,
          }).requestAuthority,
        });
        return label.ok ? "live" : label.error.code;
      }),
    );

  // 1. A mail from the verified supplier gets a reply draft that waits.
  const first = proposalOf("supplier_settings_first");
  await arrive("supplier_settings_first", 1001, 30_001);
  await wake();
  await expect.poll(owed, { timeout: 30_000 }).toEqual([]);
  expect(await draftOf(first)).toEqual({
    version: 1,
    state: "awaiting_approval",
    madeUnderPolicyVersion: admittedUnder,
    sentMessageId: null,
  });
  // A second mail arrives. Its turn runs under the same version and is still
  // with the model when the operator changes the limits.
  const second = proposalOf("supplier_settings_second");
  await arrive("supplier_settings_second", 1003, 120_000);
  const running = state.holdAt("model", "supplier_settings_second_message");
  await wake();
  await expect.poll(() => running.phase, { timeout: 30_000 }).toBe("reached");

  // 2. The operator raises the limit of open Cases. Processing stays on.
  expect(await settings("policy", { policy: raisedLimits })).toMatchObject({
    ok: true,
    policy: {
      kind: "enabled",
      policyVersion: admittedUnder + 1,
      maxActiveCases: 10,
    },
  });
  const afterLimits = await standing([
    admittedUnder,
    admittedUnder + 1,
    admittedUnder + 2,
  ]);
  // A version that is not published yet carries nothing.
  expect(afterLimits).toEqual(["live", "live", "source_subject_inactive"]);
  // The running turn goes on under the version it was admitted with. It
  // finishes in the one attempt: three model requests and one draft.
  running.phase = "released";
  state.modelOutage = false;
  await expect.poll(owed, { timeout: 30_000 }).toEqual([]);
  expect(requestsFor("supplier_settings_second")).toBe(3);
  expect(await draftOf(second)).toEqual({
    version: 1,
    state: "awaiting_approval",
    madeUnderPolicyVersion: admittedUnder,
    sentMessageId: null,
  });
  // The first draft still opens for review, takes an edit and is sent.
  const opened = await review(first);
  const openedBody: unknown = await opened.clone().json();
  expect(openedBody).toMatchObject({
    kind: "current",
    proposal: {
      proposal_id: first,
      version: 1,
      to: "supplier@example.test",
      body: FOLLOW_UP_REPLY,
    },
  });
  const drafted = await reviewSnapshot(opened);
  expect(
    await reviewResult(
      await reviewSend(organisationId, owner.session, first, "edit", {
        ...drafted,
        body: SETTINGS_EDITED_REPLY,
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 2 });
  const saved = await review(first);
  const savedBody: unknown = await saved.clone().json();
  expect(savedBody).toMatchObject({
    kind: "current",
    proposal: { version: 2, body: SETTINGS_EDITED_REPLY },
  });
  const sendsBeforeApproval = state.sends;
  const receipt = await reviewResult(
    await approve(first, await reviewSnapshot(saved)),
  );
  // The receipt names the message Gmail accepted, and that message is the
  // edited reply to the supplier.
  expect(state.sends - sendsBeforeApproval).toBe(1);
  const delivered = state.sent.at(-1);
  if (delivered === undefined) throw new Error("Missing approved send");
  expect(receipt).toEqual({
    ok: true,
    kind: "sent",
    provider_message_id: delivered.id,
    version: 2,
  });
  expect(decodeRaw(delivered.raw)).toContain("To: supplier@example.test\r\n");
  expect(caseContextCollectionDraftBody(delivered.raw)).toBe(
    SETTINGS_EDITED_REPLY,
  );
  expect(await draftOf(first)).toEqual({
    version: 2,
    state: "sent",
    madeUnderPolicyVersion: admittedUnder,
    sentMessageId: delivered.id,
  });
  // The edit queued a learning turn for the corrected reply. The journey
  // waits until the Connector owes none, so no turn runs during the stop.
  await expect
    .poll(
      () =>
        runInDurableObject(
          input.connector,
          (_actor: unknown, durable: DurableObjectState) =>
            nextEmailCorrectionLearningAt(durable.storage.sql),
        ),
      { timeout: 30_000 },
    )
    .toBeNull();

  // 3. The second draft waits and opens. The operator stops processing.
  const secondReviewed = await reviewSnapshot(await review(second));
  expect(secondReviewed.version).toBe(1);
  expect(await settings("disable", {})).toMatchObject({
    ok: true,
    policy: {
      kind: "disabled_by_operator",
      policyVersion: admittedUnder + 2,
    },
    processing: "waiting",
  });
  const sendsBeforeStop = state.sends;
  const whileStopped = {
    review: await answer(await review(second)),
    approval: await answer(await approve(second, secondReviewed)),
    standing: await standing([
      admittedUnder,
      admittedUnder + 1,
      admittedUnder + 2,
    ]),
  };
  expect(whileStopped).toEqual({
    review: {
      status: 502,
      body: { ok: false, error: "email_runtime_missing" },
    },
    approval: {
      status: 502,
      body: { ok: false, error: "connector_email_runtime_missing" },
    },
    standing: [
      "source_subject_inactive",
      "source_subject_inactive",
      "source_subject_inactive",
    ],
  });
  expect(state.sends).toBe(sendsBeforeStop);

  // 4. The operator starts processing again. The restart schedules one
  // evaluation at once, and it finds no new mail.
  expect(await settings("policy", { policy: raisedLimits })).toMatchObject({
    ok: true,
    policy: { kind: "enabled", policyVersion: admittedUnder + 3 },
  });
  await expect
    .poll(() => runInDurableObject(input.connector, readMailProcessingKind), {
      timeout: 30_000,
    })
    .toBe("waiting");
  // The second draft was made before the stop, so it stays ended. Only an
  // authority admitted under the restart is live.
  const afterRestart = {
    review: await answer(await review(second)),
    approval: await answer(await approve(second, secondReviewed)),
    standing: await standing([
      admittedUnder,
      admittedUnder + 1,
      admittedUnder + 2,
      admittedUnder + 3,
      admittedUnder + 4,
    ]),
  };
  expect(afterRestart).toEqual({
    review: {
      status: 502,
      body: { ok: false, error: "source_subject_inactive" },
    },
    approval: {
      status: 502,
      body: { ok: false, error: "source_subject_inactive" },
    },
    standing: [
      "source_subject_inactive",
      "source_subject_inactive",
      "source_subject_inactive",
      "live",
      "source_subject_inactive",
    ],
  });
  expect(state.sends).toBe(sendsBeforeStop);
  expect(await draftOf(second)).toEqual({
    version: 1,
    state: "awaiting_approval",
    madeUnderPolicyVersion: admittedUnder,
    sentMessageId: null,
  });
  // A mail that arrives after the restart gets a draft that opens.
  const third = proposalOf("supplier_settings_third");
  await arrive("supplier_settings_third", 1005, 300_000);
  await wake();
  await expect.poll(owed, { timeout: 30_000 }).toEqual([]);
  const thirdReview = await answer(await review(third));
  expect(thirdReview).toMatchObject({
    status: 200,
    body: {
      kind: "current",
      proposal: { proposal_id: third, version: 1, body: FOLLOW_UP_REPLY },
    },
  });
  expect(await draftOf(third)).toEqual({
    version: 1,
    state: "awaiting_approval",
    madeUnderPolicyVersion: admittedUnder + 3,
    sentMessageId: null,
  });

  // 5. The operator assigns the mailbox agent again. The assignment carries
  // what the agent may read and do. An authority that names the earlier
  // assignment is no longer live, also under the current policy version.
  expect(
    await settings("bind", { installationId: "installation_work" }),
  ).toMatchObject({
    ok: true,
    binding: {
      mailboxBindingId: input.fixture.mailboxBindingId,
      revision: input.fixture.bindingRevision + 1,
    },
  });
  const afterAssignment = await standing([admittedUnder + 3]);
  expect(afterAssignment).toEqual(["source_subject_inactive"]);
  const revisions = await execution.database
    .prepare(
      `SELECT policy_version AS version, kind, max_active_cases AS maxActiveCases
       FROM mailbox_ingress_policy_revision
       WHERE organisation_id = ? AND integration_account_id = ?
       ORDER BY policy_version`,
    )
    .bind(organisationId, input.account)
    .all<{ version: number; kind: string; maxActiveCases: number | null }>();
  Object.assign(input.context.task.meta, {
    mailboxSettingsDrafts: {
      policyRevisions: revisions.results,
      draftBeforeLimitsChange: {
        proposalId: first,
        madeUnderPolicyVersion: admittedUnder,
        reviewedUnderPolicyVersion: admittedUnder + 1,
        editedToVersion: 2,
        receipt,
      },
      turnRunningAtLimitsChange: {
        proposalId: second,
        madeUnderPolicyVersion: admittedUnder,
        modelRequests: requestsFor("supplier_settings_second"),
      },
      standingAfterLimitsChange: afterLimits,
      draftBeforeStop: { proposalId: second, whileStopped, afterRestart },
      draftAfterRestart: {
        proposalId: third,
        madeUnderPolicyVersion: admittedUnder + 3,
        review: thirdReview.status,
      },
      standingOfEarlierAssignment: afterAssignment,
    },
  });
}

/**
 * A supplier asks about an order. The mailbox agent reads the thread and the
 * order, and drafts a reply that cites the order, a Memory the owner taught,
 * the supplier's Memory, and records the turn never read. The review shows
 * the verified sources, numbered without a gap. The supplier's Memory came
 * from the mailbox, which belongs to the whole Organisation, so the owner
 * sees it too (Plan 27C). Without the owner's grant to orders the review is refused
 * and names nothing of the order. An edit that removes the order's sentence
 * removes the order's source.
 */
async function verifyReplySources(
  input: Readonly<{
    context: TestContext;
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    account: IntegrationAccountId;
    rawAccount: string;
    connector: FollowUpInput["connector"];
    state: CaseContextCollectionReplyProvider;
    supplierMemory: SupplierMemoryFixture;
    merchantId: string;
    correction: Awaited<ReturnType<typeof verifySupplierReplyCorrection>>;
  }>,
) {
  const { organisationId, owner, state, supplierMemory } = input;
  // The operator's correction taught a fact that rests on that reviewed
  // reply, so the owner may inspect it on the reply review surface.
  const taught = await supplierMemory.accepted(
    "sources_fact",
    SOURCES_MEMORY_FACT,
    supplierMemory.supplierScope,
    input.correction.label,
    input.correction.evidence,
  );
  state.arrive(1001, [
    {
      id: "supplier_sources_message",
      threadId: "supplier_sources",
      from: "Synthetic supplier <supplier@example.test>",
      body: `Where is our ${MAIL_SOURCE_ORDER_ID}? We need the financiers this week.`,
    },
  ]);
  expect(
    await runInDurableObject(
      input.connector,
      admitArrivals.bind(null, {
        notificationId: "sources-arrival",
        historyId: "1002",
        delay: 30_001,
      }),
    ),
  ).toMatchObject({ kind: "evaluated", admitted: 1 });
  state.arrivals = [];
  await runInDurableObject(input.connector, wakeForReplyTurns);
  await expect
    .poll(() => runInDurableObject(input.connector, readReplyTurns), {
      timeout: 30_000,
    })
    .toEqual([]);
  // The turn was shown both Memory revisions, each with the reference that
  // a citation names, and read the order the message names.
  const prompt = modelPrompt(state.sourcesInputs[0] ?? "");
  expect(prompt).toContain(`[memory:${taught}] ${SOURCES_MEMORY_FACT}`);
  expect(prompt).toContain(
    `[memory:${supplierMemory.shared}] ${SUPPLIER_MEMORY_FACT}`,
  );
  expect(state.sourcesInputs.at(-1)).toContain(
    `\\"source\\":\\"order:${MAIL_SOURCE_ORDER_ID}\\"`,
  );
  const caseId = `case_gmail_${input.rawAccount}_supplier_sources`;
  const proposalId = `proposal_${caseId}_supplier_sources_message`;
  // The Connector keeps three sources and the count of four refused
  // citations. It keeps no word of the reply.
  const kept = await runInDurableObject(
    input.connector,
    (_actor: unknown, durable: DurableObjectState) => ({
      sources: readEmailProposalSources(durable.storage.sql, proposalId),
      outcome: readEmailProposalSourceOutcome(durable.storage.sql, proposalId),
    }),
  );
  expect(kept.outcome).toEqual({ accepted: 3, dropped: 4 });
  expect(kept.sources.map((source) => source.record)).toEqual([
    expect.objectContaining({ kind: "order", orderId: MAIL_SOURCE_ORDER_ID }),
    { kind: "memory", memoryId: taught, revision: 1 },
    { kind: "memory", memoryId: supplierMemory.shared, revision: 1 },
  ]);
  for (const words of ["confirmed", "Friday", "financier"])
    expect(JSON.stringify(kept.sources)).not.toContain(words);

  const review = async () => {
    const response = await reviewSend(
      organisationId,
      owner.session,
      proposalId,
      null,
      {},
    );
    const raw: unknown = await response.json();
    return { status: response.status, raw };
  };
  const shown = async () => {
    const read = await review();
    expect(read.status, JSON.stringify(read.raw)).toBe(200);
    if (
      !isRecord(read.raw) ||
      !isRecord(read.raw.proposal) ||
      typeof read.raw.proposal.body !== "string"
    )
      throw new Error(JSON.stringify(read.raw));
    const body = read.raw.proposal.body;
    // The Portal reads the sources through the shared contract.
    const sources = parseMailReplySources(read.raw.sources, body.length);
    if (sources === null) throw new Error(JSON.stringify(read.raw.sources));
    return {
      raw: read.raw,
      body,
      sources: sources.map((source) => ({
        number: source.number,
        record: source.record,
        title: source.title,
        detail: source.detail,
        words: source.spans.map((span) => body.slice(span.start, span.end)),
      })),
    };
  };
  const drafted = await shown();
  expect(drafted.body).toBe(SOURCES_REPLY);
  // The supplier's Memory reached the turn, and this owner sees it.
  expect(drafted.sources).toEqual([
    {
      number: 1,
      record: { kind: "order", orderId: MAIL_SOURCE_ORDER_ID },
      title: `Order ${MAIL_SOURCE_ORDER_ID}`,
      detail: expect.any(String),
      words: [SOURCES_ORDER_WORDS],
    },
    {
      number: 2,
      record: { kind: "memory", memoryId: taught, revision: 1 },
      title: "Fact",
      detail: SOURCES_MEMORY_FACT,
      words: [SOURCES_MEMORY_WORDS],
    },
    {
      number: 3,
      record: { kind: "memory", memoryId: supplierMemory.shared, revision: 1 },
      title: "Fact",
      detail: SUPPLIER_MEMORY_FACT,
      words: [SOURCES_MEMORY_WORDS],
    },
  ]);
  expect(JSON.stringify(drafted.raw)).not.toContain("order_9999");

  // Without the owner's grant to orders, the owner may not read the order,
  // so the review of a reply written from it is refused. The answer names
  // nothing of the order.
  expect(
    await revokeAccessGrant({
      db: fixtureDatabase(),
      organisationId,
      grantId: MAIL_OWNER_ORDER_GRANT,
      expectedRevision: 1,
      reason: "Order read withdrawn for the sources journey",
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true });
  const denied = await review();
  expect(denied.status).toBe(403);
  for (const words of [MAIL_SOURCE_ORDER_ID, "Order ", "financier", "Friday"])
    expect(JSON.stringify(denied.raw)).not.toContain(words);
  await grantOwnerOrderRead(
    organisationId,
    input.merchantId,
    `${MAIL_OWNER_ORDER_GRANT}_restored`,
  );
  const restored = await shown();
  expect(restored.sources.map((source) => source.record.kind)).toEqual([
    "order",
    "memory",
    "memory",
  ]);

  // The owner removes the order's sentence. Its source goes with it, and
  // the Memory's words are found again where they now stand.
  const snapshot = await reviewSnapshot(
    await reviewSend(organisationId, owner.session, proposalId, null, {}),
  );
  expect(
    await reviewResult(
      await reviewSend(organisationId, owner.session, proposalId, "edit", {
        ...snapshot,
        body: SOURCES_EDITED_REPLY,
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 2 });
  const edited = await shown();
  expect(edited.body).toBe(SOURCES_EDITED_REPLY);
  expect(edited.sources).toEqual([
    {
      number: 1,
      record: { kind: "memory", memoryId: taught, revision: 1 },
      title: "Fact",
      detail: SOURCES_MEMORY_FACT,
      words: [SOURCES_MEMORY_WORDS],
    },
    {
      number: 2,
      record: { kind: "memory", memoryId: supplierMemory.shared, revision: 1 },
      title: "Fact",
      detail: SUPPLIER_MEMORY_FACT,
      words: [SOURCES_MEMORY_WORDS],
    },
  ]);
  // The JSON reporter writes this record, so a run leaves its evidence.
  Object.assign(input.context.task.meta, {
    inboxReplySources: {
      repeat:
        "pnpm --filter @purin-labs/platform exec vitest run --config vitest.e2e.config.ts tests/e2e/mail-inbox.test.ts -t 'shows the order and the Memory that a reply draft cites' --reporter=json --outputFile=<file>",
      proposalId,
      citationsMade: 7,
      kept: kept.outcome,
      reviewAsDrafted: drafted.sources,
      supplierMemoryShownToOwner: true,
      reviewWithoutOrderGrant: { status: denied.status, body: denied.raw },
      reviewAfterEdit: edited.sources,
    },
  });
}

type FollowUpInput = Readonly<{
  organisationId: OrganisationId;
  owner: Awaited<ReturnType<typeof client>>;
  account: IntegrationAccountId;
  rawAccount: string;
  connector: DurableObjectStub<
    import("../../src/actors/connector").ConnectorDO
  >;
  fixture: DraftTurnFixture;
  state: CaseContextCollectionReplyProvider;
  supplierId: string;
  /** The candidate the agent proposed, now accepted, and one beside it. */
  learned: string;
  fromCorrection: string;
}>;

/** The Memory records the Session of one attempt at a mail turn kept. */
async function mailTurnMemoryRecords(
  organisationId: OrganisationId,
  caseId: string,
  attemptKey: string,
) {
  const sessionId = parseSessionId(emailTurnSessionId(caseId, attemptKey));
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const session = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!session.ok) throw new Error(session.error.code);
  const records = await runInDurableObject(
    session.value,
    (_actor: unknown, durable: DurableObjectState) =>
      readSessionTurnMemoryRecords(durable.storage.sql, {
        turnId: `turn_email_${attemptKey}`,
        organisationId,
        sessionId: sessionId.value,
      }),
  );
  if (!records.ok) throw new Error(records.error.code);
  const inspected = await session.value.inspectCanonicalSessionState({
    organisationId,
    sessionId: sessionId.value,
  });
  return {
    records: records.value,
    atRest: inspected.ok && inspected.value.quiescence.kind === "ready",
  };
}

/**
 * After the operator accepts the candidate, the supplier's next message gets
 * a plain reply. That reply is bound to the supplier's verified contact, so
 * the turn is offered the accepted revision, which is bound to the same
 * recipient. The stranger's turn is offered nothing. The reply is checked
 * against that recipient again when it is drafted, previewed and sent.
 */
async function verifySupplierFreshReply(input: FollowUpInput) {
  const { organisationId, owner, state } = input;
  const execution = await requireMailFixtureScope(organisationId);
  const caseIdOf = (threadId: string) =>
    `case_gmail_${input.rawAccount}_${threadId}`;
  const supplierCase = caseIdOf("supplier_followup");
  const authority = buildAgentMailboxAuthority({
    organisationId,
    integrationAccountId: input.account,
    mailboxBindingId: input.fixture.mailboxBindingId,
    bindingRevision: input.fixture.bindingRevision,
    mailboxPolicyVersion: input.fixture.policyVersion,
  }).requestAuthority;
  const recipientOf = (threadId: string, messageId: string) =>
    readPlainReplyRecipient(execution.database, {
      organisationId,
      integrationAccountId: input.account,
      caseId: caseIdOf(threadId),
      triggeringMessageId: messageId,
    });
  const recipient = await recipientOf(
    "supplier_followup",
    "supplier_followup_message",
  );
  expect(recipient).toMatchObject({
    partyKind: "supplier",
    partyId: input.supplierId,
    verificationId: "verification_case_context_collection",
    verificationRevision: 1,
  });
  expect(await recipientOf("stranger_thread", "stranger_message")).toBeNull();
  // The same turn, read with and without the recipient its reply is bound
  // to. Without it, Memory bound to that recipient is refused.
  const offered = async (bound: typeof recipient) => {
    const caseId = parseCaseId(supplierCase);
    if (!caseId.ok) throw new Error(caseId.error.code);
    const read = await createMailboxTurnMemoryReader({
      env,
      execution,
      organisationId,
      integrationAccountId: input.account,
      caseId: caseId.value,
      messageId: "supplier_followup_message",
      skillIds: [],
      destinationMayReceive: async (label) =>
        emailTurnDestinationMayReceive(
          execution.database,
          authority,
          { kind: "source_only" },
          label,
          bound,
        ),
      now: Date.now(),
    }).read({ limit: 12, admits: async () => true });
    if (read.kind !== "read") throw new Error(JSON.stringify(read));
    return read.candidates.map((candidate) => candidate.memoryId);
  };
  const offeredWithRecipient = await offered(recipient);
  const offeredWithoutRecipient = await offered(null);
  expect(offeredWithRecipient).toEqual(
    expect.arrayContaining([input.learned, input.fromCorrection]),
  );
  expect(offeredWithoutRecipient).not.toContain(input.learned);
  expect(offeredWithoutRecipient).not.toContain(input.fromCorrection);
  // The Connector runs the two turns it owes.
  const before = { sends: state.sends, drafts: state.draftCreates };
  await runInDurableObject(input.connector, wakeForReplyTurns);
  await expect
    .poll(() => runInDurableObject(input.connector, readReplyTurns), {
      timeout: 30_000,
    })
    .toEqual([]);
  const requestsFor = (threadId: string) =>
    state.followUpInputs.filter((request) =>
      request.includes(`Gmail thread ${threadId}.`),
    );
  const supplierRequests = requestsFor("supplier_followup");
  const strangerRequests = requestsFor("stranger_thread");
  expect(supplierRequests).toHaveLength(3);
  expect(strangerRequests).toHaveLength(3);
  // The supplier's turn was shown the accepted revision with its request:
  // the Memory heading, the revision's exact statement, then the request.
  const supplierPrompt = modelPrompt(supplierRequests[0] ?? "");
  const request = (threadId: string, messageId: string) =>
    `Triage and draft one plain-text reply for Gmail thread ${threadId}. Admitted message ids (oldest first): ${messageId}.`;
  expect(supplierPrompt.startsWith(`${MEMORY_HEADING}\n- `)).toBe(true);
  // The line names the Memory by the reference a reply cites it with, then
  // the statement and the day and timezone it holds from. The agent dated
  // its candidate on the day it proposed it, in UTC.
  expect(
    supplierPrompt
      .split("\n")
      .filter((line) => line.includes(`] ${LEARNED_FACT} `)),
  ).toEqual([
    expect.stringMatching(
      new RegExp(
        `^- \\[memory:[^\\]]+\\] ${LEARNED_FACT.replaceAll(".", "\\.")} \\(holds from \\d{4}-\\d{2}-\\d{2}, UTC\\)$`,
        "u",
      ),
    ),
  ]);
  expect(supplierPrompt).not.toContain(MEMORY_LIMITATION_NOTICE);
  expect(
    supplierPrompt.endsWith(
      `\n\nCurrent request:\n${request("supplier_followup", "supplier_followup_message")}`,
    ),
  ).toBe(true);
  // No Memory applies to the stranger. That turn's prompt is its request
  // and nothing else: no Memory text and no limitation.
  expect(modelPrompt(strangerRequests[0] ?? "")).toBe(
    request("stranger_thread", "stranger_message"),
  );
  expect(strangerRequests.join("\n")).not.toContain(LEARNED_FACT);
  expect(state.followUpInputs.join("\n")).not.toContain(PRIVATE_MEMORY_FACT);
  expect(state.followUpInputs.join("\n")).not.toContain(
    OTHER_SUPPLIER_MEMORY_FACT,
  );
  const admitted = expect.arrayContaining([
    { memoryId: input.learned, revision: 1 },
    { memoryId: input.fromCorrection, revision: 1 },
  ]);
  const supplierTurn = await mailTurnMemoryRecords(
    organisationId,
    supplierCase,
    "supplier_followup_message",
  );
  expect(supplierTurn.records).toMatchObject([
    {
      outcome: { kind: "admitted", revisions: admitted },
      rendering: { revisions: admitted, omittedForBytes: false },
      shown: { kind: "admitted", revisions: admitted },
    },
  ]);
  const strangerTurn = await mailTurnMemoryRecords(
    organisationId,
    caseIdOf("stranger_thread"),
    "stranger_message",
  );
  expect(strangerTurn.records).toMatchObject([
    {
      outcome: { kind: "none" },
      rendering: { revisions: [], omittedForBytes: false },
      shown: { kind: "none" },
    },
  ]);
  // The reply is a draft and its acknowledgement is sent. Its recorded flow
  // carries the Memory's recipient constraint.
  const proposalId = `proposal_${supplierCase}_supplier_followup_message`;
  const flow = await runInDurableObject(
    input.connector,
    inspectCaseContextCollectionProposalFlow.bind(null, proposalId),
  );
  expect(flow).toMatchObject({
    dependency: { kind: "source_only" },
    binding: {
      flowLabel: {
        policies: expect.arrayContaining([
          expect.objectContaining({
            owner: expect.objectContaining({
              kind: "recipient_constraint",
              recipient,
            }),
          }),
        ]),
      },
    },
  });
  // Each of the two senders gets the fixed acknowledgement, and each reply
  // is a draft.
  expect({
    sends: state.sends - before.sends,
    drafts: state.draftCreates - before.drafts,
  }).toEqual({ sends: 2, drafts: 4 });
  // The stranger's message made the agent choose a direct reply. The sender
  // is not a verified contact, so the reply waits for a person, as the
  // supplier's reviewed reply does, and Gmail was not asked to send it.
  expect(state.sentBodies).not.toContain(STRANGER_REPLY);
  expect(
    [...state.drafts.values()].map(caseContextCollectionDraftBody),
  ).toContain(STRANGER_REPLY);
  const strangerLifecycle = await queuedReplyLifecycle(
    organisationId,
    `proposal_${caseIdOf("stranger_thread")}_stranger_message`,
  );
  expect(strangerLifecycle).not.toBeNull();
  expect(strangerLifecycle).toBe(
    await queuedReplyLifecycle(organisationId, proposalId),
  );
  // At each surface the reply passes for the verified address and for no
  // other. A reply that goes elsewhere names no recipient, so the flow that
  // is bound to one is refused.
  const surfaces: Record<string, { verified: string; elsewhere: string }> = {};
  for (const surface of ["draft", "preview", "send"] as const) {
    const decide = (to: string) =>
      runInDurableObject(
        input.connector,
        async (_actor: unknown, durable: DurableObjectState) => {
          const decided = await authorizeEmailProposalFlow({
            env,
            sql: durable.storage.sql,
            proposalId,
            authority,
            surface,
            to,
            approvalSatisfied: surface === "send",
            caseId: supplierCase,
            triggeringMessageId: "supplier_followup_message",
          });
          return decided.ok ? "allowed" : decided.error.code;
        },
      );
    surfaces[surface] = {
      verified: await decide("supplier@example.test"),
      elsewhere: await decide("elsewhere@example.test"),
    };
    expect(surfaces[surface]).toEqual({
      verified: "allowed",
      elsewhere: "email_disclosure_denied",
    });
  }
  // The operator reviews the reply and approves it, and it is sent.
  const reviewed = await reviewSnapshot(
    await reviewSend(organisationId, owner.session, proposalId, null, {}),
  );
  expect(reviewed.version).toBe(1);
  expect(
    await reviewResult(
      await reviewSend(
        organisationId,
        owner.session,
        proposalId,
        "approve",
        reviewed,
      ),
    ),
  ).toMatchObject({ kind: "sent" });
  expect(state.sends - before.sends).toBe(3);
  expect(state.sentBodies).not.toContain(STRANGER_REPLY);
  return {
    proposalId,
    recipient,
    offeredWithRecipient,
    offeredWithoutRecipient,
    supplierTurn: supplierTurn.records,
    supplierPrompt,
    strangerTurn: strangerTurn.records,
    strangerPrompt: modelPrompt(strangerRequests[0] ?? ""),
    surfaces,
    sentAfterApproval: true,
  };
}

/** Both reply paths retain the current organisation's capability rules. */
async function verifyReplyCapabilityPolicy(
  input: FollowUpInput,
  plainProposalId: string,
) {
  const original = await readCurrentOrganisationPolicySnapshot(
    fixtureDatabase(),
    input.organisationId,
  );
  if (!original.ok) throw new Error(original.error.code);
  const results = [];
  try {
    for (const effect of ["deny", "approval_required"] as const) {
      const policy = structuredClone(original.value);
      if (effect === "deny")
        policy.authz.deniedTools.push(CAPABILITY_KEYS.emailReplyPropose);
      else
        policy.authz.approvalRequired.push(CAPABILITY_KEYS.emailReplyPropose);
      await fixtureDatabase().prepare(
        "UPDATE policy_snapshot SET body = ? WHERE organisation_id = ? AND version = ?",
      )
        .bind(JSON.stringify(policy), input.organisationId, policy.version)
        .run();
      for (const proposal of [
        {
          kind: "collected",
          proposalId: `proposal_${input.fixture.caseId}_case_context_collection_anchor_message`,
          caseId: input.fixture.caseId,
          messageId: "case_context_collection_anchor_message",
        },
        {
          kind: "plain",
          proposalId: plainProposalId,
          caseId: `case_gmail_${input.rawAccount}_supplier_followup`,
          messageId: "supplier_followup_message",
        },
      ]) {
        for (const approvalSatisfied of [false, true]) {
          const result = await runInDurableObject(
            input.connector,
            checkReplyCapabilityPolicy.bind(null, {
              organisationId: input.organisationId,
              account: input.account,
              fixture: input.fixture,
              proposalId: proposal.proposalId,
              caseId: proposal.caseId,
              messageId: proposal.messageId,
              approvalSatisfied,
            }),
          );
          const expected =
            effect === "approval_required" && approvalSatisfied
              ? "allowed"
              : "email_disclosure_denied";
          expect(result).toBe(expected);
          results.push({
            reply: proposal.kind,
            effect,
            approvalSatisfied,
            result,
          });
        }
      }
    }
  } finally {
    await fixtureDatabase().prepare(
      "UPDATE policy_snapshot SET body = ? WHERE organisation_id = ? AND version = ?",
    )
      .bind(
        JSON.stringify(original.value),
        input.organisationId,
        original.value.version,
      )
      .run();
  }
  return results;
}

async function checkReplyCapabilityPolicy(
  input: Readonly<{
    organisationId: OrganisationId;
    account: IntegrationAccountId;
    fixture: DraftTurnFixture;
    proposalId: string;
    caseId: string;
    messageId: string;
    approvalSatisfied: boolean;
  }>,
  _actor: unknown,
  state: DurableObjectState,
) {
  const result = await authorizeEmailProposalFlow({
    env,
    sql: state.storage.sql,
    proposalId: input.proposalId,
    authority: buildAgentMailboxAuthority({
      organisationId: input.organisationId,
      integrationAccountId: input.account,
      mailboxBindingId: input.fixture.mailboxBindingId,
      bindingRevision: input.fixture.bindingRevision,
      mailboxPolicyVersion: input.fixture.policyVersion,
    }).requestAuthority,
    surface: "send",
    to: "supplier@example.test",
    approvalSatisfied: input.approvalSatisfied,
    caseId: input.caseId,
    triggeringMessageId: input.messageId,
  });
  return result.ok ? "allowed" : result.error.code;
}

async function abortMailSession(
  organisationId: OrganisationId,
  caseId: string,
  turn: string,
): Promise<void> {
  const sessionId = parseSessionId(emailTurnSessionId(caseId, turn));
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const session = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!session.ok) throw new Error(session.error.code);
  await expect(
    runInDurableObject(session.value, abortJourneyActor),
  ).rejects.toThrow();
}

function abortJourneyActor(_actor: unknown, state: DurableObjectState): void {
  state.abort("acceptance journey replaced this Actor");
}

/**
 * A second message arrives on the supplier's thread. It is a turn of its
 * own. Its first attempt is stopped while the model is asked. Its second is
 * stopped after the reply draft exists. The third finishes the reply without
 * asking the model again or drafting it twice. Every attempt keeps the
 * record of what it was shown, and the turn before it keeps its history.
 */
async function verifyInterruptedReplyRecovery(input: FollowUpInput) {
  const { organisationId, state } = input;
  const caseId = `case_gmail_${input.rawAccount}_supplier_followup`;
  const turn = "supplier_followup_second";
  const proposalId = `proposal_${caseId}_${turn}`;
  const connectorId = gmailConnectorId(input.account);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  let connector = input.connector;
  const wake = () => runInDurableObject(connector, wakeForReplyTurns);
  const owed = () => runInDurableObject(connector, readReplyTurns);
  // The running instance of the Connector ends with its work in flight, as
  // a deployment ends it. A stub of the ended instance is of no further use,
  // so the journey takes a new one, which starts the next instance.
  const stopInstance = async () => {
    await runInDurableObject(
      connector,
      (_actor: unknown, durable: DurableObjectState) => {
        durable.abort("the instance stopped");
      },
    ).catch(() => undefined);
    const next = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!next.ok) throw new Error(next.error.code);
    connector = next.value;
  };
  state.arrive(1003, [
    {
      id: turn,
      threadId: "supplier_followup",
      from: "Synthetic supplier <supplier@example.test>",
    },
  ]);
  expect(
    await runInDurableObject(
      connector,
      admitArrivals.bind(null, {
        notificationId: "memory-second-arrival",
        historyId: "1004",
        delay: 120_000,
      }),
    ),
  ).toMatchObject({ kind: "evaluated", admitted: 1 });
  state.arrivals = [];
  const before = {
    sends: state.sends,
    drafts: state.draftCreates,
    requests: state.followUpInputs.length,
  };
  // First attempt: the Connector stops while the model is being asked.
  const model = state.holdAt("model");
  await wake();
  await expect.poll(() => model.phase, { timeout: 30_000 }).toBe("reached");
  expect(await owed()).toEqual([
    { messageId: turn, attempts: 1, claimed: 1, disposition: null },
  ]);
  await stopInstance();
  // Second attempt: the new instance takes the turn over at once. The
  // Session of the first attempt is still at work, so it runs nothing and
  // waits. No turn runs twice at the same time.
  await wake();
  await expect
    .poll(owed, { timeout: 30_000 })
    .toEqual([{ messageId: turn, attempts: 2, claimed: 0, disposition: null }]);
  // An attempt can also stop after it reserved its tokens and before its
  // assignment exists. The second attempt made no assignment, so the journey
  // leaves that reservation under its name. The first attempt holds all that
  // is left of the day's budget, so this one is written past the limit.
  const unassignedTokens = 4_000;
  expect(
    await runInDurableObject(
      connector,
      (_actor: unknown, durable: DurableObjectState) =>
        reserveEmailTokens(durable.storage.sql, {
          reservationId: `turn_${caseId}_${turn}_attempt_2`,
          utcDay: utcDayKey(Date.now()),
          tokens: unassignedTokens,
          limit: Number.MAX_SAFE_INTEGER,
          now: Date.now(),
        }).kind,
    ),
  ).toBe("reserved");
  expect(state.followUpInputs.length - before.requests).toBe(1);
  // The Session is stopped too. It reports pending work until its turn
  // lease ends, about 30 s later. The recovery does not wait for that, so
  // the journey goes on at once.
  await abortMailSession(organisationId, caseId, turn);
  model.phase = "released";
  state.modelOutage = false;
  const requestsAfterFirst = state.followUpInputs.length - before.requests;
  // Third attempt: it asks the model and drafts the reply. The Connector
  // stops after that draft exists, before the acknowledgement is drafted.
  const acknowledgement = state.holdAt("acknowledgement");
  await wake();
  await expect
    .poll(() => acknowledgement.phase, { timeout: 30_000 })
    .toBe("reached");
  expect(await owed()).toEqual([
    {
      messageId: turn,
      attempts: 3,
      claimed: 1,
      disposition: "approval_required",
    },
  ]);
  const requestsAfterThird = state.followUpInputs.length - before.requests;
  expect(requestsAfterThird - requestsAfterFirst).toBe(3);
  const replyDrafts = () =>
    [...state.drafts.values()].filter(
      (raw) => caseContextCollectionDraftBody(raw) === FOLLOW_UP_REPLY,
    ).length;
  expect(replyDrafts()).toBe(1);
  // The Session of this attempt finished its turn and runs none now, so the
  // attempt that takes over has nothing to wait for.
  await stopInstance();
  acknowledgement.phase = "released";
  // Fourth attempt: it finishes the reply.
  await wake();
  await expect.poll(owed, { timeout: 30_000 }).toEqual([]);
  // The model was not asked again, the reply was not drafted twice, and
  // one acknowledgement was sent.
  expect(state.followUpInputs.length - before.requests).toBe(
    requestsAfterThird,
  );
  expect(replyDrafts()).toBe(1);
  expect({
    sends: state.sends - before.sends,
    drafts: state.draftCreates - before.drafts,
  }).toEqual({ sends: 1, drafts: 2 });
  // On the Case each attempt that began work is an assignment of its own.
  // The two that stopped are failed as abandoned and the last completed.
  // The attempt that waited made none. The turn for the message before this
  // one is as it was.
  const parsedCase = parseCaseId(caseId);
  if (!parsedCase.ok) throw new Error(parsedCase.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: parsedCase.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const assignments = snapshot.value.assignmentLifecycles.map((lifecycle) => ({
    assignmentId: lifecycle.assignment.assignmentId,
    sessionId: lifecycle.assignment.sessionId,
    state: lifecycle.kind,
    disposition:
      lifecycle.kind === "settled"
        ? lifecycle.disposition.kind === "failed"
          ? `failed:${lifecycle.disposition.code}`
          : lifecycle.disposition.kind
        : null,
  }));
  const abandoned = "abandoned";
  expect(assignments).toEqual([
    {
      assignmentId: `assignment_${caseId}_supplier_followup_message`,
      sessionId: emailTurnSessionId(caseId, "supplier_followup_message"),
      state: "settled",
      disposition: "completed",
    },
    {
      assignmentId: `assignment_${caseId}_${turn}`,
      sessionId: emailTurnSessionId(caseId, turn),
      state: "settled",
      disposition: abandoned,
    },
    {
      assignmentId: `assignment_${caseId}_${turn}_attempt_3`,
      sessionId: emailTurnSessionId(caseId, `${turn}_attempt_3`),
      state: "settled",
      disposition: abandoned,
    },
    {
      assignmentId: `assignment_${caseId}_${turn}_attempt_4`,
      sessionId: emailTurnSessionId(caseId, `${turn}_attempt_4`),
      state: "settled",
      disposition: "completed",
    },
  ]);
  // Each attempt that asked the model kept what it was shown: the same
  // accepted revisions. The attempt that asked nothing kept nothing.
  const admitted = expect.arrayContaining([
    { memoryId: input.learned, revision: 1 },
    { memoryId: input.fromCorrection, revision: 1 },
  ]);
  const shown = [
    { outcome: { kind: "admitted", revisions: admitted } },
  ] as const;
  const attempts = {
    first: (await mailTurnMemoryRecords(organisationId, caseId, turn)).records,
    third: (
      await mailTurnMemoryRecords(organisationId, caseId, `${turn}_attempt_3`)
    ).records,
    fourth: (
      await mailTurnMemoryRecords(organisationId, caseId, `${turn}_attempt_4`)
    ).records,
  };
  expect(attempts.first).toMatchObject(shown);
  expect(attempts.third).toMatchObject(shown);
  expect(attempts.fourth).toEqual([]);
  const earlierTurn = await mailTurnMemoryRecords(
    organisationId,
    caseId,
    "supplier_followup_message",
  );
  expect(earlierTurn.records).toMatchObject(shown);
  // The reply waits for approval under the recipient constraint it drew on.
  const recorded = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) => ({
      reply: latestEmailDraftOperation(durable.storage.sql, proposalId)?.state,
      earlierReply: latestEmailDraftOperation(
        durable.storage.sql,
        `proposal_${caseId}_supplier_followup_message`,
      )?.state,
      flow: readEmailProposalFlow(durable.storage.sql, proposalId),
      reservations: durable.storage.sql
        .exec<{
          reservationId: string;
          state: string;
          tokens: number;
          settledTokens: number | null;
        }>(
          `SELECT reservation_id AS reservationId, state, tokens,
                  settled_tokens AS settledTokens
           FROM connector_email_reservation
           WHERE substr(reservation_id, 1, ?) = ? ORDER BY reservation_id`,
          `turn_${caseId}_${turn}`.length,
          `turn_${caseId}_${turn}`,
        )
        .toArray(),
    }),
  );
  expect(recorded).toMatchObject({
    reply: "awaiting_approval",
    earlierReply: "sent",
    flow: {
      dependency: { kind: "source_only" },
      binding: {
        flowLabel: {
          policies: expect.arrayContaining([
            expect.objectContaining({
              owner: expect.objectContaining({ kind: "recipient_constraint" }),
            }),
          ]),
        },
      },
    },
  });
  // The mailbox's daily budget is smaller than one turn's allowance, so the
  // attempt that stopped with the model asked had reserved all that was
  // left of it. Its usage was never reported, and it is charged a quarter of
  // that reservation. The reservation of an attempt that stopped before its
  // assignment existed is released. The attempt that drafted the reply had
  // the rest of the day's budget to reserve, and is charged what it used.
  // The attempt that took the draft over reserved nothing.
  const [stopped, unassigned, drafted, ...others] = recorded.reservations;
  expect(others).toEqual([]);
  if (stopped === undefined || drafted === undefined)
    throw new Error("The attempts' reservations are missing");
  expect(stopped).toMatchObject({
    reservationId: `turn_${caseId}_${turn}`,
    state: "settled",
    settledTokens: Math.ceil(stopped.tokens / 4),
  });
  expect(unassigned).toEqual({
    reservationId: `turn_${caseId}_${turn}_attempt_2`,
    state: "released",
    tokens: unassignedTokens,
    settledTokens: null,
  });
  expect(drafted).toMatchObject({
    reservationId: `turn_${caseId}_${turn}_attempt_3`,
    state: "settled",
    tokens: stopped.tokens - Math.ceil(stopped.tokens / 4),
  });
  expect(drafted.settledTokens).toBeLessThan(drafted.tokens);
  // The operator can review the recovered reply.
  const reviewed = await reviewSnapshot(
    await reviewSend(organisationId, input.owner.session, proposalId, null, {}),
  );
  expect(reviewed.version).toBe(1);
  return {
    proposalId,
    replacedActors: ["Connector", "Session"],
    assignments,
    modelRequests: {
      first: requestsAfterFirst,
      second: 0,
      third: requestsAfterThird - requestsAfterFirst,
      fourth: 0,
    },
    replyDrafts: replyDrafts(),
    acknowledgementsSent: state.sends - before.sends,
    shown: attempts,
    reservations: recorded.reservations,
  };
}

/**
 * The operator corrects the recovered reply with a body longer than a
 * mailbox turn's prompt budget. The learning turn that follows admits the
 * accepted revisions, and its request leaves no room for them. The turn
 * records that the prompt's bytes limited what the model was given, and the
 * model is told that Memory is missing.
 */
async function verifyPromptByteLimit(input: FollowUpInput, proposalId: string) {
  const { organisationId, owner, state } = input;
  const caseId = `case_gmail_${input.rawAccount}_supplier_followup`;
  const turn = "supplier_followup_second";
  const before = state.learningInputs.length;
  const drafted = await reviewSnapshot(
    await reviewSend(organisationId, owner.session, proposalId, null, {}),
  );
  expect(
    await reviewResult(
      await reviewSend(organisationId, owner.session, proposalId, "edit", {
        ...drafted,
        body: LONG_CORRECTION,
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 2 });
  // The edit recorded a correction and queued its learning turn. The journey
  // takes a new stub here: the one it holds ended with the last instance.
  const connectorId = gmailConnectorId(input.account);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  await expect
    .poll(
      () =>
        runInDurableObject(
          connector.value,
          (_actor: unknown, durable: DurableObjectState) =>
            nextEmailCorrectionLearningAt(durable.storage.sql),
        ),
      { timeout: 30_000 },
    )
    .toBeNull();
  const requests = state.learningInputs.slice(before);
  expect(requests).toHaveLength(3);
  const prompt = modelPrompt(requests[0] ?? "");
  // The limitation is the first thing the model reads. No Memory follows it,
  // and the request is whole.
  expect(
    prompt.startsWith(`${MEMORY_LIMITATION_NOTICE}\n\nCurrent request:\n`),
  ).toBe(true);
  expect(prompt).not.toContain(MEMORY_HEADING);
  expect(prompt).not.toContain(LEARNED_FACT);
  expect(prompt.endsWith(LONG_CORRECTION)).toBe(true);
  const admitted = expect.arrayContaining([
    { memoryId: input.learned, revision: 1 },
    { memoryId: input.fromCorrection, revision: 1 },
  ]);
  const learning = await mailTurnMemoryRecords(
    organisationId,
    caseId,
    `${turn}_learn_2`,
  );
  // The accepted bundle admitted both revisions. The record of what the
  // model was given is `limited` by the prompt's bytes, with none carried.
  expect(learning.records).toMatchObject([
    {
      outcome: { kind: "admitted", revisions: admitted },
      rendering: { revisions: [], omittedForBytes: true },
      shown: { kind: "limited", revisions: [], reason: "prompt_bytes" },
    },
  ]);
  return {
    promptBytes: new TextEncoder().encode(JSON.stringify(prompt)).byteLength,
    promptStart: prompt.slice(0, MEMORY_LIMITATION_NOTICE.length + 18),
    record: learning.records[0],
  };
}

/**
 * The Session and the Connector both stop while a reply turn's model is
 * being asked, as a deployment stops them. The attempt that takes the turn
 * over finds that no instance runs the stopped attempt's turn. It does not
 * wait for that turn's lease to end: it fails the stopped assignment, asks
 * the model and finishes the reply at once.
 */
async function verifyStoppedActorsRecovery(input: FollowUpInput) {
  const { organisationId, state } = input;
  const caseId = `case_gmail_${input.rawAccount}_supplier_restart`;
  const turn = "supplier_restart_message";
  const connectorId = gmailConnectorId(input.account);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const currentConnector = async () => {
    const current = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!current.ok) throw new Error(current.error.code);
    return current.value;
  };
  let connector = await currentConnector();
  const wake = () => runInDurableObject(connector, wakeForReplyTurns);
  const owed = () => runInDurableObject(connector, readReplyTurns);
  state.arrive(1005, [
    {
      id: turn,
      threadId: "supplier_restart",
      from: "Synthetic supplier <supplier@example.test>",
    },
  ]);
  expect(
    await runInDurableObject(
      connector,
      admitArrivals.bind(null, {
        notificationId: "memory-restart-arrival",
        historyId: "1006",
        delay: 300_000,
      }),
    ),
  ).toMatchObject({ kind: "evaluated", admitted: 1 });
  state.arrivals = [];
  const replyDrafts = () =>
    [...state.drafts.values()].filter(
      (raw) => caseContextCollectionDraftBody(raw) === FOLLOW_UP_REPLY,
    ).length;
  const before = {
    sends: state.sends,
    drafts: state.draftCreates,
    replyDrafts: replyDrafts(),
    requests: state.followUpInputs.length,
  };
  // First attempt: the Session's instance ends while the model is being
  // asked. The Connector's call to it fails, and the turn is owed again.
  const model = state.holdAt("model", turn);
  await wake();
  await expect.poll(() => model.phase, { timeout: 30_000 }).toBe("reached");
  const shownToFirst = (
    await mailTurnMemoryRecords(organisationId, caseId, turn)
  ).records;
  expect(shownToFirst).toHaveLength(1);
  await stopMailTurnSession(organisationId, caseId, turn);
  await expect
    .poll(owed, { timeout: 30_000 })
    .toEqual([{ messageId: turn, attempts: 1, claimed: 0, disposition: null }]);
  // The Connector's instance ends too.
  await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) => {
      durable.abort("the instance stopped");
    },
  ).catch(() => undefined);
  connector = await currentConnector();
  model.phase = "released";
  state.modelOutage = false;
  // Second attempt: nothing runs the first attempt's turn, so this one takes
  // the turn over now. It asks the model, drafts the reply and acknowledges.
  await wake();
  await expect.poll(owed, { timeout: 30_000 }).toEqual([]);
  expect({
    requests: state.followUpInputs.length - before.requests,
    replyDrafts: replyDrafts() - before.replyDrafts,
    sends: state.sends - before.sends,
    drafts: state.draftCreates - before.drafts,
  }).toEqual({ requests: 4, replyDrafts: 1, sends: 1, drafts: 2 });
  const parsedCase = parseCaseId(caseId);
  if (!parsedCase.ok) throw new Error(parsedCase.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: parsedCase.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const assignments = snapshot.value.assignmentLifecycles.map((lifecycle) => ({
    assignmentId: lifecycle.assignment.assignmentId,
    state: lifecycle.kind,
    disposition:
      lifecycle.kind === "settled"
        ? lifecycle.disposition.kind === "failed"
          ? `failed:${lifecycle.disposition.code}`
          : lifecycle.disposition.kind
        : null,
  }));
  expect(assignments).toEqual([
    {
      assignmentId: `assignment_${caseId}_${turn}`,
      state: "settled",
      disposition: "abandoned",
    },
    {
      assignmentId: `assignment_${caseId}_${turn}_attempt_2`,
      state: "settled",
      disposition: "completed",
    },
  ]);
  // The stopped attempt keeps its record of what its model was shown, and
  // its Session comes to rest well before its turn's lease would end.
  const first = () => mailTurnMemoryRecords(organisationId, caseId, turn);
  expect((await first()).records).toEqual(shownToFirst);
  await expect
    .poll(async () => (await first()).atRest, { timeout: 10_000 })
    .toBe(true);
  const second = await mailTurnMemoryRecords(
    organisationId,
    caseId,
    `${turn}_attempt_2`,
  );
  expect(second.records).toHaveLength(1);
  const reservations = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) =>
      durable.storage.sql
        .exec<{
          reservationId: string;
          state: string;
          tokens: number;
          settledTokens: number | null;
        }>(
          `SELECT reservation_id AS reservationId, state, tokens,
                  settled_tokens AS settledTokens
           FROM connector_email_reservation
           WHERE substr(reservation_id, 1, ?) = ? ORDER BY reservation_id`,
          `turn_${caseId}_${turn}`.length,
          `turn_${caseId}_${turn}`,
        )
        .toArray(),
  );
  const [stopped, finished, ...others] = reservations;
  expect(others).toEqual([]);
  if (stopped === undefined || finished === undefined)
    throw new Error("The attempts' reservations are missing");
  expect(stopped).toMatchObject({
    reservationId: `turn_${caseId}_${turn}`,
    state: "settled",
    settledTokens: Math.ceil(stopped.tokens / 4),
  });
  expect(finished).toMatchObject({
    reservationId: `turn_${caseId}_${turn}_attempt_2`,
    state: "settled",
  });
  expect(finished.settledTokens).toBeLessThan(finished.tokens);
  return {
    proposalId: `proposal_${caseId}_${turn}`,
    replacedActors: ["Session", "Connector"],
    assignments,
    modelRequests: { first: 1, second: 3 },
    shown: { first: shownToFirst, second: second.records },
    reservations,
  };
}

/**
 * The operator corrects the reply of the last turn. The Session and the
 * Connector both stop while the learning turn's model is being asked. The
 * work stays queued. The attempt that runs it next fails the stopped
 * attempt's assignment, asks the model and proposes the candidate. Before
 * this work the stopped assignment stayed in progress, every later run was
 * refused, and the correction was never learned from.
 */
async function verifyLearningTurnRecovery(
  input: FollowUpInput,
  proposalId: string,
) {
  const { organisationId, owner, state } = input;
  const caseId = `case_gmail_${input.rawAccount}_supplier_restart`;
  const turn = "supplier_restart_message_learn_2";
  const connectorId = gmailConnectorId(input.account);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const currentConnector = async () => {
    const current = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!current.ok) throw new Error(current.error.code);
    return current.value;
  };
  const owedLearning = async () =>
    runInDurableObject(
      await currentConnector(),
      (_actor: unknown, durable: DurableObjectState) =>
        durable.storage.sql
          .exec<{ version: number; attempts: number }>(
            `SELECT version, attempts FROM connector_email_correction_learning
             WHERE proposal_id = ?`,
            proposalId,
          )
          .toArray(),
    );
  const before = state.learningInputs.length;
  const model = state.holdAt("model", RESTART_CORRECTION);
  const drafted = await reviewSnapshot(
    await reviewSend(organisationId, owner.session, proposalId, null, {}),
  );
  expect(
    await reviewResult(
      await reviewSend(organisationId, owner.session, proposalId, "edit", {
        ...drafted,
        body: RESTART_CORRECTION,
      }),
    ),
  ).toMatchObject({ kind: "edited", version: 2 });
  // First attempt: both Actors stop while the model is being asked. The
  // work is still queued, and one attempt at it is counted.
  await expect.poll(() => model.phase, { timeout: 30_000 }).toBe("reached");
  await stopMailTurnSession(organisationId, caseId, turn);
  await runInDurableObject(
    await currentConnector(),
    (_actor: unknown, durable: DurableObjectState) => {
      durable.abort("the instance stopped");
    },
  ).catch(() => undefined);
  model.phase = "released";
  expect(await owedLearning()).toEqual([{ version: 2, attempts: 1 }]);
  expect(state.learningInputs.length - before).toBe(1);
  // Second attempt: the time the first one held the work for has passed.
  await runInDurableObject(
    await currentConnector(),
    async (_actor: unknown, durable: DurableObjectState) => {
      durable.storage.sql.exec(
        "UPDATE connector_email_correction_learning SET available_at = 0",
      );
      await durable.storage.setAlarm(Date.now());
    },
  );
  await expect.poll(owedLearning, { timeout: 30_000 }).toEqual([]);
  expect(state.learningInputs.length - before).toBe(4);
  // The candidate is the agent's, from this exact correction.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const stored = await organisation.readMemories({ organisationId });
  if (!stored.ok) throw new Error(JSON.stringify(stored.error));
  const learned = stored.value.filter((memory) =>
    memory.revisions.some((revision) =>
      revision.evidence.some(
        (cited) =>
          cited.kind === "proposal_correction" &&
          cited.proposalId === proposalId,
      ),
    ),
  );
  expect(learned).toHaveLength(1);
  expect(learned[0]?.revisions).toMatchObject([
    {
      kind: "candidate",
      statement: RESTART_FACT,
      proposedBy: { kind: "agent" },
      evidence: [{ kind: "proposal_correction", proposalId, version: 2 }],
    },
  ]);
  // On the Case the stopped attempt is failed as abandoned and the next one
  // completed. Each kept its record of what its model was shown.
  const parsedCase = parseCaseId(caseId);
  if (!parsedCase.ok) throw new Error(parsedCase.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: parsedCase.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const assignments = snapshot.value.assignmentLifecycles
    .filter((lifecycle) =>
      lifecycle.assignment.assignmentId.startsWith(
        `assignment_${caseId}_${turn}`,
      ),
    )
    .map((lifecycle) => ({
      assignmentId: lifecycle.assignment.assignmentId,
      state: lifecycle.kind,
      disposition:
        lifecycle.kind === "settled"
          ? lifecycle.disposition.kind === "failed"
            ? `failed:${lifecycle.disposition.code}`
            : lifecycle.disposition.kind
          : null,
    }));
  expect(assignments).toEqual([
    {
      assignmentId: `assignment_${caseId}_${turn}`,
      state: "settled",
      disposition: "abandoned",
    },
    {
      assignmentId: `assignment_${caseId}_${turn}_attempt_2`,
      state: "settled",
      disposition: "completed",
    },
  ]);
  const shown = {
    first: (await mailTurnMemoryRecords(organisationId, caseId, turn)).records,
    second: (
      await mailTurnMemoryRecords(organisationId, caseId, `${turn}_attempt_2`)
    ).records,
  };
  expect(shown.first).toHaveLength(1);
  expect(shown.second).toHaveLength(1);
  const reservations = await runInDurableObject(
    await currentConnector(),
    (_actor: unknown, durable: DurableObjectState) =>
      durable.storage.sql
        .exec<{
          reservationId: string;
          state: string;
          tokens: number;
          settledTokens: number | null;
        }>(
          `SELECT reservation_id AS reservationId, state, tokens,
                  settled_tokens AS settledTokens
           FROM connector_email_reservation
           WHERE substr(reservation_id, 1, ?) = ? ORDER BY reservation_id`,
          `turn_${caseId}_${turn}`.length,
          `turn_${caseId}_${turn}`,
        )
        .toArray(),
  );
  const [stopped, finished, ...others] = reservations;
  expect(others).toEqual([]);
  if (stopped === undefined || finished === undefined)
    throw new Error("The attempts' reservations are missing");
  expect(stopped).toMatchObject({
    reservationId: `turn_${caseId}_${turn}`,
    state: "settled",
    settledTokens: Math.ceil(stopped.tokens / 4),
  });
  expect(finished).toMatchObject({
    reservationId: `turn_${caseId}_${turn}_attempt_2`,
    state: "settled",
  });
  expect(finished.settledTokens).toBeLessThan(finished.tokens);
  return {
    candidate: { memoryId: learned[0]?.memoryId, statement: RESTART_FACT },
    assignments,
    modelRequests: { first: 1, second: 3 },
    shown,
    reservations,
  };
}

/**
 * A reply the turn chose to send at once. The Connector stops at one of
 * three points: before the send begins, while Gmail is accepting the send,
 * so that nothing records it, or after the send is recorded and before the
 * draft is removed. The attempt that takes the turn over asks the model
 * nothing. It sends the reply when the send had not begun. Otherwise it
 * sends nothing: it finds the message Gmail accepted, or the recorded
 * receipt. In each case Gmail is given the reply once, and the Case records
 * that it was sent.
 */
async function verifyAutomaticReplyRecovery(
  input: FollowUpInput,
  stop: Readonly<{
    at: "preview" | "send" | "cleanup";
    arrival: number;
    delay: number;
  }>,
) {
  const { organisationId, state } = input;
  // The three replies answer three messages on one thread, one after the
  // other. Each message is a turn of its own on the thread's Case.
  const threadId = "supplier_automatic";
  const caseId = `case_gmail_${input.rawAccount}_${threadId}`;
  const turn = `${threadId}_${stop.at}`;
  const proposalId = `proposal_${caseId}_${turn}`;
  const connectorId = gmailConnectorId(input.account);
  if (!connectorId.ok) throw new Error(connectorId.error.code);
  const currentConnector = async () => {
    const current = await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!current.ok) throw new Error(current.error.code);
    return current.value;
  };
  let connector = await currentConnector();
  const wake = () => runInDurableObject(connector, wakeForReplyTurns);
  const owed = () => runInDurableObject(connector, readReplyTurns);
  const operation = () =>
    runInDurableObject(
      connector,
      (_actor: unknown, durable: DurableObjectState) => {
        const latest = latestEmailDraftOperation(
          durable.storage.sql,
          proposalId,
        );
        return latest === null
          ? null
          : { state: latest.state, sentMessageId: latest.sentMessageId };
      },
    );
  state.arrive(stop.arrival, [
    {
      id: turn,
      threadId,
      from: "Synthetic supplier <supplier@example.test>",
    },
  ]);
  expect(
    await runInDurableObject(
      connector,
      admitArrivals.bind(null, {
        notificationId: `memory-automatic-${stop.at}`,
        historyId: String(stop.arrival + 1),
        delay: stop.delay,
      }),
    ),
  ).toMatchObject({ kind: "evaluated", admitted: 1 });
  state.arrivals = [];
  const before = {
    sends: state.sends,
    drafts: state.draftCreates,
    requests: state.followUpInputs.length,
  };
  // First attempt: the model chooses to reply at once. The reply is drafted
  // and its send begins, and the Connector stops at the chosen point.
  state.acceptedRfcMessageId = null;
  const held = state.holdAt(stop.at, turn);
  await wake();
  await expect.poll(() => held.phase, { timeout: 30_000 }).toBe("reached");
  expect(await owed()).toEqual([
    { messageId: turn, attempts: 1, claimed: 1, disposition: "reply_now" },
  ]);
  const stoppedWith = await operation();
  expect(stoppedWith).toMatchObject(
    {
      preview: { state: "awaiting_approval", sentMessageId: null },
      send: { state: "send_indeterminate", sentMessageId: null },
      cleanup: { state: "cleanup_pending", sentMessageId: expect.any(String) },
    }[stop.at],
  );
  await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) => {
      durable.abort("the instance stopped");
    },
  ).catch(() => undefined);
  connector = await currentConnector();
  held.phase = "released";
  // Second attempt: it finishes the reply.
  await wake();
  await expect.poll(owed, { timeout: 30_000 }).toEqual([]);
  // The model was asked by the first attempt only, one draft was made, and
  // Gmail was given the reply once.
  expect({
    requests: state.followUpInputs.length - before.requests,
    sends: state.sends - before.sends,
    drafts: state.draftCreates - before.drafts,
  }).toEqual({ requests: 3, sends: 1, drafts: 1 });
  const finishedWith = await operation();
  expect(finishedWith?.sentMessageId).toEqual(expect.any(String));
  const parsedCase = parseCaseId(caseId);
  if (!parsedCase.ok) throw new Error(parsedCase.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: parsedCase.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const proposals = await caseActor.value.readEmailProposals();
  if (!proposals.ok) throw new Error(proposals.error.code);
  const onCase = proposals.value
    .filter((proposal) => proposal.proposalId === proposalId)
    .map((proposal) => proposal.lifecycle);
  expect(onCase).toEqual([
    {
      kind: "sent",
      providerMessageId: finishedWith?.sentMessageId,
      sentAt: expect.any(Number),
    },
  ]);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const assignments = snapshot.value.assignmentLifecycles
    .filter((lifecycle) =>
      lifecycle.assignment.assignmentId.startsWith(
        `assignment_${caseId}_${turn}`,
      ),
    )
    .map((lifecycle) => ({
      assignmentId: lifecycle.assignment.assignmentId,
      state: lifecycle.kind,
      disposition:
        lifecycle.kind === "settled"
          ? lifecycle.disposition.kind === "failed"
            ? `failed:${lifecycle.disposition.code}`
            : lifecycle.disposition.kind
          : null,
    }));
  expect(assignments).toEqual([
    {
      assignmentId: `assignment_${caseId}_${turn}`,
      state: "settled",
      disposition: "abandoned",
    },
    {
      assignmentId: `assignment_${caseId}_${turn}_attempt_2`,
      state: "settled",
      disposition: "completed",
    },
  ]);
  return {
    stoppedAt: stop.at,
    stoppedWith,
    finishedWith,
    onCase,
    assignments,
    modelRequests: { first: 3, second: 0 },
    sends: state.sends - before.sends,
  };
}

/** Ends the running instance of the Session of one attempt at a mail turn. */
async function stopMailTurnSession(
  organisationId: OrganisationId,
  caseId: string,
  attemptKey: string,
): Promise<void> {
  const sessionId = parseSessionId(emailTurnSessionId(caseId, attemptKey));
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const session = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!session.ok) throw new Error(session.error.code);
  await runInDurableObject(
    session.value,
    (_actor: unknown, durable: DurableObjectState) => {
      durable.abort("the instance stopped");
    },
  ).catch(() => undefined);
}

async function verifySupplierMemoryTurn(
  input: Readonly<{
    context: TestContext;
    organisation: OrganisationActorStub;
    organisationId: OrganisationId;
    owner: Awaited<ReturnType<typeof client>>;
    admission: Awaited<ReturnType<typeof verifySupplierAdmissionBinding>>;
    account: IntegrationAccountId;
    fixture: DraftTurnFixture;
    state: CaseContextCollectionReplyProvider;
    protectedFlow: ReturnType<typeof readEmailProposalFlow>;
    supplierMemory: SupplierMemoryFixture;
    correction: Awaited<ReturnType<typeof verifySupplierReplyCorrection>>;
    rawAccount: string;
    connector: FollowUpInput["connector"];
    supplierId: string;
  }>,
): Promise<void> {
  const { supplierMemory, state } = input;
  // The model was shown the supplier's Memory with its request. It was not
  // shown the private note or the other supplier's fact.
  const firstRequest = state.modelInputs[0] ?? "";
  expect(firstRequest).toContain(SUPPLIER_MEMORY_FACT);
  expect(state.modelInputs.join("\n")).not.toContain(PRIVATE_MEMORY_FACT);
  expect(state.modelInputs.join("\n")).not.toContain(
    OTHER_SUPPLIER_MEMORY_FACT,
  );
  // The Session recorded the accepted bundle and what its prompt carried.
  const caseId = parseCaseId(input.fixture.caseId);
  const sessionId = parseSessionId(
    emailTurnSessionId(
      input.fixture.caseId,
      input.fixture.messageIds.at(-1) ?? "",
    ),
  );
  if (!caseId.ok || !sessionId.ok) throw new Error("mail Case identity");
  const session = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: input.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!session.ok) throw new Error(session.error.code);
  const turnId = `turn_email_${input.fixture.messageIds.at(-1)}`;
  const records = await runInDurableObject(
    session.value,
    (_actor: unknown, durable: DurableObjectState) =>
      readSessionTurnMemoryRecords(durable.storage.sql, {
        turnId,
        organisationId: input.organisationId,
        sessionId: sessionId.value,
      }),
  );
  const admitted = [{ memoryId: supplierMemory.shared, revision: 1 }];
  // One attempt ran, so one record exists.
  expect(records).toMatchObject({
    ok: true,
    value: [
      {
        outcome: { kind: "admitted", revisions: admitted },
        rendering: { revisions: admitted, omittedForBytes: false },
      },
    ],
  });
  const record = records.ok ? records.value[0] : undefined;
  // The operator reads the same result in the execution read of the Case.
  const turnMemoryExecution = await verifyMailTurnMemoryExecution({
    organisationId: input.organisationId,
    owner: input.owner,
    caseId: input.fixture.caseId,
    sessionId: sessionId.value,
    turnId,
    shown: admitted,
    statements: [SUPPLIER_MEMORY_FACT, PRIVATE_MEMORY_FACT],
  });
  // The proposal's flow carries the Memory's own clause, which no other
  // source in the turn has. The draft, preview and send checks therefore all
  // include the Memory's restrictions.
  expect(input.protectedFlow).toMatchObject({
    binding: {
      flowLabel: {
        policies: expect.arrayContaining([
          expect.objectContaining({
            readers: expect.arrayContaining([MEMORY_REVIEWERS]),
          }),
        ]),
      },
    },
  });
  // After revocation the supplier's reader no longer offers that Memory. This
  // probe admits every label, so the private note is all that remains.
  const execution = await requireMailFixtureScope(input.organisationId);
  const read = (messageId: string = input.fixture.messageIds.at(-1) ?? "") =>
    createMailboxTurnMemoryReader({
      env,
      execution,
      organisationId: input.organisationId,
      integrationAccountId: input.account,
      caseId: caseId.value,
      messageId,
      skillIds: [],
      destinationMayReceive: async () => "allow",
      now: Date.now(),
    }).read({ limit: 12, admits: async () => true });
  const before = await read();
  expect(before).toMatchObject({ kind: "read" });
  expect(
    before.kind === "read"
      ? before.candidates.map((candidate) => candidate.memoryId).sort()
      : [],
  ).toEqual([supplierMemory.shared, supplierMemory.privateNote].sort());
  const revoked = await input.organisation.commandMemory({
    organisationId: input.organisationId,
    principal: { kind: "operator", personId: "person_memory_reviewer" },
    body: {
      commandId: "supplier_memory_revoke_shared",
      expectedRevision: 1,
      kind: "revoke",
      memoryId: supplierMemory.shared,
      revision: 1,
    } satisfies MemoryCommand,
    flowLabel: null,
  });
  expect(revoked).toMatchObject({ ok: true, value: { state: "revoked" } });
  const after = await read();
  expect(
    after.kind === "read"
      ? after.candidates.map((candidate) => candidate.memoryId)
      : null,
  ).toEqual([supplierMemory.privateNote]);
  // A Memory resting on the recorded correction carries the proposal's label
  // and is offered while that exact version stands. One resting on a body
  // the Connector never recorded is known to be unsupported and is left out.
  const { correction } = input;
  const fromCorrection = await supplierMemory.accepted(
    "from_correction",
    "Next-day orders for this supplier close at noon.",
    supplierMemory.supplierScope,
    correction.label,
    correction.evidence,
  );
  const unsupported = await supplierMemory.accepted(
    "from_unrecorded_body",
    "This supplier accepts changes until 15:00.",
    supplierMemory.supplierScope,
    correction.label,
    {
      ...correction.evidence,
      digest: correction.correction.correctedBodyDigest,
    },
  );
  const resting = await read();
  const offered =
    resting.kind === "read"
      ? resting.candidates.map((candidate) => candidate.memoryId)
      : [];
  expect(offered).toContain(fromCorrection);
  expect(offered).not.toContain(unsupported);

  // Review in the Portal. A candidate resting on the correction carries the
  // proposal's label, which names the mailbox. The mailbox belongs to the
  // whole Organisation, so each member reads it (Plan 27C).
  const { organisationId, owner } = input;
  const listed = () => listedMemories(organisationId, owner.session);
  // The candidate is the one the mailbox agent proposed from the correction.
  const candidate = correction.learned.memoryId;
  const reviewable = await listed();
  expect(reviewable).toContain(candidate);
  expect(reviewable).toContain(fromCorrection);
  // The supplier's Memory cites that supplier's earlier email in the same
  // mailbox, so it is in the Portal too.
  expect(reviewable).toContain(supplierMemory.shared);
  expect(reviewable).not.toContain(unsupported);
  // A candidate that also rests on another person's own input is withheld.
  const correctionLabel = await FlowLabel.restore(correction.label);
  const elsewhere = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId },
      readers: [{ kind: "person", personId: "person_memory_private" }],
    },
  ]);
  if (!correctionLabel.ok || !elsewhere.ok) throw new Error("review labels");
  const withOtherSource = await joinFlowLabels(
    correctionLabel.value,
    elsewhere.value,
  );
  // One bound to another supplier contact shows: a recipient limits where a
  // reply may go, not who in the Organisation reads it.
  const bound = correctionLabel.value.policies.find(
    (policy) => policy.owner.kind === "recipient_constraint",
  );
  if (bound?.owner.kind !== "recipient_constraint")
    throw new Error("recipient constraint missing");
  const otherRecipient = await FlowLabel.create([
    {
      owner: {
        ...bound.owner,
        recipient: { ...bound.owner.recipient, contactId: "contact_elsewhere" },
      },
      readers: bound.readers,
    },
  ]);
  if (!withOtherSource.ok || !otherRecipient.ok)
    throw new Error("review labels");
  const forOtherRecipient = await joinFlowLabels(
    correctionLabel.value,
    otherRecipient.value,
  );
  if (!forOtherRecipient.ok) throw new Error("review labels");
  const hiddenByOtherSource = await supplierMemory.proposed(
    "other_source",
    "A note that also rests on a record this operator cannot read.",
    supplierMemory.supplierScope,
    canonicalFlowLabel(withOtherSource.value),
    correction.evidence,
  );
  const boundToOtherRecipient = await supplierMemory.proposed(
    "other_recipient",
    "A note bound to another supplier contact.",
    supplierMemory.supplierScope,
    canonicalFlowLabel(forOtherRecipient.value),
    correction.evidence,
  );
  const afterOthers = await listed();
  expect(afterOthers).toContain(candidate);
  expect(afterOthers).not.toContain(hiddenByOtherSource);
  expect(afterOthers).toContain(boundToOtherRecipient);
  const acceptCandidate = (commandId: string, memoryId: string) =>
    memoryCommand(organisationId, owner.session, {
      commandId,
      expectedRevision: 1,
      kind: "accept",
      memoryId,
      revision: 1,
    });
  const unavailable = {
    status: 404,
    body: { ok: false, error: "memory_unavailable" },
  };
  expect(
    await acceptCandidate("supplier_review_other_source", hiddenByOtherSource),
  ).toEqual(unavailable);
  // The operator accepts the candidate through the Portal, and the
  // supplier's next turn is offered that revision.
  expect(
    await acceptCandidate("supplier_review_accept", candidate),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 1, state: "accepted" } },
  });
  const afterReview = await read();
  expect(
    afterReview.kind === "read"
      ? afterReview.candidates.map((offer) => offer.memoryId)
      : [],
  ).toContain(candidate);
  // The supplier writes again. The reply to that message uses the accepted
  // revision. A second message on the thread is then answered through two
  // interruptions.
  const followUp: FollowUpInput = {
    organisationId,
    owner,
    account: input.account,
    rawAccount: input.rawAccount,
    connector: input.connector,
    fixture: input.fixture,
    state,
    supplierId: input.supplierId,
    learned: candidate,
    fromCorrection,
  };
  const freshReply = await verifySupplierFreshReply(followUp);
  const capabilityPolicy = await verifyReplyCapabilityPolicy(
    followUp,
    freshReply.proposalId,
  );
  const recovery = await verifyInterruptedReplyRecovery(followUp);
  const promptByteLimit = await verifyPromptByteLimit(
    followUp,
    recovery.proposalId,
  );
  const stoppedActors = await verifyStoppedActorsRecovery(followUp);
  const learningRecovery = await verifyLearningTurnRecovery(
    followUp,
    stoppedActors.proposalId,
  );
  const automaticReply = {
    beforeSend: await verifyAutomaticReplyRecovery(followUp, {
      at: "preview",
      arrival: 1007,
      delay: 600_000,
    }),
    duringSend: await verifyAutomaticReplyRecovery(followUp, {
      at: "send",
      arrival: 1009,
      delay: 1_200_000,
    }),
    beforeCleanup: await verifyAutomaticReplyRecovery(followUp, {
      at: "cleanup",
      arrival: 1011,
      delay: 1_800_000,
    }),
  };
  // The reply that waits for approval keeps the revisions its turn was
  // shown. While both are in force its review opens.
  const waitingConnectorId = gmailConnectorId(followUp.account);
  if (!waitingConnectorId.ok) throw new Error(waitingConnectorId.error.code);
  const waitingConnector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: waitingConnectorId.value,
    now: Date.now(),
  });
  if (!waitingConnector.ok) throw new Error(waitingConnector.error.code);
  const keptWithReply = await runInDurableObject(
    waitingConnector.value,
    (_actor: unknown, durable: DurableObjectState) =>
      readEmailProposalMemory(durable.storage.sql, recovery.proposalId),
  );
  expect(keptWithReply).toHaveLength(2);
  expect(keptWithReply).toEqual(
    expect.arrayContaining([
      { memoryId: candidate, revision: 1 },
      { memoryId: fromCorrection, revision: 1 },
    ]),
  );
  const whileInForce = await reviewSend(
    organisationId,
    owner.session,
    recovery.proposalId,
    null,
    {},
  );
  const openReview: unknown = await whileInForce.json();
  expect(whileInForce.status, JSON.stringify(openReview)).toBe(200);
  // The review lists the Memory the draft used, by its statement, for the
  // operator who may inspect it.
  const usedForDraft =
    isRecord(openReview) && Array.isArray(openReview.memory)
      ? openReview.memory
      : null;
  expect(usedForDraft).toHaveLength(2);
  expect(usedForDraft).toEqual(
    expect.arrayContaining([
      { memory_id: candidate, revision: 1, statement: LEARNED_FACT },
      {
        memory_id: fromCorrection,
        revision: 1,
        statement: expect.any(String),
      },
    ]),
  );
  // The reply drew on a collected relationship. Once that relationship is
  // detached the proposal's sources no longer stand at the revision it
  // cited, so its correction supports nothing: the turn is no longer offered
  // either Memory, and the Portal no longer lists them.
  expect(
    await input.organisation.reviewCaseContextCollectionRelationship({
      organisationId,
      actorId: owner.identity.userId,
      caseContextCollectionId: "case_context_collection_supplier_reply",
      body: {
        commandId: "detach_for_memory_review",
        expectedRevision: 2,
        decision: {
          kind: "detach",
          relationshipId: "relationship_supplier_reply",
        },
      },
    }),
  ).toMatchObject({ ok: true, value: { revision: 3 } });
  const afterDetach = await read();
  const offeredAfterDetach =
    afterDetach.kind === "read"
      ? afterDetach.candidates.map((offer) => offer.memoryId)
      : null;
  expect(offeredAfterDetach).not.toBeNull();
  expect(offeredAfterDetach).not.toContain(candidate);
  expect(offeredAfterDetach).not.toContain(fromCorrection);
  const listedAfterDetach = await listed();
  expect(listedAfterDetach).not.toContain(candidate);
  expect(listedAfterDetach).not.toContain(fromCorrection);
  // The waiting reply was drafted with those revisions, and they no longer
  // stand. The reply may not be relied on, so its review is refused. A fresh
  // turn has to draft it again.
  const afterChange = await reviewSend(
    organisationId,
    owner.session,
    recovery.proposalId,
    null,
    {},
  );
  const memoryChanged = {
    status: afterChange.status,
    body: await afterChange.json(),
  };
  expect(memoryChanged.status).not.toBe(200);
  expect(memoryChanged.body).toEqual({
    ok: false,
    error: "email_memory_changed",
  });
  // A message with no verified contact binding has no supplier. That is a
  // known absence, so the read completes and offers nothing.
  const withoutBinding = await read("message_without_receipt");
  expect(withoutBinding).toEqual({
    kind: "read",
    candidates: [],
    more: false,
  });
  // A record the verification rests on that cannot be interpreted leaves the
  // supplier unknown. The read is then unavailable, never empty.
  await fixtureDatabase().prepare(
    "UPDATE underclerk_merchant_binding SET updated_at = 9223372036854775807 WHERE organisation_id = ?",
  )
    .bind(input.organisationId)
    .run();
  const unreadable = await read();
  expect(unreadable).toEqual({ kind: "unavailable" });
  // The reply that waits for approval is bound to the supplier's verified
  // contact. That verification can no longer be established, so the reply
  // names no recipient and its review is refused.
  const refused = await reviewSend(
    organisationId,
    owner.session,
    recovery.proposalId,
    null,
    {},
  );
  const refusedReview = { status: refused.status, body: await refused.json() };
  expect(refusedReview.status).not.toBe(200);
  expect(refusedReview.body).toEqual({
    ok: false,
    error: "email_disclosure_denied",
  });
  Object.assign(input.context.task.meta, {
    turnMemoryExecution,
    memoryMailbox: {
      supplierWithoutBinding: withoutBinding,
      supplierDependencyUnreadable: unreadable,
      memories: {
        shared: supplierMemory.shared,
        privateNote: supplierMemory.privateNote,
        otherSupplier: supplierMemory.otherSupplier,
      },
      turnId,
      recorded: record,
      modelSawSupplierMemory: firstRequest.includes(SUPPLIER_MEMORY_FACT),
      modelSawPrivateNote: state.modelInputs
        .join("\n")
        .includes(PRIVATE_MEMORY_FACT),
      offeredAfterRevocation:
        after.kind === "read"
          ? after.candidates.map((candidate) => candidate.memoryId)
          : null,
      correction: {
        recorded: correction.correction,
        evidence: correction.evidence,
        portalCitation: correction.portalCitation,
        unrecordedCitation: correction.unrecordedCitation,
        unrecordedVersions: correction.unrecordedVersions,
        memoryRestingOnIt: fromCorrection,
        memoryRestingOnAnUnrecordedBody: unsupported,
        offered,
      },
      admission: input.admission,
      freshReply,
      capabilityPolicy,
      interruptedReply: recovery,
      promptByteLimit,
      stoppedActors,
      learningRecovery,
      automaticReply,
      replyAfterMemoryChanged: {
        kept: keptWithReply,
        listedInReview: usedForDraft,
        review: memoryChanged,
      },
      replyReviewAfterVerificationUnreadable: refusedReview,
      learned: correction.learned,
      review: {
        candidate,
        listedForMember: reviewable,
        hiddenByOtherSource,
        boundToOtherRecipient,
        acceptedThroughPortal: candidate,
        afterSourceDetached: {
          offered: offeredAfterDetach,
          listed: listedAfterDetach,
        },
      },
    },
  });
}

class CaseContextCollectionReplyProvider {
  modelCalls = 0;
  modelInputs: string[] = [];
  drafts = new Map<string, string>();
  sends = 0;
  /** The body of each message that Gmail was asked to send. */
  sentBodies: string[] = [];
  draftCreates = 0;
  foreignReads = 0;
  loseSendResponse = false;
  loseDraftResponse = false;
  relatedSourceDeleted = false;
  acceptedRfcMessageId: string | null = null;
  learningInputs: string[] = [];
  async model({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const forwarded = request.clone();
    const raw: unknown = await request.json();
    // A learning turn is the one offered the tool that proposes Memory. It
    // reads the thread, proposes what the corrected reply shows, and stops.
    if (JSON.stringify(raw).includes('"propose_memory"')) {
      this.learningInputs.push(JSON.stringify(raw));
      if (this.liveLearning) {
        // The real provider answers this turn. Nothing here chooses for it.
        const response = await fetch(
          bypass(forwarded.url, {
            method: forwarded.method,
            headers: forwarded.headers,
            body: await forwarded.text(),
          }),
        );
        this.liveLearningAnswers.push({
          status: response.status,
          model:
            isRecord(raw) && typeof raw.model === "string" ? raw.model : "",
        });
        return response;
      }
      const held = this.held;
      if (
        held?.at === "model" &&
        held.phase === "armed" &&
        JSON.stringify(raw).includes(held.message)
      )
        await this.hold(held);
      if (JSON.stringify(raw).includes(RESTART_CORRECTION)) {
        const results = modelToolResults(raw);
        if (results === 0)
          return openRouterToolCall("read_email_case", {}, "restart_case");
        return results === 1
          ? openRouterToolCall(
              "propose_memory",
              { statement: RESTART_FACT, check: null },
              "restart_propose",
            )
          : openRouterText("Proposed for review.", "restart_done");
      }
      // The long correction shows nothing reusable.
      if (JSON.stringify(raw).includes(LONG_CORRECTION_MARK)) {
        const results = modelToolResults(raw);
        if (results === 0)
          return openRouterToolCall("read_email_case", {}, "long_case");
        return results === 1
          ? openRouterToolCall("no_memory", {}, "long_none")
          : openRouterText("Nothing to remember.", "long_done");
      }
      switch (this.learningInputs.length) {
        case 1:
          return openRouterToolCall("read_email_case", {}, "learning_case");
        case 2:
          return openRouterToolCall(
            "propose_memory",
            { statement: LEARNED_FACT, check: LEARNED_CHECK },
            "learning_propose",
          );
        default:
          return openRouterText("Proposed for review.", "learning_done");
      }
    }
    const text = JSON.stringify(raw);
    // An eval turn reads its scenario, then answers as the Memory in its
    // prompt says: a change at or after the cutoff the prompt states goes to
    // a person, and anything else is confirmed.
    const evalMessage = EVAL_TURN_MESSAGE.exec(text)?.[1];
    if (evalMessage !== undefined) {
      this.evalInputs.push(text);
      if (!this.evalMessages.includes(evalMessage))
        this.evalMessages.push(evalMessage);
      if (this.liveEvals) {
        // The real provider answers this turn. Nothing here chooses for it.
        const response = await fetch(
          bypass(forwarded.url, {
            method: forwarded.method,
            headers: forwarded.headers,
            body: await forwarded.text(),
          }),
        );
        this.liveEvalAnswers.push({
          status: response.status,
          model:
            isRecord(raw) && typeof raw.model === "string" ? raw.model : "",
        });
        return response;
      }
      // The provider's own answer to a key whose credit is spent.
      if (this.evalCreditSpent)
        return HttpResponse.json(
          {
            error: {
              message:
                "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
              code: 402,
            },
          },
          { status: 402 },
        );
      const held = this.held;
      if (
        held?.at === "model" &&
        held.phase === "armed" &&
        held.message ===
          evalTurn(
            this.evalMessages.indexOf(evalMessage) + 1 - this.evalTurnsAtHold,
          )
      )
        await this.hold(held);
      const toolResults = modelToolResults(raw);
      if (toolResults === 0)
        return openRouterToolCall("read_email_case", {}, "eval_case");
      if (toolResults > 1) return openRouterText("Settled.", "eval_done");
      const choice = evalAgentChoice(text);
      return openRouterToolCall(
        choice.tool,
        choice.tool === "email_reply_for_approval"
          ? { body: choice.body, sources: null }
          : { body: choice.body },
        "eval_choice",
      );
    }
    // The sources journey's turn reads the thread and the order its message
    // names, then cites what it read and what it never read.
    if (/Gmail thread supplier_sources\b/u.test(text)) {
      this.sourcesInputs.push(text);
      const toolResults = modelToolResults(raw);
      if (toolResults === 0)
        return openRouterToolCall("read_email_case", {}, "sources_case");
      if (toolResults === 1)
        return openRouterToolCall(
          "read_order",
          { orderId: MAIL_SOURCE_ORDER_ID },
          "sources_order",
        );
      if (toolResults > 2) return openRouterText("Settled.", "sources_done");
      const memoryRef = (statement: string) =>
        new RegExp(
          `\\[(memory:[^\\]]+)\\] ${statement.replaceAll(".", "\\.")}`,
          "u",
        ).exec(text)?.[1] ?? "memory:unknown";
      return openRouterToolCall(
        "email_reply_for_approval",
        {
          body: SOURCES_REPLY,
          sources: [
            {
              source: `order:${MAIL_SOURCE_ORDER_ID}`,
              text: SOURCES_ORDER_WORDS,
            },
            {
              source: memoryRef(SOURCES_MEMORY_FACT),
              text: SOURCES_MEMORY_WORDS,
            },
            // The supplier's Memory reached the turn, and this operator may
            // not inspect it.
            {
              source: memoryRef(SUPPLIER_MEMORY_FACT),
              text: SOURCES_MEMORY_WORDS,
            },
            // A record this turn never read.
            { source: "order:order_9999", text: SOURCES_ORDER_WORDS },
            { source: "purchase_request:PR-842", text: SOURCES_MEMORY_WORDS },
            // Words that are not in the reply.
            {
              source: `order:${MAIL_SOURCE_ORDER_ID}`,
              text: "Your refund is on its way.",
            },
            { source: 5, text: SOURCES_ORDER_WORDS },
          ],
        },
        "sources_reply",
      );
    }
    // A turn on mail that arrived after the anchor names its thread. It
    // reads the thread, then answers the supplier and leaves the stranger.
    const followUp =
      /Gmail thread (supplier_followup|stranger_thread|supplier_restart|supplier_automatic|supplier_settings_[a-z]+)\b/u.exec(
        text,
      );
    if (followUp !== null) {
      this.followUpInputs.push(text);
      const held = this.held;
      if (
        held?.at === "model" &&
        held.phase === "armed" &&
        text.includes(held.message)
      ) {
        // The provider is down for this turn until the journey restores it.
        this.modelOutage = true;
        await this.hold(held);
      }
      if (this.modelOutage && text.includes("supplier_followup_second"))
        return new Response(null, { status: 503 });
      const toolResults = modelToolResults(raw);
      if (toolResults === 0)
        return openRouterToolCall("read_email_case", {}, "follow_up_case");
      if (toolResults > 1) return openRouterText("Settled.", "follow_up_done");
      if (followUp[1] === "supplier_automatic")
        return openRouterToolCall(
          "email_reply_now",
          {
            // The request names the message it answers.
            body: automaticReply(
              /supplier_automatic_(?:preview|send|cleanup)/u.exec(text)?.[0] ??
                "",
            ),
          },
          "follow_up_reply_now",
        );
      // The stranger's text asks for a direct reply, and the agent obeys.
      return followUp[1] === "stranger_thread"
        ? openRouterToolCall(
            "email_reply_now",
            { body: STRANGER_REPLY },
            "follow_up_stranger_reply_now",
          )
        : openRouterToolCall(
            "email_reply_for_approval",
            { body: FOLLOW_UP_REPLY, sources: null },
            "follow_up_reply",
          );
    }
    this.modelInputs.push(text);
    this.modelCalls++;
    switch (this.modelCalls) {
      case 1:
        return openRouterToolCall("read_email_case", {}, "case_context_collection_case");
      case 2:
        return openRouterToolCall(
          "read_email_attachment",
          { messageId: "foreign_message", attachmentId: "foreign_attachment" },
          "case_context_collection_foreign",
        );
      case 3:
        return openRouterToolCall(
          "read_supplier_delay_context",
          { purchaseRequestId: "PR-842" },
          "case_context_collection_merchant_private",
        );
      case 4:
        return openRouterToolCall(
          "read_case_context_collection_evidence",
          {},
          "case_context_collection_related",
        );
      case 5:
        return openRouterToolCall(
          "email_reply_for_approval",
          {
            body: "PR-842 arrives Friday. Please confirm the delivery.",
            sources: null,
          },
          "case_context_collection_reply",
        );
      default:
        return openRouterText("Prepared for review.", "case_context_collection_done");
    }
  }
  followUpInputs: string[] = [];
  sourcesInputs: string[] = [];
  evalInputs: string[] = [];
  /** The message of each Eval turn that asked the model, in order. */
  evalMessages: string[] = [];
  /** How many Eval turns had asked the model when the hold was armed. */
  evalTurnsAtHold = 0;
  /** Forward each Eval turn to the real model provider. */
  liveEvals = false;
  /** Answer each Eval turn as the provider answers a key with no credit. */
  evalCreditSpent = false;
  /** Forward the learning turn to the real model provider. */
  liveLearning = false;
  liveLearningAnswers: { status: number; model: string }[] = [];
  liveEvalAnswers: { status: number; model: string }[] = [];
  modelOutage = false;
  /** Mail that arrived after the anchor, as Gmail holds it. */
  inbox = new Map<
    string,
    Readonly<{ threadId: string; from: string; body?: string }>
  >();
  /** The arrivals the next history read reports, and its history id. */
  arrivals: readonly string[] = [];
  historyId = 1001;
  arrive(
    historyId: number,
    messages: readonly Readonly<{
      id: string;
      threadId: string;
      from: string;
      body?: string;
    }>[],
  ): void {
    for (const message of messages) this.inbox.set(message.id, message);
    this.arrivals = messages.map((message) => message.id);
    this.historyId = historyId;
  }
  /**
   * One provider call the journey stops, to end the Actor during it. The
   * call and the journey run in different Actors, so each watches the phase.
   */
  held: {
    readonly at: "model" | "acknowledgement" | "preview" | "send" | "cleanup";
    /** The message whose model request a hold at the model stops. */
    readonly message: string;
    phase: "armed" | "reached" | "released";
  } | null = null;
  holdAt(
    at: "model" | "acknowledgement" | "preview" | "send" | "cleanup",
    message = "supplier_followup_second",
  ) {
    const held: NonNullable<CaseContextCollectionReplyProvider["held"]> = {
      at,
      message,
      phase: "armed",
    };
    this.held = held;
    this.evalTurnsAtHold = this.evalMessages.length;
    return held;
  }
  private async hold(
    held: NonNullable<CaseContextCollectionReplyProvider["held"]>,
  ): Promise<void> {
    held.phase = "reached";
    while (held.phase === "reached") await scheduler.wait(5);
  }
  draftThreads = new Map<string, string>();
  async read({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/history"))
      return HttpResponse.json({
        historyId: String(this.historyId),
        history: this.arrivals.map((id, index) => ({
          id: String(this.historyId + index),
          messagesAdded: [
            {
              message: { id, threadId: this.inbox.get(id)?.threadId ?? "" },
            },
          ],
        })),
      });
    const arrived = [...this.inbox].find(([id]) =>
      path.endsWith(`/messages/${id}`),
    );
    // What Gmail returns for the message. A metadata read takes the headers
    // it named from it, and a full read takes the body too.
    if (arrived !== undefined)
      return HttpResponse.json({
        id: arrived[0],
        threadId: arrived[1].threadId,
        internalDate: "1790726400000",
        sizeEstimate: 200,
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: arrived[1].from },
            { name: "To", value: "shop@example.test" },
            { name: "Subject", value: "Tomorrow's order" },
            { name: "Message-ID", value: `<${arrived[0]}@example.test>` },
          ],
          body: {
            data: encodeBase64Url(
              new TextEncoder().encode(
                arrived[1].body ?? "Can we still change tomorrow's order?",
              ),
            ),
          },
        },
      });
    if (path.endsWith("/drafts")) {
      const query = new URL(request.url).searchParams.get("q");
      const drafts: { id: string }[] = [];
      for (const [id, encoded] of this.drafts) {
        const messageId = decodeRaw(encoded)
          .split("\r\n")
          .find(isMessageIdHeader)
          ?.slice("Message-ID: ".length);
        if (query === `rfc822msgid:${messageId}`) drafts.push({ id });
      }
      return HttpResponse.json({ drafts });
    }
    if (path.includes("foreign_message")) {
      this.foreignReads++;
      return HttpResponse.json({ secret: "FOREIGN_CUSTOMER_SECRET" });
    }
    if (
      path.endsWith("/messages/case_context_collection_anchor_message") ||
      path.endsWith("/messages/case_context_collection_related_message")
    ) {
      const related = path.endsWith("case_context_collection_related_message");
      if (related && this.relatedSourceDeleted)
        return new Response(null, { status: 404 });
      return HttpResponse.json({
        id: related ? "case_context_collection_related_message" : "case_context_collection_anchor_message",
        threadId: related ? "case_context_collection_related" : "case_context_collection_anchor",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "supplier@example.test" },
            { name: "To", value: "shop@example.test" },
            { name: "Subject", value: "PR-842 delivery" },
            {
              name: "Message-ID",
              value: related
                ? "<related@example.test>"
                : "<anchor@example.test>",
            },
          ],
          body: {
            data: encodeBase64Url(
              new TextEncoder().encode(
                related
                  ? "AUTHORIZED_DELIVERY_FACT: PR-842 arrives Friday"
                  : "Please confirm our PR-842 delivery.",
              ),
            ),
          },
        },
      });
    }
    const draftId = path.split("/").at(-1) ?? "";
    const encoded = this.drafts.get(draftId);
    if (encoded !== undefined) {
      const previewing = this.held;
      if (
        previewing?.at === "preview" &&
        previewing.phase === "armed" &&
        caseContextCollectionDraftBody(encoded) ===
          automaticReply(previewing.message)
      ) {
        // The Connector stops while it reads the draft it is about to send.
        await this.hold(previewing);
        return new Response(null, { status: 503 });
      }
      return caseContextCollectionProviderDraft(
        draftId,
        encoded,
        this.draftThreads.get(draftId) ?? "case_context_collection_anchor",
      );
    }
    if (path.endsWith("/messages")) {
      const query = new URL(request.url).searchParams.get("q");
      const found =
        this.acceptedRfcMessageId !== null &&
        query === `rfc822msgid:${this.acceptedRfcMessageId}`;
      return HttpResponse.json({
        messages: found
          ? [{ id: "sent_case_context_collection_2", threadId: "case_context_collection_anchor" }]
          : [],
      });
    }
    if (path.endsWith("/profile"))
      return HttpResponse.json({
        emailAddress: "shop@example.test",
        historyId: "100",
      });
    throw new Error(`Unexpected CaseContextCollection Gmail read ${path}`);
  }
  draftUpdates = 0;
  /** Each message Gmail accepted and answered for, with the id it gave. */
  sent: { id: string; raw: string }[] = [];
  async update({
    request,
    params,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const raw: unknown = await request.json();
    const draftId = String(params.draftId);
    if (
      !this.drafts.has(draftId) ||
      !isRecord(raw) ||
      !isRecord(raw.message) ||
      typeof raw.message.raw !== "string"
    )
      throw new Error("Invalid Gmail draft update");
    this.drafts.set(draftId, raw.message.raw);
    this.draftUpdates++;
    return HttpResponse.json({
      id: draftId,
      message: { id: `${draftId}_message_${this.draftUpdates}` },
    });
  }
  async write({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const raw: unknown = await request.json();
    const path = new URL(request.url).pathname;
    if (path.endsWith("/watch"))
      return HttpResponse.json({
        historyId: "1000",
        expiration: String(Date.now() + 3600000),
      });
    if (!isRecord(raw)) throw new Error("Invalid Gmail write");
    if (path.endsWith("/messages/send")) {
      this.sends++;
      if (typeof raw.raw === "string")
        this.sentBodies.push(caseContextCollectionDraftBody(raw.raw));
      const sending = this.held;
      if (
        sending?.at === "send" &&
        sending.phase === "armed" &&
        typeof raw.raw === "string" &&
        caseContextCollectionDraftBody(raw.raw) ===
          automaticReply(sending.message)
      ) {
        // Gmail accepts the message, and its answer never arrives.
        this.acceptedRfcMessageId =
          decodeRaw(raw.raw)
            .split("\r\n")
            .find(isMessageIdHeader)
            ?.slice("Message-ID: ".length) ?? null;
        await this.hold(sending);
        return new Response(null, { status: 503 });
      }
      if (this.loseSendResponse) {
        if (typeof raw.raw !== "string")
          throw new Error("Missing accepted send body");
        this.acceptedRfcMessageId =
          decodeRaw(raw.raw)
            .split("\r\n")
            .find(isMessageIdHeader)
            ?.slice("Message-ID: ".length) ?? null;
        this.loseSendResponse = false;
        return new Response(null, { status: 503 });
      }
      const id = `sent_case_context_collection_${this.sends}`;
      if (typeof raw.raw === "string") this.sent.push({ id, raw: raw.raw });
      return HttpResponse.json({
        id,
        threadId:
          typeof raw.threadId === "string"
            ? raw.threadId
            : "case_context_collection_anchor",
      });
    }
    if (!isRecord(raw.message) || typeof raw.message.raw !== "string")
      throw new Error("Invalid Gmail draft");
    const held = this.held;
    if (
      held?.at === "acknowledgement" &&
      held.phase === "armed" &&
      caseContextCollectionDraftBody(raw.message.raw) === ACKNOWLEDGEMENT
    ) {
      // The request never reaches Gmail: no draft is made.
      await this.hold(held);
      return new Response(null, { status: 503 });
    }
    this.draftCreates++;
    const draftId = `draft_case_context_collection_${this.draftCreates}`;
    this.drafts.set(draftId, raw.message.raw);
    if (typeof raw.message.threadId === "string")
      this.draftThreads.set(draftId, raw.message.threadId);
    if (this.loseDraftResponse) {
      this.loseDraftResponse = false;
      return new Response(null, { status: 503 });
    }
    return HttpResponse.json({
      id: draftId,
      message: {
        id: `message_${draftId}`,
        threadId:
          this.draftThreads.get(draftId) ?? "case_context_collection_anchor",
      },
    });
  }
  async remove({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const draftId = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const removing = this.held;
    const raw = this.drafts.get(draftId);
    if (
      removing?.at === "cleanup" &&
      removing.phase === "armed" &&
      raw !== undefined &&
      caseContextCollectionDraftBody(raw) === automaticReply(removing.message)
    ) {
      // The sent reply's draft is still in Gmail when the Connector stops.
      await this.hold(removing);
      return new Response(null, { status: 503 });
    }
    this.drafts.delete(draftId);
    return new Response(null, { status: 204 });
  }
}
/** The plain-text body of a raw message as the Connector built it. */
function caseContextCollectionDraftBody(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(
      (decodeRaw(encoded).split("\r\n\r\n")[1] ?? "").replaceAll(/\s+/gu, ""),
    ) ?? new Uint8Array(),
  );
}

/** The request text of one model request: what the turn's prompt was. */
function modelPrompt(request: string): string {
  const raw: unknown = JSON.parse(request);
  const user =
    isRecord(raw) && Array.isArray(raw.messages)
      ? raw.messages.find(
          (message: unknown) => isRecord(message) && message.role === "user",
        )
      : undefined;
  const content: unknown = isRecord(user) ? user.content : undefined;
  if (typeof content === "string") return content;
  const part: unknown = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(part) || typeof part.text !== "string")
    throw new Error("Model request has no prompt");
  return part.text;
}

function caseContextCollectionProviderDraft(
  draftId: string,
  encoded: string,
  threadId: string,
): Response {
  const headers = decodeRaw(encoded).split("\r\n\r\n")[0]?.split("\r\n");
  const header = (name: string, fallback: string) =>
    headers
      ?.find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? fallback;
  return HttpResponse.json({
    id: draftId,
    message: {
      id: `message_${draftId}`,
      threadId,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "shop@example.test" },
          { name: "To", value: header("To", "supplier@example.test") },
          { name: "Subject", value: header("Subject", "Re: PR-842 delivery") },
        ],
        body: {
          data: encodeBase64Url(
            new TextEncoder().encode(caseContextCollectionDraftBody(encoded)),
          ),
        },
      },
    },
  });
}

function readObservationHead(_actor: unknown, state: DurableObjectState) {
  const head = readMailHead(state.storage.sql);
  if (head === null) throw new Error("Missing mail organization");
  return head;
}

function attemptFrozenMailProjection(
  scope: OrganisationExecutionScope,
  head: import("../../src/mail-inbox/types").MailOrganizationHead,
): Promise<void> {
  return projectMailClassifications({
    scope,
    head,
    work: {
      workId: "stale-projection",
      messageId: "m1",
      threadId: "t1",
      revision: 1,
      origin: "arrival",
    },
    classifications: [
      {
        messageId: "m1",
        threadId: "t1",
        ruleId: "rule_supplier",
        outcome: "not_matched",
        source: "jev",
        evaluatedAt: Date.now(),
      },
    ],
    contentDigest: "a".repeat(64),
  });
}

async function requireMailFixtureScope(organisationId: OrganisationId) {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value;
}

it(
  "lists mail with no reply for a mailbox with no agent and sends one person-written reply to the thread's sender",
  personReplyJourney,
  90_000,
);

/**
 * Plan 83: with no agent, new mail lists itself, except mail from a sender that
 * takes no replies. A person writes the reply. The recipient comes from the
 * thread, a repeated request sends nothing more, and a send that Gmail does not
 * confirm is never sent again.
 */
/** The decoded parts of a multipart reply, by content type. */
function mimeParts(message: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const section of message.split(/\r\n--satyr_[^\r\n]*\r\n/u)) {
    const type = /^Content-Type: ([a-z]+\/[a-z]+);/mu.exec(section)?.[1];
    if (type?.startsWith("multipart/") === true) continue;
    const body = section.split("\r\n\r\n")[1];
    if (type === undefined || body === undefined) continue;
    const bytes = Uint8Array.from(
      atob(body.replace(/\r\n(--satyr_[^\r\n]*--)?/gu, "")),
      (char) => char.charCodeAt(0),
    );
    parts[type] = new TextDecoder().decode(bytes);
  }
  return parts;
}

async function personReplyJourney(): Promise<void> {
  const owner = await client("p83-person-reply-owner");
  const organisationId = await workspace(owner);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const accountId = parseIntegrationAccountId(
    await mailbox(organisationId, owner, "p83-mail", "full_mailbox_pilot"),
  );
  if (!accountId.ok) throw new Error("Invalid fixture mailbox");
  const registered = await registerEmailMailboxAccount({
    db: fixtureDatabase(),
    organisationId,
    integrationAccountId: accountId.value,
    googleSubject: "p83-mail-subject",
    observedAddress: "shop@example.test",
    environment: "development",
    now: Date.now(),
  });
  if (!registered.ok) throw new Error(registered.error.code);
  const sends: string[] = [];
  const uploads: { query: string; type: string; body: string }[] = [];
  let answered = false;
  let sendFails = false;
  const noReply = {
    ...gmailMessage("n7", "t7", false),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "GitHub <noreply@github.com>" },
        { name: "Subject", value: "Storage is almost full" },
      ],
      body: {},
    },
  };
  network.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/threads/t7", () =>
      HttpResponse.json({ id: "t7", messages: [noReply] }),
    ),
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/messages/n7", () =>
      HttpResponse.json(noReply),
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/t1",
      () =>
        HttpResponse.json({
          id: "t1",
          messages: [
            gmailMessage("m1", "t1", true),
            ...(answered
              ? [
                  {
                    ...gmailMessage("m9", "t1", true, ["SENT"]),
                    internalDate: "1790726500000",
                    payload: {
                      mimeType: "text/plain",
                      headers: [
                        { name: "From", value: "Shop <shop@example.test>" },
                        { name: "Subject", value: "Re: delivery" },
                      ],
                      body: {},
                    },
                  },
                ]
              : []),
          ],
        }),
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ({ request }) => {
        // The search for a send that Gmail did not confirm finds nothing.
        if (new URL(request.url).searchParams.has("q"))
          return HttpResponse.json({ messages: [] });
        return HttpResponse.json({
          messages: [
            { id: "n7", threadId: "t7" },
            { id: "m1", threadId: "t1" },
          ],
        });
      },
    ),
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/*", gmailFixture),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      async ({ request }) => {
        const body: unknown = await request.json();
        sends.push(JSON.stringify(body));
        if (sendFails) return new Response("unavailable", { status: 503 });
        answered = true;
        return HttpResponse.json({ id: "sent-person-1", threadId: "t1" });
      },
    ),
    // A message over a few megabytes goes to Gmail's upload endpoint.
    http.post(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send",
      async ({ request }) => {
        uploads.push({
          query: new URL(request.url).search,
          type: request.headers.get("content-type") ?? "",
          body: new TextDecoder().decode(await request.arrayBuffer()),
        });
        return HttpResponse.json({ id: "sent-person-2", threadId: "t1" });
      },
    ),
  );

  const list = async (): Promise<unknown> => {
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId}/inbox-conversations`,
      {
        headers: {
          origin: "https://localhost",
          cookie: `satyr_control_session=${owner.session.token}; satyr_control_csrf=${owner.session.csrfToken}`,
        },
      },
    );
    const raw: unknown = await response.json();
    expect(response.status, JSON.stringify(raw)).toBe(200);
    return raw;
  };
  const before = await list();
  expect(before).toMatchObject({
    email: {
      kind: "read",
      unanswered: [
        {
          threadId: "t1",
          senderName: "Supplier",
          subject: "Packaging delivery delayed",
        },
      ],
    },
    whatsapp: { kind: "none" },
  });
  // GitHub's noreply@ mail waits for nobody.
  expect(JSON.stringify(before)).not.toContain("Storage is almost full");

  const reply = (key: string, body: Record<string, unknown>) =>
    exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId}/agent-mailboxes/${accountId.value}/person-reply`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://localhost",
          cookie: `satyr_control_session=${owner.session.token}; satyr_control_csrf=${owner.session.csrfToken}`,
          "x-satyr-csrf": owner.session.csrfToken,
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      },
    );
  const blank = await reply(crypto.randomUUID(), { threadId: "t1", body: " " });
  expect(blank.status).toBe(422);

  // A draft that waits on the thread decides the reply, and nothing is sent.
  const waitingAt = Date.now();
  await fixtureDatabase().prepare(
    `INSERT INTO email_reply_proposal (
       proposal_id, organisation_id, integration_account_id, case_id,
       gmail_thread_id, current_version, lifecycle_kind, created_at, updated_at
     ) VALUES ('proposal_p83_waits', ?, ?, 'case_p83_waits', 't1', 1, 'awaiting_approval', ?, ?)`,
  )
    .bind(organisationId, accountId.value, waitingAt, waitingAt)
    .run();
  const waits = await reply(crypto.randomUUID(), {
    threadId: "t1",
    body: "This must wait.",
  });
  expect(waits.status).toBe(409);
  expect(await waits.json()).toMatchObject({ error: "mail_reply_draft_waits" });
  expect(sends).toHaveLength(0);
  await fixtureDatabase().prepare(
    "DELETE FROM email_reply_proposal WHERE proposal_id = 'proposal_p83_waits'",
  ).run();

  // A failed send is looked up by its Message-ID, reported and not repeated.
  sendFails = true;
  const uncertainKey = crypto.randomUUID();
  const uncertain = await reply(uncertainKey, {
    threadId: "t1",
    body: "Friday is fine.",
  });
  expect(await uncertain.json()).toMatchObject({
    result: { kind: "send_indeterminate" },
  });
  expect(sends).toHaveLength(1);
  const uncertainAgain = await reply(uncertainKey, {
    threadId: "t1",
    body: "Friday is fine.",
  });
  expect(await uncertainAgain.json()).toMatchObject({
    result: { kind: "send_indeterminate" },
  });
  expect(sends).toHaveLength(1);

  sendFails = false;
  sends.length = 0;
  // A formatted reply sends its document. A link that is not http, https or
  // mailto is refused, and nothing goes.
  const forged = await reply(crypto.randomUUID(), {
    threadId: "t1",
    body: "Click",
    document: {
      blocks: [
        {
          kind: "paragraph",
          runs: [{ text: "Click", href: "javascript:alert(1)" }],
        },
      ],
    },
  });
  expect(forged.status).toBe(422);
  expect(sends).toHaveLength(0);
  // Gmail refuses a program file, so the reply with one is refused first.
  const program = await reply(crypto.randomUUID(), {
    threadId: "t1",
    body: "The tool.",
    attachments: [
      { name: "tool.exe", type: "application/octet-stream", data: "TVo=" },
    ],
  });
  expect(program.status).toBe(422);
  expect(await program.json()).toMatchObject({
    error: "mail_person_reply_attachment_blocked",
  });
  expect(sends).toHaveLength(0);
  const note = "%PDF-1.4 delivery note";
  const formatted = {
    threadId: "t1",
    body: "Friday is fine.",
    document: {
      blocks: [
        {
          kind: "paragraph",
          runs: [
            { text: "Friday", bold: true },
            { text: " is fine <script>alert(1)</script>" },
          ],
        },
        {
          kind: "list",
          ordered: true,
          items: [
            { runs: [{ text: "Pastry boxes" }] },
            { indent: 1, runs: [{ text: "Two trays", color: "red" }] },
          ],
        },
      ],
    },
    attachments: [
      {
        name: "Delivery note «Friday».pdf",
        type: "application/pdf",
        data: btoa(note),
      },
    ],
  };
  const key = crypto.randomUUID();
  const sent = await reply(key, formatted);
  const answer: unknown = await sent.json();
  expect(sent.status, JSON.stringify(answer)).toBe(200);
  expect(answer).toMatchObject({
    result: { kind: "sent", providerMessageId: "sent-person-1" },
  });
  const raw: unknown = JSON.parse(sends[0] ?? "{}");
  if (!isRecord(raw) || typeof raw.raw !== "string")
    throw new Error("Missing the raw reply");
  const message = atob(raw.raw.replaceAll("-", "+").replaceAll("_", "/"));
  expect(message).toContain("To: supplier@example.test");
  expect(message).toContain("Content-Type: multipart/mixed;");
  expect(message).toContain("Content-Type: multipart/alternative;");
  expect(message).toContain(
    "filename*=UTF-8''Delivery%20note%20%C2%ABFriday%C2%BB.pdf",
  );
  expect(raw.threadId).toBe("t1");
  // The server renders both parts from the document, not from the body.
  const parts = mimeParts(message);
  expect(parts["text/plain"]).toBe(
    "Friday is fine <script>alert(1)</script>\n1. Pastry boxes\n   1. Two trays",
  );
  expect(parts["text/html"]).toContain("<b>Friday</b>");
  expect(parts["text/html"]).toContain(
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
  expect(parts["text/html"]).not.toContain("<script>");
  expect(parts["text/html"]).toContain(
    '<li><span style="color:#c5221f">Two trays</span></li>',
  );
  expect(parts["application/pdf"]).toBe(note);

  // A reply with a large file goes as an upload, in the same thread.
  const large = new Uint8Array(6 * 1024 * 1024).fill(0x41);
  const uploaded = await reply(crypto.randomUUID(), {
    threadId: "t1",
    body: "The photos.",
    attachments: [
      {
        name: "photos.zip",
        type: "application/zip",
        data: encodeBase64(large),
      },
    ],
  });
  expect(await uploaded.json()).toMatchObject({
    result: { kind: "sent", providerMessageId: "sent-person-2" },
  });
  expect(sends).toHaveLength(1);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.query).toBe("?uploadType=multipart");
  expect(uploads[0]?.type).toMatch(/^multipart\/related; boundary=/u);
  expect(uploads[0]?.body).toContain('{"threadId":"t1"}');
  expect(uploads[0]?.body).toContain("Content-Type: message/rfc822");
  expect(uploads[0]?.body).toContain('filename="photos.zip"');

  // The same request does not send again.
  const repeated = await reply(key, formatted);
  expect(await repeated.json()).toEqual(answer);
  expect(sends).toHaveLength(1);

  // The thread's newest message is the mailbox's now, so the row leaves.
  expect(await list()).toMatchObject({ email: { unanswered: [] } });

  // Without the mailbox grant, the mailbox lists nothing and refuses a reply.
  answered = false;
  expect(await list()).toMatchObject({
    email: { unanswered: [{ threadId: "t1" }] },
  });
  const revoked = await revokeAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: "grant_mail_p83-mail",
    expectedRevision: 1,
    reason: "The owner loses the mailbox",
    now: Date.now(),
  });
  if (!revoked.ok) throw new Error(revoked.error.code);
  const denied = await list();
  expect(denied).toMatchObject({ email: { unanswered: [] } });
  expect(JSON.stringify(denied)).not.toContain("Packaging delivery delayed");
  const refused = await reply(crypto.randomUUID(), {
    threadId: "t1",
    body: "No access.",
  });
  expect(refused.status).toBe(403);
  expect(sends).toHaveLength(1);
}
