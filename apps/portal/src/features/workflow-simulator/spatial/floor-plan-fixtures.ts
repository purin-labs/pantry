import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { assertNever } from "@seams/std";
import type { AppliancePose } from "@seams/production-simulation/floor/appliance-catalogue";
import type { BakeryFloorPlanSpec } from "@seams/production-simulation/floor/bakery-room";
import { doorAngle } from "@seams/production-simulation/floor/openings";
import type { LightingStyleId } from "../store-interior-design";
import {
  FloorPlanTextures,
  BRUSHED_STEEL_PBR_RECIPE,
  MARBLE_PBR_RECIPE,
  SIDEWALK_PAVER_PBR_RECIPE,
} from "./floor-plan-materials";
import {
  cloneOwnedLivingSubtree,
  withLivingAssets,
  type LivingAssetTemplates,
} from "./living-asset-loader";
import bs2SinkUrl from "../../../../../../assets/bakery-mujoco/maruzen-bs2-126n/maruzen-bs2-126n.glb?url";
import sugicoSprayUrl from "../../../../../../assets/bakery-mujoco/sugico-to-600n/sugico-to-600n.glb?url";
import hmhsSinkUrl from "../../../../../../assets/bakery-mujoco/maruzen-hmhs-054/maruzen-hmhs-054.glb?url";
import bps30ShelfUrl from "../../../../../../assets/bakery-mujoco/maruzen-bps30-12b/maruzen-bps30-12b.glb?url";
import squareRegisterUrl from "../../../../../../assets/bakery-mujoco/square-register-2g/square-register-2g.glb?url";
import starPrinterUrl from "../../../../../../assets/bakery-mujoco/star-mcp31lb/star-mcp31lb.glb?url";

type FixtureAssetTemplates = Readonly<{
  bs2: THREE.Group;
  sugico: THREE.Group;
  bps30: THREE.Group;
  hmhs: THREE.Group;
  register: THREE.Group;
  printer: THREE.Group;
}>;

let cachedFixtureTemplates: FixtureAssetTemplates | null = null;
let fixtureLoadingPromise: Promise<FixtureAssetTemplates> | null = null;

function ensureFixtureAssetsLoaded(): Promise<FixtureAssetTemplates> {
  if (cachedFixtureTemplates !== null) {
    return Promise.resolve(cachedFixtureTemplates);
  }
  if (fixtureLoadingPromise === null) {
    fixtureLoadingPromise = import("three/addons/loaders/GLTFLoader.js")
      .then(async ({ GLTFLoader }) => {
        const loader = new GLTFLoader();
        const [bs2, sugico, bps30, hmhs, register, printer] = await Promise.all(
          [
            loader.loadAsync(bs2SinkUrl),
            loader.loadAsync(sugicoSprayUrl),
            loader.loadAsync(bps30ShelfUrl),
            loader.loadAsync(hmhsSinkUrl),
            loader.loadAsync(squareRegisterUrl),
            loader.loadAsync(starPrinterUrl),
          ],
        );
        const templates: FixtureAssetTemplates = {
          bs2: bs2.scene,
          sugico: sugico.scene,
          bps30: bps30.scene,
          hmhs: hmhs.scene,
          register: register.scene,
          printer: printer.scene,
        };
        cachedFixtureTemplates = templates;
        return templates;
      })
      .catch((error: unknown) => {
        fixtureLoadingPromise = null;
        throw error;
      });
  }
  return fixtureLoadingPromise;
}

function cloneOwnedFixtureMaterial(
  mat: THREE.Material,
  materialMap: Map<THREE.Material, THREE.Material>,
  textureMap: Map<THREE.Texture, THREE.Texture>,
): THREE.Material {
  const existing = materialMap.get(mat);
  if (existing !== undefined) return existing;
  const cloned = mat.clone();
  const record = cloned as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value instanceof THREE.Texture) {
      let clonedTex = textureMap.get(value);
      if (clonedTex === undefined) {
        clonedTex = value.clone();
        clonedTex.source = new THREE.Source(value.image);
        clonedTex.needsUpdate = true;
        textureMap.set(value, clonedTex);
      }
      record[key] = clonedTex;
    }
  }
  materialMap.set(mat, cloned);
  return cloned;
}

function cloneOwnedFixtureSubtree(source: THREE.Object3D): THREE.Object3D {
  const cloned = source.clone(true);
  const materialMap = new Map<THREE.Material, THREE.Material>();
  const textureMap = new Map<THREE.Texture, THREE.Texture>();
  cloned.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry = node.geometry.clone();
      if (Array.isArray(node.material)) {
        node.material = node.material.map((m) =>
          cloneOwnedFixtureMaterial(m, materialMap, textureMap),
        );
      } else {
        node.material = cloneOwnedFixtureMaterial(
          node.material,
          materialMap,
          textureMap,
        );
      }
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  return cloned;
}

function withFixtureAssets(
  target: THREE.Object3D,
  apply: (templates: FixtureAssetTemplates) => void,
): void {
  if (cachedFixtureTemplates !== null) {
    if (!isAncestorDisposed(target)) apply(cachedFixtureTemplates);
    return;
  }
  if (typeof fetch !== "function") return;
  void ensureFixtureAssetsLoaded()
    .then((templates) => {
      if (!isAncestorDisposed(target)) apply(templates);
    })
    .catch(() => {
      /* Keep procedural fallback in headless environments without GLB URL resolution. */
    });
}

if (typeof fetch === "function") {
  void ensureFixtureAssetsLoaded().catch(() => {});
}

function noopRaycast(): void {
  /* Contact shadow pads are visual grounding only and never intercept pointer rays. */
}

export function buildContactShadowPad(
  width: number,
  depth: number,
  maxOpacity = 0.24,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "contact-shadow-pad";
  group.position.y = 0.0065;
  group.userData.excludeFromAo = true;

  const segments = 32;
  const rings = 5;
  const radius = 0.53;
  const peakAlpha = Math.min(1, maxOpacity * 0.48);
  const shadowColor = new THREE.Color(0x17130e);

  const positions: number[] = [0, 0, 0];
  const colors: number[] = [
    shadowColor.r,
    shadowColor.g,
    shadowColor.b,
    peakAlpha,
  ];
  const indices: number[] = [];

  for (let rIdx = 1; rIdx <= rings; rIdx += 1) {
    const t = rIdx / rings;
    const falloff = (1 - t * t) * (1 - t * t);
    const alpha = rIdx === rings ? 0 : peakAlpha * falloff;
    const rad = radius * t;
    for (let s = 0; s < segments; s += 1) {
      const theta = (s / segments) * Math.PI * 2;
      positions.push(Math.cos(theta) * rad, 0, Math.sin(theta) * rad);
      colors.push(shadowColor.r, shadowColor.g, shadowColor.b, alpha);
    }
  }

  for (let s = 0; s < segments; s += 1) {
    const next = (s + 1) % segments;
    indices.push(0, 1 + next, 1 + s);
  }
  for (let rIdx = 1; rIdx < rings; rIdx += 1) {
    const innerBase = 1 + (rIdx - 1) * segments;
    const outerBase = 1 + rIdx * segments;
    for (let s = 0; s < segments; s += 1) {
      const next = (s + 1) % segments;
      indices.push(
        innerBase + s,
        innerBase + next,
        outerBase + next,
        innerBase + s,
        outerBase + next,
        outerBase + s,
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geo.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const disc = new THREE.Mesh(geo, mat);
  disc.scale.set(width, 1, depth);
  disc.userData.excludeFromAo = true;
  disc.raycast = noopRaycast;
  group.add(disc);

  return group;
}

export function buildPlumbingFixtures(
  spec: BakeryFloorPlanSpec,
  textures: FloorPlanTextures,
  plinthMat: THREE.Material,
  brassMat: THREE.Material,
  columnMat: THREE.Material,
) {
  const root = new THREE.Group();
  // 7. Upgraded plumbing fixtures (commercial sink counter & Japanese washroom)
  const brushedSteelPbr = textures.createPbr(
    "metal:brushed-steel",
    1.5,
    1.5,
    1.5,
    BRUSHED_STEEL_PBR_RECIPE,
  );
  const steelMat = new THREE.MeshPhysicalMaterial({
    color: 0xe4eaec,
    map: brushedSteelPbr.map,
    normalMap: brushedSteelPbr.normalMap,
    normalScale: new THREE.Vector2(0.28, 0.28),
    roughnessMap: brushedSteelPbr.roughnessMap,
    roughness: brushedSteelPbr.roughnessMap !== null ? 1.0 : 0.24,
    metalness: 0.84,
    clearcoat: 0.22,
    clearcoatRoughness: 0.28,
    anisotropy: 0.45,
    envMapIntensity: 1.3,
  });
  const basinMat = new THREE.MeshStandardMaterial({
    color: 0x6f7b80,
    roughness: 0.28,
    metalness: 0.8,
    envMapIntensity: 1.2,
  });
  const ceramicMat = new THREE.MeshPhysicalMaterial({
    color: 0xf8f7f2,
    roughness: 0.14,
    metalness: 0.04,
    clearcoat: 0.72,
    clearcoatRoughness: 0.12,
    reflectivity: 0.75,
  });

  for (const fix of spec.fixtures) {
    const w = Math.abs(fix.x1 - fix.x0);
    const d = Math.abs(fix.z1 - fix.z0);
    const cx = (fix.x0 + fix.x1) * 0.5;
    const cz = (fix.z0 + fix.z1) * 0.5;
    switch (fix.kind) {
      case "sink-counter": {
        const group = new THREE.Group();
        group.name = `fixture:${fix.id}`;
        group.position.set(cx, 0, cz);

        // Recessed dark stainless toe-kick plinth
        const toeKick = new THREE.Mesh(
          new THREE.BoxGeometry(w - 0.04, 0.09, d - 0.05),
          plinthMat,
        );
        toeKick.position.set(0, 0.045, -0.01);
        group.add(toeKick);

        // Main stainless cabinet body above toe-kick
        const bodyH = Math.max(0.2, fix.height - 0.12);
        const body = new THREE.Mesh(
          new RoundedBoxGeometry(w, bodyH, d - 0.02, 3, 0.01),
          steelMat,
        );
        body.position.y = 0.09 + bodyH * 0.5;
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        // Overhanging marine-edge stainless countertop deck
        const deck = new THREE.Mesh(
          new RoundedBoxGeometry(w + 0.016, 0.036, d + 0.016, 3, 0.008),
          steelMat,
        );
        deck.position.y = fix.height - 0.014;
        deck.castShadow = true;
        deck.receiveShadow = true;
        group.add(deck);

        // Sliding cabinet door panels + vertical brass/steel pulls on front face
        for (const xSign of [-0.24, 0.24]) {
          const doorPanel = new THREE.Mesh(
            new RoundedBoxGeometry(w * 0.44, bodyH - 0.06, 0.012, 2, 0.003),
            steelMat,
          );
          doorPanel.position.set(
            w * xSign,
            0.09 + bodyH * 0.5,
            d * 0.5 - 0.006,
          );
          const pull = new THREE.Mesh(
            new RoundedBoxGeometry(0.014, 0.16, 0.022, 2, 0.003),
            brassMat,
          );
          pull.position.set(
            w * (xSign * 0.35),
            0.09 + bodyH * 0.58,
            d * 0.5 + 0.008,
          );
          group.add(doorPanel, pull);
        }

        // Backsplash + wall utensil bar
        const splash = new THREE.Mesh(
          new RoundedBoxGeometry(w + 0.01, 0.16, 0.028, 3, 0.006),
          steelMat,
        );
        splash.position.set(0, fix.height + 0.08, -d * 0.5 + 0.014);
        const utensilRail = new THREE.Mesh(
          new THREE.CylinderGeometry(0.006, 0.006, w * 0.78, 10),
          brassMat,
        );
        utensilRail.rotation.z = Math.PI * 0.5;
        utensilRail.position.set(0, fix.height + 0.12, -d * 0.5 + 0.042);
        group.add(splash, utensilRail);

        // Twin commercial sink basins with beveled rim + center stainless strainer
        const basinW = Math.min(w * 0.36, 0.48);
        const basinD = d * 0.64;
        for (const xSign of [-0.22, 0.18]) {
          const rim = new THREE.Mesh(
            new RoundedBoxGeometry(
              basinW + 0.03,
              0.012,
              basinD + 0.03,
              2,
              0.004,
            ),
            steelMat,
          );
          rim.position.set(w * xSign, fix.height + 0.006, 0.02);
          const basin = new THREE.Mesh(
            new THREE.BoxGeometry(basinW, 0.016, basinD),
            basinMat,
          );
          basin.position.set(w * xSign, fix.height + 0.01, 0.02);
          const strainer = new THREE.Mesh(
            new THREE.CylinderGeometry(0.028, 0.028, 0.018, 14),
            steelMat,
          );
          strainer.position.set(w * xSign, fix.height + 0.012, 0.02);
          group.add(rim, basin, strainer);
        }

        // Gooseneck pre-rinse faucet column, arch, sprayer head & wrist levers
        const faucetStem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.014, 0.018, 0.28, 14),
          steelMat,
        );
        faucetStem.position.set(-w * 0.02, fix.height + 0.14, -d * 0.35);
        const springCoil = new THREE.Mesh(
          new THREE.CylinderGeometry(0.021, 0.021, 0.13, 14),
          brassMat,
        );
        springCoil.position.set(-w * 0.02, fix.height + 0.19, -d * 0.35);
        const faucetArch = new THREE.Mesh(
          new THREE.TorusGeometry(0.095, 0.012, 10, 20, Math.PI),
          steelMat,
        );
        faucetArch.rotation.y = Math.PI * 0.5;
        faucetArch.position.set(-w * 0.02, fix.height + 0.28, -d * 0.255);
        const sprayerNozzle = new THREE.Mesh(
          new THREE.ConeGeometry(0.022, 0.055, 14),
          brassMat,
        );
        sprayerNozzle.rotation.x = Math.PI;
        sprayerNozzle.position.set(-w * 0.02, fix.height + 0.245, -d * 0.16);
        group.add(faucetStem, springCoil, faucetArch, sprayerNozzle);

        for (const hSign of [-1, 1]) {
          const lever = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.012, 0.016),
            brassMat,
          );
          lever.position.set(
            -w * 0.02 + hSign * 0.055,
            fix.height + 0.06,
            -d * 0.34,
          );
          group.add(lever);
        }

        // Slotted stainless floor drain grate in front of sink
        const drainW = Math.min(w * 0.62, 0.82);
        const drain = new THREE.Mesh(
          new THREE.BoxGeometry(drainW, 0.006, 0.16),
          basinMat,
        );
        drain.position.set(0, 0.004, d * 0.5 + 0.18);
        group.add(drain);

        // Warm 65 °C wash water surface in left basin + stacked Matsunaga 8P moulds on right drainboard
        const washWater = new THREE.Mesh(
          new THREE.BoxGeometry(basinW * 0.92, 0.006, basinD * 0.92),
          new THREE.MeshPhysicalMaterial({
            color: 0x7dd3fc,
            roughness: 0.08,
            metalness: 0.08,
            ior: 1.333,
            reflectivity: 0.85,
            clearcoat: 0.95,
            clearcoatRoughness: 0.05,
            transparent: true,
            opacity: 0.74,
          }),
        );
        washWater.name = "sink_wash_water";
        washWater.position.set(-w * 0.22, fix.height + 0.02, 0.02);
        group.add(washWater);

        const mouldRack = new THREE.Group();
        mouldRack.name = "sink_mould_rack";
        mouldRack.position.set(w * 0.34, fix.height + 0.014, 0.02);
        for (let m = 0; m < 3; m += 1) {
          const mouldPlate = new THREE.Mesh(
            new RoundedBoxGeometry(0.18, 0.007, 0.22, 2, 0.0025),
            basinMat,
          );
          mouldPlate.position.set(0, m * 0.012, 0);
          mouldPlate.rotation.z = 0.08;
          mouldRack.add(mouldPlate);
        }
        group.add(mouldRack);

        withFixtureAssets(group, (templates) => {
          const bs2 = cloneOwnedFixtureSubtree(templates.bs2);
          const sugico = cloneOwnedFixtureSubtree(templates.sugico);
          const bps30 = cloneOwnedFixtureSubtree(templates.bps30);
          const hmhs = cloneOwnedFixtureSubtree(templates.hmhs);
          bs2.position.set(-0.12, 0, 0);
          sugico.position.set(-0.12, 0.8, -0.22);
          bps30.position.set(-0.12, 1.42, -0.15);
          hmhs.position.set(w * 0.5 + 0.28, 0.45, -0.06);
          group.add(bs2, sugico, bps30, hmhs);
        });

        root.add(group);
        break;
      }
      case "toilet": {
        const group = new THREE.Group();
        group.name = `fixture:${fix.id}`;
        group.position.set(cx, 0, cz);
        group.rotation.y =
          fix.facing === "north"
            ? Math.PI
            : fix.facing === "east"
              ? Math.PI * 0.5
              : fix.facing === "west"
                ? -Math.PI * 0.5
                : 0;

        const tankH = fix.height * 0.82;
        // Low-profile Japanese washlet tank shroud & contoured ceramic bowl
        const tank = new THREE.Mesh(
          new THREE.BoxGeometry(0.36, tankH, 0.17),
          ceramicMat,
        );
        tank.position.set(0, tankH * 0.5, -0.2);
        const flushPlate = new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 0.075, 0.012),
          brassMat,
        );
        flushPlate.position.set(0, tankH + 0.12, -0.275);

        const bowl = new THREE.Mesh(
          new THREE.CylinderGeometry(0.175, 0.135, 0.4, 22),
          ceramicMat,
        );
        bowl.scale.set(0.95, 1, 1.18);
        bowl.position.set(0, 0.2, 0.06);
        const lid = new THREE.Mesh(
          new THREE.CylinderGeometry(0.18, 0.18, 0.028, 22),
          ceramicMat,
        );
        lid.scale.set(0.95, 1, 1.18);
        lid.position.set(0, 0.415, 0.06);

        // Integrated Japanese tank-top ceramic handwash basin & chrome spout
        const miniSink = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.088, 0.036, 20),
          ceramicMat,
        );
        miniSink.scale.set(1.15, 1, 0.68);
        miniSink.position.set(0, tankH + 0.016, -0.2);
        const miniFaucet = new THREE.Mesh(
          new THREE.CylinderGeometry(0.009, 0.011, 0.085, 10),
          brassMat,
        );
        miniFaucet.position.set(0, tankH + 0.058, -0.245);
        group.add(tank, flushPlate, bowl, lid, miniSink, miniFaucet);
        root.add(group);
        break;
      }
      case "pipe-shaft": {
        const shaft = new THREE.Mesh(
          new THREE.BoxGeometry(w, fix.height, d),
          columnMat,
        );
        shaft.position.set(cx, fix.height * 0.5, cz);
        root.add(shaft);
        break;
      }
      default:
        assertNever(fix.kind);
    }
  }

  return { root, steelMat, basinMat, ceramicMat };
}

export function buildOverheadLightingAndHood(
  spec: BakeryFloorPlanSpec,
  lightingStyle: LightingStyleId,
  brassMat: THREE.Material,
  frameMat: THREE.Material,
  steelMat: THREE.Material,
  baffleMat: THREE.Material,
  ovenPose: AppliancePose,
) {
  const group = new THREE.Group();
  group.name = "store-overhead-fixtures";

  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xfff5db,
    emissive: 0xffd074,
    emissiveIntensity: 0.95,
    roughness: 0.18,
  });
  const shadeGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0xfcf6e8,
    transparent: true,
    opacity: 0.74,
    roughness: 0.18,
  });

  const fixtureY = 2.28;
  const cordHeight = Math.max(0.28, spec.ceilingHeight - fixtureY);
  const mainZones = spec.zones.filter((z) => z.kind === "main");
  const hasVoids = (spec.voids?.length ?? 0) > 0 && mainZones.length > 0;
  const mainMinX = hasVoids
    ? Math.min(...mainZones.map((z) => Math.min(z.x0, z.x1)))
    : -spec.width * 0.5;
  const mainMaxX = hasVoids
    ? Math.max(...mainZones.map((z) => Math.max(z.x0, z.x1)))
    : spec.width * 0.5;
  const mainCenterX = (mainMinX + mainMaxX) * 0.5;
  const mainSpanW = mainMaxX - mainMinX;
  const pendantPositions: readonly [number, number][] = [
    [mainCenterX - mainSpanW * 0.24, -spec.depth * 0.08],
    [mainCenterX + mainSpanW * 0.22, -spec.depth * 0.08],
    [mainCenterX - mainSpanW * 0.22, spec.depth * 0.28],
    [mainCenterX + mainSpanW * 0.18, spec.depth * 0.28],
  ];

  for (let i = 0; i < pendantPositions.length; i += 1) {
    const [px, pz] = pendantPositions[i]!;
    const lamp = new THREE.Group();
    lamp.name = `overhead-lamp:${i}`;
    lamp.position.set(px, fixtureY, pz);

    const canopyRosette = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.048, 0.018, 16),
      brassMat,
    );
    canopyRosette.position.y = cordHeight;
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.005, cordHeight, 8),
      frameMat,
    );
    cord.position.y = cordHeight * 0.5;
    lamp.add(canopyRosette, cord);

    switch (lightingStyle) {
      case "brass-pendants": {
        const collar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.028, 0.048, 0.07, 16),
          brassMat,
        );
        collar.position.y = 0.045;
        const shade = new THREE.Mesh(
          new THREE.ConeGeometry(0.17, 0.14, 24, 1, true),
          shadeGlassMat,
        );
        shade.position.y = -0.02;
        const brassRim = new THREE.Mesh(
          new THREE.TorusGeometry(0.17, 0.006, 10, 24),
          brassMat,
        );
        brassRim.rotation.x = Math.PI * 0.5;
        brassRim.position.y = -0.09;
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.042, 16, 14),
          bulbMat,
        );
        bulb.position.y = -0.045;
        const pointLight = new THREE.PointLight(0xffe2a8, 0.24, 4.4, 2.0);
        pointLight.name = `overhead-point-light:${i}`;
        pointLight.position.set(0, -0.08, 0);
        lamp.add(collar, shade, brassRim, bulb, pointLight);
        break;
      }
      case "atelier-track": {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(0.72, 0.03, 0.046),
          frameMat,
        );
        const endCaps = new THREE.Mesh(
          new THREE.BoxGeometry(0.74, 0.018, 0.052),
          brassMat,
        );
        endCaps.position.y = 0.008;
        const glowStrip = new THREE.Mesh(
          new THREE.BoxGeometry(0.66, 0.014, 0.034),
          bulbMat,
        );
        glowStrip.position.y = -0.017;
        const pointLight = new THREE.PointLight(0xfff1d0, 0.28, 4.8, 2.0);
        pointLight.name = `overhead-point-light:${i}`;
        pointLight.position.set(0, -0.05, 0);
        lamp.add(bar, endCaps, glowStrip, pointLight);
        break;
      }
      case "washi-lanterns": {
        const globe = new THREE.Mesh(
          new THREE.SphereGeometry(0.175, 24, 18),
          bulbMat,
        );
        globe.scale.set(1, 0.78, 1);
        const topRing = new THREE.Mesh(
          new THREE.CylinderGeometry(0.062, 0.062, 0.02, 18),
          frameMat,
        );
        topRing.position.y = 0.138;
        const botRing = new THREE.Mesh(
          new THREE.CylinderGeometry(0.052, 0.052, 0.016, 18),
          frameMat,
        );
        botRing.position.y = -0.135;
        const pointLight = new THREE.PointLight(0xffd996, 0.22, 4.6, 2.0);
        pointLight.name = `overhead-point-light:${i}`;
        pointLight.position.set(0, -0.06, 0);
        lamp.add(globe, topRing, botRing, pointLight);
        break;
      }
      default:
        assertNever(lightingStyle);
    }
    group.add(lamp);
  }

  // Commercial stainless exhaust canopy hood with spiral duct & grease baffles
  const hood = new THREE.Group();
  hood.name = "canopy-exhaust-hood";
  hood.position.set(ovenPose.x, 2.12, ovenPose.z);
  hood.rotation.y = ovenPose.rotY;

  // Lower perimeter skirt + upper chamfered plenum box
  const lowerSkirt = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.13, 1.06),
    steelMat,
  );
  lowerSkirt.position.y = -0.045;
  lowerSkirt.castShadow = true;
  lowerSkirt.receiveShadow = true;
  const upperPlenum = new THREE.Mesh(
    new THREE.BoxGeometry(1.44, 0.13, 0.92),
    steelMat,
  );
  upperPlenum.position.y = 0.08;
  upperPlenum.castShadow = true;
  upperPlenum.receiveShadow = true;

  // Angled commercial grease baffle filter bank along the rear underside
  const baffleFilter = new THREE.Mesh(
    new THREE.BoxGeometry(1.38, 0.032, 0.36),
    baffleMat,
  );
  baffleFilter.position.set(0, -0.05, -0.2);
  baffleFilter.rotation.x = 0.38;

  // Warm under-hood task light strip illuminating the oven deck
  const hoodLight = new THREE.Mesh(
    new THREE.BoxGeometry(1.16, 0.016, 0.06),
    bulbMat,
  );
  hoodLight.position.set(0, -0.105, 0.28);
  const hoodTaskLight = new THREE.PointLight(0xffdf9e, 0.34, 3.2, 2.0);
  hoodTaskLight.name = "hood-task-light";
  hoodTaskLight.position.set(0, -0.14, 0.24);
  hood.add(hoodTaskLight);

  // Round galvanized spiral exhaust duct riser + flanged clamp rings
  const spiralDuct = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.19, 0.46, 20),
    steelMat,
  );
  spiralDuct.position.set(0, 0.36, -0.16);
  for (const ringY of [0.22, 0.38, 0.52]) {
    const collarRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.192, 0.009, 8, 20),
      baffleMat,
    );
    collarRing.rotation.x = Math.PI * 0.5;
    collarRing.position.set(0, ringY, -0.16);
    hood.add(collarRing);
  }

  // Four threaded ceiling suspension rods at the canopy corners
  for (const rx of [-0.64, 0.64]) {
    for (const rz of [-0.38, 0.38]) {
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, 0.44, 8),
        frameMat,
      );
      rod.position.set(rx, 0.35, rz);
      hood.add(rod);
    }
  }

  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(1.62, 0.022, 1.08),
    brassMat,
  );
  trim.position.y = -0.11;
  hood.add(lowerSkirt, upperPlenum, baffleFilter, hoodLight, spiralDuct, trim);
  group.add(hood);

  return { root: group, hood };
}

export function buildCustomerBenchMesh(
  pose: AppliancePose,
  woodMat: THREE.Material,
  brassMat: THREE.Material,
  frameMat: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "decor:decor-bench";
  group.userData.decorId = "decor-bench";
  group.position.set(pose.x, 0, pose.z);
  group.rotation.y = pose.rotY;

  const leatherMat = new THREE.MeshPhysicalMaterial({
    color: 0x8f5233,
    roughness: 0.4,
    metalness: 0.05,
    sheen: 0.45,
    sheenRoughness: 0.52,
    sheenColor: new THREE.Color(0xc47d52),
    clearcoat: 0.18,
    clearcoatRoughness: 0.42,
  });
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x5c321d,
    roughness: 0.55,
  });

  // Slatted timber base deck (1.12 x 0.42 m) with brass end-caps
  const deck = new THREE.Mesh(
    new RoundedBoxGeometry(1.12, 0.042, 0.42, 3, 0.008),
    woodMat,
  );
  deck.position.y = 0.38;
  deck.castShadow = true;
  deck.receiveShadow = true;
  const deckTrim = new THREE.Mesh(
    new RoundedBoxGeometry(1.13, 0.016, 0.43, 2, 0.004),
    brassMat,
  );
  deckTrim.position.y = 0.365;
  group.add(deck, deckTrim);

  // Upholstered cognac leather seat cushion with channel-tufted seams
  const cushion = new THREE.Mesh(
    new RoundedBoxGeometry(1.06, 0.072, 0.38, 4, 0.02),
    leatherMat,
  );
  cushion.position.y = 0.438;
  cushion.castShadow = true;
  group.add(cushion);

  for (const sx of [-0.34, -0.17, 0, 0.17, 0.34]) {
    const channelSeam = new THREE.Mesh(
      new THREE.BoxGeometry(0.008, 0.076, 0.384),
      seamMat,
    );
    channelSeam.position.set(sx, 0.438, 0);
    group.add(channelSeam);
  }

  // Timber backrest + upholstered cylindrical leather lumbar bolster on brass stanchions
  const backrest = new THREE.Mesh(
    new RoundedBoxGeometry(1.06, 0.18, 0.045, 3, 0.008),
    woodMat,
  );
  backrest.position.set(0, 0.65, 0.175);
  const bolster = new THREE.Mesh(
    new THREE.CylinderGeometry(0.048, 0.048, 1.02, 16),
    leatherMat,
  );
  bolster.rotation.z = Math.PI * 0.5;
  bolster.position.set(0, 0.63, 0.135);
  group.add(backrest, bolster);

  for (const bx of [-0.42, 0.42]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.24, 10),
      brassMat,
    );
    post.position.set(bx, 0.52, 0.175);
    group.add(post);
  }

  // Four tapered legs with brass sabots and lower stretcher rail
  for (const lx of [-0.48, 0.48]) {
    for (const lz of [-0.16, 0.16]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.015, 0.36, 12),
        frameMat,
      );
      leg.position.set(lx, 0.18, lz);
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.016, 0.055, 12),
        brassMat,
      );
      foot.position.set(lx, 0.028, lz);
      group.add(leg, foot);
    }
  }
  const stretcher = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.01, 0.96, 10),
    brassMat,
  );
  stretcher.rotation.z = Math.PI * 0.5;
  stretcher.position.set(0, 0.12, 0);
  group.add(stretcher, buildContactShadowPad(1.16, 0.46, 0.22));

  return group;
}

export function buildPastryVitrineMesh(
  pose: AppliancePose,
  woodMat: THREE.Material,
  brassMat: THREE.Material,
  glassMat: THREE.Material,
  textures: FloorPlanTextures,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "decor:decor-vitrine";
  group.userData.decorId = "decor-vitrine";
  group.position.set(pose.x, 0, pose.z);
  group.rotation.y = pose.rotY;

  const marblePbr = textures.createPbr(
    "stone:calacatta-marble",
    0.9,
    1.4,
    0.8,
    MARBLE_PBR_RECIPE,
  );
  const marbleMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: marblePbr.map,
    normalMap: marblePbr.normalMap,
    normalScale: new THREE.Vector2(0.2, 0.2),
    roughnessMap: marblePbr.roughnessMap,
    roughness: marblePbr.roughnessMap !== null ? 1.0 : 0.2,
    metalness: 0.04,
    clearcoat: 0.54,
    clearcoatRoughness: 0.18,
    reflectivity: 0.72,
    envMapIntensity: 1.25,
  });
  const pastryGoldMat = new THREE.MeshStandardMaterial({
    color: 0xd8953b,
    roughness: 0.42,
    metalness: 0.06,
  });
  const boxMat = new THREE.MeshStandardMaterial({
    color: 0x22362b,
    roughness: 0.38,
    metalness: 0.08,
  });
  const ledStripMat = new THREE.MeshStandardMaterial({
    color: 0xfff6de,
    emissive: 0xffd88a,
    emissiveIntensity: 0.9,
    roughness: 0.2,
  });

  // Fluted wood cabinet base (1.12 x 0.76 x 0.50 m)
  const base = new THREE.Mesh(
    new RoundedBoxGeometry(1.12, 0.76, 0.5, 3, 0.012),
    woodMat,
  );
  base.position.y = 0.38;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Brass plinth trim + upper reveal collar
  const plinth = new THREE.Mesh(
    new RoundedBoxGeometry(1.135, 0.065, 0.515, 2, 0.005),
    brassMat,
  );
  plinth.position.y = 0.032;
  const collar = new THREE.Mesh(
    new RoundedBoxGeometry(1.13, 0.018, 0.51, 2, 0.004),
    brassMat,
  );
  collar.position.y = 0.752;
  group.add(plinth, collar);

  // Honed Calacatta marble countertop slab
  const counterTop = new THREE.Mesh(
    new RoundedBoxGeometry(1.16, 0.038, 0.54, 3, 0.007),
    marbleMat,
  );
  counterTop.position.y = 0.779;
  group.add(counterTop);

  // Glass pastry vitrine hood (0.42 m tall) with slim brass corner posts & LED bar
  const glassHood = new THREE.Mesh(
    new THREE.BoxGeometry(1.08, 0.42, 0.45),
    glassMat,
  );
  glassHood.position.y = 1.01;
  group.add(glassHood);

  for (const cx of [-0.54, 0.54]) {
    for (const cz of [-0.225, 0.225]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.016, 0.43, 0.016),
        brassMat,
      );
      post.position.set(cx, 1.01, cz);
      group.add(post);
    }
  }

  // Brass vitrine top frame, interior LED light bar & middle marble display shelf
  const topFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.11, 0.022, 0.47),
    brassMat,
  );
  topFrame.position.y = 1.222;
  const ledBar = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.01, 0.028),
    ledStripMat,
  );
  ledBar.position.set(0, 1.206, 0.16);
  const vitrineDisplayLight = new THREE.PointLight(0xffe6ad, 0.32, 2.2, 2.0);
  vitrineDisplayLight.name = "vitrine-display-light";
  vitrineDisplayLight.position.set(0, 1.16, 0.08);
  const midShelf = new THREE.Mesh(
    new RoundedBoxGeometry(1.04, 0.014, 0.36, 2, 0.0035),
    marbleMat,
  );
  midShelf.position.y = 0.99;
  group.add(
    topFrame,
    ledBar,
    vitrineDisplayLight,
    midShelf,
    buildContactShadowPad(1.2, 0.58, 0.28),
  );

  // Display trays of golden financiers on the lower marble deck (3 trays × 8 = 24 capacity)
  let looseIdx = 0;
  for (const tx of [-0.34, 0.0, 0.34] as const) {
    const tray = new THREE.Mesh(
      new RoundedBoxGeometry(0.27, 0.012, 0.31, 3, 0.004),
      brassMat,
    );
    tray.position.set(tx, 0.804, 0);
    group.add(tray);
    for (const pz of [-0.105, -0.035, 0.035, 0.105]) {
      for (const px of [-0.072, 0.072]) {
        const financier = new THREE.Mesh(
          new RoundedBoxGeometry(0.072, 0.026, 0.042, 3, 0.005),
          pastryGoldMat,
        );
        financier.name = `vitrine-financier:${looseIdx}`;
        financier.userData.vitrineLooseIndex = looseIdx;
        financier.visible = looseIdx < 12;
        financier.position.set(tx + px, 0.824, pz);
        group.add(financier);
        looseIdx += 1;
      }
    }
  }

  // Ribbon-tied pâtisserie ballotin gift boxes on the upper shelf (4 × 2 = 8 capacity)
  let boxIdx = 0;
  for (const bz of [-0.075, 0.075]) {
    for (const bx of [-0.36, -0.12, 0.12, 0.36]) {
      const boxGroup = new THREE.Group();
      boxGroup.name = `vitrine-ballotin:${boxIdx}`;
      boxGroup.userData.vitrineBallotinIndex = boxIdx;
      boxGroup.visible = boxIdx < 3;
      boxGroup.position.set(bx, 1.036, bz);
      const giftBox = new THREE.Mesh(
        new RoundedBoxGeometry(0.185, 0.072, 0.125, 2, 0.004),
        boxMat,
      );
      const ribbonX = new THREE.Mesh(
        new THREE.BoxGeometry(0.189, 0.076, 0.018),
        brassMat,
      );
      const ribbonZ = new THREE.Mesh(
        new THREE.BoxGeometry(0.018, 0.076, 0.129),
        brassMat,
      );
      boxGroup.add(giftBox, ribbonX, ribbonZ);
      group.add(boxGroup);
      boxIdx += 1;
    }
  }

  withFixtureAssets(group, (templates) => {
    const registerScene = cloneOwnedFixtureSubtree(templates.register);
    const printerScene = cloneOwnedFixtureSubtree(templates.printer);
    registerScene.scale.setScalar(0.82);
    registerScene.position.set(0.32, 1.233, 0.02);
    printerScene.scale.setScalar(0.86);
    printerScene.position.set(0.48, 1.233, -0.08);
    group.add(registerScene, printerScene);
  });

  return group;
}

function isAncestorDisposed(node: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = node;
  while (cur !== null) {
    if (cur.userData.disposed === true) return true;
    cur = cur.parent;
  }
  return false;
}

function replaceMeshMaterial(mesh: THREE.Mesh, next: THREE.Material): void {
  if (Array.isArray(mesh.material)) {
    for (const m of mesh.material) m.dispose();
  } else {
    mesh.material.dispose();
  }
  mesh.material = next;
}

function mountBotanicalPlanterModel(
  host: THREE.Group,
  templates: LivingAssetTemplates,
  modelName: "olive_tree_planter" | "storefront_shrub_planter",
  ceramicMat: THREE.Material,
  brassMat: THREE.Material,
  swaySeed: number,
  disableRaycast: boolean,
): void {
  if (isAncestorDisposed(host)) return;
  const source = templates.plantersScene.getObjectByName(modelName);
  if (!source) return;

  const model = cloneOwnedLivingSubtree(source);
  model.position.set(0, 0, 0);
  model.quaternion.identity();
  model.updateMatrixWorld(true);

  const potPrefix = modelName === "olive_tree_planter" ? "olive_" : "shrub_";
  const potMesh = model.getObjectByName(`${potPrefix}pot`);
  if (potMesh instanceof THREE.Mesh) replaceMeshMaterial(potMesh, ceramicMat);
  const saucerMesh = model.getObjectByName(`${potPrefix}saucer`);
  if (saucerMesh instanceof THREE.Mesh)
    replaceMeshMaterial(saucerMesh, brassMat);

  // Apply a subtle organic bone posture on the rigged botanical armature
  const leanX = Math.sin(swaySeed * 1.7) * 0.035;
  const leanZ = Math.cos(swaySeed * 2.3) * 0.035;
  const swayQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(leanX, swaySeed * 0.08, leanZ, "XYZ"),
  );
  const skinned: THREE.SkinnedMesh[] = [];
  model.traverse((node) => {
    if (
      node instanceof THREE.Bone &&
      (node.name === "trunk_mid" ||
        node.name === "crown_top" ||
        node.name === "shrub_canopy")
    ) {
      const bindW = new THREE.Quaternion();
      node.getWorldQuaternion(bindW);
      const bindWInv = bindW.clone().invert();
      node.quaternion.multiply(bindWInv).multiply(swayQuat).multiply(bindW);
    }
    if (node instanceof THREE.SkinnedMesh) {
      skinned.push(node);
    }
    if (disableRaycast && node instanceof THREE.Mesh) {
      node.raycast = noopRaycast;
    }
  });
  model.updateMatrixWorld(true);
  for (const sm of skinned) sm.skeleton.update();

  host.add(model);
}

export function buildPlanterMesh(
  pose: AppliancePose,
  ceramicMat: THREE.Material,
  brassMat: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "decor:decor-planter";
  group.userData.decorId = "decor-planter";
  group.position.set(pose.x, 0, pose.z);
  group.rotation.y = pose.rotY;
  group.add(buildContactShadowPad(0.44, 0.44, 0.24));

  withLivingAssets((templates) => {
    mountBotanicalPlanterModel(
      group,
      templates,
      "olive_tree_planter",
      ceramicMat,
      brassMat,
      pose.x * 0.7 + pose.z * 1.1,
      false,
    );
  });

  return group;
}

export function buildFloorPlanStairs(
  spec: BakeryFloorPlanSpec,
  maxRiseHeight: number,
  riserMat: THREE.Material,
  treadMat: THREE.Material,
  brassMat: THREE.Material,
  frameMat: THREE.Material,
): THREE.Group {
  const root = new THREE.Group();
  root.name = "floor-plan-stairs";

  for (const stair of spec.stairs ?? []) {
    const group = new THREE.Group();
    group.name = `stair:${stair.id}`;
    const totalSteps = 10;
    const totalRise = Math.min(stair.riseHeight, maxRiseHeight);
    const stepH = totalRise / totalSteps;

    // 1. Lower straight flight (4 steps ascending westward from x1 -> turnSplitX)
    const lowerCount = 4;
    const lowerSpanX = stair.x1 - stair.turnSplitX;
    const lowerRun = lowerSpanX / lowerCount;
    const lowerDepthZ = stair.z1 - stair.lowerTopZ;
    const lowerCenterZ = (stair.lowerTopZ + stair.z1) * 0.5;
    for (let i = 0; i < lowerCount; i += 1) {
      const h = stepH * (i + 1);
      const cx = stair.x1 - lowerRun * (i + 0.5);
      const riser = new THREE.Mesh(
        new THREE.BoxGeometry(lowerRun - 0.004, h, lowerDepthZ - 0.008),
        riserMat,
      );
      riser.position.set(cx, h * 0.5, lowerCenterZ);
      riser.castShadow = true;
      riser.receiveShadow = true;

      const tread = new THREE.Mesh(
        new THREE.BoxGeometry(lowerRun + 0.012, 0.024, lowerDepthZ),
        treadMat,
      );
      tread.position.set(cx, h + 0.012, lowerCenterZ);
      tread.castShadow = true;
      tread.receiveShadow = true;

      const nosing = new THREE.Mesh(
        new THREE.BoxGeometry(0.014, 0.01, lowerDepthZ - 0.01),
        brassMat,
      );
      nosing.position.set(cx + lowerRun * 0.5 + 0.002, h + 0.02, lowerCenterZ);
      group.add(riser, tread, nosing);
    }

    // 2. Quarter-turn corner winder steps (3 stepped tiers turning north)
    const winderW = stair.turnSplitX - stair.x0;
    const winderD = stair.z1 - stair.lowerTopZ;
    for (let wIdx = 0; wIdx < 3; wIdx += 1) {
      const h = stepH * (lowerCount + 1 + wIdx);
      const zMax =
        wIdx === 0
          ? stair.z1
          : wIdx === 1
            ? stair.z1 - winderD * 0.34
            : stair.z1 - winderD * 0.66;
      const xMax =
        wIdx === 0
          ? stair.turnSplitX
          : wIdx === 1
            ? stair.x0 + winderW * 0.78
            : stair.x0 + winderW * 0.96;
      const tierW = xMax - stair.x0;
      const tierD = zMax - stair.lowerTopZ;
      const cx = (stair.x0 + xMax) * 0.5;
      const cz = (stair.lowerTopZ + zMax) * 0.5;

      const tierBody = new THREE.Mesh(
        new THREE.BoxGeometry(tierW - 0.006, h, tierD - 0.006),
        riserMat,
      );
      tierBody.position.set(cx, h * 0.5, cz);
      tierBody.castShadow = true;
      tierBody.receiveShadow = true;

      const tierCap = new THREE.Mesh(
        new THREE.BoxGeometry(tierW, 0.024, tierD),
        treadMat,
      );
      tierCap.position.set(cx, h + 0.012, cz);
      group.add(tierBody, tierCap);
    }

    // 3. Upper straight flight (3 steps ascending northward from lowerTopZ -> z0)
    const upperCount = 3;
    const upperSpanZ = stair.lowerTopZ - stair.z0;
    const upperRun = upperSpanZ / upperCount;
    const upperCenterX = (stair.x0 + stair.turnSplitX) * 0.5;
    for (let i = 0; i < upperCount; i += 1) {
      const h = stepH * (lowerCount + 3 + i + 1);
      const cz = stair.lowerTopZ - upperRun * (i + 0.5);
      const riser = new THREE.Mesh(
        new THREE.BoxGeometry(winderW - 0.008, h, upperRun - 0.004),
        riserMat,
      );
      riser.position.set(upperCenterX, h * 0.5, cz);
      riser.castShadow = true;
      riser.receiveShadow = true;

      const tread = new THREE.Mesh(
        new THREE.BoxGeometry(winderW, 0.024, upperRun + 0.012),
        treadMat,
      );
      tread.position.set(upperCenterX, h + 0.012, cz);
      tread.castShadow = true;
      tread.receiveShadow = true;

      const nosing = new THREE.Mesh(
        new THREE.BoxGeometry(winderW - 0.01, 0.01, 0.014),
        brassMat,
      );
      nosing.position.set(upperCenterX, h + 0.02, cz + upperRun * 0.5 + 0.002);
      group.add(riser, tread, nosing);
    }

    // 4. Inner corner newel post & guardrail along restroom landing edge
    const railH = Math.min(0.86, maxRiseHeight * 0.62);
    const cornerY = stepH * (lowerCount + 2);
    const newelH = cornerY + railH;
    const newel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.022, newelH, 12),
      frameMat,
    );
    newel.position.set(stair.turnSplitX, newelH * 0.5, stair.lowerTopZ);

    const endPostH = totalRise + railH;
    const endPost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.02, endPostH, 12),
      frameMat,
    );
    endPost.position.set(stair.turnSplitX, endPostH * 0.5, stair.z0 + 0.04);

    const upperRailDz = stair.lowerTopZ - (stair.z0 + 0.04);
    const upperRailDy = endPostH - newelH;
    const upperRailLen = Math.hypot(upperRailDz, upperRailDy);
    const upperRail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, upperRailLen, 12),
      brassMat,
    );
    upperRail.position.set(
      stair.turnSplitX,
      (newelH + endPostH) * 0.5,
      (stair.lowerTopZ + stair.z0 + 0.04) * 0.5,
    );
    upperRail.rotation.x = -(Math.PI * 0.5 - Math.atan2(upperRailDy, upperRailDz));

    group.add(newel, endPost, upperRail);
    root.add(group);
  }

  return root;
}

export function buildExteriorStorefrontThreshold(
  spec: BakeryFloorPlanSpec,
  textures: FloorPlanTextures,
  plinthMat: THREE.Material,
  brassMat: THREE.Material,
  wainscotMat: THREE.Material,
  ceramicMat: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "storefront-threshold";

  const frontZ = spec.depth * 0.5;
  const hasSouthOpening =
    spec.doors.some((d) => Math.abs(d.hingeZ - frontZ) < 0.3) ||
    spec.windows.some((w) => Math.abs(w.z0 - frontZ) < 0.3);

  if (!hasSouthOpening) {
    // Basement / north-foyer entrance (e.g. HP Hongo B1F): street apron sits outside
    // the north-east foyer wall while the welcome mat and menu board sit in the B1F foyer.
    const foyerDoor =
      spec.doors.find(
        (d) => d.id === "door-storefront-double" || d.id === "door-front-entry",
      ) ?? spec.doors[0];
    const foyerZone = spec.zones.find((z) => z.id === "entry-foyer");
    const extNorthZ =
      foyerZone !== undefined
        ? Math.min(foyerZone.z0, foyerZone.z1)
        : -spec.depth * 0.3;
    const extMinX = 0.47;
    const extMaxX = spec.width * 0.5;
    const extCenterX = (extMinX + extMaxX) * 0.5;
    const apronW = extMaxX - extMinX + 0.28;
    const apronD = 0.82;
    const apronZ = extNorthZ - 0.14 - apronD * 0.5;

    const sidewalkPbr = textures.createPbr(
      "exterior:sidewalk-paver",
      0.9,
      apronW,
      apronD,
      SIDEWALK_PAVER_PBR_RECIPE,
    );
    const apronMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: sidewalkPbr.map,
      normalMap: sidewalkPbr.normalMap,
      normalScale: new THREE.Vector2(0.62, 0.62),
      roughnessMap: sidewalkPbr.roughnessMap,
      roughness: sidewalkPbr.roughnessMap !== null ? 1.0 : 0.68,
      metalness: 0.04,
      clearcoat: 0.12,
      clearcoatRoughness: 0.46,
      reflectivity: 0.48,
    });
    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(apronW, 0.068, apronD),
      apronMat,
    );
    apron.name = "storefront-sidewalk-apron";
    apron.position.set(extCenterX, -0.052, apronZ);
    apron.receiveShadow = true;

    const curbMat = new THREE.MeshPhysicalMaterial({
      color: 0xa8a39a,
      roughness: 0.56,
      metalness: 0.06,
      clearcoat: 0.14,
      clearcoatRoughness: 0.42,
    });
    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(apronW + 0.04, 0.076, 0.11),
      curbMat,
    );
    curb.name = "storefront-street-curb";
    curb.position.set(extCenterX, -0.044, apronZ - apronD * 0.5 - 0.055);
    curb.castShadow = true;
    curb.receiveShadow = true;
    group.add(apron, curb);

    const doorW = foyerDoor?.width ?? 0.74;
    const matCenterX =
      foyerDoor !== undefined ? foyerDoor.hingeX - doorW * 0.5 : 1.16;
    const matZ = (foyerDoor?.hingeZ ?? -1.44) - 0.24;
    const matW = Math.max(0.54, doorW - 0.04);
    const matD = 0.28;
    const matMat = new THREE.MeshPhysicalMaterial({
      color: 0x332e2a,
      roughness: 0.92,
      metalness: 0.02,
      sheen: 0.34,
      sheenRoughness: 0.84,
      sheenColor: new THREE.Color(0x6b5c4d),
    });
    const welcomeMatGroup = new THREE.Group();
    welcomeMatGroup.name = "storefront-welcome-mat";
    welcomeMatGroup.position.set(matCenterX, 0.005, matZ);
    const matFrame = new THREE.Mesh(
      new THREE.BoxGeometry(matW + 0.024, 0.005, matD + 0.024),
      brassMat,
    );
    const matBody = new THREE.Mesh(
      new THREE.BoxGeometry(matW, 0.007, matD),
      matMat,
    );
    matBody.position.y = 0.0015;
    matBody.receiveShadow = true;
    welcomeMatGroup.add(matFrame, matBody);
    group.add(welcomeMatGroup);

    const menuBoard = new THREE.Group();
    menuBoard.name = "storefront-menu-board";
    menuBoard.position.set(
      extMaxX - 0.24,
      0.004,
      (foyerDoor?.hingeZ ?? -1.44) - 0.62,
    );
    menuBoard.rotation.y = -0.35;
    for (const zSign of [-1, 1]) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.36, 0.54, 0.02),
        wainscotMat,
      );
      panel.position.set(0, 0.29, zSign * 0.085);
      panel.rotation.x = zSign * -0.18;
      const card = new THREE.Mesh(
        new THREE.BoxGeometry(0.29, 0.39, 0.006),
        ceramicMat,
      );
      card.position.set(0, 0.3, zSign * 0.098);
      card.rotation.x = zSign * -0.18;
      menuBoard.add(panel, card);
    }
    group.add(menuBoard);

    for (const node of group.getObjectsByProperty("isObject3D", true)) {
      if (node instanceof THREE.Mesh) node.raycast = noopRaycast;
    }
    return group;
  }

  const frontZones =
    (spec.voids?.length ?? 0) > 0
      ? spec.zones.filter((z) => Math.abs(Math.max(z.z0, z.z1) - frontZ) < 0.05)
      : [];
  const frontMinX =
    frontZones.length > 0
      ? Math.min(...frontZones.map((z) => Math.min(z.x0, z.x1)))
      : -spec.width * 0.5;
  const frontMaxX =
    frontZones.length > 0
      ? Math.max(...frontZones.map((z) => Math.max(z.x0, z.x1)))
      : spec.width * 0.5;
  const frontCenterX = (frontMinX + frontMaxX) * 0.5;
  const apronW = frontMaxX - frontMinX + 0.44;
  const apronD = 0.92;
  const apronZ = frontZ + 0.14 + apronD * 0.5;

  const sidewalkPbr = textures.createPbr(
    "exterior:sidewalk-paver",
    0.9,
    apronW,
    apronD,
    SIDEWALK_PAVER_PBR_RECIPE,
  );
  const apronMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: sidewalkPbr.map,
    normalMap: sidewalkPbr.normalMap,
    normalScale: new THREE.Vector2(0.62, 0.62),
    roughnessMap: sidewalkPbr.roughnessMap,
    roughness: sidewalkPbr.roughnessMap !== null ? 1.0 : 0.68,
    metalness: 0.04,
    clearcoat: 0.12,
    clearcoatRoughness: 0.46,
    reflectivity: 0.48,
  });
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(apronW, 0.068, apronD),
    apronMat,
  );
  apron.name = "storefront-sidewalk-apron";
  apron.position.set(frontCenterX, -0.052, apronZ);
  apron.receiveShadow = true;
  group.add(apron);

  // Dressed granite street curb, drainage gutter & brass boundary inlay
  const curbMat = new THREE.MeshPhysicalMaterial({
    color: 0xa8a39a,
    roughness: 0.56,
    metalness: 0.06,
    clearcoat: 0.14,
    clearcoatRoughness: 0.42,
  });
  const curbZ = frontZ + 0.14 + apronD + 0.055;
  const curb = new THREE.Mesh(
    new THREE.BoxGeometry(apronW + 0.04, 0.076, 0.11),
    curbMat,
  );
  curb.name = "storefront-street-curb";
  curb.position.set(frontCenterX, -0.044, curbZ);
  curb.castShadow = true;
  curb.receiveShadow = true;

  const gutter = new THREE.Mesh(
    new THREE.BoxGeometry(apronW + 0.04, 0.022, 0.14),
    plinthMat,
  );
  gutter.name = "storefront-street-gutter";
  gutter.position.set(frontCenterX, -0.078, curbZ + 0.11);
  gutter.receiveShadow = true;

  const boundaryStrip = new THREE.Mesh(
    new THREE.BoxGeometry(apronW - 0.16, 0.003, 0.016),
    brassMat,
  );
  boundaryStrip.position.set(frontCenterX, -0.0165, frontZ + 0.165);
  group.add(curb, gutter, boundaryStrip);

  // Honed stone entrance step + recessed woven charcoal welcome mat
  const frontDoor =
    spec.doors.find(
      (d) => d.id === "door-storefront-double" || d.id === "door-front-entry",
    ) ?? spec.doors[0];
  const doorW = frontDoor?.width ?? 0.88;
  const doorCenterX =
    frontDoor !== undefined
      ? frontDoor.hingeX + Math.cos(doorAngle(frontDoor, 0)) * (doorW * 0.5)
      : -spec.width * 0.28;

  const stepW = doorW + 0.26;
  const stepD = 0.38;
  const stepZ = frontZ + 0.26;
  const entryStep = new THREE.Mesh(
    new THREE.BoxGeometry(stepW, 0.018, stepD),
    curbMat,
  );
  entryStep.name = "storefront-entry-step";
  entryStep.position.set(doorCenterX, -0.011, stepZ);
  entryStep.castShadow = true;
  entryStep.receiveShadow = true;

  const stepNosing = new THREE.Mesh(
    new THREE.BoxGeometry(stepW + 0.006, 0.006, 0.016),
    brassMat,
  );
  stepNosing.position.set(doorCenterX, -0.002, stepZ + stepD * 0.5 - 0.006);

  const matW = Math.max(0.48, doorW - 0.06);
  const matD = 0.26;
  const matMat = new THREE.MeshPhysicalMaterial({
    color: 0x332e2a,
    roughness: 0.92,
    metalness: 0.02,
    sheen: 0.34,
    sheenRoughness: 0.84,
    sheenColor: new THREE.Color(0x6b5c4d),
  });
  const welcomeMatGroup = new THREE.Group();
  welcomeMatGroup.name = "storefront-welcome-mat";
  welcomeMatGroup.position.set(doorCenterX, -0.001, stepZ - 0.01);

  const matFrame = new THREE.Mesh(
    new THREE.BoxGeometry(matW + 0.024, 0.005, matD + 0.024),
    brassMat,
  );
  const matBody = new THREE.Mesh(
    new THREE.BoxGeometry(matW, 0.007, matD),
    matMat,
  );
  matBody.position.y = 0.0015;
  matBody.receiveShadow = true;
  welcomeMatGroup.add(matFrame, matBody);

  for (const rOff of [-0.08, -0.04, 0, 0.04, 0.08]) {
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(matW - 0.03, 0.002, 0.01),
      plinthMat,
    );
    rib.position.set(0, 0.0055, rOff);
    welcomeMatGroup.add(rib);
  }
  group.add(entryStep, stepNosing, welcomeMatGroup);

  // Flanking exterior rigged boxwood planters & timber/brass A-frame sidewalk menu board
  const planterXs: readonly [number, number] =
    doorCenterX > frontCenterX
      ? [frontMinX + 0.28, frontCenterX - 0.18]
      : [Math.min(frontMaxX - 0.85, 0.25), frontMaxX - 0.22];
  const planterNames = [
    "storefront-planter-left",
    "storefront-planter-right",
  ] as const;

  for (let i = 0; i < planterXs.length; i += 1) {
    const px = planterXs[i]!;
    const pGroup = new THREE.Group();
    pGroup.name = planterNames[i]!;
    pGroup.position.set(px, -0.018, frontZ + 0.33);
    pGroup.rotation.y = i === 0 ? 0.2 : 2.35;
    pGroup.add(buildContactShadowPad(0.38, 0.38, 0.22));
    withLivingAssets((templates) => {
      mountBotanicalPlanterModel(
        pGroup,
        templates,
        "storefront_shrub_planter",
        ceramicMat,
        brassMat,
        i * 1.9 + 0.6,
        true,
      );
    });
    group.add(pGroup);
  }

  // Sidewalk A-frame menu board ("storefront-menu-board")
  const menuBoard = new THREE.Group();
  menuBoard.name = "storefront-menu-board";
  const menuX = doorCenterX > 0 ? 0.24 : -0.45;
  menuBoard.position.set(menuX, -0.018, frontZ + 0.64);
  menuBoard.rotation.y = doorCenterX > 0 ? 0.24 : -0.24;

  for (const zSign of [-1, 1]) {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.58, 0.022),
      wainscotMat,
    );
    panel.position.set(0, 0.31, zSign * 0.09);
    panel.rotation.x = zSign * -0.18;
    panel.castShadow = true;
    panel.receiveShadow = true;

    const card = new THREE.Mesh(
      new THREE.BoxGeometry(0.31, 0.42, 0.006),
      ceramicMat,
    );
    card.position.set(0, 0.32, zSign * 0.104);
    card.rotation.x = zSign * -0.18;
    menuBoard.add(panel, card);
  }
  const hingeRod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.01, 0.4, 12),
    brassMat,
  );
  hingeRod.rotation.z = Math.PI * 0.5;
  hingeRod.position.y = 0.59;
  menuBoard.add(hingeRod, buildContactShadowPad(0.46, 0.34, 0.22));
  group.add(menuBoard);

  // Exterior threshold context is purely visual and never intercepts door/window pointer picks
  for (const node of group.getObjectsByProperty("isObject3D", true)) {
    if (node instanceof THREE.Mesh) node.raycast = noopRaycast;
  }

  return group;
}
