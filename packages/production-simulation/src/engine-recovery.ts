import { setStorage } from "./engine-storage.ts";
import type { Variant } from "@seams/type-utils";
import { rejectRecoveredBatchMember } from "./engine-batches.ts";
import type { CommandRejection, ControlCommand } from "./commands.ts";
import { claimResource, releaseTaskResources } from "./engine-resources.ts";
import {
  emit,
  held,
  isWorkflowTask,
  taskDefinition,
  type Draft,
} from "./engine-draft.ts";
import { attemptId } from "./identity.ts";
import type { CellState, RunState, TaskState } from "./state.ts";
import type { Terminal } from "./physics.ts";
import { zeroQuantity } from "./quantity.ts";
import {
  advance,
  intervalContains,
  ZERO_STEPS,
  type LogicalTime,
} from "./time.ts";
import {
  activeWorkerRoutes,
  assignWorker,
  finishWorker,
  travelDurationFromRoutes,
} from "./engine-workers.ts";

type Recover = Extract<ControlCommand, { kind: "recover" }>;
type Recovering = Variant<TaskState, "recovering">;

/** Recovery starts only from a complete boundary with all capacity available. */
export function recoveryRefusal(
  run: RunState,
  command: Recover,
): CommandRejection | null {
  const task = run.tasks.find(matchesTask.bind(null, command.task));
  if (task?.kind !== "recovery-required" || task.subject.kind !== "workflow")
    return "recovery_unavailable";
  const instance = run.instances.find(
    matchesTask.bind(null, task.subject.instance),
  );
  const cell = run.cells.find(ownsAttempt.bind(null, task.attempt));
  if (
    instance === undefined ||
    cell === undefined ||
    cell.slot.kind !== "active" ||
    instance.carriers.length !== 1 ||
    instance.carriers[0]?.carrier !== cell.slot.carrier ||
    command.handling <= 0 ||
    command.handling > 300_000_000
  )
    return "recovery_unavailable";
  for (const other of run.tasks)
    if (
      other.id !== task.id &&
      other.subject.kind === "workflow" &&
      other.subject.instance === instance.id &&
      other.kind !== "waiting" &&
      other.kind !== "completed" &&
      other.kind !== "skipped"
    )
      return "recovery_unavailable";
  for (const world of run.cells)
    if (
      world.prepared.length > 0 ||
      world.committed.boundary > run.position.time ||
      (world.hold.kind !== "settled" &&
        world.committed.boundary !== run.position.time)
    )
      return "boundary_unsettled";
  const resource = run.resources.find(matchesTask.bind(null, command.resource));
  if (resource === undefined) return "unknown_target";
  if (resource.batch !== null) return "recovery_unavailable";
  if (
    resource.allocations.length > 0 ||
    resource.withheld.some(withheldNow.bind(null, run.position.time))
  )
    return "recovery_resource_busy";
  if (command.attendance.kind === "in-place") {
    if (resource.position.kind !== "fixed") return "recovery_unavailable";
  } else {
    if (resource.position.kind !== "idle") return "recovery_unavailable";
    const definition = run.definition.scenario.resources.find(
      matchesTask.bind(null, resource.id),
    );
    if (definition?.kind !== "worker") return "recovery_unavailable";
    const travel = travelDurationFromRoutes(
      activeWorkerRoutes(run, definition),
      resource.position.at,
      command.attendance.location,
    );
    if (travel === null || travel + command.handling > 300_000_000)
      return "recovery_unavailable";
  }
  const destination = run.definition.scenario.storages.find(
    matchesTask.bind(null, command.storage),
  );
  const storage = run.storages.find(matchesTask.bind(null, command.storage));
  if (
    destination === undefined ||
    storage === undefined ||
    destination.cell !== null ||
    destination.capacity.kind !== "carriers"
  )
    return "recovery_unavailable";
  if (
    storage.occupants.length + storage.reservations.length >=
    destination.capacity.slots
  )
    return "recovery_destination_full";
  for (const definition of run.definition.scenario.resources)
    if (definition.kind === "batch" && definition.storage === command.storage)
      return "recovery_unavailable";
  const products = new Set<string>();
  for (const lot of run.lots) {
    if (
      lot.holder.kind !== "carrier" ||
      lot.holder.carrier !== cell.slot.carrier
    )
      continue;
    for (const claim of lot.claims)
      if (claim.task !== task.id) return "recovery_unavailable";
    if (lot.remaining.amount > 0) products.add(lot.product);
  }
  for (const report of command.reports) {
    if (!products.delete(report.product)) return "recovery_unavailable";
    const declared = run.definition.scenario.destinations.find(
      matchesTask.bind(null, report.destination),
    );
    if (
      declared?.role !== "rejected-output" ||
      declared.product !== report.product
    )
      return "recovery_unavailable";
  }
  return products.size === 0 ? null : "recovery_unavailable";
}

function matchesTask(id: string, record: Readonly<{ id: string }>): boolean {
  return record.id === id;
}
function ownsAttempt(attempt: string, cell: CellState): boolean {
  return cell.attempt?.id === attempt && cell.hold.kind === "unresolved";
}
function withheldNow(
  time: LogicalTime,
  entry: RunState["resources"][number]["withheld"][number],
): boolean {
  return intervalContains(entry.interval, time);
}

export function beginRecovery(draft: Draft, command: Recover): void {
  const task = held(draft.tasks, command.task, "failed task");
  if (task.kind !== "recovery-required" || !isWorkflowTask(task))
    throw new Error("Recovery requires a failed workflow task");
  const instance = held(draft.instances, task.subject.instance, "instance");
  const executor = taskDefinition(draft, instance, task.subject.key).executor;
  if (executor.kind !== "native")
    throw new Error("Recovery requires a native cell");
  const cell = held(draft.cells, executor.operation.cell, "cell");
  if (cell.slot.kind !== "active")
    throw new Error("Recovery requires a carrier");
  const attempt = attemptId(task.id, 2);
  let arrivesAt = draft.time;
  if (command.attendance.kind === "worker")
    arrivesAt = assignWorker(draft, draft.time, task.id, {
      kind: "attended",
      workers: [command.resource],
      start: command.attendance.location,
      finish: command.attendance.location,
      duration: command.handling,
      evidence: command.evidence,
    });
  const recovery = {
    task: task.id,
    command: command.commandId,
    attempt,
    carrier: cell.slot.carrier,
    resource: command.resource,
    storage: command.storage,
    handling: command.handling,
    attendance: command.attendance,
    evidence: command.evidence,
    reports: command.reports,
    startedAt: draft.time,
    arrivesAt,
    removesAt: advance(arrivesAt, command.handling),
    phase: "handling" as const,
  };
  draft.tasks.set(task.id, {
    id: task.id,
    subject: task.subject,
    kind: "recovering",
    startedAt: task.startedAt,
    failedAt: task.failedAt,
    attempt: task.attempt,
    disposition: task.disposition,
    recovery,
  });
  const resource = held(draft.resources, command.resource, "recovery resource");
  if (command.attendance.kind === "in-place")
    claimResource(draft, draft.time, resource.id, task.id, "held", 1);
  const storage = held(draft.storages, command.storage, "reject storage");
  setStorage(draft, draft.time, {
    ...storage,
    reservations: [
      ...storage.reservations,
      { task: task.id, carrier: cell.slot.carrier },
    ],
  });
  draft.cells.set(cell.id, {
    ...cell,
    hold: { kind: "evolving" },
    attempt: {
      id: attempt,
      task: task.id,
      dispatchedAt: draft.time,
      startingCheckpoint: cell.committed.checkpoint.digest,
      origin: { kind: "original" },
      lifecycle: { kind: "dispatched" },
      steps: ZERO_STEPS,
      segments: [],
    },
  });
  draft.status = { kind: "advancing" };
  emit(draft, draft.time, {
    kind: "recovery-started",
    task: task.id,
    command: command.commandId,
    attempt,
  });
}

/** The declared human handoff removes only the carrier from the native world. */
export function removeRecoveredCarrier(
  draft: Draft,
  time: LogicalTime,
  task: Recovering,
): void {
  const recovery = task.recovery;
  if (recovery.phase !== "handling")
    throw new Error("Recovery removed the carrier twice");
  if (time !== recovery.removesAt)
    throw new Error("Recovery removed the carrier before its declared handoff");
  finishWorker(draft, time, task.id);
  const carrier = held(draft.carriers, recovery.carrier, "recovery carrier");
  for (const storage of draft.storages.values()) {
    const occupants = storage.occupants.filter(
      different.bind(null, carrier.id),
    );
    const reservations = storage.reservations.filter(
      otherReservation.bind(null, task.id),
    );
    if (storage.id === recovery.storage) occupants.push(carrier.id);
    setStorage(draft, time, { ...storage, occupants, reservations });
  }
  draft.carriers.set(carrier.id, {
    ...carrier,
    custody: { kind: "stored", storage: recovery.storage },
  });
  for (const lot of draft.lots.values()) {
    if (
      lot.holder.kind !== "carrier" ||
      lot.holder.carrier !== carrier.id ||
      lot.remaining.amount === 0
    )
      continue;
    const report = recovery.reports.find(productReport.bind(null, lot.product));
    if (report === undefined)
      throw new Error("Recovery has no rejection report for its material");
    emit(draft, time, {
      kind: "lot-consumed",
      lot: lot.id,
      quantity: lot.remaining,
      task: task.id,
    });
    emit(draft, time, {
      kind: "quantity-reported",
      destination: report.destination,
      role: "rejected-output",
      product: lot.product,
      quantity: lot.remaining,
      task: task.id,
    });
    draft.lots.set(lot.id, {
      ...lot,
      remaining: zeroQuantity(lot.remaining.unit),
      claims: [],
    });
  }
  for (const cell of draft.cells.values())
    if (cell.attempt?.id === recovery.attempt)
      draft.cells.set(cell.id, {
        ...cell,
        slot: { kind: "inactive", generation: cell.slot.generation },
      });
  draft.tasks.set(task.id, {
    id: task.id,
    subject: task.subject,
    kind: "recovering",
    startedAt: task.startedAt,
    failedAt: task.failedAt,
    attempt: task.attempt,
    disposition: task.disposition,
    recovery: { ...recovery, phase: "returning" },
  });
  emit(draft, time, {
    kind: "carrier-placed",
    carrier: carrier.id,
    task: task.id,
    to: recovery.storage,
  });
}
function different(excluded: string, id: string): boolean {
  return id !== excluded;
}
function otherReservation(
  task: string,
  reservation: Readonly<{ task: string }>,
): boolean {
  return reservation.task !== task;
}
function productReport(
  product: string,
  report: Readonly<{ product: string }>,
): boolean {
  return report.product === product;
}

export function settleRecovery(
  draft: Draft,
  time: LogicalTime,
  task: Recovering,
  terminal: Terminal,
): void {
  const cell = held(draft.cells, terminal.cellId, "cell");
  if (terminal.outcome === "failed") {
    draft.tasks.set(task.id, {
      id: task.id,
      subject: task.subject,
      kind: "recovery-failed",
      startedAt: task.startedAt,
      failedAt: task.failedAt,
      attempt: task.attempt,
      disposition: task.disposition,
      recovery: task.recovery,
    });
    draft.cells.set(cell.id, {
      ...cell,
      hold: { kind: "unresolved", since: time },
    });
    emit(draft, time, {
      kind: "recovery-failed",
      task: task.id,
      attempt: terminal.attemptId,
    });
    return;
  }
  if (task.recovery.phase !== "returning" || task.subject.kind !== "workflow")
    throw new Error("Recovery completed before the human handoff");
  releaseTaskResources(draft, time, task.id);
  for (const lot of draft.lots.values())
    draft.lots.set(lot.id, {
      ...lot,
      claims: lot.claims.filter(otherReservation.bind(null, task.id)),
    });
  const instance = held(draft.instances, task.subject.instance, "instance");
  const carrier = held(draft.carriers, task.recovery.carrier, "carrier");
  draft.carriers.set(carrier.id, { ...carrier, bound: null });
  draft.instances.set(instance.id, {
    id: instance.id,
    workflow: instance.workflow,
    demand: instance.demand,
    arrival: instance.arrival,
    carriers: [],
    lots: instance.lots,
    kind: "failed",
    failedAt: task.failedAt,
    cause: task.id,
  });
  for (const other of draft.tasks.values())
    if (
      other.kind === "waiting" &&
      other.subject.kind === "workflow" &&
      other.subject.instance === instance.id
    )
      draft.tasks.set(other.id, {
        id: other.id,
        subject: other.subject,
        kind: "cancelled",
        cause: task.id,
        cancelledAt: time,
      });
  const failed: Variant<TaskState, "failed"> = {
    id: task.id,
    subject: task.subject,
    kind: "failed",
    startedAt: task.startedAt,
    failedAt: task.failedAt,
    attempt: task.attempt,
    disposition: task.disposition,
    resolvedAt: time,
  };
  draft.tasks.set(task.id, failed);
  draft.cells.set(cell.id, { ...cell, attempt: null });
  emit(draft, time, {
    kind: "carrier-released",
    carrier: carrier.id,
    instance: instance.id,
  });
  emit(draft, time, {
    kind: "recovery-completed",
    task: task.id,
    attempt: terminal.attemptId,
  });
  rejectRecoveredBatchMember(draft, time, failed, carrier.id);
  emit(draft, time, {
    kind: "cell-committed",
    cell: cell.id,
    checkpoint: terminal.checkpoint.digest,
    boundary: null,
  });
}
