import {
  chatOriginFromObservation,
  parseChatOrigin,
  type ChatOrigin,
} from "@seams/control-api";
import type { ChatTimelineEvent } from "./timeline";

/**
 * Where a chat started (Plan 87): the page that its first message carried.
 * A chat whose first message carried no page has no origin, and a later
 * message gives it none. The stored origin wins over the timeline, so the
 * origin stays when older events leave the timeline.
 */
export function chatOrigin(
  stored: unknown,
  timeline: readonly ChatTimelineEvent[],
): ChatOrigin | undefined {
  return (
    (stored === undefined ? null : parseChatOrigin(stored)) ??
    timelineOrigin(timeline)
  );
}

function timelineOrigin(
  timeline: readonly ChatTimelineEvent[],
): ChatOrigin | undefined {
  const first = timeline.find(isUserEvent);
  if (first === undefined) return undefined;
  for (const part of first.parts)
    if (part.kind === "surface_observation")
      return chatOriginFromObservation(part.observation, first.createdAt);
  return undefined;
}

function isUserEvent(
  event: ChatTimelineEvent,
): event is Extract<ChatTimelineEvent, { readonly kind: "user" }> {
  return event.kind === "user";
}

/** The origin of a conversation, as a field to spread into it. */
export function chatOriginField(
  origin: ChatOrigin | undefined,
): Readonly<{ origin?: ChatOrigin }> {
  return origin === undefined ? {} : { origin };
}

/**
 * The origin of a conversation. A builder that copies a conversation field by
 * field may leave the stored origin out; the first message still names it.
 */
export function conversationOrigin(
  conversation: Readonly<{
    origin?: ChatOrigin;
    timeline: readonly ChatTimelineEvent[];
  }>,
): ChatOrigin | null {
  return chatOrigin(conversation.origin, conversation.timeline) ?? null;
}
