import { assertNever, sameJson } from "@purin-labs/std";
import { requireValue } from "./document-values.ts";
import {
  instanceLotId,
  taskId,
  workflowInstanceId,
  type TaskId,
  type TaskKey,
} from "./identity.ts";
import {
  inspectionDecision,
  inspectionLots,
  ruleOutcome,
} from "./inspections.ts";
import type {
  DecisionGuard,
  DecisionOutcome,
  WorkflowDefinition,
} from "./scenario.ts";
import type { RunState, TaskState, WorkflowInstanceState } from "./state.ts";
import { advance, TICK_MICROSECONDS, type LogicalTime } from "./time.ts";
import { validateWorkers } from "./worker-invariants.ts";
import { validWorkerTravelReplacement } from "./engine-workers.ts";
import { validateBatches } from "./batch-invariants.ts";
import { indexDependencies } from "./dependencies.ts";
import type { StorageContents } from "./storage-document.ts";
import { taskWaits, type TaskWait } from "./scheduling-history.ts";

function index<T extends Readonly<{ id: string }>>(
  items: readonly T[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    requireValue(!result.has(item.id));
    result.set(item.id, item);
  }
  return result;
}
function get<T>(items: ReadonlyMap<string, T>, id: string): T {
  const item = items.get(id);
  requireValue(item !== undefined);
  return item;
}
function sameIdentities<T extends Readonly<{ id: string }>>(
  left: readonly T[],
  right: readonly Readonly<{ id: string }>[],
): Map<string, T> {
  const result = index(left);
  requireValue(result.size === right.length);
  for (const item of right) requireValue(result.has(item.id));
  return result;
}
function unique(values: readonly string[]): void {
  requireValue(new Set(values).size === values.length);
}
function active(task: TaskState): boolean {
  return (
    task.kind === "reserved" ||
    task.kind === "executing" ||
    task.kind === "recovery-required" ||
    task.kind === "recovering" ||
    task.kind === "recovery-failed"
  );
}

function validateTaskRelease(
  task: TaskState,
  releaseAt: LogicalTime,
  now: LogicalTime,
): void {
  switch (task.kind) {
    case "waiting": {
      let waitingForRelease = false;
      for (const blocker of task.blockers) {
        if (blocker.kind !== "release") continue;
        requireValue(
          !waitingForRelease && blocker.at === releaseAt && now < releaseAt,
        );
        waitingForRelease = true;
      }
      requireValue(waitingForRelease === now < releaseAt);
      return;
    }
    case "reserved":
      requireValue(task.reservedAt >= releaseAt);
      return;
    case "skipped":
      requireValue(task.completedAt >= releaseAt);
      return;
    case "executing":
    case "completed":
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
    case "failed":
      requireValue(task.startedAt >= releaseAt);
      return;
    case "cancelled":
      return;
    default:
      assertNever(task, "Unexpected task lifecycle");
  }
}

function validatePrerequisites(
  task: TaskState,
  prerequisites: readonly TaskId[],
  tasks: ReadonlyMap<string, TaskState>,
): void {
  let startedAt: LogicalTime;
  switch (task.kind) {
    case "cancelled":
      return;
    case "waiting":
      for (const blocker of task.blockers) {
        if (blocker.kind !== "prerequisite") continue;
        requireValue(prerequisites.includes(blocker.task));
        requireValue(
          tasks.get(blocker.task)?.kind !== "completed" &&
            tasks.get(blocker.task)?.kind !== "skipped",
        );
      }
      return;
    case "reserved":
      startedAt = task.reservedAt;
      break;
    case "skipped":
      startedAt = task.completedAt;
      break;
    case "executing":
    case "completed":
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
    case "failed":
      startedAt = task.startedAt;
      break;
    default:
      return assertNever(task, "Unexpected task lifecycle");
  }
  for (const id of prerequisites) {
    const prerequisite = tasks.get(id);
    requireValue(
      prerequisite !== undefined &&
        (prerequisite.kind === "completed" || prerequisite.kind === "skipped"),
    );
    requireValue(prerequisite.completedAt <= startedAt);
  }
}

function stepGuard(
  step: WorkflowDefinition["tasks"][number],
): DecisionGuard | null {
  const executor = step.executor;
  if (executor.kind === "after-inspection")
    return { inspection: executor.inspection, outcome: executor.outcome };
  return executor.kind === "inspection" ? (executor.when ?? null) : null;
}

function decidedOutcome(
  run: RunState,
  workflow: WorkflowDefinition,
  instance: WorkflowInstanceState,
  key: TaskKey,
): DecisionOutcome | null {
  const recorded = inspectionDecision(run.commands, taskId(instance.id, key));
  if (recorded !== null) return recorded.outcome;
  for (const step of workflow.tasks)
    if (
      step.key === key &&
      step.executor.kind === "inspection" &&
      step.executor.rule !== undefined
    )
      return ruleOutcome(
        step.executor.rule,
        { id: instance.id, sequence: instance.arrival.sequence },
        run.events,
      );
  return null;
}

/** Cross-record checks run only at restore admission, before a controller opens. */
export function validateState(run: RunState): void {
  const definition = run.definition.scenario;
  const now = run.position.time;
  requireValue(
    now <= run.position.horizon &&
      run.position.horizon >= definition.limits.horizon,
  );
  const tasks = index(run.tasks);
  const dependencies = indexDependencies(definition.dependencies);
  const instances = index(run.instances);
  const lots = index(run.lots);
  const resources = sameIdentities(run.resources, definition.resources);
  const storages = sameIdentities(run.storages, definition.storages);
  const carriers = sameIdentities(run.carriers, definition.carriers);
  const cells = sameIdentities(run.cells, definition.cells);
  const arrivals = sameIdentities(run.arrivals, definition.arrivals);
  const workflows = index(definition.workflows);
  const products = index(definition.products);
  const storageDefinitions = index(definition.storages);
  const resourceDefinitions = index(definition.resources);
  const commands = new Map<string, RunState["commands"][number]>();
  const inspected = new Set<TaskId>();
  for (const entry of run.commands) {
    const { command, receipt } = entry;
    requireValue(!commands.has(command.commandId));
    commands.set(command.commandId, entry);
    if (command.kind === "inspect") {
      requireValue(!inspected.has(command.task));
      inspected.add(command.task);
      requireValue(
        command.definition === run.definition.digest &&
          sameJson(command.lots, inspectionLots(run, command.task)),
      );
      const inspectedTask = get(tasks, command.task);
      if (inspectedTask.kind === "completed")
        requireValue(inspectedTask.startedAt === receipt.effectiveAt);
    }
    if (command.kind === "update-worker-travel") {
      const target = get(resourceDefinitions, command.resource);
      requireValue(
        target.kind === "worker" &&
          validWorkerTravelReplacement(target, command.travel),
      );
    }
    requireValue(
      receipt.status === "accepted" &&
        receipt.commandId === command.commandId &&
        receipt.runId === command.runId &&
        receipt.executionId === command.executionId &&
        command.runId === run.identity.runId,
    );
    requireValue(
      receipt.controlRevision === command.expectedControlRevision + 1 &&
        receipt.controlRevision <= run.position.controlRevision &&
        receipt.eventSequence <= run.position.eventSequence,
    );
  }
  for (const instance of run.instances) {
    const workflow = get(workflows, instance.workflow);
    const source = get(arrivals, instance.arrival.source);
    requireValue(
      instance.id ===
        workflowInstanceId(
          instance.arrival.source,
          instance.arrival.sequence,
        ) &&
        instance.arrival.sequence < source.next &&
        instance.arrival.time <= now &&
        instance.demand === workflow.demand,
    );
    for (const step of workflow.tasks) {
      const task = get(tasks, taskId(instance.id, step.key));
      requireValue(
        task.subject.kind === "workflow" &&
          task.subject.instance === instance.id &&
          task.subject.key === step.key,
      );
      if (step.executor.kind === "inspection" && task.kind === "completed") {
        const decision = inspectionDecision(run.commands, task.id);
        if (step.executor.rule === undefined) {
          requireValue(
            decision !== null && decision.definition === run.definition.digest,
          );
          requireValue(sameJson(decision.lots, inspectionLots(run, task.id)));
        } else requireValue(decision === null);
      }
      if (instance.kind === "completed")
        requireValue(task.kind === "completed" || task.kind === "skipped");
      if (instance.kind === "failed")
        requireValue(
          task.kind === "completed" ||
            task.kind === "skipped" ||
            task.kind === "failed" ||
            task.kind === "cancelled",
        );
    }
    const roles: string[] = [];
    for (const binding of instance.carriers) {
      roles.push(binding.role);
      const carrier = get(carriers, binding.carrier);
      requireValue(
        carrier.bound !== null &&
          carrier.bound.instance === instance.id &&
          carrier.bound.role === binding.role,
      );
    }
    unique(roles);
    const keys: string[] = [];
    for (const binding of instance.lots) {
      keys.push(binding.key);
      get(lots, binding.lot);
      requireValue(binding.lot === instanceLotId(instance.id, binding.key));
    }
    unique(keys);
    if (instance.kind === "completed")
      requireValue(instance.completedAt <= now);
    if (instance.kind === "failed") {
      requireValue(
        instance.failedAt <= now &&
          get(tasks, instance.cause).kind === "failed" &&
          instance.carriers.length === 0,
      );
    }
  }
  for (const task of run.tasks) {
    if (task.subject.kind === "workflow") {
      const instance = get(instances, task.subject.instance);
      const workflow = get(workflows, instance.workflow);
      let found = false;
      for (const step of workflow.tasks) {
        if (step.key !== task.subject.key) continue;
        found = true;
        const guard = stepGuard(step);
        if (task.kind === "skipped") {
          requireValue(guard !== null);
          // A decision inside a skipped branch passes on why that branch skipped.
          const gate =
            guard === null
              ? undefined
              : tasks.get(taskId(instance.id, guard.inspection));
          if (gate?.kind === "skipped")
            requireValue(
              task.inspection === gate.inspection &&
                task.outcome === gate.outcome,
            );
          else if (guard !== null) {
            requireValue(
              task.inspection === taskId(instance.id, guard.inspection),
            );
            requireValue(
              task.outcome !== guard.outcome &&
                decidedOutcome(run, workflow, instance, guard.inspection) ===
                  task.outcome,
            );
          }
        } else if (
          guard !== null &&
          (task.kind === "executing" ||
            task.kind === "completed" ||
            task.kind === "reserved")
        )
          requireValue(
            decidedOutcome(run, workflow, instance, guard.inspection) ===
              guard.outcome,
          );
        validateTaskRelease(
          task,
          advance(instance.arrival.time, step.releaseAfter),
          now,
        );
        const prerequisites = [...(dependencies.get(task.id) ?? [])];
        for (const key of step.prerequisites)
          prerequisites.push(taskId(instance.id, key));
        validatePrerequisites(task, prerequisites, tasks);
      }
      requireValue(found && task.id === taskId(instance.id, task.subject.key));
    } else {
      get(resources, task.subject.resource);
      get(tasks, task.subject.cause);
    }
    switch (task.kind) {
      case "waiting":
        requireValue(task.since <= now);
        break;
      case "reserved":
        requireValue(task.reservedAt <= now);
        break;
      case "executing":
        requireValue(
          task.startedAt <= now &&
            ((task.attempt === null &&
              task.completesAt !== null &&
              task.completesAt >= now) ||
              (task.attempt !== null && task.completesAt === null)),
        );
        break;
      case "completed":
        requireValue(
          task.startedAt <= task.completedAt && task.completedAt <= now,
        );
        break;
      case "skipped":
        requireValue(
          task.completedAt <= now && task.subject.kind === "workflow",
        );
        break;
      case "recovery-required":
        requireValue(task.startedAt <= task.failedAt && task.failedAt <= now);
        break;
      case "recovering":
      case "recovery-failed": {
        const recovery = task.recovery;
        requireValue(
          task.startedAt <= task.failedAt &&
            task.failedAt <= recovery.startedAt &&
            recovery.startedAt <= now,
        );
        requireValue(
          recovery.task === task.id && recovery.attempt !== task.attempt,
        );
        const entry = get(commands, recovery.command);
        const command = entry.command;
        requireValue(
          command.kind === "recover" &&
            command.task === task.id &&
            command.resource === recovery.resource &&
            command.storage === recovery.storage &&
            command.handling === recovery.handling &&
            sameJson(command.attendance, recovery.attendance) &&
            command.evidence === recovery.evidence &&
            sameJson(command.reports, recovery.reports) &&
            entry.receipt.status === "accepted" &&
            entry.receipt.effectiveAt === recovery.startedAt,
        );
        const resource = get(resources, recovery.resource);
        let heldHuman = false;
        for (const allocation of resource.allocations)
          if (
            allocation.task === task.id &&
            allocation.kind ===
              (recovery.attendance.kind === "worker" ? "occupied" : "held") &&
            allocation.units === 1
          )
            heldHuman = true;
        requireValue(
          heldHuman ===
            (recovery.attendance.kind === "in-place" ||
              recovery.phase === "handling"),
        );
        requireValue(
          recovery.arrivesAt >= recovery.startedAt &&
            recovery.removesAt === recovery.arrivesAt + recovery.handling &&
            recovery.removesAt - recovery.startedAt <= 300_000_000,
        );
        if (recovery.attendance.kind === "in-place")
          requireValue(recovery.arrivesAt === recovery.startedAt);
        const storage = get(storages, recovery.storage);
        if (recovery.phase === "handling") {
          let reserved = false;
          for (const reservation of storage.reservations)
            if (
              reservation.task === task.id &&
              reservation.carrier === recovery.carrier
            )
              reserved = true;
          requireValue(reserved);
        }
        const carrier = get(carriers, recovery.carrier);
        if (recovery.phase === "returning")
          requireValue(
            carrier.custody.kind === "stored" &&
              carrier.custody.storage === recovery.storage,
          );
        break;
      }
      case "failed":
        requireValue(
          task.startedAt <= task.failedAt &&
            task.failedAt <= task.resolvedAt &&
            task.resolvedAt <= now,
        );
        break;
      case "cancelled":
        requireValue(
          task.cancelledAt <= now && get(tasks, task.cause).kind === "failed",
        );
        break;
      default:
        assertNever(task);
    }
  }
  for (const resource of run.resources) {
    let used = 0;
    const allocated: string[] = [];
    for (const allocation of resource.allocations) {
      const task = get(tasks, allocation.task);
      requireValue(active(task) && allocation.since <= now);
      requireValue(
        (allocation.kind === "held" &&
          (task.kind === "recovery-required" ||
            task.kind === "recovering" ||
            task.kind === "recovery-failed")) ||
          (allocation.kind === "reserved" && task.kind === "reserved") ||
          (allocation.kind === "occupied" &&
            (task.kind === "executing" ||
              ((task.kind === "recovering" ||
                task.kind === "recovery-failed") &&
                task.recovery.attendance.kind === "worker" &&
                task.recovery.resource === resource.id &&
                task.recovery.phase === "handling"))),
      );
      allocated.push(task.id);
      used += allocation.units;
    }
    unique(allocated);
    requireValue(used <= get(resourceDefinitions, resource.id).capacity);
  }
  const occupied = new Set<string>();
  for (const storage of run.storages) {
    unique(storage.occupants);
    const reserved: string[] = [];
    for (const id of storage.occupants) {
      const carrier = get(carriers, id);
      requireValue(
        !occupied.has(id) &&
          carrier.custody.kind === "stored" &&
          carrier.custody.storage === storage.id,
      );
      occupied.add(id);
    }
    for (const reservation of storage.reservations) {
      requireValue(active(get(tasks, reservation.task)));
      get(carriers, reservation.carrier);
      reserved.push(reservation.carrier);
    }
    unique(reserved);
    const capacity = get(storageDefinitions, storage.id).capacity;
    if (capacity.kind === "carriers")
      requireValue(
        storage.occupants.length + storage.reservations.length <=
          capacity.slots,
      );
  }
  for (const carrier of run.carriers) {
    if (carrier.custody.kind === "stored")
      requireValue(occupied.has(carrier.id));
    else {
      requireValue(
        !occupied.has(carrier.id) && active(get(tasks, carrier.custody.task)),
      );
      if (carrier.custody.kind === "transport") {
        get(storages, carrier.custody.from);
        get(storages, carrier.custody.to);
      } else get(storages, carrier.custody.lastKnown);
    }
    if (carrier.bound !== null) {
      const instance = get(instances, carrier.bound.instance);
      let found = false;
      for (const binding of instance.carriers)
        if (
          binding.carrier === carrier.id &&
          binding.role === carrier.bound.role
        )
          found = true;
      requireValue(found);
    }
  }
  for (const lot of run.lots) {
    requireValue(lot.remaining.unit === get(products, lot.product).unit);
    let claimed = 0;
    for (const claim of lot.claims) {
      requireValue(
        active(get(tasks, claim.task)) &&
          claim.quantity.unit === lot.remaining.unit,
      );
      claimed += claim.quantity.amount;
    }
    requireValue(claimed <= lot.remaining.amount);
    for (const ancestor of lot.lineage) {
      requireValue(ancestor !== lot.id);
      get(lots, ancestor);
    }
    if (lot.holder.kind === "storage") get(storages, lot.holder.storage);
    else get(carriers, lot.holder.carrier);
    if (lot.origin.kind === "produced") {
      get(tasks, lot.origin.task);
      requireValue(lot.origin.at <= now);
    }
  }
  const slotted = new Set<string>();
  for (const cell of run.cells) {
    const committed = cell.committed;
    requireValue(
      committed.checkpoint.step === committed.clock.steps &&
        committed.boundary ===
          committed.clock.origin +
            committed.clock.held +
            committed.clock.steps * TICK_MICROSECONDS,
    );
    requireValue(
      committed.boundary === now ||
        (cell.hold.kind === "settled" &&
          committed.boundary <= now &&
          cell.hold.until >= now),
    );
    if (cell.slot.kind === "active") {
      get(carriers, cell.slot.carrier);
      requireValue(!slotted.has(cell.slot.carrier));
      slotted.add(cell.slot.carrier);
    }
    if (cell.hold.kind === "settled")
      requireValue(
        cell.hold.enteredAt <= now && cell.hold.enteredAt <= cell.hold.until,
      );
    if (cell.attempt !== null) {
      const attempt = cell.attempt;
      const task = get(tasks, attempt.task);
      requireValue(
        attempt.dispatchedAt <= now &&
          attempt.steps <= committed.checkpoint.step,
      );
      if (task.kind === "executing" || task.kind === "recovery-required")
        requireValue(task.attempt === attempt.id);
      if (task.kind === "recovering" || task.kind === "recovery-failed")
        requireValue(
          task.recovery.attempt === attempt.id &&
            ((task.recovery.phase === "handling" &&
              (attempt.steps * TICK_MICROSECONDS <
                task.recovery.removesAt - task.recovery.startedAt ||
                (task.kind === "recovery-failed" &&
                  attempt.steps * TICK_MICROSECONDS ===
                    task.recovery.removesAt - task.recovery.startedAt)) &&
              cell.slot.kind === "active" &&
              cell.slot.carrier === task.recovery.carrier) ||
              (task.recovery.phase === "returning" &&
                attempt.steps * TICK_MICROSECONDS >=
                  task.recovery.removesAt - task.recovery.startedAt &&
                cell.slot.kind === "inactive")),
        );
    }
  }
  requireValue(run.position.eventSequence === run.events.length);
  let previous = 0;
  let sequence = 0;
  const skippedEvents = new Set<TaskId>();
  for (const event of run.events) {
    sequence += 1;
    requireValue(
      event.sequence === sequence &&
        event.time >= previous &&
        event.time <= now,
    );
    previous = event.time;
    if ("task" in event) get(tasks, event.task);
    if (
      "task" in event &&
      (event.kind === "task-skipped" ||
        get(tasks, event.task).kind === "skipped")
    ) {
      const skipped = get(tasks, event.task);
      requireValue(skipped.kind === "skipped" && event.kind === "task-skipped");
      requireValue(
        event.time === skipped.completedAt &&
          event.inspection === skipped.inspection &&
          event.outcome === skipped.outcome,
      );
      requireValue(!skippedEvents.has(event.task));
      skippedEvents.add(event.task);
    }
    if ("instance" in event) get(instances, event.instance);
    if ("carrier" in event) get(carriers, event.carrier);
    if ("lot" in event) get(lots, event.lot);
    if ("cell" in event) get(cells, event.cell);
    if ("resource" in event) get(resources, event.resource);
    if ("cycle" in event)
      requireValue(get(resourceDefinitions, event.resource).kind === "batch");
    if ("worker" in event)
      requireValue(get(resourceDefinitions, event.worker).kind === "worker");
    if ("product" in event) get(products, event.product);
  }
  for (const task of run.tasks)
    if (task.kind === "skipped") requireValue(skippedEvents.has(task.id));
  for (const event of run.scheduled) {
    requireValue(event.order.time >= now);
    if (event.task !== undefined) get(tasks, event.task);
    if (event.resource !== undefined) get(resources, event.resource);
    if (event.cell !== undefined) get(cells, event.cell);
    if (event.command !== undefined) requireValue(commands.has(event.command));
    if (event.task !== undefined)
      requireValue(get(tasks, event.task).kind !== "skipped");
  }
  validateWorkers(run);
  validateBatches(run);
  validateStorageHistory(run);
  validateWaitingHistory(run, dependencies);
  switch (run.status.kind) {
    case "awaiting-inspection": {
      const task = get(tasks, run.status.task);
      requireValue(
        task.kind === "waiting" &&
          task.blockers.length === 1 &&
          task.blockers[0]?.kind === "inspection",
      );
      requireValue(
        inspectionLots(run, task.id) !== null &&
          inspectionDecision(run.commands, task.id) === null,
      );
      break;
    }
    case "paused":
      requireValue(
        run.status.boundary === now && commands.has(run.status.command),
      );
      break;
    case "blocked":
      for (const task of run.status.tasks)
        requireValue(
          get(tasks, task).kind !== "completed" &&
            get(tasks, task).kind !== "skipped",
        );
      break;
    case "completed":
      requireValue(run.status.completedAt === now);
      for (const instance of run.instances)
        requireValue(
          instance.kind === "completed" || instance.kind === "failed",
        );
      break;
    case "stopped-at-limit":
      for (const task of run.status.unfinished)
        requireValue(
          get(tasks, task).kind !== "completed" &&
            get(tasks, task).kind !== "skipped",
        );
      break;
  }
}

function validateWaitingHistory(
  run: RunState,
  dependencies: ReadonlyMap<TaskId, readonly TaskId[]>,
): void {
  let latest: readonly TaskWait[] | null = null;
  const tasks = index(run.tasks);
  const resources = index(run.resources);
  const storages = index(run.storages);
  const cells = index(run.cells);
  const products = index(run.definition.scenario.products);
  for (const event of run.events) {
    if (event.kind !== "waiting-changed") continue;
    if (latest === null)
      requireValue(
        event.sequence === 1 && event.time === 0 && event.waiting.length === 0,
      );
    const identities = new Set<TaskId>();
    for (const wait of event.waiting) {
      requireValue(!identities.has(wait.task));
      identities.add(wait.task);
      requireValue(get(tasks, wait.task).subject.kind === "workflow");
      for (const blocker of wait.blockers) {
        switch (blocker.kind) {
          case "inspection":
            requireValue(
              blocker.task === wait.task &&
                inspectionLots(run, blocker.task) !== null,
            );
            break;
          case "prerequisite":
            // A declared dependency can refer to an arrival that is still due.
            requireValue(
              tasks.has(blocker.task) ||
                (dependencies.get(wait.task) ?? []).includes(blocker.task),
            );
            break;
          case "resource":
          case "configuration":
          case "batch-cycle":
            get(resources, blocker.resource);
            break;
          case "destination":
            get(storages, blocker.storage);
            break;
          case "carrier":
            get(storages, blocker.store);
            break;
          case "cell-slot":
          case "cell-state":
            get(cells, blocker.cell);
            break;
          case "material":
            get(products, blocker.product);
            break;
          case "workers":
            for (const worker of blocker.workers) get(resources, worker);
            break;
          case "release":
            requireValue(blocker.at > event.time);
            break;
          default:
            assertNever(blocker);
        }
      }
    }
    latest = event.waiting;
  }
  if (latest !== null) requireValue(sameJson(latest, taskWaits(run.tasks)));
}

/** Earlier saved bundles have no snapshots. Partial or contradictory history fails. */
function validateStorageHistory(run: RunState): void {
  const latest = new Map<string, StorageContents>();
  const carriers = index(run.carriers);
  const tasks = index(run.tasks);
  const definitions = index(run.definition.scenario.storages);
  for (const event of run.events) {
    if (event.kind !== "storage-changed") continue;
    const definition = get(definitions, event.storage);
    requireValue(definition.capacity.kind === "carriers");
    requireValue(
      event.occupants.length + event.reservations.length <=
        definition.capacity.slots,
    );
    for (const carrier of event.occupants) get(carriers, carrier);
    for (const reservation of event.reservations) {
      get(carriers, reservation.carrier);
      get(tasks, reservation.task);
    }
    if (!latest.has(event.storage)) {
      const initial = [];
      for (const carrier of run.definition.scenario.carriers)
        if (carrier.storage === event.storage) initial.push(carrier.id);
      requireValue(
        event.time === 0 &&
          sameJson(event.occupants, initial) &&
          event.reservations.length === 0,
      );
    }
    latest.set(event.storage, {
      occupants: event.occupants,
      reservations: event.reservations,
    });
  }
  if (latest.size === 0) return;
  for (const storage of run.storages) {
    if (get(definitions, storage.id).capacity.kind !== "carriers") continue;
    const contents = get(latest, storage.id);
    requireValue(
      sameJson(contents.occupants, storage.occupants) &&
        sameJson(contents.reservations, storage.reservations),
    );
  }
}
