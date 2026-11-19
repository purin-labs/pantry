import { HUMAN_CELL_TRANSFER } from "@purin-labs/production-simulation/recipes/bakery/human-cell-transfer";
import {
  resourceInstance,
  type CellId,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import React from "react";
import { PlaybackCursor } from "./playback-cursor";
import { batchTimeline } from "@purin-labs/production-simulation/simulator/demo";
import {
  clock,
  describe,
  humanResource,
  taskAt,
  workName,
  workerTasks,
  type Batch,
  type HumanId,
  type HumanResource,
  type Interval,
  type Run,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { outageResourceName } from "@purin-labs/production-simulation/recipes/bakery/run-faults";
import {
  intervalSelected,
  selectionContext,
  type Selection,
} from "@purin-labs/production-simulation/simulator/selection";
import { assertNever } from "@purin-labs/std";

type TrackProps = {
  readonly run: Run;
  readonly batch: Batch;
  readonly selection: Selection;
  readonly time: number;
  readonly onSelect: (selection: Selection) => void;
  readonly onSeek: (interval: Interval) => void;
};

export function TimelineTrack(props: TrackProps): React.ReactNode {
  const { run, batch, selection, time, onSelect, onSeek } = props;
  const selected =
    selectionContext(run, selection, time).batch?.id === batch.id;
  const intervals = React.useMemo(batchTimeline.bind(null, run, batch.id), [
    run,
    batch.id,
  ]);
  return (
    <div className="workflow-track">
      <button
        aria-pressed={selected}
        onClick={onSelect.bind(null, { kind: "batch", id: batch.id })}
      >
        {workName(run, batch.id)}
      </button>
      <div className="workflow-lane">
        {intervals.map(renderInterval.bind(null, run, selection, time, onSeek))}
        <PlaybackCursor end={run.end} />
      </div>
    </div>
  );
}

export function WorkerTimelineTrack(
  props: Readonly<{
    run: Run;
    resource: HumanResource;
    time: number;
    selection: Selection;
    onSelect: TrackProps["onSelect"];
    onSeek: TrackProps["onSeek"];
  }>,
): React.ReactNode {
  const { run, resource, time, selection, onSelect, onSeek } = props;
  const tasks = React.useMemo(workerTasks.bind(null, run, resource.id), [
    run,
    resource.id,
  ]);
  return (
    <div
      className="workflow-track"
      role="group"
      aria-label={`${resource.name} allocations`}
    >
      <button
        className="workflow-resource-name"
        aria-pressed={
          selection.kind === "resource" && selection.id === resource.id
        }
        onClick={onSelect.bind(null, { kind: "resource", id: resource.id })}
      >
        {resource.name}
      </button>
      <div className="workflow-lane">
        {tasks.map(renderInterval.bind(null, run, selection, time, onSeek))}
        {workerHolds(run, resource.id).map(renderHold.bind(null, run.end))}
        {outageBar(run, resource.id === run.faults.outage?.resource)}
        <PlaybackCursor end={run.end} />
      </div>
    </div>
  );
}

function renderInterval(
  run: Run,
  selection: Selection,
  time: number,
  onSeek: TrackProps["onSeek"],
  interval: Interval,
): React.ReactNode {
  const selected = intervalSelected(selection, interval);
  const current = selected && time >= interval.start && time < interval.end;
  const executor =
    interval.kind !== "wait" && interval.attended
      ? `${humanResource(run, interval.executor).name} · `
      : "";
  const status =
    interval.kind === "wait" ? "Waiting" : taskAt(run, interval, time).kind;
  const label = `${executor}${workName(run, interval.batch)}: ${describe(interval)}. ${clock(interval.start)}–${clock(Math.min(run.end, interval.end))}. ${status}.`;
  return (
    <TimelineInterval
      key={
        interval.kind === "wait"
          ? `${interval.batch}:${interval.start}`
          : interval.id
      }
      interval={interval}
      end={run.end}
      label={label}
      current={current}
      selected={selected}
      onSeek={onSeek}
    />
  );
}

type NativeTrackProps = Readonly<{
  run: Run;
  time: number;
  selection: Selection;
  onSeek: TrackProps["onSeek"];
}>;

export function NativeTimelineTrack(props: NativeTrackProps): React.ReactNode {
  return (
    <>
      {props.run.workcells.map(nativeCellTrack.bind(null, props))}
      {transferBufferTrack(props)}
    </>
  );
}

function nativeCellTrack(
  props: NativeTrackProps,
  cell: Run["workcells"][number],
): React.ReactNode {
  const name = resourceInstance(cell.id).name;
  return (
    <div
      className="workflow-track"
      role="group"
      aria-label={`${name} allocations`}
      key={cell.id}
    >
      <span>{name}</span>
      <div className="workflow-lane">
        {props.run.intervals
          .filter(cellInterval.bind(null, cell.id))
          .map(
            renderInterval.bind(
              null,
              props.run,
              props.selection,
              props.time,
              props.onSeek,
            ),
          )}
        {cellHolds(props.run, cell.id).map(
          renderHold.bind(null, props.run.end),
        )}
        {outageBar(props.run, cellOutage(props.run, cell.id))}
        <PlaybackCursor end={props.run.end} />
      </div>
    </div>
  );
}

// A failure holds the cell, and a failed handler's baker, until an assumed
// recovery releases them or the run ends.
type HoldSpan = Readonly<{
  id: string;
  start: number;
  end: number;
  recovered: boolean;
  label: string;
}>;

function cellHolds(run: Run, cellId: CellId): readonly HoldSpan[] {
  const holds: HoldSpan[] = [];
  for (const hold of run.nativeHolds)
    if (
      hold.kind === "failed" &&
      hold.operation.attempt.input.bindings.cell === cellId
    )
      holds.push(
        holdSpan(
          hold.operation.id,
          `${workName(run, hold.operation.batchId)} step ${hold.operation.step}`,
          hold.settledTime,
          hold.recoveredAt,
          run.end,
        ),
      );
  for (const failure of run.handlingFailures)
    if (failure.task.cellId === cellId || failure.task.phase === "transfer")
      holds.push(failureHold(run, failure));
  return holds;
}

function workerHolds(run: Run, id: HumanId): readonly HoldSpan[] {
  const holds: HoldSpan[] = [];
  for (const failure of run.handlingFailures)
    if (failure.task.executor === id) holds.push(failureHold(run, failure));
  return holds;
}

function failureHold(
  run: Run,
  failure: Run["handlingFailures"][number],
): HoldSpan {
  return holdSpan(
    failure.task.id,
    `${workName(run, failure.task.batch)} ${failure.task.phase === "transfer" ? "human transfer" : failure.task.phase === "stage" ? "staging" : "clearance"}`,
    failure.failedAt,
    failure.recoveredAt,
    run.end,
  );
}

function holdSpan(
  id: string,
  task: string,
  start: number,
  recoveredAt: number | null,
  end: number,
): HoldSpan {
  return {
    id,
    start,
    end: recoveredAt ?? end,
    recovered: recoveredAt !== null,
    label:
      recoveredAt === null
        ? `${task} failed at ${clock(start)}; held until recovery.`
        : `${task} failed at ${clock(start)}; recovery assumed until ${clock(recoveredAt)}.`,
  };
}

function renderHold(end: number, hold: HoldSpan): React.ReactNode {
  return (
    <span
      key={`hold-${hold.id}`}
      className="workflow-interval workflow-hold"
      role="img"
      aria-label={hold.label}
      title={hold.label}
      style={{
        left: `${(hold.start / end) * 100}%`,
        width: `${((Math.min(end, hold.end) - hold.start) / end) * 100}%`,
      }}
    >
      <span>{hold.recovered ? "Recovery" : "Held"}</span>
    </span>
  );
}

// An outage postpones new work but lets running work finish, so it marks the
// lane beneath its tasks.
function outageBar(run: Run, affected: boolean): React.ReactNode {
  const outage = run.faults.outage;
  if (!affected || outage === null || outage.start >= run.end) return null;
  const label = `${outageResourceName(outage.resource)} unavailable ${clock(outage.start)}–${clock(outage.end)}.`;
  return (
    <span
      className="workflow-outage"
      role="img"
      aria-label={label}
      title={label}
      style={{
        left: `${(outage.start / run.end) * 100}%`,
        width: `${((Math.min(run.end, outage.end) - outage.start) / run.end) * 100}%`,
      }}
    />
  );
}

function cellInterval(cellId: CellId, interval: Interval): boolean {
  if (interval.kind === "native")
    return interval.operation.attempt.input.bindings.cell === cellId;
  return (
    interval.kind === "handoff" &&
    (interval.cellId === cellId || interval.phase === "transfer")
  );
}

function cellOutage(run: Run, cellId: CellId): boolean {
  for (const resource of run.workcellResources)
    if (
      resource.cellId === cellId &&
      resource.id === run.faults.outage?.resource
    )
      return true;
  return false;
}

type IntervalProps = {
  readonly interval: Interval;
  readonly end: number;
  readonly current: boolean;
  readonly selected: boolean;
  readonly label: string;
  readonly onSeek: TrackProps["onSeek"];
};

class TimelineInterval extends React.PureComponent<IntervalProps> {
  render(): React.ReactNode {
    const { interval, end, current, selected, label, onSeek } = this.props;
    let text: string;
    switch (interval.kind) {
      case "process":
      case "handoff":
      case "native":
        text = describe(interval);
        break;
      case "wait":
        text = "Waiting";
        break;
      case "transfer":
        text = "Transfer";
        break;
      default:
        return assertNever(interval);
    }
    return (
      <button
        className={`workflow-interval workflow-${interval.kind}`}
        aria-current={current ? "step" : undefined}
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={onSeek.bind(null, interval)}
        style={{
          left: `${(interval.start / end) * 100}%`,
          width: `${((Math.min(end, interval.end) - interval.start) / end) * 100}%`,
        }}
      >
        <span>{text}</span>
      </button>
    );
  }
}

function transferBufferTrack(props: NativeTrackProps): React.ReactNode {
  const spans: HoldSpan[] = [];
  for (const reservation of props.run.nativeReservations) {
    if (!reservation.resources.includes(HUMAN_CELL_TRANSFER.buffer)) continue;
    spans.push({
      id: `${reservation.operationId}:${reservation.start}`,
      start: reservation.start,
      end: reservation.kind === "released" ? reservation.end : props.run.end,
      recovered: reservation.kind === "released",
      label: `${reservation.materialId}: one-slot buffer reserved${reservation.kind === "held" ? "; transfer failed, location uncertain" : " (assumed transfer)"}`,
    });
  }
  if (spans.length === 0) return null;
  return (
    <div
      className="workflow-track"
      role="group"
      aria-label="Transfer buffer allocations"
    >
      <span>Buffer · 1 tray</span>
      <div className="workflow-lane">
        {spans.map(renderHold.bind(null, props.run.end))}
      </div>
    </div>
  );
}
