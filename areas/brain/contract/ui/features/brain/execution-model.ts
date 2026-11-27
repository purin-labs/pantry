import type { AgentRole } from "@purin-labs/contracts";
import type {
  CaseExecutionCaseRef,
  CaseExecutionContent,
  CaseExecutionEdge,
  CaseExecutionEdgeBasis,
  CaseExecutionLimitation,
  CaseExecutionNode,
  CaseExecutionNodeKind,
  CaseExecutionTurnMemory,
  OpenCaseExecutionNode,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type { StatusChipStatus } from "@purin-labs/ui/status-chip";

/** A whole projection, as the page holds it after it read every page. */
export type CaseExecution = Readonly<{
  caseId: string;
  nodes: readonly CaseExecutionNode[];
  edges: readonly CaseExecutionEdge[];
  limitations: readonly CaseExecutionLimitation[];
}>;

export function kindLabel(kind: CaseExecutionNodeKind): string {
  switch (kind) {
    case "trigger":
      return "Request";
    case "assignment":
      return "Assignment";
    case "turn":
      return "Turn";
    case "attempt":
      return "Attempt";
    case "tool_operation":
      return "Tool operation";
    case "proposal":
      return "Proposal";
    case "approval":
      return "Approval wait";
    case "effect":
      return "Effect";
    case "delivery":
      return "Delivery";
    default:
      return assertNever(kind);
  }
}

/**
 * Whether the name of a node already says its kind ("Turn", "Attempt 2",
 * "Research assignment", "Tool operation (withheld)"), so that the kind is not
 * written again beside it. Only an open tool operation is named by its tool.
 */
export function titleNamesKind(node: CaseExecutionNode): boolean {
  return node.access === "withheld" || node.kind !== "tool_operation";
}

/** The short name of one node. A withheld node has no name of its own. */
export function nodeTitle(node: CaseExecutionNode): string {
  if (node.access === "withheld") return `${kindLabel(node.kind)} (withheld)`;
  switch (node.kind) {
    case "trigger":
      return `Request from ${sourceLabel(node.source)}`;
    case "assignment":
      return roleLabel(node.role);
    case "turn":
      return "Turn";
    case "attempt":
      return `Attempt ${String(node.generation)}`;
    case "tool_operation":
      return node.tool;
    case "proposal":
      return proposalLabel(node.proposalKind);
    case "approval":
      return "Approval wait";
    case "effect":
      return "Governed effect";
    case "delivery":
      return "Delivery";
    default:
      return assertNever(node);
  }
}

function roleLabel(role: AgentRole): string {
  switch (role) {
    case "coordinator":
      return "Coordinator assignment";
    case "specialist":
      return "Specialist assignment";
    default:
      return assertNever(role);
  }
}

function sourceLabel(source: "connector" | "cue" | "api"): string {
  switch (source) {
    case "connector":
      return "a connected channel";
    case "cue":
      return "an automation";
    case "api":
      return "the Portal";
    default:
      return assertNever(source);
  }
}

function proposalLabel(
  kind: "observation" | "commerce_action" | "mail_reply",
): string {
  switch (kind) {
    case "observation":
      return "Proposed reply or note";
    case "commerce_action":
      return "Proposed commerce action";
    case "mail_reply":
      return "Proposed email reply";
    default:
      return assertNever(kind);
  }
}

/**
 * How one node stands, in the page's status vocabulary. An approval wait is
 * shown as waiting for a person, never as work in progress. An unknown
 * provider result is shown as unknown, never as a failure.
 */
export function nodeStatus(node: CaseExecutionNode): StatusChipStatus {
  if (node.access === "withheld") return { kind: "neutral", label: "Withheld" };
  switch (node.kind) {
    case "trigger":
      return { kind: "neutral", label: "Accepted" };
    case "assignment":
      switch (node.state) {
        case "assigned":
          return { kind: "neutral", label: "Not started" };
        case "running":
          return { kind: "info", label: "Running" };
        case "completed":
          return { kind: "success", label: "Completed" };
        case "cancelled":
          return { kind: "neutral", label: "Cancelled" };
        case "failed":
          return { kind: "danger", label: "Failed" };
        case "budget_exhausted":
          return { kind: "warning", label: "Budget used up" };
        default:
          return assertNever(node);
      }
    case "turn":
      switch (node.state) {
        case "running":
          return { kind: "info", label: "Running" };
        case "complete":
          return { kind: "success", label: "Completed" };
        case "failed":
          return { kind: "danger", label: "Failed" };
        case "unrecorded":
          return { kind: "neutral", label: "State not recorded" };
        default:
          return assertNever(node);
      }
    case "attempt":
      switch (node.state) {
        case "running":
          return { kind: "info", label: "Running" };
        case "interrupted":
          return { kind: "warning", label: "Interrupted" };
        case "ended":
          return { kind: "neutral", label: "Ended" };
        default:
          return assertNever(node);
      }
    case "tool_operation":
      switch (node.state) {
        case "started":
          return { kind: "warning", label: "No result recorded" };
        case "succeeded":
          return { kind: "success", label: "Succeeded" };
        case "failed":
          return { kind: "danger", label: "Failed" };
        default:
          return assertNever(node);
      }
    case "proposal":
      switch (node.state) {
        case "accepted":
          return { kind: "success", label: "Accepted" };
        case "rebase_required":
          return { kind: "warning", label: "Out of date" };
        case "rejected":
          return { kind: "danger", label: "Rejected" };
        case "awaiting_approval":
          return { kind: "warning", label: "Waiting for approval" };
        case "approved":
          return { kind: "info", label: "Approved" };
        case "sent":
          return { kind: "success", label: "Sent" };
        case "closed":
          return { kind: "neutral", label: "Closed" };
        case "unresolved":
          return { kind: "warning", label: "Result unknown" };
        default:
          return assertNever(node);
      }
    case "approval":
      switch (node.state) {
        case "waiting":
          return { kind: "warning", label: "Waiting for a person" };
        case "approved":
          return { kind: "success", label: "Approved" };
        case "rejected":
          return { kind: "neutral", label: "Declined" };
        case "expired":
          return { kind: "neutral", label: "Expired" };
        default:
          return assertNever(node);
      }
    case "effect":
      switch (node.state) {
        case "proposed":
        case "approval_requested":
          return { kind: "neutral", label: "Not approved yet" };
        case "signed":
          return { kind: "info", label: "Approved, not run" };
        case "executing":
          return { kind: "info", label: "Running" };
        case "confirmed":
          return { kind: "success", label: "Confirmed" };
        case "failed":
          return { kind: "danger", label: "Failed" };
        case "rejected":
          return { kind: "neutral", label: "Declined" };
        case "expired":
          return { kind: "neutral", label: "Expired" };
        case "indeterminate":
          return { kind: "warning", label: "Result unknown" };
        default:
          return assertNever(node);
      }
    case "delivery":
      return node.state === "delivered"
        ? { kind: "success", label: "Delivered" }
        : { kind: "info", label: "Not delivered yet" };
    default:
      return assertNever(node);
  }
}

/** The recorded reference an edge stands for, as a sentence part. */
export function basisLabel(basis: CaseExecutionEdgeBasis): string {
  switch (basis) {
    case "context_entry":
      return "was given what this produced";
    case "assignment":
      return "names this assignment";
    case "turn":
      return "names this turn";
    case "tool_call":
      return "names this tool call";
    case "proposal":
      return "names this proposal";
    case "action":
      return "names this governed action";
    default:
      return assertNever(basis);
  }
}

export function limitationSentence(
  limitation: CaseExecutionLimitation,
): string {
  switch (limitation) {
    case "tool_attempt_unrecorded":
      return "No record says which attempt of a turn ran a tool operation. Tool operations are linked to their turn.";
    case "effect_attempts_unrecorded":
      return "A governed effect keeps its latest state only. Each try to run it is not recorded.";
    case "delivery_attempts_unrecorded":
      return "A delivery keeps its latest state only. Each try to send it is not recorded.";
    case "mail_proposal_origin_unrecorded":
      return "An email reply proposal does not name the turn or the tool call that made it. It is shown with no link.";
    case "proposal_tool_call_unrecorded":
      return "An older commerce proposal does not name the tool call that made it. It is linked to its turn.";
    case "session_unavailable":
      return "The records of one or more assignments could not be read. Their turns are absent.";
    case "effect_unavailable":
      return "The governed action records could not be read. Effects are absent.";
    case "truncated":
      return "This Case holds more records than this view shows.";
    case "record_invalid":
      return "A stored record has a value that this view cannot show. Its record appears with its kind only.";
    default:
      return assertNever(limitation);
  }
}

/**
 * What became of Memory for one turn, as one line. A read that did not
 * complete and a turn with no record are never worded as "none".
 */
export function memorySentence(memory: CaseExecutionTurnMemory): string {
  switch (memory.kind) {
    case "unrecorded":
      return "Memory: no record";
    case "none":
      return "Memory: none applied";
    case "admitted":
      return `Memory: ${String(memory.revisions)} used`;
    case "limited":
      return memory.revisions === 0
        ? "Memory: none used, some left out (size limit)"
        : `Memory: ${String(memory.revisions)} used, more left out (size limit)`;
    case "unavailable":
      switch (memory.reason) {
        case "deadline":
          return "Memory: not read in time";
        case "read_failed":
          return "Memory: read failed";
        default:
          return assertNever(memory);
      }
    default:
      return assertNever(memory);
  }
}

export function contentRoleLabel(role: CaseExecutionContent["role"]): string {
  switch (role) {
    case "input":
      return "Request";
    case "arguments":
      return "Arguments";
    case "result":
      return "Result";
    case "entry":
      return "Proposed entry";
    case "message":
      return "Message";
    case "action":
      return "Action";
    default:
      return assertNever(role);
  }
}

export function originLabel(origin: string): string {
  switch (origin) {
    case "portal_chat":
      return "Chat";
    case "slack":
      return "Slack";
    case "email":
      return "Email";
    case "whatsapp":
      return "WhatsApp";
    case "direct":
      return "Automation";
    case "inbox_assistant":
      return "Inbox";
    case "commerce_approval":
      return "Orders";
    case "canvas_chat":
      return "Canvas chat";
    default:
      return "Other";
  }
}

export function caseLabel(entry: CaseExecutionCaseRef): string {
  return `${originLabel(entry.origin)} case`;
}

/** The facts of an open node, as label and value pairs for its detail. */
export function nodeFacts(
  node: OpenCaseExecutionNode,
): readonly Readonly<{ label: string; value: string; time?: number }>[] {
  const time = (label: string, value: number | null) =>
    value === null ? [] : [{ label, value: "", time: value }];
  switch (node.kind) {
    case "trigger":
      return [
        { label: "Request", value: node.triggerId },
        ...time("Accepted", node.acceptedAt),
      ];
    case "assignment":
      return [
        { label: "Assignment", value: node.assignmentId },
        { label: "Session", value: node.sessionId },
        ...time("Started", node.startedAt),
        ...time("Settled", node.settledAt),
        ...(node.failureCode === null
          ? []
          : [{ label: "Failure code", value: node.failureCode }]),
      ];
    case "turn":
      return [
        { label: "Turn", value: node.turnId },
        { label: "Session", value: node.sessionId },
        ...time("Started", node.startedAt),
        ...(node.failureCode === null
          ? []
          : [{ label: "Failure code", value: node.failureCode }]),
      ];
    case "attempt":
      return [
        { label: "Runtime generation", value: String(node.generation) },
        ...time("Started", node.startedAt),
        ...time("Interrupted", node.interruptedAt),
      ];
    case "tool_operation":
      return [
        { label: "Tool", value: node.tool },
        { label: "Call", value: node.callId },
        ...time("Called", node.startedAt),
        ...time("Result accepted", node.settledAt),
        ...(node.receiptId === null
          ? []
          : [{ label: "Receipt", value: node.receiptId }]),
      ];
    case "proposal":
      return [
        { label: "Proposal", value: node.proposalId },
        ...time("Recorded", node.recordedAt),
      ];
    case "approval":
      return [
        { label: "Approval request", value: node.approvalId },
        ...time("Requested", node.requestedAt),
        ...time("Decided", node.decidedAt),
      ];
    case "effect":
      return [
        { label: "Governed action", value: node.actionId },
        ...time("Recorded", node.recordedAt),
        ...time("Last change", node.updatedAt),
        ...(node.receipt === null
          ? []
          : [
              { label: "Receipt", value: node.receipt.receiptId },
              { label: "Provider status", value: node.receipt.status },
            ]),
      ];
    case "delivery":
      return [
        { label: "Output", value: node.outputId },
        { label: "Connector", value: node.connectorId },
        ...time("Addressed", node.addressedAt),
        ...(node.receipt === null
          ? []
          : [
              { label: "Receipt", value: node.receipt.nativeReceiptId },
              ...time("Delivered", node.receipt.deliveredAt),
            ]),
      ];
    default:
      return assertNever(node);
  }
}

export type PlacedNode = Readonly<{
  node: CaseExecutionNode;
  /** The column: one more than the deepest node it has an edge from. */
  layer: number;
  /** The row inside its column. */
  row: number;
}>;

/**
 * Places every node for the graph. A node's column is one more than the
 * deepest node a recorded edge comes from, so an edge always points to the
 * right. Nodes with no recorded link to each other can share a column: that
 * is how independent branches show side by side. The order inside a column
 * is the order the projection returned. Time places nothing.
 */
export function placeExecution(
  execution: CaseExecution,
): readonly PlacedNode[] {
  const incoming = new Map<string, string[]>();
  for (const edge of execution.edges) {
    const from = incoming.get(edge.to) ?? [];
    from.push(edge.from);
    incoming.set(edge.to, from);
  }
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (nodeId: string): number => {
    const known = layerOf.get(nodeId);
    if (known !== undefined) return known;
    // The records hold no cycle. A repeated visit would be one, so it stops.
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    let deepest = -1;
    for (const from of incoming.get(nodeId) ?? [])
      deepest = Math.max(deepest, layer(from));
    visiting.delete(nodeId);
    layerOf.set(nodeId, deepest + 1);
    return deepest + 1;
  };
  // Inside a column a node sits near the nodes its edges come from, so the
  // links cross less. Nodes with no such order keep the projection's order.
  const columns = new Map<number, CaseExecutionNode[]>();
  for (const node of execution.nodes) {
    const column = layer(node.nodeId);
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const rowOf = new Map<string, number>();
  const placed: PlacedNode[] = [];
  for (const column of [...columns.keys()].sort(
    (left, right) => left - right,
  )) {
    const weight = (node: CaseExecutionNode): number => {
      const rows = (incoming.get(node.nodeId) ?? []).flatMap((from) => {
        const row = rowOf.get(from);
        return row === undefined ? [] : [row];
      });
      return rows.length === 0
        ? Number.MAX_SAFE_INTEGER
        : rows.reduce((sum, row) => sum + row, 0) / rows.length;
    };
    const ordered = (columns.get(column) ?? [])
      .map((node, index) => ({ node, index, weight: weight(node) }))
      .sort(
        (left, right) => left.weight - right.weight || left.index - right.index,
      );
    ordered.forEach((entry, row) => {
      rowOf.set(entry.node.nodeId, row);
      placed.push({ node: entry.node, layer: column, row });
    });
  }
  return placed;
}

/** The nodes an edge leads into `nodeId` from, with each edge's basis. */
export function linksInto(
  execution: CaseExecution,
  nodeId: string,
): readonly Readonly<{
  from: CaseExecutionNode;
  basis: CaseExecutionEdgeBasis;
}>[] {
  const byId = new Map(execution.nodes.map((node) => [node.nodeId, node]));
  return execution.edges.flatMap((edge) => {
    const from = edge.to === nodeId ? byId.get(edge.from) : undefined;
    return from === undefined ? [] : [{ from, basis: edge.basis }];
  });
}

export function countWithheld(execution: CaseExecution): number {
  return execution.nodes.filter((node) => node.access === "withheld").length;
}
