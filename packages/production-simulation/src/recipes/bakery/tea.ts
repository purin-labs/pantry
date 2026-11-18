import {
  batchSpec,
  dishwasherActions,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
  hobPowerActions,
  hobTemperatureActions,
  taskMaterialMassKg,
  weighActions,
  type ApplianceWasmRuntimeSource,
  type RecipeApplianceExecutionOptions,
  type RecipeApplianceExecutionReport,
  type RecipeApplianceTaskBinding,
  type ScheduledTaskDescriptor,
  type ScheduledTaskSource,
} from "./appliance-execution.ts";
export {
  compileGingerBlackTeaRecipe,
  gingerBlackTeaRecipeInput,
} from "./ginger-black-tea.ts";
export {
  compileGingerMilkTeaRecipe,
  gingerMilkTeaRecipeInput,
} from "./ginger-milk-tea.ts";
export { teaStrainTiming, type TeaStrainTiming } from "./tea-process.ts";

function isBlackTeaWorkflow(workflowId: string): boolean {
  return workflowId === "ginger-tea-batch";
}

function isMilkTeaWorkflow(workflowId: string): boolean {
  return (
    workflowId === "ginger-milk-tea-batch" ||
    workflowId === "clean-initial-pan"
  );
}

function isTeaWorkflow(workflowId: string): boolean {
  return isBlackTeaWorkflow(workflowId) || isMilkTeaWorkflow(workflowId);
}

function parseFinishingTargetC(key: string): number {
  const match = /^heat-and-stir-to-(\d+)c$/u.exec(key);
  if (match === null || match[1] === undefined) return 75;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.max(45, Math.min(90, parsed)) : 75;
}

export function teaApplianceTask(
  task: ScheduledTaskDescriptor,
): RecipeApplianceTaskBinding | null {
  if (!isTeaWorkflow(task.workflowId)) return null;
  const key = task.taskKey;
  const milkTea = isMilkTeaWorkflow(task.workflowId);

  if (
    key === "prepare-ginger-and-water" ||
    key === "add-tea-and-cover" ||
    key === "strain-and-sweeten" ||
    key === "add-tea" ||
    key.startsWith("add-milk-and-sugar-at-")
  ) {
    const fallbackKg =
      key === "prepare-ginger-and-water"
        ? milkTea
          ? 0.415
          : 0.465
        : key === "add-tea-and-cover"
          ? 0.453
          : key === "strain-and-sweeten"
            ? 0.435
            : key === "add-tea"
              ? 0.404
              : 0.569;
    const defaultTempC =
      key === "prepare-ginger-and-water"
        ? 20
        : key.startsWith("add-milk-and-sugar-at-")
          ? 52
          : 35;
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, fallbackKg),
      defaultTempC,
      4050,
      1.01,
      0.04,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "weigh",
      appliance: "ohaus-ranger-3000",
      label: `Tea ${key}`,
      batch,
      buildActions: () => weighActions(batch),
    };
  }

  if (
    key === "heat-to-simmer" ||
    key === "simmer-ginger" ||
    key === "simmer-tea"
  ) {
    const appliance = milkTea ? "vollrath-59500p" : "maruzen-mih-02c";
    const fallbackKg = milkTea ? 0.415 : 0.465;
    const percent =
      key === "heat-to-simmer" ? 55 : key === "simmer-ginger" ? 38 : 30;
    const defaultTempC =
      key === "heat-to-simmer" ? 20 : key === "simmer-ginger" ? 26 : 32;
    const baseBatch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, fallbackKg),
      defaultTempC,
      4100,
      1.0,
      0.03,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "hob",
      appliance,
      label: `Tea ${key}`,
      batch: baseBatch,
      buildActions: (context) => {
        const tempC =
          key !== "heat-to-simmer" &&
          context.previousInstanceBatchTemperatureC !== null
            ? Math.max(
                22,
                Math.min(72, context.previousInstanceBatchTemperatureC),
              )
            : defaultTempC;
        return hobPowerActions(
          { ...baseBatch, temperature_c: Number(tempC.toFixed(3)) },
          percent,
          5,
        );
      },
    };
  }

  if (key === "heat-cup-preheat-water") {
    const batch = batchSpec(
      `${task.instanceId}-cup-preheat`,
      taskMaterialMassKg(task.definition, 0.3),
      20,
      4180,
      1.0,
      0.02,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "hob",
      appliance: "vollrath-59500p",
      label: "Heat cup-preheat water on induction hob",
      batch,
      buildActions: () => hobTemperatureActions(batch, 65, 5),
    };
  }

  if (key.startsWith("heat-and-stir-to-")) {
    const targetC = parseFinishingTargetC(key);
    const defaultTempC = Math.max(50, targetC - 12);
    const baseBatch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.569),
      defaultTempC,
      3950,
      1.02,
      0.05,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "hob",
      appliance: "vollrath-59500p",
      label: `Ginger milk tea ${key}`,
      batch: baseBatch,
      buildActions: (context) => {
        const tempC =
          context.previousInstanceBatchTemperatureC !== null &&
          context.previousInstanceBatchTemperatureC >= 45
            ? Math.min(targetC - 2, context.previousInstanceBatchTemperatureC)
            : defaultTempC;
        return hobTemperatureActions(
          { ...baseBatch, temperature_c: Number(tempC.toFixed(3)) },
          targetC,
          5,
        );
      },
    };
  }

  if (
    key === "wash-equipment" ||
    key === "wash-initial-pan" ||
    key === "wash-pan-a" ||
    key === "wash-pan-b-and-strainer"
  ) {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      key === "wash-equipment" || key === "wash-pan-b-and-strainer"
        ? 0.4
        : 0.35,
      26,
      950,
      1.2,
      0.02,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "dishwasher",
      appliance: "winterhalter-uc-l",
      label: `Tea ${key}`,
      batch,
      buildActions: () => dishwasherActions(batch, 6),
    };
  }

  return null;
}

export function gingerBlackTeaApplianceTasks(
  source: ScheduledTaskSource,
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    if (!isBlackTeaWorkflow(task.workflowId)) continue;
    const bound = teaApplianceTask(task);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export function gingerMilkTeaApplianceTasks(
  source: ScheduledTaskSource,
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    if (!isMilkTeaWorkflow(task.workflowId)) continue;
    const bound = teaApplianceTask(task);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export function teaApplianceTasks(
  source: ScheduledTaskSource,
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    const bound = teaApplianceTask(task);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export async function executeGingerBlackTeaApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(
    gingerBlackTeaApplianceTasks(source),
    runtime,
    { runId: options.runId ?? "ginger-black-tea-appliance-wasm", ...options },
  );
}

export async function executeGingerMilkTeaApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(
    gingerMilkTeaApplianceTasks(source),
    runtime,
    { runId: options.runId ?? "ginger-milk-tea-appliance-wasm", ...options },
  );
}

export async function executeTeaApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(teaApplianceTasks(source), runtime, {
    runId: options.runId ?? "tea-appliance-wasm",
    ...options,
  });
}
