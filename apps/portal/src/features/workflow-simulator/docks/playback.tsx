import { Select } from "../../../ui/select";
import React from "react";
import {
  PlaybackCursor,
  PlaybackScrubber,
  PlaybackTimeText,
} from "../playback-cursor";
import { Tooltip } from "@base-ui/react/tooltip";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GlideHighlight } from "../../../ui/glide-highlight";
import { PlaybackToggle } from "../playback-toggle";
import {
  StepForward,
  RotateCcw,
  ChartGantt,
  ChevronUp,
  ChevronDown,
  Minimize2,
  Maximize2,
  Check,
} from "lucide-react";

import { BatchDeadline } from "../results";
import {
  batchAt,
  clock,
  describe,
  getActiveVitrineChannelFilter,
  getActiveVitrineRushPreset,
  getSnapVitrineOrdersToWaves,
  getVitrineDemandRevision,
  humanResource,
  setVitrineOrderArrivalMinutes,
  snapOrderMinutesToNearestWave,
  stationLabel,
  metrics,
  subscribeVitrineRushPreset,
  taskAt,
  vitrineStockAt,
  type Batch,
  type HumanResource,
  type Run,
} from "@seams/production-simulation/recipes/bakery/schedule";
import { selectionContext } from "@seams/production-simulation/simulator/selection";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type { PlaybackView } from "../simulator-state";
import { TimelineTrack, WorkerTimelineTrack } from "../timeline";
import { EquipmentLanes } from "../equipment-lanes";
import { equipmentAt, equipmentSummary } from "@seams/production-simulation/simulator/equipment-timeline";
import { SegmentedControl } from "./shared";
import { assertNever } from "@seams/std";

type PlaybackState = Pick<
  PlaybackView,
  "time" | "playback" | "speed" | "scene" | "notice" | "selection"
>;

type PlaybackActions = Pick<
  WorkflowSimulatorActions,
  | "togglePlay"
  | "nextEvent"
  | "restart"
  | "changeSpeed"
  | "toggleDock"
  | "seek"
  | "select"
  | "seekInterval"
  | "seekStation"
  | "inspectInterval"
>;

type Props = Readonly<{
  run: Run;
  result: ReturnType<typeof metrics>;
  timelineOpen: boolean;
  state: PlaybackState;
  actions: PlaybackActions;
}>;

export function PlaybackDock(props: Props): React.ReactNode {
  const state = props.state;
  const [timelineTab, setTimelineTab] = React.useState<
    "batches" | "workers" | "equipment"
  >("batches");
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    if (props.timelineOpen) {
      setCollapsed(false);
    }
  }, [props.timelineOpen]);
  const timelineVisible = !collapsed && props.timelineOpen;
  const workerTasks = React.useMemo(
    () => workerTaskItems(props.run),
    [props.run],
  );
  return (
    <footer className="workflow-playback" data-collapsed={collapsed}>
      <div className="workflow-playback-controls">
        <div className="workflow-playback-clock">
          <PlaybackTimeText
            as="output"
            aria-label="Simulated time"
            aria-live="off"
            text={clock}
          />
          {!collapsed && (
            <Tooltip.Root>
              <Tooltip.Trigger
                delay={200}
                render={
                  <p className="workflow-caption" role="status" tabIndex={0} />
                }
              >
                {sceneCaption(state)}
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Positioner
                  side="top"
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  className="console-sidebar-tooltip-positioner"
                >
                  <Tooltip.Popup className="console-sidebar-tooltip workflow-caption-popover">
                    {sceneCaption(state)}
                  </Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </Tooltip.Root>
          )}
        </div>
        <div
          className="workflow-playback-transport"
          role="group"
          aria-label="Playback controls"
        >
          <PlaybackToggle
            playing={state.playback === "playing"}
            playLabel="Play shift"
            pauseLabel="Pause"
            onToggle={props.actions.togglePlay}
          />
          {!collapsed && (
            <>
              <button onClick={props.actions.nextEvent}>
                <StepForward aria-hidden="true" />
                Next event
              </button>
              <button
                className="workflow-playback-restart"
                aria-label="Restart"
                data-tooltip="Restart shift"
                onClick={props.actions.restart}
              >
                <RotateCcw aria-hidden="true" />
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="workflow-playback-speed">
                    <span>Speed</span>
                    <span>{state.speed}×</span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="workflow-more-menu workflow-speed-menu"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={12}
                    aria-label="Playback speed"
                  >
                    <GlideHighlight target="[data-highlighted]" />
                    <DropdownMenu.RadioGroup value={String(state.speed)}>
                      {[30, 120].map(
                        renderSpeedOption.bind(null, props.actions),
                      )}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}
        </div>
        <div
          className="workflow-playback-views"
          role="group"
          aria-label="Timeline"
        >
          {!collapsed && (
            <button
              id="workflow-toggle-timeline"
              aria-expanded={props.timelineOpen}
              aria-controls="workflow-dock-timeline"
              onClick={props.actions.toggleDock.bind(null, "timeline")}
            >
              <ChartGantt aria-hidden="true" />
              Production timeline{" "}
              {props.timelineOpen ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronUp aria-hidden="true" />
              )}
            </button>
          )}
          <button
            id="workflow-toggle-playback-collapse"
            type="button"
            className="workflow-playback-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand playback" : "Collapse playback"}
            data-tooltip={collapsed ? "Expand playback" : "Collapse playback"}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? (
              <>
                <Maximize2 aria-hidden="true" />
                <span>Expand</span>
              </>
            ) : (
              <>
                <Minimize2 aria-hidden="true" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </div>
      <section
        id="workflow-dock-timeline"
        className="workflow-timeline-drawer"
        hidden={!timelineVisible}
        aria-label="Production timeline"
      >
        <div className="workflow-timeline-topbar">
          <SegmentedControl
            ariaLabel="Timeline view"
            value={timelineTab}
            options={[
              {
                value: "batches",
                label: "Batches",
                onSelect: setTimelineTab.bind(null, "batches"),
              },
              {
                value: "workers",
                label: "Workers",
                onSelect: setTimelineTab.bind(null, "workers"),
              },
              {
                value: "equipment",
                label: "Equipment",
                onSelect: setTimelineTab.bind(null, "equipment"),
              },
            ]}
          />
          <button
            type="button"
            className="production-sr-alias"
            tabIndex={-1}
            onClick={setTimelineTab.bind(null, "workers")}
          >
            Worker allocations
          </button>
          <button
            type="button"
            className="production-sr-alias"
            tabIndex={-1}
            onClick={setTimelineTab.bind(null, "equipment")}
          >
            Equipment allocations
          </button>
          <div className="workflow-timeline-legend" aria-hidden="true">
            <span data-kind="process">Processing</span>
            <span data-kind="transfer">Transfer</span>
            <span data-kind="wait">Waiting</span>
            <span data-kind="order">Orders</span>
          </div>
          <p className="workflow-timeline-selection">
            {timelineSelection(props.run, state)}
          </p>
        </div>
        <label className="workflow-timeline-scrubber">
          <span className="production-sr-only">Seek through the shift</span>
          <PlaybackScrubber
            aria-label="Seek through the shift"
            end={props.run.end}
            valueText={clock}
            progressProperty="--seek-progress"
            min={0}
            step={1}
            onChange={props.actions.seek}
          />
        </label>
        <div className="workflow-time-ruler" aria-label="Shift time scale">
          <span>{clock(0)}</span>
          <span>{clock(props.run.end / 2)}</span>
          <span>{clock(props.run.end)}</span>
        </div>
        {timelineVisible && (
          <CustomerOrderTimelineTrack
            run={props.run}
            time={state.time}
            selection={state.selection}
            onSelect={props.actions.select}
            onSeekStation={props.actions.seekStation}
          />
        )}
        {timelineVisible && timelineTab === "batches"
          ? props.run.batches.map(renderTrack.bind(null, props))
          : null}
        {timelineVisible && timelineTab === "workers" && (
          <div className="workflow-worker-lanes">
            <label className="workflow-worker-picker">
              Worker task
              <Select.Root
                items={workerTasks}
                value={null}
                onValueChange={selectWorkerTask.bind(null, props)}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Choose a task…" />
                </Select.Trigger>
                <Select.Popup>
                  {workerTasks.map(renderWorkerOption)}
                </Select.Popup>
              </Select.Root>
            </label>
            {props.run.resources.map(renderWorkerTrack.bind(null, props))}
          </div>
        )}
        {timelineVisible && timelineTab === "equipment" && (
          <EquipmentLanes
            run={props.run}
            time={state.time}
            selection={state.selection}
            onSeek={props.actions.seekStation}
          />
        )}
      </section>
    </footer>
  );
}

function renderSpeedOption(
  actions: PlaybackActions,
  speed: number,
): React.ReactNode {
  return (
    <DropdownMenu.RadioItem
      key={speed}
      value={String(speed)}
      onSelect={actions.changeSpeed.bind(null, speed)}
    >
      <span className="workflow-speed-indicator">
        <DropdownMenu.ItemIndicator>
          <Check size={16} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      {speed}×
    </DropdownMenu.RadioItem>
  );
}

function selectWorkerTask(props: Props, value: string | null): void {
  if (value === null) return;
  for (const interval of props.run.intervals) {
    if (
      interval.kind !== "wait" &&
      interval.attended &&
      interval.id === value
    ) {
      props.actions.seekInterval(interval);
      return;
    }
  }
}

function workerTaskItems(
  run: Run,
): ReadonlyArray<Readonly<{ value: string; label: string }>> {
  const items = [];
  for (const interval of run.intervals) {
    if (interval.kind === "wait" || !interval.attended) continue;
    items.push({
      value: interval.id,
      label: `${humanResource(run, interval.executor).name} · Batch ${interval.batch}: ${describe(interval)} · ${clock(interval.start)}`,
    });
  }
  return items;
}

function renderWorkerOption(
  item: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function renderWorkerTrack(
  props: Props,
  resource: HumanResource,
): React.ReactNode {
  return (
    <WorkerTimelineTrack
      key={resource.id}
      run={props.run}
      resource={resource}
      time={props.state.time}
      selection={props.state.selection}
      onSelect={props.actions.select}
      onSeek={props.actions.seekInterval}
    />
  );
}

export function Deadline(
  props: Readonly<{
    run: Run;
    batch: Batch;
    actions: Pick<WorkflowSimulatorActions, "inspectInterval">;
  }>,
): React.ReactNode {
  return (
    <BatchDeadline
      run={props.run}
      batch={props.batch}
      onInspect={props.actions.inspectInterval}
    />
  );
}

function renderTrack(props: Props, batch: Batch): React.ReactNode {
  return (
    <TimelineTrack
      key={batch.id}
      run={props.run}
      batch={batch}
      selection={props.state.selection}
      time={props.state.time}
      onSelect={props.actions.select}
      onSeek={props.actions.seekInterval}
    />
  );
}

function CustomerOrderTimelineTrack(
  props: Readonly<{
    run: Run;
    time: number;
    selection: PlaybackState["selection"];
    onSelect: PlaybackActions["select"];
    onSeekStation: PlaybackActions["seekStation"];
  }>,
): React.ReactNode {
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
  const vitrine = vitrineStockAt(props.run, props.time, activeRush);
  const end = Math.max(1, props.run.end);
  const maxMinutes = Math.max(1, Math.round(end / 60));
  return (
    <div
      className="workflow-track workflow-order-track"
      role="group"
      aria-label="Customer order arrivals"
    >
      <button
        type="button"
        aria-pressed={
          props.selection.kind === "station" && props.selection.id === "pack"
        }
        title={`${vitrine.rushPresetLabel} · ${vitrine.fulfilledOrders.length}/${vitrine.orders.length} fulfilled · ${vitrine.waitingOrders.length} waiting`}
        onClick={() => props.onSelect({ kind: "station", id: "pack" })}
      >
        Orders ({vitrine.orders.length})
      </button>
      <div
        className="workflow-lane workflow-order-arrival-lane"
        role="group"
        aria-label="Customer order arrival markers"
      >
        {vitrine.refillWaves.map((wave) => {
          const wavePct = Math.max(
            0,
            Math.min(100, (wave.completedAt / end) * 100),
          );
          return (
            <span
              key={`wave-${wave.waveNumber}`}
              className="workflow-wave-tick"
              data-status={wave.status}
              title={`Refill Wave ${wave.waveNumber} (Batch ${wave.batchId}) stocked at ${clock(wave.completedAt)}`}
              style={{ left: `${wavePct}%` }}
            />
          );
        })}
        {vitrine.orders.map((ord) => {
          const pct = Math.max(2, Math.min(98, (ord.orderedAt / end) * 100));
          const seekTime = Math.min(props.run.end, ord.orderedAt);
          return (
            <button
              key={ord.id}
              type="button"
              className="workflow-order-marker"
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
              data-status={ord.status}
              data-custom={ord.isCustomArrival ? "true" : undefined}
              data-dragging={draggingOrderId === ord.id ? "true" : undefined}
              data-snapped-wave={
                draggingOrderId === ord.id && snappedWaveNumber !== null
                  ? snappedWaveNumber
                  : undefined
              }
              aria-label={`Timeline ${ord.id} at ${clock(ord.orderedAt)} (${ord.status})`}
              title={`${ord.id} · ${clock(ord.orderedAt)} · ${ord.channelLabel} · ${ord.ballotinBoxes} box + ${ord.loosePieces} loose · ${ord.beverageLabel} (${ord.status}) · Drag left/right to reschedule (Alt-drag to snap to wave)`}
              style={{ left: `${pct}%` }}
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
                  setSnappedWaveNumber(snapped.snappedWave?.waveNumber ?? null);
                } else {
                  setSnappedWaveNumber(null);
                }
                setVitrineOrderArrivalMinutes(ord.id, nextMinutes);
                props.onSeekStation(
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
                props.onSeekStation(
                  "pack",
                  Math.min(props.run.end, nextMinutes * 60),
                );
              }}
              onClick={() => {
                if (suppressClickOrderRef.current === ord.id) {
                  suppressClickOrderRef.current = null;
                  return;
                }
                props.onSeekStation("pack", seekTime);
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
              <span>{ord.id.replace("ORD-", "#")}</span>
            </button>
          );
        })}
        <PlaybackCursor end={end} />
      </div>
    </div>
  );
}

function sceneCaption(state: PlaybackState): string {
  switch (state.scene) {
    case "loading":
      return "Loading bakery assets…";
    case "unavailable":
      return "3D unavailable. Use Workflow, Inspector and Timeline to replay the shift.";
    case "ready":
      return state.notice;
    default:
      return assertNever(state.scene, "Unexpected workflow scene state");
  }
}

function timelineSelection(run: Run, state: PlaybackState): string {
  const selection = state.selection;
  if (selection.kind === "station") {
    return `${stationLabel(selection.id)} · ${equipmentSummary(equipmentAt(run, selection.id, state.time))}`;
  }
  const { batch, task, resource } = selectionContext(
    run,
    selection,
    state.time,
  );
  if (selection.kind === "task" && task !== null) {
    return `Batch ${task.batch} · ${describe(task)} · ${taskAt(run, task, state.time).kind} · ${resource?.name ?? "Unattended"}`;
  }
  if (selection.kind === "resource" && resource !== null) {
    if (task === null) return `${resource.name} · Available`;
    return `${resource.name} · Batch ${task.batch} · ${describe(task)}`;
  }
  if (batch !== null)
    return `Batch ${batch.id} · ${describe(batchAt(run, batch, state.time))}`;
  return "Select a task or worker to follow it in 3D.";
}
