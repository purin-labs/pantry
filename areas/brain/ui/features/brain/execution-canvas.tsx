import React from "react";
import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  Lock,
  Maximize,
  Minus,
  Plus,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import type { CaseExecutionNode } from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type { StatusChipStatus } from "@purin-labs/ui/status-chip";
import {
  EXECUTION_NODE_HEIGHT,
  EXECUTION_NODE_WIDTH,
  layoutExecution,
  stageLabel,
  type ExecutionFold,
} from "./execution-layout";
import {
  kindLabel,
  nodeStatus,
  nodeTitle,
  titleNamesKind,
  type CaseExecution,
} from "@purin-labs/area-brain-contract/ui/features/brain/execution-model";

type StateMark = StatusChipStatus["kind"] | "withheld";

function stateMark(node: CaseExecutionNode): StateMark {
  return node.access === "withheld" ? "withheld" : nodeStatus(node).kind;
}

/** A state has its own shape, so that colour is not its only sign. */
function stateMarkIcon(mark: StateMark): LucideIcon {
  switch (mark) {
    case "success":
      return CircleCheck;
    case "info":
      return CircleDot;
    case "warning":
      return TriangleAlert;
    case "danger":
      return CircleX;
    case "neutral":
      return Circle;
    case "withheld":
      return Lock;
    default:
      return assertNever(mark, "Unexpected value");
  }
}

const LEGEND: readonly Readonly<{ mark: StateMark; label: string }>[] = [
  { mark: "success", label: "Done" },
  { mark: "info", label: "In progress" },
  { mark: "warning", label: "Waits or unknown" },
  { mark: "danger", label: "Failed" },
  { mark: "neutral", label: "Other state" },
  { mark: "withheld", label: "Withheld" },
];

/**
 * What each state mark of the canvas means, in words. It sits in the canvas,
 * at the lower left, beside the zoom tools.
 */
function ExecutionLegend(): React.ReactNode {
  return (
    <ul className="brain-legend" aria-label="State marks">
      {LEGEND.map((entry) => {
        const Icon = stateMarkIcon(entry.mark);
        return (
          <li key={entry.mark} data-mark={entry.mark}>
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
            {entry.label}
          </li>
        );
      })}
    </ul>
  );
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
/** A first view keeps the text of a record easy to read. */
const MIN_FIRST_ZOOM = 0.85;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));
}

/**
 * The records of one Case on a canvas. The canvas scrolls like a page, so
 * the wheel, the keyboard and a touch screen move it. A drag on its
 * background moves it too.
 */
export function ExecutionCanvas(props: {
  /** The records of one Case. Another Case sets the first view again. */
  readonly execution: CaseExecution;
  readonly selectedId: string | null;
  readonly onSelect: (node: CaseExecutionNode) => void;
}): React.ReactNode {
  const { execution } = props;
  const { caseId } = execution;
  // The stacks that the person opened, for this Case.
  const [unfolded, setUnfolded] = React.useState<{
    caseId: string;
    keys: ReadonlySet<string>;
  }>({ caseId, keys: new Set() });
  const open = unfolded.caseId === caseId ? unfolded.keys : NO_STACKS;
  const layout = React.useMemo(
    () => layoutExecution(execution, open),
    [execution, open],
  );
  const toggle = (key: string): void => {
    const keys = new Set(open);
    if (!keys.delete(key)) keys.add(key);
    setUnfolded({ caseId, keys });
  };
  // A selected record is never left inside a fold.
  const hiddenIn =
    props.selectedId === null ? undefined : layout.foldOf.get(props.selectedId);
  React.useEffect(() => {
    if (hiddenIn === undefined) return;
    setUnfolded((current) => ({
      caseId,
      keys: new Set([
        ...(current.caseId === caseId ? current.keys : []),
        hiddenIn,
      ]),
    }));
  }, [caseId, hiddenIn]);

  const scroller = React.useRef<HTMLDivElement>(null);
  const arrow = React.useId();
  const [zoom, setZoom] = React.useState(1);
  const drag = React.useRef<{
    pointer: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const fit = React.useCallback(
    (least: number): void => {
      const view = scroller.current;
      if (view === null || layout.width === 0 || layout.height === 0) return;
      setZoom(
        clampZoom(
          Math.max(
            least,
            Math.min(
              1,
              view.clientWidth / layout.width,
              view.clientHeight / layout.height,
            ),
          ),
        ),
      );
    },
    [layout.height, layout.width],
  );

  // The first view of a Case shows as much as stays readable, with its first
  // record in the middle of the height. Later pages of the same Case do not
  // move the view.
  const fitFirst = React.useRef(fit);
  fitFirst.current = fit;
  const firstView = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    fitFirst.current(MIN_FIRST_ZOOM);
    firstView.current = caseId;
  }, [caseId]);
  const firstY = layout.nodes[0]?.y ?? null;
  React.useLayoutEffect(() => {
    const view = scroller.current;
    if (view === null || firstView.current !== caseId || firstY === null)
      return;
    firstView.current = null;
    view.scrollTo({
      left: 0,
      top: Math.max(
        0,
        (firstY + EXECUTION_NODE_HEIGHT / 2) * zoom - view.clientHeight / 2,
      ),
    });
  }, [caseId, firstY, zoom]);

  // The wheel with the Control or the Command key changes the zoom, as in a
  // map. A plain wheel scrolls.
  React.useEffect(() => {
    const view = scroller.current;
    if (view === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((current) => clampZoom(current * (event.deltaY < 0 ? 1.1 : 0.9)));
    };
    view.addEventListener("wheel", onWheel, { passive: false });
    return () => view.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="brain-canvas">
      <ExecutionLegend />
      <div className="brain-canvas-tools" role="group" aria-label="Zoom">
        <button
          type="button"
          className="brain-canvas-tool"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((current) => clampZoom(current - 0.1))}
        >
          <Minus size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <span className="brain-canvas-zoom" aria-live="polite">
          {String(Math.round(zoom * 100))}%
        </span>
        <button
          type="button"
          className="brain-canvas-tool"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((current) => clampZoom(current + 0.1))}
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="brain-canvas-tool brain-canvas-fit"
          onClick={() => fit(MIN_ZOOM)}
        >
          <Maximize size={14} strokeWidth={1.6} aria-hidden="true" />
          Fit to view
        </button>
      </div>
      <div
        className="brain-canvas-scroll"
        ref={scroller}
        role="group"
        aria-label="Execution graph. Each box is one record. Columns go from cause to result."
        tabIndex={0}
        onPointerDown={(event) => {
          // A record takes its own click. The background starts a drag.
          if (event.button !== 0 || event.target instanceof HTMLButtonElement)
            return;
          if ((event.target as Element).closest("button") !== null) return;
          const view = event.currentTarget;
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: view.scrollLeft,
            top: view.scrollTop,
          };
          view.setPointerCapture(event.pointerId);
          view.dataset.dragging = "true";
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === null || start.pointer !== event.pointerId) return;
          event.currentTarget.scrollLeft =
            start.left - (event.clientX - start.x);
          event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer !== event.pointerId) return;
          drag.current = null;
          delete event.currentTarget.dataset.dragging;
        }}
        onPointerCancel={(event) => {
          drag.current = null;
          delete event.currentTarget.dataset.dragging;
        }}
      >
        <div
          className="brain-canvas-extent"
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className="brain-canvas-plane"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${String(zoom)})`,
            }}
          >
            {layout.headings.map((heading) => (
              <div
                key={`${heading.stage}:${String(heading.x)}`}
                className="brain-canvas-heading"
                style={{ left: heading.x, width: heading.width }}
              >
                {stageLabel(heading.stage)}
              </div>
            ))}
            {layout.lanes.map((lane, index) =>
              index === 0 ? null : (
                <div
                  key={lane.lane}
                  className="brain-canvas-lane"
                  style={{ top: lane.top - 18, width: layout.width }}
                >
                  {lane.assignmentNodeId === null ? (
                    <span>Not linked to an assignment</span>
                  ) : null}
                </div>
              ),
            )}
            {/* The links are drawn for the eye. The detail of a record lists
                the same links in words. */}
            <svg
              className="brain-canvas-edges"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={arrow}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto"
                >
                  <path d="M 0 0.5 L 7.5 4 L 0 7.5 z" />
                </marker>
              </defs>
              {layout.edges.map((entry) => (
                <path
                  key={entry.key}
                  className="brain-canvas-edge"
                  data-active={
                    props.selectedId !== null &&
                    (entry.from === props.selectedId ||
                      entry.to === props.selectedId)
                      ? "true"
                      : undefined
                  }
                  d={entry.path}
                  markerEnd={`url(#${arrow})`}
                />
              ))}
            </svg>
            {layout.nodes.map((entry) => (
              <CanvasNode
                key={entry.node.nodeId}
                node={entry.node}
                x={entry.x}
                y={entry.y}
                selected={props.selectedId === entry.node.nodeId}
                onSelect={props.onSelect}
              />
            ))}
            {layout.folds.map((fold) => (
              <button
                key={fold.key}
                type="button"
                className="brain-canvas-fold"
                style={{
                  left: fold.x,
                  top: fold.y,
                  width: EXECUTION_NODE_WIDTH,
                  height: EXECUTION_NODE_HEIGHT,
                }}
                aria-expanded={fold.hidden === 0}
                onClick={() => toggle(fold.key)}
              >
                {foldLabel(fold)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const NO_STACKS: ReadonlySet<string> = new Set();

function foldLabel(fold: ExecutionFold): string {
  if (fold.hidden === 0) return "Show fewer";
  if (fold.kind === null) return `${String(fold.hidden)} more records`;
  const kind = kindLabel(fold.kind).toLowerCase();
  return `${String(fold.hidden)} more ${fold.hidden === 1 ? kind : `${kind}s`}`;
}

/**
 * The line under a box's title: its state, and its kind when the title does
 * not say it. A withheld box shows "Withheld" as its title and its kind here.
 */
function nodeMeta(node: CaseExecutionNode): string {
  if (node.access === "withheld") return kindLabel(node.kind);
  const state = nodeStatus(node).label;
  return titleNamesKind(node) ? state : `${kindLabel(node.kind)} · ${state}`;
}

function CanvasNode(props: {
  readonly node: CaseExecutionNode;
  readonly x: number;
  readonly y: number;
  readonly selected: boolean;
  readonly onSelect: (node: CaseExecutionNode) => void;
}): React.ReactNode {
  const { node } = props;
  const mark = stateMark(node);
  const Icon = stateMarkIcon(mark);
  return (
    <button
      type="button"
      className="brain-canvas-node"
      data-mark={mark}
      style={{
        left: props.x,
        top: props.y,
        width: EXECUTION_NODE_WIDTH,
        height: EXECUTION_NODE_HEIGHT,
      }}
      aria-pressed={props.selected}
      onClick={props.onSelect.bind(null, node)}
    >
      <span className="brain-canvas-node-title">
        {node.access === "withheld" ? "Withheld" : nodeTitle(node)}
      </span>
      <Icon
        className="brain-canvas-node-mark"
        size={16}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="brain-canvas-node-meta">{nodeMeta(node)}</span>
    </button>
  );
}
