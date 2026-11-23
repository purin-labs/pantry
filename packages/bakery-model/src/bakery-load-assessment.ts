import type { StrictUnion } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import tooling from "../../../assets/bakery-robots/universal-robots-ur5e/tooling/mass-properties.json" with { type: "json" };
import {
  PHYSICS_ASSETS_SHA256,
  physicsCellOf,
  type IngredientLoad,
  type PhysicsRequest,
} from "./bakery-physics.ts";

export const UR5E_PAYLOAD_SOURCE = {
  title: "UR5e SW 5.19 manual, section 2.2, printed page 18",
  url: "https://www.universal-robots.com/manuals/EN/PDF/SW5_19/user-manual-UR5e-PDF_online/710-965-00_UR5e_User_Manual_en_Global.pdf",
  readingAllowanceKg: 0.1,
} as const;

// Visual readings of the archived curve. Linear interpolation is an estimate.
const UR5E_CHART = [
  { distanceMm: 0, massKg: 5 },
  { distanceMm: 350, massKg: 5 },
  { distanceMm: 400, massKg: 4.5 },
  { distanceMm: 450, massKg: 4.09 },
  { distanceMm: 500, massKg: 3.75 },
  { distanceMm: 550, massKg: 3.46 },
  { distanceMm: 600, massKg: 3.21 },
] as const;

// Restrict the mass calculation to this verified fixture revision. A replacement
// model needs a fresh mass-property check (scripts/bakery-robots/ur5e_mass_check.py)
// before it can receive an assessment. The checks of this revision:
// docs/evidence/refactor-16/ci-ur5e-mass-check.md and, for the nine appliance
// entries that Refactor 16 step 9 added, docs/evidence/refactor-16/step-9.md.
const ASSESSED_ASSETS_SHA256: string =
  "09a0c0e1682605b327c5066a344bcdb6f94585925ce1e3a10a393abde602d90b";

const fixed = tooling.bodies.tool;
const jaw = tooling.bodies.jaw;
const [fixedX, , fixedZ] = fixed.centerOfMassM;
const [jawX, , jawZ] = jaw.centerOfMassM;
if (
  fixedX === undefined ||
  fixedZ === undefined ||
  jawX === undefined ||
  jawZ === undefined
)
  throw new Error("Tool mass properties need three center coordinates.");
const TOOL_CENTERS = { fixedX, fixedZ, jawX, jawZ };

type EstimatedLoad = Readonly<{
  toolMassKg: number;
  trayMassKg: number;
  ingredientMassKg: number;
  totalMassKg: number;
  flangeCenterOfMassM: readonly [number, number, number];
  centerFrame: "cell_nominal_flange";
  centerOfMassDistanceMm: number;
  chartLimitKg: number;
  chartMarginKg: number;
  readingAllowanceKg: number;
  massBasis: "unmeasured-prototype";
}>;

export type RobotLoadAssessment = StrictUnion<
  | (EstimatedLoad &
      Readonly<{
        kind: "below-chart" | "near-chart" | "above-chart";
        reason?: never;
      }>)
  | Readonly<{
      kind: "unassessed";
      reason:
        "unsupported-robot" | "unverified-model" | "outside-chart-distance";
    }>
>;

export async function assessRobotLoad(
  request: PhysicsRequest,
): Promise<RobotLoadAssessment> {
  if (request.robot !== "universal-robots-ur5e")
    return { kind: "unassessed", reason: "unsupported-robot" };
  if (PHYSICS_ASSETS_SHA256 !== ASSESSED_ASSETS_SHA256)
    return { kind: "unassessed", reason: "unverified-model" };
  // The engine runs pan staging and spanner oven fixtures with the FR10 only.
  const cell = await physicsCellOf(request);
  if (cell === null || cell === "pan-staging" || cell === "spanner-oven")
    return { kind: "unassessed", reason: "unverified-model" };
  const properties = ur5eCarriedLoad(request.ingredients);
  const limit = chartLimit(properties.centerOfMassDistanceMm);
  if (limit === null)
    return { kind: "unassessed", reason: "outside-chart-distance" };
  const margin = limit - properties.totalMassKg;
  let kind: "below-chart" | "near-chart" | "above-chart";
  if (margin >= UR5E_PAYLOAD_SOURCE.readingAllowanceKg) kind = "below-chart";
  else if (margin <= -UR5E_PAYLOAD_SOURCE.readingAllowanceKg)
    kind = "above-chart";
  else kind = "near-chart";
  return {
    kind,
    toolMassKg: properties.toolMassKg,
    trayMassKg: properties.trayMassKg,
    ingredientMassKg: request.ingredients.massKg,
    totalMassKg: properties.totalMassKg,
    flangeCenterOfMassM: properties.flangeCenterOfMassM,
    centerFrame: "cell_nominal_flange",
    centerOfMassDistanceMm: properties.centerOfMassDistanceMm,
    chartLimitKg: limit,
    chartMarginKg: margin,
    readingAllowanceKg: UR5E_PAYLOAD_SOURCE.readingAllowanceKg,
    massBasis: "unmeasured-prototype",
  };
}

function ur5eCarriedLoad(ingredients: IngredientLoad) {
  const toolMassKg = fixed.massKg + jaw.massKg;
  const trayMassKg = 2;
  const totalMassKg = toolMassKg + trayMassKg + ingredients.massKg;
  // Nominal closed grip: tool body rotates (x,y,z) to flange (z,-y,x),
  // with a 120 mm spacer. Tray origin is 250 mm ahead of the 160 mm grasp
  // site and 1 mm above it. Empty tray CoM adds 2 mm; contents add 20 mm.
  const flangeCenterOfMassM: readonly [number, number, number] = [
    (fixed.massKg * TOOL_CENTERS.fixedZ +
      jaw.massKg * TOOL_CENTERS.jawZ +
      trayMassKg * 0.003 +
      ingredients.massKg * 0.021) /
      totalMassKg,
    (0 - ingredients.massKg * ingredients.lateralMm) / 1000 / totalMassKg,
    (fixed.massKg * (0.12 + TOOL_CENTERS.fixedX) +
      jaw.massKg * (0.12 + TOOL_CENTERS.jawX) +
      trayMassKg * 0.53 +
      ingredients.massKg * (0.53 + ingredients.forwardMm / 1000)) /
      totalMassKg,
  ];
  return {
    toolMassKg,
    trayMassKg,
    totalMassKg,
    flangeCenterOfMassM,
    centerOfMassDistanceMm: Math.hypot(...flangeCenterOfMassM) * 1000,
  };
}

function chartLimit(distanceMm: number): number | null {
  let lower: Readonly<{ distanceMm: number; massKg: number }> = UR5E_CHART[0];
  for (const upper of UR5E_CHART) {
    if (upper.distanceMm === lower.distanceMm) continue;
    if (distanceMm <= upper.distanceMm) {
      const fraction =
        (distanceMm - lower.distanceMm) / (upper.distanceMm - lower.distanceMm);
      return lower.massKg + fraction * (upper.massKg - lower.massKg);
    }
    lower = upper;
  }
  return null;
}

export function robotLoadLabel(assessment: RobotLoadAssessment): string {
  switch (assessment.kind) {
    case "below-chart":
      return "Below estimated chart limit";
    case "near-chart":
      return "Near estimated chart limit";
    case "above-chart":
      return "Above estimated chart limit";
    case "unassessed":
      return "Not assessed";
    default:
      return assertNever(assessment);
  }
}
