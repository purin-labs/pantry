import React from "react";
import { batchTimeline, duration, finishDifference, largestWait } from "@purin-labs/production-simulation/simulator/demo";
import {
  clock,
  describe,
  exportVitrineShiftServiceCsv,
  exportVitrineShiftServiceJson,
  metrics,
  summarizeVitrineShiftService,
  type Batch,
  type Interval,
  type Run,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { downloadBakeryFile } from "./file-download";

type ComparisonProps = {
  readonly run: Run;
  readonly baseline: Run;
  readonly hasDraft: boolean;
  readonly onPinBaseline: () => void;
  readonly onInspect: (interval: Interval) => void;
};

export class RunComparison extends React.PureComponent<ComparisonProps> {
  render(): React.ReactNode {
    const { run, baseline, hasDraft, onPinBaseline } = this.props;
    const baselineMetrics = metrics(baseline);
    const currentMetrics = metrics(run);
    const baselineService = summarizeVitrineShiftService(baseline, baseline.end);
    const currentService = summarizeVitrineShiftService(run, run.end);
    const hasBaselineDiff =
      baseline.end !== run.end ||
      baseline.kind !== run.kind ||
      baselineMetrics.late !== currentMetrics.late ||
      baselineMetrics.unfinished !== currentMetrics.unfinished ||
      baselineService.fulfillmentRatePercent !==
        currentService.fulfillmentRatePercent ||
      baseline.variant !== run.variant;
    const batches = new Set([
      ...baseline.batches.map(batchId),
      ...run.batches.map(batchId),
    ]);
    return (
      <>
        <section aria-label="Experiment comparison">
          <p
            className="workflow-comparison-result"
            role="status"
            data-changed={hasBaselineDiff}
          >
            {finishDifference(
              baseline.kind === "complete" ? baseline.end : null,
              run.kind === "complete" ? run.end : null,
            )}
          </p>
          <div
            className="workflow-comparison-metrics"
            aria-label="Before and after"
          >
            <div>
              <span>Finish time</span>
              <strong>
                {run.kind === "complete" ? clock(run.end) : "Unfinished"}
              </strong>
              {hasBaselineDiff && (
                <small>
                  Before:{" "}
                  {baseline.kind === "complete"
                    ? clock(baseline.end)
                    : "Unfinished"}
                </small>
              )}
            </div>
            <div>
              <span>Late batches</span>
              <strong>{currentMetrics.late}</strong>
              <small>
                {hasBaselineDiff
                  ? `Before: ${baselineMetrics.late}`
                  : `of ${run.batches.length} total`}
              </small>
            </div>
            <div>
              <span>Unfinished</span>
              <strong>{currentMetrics.unfinished}</strong>
              <small>
                {hasBaselineDiff
                  ? `Before: ${baselineMetrics.unfinished}`
                  : currentMetrics.unfinished === 0
                    ? "All complete"
                    : "Stopped early"}
              </small>
            </div>
            <div>
              <span>Order fulfillment</span>
              <strong>{currentService.fulfillmentRatePercent}%</strong>
              <small>
                {hasBaselineDiff
                  ? `Before: ${baselineService.fulfillmentRatePercent}%`
                  : `${currentService.fulfilledOrders}/${currentService.totalOrders} orders`}
              </small>
            </div>
            <div>
              <span>Café bar peak wait</span>
              <strong>{currentService.maxBeverageWaitSeconds}s</strong>
              <small>
                {hasBaselineDiff
                  ? `Before: ${baselineService.maxBeverageWaitSeconds}s`
                  : `${currentService.servedBeverageCups}/${currentService.totalBeverageCups} cups`}
              </small>
            </div>
          </div>
          <div
            className="workflow-presets"
            aria-label="Export shift service report"
          >
            <button
              type="button"
              onClick={() =>
                downloadBakeryFile(
                  `shift-customer-report-${currentService.rushPreset}.json`,
                  exportVitrineShiftServiceJson(run, run.end),
                )
              }
            >
              Export shift JSON
            </button>
            <button
              type="button"
              onClick={() =>
                downloadBakeryFile(
                  `shift-customer-report-${currentService.rushPreset}.csv`,
                  exportVitrineShiftServiceCsv(run, run.end),
                  "text/csv;charset=utf-8",
                )
              }
            >
              Export shift CSV
            </button>
          </div>
          {hasDraft && (
            <p className="workflow-panel-intro">
              Apply your input changes to update this comparison.
            </p>
          )}
        </section>
        <section
          className="workflow-delays-section"
          aria-label="Delays by batch"
        >
          <div className="workflow-delays-header">
            <h3>Delays by batch</h3>
            <span className="workflow-delays-bottleneck">
              Bottleneck: {largestWait(run)}
            </span>
          </div>
          <div className="workflow-delay-list">
            {run.batches.map(this.renderDeadline.bind(this))}
          </div>
        </section>
        <div className="workflow-baseline">
          <p>Baseline: {runDescription(baseline)}</p>
          <button
            type="button"
            className="workflow-pin-baseline"
            onClick={onPinBaseline}
            disabled={hasDraft}
          >
            Use current run as baseline
          </button>
        </div>
        <details className="workflow-baseline-drawer">
          <summary>Batch comparison</summary>
          <dl className="workflow-comparison-inputs">
            <dt>Current</dt>
            <dd>{runDescription(run)}</dd>
          </dl>
          <div className="workflow-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Batch</th>
                  <th scope="col">Baseline</th>
                  <th scope="col">Current</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(batches).map(this.renderBatch.bind(this))}
              </tbody>
            </table>
          </div>
        </details>
      </>
    );
  }

  private renderBatch(id: string): React.ReactNode {
    const { run, baseline } = this.props;
    const existed = baseline.batches.some(hasBatchId.bind(null, id));
    const exists = run.batches.some(hasBatchId.bind(null, id));
    let difference: string;
    if (!existed) {
      difference = "Added batch";
    } else if (!exists) {
      difference = "Removed batch";
    } else {
      difference = finishDifference(
        finishTime(baseline, id),
        finishTime(run, id),
      );
    }
    return (
      <tr key={id}>
        <th scope="row">Batch {id}</th>
        <td>{existed ? finishLabel(baseline, id) : "Absent"}</td>
        <td>{exists ? finishLabel(run, id) : "Absent"}</td>
        <td>{difference}</td>
      </tr>
    );
  }

  private renderDeadline(batch: Batch): React.ReactNode {
    return (
      <BatchDeadline
        key={batch.id}
        run={this.props.run}
        batch={batch}
        onInspect={this.props.onInspect}
      />
    );
  }
}

type DeadlineProps = {
  readonly run: Run;
  readonly batch: Batch;
  readonly onInspect: (interval: Interval) => void;
};

export class BatchDeadline extends React.PureComponent<DeadlineProps> {
  render(): React.ReactNode {
    const { run, batch } = this.props;
    const finish = finishTime(run, batch.id);
    let status = "Unfinished";
    let tone = "failed";
    if (finish !== null) {
      if (finish > batch.deadline) {
        status = `${duration(finish - batch.deadline)} late`;
        tone = "late";
      } else {
        status = "On time";
        tone = "completed";
      }
    }
    const waits = batchTimeline(run, batch.id).filter(isWait);
    return (
      <details className="workflow-batch-delay">
        <summary>
          <span className="workflow-batch-delay-title">
            <strong>Batch {batch.id}</strong>
            <small>
              {finishLabel(run, batch.id)} · due {clock(batch.deadline)}
            </small>
          </span>
          <span className="workflow-status-pill" data-tone={tone}>
            {status}
          </span>
        </summary>
        <div className="workflow-wait-links">
          {waits.length ? (
            waits.map(this.renderWait.bind(this))
          ) : (
            <p className="workflow-no-waits">No recorded waiting.</p>
          )}
        </div>
      </details>
    );
  }

  private renderWait(interval: Interval): React.ReactNode {
    const elapsed = Math.min(interval.end, this.props.run.end) - interval.start;
    return (
      <button
        key={interval.start}
        type="button"
        onClick={this.props.onInspect.bind(null, interval)}
      >
        <span>{describe(interval)}</span>
        <small>
          {duration(elapsed)} wait · {clock(interval.start)}
        </small>
      </button>
    );
  }
}

function batchId(batch: Batch): string {
  return batch.id;
}

function hasBatchId(id: string, batch: Batch): boolean {
  return batch.id === id;
}

function isWait(interval: Interval): boolean {
  return interval.kind === "wait";
}

function runDescription(run: Run): string {
  return `${run.settings.workerCount} ${run.settings.workerCount === 1 ? "worker" : "workers"}, ${run.settings.bake} min bake, ${run.settings.batchCount} batches, ${run.variant === "normal" ? "normal shift" : "oven outage"}`;
}

function finishTime(run: Run, id: string): number | null {
  for (const item of run.completions) {
    if (item.batch === id) {
      return item.time;
    }
  }
  return null;
}

export function finishLabel(run: Run, id: string): string {
  const time = finishTime(run, id);
  return time === null ? "Unfinished" : clock(time);
}
