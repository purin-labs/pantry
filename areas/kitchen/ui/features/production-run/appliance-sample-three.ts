import * as THREE from "three";
import type {
  ApplianceFlexMesh,
  ApplianceSample,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";
import maruzenHobUrl from "../../../../../assets/bakery-mujoco/maruzen-mih-02c/maruzen-mih-02c.glb?url";
import vollrathHobUrl from "../../../../../assets/bakery-mujoco/vollrath-59500p/vollrath-59500p.glb?url";
import panasonicHobUrl from "../../../../../assets/bakery-mujoco/panasonic-kz-ck1402/panasonic-kz-ck1402.glb?url";
import rinnaiHobUrl from "../../../../../assets/bakery-mujoco/rinnai-rsb-150pj/rinnai-rsb-150pj.glb?url";
import type { InductionHob } from "./shared/induction-hob";

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

type Vec3 = readonly [number, number, number];

export function lerpVec3(a: Vec3, b: Vec3, u: number): Vec3 {
  const lerp = THREE.MathUtils.lerp;
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

/**
 * Plays the samples of one playback tick over `durationMs`: it shows the
 * interpolated sample at `now` and returns the batch that is still to play,
 * which is the last sample alone once the batch has played.
 */
export function playSampleBatch<Sample>(
  batch: readonly Sample[],
  startedAt: number,
  now: number,
  durationMs: number,
  interpolate: (first: Sample, next: Sample, u: number) => Sample,
  show: (sample: Sample) => void,
): readonly Sample[] {
  const alpha = Math.min(1, (now - startedAt) / durationMs);
  const scaled = alpha * (batch.length - 1);
  const index = Math.min(batch.length - 2, Math.floor(scaled));
  const first = batch[index];
  const next = batch[index + 1];
  if (first !== undefined && next !== undefined) {
    show(interpolate(first, next, scaled - index));
  }
  if (alpha < 1) {
    return batch;
  }
  const last = batch.at(-1);
  return last === undefined ? [] : [last];
}

type StudioLightOptions = Readonly<{
  sky?: number;
  ground?: number;
  hemi: number;
  key?: number;
  keyIntensity: number;
  keyAt: Vec3;
  /** The near and far planes of the key light's shadow camera. */
  shadow: readonly [near: number, far: number];
  /** The half width and half height of the key light's shadow camera. */
  shadowExtent: readonly [x: number, y: number];
  rim?: number;
  rimIntensity: number;
  rimAt: Vec3;
}>;

/**
 * The lights of a recipe scene: a sky light, a key light that casts the
 * shadows, and a cool rim light. The caller adds them to its scene.
 */
export function studioLights(
  options: StudioLightOptions,
): readonly [
  THREE.HemisphereLight,
  THREE.DirectionalLight,
  THREE.DirectionalLight,
] {
  const hemi = new THREE.HemisphereLight(
    options.sky ?? 0xfffcf5,
    options.ground ?? 0x6b6257,
    options.hemi,
  );
  const key = new THREE.DirectionalLight(
    options.key ?? 0xfff8ed,
    options.keyIntensity,
  );
  key.position.set(...options.keyAt);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = options.shadow[0];
  key.shadow.camera.far = options.shadow[1];
  key.shadow.camera.left = -options.shadowExtent[0];
  key.shadow.camera.right = options.shadowExtent[0];
  key.shadow.camera.top = options.shadowExtent[1];
  key.shadow.camera.bottom = -options.shadowExtent[1];
  key.shadow.bias = -0.0004;
  const rim = new THREE.DirectionalLight(
    options.rim ?? 0xdce8f5,
    options.rimIntensity,
  );
  rim.position.set(...options.rimAt);
  return [hemi, key, rim];
}

/** The lights of a dark FR10 workcell scene, added to the scene. */
export function addWorkcellLights(
  scene: THREE.Scene,
  shadowExtent: number,
): void {
  scene.add(
    ...studioLights({
      sky: 0xfff6ea,
      ground: 0x26221e,
      hemi: 0.68,
      key: 0xfff3e2,
      keyIntensity: 2.2,
      keyAt: [0.95, 1.85, 1.35],
      shadow: [0.2, 4.5],
      shadowExtent: [shadowExtent, shadowExtent],
      rim: 0xdce8f8,
      rimIntensity: 0.78,
      rimAt: [-1.1, 1.1, 0.9],
    }),
  );
}

/** The steel bench and the dark floor of a dark FR10 workcell scene. */
export function addWorkcellBench(
  scene: THREE.Scene,
  bench: Readonly<{ width: number; x: number; floor: number }>,
): void {
  const benchTop = new THREE.Mesh(
    new THREE.BoxGeometry(bench.width, 0.036, 0.96),
    new THREE.MeshStandardMaterial({
      color: 0xc8cfd6,
      metalness: 0.78,
      roughness: 0.26,
    }),
  );
  benchTop.position.set(bench.x, -0.018, 0.04);
  benchTop.receiveShadow = true;
  scene.add(benchTop);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(bench.floor, bench.floor),
    new THREE.MeshStandardMaterial({
      color: 0x1c1a18,
      roughness: 0.85,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.82;
  floor.receiveShadow = true;
  scene.add(floor);
}

/** The floor and its grid under a light Z-up recipe scene. */
export function studioFloor(
  size: number,
  grid: readonly [size: number, divisions: number],
): readonly [THREE.Mesh, THREE.GridHelper] {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({
      color: 0xc9c3b8,
      roughness: 0.88,
      metalness: 0.02,
    }),
  );
  floor.position.z = -0.78;
  floor.receiveShadow = true;

  const lines = new THREE.GridHelper(grid[0], grid[1], 0x9e978b, 0xbab3a7);
  lines.rotation.x = Math.PI / 2;
  lines.position.z = -0.779;
  return [floor, lines];
}

type PatisserieBenchOptions = Readonly<{
  floor: number;
  grid: readonly [size: number, divisions: number];
  /** The centre of the top and the shelf, in Z-up metres. */
  centre: readonly [x: number, y: number];
  top: readonly [width: number, depth: number];
  shelf: readonly [width: number, depth: number];
  legRadius: number;
  legs: readonly (readonly [x: number, y: number])[];
  /** The robot base: the pedestal stands under it. */
  robotBase: Vec3;
  /** More parts of the bench; they can share the leg material. */
  extras?: (legMat: THREE.MeshStandardMaterial) => readonly THREE.Object3D[];
}>;

/**
 * The stainless patisserie worktable of a Z-up recipe scene: the floor, the
 * top, the under shelf, the legs and the cobot pedestal, added to `root`.
 */
export function addPatisserieBench(
  root: THREE.Object3D,
  options: PatisserieBenchOptions,
): void {
  const [floor, grid] = studioFloor(options.floor, options.grid);
  const [cx, cy] = options.centre;

  const tableTop = new THREE.Mesh(
    new THREE.BoxGeometry(options.top[0], options.top[1], 0.038),
    new THREE.MeshStandardMaterial({
      color: 0xd4dbe2,
      roughness: 0.26,
      metalness: 0.78,
    }),
  );
  tableTop.position.set(cx, cy, -0.019);
  tableTop.castShadow = true;
  tableTop.receiveShadow = true;

  const underShelf = new THREE.Mesh(
    new THREE.BoxGeometry(options.shelf[0], options.shelf[1], 0.024),
    new THREE.MeshStandardMaterial({
      color: 0xbec7cf,
      roughness: 0.34,
      metalness: 0.72,
    }),
  );
  underShelf.position.set(cx, cy, -0.52);
  underShelf.receiveShadow = true;

  const legGeo = new THREE.CylinderGeometry(
    options.legRadius,
    options.legRadius,
    0.74,
    16,
  );
  legGeo.rotateX(Math.PI / 2);
  const legMat = new THREE.MeshStandardMaterial({
    color: 0xb8c2ca,
    roughness: 0.3,
    metalness: 0.8,
  });
  for (const [lx, ly] of options.legs) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(lx, ly, -0.41);
    leg.castShadow = true;
    root.add(leg);
  }

  const robotPedestal = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.28, 0.76),
    new THREE.MeshStandardMaterial({
      color: 0x394149,
      roughness: 0.45,
      metalness: 0.55,
    }),
  );
  robotPedestal.position.set(options.robotBase[0], options.robotBase[1], -0.4);
  robotPedestal.castShadow = true;
  robotPedestal.receiveShadow = true;

  root.add(
    floor,
    grid,
    tableTop,
    underShelf,
    robotPedestal,
    ...(options.extras?.(legMat) ?? []),
  );
}

/**
 * The walnut barista counter of the espresso and latte scenes: its top and
 * its steel front trim. The four legs go into `root`.
 */
export function baristaCounter(
  root: THREE.Object3D,
): readonly [THREE.Mesh, THREE.Mesh] {
  const counterTop = new THREE.Mesh(
    new THREE.BoxGeometry(0.96, 0.84, 0.036),
    new THREE.MeshStandardMaterial({
      color: 0xa87648,
      roughness: 0.46,
      metalness: 0.04,
    }),
  );
  counterTop.position.set(0.02, -0.08, -0.018);
  counterTop.castShadow = true;
  counterTop.receiveShadow = true;

  const frontTrim = new THREE.Mesh(
    new THREE.BoxGeometry(0.964, 0.012, 0.038),
    new THREE.MeshStandardMaterial({
      color: 0xd0d7de,
      roughness: 0.24,
      metalness: 0.82,
    }),
  );
  frontTrim.position.set(0.02, -0.502, -0.018);

  const legMat = new THREE.MeshStandardMaterial({
    color: 0x2a2e33,
    roughness: 0.5,
    metalness: 0.45,
  });
  for (const [lx, ly] of [
    [-0.42, -0.46],
    [0.46, -0.46],
    [-0.42, 0.28],
    [0.46, 0.28],
  ] as const) {
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(0.048, 0.048, 0.744),
      legMat,
    );
    leg.position.set(lx, ly, -0.408);
    leg.castShadow = true;
    leg.receiveShadow = true;
    root.add(leg);
  }
  return [counterTop, frontTrim];
}

/** The GLB of an induction hob model. */
export function inductionHobUrl(hob: InductionHob): string {
  return hob === "maruzen"
    ? maruzenHobUrl
    : hob === "vollrath"
      ? vollrathHobUrl
      : hob === "rinnai-rsb-150pj"
        ? rinnaiHobUrl
        : panasonicHobUrl;
}

/** The glow of the induction coil, on the hob top at `x`. */
export function inductionCoilGlow(
  x: number,
  hob: InductionHob,
): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const glow = new THREE.Mesh(
    new THREE.RingGeometry(0.036, 0.082, 48),
    new THREE.MeshBasicMaterial({
      color: 0xff5a1f,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.0,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(
    x,
    hob === "maruzen"
      ? 0.122
      : hob === "vollrath"
        ? 0.084
        : hob === "rinnai-rsb-150pj"
          ? 0.1065
          : 0.0545,
    0.18,
  );
  return glow;
}

/** The weighing pan of the Ohaus Ranger 3000 visual: it sinks under its load. */
export class ScalePan {
  private node: THREE.Object3D | null = null;
  private baseY = 0;

  bind(scale: THREE.Object3D): void {
    this.node = scale.getObjectByName("ranger_weighing_pan") ?? null;
    if (this.node) {
      this.baseY = this.node.position.y;
    }
  }

  deflect(deflectionM: number): void {
    if (this.node) {
      this.node.position.y = this.baseY - deflectionM;
    }
  }
}
