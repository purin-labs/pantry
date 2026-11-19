import type {
  CaseExecutionNode,
  CaseExecutionNodeKind,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type { CaseExecution } from "./execution-model";

/**
 * The places of the records of one Case on the Activity canvas.
 *
 * This module holds geometry only. It reads no network and no document, so a
 * journey can give it a recorded projection and check the result.
 *
 * - A column is a stage of the work. A recorded link always leads to a later
 *   column, so the canvas reads from cause to result.
 * - A lane is one assignment with the records that follow from it. Work that
 *   ran side by side is in lanes one below the other.
 * - Only recorded links place a record. Time places nothing.
 */
export type ExecutionStage =
  "request" | "assignment" | "work" | "proposal" | "decision" | "delivery";

export function stageLabel(stage: ExecutionStage): string {
  switch (stage) {
    case "request":
      return "Request";
    case "assignment":
      return "Assignment";
    case "work":
      return "Turn and tools";
    case "proposal":
      return "Proposal";
    case "decision":
      return "Approval and effect";
    case "delivery":
      return "Delivery";
    default:
      return assertNever(stage, "Unexpected value");
  }
}

/**
 * The slot of each kind inside one pass through the stages. Each recorded
 * link of one pass leads from a lower slot to a higher one. A link that does
 * not, such as a proposal that a later assignment was given, starts the next
 * pass.
 */
const KIND_SLOT: Readonly<Record<CaseExecutionNodeKind, number>> = {
  trigger: 0,
  assignment: 1,
  turn: 2,
  attempt: 3,
  tool_operation: 3,
  proposal: 4,
  approval: 5,
  effect: 6,
  delivery: 7,
};

const SLOT_STAGE: readonly ExecutionStage[] = [
  "request",
  "assignment",
  "work",
  "work",
  "proposal",
  "decision",
  "decision",
  "delivery",
];

const SLOTS = SLOT_STAGE.length;

export const EXECUTION_NODE_WIDTH = 232;
export const EXECUTION_NODE_HEIGHT = 68;
const COLUMN_GAP = 72;
const ROW_GAP = 14;
const LANE_GAP = 36;
const HEADING_HEIGHT = 36;
const PADDING = 28;
/** The greatest height over which a request sits between its lanes. */
const FAN_OUT_SPAN = 640;

export type LaidOutNode = Readonly<{
  node: CaseExecutionNode;
  x: number;
  y: number;
  /** The column, counted over the columns that hold a record. */
  column: number;
  /** The lane. The last lane holds what no link ties to an assignment. */
  lane: number;
}>;

export type ExecutionLane = Readonly<{
  lane: number;
  /** The assignment of the lane, or null for the records with none. */
  assignmentNodeId: string | null;
  top: number;
  height: number;
}>;

export type StageHeading = Readonly<{
  stage: ExecutionStage;
  x: number;
  width: number;
}>;

export type LaidOutEdge = Readonly<{
  /** Stable for the pair of places that the curve joins. */
  key: string;
  /** The records that the curve joins. A folded end names no record. */
  from: string | null;
  to: string | null;
  /** The curve from the right side of one record to the left of the other. */
  path: string;
}>;

/**
 * A long stack shows its first records and one control for the rest. The
 * control stands for records that exist. It is not a record.
 */
export type ExecutionFold = Readonly<{
  /** Names the stack: its lane and its column. */
  key: string;
  x: number;
  y: number;
  /** How many records the stack hides, or 0 when it shows them all. */
  hidden: number;
  /** The kind of the hidden records, when they share one. */
  kind: CaseExecutionNodeKind | null;
}>;

/** A stack longer than this is folded. */
export const EXECUTION_STACK_LIMIT = 6;

export type ExecutionLayout = Readonly<{
  width: number;
  height: number;
  nodes: readonly LaidOutNode[];
  lanes: readonly ExecutionLane[];
  headings: readonly StageHeading[];
  edges: readonly LaidOutEdge[];
  folds: readonly ExecutionFold[];
  /** For each hidden record, the fold that hides it. */
  foldOf: ReadonlyMap<string, string>;
}>;

const EMPTY_LAYOUT: ExecutionLayout = {
  width: 0,
  height: 0,
  nodes: [],
  lanes: [],
  headings: [],
  edges: [],
  folds: [],
  foldOf: new Map(),
};

/**
 * `unfolded` names the stacks that show each of their records. Every other
 * stack longer than the limit is folded.
 */
export function layoutExecution(
  execution: CaseExecution,
  unfolded: ReadonlySet<string> = new Set(),
): ExecutionLayout {
  if (execution.nodes.length === 0) return EMPTY_LAYOUT;
  const byId = new Map(execution.nodes.map((node) => [node.nodeId, node]));
  const incoming = new Map<string, CaseExecutionNode[]>();
  const outgoing = new Map<string, CaseExecutionNode[]>();
  for (const edge of execution.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    incoming.set(to.nodeId, [...(incoming.get(to.nodeId) ?? []), from]);
    outgoing.set(from.nodeId, [...(outgoing.get(from.nodeId) ?? []), to]);
  }

  // The pass of a record: how many times a link into it, or into a record
  // before it, went back to an earlier slot.
  const passOf = new Map<string, number>();
  const visiting = new Set<string>();
  const pass = (node: CaseExecutionNode): number => {
    const known = passOf.get(node.nodeId);
    if (known !== undefined) return known;
    // The records hold no cycle. A repeated visit would be one, so it stops.
    if (visiting.has(node.nodeId)) return 0;
    visiting.add(node.nodeId);
    let latest = 0;
    for (const source of incoming.get(node.nodeId) ?? [])
      latest = Math.max(
        latest,
        pass(source) + (KIND_SLOT[source.kind] >= KIND_SLOT[node.kind] ? 1 : 0),
      );
    visiting.delete(node.nodeId);
    passOf.set(node.nodeId, latest);
    return latest;
  };
  const slotOf = (node: CaseExecutionNode): number =>
    pass(node) * SLOTS + KIND_SLOT[node.kind];

  // The lane of a record: its own when it is an assignment, else the lane of
  // the nearest assignment that recorded links lead back to.
  const assignments = execution.nodes.filter(
    (node) => node.kind === "assignment",
  );
  const laneOfAssignment = new Map(
    assignments.map((node, index) => [node.nodeId, index]),
  );
  const unlinkedLane = assignments.length;
  const nearestAssignment = (node: CaseExecutionNode): number | null => {
    const seen = new Set<string>([node.nodeId]);
    let frontier: readonly CaseExecutionNode[] = [node];
    while (frontier.length > 0) {
      const next: CaseExecutionNode[] = [];
      for (const current of frontier)
        for (const source of incoming.get(current.nodeId) ?? []) {
          if (seen.has(source.nodeId)) continue;
          seen.add(source.nodeId);
          const lane = laneOfAssignment.get(source.nodeId);
          if (lane !== undefined) return lane;
          next.push(source);
        }
      frontier = next;
    }
    return null;
  };
  const laneOf = (node: CaseExecutionNode): number => {
    const own = laneOfAssignment.get(node.nodeId);
    if (own !== undefined) return own;
    const before = nearestAssignment(node);
    if (before !== null) return before;
    // A request has nothing before it. It sits with the first assignment
    // that was given it.
    if (node.kind === "trigger")
      for (const target of outgoing.get(node.nodeId) ?? []) {
        const lane = laneOfAssignment.get(target.nodeId);
        if (lane !== undefined) return lane;
      }
    return unlinkedLane;
  };

  // Columns that hold no record take no room.
  const slots = [...new Set(execution.nodes.map(slotOf))].sort(
    (left, right) => left - right,
  );
  const columnOfSlot = new Map(slots.map((slot, index) => [slot, index]));
  const columnX = (column: number): number =>
    PADDING + column * (EXECUTION_NODE_WIDTH + COLUMN_GAP);

  type Cell = { lane: number; column: number; nodes: CaseExecutionNode[] };
  const cells = new Map<string, Cell>();
  for (const node of execution.nodes) {
    const lane = laneOf(node);
    const column = columnOfSlot.get(slotOf(node)) ?? 0;
    const key = `${String(lane)}:${String(column)}`;
    const cell = cells.get(key) ?? { lane, column, nodes: [] };
    cell.nodes.push(node);
    cells.set(key, cell);
  }
  // A long stack keeps its first records. One more row holds the control
  // that shows the rest, or that folds the stack again.
  type Stack = Cell & {
    key: string;
    shown: CaseExecutionNode[];
    hidden: CaseExecutionNode[];
    control: boolean;
  };
  const stacks: Stack[] = [...cells.entries()].map(([key, cell]) => {
    const long = cell.nodes.length > EXECUTION_STACK_LIMIT;
    const folded = long && !unfolded.has(key);
    const kept = folded ? EXECUTION_STACK_LIMIT - 1 : cell.nodes.length;
    return {
      ...cell,
      key,
      shown: cell.nodes.slice(0, kept),
      hidden: cell.nodes.slice(kept),
      control: long,
    };
  });
  const rowsOf = (stack: Stack): number =>
    stack.shown.length + (stack.control ? 1 : 0);
  const laneRows = new Map<number, number>();
  for (const stack of stacks)
    laneRows.set(
      stack.lane,
      Math.max(laneRows.get(stack.lane) ?? 1, rowsOf(stack)),
    );
  const stackHeight = (rows: number): number =>
    rows * EXECUTION_NODE_HEIGHT + (rows - 1) * ROW_GAP;

  const lanes: ExecutionLane[] = [];
  let top = PADDING + HEADING_HEIGHT;
  for (const lane of [...laneRows.keys()].sort((left, right) => left - right)) {
    const height = stackHeight(laneRows.get(lane) ?? 1);
    lanes.push({
      lane,
      assignmentNodeId: assignments[lane]?.nodeId ?? null,
      top,
      height,
    });
    top += height + LANE_GAP;
  }
  const laneAt = new Map(lanes.map((lane) => [lane.lane, lane]));

  const placed = new Map<string, LaidOutNode>();
  const folds: ExecutionFold[] = [];
  const foldOf = new Map<string, string>();
  for (const stack of stacks) {
    const lane = laneAt.get(stack.lane);
    if (lane === undefined) continue;
    // A stack with fewer rows than its lane sits in the middle of the lane.
    const first = lane.top + (lane.height - stackHeight(rowsOf(stack))) / 2;
    const rowY = (row: number): number =>
      first + row * (EXECUTION_NODE_HEIGHT + ROW_GAP);
    stack.shown.forEach((node, row) => {
      placed.set(node.nodeId, {
        node,
        x: columnX(stack.column),
        y: rowY(row),
        column: stack.column,
        lane: stack.lane,
      });
    });
    if (!stack.control) continue;
    const kinds = new Set(stack.hidden.map((node) => node.kind));
    folds.push({
      key: stack.key,
      x: columnX(stack.column),
      y: rowY(stack.shown.length),
      hidden: stack.hidden.length,
      kind: kinds.size === 1 ? (stack.hidden[0]?.kind ?? null) : null,
    });
    for (const node of stack.hidden) foldOf.set(node.nodeId, stack.key);
  }
  const foldAt = new Map(folds.map((fold) => [fold.key, fold]));

  // One request that several lanes were given sits between those lanes, so
  // its links fan out.
  const centre = (entry: Readonly<{ y: number }>): number =>
    entry.y + EXECUTION_NODE_HEIGHT / 2;
  for (const cell of cells.values()) {
    const only = cell.nodes.length === 1 ? cell.nodes[0] : undefined;
    if (only === undefined || only.kind !== "trigger") continue;
    const alone = [...cells.values()].every(
      (other) => other === cell || other.column !== cell.column,
    );
    const entry = placed.get(only.nodeId);
    const targets = (outgoing.get(only.nodeId) ?? []).flatMap((target) => {
      const at = placed.get(target.nodeId);
      return at === undefined ? [] : [centre(at)];
    });
    if (!alone || entry === undefined || targets.length < 2) continue;
    // Lanes that are far apart keep the request with the first of them, so
    // that it is in the first view.
    if (Math.max(...targets) - Math.min(...targets) > FAN_OUT_SPAN) continue;
    const middle = targets.reduce((sum, y) => sum + y, 0) / targets.length;
    placed.set(only.nodeId, {
      ...entry,
      y: middle - EXECUTION_NODE_HEIGHT / 2,
    });
  }

  // A heading names a stage above the columns of that stage, in each pass.
  const headings: StageHeading[] = [];
  let open: {
    key: string;
    stage: ExecutionStage;
    from: number;
    to: number;
  } | null = null;
  const close = (): void => {
    if (open === null) return;
    headings.push({
      stage: open.stage,
      x: columnX(open.from),
      width: columnX(open.to) + EXECUTION_NODE_WIDTH - columnX(open.from),
    });
    open = null;
  };
  slots.forEach((slot, column) => {
    const stage = SLOT_STAGE[slot % SLOTS] ?? "work";
    const key = `${String(Math.floor(slot / SLOTS))}:${stage}`;
    if (open !== null && open.key === key) {
      open.to = column;
      return;
    }
    close();
    open = { key, stage, from: column, to: column };
  });
  close();

  // A link of a hidden record ends at the control of its fold. Several such
  // links between the same two places are one curve.
  const edges = new Map<string, LaidOutEdge>();
  const end = (
    nodeId: string,
  ): Readonly<{
    id: string | null;
    key: string;
    x: number;
    y: number;
  }> | null => {
    const node = placed.get(nodeId);
    if (node !== undefined)
      return { id: nodeId, key: nodeId, x: node.x, y: node.y };
    const fold = foldAt.get(foldOf.get(nodeId) ?? "");
    return fold === undefined
      ? null
      : { id: null, key: `fold:${fold.key}`, x: fold.x, y: fold.y };
  };
  for (const edge of execution.edges) {
    const from = end(edge.from);
    const to = end(edge.to);
    if (from === null || to === null || from.key === to.key) continue;
    const key = `${from.key}>${to.key}`;
    if (edges.has(key)) continue;
    const startX = from.x + EXECUTION_NODE_WIDTH;
    const startY = centre(from);
    const endX = to.x;
    const endY = centre(to);
    const bend = Math.max(24, (endX - startX) / 2);
    edges.set(key, {
      key,
      from: from.id,
      to: to.id,
      path: `M ${String(startX)} ${String(startY)} C ${String(startX + bend)} ${String(startY)}, ${String(endX - bend)} ${String(endY)}, ${String(endX)} ${String(endY)}`,
    });
  }

  const last = lanes.at(-1);
  return {
    width: columnX(slots.length - 1) + EXECUTION_NODE_WIDTH + PADDING,
    height: (last === undefined ? top : last.top + last.height) + PADDING,
    nodes: execution.nodes.flatMap((node) => {
      const entry = placed.get(node.nodeId);
      return entry === undefined ? [] : [entry];
    }),
    lanes,
    headings,
    edges: [...edges.values()],
    folds,
    foldOf,
  };
}
