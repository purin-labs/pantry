/**
 * Plan 84: the content of a recipe's shared draft, without Yjs. The compile and
 * the Worker read this shape, and only the room and the page hold a document.
 */
export const DRAFT_BOUNDS = Object.freeze({
  minX: 0,
  maxX: 8000,
  minY: 0,
  maxY: 4000,
});

export type DraftNode = Readonly<{
  workflow: string;
  key: string;
  label: string;
  /** Places a task in its workflow. A new step takes the next number. */
  order: number;
  /** The task without its key and prerequisites. The compile checks it. */
  body: Readonly<Record<string, unknown>>;
}>;
export type DraftEdge = Readonly<{
  workflow: string;
  from: string;
  to: string;
  order: number;
  branch: "accept" | "reject" | null;
}>;
export type DraftPosition = Readonly<{ x: number; y: number }>;
export type DraftSnapshot = Readonly<{
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  positions: Readonly<Record<string, DraftPosition>>;
}>;

/** The part of a draft that one approved change writes, as one update. */
export type DraftChangeSet = Readonly<{
  put: readonly DraftNode[];
  remove: readonly Readonly<{ workflow: string; key: string }>[];
  putEdges: readonly DraftEdge[];
  removeEdges: readonly Readonly<{
    workflow: string;
    from: string;
    to: string;
  }>[];
  positions: Readonly<Record<string, DraftPosition>>;
  /**
   * Steps that the approved layout moves to make room. A step moves only while it
   * still stands where the base layout put it, so a person's own arrangement stays.
   */
  moves: Readonly<
    Record<string, Readonly<{ from: DraftPosition; to: DraftPosition }>>
  >;
}>;

export function draftNodeId(workflow: string, key: string): string {
  return `${workflow}/${key}`;
}

export function draftEdgeId(
  workflow: string,
  from: string,
  to: string,
): string {
  return `${workflow}/${from}>${to}`;
}
