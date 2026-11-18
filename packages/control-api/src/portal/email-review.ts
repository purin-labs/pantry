import type {
  EmailOperationalPreviewResult,
  EmailOperationalQueueItem,
  EmailOperationalTargetView,
  EmailReplyMemory,
  EmailReplyPreviewResult,
  EmailReplyQueueItem,
} from "./agent-mailbox.ts";
import {
  parseEmailReplyHeadline,
  parseMailReplySources,
  type EmailReplyHeadline,
} from "../index.ts";
import {
  isNonEmptyString,
  isRecord,
  isSha256Hex,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
} from "@seams/std";

export type EmailReviewQueue = Readonly<{
  replies: readonly EmailReplyQueueItem[];
  operational: readonly EmailOperationalQueueItem[];
}>;

export function parseEmailReviewQueue(raw: unknown): EmailReviewQueue {
  if (!Array.isArray(raw)) {
    throw new Error("The server returned an invalid email approval queue.");
  }
  const replies: EmailReplyQueueItem[] = [];
  const operational: EmailOperationalQueueItem[] = [];
  for (const review of raw) {
    if (!isRecord(review) || !isRecord(review.backing)) {
      throw new Error("The server returned an invalid email approval item.");
    }
    if (
      review.kind === "gmail_reply" &&
      review.backing.kind === "gmail_draft"
    ) {
      replies.push(parseEmailReplyQueueItem(review, review.backing));
      continue;
    }
    if (
      review.kind === "operational_new_message" &&
      review.backing.kind === "encrypted_connector"
    ) {
      operational.push(parseEmailOperationalQueueItem(review, review.backing));
      continue;
    }
    throw new Error("The server returned an unknown email approval item.");
  }
  return { replies, operational };
}

export function parseEmailReplyPreviewResponse(
  raw: unknown,
): EmailReplyPreviewResult {
  if (!isRecord(raw) || raw.ok !== true || typeof raw.kind !== "string") {
    throw new Error("The server returned an invalid email reply preview.");
  }
  if (raw.kind === "proposal_missing") return { kind: "proposal_missing" };
  if (raw.kind === "expired") return { kind: "expired" };
  if (raw.kind === "invalidated" && typeof raw.reason === "string") {
    return { kind: "invalidated", reason: raw.reason };
  }
  if (
    raw.kind !== "current" ||
    !isRecord(raw.proposal) ||
    !isNonEmptyString(raw.challenge)
  ) {
    throw new Error("The server returned an unknown email reply preview.");
  }
  const proposal = raw.proposal;
  const version = positiveIntegerOrNull(proposal.version);
  const expiresAt = nonNegativeIntegerOrNull(proposal.expires_at);
  if (
    !isNonEmptyString(proposal.proposal_id) ||
    version === null ||
    typeof proposal.body_edited !== "boolean" ||
    !isNonEmptyString(proposal.to) ||
    typeof proposal.subject !== "string" ||
    !isNonEmptyString(proposal.gmail_thread_id) ||
    typeof proposal.body !== "string" ||
    !isSha256Hex(proposal.snapshot_digest) ||
    expiresAt === null
  ) {
    throw new Error("The server returned invalid email reply content.");
  }
  const sources = parseMailReplySources(raw.sources, proposal.body.length);
  if (sources === null)
    throw new Error("The server returned invalid email reply sources.");
  return {
    kind: "current",
    proposal: {
      proposalId: proposal.proposal_id,
      version,
      bodyEdited: proposal.body_edited,
      to: proposal.to,
      subject: proposal.subject,
      gmailThreadId: proposal.gmail_thread_id,
      body: proposal.body,
      snapshotDigest: proposal.snapshot_digest,
      expiresAt,
    },
    challenge: raw.challenge,
    memory: parseEmailReplyMemory(raw.memory),
    sources,
  };
}

/** The memories the server lists for a draft. An absent list is empty. */
function parseEmailReplyMemory(raw: unknown): readonly EmailReplyMemory[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new Error("The server returned invalid email reply memory.");
  return raw.map((entry: unknown) => {
    const revision = isRecord(entry)
      ? positiveIntegerOrNull(entry.revision)
      : null;
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.memory_id) ||
      revision === null ||
      !isNonEmptyString(entry.statement)
    )
      throw new Error("The server returned invalid email reply memory.");
    return {
      memoryId: entry.memory_id,
      revision,
      statement: entry.statement,
    };
  });
}

export function parseEmailOperationalPreviewResponse(
  raw: unknown,
): EmailOperationalPreviewResult {
  if (!isRecord(raw) || raw.ok !== true || typeof raw.kind !== "string") {
    throw new Error(
      "The server returned an invalid operational email preview.",
    );
  }
  if (
    raw.kind === "proposal_missing" ||
    raw.kind === "expired" ||
    raw.kind === "target_changed" ||
    raw.kind === "content_unavailable"
  ) {
    return { kind: raw.kind };
  }
  if (
    raw.kind !== "current" ||
    !isRecord(raw.proposal) ||
    !isNonEmptyString(raw.challenge)
  ) {
    throw new Error(
      "The server returned an unknown operational email preview.",
    );
  }
  const proposal = raw.proposal;
  const version = positiveIntegerOrNull(proposal.version);
  const expiresAt = nonNegativeIntegerOrNull(proposal.expires_at);
  const target = parseEmailOperationalTargetView(proposal.target);
  if (
    !isNonEmptyString(proposal.proposal_id) ||
    version === null ||
    !isNonEmptyString(proposal.case_id) ||
    !isNonEmptyString(proposal.integration_account_id) ||
    target === null ||
    !isNonEmptyString(proposal.from) ||
    !isNonEmptyString(proposal.to) ||
    (proposal.recipient_display_name !== null &&
      !isNonEmptyString(proposal.recipient_display_name)) ||
    typeof proposal.subject !== "string" ||
    typeof proposal.body !== "string" ||
    !isSha256Hex(proposal.target_digest) ||
    !isSha256Hex(proposal.snapshot_digest) ||
    expiresAt === null
  ) {
    throw new Error("The server returned invalid operational email content.");
  }
  return {
    kind: "current",
    proposal: {
      proposalId: proposal.proposal_id,
      version,
      caseId: proposal.case_id,
      integrationAccountId: proposal.integration_account_id,
      target,
      from: proposal.from,
      to: proposal.to,
      recipientDisplayName: proposal.recipient_display_name,
      subject: proposal.subject,
      body: proposal.body,
      targetDigest: proposal.target_digest,
      snapshotDigest: proposal.snapshot_digest,
      expiresAt,
    },
    challenge: raw.challenge,
  };
}

function parseEmailReplyQueueItem(
  raw: Readonly<Record<string, unknown>>,
  backing: Readonly<Record<string, unknown>>,
): EmailReplyQueueItem {
  const version = positiveIntegerOrNull(raw.version);
  const createdAt = nonNegativeIntegerOrNull(raw.created_at);
  const updatedAt = nonNegativeIntegerOrNull(raw.updated_at);
  // A queue read in a conversation names no mail.
  const headline: EmailReplyHeadline | null | undefined =
    raw.headline === undefined || raw.headline === null
      ? null
      : (parseEmailReplyHeadline(raw.headline) ?? undefined);
  if (
    !isNonEmptyString(raw.proposal_id) ||
    !isNonEmptyString(raw.integration_account_id) ||
    !isNonEmptyString(raw.case_id) ||
    !isNonEmptyString(backing.gmail_thread_id) ||
    version === null ||
    !isNonEmptyString(raw.lifecycle_kind) ||
    createdAt === null ||
    updatedAt === null ||
    headline === undefined
  ) {
    throw new Error("The server returned an invalid email approval item.");
  }
  return {
    proposalId: raw.proposal_id,
    integrationAccountId: raw.integration_account_id,
    caseId: raw.case_id,
    gmailThreadId: backing.gmail_thread_id,
    version,
    lifecycleKind: raw.lifecycle_kind,
    createdAt,
    updatedAt,
    headline,
  };
}

function parseEmailOperationalQueueItem(
  raw: Readonly<Record<string, unknown>>,
  backing: Readonly<Record<string, unknown>>,
): EmailOperationalQueueItem {
  const version = positiveIntegerOrNull(raw.version);
  const createdAt = nonNegativeIntegerOrNull(raw.created_at);
  const updatedAt = nonNegativeIntegerOrNull(raw.updated_at);
  const target = parseEmailOperationalTargetView(backing.target);
  if (
    !isNonEmptyString(raw.proposal_id) ||
    !isNonEmptyString(raw.integration_account_id) ||
    !isNonEmptyString(raw.case_id) ||
    version === null ||
    target === null ||
    !isSha256Hex(backing.snapshot_digest) ||
    !isNonEmptyString(raw.lifecycle_kind) ||
    (backing.indeterminate_rfc_message_id !== null &&
      !isNonEmptyString(backing.indeterminate_rfc_message_id)) ||
    createdAt === null ||
    updatedAt === null
  ) {
    throw new Error("The server returned an invalid operational email item.");
  }
  return {
    proposalId: raw.proposal_id,
    integrationAccountId: raw.integration_account_id,
    caseId: raw.case_id,
    target,
    version,
    snapshotDigest: backing.snapshot_digest,
    indeterminateRfcMessageId: backing.indeterminate_rfc_message_id,
    lifecycleKind: raw.lifecycle_kind,
    createdAt,
    updatedAt,
  };
}

function parseEmailOperationalTargetView(
  raw: unknown,
): EmailOperationalTargetView | null {
  if (
    isRecord(raw) &&
    raw.kind === "self_test" &&
    isNonEmptyString(raw.selfTestId) &&
    Object.keys(raw).length === 2
  ) {
    return { kind: "self_test", selfTestId: raw.selfTestId };
  }
  if (!isRecord(raw) || !isNonEmptyString(raw.contactId)) return null;
  const contactRevision = positiveIntegerOrNull(raw.contactRevision);
  if (contactRevision === null) return null;
  if (raw.kind === "customer_contact" && isNonEmptyString(raw.customerId)) {
    return {
      kind: "customer_contact",
      customerId: raw.customerId,
      contactId: raw.contactId,
      contactRevision,
    };
  }
  if (raw.kind === "supplier_contact" && isNonEmptyString(raw.supplierId)) {
    return {
      kind: "supplier_contact",
      supplierId: raw.supplierId,
      contactId: raw.contactId,
      contactRevision,
    };
  }
  return null;
}
