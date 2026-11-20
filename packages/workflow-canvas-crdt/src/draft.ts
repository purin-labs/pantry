import * as Y from "yjs";
import {
  defineSharedEncoding,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
  type YjsEncodingKind,
} from "@purin-labs/collaboration";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  DRAFT_BOUNDS,
  draftEdgeId,
  draftNodeId,
  type DraftChangeSet,
  type DraftEdge,
  type DraftNode,
  type DraftPosition,
  type DraftSnapshot,
} from "./draft-shape.ts";

export * from "./draft-shape.ts";

/**
 * Plan 84: the shared draft of one recipe's workflow. The document owns its
 * membership, unlike the position document in `index.ts`. A person can add and
 * remove steps, and each entry is one whole value, so the later write wins for
 * one step. A draft may hold a cycle or a missing prerequisite. Only the compile
 * before a run or an apply refuses those.
 */
export const WORKFLOW_DRAFT_SCHEMA = "workflow_canvas_crdt.v2";
/** The largest recipe has 258 steps. */
export const DRAFT_OBJECT_LIMIT = 512;
export const DRAFT_LABEL_LIMIT = 200;
export const DRAFT_ENCODING_LIMITS = Object.freeze({
  state: 768 * 1024,
  update: 768 * 1024,
  stateVector: 64 * 1024,
});

const ROOTS = ["nodes", "edges", "positions"] as const;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/u;

/** The document's own failures, beside the failures of an encoding. */
const FAILURES = ["invalid_draft", "object_limit"] as const;
export type DraftFailureCode = SharedDocError<
  (typeof FAILURES)[number]
>["code"];
export type DraftResult<T> = SharedDocResult<T, DraftFailureCode>;

/**
 * The checked encodings of the draft. The document class below is its own:
 * its undo history needs one Yjs document for its whole life, so an edit and
 * an accepted update change that document in place.
 */
export const workflowDraftEncoding = defineSharedEncoding({
  schema: WORKFLOW_DRAFT_SCHEMA,
  limits: DRAFT_ENCODING_LIMITS,
  failures: FAILURES,
});

/** `DraftEncoding.parse(kind, bytes)` gives a checked encoding. */
export const DraftEncoding = workflowDraftEncoding.encoding;
export type DraftEncoding<K extends YjsEncodingKind> = SharedDocEncoding<
  K,
  typeof WORKFLOW_DRAFT_SCHEMA
>;

const LOCAL_EDIT = "local-edit";

export class WorkflowDraftDoc {
  readonly #doc: Y.Doc;
  readonly #undo: Y.UndoManager;

  private constructor(doc: Y.Doc) {
    this.#doc = doc;
    this.#undo = new Y.UndoManager(
      [doc.getMap("nodes"), doc.getMap("edges"), doc.getMap("positions")],
      { trackedOrigins: new Set([LOCAL_EDIT]), captureTimeout: 0 },
    );
  }

  static create(seed: DraftSnapshot): DraftResult<WorkflowDraftDoc> {
    const doc = emptyDocument();
    doc.transact(writeSeed.bind(null, doc, seed));
    const checked = checkDocument(doc);
    if (!checked.ok) {
      doc.destroy();
      return checked;
    }
    return success(new WorkflowDraftDoc(doc));
  }

  /** An empty replica that the first sync from a room fills. */
  static createReplica(): WorkflowDraftDoc {
    return new WorkflowDraftDoc(emptyDocument());
  }

  static restore(state: DraftEncoding<"state">): DraftResult<WorkflowDraftDoc> {
    const doc = emptyDocument();
    try {
      Y.applyUpdate(doc, state.encode());
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
    const checked = checkDocument(doc);
    if (!checked.ok) {
      doc.destroy();
      return checked;
    }
    return success(new WorkflowDraftDoc(doc));
  }

  snapshot(): DraftSnapshot {
    const nodes: DraftNode[] = [];
    const edges: DraftEdge[] = [];
    const positions: Record<string, DraftPosition> = {};
    for (const value of this.#doc.getMap("nodes").values())
      nodes.push(value as DraftNode);
    for (const value of this.#doc.getMap("edges").values())
      edges.push(value as DraftEdge);
    for (const [id, value] of this.#doc.getMap("positions").entries())
      positions[id] = value as DraftPosition;
    nodes.sort(byOrder);
    edges.sort(byOrder);
    return { nodes, edges, positions };
  }

  state(): DraftResult<DraftEncoding<"state">> {
    return DraftEncoding.parse("state", Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): DraftResult<DraftEncoding<"state_vector">> {
    return DraftEncoding.parse("state_vector", Y.encodeStateVector(this.#doc));
  }

  syncUpdate(
    vector: DraftEncoding<"state_vector">,
  ): DraftResult<DraftEncoding<"update">> {
    return DraftEncoding.parse(
      "update",
      Y.encodeStateAsUpdate(this.#doc, vector.encode()),
    );
  }

  /** A remote update must leave a valid document, or the draft stays as it was. */
  apply(update: DraftEncoding<"update">): DraftResult<null> {
    const candidate = emptyDocument();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.#doc));
      Y.applyUpdate(candidate, update.encode());
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    const checked = checkDocument(candidate);
    candidate.destroy();
    if (!checked.ok) return checked;
    Y.applyUpdate(this.#doc, update.encode());
    return success(null);
  }

  putNode(node: DraftNode): DraftResult<DraftEncoding<"update">> {
    if (!validNode(node)) return failure("invalid_draft");
    return this.#edit(writeNode.bind(null, this.#doc, node));
  }

  /** Removes the step, its position and each edge that touches it. */
  removeNode(
    workflow: string,
    key: string,
  ): DraftResult<DraftEncoding<"update">> {
    return this.#edit(deleteNode.bind(null, this.#doc, workflow, key));
  }

  putEdge(edge: DraftEdge): DraftResult<DraftEncoding<"update">> {
    if (!validEdge(edge)) return failure("invalid_draft");
    return this.#edit(writeEdge.bind(null, this.#doc, edge));
  }

  removeEdge(
    workflow: string,
    from: string,
    to: string,
  ): DraftResult<DraftEncoding<"update">> {
    return this.#edit(deleteEdge.bind(null, this.#doc, workflow, from, to));
  }

  /** An approved change from outside the room, which no person's undo reverses. */
  applyChangeSet(change: DraftChangeSet): DraftResult<DraftEncoding<"update">> {
    if (
      !change.put.every(validNode) ||
      !change.putEdges.every(validEdge) ||
      !Object.values(change.positions).every(validPosition) ||
      !Object.values(change.moves).every(validMove)
    )
      return failure("invalid_draft");
    return this.#delta(writeChangeSet.bind(null, this.#doc, change));
  }

  movePosition(
    id: string,
    position: DraftPosition,
  ): DraftResult<DraftEncoding<"update">> {
    if (!validPosition(position)) return failure("invalid_draft");
    return this.#edit(writePosition.bind(null, this.#doc, id, position));
  }

  canUndo(): boolean {
    return this.#undo.canUndo();
  }

  canRedo(): boolean {
    return this.#undo.canRedo();
  }

  undo(): DraftResult<DraftEncoding<"update">> {
    return this.#delta(this.#undo.undo.bind(this.#undo));
  }

  redo(): DraftResult<DraftEncoding<"update">> {
    return this.#delta(this.#undo.redo.bind(this.#undo));
  }

  destroy(): void {
    this.#undo.destroy();
    this.#doc.destroy();
  }

  #edit(change: () => void): DraftResult<DraftEncoding<"update">> {
    return this.#delta(this.#doc.transact.bind(this.#doc, change, LOCAL_EDIT));
  }

  #delta(change: () => unknown): DraftResult<DraftEncoding<"update">> {
    const vector = Y.encodeStateVector(this.#doc);
    change();
    const checked = checkDocument(this.#doc);
    if (!checked.ok) return checked;
    return DraftEncoding.parse(
      "update",
      Y.encodeStateAsUpdate(this.#doc, vector),
    );
  }
}

function emptyDocument(): Y.Doc {
  const doc = new Y.Doc();
  for (const root of ROOTS) doc.getMap(root);
  return doc;
}

function writeSeed(doc: Y.Doc, seed: DraftSnapshot): void {
  for (const node of seed.nodes) writeNode(doc, node);
  for (const edge of seed.edges) writeEdge(doc, edge);
  for (const [id, position] of Object.entries(seed.positions))
    writePosition(doc, id, position);
}

function writeChangeSet(doc: Y.Doc, change: DraftChangeSet): void {
  doc.transact(() => {
    for (const edge of change.removeEdges)
      deleteEdge(doc, edge.workflow, edge.from, edge.to);
    for (const node of change.remove) deleteNode(doc, node.workflow, node.key);
    for (const node of change.put) writeNode(doc, node);
    for (const edge of change.putEdges) writeEdge(doc, edge);
    for (const [id, position] of Object.entries(change.positions))
      writePosition(doc, id, position);
    const positions = doc.getMap("positions");
    for (const [id, move] of Object.entries(change.moves)) {
      const at = positions.get(id) as DraftPosition | undefined;
      if (at !== undefined && at.x === move.from.x && at.y === move.from.y)
        writePosition(doc, id, move.to);
    }
  });
}

function writeNode(doc: Y.Doc, node: DraftNode): void {
  doc.getMap("nodes").set(draftNodeId(node.workflow, node.key), node);
}

function writeEdge(doc: Y.Doc, edge: DraftEdge): void {
  doc.getMap("edges").set(draftEdgeId(edge.workflow, edge.from, edge.to), edge);
}

function writePosition(doc: Y.Doc, id: string, position: DraftPosition): void {
  doc.getMap("positions").set(id, position);
}

function deleteEdge(
  doc: Y.Doc,
  workflow: string,
  from: string,
  to: string,
): void {
  doc.getMap("edges").delete(draftEdgeId(workflow, from, to));
}

function deleteNode(doc: Y.Doc, workflow: string, key: string): void {
  const id = draftNodeId(workflow, key);
  doc.getMap("nodes").delete(id);
  doc.getMap("positions").delete(id);
  const edges = doc.getMap("edges");
  for (const [edgeId, raw] of [...edges.entries()]) {
    const edge = raw as DraftEdge;
    if (edge.workflow === workflow && (edge.from === key || edge.to === key))
      edges.delete(edgeId);
  }
}

function checkDocument(doc: Y.Doc): DraftResult<null> {
  if (doc.share.size !== ROOTS.length) return failure("invalid_draft");
  for (const root of ROOTS)
    if (!(doc.share.get(root) instanceof Y.Map))
      return failure("invalid_draft");
  const nodes = doc.getMap("nodes");
  if (nodes.size > DRAFT_OBJECT_LIMIT) return failure("object_limit");
  for (const [id, raw] of nodes.entries())
    if (!validNode(raw) || draftNodeId(raw.workflow, raw.key) !== id)
      return failure("invalid_draft");
  const edges = doc.getMap("edges");
  if (edges.size > DRAFT_OBJECT_LIMIT * 4) return failure("object_limit");
  for (const [id, raw] of edges.entries())
    if (!validEdge(raw) || draftEdgeId(raw.workflow, raw.from, raw.to) !== id)
      return failure("invalid_draft");
  for (const raw of doc.getMap("positions").values())
    if (!validPosition(raw)) return failure("invalid_draft");
  if (Y.encodeStateAsUpdate(doc).byteLength > DRAFT_ENCODING_LIMITS.state)
    return failure("state_too_large");
  return success(null);
}

function validNode(raw: unknown): raw is DraftNode {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["workflow", "key", "label", "order", "body"]) &&
    validIdentity(raw.workflow) &&
    validIdentity(raw.key) &&
    typeof raw.label === "string" &&
    raw.label.length > 0 &&
    raw.label.length <= DRAFT_LABEL_LIMIT &&
    Number.isSafeInteger(raw.order) &&
    isRecord(raw.body)
  );
}

function validEdge(raw: unknown): raw is DraftEdge {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["workflow", "from", "to", "order", "branch"]) &&
    validIdentity(raw.workflow) &&
    validIdentity(raw.from) &&
    validIdentity(raw.to) &&
    Number.isSafeInteger(raw.order) &&
    (raw.branch === null || raw.branch === "accept" || raw.branch === "reject")
  );
}

function validIdentity(raw: unknown): raw is string {
  return typeof raw === "string" && IDENTITY.test(raw);
}

function validPosition(raw: unknown): raw is DraftPosition {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["x", "y"]) &&
    typeof raw.x === "number" &&
    typeof raw.y === "number" &&
    Number.isFinite(raw.x) &&
    Number.isFinite(raw.y) &&
    raw.x >= DRAFT_BOUNDS.minX &&
    raw.x <= DRAFT_BOUNDS.maxX &&
    raw.y >= DRAFT_BOUNDS.minY &&
    raw.y <= DRAFT_BOUNDS.maxY
  );
}

function validMove(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["from", "to"]) &&
    validPosition(raw.from) &&
    validPosition(raw.to)
  );
}

function byOrder(
  left: Readonly<{ order: number }>,
  right: Readonly<{ order: number }>,
): number {
  return left.order - right.order;
}
