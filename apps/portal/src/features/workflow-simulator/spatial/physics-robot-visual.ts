import type * as THREE from "three";
import {
  ROBOTS,
  type RobotModel,
} from "@seams/bakery-model/bakery-robots";
import { loadVisual, preloadVisual } from "./physics-asset-loader";
import fr10Url from "../../../../../../assets/bakery-robots/fairino-fr10/robot.glb?url";
import fr5Url from "../../../../../../assets/bakery-robots/fairino-fr5/robot.glb?url";
import xarmUrl from "../../../../../../assets/bakery-robots/ufactory-xarm6/robot.glb?url";
import fanucUrl from "../../../../../../assets/bakery-robots/fanuc-crx10ial/robot.glb?url";
import dobotUrl from "../../../../../../assets/bakery-robots/dobot-cr10/robot.glb?url";
import ur5eUrl from "../../../../../../assets/bakery-robots/universal-robots-ur5e/robot.glb?url";
const ROBOT_URLS = {
  "fairino-fr10": fr10Url,
  "fairino-fr5": fr5Url,
  "ufactory-xarm6": xarmUrl,
  "fanuc-crx10ial": fanucUrl,
  "universal-robots-ur5e": ur5eUrl,
  "dobot-cr10": dobotUrl,
};

export function preloadRobotVisual(robot: RobotModel): void {
  preloadVisual(ROBOT_URLS[robot], ROBOTS[robot].glbSha256);
}

export function loadRobotVisual(
  robot: RobotModel,
  signal: AbortSignal,
): Promise<THREE.Group> {
  return loadVisual(ROBOT_URLS[robot], ROBOTS[robot].glbSha256, signal);
}
