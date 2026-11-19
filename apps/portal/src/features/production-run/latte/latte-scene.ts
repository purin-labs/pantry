import * as THREE from "three";
import {
  LINEA_GLB_SHA256,
  EAGLE_GLB_SHA256,
} from "@purin-labs/bakery-model/bakery-physics";
import { loadVisual } from "../../workflow-simulator/spatial/physics-asset-loader";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import { preloadEspressoVisual } from "../linea/espresso-scene";
import { SceneHost } from "../scene-host";
import modelUrl from "../../../../../../assets/bakery-mujoco/la-marzocco-linea-classic-s-2g/la-marzocco-linea-classic-s-2g.glb?url";
import eagleUrl from "../../../../../../assets/bakery-mujoco/victoria-arduino-eagle-one-2g/victoria-arduino-eagle-one-2g.glb?url";
import type { LatteSample } from "@purin-labs/production-simulation/recipes/latte/model";
import { fr10PlanarIk } from "@purin-labs/production-simulation/kinematics/fr10";
import {
  baristaCounter,
  enableSceneShadows as enableShadows,
  playSampleBatch,
  studioFloor,
  studioLights,
} from "../appliance-sample-three";
import {
  fr10Arm,
  mountFr10Visual,
  openFr10Fingers,
  reachFr10,
  type Fr10Pivot,
} from "../shared/cobot-rig";

export type LatteCameraPreset = "station" | "steam" | "pour" | "overhead";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    LatteCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [0.64, 0.78, 1.24],
    target: [-0.04, 0.25, 0.24],
  },
  steam: {
    position: [0.58, 0.43, 0.56],
    target: [0.3, 0.25, 0.23],
  },
  pour: {
    position: [-0.28, 0.47, 0.58],
    target: [-0.09, 0.24, 0.36],
  },
  overhead: {
    position: [-0.11, 0.92, 0.42],
    target: [-0.12, 0.22, 0.37],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.56, -0.66, -0.03];
const INTERPOLATION_MS = 55;
const ARM = fr10Arm(ROBOT_BASE_ZUP, fr10PlanarIk);

/**
 * Draws the procedural 512x512 espresso crema + multi-leaf Rosetta & Heart latte art canvas.
 */
function drawLatteArtCanvas(
  ctx: CanvasRenderingContext2D,
  artProgress: number,
): void {
  const size = 512;
  const cx = size / 2;
  const cy = size / 2;

  // 1. Rich hazelnut-amber tiger-striped espresso crema base.
  const grad = ctx.createRadialGradient(cx - 18, cy - 18, 16, cx, cy, 250);
  grad.addColorStop(0, "#d4883e");
  grad.addColorStop(0.5, "#b36222");
  grad.addColorStop(0.84, "#863b10");
  grad.addColorStop(1, "#582208");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Tiger-stripe crema mottling.
  for (let i = 0; i < 260; i++) {
    const angle = i * 1.6180339 * Math.PI * 2;
    const radius = 24 + ((i * 67) % 196);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.fillStyle =
      i % 3 === 0
        ? "rgba(62, 22, 6, 0.30)"
        : i % 3 === 1
          ? "rgba(232, 168, 92, 0.24)"
          : "rgba(128, 56, 18, 0.22)";
    ctx.beginPath();
    ctx.ellipse(x, y, 5, 2.2, angle + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  if (artProgress <= 0.01) return;

  // 2. Monk's head / warm crema halo as steamed milk sinks under the crema (0.01 .. 0.30).
  const haloAlpha = Math.min(1, artProgress / 0.28) * 0.32;
  const haloGrad = ctx.createRadialGradient(cx, cy + 16, 12, cx, cy, 185);
  haloGrad.addColorStop(0, `rgba(248, 236, 218, ${haloAlpha})`);
  haloGrad.addColorStop(0.65, `rgba(224, 184, 136, ${haloAlpha * 0.65})`);
  haloGrad.addColorStop(1, "rgba(180, 108, 48, 0)");
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 195, 0, Math.PI * 2);
  ctx.fill();

  if (artProgress <= 0.2) return;

  // 3. Multi-leaf Rosetta microfoam feathers (0.20 .. 0.85) + pull-through heart crown (0.80 .. 1.0).
  const rosettaProgress = Math.min(1, (artProgress - 0.2) / 0.65);
  const leafPairs = 7;
  const activePairs = Math.ceil(rosettaProgress * leafPairs);

  ctx.save();
  // Base bulb of the Rosetta
  const baseRadius = 56 * Math.min(1, rosettaProgress * 1.5);
  const baseGrad = ctx.createRadialGradient(
    cx,
    cy + 58,
    6,
    cx,
    cy + 58,
    baseRadius * 1.35,
  );
  baseGrad.addColorStop(0, "rgba(255, 252, 246, 0.96)");
  baseGrad.addColorStop(0.75, "rgba(246, 234, 214, 0.88)");
  baseGrad.addColorStop(1, "rgba(212, 162, 108, 0)");
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.arc(cx, cy + 58, baseRadius * 1.25, 0, Math.PI * 2);
  ctx.fill();

  // Symmetrical undulating Rosetta leaves climbing from bottom (+Y) to top (-Y)
  for (let i = 0; i < activePairs; i++) {
    const pairFrac = i / (leafPairs - 1);
    const pairAppear = Math.min(
      1,
      Math.max(0, (rosettaProgress - pairFrac * 0.78) / 0.22),
    );
    if (pairAppear <= 0) continue;

    const stemY = cy + 68 - pairFrac * 136;
    const spanX = (86 - pairFrac * 36) * pairAppear;
    const leafWidth = (21 - pairFrac * 5) * pairAppear;

    for (const sign of [-1, 1] as const) {
      ctx.strokeStyle = "rgba(255, 251, 244, 0.95)";
      ctx.lineWidth = leafWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx, stemY + 12);
      ctx.quadraticCurveTo(
        cx + sign * spanX * 0.65,
        stemY - 18,
        cx + sign * spanX,
        stemY + 16,
      );
      ctx.stroke();

      // Thin golden-brown crema contrast separation line between leaves
      ctx.strokeStyle = "rgba(134, 62, 20, 0.52)";
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(cx + sign * 6, stemY + 20);
      ctx.quadraticCurveTo(
        cx + sign * spanX * 0.62,
        stemY - 8,
        cx + sign * (spanX - 4),
        stemY + 24,
      );
      ctx.stroke();
    }
  }

  // Top heart crown & central pull-through stem (0.76 .. 1.0)
  if (artProgress > 0.74) {
    const crownAlpha = Math.min(1, (artProgress - 0.74) / 0.26);
    ctx.fillStyle = `rgba(255, 252, 246, ${0.96 * crownAlpha})`;
    for (const sign of [-1, 1] as const) {
      ctx.beginPath();
      ctx.ellipse(
        cx + sign * 22 * crownAlpha,
        cy - 82,
        26 * crownAlpha,
        32 * crownAlpha,
        sign * -0.35,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    // Center pull-through stem cutting cleanly down the Rosetta spine
    ctx.strokeStyle = `rgba(255, 253, 248, ${0.96 * crownAlpha})`;
    ctx.lineWidth = 6.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 102);
    ctx.lineTo(cx, cy - 102 + 195 * crownAlpha);
    ctx.stroke();
  }
  ctx.restore();
}

function interpolateLatteSample(
  a: LatteSample,
  b: LatteSample,
  t: number,
): LatteSample {
  const l = (x: number, y: number) => x + (y - x) * t;
  const lv = (u: Vec3, v: Vec3): Vec3 => [
    l(u[0], v[0]),
    l(u[1], v[1]),
    l(u[2], v[2]),
  ];
  const base = t < 0.5 ? a : b;
  return {
    ...base,
    timeS: l(a.timeS, b.timeS),
    espresso: {
      ...base.espresso,
      brewPressureBar: l(
        a.espresso.brewPressureBar,
        b.espresso.brewPressureBar,
      ),
      shotElapsedS: l(a.espresso.shotElapsedS, b.espresso.shotElapsedS),
      wandAngleDeg: l(a.espresso.wandAngleDeg, b.espresso.wandAngleDeg),
    },
    cup: {
      ...base.cup,
      posZUp: lv(a.cup.posZUp, b.cup.posZUp),
      espressoMassG: l(a.cup.espressoMassG, b.cup.espressoMassG),
      milkMassG: l(a.cup.milkMassG, b.cup.milkMassG),
      totalMassG: l(a.cup.totalMassG, b.cup.totalMassG),
      temperatureC: l(a.cup.temperatureC, b.cup.temperatureC),
      cremaCoverage: l(a.cup.cremaCoverage, b.cup.cremaCoverage),
      latteArtProgress: l(a.cup.latteArtProgress, b.cup.latteArtProgress),
    },
    pitcher: {
      ...base.pitcher,
      posZUp: lv(a.pitcher.posZUp, b.pitcher.posZUp),
      tiltRad: l(a.pitcher.tiltRad, b.pitcher.tiltRad),
      wobbleRad: l(a.pitcher.wobbleRad, b.pitcher.wobbleRad),
      milkMassG: l(a.pitcher.milkMassG, b.pitcher.milkMassG),
      temperatureC: l(a.pitcher.temperatureC, b.pitcher.temperatureC),
      foamExpansion: l(a.pitcher.foamExpansion, b.pitcher.foamExpansion),
      vortexRadPerS: l(a.pitcher.vortexRadPerS, b.pitcher.vortexRadPerS),
      pouringRateGS: l(a.pitcher.pouringRateGS, b.pitcher.pouringRateGS),
    },
    cobot: {
      ...base.cobot,
      toolZUp: lv(a.cobot.toolZUp, b.cobot.toolZUp),
      wristPitchRad: l(a.cobot.wristPitchRad, b.cobot.wristPitchRad),
      fingerOpeningM: l(a.cobot.fingerOpeningM, b.cobot.fingerOpeningM),
    },
  };
}

/**
 * Interactive 3D Caffe Latte station scene:
 * La Marzocco Linea Classic S / Eagle One + FAIRINO FR10 Cobot + 600 mL stainless
 * milk pitcher + 240 mL porcelain latte bowl + dynamic Rosetta latte art.
 */
export class LatteScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  private readonly model = new THREE.Group();
  private readonly zUpRoot = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Group();
  private readonly rightFinger = new THREE.Group();
  private pivots: readonly Fr10Pivot[] = [];

  // Latte bowl & Rosetta art canvas
  private readonly cupGroup = new THREE.Group();
  private readonly cupLiquidBody: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly cupArtDisc: THREE.Mesh<
    THREE.CircleGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly cupMeniscusRing: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly cupSteamWisps: readonly THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >[];
  private readonly artCanvas = document.createElement("canvas");
  private readonly artTexture: THREE.CanvasTexture;
  private lastArtBucket = -1;

  // 600 mL Stainless-steel milk pitcher & spinning whirlpool microfoam
  private readonly pitcherGroup = new THREE.Group();
  private readonly pitcherMilkBody: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly pitcherMilkTop: THREE.Mesh<
    THREE.CircleGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly pitcherVortexGroup = new THREE.Group();
  private readonly steamPlumeGroup = new THREE.Group();

  // Espresso dual spout streams & steamed milk free-pour stream
  private readonly spoutStreams: readonly THREE.Mesh<
    THREE.TubeGeometry,
    THREE.MeshPhysicalMaterial
  >[];
  private readonly spoutStreamMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x5c2208,
    roughness: 0.06,
    metalness: 0.02,
    clearcoat: 0.95,
    transparent: true,
    opacity: 0.94,
  });
  private readonly milkPourStream: THREE.Mesh<
    THREE.TubeGeometry,
    THREE.MeshPhysicalMaterial
  >;

  private readonly loadAbort = new AbortController();
  private batchSamples: readonly LatteSample[] = [];
  private displayedFrame: LatteSample | null = null;
  private transitionStartedAt = 0;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(
    view: HTMLElement,
    private readonly appliance: "linea" | "eagle-one",
  ) {
    this.host = new SceneHost({
      view,
      camera: this.camera,
      look: {
        exposure: 0.92,
        background: 0xded9d0,
        environmentIntensity: 0.48,
      },
      pointer: "pan",
      size: { minHeight: 560 },
      step: this.step.bind(this),
    });
    this.scene = this.host.scene;

    this.host.startAt(CAMERA_PRESETS.station, {
      minDistance: 0.24,
      maxDistance: 4.2,
      maxPolarAngle: Math.PI * 0.49,
    });

    const [hemi, keyLight, rimLight] = studioLights({
      hemi: 1.25,
      keyIntensity: 1.9,
      keyAt: [1.2, 2.4, 2.1],
      shadow: [0.3, 6.0],
      shadowExtent: [1.3, 1.3],
      rimIntensity: 0.75,
      rimAt: [-1.5, 1.7, -1.2],
    });

    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.robot.position.set(...ROBOT_BASE_ZUP);
    this.gripper.add(this.leftFinger, this.rightFinger);
    this.zUpRoot.add(this.robot, this.gripper);
    this.scene.add(hemi, keyLight, rimLight, this.zUpRoot, this.model);

    // Initialize 512x512 Rosetta latte art canvas texture
    this.artCanvas.width = 512;
    this.artCanvas.height = 512;
    const ctx = this.artCanvas.getContext("2d");
    if (ctx) drawLatteArtCanvas(ctx, 0);
    this.artTexture = new THREE.CanvasTexture(this.artCanvas);
    this.artTexture.colorSpace = THREE.SRGBColorSpace;

    this.buildBaristaStation();
    this.buildParallelGripper();

    const bowl = this.buildPorcelainLatteBowl();
    this.cupLiquidBody = bowl.liquidBody;
    this.cupArtDisc = bowl.artDisc;
    this.cupMeniscusRing = bowl.meniscusRing;
    this.cupSteamWisps = bowl.steamWisps;
    this.model.add(this.cupGroup);

    const pitcher = this.buildStainlessMilkPitcher();
    this.pitcherMilkBody = pitcher.milkBody;
    this.pitcherMilkTop = pitcher.milkTop;
    this.model.add(this.pitcherGroup);

    // Dual portafilter espresso streams
    this.spoutStreams = (
      [
        {
          topX: -0.0115,
          topY: 0.059,
          topZ: -0.006,
          midX: -0.0082,
          midY: 0.038,
          midZ: -0.0035,
          botX: -0.0048,
          botZ: -0.001,
        },
        {
          topX: 0.0155,
          topY: 0.052,
          topZ: -0.003,
          midX: 0.0112,
          midY: 0.034,
          midZ: -0.0018,
          botX: 0.0062,
          botZ: -0.0005,
        },
      ] as const
    ).map((nozzle) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(nozzle.topX, nozzle.topY, nozzle.topZ),
        new THREE.Vector3(nozzle.midX, nozzle.midY, nozzle.midZ),
        new THREE.Vector3(nozzle.botX, 0.015, nozzle.botZ),
        new THREE.Vector3(nozzle.botX * 0.82, 0.0, 0),
      ]);
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 20, 0.0017, 12, false),
        this.spoutStreamMaterial,
      );
      mesh.visible = false;
      this.model.add(mesh);
      return mesh;
    });

    // Glossy white steamed milk free-pour stream from pitcher spout to cup center
    const milkCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.022, 0.068, 0),
      new THREE.Vector3(0.011, 0.046, 0),
      new THREE.Vector3(0.004, 0.022, 0),
      new THREE.Vector3(0.0, 0.0, 0),
    ]);
    this.milkPourStream = new THREE.Mesh(
      new THREE.TubeGeometry(milkCurve, 24, 0.0046, 16, false),
      new THREE.MeshPhysicalMaterial({
        color: 0xfffdf8,
        emissive: 0xfff8eb,
        emissiveIntensity: 0.18,
        roughness: 0.05,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
      }),
    );
    this.milkPourStream.visible = false;
    this.model.add(this.milkPourStream);

    this.host.requestFrame();
  }

  private buildBaristaStation(): void {
    const [floor, grid] = studioFloor(5.2, [3.8, 19]);
    const [counterTop, frontTrim] = baristaCounter(this.zUpRoot);

    const cupDeckTopZ = this.appliance === "linea" ? 0.189 : 0.132;
    const serviceRiser = new THREE.Mesh(
      new THREE.BoxGeometry(0.66, 0.195, cupDeckTopZ),
      new THREE.MeshStandardMaterial({
        color: 0x23272c,
        roughness: 0.38,
        metalness: 0.62,
      }),
    );
    serviceRiser.position.set(0.05, -0.365, cupDeckTopZ / 2);
    serviceRiser.castShadow = true;
    serviceRiser.receiveShadow = true;

    const siliconeMat = new THREE.Mesh(
      new THREE.BoxGeometry(0.63, 0.17, 0.004),
      new THREE.MeshStandardMaterial({
        color: 0x16181b,
        roughness: 0.78,
        metalness: 0.04,
      }),
    );
    siliconeMat.position.set(0.05, -0.365, cupDeckTopZ + 0.002);
    siliconeMat.receiveShadow = true;

    const serviceX = this.appliance === "linea" ? -0.12 : -0.094;
    const serviceY = this.appliance === "linea" ? -0.375 : -0.35;
    const coasterRing = new THREE.Mesh(
      new THREE.RingGeometry(0.042, 0.0465, 44),
      new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        roughness: 0.26,
        metalness: 0.84,
        side: THREE.DoubleSide,
      }),
    );
    coasterRing.position.set(serviceX, serviceY, cupDeckTopZ + 0.0045);

    // Counter-sunk stainless pitcher rinser grate under the 600 mL milk pitcher (`mx = 0.28, my = -0.355`).
    const rinserX = this.appliance === "linea" ? 0.28 : 0.25;
    const rinserY = this.appliance === "linea" ? -0.355 : -0.335;
    const rinserTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.125, 0.125, 0.006),
      new THREE.MeshStandardMaterial({
        color: 0xc8d0d8,
        roughness: 0.24,
        metalness: 0.88,
      }),
    );
    rinserTray.position.set(rinserX, rinserY, cupDeckTopZ + 0.004);
    const rinserStar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.038, 0.038, 0.004, 6).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x1d2126,
        roughness: 0.55,
        metalness: 0.3,
      }),
    );
    rinserStar.position.set(rinserX, rinserY, cupDeckTopZ + 0.008);

    // Stainless knock-box on the left side of the counter
    const knockBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.136, 0.146, 0.088),
      new THREE.MeshStandardMaterial({
        color: 0x363c42,
        roughness: 0.32,
        metalness: 0.72,
      }),
    );
    knockBox.position.set(-0.36, -0.34, 0.044);
    const knockBar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.009, 0.132, 20).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x15171a,
        roughness: 0.75,
        metalness: 0.06,
      }),
    );
    knockBar.position.set(-0.36, -0.34, 0.086);

    // Pedestal for FAIRINO FR10
    const pedestalMat = new THREE.MeshStandardMaterial({
      color: 0x4c545b,
      roughness: 0.44,
      metalness: 0.38,
    });
    const pedestalColumn = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.2, 0.7),
      pedestalMat,
    );
    pedestalColumn.position.set(ROBOT_BASE_ZUP[0], ROBOT_BASE_ZUP[1], -0.43);
    const pedestalPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.34, 0.05),
      pedestalMat,
    );
    pedestalPlate.position.set(
      ROBOT_BASE_ZUP[0],
      ROBOT_BASE_ZUP[1],
      ROBOT_BASE_ZUP[2] - 0.025,
    );

    this.zUpRoot.add(
      floor,
      grid,
      counterTop,
      frontTrim,
      serviceRiser,
      siliconeMat,
      coasterRing,
      rinserTray,
      rinserStar,
      knockBox,
      knockBar,
      pedestalColumn,
      pedestalPlate,
    );
  }

  private buildParallelGripper(): void {
    const titaniumMat = new THREE.MeshStandardMaterial({
      color: 0xbac4ce,
      roughness: 0.22,
      metalness: 0.84,
    });
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x22272e,
      roughness: 0.32,
      metalness: 0.65,
    });
    const tealMat = new THREE.MeshStandardMaterial({
      color: 0x0e5e6f,
      roughness: 0.3,
      metalness: 0.7,
    });
    const siliconePadMat = new THREE.MeshStandardMaterial({
      color: 0x15181c,
      roughness: 0.86,
      metalness: 0.04,
    });

    const changerCoupling = new THREE.Mesh(
      new THREE.CylinderGeometry(0.036, 0.038, 0.022, 32).rotateZ(Math.PI / 2),
      titaniumMat,
    );
    changerCoupling.position.set(-0.048, 0, 0);

    const statusLedRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.037, 0.0022, 12, 36).rotateY(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x38d962 }),
    );
    statusLedRing.position.set(-0.044, 0, 0);

    const palmBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.034, 0.098, 0.044),
      gunmetalMat,
    );
    palmBody.position.set(-0.02, 0, 0);

    const guideRail = new THREE.Mesh(
      new THREE.BoxGeometry(0.01, 0.092, 0.016),
      titaniumMat,
    );
    guideRail.position.set(-0.001, 0, 0);

    this.gripper.add(changerCoupling, statusLedRing, palmBody, guideRail);

    const buildFinger = (sign: 1 | -1, target: THREE.Group): void => {
      const carriage = new THREE.Mesh(
        new THREE.BoxGeometry(0.018, 0.018, 0.028),
        tealMat,
      );
      carriage.position.set(0.008, 0, 0);

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.068, 0.007, 0.022),
        titaniumMat,
      );
      arm.position.set(0.046, sign * 0.002, 0);

      const cradlePad = new THREE.Mesh(
        new THREE.BoxGeometry(0.036, 0.009, 0.034),
        siliconePadMat,
      );
      cradlePad.position.set(0.068, -sign * 0.0025, 0);
      target.add(carriage, arm, cradlePad);
    };

    buildFinger(1, this.leftFinger);
    buildFinger(-1, this.rightFinger);
    enableShadows(this.gripper);
  }

  /**
   * Wide-mouth 240 mL Italian porcelain Caffe Latte bowl (`outerRadius = 0.043 m`)
   * so the Rosetta latte art is broad and clearly visible from Station, Pour, and Overhead views.
   */
  private buildPorcelainLatteBowl(): Readonly<{
    liquidBody: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial>;
    artDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
    meniscusRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
    steamWisps: readonly THREE.Mesh<
      THREE.RingGeometry,
      THREE.MeshBasicMaterial
    >[];
  }> {
    const outerRadius = 0.042;
    const innerRadius = 0.038;
    const porcelainMat = new THREE.MeshPhysicalMaterial({
      color: 0xf7f4ec,
      roughness: 0.14,
      metalness: 0.0,
      clearcoat: 0.9,
      clearcoatRoughness: 0.08,
    });

    const profile = [
      new THREE.Vector2(0.0001, -0.035),
      new THREE.Vector2(outerRadius * 0.64, -0.035),
      new THREE.Vector2(outerRadius * 0.72, -0.026),
      new THREE.Vector2(outerRadius * 0.92, -0.004),
      new THREE.Vector2(outerRadius, 0.029),
      new THREE.Vector2(outerRadius + 0.0008, 0.0315),
      new THREE.Vector2(innerRadius + 0.0006, 0.032),
      new THREE.Vector2(innerRadius, 0.029),
      new THREE.Vector2(innerRadius * 0.84, -0.02),
      new THREE.Vector2(0.0001, -0.028),
    ];
    const bowlMesh = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 48),
      porcelainMat,
    );
    bowlMesh.castShadow = true;
    bowlMesh.receiveShadow = true;

    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.018, outerRadius - 0.001),
      new THREE.Vector3(0, 0.02, outerRadius + 0.015),
      new THREE.Vector3(0, 0.0, outerRadius + 0.017),
      new THREE.Vector3(0, -0.016, outerRadius + 0.011),
      new THREE.Vector3(0, -0.018, outerRadius * 0.8),
    ]);
    const handleMesh = new THREE.Mesh(
      new THREE.TubeGeometry(handleCurve, 20, 0.0038, 12, false),
      porcelainMat,
    );

    const liquidBody = new THREE.Mesh(
      new THREE.CylinderGeometry(innerRadius * 0.95, innerRadius * 0.8, 1, 44),
      new THREE.MeshPhysicalMaterial({
        color: 0x3b1707,
        roughness: 0.12,
        metalness: 0.01,
        clearcoat: 0.9,
      }),
    );
    liquidBody.visible = false;

    const artDisc = new THREE.Mesh(
      new THREE.CircleGeometry(innerRadius * 0.96, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        map: this.artTexture,
        roughness: 0.32,
        metalness: 0.02,
      }),
    );
    artDisc.visible = false;

    const meniscusRing = new THREE.Mesh(
      new THREE.RingGeometry(
        innerRadius * 0.88,
        innerRadius * 0.97,
        48,
      ).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xc87a2e,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
      }),
    );
    meniscusRing.visible = false;

    const steamWisps = [0, 1, 2].map(() => {
      const wisp = new THREE.Mesh(
        new THREE.RingGeometry(
          innerRadius * 0.24,
          innerRadius * 0.56,
          28,
        ).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: 0xfffaf2,
          transparent: true,
          opacity: 0.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      wisp.visible = false;
      this.cupGroup.add(wisp);
      return wisp;
    });

    this.cupGroup.add(bowlMesh, handleMesh, liquidBody, artDisc, meniscusRing);
    return { liquidBody, artDisc, meniscusRing, steamWisps };
  }

  /**
   * Sculpted 600 mL brushed stainless-steel barista milk pitcher with V-spout on `-X`,
   * strap handle on `+X`, expanding creamy milk interior, spinning whirlpool rings, and steam plume.
   */
  private buildStainlessMilkPitcher(): Readonly<{
    milkBody: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial>;
    milkTop: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  }> {
    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xd8dfe6,
      roughness: 0.2,
      metalness: 0.88,
      side: THREE.DoubleSide,
    });

    const profile = [
      new THREE.Vector2(0.0001, -0.052),
      new THREE.Vector2(0.041, -0.052),
      new THREE.Vector2(0.043, -0.036),
      new THREE.Vector2(0.039, 0.012),
      new THREE.Vector2(0.037, 0.048),
      new THREE.Vector2(0.0395, 0.054),
      new THREE.Vector2(0.036, 0.054),
      new THREE.Vector2(0.035, 0.01),
      new THREE.Vector2(0.038, -0.046),
      new THREE.Vector2(0.0001, -0.048),
    ];
    const bodyMesh = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 48),
      stainlessMat,
    );
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;

    // Protruding V-spout on `-X` lip (`[-0.044, 0.053, 0]`) for precision latte art pouring
    const spoutLip = new THREE.Mesh(
      new THREE.ConeGeometry(0.011, 0.018, 16, 1, true).rotateZ(Math.PI * 0.72),
      stainlessMat,
    );
    spoutLip.position.set(-0.038, 0.05, 0);

    // Welded stainless strap handle on `+X`
    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.037, 0.042, 0),
      new THREE.Vector3(0.06, 0.04, 0),
      new THREE.Vector3(0.062, 0.004, 0),
      new THREE.Vector3(0.054, -0.028, 0),
      new THREE.Vector3(0.041, -0.032, 0),
    ]);
    const handleMesh = new THREE.Mesh(
      new THREE.TubeGeometry(handleCurve, 24, 0.0042, 12, false),
      stainlessMat,
    );
    handleMesh.castShadow = true;

    // Creamy whole milk & microfoam interior
    const milkBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0345, 0.037, 1, 40),
      new THREE.MeshPhysicalMaterial({
        color: 0xfffdf8,
        roughness: 0.1,
        metalness: 0.0,
        clearcoat: 0.95,
      }),
    );
    const milkTop = new THREE.Mesh(
      new THREE.CircleGeometry(0.0348, 40).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xfffcf4,
        roughness: 0.16,
        metalness: 0.0,
      }),
    );

    // Whirlpool vortex rings on the milk surface
    for (const r of [0.01, 0.019, 0.027]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r, r + 0.0022, 28, 1, 0, Math.PI * 1.45).rotateX(
          -Math.PI / 2,
        ),
        new THREE.MeshBasicMaterial({
          color: 0xeae2d3,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
        }),
      );
      this.pitcherVortexGroup.add(ring);
    }

    // Pressurized steam plume jet inside the pitcher when steaming
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.008 + i * 0.005, 0.048, 20),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.24 - i * 0.05,
          depthWrite: false,
        }),
      );
      cone.position.set(0.015, 0.046 + i * 0.008, -0.006);
      this.steamPlumeGroup.add(cone);
    }
    this.steamPlumeGroup.visible = false;

    this.pitcherGroup.add(
      bodyMesh,
      spoutLip,
      handleMesh,
      milkBody,
      milkTop,
      this.pitcherVortexGroup,
      this.steamPlumeGroup,
    );
    return { milkBody, milkTop };
  }

  async load(): Promise<void> {
    preloadEspressoVisual(this.appliance);
    const reference =
      this.appliance === "linea"
        ? { url: modelUrl, sha256: LINEA_GLB_SHA256 }
        : { url: eagleUrl, sha256: EAGLE_GLB_SHA256 };

    const [loadedMachine, loadedRobot] = await Promise.all([
      loadVisual(reference.url, reference.sha256, this.loadAbort.signal),
      loadRobotVisual("fairino-fr10", this.loadAbort.signal),
    ]);
    if (this.lifecycle === "disposed") {
      loadedMachine.traverse(disposePhysicsObject);
      loadedRobot.traverse(disposePhysicsObject);
      return;
    }

    loadedMachine.traverse((node) => {
      if (
        node.name.endsWith("_cup") ||
        node.name.startsWith("Inactive_shot_timer") ||
        node.name.endsWith("group_timer")
      ) {
        node.visible = false;
      }
    });
    enableShadows(loadedMachine);
    this.model.add(loadedMachine);

    this.pivots = mountFr10Visual(this.robot, loadedRobot);
    this.lifecycle = "ready";

    if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame, performance.now());
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: LatteCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset]);
  }

  setFrame(sample: LatteSample): void {
    this.batchSamples = [sample];
    this.transitionStartedAt = performance.now();
    this.applySample(sample, this.transitionStartedAt);
    this.host.requestFrame();
  }

  setSamples(samples: readonly LatteSample[]): void {
    if (samples.length === 0) return;
    const first = this.displayedFrame ?? samples[0]!;
    this.batchSamples = [first, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: LatteSample, now: number): void {
    this.displayedFrame = sample;
    const prefix = this.appliance === "linea" ? "lcs" : "eo";

    // 1. Actuate steam wand & steam knob on the Espresso machine `.glb`
    const rightWand = this.model.getObjectByName(`${prefix}_right_steam_wand`);
    if (rightWand) {
      rightWand.rotation.x = THREE.MathUtils.degToRad(
        sample.espresso.wandAngleDeg,
      );
    }
    const rightKnob = this.model.getObjectByName(`${prefix}_right_steam_knob`);
    if (rightKnob) {
      rightKnob.rotation.z = sample.espresso.steamValveOpen
        ? Math.PI * 0.65
        : 0;
    }

    // 2. Position & update the 240 mL porcelain Caffe Latte bowl
    const { cup } = sample;
    this.cupGroup.position.set(cup.posZUp[0], cup.posZUp[2], -cup.posZUp[1]);
    const hasCupLiquid =
      cup.totalMassG > 0.25 || sample.phase === "espresso-shot";
    this.cupLiquidBody.visible = hasCupLiquid;
    this.cupArtDisc.visible = hasCupLiquid;
    this.cupMeniscusRing.visible = hasCupLiquid;

    if (hasCupLiquid) {
      const fillFrac = Math.pow(
        THREE.MathUtils.clamp(cup.totalMassG / 216, 0.08, 1.02),
        0.72,
      );
      const bottomY = -0.026;
      const topY = THREE.MathUtils.lerp(-0.008, 0.0265, fillFrac);
      const height = Math.max(0.004, topY - bottomY);
      this.cupLiquidBody.scale.set(1, height, 1);
      this.cupLiquidBody.position.y = bottomY + height / 2;
      this.cupArtDisc.position.y = topY + 0.0004;
      this.cupMeniscusRing.position.y = topY + 0.0006;

      // Refresh Rosetta latte art canvas texture when artProgress advances
      const bucket = Math.round(cup.latteArtProgress * 60);
      if (bucket !== this.lastArtBucket) {
        this.lastArtBucket = bucket;
        const ctx = this.artCanvas.getContext("2d");
        if (ctx) {
          drawLatteArtCanvas(ctx, cup.latteArtProgress);
          this.artTexture.needsUpdate = true;
        }
      }
    }

    const cupSteaming = cup.totalMassG > 5 && cup.temperatureC > 48;
    for (const [idx, wisp] of this.cupSteamWisps.entries()) {
      wisp.visible = cupSteaming;
      if (cupSteaming) {
        const cycle =
          (((now * 0.00042 + idx / this.cupSteamWisps.length) % 1) + 1) % 1;
        wisp.position.set(
          Math.sin(now * 0.002 + idx * 2.1) * 0.005,
          0.028 + cycle * 0.055,
          Math.cos(now * 0.0017 + idx * 1.6) * 0.005,
        );
        const s = 0.65 + cycle * 0.85;
        wisp.scale.set(s, s, 1);
        wisp.material.opacity = Math.sin(cycle * Math.PI) * 0.16;
      }
    }

    // 3. Dual portafilter espresso streams during `espresso-shot`
    const dispensingEspresso =
      sample.phase === "espresso-shot" && sample.espresso.brewPressureBar > 2;
    const spoutBaseY = this.appliance === "linea" ? 0.285 : 0.246;
    const cupSurfaceWorldY =
      this.cupGroup.position.y + this.cupArtDisc.position.y;
    const streamDrop = Math.max(0.014, spoutBaseY - cupSurfaceWorldY);
    for (const streamMesh of this.spoutStreams) {
      streamMesh.visible = dispensingEspresso;
      if (dispensingEspresso) {
        streamMesh.position.set(
          this.cupGroup.position.x,
          cupSurfaceWorldY,
          this.cupGroup.position.z,
        );
        streamMesh.scale.set(1, streamDrop / 0.056, 1);
      }
    }

    // 4. Position & update the 600 mL stainless milk pitcher + whirlpool microfoam
    const { pitcher } = sample;
    this.pitcherGroup.position.set(
      pitcher.posZUp[0],
      pitcher.posZUp[2],
      -pitcher.posZUp[1],
    );
    this.pitcherGroup.rotation.set(pitcher.wobbleRad, 0, pitcher.tiltRad);

    const hasMilkInPitcher = pitcher.milkMassG > 2;
    this.pitcherMilkBody.visible = hasMilkInPitcher;
    this.pitcherMilkTop.visible = hasMilkInPitcher;
    this.pitcherVortexGroup.visible =
      hasMilkInPitcher && pitcher.vortexRadPerS > 0.5;
    if (hasMilkInPitcher) {
      const milkVolFrac = THREE.MathUtils.clamp(
        (pitcher.milkMassG / 190) * pitcher.foamExpansion,
        0.08,
        1.15,
      );
      const pBotY = -0.046;
      const pTopY = THREE.MathUtils.lerp(-0.032, 0.034, milkVolFrac);
      const pHeight = Math.max(0.004, pTopY - pBotY);
      this.pitcherMilkBody.scale.set(1, pHeight, 1);
      this.pitcherMilkBody.position.y = pBotY + pHeight / 2;
      this.pitcherMilkTop.position.y = pTopY + 0.0005;
      this.pitcherVortexGroup.position.y = pTopY + 0.0012;
      this.pitcherVortexGroup.rotation.y =
        (now * 0.001 * pitcher.vortexRadPerS) % (Math.PI * 2);
    }

    // Steam plume inside pitcher when steam valve is open
    this.steamPlumeGroup.visible = sample.espresso.steamValveOpen;
    if (sample.espresso.steamValveOpen) {
      const pulse = 0.92 + Math.sin(now * 0.025) * 0.12;
      this.steamPlumeGroup.scale.set(pulse, 1, pulse);
    }

    // 5. Glossy white steamed milk free-pour stream during `pour-latte`
    const pouringMilk = pitcher.pouringRateGS > 0.5;
    this.milkPourStream.visible = pouringMilk;
    if (pouringMilk) {
      const pourHeight = Math.max(
        0.025,
        this.pitcherGroup.position.y - cupSurfaceWorldY,
      );
      this.milkPourStream.position.set(
        this.cupGroup.position.x + Math.sin(now * 0.015) * 0.004,
        cupSurfaceWorldY,
        this.cupGroup.position.z + Math.cos(now * 0.015) * 0.004,
      );
      this.milkPourStream.scale.set(1, pourHeight / 0.068, 1);
    }

    // 6. Solve FAIRINO FR10 6-DOF inverse kinematics & parallel gripper
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
        interpolateLatteSample,
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
    this.artTexture.dispose();
    this.host.dispose();
  }
}
