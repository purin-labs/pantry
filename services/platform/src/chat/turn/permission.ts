import type { OrganisationDatabase } from "../../database-handles";
import { missingChatPermissionItems } from "../permission-items";
import type { AgentPermissionRequest } from "../../data/agent-permission-request";
import {
  ENTITY_TYPE_READ_CAPABILITY,
  entityTypeReadDescription,
  entityTypeReadLabel,
  permissionLabels,
} from "../../authorization/requestable-capabilities";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type {
  ChatPermissionDecision,
  ChatPermissionItem,
  ChatPermissionRequest,
  ConversationId,
} from "@seams/control-api";
import type { FlowDecision, FlowSink } from "../../policy/information-flow";
import { capabilityDefinitionById } from "../../authorization/capability-catalogue";
import {
  parseActiveCapabilityId,
  readOrganisationCapabilityPolicies,
} from "../../data/capability-policy";
import {
  parseChatModelAction,
  conversationTimeline,
  normalizeConversationTimeline,
  type ChatModelAction,
  type Conversation,
} from "../conversation";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
  type StoredConversation,
} from "../store";
import { conversationStreamIdentity } from "./run";
import { nextTimelineSequence } from "./timeline";

type ConversationPermissionOutcome =
  | {
      readonly kind: "decided";
      readonly decision: ChatPermissionDecision;
      readonly stored: StoredConversation;
    }
  | { readonly kind: "not_found" | "conflict" }
  | {
      readonly kind: "permission_missing";
      readonly items: readonly ChatPermissionItem[];
    };

/**
 * Settles a paused run. A resume first checks that every requested
 * capability is now enabled, so a premature resume costs no model step. It
 * then runs the paused step again under a new lease: the replay of the old
 * lease would finalize a completion accepted under the old authority. A
 * denial stops the run. Repeating the same decision returns the saved result.
 */
export async function decideConversationPermission(input: {
  readonly placement: OrganisationExecutionScope;
  readonly scope: ConversationScope;
  readonly conversationId: ConversationId;
  readonly permissionRequestId: string;
  readonly decision: ChatPermissionDecision;
}): Promise<ConversationPermissionOutcome> {
  const decisionEventId = `${input.permissionRequestId}_${input.decision}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await readConversation(
      input.placement.database,
      input.scope,
      input.conversationId,
    );
    if (latest === null) return { kind: "not_found" };
    const work = latest.conversation.work;
    const timeline = conversationTimeline(latest.conversation);
    if (
      work.kind !== "awaiting_permission" ||
      work.permission.permissionRequestId !== input.permissionRequestId
    )
      return timeline.some((event) => event.eventId === decisionEventId)
        ? { kind: "decided", decision: input.decision, stored: latest }
        : { kind: "conflict" };
    let next: Conversation;
    if (input.decision === "resume") {
      const missing = await missingChatPermissionItems(
        input.placement.database,
        input.scope,
        work.permission,
      );
      if (missing === null) return { kind: "conflict" };
      if (missing.length > 0)
        return { kind: "permission_missing", items: missing };
      const lease = crypto.randomUUID();
      const stream = await conversationStreamIdentity(
        latest.actorIdentity,
        lease,
        work.step,
      );
      if (!stream.ok) throw new Error(stream.error);
      next = normalizeConversationTimeline({
        ...latest.conversation,
        work: {
          kind: "running",
          requestId: work.requestId,
          lease,
          expiresAt: Date.now() + 15 * 60_000,
          stream: stream.value,
        },
        timeline: [
          ...timeline,
          {
            kind: "activity",
            eventId: decisionEventId,
            sequence: nextTimelineSequence(timeline),
            requestId: work.requestId,
            createdAt: Date.now(),
            text: "Permission allowed. Continuing.",
          },
        ],
      });
    } else {
      next = normalizeConversationTimeline({
        ...latest.conversation,
        work: { kind: "ready" },
        timeline: [
          ...timeline,
          {
            kind: "run_cancelled",
            eventId: decisionEventId,
            sequence: nextTimelineSequence(timeline),
            requestId: work.requestId,
            createdAt: Date.now(),
            text: "Permission denied. The response stopped.",
          },
        ],
      });
    }
    const saved = await saveConversation(
      input.placement,
      input.scope.userId,
      next,
      latest.revision,
    );
    if (saved.kind === "saved")
      return {
        kind: "decided",
        decision: input.decision,
        stored: {
          ...latest,
          conversation: next,
          revision: latest.revision + 1,
        },
      };
    if (saved.kind === "capacity") return { kind: "conflict" };
  }
  return { kind: "conflict" };
}

/** The pause of a step whose agent asked a person for permission. */
export function agentChatPermission(
  request: AgentPermissionRequest,
): ChatPermissionRequest {
  const read = capabilityDefinitionById(ENTITY_TYPE_READ_CAPABILITY);
  const items: ChatPermissionItem[] = [];
  for (const entityType of request.entityTypeReads)
    items.push({
      kind: "agent_request",
      itemId: `${read.capabilityId}:${entityType}:requester`,
      label: entityTypeReadLabel(entityType),
      description: entityTypeReadDescription(entityType, "requester"),
    });
  for (const capabilityId of request.capabilityIds) {
    const definition = capabilityDefinitionById(capabilityId);
    items.push({
      kind: "agent_request",
      itemId: capabilityId,
      label: definition.label,
      description: definition.description,
    });
  }
  const labels = permissionLabels(
    request.capabilityIds,
    request.entityTypeReads,
  );
  return {
    permissionRequestId: request.requestId,
    action:
      labels.length <= 200
        ? labels.charAt(0).toUpperCase() + labels.slice(1)
        : "Use what this request needs",
    object: null,
    items,
    requestedAt: request.createdAt,
  };
}

export async function settleConversationPermission(input: {
  readonly placement: OrganisationExecutionScope;
  readonly scope: ConversationScope;
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly lease: string;
  readonly step: number;
  readonly permission: ChatPermissionRequest;
}): Promise<Conversation | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await readConversation(
      input.placement.database,
      input.scope,
      input.conversationId,
    );
    if (latest === null) return null;
    const active = latest.conversation.work;
    if (
      active.kind === "awaiting_permission" &&
      active.permission.permissionRequestId ===
        input.permission.permissionRequestId
    )
      return latest.conversation;
    if (
      active.kind !== "running" ||
      active.requestId !== input.requestId ||
      active.lease !== input.lease
    )
      return null;
    const timeline = conversationTimeline(latest.conversation);
    const paused = normalizeConversationTimeline({
      ...latest.conversation,
      work: {
        kind: "awaiting_permission",
        requestId: input.requestId,
        step: input.step,
        permission: input.permission,
        stream: active.stream,
      },
      timeline: [
        ...timeline,
        {
          kind: "activity",
          eventId: input.permission.permissionRequestId,
          sequence: nextTimelineSequence(timeline),
          requestId: input.requestId,
          createdAt: Date.now(),
          text: `Paused: the agent needs permission to ${lowerFirst(input.permission.action)}.`,
        },
      ],
    });
    if (
      (
        await saveConversation(
          input.placement,
          input.scope.userId,
          paused,
          latest.revision,
        )
      ).kind === "saved"
    )
      return paused;
  }
  return null;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Returns the request that would let this step through, or null when the
 * denial has another cause. Only a capability that is not enabled is
 * something a person can allow here; source and audience restrictions stay
 * failures.
 */
export async function chatPermissionRequest(
  db: OrganisationDatabase,
  scope: ConversationScope,
  action: ReturnType<typeof parseChatModelAction>,
  sink: FlowSink,
  requestId: string,
  step: number,
): Promise<ChatPermissionRequest | null> {
  if (!action.ok || sink.kind !== "tool_effect") return null;
  const capabilityId = parseActiveCapabilityId(sink.capabilityId);
  if (capabilityId === null) return null;
  const policies = await readOrganisationCapabilityPolicies({
    db,
    organisationId: scope.organisationId,
  });
  if (!policies.ok) return null;
  const definition = capabilityDefinitionById(capabilityId);
  const policy = policies.value.find(
    (candidate) =>
      candidate.capabilityId === capabilityId &&
      candidate.capabilityVersion === definition.capabilityVersion,
  );
  if (policy === undefined || policy.mode === "enabled") return null;
  const attempt = chatPermissionAttempt(action.value);
  if (attempt === null) return null;
  return {
    permissionRequestId: `permission_${requestId}_${step}`,
    action: attempt.action,
    object: attempt.object,
    items: [
      {
        kind: "capability",
        capabilityId,
        capabilityVersion: definition.capabilityVersion,
        label: definition.label,
        description: definition.description,
      },
    ],
    requestedAt: Date.now(),
  };
}

function chatPermissionAttempt(
  action: ChatModelAction,
): { readonly action: string; readonly object: string | null } | null {
  switch (action.kind) {
    case "read_documentation":
      return { action: "Read a public link", object: action.url };
    case "definition":
      return { action: "Draft a custom connector", object: null };
    case "revise":
      return {
        action: "Revise a custom connector",
        object: action.connectorId,
      };
    case "question":
    case "reply":
      return null;
  }
}

export function chatFlowDenialMessage(
  action: ReturnType<typeof parseChatModelAction>,
  decision: Exclude<FlowDecision, { readonly kind: "allow" }>,
): string {
  if (decision.reason.code === "audience_not_permitted")
    return "This response includes data that cannot be shown in this portal conversation.";
  if (!action.ok)
    return "The workspace's data-flow policy does not allow this response.";
  switch (action.value.kind) {
    case "read_documentation":
      return "Reading API documentation is disabled for this workspace. Enable Read message links in Access, then retry.";
    case "definition":
    case "revise":
      return "AI connector drafting is disabled for this workspace. Enable Draft custom connectors in Access, then retry.";
    case "question":
    case "reply":
      return "The workspace's data-flow policy does not allow this response.";
  }
}
