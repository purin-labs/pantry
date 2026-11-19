import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { StationId } from "@seams/bakery-model/bakery";
import tableUrl from "../production-run/models/prep-table-steel.glb?url";
import mapleUrl from "../production-run/models/prep-table-maple.glb?url";
import ovenUrl from "../../../../../assets/bakery-mujoco/maruzen-mbco-4me/maruzen-mbco-4me.glb?url";
import hobUrl from "../../../../../assets/bakery-mujoco/maruzen-mih-02c/maruzen-mih-02c.glb?url";
import rinnaiStoveUrl from "../../../../../assets/bakery-mujoco/rinnai-rsb-150pj/rinnai-rsb-150pj.glb?url";
import mixerUrl from "../../../../../assets/bakery-mujoco/aicohsha-kpl9000s/aicohsha-kpl9000s.glb?url";
import scaleUrl from "../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import rackUrl from "../production-run/models/cooling-rack-16.glb?url";
import squareRegisterUrl from "../../../../../assets/bakery-mujoco/square-register-2g/square-register-2g.glb?url";
import starPrinterUrl from "../../../../../assets/bakery-mujoco/star-mcp31lb/star-mcp31lb.glb?url";
import starDrawerUrl from "../../../../../assets/bakery-mujoco/star-mjd36m/star-mjd36m.glb?url";
import { disposePhysicsObject } from "./spatial/physics-model";
import { ensureLivingAssetsLoaded } from "./spatial/living-asset-loader";
import type { stations } from "@seams/production-simulation/recipes/bakery/schedule";

const urls: Record<StationId, string> = {
  stage: tableUrl,
  portion: mapleUrl,
  bake: ovenUrl,
  cool: rackUrl,
  pack: tableUrl,
};

const COUNTER_Y = 0.85;

function buildBeurreNoisettePan(): THREE.Group {
  const panGroup = new THREE.Group();
  panGroup.name = "stage_butter_pan";
  const stainlessMat = new THREE.MeshStandardMaterial({
    color: 0xd6dde4,
    roughness: 0.22,
    metalness: 0.88,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(0.102, 0.095, 0.052, 32, 1, true),
    stainlessMat,
  );
  wall.position.y = 0.026;
  const bottom = new THREE.Mesh(
    new THREE.CircleGeometry(0.095, 32).rotateX(-Math.PI / 2),
    stainlessMat,
  );
  bottom.position.y = 0.002;
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.012, 0.14, 14).rotateZ(Math.PI * 0.44),
    new THREE.MeshStandardMaterial({
      color: 0x22282e,
      roughness: 0.55,
      metalness: 0.2,
    }),
  );
  handle.position.set(-0.15, 0.052, 0);

  const butterDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.092, 0.09, 0.018, 28),
    new THREE.MeshStandardMaterial({
      color: 0xb8681e,
      roughness: 0.2,
      metalness: 0.04,
    }),
  );
  butterDisc.name = "stage_butter_liquid";
  butterDisc.position.y = 0.014;

  const hobGlow = new THREE.Mesh(
    new THREE.RingGeometry(0.055, 0.105, 32).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xd97706,
      emissiveIntensity: 0,
      roughness: 0.3,
      side: THREE.DoubleSide,
    }),
  );
  hobGlow.name = "stage_hob_glow";
  hobGlow.position.y = 0.001;
  hobGlow.userData.excludeFromAo = true;

  panGroup.add(wall, bottom, handle, butterDisc, hobGlow);
  return panGroup;
}

function buildMatsunagaMouldProp(filled: boolean, baked: boolean): THREE.Group {
  const group = new THREE.Group();
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0x9aa3ad,
    roughness: 0.34,
    metalness: 0.76,
  });
  const wellMat = new THREE.MeshStandardMaterial({
    color: 0x677079,
    roughness: 0.42,
    metalness: 0.68,
  });
  const batterMat = new THREE.MeshStandardMaterial({
    color: baked ? 0xbc6b21 : 0xdfae5c,
    roughness: 0.34,
    metalness: 0.02,
  });

  const plate = new THREE.Mesh(
    new RoundedBoxGeometry(0.22, 0.008, 0.28, 3, 0.003),
    plateMat,
  );
  plate.position.y = 0.004;
  group.add(plate);

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      const cx = col === 0 ? -0.048 : 0.048;
      const cz = -0.09 + row * 0.06;
      const well = new THREE.Mesh(
        new RoundedBoxGeometry(0.082, 0.009, 0.042, 2, 0.0025),
        wellMat,
      );
      well.position.set(cx, 0.0055, cz);
      group.add(well);
      if (filled) {
        const ingot = new THREE.Mesh(
          new RoundedBoxGeometry(0.076, baked ? 0.014 : 0.01, 0.038, 2, 0.003),
          batterMat,
        );
        ingot.position.set(cx, baked ? 0.009 : 0.007, cz);
        group.add(ingot);
      }
    }
  }
  return group;
}

function buildPistonDepositorProp(): THREE.Group {
  const group = new THREE.Group();
  group.name = "portion_depositor";
  const stainlessMat = new THREE.MeshStandardMaterial({
    color: 0xd8dfe6,
    roughness: 0.2,
    metalness: 0.88,
    side: THREE.DoubleSide,
  });
  const standBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.052, 0.058, 0.01, 24),
    stainlessMat,
  );
  standBase.position.y = 0.005;
  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.058, 0.01, 0.13, 28, 1, true),
    stainlessMat,
  );
  cone.position.y = 0.12;
  const batter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.052, 0.014, 0.09, 24),
    new THREE.MeshStandardMaterial({
      color: 0xdfae5c,
      roughness: 0.24,
    }),
  );
  batter.position.y = 0.125;
  group.add(standBase, cone, batter);
  return group;
}

function buildGiftBoxPackingStation(): THREE.Group {
  const group = new THREE.Group();
  group.name = "pack_gift_boxes";
  const boxMat = new THREE.MeshStandardMaterial({
    color: 0xf4efe4,
    roughness: 0.55,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xc59b43,
    roughness: 0.35,
    metalness: 0.45,
  });
  const financierMat = new THREE.MeshStandardMaterial({
    color: 0xb8651e,
    roughness: 0.36,
  });

  // Open patisserie gift box being packed with 8 golden financiers
  const openBox = new THREE.Mesh(
    new RoundedBoxGeometry(0.24, 0.032, 0.18, 2, 0.004),
    boxMat,
  );
  openBox.position.set(-0.08, 0.016, 0.02);
  group.add(openBox);

  for (let i = 0; i < 8; i++) {
    const fin = new THREE.Mesh(
      new RoundedBoxGeometry(0.048, 0.016, 0.028, 2, 0.003),
      financierMat,
    );
    fin.position.set(-0.155 + (i % 4) * 0.05, 0.034, i < 4 ? -0.02 : 0.06);
    group.add(fin);
  }

  // Stack of 2 sealed gift boxes with gold satin ribbons
  for (let k = 0; k < 2; k++) {
    const closedBox = new THREE.Mesh(
      new RoundedBoxGeometry(0.22, 0.038, 0.16, 2, 0.004),
      boxMat,
    );
    closedBox.position.set(0.2, 0.019 + k * 0.04, 0.0);
    const ribbon = new THREE.Mesh(
      new THREE.BoxGeometry(0.224, 0.04, 0.024),
      trimMat,
    );
    ribbon.position.copy(closedBox.position);
    group.add(closedBox, ribbon);
  }
  return group;
}

const STATION_FOOTPRINT = "station_footprint";

/**
 * The part of a loaded station that its floor plan footprint measures. The
 * 3D view and the recording plan both draw this part, so that one station has
 * one size in every plan.
 */
export function stationFootprintModel(station: THREE.Object3D): THREE.Object3D {
  return station.getObjectByName(STATION_FOOTPRINT) ?? station;
}

export async function loadBakeryStation(
  item: (typeof stations)[number],
): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.position.set(item.position[0], 0, item.position[2]);
  try {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const footprintGroup = new THREE.Group();
    footprintGroup.name = STATION_FOOTPRINT;
    if (item.id === "bake") {
      const table = await loader.loadAsync(tableUrl);
      table.scene.position.set(0, 0, 0);
      table.scene.scale.set(0.72, 0.942, 1.12);
      footprintGroup.add(table.scene);
    }
    const model = await loader.loadAsync(urls[item.id]);
    model.scene.position.set(
      0,
      item.id === "bake" ? COUNTER_Y : item.position[1],
      0,
    );
    if (item.id === "stage" || item.id === "portion" || item.id === "pack") {
      model.scene.scale.set(0.787, 0.942, 0.853);
    }
    footprintGroup.add(model.scene);
    root.add(footprintGroup);

    if (item.id === "stage") {
      const [scaleGltf, hobGltf, rinnaiGltf, mixerGltf] = await Promise.all([
        loader.loadAsync(scaleUrl),
        loader.loadAsync(hobUrl),
        loader.loadAsync(rinnaiStoveUrl),
        loader.loadAsync(mixerUrl),
      ]);
      scaleGltf.scene.position.set(-0.38, COUNTER_Y, 0.12);
      const dryBowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.062, 0.052, 0.085, 24),
        new THREE.MeshStandardMaterial({
          color: 0xdbe2e9,
          roughness: 0.24,
          metalness: 0.84,
        }),
      );
      dryBowl.name = "stage_scale_bowl";
      dryBowl.position.set(0, 0.16, 0);
      const dryIngredients = new THREE.Mesh(
        new THREE.CylinderGeometry(0.056, 0.048, 0.036, 22),
        new THREE.MeshStandardMaterial({
          color: 0xf4ead2,
          roughness: 0.65,
          metalness: 0.02,
        }),
      );
      dryIngredients.name = "stage_scale_ingredients";
      dryIngredients.position.set(0, 0.186, 0);
      scaleGltf.scene.add(dryBowl, dryIngredients);

      rinnaiGltf.scene.position.set(-0.38, COUNTER_Y, -0.15);

      hobGltf.scene.scale.setScalar(0.82);
      hobGltf.scene.position.set(-0.02, COUNTER_Y, 0.06);
      const pan = buildBeurreNoisettePan();
      pan.position.set(-0.02, COUNTER_Y + 0.088, 0.06);

      mixerGltf.scene.position.set(0.36, COUNTER_Y, 0.02);
      const mixerBatter = new THREE.Mesh(
        new THREE.CylinderGeometry(0.092, 0.052, 0.076, 32),
        new THREE.MeshStandardMaterial({
          color: 0xdfae5c,
          roughness: 0.25,
          metalness: 0.02,
        }),
      );
      mixerBatter.name = "stage_mixer_batter";
      mixerBatter.position.set(0.36, COUNTER_Y + 0.088, 0.098);

      root.add(
        scaleGltf.scene,
        rinnaiGltf.scene,
        hobGltf.scene,
        pan,
        mixerGltf.scene,
        mixerBatter,
      );
    } else if (item.id === "portion") {
      const scaleGltf = await loader.loadAsync(scaleUrl);
      scaleGltf.scene.position.set(-0.36, COUNTER_Y, 0.04);
      const mouldOnScale = buildMatsunagaMouldProp(true, false);
      mouldOnScale.position.set(-0.36, COUNTER_Y + 0.118, 0.04);

      const depositor = buildPistonDepositorProp();
      depositor.position.set(-0.02, COUNTER_Y, 0.02);

      const secondMould = buildMatsunagaMouldProp(true, false);
      secondMould.position.set(0.32, COUNTER_Y + 0.01, 0.04);

      root.add(scaleGltf.scene, mouldOnScale, depositor, secondMould);
    } else if (item.id === "pack") {
      const [scaleGltf, drawerGltf, registerGltf, printerGltf] =
        await Promise.all([
          loader.loadAsync(scaleUrl),
          loader.loadAsync(starDrawerUrl),
          loader.loadAsync(squareRegisterUrl),
          loader.loadAsync(starPrinterUrl),
        ]);
      scaleGltf.scene.position.set(-0.42, COUNTER_Y, 0.02);
      const giftBoxes = buildGiftBoxPackingStation();
      giftBoxes.position.set(-0.04, COUNTER_Y, 0.02);
      drawerGltf.scene.position.set(0.36, COUNTER_Y, 0.04);
      registerGltf.scene.position.set(0.36, COUNTER_Y + 0.104, 0.03);
      printerGltf.scene.position.set(0.52, COUNTER_Y, -0.14);
      root.add(
        scaleGltf.scene,
        giftBoxes,
        drawerGltf.scene,
        registerGltf.scene,
        printerGltf.scene,
      );
    }

    await ensureLivingAssetsLoaded();
    return root;
  } catch (error) {
    root.traverse(disposePhysicsObject);
    throw error;
  }
}
