import { parseChatThreadActivity, type ChatThreadActivity } from "../index.ts";
import {
  parseChatPermissionRequest,
  type ChatPermissionRequest,
} from "../index.ts";
import { isProjectRole, type ProjectRole } from "../index.ts";
import {
  isChatTranscriptionPath,
  isVoiceEngineId,
  type ChatTranscriptionPath,
  type VoiceEngineId,
} from "../index.ts";
import { isConversationId } from "../index.ts";
import type { ConversationId } from "../index.ts";
import {
  parseChatOrigin,
  parseSurfaceArea,
  type ChatOrigin,
  type SurfaceArea,
} from "../surface-observation.ts";
import {
  parseChatThreadLineage,
  type ChatThreadLineage,
  type ChatDerivedThread,
} from "../index.ts";
import {
  parseProjectSnapshot,
  type ProjectSnapshot,
  parseChatPlacement,
  type ChatPlacement,
  parseChatContextDetails,
  type ChatContextDetails,
} from "../index.ts";
import {
  parseAuthoredConnector,
  type ConnectorAuthoringResult,
} from "./custom-connectors.ts";
import type { Variant } from "@seams/type-utils";
import { isNonNegativeInteger, isRecord } from "@seams/std";
import {
  type ActiveConversationMetadata,
  type ArchivedConversationMetadata,
  type ChatApproval,
  type ChatEffort,
  type ChatModelCapabilities,
  type ChatQuestion,
  type ChatReceiptReference,
  type ChatSource,
  type ChatToolView,
  type ChatTurnUsage,
  parseChatQuestion,
} from "../index.ts";

type ConnectorCardTarget =
  | {
      readonly kind: "new";
      readonly connectorId?: never;
      readonly expectedHeadRevision?: never;
    }
  | {
      readonly kind: "revision";
      readonly connectorId: string;
      readonly expectedHeadRevision: number;
    };

export type ChatMessage =
  | {
      readonly kind: "user" | "assistant" | "activity";
      readonly id: string;
      readonly text: string;
      readonly connector?: never;
      readonly target?: never;
    }
  | {
      readonly kind: "connector";
      readonly id: string;
      readonly text: string;
      readonly connector: Variant<ConnectorAuthoringResult, "ready">;
      readonly target: ConnectorCardTarget;
    };

type ChatTimelineBase = {
  readonly eventId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly createdAt: number;
};

export type ChatAttachmentView = {
  readonly kind: "attachment";
  readonly attachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly preparation: "ready";
};

/** The page that went with a message, as its mark names it. */
export type ChatSentFrom = Readonly<{
  area: SurfaceArea;
  title: string;
  record: string | null;
}>;

export type ChatTimelineView =
  | (ChatTimelineBase & {
      readonly kind: "user";
      readonly text: string;
      readonly attachments: readonly ChatAttachmentView[];
      /**
       * The way a spoken command was transcribed. A typed message has none, and
       * a message from before Plan 82C names no engine.
       */
      readonly spoken?: Readonly<{
        path: ChatTranscriptionPath;
        engine: VoiceEngineId | null;
      }>;
      /** The page that went with the message (Plan 87). A message with no page has none. */
      readonly sentFrom?: ChatSentFrom;
    })
  | (ChatTimelineBase & {
      readonly kind:
        "activity" | "context" | "progress" | "run_failed" | "run_cancelled";
      readonly text: string;
      readonly question?: never;
      readonly contextDetails?: ChatContextDetails;
    })
  | (ChatTimelineBase & {
      readonly kind: "assistant";
      readonly text: string;
      readonly question?: ChatQuestion;
      readonly rating?: "good" | "bad" | null;
      readonly sources?: readonly ChatSource[];
      readonly usage?: ChatTurnUsage | null;
    })
  | (ChatTimelineBase & {
      readonly kind: "connector";
      readonly text: string;
      readonly connector: Variant<ConnectorAuthoringResult, "ready">;
      readonly target: ConnectorCardTarget;
    })
  | (ChatTimelineBase & {
      readonly kind: "tool_started";
      readonly tool: ChatToolView;
    })
  | (ChatTimelineBase & {
      readonly kind: "tool_settled";
      readonly tool: ChatToolView;
      readonly outcome: "succeeded" | "failed" | "denied" | "indeterminate";
      readonly summary: string;
      readonly receipt: ChatReceiptReference | null;
    })
  | (ChatTimelineBase & {
      readonly kind: "approval";
      readonly approval: ChatApproval;
    })
  | (ChatTimelineBase & {
      readonly kind: "receipt";
      readonly receipt: ChatReceiptReference;
    });

export type ChatWork =
  | { readonly kind: "ready" }
  | {
      readonly kind: "running";
      readonly requestId: string;
      readonly expiresAt: number;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "cancelling";
      readonly requestId: string;
      readonly cancellationId: string;
      readonly expiresAt: number;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "awaiting_permission";
      readonly requestId: string;
      readonly permission: ChatPermissionRequest;
    }
  | {
      readonly kind: "failed";
      readonly requestId: string;
      readonly error: string;
      readonly recovery: "projection_capacity" | "interrupted" | null;
    };

export type ChatPendingInput = {
  readonly inputId: string;
  readonly requestId: string;
  readonly text: string;
  readonly mode: "next" | "steer";
  readonly acceptedAt: number;
  readonly effort?: ChatEffort;
};

type ChatMetadata = ActiveConversationMetadata | ArchivedConversationMetadata;

type ChatSharing = Readonly<{
  visibility: "private" | "shared";
  role: ProjectRole;
}>;

export type ChatConversationSummary = Readonly<{
  sharing: ChatSharing;
  id: ConversationId;
  title: string;
  revision: number;
  latestSequence: number;
  lastReadSequence: number;
  activity: ChatThreadActivity;
  placement: ChatPlacement;
  updatedAt: number;
  /** The chat that proposed this side Case; null for any other chat. */
  parentConversationId: ConversationId | null;
  /** Where the chat started (Plan 87); null when its first message carried no page. */
  origin: ChatOrigin | null;
}> &
  ChatMetadata;

export type Chat = Readonly<{
  readonly sharing: ChatSharing | null;
  readonly lineage: ChatThreadLineage;
  /** Where the chat started (Plan 87); null when its first message carried no page. */
  readonly origin: ChatOrigin | null;
  readonly forkableResponseIds: readonly string[];
  readonly projectContext: ProjectSnapshot | null;
  readonly placement: ChatPlacement | null;
  readonly id: ConversationId;
  readonly title: string;
  readonly revision: number;
  readonly model: string;
  readonly effort: ChatEffort | null;
  readonly messages: readonly ChatMessage[];
  readonly timeline: readonly ChatTimelineView[];
  readonly latestSequence: number;
  readonly lastReadSequence: number;
  readonly draft: Readonly<{
    readonly text: string;
    readonly updatedAt: number | null;
  }>;
  readonly pendingInputs: readonly ChatPendingInput[];
  readonly work: ChatWork;
}> &
  ChatMetadata;

export type ChatModelOption = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: ChatModelCapabilities;
};

export type PendingChatDeletion = Readonly<{
  conversationId: ConversationId;
  title: string;
  operationId: string;
  expectedRevision: number;
  kind: "cleaning" | "failed";
}>;

export function parseChat(raw: unknown): Chat {
  if (
    !isRecord(raw) ||
    !isConversationId(raw.id) ||
    typeof raw.title !== "string" ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    typeof raw.model !== "string" ||
    !Array.isArray(raw.messages) ||
    !isRecord(raw.work)
  )
    throw new Error("Invalid conversation response.");
  const messages: ChatMessage[] = [];
  for (const message of raw.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      typeof message.text !== "string"
    )
      throw new Error("Invalid conversation message.");
    switch (message.kind) {
      case "user":
      case "assistant":
      case "activity":
        messages.push({
          kind: message.kind,
          id: message.id,
          text: message.text,
        });
        break;
      case "connector":
        if (!isRecord(message.document))
          throw new Error("Invalid connector card.");
        messages.push({
          kind: "connector",
          id: message.id,
          text: message.text,
          connector: parseAuthoredConnector(message.document),
          target: parseTarget(message.target),
        });
        break;
      default:
        throw new Error("Invalid message type.");
    }
  }
  const work = parseChatWork(raw.work);
  const effort = parseChatEffort(raw.effort);
  if (raw.effort !== undefined && raw.effort !== null && effort === null)
    throw new Error("Invalid conversation effort.");
  return {
    sharing: raw.sharing === undefined ? null : parseChatSharing(raw.sharing),
    lineage: requireChatLineage(raw.lineage),
    origin: parseChatOrigin(raw.origin),
    forkableResponseIds: parseForkableResponseIds(raw.forkableResponseIds),
    id: raw.id,
    title: raw.title,
    revision: raw.revision,
    model: raw.model,
    projectContext:
      raw.projectContext === undefined || raw.projectContext === null
        ? null
        : requireProjectSnapshot(raw.projectContext),
    placement:
      raw.placement === undefined ? null : parseChatPlacement(raw.placement),
    effort,
    messages,
    timeline: parseChatTimeline(raw.timeline),
    latestSequence: parseSequence(raw.latestSequence),
    lastReadSequence: parseSequence(raw.lastReadSequence),
    draft: parseChatDraft(raw.draft),
    pendingInputs: parsePendingInputs(raw.pendingInputs),
    work,
    ...parseChatMetadata(raw),
  };
}

export function parseChatSummary(raw: unknown): ChatConversationSummary {
  if (
    !isRecord(raw) ||
    !isConversationId(raw.id) ||
    typeof raw.title !== "string" ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1
  )
    throw new Error("Invalid conversation list.");
  const placement = parseChatPlacement(raw.placement);
  if (placement === null) throw new Error("Invalid chat placement.");
  const activity = parseChatThreadActivity(raw.activity);
  if (activity === null) throw new Error("Invalid chat activity.");
  return {
    sharing: parseChatSharing(raw.sharing),
    id: raw.id,
    title: raw.title,
    revision: raw.revision,
    placement,
    updatedAt: parseSequence(raw.updatedAt),
    latestSequence: parseSequence(raw.latestSequence),
    lastReadSequence: parseSequence(raw.lastReadSequence),
    activity,
    parentConversationId: isConversationId(raw.parentConversationId)
      ? raw.parentConversationId
      : null,
    origin: parseChatOrigin(raw.origin),
    ...parseChatMetadata(raw),
  };
}

function parseSequence(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : 0;
}

function parseChatDraft(raw: unknown): Chat["draft"] {
  if (
    !isRecord(raw) ||
    typeof raw.text !== "string" ||
    (raw.updatedAt !== null && typeof raw.updatedAt !== "number")
  )
    return { text: "", updatedAt: null };
  return { text: raw.text, updatedAt: raw.updatedAt };
}

function parseChatTimeline(raw: unknown): readonly ChatTimelineView[] {
  if (!Array.isArray(raw)) return [];
  const events: ChatTimelineView[] = [];
  for (const value of raw) {
    const event = parseChatTimelineEvent(value);
    if (event !== null) events.push(event);
  }
  return events;
}

function parseChatTimelineEvent(raw: unknown): ChatTimelineView | null {
  if (
    !isRecord(raw) ||
    typeof raw.eventId !== "string" ||
    !isNonNegativeInteger(raw.sequence) ||
    typeof raw.requestId !== "string" ||
    !isNonNegativeInteger(raw.createdAt) ||
    typeof raw.kind !== "string"
  )
    return null;
  const question =
    raw.kind === "assistant" && raw.question !== undefined
      ? parseChatQuestion(raw.question)
      : undefined;
  if (question === null)
    throw new Error("Could not read the assistant’s question.");
  const rating = raw.rating ?? null;
  if (
    raw.kind === "assistant" &&
    rating !== null &&
    rating !== "good" &&
    rating !== "bad"
  )
    throw new Error("Could not read response feedback.");
  const base = {
    eventId: raw.eventId,
    sequence: raw.sequence,
    requestId: raw.requestId,
    createdAt: raw.createdAt,
  };
  if (raw.kind === "assistant" && typeof raw.text === "string")
    return {
      ...base,
      kind: "assistant",
      text: raw.text,
      ...(question === undefined ? {} : { question }),
      rating: rating === "good" || rating === "bad" ? rating : null,
      sources: parseChatSources(raw.sources),
      usage: parseChatUsage(raw.usage),
    };
  if (raw.kind === "user" && typeof raw.text === "string")
    return {
      ...base,
      kind: "user",
      text: raw.text,
      attachments: parseChatAttachmentViews(raw.parts),
      ...parseSpokenPath(raw.parts),
      ...parseSentFrom(raw.parts),
    };
  if (
    (raw.kind === "activity" ||
      raw.kind === "context" ||
      raw.kind === "progress" ||
      raw.kind === "run_failed" ||
      raw.kind === "run_cancelled") &&
    typeof raw.text === "string"
  ) {
    const contextDetails =
      raw.contextDetails === undefined
        ? undefined
        : parseChatContextDetails(raw.contextDetails);
    if (contextDetails === null) throw new Error("Invalid confirmed context");
    return {
      ...base,
      kind: raw.kind,
      text: raw.text,
      ...(contextDetails === undefined ? {} : { contextDetails }),
    };
  }
  if (
    raw.kind === "connector" &&
    typeof raw.text === "string" &&
    isRecord(raw.document)
  )
    return {
      ...base,
      kind: "connector",
      text: raw.text,
      connector: parseAuthoredConnector(raw.document),
      target: parseTarget(raw.target),
    };
  if (raw.kind === "tool_started" && isRecord(raw.tool)) {
    const tool = parseChatTool(raw.tool);
    return tool === null ? null : { ...base, kind: "tool_started", tool };
  }
  if (
    raw.kind === "tool_settled" &&
    isRecord(raw.tool) &&
    typeof raw.summary === "string" &&
    (raw.outcome === "succeeded" ||
      raw.outcome === "failed" ||
      raw.outcome === "denied" ||
      raw.outcome === "indeterminate")
  ) {
    const tool = parseChatTool(raw.tool);
    const receipt = raw.receipt === null ? null : parseChatReceipt(raw.receipt);
    return tool === null || (raw.receipt !== null && receipt === null)
      ? null
      : {
          ...base,
          kind: "tool_settled",
          tool,
          outcome: raw.outcome,
          summary: raw.summary,
          receipt,
        };
  }
  if (raw.kind === "approval" && isRecord(raw.approval)) {
    const approval = parseChatApproval(raw.approval);
    return approval === null ? null : { ...base, kind: "approval", approval };
  }
  if (raw.kind === "receipt") {
    const receipt = parseChatReceipt(raw.receipt);
    return receipt === null ? null : { ...base, kind: "receipt", receipt };
  }
  return null;
}

function parseChatTool(raw: Record<string, unknown>): ChatToolView | null {
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
    return null;
  return {
    toolCallId: raw.toolCallId,
    action: raw.action,
    object: raw.object,
    destination: raw.destination,
    risk: raw.risk,
    detailsExpandable: raw.detailsExpandable,
  };
}

function parseChatApproval(raw: Record<string, unknown>): ChatApproval | null {
  if (
    raw.kind === "requested" &&
    typeof raw.approvalId === "string" &&
    typeof raw.operation === "string" &&
    typeof raw.destination === "string" &&
    typeof raw.effect === "string" &&
    isNonNegativeInteger(raw.expiresAt) &&
    isStringRecord(raw.fields) &&
    typeof raw.alwaysAllow === "boolean"
  )
    return {
      kind: "requested",
      approvalId: raw.approvalId,
      operation: raw.operation,
      destination: raw.destination,
      effect: raw.effect,
      expiresAt: raw.expiresAt,
      fields: raw.fields,
      alwaysAllow: raw.alwaysAllow,
    };
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
      kind: "settled",
      approvalId: raw.approvalId,
      decisionId: raw.decisionId,
      outcome: raw.outcome,
      settledAt: raw.settledAt,
    };
  return null;
}

function parseChatReceipt(raw: unknown): ChatReceiptReference | null {
  if (
    !isRecord(raw) ||
    typeof raw.receiptId !== "string" ||
    (raw.state !== "pending" &&
      raw.state !== "succeeded" &&
      raw.state !== "failed" &&
      raw.state !== "reconciliation_required") ||
    typeof raw.summary !== "string"
  )
    return null;
  return { receiptId: raw.receiptId, state: raw.state, summary: raw.summary };
}

function parseChatSources(raw: unknown): readonly ChatSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: ChatSource[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      typeof value.sourceId !== "string" ||
      typeof value.label !== "string" ||
      typeof value.host !== "string" ||
      (value.url !== null && typeof value.url !== "string") ||
      (value.kind !== "documentation" &&
        value.kind !== "tool" &&
        value.kind !== "attachment")
    )
      continue;
    sources.push({
      sourceId: value.sourceId,
      label: value.label,
      host: value.host,
      url: value.url,
      kind: value.kind,
    });
  }
  return sources;
}

function parseChatUsage(raw: unknown): ChatTurnUsage | null {
  if (
    !isRecord(raw) ||
    typeof raw.requestId !== "string" ||
    !isNonNegativeInteger(raw.inputTokens) ||
    !isNonNegativeInteger(raw.outputTokens) ||
    !isNonNegativeInteger(raw.totalTokens) ||
    (raw.cachedInputTokens !== null &&
      !isNonNegativeInteger(raw.cachedInputTokens)) ||
    !isNonNegativeInteger(raw.measuredAt)
  )
    return null;
  return {
    requestId: raw.requestId,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cachedInputTokens: raw.cachedInputTokens,
    totalTokens: raw.totalTokens,
    measuredAt: raw.measuredAt,
  };
}

function isStringRecord(raw: unknown): raw is Readonly<Record<string, string>> {
  if (!isRecord(raw)) return false;
  return Object.values(raw).every(function isString(value) {
    return typeof value === "string";
  });
}

function parsePendingInputs(raw: unknown): readonly ChatPendingInput[] {
  if (!Array.isArray(raw)) return [];
  const pending: ChatPendingInput[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      typeof value.inputId !== "string" ||
      typeof value.requestId !== "string" ||
      (value.mode !== "next" && value.mode !== "steer") ||
      typeof value.acceptedAt !== "number" ||
      !Number.isSafeInteger(value.acceptedAt) ||
      !Array.isArray(value.parts)
    )
      continue;
    const text = value.parts.filter(isTextPart).map(readTextPart).join("\n");
    if (text.length === 0) continue;
    const effort = parseChatEffort(value.effort);
    if (value.effort !== undefined && value.effort !== null && effort === null)
      continue;
    pending.push({
      inputId: value.inputId,
      requestId: value.requestId,
      text,
      mode: value.mode,
      acceptedAt: value.acceptedAt,
      ...(effort === null ? {} : { effort }),
    });
  }
  return pending;
}

function isTextPart(
  value: unknown,
): value is { readonly kind: "text"; readonly text: string } {
  return (
    isRecord(value) && value.kind === "text" && typeof value.text === "string"
  );
}

function readTextPart(value: {
  readonly kind: "text";
  readonly text: string;
}): string {
  return value.text;
}

function parseChatEffort(raw: unknown): ChatEffort | null {
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return null;
}

function parseChatMetadata(raw: Record<string, unknown>): ChatMetadata {
  if (
    raw.lifecycle === "active" &&
    (raw.pinnedAt === null ||
      (typeof raw.pinnedAt === "number" &&
        Number.isSafeInteger(raw.pinnedAt))) &&
    raw.archivedAt === undefined
  )
    return { lifecycle: "active", pinnedAt: raw.pinnedAt };
  if (
    raw.lifecycle === "archived" &&
    (raw.pinnedAt === null ||
      (typeof raw.pinnedAt === "number" &&
        Number.isSafeInteger(raw.pinnedAt))) &&
    typeof raw.archivedAt === "number" &&
    Number.isSafeInteger(raw.archivedAt)
  )
    return {
      lifecycle: "archived",
      pinnedAt: raw.pinnedAt,
      archivedAt: raw.archivedAt,
    };
  throw new Error("Invalid conversation state.");
}

export function parseChatModelOptions(
  raw: readonly unknown[],
): ChatModelOption[] {
  const options: ChatModelOption[] = [];
  for (const option of raw) {
    if (
      !isRecord(option) ||
      typeof option.id !== "string" ||
      typeof option.name !== "string" ||
      typeof option.description !== "string"
    )
      throw new Error("Could not read the available AI models.");
    options.push({
      id: option.id,
      name: option.name,
      description: option.description,
      capabilities: parseChatModelCapabilities(option.capabilities),
    });
  }
  if (options.length === 0)
    throw new Error("No AI models are available for this workspace.");
  return options;
}

function parseChatModelCapabilities(raw: unknown): ChatModelCapabilities {
  if (!isRecord(raw) || !isRecord(raw.input)) {
    throw new Error("Could not read the available AI model capabilities.");
  }
  const effortOptions = parseChatEfforts(raw.effortOptions);
  if (
    raw.input.text !== true ||
    typeof raw.input.images !== "boolean" ||
    typeof raw.input.documents !== "boolean" ||
    typeof raw.tools !== "boolean" ||
    typeof raw.progressSummaries !== "boolean" ||
    typeof raw.citations !== "boolean" ||
    (raw.contextWindowTokens !== null &&
      (typeof raw.contextWindowTokens !== "number" ||
        !Number.isSafeInteger(raw.contextWindowTokens) ||
        raw.contextWindowTokens < 1))
  ) {
    throw new Error("Could not read the available AI model capabilities.");
  }
  return {
    input: {
      text: true,
      images: raw.input.images,
      documents: raw.input.documents,
    },
    tools: raw.tools,
    progressSummaries: raw.progressSummaries,
    citations: raw.citations,
    effortOptions,
    contextWindowTokens: raw.contextWindowTokens,
  };
}

function parseChatEfforts(raw: unknown): ChatEffort[] {
  if (!Array.isArray(raw)) {
    throw new Error("Could not read the available AI model efforts.");
  }
  const efforts: ChatEffort[] = [];
  for (const value of raw) {
    if (value !== "low" && value !== "medium" && value !== "high") {
      throw new Error("Could not read the available AI model efforts.");
    }
    efforts.push(value);
  }
  return efforts;
}

function parseTarget(raw: unknown): ConnectorCardTarget {
  if (!isRecord(raw)) throw new Error("Invalid connector target.");
  if (raw.kind === "new") return { kind: "new" };
  if (
    raw.kind === "revision" &&
    typeof raw.connectorId === "string" &&
    typeof raw.expectedHeadRevision === "number" &&
    Number.isSafeInteger(raw.expectedHeadRevision) &&
    raw.expectedHeadRevision > 0
  )
    return {
      kind: "revision",
      connectorId: raw.connectorId,
      expectedHeadRevision: raw.expectedHeadRevision,
    };
  throw new Error("Invalid connector revision target.");
}

export function parseChatWork(raw: unknown): ChatWork {
  if (!isRecord(raw)) throw new Error("Invalid conversation status.");
  const permission =
    raw.kind === "awaiting_permission"
      ? parseChatPermissionRequest(raw.permission)
      : null;
  let work: ChatWork;
  if (raw.kind === "ready") work = { kind: "ready" };
  else if (
    raw.kind === "running" &&
    typeof raw.requestId === "string" &&
    typeof raw.expiresAt === "number" &&
    typeof raw.sessionId === "string" &&
    typeof raw.turnId === "string"
  )
    work = {
      kind: "running",
      requestId: raw.requestId,
      expiresAt: raw.expiresAt,
      sessionId: raw.sessionId,
      turnId: raw.turnId,
    };
  else if (
    raw.kind === "cancelling" &&
    typeof raw.requestId === "string" &&
    typeof raw.cancellationId === "string" &&
    typeof raw.expiresAt === "number" &&
    typeof raw.sessionId === "string" &&
    typeof raw.turnId === "string"
  )
    work = {
      kind: "cancelling",
      requestId: raw.requestId,
      cancellationId: raw.cancellationId,
      expiresAt: raw.expiresAt,
      sessionId: raw.sessionId,
      turnId: raw.turnId,
    };
  else if (
    raw.kind === "awaiting_permission" &&
    typeof raw.requestId === "string" &&
    permission !== null
  )
    work = {
      kind: "awaiting_permission",
      requestId: raw.requestId,
      permission,
    };
  else if (
    raw.kind === "failed" &&
    typeof raw.requestId === "string" &&
    typeof raw.error === "string"
  )
    work = {
      kind: "failed",
      requestId: raw.requestId,
      error: raw.error,
      recovery:
        isRecord(raw.recovery) &&
        (raw.recovery.kind === "projection_capacity" ||
          raw.recovery.kind === "interrupted")
          ? raw.recovery.kind
          : null,
    };
  else throw new Error("Invalid conversation status.");
  return work;
}

function requireProjectSnapshot(raw: unknown): ProjectSnapshot {
  const snapshot = parseProjectSnapshot(raw);
  if (snapshot === null) throw new Error("Invalid accepted project context.");
  return snapshot;
}

export function parsePendingChatDeletions(
  raw: unknown,
): readonly PendingChatDeletion[] {
  if (!Array.isArray(raw)) throw new Error("Could not read deletion progress.");
  const entries: PendingChatDeletion[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      !isConversationId(item.conversationId) ||
      typeof item.title !== "string" ||
      typeof item.operationId !== "string" ||
      typeof item.expectedRevision !== "number" ||
      !Number.isSafeInteger(item.expectedRevision) ||
      (item.kind !== "cleaning" && item.kind !== "failed")
    )
      throw new Error("Invalid deletion progress.");
    entries.push({
      conversationId: item.conversationId,
      title: item.title,
      operationId: item.operationId,
      expectedRevision: item.expectedRevision,
      kind: item.kind,
    });
  }
  return entries;
}

export function parsePinnedConversations(
  raw: unknown,
): readonly ChatConversationSummary[] {
  if (!Array.isArray(raw)) throw new Error("Could not read pinned chats.");
  const summaries: ChatConversationSummary[] = [];
  for (const item of raw) {
    const summary = parseChatSummary(item);
    if (summary.lifecycle !== "active" || summary.pinnedAt === null)
      throw new Error("Invalid pinned chat.");
    summaries.push(summary);
  }
  return summaries;
}

function requireChatLineage(raw: unknown): ChatThreadLineage {
  const lineage = parseChatThreadLineage(raw);
  if (lineage === null) throw new Error("Invalid chat ancestry.");
  return lineage;
}

function parseForkableResponseIds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) throw new Error("Invalid chat fork boundaries.");
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string")
      throw new Error("Invalid chat fork boundary.");
    ids.push(value);
  }
  return ids;
}

export function parseDerivedThreads(
  raw: unknown,
): readonly ChatDerivedThread[] {
  if (!Array.isArray(raw)) throw new Error("Invalid derived chats.");
  const threads: ChatDerivedThread[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !isConversationId(value.id) ||
      typeof value.title !== "string" ||
      typeof value.sourceMessageId !== "string"
    )
      throw new Error("Invalid derived chat.");
    threads.push({
      id: value.id,
      title: value.title,
      sourceMessageId: value.sourceMessageId,
    });
  }
  return threads;
}

function parseChatSharing(raw: unknown): ChatSharing {
  if (
    !isRecord(raw) ||
    (raw.visibility !== "private" && raw.visibility !== "shared") ||
    !isProjectRole(raw.role)
  )
    throw new Error("Could not read chat visibility.");
  return { visibility: raw.visibility, role: raw.role };
}

function parseSentFrom(raw: unknown): Readonly<{ sentFrom?: ChatSentFrom }> {
  if (!Array.isArray(raw)) return {};
  for (const part of raw) {
    if (!isRecord(part) || part.kind !== "screen") continue;
    const area = parseSurfaceArea(part.area);
    if (
      area === null ||
      typeof part.title !== "string" ||
      (part.record !== null && typeof part.record !== "string")
    )
      return {};
    return { sentFrom: { area, title: part.title, record: part.record } };
  }
  return {};
}

function parseSpokenPath(
  raw: unknown,
): Pick<Extract<ChatTimelineView, { kind: "user" }>, "spoken"> {
  if (!Array.isArray(raw)) return {};
  for (const part of raw)
    if (
      isRecord(part) &&
      part.kind === "voice" &&
      isChatTranscriptionPath(part.transcriptionPath)
    )
      return {
        spoken: {
          path: part.transcriptionPath,
          engine: isVoiceEngineId(part.transcriptionEngine)
            ? part.transcriptionEngine
            : null,
        },
      };
  return {};
}

function parseChatAttachmentViews(raw: unknown): readonly ChatAttachmentView[] {
  if (!Array.isArray(raw)) throw new Error("Invalid message parts.");
  const attachments: ChatAttachmentView[] = [];
  for (const part of raw) {
    if (!isRecord(part)) throw new Error("Invalid message part.");
    if (part.kind !== "attachment") continue;
    if (
      typeof part.attachmentId !== "string" ||
      typeof part.filename !== "string" ||
      typeof part.mediaType !== "string" ||
      part.preparation !== "ready"
    )
      throw new Error("Invalid message attachment.");
    attachments.push({
      kind: "attachment",
      attachmentId: part.attachmentId,
      filename: part.filename,
      mediaType: part.mediaType,
      preparation: "ready",
    });
  }
  return attachments;
}
