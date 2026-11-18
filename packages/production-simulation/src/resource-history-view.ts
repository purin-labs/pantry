import { isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import * as d from "./document-values.ts";
import type { ResourceInterval, ResourceUsage } from "./results.ts";

export type ResourceHistoryView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      version: 1;
      after: number;
      through: number;
      resources: readonly ResourceUsage[];
    }>
>;

function readInterval(raw: unknown): ResourceInterval {
  d.requireValue(isRecord(raw));
  const start = d.natural(raw.start);
  const end = d.natural(raw.end);
  d.requireValue(end > start);
  return {
    task: d.id("task", raw.task),
    kind: d.choice(
      raw.kind,
      "reserved",
      "occupied",
      "held",
      "travel",
      "handling",
      "changeover",
    ),
    units: d.positive(raw.units),
    start,
    end,
    ongoing: d.boolean(raw.ongoing),
  };
}

function seconds(raw: unknown): number {
  d.requireValue(typeof raw === "number" && Number.isFinite(raw) && raw >= 0);
  return raw;
}

function readUsage(raw: unknown): ResourceUsage {
  d.requireValue(isRecord(raw));
  const claimedShare = d.nullable(raw.claimedShare, seconds);
  d.requireValue(claimedShare === null || claimedShare <= 1 + Number.EPSILON);
  return {
    resource: d.id("resource", raw.resource),
    capacity: d.positive(raw.capacity),
    capacityUnitSeconds: seconds(raw.capacityUnitSeconds),
    occupiedUnitSeconds: seconds(raw.occupiedUnitSeconds),
    reservedUnitSeconds: seconds(raw.reservedUnitSeconds),
    heldUnitSeconds: seconds(raw.heldUnitSeconds),
    unallocatedUnitSeconds: seconds(raw.unallocatedUnitSeconds),
    withheldUnitSeconds: seconds(raw.withheldUnitSeconds),
    travelUnitSeconds: seconds(raw.travelUnitSeconds),
    handlingUnitSeconds: seconds(raw.handlingUnitSeconds),
    changeoverUnitSeconds: seconds(raw.changeoverUnitSeconds),
    claimedShare,
    intervals: d.array(raw.intervals, readInterval),
  };
}

/** Older bundles have no claim history. Absence never means zero resource use. */
export function readResourceHistory(raw: unknown): ResourceHistoryView {
  if (raw === undefined) return { kind: "unavailable" };
  d.requireValue(isRecord(raw));
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  d.requireValue(raw.kind === "available" && raw.version === 1);
  const after = d.natural(raw.after);
  const through = d.natural(raw.through);
  d.requireValue(through >= after);
  const resources = d.array(raw.resources, readUsage);
  for (const resource of resources)
    for (const span of resource.intervals)
      d.requireValue(span.start >= after && span.end <= through);
  return { kind: "available", version: 1, after, through, resources };
}
