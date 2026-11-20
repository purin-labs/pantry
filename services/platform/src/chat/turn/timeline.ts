import type { OrganisationDatabase } from "../../database-handles";
import type { Outcome, RequestAuthority } from "@purin-labs/contracts";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { chatInputParts } from "../input-parts";
import type {
  ConversationId,
  ChatReceiptReference,
  ChatToolView,
  ChatTurnUsage,
} from "@purin-labs/control-api";
import {
  bakerySurfaceTimelineResult,
  bakerySurfaceTimelineTool,
} from "../bakery-surface-timeline-labels";
import type { FlowSink } from "../../policy/information-flow";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import {
  parseChatModelAction,
  parseSteeredChatModelAction,
  personDocumentationLinks,
  conversationTimeline,
  timelineVisibleMessages,
  normalizeConversationTimeline,
  type ChatModelAction,
  type ChatMessage,
  type Conversation,
} from "../conversation";
import {
  type ChatTimelineEvent,
  buildAssistantTimelineEvent,
  buildTextTimelineEvent,
  buildUserTimelineEvent,
} from "../timeline";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
  type StoredConversation,
} from "../store";
import {
  listBakerySurfaceTimelineEvents,
  type BakerySurfaceTimelineEvent,
} from "../../actors/bakery-surface-effect";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { timelineEventHasId } from "./admission";
import { appendConfirmedBrowserContext } from "./context";

export function appendMessageTimelineEvents(
  conversation: Conversation,
  messages: readonly ChatMessage[],
  timeline: readonly ChatTimelineEvent[],
  requestId: string,
): readonly ChatTimelineEvent[] {
  const knownMessageIds = new Set(
    timelineVisibleMessages(conversation).map(readMessageId),
  );
  for (const event of timeline) knownMessageIds.add(event.eventId);
  let next = [...timeline];
  for (const message of messages) {
    if (knownMessageIds.has(message.id)) continue;
    next = [
      ...next,
      timelineEventForMessage(message, nextTimelineSequence(next), requestId),
    ];
    knownMessageIds.add(message.id);
  }
  return next;
}

type ConversationModelUsage = Readonly<{
  callsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}>;

export function emptyConversationModelUsage(): ConversationModelUsage {
  return {
    callsWithUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
  };
}

export function addConversationModelUsage(
  current: ConversationModelUsage,
  next: ConversationModelUsage | undefined,
): ConversationModelUsage {
  if (next === undefined) return current;
  return {
    callsWithUsage: current.callsWithUsage + next.callsWithUsage,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cachedInputTokens: current.cachedInputTokens + next.cachedInputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  };
}

export function appendModelUsageToLatestAssistant(
  timeline: readonly ChatTimelineEvent[],
  requestId: string,
  usage: ConversationModelUsage,
): readonly ChatTimelineEvent[] {
  if (usage.callsWithUsage === 0) return timeline;
  const lastAssistant = timeline.findLastIndex(
    (event) => event.kind === "assistant" && event.requestId === requestId,
  );
  if (lastAssistant < 0) return timeline;
  const event = timeline[lastAssistant];
  if (event === undefined || event.kind !== "assistant") return timeline;
  const normalized: ChatTurnUsage = {
    requestId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: usage.totalTokens,
    measuredAt: Date.now(),
  };
  return [
    ...timeline.slice(0, lastAssistant),
    { ...event, usage: normalized },
    ...timeline.slice(lastAssistant + 1),
  ];
}

function readMessageId(message: ChatMessage): string {
  return message.id;
}

function timelineEventForMessage(
  message: ChatMessage,
  sequence: number,
  requestId: string,
): ChatTimelineEvent {
  const base = {
    eventId: message.id,
    sequence,
    requestId,
    createdAt: Date.now(),
  };
  switch (message.kind) {
    case "user":
      return buildUserTimelineEvent({
        ...base,
        text: message.text,
        parts: chatInputParts(message),
      });
    case "assistant":
      return buildAssistantTimelineEvent({ ...base, text: message.text });
    case "activity":
    case "context":
      return buildTextTimelineEvent({
        ...base,
        kind: message.kind,
        text: message.text,
      });
    case "connector":
      return {
        ...base,
        kind: "connector",
        text: message.text,
        document: message.document,
        target: message.target,
      };
  }
}

export function nextTimelineSequence(
  timeline: readonly ChatTimelineEvent[],
): number {
  const last = timeline[timeline.length - 1];
  return (last?.sequence ?? 0) + 1;
}

export function documentationTool(
  url: string,
  requestId: string,
  step: number,
): ChatToolView {
  return {
    toolCallId: `tool_${requestId}_${step}`,
    action: "Read documentation",
    object: "API documentation",
    destination: safeUrlHost(url),
    risk: "read",
    detailsExpandable: true,
  };
}

function safeUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function appendToolStartedTimelineEvent(
  timeline: readonly ChatTimelineEvent[],
  requestId: string,
  tool: ChatToolView,
): readonly ChatTimelineEvent[] {
  return [
    ...timeline,
    {
      eventId: crypto.randomUUID(),
      sequence: nextTimelineSequence(timeline),
      requestId,
      createdAt: Date.now(),
      kind: "tool_started",
      tool,
    },
  ];
}

export function appendToolSettledTimelineEvent(
  timeline: readonly ChatTimelineEvent[],
  requestId: string,
  tool: ChatToolView,
  outcome: "succeeded" | "failed" | "denied" | "indeterminate",
  summary: string,
  receipt: ChatReceiptReference | null,
): readonly ChatTimelineEvent[] {
  return [
    ...timeline,
    {
      eventId: crypto.randomUUID(),
      sequence: nextTimelineSequence(timeline),
      requestId,
      createdAt: Date.now(),
      kind: "tool_settled",
      tool,
      outcome,
      summary,
      receipt,
    },
  ];
}

export async function appendBakerySurfaceTimelineEvents(input: {
  readonly db: OrganisationDatabase;
  readonly scope: ConversationScope;
  readonly conversation: Conversation;
  readonly timeline: readonly ChatTimelineEvent[];
}): Promise<{
  readonly timeline: readonly ChatTimelineEvent[];
  readonly cursor: number;
}> {
  let timeline = input.timeline;
  let cursor = input.conversation.surfaceEventCursor;
  const work = input.conversation.work;
  if (work.kind === "ready" || work.kind === "failed")
    return { timeline, cursor };
  for (let page = 0; page < 10; page += 1) {
    const events = await listBakerySurfaceTimelineEvents({
      db: input.db,
      organisationId: input.scope.organisationId,
      userId: input.scope.userId,
      requestIds: [work.requestId],
      afterSequence: cursor,
    });
    if (events.length === 0) break;
    for (const event of events) {
      cursor = event.sequence;
      timeline = appendBakerySurfaceTimelineEvent(
        timeline,
        event,
        work.requestId,
      );
    }
    if (events.length < 100) break;
  }
  return { timeline, cursor };
}

export async function reconcileStoredBakerySurfaceTimeline(
  placement: OrganisationExecutionScope,
  userId: UserId,
  stored: StoredConversation,
): Promise<StoredConversation> {
  const scope: ConversationScope = {
    organisationId: placement.organisationId,
    userId,
  };
  const db = placement.database;
  let current = stored;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projected = await appendBakerySurfaceTimelineEvents({
      db,
      scope,
      conversation: current.conversation,
      timeline: conversationTimeline(current.conversation),
    });
    if (projected.cursor === current.conversation.surfaceEventCursor)
      return current;
    const conversation = normalizeConversationTimeline({
      ...current.conversation,
      timeline: projected.timeline,
      surfaceEventCursor: projected.cursor,
    });
    if (
      (
        await saveConversation(
          placement,
          scope.userId,
          conversation,
          current.revision,
        )
      ).kind === "saved"
    )
      return {
        conversation,
        actorIdentity: current.actorIdentity,
        sharing: current.sharing,
        metadata: current.metadata,
        placement: current.placement,
        inheritsProject: current.inheritsProject,
        revision: current.revision + 1,
      };
    const latest = await readConversation(db, scope, current.conversation.id);
    if (latest === null) return current;
    current = latest;
  }
  return current;
}

function appendBakerySurfaceTimelineEvent(
  timeline: readonly ChatTimelineEvent[],
  event: BakerySurfaceTimelineEvent,
  requestId: string,
): readonly ChatTimelineEvent[] {
  timeline = appendConfirmedBrowserContext(timeline, event, requestId);
  const suffix = event.terminal.kind === "started" ? "started" : "settled";
  const eventId = `surface_tool_${suffix}_${event.effect.effectId}`;
  if (timeline.some(timelineEventHasId.bind(null, eventId))) return timeline;
  const tool = bakerySurfaceTimelineTool(event);
  if (event.terminal.kind === "started")
    return [
      ...timeline,
      {
        eventId,
        sequence: nextTimelineSequence(timeline),
        requestId,
        createdAt: event.createdAt,
        kind: "tool_started",
        tool,
      },
    ];
  if (event.terminal.kind === "indeterminate")
    return [
      ...timeline,
      {
        eventId,
        sequence: nextTimelineSequence(timeline),
        requestId,
        createdAt: event.createdAt,
        kind: "tool_settled",
        tool,
        outcome: "indeterminate",
        summary:
          "Kitchen delivery began, but its final browser outcome is unknown.",
        receipt: null,
      },
    ];
  const result = bakerySurfaceTimelineResult(event);
  return [
    ...timeline,
    {
      eventId,
      sequence: nextTimelineSequence(timeline),
      requestId,
      createdAt: event.createdAt,
      kind: "tool_settled",
      tool,
      outcome: result.outcome,
      summary: result.summary,
      receipt: result.receipt,
    },
  ];
}

export function chatActionFlowSink(
  action: ChatModelAction,
  authority: Variant<RequestAuthority, "control">,
  conversationId: ConversationId,
): FlowSink {
  switch (action.kind) {
    case "question":
    case "reply":
      return {
        kind: "conversation_delivery",
        destinationAuthority: authority,
      };
    case "read_documentation":
      return {
        kind: "tool_effect",
        destinationAuthority: authority,
        capabilityId: CAPABILITY_KEYS.messageLinkRead,
        integrationAccountId: "portal_chat",
        resourceScope: action.url,
        approvalSatisfied: false,
      };
    case "definition":
      return customConnectorDraftSink(authority, conversationId);
    case "revise":
      return customConnectorDraftSink(authority, action.connectorId);
  }
}

function customConnectorDraftSink(
  authority: Variant<RequestAuthority, "control">,
  resourceScope: string,
): FlowSink {
  return {
    kind: "tool_effect",
    destinationAuthority: authority,
    capabilityId: CAPABILITY_KEYS.customConnectorDraft,
    integrationAccountId: "portal_chat",
    resourceScope,
    approvalSatisfied: false,
  };
}

/**
 * A documentation read must name a link that a person wrote in this chat.
 * Any other URL is refused before the sink decision and fetches nothing; the
 * next model step is told which links it may read.
 */
export function writtenDocumentationAction(
  action: ReturnType<typeof parseChatModelAction>,
  messages: readonly ChatMessage[],
): ReturnType<typeof parseChatModelAction> {
  if (!action.ok || action.value.kind !== "read_documentation") return action;
  const links = personDocumentationLinks(messages);
  if (links.includes(action.value.url)) return action;
  return {
    ok: false,
    error:
      links.length === 0
        ? "Read documentation only from a link that a person wrote in this chat. Nobody wrote one, so ask the person for the documentation link."
        : `Read documentation only from a link that a person wrote in this chat: ${links.join(", ")}`,
  };
}

export function completedChatAction(
  completion: {
    readonly finalMessage: string;
    readonly outcome: Outcome;
  },
  steered: boolean,
): ReturnType<typeof parseChatModelAction> {
  switch (completion.outcome.status) {
    case "success":
      return steered
        ? parseSteeredChatModelAction(completion.finalMessage)
        : parseChatModelAction(completion.finalMessage);
    case "partial":
    case "failed":
      return {
        ok: true,
        value: {
          kind: "reply",
          text: completion.outcome.summary ?? completion.finalMessage,
        },
      };
    default:
      return assertNever(completion.outcome.status);
  }
}
