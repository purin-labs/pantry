import { isRecord, assertNever } from "@seams/std";
import { mailIdentifier, mailRevision } from "./mail-organization.ts";

export type MailWorkCaseState =
  | Readonly<{
      kind: "open" | "completing" | "completed" | "quarantined" | "archived";
      reason?: never;
    }>
  | Readonly<{ kind: "waiting"; reason: "input" | "approval" | "schedule" }>;

export type MailWorkAssignment =
  | Readonly<{
      kind: "assigned";
      assignmentId: string;
      startedAt?: never;
      settledAt?: never;
    }>
  | Readonly<{
      kind: "running";
      assignmentId: string;
      startedAt: number;
      settledAt?: never;
    }>
  | Readonly<{
      kind: "completed" | "cancelled" | "failed" | "budget_exhausted";
      assignmentId: string;
      startedAt: number;
      settledAt: number;
    }>;

export type MailWorkReplyState =
  | Readonly<{
      kind:
        | "draft_creation_indeterminate"
        | "awaiting_approval"
        | "approved"
        | "proposal_missing"
        | "rejected"
        | "expired"
        | "superseded"
        | "revoked"
        | "operator_attested_present"
        | "operator_attested_absent";
      providerMessageId?: never;
      sentAt?: never;
      rfcMessageId?: never;
      reason?: never;
    }>
  | Readonly<{
      kind: "sent";
      providerMessageId: string;
      sentAt: number;
      rfcMessageId?: never;
      reason?: never;
    }>
  | Readonly<{
      kind: "send_indeterminate";
      rfcMessageId: string;
      providerMessageId?: never;
      sentAt?: never;
      reason?: never;
    }>
  | Readonly<{
      kind: "invalidated";
      reason: "target_changed" | "unsupported_content";
      providerMessageId?: never;
      sentAt?: never;
      rfcMessageId?: never;
    }>;

export type MailWorkReply = Readonly<{
  proposalId: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  state: MailWorkReplyState;
}>;

export type MailInboxWork =
  | Readonly<{
      kind: "unlinked";
      caseId?: never;
      revision?: never;
      state?: never;
      assignments?: never;
      replies?: never;
      moreAssignments?: never;
      moreReplies?: never;
    }>
  | Readonly<{
      kind: "linked";
      caseId: string;
      revision: number;
      state: MailWorkCaseState;
      assignments: readonly MailWorkAssignment[];
      replies: readonly MailWorkReply[];
      moreAssignments: boolean;
      moreReplies: boolean;
    }>;

export type MailInboxReplyPreview =
  | Readonly<{
      kind: "current";
      version: number;
      bodyEdited: boolean;
      to: string;
      subject: string;
      body: string;
      expiresAt: number;
      reason?: never;
    }>
  | Readonly<{
      kind: "proposal_missing" | "expired";
      version?: never;
      bodyEdited?: never;
      to?: never;
      subject?: never;
      body?: never;
      expiresAt?: never;
      reason?: never;
    }>
  | Readonly<{
      kind: "invalidated";
      reason: "target_changed" | "unsupported_content";
      version?: never;
      bodyEdited?: never;
      to?: never;
      subject?: never;
      body?: never;
      expiresAt?: never;
    }>;

export function parseMailInboxWork(raw: unknown): MailInboxWork | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "unlinked") return { kind: "unlinked" };
  if (
    raw.kind !== "linked" ||
    !mailIdentifier(raw.caseId) ||
    !mailRevision(raw.revision) ||
    !Array.isArray(raw.assignments) ||
    raw.assignments.length > 20 ||
    !Array.isArray(raw.replies) ||
    raw.replies.length > 20 ||
    typeof raw.moreAssignments !== "boolean" ||
    typeof raw.moreReplies !== "boolean"
  )
    return null;
  const state = parseCaseState(raw.state);
  if (state === null) return null;
  const assignments: MailWorkAssignment[] = [];
  for (const value of raw.assignments) {
    const assignment = parseAssignment(value);
    if (assignment === null) return null;
    assignments.push(assignment);
  }
  const replies: MailWorkReply[] = [];
  for (const value of raw.replies) {
    if (
      !isRecord(value) ||
      !mailIdentifier(value.proposalId) ||
      !mailRevision(value.version) ||
      value.version < 1 ||
      !mailWorkTime(value.createdAt) ||
      !mailWorkTime(value.expiresAt)
    )
      return null;
    const replyState = parseReplyState(value.state);
    if (replyState === null) return null;
    replies.push({
      proposalId: value.proposalId,
      version: value.version,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      state: replyState,
    });
  }
  return {
    kind: "linked",
    caseId: raw.caseId,
    revision: raw.revision,
    state,
    assignments,
    replies,
    moreAssignments: raw.moreAssignments,
    moreReplies: raw.moreReplies,
  };
}

function parseCaseState(raw: unknown): MailWorkCaseState | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "open":
    case "completing":
    case "completed":
    case "quarantined":
    case "archived":
      return { kind: raw.kind };
    case "waiting":
      return raw.reason === "input" ||
        raw.reason === "approval" ||
        raw.reason === "schedule"
        ? { kind: "waiting", reason: raw.reason }
        : null;
    default:
      return null;
  }
}

function parseAssignment(raw: unknown): MailWorkAssignment | null {
  if (!isRecord(raw) || !mailIdentifier(raw.assignmentId)) return null;
  if (raw.kind === "assigned")
    return { kind: "assigned", assignmentId: raw.assignmentId };
  if (!mailWorkTime(raw.startedAt)) return null;
  if (raw.kind === "running")
    return {
      kind: "running",
      assignmentId: raw.assignmentId,
      startedAt: raw.startedAt,
    };
  if (!mailWorkTime(raw.settledAt) || raw.settledAt < raw.startedAt)
    return null;
  switch (raw.kind) {
    case "completed":
    case "cancelled":
    case "failed":
    case "budget_exhausted":
      return {
        kind: raw.kind,
        assignmentId: raw.assignmentId,
        startedAt: raw.startedAt,
        settledAt: raw.settledAt,
      };
    default:
      return null;
  }
}

function parseReplyState(raw: unknown): MailWorkReplyState | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "draft_creation_indeterminate":
    case "awaiting_approval":
    case "approved":
    case "proposal_missing":
    case "rejected":
    case "expired":
    case "superseded":
    case "revoked":
    case "operator_attested_present":
    case "operator_attested_absent":
      return { kind: raw.kind };
    case "sent":
      return mailIdentifier(raw.providerMessageId) && mailWorkTime(raw.sentAt)
        ? {
            kind: "sent",
            providerMessageId: raw.providerMessageId,
            sentAt: raw.sentAt,
          }
        : null;
    case "send_indeterminate":
      return typeof raw.rfcMessageId === "string" &&
        raw.rfcMessageId.length <= 512
        ? { kind: "send_indeterminate", rfcMessageId: raw.rfcMessageId }
        : null;
    case "invalidated":
      return raw.reason === "target_changed" ||
        raw.reason === "unsupported_content"
        ? { kind: "invalidated", reason: raw.reason }
        : null;
    default:
      return null;
  }
}

export function parseMailInboxReplyPreview(
  raw: unknown,
): MailInboxReplyPreview | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "proposal_missing" || raw.kind === "expired")
    return { kind: raw.kind };
  if (raw.kind === "invalidated")
    return raw.reason === "target_changed" ||
      raw.reason === "unsupported_content"
      ? { kind: "invalidated", reason: raw.reason }
      : null;
  if (
    raw.kind !== "current" ||
    !mailRevision(raw.version) ||
    raw.version < 1 ||
    typeof raw.bodyEdited !== "boolean" ||
    typeof raw.to !== "string" ||
    typeof raw.subject !== "string" ||
    typeof raw.body !== "string" ||
    !mailWorkTime(raw.expiresAt)
  )
    return null;
  return {
    kind: "current",
    version: raw.version,
    bodyEdited: raw.bodyEdited,
    to: raw.to,
    subject: raw.subject,
    body: raw.body,
    expiresAt: raw.expiresAt,
  };
}

function mailWorkTime(raw: unknown): raw is number {
  return (
    typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    raw >= 0 &&
    raw <= 8_640_000_000_000_000
  );
}

export function mailWorkReplyCanPreview(state: MailWorkReplyState): boolean {
  switch (state.kind) {
    case "awaiting_approval":
      return true;
    case "draft_creation_indeterminate":
    case "approved":
    case "proposal_missing":
    case "rejected":
    case "expired":
    case "superseded":
    case "revoked":
    case "operator_attested_present":
    case "operator_attested_absent":
    case "sent":
    case "send_indeterminate":
    case "invalidated":
      return false;
    default:
      return assertNever(state);
  }
}
