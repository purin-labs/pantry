import type { BatchWaitSummary } from "./production-workspace-helpers";
import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import type { BakeryProductionReplacementSource } from "@purin-labs/bakery-model/bakery-surface";
import React from "react";
import type { ProductionMaterialState } from "@purin-labs/production-simulation/recipes/bakery/production-material";
import type { Settings } from "@purin-labs/bakery-model/bakery";
import { fields } from "@purin-labs/bakery-model/bakery";
import {
  productionAssignmentId,
  type ProductionTaskChoice,
  type ProductionManualTask,
  type ProductionAssignment,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  parsePhysicsReplay,
  type PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import type {
  PlannedProductionWorkcell,
  ProductionWorkcells,
  ProductionWorkcell,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import { newDraftIdentity } from "./production-draft";
import {
  taskAt,
  clock,
  workName,
  type Run,
  type Interval,
  type NativeBakeryTask,
  type Batch,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type {
  ProductionDraftIdentity as DraftIdentity,
  ProductionReady as Ready,
} from "./production-session";
import { readExample } from "./rehearsal-examples";
import { stepName } from "./scheduled-rehearsal";
import {
  parseCellId,
  resourceInstance,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import type { SelectChoice } from "./production-workspace-choices";
import {
  REHEARSAL_PRESETS,
  type ReadExample,
} from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import {
  outageResourceName,
  type OutageResource,
} from "@purin-labs/production-simulation/recipes/bakery/run-faults";
import type { RunSummary } from "@purin-labs/production-simulation/simulator/run-comparison";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, errorMessage } from "@purin-labs/std";

export function activeMaterialReservation(
  materialId: ProductionWorkcell["material"]["materialId"],
  time: number,
  reservation: Run["nativeReservations"][number],
): boolean {
  return (
    reservation.materialId === materialId &&
    reservation.start <= time &&
    (reservation.kind !== "released" || time < reservation.end)
  );
}
export function materialStatus(state: ProductionMaterialState): string {
  switch (state.kind) {
    case "waiting":
      return "Waiting for production and an available cell";
    case "staging":
      return `Baker ${state.worker.slice(6)} is staging the tray`;
    case "awaiting-evidence":
      return "Staged; waiting for matching native evidence";
    case "transferring":
      return "Native transfer in progress";
    case "awaiting-clearance":
      return "Placement checked; waiting for baker clearance";
    case "clearing":
      return `Baker ${state.worker.slice(6)} is clearing the rack slot`;
    case "released":
      return "Tray cleared; cell and clamp released";
    case "recovery-required":
      return "Failed; material and tooling held for recovery";
    case "recovered":
      return "Recovery assumed: tray reset to its source; cell and clamp released";
    default:
      return assertNever(state);
  }
}
export function materialLocation(
  location: ProductionMaterialState["location"],
  destination: string,
): string {
  switch (location) {
    case "production":
      return "Production batch";
    case "baker":
      return "Baker custody (assumed)";
    case "cell-1-source":
      return "Cell 1 source table (assumed recovery)";
    case "cell-1-rack":
      return "Cell 1 rack; awaiting human pickup";
    case "cell-2-source":
      return "Cell 2 source table (assumed placement)";
    case "buffer":
      return "One-slot transfer buffer (assumed placement)";
    case "source":
      return "Prepared source table";
    case "gripped":
      return "In the clamp";
    case "destination":
      return destination;
    case "oven":
      return "Maruzen oven";
    case "holding":
      return "Production holding area (assumed)";
    case "unknown":
      return "Unknown — recovery required";
    default:
      return assertNever(location);
  }
}
export function runEnd(summary: RunSummary): string {
  return `${clock(summary.end)}${summary.kind === "complete" ? "" : ` (${summary.kind === "horizon" ? "shift end" : "blocked"})`}`;
}
export function resourceChoice(resource: OutageResource): SelectChoice {
  return { value: resource, label: outageResourceName(resource) };
}
export function currentDraft(identity: DraftIdentity, id: string): boolean {
  return identity.kind !== "saved" && identity.id === id;
}
export function identityAfterSave(
  identity: DraftIdentity,
  id: string,
  unchanged: boolean,
): DraftIdentity {
  if (!currentDraft(identity, id)) return identity;
  if (!unchanged) return newDraftIdentity();
  return { kind: "uncertain", id };
}
export function matchesOperation(
  id: string | null,
  operation: ProductionWorkcell,
): boolean {
  return id === operation.id;
}
export function operationChoice(
  procedure: ProductionWorkcells["procedure"],
  operation: ProductionWorkcell,
): SelectChoice {
  const { robot, ingredients } = operation.attempt.input.request;
  return {
    value: operation.id,
    label: `${cardTitle(procedure, operation)} · ${ROBOTS[robot].label} · ${ingredients.massKg} kg · forward ${ingredients.forwardMm} mm · lateral ${ingredients.lateralMm} mm · ${operation.attempt.kind}`,
  };
}
export function batchTask(batch: string, interval: Interval): boolean {
  return interval.batch === batch && interval.kind !== "wait";
}
export function batchWaits(run: Run, batch: string): readonly BatchWaitSummary[] {
  const totals = new Map<string, BatchWaitSummary>();
  for (const interval of run.intervals) {
    if (interval.kind !== "wait" || interval.batch !== batch) continue;
    const previous = totals.get(interval.label);
    totals.set(interval.label, {
      label: interval.label,
      seconds: (previous?.seconds ?? 0) + interval.end - interval.start,
      first: previous?.first ?? interval,
    });
  }
  return [...totals.values()].sort(longestWaitFirst).slice(0, 3);
}
function longestWaitFirst(
  left: BatchWaitSummary,
  right: BatchWaitSummary,
): number {
  return right.seconds - left.seconds;
}
export function batchHold(batch: string, hold: Run["nativeHolds"][number]): boolean {
  return hold.operation.batchId === batch;
}
export function nativeFailureLabel(
  failure: Variant<Run["nativeHolds"][number], "failed">["failure"],
): string {
  switch (failure.kind) {
    case "failed":
      return `Native failure: ${failure.reason}`;
    case "execution-error":
      return `Runner error: ${failure.message}`;
    default:
      return assertNever(failure);
  }
}
export function waitForBatch(
  batch: string,
  wait: Run["unresolvedWaits"][number],
): boolean {
  return wait.batch === batch;
}
export function inBatch(batch: string, operation: ProductionWorkcell): boolean {
  return batch === operation.batchId;
}
export function hasNativeOperation(id: string, interval: Interval): boolean {
  return interval.kind === "native" && interval.operation.id === id;
}
export function nativeTaskFor(run: Run, id: string): NativeBakeryTask | null {
  for (const interval of run.intervals) {
    if (interval.kind === "native" && interval.operation.id === id)
      return interval;
  }
  return null;
}
export function nativeOperationStatus(
  data: Ready,
  operation: ProductionWorkcell,
  time: number,
): string {
  const hold = data.run.nativeHolds.find(
    holdForOperation.bind(null, operation.id),
  );
  if (hold?.kind === "failed") return "Recovery required";
  if (hold?.kind === "awaiting-evidence") return "Awaiting native result";
  const task = nativeTaskFor(data.run, operation.id);
  if (task !== null) return taskAt(data.run, task, time).kind;
  for (const predecessorId of operation.dependsOn) {
    const predecessor =
      data.run.intervals.find(taskWithId.bind(null, predecessorId)) ?? null;
    if (
      predecessor === null ||
      predecessor.kind === "wait" ||
      taskAt(data.run, predecessor, time).kind !== "completed"
    )
      return `Waiting for ${predecessorId}`;
  }
  for (const predecessor of data.plan.operations) {
    if (
      predecessor.batchId !== operation.batchId ||
      predecessor.tray >= operation.tray
    )
      continue;
    const predecessorTask = nativeTaskFor(data.run, predecessor.id);
    if (
      predecessorTask === null ||
      taskAt(data.run, predecessorTask, time).kind !== "completed"
    )
      return `Waiting for tray ${predecessor.tray}`;
  }
  const wait = data.run.unresolvedWaits.find(
    waitForBatch.bind(null, operation.batchId),
  );
  return wait?.label ?? "Queued after cooling";
}
export function holdForOperation(
  id: string,
  hold: Run["nativeHolds"][number],
): boolean {
  return hold.operation.id === id;
}
export function selectedNativeStatus(
  hold: Run["nativeHolds"][number] | undefined,
  wait: Run["unresolvedWaits"][number] | undefined,
): string {
  if (hold?.kind === "failed") return "Recovery required; cell remains held";
  if (hold?.kind === "awaiting-evidence")
    return "Awaiting matching native result";
  return wait?.label ?? "Follows cooling and available resources";
}
export const message = (error: unknown): string =>
  errorMessage(error, "Unable to prepare production workcells.");
export function matchesDraftAssignment(
  id: string,
  assignment: ProductionAssignment,
): boolean {
  return productionAssignmentId(assignment) === id;
}
export function settingsMatch(left: Settings, right: Settings): boolean {
  return fields.every((field) => left[field.key] === right[field.key]);
}
export function hasPredecessor(operation: ProductionWorkcell): boolean {
  return operation.dependsOn.length > 0;
}

export function manualTaskWithId(id: string, task: ProductionManualTask): boolean {
  return task.bakeryTaskId === id;
}
export function otherTask(id: string, task: ProductionTaskChoice): boolean {
  return task.id !== id;
}
export function isManualChoice(task: ProductionTaskChoice): boolean {
  return task.kind === "manual";
}
export function taskChoice(task: ProductionTaskChoice): SelectChoice {
  return { value: task.id, label: task.label };
}
function taskWithId(id: string, task: Interval): boolean {
  return task.kind !== "wait" && task.id === id;
}

export function hasPresetValue(
  value: string | null,
  preset: (typeof REHEARSAL_PRESETS)[number],
): boolean {
  return preset.id === value;
}
export async function readPresetExample(
  example: Parameters<ReadExample>[0],
): Promise<PhysicsReplay> {
  const parsed = parsePhysicsReplay(await readExample(example));
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}
// A tray's first skill runs in the browser from a prepared fixture; recorded
// oven and rack cycles replay only.
export function browserRoot(root: ProductionWorkcell): boolean {
  const kind = root.attempt.input.kind;
  return kind === "transfer" || kind === "native-cycle";
}
export function hasResult(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return (
    operation.attempt !== undefined &&
    operation.attempt.kind !== "awaiting-evidence"
  );
}
// Rehearsal cards sit in rows by tray and columns by step.
export function isRoot(operation: ProductionWorkcell): boolean {
  return operation.step === 1;
}
export function sameTray(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return operation.batchId === root.batchId && operation.tray === root.tray;
}
export function otherTray(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return !sameTray(root, operation);
}
export function byStep(
  left: { readonly step: number },
  right: { readonly step: number },
): number {
  return left.step - right.step;
}
export function byTrayStep(
  left: ProductionWorkcell | PlannedProductionWorkcell,
  right: ProductionWorkcell | PlannedProductionWorkcell,
): number {
  return left.batchId.localeCompare(right.batchId) || left.step - right.step;
}
export function otherId(excluded: string, id: string): boolean {
  return id !== excluded;
}
// Names the skill a tray step runs, from its plan or its bound request.
export function cardTitle(
  procedure: ProductionWorkcells["procedure"],
  operation: ProductionWorkcell,
): string {
  return procedure === "rehearsal"
    ? `Tray ${operation.batchId} · step ${operation.step} · ${stepName(operation)}`
    : `Batch ${operation.batchId} · tray ${operation.tray}`;
}

export function reason(text: string): React.ReactNode {
  return <li key={text}>{text}</li>;
}

export function productionReplacementLabel(
  source: BakeryProductionReplacementSource,
): string {
  switch (source) {
    case "preview":
      return "Apply the compiled draft";
    case "one-batch":
      return "Use Financier + robot: one batch of one tray";
    case "procedure":
      return "Use the applied procedure preset";
  }
}

export function isHumanTransferStep(
  batchId: string,
  step: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return (
    step.batchId === batchId &&
    (step.attempt === undefined
      ? step.skill.kind === "restage"
      : step.start.kind === "restaged")
  );
}

export function reservedCellNames(
  reservation: Run["nativeReservations"][number],
): string {
  const names: string[] = [];
  for (const resource of reservation.resources) {
    const cellId = parseCellId(resource);
    if (cellId !== null) names.push(resourceInstance(cellId).name);
  }
  return names.join(", ");
}

export function cellRobotLabel(
  cell: import("@purin-labs/production-simulation/recipes/bakery/production-workcells").CellRobot,
): string {
  switch (cell.kind) {
    case "unused":
      return "Unassigned";
    case "assigned":
      return ROBOTS[cell.robot].label;
  }
}

export function batchWithId(id: string, batch: Batch): boolean {
  return batch.id === id;
}

export function batchTitle(run: Run, batch: Batch): string {
  return run.unit === "tray"
    ? workName(run, batch.id)
    : `Batch ${batch.id} · ${batch.trays} trays`;
}

export function isDefaultProductionNotice(notice: string): boolean {
  return (
    notice.startsWith("Production prepared.") ||
    notice.startsWith("Rehearsal prepared with two recorded trays.")
  );
}
