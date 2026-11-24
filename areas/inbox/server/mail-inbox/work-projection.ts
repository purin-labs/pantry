import type { CaseAssignmentLifecycle, CaseLifecycle } from "@purin-labs/contracts";
import type {
  MailWorkAssignment,
  MailWorkCaseState,
  MailWorkReply,
  MailWorkReplyState,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import type { CaseGmailReplyProposal } from "../actors/case-inbox/email-proposals";
import type { EmailReplyProposalLifecycle } from "../data/email-mailbox";

export function mailWorkCaseState(lifecycle: CaseLifecycle): MailWorkCaseState {
  switch (lifecycle.kind) {
    case "waiting":
      return { kind: "waiting", reason: lifecycle.wait.kind };
    case "open":
    case "quarantined":
      return { kind: lifecycle.kind };
    default:
      return assertNever(lifecycle);
  }
}

export function mailWorkAssignment(
  lifecycle: CaseAssignmentLifecycle,
): MailWorkAssignment {
  const assignmentId = lifecycle.assignment.assignmentId;
  switch (lifecycle.kind) {
    case "assigned":
      return { kind: "assigned", assignmentId };
    case "running":
      return {
        kind: "running",
        assignmentId,
        startedAt: lifecycle.start.acceptedAt,
      };
    case "settled":
      return {
        // The mailbox shows an abandoned assignment as the failure it is.
        kind:
          lifecycle.disposition.kind === "abandoned"
            ? "failed"
            : lifecycle.disposition.kind,
        assignmentId,
        startedAt: lifecycle.start.acceptedAt,
        settledAt: lifecycle.disposition.settledAt,
      };
    default:
      return assertNever(lifecycle);
  }
}

export function mailWorkReply(proposal: CaseGmailReplyProposal): MailWorkReply {
  return {
    proposalId: proposal.proposalId,
    version: proposal.version,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    state: mailWorkReplyState(proposal.lifecycle),
  };
}

function mailWorkReplyState(
  lifecycle: EmailReplyProposalLifecycle,
): MailWorkReplyState {
  switch (lifecycle.kind) {
    case "sent":
      return {
        kind: "sent",
        providerMessageId: lifecycle.providerMessageId,
        sentAt: lifecycle.sentAt,
      };
    case "send_indeterminate":
      return {
        kind: "send_indeterminate",
        rfcMessageId: lifecycle.rfcMessageId,
      };
    case "invalidated":
      return { kind: "invalidated", reason: lifecycle.reason };
    case "draft_creation_indeterminate":
    case "awaiting_approval":
    case "approved":
    case "operator_attested_present":
    case "operator_attested_absent":
    case "proposal_missing":
    case "rejected":
    case "expired":
    case "superseded":
    case "revoked":
      return { kind: lifecycle.kind };
    default:
      return assertNever(lifecycle);
  }
}
