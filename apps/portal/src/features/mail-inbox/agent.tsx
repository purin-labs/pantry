import React from "react";
import { assertNever } from "@seams/std";
import type {
  InboxUnansweredThread,
  InboxWhatsAppConversation,
  MailInboxMessage,
} from "@seams/control-api";
import { Check, MessageCircle } from "lucide-react";
import { formatListDate, formatMailDate, senderParts } from "./thread";
import { emailReplyIsOpenable, emailReplyLifecycleLabel } from "../../pages/agent-mailbox";
import type { EmailReplyQueueItem } from "@seams/control-api/portal/agent-mailbox";
import { readMailAgent, resumeMailAgent } from "./api";
import type {
  MailAgentPause,
  MailAgentState,
} from "@seams/control-api/portal/mail-agent";

type StripProps = Readonly<{
  organisationId: string;
  accountId: string;
  /** The mailbox's settings page in the Inbox. */
  settingsHref: string;
  canManage: boolean;
  /** Each read reports the state. The Inbox marks a working agent itself. */
  onChange: (agent: MailAgentState | null) => void;
  /** The line left because the agent works again. */
  onResumed: () => void;
  /** Opens the sheet that turns an agent that is off on. */
  onTurnOn: () => void;
}>;
type StripState = Readonly<{
  agent: MailAgentState | null;
  resume: "idle" | "running" | "failed";
}>;

/**
 * One sentence on why the mailbox agent does not work, with one action. An
 * agent that works shows no line here.
 */
export class MailAgentStrip extends React.Component<StripProps, StripState> {
  state: StripState = { agent: null, resume: "idle" };
  private sentence = React.createRef<HTMLParagraphElement>();
  private read = 0;
  private disposed = false;

  componentDidMount(): void {
    this.disposed = false;
    void this.refresh();
  }
  componentWillUnmount(): void {
    this.disposed = true;
  }

  /** A state that cannot be read shows nothing. The Inbox works without it. */
  refresh = async (): Promise<void> => {
    const read = ++this.read;
    let agent: MailAgentState | null;
    try {
      agent = await readMailAgent(
        this.props.organisationId,
        this.props.accountId,
      );
    } catch {
      agent = null;
    }
    if (this.disposed || read !== this.read) return;
    this.setState({ agent, resume: "idle" });
    this.props.onChange(agent);
  };

  private resume = async (): Promise<void> => {
    this.setState({ resume: "running" });
    let resume: StripState["resume"] = "idle";
    try {
      await resumeMailAgent(this.props.organisationId, this.props.accountId);
    } catch {
      resume = "failed";
    }
    // A failed resume can mean that the pause ended in another way.
    await this.refresh();
    if (!this.disposed) this.setState({ resume }, this.focusState);
  };

  // The button leaves with the pause, and the line leaves with it.
  private focusState = (): void => {
    if (this.sentence.current === null) this.props.onResumed();
    else this.sentence.current.focus();
  };

  render(): React.ReactNode {
    const { agent, resume } = this.state;
    if (agent === null || agent.kind === "on") return null;
    // A resume cannot renew Gmail access. Mailbox settings can. An agent that
    // is off keeps its settings in the mailbox menu, so its line stays short.
    const needsSettings =
      agent.kind === "paused" && agent.reason.kind === "authorization_expired";
    return (
      <div
        className="mail-agent-strip"
        role="group"
        aria-label="Mailbox agent"
        data-agent={agent.kind}
      >
        <p ref={this.sentence} tabIndex={-1}>
          {agent.kind === "off"
            ? "Agent off"
            : `Paused: ${mailAgentPauseReason(agent.reason)}.`}
        </p>
        {agent.kind === "off" && this.props.canManage ? (
          <button type="button" onClick={this.props.onTurnOn}>
            Turn on
          </button>
        ) : null}
        {agent.kind === "paused" && !needsSettings && this.props.canManage ? (
          <button
            type="button"
            onClick={this.resume}
            disabled={resume === "running"}
          >
            Resume processing
          </button>
        ) : null}
        {/* A paused mailbox can also need new limits, as a spent budget. */}
        {agent.kind === "paused" ? (
          <a href={this.props.settingsHref}>Mailbox settings</a>
        ) : null}
        {agent.kind === "paused" && resume === "failed" ? (
          <p role="alert">Processing did not resume. Try again.</p>
        ) : null}
      </div>
    );
  }
}

function mailAgentPauseReason(reason: MailAgentPause): string {
  switch (reason.kind) {
    case "active_case_limit":
      return reason.observed === 1
        ? `1 Case is open and the limit is ${reason.limit}`
        : `${reason.observed} Cases are open and the limit is ${reason.limit}`;
    case "authorization_expired":
      return "Gmail authorization expired";
    case "policy_limit":
      return "the mailbox reached a policy limit";
    default:
      return assertNever(reason);
  }
}

/**
 * One reply draft for each thread of one mailbox that waits for a decision,
 * newest first. A thread with more drafts shows its newest one.
 */
export function waitingMailDrafts(
  replies: readonly EmailReplyQueueItem[],
  accountId: string | null,
): readonly EmailReplyQueueItem[] {
  const waiting: EmailReplyQueueItem[] = [];
  for (const reply of replies)
    if (
      reply.integrationAccountId === accountId &&
      emailReplyIsOpenable(reply.lifecycleKind)
    )
      waiting.push(reply);
  waiting.sort(newestDraftFirst);
  const drafts: EmailReplyQueueItem[] = [];
  for (const draft of waiting)
    if (!mailThreadHasDraft(drafts, draft.gmailThreadId)) drafts.push(draft);
  return drafts;
}

function newestDraftFirst(
  left: EmailReplyQueueItem,
  right: EmailReplyQueueItem,
): number {
  return right.updatedAt - left.updatedAt;
}

export function mailThreadHasDraft(
  drafts: readonly EmailReplyQueueItem[],
  threadId: string,
): boolean {
  for (const draft of drafts) if (draft.gmailThreadId === threadId) return true;
  return false;
}

/** What a row and a case say about one reply draft. */
export type MailDraftItem = Readonly<{
  draft: EmailReplyQueueItem;
  /** The sender's name, or "Reply draft" while the mail is unknown. */
  sender: string;
  /** Empty while the mail is unknown. */
  subject: string;
  /** When the mail arrived, else when the agent wrote the draft. */
  since: number;
}>;

/**
 * The queue names the mail that a waiting draft answers. A thread on the
 * loaded page names itself as well.
 */
export function mailDraftItem(
  messages: readonly MailInboxMessage[],
  draft: EmailReplyQueueItem,
): MailDraftItem {
  if (draft.headline !== null)
    return {
      draft,
      sender: draft.headline.senderName,
      subject: draft.headline.subject || "No subject",
      since: draft.headline.receivedAt,
    };
  const message = threadMessage(messages, draft.gmailThreadId);
  if (message !== null)
    return {
      draft,
      sender: senderParts(message.from).name,
      subject: message.subject || "No subject",
      since: message.receivedAt,
    };
  return { draft, sender: "Reply draft", subject: "", since: draft.createdAt };
}

/** The replies of one mailbox that waited and were decided, newest first. */
export function handledMailDrafts(
  replies: readonly EmailReplyQueueItem[],
  accountId: string | null,
): readonly EmailReplyQueueItem[] {
  const handled: EmailReplyQueueItem[] = [];
  for (const reply of replies)
    if (
      reply.integrationAccountId === accountId &&
      !emailReplyIsOpenable(reply.lifecycleKind)
    )
      handled.push(reply);
  return handled.sort(newestDraftFirst);
}

type NeedsYouProps = Readonly<{
  items: readonly MailDraftItem[];
  /** WhatsApp conversations that need a person. */
  whatsapp?: readonly InboxWhatsAppConversation[];
  /** Mail of a mailbox with no agent, with no reply yet. */
  unanswered?: readonly InboxUnansweredThread[];
  openThreadId: string | null;
  openCaseId?: string | null;
  onOpen: (threadId: string) => void;
  onOpenWhatsApp?: (caseId: string) => void;
}>;

/** The threads whose draft reply waits for the person, as one quiet list. */
export function MailNeedsYouList(props: NeedsYouProps): React.ReactNode {
  const whatsapp = props.whatsapp ?? [];
  const unanswered = props.unanswered ?? [];
  if (
    props.items.length === 0 &&
    whatsapp.length === 0 &&
    unanswered.length === 0
  )
    return (
      <div className="mail-case-empty">
        <Check size={18} aria-hidden="true" />
        <p>Nothing waits for you.</p>
      </div>
    );
  const now = Date.now();
  const rows: { readonly since: number; readonly row: React.ReactNode }[] = [];
  for (const item of props.items)
    rows.push({
      since: item.since,
      row: renderNeedsYouRow(props, now, item),
    });
  for (const thread of unanswered)
    rows.push({
      since: thread.receivedAt,
      row: (
        <li key={thread.threadId}>
          <button
            type="button"
            className="mail-case-row"
            aria-current={
              props.openThreadId === thread.threadId ? "true" : undefined
            }
            data-thread-id={thread.threadId}
            onClick={props.onOpen.bind(null, thread.threadId)}
          >
            <MailAvatar name={thread.senderName} />
            <span className="mail-case-row-main">
              <span className="mail-case-row-name">{thread.senderName}</span>
              <span className="mail-case-row-line">
                {thread.subject || "No subject"}
              </span>
            </span>
            <span className="mail-case-row-side">
              <time
                className="mail-case-row-age"
                dateTime={new Date(thread.receivedAt).toISOString()}
                title={formatMailDate(thread.receivedAt)}
              >
                {formatWaitedShort(now - thread.receivedAt)}
              </time>
              <span className="mail-case-row-kind">No reply yet</span>
            </span>
          </button>
        </li>
      ),
    });
  for (const conversation of whatsapp)
    rows.push({
      since: conversation.waitingSince,
      row: (
        <WhatsAppRow
          key={conversation.caseId}
          conversation={conversation}
          now={now}
          open={props.openCaseId === conversation.caseId}
          onOpen={props.onOpenWhatsApp}
        />
      ),
    });
  rows.sort(longestWaitFirst);
  return (
    <ul className="mail-case-list" aria-label="Waiting for you">
      {rows.map(rowNode)}
    </ul>
  );
}

function longestWaitFirst(
  left: Readonly<{ since: number }>,
  right: Readonly<{ since: number }>,
): number {
  return left.since - right.since;
}

function rowNode(entry: Readonly<{ row: React.ReactNode }>): React.ReactNode {
  return entry.row;
}

/** The WhatsApp conversations of one section, with no email beside them. */
export function InboxWhatsAppList(
  props: Readonly<{
    label: string;
    conversations: readonly InboxWhatsAppConversation[];
    openCaseId: string | null;
    onOpen: (caseId: string) => void;
  }>,
): React.ReactNode {
  if (props.conversations.length === 0) return null;
  const now = Date.now();
  return (
    <ul className="mail-case-list" aria-label={props.label}>
      {props.conversations.map((conversation) => (
        <WhatsAppRow
          key={conversation.caseId}
          conversation={conversation}
          now={now}
          open={props.openCaseId === conversation.caseId}
          onOpen={props.onOpen}
        />
      ))}
    </ul>
  );
}

function WhatsAppRow(
  props: Readonly<{
    conversation: InboxWhatsAppConversation;
    now: number;
    open: boolean;
    onOpen: ((caseId: string) => void) | undefined;
  }>,
): React.ReactNode {
  const { conversation } = props;
  return (
    <li>
      <button
        type="button"
        className="mail-case-row"
        aria-current={props.open ? "true" : undefined}
        data-case-id={conversation.caseId}
        onClick={props.onOpen?.bind(null, conversation.caseId)}
      >
        <span
          className="mail-avatar"
          data-channel="whatsapp"
          aria-hidden="true"
        >
          <MessageCircle size={16} />
        </span>
        <span className="mail-case-row-main">
          <span className="mail-case-row-name">
            {conversation.customerWaId}
          </span>
          <span className="mail-case-row-line">
            {conversation.preview ?? "No text. Seams deleted it."}
          </span>
        </span>
        <span className="mail-case-row-side">
          <time
            className="mail-case-row-age"
            dateTime={new Date(conversation.waitingSince).toISOString()}
            title={formatMailDate(conversation.waitingSince)}
          >
            {formatWaitedShort(props.now - conversation.waitingSince)}
          </time>
          <span className="mail-case-row-kind">
            WhatsApp · {whatsappStateLabel(conversation.state)}
          </span>
        </span>
      </button>
    </li>
  );
}

function whatsappStateLabel(state: InboxWhatsAppConversation["state"]): string {
  switch (state) {
    case "reply_waiting":
      return "Reply";
    case "handoff_requested":
      return "Asks for you";
    case "no_reply_yet":
      return "No reply yet";
    case "send_uncertain":
      return "Check send";
    case "agent_handled":
      return "Agent";
    case "person_replied":
      return "You replied";
    case "closed":
      return "Closed";
    default:
      return assertNever(state);
  }
}

function renderNeedsYouRow(
  props: NeedsYouProps,
  now: number,
  item: MailDraftItem,
): React.ReactNode {
  const threadId = item.draft.gmailThreadId;
  return (
    <li key={threadId}>
      <button
        type="button"
        className="mail-case-row"
        aria-current={props.openThreadId === threadId ? "true" : undefined}
        data-thread-id={threadId}
        onClick={props.onOpen.bind(null, threadId)}
      >
        <MailAvatar name={item.sender} />
        <span className="mail-case-row-main">
          <span className="mail-case-row-name">{item.sender}</span>
          {item.subject === "" ? null : (
            <span className="mail-case-row-line">{item.subject}</span>
          )}
        </span>
        <span className="mail-case-row-side">
          <time
            className="mail-case-row-age"
            dateTime={new Date(item.since).toISOString()}
            title={formatMailDate(item.since)}
          >
            {formatWaitedShort(now - item.since)}
          </time>
          <span className="mail-case-row-kind">Reply</span>
        </span>
      </button>
    </li>
  );
}

type OtherMailProps = Readonly<{
  messages: readonly MailInboxMessage[];
  openThreadId: string | null;
  onOpen: (threadId: string) => void;
}>;

/**
 * The rest of the mailbox's newest mail: mail that waits for nobody. Unread
 * mail shows its sender in bold.
 */
export function MailOtherList(props: OtherMailProps): React.ReactNode {
  if (props.messages.length === 0)
    return (
      <div className="mail-case-empty">
        <p>No other mail.</p>
      </div>
    );
  return (
    <ul className="mail-case-list" data-list="other" aria-label="Other mail">
      {props.messages.map((message) => {
        const sender = senderParts(message.from).name;
        return (
          <li key={message.threadId}>
            <button
              type="button"
              className="mail-case-row"
              aria-current={
                props.openThreadId === message.threadId ? "true" : undefined
              }
              data-thread-id={message.threadId}
              data-unread={message.unread ? "true" : undefined}
              onClick={props.onOpen.bind(null, message.threadId)}
            >
              <MailAvatar name={sender} />
              <span className="mail-case-row-main">
                <span className="mail-case-row-name">
                  {sender}
                  {message.unread ? (
                    <span className="visually-hidden">, unread</span>
                  ) : null}
                </span>
                <span className="mail-case-row-line">
                  {message.subject || "No subject"}
                </span>
              </span>
              <span className="mail-case-row-side">
                <time
                  className="mail-case-row-age"
                  dateTime={new Date(message.receivedAt).toISOString()}
                  title={formatMailDate(message.receivedAt)}
                >
                  {formatListDate(message.receivedAt)}
                </time>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type HandledProps = Readonly<{
  replies: readonly EmailReplyQueueItem[];
  /** The names that the page knows for each decided draft, by proposal. */
  names: ReadonlyMap<string, string>;
  /** The loaded page of mail. A thread on it names its sender. */
  messages: readonly MailInboxMessage[];
  openThreadId: string | null;
  onOpen: (threadId: string) => void;
}>;

/** The reply drafts that were decided, with what became of each. */
export function MailHandledList(props: HandledProps): React.ReactNode {
  if (props.replies.length === 0)
    return (
      <div className="mail-case-empty">
        <p>No reply drafts were decided yet.</p>
      </div>
    );
  return (
    <ul className="mail-case-list" aria-label="Email replies that are done">
      {props.replies.map(renderHandledRow.bind(null, props))}
    </ul>
  );
}

function renderHandledRow(
  props: HandledProps,
  reply: EmailReplyQueueItem,
): React.ReactNode {
  return (
    <li key={reply.proposalId}>
      <button
        type="button"
        className="mail-case-row mail-handled-row"
        aria-current={
          props.openThreadId === reply.gmailThreadId ? "true" : undefined
        }
        onClick={props.onOpen.bind(null, reply.gmailThreadId)}
      >
        <time
          className="mail-handled-time"
          dateTime={new Date(reply.updatedAt).toISOString()}
        >
          {formatListDate(reply.updatedAt)}
        </time>
        <span className="mail-case-row-main">
          <span className="mail-case-row-line">
            <strong>{handledSender(props, reply)}</strong>
            {" · "}
            {emailReplyLifecycleLabel(reply.lifecycleKind)}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The queue names only the mail of drafts that wait. A draft decided on this
 * page keeps the name it had; a thread on the loaded page names itself.
 */
function handledSender(
  props: HandledProps,
  reply: EmailReplyQueueItem,
): string {
  const named = props.names.get(reply.proposalId);
  if (named !== undefined) return named;
  const message = threadMessage(props.messages, reply.gmailThreadId);
  return message === null ? "Reply draft" : senderParts(message.from).name;
}

/** Initials on a quiet tone. The name next to it says who it is. */
function MailAvatar(
  props: Readonly<{ name: string; size?: "small" }>,
): React.ReactNode {
  return (
    <span
      className="mail-avatar"
      data-tone={avatarTone(props.name)}
      data-size={props.size}
      aria-hidden="true"
    >
      {initials(props.name)}
    </span>
  );
}

function initials(name: string): string {
  let letters = "";
  for (const word of name.split(/[\s·,.@_-]+/u))
    if (/^[\p{L}\p{N}]/u.test(word) && letters.length < 2)
      letters += [...word][0]?.toLocaleUpperCase() ?? "";
  return letters || "?";
}

const AVATAR_TONES = ["accent", "ok", "warn"] as const;

function avatarTone(name: string): (typeof AVATAR_TONES)[number] {
  let sum = 0;
  for (const character of name) sum += character.codePointAt(0) ?? 0;
  return AVATAR_TONES[sum % AVATAR_TONES.length] ?? "accent";
}

/** How long something waited, for a row: "12 min", "3 h", "2 days". */
function formatWaitedShort(waited: number): string {
  const minutes = Math.max(0, Math.floor(waited / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** How long something waited, in a sentence: "12 minutes", "2 days". */
export function formatWaited(waited: number): string {
  const minutes = Math.max(0, Math.floor(waited / 60_000));
  if (minutes < 60) return minutes <= 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

function threadMessage(
  messages: readonly MailInboxMessage[],
  threadId: string,
): MailInboxMessage | null {
  for (const message of messages)
    if (message.threadId === threadId) return message;
  return null;
}
