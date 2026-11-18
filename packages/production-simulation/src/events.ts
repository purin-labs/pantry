import { assertNever } from "@seams/std";
import type {
  ArrivalSourceId,
  AttemptId,
  AvailabilityId,
  BatchProgramId,
  BoundaryId,
  CarrierId,
  CarrierRole,
  CellId,
  CommandId,
  ConfigurationId,
  DestinationId,
  ExecutionId,
  HoldModelId,
  LotId,
  ProductId,
  ResourceId,
  Sha256Hex,
  StorageId,
  TaskId,
  WorkflowInstanceId,
} from "./identity.ts";
import type { CarrierDisposition } from "./physics.ts";
import type { MaterialQuantity } from "./quantity.ts";
import type { ReportingRole } from "./scenario.ts";
import type { LogicalTime, StepCount } from "./time.ts";
import type { StorageState, WorkerAssignment } from "./state.ts";
import type { TaskWait } from "./scheduling-history.ts";

/** Where an instance stands in arrival order: time, then source, then sequence. */
export type ArrivalOrder = Readonly<{
  time: LogicalTime;
  source: ArrivalSourceId;
  sequence: number;
}>;

/**
 * A task, material, resource, arrival or control transition. Physics samples,
 * segment acknowledgements and time-frontier updates are not domain events.
 */
export type DomainEvent =
  /** A rule took a decision. An operator's decision is its command. */
  | Readonly<{
      kind: "decision-taken";
      task: TaskId;
      outcome: "accept" | "reject";
    }>
  | Readonly<{
      kind: "task-skipped";
      task: TaskId;
      inspection: TaskId;
      outcome: "accept" | "reject";
    }>
  | Readonly<{ kind: "waiting-changed"; waiting: readonly TaskWait[] }>
  | Readonly<{
      kind: "storage-changed";
      storage: StorageId;
      occupants: StorageState["occupants"];
      reservations: StorageState["reservations"];
    }>
  | Readonly<{
      kind: "resource-claimed";
      resource: ResourceId;
      task: TaskId;
      allocation: "reserved" | "occupied" | "held";
      units: number;
    }>
  | Readonly<{ kind: "resource-released"; resource: ResourceId; task: TaskId }>
  | Readonly<{
      kind: "batch-member-rejected";
      resource: ResourceId;
      cycle: number;
      task: TaskId;
      carrier: CarrierId;
      recovery: TaskId;
    }>
  | Readonly<{
      kind: "batch-admitted";
      resource: ResourceId;
      cycle: number;
      program: BatchProgramId;
      task: TaskId;
      carrier: CarrierId;
      closeAt: LogicalTime;
    }>
  | Readonly<{
      kind: "batch-started";
      resource: ResourceId;
      cycle: number;
      program: BatchProgramId;
      completesAt: LogicalTime;
    }>
  | Readonly<{
      kind: "batch-completed" | "batch-cleared";
      resource: ResourceId;
      cycle: number;
    }>
  | (Readonly<{ kind: "worker-assigned"; worker: ResourceId }> &
      WorkerAssignment)
  | Readonly<{
      kind: "recovery-started";
      task: TaskId;
      command: CommandId;
      attempt: AttemptId;
    }>
  | Readonly<{
      kind: "recovery-completed" | "recovery-failed";
      task: TaskId;
      attempt: AttemptId;
    }>
  | Readonly<{
      kind: "instance-arrived";
      instance: WorkflowInstanceId;
      source: ArrivalSourceId;
      arrival: number;
    }>
  | Readonly<{ kind: "task-reserved"; task: TaskId }>
  | Readonly<{ kind: "task-started"; task: TaskId; attempt: AttemptId | null }>
  | Readonly<{
      kind: "task-completed";
      task: TaskId;
      attempt: AttemptId | null;
    }>
  | Readonly<{
      kind: "task-failed";
      task: TaskId;
      attempt: AttemptId;
      disposition: CarrierDisposition;
    }>
  | Readonly<{
      kind: "carrier-acquired";
      carrier: CarrierId;
      instance: WorkflowInstanceId;
      role: CarrierRole;
    }>
  | Readonly<{
      kind: "carrier-picked-up";
      carrier: CarrierId;
      task: TaskId;
      from: StorageId;
    }>
  | Readonly<{
      kind: "carrier-placed";
      carrier: CarrierId;
      task: TaskId;
      to: StorageId;
    }>
  | Readonly<{
      kind: "carrier-released";
      carrier: CarrierId;
      instance: WorkflowInstanceId;
    }>
  | Readonly<{
      kind: "lot-produced";
      lot: LotId;
      product: ProductId;
      quantity: MaterialQuantity;
      task: TaskId;
    }>
  | Readonly<{
      kind: "lot-consumed";
      lot: LotId;
      quantity: MaterialQuantity;
      task: TaskId;
    }>
  | Readonly<{ kind: "lot-released"; lot: LotId; task: TaskId }>
  | Readonly<{
      kind: "quantity-reported";
      destination: DestinationId;
      role: ReportingRole;
      product: ProductId;
      quantity: MaterialQuantity;
      task: TaskId;
    }>
  | Readonly<{ kind: "order-completed"; instance: WorkflowInstanceId }>
  | Readonly<{
      kind: "configuration-changed";
      resource: ResourceId;
      from: ConfigurationId;
      to: ConfigurationId;
      /** The changeover task whose completion made the change. */
      task: TaskId;
    }>
  | Readonly<{
      kind: "availability-changed";
      resource: ResourceId;
      available: boolean;
      cause: AvailabilityId | CommandId;
    }>
  | Readonly<{
      kind: "command-admitted";
      command: CommandId;
      controlRevision: number;
    }>
  | Readonly<{ kind: "arrivals-closed"; source: ArrivalSourceId }>
  | Readonly<{
      kind: "cell-committed";
      cell: CellId;
      checkpoint: Sha256Hex;
      boundary: BoundaryId | null;
    }>
  /** A cell entered or left a settled hold: where its steps stop counting time. */
  | Readonly<{
      kind: "cell-hold";
      cell: CellId;
      state: "entered" | "left";
      model: HoldModelId;
    }>
  | Readonly<{ kind: "limit-reached"; limit: "horizon" | "events" }>;

/**
 * An ordered, immutable transition. `execution` records where it originated,
 * so a continuation's events stay distinct from the history it inherited.
 */
export type AcceptedEvent = Readonly<{
  sequence: number;
  time: LogicalTime;
  execution: ExecutionId;
}> &
  DomainEvent;

/**
 * The position of one transition within a timestamp. Both hosts sort with
 * {@link compareOrder}, so equal inputs give equal event order everywhere.
 *
 * At a timestamp the engine settles known completions, custody changes and
 * releases; then applies commands, scheduled availability and due arrivals;
 * then allocates and dispatches by priority, arrival order and task identity.
 */
export type OrderKey = Readonly<{ time: LogicalTime }> &
  (
    | Readonly<{
        phase: "settle";
        origin: "native";
        cell: CellId;
        attempt: AttemptId;
        step: StepCount;
        controllerSequence: number;
      }>
    | Readonly<{
        phase: "settle";
        origin: "declared";
        /** A changeover task orders by the arrival of the task it serves. */
        arrival: ArrivalOrder;
        task: TaskId;
        /** A declared task's own boundaries, in the order they occur. */
        boundary: "pickup" | "placement" | "completion";
      }>
    /** A settled hold reaching the end of its qualification. */
    | Readonly<{ phase: "control"; origin: "hold"; cell: CellId }>
    | Readonly<{ phase: "control"; origin: "command"; admission: number }>
    | Readonly<{
        phase: "control";
        origin: "availability";
        /** The declared interval or the command that withheld the resource. */
        cause: AvailabilityId | CommandId;
        edge: "end" | "start";
      }>
    | Readonly<{ phase: "control"; origin: "arrival"; arrival: ArrivalOrder }>
    | Readonly<{
        phase: "dispatch";
        /** The lower value dispatches first. */
        priority: number;
        arrival: ArrivalOrder;
        task: TaskId;
      }>
  );

const PHASES = { settle: 0, control: 1, dispatch: 2 } as const;
const SETTLE_ORIGINS = { native: 0, declared: 1 } as const;
const CONTROL_ORIGINS = {
  hold: 0,
  command: 1,
  availability: 2,
  arrival: 3,
} as const;
const BOUNDARIES = { pickup: 0, placement: 1, completion: 2 } as const;
const EDGES = { end: 0, start: 1 } as const;

// Code-unit order: a locale-aware comparison could differ between hosts.
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareArrival(left: ArrivalOrder, right: ArrivalOrder): number {
  return (
    left.time - right.time ||
    compareText(left.source, right.source) ||
    left.sequence - right.sequence
  );
}

/** A total order over transitions: negative when `left` applies first. */
export function compareOrder(left: OrderKey, right: OrderKey): number {
  const head =
    left.time - right.time || PHASES[left.phase] - PHASES[right.phase];
  if (head !== 0) return head;
  switch (left.phase) {
    case "settle":
      if (right.phase !== "settle") return 0;
      if (left.origin !== right.origin)
        return SETTLE_ORIGINS[left.origin] - SETTLE_ORIGINS[right.origin];
      if (left.origin === "native" && right.origin === "native")
        return (
          compareText(left.cell, right.cell) ||
          compareText(left.attempt, right.attempt) ||
          left.step - right.step ||
          left.controllerSequence - right.controllerSequence
        );
      if (left.origin === "declared" && right.origin === "declared")
        return (
          compareArrival(left.arrival, right.arrival) ||
          compareText(left.task, right.task) ||
          BOUNDARIES[left.boundary] - BOUNDARIES[right.boundary]
        );
      return 0;
    case "control":
      if (right.phase !== "control") return 0;
      if (left.origin !== right.origin)
        return CONTROL_ORIGINS[left.origin] - CONTROL_ORIGINS[right.origin];
      if (left.origin === "hold" && right.origin === "hold")
        return compareText(left.cell, right.cell);
      if (left.origin === "command" && right.origin === "command")
        return left.admission - right.admission;
      if (left.origin === "availability" && right.origin === "availability")
        return (
          EDGES[left.edge] - EDGES[right.edge] ||
          compareText(left.cause, right.cause)
        );
      if (left.origin === "arrival" && right.origin === "arrival")
        return compareArrival(left.arrival, right.arrival);
      return 0;
    case "dispatch":
      if (right.phase !== "dispatch") return 0;
      return (
        left.priority - right.priority ||
        compareArrival(left.arrival, right.arrival) ||
        compareText(left.task, right.task)
      );
    default:
      return assertNever(left, "Unexpected order phase");
  }
}
