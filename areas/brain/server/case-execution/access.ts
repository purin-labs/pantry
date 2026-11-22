import {
  MAX_CASE_EXECUTION_CASES,
  MAX_CASE_EXECUTION_CONTENT_LENGTH,
  MAX_CASE_EXECUTION_PAGE,
  parseCaseExecutionNode,
} from "@purin-labs/control-api";
import type {
  CaseExecutionCaseRef,
  CaseExecutionContent,
  CaseExecutionEdge,
  CaseExecutionLimitation,
  CaseExecutionNode,
  CaseExecutionNodeDetail,
  CaseExecutionPage,
  OpenCaseExecutionNode,
} from "@purin-labs/control-api";
import { isConversationId } from "@purin-labs/control-api";
import {
  decodeBase64Url,
  isNonNegativeInteger,
  isRecord,
  isSha256Hex,
  parseJsonOrNull,
} from "@purin-labs/std";

import {
  findActiveCaseActorAtScope,
  findActiveOrganisationActorAtScope,
  findActiveSessionActorAtScope,
} from "@purin-labs/actor-runtime/actors/actor-router";
import {
  authorizeConversation,
  VISIBLE_CONVERSATIONS_SQL,
} from "@purin-labs/conversation/chat/conversation-access";
import {
  conversationCaseId,
  parseConversationActorIdentity,
} from "@purin-labs/conversation/chat/conversation-actor-identity";
import type { AuthorizedConversationScope as ConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import type { Env } from "@purin-labs/kernel/env";
import type { CaseActorStub, OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { parseCaseId, parseSessionId, type CaseId } from "@purin-labs/kernel/ids";
import {
  resolveMemoryViewer,
  viewerMayRead,
  type MemoryViewer,
} from "../memory/access";
import { FlowLabel } from "@purin-labs/authority/policy/information-flow/index";
import type { Result } from "@purin-labs/kernel/result";
import {
  projectCaseRecords,
  projectSessionRecords,
  type ProjectedEdge,
  type ProjectedGuard,
  type ProjectedNode,
  type ProjectedPart,
} from "./projection";
import type {
  CaseAssignmentRecord,
  CaseExecutionCaseRecords,
  CaseExecutionSessionRecords,
  CaseExecutionStoredContent,
} from "@purin-labs/agent/case-execution/records";

export type CaseExecutionReadError = Readonly<{
  code:
    | "case_execution_unavailable"
    | "case_execution_not_found"
    | "case_execution_cursor_invalid"
    | "case_execution_changed";
}>;

/** How many Sessions one page read asks. Each is one Actor call. */
const MAX_SESSION_READS = 6;
const CASE_NODE_ID = /^c\.[0-9a-f]{24}$/u;
const SESSION_NODE_ID = /^s([0-9a-f]{12})\.[0-9a-f]{24}$/u;

type Cursor = Readonly<{ basis: string }> &
  (
    | Readonly<{ phase: "case"; offset: number; index?: never; part?: never }>
    | Readonly<{
        phase: "session";
        index: number;
        offset: number;
        /** The digest of the Session part that a page inside it was cut from. */
        part?: string;
      }>
  );

/**
 * The Cases this person may know of, newest first, for the list that links to
 * each Case's execution: a chat the person can open, and each other Case of
 * the Organisation, whatever its Project (Plan 27C). A Case is named by its
 * identity, its origin and the time it was filed. Its title and its content
 * belong to its own records, and a Case from a private source shows them
 * only to its people.
 */
export async function listCaseExecutionCases(
  env: Env,
  scope: ConversationScope,
  /** Only these Cases, when given; the newest Cases otherwise. */
  only?: readonly string[],
): Promise<Result<readonly CaseExecutionCaseRef[], CaseExecutionReadError>> {
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("case_execution_not_found");
  if (only !== undefined && only.length === 0) return { ok: true, value: [] };
  const named =
    only === undefined
      ? ""
      : `AND cp.case_id IN (${only.map(() => "?").join(", ")})`;
  const rows = await viewer.execution.database
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
       SELECT cp.case_id, cp.origin_kind, cp.updated_at
       FROM case_project cp
       LEFT JOIN portal_conversation c
         ON c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id
       WHERE cp.organisation_id = ?
         AND (c.conversation_id IS NULL
           OR c.conversation_id IN (SELECT conversation_id FROM visible_conversation))
         ${named}
       ORDER BY cp.updated_at DESC, cp.case_id
       LIMIT ?`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      scope.organisationId,
      ...(only ?? []),
      only === undefined ? MAX_CASE_EXECUTION_CASES : only.length,
    )
    .all<Record<string, unknown>>();
  const cases: CaseExecutionCaseRef[] = [];
  for (const row of rows.results)
    if (
      typeof row.case_id === "string" &&
      typeof row.origin_kind === "string" &&
      isNonNegativeInteger(row.updated_at)
    )
      cases.push({
        caseId: row.case_id,
        origin: row.origin_kind,
        filedAt: row.updated_at,
      });
  return { ok: true, value: cases };
}

/**
 * One page of a Case's execution projection for this person.
 *
 * The first pages carry what the Case and the action ledger record. The
 * later pages carry what each assignment's Session records, one assignment
 * after another. A node whose stored labels this person may not read is
 * returned withheld. The cursor names the records the first pages were
 * projected from: when those have changed, the read is refused and the
 * reader starts again.
 */
export async function readCaseExecutionPage(
  env: Env,
  scope: ConversationScope,
  input: Readonly<{ caseId: string; cursor: string | null; limit: number }>,
): Promise<Result<CaseExecutionPage, CaseExecutionReadError>> {
  const opened = await openCaseExecution(env, scope, input.caseId);
  if (!opened.ok) return opened;
  const { records, part, basis, ids, presented } = opened.value;
  const cursor: Cursor | null =
    input.cursor === null
      ? { basis, phase: "case", offset: 0 }
      : decodeCursor(input.cursor);
  if (cursor === null) return failure("case_execution_cursor_invalid");
  if (cursor.basis !== basis) return failure("case_execution_changed");
  const limit = Math.min(
    Math.max(Math.trunc(input.limit), 1),
    MAX_CASE_EXECUTION_PAGE,
  );
  const nodes: CaseExecutionNode[] = [];
  const edges: CaseExecutionEdge[] = [];
  const limitations = new Set<CaseExecutionLimitation>();
  let next: Cursor | null = null;
  const assignments = records.assignments;

  if (cursor.phase === "case") {
    const page = slicePart(part, cursor.offset, limit);
    for (const limitation of part.limitations) limitations.add(limitation);
    if (opened.value.invalidRecord) limitations.add("record_invalid");
    for (const node of page.nodes) {
      const shown = presented.get(node.key);
      if (shown === undefined)
        throw new Error("case_execution_projection_invalid");
      nodes.push(shown);
      // A limitation that says what kind of record a node is goes only to a
      // reader who sees the node.
      if (shown.access === "open")
        for (const limitation of node.limitations ?? [])
          limitations.add(limitation);
    }
    for (const edge of page.edges)
      edges.push({
        from: requireId(ids, edge.from),
        to: requireId(ids, edge.to),
        basis: edge.basis,
      });
    const end = cursor.offset + page.nodes.length;
    next =
      end < part.nodes.length
        ? { basis, phase: "case", offset: end }
        : assignments.length > 0
          ? { basis, phase: "session", index: 0, offset: 0 }
          : null;
  } else {
    let index = cursor.index;
    let offset = cursor.offset;
    for (
      let reads = 0;
      index < assignments.length &&
      nodes.length < limit &&
      reads < MAX_SESSION_READS;
      reads += 1
    ) {
      const assignment = assignments[index];
      if (assignment === undefined) break;
      const session = await projectAssignment(
        opened.value,
        assignment,
        offset,
        limit - nodes.length,
      );
      // A page inside a Session was cut from the Session as it then was. A
      // Session that has changed since gives a different list, so the read
      // is refused and the reader starts again.
      if (
        index === cursor.index &&
        offset === cursor.offset &&
        offset > 0 &&
        cursor.part !== session.digest
      )
        return failure("case_execution_changed");
      for (const limitation of session.limitations) limitations.add(limitation);
      for (const node of session.nodes) nodes.push(node);
      for (const edge of session.edges) edges.push(edge);
      if (session.remaining) {
        next = {
          basis,
          phase: "session",
          index,
          offset: offset + session.nodes.length,
          part: session.digest,
        };
        break;
      }
      index += 1;
      offset = 0;
      next =
        index < assignments.length
          ? { basis, phase: "session", index, offset: 0 }
          : null;
    }
  }
  return {
    ok: true,
    value: {
      caseId: records.caseId,
      basis,
      nodes,
      edges,
      limitations: [...limitations],
      nextCursor: next === null ? null : encodeCursor(next),
    },
  };
}

/**
 * The stored content behind one node, for a person who may read it. A node
 * that is withheld from this person and a node that does not exist give the
 * same answer.
 */
export async function readCaseExecutionNodeDetail(
  env: Env,
  scope: ConversationScope,
  input: Readonly<{ caseId: string; nodeId: string }>,
): Promise<Result<CaseExecutionNodeDetail, CaseExecutionReadError>> {
  const opened = await openCaseExecution(env, scope, input.caseId);
  if (!opened.ok) return opened;
  const { records, part, ids, key } = opened.value;
  let found: Readonly<{
    node: ProjectedNode;
    shown: CaseExecutionNode;
  }> | null = null;
  if (CASE_NODE_ID.test(input.nodeId)) {
    const node = part.nodes.find(
      (candidate) => ids.get(candidate.key) === input.nodeId,
    );
    const shown =
      node === undefined ? undefined : opened.value.presented.get(node.key);
    if (node !== undefined && shown !== undefined) found = { node, shown };
  } else {
    const prefix = SESSION_NODE_ID.exec(input.nodeId)?.[1];
    if (prefix === undefined) return failure("case_execution_not_found");
    for (const assignment of records.assignments) {
      if (
        (await assignmentDigest(
          key,
          records.caseId,
          assignment.assignmentId,
        )) !== prefix
      )
        continue;
      const session = await presentSession(
        opened.value,
        assignment,
        projectSessionRecords(
          records,
          assignment,
          await readSession(opened.value, assignment),
        ),
      );
      for (const node of session.part.nodes) {
        const shown = session.presented.get(node.key);
        if (shown !== undefined && shown.nodeId === input.nodeId)
          found = { node, shown };
      }
    }
  }
  if (found === null) return failure("case_execution_not_found");
  const presented = found.shown;
  if (presented.access !== "open") return failure("case_execution_not_found");
  const stored = await readContent(opened.value, found.node);
  if (stored === null) return failure("case_execution_unavailable");
  return {
    ok: true,
    value: {
      caseId: records.caseId,
      node: presented,
      content: stored.map(boundContent),
      context: found.node.context.map((entry) => ({
        entryId: entry.entryId,
        producer:
          entry.producer === null ? null : (ids.get(entry.producer) ?? null),
      })),
    },
  };
}

type OpenedCase = Readonly<{
  env: Env;
  viewer: MemoryViewer;
  caseId: CaseId;
  caseActor: CaseActorStub;
  records: CaseExecutionCaseRecords;
  part: ProjectedPart;
  basis: string;
  /** The key that node identities and digests are made with. */
  key: CryptoKey;
  /** The node identity of every Case-level node, by its record key. */
  ids: ReadonlyMap<string, string>;
  /** Every Case-level node as this person sees it, by its record key. */
  presented: ReadonlyMap<string, CaseExecutionNode>;
  /** A Case-level record did not fit the contract. */
  invalidRecord: boolean;
  reader: ExecutionReader;
}>;

/**
 * Opens a Case for one person. The person needs the live context capability.
 * A Case that a chat presents follows the chat's own access, and its Actor is
 * the one the chat's stored address names. Any other Case must be filed in a
 * Project the person can read. A Case that fails any of these answers as a
 * missing one.
 */
async function openCaseExecution(
  env: Env,
  scope: ConversationScope,
  rawCaseId: string,
): Promise<Result<OpenedCase, CaseExecutionReadError>> {
  const viewer = await resolveMemoryViewer(env, scope);
  if (viewer === null) return failure("case_execution_not_found");
  const caseId = parseCaseId(rawCaseId);
  if (!caseId.ok) return failure("case_execution_not_found");
  const key = await executionKey(env);
  if (key === null) return failure("case_execution_unavailable");
  const db = viewer.execution.database;
  const placed = await db
    .prepare(
      `SELECT c.conversation_id,
         json_extract(c.state_json, '$.actorIdentity') AS actor_identity
       FROM case_project cp
       LEFT JOIN portal_conversation c
         ON c.organisation_id = cp.organisation_id AND c.case_id = cp.case_id
       WHERE cp.organisation_id = ? AND cp.case_id = ?`,
    )
    .bind(scope.organisationId, caseId.value)
    .first<Record<string, unknown>>();
  if (placed === null) return failure("case_execution_not_found");
  let actorCaseId: CaseId = caseId.value;
  // A chat is read by those who may open it. Any other Case belongs to the
  // whole Organisation, whatever its Project (Plan 27C).
  if (placed.conversation_id !== null) {
    if (
      !isConversationId(placed.conversation_id) ||
      (await authorizeConversation(db, scope, placed.conversation_id)) === null
    )
      return failure("case_execution_not_found");
    try {
      actorCaseId = await conversationCaseId(
        parseConversationActorIdentity(
          placed.actor_identity,
          scope.organisationId,
        ),
      );
    } catch {
      return failure("case_execution_not_found");
    }
  }
  // Nothing is created for a read: a Case with no active Actor is absent.
  const caseActor = await findActiveCaseActorAtScope({
    scope: viewer.execution,
    namespace: env.CASE,
    caseId: actorCaseId,
  });
  if (caseActor === null) return failure("case_execution_not_found");
  let stored: CaseExecutionCaseRecords | null;
  try {
    stored = await caseActor.readExecutionRecords();
  } catch {
    return failure("case_execution_unavailable");
  }
  if (stored === null || stored.caseId !== actorCaseId)
    return failure("case_execution_not_found");
  // The ledger is read from the Organisation Actor the registry lists as
  // active. None is reserved or activated for a read. Without one, the
  // effects are absent and the page says so.
  let ledger: Awaited<
    ReturnType<OrganisationActorStub["readCaseExecutionEffects"]>
  > | null = null;
  try {
    const organisation = await findActiveOrganisationActorAtScope({
      scope: viewer.execution,
      namespace: env.ORGANISATION,
    });
    ledger =
      organisation === null
        ? null
        : await organisation.readCaseExecutionEffects({
            organisationId: scope.organisationId,
            caseId: actorCaseId,
          });
  } catch {
    ledger = null;
  }
  // The projection names the Case as the reader does.
  const records: CaseExecutionCaseRecords = {
    ...stored,
    caseId: caseId.value,
    truncated: stored.truncated || ledger?.truncated === true,
  };
  const part = projectCaseRecords(records, ledger?.effects ?? null);
  const ids = new Map<string, string>();
  for (const node of part.nodes)
    ids.set(node.key, await nodeIdOf(key, records.caseId, node.key, null));
  const reader = new ExecutionReader(viewer);
  const open = await openKeys(reader, part, new Set());
  // A Case from a private source is absent for a person outside it: each
  // trigger that started it is withheld from them.
  const triggers = part.nodes.filter((node) => node.fields.kind === "trigger");
  if (triggers.length > 0 && !triggers.some((node) => open.has(node.key)))
    return failure("case_execution_not_found");
  const presented = new Map<string, CaseExecutionNode>();
  for (const node of part.nodes)
    presented.set(
      node.key,
      present(node, requireId(ids, node.key), open.has(node.key)),
    );
  // The basis is made from what this person sees, with a key. A change to a
  // record that is withheld from them does not change it, and it cannot be
  // tested against a guess of a withheld value.
  const basis = await keyedHex(
    key,
    JSON.stringify([
      "basis",
      records.caseId,
      part.nodes.map((node) => presented.get(node.key)),
      part.edges.map((edge) => [
        ids.get(edge.from),
        ids.get(edge.to),
        edge.basis,
      ]),
    ]),
  );
  return {
    ok: true,
    value: {
      env,
      viewer,
      caseId: caseId.value,
      caseActor,
      records,
      part,
      basis,
      key,
      ids,
      presented,
      invalidRecord: hasInvalidRecord(part, open, presented),
      reader,
    },
  };
}

/**
 * The nodes of a part that one person sees. A node is open when the person
 * may read its own labels and sees every node it came from: the source of
 * each of its edges, and each node it inherits from. So nothing is open
 * below a node that is withheld. `known` holds the open nodes of the Case
 * part, for a Session part whose nodes hang from them.
 */
async function openKeys(
  reader: ExecutionReader,
  part: ProjectedPart,
  known: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const own = new Set<string>();
  for (const node of part.nodes)
    if (await reader.mayRead(node.guard)) own.add(node.key);
  const inPart = new Set(part.nodes.map((node) => node.key));
  const sources = new Map<string, string[]>();
  for (const node of part.nodes)
    sources.set(node.key, [...(node.inherits ?? [])]);
  for (const edge of part.edges) sources.get(edge.to)?.push(edge.from);
  const open = new Set(own);
  for (let changed = true; changed;) {
    changed = false;
    for (const nodeKey of [...open])
      for (const source of sources.get(nodeKey) ?? [])
        if (inPart.has(source) ? !open.has(source) : !known.has(source)) {
          open.delete(nodeKey);
          changed = true;
          break;
        }
  }
  return open;
}

function present(
  node: ProjectedNode,
  nodeId: string,
  open: boolean,
): CaseExecutionNode {
  const withheld = {
    nodeId,
    kind: node.fields.kind,
    access: "withheld",
  } as const;
  if (!open) return withheld;
  // A stored value that does not fit the contract would make the reader's
  // parser refuse the whole page. Such a node is shown with its kind only.
  const shown = openNode(node, nodeId);
  return parseCaseExecutionNode(shown) === null ? withheld : shown;
}

/** True when an open node of this part had to be shown with its kind only. */
function hasInvalidRecord(
  part: ProjectedPart,
  open: ReadonlySet<string>,
  presented: ReadonlyMap<string, CaseExecutionNode>,
): boolean {
  return part.nodes.some(
    (node) =>
      open.has(node.key) && presented.get(node.key)?.access === "withheld",
  );
}

/** Decides each node for one reader. A label is decided once per read. */
class ExecutionReader {
  private readonly decisions = new Map<string, Promise<boolean>>();

  constructor(private readonly viewer: MemoryViewer) {}

  async mayRead(guard: ProjectedGuard): Promise<boolean> {
    switch (guard.kind) {
      case "unlabelled":
        return false;
      // A mailbox belongs to the whole Organisation, so its reply proposals
      // show to each member (Plan 27C).
      case "mail":
        return true;
      case "labels":
        for (const label of guard.labels)
          if (!(await this.decide(label))) return false;
        return true;
      default:
        return false;
    }
  }

  private decide(labelJson: string): Promise<boolean> {
    const known = this.decisions.get(labelJson);
    if (known !== undefined) return known;
    const decision = this.read(labelJson);
    this.decisions.set(labelJson, decision);
    return decision;
  }

  private async read(labelJson: string): Promise<boolean> {
    const label = await FlowLabel.restore(parseJsonOrNull(labelJson));
    return (
      label.ok && (await viewerMayRead(this.viewer, label.value))
    );
  }
}

function openNode(node: ProjectedNode, nodeId: string): OpenCaseExecutionNode {
  return { ...node.fields, nodeId, access: "open" };
}

type AssignmentPage = Readonly<{
  nodes: readonly CaseExecutionNode[];
  edges: readonly CaseExecutionEdge[];
  limitations: readonly CaseExecutionLimitation[];
  /** True when the Session holds more nodes after this page. */
  remaining: boolean;
  /** A keyed digest of the whole Session part this page was cut from. */
  digest: string;
}>;

type PresentedSession = Readonly<{
  part: ProjectedPart;
  ids: ReadonlyMap<string, string>;
  presented: ReadonlyMap<string, CaseExecutionNode>;
  invalidRecord: boolean;
}>;

/** One assignment's Session part as this person sees it. */
async function presentSession(
  opened: OpenedCase,
  assignment: CaseAssignmentRecord,
  part: ProjectedPart,
): Promise<PresentedSession> {
  const ids = new Map<string, string>();
  for (const node of part.nodes)
    ids.set(
      node.key,
      await nodeIdOf(
        opened.key,
        opened.records.caseId,
        node.key,
        assignment.assignmentId,
      ),
    );
  // The open nodes of the Case part: a turn is open only below an open
  // assignment.
  const known = new Set<string>();
  for (const [nodeKey, shown] of opened.presented)
    if (shown.access === "open") known.add(nodeKey);
  const open = await openKeys(opened.reader, part, known);
  const presented = new Map<string, CaseExecutionNode>();
  for (const node of part.nodes)
    presented.set(
      node.key,
      present(node, requireId(ids, node.key), open.has(node.key)),
    );
  return {
    part,
    ids,
    presented,
    invalidRecord: hasInvalidRecord(part, open, presented),
  };
}

async function projectAssignment(
  opened: OpenedCase,
  assignment: CaseAssignmentRecord,
  offset: number,
  room: number,
): Promise<AssignmentPage> {
  const session = await presentSession(
    opened,
    assignment,
    projectSessionRecords(
      opened.records,
      assignment,
      await readSession(opened, assignment),
    ),
  );
  const { part, ids, presented } = session;
  const page = slicePart(part, offset, room);
  const limitations: CaseExecutionLimitation[] = [...part.limitations];
  if (session.invalidRecord) limitations.push("record_invalid");
  const idOf = (nodeKey: string): string | null =>
    ids.get(nodeKey) ?? opened.ids.get(nodeKey) ?? null;
  const nodes: CaseExecutionNode[] = [];
  for (const node of page.nodes) {
    const shown = presented.get(node.key);
    if (shown === undefined)
      throw new Error("case_execution_projection_invalid");
    nodes.push(shown);
  }
  const edges: CaseExecutionEdge[] = [];
  for (const edge of page.edges) {
    const from = idOf(edge.from);
    const to = idOf(edge.to);
    if (from !== null && to !== null)
      edges.push({ from, to, basis: edge.basis });
  }
  return {
    nodes,
    edges,
    limitations,
    remaining: offset + page.nodes.length < part.nodes.length,
    digest: await keyedHex(
      opened.key,
      JSON.stringify([
        "session",
        assignment.assignmentId,
        part.nodes.map((node) => [node.key, node.fields]),
        part.edges,
      ]),
    ),
  };
}

/**
 * The nodes of one page of a part, and the edges that belong to it. An edge
 * is returned once, on the page that carries the later of its two nodes. An
 * edge between two nodes of an earlier part goes on the first page.
 */
function slicePart(
  part: ProjectedPart,
  offset: number,
  room: number,
): Readonly<{
  nodes: readonly ProjectedNode[];
  edges: readonly ProjectedEdge[];
}> {
  const nodes = part.nodes.slice(offset, offset + room);
  const position = new Map<string, number>();
  part.nodes.forEach((node, index) => position.set(node.key, index));
  const end = offset + nodes.length;
  const edges = part.edges.filter((edge) => {
    const at = Math.max(
      position.get(edge.from) ?? -1,
      position.get(edge.to) ?? -1,
    );
    return at === -1 ? offset === 0 : at >= offset && at < end;
  });
  return { nodes, edges };
}

async function readSession(
  opened: OpenedCase,
  assignment: CaseAssignmentRecord,
): Promise<CaseExecutionSessionRecords | null> {
  const sessionId = parseSessionId(assignment.sessionId);
  if (!sessionId.ok) return null;
  try {
    // An assignment whose Session never started has no Actor. None is made.
    const session = await findActiveSessionActorAtScope({
      scope: opened.viewer.execution,
      namespace: opened.env.SESSION,
      sessionId: sessionId.value,
    });
    return session === null
      ? null
      : await session.actor.readExecutionRecords({
          organisationId: opened.viewer.organisationId,
          sessionId: sessionId.value,
        });
  } catch {
    return null;
  }
}

async function readContent(
  opened: OpenedCase,
  node: ProjectedNode,
): Promise<readonly CaseExecutionStoredContent[] | null> {
  const source = node.content;
  if (source === null) return [];
  try {
    if (source.owner === "case")
      return await opened.caseActor.readExecutionContent(source.target);
    const sessionId = parseSessionId(source.sessionId);
    if (!sessionId.ok) return null;
    const session = await findActiveSessionActorAtScope({
      scope: opened.viewer.execution,
      namespace: opened.env.SESSION,
      sessionId: sessionId.value,
    });
    return session === null
      ? null
      : await session.actor.readExecutionContent({
          organisationId: opened.viewer.organisationId,
          sessionId: sessionId.value,
          target: source.target,
        });
  } catch {
    return null;
  }
}

function boundContent(
  stored: CaseExecutionStoredContent,
): CaseExecutionContent {
  const truncated = stored.text.length > MAX_CASE_EXECUTION_CONTENT_LENGTH;
  return {
    role: stored.role,
    text: truncated
      ? stored.text.slice(0, MAX_CASE_EXECUTION_CONTENT_LENGTH)
      : stored.text,
    truncated,
  };
}

/**
 * The key for node identities, the basis and the Session digests. It is made
 * from a platform secret for this purpose alone. Stored identifiers often
 * follow from each other, so an identity made without a key could be
 * computed from a guess and compared. Null when the platform has no secret.
 */
async function executionKey(env: Env): Promise<CryptoKey | null> {
  const secret = env.SESSION_TOKEN_SECRET?.trim() ?? "";
  if (secret.length === 0) return null;
  const encoder = new TextEncoder();
  const hmac = { name: "HMAC", hash: "SHA-256" } as const;
  const root = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    hmac,
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    root,
    encoder.encode("pantry.case-execution.identity.v1"),
  );
  return crypto.subtle.importKey("raw", derived, hmac, false, ["sign"]);
}

async function keyedHex(key: CryptoKey, text: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  let hex = "";
  for (const byte of new Uint8Array(mac))
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A node identity names no stored identifier and cannot be computed from
 * one without the key. A Session-level node carries a prefix that selects
 * its assignment, so one detail read asks one Session.
 */
async function nodeIdOf(
  key: CryptoKey,
  caseId: string,
  nodeKey: string,
  assignmentId: string | null,
): Promise<string> {
  const record = (await keyedHex(key, `node\n${caseId}\n${nodeKey}`)).slice(
    0,
    24,
  );
  return assignmentId === null
    ? `c.${record}`
    : `s${await assignmentDigest(key, caseId, assignmentId)}.${record}`;
}

async function assignmentDigest(
  key: CryptoKey,
  caseId: string,
  assignmentId: string,
): Promise<string> {
  return (await keyedHex(key, `assignment\n${caseId}\n${assignmentId}`)).slice(
    0,
    12,
  );
}

function requireId(ids: ReadonlyMap<string, string>, nodeKey: string): string {
  const id = ids.get(nodeKey);
  if (id === undefined) throw new Error("case_execution_projection_invalid");
  return id;
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(raw: string): Cursor | null {
  const bytes = raw.length > 512 ? null : decodeBase64Url(raw);
  if (bytes === null) return null;
  // One character for each byte, as btoa in encodeCursor reads them.
  const parsed = parseJsonOrNull(String.fromCharCode(...bytes));
  if (
    !isRecord(parsed) ||
    typeof parsed.basis !== "string" ||
    !isNonNegativeInteger(parsed.offset)
  )
    return null;
  if (parsed.phase === "case")
    return { basis: parsed.basis, phase: "case", offset: parsed.offset };
  if (parsed.phase !== "session" || !isNonNegativeInteger(parsed.index))
    return null;
  if (parsed.part === undefined)
    return {
      basis: parsed.basis,
      phase: "session",
      index: parsed.index,
      offset: parsed.offset,
    };
  return isSha256Hex(parsed.part)
    ? {
        basis: parsed.basis,
        phase: "session",
        index: parsed.index,
        offset: parsed.offset,
        part: parsed.part,
      }
    : null;
}

function failure(
  code: CaseExecutionReadError["code"],
): Result<never, CaseExecutionReadError> {
  return { ok: false, error: { code } };
}
