import { assertNever, isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import * as d from "./document-values.ts";
import type { Blocker, RunState, TaskState, TaskSubject } from "./state.ts";
import { readBlocker } from "./blocker-document.ts";
import { readTaskSubject } from "./state-document.ts";
import { taskId, type WorkflowId } from "./identity.ts";
import type { WorkflowDefinition } from "./scenario.ts";
import { referencedTask } from "./dependencies.ts";

/** Plain protocol data. All times use the host view's microsecond clock. */
export type TaskView = Readonly<{
  id: string;
  subject: TaskSubject;
}> &
  StrictUnion<
    | Readonly<{ kind: "waiting"; since: number; blockers: readonly Blocker[] }>
    | Readonly<{ kind: "reserved"; reservedAt: number }>
    | Readonly<{
        kind: "skipped";
        completedAt: number;
        inspection: string;
        outcome: "accept" | "reject";
      }>
    | Readonly<{
        kind: "executing";
        startedAt: number;
        completesAt: number | null;
      }>
    | Readonly<{ kind: "completed"; startedAt: number; completedAt: number }>
    | Readonly<{
        kind: "recovery-required" | "recovering" | "recovery-failed";
        startedAt: number;
        failedAt: number;
      }>
    | Readonly<{
        kind: "failed";
        startedAt: number;
        failedAt: number;
        resolvedAt: number;
      }>
    | Readonly<{ kind: "cancelled"; cause: string; cancelledAt: number }>
  >;

/** A task can wait in several queues. Counts across queues are not additive. */
export type QueueView = Readonly<{
  kind: "resource" | "storage" | "cell";
  id: string;
  tasks: readonly string[];
}>;

export type ResourceView = Readonly<{
  id: string;
  kind: "capacity" | "batch" | "worker";
  capacity: number;
  available: boolean;
  position: string;
  batchPhase: "idle" | "loading" | "running" | "unloading" | null;
  allocations: readonly Readonly<{
    task: string;
    kind: "reserved" | "occupied" | "held";
    units: number;
    since: number;
  }>[];
}>;

export type CarrierStoreView = Readonly<{
  id: string;
  capacity: number;
  occupants: readonly string[];
  reservations: readonly Readonly<{ task: string; carrier: string }>[];
}>;

export type LogisticsView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      version: 2;
      /** Null when the retained engine cannot expose the dependency graph. */
      dependencies: readonly TaskDependencyView[] | null;
      tasks: readonly TaskView[];
      queues: readonly QueueView[];
      resources: readonly ResourceView[];
      carrierStores: readonly CarrierStoreView[];
    }>
>;

export type TaskDependencyView = Readonly<{
  task: string;
  prerequisite: string;
}>;

function taskDependencies(run: RunState): readonly TaskDependencyView[] {
  const dependencies: TaskDependencyView[] = [];
  const admitted = new Set(run.tasks.map(taskIdentity));
  const workflows = new Map<WorkflowId, WorkflowDefinition>();
  for (const workflow of run.definition.scenario.workflows)
    workflows.set(workflow.id, workflow);
  for (const instance of run.instances) {
    const workflow = workflows.get(instance.workflow);
    if (workflow === undefined) throw new Error("Missing admitted workflow");
    for (const task of workflow.tasks)
      for (const key of task.prerequisites)
        dependencies.push({
          task: taskId(instance.id, task.key),
          prerequisite: taskId(instance.id, key),
        });
  }
  for (const dependency of run.definition.scenario.dependencies) {
    const task = referencedTask(dependency.task);
    if (admitted.has(task))
      dependencies.push({
        task,
        prerequisite: referencedTask(dependency.prerequisite),
      });
  }
  return dependencies;
}

function taskIdentity(task: TaskState): string {
  return task.id;
}

function taskView(task: TaskState): TaskView {
  const identity = {
    id: task.id,
    subject: task.subject,
  };
  switch (task.kind) {
    case "waiting":
      return {
        ...identity,
        kind: task.kind,
        since: task.since,
        blockers: task.blockers,
      };
    case "reserved":
      return { ...identity, kind: task.kind, reservedAt: task.reservedAt };
    case "skipped":
      return {
        id: task.id,
        subject: task.subject,
        kind: "skipped",
        completedAt: task.completedAt,
        inspection: task.inspection,
        outcome: task.outcome,
      };
    case "executing":
      return {
        ...identity,
        kind: task.kind,
        startedAt: task.startedAt,
        completesAt: task.completesAt,
      };
    case "completed":
      return {
        ...identity,
        kind: task.kind,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      };
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
      return {
        ...identity,
        kind: task.kind,
        startedAt: task.startedAt,
        failedAt: task.failedAt,
      };
    case "failed":
      return {
        ...identity,
        kind: task.kind,
        startedAt: task.startedAt,
        failedAt: task.failedAt,
        resolvedAt: task.resolvedAt,
      };
    case "cancelled":
      return {
        ...identity,
        kind: task.kind,
        cause: task.cause,
        cancelledAt: task.cancelledAt,
      };
    default:
      return assertNever(task);
  }
}

type QueueDraft = { kind: QueueView["kind"]; id: string; tasks: string[] };

function enqueue(
  queues: Map<string, QueueDraft>,
  kind: QueueView["kind"],
  id: string,
  task: string,
): void {
  const key = `${kind}:${id}`;
  const queue = queues.get(key);
  if (queue === undefined) queues.set(key, { kind, id, tasks: [task] });
  else if (!queue.tasks.includes(task)) queue.tasks.push(task);
}

function enqueueBlocker(
  queues: Map<string, QueueDraft>,
  task: string,
  blocker: Blocker,
): void {
  switch (blocker.kind) {
    case "resource":
    case "batch-cycle":
    case "configuration":
      enqueue(queues, "resource", blocker.resource, task);
      return;
    case "workers":
      for (const worker of blocker.workers)
        enqueue(queues, "resource", worker, task);
      return;
    case "carrier":
      enqueue(queues, "storage", blocker.store, task);
      return;
    case "destination":
      enqueue(queues, "storage", blocker.storage, task);
      return;
    case "cell-slot":
    case "cell-state":
      enqueue(queues, "cell", blocker.cell, task);
      return;
    case "release":
    case "inspection":
    case "prerequisite":
    case "material":
      return;
    default:
      return assertNever(blocker);
  }
}

export function taskQueues(tasks: readonly TaskView[]): readonly QueueView[] {
  const queues = new Map<string, QueueDraft>();
  for (const task of tasks)
    if (task.kind === "waiting")
      for (const blocker of task.blockers)
        enqueueBlocker(queues, task.id, blocker);
  return [...queues.values()];
}

export function logisticsView(run: RunState): LogisticsView {
  const resources: ResourceView[] = [];
  for (const definition of run.definition.scenario.resources) {
    const resource = run.resources.find(resourceById.bind(null, definition.id));
    if (resource === undefined) throw new Error("Missing admitted resource");
    resources.push({
      id: resource.id,
      kind: definition.kind,
      capacity: definition.capacity,
      available: !resource.withheld.some(
        withheldAt.bind(null, run.position.time),
      ),
      position: resourcePosition(resource.position),
      batchPhase: resource.batch?.kind ?? null,
      allocations: resource.allocations,
    });
  }
  const carrierStores: CarrierStoreView[] = [];
  for (const definition of run.definition.scenario.storages) {
    if (definition.capacity.kind !== "carriers") continue;
    const storage = run.storages.find(storageById.bind(null, definition.id));
    if (storage === undefined) throw new Error("Missing admitted storage");
    carrierStores.push({
      id: storage.id,
      capacity: definition.capacity.slots,
      occupants: storage.occupants,
      reservations: storage.reservations,
    });
  }
  return {
    kind: "available",
    version: 2,
    dependencies: taskDependencies(run),
    tasks: run.tasks.map(taskView),
    queues: taskQueues(run.tasks.map(taskView)),
    resources,
    carrierStores,
  };
}

function resourceById(id: string, resource: RunState["resources"][number]) {
  return resource.id === id;
}

function storageById(id: string, storage: RunState["storages"][number]) {
  return storage.id === id;
}

function withheldAt(
  time: number,
  withheld: RunState["resources"][number]["withheld"][number],
): boolean {
  return withheld.interval.start <= time && time < withheld.interval.end;
}

function resourcePosition(
  position: RunState["resources"][number]["position"],
): string {
  switch (position.kind) {
    case "fixed":
      return "Fixed";
    case "idle":
      return position.at;
    case "assigned":
      return `${position.from} → ${position.start} → ${position.finish}`;
    default:
      return assertNever(position);
  }
}

function object(raw: unknown): Record<string, unknown> {
  d.requireValue(isRecord(raw));
  return raw;
}

function readTask(raw: unknown): TaskView {
  const r = object(raw);
  const identity = {
    id: d.text(r.id),
    subject: readTaskSubject(r.subject),
  };
  const kind = d.choice(
    r.kind,
    "waiting",
    "reserved",
    "executing",
    "completed",
    "skipped",
    "recovery-required",
    "recovering",
    "recovery-failed",
    "failed",
    "cancelled",
  );
  switch (kind) {
    case "waiting":
      return {
        ...identity,
        kind,
        since: d.natural(r.since),
        blockers: d.array(r.blockers, readBlocker),
      };
    case "reserved":
      return { ...identity, kind, reservedAt: d.natural(r.reservedAt) };
    case "skipped":
      return {
        id: identity.id,
        subject: identity.subject,
        kind,
        completedAt: d.natural(r.completedAt),
        inspection: d.text(r.inspection),
        outcome: d.choice(r.outcome, "accept", "reject"),
      };
    case "executing":
      return {
        ...identity,
        kind,
        startedAt: d.natural(r.startedAt),
        completesAt: d.nullable(r.completesAt, d.natural),
      };
    case "completed":
      return {
        ...identity,
        kind,
        startedAt: d.natural(r.startedAt),
        completedAt: d.natural(r.completedAt),
      };
    case "recovery-required":
    case "recovering":
    case "recovery-failed":
      return {
        ...identity,
        kind,
        startedAt: d.natural(r.startedAt),
        failedAt: d.natural(r.failedAt),
      };
    case "failed":
      return {
        ...identity,
        kind,
        startedAt: d.natural(r.startedAt),
        failedAt: d.natural(r.failedAt),
        resolvedAt: d.natural(r.resolvedAt),
      };
    case "cancelled":
      return {
        ...identity,
        kind,
        cause: d.text(r.cause),
        cancelledAt: d.natural(r.cancelledAt),
      };
    default:
      return assertNever(kind);
  }
}

function readQueue(raw: unknown): QueueView {
  const r = object(raw);
  return {
    kind: d.choice(r.kind, "resource", "storage", "cell"),
    id: d.text(r.id),
    tasks: d.array(r.tasks, d.text),
  };
}

function readAllocation(raw: unknown): ResourceView["allocations"][number] {
  const r = object(raw);
  return {
    task: d.text(r.task),
    kind: d.choice(r.kind, "reserved", "occupied", "held"),
    units: d.positive(r.units),
    since: d.natural(r.since),
  };
}

function readResource(raw: unknown): ResourceView {
  const r = object(raw);
  return {
    id: d.text(r.id),
    kind: d.choice(r.kind, "capacity", "batch", "worker"),
    capacity: d.positive(r.capacity),
    available: d.boolean(r.available),
    position: d.text(r.position),
    batchPhase: d.nullable(r.batchPhase, readBatchPhase),
    allocations: d.array(r.allocations, readAllocation),
  };
}

function readBatchPhase(raw: unknown): NonNullable<ResourceView["batchPhase"]> {
  return d.choice(raw, "idle", "loading", "running", "unloading");
}

function readReservation(
  raw: unknown,
): CarrierStoreView["reservations"][number] {
  const r = object(raw);
  return { task: d.text(r.task), carrier: d.text(r.carrier) };
}

function readCarrierStore(raw: unknown): CarrierStoreView {
  const r = object(raw);
  return {
    id: d.text(r.id),
    capacity: d.positive(r.capacity),
    occupants: d.array(r.occupants, d.text),
    reservations: d.array(r.reservations, readReservation),
  };
}

/** Normalize older retained host replies only at this request boundary. */
export function readLogisticsView(raw: unknown): LogisticsView {
  if (raw === undefined) return { kind: "unavailable" };
  const r = object(raw);
  const kind = d.choice(r.kind, "available", "unavailable");
  if (kind === "unavailable") return { kind };
  const version = d.choice(r.version, 1, 2);
  return {
    kind,
    version: 2,
    dependencies:
      version === 1 ? null : d.nullable(r.dependencies, readDependencies),
    tasks: d.array(r.tasks, readTask),
    queues: d.array(r.queues, readQueue),
    resources: d.array(r.resources, readResource),
    carrierStores: d.array(r.carrierStores, readCarrierStore),
  };
}

function readDependencies(raw: unknown): readonly TaskDependencyView[] {
  return d.array(raw, readDependency);
}

function readDependency(raw: unknown): TaskDependencyView {
  const r = object(raw);
  return { task: d.text(r.task), prerequisite: d.text(r.prerequisite) };
}
