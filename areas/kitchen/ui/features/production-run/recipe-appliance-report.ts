import {
  parseApplianceResult,
  type ApplianceName,
  type ApplianceRequest,
  type ApplianceResult,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";
import type {
  CompiledScenario,
  LogisticsView,
  TaskDefinition,
  TaskView,
} from "@purin-labs/production-simulation";
import {
  applianceTaskRisk,
  atRiskTasksFromApplianceReport,
  executeRecipeApplianceTasks,
  type ApplianceAttemptRunner,
  type ApplianceTaskRisk,
  type ExecutedApplianceTaskRecord,
  type RecipeApplianceExecutionReport,
  type RecipeApplianceTaskBinding,
  type ScheduledTaskDescriptor,
} from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";
import { recipeApplianceTask } from "@purin-labs/production-simulation/recipes/bakery/appliance-task-table";
import { isRecord } from "@purin-labs/std";
import { openExecutionWorker, type ExecutionWorker } from "./execution-client";

export type ScenarioTaskLookup = Readonly<{
  byArrivalPrefix: ReadonlyMap<string, string>;
  definitions: ReadonlyMap<string, TaskDefinition>;
}>;

/** Maps scenario arrival prefixes and `${workflow}/${taskKey}` definitions once. */
export function buildScenarioTaskLookup(
  scenario: CompiledScenario,
): ScenarioTaskLookup {
  const byArrivalPrefix = new Map<string, string>();
  for (const arrival of scenario.arrivals) {
    byArrivalPrefix.set(arrival.id, arrival.workflow);
  }
  const definitions = new Map<string, TaskDefinition>();
  for (const wf of scenario.workflows) {
    byArrivalPrefix.set(wf.id, wf.id);
    for (const td of wf.tasks) {
      definitions.set(`${wf.id}/${td.key}`, td);
    }
  }
  return { byArrivalPrefix, definitions };
}

/** Converts one host LogisticsView task into a ScheduledTaskDescriptor. */
export function taskDescriptorFromView(
  task: TaskView,
  lookup: ScenarioTaskLookup,
): ScheduledTaskDescriptor | null {
  if (task.subject.kind !== "workflow") return null;
  const instanceId = task.subject.instance;
  const taskKey = task.subject.key;
  const hashIdx = instanceId.lastIndexOf("#");
  const prefix = hashIdx >= 0 ? instanceId.slice(0, hashIdx) : instanceId;
  const workflowId = lookup.byArrivalPrefix.get(prefix) ?? prefix;
  const definition = lookup.definitions.get(`${workflowId}/${taskKey}`) ?? null;
  const startedAtUs =
    task.kind === "executing" ||
    task.kind === "completed" ||
    task.kind === "failed" ||
    task.kind === "recovery-required" ||
    task.kind === "recovering" ||
    task.kind === "recovery-failed"
      ? task.startedAt
      : 0;
  const completedAtUs =
    task.kind === "completed"
      ? task.completedAt
      : task.kind === "executing" && task.completesAt !== null
        ? task.completesAt
        : startedAtUs + 30_000_000;
  return {
    taskId: task.id,
    instanceId,
    workflowId,
    taskKey,
    startedAtUs,
    completedAtUs,
    definition,
  };
}

function compareScheduledTasks(
  a: ScheduledTaskDescriptor,
  b: ScheduledTaskDescriptor,
): number {
  if (a.startedAtUs !== b.startedAtUs) return a.startedAtUs - b.startedAtUs;
  if (a.completedAtUs !== b.completedAtUs)
    return a.completedAtUs - b.completedAtUs;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** Extracts completed workflow tasks and their bound MuJoCo appliance checks. */
export function applianceBindingsFromLogistics(
  scenario: CompiledScenario,
  logistics: LogisticsView,
  espressoAppliance: "linea" | "eagle-one" = "linea",
): Readonly<{
  scheduledTasks: readonly ScheduledTaskDescriptor[];
  bindings: readonly RecipeApplianceTaskBinding[];
}> {
  if (logistics.kind !== "available") {
    return { scheduledTasks: [], bindings: [] };
  }
  const lookup = buildScenarioTaskLookup(scenario);
  const scheduledTasks: ScheduledTaskDescriptor[] = [];
  for (const task of logistics.tasks) {
    if (task.kind !== "completed") continue;
    const descriptor = taskDescriptorFromView(task, lookup);
    if (descriptor !== null) scheduledTasks.push(descriptor);
  }
  scheduledTasks.sort(compareScheduledTasks);
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of scheduledTasks) {
    const bound = recipeApplianceTask(task, { espressoAppliance });
    if (bound !== null) bindings.push(bound);
  }
  return { scheduledTasks, bindings };
}

/** Infers the espresso machine variant from a scenario's cells/resources. */
export function espressoVariantForScenario(
  scenario: CompiledScenario,
): "linea" | "eagle-one" {
  for (const cell of scenario.cells) {
    if (cell.id.includes("eagle-one")) return "eagle-one";
  }
  for (const resource of scenario.resources) {
    if (resource.id.includes("eagle-one")) return "eagle-one";
  }
  return "linea";
}

/**
 * Adapts a browser ExecutionWorker's `appliance-run` RPC into the shared
 * `ApplianceAttemptRunner` consumed by `executeRecipeApplianceTasks`.
 * Resets the worker's Wasm instance every `resetInterval` attempts without
 * re-fetching any model packs.
 */
function createWorkerApplianceRunner(
  worker: ExecutionWorker,
  resetInterval = 15,
): ApplianceAttemptRunner {
  let executed = 0;
  return {
    async runAttempt(
      request: ApplianceRequest,
      taskId: string,
      appliance: ApplianceName,
    ): Promise<ApplianceResult> {
      if (resetInterval > 0 && executed > 0 && executed % resetInterval === 0) {
        const resetReply = await worker.request({ kind: "reset" });
        if (!isRecord(resetReply) || resetReply.kind !== "reset") {
          throw new Error(
            `Could not reset Wasm appliance module before ${taskId} (${appliance}).`,
          );
        }
      }
      const reply = await worker.request({
        kind: "appliance-run",
        file: request.file,
      });
      executed += 1;
      if (
        !isRecord(reply) ||
        reply.kind !== "appliance-result" ||
        typeof reply.file !== "string"
      ) {
        const detail =
          isRecord(reply) && typeof reply.detail === "string"
            ? `: ${reply.detail}`
            : isRecord(reply) && typeof reply.reason === "string"
              ? `: ${reply.reason}`
              : "";
        throw new Error(
          `Appliance check failed on ${taskId} (${appliance})${detail}`,
        );
      }
      return parseApplianceResult(reply.file, request);
    },
  };
}

export type ApplianceReportState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{
      kind: "running";
      completed: number;
      total: number;
      partialRisks: ReadonlyMap<string, ApplianceTaskRisk>;
    }>
  | Readonly<{
      kind: "ready";
      report: RecipeApplianceExecutionReport;
      atRisk: ReadonlyMap<string, ApplianceTaskRisk>;
    }>
  | Readonly<{ kind: "failed"; message: string }>;

export type PortalApplianceReportResult = Readonly<{
  report: RecipeApplianceExecutionReport;
  atRisk: ReadonlyMap<string, ApplianceTaskRisk>;
}>;

/**
 * Runs recipe appliance physics in a dedicated background ExecutionWorker so
 * the primary production worker stays responsive for save, history, and control.
 */
export async function runPortalApplianceReport(
  params: Readonly<{
    runId: string;
    bindings: readonly RecipeApplianceTaskBinding[];
    scheduledTasks: readonly ScheduledTaskDescriptor[];
    signal: Readonly<{ aborted: boolean }>;
    onProgress?: (
      completed: number,
      total: number,
      record: ExecutedApplianceTaskRecord,
      risk: ApplianceTaskRisk | null,
    ) => void;
  }>,
): Promise<PortalApplianceReportResult> {
  const opened = await openExecutionWorker();
  if (!opened.ok) {
    throw new Error(
      `Cannot open appliance verification worker: ${opened.error.code}.`,
    );
  }
  const worker = opened.value;
  try {
    if (params.signal.aborted) {
      throw new Error("Appliance physics verification was cancelled.");
    }
    const runner = createWorkerApplianceRunner(worker);
    const report = await executeRecipeApplianceTasks(params.bindings, runner, {
      runId: params.runId,
      scheduledTasks: params.scheduledTasks,
      continueOnRejection: true,
      signal: params.signal,
      onProgress: (completed, total, record) => {
        params.onProgress?.(
          completed,
          total,
          record,
          applianceTaskRisk(record),
        );
      },
    });
    return {
      report,
      atRisk: atRiskTasksFromApplianceReport(report),
    };
  } finally {
    worker.terminate();
  }
}
