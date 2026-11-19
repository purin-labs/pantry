import { hasExactKeys, isNonNegativeInteger, isRecord } from "@purin-labs/std";

/**
 * The reads that a permission request can include: every record of a system
 * type, or every entry of one commerce list.
 */
export const AGENT_PERMISSION_ENTITY_TYPE_READS = [
  "product",
  "offer",
  "inventory_position",
  "production_requests",
  "replenishment_queue",
  "order",
  "payment",
  "shipment",
  "stock_policy",
  "recipe_revision",
  "supplier_directory",
] as const;

/** The commerce lists among those reads. */
export const AGENT_PERMISSION_LIST_READS = [
  "production_requests",
  "replenishment_queue",
  "supplier_directory",
] as const;
export type AgentPermissionListRead =
  (typeof AGENT_PERMISSION_LIST_READS)[number];

export type AgentPermissionEntityTypeRead =
  (typeof AGENT_PERMISSION_ENTITY_TYPE_READS)[number];

type CapabilityRef = Readonly<{
  capabilityId: string;
  capabilityVersion: number;
}>;

/**
 * The grant that gives one item to the requester's role: the capability
 * itself, the read of every record of one type, or the proposals for every
 * record of the Organisation's shop.
 */
export type AgentPermissionGrantTarget =
  | Readonly<{ kind: "platform"; capabilityRef: CapabilityRef }>
  | Readonly<{
      kind: "provider_resource";
      capabilityRef: CapabilityRef;
      /** `integration:` and the shop's integration account. */
      integrationRef: string;
      /** `provider_resource:*`: every record of the shop. */
      resourceRef: string;
    }>
  | Readonly<{
      kind: "commerce_entity_type";
      capabilityRef: CapabilityRef;
      entityTypeId: Readonly<{
        origin: "system";
        typeId: Exclude<AgentPermissionEntityTypeRead, AgentPermissionListRead>;
      }>;
    }>
  | Readonly<{
      kind: "commerce_list";
      capabilityRef: CapabilityRef;
      listId: AgentPermissionListRead;
    }>;

/**
 * A capability, or the read of one record type, that a Slack agent turn
 * asked an owner or admin to allow. The view holds catalogue labels, ids and
 * the Slack thread link; it holds no agent text.
 */
export type AgentPermissionRequestItem = Readonly<{
  /** Unique within the request. */
  itemId: string;
  capabilityId: string;
  capabilityVersion: number;
  label: string;
  description: string;
  mode: "enabled" | "approval_required" | "disabled";
  /** Whether the requester's grants and the policy give it now. */
  granted: boolean;
  /** The grant that gives it to the requester's role in a Slack thread. */
  grant: Readonly<{
    subjectRef: Readonly<{ subjectRefId: string; revision: number }>;
    subjectLabel: string;
    target: AgentPermissionGrantTarget;
  }>;
}>;

export type AgentPermissionRequestView = Readonly<{
  requestId: string;
  status: "pending" | "allowed" | "denied";
  /** A pending request older than seven days can no longer be decided. */
  expired: boolean;
  createdAt: number;
  decidedAt: number | null;
  requesterRole: "owner" | "admin" | "operator" | "viewer";
  /** Where the agent asked: a Slack thread or a Portal chat. */
  origin: "slack_thread" | "portal_chat";
  /** The Slack thread of a Slack request; null for a Portal chat. */
  threadUrl: string | null;
  /**
   * A decided Slack request that has not reached its thread, because Slack
   * was unavailable. It continues there once Slack works again.
   */
  waitingForSlack: boolean;
  /** Whether the reader may allow or deny it. */
  mayDecide: boolean;
  items: readonly AgentPermissionRequestItem[];
}>;

/**
 * One request that waits for an owner or admin, as the pending list shows it:
 * who asked, where, for what, and until when. It holds no source content and
 * no agent text.
 */
export type AgentPermissionRequestSummary = Readonly<{
  requestId: string;
  origin: "slack_thread" | "portal_chat";
  requesterName: string | null;
  requesterRole: "owner" | "admin" | "operator" | "viewer";
  /** The catalogue labels of the requested items. */
  itemLabels: readonly string[];
  createdAt: number;
  expiresAt: number;
}>;

/**
 * The requests that wait. An owner or admin reads every request of the
 * Organisation; another member reads their own.
 */
export type AgentPermissionRequestList = Readonly<{
  requests: readonly AgentPermissionRequestSummary[];
  /** Whether the reader may allow or deny them. */
  mayDecide: boolean;
  /** The held answers that this reader may decide. */
  heldOutputs: readonly HeldOutputSummary[];
}>;

/**
 * An answer that the exit check stopped, as the pending list shows it (Plan
 * 27C). It holds no agent text.
 */
export type HeldOutputSummary = Readonly<{
  requestId: string;
  /**
   * `outside_written`: the conversation read text of a person outside the
   * Organisation, so the person who asked confirms the step (Plan 89).
   */
  reason: "private_source" | "outside_organisation" | "outside_written";
  /** The channel's name, when Pantry knows it. */
  destination: string | null;
  /** What a held tool effect would do. Null for an answer. */
  effect: string | null;
  /**
   * The Portal chat whose step waits, so that the chat opens the prompt.
   * Null for a Slack answer or step.
   */
  conversationId: string | null;
  createdAt: number;
  expiresAt: number;
}>;

/**
 * The exact action of a held step, as Pantry wrote it from the tool's typed
 * arguments (Plan 89). No model text describes it.
 */
export type HeldEffectAction = Readonly<{
  operation: string;
  details: readonly Readonly<{ name: string; value: string }>[];
}>;

export function parseHeldEffectAction(raw: unknown): HeldEffectAction | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["operation", "details"]) ||
    typeof raw.operation !== "string" ||
    !Array.isArray(raw.details)
  )
    return null;
  const details: { name: string; value: string }[] = [];
  for (const detail of raw.details) {
    if (
      !isRecord(detail) ||
      !hasExactKeys(detail, ["name", "value"]) ||
      typeof detail.name !== "string" ||
      typeof detail.value !== "string"
    )
      return null;
    details.push({ name: detail.name, value: detail.value });
  }
  return { operation: raw.operation, details };
}

/** One held answer, for a person who may decide it. */
export type HeldOutputView = HeldOutputSummary &
  Readonly<{
    /**
     * The exact action that one Allow covers, for an `outside_written` step.
     * Null for an answer and for a step that waits for another reason.
     */
    action: HeldEffectAction | null;
    status: "pending" | "allowed" | "denied" | "expired";
    source: "direct_message" | "portal_chat" | "private_slack" | "internal";
    /**
     * What one Allow covers: one answer or one step, or every such step of
     * one request of the person (a menu board edit).
     */
    covers: "step" | "request";
    /** The answer's text. Null for a tool effect. */
    answer: string | null;
  }>;

function parseHeldOutputSummary(item: unknown): HeldOutputSummary | null {
  if (
    !isRecord(item) ||
    !hasExactKeys(item, [
      "requestId",
      "reason",
      "destination",
      "effect",
      "conversationId",
      "createdAt",
      "expiresAt",
    ]) ||
    typeof item.requestId !== "string" ||
    (item.reason !== "private_source" &&
      item.reason !== "outside_organisation" &&
      item.reason !== "outside_written") ||
    (item.destination !== null && typeof item.destination !== "string") ||
    (item.effect !== null && typeof item.effect !== "string") ||
    (item.conversationId !== null && typeof item.conversationId !== "string") ||
    !isNonNegativeInteger(item.createdAt) ||
    !isNonNegativeInteger(item.expiresAt)
  )
    return null;
  return {
    requestId: item.requestId,
    reason: item.reason,
    destination: item.destination,
    effect: item.effect,
    conversationId: item.conversationId,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export function parseHeldOutputView(raw: unknown): HeldOutputView | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "requestId",
      "reason",
      "destination",
      "effect",
      "conversationId",
      "createdAt",
      "expiresAt",
      "status",
      "source",
      "covers",
      "answer",
      "action",
    ]) ||
    (raw.status !== "pending" &&
      raw.status !== "allowed" &&
      raw.status !== "denied" &&
      raw.status !== "expired") ||
    (raw.source !== "direct_message" &&
      raw.source !== "portal_chat" &&
      raw.source !== "private_slack" &&
      raw.source !== "internal") ||
    (raw.covers !== "step" && raw.covers !== "request") ||
    (raw.answer !== null && typeof raw.answer !== "string")
  )
    return null;
  const { status, source, covers, answer, action: rawAction, ...rest } = raw;
  const summary = parseHeldOutputSummary(rest);
  const action = rawAction === null ? null : parseHeldEffectAction(rawAction);
  return summary === null || (rawAction !== null && action === null)
    ? null
    : {
        ...summary,
        action,
        status: raw.status,
        source: raw.source,
        covers: raw.covers,
        answer: raw.answer,
      };
}

export function parseAgentPermissionRequestList(
  raw: unknown,
): AgentPermissionRequestList | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["requests", "mayDecide", "heldOutputs"]) ||
    typeof raw.mayDecide !== "boolean" ||
    !Array.isArray(raw.requests) ||
    !Array.isArray(raw.heldOutputs)
  )
    return null;
  const heldOutputs: HeldOutputSummary[] = [];
  for (const item of raw.heldOutputs) {
    const held = parseHeldOutputSummary(item);
    if (held === null) return null;
    heldOutputs.push(held);
  }
  const requests: AgentPermissionRequestSummary[] = [];
  for (const item of raw.requests) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [
        "requestId",
        "origin",
        "requesterName",
        "requesterRole",
        "itemLabels",
        "createdAt",
        "expiresAt",
      ]) ||
      typeof item.requestId !== "string" ||
      (item.origin !== "slack_thread" && item.origin !== "portal_chat") ||
      (item.requesterName !== null && typeof item.requesterName !== "string") ||
      (item.requesterRole !== "owner" &&
        item.requesterRole !== "admin" &&
        item.requesterRole !== "operator" &&
        item.requesterRole !== "viewer") ||
      !Array.isArray(item.itemLabels) ||
      !item.itemLabels.every((label) => typeof label === "string") ||
      !isNonNegativeInteger(item.createdAt) ||
      !isNonNegativeInteger(item.expiresAt)
    )
      return null;
    requests.push({
      requestId: item.requestId,
      origin: item.origin,
      requesterName: item.requesterName,
      requesterRole: item.requesterRole,
      itemLabels: item.itemLabels,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    });
  }
  return { requests, mayDecide: raw.mayDecide, heldOutputs };
}

export type AgentPermissionDecision = "allow" | "deny";

export function parseAgentPermissionDecision(
  raw: unknown,
): AgentPermissionDecision | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["decision"]) &&
    (raw.decision === "allow" || raw.decision === "deny")
    ? raw.decision
    : null;
}

export function parseAgentPermissionRequestView(
  raw: unknown,
): AgentPermissionRequestView | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "requestId",
      "status",
      "expired",
      "createdAt",
      "decidedAt",
      "requesterRole",
      "origin",
      "threadUrl",
      "waitingForSlack",
      "mayDecide",
      "items",
    ]) ||
    typeof raw.requestId !== "string" ||
    (raw.status !== "pending" &&
      raw.status !== "allowed" &&
      raw.status !== "denied") ||
    typeof raw.expired !== "boolean" ||
    !isNonNegativeInteger(raw.createdAt) ||
    (raw.decidedAt !== null && !isNonNegativeInteger(raw.decidedAt)) ||
    (raw.requesterRole !== "owner" &&
      raw.requesterRole !== "admin" &&
      raw.requesterRole !== "operator" &&
      raw.requesterRole !== "viewer") ||
    (raw.origin !== "slack_thread" && raw.origin !== "portal_chat") ||
    (raw.origin === "slack_thread"
      ? typeof raw.threadUrl !== "string" ||
        !raw.threadUrl.startsWith("https://")
      : raw.threadUrl !== null) ||
    typeof raw.waitingForSlack !== "boolean" ||
    typeof raw.mayDecide !== "boolean" ||
    !Array.isArray(raw.items)
  )
    return null;
  const items: AgentPermissionRequestItem[] = [];
  for (const item of raw.items) {
    const parsed = parseItem(item);
    if (parsed === null) return null;
    items.push(parsed);
  }
  return {
    requestId: raw.requestId,
    status: raw.status,
    expired: raw.expired,
    createdAt: raw.createdAt,
    decidedAt: raw.decidedAt,
    requesterRole: raw.requesterRole,
    origin: raw.origin,
    threadUrl: typeof raw.threadUrl === "string" ? raw.threadUrl : null,
    waitingForSlack: raw.waitingForSlack,
    mayDecide: raw.mayDecide,
    items,
  };
}

function parseItem(raw: unknown): AgentPermissionRequestItem | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "itemId",
      "capabilityId",
      "capabilityVersion",
      "label",
      "description",
      "mode",
      "granted",
      "grant",
    ]) ||
    typeof raw.itemId !== "string" ||
    typeof raw.capabilityId !== "string" ||
    !isNonNegativeInteger(raw.capabilityVersion) ||
    typeof raw.label !== "string" ||
    typeof raw.description !== "string" ||
    (raw.mode !== "enabled" &&
      raw.mode !== "approval_required" &&
      raw.mode !== "disabled") ||
    typeof raw.granted !== "boolean" ||
    !isRecord(raw.grant) ||
    !hasExactKeys(raw.grant, ["subjectRef", "subjectLabel", "target"]) ||
    !isRecord(raw.grant.subjectRef) ||
    typeof raw.grant.subjectRef.subjectRefId !== "string" ||
    !isNonNegativeInteger(raw.grant.subjectRef.revision) ||
    typeof raw.grant.subjectLabel !== "string" ||
    !isRecord(raw.grant.target) ||
    !isRecord(raw.grant.target.capabilityRef) ||
    raw.grant.target.capabilityRef.capabilityId !== raw.capabilityId ||
    raw.grant.target.capabilityRef.capabilityVersion !== raw.capabilityVersion
  )
    return null;
  const target = parseGrantTarget(raw.grant.target, {
    capabilityId: raw.capabilityId,
    capabilityVersion: raw.capabilityVersion,
  });
  if (target === null) return null;
  return {
    itemId: raw.itemId,
    capabilityId: raw.capabilityId,
    capabilityVersion: raw.capabilityVersion,
    label: raw.label,
    description: raw.description,
    mode: raw.mode,
    granted: raw.granted,
    grant: {
      subjectRef: {
        subjectRefId: raw.grant.subjectRef.subjectRefId,
        revision: raw.grant.subjectRef.revision,
      },
      subjectLabel: raw.grant.subjectLabel,
      target,
    },
  };
}

function parseGrantTarget(
  raw: Readonly<Record<string, unknown>>,
  capabilityRef: CapabilityRef,
): AgentPermissionGrantTarget | null {
  if (raw.kind === "platform")
    return hasExactKeys(raw, ["kind", "capabilityRef"])
      ? { kind: "platform", capabilityRef }
      : null;
  if (raw.kind === "provider_resource")
    return hasExactKeys(raw, [
      "kind",
      "capabilityRef",
      "integrationRef",
      "resourceRef",
    ]) &&
      typeof raw.integrationRef === "string" &&
      raw.integrationRef.startsWith("integration:") &&
      raw.resourceRef === "provider_resource:*"
      ? {
          kind: "provider_resource",
          capabilityRef,
          integrationRef: raw.integrationRef,
          resourceRef: raw.resourceRef,
        }
      : null;
  if (raw.kind === "commerce_list")
    return hasExactKeys(raw, ["kind", "capabilityRef", "listId"]) &&
      isAgentPermissionListRead(raw.listId)
      ? { kind: "commerce_list", capabilityRef, listId: raw.listId }
      : null;
  if (
    raw.kind !== "commerce_entity_type" ||
    !hasExactKeys(raw, ["kind", "capabilityRef", "entityTypeId"]) ||
    !isRecord(raw.entityTypeId) ||
    !hasExactKeys(raw.entityTypeId, ["origin", "typeId"]) ||
    raw.entityTypeId.origin !== "system" ||
    !isAgentPermissionEntityTypeRead(raw.entityTypeId.typeId) ||
    isAgentPermissionListRead(raw.entityTypeId.typeId)
  )
    return null;
  return {
    kind: "commerce_entity_type",
    capabilityRef,
    entityTypeId: { origin: "system", typeId: raw.entityTypeId.typeId },
  };
}

const ENTITY_TYPE_READS: ReadonlySet<string> = new Set(
  AGENT_PERMISSION_ENTITY_TYPE_READS,
);

export function isAgentPermissionListRead(
  value: unknown,
): value is AgentPermissionListRead {
  return (
    value === "production_requests" ||
    value === "replenishment_queue" ||
    value === "supplier_directory"
  );
}

export function isAgentPermissionEntityTypeRead(
  value: unknown,
): value is AgentPermissionEntityTypeRead {
  return typeof value === "string" && ENTITY_TYPE_READS.has(value);
}
