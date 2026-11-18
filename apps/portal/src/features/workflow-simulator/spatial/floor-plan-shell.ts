import { splitWallByWindows } from "@seams/production-simulation/floor/architecture";
import * as THREE from "three";
import { BAKERY_FLOOR_PLANS, type BakeryFloorPlanId } from "@seams/production-simulation/floor/bakery-room";
import { type FloorPlanWorkspace } from "../floor-plan-workspace";
import type { ApplianceId } from "@seams/production-simulation/floor/appliance-catalogue";
import {
  getStoreInteriorDesign,
  type StoreInteriorDesign,
} from "../store-interior-design";
import {
  FloorPlanTextures,
  resolveWallColors,
  resolveFixtureColors,
  floorPbrRecipe,
  wetTilePbrRecipe,
  wallSurfacePbrRecipe,
  wainscotPbrRecipe,
} from "./floor-plan-materials";
import {
  buildFloorPlanOpenings,
  updateOpeningVisuals,
} from "./floor-plan-openings-3d";
import {
  buildPlumbingFixtures,
  buildFloorPlanStairs,
  buildOverheadLightingAndHood,
  buildCustomerBenchMesh,
  buildPastryVitrineMesh,
  buildPlanterMesh,
  buildExteriorStorefrontThreshold,
} from "./floor-plan-fixtures";
import { enableShadowMeshes } from "./scene-lighting";

export function createFloorPlanShell(
  planId: BakeryFloorPlanId,
  ovenId: "bake" | "station-oven",
  workspace: FloorPlanWorkspace,
  options: Readonly<{
    fullHeightWalls?: boolean;
    design?: StoreInteriorDesign;
  }> = {},
): FloorPlanShell {
  const spec = BAKERY_FLOOR_PLANS[planId];
  const design = options.design ?? getStoreInteriorDesign();
  const textures = new FloorPlanTextures();
  const root = new THREE.Group();
  root.name = `floor-plan-shell:${spec.id}`;

  const wallPalette = resolveWallColors(design.wallMaterial);
  const fixturePalette = resolveFixtureColors(design.fixtureFinish);

  // 1. Base architectural sub-slab with chamfered dark plinth border
  const slabMat = new THREE.MeshStandardMaterial({
    color: wallPalette.plinthColor,
    roughness: 0.85,
    metalness: 0.08,
  });
  if ((spec.voids?.length ?? 0) > 0) {
    for (const zone of spec.zones) {
      const zw = Math.abs(zone.x1 - zone.x0);
      const zd = Math.abs(zone.z1 - zone.z0);
      const zoneSlab = new THREE.Mesh(
        new THREE.BoxGeometry(zw + 0.24, 0.08, zd + 0.24),
        slabMat,
      );
      zoneSlab.position.set(
        (zone.x0 + zone.x1) * 0.5,
        -0.052,
        (zone.z0 + zone.z1) * 0.5,
      );
      zoneSlab.receiveShadow = true;
      root.add(zoneSlab);
    }
  } else {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width + 0.28, 0.08, spec.depth + 0.28),
      slabMat,
    );
    slab.position.set(0, -0.052, 0);
    slab.receiveShadow = true;
    root.add(slab);
  }

  // 2. Textured floor zones with brass threshold strips between zones
  const brassMat = new THREE.MeshStandardMaterial({
    color: fixturePalette.accentBrassColor,
    roughness: 0.25,
    metalness: 0.85,
    envMapIntensity: 1.35,
  });

  for (const zone of spec.zones) {
    const w = Math.abs(zone.x1 - zone.x0);
    const d = Math.abs(zone.z1 - zone.z0);
    const cx = (zone.x0 + zone.x1) * 0.5;
    const cz = (zone.z0 + zone.z1) * 0.5;

    const pbr =
      zone.kind === "main"
        ? textures.createPbr(
            `floor:${design.floorMaterial}`,
            0.75,
            w,
            d,
            floorPbrRecipe(design.floorMaterial),
          )
        : textures.createPbr(
            `wet:${zone.kind}`,
            1.1,
            w,
            d,
            wetTilePbrRecipe(zone.kind),
          );

    const isPolishedStone =
      zone.kind === "main" &&
      (design.floorMaterial === "terrazzo-stone" ||
        design.floorMaterial === "limestone-checker");
    const isWoodFloor =
      zone.kind === "main" && design.floorMaterial === "herringbone-oak";
    const floorRoughness =
      zone.kind === "main"
        ? isPolishedStone
          ? 0.34
          : isWoodFloor
            ? 0.48
            : 0.58
        : 0.46;
    const floorClearcoat =
      zone.kind === "main"
        ? isPolishedStone
          ? 0.44
          : isWoodFloor
            ? 0.34
            : 0.16
        : 0.38;
    const floorClearcoatRoughness =
      zone.kind === "main" ? (isPolishedStone ? 0.16 : 0.26) : 0.2;
    const floorNormalScale =
      zone.kind === "main" ? (isPolishedStone ? 0.36 : 0.54) : 0.52;

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w - 0.008, 0.022, d - 0.008),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        map: pbr.map,
        normalMap: pbr.normalMap,
        normalScale: new THREE.Vector2(floorNormalScale, floorNormalScale),
        roughnessMap: pbr.roughnessMap,
        roughness: pbr.roughnessMap !== null ? 1.0 : floorRoughness,
        metalness: 0.04,
        clearcoat: floorClearcoat,
        clearcoatRoughness: floorClearcoatRoughness,
        reflectivity: 0.64,
        envMapIntensity: 1.15,
      }),
    );
    mesh.position.set(cx, -0.006, cz);
    mesh.receiveShadow = true;
    mesh.name = `zone:${zone.id}`;
    root.add(mesh);

    // Brass transition threshold along the front edge of wet/corridor zones
    if (zone.kind === "wet") {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(w - 0.04, 0.006, 0.022),
        brassMat,
      );
      strip.position.set(cx, 0.006, Math.max(zone.z0, zone.z1));
      root.add(strip);
    }
  }

  // 3. Walls with baseboard plinth, wainscot dado panel, and cutaway cap rail
  const wallPbr = textures.createPbr(
    `wall-surface:${design.wallMaterial}`,
    0.65,
    3.2,
    2.2,
    wallSurfacePbrRecipe(design.wallMaterial),
  );
  const wainscotPbr = textures.createPbr(
    `wainscot:${design.wallMaterial}`,
    1.2,
    2.4,
    0.8,
    wainscotPbrRecipe(design.wallMaterial),
  );
  const exteriorWallMat = new THREE.MeshStandardMaterial({
    color: wallPalette.exteriorColor,
    map: wallPbr.map,
    normalMap: wallPbr.normalMap,
    normalScale: new THREE.Vector2(0.48, 0.48),
    roughnessMap: wallPbr.roughnessMap,
    roughness: wallPbr.roughnessMap !== null ? 1.0 : wallPalette.roughness,
    metalness: 0.02,
  });
  const interiorWallMat = new THREE.MeshStandardMaterial({
    color: wallPalette.interiorColor,
    map: wallPbr.map,
    normalMap: wallPbr.normalMap,
    normalScale: new THREE.Vector2(0.48, 0.48),
    roughnessMap: wallPbr.roughnessMap,
    roughness: wallPbr.roughnessMap !== null ? 1.0 : wallPalette.roughness,
    metalness: 0.02,
  });
  const wainscotMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: wainscotPbr.map,
    normalMap: wainscotPbr.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap: wainscotPbr.roughnessMap,
    roughness: wainscotPbr.roughnessMap !== null ? 1.0 : 0.44,
    metalness: 0.05,
    clearcoat: 0.28,
    clearcoatRoughness: 0.34,
    envMapIntensity: 1.1,
  });
  const plinthMat = new THREE.MeshStandardMaterial({
    color: wallPalette.plinthColor,
    roughness: 0.56,
    metalness: 0.2,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: wallPalette.capColor,
    roughness: 0.44,
    metalness: 0.16,
  });

  for (const wall of spec.walls) {
    const subSegments = splitWallByWindows(wall, spec.windows);
    for (let subIdx = 0; subIdx < subSegments.length; subIdx += 1) {
      const seg = subSegments[subIdx]!;
      const dx = seg.x1 - seg.x0;
      const dz = seg.z1 - seg.z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;

      const isRearOrInteriorBackdrop =
        !wall.exterior ||
        (Math.abs(dz) < 0.05 && (seg.z0 + seg.z1) * 0.5 < -1.1);
      const effectiveWallMode =
        options.fullHeightWalls === true ? "full" : design.wallHeightMode;

      const sillOnly = seg.kind === "sill";
      let h = seg.kind === "sill" ? seg.sillHeight : seg.height;
      if (!sillOnly) {
        if (effectiveWallMode === "full") {
          h = wall.height * (spec.ceilingHeight / spec.cutawayWallHeight);
        } else if (
          effectiveWallMode === "smart-cutaway" &&
          isRearOrInteriorBackdrop &&
          wall.height >= 1.0
        ) {
          h = Math.min(spec.ceilingHeight, 2.35);
        } else if (wall.height >= 1.0) {
          h = 1.28;
        }
      }

      const wallGroup = new THREE.Group();
      wallGroup.name = `wall:${wall.id}:${subIdx}`;
      wallGroup.position.set(
        (seg.x0 + seg.x1) * 0.5,
        0,
        (seg.z0 + seg.z1) * 0.5,
      );
      wallGroup.rotation.y = -Math.atan2(dz, dx);

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(len, h, wall.thickness),
        wall.exterior ? exteriorWallMat : interiorWallMat,
      );
      mesh.position.y = h * 0.5;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      wallGroup.add(mesh);

      // Baseboard plinth
      if (h >= 0.25) {
        const plinth = new THREE.Mesh(
          new THREE.BoxGeometry(len + 0.004, 0.08, wall.thickness + 0.014),
          plinthMat,
        );
        plinth.position.y = 0.04;
        wallGroup.add(plinth);
      }

      // Interior timber/boiserie wainscot on full wall sections (never over windows)
      if (!sillOnly && h >= 0.95) {
        const wainscotHeight = Math.min(0.76, h - 0.14);
        const wainscot = new THREE.Mesh(
          new THREE.BoxGeometry(
            Math.max(0.04, len - 0.02),
            wainscotHeight,
            wall.thickness + 0.012,
          ),
          wainscotMat,
        );
        wainscot.position.y = 0.085 + wainscotHeight * 0.5;
        wallGroup.add(wainscot);

        const dadoRail = new THREE.Mesh(
          new THREE.BoxGeometry(
            Math.max(0.04, len - 0.01),
            0.018,
            wall.thickness + 0.022,
          ),
          brassMat,
        );
        dadoRail.position.y = 0.085 + wainscotHeight + 0.009;
        wallGroup.add(dadoRail);
      }

      // Architectural top cap rail on cutaway walls and window sills
      if (h >= 0.12 && (sillOnly || effectiveWallMode !== "full")) {
        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(len + 0.008, 0.022, wall.thickness + 0.018),
          capMat,
        );
        cap.position.y = h + 0.011;
        wallGroup.add(cap);
      }

      root.add(wallGroup);
    }
  }

  // 4. Structural RC columns & pilasters with timber/stone collar and plinth
  const columnMat = new THREE.MeshStandardMaterial({
    color: wallPalette.columnColor,
    roughness: 0.62,
    metalness: 0.08,
  });
  for (const col of spec.columns) {
    const w = Math.abs(col.x1 - col.x0);
    const d = Math.abs(col.z1 - col.z0);
    const cx = (col.x0 + col.x1) * 0.5;
    const cz = (col.z0 + col.z1) * 0.5;
    const effectiveWallMode =
      options.fullHeightWalls === true ? "full" : design.wallHeightMode;
    const h =
      effectiveWallMode === "full"
        ? spec.ceilingHeight
        : effectiveWallMode === "smart-cutaway"
          ? cz < 0
            ? Math.min(spec.ceilingHeight, 2.35)
            : 2.25
          : 1.28;

    const colGroup = new THREE.Group();
    colGroup.name = `column:${col.id}`;
    colGroup.position.set(cx, 0, cz);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), columnMat);
    mesh.position.y = h * 0.5;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    colGroup.add(mesh);

    const colPlinth = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.02, 0.09, d + 0.02),
      plinthMat,
    );
    colPlinth.position.y = 0.045;
    colGroup.add(colPlinth);

    const colCap = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.018, 0.024, d + 0.018),
      capMat,
    );
    colCap.position.y = h + 0.012;
    colGroup.add(colCap);

    root.add(colGroup);
  }

  // 5. Glass storefronts and windows with transom bar & brass/steel mullions
  const frameMat = new THREE.MeshStandardMaterial({
    color: fixturePalette.frameColor,
    roughness: fixturePalette.frameRoughness,
    metalness: fixturePalette.frameMetalness,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdff3fb,
    transparent: true,
    opacity: 0.26,
    roughness: 0.04,
    metalness: 0.06,
    ior: 1.52,
    reflectivity: 0.9,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.65,
    depthWrite: false,
  });

  const openings = buildFloorPlanOpenings(
    spec,
    frameMat,
    glassMat,
    brassMat,
    fixturePalette.doorLeafColor,
  );
  root.add(openings.root);

  // Storefront natural daylight fill entering through the primary glazing
  const storefrontWindow = spec.windows[0];
  const daylightX =
    storefrontWindow !== undefined
      ? (storefrontWindow.x0 + storefrontWindow.x1) * 0.5
      : 0;
  const daylightZ =
    storefrontWindow !== undefined
      ? (storefrontWindow.z0 + storefrontWindow.z1) * 0.5 - 0.18
      : spec.depth * 0.44;
  const storefrontDaylight = new THREE.PointLight(
    0xdff1ff,
    0.28,
    Math.max(spec.width, spec.depth) * 0.95,
    2.0,
  );
  storefrontDaylight.name = "storefront-daylight-fill";
  storefrontDaylight.position.set(daylightX, 1.48, daylightZ);
  root.add(storefrontDaylight);

  const fixtures = buildPlumbingFixtures(
    spec,
    textures,
    plinthMat,
    brassMat,
    columnMat,
  );
  root.add(fixtures.root);
  const { steelMat, basinMat, ceramicMat } = fixtures;

  if ((spec.stairs?.length ?? 0) > 0) {
    const stairEffectiveMode =
      options.fullHeightWalls === true ? "full" : design.wallHeightMode;
    const stairMaxRise =
      stairEffectiveMode === "full"
        ? spec.ceilingHeight - 0.15
        : stairEffectiveMode === "smart-cutaway"
          ? 1.72
          : 1.24;
    root.add(
      buildFloorPlanStairs(
        spec,
        stairMaxRise,
        columnMat,
        wainscotMat,
        brassMat,
        frameMat,
      ),
    );
  }

  // 7b. Exterior street-front sidewalk apron, granite curb, welcome mat & planters
  if (spec.id !== "reference") {
    root.add(
      buildExteriorStorefrontThreshold(
        spec,
        textures,
        plinthMat,
        brassMat,
        wainscotMat,
        ceramicMat,
      ),
    );
  }

  // 8. Overhead lighting fixtures & stainless canopy ventilation hood
  const overhead = buildOverheadLightingAndHood(
    spec,
    design.lightingStyle,
    brassMat,
    frameMat,
    steelMat,
    basinMat,
    workspace.getPose(planId, ovenId),
  );
  root.add(overhead.root);

  // 9. Draggable interior furnishings (customer bench, pastry vitrine, planter)
  const furnishings = new Map<ApplianceId, THREE.Group>();
  if (design.showFurnishings) {
    const decorGroup = new THREE.Group();
    decorGroup.name = "store-furnishings";
    furnishings.set(
      "decor-bench",
      buildCustomerBenchMesh(
        workspace.getPose(planId, "decor-bench"),
        wainscotMat,
        brassMat,
        frameMat,
      ),
    );
    furnishings.set(
      "decor-vitrine",
      buildPastryVitrineMesh(
        workspace.getPose(planId, "decor-vitrine"),
        wainscotMat,
        brassMat,
        glassMat,
        textures,
      ),
    );
    furnishings.set(
      "decor-planter",
      buildPlanterMesh(
        workspace.getPose(planId, "decor-planter"),
        ceramicMat,
        brassMat,
      ),
    );
    for (const node of furnishings.values()) decorGroup.add(node);
    root.add(decorGroup);
  }

  enableShadowMeshes(root);

  const shell = new FloorPlanShell(
    root,
    spec.id,
    ovenId,
    workspace,
    textures,
    openings.bindings,
    furnishings,
    overhead.hood,
  );
  shell.syncOpenings();
  return shell;
}

export class FloorPlanShell {
  constructor(
    readonly root: THREE.Group,
    readonly planId: BakeryFloorPlanId,
    private readonly ovenId: "bake" | "station-oven",
    private readonly workspace: FloorPlanWorkspace,
    private readonly textures: FloorPlanTextures,
    private readonly openings: Parameters<typeof updateOpeningVisuals>[0],
    private readonly furnishings: ReadonlyMap<ApplianceId, THREE.Group>,
    private readonly hood: THREE.Group,
  ) {}

  syncOpenings(): void {
    updateOpeningVisuals(this.openings, this.workspace);
  }

  syncPlacements(): void {
    for (const [id, node] of this.furnishings) {
      const pose = this.workspace.getPose(this.planId, id);
      node.position.set(pose.x, 0, pose.z);
      node.rotation.y = pose.rotY;
    }
    const oven = this.workspace.getPose(this.planId, this.ovenId);
    this.hood.position.set(oven.x, 2.12, oven.z);
    this.hood.rotation.y = oven.rotY;
  }

  syncVitrineStock(loosePieces: number, ballotinBoxes: number): void {
    const vitrine = this.furnishings.get("decor-vitrine");
    if (vitrine === undefined) return;
    vitrine.traverse(updateVitrineNode.bind(null, loosePieces, ballotinBoxes));
  }

  dispose(): void {
    this.root.userData.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const skeletons = new Set<THREE.Skeleton>();
    const extraTextures = new Set<THREE.Texture>();
    for (const node of this.root.getObjectsByProperty("isObject3D", true)) {
      if (node instanceof THREE.SkinnedMesh) skeletons.add(node.skeleton);
      if (!(node instanceof THREE.Mesh || node instanceof THREE.Line)) continue;
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) extraTextures.add(value);
        }
      }
    }
    for (const skeleton of skeletons) skeleton.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.textures.dispose(extraTextures);
    this.root.removeFromParent();
  }
}

function updateVitrineNode(
  loosePieces: number,
  ballotinBoxes: number,
  node: THREE.Object3D,
): void {
  const looseIndex = node.userData.vitrineLooseIndex;
  if (typeof looseIndex === "number") node.visible = looseIndex < loosePieces;
  const boxIndex = node.userData.vitrineBallotinIndex;
  if (typeof boxIndex === "number") node.visible = boxIndex < ballotinBoxes;
}
