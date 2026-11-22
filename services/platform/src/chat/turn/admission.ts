import {
  attachmentParts,
  type ChatTimelineEvent,
  surfaceObservationField,
  type PendingChatInput,
} from "../timeline";
import { chatInputParts, pendingInputSurfaceContext } from "../input-parts";
import { initialConversationCaseIdentity } from "../conversation-actor-identity";
import { canonicalJson } from "@purin-labs/std";
import {
  browserContextFromParts,
  addPendingChatInput,
  removePendingChatInput,
  conversationTimeline,
  timelineVisibleMessages,
  normalizeConversationTimeline,
  type ChatMessage,
  type Conversation,
  type ChatCommand,
} from "../conversation";
import type { OrganisationModelRoute } from "@purin-labs/agent/models/route";
import type { ConversationScope, StoredConversation } from "../store";
import type { Variant } from "@purin-labs/type-utils";
import { defaultChatEffort } from "./model";
import { conversationStreamIdentity } from "./run";
import { pendingInputHasRequestId } from "./steering";
import { appendMessageTimelineEvents } from "./timeline";

export function timelineEventIsCancellation(
  cancellationId: string,
  requestId: string,
  event: ChatTimelineEvent,
): boolean {
  return (
    event.kind === "run_cancelled" &&
    event.eventId === cancellationId &&
    event.requestId === requestId
  );
}

export function timelineEventHasId(
  eventId: string,
  event: ChatTimelineEvent,
): boolean {
  return event.eventId === eventId;
}

export function timelineEventCancelsRequest(
  requestId: string,
  event: ChatTimelineEvent,
): boolean {
  return event.kind === "run_cancelled" && event.requestId === requestId;
}

export type Admission =
  | {
      readonly ok: true;
      readonly kind: "replay" | "admitted" | "queued";
      readonly conversation: Conversation;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export async function admitTurn(
  stored: StoredConversation | null,
  command: ChatCommand,
  model: OrganisationModelRoute,
  scope: ConversationScope,
): Promise<Admission> {
  if (command.kind === "withdraw" || command.kind === "steer_queued")
    return {
      ok: false,
      code: "chat_command_invalid",
      message: "This command is handled by its dedicated admission path.",
    };
  const requestId = command.requestId;
  if (
    stored?.conversation.work.kind === "failed" &&
    stored.conversation.work.recovery?.kind === "projection_capacity" &&
    command.kind === "retry"
  )
    return {
      ok: false,
      code: "chat_projection_capacity",
      message:
        "The accepted result is preserved, but this conversation has reached its storage limit. Read the saved result or start a new chat; retrying will not run the model again.",
    };
  const storedConversation: Conversation = stored?.conversation ?? {
    lineage: { kind: "original" },
    historyBindings: [],
    id: command.conversationId,
    title:
      command.kind === "message"
        ? command.text.slice(0, 80)
        : "New conversation",
    modelRoute: model,
    documents: [],
    work: { kind: "ready" },
    completedRequests: [],
    timeline: [],
    pendingInputs: [],
    latestSequence: 0,
    lastReadSequence: 0,
    surfaceEventCursor: 0,
    draftText: "",
    draftUpdatedAt: null,
    effort: command.effort ?? defaultChatEffort(model),
  };
  const prior = timelineVisibleMessages(storedConversation).find(
    messageHasId.bind(null, requestId),
  );
  if (
    command.kind === "message" &&
    prior !== undefined &&
    !userMessageMatchesCommand(prior, command)
  )
    return {
      ok: false,
      code: "idempotency_key_conflict",
      message: "This message ID was already used for different content.",
    };
  if (storedConversation.completedRequests.includes(requestId))
    return { ok: true, kind: "replay", conversation: storedConversation };
  if (
    command.kind === "retry" &&
    prior !== undefined &&
    retryIsAlreadyActive(storedConversation, command.requestId)
  )
    return { ok: true, kind: "replay", conversation: storedConversation };
  if (
    command.kind === "message" &&
    prior?.kind === "user" &&
    userMessageMatchesCommand(prior, command)
  )
    return { ok: true, kind: "replay", conversation: storedConversation };
  if (command.kind === "next") {
    const pendingInputs = storedConversation.pendingInputs;
    const duplicateRequest = pendingInputs.find(
      pendingInputHasRequestId.bind(null, command.requestId),
    );
    if (duplicateRequest !== undefined) {
      if (
        duplicateRequest.inputId === command.inputId &&
        pendingInputMatchesCommand(duplicateRequest, command)
      )
        return {
          ok: true,
          kind: "replay",
          conversation: storedConversation,
        };
      return {
        ok: false,
        code: "idempotency_key_conflict",
        message: "This queued message ID was already used.",
      };
    }
    if (prior !== undefined) {
      if (userMessageMatchesCommand(prior, command))
        return {
          ok: true,
          kind: "replay",
          conversation: storedConversation,
        };
      return {
        ok: false,
        code: "idempotency_key_conflict",
        message: "This message ID was already used.",
      };
    }
    const duplicate = pendingInputs.find(
      pendingInputHasId.bind(null, command.inputId),
    );
    if (duplicate !== undefined) {
      if (
        duplicate.requestId === command.requestId &&
        pendingInputMatchesCommand(duplicate, command)
      )
        return {
          ok: true,
          kind: "replay",
          conversation: storedConversation,
        };
      return {
        ok: false,
        code: "idempotency_key_conflict",
        message: "This queued input ID was already used.",
      };
    }
    if (
      storedConversation.work.kind !== "running" ||
      storedConversation.work.expiresAt <= Date.now()
    )
      return {
        ok: false,
        code: "chat_not_running",
        message: "The response has finished. Send this as a new message.",
      };
    if (pendingInputs.length >= 8)
      return {
        ok: false,
        code: "chat_queue_full",
        message:
          "The queue is full. Wait for the current response or withdraw a queued message.",
      };
    const pending: PendingChatInput = {
      inputId: command.inputId,
      requestId,
      mode: "next",
      parts: chatInputParts(command),
      acceptedAt: Date.now(),
      ...(command.effort === undefined ? {} : { effort: command.effort }),
    };
    return {
      ok: true,
      kind: "queued",
      conversation: addPendingChatInput(
        { ...storedConversation, draftText: "", draftUpdatedAt: null },
        pending,
      ),
    };
  }
  const now = Date.now();
  if (
    storedConversation.work.kind === "running" &&
    storedConversation.work.expiresAt > now
  )
    return {
      ok: false,
      code: "chat_turn_running",
      message:
        "The AI is still working. Your conversation is saved; refresh to see progress.",
    };
  if (command.kind === "steer")
    return {
      ok: false,
      code: "chat_command_invalid",
      message: "Steering is handled by its dedicated admission path.",
    };
  if (command.kind === "retry") {
    const retryable =
      (storedConversation.work.kind === "failed" &&
        storedConversation.work.requestId === command.requestId) ||
      (storedConversation.work.kind === "running" &&
        storedConversation.work.requestId === command.requestId &&
        storedConversation.work.expiresAt <= now);
    if (!retryable || prior === undefined)
      return {
        ok: false,
        code: "chat_retry_invalid",
        message: "There is no interrupted message to retry.",
      };
  } else if (storedConversation.work.kind === "awaiting_permission")
    return {
      ok: false,
      code: "chat_permission_pending",
      message:
        "The agent is waiting for a permission. Allow or deny it before you send another message.",
    };
  else if (storedConversation.work.kind !== "ready")
    return {
      ok: false,
      code: "chat_retry_required",
      message:
        "Finish or retry the interrupted response before sending another message.",
    };
  if (timelineVisibleMessages(storedConversation).length > 200)
    return {
      ok: false,
      code: "chat_capacity_reached",
      message:
        "This conversation has reached its limit. Start a new chat to continue.",
    };
  const conversation: Conversation = {
    lineage: storedConversation.lineage,
    historyBindings: storedConversation.historyBindings,
    id: storedConversation.id,
    title: storedConversation.title,
    modelRoute: model,
    documents: storedConversation.documents,
    work: storedConversation.work,
    completedRequests: storedConversation.completedRequests,
    pendingInputs: storedConversation.pendingInputs,
    timeline: storedConversation.timeline,
    latestSequence: storedConversation.latestSequence,
    lastReadSequence: storedConversation.lastReadSequence,
    surfaceEventCursor: storedConversation.surfaceEventCursor,
    draftText: command.kind === "retry" ? storedConversation.draftText : "",
    draftUpdatedAt:
      command.kind === "retry" ? storedConversation.draftUpdatedAt : null,
    effort: storedConversation.effort,
  };
  const messages = [...timelineVisibleMessages(conversation)];
  if (command.kind === "message" && prior === undefined)
    messages.push({
      kind: "user",
      id: command.requestId,
      text: command.text,
      browserContext: command.browserContext,
      surfaceContext: command.surfaceContext,
      attachments: command.attachments,
      ...(command.inputMode === undefined
        ? {}
        : { inputMode: command.inputMode }),
      ...surfaceObservationField(command.surfaceObservation),
    });
  const timeline = appendMessageTimelineEvents(
    conversation,
    messages,
    conversationTimeline(conversation),
    command.requestId,
  );
  const lease = crypto.randomUUID();
  const actorIdentity =
    stored === null
      ? initialConversationCaseIdentity(scope, conversation.id)
      : stored.actorIdentity;
  const stream = await conversationStreamIdentity(actorIdentity, lease, 0);
  if (!stream.ok)
    return {
      ok: false,
      code: stream.error,
      message: "Could not create a durable chat turn.",
    };
  return {
    ok: true,
    kind: "admitted",
    conversation: normalizeConversationTimeline({
      lineage: conversation.lineage,
      historyBindings: conversation.historyBindings,
      id: conversation.id,
      title: conversation.title,
      modelRoute: conversation.modelRoute,

      documents: conversation.documents,
      completedRequests: conversation.completedRequests,
      work: {
        kind: "running",
        requestId: command.requestId,
        lease,
        expiresAt: Date.now() + 15 * 60_000,
        stream: stream.value,
      },
      timeline,
      pendingInputs: conversation.pendingInputs,
      latestSequence: conversation.latestSequence,
      lastReadSequence: conversation.lastReadSequence,
      surfaceEventCursor: conversation.surfaceEventCursor,
      draftText: conversation.draftText,
      draftUpdatedAt: conversation.draftUpdatedAt,
      effort: command.effort ?? conversation.effort,
    }),
  };
}

function retryIsAlreadyActive(
  conversation: Conversation,
  requestId: string,
): boolean {
  const work = conversation.work;
  if (work.kind === "running")
    return work.requestId === requestId && work.expiresAt > Date.now();
  return false;
}

export function pendingInputHasId(
  inputId: string,
  input: PendingChatInput,
): boolean {
  return input.inputId === inputId;
}

export function pendingInputText(input: PendingChatInput): string {
  return input.parts.filter(isTextPart).map(readTextPart).join("\n");
}

export function pendingInputMatchesCommand(
  input: PendingChatInput,
  command: Variant<ChatCommand, "message" | "next" | "steer">,
): boolean {
  return (
    pendingInputText(input) === command.text &&
    canonicalJson(attachmentParts(input.parts)) ===
      canonicalJson(command.attachments) &&
    JSON.stringify(browserContextFromParts(input.parts)) ===
      JSON.stringify(command.browserContext) &&
    (pendingInputSurfaceContext(input)?.digest ?? null) ===
      (command.surfaceContext?.digest ?? null)
  );
}

export function userMessageMatchesCommand(
  message: ChatMessage,
  command: Variant<ChatCommand, "message" | "next" | "steer">,
): boolean {
  return (
    message.kind === "user" &&
    message.text === command.text &&
    canonicalJson(message.attachments) === canonicalJson(command.attachments) &&
    JSON.stringify(message.browserContext) ===
      JSON.stringify(command.browserContext) &&
    (message.surfaceContext?.digest ?? null) ===
      (command.surfaceContext?.digest ?? null)
  );
}

function isTextPart(
  part: PendingChatInput["parts"][number],
): part is Variant<PendingChatInput["parts"][number], "text"> {
  return part.kind === "text";
}

function readTextPart(
  part: Variant<PendingChatInput["parts"][number], "text">,
): string {
  return part.text;
}

type Withdrawal =
  | {
      readonly ok: true;
      readonly kind: "replay" | "admitted";
      readonly conversation: Conversation;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function withdrawQueuedInput(
  stored: StoredConversation | null,
  inputId: string,
): Withdrawal {
  if (stored === null)
    return {
      ok: false,
      code: "chat_not_found",
      message: "This chat no longer exists.",
    };
  const pending = stored.conversation.pendingInputs;
  if (!pending.some(pendingInputHasId.bind(null, inputId)))
    return {
      ok: true,
      kind: "replay",
      conversation: stored.conversation,
    };
  return {
    ok: true,
    kind: "admitted",
    conversation: removePendingChatInput(stored.conversation, inputId),
  };
}

export function messageHasId(id: string, message: ChatMessage): boolean {
  return message.id === id;
}
