import {
  materialResults,
  type MaterialStorageHistoryView,
} from "./material-history.ts";
import { storageHistory, type StorageHistoryView } from "./storage-history.ts";
import {
  schedulingHistory,
  type SchedulingHistoryView,
} from "./scheduling-history.ts";
import { assertNever } from "@purin-labs/std";
import type {
  DestinationId,
  ProductId,
  WorkflowInstanceId,
  ResourceId,
  TaskId,
} from "./identity.ts";
import type { AcceptedEvent } from "./events.ts";
import type { Allocation } from "./state.ts";
import type { MaterialUnit } from "./quantity.ts";
import type { ReportingRole } from "./scenario.ts";
import type { RunState } from "./state.ts";
import { elapsed, type LogicalTime, type TickDuration } from "./time.ts";

/**
 * One projection of a run's accepted events, shared by headless reports and
 * portal results. It reads the run and can never change it.
 */

/** Events after `after` and through `through`. Null starts with time zero. */
export type ReportingInterval = Readonly<{
  after: LogicalTime | null;
  through: LogicalTime;
}>;

/**
 * A quantity counted where it crossed a named reporting boundary. Products
 * and units are never combined, and each role is reported apart.
 */
export type ReportedQuantity = Readonly<{
  destination: DestinationId;
  role: ReportingRole;
  product: ProductId;
  unit: MaterialUnit;
  amount: number;
  /** Per second of the interval. Null when the interval has no duration. */
  rate: number | null;
}>;

export type OrderResult = Readonly<{
  instance: WorkflowInstanceId;
  arrivedAt: LogicalTime;
}> &
  (
    | Readonly<{
        kind: "completed";
        completedAt: LogicalTime;
        leadTime: TickDuration;
      }>
    // An unfinished order keeps its original arrival and its current age.
    | Readonly<{ kind: "open"; age: TickDuration }>
    | Readonly<{ kind: "failed"; failedAt: LogicalTime }>
  );

export type StockBalance = Readonly<{
  product: ProductId;
  unit: MaterialUnit;
  remaining: number;
  /** Of `remaining`, the part in lots not yet released. */
  held: number;
}>;

export type RunResults = Readonly<{
  interval: ReportingInterval;
  reported: readonly ReportedQuantity[];
  ordersCompleted: number;
  orders: readonly OrderResult[];
  /** Material in the factory at the run's current position. */
  stock: readonly StockBalance[];
  resources: readonly ResourceUsage[];
  storageHistory: StorageHistoryView;
  materialStorageHistory: MaterialStorageHistoryView;
  schedulingHistory: SchedulingHistoryView;
}>;

export type ResourceInterval = Readonly<{
  task: TaskId;
  kind: "reserved" | "occupied" | "held" | "travel" | "handling" | "changeover";
  units: number;
  start: number;
  end: number;
  ongoing: boolean;
}>;

/** Capacity-time uses unit-seconds. Travel, handling and changeover are subsets of occupied time. */
export type ResourceUsage = Readonly<{
  resource: ResourceId;
  capacity: number;
  capacityUnitSeconds: number;
  occupiedUnitSeconds: number;
  reservedUnitSeconds: number;
  heldUnitSeconds: number;
  unallocatedUnitSeconds: number;
  /** Admission withholding can overlap running claims. It is reported separately. */
  withheldUnitSeconds: number;
  travelUnitSeconds: number;
  handlingUnitSeconds: number;
  changeoverUnitSeconds: number;
  claimedShare: number | null;
  intervals: readonly ResourceInterval[];
}>;

type Claim = Readonly<{
  task: TaskId;
  kind: Allocation["kind"];
  units: number;
  start: number;
  arrivesAt: number | null;
}>;

type ResourceLedger = {
  readonly active: Map<TaskId, Claim>;
  readonly intervals: ResourceInterval[];
};

function appendInterval(
  ledger: ResourceLedger,
  interval: ReportingInterval,
  claim: Claim,
  kind: ResourceInterval["kind"],
  start: number,
  end: number,
  ongoing: boolean,
): void {
  const clippedStart = Math.max(start, interval.after ?? 0);
  const clippedEnd = Math.min(end, interval.through);
  if (clippedEnd <= clippedStart) return;
  ledger.intervals.push({
    task: claim.task,
    kind,
    units: claim.units,
    start: clippedStart,
    end: clippedEnd,
    ongoing,
  });
}

function closeClaim(
  ledger: ResourceLedger,
  interval: ReportingInterval,
  task: TaskId,
  end: number,
  ongoing: boolean,
  changeovers: ReadonlySet<TaskId>,
): void {
  const claim = ledger.active.get(task);
  if (claim === undefined) return;
  ledger.active.delete(task);
  if (claim.kind === "occupied" && claim.arrivesAt !== null) {
    const travelEnd = Math.min(end, claim.arrivesAt);
    appendInterval(
      ledger,
      interval,
      claim,
      "travel",
      claim.start,
      travelEnd,
      ongoing && travelEnd === end,
    );
    appendInterval(
      ledger,
      interval,
      claim,
      "handling",
      travelEnd,
      end,
      ongoing,
    );
    return;
  }
  const kind =
    claim.kind === "occupied" && changeovers.has(task)
      ? "changeover"
      : claim.kind;
  appendInterval(ledger, interval, claim, kind, claim.start, end, ongoing);
}

function acceptResourceEvent(
  ledgers: ReadonlyMap<ResourceId, ResourceLedger>,
  interval: ReportingInterval,
  changeovers: ReadonlySet<TaskId>,
  event: AcceptedEvent,
): void {
  if (event.kind === "worker-assigned") {
    const ledger = ledgers.get(event.worker);
    const claim = ledger?.active.get(event.task);
    if (claim !== undefined)
      ledger?.active.set(event.task, {
        task: claim.task,
        kind: claim.kind,
        units: claim.units,
        start: claim.start,
        arrivesAt: event.arrivesAt,
      });
    return;
  }
  if (event.kind !== "resource-claimed" && event.kind !== "resource-released")
    return;
  const ledger = ledgers.get(event.resource);
  if (ledger === undefined)
    throw new Error("Resource history names an unknown resource");
  closeClaim(ledger, interval, event.task, event.time, false, changeovers);
  if (event.kind === "resource-claimed")
    ledger.active.set(event.task, {
      task: event.task,
      kind: event.allocation,
      units: event.units,
      start: event.time,
      arrivesAt: null,
    });
}

function compareIntervals(
  left: ResourceInterval,
  right: ResourceInterval,
): number {
  return (
    left.start - right.start ||
    left.end - right.end ||
    (left.task < right.task ? -1 : left.task > right.task ? 1 : 0)
  );
}

function compareWithholding(
  left: Readonly<{ start: number }>,
  right: Readonly<{ start: number }>,
): number {
  return left.start - right.start;
}

/** Union overlapping admission intervals. They do not interrupt active work. */
function withheldSeconds(
  run: RunState,
  resource: ResourceId,
  interval: ReportingInterval,
): number {
  const intervals: { start: number; end: number }[] = [];
  for (const state of run.resources)
    if (state.id === resource)
      for (const entry of state.withheld) {
        const start = Math.max(interval.after ?? 0, entry.interval.start);
        const end = Math.min(interval.through, entry.interval.end);
        if (end > start) intervals.push({ start, end });
      }
  intervals.sort(compareWithholding);
  let end = interval.after ?? 0;
  let duration = 0;
  for (const entry of intervals) {
    duration += Math.max(0, entry.end - Math.max(end, entry.start));
    end = Math.max(end, entry.end);
  }
  return duration / 1_000_000;
}

/** Integrate accepted resource transitions, clipped at the committed cursor. */
export function resourceUsage(
  run: RunState,
  interval: ReportingInterval,
): readonly ResourceUsage[] {
  const start = interval.after ?? 0;
  if (start > interval.through || interval.through > run.position.time)
    throw new RangeError(
      "Resource history requires a committed reporting interval",
    );
  const ledgers = new Map<ResourceId, ResourceLedger>();
  const changeovers = new Set<TaskId>();
  for (const task of run.tasks)
    if (task.subject.kind === "changeover") changeovers.add(task.id);
  for (const resource of run.definition.scenario.resources)
    ledgers.set(resource.id, { active: new Map(), intervals: [] });
  for (const event of run.events) {
    if (event.time > interval.through) break;
    acceptResourceEvent(ledgers, interval, changeovers, event);
  }
  const resources: ResourceUsage[] = [];
  for (const definition of run.definition.scenario.resources) {
    const ledger = ledgers.get(definition.id);
    if (ledger === undefined) throw new Error("Missing resource ledger");
    for (const task of [...ledger.active.keys()])
      closeClaim(ledger, interval, task, interval.through, true, changeovers);
    ledger.intervals.sort(compareIntervals);
    let occupied = 0;
    let reserved = 0;
    let held = 0;
    let travel = 0;
    let handling = 0;
    let changeover = 0;
    for (const span of ledger.intervals) {
      const amount = (span.units * (span.end - span.start)) / 1_000_000;
      switch (span.kind) {
        case "occupied":
          occupied += amount;
          break;
        case "reserved":
          reserved += amount;
          break;
        case "held":
          held += amount;
          break;
        case "travel":
          occupied += amount;
          travel += amount;
          break;
        case "handling":
          occupied += amount;
          handling += amount;
          break;
        case "changeover":
          occupied += amount;
          changeover += amount;
          break;
        default:
          assertNever(span.kind, "Unexpected resource interval");
      }
    }
    const capacityTime =
      (definition.capacity * (interval.through - start)) / 1_000_000;
    const claimed = occupied + reserved + held;
    resources.push({
      resource: definition.id,
      capacity: definition.capacity,
      capacityUnitSeconds: capacityTime,
      occupiedUnitSeconds: occupied,
      reservedUnitSeconds: reserved,
      heldUnitSeconds: held,
      unallocatedUnitSeconds: Math.max(0, capacityTime - claimed),
      withheldUnitSeconds:
        definition.capacity * withheldSeconds(run, definition.id, interval),
      travelUnitSeconds: travel,
      handlingUnitSeconds: handling,
      changeoverUnitSeconds: changeover,
      claimedShare: capacityTime > 0 ? claimed / capacityTime : null,
      intervals: ledger.intervals,
    });
  }
  return resources;
}

function inside(interval: ReportingInterval, time: LogicalTime): boolean {
  return (
    time <= interval.through &&
    (interval.after === null || time > interval.after)
  );
}

export function runResults(
  run: RunState,
  interval: ReportingInterval,
): RunResults {
  const seconds = (interval.through - (interval.after ?? 0)) / 1_000_000;
  const reported = new Map<DestinationId, ReportedQuantity>();
  for (const destination of run.definition.scenario.destinations) {
    let unit: MaterialUnit | null = null;
    for (const product of run.definition.scenario.products)
      if (product.id === destination.product) unit = product.unit;
    if (unit === null)
      throw new Error(`Destination ${destination.id} reports no product`);
    reported.set(destination.id, {
      destination: destination.id,
      role: destination.role,
      product: destination.product,
      unit,
      amount: 0,
      rate: seconds > 0 ? 0 : null,
    });
  }
  const completions = new Map<WorkflowInstanceId, LogicalTime>();
  let ordersCompleted = 0;
  for (const event of run.events) {
    if (event.time > interval.through) break;
    if (event.kind === "order-completed") {
      completions.set(event.instance, event.time);
      if (inside(interval, event.time)) ordersCompleted += 1;
    }
    if (event.kind !== "quantity-reported" || !inside(interval, event.time))
      continue;
    const total = reported.get(event.destination);
    if (total === undefined)
      throw new Error(`Unknown reporting destination ${event.destination}`);
    const amount = total.amount + event.quantity.amount;
    reported.set(event.destination, {
      ...total,
      amount,
      rate: seconds > 0 ? amount / seconds : null,
    });
  }

  const orders: OrderResult[] = [];
  for (const instance of run.instances) {
    if (instance.demand !== "order" || instance.arrival.time > interval.through)
      continue;
    const arrivedAt = instance.arrival.time;
    if (
      instance.kind === "failed" &&
      failureResolvedBy(run, instance.cause, interval.through)
    ) {
      orders.push({
        instance: instance.id,
        arrivedAt,
        kind: "failed",
        failedAt: instance.failedAt,
      });
      continue;
    }
    const completedAt = completions.get(instance.id);
    orders.push(
      completedAt === undefined
        ? {
            instance: instance.id,
            arrivedAt,
            kind: "open",
            age: elapsed(arrivedAt, interval.through),
          }
        : {
            instance: instance.id,
            arrivedAt,
            kind: "completed",
            completedAt,
            leadTime: elapsed(arrivedAt, completedAt),
          },
    );
  }

  const material = materialResults(run, interval);
  return {
    interval,
    reported: [...reported.values()],
    ordersCompleted,
    orders,
    stock: material.stock,
    materialStorageHistory: material.storageHistory,
    resources: resourceUsage(run, interval),
    storageHistory: storageHistory(run, interval),
    schedulingHistory: schedulingHistory(run, interval),
  };
}

function failureResolvedBy(
  run: RunState,
  task: TaskId,
  through: LogicalTime,
): boolean {
  for (const event of run.events) {
    if (event.time > through) break;
    if (event.kind === "recovery-completed" && event.task === task) return true;
  }
  return false;
}
