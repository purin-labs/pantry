import * as THREE from "three";
import { assertNever } from "@seams/std";
import type { FloorZoneKind } from "@seams/production-simulation/floor/bakery-room";
import type {
  FixtureFinishId,
  FloorMaterialId,
  WallMaterialId,
} from "../store-interior-design";

type PbrTextureSet = Readonly<{
  map: THREE.CanvasTexture | null;
  normalMap: THREE.CanvasTexture | null;
  roughnessMap: THREE.CanvasTexture | null;
}>;

type PbrSurfaceRecipe = Readonly<{
  drawAlbedo: (ctx: CanvasRenderingContext2D, size: number) => void;
  drawHeight: (ctx: CanvasRenderingContext2D, size: number) => void;
  drawRoughness: (ctx: CanvasRenderingContext2D, size: number) => void;
  normalStrength?: number;
}>;

function gray(v: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${c}, ${c}, ${c})`;
}

function grayAlpha(v: number, alpha: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgba(${c}, ${c}, ${c}, ${alpha})`;
}

function bakeNormalCanvasFromHeight(
  heightCtx: CanvasRenderingContext2D,
  size: number,
  strength: number,
): HTMLCanvasElement | null {
  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = size;
  normalCanvas.height = size;
  const outCtx = normalCanvas.getContext("2d");
  if (outCtx === null) return null;

  const src = heightCtx.getImageData(0, 0, size, size).data;
  const heights = new Float32Array(size * size);
  for (let i = 0, p = 0; i < heights.length; i += 1, p += 4) {
    heights[i] = (src[p] ?? 128) / 255;
  }

  const outImg = outCtx.createImageData(size, size);
  const dst = outImg.data;
  const mask = size - 1;

  for (let y = 0; y < size; y += 1) {
    const ym = ((y - 1) & mask) * size;
    const yc = y * size;
    const yp = ((y + 1) & mask) * size;
    for (let x = 0; x < size; x += 1) {
      const xm = (x - 1) & mask;
      const xp = (x + 1) & mask;

      const tl = heights[ym + xm]!;
      const tc = heights[ym + x]!;
      const tr = heights[ym + xp]!;
      const ml = heights[yc + xm]!;
      const mr = heights[yc + xp]!;
      const bl = heights[yp + xm]!;
      const bc = heights[yp + x]!;
      const br = heights[yp + xp]!;

      // CanvasTexture uses flipY = true: +u is +x and +v is -y.
      const dHdu = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const dHdv = tl + 2 * tc + tr - (bl + 2 * bc + br);
      const nx = -dHdu * strength;
      const ny = -dHdv * strength;
      const nz = 1;
      const invLen = 1 / Math.hypot(nx, ny, nz);

      const idx = (yc + x) * 4;
      dst[idx] = Math.round((nx * invLen * 0.5 + 0.5) * 255);
      dst[idx + 1] = Math.round((ny * invLen * 0.5 + 0.5) * 255);
      dst[idx + 2] = Math.round((nz * invLen * 0.5 + 0.5) * 255);
      dst[idx + 3] = 255;
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return normalCanvas;
}

/** Textures belong to one shell. No texture is shared across renderers or shell lifetimes. */
export class FloorPlanTextures {
  private readonly textures = new Map<string, THREE.CanvasTexture>();

  private configureTexture(
    canvas: HTMLCanvasElement,
    colorSpace: THREE.ColorSpace,
    repeatPerMeter: number,
    widthMeters: number,
    depthMeters: number,
  ): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.repeat.set(
      Math.max(1, widthMeters * repeatPerMeter),
      Math.max(1, depthMeters * repeatPerMeter),
    );
    return texture;
  }

  create(
    key: string,
    repeatPerMeter: number,
    widthMeters: number,
    depthMeters: number,
    draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  ): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const cacheKey = `${key}:${repeatPerMeter}:${widthMeters}:${depthMeters}`;
    const cached = this.textures.get(cacheKey);
    if (cached !== undefined) return cached;
    const canvas = document.createElement("canvas");
    const size = 1024;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    draw(ctx, size);
    const texture = this.configureTexture(
      canvas,
      THREE.SRGBColorSpace,
      repeatPerMeter,
      widthMeters,
      depthMeters,
    );
    this.textures.set(cacheKey, texture);
    return texture;
  }

  createPbr(
    key: string,
    repeatPerMeter: number,
    widthMeters: number,
    depthMeters: number,
    recipe: PbrSurfaceRecipe,
  ): PbrTextureSet {
    if (typeof document === "undefined") {
      return { map: null, normalMap: null, roughnessMap: null };
    }
    const baseKey = `${key}:${repeatPerMeter}:${widthMeters}:${depthMeters}`;
    const map = this.create(
      key,
      repeatPerMeter,
      widthMeters,
      depthMeters,
      recipe.drawAlbedo,
    );

    const normalKey = `${baseKey}:normal`;
    let normalMap = this.textures.get(normalKey) ?? null;
    if (normalMap === null) {
      const pbrSize = 512; // Must remain power-of-two for wrap-around mask.
      const heightCanvas = document.createElement("canvas");
      heightCanvas.width = pbrSize;
      heightCanvas.height = pbrSize;
      const heightCtx = heightCanvas.getContext("2d");
      if (heightCtx !== null) {
        recipe.drawHeight(heightCtx, pbrSize);
        const normalCanvas = bakeNormalCanvasFromHeight(
          heightCtx,
          pbrSize,
          recipe.normalStrength ?? 1.5,
        );
        if (normalCanvas !== null) {
          normalMap = this.configureTexture(
            normalCanvas,
            THREE.NoColorSpace,
            repeatPerMeter,
            widthMeters,
            depthMeters,
          );
          this.textures.set(normalKey, normalMap);
        }
      }
    }

    const roughKey = `${baseKey}:roughness`;
    let roughnessMap = this.textures.get(roughKey) ?? null;
    if (roughnessMap === null) {
      const pbrSize = 512;
      const roughCanvas = document.createElement("canvas");
      roughCanvas.width = pbrSize;
      roughCanvas.height = pbrSize;
      const roughCtx = roughCanvas.getContext("2d");
      if (roughCtx !== null) {
        recipe.drawRoughness(roughCtx, pbrSize);
        roughnessMap = this.configureTexture(
          roughCanvas,
          THREE.NoColorSpace,
          repeatPerMeter,
          widthMeters,
          depthMeters,
        );
        this.textures.set(roughKey, roughnessMap);
      }
    }

    return { map, normalMap, roughnessMap };
  }

  dispose(extraTextures?: Iterable<THREE.Texture>): void {
    const unique = new Set<THREE.Texture>(this.textures.values());
    if (extraTextures !== undefined) {
      for (const texture of extraTextures) unique.add(texture);
    }
    for (const texture of unique) texture.dispose();
    this.textures.clear();
  }
}

function drawWoodGrainBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  baseColor: string,
  grainColor: string,
  highlightColor: string,
  seed: number,
): void {
  const s = Math.max(0.5, (w + h) / 400);
  const grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, highlightColor);
  grad.addColorStop(0.5, baseColor);
  grad.addColorStop(1, baseColor);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = grainColor;
  ctx.lineWidth = 1.1 * s;
  const lines = 5;
  for (let i = 1; i <= lines; i += 1) {
    const t = i / (lines + 1);
    const wave = (((seed * 17 + i * 31) % 11) - 5) * 1.2 * s;
    ctx.beginPath();
    if (w >= h) {
      const py = y + h * t;
      ctx.moveTo(x + 2 * s, py);
      ctx.quadraticCurveTo(x + w * 0.5, py + wave, x + w - 2 * s, py);
    } else {
      const px = x + w * t;
      ctx.moveTo(px, y + 2 * s);
      ctx.quadraticCurveTo(px + wave, y + h * 0.5, px, y + h - 2 * s);
    }
    ctx.stroke();
  }
}

function drawFloorPattern(
  materialId: FloorMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (materialId) {
    case "herringbone-oak": {
      ctx.fillStyle = "#b89668";
      ctx.fillRect(0, 0, size, size);
      // Basket-chevron / French parquet oak pattern with rich wood grain and bevels
      const modules = 4;
      const modSize = size / modules;
      const staves = 3;
      const staveThick = modSize / staves;
      const tones: ReadonlyArray<readonly [string, string, string]> = [
        ["#cfa978", "#d8b78a", "rgba(92, 60, 28, 0.16)"],
        ["#c39c6b", "#ceaa7c", "rgba(86, 55, 25, 0.18)"],
        ["#d5b284", "#dfc096", "rgba(96, 64, 32, 0.14)"],
        ["#ba9260", "#c6a070", "rgba(78, 49, 21, 0.2)"],
        ["#c8a373", "#d3b083", "rgba(88, 58, 28, 0.16)"],
      ];
      for (let mr = 0; mr < modules; mr += 1) {
        for (let mc = 0; mc < modules; mc += 1) {
          const mx = mc * modSize;
          const my = mr * modSize;
          const horizontal = (mr + mc) % 2 === 0;
          for (let s = 0; s < staves; s += 1) {
            const seed = mr * 19 + mc * 7 + s * 3;
            const [base, hi, grain] = tones[seed % tones.length]!;
            const bx = horizontal ? mx : mx + s * staveThick;
            const by = horizontal ? my + s * staveThick : my;
            const bw = horizontal ? modSize : staveThick;
            const bh = horizontal ? staveThick : modSize;
            drawWoodGrainBlock(
              ctx,
              bx + 1.5 * k,
              by + 1.5 * k,
              bw - 3 * k,
              bh - 3 * k,
              base,
              grain,
              hi,
              seed,
            );
            // Warm inner highlight + dark V-groove bevel
            ctx.strokeStyle = "rgba(255, 238, 210, 0.22)";
            ctx.lineWidth = 1 * k;
            ctx.strokeRect(bx + 2 * k, by + 2 * k, bw - 4 * k, bh - 4 * k);
            ctx.strokeStyle = "rgba(68, 45, 22, 0.34)";
            ctx.lineWidth = 1.6 * k;
            ctx.strokeRect(
              bx + 0.8 * k,
              by + 0.8 * k,
              bw - 1.6 * k,
              bh - 1.6 * k,
            );
          }
        }
      }
      break;
    }
    case "terrazzo-stone": {
      ctx.fillStyle = "#dfd9cd";
      ctx.fillRect(0, 0, size, size);
      // Subtle mineral binder clouding
      for (let i = 0; i < 18; i += 1) {
        const gx = ((i * 193 + 47) % 997) * (size / 997);
        const gy = ((i * 317 + 89) % 991) * (size / 991);
        const r = size * (0.12 + (i % 4) * 0.04);
        const rad = ctx.createRadialGradient(gx, gy, 4 * k, gx, gy, r);
        rad.addColorStop(
          0,
          i % 2 === 0
            ? "rgba(248, 244, 236, 0.28)"
            : "rgba(186, 178, 164, 0.18)",
        );
        rad.addColorStop(1, "rgba(223, 217, 205, 0)");
        ctx.fillStyle = rad;
        ctx.fillRect(0, 0, size, size);
      }
      // Polygonal marble, travertine, sienna, and quartz aggregate chips
      const chipColors = [
        "#9e9587",
        "#6f6a63",
        "#c48768",
        "#f2eee6",
        "#838f82",
        "#b89f78",
        "#54504a",
        "#d8cfc0",
      ];
      for (let i = 0; i < 420; i += 1) {
        const px = ((i * 173 + 29) % 997) * (size / 997);
        const py = ((i * 311 + 71) % 991) * (size / 991);
        const baseR = (3.5 + (i % 9) * 2.1) * k;
        const verts = 5 + (i % 3);
        const rot = (i % 11) * 0.57;
        ctx.fillStyle = chipColors[i % chipColors.length]!;
        ctx.beginPath();
        for (let v = 0; v < verts; v += 1) {
          const ang = rot + (v * Math.PI * 2) / verts;
          const jitter = 0.72 + (((i * 7 + v * 13) % 7) / 7) * 0.45;
          const vx = px + Math.cos(ang) * baseR * jitter;
          const vy = py + Math.sin(ang) * baseR * jitter * 0.82;
          if (v === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 252, 245, 0.28)";
        ctx.lineWidth = 0.8 * k;
        ctx.stroke();
      }
      // Brass terrazzo divider inlay strips
      const step = size / 2;
      for (let i = step; i < size; i += step) {
        ctx.strokeStyle = "rgba(110, 102, 90, 0.32)";
        ctx.lineWidth = 4 * k;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();

        ctx.strokeStyle = "rgba(198, 162, 94, 0.65)";
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }
      break;
    }
    case "limestone-checker": {
      ctx.fillStyle = "#cfc7b6";
      ctx.fillRect(0, 0, size, size);
      const grid = 4;
      const cell = size / grid;
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const x = c * cell;
          const y = r * cell;
          const even = (r + c) % 2 === 0;
          const grad = ctx.createLinearGradient(x, y, x + cell, y + cell);
          grad.addColorStop(0, even ? "#ece6da" : "#dfd8c8");
          grad.addColorStop(0.5, even ? "#e5dfd1" : "#d8d0bf");
          grad.addColorStop(1, even ? "#ddd6c6" : "#cfc6b4");
          ctx.fillStyle = grad;
          ctx.fillRect(x + 2.5 * k, y + 2.5 * k, cell - 5 * k, cell - 5 * k);

          // Delicate limestone sedimentary veins
          ctx.strokeStyle = "rgba(145, 136, 120, 0.16)";
          ctx.lineWidth = 1.2 * k;
          ctx.beginPath();
          ctx.moveTo(x + 12 * k, y + cell * 0.32);
          ctx.bezierCurveTo(
            x + cell * 0.4,
            y + cell * 0.24,
            x + cell * 0.65,
            y + cell * 0.48,
            x + cell - 12 * k,
            y + cell * 0.38,
          );
          ctx.stroke();

          ctx.strokeStyle = "rgba(255, 252, 244, 0.45)";
          ctx.lineWidth = 1.4 * k;
          ctx.strokeRect(
            x + 3.2 * k,
            y + 3.2 * k,
            cell - 6.4 * k,
            cell - 6.4 * k,
          );
        }
      }
      // Seamless Nero Marquina dark marble cabochon diamonds at every intersection
      const cab = 22 * k;
      for (let r = 0; r <= grid; r += 1) {
        for (let c = 0; c <= grid; c += 1) {
          const ix = c * cell;
          const iy = r * cell;
          ctx.fillStyle = "#2f3331";
          ctx.beginPath();
          ctx.moveTo(ix, iy - cab);
          ctx.lineTo(ix + cab, iy);
          ctx.lineTo(ix, iy + cab);
          ctx.lineTo(ix - cab, iy);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "rgba(235, 228, 212, 0.45)";
          ctx.lineWidth = 1.2 * k;
          ctx.stroke();
        }
      }
      break;
    }
    case "quarry-terracotta": {
      ctx.fillStyle = "#754c39";
      ctx.fillRect(0, 0, size, size);
      const grid = 6;
      const cell = size / grid;
      const clayTones: ReadonlyArray<readonly [string, string]> = [
        ["#c67f5b", "#a96342"],
        ["#ba7350", "#9e5a3b"],
        ["#ce8763", "#b16a48"],
        ["#b36c4a", "#965436"],
      ];
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const x = c * cell;
          const y = r * cell;
          const [centerCol, edgeCol] =
            clayTones[(r * 5 + c * 3) % clayTones.length]!;
          const cx = x + cell * 0.5;
          const cy = y + cell * 0.5;
          const rad = ctx.createRadialGradient(
            cx,
            cy,
            cell * 0.08,
            cx,
            cy,
            cell * 0.68,
          );
          rad.addColorStop(0, centerCol);
          rad.addColorStop(1, edgeCol);
          ctx.fillStyle = rad;
          ctx.fillRect(x + 4 * k, y + 4 * k, cell - 8 * k, cell - 8 * k);
          ctx.strokeStyle = "rgba(255, 214, 186, 0.22)";
          ctx.lineWidth = 1.4 * k;
          ctx.strokeRect(x + 5 * k, y + 5 * k, cell - 10 * k, cell - 10 * k);
        }
      }
      break;
    }
    case "smoked-cedar": {
      ctx.fillStyle = "#4a3525";
      ctx.fillRect(0, 0, size, size);
      const planks = 6;
      const pw = size / planks;
      const cedarTones: ReadonlyArray<readonly [string, string, string]> = [
        ["#755740", "#82634b", "rgba(38, 24, 14, 0.25)"],
        ["#684c37", "#745740", "rgba(32, 20, 11, 0.28)"],
        ["#7d5e46", "#8a6a51", "rgba(42, 27, 15, 0.22)"],
        ["#604531", "#6c4f3a", "rgba(30, 18, 10, 0.3)"],
      ];
      for (let c = 0; c < planks; c += 1) {
        const x = c * pw;
        const [base, hi, grain] = cedarTones[c % cedarTones.length]!;
        const jointY = (((c * 271 + 140) % 864) + 80) * k;
        drawWoodGrainBlock(
          ctx,
          x + 2 * k,
          0,
          pw - 4 * k,
          jointY - 2 * k,
          base,
          grain,
          hi,
          c,
        );
        drawWoodGrainBlock(
          ctx,
          x + 2 * k,
          jointY + 2 * k,
          pw - 4 * k,
          size - jointY - 2 * k,
          hi,
          grain,
          base,
          c + 11,
        );
        ctx.strokeStyle = "rgba(255, 224, 192, 0.14)";
        ctx.lineWidth = 1.2 * k;
        ctx.strokeRect(x + 2.5 * k, 1 * k, pw - 5 * k, size - 2 * k);
      }
      break;
    }
    default:
      assertNever(materialId);
  }
}

function drawFloorHeight(
  materialId: FloorMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (materialId) {
    case "herringbone-oak": {
      ctx.fillStyle = gray(0.08);
      ctx.fillRect(0, 0, size, size);
      const modules = 4;
      const modSize = size / modules;
      const staves = 3;
      const staveThick = modSize / staves;
      for (let mr = 0; mr < modules; mr += 1) {
        for (let mc = 0; mc < modules; mc += 1) {
          const mx = mc * modSize;
          const my = mr * modSize;
          const horizontal = (mr + mc) % 2 === 0;
          for (let s = 0; s < staves; s += 1) {
            const seed = mr * 19 + mc * 7 + s * 3;
            const staveH = 0.84 + ((seed % 5) - 2) * 0.025;
            const bx = horizontal ? mx : mx + s * staveThick;
            const by = horizontal ? my + s * staveThick : my;
            const bw = horizontal ? modSize : staveThick;
            const bh = horizontal ? staveThick : modSize;
            ctx.fillStyle = gray(0.48);
            ctx.fillRect(bx + 1.5 * k, by + 1.5 * k, bw - 3 * k, bh - 3 * k);
            drawWoodGrainBlock(
              ctx,
              bx + 3.2 * k,
              by + 3.2 * k,
              bw - 6.4 * k,
              bh - 6.4 * k,
              gray(staveH),
              grayAlpha(staveH - 0.12, 0.85),
              gray(staveH + 0.03),
              seed,
            );
          }
        }
      }
      break;
    }
    case "terrazzo-stone": {
      ctx.fillStyle = gray(0.72);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 420; i += 1) {
        const px = ((i * 173 + 29) % 997) * (size / 997);
        const py = ((i * 311 + 71) % 991) * (size / 991);
        const baseR = (3.5 + (i % 9) * 2.1) * k;
        const verts = 5 + (i % 3);
        const rot = (i % 11) * 0.57;
        ctx.fillStyle = gray(0.82 + (i % 3) * 0.02);
        ctx.beginPath();
        for (let v = 0; v < verts; v += 1) {
          const ang = rot + (v * Math.PI * 2) / verts;
          const jitter = 0.72 + (((i * 7 + v * 13) % 7) / 7) * 0.45;
          const vx = px + Math.cos(ang) * baseR * jitter;
          const vy = py + Math.sin(ang) * baseR * jitter * 0.82;
          if (v === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
      }
      const step = size / 2;
      for (let i = step; i < size; i += step) {
        ctx.strokeStyle = gray(0.34);
        ctx.lineWidth = 4.5 * k;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();

        ctx.strokeStyle = gray(0.95);
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }
      break;
    }
    case "limestone-checker": {
      ctx.fillStyle = gray(0.12);
      ctx.fillRect(0, 0, size, size);
      const grid = 4;
      const cell = size / grid;
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const x = c * cell;
          const y = r * cell;
          ctx.fillStyle = gray(0.55);
          ctx.fillRect(
            x + 2.2 * k,
            y + 2.2 * k,
            cell - 4.4 * k,
            cell - 4.4 * k,
          );
          ctx.fillStyle = gray((r + c) % 2 === 0 ? 0.86 : 0.83);
          ctx.fillRect(x + 4.5 * k, y + 4.5 * k, cell - 9 * k, cell - 9 * k);
          ctx.strokeStyle = gray(0.68);
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(x + 12 * k, y + cell * 0.32);
          ctx.bezierCurveTo(
            x + cell * 0.4,
            y + cell * 0.24,
            x + cell * 0.65,
            y + cell * 0.48,
            x + cell - 12 * k,
            y + cell * 0.38,
          );
          ctx.stroke();
        }
      }
      const cab = 22 * k;
      for (let r = 0; r <= grid; r += 1) {
        for (let c = 0; c <= grid; c += 1) {
          const ix = c * cell;
          const iy = r * cell;
          ctx.fillStyle = gray(0.92);
          ctx.beginPath();
          ctx.moveTo(ix, iy - cab);
          ctx.lineTo(ix + cab, iy);
          ctx.lineTo(ix, iy + cab);
          ctx.lineTo(ix - cab, iy);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = gray(0.14);
          ctx.lineWidth = 2.2 * k;
          ctx.stroke();
        }
      }
      break;
    }
    case "quarry-terracotta": {
      ctx.fillStyle = gray(0.08);
      ctx.fillRect(0, 0, size, size);
      const grid = 6;
      const cell = size / grid;
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const x = c * cell;
          const y = r * cell;
          const cx = x + cell * 0.5;
          const cy = y + cell * 0.5;
          const rad = ctx.createRadialGradient(
            cx,
            cy,
            cell * 0.06,
            cx,
            cy,
            cell * 0.66,
          );
          rad.addColorStop(0, gray(0.92));
          rad.addColorStop(0.78, gray(0.76));
          rad.addColorStop(1, gray(0.46));
          ctx.fillStyle = rad;
          ctx.fillRect(x + 4 * k, y + 4 * k, cell - 8 * k, cell - 8 * k);
        }
      }
      break;
    }
    case "smoked-cedar": {
      ctx.fillStyle = gray(0.06);
      ctx.fillRect(0, 0, size, size);
      const planks = 6;
      const pw = size / planks;
      for (let c = 0; c < planks; c += 1) {
        const x = c * pw;
        const jointY = (((c * 271 + 140) % 864) + 80) * k;
        const hBase = 0.84 + ((c % 3) - 1) * 0.03;
        drawWoodGrainBlock(
          ctx,
          x + 2.5 * k,
          1.5 * k,
          pw - 5 * k,
          jointY - 3.5 * k,
          gray(hBase),
          grayAlpha(hBase - 0.16, 0.9),
          gray(hBase + 0.04),
          c,
        );
        drawWoodGrainBlock(
          ctx,
          x + 2.5 * k,
          jointY + 2 * k,
          pw - 5 * k,
          size - jointY - 3.5 * k,
          gray(hBase + 0.02),
          grayAlpha(hBase - 0.16, 0.9),
          gray(hBase - 0.02),
          c + 11,
        );
      }
      break;
    }
    default:
      assertNever(materialId);
  }
}

function drawFloorRoughness(
  materialId: FloorMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (materialId) {
    case "herringbone-oak": {
      ctx.fillStyle = gray(0.88);
      ctx.fillRect(0, 0, size, size);
      const modules = 4;
      const modSize = size / modules;
      const staves = 3;
      const staveThick = modSize / staves;
      const roughTones = [0.38, 0.43, 0.35, 0.46, 0.4];
      for (let mr = 0; mr < modules; mr += 1) {
        for (let mc = 0; mc < modules; mc += 1) {
          const mx = mc * modSize;
          const my = mr * modSize;
          const horizontal = (mr + mc) % 2 === 0;
          for (let s = 0; s < staves; s += 1) {
            const seed = mr * 19 + mc * 7 + s * 3;
            const rVal = roughTones[seed % roughTones.length]!;
            const bx = horizontal ? mx : mx + s * staveThick;
            const by = horizontal ? my + s * staveThick : my;
            const bw = horizontal ? modSize : staveThick;
            const bh = horizontal ? staveThick : modSize;
            drawWoodGrainBlock(
              ctx,
              bx + 2 * k,
              by + 2 * k,
              bw - 4 * k,
              bh - 4 * k,
              gray(rVal),
              grayAlpha(rVal + 0.18, 0.8),
              gray(rVal - 0.04),
              seed,
            );
          }
        }
      }
      break;
    }
    case "terrazzo-stone": {
      ctx.fillStyle = gray(0.4);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 420; i += 1) {
        const px = ((i * 173 + 29) % 997) * (size / 997);
        const py = ((i * 311 + 71) % 991) * (size / 991);
        const baseR = (3.5 + (i % 9) * 2.1) * k;
        const verts = 5 + (i % 3);
        const rot = (i % 11) * 0.57;
        ctx.fillStyle = gray(0.18 + (i % 4) * 0.025);
        ctx.beginPath();
        for (let v = 0; v < verts; v += 1) {
          const ang = rot + (v * Math.PI * 2) / verts;
          const jitter = 0.72 + (((i * 7 + v * 13) % 7) / 7) * 0.45;
          const vx = px + Math.cos(ang) * baseR * jitter;
          const vy = py + Math.sin(ang) * baseR * jitter * 0.82;
          if (v === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
      }
      const step = size / 2;
      for (let i = step; i < size; i += step) {
        ctx.strokeStyle = gray(0.76);
        ctx.lineWidth = 4.2 * k;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();

        ctx.strokeStyle = gray(0.14);
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }
      break;
    }
    case "limestone-checker": {
      ctx.fillStyle = gray(0.9);
      ctx.fillRect(0, 0, size, size);
      const grid = 4;
      const cell = size / grid;
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const x = c * cell;
          const y = r * cell;
          const even = (r + c) % 2 === 0;
          ctx.fillStyle = gray(even ? 0.35 : 0.41);
          ctx.fillRect(x + 3 * k, y + 3 * k, cell - 6 * k, cell - 6 * k);
          ctx.strokeStyle = gray(0.6);
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(x + 12 * k, y + cell * 0.32);
          ctx.bezierCurveTo(
            x + cell * 0.4,
            y + cell * 0.24,
            x + cell * 0.65,
            y + cell * 0.48,
            x + cell - 12 * k,
            y + cell * 0.38,
          );
          ctx.stroke();
        }
      }
      const cab = 22 * k;
      for (let r = 0; r <= grid; r += 1) {
        for (let c = 0; c <= grid; c += 1) {
          const ix = c * cell;
          const iy = r * cell;
          ctx.fillStyle = gray(0.16);
          ctx.beginPath();
          ctx.moveTo(ix, iy - cab);
          ctx.lineTo(ix + cab, iy);
          ctx.lineTo(ix, iy + cab);
          ctx.lineTo(ix - cab, iy);
          ctx.closePath();
          ctx.fill();
        }
      }
      break;
    }
    case "quarry-terracotta": {
      ctx.fillStyle = gray(0.94);
      ctx.fillRect(0, 0, size, size);
      const grid = 6;
      const cell = size / grid;
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const x = c * cell;
          const y = r * cell;
          const cx = x + cell * 0.5;
          const cy = y + cell * 0.5;
          const rad = ctx.createRadialGradient(
            cx,
            cy,
            cell * 0.08,
            cx,
            cy,
            cell * 0.66,
          );
          rad.addColorStop(0, gray(0.5 + ((r + c) % 2) * 0.04));
          rad.addColorStop(1, gray(0.66));
          ctx.fillStyle = rad;
          ctx.fillRect(x + 4 * k, y + 4 * k, cell - 8 * k, cell - 8 * k);
        }
      }
      break;
    }
    case "smoked-cedar": {
      ctx.fillStyle = gray(0.9);
      ctx.fillRect(0, 0, size, size);
      const planks = 6;
      const pw = size / planks;
      for (let c = 0; c < planks; c += 1) {
        const x = c * pw;
        const jointY = (((c * 271 + 140) % 864) + 80) * k;
        const rBase = 0.44 + (c % 3) * 0.04;
        drawWoodGrainBlock(
          ctx,
          x + 2.5 * k,
          1.5 * k,
          pw - 5 * k,
          jointY - 3.5 * k,
          gray(rBase),
          grayAlpha(rBase + 0.2, 0.85),
          gray(rBase - 0.04),
          c,
        );
        drawWoodGrainBlock(
          ctx,
          x + 2.5 * k,
          jointY + 2 * k,
          pw - 5 * k,
          size - jointY - 3.5 * k,
          gray(rBase + 0.02),
          grayAlpha(rBase + 0.2, 0.85),
          gray(rBase),
          c + 11,
        );
      }
      break;
    }
    default:
      assertNever(materialId);
  }
}

export function floorPbrRecipe(materialId: FloorMaterialId): PbrSurfaceRecipe {
  return {
    drawAlbedo: drawFloorPattern.bind(null, materialId),
    drawHeight: drawFloorHeight.bind(null, materialId),
    drawRoughness: drawFloorRoughness.bind(null, materialId),
    normalStrength:
      materialId === "terrazzo-stone" || materialId === "limestone-checker"
        ? 1.15
        : 1.6,
  };
}

function drawWetTilePattern(
  kind: Exclude<FloorZoneKind, "main">,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  const bg =
    kind === "wet"
      ? "#9aa8ac"
      : kind === "toilet"
        ? "#b8b1a3"
        : kind === "corridor"
          ? "#aeb3a8"
          : "#b5ae9f";
  const tile =
    kind === "wet"
      ? "#cad6d9"
      : kind === "toilet"
        ? "#e2ddd2"
        : kind === "corridor"
          ? "#d2d6cc"
          : "#d8d2c5";
  const tileAlt =
    kind === "wet"
      ? "#c1ced1"
      : kind === "toilet"
        ? "#dad4c8"
        : kind === "corridor"
          ? "#c9cdc3"
          : "#cfc8ba";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const grid = kind === "toilet" ? 12 : 8;
  const step = size / grid;
  for (let r = 0; r < grid; r += 1) {
    for (let c = 0; c < grid; c += 1) {
      const x = c * step;
      const y = r * step;
      ctx.fillStyle = (r + c) % 2 === 0 ? tile : tileAlt;
      ctx.fillRect(x + 2.5 * k, y + 2.5 * k, step - 5 * k, step - 5 * k);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.38)";
      ctx.lineWidth = 1.2 * k;
      ctx.strokeRect(x + 3.2 * k, y + 3.2 * k, step - 6.4 * k, step - 6.4 * k);
    }
  }
}

function drawWetTileHeight(
  kind: Exclude<FloorZoneKind, "main">,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  ctx.fillStyle = gray(0.1);
  ctx.fillRect(0, 0, size, size);
  const grid = kind === "toilet" ? 12 : 8;
  const step = size / grid;
  for (let r = 0; r < grid; r += 1) {
    for (let c = 0; c < grid; c += 1) {
      const x = c * step;
      const y = r * step;
      ctx.fillStyle = gray(0.54);
      ctx.fillRect(x + 2.2 * k, y + 2.2 * k, step - 4.4 * k, step - 4.4 * k);
      ctx.fillStyle = gray((r + c) % 2 === 0 ? 0.88 : 0.85);
      ctx.fillRect(x + 4.4 * k, y + 4.4 * k, step - 8.8 * k, step - 8.8 * k);
    }
  }
}

function drawWetTileRoughness(
  kind: Exclude<FloorZoneKind, "main">,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  ctx.fillStyle = gray(0.9);
  ctx.fillRect(0, 0, size, size);
  const grid = kind === "toilet" ? 12 : 8;
  const step = size / grid;
  for (let r = 0; r < grid; r += 1) {
    for (let c = 0; c < grid; c += 1) {
      const x = c * step;
      const y = r * step;
      ctx.fillStyle = gray((r + c) % 2 === 0 ? 0.32 : 0.36);
      ctx.fillRect(x + 3 * k, y + 3 * k, step - 6 * k, step - 6 * k);
    }
  }
}

export function wetTilePbrRecipe(
  kind: Exclude<FloorZoneKind, "main">,
): PbrSurfaceRecipe {
  return {
    drawAlbedo: drawWetTilePattern.bind(null, kind),
    drawHeight: drawWetTileHeight.bind(null, kind),
    drawRoughness: drawWetTileRoughness.bind(null, kind),
    normalStrength: 1.45,
  };
}

function drawWallSurfacePattern(
  wallMaterial: WallMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (wallMaterial) {
    case "limewash-hinoki": {
      ctx.fillStyle = "#ece4d3";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 28; i += 1) {
        const x = ((i * 197 + 43) % 997) * (size / 997);
        const y = ((i * 313 + 79) % 991) * (size / 991);
        const r = size * (0.14 + (i % 5) * 0.045);
        const rad = ctx.createRadialGradient(x, y, 8 * k, x, y, r);
        rad.addColorStop(
          0,
          i % 2 === 0
            ? "rgba(255, 251, 242, 0.32)"
            : "rgba(218, 208, 188, 0.24)",
        );
        rad.addColorStop(1, "rgba(236, 228, 211, 0)");
        ctx.fillStyle = rad;
        ctx.fillRect(0, 0, size, size);
      }
      break;
    }
    case "parisian-boiserie": {
      ctx.fillStyle = "#f2ede2";
      ctx.fillRect(0, 0, size, size);
      const panels = 2;
      const pw = size / panels;
      for (let p = 0; p < panels; p += 1) {
        const px = p * pw;
        ctx.strokeStyle = "rgba(182, 173, 156, 0.42)";
        ctx.lineWidth = 4 * k;
        ctx.strokeRect(px + 28 * k, 28 * k, pw - 56 * k, size - 56 * k);
        ctx.strokeStyle = "rgba(255, 253, 248, 0.72)";
        ctx.lineWidth = 2 * k;
        ctx.strokeRect(px + 32 * k, 32 * k, pw - 64 * k, size - 64 * k);
      }
      break;
    }
    case "board-concrete": {
      ctx.fillStyle = "#cccfc8";
      ctx.fillRect(0, 0, size, size);
      const boards = 8;
      const bw = size / boards;
      for (let b = 0; b < boards; b += 1) {
        const bx = b * bw;
        ctx.fillStyle = b % 2 === 0 ? "#cfd2cb" : "#c6c9c2";
        ctx.fillRect(bx + 1 * k, 0, bw - 2 * k, size);
        ctx.strokeStyle = "rgba(96, 100, 94, 0.28)";
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.moveTo(bx, 0);
        ctx.lineTo(bx, size);
        ctx.stroke();
      }
      // Architectural tie-rod form holes
      for (const ty of [size * 0.28, size * 0.72]) {
        for (const tx of [size * 0.25, size * 0.75]) {
          ctx.fillStyle = "rgba(82, 86, 80, 0.48)";
          ctx.beginPath();
          ctx.arc(tx, ty, 6 * k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case "juraku-lattice": {
      ctx.fillStyle = "#dcd0b9";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 320; i += 1) {
        const px = ((i * 163 + 19) % 997) * (size / 997);
        const py = ((i * 293 + 53) % 991) * (size / 991);
        ctx.fillStyle =
          i % 3 === 0
            ? "rgba(255, 246, 224, 0.35)"
            : "rgba(146, 122, 92, 0.22)";
        ctx.fillRect(px, py, (3 + (i % 5)) * k, 1.5 * k);
      }
      break;
    }
    default:
      assertNever(wallMaterial);
  }
}

function drawWallSurfaceHeight(
  wallMaterial: WallMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (wallMaterial) {
    case "limewash-hinoki": {
      ctx.fillStyle = gray(0.6);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 28; i += 1) {
        const x = ((i * 197 + 43) % 997) * (size / 997);
        const y = ((i * 313 + 79) % 991) * (size / 991);
        const r = size * (0.14 + (i % 5) * 0.045);
        const rad = ctx.createRadialGradient(x, y, 8 * k, x, y, r);
        rad.addColorStop(0, grayAlpha(i % 2 === 0 ? 0.78 : 0.42, 0.35));
        rad.addColorStop(1, grayAlpha(0.6, 0));
        ctx.fillStyle = rad;
        ctx.fillRect(0, 0, size, size);
      }
      break;
    }
    case "parisian-boiserie": {
      ctx.fillStyle = gray(0.72);
      ctx.fillRect(0, 0, size, size);
      const panels = 2;
      const pw = size / panels;
      for (let p = 0; p < panels; p += 1) {
        const px = p * pw;
        ctx.fillStyle = gray(0.58);
        ctx.fillRect(px + 30 * k, 30 * k, pw - 60 * k, size - 60 * k);
        ctx.strokeStyle = gray(0.96);
        ctx.lineWidth = 6 * k;
        ctx.strokeRect(px + 28 * k, 28 * k, pw - 56 * k, size - 56 * k);
        ctx.strokeStyle = gray(0.32);
        ctx.lineWidth = 2.4 * k;
        ctx.strokeRect(px + 33 * k, 33 * k, pw - 66 * k, size - 66 * k);
      }
      break;
    }
    case "board-concrete": {
      ctx.fillStyle = gray(0.16);
      ctx.fillRect(0, 0, size, size);
      const boards = 8;
      const bw = size / boards;
      for (let b = 0; b < boards; b += 1) {
        const bx = b * bw;
        const hBoard = b % 2 === 0 ? 0.72 : 0.67;
        drawWoodGrainBlock(
          ctx,
          bx + 2 * k,
          0,
          bw - 4 * k,
          size,
          gray(hBoard),
          grayAlpha(hBoard - 0.1, 0.7),
          gray(hBoard + 0.04),
          b + 5,
        );
      }
      for (const ty of [size * 0.28, size * 0.72]) {
        for (const tx of [size * 0.25, size * 0.75]) {
          const rad = ctx.createRadialGradient(tx, ty, 1 * k, tx, ty, 8 * k);
          rad.addColorStop(0, gray(0.05));
          rad.addColorStop(0.75, gray(0.28));
          rad.addColorStop(1, gray(0.7));
          ctx.fillStyle = rad;
          ctx.beginPath();
          ctx.arc(tx, ty, 8 * k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case "juraku-lattice": {
      ctx.fillStyle = gray(0.58);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 320; i += 1) {
        const px = ((i * 163 + 19) % 997) * (size / 997);
        const py = ((i * 293 + 53) % 991) * (size / 991);
        ctx.fillStyle = gray(i % 3 === 0 ? 0.84 : 0.36);
        ctx.fillRect(px, py, (3 + (i % 5)) * k, 2 * k);
      }
      break;
    }
    default:
      assertNever(wallMaterial);
  }
}

function drawWallSurfaceRoughness(
  wallMaterial: WallMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (wallMaterial) {
    case "limewash-hinoki": {
      ctx.fillStyle = gray(0.78);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 28; i += 1) {
        const x = ((i * 197 + 43) % 997) * (size / 997);
        const y = ((i * 313 + 79) % 991) * (size / 991);
        const r = size * (0.14 + (i % 5) * 0.045);
        const rad = ctx.createRadialGradient(x, y, 8 * k, x, y, r);
        rad.addColorStop(0, grayAlpha(i % 2 === 0 ? 0.7 : 0.86, 0.45));
        rad.addColorStop(1, grayAlpha(0.78, 0));
        ctx.fillStyle = rad;
        ctx.fillRect(0, 0, size, size);
      }
      break;
    }
    case "parisian-boiserie": {
      ctx.fillStyle = gray(0.58);
      ctx.fillRect(0, 0, size, size);
      const panels = 2;
      const pw = size / panels;
      for (let p = 0; p < panels; p += 1) {
        const px = p * pw;
        ctx.strokeStyle = gray(0.42);
        ctx.lineWidth = 6 * k;
        ctx.strokeRect(px + 28 * k, 28 * k, pw - 56 * k, size - 56 * k);
      }
      break;
    }
    case "board-concrete": {
      ctx.fillStyle = gray(0.84);
      ctx.fillRect(0, 0, size, size);
      const boards = 8;
      const bw = size / boards;
      for (let b = 0; b < boards; b += 1) {
        const bx = b * bw;
        ctx.fillStyle = gray(b % 2 === 0 ? 0.78 : 0.83);
        ctx.fillRect(bx + 2 * k, 0, bw - 4 * k, size);
      }
      for (const ty of [size * 0.28, size * 0.72]) {
        for (const tx of [size * 0.25, size * 0.75]) {
          ctx.fillStyle = gray(0.95);
          ctx.beginPath();
          ctx.arc(tx, ty, 6.5 * k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case "juraku-lattice": {
      ctx.fillStyle = gray(0.82);
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 320; i += 1) {
        const px = ((i * 163 + 19) % 997) * (size / 997);
        const py = ((i * 293 + 53) % 991) * (size / 991);
        ctx.fillStyle = gray(i % 3 === 0 ? 0.72 : 0.92);
        ctx.fillRect(px, py, (3 + (i % 5)) * k, 2 * k);
      }
      break;
    }
    default:
      assertNever(wallMaterial);
  }
}

export function wallSurfacePbrRecipe(
  wallMaterial: WallMaterialId,
): PbrSurfaceRecipe {
  return {
    drawAlbedo: drawWallSurfacePattern.bind(null, wallMaterial),
    drawHeight: drawWallSurfaceHeight.bind(null, wallMaterial),
    drawRoughness: drawWallSurfaceRoughness.bind(null, wallMaterial),
    normalStrength: 1.35,
  };
}

function drawWainscotPattern(
  wallMaterial: WallMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (wallMaterial) {
    case "limewash-hinoki":
    case "board-concrete": {
      // Fluted vertical Japanese hinoki / oak slatted tambour wall
      const slats = 24;
      const sw = size / slats;
      for (let s = 0; s < slats; s += 1) {
        const x = s * sw;
        const grad = ctx.createLinearGradient(x, 0, x + sw, 0);
        grad.addColorStop(0, "#9e7b4f");
        grad.addColorStop(0.22, "#d8b689");
        grad.addColorStop(0.75, "#c7a272");
        grad.addColorStop(1, "#7d5e38");
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, sw, size);
      }
      break;
    }
    case "parisian-boiserie": {
      ctx.fillStyle = "#e6dfd0";
      ctx.fillRect(0, 0, size, size);
      const panels = 2;
      const pw = size / panels;
      for (let p = 0; p < panels; p += 1) {
        const x = p * pw;
        ctx.strokeStyle = "rgba(138, 128, 110, 0.55)";
        ctx.lineWidth = 6 * k;
        ctx.strokeRect(x + 26 * k, 36 * k, pw - 52 * k, size - 72 * k);
        ctx.strokeStyle = "rgba(255, 252, 245, 0.85)";
        ctx.lineWidth = 3 * k;
        ctx.strokeRect(x + 32 * k, 42 * k, pw - 64 * k, size - 84 * k);
      }
      break;
    }
    case "juraku-lattice": {
      const slats = 28;
      const sw = size / slats;
      for (let s = 0; s < slats; s += 1) {
        const x = s * sw;
        const grad = ctx.createLinearGradient(x, 0, x + sw, 0);
        grad.addColorStop(0, "#473121");
        grad.addColorStop(0.3, "#856045");
        grad.addColorStop(0.75, "#735138");
        grad.addColorStop(1, "#382518");
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, sw, size);
      }
      break;
    }
    default:
      assertNever(wallMaterial);
  }
}

function drawWainscotHeight(
  wallMaterial: WallMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (wallMaterial) {
    case "limewash-hinoki":
    case "board-concrete":
    case "juraku-lattice": {
      const slats = wallMaterial === "juraku-lattice" ? 28 : 24;
      const sw = size / slats;
      ctx.fillStyle = gray(0.05);
      ctx.fillRect(0, 0, size, size);
      for (let s = 0; s < slats; s += 1) {
        const x = s * sw;
        // True convex fluted half-round / chamfered slat profile
        const grad = ctx.createLinearGradient(x, 0, x + sw, 0);
        grad.addColorStop(0, gray(0.06));
        grad.addColorStop(0.09, gray(0.42));
        grad.addColorStop(0.28, gray(0.86));
        grad.addColorStop(0.5, gray(0.96));
        grad.addColorStop(0.72, gray(0.86));
        grad.addColorStop(0.91, gray(0.42));
        grad.addColorStop(1, gray(0.06));
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, sw, size);
      }
      break;
    }
    case "parisian-boiserie": {
      ctx.fillStyle = gray(0.68);
      ctx.fillRect(0, 0, size, size);
      const panels = 2;
      const pw = size / panels;
      for (let p = 0; p < panels; p += 1) {
        const x = p * pw;
        ctx.fillStyle = gray(0.52);
        ctx.fillRect(x + 30 * k, 40 * k, pw - 60 * k, size - 80 * k);
        ctx.strokeStyle = gray(0.98);
        ctx.lineWidth = 8 * k;
        ctx.strokeRect(x + 26 * k, 36 * k, pw - 52 * k, size - 72 * k);
        ctx.strokeStyle = gray(0.24);
        ctx.lineWidth = 3 * k;
        ctx.strokeRect(x + 33 * k, 43 * k, pw - 66 * k, size - 86 * k);
      }
      break;
    }
    default:
      assertNever(wallMaterial);
  }
}

function drawWainscotRoughness(
  wallMaterial: WallMaterialId,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  switch (wallMaterial) {
    case "limewash-hinoki":
    case "board-concrete":
    case "juraku-lattice": {
      const slats = wallMaterial === "juraku-lattice" ? 28 : 24;
      const sw = size / slats;
      const crownRough = wallMaterial === "juraku-lattice" ? 0.42 : 0.36;
      for (let s = 0; s < slats; s += 1) {
        const x = s * sw;
        const grad = ctx.createLinearGradient(x, 0, x + sw, 0);
        grad.addColorStop(0, gray(0.88));
        grad.addColorStop(0.14, gray(crownRough + 0.08));
        grad.addColorStop(0.5, gray(crownRough));
        grad.addColorStop(0.86, gray(crownRough + 0.08));
        grad.addColorStop(1, gray(0.88));
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, sw, size);
      }
      break;
    }
    case "parisian-boiserie": {
      ctx.fillStyle = gray(0.48);
      ctx.fillRect(0, 0, size, size);
      const panels = 2;
      const pw = size / panels;
      for (let p = 0; p < panels; p += 1) {
        const x = p * pw;
        ctx.strokeStyle = gray(0.36);
        ctx.lineWidth = 8 * k;
        ctx.strokeRect(x + 26 * k, 36 * k, pw - 52 * k, size - 72 * k);
      }
      break;
    }
    default:
      assertNever(wallMaterial);
  }
}

export function wainscotPbrRecipe(
  wallMaterial: WallMaterialId,
): PbrSurfaceRecipe {
  return {
    drawAlbedo: drawWainscotPattern.bind(null, wallMaterial),
    drawHeight: drawWainscotHeight.bind(null, wallMaterial),
    drawRoughness: drawWainscotRoughness.bind(null, wallMaterial),
    normalStrength: 1.9,
  };
}

function drawMarblePattern(ctx: CanvasRenderingContext2D, size: number): void {
  const k = size / 1024;
  ctx.fillStyle = "#f5f2eb";
  ctx.fillRect(0, 0, size, size);
  const veins: ReadonlyArray<readonly [number, number, string, number]> = [
    [0.12, 0.78, "rgba(158, 152, 142, 0.26)", 3.2],
    [0.14, 0.76, "rgba(198, 166, 112, 0.18)", 1.6],
    [0.48, 0.22, "rgba(142, 138, 130, 0.22)", 2.4],
    [0.68, 0.92, "rgba(168, 160, 148, 0.18)", 2.0],
  ];
  for (const [yStart, yEnd, color, width] of veins) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * k;
    ctx.beginPath();
    ctx.moveTo(0, size * yStart);
    ctx.bezierCurveTo(
      size * 0.32,
      size * (yStart + 0.18),
      size * 0.64,
      size * (yEnd - 0.14),
      size,
      size * yEnd,
    );
    ctx.stroke();
  }
}

function drawMarbleHeight(ctx: CanvasRenderingContext2D, size: number): void {
  const k = size / 1024;
  ctx.fillStyle = gray(0.86);
  ctx.fillRect(0, 0, size, size);
  const veins: ReadonlyArray<readonly [number, number, number]> = [
    [0.12, 0.78, 3.6],
    [0.14, 0.76, 1.8],
    [0.48, 0.22, 2.6],
    [0.68, 0.92, 2.2],
  ];
  for (const [yStart, yEnd, width] of veins) {
    ctx.strokeStyle = gray(0.7);
    ctx.lineWidth = width * k;
    ctx.beginPath();
    ctx.moveTo(0, size * yStart);
    ctx.bezierCurveTo(
      size * 0.32,
      size * (yStart + 0.18),
      size * 0.64,
      size * (yEnd - 0.14),
      size,
      size * yEnd,
    );
    ctx.stroke();
  }
}

function drawMarbleRoughness(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  ctx.fillStyle = gray(0.18);
  ctx.fillRect(0, 0, size, size);
  const veins: ReadonlyArray<readonly [number, number, number]> = [
    [0.12, 0.78, 3.6],
    [0.14, 0.76, 1.8],
    [0.48, 0.22, 2.6],
    [0.68, 0.92, 2.2],
  ];
  for (const [yStart, yEnd, width] of veins) {
    ctx.strokeStyle = gray(0.32);
    ctx.lineWidth = width * k;
    ctx.beginPath();
    ctx.moveTo(0, size * yStart);
    ctx.bezierCurveTo(
      size * 0.32,
      size * (yStart + 0.18),
      size * 0.64,
      size * (yEnd - 0.14),
      size,
      size * yEnd,
    );
    ctx.stroke();
  }
}

export const MARBLE_PBR_RECIPE: PbrSurfaceRecipe = {
  drawAlbedo: drawMarblePattern,
  drawHeight: drawMarbleHeight,
  drawRoughness: drawMarbleRoughness,
  normalStrength: 0.9,
};

function drawBrushedSteelPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#dce2e4");
  grad.addColorStop(0.5, "#cfd6d9");
  grad.addColorStop(1, "#dee4e6");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 180; i += 1) {
    const y = (i / 180) * size;
    ctx.strokeStyle =
      i % 2 === 0 ? "rgba(255, 255, 255, 0.18)" : "rgba(110, 120, 126, 0.12)";
    ctx.lineWidth = 1.2 * k;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
}

function drawBrushedSteelHeight(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  ctx.fillStyle = gray(0.54);
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 256; i += 1) {
    const y = (i / 256) * size;
    const hVal = 0.44 + ((i * 37) % 11) * 0.02;
    ctx.strokeStyle = gray(hVal);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
}

function drawBrushedSteelRoughness(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  ctx.fillStyle = gray(0.24);
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 256; i += 1) {
    const y = (i / 256) * size;
    const rVal = 0.2 + ((i * 29) % 9) * 0.014;
    ctx.strokeStyle = gray(rVal);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
}

export const BRUSHED_STEEL_PBR_RECIPE: PbrSurfaceRecipe = {
  drawAlbedo: drawBrushedSteelPattern,
  drawHeight: drawBrushedSteelHeight,
  drawRoughness: drawBrushedSteelRoughness,
  normalStrength: 0.85,
};

function drawSidewalkPaverPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  ctx.fillStyle = "#8a867e";
  ctx.fillRect(0, 0, size, size);

  const rows = 4;
  const cols = 2;
  const rowH = size / rows;
  const colW = size / cols;
  const tones = ["#cbc6bd", "#c4bfb5", "#d0cbc2", "#c1bcb2"];

  for (let r = 0; r < rows; r += 1) {
    const stagger = (r % 2) * (colW * 0.5);
    for (let c = -1; c <= cols; c += 1) {
      const x0 = c * colW + stagger;
      const y0 = r * rowH;
      const tone = tones[(r * 3 + c + 4) % tones.length]!;
      const grad = ctx.createLinearGradient(x0, y0, x0 + colW, y0 + rowH);
      grad.addColorStop(0, tone);
      grad.addColorStop(1, "#b8b3a9");
      ctx.fillStyle = grad;
      ctx.fillRect(x0 + 3 * k, y0 + 3 * k, colW - 6 * k, rowH - 6 * k);

      ctx.strokeStyle = "rgba(255, 252, 245, 0.34)";
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(x0 + 4 * k, y0 + 4 * k, colW - 8 * k, rowH - 8 * k);
    }
  }

  // Bush-hammered granite mineral fleck texture
  for (let i = 0; i < 360; i += 1) {
    const px = ((i * 197 + 31) % 997) * (size / 997);
    const py = ((i * 313 + 73) % 991) * (size / 991);
    const r = (1.1 + (i % 3) * 0.8) * k;
    ctx.fillStyle =
      i % 3 === 0
        ? "rgba(250, 248, 242, 0.26)"
        : i % 3 === 1
          ? "rgba(92, 88, 82, 0.22)"
          : "rgba(138, 126, 110, 0.18)";
    ctx.fillRect(px, py, r, r);
  }
}

function drawSidewalkPaverHeight(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  ctx.fillStyle = gray(0.08);
  ctx.fillRect(0, 0, size, size);

  const rows = 4;
  const cols = 2;
  const rowH = size / rows;
  const colW = size / cols;
  for (let r = 0; r < rows; r += 1) {
    const stagger = (r % 2) * (colW * 0.5);
    for (let c = -1; c <= cols; c += 1) {
      const x0 = c * colW + stagger;
      const y0 = r * rowH;
      ctx.fillStyle = gray(0.5);
      ctx.fillRect(x0 + 2.5 * k, y0 + 2.5 * k, colW - 5 * k, rowH - 5 * k);
      ctx.fillStyle = gray(0.82 + ((r + c + 4) % 3) * 0.02);
      ctx.fillRect(x0 + 5 * k, y0 + 5 * k, colW - 10 * k, rowH - 10 * k);
    }
  }

  for (let i = 0; i < 360; i += 1) {
    const px = ((i * 197 + 31) % 997) * (size / 997);
    const py = ((i * 313 + 73) % 991) * (size / 991);
    const r = (1.4 + (i % 3) * 0.9) * k;
    ctx.fillStyle = gray(i % 2 === 0 ? 0.92 : 0.66);
    ctx.fillRect(px, py, r, r);
  }
}

function drawSidewalkPaverRoughness(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const k = size / 1024;
  ctx.fillStyle = gray(0.94);
  ctx.fillRect(0, 0, size, size);

  const rows = 4;
  const cols = 2;
  const rowH = size / rows;
  const colW = size / cols;
  for (let r = 0; r < rows; r += 1) {
    const stagger = (r % 2) * (colW * 0.5);
    for (let c = -1; c <= cols; c += 1) {
      const x0 = c * colW + stagger;
      const y0 = r * rowH;
      ctx.fillStyle = gray(0.64 + ((r + c + 4) % 3) * 0.03);
      ctx.fillRect(x0 + 3.5 * k, y0 + 3.5 * k, colW - 7 * k, rowH - 7 * k);
    }
  }

  for (let i = 0; i < 360; i += 1) {
    const px = ((i * 197 + 31) % 997) * (size / 997);
    const py = ((i * 313 + 73) % 991) * (size / 991);
    const r = (1.4 + (i % 3) * 0.9) * k;
    ctx.fillStyle = gray(i % 3 === 0 ? 0.52 : 0.78);
    ctx.fillRect(px, py, r, r);
  }
}

export const SIDEWALK_PAVER_PBR_RECIPE: PbrSurfaceRecipe = {
  drawAlbedo: drawSidewalkPaverPattern,
  drawHeight: drawSidewalkPaverHeight,
  drawRoughness: drawSidewalkPaverRoughness,
  normalStrength: 1.55,
};

export function resolveWallColors(wallMaterial: WallMaterialId): Readonly<{
  exteriorColor: number;
  interiorColor: number;
  wainscotColor: number;
  plinthColor: number;
  columnColor: number;
  capColor: number;
  roughness: number;
}> {
  switch (wallMaterial) {
    case "limewash-hinoki":
      return {
        exteriorColor: 0xf2ecdd,
        interiorColor: 0xe9e1cf,
        wainscotColor: 0xcba776,
        plinthColor: 0x3b3834,
        columnColor: 0x9b9689,
        capColor: 0xb89362,
        roughness: 0.76,
      };
    case "parisian-boiserie":
      return {
        exteriorColor: 0xf7f3e9,
        interiorColor: 0xefe9dc,
        wainscotColor: 0xe5decb,
        plinthColor: 0x2f3330,
        columnColor: 0xdcd5c5,
        capColor: 0xb08d4f,
        roughness: 0.68,
      };
    case "board-concrete":
      return {
        exteriorColor: 0xd5d7d2,
        interiorColor: 0xc8cbc4,
        wainscotColor: 0xb89668,
        plinthColor: 0x282b29,
        columnColor: 0x7e837c,
        capColor: 0x424744,
        roughness: 0.82,
      };
    case "juraku-lattice":
      return {
        exteriorColor: 0xe3d7c3,
        interiorColor: 0xd8cab2,
        wainscotColor: 0x7a573d,
        plinthColor: 0x2c241e,
        columnColor: 0x614733,
        capColor: 0x5c422e,
        roughness: 0.8,
      };
    default:
      assertNever(wallMaterial);
  }
}

export function resolveFixtureColors(fixtureFinish: FixtureFinishId): Readonly<{
  frameColor: number;
  frameMetalness: number;
  frameRoughness: number;
  accentBrassColor: number;
  doorLeafColor: number;
}> {
  switch (fixtureFinish) {
    case "blackened-steel":
      return {
        frameColor: 0x2a2f2d,
        frameMetalness: 0.68,
        frameRoughness: 0.36,
        accentBrassColor: 0xc59b52,
        doorLeafColor: 0x9c7a52,
      };
    case "aged-brass":
      return {
        frameColor: 0x9e7b42,
        frameMetalness: 0.78,
        frameRoughness: 0.32,
        accentBrassColor: 0xd4ad63,
        doorLeafColor: 0x7c5c3c,
      };
    case "natural-oak":
      return {
        frameColor: 0xa88254,
        frameMetalness: 0.15,
        frameRoughness: 0.58,
        accentBrassColor: 0xc8cfd1,
        doorLeafColor: 0xb89264,
      };
    default:
      assertNever(fixtureFinish);
  }
}
