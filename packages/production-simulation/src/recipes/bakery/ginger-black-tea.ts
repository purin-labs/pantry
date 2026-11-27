import { canonicalJson, sha256Hex } from "@purin-labs/std";
import * as d from "../../document-values.ts";
import { authoredId, type Sha256Hex } from "../../identity.ts";
import type { MaterialQuantity } from "../../quantity.ts";
import { parsePersistentCell } from "@purin-labs/bakery-model/bakery-physics";
import {
  mass,
  count,
  pool,
  input,
  lot,
  loss,
  acquire,
  release,
  move,
  taskKey,
  task,
} from "./tea-process.ts";
import { err, ok, type Result } from "../../result.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
  type MaterialOutput,
  type TaskDefinition,
} from "../../scenario.ts";
import { modelTimestep, timeFromSeconds, ZERO_DURATION } from "../../time.ts";

type StagingCell = CompiledScenario["cells"][number];

type Recipe = Readonly<{
  revision: number;
  tea: "assam" | "ctc";
  steepSeconds: number;
  simmerSeconds: number;
  arrivals: readonly number[];
  evaporation: number;
  retainedSolids: number;
  spill: number;
}>;

function arrival(raw: unknown): number {
  const value = d.natural(raw);
  d.requireValue(value < 21_600);
  return value;
}
function read(raw: unknown): Recipe {
  const r = d.record(raw, [
    "revision",
    "evidence",
    "tea",
    "steepSeconds",
    "simmerSeconds",
    "batchArrivalsSeconds",
    "evaporationMg",
    "retainedSolidsMg",
    "spillMg",
  ]);
  d.choice(r.evidence, "assumed");
  const tea = d.choice(r.tea, "assam", "ctc");
  const steepSeconds = d.positive(r.steepSeconds);
  d.requireValue(steepSeconds >= (tea === "assam" ? 180 : 120));
  d.requireValue(steepSeconds <= (tea === "assam" ? 240 : 180));
  const simmerSeconds = d.positive(r.simmerSeconds);
  d.requireValue(simmerSeconds >= 360 && simmerSeconds <= 480);
  const arrivals = d.array(r.batchArrivalsSeconds, arrival);
  d.requireValue(arrivals.length > 0 && arrivals.length <= 6);
  const evaporation = d.natural(r.evaporationMg);
  const retainedSolids = d.natural(r.retainedSolidsMg);
  const spill = d.natural(r.spillMg);
  // All ginger and tea leave with the wet solids. No extraction-yield claim.
  d.requireValue(retainedSolids >= 23_000 && evaporation < 450_000);
  d.requireValue(evaporation + retainedSolids + spill < 473_000);
  return {
    revision: d.positive(r.revision),
    tea,
    steepSeconds,
    simmerSeconds,
    arrivals,
    evaporation,
    retainedSolids,
    spill,
  };
}
function disposition(
  product: string,
  quantity: MaterialQuantity,
): MaterialOutput {
  return {
    kind: "inspection-exit",
    inspections: [authoredId("task-key", "inspect-strained-tea")],
    product: authoredId("product", product),
    quantity,
    destination: authoredId("destination", product),
    rejectedProduct: authoredId("product", `rejected-${product}`),
    rejectedDestination: authoredId("destination", `rejected-${product}`),
  };
}
function tasks(recipe: Recipe, cell: StagingCell | null): TaskDefinition[] {
  const simmered = 465_000 - recipe.evaporation;
  const infusion = simmered + 8_000;
  const served = infusion + 20_000 - recipe.retainedSolids - recipe.spill;
  const simmerOutputs = [lot("ginger-extract", "pan", simmered, "released")];
  if (recipe.evaporation > 0)
    simmerOutputs.push(loss("evaporation", recipe.evaporation));
  const strainOutputs = [
    lot("strained-tea", "receiver", served, "held"),
    loss("wet-solids", recipe.retainedSolids),
  ];
  if (recipe.spill > 0) strainOutputs.push(loss("spill", recipe.spill));
  const staging: TaskDefinition[] =
    cell === null
      ? []
      : [
          task(
            "stage-clean-equipment",
            [],
            20,
            "attended",
            [],
            [],
            [],
            [
              acquire("pan", "clean-pans"),
              move("pan", "clean-pans", "pan-staging-table", 20),
              acquire("receiver", "clean-receivers"),
              move("receiver", "clean-receivers", "staged-receivers", 20),
            ],
          ),
          {
            key: taskKey("stage-pan"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [taskKey("stage-clean-equipment")],
            claims: [
              {
                resource: authoredId("resource", "staging-arm"),
                units: 1,
                configuration: null,
              },
            ],
            executor: {
              kind: "native",
              operation: {
                cell: cell.id,
                skill: authoredId("skill", "rack-transfer"),
                parameters: cell.modelHash,
              },
            },
            inputs: [],
            outputs: [],
            releases: [],
            carriers: [
              {
                kind: "move",
                role: authoredId("carrier-role", "pan"),
                from: authoredId("storage", "pan-staging-table"),
                to: authoredId("storage", "pan-staging-rack"),
                timing: { kind: "native" },
              },
            ],
          },
          task(
            "handoff-staged-pan",
            ["stage-pan"],
            10,
            "attended",
            [],
            [],
            [],
            [move("pan", "pan-staging-rack", "prep-bench", 10)],
          ),
        ];
  return [
    ...staging,
    task(
      "prepare-ginger-and-water",
      cell === null ? [] : ["handoff-staged-pan"],
      60,
      "attended",
      ["scale"],
      [pool("water", 450_000), pool("ginger", 15_000)],
      [lot("ginger-water", "pan", 465_000, "released")],
      cell === null
        ? [
            acquire("pan", "clean-pans"),
            move("pan", "clean-pans", "prep-bench", 60),
            acquire("receiver", "clean-receivers"),
            move("receiver", "clean-receivers", "staged-receivers", 60),
          ]
        : [],
    ),
    task(
      "place-pan-on-hob",
      ["prepare-ginger-and-water"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan", "prep-bench", "hob", 10)],
    ),
    task(
      "heat-to-simmer",
      ["place-pan-on-hob"],
      120,
      "declared",
      ["hob-power"],
      [],
      [],
      [],
    ),
    task(
      "simmer-ginger",
      ["heat-to-simmer"],
      recipe.simmerSeconds,
      "declared",
      ["hob-power"],
      [input("ginger-water", 465_000)],
      simmerOutputs,
      [],
    ),
    task("turn-off-heat", ["simmer-ginger"], 5, "attended", [], [], [], []),
    task(
      "add-tea-and-cover",
      ["turn-off-heat"],
      10,
      "attended",
      ["scale"],
      [input("ginger-extract", simmered), pool("tea", 8_000)],
      [lot("infusion", "pan", infusion, "released")],
      [],
    ),
    // Extraction starts when tea is added. Moving the pan and waiting for a
    // free rest position run concurrently with this clock.
    task(
      "steep",
      ["add-tea-and-cover"],
      recipe.steepSeconds,
      "declared",
      [],
      [],
      [],
      [],
    ),
    task(
      "move-pan-off-hob",
      ["add-tea-and-cover"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan", "hob", "heatproof-rest", 10)],
    ),
    task(
      "strain-and-sweeten",
      ["steep", "move-pan-off-hob"],
      30,
      "attended",
      ["scale"],
      [input("infusion", infusion), pool("sugar", 20_000)],
      strainOutputs,
      [
        acquire("strainer", "clean-strainers"),
        move("strainer", "clean-strainers", "straining-position", 0),
        move("receiver", "staged-receivers", "receiving-position", 0),
      ],
    ),
    {
      key: taskKey("inspect-strained-tea"),
      priority: 0,
      releaseAfter: ZERO_DURATION,
      prerequisites: [taskKey("strain-and-sweeten")],
      claims: [],
      executor: { kind: "inspection" },
      inputs: [],
      outputs: [],
      carriers: [],
      releases: [authoredId("lot-key", "strained-tea")],
    },
    task(
      "serve-or-discard",
      ["inspect-strained-tea"],
      15,
      "attended",
      [],
      [input("strained-tea", served)],
      [
        disposition("tea-mass", mass(served)),
        disposition("servings", count(2)),
      ],
      [],
    ),
    task(
      "clear-used-equipment",
      ["serve-or-discard"],
      10,
      "attended",
      [],
      [],
      [],
      [
        move("pan", "heatproof-rest", "wash-pans", 10),
        move("receiver", "receiving-position", "wash-receivers", 10),
        move("strainer", "straining-position", "wash-strainers", 10),
      ],
    ),
    task(
      "wash-equipment",
      ["clear-used-equipment"],
      60,
      "attended",
      ["sink"],
      [],
      [],
      [],
    ),
    task(
      "return-clean-equipment",
      ["wash-equipment"],
      10,
      "attended",
      [],
      [],
      [],
      [
        move("pan", "wash-pans", "clean-pans", 10),
        move("receiver", "wash-receivers", "clean-receivers", 10),
        move("strainer", "wash-strainers", "clean-strainers", 10),
        release("pan"),
        release("receiver"),
        release("strainer"),
      ],
    ),
  ];
}
function explicitArrival(value: number) {
  return { time: d.value(timeFromSeconds(value)), quantity: 1 };
}
function compile(
  recipe: Recipe,
  cell: StagingCell | null,
  digest: Sha256Hex,
): CompiledScenario {
  const products: CompiledScenario["products"][number][] = [];
  for (const id of [
    "water",
    "ginger",
    "tea",
    "sugar",
    "ginger-water",
    "ginger-extract",
    "infusion",
    "strained-tea",
    "evaporation",
    "wet-solids",
    "spill",
    "tea-mass",
    "rejected-tea-mass",
  ])
    products.push({ id: authoredId("product", id), unit: "milligram" });
  for (const id of ["servings", "rejected-servings"])
    products.push({ id: authoredId("product", id), unit: "each" });
  const destinations: CompiledScenario["destinations"][number][] = [];
  for (const id of ["evaporation", "wet-solids", "spill"])
    destinations.push({
      id: authoredId("destination", id),
      product: authoredId("product", id),
      role: "loss",
    });
  for (const id of ["tea-mass", "servings"])
    destinations.push({
      id: authoredId("destination", id),
      product: authoredId("product", id),
      role: "final-output",
    });
  for (const id of ["rejected-tea-mass", "rejected-servings"])
    destinations.push({
      id: authoredId("destination", id),
      product: authoredId("product", id),
      role: "rejected-output",
    });
  const storages: CompiledScenario["storages"][number][] = [];
  const stock: CompiledScenario["stock"][number][] = [];
  for (const [id, amount] of [
    ["water", 450_000],
    ["ginger", 15_000],
    ["tea", 8_000],
    ["sugar", 20_000],
  ] as const) {
    const quantity = mass(amount * recipe.arrivals.length);
    const storage = authoredId("storage", `stock-${id}`);
    storages.push({
      id: storage,
      capacity: {
        kind: "material",
        product: authoredId("product", id),
        quantity,
      },
      cell: null,
    });
    stock.push({
      id: authoredId("lot", `stock-${id}`),
      product: authoredId("product", id),
      quantity,
      storage,
    });
  }
  for (const [id, slots] of [
    ["clean-pans", 2],
    ["prep-bench", 2],
    ["hob", 1],
    ["heatproof-rest", 1],
    ["wash-pans", 1],
    ["clean-receivers", 2],
    ["staged-receivers", 2],
    ["receiving-position", 1],
    ["wash-receivers", 1],
    ["clean-strainers", 1],
    ["straining-position", 1],
    ["wash-strainers", 1],
  ] as const)
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  if (cell !== null) {
    for (const id of ["pan-staging-table", "pan-staging-rack"])
      storages.push({
        id: authoredId("storage", id),
        capacity: { kind: "carriers", slots: 1 },
        cell: cell.id,
      });
  }
  const carriers: CompiledScenario["carriers"][number][] = [];
  for (const role of ["pan", "receiver"])
    for (let i = 1; i <= 2; i++)
      carriers.push({
        id: authoredId("carrier", `${role}-${i}`),
        storage: authoredId("storage", `clean-${role}s`),
      });
  carriers.push({
    id: authoredId("carrier", "strainer"),
    storage: authoredId("storage", "clean-strainers"),
  });
  const resources: CompiledScenario["resources"][number][] = [
    {
      id: authoredId("resource", "tea-worker"),
      kind: "worker",
      capacity: 1,
      configuration: null,
      initialLocation: authoredId("location", "tea-station"),
      travel: [],
    },
  ];
  for (const id of [
    "scale",
    "hob-power",
    "sink",
    ...(cell === null ? [] : ["staging-arm"]),
  ])
    resources.push({
      id: authoredId("resource", id),
      kind: "capacity",
      capacity: 1,
      configuration: null,
    });
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "ginger-black-tea"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "assumed-ginger-black-tea"),
        revision: recipe.revision,
        digest,
      },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(10_800)),
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
        id: authoredId("workflow", "ginger-tea-batch"),
        revision: digest,
        demand: "order",
        tasks: tasks(recipe, cell),
      },
    ],
    arrivals: [
      {
        id: authoredId("arrival-source", "tea-batches"),
        workflow: authoredId("workflow", "ginger-tea-batch"),
        kind: "explicit",
        arrivals: recipe.arrivals.map(explicitArrival),
      },
    ],
    dependencies: [],
    availability: [],
  };
}

/** Every batch stays held for an explicit disposition, including on-time batches. */
export async function compileGingerBlackTeaRecipe(
  raw: unknown,
  rawCell?: unknown,
): Promise<
  Result<
    CompiledScenario,
    Readonly<{ code: "invalid_ginger_black_tea_recipe" }>
  >
> {
  try {
    const recipe = read(raw);
    if (rawCell === undefined) {
      return ok(
        compile(recipe, null, d.digest(await sha256Hex(canonicalJson(recipe)))),
      );
    }
    const definition = parsePersistentCell(rawCell);
    d.requireValue(
      definition !== null && definition.fixture === "persistent-pan-staging/1",
    );
    const cell: StagingCell = {
      id: authoredId("cell", definition.cellId),
      modelHash: d.digest(definition.modelHash),
      controllerSourceHash: d.digest(definition.execution.controllerSourceHash),
      timestepMicroseconds: d.value(modelTimestep(definition.timestep)),
      carrierSlots: 1,
      holdModel: authoredId("hold-model", "cold-cell-rest.1"),
    };
    return ok(
      compile(
        recipe,
        cell,
        d.digest(await sha256Hex(canonicalJson({ recipe, cell: definition }))),
      ),
    );
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_ginger_black_tea_recipe" });
    throw error;
  }
}
export function gingerBlackTeaRecipeInput() {
  return {
    revision: 1,
    evidence: "assumed",
    tea: "assam",
    steepSeconds: 180,
    simmerSeconds: 420,
    batchArrivalsSeconds: [0, 60],
    evaporationMg: 20_000,
    retainedSolidsMg: 35_000,
    spillMg: 3_000,
  };
}
