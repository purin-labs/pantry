import type { StrictUnion } from "@purin-labs/type-utils";
import { logisticsView, type LogisticsView } from "../../logistics-view.ts";
import type { RunState } from "../../state.ts";

type TraceEvent = StrictUnion<
  | Readonly<{ kind: "task-started" | "task-completed"; task: string }>
  | Readonly<{
      kind: "lot-produced";
      lot: string;
      product: string;
      quantity: number;
    }>
  | Readonly<{
      kind: "lot-consumed";
      lot: string;
      task: string;
      quantity: number;
    }>
  | Readonly<{
      kind: "quantity-reported";
      task: string;
      destination: string;
      quantity: number;
      unit: string;
    }>
  | Readonly<{
      kind: "inspection-decided";
      task: string;
      outcome: "accept" | "reject";
    }>
  | Readonly<{
      kind: "carrier-moved";
      carrier: string;
      task: string;
      storage: string;
      movement: "pickup" | "placement";
    }>
  | Readonly<{
      kind: "availability-changed";
      resource: string;
      available: boolean;
    }>
>;

export type ShiftTraceNode = Readonly<{
  id: string;
  timeUs: number;
  event: TraceEvent;
}>;

export type ShiftTraceEdge = Readonly<{
  from: string;
  to: string;
  relation:
    "execution" | "prerequisite" | "material" | "inspection" | "custody";
}>;

export type ShiftTrace = StrictUnion<
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{
      kind: "available";
      coverage: "tasks" | "accepted-run";
      nodes: readonly ShiftTraceNode[];
      edges: readonly ShiftTraceEdge[];
    }>
>;

type TraceBuilder = {
  nodes: Map<string, ShiftTraceNode>;
  edges: ShiftTraceEdge[];
};

function connect(
  builder: TraceBuilder,
  from: string,
  to: string,
  relation: ShiftTraceEdge["relation"],
): void {
  const source = builder.nodes.get(from);
  const target = builder.nodes.get(to);
  if (source === undefined || target === undefined) return;
  if (source.timeUs > target.timeUs)
    throw new Error(`Trace reverses time: ${from} -> ${to}`);
  builder.edges.push({ from, to, relation });
}

function compareNodes(left: ShiftTraceNode, right: ShiftTraceNode): number {
  return left.timeUs - right.timeUs || left.id.localeCompare(right.id);
}

function graph(
  builder: TraceBuilder,
  coverage: "tasks" | "accepted-run",
): ShiftTrace {
  if (builder.nodes.size === 0)
    return { kind: "unavailable", reason: "No accepted execution events" };
  return {
    kind: "available",
    coverage,
    nodes: [...builder.nodes.values()].sort(compareNodes),
    edges: builder.edges,
  };
}

function taskGraph(
  logistics: LogisticsView & { kind: "available" },
): TraceBuilder {
  const builder: TraceBuilder = { nodes: new Map(), edges: [] };
  for (const task of logistics.tasks) {
    const startId = `task-start:${task.id}`;
    const endId = `task-end:${task.id}`;
    if ("startedAt" in task && task.startedAt !== undefined) {
      builder.nodes.set(startId, {
        id: startId,
        timeUs: task.startedAt,
        event: { kind: "task-started", task: task.id },
      });
    }
    if (task.kind === "completed") {
      builder.nodes.set(endId, {
        id: endId,
        timeUs: task.completedAt,
        event: { kind: "task-completed", task: task.id },
      });
      connect(builder, startId, endId, "execution");
    }
  }
  for (const dependency of logistics.dependencies ?? []) {
    connect(
      builder,
      `task-end:${dependency.prerequisite}`,
      `task-start:${dependency.task}`,
      "prerequisite",
    );
  }
  return builder;
}

/** The Portal can prove task dependencies from its accepted host view. */
export function buildShiftTaskTrace(logistics: LogisticsView): ShiftTrace {
  if (logistics.kind === "unavailable" || logistics.dependencies === null) {
    return {
      kind: "unavailable",
      reason: "Task dependency evidence is unavailable",
    };
  }
  return graph(taskGraph(logistics), "tasks");
}

/** Material, inspection and carrier edges require the accepted event journal. */
export function buildShiftRunTrace(run: RunState): ShiftTrace {
  const logistics = logisticsView(run);
  if (logistics.kind === "unavailable")
    return { kind: "unavailable", reason: "Task evidence is unavailable" };
  const builder = taskGraph(logistics);
  const lastCarrierNode = new Map<string, string>();
  for (const lot of run.definition.scenario.stock) {
    const id = `lot:${lot.id}`;
    builder.nodes.set(id, {
      id,
      timeUs: 0,
      event: {
        kind: "lot-produced",
        lot: lot.id,
        product: lot.product,
        quantity: lot.quantity.amount,
      },
    });
  }
  let sequence = 0;
  for (const event of run.events) {
    const id = `event:${sequence++}`;
    switch (event.kind) {
      case "lot-produced": {
        const lotId = `lot:${event.lot}`;
        builder.nodes.set(lotId, {
          id: lotId,
          timeUs: event.time,
          event: {
            kind: "lot-produced",
            lot: event.lot,
            product: event.product,
            quantity: event.quantity.amount,
          },
        });
        connect(builder, `task-start:${event.task}`, lotId, "material");
        connect(builder, lotId, `task-end:${event.task}`, "material");
        break;
      }
      case "lot-consumed":
        builder.nodes.set(id, {
          id,
          timeUs: event.time,
          event: {
            kind: "lot-consumed",
            lot: event.lot,
            task: event.task,
            quantity: event.quantity.amount,
          },
        });
        connect(builder, `lot:${event.lot}`, id, "material");
        connect(builder, id, `task-end:${event.task}`, "material");
        break;
      case "quantity-reported":
        builder.nodes.set(id, {
          id,
          timeUs: event.time,
          event: {
            kind: "quantity-reported",
            task: event.task,
            destination: event.destination,
            quantity: event.quantity.amount,
            unit: event.quantity.unit,
          },
        });
        connect(builder, `task-start:${event.task}`, id, "execution");
        break;
      case "carrier-picked-up":
      case "carrier-placed": {
        const movement =
          event.kind === "carrier-picked-up" ? "pickup" : "placement";
        const storage =
          event.kind === "carrier-picked-up" ? event.from : event.to;
        builder.nodes.set(id, {
          id,
          timeUs: event.time,
          event: {
            kind: "carrier-moved",
            carrier: event.carrier,
            task: event.task,
            storage,
            movement,
          },
        });
        const previous = lastCarrierNode.get(event.carrier);
        if (previous !== undefined) connect(builder, previous, id, "custody");
        connect(builder, `task-start:${event.task}`, id, "execution");
        lastCarrierNode.set(event.carrier, id);
        break;
      }
      case "availability-changed":
        builder.nodes.set(id, {
          id,
          timeUs: event.time,
          event: {
            kind: "availability-changed",
            resource: event.resource,
            available: event.available,
          },
        });
        break;
      default:
        // These are projections of selected accepted event kinds. Other kinds
        // do not supply material, custody or task-dependency evidence.
        break;
    }
  }
  for (const entry of run.commands) {
    if (entry.command.kind !== "inspect" || entry.receipt.status !== "accepted")
      continue;
    const command = entry.command;
    const id = `inspection:${command.commandId}`;
    builder.nodes.set(id, {
      id,
      timeUs: entry.receipt.effectiveAt,
      event: {
        kind: "inspection-decided",
        task: command.task,
        outcome: command.outcome,
      },
    });
    for (const lot of command.lots)
      connect(builder, `lot:${lot}`, id, "inspection");
    connect(builder, id, `task-end:${command.task}`, "inspection");
  }
  return graph(builder, "accepted-run");
}

export type TracePath = StrictUnion<
  | Readonly<{ kind: "resolved"; nodeIds: readonly string[]; hopCount: number }>
  | Readonly<{
      kind: "unavailable";
      reason: "missing-evidence" | "no-causal-path";
    }>
>;

/** Every returned hop is an actual edge. Missing evidence never resolves. */
export function findShiftTracePath(
  trace: ShiftTrace,
  from: string,
  to: string,
): TracePath {
  if (trace.kind === "unavailable")
    return { kind: "unavailable", reason: "missing-evidence" };
  const ids = new Set<string>();
  for (const node of trace.nodes) ids.add(node.id);
  if (!ids.has(from) || !ids.has(to))
    return { kind: "unavailable", reason: "missing-evidence" };
  const adjacency = new Map<string, string[]>();
  for (const edge of trace.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to))
      return { kind: "unavailable", reason: "missing-evidence" };
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const queue: string[][] = [[from]];
  const visited = new Set([from]);
  for (const path of queue) {
    const last = path.at(-1);
    if (last === to)
      return { kind: "resolved", nodeIds: path, hopCount: path.length - 1 };
    if (last === undefined) continue;
    for (const next of adjacency.get(last) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return { kind: "unavailable", reason: "no-causal-path" };
}
