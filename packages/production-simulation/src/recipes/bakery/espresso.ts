import { canonicalJson, sha256Hex } from "@purin-labs/std";
import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import type { GrinderModel, NativeCell } from "../../native/cell-adapter.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
} from "../../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  timeFromSeconds,
  modelTimestep,
} from "../../time.ts";
import {
  batchSpec,
  espressoActions,
  grindActions,
  taskMaterialMassKg,
  weighActions,
  type RecipeApplianceTaskBinding,
  type ScheduledTaskDescriptor,
} from "./appliance-execution.ts";
import { count, input as lotInput, mass, pool, claim } from "./tea-process.ts";

export type EspressoRecipe = Readonly<{
  revision: number;
  orders: number;
  appliance: "linea" | "eagle-one";
  grinder?: GrinderModel;
}>;
export function parseEspressoRecipe(raw: unknown): EspressoRecipe {
  const input = d.record(raw, [
    "revision",
    "orders",
    "appliance",
    ...(typeof raw === "object" &&
    raw !== null &&
    "grinder" in raw &&
    (raw as Record<string, unknown>).grinder !== undefined
      ? ["grinder"]
      : []),
  ]);
  const revision = d.positive(input.revision);
  const orders = d.positive(input.orders);
  const appliance = input.appliance;
  if ((appliance !== "linea" && appliance !== "eagle-one") || orders > 4)
    throw new Error("Select an espresso machine and 1–4 orders.");
  const grinder = input.grinder;
  if (
    grinder !== undefined &&
    grinder !== "option-o-lagom-casa" &&
    grinder !== "timemore-bricks-01s" &&
    grinder !== "fellow-opus-2" &&
    grinder !== "miicoffee-df64-gen2"
  )
    throw new Error("Select a supported Plan 60A grinder.");
  return {
    revision,
    orders,
    appliance,
    ...(grinder === undefined ? {} : { grinder }),
  };
}

/** A preheated station and a fixed operator. Yield is an uncalibrated water proxy. */
export async function compileEspresso(
  input: EspressoRecipe,
  cell: NativeCell,
): Promise<CompiledScenario> {
  const { revision, orders, appliance, grinder } = input;
  d.requireValue(
    cell.fixture === "persistent-espresso/1" &&
      cell.appliance === appliance &&
      (grinder === undefined || cell.grinder === grinder),
  );
  const digest = d.digest(
    await sha256Hex(
      canonicalJson({
        revision,
        orders,
        appliance,
        ...(grinder === undefined ? {} : { grinder }),
        model: cell.modelHash,
        coffeeGrams: 18,
        waterGrams: 36,
        brewSeconds: 18,
        baseline: "preheated",
      }),
    ),
  );
  const workflow = authoredId("workflow", "espresso-orders");
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "espresso-service"),
    policy: DISPATCH_POLICY,
    sources: [
      { id: authoredId("source", "espresso-assumptions"), revision, digest },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(orders * 28)),
      eventCap: MAX_EVENT_CAP,
    },
    products: ["coffee", "water", "espresso", "spent-coffee"].map(product),
    destinations: [
      {
        id: authoredId("destination", "served-espresso"),
        product: authoredId("product", "espresso"),
        role: "final-output",
      },
      {
        id: authoredId("destination", "spent-coffee"),
        product: authoredId("product", "spent-coffee"),
        role: "loss",
      },
    ],
    resources: ["espresso-machine", "espresso-cup", "espresso-operator"].map(
      resource,
    ),
    storages: [
      storage("coffee", orders * 18000),
      storage("water", orders * 36000),
    ],
    stock: [stock("coffee", orders * 18000), stock("water", orders * 36000)],
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
            key: authoredId("task-key", "prepare-espresso"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [
              "espresso-machine",
              "espresso-cup",
              "espresso-operator",
            ].map(claim),
            executor: {
              kind: "native",
              operation: {
                cell: cell.cellId,
                skill: authoredId("skill", "espresso-cycle"),
                parameters: cell.modelHash,
              },
            },
            inputs: [pool("coffee", 18000), pool("water", 36000)],
            outputs: [
              {
                kind: "exit",
                product: authoredId("product", "espresso"),
                quantity: mass(36000),
                destination: authoredId("destination", "served-espresso"),
              },
              {
                kind: "exit",
                product: authoredId("product", "spent-coffee"),
                quantity: mass(18000),
                destination: authoredId("destination", "spent-coffee"),
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
        id: authoredId("arrival-source", "espresso-orders"),
        workflow,
        kind: "explicit",
        arrivals: [{ time: ZERO_TIME, quantity: orders }],
      },
    ],
    availability: [],
    dependencies: [],
  };
}
function product(name: string): CompiledScenario["products"][number] {
  return { id: authoredId("product", name), unit: "milligram" };
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
  name: string,
  amount: number,
): CompiledScenario["storages"][number] {
  return {
    id: authoredId("storage", name),
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
): CompiledScenario["stock"][number] {
  return {
    id: authoredId("lot", name),
    product: authoredId("product", name),
    quantity: mass(amount),
    storage: authoredId("storage", name),
  };
}

type EspressoShiftInput = Readonly<{
  revision: number;
  orders: number;
  appliance: "linea" | "eagle-one";
  grinder: GrinderModel;
  arrivalsSeconds: readonly number[];
}>;

/**
 * Shared-clock espresso workflow for Plan 61E morning shift composition.
 * Contends for shared workers, scale, coffee grinder, and espresso machine.
 */
export async function compileEspressoShiftWorkflow(
  input: EspressoShiftInput,
): Promise<CompiledScenario> {
  const { revision, orders, appliance, grinder, arrivalsSeconds } = input;
  d.requireValue(orders >= 1 && orders <= 4);
  d.requireValue(arrivalsSeconds.length === orders);
  const digest = d.digest(
    await sha256Hex(
      canonicalJson({
        revision,
        orders,
        appliance,
        grinder,
        arrivalsSeconds,
        coffeeGrams: 18,
        waterGrams: 36,
        brewSeconds: 18,
        baseline: "morning-shift",
      }),
    ),
  );
  const workflow = authoredId("workflow", "espresso-orders");
  const coffeeMg = orders * 18_000;
  const waterMg = orders * 36_000;
  const location = authoredId("location", "coffee-station");
  const worker = authoredId("resource", "tea-worker");

  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "espresso-service"),
    policy: DISPATCH_POLICY,
    sources: [
      { id: authoredId("source", "espresso-assumptions"), revision, digest },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(28_800)),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      ...[
        "coffee",
        "espresso-bean-dose",
        "espresso-ground-dose",
        "water",
        "espresso",
        "spent-coffee",
      ].map(product),
      { id: authoredId("product", "espresso-servings"), unit: "each" },
    ],
    destinations: [
      {
        id: authoredId("destination", "served-espresso"),
        product: authoredId("product", "espresso"),
        role: "final-output",
      },
      {
        id: authoredId("destination", "espresso-servings"),
        product: authoredId("product", "espresso-servings"),
        role: "final-output",
      },
      {
        id: authoredId("destination", "spent-coffee"),
        product: authoredId("product", "spent-coffee"),
        role: "loss",
      },
    ],
    resources: [
      "scale",
      "coffee-grinder",
      "espresso-machine",
      "espresso-cup",
    ].map(resource),
    storages: [
      {
        id: authoredId("storage", "stock-coffee"),
        capacity: {
          kind: "material",
          product: authoredId("product", "coffee"),
          quantity: mass(coffeeMg),
        },
        cell: null,
      },
      {
        id: authoredId("storage", "stock-water"),
        capacity: {
          kind: "material",
          product: authoredId("product", "water"),
          quantity: mass(waterMg),
        },
        cell: null,
      },
      {
        id: authoredId("storage", "espresso-dosing-cup"),
        capacity: {
          kind: "material",
          product: authoredId("product", "espresso-bean-dose"),
          quantity: mass(coffeeMg),
        },
        cell: null,
      },
      {
        id: authoredId("storage", "espresso-portafilter"),
        capacity: {
          kind: "material",
          product: authoredId("product", "espresso-ground-dose"),
          quantity: mass(coffeeMg),
        },
        cell: null,
      },
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
            key: authoredId("task-key", "weigh-espresso-beans"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [],
            claims: [claim("scale")],
            executor: {
              kind: "attended",
              duration: d.value(durationFromSeconds(10)),
              evidence: "assumed",
              workers: [worker],
              start: location,
              finish: location,
            },
            inputs: [pool("coffee", 18_000)],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "espresso-bean-dose"),
                product: authoredId("product", "espresso-bean-dose"),
                quantity: mass(18_000),
                holder: {
                  kind: "storage",
                  storage: authoredId("storage", "espresso-dosing-cup"),
                },
                disposition: "released",
                report: null,
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "grind-espresso-dose"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [authoredId("task-key", "weigh-espresso-beans")],
            claims: [claim("coffee-grinder")],
            executor: {
              kind: "attended",
              duration: d.value(durationFromSeconds(12)),
              evidence: "assumed",
              workers: [worker],
              start: location,
              finish: location,
            },
            inputs: [lotInput("espresso-bean-dose", 18_000)],
            outputs: [
              {
                kind: "lot",
                lot: authoredId("lot-key", "espresso-ground-dose"),
                product: authoredId("product", "espresso-ground-dose"),
                quantity: mass(18_000),
                holder: {
                  kind: "storage",
                  storage: authoredId("storage", "espresso-portafilter"),
                },
                disposition: "released",
                report: null,
              },
            ],
            releases: [],
            carriers: [],
          },
          {
            key: authoredId("task-key", "extract-espresso"),
            priority: 0,
            releaseAfter: ZERO_DURATION,
            prerequisites: [authoredId("task-key", "grind-espresso-dose")],
            claims: [claim("espresso-machine"), claim("espresso-cup")],
            executor: {
              kind: "attended",
              duration: d.value(durationFromSeconds(25)),
              evidence: "assumed",
              workers: [worker],
              start: location,
              finish: location,
            },
            inputs: [
              lotInput("espresso-ground-dose", 18_000),
              pool("water", 36_000),
            ],
            outputs: [
              {
                kind: "exit",
                product: authoredId("product", "espresso"),
                quantity: mass(36_000),
                destination: authoredId("destination", "served-espresso"),
              },
              {
                kind: "exit",
                product: authoredId("product", "espresso-servings"),
                quantity: count(1),
                destination: authoredId("destination", "espresso-servings"),
              },
              {
                kind: "exit",
                product: authoredId("product", "spent-coffee"),
                quantity: mass(18_000),
                destination: authoredId("destination", "spent-coffee"),
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
        id: authoredId("arrival-source", "espresso-orders"),
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

export function espressoApplianceTask(
  task: ScheduledTaskDescriptor,
  appliance: "linea" | "eagle-one" = "linea",
): RecipeApplianceTaskBinding | null {
  if (task.workflowId !== "espresso-orders") return null;
  const key = task.taskKey;

  if (key === "weigh-espresso-beans") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.018),
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
      label: "Weigh 18 g espresso bean dose",
      batch,
      buildActions: () => weighActions(batch),
    };
  }

  if (key === "grind-espresso-dose") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      taskMaterialMassKg(task.definition, 0.018),
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
      label: "Grind 18 g espresso dose",
      batch,
      buildActions: () => grindActions(batch, 3),
    };
  }

  if (key === "extract-espresso" || key === "prepare-espresso") {
    const batch = batchSpec(
      `${task.instanceId}-${key}`,
      0.018,
      24,
      1500,
      0.5,
      0,
    );
    const machine =
      appliance === "eagle-one"
        ? "victoria-arduino-eagle-one-2g"
        : "la-marzocco-linea-classic-s-2g";
    return {
      taskId: task.taskId,
      instanceId: task.instanceId,
      workflowId: task.workflowId,
      taskKey: key,
      startedAtUs: task.startedAtUs,
      completedAtUs: task.completedAtUs,
      category: "espresso",
      appliance: machine,
      label: "Pull 36 g double espresso shot",
      batch,
      buildActions: () => espressoActions(batch, 6),
    };
  }

  return null;
}
