import {
  lateOrders,
  runFindings,
  type RunFinding,
} from "@purin-labs/bakery-workflow/findings";
import type {
  CompiledScenario,
  HostView,
  LogisticsView,
} from "@purin-labs/production-simulation";
import { isRecord } from "@purin-labs/std";
import type { PersistentCell } from "@purin-labs/bakery-model/bakery-physics";
import { openExecutionWorker, type ExecutionWorker } from "./execution-client";

type DraftRunResult = Readonly<{
  status: string;
  endSeconds: number;
  completedTasks: number;
  skippedTasks: number;
  /** Customer orders that waited too long or did not finish. */
  lateOrders: number;
  orders: number;
  findings: readonly RunFinding[];
  logistics: LogisticsView;
}>;

/**
 * A run to its end in the retained engine, then disposed, so that the worker
 * can begin the next run. Each review gets one outcome.
 */
async function driveToEnd(
  worker: ExecutionWorker,
  scenario: CompiledScenario,
  cells: readonly PersistentCell[],
  review: "accept" | "reject",
): Promise<DraftRunResult> {
  let view = hostView(
    await worker.request({
      kind: "begin",
      bundle: worker.manifest.bundle,
      cells,
      identity: {
        runId: crypto.randomUUID(),
        executionId: crypto.randomUUID(),
        hostSession: crypto.randomUUID(),
        parent: null,
      },
      origin: { kind: "scenario", scenario },
    }),
  );
  for (let turn = 0; turn < 20_000; turn++) {
    switch (view.status.kind) {
      case "awaiting-inspection": {
        const pending = view.inspections.find(isPending);
        if (pending === undefined)
          throw new Error("The run waits for a review that it does not name.");
        view = hostView(
          await worker.request({
            kind: "inspect",
            commandId: crypto.randomUUID(),
            expectedControlRevision: view.controlRevision,
            task: pending.task,
            definition: pending.definition,
            lots: pending.lots,
            outcome: review,
            note: "Draft comparison",
          }),
        );
        continue;
      }
      case "completed":
      case "blocked":
      case "stopped-at-limit": {
        const outcome = result(view, scenario);
        await worker.request({ kind: "dispose" });
        return outcome;
      }
      default:
        view = hostView(
          await worker.request({
            kind: "drive",
            turns: 128,
            until: scenario.limits.horizon,
          }),
        );
    }
  }
  throw new Error("The run exceeded its execution bound.");
}

function hostView(reply: unknown): HostView {
  if (isRecord(reply) && reply.kind === "refused")
    throw new Error(`The engine refused the run: ${String(reply.reason)}.`);
  if (!isRecord(reply) || !isRecord(reply.view))
    throw new Error("The engine returned no view.");
  return reply.view as unknown as HostView;
}

function isPending(item: HostView["inspections"][number]): boolean {
  return item.kind === "pending";
}

function result(view: HostView, scenario: CompiledScenario): DraftRunResult {
  let completedTasks = 0;
  let skippedTasks = 0;
  if (view.logistics.kind === "available")
    for (const task of view.logistics.tasks) {
      if (task.kind === "completed") completedTasks++;
      if (task.kind === "skipped") skippedTasks++;
    }
  return {
    status: view.status.kind,
    endSeconds: view.time / 1_000_000,
    completedTasks,
    skippedTasks,
    lateOrders: lateOrders(view, scenario).length,
    orders:
      view.production.kind === "available" ? view.production.orders.length : 0,
    findings: runFindings(view, scenario),
    logistics: view.logistics,
  };
}

export type DraftComparison = Readonly<{
  applied: DraftRunResult;
  draft: DraftRunResult;
}>;

export type DraftRunHandle = Readonly<{
  result: Promise<DraftComparison>;
  cancel(): void;
}>;

/**
 * Two separate runs in one worker. Neither one touches the run that the page
 * shows. The draft runs second in the same worker, so it reuses each physics
 * result of the applied run that its edit does not change (Refactor 16,
 * step 4).
 */
export function runDraftComparison(
  applied: CompiledScenario,
  draft: CompiledScenario,
  cells: readonly PersistentCell[],
  review: "accept" | "reject",
): DraftRunHandle {
  let worker: ExecutionWorker | null = null;
  let cancelled = false;
  async function both(): Promise<DraftComparison> {
    const opened = await openExecutionWorker(null);
    if (!opened.ok)
      throw new Error(`The engine did not start: ${opened.error.code}.`);
    worker = opened.value;
    try {
      if (cancelled) throw new Error("The comparison was cancelled.");
      const appliedResult = await driveToEnd(worker, applied, cells, review);
      if (cancelled) throw new Error("The comparison was cancelled.");
      return {
        applied: appliedResult,
        draft: await driveToEnd(worker, draft, cells, review),
      };
    } finally {
      worker.terminate();
      worker = null;
    }
  }
  return {
    result: both(),
    cancel() {
      cancelled = true;
      worker?.terminate();
    },
  };
}
