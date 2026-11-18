import type { MaterialStorageHistoryView } from "./material-history.ts";
import { readMaterialStorageHistory } from "./material-history-view.ts";
import {
  productionView,
  readProductionView,
  type ProductionView,
} from "./production-view.ts";
import { type StorageHistoryView } from "./storage-history.ts";
import { readStorageHistory } from "./storage-history-view.ts";
import { type SchedulingHistoryView } from "./scheduling-history.ts";
import { readSchedulingHistory } from "./scheduling-history-document.ts";
import { isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import * as d from "./document-values.ts";
import { err, ok } from "./result.ts";
import {
  logisticsView,
  readLogisticsView,
  type LogisticsView,
} from "./logistics-view.ts";
import type { RunState } from "./state.ts";
import type { TaskState } from "./state.ts";
import { inspectionDecision, inspectionLots } from "./inspections.ts";
import { runResults } from "./results.ts";
import {
  readResourceHistory,
  type ResourceHistoryView,
} from "./resource-history-view.ts";

/** A protocol projection. Callers never need the retained engine's task types. */
export type RecoveryView = Readonly<{ task: string; failedAt: number }> &
  StrictUnion<
    | Readonly<{ kind: "recovery-required"; contents: RecoveryContents }>
    | Readonly<{
        kind: "recovering" | "recovery-failed";
        phase: "handling" | "returning";
        startedAt: number;
        handling: number;
        resource: string;
        storage: string;
      }>
  >;

type RecoveryContents = StrictUnion<
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      carrier: string;
      products: readonly Readonly<{
        product: string;
        destinations: readonly string[];
      }>[];
    }>
>;

function recoveryContents(
  run: RunState,
  task: Extract<TaskState, { kind: "recovery-required" }>,
): RecoveryContents {
  for (const cell of run.cells) {
    if (cell.attempt?.id !== task.attempt || cell.slot.kind !== "active")
      continue;
    const products = new Set<string>();
    for (const lot of run.lots)
      if (
        lot.holder.kind === "carrier" &&
        lot.holder.carrier === cell.slot.carrier &&
        lot.remaining.amount > 0
      )
        products.add(lot.product);
    const contents = [];
    for (const product of products) {
      const destinations = [];
      for (const destination of run.definition.scenario.destinations)
        if (
          destination.product === product &&
          destination.role === "rejected-output"
        )
          destinations.push(destination.id);
      contents.push({ product, destinations });
    }
    return {
      kind: "available",
      carrier: cell.slot.carrier,
      products: contents,
    };
  }
  return { kind: "unavailable" };
}

function readRecoveryProduct(raw: unknown) {
  const r = object(raw);
  return {
    product: d.text(r.product),
    destinations: d.array(r.destinations, d.text),
  };
}
function readRecoveryContents(raw: unknown): RecoveryContents {
  if (raw === undefined) return { kind: "unavailable" };
  const r = object(raw);
  if (d.choice(r.kind, "available", "unavailable") === "unavailable")
    return { kind: "unavailable" };
  return {
    kind: "available",
    carrier: d.text(r.carrier),
    products: d.array(r.products, readRecoveryProduct),
  };
}

export type InspectionView = Readonly<{
  task: string;
  definition: string;
  lots: readonly string[];
}> &
  StrictUnion<
    | Readonly<{ kind: "pending" }>
    | Readonly<{ kind: "recorded"; outcome: "accept" | "reject"; note: string }>
  >;
export type ProductionTotal = Readonly<{
  destination: string;
  amount: number;
  unit: string;
}>;

function inspectionViews(run: RunState): InspectionView[] {
  const views: InspectionView[] = [];
  for (const task of run.tasks) {
    const lots = inspectionLots(run, task.id);
    if (lots === null) continue;
    const decision = inspectionDecision(run.commands, task.id);
    if (decision !== null) {
      views.push({
        kind: "recorded",
        task: task.id,
        definition: run.definition.digest,
        lots,
        outcome: decision.outcome,
        note: decision.note,
      });
    } else if (
      task.kind === "waiting" &&
      task.blockers.length === 1 &&
      task.blockers[0]?.kind === "inspection"
    ) {
      views.push({
        kind: "pending",
        task: task.id,
        definition: run.definition.digest,
        lots,
      });
    }
  }
  return views;
}
function readInspectionView(raw: unknown): InspectionView {
  const r = object(raw);
  const task = d.text(r.task);
  const definition = d.digest(r.definition);
  const lots = d.array(r.lots, d.text);
  switch (d.choice(r.kind, "pending", "recorded")) {
    case "pending":
      return { kind: "pending", task, definition, lots };
    case "recorded":
      return {
        kind: "recorded",
        task,
        definition,
        lots,
        outcome: d.choice(r.outcome, "accept", "reject"),
        note: d.text(r.note),
      };
  }
}
function readTotal(raw: unknown): ProductionTotal {
  const r = object(raw);
  return {
    destination: d.text(r.destination),
    amount: d.natural(r.amount),
    unit: d.text(r.unit),
  };
}
export type HostView = Readonly<{
  production: ProductionView;
  inspections: readonly InspectionView[];
  totals: readonly ProductionTotal[];
  time: number;
  horizon: number;
  controlRevision: number;
  events: number;
  status: Readonly<{
    kind: RunState["status"]["kind"];
    need: string | null;
  }>;
  cells: readonly Readonly<{
    id: string;
    carrier: string | null;
    boundary: number;
    checkpoint: string;
    steps: number;
    hold: "evolving" | "settled" | "unresolved";
    attempt: Readonly<{
      id: string;
      steps: number;
      lifecycle: string;
    }> | null;
  }>[];
  recoveries: readonly RecoveryView[];
  logistics: LogisticsView;
  resourceHistory: ResourceHistoryView;
  storageHistory: StorageHistoryView;
  materialStorageHistory: MaterialStorageHistoryView;
  schedulingHistory: SchedulingHistoryView;
}>;

export function executionView(run: RunState): HostView {
  const results = runResults(run, { after: null, through: run.position.time });
  const cells: HostView["cells"][number][] = [];
  for (const cell of run.cells)
    cells.push({
      id: cell.id,
      carrier: cell.slot.kind === "active" ? cell.slot.carrier : null,
      boundary: cell.committed.boundary,
      checkpoint: cell.committed.checkpoint.digest,
      steps: cell.committed.checkpoint.step,
      hold: cell.hold.kind,
      attempt:
        cell.attempt === null
          ? null
          : {
              id: cell.attempt.id,
              steps: cell.attempt.steps,
              lifecycle: cell.attempt.lifecycle.kind,
            },
    });
  const recoveries: RecoveryView[] = [];
  for (const task of run.tasks) {
    if (task.kind === "recovery-required")
      recoveries.push({
        kind: task.kind,
        task: task.id,
        failedAt: task.failedAt,
        contents: recoveryContents(run, task),
      });
    else if (task.kind === "recovering" || task.kind === "recovery-failed")
      recoveries.push({
        kind: task.kind,
        task: task.id,
        failedAt: task.failedAt,
        phase: task.recovery.phase,
        startedAt: task.recovery.startedAt,
        handling: task.recovery.handling,
        resource: task.recovery.resource,
        storage: task.recovery.storage,
      });
  }
  return {
    production: productionView(run, results),
    inspections: inspectionViews(run),
    totals: results.reported,
    time: run.position.time,
    horizon: run.position.horizon,
    controlRevision: run.position.controlRevision,
    events: run.events.length,
    status: {
      kind: run.status.kind,
      need:
        run.status.kind === "awaiting-execution" ? run.status.need.kind : null,
    },
    cells,
    recoveries,
    logistics: logisticsView(run),
    schedulingHistory: results.schedulingHistory,
    storageHistory: results.storageHistory,
    materialStorageHistory: results.materialStorageHistory,
    resourceHistory: {
      kind: "available",
      version: 1,
      after: 0,
      through: run.position.time,
      resources: results.resources,
    },
  };
}

function object(raw: unknown): Record<string, unknown> {
  d.requireValue(isRecord(raw));
  return raw;
}

function readAttempt(
  raw: unknown,
): NonNullable<HostView["cells"][number]["attempt"]> {
  const r = object(raw);
  return {
    id: d.text(r.id),
    steps: d.natural(r.steps),
    lifecycle: d.text(r.lifecycle),
  };
}

function readCell(raw: unknown): HostView["cells"][number] {
  const r = object(raw);
  return {
    id: d.text(r.id),
    carrier: d.nullable(r.carrier, d.text),
    boundary: d.natural(r.boundary),
    checkpoint: d.digest(r.checkpoint),
    steps: d.natural(r.steps),
    hold: d.choice(r.hold, "evolving", "settled", "unresolved"),
    attempt: d.nullable(r.attempt, readAttempt),
  };
}

function readRecovery(raw: unknown): RecoveryView {
  const r = object(raw);
  const task = d.text(r.task);
  const failedAt = d.natural(r.failedAt);
  const kind = d.choice(
    r.kind,
    "recovery-required",
    "recovering",
    "recovery-failed",
  );
  if (kind === "recovery-required")
    return { kind, task, failedAt, contents: readRecoveryContents(r.contents) };
  return {
    kind,
    task,
    failedAt,
    phase: d.choice(r.phase, "handling", "returning"),
    startedAt: d.natural(r.startedAt),
    handling: d.positive(r.handling),
    resource: d.text(r.resource),
    storage: d.text(r.storage),
  };
}

/** Decode once at the worker boundary; tolerate additive protocol fields. */
export function parseHostView(raw: unknown) {
  try {
    const r = object(raw);
    const status = object(r.status);
    const view: HostView = {
      production: readProductionView(r.production),
      inspections:
        r.inspections === undefined
          ? []
          : d.array(r.inspections, readInspectionView),
      totals: r.totals === undefined ? [] : d.array(r.totals, readTotal),
      time: d.natural(r.time),
      horizon: d.natural(r.horizon),
      controlRevision: d.natural(r.controlRevision),
      events: d.natural(r.events),
      status: {
        kind: d.choice(
          status.kind,
          "ready",
          "pause-requested",
          "advancing",
          "awaiting-execution",
          "awaiting-inspection",
          "paused",
          "blocked",
          "completed",
          "stopped-at-limit",
        ),
        need: d.nullable(status.need, d.text),
      },
      cells: d.array(r.cells, readCell),
      // Earlier retained protocol-1 bundles predate recovery. They expose no
      // recovery controls, but their saved nominal runs can still continue.
      recoveries:
        r.recoveries === undefined ? [] : d.array(r.recoveries, readRecovery),
      logistics: readLogisticsView(r.logistics),
      resourceHistory: readResourceHistory(r.resourceHistory),
      storageHistory: readStorageHistory(r.storageHistory),
      materialStorageHistory: readMaterialStorageHistory(
        r.materialStorageHistory,
      ),
      schedulingHistory: readSchedulingHistory(r.schedulingHistory),
    };
    if (view.resourceHistory.kind === "available")
      d.requireValue(view.resourceHistory.through === view.time);
    if (view.materialStorageHistory.kind === "available")
      d.requireValue(view.materialStorageHistory.through === view.time);
    if (view.storageHistory.kind === "available")
      d.requireValue(view.storageHistory.through === view.time);
    if (view.schedulingHistory.kind === "available")
      d.requireValue(view.schedulingHistory.through === view.time);
    return ok(view);
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_host_view" } as const);
    throw error;
  }
}
