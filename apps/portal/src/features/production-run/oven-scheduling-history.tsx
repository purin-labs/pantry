import {
  CAPACITY_CATEGORIES,
  waitCategory,
  type ResourceCategories,
  type SchedulingHistoryView,
  type WaitInterval,
  type Blocker,
} from "@seams/production-simulation";
import type React from "react";
import {
  blockerDescription,
  seconds,
  type TaskSelection,
} from "./oven-logistics";

type Props = TaskSelection & Readonly<{ view: SchedulingHistoryView }>;

export function OvenSchedulingHistory(props: Props): React.ReactNode {
  const { view } = props;
  if (view.kind === "unavailable")
    return (
      <p>This retained execution build does not expose scheduling history.</p>
    );
  return (
    <section aria-label="Scheduling history" data-time={view.through}>
      <h3>Resource states and waits</h3>
      <p>
        Accepted history from {seconds(view.after)} to {seconds(view.through)}{" "}
        seconds. Each capacity unit has one state at a time.
      </p>
      <p>
        Running, reserved, and held claims retain their units. Withheld capacity
        and spare slots in a running batch are unavailable. Loading and
        unloading include time waiting for transfers.
      </p>
      <p>
        Remaining capacity serves blocked demand before starved demand. Starved
        work lacks material or a carrier. Release and prerequisite gates request
        no capacity. Worker requests follow candidate order and count once.
      </p>
      <div
        className="oven-logistics-scroll oven-scheduling-accounting"
        tabIndex={0}
        aria-label="Resource state accounting"
      >
        <table className="oven-workspace-cells">
          <caption>Resource states (unit-seconds)</caption>
          <thead>
            <tr>
              <th>Resource</th>
              {CAPACITY_CATEGORIES.map(categoryHeading)}
            </tr>
          </thead>
          <tbody>{view.resources.map(resourceRow)}</tbody>
        </table>
      </div>
      <details>
        <summary>Accepted task waits: {view.waits.length} intervals</summary>
        <p>
          Each row retains all blockers for one interval. Wait durations use
          task-seconds. Their sum can exceed elapsed simulation time.
        </p>
        <div
          className="oven-logistics-scroll oven-wait-history"
          tabIndex={0}
          aria-label="Accepted task wait intervals"
        >
          <table className="oven-workspace-cells">
            <caption>Task waits</caption>
            <thead>
              <tr>
                <th>Task</th>
                <th>Class</th>
                <th>Start (s)</th>
                <th>End (s)</th>
                <th>Wait (s)</th>
                <th>Blockers</th>
              </tr>
            </thead>
            <tbody>{view.waits.map(waitRow.bind(null, props))}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function categoryHeading(
  kind: (typeof CAPACITY_CATEGORIES)[number],
): React.ReactNode {
  return (
    <th key={kind}>
      {kind[0]?.toUpperCase()}
      {kind.slice(1)}
    </th>
  );
}
function resourceRow(resource: ResourceCategories): React.ReactNode {
  return (
    <tr key={resource.resource} data-resource-categories={resource.resource}>
      <td>{resource.resource}</td>
      {CAPACITY_CATEGORIES.map(categoryCell.bind(null, resource))}
    </tr>
  );
}
function categoryCell(
  resource: ResourceCategories,
  kind: (typeof CAPACITY_CATEGORIES)[number],
): React.ReactNode {
  return (
    <td key={kind} data-category={kind} data-value={resource.unitSeconds[kind]}>
      {resource.unitSeconds[kind].toFixed(3)}
    </td>
  );
}
function waitRow(props: Props, span: WaitInterval): React.ReactNode {
  return (
    <tr
      key={`${span.task}:${span.start}`}
      data-wait-task={span.task}
      data-start={span.start}
      data-end={span.end}
    >
      <td>
        <button
          aria-pressed={props.selected === span.task}
          onClick={props.select.bind(null, span.task)}
        >
          {span.task}
        </button>
      </td>
      <td>{waitCategory(span.blockers)}</td>
      <td>{seconds(span.start)}</td>
      <td>{seconds(span.end)}</td>
      <td>{seconds(span.end - span.start)}</td>
      <td>
        <ul>{span.blockers.map(blockerItem)}</ul>
      </td>
    </tr>
  );
}
function blockerItem(blocker: Blocker, index: number): React.ReactNode {
  return <li key={index}>{blockerDescription(blocker)}</li>;
}
