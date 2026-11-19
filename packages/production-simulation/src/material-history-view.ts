import { isRecord } from "@purin-labs/std";
import * as d from "./document-values.ts";
import type {
  MaterialStorageContents,
  MaterialStorageHistoryView,
  MaterialStorageInterval,
  MaterialStorageUsage,
} from "./material-history.ts";
import type { StorageId, TaskId } from "./identity.ts";

function finiteAmount(raw: unknown): number {
  d.requireValue(typeof raw === "number" && Number.isFinite(raw) && raw >= 0);
  return raw;
}
function reservation(
  raw: unknown,
): MaterialStorageContents["reservations"][number] {
  d.requireValue(isRecord(raw));
  return { task: d.id("task", raw.task), quantity: d.positive(raw.quantity) };
}
function contents(raw: unknown): MaterialStorageContents {
  d.requireValue(isRecord(raw));
  const occupied = d.natural(raw.occupied);
  const held = d.natural(raw.held);
  d.requireValue(held <= occupied);
  const reservations = d.array(raw.reservations, reservation);
  const tasks = new Set<TaskId>();
  for (const item of reservations) {
    d.requireValue(!tasks.has(item.task));
    tasks.add(item.task);
  }
  return { occupied, held, reservations };
}
function readInterval(raw: unknown): MaterialStorageInterval {
  d.requireValue(isRecord(raw));
  const start = d.time(raw.start);
  const end = d.time(raw.end);
  d.requireValue(end > start);
  const state = contents(raw);
  return {
    start,
    end,
    ongoing: d.boolean(raw.ongoing),
    occupied: state.occupied,
    held: state.held,
    reservations: state.reservations,
  };
}
function committed(state: MaterialStorageContents): number {
  let total = state.occupied;
  for (const item of state.reservations) total += item.quantity;
  return total;
}
function readStore(raw: unknown): MaterialStorageUsage {
  d.requireValue(isRecord(raw));
  const capacity = d.positive(raw.capacity);
  const current = contents(raw.current);
  const intervals = d.array(raw.intervals, readInterval);
  const peakCommitted = d.natural(raw.peakCommitted);
  d.requireValue(committed(current) <= capacity && peakCommitted <= capacity);
  for (const interval of intervals)
    d.requireValue(committed(interval) <= capacity);
  return {
    storage: d.id("storage", raw.storage),
    product: d.id("product", raw.product),
    unit: d.choice(raw.unit, "each", "milligram", "microliter"),
    capacity,
    current,
    occupiedQuantitySeconds: finiteAmount(raw.occupiedQuantitySeconds),
    reservedQuantitySeconds: finiteAmount(raw.reservedQuantitySeconds),
    freeQuantitySeconds: finiteAmount(raw.freeQuantitySeconds),
    fullSeconds: finiteAmount(raw.fullSeconds),
    peakCommitted,
    intervals,
  };
}

/** Retained response boundary: earlier builds do not expose this projection. */
export function readMaterialStorageHistory(
  raw: unknown,
): MaterialStorageHistoryView {
  if (raw === undefined) return { kind: "unavailable" };
  d.requireValue(isRecord(raw));
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  d.requireValue(raw.kind === "available" && raw.version === 1);
  const after = d.time(raw.after);
  const through = d.time(raw.through);
  d.requireValue(through >= after);
  const storages = d.array(raw.storages, readStore);
  const identities = new Set<StorageId>();
  for (const storage of storages) {
    d.requireValue(!identities.has(storage.storage));
    identities.add(storage.storage);
    let cursor: number = after;
    for (const interval of storage.intervals) {
      d.requireValue(interval.start === cursor && interval.end <= through);
      d.requireValue(!interval.ongoing || interval.end === through);
      cursor = interval.end;
    }
    d.requireValue(
      cursor === through &&
        storage.fullSeconds <= (through - after) / 1_000_000,
    );
  }
  return { kind: "available", version: 1, after, through, storages };
}
