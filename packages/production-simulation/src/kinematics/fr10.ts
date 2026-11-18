/**
 * Kinematics of the FAIRINO FR10 arm, in Z-up station coordinates.
 *
 * The recipe scenes had 8 copies of these functions. Two quaternion formulas
 * remain: the scene arms use the plain product and the cross-product rotation;
 * the espresso and siphon arms use the normalized product and the expanded
 * rotation, which match MuJoCo 3.13.0 to under 1 nm. Each recipe keeps the
 * formula that it used, so no recorded pose moves by a bit.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export type JointVector = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];
export type Pose7 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export type Fr10Link = Readonly<{ pos: Vec3; quat: Quat }>;

/** The FR10 link chain from `assets/bakery-mujoco/fairino-fr10/robot.xml`, on a base. */
export function fr10Links(base: Vec3): readonly Fr10Link[] {
  return [
    { pos: base, quat: [1, 0, 0, 0] },
    { pos: [0, 0, 0.18], quat: [0.7071055, 0.70710806, 0, 0] },
    { pos: [-0.7, 0, 0], quat: [1, 0, 0, 0] },
    { pos: [-0.586, 0, 0], quat: [1, 0, 0, 0] },
    { pos: [0, 0, 0.159], quat: [0.7071055, 0.70710806, 0, 0] },
    { pos: [0, 0, 0.114], quat: [0.7071055, -0.70710806, 0, 0] },
  ];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [w, qx, qy, qz] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + w * tx + (qy * tz - qz * ty),
    vy + w * ty + (qz * tx - qx * tz),
    vz + w * tz + (qx * ty - qy * tx),
  ];
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function quatFromAxisZ(angle: number): Quat {
  return [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)];
}

const GRIPPER_MOUNT_POS: Vec3 = [0, 0, 0.125];
const GRIPPER_MOUNT_QUAT: Quat = [0.5, 0.5, -0.5, 0.5];

/** Forward kinematics to the gripper mount of a scene arm. */
export function fr10GripperKinematics(
  links: readonly Fr10Link[],
): (joints: JointVector) => Readonly<{ joints: JointVector; gripper: Pose7 }> {
  return (joints) => {
    let pos: Vec3 = [0, 0, 0];
    let quat: Quat = [1, 0, 0, 0];
    for (let i = 0; i < 6; i++) {
      const link = links[i]!;
      pos = addVec3(pos, quatRotate(quat, link.pos));
      quat = quatMul(quat, link.quat);
      quat = quatMul(quat, quatFromAxisZ(joints[i]!));
    }
    const gPos = addVec3(pos, quatRotate(quat, GRIPPER_MOUNT_POS));
    const gQuat = quatMul(quat, GRIPPER_MOUNT_QUAT);
    return {
      joints,
      gripper: [
        gPos[0],
        gPos[1],
        gPos[2],
        gQuat[0],
        gQuat[1],
        gQuat[2],
        gQuat[3],
      ],
    };
  };
}

/** Shoulder-first inverse kinematics of a scene arm: the wrist pitch sets j5. */
export function fr10ShoulderIk(
  base: Vec3,
): (toolTargetZUp: Vec3, wristPitch?: number) => JointVector {
  return (toolTargetZUp, wristPitch = Math.PI / 2) => {
    const bx = base[0];
    const by = base[1];
    const bz = base[2];

    const dx = toolTargetZUp[0] - bx;
    const dy = toolTargetZUp[1] - by;
    const d1 = 0.18;
    const a2 = 0.7;
    const a3 = 0.586;
    const d4 = 0.159;

    const rHoriz = Math.max(0.22, Math.hypot(dx, dy));
    const phi = Math.atan2(dy, dx);
    const offsetAsin = Math.asin(Math.min(0.95, d4 / rHoriz));
    const j1 = phi - offsetAsin + Math.PI;

    const dirX = -Math.cos(j1);
    const dirY = -Math.sin(j1);
    const reachForward = dx * dirX + dy * dirY;

    const wristExtend = 0.21;
    const rWrist = Math.max(0.16, reachForward - wristExtend);
    const zWrist = toolTargetZUp[2] - (bz + d1) + 0.04;

    const c = Math.min(
      a2 + a3 - 0.02,
      Math.max(0.18, Math.hypot(rWrist, zWrist)),
    );
    const cosKnee = Math.max(
      -0.99,
      Math.min(0.99, (c * c - a2 * a2 - a3 * a3) / (2 * a2 * a3)),
    );
    const j3 = Math.acos(cosKnee);

    const alpha = Math.atan2(zWrist, rWrist);
    const cosBeta = Math.max(
      -0.99,
      Math.min(0.99, (a2 * a2 + c * c - a3 * a3) / (2 * a2 * c)),
    );
    const beta = Math.acos(cosBeta);
    const theta2FromForward = alpha + beta;
    const j2 = theta2FromForward - Math.PI;

    const j4 = -theta2FromForward - j3;
    const j5 = wristPitch;
    const j6 = j1 - phi;
    return [j1, j2, j3, j4, j5, j6];
  };
}

/** Planar inverse kinematics of the latte arm: the wrist pitch folds into j4. */
export function fr10PlanarIk(
  base: Vec3,
): (targetToolPos: Vec3, wristPitch?: number) => JointVector {
  return (targetToolPos, wristPitch = Math.PI * 0.44) => {
    const dx = targetToolPos[0] - base[0];
    const dy = targetToolPos[1] - base[1];
    const dz = targetToolPos[2] - (base[2] + 0.18);

    const d4 = 0.159;
    const rHoriz = Math.max(0.18, Math.hypot(dx, dy));
    const phi = Math.atan2(dy, dx);
    const offsetAngle = Math.asin(Math.min(0.95, d4 / rHoriz));
    const j1 = phi - Math.PI + offsetAngle;

    const planarReach = Math.max(
      0.16,
      Math.sqrt(Math.max(0.02, rHoriz * rHoriz - d4 * d4)) - 0.155,
    );
    const planarZ = dz + 0.045;
    const a2 = 0.7;
    const a3 = 0.586;
    const d = Math.min(
      a2 + a3 - 0.015,
      Math.max(0.18, Math.hypot(planarReach, planarZ)),
    );

    const cosElbow = Math.max(
      -1,
      Math.min(1, (d * d - a2 * a2 - a3 * a3) / (2 * a2 * a3)),
    );
    const elbowAngle = Math.acos(cosElbow);
    const alpha = Math.atan2(planarZ, planarReach);
    const cosBeta = Math.max(
      -1,
      Math.min(1, (d * d + a2 * a2 - a3 * a3) / (2 * a2 * d)),
    );
    const beta = Math.acos(cosBeta);

    const q2 = -(alpha + beta);
    const q3 = elbowAngle;
    const q4 = -q2 - q3 - wristPitch;
    const j5 = -Math.PI * 0.5;
    const j6 = 0;
    return [j1, q2, q3, q4, j5, j6];
  };
}

/** The normalized product of the espresso and siphon arms. */
export function quatMultiplyNormalized(a: Quat, b: Quat): Quat {
  const [w1, x1, y1, z1] = a;
  const [w2, x2, y2, z2] = b;
  const w = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
  const x = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
  const y = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
  const z = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
  const norm = Math.hypot(w, x, y, z) || 1;
  return [w / norm, x / norm, y / norm, z / norm];
}

/** The expanded rotation of the espresso and siphon arms. */
export function quatRotateExpanded(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const uvx = y * vz - z * vy;
  const uvy = z * vx - x * vz;
  const uvz = x * vy - y * vx;
  const uuvx = y * uvz - z * uvy;
  const uuvy = z * uvx - x * uvz;
  const uuvz = x * uvy - y * uvx;
  return [
    vx + 2 * (w * uvx + uuvx),
    vy + 2 * (w * uvy + uuvy),
    vz + 2 * (w * uvz + uuvz),
  ];
}

const PARALLEL_GRIPPER_MOUNT: Fr10Link = {
  pos: [0, 0, 0.106],
  quat: [0, 0.7071067811865476, 0, 0.7071067811865476],
};

/**
 * Exact analytical forward kinematics to the parallel gripper and its tool
 * point, matching MuJoCo 3.13.0 (`< 1 nm` error).
 */
export function fr10ToolKinematics(
  links: readonly Fr10Link[],
): (
  joints: JointVector,
) => Readonly<{ joints: JointVector; gripper: Pose7; tool: Vec3 }> {
  return (joints) => {
    let p: Vec3 = [0, 0, 0];
    let q: Quat = [1, 0, 0, 0];
    for (let i = 0; i < 6; i++) {
      const link = links[i]!;
      const angle = joints[i]!;
      const dp = quatRotateExpanded(q, link.pos);
      p = [p[0] + dp[0], p[1] + dp[1], p[2] + dp[2]];
      q = quatMultiplyNormalized(q, link.quat);
      const half = angle * 0.5;
      q = quatMultiplyNormalized(q, [Math.cos(half), 0, 0, Math.sin(half)]);
    }
    const dg = quatRotateExpanded(q, PARALLEL_GRIPPER_MOUNT.pos);
    const gPos: Vec3 = [p[0] + dg[0], p[1] + dg[1], p[2] + dg[2]];
    const gQuat = quatMultiplyNormalized(q, PARALLEL_GRIPPER_MOUNT.quat);
    const dt = quatRotateExpanded(gQuat, [0.13, 0, 0]);
    const tool: Vec3 = [gPos[0] + dt[0], gPos[1] + dt[1], gPos[2] + dt[2]];
    return {
      joints,
      gripper: [
        gPos[0],
        gPos[1],
        gPos[2],
        gQuat[0],
        gQuat[1],
        gQuat[2],
        gQuat[3],
      ],
      tool,
    };
  };
}

/**
 * Closed-form 6-DOF inverse kinematics of the espresso arm: the parallel
 * gripper stays horizontal and points at horizontal yaw `psi` (radians).
 */
export function fr10WristIk(
  base: Vec3,
): (targetTool: Vec3, psi?: number) => JointVector {
  return (targetTool, psi = Math.PI * 0.44) => {
    const a2 = 0.7;
    const a3 = 0.586;
    const d4 = 0.159;
    const p5x = targetTool[0] - 0.236 * Math.cos(psi);
    const p5y = targetTool[1] - 0.236 * Math.sin(psi);
    const p5z = targetTool[2] + 0.114;

    const dx = p5x - base[0];
    const dy = p5y - base[1];
    const dz = p5z - base[2];

    const u = Math.sqrt(Math.max(0.04, dx * dx + dy * dy - d4 * d4));
    const j1 = Math.atan2(dy, dx) + Math.atan2(d4, u);

    const z = dz - 0.18;
    // THREE.MathUtils.clamp, as the scene called it.
    const cosJ3 = Math.max(
      -0.999,
      Math.min(0.999, (u * u + z * z - a2 * a2 - a3 * a3) / (2 * a2 * a3)),
    );
    const j3 = -Math.acos(cosJ3);
    let j2 =
      Math.atan2(-z, -u) -
      Math.atan2(a3 * Math.sin(j3), a2 + a3 * Math.cos(j3));
    if (j2 > 0) j2 -= Math.PI * 2;
    const j4 = -Math.PI * 2 - j2 - j3;
    const j5 = j1 - psi - Math.PI / 2;
    const j6 = Math.PI / 2;
    return [j1, j2, j3, j4, j5, j6];
  };
}
