import {
  batchSpec,
  blendActions,
  chillerActions,
  dishwasherActions,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
  grindActions,
  heatedFrotherActions,
  hobPowerActions,
  ovenBakeActions,
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
  blackSesameRecipeInput,
  compileBlackSesameRecipe,
  type BlackSesameProblem,
} from "./black-sesame.ts";

function isBlackSesameWorkflow(workflowId: string): boolean {
  return workflowId === "sesame-batch" || workflowId === "sesame-drink";
}

export function blackSesameApplianceTask(
  task: ScheduledTaskDescriptor,
): RecipeApplianceTaskBinding | null {
  if (!isBlackSesameWorkflow(task.workflowId)) return null;
  const key = task.taskKey;
  if (
    key === "weigh-sesame" ||
    key === "weigh-starch" ||
    key === "weigh-sugar" ||
    key === "weigh-salt" ||
    key === "weigh-water" ||
    key === "scrape-and-weigh" ||
    key === "standardize-mass" ||
    key === "wash-and-fill-bottle-a" ||
    key === "wash-and-fill-bottle-b" ||
    key === "dose"
  ) {
    const fallbackKg =
      key === "weigh-sesame"
        ? 0.22
        : key === "weigh-starch"
          ? 0.018
          : key === "weigh-sugar"
            ? 0.12
            : key === "weigh-salt"
              ? 0.002
              : key === "weigh-water"
                ? 0.4
                : key === "scrape-and-weigh"
                  ? 0.74
                  : key === "standardize-mass"
                    ? 0.76
                    : key.startsWith("wash-and-fill-bottle-")
                      ? 0.38
                      : 0.286;
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, fallbackKg),
      key === "scrape-and-weigh" || key === "standardize-mass" ? 30 : 20,
      3400,
      1.03,
      0.1,
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
      label: `Black sesame ${key}`,
      batch,
      buildActions: () => weighActions(batch),
    };
  }
  if (key === "roast-first-half" || key === "roast-second-half") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.22),
      key === "roast-second-half" ? 28 : 20,
      2100,
      0.68,
      0.25,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "oven",
      appliance: "maruzen-mbco-5e",
      label: `Black sesame ${key}`,
      batch,
      buildActions: (context) => ovenBakeActions(batch, 55, 10, context),
    };
  }
  if (key === "cool-roasted-seeds" || key === "cool-in-bath") {
    const fallbackKg = key === "cool-roasted-seeds" ? 0.22 : 0.76;
    const initialTempC = key === "cool-roasted-seeds" ? 34 : 32;
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, fallbackKg),
      initialTempC,
      3400,
      1.04,
      0.2,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "chiller",
      appliance: "hoshizaki-rt-120snj",
      label: `Black sesame ${key}`,
      batch,
      buildActions: () => chillerActions(batch, 6),
    };
  }
  if (key.startsWith("grind-")) {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.055),
      24,
      2100,
      0.65,
      25,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "grinder",
      appliance: "waring-wsg60",
      label: `Black sesame ${key}`,
      batch,
      buildActions: () => grindActions(batch, 3),
    };
  }
  if (
    key === "cook-slurry-continuous-stir" ||
    key === "dissolve-sugar-and-salt"
  ) {
    const fallbackKg =
      key === "cook-slurry-continuous-stir" ? 0.638 : 0.748;
    const percent = key === "cook-slurry-continuous-stir" ? 55 : 40;
    const defaultTempC = key === "cook-slurry-continuous-stir" ? 22 : 28;
    const baseBatch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, fallbackKg),
      defaultTempC,
      3600,
      1.05,
      0.18,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "hob",
      appliance: "maruzen-mih-02c",
      label: `Black sesame ${key}`,
      batch: baseBatch,
      buildActions: (context) => {
        const tempC =
          key === "dissolve-sugar-and-salt" &&
          context.previousInstanceBatchTemperatureC !== null
            ? Math.max(
                22,
                Math.min(70, context.previousInstanceBatchTemperatureC),
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
  if (key === "blend") {
    const batch = batchSpec(
      `${task.instanceId}-blend`,
      taskMaterialMassKg(task.definition, 0.748),
      32,
      3500,
      1.06,
      2.5,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "blender",
      appliance: "vitamix-quiet-one",
      label: "Blend black sesame concentrate",
      batch,
      buildActions: () => blendActions(batch, 45, 4),
    };
  }
  if (key === "heat-and-mix") {
    const batch = batchSpec(
      `${task.instanceId}-drink`,
      taskMaterialMassKg(task.definition, 0.286),
      38,
      3900,
      1.03,
      2.0,
    );
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "milk-frother",
      appliance: "severin-sm-3587",
      label: "Heat and froth black sesame milk drink",
      batch,
      buildActions: (context) => heatedFrotherActions(batch, 45, context),
    };
  }
  if (key === "clean-batch-vessels" || key === "wash-jug") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      key === "wash-jug" ? 0.25 : 0.5,
      26,
      1000,
      1.15,
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
      label: `Black sesame ${key}`,
      batch,
      buildActions: () =>
        dishwasherActions(batch, key === "wash-jug" ? 5 : 6),
    };
  }
  return null;
}

export function blackSesameApplianceTasks(
  source: ScheduledTaskSource,
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    const bound = blackSesameApplianceTask(task);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export async function executeBlackSesameApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(
    blackSesameApplianceTasks(source),
    runtime,
    { runId: options.runId ?? "black-sesame-appliance-wasm", ...options },
  );
}
