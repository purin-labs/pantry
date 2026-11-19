import { assertNever, sameJson } from "@purin-labs/std";
import { executionWork } from "./scenario.ts";
import type { StrictUnion } from "@purin-labs/type-utils";
import type { AcceptedEvent } from "./events.ts";
import { compareOrder } from "./events.ts";
import { held, thaw, taskDefinition } from "./engine-draft.ts";
import type { ResourceId, TaskId } from "./identity.ts";
import type { ReportingInterval } from "./results.ts";
import type { TaskDefinition } from "./scenario.ts";
import type { Allocation, Blocker, RunState, TaskState } from "./state.ts";
import { ZERO_TIME } from "./time.ts";

export type TaskWait = Readonly<{ task: TaskId; blockers: readonly Blocker[] }>;
export type WaitInterval = TaskWait & Readonly<{ start: number; end: number }>;

/** Each capacity unit belongs to exactly one category at each logical instant. */
export type CapacityCategories = Readonly<{
  running: number;
  reserved: number;
  unavailable: number;
  loading: number;
  unloading: number;
  blocked: number;
  starved: number;
  idle: number;
}>;
export const CAPACITY_CATEGORIES = [
  "running",
  "reserved",
  "unavailable",
  "loading",
  "unloading",
  "blocked",
  "starved",
  "idle",
] as const satisfies readonly (keyof CapacityCategories)[];

export type CapacityInterval = Readonly<{
  start: number;
  end: number;
  units: CapacityCategories;
}>;
export type ResourceCategories = Readonly<{
  resource: ResourceId;
  capacity: number;
  unitSeconds: CapacityCategories;
  intervals: readonly CapacityInterval[];
}>;
export type SchedulingHistoryView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      version: 1;
      after: number;
      through: number;
      resources: readonly ResourceCategories[];
      waits: readonly WaitInterval[];
    }>
>;

export function taskWaits(tasks: Iterable<TaskState>): TaskWait[] {
  const waiting: TaskWait[] = [];
  for (const task of tasks)
    if (task.kind === "waiting")
      waiting.push({ task: task.id, blockers: task.blockers });
  return waiting;
}

/** Gates request no capacity. A missing carrier is an incoming-material shortage. */
export function waitCategory(
  blockers: readonly Blocker[],
): "gated" | "blocked" | "starved" {
  let blocked = false;
  for (const blocker of blockers) {
    switch (blocker.kind) {
      case "release":
      case "inspection":
      case "prerequisite":
        return "gated";
      case "material":
      case "carrier":
        break;
      case "batch-cycle":
      case "workers":
      case "resource":
      case "configuration":
      case "destination":
      case "cell-slot":
      case "cell-state":
        blocked = true;
        break;
      default:
        assertNever(blocker);
    }
  }
  return blocked || blockers.length === 0 ? "blocked" : "starved";
}

type MutableCategories = {
  -readonly [Key in keyof CapacityCategories]: number;
};
function emptyCategories(): MutableCategories {
  return {
    running: 0,
    reserved: 0,
    unavailable: 0,
    loading: 0,
    unloading: 0,
    blocked: 0,
    starved: 0,
    idle: 0,
  };
}
type Ledger = {
  readonly resource: ResourceId;
  readonly capacity: number;
  readonly claims: Map<TaskId, Pick<Allocation, "kind" | "units">>;
  readonly withheld: Set<string>;
  readonly members: Set<TaskId>;
  batch: "idle" | "loading" | "running" | "unloading";
  readonly intervals: CapacityInterval[];
};
type Demand = Readonly<{
  wait: TaskWait;
  definition: TaskDefinition;
  arrival: RunState["instances"][number]["arrival"];
}>;

function compareDemand(left: Demand, right: Demand): number {
  return compareOrder(
    {
      phase: "dispatch",
      time: ZERO_TIME,
      priority: left.definition.priority,
      arrival: left.arrival,
      task: left.wait.task,
    },
    {
      phase: "dispatch",
      time: ZERO_TIME,
      priority: right.definition.priority,
      arrival: right.arrival,
      task: right.wait.task,
    },
  );
}

function baseCategories(ledger: Ledger): MutableCategories {
  const units = emptyCategories();
  units.idle = ledger.capacity;
  for (const claim of ledger.claims.values()) {
    units.idle -= claim.units;
    switch (claim.kind) {
      case "occupied":
        units.running += claim.units;
        break;
      case "reserved":
        units.reserved += claim.units;
        break;
      case "held":
        units.unavailable += claim.units;
        break;
      default:
        assertNever(claim.kind);
    }
  }
  if (units.idle < 0) throw new Error("Resource history exceeds capacity");
  // A running batch seals its unused slots until the cycle clears.
  if (ledger.withheld.size > 0 || ledger.batch === "running") {
    units.unavailable += units.idle;
    units.idle = 0;
  } else if (ledger.batch === "loading" || ledger.batch === "unloading") {
    units[ledger.batch] = units.idle;
    units.idle = 0;
  }
  return units;
}

function useDemand(
  units: MutableCategories,
  kind: "blocked" | "starved",
  count: number,
): void {
  const used = Math.min(units.idle, count);
  units[kind] += used;
  units.idle -= used;
}

function appendCapacity(
  ledgers: ReadonlyMap<ResourceId, Ledger>,
  definitions: ReadonlyMap<TaskId, Omit<Demand, "wait">>,
  waiting: readonly TaskWait[],
  start: number,
  end: number,
): void {
  if (end <= start) return;
  const categories = new Map<ResourceId, MutableCategories>();
  for (const ledger of ledgers.values())
    categories.set(ledger.resource, baseCategories(ledger));
  const demands: Demand[] = [];
  for (const wait of waiting) {
    const definition = held(definitions, wait.task, "waiting task definition");
    demands.push({
      wait,
      definition: definition.definition,
      arrival: definition.arrival,
    });
  }
  demands.sort(compareDemand);
  // Blocked demand takes precedence over material starvation on remaining units.
  for (const kind of ["blocked", "starved"] as const) {
    for (const demand of demands) {
      if (waitCategory(demand.wait.blockers) !== kind) continue;
      for (const claim of demand.definition.claims)
        useDemand(
          held(categories, claim.resource, "resource categories"),
          kind,
          claim.units,
        );
      const executor = executionWork(demand.definition.executor);
      if (executor.kind !== "attended") continue;
      // Candidate order matches dispatch. Attribute a request to one free worker.
      for (const worker of executor.workers) {
        const units = held(categories, worker, "worker categories");
        if (units.idle === 0) continue;
        useDemand(units, kind, 1);
        break;
      }
    }
  }
  for (const ledger of ledgers.values()) {
    const units = held(categories, ledger.resource, "resource categories");
    const previous = ledger.intervals.at(-1);
    if (
      previous !== undefined &&
      previous.end === start &&
      sameJson(previous.units, units)
    )
      ledger.intervals[ledger.intervals.length - 1] = {
        start: previous.start,
        end,
        units,
      };
    else ledger.intervals.push({ start, end, units });
  }
}

function acceptEvent(
  ledgers: ReadonlyMap<ResourceId, Ledger>,
  event: AcceptedEvent,
): void {
  if (!("resource" in event)) return;
  const ledger = held(ledgers, event.resource, "resource history");
  switch (event.kind) {
    case "resource-claimed":
      ledger.claims.set(event.task, {
        kind: event.allocation,
        units: event.units,
      });
      break;
    case "resource-released":
      ledger.claims.delete(event.task);
      break;
    case "availability-changed":
      if (event.available) ledger.withheld.delete(event.cause);
      else ledger.withheld.add(event.cause);
      break;
    case "batch-admitted":
      ledger.members.add(event.task);
      ledger.batch = "loading";
      break;
    case "batch-started":
      ledger.batch = "running";
      break;
    case "batch-completed":
      ledger.batch = "unloading";
      break;
    case "batch-cleared":
      ledger.members.clear();
      ledger.batch = "idle";
      break;
    case "batch-member-rejected":
      ledger.members.delete(event.task);
      if (ledger.members.size === 0) ledger.batch = "idle";
      break;
  }
}

function summarize(ledger: Ledger): ResourceCategories {
  const totals = emptyCategories();
  for (const span of ledger.intervals)
    for (const kind of CAPACITY_CATEGORIES)
      totals[kind] += (span.end - span.start) * span.units[kind];
  for (const kind of CAPACITY_CATEGORIES) totals[kind] /= 1_000_000;
  return {
    resource: ledger.resource,
    capacity: ledger.capacity,
    unitSeconds: totals,
    intervals: ledger.intervals,
  };
}

/** Replay accepted events once per timestamp. Same-time transitions consume no time. */
export function schedulingHistory(
  run: RunState,
  interval: ReportingInterval,
): SchedulingHistoryView {
  const after = interval.after ?? 0;
  const through = interval.through;
  if (after > through || through > run.position.time)
    throw new RangeError(
      "Scheduling history requires a committed reporting interval",
    );
  const first = run.events[0];
  if (first?.kind !== "waiting-changed" || first.time !== 0)
    return { kind: "unavailable" };
  const draft = thaw(run);
  const definitions = new Map<TaskId, Omit<Demand, "wait">>();
  for (const task of run.tasks) {
    if (task.subject.kind !== "workflow") continue;
    const instance = held(draft.instances, task.subject.instance, "instance");
    definitions.set(task.id, {
      definition: taskDefinition(draft, instance, task.subject.key),
      arrival: instance.arrival,
    });
  }
  const ledgers = new Map<ResourceId, Ledger>();
  for (const resource of run.definition.scenario.resources)
    ledgers.set(resource.id, {
      resource: resource.id,
      capacity: resource.capacity,
      claims: new Map(),
      withheld: new Set(),
      members: new Set(),
      batch: "idle",
      intervals: [],
    });
  let waiting: readonly TaskWait[] = [];
  let cursor = 0;
  const openWaits = new Map<
    TaskId,
    Readonly<{ start: number; wait: TaskWait }>
  >();
  const waits: WaitInterval[] = [];
  for (const event of run.events) {
    if (event.time > through) break;
    appendCapacity(
      ledgers,
      definitions,
      waiting,
      Math.max(after, cursor),
      event.time,
    );
    cursor = event.time;
    acceptEvent(ledgers, event);
    if (event.kind !== "waiting-changed") continue;
    const next = new Map<TaskId, TaskWait>();
    for (const wait of event.waiting) next.set(wait.task, wait);
    for (const [task, open] of openWaits) {
      const nextWait = next.get(task);
      if (nextWait !== undefined && sameJson(open.wait, nextWait)) continue;
      appendWait(waits, open, after, event.time);
      openWaits.delete(task);
    }
    for (const wait of event.waiting)
      if (!openWaits.has(wait.task))
        openWaits.set(wait.task, { start: event.time, wait });
    waiting = event.waiting;
  }
  appendCapacity(
    ledgers,
    definitions,
    waiting,
    Math.max(after, cursor),
    through,
  );
  for (const open of openWaits.values())
    appendWait(waits, open, after, through);
  const resources: ResourceCategories[] = [];
  for (const ledger of ledgers.values()) resources.push(summarize(ledger));
  return { kind: "available", version: 1, after, through, resources, waits };
}

function appendWait(
  waits: WaitInterval[],
  open: Readonly<{ start: number; wait: TaskWait }>,
  after: number,
  end: number,
): void {
  const start = Math.max(after, open.start);
  if (end > start)
    waits.push({
      task: open.wait.task,
      blockers: open.wait.blockers,
      start,
      end,
    });
}
