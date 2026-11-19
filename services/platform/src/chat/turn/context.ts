import type { UserId } from "../../ids";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { sha256Hex, assertNever } from "@purin-labs/std";
import type { ChatContextDetails } from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import type { BakerySurfaceAttachmentV1 } from "@purin-labs/bakery-model/bakery-surface";
import type { Env } from "../../env";
import { resolveActiveSessionActorAtPlacement } from "../../actors/actor-router";
import {
  conversationTimeline,
  timelineVisibleMessages,
  normalizeConversationTimeline,
  type ChatMessage,
  type Conversation,
} from "../conversation";
import type { ChatTimelineEvent } from "../timeline";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
  type StoredConversation,
} from "../store";
import type { BakerySurfaceTimelineEvent } from "../../actors/bakery-surface-effect";
import type { Variant } from "@purin-labs/type-utils";
import { timelineEventHasId } from "./admission";
import { nextTimelineSequence } from "./timeline";

export function documentHasUrl(
  url: string,
  document: { readonly url: string },
): boolean {
  return document.url === url;
}

export function currentUserMessage(
  conversation: Conversation,
): Variant<ChatMessage, "user"> {
  const messages = timelineVisibleMessages(conversation);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "user") return message;
  }
  throw new Error("chat_user_message_missing");
}

export function newerSurface(
  capture: BakerySurfaceAttachmentV1,
  latest: BakerySurfaceAttachmentV1 | null,
): BakerySurfaceAttachmentV1 | null {
  return latest !== null &&
    latest.context.capturedAt > capture.context.capturedAt
    ? latest
    : null;
}

export function conversationRequestIds(
  conversation: Conversation,
  requestId: string,
): readonly string[] {
  const ids = new Set([requestId]);
  for (const event of conversationTimeline(conversation))
    if ("requestId" in event && typeof event.requestId === "string")
      ids.add(event.requestId);
  return [...ids];
}

export function currentUserSurfaceContext(
  conversation: Conversation,
): Variant<ChatMessage, "user">["surfaceContext"] {
  const messages = timelineVisibleMessages(conversation);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "user") return message.surfaceContext;
  }
  throw new Error("chat_user_message_missing");
}

export function currentUserBrowserContext(
  conversation: Conversation,
): BakeryBrowserContext {
  for (const message of timelineVisibleMessages(conversation).toReversed())
    if (message.kind === "user") return message.browserContext;
  return { kind: "unavailable" };
}

export function appendConfirmedBrowserContext(
  timeline: readonly ChatTimelineEvent[],
  event: BakerySurfaceTimelineEvent,
  requestId: string,
): readonly ChatTimelineEvent[] {
  if (event.effect.command.kind !== "prepare_context") {
    if (
      event.terminal.kind !== "settled" ||
      event.terminal.receipt.outcome.kind !== "completed" ||
      event.terminal.receipt.outcome.result.kind !== "succeeded"
    )
      return timeline;
    const surface = event.terminal.receipt.outcome.result.surface;
    const previous = timeline.findLast(isReadyContextEvent);
    if (
      previous === undefined ||
      previous.contextDetails?.kind !== "ready" ||
      previous.requestId !== requestId ||
      previous.contextDetails.surfaceSessionId !==
        surface.context.surfaceSessionId
    )
      return timeline;
    const eventId = `context_result_${event.effect.effectId}`;
    if (timeline.some(timelineEventHasId.bind(null, eventId))) return timeline;
    const contextDetails: ChatContextDetails = {
      kind: "ready",
      area: "BakeryOS",
      effectId: event.effect.effectId,
      browserInstanceId: previous.contextDetails.browserInstanceId,
      surfaceSessionId: surface.context.surfaceSessionId,
      surfaceEpoch: surface.context.surfaceEpoch,
      digest: surface.digest,
      observedAt: surface.context.capturedAt,
    };
    return [
      ...timeline,
      {
        kind: "context",
        eventId,
        sequence: nextTimelineSequence(timeline),
        requestId,
        createdAt: event.createdAt,
        text: "Kitchen browser context confirmed by command receipt.",
        contextDetails,
      },
    ];
  }
  const eventId = `context_${event.terminal.kind}_${event.effect.effectId}`;
  if (timeline.some(timelineEventHasId.bind(null, eventId))) return timeline;
  const base = { area: "BakeryOS", effectId: event.effect.effectId } as const;
  let contextDetails: ChatContextDetails;
  let text: string;
  switch (event.terminal.kind) {
    case "started":
      contextDetails = { ...base, kind: "preparing" };
      text = "Loading Kitchen…";
      break;
    case "indeterminate":
      contextDetails = {
        ...base,
        kind: "failed",
        message: "Browser readiness is unavailable.",
      };
      text = contextDetails.message;
      break;
    case "settled": {
      const outcome = event.terminal.receipt.outcome;
      if (outcome.kind === "prepared") {
        contextDetails = {
          ...base,
          kind: "ready",
          browserInstanceId: outcome.binding.browserInstanceId,
          surfaceSessionId: outcome.surface.context.surfaceSessionId,
          surfaceEpoch: outcome.surface.context.surfaceEpoch,
          digest: outcome.surface.digest,
          observedAt: outcome.surface.context.capturedAt,
        };
        text = "Kitchen browser readiness confirmed.";
      } else {
        const message =
          outcome.kind === "delivery_failed"
            ? outcome.message
            : "Invalid preparation result.";
        contextDetails = {
          ...base,
          kind:
            outcome.kind === "delivery_failed" &&
            outcome.code === "effect_cancelled"
              ? "cancelled"
              : "failed",
          message,
        };
        text = message;
      }
      break;
    }
    default:
      return assertNever(event.terminal);
  }
  return [
    ...timeline,
    {
      kind: "context",
      eventId,
      sequence: nextTimelineSequence(timeline),
      requestId,
      createdAt: event.createdAt,
      text,
      contextDetails,
    },
  ];
}

export async function appendConfirmedSourceContexts(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversation: Conversation,
  timeline: readonly ChatTimelineEvent[],
): Promise<readonly ChatTimelineEvent[]> {
  const work = conversation.work;
  if (work.kind !== "running" && work.kind !== "cancelling") return timeline;
  const actor = await resolveActiveSessionActorAtPlacement({
    placement: placement.placement,
    env: env,
    namespace: env.SESSION,
    organisationId: scope.organisationId,
    sessionId: work.stream.sessionId,
    now: Date.now(),
  });
  if (!actor.ok) return timeline;
  const observations = await actor.value.readConfirmedContextObservations({
    requestingOrganisationId: scope.organisationId,
    sessionId: work.stream.sessionId,
  });
  for (const contextDetails of observations) {
    if (contextDetails.kind !== "observed") continue;
    const eventId = `context_source_${work.requestId}_${await sha256Hex(JSON.stringify(contextDetails))}`;
    if (timeline.some(timelineEventHasId.bind(null, eventId))) continue;
    timeline = [
      ...timeline,
      {
        kind: "context",
        eventId,
        sequence: nextTimelineSequence(timeline),
        requestId: work.requestId,
        createdAt: contextDetails.source.observedAt,
        text: `Read ${contextDetails.area} context.`,
        contextDetails,
      },
    ];
  }
  return timeline;
}

export async function reconcileStoredContextObservations(
  env: Env,
  placement: OrganisationExecutionScope,
  userId: UserId,
  stored: StoredConversation,
): Promise<StoredConversation> {
  const scope: ConversationScope = {
    organisationId: placement.organisationId,
    userId,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = conversationTimeline(stored.conversation);
    const timeline = await appendConfirmedSourceContexts(
      env,
      placement,
      scope,
      stored.conversation,
      before,
    );
    if (timeline === before) return stored;
    const conversation = normalizeConversationTimeline({
      ...stored.conversation,
      timeline,
    });
    const saved = await saveConversation(
      placement,
      scope.userId,
      conversation,
      stored.revision,
    );
    if (saved.kind === "saved")
      return {
        conversation,
        actorIdentity: stored.actorIdentity,
        sharing: stored.sharing,
        metadata: stored.metadata,
        placement: stored.placement,
        inheritsProject: stored.inheritsProject,
        revision: stored.revision + 1,
      };
    const latest = await readConversation(
      placement.database,
      scope,
      stored.conversation.id,
    );
    if (latest === null) return stored;
    stored = latest;
  }
  return stored;
}

function isReadyContextEvent(
  event: ChatTimelineEvent,
): event is Variant<ChatTimelineEvent, "context" | "activity" | "progress"> {
  return (
    (event.kind === "context" ||
      event.kind === "activity" ||
      event.kind === "progress") &&
    event.contextDetails?.kind === "ready"
  );
}

export function sharedMemberUserId(member: {
  userId: import("../../ids").UserId;
}): import("../../ids").UserId {
  return member.userId;
}
