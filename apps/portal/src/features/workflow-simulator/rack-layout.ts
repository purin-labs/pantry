import type { FitFinding } from "./spatial/floor-plan-geometry";
import * as THREE from "three";
import { OBB } from "three/addons/math/OBB.js";
import {
  parsePhysicsLayout,
  parsePhysicsRequest,
  rackLayoutHash,
  type PhysicsLayout,
} from "@seams/bakery-model/bakery-physics";
import setup from "../../../../../assets/bakery-mujoco/fr10-workcell/native/fairino-fr10/table-to-rack-nominal.json" with { type: "json" };
import {
  compileWorkcellInput,
  type TransferInput,
} from "@seams/production-simulation/recipes/bakery/workcell-input";
import { COLD_CELL } from "@seams/production-simulation/recipes/bakery/workcell-instances";
import type { ActiveAttempt } from "@seams/production-simulation/recipes/bakery/workcell-attempt";
import type { Variant } from "@seams/type-utils";

// The rack translation moves the table-to-rack destination of the Robot cell.
const RACK = COLD_CELL.skills["table-to-rack"];
const reviewed: unique symbol = Symbol("reviewed rack placement");
export type RackPlacementFit = Readonly<{ checks: readonly FitFinding[] }> &
  (
    | Readonly<{
        kind: "blocked";
        obstruction: "table" | "robot-base";
        message: string;
      }>
    | Readonly<{ kind: "unchecked"; message: string; obstruction?: never }>
  );
export type RackLayoutProposal = Readonly<{
  [reviewed]: true;
  previous: ActiveAttempt;
  epoch: number;
  layout: PhysicsLayout;
  checks: readonly FitFinding[];
}> &
  (
    | Readonly<{ kind: "blocked"; message: string; input?: never }>
    | Readonly<{ kind: "unchecked"; message: string; input: TransferInput }>
  );
export type RackLayoutReview =
  | Readonly<{ kind: "none"; proposal?: never }>
  | Readonly<{
      kind: "invalid";
      previous: ActiveAttempt;
      epoch: number;
      xMm: number;
      yMm: number;
      message: string;
      layout?: never;
      proposal?: never;
    }>
  | Readonly<{
      kind: "draft";
      previous: ActiveAttempt;
      epoch: number;
      layout: PhysicsLayout;
      fit: RackPlacementFit;
      proposal?: never;
    }>
  | Readonly<{ kind: "prepared"; proposal: RackLayoutProposal }>;

export function rackOffset(layout: PhysicsLayout): readonly [number, number] {
  return layout.kind === "fixed" ? [0, 0] : [layout.xMm, layout.yMm];
}

export function supportsRackLayout(attempt: ActiveAttempt): boolean {
  const input = attempt.input;
  return (
    input.kind === "transfer" &&
    input.request.bakeryTaskId === "table-to-rack" &&
    input.request.case === "nominal"
  );
}

export type RackLayoutDraft = Variant<RackLayoutReview, "draft">;

export function evaluateRackLayout(
  previous: ActiveAttempt,
  epoch: number,
  xMm: number,
  yMm: number,
): Variant<RackLayoutReview, "draft" | "invalid"> {
  let layout: PhysicsLayout;
  try {
    layout = parsePhysicsLayout({ kind: "rack-translation", xMm, yMm });
  } catch {
    return {
      kind: "invalid",
      previous,
      epoch,
      xMm,
      yMm,
      message:
        "Use whole millimetres from −600 to 600 on each axis. This position cannot be applied.",
    };
  }
  return {
    kind: "draft",
    previous,
    epoch,
    layout,
    fit: rackPlacementFit(layout),
  };
}

export async function prepareRackLayout(
  draft: RackLayoutDraft,
): Promise<RackLayoutProposal> {
  const { previous, epoch, layout, fit } = draft;
  if (!supportsRackLayout(previous))
    throw new Error(
      "Choose a nominal table-to-rack rehearsal tray to edit its rack.",
    );
  const source = previous.input;
  if (
    source.request.modelHash !==
    (await rackLayoutHash(source.request.layout, source.request.robot))
  )
    throw new Error("This model has no verified editable rack placement.");
  if (fit.kind === "blocked")
    return {
      [reviewed]: true,
      previous,
      epoch,
      layout,
      kind: "blocked",
      message: fit.message,
      checks: fit.checks,
    };
  const parsed = parsePhysicsRequest(
    JSON.stringify({
      schemaVersion: 7,
      robot: source.request.robot,
      ingredients: source.request.ingredients,
      clampForceN: source.request.clampForceN,
      source: "local-simulation",
      runId: source.request.runId,
      attemptId: `attempt-${crypto.randomUUID()}`,
      bakeryTaskId: "table-to-rack",
      case: "nominal",
      timestep: source.request.timestep,
      execution: source.request.execution,
      modelHash: await rackLayoutHash(layout, source.request.robot),
      layout,
    }),
  );
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  const compiled = compileWorkcellInput(
    parsed.request,
    String(source.requestedDispatchTime),
    source.bindings.cell,
  );
  if (compiled.kind === "invalid") throw new Error(compiled.message);
  return {
    [reviewed]: true,
    previous,
    epoch,
    layout,
    kind: "unchecked",
    input: compiled.input,
    message: fit.message,
    checks: fit.checks,
  };
}

/** Use the verified fixture's individual solids; a rack envelope includes empty space. */
export function rackPlacementFit(layout: PhysicsLayout): RackPlacementFit {
  const [x, y] = rackOffset(layout);
  const checks: FitFinding[] = [];
  let obstruction: "table" | "robot-base" | null = null;
  for (const target of ["table", "robot-base"] as const) {
    let blocked = false;
    for (const rack of setup.geometry) {
      if (
        !rack.name.startsWith("rack_") ||
        rack.body !== "world" ||
        rack.shape !== "box"
      )
        continue;
      const moved = fixtureBox(rack);
      moved.center.x += x / 1000;
      moved.center.y += y / 1000;
      for (const solid of setup.geometry) {
        if (
          solid.body !== "world" ||
          solid.name.startsWith("rack_") ||
          solid.shape !== "box"
        )
          continue;
        if (
          (solid.name.startsWith("table_") ? "table" : "robot-base") !== target
        )
          continue;
        if (moved.intersectsOBB(fixtureBox(solid))) blocked = true;
      }
    }
    const label = target === "table" ? "source table" : "robot base";
    checks.push({
      source: "geometry",
      rule: "solid-overlap",
      kind: blocked ? "blocked" : "clear",
      first: RACK.destination,
      second: target === "table" ? RACK.source : RACK.arm,
      message: blocked
        ? `Blocked: Rack overlaps the ${label}. Move the rack before applying.`
        : `Rack and ${label}: no modeled solid overlap.`,
    });
    if (blocked && obstruction === null) obstruction = target;
  }
  if (obstruction !== null) {
    const label = obstruction === "table" ? "source table" : "robot base";
    return {
      kind: "blocked",
      obstruction,
      checks,
      message: `Blocked: Rack overlaps the ${label}. Move the rack before applying.`,
    };
  }
  return {
    kind: "unchecked",
    checks,
    message:
      "No modeled solid overlap. Robot reach, swept motion and stability require a new simulation. Room and service clearances are unchecked.",
  };
}

function fixtureBox(geometry: (typeof setup.geometry)[number]): OBB {
  const [x, y, z, w, qx, qy, qz] = geometry.pose;
  const rotation = new THREE.Matrix3().setFromMatrix4(
    new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(qx, qy, qz, w),
    ),
  );
  return new OBB(
    new THREE.Vector3(x, y, z),
    new THREE.Vector3(...geometry.size)
      .subScalar(0.0005)
      .max(new THREE.Vector3()),
    rotation,
  );
}
