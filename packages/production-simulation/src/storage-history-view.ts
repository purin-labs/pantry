import { isRecord } from "@purin-labs/std";
import * as d from "./document-values.ts";
import type { StorageId } from "./identity.ts";
import { readStorageContents } from "./storage-document.ts";
import type {
  StorageHistoryView,
  StorageInterval,
  StorageUsage,
} from "./storage-history.ts";

function seconds(raw: unknown): number {
  d.requireValue(typeof raw === "number" && Number.isFinite(raw) && raw >= 0);
  return raw;
}

function readInterval(raw: unknown): StorageInterval {
  d.requireValue(isRecord(raw));
  const start = d.natural(raw.start);
  const end = d.natural(raw.end);
  d.requireValue(end > start);
  const contents = readStorageContents(raw);
  return {
    start,
    end,
    ongoing: d.boolean(raw.ongoing),
    occupants: contents.occupants,
    reservations: contents.reservations,
  };
}

function readUsage(raw: unknown): StorageUsage {
  d.requireValue(isRecord(raw));
  const slots = d.positive(raw.slots);
  const intervals = d.array(raw.intervals, readInterval);
  for (const span of intervals)
    d.requireValue(span.occupants.length + span.reservations.length <= slots);
  const peakOccupiedSlots = d.natural(raw.peakOccupiedSlots);
  const peakReservedSlots = d.natural(raw.peakReservedSlots);
  const peakCommittedSlots = d.natural(raw.peakCommittedSlots);
  d.requireValue(
    peakCommittedSlots <= slots &&
      peakOccupiedSlots <= peakCommittedSlots &&
      peakReservedSlots <= peakCommittedSlots,
  );
  return {
    storage: d.id("storage", raw.storage),
    slots,
    occupiedSlotSeconds: seconds(raw.occupiedSlotSeconds),
    reservedSlotSeconds: seconds(raw.reservedSlotSeconds),
    freeSlotSeconds: seconds(raw.freeSlotSeconds),
    peakOccupiedSlots,
    peakReservedSlots,
    peakCommittedSlots,
    fullSeconds: seconds(raw.fullSeconds),
    intervals,
  };
}

/** Older retained builds have no storage history. Absence never means zero use. */
export function readStorageHistory(raw: unknown): StorageHistoryView {
  if (raw === undefined) return { kind: "unavailable" };
  d.requireValue(isRecord(raw));
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  d.requireValue(raw.kind === "available" && raw.version === 1);
  const after = d.natural(raw.after);
  const through = d.natural(raw.through);
  d.requireValue(through >= after);
  const storages = d.array(raw.storages, readUsage);
  const identities = new Set<StorageId>();
  for (const storage of storages) {
    d.requireValue(!identities.has(storage.storage));
    identities.add(storage.storage);
    let cursor = after;
    for (const span of storage.intervals) {
      d.requireValue(span.start === cursor && span.end <= through);
      d.requireValue(!span.ongoing || span.end === through);
      cursor = span.end;
    }
    d.requireValue(cursor === through);
    d.requireValue(storage.fullSeconds <= (through - after) / 1_000_000);
  }
  return { kind: "available", version: 1, after, through, storages };
}
