import { MailAssistantPanel } from "./assistant";
import { MailConsoleDock } from "./console-dock";
import { MailCase, type MailThread } from "./case";
import type { MailDraftDecision } from "./conversation";
import { formatListDate, formatMailDate, senderParts } from "./thread";
import React from "react";
import { toast } from "sonner";
import { assertNever } from "@purin-labs/std";
import { forgetWithControlReads } from "@purin-labs/control/portal/control-client";
import { mailRuleLabel } from "./rule-label";
import type {
  MailInboxAccount,
  MailInboxMessage,
  MailInboxResult,
  MailInboxThreadMessage,
  MailClassifiedFilter,
  MailDecision,
} from "@purin-labs/control-api";
import { MailOrganizationPanel } from "./organization";
import {
  mailProcessingView,
  processingNotice,
  type MailProcessingState,
} from "./processing-state";
import { MailProcessingMenu } from "./processing-menu";
import { formatMailCheckTime, MailStatusMenu } from "./status-menu";
import { MailboxTurnOnSheet } from "./turn-on-sheet";
import type { MailOrganizationView } from "@purin-labs/control-api";
import {
  checkMailAgent,
  readInbox,
  readMailInbox,
  mailOrganizationRequest,
  MailReconnectRequired,
  type InboxWhatsAppSource,
  type MailboxCheck,
} from "./api";
import type { MailAgentState } from "@purin-labs/control-api/portal/mail-agent";
import { InboxAgentSheet } from "./agent-sheet";
import { WhatsAppConversation } from "./whatsapp-conversation";
import { PermissionRequiredPrompt } from "@purin-labs/area-organisation/ui/features/access/permission-required-prompt";
import { Select } from "@purin-labs/ui/select";
import {
  formatWaited,
  handledMailDrafts,
  InboxWhatsAppList,
  MailAgentStrip,
  MailHandledList,
  MailNeedsYouList,
  MailOtherList,
  mailDraftItem,
  mailThreadHasDraft,
  waitingMailDrafts,
  type MailDraftItem,
} from "./agent";
import { emailReplyIsOpenable } from "../../pages/agent-mailbox";
import type { EmailReplyQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import {
  whatsappConversationTab,
  type InboxTab,
  type InboxUnansweredThread,
  type InboxWhatsAppConversation,
} from "@purin-labs/control-api";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ExternalLink,
  LoaderCircle,
  Mails,
  OctagonAlert,
  Search,
  X,
} from "lucide-react";
import "./styles.css";

type Load<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; value: T }>;
type Page = Readonly<{
  messages: readonly MailInboxMessage[];
  nextCursor: string | null;
}>;
type Thread = MailThread;
type InboxFilter =
  Readonly<{ kind: "all"; ruleId?: never }> | MailClassifiedFilter;
/**
 * The Inbox is one list in sections: what waits for the person, what the
 * agent answered and the other mail. Done, All mail and Spam are views.
 */
type InboxScope = "inbox" | "done" | "all" | "spam";
type InboxChannel = "all" | "email" | "whatsapp";
const MAIL_CHANNELS = [
  { value: "all", label: "All channels" },
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
];
const MAIL_CORRECTION_OUTCOMES = [
  { value: "matched", label: "Matches" },
  { value: "not_matched", label: "Does not match" },
  { value: "needs_review", label: "Needs review" },
];

function renderMailSelectItem(
  item: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}
/** One conversation that the pane can step to. */
type PaneRow =
  | Readonly<{ kind: "thread"; threadId: string }>
  | Readonly<{ kind: "case"; caseId: string }>;
type InboxState = Readonly<{
  accounts: Load<readonly MailInboxAccount[]>;
  accountId: string | null;
  searchInput: string;
  query: string;
  page: Load<Page>;
  thread: Thread;
  filter: InboxFilter;
  decision: Readonly<{ kind: "closed" }> | Load<MailDecision>;
  panel: "closed" | "jev";
  processing: MailProcessingState;
  /** The email proposals of the organisation. Null until the first read. */
  replies: readonly EmailReplyQueueItem[] | null;
  scope: InboxScope;
  /** Gmail's Spam, read when the person opens it. No agent reads it. */
  spam: Load<Page> | null;
  agent: MailAgentState | null;
  /** The sheet that turns the mailbox's agent on. */
  turnOn: boolean;
  /** When the agent reads the new mail that a check found, if one did. */
  mailCheckAt: number | null;
  /** The drafts that the person decided here, until the queue shows it. */
  decided: ReadonlySet<string>;
  /** The sender of each draft that the page named, by proposal. */
  names: ReadonlyMap<string, string>;
  /** Mail of mailboxes with no agent, with no reply yet. */
  unanswered: readonly InboxUnansweredThread[];
  /** The email source failed, and the page names that. */
  emailFailed: boolean;
  whatsapp: InboxWhatsAppSource;
  /** The open WhatsApp conversation. An open email thread closes for it. */
  whatsappCaseId: string | null;
  channel: InboxChannel;
  /** The prompt that asks for a grant on a WhatsApp number. */
  whatsappPrompt: boolean;
  agentSheet: boolean;
  /** The mailbox whose settings page shows in place of the list. */
  settings: string | null;
}>;
type InboxProps = Readonly<{
  organisationId: string;
  integrationsPath: string;
  /**
   * One mailbox's settings page, with a back link to the Inbox. The Portal
   * gives it, so that the Integrations code stays out of the Inbox's code.
   */
  mailboxSettings: (accountId: string, backHref: string) => React.ReactNode;
  canManage: boolean;
  supplierHref: (supplierId: string) => string;
  orderHref: (orderId: string) => string;
  /** The Brain page with one Memory open. */
  memoryHref: (memoryId: string) => string;
  /** The Suppliers page, for a sender that no supplier exists for yet. */
  suppliersPath: string;
}>;
/** The conversation that the address of the page names. */
type Selection =
  | Readonly<{ kind: "proposal"; id: string }>
  | Readonly<{ kind: "thread"; id: string }>
  | Readonly<{ kind: "case"; id: string }>;

/**
 * The mailbox list that this tab last read for each Organisation. It names
 * mailboxes only and holds no message. The page shows it while it reads the
 * list again, so the first mailbox does not wait for that read.
 */
const LAST_ACCOUNTS = new Map<string, readonly MailInboxAccount[]>();
forgetWithControlReads(LAST_ACCOUNTS.clear.bind(LAST_ACCOUNTS));

/**
 * The Inbox: one list of email and WhatsApp in sections. What waits for the
 * person comes first, the longest wait at the top. A row opens its
 * conversation in the pane beside the list. After a reply, the next one
 * opens. Done, All mail and Spam are views.
 */
export class MailInboxRoute extends React.Component<InboxProps, InboxState> {
  state: InboxState = {
    accounts: { kind: "loading" },
    accountId: null,
    searchInput: "",
    query: "",
    page: { kind: "loading" },
    thread: { kind: "closed" },
    filter: { kind: "all" },
    decision: { kind: "closed" },
    panel: "closed",
    processing: { kind: "loading" },
    replies: null,
    scope: "inbox",
    spam: null,
    agent: null,
    turnOn: false,
    mailCheckAt: null,
    decided: new Set(),
    names: new Map(),
    unanswered: [],
    emailFailed: false,
    whatsapp: { kind: "none" },
    whatsappCaseId: null,
    channel: "all",
    whatsappPrompt: false,
    agentSheet: false,
    settings: readSettings(),
  };
  private request: AbortController | null = null;
  private accountsRequest: AbortController | null = null;
  private repliesRequest: AbortController | null = null;
  private spamRequest: AbortController | null = null;
  private agentStrip = React.createRef<MailAgentStrip>();
  private statusTrigger = React.createRef<HTMLButtonElement>();
  private threadRequest: AbortController | null = null;
  private checkTimers: number[] = [];
  private organizationPanel = React.createRef<MailOrganizationPanel>();
  private correctionRequest: AbortController | null = null;
  private decisionRequest: AbortController | null = null;
  private root = React.createRef<HTMLElement>();
  private heading = React.createRef<HTMLHeadingElement>();
  private listHeading = React.createRef<HTMLHeadingElement>();
  private viewHeading = React.createRef<HTMLHeadingElement>();
  private jevHeading = React.createRef<HTMLHeadingElement>();
  /** The control that opened JEV takes focus again when JEV closes. */
  private jevOpener: HTMLElement | null = null;
  /** The conversation that the page's address named when it loaded. */
  private selection: Selection | null = readSelection();
  /** The drafts in the order that the list last showed them. */
  private shownDrafts: readonly string[] = [];
  /**
   * The list's order when the open case opened. A decided draft can leave
   * the queue before its decision returns, and the next draft is the one
   * after it in this order.
   */
  private openOrder: readonly string[] = [];

  componentDidMount(): void {
    void this.loadAccounts();
    window.addEventListener("popstate", this.addressChanged);
  }
  componentWillUnmount(): void {
    window.removeEventListener("popstate", this.addressChanged);
    this.request?.abort();
    this.accountsRequest?.abort();
    this.threadRequest?.abort();
    this.correctionRequest?.abort();
    this.decisionRequest?.abort();
    this.repliesRequest?.abort();
    this.spamRequest?.abort();
    this.clearMailCheck();
  }

  private loadAccounts = async (): Promise<void> => {
    this.request?.abort();
    this.accountsRequest?.abort();
    const request = new AbortController();
    this.accountsRequest = request;
    const organisationId = this.props.organisationId;
    const last = LAST_ACCOUNTS.get(organisationId);
    if (last === undefined) this.setState({ accounts: { kind: "loading" } });
    else this.showAccounts(last, null);
    try {
      const result = await readMailInbox(organisationId, null, request.signal);
      if (request.signal.aborted) return;
      if (result.kind !== "accounts")
        throw new Error("Mailbox list unavailable.");
      LAST_ACCOUNTS.set(organisationId, result.accounts);
      this.showAccounts(result.accounts, last ?? null);
    } catch (error) {
      if (request.signal.aborted) return;
      // Nothing of an earlier list stays when the list cannot be read.
      LAST_ACCOUNTS.delete(organisationId);
      this.request?.abort();
      this.setState({
        accounts: { kind: "failed", message: messageForError(error) },
        accountId: null,
        page: { kind: "loading" },
        thread: { kind: "closed" },
        decision: { kind: "closed" },
      });
    }
  };

  /**
   * Shows the mailbox list. The first mailbox is read, with the reply queue,
   * unless `shown` is the earlier list and the open mailbox is still listed.
   */
  private showAccounts(
    accounts: readonly MailInboxAccount[],
    shown: readonly MailInboxAccount[] | null,
  ): void {
    const open = shown === null ? null : this.state.accountId;
    const kept =
      open !== null &&
      accounts.some((account) => account.integrationAccountId === open);
    const accountId = kept ? open : (accounts[0]?.integrationAccountId ?? null);
    this.setState(
      { accounts: { kind: "ready", value: accounts }, accountId },
      kept ? undefined : this.openSelectedThread,
    );
    if (kept) return;
    this.closeSpam();
    void this.loadReplies();
    if (accountId === null) {
      this.request?.abort();
      return;
    }
    void this.loadPage(accountId, "", null, { kind: "all" });
  }

  /** A thread that the page's address names opens with the first mailbox. */
  private openSelectedThread = (): void => {
    const selection = this.selection;
    if (selection?.kind !== "thread") return;
    this.selection = null;
    void this.openThread(selection.id);
  };

  // The queue names proposals, threads and the mail that a waiting draft
  // answers. A queue that cannot be read lists nothing; a conversation still
  // shows its own draft.
  private loadReplies = async (): Promise<void> => {
    this.repliesRequest?.abort();
    const request = new AbortController();
    this.repliesRequest = request;
    let replies: readonly EmailReplyQueueItem[] | null;
    let whatsapp: InboxWhatsAppSource;
    let unanswered: readonly InboxUnansweredThread[] = [];
    try {
      const read = await readInbox(this.props.organisationId, request.signal);
      replies = read.replies;
      unanswered = read.unanswered;
      whatsapp = read.whatsapp;
    } catch {
      replies = null;
      whatsapp = { kind: "failed" };
    }
    if (request.signal.aborted) return;
    const names = new Map(this.state.names);
    for (const reply of replies ?? [])
      if (reply.headline !== null)
        names.set(reply.proposalId, reply.headline.senderName);
    this.setState(
      {
        replies: replies ?? [],
        unanswered,
        emailFailed: replies === null,
        whatsapp,
        names,
      },
      this.openSelectedProposal,
    );
  };

  /** A draft that the page's address names opens when the queue lists it. */
  private openSelectedProposal = (): void => {
    const selection = this.selection;
    if (selection?.kind === "case") {
      this.selection = null;
      if (this.whatsappConversations().some(hasCaseId.bind(null, selection.id)))
        this.openWhatsApp(selection.id);
      return;
    }
    if (selection?.kind !== "proposal") return;
    this.selection = null;
    for (const reply of this.state.replies ?? [])
      if (
        reply.proposalId === selection.id &&
        reply.integrationAccountId === this.state.accountId
      ) {
        void this.openThread(reply.gmailThreadId);
        return;
      }
  };

  private refreshAgent = (): void => {
    void this.agentStrip.current?.refresh();
    void this.loadReplies();
  };
  private agentChanged = (agent: MailAgentState | null): void => {
    this.setState({ agent });
  };
  // The strip reports a resume from its own update. The status control
  // shows the new state in that update, so focus waits for one more update.
  private agentResumed = (): void => {
    this.forceUpdate(this.focusStatus);
  };
  private focusStatus = (): void => {
    this.statusTrigger.current?.focus();
  };
  private openTurnOn = (): void => {
    this.setState({ turnOn: true });
  };
  private closeTurnOn = (): void => {
    this.setState({ turnOn: false });
  };
  // The sheet closes on the mailbox that is on, and the status takes focus.
  private turnedOn = async (): Promise<void> => {
    this.setState({ turnOn: false });
    await this.agentStrip.current?.refresh();
    this.agentResumed();
  };

  // A decision or a saved draft changes what waits and the thread in Gmail.
  private reviewChanged = async (): Promise<void> => {
    this.refreshAgent();
    await this.reloadThread();
  };

  /** Reads the open thread again. A failed read keeps the messages shown. */
  private reloadThread = async (): Promise<void> => {
    const { accountId, thread } = this.state;
    if (accountId === null || thread.kind !== "ready") return;
    this.threadRequest?.abort();
    const request = new AbortController();
    this.threadRequest = request;
    let result: MailInboxResult;
    try {
      result = await readMailInbox(
        this.props.organisationId,
        {
          kind: "thread",
          integrationAccountId: accountId,
          threadId: thread.threadId,
        },
        request.signal,
      );
    } catch {
      return;
    }
    if (request.signal.aborted || result.kind !== "thread") return;
    this.setState({
      thread: {
        kind: "ready",
        threadId: thread.threadId,
        messages: result.messages,
      },
    });
  };

  /**
   * Reads a page of the mailbox. Another mailbox closes the conversation; a
   * read of the same list keeps it open beside the list.
   */
  private loadPage = async (
    accountId: string,
    query: string,
    cursor: string | null,
    filter: InboxFilter,
  ): Promise<void> => {
    const keep = accountId === this.state.accountId;
    this.request?.abort();
    if (!keep) {
      this.threadRequest?.abort();
      this.correctionRequest?.abort();
      this.decisionRequest?.abort();
    }
    const request = new AbortController();
    this.request = request;
    this.setState({ filter, accountId, query, page: { kind: "loading" } });
    if (!keep)
      this.setState({
        processing: { kind: "loading" },
        thread: { kind: "closed" },
        decision: { kind: "closed" },
      });
    // Google refused this mailbox's sign-in: the page asks for a reconnect.
    if (awaitsReconnect(this.state.accounts, accountId)) return;
    try {
      const result = await readMailInbox(
        this.props.organisationId,
        filter.kind === "all"
          ? { kind: "page", integrationAccountId: accountId, query, cursor }
          : {
              kind: "classifiedPage",
              integrationAccountId: accountId,
              filter,
              expectedRevision:
                mailProcessingView(this.state.processing)?.rules.revision ?? 0,
              cursor,
            },
        request.signal,
      );
      if (request.signal.aborted) return;
      if (result.kind !== "page") throw new Error("Inbox unavailable.");
      this.setState({
        page: {
          kind: "ready",
          value: { messages: result.messages, nextCursor: result.nextCursor },
        },
      });
    } catch (error) {
      if (request.signal.aborted) return;
      if (error instanceof MailReconnectRequired) {
        this.markReconnectRequired(accountId);
        this.setState({
          filter: { kind: "all" },
          decision: { kind: "closed" },
        });
        return;
      }
      this.setState({
        page: { kind: "failed", message: messageForError(error) },
        filter: { kind: "all" },
        decision: { kind: "closed" },
      });
    }
  };

  /**
   * Records a refusal that a read found. The list then names the mailbox
   * and asks for a reconnect, and the page reads no more of its mail.
   */
  private markReconnectRequired(accountId: string): void {
    const accounts = this.state.accounts;
    if (accounts.kind !== "ready") return;
    const value = accounts.value.map(awaitingReconnect.bind(null, accountId));
    LAST_ACCOUNTS.set(this.props.organisationId, value);
    this.setState({ accounts: { kind: "ready", value } });
  }

  private openThread = async (threadId: string): Promise<void> => {
    const accountId = this.state.accountId;
    if (accountId === null) return;
    this.threadRequest?.abort();
    this.correctionRequest?.abort();
    this.decisionRequest?.abort();
    const request = new AbortController();
    this.threadRequest = request;
    this.openOrder = this.shownDrafts;
    this.showSelection(threadId);
    // A case that the person opens shows in the drawer in place of JEV.
    this.setState(
      {
        thread: { kind: "loading", threadId },
        decision: { kind: "closed" },
        panel: "closed",
        whatsappCaseId: null,
      },
      this.focusThread,
    );
    try {
      const result = await readMailInbox(
        this.props.organisationId,
        { kind: "thread", integrationAccountId: accountId, threadId },
        request.signal,
      );
      if (request.signal.aborted) return;
      if (result.kind !== "thread")
        throw new Error("Conversation unavailable.");
      this.setState({
        thread: { kind: "ready", threadId, messages: result.messages },
      });
    } catch (error) {
      if (request.signal.aborted) return;
      if (error instanceof MailReconnectRequired)
        this.markReconnectRequired(accountId);
      this.setState({
        thread: { kind: "failed", threadId, message: messageForError(error) },
      });
    }
  };

  private focusThread = (): void => {
    this.heading.current?.focus();
  };

  private whatsappConversations(): readonly InboxWhatsAppConversation[] {
    const { whatsapp, channel } = this.state;
    return whatsapp.kind === "read" && channel !== "email"
      ? whatsapp.conversations
      : [];
  }
  private whatsappRows(tab: InboxTab): readonly InboxWhatsAppConversation[] {
    return this.whatsappConversations().filter(
      (conversation) => whatsappConversationTab(conversation.state) === tab,
    );
  }
  private openWhatsApp = (caseId: string): void => {
    this.threadRequest?.abort();
    this.correctionRequest?.abort();
    this.decisionRequest?.abort();
    this.showSelection(null, caseId);
    this.setState(
      {
        thread: { kind: "closed" },
        decision: { kind: "closed" },
        panel: "closed",
        whatsappCaseId: caseId,
      },
      this.focusThread,
    );
  };
  private closeWhatsApp = (): void => {
    const caseId = this.state.whatsappCaseId;
    this.showSelection(null);
    this.setState({ whatsappCaseId: null }, () => {
      const row =
        caseId === null
          ? null
          : this.root.current?.querySelector<HTMLElement>(
              `.mail-case-list [data-case-id="${CSS.escape(caseId)}"]`,
            );
      if (row !== null && row !== undefined) row.focus();
      else this.focusList();
    });
  };
  /** A reply went. The next conversation that needs a person opens. */
  private whatsappSent = (caseId: string): void => {
    toast.success("Reply sent.", { id: `whatsapp-sent-${caseId}` });
    const next = this.whatsappRows("needs").find(
      (conversation) => conversation.caseId !== caseId,
    );
    if (next !== undefined) {
      this.openWhatsApp(next.caseId);
      return;
    }
    const email = this.channelItems(this.needsItems())[0];
    if (email !== undefined) void this.openThread(email.draft.gmailThreadId);
    else this.closeWhatsApp();
  };
  /** The open mailbox's mail with no reply yet, for the chosen channel. */
  private unansweredRows(): readonly InboxUnansweredThread[] {
    const { unanswered, accountId, channel } = this.state;
    return channel === "whatsapp"
      ? []
      : unanswered.filter(
          (thread) => thread.integrationAccountId === accountId,
        );
  }
  /** The person's reply went. The next mail with no reply opens. */
  private personReplied = (threadId: string): void => {
    toast.success("Reply sent.", { id: `mail-person-reply-${threadId}` });
    const next = this.unansweredRows().find(
      (thread) => thread.threadId !== threadId,
    );
    if (next !== undefined) void this.openThread(next.threadId);
    else this.closeThread();
  };
  private channelItems(
    items: readonly MailDraftItem[],
  ): readonly MailDraftItem[] {
    return this.state.channel === "whatsapp" ? [] : items;
  }
  private changeChannel = (channel: string | null): void => {
    if (channel === "all" || channel === "email" || channel === "whatsapp")
      this.setState({ channel });
  };
  private openWhatsAppPrompt = (): void => {
    this.setState({ whatsappPrompt: true });
  };
  private closeWhatsAppPrompt = (): void => {
    this.setState({ whatsappPrompt: false });
  };
  private whatsappAllowed = (): void => {
    this.setState({ whatsappPrompt: false });
    void this.loadReplies();
  };
  private openAgentSheet = (): void => {
    this.setState({ agentSheet: true });
  };
  private closeAgentSheet = (): void => {
    this.setState({ agentSheet: false });
  };
  private agentSaved = (): void => {
    this.setState({ agentSheet: false });
    this.refreshAgent();
  };
  private agentSheetTurnOn = (): void => {
    this.setState({ agentSheet: false, turnOn: true });
  };
  private focusList = (): void => {
    (this.viewHeading.current ?? this.listHeading.current)?.focus();
  };
  /** Focus goes back to the row that opened the conversation, if it shows. */
  private focusRow(threadId: string | null): void {
    const row =
      threadId === null
        ? null
        : this.root.current?.querySelector<HTMLElement>(
            `.mail-case-list [data-thread-id="${CSS.escape(threadId)}"]`,
          );
    if (row !== null && row !== undefined) row.focus();
    else this.focusList();
  }
  private closeThread = (): void => {
    const thread = this.state.thread;
    this.threadRequest?.abort();
    this.correctionRequest?.abort();
    this.decisionRequest?.abort();
    this.showSelection(null);
    this.setState(
      { thread: { kind: "closed" }, decision: { kind: "closed" } },
      this.focusRow.bind(
        this,
        thread.kind === "closed" ? null : thread.threadId,
      ),
    );
  };
  /**
   * The drawer closes with Escape, unless the person writes in it. A menu of
   * the drawer lies outside it in the page, and its Escape closes the menu.
   */
  private drawerKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target) ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement ||
      (event.target instanceof HTMLElement &&
        event.target.dataset.slot === "select-trigger")
    )
      return;
    event.stopPropagation();
    this.closeThread();
  };

  private whatsappKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    )
      return;
    event.stopPropagation();
    this.closeWhatsApp();
  };

  /** The address of the page names the open conversation, or none. */
  private showSelection(
    threadId: string | null,
    caseId: string | null = null,
  ): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("proposal");
    url.searchParams.delete("thread");
    url.searchParams.delete("case");
    if (caseId !== null) url.searchParams.set("case", caseId);
    if (threadId !== null) {
      const draft = waitingMailDrafts(
        this.state.replies ?? [],
        this.state.accountId,
      ).find((waiting) => waiting.gmailThreadId === threadId);
      if (draft === undefined) url.searchParams.set("thread", threadId);
      else url.searchParams.set("proposal", draft.proposalId);
    }
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (
      href !==
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    )
      window.history.replaceState(window.history.state, "", href);
  }

  /** The conversations that the pane steps through, in the list's order. */
  private paneRows(items: readonly MailDraftItem[]): readonly PaneRow[] {
    const { scope, page, replies, accountId, channel } = this.state;
    const threads = (ids: readonly string[]): readonly PaneRow[] =>
      [...new Set(ids)].map((threadId) => ({ kind: "thread", threadId }));
    const cases = (tab: InboxTab): readonly PaneRow[] =>
      this.whatsappRows(tab).map(({ caseId }) => ({ kind: "case", caseId }));
    switch (scope) {
      case "inbox":
        return [
          ...this.waitingRows(items),
          ...cases("agent"),
          ...threads(this.otherMail().map((message) => message.threadId)),
        ];
      case "done":
        return [
          ...cases("handled"),
          ...(channel === "whatsapp"
            ? []
            : threads(
                handledMailDrafts(replies ?? [], accountId).map(
                  (reply) => reply.gmailThreadId,
                ),
              )),
        ];
      case "all":
        return page.kind === "ready"
          ? threads(page.value.messages.map((message) => message.threadId))
          : [];
      case "spam":
        return [];
      default:
        return assertNever(scope);
    }
  }
  /** What waits for the person, the longest wait first, as the list shows. */
  private waitingRows(items: readonly MailDraftItem[]): readonly PaneRow[] {
    const waiting: { readonly since: number; readonly row: PaneRow }[] = [];
    for (const item of this.channelItems(items))
      waiting.push({
        since: item.since,
        row: { kind: "thread", threadId: item.draft.gmailThreadId },
      });
    for (const thread of this.unansweredRows())
      waiting.push({
        since: thread.receivedAt,
        row: { kind: "thread", threadId: thread.threadId },
      });
    for (const conversation of this.whatsappRows("needs"))
      waiting.push({
        since: conversation.waitingSince,
        row: { kind: "case", caseId: conversation.caseId },
      });
    return waiting
      .sort((left, right) => left.since - right.since)
      .map((entry) => entry.row);
  }
  /**
   * The newest mail of the mailbox that waits for nobody: one row for each
   * thread. A thread that waits shows above it. A decided thread is done,
   * until newer mail comes in it.
   */
  private otherMail(): readonly MailInboxMessage[] {
    const { page, replies, accountId, channel, decided } = this.state;
    if (channel === "whatsapp" || page.kind !== "ready") return [];
    const waiting = new Set<string>();
    for (const draft of waitingMailDrafts(replies ?? [], accountId))
      if (!decided.has(draft.proposalId)) waiting.add(draft.gmailThreadId);
    for (const thread of this.unansweredRows()) waiting.add(thread.threadId);
    const doneAt = new Map<string, number>();
    for (const reply of replies ?? [])
      if (
        reply.integrationAccountId === accountId &&
        (decided.has(reply.proposalId) ||
          !emailReplyIsOpenable(reply.lifecycleKind))
      )
        doneAt.set(
          reply.gmailThreadId,
          Math.max(doneAt.get(reply.gmailThreadId) ?? 0, reply.updatedAt),
        );
    const shown = new Set<string>();
    const other: MailInboxMessage[] = [];
    for (const message of page.value.messages) {
      if (waiting.has(message.threadId) || shown.has(message.threadId))
        continue;
      shown.add(message.threadId);
      if (message.receivedAt <= (doneAt.get(message.threadId) ?? 0)) continue;
      other.push(message);
    }
    return other;
  }
  private step(rows: readonly PaneRow[], direction: 1 | -1): void {
    const { thread, whatsappCaseId } = this.state;
    const at = rows.findIndex((row) =>
      row.kind === "case"
        ? row.caseId === whatsappCaseId
        : thread.kind !== "closed" && row.threadId === thread.threadId,
    );
    const next =
      at === -1 ? rows[0] : rows[(at + direction + rows.length) % rows.length];
    if (next === undefined) return;
    if (next.kind === "case") this.openWhatsApp(next.caseId);
    else void this.openThread(next.threadId);
  }

  /**
   * An approved or rejected draft leaves the list at once, and the next draft
   * that needs the person opens.
   * The backend cannot take back a send or a rejection, so the toast offers
   * no undo.
   */
  private draftDecided = (decision: MailDraftDecision): void => {
    const sender = this.state.names.get(decision.proposalId) ?? null;
    const text = receiptText(decision, sender);
    toast.success(text, { id: `mail-decision-${decision.proposalId}` });
    const decided = new Set(this.state.decided).add(decision.proposalId);
    if (this.state.scope !== "inbox") {
      this.setState({ decided });
      return;
    }
    const shown = this.openOrder;
    const at = shown.indexOf(decision.proposalId);
    const order = [...shown.slice(at + 1), ...shown.slice(0, Math.max(at, 0))];
    const waiting = this.needsItems();
    let next: MailDraftItem | undefined;
    for (const proposalId of order) {
      next = waiting.find(
        (item) =>
          item.draft.proposalId === proposalId && !decided.has(proposalId),
      );
      if (next !== undefined) break;
    }
    next ??= waiting.find((item) => !decided.has(item.draft.proposalId));
    this.setState({ decided });
    if (next === undefined) this.closeThread();
    else void this.openThread(next.draft.gmailThreadId);
  };

  /** The drafts of the open mailbox that wait for a decision, as rows. */
  private needsItems(): readonly MailDraftItem[] {
    const { replies, accountId, page, decided } = this.state;
    const messages = page.kind === "ready" ? page.value.messages : [];
    return waitingMailDrafts(replies ?? [], accountId)
      .filter((draft) => !decided.has(draft.proposalId))
      .map(mailDraftItem.bind(null, messages))
      .sort(longestWaitFirst);
  }

  private changeMailbox = (accountId: string): void => {
    if (accountId === this.state.accountId) return;
    this.clearMailCheck();
    this.closeSpam();
    this.showSelection(null);
    this.setState({
      searchInput: "",
      scope: "inbox",
      agent: null,
      mailCheckAt: null,
    });
    void this.loadPage(accountId, "", null, { kind: "all" });
  };
  private changeSearch = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.setState({ searchInput: event.target.value });
  };
  /** A search shows its results in All mail. The field keeps focus. */
  private search = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (this.state.accountId === null) return;
    const query = this.state.searchInput.trim();
    if (query !== "" && this.state.scope !== "all")
      this.showScope("all", false);
    void this.loadPage(this.state.accountId, query, null, { kind: "all" });
  };
  private showView = (view: "all" | "spam"): void => {
    this.showScope(view, true);
  };
  private showDone = (): void => {
    this.showScope("done", true);
  };
  /**
   * Back to the Inbox. All mail can show a search, a view or a later page,
   * so the Inbox reads its newest mail again.
   */
  private closeView = (): void => {
    const fromAll = this.state.scope === "all";
    this.showScope("inbox", true);
    if (!fromAll || this.state.accountId === null) return;
    this.setState({ searchInput: "" });
    void this.loadPage(this.state.accountId, "", null, { kind: "all" });
  };
  /**
   * A view shows its list. A conversation that the list does not hold
   * closes. Unless a tab was pressed, the list's heading takes focus.
   */
  private showScope(scope: InboxScope, focus: boolean): void {
    this.threadRequest?.abort();
    this.correctionRequest?.abort();
    this.decisionRequest?.abort();
    this.showSelection(null);
    this.setState(
      {
        scope,
        thread: { kind: "closed" },
        decision: { kind: "closed" },
        whatsappCaseId: null,
      },
      focus ? this.focusList : undefined,
    );
    if (scope === "spam") void this.loadSpam(null);
  }
  /**
   * Reads one page of Gmail's Spam. Spam is listed only: a row opens the
   * message in Gmail, where the person can mark it as not spam.
   */
  private loadSpam = async (cursor: string | null): Promise<void> => {
    const accountId = this.state.accountId;
    if (accountId === null) return;
    this.spamRequest?.abort();
    const request = new AbortController();
    this.spamRequest = request;
    this.setState({ spam: { kind: "loading" } });
    if (awaitsReconnect(this.state.accounts, accountId)) return;
    try {
      const result = await readMailInbox(
        this.props.organisationId,
        { kind: "spamPage", integrationAccountId: accountId, cursor },
        request.signal,
      );
      if (request.signal.aborted) return;
      if (result.kind !== "page") throw new Error("Spam unavailable.");
      this.setState({
        spam: {
          kind: "ready",
          value: { messages: result.messages, nextCursor: result.nextCursor },
        },
      });
    } catch (error) {
      if (request.signal.aborted) return;
      if (error instanceof MailReconnectRequired) {
        this.markReconnectRequired(accountId);
        return;
      }
      this.setState({
        spam: { kind: "failed", message: messageForError(error) },
      });
    }
  };
  private firstSpamPage = (): void => {
    void this.loadSpam(null);
  };
  private nextSpamPage = (): void => {
    const spam = this.state.spam;
    if (spam?.kind === "ready" && spam.value.nextCursor !== null)
      void this.loadSpam(spam.value.nextCursor);
  };
  /** Another mailbox shows its own folders, so its Spam is not shown. */
  private closeSpam(): void {
    this.spamRequest?.abort();
    this.setState({
      spam: null,
      scope: this.state.scope === "spam" ? "inbox" : this.state.scope,
    });
  }
  private refresh = (): void => {
    this.organizationPanel.current?.refreshView();
    this.refreshAgent();
    this.refreshPage();
    if (this.state.scope === "spam") void this.loadSpam(null);
    void this.checkMail();
  };
  /**
   * Refresh also asks Gmail for new mail, for a push that is late or that
   * never comes, as on a local backend. The waiting drafts are read again
   * after the time of the agent's turn. A check that fails changes nothing.
   * While the agent state is still unread, the check goes too: the server
   * refuses it for a mailbox that is not on.
   */
  private checkMail = async (): Promise<void> => {
    const accountId = this.state.accountId;
    const agent = this.state.agent;
    if (
      accountId === null ||
      !this.props.canManage ||
      (agent !== null && agent.kind !== "on")
    )
      return;
    let check: MailboxCheck;
    try {
      check = await checkMailAgent(this.props.organisationId, accountId);
    } catch {
      return;
    }
    if (this.state.accountId !== accountId || check.kind !== "scheduled")
      return;
    this.clearMailCheck();
    this.setState({ mailCheckAt: check.at });
    const wait = Math.max(0, check.at - Date.now());
    for (const after of MAIL_CHECK_READS_MS)
      this.checkTimers.push(window.setTimeout(this.loadReplies, wait + after));
    this.checkTimers.push(
      window.setTimeout(this.endMailCheck, wait + MAIL_CHECK_SHOWN_MS),
    );
  };
  private endMailCheck = (): void => {
    this.setState({ mailCheckAt: null });
  };
  private clearMailCheck(): void {
    for (const timer of this.checkTimers) window.clearTimeout(timer);
    this.checkTimers = [];
  }
  /** Reads the first page again. An open conversation stays open. */
  private refreshPage = (): void => {
    if (this.state.accountId !== null)
      void this.loadPage(
        this.state.accountId,
        this.state.query,
        null,
        mailProcessingView(this.state.processing) === null
          ? { kind: "all" }
          : this.state.filter,
      );
  };
  private next = (): void => {
    if (
      this.state.accountId !== null &&
      this.state.page.kind === "ready" &&
      this.state.page.value.nextCursor !== null
    ) {
      void this.loadPage(
        this.state.accountId,
        this.state.query,
        this.state.page.value.nextCursor,
        this.state.filter,
      );
    }
  };
  private firstPage = (): void => {
    if (this.state.accountId !== null)
      void this.loadPage(
        this.state.accountId,
        this.state.query,
        null,
        this.state.filter,
      );
  };

  private assistantRule = (
    rule: import("@purin-labs/control-api").MailRule,
  ): void => {
    this.organizationPanel.current?.reviewSuggestedRule(rule);
  };

  private openJev = (opener: HTMLElement | null): void => {
    this.jevOpener = opener;
    this.setState({ panel: "jev" }, this.focusJev);
  };
  private toggleProcessing = (enabled: boolean): void => {
    this.organizationPanel.current?.setAutomaticProcessing(enabled);
  };
  private focusJev = (): void => {
    this.jevHeading.current?.focus();
  };
  private closeJev = (): void => {
    this.setState({ panel: "closed" }, this.focusJevOpener);
  };
  private focusJevOpener = (): void => {
    const opener = this.jevOpener;
    this.jevOpener = null;
    if (opener?.isConnected) opener.focus();
    else if (this.state.thread.kind !== "closed") this.focusThread();
    else this.focusList();
  };
  private panelKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (
      event.key === "Escape" &&
      event.target instanceof Node &&
      event.currentTarget.contains(event.target)
    ) {
      event.stopPropagation();
      this.closeJev();
    }
  };

  private processingChanged = (processing: MailProcessingState): void => {
    const previous = mailProcessingView(this.state.processing);
    const organization = mailProcessingView(processing);
    const revisionChanged =
      organization !== null &&
      previous !== null &&
      organization.rules.revision !== previous.rules.revision;
    if (
      (revisionChanged || processing.kind === "unavailable") &&
      this.state.filter.kind !== "all"
    )
      this.setState(
        { processing, filter: { kind: "all" }, decision: { kind: "closed" } },
        this.refreshPage,
      );
    else if (organization === null)
      this.setState({ processing, decision: { kind: "closed" } });
    else this.setState({ processing });
  };
  private selectFilter = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const accountId = this.state.accountId;
    if (accountId === null) return;
    const kind = event.currentTarget.dataset.filter;
    const ruleId = event.currentTarget.dataset.ruleId;
    let filter: InboxFilter;
    if (kind === "all") filter = { kind: "all" };
    else if (kind === "important") filter = { kind: "important" };
    else if (kind === "category" && ruleId !== undefined)
      filter = { kind: "category", ruleId };
    else return;
    this.setState({ searchInput: "" });
    void this.loadPage(accountId, "", null, filter);
  };

  private correctClassification = async (
    messageId: string,
    ruleId: string,
    outcome: string | null,
  ): Promise<void> => {
    const organization = mailProcessingView(this.state.processing);
    const accountId = this.state.accountId;
    if (
      organization === null ||
      accountId === null ||
      (outcome !== "matched" &&
        outcome !== "not_matched" &&
        outcome !== "needs_review")
    )
      return;
    this.correctionRequest?.abort();
    this.decisionRequest?.abort();
    this.setState({ decision: { kind: "closed" } });
    const request = new AbortController();
    this.correctionRequest = request;
    try {
      await mailOrganizationRequest(
        this.props.organisationId,
        accountId,
        {
          kind: "correct",
          expectedRevision: organization.rules.revision,
          messageId,
          ruleId,
          outcome,
        },
        request.signal,
      );
      if (!request.signal.aborted) {
        if (
          outcome !== "matched" &&
          correctionAffectsFilter(this.state.filter, organization, ruleId)
        ) {
          await this.loadPage(accountId, "", null, this.state.filter);
          this.focusList();
        } else this.organizationPanel.current?.refreshView();
      }
    } catch (error) {
      if (!request.signal.aborted && this.state.thread.kind !== "closed")
        this.setState({
          thread: {
            kind: "failed",
            threadId: this.state.thread.threadId,
            message: messageForError(error),
          },
        });
    }
  };
  private renderCorrection = (
    result: import("@purin-labs/control-api").MailClassification,
  ): React.ReactNode => {
    if (this.state.thread.kind !== "ready") return null;
    let subject: string | null = null;
    for (const message of this.state.thread.messages)
      if (message.messageId === result.messageId)
        subject = message.subject || "No subject";
    if (subject === null) return null;
    let name = "Priority";
    for (const rule of mailProcessingView(this.state.processing)?.rules.rules ??
      [])
      if (rule.ruleId === result.ruleId && rule.kind === "categorize")
        name = rule.category;
    return (
      <div
        className="mail-correction"
        key={`${result.messageId}:${result.ruleId}`}
      >
        <p
          className="mail-inbox-note"
          id={`mail-classification-subject-${result.messageId}-${result.ruleId}`}
        >
          {subject}
        </p>
        <label>
          {name} ·{" "}
          {result.source === "operator" ? "Your correction" : "JEV result"}
          {this.props.canManage ? (
            <Select.Root
              items={MAIL_CORRECTION_OUTCOMES}
              value={result.outcome}
              onValueChange={(outcome) => {
                void this.correctClassification(
                  result.messageId,
                  result.ruleId,
                  outcome,
                );
              }}
            >
              <Select.Trigger
                aria-describedby={`mail-classification-subject-${result.messageId}-${result.ruleId}`}
                data-message-id={result.messageId}
                data-rule-id={result.ruleId}
              >
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {MAIL_CORRECTION_OUTCOMES.map(renderMailSelectItem)}
              </Select.Popup>
            </Select.Root>
          ) : (
            <span>{result.outcome.replaceAll("_", " ")}</span>
          )}
        </label>
        <button
          type="button"
          data-message-id={result.messageId}
          data-rule-id={result.ruleId}
          onClick={this.readDecision}
          aria-label={`Decision details for ${name}: ${subject}`}
        >
          Decision details for {name}
        </button>
      </div>
    );
  };
  /** The rule results for the messages of the open thread. */
  private renderClassifications(
    messages: readonly MailInboxThreadMessage[],
    organization: MailOrganizationView | null,
  ): React.ReactNode {
    if (organization === null) return null;
    const results = organization.classifications.filter(
      classifiesOneOf.bind(null, messages),
    );
    if (results.length === 0) return null;
    return (
      <section className="mail-details-section">
        <h4>Classification and corrections</h4>
        <p className="mail-inbox-note">
          Corrections apply to these messages and this rule revision.
        </p>
        {results.map(this.renderCorrection)}
        {renderDecision(this.state.decision, this.state.thread)}
      </section>
    );
  }
  private renderCategoryFilter = (
    rule: import("@purin-labs/control-api").MailRule,
  ): React.ReactNode => {
    if (rule.kind !== "categorize") return null;
    return (
      <button
        key={rule.ruleId}
        type="button"
        className="mail-nav-item"
        data-filter="category"
        data-rule-id={rule.ruleId}
        aria-pressed={
          this.state.filter.kind === "category" &&
          this.state.filter.ruleId === rule.ruleId
        }
        disabled={this.state.page.kind === "loading"}
        onClick={this.selectFilter}
      >
        <span className="mail-nav-label">{rule.category}</span>
      </button>
    );
  };

  private readDecision = async (
    event: React.MouseEvent<HTMLButtonElement>,
  ): Promise<void> => {
    const accountId = this.state.accountId;
    const organization = mailProcessingView(this.state.processing);
    const messageId = event.currentTarget.dataset.messageId;
    const ruleId = event.currentTarget.dataset.ruleId;
    if (
      accountId === null ||
      organization === null ||
      messageId === undefined ||
      ruleId === undefined
    )
      return;
    this.decisionRequest?.abort();
    const request = new AbortController();
    this.decisionRequest = request;
    this.setState({ decision: { kind: "loading" } });
    try {
      const result = await readMailInbox(
        this.props.organisationId,
        {
          kind: "decision",
          integrationAccountId: accountId,
          expectedRevision: organization.rules.revision,
          messageId,
          ruleId,
        },
        request.signal,
      );
      if (request.signal.aborted) return;
      if (result.kind !== "decision")
        throw new Error("Decision details unavailable.");
      this.setState({ decision: { kind: "ready", value: result.decision } });
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({
          decision: { kind: "failed", message: messageForError(error) },
        });
    }
  };

  /** The browser's Back and Forward open and close the settings page. */
  private addressChanged = (): void => {
    this.setState({ settings: readSettings() });
  };

  /**
   * A link to this page opens or closes the mailbox settings page in place,
   * as an entry in the browser's history. Menus and sheets render in portals,
   * and their clicks reach here through React.
   */
  private linkClicked = (event: React.MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest("a");
    if (!(link instanceof HTMLAnchorElement) || link.target !== "") return;
    const url = new URL(link.href);
    if (
      url.origin !== window.location.origin ||
      url.pathname !== window.location.pathname
    )
      return;
    const settings = url.searchParams.get("settings");
    if (settings === null && this.state.settings === null) return;
    event.preventDefault();
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    this.setState({
      settings: settings === "" ? null : settings,
      turnOn: false,
      agentSheet: false,
    });
    window.scrollTo({ top: 0 });
  };

  render(): React.ReactNode {
    return (
      <div className="mail-inbox-route" onClick={this.linkClicked}>
        {this.state.settings === null
          ? this.renderInbox()
          : this.props.mailboxSettings(this.state.settings, inboxHref())}
      </div>
    );
  }

  private renderInbox(): React.ReactNode {
    const { accounts, accountId, thread } = this.state;
    if (accounts.kind === "loading")
      return <p role="status">Loading mailboxes…</p>;
    if (accounts.kind === "failed")
      return (
        <section className="mail-inbox mail-inbox-empty">
          <p role="alert">{accounts.message}</p>
          <button type="button" onClick={this.loadAccounts}>
            Try again
          </button>
        </section>
      );
    if (accounts.value.length === 0 && this.state.whatsapp.kind !== "read")
      return (
        <section className="mail-inbox mail-inbox-empty">
          <h1>Inbox</h1>
          <div className="mail-inbox-connect">
            <h2>Connect your mailbox</h2>
            <p>
              Connect a Gmail mailbox that Purin Pantry may read. Send-only
              accounts stay available for operational email.
            </p>
            <a href={`${this.props.integrationsPath}?integration=gmail`}>
              Connect Gmail
            </a>
          </div>
        </section>
      );
    const items = this.needsItems();
    this.shownDrafts = items.map((item) => item.draft.proposalId);
    const whatsappOpen = this.whatsappOpenConversation();
    const caseOpen = thread.kind !== "closed" || whatsappOpen !== null;
    const jevOpen = this.state.panel === "jev";
    const drawerOpen = caseOpen || jevOpen;
    return (
      <>
        <section
          ref={this.root}
          className="mail-inbox"
          aria-label="Mail inbox"
          data-drawer={drawerOpen ? "open" : "closed"}
        >
          {this.renderPage(items)}
          {/* On a wide screen the column stays beside the list, and says
            what it shows when no email is open. A narrow screen shows it
            only over the list, for an open email or JEV. */}
          <div className="mail-drawer" data-open={drawerOpen}>
            <MailConsoleDock shared={caseOpen && !jevOpen} />
            {drawerOpen ? null : (
              <div className="mail-column-empty">
                <Mails size={28} aria-hidden="true" />
                <p>
                  {this.state.whatsapp.kind === "read"
                    ? "Choose a conversation to read it and its suggested reply here."
                    : "Choose an email to read it and its suggested reply here."}
                </p>
              </div>
            )}
            {thread.kind !== "closed" ? (
              <div
                className="mail-drawer-case"
                hidden={jevOpen}
                onKeyDown={this.drawerKeyDown}
              >
                {this.renderCase(thread, {
                  kind: "drawer",
                  ...this.drawerSteps(items),
                  onClose: this.closeThread,
                })}
              </div>
            ) : null}
            {whatsappOpen !== null ? (
              <div
                className="mail-drawer-case"
                hidden={jevOpen}
                onKeyDown={this.whatsappKeyDown}
              >
                <WhatsAppConversation
                  key={whatsappOpen.caseId}
                  organisationId={this.props.organisationId}
                  conversation={whatsappOpen}
                  canManage={this.props.canManage}
                  heading={this.heading}
                  onChanged={this.loadReplies}
                  onSent={this.whatsappSent}
                  navigation={{
                    kind: "drawer",
                    ...this.drawerSteps(items),
                    onClose: this.closeWhatsApp,
                  }}
                />
              </div>
            ) : null}
            {this.renderJev()}
          </div>
        </section>
        {this.props.canManage ? (
          <InboxAgentSheet
            open={this.state.agentSheet}
            organisationId={this.props.organisationId}
            accountId={accountId}
            agent={this.state.agent}
            hasWhatsApp={this.state.whatsapp.kind === "read"}
            close={this.closeAgentSheet}
            onTurnOnMailbox={this.agentSheetTurnOn}
            onSaved={this.agentSaved}
          />
        ) : null}
        {this.state.whatsappPrompt &&
        this.state.whatsapp.kind === "read" &&
        this.state.whatsapp.refused !== null ? (
          <PermissionRequiredPrompt
            organisationId={this.props.organisationId}
            permission={this.state.whatsapp.refused}
            action="Read WhatsApp conversations"
            grantScope="for this WhatsApp number only"
            onAllowed={this.whatsappAllowed}
            onClose={this.closeWhatsAppPrompt}
          />
        ) : null}
        {/* The sheet sits outside the Inbox, so that the Inbox's own control
          styles do not reach it. */}
        {accountId !== null && this.props.canManage ? (
          <MailboxTurnOnSheet
            key={accountId}
            organisationId={this.props.organisationId}
            accountId={accountId}
            address={mailboxAddress(
              accounts.value,
              accountId,
              this.state.agent,
            )}
            open={this.state.turnOn}
            close={this.closeTurnOn}
            onTurnedOn={this.turnedOn}
            settingsHref={mailboxSettingsHref(accountId)}
          />
        ) : null}
      </>
    );
  }

  /** The open WhatsApp conversation, while the list still names it. */
  private whatsappOpenConversation(): InboxWhatsAppConversation | null {
    const { whatsapp, whatsappCaseId } = this.state;
    if (whatsapp.kind !== "read" || whatsappCaseId === null) return null;
    return (
      whatsapp.conversations.find(hasCaseId.bind(null, whatsappCaseId)) ?? null
    );
  }

  private drawerSteps(items: readonly MailDraftItem[]): Readonly<{
    onPrevious: (() => void) | null;
    onNext: (() => void) | null;
  }> {
    const rows = this.paneRows(items);
    if (rows.length < 2) return { onPrevious: null, onNext: null };
    return {
      onPrevious: this.step.bind(this, rows, -1),
      onNext: this.step.bind(this, rows, 1),
    };
  }

  /** A source that failed or refused says so. The other source stays. */
  private renderSourceNotices(): React.ReactNode {
    const { whatsapp, emailFailed } = this.state;
    return (
      <>
        {emailFailed ? (
          <SourceFailed
            text="Email could not load. Other channels still show here."
            onRetry={this.loadReplies}
          />
        ) : null}
        {whatsapp.kind === "failed" ? (
          <SourceFailed
            text="WhatsApp could not load. Other channels still show here."
            onRetry={this.loadReplies}
          />
        ) : null}
        {whatsapp.kind === "read" && whatsapp.truncated ? (
          <p className="mail-pane-notice mail-inbox-note">
            More WhatsApp conversations exist than this list shows.
          </p>
        ) : null}
        {whatsapp.kind === "read" && whatsapp.refused !== null ? (
          <div
            className="mail-agent-strip"
            role="group"
            aria-label="WhatsApp access"
          >
            <p>You cannot read this WhatsApp number yet.</p>
            <button type="button" onClick={this.openWhatsAppPrompt}>
              Request access
            </button>
          </div>
        ) : null}
      </>
    );
  }

  /** The page: its header, one list for the chosen view, and notices. */
  private renderPage(items: readonly MailDraftItem[]): React.ReactNode {
    const { accounts, accountId, replies } = this.state;
    if (accounts.kind !== "ready") return null;
    const notice =
      this.state.processing.kind === "unavailable"
        ? null
        : processingNotice(this.state.processing);
    const busy =
      this.state.processing.kind === "loading" ||
      this.state.processing.kind === "updating";
    return (
      <div className="mail-page">
        <header className="mail-page-head">
          <div className="mail-page-title">
            <h1 tabIndex={-1} ref={this.listHeading}>
              Inbox
            </h1>
            <p className="mail-page-summary" role="status">
              {summaryLine(
                this.channelItems(items),
                this.whatsappRows("needs"),
                this.unansweredRows(),
                replies,
                this.props.canManage,
              )}
            </p>
          </div>
          <div className="mail-page-tools">
            {accounts.value.length === 0 ? null : (
              <MailStatusMenu
                accounts={accounts.value}
                accountId={accountId}
                agent={this.state.agent}
                mailCheckAt={this.state.mailCheckAt}
                settingsHref={
                  accountId === null ? null : mailboxSettingsHref(accountId)
                }
                onMailbox={this.changeMailbox}
                onRefresh={this.refresh}
                trigger={this.statusTrigger}
              />
            )}
            {/* A fixed slot, so that the busy mark never moves the page. */}
            <span
              className="mail-busy"
              role="status"
              title={
                this.state.mailCheckAt === null
                  ? undefined
                  : `Reads new mail at ${formatMailCheckTime(this.state.mailCheckAt)}`
              }
            >
              {busy || this.state.mailCheckAt !== null ? (
                <LoaderCircle
                  className="mail-busy-icon"
                  size={18}
                  aria-hidden="true"
                />
              ) : null}
              {busy ? (
                <span className="visually-hidden">
                  {this.state.processing.kind === "loading"
                    ? "Loading processing settings"
                    : "Updating processing settings"}
                </span>
              ) : null}
            </span>
            {this.props.canManage ? (
              <button
                type="button"
                className="mail-icon-button"
                aria-label="Agent setting"
                title="Agent setting"
                onClick={this.openAgentSheet}
              >
                <Bot size={18} aria-hidden="true" />
              </button>
            ) : null}
            {accounts.value.length === 0 ? null : (
              <MailProcessingMenu
                processing={this.state.processing}
                canManage={this.props.canManage}
                integrationsPath={this.props.integrationsPath}
                settingsHref={
                  accountId === null ? null : mailboxSettingsHref(accountId)
                }
                onToggle={this.toggleProcessing}
                onRules={this.openJev}
                onView={this.showView}
              />
            )}
          </div>
        </header>
        {this.renderSourceNotices()}
        {accountId !== null ? (
          <MailAgentStrip
            key={accountId}
            ref={this.agentStrip}
            organisationId={this.props.organisationId}
            accountId={accountId}
            settingsHref={mailboxSettingsHref(accountId)}
            canManage={this.props.canManage}
            onChange={this.agentChanged}
            onResumed={this.agentResumed}
            onTurnOn={this.openTurnOn}
          />
        ) : null}
        {this.state.processing.kind === "unavailable" ? (
          <p className="mail-pane-notice" role="alert">
            {this.state.processing.message}
          </p>
        ) : (
          <p className="mail-pane-notice mail-inbox-note" role="status">
            {notice}
          </p>
        )}
        <div className="mail-page-bar">
          <form className="mail-search" onSubmit={this.search} role="search">
            <label htmlFor="mail-inbox-search" className="visually-hidden">
              Search mail
            </label>
            <button
              type="submit"
              className="mail-icon-button"
              aria-label="Search"
              disabled={
                accountId === null ||
                this.state.page.kind === "loading" ||
                this.state.filter.kind !== "all"
              }
            >
              <Search size={18} aria-hidden="true" />
            </button>
            <input
              id="mail-inbox-search"
              type="search"
              value={this.state.searchInput}
              maxLength={256}
              onChange={this.changeSearch}
              placeholder="Search mail"
              disabled={accountId === null || this.state.filter.kind !== "all"}
            />
          </form>
          {this.state.whatsapp.kind === "read" ? (
            <label className="mail-channel-filter">
              <span className="visually-hidden">Channel</span>
              <Select.Root
                items={MAIL_CHANNELS}
                value={this.state.channel}
                onValueChange={this.changeChannel}
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {MAIL_CHANNELS.map(renderMailSelectItem)}
                </Select.Popup>
              </Select.Root>
            </label>
          ) : null}
        </div>
        {this.renderList(items)}
      </div>
    );
  }

  private renderList(items: readonly MailDraftItem[]): React.ReactNode {
    const { scope } = this.state;
    switch (scope) {
      case "inbox":
        return this.renderSections(items);
      case "done":
        return this.renderDone();
      case "all":
      case "spam":
        return this.renderView(scope);
      default:
        return assertNever(scope);
    }
  }

  /**
   * One list in sections, each always open. What waits for the person comes
   * first; the agent's answers and the other mail follow.
   */
  private renderSections(items: readonly MailDraftItem[]): React.ReactNode {
    const { replies, accountId, thread, page, channel } = this.state;
    const openThreadId = thread.kind === "closed" ? null : thread.threadId;
    const waiting = this.channelItems(items);
    const whatsappWaiting = this.whatsappRows("needs");
    const unanswered = this.unansweredRows();
    const agent = this.whatsappRows("agent");
    const other = this.otherMail();
    const showMail = accountId !== null && channel !== "whatsapp";
    const waitCount =
      waiting.length + whatsappWaiting.length + unanswered.length;
    return (
      <>
        <section className="mail-section" aria-labelledby="mail-waiting">
          <h2 id="mail-waiting" className="mail-section-head">
            Waiting for you
            {replies === null || waitCount === 0 ? null : (
              <span className="mail-section-count">{waitCount}</span>
            )}
          </h2>
          {replies === null ? (
            <p className="mail-inbox-status" role="status">
              Loading what waits…
            </p>
          ) : (
            <MailNeedsYouList
              items={waiting}
              whatsapp={whatsappWaiting}
              unanswered={unanswered}
              openThreadId={openThreadId}
              openCaseId={this.state.whatsappCaseId}
              onOpen={this.openThread}
              onOpenWhatsApp={this.openWhatsApp}
            />
          )}
        </section>
        {agent.length === 0 ? null : (
          <section className="mail-section" aria-labelledby="mail-agent">
            <h2 id="mail-agent" className="mail-section-head">
              The agent answered
              <span className="mail-section-count">{agent.length}</span>
            </h2>
            <InboxWhatsAppList
              label="The agent answered"
              conversations={agent}
              openCaseId={this.state.whatsappCaseId}
              onOpen={this.openWhatsApp}
            />
          </section>
        )}
        {showMail ? (
          <section className="mail-section" aria-labelledby="mail-other">
            <h2 id="mail-other" className="mail-section-head">
              Other mail
              {page.kind === "ready" && other.length > 0 ? (
                <span className="mail-section-count">{other.length}</span>
              ) : null}
            </h2>
            {awaitsReconnect(this.state.accounts, accountId) ? (
              this.renderReconnect()
            ) : page.kind === "loading" ? (
              <p className="mail-inbox-status" role="status">
                Loading mail…
              </p>
            ) : page.kind === "failed" ? (
              <SourceFailed text={page.message} onRetry={this.firstPage} />
            ) : (
              <MailOtherList
                messages={other}
                openThreadId={openThreadId}
                onOpen={this.openThread}
              />
            )}
          </section>
        ) : null}
        <div className="mail-view-links" role="group" aria-label="Other views">
          <button
            type="button"
            className="mail-view-link"
            onClick={this.showDone}
          >
            <Check size={16} aria-hidden="true" />
            Done
          </button>
          {accountId === null ? null : (
            <>
              <button
                type="button"
                className="mail-view-link"
                onClick={this.showView.bind(this, "all")}
              >
                <Mails size={16} aria-hidden="true" />
                All mail
              </button>
              <button
                type="button"
                className="mail-view-link"
                onClick={this.showView.bind(this, "spam")}
              >
                <OctagonAlert size={16} aria-hidden="true" />
                Spam
              </button>
            </>
          )}
        </div>
      </>
    );
  }

  /** The conversations that wait for nobody now: what was sent or decided. */
  private renderDone(): React.ReactNode {
    const { replies, accountId, thread } = this.state;
    const openThreadId = thread.kind === "closed" ? null : thread.threadId;
    return (
      <section className="mail-section" aria-labelledby="mail-done">
        <div className="mail-section-bar">
          <button type="button" className="mail-back" onClick={this.closeView}>
            <ChevronLeft size={16} aria-hidden="true" />
            Inbox
          </button>
        </div>
        <h2
          id="mail-done"
          className="mail-section-head"
          tabIndex={-1}
          ref={this.viewHeading}
        >
          Done
        </h2>
        <InboxWhatsAppList
          label="WhatsApp conversations that are done"
          conversations={this.whatsappRows("handled")}
          openCaseId={this.state.whatsappCaseId}
          onOpen={this.openWhatsApp}
        />
        {replies === null ? (
          <p className="mail-inbox-status" role="status">
            Loading decisions…
          </p>
        ) : this.state.channel === "whatsapp" ? null : (
          <MailHandledList
            replies={handledMailDrafts(replies, accountId)}
            names={this.state.names}
            messages={
              this.state.page.kind === "ready"
                ? this.state.page.value.messages
                : []
            }
            openThreadId={openThreadId}
            onOpen={this.openThread}
          />
        )}
      </section>
    );
  }

  /** All mail or Spam: a list of Gmail's own, with its pages. */
  private renderView(scope: "all" | "spam"): React.ReactNode {
    const { accounts, accountId, page, spam, replies } = this.state;
    if (accounts.kind !== "ready") return null;
    const organization = mailProcessingView(this.state.processing);
    const shown = scope === "spam" ? spam : page;
    const loading =
      scope === "spam"
        ? spam === null || spam.kind === "loading"
        : page.kind === "loading" || replies === null;
    const drafts = waitingMailDrafts(replies ?? [], accountId);
    if (awaitsReconnect(accounts, accountId))
      return (
        <section className="mail-view" aria-labelledby="mail-view-title">
          {this.renderViewHead(scope)}
          {this.renderReconnect()}
        </section>
      );
    return (
      <section className="mail-view" aria-labelledby="mail-view-title">
        {this.renderViewHead(scope)}
        {scope === "all" &&
        organization !== null &&
        organization.rules.rules.length > 0
          ? this.renderViews(organization)
          : null}
        <div className="mail-list-bar">
          <div className="mail-inbox-status" role="status">
            {loading
              ? "Loading messages…"
              : shown?.kind === "ready"
                ? `${shown.value.messages.length} ${shown.value.messages.length === 1 ? "message" : "messages"} ${scope === "spam" ? "in Spam " : ""}on this page`
                : null}
          </div>
          {shown?.kind === "ready" ? (
            <div className="mail-inbox-pagination">
              <button
                type="button"
                className="mail-icon-button"
                aria-label="First page"
                title="First page"
                onClick={scope === "spam" ? this.firstSpamPage : this.firstPage}
              >
                <ChevronsLeft size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="mail-icon-button"
                aria-label="Next page"
                title="Next page"
                onClick={scope === "spam" ? this.nextSpamPage : this.next}
                disabled={shown.value.nextCursor === null}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
        {shown?.kind === "failed" ? (
          <div className="mail-inbox-empty-state">
            <p role="alert">{shown.message}</p>
            <button
              type="button"
              onClick={scope === "spam" ? this.firstSpamPage : this.firstPage}
            >
              Try again
            </button>
          </div>
        ) : null}
        {loading ? null : scope === "spam" ? (
          renderSpam(
            spam,
            mailboxAddress(accounts.value, accountId ?? "", this.state.agent),
          )
        ) : page.kind === "ready" ? (
          page.value.messages.length === 0 ? (
            <div className="mail-inbox-empty-state">
              <h3>No messages match this view</h3>
              <p className="mail-inbox-note">
                {page.value.nextCursor === null
                  ? "Try another search or another view."
                  : "No available messages on this page. Continue to the next page."}
              </p>
            </div>
          ) : (
            <ul className="mail-inbox-messages" aria-label="Email messages">
              {page.value.messages.map(this.renderMessage.bind(this, drafts))}
            </ul>
          )
        ) : null}
      </section>
    );
  }

  /** The views of the rules: all mail, important mail and each category. */
  private renderViewHead(scope: "all" | "spam"): React.ReactNode {
    return (
      <div className="mail-view-head">
        <h2 id="mail-view-title" tabIndex={-1} ref={this.viewHeading}>
          {scope === "spam"
            ? "Spam"
            : this.state.query === ""
              ? "All mail"
              : "Search results"}
        </h2>
        <button
          type="button"
          className="mail-icon-button"
          aria-label="Close this view"
          title="Close this view"
          onClick={this.closeView}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    );
  }

  /** Google refused the open mailbox's sign-in. */
  private renderReconnect(): React.ReactNode {
    const { accounts, accountId } = this.state;
    return (
      <MailboxReconnect
        address={
          accounts.kind === "ready"
            ? mailboxAddress(accounts.value, accountId ?? "", this.state.agent)
            : "This mailbox"
        }
        canManage={this.props.canManage}
        integrationsPath={this.props.integrationsPath}
      />
    );
  }

  private renderViews(organization: MailOrganizationView): React.ReactNode {
    const page = this.state.page;
    return (
      <div className="mail-nav-views">
        <div className="mail-nav-group" role="group" aria-label="Inbox views">
          <button
            type="button"
            className="mail-nav-item"
            data-filter="all"
            aria-pressed={this.state.filter.kind === "all"}
            disabled={page.kind === "loading"}
            onClick={this.selectFilter}
          >
            <span className="mail-nav-label">All</span>
          </button>
          <button
            type="button"
            className="mail-nav-item"
            data-filter="important"
            aria-pressed={this.state.filter.kind === "important"}
            disabled={page.kind === "loading"}
            onClick={this.selectFilter}
          >
            <span className="mail-nav-label">Important</span>
          </button>
          {organization.rules.rules.map(this.renderCategoryFilter)}
        </div>
        <div className="mail-inbox-coverage">
          <p role="status" className="mail-inbox-note">
            {coverageStatus(this.state.processing)}
          </p>
        </div>
      </div>
    );
  }

  /** The open conversation, in the pane beside the list. */
  private renderCase(
    thread: Exclude<Thread, Readonly<{ kind: "closed" }>>,
    navigation: React.ComponentProps<typeof MailCase>["navigation"],
  ): React.ReactNode {
    const { accounts, accountId, page, replies } = this.state;
    if (accounts.kind !== "ready" || accountId === null) return null;
    const drafts = waitingMailDrafts(replies ?? [], accountId).filter(
      (draft) => !this.state.decided.has(draft.proposalId),
    );
    return (
      <MailCase
        navigation={navigation}
        organisationId={this.props.organisationId}
        accountId={accountId}
        thread={thread}
        title={caseTitle(thread, page, drafts)}
        mailboxAddresses={mailboxAddresses(
          accounts.value,
          accountId,
          this.state.agent,
        )}
        draftExpected={mailThreadHasDraft(drafts, thread.threadId)}
        canManage={this.props.canManage}
        supplierHref={this.props.supplierHref}
        orderHref={this.props.orderHref}
        memoryHref={this.props.memoryHref}
        suppliersPath={this.props.suppliersPath}
        heading={this.heading}
        onReviewChanged={this.reviewChanged}
        onDecided={this.draftDecided}
        onPersonReplied={this.personReplied}
        onJev={this.openJev}
      >
        {thread.kind === "ready"
          ? this.renderClassifications(
              thread.messages,
              mailProcessingView(this.state.processing),
            )
          : null}
      </MailCase>
    );
  }

  /** JEV: the assistant and the rules. The rules also supply the results. */
  private renderJev(): React.ReactNode {
    const { accountId, page, thread } = this.state;
    const organization = mailProcessingView(this.state.processing);
    return (
      <aside
        id="mail-jev-panel"
        className="mail-jev-panel"
        hidden={this.state.panel === "closed"}
        aria-labelledby="mail-jev-title"
        onKeyDown={this.panelKeyDown}
      >
        <div className="mail-inbox-thread-heading">
          <h2 id="mail-jev-title" ref={this.jevHeading} tabIndex={-1}>
            JEV
          </h2>
          <button
            type="button"
            className="mail-icon-button"
            aria-label="Close JEV"
            onClick={this.closeJev}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {thread.kind === "ready" ? (
          <p className="mail-jev-context">
            {thread.messages[0]?.subject || "Selected conversation"}
          </p>
        ) : null}
        {accountId !== null &&
        page.kind === "ready" &&
        this.state.panel === "jev" ? (
          <MailAssistantPanel
            key={`${accountId}:${thread.kind === "closed" ? "closed" : thread.threadId}:${organization?.rules.revision ?? 0}`}
            organisationId={this.props.organisationId}
            accountId={accountId}
            canManage={this.props.canManage}
            decision={
              this.state.decision.kind === "ready"
                ? this.state.decision.value
                : null
            }
            revision={organization?.rules.revision ?? 0}
            onRule={this.assistantRule}
          />
        ) : null}
        {/* Rule reads also supply classifications while JEV is closed. */}
        {accountId !== null ? (
          <MailOrganizationPanel
            ref={this.organizationPanel}
            key={accountId}
            organisationId={this.props.organisationId}
            accountId={accountId}
            canManage={this.props.canManage}
            messages={page.kind === "ready" ? page.value.messages : []}
            classificationMessageIds={classificationIds(page, thread)}
            onChange={this.processingChanged}
          />
        ) : null}
      </aside>
    );
  }

  /** One line, as in Gmail: sender, then subject with its marks, then date. */
  private renderMessage = (
    drafts: readonly EmailReplyQueueItem[],
    message: MailInboxMessage,
  ): React.ReactNode => {
    const waits = mailThreadHasDraft(drafts, message.threadId);
    const label = classificationLabel(
      message,
      mailProcessingView(this.state.processing),
    );
    const thread = this.state.thread;
    return (
      <li key={message.messageId}>
        <button
          type="button"
          className="mail-inbox-row"
          aria-current={
            thread.kind !== "closed" && thread.threadId === message.threadId
              ? "true"
              : undefined
          }
          data-unread={message.unread}
          data-thread-id={message.threadId}
          onClick={this.openThread.bind(this, message.threadId)}
        >
          <span className="mail-inbox-sender" title={message.from}>
            {/* Heavier text shows unread mail. A screen reader needs the word. */}
            {message.unread ? (
              <span className="visually-hidden">Unread: </span>
            ) : null}
            {mailMessageSender(message)}
          </span>
          <span className="mail-inbox-row-main">
            <span className="mail-inbox-subject">
              {mailMessageSubject(message)}
            </span>
            {label === null ? null : (
              <span className="mail-inbox-label">{label}</span>
            )}
          </span>
          <span className="mail-inbox-row-end">
            {waits ? (
              <span className="mail-inbox-kind">Reply waits</span>
            ) : null}
            <time dateTime={mailMessageReceived(message)}>
              {formatListDate(message.receivedAt)}
            </time>
          </span>
        </button>
      </li>
    );
  };
}

/** The address names a conversation by its draft, or by its Gmail thread. */
/** A source that could not load names itself and can read again. */
/**
 * Google refused the mailbox's sign-in, so Café reads none of its mail. A
 * person who manages the workspace gets the way to reconnect it.
 */
function MailboxReconnect(
  props: Readonly<{
    address: string;
    canManage: boolean;
    integrationsPath: string;
  }>,
): React.ReactNode {
  return (
    <div className="mail-agent-strip" data-tone="danger">
      <p role="alert">
        Google refused the Gmail sign-in for {props.address}. Purin Pantry
        cannot read this mailbox until it is connected again. Your mail stays in
        Gmail.
      </p>
      {props.canManage ? (
        <a href={`${props.integrationsPath}?integration=gmail`}>
          Reconnect Gmail
        </a>
      ) : (
        <p>Ask an owner or an admin of this workspace to reconnect Gmail.</p>
      )}
    </div>
  );
}

/** True when Google refused the sign-in of the mailbox that `accountId` names. */
function awaitsReconnect(
  accounts: Load<readonly MailInboxAccount[]>,
  accountId: string | null,
): boolean {
  if (accounts.kind !== "ready" || accountId === null) return false;
  for (const account of accounts.value)
    if (account.integrationAccountId === accountId)
      return account.access === "reconnect_required";
  return false;
}

function awaitingReconnect(
  accountId: string,
  account: MailInboxAccount,
): MailInboxAccount {
  return account.integrationAccountId === accountId
    ? { ...account, access: "reconnect_required" }
    : account;
}

function SourceFailed(
  props: Readonly<{ text: string; onRetry: () => Promise<void> | void }>,
): React.ReactNode {
  return (
    <div className="mail-agent-strip" data-tone="danger">
      <p role="alert">{props.text}</p>
      <button type="button" onClick={() => void props.onRetry()}>
        Try again
      </button>
    </div>
  );
}

function hasCaseId(
  caseId: string,
  conversation: InboxWhatsAppConversation,
): boolean {
  return conversation.caseId === caseId;
}

function readSelection(): Selection | null {
  const params = new URLSearchParams(window.location.search);
  const caseId = params.get("case");
  if (caseId !== null && caseId !== "") return { kind: "case", id: caseId };
  const proposal = params.get("proposal");
  if (proposal !== null && proposal !== "")
    return { kind: "proposal", id: proposal };
  const thread = params.get("thread");
  if (thread !== null && thread !== "") return { kind: "thread", id: thread };
  return null;
}

/** "3 decisions need you. The oldest has waited 2 days." */
function summaryLine(
  items: readonly MailDraftItem[],
  whatsapp: readonly InboxWhatsAppConversation[],
  unanswered: readonly InboxUnansweredThread[],
  replies: readonly EmailReplyQueueItem[] | null,
  canManage: boolean,
): string {
  if (replies === null) return "Reading what needs you…";
  const count = items.length + whatsapp.length + unanswered.length;
  if (count === 0) return "No decisions wait for you.";
  if (!canManage)
    return count === 1
      ? "1 reply draft waits for approval."
      : `${count} reply drafts wait for approval.`;
  let oldest = Date.now();
  for (const item of items) oldest = Math.min(oldest, item.since);
  for (const conversation of whatsapp)
    oldest = Math.min(oldest, conversation.waitingSince);
  for (const thread of unanswered) oldest = Math.min(oldest, thread.receivedAt);
  const waited = formatWaited(Date.now() - oldest);
  return count === 1
    ? `1 decision needs you. It has waited ${waited}.`
    : `${count} decisions need you. The oldest has waited ${waited}.`;
}

function receiptText(
  decision: MailDraftDecision,
  sender: string | null,
): string {
  switch (decision.outcome) {
    case "sent":
      return sender === null ? "Reply sent." : `Reply sent to ${sender}.`;
    case "approved":
      return sender === null
        ? "Reply approved."
        : `Reply to ${sender} approved.`;
    case "rejected":
      return sender === null
        ? "Draft rejected."
        : `Draft for ${sender} rejected.`;
    default:
      return assertNever(decision.outcome);
  }
}

/** The person who waited longest comes first. */
function longestWaitFirst(left: MailDraftItem, right: MailDraftItem): number {
  return left.since - right.since;
}

/**
 * The subject heads the case. Until the thread is read, the queue or the row
 * that opened it names it.
 */
function caseTitle(
  thread: Thread,
  page: Load<Page>,
  drafts: readonly EmailReplyQueueItem[],
): string {
  if (thread.kind === "ready" && thread.messages[0] !== undefined)
    return thread.messages[0].subject || "No subject";
  if (thread.kind === "closed") return "Conversation";
  for (const draft of drafts)
    if (draft.gmailThreadId === thread.threadId && draft.headline !== null)
      return draft.headline.subject || "No subject";
  if (page.kind === "ready")
    for (const message of page.value.messages)
      if (message.threadId === thread.threadId)
        return message.subject || "No subject";
  return "Conversation";
}

/**
 * Gmail's Spam, listed only. The agent reads none of it, so a row opens the
 * message in Gmail, where the person can mark it as not spam.
 */
function renderSpam(spam: Load<Page> | null, address: string): React.ReactNode {
  if (spam?.kind !== "ready") return null;
  return (
    <>
      <p className="mail-spam-note">
        The agent does not read Spam. Open a message in Gmail and mark it “Not
        spam”: the agent then answers it, if it arrived in the last 3 days.
      </p>
      {spam.value.messages.length === 0 ? (
        <div className="mail-inbox-empty-state">
          <h3>No spam</h3>
          <p className="mail-inbox-note">
            {spam.value.nextCursor === null
              ? "Gmail holds no spam for this mailbox."
              : "No spam on this page. Continue to the next page."}
          </p>
        </div>
      ) : (
        <ul className="mail-inbox-messages" aria-label="Spam messages">
          {spam.value.messages.map(renderSpamMessage.bind(null, address))}
        </ul>
      )}
    </>
  );
}

function renderSpamMessage(
  address: string,
  message: MailInboxMessage,
): React.ReactNode {
  return (
    <li key={message.messageId}>
      <a
        className="mail-inbox-row mail-spam-row"
        href={gmailSpamLink(address, message.threadId)}
        target="_blank"
        rel="noreferrer"
        data-unread={message.unread}
      >
        <span className="mail-inbox-sender" title={message.from}>
          {message.unread ? (
            <span className="visually-hidden">Unread: </span>
          ) : null}
          {mailMessageSender(message)}
        </span>
        <span className="mail-inbox-row-main">
          <span className="mail-inbox-subject">
            {mailMessageSubject(message)}
          </span>
        </span>
        <time dateTime={mailMessageReceived(message)}>
          {formatListDate(message.receivedAt)}
        </time>
        <span className="visually-hidden">, opens in Gmail</span>
        <ExternalLink className="mail-spam-open" size={16} aria-hidden="true" />
      </a>
    </li>
  );
}

/** Gmail's page of one Spam thread, in the mailbox's own Google account. */
function gmailSpamLink(address: string, threadId: string): string {
  const account = address.includes("@")
    ? `?authuser=${encodeURIComponent(address)}`
    : "";
  return `https://mail.google.com/mail/${account}#spam/${encodeURIComponent(threadId)}`;
}

function mailMessageSubject(message: MailInboxMessage): string {
  return message.subject || "No subject";
}

/** A list row names the sender as Gmail does: the name, not the address. */
function mailMessageSender(message: MailInboxMessage): string {
  return senderParts(message.from).name;
}

function mailMessageReceived(message: MailInboxMessage): string {
  return new Date(message.receivedAt).toISOString();
}

function messageForError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Mail could not be loaded. Try again.";
}

function classifiesOneOf(
  messages: readonly MailInboxThreadMessage[],
  result: import("@purin-labs/control-api").MailClassification,
): boolean {
  for (const message of messages)
    if (message.messageId === result.messageId) return true;
  return false;
}

/** One mailbox's settings page, in place of the Inbox's list. */
function mailboxSettingsHref(accountId: string): string {
  return `${window.location.pathname}?settings=${encodeURIComponent(accountId)}`;
}

/** The Inbox's list, the settings page's way back. */
function inboxHref(): string {
  return window.location.pathname;
}

function readSettings(): string | null {
  const settings = new URLSearchParams(window.location.search).get("settings");
  return settings === null || settings === "" ? null : settings;
}

/** The draft reads after a check, counted from the agent's evaluation. */
const MAIL_CHECK_READS_MS = [30_000, 90_000] as const;
/** How long the time of the check stays in the bar. */
const MAIL_CHECK_SHOWN_MS = 90_000;

/** The mailbox's address: the agent's when known, else the account's name. */
function mailboxAddress(
  accounts: readonly MailInboxAccount[],
  accountId: string,
  agent: MailAgentState | null,
): string {
  if (agent !== null) return agent.address;
  for (const account of accounts)
    if (account.integrationAccountId === accountId) return account.displayName;
  return "This mailbox";
}

/** The addresses that the selected mailbox sends from, as far as known. */
function mailboxAddresses(
  accounts: readonly MailInboxAccount[],
  accountId: string,
  agent: MailAgentState | null,
): readonly string[] {
  const addresses: string[] = [];
  if (agent !== null) addresses.push(agent.address);
  // A connected Gmail mailbox is named by its address.
  for (const account of accounts)
    if (
      account.integrationAccountId === accountId &&
      account.displayName.includes("@")
    )
      addresses.push(account.displayName);
  return addresses;
}

function classificationIds(
  page: Load<Page>,
  thread: Thread,
): readonly string[] {
  const ids: string[] = [];
  if (page.kind === "ready")
    for (const message of page.value.messages) ids.push(message.messageId);
  if (thread.kind === "ready")
    for (const message of thread.messages)
      if (!ids.includes(message.messageId)) ids.push(message.messageId);
  return ids;
}

function renderDecision(
  decision: InboxState["decision"],
  thread: Thread,
): React.ReactNode {
  if (decision.kind === "closed") return null;
  if (decision.kind === "loading")
    return <p role="status">Checking classification evidence…</p>;
  if (decision.kind === "failed") return <p role="alert">{decision.message}</p>;
  const result = decision.value;
  let subject = "No subject";
  if (thread.kind === "ready")
    for (const message of thread.messages)
      if (message.messageId === result.classification.messageId)
        subject = message.subject || "No subject";
  return (
    <section className="mail-decision" aria-label="Decision details">
      <h5>{mailRuleLabel(result.rule)}</h5>
      <p>{subject}</p>
      <p>
        <strong>Criterion:</strong> {result.rule.instruction}
      </p>
      <p>
        {result.classification.source === "operator"
          ? "Your correction"
          : "JEV result"}
        : {result.classification.outcome.replaceAll("_", " ")}
        {" · "}
        {formatMailDate(result.classification.evaluatedAt)}
      </p>
      <p role="status">
        {result.evidence === "current"
          ? "Email matches the evidence used for classification."
          : "Email changed since classification. This result may be out of date."}
      </p>
      <p className="mail-inbox-note">
        Decision details show the saved result and criterion. JEV does not
        return a written rationale.
      </p>
    </section>
  );
}

function correctionAffectsFilter(
  filter: InboxFilter,
  view: MailOrganizationView,
  ruleId: string,
): boolean {
  if (filter.kind === "category") return filter.ruleId === ruleId;
  if (filter.kind === "important")
    for (const rule of view.rules.rules)
      if (rule.ruleId === ruleId && rule.kind === "prioritize") return true;
  return false;
}
/** A message that the current rules did not evaluate has no label. */
function classificationLabel(
  message: MailInboxMessage,
  view: MailOrganizationView | null,
): string | null {
  if (view === null || view.rules.kind === "empty") return null;
  const labels: string[] = [];
  let classified = false;
  for (const result of view.classifications) {
    if (result.messageId !== message.messageId) continue;
    classified = true;
    if (result.outcome === "needs_review" && !labels.includes("Needs review"))
      labels.push("Needs review");
    if (result.outcome !== "matched") continue;
    for (const rule of view.rules.rules)
      if (rule.ruleId === result.ruleId) labels.push(mailRuleLabel(rule));
  }
  if (!classified) return null;
  return labels.length === 0 ? "Classified" : labels.join(" · ");
}

function coverageStatus(processing: MailProcessingState): string {
  if (processing.kind === "unavailable")
    return "JEV status unavailable. Refresh the Inbox to retry.";
  const view = mailProcessingView(processing);
  if (view === null) return "Checking JEV availability…";
  switch (view.readiness) {
    case "eligibility_required":
      return "JEV needs processing approval. Open JEV for details.";
    case "typesafe_unavailable":
      return "Classification unavailable. Connect TypeSafe in Integrations.";
    case "history_expired":
      return "Gmail history expired. Review coverage in JEV before resuming.";
    case "ready":
      break;
    default:
      return assertNever(view.readiness);
  }
  if (view.rules.kind === "paused")
    return "Rules paused. Browsing is available.";
  if (view.rules.kind === "empty")
    return "Open JEV to set up categories and priorities.";
  return `${view.pending} pending · ${view.failed} unavailable · ${view.budgetPaused} waiting for budget`;
}
