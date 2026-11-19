import type { MaterialStorageHistoryView } from "./material-history.ts";
import { readMaterialStorageHistory } from "./material-history-view.ts";
import { isRecord } from "@purin-labs/std";
import * as d from "./document-values.ts";
import { err, ok } from "./result.ts";
import type { RunState } from "./state.ts";
import type { AcceptedEvent } from "./events.ts";
import type { LogicalTime } from "./time.ts";
import {
  logisticsView,
  readLogisticsView,
  taskQueues,
  type CarrierStoreView,
  type LogisticsView,
  type ResourceView,
  type TaskView,
} from "./logistics-view.ts";
import { runResults } from "./results.ts";
import {
  readProductionReport,
  type ProductionReport,
} from "./production-view.ts";
import {
  readResourceHistory,
  type ResourceHistoryView,
} from "./resource-history-view.ts";
import { readStorageHistory } from "./storage-history-view.ts";
import type { StorageHistoryView } from "./storage-history.ts";
import { readSchedulingHistory } from "./scheduling-history-document.ts";
import type { SchedulingHistoryView } from "./scheduling-history.ts";
import type { Variant } from "@purin-labs/type-utils";

/** Inspection has no execution identity, status or command authority. */
export type ObservationView = Readonly<{
  time: number;
  horizon: number;
  logistics: LogisticsView;
  results: ProductionReport;
  resourceHistory: ResourceHistoryView;
  storageHistory: StorageHistoryView;
  materialStorageHistory: MaterialStorageHistoryView;
  schedulingHistory: SchedulingHistoryView;
}>;

export function observationView(
  run: RunState,
  at: LogicalTime,
): ObservationView {
  if (at > run.position.time)
    throw new RangeError("Observation cannot cross the committed boundary");
  const results = runResults(run, { after: null, through: at });
  return {
    time: at,
    horizon: run.position.horizon,
    logistics: logisticsAt(run, at),
    results: {
      orders: results.orders,
      ordersCompleted: results.ordersCompleted,
      reported: results.reported,
      stock: results.stock,
    },
    resourceHistory: {
      kind: "available",
      version: 1,
      after: 0,
      through: at,
      resources: results.resources,
    },
    storageHistory: results.storageHistory,
    materialStorageHistory: results.materialStorageHistory,
    schedulingHistory: results.schedulingHistory,
  };
}

export function parseObservationView(raw: unknown) {
  try {
    d.requireValue(isRecord(raw));
    const time = d.time(raw.time);
    const view: ObservationView = {
      time,
      horizon: d.time(raw.horizon),
      logistics: readLogisticsView(raw.logistics),
      results: readProductionReport(raw.results),
      resourceHistory: readResourceHistory(raw.resourceHistory),
      storageHistory: readStorageHistory(raw.storageHistory),
      materialStorageHistory: readMaterialStorageHistory(
        raw.materialStorageHistory,
      ),
      schedulingHistory: readSchedulingHistory(raw.schedulingHistory),
    };
    for (const history of [
      view.resourceHistory,
      view.storageHistory,
      view.materialStorageHistory,
      view.schedulingHistory,
    ])
      if (history.kind === "available")
        d.requireValue(history.after === 0 && history.through === time);
    return ok(view);
  } catch (error) {
    if (error instanceof d.InvalidDocument) return err("invalid_observation");
    throw error;
  }
}

function logisticsAt(run: RunState, at: LogicalTime): LogisticsView {
  const current = logisticsView(run);
  if (at === run.position.time || current.kind === "unavailable")
    return current;
  const events: AcceptedEvent[] = [];
  for (const event of run.events) {
    if (event.time > at) break;
    events.push(event);
  }
  const tasks: TaskView[] = [];
  const admitted = new Set<string>();
  for (const task of current.tasks) {
    const observed = taskAt(run, task, events, at);
    if (observed !== null) {
      tasks.push(observed);
      admitted.add(observed.id);
    }
  }
  const dependencies = [];
  for (const edge of current.dependencies ?? [])
    if (admitted.has(edge.task)) dependencies.push(edge);
  return {
    kind: "available",
    version: 2,
    tasks,
    dependencies,
    queues: taskQueues(tasks),
    resources: resourcesAt(run, events),
    carrierStores: storesAt(run, events),
  };
}

function taskAt(
  run: RunState,
  current: TaskView,
  events: readonly AcceptedEvent[],
  at: LogicalTime,
): TaskView | null {
  let arrivedAt: number | null = null;
  if (current.subject.kind === "workflow")
    for (const instance of run.instances)
      if (
        instance.id === current.subject.instance &&
        instance.arrival.time <= at
      )
        arrivedAt = instance.arrival.time;
  if (current.subject.kind === "changeover")
    for (const event of events)
      if (event.kind === "task-reserved" && event.task === current.id) {
        arrivedAt = event.time;
        break;
      }
  if (arrivedAt === null) return null;
  let task: TaskView = {
    id: current.id,
    subject: current.subject,
    kind: "waiting",
    since: arrivedAt,
    blockers: [],
  };
  let startedAt: number | null = null;
  let failedAt: number | null = null;
  for (const event of events) {
    if (event.kind === "waiting-changed" && task.kind === "waiting")
      for (const wait of event.waiting)
        if (wait.task === current.id)
          task = {
            id: current.id,
            subject: current.subject,
            kind: "waiting",
            since: arrivedAt,
            blockers: wait.blockers,
          };
    if (!("task" in event) || event.task !== current.id) continue;
    switch (event.kind) {
      case "task-reserved":
        task = {
          id: current.id,
          subject: current.subject,
          kind: "reserved",
          reservedAt: event.time,
        };
        break;
      case "task-started":
        startedAt = event.time;
        task = {
          id: current.id,
          subject: current.subject,
          kind: "executing",
          startedAt,
          completesAt: null,
        };
        break;
      case "task-completed":
        if (startedAt === null)
          throw new Error("Task completion has no accepted start");
        task = {
          id: current.id,
          subject: current.subject,
          kind: "completed",
          startedAt,
          completedAt: event.time,
        };
        break;
      case "task-skipped":
        task = {
          id: current.id,
          subject: current.subject,
          kind: "skipped",
          completedAt: event.time,
          inspection: event.inspection,
          outcome: event.outcome,
        };
        break;
      case "task-failed":
        if (startedAt === null)
          throw new Error("Task failure has no accepted start");
        failedAt = event.time;
        task = {
          id: current.id,
          subject: current.subject,
          kind: "recovery-required",
          startedAt,
          failedAt,
        };
        break;
      case "recovery-started":
      case "recovery-failed":
      case "recovery-completed":
        if (startedAt === null || failedAt === null)
          throw new Error("Recovery has no accepted failure");
        if (event.kind === "recovery-completed")
          task = {
            id: current.id,
            subject: current.subject,
            kind: "failed",
            startedAt,
            failedAt,
            resolvedAt: event.time,
          };
        else
          task = {
            id: current.id,
            subject: current.subject,
            kind:
              event.kind === "recovery-started"
                ? "recovering"
                : "recovery-failed",
            startedAt,
            failedAt,
          };
        break;
    }
  }
  // Cancellation is a consequence of accepted recovery and has its own stored time.
  if (current.kind === "cancelled" && current.cancelledAt <= at) return current;
  return task;
}

function storesAt(
  run: RunState,
  events: readonly AcceptedEvent[],
): readonly CarrierStoreView[] {
  const stores: CarrierStoreView[] = [];
  for (const definition of run.definition.scenario.storages) {
    if (definition.capacity.kind !== "carriers") continue;
    let occupants: readonly string[] = [];
    const initial: string[] = [];
    for (const carrier of run.definition.scenario.carriers)
      if (carrier.storage === definition.id) initial.push(carrier.id);
    occupants = initial;
    let reservations: CarrierStoreView["reservations"] = [];
    for (const event of events)
      if (event.kind === "storage-changed" && event.storage === definition.id) {
        occupants = event.occupants;
        reservations = event.reservations;
      }
    stores.push({
      id: definition.id,
      capacity: definition.capacity.slots,
      occupants,
      reservations,
    });
  }
  return stores;
}

function resourcesAt(
  run: RunState,
  events: readonly AcceptedEvent[],
): readonly ResourceView[] {
  const resources: ResourceView[] = [];
  for (const definition of run.definition.scenario.resources) {
    const claims = new Map<string, ResourceView["allocations"][number]>();
    const withheld = new Set<string>();
    const members = new Set<string>();
    let batch: ResourceView["batchPhase"] =
      definition.kind === "batch" ? "idle" : null;
    let position =
      definition.kind === "worker" ? definition.initialLocation : "Fixed";
    let assignment: Variant<AcceptedEvent, "worker-assigned"> | null = null;
    for (const event of events) {
      if (event.kind === "worker-assigned" && event.worker === definition.id) {
        assignment = event;
        position = `${event.from} → ${event.start} → ${event.finish}`;
      }
      if (!("resource" in event) || event.resource !== definition.id) continue;
      switch (event.kind) {
        case "resource-claimed":
          claims.set(event.task, {
            task: event.task,
            kind: event.allocation,
            units: event.units,
            since: event.time,
          });
          break;
        case "resource-released":
          claims.delete(event.task);
          if (assignment?.task === event.task) {
            position = assignment.finish;
            assignment = null;
          }
          break;
        case "availability-changed":
          if (event.available) withheld.delete(event.cause);
          else withheld.add(event.cause);
          break;
        case "batch-admitted":
          members.add(event.task);
          batch = "loading";
          break;
        case "batch-started":
          batch = "running";
          break;
        case "batch-completed":
          batch = "unloading";
          break;
        case "batch-cleared":
          batch = "idle";
          members.clear();
          break;
        case "batch-member-rejected":
          members.delete(event.task);
          if (members.size === 0) batch = "idle";
          break;
      }
    }
    resources.push({
      id: definition.id,
      kind: definition.kind,
      capacity: definition.capacity,
      available: withheld.size === 0,
      position,
      batchPhase: batch,
      allocations: [...claims.values()],
    });
  }
  return resources;
}
