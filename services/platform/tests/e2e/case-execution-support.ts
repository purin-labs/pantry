import { exports } from "cloudflare:workers";
import {
  parseCaseExecutionCaseList,
  parseCaseTimelineDay,
  parseCaseExecutionNodeDetail,
  parseCaseExecutionPage,
  type CaseExecutionCaseRef,
  type CaseExecutionEdge,
  type CaseExecutionLimitation,
  type CaseExecutionNode,
  type CaseExecutionNodeDetail,
  type CaseExecutionNodeKind,
  type CaseTimelineDay,
  type OpenCaseExecutionNode,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import { expect } from "vitest";
import type { CaseSnapshot } from "../../src/actors/case/types";
import type { IssuedControlSession } from "../../src/data/control-plane";

/** A whole projection, read page by page through the control route. */
export type ReadCaseExecution = Readonly<{
  pages: number;
  basis: string;
  nodes: readonly CaseExecutionNode[];
  edges: readonly CaseExecutionEdge[];
  limitations: readonly CaseExecutionLimitation[];
}>;

export type OpenNode<Kind extends CaseExecutionNodeKind> = Extract<
  OpenCaseExecutionNode,
  { kind: Kind }
>;

export async function executionRequest(
  organisationId: string,
  session: IssuedControlSession,
  path: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${organisationId}${path}`,
      {
        headers: {
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          origin: "https://localhost",
        },
      },
    ),
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

/**
 * Reads every page of a Case's execution as one person. A page that is not
 * the contract's shape, a node returned twice and an edge that names a node
 * no page carried all fail the read. So does an open node at the end of an
 * edge from a withheld node: nothing is open below a record its reader may
 * not read.
 */
export async function readCaseExecution(
  organisationId: string,
  session: IssuedControlSession,
  caseId: string,
  limit: number,
): Promise<ReadCaseExecution> {
  const nodes = new Map<string, CaseExecutionNode>();
  const edges: CaseExecutionEdge[] = [];
  const limitations = new Set<CaseExecutionLimitation>();
  let cursor: string | null = null;
  let basis = "";
  let pages = 0;
  do {
    const query: string = `limit=${String(limit)}${cursor === null ? "" : `&after=${cursor}`}`;
    const read = await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?${query}`,
    );
    const page =
      read.status === 200 && isRecord(read.body)
        ? parseCaseExecutionPage(read.body.page)
        : null;
    if (page === null) throw new Error(JSON.stringify(read));
    if (page.nodes.length > limit) throw new Error("page over its limit");
    for (const node of page.nodes) {
      if (nodes.has(node.nodeId)) throw new Error(`node twice: ${node.nodeId}`);
      nodes.set(node.nodeId, node);
    }
    for (const edge of page.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to))
        throw new Error(`edge before its nodes: ${JSON.stringify(edge)}`);
      edges.push(edge);
    }
    for (const limitation of page.limitations) limitations.add(limitation);
    basis = page.basis;
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 200) throw new Error("the projection did not end");
  } while (cursor !== null);
  for (const edge of edges)
    if (
      nodes.get(edge.from)?.access === "withheld" &&
      nodes.get(edge.to)?.access === "open"
    )
      throw new Error(`open below a withheld node: ${JSON.stringify(edge)}`);
  return {
    pages,
    basis,
    nodes: [...nodes.values()],
    edges,
    limitations: [...limitations].sort(),
  };
}

export async function readCaseExecutionDetail(
  organisationId: string,
  session: IssuedControlSession,
  caseId: string,
  nodeId: string,
): Promise<
  Readonly<{ status: number; detail: CaseExecutionNodeDetail | null }>
> {
  const read = await executionRequest(
    organisationId,
    session,
    `/cases/${caseId}/execution/nodes/${nodeId}`,
  );
  return {
    status: read.status,
    detail:
      read.status === 200 && isRecord(read.body)
        ? parseCaseExecutionNodeDetail(read.body.detail)
        : null,
  };
}

export async function listExecutionCases(
  organisationId: string,
  session: IssuedControlSession,
): Promise<
  Readonly<{ status: number; cases: readonly CaseExecutionCaseRef[] | null }>
> {
  const read = await executionRequest(
    organisationId,
    session,
    "/case-executions",
  );
  return {
    status: read.status,
    cases:
      read.status === 200 && isRecord(read.body)
        ? parseCaseExecutionCaseList({ cases: read.body.cases })
        : null,
  };
}

/** The Case Timeline of a window, as one person reads it. */
export async function readCaseTimeline(
  organisationId: string,
  session: IssuedControlSession,
  window: Readonly<{ from: number; to: number }>,
): Promise<Readonly<{ status: number; timeline: CaseTimelineDay | null }>> {
  const read = await executionRequest(
    organisationId,
    session,
    `/case-executions/timeline?from=${String(window.from)}&to=${String(window.to)}`,
  );
  return {
    status: read.status,
    timeline:
      read.status === 200 && isRecord(read.body)
        ? parseCaseTimelineDay(read.body.timeline)
        : null,
  };
}

/** The open nodes of one kind, in the order the projection returned them. */
export function openNodes<Kind extends CaseExecutionNodeKind>(
  execution: ReadCaseExecution,
  kind: Kind,
): readonly OpenNode<Kind>[] {
  const found: OpenNode<Kind>[] = [];
  for (const node of execution.nodes)
    if (node.access === "open" && isKind(node, kind)) found.push(node);
  return found;
}

function isKind<Kind extends CaseExecutionNodeKind>(
  node: OpenCaseExecutionNode,
  kind: Kind,
): node is OpenNode<Kind> {
  return node.kind === kind;
}

/** The recorded references that lead into one node, as `basis:kind` pairs. */
export function incoming(
  execution: ReadCaseExecution,
  nodeId: string,
): readonly string[] {
  return execution.edges
    .filter((edge) => edge.to === nodeId)
    .map((edge) => {
      const from = execution.nodes.find((node) => node.nodeId === edge.from);
      return `${edge.basis}:${from?.kind ?? "missing"}`;
    })
    .sort();
}

/** The shape of a projection with no identity in it, for a comparison. */
export function executionShape(execution: ReadCaseExecution) {
  const count = (access: CaseExecutionNode["access"]) => {
    const kinds: Record<string, number> = {};
    for (const node of execution.nodes)
      if (node.access === access)
        kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    return kinds;
  };
  return {
    open: count("open"),
    withheld: count("withheld"),
    edges: execution.edges.length,
  };
}

function sortedExecution(execution: ReadCaseExecution) {
  return {
    basis: execution.basis,
    nodes: [...execution.nodes].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    edges: execution.edges
      .map((edge) => `${edge.from}>${edge.to}:${edge.basis}`)
      .sort(),
    limitations: execution.limitations,
  };
}

function base64Url(text: string): string {
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * The same Case read in small pages gives the same projection. A cursor that
 * is not one is refused, and a cursor from another projection is refused as
 * changed, so a reader never joins pages of two projections. A page inside a
 * Session names that Session's records as they were: a cursor that names
 * other records, or none, is refused as changed too.
 */
export async function verifyExecutionPaging(
  organisationId: string,
  session: IssuedControlSession,
  caseId: string,
  full: ReadCaseExecution,
) {
  const paged = await readCaseExecution(organisationId, session, caseId, 3);
  expect(paged.pages).toBeGreaterThan(1);
  expect(sortedExecution(paged)).toEqual(sortedExecution(full));
  const first = await executionRequest(
    organisationId,
    session,
    `/cases/${caseId}/execution?limit=1`,
  );
  const cursor =
    isRecord(first.body) && isRecord(first.body.page)
      ? first.body.page.nextCursor
      : null;
  if (typeof cursor !== "string") throw new Error("no second page");
  const decoded: unknown = JSON.parse(
    atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
  );
  if (!isRecord(decoded)) throw new Error("cursor shape");
  let inSession: Record<string, unknown> | null = null;
  for (
    let after: string | null = cursor, pages = 0;
    after !== null && inSession === null;
    pages += 1
  ) {
    if (pages > 200) throw new Error("the projection did not end");
    const at: unknown = JSON.parse(
      atob(after.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      isRecord(at) &&
      at.phase === "session" &&
      typeof at.offset === "number" &&
      at.offset > 0
    ) {
      inSession = at;
      break;
    }
    const read = await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?limit=1&after=${after}`,
    );
    after =
      isRecord(read.body) &&
      isRecord(read.body.page) &&
      typeof read.body.page.nextCursor === "string"
        ? read.body.page.nextCursor
        : null;
  }
  if (inSession === null) throw new Error("no page inside a Session");
  expect(inSession.part).toMatch(/^[0-9a-f]{64}$/u);
  const refused = {
    notACursor: await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?after=not.a.cursor`,
    ),
    otherProjection: await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?after=${base64Url(
        JSON.stringify({ ...decoded, basis: "0".repeat(64) }),
      )}`,
    ),
    otherSession: await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?limit=1&after=${base64Url(
        JSON.stringify({ ...inSession, part: "0".repeat(64) }),
      )}`,
    ),
    noSession: await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?limit=1&after=${base64Url(
        JSON.stringify({
          basis: inSession.basis,
          phase: "session",
          index: inSession.index,
          offset: inSession.offset,
        }),
      )}`,
    ),
    limitZero: await executionRequest(
      organisationId,
      session,
      `/cases/${caseId}/execution?limit=0`,
    ),
  };
  expect(refused).toMatchObject({
    notACursor: {
      status: 400,
      body: { error: "case_execution_cursor_invalid" },
    },
    otherProjection: { status: 409, body: { error: "case_execution_changed" } },
    otherSession: { status: 409, body: { error: "case_execution_changed" } },
    noSession: { status: 409, body: { error: "case_execution_changed" } },
    limitZero: { status: 400 },
  });
  return {
    pagesOfThree: paged.pages,
    refused: {
      notACursor: refused.notACursor.status,
      otherProjection: refused.otherProjection.status,
      otherSession: refused.otherSession.status,
      noSession: refused.noSession.status,
    },
  };
}

/**
 * A person who may not know of the Case gets the answer of a missing Case,
 * for the projection and for a node of it.
 */
export async function verifyExecutionHidden(
  organisationId: string,
  session: IssuedControlSession,
  caseId: string,
  nodeId: string,
) {
  const missing = await executionRequest(
    organisationId,
    session,
    "/cases/case_execution_does_not_exist/execution",
  );
  const hidden = await executionRequest(
    organisationId,
    session,
    `/cases/${caseId}/execution`,
  );
  const node = await executionRequest(
    organisationId,
    session,
    `/cases/${caseId}/execution/nodes/${nodeId}`,
  );
  expect(hidden).toEqual(missing);
  expect(hidden).toMatchObject({
    status: 404,
    body: { error: "case_execution_not_found" },
  });
  expect(node).toEqual(missing);
  return { status: hidden.status };
}

/**
 * A Portal chat Case in which each turn replied in text. Every reader of the
 * chat reads the same open projection. It is compared with the Case's own
 * records: one assignment and one Session for each turn, the proposal each
 * turn made, and the entries each later assignment was given.
 */
export async function verifyChatCaseExecution(
  input: Readonly<{
    organisationId: string;
    caseId: string;
    readers: readonly IssuedControlSession[];
    canonical: CaseSnapshot;
    /** What the last turn was asked and what it answered. */
    lastTurn: Readonly<{ input: string; reply: string }>;
  }>,
) {
  const { organisationId, caseId, canonical } = input;
  const reader = input.readers[0];
  if (reader === undefined) throw new Error("no reader");
  const full = await readCaseExecution(organisationId, reader, caseId, 100);
  expect(full.nodes.map((node) => node.access)).toEqual(
    full.nodes.map(() => "open"),
  );
  for (const other of input.readers.slice(1))
    expect(await readCaseExecution(organisationId, other, caseId, 100)).toEqual(
      full,
    );
  const triggers = openNodes(full, "trigger");
  const assignments = openNodes(full, "assignment");
  const proposals = openNodes(full, "proposal");
  const turns = openNodes(full, "turn");
  const attempts = openNodes(full, "attempt");
  expect(
    assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      state: assignment.state,
    })),
  ).toEqual(
    canonical.assignmentLifecycles.map((lifecycle) => ({
      assignmentId: lifecycle.assignment.assignmentId,
      sessionId: lifecycle.assignment.sessionId,
      state:
        lifecycle.kind === "settled"
          ? lifecycle.disposition.kind
          : lifecycle.kind,
    })),
  );
  expect(proposals.map((proposal) => proposal.proposalId).sort()).toEqual(
    [...canonical.acceptedProposalIds].sort(),
  );
  expect(triggers).toHaveLength(assignments.length);
  expect(turns.map((turn) => turn.sessionId)).toEqual(
    assignments.map((assignment) => assignment.sessionId),
  );
  // Each turn ran once: one runtime, which ended.
  expect(attempts.map((attempt) => [attempt.turnId, attempt.state])).toEqual(
    turns.map((turn) => [turn.turnId, "ended"]),
  );
  // Every edge stands for one recorded reference. A trigger has none. The
  // first assignment was given its trigger. Each later one was given its own
  // trigger and what the turn before it proposed.
  const references = (nodes: readonly { nodeId: string }[]) =>
    nodes.map((node) => incoming(full, node.nodeId));
  expect(references(triggers)).toEqual(triggers.map(() => []));
  expect(references(assignments)).toEqual(
    assignments.map((_, index) =>
      index === 0
        ? ["context_entry:trigger"]
        : ["context_entry:proposal", "context_entry:trigger"],
    ),
  );
  expect(references(turns)).toEqual(turns.map(() => ["assignment:assignment"]));
  expect(references(attempts)).toEqual(attempts.map(() => ["turn:turn"]));
  expect(references(proposals)).toEqual(proposals.map(() => ["turn:turn"]));
  expect(full.edges).toHaveLength(
    assignments.length * 2 -
      1 +
      turns.length +
      attempts.length +
      proposals.length,
  );
  expect(full.limitations).toEqual([]);
  // The detail of a node gives its stored content: what the turn was asked,
  // what it proposed, and the entries its assignment was given with the
  // node that made each. A turn has no content of its own.
  const detailOf = async (node: OpenCaseExecutionNode | undefined) => {
    if (node === undefined) throw new Error("node missing");
    const read = await readCaseExecutionDetail(
      organisationId,
      reader,
      caseId,
      node.nodeId,
    );
    if (read.detail === null) throw new Error(JSON.stringify(read));
    expect(read.detail.node).toEqual(node);
    return { content: read.detail.content, context: read.detail.context };
  };
  const details = {
    trigger: await detailOf(triggers.at(-1)),
    assignment: await detailOf(assignments.at(-1)),
    proposal: await detailOf(proposals.at(-1)),
    turn: await detailOf(turns.at(-1)),
  };
  expect(details).toMatchObject({
    trigger: {
      content: [{ role: "input", text: input.lastTurn.input }],
      context: [],
    },
    assignment: { content: [] },
    proposal: { content: [{ role: "entry", truncated: false }], context: [] },
    turn: { content: [], context: [] },
  });
  expect(details.proposal.content[0]?.text).toContain(input.lastTurn.reply);
  if (assignments.length > 1)
    expect(
      details.assignment.context.map((entry) => entry.producer).sort(),
    ).toEqual(
      [
        triggers.at(-1)?.nodeId,
        triggers.at(-2)?.nodeId,
        proposals.at(-2)?.nodeId,
      ].sort(),
    );
  return {
    full,
    details,
    paging: await verifyExecutionPaging(organisationId, reader, caseId, full),
  };
}

/** One accepted tool result, as the Session's history holds it. */
export type CanonicalToolResult = Readonly<{
  callId: string;
  tool: string;
  outcome: string;
}>;

/** Reads the accepted tool results of a Session from its own storage. */
export function readCanonicalToolResults(
  _actor: unknown,
  state: DurableObjectState,
): CanonicalToolResult[] {
  return state.storage.sql
    .exec<CanonicalToolResult>(
      `SELECT json_extract(payload, '$.entry.callId') AS callId,
         json_extract(payload, '$.entry.tool') AS tool,
         json_extract(payload, '$.entry.outcome.kind') AS outcome
       FROM session_harness_history
       WHERE json_extract(payload, '$.entry.kind') = 'tool_result'
       ORDER BY sequence`,
    )
    .toArray();
}

/**
 * A Portal chat Case whose one turn called tools. Each tool operation is one
 * accepted call with its accepted result, joined by the call identity, and
 * it hangs from the turn that made it. The detail of an operation gives the
 * arguments and the result. No record says which attempt made a call.
 */
export async function verifyToolTurnExecution(
  input: Readonly<{
    organisationId: string;
    session: IssuedControlSession;
    caseId: string;
    canonical: readonly CanonicalToolResult[];
    turn: "complete" | "failed";
  }>,
) {
  const { organisationId, session, caseId } = input;
  const full = await readCaseExecution(organisationId, session, caseId, 100);
  expect(full.nodes.map((node) => node.access)).toEqual(
    full.nodes.map(() => "open"),
  );
  const assignments = openNodes(full, "assignment");
  const turns = openNodes(full, "turn");
  const tools = openNodes(full, "tool_operation");
  const proposals = openNodes(full, "proposal");
  expect(turns.map((turn) => turn.state)).toEqual([input.turn]);
  expect(
    tools.map((tool) => ({
      callId: tool.callId,
      tool: tool.tool,
      outcome: tool.state,
    })),
  ).toEqual(input.canonical);
  expect(new Set(tools.map((tool) => tool.callId)).size).toBe(tools.length);
  for (const tool of tools) {
    expect(incoming(full, tool.nodeId)).toEqual(["turn:turn"]);
    expect(tool.settledAt).not.toBeNull();
    expect(tool.turnId).toBe(turns[0]?.turnId);
  }
  if (input.turn === "complete") {
    expect(assignments.map((assignment) => assignment.state)).toEqual([
      "completed",
    ]);
    expect(
      proposals.map((proposal) => incoming(full, proposal.nodeId)),
    ).toEqual([["turn:turn"]]);
  } else {
    // A turn that failed made no proposal, and its assignment records the
    // failure code. Neither is a result of the work.
    expect(assignments).toMatchObject([{ state: "failed" }]);
    expect(assignments[0]?.failureCode).not.toBeNull();
    expect(turns[0]?.failureCode).not.toBeNull();
    expect(proposals).toEqual([]);
  }
  expect(full.limitations).toEqual(
    tools.length === 0 ? [] : ["tool_attempt_unrecorded"],
  );
  const last = tools.at(-1);
  let detail: readonly string[] = [];
  if (last !== undefined) {
    const read = await readCaseExecutionDetail(
      organisationId,
      session,
      caseId,
      last.nodeId,
    );
    if (read.detail === null) throw new Error(JSON.stringify(read));
    expect(read.detail.node).toEqual(last);
    detail = read.detail.content.map((content) => content.role);
    expect(detail[0]).toBe("arguments");
    expect(detail.slice(1).every((role) => role === "result")).toBe(true);
  }
  return {
    caseId,
    shape: executionShape(full),
    assignment: assignments.map((assignment) => ({
      state: assignment.state,
      failureCode: assignment.failureCode,
    })),
    tools: tools.map((tool) => ({
      tool: tool.tool,
      state: tool.state,
      authority: tool.authority,
      receipt: tool.receiptId !== null,
    })),
    lastToolDetail: detail,
    limitations: full.limitations,
  };
}

/** One runtime transition of a Session, as its journal records it. */
export type CanonicalRuntime = Readonly<{
  kind:
    "runtime_activated" | "execution_resumed" | "execution_recovery_started";
  at: number;
  /** The generation an activation or a resumption starts. */
  generation: number | null;
  /** The generation a recovery fences. */
  fenced: number | null;
}>;

/** Reads the runtime transitions of a Session from its own journal. */
export function readCanonicalRuntimes(
  _actor: unknown,
  state: DurableObjectState,
): CanonicalRuntime[] {
  return state.storage.sql
    .exec<CanonicalRuntime>(
      `SELECT json_extract(envelope, '$.body.kind') AS kind,
         json_extract(envelope, '$.acceptedAt') AS at,
         json_extract(envelope, '$.body.state.runtimeLease.generation') AS generation,
         json_extract(envelope, '$.body.state.fencedRuntime.generation') AS fenced
       FROM actor_journal
       WHERE json_extract(envelope, '$.body.kind') IN (
         'runtime_activated', 'execution_resumed', 'execution_recovery_started'
       )
       ORDER BY stream_id, sequence`,
    )
    .toArray();
}

/**
 * A Portal chat Case whose turn was interrupted and went on to complete. The
 * turn has one attempt for each runtime the Session's journal records, and an
 * attempt is interrupted where the journal records the recovery that fenced
 * it, at that recovery's time. An attempt that ended has no end time. The
 * tool operations are the Session's accepted results. A tool operation that
 * was a BakeryOS command carries the receipt that the chat timeline shows for
 * the same command, with the same outcome.
 */
export async function verifyResumedTurnExecution(
  input: Readonly<{
    organisationId: string;
    session: IssuedControlSession;
    caseId: string;
    /** The Session of the turn that was interrupted. */
    sessionId: string;
    runtimes: readonly CanonicalRuntime[];
    tools: readonly CanonicalToolResult[];
    /** The state of each assignment of the Case, in order. */
    assignments: readonly string[];
    /** The state of each attempt of the interrupted turn, in order. */
    attempts: readonly ("interrupted" | "ended")[];
    /** The settled tool items of the chat timeline. */
    timeline: readonly Readonly<{
      receiptId: string | null;
      outcome: string;
    }>[];
    /** How many timeline items prepared the browser and were no tool call. */
    preparations: number;
  }>,
) {
  const { organisationId, session, caseId } = input;
  const full = await readCaseExecution(organisationId, session, caseId, 100);
  expect(full.nodes.map((node) => node.access)).toEqual(
    full.nodes.map(() => "open"),
  );
  expect(
    openNodes(full, "assignment").map((assignment) => assignment.state),
  ).toEqual(input.assignments);
  const turns = openNodes(full, "turn").filter(
    (turn) => turn.sessionId === input.sessionId,
  );
  expect(turns.map((turn) => turn.state)).toEqual(["complete"]);
  const attempts = openNodes(full, "attempt").filter(
    (attempt) => attempt.sessionId === input.sessionId,
  );
  expect(attempts.map((attempt) => attempt.state)).toEqual(input.attempts);
  // Each attempt is one runtime of the journal, and the journal's recovery
  // of a generation is what interrupted it.
  const started = input.runtimes.filter(
    (runtime) => runtime.kind !== "execution_recovery_started",
  );
  const fenced = new Map<number, number>();
  for (const runtime of input.runtimes)
    if (
      runtime.kind === "execution_recovery_started" &&
      runtime.fenced !== null
    )
      fenced.set(runtime.fenced, runtime.at);
  expect(
    attempts.map((attempt) => ({
      generation: attempt.generation,
      startedAt: attempt.startedAt,
      interruptedAt: attempt.interruptedAt,
    })),
  ).toEqual(
    started.map((runtime) => ({
      generation: runtime.generation,
      startedAt: runtime.at,
      interruptedAt:
        runtime.generation === null
          ? null
          : (fenced.get(runtime.generation) ?? null),
    })),
  );
  expect(fenced.size).toBe(
    input.attempts.filter((state) => state === "interrupted").length,
  );
  for (const attempt of attempts) {
    expect(incoming(full, attempt.nodeId)).toEqual(["turn:turn"]);
    expect(attempt.turnId).toBe(turns[0]?.turnId);
  }
  const tools = openNodes(full, "tool_operation").filter(
    (tool) => tool.sessionId === input.sessionId,
  );
  expect(
    tools.map((tool) => ({
      callId: tool.callId,
      tool: tool.tool,
      outcome: tool.state,
    })),
  ).toEqual(input.tools);
  for (const tool of tools)
    expect(incoming(full, tool.nodeId)).toEqual(["turn:turn"]);
  expect(full.limitations).toEqual(["tool_attempt_unrecorded"]);
  // The chat timeline and the graph name a BakeryOS command by one receipt.
  const commands = tools.filter((tool) => tool.authority === "surface_effect");
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect(command.receiptId).not.toBeNull();
    expect(
      input.timeline
        .filter((item) => item.receiptId === command.receiptId)
        .map((item) => item.outcome),
    ).toEqual([command.state]);
  }
  const receipts = new Set(commands.map((command) => command.receiptId));
  const timelineOnly = input.timeline.filter(
    (item) => item.receiptId === null || !receipts.has(item.receiptId),
  );
  expect(timelineOnly).toHaveLength(input.preparations);
  return {
    caseId,
    shape: executionShape(full),
    assignments: input.assignments,
    journal: input.runtimes,
    attempts: attempts.map((attempt) => ({
      generation: attempt.generation,
      state: attempt.state,
      startedAt: attempt.startedAt,
      interruptedAt: attempt.interruptedAt,
    })),
    tools: tools.map((tool) => ({
      tool: tool.tool,
      state: tool.state,
      authority: tool.authority,
      receipt: tool.receiptId !== null,
    })),
    timeline: {
      settledToolItems: input.timeline.length,
      sharedWithGraph: commands.length,
      preparationsWithNoToolCall: timelineOnly.length,
    },
    limitations: full.limitations,
  };
}

/**
 * A Case that one trigger started with more than one assignment side by
 * side. Each assignment was given the trigger and nothing of the other, so
 * no recorded reference joins them: the branches are parallel. Each branch
 * has its own Session, turn, attempt, proposal and delivery, as the Case's
 * own records hold them. The Case came from a source of the whole
 * Organisation, so each member reads every record of it (Plan 27C).
 */
export async function verifyParallelAssignmentExecution(
  input: Readonly<{
    organisationId: string;
    session: IssuedControlSession;
    caseId: string;
    canonical: CaseSnapshot;
  }>,
) {
  const { organisationId, session, caseId, canonical } = input;
  const full = await readCaseExecution(organisationId, session, caseId, 100);
  const branches = canonical.assignmentLifecycles.length;
  expect(branches).toBeGreaterThan(1);
  expect(
    new Set(
      canonical.assignmentLifecycles.map(
        (lifecycle) => lifecycle.assignment.sessionId,
      ),
    ).size,
  ).toBe(branches);
  for (const node of full.nodes)
    if (node.access === "withheld")
      expect(Object.keys(node).sort()).toEqual(["access", "kind", "nodeId"]);
  const kinds: Record<string, number> = {};
  for (const node of full.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  expect(kinds).toEqual({
    trigger: 1,
    assignment: branches,
    turn: branches,
    attempt: branches,
    proposal: canonical.acceptedProposalIds.length,
    delivery: canonical.outputs.length,
  });
  expect(canonical.acceptedProposalIds).toHaveLength(branches);
  expect(canonical.outputs).toHaveLength(branches);
  const references = (kind: CaseExecutionNodeKind) =>
    full.nodes
      .filter((node) => node.kind === kind)
      .map((node) => incoming(full, node.nodeId).join(","));
  expect(references("trigger")).toEqual([""]);
  expect(references("assignment")).toEqual(
    Array.from({ length: branches }, () => "context_entry:trigger"),
  );
  expect(references("turn")).toEqual(
    Array.from({ length: branches }, () => "assignment:assignment"),
  );
  expect(references("attempt")).toEqual(
    Array.from({ length: branches }, () => "turn:turn"),
  );
  expect(references("proposal")).toEqual(
    Array.from({ length: branches }, () => "turn:turn"),
  );
  expect(references("delivery")).toEqual(
    Array.from({ length: branches }, () => "proposal:proposal"),
  );
  // Everything that follows from one assignment follows from that one only.
  const after = (nodeId: string): Set<string> => {
    const seen = new Set<string>();
    const open = [nodeId];
    for (let next = open.pop(); next !== undefined; next = open.pop())
      for (const edge of full.edges)
        if (edge.from === next && !seen.has(edge.to)) {
          seen.add(edge.to);
          open.push(edge.to);
        }
    return seen;
  };
  const assignments = full.nodes.filter((node) => node.kind === "assignment");
  const reached = assignments.map((assignment) => after(assignment.nodeId));
  for (const branch of reached)
    expect(
      [...branch].map(
        (nodeId) => full.nodes.find((node) => node.nodeId === nodeId)?.kind,
      ),
    ).toEqual(["turn", "attempt", "proposal", "delivery"]);
  const all = reached.flatMap((branch) => [...branch]);
  expect(new Set(all).size).toBe(all.length);
  for (const assignment of assignments)
    for (const branch of reached)
      expect(branch.has(assignment.nodeId)).toBe(false);
  expect(full.limitations).toEqual(["delivery_attempts_unrecorded"]);
  expect(executionShape(full).withheld).toEqual({});
  return {
    caseId,
    shape: executionShape(full),
    branches,
    canonical: {
      assignments: canonical.assignmentLifecycles.map((lifecycle) => ({
        role: lifecycle.assignment.role,
        state: lifecycle.kind,
      })),
      proposals: canonical.acceptedProposalIds.length,
      outputs: canonical.outputs.length,
    },
    limitations: full.limitations,
    paging: await verifyExecutionPaging(organisationId, session, caseId, full),
  };
}

/**
 * A Case with a governed action in it, from a source of the whole
 * Organisation, so each member reads every record of it (Plan 27C). The
 * projection holds one open node for each record and each recorded edge. It
 * is compared with the Case's own records and the Session's history, and each
 * node's detail opens.
 */
export async function verifyCommerceExecution(
  input: Readonly<{
    organisationId: string;
    session: IssuedControlSession;
    caseId: string;
    canonical: CaseSnapshot;
    triggers: number;
    turns: number;
    toolResults: readonly CanonicalToolResult[];
  }>,
) {
  const { organisationId, session, caseId, canonical } = input;
  const full = await readCaseExecution(organisationId, session, caseId, 100);
  const outputs = canonical.outputs.map((lifecycle) => lifecycle.output.source);
  expect(executionShape(full)).toMatchObject({
    withheld: {},
    open: {
      trigger: input.triggers,
      assignment: canonical.assignmentLifecycles.length,
      turn: input.turns,
      attempt: input.turns,
      tool_operation: input.toolResults.length,
      proposal:
        canonical.acceptedProposalIds.length +
        canonical.acceptedCommerceProposalIds.length,
      approval: canonical.commerceApprovals.length,
      effect: canonical.commerceApprovals.length,
      delivery: outputs.length,
    },
  });
  const references = (kind: CaseExecutionNodeKind) =>
    full.nodes
      .filter((node) => node.kind === kind)
      .map((node) => incoming(full, node.nodeId).join(","))
      .sort();
  // The one commerce proposal hangs from the tool call that made it. The
  // approval wait hangs from that proposal, the effect from the wait, and the
  // outcome's delivery from the effect.
  expect(references("proposal")).toEqual(
    [
      ...canonical.acceptedProposalIds.map(() => "turn:turn"),
      ...canonical.acceptedCommerceProposalIds.map(
        () => "tool_call:tool_operation",
      ),
    ].sort(),
  );
  expect(references("approval")).toEqual(
    canonical.commerceApprovals.map(() => "proposal:proposal"),
  );
  expect(references("effect")).toEqual(
    canonical.commerceApprovals.map(() => "action:approval"),
  );
  expect(references("delivery")).toEqual(
    outputs
      .map((source) =>
        source.kind === "commerce_outcome"
          ? "action:effect"
          : "proposal:proposal",
      )
      .sort(),
  );
  expect(references("turn")).toEqual(
    Array.from({ length: input.turns }, () => "assignment:assignment"),
  );
  expect(references("tool_operation")).toEqual(
    input.toolResults.map(() => "turn:turn"),
  );
  expect(references("attempt")).toEqual(
    Array.from({ length: input.turns }, () => "turn:turn"),
  );
  expect(full.limitations).toEqual([
    "delivery_attempts_unrecorded",
    "effect_attempts_unrecorded",
    "tool_attempt_unrecorded",
  ]);
  // Each node's detail opens; a node that is not one answers as missing.
  const missing = await executionRequest(
    organisationId,
    session,
    `/cases/${caseId}/execution/nodes/c.${"0".repeat(24)}`,
  );
  expect(missing.status).toBe(404);
  const details = [];
  for (const node of full.nodes)
    details.push(
      (
        await executionRequest(
          organisationId,
          session,
          `/cases/${caseId}/execution/nodes/${node.nodeId}`,
        )
      ).status,
    );
  expect(details).toEqual(full.nodes.map(() => 200));
  return {
    caseId,
    shape: executionShape(full),
    references: {
      proposal: references("proposal"),
      approval: references("approval"),
      effect: references("effect"),
      delivery: references("delivery"),
    },
    limitations: full.limitations,
    nodeDetails: details.length,
    paging: await verifyExecutionPaging(organisationId, session, caseId, full),
  };
}

/**
 * A Case in which two assignments ran side by side and a third was given
 * what both proposed. The third assignment's governed action so follows from
 * both. The projection holds the join: the third assignment has an edge from each of the two proposals, and the one
 * effect of the Case is reached from each of the two side-by-side
 * assignments.
 */
export async function verifyCombinedProposalExecution(
  input: Readonly<{
    organisationId: string;
    session: IssuedControlSession;
    caseId: string;
  }>,
) {
  const full = await readCaseExecution(
    input.organisationId,
    input.session,
    input.caseId,
    100,
  );
  const assignments = full.nodes.filter((node) => node.kind === "assignment");
  const given = assignments.map((assignment) =>
    incoming(full, assignment.nodeId),
  );
  // The third assignment also held the trigger. Both earlier assignments
  // carried it, so the graph reaches the trigger through them and draws no
  // third edge.
  expect(
    [...given].sort((left, right) => left.length - right.length),
    JSON.stringify(given),
  ).toEqual([
    ["context_entry:trigger"],
    ["context_entry:trigger"],
    ["context_entry:proposal", "context_entry:proposal"],
  ]);
  const after = (nodeId: string): Set<string> => {
    const seen = new Set<string>();
    const open = [nodeId];
    for (let next = open.pop(); next !== undefined; next = open.pop())
      for (const edge of full.edges)
        if (edge.from === next && !seen.has(edge.to)) {
          seen.add(edge.to);
          open.push(edge.to);
        }
    return seen;
  };
  const effects = full.nodes.filter((node) => node.kind === "effect");
  expect(effects).toHaveLength(1);
  const sideBySide = assignments.filter((assignment) =>
    incoming(full, assignment.nodeId).includes("context_entry:trigger"),
  );
  expect(sideBySide).toHaveLength(2);
  const reached = sideBySide.map((assignment) => after(assignment.nodeId));
  for (const branch of reached)
    expect(branch.has(effects[0]?.nodeId ?? "")).toBe(true);
  // Neither of the two follows from the other.
  expect(reached[0]?.has(sideBySide[1]?.nodeId ?? "")).toBe(false);
  expect(reached[1]?.has(sideBySide[0]?.nodeId ?? "")).toBe(false);
  return {
    assignmentsGiven: given,
    effectFollowsFromBoth: true,
    nodesAfterEachAssignment: reached.map((branch) => branch.size),
  };
}
