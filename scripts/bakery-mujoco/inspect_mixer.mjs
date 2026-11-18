import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as THREE from "../../apps/portal/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../../apps/portal/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

const directory = new URL(
  "../../assets/bakery-mujoco/hobart-hl200/",
  import.meta.url,
);

async function load(filename) {
  const bytes = await readFile(new URL(filename, directory));
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return { gltf: await new GLTFLoader().parseAsync(buffer, ""), bytes };
}

function near(actual, expected, name) {
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${name}: ${actual}, expected ${expected}`,
  );
}

function size(object) {
  return new THREE.Box3()
    .setFromObject(object, true)
    .getSize(new THREE.Vector3());
}

function bowlAccess(scene) {
  const ray = new THREE.Raycaster(
    new THREE.Vector3(0, 0.42, 0.234),
    new THREE.Vector3(0, -1, 0),
  );
  const hit = ray.intersectObject(scene, true)[0];
  assert.ok(hit);
  assert.equal(hit.object.name, "Hollow_stainless_bowl");
  assert.ok(hit.distance > 0.3, "The bowl must have an open cavity");
  return hit.distance;
}

async function main() {
  const mainAsset = await load("hobart-hl200.glb");
  const whipAsset = await load("hobart-hl200-whip.glb");
  const beaterAsset = await load("hobart-hl200-beater.glb");
  const { scene, cameras, animations } = mainAsset.gltf;
  assert.equal(cameras.length, 0);
  assert.equal(animations.length, 0);
  assert.equal(scene.getObjectsByProperty("isLight", true).length, 0);
  scene.updateMatrixWorld(true);
  const root = scene.getObjectByName("hl_mixer");
  const lift = scene.getObjectByName("hl_bowl_lift");
  const swing = scene.getObjectByName("hl_bowl_swing");
  const bowl = scene.getObjectByName("hl_bowl");
  const guard = scene.getObjectByName("hl_guard");
  const orbit = scene.getObjectByName("hl_planetary");
  const axis = scene.getObjectByName("hl_tool_axis");
  const beater = scene.getObjectByName("hl_beater");
  assert.equal(swing.parent, lift);
  assert.equal(bowl.parent, swing);
  assert.equal(guard.parent, root);
  assert.equal(axis.parent, orbit);
  assert.equal(beater.parent, axis);
  const dimensions = size(root);
  near(dimensions.x, 0.524, "Envelope width");
  near(dimensions.y, 0.737, "Envelope height");
  near(dimensions.z, 0.599, "Envelope depth");
  const rim = size(scene.getObjectByName("Rolled_bowl_rim"));
  near(rim.x, 0.321, "Bowl rim diameter");
  near(rim.z, 0.321, "Bowl rim depth");
  const closedAccess = bowlAccess(scene);
  const bodyTransform = root.matrixWorld.clone();

  guard.rotation.y = THREE.MathUtils.degToRad(-120);
  lift.position.y = -0.02;
  scene.updateMatrixWorld(true);
  const loweredAccess = bowlAccess(scene);
  near(loweredAccess - closedAccess, 0.02, "Bowl lowering");
  assert.deepEqual(root.matrixWorld.elements, bodyTransform.elements);
  const seatedPosition = bowl.getWorldPosition(new THREE.Vector3());
  axis.remove(beater);
  swing.rotation.y = THREE.MathUtils.degToRad(-95);
  scene.updateMatrixWorld(true);
  const swungPosition = bowl.getWorldPosition(new THREE.Vector3());
  assert.ok(
    swungPosition.distanceTo(seatedPosition) > 0.25,
    "The bowl must swing clear for access",
  );

  swing.rotation.y = 0;
  lift.position.y = 0;
  guard.rotation.y = 0;
  const whip = whipAsset.gltf.scene.getObjectByName("hl_whip");
  axis.add(whip);
  scene.updateMatrixWorld(true);
  const whipMount = whip.getWorldPosition(new THREE.Vector3());
  assert.ok(
    whipMount.distanceTo(axis.getWorldPosition(new THREE.Vector3())) < 1e-6,
  );
  const standaloneBeater = beaterAsset.gltf.scene.getObjectByName("hl_beater");
  assert.ok(
    standaloneBeater.position.length() < 1e-6,
    "Standalone tool origin must be its mount",
  );
  const stationaryBowl = bowl.getWorldPosition(new THREE.Vector3());
  orbit.rotation.y = 0.7;
  axis.rotation.y = -1.1;
  scene.updateMatrixWorld(true);
  const offset = whip
    .getWorldPosition(new THREE.Vector3())
    .sub(orbit.getWorldPosition(new THREE.Vector3()));
  near(Math.hypot(offset.x, offset.z), 0.03, "Planetary orbit offset");
  assert.ok(
    bowl.getWorldPosition(new THREE.Vector3()).distanceTo(stationaryBowl) <
      1e-6,
  );
  orbit.rotation.y = 0;
  axis.rotation.y = 0;
  axis.remove(whip);
  axis.add(beater);
  scene.updateMatrixWorld(true);
  near(bowlAccess(scene), closedAccess, "Restored assembly");

  const meshes = scene.getObjectsByProperty("isMesh", true);
  let triangles = 0;
  for (const mesh of meshes) {
    assert.ok(mesh.geometry.getAttribute("normal"));
    assert.ok(mesh.material.isMeshStandardMaterial);
    triangles +=
      (mesh.geometry.index?.count ??
        mesh.geometry.getAttribute("position").count) / 3;
  }
  const report = {
    status: "passed",
    main_sha256: createHash("sha256").update(mainAsset.bytes).digest("hex"),
    whip_sha256: createHash("sha256").update(whipAsset.bytes).digest("hex"),
    beater_sha256: createHash("sha256").update(beaterAsset.bytes).digest("hex"),
    main_bytes: mainAsset.bytes.length,
    mesh_count: meshes.length,
    triangle_count: triangles,
    measured_dimensions_m: {
      width: dimensions.x,
      depth: dimensions.z,
      height: dimensions.y,
    },
    bowl_access_ray_m: { seated: closedAccess, lowered: loweredAccess },
    bowl_swing_displacement_m: swungPosition.distanceTo(seatedPosition),
    journey:
      "Load; check dimensions and hollow bowl; open guard; lower bowl; remove beater; swing bowl; reseat; install whip; articulate planetary; restore",
    scope:
      "Visual hierarchy and geometry only; no motor speed, gear ratio, latch, interlock or collision certification",
  };
  await writeFile(
    new URL("inspection-report.json", directory),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
}

await main();
