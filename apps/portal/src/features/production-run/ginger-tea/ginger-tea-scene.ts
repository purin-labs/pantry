import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ROBOTS } from "@seams/bakery-model/bakery-robots";
import { SceneHost } from "../scene-host";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import maruzenHobUrl from "../../../../../../assets/bakery-mujoco/maruzen-mih-02c/maruzen-mih-02c.glb?url";
import vollrathHobUrl from "../../../../../../assets/bakery-mujoco/vollrath-59500p/vollrath-59500p.glb?url";
import panasonicHobUrl from "../../../../../../assets/bakery-mujoco/panasonic-kz-ck1402/panasonic-kz-ck1402.glb?url";
import rinnaiHobUrl from "../../../../../../assets/bakery-mujoco/rinnai-rsb-150pj/rinnai-rsb-150pj.glb?url";
import ohausScaleUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import coolingRackUrl from "../models/cooling-rack-16.glb?url";
import washSinkUrl from "../models/wash-sink.glb?url";
import type {
  GingerTeaCobotSample,
  GingerTeaHobModel,
} from "@seams/production-simulation/recipes/ginger-tea/model";
import {
  fr10GripperKinematics,
  fr10Links,
  fr10ShoulderIk,
} from "@seams/production-simulation/kinematics/fr10";

export type GingerTeaCameraPreset =
  | "station"
  | "pan-staging"
  | "hob-straining"
  | "sink-service";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    GingerTeaCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [0.02, 0.94, 1.58],
    target: [0.02, 0.16, 0.22],
  },
  "pan-staging": {
    position: [-0.24, 0.68, 1.02],
    target: [-0.14, 0.14, 0.24],
  },
  "hob-straining": {
    position: [0.34, 0.62, 0.88],
    target: [0.34, 0.16, 0.22],
  },
  "sink-service": {
    position: [0.04, 0.72, 1.24],
    target: [0.0, 0.12, 0.28],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.12, 0.48, 0.0];
const INTERPOLATION_MS = 55;
const forwardKinematicsFr10 = fr10GripperKinematics(fr10Links(ROBOT_BASE_ZUP));
const solveFr10Ik = fr10ShoulderIk(ROBOT_BASE_ZUP);

function enableShadows(object: THREE.Object3D, cast = true, receive = true) {
  object.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.castShadow = cast;
      node.receiveShadow = receive;
    }
  });
}

function interpolateSample(
  a: GingerTeaCobotSample,
  b: GingerTeaCobotSample,
  u: number,
): GingerTeaCobotSample {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const lerp = THREE.MathUtils.lerp;
  const lv3 = (v1: Vec3, v2: Vec3): Vec3 => [
    lerp(v1[0], v2[0], u),
    lerp(v1[1], v2[1], u),
    lerp(v1[2], v2[2], u),
  ];
  return {
    ...b,
    timeS: lerp(a.timeS, b.timeS, u),
    panStaging: {
      ...b.panStaging,
      trayPosZUp: lv3(a.panStaging.trayPosZUp, b.panStaging.trayPosZUp),
      panBPosZUp: lv3(a.panStaging.panBPosZUp, b.panStaging.panBPosZUp),
      panBTiltRad: lerp(a.panStaging.panBTiltRad, b.panStaging.panBTiltRad, u),
    },
    scale: {
      ...b.scale,
      displayedG: lerp(a.scale.displayedG, b.scale.displayedG, u),
      panDeflectionM: lerp(a.scale.panDeflectionM, b.scale.panDeflectionM, u),
      gingerG: lerp(a.scale.gingerG, b.scale.gingerG, u),
      teaG: lerp(a.scale.teaG, b.scale.teaG, u),
      sugarG: lerp(a.scale.sugarG, b.scale.sugarG, u),
    },
    hobStation: {
      ...b.hobStation,
      panAPosZUp: lv3(a.hobStation.panAPosZUp, b.hobStation.panAPosZUp),
      panATiltRad: lerp(a.hobStation.panATiltRad, b.hobStation.panATiltRad, u),
      panAMassG: lerp(a.hobStation.panAMassG, b.hobStation.panAMassG, u),
      panATempC: lerp(a.hobStation.panATempC, b.hobStation.panATempC, u),
      evaporatedG: lerp(a.hobStation.evaporatedG, b.hobStation.evaporatedG, u),
    },
    straining: {
      ...b.straining,
      strainerPosZUp: lv3(
        a.straining.strainerPosZUp,
        b.straining.strainerPosZUp,
      ),
      retainedSolidsG: lerp(
        a.straining.retainedSolidsG,
        b.straining.retainedSolidsG,
        u,
      ),
      strainedMassG: lerp(
        a.straining.strainedMassG,
        b.straining.strainedMassG,
        u,
      ),
    },
    finishing: {
      ...b.finishing,
      milkAddedG: lerp(a.finishing.milkAddedG, b.finishing.milkAddedG, u),
      sugarAddedG: lerp(a.finishing.sugarAddedG, b.finishing.sugarAddedG, u),
      panBMassG: lerp(a.finishing.panBMassG, b.finishing.panBMassG, u),
      panBTempC: lerp(a.finishing.panBTempC, b.finishing.panBTempC, u),
      servedMassG: lerp(a.finishing.servedMassG, b.finishing.servedMassG, u),
    },
    cobot: {
      ...b.cobot,
      toolZUp: lv3(a.cobot.toolZUp, b.cobot.toolZUp),
      wristPitchRad: lerp(a.cobot.wristPitchRad, b.cobot.wristPitchRad, u),
      fingerOpeningM: lerp(a.cobot.fingerOpeningM, b.cobot.fingerOpeningM, u),
    },
  };
}

export class GingerTeaScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.04, 18);
  private readonly orbit: OrbitControls;
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Mesh();
  private readonly rightFinger = new THREE.Mesh();
  private pivots: readonly Readonly<{
    object: THREE.Object3D;
    axis: THREE.Vector3;
  }>[] = [];

  private scalePanNode: THREE.Object3D | null = null;
  private scalePanBaseY = 0.111;

  // Dynamic process visuals
  private readonly sinkWaterStream: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly coilGlowMesh: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly panAGroup = new THREE.Group();
  private readonly panALidGroup = new THREE.Group();
  private readonly panALiquidMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly panInsertTrayGroup = new THREE.Group();
  private readonly panBGroup = new THREE.Group();
  private readonly panBLiquidMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly strainerGroup = new THREE.Group();
  private readonly strainerSolidsMesh: THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly strainPourStream: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly servicePourStream: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly cupALiquidMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly cupBLiquidMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;

  private displayedFrame: GingerTeaCobotSample | null = null;
  private batchSamples: readonly GingerTeaCobotSample[] = [];
  private transitionStartedAt = 0;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";
  private readonly loadAbort = new AbortController();

  constructor(
    view: HTMLElement,
    private readonly hobModel: GingerTeaHobModel,
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
      size: { style: false },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;
    this.orbit = this.host.orbit;

    const preset = CAMERA_PRESETS.station;
    this.camera.position.set(...preset.position);
    this.orbit.target.set(...preset.target);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxDistance = 3.4;
    this.orbit.minDistance = 0.3;
    this.orbit.update();

    this.addLighting();
    this.addWorkcellBench();

    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xd4d9de,
      metalness: 0.88,
      roughness: 0.22,
    });
    const darkHandleMat = new THREE.MeshStandardMaterial({
      color: 0x24282c,
      roughness: 0.45,
      metalness: 0.2,
    });

    // Sink tap water stream (X = -0.62, Z = +0.18 in Three Y-up)
    this.sinkWaterStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.007, 0.22, 16),
      new THREE.MeshStandardMaterial({
        color: 0xa8d8ff,
        transparent: true,
        opacity: 0.72,
        roughness: 0.08,
      }),
    );
    this.sinkWaterStream.position.set(-0.62, 0.14, 0.18);
    this.sinkWaterStream.visible = false;
    this.scene.add(this.sinkWaterStream);

    // Induction coil glow on hob surface (X = +0.22, Z = +0.18 in Three Y-up)
    this.coilGlowMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.036, 0.082, 48),
      new THREE.MeshBasicMaterial({
        color: 0xff5a1f,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.0,
      }),
    );
    this.coilGlowMesh.rotation.x = -Math.PI / 2;
    this.coilGlowMesh.position.set(
      0.22,
      this.hobModel === "maruzen"
        ? 0.122
        : this.hobModel === "vollrath"
          ? 0.084
          : this.hobModel === "rinnai-rsb-150pj"
            ? 0.1065
            : 0.0545,
      0.18,
    );
    this.scene.add(this.coilGlowMesh);

    // Heatproof resting pad in front of the hob (X = +0.22, Z = +0.38)
    const corkPad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.105, 0.012, 36),
      new THREE.MeshStandardMaterial({
        color: 0x8a5e3b,
        roughness: 0.78,
      }),
    );
    corkPad.position.set(0.22, 0.006, 0.38);
    corkPad.receiveShadow = true;
    this.scene.add(corkPad);

    // Pan A (200 mm lidded ginger/tea extraction saucepan)
    const panAWall = new THREE.Mesh(
      new THREE.CylinderGeometry(0.095, 0.086, 0.056, 40, 1, true),
      stainlessMat,
    );
    panAWall.position.y = 0.028;
    const panABottom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.086, 0.086, 0.005, 40),
      stainlessMat,
    );
    panABottom.position.y = 0.0025;
    const panAHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.011, 0.16, 16),
      darkHandleMat,
    );
    panAHandle.rotation.z = Math.PI / 2;
    panAHandle.position.set(-0.155, 0.038, 0);

    const lidDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.096, 0.096, 0.005, 36),
      stainlessMat,
    );
    const lidKnob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.014, 0.018, 20),
      darkHandleMat,
    );
    lidKnob.position.y = 0.011;
    this.panALidGroup.add(lidDisc, lidKnob);
    this.panALidGroup.position.y = 0.058;

    this.panALiquidMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.084, 0.082, 0.032, 36),
      new THREE.MeshStandardMaterial({
        color: 0x8a3b12,
        roughness: 0.18,
        metalness: 0.04,
        transparent: true,
        opacity: 0.92,
      }),
    );
    this.panALiquidMesh.position.y = 0.018;
    this.panAGroup.add(
      panAWall,
      panABottom,
      panAHandle,
      this.panALiquidMesh,
      this.panALidGroup,
    );
    enableShadows(this.panAGroup);
    this.scene.add(this.panAGroup);

    // Rigid 600 × 400 mm pan-staging tray + 200 mm circular insert ring (`persistent-pan-staging/1`)
    const trayPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.008, 0.24),
      new THREE.MeshStandardMaterial({
        color: 0xb0b8c0,
        metalness: 0.72,
        roughness: 0.3,
      }),
    );
    trayPlate.position.y = 0.004;
    const insertRing = new THREE.Mesh(
      new THREE.RingGeometry(0.088, 0.112, 40),
      new THREE.MeshStandardMaterial({
        color: 0x3b424a,
        metalness: 0.55,
        roughness: 0.38,
        side: THREE.DoubleSide,
      }),
    );
    insertRing.rotation.x = -Math.PI / 2;
    insertRing.position.y = 0.009;
    this.panInsertTrayGroup.add(trayPlate, insertRing);
    enableShadows(this.panInsertTrayGroup);
    this.scene.add(this.panInsertTrayGroup);

    // Pan B (200 mm receiving saucepan / serving vessel)
    const panBWall = new THREE.Mesh(
      new THREE.CylinderGeometry(0.095, 0.086, 0.056, 40, 1, true),
      stainlessMat,
    );
    panBWall.position.y = 0.028;
    const panBBottom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.086, 0.086, 0.005, 40),
      stainlessMat,
    );
    panBBottom.position.y = 0.0025;
    const panBHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.011, 0.16, 16),
      darkHandleMat,
    );
    panBHandle.rotation.z = Math.PI / 2;
    panBHandle.position.set(0.155, 0.038, 0);

    this.panBLiquidMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.084, 0.082, 0.034, 36),
      new THREE.MeshStandardMaterial({
        color: 0xb87338,
        roughness: 0.2,
        metalness: 0.04,
      }),
    );
    this.panBLiquidMesh.position.y = 0.018;
    this.panBLiquidMesh.visible = false;
    this.panBGroup.add(panBWall, panBBottom, panBHandle, this.panBLiquidMesh);
    enableShadows(this.panBGroup);
    this.scene.add(this.panBGroup);

    // Fine mesh tea strainer suspended over the receiving station
    const strainerRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.048, 0.004, 12, 32),
      stainlessMat,
    );
    strainerRim.rotation.x = Math.PI / 2;
    const strainerBasket = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.046,
        24,
        16,
        0,
        Math.PI * 2,
        Math.PI / 2,
        Math.PI / 2,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xc2c9d0,
        metalness: 0.7,
        roughness: 0.35,
        wireframe: false,
        side: THREE.DoubleSide,
      }),
    );
    const strainerHandle = new THREE.Mesh(
      new THREE.BoxGeometry(0.095, 0.005, 0.012),
      stainlessMat,
    );
    strainerHandle.position.set(0.09, 0, 0);
    this.strainerSolidsMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 18, 12),
      new THREE.MeshStandardMaterial({
        color: 0x5c2c12,
        roughness: 0.65,
      }),
    );
    this.strainerSolidsMesh.scale.set(1, 0.45, 1);
    this.strainerSolidsMesh.position.y = -0.018;
    this.strainerSolidsMesh.visible = false;
    this.strainerGroup.add(
      strainerRim,
      strainerBasket,
      strainerHandle,
      this.strainerSolidsMesh,
    );
    enableShadows(this.strainerGroup);
    this.scene.add(this.strainerGroup);

    // Straining pour stream (Pan A -> Strainer -> Pan B)
    this.strainPourStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.008, 0.16, 16),
      new THREE.MeshStandardMaterial({
        color: 0x8c3b14,
        roughness: 0.16,
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.strainPourStream.position.set(0.5, 0.14, 0.2);
    this.strainPourStream.visible = false;
    this.scene.add(this.strainPourStream);

    // Two porcelain service cups at front-right (X = +0.54 and +0.64, Z = +0.38)
    const cupMat = new THREE.MeshStandardMaterial({
      color: 0xfaf6ee,
      roughness: 0.2,
      side: THREE.DoubleSide,
    });
    const makeCup = (x: number) => {
      const group = new THREE.Group();
      group.position.set(x, 0.0, 0.38);
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.038, 0.032, 0.082, 28, 1, true),
        cupMat,
      );
      body.position.y = 0.041;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.032, 0.032, 0.005, 28),
        cupMat,
      );
      base.position.y = 0.0025;
      const liquid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.03, 0.068, 28),
        new THREE.MeshStandardMaterial({
          color: 0xb87338,
          roughness: 0.2,
          metalness: 0.04,
        }),
      );
      liquid.position.y = 0.036;
      liquid.visible = false;
      group.add(body, base, liquid);
      enableShadows(group);
      this.scene.add(group);
      return liquid;
    };
    this.cupALiquidMesh = makeCup(0.53);
    this.cupBLiquidMesh = makeCup(0.63);

    this.servicePourStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.008, 0.14, 16),
      new THREE.MeshStandardMaterial({
        color: 0xb87338,
        roughness: 0.2,
      }),
    );
    this.servicePourStream.position.set(0.58, 0.11, 0.38);
    this.servicePourStream.visible = false;
    this.scene.add(this.servicePourStream);

    // Robot + parallel gripper
    this.robot.rotation.x = -Math.PI / 2;
    this.scene.add(this.robot);
    this.buildGripper();
    this.robot.add(this.gripper);

    this.host.requestFrame();
  }

  private addLighting(): void {
    const ambient = new THREE.HemisphereLight(0xfff6ea, 0x26221e, 0.68);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff3e2, 2.2);
    key.position.set(0.95, 1.85, 1.35);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.2;
    key.shadow.camera.far = 4.5;
    const d = 1.15;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdce8f8, 0.78);
    fill.position.set(-1.1, 1.1, 0.9);
    this.scene.add(fill);
  }

  private addWorkcellBench(): void {
    const benchTop = new THREE.Mesh(
      new THREE.BoxGeometry(1.48, 0.036, 0.96),
      new THREE.MeshStandardMaterial({
        color: 0xc8cfd6,
        metalness: 0.78,
        roughness: 0.26,
      }),
    );
    benchTop.position.set(0.12, -0.018, 0.04);
    benchTop.receiveShadow = true;
    this.scene.add(benchTop);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 4.6),
      new THREE.MeshStandardMaterial({
        color: 0x1c1a18,
        roughness: 0.85,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.82;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private buildGripper(): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2a2e33,
      metalness: 0.65,
      roughness: 0.32,
    });
    const palm = new THREE.Mesh(
      new THREE.BoxGeometry(0.048, 0.082, 0.036),
      bodyMat,
    );
    this.gripper.add(palm);

    const fingerGeom = new THREE.BoxGeometry(0.062, 0.01, 0.022);
    const fingerMat = new THREE.MeshStandardMaterial({
      color: 0x565d66,
      metalness: 0.75,
      roughness: 0.25,
    });
    this.leftFinger.geometry = fingerGeom;
    this.leftFinger.material = fingerMat;
    this.rightFinger.geometry = fingerGeom;
    this.rightFinger.material = fingerMat;
    this.gripper.add(this.leftFinger, this.rightFinger);
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const hobUrl =
      this.hobModel === "maruzen"
        ? maruzenHobUrl
        : this.hobModel === "vollrath"
          ? vollrathHobUrl
          : this.hobModel === "rinnai-rsb-150pj"
            ? rinnaiHobUrl
            : panasonicHobUrl;

    const [hobGltf, scaleGltf, rackGltf, sinkGltf, loadedRobot] =
      await Promise.all([
        loader.loadAsync(hobUrl),
        loader.loadAsync(ohausScaleUrl),
        loader.loadAsync(coolingRackUrl),
        loader.loadAsync(washSinkUrl),
        loadRobotVisual("fairino-fr10", this.loadAbort.signal),
      ]);
    if (this.loadAbort.signal.aborted || this.lifecycle === "disposed") return;

    // 1. Wash sink at far left (X = -0.66, Y = -0.82, Z = +0.18)
    const sinkRoot = sinkGltf.scene;
    sinkRoot.position.set(-0.66, -0.82, 0.18);
    enableShadows(sinkRoot);
    this.scene.add(sinkRoot);

    // 2. Clean pan staging rack behind-left (X = -0.52, Y = -0.82, Z = -0.32)
    const rackRoot = rackGltf.scene;
    rackRoot.position.set(-0.52, -0.82, -0.32);
    enableShadows(rackRoot);
    this.scene.add(rackRoot);

    // 3. Ohaus Ranger 3000 bench scale (X = -0.04, Y = 0, Z = +0.18)
    const scaleRoot = scaleGltf.scene;
    scaleRoot.position.set(-0.04, 0, 0.18);
    enableShadows(scaleRoot);
    this.scalePanNode =
      scaleRoot.getObjectByName("ranger_weighing_pan") ?? null;
    if (this.scalePanNode) {
      this.scalePanBaseY = this.scalePanNode.position.y;
    }
    this.scene.add(scaleRoot);

    // 4. Maruzen MIH-02C / Vollrath 59500P induction hob (X = +0.22, Y = 0, Z = +0.18)
    const hobRoot = hobGltf.scene;
    hobRoot.position.set(0.22, 0, 0.18);
    enableShadows(hobRoot);
    this.scene.add(hobRoot);

    // 5. FAIRINO FR10 Cobot
    loadedRobot.position.set(...ROBOT_BASE_ZUP);
    enableShadows(loadedRobot);
    this.robot.add(loadedRobot);

    const pivots: { object: THREE.Object3D; axis: THREE.Vector3 }[] = [];
    for (const joint of ROBOTS["fairino-fr10"].joints) {
      const node = loadedRobot.getObjectByName(joint.node);
      if (node !== undefined) {
        pivots.push({
          object: node,
          axis: new THREE.Vector3(...joint.axis),
        });
      }
    }
    this.pivots = pivots;

    this.lifecycle = "ready";
    if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame);
    }
    this.host.requestFrame();
  }

  setFrame(sample: GingerTeaCobotSample): void {
    this.batchSamples = [sample];
    this.displayedFrame = sample;
    if (this.lifecycle === "ready") {
      this.applySample(sample);
    }
    this.host.requestFrame();
  }

  setSamples(samples: readonly GingerTeaCobotSample[]): void {
    if (samples.length === 0) return;
    const start = this.displayedFrame ?? samples[0]!;
    this.batchSamples = [start, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  setCameraPreset(preset: GingerTeaCameraPreset): void {
    const target = CAMERA_PRESETS[preset];
    this.host.moveCamera(
      new THREE.Vector3(...target.position),
      new THREE.Vector3(...target.target),
      420,
      "smooth",
    );
  }

  private applySample(sample: GingerTeaCobotSample): void {
    this.displayedFrame = sample;

    // 1. Cobot IK & parallel gripper
    const joints = solveFr10Ik(
      sample.cobot.toolZUp,
      sample.cobot.wristPitchRad,
    );
    const fk = forwardKinematicsFr10(joints);
    for (let i = 0; i < this.pivots.length && i < fk.joints.length; i++) {
      const pivot = this.pivots[i]!;
      pivot.object.setRotationFromAxisAngle(pivot.axis, fk.joints[i]!);
    }
    const [gx, gy, gz, qw, qx, qy, qz] = fk.gripper;
    this.gripper.position.set(gx, gy, gz);
    this.gripper.quaternion.set(qx, qy, qz, qw);
    const halfOpen = Math.max(0.008, sample.cobot.fingerOpeningM);
    this.leftFinger.position.set(0.036, halfOpen, 0);
    this.rightFinger.position.set(0.036, -halfOpen, 0);

    // 2. Wash sink tap stream
    this.sinkWaterStream.visible = sample.sink.tapActive;

    // 3. Induction hob coil glow & Pan A (Z-up -> Three Y-up: X = x, Y = z, Z = -y)
    this.coilGlowMesh.material.opacity = sample.hobStation.coilActive
      ? 0.55 + 0.25 * Math.sin(sample.timeS * 8)
      : 0.0;
    const [pax, pay, paz] = sample.hobStation.panAPosZUp;
    this.panAGroup.position.set(pax, paz, -pay);
    this.panAGroup.rotation.set(0, 0, -sample.hobStation.panATiltRad);
    this.panALidGroup.visible = sample.hobStation.panALidSeated;
    const panAFillRatio = THREE.MathUtils.clamp(
      sample.hobStation.panAMassG / 465,
      0,
      1,
    );
    this.panALiquidMesh.visible = panAFillRatio > 0.02;
    this.panALiquidMesh.scale.y = Math.max(0.08, panAFillRatio);

    // 4. Rigid pan-staging tray insert & Pan B
    const [tx, ty, tz] = sample.panStaging.trayPosZUp;
    this.panInsertTrayGroup.position.set(tx, tz, -ty);
    const [pbx, pby, pbz] = sample.panStaging.panBPosZUp;
    this.panBGroup.position.set(pbx, pbz + 0.006, -pby);
    this.panBGroup.rotation.set(0, 0, -sample.panStaging.panBTiltRad);
    const panBFillRatio = THREE.MathUtils.clamp(
      sample.finishing.panBMassG / 580,
      0,
      1,
    );
    this.panBLiquidMesh.visible = panBFillRatio > 0.02;
    this.panBLiquidMesh.scale.y = Math.max(0.08, panBFillRatio);
    const isMilkColor =
      sample.mode === "two-pan-milk-tea" && sample.finishing.milkAddedG > 10;
    this.panBLiquidMesh.material.color.setHex(
      isMilkColor ? 0xc88d55 : 0x8e3b14,
    );

    // 5. Fine mesh strainer & pour streams
    const [sx, sy, sz] = sample.straining.strainerPosZUp;
    this.strainerGroup.position.set(sx, sz, -sy);
    this.strainerSolidsMesh.visible = sample.straining.retainedSolidsG > 2;
    this.strainPourStream.visible =
      sample.phase === "strain-and-inspect" &&
      sample.hobStation.pouringRateGS > 0;

    // 6. Ohaus scale weighing pan deflection
    if (this.scalePanNode) {
      this.scalePanNode.position.y =
        this.scalePanBaseY - sample.scale.panDeflectionM;
    }

    // 7. Service cups & pour stream
    this.servicePourStream.visible =
      sample.phase === "finish-and-serve" &&
      sample.hobStation.pouringRateGS > 0;
    this.servicePourStream.material.color.setHex(
      sample.mode === "two-pan-milk-tea" ? 0xc88d55 : 0x8e3b14,
    );
    const cupFill = THREE.MathUtils.clamp(
      sample.finishing.servedMassG /
        (sample.mode === "two-pan-milk-tea" ? 570 : 435),
      0,
      1,
    );
    for (const cupMesh of [this.cupALiquidMesh, this.cupBLiquidMesh]) {
      cupMesh.visible = cupFill > 0.02;
      cupMesh.scale.y = Math.max(0.08, cupFill);
      cupMesh.material.color.setHex(
        sample.mode === "two-pan-milk-tea" ? 0xc88d55 : 0x8e3b14,
      );
    }
  }

  /** Plays a batch of samples between two ticks; true while it plays. */
  private step(now: number): boolean {
    if (this.lifecycle === "ready" && this.batchSamples.length > 1) {
      const elapsed = now - this.transitionStartedAt;
      const progress = Math.min(1, elapsed / INTERPOLATION_MS);
      const scaled = progress * (this.batchSamples.length - 1);
      const idx = Math.min(
        this.batchSamples.length - 2,
        Math.floor(scaled),
      );
      const frac = scaled - idx;
      const interpolated = interpolateSample(
        this.batchSamples[idx]!,
        this.batchSamples[idx + 1]!,
        frac,
      );
      this.applySample(interpolated);
      return progress < 1;
    }
    return false;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.loadAbort.abort();
    this.host.dispose();
  }
}
