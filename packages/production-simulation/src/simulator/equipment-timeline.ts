import type { StationId } from "@purin-labs/bakery-model/bakery";
import {
  outageAt,
  type OvenCycle,
  type Run,
} from "../recipes/bakery/schedule.ts";
import { assertNever } from "@purin-labs/std";
type EquipmentAllocation = Readonly<{
  batches: readonly string[];
  capacity: Readonly<{
    unit: "trays" | "batches";
    used: number;
    total: number;
  }>;
  cycle: OvenCycle | null;
  unavailable: boolean;
}>;

export type EquipmentSpan = Readonly<{
  start: number;
  end: number;
  allocation: EquipmentAllocation;
}>;

export function equipmentAt(
  run: Run,
  station: StationId,
  cursor: number,
): EquipmentAllocation {
  const time = Math.max(0, Math.min(cursor, run.end));
  const batches = new Set<string>();
  // Only accepted events release reservations, including at a truncated shift end.
  for (const event of run.taskEvents) {
    if (event.time > time) break;
    switch (event.kind) {
      case "started":
        if (event.task.station === station) batches.add(event.task.batch);
        break;
      case "picked-up":
        if (event.task.from === station) batches.delete(event.task.batch);
        break;
      case "completed":
        if (
          station === "pack" &&
          event.task.kind === "process" &&
          event.task.operation === "pack"
        ) {
          batches.delete(event.task.batch);
        }
        break;
      case "native-settled":
      case "native-awaiting":
      case "failed":
        break;
      default:
        assertNever(event);
    }
  }
  let cycle: OvenCycle | null = null;
  if (station === "bake") {
    for (const candidate of run.cycles) {
      if (candidate.start <= time && time < candidate.end) {
        cycle = candidate;
        break;
      }
    }
  }
  const usesTrays = station === "bake" || station === "cool";
  let capacity = 1;
  if (station === "bake") capacity = run.settings.ovenTrays;
  if (station === "cool") capacity = run.settings.rackTrays;
  return {
    batches: [...batches].sort(),
    capacity: {
      unit: usesTrays ? "trays" : "batches",
      used: usesTrays
        ? batches.size * run.settings.traysPerBatch
        : batches.size,
      total: capacity,
    },
    cycle,
    unavailable: station === "bake" && outageAt(run, time),
  };
}

export function equipmentTimeline(
  run: Run,
  station: StationId,
): readonly EquipmentSpan[] {
  const boundaries = new Set([0, run.end]);
  for (const event of run.taskEvents) boundaries.add(event.time);
  if (station === "bake") {
    for (const cycle of run.cycles) {
      boundaries.add(cycle.start);
      boundaries.add(Math.min(run.end, cycle.end));
    }
    if (run.variant === "outage") {
      boundaries.add(Math.min(run.end, run.settings.outageStart * 60));
      boundaries.add(Math.min(run.end, run.settings.outageEnd * 60));
    }
  }
  const times = [...boundaries].sort(compareTime);
  const spans: EquipmentSpan[] = [];
  for (const [index, start] of times.entries()) {
    const end = times[index + 1];
    if (end === undefined) break;
    const allocation = equipmentAt(run, station, start);
    const previous = spans.at(-1);
    if (previous && sameAllocation(previous.allocation, allocation)) {
      spans[spans.length - 1] = { start: previous.start, end, allocation };
    } else {
      spans.push({ start, end, allocation });
    }
  }
  return spans;
}

export function equipmentSummary(allocation: EquipmentAllocation): string {
  const { capacity, batches, cycle, unavailable } = allocation;
  const parts = [
    `${capacity.used}/${capacity.total} ${capacity.unit} reserved`,
  ];
  if (batches.length > 0) parts.push(`Batches ${batches.join(", ")}`);
  if (cycle !== null) parts.push(`Bake cycle ${cycle.id}`);
  if (unavailable) parts.push("Unavailable for new work");
  if (unavailable && cycle !== null) parts.push("Existing bake continues");
  return parts.join(" · ");
}

function compareTime(left: number, right: number): number {
  return left - right;
}

function sameAllocation(
  left: EquipmentAllocation,
  right: EquipmentAllocation,
): boolean {
  if (left.cycle !== right.cycle || left.unavailable !== right.unavailable)
    return false;
  if (left.batches.length !== right.batches.length) return false;
  for (let index = 0; index < left.batches.length; index++) {
    if (left.batches[index] !== right.batches[index]) return false;
  }
  return true;
}
