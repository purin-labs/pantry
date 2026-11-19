import {
  getApplianceBox,
  isBoxValid,
  makeBox,
  findNearestValidPosition,
  resolveApplianceMove,
  resolveApplianceRotation,
  type ResolvedApplianceMove,
  type Box2D,
} from "@purin-labs/production-simulation/floor/collisions";
import {
  doorOpening,
  doorObstacleBoxes,
  doorThresholdWaypoints,
  isDoorOpen,
} from "@purin-labs/production-simulation/floor/openings";
import { floorPlanWorkspace } from "./floor-plan-workspace";
import { assertNever } from "@purin-labs/std";
import {
  distance,
  staffRoleProfileFor,
  transferZoneHandoff,
  type KitchenZoneId,
  type ScheduleSpatialLayout,
  type Station,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { BAKERY_FLOOR_PLANS, type BakeryFloorPlanId } from "@purin-labs/production-simulation/floor/bakery-room";
import type { FactoryStationSource } from "./spatial/factory-stations";

type StationId = Station["id"];

import {
  APPLIANCE_FOOTPRINTS,
  REHEARSAL_APPLIANCE_IDS,
  isApplianceId,
  type ApplianceId,
  type AppliancePose,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";

const HALF_PI = Math.PI / 2;

export function getApplianceHandoffPoint(
  planId: BakeryFloorPlanId,
  id: ApplianceId,
): readonly [number, number] {
  const pose = floorPlanWorkspace.getPose(planId, id);
  const fp = APPLIANCE_FOOTPRINTS[id];
  const [ox, oz] = fp.handoffOffset;
  const cos = Math.cos(pose.rotY);
  const sin = Math.sin(pose.rotY);
  const wx = pose.x + ox * cos + oz * sin;
  const wz = pose.z - ox * sin + oz * cos;
  const spec = BAKERY_FLOOR_PLANS[planId];
  const margin = 0.25;
  return [
    Math.max(
      -spec.width / 2 + margin,
      Math.min(spec.width / 2 - margin, Number(wx.toFixed(3))),
    ),
    Math.max(
      -spec.depth / 2 + margin,
      Math.min(spec.depth / 2 - margin, Number(wz.toFixed(3))),
    ),
  ];
}

export function getApplianceLocalHandoffPoint(
  planId: BakeryFloorPlanId,
  id: ApplianceId,
  lateralOffset: number,
): Readonly<{
  point: readonly [number, number];
  facingTarget: readonly [number, number];
}> {
  const pose = floorPlanWorkspace.getPose(planId, id);
  const fp = APPLIANCE_FOOTPRINTS[id];
  const [ox, oz] = fp.handoffOffset;
  const lx = ox + lateralOffset;
  const cos = Math.cos(pose.rotY);
  const sin = Math.sin(pose.rotY);
  const wx = pose.x + lx * cos + oz * sin;
  const wz = pose.z - lx * sin + oz * cos;
  const tx = pose.x + lx * cos;
  const tz = pose.z - lx * sin;
  const spec = BAKERY_FLOOR_PLANS[planId];
  const margin = 0.25;
  return {
    point: [
      Math.max(
        -spec.width / 2 + margin,
        Math.min(spec.width / 2 - margin, Number(wx.toFixed(3))),
      ),
      Math.max(
        -spec.depth / 2 + margin,
        Math.min(spec.depth / 2 - margin, Number(wz.toFixed(3))),
      ),
    ],
    facingTarget: [Number(tx.toFixed(3)), Number(tz.toFixed(3))],
  };
}

export function getWashSinkStandPoint(planId: BakeryFloorPlanId): Readonly<{
  point: readonly [number, number];
  facingTarget: readonly [number, number];
}> {
  const spec = BAKERY_FLOOR_PLANS[planId];
  const sink = spec.fixtures.find((f) => f.kind === "sink-counter");
  if (sink !== undefined) {
    const cx = Number(((sink.x0 + sink.x1) * 0.5).toFixed(3));
    const cz = Number(((sink.z0 + sink.z1) * 0.5).toFixed(3));
    const standZ = Number((Math.max(sink.z0, sink.z1) + 0.42).toFixed(3));
    const margin = 0.25;
    return {
      point: [
        Math.max(
          -spec.width / 2 + margin,
          Math.min(spec.width / 2 - margin, cx),
        ),
        Math.max(
          -spec.depth / 2 + margin,
          Math.min(spec.depth / 2 - margin, standZ),
        ),
      ],
      facingTarget: [cx, cz],
    };
  }
  const pt = getApplianceHandoffPoint(planId, "station-wash");
  const pose = floorPlanWorkspace.getPose(planId, "station-wash");
  return {
    point: pt,
    facingTarget: [pose.x, pose.z],
  };
}

export function getVitrineStandPoint(planId: BakeryFloorPlanId): Readonly<{
  point: readonly [number, number];
  facingTarget: readonly [number, number];
}> {
  const pt = getApplianceHandoffPoint(planId, "decor-vitrine");
  const pose = floorPlanWorkspace.getPose(planId, "decor-vitrine");
  return {
    point: pt,
    facingTarget: [pose.x, pose.z],
  };
}

export function getStorefrontCustomerPoints(
  planId: BakeryFloorPlanId,
): Readonly<{
  doorId: string | null;
  storefrontDoorOpen: boolean;
  doorThreshold: readonly [number, number];
  doorFacing: readonly [number, number];
  vitrineStand: Readonly<{
    point: readonly [number, number];
    facingTarget: readonly [number, number];
  }>;
  benchStand: Readonly<{
    point: readonly [number, number];
    facingTarget: readonly [number, number];
  }>;
}> {
  const spec = BAKERY_FLOOR_PLANS[planId];
  const frontDoor =
    spec.doors.find(
      (d) => d.id === "door-storefront-double" || d.id === "door-front-entry",
    ) ?? null;
  const storefrontDoorOpen =
    frontDoor === null
      ? true
      : isDoorOpen(
          floorPlanWorkspace.progress(doorOpening(planId, frontDoor)),
        );
  const doorLatchX =
    frontDoor !== null
      ? frontDoor.hingeZ < 0
        ? Number((frontDoor.hingeX - frontDoor.width * 0.5).toFixed(3))
        : Number(
            (
              frontDoor.hingeX +
              (frontDoor.leafX - frontDoor.hingeX) * 0.62
            ).toFixed(3),
          )
      : -1.6;
  const rawDoorZ =
    frontDoor !== null
      ? Number(
          (
            frontDoor.hingeZ +
            (frontDoor.hingeZ < 0 ? 1 : -1) *
              (storefrontDoorOpen ? 0.38 : 0.64)
          ).toFixed(3),
        )
      : Number((spec.depth / 2 - 0.45).toFixed(3));
  const doorThreshold = resolveWorkerObstaclePoint(
    planId,
    doorLatchX,
    rawDoorZ,
    REHEARSAL_APPLIANCE_IDS,
    0.26,
  );
  const doorFacing: readonly [number, number] = [
    doorLatchX,
    frontDoor !== null ? frontDoor.hingeZ : spec.depth / 2,
  ];
  const rawVitrine = getApplianceLocalHandoffPoint(
    planId,
    "decor-vitrine",
    0.24,
  );
  const vitrineStand = {
    point: resolveWorkerObstaclePoint(
      planId,
      rawVitrine.point[0],
      rawVitrine.point[1],
      REHEARSAL_APPLIANCE_IDS,
      0.26,
    ),
    facingTarget: rawVitrine.facingTarget,
  };
  const rawBench = getApplianceLocalHandoffPoint(planId, "decor-bench", 0);
  const benchStand = {
    point: resolveWorkerObstaclePoint(
      planId,
      rawBench.point[0],
      rawBench.point[1],
      REHEARSAL_APPLIANCE_IDS,
      0.26,
    ),
    facingTarget: rawBench.facingTarget,
  };
  return {
    doorId: frontDoor?.id ?? null,
    storefrontDoorOpen,
    doorThreshold,
    doorFacing,
    vitrineStand,
    benchStand,
  };
}

export function getColdStorageStandPoint(planId: BakeryFloorPlanId): Readonly<{
  point: readonly [number, number];
  facingTarget: readonly [number, number];
}> {
  const rawPt = getApplianceHandoffPoint(planId, "robot-cell");
  const pose = floorPlanWorkspace.getPose(planId, "robot-cell");
  const pt = resolveWorkerObstaclePoint(
    planId,
    rawPt[0],
    rawPt[1],
    REHEARSAL_APPLIANCE_IDS,
    0.28,
  );
  return {
    point: pt,
    facingTarget: [pose.x, pose.z],
  };
}

export function getOutfittedRehearsalStations(
  planId: BakeryFloorPlanId = floorPlanWorkspace.getActivePlan(),
  baseStations: readonly Station[],
): readonly (Station & Readonly<{ rotY: number }>)[] {
  return baseStations.map((st) => {
    const pose = floorPlanWorkspace.getPose(planId, st.id);
    return {
      ...st,
      position: [pose.x, st.position[1], pose.z] as const,
      handoff: getApplianceHandoffPoint(planId, st.id),
      rotY: pose.rotY,
    };
  });
}

export function getOutfittedRehearsalStation(
  id: StationId,
  planId: BakeryFloorPlanId = floorPlanWorkspace.getActivePlan(),
  baseStation: Station,
): Station & Readonly<{ rotY: number }> {
  const pose = floorPlanWorkspace.getPose(planId, id);
  return {
    ...baseStation,
    position: [pose.x, baseStation.position[1], pose.z] as const,
    handoff: getApplianceHandoffPoint(planId, id),
    rotY: pose.rotY,
  };
}

export function getOutfittedFactoryStations(
  planId: BakeryFloorPlanId,
  baseStations: readonly FactoryStationSource[],
): readonly (FactoryStationSource & Readonly<{ rotY: number }>)[] {
  return baseStations.map((st) => {
    if (!isApplianceId(st.id)) return { ...st, rotY: 0 };
    const pose = floorPlanWorkspace.getPose(planId, st.id);
    return {
      ...st,
      x: pose.x,
      z: pose.z,
      rotY: pose.rotY,
    };
  });
}

function roomBoundsFor(planId: BakeryFloorPlanId): Box2D {
  const spec = BAKERY_FLOOR_PLANS[planId];
  const inset = planId === "reference" ? 0.08 : 0.1;
  return {
    x0: -spec.width / 2 + inset,
    z0: -spec.depth / 2 + inset,
    x1: spec.width / 2 - inset,
    z1: spec.depth / 2 - inset,
  };
}

function getRoomStaticObstacles(planId: BakeryFloorPlanId): readonly Box2D[] {
  const spec = BAKERY_FLOOR_PLANS[planId];
  const boxes: Box2D[] = [...(spec.voids ?? [])];
  for (const wall of spec.walls) {
    const halfT = wall.thickness / 2;
    const dx = wall.x1 - wall.x0;
    const dz = wall.z1 - wall.z0;
    if (Math.abs(dx) > 0.02 && Math.abs(dz) > 0.02) {
      const samples = 4;
      const segHalf = (Math.hypot(dx, dz) / samples) * 0.5 + halfT;
      for (let i = 0; i < samples; i += 1) {
        const t = (i + 0.5) / samples;
        const cx = wall.x0 + dx * t;
        const cz = wall.z0 + dz * t;
        boxes.push({
          x0: cx - segHalf,
          z0: cz - segHalf,
          x1: cx + segHalf,
          z1: cz + segHalf,
        });
      }
      continue;
    }
    boxes.push({
      x0: Math.min(wall.x0, wall.x1) - halfT,
      z0: Math.min(wall.z0, wall.z1) - halfT,
      x1: Math.max(wall.x0, wall.x1) + halfT,
      z1: Math.max(wall.z0, wall.z1) + halfT,
    });
  }
  for (const col of spec.columns) {
    boxes.push({ x0: col.x0, z0: col.z0, x1: col.x1, z1: col.z1 });
  }
  for (const stair of spec.stairs ?? []) {
    boxes.push(
      { x0: stair.x0, z0: stair.lowerTopZ, x1: stair.x1, z1: stair.z1 },
      { x0: stair.x0, z0: stair.z0, x1: stair.turnSplitX, z1: stair.lowerTopZ },
    );
  }
  for (const fix of spec.fixtures) {
    if (fix.kind === "sink-counter") continue;
    boxes.push({ x0: fix.x0, z0: fix.z0, x1: fix.x1, z1: fix.z1 });
  }
  for (const door of spec.doors) {
    const progress = floorPlanWorkspace.progress(doorOpening(planId, door));
    boxes.push(...doorObstacleBoxes(door, progress));
  }
  return boxes;
}

function buildObstacleList(
  planId: BakeryFloorPlanId,
  movingId: ApplianceId | null,
  peerIds: readonly ApplianceId[],
): readonly Box2D[] {
  const obstacles: Box2D[] = [...getRoomStaticObstacles(planId)];
  for (const peerId of peerIds) {
    if (peerId === movingId) continue;
    // Espresso cobot is mounted at the beverage bar counter, so they move together.
    if (
      (movingId === "station-beverage-bar" && peerId === "espresso-cell") ||
      (movingId === "espresso-cell" && peerId === "station-beverage-bar")
    ) {
      continue;
    }
    const peerPose = floorPlanWorkspace.getPose(planId, peerId);
    obstacles.push(
      getApplianceBox(peerId, peerPose.x, peerPose.z, peerPose.rotY),
    );
  }
  return obstacles;
}

/**
 * Resolves a drag target `(desiredX, desiredZ)` against all room walls,
 * structural columns, plumbing fixtures, and peer appliances/workcells so
 * that no clipping or overlap can occur, while funneling through doorways
 * when the appliance's current orientation fits the opening.
 */
export function moveApplianceWithCollisions(
  planId: BakeryFloorPlanId,
  id: ApplianceId,
  desiredX: number,
  desiredZ: number,
  peerIds: readonly ApplianceId[],
  gestureId?: string,
): ResolvedApplianceMove {
  const result = resolveApplianceMove(
    floorPlanWorkspace.getPose(planId, id),
    desiredX,
    desiredZ,
    roomBoundsFor(planId),
    buildObstacleList(planId, id, peerIds),
  );
  commitApplianceMove(planId, result, {
    label: `Move ${APPLIANCE_FOOTPRINTS[id].label}`,
    ...(gestureId !== undefined ? { gestureId } : {}),
  });
  return result;
}

function commitApplianceMove(
  planId: BakeryFloorPlanId,
  result: ResolvedApplianceMove,
  options?: Readonly<{ gestureId?: string; label?: string }>,
): void {
  switch (result.kind) {
    case "blocked":
      return;
    case "placed": {
      const next = result.pose;
      const current = floorPlanWorkspace.getPose(planId, next.id);
      if (
        current.x === next.x &&
        current.z === next.z &&
        current.rotY === next.rotY
      )
        return;
      const poses: AppliancePose[] = [next];
      if (next.id === "station-beverage-bar") {
        const mounted = floorPlanWorkspace.getPose(planId, "espresso-cell");
        const angle = next.rotY - current.rotY;
        const dx = mounted.x - current.x;
        const dz = mounted.z - current.z;
        poses.push({
          id: "espresso-cell",
          x: next.x + dx * Math.cos(angle) + dz * Math.sin(angle),
          z: next.z - dx * Math.sin(angle) + dz * Math.cos(angle),
          rotY: mounted.rotY + angle,
        });
      }
      floorPlanWorkspace.setPoses(planId, poses, options);
      return;
    }
    default:
      assertNever(result);
  }
}

/**
 * Sets an appliance's yaw rotation `desiredRotY` (in radians) while keeping it
 * inside walls and clear of peers. Soft-snaps within ±6° of 0°, ±90°, 180°
 * when `snapCardinal` is true so aligning with walls and doorways is effortless.
 */
export function setApplianceRotationWithCollisions(
  planId: BakeryFloorPlanId,
  id: ApplianceId,
  desiredRotY: number,
  peerIds: readonly ApplianceId[],
  snapCardinal = true,
  gestureId?: string,
): ResolvedApplianceMove {
  const result = resolveApplianceRotation(
    floorPlanWorkspace.getPose(planId, id),
    desiredRotY,
    roomBoundsFor(planId),
    buildObstacleList(planId, id, peerIds),
    snapCardinal,
  );
  commitApplianceMove(planId, result, {
    label: `Rotate ${APPLIANCE_FOOTPRINTS[id].label}`,
    ...(gestureId !== undefined ? { gestureId } : {}),
  });
  return result;
}

/** Rotates an appliance by 90 degrees while keeping it inside walls and clear of peers. */
export function rotateApplianceWithCollisions(
  planId: BakeryFloorPlanId,
  id: ApplianceId,
  peerIds: readonly ApplianceId[],
): ResolvedApplianceMove {
  const current = floorPlanWorkspace.getPose(planId, id);
  const nextQuarter = Math.round(current.rotY / HALF_PI) * HALF_PI + HALF_PI;
  return setApplianceRotationWithCollisions(
    planId,
    id,
    nextQuarter,
    peerIds,
    true,
  );
}

export type WorkerPlacementRequest = Readonly<{
  x: number;
  z: number;
  /** Higher priority (2 = active station work, 1 = walking, 0 = idle) resists displacement more when separating pairs. */
  priority?: number;
}>;

const WORKER_READY_SLOTS: Readonly<
  Record<BakeryFloorPlanId, readonly (readonly [number, number])[]>
> = {
  "asakusabashi-t101940": [
    [-0.55, 0.22],
    [0.18, 0.38],
    [-0.28, 0.96],
  ],
  "kinshicho-61146": [
    [-0.62, 0.2],
    [0.12, 0.34],
    [-0.3, 0.9],
  ],
  "machiya-sun-reve": [
    [-0.52, -0.35],
    [-0.25, 0.35],
    [0.48, 1.98],
  ],
  "hongo-8257562": [
    [-0.45, 0.55],
    [-0.25, 1.75],
    [0.42, 0.58],
  ],
  reference: [
    [-2.5, 0.45],
    [-1.6, 0.45],
    [-0.7, 0.45],
  ],
};

/**
 * Zone-specialized ready/idle positions for each baker in their assigned
 * kitchen zone (`stage` for Prep & Portioning, `cool` for Hearth & Cooling,
 * `pack` for Packing & Vitrine), kept clear of all room obstacles.
 */
export function getWorkerReadyPoint(
  planId: BakeryFloorPlanId,
  workerIndex: number,
): readonly [number, number] {
  const profile = staffRoleProfileFor(workerIndex);
  const homeHandoff = getApplianceHandoffPoint(planId, profile.homeStation);
  const slots = WORKER_READY_SLOTS[planId];
  const fallback = slots[workerIndex % slots.length] ?? [0, 0.35];
  const blendedX = homeHandoff[0] * 0.72 + fallback[0] * 0.28;
  const blendedZ = homeHandoff[1] * 0.72 + fallback[1] * 0.28;
  return resolveWorkerObstaclePoint(
    planId,
    blendedX,
    blendedZ,
    ["stage", "portion", "bake", "cool", "pack"],
    0.28,
  );
}

function getWorkerRoomBoundsAndObstacles(
  planId: BakeryFloorPlanId,
  activeApplianceIds: readonly ApplianceId[],
): Readonly<{ roomBounds: Box2D; obstacles: readonly Box2D[] }> {
  const spec = BAKERY_FLOOR_PLANS[planId];
  const wallInset = planId === "reference" ? 0.08 : 0.1;
  const roomBounds: Box2D = {
    x0: -spec.width / 2 + wallInset,
    z0: -spec.depth / 2 + wallInset,
    x1: spec.width / 2 - wallInset,
    z1: spec.depth / 2 - wallInset,
  };
  const obstacles = buildObstacleList(planId, null, activeApplianceIds);
  return { roomBounds, obstacles };
}

/**
 * Projects a single worker coordinate `(x, z)` outside all room walls,
 * columns, plumbing fixtures, and active tables/appliances by `workerRadius`.
 */
export function resolveWorkerObstaclePoint(
  planId: BakeryFloorPlanId,
  x: number,
  z: number,
  activeApplianceIds: readonly ApplianceId[],
  workerRadius = 0.28,
): readonly [number, number] {
  const { roomBounds, obstacles } = getWorkerRoomBoundsAndObstacles(
    planId,
    activeApplianceIds,
  );
  const settled = findNearestValidPosition(
    x,
    z,
    workerRadius,
    workerRadius,
    roomBounds,
    obstacles,
    0.02,
  );
  if (settled === null) return [x, z];
  return [settled.x, settled.z];
}

function isSegmentClear(
  a: readonly [number, number],
  b: readonly [number, number],
  radius: number,
  roomBounds: Box2D,
  obstacles: readonly Box2D[],
  clearance: number,
): boolean {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(4, Math.ceil(dist / 0.06));
  for (let i = 1; i < steps; i += 1) {
    const u = i / steps;
    const sx = a[0] + (b[0] - a[0]) * u;
    const sz = a[1] + (b[1] - a[1]) * u;
    if (
      !isBoxValid(
        makeBox(sx, sz, radius, radius),
        roomBounds,
        obstacles,
        clearance,
      )
    ) {
      return false;
    }
  }
  return true;
}

const ROOM_PASSAGE_WAYPOINTS: Readonly<
  Record<BakeryFloorPlanId, readonly (readonly [number, number])[]>
> = {
  "asakusabashi-t101940": [
    [-1.15, -1.15],
    [-1.15, -1.68],
    [-1.15, -2.18],
    [-0.25, -2.25],
    [0.78, -2.25],
    [-0.85, 0.25],
    [0.85, 0.25],
  ],
  "kinshicho-61146": [
    [-1.4, -1.45],
    [-1.4, -2.12],
    [0.18, -1.78],
    [0.18, -2.35],
    [-0.6, 0.25],
    [0.6, 0.25],
  ],
  "machiya-sun-reve": [
    [-1.2, -2.2],
    [-0.48, -2.2],
    [-0.48, -1.05],
    [-0.48, 0.15],
    [-0.02, 0.15],
    [0.52, 0.72],
    [-0.02, 1.15],
    [0.52, 1.15],
    [0.52, 1.6],
    [0.52, 1.98],
    [-0.15, 1.98],
    [-0.82, 1.98],
  ],
  "hongo-8257562": [
    [1.12, -1.88],
    [0.12, -1.88],
    [0.08, -2.56],
    [1.06, -0.92],
    [-0.35, -0.58],
    [-0.2, 0.58],
    [0.45, 0.58],
    [-0.2, 1.75],
    [0.45, 1.75],
    [-0.2, 2.75],
  ],
  reference: [
    [-1.5, 0.1],
    [0, 0.1],
    [1.5, 0.1],
  ],
};

const walkPolylineCache = new Map<
  string,
  readonly (readonly [number, number])[]
>();

function computeRoomWalkPolyline(
  planId: BakeryFloorPlanId,
  from: readonly [number, number],
  to: readonly [number, number],
  activeApplianceIds: readonly ApplianceId[],
  workerRadius: number,
): readonly (readonly [number, number])[] {
  const cacheKey = `${planId}:${floorPlanWorkspace.getPlacementVersion()}:${floorPlanWorkspace.getOpeningVersion()}:${from[0].toFixed(3)},${from[1].toFixed(3)}->${to[0].toFixed(3)},${to[1].toFixed(3)}:${workerRadius.toFixed(2)}:${activeApplianceIds.join(",")}`;
  const cached = walkPolylineCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const startPt = resolveWorkerObstaclePoint(
    planId,
    from[0],
    from[1],
    activeApplianceIds,
    workerRadius,
  );
  const endPt = resolveWorkerObstaclePoint(
    planId,
    to[0],
    to[1],
    activeApplianceIds,
    workerRadius,
  );
  if (Math.hypot(endPt[0] - startPt[0], endPt[1] - startPt[1]) < 1e-3) {
    const trivial = [startPt, endPt] as const;
    walkPolylineCache.set(cacheKey, trivial);
    return trivial;
  }

  const { roomBounds, obstacles } = getWorkerRoomBoundsAndObstacles(
    planId,
    activeApplianceIds,
  );
  const clearance = 0.02;
  const pathRadius = Math.min(workerRadius, 0.24);

  if (
    isSegmentClear(startPt, endPt, pathRadius, roomBounds, obstacles, clearance)
  ) {
    const direct = [startPt, endPt] as const;
    if (walkPolylineCache.size > 256) walkPolylineCache.clear();
    walkPolylineCache.set(cacheKey, direct);
    return direct;
  }

  const spec = BAKERY_FLOOR_PLANS[planId];
  const rawCandidates: (readonly [number, number])[] = [
    [
      planId === "reference"
        ? (startPt[0] + endPt[0]) * 0.5
        : (startPt[0] + endPt[0]) * 0.25,
      planId === "reference" ? 0.1 : 0.35,
    ],
    [0, planId === "reference" ? 0.1 : 0.35],
    ...ROOM_PASSAGE_WAYPOINTS[planId],
  ];

  const midX = (startPt[0] + endPt[0]) * 0.5;
  const midZ = (startPt[1] + endPt[1]) * 0.5;
  const dx = endPt[0] - startPt[0];
  const dz = endPt[1] - startPt[1];
  const segLen = Math.hypot(dx, dz);
  if (segLen > 1e-3) {
    const nx = -dz / segLen;
    const nz = dx / segLen;
    for (const offset of [-0.95, -0.55, 0.55, 0.95]) {
      rawCandidates.push([midX + nx * offset, midZ + nz * offset]);
    }
  }

  for (const door of spec.doors) {
    const progress = floorPlanWorkspace.progress(doorOpening(planId, door));
    if (isDoorOpen(progress)) {
      rawCandidates.push(...doorThresholdWaypoints(door));
    }
  }

  const nodes: (readonly [number, number])[] = [startPt];
  for (const cand of rawCandidates) {
    const settled = findNearestValidPosition(
      cand[0],
      cand[1],
      pathRadius,
      pathRadius,
      roomBounds,
      obstacles,
      clearance,
    );
    if (settled === null) continue;
    const pt: readonly [number, number] = [
      Number(settled.x.toFixed(3)),
      Number(settled.z.toFixed(3)),
    ];
    if (
      !nodes.some((existing) => Math.hypot(existing[0] - pt[0], existing[1] - pt[1]) < 0.08)
    ) {
      nodes.push(pt);
    }
  }
  const endIndex = nodes.length;
  nodes.push(endPt);

  const count = nodes.length;
  const dist = new Array<number>(count).fill(Infinity);
  const prev = new Array<number>(count).fill(-1);
  const visited = new Array<boolean>(count).fill(false);
  dist[0] = 0;

  for (let step = 0; step < count; step += 1) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < count; i += 1) {
      if (!visited[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u === -1 || u === endIndex) break;
    visited[u] = true;
    const nodeU = nodes[u]!;
    for (let v = 0; v < count; v += 1) {
      if (visited[v] || v === u) continue;
      const nodeV = nodes[v]!;
      if (
        !isSegmentClear(
          nodeU,
          nodeV,
          pathRadius,
          roomBounds,
          obstacles,
          clearance,
        )
      ) {
        continue;
      }
      const weight = Math.hypot(nodeV[0] - nodeU[0], nodeV[1] - nodeU[1]);
      if (dist[u]! + weight < dist[v]!) {
        dist[v] = dist[u]! + weight;
        prev[v] = u;
      }
    }
  }

  let targetIdx = endIndex;
  let stopBeforeClosedObstacle: readonly [number, number] | null = null;
  if (!Number.isFinite(dist[endIndex])) {
    let closestIdx = 0;
    let closestDist = Math.hypot(endPt[0] - startPt[0], endPt[1] - startPt[1]);
    for (let i = 1; i < endIndex; i += 1) {
      if (!Number.isFinite(dist[i])) continue;
      const d = Math.hypot(endPt[0] - nodes[i]![0], endPt[1] - nodes[i]![1]);
      if (d < closestDist) {
        closestDist = d;
        closestIdx = i;
      }
    }
    targetIdx = closestIdx;
    const anchor = nodes[closestIdx]!;
    const remDx = endPt[0] - anchor[0];
    const remDz = endPt[1] - anchor[1];
    const remLen = Math.hypot(remDx, remDz);
    const maxSteps = Math.max(1, Math.floor(remLen / 0.03));
    let lastValid: readonly [number, number] = anchor;
    for (let s = 1; s <= maxSteps; s += 1) {
      const candX = anchor[0] + (remDx * s) / maxSteps;
      const candZ = anchor[1] + (remDz * s) / maxSteps;
      if (
        isBoxValid(
          makeBox(candX, candZ, pathRadius, pathRadius),
          roomBounds,
          obstacles,
          clearance,
        )
      ) {
        lastValid = [Number(candX.toFixed(3)), Number(candZ.toFixed(3))];
      } else {
        break;
      }
    }
    if (Math.hypot(lastValid[0] - anchor[0], lastValid[1] - anchor[1]) > 0.02) {
      stopBeforeClosedObstacle = lastValid;
    }
  }

  const chain: (readonly [number, number])[] = [];
  let curr = targetIdx;
  while (curr !== -1) {
    chain.push(nodes[curr]!);
    curr = prev[curr]!;
  }
  chain.reverse();
  if (stopBeforeClosedObstacle !== null) {
    chain.push(stopBeforeClosedObstacle);
  }
  if (chain.length < 2) {
    chain.push(chain[0] ?? startPt);
  }

  if (walkPolylineCache.size > 256) walkPolylineCache.clear();
  walkPolylineCache.set(cacheKey, chain);
  return chain;
}

/**
 * Smoothly interpolates a walking path from `from` to `to` in room space,
 * routing through open doorways and passages while respecting walls, closed
 * doors, swung-open door leaves, and appliances.
 */
export function interpolateRoomWalk(
  planId: BakeryFloorPlanId,
  from: readonly [number, number],
  to: readonly [number, number],
  u: number,
  activeApplianceIds: readonly ApplianceId[],
  workerRadius = 0.28,
): readonly [number, number] {
  const polyline = computeRoomWalkPolyline(
    planId,
    from,
    to,
    activeApplianceIds,
    workerRadius,
  );
  const t = Math.max(0, Math.min(1, u));
  if (t <= 0) return polyline[0]!;
  if (t >= 1) return polyline[polyline.length - 1]!;

  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1]!;
    const b = polyline[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cumulative.push(total);
  }
  if (total < 1e-4) return polyline[0]!;

  const targetDist = t * total;
  for (let i = 1; i < polyline.length; i += 1) {
    const segStart = cumulative[i - 1]!;
    const segEnd = cumulative[i]!;
    if (targetDist <= segEnd || i === polyline.length - 1) {
      const segLen = Math.max(1e-5, segEnd - segStart);
      const localU = Math.max(0, Math.min(1, (targetDist - segStart) / segLen));
      const a = polyline[i - 1]!;
      const b = polyline[i]!;
      return [
        Number((a[0] + (b[0] - a[0]) * localU).toFixed(3)),
        Number((a[1] + (b[1] - a[1]) * localU).toFixed(3)),
      ];
    }
  }
  return polyline[polyline.length - 1]!;
}

/**
 * Simultaneously enforces:
 * 1. Obstacle clearance (`workerRadius = 0.28 m`) from all tables, appliances,
 *    furnishings, walls, columns, and plumbing fixtures.
 * 2. Mutual person-to-person separation (`minWorkerDist = 0.62 m` center-to-center,
 *    giving >= 0.23 m clear air gap between 0.39 m human shoulders), sliding
 *    laterally along counters or into the open aisle when a table is behind a worker.
 */
export function resolveMultiWorkerPositions(
  planId: BakeryFloorPlanId,
  requests: readonly WorkerPlacementRequest[],
  activeApplianceIds: readonly ApplianceId[],
  minWorkerDist = 0.62,
  workerRadius = 0.28,
): readonly (readonly [number, number])[] {
  if (requests.length === 0) return [];
  const { roomBounds, obstacles } = getWorkerRoomBoundsAndObstacles(
    planId,
    activeApplianceIds,
  );
  const clearance = 0.02;

  const pts = requests.map((req) => {
    const valid = findNearestValidPosition(
      req.x,
      req.z,
      workerRadius,
      workerRadius,
      roomBounds,
      obstacles,
      clearance,
    );
    return {
      x: valid === null ? req.x : valid.x,
      z: valid === null ? req.z : valid.z,
      priority: req.priority ?? 1,
    };
  });

  if (pts.length === 1) {
    const p0 = pts[0]!;
    return [[Number(p0.x.toFixed(3)), Number(p0.z.toFixed(3))]];
  }

  for (let iter = 0; iter < 18; iter++) {
    let anyOverlap = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!;
        const b = pts[j]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= minWorkerDist - 1e-3) continue;
        anyOverlap = true;

        const overlap = minWorkerDist - dist + 0.01;
        let ux: number;
        let uz: number;
        if (dist > 1e-3) {
          ux = dx / dist;
          uz = dz / dist;
        } else {
          // Deterministic separation toward the open central aisle / along the counter
          const toCenterA = Math.atan2(0.35 - a.z, -0.2 - a.x);
          const angle = toCenterA + (j - i - 0.5) * 0.85;
          ux = Math.cos(angle);
          uz = Math.sin(angle);
        }

        const wA =
          a.priority > b.priority ? 0.12 : a.priority < b.priority ? 0.88 : 0.5;
        const wB = 1 - wA;

        // Try direct separation and tangent slides so a worker backed against a counter
        // slides cleanly along the counter edge or into the aisle instead of getting pinned.
        const stepCandidate = (
          originX: number,
          originZ: number,
          otherX: number,
          otherZ: number,
          dirX: number,
          dirZ: number,
          stepLen: number,
        ): { x: number; z: number } => {
          const angles = [
            0,
            0.65,
            -0.65,
            1.25,
            -1.25,
            Math.PI / 2,
            -Math.PI / 2,
          ];
          let bestPos = { x: originX, z: originZ };
          let bestScore = -Infinity;
          for (const ang of angles) {
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            const rx = dirX * ca - dirZ * sa;
            const rz = dirX * sa + dirZ * ca;
            const cand = findNearestValidPosition(
              originX + rx * stepLen,
              originZ + rz * stepLen,
              workerRadius,
              workerRadius,
              roomBounds,
              obstacles,
              clearance,
            );
            if (cand === null) continue;
            const newDist = Math.hypot(cand.x - otherX, cand.z - otherZ);
            const score = newDist - Math.abs(ang) * 0.06;
            if (score > bestScore) {
              bestScore = score;
              bestPos = { x: cand.x, z: cand.z };
            }
          }
          return bestPos;
        };

        if (wA >= wB) {
          const nextA = stepCandidate(
            a.x,
            a.z,
            b.x,
            b.z,
            -ux,
            -uz,
            overlap * wA,
          );
          a.x = nextA.x;
          a.z = nextA.z;
          const nextB = stepCandidate(b.x, b.z, a.x, a.z, ux, uz, overlap * wB);
          b.x = nextB.x;
          b.z = nextB.z;
        } else {
          const nextB = stepCandidate(b.x, b.z, a.x, a.z, ux, uz, overlap * wB);
          b.x = nextB.x;
          b.z = nextB.z;
          const nextA = stepCandidate(
            a.x,
            a.z,
            b.x,
            b.z,
            -ux,
            -uz,
            overlap * wA,
          );
          a.x = nextA.x;
          a.z = nextA.z;
        }
      }
    }
    if (!anyOverlap) break;
  }

  return pts.map((p) => {
    const finalValid = findNearestValidPosition(
      p.x,
      p.z,
      workerRadius,
      workerRadius,
      roomBounds,
      obstacles,
      clearance,
    );
    if (finalValid === null) return [p.x, p.z] as const;
    return [
      Number(finalValid.x.toFixed(3)),
      Number(finalValid.z.toFixed(3)),
    ] as const;
  });
}

const REHEARSAL_STATION_IDS: readonly StationId[] = [
  "stage",
  "portion",
  "bake",
  "cool",
  "pack",
];

/**
 * Samples an obstacle-avoiding 3D room walk trajectory between `from` and `to`
 * on the active floor plan so `schedule.ts` computes real room walking distance
 * and travel time (`travelSeconds`) from live 3D station positions.
 */
export function buildLiveRoomRoute(
  planId: BakeryFloorPlanId,
  from: readonly [number, number],
  to: readonly [number, number],
  activeApplianceIds: readonly ApplianceId[] = REHEARSAL_STATION_IDS,
): readonly (readonly [number, number])[] {
  return computeRoomWalkPolyline(planId, from, to, activeApplianceIds, 0.28);
}

export function computeRoomWalkDistanceMeters(
  planId: BakeryFloorPlanId,
  from: readonly [number, number],
  to: readonly [number, number],
  activeApplianceIds: readonly ApplianceId[] = REHEARSAL_STATION_IDS,
  workerRadius = 0.28,
): number {
  return distance(
    computeRoomWalkPolyline(planId, from, to, activeApplianceIds, workerRadius),
  );
}

export function buildLiveScheduleSpatialLayout(
  planId: BakeryFloorPlanId = floorPlanWorkspace.getActivePlan(),
): ScheduleSpatialLayout {
  const stagePose = floorPlanWorkspace.getPose(planId, "stage");
  const portionPose = floorPlanWorkspace.getPose(planId, "portion");
  const bakePose = floorPlanWorkspace.getPose(planId, "bake");
  const coolPose = floorPlanWorkspace.getPose(planId, "cool");
  const packPose = floorPlanWorkspace.getPose(planId, "pack");
  return {
    handoffs: {
      stage: getApplianceHandoffPoint(planId, "stage"),
      portion: getApplianceHandoffPoint(planId, "portion"),
      bake: getApplianceHandoffPoint(planId, "bake"),
      cool: getApplianceHandoffPoint(planId, "cool"),
      pack: getApplianceHandoffPoint(planId, "pack"),
    },
    positions: {
      stage: [stagePose.x, 0, stagePose.z],
      portion: [portionPose.x, 0, portionPose.z],
      bake: [bakePose.x, 0.902, bakePose.z],
      cool: [coolPose.x, 0, coolPose.z],
      pack: [packPose.x, 0, packPose.z],
    },
    workerStarts: [
      getWorkerReadyPoint(planId, 0),
      getWorkerReadyPoint(planId, 1),
      getWorkerReadyPoint(planId, 2),
      getWorkerReadyPoint(planId, 3),
    ],
    routeBetween: (from, to) =>
      buildLiveRoomRoute(planId, from, to, REHEARSAL_STATION_IDS),
  };
}

export type LiveStationWalkLeg = Readonly<{
  from: StationId;
  to: StationId;
  fromZone: KitchenZoneId;
  toZone: KitchenZoneId;
  fromZoneLabel: string;
  toZoneLabel: string;
  isZoneBoundary: boolean;
  handoffSummary: string;
  distanceMeters: number;
  walkSeconds: number;
}>;

export function getLiveStationWalkLegs(
  planId: BakeryFloorPlanId = floorPlanWorkspace.getActivePlan(),
): readonly LiveStationWalkLeg[] {
  const pairs: readonly (readonly [StationId, StationId])[] = [
    ["stage", "portion"],
    ["portion", "bake"],
    ["bake", "cool"],
    ["cool", "pack"],
  ];
  return pairs.map(([from, to]) => {
    const a = getApplianceHandoffPoint(planId, from);
    const b = getApplianceHandoffPoint(planId, to);
    const path = buildLiveRoomRoute(planId, a, b, REHEARSAL_STATION_IDS);
    const dist = distance(path);
    const handoff = transferZoneHandoff(from, to);
    return {
      from,
      to,
      fromZone: handoff.fromZone,
      toZone: handoff.toZone,
      fromZoneLabel: handoff.fromZoneLabel,
      toZoneLabel: handoff.toZoneLabel,
      isZoneBoundary: handoff.isZoneBoundary,
      handoffSummary: handoff.summary,
      distanceMeters: Number(dist.toFixed(2)),
      walkSeconds: Math.ceil(dist / 0.8),
    };
  });
}
