import type {
  LogisticsView,
  TaskDependencyView,
  TaskView,
} from "@purin-labs/production-simulation";
import { assertNever } from "@purin-labs/std";
import type React from "react";
import {
  seconds,
  taskTime,
  SelectedOvenTask,
  type TaskSelection,
} from "./oven-logistics";
import type { Variant } from "@purin-labs/type-utils";

type Props = TaskSelection &
  Readonly<{
    mode: "workflow" | "timeline";
    view: LogisticsView;
    time: number;
    horizon: number;
  }>;
type AvailableProps = TaskSelection &
  Readonly<{
    view: Variant<LogisticsView, "available">;
    time: number;
    horizon: number;
  }>;
type GraphNode = {
  task: TaskView;
  rank: number;
  row: number;
  pending: number;
  next: GraphNode[];
};
const COLUMN = 230;
const ROW = 116;
const WIDTH = 204;
const HEIGHT = 88;

/** Presentation only. The retained worker remains the sole owner of run state. */
export function OvenTaskViews(props: Props): React.ReactNode {
  if (props.view.kind === "unavailable") return null;
  const available: AvailableProps = {
    view: props.view,
    time: props.time,
    horizon: props.horizon,
    selected: props.selected,
    select: props.select,
    ...(props.atRisk !== undefined ? { atRisk: props.atRisk } : {}),
  };
  const selected = props.view.tasks.find(
    selectedTask.bind(null, props.selected),
  );
  return (
    <section aria-label="Persistent task views" data-time={props.time}>
      {props.mode === "workflow" && (
        <>
          <h3>Workflow</h3>
          <p>
            Arrows show prerequisites. Each card shows the task’s current state.
            Select a task in either view to inspect it.
          </p>
          {taskGraph(available)}
        </>
      )}
      {props.mode === "timeline" && (
        <>
          <h3>Task timeline</h3>
          <p>
            Bars end at accepted boundaries or the committed time. Waiting bars
            show the current wait.
          </p>
          <p>
            Scale: 0–{seconds(props.horizon)} seconds. Committed time:{" "}
            {seconds(props.time)} seconds.
          </p>
          <div
            className="oven-task-timeline oven-logistics-scroll"
            tabIndex={0}
            aria-label="Task timeline"
          >
            {props.view.tasks.map(timelineRow.bind(null, available))}
          </div>
        </>
      )}
      {props.mode === "workflow" && selected !== undefined && (
        <>
          <SelectedOvenTask
            task={selected}
            risk={props.atRisk?.get(selected.id)}
          />
          {selectedPrerequisites(available, selected)}
        </>
      )}
    </section>
  );
}

function selectedPrerequisites(
  props: AvailableProps,
  task: TaskView,
): React.ReactNode {
  if (props.view.dependencies === null) return null;
  const prerequisites: React.ReactNode[] = [];
  for (const dependency of props.view.dependencies) {
    if (dependency.task !== task.id) continue;
    const present = props.view.tasks.some(
      selectedTask.bind(null, dependency.prerequisite),
    );
    prerequisites.push(
      <li key={dependency.prerequisite}>
        {present ? (
          <button onClick={props.select.bind(null, dependency.prerequisite)}>
            {dependency.prerequisite}
          </button>
        ) : (
          `${dependency.prerequisite} (has not arrived)`
        )}
      </li>,
    );
  }
  return (
    <div aria-label="Selected task prerequisites">
      <h4>Prerequisites</h4>
      {prerequisites.length === 0 ? <p>None</p> : <ul>{prerequisites}</ul>}
    </div>
  );
}

function selectedTask(selected: string | null, task: TaskView): boolean {
  return task.id === selected;
}

function graphNodes(
  tasks: readonly TaskView[],
  dependencies: readonly TaskDependencyView[],
): readonly GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  for (const task of tasks)
    nodes.set(task.id, { task, rank: 0, row: 0, pending: 0, next: [] });
  for (const dependency of dependencies) {
    const source = nodes.get(dependency.prerequisite);
    const target = nodes.get(dependency.task);
    if (source === undefined || target === undefined) continue;
    source.next.push(target);
    target.pending++;
  }
  const ready: GraphNode[] = [];
  for (const node of nodes.values()) if (node.pending === 0) ready.push(node);
  for (let index = 0; index < ready.length; index++) {
    const source = ready[index];
    if (source === undefined) continue;
    for (const target of source.next) {
      target.rank = Math.max(target.rank, source.rank + 1);
      target.pending--;
      if (target.pending === 0) ready.push(target);
    }
  }
  const rows = new Map<number, number>();
  for (const node of nodes.values()) {
    node.row = rows.get(node.rank) ?? 0;
    rows.set(node.rank, node.row + 1);
  }
  return [...nodes.values()];
}

function taskGraph(props: AvailableProps): React.ReactNode {
  if (props.view.dependencies === null)
    return (
      <p>This retained execution build does not expose task dependencies.</p>
    );
  const nodes = graphNodes(props.view.tasks, props.view.dependencies);
  const indexed = new Map<string, GraphNode>();
  let width = COLUMN;
  let height = ROW;
  for (const node of nodes) {
    indexed.set(node.task.id, node);
    width = Math.max(width, (node.rank + 1) * COLUMN);
    height = Math.max(height, (node.row + 1) * ROW);
  }
  return (
    <div
      className="oven-task-graph oven-logistics-scroll"
      tabIndex={0}
      aria-label="Task dependency graph"
    >
      <div className="oven-task-graph-content" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          {props.view.dependencies.map(
            graphEdge.bind(null, indexed, props.selected),
          )}
        </svg>
        {nodes.map(graphCard.bind(null, props))}
      </div>
    </div>
  );
}

function graphEdge(
  nodes: ReadonlyMap<string, GraphNode>,
  selected: string | null,
  edge: TaskDependencyView,
): React.ReactNode {
  const source = nodes.get(edge.prerequisite);
  const target = nodes.get(edge.task);
  if (source === undefined || target === undefined) return null;
  const x1 = source.rank * COLUMN + WIDTH;
  const y1 = source.row * ROW + HEIGHT / 2;
  const x2 = target.rank * COLUMN;
  const y2 = target.row * ROW + HEIGHT / 2;
  return (
    <g
      key={`${edge.prerequisite}:${edge.task}`}
      data-prerequisite={edge.prerequisite}
      data-dependent={edge.task}
      data-selected={selected === edge.prerequisite || selected === edge.task}
    >
      <path
        d={`M ${x1} ${y1} C ${x1 + 14} ${y1}, ${x2 - 14} ${y2}, ${x2 - 4} ${y2}`}
      />
      <path
        d={`M ${x2 - 9} ${y2 - 4} L ${x2 - 3} ${y2} L ${x2 - 9} ${y2 + 4}`}
      />
    </g>
  );
}

function graphCard(props: AvailableProps, node: GraphNode): React.ReactNode {
  const { task } = node;
  const risk = props.atRisk?.get(task.id);
  const prerequisites: string[] = [];
  for (const dependency of props.view.dependencies ?? [])
    if (dependency.task === task.id)
      prerequisites.push(dependency.prerequisite);
  return (
    <button
      key={task.id}
      className="oven-task-card"
      data-graph-task={task.id}
      data-kind={task.kind}
      data-at-risk={risk !== undefined ? "true" : undefined}
      aria-pressed={props.selected === task.id}
      aria-label={`${task.id}: ${task.kind}${risk !== undefined ? `, at risk (${risk.reason})` : ""}. Prerequisites: ${prerequisites.join(", ") || "none"}.`}
      title={`${task.id}\n${taskTime(task)}${risk !== undefined ? `\nAt risk (${risk.appliance}): ${risk.reason}` : ""}\nPrerequisites: ${prerequisites.join(", ") || "none"}`}
      onClick={props.select.bind(null, task.id)}
      style={{
        left: node.rank * COLUMN,
        top: node.row * ROW,
        width: WIDTH,
        height: HEIGHT,
      }}
    >
      <span>
        {task.subject.kind === "workflow"
          ? task.subject.instance
          : task.subject.resource}
      </span>
      <strong>
        {task.subject.kind === "workflow" ? task.subject.key : "Changeover"}
      </strong>
      <span>
        {task.kind}
        {risk !== undefined && (
          <>
            {" "}
            <span className="appliance-risk-badge" data-risk="at-risk">
              At risk
            </span>
          </>
        )}
      </span>
    </button>
  );
}

export type Span = Readonly<{
  phase: "waiting" | "reserved" | "execution" | "unresolved" | "cancelled";
  start: number;
  end: number;
}>;

/** Completed task history is exact; live spans stop at the committed clock. */
export function taskSpans(task: TaskView, time: number): readonly Span[] {
  switch (task.kind) {
    case "waiting":
      return [{ phase: "waiting", start: task.since, end: time }];
    case "reserved":
      return [{ phase: "reserved", start: task.reservedAt, end: time }];
    case "skipped":
      return [];
    case "executing":
      return [{ phase: "execution", start: task.startedAt, end: time }];
    case "completed":
      return [
        { phase: "execution", start: task.startedAt, end: task.completedAt },
      ];
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
    case "failed":
      return [
        { phase: "execution", start: task.startedAt, end: task.failedAt },
        {
          phase: "unresolved",
          start: task.failedAt,
          end: task.kind === "failed" ? task.resolvedAt : time,
        },
      ];
    case "cancelled":
      return [
        { phase: "cancelled", start: task.cancelledAt, end: task.cancelledAt },
      ];
    default:
      return assertNever(task);
  }
}

function timelineRow(props: AvailableProps, task: TaskView): React.ReactNode {
  const risk = props.atRisk?.get(task.id);
  return (
    <div
      key={task.id}
      className="oven-task-track"
      data-timeline-task={task.id}
      data-kind={task.kind}
      data-at-risk={risk !== undefined ? "true" : undefined}
    >
      <button
        aria-pressed={props.selected === task.id}
        title={
          risk !== undefined ? `${task.id} — At risk: ${risk.reason}` : task.id
        }
        onClick={props.select.bind(null, task.id)}
      >
        {task.id}
        {risk !== undefined && (
          <>
            {" "}
            <span className="appliance-risk-badge" data-risk="at-risk">
              At risk
            </span>
          </>
        )}
      </button>
      <div className="oven-task-lane">
        {taskSpans(task, props.time).map(timelineSpan.bind(null, props, task))}
        <span
          className="oven-task-cursor"
          style={{ left: `${(props.time / props.horizon) * 100}%` }}
        />
      </div>
    </div>
  );
}

function timelineSpan(
  props: AvailableProps,
  task: TaskView,
  span: Span,
): React.ReactNode {
  const label = `${task.id}: ${span.phase} ${seconds(span.start)}–${seconds(span.end)} seconds. ${taskTime(task)}.`;
  return (
    <button
      key={span.phase}
      className="oven-task-span"
      data-phase={span.phase}
      data-start={span.start}
      data-end={span.end}
      aria-label={label}
      title={label}
      aria-pressed={props.selected === task.id}
      onClick={props.select.bind(null, task.id)}
      style={{
        left: `${(span.start / props.horizon) * 100}%`,
        width: `${((span.end - span.start) / props.horizon) * 100}%`,
      }}
    >
      {span.phase}
    </button>
  );
}
