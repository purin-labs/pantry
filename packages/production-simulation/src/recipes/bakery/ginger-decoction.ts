import { canonicalJson, sha256Hex } from "@purin-labs/std";
import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
  type MaterialOutput,
  type TaskDefinition,
} from "../../scenario.ts";
import { timeFromSeconds, ZERO_DURATION } from "../../time.ts";
import { gingerBlackTeaRecipeInput } from "./ginger-black-tea.ts";
import { gingerMilkTeaRecipeInput } from "./ginger-milk-tea.ts";
import {
  acquire,
  claim,
  input,
  loss,
  mass,
  move,
  pool,
  release,
  seconds,
  taskKey,
} from "./tea-process.ts";

/**
 * Day-before ginger decoction for the two ginger teas. Grating and simmering
 * ginger takes 9 minutes of each tea order (heat 120 s, simmer 420 s). The
 * previous afternoon simmers one decoction for each morning batch, chills it
 * and holds it in the refrigerator. The morning pours it into the pan,
 * reheats it to a simmer and brews the tea to order.
 */
export type GingerDecoction = Readonly<{
  /** The tea workflow whose ginger simmer this replaces. */
  teaWorkflow: "ginger-tea-batch" | "ginger-milk-tea-batch";
  /** The pan role that the tea workflow uses for the ginger water. */
  pan: "pan" | "pan-a";
  product: string;
  waterMg: number;
  gingerMg: number;
  evaporationMg: number;
  simmerSeconds: number;
}>;

export function gingerDecoctions(): readonly GingerDecoction[] {
  const black = gingerBlackTeaRecipeInput();
  const milk = gingerMilkTeaRecipeInput();
  return [
    {
      teaWorkflow: "ginger-tea-batch",
      pan: "pan",
      product: "black-tea-ginger-decoction",
      waterMg: 450_000,
      gingerMg: 15_000,
      evaporationMg: black.evaporationMg,
      simmerSeconds: black.simmerSeconds,
    },
    {
      teaWorkflow: "ginger-milk-tea-batch",
      pan: "pan-a",
      product: "milk-tea-ginger-decoction",
      waterMg: 400_000,
      gingerMg: 15_000,
      evaporationMg: milk.evaporationMg,
      simmerSeconds: milk.simmerSeconds,
    },
  ];
}

export function decoctionMass(decoction: GingerDecoction): number {
  return decoction.waterMg + decoction.gingerMg - decoction.evaporationMg;
}

function attended(
  key: string,
  previous: readonly string[],
  duration: number,
  start: string,
  finish: string,
  resources: readonly string[],
  rest: Pick<TaskDefinition, "inputs" | "outputs" | "carriers" | "releases">,
): TaskDefinition {
  return {
    key: taskKey(key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous.map(taskKey),
    claims: resources.map(claim),
    executor: {
      kind: "attended",
      duration: seconds(duration),
      evidence: "assumed",
      workers: [authoredId("resource", "baker")],
      start: authoredId("location", start),
      finish: authoredId("location", finish),
    },
    ...rest,
  };
}
function declared(
  key: string,
  previous: readonly string[],
  duration: number,
  resources: readonly string[],
  rest: Pick<TaskDefinition, "inputs" | "outputs" | "carriers" | "releases">,
): TaskDefinition {
  return {
    key: taskKey(key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous.map(taskKey),
    claims: resources.map(claim),
    executor: {
      kind: "declared",
      duration: seconds(duration),
      evidence: "assumed",
    },
    ...rest,
  };
}
const NONE = { inputs: [], outputs: [], carriers: [], releases: [] };

/** One decoction: weighed into a saucepan, simmered, chilled and stored. */
function decoctionTasks(decoction: GingerDecoction): TaskDefinition[] {
  const decocted = decoctionMass(decoction);
  const water = `weighed-${decoction.product}-water`;
  const ginger = `weighed-${decoction.product}-ginger`;
  const pot = (key: string): MaterialOutput => ({
    kind: "lot",
    lot: authoredId("lot-key", key),
    product: authoredId("product", "ginger-water"),
    quantity: mass(key === water ? decoction.waterMg : decoction.gingerMg),
    holder: {
      kind: "carrier",
      carrier: authoredId("carrier-role", "saucepan"),
    },
    disposition: "released",
    report: null,
  });
  return [
    attended(
      "weigh-water-and-ginger",
      [],
      60,
      "tea-station",
      "tea-station",
      ["scale"],
      {
        inputs: [
          pool("water", decoction.waterMg),
          pool("ginger", decoction.gingerMg),
        ],
        outputs: [pot(water), pot(ginger)],
        carriers: [
          acquire("saucepan", "clean-saucepans"),
          move("saucepan", "clean-saucepans", "saucepan-bench", 10),
        ],
        releases: [],
      },
    ),
    attended(
      "place-saucepan-on-hob",
      ["weigh-water-and-ginger"],
      10,
      "tea-station",
      "hob",
      [],
      {
        ...NONE,
        carriers: [move("saucepan", "saucepan-bench", "saucepan-hob", 10)],
      },
    ),
    declared("heat-to-simmer", ["place-saucepan-on-hob"], 120, ["hob"], NONE),
    declared(
      "simmer-ginger",
      ["heat-to-simmer"],
      decoction.simmerSeconds,
      ["hob"],
      {
        inputs: [
          input(water, decoction.waterMg),
          input(ginger, decoction.gingerMg),
        ],
        outputs: [
          {
            kind: "lot",
            lot: authoredId("lot-key", "simmered-decoction"),
            product: authoredId("product", "simmered-ginger-water"),
            quantity: mass(decocted),
            holder: {
              kind: "carrier",
              carrier: authoredId("carrier-role", "saucepan"),
            },
            disposition: "released",
            report: null,
          },
          loss("evaporation", decoction.evaporationMg),
        ],
        carriers: [],
        releases: [],
      },
    ),
    attended(
      "decant-to-fridge",
      ["simmer-ginger"],
      30,
      "hob",
      "tea-station",
      [],
      {
        inputs: [input("simmered-decoction", decocted)],
        outputs: [
          {
            kind: "lot",
            lot: authoredId("lot-key", "decoction"),
            product: authoredId("product", decoction.product),
            quantity: mass(decocted),
            holder: {
              kind: "storage",
              storage: authoredId("storage", `${decoction.product}-fridge`),
            },
            disposition: "held",
            report: null,
          },
        ],
        carriers: [move("saucepan", "saucepan-hob", "saucepan-wash", 10)],
        releases: [],
      },
    ),
    // Released for the morning when it is cold.
    declared("chill-decoction", ["decant-to-fridge"], 1_800, [], {
      ...NONE,
      releases: [authoredId("lot-key", "decoction")],
    }),
    attended(
      "wash-saucepan",
      ["decant-to-fridge"],
      45,
      "tea-station",
      "sink",
      ["sink"],
      NONE,
    ),
    attended(
      "put-away-saucepan",
      ["wash-saucepan"],
      10,
      "sink",
      "tea-station",
      [],
      {
        ...NONE,
        carriers: [
          move("saucepan", "saucepan-wash", "clean-saucepans", 10),
          release("saucepan"),
        ],
      },
    ),
  ];
}

/** The afternoon's decoctions: one for each morning batch of each tea. */
export async function decoctionPrep(
  batchesPerTea: number,
): Promise<CompiledScenario> {
  const decoctions = gingerDecoctions();
  const revision = d.digest(
    await sha256Hex(canonicalJson({ decoctions, batchesPerTea })),
  );
  let water = 0;
  let ginger = 0;
  for (const decoction of decoctions) {
    water += decoction.waterMg * batchesPerTea;
    ginger += decoction.gingerMg * batchesPerTea;
  }
  const workflows: CompiledScenario["workflows"][number][] = [];
  const arrivals: CompiledScenario["arrivals"][number][] = [];
  for (const [index, decoction] of decoctions.entries()) {
    const workflow = authoredId("workflow", decoction.product);
    workflows.push({
      id: workflow,
      revision,
      demand: "production",
      tasks: decoctionTasks(decoction),
    });
    arrivals.push({
      id: authoredId("arrival-source", `${decoction.product}-batches`),
      kind: "explicit",
      workflow,
      arrivals: Array.from({ length: batchesPerTea }, (_, batch) => ({
        time: d.value(timeFromSeconds(600 + index * 300 + batch * 900)),
        quantity: 1,
      })),
    });
  }
  const material = (id: string, product: string, amount: number) => ({
    id: authoredId("storage", id),
    capacity: {
      kind: "material" as const,
      product: authoredId("product", product),
      quantity: mass(amount),
    },
    cell: null,
  });
  const slots = (id: string, count: number) => ({
    id: authoredId("storage", id),
    capacity: { kind: "carriers" as const, slots: count },
    cell: null,
  });
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "ginger-decoction-prep"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "assumed-ginger-decoction"),
        revision: 1,
        digest: revision,
      },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(28_800)),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      { id: authoredId("product", "water"), unit: "milligram" },
      { id: authoredId("product", "ginger"), unit: "milligram" },
      { id: authoredId("product", "ginger-water"), unit: "milligram" },
      { id: authoredId("product", "simmered-ginger-water"), unit: "milligram" },
      { id: authoredId("product", "evaporation"), unit: "milligram" },
      ...decoctions.map((decoction) => ({
        id: authoredId("product", decoction.product),
        unit: "milligram" as const,
      })),
    ],
    destinations: [
      {
        id: authoredId("destination", "evaporation"),
        product: authoredId("product", "evaporation"),
        role: "loss",
      },
    ],
    resources: [
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
    storages: [
      material("water-stock", "water", water),
      material("ginger-stock", "ginger", ginger),
      ...decoctions.map((decoction) =>
        material(
          `${decoction.product}-fridge`,
          decoction.product,
          decoctionMass(decoction) * batchesPerTea,
        ),
      ),
      slots("clean-saucepans", 1),
      slots("saucepan-bench", 1),
      slots("saucepan-hob", 1),
      slots("saucepan-wash", 1),
    ],
    stock: [
      {
        id: authoredId("lot", "water-stock"),
        product: authoredId("product", "water"),
        quantity: mass(water),
        storage: authoredId("storage", "water-stock"),
      },
      {
        id: authoredId("lot", "ginger-stock"),
        product: authoredId("product", "ginger"),
        quantity: mass(ginger),
        storage: authoredId("storage", "ginger-stock"),
      },
    ],
    carriers: [
      {
        id: authoredId("carrier", "saucepan-1"),
        storage: authoredId("storage", "clean-saucepans"),
      },
    ],
    cells: [],
    workflows,
    arrivals,
    dependencies: [],
    availability: [],
  };
}

/**
 * Warms the milk tea cups with hot water from the espresso machine's tap
 * while the tea simmers, as a bar does, instead of washing pan A after the
 * strain and boiling cup water in it. Pan A is washed and put away after
 * service. The 300 g of cup water still drains to the same loss.
 */
export function milkTeaCupsFromBoiler(
  workflow: CompiledScenario["workflows"][number],
): CompiledScenario["workflows"][number] {
  const drop = new Set([
    "place-clean-pan-a-on-hob",
    "fill-cup-preheat-water",
    "heat-cup-preheat-water",
  ]);
  const warm = workflow.tasks.find(
    (t) => t.key === "warm-cups-and-drain-water",
  );
  d.requireValue(
    warm !== undefined &&
      warm.executor.kind === "after-inspection" &&
      warm.executor.work.kind === "attended",
  );
  const work = warm.executor.work;
  const tasks: TaskDefinition[] = [];
  for (const step of workflow.tasks) {
    if (drop.has(step.key)) continue;
    if (step.key === "warm-cups-and-drain-water") {
      tasks.push({
        ...step,
        prerequisites: [taskKey("place-pan-a-on-hob")],
        claims: [claim("espresso-machine")],
        executor: {
          ...work,
          start: authoredId("location", "coffee-station"),
          finish: authoredId("location", "coffee-station"),
        },
        inputs: [pool("water", 300_000)],
        outputs: [loss("cup-preheat-water", 300_000)],
      });
      continue;
    }
    if (step.key === "return-clean-pan-a") {
      tasks.push({
        ...step,
        prerequisites: [taskKey("wash-pan-a")],
        carriers: [
          move("pan-a", "wash-pans", "clean-pans", 10),
          release("pan-a"),
        ],
      });
      continue;
    }
    if (step.key === "place-pan-b-on-hob") {
      tasks.push({
        ...step,
        prerequisites: [
          taskKey("strain-into-pan-b"),
          taskKey("clear-dirty-pan-a"),
          taskKey("warm-cups-and-drain-water"),
        ],
      });
      continue;
    }
    tasks.push(step);
  }
  return { ...workflow, tasks };
}

/**
 * Starts a ginger tea from the day-before decoction: the pan is filled with
 * the chilled decoction in place of ginger and water, reheated to a simmer,
 * and the tea goes in at once. The ginger simmer leaves the morning.
 */
export function teaFromDecoction(
  workflow: CompiledScenario["workflows"][number],
  decoction: GingerDecoction,
): CompiledScenario["workflows"][number] {
  const simmer = workflow.tasks.find((t) => t.key === "simmer-ginger");
  const extract = simmer?.outputs.find(
    (output) => output.kind === "lot" && output.lot === "ginger-extract",
  );
  d.requireValue(simmer !== undefined && extract !== undefined);
  const decocted = decoctionMass(decoction);
  d.requireValue(extract.quantity?.amount === decocted);
  const tasks: TaskDefinition[] = [];
  for (const step of workflow.tasks) {
    if (step.key === "simmer-ginger") continue;
    if (step.key === "prepare-ginger-and-water") {
      tasks.push({
        ...step,
        key: taskKey("pour-ginger-decoction"),
        inputs: [pool(decoction.product, decocted)],
        outputs: [extract],
      });
      continue;
    }
    tasks.push({
      ...step,
      prerequisites: step.prerequisites.map((key) =>
        key === "simmer-ginger"
          ? taskKey("heat-to-simmer")
          : key === "prepare-ginger-and-water"
            ? taskKey("pour-ginger-decoction")
            : key,
      ),
    });
  }
  return { ...workflow, tasks };
}
