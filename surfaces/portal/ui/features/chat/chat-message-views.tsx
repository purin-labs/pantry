import { ChatApprovalTrace, ChatReceiptTrace } from "./operation-events";
import type { ConversationId } from "@purin-labs/control-api";
import {
  QuestionCard,
  StreamingText,
  ResponseActions,
  type ResponseRating,
  type ResponseActionResult,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
} from "@purin-labs/ui/index";
import React from "react";
import { toast } from "sonner";
import {
  ArrowUp,
  CornerDownRight,
  GitBranch,
  ListTodo,
  LoaderCircle,
  X,
} from "lucide-react";
import { ChatSources } from "./sources";
import { ChatSelectedFile } from "./selected-file";
import { forkChatThread, rateChatResponse } from "./api";
import type {
  Chat,
  ChatTimelineView,
} from "@purin-labs/control-api/portal/chat";
import type { ChatTurnUsage } from "@purin-labs/control-api";
import { errorMessage } from "@purin-labs/std";
import type { ChatPage } from "./route";
import {
  focusBranchPoint,
  latestConversationMessage,
  timelineEventHasId,
} from "./chat-route-helpers";

export const chatMessageViews = {
  renderSelectedFile(
    this: ChatPage,
    file: File,
    index: number,
  ): React.ReactNode {
    return (
      <ChatSelectedFile
        key={index}
        file={file}
        disabled={this.state.sending || this.state.steering}
        onRemove={this.removeFile.bind(this, file)}
      />
    );
  },

  renderQueued(
    this: ChatPage,
    canSteer: boolean,
    item: {
      readonly id: string;
      readonly text: string;
    },
  ): React.ReactNode {
    const steering = this.state.steeringQueuedId === item.id;
    return (
      <li key={item.id}>
        <CornerDownRight size={14} aria-hidden="true" />
        <p title={item.text}>{item.text}</p>
        {canSteer ? (
          <button
            type="button"
            className="chat-queue-steer"
            title="Send this message now, into the running response"
            aria-label={`Steer now: ${item.text.slice(0, 60)}`}
            disabled={this.state.steeringQueuedId !== null}
            onClick={this.steerQueued.bind(this, item.id)}
          >
            {steering ? (
              <LoaderCircle
                size={13}
                className="chat-queue-spinner"
                aria-hidden="true"
              />
            ) : (
              <ArrowUp size={13} aria-hidden="true" />
            )}
            Steer
          </button>
        ) : null}
        <button
          type="button"
          className="chat-queue-remove"
          title="Remove from the queue"
          aria-label={`Remove from the queue: ${item.text.slice(0, 60)}`}
          disabled={steering}
          onClick={this.removeQueued.bind(this, item.id)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </li>
    );
  },

  renderOutgoing(this: ChatPage): React.ReactNode {
    const text = this.outgoingText();
    if (text === null) return null;
    return (
      <article
        className="chat-message chat-user"
        aria-label="You"
        data-outgoing="true"
      >
        <p>{text}</p>
      </article>
    );
  },

  usageForMessage(this: ChatPage, messageId: string): ChatTurnUsage | null {
    if (
      this.state.page.kind !== "ready" ||
      this.state.page.data.conversation === null
    )
      return null;
    const event = this.state.page.data.conversation.timeline.find(
      timelineEventHasId.bind(null, messageId),
    );
    return event?.kind === "assistant" ? (event.usage ?? null) : null;
  },

  renderMessageTime(this: ChatPage, messageId: string): React.ReactNode {
    if (this.state.page.kind !== "ready") return null;
    const event = this.state.page.data.conversation?.timeline.find(
      timelineEventHasId.bind(null, messageId),
    );
    if (event === undefined) return null;
    const date = new Date(event.createdAt);
    return (
      <time
        className="chat-message-time"
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
    );
  },

  renderResponseActions(
    this: ChatPage,
    eventId: string,
    text: string,
  ): React.ReactNode {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    if (conversation === null) return null;
    const event = conversation.timeline.find(
      timelineEventHasId.bind(null, eventId),
    );
    const latest = latestConversationMessage(conversation.timeline);
    const inherited =
      conversation.lineage.kind === "fork" &&
      event !== undefined &&
      event.sequence <= conversation.lineage.throughSequence;
    const readOnly = conversation.lifecycle === "archived" || inherited;
    return (
      <div className="chat-response-actions">
        <ResponseActions
          key={eventId}
          text={text}
          rating={event?.kind === "assistant" ? (event.rating ?? null) : null}
          onRate={
            readOnly
              ? undefined
              : this.rateResponse.bind(this, conversation.id, eventId)
          }
          ratingDisabled={this.isWorking()}
          onRegenerate={
            readOnly || latest?.eventId !== eventId
              ? undefined
              : this.regenerateResponse.bind(this, conversation.id, eventId)
          }
          regenerateDisabled={
            this.isWorking() ||
            this.state.page.kind !== "ready" ||
            this.state.page.data.model.kind !== "ready"
          }
          onFork={this.requestFork.bind(this, conversation.id, eventId)}
          forkDisabled={!conversation.forkableResponseIds.includes(eventId)}
          forking={this.state.forking}
        />
        {inherited ? <small>Inherited history</small> : null}
      </div>
    );
  },

  requestFork(
    this: ChatPage,
    sourceId: ConversationId,
    messageId: string,
  ): void {
    if (this.forkPending) return;
    this.setState({ forkConfirmation: { sourceId, messageId } });
  },

  closeForkConfirmation(this: ChatPage): void {
    this.setState({ forkConfirmation: null });
  },

  confirmFork(this: ChatPage): void {
    const target = this.state.forkConfirmation;
    if (target === null) return;
    this.setState(
      { forkConfirmation: null },
      this.forkResponse.bind(this, target.sourceId, target.messageId),
    );
  },

  async forkResponse(
    this: ChatPage,
    sourceId: ConversationId,
    messageId: string,
  ): Promise<void> {
    if (this.forkPending) return;
    this.forkPending = true;
    const key = `pantry:chat-fork:${this.props.organisationId}:${sourceId}:${messageId}`;
    const operationId = localStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key, operationId);
    this.setState({ error: null, forking: true });
    try {
      await this.flushDraftSave();
      const destinationId = await forkChatThread(
        this.props.organisationId,
        sourceId,
        messageId,
        operationId,
      );
      if (this.mounted) await this.selectThread(destinationId, true);
      if (this.mounted && this.conversationId === destinationId) {
        localStorage.removeItem(key);
        this.setState(
          { threadsExpanded: true },
          this.revealSelectedFork.bind(this),
        );
        toast.success("Opened a new branch", {
          description:
            "This chat includes history through the selected response.",
        });
      }
    } catch (error) {
      if (this.mounted)
        this.setState({
          error: errorMessage(
            error,
            "Could not fork this response. Retry to recover the same chat.",
          ),
        });
    } finally {
      this.forkPending = false;
      if (this.mounted) this.setState({ forking: false });
    }
  },

  revealSelectedFork(this: ChatPage): void {
    this.layout.current
      ?.querySelector<HTMLAnchorElement>(
        '.chat-layout > .chat-thread-sidebar a[aria-current="page"]',
      )
      ?.scrollIntoView({ block: "nearest" });
    this.composer.current?.focus({ preventScroll: true });
  },

  renderBranchNavigation(
    this: ChatPage,
    conversation: Chat,
  ): React.ReactNode {
    const derived =
      this.state.page.kind === "ready"
        ? this.state.page.data.derivedThreads
        : [];
    if (conversation.lineage.kind === "side_case")
      return this.renderSideCaseSource();
    if (conversation.lineage.kind === "original" && derived.length === 0)
      return null;
    return (
      <nav className="chat-branch-navigation" aria-label="Chat branches">
        {conversation.lineage.kind === "fork" ? (
          <div className="chat-branch-origin">
            <a
              href={`${this.props.basePath}?conversation=${encodeURIComponent(conversation.lineage.sourceConversationId)}#message-${encodeURIComponent(conversation.lineage.sourceMessageId)}`}
              onClick={this.openBranchPoint.bind(
                this,
                conversation.lineage.sourceConversationId,
                conversation.lineage.sourceMessageId,
              )}
            >
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Continued from chat</span>
            </a>
          </div>
        ) : null}
        {derived.length > 0 ? (
          <ul>{derived.map(this.renderDerivedThread.bind(this))}</ul>
        ) : null}
      </nav>
    );
  },

  /** Where a side Case came from: a link while its reader can open it. */
  renderSideCaseSource(this: ChatPage): React.ReactNode {
    const source =
      this.state.page.kind === "ready"
        ? this.state.page.data.sideCaseSource
        : null;
    if (source === null) return null;
    return (
      <nav className="chat-branch-navigation" aria-label="Chat branches">
        <div className="chat-branch-origin">
          {source.kind === "available" ? (
            <a
              href={`${this.props.basePath}?conversation=${encodeURIComponent(source.conversationId)}`}
              onClick={this.openThread.bind(this, source.conversationId)}
            >
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Proposed in {source.title}</span>
            </a>
          ) : (
            <span className="chat-branch-unavailable">
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Proposed in a chat that you cannot open</span>
            </span>
          )}
        </div>
      </nav>
    );
  },

  async openBranchPoint(
    this: ChatPage,
    sourceId: ConversationId,
    messageId: string,
    event: React.MouseEvent<HTMLAnchorElement>,
  ): Promise<void> {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    await this.selectThread(sourceId, true);
    const url = new URL(window.location.href);
    url.hash = `message-${messageId}`;
    window.history.replaceState(window.history.state, "", url);
    requestAnimationFrame(focusBranchPoint.bind(null, messageId));
  },

  renderDerivedThread(
    this: ChatPage,
    thread: import("@purin-labs/control-api").ChatDerivedThread,
  ): React.ReactNode {
    return (
      <li key={thread.id}>
        <a
          href={`${this.props.basePath}?conversation=${encodeURIComponent(thread.id)}`}
          onClick={this.openThread.bind(this, thread.id)}
        >
          {thread.title}
        </a>
      </li>
    );
  },

  async rateResponse(
    this: ChatPage,
    conversationId: ConversationId,
    eventId: string,
    rating: ResponseRating,
  ): Promise<ResponseActionResult> {
    if (this.isWorking())
      return {
        kind: "failed",
        message: "Wait for the current response to finish.",
      };
    try {
      await rateChatResponse(
        this.props.organisationId,
        conversationId,
        eventId,
        rating,
      );
      if (this.mounted && this.conversationId === conversationId)
        await this.refresh();
      return { kind: "accepted" };
    } catch (error) {
      return {
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Could not save feedback. Try again.",
      };
    }
  },

  async regenerateResponse(
    this: ChatPage,
    conversationId: ConversationId,
    eventId: string,
  ): Promise<ResponseActionResult> {
    if (this.conversationId !== conversationId)
      return { kind: "failed", message: "This conversation has changed." };
    const availability = this.questionAvailability(eventId);
    if (availability !== undefined)
      return { kind: "failed", message: availability.message };
    return this.send(
      "Please revise your previous answer using the information already collected. Give me an alternative response without repeating any actions or changing external systems.",
      null,
    );
  },

  isInheritedEvent(this: ChatPage, event: ChatTimelineView): boolean {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    return (
      conversation?.lineage.kind === "fork" &&
      event.sequence <= conversation.lineage.throughSequence
    );
  },

  renderTimelineEvent(
    this: ChatPage,
    event: ChatTimelineView,
  ): React.ReactNode {
    if (event.kind === "progress" || event.kind === "activity")
      return (
        <TraceCollapsible key={event.eventId}>
          <TraceCollapsibleTrigger>
            <TraceLine status="completed">
              <TraceIcon>
                <ListTodo />
              </TraceIcon>
              <TraceTitle>
                {event.kind === "progress"
                  ? "Progress update"
                  : "Activity update"}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <p>{event.text}</p>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    if (event.kind === "assistant")
      return (
        <React.Fragment key={event.eventId}>
          {event.question === undefined ? (
            this.renderMessage({
              kind: "assistant",
              id: event.eventId,
              text: event.text,
            })
          ) : (
            <div id={`message-${event.eventId}`} tabIndex={-1}>
              <QuestionCard
                question={{ id: event.eventId, ...event.question }}
                availability={this.questionAvailability(event.eventId)}
                onSubmit={this.answerQuestion.bind(
                  this,
                  event.eventId,
                  event.question.title,
                )}
              />
              {this.renderResponseActions(event.eventId, event.text)}
            </div>
          )}
          {event.question === undefined ||
          event.sources === undefined ||
          event.sources.length === 0 ? null : (
            <ChatSources sources={event.sources} />
          )}
        </React.Fragment>
      );
    if (
      event.kind === "user" ||
      event.kind === "context" ||
      event.kind === "run_failed" ||
      event.kind === "run_cancelled"
    )
      return this.renderMessage({
        kind:
          event.kind === "context" ||
          event.kind === "run_failed" ||
          event.kind === "run_cancelled"
            ? "activity"
            : event.kind,
        id: event.eventId,
        text: event.text,
      });
    if (event.kind === "connector")
      return this.renderMessage({
        kind: "connector",
        id: event.eventId,
        text: event.text,
        connector: event.connector,
        target: event.target,
      });
    if (event.kind === "approval")
      return (
        <ChatApprovalTrace
          key={event.eventId}
          approval={event.approval}
          inherited={this.isInheritedEvent(event)}
        />
      );
    if (event.kind === "receipt")
      return <ChatReceiptTrace key={event.eventId} receipt={event.receipt} />;
    return null;
  },

  renderStreamingMessage(this: ChatPage): React.ReactNode {
    if (
      (this.state.stream.kind !== "active" &&
        this.state.stream.kind !== "reconnecting") ||
      this.state.stream.text.length === 0
    )
      return null;
    return (
      <article
        className="chat-message chat-assistant chat-streaming"
        aria-label="Assistant response in progress"
        aria-live="off"
      >
        <StreamingText text={this.state.stream.text} streaming />
      </article>
    );
  },
};
