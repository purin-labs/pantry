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
  type MaterialInput,
  type MaterialOutput,
  type TaskDefinition,
} from "../../scenario.ts";
import {
  ZERO_DURATION,
  durationFromSeconds,
  timeFromSeconds,
  type LogicalTime,
  type TickDuration,
} from "../../time.ts";

import {
  FINANCIER_FLAVOURS,
  financierBatterHolding,
  financierBatterPrepared,
  financierIngredients,
  financierPreparationSource,
  financierPreparationWorkflow,
  preparedFinancierBatter,
  type FinancierFlavour,
  type FinancierIngredient,
} from "./financier-flavours.ts";

type Ingredient = FinancierIngredient;
type Vessel = "pan" | "bowl";
type Place = "prep" | "hob" | "sink";
const OPERATIONS = [
  "weigh",
  "brown-butter",
  "return-pan",
  "mix",
  "store-batter",
  "clean",
  "put-away",
] as const;
type Operation = (typeof OPERATIONS)[number];

type Preparation = Readonly<{
  revision: number;
  evidence: "assumed";
  flavour: FinancierFlavour;
  /** Weighing order: the shared base, then the flavour's mix-ins. */
  order: readonly Ingredient[];
  ingredients: Readonly<Partial<Record<Ingredient, MaterialQuantity>>>;
  brownedButter: MaterialQuantity;
  batter: MaterialQuantity;
  evaporation: MaterialQuantity;
  residue: MaterialQuantity;
  spill: MaterialQuantity;
  holdingCapacity: MaterialQuantity;
  durations: Readonly<Record<Operation, TickDuration>>;
  travel: TickDuration;
  arrivals: readonly LogicalTime[];
  horizon: LogicalTime;
}>;

export type FinancierPreparationProblem = Readonly<{
  code: "invalid_preparation" | "browning_mass_balance" | "mixing_mass_balance";
}>;

function mass(raw: unknown): MaterialQuantity {
  return d.value(
    normalizeQuantity({
      amount: d.natural(raw),
      scale: 3,
      unit: "gram",
    }),
  );
}

function positiveMass(raw: unknown): MaterialQuantity {
  const value = mass(raw);
  d.requireValue(value.amount > 0);
  return value;
}

function duration(raw: unknown): TickDuration {
  d.requireValue(typeof raw === "number" && raw > 0);
  return d.value(durationFromSeconds(raw));
}

function arrival(raw: unknown): LogicalTime {
  d.requireValue(typeof raw === "number");
  return d.value(timeFromSeconds(raw));
}

function parsePreparation(raw: unknown): Preparation {
  const r = d.record(raw, [
    "revision",
    "evidence",
    "flavour",
    "ingredientsMg",
    "brownedButterMg",
    "batterMg",
    "evaporationMg",
    "residueMg",
    "spillMg",
    "measurementDifferenceMg",
    "holdingCapacityMg",
    "durationsSeconds",
    "travelSeconds",
    "arrivalsSeconds",
    "horizonSeconds",
  ]);
  const flavour = d.choice(r.flavour, ...FINANCIER_FLAVOURS);
  const order = financierIngredients(flavour);
  const rawIngredients = d.record(r.ingredientsMg, order);
  const ingredients: Partial<Record<Ingredient, MaterialQuantity>> = {};
  for (const ingredient of order)
    ingredients[ingredient] = positiveMass(rawIngredients[ingredient]);
  const durations = d.record(r.durationsSeconds, OPERATIONS);
  const normalizedDurations = {
    weigh: duration(durations.weigh),
    "brown-butter": duration(durations["brown-butter"]),
    "return-pan": duration(durations["return-pan"]),
    mix: duration(durations.mix),
    "store-batter": duration(durations["store-batter"]),
    clean: duration(durations.clean),
    "put-away": duration(durations["put-away"]),
  };
  // Synthetic quantities balance exactly. Measured discrepancies need a later
  // observation boundary; they cannot silently become an assumed process loss.
  d.requireValue(r.measurementDifferenceMg === 0);
  const travel = duration(r.travelSeconds);
  const arrivals = d.array(r.arrivalsSeconds, arrival);
  d.requireValue(arrivals.length > 0 && arrivals.length <= 6);
  for (const operation of [
    "brown-butter",
    "return-pan",
    "clean",
    "put-away",
  ] as const)
    d.requireValue(normalizedDurations[operation] >= travel);
  return {
    revision: d.positive(r.revision),
    evidence: d.choice(r.evidence, "assumed"),
    flavour,
    order,
    ingredients,
    brownedButter: positiveMass(r.brownedButterMg),
    batter: positiveMass(r.batterMg),
    evaporation: mass(r.evaporationMg),
    residue: mass(r.residueMg),
    spill: mass(r.spillMg),
    holdingCapacity: positiveMass(r.holdingCapacityMg),
    durations: normalizedDurations,
    travel,
    arrivals,
    horizon: arrival(r.horizonSeconds),
  };
}

function ingredientMass(
  preparation: Preparation,
  ingredient: Ingredient,
): MaterialQuantity {
  const quantity = preparation.ingredients[ingredient];
  if (quantity === undefined)
    throw new d.InvalidDocument("Missing financier ingredient");
  return quantity;
}

function lot(
  key: string,
  product: string,
  quantity: MaterialQuantity,
  vessel: Vessel,
): MaterialOutput {
  return {
    kind: "lot",
    lot: authoredId("lot-key", key),
    product: authoredId("product", product),
    quantity,
    holder: { kind: "carrier", carrier: authoredId("carrier-role", vessel) },
    disposition: "released",
    report: null,
  };
}

function input(key: string, quantity: MaterialQuantity): MaterialInput {
  return { kind: "lot", lot: authoredId("lot-key", key), quantity };
}

function loss(
  outputs: MaterialOutput[],
  product: string,
  destination: string,
  quantity: MaterialQuantity,
): void {
  if (quantity.amount === 0) return;
  outputs.push({
    kind: "exit",
    product: authoredId("product", product),
    quantity,
    destination: authoredId("destination", destination),
  });
}

function move(
  vessel: Vessel,
  from: string,
  to: string,
  placementAfter: TickDuration,
): CarrierStep {
  return {
    kind: "move",
    role: authoredId("carrier-role", vessel),
    from: authoredId("storage", from),
    to: authoredId("storage", to),
    timing: { kind: "declared", pickupAfter: ZERO_DURATION, placementAfter },
  };
}

function task(
  key: string,
  duration: TickDuration,
  previous: string | null,
  start: Place,
  finish: Place,
  resource: string | null,
  inputs: readonly MaterialInput[],
  outputs: readonly MaterialOutput[],
  carriers: readonly CarrierStep[],
): TaskDefinition {
  return {
    key: authoredId("task-key", key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous === null ? [] : [authoredId("task-key", previous)],
    claims:
      resource === null
        ? []
        : [
            {
              resource: authoredId("resource", resource),
              units: 1,
              configuration: null,
            },
          ],
    executor: {
      kind: "attended",
      duration,
      evidence: "assumed",
      workers: [authoredId("resource", "baker")],
      start: authoredId("location", start),
      finish: authoredId("location", finish),
    },
    inputs,
    outputs,
    releases: [],
    carriers,
  };
}

function compile(
  preparation: Preparation,
  revision: Sha256Hex,
): CompiledScenario {
  const mixInputs: MaterialInput[] = [
    input("browned-butter", preparation.brownedButter),
  ];
  const stock: CompiledScenario["stock"][number][] = [];
  const storages: CompiledScenario["storages"][number][] = [];
  const products: CompiledScenario["products"][number][] = [];
  for (const ingredient of preparation.order) {
    const quantity = ingredientMass(preparation, ingredient);
    const product = authoredId("product", ingredient);
    const storage = authoredId("storage", `${ingredient}-stock`);
    const total = mass(quantity.amount * preparation.arrivals.length);
    products.push({ id: product, unit: "milligram" });
    storages.push({
      id: storage,
      capacity: { kind: "material", product, quantity: total },
      cell: null,
    });
    stock.push({
      id: authoredId("lot", `${ingredient}-stock`),
      product,
      quantity: total,
      storage,
    });
    if (ingredient !== "butter")
      mixInputs.push(input(`weighed-${ingredient}`, quantity));
  }
  products.push(
    { id: authoredId("product", "browned-butter"), unit: "milligram" },
    { id: authoredId("product", "financier-batter"), unit: "milligram" },
    {
      id: authoredId("product", preparedFinancierBatter(preparation.flavour)),
      unit: "milligram",
    },
  );
  for (const [id, slots] of [
    ["clean-pan", 1],
    ["clean-bowl", 1],
    ["prep-vessels", 2],
    ["hob-vessel", 1],
    ["sink-vessels", 2],
  ] as const) {
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  }
  storages.push({
    id: authoredId("storage", financierBatterHolding(preparation.flavour)),
    capacity: {
      kind: "material",
      product: authoredId(
        "product",
        preparedFinancierBatter(preparation.flavour),
      ),
      quantity: preparation.holdingCapacity,
    },
    cell: null,
  });

  const brownOutputs = [
    lot("browned-butter", "browned-butter", preparation.brownedButter, "pan"),
  ];
  loss(brownOutputs, "butter", "butter-evaporation", preparation.evaporation);
  const mixOutputs = [
    lot("mixed-batter", "financier-batter", preparation.batter, "bowl"),
  ];
  loss(mixOutputs, "financier-batter", "mixing-residue", preparation.residue);
  loss(mixOutputs, "financier-batter", "mixing-spill", preparation.spill);

  const acquire: CarrierStep[] = [];
  const clean: CarrierStep[] = [];
  const putAway: CarrierStep[] = [];
  for (const vessel of ["pan", "bowl"] as const) {
    const role = authoredId("carrier-role", vessel);
    acquire.push({
      kind: "acquire",
      role,
      from: authoredId("storage", `clean-${vessel}`),
    });
    acquire.push(
      move(
        vessel,
        `clean-${vessel}`,
        "prep-vessels",
        preparation.durations.weigh,
      ),
    );
    clean.push(
      move(vessel, "prep-vessels", "sink-vessels", preparation.travel),
    );
    putAway.push(
      move(vessel, "sink-vessels", `clean-${vessel}`, preparation.travel),
    );
    putAway.push({ kind: "release", role });
  }
  const tasks: TaskDefinition[] = [];
  let previous: string | null = null;
  for (const ingredient of preparation.order) {
    const key = `weigh-${ingredient}`;
    const quantity = ingredientMass(preparation, ingredient);
    tasks.push(
      task(
        key,
        preparation.durations.weigh,
        previous,
        "prep",
        "prep",
        "scale",
        [
          {
            kind: "pool",
            product: authoredId("product", ingredient),
            quantity,
          },
        ],
        [
          lot(
            `weighed-${ingredient}`,
            ingredient,
            quantity,
            ingredient === "butter" ? "pan" : "bowl",
          ),
        ],
        previous === null ? acquire : [],
      ),
    );
    previous = key;
  }
  tasks.push(
    task(
      "brown-butter",
      preparation.durations["brown-butter"],
      previous,
      "prep",
      "hob",
      "hob",
      [input("weighed-butter", ingredientMass(preparation, "butter"))],
      brownOutputs,
      [move("pan", "prep-vessels", "hob-vessel", preparation.travel)],
    ),
    task(
      "return-pan",
      preparation.durations["return-pan"],
      "brown-butter",
      "hob",
      "prep",
      null,
      [],
      [],
      [move("pan", "hob-vessel", "prep-vessels", preparation.travel)],
    ),
    task(
      "mix",
      preparation.durations["mix"],
      "return-pan",
      "prep",
      "prep",
      null,
      mixInputs,
      mixOutputs,
      [],
    ),
    task(
      "store-batter",
      preparation.durations["store-batter"],
      "mix",
      "prep",
      "prep",
      null,
      [input("mixed-batter", preparation.batter)],
      [
        {
          kind: "lot",
          lot: authoredId("lot-key", "prepared-batter"),
          product: authoredId(
            "product",
            preparedFinancierBatter(preparation.flavour),
          ),
          quantity: preparation.batter,
          holder: {
            kind: "storage",
            storage: authoredId(
              "storage",
              financierBatterHolding(preparation.flavour),
            ),
          },
          disposition: "released",
          report: authoredId(
            "destination",
            financierBatterPrepared(preparation.flavour),
          ),
        },
      ],
      [],
    ),
    task(
      "clean",
      preparation.durations["clean"],
      "store-batter",
      "prep",
      "sink",
      "sink",
      [],
      [],
      clean,
    ),
    task(
      "put-away",
      preparation.durations["put-away"],
      "clean",
      "sink",
      "prep",
      null,
      [],
      [],
      putAway,
    ),
  );
  const travel = [];
  for (const from of ["prep", "hob", "sink"] as const)
    for (const to of ["prep", "hob", "sink"] as const)
      if (from !== to)
        travel.push({
          from: authoredId("location", from),
          to: authoredId("location", to),
          duration: preparation.travel,
          evidence: preparation.evidence,
        });

  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "financier-preparation"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId(
          "source",
          `assumed-${financierPreparationWorkflow(preparation.flavour)}`,
        ),
        revision: preparation.revision,
        digest: revision,
      },
    ],
    limits: { horizon: preparation.horizon, eventCap: MAX_EVENT_CAP },
    products,
    destinations: [
      {
        id: authoredId(
          "destination",
          financierBatterPrepared(preparation.flavour),
        ),
        role: "intermediate-stock",
        product: authoredId(
          "product",
          preparedFinancierBatter(preparation.flavour),
        ),
      },
      {
        id: authoredId("destination", "butter-evaporation"),
        role: "loss",
        product: authoredId("product", "butter"),
      },
      {
        id: authoredId("destination", "mixing-residue"),
        role: "loss",
        product: authoredId("product", "financier-batter"),
      },
      {
        id: authoredId("destination", "mixing-spill"),
        role: "loss",
        product: authoredId("product", "financier-batter"),
      },
    ],
    resources: [
      {
        id: authoredId("resource", "baker"),
        kind: "worker",
        capacity: 1,
        configuration: null,
        initialLocation: authoredId("location", "prep"),
        travel,
      },
      {
        id: authoredId("resource", "scale"),
        kind: "capacity",
        capacity: 1,
        configuration: null,
      },
      {
        id: authoredId("resource", "hob"),
        kind: "capacity",
        capacity: 1,
        configuration: null,
      },
      {
        id: authoredId("resource", "sink"),
        kind: "capacity",
        capacity: 1,
        configuration: null,
      },
    ],
    storages,
    stock,
    carriers: [
      {
        id: authoredId("carrier", "pan-1"),
        storage: authoredId("storage", "clean-pan"),
      },
      {
        id: authoredId("carrier", "bowl-1"),
        storage: authoredId("storage", "clean-bowl"),
      },
    ],
    cells: [],
    workflows: [
      {
        id: authoredId(
          "workflow",
          financierPreparationWorkflow(preparation.flavour),
        ),
        revision,
        demand: "production",
        tasks,
      },
    ],
    arrivals: [
      {
        id: authoredId(
          "arrival-source",
          financierPreparationSource(preparation.flavour),
        ),
        kind: "explicit",
        workflow: authoredId(
          "workflow",
          financierPreparationWorkflow(preparation.flavour),
        ),
        arrivals: preparation.arrivals.map(preparationArrival),
      },
    ],
    dependencies: [],
    availability: [],
  };
}

function preparationArrival(time: LogicalTime) {
  return { time, quantity: 1 };
}

/**
 * Admits a synthetic preparation fragment once, then uses the shared engine.
 * Quantities are integer milligrams. All process values are explicit assumptions.
 * It creates intermediate batter, with no bake result or saleable output.
 */
export async function compileFinancierPreparation(
  raw: unknown,
): Promise<Result<CompiledScenario, FinancierPreparationProblem>> {
  try {
    const preparation = parsePreparation(raw);
    if (
      ingredientMass(preparation, "butter").amount !==
      preparation.brownedButter.amount + preparation.evaporation.amount
    )
      return err({ code: "browning_mass_balance" });
    let mixed = preparation.brownedButter.amount;
    for (const ingredient of preparation.order)
      if (ingredient !== "butter")
        mixed += ingredientMass(preparation, ingredient).amount;
    if (
      !Number.isSafeInteger(mixed) ||
      mixed !==
        preparation.batter.amount +
          preparation.residue.amount +
          preparation.spill.amount
    )
      return err({ code: "mixing_mass_balance" });
    const revision = d.digest(await sha256Hex(canonicalJson(preparation)));
    return ok(compile(preparation, revision));
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_preparation" });
    throw error;
  }
}
