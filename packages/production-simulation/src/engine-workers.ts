import type { Variant } from "@purin-labs/type-utils";
import { emit, held, type Draft } from "./engine-draft.ts";
import { claimResource, releaseResource } from "./engine-resources.ts";
import type { TaskId } from "./identity.ts";
import type { TaskExecutor } from "./scenario.ts";
import type { ResourceState, WorkerAssignment } from "./state.ts";
import { advance, intervalContains, type LogicalTime } from "./time.ts";
import {
  activeWorkerRoutes,
  travelDurationFromRoutes,
  validTravelRouteReplacement,
  validWorkerTravelReplacement,
} from "./worker-travel.ts";

export {
  activeWorkerRoutes,
  travelDurationFromRoutes,
  validTravelRouteReplacement,
  validWorkerTravelReplacement,
};

/** Candidate order is policy. Travel distance never changes that order. */
export function availableWorker(
  draft: Draft,
  executor: Variant<TaskExecutor, "attended">,
  time: LogicalTime,
): ResourceState | null {
  for (const id of executor.workers) {
    const worker = held(draft.resources, id, "worker");
    if (worker.position.kind !== "idle" || worker.allocations.length > 0)
      continue;
    let withheld = false;
    for (const entry of worker.withheld)
      if (intervalContains(entry.interval, time)) withheld = true;
    if (!withheld) return worker;
  }
  return null;
}

/** Called only after all task blockers clear, alongside its other claims. */
export function assignWorker(
  draft: Draft,
  time: LogicalTime,
  task: TaskId,
  executor: Variant<TaskExecutor, "attended">,
): LogicalTime {
  const worker = availableWorker(draft, executor, time);
  if (worker === null || worker.position.kind !== "idle")
    throw new Error(`Task ${task} started without an available worker`);
  const definition = held(draft.index.resources, worker.id, "worker");
  if (definition.kind !== "worker")
    throw new Error(`Resource ${worker.id} cannot travel`);
  const routes = draft.workerTravel.get(worker.id) ?? definition.travel;
  const duration = travelDurationFromRoutes(
    routes,
    worker.position.at,
    executor.start,
  );
  if (duration === null)
    throw new Error(
      `Worker ${worker.id} has no admitted route to ${executor.start}`,
    );
  const arrivesAt = advance(time, duration);
  const assignment: WorkerAssignment = {
    task,
    from: worker.position.at,
    start: executor.start,
    finish: executor.finish,
    arrivesAt,
    completesAt: advance(arrivesAt, executor.duration),
  };
  draft.resources.set(worker.id, {
    id: worker.id,
    batch: null,
    position: {
      kind: "assigned",
      task,
      from: assignment.from,
      start: assignment.start,
      finish: assignment.finish,
      arrivesAt,
      completesAt: assignment.completesAt,
    },
    configuration: null,
    changeovers: 0,
    allocations: [],
    withheld: worker.withheld,
  });
  claimResource(draft, time, worker.id, task, "occupied", 1);
  emit(draft, time, {
    kind: "worker-assigned",
    worker: worker.id,
    ...assignment,
  });
  return arrivesAt;
}

/** Completion leaves the worker at the task endpoint for the next dispatch. */
export function finishWorker(
  draft: Draft,
  time: LogicalTime,
  task: TaskId,
): void {
  for (const worker of draft.resources.values()) {
    if (worker.position.kind !== "assigned" || worker.position.task !== task)
      continue;
    releaseResource(draft, time, worker.id, task);
    draft.resources.set(worker.id, {
      id: worker.id,
      batch: null,
      position: { kind: "idle", at: worker.position.finish },
      configuration: null,
      changeovers: 0,
      allocations: [],
      withheld: worker.withheld,
    });
  }
}
