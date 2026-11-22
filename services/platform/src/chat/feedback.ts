import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import type { ConversationId } from "@purin-labs/control-api";
import { isChatId } from "./conversation";
import {
  readConversation,
  reconcileRevokedConversationRun,
  saveConversation,
  type ConversationScope,
} from "./store";
import type { ChatTimelineEvent } from "./timeline";

type ResponseFeedback = {
  readonly eventId: string;
  readonly rating: "good" | "bad" | null;
};

export function parseResponseFeedback(
  raw: Record<string, unknown>,
): ResponseFeedback | null {
  if (
    raw.action !== "rate_response" ||
    !isChatId(raw.eventId) ||
    (raw.rating !== "good" && raw.rating !== "bad" && raw.rating !== null) ||
    Object.keys(raw).some(isUnexpectedFeedbackField)
  )
    return null;
  return { eventId: raw.eventId, rating: raw.rating };
}

function isUnexpectedFeedbackField(field: string): boolean {
  return field !== "action" && field !== "eventId" && field !== "rating";
}

export async function saveResponseFeedback(
  env: Env,
  scope: ConversationScope,
  conversationId: ConversationId,
  feedback: ResponseFeedback,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "chat_not_found"
        | "chat_archived"
        | "chat_running"
        | "chat_capacity_reached"
        | "chat_revision_conflict";
    }
> {
  const resolved = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!resolved.ok) return { ok: false, code: "chat_revision_conflict" };
  const placement = resolved.value;
  await reconcileRevokedConversationRun(
    placement,
    scope.userId,
    conversationId,
  );
  const stored = await readConversation(
    placement.database,
    scope,
    conversationId,
  );
  if (stored === null) return { ok: false, code: "chat_not_found" };
  if (stored.metadata.lifecycle === "archived")
    return { ok: false, code: "chat_archived" };
  const conversation = stored.conversation;
  if (conversation.work.kind !== "ready" && conversation.work.kind !== "failed")
    return { ok: false, code: "chat_running" };
  const event = conversation.timeline.find(
    isFeedbackResponse.bind(null, feedback.eventId),
  );
  if (event === undefined) return { ok: false, code: "chat_not_found" };
  if (
    conversation.lineage.kind === "fork" &&
    event.sequence <= conversation.lineage.throughSequence
  )
    return { ok: false, code: "chat_archived" };
  const saved = await saveConversation(
    placement,
    scope.userId,
    {
      ...conversation,
      timeline: conversation.timeline.map(
        withResponseFeedback.bind(null, feedback),
      ),
    },
    stored.revision,
  );
  switch (saved.kind) {
    case "saved":
      return { ok: true };
    case "conflict":
      return { ok: false, code: "chat_revision_conflict" };
    case "capacity":
      return { ok: false, code: "chat_capacity_reached" };
  }
}

function isFeedbackResponse(
  eventId: string,
  event: ChatTimelineEvent,
): boolean {
  return (
    event.kind === "assistant" &&
    event.eventId === eventId &&
    event.question === undefined
  );
}

function withResponseFeedback(
  feedback: ResponseFeedback,
  event: ChatTimelineEvent,
): ChatTimelineEvent {
  if (event.kind !== "assistant" || event.eventId !== feedback.eventId)
    return event;
  return { ...event, rating: feedback.rating };
}
