import type { ApplianceTaskRow } from "./appliance-execution.ts";
export {
  compileGingerBlackTeaRecipe,
  gingerBlackTeaRecipeInput,
} from "./ginger-black-tea.ts";
export {
  compileGingerMilkTeaRecipe,
  gingerMilkTeaRecipeInput,
} from "./ginger-milk-tea.ts";
export { teaStrainTiming } from "./tea-process.ts";

const BLACK_TEA_WORKFLOWS = { exact: ["ginger-tea-batch"] } as const;
const MILK_TEA_WORKFLOWS = {
  exact: ["ginger-milk-tea-batch", "clean-initial-pan"],
} as const;

function teaWeighRow(
  recipe: "ginger-black-tea" | "ginger-milk-tea",
  workflows: typeof BLACK_TEA_WORKFLOWS | typeof MILK_TEA_WORKFLOWS,
  keys: ApplianceTaskRow["keys"],
  massKg: number,
  temperatureC: number,
): ApplianceTaskRow {
  return {
    recipe,
    taskKind: "weigh",
    workflows,
    keys,
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "Tea {key}",
    batch: {
      massKg,
      temperatureC,
      specificHeat: 4050,
      densityKgL: 1.01,
      resistance: 0.04,
    },
    action: { kind: "weigh" },
  };
}

function teaHobRows(
  recipe: "ginger-black-tea" | "ginger-milk-tea",
  workflows: typeof BLACK_TEA_WORKFLOWS | typeof MILK_TEA_WORKFLOWS,
  appliance: "maruzen-mih-02c" | "vollrath-59500p",
  massKg: number,
): readonly ApplianceTaskRow[] {
  return [
    {
      recipe,
      taskKind: "hob-power",
      workflows,
      keys: { exact: ["heat-to-simmer"] },
      category: "hob",
      appliance,
      label: "Tea {key}",
      batch: {
        massKg,
        temperatureC: 20,
        specificHeat: 4100,
        densityKgL: 1.0,
        resistance: 0.03,
      },
      action: { kind: "hob-power", percent: 55, durationSeconds: 5 },
    },
    {
      recipe,
      taskKind: "hob-power",
      workflows,
      keys: { exact: ["simmer-ginger"] },
      category: "hob",
      appliance,
      label: "Tea {key}",
      batch: {
        massKg,
        temperatureC: 26,
        specificHeat: 4100,
        densityKgL: 1.0,
        resistance: 0.03,
      },
      action: {
        kind: "hob-power",
        percent: 38,
        durationSeconds: 5,
        carryPreviousTempRange: [22, 72],
      },
    },
    {
      recipe,
      taskKind: "hob-power",
      workflows,
      keys: { exact: ["simmer-tea"] },
      category: "hob",
      appliance,
      label: "Tea {key}",
      batch: {
        massKg,
        temperatureC: 32,
        specificHeat: 4100,
        densityKgL: 1.0,
        resistance: 0.03,
      },
      action: {
        kind: "hob-power",
        percent: 30,
        durationSeconds: 5,
        carryPreviousTempRange: [22, 72],
      },
    },
  ];
}

function teaWashRow(
  recipe: "ginger-black-tea" | "ginger-milk-tea",
  workflows: typeof BLACK_TEA_WORKFLOWS | typeof MILK_TEA_WORKFLOWS,
  exact: readonly string[],
  massKg: number,
): ApplianceTaskRow {
  return {
    recipe,
    taskKind: "dishwasher",
    workflows,
    keys: { exact },
    category: "dishwasher",
    appliance: "winterhalter-uc-l",
    label: "Tea {key}",
    batch: {
      massKg,
      massSource: "fixed",
      temperatureC: 26,
      specificHeat: 950,
      densityKgL: 1.2,
      resistance: 0.02,
    },
    action: { kind: "dishwasher", durationSeconds: 6 },
  };
}

/** Declarative MuJoCo appliance task rows for ginger black tea (Plan 61C). */
const GINGER_BLACK_TEA_APPLIANCE_ROWS: readonly ApplianceTaskRow[] = [
  teaWeighRow(
    "ginger-black-tea",
    BLACK_TEA_WORKFLOWS,
    { exact: ["prepare-ginger-and-water"] },
    0.465,
    20,
  ),
  teaWeighRow(
    "ginger-black-tea",
    BLACK_TEA_WORKFLOWS,
    { exact: ["add-tea-and-cover"] },
    0.453,
    35,
  ),
  teaWeighRow(
    "ginger-black-tea",
    BLACK_TEA_WORKFLOWS,
    { exact: ["strain-and-sweeten"] },
    0.435,
    35,
  ),
  teaWeighRow(
    "ginger-black-tea",
    BLACK_TEA_WORKFLOWS,
    { exact: ["add-tea"] },
    0.404,
    35,
  ),
  ...teaHobRows(
    "ginger-black-tea",
    BLACK_TEA_WORKFLOWS,
    "maruzen-mih-02c",
    0.465,
  ),
  teaWashRow("ginger-black-tea", BLACK_TEA_WORKFLOWS, ["wash-equipment"], 0.4),
];

/** Declarative MuJoCo appliance task rows for ginger milk tea (Plan 61D). */
const GINGER_MILK_TEA_APPLIANCE_ROWS: readonly ApplianceTaskRow[] = [
  teaWeighRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    { exact: ["prepare-ginger-and-water"] },
    0.415,
    20,
  ),
  teaWeighRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    { exact: ["add-tea-and-cover"] },
    0.453,
    35,
  ),
  teaWeighRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    { exact: ["strain-and-sweeten"] },
    0.435,
    35,
  ),
  teaWeighRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    { exact: ["add-tea"] },
    0.404,
    35,
  ),
  teaWeighRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    { prefixes: ["add-milk-and-sugar-at-"] },
    0.569,
    52,
  ),
  ...teaHobRows(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    "vollrath-59500p",
    0.415,
  ),
  {
    recipe: "ginger-milk-tea",
    taskKind: "hob-temperature",
    workflows: MILK_TEA_WORKFLOWS,
    keys: { exact: ["heat-cup-preheat-water"] },
    category: "hob",
    appliance: "vollrath-59500p",
    label: "Heat cup-preheat water on induction hob",
    batch: {
      idSuffix: "cup-preheat",
      massKg: 0.3,
      temperatureC: 20,
      specificHeat: 4180,
      densityKgL: 1.0,
      resistance: 0.02,
    },
    action: { kind: "hob-temperature", targetC: 65, durationSeconds: 5 },
  },
  {
    recipe: "ginger-milk-tea",
    taskKind: "hob-temperature",
    workflows: MILK_TEA_WORKFLOWS,
    keys: { prefixes: ["heat-and-stir-to-"] },
    category: "hob",
    appliance: "vollrath-59500p",
    label: "Ginger milk tea {key}",
    batch: {
      massKg: 0.569,
      temperatureC: 63,
      specificHeat: 3950,
      densityKgL: 1.02,
      resistance: 0.05,
    },
    action: {
      kind: "hob-temperature-from-key",
      fallbackTargetC: 75,
      durationSeconds: 5,
      defaultTempOffsetC: -12,
      minDefaultTempC: 50,
      carryMinTempC: 45,
      carryMaxOffsetC: -2,
    },
  },
  teaWashRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    ["wash-equipment", "wash-pan-b-and-strainer"],
    0.4,
  ),
  teaWashRow(
    "ginger-milk-tea",
    MILK_TEA_WORKFLOWS,
    ["wash-initial-pan", "wash-pan-a"],
    0.35,
  ),
];

export const TEA_APPLIANCE_ROWS: readonly ApplianceTaskRow[] = [
  ...GINGER_BLACK_TEA_APPLIANCE_ROWS,
  ...GINGER_MILK_TEA_APPLIANCE_ROWS,
];
