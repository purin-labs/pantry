import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import type { StationId } from "@purin-labs/bakery-model/bakery";
import type { ProductionWorkcell } from "./production-workcells.ts";
import { assertNever } from "@purin-labs/std";
import { along, station, stationLabel, type Point } from "./schedule-layout.ts";
import type {
  BakeryTask,
  Batch,
  HumanId,
  HumanResource,
  Interval,
  Run,
  TaskSnapshot,
} from "./schedule-types.ts";

export function outageAt(
  run: Pick<Run, "variant" | "settings">,
  time: number,
): boolean {
  return (
    run.variant === "outage" &&
    time >= run.settings.outageStart * 60 &&
    time < run.settings.outageEnd * 60
  );
}

export function humanResource(run: Run, id: HumanId): HumanResource {
  for (const resource of run.resources) {
    if (resource.id === id) return resource;
  }
  throw new Error(`Missing human resource ${id}`);
}

export function taskAt(run: Run, task: BakeryTask, time: number): TaskSnapshot {
  let snapshot: TaskSnapshot = { kind: "queued", task };
  for (const event of run.taskEvents) {
    if (event.time > time) break;
    if (event.kind === "native-awaiting") continue;
    if (event.task.id !== task.id) continue;
    switch (event.kind) {
      case "started":
        snapshot = { kind: "running", task };
        break;
      case "picked-up":
        break;
      case "completed":
        snapshot = {
          kind: "completed",
          task: event.task,
          evidence: event.evidence,
        };
        break;
      case "failed":
        snapshot = {
          kind: "failed",
          task: event.task,
          evidence: event.evidence,
        };
        break;
      case "native-settled":
        snapshot =
          event.task.outcome === "completed"
            ? {
                kind: "completed",
                task: event.task,
                evidence: {
                  source: "native-recording",
                  recording: event.task.recording,
                },
              }
            : { kind: "recovery-required", task: event.task };
        break;
      default:
        assertNever(event, "Unexpected simulator state");
    }
  }
  return snapshot;
}

export function workerTasks(run: Run, id: HumanId): readonly BakeryTask[] {
  const tasks: BakeryTask[] = [];
  for (const interval of run.intervals) {
    if (
      interval.kind !== "wait" &&
      interval.attended &&
      interval.executor === id
    ) {
      tasks.push(interval);
    }
  }
  return tasks;
}

export type BatchSnapshot =
  | Interval
  | { readonly kind: "complete"; readonly time: number }
  | { readonly kind: "unreleased" }
  | { readonly kind: "unfinished" };

export function batchAt(run: Run, batch: Batch, time: number): BatchSnapshot {
  for (const task of run.intervals) {
    if (task.batch === batch.id && task.start <= time && time < task.end) {
      return task;
    }
  }
  for (const item of run.completions) {
    if (item.batch === batch.id && time >= item.time) {
      return { kind: "complete", time: item.time };
    }
  }
  for (const hold of run.nativeHolds) {
    if (hold.operation.batchId !== batch.id || time < hold.start) continue;
    return {
      kind: "wait",
      batch: batch.id,
      station: "cool",
      location: "cool",
      start: hold.start,
      end: run.end,
      reason: "station",
      label:
        hold.kind === "failed"
          ? failureLabel("Native failure", hold.recoveredAt, time)
          : "Robot reserved; awaiting matching evidence",
    };
  }
  for (const failure of run.handlingFailures) {
    if (failure.task.batch !== batch.id || time < failure.failedAt) continue;
    return {
      kind: "wait",
      batch: batch.id,
      station: failure.task.station,
      location: failure.task.station,
      start: failure.failedAt,
      end: run.end,
      reason: "station",
      label: failureLabel(
        failure.task.phase === "transfer"
          ? "Human transfer failed; location uncertain"
          : failure.task.phase === "stage"
            ? "Staging failed"
            : "Clearance failed",
        failure.recoveredAt,
        time,
      ),
    };
  }
  return time < batch.release ? { kind: "unreleased" } : { kind: "unfinished" };
}

function failureLabel(
  failure: string,
  recoveredAt: number | null,
  time: number,
): string {
  if (recoveredAt === null) return `${failure}; cell and tray held`;
  return time < recoveredAt
    ? `${failure}; recovery assumed until ${clock(recoveredAt)}`
    : `${failure}; recovery released the cell`;
}

// Names the skill a native task runs; continuations resume the tray in the cell.
function nativeDescription(operation: ProductionWorkcell): string {
  const input = operation.attempt.input;
  const tray = `tray ${operation.tray}`;
  const robot = ROBOTS[input.request.robot].label;
  switch (input.kind) {
    case "transfer":
      return input.request.bakeryTaskId === "table-to-oven"
        ? `${robot} · load ${tray} into the oven`
        : `${robot} · ${tray} to rack`;
    case "native-cycle":
      return `${robot} · ${tray} oven cycle`;
    case "oven-cycle":
      return operation.start.kind === "reset"
        ? `${robot} · ${tray} oven cycle`
        : `${robot} · retrieve ${tray} from the oven`;
    case "rack-cycle":
      return operation.start.kind === "reset"
        ? `${robot} · ${tray} oven, table and rack`
        : `${robot} · rack ${tray}`;
  }
}

export function describe(snapshot: BatchSnapshot): string {
  switch (snapshot.kind) {
    case "process":
      switch (snapshot.operation) {
        case "cool":
          return "Cooling in moulds";
        case "demould":
          return "Demoulding";
        case "finishCooling":
          return "Cooling before packing";
        default:
          return stationLabel(snapshot.station);
      }
    case "transfer":
      return `Move from ${stationLabel(snapshot.from)} to ${stationLabel(snapshot.station)}`;
    case "handoff":
      if (snapshot.phase === "transfer")
        return "Human transfer: cell 1 rack → buffer → cell 2 source (assumed)";
      return snapshot.phase === "stage"
        ? "Stage cold proxy in Robot cell"
        : "Clear Robot cell to holding area";
    case "native":
      return nativeDescription(snapshot.operation);
    case "wait":
      return snapshot.label;
    case "complete":
      return "Packed";
    case "unreleased":
      return "Not released";
    case "unfinished":
      return "Unfinished at shift end";
    default:
      return assertNever(snapshot, "Unexpected simulator state");
  }
}

export type MachineState = "idle" | "running" | "ready" | "fault";

export function machineAt(
  run: Run,
  id: StationId,
  time: number,
): {
  state: MachineState;
  queue: readonly string[];
  occupants: readonly string[];
} {
  const queue: string[] = [];
  const occupants: string[] = [];
  let state: MachineState =
    id === "bake" && outageAt(run, time) ? "fault" : "idle";
  for (const batch of run.batches) {
    const current = batchAt(run, batch, time);
    if (current.kind === "wait" && current.station === id) {
      queue.push(batch.id);
    }
    if (
      (current.kind === "process" ||
        current.kind === "handoff" ||
        current.kind === "native") &&
      current.station === id
    ) {
      occupants.push(batch.id);
      if (current.kind === "native" || time >= current.arrival) {
        state = "running";
      }
    }
    if (current.kind === "wait" && current.location === id) {
      occupants.push(batch.id);
      if (state === "idle") {
        state = "ready";
      }
    }
    if (
      current.kind === "transfer" &&
      ((current.from === id && time < current.pickup) || current.station === id)
    ) {
      occupants.push(batch.id);
    }
  }
  return { state, queue, occupants };
}

export function doorAt(
  run: Run,
  id: StationId,
  time: number,
  reduced: boolean,
): number {
  let open = 0;
  for (const task of run.intervals) {
    if (task.kind !== "transfer") {
      continue;
    }
    if (task.from !== id && task.station !== id) {
      continue;
    }
    const start = task.from === id ? task.pickupStart : task.loadedEnd;
    const end = task.from === id ? task.pickup : task.end;
    if (time < start || time >= end) {
      continue;
    }
    open = Math.max(
      open,
      reduced ? 1 : Math.min(1, (time - start) / 0.75, (end - time) / 0.75),
    );
  }
  return open;
}

export function workerAt(
  run: Run,
  resource: HumanResource,
  time: number,
  reduced: boolean,
): Point {
  let point: Point = resource.start;
  for (const task of run.intervals) {
    if (
      task.kind === "wait" ||
      !task.attended ||
      task.executor !== resource.id ||
      task.start > time
    ) {
      continue;
    }
    if (task.end <= time) {
      point = station(task.station, run.layout).handoff;
      continue;
    }
    if (reduced) {
      return task.kind === "transfer" && time < task.pickup
        ? station(task.from, run.layout).handoff
        : station(task.station, run.layout).handoff;
    }
    if (task.kind === "transfer") {
      return time < task.pickup
        ? along(
            task.emptyRoute,
            (time - task.start) / Math.max(1, task.pickupStart - task.start),
          )
        : along(
            task.route,
            (time - task.pickup) / Math.max(1, task.loadedEnd - task.pickup),
          );
    }
    return time < task.arrival
      ? along(
          task.emptyRoute,
          (time - task.start) / (task.arrival - task.start),
        )
      : station(task.station, run.layout).handoff;
  }
  return point;
}

export function metrics(run: Run): {
  late: number;
  waiting: number;
  unfinished: number;
} {
  let late = 0;
  let waiting = 0;
  for (const batch of run.batches) {
    for (const item of run.completions) {
      if (item.batch === batch.id && item.time > batch.deadline) {
        late++;
      }
    }
  }
  for (const task of run.intervals) {
    if (task.kind === "wait") {
      waiting += task.end - task.start;
    }
  }
  return {
    late,
    waiting,
    unfinished: run.kind === "complete" ? 0 : run.unfinished.length,
  };
}

export function workName(run: Pick<Run, "unit">, batchId: string): string {
  return `${run.unit === "tray" ? "Tray" : "Batch"} ${batchId}`;
}

export function clock(seconds: number): string {
  const value = Math.floor(seconds);
  return `${String(6 + Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
