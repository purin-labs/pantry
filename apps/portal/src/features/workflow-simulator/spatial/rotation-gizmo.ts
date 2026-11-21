import * as THREE from "three";

/**
 * The yaw ring, the direction stem and the handle knob that rotate a selected
 * appliance in the Kitchen floor scenes.
 */
export type RotationGizmo3D = {
  readonly root: THREE.Group;
  readonly yawMat: THREE.MeshBasicMaterial;
  readonly knobMat: THREE.MeshBasicMaterial;
};

export function setRotationGizmoActive(
  gizmo: RotationGizmo3D,
  active: boolean,
): void {
  gizmo.yawMat.color.setHex(active ? 0x38bdf8 : 0x60a5fa);
  gizmo.yawMat.opacity = active ? 0.96 : 0.38;
  gizmo.knobMat.color.setHex(active ? 0xe0f2fe : 0xbae6fd);
  gizmo.knobMat.opacity = active ? 1.0 : 0.55;
}

export function buildRotationGizmo3D(): RotationGizmo3D {
  const root = new THREE.Group();
  root.visible = false;

  const yawMat = new THREE.MeshBasicMaterial({
    color: 0x60a5fa,
    transparent: true,
    opacity: 0.38,
    depthTest: false,
  });
  const knobMat = new THREE.MeshBasicMaterial({
    color: 0xbae6fd,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
  });
  const hitMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });

  // Circular light-blue yaw rotation ring
  const yawRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.022, 16, 72),
    yawMat,
  );
  yawRing.rotation.x = Math.PI / 2;
  yawRing.renderOrder = 12;
  yawRing.userData.isRotateGizmo = true;
  root.add(yawRing);

  // Forward direction stem + draggable handle knob on the light-blue yaw ring
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.42, 10).rotateX(Math.PI / 2),
    yawMat,
  );
  stem.position.set(0, 0, 0.79);
  stem.renderOrder = 12;
  stem.userData.isRotateGizmo = true;
  root.add(stem);

  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.068, 18, 18), knobMat);
  knob.position.set(0, 0, 1.0);
  knob.renderOrder = 13;
  knob.userData.isRotateGizmo = true;
  root.add(knob);

  const knobCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 16, 16),
    yawMat,
  );
  knobCore.position.set(0, 0, 1.0);
  knobCore.renderOrder = 14;
  knobCore.userData.isRotateGizmo = true;
  root.add(knobCore);

  // Invisible fat hit-torus for effortless mouse grabbing anywhere along the ring
  const hitRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.14, 12, 48),
    hitMat,
  );
  hitRing.rotation.x = Math.PI / 2;
  hitRing.userData.isRotateGizmo = true;
  root.add(hitRing);

  return { root, yawMat, knobMat };
}
