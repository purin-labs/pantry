import {
  MENU_BOARD_DEFAULT_CONSTRAINTS,
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_MAX_COORDINATE,
  MENU_BOARD_MIN_SIDE,
  MENU_BOARD_SCREEN_SIZES,
  resolveCanvasRect,
  type MenuBoardCanvasPlacement,
  type MenuBoardElement,
  type MenuBoardFramePlacement,
  type MenuBoardLayout,
  type MenuBoardRect,
} from "@purin-labs/menu-board-crdt/board";
import type { MenuBoardElementPlacement } from "@purin-labs/menu-board-crdt";

/**
 * The geometry of the free canvas editor (Plan 40B phase 5): snapping with
 * smart guides, resize handles, align and distribute, and the move between
 * a fixed layout and the canvas. All values are board units.
 */

const SNAP_DISTANCE = 8;
const GRID = 8;

type Size = Readonly<{ width: number; height: number }>;

/** A guide line that a snap used: vertical at x, or horizontal at y. */
export type Guide = Readonly<{ axis: "x" | "y"; at: number }>;

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function canvasPlacement(element: MenuBoardElement): MenuBoardCanvasPlacement | null {
  return element.placement.frameId === "canvas" ? element.placement : null;
}

export function boundsOf(rects: readonly MenuBoardRect[]): MenuBoardRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The rectangle between two points of a marquee drag (Plan 40B phase 5,
 * slice 4), in board units.
 */
export function marqueeRect(
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }>,
): MenuBoardRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/**
 * The elements that a marquee touches. As in Figma, an element that the
 * marquee only crosses is selected too, not only one inside it.
 */
export function marqueeSelection(
  marquee: MenuBoardRect,
  rects: ReadonlyMap<string, MenuBoardRect>,
): string[] {
  const touched: string[] = [];
  for (const [id, rect] of rects)
    if (
      rect.x < marquee.x + marquee.width &&
      marquee.x < rect.x + rect.width &&
      rect.y < marquee.y + marquee.height &&
      marquee.y < rect.y + rect.height
    )
      touched.push(id);
  return touched;
}

function clampCoordinate(value: number): number {
  return Math.max(-MENU_BOARD_MAX_COORDINATE, Math.min(MENU_BOARD_MAX_COORDINATE, Math.round(value)));
}

function clampSide(value: number): number {
  return Math.max(MENU_BOARD_MIN_SIDE, Math.min(MENU_BOARD_MAX_COORDINATE, Math.round(value)));
}

export function normalizeRect(rect: MenuBoardRect): MenuBoardRect {
  return {
    x: clampCoordinate(rect.x),
    y: clampCoordinate(rect.y),
    width: clampSide(rect.width),
    height: clampSide(rect.height),
  };
}

/** The lines that a moving box can snap to: other boxes and the board. */
function targets(others: readonly MenuBoardRect[], board: Size): Readonly<{ x: number[]; y: number[] }> {
  const x = [0, board.width / 2, board.width];
  const y = [0, board.height / 2, board.height];
  for (const rect of others) {
    x.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width);
    y.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height);
  }
  return { x, y };
}

/** The nearest snap of any of `edges` to any target, within the distance. */
function nearest(edges: readonly number[], lines: readonly number[]): Readonly<{ delta: number; at: number }> | null {
  let best: { delta: number; at: number } | null = null;
  for (const edge of edges)
    for (const line of lines) {
      const delta = line - edge;
      if (Math.abs(delta) <= SNAP_DISTANCE && (best === null || Math.abs(delta) < Math.abs(best.delta)))
        best = { delta, at: line };
    }
  return best;
}

function toGrid(value: number): number {
  return Math.round(value / GRID) * GRID;
}

/**
 * A moved box: its edges and centre snap to the other boxes and the board,
 * as smart guides do; with no guide near, its corner snaps to the grid.
 * `free` turns snapping off, for a person who holds Alt.
 */
export function snapMove(
  box: MenuBoardRect,
  others: readonly MenuBoardRect[],
  board: Size,
  free: boolean,
): Readonly<{ rect: MenuBoardRect; guides: readonly Guide[] }> {
  if (free) return { rect: normalizeRect(box), guides: [] };
  const lines = targets(others, board);
  const snapX = nearest([box.x, box.x + box.width / 2, box.x + box.width], lines.x);
  const snapY = nearest([box.y, box.y + box.height / 2, box.y + box.height], lines.y);
  const guides: Guide[] = [];
  if (snapX !== null) guides.push({ axis: "x", at: snapX.at });
  if (snapY !== null) guides.push({ axis: "y", at: snapY.at });
  return {
    rect: normalizeRect({
      ...box,
      x: snapX === null ? toGrid(box.x) : box.x + snapX.delta,
      y: snapY === null ? toGrid(box.y) : box.y + snapY.delta,
    }),
    guides,
  };
}

/**
 * A box resized by one handle and a pointer delta. The moving edges snap to
 * guides as a move does. Shift keeps the box's proportions.
 */
export function resizeRect(
  start: MenuBoardRect,
  handle: Handle,
  dx: number,
  dy: number,
  others: readonly MenuBoardRect[],
  board: Size,
  modifiers: Readonly<{ free: boolean; keepRatio: boolean }>,
): Readonly<{ rect: MenuBoardRect; guides: readonly Guide[] }> {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;
  const guides: Guide[] = [];
  if (!modifiers.free) {
    const lines = targets(others, board);
    const snapEdge = (value: number, axis: "x" | "y"): number => {
      const snap = nearest([value], axis === "x" ? lines.x : lines.y);
      if (snap === null) return toGrid(value);
      guides.push({ axis, at: snap.at });
      return value + snap.delta;
    };
    if (handle.includes("w")) left = snapEdge(left, "x");
    if (handle.includes("e")) right = snapEdge(right, "x");
    if (handle.includes("n")) top = snapEdge(top, "y");
    if (handle.includes("s")) bottom = snapEdge(bottom, "y");
  }
  if (right - left < MENU_BOARD_MIN_SIDE) {
    if (handle.includes("w")) left = right - MENU_BOARD_MIN_SIDE;
    else right = left + MENU_BOARD_MIN_SIDE;
  }
  if (bottom - top < MENU_BOARD_MIN_SIDE) {
    if (handle.includes("n")) top = bottom - MENU_BOARD_MIN_SIDE;
    else bottom = top + MENU_BOARD_MIN_SIDE;
  }
  if (modifiers.keepRatio && start.height > 0 && handle.length === 2) {
    const ratio = start.width / start.height;
    const width = right - left;
    const height = Math.max(MENU_BOARD_MIN_SIDE, Math.round(width / ratio));
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
  }
  return { rect: normalizeRect({ x: left, y: top, width: right - left, height: bottom - top }), guides };
}

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Aligns the boxes to the edge or centre of their joint bounds. */
export function align(rects: ReadonlyMap<string, MenuBoardRect>, alignment: Alignment): Map<string, MenuBoardRect> {
  const bounds = boundsOf([...rects.values()]);
  const result = new Map<string, MenuBoardRect>();
  if (bounds === null) return result;
  for (const [id, rect] of rects) {
    switch (alignment) {
      case "left":
        result.set(id, { ...rect, x: bounds.x });
        break;
      case "center":
        result.set(id, { ...rect, x: Math.round(bounds.x + (bounds.width - rect.width) / 2) });
        break;
      case "right":
        result.set(id, { ...rect, x: bounds.x + bounds.width - rect.width });
        break;
      case "top":
        result.set(id, { ...rect, y: bounds.y });
        break;
      case "middle":
        result.set(id, { ...rect, y: Math.round(bounds.y + (bounds.height - rect.height) / 2) });
        break;
      case "bottom":
        result.set(id, { ...rect, y: bounds.y + bounds.height - rect.height });
        break;
      default:
        return alignment satisfies never;
    }
  }
  return result;
}

/**
 * Spaces three or more boxes with equal gaps between the first and the last,
 * along one axis.
 */
export function distribute(rects: ReadonlyMap<string, MenuBoardRect>, axis: "x" | "y"): Map<string, MenuBoardRect> {
  const sorted = [...rects.entries()].sort((first, second) =>
    axis === "x" ? first[1].x - second[1].x : first[1].y - second[1].y);
  const result = new Map<string, MenuBoardRect>();
  if (sorted.length < 3) return result;
  const side = (rect: MenuBoardRect): number => (axis === "x" ? rect.width : rect.height);
  const start = (rect: MenuBoardRect): number => (axis === "x" ? rect.x : rect.y);
  const first = sorted[0]?.[1];
  const last = sorted.at(-1)?.[1];
  if (first === undefined || last === undefined) return result;
  const span = start(last) + side(last) - start(first);
  const total = sorted.reduce((sum, [, rect]) => sum + side(rect), 0);
  const gap = (span - total) / (sorted.length - 1);
  let cursor = start(first);
  for (const [id, rect] of sorted) {
    const at = Math.round(cursor);
    result.set(id, axis === "x" ? { ...rect, x: at } : { ...rect, y: at });
    cursor += side(rect) + gap;
  }
  return result;
}

/** The new canvas placements of moved boxes, with their order and constraints. */
export function placementsFor(
  elements: readonly MenuBoardElement[],
  rects: ReadonlyMap<string, MenuBoardRect>,
): MenuBoardElementPlacement[] {
  const placements: MenuBoardElementPlacement[] = [];
  for (const element of elements) {
    const placement = canvasPlacement(element);
    const rect = rects.get(element.id);
    if (placement === null || rect === undefined) continue;
    const next = normalizeRect(rect);
    if (
      next.x === placement.rect.x &&
      next.y === placement.rect.y &&
      next.width === placement.rect.width &&
      next.height === placement.rect.height
    )
      continue;
    placements.push({ elementId: element.id, placement: { ...placement, rect: next } });
  }
  return placements;
}

/** The stacking orders after bringing the selection to the front or back. */
export function restack(
  elements: readonly MenuBoardElement[],
  selected: ReadonlySet<string>,
  direction: "front" | "back" | "forward" | "backward",
): MenuBoardElementPlacement[] {
  const canvas = elements
    .flatMap((element) => (element.placement.frameId === "canvas" ? [element] : []))
    .sort((first, second) => first.placement.order - second.placement.order || first.id.localeCompare(second.id));
  const ids = canvas.map((element) => element.id);
  if (direction === "front" || direction === "back") {
    const moved = ids.filter((id) => selected.has(id));
    const rest = ids.filter((id) => !selected.has(id));
    ids.splice(0, ids.length, ...(direction === "front" ? [...rest, ...moved] : [...moved, ...rest]));
  } else {
    const step = direction === "forward" ? 1 : -1;
    const indexes = ids.map((_, index) => index);
    const order = step === 1 ? indexes.reverse() : indexes;
    for (const index of order) {
      const id = ids[index];
      const swap = index + step;
      const other = ids[swap];
      if (id === undefined || other === undefined || !selected.has(id) || selected.has(other)) continue;
      ids[index] = other;
      ids[swap] = id;
    }
  }
  const placements: MenuBoardElementPlacement[] = [];
  ids.forEach((id, order) => {
    const element = canvas.find((candidate) => candidate.id === id);
    if (element === undefined || element.placement.frameId !== "canvas" || element.placement.order === order) return;
    placements.push({ elementId: id, placement: { ...element.placement, order } });
  });
  return placements;
}

/**
 * The canvas placements of a fixed layout's elements, from the boxes that
 * the browser drew for them (`measured`, in board units). The free canvas
 * then starts from what the person saw.
 */
export function toCanvas(
  elements: readonly MenuBoardElement[],
  measured: ReadonlyMap<string, MenuBoardRect>,
  from: Size,
  layout: MenuBoardLayout,
): MenuBoardElementPlacement[] {
  const to = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[layout].shape];
  return elements.map((element, order) => {
    const drawn = measured.get(element.id) ?? { x: 48, y: 48 + order * 40, width: 400, height: 120 };
    const constraints = element.kind === "heading"
      ? { horizontal: "stretch", vertical: "top" } as const
      : MENU_BOARD_DEFAULT_CONSTRAINTS;
    return {
      elementId: element.id,
      placement: {
        frameId: "canvas",
        order,
        rect: normalizeRect(resolveCanvasRect(drawn, { horizontal: "scale", vertical: "scale" }, from, to)),
        constraints,
      },
    };
  });
}

/** Canvas placements for another screen shape, by each element's constraints. */
export function toShape(
  elements: readonly MenuBoardElement[],
  from: MenuBoardLayout,
  to: MenuBoardLayout,
): MenuBoardElementPlacement[] {
  const fromSize = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[from].shape];
  const toSize = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[to].shape];
  return elements.flatMap((element) => {
    const placement = canvasPlacement(element);
    if (placement === null) return [];
    return [{
      elementId: element.id,
      placement: {
        ...placement,
        rect: normalizeRect(resolveCanvasRect(placement.rect, placement.constraints, fromSize, toSize)),
      },
    }];
  });
}

/**
 * Frame placements for a fixed layout, from canvas boxes: a heading goes to
 * the header, the QR code to a portrait board's footer, and every other
 * element to the column under its centre, in top-to-bottom order.
 */
export function toFrames(
  elements: readonly MenuBoardElement[],
  from: Size,
  layout: MenuBoardLayout,
): MenuBoardElementPlacement[] {
  const frames = MENU_BOARD_LAYOUTS[layout].frames;
  const columns = frames.filter((frame): frame is MenuBoardFramePlacement["frameId"] => frame.startsWith("column_"));
  const sorted = [...elements].sort((first, second) => top(first) - top(second) || left(first) - left(second));
  const orders = new Map<string, number>();
  return sorted.map((element) => {
    const placement = canvasPlacement(element);
    const centre = placement === null ? 0 : (placement.rect.x + placement.rect.width / 2) / from.width;
    let frameId: MenuBoardFramePlacement["frameId"];
    if (element.kind === "heading" && frames.includes("header")) frameId = "header";
    else if (element.kind === "order_qr" && frames.includes("footer")) frameId = "footer";
    else frameId = columns[Math.min(columns.length - 1, Math.max(0, Math.floor(centre * columns.length)))] ?? "column_1";
    const order = orders.get(frameId) ?? 0;
    orders.set(frameId, order + 1);
    return { elementId: element.id, placement: { frameId, order } };
  });
}

function top(element: MenuBoardElement): number {
  return element.placement.frameId === "canvas" ? element.placement.rect.y : element.placement.order;
}

function left(element: MenuBoardElement): number {
  return element.placement.frameId === "canvas" ? element.placement.rect.x : 0;
}
