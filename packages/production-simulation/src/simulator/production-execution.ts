import type { BrowserPhysicsTask } from "./browser-physics-task";
import type {
  ProductionWorkcell,
  ProductionWorkcells,
} from "../recipes/bakery/production-workcells.ts";
import type {
  Handoff,
  Run,
} from "../recipes/bakery/schedule.ts";
import type { WaitingAttempt } from "../recipes/bakery/workcell-attempt.ts";

export type ExecutableProductionOperation = ProductionWorkcell &
  Readonly<{ attempt: WaitingAttempt }>;
export type ProductionExecution =
  | Readonly<{
      kind: "execute";
      operation: ExecutableProductionOperation;
      task: BrowserPhysicsTask;
      message?: never;
    }>
  | Readonly<{
      kind: "complete" | "stopped";
      message: string;
      operation?: never;
      task?: never;
    }>;

// The scheduler decides which native operation runs next: the one it holds at
// its earliest dispatch boundary. Accepting it recompiles the logical schedule
// before a later boundary can dispatch, including work in another cell.
export function nextProductionExecution(
  plan: ProductionWorkcells,
  run: Run,
): ProductionExecution {
  for (const hold of run.nativeHolds) {
    if (hold.kind !== "awaiting-evidence") continue;
    const operation = plan.operations.find(
      matchesOperation.bind(null, hold.operation.id),
    );
    if (operation === undefined || !executable(operation))
      return {
        kind: "stopped",
        message: "The awaiting native operation is not part of this run.",
      };
    const task = browserTask(operation);
    if (task === null)
      return {
        kind: "stopped",
        message: `${operationLabel(operation, plan.procedure)} replays recorded evidence only. Open its recorded result or start the tray from loading.`,
      };
    return { kind: "execute", operation, task };
  }
  // An assumed recovery releases the cell, so independent trays continue.
  for (const hold of run.nativeHolds) {
    if (hold.kind === "failed" && hold.recoveredAt === null)
      return {
        kind: "stopped",
        message: `${operationLabel(hold.operation, plan.procedure)} failed. Its tray and the cell remain held until recovery.`,
      };
  }
  for (const failure of run.handlingFailures) {
    if (failure.recoveredAt === null)
      return {
        kind: "stopped",
        message: `${handlingLabel(failure.task, plan.procedure)} failed (injected). Its tray and the cell remain held until recovery.`,
      };
  }
  const remaining =
    plan.operations.filter(executable).length + plan.planned.length;
  if (remaining > 0)
    return {
      kind: "stopped",
      message: `${remaining} native ${remaining === 1 ? "operation cannot" : "operations cannot"} start in this run. Review the Timeline waits.`,
    };
  // Recovered failures leave nothing to execute, but their trays never finish.
  for (const failure of run.handlingFailures)
    return {
      kind: "stopped",
      message: `${handlingLabel(failure.task, plan.procedure)} failed; the recovery released the cell, but its tray does not continue.`,
    };
  for (const hold of run.nativeHolds)
    if (hold.kind === "failed")
      return {
        kind: "stopped",
        message: `${operationLabel(hold.operation, plan.procedure)} failed; the recovery released the cell, but its tray does not continue.`,
      };
  return {
    kind: "complete",
    message: "Every native operation has a result.",
  };
}

// A first skill starts from its prepared fixture; a continuation resumes the
// exact state its predecessor handed off.
export function browserTask(
  operation: ExecutableProductionOperation,
): BrowserPhysicsTask | null {
  const input = operation.attempt.input;
  // A restored continuation without its handoff cannot resume physics state.
  if (operation.start.kind === "continued") return null;
  if (operation.start.kind === "continuation")
    return {
      kind: "continuation",
      handoff: operation.start.handoff,
      rackCase:
        input.kind === "rack-cycle" &&
        input.rackPlan.rackRequest.case === "slip"
          ? "slip"
          : "nominal",
    };
  switch (input.kind) {
    case "transfer":
      return {
        kind:
          operation.start.kind === "restaged" ? "prepared-request" : "request",
        mode:
          input.request.bakeryTaskId === "table-to-oven" &&
          input.request.case === "nominal"
            ? "loading"
            : "transfer",
        request: input.request,
      };
    case "native-cycle":
      return {
        kind:
          operation.start.kind === "restaged" ? "prepared-request" : "request",
        mode: "oven-handoff",
        request: input.request,
      };
    case "oven-cycle":
    case "rack-cycle":
      return null;
  }
}

export function operationLabel(
  operation: ProductionWorkcell,
  procedure: ProductionWorkcells["procedure"],
): string {
  return procedure === "rehearsal"
    ? `Tray ${operation.batchId} step ${operation.step}`
    : `Batch ${operation.batchId} · tray ${operation.tray} transfer`;
}

function handlingLabel(
  task: Handoff,
  procedure: ProductionWorkcells["procedure"],
): string {
  const phase =
    task.phase === "transfer"
      ? "human transfer"
      : task.phase === "stage"
        ? "staging"
        : "clearance";
  return procedure === "rehearsal"
    ? `Tray ${task.batch} ${phase}`
    : `Batch ${task.batch} · ${phase}`;
}

function executable(
  operation: ProductionWorkcell,
): operation is ExecutableProductionOperation {
  return operation.attempt.kind === "awaiting-evidence";
}

function matchesOperation(id: string, operation: ProductionWorkcell): boolean {
  return operation.id === id;
}
