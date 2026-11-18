// Verified robot visuals and their source joint axes. Physics runs in the shared Rust engine.

export const ROBOT_IDS = [
  "fairino-fr10",
  "fairino-fr5",
  "ufactory-xarm6",
  "fanuc-crx10ial",
  "universal-robots-ur5e",
  "dobot-cr10",
] as const;
export type RobotModel = (typeof ROBOT_IDS)[number];

export const ROBOTS = {
  "fairino-fr10": {
    label: "FAIRINO FR10",
    glbSha256:
      "2cbd5b12d74414c9c057ac5efdc056c16b90fc954e55da985d3733e6bea486fe",
    payloadKg: 10,
    reachM: 1.4,
    joints: [
      { node: "fairino-fr10__j1", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr10__j2", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr10__j3", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr10__j4", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr10__j5", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr10__j6", axis: [0.0, 1.0, -0.0] },
    ],
  },
  "fairino-fr5": {
    label: "FAIRINO FR5",
    glbSha256:
      "fd65217010629018aed5496c6237ab53b5316d56ea1d8eef5b8ade45c1f1949c",
    payloadKg: 5,
    reachM: 0.922,
    joints: [
      { node: "fairino-fr5__j1", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr5__j2", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr5__j3", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr5__j4", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr5__j5", axis: [0.0, 1.0, -0.0] },
      { node: "fairino-fr5__j6", axis: [0.0, 1.0, -0.0] },
    ],
  },
  "ufactory-xarm6": {
    label: "UFACTORY xArm 6",
    glbSha256:
      "1877636e6db7fd854c934d4cc4093497caeb7f647806aea50754435102b297f4",
    payloadKg: 5,
    reachM: 0.7,
    joints: [
      { node: "ufactory-xarm6__joint1", axis: [0.0, 1.0, -0.0] },
      { node: "ufactory-xarm6__joint2", axis: [0.0, 1.0, -0.0] },
      { node: "ufactory-xarm6__joint3", axis: [0.0, 1.0, -0.0] },
      { node: "ufactory-xarm6__joint4", axis: [0.0, 1.0, -0.0] },
      { node: "ufactory-xarm6__joint5", axis: [0.0, 1.0, -0.0] },
      { node: "ufactory-xarm6__joint6", axis: [0.0, 1.0, -0.0] },
    ],
  },
  "fanuc-crx10ial": {
    label: "FANUC CRX-10iA/L \u2014 food appearance study",
    glbSha256:
      "dc91e4d07eac4e290c08f1a2c52db36fa1d96a27926074dca9f62f8c56695443",
    payloadKg: 10,
    reachM: 1.418,
    joints: [
      { node: "fanuc-crx10ial__J1", axis: [0.0, 1.0, -0.0] },
      { node: "fanuc-crx10ial__J2", axis: [0.0, 0.0, -1.0] },
      { node: "fanuc-crx10ial__J3", axis: [0.0, 0.0, 1.0] },
      { node: "fanuc-crx10ial__J4", axis: [-1.0, 0.0, -0.0] },
      { node: "fanuc-crx10ial__J5", axis: [0.0, 0.0, 1.0] },
      { node: "fanuc-crx10ial__J6", axis: [-1.0, 0.0, -0.0] },
    ],
  },
  "universal-robots-ur5e": {
    label: "Universal Robots UR5e",
    glbSha256:
      "262fa98c52c632a17d092aace7536b3e38bb2aecef54dd365e9673fc66393309",
    payloadKg: 5,
    reachM: 0.85,
    joints: [
      {
        node: "universal-robots-ur5e__shoulder_pan_joint",
        axis: [0.0, 1.0, -0.0],
      },
      {
        node: "universal-robots-ur5e__shoulder_lift_joint",
        axis: [0.0, 1.0, -0.0],
      },
      { node: "universal-robots-ur5e__elbow_joint", axis: [0.0, 1.0, -0.0] },
      { node: "universal-robots-ur5e__wrist_1_joint", axis: [0.0, 1.0, -0.0] },
      { node: "universal-robots-ur5e__wrist_2_joint", axis: [0.0, 1.0, -0.0] },
      { node: "universal-robots-ur5e__wrist_3_joint", axis: [0.0, 1.0, -0.0] },
    ],
  },
  "dobot-cr10": {
    label: "DOBOT CR10 \u2014 provisional dynamics",
    glbSha256:
      "5ed0f6ef775ab455e902f59b41432dff866346872d121c5b10cfc33374bb1881",
    payloadKg: 10,
    reachM: 1.3,
    joints: [
      {
        node: "dobot-cr10__joint1",
        axis: [0.0, 1.0, -0.0],
      },
      {
        node: "dobot-cr10__joint2",
        axis: [0.0, 1.0, -0.0],
      },
      {
        node: "dobot-cr10__joint3",
        axis: [0.0, 1.0, -0.0],
      },
      {
        node: "dobot-cr10__joint4",
        axis: [0.0, 1.0, -0.0],
      },
      {
        node: "dobot-cr10__joint5",
        axis: [0.0, 1.0, -0.0],
      },
      {
        node: "dobot-cr10__joint6",
        axis: [0.0, 1.0, -0.0],
      },
    ],
  },
} as const;

export function parseRobotModel(value: unknown): RobotModel {
  switch (value) {
    case "fairino-fr10":
    case "fairino-fr5":
    case "ufactory-xarm6":
    case "fanuc-crx10ial":
    case "universal-robots-ur5e":
    case "dobot-cr10":
      return value;
    default:
      throw new Error("Choose a supported robot model.");
  }
}
