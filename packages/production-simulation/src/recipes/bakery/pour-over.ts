import { canonicalJson, sha256Hex } from "@purin-labs/std";
import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import type {
  GrinderModel,
  NativeCell,
  PourOverStation,
} from "../../native/cell-adapter.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
  type MaterialOutput,
} from "../../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  modelTimestep,
  timeFromSeconds,
} from "../../time.ts";
import {
  batchSpec,
  dishwasherActions,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
  grindActions,
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
import { claim, count, input as lotInput, mass, pool } from "./tea-process.ts";

/**
 * The Blue Bottle combination: the Japanese guide's 27 g blend dose with the
 * US guide's four timed spiral pours to 350 g. A human prepares the filter,
 * the ground bed, the server and a hot kettle; one FR10 pours.
 */
export type PourOverRecipe = Readonly<{
  revision: number;
  kettleWaterG: number;
  drainage: PourOverStation["drainage"];
  fault: PourOverStation["fault"];
  grinder?: PourOverStation["grinder"];
}>;

export const POUR_OVER_SOURCES = [
  "https://store.bluebottlecoffee.jp/pages/dripbrew",
  "https://bluebottlecoffee.com/us/eng/brew-guides/pour-over",
] as const;

/** Start offset in seconds, cumulative water in grams and laps each way. */
export const POUR_OVER_SCHEDULE = [
  { startS: 0, cumulativeG: 50, laps: 3 },
  { startS: 40, cumulativeG: 150, laps: 5 },
  { startS: 70, cumulativeG: 250, laps: 5 },
  { startS: 100, cumulativeG: 350, laps: 5 },
] as const;

const COFFEE_MG = 27_000;
/** Covers preparation, the 330 s drainage timeout and the kettle's return. */
const HORIZON_S = 420;

export function parsePourOverRecipe(raw: unknown): PourOverRecipe {
  const input = d.record(raw, [
    "revision",
    "kettleWaterG",
    "drainage",
    "fault",
    ...(typeof raw === "object" &&
    raw !== null &&
    "grinder" in raw &&
    (raw as Record<string, unknown>).grinder !== undefined
      ? ["grinder"]
      : []),
  ]);
  const revision = d.positive(input.revision);
  const kettleWaterG = d.positive(input.kettleWaterG);
  const { drainage, fault, grinder } = input;
  if (
    kettleWaterG < 420 ||
    kettleWaterG > 700 ||
    (drainage !== "nominal" && drainage !== "reduced") ||
    (fault !== "none" && fault !== "lost-grip") ||
    (grinder !== undefined &&
      grinder !== "option-o-lagom-casa" &&
      grinder !== "timemore-bricks-01s" &&
      grinder !== "fellow-opus-2" &&
      grinder !== "miicoffee-df64-gen2")
  )
    throw new Error(
      "Prepare 420–700 g of kettle water with nominal or reduced drainage.",
    );
  return {
    revision,
    kettleWaterG,
    drainage,
    fault,
    ...(grinder === undefined ? {} : { grinder }),
  };
}

/** One brew on a prepared station; every output is measured by the controller. */
export async function compilePourOver(
  input: PourOverRecipe,
  cell: NativeCell,
): Promise<CompiledScenario> {
  const { revision, kettleWaterG, drainage, fault, grinder } = input;
  d.requireValue(
    cell.fixture === "persistent-pour-over/1" &&
      cell.station.kettleWaterG === kettleWaterG &&
      cell.station.drainage === drainage &&
      cell.station.fault === fault &&
      (grinder === undefined || cell.station.grinder === grinder),
  );
  const waterMg = kettleWaterG * 1000;
  const digest = d.digest(
    await sha256Hex(
      canonicalJson({
        revision,
        kettleWaterG,
        drainage,
        fault,
        ...(grinder === undefined ? {} : { grinder }),
        model: cell.modelHash,
        coffeeGrams: 27,
        kettleCelsius: 93,
        schedule: POUR_OVER_SCHEDULE,
        sources: POUR_OVER_SOURCES,
      }),
    ),
  );
  const workflow = authoredId("workflow", "pour-over-brew");
  const total = waterMg + COFFEE_MG;
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "pour-over-service"),
    policy: DISPATCH_POLICY,
    sources: [
      { id: authoredId("source", "blue-bottle-pour-over"), revision, digest },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(HORIZON_S)),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      "ground-coffee",
      "hot-water",
      "brewed-coffee",
      "spent-coffee-bed",
      "spilled-water",
      "evaporated-water",
    ].map(product),
    destinations: [
      destination("brewed-coffee", "brewed-coffee", "intermediate-stock"),
      destination("spilled-water", "spilled-water", "loss"),
      destination("evaporated-water", "evaporated-water", "loss"),
    ],
    resources: ["pour-over-arm", "pour-over-station", "gooseneck-kettle"].map(
      resource,
    ),
    storages: [
      storage("kettle", "hot-water", 1_500_000),
      storage("coffee-bed", "ground-coffee", 100_000),
      storage("receiving-vessel", "brewed-coffee", 800_000),
      storage("dripper", "spent-coffee-bed", 800_000),
    ],
    stock: [
      stock("hot-water", waterMg, "kettle"),
      stock("ground-coffee", COFFEE_MG, "coffee-bed"),
    ],
    carriers: [],
    cells: [
      {
        id: cell.cellId,
        modelHash: cell.modelHash,
        controllerSourceHash: cell.controllerSourceHash,
        timestepMicroseconds: d.value(modelTimestep(0.002)),
        carrierSlots: 0,
        holdModel: null,
      },
    ],
    workflows: [
      {
        id: workflow,
        revision: digest,
        demand: "order",
        tasks: [
          {
            key: authoredId("task-key", "brew-pour-over"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [
              "pour-over-arm",
              "pour-over-station",
              "gooseneck-kettle",
            ].map(claim),
            executor: {
              kind: "native",
              operation: {
                cell: cell.cellId,
                skill: authoredId("skill", "pour-over-brew"),
                parameters: cell.modelHash,
              },
            },
            inputs: [
              pool("hot-water", waterMg),
              pool("ground-coffee", COFFEE_MG),
            ],
            outputs: [
              measuredLot(
                "beverage",
                "brewed-coffee",
                "receiving-vessel",
                waterMg,
                "brewed-coffee",
              ),
              measuredLot(
                "spent-bed",
                "spent-coffee-bed",
                "dripper",
                total,
                null,
              ),
              measuredLot("kettle-water", "hot-water", "kettle", waterMg, null),
              measuredExit("spill", "spilled-water", waterMg),
              measuredExit("evaporation", "evaporated-water", waterMg),
            ],
            releases: [],
            carriers: [],
          },
        ],
      },
    ],
    arrivals: [
      {
        id: authoredId("arrival-source", "pour-over-order"),
        workflow,
        kind: "explicit",
        arrivals: [{ time: ZERO_TIME, quantity: 1 }],
      },
    ],
    availability: [],
    dependencies: [],
  };
}

/** The beverage stays in the server, ready for a later service action. */
function measuredLot(
  measurement: string,
  name: string,
  holder: string,
  boundMg: number,
  report: string | null,
): MaterialOutput {
  return {
    kind: "measured-lot",
    lot: authoredId("lot-key", measurement),
    product: authoredId("product", name),
    measurement: authoredId("measurement", measurement),
    bound: mass(boundMg),
    holder: { kind: "storage", storage: authoredId("storage", holder) },
    disposition: "released",
    report: report === null ? null : authoredId("destination", report),
  };
}
function measuredExit(
  measurement: string,
  name: string,
  boundMg: number,
): MaterialOutput {
  return {
    kind: "measured-exit",
    product: authoredId("product", name),
    measurement: authoredId("measurement", measurement),
    bound: mass(boundMg),
    destination: authoredId("destination", name),
  };
}
function product(name: string): CompiledScenario["products"][number] {
  return { id: authoredId("product", name), unit: "milligram" };
}
function destination(
  id: string,
  name: string,
  role: CompiledScenario["destinations"][number]["role"],
): CompiledScenario["destinations"][number] {
  return {
    id: authoredId("destination", id),
    product: authoredId("product", name),
    role,
  };
}
function resource(name: string): CompiledScenario["resources"][number] {
  return {
    kind: "capacity",
    id: authoredId("resource", name),
    capacity: 1,
    configuration: null,
  };
}
function storage(
  id: string,
  name: string,
  amount: number,
): CompiledScenario["storages"][number] {
  return {
    id: authoredId("storage", id),
    capacity: {
      kind: "material",
      product: authoredId("product", name),
      quantity: mass(amount),
    },
    cell: null,
  };
}
function stock(
  name: string,
  amount: number,
  at: string,
): CompiledScenario["stock"][number] {
  return {
    id: authoredId("lot", name),
    product: authoredId("product", name),
    quantity: mass(amount),
    storage: authoredId("storage", at),
  };
}

export type PourOverShiftInput = Readonly<{
  revision: number;
  orders: number;
  grinder: GrinderModel;
  arrivalsSeconds: readonly number[];
}>;

/**
 * Shared-clock pour-over workflow for Plan 61E morning shift composition.
 * Contends for shared workers, scale, coffee grinder, hob power, kettle,
 * pour-over station, FR10 pour-over arm, and wash sink.
 */
export async function compilePourOverShiftWorkflow(
  input: PourOverShiftInput,
): Promise<CompiledScenario> {
  const { revision, orders, grinder, arrivalsSeconds } = input;
  d.requireValue(orders >= 1 && orders <= 2);
  d.requireValue(arrivalsSeconds.length === orders);
  const digest = d.digest(
    await sha256Hex(
      canonicalJson({
        revision,
        orders,
        grinder,
        arrivalsSeconds,
        coffeeGrams: 27,
        waterGrams: 350,
        kettleCelsius: 93,
        schedule: POUR_OVER_SCHEDULE,
        sources: POUR_OVER_SOURCES,
        baseline: "morning-shift",
      }),
    ),
  );
  const workflow = authoredId("workflow", "pour-over-brew");
  const coffeeMg = orders * COFFEE_MG;
  const waterMg = orders * 350_000;
  const location = authoredId("location", "coffee-station");
  const worker = authoredId("resource", "tea-worker");

  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "pour-over-service"),
    policy: DISPATCH_POLICY,
    sources: [
      { id: authoredId("source", "blue-bottle-pour-over"), revision, digest },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(28_800)),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      ...[
        "coffee",
        "pour-over-bean-dose",
        "ground-coffee",
        "water",
        "hot-water",
        "brewed-coffee",
        "spent-coffee-bed",
        "spilled-water",
        "evaporated-water",
      ].map(product),
      { id: authoredId("product", "pour-over-servings"), unit: "each" },
    ],
    destinations: [
      destination("served-pour-over", "brewed-coffee", "final-output"),
      {
        id: authoredId("destination", "pour-over-servings"),
        product: authoredId("product", "pour-over-servings"),
        role: "final-output",
      },
      destination("spent-coffee-bed", "spent-coffee-bed", "loss"),
      destination("spilled-water", "spilled-water", "loss"),
      destination("evaporated-water", "evaporated-water", "loss"),
    ],
    resources: [
      "scale",
      "coffee-grinder",
      "hob-power",
      "gooseneck-kettle",
      "pour-over-station",
      "pour-over-arm",
      "sink",
    ].map(resource),
    storages: [
      storage("stock-coffee", "coffee", coffeeMg),
      storage("stock-water", "water", waterMg),
      storage("pour-over-dosing-cup", "pour-over-bean-dose", coffeeMg),
      storage("coffee-bed", "ground-coffee", coffeeMg),
      storage("kettle", "hot-water", waterMg),
      storage("receiving-vessel", "brewed-coffee", orders * 310_000),
    ],
    stock: [
      {
        id: authoredId("lot", "stock-coffee"),
        product: authoredId("product", "coffee"),
        quantity: mass(coffeeMg),
        storage: authoredId("storage", "stock-coffee"),
      },
      {
        id: authoredId("lot", "stock-water"),
        product: authoredId("product", "water"),
        quantity: mass(waterMg),
        storage: authoredId("storage", "stock-water"),
      },
    ],
    carriers: [],
    cells: [],
    workflows: [
      {
        id: workflow,
        revision: digest,
        demand: "order",
        tasks: [
          {
            key: authoredId("task-key", "weigh-pour-over-beans"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [claim("scale")],
            executor: {
              kind: "attended",
              duration: d.value(durationFromSeconds(12)),
              evidence: "assumed",
              workers: [worker],
              start: location,
              finish: location,
            },
            inputs: [pool("coffee", COFFEE_MG)],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "pour-over-bean-dose"),
                product: authoredId("product", "pour-over-bean-dose"),
                quantity: mass(COFFEE_MG),
                holder: {
                  kind: "storage",
                  storage: authoredId("storage", "pour-over-dosing-cup"),
                },
                disposition: "released",
                report: null,
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "grind-pour-over-dose"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [authoredId("task-key", "weigh-pour-over-beans")],
            claims: [claim("coffee-grinder")],
            executor: {
              kind: "attended",
              duration: d.value(durationFromSeconds(15)),
              evidence: "assumed",
              workers: [worker],
              start: location,
              finish: location,
            },
            inputs: [lotInput("pour-over-bean-dose", COFFEE_MG)],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "ground-coffee"),
                product: authoredId("product", "ground-coffee"),
                quantity: mass(COFFEE_MG),
                holder: {
                  kind: "storage",
                  storage: authoredId("storage", "coffee-bed"),
                },
                disposition: "released",
                report: null,
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "heat-pour-over-water"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [authoredId("task-key", "weigh-pour-over-beans")],
            claims: [claim("hob-power"), claim("gooseneck-kettle")],
            executor: {
              kind: "declared",
              duration: d.value(durationFromSeconds(60)),
              evidence: "assumed",
            },
            inputs: [pool("water", 350_000)],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "hot-water"),
                product: authoredId("product", "hot-water"),
                quantity: mass(350_000),
                holder: {
                  kind: "storage",
                  storage: authoredId("storage", "kettle"),
                },
                disposition: "released",
                report: null,
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "brew-pour-over"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [
              authoredId("task-key", "grind-pour-over-dose"),
              authoredId("task-key", "heat-pour-over-water"),
            ],
            claims: [
              claim("pour-over-arm"),
              claim("pour-over-station"),
              claim("gooseneck-kettle"),
            ],
            executor: {
              kind: "declared",
              duration: d.value(durationFromSeconds(180)),
              evidence: "assumed",
            },
            inputs: [
              lotInput("ground-coffee", COFFEE_MG),
              lotInput("hot-water", 350_000),
            ],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "brewed-coffee"),
                product: authoredId("product", "brewed-coffee"),
                quantity: mass(310_000),
                holder: {
                  kind: "storage",
                  storage: authoredId("storage", "receiving-vessel"),
                },
                disposition: "released",
                report: null,
              },
              {
                kind: "exit",
                product: authoredId("product", "spent-coffee-bed"),
                quantity: mass(45_000),
                destination: authoredId("destination", "spent-coffee-bed"),
              },
              {
                kind: "exit",
                product: authoredId("product", "evaporated-water"),
                quantity: mass(12_000),
                destination: authoredId("destination", "evaporated-water"),
              },
              {
                kind: "exit",
                product: authoredId("product", "spilled-water"),
                quantity: mass(10_000),
                destination: authoredId("destination", "spilled-water"),
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "serve-pour-over-and-rinse"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [authoredId("task-key", "brew-pour-over")],
            claims: [claim("pour-over-station"), claim("sink")],
            executor: {
              kind: "attended",
              duration: d.value(durationFromSeconds(15)),
              evidence: "assumed",
              workers: [worker],
              start: location,
              finish: location,
            },
            inputs: [lotInput("brewed-coffee", 310_000)],
            outputs: [
              {
                kind: "exit",
                product: authoredId("product", "brewed-coffee"),
                quantity: mass(310_000),
                destination: authoredId("destination", "served-pour-over"),
              },
              {
                kind: "exit",
                product: authoredId("product", "pour-over-servings"),
                quantity: count(1),
                destination: authoredId("destination", "pour-over-servings"),
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
        id: authoredId("arrival-source", "pour-over-order"),
        workflow,
        kind: "explicit",
        arrivals: arrivalsSeconds.map((sec) => ({
          time: d.value(timeFromSeconds(sec)),
          quantity: 1,
        })),
      },
    ],
    availability: [],
    dependencies: [],
  };
}

export function pourOverApplianceTask(
  task: ScheduledTaskDescriptor,
): RecipeApplianceTaskBinding | null {
  if (task.workflowId !== "pour-over-brew") return null;
  const key = task.taskKey;

  if (key === "weigh-pour-over-beans") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.027),
      20,
      1500,
      0.5,
      0.05,
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
      label: "Weigh 27 g Blue Bottle pour-over dose",
      batch,
      buildActions: () => weighActions(batch),
    };
  }

  if (key === "grind-pour-over-dose") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.027),
      22,
      1500,
      0.5,
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
      label: "Grind 27 g pour-over coffee dose",
      batch,
      buildActions: () => grindActions(batch, 3),
    };
  }

  if (key === "heat-pour-over-water") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.35),
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
      label: "Heat 350 g gooseneck kettle water on induction hob",
      batch,
      buildActions: () => hobTemperatureActions(batch, 90, 5),
    };
  }

  if (key === "serve-pour-over-and-rinse") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      0.3,
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
      label: "Rinse pour-over server and dripper",
      batch,
      buildActions: () => dishwasherActions(batch, 6),
    };
  }

  return null;
}

export function pourOverApplianceTasks(
  source: ScheduledTaskSource,
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    const bound = pourOverApplianceTask(task);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export async function executePourOverApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(
    pourOverApplianceTasks(source),
    runtime,
    { runId: options.runId ?? "pour-over-appliance-wasm", ...options },
  );
}
