import { sameJson } from "@purin-labs/std";
import { emit, held, type Draft } from "./engine-draft.ts";
import type { StorageState } from "./state.ts";
import type { LogicalTime } from "./time.ts";

/** Commit storage and its history together, including recovery reservations. */
export function setStorage(
  draft: Draft,
  time: LogicalTime,
  storage: StorageState,
): void {
  const previous = held(draft.storages, storage.id, "storage");
  if (sameJson(previous, storage)) return;
  draft.storages.set(storage.id, storage);
  emit(draft, time, {
    kind: "storage-changed",
    storage: storage.id,
    occupants: storage.occupants,
    reservations: storage.reservations,
  });
}
