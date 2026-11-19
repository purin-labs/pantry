import { NODE_COLUMN, NODE_ROW } from "@purin-labs/bakery-workflow/layout";
import {
  DRAFT_BOUNDS,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft";

/** Where the workflow draft canvas places a step. */

export function clampPosition(
  x: number,
  y: number,
): Readonly<{ x: number; y: number }> {
  return {
    x: Math.min(Math.max(DRAFT_BOUNDS.minX, x), DRAFT_BOUNDS.maxX),
    y: Math.min(Math.max(DRAFT_BOUNDS.minY, y), DRAFT_BOUNDS.maxY),
  };
}

/** One rank on from the step it follows and a row down, or below everything. */
export function freePosition(
  snapshot: DraftSnapshot,
  origin: Readonly<{ x: number; y: number }> | null | undefined,
): Readonly<{ x: number; y: number }> {
  const taken = Object.values(snapshot.positions);
  let bottom = 0;
  for (const position of taken) bottom = Math.max(bottom, position.y);
  const start = origin ?? { x: 0, y: bottom };
  const x =
    start.x + (origin === null || origin === undefined ? 0 : NODE_COLUMN);
  let y = start.y + NODE_ROW;
  while (taken.some(isAt.bind(null, x, y))) y += NODE_ROW;
  return clampPosition(x, y);
}

function isAt(
  x: number,
  y: number,
  position: Readonly<{ x: number; y: number }>,
): boolean {
  return position.x === x && position.y === y;
}

export function hasEdge(
  snapshot: DraftSnapshot,
  workflow: string,
  from: string,
  to: string,
): boolean {
  for (const edge of snapshot.edges)
    if (edge.workflow === workflow && edge.from === from && edge.to === to)
      return true;
  return false;
}
