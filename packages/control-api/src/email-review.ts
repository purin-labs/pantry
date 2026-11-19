import { hasExactKeys, isNonBlankString, isRecord } from "@purin-labs/std";

/** The longest sender name that a queue item carries. */
export const EMAIL_REPLY_SENDER_NAME_MAX = 200;
/** The longest subject that a queue item carries. */
export const EMAIL_REPLY_SUBJECT_MAX = 500;

/**
 * The mail that a waiting reply draft answers, as the email review queue
 * names it: the newest message of the thread that the mailbox did not write.
 * The queue reads it from Gmail for each request and stores none of it.
 */
export type EmailReplyHeadline = Readonly<{
  /** The display name of the `From` header, or its address without one. */
  senderName: string;
  /** Empty when the message has no subject. */
  subject: string;
  receivedAt: number;
}>;

/** `headline` of a `gmail_reply` item of `GET …/email-reviews`. */
export type EmailReplyHeadlineWire = Readonly<{
  sender_name: string;
  subject: string;
  received_at: number;
}>;

export function emailReplyHeadlineWire(
  headline: EmailReplyHeadline,
): EmailReplyHeadlineWire {
  return {
    sender_name: headline.senderName,
    subject: headline.subject,
    received_at: headline.receivedAt,
  };
}

/** Null when the value is not a headline. */
export function parseEmailReplyHeadline(
  raw: unknown,
): EmailReplyHeadline | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["sender_name", "subject", "received_at"]) ||
    !isNonBlankString(raw.sender_name) ||
    raw.sender_name.length > EMAIL_REPLY_SENDER_NAME_MAX ||
    typeof raw.subject !== "string" ||
    raw.subject.length > EMAIL_REPLY_SUBJECT_MAX ||
    typeof raw.received_at !== "number" ||
    !Number.isSafeInteger(raw.received_at) ||
    raw.received_at < 0
  )
    return null;
  return {
    senderName: raw.sender_name,
    subject: raw.subject,
    receivedAt: raw.received_at,
  };
}
