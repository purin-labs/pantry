import { canonicalJson, sha256Hex } from "@purin-labs/std";
import * as d from "../../document-values.ts";
import { authoredId, type Sha256Hex } from "../../identity.ts";
import { err, ok, type Result } from "../../result.ts";
import { parsePersistentCell } from "@purin-labs/bakery-model/bakery-physics";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
  type MaterialOutput,
  type TaskDefinition,
} from "../../scenario.ts";
import { modelTimestep, timeFromSeconds, ZERO_DURATION } from "../../time.ts";
import {
  acquire,
  count,
  input,
  loss,
  lot,
  mass,
  move,
  pool,
  release,
  task,
  taskKey,
} from "./tea-process.ts";

type StagingCell = CompiledScenario["cells"][number];

type TemperaturePoint = Readonly<{ afterSeconds: number; celsius: number }>;
type Recipe = Readonly<{
  revision: number;
  simmerSeconds: number;
  arrivals: readonly number[];
  initialDirtyPan: boolean;
  evaporation: number;
  retainedSolids: number;
  spill: number;
  finishRangeC: Readonly<{ minimum: 75; maximum: 80 }>;
  finishingTrace: readonly TemperaturePoint[];
}>;

function arrival(raw: unknown): number {
  const value = d.natural(raw);
  d.requireValue(value < 21_600);
  return value;
}
function temperaturePoint(raw: unknown): TemperaturePoint {
  const r = d.record(raw, ["afterSeconds", "celsius"]);
  const afterSeconds = d.natural(r.afterSeconds);
  const celsius = d.positive(r.celsius);
  d.requireValue(afterSeconds <= 600 && celsius <= 80);
  return { afterSeconds, celsius };
}
function read(raw: unknown): Recipe {
  const r = d.record(raw, [
    "revision",
    "evidence",
    "simmerSeconds",
    "batchArrivalsSeconds",
    "initialDirtyPan",
    "evaporationMg",
    "retainedSolidsMg",
    "spillMg",
    "finishRangeC",
    "finishingTrace",
  ]);
  d.choice(r.evidence, "assumed");
  const simmerSeconds = d.positive(r.simmerSeconds);
  d.requireValue(simmerSeconds >= 360 && simmerSeconds <= 480);
  const arrivals = d.array(r.batchArrivalsSeconds, arrival);
  d.requireValue(arrivals.length > 0 && arrivals.length <= 6);
  const evaporation = d.natural(r.evaporationMg);
  const retainedSolids = d.natural(r.retainedSolidsMg);
  const spill = d.natural(r.spillMg);
  d.requireValue(
    retainedSolids >= 24_000 && evaporation + retainedSolids + spill < 424_000,
  );
  const range = d.record(r.finishRangeC, ["minimum", "maximum"]);
  const finishRangeC = {
    minimum: d.choice(range.minimum, 75),
    maximum: d.choice(range.maximum, 80),
  };
  const finishingTrace = d.array(r.finishingTrace, temperaturePoint);
  d.requireValue(finishingTrace.length >= 2 && finishingTrace.length <= 6);
  const first = finishingTrace[0];
  const last = finishingTrace[finishingTrace.length - 1];
  d.requireValue(
    first !== undefined &&
      first.afterSeconds === 0 &&
      first.celsius < finishRangeC.minimum,
  );
  d.requireValue(
    last !== undefined &&
      last.celsius >= finishRangeC.minimum &&
      last.celsius <= finishRangeC.maximum,
  );
  let previous = first;
  for (const point of finishingTrace.slice(1)) {
    d.requireValue(
      point.afterSeconds > previous.afterSeconds &&
        point.celsius > previous.celsius,
    );
    previous = point;
  }
  return {
    revision: d.positive(r.revision),
    simmerSeconds,
    arrivals,
    initialDirtyPan: d.boolean(r.initialDirtyPan),
    evaporation,
    retainedSolids,
    spill,
    finishRangeC,
    finishingTrace,
  };
}

function afterInspection(
  outcome: "accept" | "reject",
  step: TaskDefinition,
): TaskDefinition {
  const work = step.executor;
  if (step.carriers.length > 0 || step.releases.length > 0)
    throw new Error(
      "Conditional milk tea work cannot move or release carriers",
    );
  if (work.kind !== "declared" && work.kind !== "attended")
    throw new Error("Milk tea conditions require process work");
  return {
    key: step.key,
    priority: step.priority,
    releaseAfter: step.releaseAfter,
    prerequisites: step.prerequisites,
    claims: step.claims,
    executor: {
      kind: "after-inspection",
      inspection: taskKey("inspect-strained-tea"),
      outcome,
      work,
    },
    inputs: step.inputs,
    outputs: step.outputs,
    carriers: [],
    releases: [],
  };
}
function servings(product: string): MaterialOutput {
  return {
    kind: "exit",
    product: authoredId("product", product),
    quantity: count(2),
    destination: authoredId("destination", product),
  };
}
function tasks(recipe: Recipe, cell: StagingCell): TaskDefinition[] {
  const simmered = 415_000 - recipe.evaporation;
  const infusion = simmered + 9_000;
  const strained = infusion - recipe.retainedSolids - recipe.spill;
  // Water and milk use an explicit assumed density of 1 g/ml.
  const finished = strained + 180_000 + 25_000;
  const simmerOutputs = [lot("ginger-extract", "pan-a", simmered, "released")];
  if (recipe.evaporation > 0)
    simmerOutputs.push(loss("evaporation", recipe.evaporation));
  const strainOutputs = [
    lot("strained-tea", "pan-b", strained, "held"),
    loss("wet-solids", recipe.retainedSolids),
  ];
  if (recipe.spill > 0) strainOutputs.push(loss("spill", recipe.spill));
  const steps: TaskDefinition[] = [
    task(
      "stage-both-pans",
      [],
      20,
      "attended",
      [],
      [],
      [],
      [
        acquire("pan-a", "clean-pans"),
        move("pan-a", "clean-pans", "prep-bench", 20),
        acquire("pan-b", "clean-pans"),
        move("pan-b", "clean-pans", "pan-staging-table", 20),
        acquire("strainer", "clean-strainers"),
        move("strainer", "clean-strainers", "straining-position", 20),
      ],
    ),
    {
      key: taskKey("stage-pan-b"),
      priority: 0,
      releaseAfter: ZERO_DURATION,
      prerequisites: [taskKey("stage-both-pans")],
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
          role: authoredId("carrier-role", "pan-b"),
          from: authoredId("storage", "pan-staging-table"),
          to: authoredId("storage", "pan-staging-rack"),
          timing: { kind: "native" },
        },
      ],
    },
    task(
      "handoff-staged-pan-b",
      ["stage-pan-b"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan-b", "pan-staging-rack", "receiving-position", 10)],
    ),
    task(
      "prepare-ginger-and-water",
      ["handoff-staged-pan-b"],
      60,
      "attended",
      ["scale"],
      [pool("water", 400_000), pool("ginger", 15_000)],
      [lot("ginger-water", "pan-a", 415_000, "released")],
      [],
    ),
    task(
      "place-pan-a-on-hob",
      ["prepare-ginger-and-water"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan-a", "prep-bench", "hob", 10)],
    ),
    task(
      "heat-to-simmer",
      ["place-pan-a-on-hob"],
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
      [input("ginger-water", 415_000)],
      simmerOutputs,
      [],
    ),
    task(
      "add-tea",
      ["simmer-ginger"],
      10,
      "attended",
      ["scale"],
      [input("ginger-extract", simmered), pool("tea", 9_000)],
      [lot("infusion", "pan-a", infusion, "released")],
      [],
    ),
    task("simmer-tea", ["add-tea"], 180, "declared", ["hob-power"], [], [], []),
    task(
      "strain-into-pan-b",
      ["simmer-tea"],
      30,
      "attended",
      [],
      [input("infusion", infusion)],
      strainOutputs,
      [],
    ),
    task(
      "clear-dirty-pan-a",
      ["strain-into-pan-b"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan-a", "hob", "wash-pans", 10)],
    ),
    task(
      "wash-pan-a",
      ["clear-dirty-pan-a"],
      60,
      "attended",
      ["sink"],
      [],
      [],
      [],
    ),
    task(
      "place-clean-pan-a-on-hob",
      ["wash-pan-a"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan-a", "wash-pans", "hob", 10)],
    ),
    afterInspection(
      "accept",
      task(
        "fill-cup-preheat-water",
        ["inspect-strained-tea", "place-clean-pan-a-on-hob"],
        15,
        "attended",
        [],
        [pool("water", 300_000)],
        [lot("cup-water", "pan-a", 300_000, "released")],
        [],
      ),
    ),
    afterInspection(
      "accept",
      task(
        "heat-cup-preheat-water",
        ["fill-cup-preheat-water"],
        120,
        "declared",
        ["hob-power"],
        [],
        [],
        [],
      ),
    ),
    afterInspection(
      "accept",
      task(
        "warm-cups-and-drain-water",
        ["heat-cup-preheat-water"],
        60,
        "attended",
        [],
        [input("cup-water", 300_000)],
        [loss("cup-preheat-water", 300_000)],
        [],
      ),
    ),
    task(
      "return-clean-pan-a",
      ["warm-cups-and-drain-water"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan-a", "hob", "clean-pans", 10), release("pan-a")],
    ),
    task(
      "place-pan-b-on-hob",
      ["return-clean-pan-a"],
      10,
      "attended",
      [],
      [],
      [],
      [move("pan-b", "receiving-position", "hob", 10)],
    ),
    {
      key: taskKey("inspect-strained-tea"),
      priority: 0,
      releaseAfter: ZERO_DURATION,
      prerequisites: [taskKey("strain-into-pan-b")],
      claims: [],
      executor: { kind: "inspection" },
      inputs: [],
      outputs: [],
      carriers: [],
      releases: [authoredId("lot-key", "strained-tea")],
    },
    afterInspection(
      "reject",
      task(
        "discard-extract",
        ["inspect-strained-tea", "place-pan-b-on-hob"],
        15,
        "attended",
        [],
        [input("strained-tea", strained)],
        [loss("rejected-extract", strained), servings("rejected-servings")],
        [],
      ),
    ),
  ];
  const first = recipe.finishingTrace[0];
  if (first === undefined) throw new Error("Milk tea needs a finishing trace");
  let previousKey = `add-milk-and-sugar-at-${first.celsius}c`;
  steps.push(
    afterInspection(
      "accept",
      task(
        previousKey,
        ["inspect-strained-tea", "place-pan-b-on-hob"],
        20,
        "attended",
        ["scale"],
        [
          input("strained-tea", strained),
          pool("milk", 180_000),
          pool("sugar", 25_000),
        ],
        [lot("milk-tea", "pan-b", finished, "released")],
        [],
      ),
    ),
  );
  let previousSeconds = 0;
  // Task names retain the declared temperatures; durations retain trace spacing.
  // The engine executes attended work. These labels are not sensor readings.
  for (const point of recipe.finishingTrace.slice(1)) {
    const key = `heat-and-stir-to-${point.celsius}c`;
    steps.push(
      afterInspection(
        "accept",
        task(
          key,
          [previousKey],
          point.afterSeconds - previousSeconds,
          "attended",
          ["hob-power"],
          [],
          [],
          [],
        ),
      ),
    );
    previousKey = key;
    previousSeconds = point.afterSeconds;
  }
  steps.push(
    afterInspection(
      "accept",
      task(
        "serve-milk-tea",
        [previousKey],
        20,
        "attended",
        [],
        [input("milk-tea", finished)],
        [loss("milk-tea-mass", finished), servings("servings")],
        [],
      ),
    ),
    task(
      "clear-pan-b-and-strainer",
      ["serve-milk-tea", "discard-extract", "return-clean-pan-a"],
      10,
      "attended",
      [],
      [],
      [],
      [
        move("pan-b", "hob", "wash-pans", 10),
        move("strainer", "straining-position", "wash-strainers", 10),
      ],
    ),
    task(
      "wash-pan-b-and-strainer",
      ["clear-pan-b-and-strainer"],
      60,
      "attended",
      ["sink"],
      [],
      [],
      [],
    ),
    task(
      "return-clean-pan-b-and-strainer",
      ["wash-pan-b-and-strainer"],
      10,
      "attended",
      [],
      [],
      [],
      [
        move("pan-b", "wash-pans", "clean-pans", 10),
        release("pan-b"),
        move("strainer", "wash-strainers", "clean-strainers", 10),
        release("strainer"),
      ],
    ),
  );
  return steps;
}
function cleanInitialPan(): TaskDefinition[] {
  return [
    task(
      "wash-initial-pan",
      [],
      60,
      "attended",
      ["sink"],
      [],
      [],
      [acquire("dirty-pan", "wash-pans")],
    ),
    task(
      "return-initial-pan",
      ["wash-initial-pan"],
      10,
      "attended",
      [],
      [],
      [],
      [move("dirty-pan", "wash-pans", "clean-pans", 10), release("dirty-pan")],
    ),
  ];
}
function explicitArrival(value: number) {
  return { time: d.value(timeFromSeconds(value)), quantity: 1 };
}
function compile(
  recipe: Recipe,
  cell: StagingCell,
  digest: Sha256Hex,
): CompiledScenario {
  const products: CompiledScenario["products"][number][] = [];
  for (const id of [
    "water",
    "ginger",
    "tea",
    "milk",
    "sugar",
    "cup-water",
    "ginger-water",
    "ginger-extract",
    "infusion",
    "strained-tea",
    "milk-tea",
    "cup-preheat-water",
    "evaporation",
    "wet-solids",
    "spill",
    "milk-tea-mass",
    "rejected-extract",
  ])
    products.push({ id: authoredId("product", id), unit: "milligram" });
  for (const id of ["servings", "rejected-servings"])
    products.push({ id: authoredId("product", id), unit: "each" });
  const destinations: CompiledScenario["destinations"][number][] = [];
  for (const [role, ids] of [
    ["loss", ["cup-preheat-water", "evaporation", "wet-solids", "spill"]],
    ["final-output", ["milk-tea-mass", "servings"]],
    ["rejected-output", ["rejected-extract", "rejected-servings"]],
  ] as const)
    for (const id of ids)
      destinations.push({
        id: authoredId("destination", id),
        product: authoredId("product", id),
        role,
      });
  const storages: CompiledScenario["storages"][number][] = [];
  const stock: CompiledScenario["stock"][number][] = [];
  for (const [id, amount] of [
    ["water", 700_000],
    ["ginger", 15_000],
    ["tea", 9_000],
    ["milk", 180_000],
    ["sugar", 25_000],
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
    ["prep-bench", 1],
    ["receiving-position", 1],
    ["hob", 1],
    ["wash-pans", 1],
    ["clean-strainers", 1],
    ["straining-position", 1],
    ["wash-strainers", 1],
  ] as const)
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots },
      cell: null,
    });
  const carriers: CompiledScenario["carriers"] = [
    {
      id: authoredId("carrier", "pan-1"),
      storage: authoredId("storage", "clean-pans"),
    },
    {
      id: authoredId("carrier", "pan-2"),
      storage: authoredId(
        "storage",
        recipe.initialDirtyPan ? "wash-pans" : "clean-pans",
      ),
    },
    {
      id: authoredId("carrier", "strainer"),
      storage: authoredId("storage", "clean-strainers"),
    },
  ];
  for (const id of ["pan-staging-table", "pan-staging-rack"])
    storages.push({
      id: authoredId("storage", id),
      capacity: { kind: "carriers", slots: 1 },
      cell: cell.id,
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
  for (const id of ["scale", "hob-power", "sink", "staging-arm"])
    resources.push({
      id: authoredId("resource", id),
      kind: "capacity",
      capacity: 1,
      configuration: null,
    });
  const workflows: CompiledScenario["workflows"][number][] = [
    {
      id: authoredId("workflow", "ginger-milk-tea-batch"),
      revision: digest,
      demand: "order",
      tasks: tasks(recipe, cell),
    },
  ];
  const arrivals: CompiledScenario["arrivals"][number][] = [
    {
      id: authoredId("arrival-source", "milk-tea-batches"),
      workflow: authoredId("workflow", "ginger-milk-tea-batch"),
      kind: "explicit",
      arrivals: recipe.arrivals.map(explicitArrival),
    },
  ];
  if (recipe.initialDirtyPan) {
    workflows.push({
      id: authoredId("workflow", "clean-initial-pan"),
      revision: digest,
      demand: "production",
      tasks: cleanInitialPan(),
    });
    arrivals.push({
      id: authoredId("arrival-source", "initial-cleaning"),
      workflow: authoredId("workflow", "clean-initial-pan"),
      kind: "explicit",
      arrivals: [explicitArrival(0)],
    });
  }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "ginger-milk-tea"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "assumed-ginger-milk-tea"),
        revision: recipe.revision,
        digest,
      },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(14_400)),
      eventCap: MAX_EVENT_CAP,
    },
    products,
    destinations,
    storages,
    carriers,
    stock,
    resources,
    cells: [cell],
    workflows,
    arrivals,
    dependencies: [],
    availability: [],
  };
}

export async function compileGingerMilkTeaRecipe(
  raw: unknown,
  rawCell: unknown,
): Promise<
  Result<CompiledScenario, Readonly<{ code: "invalid_ginger_milk_tea_recipe" }>>
> {
  try {
    const recipe = read(raw);
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
      return err({ code: "invalid_ginger_milk_tea_recipe" });
    throw error;
  }
}
export function gingerMilkTeaRecipeInput() {
  return {
    revision: 1,
    evidence: "assumed",
    simmerSeconds: 420,
    batchArrivalsSeconds: [0, 60],
    initialDirtyPan: true,
    evaporationMg: 20_000,
    retainedSolidsMg: 36_000,
    spillMg: 3_000,
    finishRangeC: { minimum: 75, maximum: 80 },
    finishingTrace: [
      { afterSeconds: 0, celsius: 55 },
      { afterSeconds: 60, celsius: 68 },
      { afterSeconds: 120, celsius: 78 },
    ],
  };
}

export {
  executeGingerMilkTeaApplianceTasks,
  executeTeaApplianceTasks,
  gingerMilkTeaApplianceTasks,
  teaApplianceTask,
  teaApplianceTasks,
} from "./tea.ts";
