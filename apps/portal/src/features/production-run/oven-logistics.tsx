import type {
  Blocker,
  CarrierStoreView,
  LogisticsView,
  QueueView,
  ResourceView,
  TaskView,
} from "@seams/production-simulation";
import { assertNever } from "@seams/std";
import type React from "react";

export type TaskSelection = Readonly<{
  selected: string | null;
  select(task: string): void;
}>;

type Props = TaskSelection & Readonly<{ view: LogisticsView }>;

export function OvenLogistics(props: Props) {
  const { view } = props;
  if (view.kind === "unavailable")
    return (
      <p>
        This retained execution build does not expose logistics observations.
        Its saved run can continue with cell progress.
      </p>
    );
  return (
    <section aria-label="Committed logistics">
      <h3>Logistics</h3>
      <p>
        Tasks, queues, and capacity share the simulation time above. Queue
        counts use tasks. A task can wait in several queues.
      </p>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label="Waiting queues"
      >
        <table className="oven-workspace-cells">
          <caption>Waiting queues</caption>
          <thead>
            <tr>
              <th>Type</th>
              <th>Destination or resource</th>
              <th>Waiting tasks</th>
            </tr>
          </thead>
          <tbody>{view.queues.map(queueRow.bind(null, props))}</tbody>
        </table>
        {view.queues.length === 0 && (
          <p>No tasks wait for capacity or a cell.</p>
        )}
      </div>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label="Resource allocations"
      >
        <table className="oven-workspace-cells">
          <caption>Resource allocations</caption>
          <thead>
            <tr>
              <th>Resource</th>
              <th>Capacity units</th>
              <th>Availability</th>
              <th>Allocations</th>
              <th>Position / cycle</th>
            </tr>
          </thead>
          <tbody>{view.resources.map(resourceRow.bind(null, props))}</tbody>
        </table>
      </div>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label="Carrier storage"
      >
        <table className="oven-workspace-cells">
          <caption>Carrier storage</caption>
          <thead>
            <tr>
              <th>Storage</th>
              <th>Carrier slots</th>
              <th>Occupied</th>
              <th>Reserved for arrival</th>
            </tr>
          </thead>
          <tbody>{view.carrierStores.map(storageRow.bind(null, props))}</tbody>
        </table>
      </div>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label="Workflow tasks"
      >
        <table className="oven-workspace-cells">
          <caption>Workflow tasks</caption>
          <thead>
            <tr>
              <th>Instance / task</th>
              <th>State</th>
              <th>Time (seconds)</th>
              <th>Blockers</th>
            </tr>
          </thead>
          <tbody>{view.tasks.map(taskRow.bind(null, props))}</tbody>
        </table>
      </div>
    </section>
  );
}

function taskAnchor(task: string): string {
  return `oven-task-${encodeURIComponent(task)}`;
}

function taskLink(selection: TaskSelection, task: string): React.ReactNode {
  return (
    <a
      key={task}
      href={`#${taskAnchor(task)}`}
      onClick={selection.select.bind(null, task)}
    >
      {task}
    </a>
  );
}

function queueRow(selection: TaskSelection, queue: QueueView): React.ReactNode {
  return (
    <tr
      key={`${queue.kind}:${queue.id}`}
      data-queue={queue.id}
      data-kind={queue.kind}
    >
      <td>{queue.kind}</td>
      <td>{queue.id}</td>
      <td>
        <span>
          {queue.tasks.length} {queue.tasks.length === 1 ? "task" : "tasks"}
        </span>
        <ul>{queue.tasks.map(queueTask.bind(null, selection))}</ul>
      </td>
    </tr>
  );
}

function queueTask(selection: TaskSelection, task: string): React.ReactNode {
  return <li key={task}>{taskLink(selection, task)}</li>;
}

function allocation(
  selection: TaskSelection,
  allocation: ResourceView["allocations"][number],
): React.ReactNode {
  return (
    <li key={`${allocation.task}:${allocation.kind}`}>
      {taskLink(selection, allocation.task)}: {allocation.units}{" "}
      {allocation.kind} since {seconds(allocation.since)} s
    </li>
  );
}

function resourceRow(
  selection: TaskSelection,
  resource: ResourceView,
): React.ReactNode {
  return (
    <tr key={resource.id} data-resource={resource.id}>
      <td>
        {resource.id} ({resource.kind})
      </td>
      <td>{resource.capacity}</td>
      <td>{resource.available ? "Admission enabled" : "Admission withheld"}</td>
      <td>
        {resource.allocations.length === 0 ? (
          "Unallocated"
        ) : (
          <ul>{resource.allocations.map(allocation.bind(null, selection))}</ul>
        )}
      </td>
      <td>
        {resource.position}
        {resource.batchPhase !== null && ` / ${resource.batchPhase}`}
      </td>
    </tr>
  );
}

function reservation(
  selection: TaskSelection,
  reservation: CarrierStoreView["reservations"][number],
): React.ReactNode {
  return (
    <li key={reservation.task}>
      {reservation.carrier}: {taskLink(selection, reservation.task)}
    </li>
  );
}

function storageRow(
  selection: TaskSelection,
  storage: CarrierStoreView,
): React.ReactNode {
  return (
    <tr key={storage.id} data-storage={storage.id}>
      <td>{storage.id}</td>
      <td>{storage.capacity}</td>
      <td>
        {storage.occupants.length}: {storage.occupants.join(", ") || "Empty"}
      </td>
      <td>
        {storage.reservations.length === 0 ? (
          "None"
        ) : (
          <ul>{storage.reservations.map(reservation.bind(null, selection))}</ul>
        )}
      </td>
    </tr>
  );
}

export function seconds(time: number): string {
  return (time / 1_000_000).toFixed(3);
}

export function taskTime(task: TaskView): string {
  switch (task.kind) {
    case "waiting":
      return `Waiting since ${seconds(task.since)}`;
    case "reserved":
      return `Reserved at ${seconds(task.reservedAt)}`;
    case "skipped":
      return `Skipped at ${seconds(task.completedAt)} after ${task.inspection}: ${task.outcome}`;
    case "executing":
      return task.completesAt === null
        ? `Started ${seconds(task.startedAt)}; end awaits physics`
        : `${seconds(task.startedAt)} → ${seconds(task.completesAt)} (scheduled end)`;
    case "completed":
      return `${seconds(task.startedAt)} → ${seconds(task.completedAt)}`;
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
      return `Started ${seconds(task.startedAt)}; failed ${seconds(task.failedAt)}`;
    case "failed":
      return `Failed ${seconds(task.failedAt)}; resolved ${seconds(task.resolvedAt)}`;
    case "cancelled":
      return `Cancelled ${seconds(task.cancelledAt)} by ${task.cause}`;
    default:
      return assertNever(task);
  }
}

function blockerItem(blocker: Blocker, index: number): React.ReactNode {
  return <li key={index}>{blockerDescription(blocker)}</li>;
}

export function blockerDescription(blocker: Blocker): string {
  switch (blocker.kind) {
    case "release":
      return `Release at ${seconds(blocker.at)} seconds`;
    case "inspection":
      return `Inspection required: ${blocker.task}`;
    case "prerequisite":
      return `Prerequisite: ${blocker.task}`;
    case "workers":
      return `No available worker: ${blocker.workers.join(", ")}`;
    case "resource":
      return `Resource ${blocker.resource}: ${blocker.reason}`;
    case "batch-cycle":
      return `Batch resource ${blocker.resource}: ${blocker.reason}`;
    case "configuration":
      return `Resource ${blocker.resource}: requires ${blocker.required}, currently ${blocker.current}`;
    case "material":
      return `Missing ${blocker.missing.amount} ${blocker.missing.unit} of ${blocker.product}`;
    case "carrier":
      return `No available carrier in ${blocker.store}`;
    case "destination":
      return `Destination ${blocker.storage}: capacity unavailable`;
    case "cell-slot":
      return `Cell ${blocker.cell}: carrier slot occupied`;
    case "cell-state":
      return `Cell ${blocker.cell}: physical state unavailable`;
    default:
      return assertNever(blocker);
  }
}

function taskRow(selection: TaskSelection, task: TaskView): React.ReactNode {
  return (
    <tr
      key={task.id}
      id={taskAnchor(task.id)}
      data-task={task.id}
      data-kind={task.kind}
      data-selected={selection.selected === task.id}
    >
      <td>
        <button
          aria-pressed={selection.selected === task.id}
          onClick={selection.select.bind(null, task.id)}
        >
          {taskSubject(task.subject)}
        </button>
        {task.subject.kind === "changeover" && (
          <p>Requested by {taskLink(selection, task.subject.cause)}</p>
        )}
      </td>
      <td>{task.kind}</td>
      <td>{taskTime(task)}</td>
      <td>
        {task.kind === "waiting" ? (
          <ul>{task.blockers.map(blockerItem)}</ul>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

function taskSubject(subject: TaskView["subject"]): React.ReactNode {
  switch (subject.kind) {
    case "workflow":
      return (
        <>
          {subject.instance}
          <br />
          {subject.key}
        </>
      );
    case "changeover":
      return (
        <>
          {subject.resource}
          <br />
          {subject.from} → {subject.to}
        </>
      );
    default:
      return assertNever(subject);
  }
}

export function SelectedOvenTask(props: Readonly<{ task: TaskView }>) {
  const { task } = props;
  return (
    <section aria-label="Selected oven task" data-selected-task={task.id}>
      <h3>{task.id}</h3>
      <p>
        {task.kind} · {taskTime(task)}
      </p>
      {task.kind === "waiting" && <ul>{task.blockers.map(blockerItem)}</ul>}
    </section>
  );
}
