import {
  MAX_CASE_EXECUTION_CASES,
  MAX_CASE_EXECUTION_PAGE,
  MAX_CASE_TIMELINE_SPANS,
  type CaseExecutionCaseRef,
  type CaseExecutionNode,
  type CaseTimelineCase,
  type CaseTimelineDay,
  type CaseTimelineSpan,
  type OpenCaseExecutionNode,
  type ScheduleRun,
  type ScheduleRunsDay,
} from "@purin-labs/control-api";

import { assertNever, parseJsonOrNull } from "@purin-labs/std";

import type { AuthorizedConversationScope as ConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import { listVisibleChatTitles } from "../chat/store";
import type { Env } from "@purin-labs/kernel/env";
import {
  resolveMemoryViewer,
  viewerMayRead,
  type MemoryViewer,
} from "../memory/access";
import { FlowBinding } from "../policy/information-flow";
import type { Result } from "@purin-labs/kernel/result";
import {
  listCaseExecutionCases,
  readCaseExecutionPage,
  type CaseExecutionReadError,
} from "./access";
import type { Variant } from "@purin-labs/type-utils";

/** The Cases one timeline read summarises. Each costs a projection read. */
const MAX_TIMELINE_CASES = 30;
/** How many Cases are read at once. */
const TIMELINE_READS_AT_ONCE = 4;
/** Pages read for one Case before its summary stops. */
const MAX_TIMELINE_PAGES = 6;
/** The newest schedule runs one read summarises. Each costs a projection read. */
const MAX_SCHEDULE_RUNS = 40;

type OpenNode<Kind extends OpenCaseExecutionNode["kind"]> = Variant<
  OpenCaseExecutionNode,
  Kind
>;

/** What a Case is called for one reader, and the Case that proposed it. */
type CaseName = Readonly<{ title: string | null; sideCaseOf: string | null }>;

/**
 * The Cases filed in a window, each as one timeline event. The set is the
 * Activity list's: Cases this person may read, by the time they were filed.
 * Each event summarises the Case's execution projection page by page,
 * through the same read that serves the Case trace, so a record withheld
 * from this person adds to `withheld` and discloses nothing else. Titles and
 * side Case links pass their own checks in `readCaseNames`.
 */
export async function readCaseTimelineDay(
  env: Env,
  scope: ConversationScope,
  window: Readonly<{ from: number; to: number }>,
): Promise<Result<CaseTimelineDay, CaseExecutionReadError>> {
  const listed = await listCaseExecutionCases(env, scope);
  if (!listed.ok) return listed;
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("case_execution_not_found");
  const inWindow = listed.value.filter(
    (ref) => ref.filedAt >= window.from && ref.filedAt < window.to,
  );
  const chosen = inWindow.slice(0, MAX_TIMELINE_CASES);
  const read = await summariseCases(
    env,
    scope,
    viewer,
    chosen,
    new Set(listed.value.map((ref) => ref.caseId)),
  );
  if (read === "unavailable") return failure("case_execution_unavailable");
  const cases = [...read.values()];
  cases.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.caseId.localeCompare(right.caseId),
  );
  // The list carries the newest Cases only. When it is full and its oldest
  // Case still falls in the window, older Cases of the window are not in it.
  const oldest = listed.value.at(-1);
  const listFull =
    listed.value.length >= MAX_CASE_EXECUTION_CASES &&
    oldest !== undefined &&
    oldest.filedAt >= window.from;
  return {
    ok: true,
    value: {
      from: window.from,
      to: window.to,
      cases,
      truncated: inWindow.length > MAX_TIMELINE_CASES || listFull,
    },
  };
}

/**
 * The runs of the Organisation's agent schedules in a window, each with the
 * Case it opened as this reader may see it on the timeline. A run whose Case
 * the reader may not read adds to `withheld` and discloses nothing else, not
 * even its schedule or its time.
 */
export async function readScheduleRunsDay(
  env: Env,
  scope: ConversationScope,
  window: Readonly<{ from: number; to: number }>,
): Promise<Result<ScheduleRunsDay, CaseExecutionReadError>> {
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("case_execution_not_found");
  const rows = await viewer.execution.database
    .prepare(
      `SELECT r.binding_id, r.window_key, r.case_id, r.dispatched_at,
              b.installation_id
       FROM schedule_dispatch_receipt r
       JOIN schedule_binding b
         ON b.binding_id = r.binding_id AND b.organisation_id = r.organisation_id
       WHERE r.organisation_id = ? AND r.dispatched_at >= ? AND r.dispatched_at < ?
       ORDER BY r.dispatched_at DESC, r.binding_id
       LIMIT ?`,
    )
    .bind(
      viewer.execution.organisationId,
      window.from,
      window.to,
      MAX_SCHEDULE_RUNS + 1,
    )
    .all<Record<string, unknown>>();
  const receipts = rows.results.slice(0, MAX_SCHEDULE_RUNS).flatMap((row) =>
    typeof row.binding_id === "string" &&
    typeof row.window_key === "string" &&
    typeof row.case_id === "string" &&
    typeof row.installation_id === "string" &&
    typeof row.dispatched_at === "number" &&
    Number.isSafeInteger(row.dispatched_at) &&
    row.dispatched_at >= 0
      ? [
          {
            bindingId: row.binding_id,
            installationId: row.installation_id,
            windowKey: row.window_key,
            caseId: row.case_id,
            dispatchedAt: row.dispatched_at,
          },
        ]
      : [],
  );
  const readable = await listCaseExecutionCases(env, scope, [
    ...new Set(receipts.map((receipt) => receipt.caseId)),
  ]);
  if (!readable.ok) return readable;
  const read = await summariseCases(
    env,
    scope,
    viewer,
    readable.value,
    new Set(readable.value.map((ref) => ref.caseId)),
  );
  if (read === "unavailable") return failure("case_execution_unavailable");
  const runs: ScheduleRun[] = [];
  for (const { caseId, ...receipt } of receipts) {
    const event = read.get(caseId);
    if (event !== undefined) runs.push({ ...receipt, case: event });
  }
  return {
    ok: true,
    value: {
      from: window.from,
      to: window.to,
      runs,
      withheld: receipts.length - runs.length,
      truncated: rows.results.length > MAX_SCHEDULE_RUNS,
    },
  };
}

/**
 * Each Case as one timeline event for this reader, by Case identifier. A Case
 * the reader can no longer open has none. `known` holds the Cases this reader
 * may know of, which a side Case's link must point into.
 */
async function summariseCases(
  env: Env,
  scope: ConversationScope,
  viewer: MemoryViewer,
  refs: readonly CaseExecutionCaseRef[],
  known: ReadonlySet<string>,
): Promise<ReadonlyMap<string, CaseTimelineCase> | "unavailable"> {
  const names = await readCaseNames(
    viewer,
    scope,
    refs.map((ref) => ref.caseId),
    known,
  );
  const cases = new Map<string, CaseTimelineCase>();
  for (let at = 0; at < refs.length; at += TIMELINE_READS_AT_ONCE) {
    const read = await Promise.all(
      refs
        .slice(at, at + TIMELINE_READS_AT_ONCE)
        .map(readCase.bind(null, env, scope)),
    );
    for (const summary of read) {
      if (summary === "unavailable") return "unavailable";
      if (summary !== null) {
        const { recordTitle, ...event } = summary;
        cases.set(summary.caseId, {
          ...event,
          ...withRecordTitle(names.get(summary.caseId), recordTitle),
        });
      }
    }
  }
  return cases;
}

/**
 * The title of each Case that this reader may see. A side Case shows its
 * title and the Case that proposed it only when the reader may see the
 * proposing turn in the Portal (Plan 27C), so a private source hides both. Any other chat shows its title as the chat list does,
 * to a person who can open it. Every other Case is named by its own records:
 * the title its open trigger or commerce proposal shows.
 */
async function readCaseNames(
  viewer: MemoryViewer,
  scope: ConversationScope,
  caseIds: readonly string[],
  known: ReadonlySet<string>,
): Promise<ReadonlyMap<string, CaseName>> {
  const names = new Map<string, CaseName>();
  if (caseIds.length === 0) return names;
  const db = viewer.execution.database;
  const [chats, proposals] = await Promise.all([
    listVisibleChatTitles(db, scope, caseIds),
    db
      .prepare(
        `SELECT source_case_id, destination_case_id, title, flow_binding_json
         FROM side_case_proposal
         WHERE organisation_id = ? AND status IN ('starting', 'started')
           AND destination_case_id IN (${caseIds.map(() => "?").join(", ")})`,
      )
      .bind(viewer.execution.organisationId, ...caseIds)
      .all<Record<string, unknown>>(),
  ]);
  const sideCases = new Set<string>();
  for (const row of proposals.results) {
    if (typeof row.destination_case_id !== "string") continue;
    sideCases.add(row.destination_case_id);
    // A side Case that this reader may not receive has no title at all: its
    // records came from the proposing turn, so none of them may name it.
    names.set(
      row.destination_case_id,
      typeof row.source_case_id === "string" &&
        typeof row.title === "string" &&
        (await mayReceiveProposal(viewer, row.flow_binding_json))
        ? {
            title: chats.get(row.destination_case_id) ?? row.title,
            sideCaseOf: known.has(row.source_case_id)
              ? row.source_case_id
              : null,
          }
        : { title: null, sideCaseOf: null },
    );
  }
  for (const caseId of caseIds) {
    const title = chats.get(caseId);
    if (!sideCases.has(caseId) && title !== undefined)
      names.set(caseId, { title, sideCaseOf: null });
  }
  return names;
}

/** Whether this reader may see the turn that proposed a side Case now. */
async function mayReceiveProposal(
  viewer: MemoryViewer,
  bindingJson: unknown,
): Promise<boolean> {
  if (typeof bindingJson !== "string") return false;
  const binding = await FlowBinding.restore(parseJsonOrNull(bindingJson));
  return binding.ok && viewerMayRead(viewer, binding.value.flowLabel);
}

type CaseSummary = Omit<CaseTimelineCase, keyof CaseName> &
  Readonly<{
    /** The title an open trigger or commerce proposal of the Case shows. */
    recordTitle: string | null;
  }>;

/**
 * A chat or side Case name decides the title. Only a Case with neither takes
 * the title one of its open records shows.
 */
function withRecordTitle(
  name: CaseName | undefined,
  recordTitle: string | null,
): CaseName {
  return name ?? { title: recordTitle, sideCaseOf: null };
}

/**
 * One Case's projection, read to its end, as one summary. A Case that this
 * person can no longer open gives none. A projection that changes between
 * pages is read once more from the start.
 */
async function readCase(
  env: Env,
  scope: ConversationScope,
  ref: CaseExecutionCaseRef,
): Promise<CaseSummary | null | "unavailable"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nodes: CaseExecutionNode[] = [];
    let cursor: string | null = null;
    let changed = false;
    for (let page = 0; page < MAX_TIMELINE_PAGES; page += 1) {
      const read = await readCaseExecutionPage(env, scope, {
        caseId: ref.caseId,
        cursor,
        limit: MAX_CASE_EXECUTION_PAGE,
      });
      if (!read.ok) {
        if (read.error.code === "case_execution_not_found") return null;
        if (read.error.code === "case_execution_changed") {
          changed = true;
          break;
        }
        return "unavailable";
      }
      nodes.push(...read.value.nodes);
      cursor = read.value.nextCursor;
      if (cursor === null) break;
    }
    if (!changed) return summariseCase(ref, nodes);
  }
  return "unavailable";
}

/** One Case's summary from the nodes of its projection that one person read. */
function summariseCase(
  ref: CaseExecutionCaseRef,
  nodes: readonly CaseExecutionNode[],
): CaseSummary {
  const open = nodes.filter(
    (node): node is OpenCaseExecutionNode => node.access === "open",
  );
  const of = <Kind extends OpenCaseExecutionNode["kind"]>(kind: Kind) =>
    open.filter((node): node is OpenNode<Kind> => node.kind === kind);
  const triggers = of("trigger");
  const assignments = of("assignment");
  const turns = of("turn");
  const tools = of("tool_operation");
  const proposals = of("proposal");
  const approvals = of("approval");
  const effects = of("effect");
  const deliveries = of("delivery");

  const times: number[] = [ref.filedAt];
  for (const node of open) {
    const at = nodeTime(node);
    if (at !== null) times.push(at);
  }
  const startedAt = Math.min(...times);
  const trigger = earliest(triggers, (node) => node.acceptedAt);
  const titled = earliest(
    triggers.filter((node) => node.title !== null),
    (node) => node.acceptedAt,
  );
  const commerceTitled = earliest(
    proposals.filter(
      (node) => node.proposalKind === "commerce_action" && node.title !== null,
    ),
    (node) => node.recordedAt ?? Number.MAX_SAFE_INTEGER,
  );
  const source = {
    at: trigger?.acceptedAt ?? ref.filedAt,
    trigger: trigger?.source ?? null,
  };
  // The coordinator leads the Case; another role stands in when it is absent.
  const lead =
    earliest(
      assignments.filter((node) => node.role === "coordinator"),
      (node) => node.startedAt ?? Number.MAX_SAFE_INTEGER,
    ) ??
    earliest(assignments, (node) => node.startedAt ?? Number.MAX_SAFE_INTEGER);
  const agent =
    lead === null
      ? null
      : {
          at: Math.max(lead.startedAt ?? source.at, source.at),
          role: lead.role,
          state: lead.state,
        };
  let memories = 0;
  const contextTimes: number[] = [];
  for (const turn of turns) {
    if (turn.memory.kind === "admitted" || turn.memory.kind === "limited") {
      memories += turn.memory.revisions;
      if (turn.startedAt !== null) contextTimes.push(turn.startedAt);
    }
  }
  const reads = tools.filter((node) => node.authority === "read");
  for (const read of reads) contextTimes.push(read.startedAt);
  const context =
    memories + reads.length === 0
      ? null
      : {
          at: Math.max(
            contextTimes.length === 0
              ? (agent?.at ?? source.at)
              : Math.min(...contextTimes),
            agent?.at ?? source.at,
          ),
          memories,
          reads: reads.length,
        };
  return {
    caseId: ref.caseId,
    origin: ref.origin,
    startedAt,
    source,
    agent,
    context,
    spans: spansOf(assignments, approvals, proposals),
    outcome: outcomeOf({
      assignments,
      turns,
      tools,
      proposals,
      approvals,
      effects,
      deliveries,
    }),
    receipt: effects.some((effect) => effect.receipt !== null),
    withheld: nodes.length - open.length,
    recordTitle: titled?.title ?? commerceTitled?.title ?? null,
  };
}

/**
 * What came of the Case so far. A decision that waits comes first, because
 * it is what a person must act on; then a failure; then work in progress;
 * then the strongest settled result.
 */
function outcomeOf(parts: {
  assignments: readonly OpenNode<"assignment">[];
  turns: readonly OpenNode<"turn">[];
  tools: readonly OpenNode<"tool_operation">[];
  proposals: readonly OpenNode<"proposal">[];
  approvals: readonly OpenNode<"approval">[];
  effects: readonly OpenNode<"effect">[];
  deliveries: readonly OpenNode<"delivery">[];
}): CaseTimelineCase["outcome"] {
  const waiting = earliest(
    parts.approvals.filter((node) => node.state === "waiting"),
    (node) => node.requestedAt,
  );
  if (waiting !== null) return { kind: "waiting", at: waiting.requestedAt };
  const draft = earliest(
    parts.proposals.filter(
      (node) => node.state === "awaiting_approval" && node.recordedAt !== null,
    ),
    (node) => node.recordedAt ?? 0,
  );
  if (draft?.recordedAt != null)
    return { kind: "waiting", at: draft.recordedAt };
  const failures: number[] = [];
  for (const node of parts.assignments)
    if (node.state === "failed" || node.state === "budget_exhausted")
      failures.push(node.settledAt ?? node.startedAt ?? 0);
  for (const node of parts.effects)
    if (node.state === "failed" || node.state === "expired")
      failures.push(node.updatedAt);
  for (const node of parts.turns)
    if (node.state === "failed" && node.startedAt !== null)
      failures.push(node.startedAt);
  if (failures.length > 0) return { kind: "failed", at: Math.max(...failures) };
  const running =
    parts.assignments.some(
      (node) => node.state === "assigned" || node.state === "running",
    ) ||
    parts.turns.some((node) => node.state === "running") ||
    parts.tools.some((node) => node.state === "started");
  if (running) {
    const at = Math.max(
      0,
      ...parts.assignments.map((node) => node.startedAt ?? 0),
      ...parts.turns.map((node) => node.startedAt ?? 0),
      ...parts.tools.map((node) => node.startedAt),
    );
    return { kind: "running", at };
  }
  const rejected = latest(
    parts.approvals.filter(
      (node) => node.state === "rejected" && node.decidedAt !== null,
    ),
    (node) => node.decidedAt ?? 0,
  );
  const approved = latest(
    parts.approvals.filter(
      (node) => node.state === "approved" && node.decidedAt !== null,
    ),
    (node) => node.decidedAt ?? 0,
  );
  if (
    rejected !== null &&
    (approved === null || (rejected.decidedAt ?? 0) > (approved.decidedAt ?? 0))
  )
    return { kind: "rejected", at: rejected.decidedAt ?? 0 };
  const receipt = latest(
    parts.effects.filter(
      (node) => node.state === "confirmed" && node.receipt !== null,
    ),
    (node) => node.receipt?.observedAt ?? 0,
  );
  if (receipt?.receipt)
    return { kind: "receipt", at: receipt.receipt.observedAt };
  if (approved !== null)
    return { kind: "approved", at: approved.decidedAt ?? 0 };
  const delivered = latest(
    parts.deliveries.filter((node) => node.receipt !== null),
    (node) => node.receipt?.deliveredAt ?? 0,
  );
  if (delivered?.receipt)
    return { kind: "delivered", at: delivered.receipt.deliveredAt };
  const done = latest(
    parts.assignments.filter(
      (node) => node.state === "completed" && node.settledAt !== null,
    ),
    (node) => node.settledAt ?? 0,
  );
  if (done?.settledAt != null) return { kind: "done", at: done.settledAt };
  return null;
}

/**
 * Who held the Case and when: each assignment while its agent worked, and
 * each approval while a person had to decide. A draft that waits for a
 * person without an approval record counts from when it was recorded.
 * Overlapping stretches of one holder join.
 */
function spansOf(
  assignments: readonly OpenNode<"assignment">[],
  approvals: readonly OpenNode<"approval">[],
  proposals: readonly OpenNode<"proposal">[],
): readonly CaseTimelineSpan[] {
  const spans: CaseTimelineSpan[] = [];
  for (const node of assignments) {
    if (node.startedAt === null) continue;
    const working = node.state === "assigned" || node.state === "running";
    spans.push({
      holder: "agent",
      from: node.startedAt,
      to: working
        ? null
        : Math.max(node.settledAt ?? node.startedAt, node.startedAt),
    });
  }
  for (const node of approvals)
    spans.push({
      holder: "person",
      from: node.requestedAt,
      to:
        node.state === "waiting"
          ? null
          : Math.max(node.decidedAt ?? node.requestedAt, node.requestedAt),
    });
  if (approvals.length === 0)
    for (const node of proposals)
      if (node.state === "awaiting_approval" && node.recordedAt !== null)
        spans.push({ holder: "person", from: node.recordedAt, to: null });
  spans.sort((left, right) => left.from - right.from);
  const joined: CaseTimelineSpan[] = [];
  for (const span of spans) {
    const index = joined.findLastIndex((kept) => kept.holder === span.holder);
    const last = index === -1 ? undefined : joined[index];
    if (last !== undefined && (last.to === null || span.from <= last.to))
      joined[index] = {
        ...last,
        to:
          last.to === null || span.to === null
            ? null
            : Math.max(last.to, span.to),
      };
    else joined.push(span);
  }
  return joined.slice(0, MAX_CASE_TIMELINE_SPANS);
}

function nodeTime(node: OpenCaseExecutionNode): number | null {
  switch (node.kind) {
    case "trigger":
      return node.acceptedAt;
    case "assignment":
    case "turn":
      return node.startedAt;
    case "attempt":
    case "tool_operation":
      return node.startedAt;
    case "proposal":
      return node.recordedAt;
    case "approval":
      return node.requestedAt;
    case "effect":
      return node.recordedAt;
    case "delivery":
      return node.addressedAt;
    default:
      return assertNever(node);
  }
}

function earliest<Item>(
  items: readonly Item[],
  time: (item: Item) => number,
): Item | null {
  let best: Item | null = null;
  for (const item of items)
    if (best === null || time(item) < time(best)) best = item;
  return best;
}

function latest<Item>(
  items: readonly Item[],
  time: (item: Item) => number,
): Item | null {
  let best: Item | null = null;
  for (const item of items)
    if (best === null || time(item) > time(best)) best = item;
  return best;
}

function failure(
  code: CaseExecutionReadError["code"],
): Result<never, CaseExecutionReadError> {
  return { ok: false, error: { code } };
}
