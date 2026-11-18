import type { Quantity } from "@seams/contracts";
import { canonicalJson, sha256Hex } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import type { RecipeAdapter, ValueProblem } from "../adapters.ts";
import { authoredId, parseSha256Hex, type ProductId } from "../identity.ts";
import {
  normalizeQuantity,
  zeroQuantity,
  type MaterialQuantity,
  type MaterialUnit,
} from "../quantity.ts";
import { err, ok } from "../result.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type ArrivalSource,
  type CompiledScenario,
  type InitialLot,
  type MaterialInput,
  type StorageDefinition,
} from "../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  timeFromSeconds,
  type LogicalTime,
  type TickDuration,
} from "../time.ts";

/**
 * The Plan 70C contract example: bounded fragments of the black sesame drink
 * and the combined café shift, compiled into shared core types. It checks the
 * engine contract against recipe composition. It is not a recipe engine and
 * holds no stock or schedule of its own.
 */

const INGREDIENTS = ["sesame", "sugar", "rice-flour", "water", "salt"] as const;
type Ingredient = (typeof INGREDIENTS)[number];

/** Every quantity, arrival and duration the example declares. */
export type ContractExampleValues = Readonly<{
  horizonSeconds: number;
  stock: Readonly<Record<Ingredient | "milk", Quantity>> &
    Readonly<{ portionedFinancierTrays: Quantity }>;
  concentrate: Readonly<{
    ingredients: Readonly<Record<Ingredient, Quantity>>;
    yield: Quantity;
    loss: Quantity;
    coldStoreCapacity: Quantity;
    prepareSeconds: number;
    coolSeconds: number;
    batchArrivalsSeconds: readonly number[];
  }>;
  drink: Readonly<{
    concentrate: Quantity;
    milk: Quantity;
    prepareSeconds: number;
    orderArrivalsSeconds: readonly number[];
  }>;
  oven: Readonly<{
    trays: number;
    changeoverSeconds: number;
    financier: Readonly<{
      trays: number;
      bakeSeconds: number;
      arrivalSeconds: number;
    }>;
    roast: Readonly<{
      trays: number;
      sesame: Quantity;
      roastSeconds: number;
      arrivalSeconds: number;
    }>;
  }>;
}>;

/** The declared values with the revision and content digest they were read at. */
export type ContractExampleSnapshot = Readonly<{
  source: Readonly<{ revision: number; digest: string }>;
  values: ContractExampleValues;
}>;

function grams(amount: number): Quantity {
  return { amount, scale: 0, unit: "gram" };
}

function each(amount: number): Quantity {
  return { amount, scale: 0, unit: "each" };
}

/**
 * One 760 g batch holds ten nominal 76 g portions. Twelve orders arrive from
 * the first batch's release; the second batch releases after ten are served.
 * Process durations are assumptions, declared here for inspection.
 */
export const CONTRACT_EXAMPLE: ContractExampleValues = Object.freeze({
  horizonSeconds: 7_200,
  stock: {
    sesame: grams(660),
    sugar: grams(240),
    "rice-flour": grams(40),
    water: grams(800),
    salt: grams(4),
    milk: grams(2_520),
    portionedFinancierTrays: each(2),
  },
  concentrate: {
    ingredients: {
      sesame: grams(220),
      sugar: grams(120),
      "rice-flour": grams(20),
      water: grams(400),
      salt: grams(2),
    },
    yield: grams(760),
    loss: grams(2),
    coldStoreCapacity: grams(1_520),
    prepareSeconds: 900,
    coolSeconds: 1_800,
    batchArrivalsSeconds: [0, 1_800],
  },
  drink: {
    concentrate: grams(76),
    milk: grams(210),
    prepareSeconds: 60,
    orderArrivalsSeconds: [
      2_700, 2_820, 2_940, 3_060, 3_180, 3_300, 3_420, 3_540, 3_660, 3_780,
      3_900, 4_020,
    ],
  },
  oven: {
    trays: 5,
    changeoverSeconds: 600,
    financier: { trays: 2, bakeSeconds: 780, arrivalSeconds: 0 },
    roast: {
      trays: 1,
      sesame: grams(220),
      roastSeconds: 600,
      arrivalSeconds: 60,
    },
  },
});

/** Binds declared values to their own content digest, as an authoring source would. */
export async function contractExampleSnapshot(
  values: ContractExampleValues,
  revision: number,
): Promise<ContractExampleSnapshot> {
  return {
    source: { revision, digest: await sha256Hex(canonicalJson(values)) },
    values,
  };
}

const SCENARIO = authoredId("scenario", "plan-70c-contract-example");
const SOURCE = authoredId("source", "plan-70c-contract-example");
const BAKER = authoredId("resource", "baker");
const HOB = authoredId("resource", "hob");
const MIXER = authoredId("resource", "heated-mixer");
const OVEN = authoredId("resource", "oven");
const OVEN_FINANCIER = authoredId("configuration", "financier-bake");
const OVEN_ROAST = authoredId("configuration", "sesame-roast");

const CONCENTRATE = authoredId("product", "sesame-concentrate");
const MILK = authoredId("product", "milk");
const DRINK = authoredId("product", "sesame-drink");
const ROASTED_SESAME = authoredId("product", "roasted-sesame");
const PORTIONED_TRAY = authoredId("product", "portioned-financier-tray");
const BAKED_TRAY = authoredId("product", "baked-financier-tray");

const COLD_STORE = authoredId("storage", "concentrate-cold-store");
const DRY_STORE = authoredId("storage", "roasted-sesame-store");
const COOLING_RACK = authoredId("storage", "cooling-rack");

const DRINKS_SERVED = authoredId("destination", "drinks-served");
const CONCENTRATE_MADE = authoredId("destination", "concentrate-made");
const CONCENTRATE_LOSS = authoredId("destination", "concentrate-process-loss");
const SESAME_ROASTED = authoredId("destination", "sesame-roasted");
const FINANCIER_BAKED = authoredId("destination", "financier-trays-baked");

const BATCH_WORKFLOW = authoredId("workflow", "concentrate-batch");
const DRINK_WORKFLOW = authoredId("workflow", "sesame-drink-order");
const BAKE_WORKFLOW = authoredId("workflow", "financier-bake");
const ROAST_WORKFLOW = authoredId("workflow", "sesame-roast");

const CONCENTRATE_LOT = authoredId("lot-key", "concentrate");

function ingredientProduct(ingredient: Ingredient | "milk"): ProductId {
  return ingredient === "milk" ? MILK : authoredId("product", ingredient);
}

function seconds(
  value: number,
  where: string,
  problems: ValueProblem[],
): LogicalTime {
  const parsed = timeFromSeconds(value);
  if (parsed.ok) return parsed.value;
  problems.push({ where, error: parsed.error });
  return ZERO_TIME;
}

function span(
  value: number,
  where: string,
  problems: ValueProblem[],
): TickDuration {
  const parsed = durationFromSeconds(value);
  if (parsed.ok) return parsed.value;
  problems.push({ where, error: parsed.error });
  return ZERO_DURATION;
}

// A wrong dimension is an unsupported conversion: the value fails, unchanged.
function measure(
  value: Quantity,
  unit: MaterialUnit,
  where: string,
  problems: ValueProblem[],
): MaterialQuantity {
  const parsed = normalizeQuantity(value);
  if (!parsed.ok) {
    problems.push({ where, error: parsed.error });
    return zeroQuantity(unit);
  }
  if (parsed.value.unit === unit) return parsed.value;
  problems.push({
    where,
    error: { code: "unit_mismatch", expected: unit, actual: parsed.value.unit },
  });
  return zeroQuantity(unit);
}

function explicitArrivals(
  times: readonly number[],
  where: string,
  problems: ValueProblem[],
): Variant<ArrivalSource, "explicit">["arrivals"] {
  const arrivals: { time: LogicalTime; quantity: number }[] = [];
  for (const [index, time] of times.entries())
    arrivals.push({
      time: seconds(time, `${where}[${index}]`, problems),
      quantity: 1,
    });
  return arrivals;
}

function materialStore(
  product: ProductId,
  capacity: MaterialQuantity,
): StorageDefinition {
  return {
    id: authoredId("storage", `${product}-stock`),
    capacity: { kind: "material", product, quantity: capacity },
    cell: null,
  };
}

function compile({
  source,
  values,
}: ContractExampleSnapshot): ReturnType<
  RecipeAdapter<ContractExampleSnapshot, ValueProblem>["compile"]
> {
  const problems: ValueProblem[] = [];
  const digest = parseSha256Hex(source.digest);
  if (!digest.ok) return err([{ where: "source.digest", error: digest.error }]);

  const storages: StorageDefinition[] = [];
  const stock: InitialLot[] = [];
  const batchInputs: MaterialInput[] = [];
  for (const ingredient of [...INGREDIENTS, "milk"] as const) {
    const product = ingredientProduct(ingredient);
    const quantity = measure(
      values.stock[ingredient],
      "milligram",
      `stock.${ingredient}`,
      problems,
    );
    const store = materialStore(product, quantity);
    storages.push(store);
    stock.push({
      id: authoredId("lot", `${product}-initial`),
      product,
      quantity,
      storage: store.id,
    });
  }
  for (const ingredient of INGREDIENTS)
    batchInputs.push({
      kind: "pool",
      product: ingredientProduct(ingredient),
      quantity: measure(
        values.concentrate.ingredients[ingredient],
        "milligram",
        `concentrate.ingredients.${ingredient}`,
        problems,
      ),
    });
  const trays = measure(
    values.stock.portionedFinancierTrays,
    "each",
    "stock.portionedFinancierTrays",
    problems,
  );
  const trayStore = materialStore(PORTIONED_TRAY, trays);
  storages.push(trayStore, {
    id: COLD_STORE,
    capacity: {
      kind: "material",
      product: CONCENTRATE,
      quantity: measure(
        values.concentrate.coldStoreCapacity,
        "milligram",
        "concentrate.coldStoreCapacity",
        problems,
      ),
    },
    cell: null,
  });
  stock.push({
    id: authoredId("lot", `${PORTIONED_TRAY}-initial`),
    product: PORTIONED_TRAY,
    quantity: trays,
    storage: trayStore.id,
  });
  const roastQuantity = measure(
    values.oven.roast.sesame,
    "milligram",
    "oven.roast.sesame",
    problems,
  );
  storages.push(
    {
      id: DRY_STORE,
      capacity: {
        kind: "material",
        product: ROASTED_SESAME,
        quantity: roastQuantity,
      },
      cell: null,
    },
    {
      id: COOLING_RACK,
      capacity: { kind: "material", product: BAKED_TRAY, quantity: trays },
      cell: null,
    },
  );
  const changeover = span(
    values.oven.changeoverSeconds,
    "oven.changeoverSeconds",
    problems,
  );
  const one = measure(each(1), "each", "drink", problems);

  const scenario: CompiledScenario = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: SCENARIO,
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: SOURCE,
        revision: source.revision,
        digest: digest.value,
      },
    ],
    limits: {
      horizon: seconds(values.horizonSeconds, "horizonSeconds", problems),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      { id: ingredientProduct("sesame"), unit: "milligram" },
      { id: ingredientProduct("sugar"), unit: "milligram" },
      { id: ingredientProduct("rice-flour"), unit: "milligram" },
      { id: ingredientProduct("water"), unit: "milligram" },
      { id: ingredientProduct("salt"), unit: "milligram" },
      { id: MILK, unit: "milligram" },
      { id: CONCENTRATE, unit: "milligram" },
      { id: ROASTED_SESAME, unit: "milligram" },
      { id: DRINK, unit: "each" },
      { id: PORTIONED_TRAY, unit: "each" },
      { id: BAKED_TRAY, unit: "each" },
    ],
    destinations: [
      { id: DRINKS_SERVED, role: "final-output", product: DRINK },
      {
        id: CONCENTRATE_MADE,
        role: "intermediate-stock",
        product: CONCENTRATE,
      },
      { id: CONCENTRATE_LOSS, role: "loss", product: CONCENTRATE },
      {
        id: SESAME_ROASTED,
        role: "intermediate-stock",
        product: ROASTED_SESAME,
      },
      { id: FINANCIER_BAKED, role: "intermediate-stock", product: BAKED_TRAY },
    ],
    resources: [
      { kind: "capacity", id: BAKER, capacity: 1, configuration: null },
      { kind: "capacity", id: HOB, capacity: 1, configuration: null },
      { kind: "capacity", id: MIXER, capacity: 1, configuration: null },
      {
        kind: "capacity",
        id: OVEN,
        capacity: values.oven.trays,
        configuration: {
          initial: OVEN_FINANCIER,
          changeovers: [
            {
              from: OVEN_FINANCIER,
              to: OVEN_ROAST,
              duration: changeover,
              evidence: "assumed",
              claims: [],
            },
            {
              from: OVEN_ROAST,
              to: OVEN_FINANCIER,
              duration: changeover,
              evidence: "assumed",
              claims: [],
            },
          ],
        },
      },
    ],
    storages,
    carriers: [],
    cells: [],
    stock,
    workflows: [
      {
        id: BATCH_WORKFLOW,
        revision: digest.value,
        demand: "production",
        tasks: [
          {
            key: authoredId("task-key", "prepare"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [
              { resource: BAKER, units: 1, configuration: null },
              { resource: HOB, units: 1, configuration: null },
            ],
            executor: {
              kind: "declared",
              duration: span(
                values.concentrate.prepareSeconds,
                "concentrate.prepareSeconds",
                problems,
              ),
              evidence: "assumed",
            },
            inputs: batchInputs,
            outputs: [
              {
                kind: "lot",
                lot: CONCENTRATE_LOT,
                product: CONCENTRATE,
                quantity: measure(
                  values.concentrate.yield,
                  "milligram",
                  "concentrate.yield",
                  problems,
                ),
                holder: { kind: "storage", storage: COLD_STORE },
                // Unavailable to orders until its explicit cooling release.
                disposition: "held",
                report: CONCENTRATE_MADE,
              },
              {
                kind: "exit",
                product: CONCENTRATE,
                quantity: measure(
                  values.concentrate.loss,
                  "milligram",
                  "concentrate.loss",
                  problems,
                ),
                destination: CONCENTRATE_LOSS,
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "cool"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [authoredId("task-key", "prepare")],
            claims: [],
            executor: {
              kind: "declared",
              duration: span(
                values.concentrate.coolSeconds,
                "concentrate.coolSeconds",
                problems,
              ),
              evidence: "assumed",
            },
            inputs: [],
            outputs: [],
            releases: [CONCENTRATE_LOT],
            carriers: [],
          },
        ],
      },
      {
        id: DRINK_WORKFLOW,
        revision: digest.value,
        demand: "order",
        tasks: [
          {
            key: authoredId("task-key", "prepare-drink"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [
              { resource: BAKER, units: 1, configuration: null },
              { resource: MIXER, units: 1, configuration: null },
            ],
            executor: {
              kind: "declared",
              duration: span(
                values.drink.prepareSeconds,
                "drink.prepareSeconds",
                problems,
              ),
              evidence: "assumed",
            },
            inputs: [
              {
                kind: "pool",
                product: CONCENTRATE,
                quantity: measure(
                  values.drink.concentrate,
                  "milligram",
                  "drink.concentrate",
                  problems,
                ),
              },
              {
                kind: "pool",
                product: MILK,
                quantity: measure(
                  values.drink.milk,
                  "milligram",
                  "drink.milk",
                  problems,
                ),
              },
            ],
            outputs: [
              {
                kind: "exit",
                product: DRINK,
                quantity: one,
                destination: DRINKS_SERVED,
              },
            ],
            releases: [],
            carriers: [],
          },
        ],
      },
      {
        id: BAKE_WORKFLOW,
        revision: digest.value,
        demand: "production",
        tasks: [
          {
            key: authoredId("task-key", "bake"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [
              {
                resource: OVEN,
                units: values.oven.financier.trays,
                configuration: OVEN_FINANCIER,
              },
            ],
            executor: {
              kind: "declared",
              duration: span(
                values.oven.financier.bakeSeconds,
                "oven.financier.bakeSeconds",
                problems,
              ),
              evidence: "assumed",
            },
            inputs: [
              { kind: "pool", product: PORTIONED_TRAY, quantity: trays },
            ],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "baked-trays"),
                product: BAKED_TRAY,
                quantity: trays,
                holder: { kind: "storage", storage: COOLING_RACK },
                disposition: "released",
                report: FINANCIER_BAKED,
              },
            ],
            releases: [],
            carriers: [],
          },
        ],
      },
      {
        id: ROAST_WORKFLOW,
        revision: digest.value,
        demand: "production",
        tasks: [
          {
            key: authoredId("task-key", "roast"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [
              {
                resource: OVEN,
                units: values.oven.roast.trays,
                configuration: OVEN_ROAST,
              },
            ],
            executor: {
              kind: "declared",
              duration: span(
                values.oven.roast.roastSeconds,
                "oven.roast.roastSeconds",
                problems,
              ),
              evidence: "assumed",
            },
            inputs: [
              {
                kind: "pool",
                product: ingredientProduct("sesame"),
                quantity: roastQuantity,
              },
            ],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "roasted-sesame"),
                product: ROASTED_SESAME,
                quantity: roastQuantity,
                holder: { kind: "storage", storage: DRY_STORE },
                disposition: "released",
                report: SESAME_ROASTED,
              },
            ],
            releases: [],
            carriers: [],
          },
        ],
      },
    ],
    arrivals: [
      {
        id: authoredId("arrival-source", "concentrate-batches"),
        workflow: BATCH_WORKFLOW,
        kind: "explicit",
        arrivals: explicitArrivals(
          values.concentrate.batchArrivalsSeconds,
          "concentrate.batchArrivalsSeconds",
          problems,
        ),
      },
      {
        id: authoredId("arrival-source", "drink-orders"),
        workflow: DRINK_WORKFLOW,
        kind: "explicit",
        arrivals: explicitArrivals(
          values.drink.orderArrivalsSeconds,
          "drink.orderArrivalsSeconds",
          problems,
        ),
      },
      {
        id: authoredId("arrival-source", "financier-bakes"),
        workflow: BAKE_WORKFLOW,
        kind: "explicit",
        arrivals: explicitArrivals(
          [values.oven.financier.arrivalSeconds],
          "oven.financier.arrivalSeconds",
          problems,
        ),
      },
      {
        id: authoredId("arrival-source", "sesame-roasts"),
        workflow: ROAST_WORKFLOW,
        kind: "explicit",
        arrivals: explicitArrivals(
          [values.oven.roast.arrivalSeconds],
          "oven.roast.arrivalSeconds",
          problems,
        ),
      },
    ],
    availability: [],
    dependencies: [],
  };
  return problems.length === 0 ? ok(scenario) : err(problems);
}

export const contractExampleAdapter: RecipeAdapter<
  ContractExampleSnapshot,
  ValueProblem
> = Object.freeze({ compile });
