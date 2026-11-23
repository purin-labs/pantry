import { Select } from "@purin-labs/ui/select";
import React from "react";
import { PlaybackCursor } from "./playback-cursor";
import type { StationId } from "@purin-labs/bakery-model/bakery";
import {
  clock,
  getActiveVitrineChannelFilter,
  getActiveVitrineRushPreset,
  getSnapVitrineOrdersToWaves,
  getVitrineDemandRevision,
  setVitrineOrderArrivalMinutes,
  snapOrderMinutesToNearestWave,
  stations,
  subscribeVitrineRushPreset,
  vitrineStockAt,
  type Run,
  type Station,
  type VitrineStockSnapshot,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type { Selection } from "@purin-labs/production-simulation/simulator/selection";
import {
  equipmentAt,
  equipmentSummary,
  equipmentTimeline,
  type EquipmentSpan,
} from "@purin-labs/production-simulation/simulator/equipment-timeline";
import "./equipment-lanes.css";

type Props = Readonly<{
  run: Run;
  time: number;
  selection: Selection;
  onSeek: (station: StationId, time: number) => void;
}>;

type Lane = Readonly<{
  station: Station;
  spans: readonly EquipmentSpan[];
}>;

type BarOrder = VitrineStockSnapshot["orders"][number];

export function EquipmentLanes(props: Props): React.ReactNode {
  const activeRush = React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getActiveVitrineRushPreset,
    getActiveVitrineRushPreset,
  );
  React.useSyncExternalStore(
    subscribeVitrineRushPreset,
    getVitrineDemandRevision,
    getVitrineDemandRevision,
  );
  const lanes = React.useMemo(buildLanes.bind(null, props.run), [props.run]);
  const vitrine = vitrineStockAt(props.run, props.time, activeRush);
  const periods = periodItems(lanes, vitrine);
  return (
    <div className="workflow-equipment-lanes">
      <label className="workflow-worker-picker">
        Equipment interval
        <Select.Root
          items={periods}
          value={null}
          onValueChange={selectPeriod.bind(null, props, lanes, vitrine)}
        >
          <Select.Trigger>
            <Select.Value placeholder="Choose an interval…" />
          </Select.Trigger>
          <Select.Popup>
            {lanes.map(renderOptions)}
            <Select.Group>
              <Select.GroupLabel>Café bar</Select.GroupLabel>
              {vitrine.orders.map((ord) => (
                <Select.Item key={ord.id} value={barValue(ord)}>
                  {barLabel(ord)}
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Popup>
        </Select.Root>
      </label>
      {lanes.map(renderLane.bind(null, props))}
      <CafeBarLane {...props} vitrine={vitrine} />
      {props.run.kind !== "complete" && (
        <p>Reservations still present at shift end remain unresolved.</p>
      )}
    </div>
  );
}

function buildLanes(run: Run): readonly Lane[] {
  const lanes: Lane[] = [];
  for (const station of stations) {
    lanes.push({ station, spans: equipmentTimeline(run, station.id) });
  }
  return lanes;
}

function periodItems(
  lanes: readonly Lane[],
  vitrine: VitrineStockSnapshot,
): ReadonlyArray<Readonly<{ value: string; label: string }>> {
  const items = [];
  for (const lane of lanes) {
    for (const span of lane.spans) {
      items.push({
        value: spanValue(lane.station, span),
        label: spanLabel(lane.station, span),
      });
    }
  }
  for (const ord of vitrine.orders) {
    items.push({ value: barValue(ord), label: barLabel(ord) });
  }
  return items;
}

function spanValue(station: Station, span: EquipmentSpan): string {
  return `${station.id}:${span.start}`;
}

function spanLabel(station: Station, span: EquipmentSpan): string {
  return `${station.label} · ${clock(span.start)}–${clock(span.end)} · ${equipmentSummary(span.allocation)}`;
}

function barValue(ord: BarOrder): string {
  return `bar:${ord.id}:${ord.brewStart}`;
}

function barLabel(ord: BarOrder): string {
  return `Café bar · ${clock(ord.brewStart)}–${clock(ord.brewEnd)} · ${ord.id} ${ord.beverageLabel}`;
}

function renderOptions(lane: Lane): React.ReactNode {
  return (
    <Select.Group key={lane.station.id}>
      <Select.GroupLabel>{lane.station.label}</Select.GroupLabel>
      {lane.spans.map(renderOption.bind(null, lane.station))}
    </Select.Group>
  );
}

function renderOption(station: Station, span: EquipmentSpan): React.ReactNode {
  return (
    <Select.Item key={span.start} value={spanValue(station, span)}>
      {spanLabel(station, span)}
    </Select.Item>
  );
}

function selectPeriod(
  props: Props,
  lanes: readonly Lane[],
  vitrine: VitrineStockSnapshot,
  value: string | null,
): void {
  if (value === null) return;
  for (const ord of vitrine.orders) {
    if (value === barValue(ord)) {
      props.onSeek("pack", Math.min(props.run.end, ord.brewStart));
      return;
    }
  }
  for (const lane of lanes) {
    for (const span of lane.spans) {
      if (value === spanValue(lane.station, span)) {
        props.onSeek(lane.station.id, span.start);
        return;
      }
    }
  }
}

function renderLane(props: Props, lane: Lane): React.ReactNode {
  const selected =
    props.selection.kind === "station" &&
    props.selection.id === lane.station.id;
  return (
    <div
      key={lane.station.id}
      role="group"
      aria-label={`${lane.station.label} allocations`}
    >
      <div className="workflow-track">
        <button
          className="workflow-resource-name"
          aria-pressed={selected}
          onClick={props.onSeek.bind(null, lane.station.id, props.time)}
        >
          {lane.station.label}
        </button>
        <div className="workflow-lane">
          {lane.spans.map(renderSpan.bind(null, props, lane.station, selected))}
          <PlaybackCursor end={props.run.end} />
        </div>
      </div>
      <p className="workflow-equipment-status">
        {equipmentSummary(equipmentAt(props.run, lane.station.id, props.time))}
      </p>
    </div>
  );
}

function renderSpan(
  props: Props,
  station: Station,
  selected: boolean,
  span: EquipmentSpan,
): React.ReactNode {
  const allocation = span.allocation;
  if (allocation.capacity.used === 0 && !allocation.unavailable) return null;
  const current = props.time >= span.start && props.time < span.end;
  const label = `${station.label}. ${clock(span.start)}–${clock(span.end)}. ${equipmentSummary(allocation)}.`;
  let text = `${allocation.capacity.used}/${allocation.capacity.total}`;
  if (allocation.cycle !== null)
    text = `Cycle ${allocation.cycle.id} · ${text}`;
  if (allocation.unavailable) text = `Unavailable · ${text}`;
  return (
    <button
      key={span.start}
      className={`workflow-interval ${allocation.unavailable ? "workflow-wait" : "workflow-process"}`}
      aria-label={label}
      title={label}
      aria-pressed={selected && current}
      aria-current={current ? "step" : undefined}
      onClick={props.onSeek.bind(null, station.id, span.start)}
      style={{
        left: `${(span.start / props.run.end) * 100}%`,
        width: `${((span.end - span.start) / props.run.end) * 100}%`,
      }}
    >
      <span>{text}</span>
    </button>
  );
}

function CafeBarLane(
  props: Props & Readonly<{ vitrine: VitrineStockSnapshot }>,
): React.ReactNode {
  const { vitrine } = props;
  const [draggingOrderId, setDraggingOrderId] = React.useState<string | null>(
    null,
  );
  const [snappedWaveNumber, setSnappedWaveNumber] = React.useState<
    number | null
  >(null);
  const dragRef = React.useRef<{
    orderId: string;
    pointerId: number;
    startX: number;
    laneLeft: number;
    laneWidth: number;
    moved: boolean;
  } | null>(null);
  const suppressClickOrderRef = React.useRef<string | null>(null);
  const channelFilter = getActiveVitrineChannelFilter();
  const snapToWaves = getSnapVitrineOrdersToWaves();
  const selected =
    props.selection.kind === "station" && props.selection.id === "pack";
  const end = Math.max(1, props.run.end);
  const maxMinutes = Math.max(1, Math.round(end / 60));
  return (
    <div role="group" aria-label="Café bar beverage allocations">
      <div className="workflow-track">
        <button
          type="button"
          className="workflow-resource-name"
          aria-pressed={selected}
          title={vitrine.barStatusLabel}
          onClick={props.onSeek.bind(null, "pack", props.time)}
        >
          Café bar
        </button>
        <div
          className="workflow-lane workflow-bar-queue-lane"
          aria-label="Café bar queue markers"
        >
          {vitrine.orders.map((ord) => {
            const startPct = Math.max(
              2,
              Math.min(98, (ord.brewStart / end) * 100),
            );
            const statusText =
              ord.beverageStatus === "served"
                ? "Served"
                : ord.beverageStatus === "brewing"
                  ? "Brewing now"
                  : "Queued at bar";
            const label = `Café bar · ${ord.id} · ${ord.beverageLabel} · ${clock(ord.brewStart)}–${clock(ord.brewEnd)} · ${statusText}`;
            return (
              <button
                key={ord.id}
                type="button"
                className="workflow-bar-marker"
                data-order-id={ord.id}
                data-channel={ord.channel}
                data-channel-match={
                  channelFilter === "all"
                    ? undefined
                    : ord.channel === channelFilter
                      ? "true"
                      : "false"
                }
                data-arrival-minutes={ord.orderedAtMinutes}
                data-beverage-status={ord.beverageStatus}
                data-recipe={ord.beverageRecipe}
                data-custom={ord.isCustomArrival ? "true" : "false"}
                data-dragging={draggingOrderId === ord.id ? "true" : undefined}
                data-snapped-wave={
                  draggingOrderId === ord.id && snappedWaveNumber !== null
                    ? snappedWaveNumber
                    : undefined
                }
                aria-label={label}
                title={`${label} · Drag left/right to reschedule arrival (Alt-drag to snap to wave)`}
                aria-current={
                  ord.beverageStatus === "brewing" ? "step" : undefined
                }
                style={{ left: `${startPct}%` }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  const lane = e.currentTarget.parentElement;
                  if (!lane) return;
                  const rect = lane.getBoundingClientRect();
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  dragRef.current = {
                    orderId: ord.id,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    laneLeft: rect.left,
                    laneWidth: Math.max(1, rect.width),
                    moved: false,
                  };
                }}
                onPointerMove={(e) => {
                  const drag = dragRef.current;
                  if (
                    !drag ||
                    drag.orderId !== ord.id ||
                    drag.pointerId !== e.pointerId
                  ) {
                    return;
                  }
                  if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3) {
                    return;
                  }
                  if (!drag.moved) {
                    drag.moved = true;
                    setDraggingOrderId(ord.id);
                  }
                  const ratio = Math.max(
                    0,
                    Math.min(1, (e.clientX - drag.laneLeft) / drag.laneWidth),
                  );
                  const rawMinutes = Math.max(
                    1,
                    Math.min(maxMinutes, Math.round((ratio * end) / 60)),
                  );
                  let nextMinutes = rawMinutes;
                  if (e.altKey || snapToWaves) {
                    const snapped = snapOrderMinutesToNearestWave(
                      rawMinutes,
                      vitrine.refillWaves,
                      maxMinutes,
                    );
                    nextMinutes = snapped.minutes;
                    setSnappedWaveNumber(
                      snapped.snappedWave?.waveNumber ?? null,
                    );
                  } else {
                    setSnappedWaveNumber(null);
                  }
                  setVitrineOrderArrivalMinutes(ord.id, nextMinutes);
                  props.onSeek(
                    "pack",
                    Math.min(props.run.end, nextMinutes * 60),
                  );
                }}
                onPointerUp={(e) => {
                  const drag = dragRef.current;
                  if (
                    !drag ||
                    drag.orderId !== ord.id ||
                    drag.pointerId !== e.pointerId
                  ) {
                    return;
                  }
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  } catch {}
                  if (drag.moved) {
                    suppressClickOrderRef.current = ord.id;
                  }
                  dragRef.current = null;
                  setDraggingOrderId(null);
                  setSnappedWaveNumber(null);
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                  setDraggingOrderId(null);
                  setSnappedWaveNumber(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  const delta =
                    (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 5 : 1);
                  const nextMinutes = Math.max(
                    1,
                    Math.min(maxMinutes, ord.orderedAtMinutes + delta),
                  );
                  setVitrineOrderArrivalMinutes(ord.id, nextMinutes);
                  props.onSeek(
                    "pack",
                    Math.min(props.run.end, nextMinutes * 60),
                  );
                }}
                onClick={() => {
                  if (suppressClickOrderRef.current === ord.id) {
                    suppressClickOrderRef.current = null;
                    return;
                  }
                  props.onSeek("pack", Math.min(props.run.end, ord.brewStart));
                }}
              >
                {draggingOrderId === ord.id && (
                  <span
                    className="workflow-marker-drag-badge"
                    role="status"
                    aria-label={`Dragging ${ord.id} to ${clock(ord.orderedAt)}`}
                  >
                    {snappedWaveNumber !== null
                      ? `${clock(ord.orderedAt)} · Wave ${snappedWaveNumber}`
                      : clock(ord.orderedAt)}
                  </span>
                )}
                {ord.id.replace("ORD-", "#")}
              </button>
            );
          })}
          <PlaybackCursor end={end} />
        </div>
      </div>
      <p className="workflow-equipment-status">{vitrine.barStatusLabel}</p>
    </div>
  );
}
