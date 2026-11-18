import { physicsOutcome } from "@seams/production-simulation/recipes/bakery/physics-playback";
import type {
  BakerySimulationMode,
  BakerySurfacePendingOperation,
} from "@seams/bakery-model/bakery-surface";
import type { ProductionPresentation } from "@seams/bakery-model/bakery-production-scenario";
import type { BrowserPhysicsTask } from "@seams/production-simulation/simulator/browser-physics-task";
import {
  nextProductionExecution,
  type ExecutableProductionOperation,
} from "@seams/production-simulation/simulator/production-execution";
import type {
  ProductionPending,
  ProductionReady,
  ProductionSession,
} from "./production-session.ts";
import {
  acceptProductionRecording,
  bindProductionSuccessor,
  type PlannedProductionWorkcell,
  type ProductionWorkcell,
  type ProductionWorkcells,
  type ProductionWorkcellsResult,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import { supportsRackLayout } from "./rack-layout.ts";
import {
  simulateProduction,
  type Run,
  type ScheduleSpatialLayout,
} from "@seams/production-simulation/recipes/bakery/schedule";
import type { WorkcellInput } from "@seams/production-simulation/recipes/bakery/workcell-input";
import type { Variant } from "@seams/type-utils";

// A rehearsal on the production scheduler, as the workspace, chat commands
// and the browser runner all see it: the step it awaits, the tray a layout
// edit may move, and the review of one native result before acceptance.

export type PendingSimulation = Readonly<{
  operation: ExecutableProductionOperation;
  task: BrowserPhysicsTask;
  mode: BakerySimulationMode;
  label: string;
}>;

export function readyProduction(
  plan: ProductionWorkcells,
  layout: ScheduleSpatialLayout | null,
): ProductionReady {
  return { kind: "ready", plan, run: simulateProduction(plan, layout) };
}

// The step the scheduler awaits, when the browser can run it.
export function pendingSimulation(
  plan: ProductionWorkcells,
  run: Run,
): PendingSimulation | null {
  const next = nextProductionExecution(plan, run);
  if (next.kind !== "execute") return null;
  return {
    operation: next.operation,
    task: next.task,
    mode: simulationMode(next.operation.attempt.input),
    label: stepLabel(next.operation),
  };
}

export function pendingOperationContext(
  plan: ProductionWorkcells,
  run: Run,
): BakerySurfacePendingOperation | null {
  const pending = pendingSimulation(plan, run);
  return pending === null
    ? null
    : {
        operationId: pending.operation.id,
        label: pending.label,
        mode: pending.mode,
      };
}

export function simulationMode(input: WorkcellInput): BakerySimulationMode {
  switch (input.kind) {
    case "transfer":
      return "transfer";
    case "native-cycle":
    case "oven-cycle":
      return "oven-cycle";
    case "rack-cycle":
      return "rack-cycle";
  }
}

// The tray a rack translation moves: the selected tray when its first step is
// a nominal table-to-rack transfer, otherwise the first such tray.
export function layoutTray(
  plan: ProductionWorkcells,
  batchId: string | null,
): ProductionWorkcell | null {
  const roots = plan.operations.filter(isLayoutRoot);
  return roots.find(inBatch.bind(null, batchId)) ?? roots[0] ?? null;
}

// The tray in view: the selected tray, or the selected operation's tray.
export function selectedTray(session: ProductionSession): string | null {
  if (session.selection.kind === "batch") return session.selection.id;
  if (session.data.kind !== "ready" || session.operationId === null)
    return null;
  return (
    session.data.plan.operations.find(
      hasOperationId.bind(null, session.operationId),
    )?.batchId ?? null
  );
}

// Accepting a result that carries a handoff also binds the step it feeds.
export async function acceptProductionCandidate(
  plan: ProductionWorkcells,
  candidate: Variant<ProductionPending, "recording">,
): Promise<ProductionWorkcellsResult> {
  const accepted = acceptProductionRecording(
    plan,
    candidate.fingerprint,
    candidate.operationId,
    candidate.recording,
    candidate.handoff,
  );
  if (
    accepted.kind === "rejected" ||
    physicsOutcome(candidate.recording).kind !== "completed"
  )
    return accepted;
  for (const next of accepted.plan.planned)
    if (
      next.predecessorId === candidate.operationId &&
      (candidate.handoff !== null || next.skill.kind === "restage")
    )
      return bindProductionSuccessor(accepted.plan, candidate.operationId);
  return accepted;
}

// The session a rehearsal plan opens with; keepView leaves selection and time.
export function rehearsalSessionPatch(
  session: ProductionSession,
  plan: ProductionWorkcells,
  notice: string,
  keepView: boolean,
  layout: ScheduleSpatialLayout | null,
  readOnly: readonly string[] = [],
): Partial<ProductionSession> {
  const applied = readyProduction(plan, layout);
  const first = plan.operations[0];
  return {
    data: applied,
    preview: applied,
    pending: { kind: "none" },
    rehearsalReview: null,
    readOnly,
    notice,
    presentation: rehearsalPositions(plan, session.presentation),
    ...(keepView || first === undefined
      ? {}
      : {
          cursor: { time: 0, playback: "paused" as const },
          operationId: first.id,
          selection: { kind: "batch" as const, id: first.batchId },
        }),
  };
}

// Rehearsal cards sit in rows by tray and columns by step.
export function rehearsalPositions(
  plan: ProductionWorkcells,
  current: ProductionPresentation,
): ProductionPresentation {
  const positions: Record<string, ProductionPresentation[string]> = {};
  const trays = plan.operations.filter(isRoot).map(operationBatch);
  for (const operation of [...plan.operations, ...plan.planned])
    positions[operation.id] = current[operation.id] ?? {
      x: 24 + (operation.step - 1) * 190,
      y: 24 + Math.max(0, trays.indexOf(operation.batchId)) * 145,
    };
  return positions;
}

export function stepName(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): string {
  if (operation.attempt === undefined && operation.skill.kind === "restage")
    return "Human restage → cell 2 table to rack";
  if (operation.attempt === undefined)
    return operation.skill.kind === "unload"
      ? "Retrieval"
      : `Racking${operation.skill.rackCase === "slip" ? " (slip)" : ""}`;
  const input = operation.attempt.input;
  switch (input.kind) {
    case "transfer":
      return input.request.bakeryTaskId === "table-to-oven"
        ? "Loading"
        : "Table to rack";
    case "native-cycle":
      return "Oven cycle";
    case "oven-cycle":
      return operation.start.kind === "reset" ? "Oven cycle" : "Retrieval";
    case "rack-cycle":
      return operation.start.kind === "reset"
        ? "Oven → table → rack"
        : `Racking${input.rackPlan.rackRequest.case === "slip" ? " (slip)" : ""}`;
  }
}

export function stepLabel(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): string {
  return `Tray ${operation.batchId} · step ${operation.step} · ${stepName(operation)}`;
}

function isLayoutRoot(operation: ProductionWorkcell): boolean {
  return (
    operation.step === 1 &&
    operation.start.kind === "reset" &&
    supportsRackLayout(operation.attempt)
  );
}
function inBatch(
  batchId: string | null,
  operation: ProductionWorkcell,
): boolean {
  return operation.batchId === batchId;
}
function hasOperationId(id: string, operation: ProductionWorkcell): boolean {
  return operation.id === id;
}
function isRoot(operation: ProductionWorkcell): boolean {
  return operation.step === 1;
}
function operationBatch(operation: ProductionWorkcell): string {
  return operation.batchId;
}
