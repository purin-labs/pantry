import type { BakeryFloorPlanSpec } from "./bakery-room";

type WallSubSegment = Readonly<{
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}> &
  (
    | Readonly<{ kind: "wall"; height: number; sillHeight?: never }>
    | Readonly<{ kind: "sill"; sillHeight: number; height?: never }>
  );

export function splitWallByWindows(
  wall: BakeryFloorPlanSpec["walls"][number],
  windows: BakeryFloorPlanSpec["windows"],
): readonly WallSubSegment[] {
  const dx = wall.x1 - wall.x0;
  const dz = wall.z1 - wall.z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return [];
  const ux = dx / len;
  const uz = dz / len;
  const nx = -uz;
  const nz = ux;

  const spans: Array<{ t0: number; t1: number; sillHeight: number }> = [];
  for (const win of windows) {
    const wx0 = win.x0 - wall.x0;
    const wz0 = win.z0 - wall.z0;
    const wx1 = win.x1 - wall.x0;
    const wz1 = win.z1 - wall.z0;
    const d0 = Math.abs(wx0 * nx + wz0 * nz);
    const d1 = Math.abs(wx1 * nx + wz1 * nz);
    if (d0 > wall.thickness + 0.08 || d1 > wall.thickness + 0.08) continue;

    const p0 = wx0 * ux + wz0 * uz;
    const p1 = wx1 * ux + wz1 * uz;
    const t0 = Math.max(0, Math.min(p0, p1));
    const t1 = Math.min(len, Math.max(p0, p1));
    if (t1 - t0 > 0.04) {
      spans.push({
        t0,
        t1,
        sillHeight: win.sillHeight,
      });
    }
  }

  if (spans.length === 0) {
    return [
      {
        x0: wall.x0,
        z0: wall.z0,
        x1: wall.x1,
        z1: wall.z1,
        kind: "wall",
        height: wall.height,
      },
    ];
  }

  spans.sort(compareSpanStart);
  const result: WallSubSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.t0 - cursor > 0.03) {
      result.push({
        x0: wall.x0 + ux * cursor,
        z0: wall.z0 + uz * cursor,
        x1: wall.x0 + ux * span.t0,
        z1: wall.z0 + uz * span.t0,
        kind: "wall",
        height: wall.height,
      });
    }
    const s0 = Math.max(cursor, span.t0);
    if (span.t1 - s0 > 0.03) {
      result.push({
        x0: wall.x0 + ux * s0,
        z0: wall.z0 + uz * s0,
        x1: wall.x0 + ux * span.t1,
        z1: wall.z0 + uz * span.t1,
        kind: "sill",
        sillHeight: span.sillHeight,
      });
    }
    cursor = Math.max(cursor, span.t1);
  }
  if (len - cursor > 0.03) {
    result.push({
      x0: wall.x0 + ux * cursor,
      z0: wall.z0 + uz * cursor,
      x1: wall.x1,
      z1: wall.z1,
      kind: "wall",
      height: wall.height,
    });
  }
  return result;
}

function compareSpanStart(a: { t0: number }, b: { t0: number }): number {
  return a.t0 - b.t0;
}
