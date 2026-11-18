import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  LINEA_GLB_SHA256,
  EAGLE_GLB_SHA256,
} from "@seams/bakery-model/bakery-physics";
import { loadVisual } from "../../workflow-simulator/spatial/physics-asset-loader";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { SceneHost } from "../scene-host";
import {
  enableSceneShadows as enableShadows,
  studioLights,
} from "../appliance-sample-three";
import {
  buildArticulatedHumanWorker,
  poseArticulatedHumanWorker,
  type ArticulatedHumanWorker,
} from "../../workflow-simulator/spatial/human-worker-figure";
import steelTableUrl from "../models/prep-table-steel.glb?url";
import mapleTableUrl from "../models/prep-table-maple.glb?url";
import ovenUrl from "../../../../../../assets/bakery-mujoco/maruzen-mbco-4me/maruzen-mbco-4me.glb?url";
import hobUrl from "../../../../../../assets/bakery-mujoco/maruzen-mih-02c/maruzen-mih-02c.glb?url";
import rinnaiStoveUrl from "../../../../../../assets/bakery-mujoco/rinnai-rsb-150pj/rinnai-rsb-150pj.glb?url";
import mixerUrl from "../../../../../../assets/bakery-mujoco/aicohsha-kpl9000s/aicohsha-kpl9000s.glb?url";
import hitachiUrl from "../../../../../../assets/bakery-mujoco/hitachi-r-hws47xl/hitachi-r-hws47xl.glb?url";
import scaleUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import rackUrl from "../models/cooling-rack-16.glb?url";
import lineaUrl from "../../../../../../assets/bakery-mujoco/la-marzocco-linea-classic-s-2g/la-marzocco-linea-classic-s-2g.glb?url";
import eagleUrl from "../../../../../../assets/bakery-mujoco/victoria-arduino-eagle-one-2g/victoria-arduino-eagle-one-2g.glb?url";
import wpmEspressoUrl from "../../../../../../assets/bakery-mujoco/wpm-kd-330x/wpm-kd-330x.glb?url";
import wpmGrinderUrl from "../../../../../../assets/bakery-mujoco/wpm-zd-17od/wpm-zd-17od.glb?url";
import df64Url from "../../../../../../assets/bakery-mujoco/miicoffee-df64-gen2/miicoffee-df64-gen2.glb?url";
import lagomUrl from "../../../../../../assets/bakery-mujoco/option-o-lagom-casa/option-o-lagom-casa.glb?url";
import bricksUrl from "../../../../../../assets/bakery-mujoco/timemore-bricks-01s/timemore-bricks-01s.glb?url";
import opusUrl from "../../../../../../assets/bakery-mujoco/fellow-opus-2/fellow-opus-2.glb?url";
import im25pUrl from "../../../../../../assets/bakery-mujoco/hoshizaki-im-25p/hoshizaki-im-25p.glb?url";
import squareRegisterUrl from "../../../../../../assets/bakery-mujoco/square-register-2g/square-register-2g.glb?url";
import starPrinterUrl from "../../../../../../assets/bakery-mujoco/star-mcp31lb/star-mcp31lb.glb?url";
import starDrawerUrl from "../../../../../../assets/bakery-mujoco/star-mjd36m/star-mjd36m.glb?url";
import type {
  CafeShiftAppliance,
  CafeShiftGrinder,
  CafeShiftSample,
} from "@seams/production-simulation/recipes/cafe-shift/model";

export type CafeShiftCameraPreset =
  "overview" | "bakery" | "espresso-bar" | "packing";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    CafeShiftCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  overview: {
    position: [0.02, 1.38, 2.24],
    target: [0.0, 0.24, 0.04],
  },
  bakery: {
    position: [-0.62, 0.92, 1.34],
    target: [-0.62, 0.24, -0.02],
  },
  "espresso-bar": {
    position: [0.76, 0.82, 1.18],
    target: [0.68, 0.26, 0.04],
  },
  packing: {
    position: [-0.18, 0.72, 1.02],
    target: [-0.28, 0.16, 0.16],
  },
};

const BAKER_BASE_ZUP: Vec3 = [-0.64, 0.34, 0.0];
const INTERPOLATION_MS = 55;

export class CafeShiftScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
  private readonly zUpRoot = new THREE.Group();
  private readonly stationGroup = new THREE.Group();
  private readonly bakerWorker: ArticulatedHumanWorker =
    buildArticulatedHumanWorker(0xc2410c, 0);
  private readonly baristaWorker: ArticulatedHumanWorker =
    buildArticulatedHumanWorker(0x0f766e, 1);
  private readonly espressoHost = new THREE.Group();
  private readonly grinderHost = new THREE.Group();

  private butterLiquidMesh!: THREE.Mesh;
  private butterLiquidMat!: THREE.MeshStandardMaterial;
  private mouldIngots: THREE.Mesh[] = [];
  private mouldIngotMats: THREE.MeshStandardMaterial[] = [];
  private wireGridFinanciers: THREE.Mesh[] = [];
  private packedFinanciers: THREE.Mesh[] = [];
  private rejectedFinanciersGroup = new THREE.Group();
  private crumbSamplePiece!: THREE.Mesh;
  private giftBoxLidGroup = new THREE.Group();
  private giftBoxRibbonGroup = new THREE.Group();
  private ovenGlowLight!: THREE.PointLight;
  private scaleDisplayCtx: CanvasRenderingContext2D | null = null;
  private scaleDisplayTex: THREE.CanvasTexture | null = null;

  private activeBrewCupGroup = new THREE.Group();
  private activeBrewLiquid!: THREE.Mesh;
  private spoutStreamLeft!: THREE.Mesh;
  private spoutStreamRight!: THREE.Mesh;
  private servedCups: THREE.Group[] = [];
  private spentPuckMeshes: THREE.Mesh[] = [];
  private imDoorNode: Readonly<{
    object: THREE.Object3D;
    baseQuat: THREE.Quaternion;
  }> | null = null;
  private imWaterPlateNode: Readonly<{
    object: THREE.Object3D;
    baseQuat: THREE.Quaternion;
  }> | null = null;
  private imPowerSwitchNode: Readonly<{
    object: THREE.Object3D;
    baseQuat: THREE.Quaternion;
  }> | null = null;

  private readonly loadAbort = new AbortController();
  private batchSamples: readonly CafeShiftSample[] = [];
  private displayedFrame: CafeShiftSample | null = null;
  private transitionStartedAt = 0;
  private loadedEspressoAppliance: CafeShiftAppliance | null = null;
  private loadedEspressoVisual: THREE.Object3D | null = null;
  private loadingEspressoAppliance: CafeShiftAppliance | null = null;
  private loadedGrinder: CafeShiftGrinder | null = null;
  private loadedGrinderVisual: THREE.Object3D | null = null;
  private loadingGrinder: CafeShiftGrinder | null = null;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(view: HTMLElement) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      look: {
        exposure: 0.96,
        background: 0xded9d0,
        environmentIntensity: 0.52,
      },
      size: { minHeight: 540 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;

    this.host.startAt(CAMERA_PRESETS.overview, {
      minDistance: 0.35,
      maxDistance: 5.5,
      maxPolarAngle: Math.PI * 0.49,
    });

    const [hemi, keyLight, fillLight] = studioLights({
      sky: 0xfffaf0,
      ground: 0x6f685f,
      hemi: 1.25,
      key: 0xfff6e8,
      keyIntensity: 2.0,
      keyAt: [1.4, 2.8, 2.2],
      shadow: [0.3, 7.5],
      shadowExtent: [2.0, 1.8],
      rim: 0xdce8f8,
      rimIntensity: 0.78,
      rimAt: [-1.6, 1.9, -1.3],
    });

    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.bakerWorker.root.position.set(BAKER_BASE_ZUP[0], -0.78, -0.36);
    this.bakerWorker.root.scale.setScalar(1.32);
    this.baristaWorker.root.position.set(0.54, -0.78, -0.36);
    this.baristaWorker.root.scale.setScalar(1.32);
    enableShadows(this.bakerWorker.root);
    enableShadows(this.baristaWorker.root);
    this.stationGroup.add(this.bakerWorker.root, this.baristaWorker.root);

    this.scene.add(hemi, keyLight, fillLight, this.zUpRoot, this.stationGroup);
    this.buildCombinedCafeEnvironment();

    this.host.requestFrame();
  }

  private buildCombinedCafeEnvironment(): void {
    // Shared atelier floor & grid
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6.8, 5.4),
      new THREE.MeshStandardMaterial({
        color: 0xc9c2b8,
        roughness: 0.88,
        metalness: 0.02,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.78;
    floor.receiveShadow = true;
    this.stationGroup.add(floor);

    const grid = new THREE.GridHelper(5.6, 28, 0x9b9388, 0xb8b0a4);
    grid.position.y = -0.779;
    this.stationGroup.add(grid);

    // Anti-fatigue kitchen mats for Baker (#1) and Barista (#2)
    const matMaterial = new THREE.MeshStandardMaterial({
      color: 0x2b3036,
      roughness: 0.85,
      metalness: 0.08,
    });
    for (const baseX of [BAKER_BASE_ZUP[0], 0.54]) {
      const floorMat = new THREE.Mesh(
        new THREE.BoxGeometry(0.68, 0.014, 0.46),
        matMaterial,
      );
      floorMat.position.set(baseX, -0.772, -0.36);
      floorMat.receiveShadow = true;
      this.stationGroup.add(floorMat);
    }

    // Left Patisserie Bench (x = -0.58)
    const patisserieBench = new THREE.Mesh(
      new THREE.BoxGeometry(1.18, 0.04, 0.82),
      new THREE.MeshStandardMaterial({
        color: 0xcbd2d9,
        roughness: 0.32,
        metalness: 0.72,
      }),
    );
    patisserieBench.position.set(-0.56, -0.02, 0.08);
    patisserieBench.castShadow = true;
    patisserieBench.receiveShadow = true;
    this.stationGroup.add(patisserieBench);

    // Beurre noisette saucepan on induction zone (x = -0.92, z = 0.02)
    const panGroup = new THREE.Group();
    panGroup.position.set(-0.92, 0.085, 0.02);
    const panWallMat = new THREE.MeshStandardMaterial({
      color: 0xd8dfe6,
      roughness: 0.22,
      metalness: 0.88,
      side: THREE.DoubleSide,
    });
    const panWall = new THREE.Mesh(
      new THREE.CylinderGeometry(0.078, 0.072, 0.044, 28, 1, true),
      panWallMat,
    );
    panWall.position.y = 0.022;
    const panBottom = new THREE.Mesh(
      new THREE.CircleGeometry(0.072, 28).rotateX(-Math.PI / 2),
      panWallMat,
    );
    panBottom.position.y = 0.002;
    this.butterLiquidMat = new THREE.MeshStandardMaterial({
      color: 0xe6be5a,
      roughness: 0.18,
      metalness: 0.04,
    });
    this.butterLiquidMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.071, 0.069, 0.016, 24),
      this.butterLiquidMat,
    );
    this.butterLiquidMesh.position.y = 0.012;
    panGroup.add(panWall, panBottom, this.butterLiquidMesh);
    enableShadows(panGroup);
    this.stationGroup.add(panGroup);

    // Matsunaga 8P 8-cavity mould on portioning bench (x = -0.62, z = 0.18)
    const mouldGroup = new THREE.Group();
    mouldGroup.position.set(-0.62, 0.004, 0.18);
    const mouldPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.008, 0.24),
      new THREE.MeshStandardMaterial({
        color: 0x8f98a2,
        roughness: 0.34,
        metalness: 0.78,
      }),
    );
    mouldGroup.add(mouldPlate);
    for (let i = 0; i < 8; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = col === 0 ? -0.042 : 0.042;
      const cz = -0.075 + row * 0.05;
      const mat = new THREE.MeshStandardMaterial({
        color: 0xdfae5c,
        roughness: 0.34,
        metalness: 0.02,
      });
      const ingot = new THREE.Mesh(
        new THREE.BoxGeometry(0.062, 0.013, 0.032),
        mat,
      );
      ingot.position.set(cx, 0.008, cz);
      ingot.visible = false;
      mouldGroup.add(ingot);
      this.mouldIngots.push(ingot);
      this.mouldIngotMats.push(mat);
    }
    enableShadows(mouldGroup);
    this.stationGroup.add(mouldGroup);

    // Wire cooling grid (x = -0.38, z = 0.16)
    const gridGroup = new THREE.Group();
    gridGroup.position.set(-0.38, 0.012, 0.16);
    const gridFrame = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.006, 0.25),
      new THREE.MeshStandardMaterial({
        color: 0xc8d0d8,
        roughness: 0.25,
        metalness: 0.84,
        wireframe: false,
      }),
    );
    gridGroup.add(gridFrame);
    const bakedMat = new THREE.MeshStandardMaterial({
      color: 0xc47122,
      roughness: 0.36,
      metalness: 0.02,
    });
    for (let i = 0; i < 8; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const piece = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.015, 0.032),
        bakedMat,
      );
      piece.position.set(
        col === 0 ? -0.042 : 0.042,
        0.011,
        -0.075 + row * 0.05,
      );
      piece.visible = false;
      gridGroup.add(piece);
      this.wireGridFinanciers.push(piece);
    }
    enableShadows(gridGroup);
    this.stationGroup.add(gridGroup);

    // Rejected Load Disposal Tray (x = -0.92, z = 0.28)
    this.rejectedFinanciersGroup.position.set(-0.92, 0.008, 0.28);
    const rejectTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.008, 0.21),
      new THREE.MeshStandardMaterial({
        color: 0x6e3b34,
        roughness: 0.48,
        metalness: 0.35,
      }),
    );
    this.rejectedFinanciersGroup.add(rejectTray);
    const rejectedPieceMat = new THREE.MeshStandardMaterial({
      color: 0x6b3a18,
      roughness: 0.55,
      metalness: 0.02,
    });
    for (let i = 0; i < 8; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const rp = new THREE.Mesh(
        new THREE.BoxGeometry(0.056, 0.013, 0.028),
        rejectedPieceMat,
      );
      rp.position.set(col === 0 ? -0.038 : 0.038, 0.009, -0.065 + row * 0.044);
      this.rejectedFinanciersGroup.add(rp);
    }
    this.rejectedFinanciersGroup.visible = false;
    enableShadows(this.rejectedFinanciersGroup);
    this.stationGroup.add(this.rejectedFinanciersGroup);

    // Ohaus scale LCD readout plane & crumb sample piece (x = -0.14, z = 0.24)
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    this.scaleDisplayCtx = canvas.getContext("2d");
    this.scaleDisplayTex = new THREE.CanvasTexture(canvas);
    this.scaleDisplayTex.colorSpace = THREE.SRGBColorSpace;
    const lcdPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.075, 0.028).rotateX(-Math.PI * 0.28),
      new THREE.MeshBasicMaterial({ map: this.scaleDisplayTex }),
    );
    lcdPlane.position.set(-0.14, 0.056, 0.33);
    this.stationGroup.add(lcdPlane);

    this.crumbSamplePiece = new THREE.Mesh(
      new THREE.BoxGeometry(0.058, 0.015, 0.032),
      bakedMat,
    );
    this.crumbSamplePiece.position.set(-0.14, 0.068, 0.23);
    this.crumbSamplePiece.visible = false;
    this.stationGroup.add(this.crumbSamplePiece);

    // Gold-Ribbon Patisserie Ballotin Gift Box (x = 0.08, z = 0.20)
    const boxGroup = new THREE.Group();
    boxGroup.position.set(0.08, 0.004, 0.2);
    const boxBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.036, 0.16),
      new THREE.MeshStandardMaterial({
        color: 0xf5efe2,
        roughness: 0.42,
        metalness: 0.04,
      }),
    );
    boxBase.position.y = 0.018;
    const boxLiner = new THREE.Mesh(
      new THREE.BoxGeometry(0.206, 0.012, 0.146),
      new THREE.MeshStandardMaterial({
        color: 0x5c1f24,
        roughness: 0.58,
        metalness: 0.04,
      }),
    );
    boxLiner.position.y = 0.012;
    boxGroup.add(boxBase, boxLiner);

    for (let i = 0; i < 15; i++) {
      const col = i % 5;
      const row = Math.floor(i / 5);
      const fp = new THREE.Mesh(
        new THREE.BoxGeometry(0.034, 0.016, 0.038),
        bakedMat,
      );
      fp.position.set(-0.072 + col * 0.036, 0.024, -0.044 + row * 0.044);
      fp.visible = false;
      boxGroup.add(fp);
      this.packedFinanciers.push(fp);
    }

    const lidMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.226, 0.014, 0.166),
      new THREE.MeshStandardMaterial({
        color: 0xf7f2e7,
        roughness: 0.36,
        metalness: 0.06,
      }),
    );
    this.giftBoxLidGroup.add(lidMesh);
    this.giftBoxLidGroup.position.set(0, 0.04, -0.14);

    const ribbonMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.24,
      metalness: 0.78,
    });
    const ribbonX = new THREE.Mesh(
      new THREE.BoxGeometry(0.228, 0.016, 0.022),
      ribbonMat,
    );
    const ribbonZ = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.016, 0.168),
      ribbonMat,
    );
    this.giftBoxRibbonGroup.add(ribbonX, ribbonZ);
    this.giftBoxRibbonGroup.position.y = 0.041;
    this.giftBoxRibbonGroup.visible = false;

    boxGroup.add(this.giftBoxLidGroup, this.giftBoxRibbonGroup);
    enableShadows(boxGroup);
    this.stationGroup.add(boxGroup);

    // Oven interior warm glow light (at Maruzen MBCO-5E position)
    this.ovenGlowLight = new THREE.PointLight(0xff8c24, 0, 0.85);
    this.ovenGlowLight.position.set(-0.22, 0.42, -0.35);
    this.stationGroup.add(this.ovenGlowLight);

    // Right Espresso Service Bar Counter (x = 0.68)
    const espressoCounter = new THREE.Mesh(
      new THREE.BoxGeometry(1.04, 0.04, 0.84),
      new THREE.MeshStandardMaterial({
        color: 0xa68967,
        roughness: 0.44,
        metalness: 0.06,
      }),
    );
    espressoCounter.position.set(0.68, -0.02, 0.06);
    espressoCounter.castShadow = true;
    espressoCounter.receiveShadow = true;
    this.stationGroup.add(espressoCounter);

    const brassTrim = new THREE.Mesh(
      new THREE.BoxGeometry(1.044, 0.042, 0.014),
      new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        roughness: 0.24,
        metalness: 0.84,
      }),
    );
    brassTrim.position.set(0.68, -0.02, 0.484);
    this.stationGroup.add(brassTrim);

    // Espresso machine host at (x = 0.68, y = 0, z = 0.02) and single-dose grinder at (x = 0.28, y = 0, z = 0.04)
    this.espressoHost.position.set(0.68, 0, 0.02);
    this.grinderHost.position.set(0.28, 0, 0.04);
    this.stationGroup.add(this.espressoHost, this.grinderHost);

    // Active brewing cup + dual espresso spout streams
    this.activeBrewCupGroup.position.set(0.56, 0.21, 0.22);
    const cupMat = new THREE.MeshPhysicalMaterial({
      color: 0xf6f3ec,
      roughness: 0.14,
      clearcoat: 0.9,
    });
    const brewCupShell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.031, 0.023, 0.056, 28),
      cupMat,
    );
    this.activeBrewLiquid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.022, 0.044, 24),
      new THREE.MeshStandardMaterial({
        color: 0xb86824,
        roughness: 0.22,
        metalness: 0.04,
      }),
    );
    this.activeBrewLiquid.position.y = 0.008;
    this.activeBrewCupGroup.add(brewCupShell, this.activeBrewLiquid);
    this.stationGroup.add(this.activeBrewCupGroup);

    const streamMat = new THREE.MeshPhysicalMaterial({
      color: 0x5c2810,
      roughness: 0.08,
      clearcoat: 0.95,
      transparent: true,
      opacity: 0.92,
    });
    this.spoutStreamLeft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0018, 0.0014, 0.068, 12),
      streamMat,
    );
    this.spoutStreamLeft.position.set(0.552, 0.255, 0.22);
    this.spoutStreamRight = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0018, 0.0014, 0.068, 12),
      streamMat,
    );
    this.spoutStreamRight.position.set(0.568, 0.255, 0.22);
    this.stationGroup.add(this.spoutStreamLeft, this.spoutStreamRight);

    // 4 Brass Service Coasters + 4 Served Espresso Demitasse Cups on front bar
    const coasterMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.24,
      metalness: 0.86,
    });
    const cremaMat = new THREE.MeshStandardMaterial({
      color: 0xc27229,
      roughness: 0.26,
      metalness: 0.04,
    });
    for (let i = 0; i < 4; i++) {
      const cx = 0.46 + i * 0.095;
      const cz = 0.38;
      const coaster = new THREE.Mesh(
        new THREE.CylinderGeometry(0.034, 0.036, 0.005, 28),
        coasterMat,
      );
      coaster.position.set(cx, 0.003, cz);
      this.stationGroup.add(coaster);

      const servedCup = new THREE.Group();
      servedCup.position.set(cx, 0.032, cz);
      const shell = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.022, 0.054, 28),
        cupMat,
      );
      const crema = new THREE.Mesh(
        new THREE.CircleGeometry(0.027, 24).rotateX(-Math.PI / 2),
        cremaMat,
      );
      crema.position.y = 0.025;
      servedCup.add(shell, crema);
      servedCup.visible = false;
      enableShadows(servedCup);
      this.stationGroup.add(servedCup);
      this.servedCups.push(servedCup);
    }

    // Knock-box & spent espresso pucks at (x = 0.32, z = 0.34)
    const knockBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.075, 0.13),
      new THREE.MeshStandardMaterial({
        color: 0x2f343a,
        roughness: 0.36,
        metalness: 0.72,
      }),
    );
    knockBox.position.set(0.32, 0.038, 0.34);
    this.stationGroup.add(knockBox);

    const puckMat = new THREE.MeshStandardMaterial({
      color: 0x2b1b12,
      roughness: 0.92,
      metalness: 0.02,
    });
    for (let i = 0; i < 5; i++) {
      const puck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.026, 0.025, 0.016, 20),
        puckMat,
      );
      puck.position.set(
        0.305 + (i % 2) * 0.03,
        0.074 + Math.floor(i / 2) * 0.014,
        0.325 + ((i * 7) % 3) * 0.015,
      );
      puck.visible = false;
      this.stationGroup.add(puck);
      this.spentPuckMeshes.push(puck);
    }
  }

  async load(): Promise<void> {
    const gltfLoader = new GLTFLoader();
    const loadGltf = (url: string) =>
      new Promise<THREE.Group>((resolve, reject) => {
        gltfLoader.load(
          url,
          (gltf) => resolve(gltf.scene),
          undefined,
          (err) => reject(err),
        );
      });

    const [
      hobScene,
      rinnaiScene,
      mixerScene,
      ovenScene,
      hitachiScene,
      rackScene,
      scaleScene,
      steelTableScene,
      mapleTableScene,
      im25pScene,
      wpmEspressoScene,
      wpmGrinderScene,
      squareRegisterScene,
      starPrinterScene,
      starDrawerScene,
    ] = await Promise.all([
      loadGltf(hobUrl),
      loadGltf(rinnaiStoveUrl),
      loadGltf(mixerUrl),
      loadGltf(ovenUrl),
      loadGltf(hitachiUrl),
      loadGltf(rackUrl),
      loadGltf(scaleUrl),
      loadGltf(steelTableUrl),
      loadGltf(mapleTableUrl),
      loadGltf(im25pUrl),
      loadGltf(wpmEspressoUrl),
      loadGltf(wpmGrinderUrl),
      loadGltf(squareRegisterUrl),
      loadGltf(starPrinterUrl),
      loadGltf(starDrawerUrl),
    ]);

    if (this.lifecycle === "disposed") {
      return;
    }

    // Position the patisserie GLBs
    steelTableScene.position.set(-0.78, -0.78, 0.06);
    steelTableScene.scale.setScalar(0.75);
    enableShadows(steelTableScene);

    mapleTableScene.position.set(-0.18, -0.78, 0.14);
    mapleTableScene.scale.setScalar(0.72);
    enableShadows(mapleTableScene);

    hobScene.position.set(-0.92, 0.0, 0.02);
    hobScene.scale.setScalar(0.85);
    enableShadows(hobScene);

    rinnaiScene.position.set(-0.62, 0.0, -0.18);
    enableShadows(rinnaiScene);

    mixerScene.position.set(-1.08, 0.0, -0.22);
    enableShadows(mixerScene);

    ovenScene.position.set(-0.22, 0.0, -0.42);
    enableShadows(ovenScene);

    hitachiScene.position.set(-1.32, -0.78, -0.52);
    hitachiScene.scale.setScalar(0.82);
    enableShadows(hitachiScene);

    rackScene.position.set(-0.68, -0.78, -0.52);
    rackScene.scale.setScalar(0.72);
    enableShadows(rackScene);

    scaleScene.position.set(-0.14, 0.0, 0.24);
    scaleScene.scale.setScalar(0.92);
    enableShadows(scaleScene);

    wpmEspressoScene.position.set(1.02, 0.0, -0.02);
    wpmEspressoScene.scale.setScalar(0.86);
    enableShadows(wpmEspressoScene);

    wpmGrinderScene.position.set(0.86, 0.0, -0.06);
    wpmGrinderScene.scale.setScalar(0.88);
    enableShadows(wpmGrinderScene);

    starDrawerScene.position.set(0.08, 0.0, -0.12);
    starDrawerScene.scale.setScalar(0.82);
    enableShadows(starDrawerScene);

    squareRegisterScene.position.set(0.08, 0.085, -0.13);
    squareRegisterScene.scale.setScalar(0.82);
    enableShadows(squareRegisterScene);

    starPrinterScene.position.set(0.24, 0.0, -0.22);
    starPrinterScene.scale.setScalar(0.85);
    enableShadows(starPrinterScene);

    // Undercounter Hoshizaki IM-25P ice maker tucked beneath the right side of the espresso service counter
    im25pScene.position.set(0.92, -0.78, 0.08);
    im25pScene.scale.setScalar(0.98);
    enableShadows(im25pScene);
    const doorObj =
      im25pScene.getObjectByName("im25_door") ??
      im25pScene.getObjectByName("im_door");
    if (doorObj !== undefined) {
      this.imDoorNode = {
        object: doorObj,
        baseQuat: doorObj.quaternion.clone(),
      };
    }
    const waterPlateObj =
      im25pScene.getObjectByName("im25_water_plate") ??
      im25pScene.getObjectByName("im_water_plate");
    if (waterPlateObj !== undefined) {
      this.imWaterPlateNode = {
        object: waterPlateObj,
        baseQuat: waterPlateObj.quaternion.clone(),
      };
    }
    const powerSwitchObj =
      im25pScene.getObjectByName("im25_power_switch") ??
      im25pScene.getObjectByName("im_power_switch");
    if (powerSwitchObj !== undefined) {
      this.imPowerSwitchNode = {
        object: powerSwitchObj,
        baseQuat: powerSwitchObj.quaternion.clone(),
      };
    }

    this.stationGroup.add(
      steelTableScene,
      mapleTableScene,
      hobScene,
      rinnaiScene,
      mixerScene,
      ovenScene,
      hitachiScene,
      rackScene,
      scaleScene,
      wpmEspressoScene,
      wpmGrinderScene,
      starDrawerScene,
      squareRegisterScene,
      starPrinterScene,
      im25pScene,
    );

    await Promise.all([
      this.ensureEspressoVisual(this.displayedFrame?.appliance ?? "linea"),
      this.ensureGrinderVisual(
        this.displayedFrame?.grinder ?? "miicoffee-df64-gen2",
      ),
    ]);

    this.lifecycle = "ready";
    const latest = this.batchSamples.at(-1) ?? this.displayedFrame;
    if (latest !== null) {
      this.applySample(latest);
    }
    this.host.requestFrame();
  }

  private async ensureEspressoVisual(
    appliance: CafeShiftAppliance,
  ): Promise<void> {
    if (
      this.loadedEspressoAppliance === appliance ||
      this.loadingEspressoAppliance === appliance
    ) {
      return;
    }
    this.loadingEspressoAppliance = appliance;
    const url = appliance === "linea" ? lineaUrl : eagleUrl;
    const sha256 = appliance === "linea" ? LINEA_GLB_SHA256 : EAGLE_GLB_SHA256;
    try {
      const visual = await loadVisual(url, sha256, this.loadAbort.signal);
      if (this.lifecycle === "disposed") {
        visual.traverse(disposePhysicsObject);
        return;
      }
      if (this.loadedEspressoVisual !== null) {
        this.espressoHost.remove(this.loadedEspressoVisual);
        this.loadedEspressoVisual.traverse(disposePhysicsObject);
      }
      enableShadows(visual);
      this.loadedEspressoVisual = visual;
      this.loadedEspressoAppliance = appliance;
      this.espressoHost.add(visual);
      this.host.requestFrame();
    } finally {
      if (this.loadingEspressoAppliance === appliance) {
        this.loadingEspressoAppliance = null;
      }
    }
  }

  private async ensureGrinderVisual(grinder: CafeShiftGrinder): Promise<void> {
    if (this.loadedGrinder === grinder || this.loadingGrinder === grinder) {
      return;
    }
    this.loadingGrinder = grinder;
    const url =
      grinder === "miicoffee-df64-gen2"
        ? df64Url
        : grinder === "option-o-lagom-casa"
          ? lagomUrl
          : grinder === "timemore-bricks-01s"
            ? bricksUrl
            : opusUrl;
    const gltfLoader = new GLTFLoader();
    try {
      const visual = await new Promise<THREE.Group>((resolve, reject) => {
        gltfLoader.load(
          url,
          (gltf) => resolve(gltf.scene),
          undefined,
          (err) => reject(err),
        );
      });
      if (this.lifecycle === "disposed") {
        visual.traverse(disposePhysicsObject);
        return;
      }
      if (this.loadedGrinderVisual !== null) {
        this.grinderHost.remove(this.loadedGrinderVisual);
        this.loadedGrinderVisual.traverse(disposePhysicsObject);
      }
      enableShadows(visual);
      this.loadedGrinderVisual = visual;
      this.loadedGrinder = grinder;
      this.grinderHost.add(visual);
      this.host.requestFrame();
    } finally {
      if (this.loadingGrinder === grinder) {
        this.loadingGrinder = null;
      }
    }
  }

  setCameraPreset(preset: CafeShiftCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset]);
  }

  setFrame(sample: CafeShiftSample): void {
    this.setSamples([sample]);
  }

  setSamples(samples: readonly CafeShiftSample[]): void {
    const latest = samples.at(-1);
    if (latest === undefined) return;
    if (
      this.displayedFrame === null ||
      samples.length === 1 ||
      latest.timeSeconds <= this.displayedFrame.timeSeconds ||
      latest.timeSeconds - this.displayedFrame.timeSeconds > 4
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

  private applySample(sample: CafeShiftSample): void {
    this.displayedFrame = sample;
    if (
      this.loadedEspressoAppliance !== sample.appliance &&
      this.loadingEspressoAppliance !== sample.appliance
    ) {
      void this.ensureEspressoVisual(sample.appliance);
    }
    if (
      this.loadedGrinder !== sample.grinder &&
      this.loadingGrinder !== sample.grinder
    ) {
      void this.ensureGrinderVisual(sample.grinder);
    }

    // 1. Patisserie Baker (#1) articulated human posture
    const bakerYaw = sample.bakerJoints[0] * 0.42;
    this.bakerWorker.root.position.set(
      BAKER_BASE_ZUP[0] - sample.bakerJoints[0] * 0.22,
      -0.78,
      -0.36,
    );
    poseArticulatedHumanWorker(this.bakerWorker, {
      facingYawRad: bakerYaw,
      walking: false,
      working: sample.phase !== "completed",
      carrying: sample.bakerGripperOpen < 0.5,
      phase: sample.timeSeconds * 3.2 + sample.bakerJoints[1],
    });

    // 2. Espresso Barista (#2) articulated human posture
    this.baristaWorker.root.visible = sample.staffing === "two-workers";
    const baristaYaw = sample.baristaJoints[0] * 0.42;
    this.baristaWorker.root.position.set(
      0.54 + sample.baristaJoints[0] * 0.18,
      -0.78,
      -0.36,
    );
    poseArticulatedHumanWorker(this.baristaWorker, {
      facingYawRad: baristaYaw,
      walking: false,
      working: sample.phase !== "completed",
      carrying: sample.baristaGripperOpen < 0.5,
      phase: sample.timeSeconds * 3.6 + 1.2 + sample.baristaJoints[1],
    });

    // 3. Patisserie Line visual state
    const brownRatio = Math.min(
      1,
      Math.max(0, (sample.butterTempC - 30) / 122),
    );
    this.butterLiquidMat.color
      .setHex(0xe8c564)
      .lerp(new THREE.Color(0xa65818), brownRatio);

    const visibleMouldCavities = Math.min(8, sample.depositedCavities);
    const bakedTint = sample.bakeProgress;
    for (let i = 0; i < this.mouldIngots.length; i++) {
      const ingot = this.mouldIngots[i]!;
      const mat = this.mouldIngotMats[i]!;
      ingot.visible = i < visibleMouldCavities && sample.demouldedPieces === 0;
      mat.color.setHex(0xdfae5c).lerp(new THREE.Color(0xc47122), bakedTint);
      ingot.scale.y = 1 + bakedTint * 0.45;
    }

    this.ovenGlowLight.intensity =
      sample.phase === "bake-and-bar-service" ? 2.4 : 0.35;

    const onGridCount = Math.max(
      0,
      Math.min(8, sample.demouldedPieces) -
        sample.crumbSamplePieces -
        Math.min(7, sample.packedFinanciers),
    );
    for (let i = 0; i < this.wireGridFinanciers.length; i++) {
      this.wireGridFinanciers[i]!.visible = i < onGridCount;
    }

    this.rejectedFinanciersGroup.visible = sample.rejectedFinanciers > 0;
    this.crumbSamplePiece.visible = sample.crumbSamplePieces > 0;

    for (let i = 0; i < this.packedFinanciers.length; i++) {
      this.packedFinanciers[i]!.visible = i < sample.packedFinanciers;
    }

    if (sample.ribbonSealed > 0.05) {
      this.giftBoxLidGroup.position.set(
        0,
        0.04,
        THREE.MathUtils.lerp(-0.14, 0, sample.ribbonSealed),
      );
      this.giftBoxRibbonGroup.visible = sample.ribbonSealed > 0.55;
    } else {
      this.giftBoxLidGroup.position.set(0, 0.04, -0.14);
      this.giftBoxRibbonGroup.visible = false;
    }

    if (this.scaleDisplayCtx !== null && this.scaleDisplayTex !== null) {
      const ctx = this.scaleDisplayCtx;
      ctx.fillStyle = "#122117";
      ctx.fillRect(0, 0, 256, 96);
      ctx.fillStyle = "#48f582";
      ctx.font = "bold 40px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const displayG =
        sample.packedNetMassG > 0
          ? sample.packedNetMassG
          : sample.crumbSampleMassG > 0
            ? sample.crumbSampleMassG
            : sample.batterPreparedG;
      ctx.fillText(`${displayG.toFixed(1)} g`, 240, 48);
      this.scaleDisplayTex.needsUpdate = true;
    }

    // 4. Espresso Bar visual state
    const isDispensing = sample.shotState === "dispensing";
    this.spoutStreamLeft.visible = isDispensing;
    this.spoutStreamRight.visible = isDispensing;
    this.activeBrewCupGroup.visible =
      sample.phase === "batter-and-order-1" ||
      sample.phase === "deposit-and-order-2" ||
      isDispensing;
    const fillRatio = Math.min(1, Math.max(0.08, sample.activeCupMassG / 36));
    this.activeBrewLiquid.scale.set(1, fillRatio, 1);

    for (let i = 0; i < this.servedCups.length; i++) {
      this.servedCups[i]!.visible = i < sample.servedOrders;
    }
    for (let i = 0; i < this.spentPuckMeshes.length; i++) {
      this.spentPuckMeshes[i]!.visible = i < sample.spentPucks;
    }

    // 5. Hoshizaki IM-35P undercounter ice maker articulated state
    const xAxis = new THREE.Vector3(1, 0, 0);
    if (this.imDoorNode !== null) {
      this.imDoorNode.object.quaternion
        .copy(this.imDoorNode.baseQuat)
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(
            xAxis,
            sample.iceDoorAngleRad,
          ),
        );
    }
    if (this.imWaterPlateNode !== null) {
      this.imWaterPlateNode.object.quaternion
        .copy(this.imWaterPlateNode.baseQuat)
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(
            xAxis,
            -sample.iceWaterPlateAngleRad,
          ),
        );
    }
    if (this.imPowerSwitchNode !== null) {
      this.imPowerSwitchNode.object.quaternion
        .copy(this.imPowerSwitchNode.baseQuat)
        .multiply(new THREE.Quaternion().setFromAxisAngle(xAxis, 0.28));
    }
  }

  /** Plays a batch of samples between two ticks; true while it plays. */
  private step(now: number): boolean {
    if (this.batchSamples.length > 1) {
      const progress = Math.min(
        1,
        (now - this.transitionStartedAt) / INTERPOLATION_MS,
      );
      const idx = Math.min(
        this.batchSamples.length - 1,
        Math.floor(progress * this.batchSamples.length),
      );
      const sample = this.batchSamples[idx];
      if (sample !== undefined) this.applySample(sample);
      if (progress >= 1) {
        const last = this.batchSamples.at(-1);
        this.batchSamples = last === undefined ? [] : [last];
      }
    }

    return this.batchSamples.length > 1;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.loadAbort.abort();
    this.scaleDisplayTex?.dispose();
    this.host.dispose();
  }
}
