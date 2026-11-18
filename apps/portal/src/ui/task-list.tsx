import React from "react";
import {
  Check,
  ChevronDown,
  Circle,
  CircleArrowRight,
  CircleDashed,
  CircleAlert,
  Pause,
  X,
} from "lucide-react";
import { EmptyState } from "./empty-state";
import "./task-list.css";
import { assertNever } from "@seams/std";

export type TaskState =
  | {
      readonly kind:
        "pending" | "completed" | "blocked" | "failed" | "cancelled";
      readonly progress?: never;
    }
  | { readonly kind: "running"; readonly progress: number | null };

export type TaskListItem = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly state: TaskState;
};

export type TaskListProps = {
  readonly items: readonly TaskListItem[];
  readonly title?: string;
};

export function TaskList(props: TaskListProps): React.ReactNode {
  const title = props.title ?? "Tasks";
  const completed = props.items.filter(isCompleted).length;
  const progress = props.items.reduce(taskProgress, 0) / props.items.length;
  if (props.items.length === 0)
    return (
      <EmptyState
        title="No tasks yet"
        description="Tasks will appear here when a plan is available."
      />
    );
  return (
    <details className="task-list" open>
      <summary>
        <span
          className="task-list-header-icon"
          data-completed={completed === props.items.length}
          aria-hidden="true"
        >
          <svg className="task-list-donut" viewBox="0 0 16 16" fill="none">
            <circle className="task-list-donut-track" cx="8" cy="8" r="7" />
            <circle
              className="task-list-donut-fill"
              cx="8"
              cy="8"
              r="7"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - progress}
              transform="rotate(-90 8 8)"
            />
          </svg>
          <Check className="task-list-header-check" size={14} />
        </span>
        <span>{title}</span>
        <span
          className="task-list-count"
          aria-label={`${completed} of ${props.items.length} tasks completed`}
        >
          <RollingNumber value={completed} />/{props.items.length}
        </span>
        <ChevronDown
          size={14}
          className="task-list-chevron"
          aria-hidden="true"
        />
      </summary>
      <ol aria-label={title}>{props.items.map(renderTask)}</ol>
    </details>
  );
}

function isCompleted(item: TaskListItem): boolean {
  return item.state.kind === "completed";
}

function taskProgress(total: number, item: TaskListItem): number {
  if (item.state.kind === "completed") return total + 100;
  if (
    item.state.kind === "running" &&
    item.state.progress !== null &&
    Number.isFinite(item.state.progress)
  )
    return total + Math.max(0, Math.min(100, item.state.progress));
  return total;
}

function renderTask(item: TaskListItem): React.ReactNode {
  const Icon = taskIcon(item.state);
  const progress =
    item.state.kind === "running" &&
    item.state.progress !== null &&
    Number.isFinite(item.state.progress)
      ? Math.max(0, Math.min(100, item.state.progress))
      : null;
  return (
    <li key={item.id} data-state={item.state.kind}>
      <span className="task-list-icon" aria-hidden="true">
        {item.state.kind === "pending" ||
        item.state.kind === "running" ||
        item.state.kind === "completed" ? (
          <svg viewBox="0 0 16 16" fill="none" className="task-list-mark">
            <circle
              className="task-list-mark-pending"
              cx="8"
              cy="8"
              r="7"
              strokeDasharray="1 2"
            />
            <circle className="task-list-mark-ring" cx="8" cy="8" r="7" />
            <circle className="task-list-mark-fill" cx="8" cy="8" r="8" />
            <path className="task-list-mark-arrow" d="M5 8h6M8 5l3 3-3 3" />
            <path
              className="task-list-mark-check"
              d="m4.5 8 2.3 2.3 4.7-4.6"
              pathLength="1"
            />
          </svg>
        ) : (
          <Icon size={14} />
        )}
      </span>
      <div className="task-list-content">
        <div className="task-list-label">
          <span className="task-list-task-title">
            <span className="task-list-strike">
              <span className="task-list-title-ink">{item.label}</span>
            </span>
          </span>
          <small className="task-list-status">{taskStatus(item.state)}</small>
        </div>
        {item.detail && <p>{item.detail}</p>}
      </div>
      {progress !== null && (
        <span
          className="task-list-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label={`${item.label} progress`}
        >
          <RollingNumber value={Math.round(progress)} />
          <span className="task-list-percent-sign" aria-hidden="true">
            %
          </span>
        </span>
      )}
    </li>
  );
}

class RollingNumber extends React.Component<
  { value: number },
  { current: number; previous: number | null }
> {
  state: { current: number; previous: number | null } = {
    current: this.props.value,
    previous: null,
  };
  static getDerivedStateFromProps(
    props: { value: number },
    state: { current: number; previous: number | null },
  ): { current: number; previous: number | null } | null {
    return props.value === state.current
      ? null
      : { current: props.value, previous: state.current };
  }
  render(): React.ReactNode {
    const digits = String(this.state.current).split("").reverse();
    return (
      <span className="task-list-number" aria-hidden="true">
        {digits.map(this.renderDigit, this).reverse()}
      </span>
    );
  }
  private renderDigit(digit: string, index: number): React.ReactNode {
    const previous =
      this.state.previous === null
        ? null
        : String(this.state.previous).split("").reverse()[index];
    return (
      <span
        className="task-list-percent-window"
        aria-hidden="true"
        key={`${index}-${digit}`}
        data-changing={
          previous !== null && previous !== undefined && previous !== digit
        }
      >
        {previous !== null && previous !== undefined && (
          <span className="task-list-percent-out">{previous}</span>
        )}
        <span className="task-list-percent-in">{digit}</span>
      </span>
    );
  }
}

function taskIcon(state: TaskState): typeof Circle {
  switch (state.kind) {
    case "pending":
      return CircleDashed;
    case "running":
      return CircleArrowRight;
    case "completed":
      return Check;
    case "blocked":
      return Pause;
    case "failed":
      return CircleAlert;
    case "cancelled":
      return X;
    default:
      return assertNever(state, "Unknown task state");
  }
}

function taskStatus(state: TaskState): string {
  switch (state.kind) {
    case "pending":
      return "Pending";
    case "running":
      return "Working";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Needs attention";
    case "cancelled":
      return "Cancelled";
    default:
      return assertNever(state, "Unknown task state");
  }
}
