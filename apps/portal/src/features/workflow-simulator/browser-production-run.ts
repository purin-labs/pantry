import type { PhysicsRequest } from "@purin-labs/bakery-model/bakery-physics";
import type {
  BrowserPhysicsOutcome,
  EngineJobs,
  JobProgress,
} from "../production-run/engine-jobs";
import {
  nextProductionExecution,
  type ExecutableProductionOperation,
} from "@purin-labs/production-simulation/simulator/production-execution";
import {
  acceptProductionRecording,
  bindProductionSuccessor,
  replaceProductionRequest,
  type ProductionWorkcells,
  type ProductionWorkcellsResult,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import {
  simulateProduction,
  type ScheduleSpatialLayout,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import {
  compileNativeCycleInput,
  compileWorkcellInput,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-input";

type Physics = Pick<EngineJobs, "execute" | "stop" | "running">;
type Handlers = Readonly<{
  commit(
    previous: ProductionWorkcells,
    next: ProductionWorkcells,
    operationId: string,
  ): Promise<boolean>;
  progress(operationId: string, progress: JobProgress): void;
  finished(message: string): void;
  failed(message: string): void;
  // Review mode hands one step's checked result back unaccepted.
  reviewed?(step: ProductionStepResult): void;
}>;
export type ProductionStepResult = Readonly<{
  plan: ProductionWorkcells;
  operationId: string;
  outcome: BrowserPhysicsOutcome;
  handoff: BrowserPhysicsOutcome["handoff"];
}>;
type Execution = {
  plan: ProductionWorkcells;
  layout: ScheduleSpatialLayout | null;
  handlers: Handlers;
  review: string | null;
};

// The route owns this runner and the shared physics job. The production
// scheduler chooses each native operation; only committed results survive Stop.
export class BrowserProductionRun {
  private active: Execution | null = null;
  private readonly physics: Physics;
  constructor(physics: Physics) {
    this.physics = physics;
  }

  get running(): boolean {
    return this.active !== null;
  }

  // Review mode runs only the named awaited step and does not accept it.
  start(
    plan: ProductionWorkcells,
    layout: ScheduleSpatialLayout | null,
    handlers: Handlers,
    review: string | null = null,
  ): void {
    if (this.running || this.physics.running) return;
    const execution: Execution = { plan, layout, handlers, review };
    this.active = execution;
    void this.advance(execution);
  }

  stop(): void {
    if (!this.running) return;
    this.active = null;
    this.physics.stop();
  }

  private async advance(execution: Execution): Promise<void> {
    try {
      while (this.active === execution) {
        const next = nextProductionExecution(
          execution.plan,
          simulateProduction(execution.plan, execution.layout),
        );
        if (next.kind !== "execute") {
          if (execution.review !== null) throw new Error(next.message);
          this.active = null;
          execution.handlers.finished(
            next.kind === "complete"
              ? `Browser run complete. ${next.message}`
              : `Browser run stopped. ${next.message}`,
          );
          return;
        }
        const operation = next.operation;
        if (execution.review !== null && execution.review !== operation.id)
          throw new Error(
            "The rehearsal awaits a different step. The result was not run.",
          );
        const outcome = await this.physics.execute(
          next.task,
          this.prepared.bind(this, execution, operation),
          execution.handlers.progress.bind(null, operation.id),
        );
        if (this.active !== execution) return;
        // Keep continuation state only where a planned successor consumes it.
        const successor = execution.plan.planned.some(
          followsOperation.bind(null, operation.id),
        );
        const accepted = acceptProductionRecording(
          execution.plan,
          execution.plan.fingerprint,
          operation.id,
          outcome.recording,
          successor ? outcome.handoff : null,
        );
        if (execution.review !== null) {
          if (accepted.kind === "rejected") throw new Error(accepted.message);
          this.active = null;
          execution.handlers.reviewed?.({
            plan: execution.plan,
            operationId: operation.id,
            outcome,
            handoff: successor ? outcome.handoff : null,
          });
          return;
        }
        const bound =
          accepted.kind === "ready" && successor
            ? await bindProductionSuccessor(accepted.plan, operation.id)
            : accepted;
        if (!(await this.commit(execution, bound, operation.id))) return;
      }
    } catch (error) {
      if (this.active !== execution) return;
      this.active = null;
      execution.handlers.failed(
        error instanceof Error ? error.message : "The browser run failed.",
      );
    }
  }

  // A first skill adopts the worker's browser-built request. A continuation's
  // request derives from its handoff, so the worker must prepare it exactly.
  private async prepared(
    execution: Execution,
    operation: ExecutableProductionOperation,
    request: PhysicsRequest,
  ): Promise<boolean> {
    if (this.active !== execution) return false;
    if (
      operation.start.kind === "continuation" ||
      operation.start.kind === "restaged"
    )
      return (
        JSON.stringify(operation.attempt.input.request) ===
        JSON.stringify(request)
      );
    const input =
      operation.attempt.input.kind === "native-cycle"
        ? compileNativeCycleInput(
            request,
            "0",
            operation.attempt.input.bindings.cell,
          )
        : compileWorkcellInput(
            request,
            "0",
            operation.attempt.input.bindings.cell,
          );
    if (input.kind === "invalid") throw new Error(input.message);
    return this.commit(
      execution,
      await replaceProductionRequest(
        execution.plan,
        execution.plan.fingerprint,
        operation.id,
        input.input,
      ),
      operation.id,
    );
  }

  private async commit(
    execution: Execution,
    result: ProductionWorkcellsResult,
    operationId: string,
  ): Promise<boolean> {
    if (this.active !== execution) return false;
    if (result.kind === "rejected") throw new Error(result.message);
    const committed = await execution.handlers.commit(
      execution.plan,
      result.plan,
      operationId,
    );
    if (this.active !== execution) return false;
    if (!committed)
      throw new Error(
        "The production run changed. Browser execution stopped before applying its result.",
      );
    execution.plan = result.plan;
    return true;
  }
}

function followsOperation(
  predecessorId: string,
  operation: ProductionWorkcells["planned"][number],
): boolean {
  return operation.predecessorId === predecessorId;
}
