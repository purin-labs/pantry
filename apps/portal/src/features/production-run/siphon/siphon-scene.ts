import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ROBOTS } from "@seams/bakery-model/bakery-robots";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { SceneHost } from "../scene-host";
import type { StationPose } from "@seams/production-simulation/recipes/pour-over/sample";
import type { SiphonBody, SiphonSample, SiphonSetup } from "@seams/production-simulation/recipes/siphon/model";

export type SiphonCameraPreset = "bench" | "chambers" | "overhead";

const CAMERA_PRESETS: Readonly<
  Record<
    SiphonCameraPreset,
    Readonly<{
      position: readonly [number, number, number];
      target: readonly [number, number, number];
    }>
  >
> = {
  bench: {
    position: [2.05, 1.56, 0.96],
    target: [0.38, 1.04, -0.02],
  },
  chambers: {
    position: [1.08, 0.98, 0.35],
    target: [0.62, 0.91, -0.14],
  },
  overhead: {
    position: [0.62, 1.72, -0.04],
    target: [0.62, 1.02, -0.14],
  },
};

const BODIES: readonly SiphonBody[] = [
  "si_lower_bowl",
  "si_upper_bowl",
  "si_paddle",
  "po_gripper",
  "po_finger_left",
  "po_finger_right",
];

const UPPER_RADIUS_M = 0.0418;
const INTERPOLATION_MS = 55;

/**
 * Exact inner radius (m) of the Hario BU-ECA-3 cylindrical upper glass bowl as a function of local z (m).
 * Ensures the glass lathe wall, coffee slurry, floating crust, and crema disc match to < 0.5 mm.
 */
function upperInnerRadiusAtZ(z: number): number {
  if (z <= 0.015) return 0.0038;
  if (z <= 0.021) {
    const u = (z - 0.015) / 0.006;
    return THREE.MathUtils.lerp(0.0038, 0.0165, u * u);
  }
  if (z <= 0.039) {
    const u = (z - 0.021) / 0.018;
    const easeOut = Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
    return THREE.MathUtils.lerp(0.0165, UPPER_RADIUS_M, easeOut);
  }
  if (z <= 0.107) {
    return UPPER_RADIUS_M;
  }
  const u = Math.min(1, (z - 0.107) / 0.005);
  return THREE.MathUtils.lerp(UPPER_RADIUS_M, 0.0426, u * u);
}

/**
 * Exact inner radius (m) of the Hario BL-ECA-3 flat-bottomed conical lower glass server
 * as a function of local z (m).
 */
function lowerInnerRadiusAtZ(z: number): number {
  if (z <= 0.0036) return 0.0395;
  if (z <= 0.015) {
    const u = (z - 0.0036) / 0.0114;
    const s = Math.sin((u * Math.PI) / 2);
    return THREE.MathUtils.lerp(0.0395, 0.0546, s);
  }
  if (z <= 0.064) {
    const u = (z - 0.015) / 0.049;
    return THREE.MathUtils.lerp(0.0546, 0.0362, u);
  }
  if (z <= 0.074) {
    const u = (z - 0.064) / 0.01;
    const s = u * u * (3 - 2 * u);
    return THREE.MathUtils.lerp(0.0362, 0.019, s);
  }
  if (z <= 0.09) {
    return 0.019;
  }
  const u = Math.min(1, (z - 0.09) / 0.008);
  return THREE.MathUtils.lerp(0.019, 0.0244, u * u);
}

/**
 * Builds a closed LatheGeometry conforming to the inner wall of the BU-ECA-3
 * cylindrical upper glass bowl between `zBottom` and `zTop`.
 */
function buildUpperChamberLatheGeometry(
  zBottom: number,
  zTop: number,
  radialInset = 0.0005,
): THREE.BufferGeometry {
  const z0 = Math.max(0.022, zBottom);
  const z1 = Math.max(z0 + 0.0015, Math.min(0.109, zTop));
  const steps = 20;
  const profile: THREE.Vector2[] = [new THREE.Vector2(0.0001, z0)];
  for (let i = 0; i <= steps; i++) {
    const z = z0 + ((z1 - z0) * i) / steps;
    const r = Math.max(0.001, upperInnerRadiusAtZ(z) - radialInset);
    profile.push(new THREE.Vector2(r, z));
  }
  profile.push(new THREE.Vector2(0.0001, z1));
  return new THREE.LatheGeometry(profile, 48).rotateX(Math.PI / 2);
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
  first: SiphonSample,
  next: SiphonSample,
  alpha: number,
): SiphonSample {
  if (alpha <= 0) return first;
  if (alpha >= 1) return next;
  const lerp = THREE.MathUtils.lerp;
  return {
    ...next,
    timeS: lerp(first.timeS, next.timeS, alpha),
    joints: next.joints.map((angle, index) =>
      lerp(first.joints[index] ?? angle, angle, alpha),
    ),
    fingers: [
      lerp(first.fingers[0], next.fingers[0], alpha),
      lerp(first.fingers[1], next.fingers[1], alpha),
    ],
    gripper: interpolatePose(first.gripper, next.gripper, alpha),
    lowerBowl: interpolatePose(first.lowerBowl, next.lowerBowl, alpha),
    upperBowl: interpolatePose(first.upperBowl, next.upperBowl, alpha),
    paddle: interpolatePose(first.paddle, next.paddle, alpha),
    heater: {
      ...next.heater,
      powerW: lerp(first.heater.powerW, next.heater.powerW, alpha),
      radiativeW: lerp(first.heater.radiativeW, next.heater.radiativeW, alpha),
      glow: lerp(first.heater.glow, next.heater.glow, alpha),
    },
    thermo: {
      ...next.thermo,
      lowerC: lerp(first.thermo.lowerC, next.thermo.lowerC, alpha),
      upperC: lerp(first.thermo.upperC, next.thermo.upperC, alpha),
      pressureKPa: lerp(
        first.thermo.pressureKPa,
        next.thermo.pressureKPa,
        alpha,
      ),
      vaporPressureKPa: lerp(
        first.thermo.vaporPressureKPa,
        next.thermo.vaporPressureKPa,
        alpha,
      ),
      vacuumKPa: lerp(first.thermo.vacuumKPa, next.thermo.vacuumKPa, alpha),
      bubbleRate: lerp(first.thermo.bubbleRate, next.thermo.bubbleRate, alpha),
      swirlRadS: lerp(first.thermo.swirlRadS, next.thermo.swirlRadS, alpha),
    },
    extraction: {
      ...next.extraction,
      wettingFraction: lerp(
        first.extraction.wettingFraction,
        next.extraction.wettingFraction,
        alpha,
      ),
      tdsPct: lerp(first.extraction.tdsPct, next.extraction.tdsPct, alpha),
      extractionYieldPct: lerp(
        first.extraction.extractionYieldPct,
        next.extraction.extractionYieldPct,
        alpha,
      ),
      co2FoamMm: lerp(
        first.extraction.co2FoamMm,
        next.extraction.co2FoamMm,
        alpha,
      ),
      crustBuoyancy: lerp(
        first.extraction.crustBuoyancy,
        next.extraction.crustBuoyancy,
        alpha,
      ),
    },
    water: {
      ...next.water,
      lowerG: lerp(first.water.lowerG, next.water.lowerG, alpha),
      stemG: lerp(first.water.stemG, next.water.stemG, alpha),
      upperFreeG: lerp(first.water.upperFreeG, next.water.upperFreeG, alpha),
      absorbedG: lerp(first.water.absorbedG, next.water.absorbedG, alpha),
      beverageG: lerp(first.water.beverageG, next.water.beverageG, alpha),
      evaporatedG: lerp(first.water.evaporatedG, next.water.evaporatedG, alpha),
      flowGS: lerp(first.water.flowGS, next.water.flowGS, alpha),
      domeHeightM: lerp(first.water.domeHeightM, next.water.domeHeightM, alpha),
    },
  };
}

function enableShadows(object: THREE.Object3D, cast = true, receive = true) {
  object.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.castShadow = cast;
      node.receiveShadow = receive;
    }
  });
}

/**
 * Beer-Lambert optical absorption color for coffee extract as a function of TDS (%).
 * Transitions smoothly from clear hot water (0% TDS) -> honey gold -> garnet amber -> deep mahogany (1.42% TDS).
 */
function beerLambertCoffeeColor(tdsPct: number): THREE.Color {
  const u = Math.max(0, Math.min(1, tdsPct / 1.42));
  const water = new THREE.Color(0xd8eff8);
  const gold = new THREE.Color(0xd88c3a);
  const garnet = new THREE.Color(0x7c2a0a);
  const mahogany = new THREE.Color(0x1b0802);
  if (u < 0.2) {
    return water.lerp(gold, u / 0.2);
  }
  if (u < 0.56) {
    return gold.lerp(garnet, (u - 0.2) / 0.36);
  }
  return garnet.lerp(mahogany, (u - 0.56) / 0.44);
}

/**
 * Full-width sculpted LatheGeometry for the domed coffee grounds bed inside BU-ECA-3.
 * Spans the entire bottom inner wall above the F-103S cloth filter (`r = 0.0394 m`)
 * and rises into a smooth catenary dome (`h = 0.020 m` at unit Z scale) around the center post.
 */
function buildSpentCoffeeDomeGeometry(): THREE.BufferGeometry {
  const zBase = 0.0285;
  const maxH = 0.02;
  const rOuter = Math.max(0.036, upperInnerRadiusAtZ(0.034) - 0.0005);
  const steps = 24;
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0002, 0),
    new THREE.Vector2(rOuter * 0.92, 0),
    new THREE.Vector2(rOuter, 0.0035),
  ];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps; // 0 at outer wall -> 1 at center post
    const r = THREE.MathUtils.lerp(rOuter, 0.0002, u);
    const radialNorm = r / rOuter;
    const h =
      0.0035 +
      (maxH - 0.0035) * Math.pow(Math.max(0, 1 - radialNorm * radialNorm), 0.78);
    const wallR = upperInnerRadiusAtZ(zBase + h) - 0.0005;
    profile.push(new THREE.Vector2(Math.min(r, wallR), h));
  }
  return new THREE.LatheGeometry(profile, 48).rotateX(Math.PI / 2);
}

/** Granular wet dark-roast coffee grounds texture for the floating crust and domed filter bed. */
function createCoffeeGroundsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const grad = ctx.createRadialGradient(128, 128, 12, 128, 128, 128);
    grad.addColorStop(0, "#331709");
    grad.addColorStop(0.65, "#421f0d");
    grad.addColorStop(1, "#2a1206");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    const palette = ["#1c0b03", "#2b1307", "#4c2410", "#613118", "#381a0b"];
    for (let i = 0; i < 1800; i++) {
      const x = (i * 73 + (i * i * 19) % 251) % 256;
      const y = (i * 137 + (i * 31) % 241) % 256;
      const r = 1 + (i % 3) * 0.7;
      ctx.fillStyle = palette[i % palette.length]!;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

/**
 * Exact LatheGeometry for liquid inside the BL-ECA-3 flat-bottomed conical glass server.
 * Conforms to the inner conical carafe wall from `z0 = 0.0038 m` up to `zTop`.
 */
function buildLowerConicalLiquidGeometry(zTop: number): THREE.BufferGeometry {
  const z0 = 0.0038;
  const z1 = Math.max(z0 + 0.003, Math.min(0.068, zTop));
  const profile: THREE.Vector2[] = [new THREE.Vector2(0.0001, z0)];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const z = z0 + ((z1 - z0) * i) / steps;
    const r = Math.max(0.001, lowerInnerRadiusAtZ(z) - 0.0004);
    profile.push(new THREE.Vector2(r, z));
  }
  profile.push(new THREE.Vector2(0.0001, z1));
  return new THREE.LatheGeometry(profile, 48).rotateX(Math.PI / 2);
}

/**
 * Official Hario BL-ECA-3 front white enamel markings (`eca-3-b-0.jpg` & `eca-3-b-5.jpg`):
 * - `• 3 MAX` level dot & label at top
 * - `HARIO / ECA-3 / MADE IN JAPAN` wordmark stack in the middle
 * - `• 2 MIN` level dot & label at bottom
 */
function createLowerBulbMarkingsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";

    // Top level dot + "3 MAX"
    ctx.beginPath();
    ctx.arc(196, 98, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.font = "700 32px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("3", 214, 109);
    ctx.font = "600 22px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("MAX", 242, 108);

    // Center HARIO / ECA-3 / MADE IN JAPAN stack
    ctx.textAlign = "center";
    ctx.font = "800 44px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("HARIO", 256, 212);
    ctx.font = "600 26px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("ECA-3", 256, 252);
    ctx.font = "600 18px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("MADE IN JAPAN", 256, 282);

    // Bottom level dot + "2 MIN"
    ctx.beginPath();
    ctx.arc(196, 378, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.font = "700 32px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("2", 214, 389);
    ctx.font = "600 22px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("MIN", 242, 388);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Subtle white enamel Japanese caution block on the left flank of BL-ECA-3 (`eca-3-b-5.jpg`). */
function createLowerCautionMarkingsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.58)";
    ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(56, 38, 144, 34);
    ctx.textAlign = "center";
    ctx.font = "700 18px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("やけど注意", 128, 61);
    ctx.font = "500 14px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("耐熱ガラス製 · 空だき禁止", 128, 102);
    ctx.fillText("加熱中は器具に触れないで", 128, 130);
    ctx.fillText("ください · HARIO株式会社", 128, 158);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** White enamel `HARIO / ECA-3 / MADE IN JAPAN` print on the BU-ECA-3 upper glass bowl. */
function createUpperBowlMarkingsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.clearRect(0, 0, 256, 192);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.textAlign = "center";
    ctx.font = "800 34px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("HARIO", 128, 68);
    ctx.font = "600 22px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("ECA-3", 128, 102);
    ctx.font = "600 15px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText("MADE IN JAPAN", 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Screen-printed white crescent dial scale (`off` — `mid` — `max`) and bottom `HARIO`
 * wordmark on the front face of the Hario ECA-3-B conical electric heater base (`eca-3-b-0.jpg`).
 */
function createEcaHeaterFrontTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 384;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.clearRect(0, 0, 512, 384);
    const cx = 256;
    const cy = 196;

    // Crescent-shaped white scale arc from 9 o'clock (off) over 12 o'clock (mid) to 3 o'clock (max)
    // that gradually thickens toward `max` just like `eca-3-b-0.jpg`.
    ctx.fillStyle = "rgba(226, 230, 235, 0.88)";
    ctx.beginPath();
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const a = Math.PI + u * Math.PI; // PI (left) -> 2*PI (right) over top
      const rInner = 84;
      const x = cx + Math.cos(a) * rInner;
      const y = cy + Math.sin(a) * rInner;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i--) {
      const u = i / steps;
      const a = Math.PI + u * Math.PI;
      const rOuter = 86.5 + u * 8.5;
      const x = cx + Math.cos(a) * rOuter;
      const y = cy + Math.sin(a) * rOuter;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // Scale labels: `off` (9 o'clock), `mid` (12 o'clock), `max` (3 o'clock).
    ctx.fillStyle = "rgba(232, 236, 240, 0.92)";
    ctx.font = "500 24px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("off", cx - 96, cy + 8);
    ctx.textAlign = "center";
    ctx.fillText("mid", cx, cy - 102);
    ctx.textAlign = "left";
    ctx.fillText("max", cx + 102, cy + 8);

    // Bottom center HARIO wordmark.
    ctx.textAlign = "center";
    ctx.font = "800 32px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "rgba(235, 239, 244, 0.9)";
    ctx.fillText("HARIO", cx, 336);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBambooGrainTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const base = ctx.createLinearGradient(0, 0, 256, 0);
    base.addColorStop(0, "#be8f50");
    base.addColorStop(0.35, "#d4a96a");
    base.addColorStop(0.68, "#c99b5b");
    base.addColorStop(1, "#b58546");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 256, 512);

    // Longitudinal vascular bamboo fibers.
    for (let x = 2; x < 256; x += 4) {
      const alpha = 0.05 + ((x * 17) % 10) * 0.012;
      ctx.fillStyle = x % 8 === 0 ? `rgba(110, 72, 28, ${alpha})` : `rgba(245, 216, 168, ${alpha})`;
      ctx.fillRect(x, 0, 2, 512);
    }

    // Two characteristic horizontal bamboo culm nodes.
    for (const ny of [148, 366] as const) {
      const nodeGrad = ctx.createLinearGradient(0, ny - 8, 0, ny + 8);
      nodeGrad.addColorStop(0, "rgba(120, 78, 32, 0)");
      nodeGrad.addColorStop(0.45, "rgba(96, 60, 22, 0.42)");
      nodeGrad.addColorStop(0.6, "rgba(238, 206, 152, 0.35)");
      nodeGrad.addColorStop(1, "rgba(120, 78, 32, 0)");
      ctx.fillStyle = nodeGrad;
      ctx.fillRect(0, ny - 8, 256, 16);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBorosilicateGlassMaterial(opacity = 0.38): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xf4fbff,
    roughness: 0.035,
    metalness: 0.0,
    transmission: 0.84,
    ior: 1.474,
    thickness: 0.0045,
    attenuationColor: new THREE.Color(0xdff2f9),
    attenuationDistance: 0.16,
    reflectivity: 0.94,
    clearcoat: 1.0,
    clearcoatRoughness: 0.025,
    envMapIntensity: 1.55,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/**
 * Interactive 3D scene for the Hario ECA-3-B Electric Coffee Syphon (360 mL),
 * F-103S cloth filter, BA-15 bamboo paddle, and FAIRINO FR10 arm.
 */
export class SiphonScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  private readonly root = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly bodies = new Map<SiphonBody, THREE.Group>();

  private readonly heaterElementMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b1208,
    emissive: 0xff4800,
    emissiveIntensity: 0.4,
    roughness: 0.22,
    metalness: 0.12,
  });
  private readonly heaterHaloMaterial = new THREE.MeshStandardMaterial({
    color: 0xff3b14,
    emissive: 0xff2a00,
    emissiveIntensity: 0.85,
    roughness: 0.2,
  });
  private readonly heaterDialPivot = new THREE.Group();
  private readonly heaterLight = new THREE.PointLight(0xff5a14, 0.6, 0.38, 1.6);
  private readonly heaterDisplayCanvas = document.createElement("canvas");
  private readonly heaterDisplayTexture: THREE.CanvasTexture;
  private heaterDisplayKey = "";

  private readonly lowerLiquidMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd8eff8,
    roughness: 0.05,
    metalness: 0.01,
    clearcoat: 0.85,
    clearcoatRoughness: 0.04,
    transparent: true,
    opacity: 0.52,
  });
  private readonly lowerLiquid = new THREE.Mesh(
    new THREE.BufferGeometry(),
    this.lowerLiquidMaterial,
  );
  private lowerCapKey = "";

  private readonly lowerMeniscusRing = new THREE.Mesh(
    new THREE.RingGeometry(0.84, 1.0, 48),
    new THREE.MeshBasicMaterial({
      color: 0xdcf4ff,
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide,
    }),
  );

  private readonly lowerStemFoamRing = new THREE.Mesh(
    new THREE.RingGeometry(0.0044, 0.0145, 36),
    new THREE.MeshBasicMaterial({
      color: 0xd49452,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    }),
  );

  private readonly drawdownStream = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0024, 0.0068, 1, 24).rotateX(Math.PI / 2),
    new THREE.MeshPhysicalMaterial({
      color: 0x260c03,
      roughness: 0.08,
      clearcoat: 0.85,
      transparent: true,
      opacity: 0.9,
    }),
  );

  private readonly stemLiquidMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd8eff8,
    roughness: 0.06,
    clearcoat: 0.8,
    transparent: true,
    opacity: 0.88,
  });
  private readonly stemLiquid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0038, 0.0036, 1, 24).rotateX(Math.PI / 2),
    this.stemLiquidMaterial,
  );

  private readonly upperLiquidMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd8eff8,
    roughness: 0.1,
    metalness: 0.02,
    clearcoat: 0.72,
    transparent: true,
    opacity: 0.93,
  });
  private readonly upperLiquid = new THREE.Mesh(
    new THREE.BufferGeometry(),
    this.upperLiquidMaterial,
  );
  private upperLiquidKey = "";

  private readonly groundsTexture = createCoffeeGroundsTexture();

  /** Buoyant coffee grounds crust layer (3-layer stratification during steep). */
  private readonly crustLayer = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      map: this.groundsTexture,
      color: 0x5c3018,
      roughness: 0.82,
      metalness: 0.02,
    }),
  );
  private crustLayerKey = "";

  private readonly slurryCanvas = document.createElement("canvas");
  private readonly slurryTexture: THREE.CanvasTexture;
  private readonly slurryDiscGeometry = new THREE.RingGeometry(
    0.0039,
    1.0,
    56,
    12,
  );
  private readonly slurryDisc: THREE.Mesh;
  private swirlAngle = 0;

  private readonly spentDome = new THREE.Mesh(
    buildSpentCoffeeDomeGeometry(),
    new THREE.MeshStandardMaterial({
      map: this.groundsTexture,
      color: 0x542b14,
      roughness: 0.84,
      metalness: 0.02,
    }),
  );

  private readonly bubbles: readonly THREE.Mesh[];
  private readonly steamWisps: readonly THREE.Mesh[];

  private pivots: Readonly<{ object: THREE.Object3D; axis: THREE.Vector3 }>[] =
    [];
  private readonly orbit: OrbitControls;
  private readonly abort = new AbortController();
  private batchSamples: readonly SiphonSample[] = [];
  private displayedFrame: SiphonSample | null = null;
  private transitionStartedAt = 0;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(
    view: HTMLElement,
    private readonly setup: SiphonSetup,
  ) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      look: { exposure: 0.9, background: 0xddd7ce, environmentIntensity: 0.45 },
      pointer: "pan",
      size: { minHeight: 560 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;
    this.orbit = this.host.orbit;

    const hemi = new THREE.HemisphereLight(0xfffcf5, 0x6b6257, 1.15);
    const keyLight = new THREE.DirectionalLight(0xfff8ed, 1.85);
    keyLight.position.set(1.45, 2.65, 1.75);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.4;
    keyLight.shadow.camera.far = 6.5;
    keyLight.shadow.camera.left = -1.2;
    keyLight.shadow.camera.right = 1.2;
    keyLight.shadow.camera.top = 1.2;
    keyLight.shadow.camera.bottom = -1.2;
    keyLight.shadow.bias = -0.0004;
    const rimLight = new THREE.DirectionalLight(0xdce8f5, 0.68);
    rimLight.position.set(-1.5, 1.85, -1.2);
    this.scene.add(hemi, keyLight, rimLight, this.root);

    this.heaterDisplayCanvas.width = 256;
    this.heaterDisplayCanvas.height = 72;
    this.heaterDisplayTexture = new THREE.CanvasTexture(
      this.heaterDisplayCanvas,
    );
    this.heaterDisplayTexture.colorSpace = THREE.SRGBColorSpace;

    this.slurryCanvas.width = 192;
    this.slurryCanvas.height = 192;
    this.slurryTexture = new THREE.CanvasTexture(this.slurryCanvas);
    this.slurryTexture.colorSpace = THREE.SRGBColorSpace;
    this.paintSlurryTexture(0, 0, 0);
    this.slurryDisc = new THREE.Mesh(
      this.slurryDiscGeometry,
      new THREE.MeshStandardMaterial({
        map: this.slurryTexture,
        roughness: 0.34,
        metalness: 0.03,
        side: THREE.DoubleSide,
      }),
    );

    const bubbleMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.04,
      transmission: 0.72,
      transparent: true,
      opacity: 0.82,
    });
    this.bubbles = Array.from({ length: 16 }, (_, index) => {
      const radius = 0.0017 + (index % 4) * 0.00065;
      return new THREE.Mesh(
        new THREE.SphereGeometry(radius, 12, 10),
        bubbleMat,
      );
    });

    this.steamWisps = [0, 1, 2].map(
      () =>
        new THREE.Mesh(
          new THREE.RingGeometry(0.008, 0.024, 28),
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
    this.buildBeamHeater();
    this.buildLowerBowlAndStand();
    this.buildUpperBowlAndFilter();
    this.buildBambooPaddle();

    this.drawdownStream.visible = false;
    this.bodies
      .get("si_lower_bowl")
      ?.add(
        this.lowerLiquid,
        this.lowerMeniscusRing,
        this.lowerStemFoamRing,
        this.drawdownStream,
      );
    this.bodies
      .get("si_upper_bowl")
      ?.add(
        this.stemLiquid,
        this.upperLiquid,
        this.crustLayer,
        this.slurryDisc,
        this.spentDome,
        ...this.bubbles,
        ...this.steamWisps,
      );

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
        color: 0xc8c2b7,
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

  private addGeometry(item: SiphonSetup["geometry"][number]): void {
    // Gripper and fingers use sculpted industrial meshes in buildParallelGripper().
    if (
      item.body === "po_gripper" ||
      item.body === "po_finger_left" ||
      item.body === "po_finger_right"
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
    if (item.name === "si_bench_top") {
      material = new THREE.MeshStandardMaterial({
        color: 0xb27e4f,
        roughness: 0.46,
        metalness: 0.04,
      });
    } else if (item.name.startsWith("si_bench_leg_")) {
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
        metalness: 0.22,
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
   * - ISO 9409-1-50-4-M6 Robot/Tool Quick Changer with locking cam pins, status LED ring,
   *   pneumatic/I/O pass-through manifold, and coiled polyurethane M8 umbilical cable
   * - Chamfered CNC gunmetal & brushed-titanium servo actuator body with recessed side plates
   * - Hardened steel linear guide rail with optical encoder strip and bearing trucks
   * - Dual-contour CNC truss fingers with concave R=44mm silicone vessel-cradle jaws
   *   and a central V-prism notch for the R=8.5mm BA-15 bamboo paddle collar
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

    // 1. ISO 9409-1-50-4-M6 Quick Tool Changer (x = 0.000..0.026 m).
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

    // 8 radial M6 socket cap screws + twin brass cam-lock pins on the tool changer.
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

    // Pneumatic / electrical pass-through manifold block on top (+Z) + curved M8 I/O umbilical cable.
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

    // 2. Chamfered CNC Servo Actuator Housing (x = 0.025..0.061 m, width 104 mm, height 58 mm).
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

    // Brushed titanium recessed side cover plates (+Z and -Z faces) with corner M4 socket bolts.
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

    // Slate-teal anodized side accent bumpers (+/-Y flanks of actuator housing).
    for (const signY of [-1, 1] as const) {
      const bumper = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.004, 0.042),
        slateTealMat,
      );
      bumper.position.set(0.043, signY * 0.049, 0);
      gripper.add(bumper);
    }

    // 3. Precision Hardened Linear Master Guide Rail (x = 0.061..0.070 m, width 106 mm).
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

    // 4. Dual-Contour Barista Finger Jaws (`po_finger_left` and `po_finger_right`).
    //    Each finger combines:
    //    - A linear bearing carriage truck on the guide rail (x = 0.067..0.082 m)
    //    - A CNC-machined structural aluminum truss arm with lightening holes (x = 0.076..0.148 m)
    //    - A concave R = 43.8 mm silicone vessel-cradle pad (x = 0.108..0.150 m) that wraps
    //      around the Hario TCA-3 glass funnel AND features a central V-prism notch (x = 0.130 m)
    //      that locks around the r = 8.5 mm BA-15 bamboo paddle collar.
    for (const [fingerGroup, sign] of [
      [leftFinger, 1],
      [rightFinger, -1],
    ] as const) {
      // Bearing carriage block with scraper seals and 4 mounting bolts.
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

      // Helper for the concave vessel cradle inner profile y_local(x).
      // At opening = 0.0355 m, finger origin is at |y| = 0.0495 m, so a circle of R = 0.0439 m
      // centered at (0.130, 0) lies at y_local = -sign * (0.0495 - sqrt(R^2 - dx^2)).
      const cradleInnerY = (x: number): number => {
        const dx = x - 0.13;
        const rBowl = 0.0439;
        const yCircle = Math.sqrt(Math.max(0.0004, rBowl * rBowl - dx * dx));
        // Add a subtle central V-prism seat around dx = 0 for the r = 8.5 mm paddle collar.
        const vNotch = Math.max(0, 0.001 - Math.abs(dx) * 0.22);
        const inward = 0.0495 - yCircle - vNotch;
        return -sign * inward;
      };

      // CNC Aluminum Finger Truss Arm (x = 0.076..0.150 m) backing the silicone cradle pad.
      const armShape = new THREE.Shape();
      const xSamples = 18;
      armShape.moveTo(0.076, sign * 0.013);
      armShape.lineTo(0.108, sign * 0.011);
      for (let i = 0; i <= xSamples; i++) {
        const x = 0.108 + (0.042 * i) / xSamples;
        armShape.lineTo(x, cradleInnerY(x) + sign * 0.0095);
      }
      for (let i = xSamples; i >= 0; i--) {
        const x = 0.108 + (0.042 * i) / xSamples;
        armShape.lineTo(x, cradleInnerY(x) + sign * 0.0035);
      }
      armShape.lineTo(0.076, -sign * 0.001);
      armShape.closePath();

      // Two machined circular truss lightening holes in the proximal finger web.
      for (const [hx, hy, hr] of [
        [0.088, sign * 0.006, 0.0032],
        [0.1, sign * 0.0055, 0.0028],
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

      // Upper and lower structural flange ribs along the CNC finger arm.
      const flangeGeo = new THREE.ExtrudeGeometry(armShape, {
        depth: 0.004,
        bevelEnabled: false,
      });
      for (const rz of [-0.022, 0.018] as const) {
        const ribPlate = new THREE.Mesh(flangeGeo, slateTealMat);
        ribPlate.position.z = rz;
        fingerGroup.add(ribPlate);
      }

      // Contoured Multi-Radius Silicone Vessel Cradle & V-Notch Pad (x = 0.108..0.150 m).
      const padShape = new THREE.Shape();
      for (let i = 0; i <= xSamples; i++) {
        const x = 0.108 + (0.042 * i) / xSamples;
        const y = cradleInnerY(x) + sign * 0.0035;
        if (i === 0) padShape.moveTo(x, y);
        else padShape.lineTo(x, y);
      }
      for (let i = xSamples; i >= 0; i--) {
        const x = 0.108 + (0.042 * i) / xSamples;
        padShape.lineTo(x, cradleInnerY(x));
      }
      padShape.closePath();

      const padGeo = new THREE.ExtrudeGeometry(padShape, {
        depth: 0.044,
        bevelEnabled: true,
        bevelThickness: 0.001,
        bevelSize: 0.0008,
        bevelSegments: 3,
      });
      padGeo.translate(0, 0, -0.022);
      const siliconePad = new THREE.Mesh(padGeo, siliconePadMat);

      // 5 vertical micro-grip elastomer ribs along the concave cradle surface.
      for (const rx of [0.114, 0.123, 0.13, 0.137, 0.146] as const) {
        const rib = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.0013, 0.041, 8, 12).rotateX(Math.PI / 2),
          siliconePadMat,
        );
        rib.position.set(rx, cradleInnerY(rx) + sign * 0.0004, 0);
        fingerGroup.add(rib);
      }

      fingerGroup.add(carriage, carriageCap, jawArm, siliconePad);
      enableShadows(fingerGroup);
    }
  }

  /**
   * Hario ECA-3-B Electric Coffee Syphon heater base (Ø150 mm bottom -> Ø118 mm top, H 74 mm):
   * - Matte-black textured polypropylene conical frustum body on 4 stepped rubber feet
   * - Recessed brushed-aluminum heating plate with thermal contact ring
   * - Conformal front white crescent scale (`off` — `mid` — `max`) and bottom `HARIO` wordmark
   * - Left orange-red power pilot indicator lamp + central matte-black rotary pointer knob
   */
  private buildBeamHeater(): void {
    const heater = new THREE.Group();
    heater.position.set(0.62, 0.14, 0.8);

    const matteBlackBody = new THREE.MeshStandardMaterial({
      color: 0x1b1d21,
      roughness: 0.54,
      metalness: 0.08,
    });
    const darkRubber = new THREE.MeshStandardMaterial({
      color: 0x111316,
      roughness: 0.76,
      metalness: 0.04,
    });
    const brushedAluminumPlate = new THREE.MeshStandardMaterial({
      color: 0xd0d6dc,
      roughness: 0.24,
      metalness: 0.86,
    });
    const darkBezelMat = new THREE.MeshStandardMaterial({
      color: 0x14161a,
      roughness: 0.42,
      metalness: 0.16,
    });

    // 1. 4 stepped black rubber isolation feet (z = 0.000..0.006 m).
    for (const [fx, fy] of [
      [-0.046, -0.042],
      [0.046, -0.042],
      [-0.046, 0.042],
      [0.046, 0.042],
    ] as const) {
      const footPad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.009, 0.0035, 24).rotateX(
          Math.PI / 2,
        ),
        darkRubber,
      );
      footPad.position.set(fx, fy, 0.0018);
      const footBoss = new THREE.Mesh(
        new THREE.CylinderGeometry(0.013, 0.0115, 0.0035, 24).rotateX(
          Math.PI / 2,
        ),
        matteBlackBody,
      );
      footBoss.position.set(fx, fy, 0.0048);
      heater.add(footPad, footBoss);
    }

    // 2. Matte-black conical frustum housing (z = 0.0055..0.074 m, Ø150 mm bottom -> Ø118 mm top)
    //    with recessed top centering well (z = 0.0695 m, r = 0.0445 m) for the BL-ECA-3 glass base.
    const frustumProfile = [
      new THREE.Vector2(0.001, 0.0055),
      new THREE.Vector2(0.0725, 0.0055),
      new THREE.Vector2(0.075, 0.0075),
      new THREE.Vector2(0.059, 0.0715),
      new THREE.Vector2(0.0565, 0.074),
      new THREE.Vector2(0.0515, 0.074),
      new THREE.Vector2(0.0455, 0.0695),
      new THREE.Vector2(0.001, 0.0695),
    ];
    const frustumBody = new THREE.Mesh(
      new THREE.LatheGeometry(frustumProfile, 72).rotateX(Math.PI / 2),
      matteBlackBody,
    );

    // 3. Recessed brushed-aluminum electric heating plate (z = 0.0695..0.0705 m) + thermal glow ring.
    const heatingPlate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0445, 0.0445, 0.0014, 56).rotateX(
        Math.PI / 2,
      ),
      brushedAluminumPlate,
    );
    heatingPlate.position.z = 0.0698;

    const thermalGlowRing = new THREE.Mesh(
      new THREE.RingGeometry(0.022, 0.041, 48),
      this.heaterElementMaterial,
    );
    thermalGlowRing.position.z = 0.0706;

    this.heaterLight.position.set(0, 0, 0.082);

    // 4. Front control face on the -Y conical frustum slope (alpha = atan(0.016 / 0.064) = 0.24498 rad).
    const slopeAngle = Math.atan2(0.016, 0.064);
    const frontGroup = new THREE.Group();
    frontGroup.position.set(0, -0.06725, 0.038);
    frontGroup.rotation.x = Math.PI / 2 - slopeAngle;

    // Curved conformal decal mesh for `off` / `mid` / `max` crescent scale & `HARIO` wordmark.
    const decalGeo = new THREE.PlaneGeometry(0.086, 0.058, 32, 8);
    const decalPos = decalGeo.attributes.position;
    if (decalPos !== undefined) {
      for (let i = 0; i < decalPos.count; i++) {
        const vx = decalPos.getX(i);
        const vy = decalPos.getY(i);
        const rAtY = Math.max(0.055, 0.06725 - vy * Math.sin(slopeAngle));
        const sag = rAtY - Math.sqrt(Math.max(1e-5, rAtY * rAtY - vx * vx));
        decalPos.setZ(i, 0.0005 - sag / Math.cos(slopeAngle));
      }
      decalPos.needsUpdate = true;
    }
    const frontScaleDecal = new THREE.Mesh(
      decalGeo,
      new THREE.MeshBasicMaterial({
        map: createEcaHeaterFrontTexture(),
        transparent: true,
        depthWrite: false,
      }),
    );
    frontScaleDecal.position.y = 0.001;

    // Left recessed power pilot lamp (x = -0.033 m on front face, wraps with frustum curvature).
    const pilotGroup = new THREE.Group();
    pilotGroup.position.set(-0.033, -0.001, -0.0076);
    pilotGroup.rotation.y = -Math.asin(0.033 / 0.06725);
    const pilotBezel = new THREE.Mesh(
      new THREE.RingGeometry(0.0018, 0.0031, 24),
      darkBezelMat,
    );
    pilotBezel.position.z = 0.0003;
    const pilotLens = new THREE.Mesh(
      new THREE.SphereGeometry(0.0019, 16, 12),
      this.heaterHaloMaterial,
    );
    pilotLens.scale.set(1, 1, 0.55);
    pilotLens.position.z = 0.0004;
    pilotGroup.add(pilotBezel, pilotLens);

    // Central recessed dial bezel + rotating matte-black pointer knob (`this.heaterDialPivot`).
    const dialBezel = new THREE.Mesh(
      new THREE.TorusGeometry(0.0158, 0.0014, 14, 48),
      darkBezelMat,
    );
    dialBezel.position.set(0, -0.001, -0.0005);

    this.heaterDialPivot.position.set(0, -0.001, 0.0005);
    const knobBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0142, 0.015, 0.0085, 48).rotateX(
        Math.PI / 2,
      ),
      matteBlackBody,
    );
    knobBody.position.z = 0.0042;

    const knobFace = new THREE.Mesh(
      new THREE.CylinderGeometry(0.013, 0.013, 0.001, 48).rotateX(Math.PI / 2),
      darkBezelMat,
    );
    knobFace.position.z = 0.0083;

    // Raised diametral pointer bar across the knob face with indicator tick on the -X pointer end.
    const pointerBar = new THREE.Mesh(
      new THREE.BoxGeometry(0.0278, 0.004, 0.0032),
      matteBlackBody,
    );
    pointerBar.position.z = 0.0094;

    const pointerTick = new THREE.Mesh(
      new THREE.BoxGeometry(0.0055, 0.0014, 0.0006),
      new THREE.MeshBasicMaterial({ color: 0xd8dee6 }),
    );
    pointerTick.position.set(-0.0105, 0, 0.0111);

    this.heaterDialPivot.add(knobBody, knobFace, pointerBar, pointerTick);
    frontGroup.add(
      frontScaleDecal,
      pilotGroup,
      dialBezel,
      this.heaterDialPivot,
    );

    heater.add(
      frustumBody,
      heatingPlate,
      thermalGlowRing,
      this.heaterLight,
      frontGroup,
    );
    enableShadows(heater);
    this.root.add(heater);
  }

  /**
   * Hario BL-ECA-3 conical flat-bottomed borosilicate lower server (360 mL, 3-cup) +
   * matte-black neck collar and open cantilevered 65° angled handle (`eca-3-b-0.jpg` & `eca-3-b-5.jpg`):
   * - Stepped flat glass foot (Ø85 mm), wide rounded lower belly (Ø114 mm), straight conical walls,
   *   cylindrical neck (Ø42 mm), and flared glass trumpet rim (Ø53 mm)
   * - White enamel `• 3 MAX / HARIO ECA-3 MADE IN JAPAN / • 2 MIN` front print + Japanese caution block
   * - Smooth matte-black neck collar + injection-molded open cantilevered matte-black handle
   */
  private buildLowerBowlAndStand(): void {
    const group = this.bodies.get("si_lower_bowl");
    if (group === undefined) return;

    const glassMaterial = createBorosilicateGlassMaterial(0.38);
    const glassRimMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xebf7fc,
      roughness: 0.06,
      metalness: 0.04,
      clearcoat: 1.0,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    const matteBlackHandle = new THREE.MeshStandardMaterial({
      color: 0x181a1e,
      roughness: 0.48,
      metalness: 0.08,
    });

    // 1. Double-walled BL-ECA-3 conical flat-bottomed borosilicate glass server (z = 0.000..0.098 m).
    const zOuter = [
      0.0038, 0.006, 0.01, 0.015, 0.026, 0.04, 0.054, 0.064, 0.069, 0.074,
      0.082, 0.09, 0.094, 0.098,
    ];
    const outerPts: THREE.Vector2[] = [
      new THREE.Vector2(0.0005, 0.0005),
      new THREE.Vector2(0.0415, 0.0005),
      new THREE.Vector2(0.0428, 0.0035),
      ...zOuter.map(
        (z) => new THREE.Vector2(lowerInnerRadiusAtZ(z) + 0.0022, z),
      ),
    ];
    const innerPts: THREE.Vector2[] = [
      ...[...zOuter]
        .reverse()
        .map((z) => new THREE.Vector2(lowerInnerRadiusAtZ(z), z)),
      new THREE.Vector2(0.0005, 0.0036),
    ];
    const carafeProfile = [
      ...new THREE.SplineCurve(outerPts).getPoints(56),
      new THREE.Vector2(0.0256, 0.0984),
      ...new THREE.SplineCurve(innerPts).getPoints(52),
    ];
    const carafeGlass = new THREE.Mesh(
      new THREE.LatheGeometry(carafeProfile, 64).rotateX(Math.PI / 2),
      glassMaterial,
    );
    carafeGlass.renderOrder = 2;

    // Fire-polished trumpet mouth rim + thick optical flat glass foot ring.
    const neckRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.0255, 0.0014, 16, 48),
      glassRimMaterial,
    );
    neckRim.position.z = 0.098;
    neckRim.renderOrder = 3;

    const baseFootRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.0418, 0.0018, 16, 56),
      glassRimMaterial,
    );
    baseFootRing.position.z = 0.0022;
    baseFootRing.renderOrder = 3;

    // 2. Conical front white enamel markings (`• 3 MAX / HARIO ECA-3 MADE IN JAPAN / • 2 MIN`).
    const markings = new THREE.Mesh(
      new THREE.CylinderGeometry(
        lowerInnerRadiusAtZ(0.058) + 0.0026,
        lowerInnerRadiusAtZ(0.02) + 0.0026,
        0.038,
        36,
        1,
        true,
        -0.12,
        0.72,
      ).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: createLowerBulbMarkingsTexture(),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    markings.position.z = 0.039;
    markings.renderOrder = 3;

    // Left-flank Japanese heatproof glass caution block (`eca-3-b-0.jpg` & `eca-3-b-5.jpg`).
    const cautionMarkings = new THREE.Mesh(
      new THREE.CylinderGeometry(
        lowerInnerRadiusAtZ(0.054) + 0.0026,
        lowerInnerRadiusAtZ(0.024) + 0.0026,
        0.03,
        28,
        1,
        true,
        -0.78,
        0.52,
      ).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: createLowerCautionMarkingsTexture(),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    cautionMarkings.position.z = 0.039;
    cautionMarkings.renderOrder = 3;

    // 3. Smooth matte-black neck collar (z = 0.0735..0.0905 m, r = 0.0246 m).
    const collarProfile = [
      new THREE.Vector2(0.021, 0.0735),
      new THREE.Vector2(0.0242, 0.0742),
      new THREE.Vector2(0.0246, 0.082),
      new THREE.Vector2(0.0242, 0.0898),
      new THREE.Vector2(0.021, 0.0905),
    ];
    const neckCollar = new THREE.Mesh(
      new THREE.LatheGeometry(collarProfile, 56).rotateX(Math.PI / 2),
      matteBlackHandle,
    );

    // 4. Open cantilevered matte-black angled handle (`eca-3-b-0.jpg`):
    //    Horizontal bridge from collar (x = 0.022..0.056 m, z = 0.082 m) -> smooth rounded elbow ->
    //    65° downward-angled grip arm reaching (x = 0.095 m, z = 0.002 m) with an open bottom tip.
    const handleShape = new THREE.Shape();
    handleShape.moveTo(0.021, 0.0898);
    handleShape.lineTo(0.053, 0.0898);
    handleShape.quadraticCurveTo(0.064, 0.0898, 0.069, 0.079);
    handleShape.lineTo(0.097, 0.007);
    handleShape.quadraticCurveTo(0.099, 0.001, 0.094, -0.001);
    handleShape.quadraticCurveTo(0.089, -0.002, 0.086, 0.004);
    handleShape.lineTo(0.059, 0.072);
    handleShape.quadraticCurveTo(0.055, 0.0785, 0.047, 0.0785);
    handleShape.lineTo(0.026, 0.0785);
    handleShape.quadraticCurveTo(0.022, 0.078, 0.021, 0.074);
    handleShape.closePath();

    const handleGeo = new THREE.ExtrudeGeometry(handleShape, {
      depth: 0.015,
      bevelEnabled: true,
      bevelThickness: 0.0022,
      bevelSize: 0.002,
      bevelSegments: 4,
    });
    handleGeo.translate(0, 0, -0.0075);
    handleGeo.rotateX(Math.PI / 2);
    const cantileverHandle = new THREE.Mesh(handleGeo, matteBlackHandle);

    group.add(
      carafeGlass,
      neckRim,
      baseFootRing,
      markings,
      cautionMarkings,
      neckCollar,
      cantileverHandle,
    );
    enableShadows(group);
    carafeGlass.castShadow = false;
    neckRim.castShadow = false;
    baseFootRing.castShadow = false;
    markings.castShadow = false;
    cautionMarkings.castShadow = false;
  }

  /**
   * Hario BU-ECA-3 cylindrical upper glass bowl (Ø88 mm) + F-103S cloth filter assembly (`eca-3-b-0.jpg` & `eca-3-b-5.jpg`):
   * - Straight vertical cylindrical borosilicate bowl with rounded bottom shoulder & 80 mm downstem
   * - White enamel `HARIO / ECA-3 / MADE IN JAPAN` upper front print
   * - 3-ribbed matte-black silicone neck gasket (`eca-3-b-5.jpg`)
   * - Pleated F-103S cotton flannel filter pad, perforated stainless plate, and tall central upright stainless post (`22 mm`)
   * - Top-of-stem 14-turn stainless helical tension spring, pull rod, and bottom bead chain + J-hook
   */
  private buildUpperBowlAndFilter(): void {
    const group = this.bodies.get("si_upper_bowl");
    if (group === undefined) return;

    const glassMaterial = createBorosilicateGlassMaterial(0.34);
    const glassRimMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xebf7fc,
      roughness: 0.06,
      metalness: 0.04,
      clearcoat: 1.0,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const gasketMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b1d21,
      roughness: 0.56,
      metalness: 0.06,
    });
    const flannelMaterial = new THREE.MeshStandardMaterial({
      color: 0xe6dac3,
      roughness: 0.86,
      metalness: 0.02,
    });
    const flannelSeamMaterial = new THREE.MeshStandardMaterial({
      color: 0xcab899,
      roughness: 0.88,
      metalness: 0.02,
    });
    const steelMaterial = new THREE.MeshStandardMaterial({
      color: 0xd8dee6,
      roughness: 0.16,
      metalness: 0.92,
    });

    // 1. Double-walled BU-ECA-3 straight cylindrical borosilicate upper bowl + 80 mm downstem.
    const zSamples: number[] = [
      -0.078, -0.04, 0.0, 0.015, 0.018, 0.021, 0.025, 0.03, 0.035, 0.04, 0.055,
      0.075, 0.095, 0.107, 0.112,
    ];
    const outerPoints = zSamples.map((z) => {
      const wall = z < 0.018 ? 0.0018 : 0.0022;
      return new THREE.Vector2(upperInnerRadiusAtZ(z) + wall, z);
    });
    const innerPoints = [...zSamples]
      .reverse()
      .map((z) => new THREE.Vector2(upperInnerRadiusAtZ(z), z));

    const upperProfile = [
      ...new THREE.SplineCurve(outerPoints).getPoints(56),
      new THREE.Vector2(0.0446, 0.1124),
      ...new THREE.SplineCurve(innerPoints).getPoints(56),
    ];
    const upperGlass = new THREE.Mesh(
      new THREE.LatheGeometry(upperProfile, 64).rotateX(Math.PI / 2),
      glassMaterial,
    );
    upperGlass.renderOrder = 2;

    // Fire-polished top mouth rim + lower stem orifice ring.
    const upperRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.0442, 0.0015, 16, 56),
      glassRimMaterial,
    );
    upperRim.position.z = 0.112;
    upperRim.renderOrder = 3;

    const stemOrificeRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.0048, 0.0009, 12, 28),
      glassRimMaterial,
    );
    stemOrificeRing.position.z = -0.0778;
    stemOrificeRing.renderOrder = 3;

    // White enamel `HARIO / ECA-3 / MADE IN JAPAN` print on upper front wall (`eca-3-b-0.jpg`).
    const upperMarkings = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.0443,
        0.0443,
        0.026,
        32,
        1,
        true,
        -0.06,
        0.6,
      ).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: createUpperBowlMarkingsTexture(),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    upperMarkings.position.z = 0.084;
    upperMarkings.renderOrder = 3;

    // 2. 3-ribbed black silicone neck gasket matching `eca-3-b-5.jpg` (z = -0.003..+0.019 m).
    const gasketProfile: THREE.Vector2[] = [
      new THREE.Vector2(0.006, -0.003),
      new THREE.Vector2(0.0185, -0.003),
      new THREE.Vector2(0.0216, 0.0005),
      new THREE.Vector2(0.0188, 0.004),
      new THREE.Vector2(0.0232, 0.0085),
      new THREE.Vector2(0.0196, 0.013),
      new THREE.Vector2(0.0262, 0.0172),
      new THREE.Vector2(0.0245, 0.0195),
      new THREE.Vector2(0.007, 0.0195),
    ];
    const gasket = new THREE.Mesh(
      new THREE.LatheGeometry(gasketProfile, 48).rotateX(Math.PI / 2),
      gasketMaterial,
    );

    // 3. F-103S pleated cotton flannel filter cushion (Ø55 mm at z = 0.026..0.030 m).
    const clothProfile = [
      new THREE.Vector2(0.002, 0.0245),
      new THREE.Vector2(0.0265, 0.0255),
      new THREE.Vector2(0.0278, 0.0278),
      new THREE.Vector2(0.0248, 0.03),
      new THREE.Vector2(0.012, 0.0306),
      new THREE.Vector2(0.002, 0.0306),
    ];
    const clothDisc = new THREE.Mesh(
      new THREE.LatheGeometry(clothProfile, 48).rotateX(Math.PI / 2),
      flannelMaterial,
    );

    // 10 radial pleated cloth seams around the perimeter of the flannel filter pad (`eca-3-b-0.jpg`).
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI * 2) / 10;
      const seam = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.0009, 0.014, 6, 8).rotateZ(Math.PI / 2),
        flannelSeamMaterial,
      );
      seam.position.set(Math.cos(a) * 0.0185, Math.sin(a) * 0.0185, 0.0302);
      seam.rotation.z = a;
      group.add(seam);
    }

    // Perforated stainless retaining plate + signature tall upright stainless finger post (`z = 0.030..0.052 m`, `eca-3-b-0.jpg`).
    const filterWasher = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0125, 0.0135, 0.0018, 32).rotateX(
        Math.PI / 2,
      ),
      steelMaterial,
    );
    filterWasher.position.z = 0.0308;

    const centerPost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0038, 0.004, 0.021, 28).rotateX(Math.PI / 2),
      steelMaterial,
    );
    centerPost.position.z = 0.0415;

    const centerPostCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0032, 0.0038, 0.0015, 28).rotateX(
        Math.PI / 2,
      ),
      steelMaterial,
    );
    centerPostCap.position.z = 0.0525;

    // 4. Top-of-stem 14-turn stainless helical tension spring (`z = 0.012..-0.024 m`, visible right below neck collar in `eca-3-b-0.jpg`)
    //    + straight stainless pull wire (`z = -0.024..-0.068 m`) + bottom bead chain & J-hook (`z = -0.068..-0.081 m`).
    const springPoints: THREE.Vector3[] = [];
    const springTurns = 13;
    const springSamples = 96;
    for (let i = 0; i <= springSamples; i++) {
      const u = i / springSamples;
      const theta = u * springTurns * Math.PI * 2;
      const r = 0.0023;
      const z = 0.012 - u * 0.036;
      springPoints.push(
        new THREE.Vector3(Math.cos(theta) * r, Math.sin(theta) * r, z),
      );
    }
    const tensionSpring = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(springPoints),
        88,
        0.00052,
        8,
        false,
      ),
      steelMaterial,
    );

    const pullWire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.00048, 0.00048, 0.046, 10).rotateX(
        Math.PI / 2,
      ),
      steelMaterial,
    );
    pullWire.position.z = -0.047;

    const beadGeo = new THREE.SphereGeometry(0.0013, 12, 10);
    for (let b = 0; b < 5; b++) {
      const bead = new THREE.Mesh(beadGeo, steelMaterial);
      bead.position.z = -0.07 - b * 0.0026;
      group.add(bead);
    }

    const hookCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, -0.068),
      new THREE.Vector3(0, 0, -0.0795),
      new THREE.Vector3(0.0025, 0, -0.0815),
      new THREE.Vector3(0.0052, 0, -0.079),
      new THREE.Vector3(0.0054, 0, -0.0745),
    ]);
    const bottomHook = new THREE.Mesh(
      new THREE.TubeGeometry(hookCurve, 24, 0.00065, 10, false),
      steelMaterial,
    );

    group.add(
      upperGlass,
      upperRim,
      stemOrificeRing,
      upperMarkings,
      gasket,
      clothDisc,
      filterWasher,
      centerPost,
      centerPostCap,
      tensionSpring,
      pullWire,
      bottomHook,
    );
    enableShadows(group);
    upperGlass.castShadow = false;
    upperRim.castShadow = false;
    stemOrificeRing.castShadow = false;
    upperMarkings.castShadow = false;
  }

  /**
   * Sculpted Hario BA-15 natural Moso bamboo stirring paddle (243 x 24 mm):
   * - Continuous bevelled oar blade, ergonomic waist taper, and rounded crown with hanging eyelet
   * - Procedural bamboo vascular grain and culm-node texture
   * - Precision anodized-aluminum & ribbed Viton grasp collar (r = 8.5 mm at z = 0.075 m)
   */
  private buildBambooPaddle(): void {
    const group = this.bodies.get("si_paddle");
    if (group === undefined) return;

    const bambooMaterial = new THREE.MeshStandardMaterial({
      map: createBambooGrainTexture(),
      color: 0xe8c896,
      roughness: 0.38,
      metalness: 0.03,
    });
    const gripSleeveMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b1f24,
      roughness: 0.64,
      metalness: 0.14,
    });
    const brassMaterial = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.22,
      metalness: 0.88,
    });

    // 1. One-piece sculpted BA-15 bamboo paddle silhouette in (Z_length, Y_width) extruded in X_thickness.
    const paddleShape = new THREE.Shape();
    paddleShape.moveTo(-0.056, -0.006);
    paddleShape.quadraticCurveTo(-0.06, 0, -0.056, 0.006);
    paddleShape.quadraticCurveTo(-0.044, 0.0115, -0.018, 0.0112);
    paddleShape.quadraticCurveTo(0.004, 0.0102, 0.018, 0.0065);
    paddleShape.lineTo(0.118, 0.0062);
    paddleShape.quadraticCurveTo(0.126, 0.0062, 0.126, 0);
    paddleShape.quadraticCurveTo(0.126, -0.0062, 0.118, -0.0062);
    paddleShape.lineTo(0.018, -0.0065);
    paddleShape.quadraticCurveTo(0.004, -0.0102, -0.018, -0.0112);
    paddleShape.quadraticCurveTo(-0.044, -0.0115, -0.056, -0.006);
    paddleShape.closePath();

    // Hanging eyelet hole near the top crown of the BA-15 handle (z = 0.116 m).
    const eyelet = new THREE.Path();
    eyelet.absarc(0.116, 0, 0.0022, 0, Math.PI * 2, false);
    paddleShape.holes.push(eyelet);

    const paddleGeo = new THREE.ExtrudeGeometry(paddleShape, {
      depth: 0.0032,
      bevelEnabled: true,
      bevelThickness: 0.0009,
      bevelSize: 0.0009,
      bevelSegments: 4,
    });
    paddleGeo.translate(0, 0, -0.0016);
    paddleGeo.rotateY(-Math.PI / 2);
    const bambooBody = new THREE.Mesh(paddleGeo, bambooMaterial);

    // 2. Lathe-turned ribbed Viton & brass grasp collar at z = 0.075 m (r = 8.5 mm) where FR10 jaws lock.
    const sleeveProfile: THREE.Vector2[] = [new THREE.Vector2(0.0045, 0.056)];
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const z = 0.056 + u * 0.038;
      const groove = Math.sin(u * Math.PI * 8) * 0.00035;
      sleeveProfile.push(new THREE.Vector2(0.0084 + groove, z));
    }
    sleeveProfile.push(new THREE.Vector2(0.0045, 0.094));
    const gripSleeve = new THREE.Mesh(
      new THREE.LatheGeometry(sleeveProfile, 36).rotateX(Math.PI / 2),
      gripSleeveMaterial,
    );

    const topFerrule = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0086, 0.0086, 0.0035, 32).rotateX(
        Math.PI / 2,
      ),
      brassMaterial,
    );
    topFerrule.position.set(0, 0, 0.095);

    const bottomFerrule = topFerrule.clone();
    bottomFerrule.position.set(0, 0, 0.055);

    group.add(bambooBody, gripSleeve, topFerrule, bottomFerrule);
    enableShadows(group);
  }

  async load(): Promise<void> {
    const visual = await loadRobotVisual("fairino-fr10", this.abort.signal);
    if (this.lifecycle === "disposed") {
      visual.traverse(disposePhysicsObject);
      return;
    }
    const pivots = [];
    for (const joint of ROBOTS["fairino-fr10"].joints) {
      const object = visual.getObjectByName(joint.node);
      if (object === undefined)
        throw new Error("Robot visual has an incompatible joint hierarchy.");
      pivots.push({ object, axis: new THREE.Vector3(...joint.axis) });
    }
    enableShadows(visual);
    visual.rotation.x = Math.PI / 2;
    this.robot.add(visual);
    this.pivots = pivots;
    this.lifecycle = "ready";
    const latest = this.batchSamples.at(-1) ?? this.displayedFrame;
    if (latest !== null && latest !== undefined) this.applySample(latest);
    this.host.requestFrame();
  }

  setCameraPreset(preset: SiphonCameraPreset): void {
    const next = CAMERA_PRESETS[preset];
    this.host.moveCamera(
      new THREE.Vector3(...next.position),
      new THREE.Vector3(...next.target),
    );
  }

  private updateHeaterDisplay(sample: SiphonSample): void {
    const modeLabel =
      sample.heater.mode === "high-350w"
        ? "350W HIGH"
        : sample.heater.mode === "hold-110w"
          ? "110W HOLD"
          : "0W OFF";
    const tempText = `${sample.thermo.lowerC.toFixed(1)}°C`;
    const pressText = `${sample.thermo.pressureKPa.toFixed(1)}kPa`;
    const key = `${modeLabel}|${tempText}|${pressText}`;
    if (key === this.heaterDisplayKey) return;
    this.heaterDisplayKey = key;

    const ctx = this.heaterDisplayCanvas.getContext("2d");
    if (ctx === null) return;
    ctx.fillStyle = "#0b0e12";
    ctx.fillRect(0, 0, 256, 72);
    ctx.strokeStyle = "#252c35";
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, 252, 68);

    ctx.fillStyle = sample.heater.powerW > 0 ? "#ff6b2b" : "#64b5f6";
    ctx.font = "700 20px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText(modeLabel, 12, 30);

    ctx.fillStyle = "#e8f0f7";
    ctx.font = "600 18px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${tempText} · ${pressText}`, 12, 56);
    this.heaterDisplayTexture.needsUpdate = true;
  }

  private paintSlurryTexture(
    swirlAngle: number,
    foamStrength: number,
    wettingFraction: number,
  ): void {
    const ctx = this.slurryCanvas.getContext("2d");
    if (ctx === null) return;
    const grad = ctx.createRadialGradient(96, 96, 6, 96, 96, 94);
    if (wettingFraction < 0.35) {
      // Unwetted dry roast grounds floating on top before fold-in stir.
      grad.addColorStop(0, "#4a2812");
      grad.addColorStop(0.75, "#3b1f0e");
      grad.addColorStop(1, "#5c3419");
    } else {
      // Golden CO2 bloom crema foam and wet coffee crust.
      grad.addColorStop(0, "#42200d");
      grad.addColorStop(0.62, "#78421d");
      grad.addColorStop(1, "#c88d4e");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 192, 192);

    ctx.save();
    ctx.translate(96, 96);
    ctx.rotate(swirlAngle);
    ctx.strokeStyle = `rgba(238, 194, 134, ${0.22 + foamStrength * 0.42})`;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (let arm = 0; arm < 3; arm++) {
      ctx.beginPath();
      const baseAngle = (arm * Math.PI * 2) / 3;
      for (let r = 8; r <= 82; r += 4) {
        const a = baseAngle + r * 0.044;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (r === 8) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    this.slurryTexture.needsUpdate = true;
  }

  /** Deforms the top crema surface into a concave parabolic whirlpool vortex during stirring. */
  private updateVortexSurface(swirlRadS: number): void {
    const positions = this.slurryDiscGeometry.attributes.position;
    if (positions === undefined) return;
    const depth = Math.min(0.009, swirlRadS * swirlRadS * 0.00026);
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const r2 = x * x + y * y;
      const zOffset = depth * (r2 - 0.5);
      positions.setZ(i, zOffset);
    }
    positions.needsUpdate = true;
  }

  setFrame(sample: SiphonSample): void {
    this.setSamples([sample]);
  }

  setSamples(samples: readonly SiphonSample[]): void {
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

  private applySample(sample: SiphonSample): void {
    this.displayedFrame = sample;
    this.updateHeaterDisplay(sample);

    for (const [index, pivot] of this.pivots.entries()) {
      const angle = sample.joints[index];
      if (angle !== undefined)
        pivot.object.quaternion.setFromAxisAngle(pivot.axis, angle);
    }

    const place = (body: SiphonBody, pose: StationPose) => {
      const group = this.bodies.get(body);
      if (group !== undefined) setPose(group, pose);
    };
    place("po_gripper", sample.gripper);
    place("si_lower_bowl", sample.lowerBowl);
    place("si_upper_bowl", sample.upperBowl);
    place("si_paddle", sample.paddle);

    for (const [index, side] of (["left", "right"] as const).entries()) {
      const finger = this.bodies.get(
        side === "left" ? "po_finger_left" : "po_finger_right",
      );
      const frame = this.setup.fingers[side];
      if (finger === undefined) continue;
      setPose(finger, frame.pose);
      const opening = sample.fingers[index] ?? 0;
      finger.position.x += frame.axis[0] * opening;
      finger.position.y += frame.axis[1] * opening;
      finger.position.z += frame.axis[2] * opening;
    }

    // 1. ECA-3-B electric heater thermal glow, power pilot LED, and rotary dial (`off` / `mid` / `max`).
    this.heaterElementMaterial.emissiveIntensity =
      0.08 + sample.heater.glow * 1.65;
    this.heaterHaloMaterial.emissiveIntensity =
      sample.heater.powerW > 0 ? 1.35 : 0.08;
    this.heaterLight.intensity = sample.heater.glow * 1.1;
    this.heaterDialPivot.rotation.z =
      sample.heater.mode === "high-350w"
        ? -Math.PI
        : sample.heater.mode === "hold-110w"
          ? -Math.PI / 2
          : 0;

    // 2. Beer-Lambert optical coffee absorption & continuous lower-carafe mixing during drawdown.
    const extractColor = beerLambertCoffeeColor(sample.extraction.tdsPct);
    const upperOpticalColor = beerLambertCoffeeColor(
      Math.max(0.28, sample.extraction.tdsPct),
    );
    const isDrawdownOrDone =
      sample.control.phase === "drawdown" ||
      sample.control.phase === "completed";
    const heelG = 26;
    const drainedCoffeeG = isDrawdownOrDone
      ? Math.max(0, sample.water.lowerG - heelG)
      : 0;
    const mixFraction =
      drainedCoffeeG <= 0
        ? 0
        : Math.min(1, (drainedCoffeeG * 2.2) / Math.max(1, sample.water.lowerG));
    const lowerEffectiveTds = sample.extraction.tdsPct * mixFraction;
    const lowerColor = beerLambertCoffeeColor(lowerEffectiveTds);

    this.lowerLiquidMaterial.color.copy(lowerColor);
    this.lowerLiquidMaterial.opacity = THREE.MathUtils.lerp(
      0.48,
      0.94,
      Math.min(1, lowerEffectiveTds / 1.1),
    );
    this.upperLiquidMaterial.color.copy(upperOpticalColor);
    this.stemLiquidMaterial.color.copy(
      isDrawdownOrDone
        ? extractColor
        : beerLambertCoffeeColor(sample.extraction.tdsPct * 0.25),
    );
    this.stemLiquidMaterial.opacity = isDrawdownOrDone ? 0.94 : 0.72;

    // 3. Exact conical-carafe liquid geometry inside BL-ECA-3 lower glass server.
    //    At 26 g heel (lowerFraction = 0.074), zSurface = 0.0101 m (right at the downstem orifice, matching eca-3-b-1.jpg).
    //    At 350 g full (lowerFraction = 1.0), zSurface = 0.0520 m (at the "• 3 MAX" enamel dot).
    const lowerFraction = Math.max(
      0.05,
      Math.min(1, sample.water.lowerG / Math.max(1, sample.water.initialG)),
    );
    const zSurface = 0.0068 + lowerFraction * 0.0452;
    const capKey = zSurface.toFixed(4);
    if (capKey !== this.lowerCapKey) {
      this.lowerCapKey = capKey;
      this.lowerLiquid.geometry.dispose();
      this.lowerLiquid.geometry = buildLowerConicalLiquidGeometry(zSurface);
    }
    const rSurface = Math.max(0.01, lowerInnerRadiusAtZ(zSurface) - 0.0005);
    this.lowerMeniscusRing.scale.set(rSurface, rSurface, 1);
    this.lowerMeniscusRing.position.set(0, 0, zSurface + 0.0003);
    if (this.lowerMeniscusRing.material instanceof THREE.MeshBasicMaterial) {
      const cremaBlend = Math.min(1, drainedCoffeeG / 95);
      this.lowerMeniscusRing.material.color
        .setHex(0xdcf4ff)
        .lerp(new THREE.Color(0xc88746), cremaBlend);
      this.lowerMeniscusRing.material.opacity = THREE.MathUtils.lerp(
        0.52,
        0.84,
        cremaBlend,
      );
    }

    // Golden-tan crema micro-foam collar around the glass stem on the lower liquid meniscus during drawdown/completed.
    this.lowerStemFoamRing.visible = drainedCoffeeG > 8;
    if (this.lowerStemFoamRing.visible) {
      const foamScale = 0.85 + Math.min(1, drainedCoffeeG / 140) * 0.55;
      this.lowerStemFoamRing.scale.set(foamScale, foamScale, 1);
      this.lowerStemFoamRing.position.set(0, 0, zSurface + 0.0004);
      if (this.lowerStemFoamRing.material instanceof THREE.MeshBasicMaterial) {
        this.lowerStemFoamRing.material.opacity =
          Math.min(1, drainedCoffeeG / 80) * 0.76;
      }
    }

    // 4. Submerged downward coffee jet & bottom diffusion plume from stem tip (z = 0.0105 m) to carafe floor (z = 0.0040 m).
    const drawingDown =
      sample.control.phase === "drawdown" && sample.water.flowGS < -0.25;
    this.drawdownStream.visible = drawingDown;
    if (drawingDown) {
      const jetBottomZ = 0.004;
      const jetTopZ = Math.min(zSurface - 0.0005, 0.0125);
      const streamLen = Math.max(0.004, jetTopZ - jetBottomZ);
      const flowScale = Math.min(1.35, 0.75 + Math.abs(sample.water.flowGS) / 22);
      this.drawdownStream.scale.set(flowScale, flowScale, streamLen);
      this.drawdownStream.position.set(0, 0, jetBottomZ + streamLen / 2);
      if (
        this.drawdownStream.material instanceof THREE.MeshPhysicalMaterial
      ) {
        this.drawdownStream.material.color.copy(extractColor);
      }
    }

    // 5. Downstem liquid column inside the 140 mm glass tube (`si_upper_bowl` z = -0.078..0.024 m).
    this.stemLiquid.visible = sample.water.stemG > 0.2;
    if (this.stemLiquid.visible) {
      const stemRatio = Math.min(1, sample.water.stemG / 3.6);
      const len = 0.102 * stemRatio;
      this.stemLiquid.scale.set(1, 1, Math.max(0.008, len));
      this.stemLiquid.position.set(0, 0, -0.078 + len / 2);
    }

    // 6. Upper chamber 3-layer stratification inside BU-ECA-3 cylindrical bowl:
    //    Driven strictly by free liquid (`upperFreeG`) so that during drawdown the free coffee meniscus
    //    drains all the way down through the emerging domed coffee bed and disappears when `upperFreeG <= 0.6 g`.
    const upperFreeFraction = Math.max(
      0,
      Math.min(1, sample.water.upperFreeG / Math.max(1, sample.water.initialG - heelG)),
    );
    const upperHeight = upperFreeFraction * 0.058;
    const crustThickness = 0.012;

    if (sample.water.upperFreeG <= 0.6 || upperHeight <= 0.0012) {
      // Before upflow reaches the upper bowl, or once drawdown finishes draining free coffee:
      this.upperLiquid.visible = false;
      this.slurryDisc.visible = false;
      const preBrewDryBed =
        sample.control.phase === "preheat-seal" ||
        (sample.control.phase === "upflow" && sample.water.upperFreeG < 8);
      this.crustLayer.visible = preBrewDryBed;
      if (preBrewDryBed) {
        const dryKey = "dry:0.030:0.041";
        if (dryKey !== this.crustLayerKey) {
          this.crustLayerKey = dryKey;
          this.crustLayer.geometry.dispose();
          this.crustLayer.geometry = buildUpperChamberLatheGeometry(
            0.03,
            0.041,
            0.0008,
          );
        }
      }
    } else {
      this.upperLiquid.visible = true;
      this.slurryDisc.visible = true;
      const zBottom = 0.0285;
      const zTop = zBottom + Math.max(0.0025, upperHeight);
      const liqKey = `${zBottom.toFixed(3)}:${zTop.toFixed(3)}`;
      if (liqKey !== this.upperLiquidKey) {
        this.upperLiquidKey = liqKey;
        this.upperLiquid.geometry.dispose();
        this.upperLiquid.geometry = buildUpperChamberLatheGeometry(
          zBottom,
          zTop,
          0.0006,
        );
      }

      // Floating coffee grounds crust band near top of liquid column (buoyant from CO2 during steep; settles onto dome during drawdown).
      const showFloatingCrust =
        sample.extraction.crustBuoyancy > 0.14 && upperHeight > 0.02;
      this.crustLayer.visible = showFloatingCrust;
      if (showFloatingCrust) {
        const crustCenterZ =
          zBottom +
          Math.max(
            crustThickness / 2,
            upperHeight * (0.45 + 0.52 * sample.extraction.crustBuoyancy) -
              crustThickness * 0.45,
          );
        const cBot = Math.max(zBottom + 0.002, crustCenterZ - crustThickness / 2);
        const cTop = Math.min(zTop + 0.0003, crustCenterZ + crustThickness / 2);
        const cKey = `${cBot.toFixed(3)}:${cTop.toFixed(3)}`;
        if (cKey !== this.crustLayerKey) {
          this.crustLayerKey = cKey;
          this.crustLayer.geometry.dispose();
          this.crustLayer.geometry = buildUpperChamberLatheGeometry(
            cBot,
            cTop,
            0.0004,
          );
        }
      }

      const rDisc = Math.max(0.01, upperInnerRadiusAtZ(zTop) - 0.0006);
      this.slurryDisc.scale.set(rDisc, rDisc, 1);
      this.slurryDisc.position.set(0, 0, zTop + 0.0005);
      this.updateVortexSurface(sample.thermo.swirlRadS);
    }

    // 7. Full-width sculpted spent coffee grounds dome on top of F-103S cloth filter (`z = 0.0285..0.0485 m`).
    //    As `upperLiquid` recedes below `z = 0.048 m` during drawdown, the coffee mound emerges progressively above the meniscus.
    const showDome =
      sample.water.absorbedG > 2 &&
      (sample.control.phase === "whirlpool" ||
        sample.control.phase === "drawdown" ||
        sample.control.phase === "completed" ||
        upperHeight < 0.032);
    this.spentDome.visible = showDome;
    if (showDome) {
      const domeScaleZ = Math.max(
        0.55,
        Math.min(1.15, sample.water.domeHeightM / 0.022),
      );
      this.spentDome.scale.set(1, 1, domeScaleZ);
      this.spentDome.position.set(0, 0, 0.0285);
    }
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
      this.swirlAngle += sample.thermo.swirlRadS * 0.016;
      this.paintSlurryTexture(
        this.swirlAngle,
        Math.min(1, sample.thermo.swirlRadS / 5),
        sample.extraction.wettingFraction,
      );

      // Animate rising vapor bubbles (upflow/steep) OR final vacuum-equalizer bubble kick in the lower bowl at end of drawdown.
      const isVacuumKick =
        sample.control.phase === "drawdown" && sample.water.upperFreeG <= 2.0;
      const bubbling = sample.thermo.bubbleRate > 0.05;
      for (const [index, bubble] of this.bubbles.entries()) {
        bubble.visible = bubbling;
        if (!bubbling) continue;
        if (bubble.material instanceof THREE.MeshPhysicalMaterial) {
          bubble.material.color.setHex(isVacuumKick ? 0xdba362 : 0xffffff);
        }
        const cycle =
          (((now * 0.00105 * (0.6 + sample.thermo.bubbleRate * 0.6) +
            index / this.bubbles.length) %
            1) +
            1) %
          1;
        if (isVacuumKick) {
          // Vacuum equalizer kick: air breaks through the domed bed and bursts from the bottom stem tip (z = -0.078 m)
          // radially upward to the lower carafe surface (z = -0.043 m in si_upper_bowl coordinates).
          const radial = 0.002 + cycle * 0.024;
          const theta = index * 2.399 + now * 0.004;
          bubble.position.set(
            Math.cos(theta) * radial,
            Math.sin(theta) * radial,
            -0.078 + cycle * 0.035,
          );
        } else if (cycle < 0.62) {
          const stemProgress = cycle / 0.62;
          bubble.position.set(
            Math.sin(now * 0.008 + index) * 0.0018,
            Math.cos(now * 0.007 + index) * 0.0018,
            -0.078 + stemProgress * 0.106,
          );
        } else {
          const bowlProgress = (cycle - 0.62) / 0.38;
          const radial = bowlProgress * 0.028;
          const theta = index * 2.399 + this.swirlAngle;
          bubble.position.set(
            Math.cos(theta) * radial,
            Math.sin(theta) * radial,
            0.032 + bowlProgress * 0.048,
          );
        }
      }

      // Animate rising steam wisps above the hot upper bowl.
      const steaming = sample.thermo.upperC > 65 && sample.water.upperFreeG > 5;
      for (const [index, wisp] of this.steamWisps.entries()) {
        wisp.visible = steaming;
        if (!steaming) continue;
        const cycle =
          (((now * 0.00042 + index / this.steamWisps.length) % 1) + 1) % 1;
        wisp.position.set(
          Math.sin(now * 0.0018 + index * 2.1) * 0.006,
          Math.cos(now * 0.0015 + index * 1.7) * 0.006,
          0.115 + cycle * 0.072,
        );
        const scale = 0.75 + cycle * 1.05;
        wisp.scale.set(scale, scale, 1);
        if (wisp.material instanceof THREE.MeshBasicMaterial) {
          wisp.material.opacity = Math.sin(cycle * Math.PI) * 0.17;
        }
      }
    }

    return this.batchSamples.length > 1;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.abort.abort();
    this.heaterDisplayTexture.dispose();
    this.slurryTexture.dispose();
    this.groundsTexture.dispose();
    this.host.dispose();
  }
}
