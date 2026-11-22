import {
  durationFromSeconds,
  type CompiledScenario,
  type TravelRoute,
} from "@purin-labs/production-simulation";
import { shiftTravel } from "@purin-labs/production-simulation/recipes/bakery/bakery-shift";
import {
  APPLIANCE_FOOTPRINTS,
  STORE_DECOR_IDS,
  isApplianceId,
  type ApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";
import { computeRoomWalkDistanceMeters } from "../workflow-simulator/bakery-appliance-layout";
import type { BakeryFloorPlanId } from "@purin-labs/production-simulation/floor/bakery-room";
import { floorPlanWorkspace } from "../workflow-simulator/floor-plan-workspace";
import type { FactoryStationSource } from "../workflow-simulator/spatial/factory-stations";
import { factoryStationsForScenario } from "./factory-places";
import { MORNING_SHIFT_STATIONS } from "./morning-shift-appliances";

type WalkSpeedPreset = "standard" | "brisk" | "congested-aisle";

const WALK_SPEED_MPS: Readonly<Record<WalkSpeedPreset, number>> = {
  brisk: 1.5,
  standard: 1.25,
  "congested-aisle": 0.95,
};

const STATION_SETTLE_SECONDS: Readonly<Record<WalkSpeedPreset, number>> = {
  brisk: 0.4,
  standard: 0.8,
  "congested-aisle": 1.6,
};

const SAME_STATION_SIDESTEP_METERS = 1.1;

function stationStandPointOnFloorPlan(
  planId: BakeryFloorPlanId,
  station: FactoryStationSource,
): readonly [number, number] {
  if (!isApplianceId(station.id)) return [station.x, station.z + 0.78];
  const pose = floorPlanWorkspace.getPose(planId, station.id);
  const footprint = APPLIANCE_FOOTPRINTS[station.id];
  const [ox, oz] = footprint?.handoffOffset ?? [0, 0.78];
  const cos = Math.cos(pose.rotY);
  const sin = Math.sin(pose.rotY);
  return [pose.x + ox * cos + oz * sin, pose.z - ox * sin + oz * cos];
}

function scenarioStationObstacleIds(
  stations: readonly FactoryStationSource[],
): readonly ApplianceId[] {
  const ids: ApplianceId[] = [
    ...stations.map((s) => s.id).filter(isApplianceId),
    ...STORE_DECOR_IDS,
  ];
  if (stations.some((s) => s.id === "station-beverage-bar")) {
    ids.push("pour-over-cell", "espresso-cell");
  }
  return ids;
}

export function scenarioPeerApplianceIds(
  scenario: CompiledScenario,
): readonly ApplianceId[] {
  const stations = factoryStationsForScenario(scenario) ?? MORNING_SHIFT_STATIONS;
  const ids = [...scenarioStationObstacleIds(stations)];
  if (scenario.id === "bakery-shift") {
    ids.push("robot-cell", "tea-pan-cell");
  } else if (scenario.cells.length > 0) {
    ids.push("robot-cell");
  }
  return ids;
}

export function buildFloorPlanTravelRoutes(
  planId: BakeryFloorPlanId,
  stations: readonly FactoryStationSource[],
  baseTravel: readonly TravelRoute[],
  walkSpeedPreset: WalkSpeedPreset = "standard",
): readonly TravelRoute[] {
  const obstacleIds = scenarioStationObstacleIds(stations);
  const speedMps = WALK_SPEED_MPS[walkSpeedPreset];
  const settleSeconds = STATION_SETTLE_SECONDS[walkSpeedPreset];
  const stationByLocation = new Map<string, FactoryStationSource>();
  for (const station of stations) {
    for (const loc of station.locations) {
      if (!stationByLocation.has(loc)) stationByLocation.set(loc, station);
    }
  }
  const standByStationId = new Map<string, readonly [number, number]>();
  for (const station of stations) {
    standByStationId.set(
      station.id,
      stationStandPointOnFloorPlan(planId, station),
    );
  }
  const distanceCache = new Map<string, number>();

  return baseTravel.map((route) => {
    const fromStation = stationByLocation.get(route.from);
    const toStation = stationByLocation.get(route.to);
    if (fromStation === undefined || toStation === undefined) return route;
    let distMeters: number;
    if (fromStation.id === toStation.id) {
      distMeters = SAME_STATION_SIDESTEP_METERS;
    } else {
      const cacheKey = `${fromStation.id}\0${toStation.id}`;
      const cached = distanceCache.get(cacheKey);
      if (cached !== undefined) {
        distMeters = cached;
      } else {
        const fromPt = standByStationId.get(fromStation.id)!;
        const toPt = standByStationId.get(toStation.id)!;
        distMeters = computeRoomWalkDistanceMeters(
          planId,
          fromPt,
          toPt,
          obstacleIds,
        );
        distanceCache.set(cacheKey, distMeters);
      }
    }
    const seconds = Math.max(
      1,
      Math.round(distMeters / speedMps + settleSeconds),
    );
    const parsed = durationFromSeconds(seconds);
    if (!parsed.ok) return route;
    return {
      from: route.from,
      to: route.to,
      duration: parsed.value,
      evidence: "model",
    };
  });
}

export function buildShiftFloorPlanTravel(
  walkSpeedPreset: WalkSpeedPreset = "standard",
  planId: BakeryFloorPlanId = floorPlanWorkspace.getActivePlan(),
): readonly TravelRoute[] {
  return buildFloorPlanTravelRoutes(
    planId,
    MORNING_SHIFT_STATIONS,
    shiftTravel(walkSpeedPreset),
    walkSpeedPreset,
  );
}

export function inferScenarioWalkSpeedPreset(
  scenario: CompiledScenario,
  planId: BakeryFloorPlanId = floorPlanWorkspace.getActivePlan(),
): WalkSpeedPreset {
  for (const resource of scenario.resources) {
    if (resource.kind !== "worker") continue;
    for (const route of resource.travel) {
      if (route.from === "tea-station" && route.to === "coffee-station") {
        const sec = Math.round(route.duration / 1_000_000);
        if (route.evidence === "model") {
          if (sec <= 1) return "brisk";
          if (sec >= 3) return "congested-aisle";
          return "standard";
        }
        if (sec <= 4) return "brisk";
        if (sec >= 7) return "congested-aisle";
        return "standard";
      }
    }
    const stations = factoryStationsForScenario(scenario);
    if (
      stations !== null &&
      resource.travel.some((route) => route.evidence === "model")
    ) {
      let bestPreset: WalkSpeedPreset = "standard";
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const candidate of [
        "standard",
        "brisk",
        "congested-aisle",
      ] as const) {
        const candidateRoutes = buildFloorPlanTravelRoutes(
          planId,
          stations,
          resource.travel,
          candidate,
        );
        if (sameTravelDurations(resource.travel, candidateRoutes)) {
          return candidate;
        }
        let delta = 0;
        for (let i = 0; i < resource.travel.length; i += 1) {
          delta += Math.abs(
            resource.travel[i]!.duration - candidateRoutes[i]!.duration,
          );
        }
        if (delta < bestDelta) {
          bestDelta = delta;
          bestPreset = candidate;
        }
      }
      return bestPreset;
    }
    for (const route of resource.travel) {
      if (route.from === "prep" && route.to === "hob") {
        const sec = Math.round(route.duration / 1_000_000);
        if (sec <= 3) return "brisk";
        if (sec >= 6) return "congested-aisle";
        return "standard";
      }
    }
  }
  return "standard";
}

export function sameTravelDurations(
  a: readonly TravelRoute[],
  b: readonly TravelRoute[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.from !== right.from ||
      left.to !== right.to ||
      left.duration !== right.duration
    ) {
      return false;
    }
  }
  return true;
}
