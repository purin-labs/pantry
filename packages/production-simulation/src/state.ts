import type { StrictUnion } from "@seams/type-utils";
import type { AdmittedScenario } from "./admission.ts";
import type {
  CommandReceipt,
  ControlCommand,
  RecoveryRequest,
} from "./commands.ts";
import type { AcceptedEvent, ArrivalOrder, OrderKey } from "./events.ts";
import type {
  ArrivalSourceId,
  AttemptId,
  AvailabilityId,
  BatchProgramId,
  CarrierId,
  CarrierRole,
  CellId,
  CommandId,
  ConfigurationId,
  ExecutionId,
  HostSessionId,
  LotId,
  LotKey,
  LocationId,
  ProductId,
  ResourceId,
  RunId,
  Sha256Hex,
  SnapshotId,
  StorageId,
  TaskId,
  TaskKey,
  WorkflowId,
  WorkflowInstanceId,
} from "./identity.ts";
import type {
  AttemptLifecycle,
  BoundaryCandidate,
  CarrierDisposition,
  CarrierSlot,
  CommittedCell,
  DispatchOrigin,
  ExecutionNeed,
  HoldState,
  NativeEvent,
  PendingProgress,
  Terminal,
} from "./physics.ts";
import type { MaterialQuantity } from "./quantity.ts";
import type { Interval, LogicalTime, StepCount } from "./time.ts";

/**
 * The records one run owns. Hosts hold this state and pass it to the engine;
 * views read projections of it and can never change it.
 */

/**
 * `runId` is production ancestry. `executionId` is one writer: a fresh-host
 * continuation receives a new one and records what it continued from.
 */
export type ExecutionIdentity = Readonly<{
  runId: RunId;
  executionId: ExecutionId;
  /** The one host session that may command this execution. */
  hostSession: HostSessionId;
  /** The approved bundle its physics runs through; null without a cell. */
  bundle: Sha256Hex | null;
  parent: Readonly<{
    snapshot: SnapshotId;
    execution: ExecutionId;
  }> | null;
}>;

/**
 * `time` is the latest timestamp the engine has fully processed. Pause,
 * resume and recovery use that boundary; other commands use the next tick.
 */
export type RunPosition = Readonly<{
  time: LogicalTime;
  eventSequence: number;
  controlRevision: number;
  horizon: LogicalTime;
}>;

/** Why a task cannot start. Each names the record that must change. */
export type Blocker = StrictUnion<
  | Readonly<{
      kind: "batch-cycle";
      resource: ResourceId;
      reason: "loading" | "running" | "unloading" | "closed" | "program";
    }>
  | Readonly<{ kind: "release"; at: LogicalTime }>
  | Readonly<{
      kind: "workers";
      workers: readonly [ResourceId, ...ResourceId[]];
    }>
  | Readonly<{ kind: "prerequisite"; task: TaskId }>
  | Readonly<{ kind: "inspection"; task: TaskId }>
  | Readonly<{
      kind: "resource";
      resource: ResourceId;
      reason: "capacity" | "unavailable" | "held";
    }>
  | Readonly<{
      kind: "configuration";
      resource: ResourceId;
      required: ConfigurationId;
      current: ConfigurationId;
    }>
  | Readonly<{
      kind: "material";
      product: ProductId;
      missing: MaterialQuantity;
    }>
  | Readonly<{ kind: "carrier"; store: StorageId }>
  | Readonly<{ kind: "destination"; storage: StorageId }>
  | Readonly<{ kind: "cell-slot"; cell: CellId }>
  | Readonly<{ kind: "cell-state"; cell: CellId }>
>;

/**
 * What a task is: a step of a workflow instance, or a changeover the engine
 * created for the waiting task named as its cause.
 */
export type TaskSubject =
  | Readonly<{
      kind: "workflow";
      instance: WorkflowInstanceId;
      key: TaskKey;
    }>
  | Readonly<{
      kind: "changeover";
      resource: ResourceId;
      from: ConfigurationId;
      to: ConfigurationId;
      cause: TaskId;
    }>;

export type TaskState = Readonly<{
  id: TaskId;
  subject: TaskSubject;
}> &
  StrictUnion<
    | Readonly<{
        kind: "waiting";
        since: LogicalTime;
        blockers: readonly Blocker[];
      }>
    | Readonly<{ kind: "reserved"; reservedAt: LogicalTime }>
    | Readonly<{
        kind: "skipped";
        completedAt: LogicalTime;
        inspection: TaskId;
        outcome: "accept" | "reject";
      }>
    | Readonly<{
        kind: "executing";
        startedAt: LogicalTime;
        /** Present for native work: the exact attempt awaiting evidence. */
        attempt: AttemptId | null;
        /** Known at dispatch for declared work, unknown for native work. */
        completesAt: LogicalTime | null;
      }>
    | Readonly<{
        kind: "completed";
        startedAt: LogicalTime;
        completedAt: LogicalTime;
      }>
    | Readonly<{
        kind: "recovery-required";
        startedAt: LogicalTime;
        failedAt: LogicalTime;
        attempt: AttemptId;
        disposition: CarrierDisposition;
      }>
    | Readonly<{
        kind: "recovering";
        startedAt: LogicalTime;
        failedAt: LogicalTime;
        attempt: AttemptId;
        disposition: CarrierDisposition;
        recovery: RecoveryState;
      }>
    | Readonly<{
        kind: "recovery-failed";
        startedAt: LogicalTime;
        failedAt: LogicalTime;
        attempt: AttemptId;
        disposition: CarrierDisposition;
        recovery: RecoveryState;
      }>
    | Readonly<{
        kind: "failed";
        startedAt: LogicalTime;
        failedAt: LogicalTime;
        attempt: AttemptId;
        disposition: CarrierDisposition;
        resolvedAt: LogicalTime;
      }>
    | Readonly<{ kind: "cancelled"; cause: TaskId; cancelledAt: LogicalTime }>
  >;

export type RecoveryState = RecoveryRequest &
  Readonly<{
    command: CommandId;
    attempt: AttemptId;
    carrier: CarrierId;
    startedAt: LogicalTime;
    arrivesAt: LogicalTime;
    removesAt: LogicalTime;
    phase: "handling" | "returning";
  }>;

/**
 * One claim on a resource's capacity. A reservation precedes execution, an
 * occupation lasts while the task runs, and a hold survives a failure.
 */
export type Allocation = Readonly<{
  task: TaskId;
  units: number;
  kind: "reserved" | "occupied" | "held";
  since: LogicalTime;
}>;

/** An assignment persists through the approach and the complete work interval. */
export type WorkerAssignment = Readonly<{
  task: TaskId;
  from: LocationId;
  start: LocationId;
  finish: LocationId;
  arrivesAt: LogicalTime;
  completesAt: LogicalTime;
}>;

export type ResourcePosition = StrictUnion<
  | Readonly<{ kind: "fixed" }>
  | Readonly<{ kind: "idle"; at: LocationId }>
  | (Readonly<{ kind: "assigned" }> & WorkerAssignment)
>;

export type ResourceState = Readonly<{
  id: ResourceId;
  position: ResourcePosition;
  batch: BatchState | null;
  configuration: ConfigurationId | null;
  /** Changeover tasks this resource has started, for their identities. */
  changeovers: number;
  allocations: readonly Allocation[];
  /** Declared and commanded intervals in which no new task may start. */
  withheld: readonly Readonly<{
    cause: AvailabilityId | CommandId;
    interval: Interval;
  }>[];
}>;

export type BatchMember = Readonly<{ task: TaskId; carrier: CarrierId }>;
export type BatchState = Readonly<{ sequence: number }> &
  StrictUnion<
    | Readonly<{ kind: "idle" }>
    | Readonly<{
        kind: "loading";
        program: BatchProgramId;
        openedAt: LogicalTime;
        closeAt: LogicalTime;
        members: readonly [BatchMember, ...BatchMember[]];
      }>
    | Readonly<{
        kind: "running";
        program: BatchProgramId;
        startedAt: LogicalTime;
        completesAt: LogicalTime;
        members: readonly [BatchMember, ...BatchMember[]];
      }>
    | Readonly<{
        kind: "unloading";
        program: BatchProgramId;
        completedAt: LogicalTime;
        members: readonly [BatchMember, ...BatchMember[]];
      }>
  >;

/**
 * Occupancy is material actually present. A reservation is capacity promised
 * to an arriving carrier before it leaves its source. Together they never
 * exceed the position's capacity.
 */
export type StorageState = Readonly<{
  id: StorageId;
  occupants: readonly CarrierId[];
  reservations: readonly Readonly<{ task: TaskId; carrier: CarrierId }>[];
}>;

/** A carrier is in exactly one custody location at any logical time. */
export type CarrierCustody =
  | Readonly<{ kind: "stored"; storage: StorageId }>
  | Readonly<{
      kind: "transport";
      task: TaskId;
      from: StorageId;
      to: StorageId;
    }>
  | Readonly<{ kind: "unknown"; task: TaskId; lastKnown: StorageId }>;

export type CarrierState = Readonly<{
  id: CarrierId;
  custody: CarrierCustody;
  bound: Readonly<{
    instance: WorkflowInstanceId;
    role: CarrierRole;
  }> | null;
}>;

export type LotState = Readonly<{
  id: LotId;
  product: ProductId;
  /** What remains in the lot, including quantity claimed but not yet consumed. */
  remaining: MaterialQuantity;
  claims: readonly Readonly<{ task: TaskId; quantity: MaterialQuantity }>[];
  /** Lots consumed to produce this one. */
  lineage: readonly LotId[];
  origin:
    | Readonly<{ kind: "initial-stock" }>
    | Readonly<{ kind: "produced"; task: TaskId; at: LogicalTime }>;
  /** A held lot cannot fulfil a claim. */
  disposition: "held" | "released";
  holder:
    | Readonly<{ kind: "storage"; storage: StorageId }>
    | Readonly<{ kind: "carrier"; carrier: CarrierId }>;
}>;

export type WorkflowInstanceState = Readonly<{
  id: WorkflowInstanceId;
  workflow: WorkflowId;
  demand: "order" | "production";
  arrival: ArrivalOrder;
  carriers: readonly Readonly<{ role: CarrierRole; carrier: CarrierId }>[];
  lots: readonly Readonly<{ key: LotKey; lot: LotId }>[];
}> &
  StrictUnion<
    | Readonly<{ kind: "open" }>
    | Readonly<{ kind: "completed"; completedAt: LogicalTime }>
    | Readonly<{ kind: "failed"; failedAt: LogicalTime; cause: TaskId }>
  >;

/**
 * `next` is the sequence of the next instance this source creates. Closing a
 * source stops future arrivals; orders that already arrived stay eligible.
 */
export type ArrivalSourceState = Readonly<{
  id: ArrivalSourceId;
  next: number;
}> &
  StrictUnion<
    | Readonly<{ kind: "open" }>
    | Readonly<{ kind: "exhausted" }>
    | Readonly<{ kind: "closed"; closedAt: LogicalTime; command: CommandId }>
  >;

/**
 * One physical world. `committed` is real state at the accepted boundary;
 * `pending` is later computed progress that has not been applied.
 */
export type CellState = Readonly<{
  id: CellId;
  slot: CarrierSlot;
  committed: CommittedCell;
  pending: PendingProgress | null;
  hold: HoldState;
  attempt: Readonly<{
    id: AttemptId;
    task: TaskId;
    dispatchedAt: LogicalTime;
    /** The exact state the attempt was dispatched from. */
    startingCheckpoint: Sha256Hex;
    origin: DispatchOrigin;
    lifecycle: AttemptLifecycle;
    /** Accepted steps since dispatch, and accepted segments by sequence. */
    steps: StepCount;
    segments: readonly Sha256Hex[];
  }> | null;
  /** Boundary changes prepared against this state and not yet committed. */
  prepared: readonly BoundaryCandidate[];
}>;

/** A transition already known to occur at a future logical time. */
export type ScheduledEvent = Readonly<{ order: OrderKey }> &
  StrictUnion<
    | Readonly<{
        kind: "task-boundary";
        task: TaskId;
        /** The carrier step a pickup or placement belongs to. */
        carrierStep: number | null;
      }>
    | Readonly<{ kind: "native-event"; task: TaskId; event: NativeEvent }>
    | Readonly<{ kind: "native-terminal"; task: TaskId; terminal: Terminal }>
    | Readonly<{
        kind: "availability-edge";
        resource: ResourceId;
        cause: AvailabilityId | CommandId;
      }>
    | Readonly<{ kind: "command"; command: CommandId }>
    | Readonly<{ kind: "hold-expiry"; cell: CellId }>
    | Readonly<{ kind: "hold-entry"; cell: CellId }>
  >;

export type RunStatus = StrictUnion<
  /** Created; time zero has not been processed. */
  | Readonly<{ kind: "ready" }>
  /** Able to process the next timestamp. */
  | Readonly<{ kind: "advancing" }>
  | Readonly<{ kind: "awaiting-inspection"; task: TaskId }>
  /** Logical time waits on this exact evidence from physics. */
  | Readonly<{ kind: "awaiting-execution"; need: ExecutionNeed }>
  | Readonly<{ kind: "pause-requested"; command: CommandId }>
  | Readonly<{ kind: "paused"; command: CommandId; boundary: LogicalTime }>
  /** Unfinished work with no scheduled event able to release it. */
  | Readonly<{ kind: "blocked"; tasks: readonly [TaskId, ...TaskId[]] }>
  | Readonly<{ kind: "completed"; completedAt: LogicalTime }>
  | Readonly<{
      kind: "stopped-at-limit";
      limit: "horizon" | "events";
      unfinished: readonly TaskId[];
    }>
>;

export type RunState = Readonly<{
  identity: ExecutionIdentity;
  definition: AdmittedScenario;
  position: RunPosition;
  status: RunStatus;
  arrivals: readonly ArrivalSourceState[];
  instances: readonly WorkflowInstanceState[];
  tasks: readonly TaskState[];
  resources: readonly ResourceState[];
  storages: readonly StorageState[];
  carriers: readonly CarrierState[];
  lots: readonly LotState[];
  cells: readonly CellState[];
  scheduled: readonly ScheduledEvent[];
  /** Admitted commands and their receipts, kept to deduplicate redelivery. */
  commands: readonly Readonly<{
    command: ControlCommand;
    receipt: CommandReceipt;
  }>[];
  events: readonly AcceptedEvent[];
}>;

/**
 * Whether production has drained. It has only when every source is closed or
 * exhausted and every arrived instance is complete or resolved as failed,
 * with no carrier in use.
 */
export type DrainStatus =
  | Readonly<{ kind: "drained"; at: LogicalTime }>
  | Readonly<{
      kind: "draining";
      openSources: readonly ArrivalSourceId[];
      openInstances: readonly WorkflowInstanceId[];
      boundCarriers: readonly CarrierId[];
    }>
  | Readonly<{
      kind: "blocked";
      tasks: readonly [TaskId, ...TaskId[]];
    }>;

export function drainStatus(run: RunState): DrainStatus {
  if (run.status.kind === "blocked")
    return { kind: "blocked", tasks: run.status.tasks };
  const openSources: ArrivalSourceId[] = [];
  for (const source of run.arrivals)
    if (source.kind === "open") openSources.push(source.id);
  const openInstances: WorkflowInstanceId[] = [];
  for (const instance of run.instances)
    if (instance.kind === "open") openInstances.push(instance.id);
  const boundCarriers: CarrierId[] = [];
  for (const carrier of run.carriers)
    if (carrier.bound !== null || carrier.custody.kind !== "stored")
      boundCarriers.push(carrier.id);
  return openSources.length + openInstances.length + boundCarriers.length === 0
    ? { kind: "drained", at: run.position.time }
    : { kind: "draining", openSources, openInstances, boundCarriers };
}
