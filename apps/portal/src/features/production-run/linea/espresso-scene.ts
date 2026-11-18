import type { ApplianceVisual } from "@seams/production-simulation/simulator/appliance-runtime";
import * as THREE from "three";
import { isRecord, parseJsonOrNull } from "@seams/std";
import {
  loadVisual,
  preloadVisual,
} from "../../workflow-simulator/spatial/physics-asset-loader";
import {
  loadRobotVisual,
  preloadRobotVisual,
} from "../../workflow-simulator/spatial/physics-robot-visual";
import {
  LINEA_GLB_SHA256,
  EAGLE_GLB_SHA256,
} from "@seams/bakery-model/bakery-physics";
import { SceneHost } from "../scene-host";
import type {
  ApplianceDisplay,
  ApplianceSample,
} from "@seams/bakery-model/bakery-appliance-protocol";
import { disposePhysicsObject } from "../../workflow-simulator/spatial/physics-model";
import {
  applyRecordedAppliancePose,
  baristaCounter,
  enableSceneShadows as enableShadows,
  interpolateApplianceSample,
  playSampleBatch,
  studioFloor,
  studioLights,
} from "../appliance-sample-three";
import modelUrl from "../../../../../../assets/bakery-mujoco/la-marzocco-linea-classic-s-2g/la-marzocco-linea-classic-s-2g.glb?url";
import eagleUrl from "../../../../../../assets/bakery-mujoco/victoria-arduino-eagle-one-2g/victoria-arduino-eagle-one-2g.glb?url";
import {
  fr10ToolKinematics,
  fr10WristIk,
} from "@seams/production-simulation/kinematics/fr10";
import {
  fr10Arm,
  fr10Pivots,
  openFr10Fingers,
  reachFr10,
  type Fr10Pivot,
} from "../shared/cobot-rig";

type EspressoModel = "linea" | "eagle-one";
export type EspressoCameraPreset = "station" | "group" | "overhead";

type Vec3 = readonly [number, number, number];
type Pose7 = readonly [number, number, number, number, number, number, number];

type EspressoLiveTelemetry = Readonly<{
  coffeeC: number;
  steamC: number;
  brewPressureBar: number;
  steamPressureBar: number;
  servedG: number;
  leftCup: Readonly<{
    position: "placed" | "removed";
    massG: number;
    temperatureC: number;
    travelM: number;
    travelSetpointM: number;
  }>;
  leftShot: Readonly<{
    kind: "idle" | "dispensing" | "complete" | "interrupted";
    elapsedS: number;
    durationS: number;
    deliveredG: number;
  }>;
  hotWater: Readonly<{
    kind: "idle" | "dispensing" | "complete" | "interrupted";
    elapsedS: number;
    deliveredG: number;
  }>;
}>;

const CAMERA_PRESETS: Readonly<
  Record<
    EspressoCameraPreset,
    Readonly<{
      position: Vec3;
      target: Vec3;
    }>
  >
> = {
  station: {
    position: [0.64, 0.78, 1.24],
    target: [-0.14, 0.24, 0.24],
  },
  group: {
    position: [0.14, 0.44, 0.54],
    target: [-0.12, 0.24, 0.21],
  },
  overhead: {
    position: [-0.14, 1.32, 0.48],
    target: [-0.16, 0.18, 0.26],
  },
};

const ROBOT_BASE_ZUP: Vec3 = [-0.56, -0.66, -0.03];
const INTERPOLATION_MS = 55;
const ARM = fr10Arm(ROBOT_BASE_ZUP, fr10WristIk, fr10ToolKinematics);

export function preloadEspressoVisual(appliance: EspressoModel): void {
  preloadVisual(
    appliance === "linea" ? modelUrl : eagleUrl,
    appliance === "linea" ? LINEA_GLB_SHA256 : EAGLE_GLB_SHA256,
  );
  preloadRobotVisual("fairino-fr10");
}

/**
 * Prepared espresso station sample at `t = 0 s` so the 3D scene (espresso machine,
 * barista counter, porcelain cups, LED shot timers, and FAIRINO FR10 Cobot) renders
 * immediately in review state before execution starts.
 */
export function initialEspressoSample(
  appliance: EspressoModel,
): ApplianceSample {
  const isLinea = appliance === "linea";
  const prefix = isLinea ? "lcs" : "eo";
  const bodies = new Map<string, Pose7>();
  bodies.set(
    isLinea ? "lcs_machine" : "victoria-arduino-eagle-one-2g",
    [0, 0, 0, 1, 0, 0, 0],
  );
  bodies.set(
    `${prefix}_left_portafilter`,
    isLinea
      ? [-0.12, -0.177, 0.318, 1, 0, 0, 0]
      : [-0.094, -0.155, 0.279, 1, 0, 0, 0],
  );
  bodies.set(
    `${prefix}_right_portafilter`,
    isLinea
      ? [0.12, -0.177, 0.318, 1, 0, 0, 0]
      : [0.144, -0.155, 0.279, 1, 0, 0, 0],
  );
  bodies.set(
    `${prefix}_left_cup`,
    isLinea
      ? [-0.12, -0.375, 0.225, 1, 0, 0, 0]
      : [-0.094, -0.35, 0.168, 1, 0, 0, 0],
  );
  bodies.set(
    `${prefix}_right_cup`,
    isLinea
      ? [0.12, -0.195, 0.225, 1, 0, 0, 0]
      : [0.144, -0.17, 0.168, 1, 0, 0, 0],
  );
  bodies.set(
    `${prefix}_hot_water_cup`,
    isLinea
      ? [0.215, -0.195, 0.225, 1, 0, 0, 0]
      : [-0.218, -0.179, 0.168, 1, 0, 0, 0],
  );

  const displays: ApplianceDisplay[] = isLinea
    ? [
        {
          name: "left_timer",
          text: "00",
          lamp: false,
          pose: [-0.12, -0.239, 0.47, 0.70710678, 0.70710678, 0, 0],
          width: 0.031,
          height: 0.016,
          color: [0.93, 0.61, 0.2],
        },
        {
          name: "right_timer",
          text: "00",
          lamp: false,
          pose: [0.12, -0.239, 0.47, 0.70710678, 0.70710678, 0, 0],
          width: 0.031,
          height: 0.016,
          color: [0.93, 0.61, 0.2],
        },
      ]
    : [
        {
          name: "left_timer",
          text: "00",
          lamp: false,
          pose: [-0.094, -0.208, 0.379, 0.70710678, 0.70710678, 0, 0],
          width: 0.024,
          height: 0.014,
          color: [0.93, 0.61, 0.2],
        },
        {
          name: "right_timer",
          text: "00",
          lamp: false,
          pose: [0.144, -0.208, 0.379, 0.70710678, 0.70710678, 0, 0],
          width: 0.024,
          height: 0.014,
          color: [0.93, 0.61, 0.2],
        },
      ];

  const telemetry = {
    kind: "espresso",
    espresso: {
      model: appliance,
      cups: [
        {
          position: "removed",
          mass_g: 0,
          temperature_c: 20,
          travel_m: 0.18,
          travel_setpoint_m: 0.18,
          support_n: 1.962,
        },
        {
          position: "placed",
          mass_g: 0,
          temperature_c: 20,
          travel_m: 0,
          travel_setpoint_m: 0,
          support_n: 1.962,
        },
        {
          position: "placed",
          mass_g: 0,
          temperature_c: 20,
          travel_m: 0,
          travel_setpoint_m: 0,
          support_n: 1.962,
        },
      ],
      drain_g: 0,
      discarded_g: 0,
      served_g: 0,
      dose_controls: ["manual", "one"],
      shot_doses_s: [
        [18, 25],
        [18, 25],
      ],
      hot_water_dose_s: 5,
      shots: [{ kind: "idle" }, { kind: "idle" }],
      hot_water: { kind: "idle" },
      filters: [
        { target: "locked", lift_setpoint_m: 0 },
        { target: "locked", lift_setpoint_m: 0 },
      ],
      steam_open: [false, false],
      water_available: true,
      power: { kind: "on", coffee_c: 93, steam_c: 125 },
      coffee_c: 93,
      steam_c: 125,
      brew_pressure_bar: [0, 0],
      steam_pressure_bar: 1.2,
      heater_w: 0,
      drawn_water_g: 0,
      input_j: 0,
      loss_j: 0,
      grounds_exchange_j: 0,
    },
  };

  return {
    timeSeconds: 0,
    contents: { kind: "empty" },
    bodies,
    displays,
    telemetryText: JSON.stringify(telemetry),
    flexMeshes: [],
  };
}

/** Parses live controller state from `sample.telemetryText` for UI and fluid/robot animation. */
export function parseEspressoLiveTelemetry(
  sample: ApplianceSample | null,
): EspressoLiveTelemetry {
  const fallback: EspressoLiveTelemetry = {
    coffeeC: 93,
    steamC: 125,
    brewPressureBar: 0,
    steamPressureBar: 1.2,
    servedG: 0,
    leftCup: {
      position: "removed",
      massG: 0,
      temperatureC: 20,
      travelM: 0.18,
      travelSetpointM: 0.18,
    },
    leftShot: {
      kind: "idle",
      elapsedS: 0,
      durationS: 18,
      deliveredG: 0,
    },
    hotWater: {
      kind: "idle",
      elapsedS: 0,
      deliveredG: 0,
    },
  };
  if (sample === null) return fallback;
  const raw = parseJsonOrNull(sample.telemetryText);
  if (!isRecord(raw) || !isRecord(raw.espresso)) return fallback;
  const esp = raw.espresso;
  const cups = Array.isArray(esp.cups) ? esp.cups : [];
  const c0 = isRecord(cups[0]) ? cups[0] : null;
  const shots = Array.isArray(esp.shots) ? esp.shots : [];
  const s0 = isRecord(shots[0]) ? shots[0] : null;
  const hw = isRecord(esp.hot_water) ? esp.hot_water : null;
  const pressures = Array.isArray(esp.brew_pressure_bar)
    ? esp.brew_pressure_bar
    : [];

  const num = (val: unknown, def: number): number =>
    typeof val === "number" && Number.isFinite(val) ? val : def;

  const shotKind =
    s0?.kind === "dispensing" ||
    s0?.kind === "complete" ||
    s0?.kind === "interrupted"
      ? s0.kind
      : "idle";
  const hwKind =
    hw?.kind === "dispensing" ||
    hw?.kind === "complete" ||
    hw?.kind === "interrupted"
      ? hw.kind
      : "idle";

  return {
    coffeeC: num(esp.coffee_c, 93),
    steamC: num(esp.steam_c, 125),
    brewPressureBar: num(pressures[0], 0),
    steamPressureBar: num(esp.steam_pressure_bar, 1.2),
    servedG: num(esp.served_g, 0),
    leftCup: {
      position: c0?.position === "placed" ? "placed" : "removed",
      massG: num(c0?.mass_g, 0),
      temperatureC: num(c0?.temperature_c, 20),
      travelM: num(c0?.travel_m, 0.18),
      travelSetpointM: num(c0?.travel_setpoint_m, 0.18),
    },
    leftShot: {
      kind: shotKind,
      elapsedS: num(s0?.elapsed_s, 0),
      durationS: num(s0?.duration_s, 18),
      deliveredG: num(s0?.delivered_g, 0),
    },
    hotWater: {
      kind: hwKind,
      elapsedS: num(hw?.elapsed_s, 0),
      deliveredG: num(hw?.delivered_g, 0),
    },
  };
}

/**
 * Rich golden-hazelnut espresso crema texture with dark-roast mahogany tiger-striping
 * and micro-foam sheen for the rising beverage meniscus inside the demitasse cup.
 */
function createEspressoCremaTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const grad = ctx.createRadialGradient(128, 128, 12, 128, 128, 126);
    grad.addColorStop(0, "#b86824");
    grad.addColorStop(0.55, "#c97b32");
    grad.addColorStop(0.84, "#a15218");
    grad.addColorStop(1, "#5c2408");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    // Concentric tiger-stripe mottling streaks characteristic of 9-bar espresso extraction.
    for (let i = 0; i < 420; i++) {
      const angle = i * 1.6180339 * Math.PI * 2;
      const radius = 14 + ((i * 59) % 98);
      const x = 128 + Math.cos(angle) * radius;
      const y = 128 + Math.sin(angle) * radius;
      ctx.fillStyle =
        i % 3 === 0
          ? "rgba(58, 20, 6, 0.34)"
          : i % 3 === 1
            ? "rgba(226, 158, 84, 0.28)"
            : "rgba(120, 52, 16, 0.26)";
      ctx.beginPath();
      ctx.ellipse(
        x,
        y,
        2.2 + (i % 4) * 1.1,
        1.1 + (i % 3) * 0.6,
        angle + Math.PI / 2,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type CupVisual = Readonly<{
  group: THREE.Group;
  liquidBody: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial>;
  cremaDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  meniscusRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  ripples: readonly THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[];
  steamWisps: readonly THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  >[];
  innerRadius: number;
}>;

/** Shared visual for the appliance rehearsal and accepted scheduler observations. */
export class EspressoScene {
  private readonly host: SceneHost;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  private readonly model = new THREE.Group();
  /** Z-up station root (`rotation.x = -PI / 2`) matching MuJoCo and FR10 kinematics. */
  private readonly zUpRoot = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly gripper = new THREE.Group();
  private readonly leftFinger = new THREE.Group();
  private readonly rightFinger = new THREE.Group();
  private pivots: readonly Fr10Pivot[] = [];
  private readonly displayPlanes = new Map<
    string,
    THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  >();
  private readonly cupVisuals: CupVisual[] = [];
  private readonly servedCupVisuals: CupVisual[] = [];
  private readonly spentPucks: THREE.Mesh[] = [];
  private readonly spoutStreams: readonly THREE.Mesh<
    THREE.TubeGeometry,
    THREE.MeshPhysicalMaterial
  >[];
  private readonly spoutStreamMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x5c2208,
    roughness: 0.06,
    metalness: 0.02,
    clearcoat: 0.95,
    clearcoatRoughness: 0.04,
    transparent: true,
    opacity: 0.94,
  });
  private readonly hotWaterStream: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshPhysicalMaterial
  >;
  private readonly cremaTexture = createEspressoCremaTexture();
  private readonly loadAbort = new AbortController();
  private batchSamples: readonly ApplianceSample[] = [];
  private displayedFrame: ApplianceSample | null = null;
  private transitionStartedAt = 0;
  private loadedVisual: THREE.Object3D | null = null;
  private loadedRobot: THREE.Object3D | null = null;
  private lifecycle: "loading" | "ready" | "disposed" = "loading";

  constructor(
    view: HTMLElement,
    private readonly appliance: EspressoModel,
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
      minDistance: 0.26,
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

    this.buildBaristaStation();
    this.buildParallelGripper();

    for (const label of ["left", "right", "hot_water"] as const) {
      const cupVisual = createPorcelainCup(label, appliance, this.cremaTexture);
      this.model.add(cupVisual.group);
      this.cupVisuals.push(cupVisual);
    }

    // Create 3 additional served demitasse cups for multi-order service tray presentation (Orders 1..3 while Order 2..4 runs).
    const serviceY = appliance === "linea" ? -0.375 : -0.35;
    const serviceCupZ = appliance === "linea" ? 0.225 : 0.168;
    for (const [slotIdx, slotX] of [-0.032, 0.054, 0.14].entries()) {
      const servedCup = createPorcelainCup(
        `served_${slotIdx + 1}`,
        appliance,
        this.cremaTexture,
      );
      servedCup.group.position.set(slotX, serviceCupZ, -serviceY);
      servedCup.group.visible = false;
      servedCup.liquidBody.visible = true;
      servedCup.cremaDisc.visible = true;
      servedCup.meniscusRing.visible = true;
      const topY = 0.0255;
      const bottomY = -0.026;
      const height = topY - bottomY;
      servedCup.liquidBody.scale.set(1, height, 1);
      servedCup.liquidBody.position.y = bottomY + height / 2;
      servedCup.cremaDisc.position.y = topY + 0.0004;
      servedCup.meniscusRing.position.y = topY + 0.0006;
      this.model.add(servedCup.group);
      this.servedCupVisuals.push(servedCup);
    }

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

    this.hotWaterStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0022, 0.0016, 0.06, 16),
      new THREE.MeshPhysicalMaterial({
        color: 0xe6f6fc,
        roughness: 0.04,
        transmission: 0.78,
        ior: 1.333,
        clearcoat: 1.0,
        transparent: true,
        opacity: 0.82,
      }),
    );
    this.hotWaterStream.visible = false;
    this.model.add(this.hotWaterStream);

    // Apply prepared t = 0 state immediately so cups, timers, and arm pose are ready.
    this.applySample(initialEspressoSample(appliance), performance.now());

    this.host.requestFrame();
  }

  /**
   * Builds the café barista counter, service tamping mat, knock-box, calibrated tamper,
   * studio floor, and FAIRINO FR10 mounting pedestal in Z-up station coordinates.
   */
  private buildBaristaStation(): void {
    const [floor, grid] = studioFloor(5.2, [3.8, 19]);
    // Walnut barista counter, steel front trim, and the slate legs down to `mz = -0.78`.
    const [counterTop, frontTrim] = baristaCounter(this.zUpRoot);

    const underShelf = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.72, 0.024),
      new THREE.MeshStandardMaterial({
        color: 0x3b4148,
        roughness: 0.48,
        metalness: 0.35,
      }),
    );
    underShelf.position.set(0.02, -0.09, -0.46);
    underShelf.receiveShadow = true;

    // Guided cup transfer deck & silicone barista service mat (`mz = 0 .. cupBaseZ`)
    // bridging from the front service zone (`my = -0.375`) to the drip tray edge (`my = -0.255`).
    const cupDeckTopZ = this.appliance === "linea" ? 0.189 : 0.132;
    const serviceRiser = new THREE.Mesh(
      new THREE.BoxGeometry(0.48, 0.19, cupDeckTopZ),
      new THREE.MeshStandardMaterial({
        color: 0x23272c,
        roughness: 0.38,
        metalness: 0.62,
      }),
    );
    serviceRiser.position.set(-0.04, -0.365, cupDeckTopZ / 2);
    serviceRiser.castShadow = true;
    serviceRiser.receiveShadow = true;

    const siliconeMat = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.165, 0.004),
      new THREE.MeshStandardMaterial({
        color: 0x16181b,
        roughness: 0.78,
        metalness: 0.04,
      }),
    );
    siliconeMat.position.set(-0.04, -0.365, cupDeckTopZ + 0.002);
    siliconeMat.receiveShadow = true;

    // Multi-cup brass service coaster rings along the front service bar (Slot 0 active handoff + Slots 1..3 served orders).
    const serviceX = this.appliance === "linea" ? -0.12 : -0.094;
    const serviceY = this.appliance === "linea" ? -0.375 : -0.35;
    const coasterMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.26,
      metalness: 0.84,
      side: THREE.DoubleSide,
    });
    for (const [idx, slotX] of [serviceX, -0.032, 0.054, 0.14].entries()) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(
          idx === 0 ? 0.032 : 0.029,
          idx === 0 ? 0.036 : 0.0325,
          40,
        ),
        coasterMat,
      );
      ring.position.set(slotX, serviceY, cupDeckTopZ + 0.0045);
      this.zUpRoot.add(ring);
    }

    // Calibrated 58 mm stainless-steel & walnut barista tamper resting at the back-right of the service mat.
    const tamperGroup = new THREE.Group();
    tamperGroup.position.set(0.145, -0.312, cupDeckTopZ + 0.004);
    const tamperBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.029, 0.029, 0.012, 32).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xd8dfe6,
        roughness: 0.18,
        metalness: 0.9,
      }),
    );
    tamperBase.position.z = 0.006;
    const tamperHandle = new THREE.Mesh(
      new THREE.LatheGeometry(
        [
          new THREE.Vector2(0.012, 0.012),
          new THREE.Vector2(0.0105, 0.032),
          new THREE.Vector2(0.019, 0.058),
          new THREE.Vector2(0.017, 0.072),
          new THREE.Vector2(0.001, 0.075),
        ],
        32,
      ).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x5c381c,
        roughness: 0.36,
        metalness: 0.05,
      }),
    );
    tamperGroup.add(tamperBase, tamperHandle);
    enableShadows(tamperGroup);

    // Open-top stainless-steel knock-box with rubberized knock bar & spent espresso pucks (`mx = -0.36, my = -0.34`).
    const knockBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.136, 0.146, 0.088),
      new THREE.MeshStandardMaterial({
        color: 0x363c42,
        roughness: 0.32,
        metalness: 0.72,
      }),
    );
    knockBox.position.set(-0.36, -0.34, 0.044);
    const knockWell = new THREE.Mesh(
      new THREE.BoxGeometry(0.116, 0.126, 0.016),
      new THREE.MeshStandardMaterial({
        color: 0x140d09,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );
    knockWell.position.set(-0.36, -0.34, 0.082);
    const knockBar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.009, 0.132, 20).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x15171a,
        roughness: 0.75,
        metalness: 0.06,
      }),
    );
    knockBar.position.set(-0.36, -0.34, 0.086);
    this.zUpRoot.add(knockWell);

    // Compacted 58 mm spent coffee pucks inside the knock-box (revealed per completed order).
    const puckMat = new THREE.MeshStandardMaterial({
      color: 0x2b170c,
      roughness: 0.94,
      metalness: 0.01,
    });
    for (const [puckIdx, pose] of (
      [
        { x: -0.382, y: -0.368, z: 0.091, rx: 0.12, ry: -0.08 },
        { x: -0.338, y: -0.312, z: 0.092, rx: -0.15, ry: 0.11 },
        { x: -0.376, y: -0.314, z: 0.096, rx: 0.22, ry: 0.18 },
        { x: -0.342, y: -0.364, z: 0.099, rx: -0.18, ry: -0.14 },
      ] as const
    ).entries()) {
      const puck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.027, 0.016, 28).rotateX(
          Math.PI / 2,
        ),
        puckMat,
      );
      puck.name = `spent_puck_${puckIdx + 1}`;
      puck.position.set(pose.x, pose.y, pose.z);
      puck.rotation.set(pose.rx, pose.ry, 0);
      puck.castShadow = true;
      puck.visible = false;
      this.zUpRoot.add(puck);
      this.spentPucks.push(puck);
    }

    // Heavy steel pedestal column & mounting plate for the FAIRINO FR10 Cobot at `ROBOT_BASE_ZUP`.
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
    pedestalColumn.castShadow = true;
    pedestalColumn.receiveShadow = true;

    const pedestalPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.34, 0.05),
      pedestalMat,
    );
    pedestalPlate.position.set(
      ROBOT_BASE_ZUP[0],
      ROBOT_BASE_ZUP[1],
      ROBOT_BASE_ZUP[2] - 0.025,
    );
    pedestalPlate.castShadow = true;
    pedestalPlate.receiveShadow = true;

    this.zUpRoot.add(
      floor,
      grid,
      counterTop,
      frontTrim,
      underShelf,
      serviceRiser,
      siliconeMat,
      tamperGroup,
      knockBox,
      knockBar,
      pedestalColumn,
      pedestalPlate,
    );
  }

  /**
   * High-fidelity CNC parallel barista gripper mounted to the FAIRINO FR10 wrist:
   * ISO 9409-1 quick tool changer with green status LED ring, M8 umbilical cable,
   * chamfered gunmetal/titanium servo palm, linear rail, and contoured silicone cup-cradle pads.
   */
  private buildParallelGripper(): void {
    const titaniumMat = new THREE.MeshStandardMaterial({
      color: 0xbac4ce,
      roughness: 0.22,
      metalness: 0.84,
    });
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x22272e,
      roughness: 0.32,
      metalness: 0.68,
    });
    const slateTealMat = new THREE.MeshStandardMaterial({
      color: 0x1d5b63,
      roughness: 0.28,
      metalness: 0.46,
    });
    const hardenedSteelMat = new THREE.MeshStandardMaterial({
      color: 0xd8dfe6,
      roughness: 0.16,
      metalness: 0.92,
    });
    const brassAccentMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.24,
      metalness: 0.86,
    });
    const siliconePadMat = new THREE.MeshStandardMaterial({
      color: 0x16181b,
      roughness: 0.74,
      metalness: 0.05,
    });
    const ledRingMat = new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      emissive: new THREE.Color(0x16a34a),
      emissiveIntensity: 0.75,
      roughness: 0.18,
    });

    const changerCoupling = new THREE.Mesh(
      new THREE.CylinderGeometry(0.039, 0.041, 0.024, 40).rotateZ(-Math.PI / 2),
      titaniumMat,
    );
    changerCoupling.position.set(0.012, 0, 0);

    const statusRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.0386, 0.0016, 12, 40).rotateY(Math.PI / 2),
      ledRingMat,
    );
    statusRing.position.set(0.0125, 0, 0);

    const palmBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.034, 0.098, 0.052),
      gunmetalMat,
    );
    palmBody.position.set(0.043, 0, 0);

    const guideRail = new THREE.Mesh(
      new THREE.BoxGeometry(0.009, 0.104, 0.026),
      hardenedSteelMat,
    );
    guideRail.position.set(0.064, 0, 0);

    const cableCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.004, 0.018, 0.034),
      new THREE.Vector3(0.015, 0.035, 0.046),
      new THREE.Vector3(0.027, 0.036, 0.042),
      new THREE.Vector3(0.036, 0.024, 0.028),
    ]);
    const ioCable = new THREE.Mesh(
      new THREE.TubeGeometry(cableCurve, 20, 0.0025, 10, false),
      siliconePadMat,
    );

    this.gripper.add(changerCoupling, statusRing, palmBody, guideRail, ioCable);

    for (const [fingerGroup, signY] of [
      [this.leftFinger, 1],
      [this.rightFinger, -1],
    ] as const) {
      const carriage = new THREE.Mesh(
        new THREE.BoxGeometry(0.014, 0.022, 0.032),
        slateTealMat,
      );
      carriage.position.set(0.072, 0, 0);

      const armBeam = new THREE.Mesh(
        new THREE.BoxGeometry(0.056, 0.006, 0.022),
        titaniumMat,
      );
      armBeam.position.set(0.104, signY * 0.003, 0);

      // Contoured silicone pad that cradles the porcelain demitasse cup wall (`x = 0.13 m`).
      const cradlePad = new THREE.Mesh(
        new THREE.BoxGeometry(0.028, 0.006, 0.036),
        siliconePadMat,
      );
      cradlePad.position.set(0.13, -signY * 0.002, 0);

      const frontLip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0022, 0.0022, 0.034, 12),
        brassAccentMat,
      );
      frontLip.position.set(0.141, -signY * 0.004, 0);

      fingerGroup.add(carriage, armBeam, cradlePad, frontLip);
    }
    enableShadows(this.gripper);
  }

  async load(
    reference: ApplianceVisual = {
      url: this.appliance === "linea" ? modelUrl : eagleUrl,
      sha256: this.appliance === "linea" ? LINEA_GLB_SHA256 : EAGLE_GLB_SHA256,
    },
  ): Promise<void> {
    const [loadedMachine, loadedRobot] = await Promise.all([
      loadVisual(reference.url, reference.sha256, this.loadAbort.signal),
      loadRobotVisual("fairino-fr10", this.loadAbort.signal),
    ]);
    if (this.lifecycle === "disposed") {
      loadedMachine.traverse(disposePhysicsObject);
      loadedRobot.traverse(disposePhysicsObject);
      return;
    }
    if (this.loadedVisual !== null) {
      this.model.remove(this.loadedVisual);
      this.loadedVisual.traverse(disposePhysicsObject);
    }
    if (this.loadedRobot !== null) {
      this.robot.remove(this.loadedRobot);
      this.loadedRobot.traverse(disposePhysicsObject);
    }
    this.loadedVisual = loadedMachine;
    loadedMachine.traverse(hideStaticTimer);
    enableShadows(loadedMachine);
    this.model.add(loadedMachine);

    const pivots = fr10Pivots(loadedRobot);
    enableShadows(loadedRobot);
    loadedRobot.rotation.x = Math.PI / 2;
    this.loadedRobot = loadedRobot;
    this.robot.add(loadedRobot);
    this.pivots = pivots;

    this.lifecycle = "ready";
    const latest = this.batchSamples.at(-1) ?? this.displayedFrame;
    if (latest !== null && latest !== undefined) {
      this.applySample(latest, performance.now());
    }
    this.host.requestFrame();
  }

  setCameraPreset(preset: EspressoCameraPreset): void {
    this.host.moveCameraTo(CAMERA_PRESETS[preset]);
  }

  setFrame(sample: ApplianceSample): void {
    this.setSamples([sample]);
  }

  /** Plays through recorded samples smoothly at 60 FPS. */
  setSamples(samples: readonly ApplianceSample[]): void {
    const latest = samples.at(-1);
    if (latest === undefined) return;
    if (
      this.displayedFrame === null ||
      samples.length === 1 ||
      latest.timeSeconds <= this.displayedFrame.timeSeconds ||
      latest.timeSeconds - this.displayedFrame.timeSeconds > 4.0
    ) {
      this.batchSamples = [latest];
      this.displayedFrame = latest;
      this.transitionStartedAt = performance.now();
      this.applySample(latest, this.transitionStartedAt);
      this.host.requestFrame();
      return;
    }
    this.batchSamples = [this.displayedFrame, ...samples];
    this.transitionStartedAt = performance.now();
    this.host.requestFrame();
  }

  private applySample(sample: ApplianceSample, now: number): void {
    this.displayedFrame = sample;
    for (const cup of this.cupVisuals) cup.group.visible = true;
    this.scene.updateMatrixWorld(true);
    this.model.traverse(applyRecordedAppliancePose.bind(null, sample));

    // 1. Update LED shot timers on the group heads.
    for (const display of sample.displays) {
      if (display.name !== "left_timer" && display.name !== "right_timer")
        continue;
      let plane = this.displayPlanes.get(display.name);
      if (!plane) {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 128;
        plane = new THREE.Mesh(
          new THREE.PlaneGeometry(display.width, display.height).rotateX(
            -Math.PI / 2,
          ),
          new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas) }),
        );
        this.displayPlanes.set(display.name, plane);
        this.scene.add(plane);
      }
      const canvas: unknown = plane.material.map?.image;
      if (!(canvas instanceof HTMLCanvasElement))
        throw new Error("Invalid display canvas.");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing display context.");
      context.fillStyle = "#090b0b";
      context.fillRect(0, 0, 256, 128);
      context.fillStyle = "#ee9c32";
      context.font = "90px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(display.text, 128, 64);
      if (plane.material.map) plane.material.map.needsUpdate = true;
      const p = display.pose;
      plane.position.set(p[0], p[2], -p[1]);
      plane.quaternion.set(p[4], p[6], -p[5], p[3]);
    }

    // 2. Parse live controller telemetry for fluid volume, crema, spout streams, and FR10 Cobot tracking.
    const telemetry = parseEspressoLiveTelemetry(sample);
    const prefix = this.appliance === "linea" ? "lcs" : "eo";
    const cupRadius = this.appliance === "linea" ? 0.032 : 0.027;
    const defaultLeftCupZUp: Vec3 =
      this.appliance === "linea"
        ? [-0.12, -0.195 - telemetry.leftCup.travelM, 0.225]
        : [-0.094, -0.17 - telemetry.leftCup.travelM, 0.168];
    const leftCupPose = sample.bodies.get(`${prefix}_left_cup`);
    const cupZUp: Vec3 =
      leftCupPose && leftCupPose.length >= 3
        ? [leftCupPose[0]!, leftCupPose[1]!, leftCupPose[2]!]
        : defaultLeftCupZUp;

    // 3. Update porcelain cup interior liquid, tiger-striped crema meniscus, and surface ripples.
    const leftCupVisual = this.cupVisuals[0];
    const effectiveCupMassG =
      telemetry.leftCup.massG > 0.1
        ? telemetry.leftCup.massG
        : telemetry.servedG > 0 && telemetry.leftCup.travelM > 0.12
          ? Math.min(36, telemetry.servedG)
          : 0;
    if (leftCupVisual !== undefined) {
      const massG = effectiveCupMassG;
      const dispensing = telemetry.leftShot.kind === "dispensing";
      const hasLiquid = massG > 0.25 || dispensing;
      leftCupVisual.liquidBody.visible = hasLiquid;
      leftCupVisual.cremaDisc.visible = hasLiquid;
      leftCupVisual.meniscusRing.visible = hasLiquid;

      if (hasLiquid) {
        // Tapered thick-walled demitasse interior fills non-linearly from narrow base to wide rim.
        const linearFill = THREE.MathUtils.clamp(massG / 36, 0.05, 1.04);
        const fillFraction = Math.pow(linearFill, 0.68);
        const minY = -0.006;
        const maxY = 0.026;
        const topY = THREE.MathUtils.lerp(minY + 0.004, maxY, fillFraction);
        const bottomY = -0.026;
        const height = Math.max(0.004, topY - bottomY);
        leftCupVisual.liquidBody.scale.set(1, height, 1);
        leftCupVisual.liquidBody.position.y = bottomY + height / 2;
        leftCupVisual.cremaDisc.position.y = topY + 0.0004;
        leftCupVisual.meniscusRing.position.y = topY + 0.0006;

        for (const [idx, ripple] of leftCupVisual.ripples.entries()) {
          ripple.visible = dispensing;
          if (dispensing) {
            const sign = idx === 0 ? -1 : 1;
            const phase = (((now * 0.0038 + idx * 0.5) % 1) + 1) % 1;
            const scale = 0.65 + phase * 1.35;
            ripple.position.set(sign * 0.0045, topY + 0.0008, 0);
            ripple.scale.set(scale, scale, 1);
            ripple.material.opacity = (1 - phase) * 0.72;
          }
        }
      } else {
        for (const ripple of leftCupVisual.ripples) ripple.visible = false;
      }

      const steaming = massG > 1.5 && telemetry.leftCup.temperatureC > 48;
      for (const [idx, wisp] of leftCupVisual.steamWisps.entries()) {
        wisp.visible = steaming;
        if (steaming) {
          const cycle =
            (((now * 0.00045 + idx / leftCupVisual.steamWisps.length) % 1) +
              1) %
            1;
          wisp.position.set(
            Math.sin(now * 0.002 + idx * 2.1) * 0.004,
            0.026 + cycle * 0.055,
            Math.cos(now * 0.0017 + idx * 1.6) * 0.004,
          );
          const s = 0.68 + cycle * 0.85;
          wisp.scale.set(s, s, 1);
          wisp.material.opacity = Math.sin(cycle * Math.PI) * 0.18;
        }
      }
    }

    // 3b. Update multi-order served cups on brass coasters (Slots 1..3) and spent pucks in knock-box.
    const servedOrders = Math.min(
      4,
      Math.floor((telemetry.servedG + 0.5) / 36),
    );
    const activeCupRestingServed =
      telemetry.leftCup.position === "removed" &&
      telemetry.leftCup.travelM > 0.14 &&
      servedOrders > 0;
    const trayServedCups = activeCupRestingServed
      ? Math.max(0, servedOrders - 1)
      : Math.min(3, servedOrders);
    for (const [slotIdx, servedCup] of this.servedCupVisuals.entries()) {
      const visible = slotIdx < trayServedCups;
      servedCup.group.visible = visible;
      if (visible) {
        for (const [idx, wisp] of servedCup.steamWisps.entries()) {
          wisp.visible = true;
          const cycle =
            (((now * 0.00042 +
              slotIdx * 0.27 +
              idx / servedCup.steamWisps.length) %
              1) +
              1) %
            1;
          wisp.position.set(
            Math.sin(now * 0.0018 + idx * 2.1 + slotIdx) * 0.004,
            0.026 + cycle * 0.052,
            Math.cos(now * 0.0015 + idx * 1.6 + slotIdx) * 0.004,
          );
          const s = 0.65 + cycle * 0.82;
          wisp.scale.set(s, s, 1);
          wisp.material.opacity = Math.sin(cycle * Math.PI) * 0.16;
        }
      }
    }
    for (const [puckIdx, puck] of this.spentPucks.entries()) {
      puck.visible = puckIdx < servedOrders;
    }

    // 4. Update dual mouse-tail espresso streams from the left portafilter spouts into the cup.
    const dispensing = telemetry.leftShot.kind === "dispensing";
    const spoutBaseY = this.appliance === "linea" ? 0.285 : 0.246;
    const fillFractionForStream = Math.pow(
      THREE.MathUtils.clamp(effectiveCupMassG / 36, 0.05, 1),
      0.68,
    );
    const cupSurfaceWorldY =
      cupZUp[2] + THREE.MathUtils.lerp(-0.002, 0.026, fillFractionForStream);
    const streamDrop = Math.max(0.014, spoutBaseY - cupSurfaceWorldY);
    const elapsedS = telemetry.leftShot.elapsedS;
    if (dispensing) {
      // Evolve stream color from dark ristretto (0-3s) -> rich hazelnut heart (3-13s) -> golden crema blonde (13-18s).
      const ristretto = new THREE.Color(0x280902);
      const heart = new THREE.Color(0x7c310c);
      const blonde = new THREE.Color(0xb86822);
      if (elapsedS < 3.5) {
        this.spoutStreamMaterial.color
          .copy(ristretto)
          .lerp(heart, elapsedS / 3.5);
      } else {
        this.spoutStreamMaterial.color
          .copy(heart)
          .lerp(blonde, Math.min(1, (elapsedS - 3.5) / 14.5));
      }
    }
    for (const streamMesh of this.spoutStreams) {
      streamMesh.visible = dispensing;
      if (dispensing) {
        streamMesh.position.set(cupZUp[0], cupSurfaceWorldY, -cupZUp[1]);
        streamMesh.scale.set(1, streamDrop / 0.056, 1);
      }
    }

    // Hot water stream if active in appliance rehearsal.
    const hwActive = telemetry.hotWater.kind === "dispensing";
    this.hotWaterStream.visible = hwActive;
    if (hwActive) {
      const hwX = this.appliance === "linea" ? 0.215 : -0.218;
      const hwY = this.appliance === "linea" ? 0.265 : 0.215;
      const hwZ = this.appliance === "linea" ? 0.195 : 0.179;
      this.hotWaterStream.position.set(hwX, hwY, hwZ);
    }

    // 5. Solve FAIRINO FR10 Cobot arm & parallel gripper trajectory from accepted sample state.
    this.updateCobotKinematics(telemetry, cupZUp, cupRadius);
  }

  /**
   * Computes the FAIRINO FR10 Cobot end-effector target in Z-up station coordinates:
   * - During `PlaceCup` & `RemoveCup`: cradles the active porcelain demitasse cup along its
   *   MuJoCo slide trajectory (`my = -0.375 <-> -0.195`).
   * - At shot start (`elapsed_s < 1.1 s`): lifts to press the group manual brew button
   *   (`lcs_left_dose_3` / `eo_left_dose_3`) and retracts to an observation hover pose.
   * - During `Brew`: observes the extraction from a clear barista hover pose, then descends
   *   at `elapsed_s > 16.8 s` to grasp the filled cup for service removal.
   */
  private updateCobotKinematics(
    telemetry: EspressoLiveTelemetry,
    cupZUp: Vec3,
    cupRadius: number,
  ): void {
    const buttonZUp: Vec3 =
      this.appliance === "linea"
        ? [-0.08, -0.248, 0.415]
        : [-0.071, -0.216, 0.345];
    const hoverZUp: Vec3 =
      this.appliance === "linea"
        ? [-0.15, -0.34, 0.315]
        : [-0.13, -0.31, 0.265];

    const closedFingerOpening = Math.max(0.012, cupRadius - 0.0135);
    const openFingerOpening = closedFingerOpening + 0.015;

    let targetTool: Vec3 = [cupZUp[0], cupZUp[1], cupZUp[2] + 0.002];
    let fingerOpening = closedFingerOpening;

    const { leftCup, leftShot } = telemetry;
    const smooth = (u: number): number => {
      const c = THREE.MathUtils.clamp(u, 0, 1);
      return c * c * (3 - 2 * c);
    };
    const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => [
      THREE.MathUtils.lerp(a[0], b[0], t),
      THREE.MathUtils.lerp(a[1], b[1], t),
      THREE.MathUtils.lerp(a[2], b[2], t),
    ];

    if (leftShot.kind === "dispensing") {
      const e = leftShot.elapsedS;
      const cupGrasp: Vec3 = [cupZUp[0], cupZUp[1], cupZUp[2] + 0.002];
      if (e < 0.45) {
        // Press the manual brew button on the left group head.
        const t = smooth(e / 0.45);
        targetTool = lerpVec(
          buttonZUp,
          [buttonZUp[0], buttonZUp[1] + 0.008, buttonZUp[2]],
          t,
        );
        fingerOpening = 0.008;
      } else if (e < 1.6) {
        // Retract smoothly from the brew button to the barista observation hover pose.
        const t = smooth((e - 0.45) / 1.15);
        targetTool = lerpVec(buttonZUp, hoverZUp, t);
        fingerOpening = THREE.MathUtils.lerp(0.008, openFingerOpening, t);
      } else if (e < leftShot.durationS - 1.2) {
        // Hold steady in observation hover while the 9-bar shot extracts into the cup.
        targetTool = hoverZUp;
        fingerOpening = openFingerOpening;
      } else {
        // Descend back to the drip grate and close fingers around the filled cup.
        const t = smooth((e - (leftShot.durationS - 1.2)) / 1.2);
        targetTool = lerpVec(hoverZUp, cupGrasp, t);
        fingerOpening = THREE.MathUtils.lerp(
          openFingerOpening,
          closedFingerOpening,
          t,
        );
      }
    } else if (
      leftCup.position === "placed" &&
      leftCup.travelM < 0.004 &&
      leftShot.kind === "idle"
    ) {
      // Cup has just settled on the drip grate (`PlaceCup` final 0.5 s): release and rise to brew button.
      const settleProgress = smooth(1 - leftCup.travelM / 0.004);
      const cupGrasp: Vec3 = [cupZUp[0], cupZUp[1], cupZUp[2] + 0.002];
      targetTool = lerpVec(cupGrasp, buttonZUp, settleProgress * 0.85);
      fingerOpening = THREE.MathUtils.lerp(
        closedFingerOpening,
        0.008,
        settleProgress,
      );
    } else if (leftCup.position === "removed" && leftCup.travelM >= 0.176) {
      // Prepared or completed on the front service mat: cradle gently with slightly relaxed fingers.
      const releaseFactor = smooth((leftCup.travelM - 0.176) / 0.004);
      targetTool = [
        cupZUp[0],
        cupZUp[1] - releaseFactor * 0.012,
        cupZUp[2] + 0.002 + releaseFactor * 0.008,
      ];
      fingerOpening = THREE.MathUtils.lerp(
        closedFingerOpening,
        openFingerOpening,
        releaseFactor * 0.65,
      );
    } else {
      // Active cup transfer (`PlaceCup` or `RemoveCup` slide along `my`): firm grasp on the cup.
      targetTool = [cupZUp[0], cupZUp[1], cupZUp[2] + 0.002];
      fingerOpening = closedFingerOpening;
    }

    reachFr10(ARM, this.pivots, this.gripper, targetTool, Math.PI * 0.44);
    openFr10Fingers(this.leftFinger, this.rightFinger, fingerOpening);
  }

  /** Plays a batch of samples between two ticks; true while it plays. */
  private step(now: number): boolean {
    if (this.batchSamples.length > 1) {
      this.batchSamples = playSampleBatch(
        this.batchSamples,
        this.transitionStartedAt,
        now,
        INTERPOLATION_MS,
        interpolateApplianceSample,
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
    this.cremaTexture.dispose();
    this.host.dispose();
  }
}

/**
 * Thick-walled Italian glazed porcelain demitasse cup with a tapered foot, rolled lip,
 * front ear handle, and interior espresso + tiger-striped crema meshes.
 */
function createPorcelainCup(
  label: string,
  appliance: EspressoModel,
  cremaTexture: THREE.CanvasTexture,
): CupVisual {
  const group = new THREE.Group();
  const outerRadius = appliance === "linea" ? 0.032 : 0.027;
  const innerRadius = outerRadius - 0.0038;
  group.name = `${appliance === "linea" ? "lcs" : "eo"}_${label}_cup`;

  const porcelainMat = new THREE.MeshPhysicalMaterial({
    color: 0xf5f3ec,
    roughness: 0.14,
    metalness: 0.0,
    clearcoat: 0.9,
    clearcoatRoughness: 0.08,
  });

  // Sculpted thick-walled porcelain cup profile (`y = -0.035 .. +0.032 m`).
  const cupProfile = [
    new THREE.Vector2(0.0001, -0.035),
    new THREE.Vector2(outerRadius * 0.72, -0.035),
    new THREE.Vector2(outerRadius * 0.76, -0.03),
    new THREE.Vector2(outerRadius * 0.88, -0.012),
    new THREE.Vector2(outerRadius, 0.029),
    new THREE.Vector2(outerRadius + 0.0008, 0.0315),
    new THREE.Vector2(innerRadius + 0.0006, 0.032),
    new THREE.Vector2(innerRadius, 0.029),
    new THREE.Vector2(innerRadius * 0.84, -0.022),
    new THREE.Vector2(0.0001, -0.0285),
  ];
  const cupMesh = new THREE.Mesh(
    new THREE.LatheGeometry(cupProfile, 48),
    porcelainMat,
  );
  cupMesh.castShadow = true;
  cupMesh.receiveShadow = true;

  // Classic demitasse loop ear handle on the `+Z` (Three.js front) face so left/right gripper jaws clear it.
  const handleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.018, outerRadius - 0.001),
    new THREE.Vector3(0, 0.02, outerRadius + 0.013),
    new THREE.Vector3(0, 0.0, outerRadius + 0.015),
    new THREE.Vector3(0, -0.016, outerRadius + 0.009),
    new THREE.Vector3(0, -0.018, outerRadius * 0.84),
  ]);
  const handleMesh = new THREE.Mesh(
    new THREE.TubeGeometry(handleCurve, 20, 0.0034, 12, false),
    porcelainMat,
  );
  handleMesh.castShadow = true;

  // Accent saucer/coaster lip ring at the base foot.
  const footBand = new THREE.Mesh(
    new THREE.CylinderGeometry(
      outerRadius * 0.75,
      outerRadius * 0.73,
      0.003,
      36,
    ),
    new THREE.MeshStandardMaterial({
      color: 0xd6cfc2,
      roughness: 0.55,
    }),
  );
  footBand.position.y = -0.0335;

  // Interior dark-roast espresso liquid column (`height = 1` scaled dynamically).
  const liquidBody = new THREE.Mesh(
    new THREE.CylinderGeometry(innerRadius * 0.94, innerRadius * 0.82, 1, 40),
    new THREE.MeshPhysicalMaterial({
      color: 0x1a0702,
      roughness: 0.08,
      metalness: 0.02,
      clearcoat: 0.92,
    }),
  );
  liquidBody.visible = false;

  // Golden-hazelnut tiger-striped crema surface disc.
  const cremaDisc = new THREE.Mesh(
    new THREE.CircleGeometry(innerRadius * 0.95, 44).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      map: cremaTexture,
      roughness: 0.36,
      metalness: 0.02,
    }),
  );
  cremaDisc.visible = false;

  // Capillary golden crema meniscus ring against the inner porcelain wall.
  const meniscusRing = new THREE.Mesh(
    new THREE.RingGeometry(innerRadius * 0.84, innerRadius * 0.96, 44).rotateX(
      -Math.PI / 2,
    ),
    new THREE.MeshBasicMaterial({
      color: 0xd88b3a,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide,
    }),
  );
  meniscusRing.visible = false;

  // Dual surface ripples where the two portafilter spout streams enter the crema.
  const ripples = [0, 1].map(() => {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.0018, 0.0044, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xf2ba72,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
      }),
    );
    ring.visible = false;
    return ring;
  });

  // Rising aromatic steam wisps above the hot espresso cup.
  const steamWisps = [0, 1, 2].map(() => {
    const wisp = new THREE.Mesh(
      new THREE.RingGeometry(0.005, 0.015, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xf7f5f0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    wisp.visible = false;
    return wisp;
  });

  group.add(
    cupMesh,
    handleMesh,
    footBand,
    liquidBody,
    cremaDisc,
    meniscusRing,
    ...ripples,
    ...steamWisps,
  );
  return {
    group,
    liquidBody,
    cremaDisc,
    meniscusRing,
    ripples,
    steamWisps,
    innerRadius,
  };
}

function hideStaticTimer(object: THREE.Object3D): void {
  if (
    object.name.startsWith("Inactive_shot_timer") ||
    object.name.endsWith("group_timer")
  )
    object.visible = false;
}
