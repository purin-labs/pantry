import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import { SceneHost } from "../scene-host";
import { loadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import kpl9000sUrl from "../../../../../../assets/bakery-mujoco/aicohsha-kpl9000s/aicohsha-kpl9000s.glb?url";
import kpl9000sBeaterUrl from "../../../../../../assets/bakery-mujoco/hobart-hl200/hobart-hl200-beater.glb?url";
import ohausScaleUrl from "../../../../../../assets/bakery-mujoco/ohaus-ranger-3000/ohaus-r31pe6.glb?url";
import type {
  FinancierBatterSample,
  FinancierHobModel,
  FinancierMixerTool,
} from "@seams/production-simulation/recipes/financier-batter/model";
import {
  addPatisserieBench,
  enableSceneShadows as enableShadows,
  inductionHobUrl,
  lerpVec3,
  playSampleBatch,
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

export type FinancierBatterCameraPreset =
  "station" | "hob" | "mixer" | "overhead";

type Vec3 = readonly [number, number, number];

const CAMERA_PRESETS: Readonly<
  Record<
    FinancierBatterCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [0.04, 0.94, 1.42],
    target: [0.02, 0.26, 0.18],
  },
  hob: {
    position: [-0.16, 0.62, 0.72],
    target: [-0.02, 0.15, 0.18],
  },
  mixer: {
    position: [0.14, 0.78, 0.78],
    target: [0.38, 0.32, 0.22],
  },
  overhead: {
    position: [0.02, 1.42, 0.36],
    target: [0.02, 0.2, 0.18],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.22, 0.48, 0.0];
const INTERPOLATION_MS = 55;
const ARM = fr10Arm(ROBOT_BASE_ZUP);

/** The silicone staging mat of the tempered egg-white pitcher (`[-0.42, -0.41, 0.002]`). */
function stagingMat(): THREE.Mesh {
  const mat = new THREE.Mesh(
    new THREE.CylinderGeometry(0.068, 0.068, 0.004, 36),
    new THREE.MeshStandardMaterial({
      color: 0x2c353d,
      roughness: 0.75,
    }),
  );
  mat.rotation.x = Math.PI / 2;
  mat.position.set(-0.42, -0.41, 0.002);
  return mat;
}

function interpolateSample(
  a: FinancierBatterSample,
  b: FinancierBatterSample,
  u: number,
): FinancierBatterSample {
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
    induction: {
      ...b.induction,
      panPosZUp: lv3(a.induction.panPosZUp, b.induction.panPosZUp),
      panTiltRad: lerp(a.induction.panTiltRad, b.induction.panTiltRad, u),
      butterMassG: lerp(a.induction.butterMassG, b.induction.butterMassG, u),
      butterTempC: lerp(a.induction.butterTempC, b.induction.butterTempC, u),
      evaporatedG: lerp(a.induction.evaporatedG, b.induction.evaporatedG, u),
      browningProgress: lerp(
        a.induction.browningProgress,
        b.induction.browningProgress,
        u,
      ),
      foamIntensity: lerp(
        a.induction.foamIntensity,
        b.induction.foamIntensity,
        u,
      ),
    },
    mixer: {
      ...b.mixer,
      orbitAngleRad: lerp(a.mixer.orbitAngleRad, b.mixer.orbitAngleRad, u),
      spinAngleRad: lerp(a.mixer.spinAngleRad, b.mixer.spinAngleRad, u),
      bowlLiftM: lerp(a.mixer.bowlLiftM, b.mixer.bowlLiftM, u),
      guardAngleRad: lerp(a.mixer.guardAngleRad, b.mixer.guardAngleRad, u),
      bowlMassG: lerp(a.mixer.bowlMassG, b.mixer.bowlMassG, u),
      dryChargedG: lerp(a.mixer.dryChargedG, b.mixer.dryChargedG, u),
      whitesChargedG: lerp(a.mixer.whitesChargedG, b.mixer.whitesChargedG, u),
      butterChargedG: lerp(a.mixer.butterChargedG, b.mixer.butterChargedG, u),
      batterTempC: lerp(a.mixer.batterTempC, b.mixer.batterTempC, u),
      emulsification: lerp(a.mixer.emulsification, b.mixer.emulsification, u),
    },
    dryVessel: {
      ...b.dryVessel,
      posZUp: lv3(a.dryVessel.posZUp, b.dryVessel.posZUp),
      tiltRad: lerp(a.dryVessel.tiltRad, b.dryVessel.tiltRad, u),
      massG: lerp(a.dryVessel.massG, b.dryVessel.massG, u),
    },
    whitesVessel: {
      ...b.whitesVessel,
      posZUp: lv3(a.whitesVessel.posZUp, b.whitesVessel.posZUp),
      tiltRad: lerp(a.whitesVessel.tiltRad, b.whitesVessel.tiltRad, u),
      massG: lerp(a.whitesVessel.massG, b.whitesVessel.massG, u),
    },
    cobot: lerpCobot(a.cobot, b.cobot, u),
  };
}

/**
 * Draws the 512x512 beurre noisette texture inside the 200 mm stainless pan:
 * golden melted butter -> foaming white water-boil ring -> deep hazelnut-amber
 * Maillard beurre noisette with toasted milk-solid specks.
 */
function drawBeurreNoisetteCanvas(
  ctx: CanvasRenderingContext2D,
  browning: number,
  foam: number,
  burnt: boolean,
): void {
  const size = 512;
  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  // Interpolate liquid butter color: golden yellow (#f4c84b) -> amber hazelnut (#9e561b) -> burnt (#2e190b)
  const r = burnt
    ? Math.round(THREE.MathUtils.lerp(244, 46, browning))
    : Math.round(THREE.MathUtils.lerp(244, 158, browning));
  const g = burnt
    ? Math.round(THREE.MathUtils.lerp(200, 25, browning))
    : Math.round(THREE.MathUtils.lerp(200, 86, browning));
  const b = burnt
    ? Math.round(THREE.MathUtils.lerp(75, 11, browning))
    : Math.round(THREE.MathUtils.lerp(75, 27, browning));

  const grad = ctx.createRadialGradient(cx, cy, 18, cx, cy, cx);
  grad.addColorStop(
    0,
    `rgb(${Math.min(255, r + 24)}, ${Math.min(255, g + 20)}, ${Math.min(255, b + 16)})`,
  );
  grad.addColorStop(0.75, `rgb(${r}, ${g}, ${b})`);
  grad.addColorStop(
    1,
    `rgb(${Math.max(0, r - 28)}, ${Math.max(0, g - 22)}, ${Math.max(0, b - 12)})`,
  );
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, cx - 2, 0, Math.PI * 2);
  ctx.fill();

  // Toasted milk-solid specks at the bottom of the pan as Maillard browning progresses
  if (browning > 0.25) {
    const speckAlpha = Math.min(0.85, (browning - 0.25) * 1.1);
    ctx.fillStyle = burnt
      ? `rgba(18, 10, 6, ${speckAlpha})`
      : `rgba(82, 36, 10, ${speckAlpha})`;
    for (let i = 0; i < 65; i++) {
      const angle = i * 2.39996;
      const dist = Math.sqrt(i / 65) * (cx * 0.78);
      const sx = cx + Math.cos(angle) * dist;
      const sy = cy + Math.sin(angle) * dist;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2 + (i % 3) * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Creamy foaming ring during moisture evaporation
  if (foam > 0.05) {
    ctx.strokeStyle = `rgba(255, 249, 232, ${Math.min(0.82, foam * 0.85)})`;
    ctx.lineWidth = 14 * foam;
    for (const radFrac of [0.35, 0.58, 0.78]) {
      ctx.beginPath();
      ctx.arc(cx, cy, cx * radFrac, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Draws the 512x512 financier batter texture inside the Hobart HL200 20 qt bowl:
 * pale ivory sifted almond-sugar meal -> egg-white hydration -> glossy golden-amber
 * financier batter with planetary spiral ribbons.
 */
function drawFinancierBatterCanvas(
  ctx: CanvasRenderingContext2D,
  emulsification: number,
  hasButter: boolean,
  orbitAngle: number,
): void {
  const size = 512;
  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  // Base color shifts from pale almond meal (#f3ead5) to rich golden noisette batter (#dfae5c)
  const goldMix = hasButter
    ? Math.min(1, emulsification)
    : emulsification * 0.35;
  const r = Math.round(THREE.MathUtils.lerp(243, 223, goldMix));
  const g = Math.round(THREE.MathUtils.lerp(234, 174, goldMix));
  const b = Math.round(THREE.MathUtils.lerp(213, 92, goldMix));

  const grad = ctx.createRadialGradient(cx, cy, 16, cx, cy, cx);
  grad.addColorStop(
    0,
    `rgb(${Math.min(255, r + 14)}, ${Math.min(255, g + 12)}, ${Math.min(255, b + 10)})`,
  );
  grad.addColorStop(0.8, `rgb(${r}, ${g}, ${b})`);
  grad.addColorStop(
    1,
    `rgb(${Math.max(0, r - 20)}, ${Math.max(0, g - 18)}, ${Math.max(0, b - 15)})`,
  );
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, cx - 2, 0, Math.PI * 2);
  ctx.fill();

  // Epicyclic planetary ribbon waves on the batter surface
  if (emulsification > 0.04) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(orbitAngle);
    ctx.strokeStyle = hasButter
      ? "rgba(176, 112, 34, 0.38)"
      : "rgba(210, 194, 162, 0.48)";
    ctx.lineWidth = 6;
    for (let ring = 1; ring <= 4; ring++) {
      ctx.beginPath();
      ctx.arc(14, 0, ring * 44, 0, Math.PI * 1.65);
      ctx.stroke();
    }
    // Fine hazelnut specks folded throughout the financier batter
    if (hasButter) {
      ctx.fillStyle = "rgba(120, 62, 18, 0.45)";
      for (let i = 0; i < 48; i++) {
        const a = i * 2.39996;
        const d = Math.sqrt(i / 48) * (cx * 0.82);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * d, Math.sin(a) * d, 2.0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

export class FinancierBatterScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.02, 20);
  private readonly zUpRoot = new THREE.Group();
  private readonly model = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Group();
  private readonly rightFinger = new THREE.Group();
  private pivots: readonly Fr10Pivot[] = [];

  // Appliance root groups & articulated nodes
  private readonly scaleRoot = new THREE.Group();
  private readonly scalePan = new ScalePan();

  private readonly hobRoot = new THREE.Group();
  private readonly coilGlowMesh: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >;

  private readonly mixerRoot = new THREE.Group();
  private hlBowlLiftNode: THREE.Object3D | null = null;
  private hlBowlBaseY = 0.012;
  private hlGuardNode: THREE.Object3D | null = null;
  private hlPlanetaryNode: THREE.Object3D | null = null;
  private hlToolAxisNode: THREE.Object3D | null = null;
  private hlLiftLeverNode: THREE.Object3D | null = null;
  private hlBeaterNode: THREE.Object3D | null = null;
  private hlWhipNode: THREE.Object3D | null = null;

  // Dynamic vessels & contents
  private readonly panGroup = new THREE.Group();
  private readonly butterBody: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly butterTop: THREE.Mesh<
    THREE.CircleGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly butterSteamWisps: readonly THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >[];
  private readonly butterCanvas = document.createElement("canvas");
  private readonly butterTexture: THREE.CanvasTexture;
  private lastButterBucket = -1;

  private readonly bowlBatterGroup = new THREE.Group();
  private readonly bowlBatterBody: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly bowlBatterTop: THREE.Mesh<
    THREE.CircleGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly batterCanvas = document.createElement("canvas");
  private readonly batterTexture: THREE.CanvasTexture;
  private lastBatterBucket = -1;

  private readonly dryVesselGroup = new THREE.Group();
  private readonly dryVesselContent: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;

  private readonly whitesVesselGroup = new THREE.Group();
  private readonly whitesVesselContent: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  >;

  private readonly dryPourStream: THREE.Mesh<
    THREE.TubeGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly whitesPourStream: THREE.Mesh<
    THREE.TubeGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly butterPourStream: THREE.Mesh<
    THREE.TubeGeometry,
    THREE.MeshPhysicalMaterial
  >;

  private readonly loadAbort = new AbortController();
  private batchSamples: readonly FinancierBatterSample[] = [];
  private displayedFrame: FinancierBatterSample | null = null;
  private transitionStartedAt = 0;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(
    view: HTMLElement,
    private readonly hobModel: FinancierHobModel,
    private readonly mixerTool: FinancierMixerTool,
  ) {
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

    this.host.startAt(CAMERA_PRESETS.station, {
      minDistance: 0.25,
      maxDistance: 4.5,
      maxPolarAngle: Math.PI * 0.49,
    });

    const [hemi, keyLight, rimLight] = studioLights({
      hemi: 1.25,
      keyIntensity: 1.9,
      keyAt: [1.3, 2.5, 2.1],
      shadow: [0.3, 6.5],
      shadowExtent: [1.5, 1.5],
      rimIntensity: 0.75,
      rimAt: [-1.5, 1.8, -1.2],
    });

    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.robot.position.set(...ROBOT_BASE_ZUP);
    this.gripper.add(this.leftFinger, this.rightFinger);
    this.zUpRoot.add(this.robot, this.gripper);
    this.scene.add(hemi, keyLight, rimLight, this.zUpRoot, this.model);

    // Initialize dynamic canvas textures
    this.butterCanvas.width = 512;
    this.butterCanvas.height = 512;
    const bCtx = this.butterCanvas.getContext("2d");
    if (bCtx) drawBeurreNoisetteCanvas(bCtx, 0, 0, false);
    this.butterTexture = new THREE.CanvasTexture(this.butterCanvas);
    this.butterTexture.colorSpace = THREE.SRGBColorSpace;

    this.batterCanvas.width = 512;
    this.batterCanvas.height = 512;
    const mCtx = this.batterCanvas.getContext("2d");
    if (mCtx) drawFinancierBatterCanvas(mCtx, 0, false, 0);
    this.batterTexture = new THREE.CanvasTexture(this.batterCanvas);
    this.batterTexture.colorSpace = THREE.SRGBColorSpace;

    // 1.32 m wide brushed stainless patisserie worktable (`Z = 0` top surface)
    addPatisserieBench(this.zUpRoot, {
      floor: 5.6,
      grid: [4.2, 21],
      centre: [0.0, -0.08],
      top: [1.34, 0.88],
      shelf: [1.26, 0.78],
      legRadius: 0.022,
      legs: [
        [-0.61, -0.46],
        [0.61, -0.46],
        [-0.61, 0.3],
        [0.61, 0.3],
      ],
      robotBase: ROBOT_BASE_ZUP,
      extras: () => [stagingMat()],
    });
    buildPaddedGripper(this.gripper, this.leftFinger, this.rightFinger, {
      barX: 0.074,
      padY: 0.006,
    });

    // Glowing induction ring on the hob surface
    this.coilGlowMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.042, 0.095, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xff5a1f,
        transparent: true,
        opacity: 0.0,
        side: THREE.DoubleSide,
      }),
    );
    this.coilGlowMesh.position.set(
      -0.02,
      this.hobModel === "maruzen" || this.hobModel === "rinnai-rsb-150pj"
        ? 0.1065
        : this.hobModel === "vollrath"
          ? 0.084
          : 0.0545,
      0.18,
    );
    this.model.add(this.coilGlowMesh);

    const panBuilt = this.buildInductionPan();
    this.butterBody = panBuilt.butterBody;
    this.butterTop = panBuilt.butterTop;
    this.butterSteamWisps = panBuilt.steamWisps;
    this.model.add(this.panGroup);

    const bowlBuilt = this.buildMixerBowlBatter();
    this.bowlBatterBody = bowlBuilt.batterBody;
    this.bowlBatterTop = bowlBuilt.batterTop;
    this.bowlBatterGroup.position.set(0.38, 0.02, 0.226);
    this.model.add(this.bowlBatterGroup);

    this.dryVesselContent = this.buildDryVessel();
    this.model.add(this.dryVesselGroup);

    this.whitesVesselContent = this.buildWhitesVessel();
    this.model.add(this.whitesVesselGroup);

    // 3D Pour streams into the Hobart HL200 20 qt bowl (`x = 0.38, z = 0.224`)
    const streamCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.075, 0.15, 0.02),
      new THREE.Vector3(-0.035, 0.1, 0.012),
      new THREE.Vector3(-0.01, 0.048, 0.004),
      new THREE.Vector3(0.0, 0.0, 0),
    ]);
    this.dryPourStream = new THREE.Mesh(
      new THREE.TubeGeometry(streamCurve, 20, 0.0085, 14, false),
      new THREE.MeshStandardMaterial({
        color: 0xf5ebd6,
        roughness: 0.78,
        metalness: 0.0,
      }),
    );
    this.dryPourStream.visible = false;

    this.whitesPourStream = new THREE.Mesh(
      new THREE.TubeGeometry(streamCurve, 20, 0.0055, 14, false),
      new THREE.MeshPhysicalMaterial({
        color: 0xf7e7b4,
        roughness: 0.08,
        transmission: 0.45,
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.whitesPourStream.visible = false;

    this.butterPourStream = new THREE.Mesh(
      new THREE.TubeGeometry(streamCurve, 24, 0.0052, 16, false),
      new THREE.MeshPhysicalMaterial({
        color: 0xb8641b,
        emissive: 0x4a2005,
        emissiveIntensity: 0.22,
        roughness: 0.08,
        clearcoat: 1.0,
      }),
    );
    this.butterPourStream.visible = false;

    this.model.add(
      this.dryPourStream,
      this.whitesPourStream,
      this.butterPourStream,
    );

    this.scaleRoot.position.set(-0.42, 0, 0.16);
    this.hobRoot.position.set(-0.02, 0, 0.18);
    this.mixerRoot.position.set(0.38, 0, 0.146);
    this.model.add(this.scaleRoot, this.hobRoot, this.mixerRoot);

    this.host.requestFrame();
  }

  private buildInductionPan(): Readonly<{
    butterBody: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
    butterTop: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
    steamWisps: readonly THREE.Mesh<
      THREE.RingGeometry,
      THREE.MeshBasicMaterial
    >[];
  }> {
    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xd6dde4,
      roughness: 0.22,
      metalness: 0.88,
      side: THREE.DoubleSide,
    });
    const profile = [
      new THREE.Vector2(0.0001, 0.0),
      new THREE.Vector2(0.098, 0.0),
      new THREE.Vector2(0.104, 0.052),
      new THREE.Vector2(0.108, 0.056),
      new THREE.Vector2(0.101, 0.056),
      new THREE.Vector2(0.095, 0.005),
      new THREE.Vector2(0.0001, 0.005),
    ];
    const panMesh = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 48),
      stainlessMat,
    );
    panMesh.castShadow = true;
    panMesh.receiveShadow = true;

    // Riveted stainless + black silicone handle on `-X` so Cobot approaches from the left
    const handleShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.013, 0.16, 20).rotateZ(
        Math.PI * 0.44,
      ),
      new THREE.MeshStandardMaterial({
        color: 0x22282e,
        roughness: 0.55,
        metalness: 0.2,
      }),
    );
    handleShaft.position.set(-0.165, 0.058, 0);
    handleShaft.castShadow = true;

    const butterBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.094, 0.092, 0.022, 40),
      new THREE.MeshStandardMaterial({
        color: 0xd89628,
        roughness: 0.22,
        metalness: 0.05,
      }),
    );
    butterBody.position.y = 0.016;

    const butterTop = new THREE.Mesh(
      new THREE.CircleGeometry(0.094, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        map: this.butterTexture,
        roughness: 0.18,
        metalness: 0.04,
      }),
    );
    butterTop.position.y = 0.0275;

    const steamWisps = [0, 1, 2].map(() => {
      const wisp = new THREE.Mesh(
        new THREE.RingGeometry(0.024, 0.062, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: 0xfffdf8,
          transparent: true,
          opacity: 0.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      wisp.visible = false;
      this.panGroup.add(wisp);
      return wisp;
    });

    this.panGroup.add(panMesh, handleShaft, butterBody, butterTop);
    return { butterBody, butterTop, steamWisps };
  }

  private buildMixerBowlBatter(): Readonly<{
    batterBody: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial>;
    batterTop: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  }> {
    const batterBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.103, 0.071, 1, 48),
      new THREE.MeshPhysicalMaterial({
        color: 0xe6be6e,
        roughness: 0.24,
        metalness: 0.0,
        clearcoat: 0.65,
      }),
    );
    batterBody.visible = false;

    const batterTop = new THREE.Mesh(
      new THREE.CircleGeometry(0.103, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        map: this.batterTexture,
        roughness: 0.25,
        metalness: 0.02,
      }),
    );
    batterTop.visible = false;

    this.bowlBatterGroup.add(batterBody, batterTop);
    return { batterBody, batterTop };
  }

  private buildDryVessel(): THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  > {
    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xdbe2e9,
      roughness: 0.24,
      metalness: 0.85,
      side: THREE.DoubleSide,
    });
    const vesselMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.068, 0.056, 0.095, 36, 1, true),
      stainlessMat,
    );
    vesselMesh.position.y = 0.0475;
    vesselMesh.castShadow = true;

    const bottomDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.056, 36).rotateX(-Math.PI / 2),
      stainlessMat,
    );
    bottomDisc.position.y = 0.001;

    const powderMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.064, 0.054, 0.072, 32),
      new THREE.MeshStandardMaterial({
        color: 0xf6eedb,
        roughness: 0.82,
      }),
    );
    powderMesh.position.y = 0.038;

    this.dryVesselGroup.add(vesselMesh, bottomDisc, powderMesh);
    return powderMesh;
  }

  private buildWhitesVessel(): THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  > {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.08,
      transmission: 0.82,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const vesselMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.046, 0.092, 32, 1, true),
      glassMat,
    );
    vesselMesh.position.y = 0.046;

    const whitesMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.049, 0.044, 0.066, 32),
      new THREE.MeshPhysicalMaterial({
        color: 0xf4df9e,
        roughness: 0.12,
        transmission: 0.42,
        transparent: true,
        opacity: 0.88,
      }),
    );
    whitesMesh.position.y = 0.034;

    this.whitesVesselGroup.add(vesselMesh, whitesMesh);
    return whitesMesh;
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const hobAssetUrl = inductionHobUrl(this.hobModel);

    const [scaleGltf, hobGltf, mixerGltf, beaterGltf, loadedRobot] =
      await Promise.all([
        loader.loadAsync(ohausScaleUrl),
        loader.loadAsync(hobAssetUrl),
        loader.loadAsync(kpl9000sUrl),
        loader.loadAsync(kpl9000sBeaterUrl),
        loadRobotVisual("fairino-fr10", this.loadAbort.signal),
      ]);

    if (this.lifecycle === "disposed") {
      scaleGltf.scene.traverse(disposePhysicsObject);
      hobGltf.scene.traverse(disposePhysicsObject);
      mixerGltf.scene.traverse(disposePhysicsObject);
      beaterGltf.scene.traverse(disposePhysicsObject);
      loadedRobot.traverse(disposePhysicsObject);
      return;
    }

    enableShadows(scaleGltf.scene);
    this.scalePan.bind(scaleGltf.scene);
    this.scaleRoot.add(scaleGltf.scene);

    enableShadows(hobGltf.scene);
    this.hobRoot.add(hobGltf.scene);

    enableShadows(mixerGltf.scene);
    this.hlBowlLiftNode =
      mixerGltf.scene.getObjectByName("kpl_bowl") ??
      mixerGltf.scene.getObjectByName("hl_bowl_lift") ??
      null;
    if (this.hlBowlLiftNode) {
      this.hlBowlBaseY = this.hlBowlLiftNode.position.y;
    }
    this.hlGuardNode =
      mixerGltf.scene.getObjectByName("kpl_finger_guard") ??
      mixerGltf.scene.getObjectByName("hl_guard") ??
      null;
    this.hlPlanetaryNode =
      mixerGltf.scene.getObjectByName("kpl_planetary") ??
      mixerGltf.scene.getObjectByName("hl_planetary") ??
      null;
    this.hlLiftLeverNode =
      mixerGltf.scene.getObjectByName("kpl_speed_dial") ??
      mixerGltf.scene.getObjectByName("hl_lift_lever") ??
      null;
    this.hlWhipNode =
      mixerGltf.scene.getObjectByName("kpl_whip") ??
      mixerGltf.scene.getObjectByName("hl_whip") ??
      null;

    enableShadows(beaterGltf.scene);
    this.hlBeaterNode = beaterGltf.scene;
    this.hlBeaterNode.scale.setScalar(0.425);
    if (this.hlWhipNode) {
      this.hlBeaterNode.position.copy(this.hlWhipNode.position);
    } else {
      this.hlBeaterNode.position.set(0, -0.008, 0.026);
    }
    if (this.hlPlanetaryNode && this.hlBeaterNode) {
      this.hlPlanetaryNode.add(this.hlBeaterNode);
    }
    this.hlToolAxisNode =
      this.mixerTool === "beater" ? this.hlBeaterNode : this.hlWhipNode;
    if (this.hlBeaterNode) {
      this.hlBeaterNode.visible = this.mixerTool === "beater";
    }
    if (this.hlWhipNode) {
      this.hlWhipNode.visible = this.mixerTool === "whip";
    }
    this.mixerRoot.add(mixerGltf.scene);

    this.pivots = mountFr10Visual(this.robot, loadedRobot);
    this.lifecycle = "ready";

    if (this.displayedFrame !== null) {
      this.applySample(this.displayedFrame, performance.now());
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: FinancierBatterCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset]);
  }

  setFrame(sample: FinancierBatterSample): void {
    this.batchSamples = [sample];
    this.transitionStartedAt = performance.now();
    this.applySample(sample, this.transitionStartedAt);
    this.host.requestFrame();
  }

  setSamples(samples: readonly FinancierBatterSample[]): void {
    if (samples.length === 0) return;
    const first = this.displayedFrame ?? samples[0]!;
    this.batchSamples = [first, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: FinancierBatterSample, now: number): void {
    this.displayedFrame = sample;

    // 1. Ohaus Ranger 3000 scale weighing pan deflection
    this.scalePan.deflect(sample.scale.panDeflectionM);

    // 2. Induction hob glowing coil & 200 mm beurre noisette pan
    const { induction } = sample;
    this.coilGlowMesh.material.opacity = induction.coilActive
      ? 0.42 + Math.sin(now * 0.008) * 0.1
      : 0.0;
    this.panGroup.position.set(
      induction.panPosZUp[0],
      induction.panPosZUp[2],
      -induction.panPosZUp[1],
    );
    this.panGroup.rotation.set(0, 0, -induction.panTiltRad);

    const butterBucket =
      Math.round(induction.browningProgress * 40) * 100 +
      Math.round(induction.foamIntensity * 20);
    if (butterBucket !== this.lastButterBucket) {
      this.lastButterBucket = butterBucket;
      const bCtx = this.butterCanvas.getContext("2d");
      if (bCtx) {
        drawBeurreNoisetteCanvas(
          bCtx,
          induction.browningProgress,
          induction.foamIntensity,
          sample.phase === "failed" && induction.butterTempC > 170,
        );
        this.butterTexture.needsUpdate = true;
      }
    }
    const butterFrac = THREE.MathUtils.clamp(
      induction.butterMassG / 180,
      0.06,
      1.0,
    );
    this.butterBody.scale.set(1, butterFrac, 1);
    this.butterBody.position.y = 0.005 + 0.011 * butterFrac;
    this.butterTop.position.y = 0.005 + 0.022 * butterFrac + 0.0005;

    const steamingButter =
      induction.butterTempC > 95 && induction.panTiltRad < 0.2;
    for (const [idx, wisp] of this.butterSteamWisps.entries()) {
      wisp.visible = steamingButter;
      if (steamingButter) {
        const cycle =
          (((now * 0.0005 + idx / this.butterSteamWisps.length) % 1) + 1) % 1;
        wisp.position.set(
          Math.sin(now * 0.002 + idx * 2) * 0.008,
          0.032 + cycle * 0.09,
          Math.cos(now * 0.0017 + idx * 1.6) * 0.008,
        );
        const s = 0.7 + cycle * 0.9;
        wisp.scale.set(s, s, 1);
        wisp.material.opacity = Math.sin(cycle * Math.PI) * 0.22;
      }
    }

    // 3. Aicohsha Kenmix KPL9000S planetary mixer articulations & 6.7 L bowl batter
    const { mixer } = sample;
    if (this.hlBowlLiftNode) {
      this.hlBowlLiftNode.position.y = this.hlBowlBaseY + mixer.bowlLiftM * 0.4;
    }
    if (this.hlLiftLeverNode) {
      this.hlLiftLeverNode.rotation.x = mixer.speedSetting * 1.45;
    }
    if (this.hlGuardNode) {
      this.hlGuardNode.rotation.x =
        (Math.min(0, mixer.guardAngleRad) / -1.95) * 0.35;
    }
    if (this.hlPlanetaryNode) {
      this.hlPlanetaryNode.rotation.y = mixer.orbitAngleRad;
    }
    if (this.hlToolAxisNode) {
      this.hlToolAxisNode.rotation.y = mixer.spinAngleRad;
    }

    const hasBatter = mixer.bowlMassG > 2;
    this.bowlBatterBody.visible = hasBatter;
    this.bowlBatterTop.visible = hasBatter;
    this.bowlBatterGroup.position.y = 0.02 + mixer.bowlLiftM * 0.4;
    let batterSurfaceY = 0.08 + mixer.bowlLiftM * 0.4;
    if (hasBatter) {
      const fillFrac = THREE.MathUtils.clamp(mixer.bowlMassG / 756, 0.08, 1.0);
      const height = THREE.MathUtils.lerp(0.038, 0.102, fillFrac);
      this.bowlBatterBody.scale.set(1, height, 1);
      this.bowlBatterBody.position.y = height / 2;
      this.bowlBatterTop.position.y = height + 0.001;
      batterSurfaceY = this.bowlBatterGroup.position.y + height;

      const batterBucket =
        Math.round(mixer.emulsification * 50) * 100 +
        Math.round((mixer.orbitAngleRad % (Math.PI * 2)) * 10) +
        (mixer.butterChargedG > 5 ? 10000 : 0);
      if (batterBucket !== this.lastBatterBucket) {
        this.lastBatterBucket = batterBucket;
        const mCtx = this.batterCanvas.getContext("2d");
        if (mCtx) {
          drawFinancierBatterCanvas(
            mCtx,
            mixer.emulsification,
            mixer.butterChargedG > 5,
            mixer.orbitAngleRad,
          );
          this.batterTexture.needsUpdate = true;
        }
      }
    }

    // 4. Dry-blend vessel & egg-whites vessel + pour streams
    const { dryVessel, whitesVessel } = sample;
    this.dryVesselGroup.position.set(
      dryVessel.posZUp[0],
      dryVessel.posZUp[2],
      -dryVessel.posZUp[1],
    );
    this.dryVesselGroup.rotation.set(0, 0, -dryVessel.tiltRad);
    this.dryVesselContent.visible = dryVessel.massG > 2;
    if (this.dryVesselContent.visible) {
      const frac = THREE.MathUtils.clamp(dryVessel.massG / 395, 0.08, 1.0);
      this.dryVesselContent.scale.set(1, frac, 1);
      this.dryVesselContent.position.y = 0.002 + 0.036 * frac;
    }

    this.whitesVesselGroup.position.set(
      whitesVessel.posZUp[0],
      whitesVessel.posZUp[2],
      -whitesVessel.posZUp[1],
    );
    this.whitesVesselGroup.rotation.set(0, 0, -whitesVessel.tiltRad);
    this.whitesVesselContent.visible = whitesVessel.massG > 2;
    if (this.whitesVesselContent.visible) {
      const frac = THREE.MathUtils.clamp(whitesVessel.massG / 181, 0.08, 1.0);
      this.whitesVesselContent.scale.set(1, frac, 1);
      this.whitesVesselContent.position.y = 0.002 + 0.033 * frac;
    }

    this.dryPourStream.visible = dryVessel.pouringRateGS > 1;
    if (this.dryPourStream.visible) {
      this.dryPourStream.position.set(0.35, batterSurfaceY, 0.23);
    }
    this.whitesPourStream.visible = whitesVessel.pouringRateGS > 1;
    if (this.whitesPourStream.visible) {
      this.whitesPourStream.position.set(0.35, batterSurfaceY, 0.23);
    }
    this.butterPourStream.visible = induction.pouringRateGS > 1;
    if (this.butterPourStream.visible) {
      this.butterPourStream.position.set(0.34, batterSurfaceY, 0.23);
    }

    // 5. FAIRINO FR10 6-DOF inverse kinematics & parallel gripper
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
    this.butterTexture.dispose();
    this.batterTexture.dispose();
    this.host.dispose();
  }
}
