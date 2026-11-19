import * as THREE from "three";
import type { BakeryFloorPlanSpec } from "@purin-labs/production-simulation/floor/bakery-room";
import {
  doorOpening,
  windowOpening,
  openingId,
  doorAngle,
  windowSashGeometry,
  windowSashRotation,
  type FloorPlanOpening,
} from "@purin-labs/production-simulation/floor/openings";
import type { FloorPlanWorkspace } from "../floor-plan-workspace";
import { enableShadowMeshes } from "./scene-lighting";
import type { Variant } from "@purin-labs/type-utils";

type OpeningVisual =
  | Readonly<{
      kind: "door";
      opening: Variant<FloorPlanOpening, "door">;
      pivot: THREE.Group;
      panel?: never;
    }>
  | Readonly<{
      kind: "window";
      opening: Variant<FloorPlanOpening, "window">;
      pivot: THREE.Group;
      panel: number;
    }>;

const openingObjects = new WeakMap<THREE.Object3D, FloorPlanOpening>();

/** Guides and hidden objects do not obstruct the first visible physical surface. */
export function pickFloorPlanOpening(
  ray: THREE.Raycaster,
  roots: THREE.Object3D[],
): FloorPlanOpening | null {
  for (const hit of ray.intersectObjects(roots, true)) {
    if (!(hit.object instanceof THREE.Mesh)) continue;
    let visible = true;
    let opening: FloorPlanOpening | null = null;
    let current: THREE.Object3D | null = hit.object;
    while (current !== null) {
      if (!current.visible) visible = false;
      opening = openingObjects.get(current) ?? opening;
      current = current.parent;
    }
    if (visible) return opening;
  }
  return null;
}

export function updateOpeningVisuals(
  bindings: readonly OpeningVisual[],
  workspace: FloorPlanWorkspace,
): void {
  for (const visual of bindings) {
    const progress = workspace.progress(visual.opening);
    switch (visual.kind) {
      case "door":
        visual.pivot.rotation.y = -doorAngle(visual.opening.door, progress);
        break;
      case "window":
        visual.pivot.rotation.y = windowSashRotation(visual.panel, progress);
        break;
    }
  }
}

export function buildFloorPlanOpenings(
  spec: BakeryFloorPlanSpec,
  frameMat: THREE.Material,
  glassMat: THREE.Material,
  brassMat: THREE.Material,
  doorLeafColor: number,
) {
  const root = new THREE.Group();
  const bindings: OpeningVisual[] = [];
  for (const win of spec.windows) {
    const dx = win.x1 - win.x0;
    const dz = win.z1 - win.z0;
    const span = Math.hypot(dx, dz);
    if (span < 1e-3) continue;
    const head = win.headHeight;
    const sill = win.sillHeight;
    const gh = Math.max(0.28, head - sill);
    const opening = windowOpening(spec.id, win);
    const openingKey = openingId(opening);
    const group = new THREE.Group();
    group.name = openingKey;
    openingObjects.set(group, opening);
    group.position.set(
      (win.x0 + win.x1) * 0.5,
      sill + gh * 0.5,
      (win.z0 + win.z1) * 0.5,
    );
    group.rotation.y = -Math.atan2(dz, dx);

    const hasTransom = gh > 0.95;
    const transomY = hasTransom ? gh * 0.24 : gh * 0.5;
    const lowerTopY = hasTransom ? transomY - 0.012 : gh * 0.5 - 0.016;
    const lowerBotY = -gh * 0.5 + 0.016;
    const sashH = Math.max(0.18, lowerTopY - lowerBotY);
    const sashCenterY = (lowerTopY + lowerBotY) * 0.5;

    // Top & bottom outer frame rails
    for (const yOff of [-gh * 0.5, gh * 0.5]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(span + 0.03, 0.032, 0.056),
        frameMat,
      );
      rail.position.y = yOff;
      group.add(rail);
    }

    // Outer left & right jamb posts
    for (const xOff of [-span * 0.5, span * 0.5]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.032, gh + 0.032, 0.056),
        frameMat,
      );
      post.position.x = xOff;
      group.add(post);
    }

    // Fixed upper transom bar & transom glass when tall
    if (hasTransom) {
      const transom = new THREE.Mesh(
        new THREE.BoxGeometry(span + 0.02, 0.024, 0.05),
        frameMat,
      );
      transom.position.y = transomY;
      const transomGlassH = Math.max(0.12, gh * 0.5 - transomY - 0.02);
      const transomPane = new THREE.Mesh(
        new THREE.BoxGeometry(span - 0.02, transomGlassH, 0.016),
        glassMat,
      );
      transomPane.position.y = transomY + 0.012 + transomGlassH * 0.5;
      group.add(transom, transomPane);
    }

    // Operable French casement window sashes for each bay
    const panels = win.panels;
    for (let i = 0; i < panels; i += 1) {
      const geometry = windowSashGeometry(win, i);
      const hingeLeft = i % 2 === 0;
      const sashW = geometry.width;
      const localCenterX = hingeLeft ? sashW * 0.5 : -sashW * 0.5;
      const sashPivot = new THREE.Group();
      sashPivot.name = `window-sash-pivot:${win.id}:${i}`;
      sashPivot.position.set(geometry.hingeOffset - span * 0.5, sashCenterY, 0);
      bindings.push({ kind: "window", opening, panel: i, pivot: sashPivot });

      // Sash glass pane
      const sashPane = new THREE.Mesh(
        new THREE.BoxGeometry(sashW - 0.036, sashH - 0.036, 0.016),
        glassMat,
      );
      sashPane.position.x = localCenterX;
      sashPivot.add(sashPane);

      // Sash perimeter frame rails & stiles
      for (const sy of [-sashH * 0.5 + 0.012, sashH * 0.5 - 0.012]) {
        const sRail = new THREE.Mesh(
          new THREE.BoxGeometry(sashW, 0.024, 0.036),
          frameMat,
        );
        sRail.position.set(localCenterX, sy, 0);
        sashPivot.add(sRail);
      }
      for (const sx of [
        localCenterX - sashW * 0.5 + 0.012,
        localCenterX + sashW * 0.5 - 0.012,
      ]) {
        const sStile = new THREE.Mesh(
          new THREE.BoxGeometry(0.024, sashH, 0.036),
          frameMat,
        );
        sStile.position.set(sx, 0, 0);
        sashPivot.add(sStile);
      }

      // Brass casement latch handle on the meeting stile
      const handleX = hingeLeft
        ? localCenterX + sashW * 0.5 - 0.028
        : localCenterX - sashW * 0.5 + 0.028;
      const latch = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.09, 0.048),
        brassMat,
      );
      latch.position.set(handleX, 0, 0);
      sashPivot.add(latch);

      group.add(sashPivot);
    }

    root.add(group);
  }

  // 6. Framed glass storefront & interior doors (clear glass vision panel + hinged leaf)
  const doorMat = new THREE.MeshStandardMaterial({
    color: doorLeafColor,
    roughness: 0.5,
    metalness: 0.12,
  });
  const arcMat = new THREE.LineBasicMaterial({ color: 0x6b766c });

  for (const door of spec.doors) {
    const dx = door.leafX - door.hingeX;
    const dz = door.leafZ - door.hingeZ;
    const len = door.width;
    const dh = door.height;
    const openAngle = Math.atan2(dz, dx);
    const closedAngle = doorAngle(door, 0);

    const opening = doorOpening(spec.id, door);
    const openingKey = openingId(opening);

    const doorContainer = new THREE.Group();
    doorContainer.name = openingKey;
    openingObjects.set(doorContainer, opening);

    // Fixed doorway jamb posts & header bar in the wall opening
    const frameGroup = new THREE.Group();
    frameGroup.position.set(
      door.hingeX + Math.cos(closedAngle) * len * 0.5,
      dh * 0.5,
      door.hingeZ + Math.sin(closedAngle) * len * 0.5,
    );
    frameGroup.rotation.y = -closedAngle;
    for (const xSign of [-1, 1]) {
      const jamb = new THREE.Mesh(
        new THREE.BoxGeometry(0.028, dh + 0.02, 0.072),
        frameMat,
      );
      jamb.position.x = xSign * (len * 0.5);
      frameGroup.add(jamb);
    }
    const header = new THREE.Mesh(
      new THREE.BoxGeometry(len + 0.04, 0.032, 0.074),
      frameMat,
    );
    header.position.y = dh * 0.5;
    const threshold = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.008, 0.06),
      brassMat,
    );
    threshold.position.y = -dh * 0.5 + 0.004;
    frameGroup.add(header, threshold);
    doorContainer.add(frameGroup);

    // Pivoting door leaf hinged at (door.hingeX, dh * 0.5, door.hingeZ)
    const doorPivot = new THREE.Group();
    doorPivot.name = `door-leaf-pivot:${door.id}`;
    bindings.push({ kind: "door", opening, pivot: doorPivot });
    doorPivot.position.set(door.hingeX, dh * 0.5, door.hingeZ);

    const leafGroup = new THREE.Group();
    leafGroup.position.x = len * 0.5;

    const isToiletDoor = door.id.includes("toilet");
    if (isToiletDoor) {
      const leaf = new THREE.Mesh(
        new THREE.BoxGeometry(len, dh, 0.042),
        doorMat,
      );
      leafGroup.add(leaf);
    } else {
      // Framed glass café entrance door: stiles, rails, bottom kickplate, and clear glass pane
      const stileW = 0.065;
      const topRailH = 0.065;
      const botRailH = 0.18;
      const glassW = Math.max(0.12, len - stileW * 2);
      const glassH = Math.max(0.2, dh - topRailH - botRailH);

      for (const xSign of [-1, 1]) {
        const stile = new THREE.Mesh(
          new THREE.BoxGeometry(stileW, dh, 0.044),
          frameMat,
        );
        stile.position.x = xSign * (len * 0.5 - stileW * 0.5);
        leafGroup.add(stile);
      }
      const topRail = new THREE.Mesh(
        new THREE.BoxGeometry(glassW, topRailH, 0.044),
        frameMat,
      );
      topRail.position.y = dh * 0.5 - topRailH * 0.5;
      const botRail = new THREE.Mesh(
        new THREE.BoxGeometry(glassW, botRailH, 0.044),
        brassMat,
      );
      botRail.position.y = -dh * 0.5 + botRailH * 0.5;
      const doorGlass = new THREE.Mesh(
        new THREE.BoxGeometry(glassW, glassH, 0.016),
        glassMat,
      );
      doorGlass.position.y = (botRailH - topRailH) * 0.5;
      leafGroup.add(topRail, botRail, doorGlass);
    }

    // Vertical brass pull handles on both faces
    for (const zSide of [-0.032, 0.032]) {
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.009, 0.009, 0.28, 12),
        brassMat,
      );
      handle.position.set(len * 0.34, 0, zSide);
      leafGroup.add(handle);
    }

    doorPivot.add(leafGroup);
    doorContainer.add(doorPivot);

    root.add(doorContainer);

    // Swing arc on floor
    const pts: THREE.Vector3[] = [
      new THREE.Vector3(door.hingeX, 0.012, door.hingeZ),
    ];
    const steps = 18;
    for (let s = 0; s <= steps; s += 1) {
      const a = openAngle + (door.swingRad * s) / steps;
      pts.push(
        new THREE.Vector3(
          door.hingeX + Math.cos(a) * len,
          0.012,
          door.hingeZ + Math.sin(a) * len,
        ),
      );
    }
    const arcGeo = new THREE.BufferGeometry().setFromPoints(pts);
    root.add(new THREE.Line(arcGeo, arcMat));
  }

  enableShadowMeshes(root);
  return { root, bindings };
}
