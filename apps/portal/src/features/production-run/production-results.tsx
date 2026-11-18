import {
  blankMeasuredSixHourShiftTemplate,
  compareMeasuredSixHourShift,
  compareShiftMetric,
  parseMeasuredSixHourShift,
} from "@seams/production-simulation/recipes/bakery/shift-report";
import React from "react";
import type {
  ProductionReport,
  OrderResult,
  ReportedQuantity,
  StockBalance,
} from "@seams/production-simulation";
import type {
  ShiftReport,
  ShiftHour,
  ShiftMetric,
  Measurement,
  MeasuredSixHourShift,
  MeasuredSixHourMetricComparison,
} from "@seams/production-simulation/recipes/bakery/shift-report";
import { assertNever } from "@seams/std";
import { downloadBakeryFile } from "../workflow-simulator/file-download";
import { seconds } from "./oven-logistics";
import type { Variant } from "@seams/type-utils";

const MAX_SIX_HOUR_MEASUREMENT_BYTES = 1024 * 1024;

export function ProductionResults({
  time,
  results,
  shift,
}: Readonly<{
  time: number;
  results: ProductionReport | null;
  shift: ShiftReport;
}>): React.ReactNode {
  const [showDepletedStock, setShowDepletedStock] = React.useState(false);
  if (results === null)
    return (
      <p>This retained build does not expose order and material results.</p>
    );
  const sortedReported = [...results.reported].sort((a, b) => {
    const aActive = a.amount > 0 ? 0 : 1;
    const bActive = b.amount > 0 ? 0 : 1;
    return aActive - bActive;
  });
  const activeStock = results.stock.filter(
    (s) => s.remaining > 0 || s.held > 0,
  );
  const depletedStock = results.stock.filter(
    (s) => s.remaining === 0 && s.held === 0,
  );
  const visibleStock =
    showDepletedStock || activeStock.length === 0
      ? [...activeStock, ...depletedStock]
      : activeStock;
  return (
    <section
      aria-label="Production results"
      className="production-results-panel"
      data-time={time}
    >
      <div className="production-results-header">
        <div>
          <h3>Production results</h3>
          <p>
            From 0 to {seconds(time)} seconds. {results.ordersCompleted} orders
            completed. Open orders retain their original arrival time.
          </p>
        </div>
        <div className="production-results-pills">
          <span className="production-results-pill">
            Elapsed: <strong>{seconds(time)} s</strong>
          </span>
          <span className="production-results-pill">
            Completed orders: <strong>{results.ordersCompleted}</strong>
          </span>
          <span className="production-results-pill">
            Active stock: <strong>{activeStock.length}</strong>
          </span>
        </div>
      </div>
      <div className="oven-logistics-scroll" tabIndex={0}>
        <ShiftResults report={shift} />
        <div className="production-table-card">
          <table className="oven-workspace-cells production-data-table">
            <caption>Order lead times</caption>
            <thead>
              <tr>
                <th>Order</th>
                <th>State</th>
                <th className="num-col">Arrival (s)</th>
                <th className="num-col">Lead time or current age (s)</th>
              </tr>
            </thead>
            <tbody>
              {results.orders.length > 0 ? (
                results.orders.map(orderRow)
              ) : (
                <tr>
                  <td colSpan={4} className="production-empty-cell">
                    No customer or production orders recorded in this interval.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="production-table-card">
          <table className="oven-workspace-cells production-data-table">
            <caption>Reported output</caption>
            <thead>
              <tr>
                <th>Destination</th>
                <th>Role</th>
                <th>Product</th>
                <th className="num-col">Quantity</th>
                <th className="num-col">Per second</th>
              </tr>
            </thead>
            <tbody>
              {sortedReported.length > 0 ? (
                sortedReported.map(outputRow)
              ) : (
                <tr>
                  <td colSpan={5} className="production-empty-cell">
                    No reported output recorded in this interval.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="production-table-card">
          <table className="oven-workspace-cells production-data-table">
            <caption>Material in the factory</caption>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num-col">Remaining quantity</th>
                <th className="num-col">Held quantity</th>
              </tr>
            </thead>
            <tbody>
              {visibleStock.length > 0 ? (
                visibleStock.map(stockRow)
              ) : (
                <tr>
                  <td colSpan={3} className="production-empty-cell">
                    No remaining or held material recorded in this interval.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {activeStock.length > 0 && depletedStock.length > 0 ? (
            <div className="production-table-footer">
              <button
                type="button"
                className="secondary production-stock-toggle"
                onClick={() => setShowDepletedStock((prev) => !prev)}
              >
                {showDepletedStock
                  ? `Hide ${depletedStock.length} depleted materials (0 balance)`
                  : `Show ${depletedStock.length} depleted materials (0 balance)`}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
function orderDuration(order: OrderResult): string {
  switch (order.kind) {
    case "open":
      return `${seconds(order.age)} (current age)`;
    case "completed":
      return seconds(order.leadTime);
    case "failed":
      return `Failed at ${seconds(order.failedAt)}`;
    default:
      return assertNever(order);
  }
}
function orderRow(order: OrderResult): React.ReactNode {
  return (
    <tr key={order.instance} data-order={order.instance}>
      <td>{order.instance}</td>
      <td>
        <span className="production-order-badge" data-state={order.kind}>
          {order.kind}
        </span>
      </td>
      <td className="num-col">{seconds(order.arrivedAt)}</td>
      <td className="num-col">{orderDuration(order)}</td>
    </tr>
  );
}
function outputRow(total: ReportedQuantity): React.ReactNode {
  return (
    <tr
      key={total.destination}
      data-zero={total.amount === 0 ? "true" : undefined}
    >
      <td>{total.destination}</td>
      <td>{total.role}</td>
      <td>{total.product}</td>
      <td className="num-col">
        {total.amount} {total.unit}
      </td>
      <td className="num-col">
        {total.rate === null
          ? "No elapsed time"
          : `${total.rate.toFixed(6)} ${total.unit}/s`}
      </td>
    </tr>
  );
}
function stockRow(stock: StockBalance): React.ReactNode {
  const isZero = stock.remaining === 0 && stock.held === 0;
  return (
    <tr key={stock.product} data-zero={isZero ? "true" : undefined}>
      <td>{stock.product}</td>
      <td className="num-col">
        {stock.remaining} {stock.unit}
      </td>
      <td className="num-col">
        {stock.held} {stock.unit}
      </td>
    </tr>
  );
}
function measurementText(measurement: Measurement): string {
  if (measurement.kind === "unavailable")
    return `Unavailable: ${measurement.reason}`;
  return measurement.value.toFixed(2);
}

function ShiftResults({
  report,
}: Readonly<{ report: ShiftReport }>): React.ReactNode {
  if (report.kind === "not-applicable") return null;
  if (report.kind === "unavailable") return <p>{report.reason}</p>;
  const { measurements, trace } = report;
  const withinCount = measurements.metrics.filter(
    (m) => compareShiftMetric(m) === "within-assumption",
  ).length;
  const observedCount = measurements.metrics.filter(
    (m) => m.measurement.kind === "observed",
  ).length;
  return (
    <section
      aria-label="6-hour shift evidence"
      className="shift-evidence-panel"
    >
      <div className="shift-evidence-header">
        <div>
          <h4>6-hour shift evidence</h4>
          <p className="shift-evidence-subtitle">
            {measurements.phase === "complete"
              ? "Completed shift"
              : "Partial shift"}
            . Assumed timings / Uncalibrated. Reference ranges are planning
            assumptions.
          </p>
        </div>
        <div className="shift-evidence-badges">
          <span
            className="shift-band-badge"
            data-band={
              measurements.phase === "complete"
                ? "within-assumption"
                : "unavailable"
            }
          >
            {measurements.phase === "complete"
              ? "Completed shift"
              : "Partial shift"}
          </span>
          <span className="shift-band-badge" data-band="outside-assumption">
            Assumed timings / Uncalibrated
          </span>
          <span className="shift-band-badge" data-band="unavailable">
            {observedCount === 0
              ? `0 / ${measurements.metrics.length} observed`
              : `${withinCount} / ${measurements.metrics.length} in assumed range`}
          </span>
        </div>
      </div>
      <div className="shift-evidence-table">
        <table className="oven-workspace-cells shift-hourly-table">
          <caption>Hourly task activity</caption>
          <thead>
            <tr>
              <th>Hour</th>
              <th className="num-col">Starts</th>
              <th className="num-col">Completions</th>
              <th className="num-col">Worker busy (s)</th>
              <th className="num-col">Activity share (%)</th>
            </tr>
          </thead>
          <tbody>{measurements.hours.map(hourlySliceRow)}</tbody>
        </table>
      </div>
      <div className="shift-evidence-table">
        <table className="oven-workspace-cells shift-metrics-table">
          <caption>Observed metrics and assumed ranges</caption>
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num-col">Observed</th>
              <th className="num-col">Assumed range</th>
              <th>Comparison</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>{measurements.metrics.map(metricRow)}</tbody>
        </table>
      </div>
      <div className="shift-trace-card">
        <h4>Accepted task dependency trace</h4>
        {trace.kind === "unavailable" ? (
          <p className="shift-trace-empty">{trace.reason}</p>
        ) : (
          <p className="shift-trace-summary">
            <strong>{trace.nodes.length}</strong> recorded task events and{" "}
            <strong>{trace.edges.length}</strong> execution and prerequisite
            links. This view has no lot lineage or appliance recovery evidence.
          </p>
        )}
      </div>
      <SixHourMeasuredShiftPanel
        key={`${measurements.phase}-${measurements.elapsedSeconds}-${observedCount}`}
        measurements={measurements}
      />
    </section>
  );
}

type SixHourImportState =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "ready"; shift: MeasuredSixHourShift }>;

class SixHourMeasuredShiftPanel extends React.Component<
  Readonly<{
    measurements: Variant<ShiftReport, "available">["measurements"];
  }>,
  Readonly<{ imported: SixHourImportState }>
> {
  state: Readonly<{ imported: SixHourImportState }> = {
    imported: { kind: "empty" },
  };

  private downloadTemplate(): void {
    downloadBakeryFile(
      "six-hour-measured-shift.json",
      `${JSON.stringify(blankMeasuredSixHourShiftTemplate(), null, 2)}\n`,
      "application/json;charset=utf-8",
    );
  }

  private async importFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    if (file.size > MAX_SIX_HOUR_MEASUREMENT_BYTES) {
      this.setState({
        imported: {
          kind: "invalid",
          message:
            "Choose a 6-hour measured-shift JSON file smaller than 1 MiB.",
        },
      });
      return;
    }
    this.setState({ imported: { kind: "reading" } });
    try {
      const parsed = parseMeasuredSixHourShift(await file.text());
      this.setState({
        imported: parsed.ok
          ? { kind: "ready", shift: parsed.value }
          : { kind: "invalid", message: parsed.error },
      });
    } catch {
      this.setState({
        imported: {
          kind: "invalid",
          message: "The 6-hour measured-shift file could not be read.",
        },
      });
    }
  }

  render(): React.ReactNode {
    const { imported } = this.state;
    const comparison =
      imported.kind === "ready"
        ? compareMeasuredSixHourShift(this.props.measurements, imported.shift)
        : null;
    return (
      <section
        aria-label="6-hour shop shift comparison"
        className="shift-measured"
      >
        <h4>6-hour shop shift comparison</h4>
        <p>
          Compare observed shop metrics and carryover counts with this simulated
          shift. The file stays in this browser tab.
        </p>
        <div className="shift-measured-actions">
          <label className="shift-measured-import">
            Import measured 6-hour shift JSON
            <input
              aria-label="Import measured 6-hour shift JSON"
              className="visually-hidden"
              type="file"
              accept=".json,application/json"
              onChange={this.importFile.bind(this)}
            />
          </label>
          <button
            className="secondary"
            type="button"
            onClick={this.downloadTemplate.bind(this)}
          >
            Download blank 6-hour measurement template
          </button>
        </div>
        {imported.kind === "reading" ? (
          <p role="status">Reading 6-hour shop measurements…</p>
        ) : null}
        {imported.kind === "invalid" ? (
          <p role="alert">{imported.message} Current results are unchanged.</p>
        ) : null}
        {comparison !== null ? (
          <div aria-live="polite" className="shift-measured-result">
            <dl className="shift-measured-facts">
              <div>
                <dt>Site</dt>
                <dd>{comparison.site}</dd>
              </div>
              <div>
                <dt>Shift</dt>
                <dd>{comparison.shiftId}</dd>
              </div>
              <div>
                <dt>Start</dt>
                <dd>{startText(comparison.startTime)}</dd>
              </div>
              <div>
                <dt>Reorder threshold</dt>
                <dd>{comparison.carryover.reorderThresholdUnits} units</dd>
              </div>
              <div>
                <dt>Opening shelf</dt>
                <dd>{comparison.carryover.openingRetailUnits} units</dd>
              </div>
              <div>
                <dt>Ending shelf</dt>
                <dd>{comparison.carryover.endingRetailUnits} units</dd>
              </div>
              <div>
                <dt>Max cold hold</dt>
                <dd>
                  {comparison.carryover.maxRefrigeratedHoldHoursObserved} h
                </dd>
              </div>
            </dl>
            <p className="shift-measured-limit">
              {comparison.calibrationStatus}.
            </p>
            <div className="shift-measured-table" tabIndex={0}>
              <table className="oven-workspace-cells">
                <caption>
                  6-hour shop shift observation against simulated run
                </caption>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th className="num-col">Shop observed</th>
                    <th className="num-col">Simulated</th>
                    <th className="num-col">Signed error (sim − shop)</th>
                    <th>Shop vs assumed band</th>
                  </tr>
                </thead>
                <tbody>{comparison.metrics.map(measuredMetricRow)}</tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>
    );
  }
}

/** A shop value with its unit; a long time reads in hours and minutes. */
function measuredText(measurement: Measurement, unit: string): string {
  return measurement.kind === "unavailable"
    ? measurementText(measurement)
    : quantityText(measurement.value, unit);
}

/** Simulated minus shop; a value that rounds to zero has no sign. */
function signedText(error: number, unit: string): string {
  const text = quantityText(error, unit);
  return error > 0 && text !== quantityText(0, unit) ? `+${text}` : text;
}

function quantityText(value: number, unit: string): string {
  const rounded = Math.round(value * 100) / 100;
  if (unit === "s" && Math.abs(rounded) >= 60) {
    const sign = rounded < 0 ? "-" : "";
    const total = Math.round(Math.abs(rounded));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours > 0
      ? `${sign}${String(hours)} h ${String(minutes)} min`
      : `${sign}${String(minutes)} min ${String(total % 60)} s`;
  }
  // -0.001 rounds to -0, which toFixed writes as "-0.00".
  return `${(rounded === 0 ? 0 : rounded).toFixed(2)} ${unit}`;
}

/**
 * The shift's start as the file writes it, in the shop's own date and time and
 * not moved to this browser's time zone.
 */
function startText(start: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(start);
  if (parts === null) return start === "" ? "Not given" : start;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  return new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0),
  ).toLocaleString(undefined, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function measuredMetricRow(
  item: MeasuredSixHourMetricComparison,
): React.ReactNode {
  return (
    <tr key={item.id} data-measured-metric={item.id}>
      <td>{item.label}</td>
      <td
        className={
          item.shopObserved.kind === "observed" ? "num-col" : "unavailable-col"
        }
      >
        {measuredText(item.shopObserved, item.unit)}
      </td>
      <td
        className={
          item.simulated.kind === "observed" ? "num-col" : "unavailable-col"
        }
      >
        {measuredText(item.simulated, item.unit)}
      </td>
      <td className="num-col">
        {item.signedError === null
          ? "Unavailable"
          : signedText(item.signedError, item.unit)}
      </td>
      <td data-band={item.shopBandStatus}>
        <span className="shift-band-badge" data-band={item.shopBandStatus}>
          {bandStatusLabel(item.shopBandStatus)}
        </span>
      </td>
    </tr>
  );
}

function bandStatusLabel(
  status: MeasuredSixHourMetricComparison["shopBandStatus"],
): string {
  switch (status) {
    case "within-assumption":
      return "Within assumed range";
    case "outside-assumption":
      return "Outside assumed range";
    case "unavailable":
      return "Unavailable";
  }
}
function hourlySliceRow(hour: ShiftHour): React.ReactNode {
  return (
    <tr key={hour.hour}>
      <td>Hour {hour.hour}</td>
      <td className="num-col">{hour.starts}</td>
      <td className="num-col">{hour.completions}</td>
      <td className="num-col">{hour.workerBusySeconds.toFixed(1)}</td>
      <td
        className={
          hour.actionShare.kind === "observed" ? "num-col" : "unavailable-col"
        }
      >
        {measurementText(hour.actionShare)}
      </td>
    </tr>
  );
}
function metricRow(metric: ShiftMetric): React.ReactNode {
  const status = compareShiftMetric(metric);
  return (
    <tr key={metric.id} data-metric={metric.id}>
      <td>{metric.label}</td>
      <td
        className={
          metric.measurement.kind === "observed" ? "num-col" : "unavailable-col"
        }
      >
        {measurementText(metric.measurement)}{" "}
        {metric.measurement.kind === "observed" ? metric.unit : ""}
      </td>
      <td className="num-col">
        {metric.lower}–{metric.upper} {metric.unit}
      </td>
      <td data-band={status}>
        <span className="shift-band-badge" data-band={status}>
          {comparisonLabel(metric)}
        </span>
      </td>
      <td className="basis-col">{metric.basis}</td>
    </tr>
  );
}

function comparisonLabel(metric: ShiftMetric): string {
  switch (compareShiftMetric(metric)) {
    case "within-assumption":
      return "Within assumed range";
    case "outside-assumption":
      return "Outside assumed range";
    case "unavailable":
      return "Unavailable";
  }
}
