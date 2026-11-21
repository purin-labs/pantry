import type { AdmittedScenario } from "./admission.ts";
import { indexDependencies } from "./dependencies.ts";
import { activeWorkerTravelByResource } from "./worker-travel.ts";
import type { AcceptedEvent, ArrivalOrder, DomainEvent } from "./events.ts";
import type {
  ArrivalSourceId,
  CarrierId,
  CellId,
  DestinationId,
  LotId,
  ResourceId,
  StorageId,
  TaskId,
  TaskKey,
  WorkflowId,
  WorkflowInstanceId,
} from "./identity.ts";
import type {
  ArrivalSource,
  PhysicalCellDefinition,
  ReportingDestination,
  ResourceDefinition,
  StorageDefinition,
  TaskDefinition,
  TravelRoute,
  WorkflowDefinition,
} from "./scenario.ts";
import type {
  ArrivalSourceState,
  CarrierState,
  CellState,
  ExecutionIdentity,
  LotState,
  ResourceState,
  RunState,
  RunStatus,
  ScheduledEvent,
  StorageState,
  TaskState,
  WorkflowInstanceState,
} from "./state.ts";
import { advance, repeat, type LogicalTime } from "./time.ts";
import type { Variant } from "@purin-labs/type-utils";

/**
 * One advance works on a draft: the run's records keyed by identity. Records
 * themselves stay immutable and are replaced, so the state an operation was
 * given is never changed. Maps keep creation order, which is saved order.
 * The event history is shared with the state the draft came from, and
 * `emit` copies it before its first append, so a call that emits nothing
 * copies no history.
 */
export type Draft = {
  readonly definition: AdmittedScenario;
  readonly identity: ExecutionIdentity;
  readonly index: ScenarioIndex;
  time: LogicalTime;
  controlRevision: number;
  horizon: LogicalTime;
  status: RunStatus;
  readonly arrivals: Map<ArrivalSourceId, ArrivalSourceState>;
  readonly instances: Map<WorkflowInstanceId, WorkflowInstanceState>;
  readonly tasks: Map<TaskId, TaskState>;
  readonly resources: Map<ResourceId, ResourceState>;
  readonly workerTravel: Map<ResourceId, readonly TravelRoute[]>;
  readonly storages: Map<StorageId, StorageState>;
  readonly carriers: Map<CarrierId, CarrierState>;
  readonly lots: Map<LotId, LotState>;
  readonly cells: Map<CellId, CellState>;
  scheduled: ScheduledEvent[];
  readonly commands: RunState["commands"][number][];
  /** Append only through `emit`. */
  events: readonly AcceptedEvent[];
  /** Whether `events` is still the array of a frozen state. */
  eventsShared: boolean;
};

type ScenarioIndex = Readonly<{
  dependencies: ReadonlyMap<TaskId, readonly TaskId[]>;
  workflows: ReadonlyMap<WorkflowId, WorkflowDefinition>;
  tasks: ReadonlyMap<WorkflowId, ReadonlyMap<TaskKey, TaskDefinition>>;
  resources: ReadonlyMap<ResourceId, ResourceDefinition>;
  storages: ReadonlyMap<StorageId, StorageDefinition>;
  destinations: ReadonlyMap<DestinationId, ReportingDestination>;
  sources: ReadonlyMap<ArrivalSourceId, ArrivalSource>;
  cells: ReadonlyMap<CellId, PhysicalCellDefinition>;
}>;

export type WorkflowTask = TaskState &
  Readonly<{ subject: Variant<TaskState["subject"], "workflow"> }>;

export function isWorkflowTask(task: TaskState): task is WorkflowTask {
  return task.subject.kind === "workflow";
}

function byId<Value extends Readonly<{ id: string }>>(
  values: readonly Value[],
): Map<Value["id"], Value> {
  const result = new Map<Value["id"], Value>();
  for (const value of values) result.set(value.id, value);
  return result;
}

// An admitted scenario is immutable, so its index is built once.
const indexes = new WeakMap<AdmittedScenario, ScenarioIndex>();

function indexScenario(definition: AdmittedScenario): ScenarioIndex {
  const known = indexes.get(definition);
  if (known !== undefined) return known;
  const { scenario } = definition;
  const tasks = new Map<WorkflowId, ReadonlyMap<TaskKey, TaskDefinition>>();
  for (const workflow of scenario.workflows) {
    const keyed = new Map<TaskKey, TaskDefinition>();
    for (const task of workflow.tasks) keyed.set(task.key, task);
    tasks.set(workflow.id, keyed);
  }
  const index: ScenarioIndex = {
    dependencies: indexDependencies(scenario.dependencies),
    workflows: byId(scenario.workflows),
    tasks,
    resources: byId(scenario.resources),
    storages: byId(scenario.storages),
    destinations: byId(scenario.destinations),
    sources: byId(scenario.arrivals),
    cells: byId(scenario.cells),
  };
  indexes.set(definition, index);
  return index;
}

export function thaw(run: RunState): Draft {
  return {
    definition: run.definition,
    identity: run.identity,
    index: indexScenario(run.definition),
    time: run.position.time,
    controlRevision: run.position.controlRevision,
    horizon: run.position.horizon,
    status: run.status,
    arrivals: byId(run.arrivals),
    instances: byId(run.instances),
    tasks: byId(run.tasks),
    resources: byId(run.resources),
    workerTravel: activeWorkerTravelByResource(run),
    storages: byId(run.storages),
    carriers: byId(run.carriers),
    lots: byId(run.lots),
    cells: byId(run.cells),
    scheduled: [...run.scheduled],
    commands: [...run.commands],
    events: run.events,
    eventsShared: true,
  };
}

/**
 * The run state the draft holds now. The draft stays usable: the state keeps
 * its own copy of every collection that the draft can still change.
 */
export function freeze(draft: Draft): RunState {
  return {
    identity: draft.identity,
    definition: draft.definition,
    position: {
      time: draft.time,
      eventSequence: draft.events.length,
      controlRevision: draft.controlRevision,
      horizon: draft.horizon,
    },
    status: draft.status,
    arrivals: [...draft.arrivals.values()],
    instances: [...draft.instances.values()],
    tasks: [...draft.tasks.values()],
    resources: [...draft.resources.values()],
    storages: [...draft.storages.values()],
    carriers: [...draft.carriers.values()],
    lots: [...draft.lots.values()],
    cells: [...draft.cells.values()],
    scheduled: [...draft.scheduled],
    commands: [...draft.commands],
    events: shareEvents(draft),
  };
}

function shareEvents(draft: Draft): readonly AcceptedEvent[] {
  draft.eventsShared = true;
  return draft.events;
}

/** Appends one accepted event at `time`, numbered from one. */
export function emit(
  draft: Draft,
  time: LogicalTime,
  event: DomainEvent,
): void {
  const events: AcceptedEvent[] = draft.eventsShared
    ? [...draft.events]
    : (draft.events as AcceptedEvent[]);
  events.push({
    sequence: events.length + 1,
    time,
    execution: draft.identity.executionId,
    ...event,
  });
  draft.events = events;
  draft.eventsShared = false;
}

/** A record the run must hold. Its absence is an engine fault, not input. */
export function held<Key, Value>(
  records: ReadonlyMap<Key, Value>,
  id: Key,
  subject: string,
): Value {
  const value = records.get(id);
  if (value === undefined)
    throw new Error(`The run holds no ${subject} ${String(id)}`);
  return value;
}

/** The definition a workflow task was instantiated from. */
export function taskDefinition(
  draft: Draft,
  instance: WorkflowInstanceState,
  key: TaskKey,
): TaskDefinition {
  return held(
    held(draft.index.tasks, instance.workflow, "workflow"),
    key,
    "task definition",
  );
}

/** The arrival order a task dispatches and settles by. */
export function arrivalOf(draft: Draft, task: TaskState): ArrivalOrder {
  const subject = task.subject;
  if (subject.kind === "workflow")
    return held(draft.instances, subject.instance, "instance").arrival;
  // A changeover serves the task that needs it and takes its place in order.
  return arrivalOf(draft, held(draft.tasks, subject.cause, "task"));
}

/** When a source creates its instance numbered `sequence`, or null if never. */
export function arrivalTime(
  source: ArrivalSource,
  sequence: number,
): LogicalTime | null {
  if (source.kind === "periodic") {
    const time = advance(source.first, repeat(source.interval, sequence));
    return source.limit.kind === "count"
      ? sequence < source.limit.count
        ? time
        : null
      : time <= source.limit.end
        ? time
        : null;
  }
  let before = 0;
  for (const arrival of source.arrivals) {
    if (sequence < before + arrival.quantity) return arrival.time;
    before += arrival.quantity;
  }
  return null;
}
