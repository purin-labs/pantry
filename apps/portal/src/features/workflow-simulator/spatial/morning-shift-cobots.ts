import { floorPlanWorkspace } from "../floor-plan-workspace";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { SynchronizedCobotTransferState } from "../../production-run/morning-shift-appliances";
import { type BakeryFloorPlanId } from "@seams/production-simulation/floor/bakery-room";

import {
  buildArticulatedHumanWorker,
  poseArticulatedHumanWorker,
  type ArticulatedHumanWorker,
} from "./human-worker-figure";
import { disposePhysicsObject } from "./physics-model";
import { enableShadowMeshes } from "./scene-lighting";
import { ensureLivingAssetsLoaded } from "./living-asset-loader";

type Vec3 = readonly [number, number, number];

const ESPRESSO_STATION_ORIGIN: Vec3 = [1.09, 0.85, 2.04];
const ESPRESSO_BARISTA_LOCAL_POS: Vec3 = [
  -0.08,
  -ESPRESSO_STATION_ORIGIN[1],
  0.62,
];

const POUR_OVER_STATION_ORIGIN: Vec3 = [-1.85, 0, 2.0];

function smoothStep(u: number): number {
  const c = THREE.MathUtils.clamp(u, 0, 1);
  return c * c * (3 - 2 * c);
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    THREE.MathUtils.lerp(a[0], b[0], t),
    THREE.MathUtils.lerp(a[1], b[1], t),
    THREE.MathUtils.lerp(a[2], b[2], t),
  ];
}

class EspressoBaristaRig {
  readonly root = new THREE.Group();
  private readonly zUpRoot = new THREE.Group();
  private readonly barista: ArticulatedHumanWorker;
  private readonly activeCup = new THREE.Group();
  private readonly activeLiquid: THREE.Mesh;
  private readonly spoutStream: THREE.Mesh;
  private readonly portafilter = new THREE.Group();
  private readonly servedCups: readonly THREE.Group[];
  private readonly statusRing: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshStandardMaterial
  >;

  constructor() {
    this.root.name = "espresso-cell";
    this.root.position.set(...ESPRESSO_STATION_ORIGIN);
    this.zUpRoot.rotation.x = -Math.PI / 2;

    this.barista = buildArticulatedHumanWorker(1, 0xb5543c);
    this.barista.root.position.set(...ESPRESSO_BARISTA_LOCAL_POS);
    this.root.add(this.barista.root);

    this.statusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.24, 32),
      new THREE.MeshStandardMaterial({
        color: 0x64748b,
        emissive: 0x64748b,
        emissiveIntensity: 0.25,
        side: THREE.DoubleSide,
      }),
    );
    this.statusRing.position.set(
      ESPRESSO_BARISTA_LOCAL_POS[0],
      -ESPRESSO_BARISTA_LOCAL_POS[2],
      -0.83,
    );
    this.statusRing.userData.excludeFromAo = true;
    this.zUpRoot.add(this.statusRing);

    const porcelainMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.2,
    });
    const cremaMat = new THREE.MeshStandardMaterial({
      color: 0xb86824,
      emissive: 0x7c310c,
      emissiveIntensity: 0.25,
      roughness: 0.3,
    });
    const cupShell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.025, 0.058, 24),
      porcelainMat,
    );
    this.activeLiquid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.023, 0.038, 24),
      cremaMat,
    );
    this.activeLiquid.position.y = 0.008;
    this.activeLiquid.visible = false;
    this.activeCup.add(cupShell, this.activeLiquid);
    this.root.add(this.activeCup);

    this.spoutStream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.003, 0.065, 16),
      new THREE.MeshStandardMaterial({
        color: 0x7c310c,
        emissive: 0xb86824,
        emissiveIntensity: 0.6,
      }),
    );
    this.spoutStream.visible = false;
    this.root.add(this.spoutStream);

    const pfBasket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.029, 0.028, 20),
      new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.3,
        metalness: 0.75,
      }),
    );
    const pfPuck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.026, 0.012, 20),
      new THREE.MeshStandardMaterial({
        color: 0x3b2010,
        roughness: 0.75,
      }),
    );
    pfPuck.position.y = 0.01;
    const pfHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.012, 0.12, 14).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.5,
      }),
    );
    pfHandle.position.set(0, 0, 0.082);
    this.portafilter.add(pfBasket, pfPuck, pfHandle);
    this.root.add(this.portafilter);

    this.servedCups = [-0.03, 0.055, 0.14].map((slotX) => {
      const served = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.024, 0.054, 20),
        porcelainMat,
      );
      const top = new THREE.Mesh(
        new THREE.CylinderGeometry(0.027, 0.025, 0.036, 20),
        cremaMat,
      );
      top.position.y = 0.008;
      served.add(body, top);
      served.position.set(slotX, 0.225, 0.375);
      served.visible = false;
      this.root.add(served);
      return served;
    });

    this.root.add(this.zUpRoot);
    this.update({
      cellId: "espresso-cell",
      robot: "fairino-fr10",
      status: "idle",
      taskId: null,
      label: "Barista espresso station ready",
      step: 0,
      committedSeconds: 0,
      completedTransfers: 0,
      totalTransfers: 2,
      progress: 0,
      phase: "ready",
      jointAnglesRad: [0.42, -1.24, -1.52, -3.52, -2.53, 1.571],
      endEffectorPoseMeters: [-0.12, -0.387, 0.235],
      gripperWidthMm: 48,
      gripperForceNewtons: 0,
      payloadMassKg: 0,
      shoulderTorqueNm: 17.2,
      cascadeHold: null,
    });
  }

  anchor(): THREE.Vector3 {
    return new THREE.Vector3(
      this.root.position.x + ESPRESSO_BARISTA_LOCAL_POS[0],
      1.85,
      this.root.position.z + ESPRESSO_BARISTA_LOCAL_POS[2],
    );
  }

  update(transfer: SynchronizedCobotTransferState): void {
    const frontCupZUp: Vec3 = [-0.12, -0.375, 0.225];
    const grateCupZUp: Vec3 = [-0.12, -0.195, 0.225];
    const groupPfZUp: Vec3 = [-0.12, -0.195, 0.285];
    const grinderPfZUp: Vec3 = [0.08, -0.26, 0.235];
    const tampPfZUp: Vec3 = [-0.02, -0.34, 0.215];

    let cupZUp: Vec3 = frontCupZUp;
    let pfZUp: Vec3 = groupPfZUp;
    let pfLockYaw = 0;
    let dispensing = false;
    let liquidFill = 0;

    if (transfer.status === "cascade-held") {
      cupZUp = frontCupZUp;
      pfZUp = groupPfZUp;
    } else if (transfer.status === "executing") {
      const p = THREE.MathUtils.clamp(transfer.progress, 0, 1);
      pfZUp = groupPfZUp;
      if (p < 0.14) {
        const t = smoothStep(p / 0.14);
        cupZUp = lerpVec(frontCupZUp, grateCupZUp, t);
      } else if (p < 0.22) {
        const t = smoothStep((p - 0.14) / 0.08);
        cupZUp = grateCupZUp;
        dispensing = t > 0.6;
        liquidFill = 0.1;
      } else if (p < 0.82) {
        cupZUp = grateCupZUp;
        dispensing = true;
        liquidFill = THREE.MathUtils.clamp((p - 0.2) / 0.62, 0.1, 1);
      } else {
        const t = smoothStep((p - 0.82) / 0.18);
        cupZUp = lerpVec(grateCupZUp, frontCupZUp, t);
        liquidFill = 1;
      }
    } else if (transfer.status === "handoff") {
      // Barista portafilter dose, tamp, and grouphead lock trajectory
      const p = THREE.MathUtils.clamp(transfer.progress, 0, 1);
      cupZUp = frontCupZUp;
      if (p < 0.35) {
        const t = smoothStep(p / 0.35);
        pfZUp = lerpVec(groupPfZUp, grinderPfZUp, t);
        pfLockYaw = THREE.MathUtils.lerp(-0.45, 0, t);
      } else if (p < 0.7) {
        const t = smoothStep((p - 0.35) / 0.35);
        pfZUp = lerpVec(grinderPfZUp, tampPfZUp, t);
      } else {
        const t = smoothStep((p - 0.7) / 0.3);
        pfZUp = lerpVec(tampPfZUp, groupPfZUp, t);
        pfLockYaw = THREE.MathUtils.lerp(-0.48, 0, t);
      }
    } else if (transfer.completedTransfers > 0) {
      cupZUp = frontCupZUp;
      pfZUp = groupPfZUp;
      liquidFill = 1;
    }

    const haloHex =
      transfer.status === "cascade-held"
        ? 0xef4444
        : transfer.status === "executing"
          ? 0xf59e0b
          : transfer.status === "handoff"
            ? 0x38bdf8
            : transfer.completedTransfers > 0
              ? 0x22c55e
              : 0x64748b;
    this.statusRing.material.color.setHex(haloHex);
    this.statusRing.material.emissive.setHex(haloHex);
    this.statusRing.material.emissiveIntensity =
      transfer.status === "executing" || transfer.status === "cascade-held"
        ? 0.9
        : 0.35;

    this.activeCup.position.set(cupZUp[0], cupZUp[2], -cupZUp[1]);
    this.portafilter.position.set(pfZUp[0], pfZUp[2], -pfZUp[1]);
    this.portafilter.rotation.set(0, pfLockYaw, 0);
    this.activeLiquid.visible = liquidFill > 0.02;
    if (this.activeLiquid.visible) {
      this.activeLiquid.scale.set(1, Math.max(0.15, liquidFill), 1);
    }
    this.spoutStream.visible = dispensing;
    if (dispensing) {
      this.spoutStream.position.set(
        grateCupZUp[0],
        grateCupZUp[2] + 0.042,
        -grateCupZUp[1],
      );
    }
    for (const [idx, served] of this.servedCups.entries()) {
      served.visible = idx < transfer.completedTransfers;
    }

    const isWorking =
      transfer.status === "executing" || transfer.status === "handoff";
    const yawOffset =
      transfer.status === "handoff"
        ? pfLockYaw * 0.32
        : (cupZUp[0] + 0.12) * 0.6;
    poseArticulatedHumanWorker(this.barista, {
      facingYawRad: Math.PI + yawOffset,
      walking: false,
      working: isWorking,
      carrying: false,
      phase: transfer.progress * Math.PI * 8 + 0.6,
    });
  }
}

class PourOverBaristaRig {
  readonly root = new THREE.Group();
  private readonly zUpRoot = new THREE.Group();
  private readonly barista: ArticulatedHumanWorker;
  private readonly kettle = new THREE.Group();
  private readonly stream: THREE.Mesh;
  private readonly dripperSlurry: THREE.Mesh;
  private readonly serverBeverage: THREE.Mesh;
  private readonly statusRing: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshStandardMaterial
  >;

  constructor() {
    this.root.name = "pour-over-cell";
    this.root.position.set(...POUR_OVER_STATION_ORIGIN);
    this.zUpRoot.rotation.x = -Math.PI / 2;

    this.barista = buildArticulatedHumanWorker(2, 0x4f8a4b);
    this.barista.root.position.set(-0.02, 0, 0);
    this.root.add(this.barista.root);

    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x8c9aa0,
      roughness: 0.45,
      metalness: 0.35,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.38,
      metalness: 0.45,
    });
    const porcelainMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.2,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xdbeafe,
      roughness: 0.15,
      transparent: true,
      opacity: 0.48,
    });

    // Stainless pour-over bench (`x = 0.62`).
    const boxes: readonly Readonly<{
      size: Vec3;
      pose: Vec3;
    }>[] = [
      { size: [0.6, 0.84, 0.04], pose: [0.62, 0, 0.78] },
      { size: [0.05, 0.05, 0.76], pose: [0.36, -0.38, 0.38] },
      { size: [0.05, 0.05, 0.76], pose: [0.36, 0.38, 0.38] },
      { size: [0.05, 0.05, 0.76], pose: [0.88, -0.38, 0.38] },
      { size: [0.05, 0.05, 0.76], pose: [0.88, 0.38, 0.38] },
    ];
    for (const item of boxes) {
      const bevel = Math.min(0.008, Math.min(...item.size) * 0.35);
      const mesh = new THREE.Mesh(
        new RoundedBoxGeometry(
          item.size[0],
          item.size[1],
          item.size[2],
          3,
          bevel,
        ),
        steelMat,
      );
      mesh.position.set(item.pose[0], item.pose[1], item.pose[2]);
      this.zUpRoot.add(mesh);
    }

    this.statusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.25, 32),
      new THREE.MeshStandardMaterial({
        color: 0x64748b,
        emissive: 0x64748b,
        emissiveIntensity: 0.25,
        side: THREE.DoubleSide,
      }),
    );
    this.statusRing.position.set(-0.02, 0, 0.02);
    this.statusRing.userData.excludeFromAo = true;
    this.zUpRoot.add(this.statusRing);

    // Kettle base pad and Acaia brew scale on the bench top (`z = 0.80`).
    const kettleBase = new THREE.Mesh(
      new RoundedBoxGeometry(0.15, 0.15, 0.025, 3, 0.005),
      darkMat,
    );
    kettleBase.position.set(0.62, -0.22, 0.812);
    const scaleBase = new THREE.Mesh(
      new RoundedBoxGeometry(0.16, 0.16, 0.028, 3, 0.005),
      darkMat,
    );
    scaleBase.position.set(0.62, 0.17, 0.814);
    this.zUpRoot.add(kettleBase, scaleBase);

    // KINTO glass server (`[0.62, 0.17, 0.83]`) and Kuemon porcelain dripper (`[0.62, 0.17, 0.93]`).
    const serverShell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, 0.105, 28).rotateX(Math.PI / 2),
      glassMat,
    );
    serverShell.position.set(0.62, 0.17, 0.88);
    this.serverBeverage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.048, 0.048, 0.075, 28).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x5c1b07,
        emissive: 0x3b1808,
        emissiveIntensity: 0.25,
        roughness: 0.15,
      }),
    );
    this.serverBeverage.position.set(0.62, 0.17, 0.865);
    this.serverBeverage.visible = false;

    const dripperCone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.032, 0.082, 28).rotateX(Math.PI / 2),
      porcelainMat,
    );
    dripperCone.position.set(0.62, 0.17, 0.965);
    const coffeeBed = new THREE.Mesh(
      new THREE.CylinderGeometry(0.044, 0.028, 0.035, 24).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3b2010, roughness: 0.75 }),
    );
    coffeeBed.position.set(0.62, 0.17, 0.968);
    this.dripperSlurry = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.034, 0.042, 24).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x6b2f12,
        emissive: 0x451a03,
        emissiveIntensity: 0.35,
        roughness: 0.22,
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.dripperSlurry.position.set(0.62, 0.17, 0.976);
    this.dripperSlurry.visible = false;
    this.zUpRoot.add(
      serverShell,
      this.serverBeverage,
      dripperCone,
      coffeeBed,
      this.dripperSlurry,
    );

    // Fellow Stagg gooseneck kettle (`kettle` group in Z-up).
    const kettleBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.048, 0.056, 0.135, 28).rotateX(Math.PI / 2),
      darkMat,
    );
    kettleBody.position.set(0, 0, 0.068);
    const spout = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.009, 0.13, 16),
      darkMat,
    );
    spout.position.set(0, 0.075, 0.085);
    spout.rotation.x = -0.55;
    this.kettle.add(kettleBody, spout);
    this.zUpRoot.add(this.kettle);

    // Gooseneck water stream into the Kuemon dripper.
    this.stream = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.0025, 0.11, 16).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.75,
        transparent: true,
        opacity: 0.88,
      }),
    );
    this.stream.visible = false;
    this.zUpRoot.add(this.stream);

    this.root.add(this.zUpRoot);
    this.update({
      cellId: "pour-over-cell",
      robot: "fairino-fr10",
      status: "idle",
      taskId: null,
      label: "Barista pour-over station ready",
      step: 0,
      committedSeconds: 0,
      completedTransfers: 0,
      totalTransfers: 1,
      progress: 0,
      phase: "prepared",
      jointAnglesRad: [0.18, -1.12, -1.68, -3.48, -1.39, 1.571],
      endEffectorPoseMeters: [0.44, -0.22, 1.0],
      gripperWidthMm: 44,
      gripperForceNewtons: 0,
      payloadMassKg: 0,
      shoulderTorqueNm: 18.4,
      cascadeHold: null,
    });
  }

  anchor(): THREE.Vector3 {
    return new THREE.Vector3(
      this.root.position.x + 0.3,
      1.95,
      this.root.position.z,
    );
  }

  update(transfer: SynchronizedCobotTransferState): void {
    const standKettleZUp: Vec3 = [0.62, -0.22, 0.83];

    let kettlePos: Vec3 = standKettleZUp;
    let kettleTilt = 0;
    let pouring = false;
    let slurryFill = 0;
    let beverageFill = transfer.completedTransfers > 0 ? 1 : 0;

    if (transfer.status === "cascade-held") {
      kettlePos = standKettleZUp;
    } else if (transfer.status === "executing") {
      const p = THREE.MathUtils.clamp(transfer.progress, 0, 1);
      beverageFill = THREE.MathUtils.clamp(p * 1.15, 0.08, 1);
      const isPourPhase =
        transfer.phase === "pour-1" ||
        transfer.phase === "pour-2" ||
        transfer.phase === "pour-3" ||
        transfer.phase === "pour-4";
      const isRestPhase =
        transfer.phase === "rest-1" ||
        transfer.phase === "rest-2" ||
        transfer.phase === "rest-3";

      if (isPourPhase) {
        const theta = p * 28 * Math.PI;
        const r = 0.022;
        const spiralX = 0.62 + r * Math.cos(theta);
        const spiralY = 0.17 + r * Math.sin(theta);
        kettlePos = [spiralX, spiralY - 0.09, 1.04];
        kettleTilt = -0.38;
        pouring = true;
        slurryFill = 0.85;
        this.stream.position.set(spiralX, spiralY, 1.01);
      } else if (isRestPhase) {
        kettlePos = [0.58, 0.02, 1.0];
        kettleTilt = -0.08;
        slurryFill = 0.45;
      } else {
        // Darcy filter-bed drawdown & return-kettle phase.
        const t = smoothStep(Math.max(0, (p - 0.58) / 0.42));
        kettlePos = lerpVec([0.58, 0.02, 1.0], standKettleZUp, t);
        slurryFill = Math.max(0, 0.55 * Math.exp(-t * 3.2));
      }
    } else if (transfer.status === "handoff") {
      // Filter pre-wet rinse and ground coffee dose trajectory
      const p = THREE.MathUtils.clamp(transfer.progress, 0, 1);
      const t = Math.sin(p * Math.PI);
      kettlePos = lerpVec(standKettleZUp, [0.62, 0.08, 1.02], t);
      kettleTilt = -0.22 * t;
      pouring = p > 0.25 && p < 0.65;
      slurryFill = pouring ? 0.22 : 0;
      if (pouring) this.stream.position.set(0.62, 0.17, 1.01);
    }

    const haloHex =
      transfer.status === "cascade-held"
        ? 0xef4444
        : transfer.status === "executing"
          ? 0xf59e0b
          : transfer.status === "handoff"
            ? 0x38bdf8
            : transfer.completedTransfers > 0
              ? 0x22c55e
              : 0x64748b;
    this.statusRing.material.color.setHex(haloHex);
    this.statusRing.material.emissive.setHex(haloHex);
    this.statusRing.material.emissiveIntensity =
      transfer.status === "executing" || transfer.status === "cascade-held"
        ? 0.9
        : 0.35;

    this.kettle.position.set(kettlePos[0], kettlePos[1], kettlePos[2]);
    this.kettle.rotation.set(kettleTilt, 0, 0);
    this.stream.visible = pouring;
    this.dripperSlurry.visible = slurryFill > 0.05;
    if (this.dripperSlurry.visible) {
      this.dripperSlurry.scale.set(1, 1, Math.max(0.2, slurryFill));
      this.dripperSlurry.position.set(0.62, 0.17, 0.968 + slurryFill * 0.018);
    }
    this.serverBeverage.visible = beverageFill > 0.03;
    if (this.serverBeverage.visible) {
      const h = Math.max(0.15, beverageFill);
      this.serverBeverage.scale.set(1, 1, h);
      this.serverBeverage.position.set(0.62, 0.17, 0.835 + h * 0.035);
    }

    const isWorking =
      transfer.status === "executing" || transfer.status === "handoff";
    poseArticulatedHumanWorker(this.barista, {
      facingYawRad: Math.PI / 2 - kettlePos[1] * 0.45,
      walking: false,
      working: isWorking,
      carrying: pouring,
      phase: transfer.progress * Math.PI * 10 + 1.2,
    });
  }
}

export class MorningShiftCobotLayer {
  readonly root = new THREE.Group();
  private readonly espresso = new EspressoBaristaRig();
  private readonly pourOver = new PourOverBaristaRig();
  private key = "";

  constructor() {
    this.root.name = "morning-shift-cobots";
    this.root.add(this.espresso.root, this.pourOver.root);
    enableShadowMeshes(this.root);
    this.syncPlacements(floorPlanWorkspace.getActivePlan());
  }

  syncPlacements(planId: BakeryFloorPlanId): void {
    const espPose = floorPlanWorkspace.getPose(planId, "espresso-cell");
    this.espresso.root.position.set(
      espPose.x,
      ESPRESSO_STATION_ORIGIN[1],
      espPose.z,
    );
    this.espresso.root.rotation.y = espPose.rotY;

    const poPose = floorPlanWorkspace.getPose(planId, "pour-over-cell");
    this.pourOver.root.position.set(
      poPose.x,
      POUR_OVER_STATION_ORIGIN[1],
      poPose.z,
    );
    this.pourOver.root.rotation.y = poPose.rotY;
    this.key = "";
  }

  async load(signal: AbortSignal): Promise<void> {
    await ensureLivingAssetsLoaded(signal);
    this.key = "";
  }

  cellRoot(cellId: string): THREE.Object3D | null {
    if (cellId === "espresso-cell") return this.espresso.root;
    if (cellId === "pour-over-cell") return this.pourOver.root;
    return null;
  }

  anchor(cellId: string): THREE.Vector3 | null {
    if (cellId === "espresso-cell") return this.espresso.anchor();
    if (cellId === "pour-over-cell") return this.pourOver.anchor();
    return null;
  }

  update(transfers: readonly SynchronizedCobotTransferState[] | null): void {
    const key = JSON.stringify(transfers);
    if (key === this.key) return;
    this.key = key;

    const espressoTransfer = (transfers ?? []).find(
      (t) => t.cellId === "espresso-cell",
    );
    this.espresso.root.visible = espressoTransfer !== undefined;
    if (espressoTransfer !== undefined) {
      this.espresso.update(espressoTransfer);
    }

    const pourOverTransfer = (transfers ?? []).find(
      (t) => t.cellId === "pour-over-cell",
    );
    this.pourOver.root.visible = pourOverTransfer !== undefined;
    if (pourOverTransfer !== undefined) {
      this.pourOver.update(pourOverTransfer);
    }
  }

  dispose(): void {
    this.root.traverse(disposePhysicsObject);
    this.root.clear();
  }
}
