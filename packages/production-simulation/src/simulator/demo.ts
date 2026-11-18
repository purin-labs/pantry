import {
  parseSettings,
  sampleSettings,
  type StationId,
} from "@seams/bakery-model/bakery";
import {
  machineAt,
  simulate,
  type Interval,
  type Run,
  type ScheduleSpatialLayout,
  type ScheduleVariant,
  type Wait,
} from "../recipes/bakery/schedule.ts";
import { assertNever } from "@seams/std";
export function machineSummary(run: Run, id: StationId, time: number): string {
  const status = machineAt(run, id, time);
  const batches = status.occupants.length
    ? `Batches ${status.occupants.join(", ")}`
    : "No batches";
  const lines = [`${status.state} · queue ${status.queue.length}`, batches];
  if (id === "bake") {
    let trays = 0;
    for (const batch of run.batches) {
      if (status.occupants.includes(batch.id)) {
        trays += batch.trays;
      }
    }
    lines.push(`${trays}/${run.settings.ovenTrays} trays reserved`);
    for (const cycle of run.cycles) {
      if (cycle.start <= time && time < cycle.end) {
        lines.push(`Baking · ${duration(cycle.end - time)} remaining`);
        break;
      }
    }
  }
  return lines.join("\n");
}

/** Only what departs from a quiet station, or null when nothing does. */
export function machineAttention(
  run: Run,
  id: StationId,
  time: number,
): string | null {
  const status = machineAt(run, id, time);
  const parts: string[] = [];
  if (status.state === "fault") parts.push("Fault");
  if (status.queue.length > 0) parts.push(`${status.queue.length} queued`);
  if (id === "bake") {
    for (const cycle of run.cycles) {
      if (cycle.start <= time && time < cycle.end) {
        parts.push(`${duration(cycle.end - time)} left`);
        break;
      }
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function duration(seconds: number): string {
  const rounded = Math.round(Math.abs(seconds));
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

export function finishDifference(
  baseline: number | null,
  current: number | null,
): string {
  if (baseline === null || current === null) {
    return "Finish unavailable";
  }
  return current === baseline
    ? "Same finish"
    : `${duration(current - baseline)} ${current < baseline ? "earlier" : "later"}`;
}

export function batchTimeline(run: Run, batch: string): Interval[] {
  const result: Interval[] = [];
  for (const item of run.intervals) {
    if (item.batch !== batch) {
      continue;
    }
    const previous = result[result.length - 1];
    if (
      previous?.kind === "wait" &&
      item.kind === "wait" &&
      previous.end === item.start &&
      previous.station === item.station &&
      previous.location === item.location &&
      previous.reason === item.reason &&
      previous.label === item.label
    ) {
      result[result.length - 1] = {
        kind: "wait",
        batch,
        station: item.station,
        location: item.location,
        reason: item.reason,
        label: item.label,
        start: previous.start,
        end: item.end,
      };
    } else {
      result.push(item);
    }
  }
  return result;
}

export type DemoPreset = "morning" | "one-worker" | "breakdown";

export function demoPreset(
  preset: DemoPreset,
  layout: ScheduleSpatialLayout | null,
): {
  normal: Run;
  outage: Run;
  variant: ScheduleVariant;
} {
  const result = parseSettings({
    ...sampleSettings(),
    workerCount: preset === "one-worker" ? 1 : sampleSettings().workerCount,
  });
  if (result.kind === "invalid") {
    throw new Error(result.message);
  }
  return {
    normal: simulate(result.settings, "normal", layout),
    outage: simulate(result.settings, "outage", layout),
    variant: preset === "breakdown" ? "outage" : "normal",
  };
}

export function largestWait(run: Run): string {
  const totals = new Map<Wait["reason"], number>();
  for (const interval of run.intervals) {
    if (interval.kind !== "wait") {
      continue;
    }
    const elapsed = Math.min(interval.end, run.end) - interval.start;
    const previous = totals.get(interval.reason) ?? 0;
    totals.set(interval.reason, previous + elapsed);
  }
  let reason: Wait["reason"] | null = null;
  let seconds = 0;
  for (const [candidate, total] of totals) {
    if (total > seconds) {
      reason = candidate;
      seconds = total;
    }
  }
  return reason === null
    ? "No waiting"
    : `${waitLabel(reason)} · ${Math.round(seconds / 60)} batch-min`;
}

function waitLabel(reason: Wait["reason"]): string {
  switch (reason) {
    case "worker":
      return "Workers busy";
    case "station":
      return "Station capacity";
    case "dependency":
      return "Task dependency";
    case "start":
      return "Earliest start";
    case "cycle":
      return "Oven cycle";
    case "outage":
      return "Oven outage";
    default:
      return assertNever(reason);
  }
}
