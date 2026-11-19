import { setStorage } from "./engine-storage.ts";
import type { Variant } from "@purin-labs/type-utils";
import { emit, held, type Draft, type WorkflowTask } from "./engine-draft.ts";
import {
  boundaryId,
  type BoundaryId,
  type CarrierId,
  type CarrierRole,
  type CellId,
  type StorageId,
} from "./identity.ts";
import {
  activateSlot,
  deactivateSlot,
  type BoundaryOperation,
  type BoundaryRequest,
  type CarrierDisposition,
  type CarrierSlot,
} from "./physics.ts";
import type { CarrierStep, TaskDefinition } from "./scenario.ts";
import type { Blocker, CarrierState, WorkflowInstanceState } from "./state.ts";
import {
  advance as later,
  elapsed,
  type LogicalTime,
  type TickDuration,
} from "./time.ts";

/**
 * Carriers and their custody. A carrier is in one place at any logical time:
 * a named position, or the task transporting it. Entering or leaving a cell
 * commits the cell's own state with the custody change, or neither.
 */

type Move = Variant<CarrierStep, "move">;

/**
 * Raised when a timestamp reaches a carrier's admission or removal and the
 * physics host has not yet prepared it. The timestamp is abandoned unapplied
 * and processed again once the candidate arrives.
 */
export class BoundaryRequired extends Error {
  readonly request: BoundaryRequest;

  constructor(request: BoundaryRequest) {
    super(`Boundary ${request.boundary} awaits its prepared candidate`);
    this.request = request;
  }
}

export function sameSlot(left: CarrierSlot, right: CarrierSlot): boolean {
  return (
    left.kind === right.kind &&
    left.generation === right.generation &&
    left.carrier === right.carrier
  );
}

/** The slot a boundary change must produce, or null if the slot forbids it. */
export function slotAfter(
  slot: CarrierSlot,
  operation: BoundaryOperation,
): CarrierSlot | null {
  const changed =
    operation.kind === "admission"
      ? activateSlot(slot, operation.carrier)
      : deactivateSlot(slot, operation.carrier);
  return changed.ok ? changed.value : null;
}

function cellOf(draft: Draft, storage: StorageId): CellId | null {
  return held(draft.index.storages, storage, "storage").cell;
}

function moveAt(definition: TaskDefinition, carrierStep: number): Move {
  const step = definition.carriers[carrierStep];
  if (step === undefined || step.kind !== "move")
    throw new Error(`Task ${definition.key} has no move at ${carrierStep}`);
  return step;
}

/** The carrier an instance holds in a role. Admission ordered the route. */
export function boundCarrier(
  draft: Draft,
  instance: WorkflowInstanceState,
  role: CarrierRole,
): CarrierState {
  for (const binding of instance.carriers)
    if (binding.role === role)
      return held(draft.carriers, binding.carrier, "carrier");
  throw new Error(`Instance ${instance.id} holds no carrier as ${role}`);
}

function freeCarrier(
  draft: Draft,
  storage: StorageId,
  taken: ReadonlySet<CarrierId>,
): CarrierState | null {
  for (const id of held(draft.storages, storage, "storage").occupants) {
    const carrier = held(draft.carriers, id, "carrier");
    if (carrier.bound === null && !taken.has(id)) return carrier;
  }
  return null;
}

/** Whether a carrier holds the cell's slot or is already on its way in. */
function cellClaimed(draft: Draft, cell: CellId): boolean {
  if (held(draft.cells, cell, "cell").slot.kind === "active") return true;
  for (const storage of draft.storages.values())
    if (cellOf(draft, storage.id) === cell && storage.reservations.length > 0)
      return true;
  return false;
}

/** What a task's carrier steps and native cell need before it can start. */
export function carrierBlockers(
  draft: Draft,
  definition: TaskDefinition,
): Blocker[] {
  const blockers: Blocker[] = [];
  const taken = new Set<CarrierId>();
  for (const step of definition.carriers) {
    if (step.kind === "acquire") {
      const carrier = freeCarrier(draft, step.from, taken);
      if (carrier === null)
        blockers.push({ kind: "carrier", store: step.from });
      else taken.add(carrier.id);
      continue;
    }
    if (step.kind !== "move") continue;
    const capacity = held(draft.index.storages, step.to, "storage").capacity;
    const destination = held(draft.storages, step.to, "storage");
    if (
      capacity.kind !== "carriers" ||
      destination.occupants.length + destination.reservations.length >=
        capacity.slots
    )
      blockers.push({ kind: "destination", storage: step.to });
    const entered = cellOf(draft, step.to);
    if (entered === null || cellOf(draft, step.from) === entered) continue;
    if (held(draft.cells, entered, "cell").hold.kind === "unresolved")
      blockers.push({ kind: "cell-state", cell: entered });
    else if (cellClaimed(draft, entered))
      blockers.push({ kind: "cell-slot", cell: entered });
  }
  if (definition.executor.kind === "native") {
    const cell = held(draft.cells, definition.executor.operation.cell, "cell");
    if (cell.attempt !== null || cell.hold.kind === "unresolved")
      blockers.push({ kind: "cell-state", cell: cell.id });
  }
  return blockers;
}

/**
 * Binds acquired carriers and reserves every destination before any pickup.
 * A declared move schedules its own pickup and placement; a native move
 * waits for the controller to evidence them.
 */
export function bindCarriers(
  draft: Draft,
  time: LogicalTime,
  workAt: LogicalTime,
  task: WorkflowTask,
  definition: TaskDefinition,
): void {
  let instance = held(draft.instances, task.subject.instance, "instance");
  for (const [carrierStep, step] of definition.carriers.entries()) {
    if (step.kind === "release") continue;
    if (step.kind === "acquire") {
      const carrier = freeCarrier(draft, step.from, new Set());
      if (carrier === null)
        throw new Error(`Task ${task.id} started without its carrier`);
      draft.carriers.set(carrier.id, {
        ...carrier,
        bound: { instance: instance.id, role: step.role },
      });
      instance = {
        ...instance,
        carriers: [
          ...instance.carriers,
          { role: step.role, carrier: carrier.id },
        ],
      };
      draft.instances.set(instance.id, instance);
      emit(draft, time, {
        kind: "carrier-acquired",
        carrier: carrier.id,
        instance: instance.id,
        role: step.role,
      });
      continue;
    }
    const carrier = boundCarrier(draft, instance, step.role);
    const destination = held(draft.storages, step.to, "storage");
    setStorage(draft, time, {
      ...destination,
      reservations: [
        ...destination.reservations,
        { task: task.id, carrier: carrier.id },
      ],
    });
    if (step.timing.kind !== "declared") continue;
    for (const boundary of ["pickup", "placement"] as const)
      draft.scheduled.push({
        kind: "task-boundary",
        task: task.id,
        carrierStep,
        order: {
          time: later(
            workAt,
            boundary === "pickup"
              ? step.timing.pickupAfter
              : step.timing.placementAfter,
          ),
          phase: "settle",
          origin: "declared",
          arrival: instance.arrival,
          task: task.id,
          boundary,
        },
      });
  }
}

/**
 * Ends a settled hold at `time`. The world did not step while it was held:
 * the held span is counted as factory time and never as steps.
 */
export function wake(draft: Draft, cellId: CellId, time: LogicalTime): void {
  const cell = held(draft.cells, cellId, "cell");
  if (cell.hold.kind !== "settled") return;
  const scheduled: (typeof draft.scheduled)[number][] = [];
  for (const event of draft.scheduled)
    if (event.kind !== "hold-expiry" || event.cell !== cellId)
      scheduled.push(event);
  draft.scheduled = scheduled;
  draft.cells.set(cellId, {
    ...cell,
    hold: { kind: "evolving" },
    committed: {
      ...cell.committed,
      boundary: time,
      clock: {
        ...cell.committed.clock,
        held: (cell.committed.clock.held +
          elapsed(cell.committed.boundary, time)) as TickDuration,
      },
    },
  });
  emit(draft, time, {
    kind: "cell-hold",
    cell: cellId,
    state: "left",
    model: cell.hold.model,
  });
}

/**
 * Commits a carrier's admission to, or removal from, a cell: the slot and the
 * cell's checkpoint change together, from a candidate prepared against the
 * exact state the cell is in.
 */
function commitBoundary(
  draft: Draft,
  time: LogicalTime,
  cellId: CellId,
  boundary: BoundaryId,
  operation: BoundaryOperation,
): void {
  // A carrier entering or leaving ends the hold before anything changes.
  wake(draft, cellId, time);
  const cell = held(draft.cells, cellId, "cell");
  if (cell.attempt !== null || cell.committed.boundary !== time)
    throw new Error(`Cell ${cellId} cannot change its carrier now`);
  const slot = slotAfter(cell.slot, operation);
  if (slot === null)
    throw new Error(`Cell ${cellId} cannot take boundary ${boundary}`);
  const predecessor = cell.committed.checkpoint.digest;
  for (const candidate of cell.prepared) {
    if (
      candidate.boundary !== boundary ||
      candidate.predecessor !== predecessor
    )
      continue;
    draft.cells.set(cellId, {
      ...cell,
      slot,
      committed: { ...cell.committed, checkpoint: candidate.checkpoint },
      prepared: [],
    });
    emit(draft, time, {
      kind: "cell-committed",
      cell: cellId,
      checkpoint: candidate.checkpoint.digest,
      boundary,
    });
    return;
  }
  throw new BoundaryRequired({
    boundary,
    runId: draft.identity.runId,
    executionId: draft.identity.executionId,
    cellId,
    predecessor,
    slot: cell.slot,
    operation,
  });
}

/**
 * The accepted pickup: the carrier leaves its position and the task
 * transporting it has custody. Leaving a cell removes it from that world.
 */
export function pickUp(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  definition: TaskDefinition,
  carrierStep: number,
): void {
  const step = moveAt(definition, carrierStep);
  const instance = held(draft.instances, task.subject.instance, "instance");
  const carrier = boundCarrier(draft, instance, step.role);
  if (
    carrier.custody.kind !== "stored" ||
    carrier.custody.storage !== step.from
  )
    throw new Error(`Carrier ${carrier.id} is not at ${step.from}`);
  const left = cellOf(draft, step.from);
  if (left !== null && cellOf(draft, step.to) !== left)
    commitBoundary(
      draft,
      time,
      left,
      boundaryId(task.id, carrierStep, "removal"),
      {
        kind: "removal",
        carrier: carrier.id,
        storage: step.from,
      },
    );
  const source = held(draft.storages, step.from, "storage");
  const occupants: CarrierId[] = [];
  for (const occupant of source.occupants)
    if (occupant !== carrier.id) occupants.push(occupant);
  setStorage(draft, time, { ...source, occupants });
  draft.carriers.set(carrier.id, {
    ...carrier,
    custody: {
      kind: "transport",
      task: task.id,
      from: step.from,
      to: step.to,
    },
  });
  emit(draft, time, {
    kind: "carrier-picked-up",
    carrier: carrier.id,
    task: task.id,
    from: step.from,
  });
}

/**
 * The accepted placement: custody passes to the destination, which becomes
 * occupied. Entering a cell admits the carrier to that world.
 */
export function place(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  definition: TaskDefinition,
  carrierStep: number,
): void {
  const step = moveAt(definition, carrierStep);
  const instance = held(draft.instances, task.subject.instance, "instance");
  const carrier = boundCarrier(draft, instance, step.role);
  if (carrier.custody.kind !== "transport" || carrier.custody.task !== task.id)
    throw new Error(`Carrier ${carrier.id} is not carried by ${task.id}`);
  const entered = cellOf(draft, step.to);
  if (entered !== null && cellOf(draft, step.from) !== entered)
    commitBoundary(
      draft,
      time,
      entered,
      boundaryId(task.id, carrierStep, "admission"),
      { kind: "admission", carrier: carrier.id, storage: step.to },
    );
  settleAt(draft, time, task, carrier, step.to);
  emit(draft, time, {
    kind: "carrier-placed",
    carrier: carrier.id,
    task: task.id,
    to: step.to,
  });
}

// The destination's reservation becomes its occupancy.
function settleAt(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  carrier: CarrierState,
  storage: StorageId,
): void {
  const destination = held(draft.storages, storage, "storage");
  const reservations: (typeof destination.reservations)[number][] = [];
  for (const reservation of destination.reservations)
    if (reservation.task !== task.id || reservation.carrier !== carrier.id)
      reservations.push(reservation);
  setStorage(draft, time, {
    ...destination,
    occupants: [...destination.occupants, carrier.id],
    reservations,
  });
  draft.carriers.set(carrier.id, {
    ...carrier,
    custody: { kind: "stored", storage },
  });
}

/** The carrier steps a native controller evidences, by their position. */
export function nativeMoves(definition: TaskDefinition): number[] {
  const moves: number[] = [];
  for (const [carrierStep, step] of definition.carriers.entries())
    if (step.kind === "move" && step.timing.kind === "native")
      moves.push(carrierStep);
  return moves;
}

/** Returns released carriers to the pool, empty, where they stand. */
export function releaseCarriers(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  definition: TaskDefinition,
): void {
  for (const step of definition.carriers) {
    if (step.kind !== "release") continue;
    const instance = held(draft.instances, task.subject.instance, "instance");
    const carrier = boundCarrier(draft, instance, step.role);
    const carriers: (typeof instance.carriers)[number][] = [];
    for (const binding of instance.carriers)
      if (binding.role !== step.role) carriers.push(binding);
    draft.instances.set(instance.id, { ...instance, carriers });
    draft.carriers.set(carrier.id, { ...carrier, bound: null });
    emit(draft, time, {
      kind: "carrier-released",
      carrier: carrier.id,
      instance: instance.id,
    });
  }
}

/**
 * Records where a failed native move left its carrier. Reservations stay, so
 * nothing else takes the positions involved before an explicit recovery.
 */
export function failCarriers(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
  definition: TaskDefinition,
  disposition: CarrierDisposition,
): void {
  const instance = held(draft.instances, task.subject.instance, "instance");
  for (const carrierStep of nativeMoves(definition)) {
    const step = moveAt(definition, carrierStep);
    const carrier = boundCarrier(draft, instance, step.role);
    if (disposition === "unknown")
      draft.carriers.set(carrier.id, {
        ...carrier,
        custody: { kind: "unknown", task: task.id, lastKnown: step.from },
      });
    else if (
      disposition === "destination" &&
      carrier.custody.kind === "transport"
    )
      settleAt(draft, time, task, carrier, step.to);
  }
}
