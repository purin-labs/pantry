import type { ApplianceId, AppliancePose } from "@seams/production-simulation/floor/appliance-catalogue";
import type { ResolvedApplianceMove } from "@seams/production-simulation/floor/collisions";
import type { FloorPlanOpening } from "@seams/production-simulation/floor/openings";
import type { SceneGesture } from "./scene";

/** Compile-only checks for invalid identities and mixed domain branches. */
export function floorPlanTypeChecks(
  pose: AppliancePose,
  door: Extract<FloorPlanOpening, { kind: "door" }>,
  window: Extract<FloorPlanOpening, { kind: "window" }>,
  move: Extract<SceneGesture, { kind: "move" }>,
  raw: string,
): void {
  // @ts-expect-error Raw UI identities must pass the catalogue guard.
  const identity: ApplianceId = raw;
  // @ts-expect-error Failure cannot carry success-only collision diagnostics.
  const blocked: ResolvedApplianceMove = {
    kind: "blocked",
    pose,
    reason: "no-clearance",
    contactedBoundary: true,
  };
  // @ts-expect-error A broad spread must not combine door and window branches.
  const opening: FloorPlanOpening = { ...door, window: window.window };
  // @ts-expect-error A completed gesture cannot retain drag fields through a spread.
  const idle: SceneGesture = { ...move, kind: "idle" };
  // @ts-expect-error A broad assertion does not establish a valid move result.
  const asserted: ResolvedApplianceMove = {} as {
    kind: string;
    pose: AppliancePose;
  };
  void [identity, blocked, opening, idle, asserted];
}
