import {
  APPLIANCE_FOOTPRINTS,
  type ApplianceId,
  type AppliancePose,
} from "./appliance-catalogue.ts";

const HALF_PI = Math.PI / 2;

export type ResolvedApplianceMove =
  | Readonly<{
      kind: "placed";
      pose: AppliancePose;
      contactedBoundary: boolean;
      reason?: never;
    }>
  | Readonly<{
      kind: "blocked";
      pose: AppliancePose;
      reason: "no-clearance";
      contactedBoundary?: never;
    }>;

function blockedMove(pose: AppliancePose): ResolvedApplianceMove {
  return { kind: "blocked", pose, reason: "no-clearance" };
}

function placedMove(
  pose: AppliancePose,
  contactedBoundary: boolean,
): ResolvedApplianceMove {
  return { kind: "placed", pose, contactedBoundary };
}

export type Box2D = Readonly<{
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}>;

export function getOrientedExtents(
  id: ApplianceId,
  rotY: number,
): Readonly<{ halfWidth: number; halfDepth: number }> {
  const fp = APPLIANCE_FOOTPRINTS[id];
  const c = Math.abs(Math.cos(rotY));
  const s = Math.abs(Math.sin(rotY));
  return {
    halfWidth: fp.halfWidth * c + fp.halfDepth * s,
    halfDepth: fp.halfWidth * s + fp.halfDepth * c,
  };
}

export function getApplianceBox(
  id: ApplianceId,
  x: number,
  z: number,
  rotY: number,
): Box2D {
  const { halfWidth, halfDepth } = getOrientedExtents(id, rotY);
  return {
    x0: x - halfWidth,
    z0: z - halfDepth,
    x1: x + halfWidth,
    z1: z + halfDepth,
  };
}

function boxesOverlap(a: Box2D, b: Box2D, clearance: number): boolean {
  return !(
    a.x1 + clearance <= b.x0 ||
    a.x0 - clearance >= b.x1 ||
    a.z1 + clearance <= b.z0 ||
    a.z0 - clearance >= b.z1
  );
}

export function isBoxValid(
  candidate: Box2D,
  roomBounds: Box2D,
  obstacles: readonly Box2D[],
  clearance: number,
): boolean {
  if (
    candidate.x0 < roomBounds.x0 - 1e-4 ||
    candidate.x1 > roomBounds.x1 + 1e-4 ||
    candidate.z0 < roomBounds.z0 - 1e-4 ||
    candidate.z1 > roomBounds.z1 + 1e-4
  ) {
    return false;
  }
  for (const ob of obstacles) {
    if (boxesOverlap(candidate, ob, clearance)) return false;
  }
  return true;
}

export function makeBox(x: number, z: number, hw: number, hd: number): Box2D {
  return { x0: x - hw, z0: z - hd, x1: x + hw, z1: z + hd };
}

export function findNearestValidPosition(
  originX: number,
  originZ: number,
  hw: number,
  hd: number,
  roomBounds: Box2D,
  obstacles: readonly Box2D[],
  clearance: number,
): { x: number; z: number; shifted: boolean } | null {
  if (
    ![originX, originZ, hw, hd].every(Number.isFinite) ||
    hw * 2 > roomBounds.x1 - roomBounds.x0 ||
    hd * 2 > roomBounds.z1 - roomBounds.z0
  )
    return null;
  const minX = roomBounds.x0 + hw;
  const maxX = roomBounds.x1 - hw;
  const minZ = roomBounds.z0 + hd;
  const maxZ = roomBounds.z1 - hd;
  const clampX = clampCoordinate.bind(null, minX, maxX);
  const clampZ = clampCoordinate.bind(null, minZ, maxZ);

  const cx = clampX(originX);
  const cz = clampZ(originZ);
  if (isBoxValid(makeBox(cx, cz, hw, hd), roomBounds, obstacles, clearance)) {
    return {
      x: cx,
      z: cz,
      shifted: Math.abs(cx - originX) > 1e-3 || Math.abs(cz - originZ) > 1e-3,
    };
  }

  // Try iterative Minimum Translation Vector (MTV) projection first
  let mtvX = cx;
  let mtvZ = cz;
  for (let iter = 0; iter < 12; iter++) {
    let resolvedAll = true;
    const box = makeBox(mtvX, mtvZ, hw, hd);
    for (const ob of obstacles) {
      if (!boxesOverlap(box, ob, clearance)) continue;
      resolvedAll = false;
      const pushLeft = ob.x0 - clearance - hw - mtvX;
      const pushRight = ob.x1 + clearance + hw - mtvX;
      const pushNorth = ob.z0 - clearance - hd - mtvZ;
      const pushSouth = ob.z1 + clearance + hd - mtvZ;

      const candidates: { dx: number; dz: number; dist: number }[] = [];
      if (mtvX + pushLeft >= minX - 1e-4)
        candidates.push({ dx: pushLeft, dz: 0, dist: Math.abs(pushLeft) });
      if (mtvX + pushRight <= maxX + 1e-4)
        candidates.push({ dx: pushRight, dz: 0, dist: Math.abs(pushRight) });
      if (mtvZ + pushNorth >= minZ - 1e-4)
        candidates.push({ dx: 0, dz: pushNorth, dist: Math.abs(pushNorth) });
      if (mtvZ + pushSouth <= maxZ + 1e-4)
        candidates.push({ dx: 0, dz: pushSouth, dist: Math.abs(pushSouth) });

      candidates.sort(compareDisplacement);
      const best = candidates[0];
      if (best !== undefined) {
        mtvX = clampX(mtvX + best.dx);
        mtvZ = clampZ(mtvZ + best.dz);
      }
      break;
    }
    if (resolvedAll) break;
  }
  if (
    isBoxValid(makeBox(mtvX, mtvZ, hw, hd), roomBounds, obstacles, clearance)
  ) {
    return { x: mtvX, z: mtvZ, shifted: true };
  }

  // Radial spiral search around (cx, cz) for nearest valid pose
  for (let radius = 0.04; radius <= 2.4; radius += 0.04) {
    const samples = 24;
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const candX = clampX(cx + Math.cos(angle) * radius);
      const candZ = clampZ(cz + Math.sin(angle) * radius);
      if (
        isBoxValid(
          makeBox(candX, candZ, hw, hd),
          roomBounds,
          obstacles,
          clearance,
        )
      ) {
        return { x: candX, z: candZ, shifted: true };
      }
    }
  }

  return null;
}

export function resolveApplianceMove(
  current: AppliancePose,
  desiredX: number,
  desiredZ: number,
  roomBounds: Box2D,
  obstacles: readonly Box2D[],
): ResolvedApplianceMove {
  const id = current.id;
  const { halfWidth: hw, halfDepth: hd } = getOrientedExtents(id, current.rotY);
  const minX = roomBounds.x0 + hw;
  const maxX = roomBounds.x1 - hw;
  const minZ = roomBounds.z0 + hd;
  const maxZ = roomBounds.z1 - hd;

  const clampX = clampCoordinate.bind(null, minX, maxX);
  const clampZ = clampCoordinate.bind(null, minZ, maxZ);

  if (!Number.isFinite(desiredX) || !Number.isFinite(desiredZ))
    return blockedMove(current);
  const targetX = clampX(desiredX);
  const targetZ = clampZ(desiredZ);
  let contactedBoundary =
    Math.abs(targetX - desiredX) > 1e-3 || Math.abs(targetZ - desiredZ) > 1e-3;

  const clearance = 0.02;

  // Ensure starting pose is valid (e.g. immediately after a rotation)
  const startValid = findNearestValidPosition(
    current.x,
    current.z,
    hw,
    hd,
    roomBounds,
    obstacles,
    clearance,
  );
  if (startValid === null) return blockedMove(current);
  let slideX = startValid.x;
  let slideZ = startValid.z;
  if (startValid.shifted) contactedBoundary = true;

  // Continuous sub-stepped slide with doorway funneling so objects never
  // teleport through walls narrower than their current oriented footprint,
  // yet smoothly thread doorways once rotated to fit.
  const totalDist = Math.hypot(targetX - slideX, targetZ - slideZ);
  const steps = Math.max(8, Math.min(96, Math.ceil(totalDist / 0.03)));

  for (let s = 0; s < steps; s++) {
    const rem = steps - s;
    const stepDx = (targetX - slideX) / rem;
    const stepDz = (targetZ - slideZ) / rem;
    if (Math.abs(stepDx) < 1e-5 && Math.abs(stepDz) < 1e-5) break;

    const nextX = clampX(slideX + stepDx);
    const nextZ = clampZ(slideZ + stepDz);

    // 1. Direct diagonal sub-step
    if (
      isBoxValid(
        makeBox(nextX, nextZ, hw, hd),
        roomBounds,
        obstacles,
        clearance,
      )
    ) {
      slideX = nextX;
      slideZ = nextZ;
      continue;
    }

    contactedBoundary = true;
    let movedX = false;
    let movedZ = false;

    if (
      Math.abs(stepDx) > 1e-5 &&
      isBoxValid(
        makeBox(nextX, slideZ, hw, hd),
        roomBounds,
        obstacles,
        clearance,
      )
    ) {
      slideX = nextX;
      movedX = true;
    }

    if (
      Math.abs(stepDz) > 1e-5 &&
      isBoxValid(
        makeBox(slideX, nextZ, hw, hd),
        roomBounds,
        obstacles,
        clearance,
      )
    ) {
      slideZ = nextZ;
      movedZ = true;
    }

    // 2. Doorway funneling: if Z is blocked, check if shifting X slightly
    // along the wall reaches an open doorway that fits the current width.
    if (!movedZ && Math.abs(targetZ - slideZ) > 0.015) {
      const zStep =
        Math.sign(targetZ - slideZ) *
        Math.min(0.035, Math.abs(targetZ - slideZ));
      const testZ = clampZ(slideZ + zStep);
      let foundNudgeX: number | null = null;
      for (let k = 1; k <= 24; k++) {
        const offset = k * 0.035;
        for (const dir of [-1, 1] as const) {
          const candX = clampX(slideX + dir * offset);
          if (Math.abs(candX - slideX) < 1e-4) continue;
          // Verify continuous horizontal path from slideX to candX at slideZ
          let pathClear = true;
          for (let j = 1; j <= k; j++) {
            const midX = clampX(slideX + dir * j * 0.035);
            if (
              !isBoxValid(
                makeBox(midX, slideZ, hw, hd),
                roomBounds,
                obstacles,
                clearance,
              )
            ) {
              pathClear = false;
              break;
            }
          }
          if (
            pathClear &&
            isBoxValid(
              makeBox(candX, testZ, hw, hd),
              roomBounds,
              obstacles,
              clearance,
            )
          ) {
            foundNudgeX = candX;
            break;
          }
        }
        if (foundNudgeX !== null) break;
      }
      if (foundNudgeX !== null) {
        const shiftX =
          Math.sign(foundNudgeX - slideX) *
          Math.min(0.04, Math.abs(foundNudgeX - slideX));
        const steppedX = clampX(slideX + shiftX);
        if (
          isBoxValid(
            makeBox(steppedX, slideZ, hw, hd),
            roomBounds,
            obstacles,
            clearance,
          )
        ) {
          slideX = steppedX;
        }
        if (
          isBoxValid(
            makeBox(slideX, testZ, hw, hd),
            roomBounds,
            obstacles,
            clearance,
          )
        ) {
          slideZ = testZ;
        }
      }
    }

    // Symmetrically, if X is blocked, check if shifting Z slightly reaches an open gap
    if (!movedX && Math.abs(targetX - slideX) > 0.015) {
      const xStep =
        Math.sign(targetX - slideX) *
        Math.min(0.035, Math.abs(targetX - slideX));
      const testX = clampX(slideX + xStep);
      let foundNudgeZ: number | null = null;
      for (let k = 1; k <= 24; k++) {
        const offset = k * 0.035;
        for (const dir of [-1, 1] as const) {
          const candZ = clampZ(slideZ + dir * offset);
          if (Math.abs(candZ - slideZ) < 1e-4) continue;
          let pathClear = true;
          for (let j = 1; j <= k; j++) {
            const midZ = clampZ(slideZ + dir * j * 0.035);
            if (
              !isBoxValid(
                makeBox(slideX, midZ, hw, hd),
                roomBounds,
                obstacles,
                clearance,
              )
            ) {
              pathClear = false;
              break;
            }
          }
          if (
            pathClear &&
            isBoxValid(
              makeBox(testX, candZ, hw, hd),
              roomBounds,
              obstacles,
              clearance,
            )
          ) {
            foundNudgeZ = candZ;
            break;
          }
        }
        if (foundNudgeZ !== null) break;
      }
      if (foundNudgeZ !== null) {
        const shiftZ =
          Math.sign(foundNudgeZ - slideZ) *
          Math.min(0.04, Math.abs(foundNudgeZ - slideZ));
        const steppedZ = clampZ(slideZ + shiftZ);
        if (
          isBoxValid(
            makeBox(slideX, steppedZ, hw, hd),
            roomBounds,
            obstacles,
            clearance,
          )
        ) {
          slideZ = steppedZ;
        }
        if (
          isBoxValid(
            makeBox(testX, slideZ, hw, hd),
            roomBounds,
            obstacles,
            clearance,
          )
        ) {
          slideX = testX;
        }
      }
    }
  }

  const nextPose: AppliancePose = {
    id,
    x: slideX,
    z: slideZ,
    rotY: current.rotY,
  };

  if (
    !isBoxValid(
      getApplianceBox(id, nextPose.x, nextPose.z, nextPose.rotY),
      roomBounds,
      obstacles,
      clearance,
    )
  ) {
    return blockedMove(current);
  }
  return placedMove(nextPose, contactedBoundary);
}

export function resolveApplianceRotation(
  current: AppliancePose,
  desiredRotY: number,
  roomBounds: Box2D,
  obstacles: readonly Box2D[],
  snapCardinal = true,
): ResolvedApplianceMove {
  const id = current.id;
  if (!Number.isFinite(desiredRotY)) return blockedMove(current);
  let norm = (desiredRotY + Math.PI) % (Math.PI * 2);
  if (norm < 0) norm += Math.PI * 2;
  norm -= Math.PI;

  if (snapCardinal) {
    const snapAngles = [-Math.PI, -HALF_PI, 0, HALF_PI, Math.PI];
    const snapThreshold = (6 * Math.PI) / 180;
    for (const target of snapAngles) {
      if (Math.abs(norm - target) <= snapThreshold) {
        norm = target === -Math.PI ? Math.PI : target;
        break;
      }
    }
  }

  const nextRotY = norm;
  const { halfWidth: hw, halfDepth: hd } = getOrientedExtents(id, nextRotY);
  const settled = findNearestValidPosition(
    current.x,
    current.z,
    hw,
    hd,
    roomBounds,
    obstacles,
    0.02,
  );
  if (settled === null) return blockedMove(current);
  const nextPose: AppliancePose = {
    id,
    x: settled.x,
    z: settled.z,
    rotY: nextRotY,
  };
  if (
    !isBoxValid(
      getApplianceBox(id, nextPose.x, nextPose.z, nextPose.rotY),
      roomBounds,
      obstacles,
      0.02,
    )
  ) {
    return blockedMove(current);
  }
  return placedMove(nextPose, settled.shifted);
}

function clampCoordinate(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function compareDisplacement(a: { dist: number }, b: { dist: number }): number {
  return a.dist - b.dist;
}
