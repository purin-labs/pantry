import { canonicalJson, sha256Hex } from "@purin-labs/std";
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
import { claim, mass, pool, seconds } from "./tea-process.ts";

export type SiphonRecipe = Readonly<{
  revision: number;
  waterG: number;
  coffeeG: number;
  steepSeconds: number;
}>;

/** Grounds hold about two grams of water for each gram of coffee: an assumption. */
const RETAINED_WATER_PER_COFFEE = 2;
const STATION = authoredId("location", "siphon-station");
const COBOT = authoredId("resource", "siphon-cobot");

type Step = Readonly<{
  key: string;
  after: readonly string[];
  duration: number;
  arm: boolean;
  inputs?: readonly MaterialInput[];
  outputs?: readonly MaterialOutput[];
}>;

/**
 * One siphon brew. Vapor pressure moves the water, so each stage needs the one
 * before it. Durations are the assumed windows of the siphon station.
 */
export async function compileSiphon(
  input: SiphonRecipe,
): Promise<CompiledScenario> {
  const { revision, waterG, coffeeG, steepSeconds } = input;
  const brewedG = waterG - coffeeG * RETAINED_WATER_PER_COFFEE;
  d.requireValue(
    Number.isSafeInteger(revision) &&
      revision > 0 &&
      waterG > 0 &&
      coffeeG > 0 &&
      steepSeconds > 0 &&
      brewedG > 0,
  );
  const digest = d.digest(
    await sha256Hex(
      canonicalJson({
        recipe: "siphon",
        revision,
        waterG,
        coffeeG,
        steepSeconds,
      }),
    ),
  );
  const steps: readonly Step[] = [
    {
      key: "preheat-seal",
      after: [],
      duration: 10,
      arm: true,
      inputs: [pool("water", waterG * 1000)],
    },
    { key: "upflow", after: ["preheat-seal"], duration: 18, arm: false },
    {
      key: "fold-in",
      after: ["upflow"],
      duration: 20,
      arm: true,
      inputs: [pool("coffee", coffeeG * 1000)],
    },
    { key: "steep", after: ["fold-in"], duration: steepSeconds, arm: false },
    { key: "whirlpool", after: ["steep"], duration: 16, arm: true },
    {
      key: "drawdown",
      after: ["whirlpool"],
      duration: 51,
      arm: false,
      outputs: [
        {
          kind: "exit",
          product: authoredId("product", "siphon-coffee"),
          quantity: mass(brewedG * 1000),
          destination: authoredId("destination", "served-coffee"),
        },
      ],
    },
  ];
  const workflow = authoredId("workflow", "siphon-brew");
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "siphon-service"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "siphon-assumptions"),
        revision,
        digest,
      },
    ],
    limits: {
      horizon: d.value(timeFromSeconds(120 + steepSeconds * 2 + 115)),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      { id: authoredId("product", "water"), unit: "milligram" },
      { id: authoredId("product", "coffee"), unit: "milligram" },
      { id: authoredId("product", "siphon-coffee"), unit: "milligram" },
    ],
    destinations: [
      {
        id: authoredId("destination", "served-coffee"),
        product: authoredId("product", "siphon-coffee"),
        role: "final-output",
      },
    ],
    resources: [
      {
        id: COBOT,
        kind: "worker",
        capacity: 1,
        configuration: null,
        initialLocation: STATION,
        travel: [],
      },
      {
        id: authoredId("resource", "siphon-vessel"),
        kind: "capacity",
        capacity: 1,
        configuration: null,
      },
    ],
    storages: [
      pantry("water", waterG * 1000),
      pantry("coffee", coffeeG * 1000),
    ],
    carriers: [],
    cells: [],
    stock: [opening("water", waterG * 1000), opening("coffee", coffeeG * 1000)],
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
        id: authoredId("arrival-source", "siphon-orders"),
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
    claims: [claim("siphon-vessel")],
    executor: step.arm
      ? {
          kind: "attended",
          duration,
          evidence: "assumed",
          workers: [COBOT],
          start: STATION,
          finish: STATION,
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
