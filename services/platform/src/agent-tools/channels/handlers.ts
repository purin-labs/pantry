import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { resolveCollaborationAgent } from "../../actors/collaboration-agent";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { sessionTurnExecution } from "../../chat/turn-access";
import { registerEmailSelfTest } from "../../data/email-self-test";
import { resolveEmailOperationalCapability } from "../../actors/email-operational-capability";
import type { EmailProposalTarget } from "../../data/email-operational";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import type { ConnectorActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  parseCaseId,
  parseIntegrationAccountId,
  newRequestId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import {
  requireActiveOrganisationActorAtPlacement,
  resolveActiveCaseActorAtPlacement,
  resolveActiveConnectorActorAtPlacement,
} from "@purin-labs/actor-runtime/actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
  admittedSessionOperation,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "../catalog/execute";
import { EmailReplyDraftRequestError } from "./services";
import { readChatReplyProvenance } from "../../actors/email-chat-reply-sources";
import type {
  EmailChatContext,
  EmailChatSource,
} from "../../mail-inbox/reply-sources";
import type {
  HarnessEmailMailboxSearch,
  HarnessEmailMailboxSearchResult,
  HarnessEmailReplyPropose,
  HarnessEmailReplyDraft,
  HarnessEmailReplyDraftEdit,
  HarnessEmailReplyDraftRead,
  HarnessEmailReplyProposalReceipt,
  HarnessEmailOperationalPropose,
  HarnessEmailOperationalProposalReceipt,
  HarnessWhatsAppSupportInbox,
  HarnessWhatsAppSupportRead,
  HarnessWhatsAppSupportReplyReceipt,
  HarnessWhatsAppSupportReplySend,
} from "./services";
import { authorizeCapabilityUse } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import {
  parseCapabilityKey,
  type CapabilityDefinition,
} from "@purin-labs/authority/authorization/access-grants/capability-key";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
  type FlowLabel,
} from "@purin-labs/authority/policy/index";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import { listAccessGrants } from "@purin-labs/authority/data/access-grants";
import { selectActiveGrants } from "@purin-labs/authority/authorization/access-grants/compiler";
import { listOrganisationMembers } from "@purin-labs/tenancy/data/control-plane";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import {
  projectEmailReplyProposal,
  readEmailReplyProposalProjection,
} from "../../data/email-mailbox";
import { gmailConnectorId } from "../../mail-inbox/contract/connector-ids";
import {
  readWhatsAppCaseConversationWindowByCaseId,
  readWhatsAppReplyProposalProjection,
  whatsappConnectorId,
} from "../../data/whatsapp";
import type { Variant } from "@purin-labs/type-utils";
import { isNonNegativeInteger, isPositiveInteger } from "@purin-labs/std";
import {
  type EmailMailboxReadScope,
  proposalFlowEffect,
  type ToolEffect,
  collaborationEditDeadline,
  collaborationMember,
  readAccessGrantId,
  requireCurrentEmailToolLease,
  selectProviderResourceGrants,
} from "../session-support";
import type { SessionToolContext } from "../context";

export async function searchEmailMailboxForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessEmailMailboxSearch,
): Promise<HarnessEmailMailboxSearchResult> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const integrationAccountId = parseIntegrationAccountId(
    request.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new Error("Email mailbox account identity is invalid");
  }
  const scope = await authorizeEmailMailboxRead({
    execution,
    lease,
    assignment,
    caseId,
    integrationAccountId: integrationAccountId.value,
  });
  const connectorId = gmailConnectorId(integrationAccountId.value);
  if (!connectorId.ok) {
    throw new Error("Email mailbox Connector identity is invalid");
  }
  const now = Date.now();
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    namespace: env.CONNECTOR,
    organisationId,
    placement: execution.scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) {
    throw new Error(
      `Email mailbox Connector is unavailable: ${connector.error.code}`,
    );
  }
  await requireSessionExecution(execution, lease);
  const searched = await connector.value.searchEmailMailbox({
    identity: { organisationId, connectorId: connectorId.value },
    execution: sessionTurnExecution(lease),
    query: request.query,
    limit: request.limit,
    now,
  });
  if (!searched.ok) {
    throw new Error(`Email mailbox search failed: ${searched.error.code}`);
  }
  await requireSessionExecution(execution, lease);
  const result: HarnessEmailMailboxSearchResult = {
    integrationAccountId: searched.value.integrationAccountId,
    messages: searched.value.messages.map(emailMailboxMessageForHarness),
    truncated: searched.value.truncated,
  };
  await commitEmailMailboxObservation({
    storage,
    execution,
    lease,
    scope,
    contentDigest: await digestCanonical({
      kind: "email_mailbox_search_v1",
      result,
    }),
    observedAt: now,
  });
  requireCurrentEmailToolLease(storage, lease, assignment);
  return result;
}

function emailMailboxMessageForHarness(
  message: import("@purin-labs/connections/mail/gmail-adapter").GmailMessageContent,
): HarnessEmailMailboxSearchResult["messages"][number] {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    from: message.headers.from,
    subject: message.headers.subject,
    date: message.headers.date,
    bodyText: message.bodyText,
    attachments: message.attachments.map(emailAttachmentForHarness),
  };
}

async function authorizeEmailMailboxRead(
  input: Readonly<{
    execution: SessionExecutionAdmission;
    lease: HarnessTurnLease;
    assignment: CaseAssignment;
    caseId: CaseId;
    integrationAccountId: IntegrationAccountId;
  }>,
): Promise<EmailMailboxReadScope> {
  await requireSessionExecution(input.execution, input.lease);
  const capability = readEmailMailboxCapability(
    input.assignment.authorityPartition.capabilityKeys,
    CAPABILITY_KEYS.emailMailboxRead,
    input.integrationAccountId,
  );
  if (capability === null) {
    throw new Error("Email mailbox is outside the granted read scope");
  }
  const authorized = await authorizeCapabilityUse({
    db: input.execution.scope.database,
    accountAccess: input.execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      input.lease.session.sessionId,
      input.lease.turn.turnId,
    ),
    action: "execute",
    organisationId: input.execution.scope.organisationId,
    authority: input.lease.requestAuthority,
    authorityPartition: input.assignment.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!authorized.ok) {
    throw new Error(
      `Email mailbox authority rejected: ${authorized.error.code}`,
    );
  }
  const grants = await listAccessGrants({
    db: input.execution.scope.database,
    organisationId: input.execution.scope.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) {
    throw new Error("Email mailbox grants are unavailable");
  }
  const selected = selectActiveGrants({
    organisationId: input.execution.scope.organisationId,
    authority: input.lease.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) {
    throw new Error("Email mailbox grant selection failed");
  }
  const matchingGrants = selectProviderResourceGrants(
    selected.value,
    capability,
  );
  if (matchingGrants.length === 0) {
    throw new Error("Email mailbox source grant is unavailable");
  }
  const inputLabel = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: input.execution.scope.database,
    organisationId: input.execution.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    capabilityId: capability.capabilityId,
    resourceScope: capability.resourceScope,
    grantIds: matchingGrants.map(readAccessGrantId),
  });
  if (!inputLabel.ok) {
    throw new Error(
      `Email mailbox source label is unavailable: ${inputLabel.error.code}`,
    );
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: input.lease.requestAuthority,
      caseId: input.caseId,
    },
    inputLabel: inputLabel.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Email mailbox information-flow admission denied");
  }
  await requireSessionExecution(input.execution, input.lease);
  return { capability, inputLabel: inputLabel.value };
}

async function commitEmailMailboxObservation(
  input: Readonly<{
    storage: DurableObjectStorage;
    execution: SessionExecutionAdmission;
    lease: HarnessTurnLease;
    scope: EmailMailboxReadScope;
    contentDigest: string;
    observedAt: number;
  }>,
): Promise<void> {
  const contentDigest = input.contentDigest;
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId: input.execution.scope.organisationId,
      integrationAccountId: input.scope.capability.integrationAccountId,
      resourceScope: input.scope.capability.resourceScope,
    },
    sourceRevision: input.observedAt,
    contentDigest,
    inputLabel: input.scope.inputLabel,
    observedAt: input.observedAt,
  });
  if (!evidence.ok) {
    throw new Error(
      `Email mailbox observation is invalid: ${evidence.error.code}`,
    );
  }
  await requireSessionExecution(input.execution, input.lease);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(
      null,
      input.execution,
      input.lease,
    ),
    sql: input.storage.sql,
    transactionSync: input.storage.transactionSync.bind(input.storage),
    organisationId: input.execution.scope.organisationId,
    sessionId: input.lease.session.sessionId,
    turnId: input.lease.turn.turnId,
    authorityPartitionDigest: input.lease.authorityPartitionDigest,
    inputLabel: input.scope.inputLabel,
    observation: evidence.value,
    observedAt: input.observedAt,
  });
  if (!admitted.ok) {
    throw new Error(
      `Email mailbox information-flow commit failed: ${admitted.error.code}`,
    );
  }
}

/**
 * Plan 40D: the agent's read of a Gmail reply's shared draft. The draft is
 * mailbox content, so the read needs the mailbox read and records a mailbox
 * observation, as a mailbox search does.
 */
export async function readEmailReplyDraftForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessEmailReplyDraftRead,
): Promise<HarnessEmailReplyDraft> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const integrationAccountId = await requireEmailReplyInMailbox(
    execution,
    request,
  );
  const scope = await authorizeEmailMailboxRead({
    execution,
    lease,
    assignment,
    caseId,
    integrationAccountId,
  });
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "read",
  );
  await authorizeEmailReplyDraftChat(
    env,
    storage,
    execution,
    lease,
    integrationAccountId,
    request.proposalId,
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readMailReplyDraft({
    organisationId,
    proposalId: request.proposalId,
    userId: member.userId,
  });
  if (!result.ok) {
    throw new Error(`Email reply draft unavailable: ${result.error.code}`);
  }
  const draft: HarnessEmailReplyDraft = {
    proposalId: result.value.proposalId,
    body: result.value.body,
    savedVersion: result.value.savedVersion,
    unsaved: result.value.unsaved,
  };
  await commitEmailReplyDraftObservation(
    storage,
    execution,
    lease,
    scope,
    draft,
  );
  requireCurrentEmailToolLease(storage, lease, assignment);
  return draft;
}

/**
 * Plan 40D: an agent edit of a Gmail reply's shared draft, with its named
 * cursor. It needs the authority of a reply proposal in that mailbox and an
 * owner or admin requester, as a reviewed edit does; the edit never saves to
 * Gmail and never sends.
 */
export async function editEmailReplyDraftForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessEmailReplyDraftEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect<HarnessEmailReplyDraft>> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const integrationAccountId = await requireEmailReplyInMailbox(
    execution,
    request,
  );
  const scope = await authorizeEmailMailboxRead({
    execution,
    lease,
    assignment,
    caseId,
    integrationAccountId,
  });
  const capability = readEmailMailboxCapability(
    assignment.authorityPartition.capabilityKeys,
    CAPABILITY_KEYS.emailReplyPropose,
    integrationAccountId,
  );
  if (capability === null) {
    throw new Error("Email mailbox is outside the granted reply scope");
  }
  const authorized = await authorizeCapabilityUse({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!authorized.ok) {
    throw new Error(`Email reply authority rejected: ${authorized.error.code}`);
  }
  return proposalFlowEffect(
    lease,
    {
      capabilityId: CAPABILITY_KEYS.emailReplyPropose,
      integrationAccountId: integrationAccountId,
      resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
    },
    async () => {
      const member = await collaborationMember(
        execution.scope.database,
        organisationId,
        lease,
        "edit",
      );
      if (member.role !== "owner" && member.role !== "admin") {
        throw new EmailReplyDraftRequestError(
          "Only an owner or admin may edit a reply draft.",
        );
      }
      const chat = await authorizeEmailReplyDraftChat(
        env,
        storage,
        execution,
        lease,
        integrationAccountId,
        request.proposalId,
      );
      // The reply's review covers what this chat read before its words reach
      // the shared draft, so a person who may not read them is refused first.
      await requireSessionExecution(execution, lease);
      const recorded = await chat.connector.recordEmailReplyEditProvenance({
        identity: chat.identity,
        proposalId: request.proposalId,
        chatSources: chat.provenance.chatSources,
        chatContext: chat.provenance.chatContext,
        now: Date.now(),
      });
      if (!recorded.ok) {
        throw new Error(
          `Email reply draft edit refused: ${recorded.error.code}`,
        );
      }
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        organisationId,
        placement: execution.scope.placement,
        now: Date.now(),
      });
      const active = preflightHarnessTurnLease(storage, lease, Date.now());
      if (!active.ok) {
        throw new Error(
          `Email reply draft authority expired: ${active.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      const result = await organisation.editMailReplyDraft({
        agent: await resolveCollaborationAgent(execution.scope, assignment),
        execution: sessionTurnExecution(lease),
        organisationId,
        request: {
          proposalId: request.proposalId,
          oldText: request.oldText,
          newText: request.newText,
        },
        operationId: JSON.stringify([
          lease.session.sessionId,
          lease.turn.turnId,
          operationId,
        ]),
        userId: member.userId,
        deadlineAt,
      });
      if (!result.ok) {
        throw new EmailReplyDraftRequestError(
          `Email reply draft edit failed: ${result.error.code}. Read the draft again before choosing a new edit.`,
        );
      }
      const draft: HarnessEmailReplyDraft = {
        proposalId: result.value.proposalId,
        body: result.value.body,
        savedVersion: result.value.savedVersion,
        unsaved: result.value.unsaved,
      };
      await commitEmailReplyDraftObservation(
        storage,
        execution,
        lease,
        scope,
        draft,
      );
      requireCurrentEmailToolLease(storage, lease, assignment);
      return draft;
    },
  );
}

/**
 * Plan 40D: a reply's shared draft is read and edited only from a Portal
 * chat whose requester may review the reply, and only when this chat read
 * every source and context record that the reply rests on. The draft then
 * adds no source to the Session beyond the mailbox.
 */
async function authorizeEmailReplyDraftChat(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  integrationAccountId: IntegrationAccountId,
  proposalId: string,
) {
  const authority = lease.requestAuthority;
  if (authority.kind !== "control") {
    throw new EmailReplyDraftRequestError(
      "A reply draft is read and edited from a Portal chat.",
    );
  }
  const organisationId = execution.scope.organisationId;
  const connectorId = gmailConnectorId(integrationAccountId);
  if (!connectorId.ok) {
    throw new Error("Email mailbox Connector identity is invalid");
  }
  const now = Date.now();
  const connector = await resolveActiveConnectorActorAtPlacement({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    placement: execution.scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) {
    throw new Error(
      `Email mailbox Connector is unavailable: ${connector.error.code}`,
    );
  }
  const identity = { organisationId, connectorId: connectorId.value };
  await requireSessionExecution(execution, lease);
  const review = await connector.value.authorizeEmailProposalDelivery({
    identity,
    proposalId,
    authority,
    now,
  });
  if (!review.ok) {
    throw new EmailReplyDraftRequestError(
      "This reply is not open to the person who asked. Do not retry.",
    );
  }
  const reply = await connector.value.readEmailReplyProvenance({
    identity,
    proposalId,
    now,
  });
  if (!reply.ok) {
    throw new Error(`Email reply draft unavailable: ${reply.error.code}`);
  }
  if (reply.value.kind !== "chat") {
    throw new EmailReplyDraftRequestError(
      "Agent edits of a reply that the mailbox agent drafted are not available yet. Ask the person to edit it in the Inbox.",
    );
  }
  const provenance = await readChatReplyProvenance(storage.sql, {
    organisationId,
    sessionId: lease.session.sessionId,
    body: "",
    citations: [],
    malformed: 0,
  });
  if (!chatCoversReply(provenance, reply.value)) {
    throw new EmailReplyDraftRequestError(
      "This chat has not read every source of the reply. Use the chat that drafted it, or a chat in the same Project.",
    );
  }
  await requireSessionExecution(execution, lease);
  return { connector: connector.value, identity, provenance };
}

function chatCoversReply(
  chat: Readonly<{
    chatSources: readonly EmailChatSource[];
    chatContext: EmailChatContext;
  }>,
  reply: Readonly<{
    chatSources: readonly EmailChatSource[];
    chatContext: EmailChatContext;
  }>,
): boolean {
  const sources = new Set(
    chat.chatSources.map((source) =>
      JSON.stringify([source.integrationAccountId, source.resourceScope]),
    ),
  );
  const memory = new Set(
    chat.chatContext.memory.map((shown) =>
      JSON.stringify([shown.memoryId, shown.revision]),
    ),
  );
  const projects = new Set(chat.chatContext.projects);
  return (
    reply.chatSources.every((source) =>
      sources.has(
        JSON.stringify([source.integrationAccountId, source.resourceScope]),
      ),
    ) &&
    reply.chatContext.memory.every((shown) =>
      memory.has(JSON.stringify([shown.memoryId, shown.revision])),
    ) &&
    reply.chatContext.projects.every((projectId) => projects.has(projectId))
  );
}

/** The reply's mailbox account, when the reply belongs to the named mailbox. */
async function requireEmailReplyInMailbox(
  execution: SessionExecutionAdmission,
  request: HarnessEmailReplyDraftRead,
): Promise<IntegrationAccountId> {
  const integrationAccountId = parseIntegrationAccountId(
    request.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new Error("Email mailbox account identity is invalid");
  }
  const projection = await readEmailReplyProposalProjection({
    db: execution.scope.database,
    organisationId: execution.scope.organisationId,
    proposalId: request.proposalId,
  });
  if (
    projection === null ||
    projection.integrationAccountId !== integrationAccountId.value
  ) {
    throw new Error("The reply is not in this mailbox");
  }
  return integrationAccountId.value;
}

async function commitEmailReplyDraftObservation(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  scope: EmailMailboxReadScope,
  draft: HarnessEmailReplyDraft,
): Promise<void> {
  await commitEmailMailboxObservation({
    storage,
    execution,
    lease,
    scope,
    contentDigest: await digestCanonical({
      kind: "email_reply_draft_v1",
      draft,
    }),
    observedAt: Date.now(),
  });
}

export async function proposeEmailReplyForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessEmailReplyPropose,
): Promise<ToolEffect<HarnessEmailReplyProposalReceipt>> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const integrationAccountId = parseIntegrationAccountId(
    request.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new Error("Email mailbox account identity is invalid");
  }
  const capability = readEmailMailboxCapability(
    assignment.authorityPartition.capabilityKeys,
    CAPABILITY_KEYS.emailReplyPropose,
    integrationAccountId.value,
  );
  if (capability === null) {
    throw new Error("Email mailbox is outside the granted reply scope");
  }
  const authorized = await authorizeCapabilityUse({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!authorized.ok) {
    throw new Error(`Email reply authority rejected: ${authorized.error.code}`);
  }
  return proposalFlowEffect(
    lease,
    {
      capabilityId: CAPABILITY_KEYS.emailReplyPropose,
      integrationAccountId: integrationAccountId.value,
      resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
    },
    async () => {
      // The model's citations prove nothing alone: this Session's accepted reads
      // decide which ones the reply keeps.
      const provenance = await readChatReplyProvenance(storage.sql, {
        organisationId,
        sessionId: lease.session.sessionId,
        body: request.body,
        citations: request.citations,
        malformed: request.malformedCitations,
      });
      const connectorId = gmailConnectorId(integrationAccountId.value);
      if (!connectorId.ok) {
        throw new Error("Email mailbox Connector identity is invalid");
      }
      const now = Date.now();
      const connector = await resolveActiveConnectorActorAtPlacement({
        env: env,
        namespace: env.CONNECTOR,
        organisationId,
        placement: execution.scope.placement,
        connectorId: connectorId.value,
        now,
      });
      if (!connector.ok) {
        throw new Error(
          `Email mailbox Connector is unavailable: ${connector.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      const proposalId = `proposal_email_${lease.turn.turnId}_${request.messageId}`;
      const created = await connector.value.createEmailReplyProposal({
        identity: { organisationId, connectorId: connectorId.value },
        execution: sessionTurnExecution(lease),
        caseId,
        proposalId,
        messageId: request.messageId,
        threadId: request.threadId,
        body: request.body,
        sources: provenance.sources,
        chatSources: provenance.chatSources,
        chatContext: provenance.chatContext,
        now,
      });
      if (!created.ok) {
        throw new Error(`Email reply proposal failed: ${created.error.code}`);
      }
      // The count of refused citations is part of the turn's trace.
      traceLog("email_reply.sources", {
        requestId: newRequestId(),
        proposalId,
        accepted: provenance.sources.sources.length,
        dropped: provenance.sources.dropped,
      });
      await requireSessionExecution(execution, lease);
      const caseActor = await resolveActiveCaseActorAtPlacement({
        env: env,
        namespace: env.CASE,
        organisationId,
        placement: execution.scope.placement,
        caseId,
        now,
      });
      if (!caseActor.ok) {
        throw new Error(
          `Email reply Case is unavailable: ${caseActor.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      const accepted = await caseActor.value.acceptEmailProposal(
        created.value.record,
      );
      await requireSessionExecution(execution, lease);
      if (!accepted.ok) {
        await connector.value.disposeEmailProposal({
          identity: { organisationId, connectorId: connectorId.value },
          proposalId,
          now,
        });
        throw new Error(
          `Email reply proposal record failed: ${accepted.error.code}`,
        );
      }
      const projected = await projectEmailReplyProposal({
        scope: execution.scope,
        integrationAccountId: integrationAccountId.value,
        proposalId,
        caseId,
        gmailThreadId: request.threadId,
        currentVersion: 1,
        lifecycleKind: "awaiting_approval",
        now,
      });
      if (!projected.ok) {
        traceWarn("email_slack.proposal_projection_deferred", {
          requestId: newRequestId(),
          proposalId,
          code: projected.error.code,
        });
      }
      await requireSessionExecution(execution, lease);
      requireCurrentEmailToolLease(storage, lease, assignment);
      return {
        kind: "proposed",
        proposalId,
        providerDraftId: created.value.record.providerDraftId,
      };
    },
  );
}

export async function proposeEmailOperationalForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessEmailOperationalPropose,
): Promise<ToolEffect<HarnessEmailOperationalProposalReceipt>> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const caseId = requireCurrentEmailToolLease(storage, lease, assignment);
  const capability = await resolveEmailOperationalCapability(
    organisationId,
    assignment.authorityPartition.capabilityKeys,
    request.accountRef,
  );
  if (capability === null) {
    throw new Error("Operational email is outside the granted send scope");
  }
  const integrationAccountId = capability.integrationAccountId;
  const authorized = await authorizeCapabilityUse({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!authorized.ok) {
    throw new Error(
      `Operational email authority rejected: ${authorized.error.code}`,
    );
  }
  return proposalFlowEffect(
    lease,
    {
      capabilityId: CAPABILITY_KEYS.emailOperationalPropose,
      integrationAccountId: integrationAccountId,
      resourceScope: EMAIL_OPERATIONAL_RESOURCE_SCOPE,
    },
    async () => {
      const connectorId = gmailConnectorId(integrationAccountId);
      if (!connectorId.ok) {
        throw new Error("Operational email Connector identity is invalid");
      }
      const now = Date.now();
      const connector = await resolveActiveConnectorActorAtPlacement({
        env: env,
        namespace: env.CONNECTOR,
        organisationId,
        placement: execution.scope.placement,
        connectorId: connectorId.value,
        now,
      });
      if (!connector.ok) {
        throw new Error(
          `Operational email Connector is unavailable: ${connector.error.code}`,
        );
      }
      const proposalKey =
        request.target.kind === "self_test"
          ? "self_test"
          : request.target.contactId;
      const proposalId = `proposal_operational_email_${lease.turn.turnId}_${proposalKey}`;
      let target: EmailProposalTarget;
      if (request.target.kind === "self_test") {
        await requireSessionExecution(execution, lease);
        const registered = await registerEmailSelfTest({
          scope: execution.scope,
          globalDatabase: env.DB,
          execution: sessionTurnExecution(lease),
          integrationAccountId: integrationAccountId,
          proposalId,
          caseId,
          now,
          expiresAt: now + 15 * 60_000,
          request: request.target,
        });
        if (!registered.ok) {
          throw new Error(
            `Self-test recipient rejected: ${registered.error.code}`,
          );
        }
        target = registered.value;
      } else {
        target = request.target;
      }
      await requireSessionExecution(execution, lease);
      const created = await connector.value.createEmailOperationalProposal({
        identity: { organisationId, connectorId: connectorId.value },
        execution: sessionTurnExecution(lease),
        integrationAccountId: integrationAccountId,
        caseId,
        proposalId,
        target,
        subject: request.subject,
        body: request.body,
        policyVersion: capability.capabilityVersion,
        expiresAt: now + 15 * 60_000,
        now,
      });
      if (!created.ok) {
        if (target.kind === "self_test") {
          await execution.scope.database
            .prepare(
              `DELETE FROM email_self_test WHERE organisation_id = ? AND self_test_id = ?
               AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
                 AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
            )
            .bind(
              organisationId,
              target.selfTestId,
              organisationId,
              execution.scope.placement.placementEpoch,
              execution.scope.placement.placementCellId,
              execution.scope.fenceToken,
            )
            .run();
        }
        throw new Error(
          `Operational email proposal failed: ${created.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      const caseActor = await resolveActiveCaseActorAtPlacement({
        env: env,
        namespace: env.CASE,
        organisationId,
        placement: execution.scope.placement,
        caseId,
        now,
      });
      if (!caseActor.ok) {
        throw new Error(
          `Operational email Case is unavailable: ${caseActor.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      const accepted = await caseActor.value.acceptEmailProposal({
        kind: "operational_new_message",
        proposalId: created.value.proposalId,
        version: created.value.version,
        caseId: created.value.caseId,
        integrationAccountId: String(created.value.integrationAccountId),
        target: created.value.target,
        targetDigest: created.value.targetDigest,
        subjectDigest: created.value.subjectDigest,
        bodyDigest: created.value.bodyDigest,
        snapshotDigest: created.value.snapshotDigest,
        policyVersion: created.value.policyVersion,
        credentialGeneration: created.value.credentialGeneration,
        createdAt: created.value.createdAt,
        expiresAt: created.value.expiresAt,
        lifecycle: { kind: "awaiting_approval" },
      });
      await requireSessionExecution(execution, lease);
      if (!accepted.ok) {
        await connector.value.rejectEmailOperational({
          identity: { organisationId, connectorId: connectorId.value },
          integrationAccountId: integrationAccountId,
          proposalId,
          approvedVersion: created.value.version,
          approvedSnapshotDigest: created.value.snapshotDigest,
          now,
        });
        throw new Error(
          `Operational email proposal record failed: ${accepted.error.code}`,
        );
      }
      await requireSessionExecution(execution, lease);
      requireCurrentEmailToolLease(storage, lease, assignment);
      return {
        kind: "proposed",
        proposalId: created.value.proposalId,
        version: created.value.version,
        snapshotDigest: created.value.snapshotDigest,
      };
    },
  );
}

function readEmailMailboxCapability(
  capabilityKeys: readonly string[],
  capabilityId:
    | typeof CAPABILITY_KEYS.emailMailboxRead
    | typeof CAPABILITY_KEYS.emailReplyPropose,
  integrationAccountId: IntegrationAccountId,
): Variant<CapabilityDefinition, "provider_resource"> | null {
  for (const key of capabilityKeys) {
    const parsed = parseCapabilityKey(key);
    if (
      parsed.ok &&
      parsed.value.kind === "provider_resource" &&
      parsed.value.capabilityId === capabilityId &&
      parsed.value.integrationAccountId === integrationAccountId &&
      parsed.value.resourceScope === EMAIL_MAILBOX_RESOURCE_SCOPE
    ) {
      return parsed.value;
    }
  }
  return null;
}

type WhatsAppSupportConversationWindowRow = Readonly<{
  readonly caseId: unknown;
  readonly conversationWindowSequence: unknown;
  readonly bindingRevision: unknown;
  readonly policyVersion: unknown;
  readonly openedAt: unknown;
  readonly serviceWindowExpiresAt: unknown;
}>;

type WhatsAppSupportConversationWindow = Readonly<{
  readonly integrationAccountId: IntegrationAccountId;
  readonly caseId: CaseId;
  readonly sourceRevision: number;
  readonly openedAt: number;
  readonly serviceWindowExpiresAt: number;
}>;

type WhatsAppSupportScope = Readonly<{
  readonly capability: Variant<CapabilityDefinition, "provider_resource">;
  readonly inputLabel: FlowLabel;
  readonly conversationWindows: readonly WhatsAppSupportConversationWindow[];
}>;

const WHATSAPP_DIRECTED_REPLY_MAX_CHARS = 4_000;

const WHATSAPP_DIRECTED_REPLY_TTL_MS = 4 * 3_600_000;

export async function sendWhatsAppSupportReplyForEmbeddedHarness(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  currentInstruction: string,
  request: HarnessWhatsAppSupportReplySend,
): Promise<HarnessWhatsAppSupportReplyReceipt> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error("WhatsApp support session binding invalid");
  }
  if (!currentInstruction.includes(request.body)) {
    throw new Error(
      "WhatsApp reply body was not supplied verbatim by the current requester",
    );
  }
  const requesterUserId = await resolveWhatsAppReplyRequester(
    execution.scope.database,
    organisationId,
    lease,
  );
  if (requesterUserId === null) {
    throw new Error("WhatsApp reply requester is not an active operator");
  }
  const caseId = parseCaseId(request.caseId);
  if (!caseId.ok) {
    throw new Error("WhatsApp support Case identity invalid");
  }
  const conversationWindow = await readWhatsAppCaseConversationWindowByCaseId({
    db: execution.scope.database,
    organisationId,
    caseId: caseId.value,
  });
  const now = Date.now();
  if (
    conversationWindow === null ||
    conversationWindow.closedAt !== null ||
    conversationWindow.serviceWindowExpiresAt <= now
  ) {
    throw new Error("WhatsApp support Case is not active");
  }
  if (
    !hasWhatsAppReplyCapability(
      assignment.authorityPartition.capabilityKeys,
      conversationWindow.integrationAccountId,
    )
  ) {
    throw new Error("WhatsApp support Case is outside the granted reply scope");
  }
  const connectorId = whatsappConnectorId(
    conversationWindow.integrationAccountId,
  );
  if (!connectorId.ok) {
    throw new Error("WhatsApp support Connector identity is invalid");
  }
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    namespace: env.CONNECTOR,
    organisationId,
    placement: execution.scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) {
    throw new Error(
      `WhatsApp support Connector is unavailable: ${connector.error.code}`,
    );
  }
  const automaticProposalId = `proposal_${caseId.value}_${conversationWindow.conversationWindowSequence}`;
  const projection = await readWhatsAppReplyProposalProjection({
    db: execution.scope.database,
    organisationId,
    proposalId: automaticProposalId,
  });
  const approval =
    projection?.author === "agent" &&
    projection.lifecycleKind === "awaiting_approval"
      ? await editDirectedWhatsAppAgentProposal(
          connector.value,
          execution,
          lease,
          connectorId.value,
          automaticProposalId,
          request.body,
          now,
        )
      : await composeDirectedWhatsAppHumanReply(
          connector.value,
          execution,
          lease,
          connectorId.value,
          caseId.value,
          requesterUserId,
          `proposal_slack_${lease.turn.turnId}`,
          request.body,
          conversationWindow.serviceWindowExpiresAt,
          now,
        );
  await requireSessionExecution(execution, lease);
  const sent = await connector.value.dispatchWhatsAppReply({
    identity: { organisationId, connectorId: connectorId.value },
    origin: { kind: "session_turn", execution: sessionTurnExecution(lease) },
    proposalId: approval.proposalId,
    approvedVersion: approval.version,
    approvedBodyDigest: approval.bodyDigest,
    approvedBy: requesterUserId,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  if (!sent.ok) {
    throw new Error(`WhatsApp support reply failed: ${sent.error.code}`);
  }
  if (sent.value.kind !== "sent") {
    throw new Error(`WhatsApp support reply was not sent: ${sent.value.kind}`);
  }
  return {
    kind: "sent",
    caseId: caseId.value,
    receiptId: sent.value.whatsappMessageId,
  };
}

async function resolveWhatsAppReplyRequester(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
): Promise<string | null> {
  const authority = lease.requestAuthority;
  if (
    authority.kind !== "direct_conversation" &&
    authority.kind !== "shared_conversation"
  ) {
    return null;
  }
  if (
    authority.role !== "owner" &&
    authority.role !== "admin" &&
    authority.role !== "operator"
  ) {
    return null;
  }
  const members = await listOrganisationMembers({ db, organisationId });
  for (const member of members) {
    if (
      member.personId === authority.requesterPersonId &&
      member.role === authority.role
    ) {
      return member.userId;
    }
  }
  return null;
}

function hasWhatsAppReplyCapability(
  capabilityKeys: readonly string[],
  integrationAccountId: IntegrationAccountId,
): boolean {
  for (const key of capabilityKeys) {
    const parsed = parseCapabilityKey(key);
    if (
      parsed.ok &&
      parsed.value.kind === "provider_resource" &&
      parsed.value.capabilityId === CAPABILITY_KEYS.whatsappSupportReplySend &&
      parsed.value.integrationAccountId === integrationAccountId &&
      parsed.value.resourceScope === WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE
    ) {
      return true;
    }
  }
  return false;
}

async function editDirectedWhatsAppAgentProposal(
  connector: ConnectorActorStub,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  connectorId: string,
  proposalId: string,
  body: string,
  now: number,
): Promise<{
  readonly proposalId: string;
  readonly version: number;
  readonly bodyDigest: string;
}> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const edited = await connector.editWhatsAppProposal({
    identity: { organisationId, connectorId },
    origin: { kind: "session_turn", execution: sessionTurnExecution(lease) },
    proposalId,
    body,
    maxReplyChars: WHATSAPP_DIRECTED_REPLY_MAX_CHARS,
    now,
  });
  await requireSessionExecution(execution, lease);
  if (!edited.ok) {
    throw new Error(`WhatsApp support reply edit failed: ${edited.error.code}`);
  }
  if (edited.value.kind !== "versioned") {
    throw new Error(
      `WhatsApp support reply proposal is unavailable: ${edited.value.kind}`,
    );
  }
  return {
    proposalId,
    version: edited.value.version,
    bodyDigest: edited.value.bodyDigest,
  };
}

async function composeDirectedWhatsAppHumanReply(
  connector: ConnectorActorStub,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  connectorId: string,
  caseId: CaseId,
  requesterUserId: string,
  proposalId: string,
  body: string,
  serviceWindowExpiresAt: number,
  now: number,
): Promise<{
  readonly proposalId: string;
  readonly version: number;
  readonly bodyDigest: string;
}> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const takeover = await connector.takeOverWhatsAppCase({
    identity: { organisationId, connectorId },
    origin: { kind: "session_turn", execution: sessionTurnExecution(lease) },
    caseId,
    operatorUserId: requesterUserId,
    now,
  });
  await requireSessionExecution(execution, lease);
  if (!takeover.ok) {
    throw new Error(`WhatsApp support takeover failed: ${takeover.error.code}`);
  }
  const composed = await connector.composeWhatsAppHumanReply({
    identity: { organisationId, connectorId },
    origin: { kind: "session_turn", execution: sessionTurnExecution(lease) },
    caseId,
    proposalId,
    body,
    maxReplyChars: WHATSAPP_DIRECTED_REPLY_MAX_CHARS,
    expiresAt: Math.min(
      now + WHATSAPP_DIRECTED_REPLY_TTL_MS,
      serviceWindowExpiresAt,
    ),
    now,
  });
  await requireSessionExecution(execution, lease);
  if (!composed.ok) {
    throw new Error(
      `WhatsApp support reply compose failed: ${composed.error.code}`,
    );
  }
  return composed.value;
}

export async function readWhatsAppSupportForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessWhatsAppSupportRead,
): Promise<HarnessWhatsAppSupportInbox> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error("WhatsApp support session binding invalid");
  }
  const caseId = parseCaseId(assignment.caseId);
  if (!caseId.ok) {
    throw new Error("WhatsApp support Case identity invalid");
  }
  const capabilities = readWhatsAppSupportCapabilities(
    assignment.authorityPartition.capabilityKeys,
  );
  if (capabilities.length === 0) {
    throw new Error("WhatsApp support authority is unavailable");
  }
  const grants = await listAccessGrants({
    db: execution.scope.database,
    organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) {
    throw new Error("WhatsApp support grants are unavailable");
  }
  const selected = selectActiveGrants({
    organisationId,
    authority: lease.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) {
    throw new Error("WhatsApp support grant selection failed");
  }
  const now = Date.now();
  const scopes: WhatsAppSupportScope[] = [];
  const candidates: WhatsAppSupportConversationWindow[] = [];
  for (const capability of capabilities) {
    const authorized = await authorizeCapabilityUse({
      db: execution.scope.database,
      accountAccess: execution.scope.accountAccess,
      userAuthority: acceptedExecutionAuthority(
        lease.session.sessionId,
        lease.turn.turnId,
      ),
      action: "execute",
      organisationId,
      authority: lease.requestAuthority,
      authorityPartition: assignment.authorityPartition,
      request: { capabilities: [capability] },
    });
    if (!authorized.ok) {
      throw new Error(
        `WhatsApp support authority rejected: ${authorized.error.code}`,
      );
    }
    const matchingGrants = selectProviderResourceGrants(
      selected.value,
      capability,
    );
    if (matchingGrants.length === 0) {
      throw new Error("WhatsApp support source grant is unavailable");
    }
    const inputLabel = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: execution.scope.database,
      organisationId,
      integrationAccountId: capability.integrationAccountId,
      capabilityId: capability.capabilityId,
      resourceScope: capability.resourceScope,
      grantIds: matchingGrants.map(readAccessGrantId),
    });
    if (!inputLabel.ok) {
      throw new Error(
        `WhatsApp support source label is unavailable: ${inputLabel.error.code}`,
      );
    }
    const admission = await decideContextAdmission({
      subject: {
        kind: "authority_derived",
        requestAuthority: lease.requestAuthority,
        caseId: caseId.value,
      },
      inputLabel: inputLabel.value,
    });
    if (admission.kind !== "admit") {
      throw new Error("WhatsApp support information-flow admission denied");
    }
    const readConversationWindows = admittedSessionOperation(
      execution,
      lease,
      readOpenWhatsAppSupportConversationWindows,
    );
    const conversationWindows = await readConversationWindows({
      db: execution.scope.database,
      organisationId,
      integrationAccountId: capability.integrationAccountId,
      now,
      limit: request.limit + 1,
    });
    scopes.push({
      capability,
      inputLabel: inputLabel.value,
      conversationWindows,
    });
    candidates.push(...conversationWindows);
  }
  candidates.sort(compareWhatsAppSupportConversationWindows);
  const truncated = candidates.length > request.limit;
  const selectedConversationWindows = candidates.slice(0, request.limit);
  const cases: HarnessWhatsAppSupportInbox["cases"][number][] = [];
  for (const conversationWindow of selectedConversationWindows) {
    cases.push(
      await readWhatsAppSupportCase(
        env,
        execution,
        lease,
        conversationWindow,
        now,
      ),
    );
  }
  for (const scope of scopes) {
    const scopeCases = cases.filter(
      matchesWhatsAppSupportAccount.bind(
        null,
        scope.capability.integrationAccountId,
      ),
    );
    await commitWhatsAppSupportObservation({
      storage,
      execution,
      lease,
      scope,
      cases: scopeCases,
      truncated,
      observedAt: now,
    });
  }
  await requireSessionExecution(execution, lease);
  return { scope: WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE, cases, truncated };
}

function readWhatsAppSupportCapabilities(
  capabilityKeys: readonly string[],
): readonly Variant<CapabilityDefinition, "provider_resource">[] {
  const capabilities = new Map<
    string,
    Variant<CapabilityDefinition, "provider_resource">
  >();
  for (const key of capabilityKeys) {
    const parsed = parseCapabilityKey(key);
    if (
      !parsed.ok ||
      parsed.value.kind !== "provider_resource" ||
      parsed.value.capabilityId !== CAPABILITY_KEYS.whatsappSupportRead
    ) {
      continue;
    }
    if (parsed.value.resourceScope !== WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE) {
      throw new Error("WhatsApp support resource scope is invalid");
    }
    capabilities.set(parsed.value.integrationAccountId, parsed.value);
  }
  return [...capabilities.values()].sort(compareWhatsAppSupportCapabilities);
}

function compareWhatsAppSupportCapabilities(
  left: Variant<CapabilityDefinition, "provider_resource">,
  right: Variant<CapabilityDefinition, "provider_resource">,
): number {
  return left.integrationAccountId.localeCompare(right.integrationAccountId);
}

async function readOpenWhatsAppSupportConversationWindows(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: string;
    readonly now: number;
    readonly limit: number;
  }>,
): Promise<readonly WhatsAppSupportConversationWindow[]> {
  const rows = await input.db
    .prepare(
      `SELECT conversationWindow.case_id AS caseId,
            conversationWindow.conversation_window_sequence AS conversationWindowSequence,
            conversationWindow.binding_revision AS bindingRevision,
            conversationWindow.policy_version AS policyVersion,
            conversationWindow.opened_at AS openedAt,
            conversationWindow.service_window_expires_at AS serviceWindowExpiresAt
       FROM whatsapp_case_conversation_window AS conversationWindow
       JOIN integration_account AS account
         ON account.organisation_id = conversationWindow.organisation_id
        AND account.integration_account_id = conversationWindow.integration_account_id
      WHERE conversationWindow.organisation_id = ? AND conversationWindow.integration_account_id = ?
        AND conversationWindow.closed_at IS NULL AND conversationWindow.service_window_expires_at > ?
        AND account.provider = 'whatsapp' AND account.lifecycle = 'active'
      ORDER BY conversationWindow.opened_at DESC, conversationWindow.case_id
      LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.now,
      input.limit,
    )
    .all<WhatsAppSupportConversationWindowRow>();
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new Error("WhatsApp support account identity is invalid");
  }
  const conversationWindows: WhatsAppSupportConversationWindow[] = [];
  for (const row of rows.results ?? []) {
    const parsed = parseWhatsAppSupportConversationWindowRow(
      integrationAccountId.value,
      row,
    );
    if (parsed === null) {
      throw new Error(
        "WhatsApp support conversation window projection is invalid",
      );
    }
    conversationWindows.push(parsed);
  }
  return conversationWindows;
}

function parseWhatsAppSupportConversationWindowRow(
  integrationAccountId: IntegrationAccountId,
  row: WhatsAppSupportConversationWindowRow,
): WhatsAppSupportConversationWindow | null {
  if (
    !isPositiveInteger(row.conversationWindowSequence) ||
    !isPositiveInteger(row.bindingRevision) ||
    !isPositiveInteger(row.policyVersion) ||
    !isNonNegativeInteger(row.openedAt) ||
    !isPositiveInteger(row.serviceWindowExpiresAt) ||
    typeof row.caseId !== "string"
  ) {
    return null;
  }
  const caseId = parseCaseId(row.caseId);
  if (!caseId.ok) {
    return null;
  }
  return {
    integrationAccountId,
    caseId: caseId.value,
    sourceRevision: Math.max(
      row.conversationWindowSequence,
      row.bindingRevision,
      row.policyVersion,
      row.serviceWindowExpiresAt,
    ),
    openedAt: row.openedAt,
    serviceWindowExpiresAt: row.serviceWindowExpiresAt,
  };
}

function compareWhatsAppSupportConversationWindows(
  left: WhatsAppSupportConversationWindow,
  right: WhatsAppSupportConversationWindow,
): number {
  return (
    right.openedAt - left.openedAt || left.caseId.localeCompare(right.caseId)
  );
}

async function readWhatsAppSupportCase(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  conversationWindow: WhatsAppSupportConversationWindow,
  now: number,
): Promise<HarnessWhatsAppSupportInbox["cases"][number]> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const connectorId = whatsappConnectorId(
    conversationWindow.integrationAccountId,
  );
  if (!connectorId.ok) {
    throw new Error("WhatsApp support Connector identity is invalid");
  }
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    namespace: env.CONNECTOR,
    organisationId,
    placement: execution.scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok) {
    throw new Error(
      `WhatsApp support Connector is unavailable: ${connector.error.code}`,
    );
  }
  await requireSessionExecution(execution, lease);
  const panel = await connector.value.readWhatsAppCasePanel({
    identity: { organisationId, connectorId: connectorId.value },
    caseId: conversationWindow.caseId,
    now,
  });
  await requireSessionExecution(execution, lease);
  if (!panel.ok || panel.value.caseId !== conversationWindow.caseId) {
    throw new Error("WhatsApp support Case content is unavailable");
  }
  const messages: HarnessWhatsAppSupportInbox["cases"][number]["messages"][number][] =
    [];
  for (const message of panel.value.messages) {
    messages.push({
      direction: message.direction,
      occurredAt: message.occurredAt,
      text: message.text,
    });
  }
  return {
    integrationAccountId: conversationWindow.integrationAccountId,
    caseId: conversationWindow.caseId,
    customerWaId: panel.value.customerWaId,
    openedAt: conversationWindow.openedAt,
    serviceWindowExpiresAt: conversationWindow.serviceWindowExpiresAt,
    ownership: panel.value.ownership.kind,
    messages,
  };
}

function matchesWhatsAppSupportAccount(
  integrationAccountId: string,
  supportCase: HarnessWhatsAppSupportInbox["cases"][number],
): boolean {
  return supportCase.integrationAccountId === integrationAccountId;
}

async function commitWhatsAppSupportObservation(
  input: Readonly<{
    readonly storage: DurableObjectStorage;
    readonly execution: SessionExecutionAdmission;
    readonly lease: HarnessTurnLease;
    readonly scope: WhatsAppSupportScope;
    readonly cases: readonly HarnessWhatsAppSupportInbox["cases"][number][];
    readonly truncated: boolean;
    readonly observedAt: number;
  }>,
): Promise<void> {
  const contentDigest = await digestCanonical({
    kind: "whatsapp_support_active_cases_v1",
    cases: input.cases,
    truncated: input.truncated,
  });
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId: input.execution.scope.organisationId,
      integrationAccountId: input.scope.capability.integrationAccountId,
      resourceScope: input.scope.capability.resourceScope,
    },
    sourceRevision: latestWhatsAppSupportSourceRevision(
      input.scope.conversationWindows,
    ),
    contentDigest,
    inputLabel: input.scope.inputLabel,
    observedAt: input.observedAt,
  });
  if (!evidence.ok) {
    throw new Error(
      `WhatsApp support observation is invalid: ${evidence.error.code}`,
    );
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(
      null,
      input.execution,
      input.lease,
    ),
    sql: input.storage.sql,
    transactionSync: input.storage.transactionSync.bind(input.storage),
    organisationId: input.execution.scope.organisationId,
    sessionId: input.lease.session.sessionId,
    turnId: input.lease.turn.turnId,
    authorityPartitionDigest: input.lease.authorityPartitionDigest,
    inputLabel: input.scope.inputLabel,
    observation: evidence.value,
    observedAt: input.observedAt,
  });
  if (!admitted.ok) {
    throw new Error(
      `WhatsApp support information-flow commit failed: ${admitted.error.code}`,
    );
  }
}

function latestWhatsAppSupportSourceRevision(
  conversationWindows: readonly WhatsAppSupportConversationWindow[],
): number {
  let revision = 1;
  for (const conversationWindow of conversationWindows) {
    revision = Math.max(revision, conversationWindow.sourceRevision);
  }
  return revision;
}

function emailAttachmentForHarness(
  attachment: import("@purin-labs/connections/mail/gmail-adapter").GmailAttachmentRef,
): HarnessEmailMailboxSearchResult["messages"][number]["attachments"][number] {
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    declaredBytes: attachment.declaredBytes,
  };
}
