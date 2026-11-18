import * as THREE from "three";
import { buildContactShadowPad } from "./floor-plan-fixtures";
import {
  cloneOwnedLivingSubtree,
  withLivingAssets,
  type LivingAssetTemplates,
} from "./living-asset-loader";

type HumanWorkerPoseOptions = Readonly<{
  facingYawRad: number;
  walking: boolean;
  working: boolean;
  carrying: boolean;
  phase: number;
}>;

export type ArticulatedHumanWorker = Readonly<{
  root: THREE.Group;
  pelvisGroup: THREE.Group;
  spinePivot: THREE.Group;
  neckPivot: THREE.Group;
  leftHipPivot: THREE.Group;
  rightHipPivot: THREE.Group;
  leftKneePivot: THREE.Group;
  rightKneePivot: THREE.Group;
  leftAnklePivot: THREE.Group;
  rightAnklePivot: THREE.Group;
  leftShoulderPivot: THREE.Group;
  rightShoulderPivot: THREE.Group;
  leftElbowPivot: THREE.Group;
  rightElbowPivot: THREE.Group;
  leftWristPivot: THREE.Group;
  rightWristPivot: THREE.Group;
  carriedItemGroup: THREE.Group;
}>;

const WORKER_ACCENT_HEX = [0x3f72af, 0xb5543c, 0x4f8a4b] as const;
const WORKER_SKIN_HEX = [0xe8be9e, 0xd8a47f, 0xf0c8ad] as const;
const WORKER_HAIR_HEX = [0x241c18, 0x4a2f1d, 0x35281e] as const;
const CUSTOMER_COAT_HEX = [0xc29b70, 0x4b6358, 0x3b4d6b, 0x8c584c] as const;
const CUSTOMER_SCARF_HEX = [0xf3ece0, 0xdbe4dd, 0xe8dfd1, 0xf4e3d7] as const;

const PELVIS_REST_Y = 0.84;
const IDENTITY_QUAT = new THREE.Quaternion();
const TMP_QUAT_A = new THREE.Quaternion();
const TMP_QUAT_B = new THREE.Quaternion();
const TMP_VEC = new THREE.Vector3();

const CHEF_ONLY_MESHES = [
  "chef_apron",
  "chef_accent_trim",
  "chef_buttons",
  "chef_thermometer",
  "chef_side_towel",
  "chef_toque",
  "chef_toque_piping",
  "mesh_hair_chef",
] as const;

const VISITOR_ONLY_MESHES = ["customer_scarf", "mesh_hair_visitor"] as const;

type BoundBone = Readonly<{
  bone: THREE.Bone;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  worldBindQuat: THREE.Quaternion;
  worldBindQuatInv: THREE.Quaternion;
  parentWorldBindQuatInv: THREE.Quaternion;
}>;

type FigureAppearanceSpec = Readonly<{
  role: "patissier" | "visitor";
  skinColor: number | string;
  hairColor: number | string;
  accentColor: number | string;
  jacketColor: number | string;
  jacketRoughness: number;
  trimColor: number | string;
}>;

type RigController = {
  syncFromPivots: () => void;
};

const rigControllers = new WeakMap<ArticulatedHumanWorker, RigController>();

function applyPoseQuatToBone(
  bound: BoundBone,
  poseQuat: THREE.Quaternion,
): void {
  bound.bone.quaternion
    .copy(bound.restQuat)
    .multiply(bound.worldBindQuatInv)
    .multiply(poseQuat)
    .multiply(bound.worldBindQuat);
}

function mountRiggedFigureFromTemplates(
  figure: ArticulatedHumanWorker,
  spec: FigureAppearanceSpec,
  templates: LivingAssetTemplates,
): void {
  const sourceArmature = templates.humanScene.getObjectByName("human_armature");
  if (!sourceArmature) return;

  const armature = cloneOwnedLivingSubtree(sourceArmature);
  armature.position.set(0, 0, 0);
  armature.quaternion.identity();
  armature.scale.setScalar(1);
  armature.updateMatrixWorld(true);

  const bones = new Map<string, BoundBone>();
  const skinnedMeshes: THREE.SkinnedMesh[] = [];

  armature.traverse((node) => {
    if (node instanceof THREE.Bone) {
      const worldBindQuat = new THREE.Quaternion();
      node.getWorldQuaternion(worldBindQuat);
      const parentWorldBindQuat = new THREE.Quaternion();
      if (node.parent) node.parent.getWorldQuaternion(parentWorldBindQuat);
      bones.set(node.name, {
        bone: node,
        restPos: node.position.clone(),
        restQuat: node.quaternion.clone(),
        worldBindQuat,
        worldBindQuatInv: worldBindQuat.clone().invert(),
        parentWorldBindQuatInv: parentWorldBindQuat.invert(),
      });
    }
    if (node instanceof THREE.SkinnedMesh) {
      skinnedMeshes.push(node);
    }
    if (
      node instanceof THREE.Mesh &&
      node.material instanceof THREE.MeshStandardMaterial
    ) {
      const mat = node.material;
      switch (mat.name) {
        case "mat_skin":
          mat.color.set(spec.skinColor);
          break;
        case "mat_hair":
          mat.color.set(spec.hairColor);
          break;
        case "mat_accent":
          mat.color.set(spec.accentColor);
          break;
        case "mat_jacket":
          mat.color.set(spec.jacketColor);
          mat.roughness = spec.jacketRoughness;
          break;
        case "mat_jacket_trim":
          mat.color.set(spec.trimColor);
          break;
      }
    }
  });

  const isChef = spec.role === "patissier";
  for (const name of CHEF_ONLY_MESHES) {
    const part = armature.getObjectByName(name);
    if (part) part.visible = isChef;
  }
  for (const name of VISITOR_ONLY_MESHES) {
    const part = armature.getObjectByName(name);
    if (part) part.visible = !isChef;
  }

  const propName = isChef ? "prop_chef_vessel" : "prop_visitor_ballotin";
  const propTemplate = templates.humanScene.getObjectByName(propName);
  if (propTemplate && figure.carriedItemGroup.children.length === 0) {
    const propClone = cloneOwnedLivingSubtree(propTemplate);
    propClone.position.set(0, 0, 0);
    propClone.quaternion.identity();
    figure.carriedItemGroup.add(propClone);
  }

  const jointPairs: ReadonlyArray<readonly [string, THREE.Group]> = [
    ["pelvis", figure.pelvisGroup],
    ["spine", figure.spinePivot],
    ["left_hip", figure.leftHipPivot],
    ["right_hip", figure.rightHipPivot],
    ["left_knee", figure.leftKneePivot],
    ["right_knee", figure.rightKneePivot],
    ["left_ankle", figure.leftAnklePivot],
    ["right_ankle", figure.rightAnklePivot],
    ["left_shoulder", figure.leftShoulderPivot],
    ["right_shoulder", figure.rightShoulderPivot],
    ["left_elbow", figure.leftElbowPivot],
    ["right_elbow", figure.rightElbowPivot],
    ["left_wrist", figure.leftWristPivot],
    ["right_wrist", figure.rightWristPivot],
  ];

  const pelvisBound = bones.get("pelvis");
  const neckBound = bones.get("neck");
  const headBound = bones.get("head");

  const syncFromPivots = (): void => {
    for (const [boneName, pivot] of jointPairs) {
      const bound = bones.get(boneName);
      if (bound !== undefined) {
        applyPoseQuatToBone(bound, pivot.quaternion);
      }
    }
    if (pelvisBound !== undefined) {
      TMP_VEC.set(
        figure.pelvisGroup.position.x,
        figure.pelvisGroup.position.y - PELVIS_REST_Y,
        figure.pelvisGroup.position.z,
      ).applyQuaternion(pelvisBound.parentWorldBindQuatInv);
      pelvisBound.bone.position.copy(pelvisBound.restPos).add(TMP_VEC);
    }
    // Distribute neckPivot rotation organically between cervical neck (40%) and skull base (60%)
    if (neckBound !== undefined) {
      TMP_QUAT_A.slerpQuaternions(
        IDENTITY_QUAT,
        figure.neckPivot.quaternion,
        0.4,
      );
      applyPoseQuatToBone(neckBound, TMP_QUAT_A);
    }
    if (headBound !== undefined) {
      TMP_QUAT_B.slerpQuaternions(
        IDENTITY_QUAT,
        figure.neckPivot.quaternion,
        0.6,
      );
      applyPoseQuatToBone(headBound, TMP_QUAT_B);
    }
    armature.updateMatrixWorld(true);
    for (const sm of skinnedMeshes) {
      sm.skeleton.update();
    }
  };

  figure.root.add(armature);
  rigControllers.set(figure, { syncFromPivots });
  syncFromPivots();
}

function buildRiggedFigure(
  name: string,
  userData: Record<string, unknown>,
  spec: FigureAppearanceSpec,
): ArticulatedHumanWorker {
  const root = new THREE.Group();
  root.name = name;
  root.userData = userData;

  const pelvisGroup = new THREE.Group();
  pelvisGroup.name = "pelvis";
  pelvisGroup.position.set(0, PELVIS_REST_Y, 0);
  root.add(pelvisGroup);

  const buildLegPivots = (side: -1 | 1) => {
    const hipPivot = new THREE.Group();
    hipPivot.name = side < 0 ? "left-hip" : "right-hip";
    hipPivot.position.set(side * 0.086, -0.02, 0);

    const kneePivot = new THREE.Group();
    kneePivot.name = side < 0 ? "left-knee" : "right-knee";
    kneePivot.position.set(0, -0.37, 0.004);
    hipPivot.add(kneePivot);

    const anklePivot = new THREE.Group();
    anklePivot.name = side < 0 ? "left-ankle" : "right-ankle";
    anklePivot.position.set(0, -0.365, -0.004);
    kneePivot.add(anklePivot);

    pelvisGroup.add(hipPivot);
    return { hipPivot, kneePivot, anklePivot };
  };

  const leftLeg = buildLegPivots(-1);
  const rightLeg = buildLegPivots(1);

  const spinePivot = new THREE.Group();
  spinePivot.name = "spine";
  spinePivot.position.set(0, 0.05, 0);
  pelvisGroup.add(spinePivot);

  const neckPivot = new THREE.Group();
  neckPivot.name = "neck";
  neckPivot.position.set(0, 0.445, 0.004);
  spinePivot.add(neckPivot);

  const buildArmPivots = (side: -1 | 1) => {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.name = side < 0 ? "left-shoulder" : "right-shoulder";
    shoulderPivot.position.set(side * 0.172, 0.385, -0.006);

    const elbowPivot = new THREE.Group();
    elbowPivot.name = side < 0 ? "left-elbow" : "right-elbow";
    elbowPivot.position.set(side * 0.008, -0.25, 0.002);
    shoulderPivot.add(elbowPivot);

    const wristPivot = new THREE.Group();
    wristPivot.name = side < 0 ? "left-wrist" : "right-wrist";
    wristPivot.position.set(side * 0.002, -0.22, 0.01);
    elbowPivot.add(wristPivot);

    spinePivot.add(shoulderPivot);
    return { shoulderPivot, elbowPivot, wristPivot };
  };

  const leftArm = buildArmPivots(-1);
  const rightArm = buildArmPivots(1);

  const carriedItemGroup = new THREE.Group();
  carriedItemGroup.name = "carried-vessel";
  carriedItemGroup.position.set(0, 0.11, 0.305);
  carriedItemGroup.visible = false;
  spinePivot.add(carriedItemGroup);

  root.add(buildContactShadowPad(0.46, 0.44, 0.24));

  const figure: ArticulatedHumanWorker = {
    root,
    pelvisGroup,
    spinePivot,
    neckPivot,
    leftHipPivot: leftLeg.hipPivot,
    rightHipPivot: rightLeg.hipPivot,
    leftKneePivot: leftLeg.kneePivot,
    rightKneePivot: rightLeg.kneePivot,
    leftAnklePivot: leftLeg.anklePivot,
    rightAnklePivot: rightLeg.anklePivot,
    leftShoulderPivot: leftArm.shoulderPivot,
    rightShoulderPivot: rightArm.shoulderPivot,
    leftElbowPivot: leftArm.elbowPivot,
    rightElbowPivot: rightArm.elbowPivot,
    leftWristPivot: leftArm.wristPivot,
    rightWristPivot: rightArm.wristPivot,
    carriedItemGroup,
  };

  withLivingAssets((templates) => {
    mountRiggedFigureFromTemplates(figure, spec, templates);
  });

  return figure;
}

export function buildArticulatedHumanWorker(
  workerIndex: number,
  accentColor?: number | string,
): ArticulatedHumanWorker {
  let resolvedIndex = workerIndex;
  let resolvedAccent = accentColor;
  if (
    typeof accentColor === "number" &&
    Number.isInteger(accentColor) &&
    accentColor >= 0 &&
    accentColor < 64 &&
    workerIndex > 0xff
  ) {
    resolvedIndex = accentColor;
    resolvedAccent = workerIndex;
  }
  const safeIndex = Math.max(0, Math.floor(Math.abs(resolvedIndex)));
  const accent =
    resolvedAccent ??
    WORKER_ACCENT_HEX[safeIndex % WORKER_ACCENT_HEX.length] ??
    0x3f72af;
  const skinColor =
    WORKER_SKIN_HEX[safeIndex % WORKER_SKIN_HEX.length] ?? 0xe8be9e;
  const hairColor =
    WORKER_HAIR_HEX[safeIndex % WORKER_HAIR_HEX.length] ?? 0x241c18;

  return buildRiggedFigure(
    `human-worker-${safeIndex}`,
    {
      figureKind: "human-patissier",
      workerIndex: safeIndex,
    },
    {
      role: "patissier",
      skinColor,
      hairColor,
      accentColor: accent,
      jacketColor: 0xf8fafc,
      jacketRoughness: 0.56,
      trimColor: 0xcbd5e1,
    },
  );
}

export function poseArticulatedHumanWorker(
  figure: ArticulatedHumanWorker,
  options: HumanWorkerPoseOptions,
): void {
  figure.root.rotation.y = options.facingYawRad;
  figure.carriedItemGroup.visible = options.carrying;

  const cycle = options.phase;
  const sinA = Math.sin(cycle);
  const cosA = Math.cos(cycle);

  if (options.walking) {
    const stride = sinA * 0.42;
    const leftLift = Math.max(0, cosA);
    const rightLift = Math.max(0, -cosA);

    figure.pelvisGroup.position.y = PELVIS_REST_Y - Math.abs(sinA) * 0.018;
    figure.pelvisGroup.rotation.y = stride * 0.12;

    figure.leftHipPivot.rotation.x = -stride;
    figure.rightHipPivot.rotation.x = stride;

    figure.leftKneePivot.rotation.x = 0.08 + leftLift * 0.56;
    figure.rightKneePivot.rotation.x = 0.08 + rightLift * 0.56;

    figure.leftAnklePivot.rotation.x = -leftLift * 0.22 + stride * 0.18;
    figure.rightAnklePivot.rotation.x = -rightLift * 0.22 - stride * 0.18;

    figure.spinePivot.rotation.x = options.carrying ? 0.08 : 0.05;
    figure.spinePivot.rotation.y = -stride * 0.16;
    figure.spinePivot.rotation.z = sinA * 0.025;

    figure.neckPivot.rotation.x = 0.04;
    figure.neckPivot.rotation.y = stride * 0.08;
  } else {
    const breathe = Math.sin(cycle * 0.5) * 0.015;
    figure.pelvisGroup.position.y = PELVIS_REST_Y;
    figure.pelvisGroup.rotation.y = 0;

    figure.leftHipPivot.rotation.x = -0.03;
    figure.rightHipPivot.rotation.x = 0.03;
    figure.leftKneePivot.rotation.x = 0.06;
    figure.rightKneePivot.rotation.x = 0.06;
    figure.leftAnklePivot.rotation.x = -0.03;
    figure.rightAnklePivot.rotation.x = -0.03;

    figure.spinePivot.rotation.x = options.working ? 0.11 : 0.03;
    figure.spinePivot.rotation.y = options.working ? sinA * 0.06 : 0;
    figure.spinePivot.rotation.z = breathe;

    figure.neckPivot.rotation.x = options.working ? 0.16 : 0.04;
    figure.neckPivot.rotation.y = options.working ? cosA * 0.08 : 0;
  }

  if (options.carrying) {
    const carryBob = Math.sin(cycle * 2) * 0.03;
    figure.leftShoulderPivot.rotation.set(-0.42 + carryBob, 0.18, 0.08);
    figure.rightShoulderPivot.rotation.set(-0.42 - carryBob, -0.18, -0.08);
    figure.leftElbowPivot.rotation.set(-1.02, 0.24, 0);
    figure.rightElbowPivot.rotation.set(-1.02, -0.24, 0);
    figure.leftWristPivot.rotation.set(0.15, 0, -0.25);
    figure.rightWristPivot.rotation.set(0.15, 0, 0.25);
    figure.carriedItemGroup.position.set(0, 0.11 + carryBob * 0.2, 0.305);
  } else if (options.working && !options.walking) {
    const leftReach = Math.sin(cycle) * 0.16;
    const rightReach = Math.cos(cycle * 1.3) * 0.18;
    figure.leftShoulderPivot.rotation.set(-0.48 + leftReach * 0.5, 0.16, 0.06);
    figure.rightShoulderPivot.rotation.set(
      -0.52 + rightReach * 0.5,
      -0.16,
      -0.06,
    );
    figure.leftElbowPivot.rotation.set(-0.88 - leftReach * 0.4, 0.18, 0);
    figure.rightElbowPivot.rotation.set(-0.92 - rightReach * 0.4, -0.18, 0);
    figure.leftWristPivot.rotation.set(0.12, leftReach * 0.3, 0);
    figure.rightWristPivot.rotation.set(0.12, -rightReach * 0.3, 0);
  } else if (options.walking) {
    const armSwing = sinA * 0.34;
    figure.leftShoulderPivot.rotation.set(armSwing - 0.08, 0, 0.05);
    figure.rightShoulderPivot.rotation.set(-armSwing - 0.08, 0, -0.05);
    figure.leftElbowPivot.rotation.set(
      -0.28 - Math.max(0, -armSwing) * 0.35,
      0,
      0,
    );
    figure.rightElbowPivot.rotation.set(
      -0.28 - Math.max(0, armSwing) * 0.35,
      0,
      0,
    );
    figure.leftWristPivot.rotation.set(0, 0, 0);
    figure.rightWristPivot.rotation.set(0, 0, 0);
  } else {
    figure.leftShoulderPivot.rotation.set(-0.12, 0.06, 0.05);
    figure.rightShoulderPivot.rotation.set(-0.12, -0.06, -0.05);
    figure.leftElbowPivot.rotation.set(-0.34, 0.08, 0);
    figure.rightElbowPivot.rotation.set(-0.34, -0.08, 0);
    figure.leftWristPivot.rotation.set(0, 0, 0);
    figure.rightWristPivot.rotation.set(0, 0, 0);
  }

  rigControllers.get(figure)?.syncFromPivots();
}

export function createPosedHumanWorkerGroup(
  workerIndex: number,
  options: HumanWorkerPoseOptions,
  accentColor?: number | string,
): THREE.Group {
  const figure = buildArticulatedHumanWorker(workerIndex, accentColor);
  poseArticulatedHumanWorker(figure, options);
  return figure.root;
}

export function buildArticulatedCustomerVisitor(
  customerIndex: number,
  coatColor?: number | string,
): ArticulatedHumanWorker {
  const safeIndex = Math.max(0, Math.floor(Math.abs(customerIndex)));
  const scarfHex =
    CUSTOMER_SCARF_HEX[safeIndex % CUSTOMER_SCARF_HEX.length] ?? 0xf3ece0;
  const coatHex =
    coatColor ??
    CUSTOMER_COAT_HEX[safeIndex % CUSTOMER_COAT_HEX.length] ??
    0xc29b70;
  const skinColor =
    WORKER_SKIN_HEX[(safeIndex + 1) % WORKER_SKIN_HEX.length] ?? 0xe8be9e;
  const hairColor =
    WORKER_HAIR_HEX[(safeIndex + 1) % WORKER_HAIR_HEX.length] ?? 0x35281e;
  const trimColor = new THREE.Color(coatHex).multiplyScalar(0.84).getHex();

  return buildRiggedFigure(
    `customer-visitor-${safeIndex}`,
    {
      figureKind: "customer-visitor",
      customerIndex: safeIndex,
    },
    {
      role: "visitor",
      skinColor,
      hairColor,
      accentColor: scarfHex,
      jacketColor: coatHex,
      jacketRoughness: 0.64,
      trimColor,
    },
  );
}
