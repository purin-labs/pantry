import { canonicalJson, sha256Hex } from "@seams/std";
import { parsePersistentCell } from "@seams/bakery-model/bakery-physics";
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
  type LotHolder,
  type TaskDefinition,
} from "../../scenario.ts";
import {
  durationFromSeconds,
  modelTimestep,
  timeFromSeconds,
  ZERO_DURATION,
} from "../../time.ts";

type ColdRackCell = CompiledScenario["cells"][number];

const INGREDIENTS = {
  sesame: 220_000,
  sugar: 120_000,
  "rice-flour": 20_000,
  water: 400_000,
  salt: 2_000,
} as const;
const STAGES = [
  "weigh",
  "roast",
  "stir",
  "roast-cool",
  "grind",
  "slurry",
  "dissolve",
  "blend",
  "scrape",
  "standardize",
  "cool",
  "release",
  "bottle",
  "clean",
  "dose",
  "cup",
  "heat",
  "pour",
  "wash-jug",
  "return",
] as const;
const VESSELS = ["pan", "grinder-cup", "blender-jar", "cooling-pan"] as const;
type Stage = (typeof STAGES)[number];
type Recipe = Readonly<{
  revision: number;
  roast: "skip" | "refresh";
  batchArrivals: readonly number[];
  orderArrivals: readonly number[];
  grindLoads: readonly number[];
  evaporation: number;
  residue: number;
  spill: number;
  waterAdded: number;
  excessDiscarded: number;
  blendedMass: number;
  jugs: number;
  durations: Readonly<Record<Stage, number>>;
}>;
export type BlackSesameProblem = Readonly<{
  code: "invalid_black_sesame_recipe" | "concentrate_mass_balance";
}>;

/** Each batch fills one 380 g bottle at each of the two refrigerator positions. */
const BOTTLES = ["bottle-a", "bottle-b"] as const;
const BOTTLE_MG = 380_000;

function mass(amount: number): MaterialQuantity {
  return d.value(normalizeQuantity({ amount, scale: 3, unit: "gram" }));
}
function count(amount: number): MaterialQuantity {
  return d.value(normalizeQuantity({ amount, scale: 0, unit: "each" }));
}
function seconds(value: number) {
  return d.value(durationFromSeconds(value));
}
function arrival(raw: unknown): number {
  const value = d.natural(raw);
  d.requireValue(value < 21_600);
  return value;
}
function readDuration(raw: unknown): number {
  const value = d.positive(raw);
  d.requireValue(value <= 7_200);
  return value;
}
function grindLoad(raw: unknown): number {
  const value = d.positive(raw);
  d.requireValue(value >= 50_000 && value <= 75_000);
  return value;
}
function read(raw: unknown): Recipe {
  const r = d.record(raw, [
    "revision",
    "evidence",
    "roast",
    "batchArrivalsSeconds",
    "orderArrivalsSeconds",
    "grindLoadsMg",
    "evaporationMg",
    "residueMg",
    "spillMg",
    "waterAddedMg",
    "excessDiscardedMg",
    "measurementDifferenceMg",
    "jugCount",
    "durationsSeconds",
  ]);
  d.choice(r.evidence, "assumed");
  d.requireValue(r.measurementDifferenceMg === 0);
  const batchArrivals = d.array(r.batchArrivalsSeconds, arrival);
  const orderArrivals = d.array(r.orderArrivalsSeconds, arrival);
  d.requireValue(batchArrivals.length > 0 && batchArrivals.length <= 3);
  d.requireValue(orderArrivals.length > 0 && orderArrivals.length <= 30);
  const grindLoads = d.array(r.grindLoadsMg, grindLoad);
  let ground = 0;
  for (const load of grindLoads) ground += load;
  d.requireValue(ground === INGREDIENTS.sesame);
  const rawDurations = d.record(r.durationsSeconds, STAGES);
  const durations = {
    weigh: readDuration(rawDurations.weigh),
    roast: readDuration(rawDurations.roast),
    stir: readDuration(rawDurations.stir),
    "roast-cool": readDuration(rawDurations["roast-cool"]),
    grind: readDuration(rawDurations.grind),
    slurry: readDuration(rawDurations.slurry),
    dissolve: readDuration(rawDurations.dissolve),
    blend: readDuration(rawDurations.blend),
    scrape: readDuration(rawDurations.scrape),
    standardize: readDuration(rawDurations.standardize),
    cool: readDuration(rawDurations.cool),
    release: readDuration(rawDurations.release),
    bottle: readDuration(rawDurations.bottle),
    clean: readDuration(rawDurations.clean),
    dose: readDuration(rawDurations.dose),
    cup: readDuration(rawDurations.cup),
    heat: readDuration(rawDurations.heat),
    pour: readDuration(rawDurations.pour),
    "wash-jug": readDuration(rawDurations["wash-jug"]),
    return: readDuration(rawDurations.return),
  };
  const evaporation = d.natural(r.evaporationMg);
  const residue = d.natural(r.residueMg);
  const spill = d.natural(r.spillMg);
  d.requireValue(evaporation < 400_000 && residue + spill < 220_000);
  const jugs = d.positive(r.jugCount);
  d.requireValue(jugs <= 3);
  return {
    revision: d.positive(r.revision),
    roast: d.choice(r.roast, "skip", "refresh"),
    batchArrivals,
    orderArrivals,
    grindLoads,
    evaporation,
    residue,
    spill,
    waterAdded: d.natural(r.waterAddedMg),
    excessDiscarded: d.natural(r.excessDiscardedMg),
    blendedMass: 762_000 - evaporation - residue - spill,
    jugs,
    durations,
  };
}

function pool(product: string, quantity: MaterialQuantity): MaterialInput {
  return { kind: "pool", product: authoredId("product", product), quantity };
}
function input(lot: string, quantity: MaterialQuantity): MaterialInput {
  return { kind: "lot", lot: authoredId("lot-key", lot), quantity };
}
function lot(
  key: string,
  product: string,
  quantity: MaterialQuantity,
  holder: LotHolder,
  disposition: "held" | "released",
): MaterialOutput {
  return {
    kind: "lot",
    lot: authoredId("lot-key", key),
    product: authoredId("product", product),
    quantity,
    holder,
    disposition,
    report: null,
  };
}
function vessel(role: string) {
  return {
    kind: "carrier" as const,
    carrier: authoredId("carrier-role", role),
  };
}
function storage(id: string) {
  return { kind: "storage" as const, storage: authoredId("storage", id) };
}
function exit(product: string, quantity: MaterialQuantity): MaterialOutput {
  return {
    kind: "exit",
    product: authoredId("product", product),
    quantity,
    destination: authoredId("destination", product),
  };
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
function task(
  key: string,
  previous: readonly string[],
  duration: number,
  work: "attended" | "declared",
  resources: readonly string[],
  inputs: readonly MaterialInput[],
  outputs: readonly MaterialOutput[],
  carriers: readonly CarrierStep[],
  releases: readonly string[] = [],
): TaskDefinition {
  return {
    key: authoredId("task-key", key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous.map(taskKey),
    executor:
      work === "declared"
        ? { kind: "declared", duration: seconds(duration), evidence: "assumed" }
        : {
            kind: "attended",
            duration: seconds(duration),
            evidence: "assumed",
            workers: [authoredId("resource", "baker")],
            start: authoredId("location", "sesame-station"),
            finish: authoredId("location", "sesame-station"),
          },
    claims: resources.map(resourceClaim),
    inputs,
    outputs,
    carriers,
    releases: releases.map(lotKey),
  };
}
function taskKey(key: string) {
  return authoredId("task-key", key);
}
function lotKey(key: string) {
  return authoredId("lot-key", key);
}
function resourceClaim(id: string) {
  return {
    resource: authoredId("resource", id),
    units: 1,
    configuration: null,
  };
}
function readColdCell(rawCell: unknown): ColdRackCell {
  const definition = parsePersistentCell(rawCell);
  d.requireValue(
    definition !== null &&
      definition.fixture === "persistent-rack/1" &&
      definition.ingredients.massKg === 1 &&
      definition.ingredients.forwardMm === 0 &&
      definition.ingredients.lateralMm === 0 &&
      definition.clampForceN === 100,
  );
  return {
    id: authoredId("cell", definition.cellId),
    modelHash: d.digest(definition.modelHash),
    controllerSourceHash: d.digest(definition.execution.controllerSourceHash),
    timestepMicroseconds: d.value(modelTimestep(definition.timestep)),
    carrierSlots: 1,
    holdModel: authoredId("hold-model", "cold-cell-rest.1"),
  };
}

function batchTasks(
  recipe: Recipe,
  cell: ColdRackCell | null,
): TaskDefinition[] {
  const t = recipe.durations;
  const tasks: TaskDefinition[] = [];
  const vessels: CarrierStep[] = [];
  for (const role of VESSELS) {
    vessels.push(
      acquire(role, `clean-${role}`),
      move(role, `clean-${role}`, "batch-vessels", t.weigh),
    );
  }
  let previous: string | null = null;
  for (const [name, amount] of Object.entries(INGREDIENTS)) {
    const key = `weigh-${name}`;
    tasks.push(
      task(
        key,
        previous === null ? [] : [previous],
        t.weigh,
        "attended",
        ["scale"],
        [pool(name, mass(amount))],
        [
          lot(
            name,
            name,
            mass(amount),
            vessel(name === "sesame" ? "grinder-cup" : "pan"),
            "released",
          ),
        ],
        previous === null ? vessels : [],
      ),
    );
    previous = key;
  }
  if (previous === null) throw new Error("The recipe requires ingredients");
  if (recipe.roast === "refresh") {
    tasks.push(
      task(
        "roast-first-half",
        [previous],
        t.roast / 2,
        "declared",
        ["oven", "roast-tray"],
        [],
        [],
        [],
      ),
      task(
        "stir-roast",
        ["roast-first-half"],
        t.stir,
        "attended",
        ["oven", "roast-tray"],
        [],
        [],
        [],
      ),
      task(
        "roast-second-half",
        ["stir-roast"],
        t.roast / 2,
        "declared",
        ["oven", "roast-tray"],
        [],
        [],
        [],
      ),
      task(
        "cool-roasted-seeds",
        ["roast-second-half"],
        t["roast-cool"],
        "declared",
        ["roast-tray"],
        [],
        [],
        [],
      ),
    );
    previous = "cool-roasted-seeds";
  }
  const blendInputs: MaterialInput[] = [];
  for (const [index, amount] of recipe.grindLoads.entries()) {
    const key = `grind-${index + 1}`;
    tasks.push(
      task(
        key,
        [previous],
        t.grind,
        "attended",
        ["grinder"],
        [input("sesame", mass(amount))],
        [
          lot(
            key,
            "ground-sesame",
            mass(amount),
            vessel("blender-jar"),
            "released",
          ),
        ],
        [],
      ),
    );
    blendInputs.push(input(key, mass(amount)));
    previous = key;
  }
  const slurryMass = 420_000 - recipe.evaporation;
  const slurryOutputs = [
    lot("slurry", "slurry", mass(slurryMass), vessel("pan"), "released"),
  ];
  if (recipe.evaporation > 0)
    slurryOutputs.push(exit("evaporation", mass(recipe.evaporation)));
  tasks.push(
    task(
      "cook-slurry-continuous-stir",
      [previous],
      t.slurry,
      "attended",
      ["hob"],
      [input("water", mass(400_000)), input("rice-flour", mass(20_000))],
      slurryOutputs,
      [],
    ),
  );
  tasks.push(
    task(
      "dissolve-sugar-and-salt",
      ["cook-slurry-continuous-stir"],
      t.dissolve,
      "attended",
      [],
      [
        input("slurry", mass(slurryMass)),
        input("sugar", mass(120_000)),
        input("salt", mass(2_000)),
      ],
      [
        lot(
          "sweet-slurry",
          "sweet-slurry",
          mass(slurryMass + 122_000),
          vessel("pan"),
          "released",
        ),
      ],
      [],
    ),
  );
  blendInputs.push(input("sweet-slurry", mass(slurryMass + 122_000)));
  const blended = [
    lot(
      "blended",
      "blended-base",
      mass(recipe.blendedMass),
      vessel("blender-jar"),
      "released",
    ),
  ];
  if (recipe.residue > 0) blended.push(exit("residue", mass(recipe.residue)));
  if (recipe.spill > 0) blended.push(exit("spill", mass(recipe.spill)));
  tasks.push(
    task(
      "blend",
      ["dissolve-sugar-and-salt"],
      t.blend,
      "attended",
      ["blender"],
      blendInputs,
      blended,
      [],
    ),
    task(
      "scrape-and-weigh",
      ["blend"],
      t.scrape,
      "attended",
      ["scale"],
      [],
      [],
      [],
    ),
  );
  const standardInputs = [input("blended", mass(recipe.blendedMass))];
  if (recipe.waterAdded > 0)
    standardInputs.push(pool("water", mass(recipe.waterAdded)));
  const standardOutputs = [
    lot(
      "standard-base",
      "standard-base",
      mass(760_000),
      vessel("cooling-pan"),
      "held",
    ),
  ];
  if (recipe.excessDiscarded > 0)
    standardOutputs.push(
      exit("excess-discarded", mass(recipe.excessDiscarded)),
    );
  tasks.push(
    task(
      "standardize-mass",
      ["scrape-and-weigh"],
      t.standardize,
      "attended",
      ["scale"],
      standardInputs,
      standardOutputs,
      [],
    ),
    task(
      "cool-in-bath",
      ["standardize-mass"],
      t.cool,
      "declared",
      ["cooling-bath"],
      [],
      [],
      [],
    ),
    task(
      "assumed-cooling-release",
      ["cool-in-bath"],
      t.release,
      "attended",
      [],
      [],
      [],
      [],
      ["standard-base"],
    ),
  );
  let fillPrerequisite = "assumed-cooling-release";
  if (cell !== null) {
    tasks.push(
      task(
        "stage-cold-carrier",
        ["assumed-cooling-release"],
        t.return,
        "attended",
        [],
        [],
        [],
        [
          acquire("cold-carrier", "clean-cold-carrier"),
          move("cold-carrier", "clean-cold-carrier", "cold-staging-table", t.return),
        ],
      ),
      {
        key: authoredId("task-key", "transfer-cold-carrier"),
        priority: 0,
        releaseAfter: ZERO_DURATION,
        prerequisites: [taskKey("stage-cold-carrier")],
        executor: {
          kind: "native",
          operation: {
            cell: cell.id,
            skill: authoredId("skill", "rack-transfer"),
            parameters: cell.modelHash,
          },
        },
        claims: [resourceClaim("cold-cell-arm")],
        inputs: [],
        outputs: [],
        carriers: [
          {
            kind: "move",
            role: authoredId("carrier-role", "cold-carrier"),
            from: authoredId("storage", "cold-staging-table"),
            to: authoredId("storage", "cold-staging-rack"),
            timing: { kind: "native" },
          },
        ],
        releases: [],
      },
      task(
        "handoff-cold-carrier",
        ["transfer-cold-carrier"],
        t.return,
        "attended",
        [],
        [],
        [],
        [
          move("cold-carrier", "cold-staging-rack", "refrigerator-shelf", t.return),
        ],
      ),
    );
    fillPrerequisite = "handoff-cold-carrier";
  }
  const filled: string[] = [];
  for (const bottle of BOTTLES) {
    const key = `wash-and-fill-${bottle}`;
    tasks.push(
      task(
        key,
        [fillPrerequisite],
        t.bottle,
        "attended",
        ["sink", "scale"],
        [input("standard-base", mass(BOTTLE_MG))],
        [
          lot(
            bottle,
            "concentrate",
            mass(BOTTLE_MG),
            storage(bottle),
            "released",
          ),
        ],
        [],
      ),
    );
    filled.push(key);
  }
  const washing: CarrierStep[] = [];
  const returning: CarrierStep[] = [];
  for (const role of VESSELS) {
    washing.push(move(role, "batch-vessels", "batch-wash", t.clean));
    returning.push(
      move(role, "batch-wash", `clean-${role}`, t.return),
      release(role),
    );
  }
  if (cell !== null) {
    returning.push(
      move("cold-carrier", "refrigerator-shelf", "clean-cold-carrier", t.return),
      release("cold-carrier"),
    );
  }
  tasks.push(
    task(
      "clean-batch-vessels",
      filled,
      t.clean,
      "attended",
      ["sink"],
      [],
      [],
      washing,
    ),
    task(
      "return-batch-vessels",
      ["clean-batch-vessels"],
      t.return,
      "attended",
      [],
      [],
      [],
      returning,
    ),
  );
  return tasks;
}

function drinkTasks(recipe: Recipe): TaskDefinition[] {
  const t = recipe.durations;
  return [
    task(
      "dose",
      [],
      t.dose,
      "attended",
      ["scale"],
      [pool("concentrate", mass(76_000)), pool("milk", mass(210_000))],
      [lot("dose", "drink-mixture", mass(286_000), vessel("jug"), "released")],
      [
        acquire("jug", "clean-jugs"),
        move("jug", "clean-jugs", "mixer-seat", t.dose),
      ],
    ),
    task(
      "prepare-cup",
      ["dose"],
      t.cup,
      "attended",
      [],
      [pool("empty-cup", count(1))],
      [lot("cup", "empty-cup", count(1), vessel("jug"), "released")],
      [],
    ),
    task(
      "heat-and-mix",
      ["prepare-cup"],
      t.heat,
      "declared",
      ["heated-mixer"],
      [],
      [],
      [],
    ),
    task(
      "pour-and-serve",
      ["heat-and-mix"],
      t.pour,
      "attended",
      ["heated-mixer"],
      [input("dose", mass(286_000)), input("cup", count(1))],
      [exit("drink-mass", mass(286_000)), exit("drinks-served", count(1))],
      [move("jug", "mixer-seat", "dirty-jugs", t.pour)],
    ),
    task(
      "wash-jug",
      ["pour-and-serve"],
      t["wash-jug"],
      "attended",
      ["sink"],
      [],
      [],
      [move("jug", "dirty-jugs", "jug-wash", t["wash-jug"])],
    ),
    task(
      "return-jug",
      ["wash-jug"],
      t.return,
      "attended",
      [],
      [],
      [],
      [move("jug", "jug-wash", "clean-jugs", t.return), release("jug")],
    ),
  ];
}

function compile(
  recipe: Recipe,
  cell: ColdRackCell | null,
  digest: Sha256Hex,
): CompiledScenario {
  const products: CompiledScenario["products"][number][] = [];
  const storages: CompiledScenario["storages"][number][] = [];
  const stock: CompiledScenario["stock"][number][] = [];
  const batches = recipe.batchArrivals.length;
  const stocks = {
    ...INGREDIENTS,
    water: INGREDIENTS.water + recipe.waterAdded,
  };
  for (const [name, amount] of Object.entries(stocks)) {
    const quantity = mass(amount * batches);
    const product = authoredId("product", name);
    const place = authoredId("storage", `${name}-stock`);
    products.push({ id: product, unit: "milligram" });
    storages.push({
      id: place,
      capacity: { kind: "material", product, quantity },
      cell: null,
    });
    stock.push({
      id: authoredId("lot", `${name}-stock`),
      product,
      quantity,
      storage: place,
    });
  }
  for (const [name, quantity] of [
    ["milk", mass(210_000 * recipe.orderArrivals.length)],
    ["empty-cup", count(recipe.orderArrivals.length)],
  ] as const) {
    const product = authoredId("product", name);
    const place = authoredId("storage", `${name}-stock`);
    products.push({ id: product, unit: quantity.unit });
    storages.push({
      id: place,
      capacity: { kind: "material", product, quantity },
      cell: null,
    });
    stock.push({
      id: authoredId("lot", `${name}-stock`),
      product,
      quantity,
      storage: place,
    });
  }
  for (const id of [
    "ground-sesame",
    "slurry",
    "sweet-slurry",
    "blended-base",
    "standard-base",
    "concentrate",
    "drink-mixture",
    "evaporation",
    "residue",
    "spill",
    "excess-discarded",
    "drink-mass",
  ])
    products.push({ id: authoredId("product", id), unit: "milligram" });
  products.push({ id: authoredId("product", "drinks-served"), unit: "each" });
  // Each position holds one bottle, so a later batch washes and refills a
  // bottle only after service has used up its previous contents.
  for (const id of BOTTLES) storages.push(bottlePosition(id, 1));
  const carriers: CompiledScenario["carriers"][number][] = [];
  for (const id of VESSELS) {
    const place = authoredId("storage", `clean-${id}`);
    storages.push({
      id: place,
      capacity: { kind: "carriers", slots: 1 },
      cell: null,
    });
    carriers.push({ id: authoredId("carrier", id), storage: place });
  }
  for (const [id, slots] of [
    ["batch-vessels", 4],
    ["batch-wash", 4],
    ["clean-jugs", recipe.jugs],
    ["mixer-seat", 1],
    ["dirty-jugs", recipe.jugs],
    ["jug-wash", 1],
  ] as const)
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  for (let i = 1; i <= recipe.jugs; i++)
    carriers.push({
      id: authoredId("carrier", `jug-${i}`),
      storage: authoredId("storage", "clean-jugs"),
    });
  if (cell !== null) {
    storages.push(
      {
        id: authoredId("storage", "clean-cold-carrier"),
        capacity: { kind: "carriers", slots: 1 },
        cell: null,
      },
      {
        id: authoredId("storage", "cold-staging-table"),
        capacity: { kind: "carriers", slots: 1 },
        cell: cell.id,
      },
      {
        id: authoredId("storage", "cold-staging-rack"),
        capacity: { kind: "carriers", slots: 1 },
        cell: cell.id,
      },
      {
        id: authoredId("storage", "refrigerator-shelf"),
        capacity: { kind: "carriers", slots: 1 },
        cell: null,
      },
    );
    carriers.push({
      id: authoredId("carrier", "cold-container-carrier"),
      storage: authoredId("storage", "clean-cold-carrier"),
    });
  }
  const resources: CompiledScenario["resources"][number][] = [
    {
      id: authoredId("resource", "baker"),
      kind: "worker",
      capacity: 1,
      configuration: null,
      initialLocation: authoredId("location", "sesame-station"),
      travel: [],
    },
  ];
  for (const id of cell === null
    ? [
        "scale",
        "oven",
        "roast-tray",
        "grinder",
        "hob",
        "blender",
        "cooling-bath",
        "sink",
        "heated-mixer",
      ]
    : [
        "scale",
        "oven",
        "roast-tray",
        "grinder",
        "hob",
        "blender",
        "cooling-bath",
        "sink",
        "heated-mixer",
        "cold-cell-arm",
      ])
    resources.push({
      id: authoredId("resource", id),
      kind: "capacity",
      capacity: 1,
      configuration: null,
    });
  const destinations: CompiledScenario["destinations"][number][] = [];
  for (const id of ["evaporation", "residue", "spill", "excess-discarded"])
    destinations.push({
      id: authoredId("destination", id),
      product: authoredId("product", id),
      role: "loss",
    });
  for (const id of ["drink-mass", "drinks-served"])
    destinations.push({
      id: authoredId("destination", id),
      product: authoredId("product", id),
      role: "final-output",
    });
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "black-sesame-milk"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "assumed-black-sesame-recipe"),
        revision: recipe.revision,
        digest,
      },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(21_600)),
      eventCap: MAX_EVENT_CAP,
    },
    products,
    destinations,
    storages,
    carriers,
    stock,
    resources,
    cells: cell === null ? [] : [cell],
    workflows: [
      {
        id: authoredId("workflow", "sesame-batch"),
        revision: digest,
        demand: "production",
        tasks: batchTasks(recipe, cell),
      },
      {
        id: authoredId("workflow", "sesame-drink"),
        revision: digest,
        demand: "order",
        tasks: drinkTasks(recipe),
      },
    ],
    arrivals: [
      {
        id: authoredId("arrival-source", "sesame-batches"),
        workflow: authoredId("workflow", "sesame-batch"),
        kind: "explicit",
        arrivals: recipe.batchArrivals.map(explicitArrival),
      },
      {
        id: authoredId("arrival-source", "sesame-orders"),
        workflow: authoredId("workflow", "sesame-drink"),
        kind: "explicit",
        arrivals: recipe.orderArrivals.map(explicitArrival),
      },
    ],
    dependencies: [],
    availability: [],
  };
}
function explicitArrival(seconds: number) {
  return { time: d.value(timeFromSeconds(seconds)), quantity: 1 };
}

/** Synthetic process rehearsal. The same engine owns all stock and scheduling. */
export async function compileBlackSesameRecipe(
  raw: unknown,
  rawCell?: unknown,
): Promise<Result<CompiledScenario, BlackSesameProblem>> {
  try {
    const recipe = read(raw);
    const cell = rawCell === undefined ? null : readColdCell(rawCell);
    if (
      recipe.blendedMass + recipe.waterAdded - recipe.excessDiscarded !==
        760_000 ||
      (recipe.blendedMass < 760_000 && recipe.excessDiscarded !== 0) ||
      (recipe.blendedMass >= 760_000 && recipe.waterAdded !== 0)
    )
      return err({ code: "concentrate_mass_balance" });
    const digest = d.digest(
      await sha256Hex(canonicalJson(cell === null ? recipe : { recipe, cell })),
    );
    return ok(compile(recipe, cell, digest));
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_black_sesame_recipe" });
    throw error;
  }
}

function bottlePosition(
  id: string,
  bottles: number,
): CompiledScenario["storages"][number] {
  return {
    id: authoredId("storage", id),
    capacity: {
      kind: "material",
      product: authoredId("product", "concentrate"),
      quantity: mass(BOTTLE_MG * bottles),
    },
    cell: null,
  };
}

/**
 * A run in which no order draws the concentrate the same day, such as the
 * afternoon prep for the next morning, bottles each batch into its own pair of
 * bottles. Each refrigerator position then holds one bottle for each batch.
 */
export function bottleEveryBatch(
  scenario: CompiledScenario,
  batches: number,
): CompiledScenario {
  const positions = new Map<string, string>(
    BOTTLES.map((id) => [authoredId("storage", id), id]),
  );
  return {
    ...scenario,
    storages: scenario.storages.map((storage) => {
      const id = positions.get(storage.id);
      return id === undefined ? storage : bottlePosition(id, batches);
    }),
  };
}

export function blackSesameRecipeInput() {
  return {
    revision: 1,
    evidence: "assumed",
    roast: "skip",
    batchArrivalsSeconds: [0, 7_200],
    orderArrivalsSeconds: [
      1_800, 1_815, 1_830, 1_845, 1_860, 1_875, 1_890, 1_905, 1_920, 1_935,
      1_950, 1_965,
    ],
    grindLoadsMg: [55_000, 55_000, 55_000, 55_000],
    evaporationMg: 12_000,
    residueMg: 8_000,
    spillMg: 2_000,
    waterAddedMg: 20_000,
    excessDiscardedMg: 0,
    measurementDifferenceMg: 0,
    jugCount: 1,
    durationsSeconds: {
      weigh: 30,
      roast: 300,
      stir: 20,
      "roast-cool": 60,
      grind: 20,
      slurry: 300,
      dissolve: 30,
      blend: 105,
      scrape: 20,
      standardize: 20,
      cool: 1_200,
      release: 10,
      bottle: 50,
      clean: 90,
      dose: 10,
      cup: 10,
      heat: 55,
      pour: 5,
      "wash-jug": 30,
      return: 5,
    },
  };
}

export {
  blackSesameApplianceTask,
  blackSesameApplianceTasks,
  executeBlackSesameApplianceTasks,
} from "./black-sesame-milk.ts";
