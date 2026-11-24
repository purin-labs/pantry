import { isAgentRole, type AgentRole } from "@purin-labs/contracts";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

/**
 * A read-only projection of what the runtime recorded while it worked on one
 * Case. Each node stands for one recorded record. Each edge stands for one
 * recorded reference between two records, and `basis` names that reference.
 * Time gives an order only: no edge is drawn from it.
 */
export type CaseExecutionNodeKind =
  | "trigger"
  | "assignment"
  | "turn"
  | "attempt"
  | "tool_operation"
  | "proposal"
  | "approval"
  | "effect"
  | "delivery";

type NodeIdentity<Kind extends CaseExecutionNodeKind> = Readonly<{
  /** Stable for the record it stands for. It names no stored identifier. */
  nodeId: string;
  kind: Kind;
}>;

/**
 * A record this reader may not see. Its kind and its recorded edges stay, so
 * the shape of the work is honest. Nothing else of it is disclosed.
 */
export type WithheldCaseExecutionNode = NodeIdentity<CaseExecutionNodeKind> &
  Readonly<{ access: "withheld" }>;

export type CaseExecutionAssignmentState =
  | "assigned"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "budget_exhausted";

/** How a proposal stands. Mail replies keep the states of their review. */
export type CaseExecutionProposalState =
  | "accepted"
  | "rebase_required"
  | "rejected"
  | "awaiting_approval"
  | "approved"
  | "sent"
  | "closed"
  | "unresolved";

/**
 * An approval wait is not inference work. `waiting` means that a person has
 * not decided yet. `expired` means that the action expired before a person
 * decided it, and the wait ended.
 */
export type CaseExecutionApprovalState =
  "waiting" | "approved" | "rejected" | "expired";

/**
 * How a governed effect stands. `indeterminate` means that the provider's
 * answer is unknown: it stays so until reconciliation establishes the result.
 */
export type CaseExecutionEffectState =
  | "proposed"
  | "approval_requested"
  | "signed"
  | "executing"
  | "confirmed"
  | "failed"
  | "rejected"
  | "expired"
  | "indeterminate";

export type CaseExecutionToolAuthority =
  | "read"
  | "provider_effect"
  | "surface_effect"
  | "code_execution"
  | "workspace_revision";

/**
 * What became of accepted Memory for one turn, as its Session recorded it
 * before the model was asked. It holds a kind, a reason and a count. It
 * holds no Memory text and no Memory identifier.
 *
 * - `unrecorded`: the read found no Memory outcome for the turn. The turn
 *   assembled no context, or its context was accepted before Memory
 *   admission. This is not a finding that no Memory applies.
 * - `none`: the read of Memory completed. It found no Memory that applies to
 *   the turn and that the turn may be given.
 * - `admitted`: the turn was given `revisions` Memory revisions.
 * - `limited`: the turn was given `revisions` Memory revisions, and a size
 *   limit left out one or more: the item or token limit of the context, or
 *   the byte limit of the prompt.
 * - `unavailable`: the read of Memory did not complete, in time or at all.
 *   This says nothing about whether any Memory applies.
 */
export type CaseExecutionTurnMemory =
  | Readonly<{ kind: "unrecorded"; reason?: never; revisions?: never }>
  | Readonly<{ kind: "none"; reason?: never; revisions?: never }>
  | Readonly<{ kind: "admitted"; revisions: number; reason?: never }>
  | Readonly<{
      kind: "limited";
      reason: "items" | "tokens" | "prompt_bytes";
      revisions: number;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: "deadline" | "read_failed";
      revisions?: never;
    }>;

export type OpenCaseExecutionNode = Readonly<{ access: "open" }> &
  (
    | (NodeIdentity<"trigger"> &
        Readonly<{
          triggerId: string;
          source: "connector" | "cue" | "api";
          acceptedAt: number;
          /**
           * What the trigger is about, from its own source: an email's
           * subject, or the first line of a person's message. It shows only
           * where the trigger is open.
           */
          title: string | null;
        }>)
    | (NodeIdentity<"assignment"> &
        Readonly<{
          assignmentId: string;
          sessionId: string;
          role: AgentRole;
          state: CaseExecutionAssignmentState;
          /** The Case revision the assignment was built on. */
          caseRevision: number;
          startedAt: number | null;
          settledAt: number | null;
          /** A recorded failure code. Null unless the assignment failed. */
          failureCode: string | null;
        }>)
    | (NodeIdentity<"turn"> &
        Readonly<{
          sessionId: string;
          turnId: string;
          /**
           * `unrecorded` is a turn that keeps no turn record: a mail turn or
           * an Eval turn. Its Session records the context it gave the turn,
           * and no state, start, attempt or tool operation.
           */
          state: "running" | "complete" | "failed" | "unrecorded";
          /** Null when the state is `unrecorded`, and only then. */
          startedAt: number | null;
          failureCode: string | null;
          /**
           * The Memory result of this turn. A turn with no turn record can
           * run again in its Session: this is then the result of its latest
           * run.
           */
          memory: CaseExecutionTurnMemory;
        }>)
    | (NodeIdentity<"attempt"> &
        Readonly<{
          sessionId: string;
          turnId: string;
          /** The runtime generation the Session recorded for this attempt. */
          generation: number;
          state: "running" | "interrupted" | "ended";
          startedAt: number;
          /**
           * When a recovery fenced this attempt. Null unless the attempt was
           * interrupted. The Session records no time for the end of an
           * attempt that completed: the time on a completion is set when the
           * turn is accepted.
           */
          interruptedAt: number | null;
        }>)
    | (NodeIdentity<"tool_operation"> &
        Readonly<{
          sessionId: string;
          turnId: string;
          callId: string;
          tool: string;
          /** `started` means that no result is recorded for the call. */
          state: "started" | "succeeded" | "failed";
          startedAt: number;
          settledAt: number | null;
          authority: CaseExecutionToolAuthority | null;
          receiptId: string | null;
        }>)
    | (NodeIdentity<"proposal"> &
        Readonly<{
          proposalId: string;
          proposalKind: "observation" | "commerce_action" | "mail_reply";
          state: CaseExecutionProposalState;
          recordedAt: number | null;
          /** What a commerce proposal asks for. Null for other kinds. */
          title: string | null;
        }>)
    | (NodeIdentity<"approval"> &
        Readonly<{
          approvalId: string;
          state: CaseExecutionApprovalState;
          requestedAt: number;
          decidedAt: number | null;
        }>)
    | (NodeIdentity<"effect"> &
        Readonly<{
          actionId: string;
          state: CaseExecutionEffectState;
          recordedAt: number;
          updatedAt: number;
          receipt: Readonly<{
            receiptId: string;
            status: string;
            observedAt: number;
          }> | null;
        }>)
    | (NodeIdentity<"delivery"> &
        Readonly<{
          outputId: string;
          deliveryId: string;
          connectorId: string;
          state: "pending" | "delivered";
          addressedAt: number;
          receipt: Readonly<{
            nativeReceiptId: string;
            deliveredAt: number;
          }> | null;
        }>)
  );

export type CaseExecutionNode =
  WithheldCaseExecutionNode | OpenCaseExecutionNode;

/**
 * The recorded reference an edge stands for.
 *
 * - `context_entry`: the assignment's context names a Case entry that the
 *   source node produced.
 * - `assignment`: the record names the assignment it belongs to. For a turn
 *   this is the Session's accepted input, or the context record of a turn
 *   that keeps no turn record.
 * - `turn`: the record names the turn it belongs to.
 * - `tool_call`: the proposal's acceptance names the tool call that made it.
 * - `proposal`: the record names the proposal it decides or delivers.
 * - `action`: the record names the governed action by its nonce.
 */
export type CaseExecutionEdgeBasis =
  "context_entry" | "assignment" | "turn" | "tool_call" | "proposal" | "action";

export type CaseExecutionEdge = Readonly<{
  from: string;
  to: string;
  basis: CaseExecutionEdgeBasis;
}>;

/**
 * A causal link that the records do not hold, or a part of the Case that
 * could not be read. The reader must not assume the missing link.
 */
export type CaseExecutionLimitation =
  /** No record says which attempt of a turn ran a tool operation. */
  | "tool_attempt_unrecorded"
  /** A governed effect keeps its latest state only, not each execution try. */
  | "effect_attempts_unrecorded"
  /** A delivery keeps its latest state only, not each send try. */
  | "delivery_attempts_unrecorded"
  /** A mail reply proposal does not name the turn or tool call that made it. */
  | "mail_proposal_origin_unrecorded"
  /** A proposal accepted before this field existed names no tool call. */
  | "proposal_tool_call_unrecorded"
  /** A Session's records could not be read, so its turns are absent. */
  | "session_unavailable"
  /** A governed action's record could not be read, so its effect is absent. */
  | "effect_unavailable"
  /** The Case holds more records than one projection carries. */
  | "truncated"
  /** A stored record does not fit this contract. Its node shows its kind only. */
  | "record_invalid";

export type CaseExecutionPage = Readonly<{
  caseId: string;
  /**
   * Identifies the records this page was projected from. A later page with
   * another value belongs to another projection: read again from the start.
   */
  basis: string;
  nodes: readonly CaseExecutionNode[];
  /**
   * Each edge is returned once, on the page that carries the later of its
   * two nodes. Its other node is on this page or on an earlier one.
   */
  edges: readonly CaseExecutionEdge[];
  limitations: readonly CaseExecutionLimitation[];
  /** Null on the last page. */
  nextCursor: string | null;
}>;

/** One bounded piece of content behind a node, for a reader who may see it. */
export type CaseExecutionContent = Readonly<{
  role: "input" | "arguments" | "result" | "entry" | "message" | "action";
  text: string;
  /** True when the stored text was longer than this read returns. */
  truncated: boolean;
}>;

export type CaseExecutionNodeDetail = Readonly<{
  caseId: string;
  node: OpenCaseExecutionNode;
  content: readonly CaseExecutionContent[];
  /** The Case entries an assignment was given, by the node that made each. */
  context: readonly Readonly<{ entryId: string; producer: string | null }>[];
}>;

/** A Case this reader may know of, for the list that links to its execution. */
export type CaseExecutionCaseRef = Readonly<{
  caseId: string;
  origin: string;
  filedAt: number;
}>;

export const MAX_CASE_EXECUTION_PAGE = 100;
export const MAX_CASE_EXECUTION_CONTENT_LENGTH = 4_000;
export const MAX_CASE_EXECUTION_CASES = 50;

const NODE_KINDS: readonly CaseExecutionNodeKind[] = [
  "trigger",
  "assignment",
  "turn",
  "attempt",
  "tool_operation",
  "proposal",
  "approval",
  "effect",
  "delivery",
];
const EDGE_BASES: readonly CaseExecutionEdgeBasis[] = [
  "context_entry",
  "assignment",
  "turn",
  "tool_call",
  "proposal",
  "action",
];
const LIMITATIONS: readonly CaseExecutionLimitation[] = [
  "tool_attempt_unrecorded",
  "effect_attempts_unrecorded",
  "delivery_attempts_unrecorded",
  "mail_proposal_origin_unrecorded",
  "proposal_tool_call_unrecorded",
  "session_unavailable",
  "effect_unavailable",
  "truncated",
  "record_invalid",
];
const ASSIGNMENT_STATES: readonly CaseExecutionAssignmentState[] = [
  "assigned",
  "running",
  "completed",
  "cancelled",
  "failed",
  "budget_exhausted",
];
const PROPOSAL_STATES: readonly CaseExecutionProposalState[] = [
  "accepted",
  "rebase_required",
  "rejected",
  "awaiting_approval",
  "approved",
  "sent",
  "closed",
  "unresolved",
];
const EFFECT_STATES: readonly CaseExecutionEffectState[] = [
  "proposed",
  "approval_requested",
  "signed",
  "executing",
  "confirmed",
  "failed",
  "rejected",
  "expired",
  "indeterminate",
];
const TOOL_AUTHORITIES: readonly CaseExecutionToolAuthority[] = [
  "read",
  "provider_effect",
  "surface_effect",
  "code_execution",
  "workspace_revision",
];
const CONTENT_ROLES: readonly CaseExecutionContent["role"][] = [
  "input",
  "arguments",
  "result",
  "entry",
  "message",
  "action",
];
const MAX_ID_LENGTH = 512;

export function isCaseExecutionNodeKind(
  value: unknown,
): value is CaseExecutionNodeKind {
  return oneOf(NODE_KINDS, value);
}

export function isCaseExecutionAssignmentState(
  value: unknown,
): value is CaseExecutionAssignmentState {
  return oneOf(ASSIGNMENT_STATES, value);
}

export function parseCaseExecutionPage(raw: unknown): CaseExecutionPage | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "caseId",
      "basis",
      "nodes",
      "edges",
      "limitations",
      "nextCursor",
    ]) ||
    !identifier(raw.caseId) ||
    !identifier(raw.basis) ||
    !Array.isArray(raw.nodes) ||
    raw.nodes.length > MAX_CASE_EXECUTION_PAGE ||
    !Array.isArray(raw.edges) ||
    !Array.isArray(raw.limitations) ||
    (raw.nextCursor !== null && !identifier(raw.nextCursor))
  )
    return null;
  const nodes: CaseExecutionNode[] = [];
  for (const entry of raw.nodes) {
    const node = parseCaseExecutionNode(entry);
    if (node === null) return null;
    nodes.push(node);
  }
  const edges: CaseExecutionEdge[] = [];
  for (const entry of raw.edges) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["from", "to", "basis"]) ||
      !identifier(entry.from) ||
      !identifier(entry.to) ||
      !oneOf(EDGE_BASES, entry.basis)
    )
      return null;
    edges.push({ from: entry.from, to: entry.to, basis: entry.basis });
  }
  const limitations: CaseExecutionLimitation[] = [];
  for (const entry of raw.limitations) {
    if (!oneOf(LIMITATIONS, entry) || limitations.includes(entry)) return null;
    limitations.push(entry);
  }
  return {
    caseId: raw.caseId,
    basis: raw.basis,
    nodes,
    edges,
    limitations,
    nextCursor: raw.nextCursor,
  };
}

export function parseCaseExecutionNode(raw: unknown): CaseExecutionNode | null {
  if (
    !isRecord(raw) ||
    !identifier(raw.nodeId) ||
    !isCaseExecutionNodeKind(raw.kind)
  )
    return null;
  if (raw.access === "withheld")
    return hasExactKeys(raw, ["nodeId", "kind", "access"])
      ? { nodeId: raw.nodeId, kind: raw.kind, access: "withheld" }
      : null;
  return raw.access === "open" ? parseOpenNode(raw, raw.nodeId) : null;
}

export function parseCaseExecutionNodeDetail(
  raw: unknown,
): CaseExecutionNodeDetail | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["caseId", "node", "content", "context"]) ||
    !identifier(raw.caseId) ||
    !Array.isArray(raw.content) ||
    !Array.isArray(raw.context)
  )
    return null;
  const node = parseCaseExecutionNode(raw.node);
  if (node === null || node.access !== "open") return null;
  const content: CaseExecutionContent[] = [];
  for (const entry of raw.content) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["role", "text", "truncated"]) ||
      !oneOf(CONTENT_ROLES, entry.role) ||
      typeof entry.text !== "string" ||
      entry.text.length > MAX_CASE_EXECUTION_CONTENT_LENGTH ||
      typeof entry.truncated !== "boolean"
    )
      return null;
    content.push({
      role: entry.role,
      text: entry.text,
      truncated: entry.truncated,
    });
  }
  const context: { entryId: string; producer: string | null }[] = [];
  for (const entry of raw.context) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["entryId", "producer"]) ||
      !identifier(entry.entryId) ||
      (entry.producer !== null && !identifier(entry.producer))
    )
      return null;
    context.push({ entryId: entry.entryId, producer: entry.producer });
  }
  return { caseId: raw.caseId, node, content, context };
}

export function parseCaseExecutionCaseList(
  raw: unknown,
): readonly CaseExecutionCaseRef[] | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["cases"]) ||
    !Array.isArray(raw.cases) ||
    raw.cases.length > MAX_CASE_EXECUTION_CASES
  )
    return null;
  const cases: CaseExecutionCaseRef[] = [];
  for (const entry of raw.cases) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["caseId", "origin", "filedAt"]) ||
      !identifier(entry.caseId) ||
      !identifier(entry.origin) ||
      !isNonNegativeInteger(entry.filedAt)
    )
      return null;
    cases.push({
      caseId: entry.caseId,
      origin: entry.origin,
      filedAt: entry.filedAt,
    });
  }
  return cases;
}

function parseOpenNode(
  raw: Record<string, unknown>,
  nodeId: string,
): OpenCaseExecutionNode | null {
  const base = { nodeId, access: "open" } as const;
  switch (raw.kind) {
    case "trigger":
      return hasNodeKeys(raw, ["triggerId", "source", "acceptedAt", "title"]) &&
        identifier(raw.triggerId) &&
        (raw.source === "connector" ||
          raw.source === "cue" ||
          raw.source === "api") &&
        isNonNegativeInteger(raw.acceptedAt) &&
        titleOrNull(raw.title)
        ? {
            ...base,
            kind: "trigger",
            triggerId: raw.triggerId,
            source: raw.source,
            acceptedAt: raw.acceptedAt,
            title: raw.title,
          }
        : null;
    case "assignment":
      return hasNodeKeys(raw, [
        "assignmentId",
        "sessionId",
        "role",
        "state",
        "caseRevision",
        "startedAt",
        "settledAt",
        "failureCode",
      ]) &&
        identifier(raw.assignmentId) &&
        identifier(raw.sessionId) &&
        isAgentRole(raw.role) &&
        oneOf(ASSIGNMENT_STATES, raw.state) &&
        isNonNegativeInteger(raw.caseRevision) &&
        timeOrNull(raw.startedAt) &&
        timeOrNull(raw.settledAt) &&
        identifierOrNull(raw.failureCode)
        ? {
            ...base,
            kind: "assignment",
            assignmentId: raw.assignmentId,
            sessionId: raw.sessionId,
            role: raw.role,
            state: raw.state,
            caseRevision: raw.caseRevision,
            startedAt: raw.startedAt,
            settledAt: raw.settledAt,
            failureCode: raw.failureCode,
          }
        : null;
    case "turn": {
      if (
        !hasNodeKeys(raw, [
          "sessionId",
          "turnId",
          "state",
          "startedAt",
          "failureCode",
          "memory",
        ]) ||
        !identifier(raw.sessionId) ||
        !identifier(raw.turnId) ||
        (raw.state !== "running" &&
          raw.state !== "complete" &&
          raw.state !== "failed" &&
          raw.state !== "unrecorded") ||
        !timeOrNull(raw.startedAt) ||
        // A turn with no turn record has no start and no failure.
        (raw.startedAt === null) !== (raw.state === "unrecorded") ||
        !identifierOrNull(raw.failureCode) ||
        (raw.state === "unrecorded" && raw.failureCode !== null)
      )
        return null;
      const memory = parseTurnMemory(raw.memory);
      return memory === null
        ? null
        : {
            ...base,
            kind: "turn",
            sessionId: raw.sessionId,
            turnId: raw.turnId,
            state: raw.state,
            startedAt: raw.startedAt,
            failureCode: raw.failureCode,
            memory,
          };
    }
    case "attempt":
      return hasNodeKeys(raw, [
        "sessionId",
        "turnId",
        "generation",
        "state",
        "startedAt",
        "interruptedAt",
      ]) &&
        identifier(raw.sessionId) &&
        identifier(raw.turnId) &&
        isNonNegativeInteger(raw.generation) &&
        (raw.state === "running" ||
          raw.state === "interrupted" ||
          raw.state === "ended") &&
        isNonNegativeInteger(raw.startedAt) &&
        timeOrNull(raw.interruptedAt) &&
        (raw.interruptedAt === null) === (raw.state !== "interrupted")
        ? {
            ...base,
            kind: "attempt",
            sessionId: raw.sessionId,
            turnId: raw.turnId,
            generation: raw.generation,
            state: raw.state,
            startedAt: raw.startedAt,
            interruptedAt: raw.interruptedAt,
          }
        : null;
    case "tool_operation":
      return hasNodeKeys(raw, [
        "sessionId",
        "turnId",
        "callId",
        "tool",
        "state",
        "startedAt",
        "settledAt",
        "authority",
        "receiptId",
      ]) &&
        identifier(raw.sessionId) &&
        identifier(raw.turnId) &&
        identifier(raw.callId) &&
        identifier(raw.tool) &&
        (raw.state === "started" ||
          raw.state === "succeeded" ||
          raw.state === "failed") &&
        isNonNegativeInteger(raw.startedAt) &&
        timeOrNull(raw.settledAt) &&
        (raw.authority === null || oneOf(TOOL_AUTHORITIES, raw.authority)) &&
        identifierOrNull(raw.receiptId)
        ? {
            ...base,
            kind: "tool_operation",
            sessionId: raw.sessionId,
            turnId: raw.turnId,
            callId: raw.callId,
            tool: raw.tool,
            state: raw.state,
            startedAt: raw.startedAt,
            settledAt: raw.settledAt,
            authority: raw.authority,
            receiptId: raw.receiptId,
          }
        : null;
    case "proposal":
      return hasNodeKeys(raw, [
        "proposalId",
        "proposalKind",
        "state",
        "recordedAt",
        "title",
      ]) &&
        identifier(raw.proposalId) &&
        (raw.proposalKind === "observation" ||
          raw.proposalKind === "commerce_action" ||
          raw.proposalKind === "mail_reply") &&
        oneOf(PROPOSAL_STATES, raw.state) &&
        timeOrNull(raw.recordedAt) &&
        titleOrNull(raw.title)
        ? {
            ...base,
            kind: "proposal",
            proposalId: raw.proposalId,
            proposalKind: raw.proposalKind,
            state: raw.state,
            recordedAt: raw.recordedAt,
            title: raw.title,
          }
        : null;
    case "approval":
      return hasNodeKeys(raw, [
        "approvalId",
        "state",
        "requestedAt",
        "decidedAt",
      ]) &&
        identifier(raw.approvalId) &&
        (raw.state === "waiting" ||
          raw.state === "approved" ||
          raw.state === "rejected" ||
          raw.state === "expired") &&
        isNonNegativeInteger(raw.requestedAt) &&
        timeOrNull(raw.decidedAt)
        ? {
            ...base,
            kind: "approval",
            approvalId: raw.approvalId,
            state: raw.state,
            requestedAt: raw.requestedAt,
            decidedAt: raw.decidedAt,
          }
        : null;
    case "effect": {
      if (
        !hasNodeKeys(raw, [
          "actionId",
          "state",
          "recordedAt",
          "updatedAt",
          "receipt",
        ]) ||
        !identifier(raw.actionId) ||
        !oneOf(EFFECT_STATES, raw.state) ||
        !isNonNegativeInteger(raw.recordedAt) ||
        !isNonNegativeInteger(raw.updatedAt)
      )
        return null;
      const receipt = parseEffectReceipt(raw.receipt);
      return receipt === undefined
        ? null
        : {
            ...base,
            kind: "effect",
            actionId: raw.actionId,
            state: raw.state,
            recordedAt: raw.recordedAt,
            updatedAt: raw.updatedAt,
            receipt,
          };
    }
    case "delivery": {
      if (
        !hasNodeKeys(raw, [
          "outputId",
          "deliveryId",
          "connectorId",
          "state",
          "addressedAt",
          "receipt",
        ]) ||
        !identifier(raw.outputId) ||
        !identifier(raw.deliveryId) ||
        !identifier(raw.connectorId) ||
        (raw.state !== "pending" && raw.state !== "delivered") ||
        !isNonNegativeInteger(raw.addressedAt)
      )
        return null;
      const receipt = parseDeliveryReceipt(raw.receipt);
      // A delivered output has its receipt, and a pending one has none.
      return receipt === undefined ||
        (raw.state === "delivered") !== (receipt !== null)
        ? null
        : {
            ...base,
            kind: "delivery",
            outputId: raw.outputId,
            deliveryId: raw.deliveryId,
            connectorId: raw.connectorId,
            state: raw.state,
            addressedAt: raw.addressedAt,
            receipt,
          };
    }
    default:
      return null;
  }
}

/**
 * The Memory result of one turn. Null means that the value is not one: a
 * kind with a key of another kind, a reason of another kind, or a count that
 * its kind cannot have.
 */
function parseTurnMemory(raw: unknown): CaseExecutionTurnMemory | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "unrecorded":
    case "none":
      return hasExactKeys(raw, ["kind"]) ? { kind: raw.kind } : null;
    case "admitted":
      // An admitted outcome holds one revision or more.
      return hasExactKeys(raw, ["kind", "revisions"]) &&
        isPositiveInteger(raw.revisions)
        ? { kind: "admitted", revisions: raw.revisions }
        : null;
    case "limited":
      // The prompt's byte limit can leave out every revision.
      return hasExactKeys(raw, ["kind", "reason", "revisions"]) &&
        (raw.reason === "items" ||
          raw.reason === "tokens" ||
          raw.reason === "prompt_bytes") &&
        isNonNegativeInteger(raw.revisions)
        ? { kind: "limited", reason: raw.reason, revisions: raw.revisions }
        : null;
    case "unavailable":
      return hasExactKeys(raw, ["kind", "reason"]) &&
        (raw.reason === "deadline" || raw.reason === "read_failed")
        ? { kind: "unavailable", reason: raw.reason }
        : null;
    default:
      return null;
  }
}

type EffectNode = Variant<OpenCaseExecutionNode, "effect">;
type DeliveryNode = Variant<OpenCaseExecutionNode, "delivery">;

/** Undefined means that the stored value is not a receipt and not null. */
function parseEffectReceipt(raw: unknown): EffectNode["receipt"] | undefined {
  if (raw === null) return null;
  return isRecord(raw) &&
    hasExactKeys(raw, ["receiptId", "status", "observedAt"]) &&
    identifier(raw.receiptId) &&
    identifier(raw.status) &&
    isNonNegativeInteger(raw.observedAt)
    ? {
        receiptId: raw.receiptId,
        status: raw.status,
        observedAt: raw.observedAt,
      }
    : undefined;
}

function parseDeliveryReceipt(
  raw: unknown,
): DeliveryNode["receipt"] | undefined {
  if (raw === null) return null;
  return isRecord(raw) &&
    hasExactKeys(raw, ["nativeReceiptId", "deliveredAt"]) &&
    identifier(raw.nativeReceiptId) &&
    isNonNegativeInteger(raw.deliveredAt)
    ? { nativeReceiptId: raw.nativeReceiptId, deliveredAt: raw.deliveredAt }
    : undefined;
}

function hasNodeKeys(
  raw: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return hasExactKeys(raw, ["nodeId", "kind", "access", ...keys]);
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function identifierOrNull(value: unknown): value is string | null {
  return value === null || identifier(value);
}

function timeOrNull(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

/** The longest title a record shows. */
const MAX_NODE_TITLE = 200;

function titleOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= MAX_NODE_TITLE)
  );
}

function oneOf<Value extends string>(
  values: readonly Value[],
  value: unknown,
): value is Value {
  return typeof value === "string" && values.some((entry) => entry === value);
}
