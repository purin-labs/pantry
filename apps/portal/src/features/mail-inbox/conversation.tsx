import { DecisionButtons } from "@purin-labs/ui/index";
import { EMAIL_REPLY_DECISION } from "../email-review/decision-labels";
import React from "react";
import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import {
  takesNoReplies,
  type MailInboxThreadMessage,
  type MailInboxWork,
  type MailReplyAttachment,
  type MailReplyDocument,
  type MailWorkAssignment,
  type MailWorkCaseState,
  type MailWorkReply,
  type MailWorkReplyState,
} from "@purin-labs/control-api";
import { formatAbsoluteTime } from "@purin-labs/ui/formatting";
import { emailReplyIsOpenable, emailReplyLifecycleLabel } from "../../pages/agent-mailbox";
import type { EmailReplyPreviewResult } from "@purin-labs/control-api/portal/agent-mailbox";
import {
  createEmailReviewActions,
  EmailReplyDraftStaleError,
  readEmailReplyPreview,
} from "../email-review/api";
import { ReplyDraftEditor } from "./reply-draft-editor";
import { MailDraftBody, MailDraftSources } from "./draft-sources";
import {
  ClaimSummary,
  ClaimTrace,
  draftClaims,
  focusNumber,
  relocateSources,
  type ClaimFocus,
  type DraftClaim,
} from "./claim-trace";
import { readMailInbox, sendMailPersonReply } from "./api";
import { MailRelationshipCorrection } from "./relationship";
import { MailSenderSupplier } from "./sender-supplier";
import { Reply } from "lucide-react";
import { MailReplyComposer } from "./reply-composer";
import {
  conversationSender,
  MailThreadMessages,
  senderParts,
  type MailThreadDraft,
} from "./thread";

type Load<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; value: T }>;
type LinkedWork = Variant<MailInboxWork, "linked">;
type CurrentDraft = Variant<EmailReplyPreviewResult, "current">;
/** The reply draft that waits in this thread, as Gmail holds it now. */
type Draft =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loading"; proposalId: string }>
  | Readonly<{ kind: "failed"; proposalId: string; message: string }>
  | Readonly<{
      kind: "ready";
      proposalId: string;
      result: EmailReplyPreviewResult;
    }>
  | Readonly<{ kind: "editing"; proposalId: string; result: CurrentDraft }>;
type Change = "approve" | "edit" | "reject" | "resolve" | "correct";
type Mutation =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running"; change: Change }>
  /** `stale`: Gmail holds a newer version than the shared draft started from. */
  | Readonly<{ kind: "failed"; message: string; stale: boolean }>;
/** A decision that ended the draft that waited. */
export type MailDraftDecision = Readonly<{
  proposalId: string;
  outcome: "sent" | "approved" | "rejected";
}>;
type Props = Readonly<{
  organisationId: string;
  accountId: string;
  threadId: string;
  messages: readonly MailInboxThreadMessage[];
  /** The addresses that the mailbox sends from. */
  mailboxAddresses: readonly string[];
  /** The Inbox already knows that a draft waits in this thread. */
  draftExpected: boolean;
  canManage: boolean;
  supplierHref: (supplierId: string) => string;
  orderHref: (orderId: string) => string;
  /** The Brain page with one Memory open. */
  memoryHref: (memoryId: string) => string;
  /** The Suppliers page. */
  suppliersPath: string;
  /** Resolves when the Inbox shows the thread as Gmail holds it now. */
  onReviewChanged: () => Promise<void>;
  /**
   * The person approved or rejected the draft, and its new state is read. A
   * send that Gmail did not confirm is not a decision: its card stays.
   */
  onDecided: (decision: MailDraftDecision) => void;
  /** A person wrote a reply, and Gmail holds it. */
  onPersonReplied?: (threadId: string) => void;
  /** More content for the details, after the conversation's own. */
  children?: React.ReactNode;
}>;
type State = Readonly<{
  /** What the person writes when no draft waits. */
  personReply: string;
  personSend: "idle" | "sending" | "unconfirmed" | "failed";
  /** The reply takes the whole pane while the person writes it. */
  personReplyOpen: boolean;
  personReplyExpanded: boolean;
  work: Load<MailInboxWork>;
  draft: Draft;
  mutation: Mutation;
  correcting: boolean;
  /** The last change that the person made. Its result shows one time. */
  settled: Readonly<{ proposalId: string; change: Change }> | null;
  /** The source whose words are marked in the draft. */
  activeSource: number | null;
  /** Whether the Sources fold is open. Source numbers show then. */
  /** Whether the claims of the draft show beside their records. */
  traceOpen: boolean;
  /** The claim or the record that the person points at in the trace. */
  claimFocus: ClaimFocus | null;
  /** The shared draft's text while the person edits it. */
  editorBody: string | null;
}>;

/**
 * One open conversation: its messages, the suggested reply that waits with
 * its actions, what the agent checked, and one closed Sources disclosure with
 * the cited records and the other work on the thread.
 */
export class MailConversation extends React.Component<Props, State> {
  state: State = {
    personReply: "",
    personSend: "idle",
    // The reply stands open under the mail until the person closes it.
    personReplyOpen: true,
    personReplyExpanded: false,
    work: { kind: "loading" },
    draft: { kind: "none" },
    mutation: { kind: "idle" },
    correcting: false,
    settled: null,
    activeSource: null,
    traceOpen: false,
    claimFocus: null,
    editorBody: null,
  };
  private actions = createEmailReviewActions(this.props.organisationId);
  private request: AbortController | null = null;
  private root = React.createRef<HTMLDivElement>();
  private scroller = React.createRef<HTMLDivElement>();
  private replyEditor = React.createRef<ReplyDraftEditor>();
  private editButton = React.createRef<HTMLButtonElement>();
  private correctionButton = React.createRef<HTMLButtonElement>();
  private disposed = false;
  /** True from a reply send's first step until it ends; state lags a render. */
  private personSending = false;
  /**
   * The idempotency key of the reply that the person tries to send, kept in
   * memory until a send is answered. A changed reply takes a new key.
   */
  private personSendAttempt: Readonly<{
    key: string;
    text: string;
    document: string;
    attachments: readonly MailReplyAttachment[];
  }> | null = null;

  componentDidMount(): void {
    this.disposed = false;
    this.showNewestMessage();
    void this.loadWork();
  }
  componentDidUpdate(_props: Props, previous: State): void {
    // The reply box takes room when the draft arrives.
    if (previous.draft.kind !== this.state.draft.kind) this.showNewestMessage();
  }
  componentWillUnmount(): void {
    this.disposed = true;
    this.request?.abort();
    this.composerObserver?.disconnect();
  }

  private composerObserver: ResizeObserver | null = null;

  /**
   * The person's reply floats over the foot of the messages, so the mail
   * scrolls under it. The messages keep `--mail-reply-room` free at their
   * foot, so the last line can scroll clear of the reply.
   */
  private observeComposer = (composer: HTMLDivElement | null): void => {
    this.composerObserver?.disconnect();
    this.composerObserver = null;
    // The parent is the root; its ref is not set yet on the first mount.
    const root = composer?.parentElement ?? this.root.current;
    if (composer === null || typeof ResizeObserver === "undefined") {
      root?.style.removeProperty("--mail-reply-room");
      return;
    }
    const publish = (): void => {
      root?.style.setProperty(
        "--mail-reply-room",
        `${composer.getBoundingClientRect().height}px`,
      );
    };
    this.composerObserver = new ResizeObserver(publish);
    this.composerObserver.observe(composer);
    publish();
  };

  /** Opens at the foot, or at the newest message if it is too tall to fit. */
  private showNewestMessage(): void {
    const scroller = this.scroller.current;
    if (scroller === null) return;
    const messages = scroller.querySelectorAll<HTMLElement>(
      ".mail-inbox-message, .mail-inbox-own",
    );
    const newest = messages.item(messages.length - 1);
    const foot = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop =
      newest === null ? foot : Math.min(newest.offsetTop, foot);
  }

  /**
   * Reads the work, then the draft that waits. A newer read replaces it. The
   * work read is returned, or null when the read failed or was replaced.
   */
  private loadWork = async (): Promise<MailInboxWork | null> => {
    if (this.disposed) return null;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.setState({
      work: { kind: "loading" },
      draft: { kind: "none" },
      correcting: false,
    });
    let work: MailInboxWork;
    try {
      const result = await readMailInbox(
        this.props.organisationId,
        {
          kind: "work",
          integrationAccountId: this.props.accountId,
          threadId: this.props.threadId,
        },
        request.signal,
      );
      if (request.signal.aborted) return null;
      if (result.kind !== "work" || result.threadId !== this.props.threadId)
        throw new Error("Conversation work returned an unexpected response.");
      work = result.work;
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({ work: { kind: "failed", message: workError(error) } });
      return null;
    }
    const waiting = waitingReply(work);
    if (waiting === null) {
      this.setState({ work: { kind: "ready", value: work } });
      return work;
    }
    const proposalId = waiting.proposalId;
    this.setState({
      work: { kind: "ready", value: work },
      draft: { kind: "loading", proposalId },
    });
    let draft: Draft;
    try {
      const result = await readEmailReplyPreview(
        this.props.organisationId,
        proposalId,
        request.signal,
      );
      if (
        result.kind === "current" &&
        result.proposal.gmailThreadId !== this.props.threadId
      )
        throw new Error(
          "This reply belongs to a different conversation. Refresh conversation work.",
        );
      draft = { kind: "ready", proposalId, result };
    } catch (error) {
      draft = { kind: "failed", proposalId, message: reviewProblem(error) };
    }
    if (request.signal.aborted) return null;
    this.setState({ draft });
    // A draft that Gmail no longer holds leaves the Inbox's list as well.
    if (draft.kind === "ready" && draft.result.kind !== "current")
      void this.props.onReviewChanged();
    return work;
  };

  /** Reads the thread's work again. The conversation's menu offers it. */
  refresh(): void {
    void this.refreshWork();
  }

  private refreshWork = async (): Promise<void> => {
    this.setState({ mutation: { kind: "idle" }, settled: null });
    await this.loadWork();
  };

  private retry = async (): Promise<void> => {
    await this.loadWork();
    if (!this.disposed) this.setState({ settled: null }, this.focusOutcome);
  };

  /**
   * A decision or a saved draft changes the thread in Gmail and what waits in
   * the Inbox. The thread is read again first, so that the new draft does not
   * show beside its old text. Focus goes to the result when the page shows it.
   */
  private reviewChanged = async (
    settled: State["settled"],
  ): Promise<MailInboxWork | null> => {
    this.request?.abort();
    this.setState({
      work: { kind: "loading" },
      draft: { kind: "none" },
      correcting: false,
      settled: null,
    });
    await this.props.onReviewChanged();
    const work = await this.loadWork();
    if (!this.disposed) this.setState({ settled }, this.focusOutcome);
    return work;
  };

  /** A failed change also reads the draft again: its state can be new. */
  private change = async (
    change: Change,
    proposalId: string,
    run: () => Promise<void>,
  ): Promise<void> => {
    if (this.state.mutation.kind === "running") return;
    this.setState({ mutation: { kind: "running", change }, settled: null });
    let mutation: Mutation = { kind: "idle" };
    try {
      await run();
    } catch (error) {
      mutation = {
        kind: "failed",
        message: reviewProblem(error),
        stale: error instanceof EmailReplyDraftStaleError,
      };
    }
    if (this.disposed) return;
    this.setState({ mutation });
    const work = await this.reviewChanged(
      mutation.kind === "idle" ? { proposalId, change } : null,
    );
    if (mutation.kind === "idle" && work !== null && !this.disposed)
      this.reportDecision(work, proposalId, change);
  };

  private reportDecision(
    work: MailInboxWork,
    proposalId: string,
    change: Change,
  ): void {
    if (change !== "approve" && change !== "reject") return;
    if (work.kind !== "linked") return;
    for (const reply of work.replies) {
      if (reply.proposalId !== proposalId) continue;
      const outcome = reply.state.kind;
      if (
        outcome === "sent" ||
        outcome === "approved" ||
        outcome === "rejected"
      )
        this.props.onDecided({ proposalId, outcome });
      return;
    }
  }

  private approve = async (): Promise<void> => {
    const draft = this.state.draft;
    if (draft.kind !== "ready" || draft.result.kind !== "current") return;
    const { proposal, challenge } = draft.result;
    await this.change(
      "approve",
      draft.proposalId,
      this.actions.approveEmailReply.bind(null, proposal.proposalId, {
        version: proposal.version,
        snapshotDigest: proposal.snapshotDigest,
        challenge,
      }),
    );
  };

  private reject = async (): Promise<void> => {
    const draft = this.state.draft;
    if (draft.kind !== "ready" || draft.result.kind !== "current") return;
    await this.change(
      "reject",
      draft.proposalId,
      this.actions.rejectEmailReply.bind(null, draft.proposalId),
    );
  };

  /** Plan 40D: saves the shared draft as the next Gmail version. */
  private saveSharedDraft = async (): Promise<void> => {
    const draft = this.state.draft;
    if (draft.kind !== "editing") return;
    if (this.replyEditor.current?.hasUnsyncedEdits() === true) {
      this.setState({
        mutation: {
          kind: "failed",
          message: "Your last change is still syncing. Save again in a moment.",
          stale: false,
        },
      });
      return;
    }
    await this.change(
      "edit",
      draft.proposalId,
      this.actions.saveEmailReplyDraft.bind(null, draft.proposalId),
    );
  };

  /** Drops the shared draft's unsaved text and loads the Gmail version. */
  private reloadSharedDraft = async (): Promise<void> => {
    const draft = this.state.draft;
    if (draft.kind !== "editing" && draft.kind !== "ready") return;
    await this.change(
      "edit",
      draft.proposalId,
      this.actions.reloadEmailReplyDraft.bind(null, draft.proposalId),
    );
  };

  private sharedDraftClosed = (): void => {
    void this.refreshWork();
  };

  private resolve = async (reply: MailWorkReply): Promise<void> => {
    await this.change(
      "resolve",
      reply.proposalId,
      this.actions.resolveEmailReply.bind(
        null,
        reply.proposalId,
        reply.version,
      ),
    );
  };

  private startEdit = (): void => {
    this.openEditor(this.focusEditor);
  };
  private openEditor(opened: () => void): void {
    const draft = this.state.draft;
    if (draft.kind !== "ready" || draft.result.kind !== "current") return;
    this.setState(
      {
        draft: {
          kind: "editing",
          proposalId: draft.proposalId,
          result: draft.result,
        },
        editorBody: null,
        claimFocus: null,
      },
      opened,
    );
  }

  /** Selects the words of a claim with no source in the shared draft. */
  private editClaim = (claim: DraftClaim): void => {
    const select = (): void => {
      this.replyEditor.current?.selectText(claim.text);
    };
    if (this.state.draft.kind === "editing") select();
    else this.openEditor(select);
  };
  private editorBodyChanged = (editorBody: string): void => {
    this.setState({ editorBody });
  };
  private traceToggled = (): void => {
    this.setState((state) => ({
      traceOpen: !state.traceOpen,
      claimFocus: null,
    }));
  };
  private claimFocused = (claimFocus: ClaimFocus | null): void => {
    this.setState({ claimFocus });
  };
  private cancelEdit = (): void => {
    const draft = this.state.draft;
    if (draft.kind !== "editing") return;
    this.setState(
      {
        draft: {
          kind: "ready",
          proposalId: draft.proposalId,
          result: draft.result,
        },
      },
      this.focusEditButton,
    );
  };
  private startCorrection = (): void => {
    this.setState({ correcting: true });
  };
  private closeCorrection = (): void => {
    this.setState({ correcting: false }, this.focusCorrectionButton);
  };
  private correctionChanged = async (proposalId: string): Promise<void> => {
    this.setState({ mutation: { kind: "idle" } });
    await this.reviewChanged({ proposalId, change: "correct" });
  };

  private focusEditor = (): void => {
    this.replyEditor.current?.focus();
  };
  private focusEditButton = (): void => {
    this.editButton.current?.focus();
  };
  private focusCorrectionButton = (): void => {
    this.correctionButton.current?.focus();
  };
  // The control that the person used can be gone. Focus goes to the result,
  // else to the title.
  private focusOutcome = (): void => {
    const outcome = this.root.current?.querySelector<HTMLElement>(
      "[data-mail-outcome]",
    );
    outcome?.focus();
    if (outcome == null || document.activeElement !== outcome)
      document.getElementById("mail-case-title")?.focus();
  };

  private threadDraft(): MailThreadDraft {
    const { work, draft } = this.state;
    switch (draft.kind) {
      case "none":
        return work.kind === "loading" && this.props.draftExpected
          ? { kind: "unread" }
          : { kind: "none" };
      case "loading":
      case "failed":
        return { kind: "unread" };
      case "ready":
        return draft.result.kind === "current"
          ? { kind: "read", body: draft.result.proposal.body }
          : { kind: "none" };
      case "editing":
        return { kind: "read", body: draft.result.proposal.body };
      default:
        return assertNever(draft);
    }
  }

  private renderSettled(work: LinkedWork | null): React.ReactNode {
    const settled = this.state.settled;
    if (settled === null || work === null) return null;
    for (const reply of work.replies) {
      if (reply.proposalId !== settled.proposalId) continue;
      const notice = settledNotice(reply.state);
      return notice === null ? null : (
        <p className="mail-conversation-notice" data-mail-outcome tabIndex={-1}>
          {notice}
        </p>
      );
    }
    return null;
  }

  private renderUnconfirmed = (reply: MailWorkReply): React.ReactNode => {
    if (reply.state.kind !== "send_indeterminate") return null;
    const settled = this.state.settled;
    return (
      <section
        key={reply.proposalId}
        className="mail-draft"
        data-draft="unconfirmed"
        aria-labelledby={`mail-unconfirmed-${reply.proposalId}`}
      >
        <h3
          id={`mail-unconfirmed-${reply.proposalId}`}
          className="mail-draft-chip"
          data-mail-outcome
          tabIndex={-1}
        >
          Send not confirmed
        </h3>
        <p>
          Gmail did not confirm this send. Purin Pantry does not retry it.
          Check the exact message in Gmail first.
        </p>
        {settled?.proposalId === reply.proposalId &&
        settled.change === "resolve" ? (
          <p className="mail-inbox-note">
            Gmail does not show this reply as sent yet.
          </p>
        ) : null}
        {this.props.canManage ? (
          <button
            type="button"
            onClick={this.resolve.bind(this, reply)}
            disabled={this.state.mutation.kind === "running"}
          >
            Check send state in Gmail
          </button>
        ) : null}
      </section>
    );
  };

  private renderDraft(): React.ReactNode {
    const { work, draft, mutation } = this.state;
    if (
      draft.kind === "loading" ||
      (draft.kind === "none" &&
        work.kind === "loading" &&
        this.props.draftExpected)
    )
      return <p role="status">Fetching the current draft from Gmail…</p>;
    if (draft.kind === "none") return null;
    if (draft.kind === "failed")
      return (
        <div className="mail-conversation-problem">
          <p role="alert">{draft.message}</p>
          <button type="button" onClick={this.retry}>
            Try again
          </button>
        </div>
      );
    const result = draft.result;
    if (result.kind !== "current")
      return (
        <p className="mail-conversation-notice" data-mail-outcome tabIndex={-1}>
          {goneDraftNotice(result)}
        </p>
      );
    const proposal = result.proposal;
    // While the person edits, the claims follow the shared text.
    const body =
      draft.kind === "editing" && this.state.editorBody !== null
        ? this.state.editorBody
        : proposal.body;
    const sources = relocateSources(proposal.body, result.sources, body);
    const claims = draftClaims(body, sources);
    const focus = this.state.claimFocus;
    const traceId = `mail-claim-trace-${draft.proposalId}`;
    return (
      <section className="mail-draft" aria-labelledby="mail-draft-title">
        <h3
          id="mail-draft-title"
          className="mail-draft-title"
          data-mail-outcome
          tabIndex={-1}
        >
          Suggested reply
        </h3>
        <p className="mail-draft-to">To {proposal.to}</p>
        {draft.kind === "editing" ? (
          <ReplyDraftEditor
            ref={this.replyEditor}
            organisationId={this.props.organisationId}
            proposalId={draft.proposalId}
            disabled={mutation.kind === "running"}
            onClosed={this.sharedDraftClosed}
            onBody={this.editorBodyChanged}
          />
        ) : (
          <MailDraftBody
            body={proposal.body}
            sources={result.sources}
            active={this.state.activeSource ?? focusNumber(focus, claims)}
            showNumbers
            unsourced={claims.filter((claim) => claim.numbers.length === 0)}
            activeUnsourced={focus?.kind === "claim" ? focus.key : null}
          />
        )}
        <ClaimSummary
          claims={claims}
          open={this.state.traceOpen}
          controls={traceId}
          onToggle={this.traceToggled}
        />
        {this.state.traceOpen && claims.length > 0 ? (
          <ClaimTrace
            id={traceId}
            claims={claims}
            sources={sources}
            links={{
              orderHref: this.props.orderHref,
              supplierHref: this.props.supplierHref,
              memoryHref: this.props.memoryHref,
            }}
            focus={focus}
            onFocus={this.claimFocused}
            unsourcedAction={
              !this.props.canManage
                ? null
                : {
                    label: draft.kind === "editing" ? "Select it" : "Change it",
                    run: this.editClaim,
                  }
            }
          />
        ) : null}
        {proposal.bodyEdited || proposal.version > 1 ? (
          <p className="mail-inbox-note">You edited this draft.</p>
        ) : (
          <p className="mail-inbox-note">
            Not sent. It waits for your approval.
          </p>
        )}
      </section>
    );
  }

  /**
   * The address that a person's reply goes to, when a person can write one:
   * no draft waits or comes, and the person can manage the mailbox.
   */
  private personReplyAddress(): string | null {
    const { work, draft } = this.state;
    if (
      !this.props.canManage ||
      this.props.draftExpected ||
      work.kind !== "ready" ||
      draft.kind !== "none"
    )
      return null;
    return conversationSender(this.props.messages, this.props.mailboxAddresses);
  }

  /**
   * With no draft, a person can write the reply (Plan 83). It starts open as
   * an email composer with a formatting toolbar, and it can take the whole
   * pane. Closed, it is one Reply bar and keeps what the person wrote.
   */
  private renderPersonReply(): React.ReactNode {
    const { personReply, personSend, personReplyOpen, personReplyExpanded } =
      this.state;
    const address = this.personReplyAddress();
    if (address === null || takesNoReplies(address)) return null;
    const recipient = this.replyRecipient(address);
    const problem =
      personSend === "unconfirmed" ? (
        <p role="alert" className="mail-reply-problem">
          Gmail did not confirm this send. Purin Pantry does not retry it.
          Check the thread in Gmail.
        </p>
      ) : personSend === "failed" ? (
        <p role="alert" className="mail-reply-problem">
          The reply did not go. Try again.
        </p>
      ) : null;
    return (
      <>
        {personReplyOpen ? null : (
          <section className="mail-reply-closed" aria-label="Your reply">
            {problem}
            <button
              type="button"
              className="mail-reply-open"
              onClick={this.openPersonReply}
            >
              <Reply size={16} aria-hidden="true" />
              <span className="mail-reply-open-label">
                {personReply.trim() === ""
                  ? `Reply to ${recipient.name}`
                  : "Continue your reply"}
              </span>
              {personReply.trim() === "" ? null : (
                <span className="mail-reply-open-preview">{personReply}</span>
              )}
            </button>
          </section>
        )}
        <MailReplyComposer
          recipient={{ name: recipient.name, address }}
          subject={this.replySubject()}
          hidden={!personReplyOpen}
          sending={personSend === "sending"}
          expanded={personReplyExpanded}
          problem={personReplyOpen ? problem : null}
          onText={this.personReplyChanged}
          onToggleExpanded={this.togglePersonReplyExpanded}
          onClose={this.closePersonReply}
          onDiscard={this.discardPersonReply}
          onSend={this.sendPersonReply}
        />
      </>
    );
  }

  /** The person that the reply goes to, by name when the thread has one. */
  private replyRecipient(address: string): Readonly<{ name: string }> {
    for (let index = this.props.messages.length - 1; index >= 0; index -= 1) {
      const from = this.props.messages[index]?.from;
      if (from === undefined || !from.includes(address)) continue;
      return { name: senderParts(from).name };
    }
    return { name: address };
  }

  /** Gmail keeps the reply in the thread, under the thread's subject. */
  private replySubject(): string {
    const subject = this.props.messages[0]?.subject.trim() ?? "";
    if (subject === "") return "(no subject)";
    return /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
  }

  private openPersonReply = (): void => {
    this.setState({ personReplyOpen: true });
  };

  private closePersonReply = (): void => {
    this.setState({ personReplyOpen: false, personReplyExpanded: false });
  };

  private togglePersonReplyExpanded = (): void => {
    this.setState((state) => ({
      personReplyExpanded: !state.personReplyExpanded,
    }));
  };

  private discardPersonReply = (): void => {
    this.personSendAttempt = null;
    this.setState({
      personReply: "",
      personSend: "idle",
      personReplyOpen: false,
      personReplyExpanded: false,
    });
  };

  private personReplyChanged = (text: string): void => {
    this.setState({ personReply: text, personSend: "idle" });
  };

  private sendPersonReply = async (
    document: MailReplyDocument,
    text: string,
    attachments: readonly MailReplyAttachment[],
  ): Promise<boolean> => {
    if (text.trim() === "" || this.personSending) return false;
    this.personSending = true;
    this.setState({ personSend: "sending" });
    const key = this.personSendKey(document, text, attachments);
    try {
      const result = await sendMailPersonReply(
        this.props.organisationId,
        this.props.accountId,
        this.props.threadId,
        key,
        text,
        document,
        attachments,
      );
      if (this.personSendAttempt?.key === key) this.personSendAttempt = null;
      if (this.disposed) return true;
      this.setState({
        personSend: result === "send_indeterminate" ? "unconfirmed" : "idle",
        personReply: "",
        personReplyOpen: false,
        personReplyExpanded: false,
      });
      if (result === "send_indeterminate") return true;
      await this.props.onReviewChanged();
      this.props.onPersonReplied?.(this.props.threadId);
      return true;
    } catch {
      if (!this.disposed) this.setState({ personSend: "failed" });
      return false;
    } finally {
      this.personSending = false;
    }
  };

  /** The same reply keeps its key; a changed text or file takes a new one. */
  private personSendKey(
    document: MailReplyDocument,
    text: string,
    attachments: readonly MailReplyAttachment[],
  ): string {
    const shape = JSON.stringify(document);
    const last = this.personSendAttempt;
    if (
      last !== null &&
      last.text === text &&
      last.document === shape &&
      last.attachments.length === attachments.length &&
      last.attachments.every(
        (file, index) =>
          file.name === attachments[index]?.name &&
          file.type === attachments[index]?.type &&
          file.data === attachments[index]?.data,
      )
    )
      return last.key;
    const key = `portal-${crypto.randomUUID()}`;
    this.personSendAttempt = { key, text, document: shape, attachments };
    return key;
  }

  /**
   * The bar ends the conversation, so that it stays in view while the person
   * reads a message or works in the details.
   */
  private renderBar(): React.ReactNode {
    const { draft, mutation } = this.state;
    const editing = draft.kind === "editing";
    const actions =
      this.props.canManage &&
      (editing || (draft.kind === "ready" && draft.result.kind === "current"));
    if (!actions && mutation.kind === "idle") return null;
    const busy = mutation.kind === "running";
    return (
      <div className="mail-draft-bar">
        {mutation.kind === "failed" ? (
          <p role="alert">{mutation.message}</p>
        ) : null}
        {mutation.kind === "failed" &&
        mutation.stale &&
        this.props.canManage ? (
          <button type="button" onClick={this.reloadSharedDraft}>
            Load the Gmail version
          </button>
        ) : null}
        {mutation.kind === "running" ? (
          <p role="status">{pendingMessage(mutation.change)}</p>
        ) : null}
        {actions ? (
          <div
            className="mail-draft-actions"
            role="group"
            aria-label="Draft reply actions"
          >
            {editing ? (
              <>
                <button
                  type="button"
                  className="connection-primary-action"
                  onClick={this.saveSharedDraft}
                  disabled={busy}
                >
                  Save draft
                </button>
                <button type="button" onClick={this.cancelEdit} disabled={busy}>
                  Close
                </button>
              </>
            ) : (
              <DecisionButtons
                disabled={busy}
                allow={{
                  label: EMAIL_REPLY_DECISION.sendLabel,
                  className: "connection-primary-action",
                  onSelect: this.approve,
                }}
                between={
                  <button
                    type="button"
                    ref={this.editButton}
                    onClick={this.startEdit}
                    disabled={busy}
                  >
                    Edit
                  </button>
                }
                refuse={{
                  label: EMAIL_REPLY_DECISION.discardLabel,
                  onSelect: this.reject,
                }}
              />
            )}
          </div>
        ) : null}
      </div>
    );
  }

  /**
   * The records that the agent checked for the draft: what the draft cites,
   * then the accepted Memory it was shown.
   */
  private renderSources(): React.ReactNode {
    const draft = this.state.draft;
    if (
      (draft.kind !== "ready" && draft.kind !== "editing") ||
      draft.result.kind !== "current"
    )
      return null;
    return (
      <section className="mail-details-section">
        <h4>Sources</h4>
        <MailDraftSources
          sources={draft.result.sources}
          active={this.state.activeSource}
          links={{
            orderHref: this.props.orderHref,
            supplierHref: this.props.supplierHref,
            memoryHref: this.props.memoryHref,
          }}
          onActive={this.activateSource}
        />
      </section>
    );
  }

  private activateSource = (activeSource: number | null): void => {
    this.setState({ activeSource });
  };

  private renderDraftFacts(): React.ReactNode {
    const draft = this.state.draft;
    if (
      (draft.kind !== "ready" && draft.kind !== "editing") ||
      draft.result.kind !== "current"
    )
      return null;
    const proposal = draft.result.proposal;
    return (
      <section className="mail-details-section">
        <h4>Draft reply</h4>
        <dl className="mail-details-facts">
          <div>
            <dt>Subject</dt>
            <dd>{proposal.subject}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{formatAbsoluteTime(proposal.expiresAt)}</dd>
          </div>
        </dl>
        <p className="mail-inbox-note">
          A changed recipient, subject or thread in Gmail cancels this draft.
        </p>
        <a
          href={`https://mail.google.com/mail/#all/${encodeURIComponent(proposal.gmailThreadId)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open in Gmail
        </a>
      </section>
    );
  }

  /** The supplier that the conversation's sender is linked to. */
  private renderSender(): React.ReactNode {
    const address = conversationSender(
      this.props.messages,
      this.props.mailboxAddresses,
    );
    return address === null ? null : (
      <MailSenderSupplier
        key={address}
        organisationId={this.props.organisationId}
        accountId={this.props.accountId}
        address={address}
        canManage={this.props.canManage}
        supplierHref={this.props.supplierHref}
        suppliersPath={this.props.suppliersPath}
      />
    );
  }

  /** The correction sits below the thread. The draft and its bar stay. */
  private renderCorrection(work: LinkedWork | null): React.ReactNode {
    const waiting = work === null ? null : waitingReply(work);
    if (waiting === null || !this.props.canManage) return null;
    return (
      <section className="mail-details-section">
        {this.state.correcting ? (
          <MailRelationshipCorrection
            organisationId={this.props.organisationId}
            proposalId={waiting.proposalId}
            onChanged={this.correctionChanged.bind(this, waiting.proposalId)}
            onClose={this.closeCorrection}
            supplierHref={this.props.supplierHref}
          />
        ) : (
          <button
            type="button"
            ref={this.correctionButton}
            onClick={this.startCorrection}
          >
            Correct purchasing link
          </button>
        )}
      </section>
    );
  }

  private renderActivity(work: LinkedWork): React.ReactNode {
    return (
      <section className="mail-details-section">
        <h4>Activity and receipts</h4>
        <h5>Assignments</h5>
        {work.assignments.length === 0 ? (
          <p className="mail-inbox-note">No assignments recorded.</p>
        ) : (
          <ul className="mail-work-list">
            {work.assignments.map(renderAssignment)}
          </ul>
        )}
        {work.moreAssignments ? (
          <p className="mail-inbox-note">
            Showing the 20 most recent assignments.
          </p>
        ) : null}
        <h5>Replies</h5>
        {work.replies.length === 0 ? (
          <p className="mail-inbox-note">No reply proposals recorded.</p>
        ) : (
          <ul className="mail-work-list">{work.replies.map(renderReply)}</ul>
        )}
        {work.moreReplies ? (
          <p className="mail-inbox-note">
            Showing the 20 most recent proposals.
          </p>
        ) : null}
      </section>
    );
  }

  render(): React.ReactNode {
    const work = this.state.work;
    const linked =
      work.kind === "ready" && work.value.kind === "linked" ? work.value : null;
    const sources = this.renderSources();
    const correction = this.renderCorrection(linked);
    const activity = linked === null ? null : this.renderActivity(linked);
    const reply = this.renderDraft() ?? this.renderPersonReply();
    const bar = this.renderBar();
    return (
      <div
        className="mail-conversation"
        ref={this.root}
        data-replying={
          this.state.personReplyOpen && this.personReplyAddress() !== null
            ? this.state.personReplyExpanded
              ? "expanded"
              : ""
            : undefined
        }
      >
        <div className="mail-conversation-scroll" ref={this.scroller}>
          <MailThreadMessages
            messages={this.props.messages}
            addresses={this.props.mailboxAddresses}
            draft={this.threadDraft()}
          />
          {work.kind === "failed" ? (
            <div className="mail-conversation-problem">
              <p role="alert">{work.message}</p>
              <button type="button" onClick={this.retry}>
                Try again
              </button>
            </div>
          ) : null}
          {this.renderSettled(linked)}
          {linked?.replies.map(this.renderUnconfirmed)}
          {sources}
          <section
            className="mail-case-details"
            aria-label="Conversation details"
          >
            {this.renderDraftFacts()}
            {this.renderSender()}
            {linked === null ? null : (
              <div className="mail-details-section mail-details-case">
                <p className="mail-details-state">{caseLabel(linked.state)}</p>
              </div>
            )}
          </section>
          {work.kind === "loading" ? (
            <p className="mail-inbox-status" role="status">
              Loading conversation work…
            </p>
          ) : null}
          {correction}
          {activity}
          {this.props.children}
        </div>
        {reply === null && bar === null ? null : (
          <div
            className="mail-composer"
            ref={this.observeComposer}
            data-kind={this.renderDraft() === null ? "person" : "draft"}
          >
            {reply}
            {bar}
          </div>
        )}
        {reply === null && takesNoReplies(this.personReplyAddress() ?? "") ? (
          <p className="mail-inbox-note mail-no-reply">
            This sender does not take replies.
          </p>
        ) : null}
      </div>
    );
  }
}

/** The source whose words the draft marks for a focus in the trace. */
/** The newest draft that waits. Its card shows with the conversation. */
function waitingReply(work: MailInboxWork): MailWorkReply | null {
  if (work.kind !== "linked") return null;
  for (const reply of work.replies)
    if (emailReplyIsOpenable(reply.state.kind)) return reply;
  return null;
}

function settledNotice(state: MailWorkReplyState): string | null {
  switch (state.kind) {
    case "awaiting_approval":
    case "send_indeterminate":
      return null;
    case "sent":
      return "Reply sent.";
    case "rejected":
      return "Draft rejected.";
    case "approved":
      return "Reply approved.";
    case "draft_creation_indeterminate":
    case "proposal_missing":
    case "expired":
    case "superseded":
    case "revoked":
    case "operator_attested_present":
    case "operator_attested_absent":
    case "invalidated":
      return `${emailReplyLifecycleLabel(state.kind)}.`;
    default:
      return assertNever(state);
  }
}

function goneDraftNotice(
  result: Exclude<EmailReplyPreviewResult, CurrentDraft>,
): string {
  switch (result.kind) {
    case "proposal_missing":
      return "The Gmail draft is gone, so there is nothing to approve.";
    case "invalidated":
      return result.reason === "unsupported_content"
        ? "The Gmail draft gained an attachment or rich content, which cancelled this draft reply."
        : "A recipient, subject or thread changed in Gmail, which cancelled this draft reply.";
    case "expired":
      return "This draft reply expired before approval.";
    default:
      return assertNever(result);
  }
}

function pendingMessage(change: Change): string {
  switch (change) {
    case "approve":
      return "Sending the reply…";
    case "edit":
    case "correct":
      return "Saving the draft…";
    case "reject":
      return "Rejecting the draft…";
    case "resolve":
      return "Checking Gmail…";
    default:
      return assertNever(change);
  }
}

function renderReply(reply: MailWorkReply): React.ReactNode {
  return (
    <li key={reply.proposalId} className="mail-work-reply">
      <p>
        <strong>{emailReplyLifecycleLabel(reply.state.kind)}</strong> · Version{" "}
        {reply.version}
      </p>
      {reply.state.kind === "sent" ? (
        <p title={`Gmail receipt ${reply.state.providerMessageId}`}>
          Gmail confirmed the send ·{" "}
          <time dateTime={new Date(reply.state.sentAt).toISOString()}>
            {new Date(reply.state.sentAt).toLocaleString()}
          </time>
        </p>
      ) : null}
    </li>
  );
}

function renderAssignment(assignment: MailWorkAssignment): React.ReactNode {
  return (
    <li key={assignment.assignmentId}>
      <strong>{assignmentLabel(assignment)}</strong>
      {assignment.kind !== "assigned" ? (
        <p className="mail-inbox-note">
          {assignment.kind === "running" ? "Started" : "Finished"}{" "}
          <time
            dateTime={new Date(
              assignment.kind === "running"
                ? assignment.startedAt
                : assignment.settledAt,
            ).toISOString()}
          >
            {new Date(
              assignment.kind === "running"
                ? assignment.startedAt
                : assignment.settledAt,
            ).toLocaleString()}
          </time>
        </p>
      ) : null}
    </li>
  );
}

function assignmentLabel(assignment: MailWorkAssignment): string {
  switch (assignment.kind) {
    case "assigned":
      return "Assigned";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "budget_exhausted":
      return "Budget exhausted";
    default:
      return assertNever(assignment);
  }
}

function caseLabel(state: MailWorkCaseState): string {
  switch (state.kind) {
    case "open":
      return "Case open";
    case "waiting":
      switch (state.reason) {
        case "input":
          return "Waiting for input";
        case "approval":
          return "Waiting for approval";
        case "schedule":
          return "Waiting for schedule";
        default:
          return assertNever(state);
      }
    case "completing":
      return "Case completing";
    case "completed":
      return "Case completed";
    case "quarantined":
      return "Case quarantined";
    case "archived":
      return "Case archived";
    default:
      return assertNever(state);
  }
}

function workError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Conversation work could not be loaded. Refresh to try again.";
}

function reviewProblem(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The email review action could not be completed. Try again.";
}
