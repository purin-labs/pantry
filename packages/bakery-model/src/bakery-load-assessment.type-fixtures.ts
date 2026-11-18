import type { PhysicsRequest } from "./bakery-physics.ts";
import {
  assessRobotLoad,
  type RobotLoadAssessment,
} from "./bakery-load-assessment.ts";
import type { Variant } from "@seams/type-utils";

declare const request: PhysicsRequest;
void assessRobotLoad(request);
// @ts-expect-error Raw identity and ingredients cannot bypass the physics boundary.
void assessRobotLoad({
  robot: "universal-robots-ur5e",
  ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
});
// @ts-expect-error An unassessed load cannot also supply an assessed limit.
const invalid: RobotLoadAssessment = {
  kind: "unassessed",
  reason: "unsupported-robot",
  chartLimitKg: 5,
};
void invalid;
declare const unassessed: Variant<RobotLoadAssessment, "unassessed">;
// @ts-expect-error A broad spread cannot combine an unassessed state and load metrics.
const spread: RobotLoadAssessment = { ...unassessed, totalMassKg: 4 };
void spread;
