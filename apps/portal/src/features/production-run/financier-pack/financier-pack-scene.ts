import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { SceneHost } from "../scene-host";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import ohausScaleUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import coolingRackUrl from "../models/cooling-rack-16.glb?url";
import type { FinancierPackSample } from "@seams/production-simulation/recipes/financier-pack/model";
import {
  addPatisserieBench,
  enableSceneShadows as enableShadows,
  lerpVec3,
  ScalePan,
  studioLights,
} from "../appliance-sample-three";
import {
  buildPaddedGripper,
  fr10Arm,
  lerpCobot,
  mountFr10Visual,
  openFr10Fingers,
  reachFr10,
  type Fr10Pivot,
} from "../shared/cobot-rig";

export type FinancierPackCameraPreset =
  "station" | "demould" | "crumb" | "giftbox";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    FinancierPackCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [-0.04, 0.94, 1.52],
    target: [-0.05, 0.24, 0.08],
  },
  demould: {
    position: [-0.52, 0.62, 0.78],
    target: [-0.46, 0.12, 0.04],
  },
  crumb: {
    position: [0.06, 0.54, 0.76],
    target: [0.1, 0.1, 0.18],
  },
  giftbox: {
    position: [0.38, 0.58, 0.78],
    target: [0.36, 0.16, 0.14],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.14, 0.48, 0.0];
const INTERPOLATION_MS = 55;
const ARM = fr10Arm(ROBOT_BASE_ZUP);

function interpolateSample(
  a: FinancierPackSample,
  b: FinancierPackSample,
  u: number,
): FinancierPackSample {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const lerp = THREE.MathUtils.lerp;
  const lv3 = (v1: Vec3, v2: Vec3): Vec3 => lerpVec3(v1, v2, u);
  return {
    ...b,
    timeS: lerp(a.timeS, b.timeS, u),
    scale: {
      ...b.scale,
      displayedG: lerp(a.scale.displayedG, b.scale.displayedG, u),
      panDeflectionM: lerp(a.scale.panDeflectionM, b.scale.panDeflectionM, u),
    },
    coolingGrid: {
      ...b.coolingGrid,
      mouldPosZUp: lv3(a.coolingGrid.mouldPosZUp, b.coolingGrid.mouldPosZUp),
      mouldRollRad: lerp(
        a.coolingGrid.mouldRollRad,
        b.coolingGrid.mouldRollRad,
        u,
      ),
      coreTempC: lerp(a.coolingGrid.coreTempC, b.coolingGrid.coreTempC, u),
    },
    crumbCheck: {
      ...b.crumbCheck,
      samplePosZUp: lv3(a.crumbCheck.samplePosZUp, b.crumbCheck.samplePosZUp),
    },
    giftBox: {
      ...b.giftBox,
      packedNetG: lerp(a.giftBox.packedNetG, b.giftBox.packedNetG, u),
      activePiecePosZUp:
        a.giftBox.activePiecePosZUp && b.giftBox.activePiecePosZUp
          ? lv3(a.giftBox.activePiecePosZUp, b.giftBox.activePiecePosZUp)
          : b.giftBox.activePiecePosZUp,
      lidClosedProgress: lerp(
        a.giftBox.lidClosedProgress,
        b.giftBox.lidClosedProgress,
        u,
      ),
      ribbonProgress: lerp(
        a.giftBox.ribbonProgress,
        b.giftBox.ribbonProgress,
        u,
      ),
    },
    cobot: lerpCobot(a.cobot, b.cobot, u),
  };
}

function buildFinancierIngotMesh(
  crustMat: THREE.Material,
  bosseMat: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.056, 0.015, 0.032),
    crustMat,
  );
  base.position.y = 0.0075;
  base.castShadow = true;
  base.receiveShadow = true;
  const bosse = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    bosseMat,
  );
  bosse.scale.set(1.5, 0.34, 0.78);
  bosse.position.y = 0.014;
  group.add(base, bosse);
  return group;
}

export class FinancierPackScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.04, 18);
  private readonly loadAbort = new AbortController();

  private readonly zUpRoot = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Group();
  private readonly rightFinger = new THREE.Group();

  private readonly model = new THREE.Group();
  private readonly scaleRoot = new THREE.Group();
  private readonly coolingRackRoot = new THREE.Group();
  private readonly scalePan = new ScalePan();

  private readonly mouldGroup = new THREE.Group();
  private readonly gridFinanciers: THREE.Group[] = [];
  private readonly crumbWholeGroup: THREE.Group;
  private readonly crumbCutGroup = new THREE.Group();
  private readonly inFlightFinancier: THREE.Group;
  private readonly giftBoxRoot = new THREE.Group();
  private readonly giftBoxFinanciers: THREE.Group[] = [];
  private readonly giftBoxLid = new THREE.Group();
  private readonly giftBoxRibbon = new THREE.Group();

  private pivots: readonly Fr10Pivot[] = [];

  private lifecycle: "loading" | "ready" | "disposed" = "loading";
  private displayedFrame: FinancierPackSample | null = null;
  private batchSamples: readonly FinancierPackSample[] = [];
  private transitionStartedAt = 0;

  constructor(view: HTMLDivElement) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      renderer: { antialias: true, alpha: true },
      look: { exposure: 1.08, background: null, environmentIntensity: null },
      attach: "replace",
      pointer: "pan",
      size: { style: false },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;

    this.host.startAt(CAMERA_PRESETS.station, {
      minDistance: 0.25,
      maxDistance: 4.5,
      maxPolarAngle: Math.PI * 0.49,
    });

    const [hemi, keyLight, rimLight] = studioLights({
      hemi: 1.3,
      keyIntensity: 1.95,
      keyAt: [1.2, 2.6, 2.2],
      shadow: [0.3, 6.5],
      shadowExtent: [1.8, 1.6],
      rimIntensity: 0.75,
      rimAt: [-1.5, 1.8, -1.2],
    });

    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.robot.position.set(...ROBOT_BASE_ZUP);
    this.gripper.add(this.leftFinger, this.rightFinger);
    this.zUpRoot.add(this.robot, this.gripper);
    this.scene.add(hemi, keyLight, rimLight, this.zUpRoot, this.model);

    const crustMat = new THREE.MeshStandardMaterial({
      color: 0xbc6b21,
      roughness: 0.36,
      metalness: 0.02,
    });
    const bosseMat = new THREE.MeshStandardMaterial({
      color: 0xc97b2c,
      roughness: 0.32,
      metalness: 0.02,
    });

    addPatisserieBench(this.zUpRoot, {
      floor: 6.0,
      grid: [4.6, 23],
      centre: [0.0, -0.06],
      top: [1.78, 0.92],
      shelf: [1.68, 0.82],
      legRadius: 0.024,
      legs: [
        [-0.82, -0.46],
        [0.82, -0.46],
        [-0.82, 0.34],
        [0.82, 0.34],
      ],
      robotBase: ROBOT_BASE_ZUP,
    });
    buildPaddedGripper(this.gripper, this.leftFinger, this.rightFinger, {
      barX: 0.07,
      padY: 0.007,
    });
    this.buildCoolingGridAndWashBasin(crustMat, bosseMat);
    this.buildMatsunagaMould(crustMat, bosseMat);

    this.crumbWholeGroup = buildFinancierIngotMesh(crustMat, bosseMat);
    this.buildCrumbInspectionPlate(crustMat, bosseMat);
    this.inFlightFinancier = buildFinancierIngotMesh(crustMat, bosseMat);
    this.inFlightFinancier.visible = false;
    this.buildPatisserieGiftBox(crustMat, bosseMat);

    this.model.add(
      this.mouldGroup,
      this.crumbWholeGroup,
      this.crumbCutGroup,
      this.inFlightFinancier,
      this.giftBoxRoot,
    );

    // Appliance root placements (Three.js Y-up)
    this.scaleRoot.position.set(0.36, 0, 0.14);
    this.coolingRackRoot.position.set(-1.18, -0.78, -0.25);
    this.model.add(this.scaleRoot, this.coolingRackRoot);

    this.host.requestFrame();
  }

  private buildCoolingGridAndWashBasin(
    crustMat: THREE.Material,
    bosseMat: THREE.Material,
  ): void {
    const wireMat = new THREE.MeshStandardMaterial({
      color: 0xc2ccd6,
      roughness: 0.25,
      metalness: 0.86,
    });
    // Benchtop cooling wire grid at [-0.46, 0, 0.14] in Three.js Y-up
    const gridGroup = new THREE.Group();
    gridGroup.position.set(-0.46, 0, 0.14);

    const frameW = 0.34;
    const frameD = 0.28;
    const railH = 0.022;
    const fbGeo = new THREE.CylinderGeometry(0.003, 0.003, frameW, 10).rotateZ(
      Math.PI / 2,
    );
    for (const zOff of [-frameD / 2, frameD / 2] as const) {
      const bar = new THREE.Mesh(fbGeo, wireMat);
      bar.position.set(0, railH, zOff);
      gridGroup.add(bar);
    }
    const wireGeo = new THREE.CylinderGeometry(
      0.0018,
      0.0018,
      frameD,
      8,
    ).rotateX(Math.PI / 2);
    for (let i = -6; i <= 6; i++) {
      const wire = new THREE.Mesh(wireGeo, wireMat);
      wire.position.set(i * 0.024, railH + 0.002, 0);
      gridGroup.add(wire);
    }

    // 8 demoulded golden financiers resting on the wire grid
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) {
        const fin = buildFinancierIngotMesh(crustMat, bosseMat);
        fin.position.set(
          col === 0 ? -0.048 : 0.048,
          railH + 0.004,
          -0.084 + row * 0.056,
        );
        fin.visible = false;
        gridGroup.add(fin);
        this.gridFinanciers.push(fin);
      }
    }
    this.model.add(gridGroup);

    // Manual-care warm soapy wash basin at rear-left [-0.52, 0, -0.22]
    const basinGroup = new THREE.Group();
    basinGroup.position.set(-0.52, 0, -0.22);
    const basinMat = new THREE.MeshStandardMaterial({
      color: 0x9aa6b2,
      roughness: 0.28,
      metalness: 0.78,
    });
    const basinBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.036, 0.26),
      basinMat,
    );
    basinBase.position.y = 0.018;
    basinBase.receiveShadow = true;
    const waterMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.29, 0.01, 0.23),
      new THREE.MeshStandardMaterial({
        color: 0x7cb8d4,
        roughness: 0.14,
        metalness: 0.08,
        transparent: true,
        opacity: 0.65,
      }),
    );
    waterMesh.position.y = 0.032;
    basinGroup.add(basinBase, waterMesh);
    this.model.add(basinGroup);
  }

  private buildMatsunagaMould(
    crustMat: THREE.Material,
    bosseMat: THREE.Material,
  ): void {
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x949ea8,
      roughness: 0.34,
      metalness: 0.76,
    });
    const wellMat = new THREE.MeshStandardMaterial({
      color: 0x626b74,
      roughness: 0.42,
      metalness: 0.68,
    });
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.008, 0.26),
      plateMat,
    );
    plate.castShadow = true;
    this.mouldGroup.add(plate);

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) {
        const cx = col === 0 ? -0.048 : 0.048;
        const cz = -0.084 + row * 0.056;
        const well = new THREE.Mesh(
          new THREE.BoxGeometry(0.064, 0.012, 0.038),
          wellMat,
        );
        well.position.set(cx, 0.004, cz);
        this.mouldGroup.add(well);

        const inMouldFin = buildFinancierIngotMesh(crustMat, bosseMat);
        inMouldFin.name = "in_mould_financier";
        inMouldFin.position.set(cx, 0.006, cz);
        this.mouldGroup.add(inMouldFin);
      }
    }
  }

  private buildCrumbInspectionPlate(
    crustMat: THREE.Material,
    bosseMat: THREE.Material,
  ): void {
    // Porcelain crumb-check plate at [-0.06, 0, 0.22] in Three.js Y-up
    const plateGroup = new THREE.Group();
    plateGroup.position.set(-0.06, 0, 0.22);
    const porcelainMat = new THREE.MeshStandardMaterial({
      color: 0xf8f6f0,
      roughness: 0.18,
      metalness: 0.04,
    });
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.088, 0.072, 0.014, 32),
      porcelainMat,
    );
    rim.position.y = 0.007;
    rim.receiveShadow = true;
    plateGroup.add(rim);
    this.model.add(plateGroup);

    // Cut-open financier halves showing golden-ivory honeycombed interior crumb
    this.crumbCutGroup.position.set(-0.06, 0.014, 0.22);
    const crumbInteriorMat = new THREE.MeshStandardMaterial({
      color: 0xf2d282,
      roughness: 0.62,
      metalness: 0.0,
    });
    for (const sign of [-1, 1] as const) {
      const half = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.015, 0.032),
        crustMat,
      );
      body.position.y = 0.0075;
      const crumbFace = new THREE.Mesh(
        new THREE.PlaneGeometry(0.03, 0.014),
        crumbInteriorMat,
      );
      crumbFace.rotation.y = sign < 0 ? Math.PI / 2 : -Math.PI / 2;
      crumbFace.position.set(sign < 0 ? 0.0132 : -0.0132, 0.0075, 0);
      const bosseHalf = new THREE.Mesh(
        new THREE.SphereGeometry(0.011, 10, 8),
        bosseMat,
      );
      bosseHalf.scale.set(1.1, 0.35, 0.75);
      bosseHalf.position.y = 0.014;
      half.add(body, crumbFace, bosseHalf);
      half.position.set(sign * 0.02, 0, 0);
      half.rotation.y = sign * 0.18;
      this.crumbCutGroup.add(half);
    }
    this.crumbCutGroup.visible = false;
  }

  private buildPatisserieGiftBox(
    crustMat: THREE.Material,
    bosseMat: THREE.Material,
  ): void {
    // Positioned on the Ohaus Ranger 3000 scale pan at [0.36, 0.118, 0.14]
    this.giftBoxRoot.position.set(0.36, 0.118, 0.14);

    const ivoryBoxMat = new THREE.MeshStandardMaterial({
      color: 0xf6f1e6,
      roughness: 0.46,
      metalness: 0.04,
    });
    const goldFluteMat = new THREE.MeshStandardMaterial({
      color: 0xd4af53,
      roughness: 0.32,
      metalness: 0.52,
    });
    const satinRibbonMat = new THREE.MeshStandardMaterial({
      color: 0xc89b3c,
      roughness: 0.28,
      metalness: 0.48,
    });

    // Lower ballotin tray
    const trayBottom = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.006, 0.15),
      ivoryBoxMat,
    );
    trayBottom.position.y = 0.003;
    trayBottom.castShadow = true;
    trayBottom.receiveShadow = true;
    this.giftBoxRoot.add(trayBottom);

    const goldLiner = new THREE.Mesh(
      new THREE.BoxGeometry(0.208, 0.003, 0.138),
      goldFluteMat,
    );
    goldLiner.position.y = 0.0065;
    this.giftBoxRoot.add(goldLiner);

    const wallFB = new THREE.BoxGeometry(0.22, 0.028, 0.006);
    for (const zOff of [-0.072, 0.072] as const) {
      const w = new THREE.Mesh(wallFB, ivoryBoxMat);
      w.position.set(0, 0.014, zOff);
      w.castShadow = true;
      this.giftBoxRoot.add(w);
    }
    const wallLR = new THREE.BoxGeometry(0.006, 0.028, 0.138);
    for (const xOff of [-0.107, 0.107] as const) {
      const w = new THREE.Mesh(wallLR, ivoryBoxMat);
      w.position.set(xOff, 0.014, 0);
      w.castShadow = true;
      this.giftBoxRoot.add(w);
    }

    // 8 visual financier slots inside the ballotin (4 cols x 2 rows)
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const fin = buildFinancierIngotMesh(crustMat, bosseMat);
        fin.scale.set(0.76, 1.0, 0.92);
        fin.rotation.y = Math.PI / 2;
        fin.position.set(
          -0.069 + col * 0.046,
          0.008,
          row === 0 ? -0.032 : 0.032,
        );
        fin.visible = false;
        this.giftBoxRoot.add(fin);
        this.giftBoxFinanciers.push(fin);
      }
    }

    // Embossed ivory patisserie lid
    const lidTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.226, 0.012, 0.156),
      ivoryBoxMat,
    );
    const goldCrest = new THREE.Mesh(
      new THREE.BoxGeometry(0.068, 0.002, 0.038),
      goldFluteMat,
    );
    goldCrest.position.y = 0.0065;
    this.giftBoxLid.add(lidTop, goldCrest);
    this.giftBoxRoot.add(this.giftBoxLid);

    // Gold satin ribbon cross-bands & bow
    const ribbonLong = new THREE.Mesh(
      new THREE.BoxGeometry(0.232, 0.036, 0.024),
      satinRibbonMat,
    );
    ribbonLong.position.y = 0.02;
    const ribbonCross = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.037, 0.162),
      satinRibbonMat,
    );
    ribbonCross.position.y = 0.02;
    const bowLeft = new THREE.Mesh(
      new THREE.TorusGeometry(0.02, 0.005, 10, 20),
      satinRibbonMat,
    );
    bowLeft.rotation.x = Math.PI / 2;
    bowLeft.position.set(-0.017, 0.041, 0);
    const bowRight = new THREE.Mesh(
      new THREE.TorusGeometry(0.02, 0.005, 10, 20),
      satinRibbonMat,
    );
    bowRight.rotation.x = Math.PI / 2;
    bowRight.position.set(0.017, 0.041, 0);
    this.giftBoxRibbon.add(ribbonLong, ribbonCross, bowLeft, bowRight);
    this.giftBoxRibbon.visible = false;
    this.giftBoxRoot.add(this.giftBoxRibbon);
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const [scaleGltf, rackGltf, loadedRobot] = await Promise.all([
      loader.loadAsync(ohausScaleUrl),
      loader.loadAsync(coolingRackUrl),
      loadRobotVisual("fairino-fr10", this.loadAbort.signal),
    ]);

    if (this.lifecycle === "disposed") {
      scaleGltf.scene.traverse(disposePhysicsObject);
      rackGltf.scene.traverse(disposePhysicsObject);
      loadedRobot.traverse(disposePhysicsObject);
      return;
    }

    enableShadows(scaleGltf.scene);
    this.scalePan.bind(scaleGltf.scene);
    this.scaleRoot.add(scaleGltf.scene);

    enableShadows(rackGltf.scene);
    this.coolingRackRoot.add(rackGltf.scene);

    this.pivots = mountFr10Visual(this.robot, loadedRobot);
    this.lifecycle = "ready";

    if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame);
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: FinancierPackCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset], 360, "smooth");
  }

  setFrame(sample: FinancierPackSample): void {
    this.batchSamples = [sample];
    this.transitionStartedAt = performance.now();
    this.applySample(sample);
    this.host.requestFrame();
  }

  setSamples(samples: readonly FinancierPackSample[]): void {
    if (samples.length === 0) return;
    const start = this.displayedFrame ?? samples[0]!;
    this.batchSamples = [start, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: FinancierPackSample): void {
    this.displayedFrame = sample;
    const { scale, coolingGrid, crumbCheck, giftBox, cobot } = sample;

    // 1. Ohaus Ranger 3000 spring pan deflection
    this.scalePan.deflect(scale.panDeflectionM);

    // 2. Matsunaga 8P mould & wire cooling grid financiers
    this.mouldGroup.position.set(
      coolingGrid.mouldPosZUp[0],
      coolingGrid.mouldPosZUp[2],
      -coolingGrid.mouldPosZUp[1],
    );
    this.mouldGroup.rotation.set(0, 0, coolingGrid.mouldRollRad);
    for (const child of this.mouldGroup.children) {
      if (child.name === "in_mould_financier") {
        child.visible = !coolingGrid.mouldDemoulded;
      }
    }

    const totalDemoulded =
      sample.giftBox.targetCapacity + (crumbCheck.sampled ? 1 : 0);
    const visibleGridSlots = coolingGrid.mouldDemoulded
      ? Math.round(
          (coolingGrid.gridPiecesRemaining / Math.max(1, totalDemoulded)) * 8,
        )
      : 0;
    for (let i = 0; i < this.gridFinanciers.length; i++) {
      const mesh = this.gridFinanciers[i];
      if (mesh) {
        mesh.visible = i < visibleGridSlots;
      }
    }

    // 3. 23.5 g Crumb-check financier sample (whole in transit / on scale -> halved on plate)
    const showWholeSample =
      (cobot.holding === "crumb-piece" || crumbCheck.sampled) &&
      !crumbCheck.sampleCutOpen;
    this.crumbWholeGroup.visible = showWholeSample;
    if (showWholeSample) {
      this.crumbWholeGroup.position.set(
        crumbCheck.samplePosZUp[0],
        crumbCheck.samplePosZUp[2],
        -crumbCheck.samplePosZUp[1],
      );
    }
    this.crumbCutGroup.visible = crumbCheck.sampleCutOpen;

    // 4. Patisserie gift box on Ohaus scale + in-flight financier + lid + gold ribbon
    this.giftBoxRoot.position.y = 0.118 - scale.panDeflectionM;
    const filledSlots = Math.round(
      (giftBox.packedCount / Math.max(1, giftBox.targetCapacity)) * 8,
    );
    for (let i = 0; i < this.giftBoxFinanciers.length; i++) {
      const fin = this.giftBoxFinanciers[i];
      if (fin) {
        fin.visible = i < filledSlots;
      }
    }

    if (giftBox.activePiecePosZUp !== null) {
      this.inFlightFinancier.visible = true;
      this.inFlightFinancier.position.set(
        giftBox.activePiecePosZUp[0],
        giftBox.activePiecePosZUp[2],
        -giftBox.activePiecePosZUp[1],
      );
    } else {
      this.inFlightFinancier.visible = false;
    }

    // Lid rests behind scale at [0, 0.01, -0.32] until lidClosedProgress > 0
    if (giftBox.lidClosedProgress <= 0.01) {
      this.giftBoxLid.position.set(0, 0.006, -0.26);
      this.giftBoxLid.rotation.x = -0.15;
    } else {
      const u = giftBox.lidClosedProgress;
      this.giftBoxLid.position.set(
        0,
        THREE.MathUtils.lerp(0.09, 0.029, u),
        THREE.MathUtils.lerp(-0.22, 0, u),
      );
      this.giftBoxLid.rotation.x = THREE.MathUtils.lerp(-0.15, 0, u);
    }

    this.giftBoxRibbon.visible = giftBox.ribbonProgress > 0.05;
    if (this.giftBoxRibbon.visible) {
      this.giftBoxRibbon.scale.setScalar(
        THREE.MathUtils.lerp(0.85, 1.0, giftBox.ribbonProgress),
      );
    }

    // 5. FAIRINO FR10 6-DOF inverse kinematics & parallel gripper
    reachFr10(
      ARM,
      this.pivots,
      this.gripper,
      cobot.toolZUp,
      cobot.wristPitchRad,
    );
    openFr10Fingers(this.leftFinger, this.rightFinger, cobot.fingerOpeningM);
  }

  /** Plays a batch of samples between two ticks; true while it plays. */
  private step(now: number): boolean {
    if (this.batchSamples.length > 1) {
      const progress = Math.min(
        1,
        (now - this.transitionStartedAt) / INTERPOLATION_MS,
      );
      const scaled = progress * (this.batchSamples.length - 1);
      const idx = Math.min(
        this.batchSamples.length - 2,
        Math.max(0, Math.floor(scaled)),
      );
      const frac = scaled - idx;
      const a = this.batchSamples[idx]!;
      const b = this.batchSamples[idx + 1]!;
      this.applySample(interpolateSample(a, b, frac));
      if (progress >= 1) {
        this.batchSamples = [this.batchSamples.at(-1)!];
      }
    }

    return this.batchSamples.length > 1;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.loadAbort.abort();
    this.host.dispose();
  }
}
