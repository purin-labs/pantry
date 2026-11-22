import React from "react";
import {
  Check,
  Circle,
  Clock,
  LoaderCircle,
  TriangleAlert,
  ArrowUpRight,
} from "lucide-react";
import type { HostView, TaskView } from "@purin-labs/production-simulation";
import { assertNever } from "@purin-labs/std";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  type TraceStatus,
} from "@purin-labs/ui/trace";
import { blockerDescription, taskTime } from "./oven-logistics";
import "@purin-labs/ui/operations-trace.css";
import "./production-activity-trace.css";

type Props = Readonly<{
  view: HostView;
  select(task: string): void;
  reviewRecovery(): void;
}>;

/** The accepted simulation view owns every state. This component never dispatches work. */
export function ProductionActivityTrace(props: Props): React.ReactNode {
  if (props.view.logistics.kind === "unavailable")
    return (
      <p>Task activity is unavailable in this retained simulation build.</p>
    );
  const tasks = props.view.logistics.tasks;
  const groups = new Map<string, TaskView[]>();
  for (const task of tasks) {
    const groupId =
      task.subject.kind === "workflow"
        ? task.subject.instance
        : "Equipment changeovers";
    const group = groups.get(groupId) ?? [];
    group.push(task);
    groups.set(groupId, group);
  }
  return (
    <Trace
      className="operations-trace production-activity-trace"
      aria-label="Production activity"
    >
      <p className="operations-trace-context">
        Task activity{" "}
        <span>
          Simulation ·{" "}
          <span className="production-activity-seconds">
            {(props.view.time / 1_000_000).toFixed(1)}
          </span>{" "}
          s
        </span>
      </p>
      {tasks.length === 0 && <p>No tasks have entered this run.</p>}
      {Array.from(groups.entries()).map(renderGroup.bind(null, props))}
      {props.view.cells.some(unresolvedCell) && (
        <p role="status">
          An execution outcome is unresolved. The simulation must reconcile its
          accepted state before it can continue.
        </p>
      )}
    </Trace>
  );
}

function renderGroup(
  props: Props,
  [identity, tasks]: [string, TaskView[]],
): React.ReactNode {
  return (
    <section
      key={identity}
      className="production-activity-group"
      aria-label={groupTitle(identity)}
    >
      <h4>{groupTitle(identity)}</h4>
      <Trace>{tasks.map(renderTask.bind(null, props))}</Trace>
    </section>
  );
}

function groupTitle(identity: string): string {
  const match = /^(.*)#(\d+)$/u.exec(identity);
  if (match)
    return `${displayName(match[1] ?? identity)} · ${Number(match[2]) + 1}`;
  return displayName(identity);
}
function displayName(value: string): string {
  const label = value.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function unresolvedCell(cell: HostView["cells"][number]): boolean {
  return cell.hold === "unresolved";
}

function taskLabel(task: TaskView, view: HostView): string {
  switch (task.kind) {
    case "waiting":
      return task.blockers.length === 0 ? "Queued" : "Waiting";
    case "reserved":
      return "Reserved";
    case "executing":
      return executionLabel(view);
    case "completed":
      return "Completed";
    case "skipped":
      return "Skipped after inspection";
    case "recovery-required":
      return "Recovery required";
    case "recovering":
      return `Recovery · ${executionLabel(view)}`;
    case "recovery-failed":
      return "Recovery failed";
    case "failed":
      return "Failed · resolved";
    case "cancelled":
      return "Cancelled";
    default:
      return assertNever(task);
  }
}
function executionLabel(view: HostView): string {
  switch (view.status.kind) {
    case "advancing":
    case "awaiting-execution":
      return "In progress";
    case "paused":
      return "Paused";
    case "pause-requested":
      return "Pause requested";
    case "blocked":
      return "Blocked";
    case "awaiting-inspection":
      return "Awaiting inspection";
    case "stopped-at-limit":
      return "Execution limit reached";
    case "ready":
      return "Ready";
    case "completed":
      return "Run ended";
    default:
      return assertNever(view.status.kind);
  }
}
function isAdvancing(view: HostView): boolean {
  return (
    view.status.kind === "advancing" ||
    view.status.kind === "awaiting-execution"
  );
}
function taskStatus(task: TaskView, view: HostView): TraceStatus {
  switch (task.kind) {
    case "executing":
    case "recovering":
      return isAdvancing(view) ? "running" : "pending";
    case "completed":
      return "completed";
    case "recovery-required":
    case "recovery-failed":
    case "failed":
      return "error";
    case "waiting":
    case "reserved":
    case "cancelled":
    case "skipped":
      return "pending";
    default:
      return assertNever(task);
  }
}
function taskIcon(task: TaskView, status: TraceStatus): typeof Check {
  if (status === "error") return TriangleAlert;
  if (status === "running") return LoaderCircle;
  if (task.kind === "completed") return Check;
  if (task.kind === "waiting" || task.kind === "reserved") return Clock;
  return Circle;
}
function taskTitle(task: TaskView): string {
  switch (task.subject.kind) {
    case "workflow":
      return displayName(task.subject.key);
    case "changeover":
      return `Change ${task.subject.resource} from ${task.subject.from} to ${task.subject.to}`;
    default:
      return assertNever(task.subject);
  }
}
function prerequisiteLabel(
  tasks: readonly TaskView[],
  current: TaskView,
  identity: string,
): string {
  for (const target of tasks) {
    if (target.id !== identity) continue;
    if (
      target.subject.kind === "workflow" &&
      (current.subject.kind !== "workflow" ||
        current.subject.instance !== target.subject.instance)
    )
      return `${taskTitle(target)} · ${groupTitle(target.subject.instance)}`;
    return taskTitle(target);
  }
  return identity;
}
function renderTask(props: Props, task: TaskView): React.ReactNode {
  const status = taskStatus(task, props.view);
  const Icon = taskIcon(task, status);
  const blockers: React.ReactNode[] = [];
  if (task.kind === "waiting")
    for (const [index, blocker] of task.blockers.entries())
      blockers.push(<li key={index}>{blockerDescription(blocker)}</li>);
  const resources: React.ReactNode[] = [];
  if (props.view.logistics.kind === "available")
    for (const resource of props.view.logistics.resources)
      for (const allocation of resource.allocations)
        if (allocation.task === task.id)
          resources.push(
            <li key={resource.id}>
              {resource.id} · {allocation.kind} · {allocation.units} capacity
              units
            </li>,
          );
  const prerequisites: React.ReactNode[] = [];
  if (
    props.view.logistics.kind === "available" &&
    props.view.logistics.dependencies !== null
  )
    for (const dependency of props.view.logistics.dependencies)
      if (dependency.task === task.id)
        prerequisites.push(
          <li key={dependency.prerequisite}>
            <button
              type="button"
              className="production-task-button"
              onClick={props.select.bind(null, dependency.prerequisite)}
            >
              {prerequisiteLabel(
                props.view.logistics.tasks,
                task,
                dependency.prerequisite,
              )}
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </li>,
        );
  return (
    <TraceCollapsible
      key={task.id}
      defaultOpen={status === "error"}
      data-task-id={task.id}
    >
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon spinning={status === "running"}>
            <Icon />
          </TraceIcon>
          <TraceTitle>{taskTitle(task)}</TraceTitle>
          <TraceDescription>{taskLabel(task, props.view)}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <p className="production-task-time">Time (seconds): {taskTime(task)}</p>
        {blockers.length > 0 && <ul aria-label="Task blockers">{blockers}</ul>}
        {resources.length > 0 && (
          <>
            <h4>Resource allocations</h4>
            <ul>{resources}</ul>
          </>
        )}
        {prerequisites.length > 0 && (
          <>
            <h4>Prerequisites</h4>
            <ul className="production-task-prerequisites">{prerequisites}</ul>
          </>
        )}
        {task.kind === "completed" && (
          <p className="operations-trace-receipt">
            <Check size={14} />
            Simulation result recorded
          </p>
        )}
        <div className="operations-trace-actions">
          <button
            className="production-task-button"
            type="button"
            onClick={props.select.bind(null, task.id)}
          >
            Inspect task
          </button>
          {(task.kind === "recovery-required" ||
            task.kind === "recovery-failed") && (
            <button
              className="production-task-button"
              type="button"
              onClick={props.reviewRecovery}
            >
              Review recovery
            </button>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
