import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as THREE from "../../apps/portal/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../../apps/portal/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

const directory = new URL(
  "../../assets/bakery-mujoco/aicoh-ms-30/",
  import.meta.url,
);

async function load(name) {
  const bytes = await readFile(new URL(name, directory));
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return {
    gltf: await new GLTFLoader().parseAsync(buffer, ""),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function near(actual, expected, title) {
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${title}: ${actual}, expected ${expected}`,
  );
}

function bowlAccess(bowl) {
  const ray = new THREE.Raycaster(
    new THREE.Vector3(0, 0.92, 0.24),
    new THREE.Vector3(0, -1, 0),
  );
  const hit = ray.intersectObject(bowl, true)[0];
  assert.ok(hit);
  assert.equal(hit.object.name, "Hollow_stainless_bowl");
  assert.ok(hit.distance > 0.3, "The bowl must have a hollow cavity");
  return hit.distance;
}

async function main() {
  const mainAsset = await load("aicoh-ms-30.glb");
  const alternate = await load("aicoh-ms-30-beater.glb");
  const spareWhip = await load("aicoh-ms-30-whip.glb");
  const { scene, cameras, animations } = mainAsset.gltf;
  assert.equal(cameras.length, 0);
  assert.equal(animations.length, 0);
  assert.equal(scene.getObjectsByProperty("isLight", true).length, 0);
  const root = scene.getObjectByName("ms_mixer");
  const lift = scene.getObjectByName("ms_bowl_lift");
  const bowl = scene.getObjectByName("ms_bowl");
  const guard = scene.getObjectByName("ms_guard");
  const orbit = scene.getObjectByName("ms_planetary");
  const axis = scene.getObjectByName("ms_tool_axis");
  const whip = scene.getObjectByName("ms_whip");
  assert.equal(lift.parent, root);
  assert.equal(bowl.parent, lift);
  assert.equal(guard.parent, root);
  assert.equal(axis.parent, orbit);
  assert.equal(whip.parent, axis);
  scene.updateMatrixWorld(true);
  const dimensions = new THREE.Box3()
    .setFromObject(root, true)
    .getSize(new THREE.Vector3());
  near(dimensions.x, 0.545, "Width");
  near(dimensions.y, 1.445, "Height");
  near(dimensions.z, 0.79, "Depth");
  const initialAccess = bowlAccess(bowl);
  const rootTransform = root.matrixWorld.clone();
  const initialBowl = bowl.position.clone();
  guard.rotation.y = Math.PI;
  lift.position.y = -0.12;
  scene.updateMatrixWorld(true);
  const loweredAccess = bowlAccess(bowl);
  near(loweredAccess - initialAccess, 0.12, "Bowl lowering");
  const lowerBounds = new THREE.Box3().setFromObject(bowl, true);
  assert.ok(lowerBounds.min.y > 0.29, "Lowered bowl clears the base height");
  axis.remove(whip);
  bowl.position.z += 0.5;
  scene.updateMatrixWorld(true);
  assert.ok(
    new THREE.Box3().setFromObject(bowl, true).min.z > 0.46,
    "Removed bowl clears the machine front",
  );
  bowl.position.copy(initialBowl);
  const beater = alternate.gltf.scene.getObjectByName("ms_beater");
  assert.deepEqual(beater.position.toArray(), [0, 0, 0]);
  axis.add(beater);
  lift.position.y = 0;
  guard.rotation.y = 0;
  scene.updateMatrixWorld(true);
  const axisBefore = axis.getWorldPosition(new THREE.Vector3());
  const bowlBefore = bowl.getWorldPosition(new THREE.Vector3());
  orbit.rotation.y = Math.PI;
  axis.rotation.y = Math.PI / 3;
  scene.updateMatrixWorld(true);
  near(
    axis.getWorldPosition(new THREE.Vector3()).distanceTo(axisBefore),
    0.066,
    "Planetary orbit diameter",
  );
  near(
    bowl.getWorldPosition(new THREE.Vector3()).distanceTo(bowlBefore),
    0,
    "Bowl stays fixed during tool motion",
  );
  assert.deepEqual(root.matrixWorld.elements, rootTransform.elements);
  axis.remove(beater);
  axis.add(whip);
  orbit.rotation.y = 0;
  axis.rotation.y = 0;
  scene.updateMatrixWorld(true);
  near(bowlAccess(bowl), initialAccess, "Restored bowl access");
  assert.deepEqual(
    spareWhip.gltf.scene.getObjectByName("ms_whip").position.toArray(),
    [0, 0, 0],
  );
  const meshes = scene.getObjectsByProperty("isMesh", true);
  let triangles = 0;
  for (const mesh of meshes) {
    assert.ok(mesh.geometry.attributes.normal);
    assert.ok(mesh.material);
    triangles +=
      (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) /
      3;
  }
  const report = {
    status: "passed",
    main_sha256: mainAsset.sha256,
    beater_sha256: alternate.sha256,
    whip_sha256: spareWhip.sha256,
    main_bytes: mainAsset.bytes,
    mesh_count: meshes.length,
    triangle_count: triangles,
    measured_dimensions_m: {
      width: dimensions.x,
      depth: dimensions.z,
      height: dimensions.y,
    },
    bowl_access_ray_m: { seated: initialAccess, lowered: loweredAccess },
    lowered_bowl_min_height_m: lowerBounds.min.y,
    journey:
      "Load; verify envelope and cavity; open guard; lower bowl; detach tool; remove and reseat bowl; install alternate tool; articulate planetary; restore",
    scope:
      "Visual export inspection. No continuous collision, interlock, motor or calibrated tool-fit acceptance.",
  };
  await writeFile(
    new URL("inspection-report.json", directory),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}

await main();
