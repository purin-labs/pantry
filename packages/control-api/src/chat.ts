import {
  assertNever,
  hasExactKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSha256Hex,
} from "@purin-labs/std";

export type ChatThreadActivity = "idle" | "working" | "approval" | "failed";

export function parseChatThreadActivity(raw: unknown): ChatThreadActivity | null {
  switch (raw) {
    case "idle":
    case "working":
    case "approval":
    case "failed":
      return raw;
    default:
      return null;
  }
}

export function chatThreadActivity(
  workKind:
    | "ready"
    | "running"
    | "awaiting_permission"
    | "cancelling"
    | "failed",
): ChatThreadActivity {
  switch (workKind) {
    case "ready":
      return "idle";
    case "running":
    case "cancelling":
      return "working";
    case "awaiting_permission":
      return "approval";
    case "failed":
      return "failed";
    default:
      return assertNever(workKind);
  }
}

export type ChatContextDetails =
  | Readonly<{
      kind: "preparing";
      area: "kitchen";
      effectId: string;
      source?: never;
    }>
  | Readonly<{
      kind: "failed" | "cancelled";
      area: "kitchen";
      effectId: string;
      message: string;
      source?: never;
    }>
  | Readonly<{
      kind: "observed";
      /** Workspace: a connected file or another resource of no product area. */
      area: "commerce" | "cafe" | "kitchen" | "Workspace";
      source: Readonly<{
        id: string;
        revision: string;
        digest: string;
        observedAt: number;
        origin: "saved" | "business" | "file";
      }>;
      effectId?: never;
    }>
  | Readonly<{
      kind: "ready";
      area: "kitchen";
      effectId: string;
      browserInstanceId: string;
      surfaceSessionId: string;
      surfaceEpoch: number;
      digest: string;
      observedAt: number;
      source?: never;
    }>;

export function parseChatContextDetails(
  raw: unknown,
): ChatContextDetails | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "observed") {
    if (
      (raw.area !== "commerce" &&
        raw.area !== "cafe" &&
        raw.area !== "kitchen" &&
        raw.area !== "Workspace") ||
      !hasExactKeys(raw, ["kind", "area", "source"]) ||
      !isRecord(raw.source)
    )
      return null;
    const source = raw.source;
    if (
      !hasExactKeys(source, [
        "id",
        "revision",
        "digest",
        "observedAt",
        "origin",
      ]) ||
      !isNonEmptyString(source.id) ||
      !isNonEmptyString(source.revision) ||
      !isSha256Hex(source.digest) ||
      !isNonNegativeInteger(source.observedAt) ||
      (source.origin !== "saved" &&
        source.origin !== "business" &&
        source.origin !== "file")
    )
      return null;
    return {
      kind: "observed",
      area: raw.area,
      source: {
        id: source.id,
        revision: source.revision,
        digest: source.digest,
        observedAt: source.observedAt,
        origin: source.origin,
      },
    };
  }
  if (raw.area !== "kitchen" || !isNonEmptyString(raw.effectId)) return null;
  if (
    raw.kind === "preparing" &&
    hasExactKeys(raw, ["kind", "area", "effectId"])
  )
    return { kind: "preparing", area: "kitchen", effectId: raw.effectId };
  if (
    (raw.kind === "failed" || raw.kind === "cancelled") &&
    hasExactKeys(raw, ["kind", "area", "effectId", "message"]) &&
    isNonEmptyString(raw.message)
  )
    return {
      kind: raw.kind,
      area: "kitchen",
      effectId: raw.effectId,
      message: raw.message,
    };
  if (
    raw.kind === "ready" &&
    hasExactKeys(raw, [
      "kind",
      "area",
      "effectId",
      "browserInstanceId",
      "surfaceSessionId",
      "surfaceEpoch",
      "digest",
      "observedAt",
    ]) &&
    isNonEmptyString(raw.browserInstanceId) &&
    isNonEmptyString(raw.surfaceSessionId) &&
    isNonNegativeInteger(raw.surfaceEpoch) &&
    isSha256Hex(raw.digest) &&
    isNonNegativeInteger(raw.observedAt)
  )
    return {
      kind: "ready",
      area: "kitchen",
      effectId: raw.effectId,
      browserInstanceId: raw.browserInstanceId,
      surfaceSessionId: raw.surfaceSessionId,
      surfaceEpoch: raw.surfaceEpoch,
      digest: raw.digest,
      observedAt: raw.observedAt,
    };
  return null;
}

export type ChatQuestion = {
  readonly title: string;
  readonly description: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[];
  readonly allowCustom: boolean;
};

export function parseChatQuestion(raw: unknown): ChatQuestion | null {
  if (
    !isRecord(raw) ||
    !isQuestionText(raw.title, 300) ||
    typeof raw.description !== "string" ||
    raw.description.length > 1000 ||
    typeof raw.allowCustom !== "boolean" ||
    !Array.isArray(raw.options) ||
    raw.options.length > 6 ||
    (raw.options.length === 0 && !raw.allowCustom)
  )
    return null;
  const options: ChatQuestion["options"][number][] = [];
  const ids = new Set<string>();
  for (const option of raw.options) {
    if (
      !isRecord(option) ||
      !isQuestionText(option.id, 64) ||
      ids.has(option.id) ||
      !isQuestionText(option.label, 200) ||
      typeof option.description !== "string" ||
      option.description.length > 500
    )
      return null;
    ids.add(option.id);
    options.push({
      id: option.id,
      label: option.label,
      description: option.description,
    });
  }
  return {
    title: raw.title,
    description: raw.description,
    options,
    allowCustom: raw.allowCustom,
  };
}

function isQuestionText(raw: unknown, limit: number): raw is string {
  return (
    typeof raw === "string" && raw.trim().length > 0 && raw.length <= limit
  );
}

export type ChatSource = {
  readonly sourceId: string;
  readonly label: string;
  readonly host: string;
  readonly url: string | null;
  readonly kind: "documentation" | "tool" | "attachment";
};

export type ChatToolView = {
  readonly toolCallId: string;
  readonly action: string;
  readonly object: string;
  readonly destination: string;
  readonly risk: "read" | "write" | "destructive";
  readonly detailsExpandable: boolean;
};

export type ChatEffort = "low" | "medium" | "high";

export type ChatModelCapabilities = {
  readonly input: {
    readonly text: true;
    readonly images: boolean;
    readonly documents: boolean;
  };
  readonly tools: boolean;
  readonly progressSummaries: boolean;
  readonly citations: boolean;
  readonly effortOptions: readonly ChatEffort[];
  readonly contextWindowTokens: number | null;
};

export type ActiveConversationMetadata = {
  readonly lifecycle: "active";
  readonly pinnedAt: number | null;
  readonly archivedAt?: never;
};

export type ArchivedConversationMetadata = {
  readonly lifecycle: "archived";
  readonly pinnedAt: number | null;
  readonly archivedAt: number;
};

export type ChatTurnUsage = {
  readonly requestId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number;
  readonly measuredAt: number;
};

export type ChatApproval =
  | {
      readonly kind: "requested";
      readonly approvalId: string;
      readonly operation: string;
      readonly destination: string;
      readonly effect: string;
      readonly expiresAt: number;
      readonly fields: Readonly<Record<string, string>>;
      readonly alwaysAllow: boolean;
    }
  | {
      readonly kind: "settled";
      readonly approvalId: string;
      readonly decisionId: string;
      readonly outcome:
        "allowed_once" | "always_allowed" | "denied" | "expired" | "failed";
      readonly settledAt: number;
    };

/**
 * What a paused run needs. A `capability` item is a workspace capability that
 * a chat action needs; allowing it turns the capability on. An
 * `agent_request` item belongs to the agent permission request whose id is
 * the request's `permissionRequestId`; allowing it turns capabilities on and
 * adds grants through that request. The run stays paused until a person
 * allows the request or stops the run.
 */
export type ChatPermissionItem =
  | {
      readonly kind: "capability";
      readonly capabilityId: string;
      readonly capabilityVersion: number;
      readonly label: string;
      readonly description: string;
      readonly itemId?: never;
    }
  | {
      readonly kind: "agent_request";
      readonly itemId: string;
      readonly label: string;
      readonly description: string;
      readonly capabilityId?: never;
      readonly capabilityVersion?: never;
    };

export type ChatPermissionRequest = {
  readonly permissionRequestId: string;
  /** What the agent tried to do, e.g. "Read a public link". */
  readonly action: string;
  /** The exact target of the attempt, e.g. the URL, when it has one. */
  readonly object: string | null;
  readonly items: readonly ChatPermissionItem[];
  readonly requestedAt: number;
};

export type ChatPermissionDecision = "resume" | "deny";

export function parseChatPermissionRequest(
  raw: unknown,
): ChatPermissionRequest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "permissionRequestId",
      "action",
      "object",
      "items",
      "requestedAt",
    ]) ||
    !isQuestionText(raw.permissionRequestId, 128) ||
    !isQuestionText(raw.action, 200) ||
    (raw.object !== null && !isQuestionText(raw.object, 2048)) ||
    !isNonNegativeInteger(raw.requestedAt) ||
    !Array.isArray(raw.items) ||
    raw.items.length === 0 ||
    raw.items.length > 8
  )
    return null;
  const items: ChatPermissionItem[] = [];
  for (const item of raw.items) {
    const parsed = parseChatPermissionItem(item);
    if (
      parsed === null ||
      items.some(
        (existing) =>
          chatPermissionItemKey(existing) === chatPermissionItemKey(parsed),
      )
    )
      return null;
    items.push(parsed);
  }
  // One request holds one kind of item.
  if (items.some((item) => item.kind !== items[0]?.kind)) return null;
  return {
    permissionRequestId: raw.permissionRequestId,
    action: raw.action,
    object: raw.object,
    items,
    requestedAt: raw.requestedAt,
  };
}

function parseChatPermissionItem(raw: unknown): ChatPermissionItem | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "capability" &&
    hasExactKeys(raw, [
      "kind",
      "capabilityId",
      "capabilityVersion",
      "label",
      "description",
    ]) &&
    isQuestionText(raw.capabilityId, 128) &&
    isNonNegativeInteger(raw.capabilityVersion) &&
    isQuestionText(raw.label, 200) &&
    typeof raw.description === "string" &&
    raw.description.length <= 1000
  )
    return {
      kind: "capability",
      capabilityId: raw.capabilityId,
      capabilityVersion: raw.capabilityVersion,
      label: raw.label,
      description: raw.description,
    };
  if (
    raw.kind === "agent_request" &&
    hasExactKeys(raw, ["kind", "itemId", "label", "description"]) &&
    isQuestionText(raw.itemId, 200) &&
    isQuestionText(raw.label, 200) &&
    typeof raw.description === "string" &&
    raw.description.length <= 1000
  )
    return {
      kind: "agent_request",
      itemId: raw.itemId,
      label: raw.label,
      description: raw.description,
    };
  return null;
}

/** The unique key of an item within one request. */
function chatPermissionItemKey(item: ChatPermissionItem): string {
  return item.kind === "capability" ? item.capabilityId : item.itemId;
}

export function parseChatPermissionDecision(
  raw: unknown,
): ChatPermissionDecision | null {
  return raw === "resume" || raw === "deny" ? raw : null;
}

export type ChatReceiptReference = {
  readonly receiptId: string;
  readonly state:
    "pending" | "succeeded" | "failed" | "reconciliation_required";
  readonly summary: string;
};
