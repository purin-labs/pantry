import type { StrictUnion } from "@seams/type-utils";
import type { LogisticsView } from "../../logistics-view.ts";
import type { ProductionReport } from "../../production-view.ts";
import type { ResourceHistoryView } from "../../resource-history-view.ts";
import type { CompiledScenario } from "../../scenario.ts";
import {
  clock,
  getActiveVitrineRushPreset,
  metrics as scheduleBatchMetrics,
  vitrineStockAt,
  type Run,
  type VitrineRushPresetId,
} from "./schedule.ts";
import { measureShift, type ShiftMetrics } from "./shift-metrics.ts";
import { SIX_HOUR_SHIFT_SECONDS } from "./shift-preset.ts";
import { buildShiftTaskTrace, type ShiftTrace } from "./shift-trace.ts";

export type VitrineShiftServiceMetrics = Readonly<{
  rushPreset: VitrineRushPresetId;
  rushPresetLabel: string;
  horizonSeconds: number;
  evaluatedAtSeconds: number;
  evaluatedAtClock: string;
  batchCount: number;
  lateBatchCount: number;
  unfinishedBatchCount: number;
  totalOrders: number;
  fulfilledOrders: number;
  waitingOrders: number;
  upcomingOrders: number;
  fulfillmentRatePercent: number;
  stockoutOrderCount: number;
  meanStockoutWaitSeconds: number;
  maxStockoutWaitSeconds: number;
  totalBeverageCups: number;
  servedBeverageCups: number;
  meanBeverageWaitSeconds: number;
  maxBeverageWaitSeconds: number;
  customArrivalCount: number;
}>;

function orderStockoutWaitSeconds(
  ord: {
    readonly orderedAt: number;
    readonly fulfilledAt: number | null;
    readonly status: string;
  },
  timeSeconds: number,
): number {
  if (ord.fulfilledAt !== null) {
    return Math.max(0, ord.fulfilledAt - ord.orderedAt);
  }
  if (ord.status === "waiting-refill") {
    return Math.max(0, timeSeconds - ord.orderedAt);
  }
  return 0;
}

export function summarizeVitrineShiftService(
  run: Run,
  timeSeconds: number = run.end,
  preset: VitrineRushPresetId = getActiveVitrineRushPreset(),
): VitrineShiftServiceMetrics {
  const stock = vitrineStockAt(run, timeSeconds, preset);
  const runMetrics = scheduleBatchMetrics(run);
  const delayedOrders = stock.orders.filter(
    (ord) =>
      orderStockoutWaitSeconds(ord, timeSeconds) > 0 ||
      ord.status === "waiting-refill",
  );
  const totalStockoutWait = delayedOrders.reduce(
    (acc, ord) => acc + orderStockoutWaitSeconds(ord, timeSeconds),
    0,
  );
  const maxStockoutWaitSeconds = stock.orders.reduce(
    (max, ord) => Math.max(max, orderStockoutWaitSeconds(ord, timeSeconds)),
    0,
  );
  const totalBeverageWait = stock.orders.reduce(
    (acc, ord) => acc + ord.beverageWaitSeconds,
    0,
  );
  return {
    rushPreset: stock.rushPreset,
    rushPresetLabel: stock.rushPresetLabel,
    horizonSeconds: run.end,
    evaluatedAtSeconds: timeSeconds,
    evaluatedAtClock: clock(timeSeconds),
    batchCount: run.batches.length,
    lateBatchCount: runMetrics.late,
    unfinishedBatchCount: runMetrics.unfinished,
    totalOrders: stock.orders.length,
    fulfilledOrders: stock.fulfilledOrders.length,
    waitingOrders: stock.waitingOrders.length,
    upcomingOrders: stock.upcomingOrders.length,
    fulfillmentRatePercent:
      stock.orders.length === 0
        ? 100
        : Math.round((1000 * stock.fulfilledOrders.length) / stock.orders.length) /
          10,
    stockoutOrderCount: delayedOrders.length,
    meanStockoutWaitSeconds:
      delayedOrders.length === 0
        ? 0
        : Math.round((10 * totalStockoutWait) / delayedOrders.length) / 10,
    maxStockoutWaitSeconds,
    totalBeverageCups: stock.totalBeverageCups,
    servedBeverageCups: stock.servedBeverageCups,
    meanBeverageWaitSeconds:
      stock.orders.length === 0
        ? 0
        : Math.round((10 * totalBeverageWait) / stock.orders.length) / 10,
    maxBeverageWaitSeconds: stock.maxBeverageWaitSeconds,
    customArrivalCount: stock.customArrivalCount,
  };
}

export function exportVitrineShiftServiceJson(
  run: Run,
  timeSeconds: number = run.end,
  preset: VitrineRushPresetId = getActiveVitrineRushPreset(),
): string {
  const stock = vitrineStockAt(run, timeSeconds, preset);
  const summary = summarizeVitrineShiftService(run, timeSeconds, preset);
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      summary,
      orders: stock.orders.map((ord) => ({
        id: ord.id,
        channel: ord.channel,
        orderedAt: ord.orderedAt,
        orderedAtClock: clock(ord.orderedAt),
        status: ord.status,
        fulfilledAt: ord.fulfilledAt,
        fulfilledAtClock:
          ord.fulfilledAt !== null ? clock(ord.fulfilledAt) : null,
        waitSeconds: orderStockoutWaitSeconds(ord, timeSeconds),
        loosePieces: ord.loosePieces,
        ballotinBoxes: ord.ballotinBoxes,
        beverageRecipe: ord.beverageRecipe,
        beverageCount: ord.beverageCount,
        brewStart: ord.brewStart,
        brewEnd: ord.brewEnd,
        beverageWaitSeconds: ord.beverageWaitSeconds,
        beverageStatus: ord.beverageStatus,
        isCustomArrival: ord.isCustomArrival,
      })),
    },
    null,
    2,
  )}\n`;
}

export function exportVitrineShiftServiceCsv(
  run: Run,
  timeSeconds: number = run.end,
  preset: VitrineRushPresetId = getActiveVitrineRushPreset(),
): string {
  const stock = vitrineStockAt(run, timeSeconds, preset);
  const summary = summarizeVitrineShiftService(run, timeSeconds, preset);
  const header = [
    "# rush_preset",
    "evaluated_at_clock",
    "fulfillment_rate_pct",
    "fulfilled_orders",
    "total_orders",
    "stockout_orders",
    "mean_stockout_wait_s",
    "max_stockout_wait_s",
    "served_beverage_cups",
    "total_beverage_cups",
    "mean_bar_wait_s",
    "max_bar_wait_s",
  ].join(",");
  const summaryRow = [
    summary.rushPreset,
    summary.evaluatedAtClock,
    summary.fulfillmentRatePercent,
    summary.fulfilledOrders,
    summary.totalOrders,
    summary.stockoutOrderCount,
    summary.meanStockoutWaitSeconds,
    summary.maxStockoutWaitSeconds,
    summary.servedBeverageCups,
    summary.totalBeverageCups,
    summary.meanBeverageWaitSeconds,
    summary.maxBeverageWaitSeconds,
  ].join(",");
  const orderHeader = [
    "order_id",
    "channel",
    "ordered_at_clock",
    "status",
    "fulfilled_at_clock",
    "vitrine_wait_s",
    "loose_pieces",
    "ballotin_boxes",
    "beverage_recipe",
    "beverage_cups",
    "brew_start_clock",
    "brew_end_clock",
    "bar_wait_s",
    "beverage_status",
    "custom_arrival",
  ].join(",");
  const orderRows = stock.orders.map((ord) =>
    [
      ord.id,
      ord.channel,
      clock(ord.orderedAt),
      ord.status,
      ord.fulfilledAt !== null ? clock(ord.fulfilledAt) : "",
      orderStockoutWaitSeconds(ord, timeSeconds),
      ord.loosePieces,
      ord.ballotinBoxes,
      ord.beverageRecipe,
      ord.beverageCount,
      clock(ord.brewStart),
      clock(ord.brewEnd),
      ord.beverageWaitSeconds,
      ord.beverageStatus,
      ord.isCustomArrival ? "true" : "false",
    ].join(","),
  );
  return `${[header, summaryRow, orderHeader, ...orderRows].join("\n")}\n`;
}

export type ShiftReport = StrictUnion<
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{
      kind: "available";
      measurements: ShiftMetrics;
      trace: ShiftTrace;
    }>
>;

export function reportBakeryShift(
  scenario: CompiledScenario,
  logistics: LogisticsView,
  history: ResourceHistoryView,
  production: ProductionReport | null,
  timeUs: number,
  phase: ShiftMetrics["phase"],
): ShiftReport {
  if (
    scenario.id !== "bakery-shift" ||
    scenario.limits.horizon !== SIX_HOUR_SHIFT_SECONDS * 1e6
  )
    return { kind: "not-applicable" };
  if (logistics.kind !== "available" || production === null)
    return {
      kind: "unavailable",
      reason: "Accepted production records are unavailable",
    };
  return {
    kind: "available",
    measurements: measureShift(
      scenario,
      logistics,
      history,
      production,
      timeUs,
      phase,
    ),
    trace: buildShiftTaskTrace(logistics),
  };
}

export type {
  ShiftHour,
  ShiftMetric,
  MetricId,
  Measurement,
  MeasuredSixHourCarryover,
  MeasuredSixHourShift,
  MeasuredSixHourMetricComparison,
  MeasuredSixHourComparison,
} from "./shift-metrics.ts";

export {
  compareShiftMetric,
  blankMeasuredSixHourShiftTemplate,
  parseMeasuredSixHourShift,
  compareMeasuredSixHourShift,
} from "./shift-metrics.ts";
