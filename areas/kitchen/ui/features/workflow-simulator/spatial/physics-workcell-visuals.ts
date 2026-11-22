import type { WorkcellVisualBundle } from "./physics-model";
import { loadVisual } from "./physics-asset-loader";
import { disposePhysicsObject } from "./physics-model";
import workcellVisualsUrl from "../../../../../../assets/bakery-mujoco/fr10-workcell/workcell-visuals.glb?url";
import ur5eToolingUrl from "../../../../../../assets/bakery-robots/universal-robots-ur5e/tooling/tooling.glb?url";

export type { WorkcellVisualBundle };

const WORKCELL_VISUALS_SHA256 =
  "2637609acad0c379a6570a9cadcee036f709a063966f4b36b3f96e67da3baac8";
const UR5E_TOOLING_SHA256 =
  "c30436636c72c3c8b9edec3b5b98e5f6b23161315352be5133bd2f8235bb48d4";

export async function loadWorkcellVisuals(
  options: Readonly<{ ur5eTooling: boolean }>,
  signal: AbortSignal,
): Promise<WorkcellVisualBundle> {
  const [fixtures, ur5eTooling] = await Promise.all([
    loadVisual(workcellVisualsUrl, WORKCELL_VISUALS_SHA256, signal),
    options.ur5eTooling
      ? loadVisual(ur5eToolingUrl, UR5E_TOOLING_SHA256, signal)
      : Promise.resolve(null),
  ]);
  return { fixtures, ur5eTooling };
}

export function disposeWorkcellVisualBundle(
  bundle: WorkcellVisualBundle,
): void {
  bundle.fixtures.traverse(disposePhysicsObject);
  bundle.ur5eTooling?.traverse(disposePhysicsObject);
}
