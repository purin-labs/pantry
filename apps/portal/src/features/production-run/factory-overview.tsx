import type React from "react";
import { assertNever } from "@seams/std";
import type {
  CarrierStoreView,
  CompiledScenario,
  HostView,
  ResourceView,
  TaskView,
} from "@seams/production-simulation";
import { seconds, type TaskSelection } from "./oven-logistics";

type Props = TaskSelection &
  Readonly<{
    scenario: CompiledScenario;
    view: Pick<HostView, "time" | "logistics" | "schedulingHistory">;
  }>;

/** A logical floor plan. Every occupant and reservation comes from the host. */
export function FactoryOverview(props: Props): React.ReactNode {
  const { view } = props;
  if (
    props.scenario.id !== "plan-70-recurring-cold-cell" ||
    view.logistics.kind !== "available"
  )
    return null;
  return (
    <section aria-label="Factory overview" data-time={view.time}>
      <h3>Factory overview</h3>
      <p>
        Committed at {seconds(view.time)} seconds. Positions show tray custody
        and reserved arrivals. Each cell has its own physical world.
      </p>
      <div className="factory-positions">
        {view.logistics.carrierStores.map(positionCard.bind(null, props))}
      </div>
      <h4>Transfer route</h4>
      <p>
        Arrows show planned transfers, including tray return. Task buttons show
        current waits and work.
      </p>
      <ol className="factory-transfers">{transferRoute(props)}</ol>
      <h4>Shared resources and equipment</h4>
      <div className="factory-positions">
        {view.logistics.resources.map(resourceCard.bind(null, props))}
      </div>
    </section>
  );
}

function taskButton(selection: TaskSelection, task: string): React.ReactNode {
  return (
    <button
      key={task}
      aria-pressed={selection.selected === task}
      onClick={selection.select.bind(null, task)}
    >
      {task}
    </button>
  );
}

function positionCard(props: Props, store: CarrierStoreView): React.ReactNode {
  let cell: string | null = null;
  for (const definition of props.scenario.storages)
    if (definition.id === store.id) cell = definition.cell;
  const waiting: React.ReactNode[] = [];
  if (props.view.logistics.kind === "available")
    for (const queue of props.view.logistics.queues)
      if (queue.kind === "storage" && queue.id === store.id)
        for (const task of queue.tasks) waiting.push(taskButton(props, task));
  return (
    <article
      key={store.id}
      data-factory-position={store.id}
      data-full={
        store.occupants.length + store.reservations.length === store.capacity
      }
    >
      <h4>{store.id}</h4>
      <p>{cell ?? "Shared floor"}</p>
      <p>
        {store.occupants.length} occupied + {store.reservations.length} reserved
        / {store.capacity} slots
      </p>
      <p>Present: {store.occupants.join(", ") || "Empty"}</p>
      {store.reservations.map(reservationCard.bind(null, props))}
      {waiting.length > 0 && (
        <div>
          <p>Waiting for a slot or tray:</p>
          {waiting}
        </div>
      )}
    </article>
  );
}

function reservationCard(
  selection: TaskSelection,
  reservation: CarrierStoreView["reservations"][number],
): React.ReactNode {
  return (
    <p key={reservation.task}>
      Reserved arrival: {reservation.carrier}{" "}
      {taskButton(selection, reservation.task)}
    </p>
  );
}

function transferRoute(props: Props): React.ReactNode[] {
  const route: React.ReactNode[] = [];
  for (const workflow of props.scenario.workflows)
    for (const definition of workflow.tasks)
      for (const [index, move] of definition.carriers.entries()) {
        if (move.kind !== "move") continue;
        const tasks: React.ReactNode[] = [];
        if (props.view.logistics.kind === "available")
          for (const task of props.view.logistics.tasks)
            if (
              task.subject.kind === "workflow" &&
              task.subject.key === definition.key &&
              activeTask(task)
            )
              tasks.push(
                <li key={task.id}>
                  {taskButton(props, task.id)}: {task.kind}
                </li>,
              );
        route.push(
          <li
            key={`${workflow.id}/${definition.key}/${index}`}
            data-factory-transfer={definition.key}
          >
            <strong>
              {move.from} → {move.to}
            </strong>
            <p>
              {definition.key} ·{" "}
              {definition.executor.kind === "native"
                ? "Physical transfer"
                : "Declared handling"}
            </p>
            {tasks.length > 0 ? <ul>{tasks}</ul> : <p>No active transfer</p>}
          </li>,
        );
      }
  return route;
}

function activeTask(task: TaskView): boolean {
  switch (task.kind) {
    case "waiting":
      for (const blocker of task.blockers)
        if (blocker.kind === "prerequisite" || blocker.kind === "release")
          return false;
      return true;
    case "reserved":
    case "executing":
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
      return true;
    case "completed":
    case "skipped":
    case "failed":
    case "cancelled":
      return false;
    default:
      return assertNever(task);
  }
}

function resourceCard(props: Props, resource: ResourceView): React.ReactNode {
  const tasks: React.ReactNode[] = [];
  for (const allocation of resource.allocations)
    tasks.push(
      <li key={allocation.task}>
        {taskButton(props, allocation.task)}: {allocation.kind} (
        {allocation.units})
      </li>,
    );
  let classification = "No accepted capacity interval";
  if (props.view.schedulingHistory.kind === "available")
    for (const entry of props.view.schedulingHistory.resources) {
      if (entry.resource !== resource.id) continue;
      const last = entry.intervals.at(-1);
      if (last !== undefined)
        classification = `Last interval ${seconds(last.start)}–${seconds(last.end)} s: ${Object.entries(last.units).filter(positiveCategory).map(categoryLabel).join(", ")}`;
    }
  return (
    <article key={resource.id} data-factory-resource={resource.id}>
      <h4>{resource.id}</h4>
      <p>
        {resource.available ? "Admission enabled" : "Admission withheld"} ·{" "}
        {resource.capacity} capacity
      </p>
      {tasks.length > 0 ? <ul>{tasks}</ul> : <p>No current allocation</p>}
      <p>{classification}</p>
    </article>
  );
}
function positiveCategory(entry: [string, number]): boolean {
  return entry[1] > 0;
}
function categoryLabel(entry: [string, number]): string {
  return `${entry[1]} ${entry[0]}`;
}
