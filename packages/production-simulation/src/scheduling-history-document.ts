import { isRecord } from "@purin-labs/std";
import * as d from "./document-values.ts";
import { readBlocker } from "./blocker-document.ts";
import {
  CAPACITY_CATEGORIES,
  type CapacityCategories,
  type CapacityInterval,
  type ResourceCategories,
  type SchedulingHistoryView,
  type TaskWait,
  type WaitInterval,
} from "./scheduling-history.ts";

export function readTaskWait(raw: unknown): TaskWait {
  const r = d.record(raw, ["task", "blockers"]);
  return {
    task: d.id("task", r.task),
    blockers: d.array(r.blockers, readBlocker),
  };
}

function seconds(raw: unknown): number {
  d.requireValue(typeof raw === "number" && Number.isFinite(raw) && raw >= 0);
  return raw;
}

function readCategories(raw: unknown): CapacityCategories {
  const r = d.record(raw, CAPACITY_CATEGORIES);
  return {
    running: seconds(r.running),
    reserved: seconds(r.reserved),
    unavailable: seconds(r.unavailable),
    loading: seconds(r.loading),
    unloading: seconds(r.unloading),
    blocked: seconds(r.blocked),
    starved: seconds(r.starved),
    idle: seconds(r.idle),
  };
}

function readSpan(raw: unknown): Readonly<{ start: number; end: number }> {
  d.requireValue(isRecord(raw));
  const start = d.natural(raw.start);
  const end = d.natural(raw.end);
  d.requireValue(end > start);
  return { start, end };
}
function readCapacityInterval(raw: unknown): CapacityInterval {
  d.requireValue(isRecord(raw));
  const span = readSpan(raw);
  const units = readCategories(raw.units);
  for (const kind of CAPACITY_CATEGORIES) d.natural(units[kind]);
  return { start: span.start, end: span.end, units };
}
function readWaitInterval(raw: unknown): WaitInterval {
  d.requireValue(isRecord(raw));
  const span = readSpan(raw);
  return {
    start: span.start,
    end: span.end,
    task: d.id("task", raw.task),
    blockers: d.array(raw.blockers, readBlocker),
  };
}
function readResource(raw: unknown): ResourceCategories {
  d.requireValue(isRecord(raw));
  return {
    resource: d.id("resource", raw.resource),
    capacity: d.positive(raw.capacity),
    unitSeconds: readCategories(raw.unitSeconds),
    intervals: d.array(raw.intervals, readCapacityInterval),
  };
}

/** Older retained hosts omit this observation. Decode that absence only here. */
export function readSchedulingHistory(raw: unknown): SchedulingHistoryView {
  if (raw === undefined) return { kind: "unavailable" };
  d.requireValue(isRecord(raw));
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  d.requireValue(raw.kind === "available" && raw.version === 1);
  const after = d.natural(raw.after);
  const through = d.natural(raw.through);
  d.requireValue(through >= after);
  const resources = d.array(raw.resources, readResource);
  const identities = new Set<string>();
  for (const resource of resources) {
    d.requireValue(!identities.has(resource.resource));
    identities.add(resource.resource);
    let cursor = after;
    for (const span of resource.intervals) {
      d.requireValue(span.start === cursor && span.end <= through);
      let count = 0;
      for (const kind of CAPACITY_CATEGORIES) count += span.units[kind];
      d.requireValue(count === resource.capacity);
      cursor = span.end;
    }
    d.requireValue(cursor === through);
    for (const kind of CAPACITY_CATEGORIES) {
      let duration = 0;
      for (const span of resource.intervals)
        duration += (span.end - span.start) * span.units[kind];
      d.requireValue(duration / 1_000_000 === resource.unitSeconds[kind]);
    }
  }
  const waits = d.array(raw.waits, readWaitInterval);
  for (const wait of waits)
    d.requireValue(wait.start >= after && wait.end <= through);
  return { kind: "available", version: 1, after, through, resources, waits };
}
