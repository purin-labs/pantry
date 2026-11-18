import React from "react";
import type {
  CaseExecutionNode,
  CaseExecutionNodeDetail,
  CaseExecutionPage,
  OpenCaseExecutionNode,
} from "@seams/control-api";
import type { ChatWork, ChatTimelineView } from "@seams/control-api/portal/chat";

let pageReads = 0;
let revoked = false;
const caseId = "case_trace_preview";
const sessionId = "session_trace_preview";
const turnId = "turn_trace_preview";

export function executionPreviewEnabled(): boolean {
  return (
    new URLSearchParams(window.location.search).get("scenario") ===
    "trace-execution"
  );
}

export function executionPreviewWork(): ChatWork {
  return {
    kind: "running",
    requestId: "preview_request",
    sessionId,
    turnId,
    expiresAt: Date.now() + 60_000,
  };
}

export function executionPreviewEvents(): readonly ChatTimelineView[] {
  if (!executionPreviewEnabled()) return [];
  return [
    {
      kind: "approval",
      eventId: "commerce-approval-event",
      sequence: 6,
      requestId: "preview_request",
      createdAt: 6,
      approval: {
        kind: "requested",
        approvalId: "approval_preview_refund",
        operation: "Cancel order A101",
        destination: "Connected commerce system",
        effect: "Full refund",
        expiresAt: 1792108800000,
        fields: { Order: "A101", Refund: "JPY 8400" },
        alwaysAllow: false,
      },
    },
    {
      kind: "receipt",
      eventId: "commerce-receipt-event",
      sequence: 7,
      requestId: "preview_request",
      createdAt: 7,
      receipt: {
        receiptId: "chat_receipt_preview_refund",
        state: "reconciliation_required",
        summary: "The provider did not confirm the refund outcome.",
      },
    },
  ];
}

export function previewExecutionResponse(url: URL): Response | null {
  if (
    !url.pathname.endsWith("/execution") &&
    !url.pathname.includes("/execution/nodes/")
  )
    return null;
  if (!executionPreviewEnabled() || revoked)
    return Response.json(
      { error: "case_execution_not_found" },
      { status: 404 },
    );
  if (url.pathname.endsWith("/execution")) {
    pageReads += 1;
    const page: CaseExecutionPage = {
      caseId,
      basis: "preview-case",
      nextCursor: null,
      nodes: previewNodes(pageReads > 1),
      edges: [
        { from: "assignment", to: "turn", basis: "assignment" },
        { from: "turn", to: "lookup", basis: "turn" },
        { from: "turn", to: "command", basis: "turn" },
        {
          from: "commerce-proposal",
          to: "commerce-approval",
          basis: "proposal",
        },
        { from: "commerce-approval", to: "commerce-effect", basis: "action" },
      ],
      limitations: [],
    };
    return Response.json({ ok: true, page });
  }
  const nodeId = url.pathname.split("/").at(-1);
  let found: OpenCaseExecutionNode | null = null;
  for (const node of previewNodes(pageReads > 1))
    if (node.nodeId === nodeId && node.access === "open") found = node;
  if (found === null)
    return Response.json(
      { error: "case_execution_not_found" },
      { status: 404 },
    );
  const detail: CaseExecutionNodeDetail = {
    caseId,
    node: found,
    content: [],
    context: [],
  };
  if (found.kind === "assignment")
    return Response.json({
      ok: true,
      detail: {
        ...detail,
        content: [
          {
            role: "input",
            text: "Inspect shipment A101 and validate its delivery report.",
            truncated: false,
          },
        ],
      },
    });
  if (found.kind !== "tool_operation")
    return Response.json({ ok: true, detail });
  const content: CaseExecutionNodeDetail["content"][number][] = [
    {
      role: "arguments",
      text:
        found.nodeId === "lookup"
          ? '{"query":"shipment A101"}'
          : JSON.stringify({ code: 'await validateShipment("A101")' }),
      truncated: false,
    },
  ];
  if (found.state !== "started")
    content.push({
      role: "result",
      text:
        found.nodeId === "lookup"
          ? '{"shipment":"A101","status":"in_transit","privateNote":"fragile pastry gift"}'
          : "TypeError: Missing delivery window\n  at validateShipment (report.ts:42:7)\nProcess exited with code 1.",
      truncated: false,
    });
  return Response.json({
    ok: true,
    detail: {
      caseId,
      node: found,
      content,
      context: [],
    } satisfies CaseExecutionNodeDetail,
  });
}

function previewNodes(settled: boolean): readonly CaseExecutionNode[] {
  const assignment: CaseExecutionNode = {
    access: "open",
    kind: "assignment",
    nodeId: "assignment",
    assignmentId: "assignment_preview",
    sessionId,
    role: "research",
    state: settled ? "completed" : "running",
    caseRevision: 1,
    startedAt: 1,
    settledAt: settled ? 4 : null,
    failureCode: null,
  };
  const turn: CaseExecutionNode = {
    access: "open",
    kind: "turn",
    nodeId: "turn",
    sessionId,
    turnId,
    state: settled ? "complete" : "running",
    startedAt: 1,
    failureCode: null,
    memory: { kind: "none" },
  };
  const lookup: CaseExecutionNode = {
    access: "open",
    kind: "tool_operation",
    nodeId: "lookup",
    sessionId,
    turnId,
    callId: "lookup_preview",
    tool: "tool_search",
    state: settled ? "succeeded" : "started",
    startedAt: 2,
    settledAt: settled ? 4 : null,
    authority: "read",
    receiptId: null,
  };
  const command: CaseExecutionNode = {
    access: "open",
    kind: "tool_operation",
    nodeId: "command",
    sessionId,
    turnId,
    callId: "command_preview",
    tool: "run_code",
    state: settled ? "failed" : "started",
    startedAt: 3,
    settledAt: settled ? 3 : null,
    authority: "code_execution",
    receiptId: null,
  };
  const commerce: readonly CaseExecutionNode[] = [
    {
      access: "open",
      kind: "proposal",
      nodeId: "commerce-proposal",
      proposalId: "proposal_preview_refund",
      proposalKind: "commerce_action",
      state: "approved",
      recordedAt: 5,
      title: "Refund payment",
    },
    {
      access: "open",
      kind: "approval",
      nodeId: "commerce-approval",
      approvalId: "approval_preview_refund",
      state: "approved",
      requestedAt: 6,
      decidedAt: 7,
    },
    {
      access: "open",
      kind: "effect",
      nodeId: "commerce-effect",
      actionId: "action_preview_refund",
      state: "indeterminate",
      recordedAt: 8,
      updatedAt: 9,
      receipt: {
        receiptId: "receipt_preview_refund",
        status: "indeterminate",
        observedAt: 9,
      },
    },
  ];
  return settled
    ? [assignment, turn, command, lookup, ...commerce]
    : [assignment, turn, lookup, command, ...commerce];
}

function revokeExecution(): void {
  revoked = true;
}

export function ChatExecutionPreviewControls(): React.ReactNode {
  if (!executionPreviewEnabled()) return null;
  return (
    <aside
      style={{ position: "fixed", top: 8, left: 8, zIndex: 1000 }}
      aria-label="Execution preview controls"
    >
      <button type="button" onClick={revokeExecution}>
        Revoke activity access
      </button>
    </aside>
  );
}

export function executionPreviewStream(signal: AbortSignal | null): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start: startProgress.bind(null, signal) }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}
function startProgress(
  signal: AbortSignal | null,
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        kind: "progress",
        sequence: 1,
        label: "Inspecting shipment tools",
      }) + "\n",
    ),
  );
  signal?.addEventListener("abort", closeProgress.bind(null, controller), {
    once: true,
  });
}
function closeProgress(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  try {
    controller.close();
  } catch {
    /* The reader may already have cancelled. */
  }
}
