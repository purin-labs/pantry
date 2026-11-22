import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { GMAIL_MAILBOX } from "@purin-labs/connections/mail/gmail-mail-adapter";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { fetchConnectorMail } from "@purin-labs/area-inbox/server/mail-inbox/execution";
import { extractMailbox } from "@purin-labs/connections/mail/gmail-adapter";
import {
  parseCaseId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { resolveVerifiedContactEndpointByEndpoint } from "@purin-labs/area-inbox/server/data/contact-verification";
import { bindEmailMessageReceiptContact } from "@purin-labs/area-inbox/server/data/email-mailbox";
import type { CaseContextCollectionSelection } from "@purin-labs/agent/case-context-discovery/relationships";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";

type EmailCaseContextCollectionReceipt = Readonly<{
  messageId: string;
  threadId: string;
  caseId: CaseId;
  admittedAt: number;
}>;

export type EmailCaseContextDiscoveryOutcome =
  | Readonly<{ kind: "terminal"; reason: string }>
  | Readonly<{ kind: "retry"; reason: string }>
  | Readonly<{ kind: "evaluated"; recorded: number }>;

const MAX_CANDIDATE_RECEIPTS = 20;
const MAX_CANDIDATES = 5;
const MAX_EVIDENCE_BYTES = 1_800;
const CANDIDATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export async function discoverAdmittedEmailCaseContext(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    integrationAccountId: IntegrationAccountId;
    caseId: CaseId;
    messageIds: readonly string[];
    accessToken: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<EmailCaseContextDiscoveryOutcome> {
  const mailOperations = GMAIL_MAILBOX;
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  const fetcher = fetchConnectorMail.bind(
    null,
    input.sql,
    input.scope,
    input.fetcher,
  );
  const anchorMessageId = input.messageIds.at(-1);
  if (anchorMessageId === undefined)
    return {
      kind: "terminal",
      reason: "case_context_collection_email_identity_invalid",
    };
  const anchorReceipt = await readEmailCaseContextCollectionReceipt({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    messageId: anchorMessageId,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  if (anchorReceipt === null || anchorReceipt.caseId !== input.caseId) {
    return {
      kind: "terminal",
      reason: "case_context_collection_email_receipt_unavailable",
    };
  }
  const anchorContent = await mailOperations.reads.readMessage({
    accessToken: input.accessToken,
    messageId: anchorReceipt.messageId,
    fetcher,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  if (!anchorContent.ok) {
    return {
      kind: "retry",
      reason: "case_context_collection_email_source_unavailable",
    };
  }
  if (
    anchorContent.value.threadId !== anchorReceipt.threadId ||
    anchorContent.value.headers.from === null
  ) {
    return {
      kind: "terminal",
      reason: "case_context_collection_email_source_mismatch",
    };
  }
  const sender = extractMailbox(anchorContent.value.headers.from);
  if (sender === null) {
    return {
      kind: "terminal",
      reason: "case_context_collection_email_sender_invalid",
    };
  }
  const verification = await resolveVerifiedContactEndpointByEndpoint({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    endpoint: { channel: "gmail", address: sender },
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  if (!verification.ok) {
    return { kind: "terminal", reason: verification.error.code };
  }
  const anchorBinding = await bindEmailMessageReceiptContact({
    scope: input.scope,
    integrationAccountId: input.integrationAccountId,
    providerMessageId: anchorReceipt.messageId,
    caseId: anchorReceipt.caseId,
    admittedAt: anchorReceipt.admittedAt,
    verificationId: verification.value.verificationId,
    verificationRevision: verification.value.revision,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  if (!anchorBinding.ok) {
    return { kind: "retry", reason: anchorBinding.error.code };
  }
  const receipts = await listEmailCaseContextDiscoveryCandidates({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    excludedCaseId: input.caseId,
    anchorAdmittedAt: anchorReceipt.admittedAt,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  const candidates = [];
  const seenCases = new Set<string>();
  let candidateReadFailed = false;
  for (const receipt of receipts) {
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return placementRetry();
    if (candidates.length >= MAX_CANDIDATES) break;
    if (seenCases.has(receipt.caseId)) continue;
    const content = await mailOperations.reads.readMessage({
      accessToken: input.accessToken,
      messageId: receipt.messageId,
      fetcher,
    });
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return placementRetry();
    if (!content.ok) {
      candidateReadFailed = true;
      continue;
    }
    if (
      content.value.threadId !== receipt.threadId ||
      content.value.headers.from === null ||
      extractMailbox(content.value.headers.from) !== sender
    ) {
      continue;
    }
    const candidateBinding = await bindEmailMessageReceiptContact({
      scope: input.scope,
      integrationAccountId: input.integrationAccountId,
      providerMessageId: receipt.messageId,
      caseId: receipt.caseId,
      admittedAt: receipt.admittedAt,
      verificationId: verification.value.verificationId,
      verificationRevision: verification.value.revision,
    });
    if (!(await isActorExecutionActive(input.sql, input.scope)))
      return placementRetry();
    if (!candidateBinding.ok) {
      candidateReadFailed = true;
      continue;
    }
    seenCases.add(receipt.caseId);
    candidates.push({
      selection: caseContextCollectionSelection(
        receipt,
        input.integrationAccountId,
        {
          verificationId: verification.value.verificationId,
          verificationRevision: verification.value.revision,
        },
      ),
      evidence: emailEvidence(content.value),
    });
  }
  if (candidateReadFailed) {
    return {
      kind: "retry",
      reason: "case_context_discovery_email_candidate_source_unavailable",
    };
  }
  if (candidates.length === 0) {
    return {
      kind: "terminal",
      reason: "case_context_discovery_email_candidates_unavailable",
    };
  }
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId: input.scope.organisationId,
    now: input.now,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  const result = await organisation.evaluateCaseContextDiscovery({
    organisationId: input.scope.organisationId,
    request: {
      issueKind: "email_issue",
      issueInstance: input.caseId,
      anchor: {
        selection: caseContextCollectionSelection(
          anchorReceipt,
          input.integrationAccountId,
          {
            verificationId: verification.value.verificationId,
            verificationRevision: verification.value.revision,
          },
        ),
        evidence: emailEvidence(anchorContent.value),
      },
      candidates,
    },
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return placementRetry();
  if (result.ok && result.value.receipt.kind === "evaluated") {
    return { kind: "evaluated", recorded: result.value.recorded.length };
  }
  if (result.ok && result.value.receipt.kind === "reserved")
    return {
      kind: "retry",
      reason: "case_context_discovery_evaluation_pending",
    };
  if (result.ok) {
    return {
      kind: "terminal",
      reason:
        result.value.receipt.kind === "failed"
          ? result.value.receipt.failureCode
          : `case_context_discovery_evaluation_${result.value.receipt.kind}`,
    };
  }
  return result.error.code === "case_context_collection_revision_conflict" ||
    result.error.code === "case_context_discovery_budget_exhausted" ||
    result.error.code === "case_context_discovery_rate_limited" ||
    result.error.code === "organisation_placement_conflict"
    ? { kind: "retry", reason: result.error.code }
    : { kind: "terminal", reason: result.error.code };
}

function placementRetry(): EmailCaseContextDiscoveryOutcome {
  return { kind: "retry", reason: "connector_placement_conflict" };
}

async function readEmailCaseContextCollectionReceipt(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    messageId: string;
  }>,
): Promise<EmailCaseContextCollectionReceipt | null> {
  const row = await input.db
    .prepare(
      `SELECT provider_message_id AS messageId, gmail_thread_id AS threadId,
              case_id AS caseId, admitted_at AS admittedAt
       FROM email_message_receipt
       WHERE organisation_id = ? AND integration_account_id = ? AND provider_message_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId, input.messageId)
    .first<Record<string, unknown>>();
  return parseEmailCaseContextCollectionReceipt(row);
}

async function listEmailCaseContextDiscoveryCandidates(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    excludedCaseId: CaseId;
    anchorAdmittedAt: number;
  }>,
): Promise<readonly EmailCaseContextCollectionReceipt[]> {
  const rows = await input.db
    .prepare(
      `SELECT provider_message_id AS messageId, gmail_thread_id AS threadId,
              case_id AS caseId, admitted_at AS admittedAt
       FROM email_message_receipt
       WHERE organisation_id = ? AND integration_account_id = ? AND case_id <> ?
         AND admitted_at BETWEEN ? AND ?
       ORDER BY admitted_at DESC LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.excludedCaseId,
      Math.max(0, input.anchorAdmittedAt - CANDIDATE_WINDOW_MS),
      input.anchorAdmittedAt,
      MAX_CANDIDATE_RECEIPTS,
    )
    .all<Record<string, unknown>>();
  const receipts: EmailCaseContextCollectionReceipt[] = [];
  for (const row of rows.results) {
    const receipt = parseEmailCaseContextCollectionReceipt(row);
    if (receipt !== null) receipts.push(receipt);
  }
  return receipts;
}

function parseEmailCaseContextCollectionReceipt(
  raw: Record<string, unknown> | null,
): EmailCaseContextCollectionReceipt | null {
  if (
    raw === null ||
    typeof raw.messageId !== "string" ||
    raw.messageId.length === 0 ||
    typeof raw.threadId !== "string" ||
    raw.threadId.length === 0 ||
    typeof raw.caseId !== "string" ||
    typeof raw.admittedAt !== "number" ||
    !Number.isSafeInteger(raw.admittedAt) ||
    raw.admittedAt < 0
  ) {
    return null;
  }
  const caseId = parseCaseId(raw.caseId);
  return caseId.ok
    ? {
        messageId: raw.messageId,
        threadId: raw.threadId,
        caseId: caseId.value,
        admittedAt: raw.admittedAt,
      }
    : null;
}

function caseContextCollectionSelection(
  receipt: EmailCaseContextCollectionReceipt,
  integrationAccountId: IntegrationAccountId,
  verification: Readonly<{
    verificationId: string;
    verificationRevision: number;
  }>,
): CaseContextCollectionSelection {
  return {
    caseId: receipt.caseId,
    source: "gmail",
    integrationAccountId,
    reference: receipt.messageId,
    sourceRevision: receipt.admittedAt,
    verificationId: verification.verificationId,
    verificationRevision: verification.verificationRevision,
  };
}

function emailEvidence(
  message: Readonly<{
    headers: Readonly<{ subject: string }>;
    bodyText: string;
  }>,
): string {
  const evidence = `Subject: ${message.headers.subject}\nBody:\n${message.bodyText}`;
  return truncateUtf8(
    evidence.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " "),
    MAX_EVIDENCE_BYTES,
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
