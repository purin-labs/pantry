import { floorPlanWorkspace } from "../floor-plan-workspace";
import * as THREE from "three";
import { bakeryRoom, type BakeryFloorPlanId } from "@seams/production-simulation/floor/bakery-room";

import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { StationId } from "@seams/bakery-model/bakery";
import { sceneLabel } from "../scene-labels";
import { loadBakeryStation } from "../bakery-assets";
import { disposePhysicsObject } from "./physics-model";
import { stations } from "@seams/production-simulation/recipes/bakery/schedule";
import { bindOvenVisual, updateOvenVisual } from "../oven-visual";
import type { WorkcellSelection } from "@seams/production-simulation/simulator/selection";
import { planFootprint, type FloorPlanItem } from "./floor-plan-geometry";
import { createFloorPlanShell, type FloorPlanShell } from "./floor-plan-shell";
import { enableShadowMeshes } from "./scene-lighting";
import {
  getStoreInteriorDesign,
  subscribeStoreInteriorDesign,
} from "../store-interior-design";
import {
  APPLIANCE_FOOTPRINTS,
  STORE_DECOR_IDS,
} from "@seams/production-simulation/floor/appliance-catalogue";
import { getApplianceBox } from "@seams/production-simulation/floor/collisions";

// The bakery around the robot cell: assumed stations for orientation. Robot
// work comes from native recordings; production timing is in the production
// workspace.
export class RehearsalBakery {
  readonly root = new THREE.Group();
  readonly labels = new Map<StationId, CSS2DObject>();
  private readonly objects = new Map<StationId, THREE.Group>();
  private readonly referenceFloor: THREE.Mesh;
  private readonly referenceWall: THREE.Mesh;
  private customShell: FloorPlanShell | null = null;
  private readonly unsubscribeFloorPlan: () => void;
  private readonly unsubscribePlacements: () => void;
  private readonly unsubscribeInterior: () => void;
  private readonly unsubscribeOpenings: () => void;
  private disposed = false;

  constructor(private readonly onChange?: () => void) {
    this.referenceFloor = new THREE.Mesh(
      new THREE.BoxGeometry(bakeryRoom.width, 0.1, bakeryRoom.depth),
      new THREE.MeshStandardMaterial({ color: "#d4dac9", roughness: 0.7 }),
    );
    this.referenceFloor.position.y = -0.06;
    this.referenceFloor.receiveShadow = true;
    this.referenceWall = new THREE.Mesh(
      new THREE.BoxGeometry(
        bakeryRoom.width,
        bakeryRoom.rearWallHeight,
        bakeryRoom.rearWallThickness,
      ),
      new THREE.MeshStandardMaterial({ color: "#f1ecdc", roughness: 0.7 }),
    );
    this.referenceWall.position.set(
      0,
      bakeryRoom.rearWallHeight / 2,
      -bakeryRoom.depth / 2,
    );
    this.referenceWall.castShadow = true;
    this.referenceWall.receiveShadow = true;
    this.root.add(this.referenceFloor, this.referenceWall);
    for (const station of stations) {
      const label = sceneLabel(`${station.label}\nBakery context`);
      label.position.set(station.position[0], 2.1, station.position[2]);
      this.labels.set(station.id, label);
      this.root.add(label);
    }
    this.applyFloorPlan(floorPlanWorkspace.getActivePlan());
    this.unsubscribeFloorPlan = floorPlanWorkspace.subscribePlan((id) => {
      this.applyFloorPlan(id);
      this.onChange?.();
    });
    this.unsubscribePlacements = floorPlanWorkspace.subscribePlacements(() => {
      this.syncStationPlacements(floorPlanWorkspace.getActivePlan());
      this.onChange?.();
    });
    this.unsubscribeInterior = subscribeStoreInteriorDesign(() => {
      this.applyFloorPlan(floorPlanWorkspace.getActivePlan());
      this.onChange?.();
    });
    this.unsubscribeOpenings = floorPlanWorkspace.subscribeOpenings(
      (planId) => {
        if (planId !== this.customShell?.planId) return;
        this.customShell?.syncOpenings();
        this.onChange?.();
      },
    );
  }

  private applyFloorPlan(id: BakeryFloorPlanId): void {
    if (this.customShell !== null) {
      this.customShell.dispose();
      this.customShell = null;
    }
    if (id === "reference") {
      this.referenceFloor.visible = true;
      this.referenceWall.visible = true;
    } else {
      this.referenceFloor.visible = false;
      this.referenceWall.visible = false;
      this.customShell = createFloorPlanShell(id, "bake", floorPlanWorkspace);
      this.root.add(this.customShell.root);
    }
    this.syncStationPlacements(id);
  }

  private syncStationPlacements(planId: BakeryFloorPlanId): void {
    for (const station of stations) {
      const pose = floorPlanWorkspace.getPose(planId, station.id);
      const label = this.labels.get(station.id);
      if (label !== undefined) {
        label.position.set(pose.x, 2.1, pose.z);
      }
      const object = this.objects.get(station.id);
      if (object !== undefined) {
        object.position.set(pose.x, 0, pose.z);
        object.rotation.y = pose.rotY;
        object.updateMatrixWorld(true);
      }
    }
    this.customShell?.syncPlacements();
  }

  async load(): Promise<void> {
    await Promise.all(stations.map(this.loadStation.bind(this)));
    if (!this.disposed) {
      this.syncStationPlacements(floorPlanWorkspace.getActivePlan());
      this.onChange?.();
    }
  }

  private async loadStation(station: (typeof stations)[number]): Promise<void> {
    const root = await loadBakeryStation(station);
    if (this.disposed) {
      root.traverse(disposePhysicsObject);
      return;
    }
    enableShadowMeshes(root);
    const pose = floorPlanWorkspace.getPose(
      floorPlanWorkspace.getActivePlan(),
      station.id,
    );
    root.position.set(pose.x, 0, pose.z);
    root.rotation.y = pose.rotY;
    root.updateMatrixWorld(true);
    this.root.add(root);
    this.objects.set(station.id, root);
    if (station.id === "bake")
      updateOvenVisual(bindOvenVisual(root), "idle", 0);
  }

  /** Assumed stations, drawn in the plan exactly where the 3D view places them. */
  floorPlanItems(): readonly FloorPlanItem<WorkcellSelection>[] {
    const items: FloorPlanItem<WorkcellSelection>[] = [];
    for (const station of stations) {
      const object = this.objects.get(station.id);
      if (object === undefined) continue;
      items.push({
        id: `context:${station.id}`,
        label: station.label,
        bounds: new THREE.Box3().setFromObject(object),
        footprint: planFootprint([object]),
        selection: null,
        context: true,
        geometry: { kind: "visual-only" },
      });
    }
    const planId = floorPlanWorkspace.getActivePlan();
    if (planId !== "reference" && getStoreInteriorDesign().showFurnishings) {
      for (const decorId of STORE_DECOR_IDS) {
        const pose = floorPlanWorkspace.getPose(planId, decorId);
        const fp = APPLIANCE_FOOTPRINTS[decorId];
        const box = getApplianceBox(decorId, pose.x, pose.z, pose.rotY);
        items.push({
          id: `context:${decorId}`,
          label: fp.label,
          bounds: new THREE.Box3(
            new THREE.Vector3(box.x0, 0, box.z0),
            new THREE.Vector3(box.x1, 0.95, box.z1),
          ),
          footprint: [
            [
              [box.x0, box.z0],
              [box.x1, box.z0],
              [box.x1, box.z1],
              [box.x0, box.z1],
            ],
          ],
          selection: null,
          context: true,
          geometry: { kind: "visual-only" },
        });
      }
    }
    return items;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeFloorPlan();
    this.unsubscribePlacements();
    this.unsubscribeInterior();
    this.unsubscribeOpenings();
    for (const label of this.labels.values()) label.element.remove();
    this.customShell?.dispose();
    this.customShell = null;
    this.root.traverse(disposePhysicsObject);
  }
}
