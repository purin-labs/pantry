import { isRecord } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import * as d from "./document-values.ts";
import {
  drainStatus,
  type ArrivalSourceState,
  type DrainStatus,
  type RunState,
} from "./state.ts";
import type {
  OrderResult,
  ReportedQuantity,
  RunResults,
  StockBalance,
} from "./results.ts";

export type ArrivalView = StrictUnion<
  | ArrivalSourceState
  | Readonly<{
      kind: "closing";
      id: ArrivalSourceState["id"];
      next: number;
      effectiveAt: number;
      command: string;
    }>
>;

export type ProductionReport = Pick<
  RunResults,
  "orders" | "ordersCompleted" | "reported" | "stock"
>;

export type ProductionView = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      version: 1;
      arrivals: readonly ArrivalView[];
      drain: DrainStatus;
      orders: readonly OrderResult[];
      ordersCompleted: number;
      reported: readonly ReportedQuantity[];
      stock: readonly StockBalance[];
    }>
>;

export function productionView(
  run: RunState,
  results: RunResults,
): ProductionView {
  return {
    kind: "available",
    version: 1,
    arrivals: run.arrivals.map(arrivalView.bind(null, run)),
    drain: drainStatus(run),
    orders: results.orders,
    ordersCompleted: results.ordersCompleted,
    reported: results.reported,
    stock: results.stock,
  };
}

function arrivalView(run: RunState, source: ArrivalSourceState): ArrivalView {
  if (source.kind !== "open") return source;
  for (const entry of run.commands)
    if (
      entry.command.kind === "close-arrivals" &&
      entry.command.source === source.id &&
      entry.receipt.status === "accepted" &&
      entry.receipt.effectiveAt > run.position.time
    )
      return {
        kind: "closing",
        id: source.id,
        next: source.next,
        effectiveAt: entry.receipt.effectiveAt,
        command: entry.command.commandId,
      };
  return source;
}

/** Missing fields belong only to retained protocol 1–3 response normalization. */
export function readProductionView(raw: unknown): ProductionView {
  if (raw === undefined) return { kind: "unavailable" };
  d.requireValue(isRecord(raw));
  if (d.choice(raw.kind, "available", "unavailable") === "unavailable")
    return { kind: "unavailable" };
  return {
    kind: "available",
    version: d.choice(raw.version, 1),
    arrivals: d.array(raw.arrivals, readArrival),
    drain: readDrain(raw.drain),
    orders: d.array(raw.orders, readOrder),
    ordersCompleted: d.natural(raw.ordersCompleted),
    reported: d.array(raw.reported, readReported),
    stock: d.array(raw.stock, readStock),
  };
}
export function readProductionReport(raw: unknown): ProductionReport {
  d.requireValue(isRecord(raw));
  return {
    orders: d.array(raw.orders, readOrder),
    ordersCompleted: d.natural(raw.ordersCompleted),
    reported: d.array(raw.reported, readReported),
    stock: d.array(raw.stock, readStock),
  };
}

function readArrival(raw: unknown): ArrivalView {
  d.requireValue(isRecord(raw));
  const id = d.id("arrival-source", raw.id);
  const next = d.natural(raw.next);
  switch (d.choice(raw.kind, "open", "exhausted", "closed", "closing")) {
    case "closing":
      return {
        kind: "closing",
        id,
        next,
        effectiveAt: d.time(raw.effectiveAt),
        command: d.id("command", raw.command),
      };
    case "open":
      return { kind: "open", id, next };
    case "exhausted":
      return { kind: "exhausted", id, next };
    case "closed":
      return {
        kind: "closed",
        id,
        next,
        closedAt: d.time(raw.closedAt),
        command: d.id("command", raw.command),
      };
  }
}
function readDrain(raw: unknown): DrainStatus {
  d.requireValue(isRecord(raw));
  switch (d.choice(raw.kind, "drained", "draining", "blocked")) {
    case "drained":
      return { kind: "drained", at: d.time(raw.at) };
    case "draining":
      return {
        kind: "draining",
        openSources: d.ids("arrival-source", raw.openSources),
        openInstances: d.ids("workflow-instance", raw.openInstances),
        boundCarriers: d.ids("carrier", raw.boundCarriers),
      };
    case "blocked": {
      const tasks = d.ids("task", raw.tasks);
      const first = tasks[0];
      d.requireValue(first !== undefined);
      return { kind: "blocked", tasks: [first, ...tasks.slice(1)] };
    }
  }
}
function readOrder(raw: unknown): OrderResult {
  d.requireValue(isRecord(raw));
  const instance = d.id("workflow-instance", raw.instance);
  const arrivedAt = d.time(raw.arrivedAt);
  switch (d.choice(raw.kind, "open", "completed", "failed")) {
    case "open":
      return { kind: "open", instance, arrivedAt, age: d.duration(raw.age) };
    case "completed": {
      const completedAt = d.time(raw.completedAt);
      const leadTime = d.duration(raw.leadTime);
      d.requireValue(completedAt - arrivedAt === leadTime);
      return { kind: "completed", instance, arrivedAt, completedAt, leadTime };
    }
    case "failed":
      return {
        kind: "failed",
        instance,
        arrivedAt,
        failedAt: d.time(raw.failedAt),
      };
  }
}
function readReported(raw: unknown): ReportedQuantity {
  d.requireValue(isRecord(raw));
  return {
    destination: d.id("destination", raw.destination),
    role: d.choice(
      raw.role,
      "final-output",
      "intermediate-stock",
      "rejected-output",
      "loss",
    ),
    product: d.id("product", raw.product),
    unit: d.choice(raw.unit, "each", "milligram", "microliter"),
    amount: d.natural(raw.amount),
    rate: d.nullable(raw.rate, readRate),
  };
}
function readRate(raw: unknown): number {
  d.requireValue(typeof raw === "number" && Number.isFinite(raw) && raw >= 0);
  return raw;
}
function readStock(raw: unknown): StockBalance {
  d.requireValue(isRecord(raw));
  const remaining = d.natural(raw.remaining);
  const held = d.natural(raw.held);
  d.requireValue(held <= remaining);
  return {
    product: d.id("product", raw.product),
    unit: d.choice(raw.unit, "each", "milligram", "microliter"),
    remaining,
    held,
  };
}
