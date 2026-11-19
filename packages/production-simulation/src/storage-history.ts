import type { StrictUnion } from "@purin-labs/type-utils";
import type { StorageId } from "./identity.ts";
import type { ReportingInterval } from "./results.ts";
import type { RunState } from "./state.ts";
import type { StorageContents } from "./storage-document.ts";

export type StorageInterval = StorageContents &
  Readonly<{ start: number; end: number; ongoing: boolean }>;

/** Occupancy and admission reservations use slot-seconds. */
export type StorageUsage = Readonly<{
  storage: StorageId;
  slots: number;
  occupiedSlotSeconds: number;
  reservedSlotSeconds: number;
  freeSlotSeconds: number;
  peakOccupiedSlots: number;
  peakReservedSlots: number;
  peakCommittedSlots: number;
  fullSeconds: number;
  intervals: readonly StorageInterval[];
}>;

export type StorageHistoryView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      version: 1;
      after: number;
      through: number;
      storages: readonly StorageUsage[];
    }>
>;

type StorageLedger = {
  readonly storage: StorageId;
  readonly slots: number;
  readonly intervals: StorageInterval[];
  current: Readonly<{ start: number; contents: StorageContents }> | null;
};

function appendInterval(
  ledger: StorageLedger,
  after: number,
  through: number,
  end: number,
  ongoing: boolean,
): void {
  const current = ledger.current;
  if (current === null) return;
  const start = Math.max(after, current.start);
  const clippedEnd = Math.min(through, end);
  if (clippedEnd <= start) return;
  ledger.intervals.push({
    start,
    end: clippedEnd,
    ongoing,
    occupants: current.contents.occupants,
    reservations: current.contents.reservations,
  });
}

function summarize(ledger: StorageLedger, duration: number): StorageUsage {
  let occupied = 0;
  let reserved = 0;
  let peakOccupied = 0;
  let peakReserved = 0;
  let peakCommitted = 0;
  let fullDuration = 0;
  for (const span of ledger.intervals) {
    const duration = span.end - span.start;
    const committed = span.occupants.length + span.reservations.length;
    occupied += span.occupants.length * duration;
    reserved += span.reservations.length * duration;
    peakOccupied = Math.max(peakOccupied, span.occupants.length);
    peakReserved = Math.max(peakReserved, span.reservations.length);
    peakCommitted = Math.max(peakCommitted, committed);
    if (committed === ledger.slots) fullDuration += duration;
  }
  return {
    storage: ledger.storage,
    slots: ledger.slots,
    occupiedSlotSeconds: occupied / 1_000_000,
    reservedSlotSeconds: reserved / 1_000_000,
    freeSlotSeconds:
      Math.max(0, ledger.slots * duration - occupied - reserved) / 1_000_000,
    peakOccupiedSlots: peakOccupied,
    peakReservedSlots: peakReserved,
    peakCommittedSlots: peakCommitted,
    fullSeconds: fullDuration / 1_000_000,
    intervals: ledger.intervals,
  };
}

/** Integrate accepted carrier-store snapshots. Material stores are separate. */
export function storageHistory(
  run: RunState,
  interval: ReportingInterval,
): StorageHistoryView {
  const after = interval.after ?? 0;
  const through = interval.through;
  if (after > through || through > run.position.time)
    throw new RangeError(
      "Storage history requires a committed reporting interval",
    );
  const ledgers = new Map<StorageId, StorageLedger>();
  for (const definition of run.definition.scenario.storages) {
    if (definition.capacity.kind !== "carriers") continue;
    ledgers.set(definition.id, {
      storage: definition.id,
      slots: definition.capacity.slots,
      current: null,
      intervals: [],
    });
  }
  for (const event of run.events) {
    if (event.time > through) break;
    if (event.kind !== "storage-changed") continue;
    const ledger = ledgers.get(event.storage);
    if (ledger === undefined)
      throw new Error("Unknown carrier store in history");
    // A complete history starts with an accepted snapshot at time zero.
    if (ledger.current === null && event.time !== 0)
      return { kind: "unavailable" };
    appendInterval(ledger, after, through, event.time, false);
    ledger.current = {
      start: event.time,
      contents: {
        occupants: event.occupants,
        reservations: event.reservations,
      },
    };
  }
  const storages: StorageUsage[] = [];
  for (const ledger of ledgers.values()) {
    if (ledger.current === null) return { kind: "unavailable" };
    appendInterval(ledger, after, through, through, true);
    storages.push(summarize(ledger, through - after));
  }
  return { kind: "available", version: 1, after, through, storages };
}
