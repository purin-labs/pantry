import { isSessionMailExecutionActive } from "../../mail-inbox/execution";
import { readEmailProposalEvidence } from "../email-case-context-collection-evidence";
import {
  acceptMailClassificationHint,
  eraseMailOrganization,
} from "../../mail-inbox/store";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  acceptEmailHint,
  createConnectorEmailSchema,
  disableEmailRuntime,
  latestEmailDraftOperation,
  nextEmailCaseContextDiscoveryAt,
  nextEmailCorrectionLearningAt,
  nextEmailEvaluationAt,
  nextEmailMaintenanceAt,
  nextEmailReplyTurnAt,
  nextEmailWatchCleanupAt,
  requestEmailWatchCleanup,
  readEmailRuntime,
  type EmailHintAcceptance,
  type EmailRuntimeSnapshot,
} from "../connector-email";
import { nextOperationalEmailMaintenanceAt } from "../connector-email-operational";
import type { EmailDisposalOutcome } from "../connector-email-proposal";
import {
  createConnectorEvalSchema,
  nextEvalWorkAt,
} from "@purin-labs/area-brain/server/actors/connector-eval";
import type { GmailMessageContent } from "@purin-labs/connections/mail/gmail-adapter";
import { nextMailOrganizationAt } from "../../mail-inbox/store";
import type { AlarmReconciler } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import { digestEmailBody } from "@purin-labs/connections/mail/reply-target";
import {
  createEmailProposalDraft,
  type EmailProposalDraftRecord,
} from "../email-case-processing";
import {
  type EmailReplyProposalCreateRequest,
  parseEmailChangeRequest,
} from "./email-parsers";
import { ensureConnectorIdentity } from "@purin-labs/conversation/actors/connector/ingress-parsers";
import { invalid } from "@purin-labs/conversation/actors/connector/support";
import type { ConnectorResult } from "@purin-labs/conversation/actors/connector/types";
import type { EmailMailboxRevocationRequest } from "./whatsapp-parsers";

export type EmailMailboxDisposal = {
  readonly proposalId: string;
  readonly version: number;
  readonly kind: EmailDisposalOutcome["kind"];
};

export type EmailMailboxRevocation = {
  readonly watchStopped: boolean;
  readonly disposals: readonly EmailMailboxDisposal[];
};

export type EmailRuntimeStatus = EmailRuntimeSnapshot & {
  readonly usage: {
    readonly activeCases: number;
    readonly admittedLastHour: number;
    readonly tokens: { readonly reserved: number; readonly consumed: number };
    readonly nextEvaluationAt: number | null;
  };
};

export type ConnectorEmailMailboxSearch = Readonly<{
  integrationAccountId: string;
  messages: readonly GmailMessageContent[];
  truncated: boolean;
}>;

export type ConnectorEmailReplyProposal = Readonly<{
  record: EmailProposalDraftRecord;
}>;

/** Creates the tables of the mailbox. */
export function createEmailChannelSchema(storage: DurableObjectStorage): void {
  createConnectorEmailSchema(storage.sql, createConnectorEvalSchema);
}

/**
 * The due times of the mailbox's alarm work, its evals among them. Each
 * reads its own rows.
 */
export function emailAlarmDue(sql: SqlStorage): readonly AlarmReconciler[] {
  return [
    { name: "email_evaluation", nextDue: () => nextEmailEvaluationAt(sql) },
    { name: "mail_organization", nextDue: () => nextMailOrganizationAt(sql) },
    {
      name: "email_case_context_discovery",
      nextDue: () => nextEmailCaseContextDiscoveryAt(sql),
    },
    {
      name: "email_correction_learning",
      nextDue: () => nextEmailCorrectionLearningAt(sql),
    },
    { name: "eval_work", nextDue: () => nextEvalWorkAt(sql) },
    { name: "email_reply_turn", nextDue: () => nextEmailReplyTurnAt(sql) },
    {
      name: "email_maintenance",
      nextDue: (now) => nextEmailMaintenanceAt(sql, now),
    },
    {
      name: "email_watch_cleanup",
      nextDue: () => nextEmailWatchCleanupAt(sql),
    },
    {
      name: "operational_email_maintenance",
      nextDue: () => nextOperationalEmailMaintenanceAt(sql),
    },
  ];
}

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
