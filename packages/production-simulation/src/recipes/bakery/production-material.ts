import { HUMAN_CELL_TRANSFER } from "./human-cell-transfer.ts";
import nominal from "../../../../../assets/bakery-mujoco/fr10-workcell/native/fairino-fr10/table-to-rack-nominal.json" with { type: "json" };
import blocked from "../../../../../assets/bakery-mujoco/fr10-workcell/native/fairino-fr10/table-to-rack-blocked.json" with { type: "json" };
import unreachable from "../../../../../assets/bakery-mujoco/fr10-workcell/native/fairino-fr10/table-to-rack-unreachable.json" with { type: "json" };
import type {
  PhysicsGeometry,
  PhysicsPose,
  PhysicsReplay,
} from "@seams/bakery-model/bakery-physics";
import { rackBindings, type WorkcellInput } from "./workcell-input.ts";
import { workcellAt } from "./workcell-attempt.ts";
import { continuationPrefix, type Run, type Handoff } from "./schedule.ts";
import type { ProductionWorkcell } from "./production-workcells.ts";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type ProductionMaterialBinding = Readonly<{
  profile: "mbco-cold-proxy-v1";
  materialId: `batch:${string}:tray:${number}`;
  temperature: "assumed-cold";
  capacity: 1;
  resources: WorkcellInput["bindings"];
}>;

// A rehearsal chain binds the same cold proxy to the fixture of its first skill.
export function productionMaterialBinding(
  batchId: string,
  tray: number,
  resources: WorkcellInput["bindings"] = rackBindings,
): ProductionMaterialBinding {
  return Object.freeze({
    profile: "mbco-cold-proxy-v1",
    materialId: `batch:${batchId}:tray:${tray}`,
    temperature: "assumed-cold",
    capacity: 1,
    resources,
  });
}

type Compatibility =
  | Readonly<{ kind: "compatible"; message?: never }>
  | Readonly<{ kind: "incompatible"; message: string }>;

// Reuse the runner's checked-in setup rather than maintaining a second geometry profile.
export function validateProductionMaterial(
  recording: PhysicsReplay,
): Compatibility {
  if (
    recording.kind !== "bakery-physics-recording" ||
    recording.request.bakeryTaskId !== "table-to-rack"
  )
    return incompatible(
      "Production material requires an individual table-to-rack recording.",
    );
  let setup: typeof nominal;
  switch (recording.request.case) {
    case "nominal":
    case "slip":
      setup = nominal;
      break;
    case "blocked":
      setup = blocked;
      break;
    case "unreachable":
      setup = unreachable;
      break;
    default:
      return incompatible("Unsupported material transfer case.");
  }
  if (
    recording.fixture.kind !== "rack" ||
    !nearValues(recording.robotBase, setup.robotBase, 1e-6)
  )
    return incompatible(
      "The recording uses a different workcell placement or fixture.",
    );
  if (recording.geometry.length !== setup.geometry.length)
    return incompatible(
      "The tray, clamp or support geometry differs from the cold-proxy fixture.",
    );
  for (const expected of setup.geometry) {
    const actual = recording.geometry.find(
      namedGeometry.bind(null, expected.name),
    );
    if (
      actual === undefined ||
      actual.body !== expected.body ||
      actual.shape !== expected.shape ||
      !nearValues(actual.size, expected.size, 1e-6) ||
      !nearValues(actual.pose, expected.pose, 1e-6)
    )
      return incompatible(`Material/tooling mismatch: ${expected.name}.`);
  }
  // MJSTATE_INTEGRATION begins with time, six arm qpos values, then the jaw qpos.
  const sourcePose = setup.initialState.slice(8, 15);
  if (!nearValues(recording.samples[0].tray, sourcePose, 1e-6))
    return incompatible(
      "The tray does not start at the prepared source pose. Restage it before transfer.",
    );
  if (recording.outcome.kind !== "completed") return { kind: "compatible" };
  const last = recording.samples[recording.samples.length - 1];
  const left = recording.geometry.find(
    namedGeometry.bind(null, "rack_rail_left"),
  );
  const right = recording.geometry.find(
    namedGeometry.bind(null, "rack_rail_right"),
  );
  const bottom = recording.geometry.find(
    namedGeometry.bind(null, "mbco_tray_bottom"),
  );
  if (
    last === undefined ||
    left === undefined ||
    right === undefined ||
    bottom === undefined
  )
    return incompatible("The completed handoff has no tray or rack supports.");
  const destination = [
    (left.pose[0] + right.pose[0]) / 2,
    (left.pose[1] + right.pose[1]) / 2,
    left.pose[2] + left.size[2] + bottom.size[2],
  ];
  // Match the native controller's 1 cm / 5 degree completion tolerances.
  if (
    positionDistance(last.tray, destination) >= 0.01 ||
    orientationDistance(last.tray, sourcePose) >= (5 * Math.PI) / 180
  )
    return incompatible(
      "Completed evidence leaves the tray outside the reserved rack pose.",
    );
  if (!openClamp(last.tool, last.jaw))
    return incompatible(
      "Completed evidence has not opened the clamp for material clearance.",
    );
  return { kind: "compatible" };
}

function incompatible(message: string): Compatibility {
  return { kind: "incompatible", message };
}
function namedGeometry(name: string, geometry: PhysicsGeometry): boolean {
  return geometry.name === name;
}
function nearValues(
  left: readonly number[],
  right: readonly number[],
  tolerance: number,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++)
    if (Math.abs(left[index]! - right[index]!) > tolerance) return false;
  return true;
}
function positionDistance(
  left: readonly number[],
  right: readonly number[],
): number {
  return Math.hypot(
    left[0]! - right[0]!,
    left[1]! - right[1]!,
    left[2]! - right[2]!,
  );
}
function orientationDistance(
  left: PhysicsPose,
  right: readonly number[],
): number {
  let dot = 0;
  for (let index = 3; index < 7; index++) dot += left[index]! * right[index]!;
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}
function openClamp(tool: PhysicsPose, jaw: PhysicsPose): boolean {
  const [, , , w, x, y, z] = tool;
  const axis = [
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ];
  const offset = [jaw[0] - tool[0], jaw[1] - tool[1], jaw[2] - tool[2]];
  const gap =
    offset[0]! * axis[0]! + offset[1]! * axis[1]! + offset[2]! * axis[2]!;
  const lateral = Math.hypot(
    offset[0]! - gap * axis[0]!,
    offset[1]! - gap * axis[1]!,
    offset[2]! - gap * axis[2]!,
  );
  return (
    gap > 0.02 &&
    gap <= 0.036 &&
    lateral <= 1e-5 &&
    orientationDistance(tool, jaw) <= 1e-4
  );
}

export type ProductionMaterialState =
  | Readonly<{
      kind: "waiting";
      location: "production";
      tool: "unallocated";
      worker?: never;
    }>
  | Readonly<{
      kind: "staging";
      location: "baker" | "buffer";
      tool: "reserved";
      worker: Handoff["executor"];
    }>
  | Readonly<{
      kind: "awaiting-evidence";
      location: "source" | "destination" | "cell-2-source";
      tool: "reserved";
      worker?: never;
    }>
  | Readonly<{
      kind: "transferring";
      location: "source" | "gripped" | "destination" | "oven";
      tool: "reserved";
      worker?: never;
    }>
  | Readonly<{
      kind: "awaiting-clearance";
      location: "source" | "destination" | "cell-1-rack";
      tool: "reserved";
      worker?: never;
    }>
  | Readonly<{
      kind: "clearing";
      location: "baker";
      tool: "reserved";
      worker: Handoff["executor"];
    }>
  | Readonly<{
      kind: "released";
      location: "holding";
      tool: "released";
      worker?: never;
    }>
  | Readonly<{
      kind: "recovery-required";
      location: "source" | "gripped" | "destination" | "unknown";
      tool: "held";
      worker?: never;
    }>
  | Readonly<{
      kind: "recovered";
      location: "source" | "cell-1-source";
      tool: "released";
      worker?: never;
    }>;

// An assumed recovery resets the tray to its source and releases the cell.
const RECOVERED: ProductionMaterialState = Object.freeze({
  kind: "recovered",
  location: "source",
  tool: "released",
});

// Playback is a projection of the scheduler and existing attempt lifecycle, never a second owner.
// A tray's chain shares one staging and clearance; each step continues from
// the previous step's resting place.
export function productionMaterialAt(
  run: Run,
  operation: ProductionWorkcell,
  time: number,
): ProductionMaterialState {
  const root = `batch:${operation.batchId}:native:${operation.tray}`;
  const stage = operationHandoff(run, root, "stage");
  if (stage === undefined || time < stage.start)
    return { kind: "waiting", location: "production", tool: "unallocated" };
  if (time < stage.end)
    return {
      kind: "staging",
      location: "baker",
      tool: "reserved",
      worker: stage.executor,
    };
  if (stage.outcome === "failed") return failedHandling(run, stage, time);
  const transfer = operationHandoff(run, root, "transfer");
  if (transfer !== undefined && time >= transfer.start) {
    if (transfer.outcome === "failed" && time >= transfer.end)
      return failedHandling(run, transfer, time);
    if (time < transfer.arrival + HUMAN_CELL_TRANSFER.pickupSeconds)
      return {
        kind: "awaiting-clearance",
        location: "cell-1-rack",
        tool: "reserved",
      };
    if (time < transfer.end)
      return {
        kind: "staging",
        location:
          time <
          transfer.arrival +
            HUMAN_CELL_TRANSFER.pickupSeconds +
            HUMAN_CELL_TRANSFER.carrySeconds
            ? "baker"
            : "buffer",
        tool: "reserved",
        worker: transfer.executor,
      };
  }
  const clear = operationHandoff(run, root, "clear");
  if (clear?.outcome === "failed" && time >= clear.end)
    return failedHandling(run, clear, time);
  if (clear !== undefined && time >= clear.end)
    return { kind: "released", location: "holding", tool: "released" };
  if (clear !== undefined && time >= clear.start)
    return {
      kind: "clearing",
      location: "baker",
      tool: "reserved",
      worker: clear.executor,
    };
  const natives = chainNatives(run, operation);
  let native: (typeof natives)[number] | undefined;
  for (const task of natives) if (task.start <= time) native = task;
  if (
    transfer !== undefined &&
    time >= transfer.end &&
    (native === undefined || native.end <= transfer.start)
  )
    return {
      kind: "awaiting-evidence",
      location: "cell-2-source",
      tool: "reserved",
    };
  if (native === undefined)
    return { kind: "awaiting-evidence", location: "source", tool: "reserved" };
  // Subtracting a large dispatch offset can round below the terminal sample.
  const elapsed =
    time >= native.end
      ? native.operation.attempt.settledTime
      : continuationPrefix(native.operation) + time - native.start;
  const projection = workcellAt(native.operation.attempt, elapsed);
  switch (projection.kind) {
    case "running":
      return {
        kind: "transferring",
        location: projection.tray,
        tool: "reserved",
      };
    case "completed":
      return chainSteps(run, operation) > native.operation.step
        ? {
            kind: "awaiting-evidence",
            location: projection.tray,
            tool: "reserved",
          }
        : {
            kind: "awaiting-clearance",
            location: projection.tray,
            tool: "reserved",
          };
    case "recovery-required":
      return recoveredAt(run, native.operation.id) <= time
        ? RECOVERED
        : {
            kind: "recovery-required",
            location: projection.tray,
            tool: "held",
          };
    case "queued":
    case "awaiting-evidence":
    case "awaiting-return":
      throw new Error(
        "Production transfer has an incompatible attempt lifecycle.",
      );
    default:
      return assertNever(projection);
  }
}
function failedHandling(
  run: Run,
  task: Handoff,
  time: number,
): ProductionMaterialState {
  for (const failure of run.handlingFailures)
    if (
      failure.task.id === task.id &&
      failure.recoveredAt !== null &&
      time >= failure.recoveredAt
    )
      return task.phase === "transfer"
        ? { kind: "recovered", location: "cell-1-source", tool: "released" }
        : RECOVERED;
  return { kind: "recovery-required", location: "unknown", tool: "held" };
}
function recoveredAt(run: Run, operationId: string): number {
  for (const hold of run.nativeHolds)
    if (
      hold.kind === "failed" &&
      hold.operation.id === operationId &&
      hold.recoveredAt !== null
    )
      return hold.recoveredAt;
  return Infinity;
}
function chainNatives(
  run: Run,
  operation: ProductionWorkcell,
): readonly Variant<Run["intervals"][number], "native">[] {
  const natives: Variant<Run["intervals"][number], "native">[] = [];
  for (const task of run.intervals)
    if (
      task.kind === "native" &&
      task.operation.batchId === operation.batchId &&
      task.operation.tray === operation.tray
    )
      natives.push(task);
  return natives.sort(byStart);
}
function byStart(left: { start: number }, right: { start: number }): number {
  return left.start - right.start;
}
// The number of native skills authored for this tray's chain.
function chainSteps(run: Run, operation: ProductionWorkcell): number {
  const batch = run.batches.find(hasBatchId.bind(null, operation.batchId));
  let count = 0;
  for (const step of batch?.steps ?? [])
    if (
      (step.kind === "native" || step.kind === "planned") &&
      step.operation.tray === operation.tray
    )
      count++;
  return count;
}
function hasBatchId(id: string, batch: { id: string }): boolean {
  return batch.id === id;
}
function operationHandoff(
  run: Run,
  id: string,
  phase: Handoff["phase"],
): Handoff | undefined {
  for (const task of run.intervals)
    if (
      task.kind === "handoff" &&
      task.operationId === id &&
      task.phase === phase
    )
      return task;
  return undefined;
}
