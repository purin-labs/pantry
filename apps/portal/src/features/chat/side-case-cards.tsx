/**
 * Side Cases that the agent proposed in this chat (Plan 74). Each one shows
 * as a card in the timeline at the moment the agent proposed it. Nothing
 * starts until a person chooses. "Start in a subthread" starts a new chat
 * under this one, with the brief as its first message and none of this
 * chat's history. "Do it here" sends the brief as the person's next message
 * in this chat and closes the proposal.
 */
import React from "react";
import { GitBranch, LoaderCircle } from "lucide-react";
import { assertNever } from "@purin-labs/std";
import type {
  ChatSideCaseState,
  ChatSideCaseView,
  ConversationId,
} from "@purin-labs/control-api";
import type { ChatTimelineInsert } from "./activity";
import type { ChatTimelineView } from "@purin-labs/control-api/portal/chat";
import { sideCaseHereRequestId } from "@purin-labs/control-api";
import type { SideCaseActions } from "./side-cases";
import "../../ui/draft-message-card.css";
import "./side-case-card.css";

type SideCaseContext = Readonly<{
  actions: SideCaseActions;
  /** False for a person whose role cannot act in Portal chats. */
  canManage: boolean;
  basePath: string;
  onOpen: (
    conversationId: ConversationId,
    event: React.MouseEvent<HTMLAnchorElement>,
  ) => void;
  onChanged: () => Promise<void>;
  /** Sends the brief as the person's next message in this chat. */
  sendHere: (card: ChatSideCaseView) => Promise<void>;
  timeline: readonly ChatTimelineView[];
}>;

export function sideCaseInserts(
  cards: readonly ChatSideCaseView[],
  context: SideCaseContext,
): readonly ChatTimelineInsert[] {
  return cards.map((card) => ({
    key: `side-case:${card.proposalId}`,
    createdAt: card.createdAt,
    node: (
      <ChatSideCaseCard
        key={`side-case:${card.proposalId}`}
        card={card}
        context={context}
      />
    ),
  }));
}

type Pending = "start" | "here" | null;
type HereDelivery =
  Readonly<{ kind: "not_sent" }> | Readonly<{ kind: "accepted" }>;
const HERE_ACCEPTED_MESSAGE =
  "The brief is already in this chat. Select Finish here to close this proposal.";

function ChatSideCaseCard(
  props: Readonly<{ card: ChatSideCaseView; context: SideCaseContext }>,
): React.ReactNode {
  const { context } = props;
  const titleId = React.useId();
  const errorId = React.useId();
  // The answer of the last action shows at once; the next chat read replaces it.
  const [answered, setAnswered] = React.useState<ChatSideCaseView | null>(null);
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [localDelivery, setHereDelivery] = React.useState<HereDelivery>({
    kind: "not_sent",
  });
  const hereDelivery: HereDelivery = context.timeline.some(
    acceptedBrief.bind(null, props.card),
  )
    ? { kind: "accepted" }
    : localDelivery;
  const card =
    answered !== null && stage(answered.state) > stage(props.card.state)
      ? answered
      : props.card;
  const status = statusOf(card.state, pending, hereDelivery);

  async function run(
    step: Exclude<Pending, null>,
    action: () => Promise<ChatSideCaseView>,
  ): Promise<void> {
    if (pending !== null) return;
    setPending(step);
    setError(null);
    let answer: ChatSideCaseView;
    try {
      answer = await action();
    } catch (caught) {
      setPending(null);
      setError(
        caught instanceof Error && caught.message.length > 0
          ? caught.message
          : "This step did not finish. Try again.",
      );
      await context.onChanged().catch(ignoreRefreshFailure);
      return;
    }
    // The card shows the answer at once; the chat read that follows only
    // brings the sidebar and the other cards up to date.
    setAnswered(answer);
    setPending(null);
    await context.onChanged().catch(ignoreRefreshFailure);
  }
  const start = (): Promise<void> =>
    run("start", async () => (await context.actions.start(card)).card);
  // The message goes first: a proposal closes only when its work is here.
  const doHere = run.bind(
    null,
    "here",
    completeSideCaseHere.bind(
      null,
      card,
      context,
      hereDelivery,
      setHereDelivery,
    ),
  );
  const notice = noticeOf(card.state, context.canManage);
  const mayStart =
    context.canManage &&
    hereDelivery.kind === "not_sent" &&
    ((card.state.kind === "open" && card.state.mayDecide) ||
      (card.state.kind === "starting" && card.state.mayRetry));
  const mayDoHere =
    context.canManage && card.state.kind === "open" && card.state.mayDecide;

  return (
    <article
      className="draft-message side-case-card"
      data-status={status.tone}
      aria-labelledby={titleId}
      aria-busy={pending !== null}
    >
      <header className="draft-message-head">
        <span className="draft-message-icon" aria-hidden="true">
          <GitBranch size={18} strokeWidth={1.75} />
        </span>
        <h3 id={titleId} className="draft-message-title">
          {card.title}
        </h3>
        <span className="draft-message-status" role="status">
          <span className="draft-message-dot" aria-hidden="true" />
          {status.label}
        </span>
      </header>
      {undecided(card.state) && hereDelivery.kind === "not_sent" ? (
        <p className="side-case-card-lead">
          The agent found this separate work.
          {mayStart || mayDoHere
            ? " Start it in a subthread that begins with this brief, or do it here in this chat."
            : " Its brief is shown below."}
        </p>
      ) : null}
      {/* A closed proposal keeps only its title, so the timeline stays calm. */}
      {closed(card.state) ? null : (
        <div className="draft-message-sheet">
          <p className="side-case-card-brief">{card.brief}</p>
        </div>
      )}
      {notice === null ? null : (
        <p className="draft-message-notice" role="status">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p id={errorId} className="draft-message-error" role="alert">
          {hereDelivery.kind === "accepted" ? HERE_ACCEPTED_MESSAGE : error}
        </p>
      )}
      {mayStart || mayDoHere || openable(card.state) ? (
        <div className="draft-message-actions">
          {mayStart ? (
            <button
              type="button"
              className="draft-message-button"
              data-tone="primary"
              aria-disabled={pending !== null}
              aria-describedby={error === null ? undefined : errorId}
              onClick={() => void start()}
            >
              {pending === "start" ? (
                <LoaderCircle
                  className="draft-message-spin"
                  size={14}
                  aria-hidden="true"
                />
              ) : null}
              Start in a subthread
            </button>
          ) : null}
          {mayDoHere ? (
            <button
              type="button"
              className="draft-message-button"
              data-tone="secondary"
              aria-disabled={pending !== null}
              aria-describedby={error === null ? undefined : errorId}
              onClick={() => void doHere()}
            >
              {pending === "here" ? (
                <LoaderCircle
                  className="draft-message-spin"
                  size={14}
                  aria-hidden="true"
                />
              ) : null}
              {hereDelivery.kind === "accepted" ? "Finish here" : "Do it here"}
            </button>
          ) : null}
          {card.state.kind === "started" &&
          card.state.conversationId !== null ? (
            <OpenChatLink
              conversationId={card.state.conversationId}
              context={context}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

async function completeSideCaseHere(
  card: ChatSideCaseView,
  context: SideCaseContext,
  delivery: HereDelivery,
  setDelivery: React.Dispatch<React.SetStateAction<HereDelivery>>,
): Promise<ChatSideCaseView> {
  if (delivery.kind === "not_sent") {
    await context.sendHere(card);
    setDelivery({ kind: "accepted" });
  }
  try {
    return await context.actions.dismiss(card);
  } catch {
    throw new Error(HERE_ACCEPTED_MESSAGE);
  }
}

function acceptedBrief(
  card: ChatSideCaseView,
  event: ChatTimelineView,
): boolean {
  return (
    event.kind === "user" &&
    event.requestId === sideCaseHereRequestId(card.proposalId) &&
    event.text === card.brief
  );
}

function OpenChatLink(
  props: Readonly<{
    conversationId: ConversationId;
    context: SideCaseContext;
  }>,
): React.ReactNode {
  return (
    <a
      className="draft-message-button"
      data-tone="secondary"
      href={`${props.context.basePath}?conversation=${encodeURIComponent(props.conversationId)}`}
      onClick={(event) => props.context.onOpen(props.conversationId, event)}
    >
      Open chat
    </a>
  );
}

function ignoreRefreshFailure(): void {}

function undecided(state: ChatSideCaseState): boolean {
  return state.kind === "open" || state.kind === "starting";
}

function closed(state: ChatSideCaseState): boolean {
  return state.kind === "dismissed" || state.kind === "expired";
}

function openable(state: ChatSideCaseState): boolean {
  return state.kind === "started" && state.conversationId !== null;
}

/** How far a proposal has moved. A card never shows an earlier state again. */
function stage(state: ChatSideCaseState): number {
  switch (state.kind) {
    case "open":
      return 0;
    case "starting":
      return 1;
    case "started":
    case "dismissed":
    case "expired":
      return 2;
    default:
      return assertNever(state, "Unknown side Case state");
  }
}

function statusOf(
  state: ChatSideCaseState,
  pending: Pending,
  delivery: HereDelivery,
): Readonly<{ label: string; tone: string }> {
  if (pending === "start") return { label: "Starting", tone: "loading" };
  if (pending === "here")
    return {
      label: delivery.kind === "accepted" ? "Finishing" : "Sending",
      tone: "loading",
    };
  switch (state.kind) {
    case "open":
      return delivery.kind === "accepted"
        ? { label: "In this chat", tone: "sent" }
        : { label: "Proposed", tone: "ready" };
    case "starting":
      return { label: "Starting", tone: "loading" };
    case "started":
      return { label: "Started", tone: "sent" };
    // A person closes a proposal only with "Do it here".
    case "dismissed":
      return { label: "In this chat", tone: "sent" };
    case "expired":
      return { label: "Expired", tone: "expired" };
    default:
      return assertNever(state, "Unknown side Case state");
  }
}

function noticeOf(state: ChatSideCaseState, canManage: boolean): string | null {
  switch (state.kind) {
    case "open":
      return canManage && state.mayDecide
        ? null
        : "A person who can edit this chat can start it.";
    case "starting":
      if (!state.mayRetry) return "Another person is starting this chat.";
      if (!canManage)
        return "A person who can edit this chat must retry the start.";
      return "The new chat did not finish starting. Start it again.";
    case "started":
      return state.conversationId === null
        ? "This side Case started as a separate chat."
        : null;
    case "dismissed":
    case "expired":
      return null;
    default:
      return assertNever(state, "Unknown side Case state");
  }
}
