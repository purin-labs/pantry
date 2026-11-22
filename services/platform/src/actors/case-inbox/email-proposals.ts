import type {
  MailInboxWork,
  MailWorkAssignment,
  MailWorkReply,
} from "@purin-labs/control-api";
import { checked } from "@purin-labs/contracts/connector-rpc";
import {
  emailProposalEvidenceSchema,
  operationalEmailProposalSchema,
  replyEmailProposalSchema,
} from "@purin-labs/contracts/case-rpc";
import type { Variant } from "@purin-labs/type-utils";
import {
  parseCaseEvidenceDependency,
  type CaseContextCollectionProposalEvidence,
} from "@purin-labs/agent/case-context-discovery/evidence";
import {
  parseEmailReplyProposalLifecycle,
  type EmailReplyProposalLifecycle,
} from "../../data/email-mailbox";
import {
  parseEmailProposalTarget,
  type EmailProposalTarget,
} from "../../data/email-operational";
import { emailReplyProposalTransition } from "../../data/email-reply-proposal-lifecycle";
import type { CaseId, OrganisationId } from "@purin-labs/kernel/ids";
import {
  mailWorkAssignment,
  mailWorkCaseState,
  mailWorkReply,
} from "../../mail-inbox/work-projection";
import { readMeta } from "@purin-labs/conversation/actors/case/context-source";
import {
  invalid,
  parseAssignmentLifecycleJson,
  parseLifecycle,
} from "@purin-labs/conversation/actors/case/record-parsers";
import { readCaseMetaId } from "@purin-labs/conversation/actors/case/request-parsers";
import type { CaseResult, JsonRow, LifecycleRow } from "@purin-labs/conversation/actors/case/types";

/*
 * The Inbox part of the Case (Refactor 17, steps A1.6 and A1.9): the email
 * reply proposals of a Case, in the Case table `case_email_proposal`, and the
 * mail work of a thread. `CaseDO` implements `CaseInboxRpc` with these
 * functions; each RPC method calls one of them.
 */

export type CaseGmailReplyProposal = {
  readonly evidence: CaseContextCollectionProposalEvidence;
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly threadId: string;
  readonly providerDraftId: string;
  readonly providerDraftMessageId: string;
  readonly triggeringProviderMessageId: string;
  readonly mailboxBindingId: string;
  readonly bindingRevision: number;
  readonly policyVersion: number;
  readonly targetDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lifecycle: EmailReplyProposalLifecycle;
};

type CaseOperationalEmailProposal = {
  readonly kind: "operational_new_message";
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly integrationAccountId: string;
  readonly target: EmailProposalTarget;
  readonly targetDigest: string;
  readonly subjectDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly policyVersion: number;
  readonly credentialGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lifecycle: EmailReplyProposalLifecycle;
};

export type CaseEmailProposal =
  CaseGmailReplyProposal | CaseOperationalEmailProposal;

function parseCaseEmailProposal(
  value: unknown,
): CaseEmailProposal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  if ((value as Record<string, unknown>).kind === "operational_new_message") {
    const proposal = checked(operationalEmailProposalSchema, value);
    if (proposal === null) return null;
    const lifecycle = parseEmailReplyProposalLifecycle(proposal.lifecycle);
    const target = parseEmailProposalTarget(proposal.target);
    if (!lifecycle.ok || target === null) return null;
    return {
      kind: "operational_new_message",
      proposalId: proposal.proposalId,
      version: proposal.version,
      caseId: proposal.caseId,
      integrationAccountId: proposal.integrationAccountId,
      target,
      targetDigest: proposal.targetDigest,
      subjectDigest: proposal.subjectDigest,
      bodyDigest: proposal.bodyDigest,
      snapshotDigest: proposal.snapshotDigest,
      policyVersion: proposal.policyVersion,
      credentialGeneration: proposal.credentialGeneration,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      lifecycle: lifecycle.value,
    };
  }
  const proposal = checked(replyEmailProposalSchema, value);
  if (proposal === null) return null;
  const lifecycle = parseEmailReplyProposalLifecycle(proposal.lifecycle);
  const evidence = parseEmailProposalEvidence(proposal.evidence);
  if (!lifecycle.ok || evidence === null) return null;
  return {
    proposalId: proposal.proposalId,
    version: proposal.version,
    caseId: proposal.caseId,
    threadId: proposal.threadId,
    providerDraftId: proposal.providerDraftId,
    evidence,
    providerDraftMessageId: proposal.providerDraftMessageId,
    triggeringProviderMessageId: proposal.triggeringProviderMessageId,
    mailboxBindingId: proposal.mailboxBindingId,
    bindingRevision: proposal.bindingRevision,
    policyVersion: proposal.policyVersion,
    targetDigest: proposal.targetDigest,
    bodyDigest: proposal.bodyDigest,
    snapshotDigest: proposal.snapshotDigest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    lifecycle: lifecycle.value,
  };
}

function parseCaseEmailProposalJson(
  payload: string,
): CaseEmailProposal | null {
  try {
    return parseCaseEmailProposal(JSON.parse(payload));
  } catch {
    return null;
  }
}

function parseEmailProposalEvidence(
  raw: unknown,
): CaseContextCollectionProposalEvidence | null {
  if (raw === undefined) return { kind: "source_only" };
  const evidence = checked(emailProposalEvidenceSchema, raw);
  if (evidence === null) return null;
  if (evidence.kind === "source_only") return { kind: "source_only" };
  const dependency = parseCaseEvidenceDependency(evidence.dependency);
  return dependency?.kind === "case_context_collection_evidence"
    ? {
        kind: "case_context_collection_evidence",
        dependency,
        flowBindingDigest: evidence.flowBindingDigest,
      }
    : null;
}

export function acceptCaseEmailProposal(
  storage: DurableObjectStorage,
  raw: unknown,
): CaseResult<{ readonly kind: "accepted" | "duplicate" }> {
  const input = parseCaseEmailProposal(raw);
  if (input === null) return invalid("case_email_proposal_invalid");
  if (input.caseId !== readCaseMetaId(storage.sql)) {
    return invalid("case_email_proposal_case_mismatch");
  }
  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM case_email_proposal WHERE proposal_id = ? AND version = ?",
        input.proposalId,
        input.version,
      )
      .toArray()[0];
    const payload = JSON.stringify(input);
    if (existing !== undefined) {
      return existing.payload === payload
        ? { ok: true as const, value: { kind: "duplicate" as const } }
        : invalid("case_email_proposal_conflict");
    }
    storage.sql.exec(
      "INSERT INTO case_email_proposal (proposal_id, version, payload) VALUES (?, ?, ?)",
      input.proposalId,
      input.version,
      payload,
    );
    return { ok: true as const, value: { kind: "accepted" as const } };
  });
}

export function transitionCaseEmailProposal(
  storage: DurableObjectStorage,
  raw: unknown,
): CaseResult<{ readonly kind: "transitioned" | "unchanged" }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("case_email_proposal_transition_invalid");
  }
  const request = raw as Record<string, unknown>;
  const lifecycle = parseEmailReplyProposalLifecycle(request.lifecycle);
  if (
    !lifecycle.ok ||
    typeof request.proposalId !== "string" ||
    typeof request.version !== "number" ||
    !Number.isSafeInteger(request.version)
  ) {
    return invalid("case_email_proposal_transition_invalid");
  }
  const proposalId = request.proposalId;
  const version = request.version;
  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM case_email_proposal WHERE proposal_id = ? AND version = ?",
        proposalId,
        version,
      )
      .toArray()[0];
    if (existing === undefined) return invalid("case_email_proposal_unknown");
    const parsed = parseCaseEmailProposalJson(existing.payload);
    if (parsed === null) return invalid("case_email_proposal_corrupt");
    const move = emailReplyProposalTransition(
      parsed.lifecycle.kind,
      lifecycle.value.kind,
    );
    // A repeat of the terminal state changes nothing, so the copies may
    // follow it. Any other move out of a terminal state is immutable, and a
    // move that the machine does not allow is refused.
    if (move.kind === "repeat")
      return { ok: true as const, value: { kind: "unchanged" as const } };
    if (move.kind === "refused")
      return invalid(
        move.terminal
          ? "case_email_proposal_immutable"
          : "case_email_proposal_transition_refused",
      );
    const written = storage.sql.exec(
      `UPDATE case_email_proposal SET payload = ?
          WHERE proposal_id = ? AND version = ?
            AND json_extract(payload, '$.lifecycle.kind') = ?`,
      JSON.stringify({ ...parsed, lifecycle: lifecycle.value }),
      proposalId,
      version,
      parsed.lifecycle.kind,
    );
    if (written.rowsWritten !== 1)
      return invalid("case_email_proposal_transition_stale");
    return { ok: true as const, value: { kind: "transitioned" as const } };
  });
}

export function readCaseEmailProposals(
  storage: DurableObjectStorage,
): CaseResult<readonly CaseEmailProposal[]> {
  const rows = storage.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM case_email_proposal ORDER BY proposal_id, version",
    )
    .toArray();
  const proposals: CaseEmailProposal[] = [];
  for (const row of rows) {
    const parsed = parseCaseEmailProposalJson(row.payload);
    if (parsed === null) return invalid("case_email_proposal_corrupt");
    proposals.push(parsed);
  }
  return { ok: true, value: proposals };
}

export function readCaseMailWork(
  storage: DurableObjectStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: CaseId;
    threadId: string;
  }>,
): CaseResult<Variant<MailInboxWork, "linked">> {
  // Inbox projection excludes Case journals, objectives and assignment context.
  const sql = storage.sql;
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.organisation_id !== input.organisationId ||
    meta.case_id !== input.caseId
  )
    return invalid("mail_inbox_not_found");
  const lifecycle = parseLifecycle(meta.lifecycle_json);
  if (lifecycle === null) return invalid("case_storage_corrupt");
  const assignmentRows = sql
    .exec<LifecycleRow>(
      "SELECT lifecycle_json FROM case_assignment ORDER BY rowid DESC LIMIT 21",
    )
    .toArray();
  const assignments: MailWorkAssignment[] = [];
  for (const row of assignmentRows.slice(0, 20)) {
    const assignment = parseAssignmentLifecycleJson(row.lifecycle_json);
    if (assignment === null) return invalid("case_storage_corrupt");
    assignments.push(mailWorkAssignment(assignment));
  }
  const proposalRows = sql
    .exec<JsonRow>(
      `SELECT payload FROM case_email_proposal AS current
       WHERE json_extract(payload, '$.threadId') = ?
         AND json_extract(payload, '$.kind') IS NULL
         AND version = (SELECT MAX(version) FROM case_email_proposal WHERE proposal_id = current.proposal_id)
       ORDER BY rowid DESC LIMIT 21`,
      input.threadId,
    )
    .toArray();
  const replies: MailWorkReply[] = [];
  for (const row of proposalRows.slice(0, 20)) {
    const proposal = parseCaseEmailProposalJson(row.payload);
    if (
      proposal === null ||
      "kind" in proposal ||
      proposal.caseId !== input.caseId ||
      proposal.threadId !== input.threadId
    )
      return invalid("case_storage_corrupt");
    replies.push(mailWorkReply(proposal));
  }
  return {
    ok: true,
    value: {
      kind: "linked",
      caseId: meta.case_id,
      revision: meta.revision,
      state: mailWorkCaseState(lifecycle),
      assignments,
      replies,
      moreAssignments: assignmentRows.length > 20,
      moreReplies: proposalRows.length > 20,
    },
  };
}
