import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { isRecord } from "@seams/std";
import { ROBOTS } from "@seams/bakery-model/bakery-robots";
import type { PersistentPourOverCell } from "@seams/bakery-model/bakery-physics";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { SceneHost } from "../scene-host";
import {
  enableSceneShadows as enableShadows,
  studioLights,
} from "../appliance-sample-three";
import { fr10Pivots } from "../shared/cobot-rig";
import type {
  PourOverSample,
  StationPose,
} from "@seams/production-simulation/recipes/pour-over/sample";

/** The station geometry the runtime packaged with this cell's model. */
export type PourOverSetup = Readonly<{
  robotBase: StationPose;
  geometry: readonly Readonly<{
    name: string;
    body: Body;
    shape: "box" | "cylinder" | "capsule";
    size: readonly [number, number, number];
    pose: StationPose;
    rgba: readonly [number, number, number, number];
  }>[];
  fingers: Readonly<
    Record<
      "left" | "right",
      Readonly<{ pose: StationPose; axis: readonly number[] }>
    >
  >;
}>;

/** Prepared pour-over station geometry so the 3D scene renders immediately in review state. */
export const INITIAL_POUR_OVER_SETUP: PourOverSetup = {
  robotBase: [0, 0, 0.75, 1, 0, 0, 0],
  geometry: [
    {
      name: "pedestal_column",
      body: "world",
      shape: "box",
      size: [0.1, 0.1, 0.35],
      pose: [0, 0, 0.35, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "pedestal_plate",
      body: "world",
      shape: "box",
      size: [0.18, 0.18, 0.025],
      pose: [0, 0, 0.725, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "po_bench_top",
      body: "world",
      shape: "box",
      size: [0.3, 0.42, 0.02],
      pose: [0.62, 0, 0.78, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "po_bench_leg_1",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.36, -0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "po_bench_leg_2",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.36, 0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "po_bench_leg_3",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.88, -0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
    {
      name: "po_bench_leg_4",
      body: "world",
      shape: "box",
      size: [0.025, 0.025, 0.38],
      pose: [0.88, 0.38, 0.38, 1, 0, 0, 0],
      rgba: [0.55, 0.62, 0.64, 1],
    },
  ],
  fingers: {
    left: {
      pose: [0, 0.014, 0, 1, 0, 0, 0],
      axis: [0, 1, 0],
    },
    right: {
      pose: [0, -0.014, 0, 1, 0, 0, 0],
      axis: [0, -1, 0],
    },
  },
};

const INITIAL_POUR_OVER_JOINTS: readonly number[] = [
  -0.6514565197170076, -1.6261626480081617, -2.57100207964568,
  -2.08603066525013, -2.2222528465334253, 1.5707844467423548,
];

/** Prepared station sample at `t = 0 s` before the run starts. */
export function initialPourOverSample(
  cell: PersistentPourOverCell,
): PourOverSample {
  return {
    step: 0,
    joints: INITIAL_POUR_OVER_JOINTS,
    fingers: [0.016, 0.016],
    gripper: [0.27, -0.325, 1.005, 1, 0, 0, 0],
    kettle: [0.62, -0.22, 0.83, 0.7071067811865476, 0, 0, 0.7071067811865476],
    dripper: [0.62, 0.17, 0.93, 1, 0, 0, 0],
    server: [0.62, 0.17, 0.83, 1, 0, 0, 0],
    scale: {
      loadKg: 0.704,
      readingG: null,
      tared: false,
      stable: true,
    },
    water: {
      kettleG: cell.station.kettleWaterG,
      kettleC: cell.station.kettleWaterC,
      airborneG: 0,
      absorbedG: 0,
      freeG: 0,
      bedC: 25,
      serverG: 0,
      serverC: 25,
      spillG: 0,
      evaporatedG: 0,
      pouredG: 0,
      offBedG: 0,
      wetRadiusM: 0,
      flowGS: 0,
    },
    stream: null,
    control: {
      phase: "prepared",
      stage: null,
      brewS: null,
      nextTargetG: 50,
      deviations: [],
    },
    outcome: null,
  };
}

export type PourOverCameraPreset = "bench" | "closeup" | "overhead";

const CAMERA_PRESETS: Readonly<
  Record<
    PourOverCameraPreset,
    Readonly<{
      position: readonly [number, number, number];
      target: readonly [number, number, number];
    }>
  >
> = {
  bench: {
    position: [2.12, 1.58, 1.05],
    target: [0.34, 1.08, 0.04],
  },
  closeup: {
    position: [1.14, 1.15, 0.28],
    target: [0.62, 0.94, -0.16],
  },
  overhead: {
    position: [0.62, 1.88, -0.02],
    target: [0.58, 0.96, -0.14],
  },
};

const BODIES = [
  "po_server",
  "po_dripper",
  "po_kettle",
  "po_gripper",
  "po_finger_left",
  "po_finger_right",
] as const;
type Body = (typeof BODIES)[number] | "world";
const KETTLE_RADIUS_M = 0.055;
const KETTLE_FLOOR_M = 0.006;
const SERVER_RADIUS_M = 0.0488;
const SERVER_FLOOR_M = 0.0045;
const BED_RADIUS_M = 0.0405;
const BED_SURFACE_M = 0.04;
const INTERPOLATION_MS = 55;

function invalid(): never {
  throw new Error("Invalid pour-over station scene.");
}
function finite(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : invalid();
}
function finiteList(raw: unknown, length: number): number[] {
  if (!Array.isArray(raw) || raw.length !== length) invalid();
  return raw.map(finite);
}
function vector3(raw: unknown): readonly [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) invalid();
  return [finite(raw[0]), finite(raw[1]), finite(raw[2])];
}
function rgba(raw: unknown): readonly [number, number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 4) invalid();
  return [finite(raw[0]), finite(raw[1]), finite(raw[2]), finite(raw[3])];
}
function poseOf(raw: unknown): StationPose {
  if (!Array.isArray(raw) || raw.length !== 7) invalid();
  return [
    finite(raw[0]),
    finite(raw[1]),
    finite(raw[2]),
    finite(raw[3]),
    finite(raw[4]),
    finite(raw[5]),
    finite(raw[6]),
  ];
}
function shapeOf(raw: unknown): "box" | "cylinder" | "capsule" {
  return raw === "box" || raw === "cylinder" || raw === "capsule"
    ? raw
    : invalid();
}
function bodyOf(raw: unknown): Body {
  if (raw === "world") return raw;
  for (const body of BODIES) if (body === raw) return body;
  return invalid();
}

/** The worker's scene reply for this exact pour-over cell and robot visual. */
export function readPourOverScene(
  cell: PersistentPourOverCell,
  raw: unknown,
): PourOverSetup {
  if (
    !isRecord(raw) ||
    raw.kind !== "scene" ||
    raw.version !== 1 ||
    raw.cell !== cell.cellId ||
    raw.modelHash !== cell.modelHash
  )
    throw new Error("This retained build does not provide the station scene.");
  if (raw.robotGlbSha256 !== ROBOTS["fairino-fr10"].glbSha256)
    throw new Error("This Portal cannot display the retained robot visual.");
  return parsePourOverSetup(raw.setup);
}

/** Parses the station setup the runtime packaged with its model, once. */
function parsePourOverSetup(raw: unknown): PourOverSetup {
  if (!isRecord(raw) || !Array.isArray(raw.geometry) || !isRecord(raw.frames))
    invalid();
  const frames = raw.frames;
  if (!isRecord(frames.fingers)) invalid();
  const finger = (side: "left" | "right") => {
    const value = isRecord(frames.fingers) ? frames.fingers[side] : null;
    if (!isRecord(value)) invalid();
    return { pose: poseOf(value.pose), axis: finiteList(value.axis, 3) };
  };
  const geometry = raw.geometry.map((item: unknown) => {
    if (!isRecord(item) || typeof item.name !== "string") invalid();
    return {
      name: item.name,
      body: bodyOf(item.body),
      shape: shapeOf(item.shape),
      size: vector3(item.size),
      pose: poseOf(item.pose),
      rgba: rgba(item.rgba),
    };
  });
  return {
    robotBase: poseOf(raw.robotBase),
    geometry,
    fingers: { left: finger("left"), right: finger("right") },
  };
}

function setPose(object: THREE.Object3D, pose: StationPose): void {
  object.position.set(pose[0], pose[1], pose[2]);
  object.quaternion.set(pose[4], pose[5], pose[6], pose[3]);
}

function interpolatePose(
  first: StationPose,
  next: StationPose,
  alpha: number,
): StationPose {
  const rotation = new THREE.Quaternion(first[4], first[5], first[6], first[3]);
  rotation.slerp(
    new THREE.Quaternion(next[4], next[5], next[6], next[3]),
    alpha,
  );
  return [
    THREE.MathUtils.lerp(first[0], next[0], alpha),
    THREE.MathUtils.lerp(first[1], next[1], alpha),
    THREE.MathUtils.lerp(first[2], next[2], alpha),
    rotation.w,
    rotation.x,
    rotation.y,
    rotation.z,
  ];
}

function interpolateSample(
  first: PourOverSample,
  next: PourOverSample,
  alpha: number,
): PourOverSample {
  if (alpha <= 0) return first;
  if (alpha >= 1) return next;
  const lerp = THREE.MathUtils.lerp;
  let stream: PourOverSample["stream"] = next.stream;
  if (first.stream !== null && next.stream !== null) {
    stream = {
      outlet: [
        lerp(first.stream.outlet[0], next.stream.outlet[0], alpha),
        lerp(first.stream.outlet[1], next.stream.outlet[1], alpha),
        lerp(first.stream.outlet[2], next.stream.outlet[2], alpha),
      ],
      velocity: [
        lerp(first.stream.velocity[0], next.stream.velocity[0], alpha),
        lerp(first.stream.velocity[1], next.stream.velocity[1], alpha),
        lerp(first.stream.velocity[2], next.stream.velocity[2], alpha),
      ],
      landing: [
        lerp(first.stream.landing[0], next.stream.landing[0], alpha),
        lerp(first.stream.landing[1], next.stream.landing[1], alpha),
        lerp(first.stream.landing[2], next.stream.landing[2], alpha),
      ],
      flightS: lerp(first.stream.flightS, next.stream.flightS, alpha),
    };
  }
  return {
    ...next,
    joints: next.joints.map((angle, index) =>
      lerp(first.joints[index] ?? angle, angle, alpha),
    ),
    fingers: [
      lerp(first.fingers[0], next.fingers[0], alpha),
      lerp(first.fingers[1], next.fingers[1], alpha),
    ],
    gripper: interpolatePose(first.gripper, next.gripper, alpha),
    kettle: interpolatePose(first.kettle, next.kettle, alpha),
    dripper: interpolatePose(first.dripper, next.dripper, alpha),
    server: interpolatePose(first.server, next.server, alpha),
    water: {
      ...next.water,
      kettleG: lerp(first.water.kettleG, next.water.kettleG, alpha),
      absorbedG: lerp(first.water.absorbedG, next.water.absorbedG, alpha),
      freeG: lerp(first.water.freeG, next.water.freeG, alpha),
      serverG: lerp(first.water.serverG, next.water.serverG, alpha),
      wetRadiusM: lerp(first.water.wetRadiusM, next.water.wetRadiusM, alpha),
      flowGS: lerp(first.water.flowGS, next.water.flowGS, alpha),
    },
    stream,
  };
}

/**
 * 30-pleat natural bamboo paper wave filter basket (`bb-kit-0.jpg`, `bb-kit-1.jpg`).
 * Conforms to the interior of the Blue Bottle Kuemon porcelain cone, rises ~3.5 mm
 * above its rim, and is open at the top so the coffee bed and bloom dome are visible.
 */
function createPleatedFilterGeometry(): THREE.BufferGeometry {
  const radialSegments = 120;
  const heightSegments = 16;
  const geometry = new THREE.CylinderGeometry(
    0.0534,
    0.0318,
    0.065,
    radialSegments,
    heightSegments,
    true,
  );
  const positions = geometry.attributes.position;
  if (positions !== undefined) {
    for (let index = 0; index < positions.count; index++) {
      const x = positions.getX(index);
      const y = positions.getY(index);
      const z = positions.getZ(index);
      const angle = Math.atan2(z, x);
      const radius = Math.hypot(x, z);
      if (radius < 0.004) continue;
      const heightFraction = Math.max(0, Math.min(1, (y + 0.0325) / 0.065));
      // 30 crisp accordion wave pleats flaring toward the upper rim (`bb-kit-1.jpg`).
      const pleatWave = Math.cos(angle * 30);
      const sharpWave =
        Math.sign(pleatWave) * Math.pow(Math.abs(pleatWave), 0.72);
      const pleat =
        sharpWave * 0.0021 * (0.16 + 0.84 * Math.pow(heightFraction, 0.85));
      const scale = (radius + pleat) / Math.max(radius, 1e-5);
      positions.setX(index, x * scale);
      positions.setZ(index, z * scale);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, 0.0462);
  return geometry;
}

/** Natural unbleached bamboo filter paper grain texture (`bb-kit-0.jpg`, `bb-kit-1.jpg`). */
function createBambooFilterTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#dfc298");
    grad.addColorStop(0.65, "#d4b284");
    grad.addColorStop(1, "#c29b69");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    for (let i = 0; i < 900; i++) {
      const x = (i * 67) % 256;
      const y = (i * 131) % 256;
      ctx.fillStyle =
        i % 2 === 0 ? "rgba(158, 118, 70, 0.12)" : "rgba(248, 232, 204, 0.14)";
      ctx.fillRect(x, y, 2, 8);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Iconic sky-blue Blue Bottle silhouette logo (`#00a0df`) printed on the front
 * of the white Kuemon Arita-yaki porcelain dripper (`bb-dripper-0.jpg`, `bb-kit-0.jpg`).
 */
function createBlueBottleLogoTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = "#009fe3";

    // Characteristic hand-drawn Blue Bottle apothecary bottle silhouette:
    // Tilted top lip ring, narrow neck, sloped shoulders, and rounded flat-bottomed body.
    ctx.beginPath();
    // Top tilted lip collar
    ctx.ellipse(126, 52, 11, 3.2, 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(121, 54);
    ctx.lineTo(120, 82);
    // Left shoulder curve
    ctx.bezierCurveTo(119, 92, 95, 100, 93, 120);
    // Left body flank tapering slightly toward base
    ctx.bezierCurveTo(91, 148, 95, 182, 98, 198);
    // Rounded bottom heel
    ctx.bezierCurveTo(100, 206, 112, 209, 128, 209);
    ctx.bezierCurveTo(144, 209, 156, 206, 158, 198);
    // Right body flank
    ctx.bezierCurveTo(161, 182, 165, 148, 163, 120);
    // Right shoulder curve
    ctx.bezierCurveTo(161, 100, 136, 92, 134, 82);
    ctx.lineTo(132, 55);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Subtle frosted Blue Bottle logo & `BLUE BOTTLE COFFEE` wordmark for the front of the KINTO glass carafe.
 */
function createCarafeLogoTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = "rgba(0, 159, 227, 0.85)";
    ctx.beginPath();
    ctx.ellipse(128, 86, 7, 2.2, 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(124, 88);
    ctx.lineTo(123, 106);
    ctx.bezierCurveTo(122, 113, 106, 118, 105, 132);
    ctx.bezierCurveTo(104, 150, 107, 174, 109, 184);
    ctx.bezierCurveTo(111, 190, 118, 192, 128, 192);
    ctx.bezierCurveTo(138, 192, 145, 190, 147, 184);
    ctx.bezierCurveTo(149, 174, 152, 150, 151, 132);
    ctx.bezierCurveTo(150, 118, 134, 113, 133, 106);
    ctx.lineTo(132, 88);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBorosilicateGlassMaterial(
  opacity = 0.34,
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xf4fbff,
    roughness: 0.035,
    metalness: 0.0,
    transmission: 0.84,
    ior: 1.474,
    thickness: 0.004,
    attenuationColor: new THREE.Color(0xdff2f9),
    attenuationDistance: 0.16,
    reflectivity: 0.94,
    clearcoat: 1.0,
    clearcoatRoughness: 0.025,
    envMapIntensity: 1.5,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/**
 * Beer-Lambert optical coffee absorption color for pour-over percolation and server beverage.
 */
function beerLambertPourOverColor(depthFraction: number): THREE.Color {
  const u = Math.max(0, Math.min(1, depthFraction));
  const amber = new THREE.Color(0xb85a1c);
  const garnet = new THREE.Color(0x5c1b07);
  const mahogany = new THREE.Color(0x1b0702);
  if (u < 0.38) {
    return amber.lerp(garnet, u / 0.38);
  }
  return garnet.lerp(mahogany, (u - 0.38) / 0.62);
}

/**
 * Builds a closed LatheGeometry for the brewed coffee inside the Blue Bottle x KINTO
 * straight-walled glass carafe (`r = 0.0488 m`), with a rounded bottom fillet and concave capillary meniscus.
 */
function buildServerBeverageGeometry(zTop: number): THREE.BufferGeometry {
  const z0 = SERVER_FLOOR_M;
  const z1 = Math.max(z0 + 0.002, Math.min(0.092, zTop));
  const rMax = SERVER_RADIUS_M;
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0001, z0),
    new THREE.Vector2(rMax - 0.0035, z0),
    new THREE.Vector2(rMax - 0.001, Math.min(z1, z0 + 0.0018)),
    new THREE.Vector2(rMax, Math.min(z1, z0 + 0.0045)),
    new THREE.Vector2(rMax, z1 + 0.0004),
    new THREE.Vector2(rMax - 0.0025, z1),
    new THREE.Vector2(0.0001, z1),
  ];
  return new THREE.LatheGeometry(profile, 48).rotateX(Math.PI / 2);
}

/**
 * Builds a tapering ballistic laminar water jet along the parabolic trajectory from the
 * Fellow Stagg gooseneck tip to the coffee bed, narrowing by continuity as it accelerates under gravity.
 */
function buildTaperingStreamGeometry(
  stream: NonNullable<PourOverSample["stream"]>,
  flowGS: number,
): THREE.BufferGeometry {
  const axialSegments = 28;
  const radialSegments = 14;
  const points: THREE.Vector3[] = [];
  const speeds: number[] = [];
  for (let i = 0; i <= axialSegments; i++) {
    const t = (stream.flightS * i) / axialSegments;
    const vx = stream.velocity[0];
    const vy = stream.velocity[1];
    const vz = stream.velocity[2] - 9.81 * t;
    speeds.push(Math.max(0.25, Math.hypot(vx, vy, vz)));
    points.push(
      new THREE.Vector3(
        stream.outlet[0] + stream.velocity[0] * t,
        stream.outlet[1] + stream.velocity[1] * t,
        stream.outlet[2] + stream.velocity[2] * t - 0.5 * 9.81 * t * t,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(
    curve,
    axialSegments,
    1.0,
    radialSegments,
    false,
  );
  const pos = geometry.attributes.position;
  if (pos !== undefined) {
    const flowNorm = Math.max(
      0.35,
      Math.min(1.25, Math.sqrt(Math.max(0.8, flowGS) / 11)),
    );
    const baseRadius = 0.0024 * flowNorm;
    const v0 = speeds[0] ?? 0.4;
    const ringStride = radialSegments + 1;
    const center = new THREE.Vector3();
    const vertex = new THREE.Vector3();
    for (let i = 0; i <= axialSegments; i++) {
      const u = i / axialSegments;
      curve.getPointAt(u, center);
      const speed = speeds[i] ?? v0;
      const continuityTaper = Math.pow(v0 / Math.max(v0, speed), 0.44);
      const radius = Math.max(0.001, baseRadius * continuityTaper);
      for (let j = 0; j < ringStride; j++) {
        const idx = i * ringStride + j;
        vertex.fromBufferAttribute(pos, idx);
        vertex.sub(center).multiplyScalar(radius).add(center);
        pos.setXYZ(idx, vertex.x, vertex.y, vertex.z);
      }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  return geometry;
}

/**
 * The accepted state of the station: arm, kettle, vessels, scale, water and
 * stream. It only draws recorded samples; it runs no controller.
 */
export class PourOverScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  /** Only this root converts Z-up physics into Three.js Y-up. */
  private readonly root = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly bodies = new Map<Body, THREE.Group>();
  private readonly kettleWater = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 40).rotateX(Math.PI / 2),
    new THREE.MeshPhysicalMaterial({
      color: 0xd8eff8,
      roughness: 0.06,
      metalness: 0.01,
      clearcoat: 0.85,
      transparent: true,
      opacity: 0.56,
    }),
  );
  private readonly bedWater = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 48).rotateX(Math.PI / 2),
    new THREE.MeshPhysicalMaterial({
      color: 0x3b1808,
      roughness: 0.12,
      metalness: 0.03,
      clearcoat: 0.78,
      transparent: true,
      opacity: 0.92,
    }),
  );
  private readonly landingRipple = new THREE.Mesh(
    new THREE.RingGeometry(0.0022, 0.0052, 36),
    new THREE.MeshBasicMaterial({
      color: 0xe6bc8a,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
    }),
  );
  private readonly landingRippleOuter = new THREE.Mesh(
    new THREE.RingGeometry(0.0055, 0.0085, 36),
    new THREE.MeshBasicMaterial({
      color: 0xd49c62,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    }),
  );
  private readonly beverageMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x1e0802,
    roughness: 0.06,
    metalness: 0.02,
    clearcoat: 0.88,
    clearcoatRoughness: 0.04,
    transparent: true,
    opacity: 0.94,
  });
  private readonly beverage = new THREE.Mesh(
    new THREE.BufferGeometry(),
    this.beverageMaterial,
  );
  private beverageCapKey = "";
  private readonly beverageMeniscus = new THREE.Mesh(
    new THREE.RingGeometry(
      SERVER_RADIUS_M - 0.0052,
      SERVER_RADIUS_M - 0.0004,
      56,
    ),
    new THREE.MeshBasicMaterial({
      color: 0xc98d4e,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
    }),
  );
  private readonly beverageCenterFoam = new THREE.Mesh(
    new THREE.RingGeometry(0.0008, 0.011, 36),
    new THREE.MeshBasicMaterial({
      color: 0xd49a5a,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    }),
  );
  private readonly percolation = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0015, 0.00085, 1, 18).rotateX(Math.PI / 2),
    new THREE.MeshPhysicalMaterial({
      color: 0x7a340e,
      roughness: 0.06,
      clearcoat: 0.85,
      transparent: true,
      opacity: 0.86,
    }),
  );
  private readonly percolationDrops: readonly THREE.Mesh[];
  private readonly stream = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshPhysicalMaterial({
      color: 0xe8f6fd,
      roughness: 0.03,
      metalness: 0.01,
      transmission: 0.76,
      ior: 1.333,
      clearcoat: 1.0,
      transparent: true,
      opacity: 0.82,
    }),
  );
  private readonly filterPaperMaterial = new THREE.MeshStandardMaterial({
    map: createBambooFilterTexture(),
    color: 0xe6caa0,
    roughness: 0.82,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  private readonly scaleDisplayCanvas = document.createElement("canvas");
  private readonly scaleDisplayTexture: THREE.CanvasTexture;
  private scaleDisplayKey = "";
  private readonly kettleBaseCanvas = document.createElement("canvas");
  private readonly kettleBaseTexture: THREE.CanvasTexture;
  private kettleBaseKey = "";
  private readonly bedSurfaceCanvas = document.createElement("canvas");
  private readonly bedSurfaceTexture: THREE.CanvasTexture;
  private readonly bloomCremaDiscGeometry = new THREE.RingGeometry(
    0.0003,
    BED_RADIUS_M,
    56,
    14,
  );
  private readonly bloomCremaDiscMaterial: THREE.MeshStandardMaterial;
  private readonly bloomCremaDisc: THREE.Mesh;
  private readonly steamWisps: readonly THREE.Mesh[];
  private lastTrailPoint: readonly [number, number] | null = null;
  private pivots: Readonly<{ object: THREE.Object3D; axis: THREE.Vector3 }>[] =
    [];
  private readonly orbit: OrbitControls;
  private readonly abort = new AbortController();
  private batchSamples: readonly PourOverSample[] = [];
  private displayedFrame: PourOverSample | null = null;
  private transitionStartedAt = 0;
  private streamKey = "";
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(
    view: HTMLElement,
    private readonly setup: PourOverSetup,
  ) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      look: {
        exposure: 0.88,
        background: 0xded9d0,
        environmentIntensity: 0.42,
      },
      pointer: "pan",
      size: { minHeight: 560 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;
    this.orbit = this.host.orbit;

    const [hemi, keyLight, rimLight] = studioLights({
      hemi: 1.15,
      keyIntensity: 1.85,
      keyAt: [1.4, 2.6, 1.8],
      shadow: [0.4, 6.5],
      shadowExtent: [1.2, 1.2],
      rimIntensity: 0.65,
      rimAt: [-1.6, 1.8, -1.2],
    });
    this.scene.add(hemi, keyLight, rimLight, this.root);

    this.scaleDisplayCanvas.width = 256;
    this.scaleDisplayCanvas.height = 64;
    this.scaleDisplayTexture = new THREE.CanvasTexture(this.scaleDisplayCanvas);
    this.scaleDisplayTexture.colorSpace = THREE.SRGBColorSpace;

    this.kettleBaseCanvas.width = 128;
    this.kettleBaseCanvas.height = 128;
    this.kettleBaseTexture = new THREE.CanvasTexture(this.kettleBaseCanvas);
    this.kettleBaseTexture.colorSpace = THREE.SRGBColorSpace;

    this.bedSurfaceCanvas.width = 256;
    this.bedSurfaceCanvas.height = 256;
    this.bedSurfaceTexture = new THREE.CanvasTexture(this.bedSurfaceCanvas);
    this.bedSurfaceTexture.colorSpace = THREE.SRGBColorSpace;
    this.resetBedSurfaceCanvas();
    this.bloomCremaDiscMaterial = new THREE.MeshStandardMaterial({
      map: this.bedSurfaceTexture,
      roughness: 0.78,
      metalness: 0.02,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
    });
    this.bloomCremaDisc = new THREE.Mesh(
      this.bloomCremaDiscGeometry,
      this.bloomCremaDiscMaterial,
    );
    this.bloomCremaDisc.position.z = BED_SURFACE_M + 0.0005;

    const dropMat = new THREE.MeshPhysicalMaterial({
      color: 0x6e2b0b,
      roughness: 0.05,
      clearcoat: 0.9,
      transparent: true,
      opacity: 0.88,
    });
    this.percolationDrops = [0, 1, 2].map(() => {
      const drop = new THREE.Mesh(
        new THREE.SphereGeometry(0.0017, 12, 10),
        dropMat,
      );
      drop.scale.set(0.85, 0.85, 1.35);
      drop.visible = false;
      return drop;
    });

    this.steamWisps = [0, 1, 2].map(
      () =>
        new THREE.Mesh(
          new THREE.RingGeometry(0.007, 0.021, 28),
          new THREE.MeshBasicMaterial({
            color: 0xf7f5f0,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        ),
    );

    this.root.rotation.x = -Math.PI / 2;
    this.root.add(this.robot);
    setPose(this.robot, setup.robotBase);
    for (const body of BODIES) {
      const group = new THREE.Group();
      this.bodies.set(body, group);
      if (body === "po_finger_left" || body === "po_finger_right")
        this.bodies.get("po_gripper")?.add(group);
      else this.root.add(group);
    }
    this.bodies.set("world", this.root);
    this.buildFloorAndStudio();
    for (const item of setup.geometry) this.addGeometry(item);
    this.buildParallelGripper();
    this.buildBrewScale();
    this.buildKettleStand();
    this.buildGlassServer();
    this.buildPorcelainDripper();
    this.buildGooseneckKettle();

    this.landingRipple.visible = false;
    this.landingRippleOuter.visible = false;
    this.percolation.visible = false;
    this.beverageMeniscus.visible = false;
    this.beverageCenterFoam.visible = false;
    this.bodies.get("po_kettle")?.add(this.kettleWater);
    this.bodies
      .get("po_dripper")
      ?.add(
        this.bedWater,
        this.bloomCremaDisc,
        this.landingRipple,
        this.landingRippleOuter,
        ...this.steamWisps,
      );
    this.bodies
      .get("po_server")
      ?.add(
        this.beverage,
        this.beverageMeniscus,
        this.beverageCenterFoam,
        this.percolation,
        ...this.percolationDrops,
      );
    this.root.add(this.stream);

    // Frame the full FR10 arm clear of the top-left card and center the station.
    this.camera.position.set(...CAMERA_PRESETS.bench.position);
    this.orbit.target.set(...CAMERA_PRESETS.bench.target);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.48;
    this.orbit.minDistance = 0.28;
    this.orbit.maxDistance = 4.5;
    this.orbit.update();
    this.host.requestFrame();
  }

  private buildFloorAndStudio(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshStandardMaterial({
        color: 0xc9c3b8,
        roughness: 0.88,
        metalness: 0.02,
      }),
    );
    floor.receiveShadow = true;
    const grid = new THREE.GridHelper(3.6, 18, 0x9e978b, 0xbab3a7);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.001;
    this.root.add(floor, grid);
  }

  private addGeometry(item: PourOverSetup["geometry"][number]): void {
    // Vessels, scale, kettle base, and parallel gripper have dedicated sculpted meshes at their exact physics poses.
    if (
      item.body === "po_gripper" ||
      item.body === "po_finger_left" ||
      item.body === "po_finger_right" ||
      item.body === "po_server" ||
      item.body === "po_dripper" ||
      item.body === "po_kettle" ||
      item.name === "po_scale_base" ||
      item.name === "po_scale_platen_top" ||
      item.name === "po_kettle_stand"
    )
      return;

    let geometry: THREE.BufferGeometry;
    if (item.shape === "box")
      geometry = new THREE.BoxGeometry(
        item.size[0] * 2,
        item.size[1] * 2,
        item.size[2] * 2,
      );
    else if (item.shape === "capsule")
      geometry = new THREE.CapsuleGeometry(
        item.size[0],
        item.size[1] * 2,
        8,
        16,
      ).rotateX(Math.PI / 2);
    else
      geometry = new THREE.CylinderGeometry(
        item.size[0],
        item.size[0],
        item.size[1] * 2,
        40,
      ).rotateX(Math.PI / 2);

    let material: THREE.MeshStandardMaterial;
    if (item.name === "po_bench_top") {
      // Warm natural oak café counter top.
      material = new THREE.MeshStandardMaterial({
        color: 0xb68252,
        roughness: 0.48,
        metalness: 0.04,
      });
    } else if (item.name.startsWith("po_bench_leg_")) {
      material = new THREE.MeshStandardMaterial({
        color: 0x2c3035,
        roughness: 0.52,
        metalness: 0.45,
      });
    } else if (item.name.startsWith("pedestal_")) {
      material = new THREE.MeshStandardMaterial({
        color: 0x4c545b,
        roughness: 0.46,
        metalness: 0.35,
      });
    } else {
      const color = new THREE.Color().setRGB(
        item.rgba[0],
        item.rgba[1],
        item.rgba[2],
      );
      material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.38,
        metalness: 0.18,
        transparent: item.rgba[3] < 1,
        opacity: item.rgba[3],
      });
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = item.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    setPose(mesh, item.pose);
    this.bodies.get(item.body)?.add(mesh);
  }

  /**
   * High-fidelity collaborative barista end-effector mounted to the FR10 j6 flange:
   * - ISO 9409-1-50-4-M6 Quick Tool Changer with locking cam pins, status LED ring,
   *   pneumatic/I/O pass-through manifold, and coiled polyurethane M8 umbilical cable
   * - Chamfered CNC gunmetal & brushed-titanium servo actuator body with recessed side plates
   * - Hardened steel linear guide rail with optical encoder strip and bearing trucks
   * - CNC truss fingers with form-fitted silicone handle-cradle pads (`y_local = -sign * 0.006 m`
   *   across `x = 0.120..0.140 m` with front/back retention lips) calibrated to lock flush onto
   *   the `20 mm` wide (`y = ±0.010 m`) Fellow Stagg EKG kettle handle.
   */
  private buildParallelGripper(): void {
    const gripper = this.bodies.get("po_gripper");
    const leftFinger = this.bodies.get("po_finger_left");
    const rightFinger = this.bodies.get("po_finger_right");
    if (
      gripper === undefined ||
      leftFinger === undefined ||
      rightFinger === undefined
    )
      return;

    const titaniumMat = new THREE.MeshStandardMaterial({
      color: 0xbac4ce,
      roughness: 0.22,
      metalness: 0.84,
    });
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x22272e,
      roughness: 0.32,
      metalness: 0.68,
    });
    const slateTealMat = new THREE.MeshStandardMaterial({
      color: 0x1d5b63,
      roughness: 0.28,
      metalness: 0.46,
    });
    const hardenedSteelMat = new THREE.MeshStandardMaterial({
      color: 0xd8dfe6,
      roughness: 0.16,
      metalness: 0.92,
    });
    const brassAccentMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.24,
      metalness: 0.86,
    });
    const cableJacketMat = new THREE.MeshStandardMaterial({
      color: 0x141619,
      roughness: 0.58,
      metalness: 0.08,
    });
    const siliconePadMat = new THREE.MeshStandardMaterial({
      color: 0x16181b,
      roughness: 0.72,
      metalness: 0.05,
    });
    const ledRingMat = new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      emissive: new THREE.Color(0x16a34a),
      emissiveIntensity: 0.75,
      roughness: 0.18,
    });

    const changerProfile = [
      new THREE.Vector2(0.012, 0.0),
      new THREE.Vector2(0.041, 0.0),
      new THREE.Vector2(0.041, 0.007),
      new THREE.Vector2(0.038, 0.009),
      new THREE.Vector2(0.038, 0.014),
      new THREE.Vector2(0.0395, 0.016),
      new THREE.Vector2(0.0395, 0.023),
      new THREE.Vector2(0.036, 0.025),
      new THREE.Vector2(0.012, 0.025),
    ];
    const changerCoupling = new THREE.Mesh(
      new THREE.LatheGeometry(changerProfile, 48).rotateZ(-Math.PI / 2),
      titaniumMat,
    );

    const changerLockCollar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0388, 0.0388, 0.007, 48, 1, true).rotateZ(
        Math.PI / 2,
      ),
      gunmetalMat,
    );
    changerLockCollar.position.set(0.0185, 0, 0);

    const statusRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.0386, 0.0015, 12, 48).rotateY(Math.PI / 2),
      ledRingMat,
    );
    statusRing.position.set(0.0125, 0, 0);

    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const bolt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0022, 0.0022, 0.004, 14).rotateZ(
          Math.PI / 2,
        ),
        hardenedSteelMat,
      );
      bolt.position.set(0.007, Math.cos(a) * 0.035, Math.sin(a) * 0.035);
      gripper.add(bolt);
    }
    for (const signY of [-1, 1] as const) {
      const camPin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0032, 0.0032, 0.008, 16),
        brassAccentMat,
      );
      camPin.position.set(0.019, signY * 0.039, 0);
      gripper.add(camPin);
    }

    const ioManifold = new THREE.Mesh(
      new THREE.BoxGeometry(0.018, 0.026, 0.012),
      gunmetalMat,
    );
    ioManifold.position.set(0.017, 0, 0.038);

    const glandWrist = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0038, 0.0044, 0.008, 16).rotateZ(
        Math.PI / 2,
      ),
      brassAccentMat,
    );
    glandWrist.position.set(0.005, 0.018, 0.036);

    const glandBody = glandWrist.clone();
    glandBody.position.set(0.034, 0.026, 0.031);

    const cableCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.004, 0.018, 0.036),
      new THREE.Vector3(0.014, 0.036, 0.048),
      new THREE.Vector3(0.026, 0.038, 0.044),
      new THREE.Vector3(0.035, 0.026, 0.031),
    ]);
    const ioCable = new THREE.Mesh(
      new THREE.TubeGeometry(cableCurve, 24, 0.0026, 12, false),
      cableJacketMat,
    );

    const bodyShape = new THREE.Shape();
    bodyShape.moveTo(0.025, -0.044);
    bodyShape.lineTo(0.053, -0.051);
    bodyShape.quadraticCurveTo(0.06, -0.051, 0.06, -0.044);
    bodyShape.lineTo(0.06, 0.044);
    bodyShape.quadraticCurveTo(0.06, 0.051, 0.053, 0.051);
    bodyShape.lineTo(0.025, 0.044);
    bodyShape.closePath();

    const palmGeo = new THREE.ExtrudeGeometry(bodyShape, {
      depth: 0.052,
      bevelEnabled: true,
      bevelThickness: 0.0028,
      bevelSize: 0.0024,
      bevelSegments: 4,
    });
    palmGeo.translate(0, 0, -0.026);
    const palmBody = new THREE.Mesh(palmGeo, gunmetalMat);

    const plateShape = new THREE.Shape();
    plateShape.moveTo(0.029, -0.038);
    plateShape.lineTo(0.055, -0.043);
    plateShape.lineTo(0.055, 0.043);
    plateShape.lineTo(0.029, 0.038);
    plateShape.closePath();
    const plateGeo = new THREE.ExtrudeGeometry(plateShape, {
      depth: 0.0022,
      bevelEnabled: true,
      bevelThickness: 0.0008,
      bevelSize: 0.0008,
      bevelSegments: 2,
    });
    for (const signZ of [-1, 1] as const) {
      const sidePlate = new THREE.Mesh(plateGeo, titaniumMat);
      sidePlate.position.z = signZ * 0.0282 - 0.0011;
      gripper.add(sidePlate);
      for (const [bx, by] of [
        [0.033, -0.033],
        [0.052, -0.037],
        [0.033, 0.033],
        [0.052, 0.037],
      ] as const) {
        const screw = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0018, 0.0018, 0.002, 12).rotateX(
            Math.PI / 2,
          ),
          hardenedSteelMat,
        );
        screw.position.set(bx, by, signZ * 0.0295);
        gripper.add(screw);
      }
    }

    for (const signY of [-1, 1] as const) {
      const bumper = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.004, 0.042),
        slateTealMat,
      );
      bumper.position.set(0.043, signY * 0.049, 0);
      gripper.add(bumper);
    }

    const guideRail = new THREE.Mesh(
      new THREE.BoxGeometry(0.009, 0.106, 0.028),
      hardenedSteelMat,
    );
    guideRail.position.set(0.065, 0, 0);

    const railRacewayTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.0095, 0.104, 0.003),
      gunmetalMat,
    );
    railRacewayTop.position.set(0.065, 0, 0.01);
    const railRacewayBottom = railRacewayTop.clone();
    railRacewayBottom.position.set(0.065, 0, -0.01);

    const encoderScale = new THREE.Mesh(
      new THREE.BoxGeometry(0.002, 0.098, 0.006),
      brassAccentMat,
    );
    encoderScale.position.set(0.0692, 0, 0);

    gripper.add(
      changerCoupling,
      changerLockCollar,
      statusRing,
      ioManifold,
      glandWrist,
      glandBody,
      ioCable,
      palmBody,
      guideRail,
      railRacewayTop,
      railRacewayBottom,
      encoderScale,
    );
    enableShadows(gripper);

    // Calibrated jaw profile for the Fellow Stagg EKG kettle handle (`x ∈ [0.122, 0.138]`, `|y| = 0.010 m`):
    // When grasping, MuJoCo places each finger origin at `|y| = 0.016 m`, so an inner clamping surface
    // at `y_local = -sign * 0.006 m` locks flush against `|y| = 0.010 m`, with front/back keeper lips
    // at `x = 0.114..0.120` and `x = 0.140..0.146` wrapping the handle edges.
    for (const [fingerGroup, sign] of [
      [leftFinger, 1],
      [rightFinger, -1],
    ] as const) {
      const carriage = new THREE.Mesh(
        new THREE.BoxGeometry(0.015, 0.022, 0.034),
        gunmetalMat,
      );
      carriage.position.set(0.073, sign * 0.003, 0);

      const carriageCap = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.018, 0.036),
        slateTealMat,
      );
      carriageCap.position.set(0.074, sign * 0.006, 0);

      for (const [bx, bz] of [
        [0.07, -0.011],
        [0.078, -0.011],
        [0.07, 0.011],
        [0.078, 0.011],
      ] as const) {
        const bolt = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0015, 0.0015, 0.003, 10),
          hardenedSteelMat,
        );
        bolt.position.set(bx, sign * 0.015, bz);
        fingerGroup.add(bolt);
      }

      const handleCradleInnerY = (x: number): number => {
        const dx = Math.abs(x - 0.13);
        // Flat seat (`inward = 0.006 m`) across the 16 mm handle depth (`dx <= 0.0085 m`),
        // with raised front & back retention lips (`inward = 0.0082 m`) that cradle the handle edges.
        const lip =
          dx > 0.0082
            ? Math.sin(Math.min(1, (dx - 0.0082) / 0.009) * Math.PI) * 0.0022
            : 0;
        return -sign * (0.006 + lip);
      };

      const armShape = new THREE.Shape();
      const xSamples = 20;
      armShape.moveTo(0.076, sign * 0.012);
      armShape.lineTo(0.11, sign * 0.009);
      for (let i = 0; i <= xSamples; i++) {
        const x = 0.112 + (0.036 * i) / xSamples;
        armShape.lineTo(x, handleCradleInnerY(x) + sign * 0.0092);
      }
      for (let i = xSamples; i >= 0; i--) {
        const x = 0.112 + (0.036 * i) / xSamples;
        armShape.lineTo(x, handleCradleInnerY(x) + sign * 0.0034);
      }
      armShape.lineTo(0.076, -sign * 0.001);
      armShape.closePath();

      for (const [hx, hy, hr] of [
        [0.088, sign * 0.0055, 0.0032],
        [0.101, sign * 0.0045, 0.0028],
      ] as const) {
        const hole = new THREE.Path();
        hole.absarc(hx, hy, hr, 0, Math.PI * 2, false);
        armShape.holes.push(hole);
      }

      const armGeo = new THREE.ExtrudeGeometry(armShape, {
        depth: 0.03,
        bevelEnabled: true,
        bevelThickness: 0.0012,
        bevelSize: 0.001,
        bevelSegments: 3,
      });
      armGeo.translate(0, 0, -0.015);
      const jawArm = new THREE.Mesh(armGeo, titaniumMat);

      const flangeGeo = new THREE.ExtrudeGeometry(armShape, {
        depth: 0.004,
        bevelEnabled: false,
      });
      for (const rz of [-0.021, 0.017] as const) {
        const ribPlate = new THREE.Mesh(flangeGeo, slateTealMat);
        ribPlate.position.z = rz;
        fingerGroup.add(ribPlate);
      }

      const padShape = new THREE.Shape();
      for (let i = 0; i <= xSamples; i++) {
        const x = 0.112 + (0.036 * i) / xSamples;
        const y = handleCradleInnerY(x) + sign * 0.0034;
        if (i === 0) padShape.moveTo(x, y);
        else padShape.lineTo(x, y);
      }
      for (let i = xSamples; i >= 0; i--) {
        const x = 0.112 + (0.036 * i) / xSamples;
        padShape.lineTo(x, handleCradleInnerY(x));
      }
      padShape.closePath();

      const padGeo = new THREE.ExtrudeGeometry(padShape, {
        depth: 0.046,
        bevelEnabled: true,
        bevelThickness: 0.0009,
        bevelSize: 0.0008,
        bevelSegments: 3,
      });
      padGeo.translate(0, 0, -0.023);
      const siliconePad = new THREE.Mesh(padGeo, siliconePadMat);

      for (const rx of [0.117, 0.1235, 0.13, 0.1365, 0.143] as const) {
        const rib = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.0011, 0.043, 8, 12).rotateX(Math.PI / 2),
          siliconePadMat,
        );
        rib.position.set(rx, handleCradleInnerY(rx) + sign * 0.0003, 0);
        fingerGroup.add(rib);
      }

      fingerGroup.add(carriage, carriageCap, jawArm, siliconePad);
      enableShadows(fingerGroup);
    }
  }

  /**
   * Minimalist Acaia Pearl / Blue Bottle precision barista scale at `(0.62, 0.17, 0.800)`:
   * - Chamfered matte-white polycarbonate unibody housing on 4 anti-slip rubber feet
   * - Brushed champagne-anodized bezel trim
   * - Ribbed matte-black heat-resistant silicone weighing pad (`top at z = 0.830 m`)
   * - Recessed front-facing OLED matrix display (`timer`, `flow-rate bar`, `tared weight in g`)
   */
  private buildBrewScale(): void {
    const scaleGroup = new THREE.Group();
    scaleGroup.position.set(0.62, 0.17, 0.8);

    const whiteBodyMat = new THREE.MeshStandardMaterial({
      color: 0xf4f2ec,
      roughness: 0.2,
      metalness: 0.04,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xc8bfa8,
      roughness: 0.26,
      metalness: 0.76,
    });
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x181a1d,
      roughness: 0.76,
      metalness: 0.04,
    });

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.188, 0.188, 0.023),
      whiteBodyMat,
    );
    body.position.z = 0.012;

    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(0.182, 0.182, 0.0022),
      trimMat,
    );
    trim.position.z = 0.0242;

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(0.164, 0.164, 0.0048),
      padMat,
    );
    pad.position.z = 0.0276;

    // Concentric heat-dissipation rings on the silicone weighing pad.
    for (const r of [0.032, 0.052, 0.068] as const) {
      const groove = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.0007, 8, 48),
        padMat,
      );
      groove.position.z = 0.0301;
      scaleGroup.add(groove);
    }

    const display = new THREE.Mesh(
      new THREE.PlaneGeometry(0.126, 0.02),
      new THREE.MeshBasicMaterial({ map: this.scaleDisplayTexture }),
    );
    display.rotation.set(Math.PI / 2, Math.PI / 2, 0);
    display.position.set(0.0945, 0, 0.0125);

    scaleGroup.add(body, trim, pad, display);
    enableShadows(scaleGroup);
    this.root.add(scaleGroup);
    this.updateScaleDisplay(null);
  }

  /**
   * Fellow Stagg EKG square matte-black electric kettle base (`bb-kettle-0.jpg`, `bb-kettle-1.png`)
   * at `(0.62, -0.22, 0.800)` with recessed circular power socket ring (`top at z = 0.830 m`),
   * front-left circular LCD temperature screen (`93°C`), and front-right rotary control dial knob.
   */
  private buildKettleStand(): void {
    const standGroup = new THREE.Group();
    standGroup.position.set(0.62, -0.22, 0.8);

    const matteBlack = new THREE.MeshStandardMaterial({
      color: 0x1a1c20,
      roughness: 0.48,
      metalness: 0.16,
    });
    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x2c3036,
      roughness: 0.32,
      metalness: 0.68,
    });
    const brassContact = new THREE.MeshStandardMaterial({
      color: 0xc8a248,
      roughness: 0.25,
      metalness: 0.88,
    });

    // Square bevelled Stagg EKG base plinth (`148 x 148 x 29 mm`).
    const plinthShape = new THREE.Shape();
    const half = 0.072;
    const rad = 0.007;
    plinthShape.moveTo(-half + rad, -half);
    plinthShape.lineTo(half - rad, -half);
    plinthShape.quadraticCurveTo(half, -half, half, -half + rad);
    plinthShape.lineTo(half, half - rad);
    plinthShape.quadraticCurveTo(half, half, half - rad, half);
    plinthShape.lineTo(-half + rad, half);
    plinthShape.quadraticCurveTo(-half, half, -half, half - rad);
    plinthShape.lineTo(-half, -half + rad);
    plinthShape.quadraticCurveTo(-half, -half, -half + rad, -half);
    plinthShape.closePath();

    const plinthGeo = new THREE.ExtrudeGeometry(plinthShape, {
      depth: 0.027,
      bevelEnabled: true,
      bevelThickness: 0.0014,
      bevelSize: 0.0014,
      bevelSegments: 3,
    });
    const plinth = new THREE.Mesh(plinthGeo, matteBlack);
    plinth.position.z = 0.0014;

    // Circular kettle seating well + central Strix 360° power connector ring (`z = 0.030 m`).
    const wellRim = new THREE.Mesh(
      new THREE.RingGeometry(0.056, 0.0605, 48),
      darkMetal,
    );
    wellRim.position.z = 0.0299;

    const strixOuter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.017, 0.018, 0.0025, 32).rotateX(Math.PI / 2),
      darkMetal,
    );
    strixOuter.position.z = 0.0295;

    const strixPin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.0032, 20).rotateX(Math.PI / 2),
      brassContact,
    );
    strixPin.position.z = 0.0298;

    // Front-left circular LCD temperature display (`bb-kettle-0.jpg`, camera faces +X/-Y).
    const lcdBezel = new THREE.Mesh(
      new THREE.RingGeometry(0.0115, 0.0132, 32),
      darkMetal,
    );
    lcdBezel.position.set(0.054, -0.052, 0.03);

    const lcdScreen = new THREE.Mesh(
      new THREE.CircleGeometry(0.0115, 32),
      new THREE.MeshBasicMaterial({ map: this.kettleBaseTexture }),
    );
    lcdScreen.position.set(0.054, -0.052, 0.0301);

    // Front-right rotary temperature dial knob (`bb-kettle-0.jpg`).
    const dialKnob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0125, 0.013, 0.0075, 36).rotateX(
        Math.PI / 2,
      ),
      matteBlack,
    );
    dialKnob.position.set(0.054, 0.052, 0.0332);

    const dialCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0118, 0.0118, 0.001, 36).rotateX(
        Math.PI / 2,
      ),
      darkMetal,
    );
    dialCap.position.set(0.054, 0.052, 0.0372);

    standGroup.add(
      plinth,
      wellRim,
      strixOuter,
      strixPin,
      lcdBezel,
      lcdScreen,
      dialKnob,
      dialCap,
    );
    enableShadows(standGroup);
    this.root.add(standGroup);
    this.updateKettleBaseDisplay(93.0);
  }

  private updateKettleBaseDisplay(kettleC: number): void {
    const tempText = `${Math.round(kettleC)}°C`;
    if (tempText === this.kettleBaseKey) return;
    this.kettleBaseKey = tempText;
    const ctx = this.kettleBaseCanvas.getContext("2d");
    if (ctx === null) return;
    ctx.fillStyle = "#121a1d";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#d8eef5";
    ctx.font = "700 34px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tempText, 64, 54);
    ctx.fillStyle = "#7aa6b8";
    ctx.font = "600 16px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("SET 93°C", 64, 88);
    this.kettleBaseTexture.needsUpdate = true;
  }

  private updateScaleDisplay(sample: PourOverSample | null): void {
    const timeText =
      sample?.control.brewS === null || sample?.control.brewS === undefined
        ? "0:00"
        : `${Math.floor(sample.control.brewS / 60)}:${String(
            Math.floor(sample.control.brewS % 60),
          ).padStart(2, "0")}`;
    const massText =
      sample === null || sample.scale.readingG === null || !sample.scale.tared
        ? "0.0 g"
        : `${sample.scale.readingG.toFixed(1)} g`;
    const flowNorm =
      sample === null ? 0 : Math.min(1, sample.water.flowGS / 15.0);
    const key = `${timeText}|${massText}|${flowNorm.toFixed(2)}`;
    if (key === this.scaleDisplayKey) return;
    this.scaleDisplayKey = key;
    const context = this.scaleDisplayCanvas.getContext("2d");
    if (context === null) return;
    context.fillStyle = "#0e1013";
    context.fillRect(0, 0, 256, 64);

    // Subtle Tare ("T") and Power LED indicators on outer corners.
    context.fillStyle = "rgba(180, 192, 206, 0.5)";
    context.font = "700 13px ui-sans-serif, system-ui, sans-serif";
    context.textAlign = "left";
    context.fillText("P", 8, 16);
    context.textAlign = "right";
    context.fillText("T", 248, 16);

    // Live flow-rate LED bar along bottom center.
    context.fillStyle = "#222830";
    context.fillRect(88, 48, 80, 5);
    if (flowNorm > 0.02) {
      context.fillStyle = "#38bdf8";
      context.fillRect(88, 48, Math.round(80 * flowNorm), 5);
    }

    context.fillStyle = "#f5f8fc";
    context.font = "700 26px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillText(timeText, 22, 32);
    context.textAlign = "right";
    context.fillText(massText, 234, 32);
    this.scaleDisplayTexture.needsUpdate = true;
  }

  /**
   * Blue Bottle x KINTO 550 mL heat-resistant borosilicate glass carafe (`bb-carafe-0.jpg`, `bb-carafe-1.png`):
   * - Straight-walled optical glass cylinder (`r_outer = 0.0512 m`, `r_inner = 0.0490 m`, `h = 0.100 m`)
   *   with rounded bottom heel and thickened optical base
   * - Delicate V-shaped pouring spout lip on the left (`-Y`) profile
   * - Solid bent crystal-clear glass D-handle on the right (`+Y`) profile (`bb-carafe-0.jpg`)
   * - Subtle Blue Bottle apothecary silhouette mark on the front glass face
   */
  private buildGlassServer(): void {
    const server = this.bodies.get("po_server");
    if (server === undefined) return;

    const glassMaterial = createBorosilicateGlassMaterial(0.32);
    const solidGlassMaterial = createBorosilicateGlassMaterial(0.54);

    // One-piece LatheGeometry borosilicate carafe body (outer wall + rim + inner wall + thickened floor).
    const carafeProfile = [
      new THREE.Vector2(0.0001, 0.0004),
      new THREE.Vector2(0.0465, 0.0004),
      new THREE.Vector2(0.0502, 0.0028),
      new THREE.Vector2(0.0512, 0.0085),
      new THREE.Vector2(0.0512, 0.0955),
      new THREE.Vector2(0.052, 0.0988),
      new THREE.Vector2(0.0506, 0.0998),
      new THREE.Vector2(0.049, 0.0985),
      new THREE.Vector2(0.049, 0.009),
      new THREE.Vector2(0.0462, 0.0046),
      new THREE.Vector2(0.0001, 0.0044),
    ];
    const carafeGlass = new THREE.Mesh(
      new THREE.LatheGeometry(carafeProfile, 64).rotateX(Math.PI / 2),
      glassMaterial,
    );

    const rimHighlight = new THREE.Mesh(
      new THREE.TorusGeometry(0.051, 0.0014, 14, 56),
      solidGlassMaterial,
    );
    rimHighlight.position.z = 0.099;

    // Solid bent borosilicate glass D-handle (`bb-carafe-0.jpg`): horizontal top attachment at z = 0.080 m,
    // smooth vertical arch at r = 0.082 m, and lower return into the glass wall at z = 0.022 m.
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.0505, 0.08),
      new THREE.Vector3(0, 0.068, 0.079),
      new THREE.Vector3(0, 0.081, 0.068),
      new THREE.Vector3(0, 0.083, 0.05),
      new THREE.Vector3(0, 0.079, 0.032),
      new THREE.Vector3(0, 0.065, 0.023),
      new THREE.Vector3(0, 0.0505, 0.021),
    ]);
    const handle = new THREE.Mesh(
      new THREE.TubeGeometry(handleCurve, 36, 0.0052, 16, false),
      solidGlassMaterial,
    );
    handle.scale.set(0.72, 1, 1);
    handle.rotation.z = -0.32;

    // Subtle Blue Bottle logo decal on the front-right glass wall of the KINTO carafe
    // (offset from the center axis so the percolating coffee stream is unobstructed).
    const logoDecal = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.0515,
        0.0515,
        0.024,
        24,
        1,
        true,
        Math.PI * 0.25,
        Math.PI * 0.14,
      ).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: createCarafeLogoTexture(),
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    logoDecal.position.z = 0.038;

    server.add(carafeGlass, rimHighlight, handle, logoDecal);
    carafeGlass.castShadow = false;
    rimHighlight.castShadow = false;
    logoDecal.castShadow = false;
  }

  /**
   * Blue Bottle Coffee Dripper (`po_dripper` — Kuemon Arita-yaki porcelain, `bb-dripper-0.jpg`, `bb-dripper-1.jpg`, `bb-dripper-2.jpg`):
   * - Glazed white Arita porcelain cone with domed saucer flange, waist, and 5 underside radial stabilizing ribs
   * - 40 interior radial capillary ridges converging toward the single `5 mm` central drainage orifice
   * - Signature sky-blue Blue Bottle apothecary silhouette logo (`#009fe3`) on the front cone wall
   * - Angular flat-ribbon porcelain D-handle on the right profile side
   * - 30-pleat natural bamboo paper wave filter basket (`bb-kit-1.jpg`) + 27 g ground coffee bed
   */
  private buildPorcelainDripper(): void {
    const dripper = this.bodies.get("po_dripper");
    if (dripper === undefined) return;

    const porcelain = new THREE.MeshPhysicalMaterial({
      color: 0xf8f7f3,
      roughness: 0.11,
      metalness: 0.01,
      clearcoat: 0.88,
      clearcoatRoughness: 0.06,
      side: THREE.DoubleSide,
    });

    // 1. One-piece LatheGeometry for the Kuemon Arita porcelain dripper:
    //    Domed saucer skirt (`r = 0.0575 m` at `z = 0.0025 m`) -> concave neck waist (`r = 0.0365 m` at `z = 0.012 m`)
    //    -> straight tapered cone wall (`r = 0.0585 m` at `z = 0.075 m`) -> inner wall down to flat bottom floor
    //    with central `r = 0.0026 m` single drainage hole (`bb-dripper-1.jpg`).
    const profile = [
      new THREE.Vector2(0.028, -0.0025),
      new THREE.Vector2(0.031, -0.0025),
      new THREE.Vector2(0.032, 0.0005),
      new THREE.Vector2(0.0565, 0.0005),
      new THREE.Vector2(0.0578, 0.0022),
      new THREE.Vector2(0.0558, 0.0052),
      new THREE.Vector2(0.0445, 0.0092),
      new THREE.Vector2(0.0368, 0.0125),
      new THREE.Vector2(0.0435, 0.032),
      new THREE.Vector2(0.0512, 0.054),
      new THREE.Vector2(0.0586, 0.0742),
      new THREE.Vector2(0.0574, 0.0755),
      new THREE.Vector2(0.0554, 0.0742),
      new THREE.Vector2(0.048, 0.053),
      new THREE.Vector2(0.0402, 0.031),
      new THREE.Vector2(0.0334, 0.0125),
      new THREE.Vector2(0.0026, 0.0115),
      new THREE.Vector2(0.0026, 0.0075),
      new THREE.Vector2(0.028, 0.0075),
    ];
    const body = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 64).rotateX(Math.PI / 2),
      porcelain,
    );

    // 2. 5 underside radial stabilizing ribs (`bb-dripper-2.jpg`).
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5;
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(0.022, 0.0036, 0.0032),
        porcelain,
      );
      rib.position.set(Math.cos(a) * 0.042, Math.sin(a) * 0.042, 0.0002);
      rib.rotation.z = a;
      dripper.add(rib);
    }

    // 3. 40 fine interior radial capillary ribs along the inner cone wall (`bb-dripper-1.jpg`).
    const slopeAngle = Math.atan2(0.0554 - 0.0334, 0.0742 - 0.0125);
    const ribGeo = new THREE.CylinderGeometry(0.00042, 0.00052, 0.06, 6);
    const upAxis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 40; i++) {
      const a = (i * Math.PI * 2) / 40;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const p0 = new THREE.Vector3(ca * 0.0334, sa * 0.0334, 0.0145);
      const p1 = new THREE.Vector3(ca * 0.0542, sa * 0.0542, 0.0725);
      const capillary = new THREE.Mesh(ribGeo, porcelain);
      capillary.position.copy(p0).add(p1).multiplyScalar(0.5);
      capillary.quaternion.setFromUnitVectors(
        upAxis,
        p1.clone().sub(p0).normalize(),
      );
      dripper.add(capillary);
    }

    // 4. Angular flat-ribbon porcelain D-handle (`bb-dripper-0.jpg`, `bb-kit-0.jpg`).
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.055, 0.068),
      new THREE.Vector3(0, 0.079, 0.067),
      new THREE.Vector3(0, 0.085, 0.061),
      new THREE.Vector3(0, 0.079, 0.051),
      new THREE.Vector3(0, 0.058, 0.033),
      new THREE.Vector3(0, 0.038, 0.017),
    ]);
    const handle = new THREE.Mesh(
      new THREE.TubeGeometry(handleCurve, 32, 0.0046, 14, false),
      porcelain,
    );
    handle.scale.set(1.35, 0.88, 0.72);
    handle.rotation.z = -0.32;

    // 5. Conformal sky-blue Blue Bottle logo decal on the front cone wall (`bb-dripper-0.jpg`).
    const logoGeo = new THREE.PlaneGeometry(0.026, 0.028, 16, 8);
    const logoPos = logoGeo.attributes.position;
    if (logoPos !== undefined) {
      for (let i = 0; i < logoPos.count; i++) {
        const vx = logoPos.getX(i);
        const vy = logoPos.getY(i);
        const zOnCone = 0.044 + vy * Math.cos(slopeAngle);
        const rAtZ = 0.0368 + ((zOnCone - 0.0125) / 0.0617) * (0.0586 - 0.0368);
        const sag = rAtZ - Math.sqrt(Math.max(1e-5, rAtZ * rAtZ - vx * vx));
        logoPos.setZ(i, 0.0004 - sag / Math.cos(slopeAngle));
      }
      logoPos.needsUpdate = true;
    }
    const logoDecal = new THREE.Mesh(
      logoGeo,
      new THREE.MeshBasicMaterial({
        map: createBlueBottleLogoTexture(),
        transparent: true,
        depthWrite: false,
      }),
    );
    const logoGroup = new THREE.Group();
    const rLogoMid = 0.0481;
    logoGroup.position.set(0, -rLogoMid, 0.044);
    logoGroup.rotation.x = Math.PI / 2 + slopeAngle;
    logoGroup.add(logoDecal);
    const logoWrapper = new THREE.Group();
    logoWrapper.rotation.z = Math.PI * 0.34;
    logoWrapper.add(logoGroup);

    // 6. 30-pleat natural bamboo paper wave filter basket (`bb-kit-1.jpg`).
    const filterPaper = new THREE.Mesh(
      createPleatedFilterGeometry(),
      this.filterPaperMaterial,
    );

    // 7. Prepared 27 g roasted coffee bed inside the bamboo filter cone.
    const coffeeBed = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0398, 0.0315, 0.026, 48).rotateX(
        Math.PI / 2,
      ),
      new THREE.MeshStandardMaterial({
        color: 0x3b2010,
        roughness: 0.9,
        metalness: 0.0,
      }),
    );
    coffeeBed.position.z = 0.0255;

    dripper.add(body, handle, logoWrapper, filterPaper, coffeeBed);
    enableShadows(dripper);
    logoDecal.castShadow = false;
  }

  /**
   * Fellow Stagg EKG Matte-Black Pour-Over Kettle (`bb-kettle-0.jpg`, `bb-kettle-1.png`):
   * - Tapered matte-black 304 stainless body (`z = 0.000..0.136 m`) with flared lower belly and straight upper neck
   * - Concave recessed lid with brushed stainless rim, 3 steam vent holes on the `+X` spout side, and bevelled puck knob
   * - Precision S-curve gooseneck spout with bevelled open-top pouring tip at exact MuJoCo outlet `(0.168, 0, 0.088)`
   * - Iconic single-cantilever counterbalanced Stagg handle (`bb-kettle-1.png`): polished chrome neck ferrule at `z = 0.118 m`,
   *   sculpted thumb-rest horn at `(-0.096, 0, 0.132)`, and counterbalanced grip column centered through `(-0.105, 0, 0.075)`
   */
  private buildGooseneckKettle(): void {
    const kettle = this.bodies.get("po_kettle");
    if (kettle === undefined) return;

    const matteBlack = new THREE.MeshStandardMaterial({
      color: 0x181a1e,
      roughness: 0.42,
      metalness: 0.28,
    });
    const darkSlate = new THREE.MeshStandardMaterial({
      color: 0x25282e,
      roughness: 0.36,
      metalness: 0.34,
    });
    const chromeMetal = new THREE.MeshStandardMaterial({
      color: 0xdce2e8,
      roughness: 0.14,
      metalness: 0.92,
    });
    const ventHoleMat = new THREE.MeshBasicMaterial({ color: 0x050608 });

    // 1. Fellow Stagg silhouette LatheGeometry: rounded bottom heel -> wide lower belly (`r = 0.0605 m` at `z = 0.024 m`)
    //    -> inward conical taper -> straight cylindrical upper neck (`r = 0.0488 m` at `z = 0.108..0.136 m`).
    const bodyProfile = [
      new THREE.Vector2(0.0001, 0.001),
      new THREE.Vector2(0.055, 0.001),
      new THREE.Vector2(0.0595, 0.006),
      new THREE.Vector2(0.0608, 0.022),
      new THREE.Vector2(0.0592, 0.042),
      new THREE.Vector2(0.0548, 0.072),
      new THREE.Vector2(0.0502, 0.104),
      new THREE.Vector2(0.0488, 0.122),
      new THREE.Vector2(0.0488, 0.1355),
      new THREE.Vector2(0.0472, 0.1355),
      new THREE.Vector2(0.044, 0.1325),
      new THREE.Vector2(0.0001, 0.1315),
    ];
    const body = new THREE.Mesh(
      new THREE.LatheGeometry(bodyProfile, 64).rotateX(Math.PI / 2),
      matteBlack,
    );

    const baseRing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0565, 0.0565, 0.003, 48).rotateX(
        Math.PI / 2,
      ),
      chromeMetal,
    );
    baseRing.position.z = 0.0018;

    // 2. Concave recessed lid with brushed stainless rim, 3 steam vent holes (`bb-kettle-0.jpg`), and bevelled puck knob.
    const lidRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.0478, 0.001, 12, 56),
      chromeMetal,
    );
    lidRim.position.z = 0.1356;

    for (const vy of [-0.0065, 0, 0.0065] as const) {
      const vent = new THREE.Mesh(
        new THREE.CircleGeometry(0.0013, 14),
        ventHoleMat,
      );
      vent.position.set(0.034, vy, 0.1332);
      kettle.add(vent);
    }

    const knobStem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0085, 0.0085, 0.006, 28).rotateX(
        Math.PI / 2,
      ),
      matteBlack,
    );
    knobStem.position.z = 0.1355;

    const knobProfile = [
      new THREE.Vector2(0.0001, 0.138),
      new THREE.Vector2(0.0145, 0.138),
      new THREE.Vector2(0.0168, 0.1405),
      new THREE.Vector2(0.0168, 0.1432),
      new THREE.Vector2(0.0148, 0.1448),
      new THREE.Vector2(0.0001, 0.1448),
    ];
    const knob = new THREE.Mesh(
      new THREE.LatheGeometry(knobProfile, 36).rotateX(Math.PI / 2),
      matteBlack,
    );

    // 3. Fluted S-curve gooseneck spout ending at exact physics outlet `(0.168, 0, 0.088)` with bevelled stainless tip (`bb-kettle-0.jpg`).
    const spoutCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.055, 0, 0.022),
      new THREE.Vector3(0.082, 0, 0.018),
      new THREE.Vector3(0.104, 0, 0.048),
      new THREE.Vector3(0.124, 0, 0.095),
      new THREE.Vector3(0.148, 0, 0.098),
      new THREE.Vector3(0.167, 0, 0.0885),
    ]);
    const spout = new THREE.Mesh(
      new THREE.TubeGeometry(spoutCurve, 44, 0.0046, 18, false),
      matteBlack,
    );

    // Bevelled stainless-lined pouring lip cut-out at the tip `(0.168, 0, 0.088)`.
    const spoutTipLip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0042, 0.0045, 0.006, 20, 1, true).rotateZ(
        -Math.PI / 2 + 0.35,
      ),
      chromeMetal,
    );
    spoutTipLip.position.set(0.1665, 0, 0.0888);

    // 4. Iconic Fellow Stagg single-cantilever counterbalanced handle (`bb-kettle-1.png`):
    //    - Polished chrome neck ferrule at `(-0.053, 0, 0.118)`
    //    - Sculpted matte-black cantilever bridge + angled thumb-rest horn at `(-0.095, 0, 0.132)`
    //    - Counterbalanced grip column centered along `x = -0.105 m, y ∈ [-0.010, 0.010], z = 0.028..0.122 m`
    //      so the FR10 parallel jaws clamp directly onto the physical handle column at `(-0.105, 0, 0.075)`.
    const neckFerrule = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0086, 0.0092, 0.014, 28).rotateZ(
        Math.PI / 2,
      ),
      chromeMetal,
    );
    neckFerrule.position.set(-0.054, 0, 0.118);

    const cantileverCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.06, 0, 0.118),
      new THREE.Vector3(-0.082, 0, 0.119),
      new THREE.Vector3(-0.097, 0, 0.123),
      new THREE.Vector3(-0.104, 0, 0.114),
    ]);
    const cantileverStem = new THREE.Mesh(
      new THREE.TubeGeometry(cantileverCurve, 20, 0.0085, 16, false),
      matteBlack,
    );
    cantileverStem.scale.set(1, 1.08, 1);

    // Angled thumb-rest horn at the top of the Stagg handle in the X-Z plane (`bb-kettle-1.png`).
    const hornAxis = new THREE.Vector3(-0.38, 0, 0.925).normalize();
    const thumbHorn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0078, 0.0088, 0.018, 24),
      matteBlack,
    );
    thumbHorn.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      hornAxis,
    );
    thumbHorn.position.set(-0.096, 0, 0.126);

    const thumbCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0075, 0.0078, 0.0018, 24),
      darkSlate,
    );
    thumbCap.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      hornAxis,
    );
    thumbCap.position.set(-0.0994, 0, 0.1342);

    // Ergonomic oval-rectangular grip column centered through `(-0.105, 0, 0.075)` (`width in Y = 20 mm`).
    const gripShape = new THREE.Shape();
    const gx = 0.008;
    const gy = 0.01;
    const gr = 0.0038;
    gripShape.moveTo(-gx + gr, -gy);
    gripShape.lineTo(gx - gr, -gy);
    gripShape.quadraticCurveTo(gx, -gy, gx, -gy + gr);
    gripShape.lineTo(gx, gy - gr);
    gripShape.quadraticCurveTo(gx, gy, gx - gr, gy);
    gripShape.lineTo(-gx + gr, gy);
    gripShape.quadraticCurveTo(-gx, gy, -gx, gy - gr);
    gripShape.lineTo(-gx, -gy + gr);
    gripShape.quadraticCurveTo(-gx, -gy, -gx + gr, -gy);
    gripShape.closePath();

    const gripGeo = new THREE.ExtrudeGeometry(gripShape, {
      depth: 0.092,
      bevelEnabled: true,
      bevelThickness: 0.0015,
      bevelSize: 0.0008,
      bevelSegments: 3,
    });
    const handleGrip = new THREE.Mesh(gripGeo, matteBlack);
    handleGrip.position.set(-0.105, 0, 0.028);

    // Weighted bottom counterweight end-cap ring at `z = 0.027 m` (`bb-kettle-1.png`).
    const bottomCap = new THREE.Mesh(
      new THREE.BoxGeometry(0.0165, 0.0204, 0.0045),
      darkSlate,
    );
    bottomCap.position.set(-0.105, 0, 0.0265);

    kettle.add(
      body,
      baseRing,
      lidRim,
      knobStem,
      knob,
      spout,
      spoutTipLip,
      neckFerrule,
      cantileverStem,
      thumbHorn,
      thumbCap,
      handleGrip,
      bottomCap,
    );
    enableShadows(kettle);
  }

  async load(): Promise<void> {
    const visual = await loadRobotVisual("fairino-fr10", this.abort.signal);
    if (this.lifecycle === "disposed") {
      visual.traverse(disposePhysicsObject);
      return;
    }
    const pivots = fr10Pivots(visual);
    enableShadows(visual);
    // The GLB already uses Y-up, so undo that conversion inside the physics root.
    visual.rotation.x = Math.PI / 2;
    this.robot.add(visual);
    this.pivots = pivots;
    this.lifecycle = "ready";
    const latest = this.batchSamples.at(-1) ?? this.displayedFrame;
    if (latest !== null && latest !== undefined) this.applySample(latest);
    this.host.requestFrame();
  }

  setCameraPreset(preset: PourOverCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset]);
  }

  private resetBedSurfaceCanvas(): void {
    const context = this.bedSurfaceCanvas.getContext("2d");
    if (context === null) return;
    const grad = context.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, "#3b2010");
    grad.addColorStop(0.7, "#472714");
    grad.addColorStop(1, "#2f180b");
    context.fillStyle = grad;
    context.fillRect(0, 0, 256, 256);

    // Granular dry roasted coffee grounds particles before first pour.
    const palette = ["#241107", "#331a0c", "#4d2914", "#5e3319", "#3d2010"];
    for (let i = 0; i < 1400; i++) {
      const x = (i * 73 + ((i * i * 19) % 251)) % 256;
      const y = (i * 137 + ((i * 31) % 241)) % 256;
      const r = 1 + (i % 3) * 0.65;
      context.fillStyle = palette[i % palette.length]!;
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.fill();
    }
    this.lastTrailPoint = null;
    this.bedSurfaceTexture.needsUpdate = true;
  }

  /**
   * Deforms the coffee bed mesh (`bloomCremaDiscGeometry`) to model:
   * - Convex CO2 outgassing bloom dome (`+4.5 mm` center rise during Pour 1 & Bloom rest)
   * - Glossy liquid slurry pool during Pours 2–4
   * - Settled concave spent coffee bed (`-2.0 mm` center dish) as `freeG` drains to 0
   */
  private updateBedSurfaceGeometry(sample: PourOverSample): void {
    const pos = this.bloomCremaDiscGeometry.attributes.position;
    if (pos === undefined) return;
    const wet = sample.water.absorbedG + sample.water.freeG;
    const isBloomPhase =
      sample.control.phase === "pour-1" || sample.control.phase === "rest-1";
    const bloomStrength =
      isBloomPhase && wet > 0.5
        ? Math.min(1, sample.water.absorbedG / 28) *
          Math.max(0.35, 1 - Math.max(0, sample.water.pouredG - 55) / 40)
        : 0;
    const drainConcavity =
      sample.water.pouredG > 80 && sample.water.freeG < 18
        ? (1 - sample.water.freeG / 18) * 0.0022
        : 0;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const rNorm = Math.min(1, Math.hypot(x, y) / BED_RADIUS_M);
      const domeZ =
        bloomStrength * 0.0046 * Math.max(0, 1 - rNorm * rNorm) -
        drainConcavity * Math.max(0, 1 - rNorm * rNorm);
      pos.setZ(i, domeZ);
    }
    pos.needsUpdate = true;
  }

  private updateBedSurface(sample: PourOverSample): void {
    const wet = sample.water.absorbedG + sample.water.freeG;
    if (sample.step <= 5 || wet <= 0.01) {
      if (this.lastTrailPoint !== null) this.resetBedSurfaceCanvas();
      this.bloomCremaDiscMaterial.roughness = 0.84;
      return;
    }
    this.bloomCremaDiscMaterial.roughness =
      sample.water.freeG > 3 ? 0.24 : 0.62;
    const context = this.bedSurfaceCanvas.getContext("2d");
    if (context === null) return;
    const wetPixels = Math.min(
      124,
      Math.max(10, (sample.water.wetRadiusM / BED_RADIUS_M) * 128),
    );
    const isBloom =
      sample.control.phase === "pour-1" || sample.control.phase === "rest-1";
    const gradient = context.createRadialGradient(
      128,
      128,
      wetPixels * 0.18,
      128,
      128,
      wetPixels,
    );
    if (isBloom) {
      // Frothy golden-tan CO2 bloom crema bubbles during Pour 1 & Bloom rest.
      gradient.addColorStop(0, "rgba(112, 58, 22, 0.16)");
      gradient.addColorStop(0.65, "rgba(168, 102, 44, 0.18)");
      gradient.addColorStop(1, "rgba(218, 158, 92, 0.28)");
    } else {
      // Deep mahogany coffee slurry with golden perimeter crema ring during Pours 2–4.
      gradient.addColorStop(0, "rgba(32, 13, 5, 0.18)");
      gradient.addColorStop(0.76, "rgba(64, 30, 12, 0.16)");
      gradient.addColorStop(1, "rgba(204, 144, 78, 0.26)");
    }
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(128, 128, wetPixels, 0, Math.PI * 2);
    context.fill();

    if (sample.stream !== null && sample.stream.flightS > 0) {
      const localX = sample.stream.landing[0] - sample.dripper[0];
      const localY = sample.stream.landing[1] - sample.dripper[1];
      const px = 128 + (localX / BED_RADIUS_M) * 120;
      const py = 128 - (localY / BED_RADIUS_M) * 120;
      if (this.lastTrailPoint !== null) {
        context.strokeStyle = "rgba(228, 176, 110, 0.48)";
        context.lineWidth = 11;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(this.lastTrailPoint[0], this.lastTrailPoint[1]);
        context.lineTo(px, py);
        context.stroke();

        context.strokeStyle = "rgba(26, 10, 3, 0.76)";
        context.lineWidth = 5;
        context.beginPath();
        context.moveTo(this.lastTrailPoint[0], this.lastTrailPoint[1]);
        context.lineTo(px, py);
        context.stroke();
      }
      this.lastTrailPoint = [px, py];
    } else {
      this.lastTrailPoint = null;
    }
    this.bedSurfaceTexture.needsUpdate = true;
  }

  setFrame(sample: PourOverSample): void {
    this.setSamples([sample]);
  }

  /** Plays through every recorded 20 ms sample in the batch at 60 FPS. */
  setSamples(samples: readonly PourOverSample[]): void {
    const latest = samples.at(-1);
    if (latest === undefined) return;
    if (
      this.displayedFrame === null ||
      latest.outcome !== null ||
      latest.step <= this.displayedFrame.step ||
      latest.step - this.displayedFrame.step > 1200
    ) {
      this.batchSamples = [latest];
      this.displayedFrame = latest;
      this.transitionStartedAt = performance.now();
      this.applySample(latest);
      this.host.requestFrame();
      return;
    }
    this.batchSamples = [this.displayedFrame, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: PourOverSample): void {
    this.displayedFrame = sample;
    this.updateScaleDisplay(sample);
    this.updateKettleBaseDisplay(sample.water.kettleC);
    this.updateBedSurface(sample);
    this.updateBedSurfaceGeometry(sample);

    for (const [index, pivot] of this.pivots.entries()) {
      const angle = sample.joints[index];
      if (angle !== undefined)
        pivot.object.quaternion.setFromAxisAngle(pivot.axis, angle);
    }
    const place = (body: Body, pose: StationPose) => {
      const group = this.bodies.get(body);
      if (group !== undefined) setPose(group, pose);
    };
    place("po_gripper", sample.gripper);
    place("po_kettle", sample.kettle);
    place("po_dripper", sample.dripper);
    place("po_server", sample.server);
    for (const [index, side] of (["left", "right"] as const).entries()) {
      const finger = this.bodies.get(
        side === "left" ? "po_finger_left" : "po_finger_right",
      );
      const frame = this.setup.fingers[side];
      if (finger === undefined) continue;
      setPose(finger, frame.pose);
      const opening = sample.fingers[index] ?? 0;
      finger.position.x += (frame.axis[0] ?? 0) * opening;
      finger.position.y += (frame.axis[1] ?? 0) * opening;
      finger.position.z += (frame.axis[2] ?? 0) * opening;
    }

    // 1. Kettle interior water column.
    this.setColumn(
      this.kettleWater,
      KETTLE_RADIUS_M - 0.006,
      KETTLE_FLOOR_M,
      sample.water.kettleG / 1000 / 1000 / (Math.PI * KETTLE_RADIUS_M ** 2),
    );

    // 2. Bamboo paper filter wicking color (darkens warmly as hot water wets the bed).
    const wet = sample.water.absorbedG + sample.water.freeG;
    const filterWetFactor = Math.min(1, wet / 45);
    this.filterPaperMaterial.color
      .setHex(0xe6caa0)
      .lerp(new THREE.Color(0xc49a68), filterWetFactor);

    // 3. Coffee bed slurry height inside the Blue Bottle dripper.
    const bedWaterHeight =
      wet > 0
        ? 0.0015 +
          sample.water.freeG / 1000 / 1000 / (Math.PI * BED_RADIUS_M ** 2)
        : 0;
    this.setColumn(
      this.bedWater,
      Math.max(0.004, Math.min(0.043, sample.water.wetRadiusM)),
      BED_SURFACE_M - 0.002,
      bedWaterHeight,
    );
    this.bloomCremaDisc.position.z =
      BED_SURFACE_M - 0.0015 + bedWaterHeight + 0.0005;

    // 4. Brewed coffee in the Blue Bottle x KINTO glass carafe (`bb-carafe-1.png`).
    const beverageHeight =
      sample.water.serverG / 1000 / 1000 / (Math.PI * SERVER_RADIUS_M ** 2);
    const hasBeverage = sample.water.serverG > 0.4;
    this.beverage.visible = hasBeverage;
    this.beverageMeniscus.visible = hasBeverage;
    if (hasBeverage) {
      const zTop = SERVER_FLOOR_M + Math.max(0.0025, beverageHeight);
      const capKey = zTop.toFixed(4);
      if (capKey !== this.beverageCapKey) {
        this.beverageCapKey = capKey;
        this.beverage.geometry.dispose();
        this.beverage.geometry = buildServerBeverageGeometry(zTop);
      }
      const depthFraction = Math.min(1, sample.water.serverG / 140);
      this.beverageMaterial.color.copy(beerLambertPourOverColor(depthFraction));
      this.beverageMaterial.opacity = THREE.MathUtils.lerp(
        0.78,
        0.95,
        depthFraction,
      );
      this.beverageMeniscus.position.set(0, 0, zTop + 0.0003);
    }

    // 5. Percolating coffee stream & tail droplets from the single center dripper hole (`z = 0.097 m`) into the carafe.
    const topZ = 0.097;
    const bottomZ = SERVER_FLOOR_M + Math.max(0, beverageHeight);
    const steadyPercolation = sample.water.freeG > 5.5;
    const tailDripping = sample.water.freeG > 0.15 && !steadyPercolation;

    this.percolation.visible = steadyPercolation;
    if (steadyPercolation) {
      const dropLen = Math.max(0.005, topZ - bottomZ);
      const streamRadiusScale = Math.min(1.35, 0.65 + sample.water.freeG / 65);
      this.percolation.scale.set(streamRadiusScale, streamRadiusScale, dropLen);
      this.percolation.position.set(0, 0, bottomZ + dropLen / 2);
    }

    // Central crema bubble patch on the carafe coffee surface where percolation lands (`bb-carafe-1.png`).
    this.beverageCenterFoam.visible =
      hasBeverage && (steadyPercolation || tailDripping);
    if (this.beverageCenterFoam.visible) {
      const zTop = SERVER_FLOOR_M + Math.max(0.0025, beverageHeight);
      const foamScale = steadyPercolation
        ? 0.9 + Math.min(0.6, sample.water.freeG / 90)
        : 0.55;
      this.beverageCenterFoam.scale.set(foamScale, foamScale, 1);
      this.beverageCenterFoam.position.set(0, 0, zTop + 0.0004);
      if (this.beverageCenterFoam.material instanceof THREE.MeshBasicMaterial) {
        this.beverageCenterFoam.material.opacity = steadyPercolation
          ? 0.68
          : 0.38;
      }
    }

    // 6. Dual concentric landing ripples where the gooseneck water jet strikes the coffee bed.
    if (sample.stream !== null && sample.stream.flightS > 0) {
      const dripper = sample.dripper;
      const lx = sample.stream.landing[0] - dripper[0];
      const ly = sample.stream.landing[1] - dripper[1];
      const lz = BED_SURFACE_M - 0.0008 + bedWaterHeight;
      this.landingRipple.visible = true;
      this.landingRipple.position.set(lx, ly, lz);
      this.landingRippleOuter.visible = true;
      this.landingRippleOuter.position.set(lx, ly, lz);
    } else {
      this.landingRipple.visible = false;
      this.landingRippleOuter.visible = false;
    }

    this.setStream(sample.stream, sample.water.flowGS);
  }

  private setColumn(
    mesh: THREE.Mesh,
    radius: number,
    floor: number,
    height: number,
  ): void {
    mesh.visible = height > 1e-5;
    mesh.scale.set(radius, radius, Math.max(height, 1e-5));
    mesh.position.set(0, 0, floor + height / 2);
  }

  /** The recorded jet: its outlet, velocity, flight time and flow rate, under gravity. */
  private setStream(stream: PourOverSample["stream"], flowGS: number): void {
    if (stream === null || stream.flightS <= 0) {
      if (this.stream.visible) {
        this.stream.geometry.dispose();
        this.stream.geometry = new THREE.BufferGeometry();
        this.stream.visible = false;
        this.streamKey = "";
      }
      return;
    }
    const key = `${stream.outlet[0].toFixed(4)},${stream.outlet[1].toFixed(4)},${stream.outlet[2].toFixed(4)},${stream.velocity[0].toFixed(3)},${stream.velocity[1].toFixed(3)},${stream.velocity[2].toFixed(3)},${stream.flightS.toFixed(4)},${flowGS.toFixed(1)}`;
    if (key === this.streamKey && this.stream.visible) return;
    this.streamKey = key;
    this.stream.geometry.dispose();
    this.stream.geometry = buildTaperingStreamGeometry(stream, flowGS);
    this.stream.visible = true;
  }

  /** Plays a batch of samples between two ticks; true while it plays. */
  private step(now: number): boolean {
    if (this.batchSamples.length > 1) {
      const alpha = Math.min(
        1,
        (now - this.transitionStartedAt) / INTERPOLATION_MS,
      );
      const scaled = alpha * (this.batchSamples.length - 1);
      const index = Math.min(this.batchSamples.length - 2, Math.floor(scaled));
      const first = this.batchSamples[index];
      const next = this.batchSamples[index + 1];
      if (first !== undefined && next !== undefined) {
        this.applySample(interpolateSample(first, next, scaled - index));
      }
      if (alpha >= 1) {
        const last = this.batchSamples.at(-1);
        this.batchSamples = last === undefined ? [] : [last];
      }
    }
    const sample = this.displayedFrame;
    if (sample !== null) {
      // Animate expanding concentric ripples around the stream impact point.
      if (this.landingRipple.visible) {
        const rPhase1 = (((now * 0.0032) % 1) + 1) % 1;
        const rPhase2 = (((now * 0.0032 + 0.5) % 1) + 1) % 1;
        const s1 = 0.65 + rPhase1 * 1.45;
        const s2 = 0.65 + rPhase2 * 1.45;
        this.landingRipple.scale.set(s1, s1, 1);
        this.landingRippleOuter.scale.set(s2, s2, 1);
        if (this.landingRipple.material instanceof THREE.MeshBasicMaterial) {
          this.landingRipple.material.opacity = (1 - rPhase1) * 0.72;
        }
        if (
          this.landingRippleOuter.material instanceof THREE.MeshBasicMaterial
        ) {
          this.landingRippleOuter.material.opacity = (1 - rPhase2) * 0.52;
        }
      }

      // Animate falling coffee droplets during tail drainage (or alongside percolation).
      const dripping = sample.water.freeG > 0.15 && sample.water.freeG <= 14.0;
      const beverageHeight =
        sample.water.serverG / 1000 / 1000 / (Math.PI * SERVER_RADIUS_M ** 2);
      const topZ = 0.096;
      const bottomZ = SERVER_FLOOR_M + Math.max(0.002, beverageHeight);
      const fallDist = Math.max(0.01, topZ - bottomZ);
      for (const [index, drop] of this.percolationDrops.entries()) {
        drop.visible = dripping;
        if (!dripping) continue;
        const rate = 0.0018 + Math.min(0.0022, sample.water.freeG * 0.0002);
        const cycle =
          (((now * rate + index / this.percolationDrops.length) % 1) + 1) % 1;
        // Gravity-accelerated fall `z = topZ - fallDist * cycle^2`.
        drop.position.set(0, 0, topZ - fallDist * cycle * cycle);
      }
    }

    const steaming =
      sample !== null &&
      sample.water.absorbedG + sample.water.freeG > 1 &&
      sample.water.bedC > 60;
    for (const [index, wisp] of this.steamWisps.entries()) {
      wisp.visible = steaming;
      if (!steaming) continue;
      const cycle =
        (((now * 0.00042 + index / this.steamWisps.length) % 1) + 1) % 1;
      wisp.position.set(
        Math.sin(now * 0.0018 + index * 2.1) * 0.005,
        Math.cos(now * 0.0015 + index * 1.7) * 0.005,
        BED_SURFACE_M + 0.015 + cycle * 0.068,
      );
      const scale = 0.72 + cycle * 0.95;
      wisp.scale.set(scale, scale, 1);
      if (wisp.material instanceof THREE.MeshBasicMaterial) {
        wisp.material.opacity = Math.sin(cycle * Math.PI) * 0.16;
      }
    }
    return this.batchSamples.length > 1;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.abort.abort();
    this.scaleDisplayTexture.dispose();
    this.kettleBaseTexture.dispose();
    this.bedSurfaceTexture.dispose();
    this.host.dispose();
  }
}
