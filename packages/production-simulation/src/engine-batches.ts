import { assertNever } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import { boundCarrier } from "./engine-carriers.ts";
import {
  emit,
  held,
  isWorkflowTask,
  taskDefinition,
  type Draft,
  type WorkflowTask,
} from "./engine-draft.ts";
import {
  taskId,
  type CarrierId,
  type ResourceId,
  type TaskId,
  type WorkflowId,
} from "./identity.ts";
import type { ResourceDefinition, TaskExecutor } from "./scenario.ts";
import type {
  BatchMember,
  BatchState,
  Blocker,
  ResourceState,
  TaskState,
} from "./state.ts";
import {
  advance,
  intervalContains,
  type LogicalTime,
  type TickDuration,
} from "./time.ts";

type BatchExecutor = Variant<TaskExecutor, "batch">;

/** A rejected member leaves only after carrier removal and successful arm return. */
export function withoutBatchMember(
  batch: Variant<BatchState, "loading" | "unloading">,
  task: TaskId,
): BatchState {
  const members: BatchMember[] = [];
  for (const member of batch.members)
    if (member.task !== task) members.push(member);
  const [first, ...rest] = members;
  if (first === undefined) return { kind: "idle", sequence: batch.sequence };
  switch (batch.kind) {
    case "loading":
      return {
        kind: "loading",
        sequence: batch.sequence,
        program: batch.program,
        openedAt: batch.openedAt,
        closeAt: batch.closeAt,
        members: [first, ...rest],
      };
    case "unloading":
      return {
        kind: "unloading",
        sequence: batch.sequence,
        program: batch.program,
        completedAt: batch.completedAt,
        members: [first, ...rest],
      };
    default:
      return assertNever(batch);
  }
}

export function rejectRecoveredBatchMember(
  draft: Draft,
  time: LogicalTime,
  failed: Variant<TaskState, "failed">,
  carrier: CarrierId,
): void {
  if (!isWorkflowTask(failed))
    throw new Error("Recovery requires a workflow task");
  for (const resource of draft.resources.values()) {
    const batch = resource.batch;
    if (batch === null || batch.kind === "idle" || batch.kind === "running")
      continue;
    for (const member of batch.members) {
      if (member.carrier !== carrier) continue;
      const process = held(draft.tasks, member.task, "batch member");
      if (
        !isWorkflowTask(process) ||
        process.subject.instance !== failed.subject.instance
      )
        continue;
      const executor = batchExecutor(draft, member.task);
      const handling =
        batch.kind === "loading" ? executor.load : executor.unload;
      if (handling !== failed.subject.key) continue;
      setBatch(draft, resource, withoutBatchMember(batch, member.task));
      emit(draft, time, {
        kind: "batch-member-rejected",
        resource: resource.id,
        cycle: batch.sequence,
        task: member.task,
        carrier,
        recovery: failed.id,
      });
    }
  }
}

export function batchExecutor(draft: Draft, id: TaskId): BatchExecutor {
  const task = held(draft.tasks, id, "batch task");
  if (!isWorkflowTask(task))
    throw new Error("A batch member must be a workflow task");
  const instance = held(draft.instances, task.subject.instance, "instance");
  const executor = taskDefinition(draft, instance, task.subject.key).executor;
  if (executor.kind !== "batch")
    throw new Error("A batch member needs a batch executor");
  return executor;
}

function batchForLoad(
  draft: Draft,
  task: WorkflowTask,
): Readonly<{ task: TaskId; executor: BatchExecutor }> | null {
  const instance = held(draft.instances, task.subject.instance, "instance");
  for (const definition of held(
    draft.index.tasks,
    instance.workflow,
    "workflow",
  ).values()) {
    const executor = definition.executor;
    if (executor.kind === "batch" && executor.load === task.subject.key)
      return { task: taskId(instance.id, definition.key), executor };
  }
  return null;
}

function unavailable(resource: ResourceState, time: LogicalTime): boolean {
  for (const entry of resource.withheld)
    if (intervalContains(entry.interval, time)) return true;
  return false;
}

/** Load admission and process dispatch share one persistent cycle gate. */
export function batchBlockers(
  draft: Draft,
  task: WorkflowTask,
  time: LogicalTime,
): Blocker[] {
  const instance = held(draft.instances, task.subject.instance, "instance");
  const executor = taskDefinition(draft, instance, task.subject.key).executor;
  if (executor.kind === "batch")
    return [
      { kind: "batch-cycle", resource: executor.resource, reason: "loading" },
    ];
  const load = batchForLoad(draft, task);
  if (load === null) return [];
  const resource = held(
    draft.resources,
    load.executor.resource,
    "batch resource",
  );
  const batch = resource.batch;
  if (batch === null) throw new Error("A batch resource has no cycle state");
  const blockers: Blocker[] = [];
  if (unavailable(resource, time))
    blockers.push({
      kind: "resource",
      resource: resource.id,
      reason: "unavailable",
    });
  switch (batch.kind) {
    case "idle":
      break;
    case "loading":
      if (time >= batch.closeAt)
        blockers.push({
          kind: "batch-cycle",
          resource: resource.id,
          reason: "closed",
        });
      else if (batch.program !== load.executor.program)
        blockers.push({
          kind: "batch-cycle",
          resource: resource.id,
          reason: "program",
        });
      break;
    case "running":
    case "unloading":
      blockers.push({
        kind: "batch-cycle",
        resource: resource.id,
        reason: batch.kind,
      });
      break;
    default:
      assertNever(batch);
  }
  return blockers;
}

function setBatch(
  draft: Draft,
  resource: ResourceState,
  batch: BatchState,
): void {
  draft.resources.set(resource.id, {
    id: resource.id,
    position: resource.position,
    batch,
    configuration: resource.configuration,
    changeovers: resource.changeovers,
    allocations: resource.allocations,
    withheld: resource.withheld,
  });
}

/** Register only after the load atomically claims its carrier and destination. */
export function admitBatchLoad(
  draft: Draft,
  time: LogicalTime,
  task: WorkflowTask,
): void {
  const load = batchForLoad(draft, task);
  if (load === null) return;
  const resource = held(
    draft.resources,
    load.executor.resource,
    "batch resource",
  );
  const definition = held(
    draft.index.resources,
    resource.id,
    "batch definition",
  );
  const previous = resource.batch;
  if (
    definition.kind !== "batch" ||
    previous === null ||
    (previous.kind !== "idle" && previous.kind !== "loading")
  )
    throw new Error("A load cannot enter this cycle");
  const instance = held(draft.instances, task.subject.instance, "instance");
  const carrier = boundCarrier(draft, instance, load.executor.carrier);
  const member = { task: load.task, carrier: carrier.id };
  const batch: Variant<BatchState, "loading"> = {
    kind: "loading",
    sequence:
      previous.kind === "idle" ? previous.sequence + 1 : previous.sequence,
    program: load.executor.program,
    openedAt: previous.kind === "idle" ? time : previous.openedAt,
    closeAt:
      previous.kind === "idle"
        ? advance(time, definition.loadWindow)
        : previous.closeAt,
    members:
      previous.kind === "idle" ? [member] : [...previous.members, member],
  };
  setBatch(draft, resource, batch);
  emit(draft, time, {
    kind: "batch-admitted",
    resource: resource.id,
    cycle: batch.sequence,
    program: batch.program,
    task: member.task,
    carrier: member.carrier,
    closeAt: batch.closeAt,
  });
}

function compatibleWorkflow(
  draft: Draft,
  workflow: WorkflowId,
  resource: ResourceId,
  program: BatchExecutor["program"],
): boolean {
  for (const task of held(draft.index.tasks, workflow, "workflow").values())
    if (
      task.executor.kind === "batch" &&
      task.executor.resource === resource &&
      task.executor.program === program
    )
      return true;
  return false;
}

/** A partial final cohort starts when no compatible future load remains. */
function hasFutureLoad(
  draft: Draft,
  resource: ResourceId,
  batch: Variant<BatchState, "loading">,
): boolean {
  for (const source of draft.arrivals.values()) {
    if (source.kind !== "open") continue;
    const definition = held(draft.index.sources, source.id, "source");
    if (compatibleWorkflow(draft, definition.workflow, resource, batch.program))
      return true;
  }
  for (const task of draft.tasks.values()) {
    if (task.kind !== "waiting" || !isWorkflowTask(task)) continue;
    const instance = held(draft.instances, task.subject.instance, "instance");
    const executor = taskDefinition(draft, instance, task.subject.key).executor;
    if (
      executor.kind !== "batch" ||
      executor.resource !== resource ||
      executor.program !== batch.program
    )
      continue;
    let member = false;
    for (const entry of batch.members)
      if (entry.task === task.id) member = true;
    if (!member) return true;
  }
  return false;
}

export function batchCanStart(
  draft: Draft,
  time: LogicalTime,
  resource: ResourceId,
): boolean {
  const state = held(draft.resources, resource, "batch resource");
  const definition = held(draft.index.resources, resource, "batch definition");
  const batch = state.batch;
  if (
    definition.kind !== "batch" ||
    batch?.kind !== "loading" ||
    unavailable(state, time)
  )
    return false;
  const storage = held(draft.storages, definition.storage, "batch storage");
  if (
    storage.reservations.length > 0 ||
    storage.occupants.length !== batch.members.length
  )
    return false;
  return (
    batch.members.length === definition.capacity ||
    time >= batch.closeAt ||
    !hasFutureLoad(draft, resource, batch)
  );
}

export function batchDuration(
  definition: Variant<ResourceDefinition, "batch">,
  program: BatchExecutor["program"],
): TickDuration {
  for (const candidate of definition.programs)
    if (candidate.id === program) return candidate.duration;
  throw new Error(`Batch resource ${definition.id} has no program ${program}`);
}

export function beginBatch(
  draft: Draft,
  time: LogicalTime,
  id: ResourceId,
): void {
  const resource = held(draft.resources, id, "batch resource");
  const definition = held(draft.index.resources, id, "batch definition");
  const previous = resource.batch;
  if (definition.kind !== "batch" || previous?.kind !== "loading")
    throw new Error("The batch is not loading");
  const completesAt = advance(
    time,
    batchDuration(definition, previous.program),
  );
  setBatch(draft, resource, {
    kind: "running",
    sequence: previous.sequence,
    program: previous.program,
    startedAt: time,
    completesAt,
    members: previous.members,
  });
  emit(draft, time, {
    kind: "batch-started",
    resource: id,
    cycle: previous.sequence,
    program: previous.program,
    completesAt,
  });
}

/** Runs after all same-tick task completions, before new admission. */
export function settleBatches(draft: Draft, time: LogicalTime): void {
  for (const resource of draft.resources.values()) {
    const batch = resource.batch;
    if (batch === null || batch.kind === "idle" || batch.kind === "loading")
      continue;
    if (batch.kind === "running") {
      if (time < batch.completesAt) continue;
      for (const member of batch.members)
        if (held(draft.tasks, member.task, "batch task").kind !== "completed")
          throw new Error("A cycle cannot finish before its members");
      setBatch(draft, resource, {
        kind: "unloading",
        sequence: batch.sequence,
        program: batch.program,
        completedAt: time,
        members: batch.members,
      });
      emit(draft, time, {
        kind: "batch-completed",
        resource: resource.id,
        cycle: batch.sequence,
      });
      continue;
    }
    let clear = true;
    for (const member of batch.members) {
      const task = held(draft.tasks, member.task, "batch task");
      if (!isWorkflowTask(task))
        throw new Error("A batch member must be a workflow task");
      const executor = batchExecutor(draft, task.id);
      if (
        held(
          draft.tasks,
          taskId(task.subject.instance, executor.unload),
          "unload task",
        ).kind !== "completed"
      )
        clear = false;
    }
    if (!clear) continue;
    setBatch(draft, resource, { kind: "idle", sequence: batch.sequence });
    emit(draft, time, {
      kind: "batch-cleared",
      resource: resource.id,
      cycle: batch.sequence,
    });
  }
}
