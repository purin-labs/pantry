import { floorPlanWorkspace } from "./floor-plan-workspace";
import type {
  BakerySurfaceEquipment,
  BakerySurfaceOpening,
  BakerySurfaceShiftLayout,
} from "@seams/bakery-model/bakery-surface";
import { BAKERY_FLOOR_PLANS, type BakeryFloorPlanId } from "@seams/production-simulation/floor/bakery-room";
import {
  doorOpening,
  isDoorOpen,
  openingId,
  windowOpening,
} from "@seams/production-simulation/floor/openings";
import {
  APPLIANCE_FOOTPRINTS,
  REHEARSAL_APPLIANCE_IDS,
  type ApplianceId,
} from "@seams/production-simulation/floor/appliance-catalogue";
import { getStoreInteriorDesign } from "./store-interior-design";

// The appliances, openings, interior palette and undo history on the open floor
// plan, for the agent's context of the shift page.
export function shiftFloorPlanLayout(): BakerySurfaceShiftLayout {
  const floorPlan = floorPlanWorkspace.getActivePlan();
  const history = floorPlanWorkspace.getHistorySnapshot();
  return {
    floorPlan,
    equipment: REHEARSAL_APPLIANCE_IDS.flatMap(
      shiftEquipment.bind(null, floorPlan),
    ),
    openings: shiftOpenings(floorPlan),
    interior: getStoreInteriorDesign(),
    history: {
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      hasCustomLayout: history.hasCustomLayout,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    },
  };
}

function shiftEquipment(
  floorPlan: BakeryFloorPlanId,
  id: ApplianceId,
): BakerySurfaceEquipment[] {
  const footprint = APPLIANCE_FOOTPRINTS[id];
  const pose = floorPlanWorkspace.getPose(floorPlan, id);
  return [
    {
      id,
      label: footprint.label,
      rotationDegrees: yawDegrees(pose.rotY),
      xMm: Math.round(pose.x * 1000),
      zMm: Math.round(pose.z * 1000),
    },
  ];
}

function shiftOpenings(floorPlan: BakeryFloorPlanId): BakerySurfaceOpening[] {
  const spec = BAKERY_FLOOR_PLANS[floorPlan];
  const openings: BakerySurfaceOpening[] = [];
  for (const door of spec.doors) {
    const opening = doorOpening(floorPlan, door);
    const progress = Number(floorPlanWorkspace.progress(opening).toFixed(3));
    openings.push({
      id: openingId(opening),
      label: door.label,
      kind: "door",
      open: isDoorOpen(progress),
      progress,
    });
  }
  for (const window of spec.windows) {
    const opening = windowOpening(floorPlan, window);
    const progress = Number(floorPlanWorkspace.progress(opening).toFixed(3));
    openings.push({
      id: openingId(opening),
      label: window.label,
      kind: "window",
      open: isDoorOpen(progress),
      progress,
    });
  }
  return openings;
}

function yawDegrees(radians: number): number {
  const degrees = Math.round((radians * 180) / Math.PI);
  const normalized = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}
