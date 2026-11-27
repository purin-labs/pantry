import type { Operation, StationId } from "@purin-labs/bakery-model/bakery";
import {
  batchAt,
  type Batch,
  type HumanId,
  type HumanResource,
  type Interval,
  type Process,
  type Run,
  type BakeryTask,
  type BakeryTaskId,
} from "../recipes/bakery/schedule.ts";
import type {
  WorkcellTaskId,
  WorkcellResourceId,
} from "../recipes/bakery/workcell-input.ts";
import { assertNever } from "@purin-labs/std";

export type Selection =
  | Readonly<{ kind: "batch"; id: string }>
  | Readonly<{ kind: "station"; id: StationId }>
  | Readonly<{ kind: "task"; id: BakeryTaskId }>
  | Readonly<{ kind: "resource"; id: HumanId }>;

export type WorkcellSelection =
  | Readonly<{ kind: "task"; id: WorkcellTaskId }>
  | Readonly<{ kind: "resource"; id: WorkcellResourceId }>;

function taskById(run: Run, id: BakeryTaskId): BakeryTask | null {
  for (const interval of run.intervals) {
    if (interval.kind !== "wait" && interval.id === id) return interval;
  }
  return null;
}

export function selectionExists(run: Run, selection: Selection): boolean {
  switch (selection.kind) {
    case "batch":
      return run.batches.some(hasId.bind(null, selection.id));
    case "station":
      return true;
    case "task":
      return taskById(run, selection.id) !== null;
    case "resource":
      return run.resources.some(hasId.bind(null, selection.id));
    default:
      return assertNever(selection);
  }
}

export function selectionForRun(run: Run, selection: Selection): Selection {
  if (selectionExists(run, selection)) return selection;
  const first = run.batches[0];
  if (first === undefined)
    throw new Error("A workflow run must contain a batch.");
  return { kind: "batch", id: first.id };
}

export function selectionForInterval(interval: Interval): Selection {
  if (interval.kind === "wait") return { kind: "batch", id: interval.batch };
  return { kind: "task", id: interval.id };
}

export function intervalSelected(
  selection: Selection,
  interval: Interval,
): boolean {
  switch (selection.kind) {
    case "batch":
      return interval.batch === selection.id;
    case "station":
      return interval.station === selection.id;
    case "task":
      return interval.kind !== "wait" && interval.id === selection.id;
    case "resource":
      return (
        interval.kind !== "wait" &&
        interval.attended &&
        interval.executor === selection.id
      );
    default:
      return assertNever(selection);
  }
}

export function selectionContext(
  run: Run,
  selection: Selection,
  time: number,
): Readonly<{
  batch: Batch | null;
  task: BakeryTask | null;
  resource: HumanResource | null;
}> {
  let batch: Batch | null = null;
  let task: BakeryTask | null = null;
  let resource: HumanResource | null = null;
  switch (selection.kind) {
    case "station":
      break;
    case "batch": {
      batch = run.batches.find(hasId.bind(null, selection.id)) ?? null;
      const current = batch === null ? null : batchAt(run, batch, time);
      if (
        current?.kind === "process" ||
        current?.kind === "transfer" ||
        current?.kind === "handoff" ||
        current?.kind === "native"
      )
        task = current;
      break;
    }
    case "task":
      task = taskById(run, selection.id);
      break;
    case "resource":
      resource = run.resources.find(hasId.bind(null, selection.id)) ?? null;
      for (const interval of run.intervals) {
        if (
          interval.kind !== "wait" &&
          interval.attended &&
          interval.executor === selection.id &&
          interval.start <= time &&
          time < interval.end
        ) {
          task = interval;
          break;
        }
      }
      break;
    default:
      return assertNever(selection);
  }
  if (task !== null) {
    batch = run.batches.find(hasId.bind(null, task.batch)) ?? null;
    if (task.attended)
      resource = run.resources.find(hasId.bind(null, task.executor)) ?? null;
  }
  return { batch, task, resource };
}

export function operationTask(
  run: Run,
  selection: Selection,
  time: number,
  operation: Operation,
): Process | null {
  const batch = selectionContext(run, selection, time).batch ?? run.batches[0];
  if (batch === undefined) return null;
  for (const interval of run.intervals) {
    if (
      interval.kind === "process" &&
      interval.batch === batch.id &&
      interval.operation === operation
    )
      return interval;
  }
  return null;
}

export function operationWait(
  run: Run,
  selection: Selection,
  time: number,
  operation: Operation,
): string | null {
  const batch = selectionContext(run, selection, time).batch ?? run.batches[0];
  if (batch === undefined) return null;
  const task = operationTask(run, selection, time, operation);
  if (task !== null && task.start <= time) return null;
  const station =
    operation === "demould" || operation === "finishCooling"
      ? "cool"
      : operation;
  for (const wait of run.unresolvedWaits) {
    if (
      wait.batch === batch.id &&
      wait.station === station &&
      time >= wait.time
    )
      return wait.label;
  }
  for (const interval of run.intervals) {
    if (
      interval.kind === "wait" &&
      interval.batch === batch.id &&
      interval.station === station &&
      interval.start <= time &&
      time < interval.end
    )
      return interval.label;
  }
  return null;
}

function hasId(id: string, item: Readonly<{ id: string }>): boolean {
  return item.id === id;
}
