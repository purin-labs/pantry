import {
  machineTransition,
  type MachineTransitionResult,
} from "@purin-labs/std/state-machine";
import {
  conversationTimeline,
  normalizeConversationTimeline,
  type Conversation,
  type ConversationWork,
} from "./conversation";
import {
  CONVERSATION_WORK_MACHINE,
  PERMISSION_WAIT_MS,
} from "./conversation-work.machine";

type WorkMachine = typeof CONVERSATION_WORK_MACHINE;

/**
 * The checks of the guarded moves. `now` dates the permission wait, and
 * `modelRouteAvailable` is what the caller read of the conversation's route.
 */
type ConversationTransitionFacts = Readonly<{
  now: number;
  modelRouteAvailable: boolean;
}>;

/**
 * Whether `event` may move the work (Refactor 15, refactor 9). Every writer
 * of a guarded move asks this before it saves the conversation.
 */
export function conversationTransition(
  work: ConversationWork,
  event: "expire_permission" | "block",
  facts: ConversationTransitionFacts,
): MachineTransitionResult<WorkMachine, "expire_permission" | "block"> {
  return event === "expire_permission"
    ? machineTransition(CONVERSATION_WORK_MACHINE, work.kind, event, {
        wait_expired: () =>
          work.kind === "awaiting_permission" &&
          facts.now >= work.permission.requestedAt + PERMISSION_WAIT_MS,
      })
    : machineTransition(CONVERSATION_WORK_MACHINE, work.kind, event, {
        model_route_unavailable: () => !facts.modelRouteAvailable,
      });
}

/**
 * Whether the work waits for a person, so the Case's wake has nothing to
 * do: a chat with no queued message, a failed turn, or a permission wait.
 */
export function conversationWorkAtRest(conversation: Conversation): boolean {
  switch (conversation.work.kind) {
    case "ready":
      return conversation.pendingInputs.length === 0;
    case "failed":
    case "awaiting_permission":
      return true;
    case "running":
    case "cancelling":
      return false;
  }
}

export const PERMISSION_EXPIRED_MESSAGE =
  "The permission request expired after 24 hours. Retry to ask again.";

export const MODEL_ROUTE_UNAVAILABLE_MESSAGE =
  "This conversation's AI connection is unavailable. Restore its connection, then retry.";

/**
 * A permission wait that is 24 hours old reads as a failed turn. The read
 * moves it, so every reader sees the same expiry and a retry asks again;
 * the next save stores it. The failure is dated when the wait ended.
 */
export function expirePermissionWait(
  conversation: Conversation,
  now: number,
): Conversation {
  const work = conversation.work;
  if (work.kind !== "awaiting_permission") return conversation;
  if (
    !conversationTransition(work, "expire_permission", {
      now,
      modelRouteAvailable: true,
    }).allowed
  )
    return conversation;
  return failConversationWork(
    conversation,
    work.requestId,
    PERMISSION_EXPIRED_MESSAGE,
    work.permission.requestedAt + PERMISSION_WAIT_MS,
  );
}

/** The failed work of `requestId`, with its failure in the timeline. */
export function failConversationWork(
  conversation: Conversation,
  requestId: string,
  message: string,
  failedAt: number,
): Conversation {
  const timeline = conversationTimeline(conversation);
  const sequence = (timeline[timeline.length - 1]?.sequence ?? 0) + 1;
  return normalizeConversationTimeline({
    ...conversation,
    work: { kind: "failed", requestId, error: message, recovery: null },
    timeline: [
      ...timeline,
      {
        kind: "run_failed",
        eventId: `failure_${requestId}_${sequence}`,
        sequence,
        requestId,
        createdAt: failedAt,
        text: message,
      },
    ],
  });
}
