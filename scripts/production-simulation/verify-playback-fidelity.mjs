// Dense MuJoCo reference versus the Portal's actual recording reconstruction.
// Dense operation evidence remains the fallback until sparse contact recording
// is qualified. This campaign does not enable interpolated playback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wasmTransport } from "../../packages/production-simulation/src/native/wasm-transport.ts";
import { requireDenseOperationRecording } from "../../packages/production-simulation/src/native/cell-recording.ts";
import {
  parsePersistentCell,
  parsePersistentPhysicsMotion,
  parsePersistentPhysicsScene,
} from "../../packages/bakery-model/src/bakery-physics.ts";
import { ROBOTS } from "../../packages/bakery-model/src/bakery-robots.ts";
import {
  PhysicsModel,
  disposePhysicsObject,
  samplePhysics,
} from "../../areas/kitchen/ui/features/workflow-simulator/spatial/physics-model.ts";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import {
  OVEN_CELL,
  prepareCell,
  runtimeFiles,
  runtimeModule,
} from "./build-execution-bundle.mjs";

assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const output = resolve(process.argv[2]);
assert.equal(existsSync(output), false, "Preserve earlier evidence");
mkdirSync(output, { recursive: true });
const root = resolve(import.meta.dirname, "../..");
const runtime = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
const runtimeIdentity = runtimeFiles(runtime);
const portal = createRequire(join(root, "apps/portal/package.json"));
const THREE = await import(pathToFileURL(portal.resolve("three")).href);
const { GLTFLoader } = await import(
  pathToFileURL(portal.resolve("three/addons/loaders/GLTFLoader.js")).href
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = { encode, decode };
const artifacts = [];
const limits = { positionM: 0.001, angleRad: Math.PI / 1800, windowSteps: 50 };

function encode(text) {
  return encoder.encode(text);
}
function decode(bytes) {
  return decoder.decode(bytes);
}
function save(name, value) {
  const content = JSON.stringify(value);
  writeFileSync(join(output, name), content, { flag: "wx" });
  artifacts.push({
    file: name,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
function numeric(left, right) {
  return left - right;
}
async function send(host, command, kind) {
  const reply = await host.send(command);
  assert.equal(reply.kind, kind, JSON.stringify(reply));
  return reply;
}
async function open(definition) {
  const module = await runtimeModule(runtime);
  const host = wasmTransport(module, codec);
  const cell = definition.cellId;
  await send(
    host,
    { op: "open", cell, opening: { kind: "create", definition } },
    "opened",
  );
  await send(
    host,
    {
      op: "prepare",
      cell,
      boundary: "admit",
      change: { kind: "admission", carrier: "tray-a" },
    },
    "prepared",
  );
  await send(host, { op: "commit", cell, boundary: "admit" }, "committed");
  return host;
}

async function capture(definition, name, stride, pauses) {
  let host = await open(definition);
  const cell = definition.cellId;
  await send(
    host,
    { op: "start", cell, attemptId: "load", task: "table-to-oven" },
    "started",
  );
  const initial = await send(host, { op: "observe", cell }, "observed");
  const contacts = [{ step: 0, shapes: initial.observation.trayContacts }];
  const samples = [];
  const events = [];
  const boundaries = [];
  const durations = [];
  const contactEvidence = [];
  let recordingBytes = 0;
  let step = 0;
  let sequence = 0;
  let predecessor = null;
  let outcome = null;
  let pause = 0;
  let latestContacts = initial.observation.trayContacts;
  while (outcome === null) {
    assert.ok(
      step < 30_000,
      "The operation must finish within its 60-second limit",
    );
    const allowance = Math.min(stride, (pauses[pause] ?? Infinity) - step);
    assert.ok(allowance > 0);
    const started = performance.now();
    const reply = await send(
      host,
      { op: "advance", cell, steps: allowance },
      "advanced",
    );
    durations.push(performance.now() - started);
    const segment = reply.segment;
    assert.ok(segment !== null);
    requireDenseOperationRecording(segment);
    recordingBytes += Buffer.byteLength(JSON.stringify(segment));
    contactEvidence.push(...segment.contacts.observations);
    assert.equal(segment.sequence, sequence++);
    assert.equal(segment.startStep, step);
    if (predecessor !== null) assert.equal(segment.predecessor, predecessor);
    predecessor = segment.checkpoint;
    assert.equal(segment.samples[0].step, step);
    assert.equal(segment.samples.at(-1).step, segment.endStep);
    if (samples.length === 0) samples.push(segment.samples[0]);
    else assert.deepEqual(segment.samples[0], samples.at(-1));
    samples.push(...segment.samples.slice(1));
    events.push(...segment.events);
    step = segment.endStep;
    boundaries.push(step);
    outcome = reply.outcome;
    if (stride === 1) {
      const observed = await send(host, { op: "observe", cell }, "observed");
      assert.equal(observed.observation.steps, step);
      assert.deepEqual(observed.observation.tray, samples.at(-1).tray);
      const current = observed.observation.trayContacts;
      if (JSON.stringify(current) !== JSON.stringify(latestContacts)) {
        contacts.push({ step, shapes: current });
        latestContacts = current;
      }
    }
    if (step === pauses[pause]) {
      const exported = await send(host, { op: "export", cell }, "exported");
      const before = await send(host, { op: "observe", cell }, "observed");
      save(`${name}-restore-${pause}.json`, exported);
      await send(host, { op: "dispose", cell }, "disposed");
      host = wasmTransport(await runtimeModule(runtime), codec);
      const opened = await send(
        host,
        {
          op: "open",
          cell,
          opening: {
            kind: "restore",
            content: exported.content,
            digest: exported.checkpoint.digest,
            sequence: exported.sequence,
          },
        },
        "opened",
      );
      assert.deepEqual(opened.checkpoint, exported.checkpoint);
      assert.deepEqual(
        await send(host, { op: "observe", cell }, "observed"),
        before,
      );
      pause++;
    }
  }
  assert.equal(pause, pauses.length);
  const final = await send(host, { op: "export", cell }, "exported");
  await send(host, { op: "dispose", cell }, "disposed");
  durations.sort(numeric);
  const result = {
    samples,
    events,
    boundaries,
    contacts,
    contactEvidence,
    recordingBytes,
    outcome,
    final,
    pauses,
    advanceMs: {
      p95: durations[Math.ceil(durations.length * 0.95) - 1],
      max: durations.at(-1),
    },
  };
  save(`${name}.json`, result);
  return result;
}

function compareReference(reference, candidate) {
  for (const sample of candidate.samples)
    assert.deepEqual(
      sample,
      reference.samples[sample.step],
      `Exact step ${sample.step}`,
    );
  assert.deepEqual(candidate.events, reference.events);
  assert.deepEqual(candidate.contactEvidence, reference.contactEvidence);
  assert.deepEqual(candidate.outcome, reference.outcome);
  assert.equal(candidate.final.content, reference.final.content);
}

function criticalSteps(reference) {
  const causes = [];
  for (const event of reference.events)
    causes.push({
      step: event.step,
      kind: event.kind,
      label: event.label ?? event.kind,
    });
  for (const transition of reference.contacts.slice(1))
    causes.push({
      step: transition.step,
      kind: "carrier-contact-set",
      shapes: transition.shapes,
    });
  const steps = new Set();
  for (const event of causes)
    for (
      let step = Math.max(0, event.step - limits.windowSteps);
      step <= Math.min(reference.outcome.step, event.step + limits.windowSteps);
      step++
    )
      steps.add(step);
  return { causes, steps };
}

function choosePauses(reference) {
  const candidates = [reference.outcome.step - 10];
  if (reference.contacts.length > 1)
    candidates.push(reference.contacts[1].step + 1);
  for (const event of reference.events)
    if (event.kind === "pickup") candidates.push(event.step + 3);
  return [...new Set(candidates)].sort(numeric);
}

function metric() {
  return { positionM: 0, positionStep: 0, angleRad: 0, angleStep: 0 };
}
function recordError(target, actual, expected, step) {
  const position = Math.hypot(
    actual[0] - expected[0],
    actual[1] - expected[1],
    actual[2] - expected[2],
  );
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 3; index < 7; index++) {
    dot += actual[index] * expected[index];
    normA += actual[index] ** 2;
    normB += expected[index] ** 2;
  }
  const angle =
    2 * Math.acos(Math.min(1, Math.abs(dot) / Math.sqrt(normA * normB)));
  assert.ok(Number.isFinite(position) && Number.isFinite(angle));
  if (position > target.positionM) {
    target.positionM = position;
    target.positionStep = step;
  }
  if (angle > target.angleRad) {
    target.angleRad = angle;
    target.angleStep = step;
  }
}
function pose(object) {
  const position = object.getWorldPosition(new THREE.Vector3());
  const rotation = object.getWorldQuaternion(new THREE.Quaternion());
  return [
    position.x,
    position.y,
    position.z,
    rotation.w,
    rotation.x,
    rotation.y,
    rotation.z,
  ];
}

async function measure(definition, reference, candidate) {
  const robot = ROBOTS[definition.robot];
  const setup = JSON.parse(
    readFileSync(
      join(
        root,
        `assets/bakery-mujoco/fr10-workcell/native/${definition.robot}/combined-nominal.json`,
      ),
      "utf8",
    ),
  );
  const cell = parsePersistentCell(definition);
  assert.ok(cell !== null);
  const scene = parsePersistentPhysicsScene(cell, setup, robot.glbSha256);
  const denseMotion = parsePersistentPhysicsMotion(scene, reference.samples);
  const sparseMotion = parsePersistentPhysicsMotion(scene, candidate.samples);
  const glb = readFileSync(
    join(root, `assets/bakery-robots/${definition.robot}/robot.glb`),
  );
  assert.equal(createHash("sha256").update(glb).digest("hex"), robot.glbSha256);
  const asset = await new GLTFLoader().parseAsync(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
    "",
  );
  const exactModel = new PhysicsModel(denseMotion);
  const reconstructedModel = new PhysicsModel(sparseMotion);
  exactModel.attachRobot(asset.scene.clone(true));
  reconstructedModel.attachRobot(asset.scene.clone(true));
  const objects = [];
  for (const joint of robot.joints) {
    const exact = exactModel.robot.getObjectByName(joint.node);
    const reconstructed = reconstructedModel.robot.getObjectByName(joint.node);
    assert.ok(exact && reconstructed);
    objects.push({ name: joint.node, exact, reconstructed });
  }
  const errors = { tool: metric(), jaw: metric(), tray: metric() };
  const outsideWindows = { tool: metric(), jaw: metric(), tray: metric() };
  const exactErrors = { tool: metric(), jaw: metric(), tray: metric() };
  const links = {};
  for (const object of objects) links[object.name] = metric();
  const critical = criticalSteps(reference);
  const present = new Set();
  for (const sample of candidate.samples) present.add(sample.step);
  let missingCritical = 0;
  let firstMissingCritical = null;
  let requiredWindowBytes = 0;
  for (const step of critical.steps) {
    requiredWindowBytes += Buffer.byteLength(
      JSON.stringify(reference.samples[step]),
    );
    if (!present.has(step)) {
      missingCritical++;
      firstMissingCritical ??= step;
    }
  }
  let windowsCrossingCommittedSegments = 0;
  for (const event of critical.causes) {
    const start = Math.max(0, event.step - limits.windowSteps);
    for (const boundary of candidate.boundaries) {
      if (boundary > start && boundary < event.step) {
        windowsCrossingCommittedSegments++;
        break;
      }
    }
  }
  for (const expected of reference.samples) {
    const seconds = expected.step * 0.002;
    const actual = samplePhysics(sparseMotion, seconds);
    exactModel.update(seconds);
    reconstructedModel.update(seconds);
    if (present.has(expected.step)) assert.deepEqual(actual, expected);
    for (const body of ["tool", "jaw", "tray"]) {
      recordError(errors[body], actual[body], expected[body], expected.step);
      if (!critical.steps.has(expected.step))
        recordError(
          outsideWindows[body],
          actual[body],
          expected[body],
          expected.step,
        );
      if (present.has(expected.step))
        recordError(
          exactErrors[body],
          pose(reconstructedModel[body]),
          pose(exactModel[body]),
          expected.step,
        );
    }
    for (const object of objects)
      recordError(
        links[object.name],
        pose(object.reconstructed),
        pose(object.exact),
        expected.step,
      );
  }
  let poseWithinLimits = true;
  for (const error of [...Object.values(errors), ...Object.values(links)])
    if (error.positionM > limits.positionM || error.angleRad > limits.angleRad)
      poseWithinLimits = false;
  for (const error of Object.values(exactErrors)) {
    assert.ok(error.positionM <= 1e-6);
    assert.ok(error.angleRad <= 1e-6);
  }
  exactModel.root.traverse(disposePhysicsObject);
  reconstructedModel.root.traverse(disposePhysicsObject);
  return {
    denseSamples: reference.samples.length,
    recordedSamples: candidate.samples.length,
    omittedSteps: reference.samples.length - candidate.samples.length,
    errors,
    outsideWindows,
    exactErrors,
    links,
    critical: {
      events: critical.causes,
      requiredSteps: critical.steps.size,
      requiredWindowBytes,
      windowsCrossingCommittedSegments,
      missingSteps: missingCritical,
      firstMissingStep: firstMissingCritical,
    },
    poseWithinLimits,
    observedWindowsComplete: missingCritical === 0,
    qualification: "dense-operation-evidence",
  };
}

const nominal = await prepareCell(runtime, "cold-cell-1", OVEN_CELL);
const weak = structuredClone(nominal);
weak.clampForceN = 20;
weak.ingredients.massKg = 2;
const cases = [];
for (const [name, definition, expectedOutcome] of [
  ["nominal", nominal, "completed"],
  ["weak-clamp", weak, "failed"],
]) {
  console.log(`Capturing every solver step: ${name}`);
  save(`${name}-definition.json`, definition);
  const dense = await capture(definition, `${name}-dense`, 1, []);
  assert.equal(dense.samples.length, dense.outcome.step + 1);
  assert.equal(dense.outcome.kind, expectedOutcome);
  if (expectedOutcome === "failed")
    assert.equal(dense.outcome.reason, "lost-grasp");
  const recorded = await capture(definition, `${name}-recorded`, 32, []);
  compareReference(dense, recorded);
  const pauses = choosePauses(dense);
  const restored = await capture(definition, `${name}-restored`, 32, pauses);
  compareReference(dense, restored);
  const measurements = await measure(definition, dense, recorded);
  const restoredMeasurements = await measure(definition, dense, restored);
  assert.equal(measurements.poseWithinLimits, true);
  assert.equal(measurements.observedWindowsComplete, true);
  assert.equal(measurements.omittedSteps, 0);
  assert.equal(restoredMeasurements.observedWindowsComplete, true);
  assert.equal(recorded.contactEvidence.length, recorded.outcome.step);
  let peakNormalForceN = 0;
  let maximumPenetrationM = 0;
  const pairIdentities = new Set();
  for (const observation of recorded.contactEvidence)
    for (const pair of observation.pairs) {
      peakNormalForceN = Math.max(peakNormalForceN, pair.normalForceN);
      maximumPenetrationM = Math.max(maximumPenetrationM, pair.penetrationM);
      pairIdentities.add(JSON.stringify([pair.first, pair.second]));
    }
  assert.ok(
    peakNormalForceN > 0,
    "The loaded carrier must exert contact force",
  );
  save(`${name}-measurements.json`, {
    measurements,
    restoredMeasurements,
  });
  cases.push({
    name,
    outcome: dense.outcome,
    pauses,
    exactRestore: true,
    measurements,
    restoredMeasurements,
    recordingBytes: recorded.recordingBytes,
    contacts: {
      observations: recorded.contactEvidence.length,
      pairs: pairIdentities.size,
      peakNormalForceN,
      maximumPenetrationM,
    },
    advanceMs: recorded.advanceMs,
  });
  console.log(
    `${name}: ${dense.samples.length} exact reference samples; ${measurements.critical.missingSteps} missing critical-window steps`,
  );
}
const sources = [];
for (const file of [
  "scripts/production-simulation/verify-playback-fidelity.mjs",
  "areas/kitchen/ui/features/workflow-simulator/spatial/physics-model.ts",
  "packages/bakery-model/src/bakery-physics.ts",
  "packages/bakery-model/src/bakery-robots.ts",
  "packages/production-simulation/src/recipes/bakery/physics-playback.ts",
  "packages/production-simulation/src/native/cell-recording.ts",
  "assets/bakery-mujoco/fr10-workcell/native/universal-robots-ur5e/combined-nominal.json",
]) {
  const content = readFileSync(join(root, file));
  sources.push({
    file,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
save("report.json", {
  result: "passed",
  qualification: "dense-operation-evidence",
  backend: "retained Wasm under Node",
  runtime: runtimeIdentity,
  limits,
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
  },
  scope:
    "Every operation pose and post-forward shape-pair force matches across bounded advances and fresh-module restores. Sparse contact qualification, idle contact windows, individual contact points, slip margins, and GPU rendering remain outside this campaign.",
  cases,
  sources,
  artifacts,
});
console.log(`Playback fidelity evidence: ${output}`);
