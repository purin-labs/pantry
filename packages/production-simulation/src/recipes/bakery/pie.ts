import { canonicalJson, sha256Hex } from "@purin-labs/std";
import * as d from "../../document-values.ts";
import { authoredId, type Sha256Hex } from "../../identity.ts";
import { normalizeQuantity, type MaterialQuantity } from "../../quantity.ts";
import { err, ok, type Result } from "../../result.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CarrierStep,
  type CompiledScenario,
  type LotHolder,
  type MaterialInput,
  type MaterialOutput,
  type TaskDefinition,
  type TaskExecutor,
} from "../../scenario.ts";
import {
  durationFromSeconds,
  timeFromSeconds,
  ZERO_DURATION,
} from "../../time.ts";
import {
  batchSpec,
  chillerActions,
  dishwasherActions,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
  hobPowerActions,
  hobTemperatureActions,
  ovenBakeActions,
  pastryDrapeActions,
  pastryPressDoughActions,
  pastrySheetActions,
  planetaryMixActions,
  taskMaterialMassKg,
  weighActions,
  type ApplianceWasmRuntimeSource,
  type RecipeApplianceExecutionOptions,
  type RecipeApplianceExecutionReport,
  type RecipeApplianceTaskBinding,
  type ScheduledTaskDescriptor,
  type ScheduledTaskSource,
} from "./appliance-execution.ts";

import {
  PIE_PRODUCTS,
  PIE_TYPES,
  pieTypeOf,
  type PieType,
} from "./pie-products.ts";

export { PIE_PRODUCTS, PIE_TYPES, pieTypeOf } from "./pie-products.ts";
export type { PieProduct, PieType } from "./pie-products.ts";

const SHORTCRUST_INGREDIENTS = [
  "wheat-flour",
  "butter",
  "salt",
  "whole-egg",
  "water",
] as const;
type ShortcrustIngredient = (typeof SHORTCRUST_INGREDIENTS)[number];

/** Filling ingredients by the step that they go into the pan. */
const FILLING_STAGES = {
  "steak-and-pepper": {
    sear: ["beef-chuck", "onion"],
    braise: ["beef-stock", "cracked-black-pepper"],
    thicken: ["gravy-thickener"],
  },
  "beef-bourguignon": {
    sear: ["beef-chuck", "bacon-lardons", "pearl-onion", "mushroom"],
    braise: ["red-wine", "beef-stock"],
    thicken: [],
  },
} as const satisfies Record<
  PieType,
  Readonly<{
    sear: readonly string[];
    braise: readonly string[];
    thicken: readonly string[];
  }>
>;
type Stage = "sear" | "braise" | "thicken";
const STAGES: readonly Stage[] = ["sear", "braise", "thicken"];

const DURATIONS = [
  "weigh",
  "mix-shortcrust",
  "wrap-shortcrust",
  "rest-shortcrust",
  "release",
  "clean",
  "put-away",
  "place-pan",
  "sear",
  "braise",
  "reduce",
  "transfer-filling",
  "chill-filling",
  "prepare-tray",
  "line-tin",
  "fill-pie",
  "lid-pie",
  "egg-wash",
  "transfer",
  "bake",
  "inspect",
  "cool",
  "pack",
] as const;
type Duration = (typeof DURATIONS)[number];

type Filling = Readonly<{
  pie: PieType;
  /** Pies from one filling batch: one braising pan, one tray. */
  count: number;
  /** Filling batches, and so trays, of this pie type. */
  batches: number;
  ingredients: Readonly<Record<Stage, readonly (readonly [string, number])[]>>;
  searLoss: number;
  braiseLoss: number;
  reduceLoss: number;
  residue: number;
  filling: number;
  arrival: number;
  /** When the pie bench takes the trays of this type. */
  assemblyArrival: number;
}>;
/**
 * Which work the scenario holds. "prep" is the previous afternoon's
 * mise en place: shortcrust and chilled fillings. "assembly" takes those
 * from the refrigerator and lines, fills, lids, bakes and packs. "full"
 * does both in one run.
 */
export type PieStage = "full" | "prep" | "assembly";
type Recipe = Readonly<{
  revision: number;
  stage: PieStage;
  shortcrust: Readonly<{
    ingredients: readonly (readonly [ShortcrustIngredient, number])[];
    residue: number;
    dough: number;
    arrival: number;
  }>;
  pie: Readonly<{
    shell: number;
    filling: number;
    lid: number;
    eggWash: number;
    bakeLoss: number;
  }>;
  pies: readonly Filling[];
  durations: Readonly<Record<Duration, number>>;
}>;

export type PieRecipeProblem = Readonly<{
  code:
    | "invalid_pie_recipe"
    | "shortcrust_mass_balance"
    | "filling_mass_balance"
    | "insufficient_shortcrust";
}>;

function mass(amount: number): MaterialQuantity {
  return d.value(normalizeQuantity({ amount, scale: 3, unit: "gram" }));
}
function count(amount: number): MaterialQuantity {
  return d.value(normalizeQuantity({ amount, scale: 0, unit: "each" }));
}
function seconds(value: number) {
  return d.value(durationFromSeconds(value));
}
function readDuration(raw: unknown): number {
  const value = d.positive(raw);
  d.requireValue(value <= 7_200);
  return value;
}
function arrival(raw: unknown): number {
  const value = d.natural(raw);
  d.requireValue(value < 21_600);
  return value;
}
function readAmounts<const K extends string>(
  raw: unknown,
  keys: readonly K[],
): (readonly [K, number])[] {
  const r = d.record(raw, keys);
  const amounts: (readonly [K, number])[] = [];
  for (const key of keys) amounts.push([key, d.positive(r[key])]);
  return amounts;
}

function readFilling(raw: unknown): Filling {
  const r = d.record(raw, [
    "pie",
    "count",
    "batches",
    "searMg",
    "braiseMg",
    "thickenMg",
    "searLossMg",
    "braiseLossMg",
    "reduceLossMg",
    "residueMg",
    "fillingMg",
    "arrivalSeconds",
    "assemblyArrivalSeconds",
  ]);
  const pie = d.choice(r.pie, ...PIE_TYPES);
  const stages = FILLING_STAGES[pie];
  const pies = d.positive(r.count);
  const batches = d.positive(r.batches);
  // The appliance models hold 1 l in the induction pan and 2 l on the oven
  // tray: one filling batch braises in one pan and bakes as one tray of at
  // most three 12 cm pies (about 0.45 l each).
  d.requireValue(pies <= 3 && batches <= 3);
  return {
    pie,
    count: pies,
    batches,
    ingredients: {
      sear: readAmounts(r.searMg, stages.sear),
      braise: readAmounts(r.braiseMg, stages.braise),
      thicken: readAmounts(r.thickenMg, stages.thicken),
    },
    searLoss: d.natural(r.searLossMg),
    braiseLoss: d.natural(r.braiseLossMg),
    reduceLoss: d.natural(r.reduceLossMg),
    residue: d.natural(r.residueMg),
    filling: d.positive(r.fillingMg),
    arrival: arrival(r.arrivalSeconds),
    assemblyArrival: arrival(r.assemblyArrivalSeconds),
  };
}

function read(raw: unknown): Recipe {
  const r = d.record(raw, [
    "revision",
    "evidence",
    "stage",
    "shortcrust",
    "pie",
    "pies",
    "measurementDifferenceMg",
    "durationsSeconds",
  ]);
  d.choice(r.evidence, "assumed");
  const stage = d.choice(r.stage, "full", "prep", "assembly");
  d.requireValue(r.measurementDifferenceMg === 0);
  const crust = d.record(r.shortcrust, [
    "ingredientsMg",
    "residueMg",
    "doughMg",
    "arrivalSeconds",
  ]);
  const pie = d.record(r.pie, [
    "shellMg",
    "fillingMg",
    "lidMg",
    "eggWashMg",
    "bakeLossMg",
  ]);
  const pies = d.array(r.pies, readFilling);
  d.requireValue(pies.length > 0 && pies.length <= PIE_TYPES.length);
  const seen = new Set<PieType>();
  for (const entry of pies) {
    d.requireValue(!seen.has(entry.pie));
    seen.add(entry.pie);
  }
  const rawDurations = d.record(r.durationsSeconds, DURATIONS);
  const durations = {} as Record<Duration, number>;
  for (const key of DURATIONS) durations[key] = readDuration(rawDurations[key]);
  const piece = {
    shell: d.positive(pie.shellMg),
    filling: d.positive(pie.fillingMg),
    lid: d.positive(pie.lidMg),
    eggWash: d.positive(pie.eggWashMg),
    bakeLoss: d.natural(pie.bakeLossMg),
  };
  d.requireValue(
    piece.bakeLoss < piece.shell + piece.filling + piece.lid + piece.eggWash,
  );
  return {
    revision: d.positive(r.revision),
    stage,
    shortcrust: {
      ingredients: readAmounts(crust.ingredientsMg, SHORTCRUST_INGREDIENTS),
      residue: d.natural(crust.residueMg),
      dough: d.positive(crust.doughMg),
      arrival: arrival(crust.arrivalSeconds),
    },
    pie: piece,
    pies,
    durations,
  };
}

function taskKey(key: string) {
  return authoredId("task-key", key);
}
function lotKey(key: string) {
  return authoredId("lot-key", key);
}
function pool(product: string, quantity: MaterialQuantity): MaterialInput {
  return { kind: "pool", product: authoredId("product", product), quantity };
}
function input(lot: string, quantity: MaterialQuantity): MaterialInput {
  return { kind: "lot", lot: lotKey(lot), quantity };
}
function carrier(role: string): LotHolder {
  return { kind: "carrier", carrier: authoredId("carrier-role", role) };
}
function storage(id: string): LotHolder {
  return { kind: "storage", storage: authoredId("storage", id) };
}
function lot(
  key: string,
  product: string,
  quantity: MaterialQuantity,
  holder: LotHolder,
  disposition: "held" | "released" = "released",
): MaterialOutput {
  return {
    kind: "lot",
    lot: lotKey(key),
    product: authoredId("product", product),
    quantity,
    holder,
    disposition,
    report: null,
  };
}
function exit(
  product: string,
  quantity: MaterialQuantity,
  outputs: MaterialOutput[],
): void {
  if (quantity.amount === 0) return;
  outputs.push({
    kind: "exit",
    product: authoredId("product", product),
    quantity,
    destination: authoredId("destination", product),
  });
}
function move(
  role: string,
  from: string,
  to: string,
  duration: number,
): CarrierStep {
  return {
    kind: "move",
    role: authoredId("carrier-role", role),
    from: authoredId("storage", from),
    to: authoredId("storage", to),
    timing: {
      kind: "declared",
      pickupAfter: ZERO_DURATION,
      placementAfter: seconds(duration),
    },
  };
}
function acquire(role: string, from: string): CarrierStep {
  return {
    kind: "acquire",
    role: authoredId("carrier-role", role),
    from: authoredId("storage", from),
  };
}
function release(role: string): CarrierStep {
  return { kind: "release", role: authoredId("carrier-role", role) };
}
function attended(
  duration: number,
  start: string,
  finish: string,
): TaskExecutor {
  return {
    kind: "attended",
    duration: seconds(duration),
    evidence: "assumed",
    workers: [authoredId("resource", "baker")],
    start: authoredId("location", start),
    finish: authoredId("location", finish),
  };
}
function passive(duration: number): TaskExecutor {
  return { kind: "declared", duration: seconds(duration), evidence: "assumed" };
}
function task(
  key: string,
  previous: readonly string[],
  executor: TaskExecutor,
  resources: readonly string[],
  inputs: readonly MaterialInput[],
  outputs: readonly MaterialOutput[],
  carriers: readonly CarrierStep[] = [],
  releases: readonly string[] = [],
): TaskDefinition {
  return {
    key: taskKey(key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous.map(taskKey),
    executor,
    claims: resources.map((id) => ({
      resource: authoredId("resource", id),
      units: 1,
      configuration: null,
    })),
    inputs,
    outputs,
    carriers,
    releases: releases.map(lotKey),
  };
}

/**
 * Weighs a batch's ingredients one after another into one vessel, as one
 * attended task at the scale. Each weighed lot keeps its own key and becomes
 * the batch's weighed product, so the product graph stays acyclic.
 */
function weighInto(
  key: string,
  product: string,
  ingredients: readonly (readonly [string, number])[],
  vessel: string,
  vesselHome: string,
  vesselBench: string,
  weighSeconds: number,
): TaskDefinition {
  const inputs: MaterialInput[] = [];
  const outputs: MaterialOutput[] = [];
  for (const [ingredient, amount] of ingredients) {
    inputs.push(pool(ingredient, mass(amount)));
    outputs.push(
      lot(`weighed-${ingredient}`, product, mass(amount), carrier(vessel)),
    );
  }
  return task(
    key,
    [],
    attended(weighSeconds * ingredients.length, "prep", "prep"),
    ["scale"],
    inputs,
    outputs,
    [
      acquire(vessel, vesselHome),
      move(vessel, vesselHome, vesselBench, weighSeconds),
    ],
  );
}

/** Shortcrust for every pie: rubbed in the HL200 with the beater, rested cold. */
function shortcrustTasks(recipe: Recipe): TaskDefinition[] {
  const t = recipe.durations;
  const mixInputs: MaterialInput[] = [];
  for (const [ingredient, amount] of recipe.shortcrust.ingredients)
    mixInputs.push(input(`weighed-${ingredient}`, mass(amount)));
  const mixed: MaterialOutput[] = [
    lot(
      "shortcrust",
      "shortcrust-dough",
      mass(recipe.shortcrust.dough),
      carrier("bowl"),
    ),
  ];
  exit("shortcrust-residue", mass(recipe.shortcrust.residue), mixed);
  return [
    weighInto(
      "weigh-shortcrust-ingredients",
      "weighed-shortcrust-ingredients",
      recipe.shortcrust.ingredients,
      "bowl",
      "clean-bowl",
      "prep-vessels",
      t.weigh,
    ),
    task(
      "mix-shortcrust",
      ["weigh-shortcrust-ingredients"],
      attended(t["mix-shortcrust"], "prep", "prep"),
      [],
      mixInputs,
      mixed,
    ),
    task(
      "wrap-and-chill-shortcrust",
      ["mix-shortcrust"],
      attended(t["wrap-shortcrust"], "prep", "prep"),
      [],
      [input("shortcrust", mass(recipe.shortcrust.dough))],
      [
        lot(
          "chilled-shortcrust",
          "shortcrust-dough",
          mass(recipe.shortcrust.dough),
          storage("shortcrust-fridge"),
          "held",
        ),
      ],
    ),
    // The rested dough is released for lining when its rest ends.
    task(
      "rest-shortcrust",
      ["wrap-and-chill-shortcrust"],
      passive(t["rest-shortcrust"]),
      [],
      [],
      [],
      [],
      ["chilled-shortcrust"],
    ),
    task(
      "clean-bowl",
      ["wrap-and-chill-shortcrust"],
      attended(t.clean, "prep", "sink"),
      ["sink"],
      [],
      [],
      [move("bowl", "prep-vessels", "sink-vessels", t.transfer)],
    ),
    task(
      "put-away-bowl",
      ["clean-bowl"],
      attended(t["put-away"], "sink", "prep"),
      [],
      [],
      [],
      [move("bowl", "sink-vessels", "clean-bowl", t.transfer), release("bowl")],
    ),
  ];
}

/** One pan of filling: seared and braised on the braising hob, then chilled. */
function fillingTasks(recipe: Recipe, filling: Filling): TaskDefinition[] {
  const t = recipe.durations;
  const staged: Record<Stage, MaterialInput[]> = {
    sear: [],
    braise: [],
    thicken: [],
  };
  const total: Record<Stage, number> = { sear: 0, braise: 0, thicken: 0 };
  const weighed: (readonly [string, number])[] = [];
  for (const stage of STAGES)
    for (const [ingredient, amount] of filling.ingredients[stage]) {
      weighed.push([ingredient, amount]);
      staged[stage].push(input(`weighed-${ingredient}`, mass(amount)));
      total[stage] += amount;
    }
  const seared = total.sear - filling.searLoss;
  const braised = seared + total.braise - filling.braiseLoss;
  const cooked = braised + total.thicken - filling.reduceLoss;
  const searOutputs: MaterialOutput[] = [
    lot("seared", "seared-filling", mass(seared), carrier("braise-pan")),
  ];
  exit("filling-evaporation", mass(filling.searLoss), searOutputs);
  const braiseOutputs: MaterialOutput[] = [
    lot("braised", "braised-filling", mass(braised), carrier("braise-pan")),
  ];
  exit("filling-evaporation", mass(filling.braiseLoss), braiseOutputs);
  const reduceOutputs: MaterialOutput[] = [
    lot("cooked", "cooked-filling", mass(cooked), carrier("braise-pan")),
  ];
  exit("filling-evaporation", mass(filling.reduceLoss), reduceOutputs);
  const transferOutputs: MaterialOutput[] = [
    lot(
      "chilled-filling",
      `${filling.pie}-filling`,
      mass(filling.filling),
      storage(`${filling.pie}-filling-fridge`),
      "held",
    ),
  ];
  exit("filling-residue", mass(filling.residue), transferOutputs);
  return [
    weighInto(
      "weigh-filling-ingredients",
      "weighed-filling-ingredients",
      weighed,
      "braise-pan",
      "clean-braise-pans",
      "braise-prep",
      t.weigh,
    ),
    task(
      "place-pan-on-hob",
      ["weigh-filling-ingredients"],
      attended(t["place-pan"], "prep", "hob"),
      [],
      [],
      [],
      [move("braise-pan", "braise-prep", "braise-hob-positions", t.transfer)],
    ),
    task(
      "sear-beef",
      ["place-pan-on-hob"],
      attended(t.sear, "hob", "hob"),
      ["braise-hob"],
      staged.sear,
      searOutputs,
    ),
    task(
      "braise-filling",
      ["sear-beef"],
      passive(t.braise),
      ["braise-hob"],
      [input("seared", mass(seared)), ...staged.braise],
      braiseOutputs,
    ),
    task(
      "reduce-filling",
      ["braise-filling"],
      // The lid comes off and the filling reduces on the hob without a person.
      passive(t.reduce),
      ["braise-hob"],
      [input("braised", mass(braised)), ...staged.thicken],
      reduceOutputs,
    ),
    task(
      "transfer-filling-to-chill",
      ["reduce-filling"],
      attended(t["transfer-filling"], "hob", "prep"),
      [],
      [input("cooked", mass(cooked))],
      transferOutputs,
      [
        move(
          "braise-pan",
          "braise-hob-positions",
          "braise-pan-wash",
          t.transfer,
        ),
      ],
    ),
    // The filling is released for the pies when it is cold.
    task(
      "chill-filling",
      ["transfer-filling-to-chill"],
      passive(t["chill-filling"]),
      [],
      [],
      [],
      [],
      ["chilled-filling"],
    ),
    task(
      "clean-braise-pan",
      ["transfer-filling-to-chill"],
      attended(t.clean, "prep", "sink"),
      ["sink"],
      [],
      [],
    ),
    task(
      "put-away-braise-pan",
      ["clean-braise-pan"],
      attended(t["put-away"], "sink", "prep"),
      [],
      [],
      [],
      [
        move("braise-pan", "braise-pan-wash", "clean-braise-pans", t.transfer),
        release("braise-pan"),
      ],
    ),
  ];
}

/** The carrier role of tray `index` of one pie type: pie-tray-a, pie-tray-b. */
function trayRole(index: number): string {
  return `pie-tray-${String.fromCharCode(97 + index)}`;
}

/**
 * All the pies of one type: each tray of three is lined, filled, lidded and
 * egg-washed; the trays bake together on two oven shelves, cool and are packed.
 */
function assemblyTasks(recipe: Recipe, filling: Filling): TaskDefinition[] {
  const t = recipe.durations;
  const p = recipe.pie;
  const n = filling.count;
  const shells = p.shell * n;
  const filled = shells + p.filling * n;
  const lidded = filled + p.lid * n;
  const assembled = lidded + p.eggWash * n;
  const baked = assembled - p.bakeLoss * n;
  const trays = Array.from({ length: filling.batches }, (_, index) =>
    trayRole(index),
  );
  const tasks: TaskDefinition[] = [];
  let previous: string | null = null;
  for (const tray of trays) {
    const step = (key: string) => `${key}-${tray.slice(-1)}`;
    tasks.push(
      task(
        step("prepare-pie-tray"),
        previous === null ? [] : [previous],
        attended(t["prepare-tray"], "prep", "prep"),
        [],
        [],
        [],
        [
          acquire(tray, "clean-pie-trays"),
          move(tray, "clean-pie-trays", "pie-bench", t["prepare-tray"]),
        ],
      ),
      task(
        step("line-tins"),
        [step("prepare-pie-tray")],
        attended(t["line-tin"] * n, "prep", "prep"),
        ["scale"],
        [pool("shortcrust-dough", mass(shells))],
        [lot(step("pie-shells"), "pie-shells", mass(shells), carrier(tray))],
      ),
      task(
        step("fill-pies"),
        [step("line-tins")],
        attended(t["fill-pie"] * n, "prep", "prep"),
        ["scale"],
        [
          input(step("pie-shells"), mass(shells)),
          pool(`${filling.pie}-filling`, mass(p.filling * n)),
        ],
        [
          lot(
            step("filled-pies"),
            "filled-pie-shells",
            mass(filled),
            carrier(tray),
          ),
        ],
      ),
      task(
        step("lid-pies"),
        [step("fill-pies")],
        attended(t["lid-pie"] * n, "prep", "prep"),
        [],
        [
          input(step("filled-pies"), mass(filled)),
          pool("puff-pastry-sheet", mass(p.lid * n)),
        ],
        [
          lot(
            step("lidded-pies"),
            "lidded-pie-mass",
            mass(lidded),
            carrier(tray),
          ),
        ],
      ),
      task(
        step("egg-wash-pies"),
        [step("lid-pies")],
        attended(t["egg-wash"], "prep", "prep"),
        [],
        [
          input(step("lidded-pies"), mass(lidded)),
          pool("whole-egg", mass(p.eggWash * n)),
        ],
        [
          lot(
            step("assembled-pie-mass"),
            "assembled-pie-mass",
            mass(assembled),
            carrier(tray),
          ),
          lot(
            step("assembled-pies"),
            "assembled-pies",
            count(n),
            carrier(tray),
          ),
        ],
      ),
    );
    previous = step("egg-wash-pies");
  }
  if (previous === null) throw new d.InvalidDocument("No pie tray");
  const bakeInputs: MaterialInput[] = [];
  const bakeOutputs: MaterialOutput[] = [];
  const bakedLots: string[] = [];
  const packInputs: MaterialInput[] = [];
  for (const tray of trays) {
    const suffix = tray.slice(-1);
    bakeInputs.push(
      input(`assembled-pie-mass-${suffix}`, mass(assembled)),
      input(`assembled-pies-${suffix}`, count(n)),
    );
    bakeOutputs.push(
      lot(
        `baked-pie-mass-${suffix}`,
        "baked-pie-mass",
        mass(baked),
        carrier(tray),
        "held",
      ),
      lot(
        `baked-pies-${suffix}`,
        "baked-pies",
        count(n),
        carrier(tray),
        "held",
      ),
    );
    bakedLots.push(`baked-pie-mass-${suffix}`, `baked-pies-${suffix}`);
    packInputs.push(
      input(`baked-pie-mass-${suffix}`, mass(baked)),
      input(`baked-pies-${suffix}`, count(n)),
    );
  }
  exit("pie-bake-loss", mass(p.bakeLoss * n * trays.length), bakeOutputs);
  const packed = (
    dimension: "pie-mass" | "pies",
    quantity: MaterialQuantity,
  ): MaterialOutput => ({
    kind: "inspection-exit",
    inspections: [taskKey("inspect-pies")],
    product: authoredId("product", `packed-${filling.pie}-${dimension}`),
    quantity,
    destination: authoredId(
      "destination",
      `packed-${filling.pie}-${dimension}`,
    ),
    rejectedProduct: authoredId(
      "product",
      `rejected-${filling.pie}-${dimension}`,
    ),
    rejectedDestination: authoredId(
      "destination",
      `rejected-${filling.pie}-${dimension}`,
    ),
  });
  const everyTray = (
    from: string,
    to: string,
    duration: number,
  ): CarrierStep[] => trays.map((tray) => move(tray, from, to, duration));
  tasks.push(
    task(
      "load-pie-oven",
      [previous],
      attended(t.transfer, "prep", "oven"),
      ["oven"],
      [],
      [],
      everyTray("pie-bench", "oven-pie-trays", t.transfer),
    ),
    task(
      "bake-pies",
      ["load-pie-oven"],
      passive(t.bake),
      ["oven"],
      bakeInputs,
      bakeOutputs,
    ),
    task(
      "examine-pies",
      ["bake-pies"],
      attended(t.inspect, "oven", "oven"),
      ["oven"],
      [],
      [],
    ),
    task(
      "inspect-pies",
      ["examine-pies"],
      { kind: "inspection" },
      [],
      [],
      [],
      [],
      bakedLots,
    ),
    task(
      "unload-pie-oven",
      ["inspect-pies"],
      attended(t.transfer, "oven", "cooling"),
      ["oven"],
      [],
      [],
      everyTray("oven-pie-trays", "pie-cooling-rack", t.transfer),
    ),
    task("cool-pies", ["unload-pie-oven"], passive(t.cool), [], [], []),
    task(
      "move-pies-to-packing",
      ["cool-pies"],
      attended(t.transfer, "cooling", "packing"),
      ["packing"],
      [],
      [],
      everyTray("pie-cooling-rack", "pie-packing", t.transfer),
    ),
    task(
      "pack-pies",
      ["move-pies-to-packing"],
      attended(t.pack * trays.length, "packing", "packing"),
      ["packing"],
      packInputs,
      [
        packed("pie-mass", mass(baked * trays.length)),
        packed("pies", count(n * trays.length)),
      ],
    ),
    task(
      "wash-pie-trays",
      ["pack-pies"],
      attended(t.clean, "packing", "sink"),
      ["sink"],
      [],
      [],
      everyTray("pie-packing", "pie-tray-wash", t.transfer),
    ),
    task(
      "put-away-pie-trays",
      ["wash-pie-trays"],
      attended(t["put-away"], "sink", "prep"),
      [],
      [],
      [],
      [
        ...everyTray("pie-tray-wash", "clean-pie-trays", t.transfer),
        ...trays.map(release),
      ],
    ),
  );
  return tasks;
}

function explicitArrival(value: number) {
  return { time: d.value(timeFromSeconds(value)), quantity: 1 };
}

function compile(recipe: Recipe, digest: Sha256Hex): CompiledScenario {
  const products: CompiledScenario["products"][number][] = [];
  const storages: CompiledScenario["storages"][number][] = [];
  const stock: CompiledScenario["stock"][number][] = [];
  const needed = new Map<string, number>();
  const add = (ingredient: string, amount: number) =>
    needed.set(ingredient, (needed.get(ingredient) ?? 0) + amount);
  const prep = recipe.stage !== "assembly";
  const assembly = recipe.stage !== "prep";
  if (prep)
    for (const [ingredient, amount] of recipe.shortcrust.ingredients)
      add(ingredient, amount);
  for (const filling of recipe.pies) {
    if (prep)
      for (const stage of STAGES)
        for (const [ingredient, amount] of filling.ingredients[stage])
          add(ingredient, amount * filling.batches);
    if (assembly) {
      add(
        "puff-pastry-sheet",
        recipe.pie.lid * filling.count * filling.batches,
      );
      add("whole-egg", recipe.pie.eggWash * filling.count * filling.batches);
    }
  }
  for (const [ingredient, amount] of needed) {
    const product = authoredId("product", ingredient);
    const place = authoredId("storage", `${ingredient}-stock`);
    products.push({ id: product, unit: "milligram" });
    storages.push({
      id: place,
      capacity: { kind: "material", product, quantity: mass(amount) },
      cell: null,
    });
    stock.push({
      id: authoredId("lot", `${ingredient}-stock`),
      product,
      quantity: mass(amount),
      storage: place,
    });
  }
  for (const id of [
    "weighed-shortcrust-ingredients",
    "weighed-filling-ingredients",
    "shortcrust-dough",
    "shortcrust-residue",
    "seared-filling",
    "braised-filling",
    "cooked-filling",
    "filling-evaporation",
    "filling-residue",
    "pie-shells",
    "filled-pie-shells",
    "lidded-pie-mass",
    "assembled-pie-mass",
    "baked-pie-mass",
    "pie-bake-loss",
  ])
    products.push({ id: authoredId("product", id), unit: "milligram" });
  for (const id of ["assembled-pies", "baked-pies"])
    products.push({ id: authoredId("product", id), unit: "each" });
  const destinations: CompiledScenario["destinations"][number][] = [];
  for (const id of [
    "shortcrust-residue",
    "filling-evaporation",
    "filling-residue",
    "pie-bake-loss",
  ])
    destinations.push({
      id: authoredId("destination", id),
      product: authoredId("product", id),
      role: "loss",
    });
  for (const filling of recipe.pies) {
    products.push({
      id: authoredId("product", `${filling.pie}-filling`),
      unit: "milligram",
    });
    storages.push({
      id: authoredId("storage", `${filling.pie}-filling-fridge`),
      capacity: {
        kind: "material",
        product: authoredId("product", `${filling.pie}-filling`),
        quantity: mass(filling.filling * filling.batches),
      },
      cell: null,
    });
    for (const [phase, role] of [
      ["packed", "final-output"],
      ["rejected", "rejected-output"],
    ] as const)
      for (const [dimension, unit] of [
        ["pie-mass", "milligram"],
        ["pies", "each"],
      ] as const) {
        const id = `${phase}-${filling.pie}-${dimension}`;
        products.push({ id: authoredId("product", id), unit });
        destinations.push({
          id: authoredId("destination", id),
          product: authoredId("product", id),
          role,
        });
      }
  }
  storages.push({
    id: authoredId("storage", "shortcrust-fridge"),
    capacity: {
      kind: "material",
      product: authoredId("product", "shortcrust-dough"),
      quantity: mass(recipe.shortcrust.dough),
    },
    cell: null,
  });
  // Assembly alone starts from the previous afternoon's dough and fillings,
  // held in the refrigerator.
  if (!prep) {
    stock.push({
      id: authoredId("lot", "shortcrust-dough-on-hand"),
      product: authoredId("product", "shortcrust-dough"),
      quantity: mass(recipe.shortcrust.dough),
      storage: authoredId("storage", "shortcrust-fridge"),
    });
    for (const filling of recipe.pies)
      stock.push({
        id: authoredId("lot", `${filling.pie}-filling-on-hand`),
        product: authoredId("product", `${filling.pie}-filling`),
        quantity: mass(filling.filling * filling.batches),
        storage: authoredId("storage", `${filling.pie}-filling-fridge`),
      });
  }
  let trays = 0;
  let shelves = 1;
  for (const filling of recipe.pies) {
    trays += filling.batches;
    shelves = Math.max(shelves, filling.batches);
  }
  for (const [id, slots] of [
    ["clean-bowl", 1],
    ["prep-vessels", 2],
    ["sink-vessels", 2],
    ["clean-braise-pans", BRAISE_ZONES],
    ["braise-prep", BRAISE_ZONES],
    ["braise-hob-positions", BRAISE_ZONES],
    ["braise-pan-wash", BRAISE_ZONES],
    ["clean-pie-trays", trays],
    ["pie-bench", trays],
    // One pie type's trays bake together, one tray on each oven shelf.
    ["oven-pie-trays", shelves],
    ["pie-cooling-rack", trays],
    ["pie-packing", shelves],
    ["pie-tray-wash", shelves],
  ] as const)
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  const carriers: CompiledScenario["carriers"][number][] = [
    {
      id: authoredId("carrier", "bowl-1"),
      storage: authoredId("storage", "clean-bowl"),
    },
  ];
  for (let index = 1; index <= BRAISE_ZONES; index++)
    carriers.push({
      id: authoredId("carrier", `braise-pan-${index}`),
      storage: authoredId("storage", "clean-braise-pans"),
    });
  for (let index = 1; index <= trays; index++)
    carriers.push({
      id: authoredId("carrier", `pie-tray-${index}`),
      storage: authoredId("storage", "clean-pie-trays"),
    });
  const places = ["prep", "hob", "sink", "oven", "cooling", "packing"];
  const travel = [];
  for (const from of places)
    for (const to of places)
      if (from !== to)
        travel.push({
          from: authoredId("location", from),
          to: authoredId("location", to),
          duration: seconds(recipe.durations.transfer),
          evidence: "assumed" as const,
        });
  const resources: CompiledScenario["resources"][number][] = [
    {
      id: authoredId("resource", "baker"),
      kind: "worker",
      capacity: 1,
      configuration: null,
      initialLocation: authoredId("location", "prep"),
      travel,
    },
    {
      id: authoredId("resource", "braise-hob"),
      kind: "capacity",
      capacity: BRAISE_ZONES,
      configuration: null,
    },
  ];
  for (const id of ["scale", "sink", "oven", "packing"])
    resources.push({
      id: authoredId("resource", id),
      kind: "capacity",
      capacity: 1,
      configuration: null,
    });
  const workflows: CompiledScenario["workflows"][number][] = [];
  const arrivals: CompiledScenario["arrivals"][number][] = [];
  if (prep) {
    workflows.push({
      id: authoredId("workflow", "shortcrust"),
      revision: digest,
      demand: "production",
      tasks: shortcrustTasks(recipe),
    });
    arrivals.push({
      id: authoredId("arrival-source", "shortcrust-batches"),
      kind: "explicit",
      workflow: authoredId("workflow", "shortcrust"),
      arrivals: [explicitArrival(recipe.shortcrust.arrival)],
    });
  }
  const dependencies: CompiledScenario["dependencies"][number][] = [];
  for (const filling of recipe.pies) {
    const fillingWorkflow = authoredId("workflow", `${filling.pie}-filling`);
    const fillingSource = authoredId(
      "arrival-source",
      `${filling.pie}-filling-batches`,
    );
    const pieWorkflow = authoredId("workflow", `${filling.pie}-pies`);
    const pieSource = authoredId(
      "arrival-source",
      `${filling.pie}-pie-batches`,
    );
    if (prep) {
      workflows.push({
        id: fillingWorkflow,
        revision: digest,
        demand: "production",
        tasks: fillingTasks(recipe, filling),
      });
      arrivals.push({
        id: fillingSource,
        kind: "explicit",
        workflow: fillingWorkflow,
        arrivals: Array.from({ length: filling.batches }, () =>
          explicitArrival(filling.arrival),
        ),
      });
    }
    if (assembly) {
      workflows.push({
        id: pieWorkflow,
        revision: digest,
        demand: "production",
        tasks: assemblyTasks(recipe, filling),
      });
      arrivals.push({
        id: pieSource,
        kind: "explicit",
        workflow: pieWorkflow,
        arrivals: [explicitArrival(filling.assemblyArrival)],
      });
    }
    if (!prep || !assembly) continue;
    // Tray k is set out once the rested shortcrust and filling batch k are
    // both released.
    for (let sequence = 0; sequence < filling.batches; sequence++) {
      const prepare = taskKey(
        `prepare-pie-tray-${trayRole(sequence).slice(-1)}`,
      );
      dependencies.push(
        {
          task: { source: pieSource, sequence: 0, key: prepare },
          prerequisite: {
            source: authoredId("arrival-source", "shortcrust-batches"),
            sequence: 0,
            key: taskKey("rest-shortcrust"),
          },
        },
        {
          task: { source: pieSource, sequence: 0, key: prepare },
          prerequisite: {
            source: fillingSource,
            sequence,
            key: taskKey("chill-filling"),
          },
        },
      );
    }
  }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "pies"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "assumed-pie-recipe"),
        revision: recipe.revision,
        digest,
      },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(28_800)),
      eventCap: MAX_EVENT_CAP,
    },
    products,
    destinations,
    resources,
    storages,
    stock,
    carriers,
    cells: [],
    workflows,
    arrivals,
    dependencies,
    availability: [],
  };
}

/**
 * Steak and pepper pie and beef bourguignon pie. Quantities are integer
 * milligrams; every mass balance is exact and every value is an assumption.
 */
export async function compilePieRecipe(
  raw: unknown,
): Promise<Result<CompiledScenario, PieRecipeProblem>> {
  try {
    const recipe = read(raw);
    let crust = 0;
    for (const [, amount] of recipe.shortcrust.ingredients) crust += amount;
    if (crust !== recipe.shortcrust.dough + recipe.shortcrust.residue)
      return err({ code: "shortcrust_mass_balance" });
    let pies = 0;
    for (const filling of recipe.pies) {
      let raw = 0;
      for (const stage of STAGES)
        for (const [, amount] of filling.ingredients[stage]) raw += amount;
      let searRaw = 0;
      for (const [, amount] of filling.ingredients.sear) searRaw += amount;
      if (
        filling.searLoss >= searRaw ||
        raw !==
          filling.filling +
            filling.residue +
            filling.searLoss +
            filling.braiseLoss +
            filling.reduceLoss ||
        filling.filling !== recipe.pie.filling * filling.count
      )
        return err({ code: "filling_mass_balance" });
      pies += filling.count * filling.batches;
    }
    if (recipe.shortcrust.dough !== recipe.pie.shell * pies)
      return err({ code: "insufficient_shortcrust" });
    const digest = d.digest(await sha256Hex(canonicalJson(recipe)));
    return ok(compile(recipe, digest));
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_pie_recipe" });
    throw error;
  }
}

/** Reference formula for one pan of filling, three pies of one type, in mg. */
const FILLING_FORMULA: Readonly<
  Record<
    PieType,
    Readonly<{
      sear: Readonly<Record<string, number>>;
      braise: Readonly<Record<string, number>>;
      thicken: Readonly<Record<string, number>>;
      searLossMg: number;
      braiseLossMg: number;
      reduceLossMg: number;
    }>
  >
> = {
  "steak-and-pepper": {
    sear: { "beef-chuck": 600_000, onion: 150_000 },
    braise: { "beef-stock": 250_000, "cracked-black-pepper": 4_000 },
    thicken: { "gravy-thickener": 20_000 },
    searLossMg: 45_000,
    braiseLossMg: 165_000,
    reduceLossMg: 20_000,
  },
  "beef-bourguignon": {
    sear: {
      "beef-chuck": 500_000,
      "bacon-lardons": 75_000,
      "pearl-onion": 100_000,
      mushroom: 125_000,
    },
    braise: { "red-wine": 200_000, "beef-stock": 100_000 },
    thicken: {},
    searLossMg: 60_000,
    braiseLossMg: 240_000,
    reduceLossMg: 5_000,
  },
};
const REFERENCE_PIES = 3;
/** Pies on one tray and from one braising pan. */
const PIES_PER_TRAY = 3;
/** Shortcrust for twelve 110 g bases: flour and butter 2:1, egg and water. */
const SHORTCRUST_FORMULA: Readonly<Record<ShortcrustIngredient, number>> = {
  "wheat-flour": 740_000,
  butter: 370_000,
  salt: 6_000,
  "whole-egg": 100_000,
  water: 125_000,
};
const SHORTCRUST_REFERENCE_PIES = 12;
const SHELL_MG = 110_000;
/** Four Vollrath induction units on the braising bench, each with its own pan. */
const BRAISE_ZONES = 4;
const FILLING_MG = 260_000;

function scaled(
  formula: Readonly<Record<string, number>>,
  pies: number,
  reference: number,
): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const [ingredient, amount] of Object.entries(formula))
    amounts[ingredient] = Math.round((amount * pies) / reference);
  return amounts;
}
function sum(amounts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const amount of Object.values(amounts)) total += amount;
  return total;
}

export type PieRecipeOptions = Readonly<{
  pies?: readonly PieType[];
  /** Pies of each type: 3 or 6, as trays of three. */
  piesPerType?: 3 | 6;
  shortcrustArrivalSeconds?: number;
  fillingArrivalsSeconds?: readonly number[];
  /** "full" by default; see PieStage. */
  stage?: PieStage;
  /** Assembly alone: when the pie bench takes each type's trays. */
  assemblyArrivalsSeconds?: readonly number[];
}>;

/**
 * Working formula with visibly assumed process values. The shortcrust and
 * filling are scaled to the pie count. Residue is what is left after the
 * exact 110 g bases and 260 g fillings are taken.
 */
export function pieRecipeInput(options: PieRecipeOptions = {}) {
  const types = options.pies ?? PIE_TYPES;
  const perType = options.piesPerType ?? 6;
  const stage = options.stage ?? "full";
  const trays = perType / PIES_PER_TRAY;
  const fillingArrivals = options.fillingArrivalsSeconds ?? [0, 60];
  const total = perType * types.length;
  const crust = scaled(SHORTCRUST_FORMULA, total, SHORTCRUST_REFERENCE_PIES);
  const dough = SHELL_MG * total;
  const durationsSeconds = {
    weigh: 15,
    "mix-shortcrust": 240,
    "wrap-shortcrust": 60,
    "rest-shortcrust": 1_800,
    release: 20,
    clean: 90,
    "put-away": 10,
    "place-pan": 10,
    sear: 600,
    braise: 5_400,
    reduce: 600,
    "transfer-filling": 60,
    "chill-filling": 3_600,
    "prepare-tray": 20,
    "line-tin": 45,
    "fill-pie": 30,
    "lid-pie": 50,
    "egg-wash": 60,
    transfer: 10,
    bake: 2_100,
    inspect: 30,
    cool: 1_800,
    pack: 120,
  };
  // The pie bench takes a type's trays when its filling can first be cold.
  const fillingSeconds =
    durationsSeconds.sear +
    durationsSeconds.braise +
    durationsSeconds.reduce +
    durationsSeconds["transfer-filling"] +
    durationsSeconds["chill-filling"];
  const pies = types.map((pie, index) => {
    const formula = FILLING_FORMULA[pie];
    const sear = scaled(formula.sear, PIES_PER_TRAY, REFERENCE_PIES);
    const braise = scaled(formula.braise, PIES_PER_TRAY, REFERENCE_PIES);
    const thicken = scaled(formula.thicken, PIES_PER_TRAY, REFERENCE_PIES);
    const searLossMg = formula.searLossMg;
    const braiseLossMg = formula.braiseLossMg;
    const reduceLossMg = formula.reduceLossMg;
    const fillingMg = FILLING_MG * PIES_PER_TRAY;
    return {
      pie,
      count: PIES_PER_TRAY,
      batches: trays,
      searMg: sear,
      braiseMg: braise,
      thickenMg: thicken,
      searLossMg,
      braiseLossMg,
      reduceLossMg,
      residueMg:
        sum(sear) +
        sum(braise) +
        sum(thicken) -
        searLossMg -
        braiseLossMg -
        reduceLossMg -
        fillingMg,
      fillingMg,
      arrivalSeconds: fillingArrivals[index] ?? 0,
      assemblyArrivalSeconds:
        stage === "assembly"
          ? (options.assemblyArrivalsSeconds?.[index] ?? 0)
          : (fillingArrivals[index] ?? 0) + fillingSeconds,
    };
  });
  return {
    revision: 1,
    evidence: "assumed",
    stage,
    shortcrust: {
      ingredientsMg: crust,
      residueMg: sum(crust) - dough,
      doughMg: dough,
      arrivalSeconds: options.shortcrustArrivalSeconds ?? 0,
    },
    pie: {
      shellMg: SHELL_MG,
      fillingMg: FILLING_MG,
      lidMg: 80_000,
      eggWashMg: 5_000,
      bakeLossMg: 25_000,
    },
    pies,
    measurementDifferenceMg: 0,
    durationsSeconds,
  };
}

function isPieWorkflow(workflowId: string): boolean {
  return (
    workflowId === "shortcrust" ||
    workflowId.endsWith("-filling") ||
    workflowId.endsWith("-pies")
  );
}

function binding(
  task: ScheduledTaskDescriptor,
  category: RecipeApplianceTaskBinding["category"],
  appliance: RecipeApplianceTaskBinding["appliance"],
  label: string,
  batch: RecipeApplianceTaskBinding["batch"],
  buildActions: RecipeApplianceTaskBinding["buildActions"],
): RecipeApplianceTaskBinding {
  return {
    taskId: task.taskId,
    instanceId: task.instanceId,
    workflowId: task.workflowId,
    taskKey: task.taskKey,
    startedAtUs: task.startedAtUs,
    completedAtUs: task.completedAtUs,
    category,
    appliance,
    label,
    batch,
    buildActions,
  };
}

/**
 * Binds the pie steps to the MuJoCo appliance models: the Ohaus scale, the
 * HL200 with its beater, the Vollrath induction hob with the induction pan,
 * the Hoshizaki refrigerator, the MuJoCo 4.0.0 deformable pastry bench, the
 * MBCO-5E convection oven and the Winterhalter warewasher.
 */
export function pieApplianceTask(
  task: ScheduledTaskDescriptor,
): RecipeApplianceTaskBinding | null {
  if (!isPieWorkflow(task.workflowId)) return null;
  const key = task.taskKey;
  const id = `${task.instanceId}-${key}`;
  const pie = pieTypeOf(task.workflowId);
  const product = pie === null ? "Pie shortcrust" : PIE_PRODUCTS[pie].title;
  if (key === "wrap-and-chill-shortcrust") {
    const batch = batchSpec(
      id,
      taskMaterialMassKg(task.definition, 1.32),
      8,
      1900,
      1.15,
      0.6,
    );
    return binding(
      task,
      "pastry-bench",
      "pastry-bench",
      "Flatten and fold 3D shortcrust dough block on the marble bench",
      batch,
      () => pastryPressDoughActions(batch, 21.0, 2.2),
    );
  }
  if (key.startsWith("line-tins")) {
    const batch = batchSpec(
      id,
      taskMaterialMassKg(task.definition, 0.33),
      8,
      1900,
      1.15,
      0.6,
    );
    return binding(
      task,
      "pastry-bench",
      "pastry-bench",
      `Sheet 3 mm shortcrust and line ${product.toLowerCase()} tins`,
      batch,
      () => pastrySheetActions(batch, 3.0, 2.4),
    );
  }
  if (key.startsWith("lid-pies")) {
    const batch = batchSpec(id, 0.24, 6, 1950, 1.08, 0.5);
    return binding(
      task,
      "pastry-bench",
      "pastry-bench",
      `Drape and crimp puff-pastry lids on ${product.toLowerCase()}s`,
      batch,
      () => pastryDrapeActions(batch, 42.0, 2.4),
    );
  }
  if (key.startsWith("weigh-")) {
    const batch = batchSpec(
      id,
      taskMaterialMassKg(task.definition, 0.2),
      6,
      3200,
      1.0,
      0.1,
    );
    return binding(
      task,
      "weigh",
      "ohaus-ranger-3000",
      `${product} ${key}`,
      batch,
      () => weighActions(batch),
    );
  }
  if (key === "mix-shortcrust") {
    // Cold butter rubbed into flour: a stiff batch on the beater's low speed.
    const batch = batchSpec(
      id,
      taskMaterialMassKg(task.definition, 1.32),
      8,
      1900,
      1.15,
      0.6,
    );
    return binding(
      task,
      "mixer",
      "hobart-hl200",
      "Mix shortcrust with the beater",
      batch,
      () => planetaryMixActions(batch, 1, 6),
    );
  }
  if (key === "rest-shortcrust" || key === "chill-filling") {
    const dough = key === "rest-shortcrust";
    const batch = batchSpec(
      id,
      // The resting task holds no lot: the dough for twelve bases, or the
      // filling from one braising pan.
      dough
        ? (SHELL_MG * 12) / 1_000_000
        : (FILLING_MG * PIES_PER_TRAY) / 1_000_000,
      dough ? 12 : 70,
      dough ? 1900 : 3300,
      dough ? 1.15 : 1.05,
      0.3,
    );
    return binding(
      task,
      "chiller",
      "hoshizaki-rt-120snj",
      dough
        ? "Rest shortcrust in the refrigerator"
        : `Chill the ${product.toLowerCase()} filling`,
      batch,
      () => chillerActions(batch, dough ? 8 : 12),
    );
  }
  if (
    key === "sear-beef" ||
    key === "braise-filling" ||
    key === "reduce-filling"
  ) {
    const batch = batchSpec(
      id,
      taskMaterialMassKg(task.definition, 1.6),
      key === "sear-beef" ? 6 : 80,
      3300,
      1.05,
      key === "sear-beef" ? 0.4 : 0.25,
    );
    return binding(
      task,
      "hob",
      "vollrath-59500p",
      key === "sear-beef"
        ? `Sear beef for the ${product.toLowerCase()}`
        : key === "braise-filling"
          ? `Braise the ${product.toLowerCase()} filling in the induction pan`
          : `Reduce the ${product.toLowerCase()} filling`,
      batch,
      () =>
        key === "braise-filling"
          ? hobTemperatureActions(batch, 90, 20)
          : hobPowerActions(batch, key === "sear-beef" ? 85 : 60, 10),
    );
  }
  if (key === "bake-pies") {
    // The oven model instruments one tray: the bake's mass over its trays.
    let trays = 0;
    for (const output of task.definition?.outputs ?? [])
      if (output.kind === "lot" && output.product === "baked-pie-mass")
        trays += 1;
    const batch = batchSpec(
      id,
      taskMaterialMassKg(task.definition, 2.58) / Math.max(1, trays),
      8,
      2900,
      0.95,
      0.3,
    );
    // The oven model runs on the same scaled programme as the financier bake;
    // a 35-minute pie bake is 2.3 times the 15-minute financier bake.
    return binding(
      task,
      "oven",
      "maruzen-mbco-5e",
      `Bake ${product.toLowerCase()}s in the convection oven`,
      batch,
      (context) => ovenBakeActions(batch, 55, 28, context),
    );
  }
  if (
    key === "clean-bowl" ||
    key === "clean-braise-pan" ||
    key === "wash-pie-trays"
  ) {
    const batch = batchSpec(
      id,
      key === "wash-pie-trays" ? 0.9 : 0.6,
      26,
      1000,
      1.18,
      0.02,
    );
    return binding(
      task,
      "dishwasher",
      "winterhalter-uc-l",
      `${product} ${key}`,
      batch,
      () => dishwasherActions(batch, 6),
    );
  }
  return null;
}

export function pieApplianceTasks(
  source: ScheduledTaskSource,
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    const bound = pieApplianceTask(task);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export async function executePieApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(pieApplianceTasks(source), runtime, {
    runId: options.runId ?? "pie-appliance-wasm",
    ...options,
  });
}
