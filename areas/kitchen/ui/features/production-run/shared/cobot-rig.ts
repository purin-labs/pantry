import * as THREE from "three";
import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import {
  fr10GripperKinematics,
  fr10Links,
  fr10ShoulderIk,
  type Fr10Link,
  type JointVector,
  type Pose7,
  type Vec3,
} from "@purin-labs/production-simulation/kinematics/fr10";
import { enableSceneShadows, lerpVec3 } from "../appliance-sample-three";

/** One revolute joint of the FR10 visual. */
export type Fr10Pivot = Readonly<{
  object: THREE.Object3D;
  axis: THREE.Vector3;
}>;

/** The FR10 arm of a scene on its base: an inverse solver and a forward chain. */
type Fr10Arm = Readonly<{
  solve(tool: Vec3, wristPitch?: number): JointVector;
  forward(
    joints: JointVector,
  ): Readonly<{ joints: JointVector; gripper: Pose7 }>;
}>;

/** The FR10 arm on a base; the shoulder solver and the gripper chain by default. */
export function fr10Arm(
  base: Vec3,
  solve: (base: Vec3) => Fr10Arm["solve"] = fr10ShoulderIk,
  forward: (
    links: readonly Fr10Link[],
  ) => Fr10Arm["forward"] = fr10GripperKinematics,
): Fr10Arm {
  return { forward: forward(fr10Links(base)), solve: solve(base) };
}

/** The cobot pose of a recipe sample. */
type CobotPose = Readonly<{
  toolZUp: Vec3;
  wristPitchRad: number;
  fingerOpeningM: number;
}>;

/** The cobot pose between two samples. */
export function lerpCobot<Cobot extends CobotPose>(
  a: Cobot,
  b: Cobot,
  u: number,
): Cobot {
  const lerp = THREE.MathUtils.lerp;
  return {
    ...b,
    toolZUp: lerpVec3(a.toolZUp, b.toolZUp, u),
    wristPitchRad: lerp(a.wristPitchRad, b.wristPitchRad, u),
    fingerOpeningM: lerp(a.fingerOpeningM, b.fingerOpeningM, u),
  };
}

/**
 * The joints of an FR10 visual in chain order. A joint that the visual lacks
 * throws, or is left out when `skipMissing`.
 */
export function fr10Pivots(
  visual: THREE.Object3D,
  skipMissing = false,
): Fr10Pivot[] {
  const pivots: Fr10Pivot[] = [];
  for (const joint of ROBOTS["fairino-fr10"].joints) {
    const object = visual.getObjectByName(joint.node);
    if (object === undefined) {
      if (skipMissing) {
        continue;
      }
      throw new Error("Robot visual has an incompatible joint hierarchy.");
    }
    pivots.push({ object, axis: new THREE.Vector3(...joint.axis) });
  }
  return pivots;
}

/** Mounts the Y-up FR10 visual in a Z-up robot root and returns its joints. */
export function mountFr10Visual(
  robot: THREE.Object3D,
  visual: THREE.Object3D,
): Fr10Pivot[] {
  const pivots = fr10Pivots(visual);
  enableSceneShadows(visual);
  visual.rotation.x = Math.PI / 2;
  robot.add(visual);
  return pivots;
}

/** Turns the arm toward the tool target and places the gripper mount. */
export function reachFr10(
  arm: Fr10Arm,
  pivots: readonly Fr10Pivot[],
  gripper: THREE.Object3D,
  tool: Vec3,
  wristPitch: number,
): void {
  const fk = arm.forward(arm.solve(tool, wristPitch));
  for (const [index, pivot] of pivots.entries()) {
    const angle = fk.joints[index];
    if (angle !== undefined) {
      pivot.object.quaternion.setFromAxisAngle(pivot.axis, angle);
    }
  }
  gripper.position.set(fk.gripper[0], fk.gripper[1], fk.gripper[2]);
  gripper.quaternion.set(
    fk.gripper[4],
    fk.gripper[5],
    fk.gripper[6],
    fk.gripper[3],
  );
}

/** Opens the parallel fingers: each sits 14 mm off the axis plus the opening. */
export function openFr10Fingers(
  leftFinger: THREE.Object3D,
  rightFinger: THREE.Object3D,
  openingM: number,
): void {
  leftFinger.position.set(0, 0.014 + openingM, 0);
  rightFinger.position.set(0, -0.014 - openingM, 0);
}

/** The plain parallel gripper of a dark FR10 workcell: a palm and two finger meshes. */
export function buildWorkcellGripper(
  gripper: THREE.Object3D,
  leftFinger: THREE.Mesh,
  rightFinger: THREE.Mesh,
): void {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2a2e33,
    metalness: 0.65,
    roughness: 0.32,
  });
  const palm = new THREE.Mesh(
    new THREE.BoxGeometry(0.048, 0.082, 0.036),
    bodyMat,
  );
  gripper.add(palm);

  const fingerGeom = new THREE.BoxGeometry(0.062, 0.01, 0.022);
  const fingerMat = new THREE.MeshStandardMaterial({
    color: 0x565d66,
    metalness: 0.75,
    roughness: 0.25,
  });
  leftFinger.geometry = fingerGeom;
  leftFinger.material = fingerMat;
  rightFinger.geometry = fingerGeom;
  rightFinger.material = fingerMat;
  gripper.add(leftFinger, rightFinger);
}

/**
 * The padded parallel gripper of the patisserie scenes: a palm, two finger
 * bars at `barX` and two teal pads `padY` inside them.
 */
export function buildPaddedGripper(
  gripper: THREE.Object3D,
  leftFinger: THREE.Object3D,
  rightFinger: THREE.Object3D,
  fingers: Readonly<{ barX: number; padY: number }>,
): void {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1e242b,
    roughness: 0.36,
    metalness: 0.55,
  });
  const padMat = new THREE.MeshStandardMaterial({
    color: 0x1a5661,
    roughness: 0.45,
    metalness: 0.15,
  });

  const palm = new THREE.Mesh(
    new THREE.BoxGeometry(0.065, 0.088, 0.044),
    bodyMat,
  );
  palm.position.set(0.025, 0, 0);
  gripper.add(palm);

  const fingerGeo = new THREE.BoxGeometry(0.072, 0.012, 0.026);
  const padGeo = new THREE.BoxGeometry(0.048, 0.006, 0.024);
  for (const [finger, side] of [
    [leftFinger, -1],
    [rightFinger, 1],
  ] as const) {
    const bar = new THREE.Mesh(fingerGeo, bodyMat);
    bar.position.set(fingers.barX, 0, 0);
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(0.082, side * fingers.padY, 0);
    finger.add(bar, pad);
  }
}
