import {
  attachmentParts,
  surfaceObservationFromParts,
  type ChatAttachmentPart,
} from "./timeline";
import {
  parsePortalPageView,
  parseSurfaceObservation,
  surfaceObservationFromPageView,
  type SurfaceObservationV2,
} from "@purin-labs/control-api";
import type { ChatOrigin } from "@purin-labs/control-api";
import { chatOrigin, chatOriginField } from "./origin";
import {
  admitKitchenState,
  kitchenAttachment,
  oldKitchenAttachmentIsIntact,
  withOldKitchenAttachment,
} from "./kitchen-observation";
import {
  isConversationId,
  parseChatPermissionRequest,
} from "@purin-labs/control-api";
import type { ChatPermissionRequest, ConversationId } from "@purin-labs/control-api";
import { parseChatInputMode, type ChatInputMode } from "@purin-labs/control-api";
import {
  parseChatThreadLineage,
  parseChatHistoryBindings,
  type ChatThreadLineage,
  type ChatHistoryBinding,
} from "./fork-history";
import {
  parsePageBrowserContext,
  type ModelRoute,
  type PageBrowserContext,
} from "@purin-labs/contracts";
import { parseSessionModelRoute } from "../policy-snapshot";
import type { JsonRecord } from "../control/http";
import {
  parseCustomConnectorId,
  type CustomConnectorId,
} from "../custom-connectors/identity";
import type { Result } from "../result";
import { parseSessionId, type SessionId } from "../ids";
import {
  parseChatTimelineEvent,
  parseInputParts,
  type ChatInputPart,
  type ChatTimelineEvent,
  type PendingChatInput,
} from "./timeline";
import {
  parseBakerySurfaceAttachment,
  type BakerySurfaceAttachmentV1,
} from "@purin-labs/bakery-model/bakery-surface";
import type { Variant } from "@purin-labs/type-utils";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";
import {
  type ChatEffort,
  type ChatQuestion,
  parseChatQuestion,
} from "@purin-labs/control-api";
export type ConnectorCardTarget =
  | {
      readonly kind: "new";
      readonly connectorId?: never;
      readonly expectedHeadRevision?: never;
    }
  | {
      readonly kind: "revision";
      readonly connectorId: CustomConnectorId;
      readonly expectedHeadRevision: number;
    };

export type ChatMessage =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly browserContext: PageBrowserContext;
      readonly surfaceContext: BakerySurfaceAttachmentV1 | null;
      readonly attachments: readonly ChatAttachmentPart[];
      readonly inputMode?: ChatInputMode;
      /** The Portal page on the sender's screen at send time. */
      readonly surfaceObservation?: SurfaceObservationV2;
      readonly document?: never;
      readonly target?: never;
    }
  | {
      readonly kind: "assistant" | "activity" | "context";
      readonly id: string;
      readonly text: string;
      readonly document?: never;
      readonly target?: never;
    }
  | {
      readonly kind: "connector";
      readonly id: string;
      readonly text: string;
      readonly document: JsonRecord;
      readonly target: ConnectorCardTarget;
    };

export type ConversationWork =
  | {
      readonly kind: "ready";
      readonly requestId?: never;
      readonly lease?: never;
      readonly expiresAt?: never;
      readonly stream?: never;
      readonly error?: never;
      readonly recovery?: never;
    }
  | {
      readonly kind: "running";
      readonly requestId: string;
      readonly lease: string;
      readonly expiresAt: number;
      readonly stream: ConversationStream;
      readonly error?: never;
      readonly recovery?: never;
    }
  | {
      readonly kind: "awaiting_permission";
      readonly requestId: string;
      /** The step that runs again, under a new lease, after a resume. */
      readonly step: number;
      readonly permission: ChatPermissionRequest;
      /**
       * The paused step. Its turn binding decides who may read the request. A
       * pause saved before this field has none, and its read stays refused.
       */
      readonly stream: ConversationStream | null;
      readonly lease?: never;
      readonly expiresAt?: never;
      readonly cancellationId?: never;
      readonly error?: never;
      readonly recovery?: never;
    }
  | {
      readonly kind: "cancelling";
      readonly requestId: string;
      readonly cancellationId: string;
      readonly lease: string;
      readonly expiresAt: number;
      readonly stream: ConversationStream;
      readonly approval?: never;
      readonly nextStep?: never;
      readonly error?: never;
      readonly recovery?: never;
    }
  | {
      readonly kind: "failed";
      readonly requestId: string;
      readonly error: string;
      readonly recovery: {
        readonly kind: "projection_capacity" | "interrupted";
        readonly lease: string;
        readonly stream: ConversationStream;
      } | null;
      readonly lease?: never;
      readonly expiresAt?: never;
      readonly stream?: never;
    };

// A failed turn can be retried and a queued message is sent later. Each runs
// with the Project context bound when it was admitted, so a chat stays in its
// Project while it holds either. A turn stopped at the storage limit cannot
// run again and holds nothing.
export function holdsAdmittedWork(
  work: ConversationWork,
  queuedInputs: number,
): boolean {
  return (
    queuedInputs > 0 ||
    (work.kind === "failed" && work.recovery?.kind !== "projection_capacity")
  );
}

export type ConversationStream = {
  readonly step: number;
  readonly sessionId: SessionId;
  readonly turnId: string;
};

/** A documentation page that a chat read, as the chat record stores it. */
export type ConversationDocument = {
  readonly url: string;
  readonly sha256: string;
  readonly text: string;
  readonly truncated: boolean;
};

export type Conversation = {
  readonly lineage: ChatThreadLineage;
  readonly historyBindings: readonly ChatHistoryBinding[];
  readonly id: ConversationId;
  readonly title: string;
  readonly modelRoute: ModelRoute;
  readonly documents: readonly ConversationDocument[];
  readonly work: ConversationWork;
  readonly completedRequests: readonly string[];
  readonly timeline: readonly ChatTimelineEvent[];
  readonly pendingInputs: readonly PendingChatInput[];
  readonly latestSequence: number;
  readonly lastReadSequence: number;
  readonly surfaceEventCursor: number;
  readonly draftText: string;
  readonly draftUpdatedAt: number | null;
  readonly effort: ChatEffort | null;
  /** Where the chat started; a chat whose first message carried no page has none (Plan 87). */
  readonly origin?: ChatOrigin;
};

export type ChatCommand =
  | {
      readonly kind: "message";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly model: string;
      readonly text: string;
      readonly inputId?: never;
      readonly cancellationId?: never;
      readonly effort?: ChatEffort;
      /** Sets the message as the chat's goal with this budget, before the turn starts. */
      readonly goalTokenBudget?: number;
      readonly browserContext: PageBrowserContext;
      readonly surfaceContext: BakerySurfaceAttachmentV1 | null;
      readonly attachments: readonly ChatAttachmentPart[];
      /** Present on a spoken command (Plan 82). */
      readonly inputMode?: ChatInputMode;
      /** The Portal page on the sender's screen at send time. */
      readonly surfaceObservation?: SurfaceObservationV2;
    }
  | {
      readonly kind: "steer";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly inputId: string;
      readonly cancellationId: string;
      readonly model: string;
      readonly text: string;
      readonly effort?: ChatEffort;
      readonly browserContext: PageBrowserContext;
      readonly surfaceContext: BakerySurfaceAttachmentV1 | null;
      readonly attachments: readonly ChatAttachmentPart[];
      /** Present on a spoken command (Plan 82). */
      readonly inputMode?: ChatInputMode;
      /** The Portal page on the sender's screen at send time. */
      readonly surfaceObservation?: SurfaceObservationV2;
    }
  | {
      readonly kind: "next";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly model: string;
      readonly text: string;
      readonly inputId: string;
      readonly effort?: ChatEffort;
      readonly browserContext: PageBrowserContext;
      readonly surfaceContext: BakerySurfaceAttachmentV1 | null;
      readonly attachments: readonly ChatAttachmentPart[];
      /** Present on a spoken command (Plan 82). */
      readonly inputMode?: ChatInputMode;
      /** The Portal page on the sender's screen at send time. */
      readonly surfaceObservation?: SurfaceObservationV2;
    }
  | {
      readonly kind: "withdraw";
      readonly conversationId: ConversationId;
      readonly inputId: string;
      readonly requestId?: never;
      readonly model?: never;
      readonly text?: never;
      readonly attachments?: never;
      readonly effort?: never;
      readonly surfaceContext?: never;
    }
  | {
      /** Send a message that waits in the queue now, into the running turn. */
      readonly kind: "steer_queued";
      readonly conversationId: ConversationId;
      readonly inputId: string;
      readonly cancellationId: string;
      readonly model: string;
      readonly requestId?: never;
      readonly text?: never;
      readonly attachments?: never;
      readonly effort?: never;
      readonly surfaceContext?: never;
    }
  | {
      readonly kind: "retry";
      readonly conversationId: ConversationId;
      readonly requestId: string;
      readonly model: string;
      readonly text?: never;
      readonly attachments?: never;
      readonly effort?: ChatEffort;
      readonly surfaceContext?: never;
    };

export function parseChatCommand(raw: unknown): Result<ChatCommand, string> {
  if (!isRecord(raw) || !isConversationId(raw.conversationId))
    return { ok: false, error: "chat_request_invalid" };
  if (
    raw.kind === "withdraw" &&
    Object.keys(raw).length === 3 &&
    isChatId(raw.inputId)
  )
    return {
      ok: true,
      value: {
        kind: "withdraw",
        conversationId: raw.conversationId,
        inputId: raw.inputId,
      },
    };
  if (
    raw.kind === "steer_queued" &&
    Object.keys(raw).length === 5 &&
    isChatId(raw.inputId) &&
    isChatId(raw.cancellationId) &&
    isChatModelId(raw.model)
  )
    return {
      ok: true,
      value: {
        kind: "steer_queued",
        conversationId: raw.conversationId,
        inputId: raw.inputId,
        cancellationId: raw.cancellationId,
        model: raw.model,
      },
    };
  if (!isChatId(raw.requestId) || !isChatModelId(raw.model))
    return { ok: false, error: "chat_request_invalid" };
  const effort = parseChatEffort(raw.effort);
  if (raw.effort !== undefined && effort === null)
    return { ok: false, error: "chat_message_invalid" };
  // A tab that loaded the Portal before Plan 87 phase 2 still sends the
  // Kitchen view in its own key, until the tab reloads.
  const oldTabSurfaceContext = parseSurfaceContext(raw.surfaceContext);
  if (oldTabSurfaceContext === undefined)
    return { ok: false, error: "chat_message_invalid" };
  const browserContext =
    raw.browserContext === undefined
      ? ({ kind: "unavailable" } as const)
      : parsePageBrowserContext(raw.browserContext);
  if (
    browserContext === null ||
    (browserContext.kind !== "unavailable" &&
      browserContext.binding.conversationId !== raw.conversationId)
  )
    return { ok: false, error: "chat_message_invalid" };
  const surfaceObservation = parseSurfaceObservationKey(raw);
  if (surfaceObservation === null)
    return { ok: false, error: "chat_message_invalid" };
  const screen = commandScreen(
    surfaceObservation,
    oldTabSurfaceContext,
    browserContext,
  );
  if (screen === null) return { ok: false, error: "chat_message_invalid" };
  const surfaceObservationField =
    screen.observation === undefined
      ? {}
      : { surfaceObservation: screen.observation };
  const surfaceContext = screen.kitchen;
  // The browser context and the screen are optional keys of a message.
  const browserKeyCount =
    (Object.hasOwn(raw, "browserContext") ? 1 : 0) +
    (surfaceObservation === undefined ? 0 : 1);
  const surfaceKeyCount = Object.hasOwn(raw, "surfaceContext") ? 1 : 0;
  const goalKeyCount = Object.hasOwn(raw, "goalTokenBudget") ? 1 : 0;
  const inputMode = Object.hasOwn(raw, "inputMode")
    ? parseChatInputMode(raw.inputMode)
    : undefined;
  if (inputMode === null) return { ok: false, error: "chat_message_invalid" };
  const inputModeKeyCount = inputMode === undefined ? 0 : 1;
  const inputModeField = inputMode === undefined ? {} : { inputMode };
  if (
    goalKeyCount === 1 &&
    (raw.kind !== "message" ||
      typeof raw.goalTokenBudget !== "number" ||
      !Number.isSafeInteger(raw.goalTokenBudget) ||
      raw.goalTokenBudget < 1 ||
      raw.goalTokenBudget > 4294967295)
  )
    return { ok: false, error: "chat_message_invalid" };
  if (
    raw.kind === "retry" &&
    Object.keys(raw).length === (effort === null ? 4 : 5)
  )
    return {
      ok: true,
      value: {
        kind: "retry",
        conversationId: raw.conversationId,
        requestId: raw.requestId,
        model: raw.model,
        ...(effort === null ? {} : { effort }),
      },
    };
  const isNext = raw.kind === "next";
  const isSteer = raw.kind === "steer";
  let inputId: string | undefined;
  if (isNext || isSteer) {
    if (!isChatId(raw.inputId))
      return { ok: false, error: "chat_message_invalid" };
    inputId = raw.inputId;
  }
  if (isSteer && !isChatId(raw.cancellationId))
    return { ok: false, error: "chat_message_invalid" };
  if (
    (raw.kind !== "message" && !isSteer && !isNext) ||
    (isNext
      ? Object.keys(raw).length !==
        (effort === null ? 6 : 7) +
          surfaceKeyCount +
          browserKeyCount +
          inputModeKeyCount
      : isSteer
        ? Object.keys(raw).length !==
          (effort === null ? 7 : 8) +
            surfaceKeyCount +
            browserKeyCount +
            inputModeKeyCount
        : Object.keys(raw).length !==
          (effort === null ? 5 : 6) +
            surfaceKeyCount +
            browserKeyCount +
            goalKeyCount +
            inputModeKeyCount) ||
    typeof raw.text !== "string" ||
    raw.text.trim().length === 0 ||
    raw.text.length > 8000
  )
    return { ok: false, error: "chat_message_invalid" };
  if (
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|EZ[AT]K[A-Za-z0-9]{20,}|shippo_(?:test|live)_[A-Za-z0-9]{16,})\b/u.test(
      raw.text,
    )
  )
    return { ok: false, error: "chat_use_secure_credential_entry" };
  if (isNext) {
    if (inputId === undefined)
      return { ok: false, error: "chat_message_invalid" };
    return {
      ok: true,
      value: {
        kind: "next",
        conversationId: raw.conversationId,
        requestId: raw.requestId,
        model: raw.model,
        text: raw.text.trim(),
        inputId,
        browserContext,
        surfaceContext,
        attachments: [],
        ...(effort === null ? {} : { effort }),
        ...inputModeField,
        ...surfaceObservationField,
      },
    };
  }
  if (isSteer) {
    if (inputId === undefined || typeof raw.cancellationId !== "string")
      return { ok: false, error: "chat_message_invalid" };
    return {
      ok: true,
      value: {
        kind: "steer",
        conversationId: raw.conversationId,
        requestId: raw.requestId,
        inputId,
        cancellationId: raw.cancellationId,
        model: raw.model,
        text: raw.text.trim(),
        browserContext,
        surfaceContext,
        attachments: [],
        ...(effort === null ? {} : { effort }),
        ...inputModeField,
        ...surfaceObservationField,
      },
    };
  }
  return {
    ok: true,
    value: {
      kind: "message",
      conversationId: raw.conversationId,
      requestId: raw.requestId,
      model: raw.model,
      text: raw.text.trim(),
      browserContext,
      surfaceContext,
      attachments: [],
      ...(effort === null ? {} : { effort }),
      ...inputModeField,
      ...surfaceObservationField,
      ...(goalKeyCount === 0
        ? {}
        : { goalTokenBudget: raw.goalTokenBudget as number }),
    },
  };
}

// The page on the sender's screen. A tab that loaded the Portal before Plan 87
// still sends a v1 `pageView`, which reads as v2 until the tab reloads.
function parseSurfaceObservationKey(
  raw: JsonRecord,
): SurfaceObservationV2 | null | undefined {
  const hasObservation = Object.hasOwn(raw, "surfaceObservation");
  const hasPageView = Object.hasOwn(raw, "pageView");
  if (hasObservation && hasPageView) return null;
  if (hasObservation) return parseSurfaceObservation(raw.surfaceObservation);
  if (!hasPageView) return undefined;
  const view = parsePortalPageView(raw.pageView);
  return view === null ? null : surfaceObservationFromPageView(view);
}

/**
 * The one screen observation of a message, and the Kitchen view that
 * it carries for the Kitchen code. Null when the Kitchen state breaks its
 * contract.
 */
function commandScreen(
  observation: SurfaceObservationV2 | undefined,
  oldTab: BakerySurfaceAttachmentV1 | null,
  browser: PageBrowserContext,
): Readonly<{
  observation: SurfaceObservationV2 | undefined;
  kitchen: BakerySurfaceAttachmentV1 | null;
}> | null {
  if (oldTab !== null && !oldKitchenAttachmentIsIntact(oldTab)) return null;
  const admitted =
    observation === undefined
      ? undefined
      : admitKitchenState(observation, browser);
  if (admitted === null) return null;
  const merged = withOldKitchenAttachment(admitted, oldTab, browser);
  return { observation: merged, kitchen: kitchenAttachment(merged) };
}

function parseSurfaceContext(
  raw: unknown,
): BakerySurfaceAttachmentV1 | null | undefined {
  if (raw === undefined || raw === null) return null;
  const parsed = parseBakerySurfaceAttachment(raw);
  return parsed.kind === "valid" ? parsed.value : undefined;
}

function isChatModelId(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 120 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(raw)
  );
}

function parseChatEffort(raw: unknown): ChatEffort | null {
  if (raw === undefined) return null;
  return raw === "low" || raw === "medium" || raw === "high" ? raw : null;
}

export function isChatId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-zA-Z0-9_-]{8,100}$/u.test(raw);
}

export function parseConversation(raw: unknown): Conversation {
  if (
    !isRecord(raw) ||
    !isConversationId(raw.id) ||
    typeof raw.title !== "string" ||
    !Array.isArray(raw.timeline) ||
    !Array.isArray(raw.documents) ||
    !Array.isArray(raw.completedRequests)
  )
    throw new Error("conversation_storage_invalid");
  const documents: ConversationDocument[] = [];
  for (const document of raw.documents) {
    if (
      !isRecord(document) ||
      typeof document.url !== "string" ||
      typeof document.sha256 !== "string" ||
      typeof document.text !== "string" ||
      typeof document.truncated !== "boolean"
    )
      throw new Error("conversation_document_invalid");
    documents.push({
      url: document.url,
      sha256: document.sha256,
      text: document.text,
      truncated: document.truncated,
    });
  }
  const completedRequests: string[] = [];
  for (const id of raw.completedRequests) {
    if (!isChatId(id)) throw new Error("conversation_request_invalid");
    completedRequests.push(id);
  }
  const timeline = parseStoredTimeline(raw.timeline);
  const latestSequence = parseSequence(
    raw.latestSequence,
    latestTimelineSequence(timeline),
  );
  const lastReadSequence = parseSequence(raw.lastReadSequence, latestSequence);
  if (lastReadSequence > latestSequence)
    throw new Error("conversation_read_cursor_invalid");
  const effort = parseChatEffort(raw.effort);
  if (raw.effort !== undefined && raw.effort !== null && effort === null)
    throw new Error("conversation_effort_invalid");
  return {
    lineage: parseChatThreadLineage(raw.lineage),
    historyBindings: parseChatHistoryBindings(raw.historyBindings),
    id: raw.id,
    title: raw.title,
    modelRoute: parseStoredModelRoute(raw),
    documents,
    work: parseWork(raw.work),
    completedRequests,
    timeline,
    pendingInputs: parsePendingInputs(raw.pendingInputs),
    latestSequence,
    lastReadSequence,
    surfaceEventCursor: parseSequence(raw.surfaceEventCursor, 0),
    draftText: typeof raw.draftText === "string" ? raw.draftText : "",
    draftUpdatedAt:
      raw.draftUpdatedAt === null || raw.draftUpdatedAt === undefined
        ? null
        : parseTimestamp(raw.draftUpdatedAt),
    effort,
    ...chatOriginField(chatOrigin(raw.origin, timeline)),
  };
}

export function conversationTimeline(
  conversation: Conversation,
): readonly ChatTimelineEvent[] {
  return conversation.timeline;
}

export function latestPublicTimelineSequence(
  conversation: Conversation,
): number {
  let latest = 0;
  for (const event of conversationTimeline(conversation)) {
    if (event.kind !== "context") latest = event.sequence;
  }
  return latest;
}

export function normalizeConversationTimeline(
  conversation: Conversation,
): Conversation {
  const timeline = conversation.timeline;
  const latestSequence = latestTimelineSequence(timeline);
  const lastReadSequence = Math.min(
    conversation.lastReadSequence,
    latestSequence,
  );
  return {
    lineage: conversation.lineage,
    historyBindings: conversation.historyBindings,
    id: conversation.id,
    title: conversation.title,
    modelRoute: conversation.modelRoute,
    documents: conversation.documents,
    work: conversation.work,
    completedRequests: conversation.completedRequests,
    pendingInputs: conversation.pendingInputs,
    surfaceEventCursor: conversation.surfaceEventCursor,
    draftText: conversation.draftText,
    effort: conversation.effort,
    timeline,
    latestSequence,
    lastReadSequence,
    draftUpdatedAt:
      conversation.draftText.length === 0 ? null : conversation.draftUpdatedAt,
    ...chatOriginField(chatOrigin(conversation.origin, timeline)),
  };
}

export function addPendingChatInput(
  conversation: Conversation,
  input: PendingChatInput,
): Conversation {
  return {
    ...conversation,
    pendingInputs: [...conversation.pendingInputs, input],
  };
}

export function removePendingChatInput(
  conversation: Conversation,
  inputId: string,
): Conversation {
  return {
    ...conversation,
    pendingInputs: conversation.pendingInputs.filter(function keepInput(input) {
      return input.inputId !== inputId;
    }),
  };
}

export function timelineVisibleMessages(
  conversation: Conversation,
): readonly ChatMessage[] {
  return timelineVisibleMessagesFromEvents(conversation.timeline);
}

function parseStoredModelRoute(raw: JsonRecord): ModelRoute {
  const route = parseSessionModelRoute(raw.modelRoute);
  if (!route.ok) throw new Error("conversation_model_invalid");
  return route.value;
}

function parseStoredTimeline(raw: unknown): readonly ChatTimelineEvent[] {
  if (!Array.isArray(raw)) throw new Error("conversation_timeline_invalid");
  const events: ChatTimelineEvent[] = [];
  let previous = -1;
  for (const item of raw) {
    const parsed = parseChatTimelineEvent(normalizeStoredSurfaceParts(item));
    if (!parsed.ok && parsed.error === "project_evidence_unavailable")
      throw new Error(parsed.error);
    if (!parsed.ok || parsed.value.sequence <= previous)
      throw new Error("conversation_timeline_invalid");
    previous = parsed.value.sequence;
    events.push(parsed.value);
  }
  return events;
}

function normalizeStoredSurfaceParts(raw: unknown): unknown {
  if (!isRecord(raw) || raw.kind !== "user" || !Array.isArray(raw.parts))
    return raw;
  const parts: unknown[] = [];
  for (const part of raw.parts) {
    if (
      !isRecord(part) ||
      part.kind !== "surface" ||
      parseBakerySurfaceAttachment(part.surface).kind === "valid"
    ) {
      parts.push(part);
      continue;
    }
    const text = historicalSurfaceText(part.surface);
    if (text === null) {
      parts.push(part);
      continue;
    }
    // Historical snapshots remain readable without becoming live command authority.
    const historical: ChatInputPart = {
      kind: "text",
      text,
    };
    parts.push(historical);
  }
  return { ...raw, parts };
}

function historicalSurfaceText(raw: unknown): string | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "bakery-surface-context" ||
    typeof raw.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.digest) ||
    !isRecord(raw.context) ||
    raw.context.schemaVersion !== 1 ||
    raw.context.kind !== "bakery-workspace"
  )
    return null;
  return `Historical Kitchen context (read-only snapshot):\n${JSON.stringify(raw)}`;
}

function parseSequence(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new Error("conversation_sequence_invalid");
  return raw;
}

function parseTimestamp(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new Error("conversation_timestamp_invalid");
  return raw;
}

function parsePendingInputs(raw: unknown): readonly PendingChatInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("conversation_queue_invalid");
  const pending: PendingChatInput[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !isChatId(value.inputId) ||
      !isChatId(value.requestId) ||
      (value.mode !== "next" && value.mode !== "steer") ||
      typeof value.acceptedAt !== "number" ||
      !Number.isSafeInteger(value.acceptedAt) ||
      value.acceptedAt < 0 ||
      !Array.isArray(value.parts)
    )
      throw new Error("conversation_queue_invalid");
    const parts = parseInputParts(value.parts);
    if (!parts.ok) throw new Error("conversation_queue_invalid");
    const effort = parseChatEffort(value.effort);
    if (value.effort !== undefined && effort === null)
      throw new Error("conversation_queue_invalid");
    pending.push({
      inputId: value.inputId,
      requestId: value.requestId,
      mode: value.mode,
      parts: parts.value,
      acceptedAt: value.acceptedAt,
      ...(effort === null ? {} : { effort }),
    });
  }
  return pending;
}

function latestTimelineSequence(
  timeline: readonly ChatTimelineEvent[],
): number {
  const last = timeline[timeline.length - 1];
  return last === undefined ? 0 : last.sequence;
}

function timelineVisibleMessagesFromEvents(
  events: readonly ChatTimelineEvent[],
): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "user":
        messages.push({
          kind: "user",
          id: event.eventId,
          text: event.text,
          browserContext: browserContextFromParts(event.parts),
          surfaceContext: surfaceContextFromParts(event.parts),
          attachments: attachmentParts(event.parts),
          ...inputModeFromParts(event.parts),
          ...surfaceObservationFromParts(event.parts),
        });
        break;
      case "assistant":
      case "activity":
      case "context":
        messages.push({
          kind: event.kind,
          id: event.eventId,
          text: event.text,
        });
        break;
      case "connector":
        messages.push({
          kind: "connector",
          id: event.eventId,
          text: event.text,
          document: event.document,
          target: event.target,
        });
        break;
      case "progress":
      case "run_failed":
      case "run_cancelled":
        messages.push({
          kind: "activity",
          id: event.eventId,
          text: event.text,
        });
        break;
      case "tool_started":
      case "tool_settled":
      case "approval":
      case "receipt":
        break;
      default:
        throw new Error(
          `conversation_timeline_event_unhandled:${String(event)}`,
        );
    }
  }
  return messages;
}

export function inputModeFromParts(
  parts: readonly ChatInputPart[],
): Readonly<{ inputMode?: ChatInputMode }> {
  for (const part of parts)
    if (part.kind === "voice") return { inputMode: { ...part } };
  return {};
}

// The Kitchen view travels inside the screen observation (Plan 87).
function surfaceContextFromParts(
  parts: Variant<ChatTimelineEvent, "user">["parts"],
): BakerySurfaceAttachmentV1 | null {
  for (const part of parts)
    if (part.kind === "surface_observation")
      return kitchenAttachment(part.observation);
  return null;
}

function parseConversationRecovery(
  raw: unknown,
): Variant<ConversationWork, "failed">["recovery"] {
  if (raw === undefined || raw === null) return null;
  if (
    isRecord(raw) &&
    (raw.kind === "projection_capacity" || raw.kind === "interrupted") &&
    isChatId(raw.lease)
  ) {
    const stream = parseConversationStream(raw.stream);
    if (stream !== null) return { kind: raw.kind, lease: raw.lease, stream };
  }
  throw new Error("conversation_recovery_invalid");
}

export function parseWork(raw: unknown): ConversationWork {
  if (!isRecord(raw)) throw new Error("conversation_work_invalid");
  if (raw.kind === "ready") return { kind: "ready" };
  if (
    raw.kind === "failed" &&
    isChatId(raw.requestId) &&
    typeof raw.error === "string"
  )
    return {
      kind: "failed",
      requestId: raw.requestId,
      error: raw.error,
      recovery: parseConversationRecovery(raw.recovery),
    };
  if (
    raw.kind === "awaiting_permission" &&
    isChatId(raw.requestId) &&
    isNonNegativeInteger(raw.step)
  ) {
    const permission = parseChatPermissionRequest(raw.permission);
    if (permission !== null)
      return {
        kind: "awaiting_permission",
        requestId: raw.requestId,
        step: raw.step,
        permission,
        stream: parseConversationStream(raw.stream),
      };
  }
  const stream = parseConversationStream(raw.stream);
  if (
    raw.kind === "cancelling" &&
    isChatId(raw.requestId) &&
    isChatId(raw.cancellationId) &&
    isChatId(raw.lease) &&
    isNonNegativeInteger(raw.expiresAt) &&
    stream !== null
  )
    return {
      kind: "cancelling",
      requestId: raw.requestId,
      cancellationId: raw.cancellationId,
      lease: raw.lease,
      expiresAt: raw.expiresAt,
      stream,
    };
  if (
    raw.kind === "running" &&
    isChatId(raw.requestId) &&
    isChatId(raw.lease) &&
    typeof raw.expiresAt === "number" &&
    Number.isSafeInteger(raw.expiresAt) &&
    stream !== null
  )
    return {
      kind: "running",
      requestId: raw.requestId,
      lease: raw.lease,
      expiresAt: raw.expiresAt,
      stream,
    };
  throw new Error("conversation_work_invalid");
}

function parseConversationStream(raw: unknown): ConversationStream | null {
  if (!isRecord(raw) || typeof raw.sessionId !== "string") return null;
  const sessionId = parseSessionId(raw.sessionId);
  if (
    !sessionId.ok ||
    typeof raw.step !== "number" ||
    !Number.isSafeInteger(raw.step) ||
    raw.step < 0 ||
    !isChatId(raw.turnId)
  )
    return null;
  return {
    step: raw.step,
    sessionId: sessionId.value,
    turnId: raw.turnId,
  };
}

/**
 * The JSON action of a model answer. The answer holds all the text that the
 * model wrote in the turn, so text from before a tool call can come first;
 * the action is then the first object from which the rest of the answer
 * parses.
 */
/**
 * The action of a turn that a steering message joined (Plan 71). The turn
 * answered the first message, then went on after the steer, so its answer
 * holds one reply object for each part. Each one is a real answer: join
 * them. Any other content is read as one action.
 */
export function parseSteeredChatModelAction(
  text: string,
): Result<ChatModelAction, string> {
  const starts = [...text.matchAll(CHAT_ACTION_START)].map(matchIndex);
  const replies: string[] = [];
  for (const [position, start] of starts.entries()) {
    const action = parsedJson(text.slice(start, starts[position + 1]));
    if (
      !isRecord(action) ||
      action.kind !== "reply" ||
      typeof action.text !== "string" ||
      action.text.trim().length === 0
    )
      return parseChatModelAction(text);
    replies.push(action.text);
  }
  return replies.length > 1 && text.slice(0, starts[0]).trim() === ""
    ? { ok: true, value: { kind: "reply", text: replies.join("\n\n") } }
    : parseChatModelAction(text);
}

const CHAT_ACTION_START = /(?:```(?:json)?\s*\n)?\{\s*"kind"\s*:/gu;

function matchIndex(match: RegExpExecArray): number {
  return match.index;
}

function chatActionJson(text: string): unknown {
  const whole = parsedJson(text);
  if (whole !== undefined) return whole;
  for (const start of text.matchAll(CHAT_ACTION_START)) {
    const tail = parsedJson(text.slice(start.index));
    if (tail !== undefined) return tail;
  }
  return undefined;
}

/** Text with no attempt at a JSON action, which an invalid action has. */
function isProseAnswer(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("```json") &&
    text.search(CHAT_ACTION_START) < 0
  );
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(
      text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1"),
    );
  } catch {
    return undefined;
  }
}

export type ChatModelAction =
  | {
      readonly kind: "question";
      readonly question: ChatQuestion;
      readonly text?: never;
    }
  | { readonly kind: "reply"; readonly text: string; readonly question?: never }
  | { readonly kind: "read_documentation"; readonly url: string }
  | { readonly kind: "definition"; readonly document: JsonRecord }
  | {
      readonly kind: "revise";
      readonly connectorId: CustomConnectorId;
      readonly document: JsonRecord;
    };

export function parseChatModelAction(
  text: string,
): Result<ChatModelAction, string> {
  const raw = chatActionJson(text);
  if (raw === undefined) {
    // A prose answer is the reply. A new step has no record of this one, so
    // asking again would repeat every tool that this step called.
    if (isProseAnswer(text))
      return { ok: true, value: { kind: "reply", text: text.trim() } };
    return {
      ok: false,
      error:
        "Return one JSON action: reply, question, read_documentation, definition, or revise.",
    };
  }
  if (!isRecord(raw))
    return { ok: false, error: "Return a JSON action object." };
  switch (raw.kind) {
    case "question": {
      const question = parseChatQuestion(raw.question);
      if (question !== null)
        return { ok: true, value: { kind: "question", question } };
      return {
        ok: false,
        error:
          "A question needs a title (up to 300 characters), description, allowCustom, and up to six options with unique id, label, and description. Allow custom text when there are no options.",
      };
    }
    case "reply":
      if (typeof raw.text === "string" && raw.text.trim().length > 0)
        return { ok: true, value: { kind: "reply", text: raw.text } };
      break;
    case "read_documentation": {
      // An invalid URL falls through: the next model step receives a
      // validation result.
      const url = documentationUrl(raw.url);
      if (url !== null)
        return { ok: true, value: { kind: "read_documentation", url } };
      break;
    }
    case "revise": {
      const id = parseCustomConnectorId(raw.connectorId);
      if (id.ok && isRecord(raw.document))
        return {
          ok: true,
          value: {
            kind: "revise",
            connectorId: id.value,
            document: raw.document,
          },
        };
      break;
    }
    case "definition":
      if (isRecord(raw.document))
        return {
          ok: true,
          value: { kind: "definition", document: raw.document },
        };
      break;
  }
  return {
    ok: false,
    error:
      "Invalid action. Documentation must use public HTTPS URLs without credentials or query parameters.",
  };
}

/**
 * A documentation URL in the form a chat reads it: HTTPS with no
 * credentials, port or query, and without its fragment. Null for any other
 * value.
 */
function documentationUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== ""
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

const WRITTEN_LINK = /https:\/\/[^\s<>"'`]+/gu;
const LINK_TRAILER = /[.,;:!?)\]}]+$/u;

/**
 * The documentation links that people wrote in this chat. A chat reads
 * documentation only from these, so the model cannot compose a URL and carry
 * text to a host in its path.
 */
export function personDocumentationLinks(
  messages: readonly ChatMessage[],
): readonly string[] {
  const links = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "user") continue;
    for (const match of message.text.matchAll(WRITTEN_LINK)) {
      const url = documentationUrl(match[0].replace(LINK_TRAILER, ""));
      if (url !== null) links.add(url);
    }
  }
  return [...links];
}

export function browserContextFromParts(
  parts: readonly ChatInputPart[],
): PageBrowserContext {
  for (const part of parts) if (part.kind === "browser") return part.context;
  return { kind: "unavailable" };
}
