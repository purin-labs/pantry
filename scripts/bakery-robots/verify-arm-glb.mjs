// Verify exported Three.js playback against the actual Rust/MuJoCo recording.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../apps/portal/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../../apps/portal/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

const directory = new URL(
  `../../assets/bakery-robots/${process.argv[2]}/`,
  import.meta.url,
);
const bytes = readFileSync(new URL("robot.glb", directory));
const gltf = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);
const metadata = JSON.parse(readFileSync(new URL("joints.json", directory)));
const reference = JSON.parse(
  readFileSync(new URL("acceptance/reference-poses.json", directory)),
);
const recording = JSON.parse(
  readFileSync(new URL("acceptance/loaded-trace.json", directory)),
);
const conversion = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const inverse = conversion.clone().invert();

function setAngles(angles) {
  for (const [index, joint] of metadata.joint_order.entries()) {
    gltf.scene
      .getObjectByName(joint.node)
      .quaternion.setFromAxisAngle(
        new THREE.Vector3(...joint.axis_gltf),
        angles[index],
      );
  }
  gltf.scene.updateMatrixWorld(true);
}

let maximum = 0;
for (const sample of reference) {
  setAngles(sample.angles);
  for (const [name, rows] of Object.entries(sample.links)) {
    const expected = conversion
      .clone()
      .multiply(new THREE.Matrix4().set(...rows.flat()))
      .multiply(inverse);
    const actual = gltf.scene.getObjectByName(name).matrixWorld;
    for (let index = 0; index < 16; index += 1) {
      const difference = Math.abs(
        expected.elements[index] - actual.elements[index],
      );
      maximum = Math.max(maximum, difference);
      assert.ok(difference < 2e-6, `Frame differs: ${name}`);
    }
  }
}
let playbackError = 0;
for (const sample of recording) {
  setAngles(sample.joints);
  const actual = gltf.scene
    .getObjectByName(`${process.argv[2]}__flange`)
    .getWorldPosition(new THREE.Vector3());
  const expected = new THREE.Vector3(...sample.flange_m).applyMatrix4(
    conversion,
  );
  playbackError = Math.max(playbackError, actual.distanceTo(expected));
  assert.ok(
    actual.distanceTo(expected) < 2e-6,
    "Playback differs from native physics",
  );
}
let triangles = 0;
for (const mesh of gltf.scene.getObjectsByProperty("isMesh", true)) {
  triangles += mesh.geometry.index.count / 3;
}
assert.equal(triangles, metadata.triangles);
assert.equal(gltf.animations.length, 1);
assert.equal(gltf.animations[0].tracks.length, 6);
const report = {
  passed: true,
  triangles,
  glb_bytes: bytes.length,
  reference_poses: reference.length,
  native_recording_samples: recording.length,
  maximum_matrix_error: maximum,
  maximum_native_playback_error_m: playbackError,
};
writeFileSync(
  new URL("acceptance/threejs-report.json", directory),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
