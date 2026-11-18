import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ROBOTS } from "@seams/bakery-model/bakery-robots";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { SceneHost } from "../scene-host";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import {
  bindOvenVisual,
  updateOvenVisual,
  type OvenVisual,
} from "../../workflow-simulator/oven-visual";
import maruzenOvenUrl from "../../../../../../assets/bakery-mujoco/maruzen-mbco-4me/maruzen-mbco-4me.glb?url";
import ohausScaleUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import type { FinancierBakeSample } from "@seams/production-simulation/recipes/financier-bake/model";
import {
  fr10GripperKinematics,
  fr10Links,
  fr10ShoulderIk,
} from "@seams/production-simulation/kinematics/fr10";

export type FinancierBakeCameraPreset =
  | "station"
  | "depositor"
  | "oven"
  | "cooling";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    FinancierBakeCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [-0.04, 0.96, 1.54],
    target: [-0.02, 0.28, 0.08],
  },
  depositor: {
    position: [-0.58, 0.62, 0.78],
    target: [-0.58, 0.16, 0.18],
  },
  oven: {
    position: [0.06, 0.62, 0.96],
    target: [0.34, 0.36, 0.02],
  },
  cooling: {
    position: [-0.2, 0.58, 0.72],
    target: [-0.2, 0.08, 0.18],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.36, 0.48, 0.0];
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
  a: FinancierBakeSample,
  b: FinancierBakeSample,
  u: number,
): FinancierBakeSample {
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
    scale: {
      ...b.scale,
      displayedG: lerp(a.scale.displayedG, b.scale.displayedG, u),
      panDeflectionM: lerp(a.scale.panDeflectionM, b.scale.panDeflectionM, u),
    },
    depositor: {
      ...b.depositor,
      nozzlePosZUp: lv3(a.depositor.nozzlePosZUp, b.depositor.nozzlePosZUp),
      funnelBatterG: lerp(
        a.depositor.funnelBatterG,
        b.depositor.funnelBatterG,
        u,
      ),
      pouringRateGS: lerp(
        a.depositor.pouringRateGS,
        b.depositor.pouringRateGS,
        u,
      ),
      cavityFillFractions: b.depositor.cavityFillFractions.map((val, idx) =>
        lerp(a.depositor.cavityFillFractions[idx] ?? val, val, u),
      ),
    },
    mouldTray: {
      ...b.mouldTray,
      trayPosZUp: lv3(a.mouldTray.trayPosZUp, b.mouldTray.trayPosZUp),
      mouldPosZUp: lv3(a.mouldTray.mouldPosZUp, b.mouldTray.mouldPosZUp),
      depositedG: lerp(a.mouldTray.depositedG, b.mouldTray.depositedG, u),
      currentMassG: lerp(a.mouldTray.currentMassG, b.mouldTray.currentMassG, u),
      evaporatedG: lerp(a.mouldTray.evaporatedG, b.mouldTray.evaporatedG, u),
      bosseRise: lerp(a.mouldTray.bosseRise, b.mouldTray.bosseRise, u),
      crustBrowning: lerp(
        a.mouldTray.crustBrowning,
        b.mouldTray.crustBrowning,
        u,
      ),
      coreTempC: lerp(a.mouldTray.coreTempC, b.mouldTray.coreTempC, u),
    },
    oven: {
      ...b.oven,
      chamberTempC: lerp(a.oven.chamberTempC, b.oven.chamberTempC, u),
      doorAngleRad: lerp(a.oven.doorAngleRad, b.oven.doorAngleRad, u),
      handleAngleRad: lerp(a.oven.handleAngleRad, b.oven.handleAngleRad, u),
      steamLossG: lerp(a.oven.steamLossG, b.oven.steamLossG, u),
    },
    cobot: {
      ...b.cobot,
      toolZUp: lv3(a.cobot.toolZUp, b.cobot.toolZUp),
      wristPitchRad: lerp(a.cobot.wristPitchRad, b.cobot.wristPitchRad, u),
      fingerOpeningM: lerp(a.cobot.fingerOpeningM, b.cobot.fingerOpeningM, u),
    },
  };
}

/**
 * Draws the 256x256 top crust texture for each financier ingot:
 * raw glossy golden batter (#e4ba67) -> golden-amber Maillard crust (#bc6b21)
 * with deeper caramelized rectangular border and characteristic golden crack along the bosse hump.
 */
function drawFinancierCrustCanvas(
  ctx: CanvasRenderingContext2D,
  browning: number,
  bosse: number,
): void {
  const w = 256;
  const h = 256;
  ctx.clearRect(0, 0, w, h);

  const clamped = Math.min(1, Math.max(0, browning));
  const over = Math.max(0, browning - 1);

  // Center color: pale golden batter (230, 188, 106) -> baked golden amber (196, 114, 38) -> scorched (62, 30, 12)
  const cr = Math.round(
    THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(230, 196, clamped),
      62,
      Math.min(1, over * 2.8),
    ),
  );
  const cg = Math.round(
    THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(188, 114, clamped),
      30,
      Math.min(1, over * 2.8),
    ),
  );
  const cb = Math.round(
    THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(106, 38, clamped),
      12,
      Math.min(1, over * 2.8),
    ),
  );

  // Rim color darkens faster due to direct heat conduction from the Matsunaga steel cavity wall
  const rr = Math.round(Math.max(18, cr - 48 * clamped - 70 * over));
  const rg = Math.round(Math.max(10, cg - 38 * clamped - 45 * over));
  const rb = Math.round(Math.max(5, cb - 22 * clamped - 20 * over));

  const grad = ctx.createRadialGradient(w / 2, h / 2, 18, w / 2, h / 2, w * 0.65);
  grad.addColorStop(0, `rgb(${Math.min(255, cr + 18)}, ${Math.min(255, cg + 14)}, ${Math.min(255, cb + 8)})`);
  grad.addColorStop(0.62, `rgb(${cr}, ${cg}, ${cb})`);
  grad.addColorStop(1, `rgb(${rr}, ${rg}, ${rb})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Hazelnut beurre-noisette specks suspended in the financier crumb
  ctx.fillStyle = "rgba(96, 44, 12, 0.36)";
  for (let i = 0; i < 36; i++) {
    const sx = ((i * 73) % 220) + 18;
    const sy = ((i * 137) % 220) + 18;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Central longitudinal bosse fissure highlight once hump rises
  if (bosse > 0.35) {
    const alpha = Math.min(0.65, (bosse - 0.35) * 0.9);
    ctx.strokeStyle = `rgba(246, 206, 124, ${alpha})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(w * 0.22, h * 0.5);
    ctx.quadraticCurveTo(w * 0.5, h * 0.46, w * 0.78, h * 0.5);
    ctx.stroke();
  }
}

export class FinancierBakeScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.02, 20);
  private readonly orbit: OrbitControls;
  private readonly zUpRoot = new THREE.Group();
  private readonly model = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Group();
  private readonly rightFinger = new THREE.Group();
  private pivots: Readonly<{ object: THREE.Object3D; axis: THREE.Vector3 }>[] =
    [];

  // Appliances
  private readonly scaleRoot = new THREE.Group();
  private scalePanNode: THREE.Object3D | null = null;
  private scalePanBaseY = 0.117;

  private readonly ovenRoot = new THREE.Group();
  private ovenVisual: OvenVisual | null = null;
  private readonly chamberPointLight: THREE.PointLight;

  // Custom 3D patisserie tooling: Confectionery piston funnel, Matsunaga 8P mould, 600x400 carrier tray
  private readonly depositorGroup = new THREE.Group();
  private readonly funnelBatterMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly dosingStreamMesh: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  >;

  private readonly carrierTrayGroup = new THREE.Group();
  private readonly mouldGroup = new THREE.Group();
  private readonly cavityBatterMeshes: readonly THREE.Mesh<
    THREE.BoxGeometry,
    THREE.MeshStandardMaterial
  >[];
  private readonly cavityBosseMeshes: readonly THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshStandardMaterial
  >[];
  private readonly crustCanvas = document.createElement("canvas");
  private readonly crustTexture: THREE.CanvasTexture;
  private lastCrustBucket = -1;

  private readonly loadAbort = new AbortController();
  private batchSamples: readonly FinancierBakeSample[] = [];
  private displayedFrame: FinancierBakeSample | null = null;
  private transitionStartedAt = 0;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(view: HTMLElement) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      renderer: { antialias: true, powerPreference: "high-performance" },
      look: { exposure: 0.94, background: 0xded9d0, environmentIntensity: 0.5 },
      pointer: "pan",
      size: { minHeight: 560 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;
    this.orbit = this.host.orbit;

    this.camera.position.set(...CAMERA_PRESETS.station.position);
    this.orbit.target.set(...CAMERA_PRESETS.station.target);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.minDistance = 0.25;
    this.orbit.maxDistance = 4.5;
    this.orbit.update();

    const hemi = new THREE.HemisphereLight(0xfffcf5, 0x6b6257, 1.25);
    const keyLight = new THREE.DirectionalLight(0xfff8ed, 1.9);
    keyLight.position.set(1.2, 2.6, 2.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.3;
    keyLight.shadow.camera.far = 6.5;
    keyLight.shadow.camera.left = -1.7;
    keyLight.shadow.camera.right = 1.7;
    keyLight.shadow.camera.top = 1.6;
    keyLight.shadow.camera.bottom = -1.6;
    keyLight.shadow.bias = -0.0004;
    const rimLight = new THREE.DirectionalLight(0xdce8f5, 0.75);
    rimLight.position.set(-1.5, 1.8, -1.2);

    // Warm interior halogen chamber lamp inside the Maruzen MBCO-5E
    this.chamberPointLight = new THREE.PointLight(0xffb454, 1.8, 0.95);
    this.chamberPointLight.position.set(0.32, 0.46, -0.02);

    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.robot.position.set(...ROBOT_BASE_ZUP);
    this.gripper.add(this.leftFinger, this.rightFinger);
    this.zUpRoot.add(this.robot, this.gripper);
    this.scene.add(
      hemi,
      keyLight,
      rimLight,
      this.chamberPointLight,
      this.zUpRoot,
      this.model,
    );

    this.crustCanvas.width = 256;
    this.crustCanvas.height = 256;
    const cCtx = this.crustCanvas.getContext("2d");
    if (cCtx) drawFinancierCrustCanvas(cCtx, 0, 0);
    this.crustTexture = new THREE.CanvasTexture(this.crustCanvas);
    this.crustTexture.colorSpace = THREE.SRGBColorSpace;

    this.buildPatisserieBench();
    this.buildParallelGripper();
    this.buildCoolingWireGrid();
    this.buildCarrierTray();

    const builtDepositor = this.buildPistonDepositor();
    this.funnelBatterMesh = builtDepositor.funnelBatterMesh;
    this.dosingStreamMesh = builtDepositor.dosingStreamMesh;
    this.model.add(this.depositorGroup, this.dosingStreamMesh);

    const builtMould = this.buildMatsunagaMould();
    this.cavityBatterMeshes = builtMould.cavityBatterMeshes;
    this.cavityBosseMeshes = builtMould.cavityBosseMeshes;
    this.model.add(this.carrierTrayGroup, this.mouldGroup);

    // Appliance root placements (Three.js Y-up)
    this.scaleRoot.position.set(-0.58, 0, 0.18);
    this.ovenRoot.position.set(0.42, 0, -0.04);
    this.model.add(this.scaleRoot, this.ovenRoot);

    this.host.requestFrame();
  }

  private buildPatisserieBench(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6.0, 6.0),
      new THREE.MeshStandardMaterial({
        color: 0xc9c3b8,
        roughness: 0.88,
        metalness: 0.02,
      }),
    );
    floor.position.z = -0.78;
    floor.receiveShadow = true;

    const grid = new THREE.GridHelper(4.6, 23, 0x9e978b, 0xbab3a7);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.779;

    // 1.76 m wide brushed stainless patisserie worktable (`Z = 0` top surface)
    const tableTop = new THREE.Mesh(
      new THREE.BoxGeometry(1.78, 0.92, 0.038),
      new THREE.MeshStandardMaterial({
        color: 0xd4dbe2,
        roughness: 0.26,
        metalness: 0.78,
      }),
    );
    tableTop.position.set(0.06, -0.06, -0.019);
    tableTop.castShadow = true;
    tableTop.receiveShadow = true;

    const underShelf = new THREE.Mesh(
      new THREE.BoxGeometry(1.68, 0.82, 0.024),
      new THREE.MeshStandardMaterial({
        color: 0xbec7cf,
        roughness: 0.34,
        metalness: 0.72,
      }),
    );
    underShelf.position.set(0.06, -0.06, -0.52);
    underShelf.receiveShadow = true;

    const legGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.74, 16);
    legGeo.rotateX(Math.PI / 2);
    const legMat = new THREE.MeshStandardMaterial({
      color: 0xb8c2ca,
      roughness: 0.3,
      metalness: 0.8,
    });
    for (const [lx, ly] of [
      [-0.76, -0.46],
      [0.88, -0.46],
      [-0.76, 0.34],
      [0.88, 0.34],
    ] as const) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lx, ly, -0.41);
      leg.castShadow = true;
      this.zUpRoot.add(leg);
    }

    // Cobot steel pedestal behind the bench
    const robotPedestal = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.28, 0.76),
      new THREE.MeshStandardMaterial({
        color: 0x394149,
        roughness: 0.45,
        metalness: 0.55,
      }),
    );
    robotPedestal.position.set(ROBOT_BASE_ZUP[0], ROBOT_BASE_ZUP[1], -0.4);
    robotPedestal.castShadow = true;
    robotPedestal.receiveShadow = true;

    // Stainless funnel rest stand behind the Ohaus scale (`[-0.58, 0.14, 0]`)
    const funnelStandBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.064, 0.012, 28),
      legMat,
    );
    funnelStandBase.rotation.x = Math.PI / 2;
    funnelStandBase.position.set(-0.58, 0.14, 0.006);

    const funnelStandRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.048, 0.0045, 12, 32),
      legMat,
    );
    funnelStandRing.position.set(-0.58, 0.14, 0.145);

    this.zUpRoot.add(
      floor,
      grid,
      tableTop,
      underShelf,
      robotPedestal,
      funnelStandBase,
      funnelStandRing,
    );
  }

  private buildParallelGripper(): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1e242b,
      roughness: 0.36,
      metalness: 0.55,
    });
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x1a5661,
      roughness: 0.45,
      metalness: 0.15,
    });

    const palm = new THREE.Mesh(
      new THREE.BoxGeometry(0.065, 0.088, 0.044),
      bodyMat,
    );
    palm.position.set(0.025, 0, 0);
    this.gripper.add(palm);

    const fingerGeo = new THREE.BoxGeometry(0.072, 0.012, 0.026);
    const padGeo = new THREE.BoxGeometry(0.048, 0.006, 0.024);

    const lFingerMesh = new THREE.Mesh(fingerGeo, bodyMat);
    lFingerMesh.position.set(0.074, 0, 0);
    const lPadMesh = new THREE.Mesh(padGeo, padMat);
    lPadMesh.position.set(0.082, -0.006, 0);
    this.leftFinger.add(lFingerMesh, lPadMesh);

    const rFingerMesh = new THREE.Mesh(fingerGeo, bodyMat);
    rFingerMesh.position.set(0.074, 0, 0);
    const rPadMesh = new THREE.Mesh(padGeo, padMat);
    rPadMesh.position.set(0.082, 0.006, 0);
    this.rightFinger.add(rFingerMesh, rPadMesh);
  }

  private buildCoolingWireGrid(): void {
    const wireGroup = new THREE.Group();
    wireGroup.position.set(-0.2, 0.0, 0.18);
    const wireMat = new THREE.MeshStandardMaterial({
      color: 0xc8d0d8,
      roughness: 0.24,
      metalness: 0.86,
    });

    // Outer frame (360 x 480 mm raised 28 mm above table for airflow under carrier tray)
    const frameW = 0.36;
    const frameD = 0.46;
    const frameY = 0.026;
    const railGeoX = new THREE.CylinderGeometry(
      0.0035,
      0.0035,
      frameW,
      12,
    ).rotateZ(Math.PI / 2);
    const railGeoZ = new THREE.CylinderGeometry(
      0.0035,
      0.0035,
      frameD,
      12,
    ).rotateX(Math.PI / 2);

    for (const zOff of [-frameD / 2, frameD / 2]) {
      const bar = new THREE.Mesh(railGeoX, wireMat);
      bar.position.set(0, frameY, zOff);
      wireGroup.add(bar);
    }
    for (const xOff of [-frameW / 2, frameW / 2]) {
      const bar = new THREE.Mesh(railGeoZ, wireMat);
      bar.position.set(xOff, frameY, 0);
      wireGroup.add(bar);
    }
    for (let i = -5; i <= 5; i++) {
      const wire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.002, 0.002, frameW - 0.006, 8).rotateZ(
          Math.PI / 2,
        ),
        wireMat,
      );
      wire.position.set(0, frameY, i * 0.038);
      wireGroup.add(wire);
    }
    for (const [fx, fz] of [
      [-frameW / 2 + 0.02, -frameD / 2 + 0.02],
      [frameW / 2 - 0.02, -frameD / 2 + 0.02],
      [-frameW / 2 + 0.02, frameD / 2 - 0.02],
      [frameW / 2 - 0.02, frameD / 2 - 0.02],
    ] as const) {
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0035, 0.0035, frameY, 10),
        wireMat,
      );
      foot.position.set(fx, frameY / 2, fz);
      wireGroup.add(foot);
    }
    this.model.add(wireGroup);
  }

  private buildCarrierTray(): void {
    // 400 x 600 mm Maruzen oven carrier tray (scaled to 380 x 480 mm visual carrier for clean framing)
    const trayMat = new THREE.MeshStandardMaterial({
      color: 0xcfd6de,
      roughness: 0.32,
      metalness: 0.82,
    });
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(0.376, 0.003, 0.46),
      trayMat,
    );
    floor.position.y = 0.0015;
    floor.castShadow = true;
    floor.receiveShadow = true;

    const rimH = 0.016;
    const leftRim = new THREE.Mesh(
      new THREE.BoxGeometry(0.004, rimH, 0.46),
      trayMat,
    );
    leftRim.position.set(-0.186, rimH / 2, 0);
    const rightRim = new THREE.Mesh(
      new THREE.BoxGeometry(0.004, rimH, 0.46),
      trayMat,
    );
    rightRim.position.set(0.186, rimH / 2, 0);
    const frontRim = new THREE.Mesh(
      new THREE.BoxGeometry(0.376, rimH, 0.004),
      trayMat,
    );
    frontRim.position.set(0, rimH / 2, 0.228);
    const backRim = new THREE.Mesh(
      new THREE.BoxGeometry(0.376, rimH, 0.004),
      trayMat,
    );
    backRim.position.set(0, rimH / 2, -0.228);

    this.carrierTrayGroup.add(floor, leftRim, rightRim, frontRim, backRim);
  }

  private buildPistonDepositor(): Readonly<{
    funnelBatterMesh: THREE.Mesh<
      THREE.CylinderGeometry,
      THREE.MeshStandardMaterial
    >;
    dosingStreamMesh: THREE.Mesh<
      THREE.CylinderGeometry,
      THREE.MeshPhysicalMaterial
    >;
  }> {
    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xd8dfe6,
      roughness: 0.2,
      metalness: 0.88,
      side: THREE.DoubleSide,
    });

    // Conical confectionery piston funnel (`y = 0` is nozzle tip)
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.062, 0.01, 0.135, 36, 1, true),
      stainlessMat,
    );
    cone.position.y = 0.075;
    cone.castShadow = true;

    const nozzleTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.006, 0.018, 20),
      stainlessMat,
    );
    nozzleTip.position.y = 0.008;

    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.075, 0.042),
      new THREE.MeshStandardMaterial({
        color: 0x22282f,
        roughness: 0.5,
        metalness: 0.3,
      }),
    );
    handle.position.set(0, 0.085, -0.062);

    const funnelBatterMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.056, 0.014, 0.095, 32),
      new THREE.MeshStandardMaterial({
        color: 0xdfae5c,
        roughness: 0.24,
        metalness: 0.02,
      }),
    );
    funnelBatterMesh.position.y = 0.082;

    const dosingStreamMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0045, 0.0055, 0.112, 16),
      new THREE.MeshPhysicalMaterial({
        color: 0xe3b45e,
        roughness: 0.18,
        clearcoat: 0.85,
      }),
    );
    dosingStreamMesh.visible = false;

    this.depositorGroup.add(cone, nozzleTip, handle, funnelBatterMesh);
    return { funnelBatterMesh, dosingStreamMesh };
  }

  private buildMatsunagaMould(): Readonly<{
    cavityBatterMeshes: readonly THREE.Mesh<
      THREE.BoxGeometry,
      THREE.MeshStandardMaterial
    >[];
    cavityBosseMeshes: readonly THREE.Mesh<
      THREE.SphereGeometry,
      THREE.MeshStandardMaterial
    >[];
  }> {
    // Matsunaga M-size 220 x 300 mm 8-cavity silicone-coated silver financier tray
    const silverCoatedMat = new THREE.MeshStandardMaterial({
      color: 0x9aa3ad,
      roughness: 0.34,
      metalness: 0.76,
    });
    const cavityWellMat = new THREE.MeshStandardMaterial({
      color: 0x677079,
      roughness: 0.42,
      metalness: 0.68,
    });
    const financierMat = new THREE.MeshStandardMaterial({
      map: this.crustTexture,
      roughness: 0.38,
      metalness: 0.02,
    });

    const trayPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.008, 0.3),
      silverCoatedMat,
    );
    trayPlate.position.y = 0.004;
    trayPlate.castShadow = true;
    trayPlate.receiveShadow = true;
    this.mouldGroup.add(trayPlate);

    // 8 rectangular financier cavities (2 cols x 4 rows; each 85 x 43 x 11.5 mm)
    const cavityOffsets: readonly (readonly [number, number])[] = [
      [-0.048, 0.096],
      [0.048, 0.096],
      [-0.048, 0.032],
      [0.048, 0.032],
      [-0.048, -0.032],
      [0.048, -0.032],
      [-0.048, -0.096],
      [0.048, -0.096],
    ];

    const cavityBatterMeshes: THREE.Mesh<
      THREE.BoxGeometry,
      THREE.MeshStandardMaterial
    >[] = [];
    const cavityBosseMeshes: THREE.Mesh<
      THREE.SphereGeometry,
      THREE.MeshStandardMaterial
    >[] = [];

    for (const [cx, cz] of cavityOffsets) {
      // Recessed dark-silver cavity frame
      const wellRim = new THREE.Mesh(
        new THREE.BoxGeometry(0.084, 0.009, 0.044),
        cavityWellMat,
      );
      wellRim.position.set(cx, 0.0055, cz);
      this.mouldGroup.add(wellRim);

      // Financier rectangular ingot inside cavity (80 x 40 mm)
      const batterIngot = new THREE.Mesh(
        new THREE.BoxGeometry(0.078, 0.011, 0.039),
        financierMat,
      );
      batterIngot.position.set(cx, 0.006, cz);
      batterIngot.visible = false;
      batterIngot.castShadow = true;
      this.mouldGroup.add(batterIngot);
      cavityBatterMeshes.push(batterIngot);

      // Characteristic financier central bosse hump dome
      const bosseDome = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 24, 16),
        financierMat,
      );
      bosseDome.scale.set(1.55, 0.01, 0.72);
      bosseDome.position.set(cx, 0.0115, cz);
      bosseDome.visible = false;
      this.mouldGroup.add(bosseDome);
      cavityBosseMeshes.push(bosseDome);
    }

    return { cavityBatterMeshes, cavityBosseMeshes };
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const [scaleGltf, ovenGltf, loadedRobot] = await Promise.all([
      loader.loadAsync(ohausScaleUrl),
      loader.loadAsync(maruzenOvenUrl),
      loadRobotVisual("fairino-fr10", this.loadAbort.signal),
    ]);

    if (this.lifecycle === "disposed") {
      scaleGltf.scene.traverse(disposePhysicsObject);
      ovenGltf.scene.traverse(disposePhysicsObject);
      loadedRobot.traverse(disposePhysicsObject);
      return;
    }

    enableShadows(scaleGltf.scene);
    this.scalePanNode =
      scaleGltf.scene.getObjectByName("ranger_weighing_pan") ?? null;
    if (this.scalePanNode) {
      this.scalePanBaseY = this.scalePanNode.position.y;
    }
    this.scaleRoot.add(scaleGltf.scene);

    enableShadows(ovenGltf.scene);
    this.ovenVisual = bindOvenVisual(ovenGltf.scene);
    this.ovenRoot.add(ovenGltf.scene);

    const pivots = [];
    for (const joint of ROBOTS["fairino-fr10"].joints) {
      const object = loadedRobot.getObjectByName(joint.node);
      if (object === undefined) {
        throw new Error("Robot visual has an incompatible joint hierarchy.");
      }
      pivots.push({ object, axis: new THREE.Vector3(...joint.axis) });
    }
    enableShadows(loadedRobot);
    loadedRobot.rotation.x = Math.PI / 2;
    this.robot.add(loadedRobot);
    this.pivots = pivots;
    this.lifecycle = "ready";

    if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame);
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: FinancierBakeCameraPreset): void {
    const next = CAMERA_PRESETS[preset];
    this.host.moveCamera(
      new THREE.Vector3(...next.position),
      new THREE.Vector3(...next.target),
    );
  }

  setFrame(sample: FinancierBakeSample): void {
    this.batchSamples = [sample];
    this.transitionStartedAt = performance.now();
    this.applySample(sample);
    this.host.requestFrame();
  }

  setSamples(samples: readonly FinancierBakeSample[]): void {
    if (samples.length === 0) return;
    const first = this.displayedFrame ?? samples[0]!;
    this.batchSamples = [first, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: FinancierBakeSample): void {
    this.displayedFrame = sample;

    // 1. Ohaus Ranger 3000 scale pan deflection
    if (this.scalePanNode) {
      this.scalePanNode.position.y =
        this.scalePanBaseY - sample.scale.panDeflectionM;
    }

    // 2. Confectionery piston depositor & dosing stream
    const { depositor, mouldTray, oven } = sample;
    this.depositorGroup.position.set(
      depositor.nozzlePosZUp[0],
      depositor.nozzlePosZUp[2],
      -depositor.nozzlePosZUp[1],
    );
    const funnelFrac = THREE.MathUtils.clamp(
      depositor.funnelBatterG / 726,
      0.12,
      1.0,
    );
    this.funnelBatterMesh.scale.set(funnelFrac, funnelFrac, funnelFrac);

    this.dosingStreamMesh.visible = depositor.pouringRateGS > 1;
    if (this.dosingStreamMesh.visible) {
      this.dosingStreamMesh.position.set(
        depositor.nozzlePosZUp[0],
        depositor.nozzlePosZUp[2] - 0.054,
        -depositor.nozzlePosZUp[1],
      );
    }

    // 3. 600x400 mm Carrier Tray & Matsunaga 8P Mould + 8 Financier Cavities
    this.carrierTrayGroup.position.set(
      mouldTray.trayPosZUp[0],
      mouldTray.trayPosZUp[2],
      -mouldTray.trayPosZUp[1],
    );
    this.mouldGroup.position.set(
      mouldTray.mouldPosZUp[0],
      mouldTray.mouldPosZUp[2],
      -mouldTray.mouldPosZUp[1],
    );

    const crustBucket =
      Math.round(mouldTray.crustBrowning * 50) * 100 +
      Math.round(mouldTray.bosseRise * 30);
    if (crustBucket !== this.lastCrustBucket) {
      this.lastCrustBucket = crustBucket;
      const cCtx = this.crustCanvas.getContext("2d");
      if (cCtx) {
        drawFinancierCrustCanvas(
          cCtx,
          mouldTray.crustBrowning,
          mouldTray.bosseRise,
        );
        this.crustTexture.needsUpdate = true;
      }
    }

    for (let i = 0; i < 8; i++) {
      const fill = depositor.cavityFillFractions[i] ?? 0;
      const ingot = this.cavityBatterMeshes[i];
      const bosse = this.cavityBosseMeshes[i];
      if (ingot) {
        ingot.visible = fill > 0.02;
        if (ingot.visible) {
          const hScale =
            THREE.MathUtils.lerp(0.15, 1.0, fill) + mouldTray.bosseRise * 0.22;
          ingot.scale.set(1, hScale, 1);
          ingot.position.y = 0.004 + 0.0055 * hScale;
        }
      }
      if (bosse) {
        bosse.visible = mouldTray.bosseRise > 0.04 && fill > 0.5;
        if (bosse.visible) {
          bosse.scale.set(
            1.55,
            0.04 + mouldTray.bosseRise * 0.28,
            0.72,
          );
          bosse.position.y = 0.011 + mouldTray.bosseRise * 0.0025;
        }
      }
    }

    // 4. Maruzen MBCO-5E Oven Door, Handle, Readouts & Chamber Lamp
    if (this.ovenVisual) {
      const openingFrac = THREE.MathUtils.clamp(
        oven.doorAngleRad / THREE.MathUtils.degToRad(100),
        0,
        1.1,
      );
      updateOvenVisual(this.ovenVisual, oven.state, openingFrac);
      this.ovenVisual.door.rotation.y = -oven.doorAngleRad;
      this.ovenVisual.handle.rotation.z = oven.handleAngleRad;
    }
    this.chamberPointLight.intensity = oven.lampActive ? 2.1 : 0.15;

    // 5. FAIRINO FR10 6-DOF inverse kinematics & parallel gripper
    const joints = solveFr10Ik(
      sample.cobot.toolZUp,
      sample.cobot.wristPitchRad,
    );
    const fk = forwardKinematicsFr10(joints);
    for (const [index, pivot] of this.pivots.entries()) {
      const angle = fk.joints[index];
      if (angle !== undefined) {
        pivot.object.quaternion.setFromAxisAngle(pivot.axis, angle);
      }
    }
    this.gripper.position.set(fk.gripper[0], fk.gripper[1], fk.gripper[2]);
    this.gripper.quaternion.set(
      fk.gripper[4],
      fk.gripper[5],
      fk.gripper[6],
      fk.gripper[3],
    );
    const open = sample.cobot.fingerOpeningM;
    this.leftFinger.position.set(0, 0.014 + open, 0);
    this.rightFinger.position.set(0, -0.014 - open, 0);
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
    } else if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame);
    }

    return this.batchSamples.length > 1;
  }

  dispose(): void {
    this.lifecycle = "disposed";
    this.loadAbort.abort();
    this.crustTexture.dispose();
    this.host.dispose();
  }
}
