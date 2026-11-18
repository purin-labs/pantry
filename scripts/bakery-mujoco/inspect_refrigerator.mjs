import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as THREE from "../../apps/portal/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../../apps/portal/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

// Node.js headless shim so GLTFLoader can parse GLBs containing embedded PNG textures.
globalThis.self ??= globalThis;
THREE.ImageLoader.prototype.load = function loadHeadlessImage(_url, onLoad) {
  const image = { width: 1, height: 1, data: new Uint8Array(4) };
  queueMicrotask(() => onLoad?.(image));
  return image;
};

const directory = new URL(
  "../../assets/bakery-mujoco/hoshizaki-rt-120snj/",
  import.meta.url,
);

function dimensions(object) {
  return new THREE.Box3()
    .setFromObject(object, true)
    .getSize(new THREE.Vector3());
}

function frontRay(scene, x) {
  const ray = new THREE.Raycaster(
    new THREE.Vector3(x, 0.43, 1),
    new THREE.Vector3(0, 0, -1),
  );
  const hit = ray.intersectObject(scene, true)[0];
  assert.ok(hit, "The cabinet must intercept the access ray");
  return { object: hit.object.name, distance_m: hit.distance };
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.001, `${label}: ${actual}`);
}

async function main() {
  const bytes = await readFile(new URL("hoshizaki-rt-120snj.glb", directory));
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const { scene, animations, cameras } = await new GLTFLoader().parseAsync(
    buffer,
    "",
  );
  const cabinet = scene.getObjectByName("rt_cabinet");
  assert.ok(cabinet);
  assert.equal(cameras.length, 0);
  assert.equal(scene.getObjectsByProperty("isLight", true).length, 0);
  scene.updateMatrixWorld(true);
  const closedSize = dimensions(cabinet);
  near(closedSize.x, 1.2, "Cabinet width");
  near(closedSize.y, 0.8, "Cabinet height");
  near(closedSize.z, 0.626, "Depth including handles");

  const doors = [
    scene.getObjectByName("rt_door_left"),
    scene.getObjectByName("rt_door_right"),
  ];
  for (const door of doors) assert.equal(door.parent, cabinet);
  const cabinetTransform = cabinet.matrixWorld.clone();
  const closedHits = [frontRay(scene, -0.079), frontRay(scene, 0.341)];
  assert.match(closedHits[0].object, /left_stainless_door/);
  assert.match(closedHits[1].object, /right_stainless_door/);

  assert.equal(animations.length, 2);
  const mixer = new THREE.AnimationMixer(scene);
  for (const clip of animations) mixer.clipAction(clip).play();
  mixer.setTime(69 / 24);
  scene.updateMatrixWorld(true);
  for (const door of doors) {
    near(
      door.quaternion.angleTo(new THREE.Quaternion()),
      THREE.MathUtils.degToRad(100),
      "Open angle",
    );
  }
  assert.deepEqual(cabinet.matrixWorld.elements, cabinetTransform.elements);
  const openHits = [frontRay(scene, -0.079), frontRay(scene, 0.341)];
  for (const hit of openHits) {
    assert.match(hit.object, /Rear_insulated_wall/);
    near(hit.distance_m, 1.243, "Open access reaches rear interior wall");
  }

  const shelves = cabinet.children.filter(isShelf);
  assert.equal(shelves.length, 4);
  for (const shelf of shelves) {
    const size = dimensions(shelf);
    near(size.x, 0.4, "Shelf width");
    near(size.z, 0.425, "Shelf depth");
  }
  const shelf = shelves[0];
  const storedPosition = shelf.position.clone();
  shelf.position.z += 0.6;
  scene.updateMatrixWorld(true);
  near(shelf.position.distanceTo(storedPosition), 0.6, "Shelf removal travel");
  assert.deepEqual(cabinet.matrixWorld.elements, cabinetTransform.elements);
  shelf.position.copy(storedPosition);

  mixer.setTime(0);
  scene.updateMatrixWorld(true);
  assert.deepEqual(
    [frontRay(scene, -0.079), frontRay(scene, 0.341)],
    closedHits,
  );
  const meshes = scene.getObjectsByProperty("isMesh", true);
  let triangles = 0;
  for (const mesh of meshes) {
    assert.ok(mesh.geometry.getAttribute("normal"));
    triangles +=
      (mesh.geometry.index?.count ??
        mesh.geometry.getAttribute("position").count) / 3;
  }
  const report = {
    status: "passed",
    asset_sha256: createHash("sha256").update(bytes).digest("hex"),
    file_bytes: bytes.length,
    closed_dimensions_m: {
      width: closedSize.x,
      height: closedSize.y,
      depth: closedSize.z,
    },
    mesh_count: meshes.length,
    triangle_count: triangles,
    shelf_count: shelves.length,
    animation_duration_s: animations[0].duration,
    independent_door_clips: animations.length,
    closed_access: closedHits,
    open_access: openHits,
    journey:
      "Load GLB; inspect dimensions; open both doors; reach rear wall; remove and restore shelf; close both doors",
    scope:
      "Visual geometry and animation only; no physics or storage-clearance certification",
  };
  await writeFile(
    new URL("inspection-report.json", directory),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
}

function isShelf(object) {
  return object.name.startsWith("rt_shelf_");
}

await main();
