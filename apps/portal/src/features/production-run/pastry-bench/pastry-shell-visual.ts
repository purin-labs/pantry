import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { ApplianceFlexMesh } from "@seams/bakery-model/bakery-appliance-protocol";

export type DeformablePastryBufferState = {
  vertexCount: number;
  triangleCount: number;
  positionBuffer: Float32Array | null;
};

export function createDeformablePastryBufferState(): DeformablePastryBufferState {
  return {
    vertexCount: 0,
    triangleCount: 0,
    positionBuffer: null,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function rgbCss(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): string {
  const k = clamp01(t);
  return `rgb(${lerpChannel(a[0], b[0], k)}, ${lerpChannel(a[1], b[1], k)}, ${lerpChannel(a[2], b[2], k)})`;
}

/**
 * Draws a 256×256 procedural patisserie pastry texture transitioning smoothly
 * from floured Normandy butter dough (`browning = 0`) through glossy egg-wash
 * (`glaze > 0`) to caramelized golden-amber Maillard puff crust (`browning = 1`).
 */
function drawPastryCrustCanvas(
  ctx: CanvasRenderingContext2D,
  browning: number,
  glaze: number,
): void {
  const b = clamp01(browning);
  const g = clamp01(glaze);

  const rawCenter: readonly [number, number, number] = [245, 231, 196];
  const rawMid: readonly [number, number, number] = [237, 216, 171];
  const rawRim: readonly [number, number, number] = [226, 199, 146];

  const eggCenter: readonly [number, number, number] = [249, 226, 162];
  const eggMid: readonly [number, number, number] = [238, 203, 126];
  const eggRim: readonly [number, number, number] = [222, 178, 102];

  const bakedCenter: readonly [number, number, number] = [214, 138, 48];
  const bakedMid: readonly [number, number, number] = [184, 102, 28];
  const bakedRim: readonly [number, number, number] = [132, 64, 16];

  const baseCenter: readonly [number, number, number] = [
    lerpChannel(rawCenter[0], eggCenter[0], g),
    lerpChannel(rawCenter[1], eggCenter[1], g),
    lerpChannel(rawCenter[2], eggCenter[2], g),
  ];
  const baseMid: readonly [number, number, number] = [
    lerpChannel(rawMid[0], eggMid[0], g),
    lerpChannel(rawMid[1], eggMid[1], g),
    lerpChannel(rawMid[2], eggMid[2], g),
  ];
  const baseRim: readonly [number, number, number] = [
    lerpChannel(rawRim[0], eggRim[0], g),
    lerpChannel(rawRim[1], eggRim[1], g),
    lerpChannel(rawRim[2], eggRim[2], g),
  ];

  const grad = ctx.createRadialGradient(128, 128, 14, 128, 128, 152);
  grad.addColorStop(0, rgbCss(baseCenter, bakedCenter, b));
  grad.addColorStop(0.62, rgbCss(baseMid, bakedMid, b));
  grad.addColorStop(1, rgbCss(baseRim, bakedRim, Math.min(1, b * 1.12)));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  // Fluted rim conduction toast halo + flaky butter / Maillard speckles
  if (b > 0.12) {
    ctx.strokeStyle = `rgba(104, 46, 10, ${(b * 0.34).toFixed(3)})`;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(128, 128, 98, 0, Math.PI * 2);
    ctx.stroke();

    // Subtle diamond score lines across the puffed pie lid dome
    ctx.strokeStyle = `rgba(248, 206, 128, ${(b * 0.28).toFixed(3)})`;
    ctx.lineWidth = 2;
    for (const offset of [-26, 0, 26]) {
      ctx.beginPath();
      ctx.moveTo(76, 128 + offset - 28);
      ctx.lineTo(180, 128 + offset + 28);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(180, 128 + offset - 28);
      ctx.lineTo(76, 128 + offset + 28);
      ctx.stroke();
    }
  }

  for (let i = 0; i < 220; i += 1) {
    const x = ((i * 73) % 248) + 4;
    const y = ((i * 137) % 248) + 4;
    if (i % 3 === 0) {
      const flourAlpha = Math.max(0.05, 0.42 * (1 - b * 0.85));
      ctx.fillStyle = `rgba(255, 252, 245, ${flourAlpha.toFixed(3)})`;
    } else {
      const blisterR = lerpChannel(218, 124, b);
      const blisterG = lerpChannel(179, 58, b);
      const blisterB = lerpChannel(108, 14, b);
      const alpha = 0.22 + b * 0.16;
      ctx.fillStyle = `rgba(${blisterR}, ${blisterG}, ${blisterB}, ${alpha.toFixed(3)})`;
    }
    ctx.beginPath();
    ctx.arc(x, y, 1.4 + (i % 3) * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

export class PastryShellTextureController {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  readonly texture: THREE.CanvasTexture;
  private lastKey = "";

  constructor(initialBrowning = 0, initialGlaze = 0) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.update(initialBrowning, initialGlaze);
  }

  update(browning: number, glaze: number): void {
    const qBrown = Math.round(clamp01(browning) * 100);
    const qGlaze = Math.round(clamp01(glaze) * 50);
    const key = `${qBrown}:${qGlaze}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (this.ctx !== null) {
      drawPastryCrustCanvas(this.ctx, qBrown / 100, qGlaze / 50);
      this.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Updates a Three.js `BufferGeometry` from a MuJoCo 4.0.0 `flexcomp` 2D shell
 * (`dim === 2`) or 3D solid (`dim === 3`) mesh (`mjData.flexvert_xpos` Z-up ->
 * Three.js Y-up), adding smooth laminated puff dome lift (`puffLiftMm`) to 2D
 * pie shells inside the 12 cm fluted tin while preserving the crimped rim seal.
 */
export function updateDeformablePastryBufferGeometry(
  geometry: THREE.BufferGeometry,
  state: DeformablePastryBufferState,
  mesh: ApplianceFlexMesh,
  puffLiftMm = 0,
): void {
  const vCount = mesh.vertexCount;
  const triCount = Math.floor(mesh.faces.length / 3);
  if (vCount <= 0 || mesh.vertices.length < vCount * 3) return;

  if (
    state.positionBuffer === null ||
    state.vertexCount !== vCount ||
    state.triangleCount !== triCount
  ) {
    state.vertexCount = vCount;
    state.triangleCount = triCount;
    state.positionBuffer = new Float32Array(vCount * 3);

    const uvs = new Float32Array(vCount * 2);
    if (mesh.dim === 3) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < vCount; i += 1) {
        const vx = mesh.vertices[i * 3]!;
        const vy = mesh.vertices[i * 3 + 1]!;
        if (vx < minX) minX = vx;
        if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy;
        if (vy > maxY) maxY = vy;
      }
      const spanX = Math.max(1e-4, maxX - minX);
      const spanY = Math.max(1e-4, maxY - minY);
      for (let i = 0; i < vCount; i += 1) {
        uvs[i * 2] = (mesh.vertices[i * 3]! - minX) / spanX;
        uvs[i * 2 + 1] = (mesh.vertices[i * 3 + 1]! - minY) / spanY;
      }
    } else {
      const gridSide = Math.max(2, Math.round(Math.sqrt(vCount)));
      for (let i = 0; i < vCount; i += 1) {
        const col = i % gridSide;
        const row = Math.floor(i / gridSide);
        uvs[i * 2] = col / (gridSide - 1);
        uvs[i * 2 + 1] = row / (gridSide - 1);
      }
    }

    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(state.positionBuffer, 3),
    );
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(Array.from(mesh.faces));
  }

  const out = state.positionBuffer;
  const src = mesh.vertices;
  const liftM = mesh.dim === 2 ? Math.max(0, puffLiftMm) * 0.001 : 0;

  for (let i = 0; i < vCount; i += 1) {
    const base = i * 3;
    const x = src[base]!;
    const yThree = src[base + 2]!;
    const zThree = -src[base + 1]!;
    let domeLift = 0;
    if (liftM > 0) {
      const r = Math.hypot(x, zThree);
      if (r < 0.056) {
        const u = 1 - (r / 0.056) ** 2;
        domeLift = liftM * u ** 1.12;
      } else if (r <= 0.068) {
        // Flaky puff-edge lamination expansion along the crimped fluted collar
        const rimFactor = 1 - Math.abs(r - 0.061) / 0.009;
        domeLift = liftM * 0.18 * Math.max(0, rimFactor);
      }
    }
    out[base] = x;
    out[base + 1] = yThree + domeLift;
    out[base + 2] = zThree;
  }

  const attr = geometry.getAttribute("position");
  if (attr instanceof THREE.BufferAttribute) {
    attr.needsUpdate = true;
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

/**
 * Canonical 9×9 (81-vertex / 128-triangle) crimped 12 cm pie shell mesh matching
 * `pastry_sheet` (`<flexcomp type="grid" dim="2" count="9 9 1" spacing="0.020">`)
 * in local tin coordinates, used by Kitchen 3D factory & oven stations.
 */
export function createCanonicalCrimpedPastryFlexMesh(): ApplianceFlexMesh {
  return pastrySheetFlexMesh((x, y, r, theta) => {
    if (r < 0.054) {
      const dome = 1 - (r / 0.054) ** 2;
      return [x, y, 0.025 + 0.004 * dome];
    }
    if (r <= 0.065) {
      const flute = 0.0012 * Math.cos(theta * 16);
      return [x, y, 0.0285 + flute];
    }
    // Trimmed / tucked skirt around the 12 cm fluted tin rim
    const clampScale = 0.065 / r;
    return [x * clampScale, y * clampScale, 0.0265];
  });
}

/**
 * The 9×9 `pastry_sheet` grid of 17.5 mm cells in local tin coordinates;
 * `place` gives each vertex from its grid point and its polar position.
 */
function pastrySheetFlexMesh(
  place: (
    x: number,
    y: number,
    r: number,
    theta: number,
  ) => readonly [number, number, number],
): ApplianceFlexMesh {
  const gridSide = 9;
  const spacing = 0.0175;
  const half = ((gridSide - 1) * spacing) / 2;
  const vertices: number[] = [];
  for (let row = 0; row < gridSide; row += 1) {
    for (let col = 0; col < gridSide; col += 1) {
      const x = -half + col * spacing;
      const y = -half + row * spacing;
      vertices.push(...place(x, y, Math.hypot(x, y), Math.atan2(y, x)));
    }
  }
  const faces: number[] = [];
  for (let row = 0; row < gridSide - 1; row += 1) {
    for (let col = 0; col < gridSide - 1; col += 1) {
      const a = row * gridSide + col;
      const b = a + 1;
      const c = a + gridSide;
      const d = c + 1;
      faces.push(a, b, d, a, d, c);
    }
  }
  return {
    name: "pastry_sheet",
    dim: 2,
    vertexCount: gridSide * gridSide,
    vertices,
    faces,
  };
}

export function isPieCarrierOrStore(carrier: string, store: string): boolean {
  return (
    carrier.startsWith("pie-tray") ||
    store === "clean-pie-trays" ||
    store === "pie-bench" ||
    store === "oven-pie-tray" ||
    store === "oven-pie-trays" ||
    store === "pie-cooling-rack" ||
    store === "pie-packing" ||
    store === "pie-tray-wash"
  );
}

type PieCarrierLiveProgress = Readonly<{
  benchTaskId?: string | null;
  benchProgress?: number;
  scaleTaskId?: string | null;
  ovenTaskId?: string | null;
  ovenProgress?: number;
  ovenCompleted?: boolean;
}>;

type PieCarrierVisualStage =
  | "clean"
  | "lined-cavity"
  | "filled-cavity"
  | "raw-dough"
  | "oven-baking"
  | "golden-baked";

function quantizeStep(value: number, step = 0.05): number {
  return Math.round(clamp01(value) / step) * step;
}

/**
 * Canonical 9×9 (81-vertex / 128-triangle) shortcrust base draped into a 12 cm
 * fluted pie tin cavity before puff-lid sealing (`line-tins` / `fill-pies`).
 */
function createCanonicalLinedCavityFlexMesh(drapeScale = 1): ApplianceFlexMesh {
  const depth = 0.0225 * clamp01(drapeScale);
  return pastrySheetFlexMesh((x, y, r, theta) => {
    if (r < 0.049) {
      const bowl = 1 - (r / 0.049) ** 3;
      return [x, y, 0.028 - depth * bowl];
    }
    if (r <= 0.065) {
      const wallU = clamp01((r - 0.049) / 0.012);
      const flute = 0.0012 * Math.cos(theta * 16);
      return [x, y, 0.028 - depth * (1 - wallU) + flute * wallU];
    }
    const clampScale = 0.065 / r;
    return [x * clampScale, y * clampScale, 0.0265];
  });
}

function createProgressiveShellGeometry(
  canonical: ApplianceFlexMesh,
  puffLiftMm: number,
  browning: number,
  eggWash: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const bufState = createDeformablePastryBufferState();
  updateDeformablePastryBufferGeometry(
    geometry,
    bufState,
    canonical,
    puffLiftMm,
  );

  // Per-vertex Maillard radial gradient (floured shortcrust -> egg-wash -> golden puff crust)
  const vCount = canonical.vertexCount;
  const colors = new Float32Array(vCount * 3);
  const b = clamp01(browning);
  const g = clamp01(eggWash);

  const rawCenter = new THREE.Color(0xf5e7c4);
  const eggCenter = new THREE.Color(0xf7e3aa);
  const bakedCenter = new THREE.Color(0xd6862c);

  const rawRim = new THREE.Color(0xe2c792);
  const eggRim = new THREE.Color(0xdeb368);
  const bakedRim = new THREE.Color(0x843e10);

  const centerColor = rawCenter.clone().lerp(eggCenter, g).lerp(bakedCenter, b);
  const rimColor = rawRim
    .clone()
    .lerp(eggRim, g)
    .lerp(bakedRim, Math.min(1, b * 1.12));

  const blended = new THREE.Color();
  for (let i = 0; i < vCount; i += 1) {
    const x = canonical.vertices[i * 3]!;
    const y = canonical.vertices[i * 3 + 1]!;
    const rNorm = clamp01(Math.hypot(x, y) / 0.062);
    blended.copy(centerColor).lerp(rimColor, rNorm ** 1.35);
    colors[i * 3] = blended.r;
    colors[i * 3 + 1] = blended.g;
    colors[i * 3 + 2] = blended.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Builds a 460×320 mm baking tray holding three 12 cm fluted aluminium pie tins
 * topped with the 81-vertex / 128-triangle deformed pastry shell for Pantry
 * Kitchen's 3D factory & Maruzen oven stations. Each returned group owns its
 * geometries and materials so `FactoryStations` can safely dispose and rebuild
 * carrier contents across timeline scrubs.
 */
export function buildPieCarrierGroup(
  carrier: string,
  store: string,
  liveProgress: PieCarrierLiveProgress | null = null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = carrier;

  const benchTask = liveProgress?.benchTaskId ?? null;
  const scaleTask = liveProgress?.scaleTaskId ?? null;
  const ovenTask = liveProgress?.ovenTaskId ?? null;
  const qBench = quantizeStep(liveProgress?.benchProgress ?? 1);
  const qOven = quantizeStep(liveProgress?.ovenProgress ?? 0.85);

  let stage: PieCarrierVisualStage;
  let puffLiftMm = 0;
  let browning = 0;
  let eggWash = 0;
  let drapeScale = 1;

  if (store === "clean-pie-trays" || store === "pie-tray-wash") {
    stage = "clean";
  } else if (store === "pie-bench") {
    if (benchTask !== null && benchTask.includes("line-tins")) {
      stage = "lined-cavity";
      drapeScale = 0.35 + 0.65 * qBench;
    } else if (scaleTask !== null && scaleTask.includes("fill-pies")) {
      stage = "filled-cavity";
      drapeScale = 1;
    } else if (benchTask !== null && benchTask.includes("lid-pies")) {
      stage = "raw-dough";
      puffLiftMm = 0.15 + 0.55 * qBench;
      eggWash = 0.35 + 0.65 * qBench;
      browning = 0.04 * qBench;
    } else {
      stage = "raw-dough";
      puffLiftMm = 0.65;
      eggWash = 1;
      browning = 0.06;
    }
  } else if (store === "oven-pie-tray" || store === "oven-pie-trays") {
    stage = "oven-baking";
    const bakeT =
      ovenTask !== null && ovenTask.includes("bake-pies")
        ? qOven
        : liveProgress?.ovenCompleted
          ? 1
          : 0.85;
    puffLiftMm = 0.75 + 4.85 * bakeT;
    eggWash = 1;
    browning = 0.08 + 0.86 * bakeT;
  } else {
    stage = "golden-baked";
    puffLiftMm = 5.6;
    eggWash = 1;
    browning = 0.94;
  }

  group.userData = {
    pieStage: stage,
    puffLiftMm: Number(puffLiftMm.toFixed(2)),
    browningPct: Math.round(browning * 100),
    vertexCount: stage === "clean" ? 0 : 81,
    triangleCount: stage === "clean" ? 0 : 128,
  };

  const trayGeo = new RoundedBoxGeometry(0.46, 0.024, 0.32, 3, 0.006);
  const trayMat = new THREE.MeshStandardMaterial({
    color: stage === "clean" ? 0x9ea4a8 : 0x565b60,
    roughness: 0.46,
    metalness: 0.42,
  });
  const base = new THREE.Mesh(trayGeo, trayMat);
  base.position.y = 0.012;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const tinWallGeo = new THREE.CylinderGeometry(0.061, 0.049, 0.028, 24);
  const tinRimGeo = new THREE.TorusGeometry(0.061, 0.0032, 8, 28);
  tinRimGeo.rotateX(Math.PI / 2);
  const tinMat = new THREE.MeshStandardMaterial({
    color: 0xbac0c6,
    roughness: 0.34,
    metalness: 0.72,
  });

  const isCavityStage = stage === "lined-cavity" || stage === "filled-cavity";
  const shellGeo =
    stage === "clean"
      ? null
      : createProgressiveShellGeometry(
          isCavityStage
            ? createCanonicalLinedCavityFlexMesh(drapeScale)
            : createCanonicalCrimpedPastryFlexMesh(),
          puffLiftMm,
          browning,
          eggWash,
        );
  const shellMat =
    stage === "clean"
      ? null
      : new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness:
            stage === "lined-cavity" || stage === "filled-cavity"
              ? 0.62
              : stage === "raw-dough"
                ? 0.42
                : 0.36,
          metalness: 0.02,
          emissive: new THREE.Color(
            stage === "oven-baking" ? 0xd97706 : 0x000000,
          ),
          emissiveIntensity:
            stage === "oven-baking" ? 0.12 + 0.24 * browning : 0.0,
          side: THREE.DoubleSide,
        });

  const fillingGeo =
    stage === "filled-cavity"
      ? new THREE.CylinderGeometry(0.046, 0.042, 0.014, 22)
      : null;
  const fillingMat =
    stage === "filled-cavity"
      ? new THREE.MeshStandardMaterial({
          color: 0x4d2a16,
          roughness: 0.32,
          metalness: 0.04,
        })
      : null;

  // Three 12 cm fluted pie tins aligned at (-136, 0, +136 mm) matching `pb_pie_tray`
  const tinOffsets: readonly (readonly [number, number])[] = [
    [-0.136, 0.0],
    [0.0, 0.0],
    [0.136, 0.0],
  ];
  for (const [tx, tz] of tinOffsets) {
    const tin = new THREE.Mesh(tinWallGeo, tinMat);
    tin.position.set(tx, 0.024 + 0.014, tz);
    tin.castShadow = true;
    tin.receiveShadow = true;
    const rim = new THREE.Mesh(tinRimGeo, tinMat);
    rim.position.set(tx, 0.024 + 0.028, tz);
    group.add(tin, rim);

    if (fillingGeo !== null && fillingMat !== null) {
      const gravy = new THREE.Mesh(fillingGeo, fillingMat);
      gravy.position.set(tx, 0.024 + 0.015, tz);
      group.add(gravy);
    }

    if (shellGeo !== null && shellMat !== null) {
      const shell = new THREE.Mesh(shellGeo, shellMat);
      shell.name = `${carrier}-deformed-pastry-shell`;
      shell.position.set(tx, 0.024, tz);
      shell.castShadow = true;
      shell.receiveShadow = true;
      group.add(shell);
    }
  }
  return group;
}
