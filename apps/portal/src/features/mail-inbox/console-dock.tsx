import React from "react";

import { useConsoleDock } from "@purin-labs/ui/console-tools";
import { OverflowToolbar } from "@purin-labs/ui/overflow-toolbar";
import "@purin-labs/ui/resize-handle.css";

const WIDTH_KEY = "pantry:inbox-console-dock-width";
/** The dock's least width before a measure. */
const MIN_WIDTH = 112;
/** The pane's least room for the conversation before a measure. */
const PANE_RESERVE = 200;
/** The title keeps its one-line width, up to this many pixels. */
const TITLE_ROOM = 256;
/** The conversation's ellipsis and the space around it. */
const PANE_TOOLS_ROOM = 48;
const OVERFLOW_ROOM = 32;
const KEY_STEP = 16;

/**
 * The console's tools at the top right of the conversation pane, on the row
 * of the conversation's own tools. The handle between the two groups moves:
 * the group with less room keeps what fits and puts the rest behind an
 * ellipsis. The pane's bars read the dock's width from
 * `--mail-console-dock`.
 */
export function MailConsoleDock(
  props: Readonly<{
    /** A conversation is open, so its tools share the row. */
    shared: boolean;
  }>,
): React.ReactNode {
  const items = useConsoleDock();
  const dock = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState<number | null>(storedWidth);
  React.useEffect(publishDockWidth.bind(null, dock), [items !== null]);
  // The open conversation changes the room that its title needs.
  React.useLayoutEffect(publishLimits.bind(null, dock));
  if (items === null) return null;
  return (
    <div
      ref={dock}
      className="mail-console-dock portal-workspace-header"
      style={
        width === null || !props.shared
          ? undefined
          : ({ "--mail-console-dock-set": `${width}px` } as React.CSSProperties)
      }
    >
      <div className="portal-nav">
        {props.shared ? (
          <div
            className="mail-console-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to share the row"
            aria-valuemin={Math.round(minWidth(dock.current))}
            aria-valuemax={maxWidth(dock.current)}
            aria-valuenow={Math.round(
              width ?? dock.current?.getBoundingClientRect().width ?? MIN_WIDTH,
            )}
            tabIndex={0}
            data-resize-handle=""
            onPointerDown={startDrag.bind(null, dock, setWidth)}
            onDoubleClick={resetWidth.bind(null, setWidth)}
            onKeyDown={stepWidth.bind(null, dock, setWidth)}
          />
        ) : null}
        <OverflowToolbar
          className="mail-console-tools"
          items={items}
          overflowLabel="More console tools"
        />
      </div>
    </div>
  );
}

function storedWidth(): number | null {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(WIDTH_KEY);
    else window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // The width stays for this visit only.
  }
}

/**
 * The least width: the handle, the ellipsis and the account. The account
 * never moves, so the dock never becomes narrower than this.
 */
function minWidth(dock: HTMLElement | null): number {
  const tools = dock?.querySelector<HTMLElement>(".mail-console-tools");
  if (dock == null || tools == null) return MIN_WIDTH;
  const box = dock.getBoundingClientRect();
  const row = tools.getBoundingClientRect();
  const gap = Number.parseFloat(getComputedStyle(tools).columnGap) || 0;
  let pinned = 0;
  for (const item of tools.querySelectorAll<HTMLElement>(
    ":scope > .overflow-toolbar-item[data-key='account']",
  )) {
    pinned += item.getBoundingClientRect().width + gap;
  }
  return Math.ceil(
    row.left - box.left + OVERFLOW_ROOM + pinned + (box.right - row.right),
  );
}

/**
 * The largest width: the open conversation keeps its title on one line, up
 * to TITLE_ROOM, and room for its ellipsis.
 */
function maxWidth(dock: HTMLElement | null): number {
  const pane = dock?.parentElement;
  if (dock == null || pane == null) return MIN_WIDTH;
  const bar = visibleBar(pane);
  const reserve =
    bar === null
      ? PANE_RESERVE
      : Number.parseFloat(getComputedStyle(bar).paddingInlineStart) +
        titleRoom(bar) +
        PANE_TOOLS_ROOM;
  return Math.max(minWidth(dock), pane.clientWidth - reserve);
}

function visibleBar(pane: HTMLElement): HTMLElement | null {
  for (const bar of pane.querySelectorAll<HTMLElement>(".mail-case-bar")) {
    if (bar.offsetParent !== null) return bar;
  }
  return null;
}

let measureCanvas: HTMLCanvasElement | null = null;

/** The one-line width of the title or the channel, whichever is wider. */
function titleRoom(bar: HTMLElement): number {
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (context === null) return TITLE_ROOM;
  let widest = 0;
  for (const text of bar.querySelectorAll<HTMLElement>(
    ".mail-case-heading > *",
  )) {
    const style = getComputedStyle(text);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    widest = Math.max(
      widest,
      context.measureText(text.textContent ?? "").width,
    );
  }
  return Math.min(TITLE_ROOM, Math.ceil(widest) + 2);
}

function clampWidth(dock: HTMLElement | null, width: number): number {
  return Math.min(maxWidth(dock), Math.max(minWidth(dock), width));
}

/**
 * A stored width also gives way to the title and to the account. The title
 * keeps its one-line room, so the conversation's tools give way first.
 */
function publishLimits(dock: React.RefObject<HTMLDivElement | null>): void {
  const element = dock.current;
  if (element === null) return;
  const pane = element.parentElement;
  const bar = pane === null ? null : visibleBar(pane);
  if (pane !== null) {
    if (bar === null) pane.style.removeProperty("--mail-case-title-room");
    else
      pane.style.setProperty("--mail-case-title-room", `${titleRoom(bar)}px`);
  }
  element.style.setProperty(
    "--mail-console-dock-min",
    `${minWidth(element)}px`,
  );
  element.style.setProperty(
    "--mail-console-dock-max",
    `${maxWidth(element)}px`,
  );
}

/** The pane's bars keep clear of the dock. */
function publishDockWidth(
  dock: React.RefObject<HTMLDivElement | null>,
): (() => void) | undefined {
  const element = dock.current;
  const pane = element?.parentElement;
  if (element == null || pane == null) return;
  const publish = setPaneProperty.bind(null, pane, element);
  publish();
  if (typeof ResizeObserver === "undefined") {
    return stopPublishing.bind(null, null, pane);
  }
  const observer = new ResizeObserver(publish);
  observer.observe(element);
  return stopPublishing.bind(null, observer, pane);
}

function setPaneProperty(pane: HTMLElement, dock: HTMLElement): void {
  pane.style.setProperty(
    "--mail-console-dock",
    `${dock.getBoundingClientRect().width}px`,
  );
}

function stopPublishing(
  observer: ResizeObserver | null,
  pane: HTMLElement,
): void {
  observer?.disconnect();
  pane.style.removeProperty("--mail-console-dock");
  pane.style.removeProperty("--mail-case-title-room");
}

function startDrag(
  dock: React.RefObject<HTMLDivElement | null>,
  setWidth: React.Dispatch<React.SetStateAction<number | null>>,
  event: React.PointerEvent<HTMLDivElement>,
): void {
  const element = dock.current;
  if (element === null || event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const drag: Drag = {
    startX: event.clientX,
    startWidth: element.getBoundingClientRect().width,
    width: null,
  };
  const move = dragTo.bind(null, element, drag, setWidth);
  const end = endDrag.bind(null, handle, drag, move);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end, { once: true });
  handle.addEventListener("pointercancel", end, { once: true });
}

type Drag = {
  readonly startX: number;
  readonly startWidth: number;
  width: number | null;
};

/** The dock stands at the right, so a move to the left widens it. */
function dragTo(
  dock: HTMLElement,
  drag: Drag,
  setWidth: React.Dispatch<React.SetStateAction<number | null>>,
  event: PointerEvent,
): void {
  const width = clampWidth(
    dock,
    drag.startWidth - (event.clientX - drag.startX),
  );
  drag.width = width;
  setWidth(width);
}

function endDrag(
  handle: HTMLElement,
  drag: Drag,
  move: (event: PointerEvent) => void,
): void {
  handle.removeEventListener("pointermove", move);
  if (drag.width !== null) storeWidth(drag.width);
}

function resetWidth(
  setWidth: React.Dispatch<React.SetStateAction<number | null>>,
): void {
  setWidth(null);
  storeWidth(null);
}

function stepWidth(
  dock: React.RefObject<HTMLDivElement | null>,
  setWidth: React.Dispatch<React.SetStateAction<number | null>>,
  event: React.KeyboardEvent<HTMLDivElement>,
): void {
  const element = dock.current;
  if (element === null) return;
  const current = element.getBoundingClientRect().width;
  let next: number | null;
  switch (event.key) {
    case "ArrowLeft":
      next = current + KEY_STEP;
      break;
    case "ArrowRight":
      next = current - KEY_STEP;
      break;
    case "Home":
      next = maxWidth(element);
      break;
    case "End":
      next = MIN_WIDTH;
      break;
    case "Enter":
      event.preventDefault();
      resetWidth(setWidth);
      return;
    default:
      return;
  }
  event.preventDefault();
  const width = clampWidth(element, next);
  setWidth(width);
  storeWidth(width);
}
