import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SceneHost } from "../scene-host";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import waringWsg60Url from "../../../../../../assets/bakery-mujoco/waring-wsg60/waring-wsg60.glb?url";
import vitamixQuietOneUrl from "../../../../../../assets/bakery-mujoco/vitamix-quiet-one/vitamix-quiet-one.glb?url";
import ohausScaleUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import hoshizakiUrl from "../../../../../../assets/bakery-mujoco/hoshizaki-rt-120snj/hoshizaki-rt-120snj.glb?url";
import severinSm3587Url from "../../../../../../assets/bakery-mujoco/severin-sm-3587/severin-sm-3587.glb?url";
import type {
  BlackSesameCobotSample,
  BlackSesameHobModel,
} from "@purin-labs/production-simulation/recipes/black-sesame/model";
import {
  addWorkcellBench,
  addWorkcellLights,
  enableSceneShadows as enableShadows,
  inductionCoilGlow,
  inductionHobUrl,
  lerpVec3,
  playSampleBatch,
  ScalePan,
} from "../appliance-sample-three";
import {
  buildWorkcellGripper,
  fr10Arm,
  lerpCobot,
  mountFr10Visual,
  openFr10Fingers,
  reachFr10,
  type Fr10Pivot,
} from "../shared/cobot-rig";

export type BlackSesameCameraPreset =
  "station" | "grinder-blender" | "refrigerator" | "service";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    BlackSesameCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [0.06, 0.92, 1.56],
    target: [0.04, 0.16, 0.22],
  },
  "grinder-blender": {
    position: [-0.18, 0.68, 0.92],
    target: [-0.18, 0.24, 0.2],
  },
  refrigerator: {
    position: [0.34, 0.22, 1.18],
    target: [0.18, -0.24, 0.28],
  },
  service: {
    position: [0.58, 0.56, 0.86],
    target: [0.52, 0.18, 0.26],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.14, 0.48, 0.0];
const INTERPOLATION_MS = 55;
const ARM = fr10Arm(ROBOT_BASE_ZUP);

function interpolateSample(
  a: BlackSesameCobotSample,
  b: BlackSesameCobotSample,
  u: number,
): BlackSesameCobotSample {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const lerp = THREE.MathUtils.lerp;
  const lv3 = (v1: Vec3, v2: Vec3): Vec3 => lerpVec3(v1, v2, u);
  return {
    ...b,
    timeS: lerp(a.timeS, b.timeS, u),
    grinder: {
      ...b.grinder,
      bladeAngleRad: lerp(a.grinder.bladeAngleRad, b.grinder.bladeAngleRad, u),
      sesameGroundG: lerp(a.grinder.sesameGroundG, b.grinder.sesameGroundG, u),
    },
    induction: {
      ...b.induction,
      panPosZUp: lv3(a.induction.panPosZUp, b.induction.panPosZUp),
      panTiltRad: lerp(a.induction.panTiltRad, b.induction.panTiltRad, u),
      slurryMassG: lerp(a.induction.slurryMassG, b.induction.slurryMassG, u),
      slurryTempC: lerp(a.induction.slurryTempC, b.induction.slurryTempC, u),
      evaporatedG: lerp(a.induction.evaporatedG, b.induction.evaporatedG, u),
    },
    blender: {
      ...b.blender,
      bladeAngleRad: lerp(a.blender.bladeAngleRad, b.blender.bladeAngleRad, u),
      enclosureDoorAngleRad: lerp(
        a.blender.enclosureDoorAngleRad,
        b.blender.enclosureDoorAngleRad,
        u,
      ),
      containerMassG: lerp(
        a.blender.containerMassG,
        b.blender.containerMassG,
        u,
      ),
      concentrateTempC: lerp(
        a.blender.concentrateTempC,
        b.blender.concentrateTempC,
        u,
      ),
      homogenization: lerp(
        a.blender.homogenization,
        b.blender.homogenization,
        u,
      ),
    },
    scale: {
      ...b.scale,
      displayedG: lerp(a.scale.displayedG, b.scale.displayedG, u),
      panDeflectionM: lerp(a.scale.panDeflectionM, b.scale.panDeflectionM, u),
      waterTopUpG: lerp(a.scale.waterTopUpG, b.scale.waterTopUpG, u),
      standardizedMassG: lerp(
        a.scale.standardizedMassG,
        b.scale.standardizedMassG,
        u,
      ),
    },
    coldCarrier: {
      ...b.coldCarrier,
      carrierPosZUp: lv3(
        a.coldCarrier.carrierPosZUp,
        b.coldCarrier.carrierPosZUp,
      ),
      bottleAMassG: lerp(
        a.coldCarrier.bottleAMassG,
        b.coldCarrier.bottleAMassG,
        u,
      ),
      bottleBMassG: lerp(
        a.coldCarrier.bottleBMassG,
        b.coldCarrier.bottleBMassG,
        u,
      ),
      rightDoorAngleRad: lerp(
        a.coldCarrier.rightDoorAngleRad,
        b.coldCarrier.rightDoorAngleRad,
        u,
      ),
    },
    milkMixer: {
      ...b.milkMixer,
      jugPosZUp: lv3(a.milkMixer.jugPosZUp, b.milkMixer.jugPosZUp),
      jugTiltRad: lerp(a.milkMixer.jugTiltRad, b.milkMixer.jugTiltRad, u),
      stirrerAngleRad: lerp(
        a.milkMixer.stirrerAngleRad,
        b.milkMixer.stirrerAngleRad,
        u,
      ),
      concentrateDosedG: lerp(
        a.milkMixer.concentrateDosedG,
        b.milkMixer.concentrateDosedG,
        u,
      ),
      milkDosedG: lerp(a.milkMixer.milkDosedG, b.milkMixer.milkDosedG, u),
      drinkMassG: lerp(a.milkMixer.drinkMassG, b.milkMixer.drinkMassG, u),
      drinkTempC: lerp(a.milkMixer.drinkTempC, b.milkMixer.drinkTempC, u),
      servedCupG: lerp(a.milkMixer.servedCupG, b.milkMixer.servedCupG, u),
    },
    cobot: lerpCobot(a.cobot, b.cobot, u),
  };
}

export class BlackSesameScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.04, 18);
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Mesh();
  private readonly rightFinger = new THREE.Mesh();
  private pivots: readonly Fr10Pivot[] = [];

  // Articulated equipment nodes
  private wsgCoverNode: THREE.Object3D | null = null;
  private wsgBladeNode: THREE.Object3D | null = null;
  private wsgCoverBaseY = 0.21;

  private tqoDoorNode: THREE.Object3D | null = null;
  private tqoBladeNode: THREE.Object3D | null = null;

  private readonly scalePan = new ScalePan();

  private hoshizakiRightDoorNode: THREE.Object3D | null = null;

  private severinJugGroup = new THREE.Group();
  private severinStirrerNode: THREE.Object3D | null = null;

  // Dynamic process visuals
  private readonly coilGlowMesh: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly slurryPanGroup = new THREE.Group();
  private readonly slurryLiquidMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly slurryPourStream: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly vitamixEmulsionMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly coldCarrierGroup = new THREE.Group();
  private readonly bottleAFillMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly bottleBFillMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly severinPourStream: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly serviceCupLiquidMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;

  private displayedFrame: BlackSesameCobotSample | null = null;
  private batchSamples: readonly BlackSesameCobotSample[] = [];
  private transitionStartedAt = 0;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";
  private readonly loadAbort = new AbortController();

  constructor(
    view: HTMLElement,
    private readonly hobModel: BlackSesameHobModel,
  ) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      renderer: { antialias: true, powerPreference: "high-performance" },
      look: {
        exposure: 1.12,
        background: 0x161412,
        environmentIntensity: null,
        outputColorSpace: THREE.SRGBColorSpace,
      },
      attach: "replace",
      size: { minHeight: 560 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;

    this.host.startAt(CAMERA_PRESETS.station, {
      minDistance: 0.3,
      maxDistance: 3.2,
    });

    addWorkcellLights(this.scene, 1.1);
    // Upper stainless bench top at Y = 0, with open front bay on right for Hoshizaki RT-120SNJ undercounter refrigerator
    addWorkcellBench(this.scene, { width: 1.68, x: 0.02, floor: 4.4 });

    // Induction coil glow on hob surface (X = -0.22, Z = 0.18 in Three Y-up)
    this.coilGlowMesh = inductionCoilGlow(-0.22, this.hobModel);
    this.scene.add(this.coilGlowMesh);

    // 200 mm stainless steel slurry pan + translucent sweet rice-flour slurry
    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xd4d9de,
      metalness: 0.88,
      roughness: 0.22,
    });
    const panWall = new THREE.Mesh(
      new THREE.CylinderGeometry(0.095, 0.086, 0.052, 40, 1, true),
      stainlessMat,
    );
    panWall.position.y = 0.026;
    const panBottom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.086, 0.086, 0.005, 40),
      stainlessMat,
    );
    panBottom.position.y = 0.0025;
    const panHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.011, 0.16, 16),
      stainlessMat,
    );
    panHandle.rotation.z = Math.PI / 2;
    panHandle.position.set(-0.155, 0.038, 0);

    this.slurryLiquidMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.084, 0.082, 0.028, 36),
      new THREE.MeshStandardMaterial({
        color: 0xf4efe4,
        roughness: 0.18,
        metalness: 0.04,
        transparent: true,
        opacity: 0.92,
      }),
    );
    this.slurryLiquidMesh.position.y = 0.016;
    this.slurryPanGroup.add(
      panWall,
      panBottom,
      panHandle,
      this.slurryLiquidMesh,
    );
    enableShadows(this.slurryPanGroup);
    this.scene.add(this.slurryPanGroup);

    // Slurry pour stream into Vitamix container
    this.slurryPourStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.009, 0.18, 16),
      new THREE.MeshStandardMaterial({
        color: 0xf3eee2,
        roughness: 0.16,
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.slurryPourStream.position.set(0.08, 0.34, 0.2);
    this.slurryPourStream.visible = false;
    this.scene.add(this.slurryPourStream);

    // Glossy charcoal-black sesame concentrate inside Vitamix Advance container
    this.vitamixEmulsionMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.048, 0.12, 32),
      new THREE.MeshStandardMaterial({
        color: 0x1e1d20,
        roughness: 0.14,
        metalness: 0.08,
      }),
    );
    this.vitamixEmulsionMesh.position.set(0.08, 0.25, 0.2);
    this.vitamixEmulsionMesh.visible = false;
    this.scene.add(this.vitamixEmulsionMesh);

    // Covered cold-container carrier holding 2 × 380 g concentrate bottles (bottle-a, bottle-b)
    const carrierCaddy = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.055, 0.11),
      new THREE.MeshStandardMaterial({
        color: 0xbac2ca,
        metalness: 0.72,
        roughness: 0.28,
      }),
    );
    carrierCaddy.position.y = 0.028;
    const carrierHandleArch = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.012, 0.018),
      stainlessMat,
    );
    carrierHandleArch.position.y = 0.145;

    const glassBottleMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.36,
      roughness: 0.08,
      transmission: 0.65,
    });
    const bottleAGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.032, 0.125, 24),
      glassBottleMat,
    );
    bottleAGlass.position.set(-0.044, 0.072, 0);
    const bottleBGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.032, 0.125, 24),
      glassBottleMat,
    );
    bottleBGlass.position.set(0.044, 0.072, 0);

    const lidCapMat = new THREE.MeshStandardMaterial({
      color: 0x24282c,
      roughness: 0.35,
    });
    const bottleACap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.016, 20),
      lidCapMat,
    );
    bottleACap.position.set(-0.044, 0.14, 0);
    const bottleBCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.016, 20),
      lidCapMat,
    );
    bottleBCap.position.set(0.044, 0.14, 0);

    const sesameConcentrateMat = new THREE.MeshStandardMaterial({
      color: 0x1b1a1d,
      roughness: 0.15,
      metalness: 0.06,
    });
    this.bottleAFillMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.029, 0.029, 0.105, 24),
      sesameConcentrateMat,
    );
    this.bottleAFillMesh.position.set(-0.044, 0.062, 0);
    this.bottleBFillMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.029, 0.029, 0.105, 24),
      sesameConcentrateMat,
    );
    this.bottleBFillMesh.position.set(0.044, 0.062, 0);

    this.coldCarrierGroup.add(
      carrierCaddy,
      carrierHandleArch,
      bottleAGlass,
      bottleBGlass,
      bottleACap,
      bottleBCap,
      this.bottleAFillMesh,
      this.bottleBFillMesh,
    );
    enableShadows(this.coldCarrierGroup);
    this.scene.add(this.coldCarrierGroup);

    // Service cup at front-right (X = +0.58, Z = +0.39) + Severin pour stream
    const cupGroup = new THREE.Group();
    cupGroup.position.set(0.58, 0.0, 0.39);
    const cupBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.044, 0.036, 0.092, 32, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xfaf6ee,
        roughness: 0.2,
        side: THREE.DoubleSide,
      }),
    );
    cupBody.position.y = 0.046;
    const cupBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.036, 0.036, 0.006, 32),
      new THREE.MeshStandardMaterial({ color: 0xfaf6ee, roughness: 0.2 }),
    );
    cupBase.position.y = 0.003;
    this.serviceCupLiquidMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.041, 0.035, 0.076, 32),
      new THREE.MeshStandardMaterial({
        color: 0x4b484d,
        roughness: 0.22,
        metalness: 0.04,
      }),
    );
    this.serviceCupLiquidMesh.position.y = 0.04;
    this.serviceCupLiquidMesh.visible = false;
    cupGroup.add(cupBody, cupBase, this.serviceCupLiquidMesh);
    enableShadows(cupGroup);
    this.scene.add(cupGroup);

    this.severinPourStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.008, 0.14, 16),
      new THREE.MeshStandardMaterial({
        color: 0x524f54,
        roughness: 0.2,
      }),
    );
    this.severinPourStream.position.set(0.58, 0.12, 0.39);
    this.severinPourStream.visible = false;
    this.scene.add(this.severinPourStream);

    // Robot + parallel gripper
    this.robot.rotation.x = -Math.PI / 2;
    this.scene.add(this.robot);
    buildWorkcellGripper(this.gripper, this.leftFinger, this.rightFinger);
    this.robot.add(this.gripper);
    this.scene.add(this.severinJugGroup);

    this.host.requestFrame();
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const hobUrl = inductionHobUrl(this.hobModel);

    const [
      wsgGltf,
      hobGltf,
      tqoGltf,
      scaleGltf,
      hoshizakiGltf,
      severinGltf,
      loadedRobot,
    ] = await Promise.all([
      loader.loadAsync(waringWsg60Url),
      loader.loadAsync(hobUrl),
      loader.loadAsync(vitamixQuietOneUrl),
      loader.loadAsync(ohausScaleUrl),
      loader.loadAsync(hoshizakiUrl),
      loader.loadAsync(severinSm3587Url),
      loadRobotVisual("fairino-fr10", this.loadAbort.signal),
    ]);
    if (this.loadAbort.signal.aborted || this.lifecycle === "disposed") return;

    // 1. Waring WSG60 spice grinder at left (X = -0.52, Z = +0.18)
    const wsgRoot = wsgGltf.scene;
    wsgRoot.position.set(-0.52, 0, 0.18);
    enableShadows(wsgRoot);
    this.wsgCoverNode = wsgRoot.getObjectByName("wsg_cover") ?? null;
    if (this.wsgCoverNode) {
      this.wsgCoverBaseY = this.wsgCoverNode.position.y;
    }
    this.wsgBladeNode = wsgRoot.getObjectByName("wsg_blade") ?? null;
    this.scene.add(wsgRoot);

    // 2. Maruzen MIH-02C / Vollrath 59500P induction hob (X = -0.22, Z = +0.18)
    const hobRoot = hobGltf.scene;
    hobRoot.position.set(-0.22, 0, 0.18);
    enableShadows(hobRoot);
    this.scene.add(hobRoot);

    // 3. Vitamix The Quiet One blender at center (X = +0.08, Z = +0.20)
    const tqoRoot = tqoGltf.scene;
    tqoRoot.position.set(0.08, 0, 0.2);
    enableShadows(tqoRoot);
    this.tqoDoorNode = tqoRoot.getObjectByName("tqo_enclosure_door") ?? null;
    this.tqoBladeNode = tqoRoot.getObjectByName("tqo_blade") ?? null;
    this.scene.add(tqoRoot);

    // 4. Ohaus Ranger 3000 bench scale (X = +0.36, Z = +0.18)
    const scaleRoot = scaleGltf.scene;
    scaleRoot.position.set(0.36, 0, 0.18);
    enableShadows(scaleRoot);
    this.scalePan.bind(scaleRoot);
    this.scene.add(scaleRoot);

    // 5. Hoshizaki RT-120SNJ refrigerated worktop mounted under the bench (Y = -0.82, X = +0.05, Z = +0.12)
    const hoshizakiRoot = hoshizakiGltf.scene;
    hoshizakiRoot.position.set(0.05, -0.82, 0.12);
    enableShadows(hoshizakiRoot);
    this.hoshizakiRightDoorNode =
      hoshizakiRoot.getObjectByName("rt_door_right") ?? null;
    this.scene.add(hoshizakiRoot);

    // 6. Severin SM 3587 Spuma 700 Plus milk mixer at right (X = +0.58, Z = +0.18)
    const severinRoot = severinGltf.scene;
    severinRoot.position.set(0.58, 0, 0.18);
    enableShadows(severinRoot);
    const jugNode = severinRoot.getObjectByName("sm3587_jug");
    this.severinStirrerNode =
      severinRoot.getObjectByName("sm3587_stirrer") ?? null;
    if (jugNode) {
      this.severinJugGroup.add(jugNode);
      jugNode.position.set(0, 0, 0);
    }
    this.scene.add(severinRoot);

    // 7. FAIRINO FR10 Cobot
    this.pivots = mountFr10Visual(this.robot, loadedRobot);
    this.lifecycle = "ready";

    if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame, performance.now());
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: BlackSesameCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset]);
  }

  setFrame(sample: BlackSesameCobotSample): void {
    this.batchSamples = [sample];
    this.transitionStartedAt = performance.now();
    this.applySample(sample, this.transitionStartedAt);
    this.host.requestFrame();
  }

  setSamples(samples: readonly BlackSesameCobotSample[]): void {
    if (samples.length === 0) return;
    const first = this.displayedFrame ?? samples[0]!;
    this.batchSamples = [first, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: BlackSesameCobotSample, now: number): void {
    this.displayedFrame = sample;

    // 1. Waring WSG60 spice grinder cover & blade
    if (this.wsgCoverNode) {
      this.wsgCoverNode.position.y = sample.grinder.coverSeated
        ? this.wsgCoverBaseY
        : this.wsgCoverBaseY + 0.042;
    }
    if (this.wsgBladeNode) {
      this.wsgBladeNode.rotation.y = sample.grinder.bladeAngleRad;
    }

    // 2. Induction hob & sweet rice-flour slurry pan
    const { induction } = sample;
    this.coilGlowMesh.material.opacity = induction.coilActive
      ? 0.44 + Math.sin(now * 0.008) * 0.1
      : 0.0;
    this.slurryPanGroup.position.set(
      induction.panPosZUp[0],
      induction.panPosZUp[2],
      -induction.panPosZUp[1],
    );
    this.slurryPanGroup.rotation.set(0, 0, -induction.panTiltRad);
    const slurryFrac = THREE.MathUtils.clamp(
      induction.slurryMassG / 542,
      0.05,
      1.0,
    );
    this.slurryLiquidMesh.scale.set(1, slurryFrac, 1);
    this.slurryLiquidMesh.position.y = 0.004 + 0.014 * slurryFrac;
    this.slurryPourStream.visible = induction.pouringRateGS > 1;

    // 3. Vitamix The Quiet One acoustic door, blade, and concentrate fill
    const { blender } = sample;
    if (this.tqoDoorNode) {
      this.tqoDoorNode.rotation.x = -blender.enclosureDoorAngleRad;
    }
    if (this.tqoBladeNode) {
      this.tqoBladeNode.rotation.y = blender.bladeAngleRad;
    }
    this.vitamixEmulsionMesh.visible = blender.containerMassG > 10;
    if (this.vitamixEmulsionMesh.visible) {
      const fillFrac = THREE.MathUtils.clamp(
        blender.containerMassG / 760,
        0.1,
        1.0,
      );
      this.vitamixEmulsionMesh.scale.set(1, fillFrac, 1);
    }

    // 4. Ohaus Ranger 3000 scale pan deflection
    this.scalePan.deflect(sample.scale.panDeflectionM);

    // 5. Covered cold-container carrier & Hoshizaki RT-120SNJ right door
    const { coldCarrier } = sample;
    this.coldCarrierGroup.position.set(
      coldCarrier.carrierPosZUp[0],
      coldCarrier.carrierPosZUp[2],
      -coldCarrier.carrierPosZUp[1],
    );
    this.bottleAFillMesh.visible = coldCarrier.bottleAMassG > 5;
    if (this.bottleAFillMesh.visible) {
      const fA = THREE.MathUtils.clamp(coldCarrier.bottleAMassG / 380, 0.08, 1);
      this.bottleAFillMesh.scale.set(1, fA, 1);
    }
    this.bottleBFillMesh.visible = coldCarrier.bottleBMassG > 5;
    if (this.bottleBFillMesh.visible) {
      const fB = THREE.MathUtils.clamp(coldCarrier.bottleBMassG / 380, 0.08, 1);
      this.bottleBFillMesh.scale.set(1, fB, 1);
    }
    if (this.hoshizakiRightDoorNode) {
      this.hoshizakiRightDoorNode.rotation.y = coldCarrier.rightDoorAngleRad;
    }

    // 6. Severin SM 3587 jug, magnetic stirrer, and service cup
    const { milkMixer } = sample;
    this.severinJugGroup.position.set(
      milkMixer.jugPosZUp[0],
      milkMixer.jugPosZUp[2],
      -milkMixer.jugPosZUp[1],
    );
    this.severinJugGroup.rotation.set(0, 0, -milkMixer.jugTiltRad);
    if (this.severinStirrerNode) {
      this.severinStirrerNode.rotation.y = milkMixer.stirrerAngleRad;
    }
    this.severinPourStream.visible = milkMixer.pouringRateGS > 1;
    this.serviceCupLiquidMesh.visible = milkMixer.servedCupG > 5;
    if (this.serviceCupLiquidMesh.visible) {
      const cupFrac = THREE.MathUtils.clamp(
        milkMixer.servedCupG / 286,
        0.08,
        1.0,
      );
      this.serviceCupLiquidMesh.scale.set(1, cupFrac, 1);
      this.serviceCupLiquidMesh.position.y = 0.006 + 0.038 * cupFrac;
    }

    // 7. FAIRINO FR10 6-DOF inverse kinematics & parallel gripper
    reachFr10(
      ARM,
      this.pivots,
      this.gripper,
      sample.cobot.toolZUp,
      sample.cobot.wristPitchRad,
    );
    openFr10Fingers(
      this.leftFinger,
      this.rightFinger,
      sample.cobot.fingerOpeningM,
    );
  }

  /** Plays a batch of samples between two ticks; true while it plays. */
  private step(now: number): boolean {
    if (this.batchSamples.length > 1) {
      this.batchSamples = playSampleBatch(
        this.batchSamples,
        this.transitionStartedAt,
        now,
        INTERPOLATION_MS,
        interpolateSample,
        (sample) => this.applySample(sample, now),
      );
    } else if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame, now);
    }

    return this.batchSamples.length > 1;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.loadAbort.abort();
    this.host.dispose();
  }
}
