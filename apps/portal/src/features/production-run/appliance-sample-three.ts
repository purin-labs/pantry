import * as THREE from "three";
import type {
  ApplianceFlexMesh,
  ApplianceSample,
} from "@seams/bakery-model/bakery-appliance-protocol";

type Pose7 = readonly [number, number, number, number, number, number, number];

/**
 * Applies a MuJoCo Z-up `[x, y, z, qw, qx, qy, qz]` world pose to a named
 * Three.js Y-up GLB node (`[x, z, -y]`, `[qx, qz, -qy, qw]`), accounting for
 * any parent transform in the loaded GLB hierarchy.
 */
export function applyRecordedAppliancePose(
  sample: ApplianceSample,
  object: THREE.Object3D,
): void {
  const p = sample.bodies.get(object.name);
  if (p === undefined) return;
  const world = new THREE.Matrix4().compose(
    new THREE.Vector3(p[0], p[2], -p[1]),
    new THREE.Quaternion(p[4], p[6], -p[5], p[3]),
    new THREE.Vector3(1, 1, 1),
  );
  if (object.parent !== null) {
    world.premultiply(object.parent.matrixWorld.clone().invert());
  }
  world.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld(true);
}

function interpolateFlexMeshes(
  first: readonly ApplianceFlexMesh[],
  next: readonly ApplianceFlexMesh[],
  alpha: number,
): readonly ApplianceFlexMesh[] {
  if (next.length === 0 || first.length === 0) return next;
  const lerp = THREE.MathUtils.lerp;
  return next.map((mesh2) => {
    const mesh1 = first.find(
      (candidate) =>
        candidate.name === mesh2.name &&
        candidate.vertexCount === mesh2.vertexCount &&
        candidate.vertices.length === mesh2.vertices.length,
    );
    if (mesh1 === undefined) return mesh2;
    const vertices = new Array<number>(mesh2.vertices.length);
    for (let i = 0; i < mesh2.vertices.length; i += 1) {
      vertices[i] = lerp(mesh1.vertices[i]!, mesh2.vertices[i]!, alpha);
    }
    return {
      ...mesh2,
      vertices,
    };
  });
}

/**
 * Smoothly interpolates rigid body poses and MuJoCo 4.0.0 deformable
 * `flexcomp` mesh vertices between two recorded appliance samples.
 */
export function interpolateApplianceSample(
  first: ApplianceSample,
  next: ApplianceSample,
  alpha: number,
): ApplianceSample {
  if (alpha <= 0) return first;
  if (alpha >= 1) return next;
  const lerp = THREE.MathUtils.lerp;
  const bodies = new Map<string, Pose7>();
  for (const [name, p2] of next.bodies.entries()) {
    const p1 = first.bodies.get(name);
    if (p1 === undefined) {
      bodies.set(name, p2);
      continue;
    }
    const q1 = new THREE.Quaternion(p1[4], p1[5], p1[6], p1[3]);
    const q2 = new THREE.Quaternion(p2[4], p2[5], p2[6], p2[3]);
    q1.slerp(q2, alpha);
    bodies.set(name, [
      lerp(p1[0], p2[0], alpha),
      lerp(p1[1], p2[1], alpha),
      lerp(p1[2], p2[2], alpha),
      q1.w,
      q1.x,
      q1.y,
      q1.z,
    ]);
  }
  return {
    ...next,
    timeSeconds: lerp(first.timeSeconds, next.timeSeconds, alpha),
    bodies,
    flexMeshes: interpolateFlexMeshes(first.flexMeshes, next.flexMeshes, alpha),
  };
}

export function enableSceneShadows(
  object: THREE.Object3D,
  cast = true,
  receive = true,
): void {
  object.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.castShadow = cast;
      node.receiveShadow = receive;
    }
  });
}
