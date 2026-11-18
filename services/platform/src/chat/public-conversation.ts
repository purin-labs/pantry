import { currentProjectSnapshot } from "./project-context-binding";
import {
  latestPublicTimelineSequence,
  conversationTimeline,
  timelineVisibleMessages,
  type ChatMessage,
  type Conversation,
} from "./conversation";
import {
  attachmentParts,
  type ChatInputPart,
  type ChatTimelineEvent,
} from "./timeline";
import type { ConversationMetadata } from "./store";
import { assertNever } from "@seams/std";
import { conversationOrigin } from "./origin";

function visibleMessage(message: ChatMessage): boolean {
  return message.kind !== "context";
}

export function publicConversation(
  conversation: Conversation,
  metadata: ConversationMetadata = { lifecycle: "active", pinnedAt: null },
  revision: number,
): Record<string, unknown> {
  const latestSequence = latestPublicTimelineSequence(conversation);
  return {
    id: conversation.id,
    title: conversation.title,
    lineage: conversation.lineage,
    origin: conversationOrigin(conversation),
    forkableResponseIds: conversation.historyBindings
      .filter(
        completedResponseBinding.bind(null, conversation.completedRequests),
      )
      .map(responseBindingId),
    projectContext: currentProjectSnapshot(conversation),
    revision,
    model: conversation.modelRoute.model,
    effort: conversation.effort,
    messages: timelineVisibleMessages(conversation)
      .filter(visibleMessage)
      .map(publicMessage),
    timeline: conversationTimeline(conversation)
      .filter(isPublicTimelineEvent)
      .map(publicTimelineEvent),
    latestSequence,
    lastReadSequence: Math.min(conversation.lastReadSequence, latestSequence),
    draft: {
      text: conversation.draftText,
      updatedAt: conversation.draftUpdatedAt,
    },
    pendingInputs: conversation.pendingInputs,
    work: publicConversationWork(conversation.work),
    ...metadata,
  };
}

function isPublicTimelineEvent(
  event: ReturnType<typeof conversationTimeline>[number],
): boolean {
  return event.kind !== "context" || event.contextDetails !== undefined;
}

/**
 * The mark of the page that went with a message: its name, never its view.
 * The view stays on the server, because a shared chat has other readers.
 */
function screenParts(
  parts: readonly ChatInputPart[],
): readonly unknown[] {
  for (const part of parts)
    if (part.kind === "surface_observation")
      return [
        {
          kind: "screen",
          area: part.observation.area,
          title: part.observation.title,
          record: part.observation.record?.label ?? null,
        },
      ];
  return [];
}

// A message keeps the page that went with it, but its public form does not.
function publicMessage(message: ChatMessage): ChatMessage {
  if (message.kind !== "user" || message.surfaceObservation === undefined)
    return message;
  const { surfaceObservation: _view, ...rest } = message;
  return rest;
}

/** The mark of a spoken command, which the Portal shows on the message. */
function voiceParts(parts: readonly ChatInputPart[]): readonly ChatInputPart[] {
  return parts.filter((part) => part.kind === "voice");
}

function publicTimelineEvent(event: ChatTimelineEvent): unknown {
  const base = {
    eventId: event.eventId,
    sequence: event.sequence,
    requestId: event.requestId,
    createdAt: event.createdAt,
  };
  switch (event.kind) {
    case "user":
      return {
        ...base,
        kind: event.kind,
        text: event.text,
        parts: [
          ...attachmentParts(event.parts),
          ...voiceParts(event.parts),
          ...screenParts(event.parts),
        ],
      };
    case "activity":
    case "context":
    case "progress":
    case "run_failed":
    case "run_cancelled":
      return {
        ...base,
        kind: event.kind,
        text: event.text,
        ...((event.kind === "context" ||
          event.kind === "activity" ||
          event.kind === "progress") &&
        event.contextDetails !== undefined
          ? { contextDetails: event.contextDetails }
          : {}),
      };
    case "assistant":
      return {
        ...base,
        kind: event.kind,
        text: event.text,
        sources: event.sources,
        usage: event.usage,
        rating: event.rating ?? null,
        ...(event.question === undefined ? {} : { question: event.question }),
      };
    case "connector":
      return {
        ...base,
        kind: event.kind,
        text: event.text,
        document: event.document,
        target: event.target,
      };
    case "tool_started":
      return { ...base, kind: event.kind, tool: event.tool };
    case "tool_settled":
      return {
        ...base,
        kind: event.kind,
        tool: event.tool,
        outcome: event.outcome,
        summary: event.summary,
        receipt: event.receipt,
      };
    case "approval":
      return { ...base, kind: event.kind, approval: event.approval };
    case "receipt":
      return { ...base, kind: event.kind, receipt: event.receipt };
    default:
      return assertNever(event);
  }
}

export function publicConversationWork(work: Conversation["work"]): unknown {
  if (work.kind === "failed")
    return {
      kind: "failed",
      requestId: work.requestId,
      error: work.error,
      recovery: work.recovery === null ? null : { kind: work.recovery.kind },
    };
  return work.kind === "running" || work.kind === "cancelling"
    ? {
        kind: work.kind,
        requestId: work.requestId,
        expiresAt: work.expiresAt,
        sessionId: work.stream.sessionId,
        turnId: work.stream.turnId,
        ...(work.kind === "cancelling"
          ? { cancellationId: work.cancellationId }
          : {}),
      }
    : work.kind === "awaiting_permission"
      ? {
          kind: "awaiting_permission",
          requestId: work.requestId,
          permission: work.permission,
        }
      : work;
}

function completedResponseBinding(
  completedRequests: readonly string[],
  binding: Conversation["historyBindings"][number],
): boolean {
  return (
    binding.responseId !== null && completedRequests.includes(binding.requestId)
  );
}

function responseBindingId(
  binding: Conversation["historyBindings"][number],
): string | null {
  return binding.responseId;
}
