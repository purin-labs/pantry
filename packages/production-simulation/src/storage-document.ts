import { isRecord } from "@seams/std";
import * as d from "./document-values.ts";
import type { CarrierId } from "./identity.ts";
import type { StorageState } from "./state.ts";

export type StorageContents = Pick<StorageState, "occupants" | "reservations">;

function reservation(raw: unknown): StorageState["reservations"][number] {
  const r = d.record(raw, ["task", "carrier"]);
  return { task: d.id("task", r.task), carrier: d.id("carrier", r.carrier) };
}

/** Shared by saved state, accepted events, and worker observations. */
export function readStorageContents(raw: unknown): StorageContents {
  d.requireValue(isRecord(raw));
  const occupants = d.ids("carrier", raw.occupants);
  const reservations = d.array(raw.reservations, reservation);
  d.requireValue(new Set(occupants).size === occupants.length);
  const reserved = new Set<CarrierId>();
  for (const item of reservations) {
    d.requireValue(!reserved.has(item.carrier));
    reserved.add(item.carrier);
  }
  return { occupants, reservations };
}
