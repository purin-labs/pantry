import { sameJson } from "@seams/std";
import { executionWork } from "./scenario.ts";
import type { Variant } from "@seams/type-utils";
import { InvalidDocument, requireValue } from "./document-values.ts";
import type { AcceptedEvent } from "./events.ts";
import type { CommandId, TaskId } from "./identity.ts";
import type { ControlCommand, RecoveryRequest } from "./commands.ts";
import {
  acceptedCommandsById,
  admittedWorkerTravelCommand,
  travelDurationFromRoutes,
} from "./worker-travel.ts";
import type {
  ResourceDefinition,
  TaskDefinition,
  TravelRoute,
} from "./scenario.ts";
import type {
  ResourcePosition,
  ResourceState,
  RunState,
  TaskState,
} from "./state.ts";
import { advance } from "./time.ts";

function taskEntry(
  run: RunState,
  id: TaskId,
): Readonly<{ task: TaskState; definition: TaskDefinition }> {
  for (const task of run.tasks) {
    if (task.id !== id) continue;
    requireValue(task.subject.kind === "workflow");
    for (const instance of run.instances) {
      if (instance.id !== task.subject.instance) continue;
      for (const workflow of run.definition.scenario.workflows) {
        if (workflow.id !== instance.workflow) continue;
        for (const definition of workflow.tasks)
          if (definition.key === task.subject.key) return { task, definition };
      }
    }
  }
  throw new Error(`No workflow task ${id}`);
}

function validatePendingBoundaries(
  run: RunState,
  event: Variant<AcceptedEvent, "worker-assigned">,
  definition: TaskDefinition,
): void {
  for (const pending of run.scheduled) {
    if (pending.kind !== "task-boundary" || pending.task !== event.task)
      continue;
    const order = pending.order;
    requireValue(order.phase === "settle" && order.origin === "declared");
    if (order.boundary === "completion") {
      requireValue(
        pending.carrierStep === null && order.time === event.completesAt,
      );
      continue;
    }
    requireValue(pending.carrierStep !== null);
    const step = definition.carriers[pending.carrierStep];
    requireValue(
      step !== undefined &&
        step.kind === "move" &&
        step.timing.kind === "declared",
    );
    const offset =
      order.boundary === "pickup"
        ? step.timing.pickupAfter
        : step.timing.placementAfter;
    requireValue(order.time === advance(event.arrivesAt, offset));
  }
}

function validateAssignment(
  run: RunState,
  definition: Variant<ResourceDefinition, "worker">,
  routes: readonly TravelRoute[],
  event: Variant<AcceptedEvent, "worker-assigned">,
  position: ResourcePosition,
): ResourcePosition {
  requireValue(position.kind === "idle" && event.from === position.at);
  const entry = taskEntry(run, event.task);
  const executor = executionWork(entry.definition.executor);
  const task = entry.task;
  if (executor.kind === "native")
    return validateRecoveryAssignment(run, definition, routes, event, position);
  requireValue(executor.kind === "attended");
  requireValue(task.kind === "executing" || task.kind === "completed");
  requireValue(
    executor.workers.includes(definition.id) && task.startedAt === event.time,
  );
  const travel = travelDurationFromRoutes(routes, position.at, executor.start);
  requireValue(travel !== null);
  requireValue(
    event.start === executor.start &&
      event.finish === executor.finish &&
      event.arrivesAt === advance(event.time, travel) &&
      event.completesAt === advance(event.arrivesAt, executor.duration),
  );
  if (task.kind === "executing")
    requireValue(
      task.attempt === null && task.completesAt === event.completesAt,
    );
  else requireValue(task.completedAt === event.completesAt);
  validatePendingBoundaries(run, event, entry.definition);
  return {
    kind: "assigned",
    task: event.task,
    from: event.from,
    start: event.start,
    finish: event.finish,
    arrivesAt: event.arrivesAt,
    completesAt: event.completesAt,
  };
}

function recoveryCommand(
  run: RunState,
  event: Variant<AcceptedEvent, "worker-assigned">,
): RecoveryRequest {
  for (const entry of run.commands) {
    const command = entry.command;
    if (
      command.kind === "recover" &&
      command.task === event.task &&
      entry.receipt.status === "accepted" &&
      entry.receipt.effectiveAt === event.time
    )
      return command;
  }
  throw new InvalidDocument("A recovery assignment needs its accepted command");
}

function validateRecoveryAssignment(
  run: RunState,
  definition: Variant<ResourceDefinition, "worker">,
  routes: readonly TravelRoute[],
  event: Variant<AcceptedEvent, "worker-assigned">,
  position: Variant<ResourcePosition, "idle">,
): ResourcePosition {
  const command = recoveryCommand(run, event);
  requireValue(
    command.attendance.kind === "worker" && command.resource === definition.id,
  );
  const travel = travelDurationFromRoutes(
    routes,
    position.at,
    command.attendance.location,
  );
  requireValue(travel !== null);
  requireValue(
    event.start === command.attendance.location &&
      event.finish === event.start &&
      event.arrivesAt === advance(event.time, travel) &&
      event.completesAt === advance(event.arrivesAt, command.handling),
  );
  const { task } = taskEntry(run, event.task);
  requireValue(
    task.kind === "recovering" ||
      task.kind === "recovery-failed" ||
      task.kind === "failed",
  );
  if (task.kind !== "failed")
    requireValue(
      task.recovery.startedAt === event.time &&
        task.recovery.arrivesAt === event.arrivesAt &&
        task.recovery.removesAt === event.completesAt,
    );
  return {
    kind: "assigned",
    task: event.task,
    from: event.from,
    start: event.start,
    finish: event.finish,
    arrivesAt: event.arrivesAt,
    completesAt: event.completesAt,
  };
}

function validateWorker(
  run: RunState,
  definition: Variant<ResourceDefinition, "worker">,
  resource: ResourceState,
  assigned: Set<TaskId>,
  acceptedCommands: ReadonlyMap<CommandId, ControlCommand>,
): void {
  requireValue(resource.configuration === null && resource.changeovers === 0);
  let position: ResourcePosition = {
    kind: "idle",
    at: definition.initialLocation,
  };
  let routes: readonly TravelRoute[] = definition.travel;
  for (const event of run.events) {
    if (event.kind === "command-admitted") {
      const command = admittedWorkerTravelCommand(acceptedCommands, event);
      if (command?.resource === resource.id) routes = command.travel;
      continue;
    }
    if (event.kind === "worker-assigned" && event.worker === resource.id) {
      requireValue(!assigned.has(event.task));
      assigned.add(event.task);
      position = validateAssignment(run, definition, routes, event, position);
    } else if (
      (event.kind === "task-completed" || event.kind === "carrier-placed") &&
      position.kind === "assigned" &&
      event.task === position.task
    ) {
      if (event.kind === "carrier-placed") {
        const { definition: taskDefinition } = taskEntry(run, event.task);
        if (taskDefinition.executor.kind !== "native") continue;
        let destination: string | null = null;
        for (const entry of run.commands)
          if (
            entry.command.kind === "recover" &&
            entry.command.task === event.task
          )
            destination = entry.command.storage;
        requireValue(event.to === destination);
      }
      requireValue(event.time === position.completesAt);
      position = { kind: "idle", at: position.finish };
    }
  }
  requireValue(sameJson(position, resource.position));
  if (position.kind === "idle") {
    requireValue(resource.allocations.length === 0);
    return;
  }
  requireValue(position.kind === "assigned");
  const allocation = resource.allocations[0];
  const { task } = taskEntry(run, position.task);
  requireValue(
    task.kind === "executing" ||
      task.kind === "recovering" ||
      task.kind === "recovery-failed",
  );
  const assignedAt =
    task.kind === "executing" ? task.startedAt : task.recovery.startedAt;
  if (task.kind !== "executing")
    requireValue(task.recovery.phase === "handling");
  requireValue(resource.allocations.length === 1 && allocation !== undefined);
  requireValue(
    allocation.task === task.id &&
      allocation.kind === "occupied" &&
      allocation.units === 1 &&
      allocation.since === assignedAt,
  );
}

/** Restore checks worker custody, route timing and delayed carrier boundaries together. */
export function validateWorkers(run: RunState): void {
  const assigned = new Set<TaskId>();
  const acceptedCommands = acceptedCommandsById(run);
  for (const resource of run.resources) {
    for (const definition of run.definition.scenario.resources) {
      if (definition.id !== resource.id) continue;
      if (definition.kind === "worker")
        validateWorker(run, definition, resource, assigned, acceptedCommands);
      else requireValue(resource.position.kind === "fixed");
    }
  }
  for (const event of run.events)
    if (event.kind === "worker-assigned")
      requireValue(assigned.has(event.task));
  for (const entry of run.commands)
    if (
      entry.command.kind === "recover" &&
      entry.command.attendance.kind === "worker"
    )
      requireValue(assigned.has(entry.command.task));
  for (const task of run.tasks) {
    if (task.subject.kind !== "workflow") continue;
    const { definition } = taskEntry(run, task.id);
    const executor = executionWork(definition.executor);
    if (executor.kind !== "attended") continue;
    requireValue(
      assigned.has(task.id) ===
        (task.kind === "executing" || task.kind === "completed"),
    );
    if (task.kind !== "waiting") continue;
    for (const blocker of task.blockers)
      if (blocker.kind === "workers")
        requireValue(sameJson(blocker.workers, executor.workers));
  }
}
