import { emit, held, type Draft } from "./engine-draft.ts";
import type { ResourceId, TaskId } from "./identity.ts";
import type { Allocation } from "./state.ts";
import type { LogicalTime } from "./time.ts";

/** Every capacity claim changes state and accepted history together. */
export function claimResource(
  draft: Draft,
  time: LogicalTime,
  resourceId: ResourceId,
  task: TaskId,
  kind: Allocation["kind"],
  units: number,
): void {
  const resource = held(draft.resources, resourceId, "resource");
  const allocations: Allocation[] = [];
  for (const allocation of resource.allocations)
    if (allocation.task !== task) allocations.push(allocation);
  allocations.push({ task, kind, units, since: time });
  draft.resources.set(resource.id, { ...resource, allocations });
  emit(draft, time, {
    kind: "resource-claimed",
    resource: resource.id,
    task,
    allocation: kind,
    units,
  });
}

export function holdTaskResources(
  draft: Draft,
  time: LogicalTime,
  task: TaskId,
): void {
  for (const resource of draft.resources.values())
    for (const allocation of resource.allocations)
      if (allocation.task === task)
        claimResource(draft, time, resource.id, task, "held", allocation.units);
}

export function releaseResource(
  draft: Draft,
  time: LogicalTime,
  resourceId: ResourceId,
  task: TaskId,
): void {
  const resource = held(draft.resources, resourceId, "resource");
  const allocations: Allocation[] = [];
  for (const allocation of resource.allocations)
    if (allocation.task !== task) allocations.push(allocation);
  if (allocations.length === resource.allocations.length) return;
  draft.resources.set(resource.id, { ...resource, allocations });
  emit(draft, time, { kind: "resource-released", resource: resource.id, task });
}

export function releaseTaskResources(
  draft: Draft,
  time: LogicalTime,
  task: TaskId,
): void {
  for (const resource of draft.resources.values())
    releaseResource(draft, time, resource.id, task);
}
