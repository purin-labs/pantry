import React from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import type { BoardSize } from "./board-view";

/**
 * The work area of the board editor: an endless canvas behind the floating
 * panels, as in a design tool. The board sits on it at a zoom; the person
 * pans with a drag on the empty area, Space and a drag, or, once the board
 * is no longer fitted, the scroll wheel,
 * and zooms with Ctrl or Cmd and the wheel, a pinch, or the zoom buttons.
 * The board fits the space between the panels until the person zooms or
 * pans, and again when the board or its shape changes.
 */

type View = Readonly<{ zoom: number; x: number; y: number; fit: boolean }>;

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** A drag on the empty area shorter than this is a click. */
const CLICK_DISTANCE = 3;

export function BoardViewport(props: Readonly<{
  /** The board's size in board units. */
  design: BoardSize;
  /** A change fits the board again: another board, layout or shape. */
  fitKey: string;
  /** Draws the board at a width in pixels. */
  children: (width: number) => React.ReactNode;
  /**
   * Drawn on the board's stage, in the stage's pixels (comment pins, screen
   * guides); a function gets the board's width in pixels.
   */
  stageChildren?: React.ReactNode | ((width: number) => React.ReactNode);
  stageRef?: React.RefObject<HTMLDivElement | null>;
  /** Shown beside the zoom buttons. */
  footer?: React.ReactNode;
  /** The board's name above it, as the frame name in a design tool. */
  label?: string;
  /** A click on the empty area, not on the board. */
  onBackgroundClick?: () => void;
  /**
   * A rect in board units that the view keeps in its middle (Plan 40B phase
   * 7, Follow). The view pans to it at once, with no motion, and keeps the
   * zoom; null leaves the view where it is.
   */
  follow?: Readonly<{ x: number; y: number; width: number; height: number }> | null;
  /** A drop on the canvas (a product from the Products panel). */
  drop?: Readonly<{
    accepts: (event: React.DragEvent) => boolean;
    onDrop: (event: React.DragEvent) => void;
  }>;
}>): React.ReactNode {
  const [dropping, setDropping] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState<View>({ zoom: 0, x: 0, y: 0, fit: true });
  const current = React.useRef(view);
  current.current = view;
  const [spaceHeld, setSpaceHeld] = React.useState(false);
  const [panning, setPanning] = React.useState(false);
  const pan = React.useRef<Readonly<{ pointerId: number; x: number; y: number; startX: number; startY: number; moved: boolean }> | null>(null);
  const { width, height } = props.design;
  const fit = React.useCallback((): void => {
    const element = root.current;
    if (element === null) return;
    const fitted = fittedView(element, { width, height });
    if (fitted !== null) setView(fitted);
  }, [width, height]);
  // The board fits again when it, its shape or the window changes, until the
  // person zooms or pans.
  React.useLayoutEffect(() => {
    fit();
  }, [fit, props.fitKey]);
  React.useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      if (current.current.fit) fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  const followKey = props.follow == null
    ? null
    : `${props.follow.x}:${props.follow.y}:${props.follow.width}:${props.follow.height}`;
  React.useLayoutEffect(() => {
    const element = root.current;
    const target = props.follow;
    if (element === null || target == null || followKey === null) return;
    setView((before) => {
      if (before.zoom === 0) return before;
      const x = element.clientWidth / 2 - (target.x + target.width / 2) * before.zoom;
      const y = element.clientHeight / 2 - (target.y + target.height / 2) * before.zoom;
      return before.x === x && before.y === y ? before : { ...before, x, y, fit: false };
    });
    // The key names the rect; a new object with the same rect does not pan.
  }, [followKey]);
  const zoomAt = React.useCallback((factor: number, point: Readonly<{ x: number; y: number }> | null): void => {
    const element = root.current;
    if (element === null) return;
    const box = element.getBoundingClientRect();
    const at = point ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    setView((before) => {
      const zoom = clamp(before.zoom * factor, ZOOM_MIN, ZOOM_MAX);
      const ratio = zoom / (before.zoom === 0 ? zoom : before.zoom);
      const localX = at.x - box.left;
      const localY = at.y - box.top;
      return { zoom, x: localX - (localX - before.x) * ratio, y: localY - (localY - before.y) * ratio, fit: false };
    });
  }, []);
  // React's wheel listener is passive, and a zoom must stop the page zoom.
  React.useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * scale * 0.002), { x: event.clientX, y: event.clientY });
        return;
      }
      // A fitted board stays still: all of it is in view, so a scroll has
      // nothing to show. After a zoom or a drag, a scroll pans.
      if (current.current.fit) return;
      const dx = (event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX) * scale;
      const dy = (event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY) * scale;
      setView((before) => ({ ...before, x: before.x - dx, y: before.y - dy, fit: false }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoomAt]);
  const zoomTo = React.useCallback((zoom: number): void => {
    zoomAt(zoom / (current.current.zoom === 0 ? zoom : current.current.zoom), null);
  }, [zoomAt]);
  // Space and a drag pans, as in a design tool; Shift 1 fits, Shift 0 is
  // 100%, and Ctrl or Cmd with + or − zooms. The keys act anywhere in the
  // workspace except in a field.
  React.useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (!inside(root.current, event.target)) return;
      if (event.code === "Space") {
        if (event.repeat || isControl(event.target)) return;
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (isField(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.shiftKey && !mod && event.code === "Digit1") fit();
      else if (event.shiftKey && !mod && event.code === "Digit0") zoomTo(1);
      else if (mod && (event.key === "=" || event.key === "+")) zoomAt(ZOOM_STEP, null);
      else if (mod && event.key === "-") zoomAt(1 / ZOOM_STEP, null);
      else return;
      event.preventDefault();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const blur = (): void => setSpaceHeld(false);
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [fit, zoomAt, zoomTo]);
  const beginPan = (event: React.PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    setPanning(true);
  };
  const movePan = (event: React.PointerEvent): void => {
    const state = pan.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    const moved = state.moved || Math.hypot(event.clientX - state.startX, event.clientY - state.startY) >= CLICK_DISTANCE;
    pan.current = { ...state, x: event.clientX, y: event.clientY, moved };
    if (moved) setView((before) => ({ ...before, x: before.x + dx, y: before.y + dy, fit: false }));
  };
  const endPan = (event: React.PointerEvent, background: boolean): void => {
    const state = pan.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    pan.current = null;
    setPanning(false);
    if (!state.moved && background) props.onBackgroundClick?.();
  };
  const boardWidth = width * view.zoom;
  return <div
    ref={root}
    className="menu-board-viewport"
    data-pan={spaceHeld ? "true" : undefined}
    data-panning={panning ? "true" : undefined}
    data-dropping={dropping ? "true" : undefined}
    onDragOver={(event) => {
      if (props.drop === undefined || !props.drop.accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!dropping) setDropping(true);
    }}
    onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropping(false);
    }}
    onDrop={(event) => {
      setDropping(false);
      if (props.drop === undefined || !props.drop.accepts(event)) return;
      event.preventDefault();
      props.drop.onDrop(event);
    }}
    onPointerDown={(event) => {
      // The middle button pans anywhere; the left button on the empty area.
      if (event.button === 1 || event.target === event.currentTarget) beginPan(event);
    }}
    onPointerMove={movePan}
    onPointerUp={(event) => endPan(event, true)}
    onPointerCancel={(event) => endPan(event, false)}
  >
    {view.zoom === 0 ? null : <div
      ref={props.stageRef}
      className="menu-board-stage"
      style={{ left: view.x, top: view.y, width: boardWidth }}
    >
      {props.label === undefined ? null : <span className="menu-board-stage-label" aria-hidden="true">{props.label}</span>}
      {props.children(boardWidth)}
      {typeof props.stageChildren === "function" ? props.stageChildren(boardWidth) : props.stageChildren}
    </div>}
    {spaceHeld ? <div
      className="menu-board-pan-shield"
      onPointerDown={beginPan}
      onPointerMove={movePan}
      onPointerUp={(event) => endPan(event, false)}
      onPointerCancel={(event) => endPan(event, false)}
    /> : null}
    <div className="menu-board-float menu-board-zoom" role="group" aria-label="Zoom">
      <button type="button" className="menu-board-icon-button" aria-label="Zoom out" title="Zoom out (Ctrl −)" onClick={() => zoomAt(1 / ZOOM_STEP, null)}>
        <Minus size={16} aria-hidden="true" />
      </button>
      <button type="button" className="menu-board-zoom-level" aria-label="Zoom to 100%" title="Zoom to 100% (Shift 0)" onClick={() => zoomTo(1)}>
        {Math.round(view.zoom * 100)}%
      </button>
      <button type="button" className="menu-board-icon-button" aria-label="Zoom in" title="Zoom in (Ctrl +)" onClick={() => zoomAt(ZOOM_STEP, null)}>
        <Plus size={16} aria-hidden="true" />
      </button>
      <button type="button" className="menu-board-icon-button" aria-label="Zoom to fit" aria-pressed={view.fit} title="Zoom to fit (Shift 1)" onClick={fit}>
        <Maximize size={15} aria-hidden="true" />
      </button>
    </div>
    {props.footer === undefined ? null : <div className="menu-board-float menu-board-view-footer">{props.footer}</div>}
  </div>;
}

/** The space that a fitted board keeps from a floating panel. */
const FIT_MARGIN = 32;

/**
 * The zoom and place that fit the board in the free space: the viewport
 * less the floating panels that cover it.
 */
function fittedView(element: HTMLElement, design: BoardSize): View | null {
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0 || design.width === 0 || design.height === 0) return null;
  const workspace = element.closest(".menu-board-workspace") ?? element;
  const covered = (selector: string): DOMRect | null => {
    const node = workspace.querySelector(selector);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    const overlaps = rect.width > 0 && rect.height > 0 && rect.left < box.right && rect.right > box.left &&
      rect.top < box.bottom && rect.bottom > box.top;
    return overlaps ? rect : null;
  };
  const start = covered(".menu-board-panel-start");
  const end = covered(".menu-board-panel-end");
  const toolbar = covered(".menu-board-toolbar");
  const zoomBar = covered(".menu-board-view-footer");
  const left = (start === null ? 0 : start.right - box.left) + FIT_MARGIN;
  const right = (end === null ? 0 : box.right - end.left) + FIT_MARGIN;
  const top = (toolbar === null ? 0 : toolbar.bottom - box.top) + FIT_MARGIN;
  const bottom = (zoomBar === null ? 0 : box.bottom - zoomBar.top) + FIT_MARGIN;
  const room = { width: Math.max(80, box.width - left - right), height: Math.max(80, box.height - top - bottom) };
  const zoom = clamp(Math.min(room.width / design.width, room.height / design.height, 1), ZOOM_MIN, ZOOM_MAX);
  return {
    zoom,
    x: left + (room.width - design.width * zoom) / 2,
    y: top + (room.height - design.height * zoom) / 2,
    fit: true,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function inside(root: HTMLElement | null, target: EventTarget | null): boolean {
  const workspace = root?.closest(".menu-board-workspace") ?? root;
  return target instanceof Node && workspace !== null && workspace !== undefined && (workspace.contains(target) || target === document.body);
}

function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** A field or a button: Space acts on it, not on the canvas. */
function isControl(target: EventTarget | null): boolean {
  return isField(target) || target instanceof HTMLButtonElement;
}
