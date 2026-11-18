import { isSessionMailExecutionActive } from "../../mail-inbox/execution";
import { readEmailProposalEvidence } from "../email-case-context-collection-evidence";
import {
  acceptMailClassificationHint,
  eraseMailOrganization,
} from "../../mail-inbox/store";
import type { Env } from "../../env";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import {
  acceptEmailHint,
  disableEmailRuntime,
  latestEmailDraftOperation,
  requestEmailWatchCleanup,
  readEmailRuntime,
  type EmailHintAcceptance,
  type EmailRuntimeSnapshot,
} from "../connector-email";
import { digestEmailBody } from "../../mail/reply-target";
import { createEmailProposalDraft } from "../email-case-processing";
import {
  acceptConnectorCaseWork,
  acceptSlackFollowUp,
  parkSlackPermissionRequest,
  releaseParkedSlackPermission,
  parkSlackSideCaseCommand,
  type SlackSideCaseParkRequest,
  type SlackPermissionParkRequest,
  type SlackPermissionRelease,
  type ConnectorCaseWorkRequest,
  type SlackFollowUpAcceptance,
  type SlackFollowUpRequest,
} from "../connector-case-work";
import {
  type EmailReplyProposalCreateRequest,
  parseEmailChangeRequest,
} from "./email-parsers";
import { ensureConnectorIdentity } from "./ingress-parsers";
import { invalid } from "./support";
import type { ConnectorEmailReplyProposal, ConnectorResult } from "./types";
import type { EmailMailboxRevocationRequest } from "./whatsapp-parsers";

export async function createConnectorEmailReplyProposal(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    env: Env;
    sql: SqlStorage;
    runtime: EmailRuntimeSnapshot;
    caseId: string;
    mailboxBindingId: string;
    bindingRevision: number;
    request: EmailReplyProposalCreateRequest;
  }>,
): Promise<ConnectorResult<ConnectorEmailReplyProposal>> {
  const bodyDigest = await digestEmailBody(input.request.body);
  if (
    !(await isSessionMailExecutionActive(
      input.sql,
      input.scope,
      input.env.DB,
      input.request.execution,
    ))
  )
    return invalid("connector_execution_authority_inactive");
  const existing = latestEmailDraftOperation(
    input.sql,
    input.request.proposalId,
  );
  if (existing !== null) {
    if (
      existing.version !== 1 ||
      existing.state !== "awaiting_approval" ||
      existing.caseId !== input.caseId ||
      existing.threadId !== input.request.threadId ||
      existing.triggeringMessageId !== input.request.messageId ||
      existing.bodyDigest !== bodyDigest
    ) {
      return invalid("connector_email_reply_proposal_conflict");
    }
    const evidence = await readEmailProposalEvidence(
      input.sql,
      existing.proposalId,
    );
    if (
      !(await isSessionMailExecutionActive(
        input.sql,
        input.scope,
        input.env.DB,
        input.request.execution,
      ))
    )
      return invalid("connector_execution_authority_inactive");
    return {
      ok: true,
      value: {
        record: {
          proposalId: existing.proposalId,
          version: existing.version,
          caseId: existing.caseId,
          threadId: existing.threadId,
          providerDraftId: existing.draftId,
          providerDraftMessageId: existing.draftMessageId,
          triggeringProviderMessageId: existing.triggeringMessageId,
          mailboxBindingId: input.mailboxBindingId,
          bindingRevision: input.bindingRevision,
          policyVersion: existing.policyVersion,
          targetDigest: existing.targetDigest,
          bodyDigest: existing.bodyDigest,
          snapshotDigest: existing.snapshotDigest,
          createdAt: existing.createdAt,
          expiresAt: existing.expiresAt,
          evidence,
          lifecycle: { kind: "awaiting_approval" },
        },
      },
    };
  }
  const created = await createEmailProposalDraft(
    input.env,
    {
      scope: input.scope,
      connectorSql: input.sql,
      organisationId: input.runtime.organisationId,
      integrationAccountId: input.runtime.integrationAccountId,
      threadId: input.request.threadId,
      caseId: input.caseId,
      messageIds: [input.request.messageId],
      mailboxBindingId: input.mailboxBindingId,
      bindingRevision: input.bindingRevision,
      policyVersion: input.runtime.policyVersion,
      limits: input.runtime.limits,
      now: input.request.now,
    },
    {
      proposalId: input.request.proposalId,
      version: 1,
      body: input.request.body,
      triggeringMessageId: input.request.messageId,
      purpose: "operator_edit",
      producingFlow: {
        kind: "chat_turn",
        sources: input.request.sources,
        chatSources: input.request.chatSources,
        chatContext: input.request.chatContext,
      },
      commerceEvidence: [],
    },
    { kind: "session_turn", execution: input.request.execution },
  );
  return created.ok ? created : invalid(created.error.code);
}

export function acceptCaseWorkTransaction(
  sql: SqlStorage,
  input: ConnectorCaseWorkRequest,
): ConnectorResult<{
  readonly kind: "accepted" | "duplicate";
  readonly eventId: string;
}> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return acceptConnectorCaseWork(sql, input);
}

export type SlackPermissionParked = Readonly<{
  caseId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string | null;
}>;

export function parkSlackPermissionTransaction(
  sql: SqlStorage,
  input: SlackPermissionParkRequest,
  now: number,
): ReturnType<typeof parkSlackPermissionRequest> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return parkSlackPermissionRequest(sql, input, now);
}

/** The later start repeats the work of an earlier one that failed. */
export function ignoreEarlierSideCaseStart(): void {}

export type SlackSideCaseParked = Readonly<{
  caseId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterPersonId: string;
}>;

export function parkSlackSideCaseTransaction(
  sql: SqlStorage,
  input: SlackSideCaseParkRequest,
  now: number,
): ReturnType<typeof parkSlackSideCaseCommand> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return parkSlackSideCaseCommand(sql, input, now);
}

export function releaseSlackPermissionTransaction(
  sql: SqlStorage,
  input: SlackPermissionRelease,
  now: number,
): ReturnType<typeof releaseParkedSlackPermission> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return releaseParkedSlackPermission(sql, input, now);
}

export function acceptSlackFollowUpTransaction(
  sql: SqlStorage,
  input: SlackFollowUpRequest,
): ConnectorResult<SlackFollowUpAcceptance> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return acceptSlackFollowUp(sql, input);
}

export function acceptConnectorEmailChange(
  sql: SqlStorage,
  input: NonNullable<ReturnType<typeof parseEmailChangeRequest>>,
): ConnectorResult<EmailHintAcceptance> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  acceptMailClassificationHint(sql, input.now);
  return {
    ok: true,
    value: acceptEmailHint(sql, {
      notificationId: input.notificationId,
      historyId: input.historyId,
      now: input.now,
    }),
  };
}

export function fenceConnectorEmailMailbox(
  sql: SqlStorage,
  input: EmailMailboxRevocationRequest,
): ConnectorResult<null> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  const disabled = disableEmailRuntime(sql, { now: input.now });
  if (disabled.ok && input.kind === "erase") eraseMailOrganization(sql);
  const runtime = readEmailRuntime(sql);
  if (disabled.ok && runtime !== null && runtime.watchExpiresAt !== null)
    requestEmailWatchCleanup(sql, input.now);
  return disabled;
}

export function isPresentNoticeKey(value: string | null): value is string {
  return value !== null;
}
