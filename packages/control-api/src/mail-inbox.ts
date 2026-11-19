import { isRecord } from "@purin-labs/std";
import {
  parseMailInboxWork,
  parseMailInboxReplyPreview,
  type MailInboxWork,
  type MailInboxReplyPreview,
} from "./mail-work.ts";
import {
  mailIdentifier,
  mailRevision,
  parseMailDecision,
  type MailDecision,
} from "./mail-organization.ts";

export type MailClassifiedFilter =
  | Readonly<{ kind: "important"; ruleId?: never }>
  | Readonly<{ kind: "category"; ruleId: string }>;

export function parseMailClassifiedFilter(
  raw: unknown,
): MailClassifiedFilter | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "important" && Object.keys(raw).length === 1)
    return { kind: "important" };
  if (
    raw.kind === "category" &&
    Object.keys(raw).length === 2 &&
    mailIdentifier(raw.ruleId)
  )
    return { kind: "category", ruleId: raw.ruleId };
  return null;
}

/**
 * A mailbox that the person may read. `reconnect_required`: Google refused
 * the sign-in, so Pantry reads no mail of it until someone connects it again.
 */
export type MailInboxAccountAccess = "readable" | "reconnect_required";

export type MailInboxAccount = Readonly<{
  integrationAccountId: string;
  displayName: string;
  access: MailInboxAccountAccess;
}>;

export type MailInboxMessage = Readonly<{
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  receivedAt: number;
  unread: boolean;
}>;

export type MailInboxThreadMessage = MailInboxMessage &
  Readonly<{
    body: string;
    attachmentNames: readonly string[];
  }>;

export type MailInboxResult =
  | Readonly<{
      kind: "work";
      threadId: string;
      work: MailInboxWork;
      preview?: never;
      proposalId?: never;
      messages?: never;
      accounts?: never;
      nextCursor?: never;
      decision?: never;
    }>
  | Readonly<{
      kind: "reply";
      threadId: string;
      proposalId: string;
      preview: MailInboxReplyPreview;
      work?: never;
      messages?: never;
      accounts?: never;
      nextCursor?: never;
      decision?: never;
    }>
  | Readonly<{
      kind: "accounts";
      work?: never;
      preview?: never;
      proposalId?: never;
      accounts: readonly MailInboxAccount[];
      messages?: never;
      nextCursor?: never;
      threadId?: never;
      decision?: never;
    }>
  | Readonly<{
      kind: "page";
      work?: never;
      preview?: never;
      proposalId?: never;
      accounts?: never;
      threadId?: never;
      messages: readonly MailInboxMessage[];
      nextCursor: string | null;
      decision?: never;
    }>
  | Readonly<{
      kind: "thread";
      work?: never;
      preview?: never;
      proposalId?: never;
      accounts?: never;
      nextCursor?: never;
      threadId: string;
      messages: readonly MailInboxThreadMessage[];
      decision?: never;
    }>
  | Readonly<{
      kind: "decision";
      work?: never;
      preview?: never;
      proposalId?: never;
      decision: MailDecision;
      messages?: never;
      accounts?: never;
      nextCursor?: never;
      threadId?: never;
    }>;

export type MailInboxCommand =
  | Readonly<{
      kind: "work";
      integrationAccountId: string;
      threadId: string;
      proposalId?: never;
      messageId?: never;
      ruleId?: never;
      query?: never;
      cursor?: never;
      filter?: never;
      expectedRevision?: never;
    }>
  | Readonly<{
      kind: "reply";
      integrationAccountId: string;
      threadId: string;
      proposalId: string;
      messageId?: never;
      ruleId?: never;
      query?: never;
      cursor?: never;
      filter?: never;
      expectedRevision?: never;
    }>
  | Readonly<{
      kind: "page";
      proposalId?: never;
      integrationAccountId: string;
      messageId?: never;
      ruleId?: never;
      query: string;
      threadId?: never;
      filter?: never;
      expectedRevision?: never;
      cursor: string | null;
    }>
  | Readonly<{
      /** Gmail's Spam, read only. The agent reads none of it. */
      kind: "spamPage";
      proposalId?: never;
      integrationAccountId: string;
      messageId?: never;
      ruleId?: never;
      query?: never;
      threadId?: never;
      filter?: never;
      expectedRevision?: never;
      cursor: string | null;
    }>
  | Readonly<{
      kind: "classifiedPage";
      proposalId?: never;
      integrationAccountId: string;
      messageId?: never;
      ruleId?: never;
      filter: MailClassifiedFilter;
      expectedRevision: number;
      cursor: string | null;
      query?: never;
      threadId?: never;
    }>
  | Readonly<{
      kind: "decision";
      proposalId?: never;
      integrationAccountId: string;
      expectedRevision: number;
      messageId: string;
      ruleId: string;
      query?: never;
      cursor?: never;
      threadId?: never;
      filter?: never;
    }>
  | Readonly<{
      kind: "thread";
      proposalId?: never;
      integrationAccountId: string;
      messageId?: never;
      ruleId?: never;
      query?: never;
      cursor?: never;
      threadId: string;
      filter?: never;
      expectedRevision?: never;
    }>;

export function parseMailInboxCommand(raw: unknown): MailInboxCommand | null {
  if (!isRecord(raw) || !identifier(raw.integrationAccountId)) return null;
  if (
    raw.kind === "work" &&
    Object.keys(raw).length === 3 &&
    mailIdentifier(raw.threadId)
  )
    return {
      kind: "work",
      integrationAccountId: raw.integrationAccountId,
      threadId: raw.threadId,
    };
  if (
    raw.kind === "reply" &&
    Object.keys(raw).length === 4 &&
    mailIdentifier(raw.threadId) &&
    mailIdentifier(raw.proposalId)
  )
    return {
      kind: "reply",
      integrationAccountId: raw.integrationAccountId,
      threadId: raw.threadId,
      proposalId: raw.proposalId,
    };
  if (
    raw.kind === "decision" &&
    Object.keys(raw).length === 5 &&
    mailRevision(raw.expectedRevision) &&
    mailIdentifier(raw.messageId) &&
    mailIdentifier(raw.ruleId)
  )
    return {
      kind: "decision",
      integrationAccountId: raw.integrationAccountId,
      expectedRevision: raw.expectedRevision,
      messageId: raw.messageId,
      ruleId: raw.ruleId,
    };
  if (
    raw.kind === "classifiedPage" &&
    Object.keys(raw).length === 5 &&
    mailRevision(raw.expectedRevision) &&
    validCursor(raw.cursor)
  ) {
    const filter = parseMailClassifiedFilter(raw.filter);
    if (filter === null) return null;
    return {
      kind: "classifiedPage",
      integrationAccountId: raw.integrationAccountId,
      expectedRevision: raw.expectedRevision,
      filter,
      cursor: raw.cursor,
    };
  }
  if (
    raw.kind === "page" &&
    Object.keys(raw).length === 4 &&
    typeof raw.query === "string" &&
    raw.query.length <= 256 &&
    (raw.cursor === null ||
      (typeof raw.cursor === "string" &&
        raw.cursor.length > 0 &&
        raw.cursor.length <= 8192))
  ) {
    return {
      kind: "page",
      integrationAccountId: raw.integrationAccountId,
      query: raw.query.trim(),
      cursor: raw.cursor,
    };
  }
  if (
    raw.kind === "spamPage" &&
    Object.keys(raw).length === 3 &&
    validCursor(raw.cursor)
  )
    return {
      kind: "spamPage",
      integrationAccountId: raw.integrationAccountId,
      cursor: raw.cursor,
    };
  if (
    raw.kind === "thread" &&
    Object.keys(raw).length === 3 &&
    identifier(raw.threadId)
  ) {
    return {
      kind: "thread",
      integrationAccountId: raw.integrationAccountId,
      threadId: raw.threadId,
    };
  }
  return null;
}

function validCursor(raw: unknown): raw is string | null {
  return (
    raw === null ||
    (typeof raw === "string" && raw.length > 0 && raw.length <= 8192)
  );
}

export function parseMailInboxResult(raw: unknown): MailInboxResult | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "work" && mailIdentifier(raw.threadId)) {
    const work = parseMailInboxWork(raw.work);
    return work === null
      ? null
      : { kind: "work", threadId: raw.threadId, work };
  }
  if (
    raw.kind === "reply" &&
    mailIdentifier(raw.threadId) &&
    mailIdentifier(raw.proposalId)
  ) {
    const preview = parseMailInboxReplyPreview(raw.preview);
    return preview === null
      ? null
      : {
          kind: "reply",
          threadId: raw.threadId,
          proposalId: raw.proposalId,
          preview,
        };
  }
  if (raw.kind === "decision") {
    const decision = parseMailDecision(raw.decision);
    return decision === null ? null : { kind: "decision", decision };
  }
  if (raw.kind === "accounts" && Array.isArray(raw.accounts)) {
    const accounts: MailInboxAccount[] = [];
    for (const account of raw.accounts) {
      if (
        !isRecord(account) ||
        !identifier(account.integrationAccountId) ||
        typeof account.displayName !== "string" ||
        (account.access !== "readable" &&
          account.access !== "reconnect_required")
      )
        return null;
      accounts.push({
        integrationAccountId: account.integrationAccountId,
        displayName: account.displayName,
        access: account.access,
      });
    }
    return { kind: "accounts", accounts };
  }
  if (!Array.isArray(raw.messages)) return null;
  if (
    raw.kind === "page" &&
    (raw.nextCursor === null || typeof raw.nextCursor === "string")
  ) {
    const messages: MailInboxMessage[] = [];
    for (const item of raw.messages) {
      const message = parseMessage(item);
      if (message === null) return null;
      messages.push(message);
    }
    return { kind: "page", messages, nextCursor: raw.nextCursor };
  }
  if (raw.kind === "thread" && identifier(raw.threadId)) {
    const messages: MailInboxThreadMessage[] = [];
    for (const item of raw.messages) {
      const message = parseMessage(item);
      if (
        message === null ||
        !isRecord(item) ||
        message.threadId !== raw.threadId ||
        typeof item.body !== "string" ||
        !Array.isArray(item.attachmentNames)
      )
        return null;
      const attachmentNames: string[] = [];
      for (const name of item.attachmentNames) {
        if (typeof name !== "string") return null;
        attachmentNames.push(name);
      }
      messages.push({ ...message, body: item.body, attachmentNames });
    }
    return { kind: "thread", threadId: raw.threadId, messages };
  }
  return null;
}

function parseMessage(raw: unknown): MailInboxMessage | null {
  if (
    !isRecord(raw) ||
    !identifier(raw.messageId) ||
    !identifier(raw.threadId) ||
    typeof raw.from !== "string" ||
    typeof raw.subject !== "string" ||
    typeof raw.receivedAt !== "number" ||
    !Number.isSafeInteger(raw.receivedAt) ||
    raw.receivedAt < 0 ||
    raw.receivedAt > 8_640_000_000_000_000 ||
    typeof raw.unread !== "boolean"
  )
    return null;
  return {
    messageId: raw.messageId,
    threadId: raw.threadId,
    from: raw.from,
    subject: raw.subject,
    receivedAt: raw.receivedAt,
    unread: raw.unread,
  };
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value
  );
}
