import { canonicalJson, sha256Hex } from "@seams/std";
import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
  type MaterialInput,
  type MaterialOutput,
  type TaskDefinition,
} from "../../scenario.ts";
import { ZERO_DURATION, ZERO_TIME, timeFromSeconds } from "../../time.ts";
import { claim, count, mass, pool, seconds } from "./tea-process.ts";

export type LatteRecipe = Readonly<{ revision: number; milkG: number }>;

const COFFEE_MG = 18_000;
const WATER_MG = 36_000;
const BAR = authoredId("location", "bar");
const COBOT = authoredId("resource", "latte-cobot");

type Step = Readonly<{
  key: string;
  after: readonly string[];
  /** Seconds with the arm on this step, or with the machine alone. */
  duration: number;
  arm: boolean;
  claims: readonly string[];
  inputs?: readonly MaterialInput[];
  outputs?: readonly MaterialOutput[];
}>;

/**
 * One latte at one bar. The shot and the steamed milk are separate arms, and
 * both must finish before the pour. The one cobot arm still keeps its own work
 * in order. Durations are the assumed windows of the latte station.
 */
export async function compileLatte(
  input: LatteRecipe,
): Promise<CompiledScenario> {
  d.requireValue(
    Number.isSafeInteger(input.revision) &&
      input.revision > 0 &&
      Number.isSafeInteger(input.milkG) &&
      input.milkG > 0,
  );
  const milkMg = input.milkG * 1000;
  const digest = d.digest(
    await sha256Hex(
      canonicalJson({
        recipe: "latte",
        revision: input.revision,
        milkG: input.milkG,
      }),
    ),
  );
  const steps: readonly Step[] = [
    {
      key: "place-cup",
      after: [],
      duration: 2.4,
      arm: true,
      claims: ["latte-cup"],
    },
    {
      key: "espresso-shot",
      after: ["place-cup"],
      duration: 16,
      arm: false,
      claims: ["espresso-group"],
      inputs: [pool("coffee", COFFEE_MG), pool("water", WATER_MG)],
      outputs: [
        {
          kind: "exit",
          product: authoredId("product", "spent-coffee"),
          quantity: mass(COFFEE_MG),
          destination: authoredId("destination", "spent-coffee"),
        },
      ],
    },
    {
      key: "transfer-cup",
      after: ["espresso-shot"],
      duration: 2.2,
      arm: true,
      claims: ["latte-cup"],
    },
    {
      key: "grasp-pitcher",
      after: [],
      duration: 1,
      arm: true,
      claims: ["milk-pitcher"],
    },
    {
      key: "steam-stretch",
      after: ["grasp-pitcher"],
      duration: 10,
      arm: true,
      claims: ["milk-pitcher", "steam-wand"],
      inputs: [pool("milk", milkMg)],
    },
    {
      key: "steam-whirlpool",
      after: ["steam-stretch"],
      duration: 10,
      arm: true,
      claims: ["milk-pitcher", "steam-wand"],
    },
    {
      key: "pour-latte",
      after: ["transfer-cup", "steam-whirlpool"],
      duration: 12,
      arm: true,
      claims: ["latte-cup", "milk-pitcher"],
      outputs: [
        {
          kind: "exit",
          product: authoredId("product", "latte"),
          quantity: count(1),
          destination: authoredId("destination", "served-latte"),
        },
      ],
    },
    {
      key: "return-pitcher",
      after: ["pour-latte"],
      duration: 3,
      arm: true,
      claims: ["milk-pitcher"],
    },
  ];
  const workflow = authoredId("workflow", "latte-order");
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "latte-service"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "latte-assumptions"),
        revision: input.revision,
        digest,
      },
    ],
    limits: { horizon: d.value(timeFromSeconds(180)), eventCap: MAX_EVENT_CAP },
    products: [
      { id: authoredId("product", "coffee"), unit: "milligram" },
      { id: authoredId("product", "water"), unit: "milligram" },
      { id: authoredId("product", "milk"), unit: "milligram" },
      { id: authoredId("product", "spent-coffee"), unit: "milligram" },
      { id: authoredId("product", "latte"), unit: "each" },
    ],
    destinations: [
      {
        id: authoredId("destination", "served-latte"),
        product: authoredId("product", "latte"),
        role: "final-output",
      },
      {
        id: authoredId("destination", "spent-coffee"),
        product: authoredId("product", "spent-coffee"),
        role: "loss",
      },
    ],
    resources: [
      {
        id: COBOT,
        kind: "worker",
        capacity: 1,
        configuration: null,
        initialLocation: BAR,
        travel: [],
      },
      ...["latte-cup", "milk-pitcher", "espresso-group", "steam-wand"].map(
        equipment,
      ),
    ],
    storages: [
      pantry("coffee", COFFEE_MG),
      pantry("water", WATER_MG),
      pantry("milk", milkMg),
    ],
    carriers: [],
    cells: [],
    stock: [
      opening("coffee", COFFEE_MG),
      opening("water", WATER_MG),
      opening("milk", milkMg),
    ],
    workflows: [
      {
        id: workflow,
        revision: digest,
        demand: "order",
        tasks: steps.map(task),
      },
    ],
    arrivals: [
      {
        id: authoredId("arrival-source", "latte-orders"),
        workflow,
        kind: "explicit",
        arrivals: [{ time: ZERO_TIME, quantity: 1 }],
      },
    ],
    availability: [],
    dependencies: [],
  };
}

function task(step: Step): TaskDefinition {
  const duration = seconds(step.duration);
  return {
    key: authoredId("task-key", step.key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: step.after.map(taskKey),
    claims: step.claims.map(claim),
    executor: step.arm
      ? {
          kind: "attended",
          duration,
          evidence: "assumed",
          workers: [COBOT],
          start: BAR,
          finish: BAR,
        }
      : { kind: "declared", duration, evidence: "assumed" },
    inputs: step.inputs ?? [],
    outputs: step.outputs ?? [],
    releases: [],
    carriers: [],
  };
}

function taskKey(key: string) {
  return authoredId("task-key", key);
}

function equipment(name: string): CompiledScenario["resources"][number] {
  return {
    id: authoredId("resource", name),
    kind: "capacity",
    capacity: 1,
    configuration: null,
  };
}

function pantry(
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

function opening(
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
