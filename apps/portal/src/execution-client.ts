import {
  parseCaseExecutionPage,
  parseCaseExecutionNodeDetail,
  type ConversationId,
  type CaseExecutionNode,
  type CaseExecutionEdge,
  type CaseExecutionLimitation,
  type CaseExecutionNodeDetail,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { ControlApiError } from "./control-client";

type ExecutionTransport = Readonly<{
  read: (path: string) => Promise<unknown>;
}>;

function organisationPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}`;
}

const MAX_EXECUTION_PAGES = 60;

export type ReadCaseExecution = Readonly<{
  caseId: string;
  nodes: readonly CaseExecutionNode[];
  edges: readonly CaseExecutionEdge[];
  limitations: readonly CaseExecutionLimitation[];
}>;

/**
 * The whole execution projection of one Case, read page by page. When the
 * Case changes between two pages, Pantry refuses the next page and the read
 * starts again, so the pages of two projections are never joined.
 *
 * `onPages` receives what was read so far after each page but the last, so
 * that a view can show a long Case while its pages arrive.
 */
export async function readCaseExecution(
  transport: ExecutionTransport,
  organisationId: string,
  caseId: string,
  onPages?: (partial: ReadCaseExecution) => void,
): Promise<ReadCaseExecution> {
  const base = `${organisationPath(organisationId)}/cases/${encodeURIComponent(caseId)}/execution`;
  return readExecutionPages(transport, base, onPages);
}

export async function readChatExecution(
  transport: ExecutionTransport,
  organisationId: string,
  conversationId: ConversationId,
): Promise<ReadCaseExecution> {
  return readExecutionPages(
    transport,
    `${organisationPath(organisationId)}/chat/${encodeURIComponent(conversationId)}/execution`,
  );
}

async function readExecutionPages(
  transport: ExecutionTransport,
  base: string,
  onPages?: (partial: ReadCaseExecution) => void,
): Promise<ReadCaseExecution> {
  for (let restart = 0; restart < 3; restart += 1) {
    const nodes = new Map<string, CaseExecutionNode>();
    const edges: CaseExecutionEdge[] = [];
    const limitations = new Set<CaseExecutionLimitation>();
    let cursor: string | null = null;
    let changed = false;
    let caseId: string | null = null;
    for (let pages = 0; pages < MAX_EXECUTION_PAGES; pages += 1) {
      let raw: unknown;
      try {
        raw = await transport.read(
          cursor === null
            ? base
            : `${base}?after=${encodeURIComponent(cursor)}`,
        );
      } catch (error) {
        if (executionErrorCode(error) !== "case_execution_changed") throw error;
        changed = true;
        break;
      }
      const page = isRecord(raw) ? parseCaseExecutionPage(raw.page) : null;
      if (page === null)
        throw new Error("The server returned a page this view cannot read.");
      if (caseId !== null && caseId !== page.caseId)
        throw new Error("The execution identity changed between pages.");
      caseId = page.caseId;
      for (const node of page.nodes) nodes.set(node.nodeId, node);
      edges.push(...page.edges);
      for (const limitation of page.limitations) limitations.add(limitation);
      cursor = page.nextCursor;
      const read = {
        caseId,
        nodes: [...nodes.values()],
        edges: [...edges],
        limitations: [...limitations],
      };
      if (cursor === null) return read;
      onPages?.(read);
    }
    if (!changed && caseId !== null)
      return {
        caseId,
        nodes: [...nodes.values()],
        edges,
        limitations: [...limitations, "truncated"],
      };
  }
  throw new Error(
    "This Case is changing while it is read. Wait a moment, then try again.",
  );
}

/** The stored content behind one node this person may read. */
export async function readExecutionNode(
  transport: ExecutionTransport,
  organisationId: string,
  caseId: string,
  nodeId: string,
): Promise<CaseExecutionNodeDetail> {
  const raw = await transport.read(
    `${organisationPath(organisationId)}/cases/${encodeURIComponent(caseId)}/execution/nodes/${encodeURIComponent(nodeId)}`,
  );
  const detail = isRecord(raw)
    ? parseCaseExecutionNodeDetail(raw.detail)
    : null;
  if (detail === null)
    throw new Error("The server returned a detail this view cannot read.");
  return detail;
}

function executionErrorCode(error: unknown): unknown {
  return error instanceof ControlApiError && isRecord(error.details)
    ? error.details.error
    : null;
}

/** What to tell the person when an execution read fails. */
export function executionErrorMessage(error: unknown): string {
  switch (executionErrorCode(error)) {
    case "case_execution_not_found":
      return "This Case is not available to you.";
    case "case_execution_unavailable":
      return "Pantry could not read this Case now. Try again.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not complete this request. Try again.";
  }
}
