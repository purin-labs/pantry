import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { chatUserMessage } from "../attachments";
import {
  attachmentParts,
  surfaceObservationField,
  surfaceObservationFromParts,
  type PendingChatInput,
} from "../timeline";
import { chatInputParts, pendingInputSurfaceContext } from "../input-parts";
import {
  browserContextFromParts,
  inputModeFromParts,
  removePendingChatInput,
  conversationTimeline,
  timelineVisibleMessages,
  normalizeConversationTimeline,
  type ChatMessage,
  type Conversation,
  type ChatCommand,
} from "../conversation";
import type { Env } from "@purin-labs/kernel/env";
import type { SessionActorStub } from "../../actors/actor-stubs";
import { parseRequestId } from "@purin-labs/kernel/ids";
import { resolveActiveSessionActorAtPlacement } from "../../actors/actor-router";
import type { OrganisationModelRoute } from "../../models/route";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
  type StoredConversation,
} from "../store";
import type { Variant } from "@purin-labs/type-utils";
import {
  type Admission,
  messageHasId,
  pendingInputHasId,
  pendingInputMatchesCommand,
  pendingInputText,
  userMessageMatchesCommand,
} from "./admission";
import { appendMessageTimelineEvents } from "./timeline";

export function admitSteering(
  stored: StoredConversation | null,
  command: Variant<ChatCommand, "steer">,
  model: OrganisationModelRoute,
): Admission {
  if (
    stored === null ||
    JSON.stringify(stored.conversation.modelRoute) !== JSON.stringify(model)
  )
    return {
      ok: false,
      code: "chat_model_changed",
      message: "Open a conversation using the current workspace model.",
    };
  const conversation = stored.conversation;
  const prior = timelineVisibleMessages(conversation).find(
    messageHasId.bind(null, command.requestId),
  );
  const pending = conversation.pendingInputs.find(
    pendingInputHasRequestId.bind(null, command.requestId),
  );
  if (prior !== undefined || pending !== undefined) {
    if (
      (prior !== undefined && userMessageMatchesCommand(prior, command)) ||
      (pending !== undefined && pendingInputMatchesCommand(pending, command))
    )
      return { ok: true, kind: "replay", conversation };
    return {
      ok: false,
      code: "idempotency_key_conflict",
      message: "This message ID was already used.",
    };
  }
  if (
    conversation.work.kind !== "running" ||
    conversation.work.expiresAt <= Date.now()
  )
    return {
      ok: false,
      code: "chat_not_running",
      message: "The response has finished. Send this as a new message.",
    };
  if (timelineVisibleMessages(conversation).length > 200)
    return {
      ok: false,
      code: "chat_capacity_reached",
      message: "Start a new chat to continue.",
    };
  return {
    ok: true,
    kind: "admitted",
    conversation: normalizeConversationTimeline({
      ...conversation,
      work: {
        kind: "cancelling",
        requestId: conversation.work.requestId,
        cancellationId: command.cancellationId,
        lease: conversation.work.lease,
        expiresAt: conversation.work.expiresAt,
        stream: conversation.work.stream,
      },
      pendingInputs: [
        {
          inputId: command.inputId,
          requestId: command.requestId,
          mode: "steer",
          parts: chatInputParts(command),
          acceptedAt: Date.now(),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
        },
        ...conversation.pendingInputs,
      ],
      draftText: "",
      draftUpdatedAt: null,
      effort: command.effort ?? conversation.effort,
    }),
  };
}

type QueuedSteering =
  | {
      readonly ok: true;
      /** "current": the message already left the queue, and nothing changes. */
      readonly kind: "current" | "admitted" | "cancelling";
      readonly conversation: Conversation;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The cancel path of a queued message: the running turn stops and the message
 * runs first. It keeps its ids, its files and its context, so a failure at any
 * step leaves the message in the queue.
 */
export function admitQueuedSteering(
  stored: StoredConversation | null,
  command: Variant<ChatCommand, "steer_queued">,
  model: OrganisationModelRoute,
): QueuedSteering {
  if (
    stored === null ||
    JSON.stringify(stored.conversation.modelRoute) !== JSON.stringify(model)
  )
    return {
      ok: false,
      code: "chat_model_changed",
      message: "Open a conversation using the current workspace model.",
    };
  const conversation = stored.conversation;
  const pending = conversation.pendingInputs.find(
    pendingInputHasId.bind(null, command.inputId),
  );
  if (pending === undefined) return { ok: true, kind: "current", conversation };
  // A second click: the first one may still be settling, or may have finished.
  if (pending.mode === "steer")
    return {
      ok: true,
      kind: conversation.work.kind === "cancelling" ? "cancelling" : "current",
      conversation,
    };
  if (
    conversation.work.kind !== "running" ||
    conversation.work.expiresAt <= Date.now()
  )
    return {
      ok: false,
      code: "chat_not_running",
      message: "No response is running now. This message stays in the queue.",
    };
  return {
    ok: true,
    kind: "admitted",
    conversation: {
      ...conversation,
      work: {
        kind: "cancelling",
        requestId: conversation.work.requestId,
        cancellationId: command.cancellationId,
        lease: conversation.work.lease,
        expiresAt: conversation.work.expiresAt,
        stream: conversation.work.stream,
      },
      pendingInputs: [
        { ...pending, mode: "steer" },
        ...conversation.pendingInputs.filter(
          (input) => input.inputId !== command.inputId,
        ),
      ],
      effort: pending.effort ?? conversation.effort,
    },
  };
}

/**
 * A queued message as a steer that can join the running turn, on the
 * conversation without that message. Null when the message left the queue.
 */
export function queuedInputAsSteering(
  stored: StoredConversation | null,
  command: Variant<ChatCommand, "steer_queued">,
): {
  readonly stored: StoredConversation;
  readonly command: Variant<ChatCommand, "steer">;
} | null {
  const pending = stored?.conversation.pendingInputs.find(
    pendingInputHasId.bind(null, command.inputId),
  );
  if (stored === null || stored === undefined || pending === undefined)
    return null;
  return {
    stored: {
      ...stored,
      conversation: removePendingChatInput(
        stored.conversation,
        command.inputId,
      ),
    },
    command: {
      kind: "steer",
      conversationId: command.conversationId,
      requestId: pending.requestId,
      inputId: pending.inputId,
      cancellationId: command.cancellationId,
      model: command.model,
      text: pendingInputText(pending),
      browserContext: browserContextFromParts(pending.parts),
      surfaceContext: pendingInputSurfaceContext(pending),
      attachments: attachmentParts(pending.parts),
      ...(pending.effort === undefined ? {} : { effort: pending.effort }),
      ...inputModeFromParts(pending.parts),
      ...surfaceObservationFromParts(pending.parts),
    },
  };
}

/**
 * Join a message to the running turn (Plan 71). The turn's Session admits it
 * when its harness steers and the sender is the turn's requester; the turn
 * then continues, and the model reads the message before its next request.
 * The message enters the timeline at once. Null means that the message did
 * not join the turn: a replay, a message with files or context, or a refusal
 * by the Session. The caller then uses the cancel-and-queue path.
 */
export async function steerRunningConversation(input: {
  readonly env: Env;
  readonly placement: OrganisationExecutionScope;
  readonly scope: ConversationScope;
  readonly stored: StoredConversation | null;
  /** A steer, or a message for the next turn that joins this one first. */
  readonly command: Variant<ChatCommand, "steer" | "next">;
  readonly model: OrganisationModelRoute;
  /** A queued message is not the composer's text, so the draft stays. */
  readonly keepsDraft?: boolean;
}): Promise<{
  readonly conversation: Conversation;
  readonly revision: number;
} | null> {
  const { stored, command } = input;
  if (
    stored === null ||
    JSON.stringify(stored.conversation.modelRoute) !==
      JSON.stringify(input.model) ||
    !steersNatively(stored.conversation, command)
  )
    return null;
  const work = stored.conversation.work;
  const requestId = parseRequestId(command.requestId);
  if (work.kind !== "running" || work.expiresAt <= Date.now() || !requestId.ok)
    return null;
  const actor = await resolveActiveSessionActorAtPlacement({
    placement: input.placement.placement,
    env: input.env,
    namespace: input.env.SESSION,
    organisationId: input.scope.organisationId,
    sessionId: work.stream.sessionId,
    now: Date.now(),
  });
  if (!actor.ok) return null;
  const steered = await steerSession(actor.value, {
    organisationId: input.scope.organisationId,
    sessionId: work.stream.sessionId,
    requestId: requestId.value,
    requester: { kind: "user", userId: String(input.scope.userId) },
    text: command.text,
    message: await chatUserMessage(
      input.env.ARCHIVE,
      input.scope.organisationId,
      command.text,
      [],
    ),
  });
  if (!steered.ok || steered.value.kind !== "accepted") return null;
  // The turn holds the message now. Its timeline entry must not be lost to a
  // save that ran beside this one.
  let latest = { conversation: stored.conversation, revision: stored.revision };
  for (let attempt = 0; attempt < STEERING_SAVE_ATTEMPTS; attempt += 1) {
    const steeredMessage = withSteeringMessage(
      latest.conversation,
      command,
      work.requestId,
    );
    const steeredConversation =
      input.keepsDraft === true
        ? {
            ...steeredMessage,
            draftText: latest.conversation.draftText,
            draftUpdatedAt: latest.conversation.draftUpdatedAt,
          }
        : steeredMessage;
    const saved = await saveConversation(
      input.placement,
      input.scope.userId,
      steeredConversation,
      latest.revision,
    );
    if (saved.kind === "saved")
      return {
        conversation: steeredConversation,
        revision: latest.revision + 1,
      };
    const reread = await readConversation(
      input.placement.database,
      input.scope,
      stored.conversation.id,
    );
    if (reread === null) break;
    latest = reread;
  }
  // A retry of the request finds the admitted input and saves it again.
  throw new Error("chat_steering_save_failed");
}

const STEERING_SAVE_ATTEMPTS = 5;

/** A Session that cannot answer leaves the message to the cancel path. */
async function steerSession(
  actor: Pick<SessionActorStub, "steerCanonicalEmbeddedHarnessTurn">,
  input: Parameters<SessionActorStub["steerCanonicalEmbeddedHarnessTurn"]>[0],
): Promise<
  | Awaited<ReturnType<SessionActorStub["steerCanonicalEmbeddedHarnessTurn"]>>
  | { readonly ok: false }
> {
  try {
    return await actor.steerCanonicalEmbeddedHarnessTurn(input);
  } catch {
    return { ok: false };
  }
}

/**
 * A message joins the running turn natively when it adds only text: it is
 * new, has no files, and keeps the turn's effort. The turn keeps the browser
 * and the Bakery surface of the message that started it, so the steer may
 * carry none of them or the same ones; the Portal sends its browser binding
 * with every message.
 */
function steersNatively(
  conversation: Conversation,
  command: Variant<ChatCommand, "steer" | "next">,
): boolean {
  const turnMessage =
    timelineVisibleMessages(conversation).findLast(isUserChatMessage);
  return (
    turnMessage !== undefined &&
    command.attachments.length === 0 &&
    (command.surfaceContext === null ||
      JSON.stringify(command.surfaceContext) ===
        JSON.stringify(turnMessage.surfaceContext)) &&
    (command.browserContext.kind !== "available" ||
      JSON.stringify(command.browserContext) ===
        JSON.stringify(turnMessage.browserContext)) &&
    (command.effort === undefined || command.effort === conversation.effort) &&
    !timelineVisibleMessages(conversation).some(
      messageHasId.bind(null, command.requestId),
    ) &&
    !conversation.pendingInputs.some(
      pendingInputHasRequestId.bind(null, command.requestId),
    )
  );
}

/** A steering message joined the request: it has a second user message. */
export function requestWasSteered(
  conversation: Conversation,
  requestId: string,
): boolean {
  return (
    conversationTimeline(conversation).filter(function isRequestMessage(event) {
      return event.kind === "user" && event.requestId === requestId;
    }).length > 1
  );
}

function isUserChatMessage(
  message: ChatMessage,
): message is Variant<ChatMessage, "user"> {
  return message.kind === "user";
}

/**
 * The message belongs to the request of the turn that it joined: that
 * request's history holds it. Its own request id is the event's id.
 */
function withSteeringMessage(
  conversation: Conversation,
  command: Variant<ChatCommand, "steer" | "next">,
  steeredRequestId: string,
): Conversation {
  const messages: ChatMessage[] = [
    ...timelineVisibleMessages(conversation),
    {
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
    },
  ];
  return normalizeConversationTimeline({
    ...conversation,
    timeline: appendMessageTimelineEvents(
      conversation,
      messages,
      conversationTimeline(conversation),
      steeredRequestId,
    ),
    // A queued message that joins the turn leaves the queue in the same save.
    pendingInputs: conversation.pendingInputs.filter(
      (input) => input.requestId !== command.requestId,
    ),
    draftText: "",
    draftUpdatedAt: null,
  });
}

export function pendingInputHasRequestId(
  requestId: string,
  input: PendingChatInput,
): boolean {
  return input.requestId === requestId;
}
