import {
  NODE_COLUMN,
  NODE_HEIGHT,
  NODE_ROW,
  NODE_WIDTH,
} from "@purin-labs/bakery-workflow/layout";
import React from "react";
import type { RecipeGraphEdge, RecipeGraphNode } from "./recipe-graph";

export const WIDTH = NODE_WIDTH;
export const HEIGHT = NODE_HEIGHT;
/** A wire is a curve when it has this much room, and it runs through a gap otherwise. */
const WIRE_REACH = 14;
const WIRE_CORNER = 14;
/** From the edge of a card to the centre of its port. */
const PORT_CENTRE = 15;
/** The label above a step: its kind and its seconds. */
const LABEL_ROOM = 20;
/** The floating bars stand 12px from the edge of the workspace, 8px apart. */
const CHROME_EDGE = 12;
const CHROME_GAP = 8;

/** What flows out of a step. A port and its wire share the color and the icon. */
export type PortKind = RecipeGraphNode["role"] | "workflow";

/** A proposal that a person reviews. The shared draft stays as it is under it. */
export type ChromeParts = Readonly<
  Record<
    | "header"
    | "end"
    | "stages"
    | "summary"
    | "footer"
    | "notices"
    | "tools"
    | "result",
    Element | null
  >
>;

/**
 * The header and the draft group share the first row when both fit, and the group
 * moves under the header when they do not. The stages and the summary stack below
 * them; the tools sit on the footer.
 */
export function chromeOffsets(
  parts: ChromeParts,
  width: number,
  workspaceWidth = width,
): ReadonlyArray<readonly [string, number]> {
  const beside =
    shownWidth(parts.header) + shownWidth(parts.end) + CHROME_EDGE * 3 <= width;
  const endTop = beside ? CHROME_EDGE : below(CHROME_EDGE, parts.header);
  const row = Math.max(shownHeight(parts.header), shownHeight(parts.end));
  const top = !beside
    ? below(endTop, parts.end)
    : row === 0
      ? CHROME_EDGE
      : CHROME_EDGE + row + CHROME_GAP;
  const summary = below(top, parts.stages);
  const statusCrowded =
    CHROME_EDGE + shownWidth(parts.header) + CHROME_GAP >
    workspaceWidth - 340;
  const statusTop = statusCrowded
    ? Math.max(64, below(CHROME_EDGE, parts.header))
    : 64;
  return [
    ["--chrome-end-top", endTop],
    ["--chrome-top", top],
    ["--chrome-summary-top", summary],
    ["--chrome-stack", below(summary, parts.summary)],
    ["--chrome-bottom", below(CHROME_EDGE, parts.footer)],
    ["--chrome-status-top", statusTop],
    ["--notices-height", shownHeight(parts.notices)],
    ["--tools-height", shownHeight(parts.tools)],
    ["--result-height", below(0, parts.result)],
  ];
}

function below(top: number, part: Element | null): number {
  const height = shownHeight(part);
  return height === 0 ? top : top + height + CHROME_GAP;
}

function shownHeight(part: Element | null): number {
  return part instanceof HTMLElement ? part.offsetHeight : 0;
}

function shownWidth(part: Element | null): number {
  return part instanceof HTMLElement ? part.offsetWidth : 0;
}

export function isIntersecting(entry: IntersectionObserverEntry): boolean {
  return entry.isIntersecting;
}

type Point = Readonly<{ x: number; y: number }>;
type Wire = Readonly<{ d: string; label: Point }>;

/**
 * A wire leaves the port on the right of a step and enters the port on the left of
 * the step that needs it. To the next column it bends in the gap between the two. Any
 * other wire would cross the steps between its ends, so it runs only in the gaps: to
 * the middle of the gap beside its step, along the gap above the row of the step that
 * needs it, and back down that step's gap to its port.
 */
export function wireRoute(from: Point, to: Point): Wire {
  const x1 = from.x + WIDTH + PORT_CENTRE;
  const y1 = from.y + HEIGHT / 2;
  const x2 = to.x - PORT_CENTRE;
  const y2 = to.y + HEIGHT / 2;
  if (x2 - x1 >= WIRE_REACH && to.x - from.x <= NODE_COLUMN) {
    const bend = Math.max(WIRE_REACH, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6 },
    };
  }
  const gap = (NODE_COLUMN - WIDTH) / 2;
  const out = from.x + WIDTH + gap;
  const into = to.x - gap;
  // The lane runs in the gap above the row, clear of the labels of that row.
  const lane = to.y - LABEL_ROOM - (NODE_ROW - HEIGHT - LABEL_ROOM) / 2;
  return {
    d: roundedPath([
      { x: x1, y: y1 },
      { x: out, y: y1 },
      { x: out, y: lane },
      { x: into, y: lane },
      { x: into, y: y2 },
      { x: x2, y: y2 },
    ]),
    label: { x: (out + into) / 2, y: lane - 4 },
  };
}

/** Straight segments through the points, with a round corner at each turn. */
function roundedPath(points: readonly Point[]): string {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last === undefined || last.x !== point.x || last.y !== point.y)
      kept.push(point);
  }
  const first = kept[0];
  if (first === undefined) return "";
  const parts = [`M ${first.x} ${first.y}`];
  for (let index = 1; index < kept.length - 1; index++) {
    const before = kept[index - 1];
    const corner = kept[index];
    const after = kept[index + 1];
    if (before === undefined || corner === undefined || after === undefined)
      continue;
    const into = Math.hypot(corner.x - before.x, corner.y - before.y);
    const away = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(WIRE_CORNER, into / 2, away / 2);
    parts.push(
      `L ${corner.x + ((before.x - corner.x) / into) * radius} ${corner.y + ((before.y - corner.y) / into) * radius}`,
      `Q ${corner.x} ${corner.y}, ${corner.x + ((after.x - corner.x) / away) * radius} ${corner.y + ((after.y - corner.y) / away) * radius}`,
    );
  }
  const last = kept.at(-1);
  if (last !== undefined && kept.length > 1)
    parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

export function edgePath(
  nodes: ReadonlyMap<string, RecipeGraphNode>,
  edge: RecipeGraphEdge,
): React.ReactNode {
  const source = nodes.get(edge.from);
  const target = nodes.get(edge.to);
  if (source === undefined || target === undefined) return null;
  const wire = wireRoute(source, target);
  return (
    <g
      key={`${edge.from}:${edge.to}`}
      data-prerequisite={edge.from}
      data-dependent={edge.to}
      data-branch={edge.branch ?? undefined}
      data-kind={edgeKind(nodes, edge)}
    >
      <path d={wire.d} />
      {edge.branch !== null && (
        <text x={wire.label.x} y={wire.label.y} textAnchor="middle">
          {edge.branch === "accept" ? "Accept" : "Reject"}
        </text>
      )}
    </g>
  );
}

export function edgeEndsAt(id: string, edge: Readonly<{ to: string }>): boolean {
  return edge.to === id;
}

export function edgeStartsAt(id: string, edge: Readonly<{ from: string }>): boolean {
  return edge.from === id;
}

/** A branch shows its outcome, and any other wire shows the step it leaves. */
export function edgeKind(
  nodes: ReadonlyMap<string, RecipeGraphNode>,
  edge: RecipeGraphEdge,
): PortKind {
  return edge.branch ?? nodes.get(edge.from)?.role ?? "work";
}
