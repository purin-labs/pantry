import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import {
  instanceLotId,
  taskId,
  type LotId,
  type ProductId,
  type StorageId,
  type TaskId,
} from "./identity.ts";
import type { MaterialUnit } from "./quantity.ts";
import type { ReportingInterval, StockBalance } from "./results.ts";
import type { RunState } from "./state.ts";
import { outputCeiling, type MaterialOutput } from "./scenario.ts";
import type { AcceptedEvent } from "./events.ts";

export type MaterialStorageContents = Readonly<{
  occupied: number;
  held: number;
  reservations: readonly Readonly<{ task: TaskId; quantity: number }>[];
}>;
export type MaterialStorageInterval = MaterialStorageContents &
  Readonly<{
    start: number;
    end: number;
    ongoing: boolean;
  }>;
export type MaterialStorageUsage = Readonly<{
  storage: StorageId;
  product: ProductId;
  unit: MaterialUnit;
  capacity: number;
  current: MaterialStorageContents;
  occupiedQuantitySeconds: number;
  reservedQuantitySeconds: number;
  freeQuantitySeconds: number;
  peakCommitted: number;
  fullSeconds: number;
  intervals: readonly MaterialStorageInterval[];
}>;
export type MaterialStorageHistoryView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      version: 1;
      after: number;
      through: number;
      storages: readonly MaterialStorageUsage[];
    }>
>;

type LotBalance = {
  readonly product: ProductId;
  readonly storage: StorageId | null;
  remaining: number;
  held: boolean;
};
type MaterialStore = {
  readonly storage: StorageId;
  readonly product: ProductId;
  readonly unit: MaterialUnit;
  readonly capacity: number;
  readonly reservations: Map<TaskId, number>;
  readonly intervals: MaterialStorageInterval[];
  start: number;
  occupied: number;
  held: number;
};
type LotOutput = Variant<MaterialOutput, "lot" | "measured-lot">;
type MaterialLedger = Readonly<{
  lots: Map<LotId, LotBalance>;
  definitions: ReadonlyMap<LotId, LotOutput>;
  outputs: ReadonlyMap<TaskId, readonly LotOutput[]>;
  stores: Map<StorageId, MaterialStore>;
  after: number;
  through: number;
}>;

/** One accepted-event fold supplies both stock balances and material-store history. */
export function materialResults(
  run: RunState,
  interval: ReportingInterval,
): Readonly<{
  stock: readonly StockBalance[];
  storageHistory: MaterialStorageHistoryView;
}> {
  const after = interval.after ?? 0;
  const through = interval.through;
  if (after > through || through > run.position.time)
    throw new RangeError(
      "Material history requires a committed reporting interval",
    );
  const stores = new Map<StorageId, MaterialStore>();
  for (const definition of run.definition.scenario.storages) {
    if (definition.capacity.kind !== "material") continue;
    stores.set(definition.id, {
      storage: definition.id,
      product: definition.capacity.product,
      unit: definition.capacity.quantity.unit,
      capacity: definition.capacity.quantity.amount,
      start: 0,
      occupied: 0,
      held: 0,
      reservations: new Map(),
      intervals: [],
    });
  }
  const definitions = new Map<LotId, LotOutput>();
  const outputs = new Map<TaskId, readonly LotOutput[]>();
  for (const instance of run.instances)
    for (const workflow of run.definition.scenario.workflows) {
      if (workflow.id !== instance.workflow) continue;
      for (const task of workflow.tasks) {
        const lots: LotOutput[] = [];
        for (const output of task.outputs) {
          if (output.kind !== "lot" && output.kind !== "measured-lot") continue;
          definitions.set(instanceLotId(instance.id, output.lot), output);
          lots.push(output);
        }
        outputs.set(taskId(instance.id, task.key), lots);
      }
    }
  const ledger: MaterialLedger = {
    lots: new Map(),
    definitions,
    outputs,
    stores,
    after,
    through,
  };
  for (const lot of run.definition.scenario.stock) {
    ledger.lots.set(lot.id, {
      product: lot.product,
      storage: lot.storage,
      remaining: lot.quantity.amount,
      held: false,
    });
    const store = stores.get(lot.storage);
    if (store !== undefined) store.occupied += lot.quantity.amount;
  }
  for (const event of run.events) {
    if (event.time > through) break;
    applyMaterialEvent(ledger, event);
  }
  const storages: MaterialStorageUsage[] = [];
  for (const store of stores.values()) {
    appendMaterialInterval(ledger, store, through, true);
    storages.push(summarizeMaterialStore(store, through - after));
  }
  const stock: StockBalance[] = [];
  for (const product of run.definition.scenario.products) {
    let remaining = 0;
    let held = 0;
    for (const lot of ledger.lots.values()) {
      if (lot.product !== product.id) continue;
      remaining += lot.remaining;
      if (lot.held) held += lot.remaining;
    }
    stock.push({ product: product.id, unit: product.unit, remaining, held });
  }
  return {
    stock,
    storageHistory: { kind: "available", version: 1, after, through, storages },
  };
}

function applyMaterialEvent(
  ledger: MaterialLedger,
  event: AcceptedEvent,
): void {
  switch (event.kind) {
    case "lot-produced": {
      const definition = ledger.definitions.get(event.lot);
      if (definition === undefined)
        throw new Error("Produced material has no pinned definition");
      const lot: LotBalance = {
        product: event.product,
        remaining: event.quantity.amount,
        storage:
          definition.holder.kind === "storage"
            ? definition.holder.storage
            : null,
        held: definition.disposition === "held",
      };
      ledger.lots.set(event.lot, lot);
      changeStoredQuantity(
        ledger,
        lot,
        event.time,
        lot.remaining,
        lot.held ? lot.remaining : 0,
      );
      break;
    }
    case "lot-consumed": {
      const lot = requiredLot(ledger, event.lot);
      if (lot.remaining < event.quantity.amount)
        throw new Error("Invalid material consumption history");
      changeStoredQuantity(
        ledger,
        lot,
        event.time,
        -event.quantity.amount,
        lot.held ? -event.quantity.amount : 0,
      );
      lot.remaining -= event.quantity.amount;
      break;
    }
    case "lot-released": {
      const lot = requiredLot(ledger, event.lot);
      if (lot.held)
        changeStoredQuantity(ledger, lot, event.time, 0, -lot.remaining);
      lot.held = false;
      break;
    }
    case "task-started":
      reserveMaterialOutput(ledger, event.task, event.time);
      break;
    case "task-completed":
    case "task-failed":
      for (const store of ledger.stores.values()) {
        if (!store.reservations.has(event.task)) continue;
        appendMaterialInterval(ledger, store, event.time, false);
        store.reservations.delete(event.task);
      }
      break;
  }
}

function requiredLot(ledger: MaterialLedger, id: LotId): LotBalance {
  const lot = ledger.lots.get(id);
  if (lot === undefined) throw new Error("Invalid material lot history");
  return lot;
}
function changeStoredQuantity(
  ledger: MaterialLedger,
  lot: LotBalance,
  time: number,
  amount: number,
  held: number,
): void {
  if (lot.storage === null) return;
  const store = ledger.stores.get(lot.storage);
  if (store === undefined)
    throw new Error("Material lot names an unknown material store");
  appendMaterialInterval(ledger, store, time, false);
  store.occupied += amount;
  store.held += held;
}
function reserveMaterialOutput(
  ledger: MaterialLedger,
  task: TaskId,
  time: number,
): void {
  for (const output of ledger.outputs.get(task) ?? []) {
    if (output.holder.kind !== "storage") continue;
    const store = ledger.stores.get(output.holder.storage);
    if (store === undefined)
      throw new Error("Material output names an unknown material store");
    appendMaterialInterval(ledger, store, time, false);
    store.reservations.set(
      task,
      (store.reservations.get(task) ?? 0) + outputCeiling(output).amount,
    );
  }
}
function materialContents(store: MaterialStore): MaterialStorageContents {
  const reservations = [];
  for (const [task, quantity] of store.reservations)
    reservations.push({ task, quantity });
  return { occupied: store.occupied, held: store.held, reservations };
}
function appendMaterialInterval(
  ledger: MaterialLedger,
  store: MaterialStore,
  end: number,
  ongoing: boolean,
): void {
  const start = Math.max(ledger.after, store.start);
  const clippedEnd = Math.min(ledger.through, end);
  if (clippedEnd > start) {
    const contents = materialContents(store);
    let committed = contents.occupied;
    for (const reservation of contents.reservations)
      committed += reservation.quantity;
    if (
      contents.held < 0 ||
      contents.held > contents.occupied ||
      committed > store.capacity
    )
      throw new Error("Material storage history exceeds declared capacity");
    store.intervals.push({
      start,
      end: clippedEnd,
      ongoing,
      occupied: contents.occupied,
      held: contents.held,
      reservations: contents.reservations,
    });
  }
  store.start = end;
}
function summarizeMaterialStore(
  store: MaterialStore,
  duration: number,
): MaterialStorageUsage {
  let occupied = 0;
  let reserved = 0;
  let peakCommitted = 0;
  let full = 0;
  for (const span of store.intervals) {
    const elapsed = span.end - span.start;
    let promised = 0;
    for (const reservation of span.reservations)
      promised += reservation.quantity;
    occupied += span.occupied * elapsed;
    reserved += promised * elapsed;
    peakCommitted = Math.max(peakCommitted, span.occupied + promised);
    if (span.occupied + promised === store.capacity) full += elapsed;
  }
  return {
    storage: store.storage,
    product: store.product,
    unit: store.unit,
    capacity: store.capacity,
    current: materialContents(store),
    occupiedQuantitySeconds: occupied / 1_000_000,
    reservedQuantitySeconds: reserved / 1_000_000,
    freeQuantitySeconds:
      Math.max(0, store.capacity * duration - occupied - reserved) / 1_000_000,
    peakCommitted,
    fullSeconds: full / 1_000_000,
    intervals: store.intervals,
  };
}
