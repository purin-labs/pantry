import React from "react";
import { assertNever } from "@purin-labs/std";
import type { MailInboxThreadMessage } from "@purin-labs/control-api";

/**
 * The fixed text that the mailbox sends when a reply waits for review. The
 * platform owns it in `email-case-processing.ts`.
 */
const MAIL_ACKNOWLEDGEMENT =
  "Thanks for your email. We've received your message and will get back to you shortly.";

/** What the conversation knows about the reply draft that waits in its thread. */
export type MailThreadDraft =
  | Readonly<{ kind: "none"; body?: never }>
  | Readonly<{ kind: "unread"; body?: never }>
  | Readonly<{ kind: "read"; body: string }>;

type Props = Readonly<{
  messages: readonly MailInboxThreadMessage[];
  /** The addresses that the mailbox sends from. */
  addresses: readonly string[];
  draft: MailThreadDraft;
}>;

/**
 * The messages of one thread, as a conversation. The automatic acknowledgement
 * is one line that opens. The Gmail draft of the reply is not a message: the
 * reply box shows it.
 */
export function MailThreadMessages(props: Props): React.ReactNode {
  return visibleThreadMessages(props).map(
    renderThreadMessage.bind(null, props.addresses),
  );
}

/**
 * A thread read carries no Gmail labels. The draft is the last message whose
 * text is the draft's text: the platform reads both from the same Gmail
 * message. Until the page knows that text, a last message from the mailbox
 * stays back, so that the draft does not show as mail first.
 */
function visibleThreadMessages(
  props: Props,
): readonly MailInboxThreadMessage[] {
  const { messages, addresses, draft } = props;
  switch (draft.kind) {
    case "none":
      return messages;
    case "unread": {
      const last = messages.at(-1);
      return last !== undefined && mayBeDraft(last, addresses)
        ? messages.slice(0, -1)
        : messages;
    }
    case "read": {
      const text = plainText(draft.body);
      let index = text === "" ? -1 : messages.length - 1;
      while (index >= 0 && plainText(messages[index]?.body ?? "") !== text)
        index -= 1;
      return index === -1
        ? messages
        : [...messages.slice(0, index), ...messages.slice(index + 1)];
    }
    default:
      return assertNever(draft);
  }
}

/** A draft that Gmail has not sent can lack a sender. */
function mayBeDraft(
  message: MailInboxThreadMessage,
  addresses: readonly string[],
): boolean {
  return (
    !isAcknowledgement(message) &&
    (message.from === "" || isFromMailbox(message, addresses))
  );
}

function isFromMailbox(
  message: MailInboxThreadMessage,
  addresses: readonly string[],
): boolean {
  const sender = senderAddress(message.from);
  for (const address of addresses)
    if (address.trim().toLowerCase() === sender) return true;
  return false;
}

/**
 * The address that the conversation answers: the sender of its newest message
 * that is not from the mailbox. Null when that message names no address.
 */
export function conversationSender(
  messages: readonly MailInboxThreadMessage[],
  addresses: readonly string[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message === undefined ||
      isAcknowledgement(message) ||
      isFromMailbox(message, addresses)
    )
      continue;
    const address = senderAddress(message.from);
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(address) ? address : null;
  }
  return null;
}

/** The address of a `From` header, with or without a display name. */
function senderAddress(from: string): string {
  const bracketed = /<([^<>]+)>\s*$/u.exec(from);
  return (bracketed?.[1] ?? from).trim().toLowerCase();
}

/** The acknowledgement has one fixed text, so the text alone identifies it. */
function isAcknowledgement(message: MailInboxThreadMessage): boolean {
  return oneLine(message.body) === MAIL_ACKNOWLEDGEMENT;
}

function plainText(text: string): string {
  return text.replaceAll("\r\n", "\n").trim();
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function renderThreadMessage(
  addresses: readonly string[],
  message: MailInboxThreadMessage,
  index: number,
): React.ReactNode {
  if (isAcknowledgement(message))
    return (
      <p key={message.messageId} className="mail-inbox-own">
        <span className="mail-inbox-own-label">
          Automatic acknowledgement sent
        </span>
        <span className="visually-hidden">, </span>
        {renderTime(message)}
      </p>
    );
  // A later reply's history repeats the messages above it in this thread.
  const historyInThread = index > 0;
  if (isFromMailbox(message, addresses))
    return (
      <article
        key={message.messageId}
        className="mail-inbox-message"
        data-own="true"
      >
        <header className="mail-message-head">
          <h3>From this mailbox</h3>
          {renderTime(message)}
        </header>
        {renderBody(message, historyInThread)}
      </article>
    );
  const sender = senderParts(message.from);
  return (
    <article key={message.messageId} className="mail-inbox-message">
      <header className="mail-message-head">
        <h3>{sender.name}</h3>
        {sender.address === null ? null : (
          <span className="mail-message-address">{sender.address}</span>
        )}
        {renderTime(message)}
      </header>
      {renderBody(message, historyInThread)}
    </article>
  );
}

/** A `From` header as Gmail shows it: the name, then the address. */
export function senderParts(
  from: string,
): Readonly<{ name: string; address: string | null }> {
  const bracketed = /^(.*?)\s*<([^<>]+)>\s*$/u.exec(from);
  if (bracketed === null)
    return { name: from.trim() || "Unknown sender", address: null };
  const name = (bracketed[1] ?? "").replaceAll('"', "").trim();
  const address = (bracketed[2] ?? "").trim();
  return name === "" ? { name: address, address: null } : { name, address };
}

function renderTime(message: MailInboxThreadMessage): React.ReactNode {
  return (
    <time dateTime={new Date(message.receivedAt).toISOString()}>
      {formatMailDate(message.receivedAt)}
    </time>
  );
}

function renderBody(
  message: MailInboxThreadMessage,
  historyInThread: boolean,
): React.ReactNode {
  const { own, quoted } = splitQuotedHistory(message.body);
  return (
    <>
      <div className="mail-inbox-body">
        {own === "" ? "This message has no readable text." : linkedText(own)}
      </div>
      {quoted === null || historyInThread ? null : (
        <div className="mail-inbox-quoted">
          <div className="mail-inbox-body">{linkedText(quoted)}</div>
        </div>
      )}
      {message.attachmentNames.length > 0 ? (
        <p className="mail-inbox-note">
          Attachments: {message.attachmentNames.join(", ")}. Open Gmail to
          download.
        </p>
      ) : null}
    </>
  );
}

/**
 * A web address in mail text, bare or as Gmail writes a link in plain text:
 * `Terms of Service<https://…>`.
 */
const WEB_ADDRESS = /<?(https?:\/\/[^\s<>"]+)>?/gu;
/** Punctuation that ends a sentence, not the address. */
const ADDRESS_TAIL = /[.,;:!?)\]]+$/u;

/**
 * The text with each web address as a short link: its host, with the whole
 * address as the link's title. A long tracking address no longer fills the
 * message.
 */
function linkedText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const start = match.index;
    const raw = match[1] ?? "";
    const tail = match[0].startsWith("<")
      ? ""
      : (ADDRESS_TAIL.exec(raw)?.[0] ?? "");
    const href = raw.slice(0, raw.length - tail.length);
    let host: string;
    try {
      host = new URL(href).host.replace(/^www\./u, "");
    } catch {
      continue;
    }
    const before = text.slice(at, start);
    parts.push(before);
    if (before !== "" && !/\s$/u.test(before)) parts.push(" ");
    parts.push(
      <a
        key={start}
        className="mail-body-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={href}
      >
        {host}
      </a>,
    );
    parts.push(tail);
    at = start + match[0].length;
  }
  if (at === 0) return text;
  parts.push(text.slice(at));
  return parts;
}

/** Outlook's rule above the earlier mail, or its "Original Message" line. */
const HISTORY_RULE = /^\s*_{8,}\s*$/u;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/iu;
const HEADER_FROM = /^\s*\*?From:\*?\s/iu;
const HEADER_NEXT = /^\s*\*?(?:Sent|Date|To):\*?\s/iu;
/** Gmail and Apple Mail: "On …, Name <address> wrote:", maybe on two lines. */
const ATTRIBUTION_START = /^\s*On\s/u;
const ATTRIBUTION_END = /\bwrote:\s*$/u;
/** Gmail in other languages ends its line with the address and a colon. */
const ADDRESS_ATTRIBUTION = /<[^\s<>@]+@[^\s<>]+>\s*[:：]\s*$/u;

/**
 * A reply carries the earlier mail below it. The thread already shows that
 * mail, so a later reply leaves the history out. With no text before the
 * history, all of the text is the message.
 */
function splitQuotedHistory(
  body: string,
): Readonly<{ own: string; quoted: string | null }> {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!startsHistory(lines, index)) continue;
    const own = lines.slice(0, index).join("\n").trimEnd();
    if (own.trim() === "") break;
    // The fold draws its own edge, so Outlook's rule goes.
    const start = HISTORY_RULE.test(lines[index] ?? "") ? index + 1 : index;
    return { own, quoted: lines.slice(start).join("\n").trim() };
  }
  return { own: body, quoted: null };
}

function startsHistory(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  if (ORIGINAL_MESSAGE.test(line) || ADDRESS_ATTRIBUTION.test(line))
    return true;
  if (HISTORY_RULE.test(line)) {
    const header = lines.slice(index + 1).find(isNotBlank);
    return header !== undefined && HEADER_FROM.test(header);
  }
  if (HEADER_FROM.test(line)) return HEADER_NEXT.test(next);
  if (ATTRIBUTION_START.test(line))
    return ATTRIBUTION_END.test(line) || ATTRIBUTION_END.test(next);
  // A block of "> " lines that ends the mail.
  return line.startsWith(">") && lines.slice(index).every(isQuoteOrBlank);
}

function isNotBlank(line: string): boolean {
  return line.trim() !== "";
}

function isQuoteOrBlank(line: string): boolean {
  return line.trim() === "" || line.startsWith(">");
}

export function formatMailDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

/** As Gmail: the time for today, the day for this year, else the date. */
export function formatListDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
      date,
    );
  return new Intl.DateTimeFormat(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { dateStyle: "short" },
  ).format(date);
}
