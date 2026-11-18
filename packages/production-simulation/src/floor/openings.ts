import {
  BAKERY_FLOOR_PLANS,
  type BakeryFloorPlanId,
  type FloorPlanDoor,
  type FloorPlanWindow,
} from "./bakery-room";
import type { Box2D } from "./collisions";
import type { Variant } from "@seams/type-utils";

export type FloorPlanOpening =
  | Readonly<{
      kind: "door";
      planId: BakeryFloorPlanId;
      door: FloorPlanDoor;
      window?: never;
    }>
  | Readonly<{
      kind: "window";
      planId: BakeryFloorPlanId;
      window: FloorPlanWindow;
      door?: never;
    }>;

export function doorOpening(
  planId: BakeryFloorPlanId,
  door: FloorPlanDoor,
): Variant<FloorPlanOpening, "door"> {
  return { kind: "door", planId, door };
}

export function windowOpening(
  planId: BakeryFloorPlanId,
  window: FloorPlanWindow,
): Variant<FloorPlanOpening, "window"> {
  return { kind: "window", planId, window };
}

export function openingId(opening: FloorPlanOpening): string {
  switch (opening.kind) {
    case "door":
      return `door:${opening.door.id}`;
    case "window":
      return `window:${opening.window.id}`;
  }
}

/** Converts DOM metadata into a known opening at the interaction boundary. */
export function findFloorPlanOpening(
  planId: BakeryFloorPlanId,
  id: string,
): FloorPlanOpening | null {
  const spec = BAKERY_FLOOR_PLANS[planId];
  for (const door of spec.doors) {
    if (`door:${door.id}` === id) return doorOpening(planId, door);
  }
  for (const window of spec.windows) {
    if (`window:${window.id}` === id) return windowOpening(planId, window);
  }
  return null;
}

export function openingEase(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}

export function doorAngle(door: FloorPlanDoor, progress: number): number {
  const open = Math.atan2(door.leafZ - door.hingeZ, door.leafX - door.hingeX);
  return open + door.swingRad * (1 - openingEase(progress));
}

export function isDoorOpen(progress: number): boolean {
  return progress >= 0.5;
}

export function doorLeafHitsBox(
  door: FloorPlanDoor,
  progress: number,
  box: Box2D,
): boolean {
  const angle = doorAngle(door, progress);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfT = 0.025;
  const samples = 10;
  for (let i = 1; i <= samples; i += 1) {
    const t = i / samples;
    const px = door.hingeX + cos * door.width * t;
    const pz = door.hingeZ + sin * door.width * t;
    if (
      px >= box.x0 - halfT &&
      px <= box.x1 + halfT &&
      pz >= box.z0 - halfT &&
      pz <= box.z1 + halfT
    ) {
      return true;
    }
  }
  return false;
}

export function doorSweepIntersectsBox(
  door: FloorPlanDoor,
  box: Box2D,
): boolean {
  for (let step = 1; step <= 20; step += 1) {
    if (doorLeafHitsBox(door, step / 20, box)) return true;
  }
  return false;
}

export function maxUnobstructedDoorProgress(
  door: FloorPlanDoor,
  startProgress: number,
  targetProgress: 0 | 1,
  obstacleBoxes: readonly Box2D[],
): number {
  if (obstacleBoxes.length === 0 || startProgress === targetProgress) {
    return targetProgress;
  }
  const steps = 50;
  let lastClear = startProgress;
  for (let i = 1; i <= steps; i += 1) {
    const u = i / steps;
    const p = startProgress + (targetProgress - startProgress) * u;
    if (
      Math.abs(p - startProgress) >= 0.04 &&
      obstacleBoxes.some((box) => doorLeafHitsBox(door, p, box))
    ) {
      return Number(lastClear.toFixed(3));
    }
    lastClear = p;
  }
  return targetProgress;
}

/**
 * Physical obstacle boxes for a door leaf at `progress` (0 = closed across the
 * doorway threshold, 1 = swung open along the leaf edge).
 */
export function doorObstacleBoxes(
  door: FloorPlanDoor,
  progress: number,
): readonly Box2D[] {
  const angle = doorAngle(door, progress);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const endX = door.hingeX + cos * door.width;
  const endZ = door.hingeZ + sin * door.width;
  const halfT = 0.025;
  if (Math.abs(sin) < 0.08 || Math.abs(cos) < 0.08) {
    return [
      {
        x0: Math.min(door.hingeX, endX) - halfT,
        z0: Math.min(door.hingeZ, endZ) - halfT,
        x1: Math.max(door.hingeX, endX) + halfT,
        z1: Math.max(door.hingeZ, endZ) + halfT,
      },
    ];
  }
  const boxes: Box2D[] = [];
  const samples = 4;
  const segHalf = (door.width / samples) * 0.5 + halfT;
  for (let i = 0; i < samples; i += 1) {
    const t = (i + 0.5) / samples;
    const cx = door.hingeX + cos * door.width * t;
    const cz = door.hingeZ + sin * door.width * t;
    boxes.push({
      x0: cx - segHalf,
      z0: cz - segHalf,
      x1: cx + segHalf,
      z1: cz + segHalf,
    });
  }
  return boxes;
}

/**
 * Threshold midpoint and approach waypoints on both sides of an open doorway,
 * centered in the clear gap between the hinged leaf and the opposite jamb.
 */
export function doorThresholdWaypoints(
  door: FloorPlanDoor,
): readonly (readonly [number, number])[] {
  const closedAngle = doorAngle(door, 0);
  const ux = Math.cos(closedAngle);
  const uz = Math.sin(closedAngle);
  const nx = -uz;
  const nz = ux;
  const clearCenterOffset = (door.width + 0.025) * 0.5;
  const cx = door.hingeX + ux * clearCenterOffset;
  const cz = door.hingeZ + uz * clearCenterOffset;
  const approach = 0.38;
  return [
    [Number((cx - nx * approach).toFixed(3)), Number((cz - nz * approach).toFixed(3))],
    [Number(cx.toFixed(3)), Number(cz.toFixed(3))],
    [Number((cx + nx * approach).toFixed(3)), Number((cz + nz * approach).toFixed(3))],
  ];
}

/** Rotation around the sash's local Y axis, shared by SVG and Three.js. */
export function windowSashRotation(panel: number, progress: number): number {
  const hingeSide = panel % 2 === 0 ? -1 : 1;
  return hingeSide * 1.12 * openingEase(progress);
}

export function windowSashGeometry(window: FloorPlanWindow, panel: number) {
  const span = Math.hypot(window.x1 - window.x0, window.z1 - window.z0);
  const bayWidth = span / window.panels;
  const left = panel % 2 === 0;
  const hingeOffset = left
    ? panel * bayWidth + 0.014
    : (panel + 1) * bayWidth - 0.014;
  const angle = Math.atan2(window.z1 - window.z0, window.x1 - window.x0);
  return {
    hingeOffset,
    x: window.x0 + Math.cos(angle) * hingeOffset,
    z: window.z0 + Math.sin(angle) * hingeOffset,
    width: Math.max(0.14, bayWidth - 0.024),
    angle: left ? angle : angle + Math.PI,
  };
}
