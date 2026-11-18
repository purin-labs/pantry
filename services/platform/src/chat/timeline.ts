import {
  isChatTranscriptionPath,
  isVoiceEngineId,
  type ChatTranscriptionPath,
  type VoiceEngineId,
} from "@seams/control-api";
import {
  parsePortalPageView,
  parseSurfaceObservation,
  surfaceObservationFromPageView,
  type SurfaceObservationV2,
} from "@seams/control-api";
import {
  restoreStoredProjectSnapshot,
  type ProjectSnapshot,
  parseChatContextDetails,
  type ChatContextDetails,
} from "@seams/control-api";
import {
  parseBakeryBrowserContext,
  type BakeryBrowserContext,
} from "@seams/bakery-model/bakery-context";
import type { JsonRecord } from "../control/http";
import type { Result } from "../result";
import type { ConnectorCardTarget as ConversationCardTarget } from "./conversation";
import { parseCustomConnectorId } from "../custom-connectors/identity";
import {
  parseBakerySurfaceAttachment,
  type BakerySurfaceAttachmentV1,
} from "@seams/bakery-model/bakery-surface";
import { isNonNegativeInteger, isRecord } from "@seams/std";
import { withOldKitchenAttachment } from "./kitchen-observation";
import {
  type ChatApproval,
  type ChatQuestion,
  type ChatReceiptReference,
  type ChatSource,
  type ChatToolView,
  type ChatTurnUsage,
  parseChatQuestion,
} from "@seams/control-api";
export type ConnectorCardTarget = ConversationCardTarget;

/** The provider-neutral content that can be accepted into a conversation. */
export type ChatInputPart =
  | { readonly kind: "project_context"; readonly snapshot: ProjectSnapshot }
  | { readonly kind: "browser"; readonly context: BakeryBrowserContext }
  | { readonly kind: "text"; readonly text: string }
  /** The command was spoken; the text part holds its transcript (Plan 82). */
  | {
      readonly kind: "voice";
      readonly transcriptionPath: ChatTranscriptionPath;
      /** A message from before Plan 82C names no engine. */
      readonly transcriptionEngine?: VoiceEngineId;
    }
  /**
   * The page on the sender's screen when the message was sent (Plan 87). A
   * message keeps one; the Satyr Kitchen view is its `state` (phase 2).
   */
  | {
      readonly kind: "surface_observation";
      readonly observation: SurfaceObservationV2;
    }
  | {
      readonly kind: "attachment";
      readonly attachmentId: string;
      readonly mediaType: string;
      readonly filename: string;
      readonly preparation: "ready";
    };

export type ChatAttachmentPart = Extract<
  ChatInputPart,
  { readonly kind: "attachment" }
>;

export function attachmentParts(
  parts: readonly ChatInputPart[],
): readonly ChatAttachmentPart[] {
  return parts.filter(isAttachmentPart);
}
function isAttachmentPart(part: ChatInputPart): part is ChatAttachmentPart {
  return part.kind === "attachment";
}

/** The screen observation of a message, as a field to spread into it. */
export function surfaceObservationFromParts(
  parts: readonly ChatInputPart[],
): Readonly<{ surfaceObservation?: SurfaceObservationV2 }> {
  for (const part of parts)
    if (part.kind === "surface_observation")
      return { surfaceObservation: part.observation };
  return {};
}

export type PendingChatInput = {
  readonly inputId: string;
  readonly requestId: string;
  readonly mode: "next" | "steer";
  readonly parts: readonly ChatInputPart[];
  readonly acceptedAt: number;
  readonly effort?: "low" | "medium" | "high";
};

type TimelineBase = {
  readonly eventId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly createdAt: number;
};

export type ChatTimelineEvent =
  | (TimelineBase & {
      readonly kind: "user";
      readonly text: string;
      readonly parts: readonly ChatInputPart[];
    })
  | (TimelineBase & {
      readonly kind: "assistant";
      readonly text: string;
      readonly sources: readonly ChatSource[];
      readonly question?: ChatQuestion;
      readonly rating?: "good" | "bad" | null;
      readonly usage: ChatTurnUsage | null;
    })
  | (TimelineBase & {
      readonly kind: "activity" | "context" | "progress";
      readonly text: string;
      readonly contextDetails?: ChatContextDetails;
    })
  | (TimelineBase & {
      readonly kind: "connector";
      readonly text: string;
      readonly document: JsonRecord;
      readonly target: ConnectorCardTarget;
    })
  | (TimelineBase & {
      readonly kind: "tool_started";
      readonly tool: ChatToolView;
    })
  | (TimelineBase & {
      readonly kind: "tool_settled";
      readonly tool: ChatToolView;
      readonly outcome: "succeeded" | "failed" | "denied" | "indeterminate";
      readonly summary: string;
      readonly receipt: ChatReceiptReference | null;
    })
  | (TimelineBase & {
      readonly kind: "approval";
      readonly approval: ChatApproval;
    })
  | (TimelineBase & {
      readonly kind: "receipt";
      readonly receipt: ChatReceiptReference;
    })
  | (TimelineBase & {
      readonly kind: "run_failed" | "run_cancelled";
      readonly text: string;
    });

export type ConversationTimelineState = {
  readonly timeline: readonly ChatTimelineEvent[];
  readonly pendingInputs: readonly PendingChatInput[];
  readonly latestSequence: number;
  readonly lastReadSequence: number;
  readonly draftText: string;
  readonly draftUpdatedAt: number | null;
};

export function buildUserTimelineEvent(input: {
  readonly eventId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly createdAt: number;
  readonly text: string;
  readonly parts?: readonly ChatInputPart[];
}): ChatTimelineEvent {
  return {
    kind: "user",
    eventId: input.eventId,
    sequence: input.sequence,
    requestId: input.requestId,
    createdAt: input.createdAt,
    text: input.text,
    parts: input.parts ?? [{ kind: "text", text: input.text }],
  };
}

export function buildAssistantTimelineEvent(input: {
  readonly eventId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly createdAt: number;
  readonly text: string;
  readonly sources?: readonly ChatSource[];
  readonly question?: ChatQuestion;
  readonly usage?: ChatTurnUsage | null;
}): ChatTimelineEvent {
  return {
    kind: "assistant",
    eventId: input.eventId,
    sequence: input.sequence,
    requestId: input.requestId,
    createdAt: input.createdAt,
    text: input.text,
    sources: input.sources ?? [],
    ...(input.question === undefined ? {} : { question: input.question }),
    usage: input.usage ?? null,
  };
}

export function buildTextTimelineEvent(input: {
  readonly kind: "activity" | "context" | "progress";
  readonly eventId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly createdAt: number;
  readonly text: string;
}): ChatTimelineEvent {
  return input;
}

export function parseChatTimelineEvent(
  raw: unknown,
): Result<ChatTimelineEvent, string> {
  if (!isRecord(raw)) return { ok: false, error: "timeline_event_invalid" };
  const base = parseTimelineBase(raw);
  if (!base.ok) return base;
  if (
    raw.kind === "user" &&
    typeof raw.text === "string" &&
    Array.isArray(raw.parts)
  ) {
    const parts = parseInputParts(raw.parts);
    if (!parts.ok) return parts;
    if (parts.ok)
      return {
        ok: true,
        value: {
          ...base.value,
          kind: "user",
          text: raw.text,
          parts: parts.value,
        },
      };
  }
  if (
    raw.kind === "assistant" &&
    typeof raw.text === "string" &&
    Array.isArray(raw.sources)
  ) {
    const sources = parseSources(raw.sources);
    const rating = raw.rating ?? null;
    if (rating !== null && rating !== "good" && rating !== "bad")
      return { ok: false, error: "timeline_rating_invalid" };
    const question =
      raw.question === undefined ? undefined : parseChatQuestion(raw.question);
    if (question === null)
      return { ok: false, error: "timeline_question_invalid" };
    const usage =
      raw.usage === null
        ? { ok: true, value: null as ChatTurnUsage | null }
        : parseUsage(raw.usage);
    if (sources.ok && usage.ok)
      return {
        ok: true,
        value: {
          ...base.value,
          kind: "assistant",
          text: raw.text,
          sources: sources.value,
          rating,
          ...(question === undefined ? {} : { question }),
          usage: usage.value,
        },
      };
  }
  if (
    (raw.kind === "activity" ||
      raw.kind === "context" ||
      raw.kind === "progress") &&
    typeof raw.text === "string"
  ) {
    const contextDetails =
      raw.contextDetails === undefined
        ? undefined
        : parseChatContextDetails(raw.contextDetails);
    if (contextDetails === null)
      return { ok: false, error: "timeline_context_invalid" };
    return {
      ok: true,
      value: {
        ...base.value,
        kind: raw.kind,
        text: raw.text,
        ...(contextDetails === undefined ? {} : { contextDetails }),
      },
    };
  }
  if (
    raw.kind === "connector" &&
    typeof raw.text === "string" &&
    isRecord(raw.document)
  ) {
    const target = parseConnectorTarget(raw.target);
    if (target.ok)
      return {
        ok: true,
        value: {
          ...base.value,
          kind: "connector",
          text: raw.text,
          document: raw.document,
          target: target.value,
        },
      };
  }
  if (raw.kind === "tool_started" && isRecord(raw.tool)) {
    const tool = parseToolView(raw.tool);
    if (tool.ok)
      return {
        ok: true,
        value: { ...base.value, kind: "tool_started", tool: tool.value },
      };
  }
  if (
    raw.kind === "tool_settled" &&
    isRecord(raw.tool) &&
    typeof raw.summary === "string" &&
    isRecord(raw.receipt)
  ) {
    const tool = parseToolView(raw.tool);
    const receipt = parseReceiptReference(raw.receipt);
    if (tool.ok && receipt.ok && isToolOutcome(raw.outcome))
      return {
        ok: true,
        value: {
          ...base.value,
          kind: "tool_settled",
          tool: tool.value,
          outcome: raw.outcome,
          summary: raw.summary,
          receipt: receipt.value,
        },
      };
  }
  if (
    raw.kind === "tool_settled" &&
    isRecord(raw.tool) &&
    typeof raw.summary === "string" &&
    raw.receipt === null
  ) {
    const tool = parseToolView(raw.tool);
    if (tool.ok && isToolOutcome(raw.outcome))
      return {
        ok: true,
        value: {
          ...base.value,
          kind: "tool_settled",
          tool: tool.value,
          outcome: raw.outcome,
          summary: raw.summary,
          receipt: null,
        },
      };
  }
  if (raw.kind === "approval" && isRecord(raw.approval)) {
    const approval = parseApproval(raw.approval);
    if (approval.ok)
      return {
        ok: true,
        value: { ...base.value, kind: "approval", approval: approval.value },
      };
  }
  if (raw.kind === "receipt" && isRecord(raw.receipt)) {
    const receipt = parseReceiptReference(raw.receipt);
    if (receipt.ok)
      return {
        ok: true,
        value: { ...base.value, kind: "receipt", receipt: receipt.value },
      };
  }
  if (raw.kind === "run_failed" || raw.kind === "run_cancelled") {
    if (typeof raw.text === "string")
      return {
        ok: true,
        value: { ...base.value, kind: raw.kind, text: raw.text },
      };
  }
  return { ok: false, error: "timeline_event_invalid" };
}

function parseTimelineBase(raw: JsonRecord): Result<TimelineBase, string> {
  if (
    typeof raw.eventId !== "string" ||
    raw.eventId.length === 0 ||
    typeof raw.sequence !== "number" ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 0 ||
    typeof raw.requestId !== "string" ||
    raw.requestId.length === 0 ||
    typeof raw.createdAt !== "number" ||
    !Number.isSafeInteger(raw.createdAt) ||
    raw.createdAt < 0
  )
    return { ok: false, error: "timeline_event_invalid" };
  return {
    ok: true,
    value: {
      eventId: raw.eventId,
      sequence: raw.sequence,
      requestId: raw.requestId,
      createdAt: raw.createdAt,
    },
  };
}

export function parseInputParts(
  raw: readonly unknown[],
): Result<readonly ChatInputPart[], string> {
  const parts: ChatInputPart[] = [];
  let hasProjectContext = false;
  let oldKitchen: BakerySurfaceAttachmentV1 | null = null;
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: "timeline_input_invalid" };
    if (item.kind === "project_context") {
      const restored = restoreStoredProjectSnapshot(item.snapshot);
      if (restored.kind === "evidence_unavailable") return { ok: false, error: "project_evidence_unavailable" };
      if (restored.kind !== "available" || hasProjectContext)
        return { ok: false, error: "timeline_project_context_invalid" };
      hasProjectContext = true;
      parts.push({ kind: "project_context", snapshot: restored.snapshot });
      continue;
    }
    if (item.kind === "text" && typeof item.text === "string") {
      parts.push({ kind: "text", text: item.text });
      continue;
    }
    if (item.kind === "voice" && isChatTranscriptionPath(item.transcriptionPath)) {
      parts.push({
        kind: "voice",
        transcriptionPath: item.transcriptionPath,
        ...(isVoiceEngineId(item.transcriptionEngine)
          ? { transcriptionEngine: item.transcriptionEngine }
          : {}),
      });
      continue;
    }
    if (item.kind === "browser") {
      const context = parseBakeryBrowserContext(item.context);
      if (context === null)
        return { ok: false, error: "timeline_input_invalid" };
      parts.push({ kind: "browser", context });
      continue;
    }
    if (item.kind === "surface_observation") {
      const observation = parseSurfaceObservation(item.observation);
      if (observation === null)
        return { ok: false, error: "timeline_input_invalid" };
      parts.push({ kind: "surface_observation", observation });
      continue;
    }
    // A message stored before Plan 87 holds a v1 page view.
    if (item.kind === "page_view") {
      const view = parsePortalPageView(item.view);
      if (view === null) return { ok: false, error: "timeline_input_invalid" };
      parts.push({
        kind: "surface_observation",
        observation: surfaceObservationFromPageView(view),
      });
      continue;
    }
    // A message stored before Plan 87 phase 2 holds a Kitchen
    // attachment beside its observation; both read as one observation.
    if (item.kind === "surface") {
      const parsed = parseBakerySurfaceAttachment(item.surface);
      if (parsed.kind === "invalid" || oldKitchen !== null)
        return { ok: false, error: "timeline_input_invalid" };
      oldKitchen = parsed.value;
      continue;
    }
    if (
      item.kind === "attachment" &&
      typeof item.attachmentId === "string" &&
      typeof item.mediaType === "string" &&
      typeof item.filename === "string" &&
      item.preparation === "ready"
    ) {
      parts.push({
        kind: "attachment",
        attachmentId: item.attachmentId,
        mediaType: item.mediaType,
        filename: item.filename,
        preparation: "ready",
      });
      continue;
    }
    return { ok: false, error: "timeline_input_invalid" };
  }
  return { ok: true, value: withOneScreenPart(parts, oldKitchen) };
}

function withOneScreenPart(
  parts: readonly ChatInputPart[],
  oldKitchen: BakerySurfaceAttachmentV1 | null,
): readonly ChatInputPart[] {
  if (oldKitchen === null) return parts;
  const { surfaceObservation } = surfaceObservationFromParts(parts);
  const observation = withOldKitchenAttachment(
    surfaceObservation,
    oldKitchen,
    browserOfParts(parts),
  );
  const others = parts.filter(isNotScreenPart);
  if (observation === undefined) return others;
  // The part goes where a new message keeps it: before the browser part.
  const browser = others.findIndex(isBrowserPart);
  const at = browser < 0 ? others.length : browser;
  return [
    ...others.slice(0, at),
    { kind: "surface_observation", observation },
    ...others.slice(at),
  ];
}

function isBrowserPart(part: ChatInputPart): boolean {
  return part.kind === "browser";
}

function isNotScreenPart(part: ChatInputPart): boolean {
  return part.kind !== "surface_observation";
}

function browserOfParts(parts: readonly ChatInputPart[]): BakeryBrowserContext {
  for (const part of parts) if (part.kind === "browser") return part.context;
  return { kind: "unavailable" };
}

function parseSources(
  raw: readonly unknown[],
): Result<readonly ChatSource[], string> {
  const sources: ChatSource[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.sourceId !== "string" ||
      typeof item.label !== "string" ||
      typeof item.host !== "string" ||
      (item.url !== null && typeof item.url !== "string") ||
      (item.kind !== "documentation" &&
        item.kind !== "tool" &&
        item.kind !== "attachment")
    )
      return { ok: false, error: "timeline_source_invalid" };
    sources.push({
      sourceId: item.sourceId,
      label: item.label,
      host: item.host,
      url: item.url,
      kind: item.kind,
    });
  }
  return { ok: true, value: sources };
}

function parseToolView(raw: JsonRecord): Result<ChatToolView, string> {
  if (
    typeof raw.toolCallId !== "string" ||
    typeof raw.action !== "string" ||
    typeof raw.object !== "string" ||
    typeof raw.destination !== "string" ||
    (raw.risk !== "read" &&
      raw.risk !== "write" &&
      raw.risk !== "destructive") ||
    typeof raw.detailsExpandable !== "boolean"
  )
    return { ok: false, error: "timeline_tool_invalid" };
  return {
    ok: true,
    value: {
      toolCallId: raw.toolCallId,
      action: raw.action,
      object: raw.object,
      destination: raw.destination,
      risk: raw.risk,
      detailsExpandable: raw.detailsExpandable,
    },
  };
}

function parseApproval(raw: JsonRecord): Result<ChatApproval, string> {
  if (raw.kind === "requested") {
    if (
      typeof raw.approvalId !== "string" ||
      typeof raw.operation !== "string" ||
      typeof raw.destination !== "string" ||
      typeof raw.effect !== "string" ||
      !isNonNegativeInteger(raw.expiresAt) ||
      !isStringRecord(raw.fields) ||
      typeof raw.alwaysAllow !== "boolean"
    )
      return { ok: false, error: "timeline_approval_invalid" };
    return {
      ok: true,
      value: {
        kind: "requested",
        approvalId: raw.approvalId,
        operation: raw.operation,
        destination: raw.destination,
        effect: raw.effect,
        expiresAt: raw.expiresAt,
        fields: raw.fields,
        alwaysAllow: raw.alwaysAllow,
      },
    };
  }
  if (
    raw.kind === "settled" &&
    typeof raw.approvalId === "string" &&
    typeof raw.decisionId === "string" &&
    (raw.outcome === "allowed_once" ||
      raw.outcome === "always_allowed" ||
      raw.outcome === "denied" ||
      raw.outcome === "expired" ||
      raw.outcome === "failed") &&
    isNonNegativeInteger(raw.settledAt)
  )
    return {
      ok: true,
      value: {
        kind: "settled",
        approvalId: raw.approvalId,
        decisionId: raw.decisionId,
        outcome: raw.outcome,
        settledAt: raw.settledAt,
      },
    };
  return { ok: false, error: "timeline_approval_invalid" };
}

function parseReceiptReference(
  raw: JsonRecord,
): Result<ChatReceiptReference, string> {
  if (
    typeof raw.receiptId !== "string" ||
    (raw.state !== "pending" &&
      raw.state !== "succeeded" &&
      raw.state !== "failed" &&
      raw.state !== "reconciliation_required") ||
    typeof raw.summary !== "string"
  )
    return { ok: false, error: "timeline_receipt_invalid" };
  return {
    ok: true,
    value: {
      receiptId: raw.receiptId,
      state: raw.state,
      summary: raw.summary,
    },
  };
}

function isToolOutcome(
  raw: unknown,
): raw is "succeeded" | "failed" | "denied" | "indeterminate" {
  return (
    raw === "succeeded" ||
    raw === "failed" ||
    raw === "denied" ||
    raw === "indeterminate"
  );
}

function isStringRecord(raw: unknown): raw is Readonly<Record<string, string>> {
  if (!isRecord(raw)) return false;
  return Object.values(raw).every(function isString(value) {
    return typeof value === "string";
  });
}

function parseUsage(raw: unknown): Result<ChatTurnUsage, string> {
  if (
    !isRecord(raw) ||
    typeof raw.requestId !== "string" ||
    typeof raw.measuredAt !== "number" ||
    !Number.isSafeInteger(raw.measuredAt)
  )
    return { ok: false, error: "timeline_usage_invalid" };
  if (
    !isNonNegativeInteger(raw.inputTokens) ||
    !isNonNegativeInteger(raw.outputTokens) ||
    !isNonNegativeInteger(raw.totalTokens) ||
    (raw.cachedInputTokens !== null &&
      !isNonNegativeInteger(raw.cachedInputTokens))
  )
    return { ok: false, error: "timeline_usage_invalid" };
  const cachedInputTokens =
    raw.cachedInputTokens === null ? null : raw.cachedInputTokens;
  return {
    ok: true,
    value: {
      requestId: raw.requestId,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cachedInputTokens,
      totalTokens: raw.totalTokens,
      measuredAt: raw.measuredAt,
    },
  };
}

function parseConnectorTarget(
  raw: unknown,
): Result<ConnectorCardTarget, string> {
  if (!isRecord(raw)) return { ok: false, error: "timeline_connector_invalid" };
  if (raw.kind === "new") return { ok: true, value: { kind: "new" } };
  const id = parseCustomConnectorId(raw.connectorId);
  if (
    raw.kind === "revision" &&
    id.ok &&
    typeof raw.expectedHeadRevision === "number" &&
    Number.isSafeInteger(raw.expectedHeadRevision) &&
    raw.expectedHeadRevision > 0
  )
    return {
      ok: true,
      value: {
        kind: "revision",
        connectorId: id.value,
        expectedHeadRevision: raw.expectedHeadRevision,
      },
    };
  return { ok: false, error: "timeline_connector_invalid" };
}
