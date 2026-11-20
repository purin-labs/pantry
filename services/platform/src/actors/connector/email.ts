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
