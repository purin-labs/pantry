// Compare exported GLB body frames with the compiled native model at rest.
// Read node transforms directly; textures and materials do not affect frames.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "../../apps/portal/node_modules/three/build/three.module.js";

function objectFromNode(node) {
  const object = new THREE.Object3D();
  object.name = node.name ?? "";
  if (node.matrix) {
    new THREE.Matrix4()
      .fromArray(node.matrix)
      .decompose(object.position, object.quaternion, object.scale);
  } else {
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
  }
  return object;
}

function loadFrames(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, "Expected a GLB file");
  assert.equal(bytes.readUInt32LE(4), 2, "Expected glTF version 2");
  const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
  const objects = document.nodes.map(objectFromNode);
  for (const [index, node] of document.nodes.entries()) {
    for (const child of node.children ?? []) objects[index].add(objects[child]);
  }
  const scene = new THREE.Group();
  for (const index of document.scenes[document.scene ?? 0].nodes) {
    scene.add(objects[index]);
  }
  scene.updateMatrixWorld(true);
  return scene;
}

function inspectAppliance(reference) {
  const bytes = readFileSync(reference.glb);
  const scene = loadFrames(bytes);
  const frames = [];
  for (const [name, pose] of Object.entries(reference.bodies)) {
    const object = scene.getObjectByName(name);
    if (object === undefined) continue;
    const position = new THREE.Vector3(pose[0], pose[2], -pose[1]);
    const rotation = new THREE.Quaternion(pose[4], pose[6], -pose[5], pose[3]);
    const positionError = object
      .getWorldPosition(new THREE.Vector3())
      .distanceTo(position);
    const rotationError = object
      .getWorldQuaternion(new THREE.Quaternion())
      .angleTo(rotation);
    frames.push({
      name,
      position_error_m: positionError,
      orientation_error_rad: rotationError,
      passed: positionError <= 0.000002 && rotationError <= 0.00001,
    });
  }
  return {
    passed: frames.length > 0 && frames.every(framePassed),
    glb_sha256: createHash("sha256").update(bytes).digest("hex"),
    native_sha256: reference.native_sha256,
    frames,
  };
}

function framePassed(frame) {
  return frame.passed;
}

function inspectMotion(reference) {
  const bytes = readFileSync(reference.glb);
  const scene = loadFrames(bytes);
  const motions = [];
  for (const motion of reference.motions) {
    const object = scene.getObjectByName(motion.body);
    if (object === undefined) {
      motions.push({
        body: motion.body,
        joint: motion.joint,
        passed: false,
        error: "missing-visual-body",
      });
      continue;
    }
    const originalPosition = object.position.clone();
    const originalRotation = object.quaternion.clone();
    // Blender's exporter converts local transforms as well as world poses.
    const [x, y, z] = motion.visual_axis;
    const axis = new THREE.Vector3(x, z, -y);
    let positionError = 0;
    let rotationError = 0;
    for (const sample of motion.samples) {
      object.position.copy(originalPosition);
      object.quaternion.copy(originalRotation);
      if (motion.kind === "hinge") object.rotateOnAxis(axis, sample.value);
      else if (motion.kind === "slide")
        object.position.addScaledVector(axis, sample.value);
      else throw new Error(`Unknown motion kind: ${motion.kind}`);
      scene.updateMatrixWorld(true);
      const p = sample.pose;
      const position = new THREE.Vector3(p[0], p[2], -p[1]);
      const rotation = new THREE.Quaternion(p[4], p[6], -p[5], p[3]);
      positionError = Math.max(
        positionError,
        object.getWorldPosition(new THREE.Vector3()).distanceTo(position),
      );
      rotationError = Math.max(
        rotationError,
        object.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation),
      );
    }
    object.position.copy(originalPosition);
    object.quaternion.copy(originalRotation);
    scene.updateMatrixWorld(true);
    motions.push({
      body: motion.body,
      joint: motion.joint,
      samples: motion.samples.length,
      range: [motion.samples[0].value, motion.samples.at(-1).value],
      position_error_m: positionError,
      orientation_error_rad: rotationError,
      passed: positionError <= 0.000002 && rotationError <= 0.00001,
    });
  }
  return {
    passed: motions.length > 0 && motions.every(framePassed),
    glb_sha256: createHash("sha256").update(bytes).digest("hex"),
    native_sha256: reference.native_sha256,
    motions,
  };
}

const referencePath = resolve(process.argv[2]);
const references = JSON.parse(readFileSync(referencePath));
const appliances = {};
const motionMode = process.argv[4] === "--motion";
for (const [name, reference] of Object.entries(references)) {
  appliances[name] = motionMode
    ? inspectMotion(reference)
    : inspectAppliance(reference);
}
const passed = Object.values(appliances).every(framePassed);
const report = {
  passed,
  scope: motionMode
    ? "Sampled scalar-joint frames against independent authored visual axes; no dynamics, coupled free bodies or surface fit qualification"
    : "Named GLB/native body frames at rest; no continuous surface or physical fit qualification",
  position_tolerance_m: 0.000002,
  orientation_tolerance_rad: 0.00001,
  appliances,
};
writeFileSync(resolve(process.argv[3]), `${JSON.stringify(report, null, 2)}\n`);
assert.ok(passed, "GLB/native frame alignment failed; inspect the report");
