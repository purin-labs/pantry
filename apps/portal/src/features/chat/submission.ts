import type { ConversationId } from "@seams/control-api";
import type { Chat } from "@seams/control-api/portal/chat";

/**
 * How the composer submits a message: `send` starts a turn, `queue` waits for
 * the running turn as `next`, and `steer` goes into the running turn.
 */
type SubmissionLane = "send" | "queue" | "steer";

/** One composer message on its way to the server, from the Enter to the answer. */
type Submission = Readonly<{
  lane: SubmissionLane;
  text: string;
  attempt: number;
}>;

/** The submissions in flight, for each conversation. A lane holds one at a time. */
type Submissions = ReadonlyMap<ConversationId, readonly Submission[]>;

type SubmissionEvent =
  | Readonly<{
      kind: "begin";
      conversationId: ConversationId;
      lane: SubmissionLane;
      text: string;
      attempt: number;
    }>
  | Readonly<{
      kind: "settle";
      conversationId: ConversationId;
      attempt: number;
    }>;

type SubmissionStep =
  | Readonly<{ kind: "moved"; submissions: Submissions }>
  /** The same lane of this conversation still runs: the event changes nothing. */
  | Readonly<{ kind: "refused"; reason: "lane_busy" }>;

/**
 * The composer's submission machine. Its state is keyed by conversation, so
 * a send that is still in flight in one chat never blocks or swallows a send
 * in another chat. A second Enter in one lane before the first one has its
 * answer is refused, so it makes no second input id and no second copy.
 */
function submissionStep(
  submissions: Submissions,
  event: SubmissionEvent,
): SubmissionStep {
  const running = submissions.get(event.conversationId) ?? [];
  const next = new Map(submissions);
  switch (event.kind) {
    case "begin": {
      if (running.some((submission) => submission.lane === event.lane))
        return { kind: "refused", reason: "lane_busy" };
      next.set(event.conversationId, [
        ...running,
        { lane: event.lane, text: event.text, attempt: event.attempt },
      ]);
      return { kind: "moved", submissions: next };
    }
    case "settle": {
      const kept = running.filter(
        (submission) => submission.attempt !== event.attempt,
      );
      if (kept.length === 0) next.delete(event.conversationId);
      else next.set(event.conversationId, kept);
      return { kind: "moved", submissions: next };
    }
  }
}

/** The proof that a submission began; `settle` takes it back. */
type SubmissionTicket = Readonly<{
  conversationId: ConversationId;
  attempt: number;
}>;

/** The chat page's submissions. It moves only through `submissionStep`. */
export class ComposerSubmissions {
  #submissions: Submissions = new Map();
  #attempts = 0;

  /** Null while the same lane of this conversation still runs. */
  begin(
    conversationId: ConversationId,
    lane: SubmissionLane,
    text: string,
  ): SubmissionTicket | null {
    const attempt = ++this.#attempts;
    const step = submissionStep(this.#submissions, {
      kind: "begin",
      conversationId,
      lane,
      text,
      attempt,
    });
    if (step.kind === "refused") return null;
    this.#submissions = step.submissions;
    return { conversationId, attempt };
  }

  settle(ticket: SubmissionTicket | null): void {
    if (ticket === null) return;
    const step = submissionStep(this.#submissions, {
      kind: "settle",
      ...ticket,
    });
    if (step.kind === "moved") this.#submissions = step.submissions;
  }

  /** A new turn is on its way in this conversation. */
  sending(conversationId: ConversationId | null): boolean {
    return this.#lanes(conversationId).some(
      (submission) => submission.lane === "send",
    );
  }

  /**
   * A message of this conversation is on its way. Until its answer arrives, a
   * read of the conversation can still hold the submitted text as the saved
   * draft, so the composer keeps its own text.
   */
  holdsDraft(conversationId: ConversationId | null): boolean {
    return this.#lanes(conversationId).length > 0;
  }

  #lanes(conversationId: ConversationId | null): readonly Submission[] {
    return conversationId === null
      ? []
      : (this.#submissions.get(conversationId) ?? []);
  }
}

/**
 * True when `incoming` is an older snapshot of the conversation on screen. A
 * read that started before a send can answer after it; the page keeps the
 * newer revision.
 */
export function isOlderSnapshot(
  shown: Chat | null | undefined,
  incoming: Chat | null,
): boolean {
  return (
    shown != null &&
    incoming !== null &&
    shown.id === incoming.id &&
    incoming.revision < shown.revision
  );
}

/** Ends one send's outgoing message, and leaves a later send's message. */
export function withoutOutgoing(
  conversationId: ConversationId,
  state: Readonly<{
    outgoing: Readonly<{ conversationId: ConversationId }> | null;
  }>,
): Readonly<{ outgoing: null }> | null {
  return state.outgoing?.conversationId === conversationId
    ? { outgoing: null }
    : null;
}

type QueuedInput = Readonly<{ id: string; text: string }>;

/** A failed queued message goes back to the composer, unless the person typed again. */
export function restoreQueuedDraft(
  submittedText: string,
  message: string | null,
  state: Readonly<{ draft: string }>,
): Readonly<{ draft: string; error: string | null }> {
  return {
    draft: state.draft.length === 0 ? submittedText : state.draft,
    error: message,
  };
}

/** An accepted message leaves the composer, unless the person typed again. */
export function clearSubmittedDraft(
  text: string,
  state: Readonly<{ draft: string }>,
): Readonly<{ draft: string }> {
  return { draft: state.draft.trim() === text.trim() ? "" : state.draft };
}

export function toQueuedInput(
  input: Readonly<{ inputId: string; text: string }>,
): QueuedInput {
  return { id: input.inputId, text: input.text };
}

export function removeAcceptedQueue(
  id: string,
  state: Readonly<{ queued: readonly QueuedInput[] }>,
): Readonly<{ queued: readonly QueuedInput[] }> {
  return { queued: state.queued.filter((item) => item.id !== id) };
}
