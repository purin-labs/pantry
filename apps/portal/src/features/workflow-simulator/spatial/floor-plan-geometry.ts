import * as THREE from "three";
import { OBB } from "three/addons/math/OBB.js";
import type {
  PhysicsReplay,
  PhysicsMotion,
} from "@seams/bakery-model/bakery-physics";

export type RecordedFitEvent = Readonly<{
  recording: PhysicsReplay;
  request: PhysicsMotion["request"];
  eventIndex: number;
  time: number;
}>;

export type FitFinding = Readonly<{
  kind: "blocked" | "unchecked" | "clear";
  rule:
    | "solid-overlap"
    | "room-boundary"
    | "wall-overlap"
    | "door-sweep"
    | "utility-reach"
    | "recorded-pose";
  first: string;
  second: string;
  message: string;
}> &
  (
    | Readonly<{ source: "geometry"; event?: never }>
    | Readonly<{ source: "recording"; event: RecordedFitEvent }>
  );

export type FloorPlanActor = Readonly<{
  id: string;
  kind: "worker" | "customer";
  label: string;
  x: number;
  z: number;
  facingYawRad: number;
  color: string;
  carrying: boolean;
}>;

/** A convex outline on the floor in world metres, as [x, z] pairs. */
export type PlanPolygon = readonly (readonly [number, number])[];

export type FloorPlanItem<Selection> = Readonly<{
  id: string;
  label: string;
  /** World-axis envelope used by fit checks; drawn only as an overlay. */
  bounds: THREE.Box3;
  /** Top-view outline of the placed parts, from {@link planFootprint}. */
  footprint: readonly PlanPolygon[];
  originalBounds?: THREE.Box3;
  /** Conservative opening-space envelope; never itself a confirmed collision. */
  sweepEnvelope?: THREE.Box3;
  /** Null when the drawing has nothing to select, e.g. idle context. */
  selection: Selection | null;
  /** Assumed surroundings shown for orientation and excluded from fit checks. */
  context?: true;
  /** Stable reference number shared with 3D labels; defaults to list order. */
  number?: number;
  /** Live operating state shown as a dot on the footprint. */
  state?: string;
  geometry:
    | Readonly<{ kind: "model-boxes"; boxes: readonly OBB[] }>
    | Readonly<{ kind: "visual-only" }>;
}>;

/**
 * The top view of placed geometry: each mesh's local bounds, moved by its
 * world transform and projected onto the floor. Rotations, open doors and
 * gaps between parts survive; the single world-axis envelope loses them.
 */
export function planFootprint(
  objects: readonly THREE.Object3D[],
): readonly PlanPolygon[] {
  const polygons: PlanPolygon[] = [];
  const corner = new THREE.Vector3();
  for (const object of objects) {
    object.updateWorldMatrix(true, true);
    for (const node of object.getObjectsByProperty("isMesh", true)) {
      if (!(node instanceof THREE.Mesh)) continue;
      if (node.geometry.boundingBox === null)
        node.geometry.computeBoundingBox();
      const bounds = node.geometry.boundingBox;
      if (bounds === null || bounds.isEmpty()) continue;
      const points: [number, number][] = [];
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            corner.set(x, y, z).applyMatrix4(node.matrixWorld);
            points.push([corner.x, corner.z]);
          }
        }
      }
      const hull = convexHull(points);
      if (hull.length >= 2) polygons.push(hull);
    }
  }
  return polygons;
}

/** Andrew's monotone chain; collinear points are dropped. */
export function convexHull(
  points: readonly (readonly [number, number])[],
): PlanPolygon {
  const sorted = [...points].sort(comparePoints);
  if (sorted.length < 3) return sorted;
  const lower = halfHull(sorted);
  const upper = halfHull([...sorted].reverse());
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** The points of one hull chain, keeping only left turns. */
function halfHull(
  points: readonly (readonly [number, number])[],
): (readonly [number, number])[] {
  const chain: (readonly [number, number])[] = [];
  for (const point of points) {
    while (bendsRight(chain, point)) chain.pop();
    chain.push(point);
  }
  return chain;
}

/** Whether the chain's last two points turn right or run straight into point. */
function bendsRight(
  chain: readonly (readonly [number, number])[],
  point: readonly [number, number],
): boolean {
  const first = chain[chain.length - 2];
  const second = chain[chain.length - 1];
  return (
    first !== undefined &&
    second !== undefined &&
    cross(first, second, point) <= 1e-12
  );
}

/**
 * Whether the outline already fills its world-axis envelope, sampled on an
 * 8 × 8 grid of cell centres. Only an envelope that adds space needs drawing.
 */
export function fillsEnvelope(
  polygons: readonly PlanPolygon[],
  bounds: THREE.Box3,
): boolean {
  const width = bounds.max.x - bounds.min.x;
  const depth = bounds.max.z - bounds.min.z;
  for (let column = 0; column < 8; column++) {
    for (let row = 0; row < 8; row++) {
      const x = bounds.min.x + ((column + 0.5) * width) / 8;
      const z = bounds.min.z + ((row + 0.5) * depth) / 8;
      if (!polygons.some(containsPoint.bind(null, x, z))) return false;
    }
  }
  return true;
}

function containsPoint(x: number, z: number, polygon: PlanPolygon): boolean {
  // Each edge runs from the previous point, starting with the closing edge.
  let start = polygon[polygon.length - 1];
  if (polygon.length < 3 || start === undefined) return false;
  let sign = 0;
  for (const end of polygon) {
    const side = cross(start, end, [x, z]);
    start = end;
    if (Math.abs(side) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(side);
    else if (Math.sign(side) !== sign) return false;
  }
  return true;
}

/** A cheap change key for per-frame comparison, at millimetre resolution. */
export function footprintKey(polygons: readonly PlanPolygon[]): number {
  let hash = 2166136261;
  for (const polygon of polygons) {
    hash = Math.imul(hash ^ polygon.length, 16777619);
    for (const [x, z] of polygon) {
      hash = Math.imul(hash ^ Math.round(x * 1000), 16777619);
      hash = Math.imul(hash ^ Math.round(z * 1000), 16777619);
    }
  }
  return hash >>> 0;
}

function comparePoints(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return a[0] - b[0] || a[1] - b[1];
}

function cross(
  origin: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return (
    (a[0] - origin[0]) * (b[1] - origin[1]) -
    (a[1] - origin[1]) * (b[0] - origin[0])
  );
}

export function modelBoxes(objects: readonly THREE.Mesh[]): readonly OBB[] {
  const boxes: OBB[] = [];
  for (const object of objects) {
    if (!(object.geometry instanceof THREE.BoxGeometry)) continue;
    object.updateWorldMatrix(true, false);
    object.geometry.computeBoundingBox();
    const bounds = object.geometry.boundingBox;
    if (bounds === null) continue;
    const box = new OBB().fromBox3(bounds).applyMatrix4(object.matrixWorld);
    // Ignore touching support surfaces and sub-millimetre simulation contact slop.
    box.halfSize.subScalar(0.0005).max(new THREE.Vector3());
    boxes.push(box);
  }
  return boxes;
}

export function modelBoxesIntersect<Selection>(
  a: FloorPlanItem<Selection>,
  b: FloorPlanItem<Selection>,
): boolean {
  if (a.geometry.kind !== "model-boxes" || b.geometry.kind !== "model-boxes")
    return false;
  for (const first of a.geometry.boxes) {
    for (const second of b.geometry.boxes) {
      if (first.intersectsOBB(second)) return true;
    }
  }
  return false;
}

export function footprintsOverlap(a: THREE.Box3, b: THREE.Box3): boolean {
  return (
    Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > 0.001 &&
    Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > 0.001
  );
}
