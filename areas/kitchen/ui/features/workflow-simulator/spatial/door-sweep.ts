import * as THREE from "three";
import { OBB } from "three/addons/math/OBB.js";

export type DoorSweep = Readonly<{
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  recordedAngle: number;
  boxes: readonly OBB[];
}>;

export type SweepCheck =
  | Readonly<{ kind: "clear"; angle?: never }>
  | Readonly<{ kind: "blocked"; angle: number }>
  | Readonly<{ kind: "unchecked"; angle?: never }>;

const doorOpeningAngle = (110 * Math.PI) / 180;

function rotation(sweep: DoorSweep, angle: number): THREE.Matrix4 {
  const { pivot } = sweep;
  return new THREE.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(
      new THREE.Matrix4().makeRotationAxis(
        sweep.axis,
        angle - sweep.recordedAngle,
      ),
    )
    .multiply(
      new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z),
    );
}

function boxBounds(box: OBB): THREE.Box3 {
  const result = new THREE.Box3();
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        result.expandByPoint(
          new THREE.Vector3(x, y, z)
            .multiply(box.halfSize)
            .applyMatrix3(box.rotation)
            .add(box.center),
        );
      }
    }
  }
  return result;
}

function boxAt(sweep: DoorSweep, box: OBB, angle: number): OBB {
  const transform = rotation(sweep, angle);
  return new OBB(
    box.center.clone().applyMatrix4(transform),
    box.halfSize.clone(),
    new THREE.Matrix3().setFromMatrix4(transform).multiply(box.rotation),
  );
}

function intervalEnvelope(
  sweep: DoorSweep,
  box: OBB,
  start: number,
  end: number,
): THREE.Box3 {
  const middle = boxAt(sweep, box, (start + end) / 2);
  const radius = box.center.distanceTo(sweep.pivot) + box.halfSize.length();
  // Every point moves at most this chord distance from the interval midpoint.
  // Inflation proves exclusion throughout the interval, including between samples.
  return boxBounds(middle).expandByScalar(
    2 * radius * Math.sin((end - start) / 4) + 1e-9,
  );
}

export function doorSweepBounds(sweep: DoorSweep): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (let step = 0; step < 22; step++) {
    for (const box of sweep.boxes)
      bounds.union(
        intervalEnvelope(
          sweep,
          box,
          (step * doorOpeningAngle) / 22,
          ((step + 1) * doorOpeningAngle) / 22,
        ),
      );
  }
  return bounds;
}

export function checkDoorSweep(
  sweep: DoorSweep,
  obstacles: readonly OBB[],
): SweepCheck {
  if (sweep.boxes.length === 0 || obstacles.length === 0)
    return { kind: "unchecked" };
  let unresolved = false;
  for (const moving of sweep.boxes) {
    for (const obstacle of obstacles) {
      const bounds = boxBounds(obstacle);
      const intervals = [{ start: 0, end: doorOpeningAngle, depth: 0 }];
      while (intervals.length > 0) {
        const interval = intervals.pop();
        if (interval === undefined) break;
        const { start, end, depth } = interval;
        if (!intervalEnvelope(sweep, moving, start, end).intersectsBox(bounds))
          continue;
        const middle = (start + end) / 2;
        for (const angle of [start, middle, end]) {
          if (boxAt(sweep, moving, angle).intersectsOBB(obstacle))
            return { kind: "blocked", angle };
        }
        if (depth === 10) unresolved = true;
        else
          intervals.push(
            { start, end: middle, depth: depth + 1 },
            { start: middle, end, depth: depth + 1 },
          );
      }
    }
  }
  return { kind: unresolved ? "unchecked" : "clear" };
}
