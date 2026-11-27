import type {
  ApplianceAction,
  ApplianceBatch,
  ApplianceName,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";
import {
  batchSpec,
  blendActions,
  chillerActions,
  dishwasherActions,
  espressoActions,
  extractScheduledTasks,
  grindActions,
  heatedFrotherActions,
  hobPowerActions,
  hobTemperatureActions,
  ovenBakeActions,
  ovenPreheatActions,
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
  planetaryMixActions,
  taskMaterialMassKg,
  weighActions,
  type ApplianceActionRowSpec,
  type ApplianceBatchRowSpec,
  type ApplianceKeyMatcher,
  type ApplianceTaskContext,
  type ApplianceTaskKind,
  type ApplianceTaskRow,
  type ApplianceWorkflowMatcher,
  type RecipeApplianceTaskBinding,
  type ScheduledTaskDescriptor,
  type ScheduledTaskSource,
} from "./appliance-execution.ts";
import { BLACK_SESAME_APPLIANCE_ROWS } from "./black-sesame-milk.ts";
import { ESPRESSO_APPLIANCE_ROWS } from "./espresso.ts";
import { FINANCIER_APPLIANCE_ROWS } from "./financier.ts";
import {
  FINANCIER_FLAVOUR_PRODUCTS,
  financierFlavourOf,
} from "./financier-flavours.ts";
import { PIE_APPLIANCE_ROWS } from "./pie.ts";
import { PIE_PRODUCTS, pieTypeOf } from "./pie-products.ts";
import { POUR_OVER_APPLIANCE_ROWS } from "./pour-over.ts";
import { TEA_APPLIANCE_ROWS } from "./tea.ts";

/**
 * Unified declarative table of every built-in recipe's MuJoCo appliance rows.
 * Order matches the combined bakery shift lookup priority.
 */
const RECIPE_APPLIANCE_ROWS: readonly ApplianceTaskRow[] = [
  ...FINANCIER_APPLIANCE_ROWS,
  ...PIE_APPLIANCE_ROWS,
  ...BLACK_SESAME_APPLIANCE_ROWS,
  ...TEA_APPLIANCE_ROWS,
  ...ESPRESSO_APPLIANCE_ROWS,
  ...POUR_OVER_APPLIANCE_ROWS,
];

const ANY_WORKFLOW: ApplianceWorkflowMatcher = {};

/**
 * Canonical task-kind rows used for recipes authored or renamed on the
 * Plan 84 workflow canvas (and recipes without bespoke rows such as latte/siphon).
 */
const CANONICAL_APPLIANCE_ROWS: readonly ApplianceTaskRow[] = [
  {
    recipe: "canvas",
    taskKind: "weigh",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["weigh", "dose"], prefixes: ["weigh-", "dose-"] },
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "Weigh {key}",
    batch: {
      massKg: 0.25,
      temperatureC: 20,
      specificHeat: 3200,
      densityKgL: 1.03,
      resistance: 0.1,
    },
    action: { kind: "weigh" },
  },
  {
    recipe: "canvas",
    taskKind: "grind",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["grind"], prefixes: ["grind-"] },
    category: "grinder",
    appliance: "waring-wsg60",
    label: "Grind {key}",
    batch: {
      massKg: 0.027,
      temperatureC: 22,
      specificHeat: 1500,
      densityKgL: 0.5,
      resistance: 25,
    },
    action: { kind: "grind", durationSeconds: 3 },
  },
  {
    recipe: "canvas",
    taskKind: "blend",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["blend"], prefixes: ["blend-"] },
    category: "blender",
    appliance: "vitamix-quiet-one",
    label: "Blend {key}",
    batch: {
      massKg: 0.5,
      temperatureC: 28,
      specificHeat: 3500,
      densityKgL: 1.05,
      resistance: 2.5,
    },
    action: { kind: "blend", percent: 45, durationSeconds: 4 },
  },
  {
    recipe: "canvas",
    taskKind: "planetary-mix",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["mix"], prefixes: ["mix-"] },
    category: "mixer",
    appliance: "hobart-hl200",
    label: "Mix {key}",
    batch: {
      massKg: 0.375,
      temperatureC: 20,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.35,
    },
    action: { kind: "planetary-mix", setting: 2, durationSeconds: 4 },
  },
  {
    recipe: "canvas",
    taskKind: "heated-frother",
    workflows: ANY_WORKFLOW,
    keys: {
      exact: ["heat-and-mix", "steam-stretch", "steam-whirlpool"],
      prefixes: ["froth-", "steam-"],
    },
    category: "milk-frother",
    appliance: "severin-sm-3587",
    label: "Heat and froth {key}",
    batch: {
      massKg: 0.25,
      temperatureC: 38,
      specificHeat: 3900,
      densityKgL: 1.03,
      resistance: 2.0,
    },
    action: { kind: "heated-frother", targetC: 45 },
  },
  {
    recipe: "canvas",
    taskKind: "espresso",
    workflows: ANY_WORKFLOW,
    keys: {
      exact: ["espresso-shot", "extract-espresso", "prepare-espresso"],
      prefixes: ["espresso-"],
    },
    category: "espresso",
    appliance: "la-marzocco-linea-classic-s-2g",
    useEspressoOption: true,
    label: "Extract espresso {key}",
    batch: {
      massKg: 0.018,
      massSource: "fixed",
      temperatureC: 24,
      specificHeat: 1500,
      densityKgL: 0.5,
      resistance: 0,
    },
    action: { kind: "espresso", durationSeconds: 6 },
  },
  {
    recipe: "canvas",
    taskKind: "oven-preheat",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["preheat", "preheat-oven"], prefixes: ["preheat-oven-"] },
    category: "oven",
    appliance: "maruzen-mbco-5e",
    label: "Preheat convection oven ({key})",
    batch: null,
    action: { kind: "oven-preheat", targetC: 55 },
  },
  {
    recipe: "canvas",
    taskKind: "oven-bake",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["bake", "roast"], prefixes: ["bake-", "roast-"] },
    category: "oven",
    appliance: "maruzen-mbco-5e",
    label: "Bake {key} in convection oven",
    batch: {
      massKg: 0.25,
      temperatureC: 18,
      specificHeat: 3100,
      densityKgL: 1.05,
      resistance: 0.35,
    },
    action: { kind: "oven-bake", targetC: 55, durationSeconds: 12 },
  },
  {
    recipe: "canvas",
    taskKind: "hob-temperature",
    workflows: ANY_WORKFLOW,
    keys: {
      exact: ["braise-filling", "preheat-seal", "upflow"],
      prefixes: ["heat-and-stir-to-", "heat-water", "braise-"],
    },
    category: "hob",
    appliance: "vollrath-59500p",
    label: "Heat {key} on induction hob",
    batch: {
      massKg: 0.4,
      temperatureC: 20,
      specificHeat: 4100,
      densityKgL: 1.0,
      resistance: 0.04,
    },
    action: { kind: "hob-temperature", targetC: 85, durationSeconds: 5 },
  },
  {
    recipe: "canvas",
    taskKind: "hob-power",
    workflows: ANY_WORKFLOW,
    keys: {
      exact: ["brown-butter", "sear-beef", "reduce-filling", "heat-to-simmer"],
      prefixes: ["simmer-", "heat-", "cook-", "sear-", "reduce-"],
    },
    category: "hob",
    appliance: "maruzen-mih-02c",
    label: "Cook {key} on induction hob",
    batch: {
      massKg: 0.35,
      temperatureC: 20,
      specificHeat: 3600,
      densityKgL: 1.0,
      resistance: 0.1,
    },
    action: { kind: "hob-power", percent: 55, durationSeconds: 5 },
  },
  {
    recipe: "canvas",
    taskKind: "chiller",
    workflows: ANY_WORKFLOW,
    keys: {
      exact: ["chill", "refrigerate", "store-batter", "rest-shortcrust"],
      prefixes: ["chill-", "cool-"],
    },
    category: "chiller",
    appliance: "hoshizaki-rt-120snj",
    label: "Chill {key}",
    batch: {
      massKg: 0.35,
      temperatureC: 26,
      specificHeat: 3200,
      densityKgL: 1.04,
      resistance: 0.25,
    },
    action: { kind: "chiller", durationSeconds: 6 },
  },
  {
    recipe: "canvas",
    taskKind: "pastry-press",
    workflows: ANY_WORKFLOW,
    keys: {
      exact: ["wrap-and-chill-shortcrust", "press-dough"],
      prefixes: ["press-dough-"],
    },
    category: "pastry-bench",
    appliance: "pastry-bench",
    label: "Press dough {key} on marble bench",
    batch: {
      massKg: 1.0,
      temperatureC: 8,
      specificHeat: 1900,
      densityKgL: 1.15,
      resistance: 0.6,
    },
    action: {
      kind: "pastry-press",
      targetHeightMm: 21.0,
      durationSeconds: 2.2,
    },
  },
  {
    recipe: "canvas",
    taskKind: "pastry-sheet",
    workflows: ANY_WORKFLOW,
    keys: { prefixes: ["line-tins", "sheet-pastry"] },
    category: "pastry-bench",
    appliance: "pastry-bench",
    label: "Sheet pastry {key} on marble bench",
    batch: {
      massKg: 0.33,
      temperatureC: 8,
      specificHeat: 1900,
      densityKgL: 1.15,
      resistance: 0.6,
    },
    action: {
      kind: "pastry-sheet",
      targetThicknessMm: 3.0,
      durationSeconds: 2.4,
    },
  },
  {
    recipe: "canvas",
    taskKind: "pastry-drape",
    workflows: ANY_WORKFLOW,
    keys: { prefixes: ["lid-pies", "drape-pastry"] },
    category: "pastry-bench",
    appliance: "pastry-bench",
    label: "Drape pastry {key} on marble bench",
    batch: {
      massKg: 0.24,
      massSource: "fixed",
      temperatureC: 6,
      specificHeat: 1950,
      densityKgL: 1.08,
      resistance: 0.5,
    },
    action: { kind: "pastry-drape", targetDepthMm: 42.0, durationSeconds: 2.4 },
  },
  {
    recipe: "canvas",
    taskKind: "dishwasher",
    workflows: ANY_WORKFLOW,
    keys: { exact: ["clean", "wash"], prefixes: ["clean-", "wash-"] },
    category: "dishwasher",
    appliance: "winterhalter-uc-l",
    label: "Wash {key}",
    batch: {
      massKg: 0.4,
      massSource: "fixed",
      temperatureC: 26,
      specificHeat: 1000,
      densityKgL: 1.18,
      resistance: 0.02,
    },
    action: { kind: "dishwasher", durationSeconds: 6 },
  },
];

type RecipeApplianceTaskOptions = Readonly<{
  /** Narrow matching to one recipe family (e.g. `"financier"`, `"pie"`). */
  recipe?: string;
  /** Espresso machine variant when binding espresso tasks. */
  espressoAppliance?: "linea" | "eagle-one";
  /** Override table rows; defaults to `RECIPE_APPLIANCE_ROWS`. */
  rows?: readonly ApplianceTaskRow[];
  /** Enable canonical task-kind fallback for canvas-edited/custom workflows (default `true`). */
  includeCanvasFallback?: boolean;
}>;

function matchesWorkflow(
  workflowId: string,
  matcher: ApplianceWorkflowMatcher,
): boolean {
  const hasRule =
    (matcher.exact !== undefined && matcher.exact.length > 0) ||
    (matcher.prefixes !== undefined && matcher.prefixes.length > 0) ||
    (matcher.suffixes !== undefined && matcher.suffixes.length > 0);
  if (!hasRule) return true;
  if (matcher.exact?.includes(workflowId)) return true;
  if (matcher.prefixes?.some((p) => workflowId.startsWith(p))) return true;
  if (matcher.suffixes?.some((s) => workflowId.endsWith(s))) return true;
  return false;
}

function normalizeTaskKey(
  taskKey: string,
  matcher: ApplianceKeyMatcher,
): string {
  return matcher.stripTrayPrefix
    ? taskKey.replace(/^tray-\d+\./u, "")
    : taskKey;
}

function matchesKey(key: string, matcher: ApplianceKeyMatcher): boolean {
  if (matcher.exact?.includes(key)) return true;
  if (matcher.prefixes?.some((p) => key.startsWith(p))) return true;
  return false;
}

/** Strips a canvas duplicate suffix (`bake-2` -> `bake`) generated by `freshKey`. */
function stripCanvasDuplicateSuffix(key: string): string | null {
  const match = /^(.+)-(\d+)$/u.exec(key);
  if (match === null || match[1] === undefined) return null;
  const n = Number(match[2]);
  return Number.isInteger(n) && n >= 2 ? match[1] : null;
}

function parseFinishingTargetC(key: string, fallback: number): number {
  const match = /^heat-and-stir-to-(\d+)c$/u.exec(key);
  if (match === null || match[1] === undefined) return fallback;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed)
    ? Math.max(45, Math.min(90, parsed))
    : fallback;
}

function productLabelFor(
  row: ApplianceTaskRow,
  task: Pick<ScheduledTaskDescriptor, "instanceId" | "workflowId">,
): string {
  if (row.productSource === "financier") {
    const flavour =
      financierFlavourOf(task.instanceId) ??
      financierFlavourOf(task.workflowId);
    return flavour === null
      ? "Financier"
      : FINANCIER_FLAVOUR_PRODUCTS[flavour].title;
  }
  if (row.productSource === "pie") {
    const pie = pieTypeOf(task.workflowId);
    return pie === null ? "Pie shortcrust" : PIE_PRODUCTS[pie].title;
  }
  return "";
}

function formatLabel(
  row: ApplianceTaskRow,
  task: Pick<ScheduledTaskDescriptor, "instanceId" | "workflowId">,
  key: string,
): string {
  const product = productLabelFor(row, task);
  return row.label
    .replaceAll("{product}", product)
    .replaceAll("{productLower}", product.toLowerCase())
    .replaceAll("{key}", key);
}

function buildBatchFromSpec(
  task: ScheduledTaskDescriptor,
  matchedKey: string,
  spec: ApplianceBatchRowSpec,
  action: ApplianceActionRowSpec,
): ApplianceBatch {
  let massKg = spec.massKg;
  if (spec.massSource !== "fixed") {
    const baseMass = taskMaterialMassKg(task.definition, spec.massKg);
    if (spec.divideMassByOutputProduct !== undefined) {
      let count = 0;
      for (const output of task.definition?.outputs ?? []) {
        if (
          output.kind === "lot" &&
          output.product === spec.divideMassByOutputProduct
        ) {
          count += 1;
        }
      }
      massKg = baseMass / Math.max(1, count);
    } else {
      massKg = baseMass;
    }
  }
  let temperatureC = spec.temperatureC;
  if (action.kind === "hob-temperature-from-key") {
    const targetC = parseFinishingTargetC(matchedKey, action.fallbackTargetC);
    temperatureC = Math.max(
      action.minDefaultTempC,
      targetC + action.defaultTempOffsetC,
    );
  }
  const suffix = spec.idSuffix ?? matchedKey;
  return batchSpec(
    `${task.instanceId}-${suffix}`,
    massKg,
    temperatureC,
    spec.specificHeat,
    spec.densityKgL,
    spec.resistance,
  );
}

function buildActionCallback(
  action: ApplianceActionRowSpec,
  batch: ApplianceBatch | null,
  matchedKey: string,
): (context: ApplianceTaskContext) => readonly ApplianceAction[] {
  switch (action.kind) {
    case "weigh":
      return () => weighActions(batch!);
    case "hob-power":
      return (context) => {
        if (
          action.carryPreviousTempRange !== undefined &&
          context.previousInstanceBatchTemperatureC !== null
        ) {
          const [minC, maxC] = action.carryPreviousTempRange;
          const tempC = Math.max(
            minC,
            Math.min(maxC, context.previousInstanceBatchTemperatureC),
          );
          return hobPowerActions(
            { ...batch!, temperature_c: Number(tempC.toFixed(3)) },
            action.percent,
            action.durationSeconds,
          );
        }
        return hobPowerActions(batch!, action.percent, action.durationSeconds);
      };
    case "hob-temperature":
      return () =>
        hobTemperatureActions(batch!, action.targetC, action.durationSeconds);
    case "hob-temperature-from-key": {
      const targetC = parseFinishingTargetC(matchedKey, action.fallbackTargetC);
      const defaultTempC = Math.max(
        action.minDefaultTempC,
        targetC + action.defaultTempOffsetC,
      );
      return (context) => {
        const tempC =
          context.previousInstanceBatchTemperatureC !== null &&
          context.previousInstanceBatchTemperatureC >= action.carryMinTempC
            ? Math.min(
                targetC + action.carryMaxOffsetC,
                context.previousInstanceBatchTemperatureC,
              )
            : defaultTempC;
        return hobTemperatureActions(
          { ...batch!, temperature_c: Number(tempC.toFixed(3)) },
          targetC,
          action.durationSeconds,
        );
      };
    }
    case "planetary-mix":
      return () =>
        planetaryMixActions(batch!, action.setting, action.durationSeconds);
    case "grind":
      return () => grindActions(batch!, action.durationSeconds);
    case "blend":
      return () => blendActions(batch!, action.percent, action.durationSeconds);
    case "heated-frother":
      return (context) => heatedFrotherActions(batch!, action.targetC, context);
    case "espresso":
      return () => espressoActions(batch!, action.durationSeconds);
    case "oven-preheat":
      return (context) => ovenPreheatActions(action.targetC, context);
    case "oven-bake":
      return (context) =>
        ovenBakeActions(
          batch!,
          action.targetC,
          action.durationSeconds,
          context,
        );
    case "chiller":
      return () => chillerActions(batch!, action.durationSeconds);
    case "dishwasher":
      return () => dishwasherActions(batch!, action.durationSeconds);
    case "pastry-press":
      return () =>
        pastryPressDoughActions(
          batch!,
          action.targetHeightMm,
          action.durationSeconds,
        );
    case "pastry-sheet":
      return () =>
        pastrySheetActions(
          batch!,
          action.targetThicknessMm,
          action.durationSeconds,
        );
    case "pastry-drape":
      return () =>
        pastryDrapeActions(
          batch!,
          action.targetDepthMm,
          action.durationSeconds,
        );
  }
}

type ResolvedApplianceRow = Readonly<{
  row: ApplianceTaskRow;
  matchedKey: string;
}>;

/**
 * Resolves the declarative appliance row for a scheduled or canvas task.
 * Built-in recipes match their own rows first (and canvas duplicate suffixes
 * like `bake-2` match the same workflow's exact rows). Non-built-in workflows
 * authored on the Plan 84 canvas fall back to `CANONICAL_APPLIANCE_ROWS`.
 */
function resolveApplianceTaskRow(
  task: Pick<ScheduledTaskDescriptor, "workflowId" | "taskKey">,
  options: RecipeApplianceTaskOptions = {},
): ResolvedApplianceRow | null {
  const rows = options.rows ?? RECIPE_APPLIANCE_ROWS;
  let workflowRecognized = false;

  for (const row of rows) {
    if (options.recipe !== undefined && row.recipe !== options.recipe) continue;
    if (!matchesWorkflow(task.workflowId, row.workflows)) continue;
    workflowRecognized = true;
    const key = normalizeTaskKey(task.taskKey, row.keys);
    if (matchesKey(key, row.keys)) {
      return { row, matchedKey: key };
    }
  }

  if (options.includeCanvasFallback === false) return null;

  // Canvas-added duplicate step inside a built-in workflow (e.g. `bake-2`, `mix-2`).
  if (workflowRecognized) {
    for (const row of rows) {
      if (options.recipe !== undefined && row.recipe !== options.recipe)
        continue;
      if (!matchesWorkflow(task.workflowId, row.workflows)) continue;
      const key = normalizeTaskKey(task.taskKey, row.keys);
      const base = stripCanvasDuplicateSuffix(key);
      if (base !== null && row.keys.exact?.includes(base)) {
        return { row, matchedKey: key };
      }
    }
    return null;
  }

  // Custom or renamed workflow authored on the Plan 84 canvas.
  if (options.recipe !== undefined) return null;
  for (const row of CANONICAL_APPLIANCE_ROWS) {
    const key = normalizeTaskKey(task.taskKey, row.keys);
    if (matchesKey(key, row.keys)) {
      return { row, matchedKey: key };
    }
    const base = stripCanvasDuplicateSuffix(key);
    if (base !== null && matchesKey(base, row.keys)) {
      return { row, matchedKey: key };
    }
  }
  return null;
}

/**
 * Resolves the canonical `ApplianceTaskKind` for any recipe or Plan 84 canvas task.
 */
export function resolveApplianceTaskKind(
  task: Pick<ScheduledTaskDescriptor, "workflowId" | "taskKey">,
  options: RecipeApplianceTaskOptions = {},
): ApplianceTaskKind | null {
  return resolveApplianceTaskRow(task, options)?.row.taskKind ?? null;
}

/**
 * Single data-driven binder mapping one scheduled task to its MuJoCo appliance
 * task binding. Replaces all per-recipe `*ApplianceTask` functions.
 */
export function recipeApplianceTask(
  task: ScheduledTaskDescriptor,
  options: RecipeApplianceTaskOptions = {},
): RecipeApplianceTaskBinding | null {
  const resolved = resolveApplianceTaskRow(task, options);
  if (resolved === null) return null;
  const { row, matchedKey } = resolved;
  const appliance: ApplianceName =
    row.useEspressoOption && options.espressoAppliance === "eagle-one"
      ? "victoria-arduino-eagle-one-2g"
      : row.appliance;
  const batch =
    row.batch === null
      ? null
      : buildBatchFromSpec(task, matchedKey, row.batch, row.action);
  return {
    taskId: task.taskId,
    instanceId: task.instanceId,
    workflowId: task.workflowId,
    taskKey: matchedKey,
    startedAtUs: task.startedAtUs,
    completedAtUs: task.completedAtUs,
    category: row.category,
    appliance,
    label: formatLabel(row, task, matchedKey),
    batch,
    buildActions: buildActionCallback(row.action, batch, matchedKey),
  };
}

/**
 * Single data-driven collector mapping every scheduled task of a run or
 * compiled scenario (including Plan 84 canvas-lowered scenarios) into ordered
 * MuJoCo appliance task bindings ready for `executeRecipeApplianceTasks`.
 */
export function recipeApplianceTasks(
  source: ScheduledTaskSource,
  options: RecipeApplianceTaskOptions = {},
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    const bound = recipeApplianceTask(task, options);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}
