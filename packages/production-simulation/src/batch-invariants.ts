import { assertNever, sameJson } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import { requireValue } from "./document-values.ts";
import {
  batchDuration,
  batchExecutor,
  withoutBatchMember,
} from "./engine-batches.ts";
import {
  held,
  isWorkflowTask,
  thaw,
  type Draft,
  type WorkflowTask,
} from "./engine-draft.ts";
import type { AcceptedEvent } from "./events.ts";
import { taskId, type TaskId } from "./identity.ts";
import type { ResourceDefinition } from "./scenario.ts";
import type { BatchState, RunState } from "./state.ts";
import { advance } from "./time.ts";

type BatchEvent = Extract<
  AcceptedEvent,
  {
    kind:
      | "batch-admitted"
      | "batch-started"
      | "batch-completed"
      | "batch-cleared"
      | "batch-member-rejected";
  }
>;

function isBatchEvent(event: AcceptedEvent): event is BatchEvent {
  return (
    event.kind === "batch-admitted" ||
    event.kind === "batch-started" ||
    event.kind === "batch-completed" ||
    event.kind === "batch-cleared" ||
    event.kind === "batch-member-rejected"
  );
}

function memberTask(draft: Draft, id: TaskId): WorkflowTask {
  const task = held(draft.tasks, id, "batch member");
  requireValue(isWorkflowTask(task));
  const instance = held(draft.instances, task.subject.instance, "instance");
  const definition = held(
    held(draft.index.tasks, instance.workflow, "workflow"),
    task.subject.key,
    "task definition",
  );
  requireValue(definition.executor.kind === "batch");
  return task;
}

function acceptBatchEvent(
  draft: Draft,
  definition: Variant<ResourceDefinition, "batch">,
  state: BatchState,
  event: BatchEvent,
): BatchState {
  switch (event.kind) {
    case "batch-admitted": {
      requireValue(state.kind === "idle" || state.kind === "loading");
      const task = memberTask(draft, event.task);
      const executor = batchExecutor(draft, task.id);
      requireValue(
        executor.resource === definition.id &&
          executor.program === event.program,
      );
      const load = held(
        draft.tasks,
        taskId(task.subject.instance, executor.load),
        "batch load",
      );
      requireValue(
        (load.kind === "executing" ||
          load.kind === "completed" ||
          load.kind === "recovery-required" ||
          load.kind === "recovering" ||
          load.kind === "recovery-failed" ||
          load.kind === "failed") &&
          load.startedAt === event.time,
      );
      let acquired = false;
      for (const earlier of draft.events)
        if (
          earlier.kind === "carrier-acquired" &&
          earlier.instance === task.subject.instance &&
          earlier.role === executor.carrier &&
          earlier.carrier === event.carrier &&
          earlier.time <= event.time
        )
          acquired = true;
      requireValue(acquired);
      if (state.kind === "idle") {
        requireValue(
          event.cycle === state.sequence + 1 &&
            event.closeAt === advance(event.time, definition.loadWindow),
        );
        return {
          kind: "loading",
          sequence: event.cycle,
          program: event.program,
          openedAt: event.time,
          closeAt: event.closeAt,
          members: [{ task: task.id, carrier: event.carrier }],
        };
      }
      requireValue(
        event.cycle === state.sequence &&
          event.program === state.program &&
          event.closeAt === state.closeAt &&
          event.time < state.closeAt,
      );
      for (const member of state.members)
        requireValue(
          member.task !== task.id && member.carrier !== event.carrier,
        );
      requireValue(state.members.length < definition.capacity);
      return {
        kind: "loading",
        sequence: state.sequence,
        program: state.program,
        openedAt: state.openedAt,
        closeAt: state.closeAt,
        members: [...state.members, { task: task.id, carrier: event.carrier }],
      };
    }
    case "batch-started": {
      requireValue(
        state.kind === "loading" &&
          event.cycle === state.sequence &&
          event.program === state.program,
      );
      requireValue(
        event.completesAt ===
          advance(event.time, batchDuration(definition, event.program)),
      );
      for (const member of state.members) {
        const task = memberTask(draft, member.task);
        const executor = batchExecutor(draft, task.id);
        const load = held(
          draft.tasks,
          taskId(task.subject.instance, executor.load),
          "batch load",
        );
        requireValue(
          load.kind === "completed" && load.completedAt <= event.time,
        );
        requireValue(
          (task.kind === "executing" || task.kind === "completed") &&
            task.startedAt === event.time,
        );
        requireValue(
          task.kind === "executing"
            ? task.completesAt === event.completesAt
            : task.completedAt === event.completesAt,
        );
      }
      return {
        kind: "running",
        sequence: state.sequence,
        program: state.program,
        startedAt: event.time,
        completesAt: event.completesAt,
        members: state.members,
      };
    }
    case "batch-completed": {
      requireValue(
        state.kind === "running" &&
          event.cycle === state.sequence &&
          event.time === state.completesAt,
      );
      for (const member of state.members) {
        const task = held(draft.tasks, member.task, "batch member");
        requireValue(
          task.kind === "completed" && task.completedAt === event.time,
        );
      }
      return {
        kind: "unloading",
        sequence: state.sequence,
        program: state.program,
        completedAt: event.time,
        members: state.members,
      };
    }
    case "batch-cleared": {
      requireValue(
        state.kind === "unloading" && event.cycle === state.sequence,
      );
      let last = state.completedAt;
      for (const member of state.members) {
        const task = memberTask(draft, member.task);
        const executor = batchExecutor(draft, task.id);
        const unload = held(
          draft.tasks,
          taskId(task.subject.instance, executor.unload),
          "batch unload",
        );
        requireValue(
          unload.kind === "completed" && unload.startedAt >= state.completedAt,
        );
        if (unload.completedAt > last) last = unload.completedAt;
      }
      for (const earlier of draft.events)
        if (
          earlier.kind === "batch-member-rejected" &&
          earlier.resource === definition.id &&
          earlier.cycle === state.sequence &&
          earlier.sequence < event.sequence &&
          earlier.time > last
        )
          last = earlier.time;
      requireValue(event.time === last);
      return { kind: "idle", sequence: state.sequence };
    }
    case "batch-member-rejected": {
      requireValue(
        (state.kind === "loading" || state.kind === "unloading") &&
          event.cycle === state.sequence,
      );
      const process = memberTask(draft, event.task);
      const executor = batchExecutor(draft, event.task);
      const handling =
        state.kind === "loading" ? executor.load : executor.unload;
      requireValue(
        executor.resource === definition.id &&
          event.recovery === taskId(process.subject.instance, handling),
      );
      let memberFound = false;
      for (const member of state.members)
        if (member.task === event.task && member.carrier === event.carrier)
          memberFound = true;
      requireValue(memberFound);
      const recovered = held(
        draft.tasks,
        event.recovery,
        "recovered batch handler",
      );
      requireValue(
        recovered.kind === "failed" && recovered.resolvedAt === event.time,
      );
      let completed = false;
      for (const earlier of draft.events)
        if (
          earlier.kind === "recovery-completed" &&
          earlier.task === event.recovery &&
          earlier.time === event.time &&
          earlier.sequence < event.sequence
        )
          completed = true;
      requireValue(completed);
      return withoutBatchMember(state, event.task);
    }
    default:
      return assertNever(event);
  }
}

/** Saved cycle membership must agree with history, physical custody and task state. */
export function validateBatches(run: RunState): void {
  const draft = thaw(run);
  const active = new Set<TaskId>();
  for (const resource of run.resources) {
    const definition = held(draft.index.resources, resource.id, "resource");
    if (definition.kind !== "batch") {
      requireValue(resource.batch === null);
      continue;
    }
    let state: BatchState = { kind: "idle", sequence: 0 };
    for (const event of run.events)
      if (isBatchEvent(event) && event.resource === resource.id)
        state = acceptBatchEvent(draft, definition, state, event);
    requireValue(
      sameJson(state, resource.batch) &&
        resource.configuration === null &&
        resource.changeovers === 0,
    );
    const storage = held(draft.storages, definition.storage, "batch storage");
    if (state.kind === "idle") {
      requireValue(
        storage.occupants.length === 0 &&
          storage.reservations.length === 0 &&
          resource.allocations.length === 0,
      );
      continue;
    }
    for (const occupant of storage.occupants) {
      let found = false;
      for (const member of state.members)
        if (member.carrier === occupant) found = true;
      requireValue(found);
    }
    if (state.kind === "running")
      requireValue(
        storage.occupants.length === state.members.length &&
          storage.reservations.length === 0 &&
          resource.allocations.length === state.members.length,
      );
    else requireValue(resource.allocations.length === 0);
    for (const member of state.members) {
      const task = memberTask(draft, member.task);
      const executor = batchExecutor(draft, task.id);
      const unload = held(
        draft.tasks,
        taskId(task.subject.instance, executor.unload),
        "batch unload",
      );
      if (state.kind === "loading")
        requireValue(task.kind === "waiting" && unload.kind === "waiting");
      if (state.kind === "running") {
        requireValue(
          task.kind === "executing" &&
            task.attempt === null &&
            unload.kind === "waiting",
        );
        active.add(task.id);
        let allocated = false;
        for (const allocation of resource.allocations)
          if (
            allocation.task === task.id &&
            allocation.kind === "occupied" &&
            allocation.units === 1 &&
            allocation.since === state.startedAt
          )
            allocated = true;
        requireValue(allocated);
        let completions = 0;
        for (const pending of run.scheduled) {
          if (pending.task !== task.id) continue;
          requireValue(
            pending.kind === "task-boundary" &&
              pending.carrierStep === null &&
              pending.order.phase === "settle" &&
              pending.order.origin === "declared" &&
              pending.order.boundary === "completion" &&
              pending.order.task === task.id &&
              pending.order.time === state.completesAt,
          );
          completions += 1;
        }
        requireValue(completions === 1);
      }
      if (state.kind === "unloading") {
        requireValue(task.kind === "completed");
        requireValue(
          unload.kind === "waiting" ||
            unload.kind === "executing" ||
            unload.kind === "completed" ||
            unload.kind === "recovery-required" ||
            unload.kind === "recovering" ||
            unload.kind === "recovery-failed",
        );
        if (unload.kind !== "waiting")
          requireValue(unload.startedAt >= state.completedAt);
      }
      if (unload.kind === "completed") continue;
      const carrier = held(draft.carriers, member.carrier, "batch carrier");
      requireValue(
        carrier.bound?.instance === task.subject.instance &&
          carrier.bound.role === executor.carrier,
      );
    }
  }
  for (const task of run.tasks) {
    if (task.kind !== "executing" || !isWorkflowTask(task)) continue;
    const instance = held(draft.instances, task.subject.instance, "instance");
    const definition = held(
      held(draft.index.tasks, instance.workflow, "workflow"),
      task.subject.key,
      "task definition",
    );
    if (definition.executor.kind === "batch") requireValue(active.has(task.id));
  }
}
