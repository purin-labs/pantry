import { isRecord } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import type { LogisticsView, TaskView } from "../../logistics-view.ts";
import type { ProductionReport } from "../../production-view.ts";
import type { ResourceHistoryView } from "../../resource-history-view.ts";
import { err, ok, type Result } from "../../result.ts";
import type { CompiledScenario } from "../../scenario.ts";
import { SIX_HOUR_SHIFT_SECONDS } from "./shift-preset.ts";

export type Measurement = StrictUnion<
  | Readonly<{ kind: "observed"; value: number; sampleCount: number }>
  | Readonly<{ kind: "unavailable"; reason: string }>
>;

export type MetricId =
  | "shift-span-seconds"
  | "financier-bake-duration-seconds"
  | "financier-cool-in-mould-seconds"
  | "financier-demould-seconds"
  | "financier-pack-seconds"
  | "worker-walk-transition-seconds"
  | "drink-order-mean-wait-seconds"
  | "drink-order-p95-wait-seconds"
  | "baker-utilization-percent"
  | "barista-utilization-percent"
  | "mould-reuse-ratio"
  | "saleable-financier-share-percent";

type Reference = Readonly<{
  id: MetricId;
  label: string;
  unit: string;
  lower: number;
  upper: number;
  basis: string;
}>;

// Planning assumptions, not observed population percentiles. Do not adjust
// observations or these ranges to make an acceptance journey pass.
const REFERENCES: readonly Reference[] = [
  {
    id: "shift-span-seconds",
    label: "Completed shift duration",
    unit: "s",
    lower: 0,
    upper: SIX_HOUR_SHIFT_SECONDS,
    basis: "Six-hour execution limit",
  },
  {
    id: "financier-bake-duration-seconds",
    label: "Mean financier bake duration",
    unit: "s",
    lower: 900,
    upper: 1080,
    basis: "Provisional recipe range in the Plan 42 worksheet",
  },
  {
    id: "financier-cool-in-mould-seconds",
    label: "Mean cooling duration in mould",
    unit: "s",
    lower: 150,
    upper: 300,
    basis: "Scenario assumption; physical measurement required",
  },
  {
    id: "financier-demould-seconds",
    label: "Mean demould duration",
    unit: "s",
    lower: 20,
    upper: 300,
    basis: "Scenario assumption; physical measurement required",
  },
  {
    id: "financier-pack-seconds",
    label: "Mean packing duration per tray",
    unit: "s",
    lower: 45,
    upper: 180,
    basis: "Scenario assumption; physical measurement required",
  },
  {
    id: "worker-walk-transition-seconds",
    label: "Mean worker travel duration",
    unit: "s",
    lower: 4,
    upper: 21,
    basis: "Assumed layout and walk speed",
  },
  {
    id: "drink-order-mean-wait-seconds",
    label: "Mean drink service time",
    unit: "s",
    lower: 0,
    upper: 900,
    basis: "Plan 61E service target; excludes unfinished orders",
  },
  {
    id: "drink-order-p95-wait-seconds",
    label: "P95 drink service time",
    unit: "s",
    lower: 0,
    upper: 1200,
    basis:
      "Scenario service target; nearest-rank statistic of completed drinks",
  },
  {
    id: "baker-utilization-percent",
    label: "Baker occupied share",
    unit: "%",
    lower: 40,
    upper: 92,
    basis: "Planning assumption; occupied time divided by elapsed shift time",
  },
  {
    id: "barista-utilization-percent",
    label: "Barista occupied share",
    unit: "%",
    lower: 30,
    upper: 88,
    basis: "Planning assumption; occupied time divided by elapsed shift time",
  },
  {
    id: "mould-reuse-ratio",
    label: "Mould returns per carrier",
    unit: "x",
    lower: 3,
    upper: 8,
    basis:
      "Scenario assumption; completed returns divided by actual mould count",
  },
  {
    id: "saleable-financier-share-percent",
    label: "Saleable financier piece share",
    unit: "%",
    lower: 82,
    upper: 100,
    basis:
      "Packed pieces divided by packed plus rejected pieces; excludes samples",
  },
];

export type ShiftMetric = Reference &
  Readonly<{
    measurement: Measurement;
  }>;

export type ShiftHour = Readonly<{
  hour: number;
  starts: number;
  completions: number;
  workerBusySeconds: number;
  actionShare: Measurement;
}>;

export type ShiftMetrics = Readonly<{
  phase: "partial" | "complete";
  elapsedSeconds: number;
  hours: readonly ShiftHour[];
  metrics: readonly ShiftMetric[];
}>;

function observed(value: number, sampleCount: number): Measurement {
  return { kind: "observed", value, sampleCount };
}

function unavailable(reason: string): Measurement {
  return { kind: "unavailable", reason };
}

function sum(total: number, value: number): number {
  return total + value;
}

function ascending(left: number, right: number): number {
  return left - right;
}

function mean(values: readonly number[]): Measurement {
  if (values.length === 0) return unavailable("No completed observations");
  return observed(values.reduce(sum, 0) / values.length, values.length);
}

function percentile(values: readonly number[], percent: number): Measurement {
  if (values.length === 0) return unavailable("No completed observations");
  const sorted = [...values].sort(ascending);
  const value = sorted[Math.ceil((percent * sorted.length) / 100) - 1];
  if (value === undefined) return unavailable("No percentile observation");
  return observed(value, values.length);
}

function taskDurations(tasks: readonly TaskView[], key: string): number[] {
  const durations: number[] = [];
  for (const task of tasks) {
    if (
      task.kind === "completed" &&
      task.subject.kind === "workflow" &&
      task.subject.key === key
    ) {
      durations.push((task.completedAt - task.startedAt) / 1e6);
    }
  }
  return durations;
}

function reportedQuantity(
  results: ProductionReport,
  destination: string,
): Measurement {
  for (const quantity of results.reported) {
    if (quantity.destination === destination)
      return observed(quantity.amount, 1);
  }
  return unavailable(`No quantity report for ${destination}`);
}

function occupiedShare(
  history: ResourceHistoryView,
  worker: string,
  elapsedSeconds: number,
): Measurement {
  if (
    history.kind !== "available" ||
    history.after !== 0 ||
    history.through / 1e6 !== elapsedSeconds
  ) {
    return unavailable(
      "Resource history does not cover this reporting interval",
    );
  }
  for (const resource of history.resources) {
    if (resource.resource !== worker) continue;
    if (resource.capacityUnitSeconds <= 0)
      return unavailable("No elapsed capacity time");
    return observed(
      (100 * resource.occupiedUnitSeconds) / resource.capacityUnitSeconds,
      resource.intervals.length,
    );
  }
  return unavailable(`No resource history for ${worker}`);
}

function drinkWaits(
  scenario: CompiledScenario,
  logistics: LogisticsView & { kind: "available" },
  results: ProductionReport,
): number[] {
  const finishes = new Map<string, number>();
  const workflowBySource = new Map<string, string>();
  for (const source of scenario.arrivals)
    workflowBySource.set(source.id, source.workflow);
  for (const task of logistics.tasks) {
    if (task.kind !== "completed" || task.subject.kind !== "workflow") continue;
    const source = task.subject.instance.split("#")[0];
    if (source === undefined) continue;
    const workflow = workflowBySource.get(source);
    if (workflow === undefined) continue;
    const key = task.subject.key;
    if (
      (workflow === "sesame-drink" && key === "pour-and-serve") ||
      (workflow === "ginger-tea-batch" && key === "serve-or-discard") ||
      (workflow === "ginger-milk-tea-batch" && key === "serve-milk-tea") ||
      (workflow === "espresso-orders" && key === "extract-espresso") ||
      (workflow === "pour-over-brew" && key === "serve-pour-over-and-rinse")
    )
      finishes.set(task.subject.instance, task.completedAt);
  }
  const waits: number[] = [];
  for (const order of results.orders) {
    const finish = finishes.get(order.instance);
    if (order.kind === "completed" && finish !== undefined)
      waits.push((finish - order.arrivedAt) / 1e6);
  }
  return waits;
}

function hourlyActivity(
  tasks: readonly TaskView[],
  history: ResourceHistoryView,
): readonly ShiftHour[] {
  const hours = [];
  let totalActions = 0;
  for (let hour = 1; hour <= 6; hour++) {
    const start = (hour - 1) * 3600e6;
    const end = hour * 3600e6;
    let starts = 0;
    let completions = 0;
    let workerBusySeconds = 0;
    for (const task of tasks) {
      if (
        "startedAt" in task &&
        task.startedAt !== undefined &&
        task.startedAt >= start &&
        task.startedAt < end
      )
        starts++;
      if (
        task.kind === "completed" &&
        task.completedAt >= start &&
        (task.completedAt < end || (hour === 6 && task.completedAt === end))
      )
        completions++;
    }
    if (history.kind === "available") {
      for (const resource of history.resources) {
        if (resource.resource !== "baker" && resource.resource !== "barista")
          continue;
        for (const span of resource.intervals) {
          if (
            span.kind === "occupied" ||
            span.kind === "handling" ||
            span.kind === "travel" ||
            span.kind === "changeover"
          ) {
            workerBusySeconds +=
              Math.max(
                0,
                Math.min(end, span.end) - Math.max(start, span.start),
              ) / 1e6;
          }
        }
      }
    }
    hours.push({ hour, starts, completions, workerBusySeconds });
    totalActions += starts + completions;
  }
  const result: ShiftHour[] = [];
  for (const hour of hours)
    result.push({
      ...hour,
      actionShare:
        totalActions === 0
          ? unavailable("No task activity")
          : observed(
              (100 * (hour.starts + hour.completions)) / totalActions,
              hour.starts + hour.completions,
            ),
    });
  return result;
}

export function measureShift(
  scenario: CompiledScenario,
  logistics: LogisticsView & { kind: "available" },
  history: ResourceHistoryView,
  results: ProductionReport,
  timeUs: number,
  phase: ShiftMetrics["phase"],
): ShiftMetrics {
  const elapsedSeconds = timeUs / 1e6;
  const values = new Map<MetricId, Measurement>();
  values.set(
    "shift-span-seconds",
    phase === "complete" && logistics.tasks.length > 0
      ? observed(elapsedSeconds, 1)
      : unavailable("The shift is incomplete"),
  );
  values.set(
    "financier-bake-duration-seconds",
    mean(taskDurations(logistics.tasks, "bake")),
  );
  values.set(
    "financier-cool-in-mould-seconds",
    mean(taskDurations(logistics.tasks, "cool-in-mould")),
  );
  values.set(
    "financier-demould-seconds",
    mean(taskDurations(logistics.tasks, "demould")),
  );
  values.set(
    "financier-pack-seconds",
    mean(taskDurations(logistics.tasks, "finish-product")),
  );
  const walks: number[] = [];
  if (history.kind === "available") {
    for (const resource of history.resources) {
      if (resource.resource !== "baker" && resource.resource !== "barista")
        continue;
      for (const span of resource.intervals)
        if (span.kind === "travel") walks.push((span.end - span.start) / 1e6);
    }
  }
  values.set("worker-walk-transition-seconds", mean(walks));
  const waits = drinkWaits(scenario, logistics, results);
  values.set("drink-order-mean-wait-seconds", mean(waits));
  values.set("drink-order-p95-wait-seconds", percentile(waits, 95));
  values.set(
    "baker-utilization-percent",
    occupiedShare(history, "baker", elapsedSeconds),
  );
  values.set(
    "barista-utilization-percent",
    occupiedShare(history, "barista", elapsedSeconds),
  );
  let moulds = 0;
  for (const carrier of scenario.carriers)
    if (carrier.id.startsWith("mould-")) moulds++;
  const returns = taskDurations(logistics.tasks, "return-mould");
  values.set(
    "mould-reuse-ratio",
    moulds > 0 && returns.length > 0
      ? observed(returns.length / moulds, returns.length)
      : unavailable("No completed mould returns"),
  );
  const packed = reportedQuantity(results, "packed-pieces");
  const rejected = reportedQuantity(results, "rejected-pieces");
  values.set(
    "saleable-financier-share-percent",
    packed.kind === "observed" &&
      rejected.kind === "observed" &&
      packed.value + rejected.value > 0
      ? observed(
          (100 * packed.value) / (packed.value + rejected.value),
          packed.value + rejected.value,
        )
      : unavailable("Packed and rejected piece counts are required"),
  );
  const metrics: ShiftMetric[] = [];
  for (const reference of REFERENCES) {
    const measurement =
      values.get(reference.id) ?? unavailable("No observation");
    metrics.push({ ...reference, measurement });
  }
  return {
    phase,
    elapsedSeconds,
    hours: hourlyActivity(logistics.tasks, history),
    metrics,
  };
}

export type ShiftCohort = StrictUnion<
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{
      kind: "observed";
      runCount: number;
      metrics: readonly Readonly<{
        id: MetricId;
        minimum: number;
        median: number;
        maximum: number;
      }>[];
    }>
>;

/** A sensitivity comparison of explicit variants, not a population estimate. */
export function compareShiftCohort(
  reports: readonly ShiftMetrics[],
): ShiftCohort {
  if (reports.length === 0)
    return { kind: "unavailable", reason: "No completed runs" };
  const metrics = [];
  for (const reference of REFERENCES) {
    const samples: number[] = [];
    for (const report of reports) {
      if (report.phase !== "complete")
        return { kind: "unavailable", reason: "A run is incomplete" };
      for (const metric of report.metrics)
        if (
          metric.id === reference.id &&
          metric.measurement.kind === "observed"
        )
          samples.push(metric.measurement.value);
    }
    if (samples.length !== reports.length)
      return {
        kind: "unavailable",
        reason: `Missing observations for ${reference.id}`,
      };
    const median = percentile(samples, 50);
    if (median.kind === "unavailable") return median;
    metrics.push({
      id: reference.id,
      minimum: Math.min(...samples),
      median: median.value,
      maximum: Math.max(...samples),
    });
  }
  return { kind: "observed", runCount: reports.length, metrics };
}

export function compareShiftMetric(
  metric: ShiftMetric,
): "within-assumption" | "outside-assumption" | "unavailable" {
  if (metric.measurement.kind === "unavailable") return "unavailable";
  return metric.measurement.value >= metric.lower &&
    metric.measurement.value <= metric.upper
    ? "within-assumption"
    : "outside-assumption";
}

export type MeasuredSixHourCarryover = Readonly<{
  reorderThresholdUnits: number;
  openingRetailUnits: number;
  endingRetailUnits: number;
  maxRefrigeratedHoldHoursObserved: number;
}>;

export type MeasuredSixHourShift = Readonly<{
  kind: "bakery-six-hour-measured-shift";
  schemaVersion: 1;
  shiftId: string;
  site: string;
  startTime: string;
  operatorId: string;
  measurementMethod: string;
  evidenceRef: string;
  recipeRevision: string;
  metrics: Readonly<Record<MetricId, Measurement>>;
  carryover: MeasuredSixHourCarryover;
}>;

export type MeasuredSixHourMetricComparison = Readonly<{
  id: MetricId;
  label: string;
  unit: string;
  lower: number;
  upper: number;
  shopObserved: Measurement;
  simulated: Measurement;
  signedError: number | null;
  shopBandStatus: "within-assumption" | "outside-assumption" | "unavailable";
}>;

export type MeasuredSixHourComparison = Readonly<{
  shiftId: string;
  site: string;
  startTime: string;
  operatorId: string;
  evidenceRef: string;
  calibrationStatus: "Assumed timings / Uncalibrated (single-shift comparison; separate fitting and validation runs required)";
  carryover: MeasuredSixHourCarryover;
  metrics: readonly MeasuredSixHourMetricComparison[];
}>;

export function blankMeasuredSixHourShiftTemplate(): Record<string, unknown> {
  const metrics: Record<string, Measurement> = {};
  for (const reference of REFERENCES) {
    metrics[reference.id] = {
      kind: "unavailable",
      reason: "Awaiting shop observation",
    };
  }
  return {
    kind: "bakery-six-hour-measured-shift",
    schemaVersion: 1,
    shiftId: "",
    site: "",
    startTime: "",
    operatorId: "",
    measurementMethod: "",
    evidenceRef: "",
    recipeRevision: "",
    metrics,
    carryover: {
      reorderThresholdUnits: 4,
      openingRetailUnits: 0,
      endingRetailUnits: 0,
      maxRefrigeratedHoldHoursObserved: 0,
    },
  };
}

function requiredText(value: unknown, field: string): Result<string, string> {
  if (typeof value !== "string" || value.trim().length === 0)
    return err(`Record ${field} in the 6-hour measurement file.`);
  return ok(value.trim());
}

function parseMeasurementEntry(
  raw: unknown,
  reference: Reference,
): Result<Measurement, string> {
  if (!isRecord(raw) || typeof raw.kind !== "string")
    return err(`Metric ${reference.id} must be an observed or unavailable record.`);
  if (raw.kind === "unavailable") {
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0)
      return err(`Metric ${reference.id} requires an unavailable reason.`);
    return ok({ kind: "unavailable", reason: raw.reason.trim() });
  }
  if (raw.kind !== "observed")
    return err(`Metric ${reference.id} has unknown kind ${raw.kind}.`);
  if (
    typeof raw.value !== "number" ||
    !Number.isFinite(raw.value) ||
    raw.value < 0 ||
    (reference.unit === "%" && raw.value > 100) ||
    typeof raw.sampleCount !== "number" ||
    !Number.isInteger(raw.sampleCount) ||
    raw.sampleCount < 1
  ) {
    return err(
      `Metric ${reference.id} requires a non-negative value and integer sampleCount >= 1.`,
    );
  }
  return ok({
    kind: "observed",
    value: raw.value,
    sampleCount: raw.sampleCount,
  });
}

export function parseMeasuredSixHourShift(
  text: string,
): Result<MeasuredSixHourShift, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err("Choose a valid 6-hour measured-shift JSON file.");
  }
  if (
    !isRecord(raw) ||
    raw.kind !== "bakery-six-hour-measured-shift" ||
    raw.schemaVersion !== 1
  ) {
    return err(
      "Use a version 1 6-hour measured shift (kind: bakery-six-hour-measured-shift). Download the blank template and fill in shop observations.",
    );
  }
  const shiftId = requiredText(raw.shiftId, "shiftId");
  if (!shiftId.ok) return shiftId;
  const site = requiredText(raw.site, "site");
  if (!site.ok) return site;
  const operatorId = requiredText(raw.operatorId, "operatorId");
  if (!operatorId.ok) return operatorId;
  const measurementMethod = requiredText(
    raw.measurementMethod,
    "measurementMethod",
  );
  if (!measurementMethod.ok) return measurementMethod;
  const evidenceRef = requiredText(raw.evidenceRef, "evidenceRef");
  if (!evidenceRef.ok) return evidenceRef;
  const recipeRevision = requiredText(raw.recipeRevision, "recipeRevision");
  if (!recipeRevision.ok) return recipeRevision;
  if (
    typeof raw.startTime !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      raw.startTime,
    ) ||
    !Number.isFinite(Date.parse(raw.startTime))
  ) {
    return err("Use an ISO shift startTime with a timezone offset.");
  }
  if (!isRecord(raw.metrics))
    return err("Record the twelve 6-hour shift metrics.");
  const parsedMetrics = {} as Record<MetricId, Measurement>;
  let observedCount = 0;
  for (const reference of REFERENCES) {
    const entry = parseMeasurementEntry(raw.metrics[reference.id], reference);
    if (!entry.ok) return entry;
    if (entry.value.kind === "observed") observedCount++;
    parsedMetrics[reference.id] = entry.value;
  }
  if (observedCount === 0) {
    return err(
      "Record at least one observed shop metric before importing the template.",
    );
  }
  if (!isRecord(raw.carryover))
    return err("Record carryover and reorder threshold observations.");
  const {
    reorderThresholdUnits,
    openingRetailUnits,
    endingRetailUnits,
    maxRefrigeratedHoldHoursObserved,
  } = raw.carryover;
  if (
    typeof reorderThresholdUnits !== "number" ||
    !Number.isInteger(reorderThresholdUnits) ||
    reorderThresholdUnits < 0 ||
    reorderThresholdUnits > 16 ||
    typeof openingRetailUnits !== "number" ||
    !Number.isInteger(openingRetailUnits) ||
    openingRetailUnits < 0 ||
    typeof endingRetailUnits !== "number" ||
    !Number.isInteger(endingRetailUnits) ||
    endingRetailUnits < 0 ||
    typeof maxRefrigeratedHoldHoursObserved !== "number" ||
    !Number.isFinite(maxRefrigeratedHoldHoursObserved) ||
    maxRefrigeratedHoldHoursObserved <= 0 ||
    maxRefrigeratedHoldHoursObserved > 72
  ) {
    return err(
      "Check carryover values: reorderThresholdUnits (0..16), retail unit counts (>= 0), and maxRefrigeratedHoldHoursObserved (0 < hours <= 72).",
    );
  }
  return ok({
    kind: "bakery-six-hour-measured-shift",
    schemaVersion: 1,
    shiftId: shiftId.value,
    site: site.value,
    startTime: raw.startTime,
    operatorId: operatorId.value,
    measurementMethod: measurementMethod.value,
    evidenceRef: evidenceRef.value,
    recipeRevision: recipeRevision.value,
    metrics: parsedMetrics,
    carryover: {
      reorderThresholdUnits,
      openingRetailUnits,
      endingRetailUnits,
      maxRefrigeratedHoldHoursObserved,
    },
  });
}

export function compareMeasuredSixHourShift(
  simulated: ShiftMetrics,
  measured: MeasuredSixHourShift,
): MeasuredSixHourComparison {
  const simulatedById = new Map<MetricId, ShiftMetric>();
  for (const metric of simulated.metrics) simulatedById.set(metric.id, metric);
  const comparisons: MeasuredSixHourMetricComparison[] = [];
  for (const reference of REFERENCES) {
    const shopObserved = measured.metrics[reference.id];
    const simMetric = simulatedById.get(reference.id);
    const simulatedMeasurement: Measurement = simMetric?.measurement ?? {
      kind: "unavailable",
      reason: "Missing simulated metric",
    };
    const signedError =
      shopObserved.kind === "observed" &&
      simulatedMeasurement.kind === "observed"
        ? simulatedMeasurement.value - shopObserved.value
        : null;
    const shopBandStatus = compareShiftMetric({
      ...reference,
      measurement: shopObserved,
    });
    comparisons.push({
      id: reference.id,
      label: reference.label,
      unit: reference.unit,
      lower: reference.lower,
      upper: reference.upper,
      shopObserved,
      simulated: simulatedMeasurement,
      signedError,
      shopBandStatus,
    });
  }
  return {
    shiftId: measured.shiftId,
    site: measured.site,
    startTime: measured.startTime,
    operatorId: measured.operatorId,
    evidenceRef: measured.evidenceRef,
    calibrationStatus:
      "Assumed timings / Uncalibrated (single-shift comparison; separate fitting and validation runs required)",
    carryover: measured.carryover,
    metrics: comparisons,
  };
}
