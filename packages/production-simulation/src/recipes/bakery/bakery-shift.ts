import { bakeryShiftDemand } from "./shift-demand.ts";
import { assertNever, isRecord } from "@purin-labs/std";
import { parsePersistentCell } from "@purin-labs/bakery-model/bakery-physics";
import * as d from "../../document-values.ts";
import { authoredId, type ResourceId, type StorageId } from "../../identity.ts";
import { addQuantity, normalizeQuantity } from "../../quantity.ts";
import { err, ok, type Result } from "../../result.ts";
import { readTravelRoute } from "../../scenario-document.ts";
import type {
  AvailabilityInterval,
  CarrierStep,
  Changeover,
  CompiledScenario,
  TaskDefinition,
  TravelRoute,
} from "../../scenario.ts";
import {
  durationFromSeconds,
  interval,
  tickDuration,
  timeFromSeconds,
} from "../../time.ts";
import {
  routePairKey,
  validTravelRouteReplacement,
} from "../../worker-travel.ts";
import {
  blackSesameRecipeInput,
  bottleEveryBatch,
  compileBlackSesameRecipe,
} from "./black-sesame.ts";
import {
  compileEspressoShiftWorkflow,
  espressoApplianceTask,
} from "./espresso.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "./financier-production.ts";
import {
  compileGingerBlackTeaRecipe,
  gingerBlackTeaRecipeInput,
} from "./ginger-black-tea.ts";
import {
  compileGingerMilkTeaRecipe,
  gingerMilkTeaRecipeInput,
} from "./ginger-milk-tea.ts";
import {
  compilePourOverShiftWorkflow,
  pourOverApplianceTask,
} from "./pour-over.ts";
import { sharedRecipeRecords } from "./shared-records.ts";
import { FINANCIER_FLAVOURS } from "./financier-flavours.ts";
import { compilePieRecipe, pieRecipeInput } from "./pie.ts";
import { PIE_TYPES } from "./pie-products.ts";
import {
  miseEnPlaceLots,
  withinHold,
  type CarryoverMiseEnPlaceLot,
  type MiseEnPlaceLot,
} from "./mise-en-place.ts";
import {
  decoctionMass,
  decoctionPrep,
  gingerDecoctions,
  milkTeaCupsFromBoiler,
  teaFromDecoction,
} from "./ginger-decoction.ts";

import {
  MORNING_SHIFT_SECONDS,
  shiftHorizonSeconds,
  type BakeryServiceShiftInput,
} from "./shift-preset.ts";
export {
  SIX_HOUR_SHIFT_SECONDS,
  morningShiftRecipeInput,
  sixHourShiftRecipeInput,
  type BakeryShiftOptions,
  type BakeryServiceShiftInput,
} from "./shift-preset.ts";
export { extractCarryoverMiseEnPlace } from "./mise-en-place.ts";

function shiftInterval(startSec: number, endSec: number) {
  return d.value(
    interval(
      d.value(timeFromSeconds(startSec)),
      d.value(timeFromSeconds(endSec)),
    ),
  );
}

function shiftAvailability(
  input: BakeryServiceShiftInput,
): readonly AvailabilityInterval[] {
  if (input.kind !== "six-hour-shift") return [];
  const policy = input.shiftBreakPolicy;
  if (policy === "continuous-no-break") return [];
  if (policy === "fixed-window") {
    const out: AvailabilityInterval[] = [
      {
        id: authoredId("availability", "baker-fixed-break"),
        resource: authoredId("resource", "baker"),
        interval: shiftInterval(10_200, 11_100),
      },
    ];
    if (input.workers === 2) {
      out.push({
        id: authoredId("availability", "barista-fixed-break"),
        resource: authoredId("resource", "barista"),
        interval: shiftInterval(10_200, 11_100),
      });
    }
    return out;
  }
  const out: AvailabilityInterval[] = [
    {
      id: authoredId("availability", "baker-relief-break"),
      resource: authoredId("resource", "baker"),
      interval: shiftInterval(7_800, 8_700),
    },
  ];
  if (input.workers === 2) {
    out.push({
      id: authoredId("availability", "barista-relief-break"),
      resource: authoredId("resource", "barista"),
      interval: shiftInterval(10_200, 11_100),
    });
  }
  return out;
}

function sharedStorage(id: StorageId): StorageId {
  if (id === "clean-pan") return authoredId("storage", "clean-pans");
  if (id === "hob-vessel") return authoredId("storage", "hob");
  if (id === "cold-staging-table")
    return authoredId("storage", "pan-staging-table");
  if (id === "cold-staging-rack")
    return authoredId("storage", "pan-staging-rack");
  return id;
}

function sharedCarrierStep(step: CarrierStep): CarrierStep {
  switch (step.kind) {
    case "acquire":
      return {
        kind: "acquire",
        role: step.role,
        from: sharedStorage(step.from),
      };
    case "move":
      return {
        kind: "move",
        role: step.role,
        from: sharedStorage(step.from),
        to: sharedStorage(step.to),
        timing: step.timing,
      };
    case "release":
      return step;
    default:
      return assertNever(step);
  }
}

function sharedFinancierTask(step: TaskDefinition): TaskDefinition {
  const claims: TaskDefinition["claims"][number][] = [];
  for (const claim of step.claims)
    claims.push({
      resource:
        claim.resource === "hob"
          ? authoredId("resource", "hob-power")
          : claim.resource,
      units: claim.units,
      configuration: claim.configuration,
    });
  let executor = step.executor;
  if (executor.kind === "attended")
    executor = {
      kind: "attended",
      workers: [authoredId("resource", "tea-worker")],
      start: executor.start,
      finish: executor.finish,
      duration: executor.duration,
      evidence: executor.evidence,
    };
  return {
    key: step.key,
    priority: step.priority,
    releaseAfter: step.releaseAfter,
    prerequisites: step.prerequisites,
    claims,
    executor,
    inputs: step.inputs,
    outputs: step.outputs,
    carriers: step.carriers.map(sharedCarrierStep),
    releases: step.releases,
  };
}

function applyCustomTravelRoutes(
  baseTravel: readonly TravelRoute[],
  customTravel: readonly TravelRoute[] | undefined,
  options: Readonly<{ exactSet: boolean }>,
): readonly TravelRoute[] {
  if (customTravel === undefined) return baseTravel;
  if (options.exactSet) {
    d.requireValue(validTravelRouteReplacement(baseTravel, customTravel));
    return customTravel;
  }
  const customByPair = new Map<string, TravelRoute>();
  for (const route of customTravel) {
    d.requireValue(route.from !== route.to && tickDuration(route.duration).ok);
    const key = routePairKey(route.from, route.to);
    d.requireValue(!customByPair.has(key));
    customByPair.set(key, route);
  }
  return baseTravel.map((route) => {
    const replacement = customByPair.get(routePairKey(route.from, route.to));
    d.requireValue(replacement !== undefined);
    return replacement;
  });
}

function composeBoundedShift(
  financier: CompiledScenario,
  tea: CompiledScenario,
  customTravel?: readonly TravelRoute[],
): CompiledScenario {
  const resources: CompiledScenario["resources"][number][] = [];
  for (const resource of financier.resources) {
    if (resource.kind === "worker") {
      const baseTravel = [...resource.travel];
      for (const place of ["prep", "hob", "sink", "oven", "cooling", "packing"])
        for (const [from, to] of [
          [place, "tea-station"],
          ["tea-station", place],
        ] as const)
          baseTravel.push({
            from: authoredId("location", from),
            to: authoredId("location", to),
            duration: d.value(durationFromSeconds(5)),
            evidence: "assumed",
          });
      const travel = applyCustomTravelRoutes(baseTravel, customTravel, {
        exactSet: false,
      });
      resources.push({
        id: authoredId("resource", "tea-worker"),
        kind: "worker",
        capacity: 1,
        configuration: null,
        initialLocation: resource.initialLocation,
        travel,
      });
    } else if (resource.id !== "hob") resources.push(resource);
  }
  const teaResources: CompiledScenario["resources"][number][] = [];
  for (const resource of tea.resources)
    if (resource.kind !== "worker") teaResources.push(resource);
  const storages: CompiledScenario["storages"][number][] = [];
  for (const storage of financier.storages)
    if (storage.id !== "clean-pan" && storage.id !== "hob-vessel")
      storages.push(storage);
  const carriers: CompiledScenario["carriers"][number][] = [];
  for (const carrier of financier.carriers)
    if (carrier.id !== "pan-1") carriers.push(carrier);
  const workflows: CompiledScenario["workflows"][number][] = [];
  for (const workflow of financier.workflows)
    workflows.push({
      id: workflow.id,
      revision: workflow.revision,
      demand: workflow.demand,
      tasks: workflow.tasks.map(sharedFinancierTask),
    });
  return {
    schemaVersion: financier.schemaVersion,
    id: authoredId("scenario", "bakery-shift"),
    policy: financier.policy,
    sources: [...financier.sources, ...tea.sources],
    limits: financier.limits,
    products: sharedRecipeRecords(financier.products, tea.products),
    destinations: sharedRecipeRecords(financier.destinations, tea.destinations),
    resources: sharedRecipeRecords(resources, teaResources),
    storages: sharedRecipeRecords(storages, tea.storages),
    carriers: sharedRecipeRecords(carriers, tea.carriers),
    stock: [...financier.stock, ...tea.stock],
    cells: tea.cells,
    workflows: [...workflows, ...tea.workflows],
    arrivals: [...financier.arrivals, ...tea.arrivals],
    dependencies: financier.dependencies,
    availability: [],
  };
}

export const SHIFT_LOCATIONS = [
  "prep",
  "hob",
  "sink",
  "oven",
  "cooling",
  "packing",
  "sesame-station",
  "tea-station",
  "coffee-station",
] as const;

type WorkerResource = Variant<CompiledScenario["resources"][number], "worker">;

export function shiftTravel(
  walkSpeedPreset: "standard" | "brisk" | "congested-aisle" = "standard",
): WorkerResource["travel"] {
  const travel: WorkerResource["travel"][number][] = [];
  const prepCluster = new Set([
    "prep",
    "hob",
    "sink",
    "sesame-station",
    "tea-station",
    "coffee-station",
  ]);
  const intraClusterSeconds =
    walkSpeedPreset === "brisk"
      ? 4
      : walkSpeedPreset === "congested-aisle"
        ? 7
        : 5;
  const crossClusterSeconds =
    walkSpeedPreset === "brisk"
      ? 11
      : walkSpeedPreset === "congested-aisle"
        ? 21
        : 15;
  for (const from of SHIFT_LOCATIONS)
    for (const to of SHIFT_LOCATIONS) {
      if (from === to) continue;
      const seconds =
        prepCluster.has(from) && prepCluster.has(to)
          ? intraClusterSeconds
          : crossClusterSeconds;
      travel.push({
        from: authoredId("location", from),
        to: authoredId("location", to),
        duration: d.value(durationFromSeconds(seconds)),
        evidence: "assumed",
      });
    }
  return travel;
}

/** Moves a bar pan to the bar's own hob positions instead of the kitchen's. */
function barCarrierStep(step: CarrierStep): CarrierStep {
  const place = (id: StorageId): StorageId =>
    id === "hob" ? authoredId("storage", "bar-hob") : id;
  switch (step.kind) {
    case "acquire":
      return { ...step, from: place(step.from) };
    case "move":
      return { ...step, from: place(step.from), to: place(step.to) };
    case "release":
      return step;
    default:
      return assertNever(step);
  }
}

type WorkerPool = readonly [ResourceId, ...ResourceId[]];

/** The step that hands each drink to the customer. */
const SERVICE_STEP: Readonly<Record<string, string>> = {
  "sesame-drink": "pour-and-serve",
  "ginger-tea-batch": "serve-or-discard",
  "ginger-milk-tea-batch": "serve-milk-tea",
  "espresso-orders": "extract-espresso",
  "pour-over-brew": "serve-pour-over-and-rinse",
};

/**
 * Dispatch priority of a customer-order step. Straining ends a timed
 * extraction, so it goes first (-3); then the steps that bring the drink to
 * the customer (-2); then clearing and washing after service (-1).
 * Production stays at 0.
 */
function orderPriorityOf(
  key: string,
  service: ReadonlySet<string> | null,
): number {
  if (key.startsWith("strain-")) return -3;
  return service === null || service.has(key) ? -2 : -1;
}

/** The service step and every step it waits for within its workflow. */
function serviceSteps(
  workflow: CompiledScenario["workflows"][number],
): ReadonlySet<string> | null {
  const service = SERVICE_STEP[workflow.id];
  if (service === undefined) return null;
  const byKey = new Map<string, TaskDefinition>();
  for (const step of workflow.tasks) byKey.set(step.key, step);
  const path = new Set<string>();
  const pending = [service];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || path.has(key)) continue;
    path.add(key);
    for (const before of byKey.get(key)?.prerequisites ?? [])
      pending.push(before);
  }
  return path;
}

/**
 * The workers who may do a workflow's attended tasks. One worker does
 * everything. Two workers without roles share every task. With station roles
 * the barista alone serves customer orders and the baker runs production. A
 * barista who helps production cannot leave a started task for a new order.
 */
function shiftWorkerPool(
  input: BakeryServiceShiftInput,
  demand: CompiledScenario["workflows"][number]["demand"],
): WorkerPool {
  const baker = authoredId("resource", "baker");
  const barista = authoredId("resource", "barista");
  if (input.workers === 1) return [baker];
  if (input.stationRoles === false) return [baker, barista];
  if (demand === "order") return [barista];
  return input.baristaHelpsProduction === true ? [baker, barista] : [baker];
}

function rewriteMorningWorkflow(
  workflow: CompiledScenario["workflows"][number],
  input: BakeryServiceShiftInput,
  ovenConfig: "financier-bake" | "sesame-roast" | "pie-bake" | null,
): CompiledScenario["workflows"][number] {
  const pool = shiftWorkerPool(input, workflow.demand);
  const bar = input.barScale !== false && workflow.demand === "order";
  // Lower values dispatch first (priority, then arrival, then task id). The
  // steps that bring a drink to the customer go first (-2), then clearing and
  // washing the bar equipment after service (-1), then production (0).
  const ordered = input.orderPriority !== false && workflow.demand === "order";
  const service = serviceSteps(workflow);
  return {
    id: workflow.id,
    revision: workflow.revision,
    demand: workflow.demand,
    tasks: workflow.tasks.map((step) =>
      rewriteMorningTask(
        step,
        pool,
        bar,
        ovenConfig,
        ordered ? orderPriorityOf(step.key, service) : null,
      ),
    ),
  };
}

function rewriteMorningTask(
  step: TaskDefinition,
  workerPool: WorkerPool,
  bar: boolean,
  ovenConfig: "financier-bake" | "sesame-roast" | "pie-bake" | null,
  priority: number | null,
): TaskDefinition {
  const claims: TaskDefinition["claims"][number][] = [];
  for (const claim of step.claims) {
    let resource = claim.resource;
    if (resource === "hob") resource = authoredId("resource", "hob-power");
    else if (resource === "cold-cell-arm")
      resource = authoredId("resource", "staging-arm");
    if (bar && resource === "scale")
      resource = authoredId("resource", "bar-scale");
    if (bar && resource === "hob-power")
      resource = authoredId("resource", "bar-hob-power");
    const configuration =
      resource === "oven" && ovenConfig !== null
        ? authoredId("configuration", ovenConfig)
        : claim.configuration;
    claims.push({
      resource,
      units: claim.units,
      configuration,
    });
  }
  let executor = step.executor;
  if (executor.kind === "attended")
    executor = {
      kind: "attended",
      workers: workerPool,
      start: executor.start,
      finish: executor.finish,
      duration: executor.duration,
      evidence: executor.evidence,
    };
  else if (
    executor.kind === "after-inspection" &&
    executor.work.kind === "attended"
  )
    executor = {
      kind: "after-inspection",
      inspection: executor.inspection,
      outcome: executor.outcome,
      work: {
        kind: "attended",
        workers: workerPool,
        start: executor.work.start,
        finish: executor.work.finish,
        duration: executor.work.duration,
        evidence: executor.work.evidence,
      },
    };
  return {
    key: step.key,
    priority: priority ?? step.priority,
    releaseAfter: step.releaseAfter,
    prerequisites: step.prerequisites,
    claims,
    executor,
    inputs: step.inputs,
    outputs: step.outputs,
    carriers: step.carriers.map((carrier) => {
      const shared = sharedCarrierStep(carrier);
      return bar ? barCarrierStep(shared) : shared;
    }),
    releases: step.releases,
  };
}

/**
 * The convection oven bakes financiers at 170 °C and pies at 200 °C, and
 * roasts sesame when the shift refreshes it. A change between programmes
 * waits for the chamber: heating is faster than cooling with the vent open.
 */
function ovenChangeovers(
  sesameRoast: BakeryServiceShiftInput["sesameRoast"],
): Changeover[] {
  const pairs: [string, string, number][] = [
    ["financier-bake", "pie-bake", 180],
    ["pie-bake", "financier-bake", 240],
  ];
  if (sesameRoast === "refresh")
    pairs.push(
      ["financier-bake", "sesame-roast", 120],
      ["sesame-roast", "financier-bake", 120],
      ["sesame-roast", "pie-bake", 240],
      ["pie-bake", "sesame-roast", 300],
    );
  return pairs.map(([from, to, seconds]) => ({
    from: authoredId("configuration", from),
    to: authoredId("configuration", to),
    duration: d.value(durationFromSeconds(seconds)),
    evidence: "assumed",
    claims: [],
  }));
}

function composeMorningShift(
  financier: CompiledScenario,
  sesame: CompiledScenario,
  blackTea: CompiledScenario,
  milkTea: CompiledScenario,
  espresso: CompiledScenario | null,
  pourOver: CompiledScenario | null,
  pies: CompiledScenario | null,
  input: BakeryServiceShiftInput,
): CompiledScenario {
  const extraScenarios: CompiledScenario[] = [];
  if (espresso !== null) extraScenarios.push(espresso);
  if (pourOver !== null) extraScenarios.push(pourOver);
  const allScenarios = [
    financier,
    sesame,
    blackTea,
    milkTea,
    ...extraScenarios,
    ...(pies === null ? [] : [pies]),
  ];
  const travel = applyCustomTravelRoutes(
    shiftTravel(input.walkSpeedPreset),
    input.customTravel,
    { exactSet: true },
  );
  const resources = new Map<string, CompiledScenario["resources"][number]>();
  resources.set("baker", {
    id: authoredId("resource", "baker"),
    kind: "worker",
    capacity: 1,
    configuration: null,
    initialLocation: authoredId("location", "prep"),
    travel,
  });
  if (input.workers === 2) {
    resources.set("barista", {
      id: authoredId("resource", "barista"),
      kind: "worker",
      capacity: 1,
      configuration: null,
      initialLocation: authoredId("location", "coffee-station"),
      travel,
    });
  }
  if (input.barScale !== false) {
    resources.set("bar-scale", {
      id: authoredId("resource", "bar-scale"),
      kind: "capacity",
      capacity: 1,
      configuration: null,
    });
    resources.set("bar-hob-power", {
      id: authoredId("resource", "bar-hob-power"),
      kind: "capacity",
      capacity: 2,
      configuration: null,
    });
  }
  for (const scenario of allScenarios) {
    for (const resource of scenario.resources) {
      if (
        resource.kind === "worker" ||
        resource.id === "hob" ||
        resource.id === "cold-cell-arm"
      )
        continue;
      if (resource.id === "hob-power") {
        resources.set(resource.id, {
          ...resource,
          capacity: input.hobZones,
        });
        continue;
      }
      if (resource.id === "oven" && resource.kind === "capacity") {
        resources.set(resource.id, {
          ...resource,
          configuration: {
            initial: authoredId("configuration", "financier-bake"),
            changeovers: ovenChangeovers(input.sesameRoast),
          },
        });
        continue;
      }
      resources.set(resource.id, resource);
    }
  }

  const stock = new Map<string, CompiledScenario["stock"][number]>();
  for (const scenario of allScenarios) {
    for (const entry of scenario.stock) {
      const previous = stock.get(entry.id);
      stock.set(entry.id, {
        id: entry.id,
        product: entry.product,
        storage: entry.storage,
        quantity:
          previous === undefined
            ? entry.quantity
            : d.value(addQuantity(previous.quantity, entry.quantity)),
      });
    }
  }

  const storages = new Map<string, CompiledScenario["storages"][number]>();
  for (const scenario of allScenarios) {
    for (const entry of scenario.storages) {
      if (
        entry.id === "clean-pan" ||
        entry.id === "hob-vessel" ||
        entry.id === "cold-staging-table" ||
        entry.id === "cold-staging-rack"
      )
        continue;
      storages.set(entry.id, entry);
    }
  }
  for (const entry of stock.values()) {
    storages.set(entry.storage, {
      id: entry.storage,
      capacity: {
        kind: "material",
        product: entry.product,
        quantity: entry.quantity,
      },
      cell: null,
    });
  }
  if (input.barScale !== false)
    storages.set("bar-hob", {
      id: authoredId("storage", "bar-hob"),
      capacity: { kind: "carriers", slots: 2 },
      cell: null,
    });
  for (const [id, slots] of [
    ["clean-pans", input.panCount],
    ["prep-bench", input.panCount],
    ["hob", input.hobZones],
    ["heatproof-rest", 2],
    ["wash-pans", input.panCount],
    ["receiving-position", 2],
    ["wash-receivers", 2],
    ["clean-strainers", input.strainers],
    ["straining-position", input.strainers],
    ["wash-strainers", input.strainers],
  ] as const) {
    const existing = storages.get(id);
    if (existing !== undefined) {
      storages.set(id, {
        ...existing,
        capacity: { kind: "carriers", slots },
      });
    }
  }

  const carriers = new Map<string, CompiledScenario["carriers"][number]>();
  for (const entry of financier.carriers)
    if (entry.id !== "pan-1") carriers.set(entry.id, entry);
  for (const entry of sesame.carriers)
    if (entry.id !== "pan") carriers.set(entry.id, entry);
  for (const entry of blackTea.carriers) carriers.set(entry.id, entry);
  for (const entry of milkTea.carriers) carriers.set(entry.id, entry);
  for (const extra of extraScenarios)
    for (const entry of extra.carriers) carriers.set(entry.id, entry);
  if (pies !== null)
    for (const entry of pies.carriers) carriers.set(entry.id, entry);
  if (input.strainers === 2)
    carriers.set("strainer-2", {
      id: authoredId("carrier", "strainer-2"),
      storage: authoredId("storage", "clean-strainers"),
    });
  for (let pan = 3; pan <= input.panCount; pan++)
    carriers.set(`pan-${pan}`, {
      id: authoredId("carrier", `pan-${pan}`),
      storage: authoredId("storage", "clean-pans"),
    });

  let products = sharedRecipeRecords(financier.products, sesame.products);
  products = sharedRecipeRecords(products, blackTea.products);
  products = sharedRecipeRecords(products, milkTea.products);
  for (const extra of extraScenarios)
    products = sharedRecipeRecords(products, extra.products);
  if (pies !== null) products = sharedRecipeRecords(products, pies.products);

  let destinations = sharedRecipeRecords(
    financier.destinations,
    sesame.destinations,
  );
  destinations = sharedRecipeRecords(destinations, blackTea.destinations);
  destinations = sharedRecipeRecords(destinations, milkTea.destinations);
  for (const extra of extraScenarios)
    destinations = sharedRecipeRecords(destinations, extra.destinations);
  if (pies !== null)
    destinations = sharedRecipeRecords(destinations, pies.destinations);

  const ovenConfigForFinancier = "financier-bake";
  const ovenConfigForSesame =
    input.sesameRoast === "refresh" ? "sesame-roast" : null;

  const workflows: CompiledScenario["workflows"][number][] = [];
  for (const workflow of financier.workflows)
    workflows.push(
      rewriteMorningWorkflow(workflow, input, ovenConfigForFinancier),
    );
  for (const workflow of sesame.workflows)
    workflows.push(
      rewriteMorningWorkflow(workflow, input, ovenConfigForSesame),
    );
  for (const workflow of blackTea.workflows)
    workflows.push(rewriteMorningWorkflow(workflow, input, null));
  for (const workflow of milkTea.workflows)
    workflows.push(rewriteMorningWorkflow(workflow, input, null));
  for (const extra of extraScenarios)
    for (const workflow of extra.workflows)
      workflows.push(rewriteMorningWorkflow(workflow, input, null));
  if (pies !== null)
    for (const workflow of pies.workflows)
      workflows.push(rewriteMorningWorkflow(workflow, input, "pie-bake"));

  const financierArrivals = financier.arrivals.map((source) =>
    source.kind === "explicit"
      ? {
          ...source,
          arrivals: source.arrivals.map((entry) => ({
            ...entry,
            time: d.value(
              timeFromSeconds(600 + Math.round(entry.time / 1_000_000)),
            ),
          })),
        }
      : source,
  );

  return {
    schemaVersion: financier.schemaVersion,
    id: authoredId("scenario", "bakery-shift"),
    policy: financier.policy,
    sources: [
      ...financier.sources,
      ...sesame.sources,
      ...blackTea.sources,
      ...milkTea.sources,
      ...extraScenarios.flatMap((s) => s.sources),
      ...(pies === null ? [] : pies.sources),
    ],
    limits: {
      horizon: d.value(timeFromSeconds(shiftHorizonSeconds(input))),
      eventCap: financier.limits.eventCap,
    },
    products,
    destinations,
    resources: [...resources.values()],
    storages: [...storages.values()],
    carriers: [...carriers.values()],
    stock: [...stock.values()],
    cells: milkTea.cells,
    workflows,
    arrivals: [
      ...financierArrivals,
      ...sesame.arrivals,
      ...blackTea.arrivals,
      ...milkTea.arrivals,
      ...extraScenarios.flatMap((s) => s.arrivals),
      ...(pies === null ? [] : pies.arrivals),
    ],
    dependencies: [
      ...financier.dependencies,
      ...(pies === null ? [] : pies.dependencies),
    ],
    availability: shiftAvailability(input),
  };
}

function optionalFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  d.requireValue(typeof raw === "boolean");
  return raw;
}

function parseCarryoverMiseEnPlaceLot(raw: unknown): CarryoverMiseEnPlaceLot {
  const r = d.record(raw, [
    "lot",
    "product",
    "storage",
    "quantityMg",
    "madeBy",
    "holdHours",
    "madeAtSeconds",
    "elapsedBeforeShiftSeconds",
  ]);
  const madeBy = d.record(r.madeBy, ["workflow", "task"]);
  d.requireValue(
    typeof r.madeAtSeconds === "number" &&
      Number.isFinite(r.madeAtSeconds) &&
      r.madeAtSeconds >= 0 &&
      typeof r.elapsedBeforeShiftSeconds === "number" &&
      Number.isFinite(r.elapsedBeforeShiftSeconds) &&
      r.elapsedBeforeShiftSeconds >= 0,
  );
  return {
    lot: d.authored("lot", r.lot),
    product: d.authored("product", r.product),
    storage: d.authored("storage", r.storage),
    quantityMg: d.positive(r.quantityMg),
    madeBy: {
      workflow: d.authored("workflow", madeBy.workflow),
      task: d.authored("task-key", madeBy.task),
    },
    holdHours: d.positive(r.holdHours),
    madeAtSeconds: r.madeAtSeconds,
    elapsedBeforeShiftSeconds: r.elapsedBeforeShiftSeconds,
  };
}

function parseBakeryServiceShiftInput(raw: unknown): BakeryServiceShiftInput {
  d.requireValue(isRecord(raw));
  const optionalKeys: string[] = [];
  for (const key of [
    "kind",
    "piesPerType",
    "miseEnPlace",
    "stationRoles",
    "orderPriority",
    "milkJugs",
    "strainers",
    "baristaHelpsProduction",
    "barScale",
    "cupWarming",
    "financierWaves",
    "waveIntervalMinutes",
    "reorderThresholdUnits",
    "carryoverMiseEnPlace",
    "mouldCount",
    "coolingGridSlots",
    "demandPreset",
    "shiftBreakPolicy",
    "walkSpeedPreset",
    "customTravel",
    "espressoOrders",
    "espressoAppliance",
    "pourOverOrders",
    "coffeeGrinder",
  ]) {
    if (key in raw && raw[key] !== undefined) optionalKeys.push(key);
  }
  const r = d.record(raw, [
    "financierLoads",
    "sesameBatches",
    "sesameRoast",
    "sesameCoolingSeconds",
    "sesamePreparation",
    "blackTeaBatches",
    "milkTeaBatches",
    "workers",
    "hobZones",
    "panCount",
    "nativeColdHandling",
    ...optionalKeys,
  ]);
  const financierLoads = d.positive(r.financierLoads);
  const piesPerType =
    r.piesPerType === undefined ? 6 : d.choice(r.piesPerType, 0, 3, 6);
  const financierWaves =
    r.financierWaves === undefined ? 1 : d.choice(r.financierWaves, 1, 2, 3);
  const waveIntervalMinutes =
    r.waveIntervalMinutes === undefined
      ? 45
      : d.positive(r.waveIntervalMinutes);
  const reorderThresholdUnits =
    r.reorderThresholdUnits === undefined
      ? undefined
      : d.natural(r.reorderThresholdUnits);
  const carryoverMiseEnPlace =
    r.carryoverMiseEnPlace === undefined
      ? undefined
      : d.array(r.carryoverMiseEnPlace, parseCarryoverMiseEnPlaceLot);
  const mouldCount =
    r.mouldCount === undefined ? 2 : d.choice(r.mouldCount, 2, 3);
  const coolingGridSlots =
    r.coolingGridSlots === undefined
      ? 2
      : d.choice(r.coolingGridSlots, 2, 3, 4);
  const demandPreset =
    r.demandPreset === undefined
      ? "rush"
      : d.choice(r.demandPreset, "steady", "rush", "gift-box-surge");
  const shiftBreakPolicy =
    r.shiftBreakPolicy === undefined
      ? "staggered-relief"
      : d.choice(
          r.shiftBreakPolicy,
          "staggered-relief",
          "fixed-window",
          "continuous-no-break",
        );
  const walkSpeedPreset =
    r.walkSpeedPreset === undefined
      ? "standard"
      : d.choice(r.walkSpeedPreset, "standard", "brisk", "congested-aisle");
  const customTravel =
    r.customTravel === undefined
      ? undefined
      : d.array(r.customTravel, readTravelRoute);
  if (customTravel !== undefined) {
    d.requireValue(
      validTravelRouteReplacement(shiftTravel(walkSpeedPreset), customTravel),
    );
  }
  const sesameBatches = d.positive(r.sesameBatches);
  const sesameRoast = d.choice(r.sesameRoast, "skip", "refresh");
  const sesameCoolingSeconds = d.positive(r.sesameCoolingSeconds);
  const sesamePreparation = d.choice(r.sesamePreparation, "baseline", "early");
  const blackTeaBatches = d.positive(r.blackTeaBatches);
  const milkTeaBatches = d.positive(r.milkTeaBatches);
  const espressoOrders =
    r.espressoOrders === undefined ? 2 : d.natural(r.espressoOrders);
  const espressoAppliance =
    r.espressoAppliance === undefined
      ? "linea"
      : d.choice(r.espressoAppliance, "linea", "eagle-one");
  const pourOverOrders =
    r.pourOverOrders === undefined ? 2 : d.natural(r.pourOverOrders);
  const coffeeGrinder =
    r.coffeeGrinder === undefined
      ? "option-o-lagom-casa"
      : d.choice(
          r.coffeeGrinder,
          "option-o-lagom-casa",
          "timemore-bricks-01s",
          "fellow-opus-2",
          "miicoffee-df64-gen2",
        );
  const workers = d.choice(r.workers, 1, 2);
  const miseEnPlace =
    r.miseEnPlace === undefined
      ? "day-before"
      : d.choice(r.miseEnPlace, "day-before", "same-morning");
  const stationRoles =
    r.stationRoles === undefined ? true : r.stationRoles === true;
  d.requireValue(
    r.stationRoles === undefined || typeof r.stationRoles === "boolean",
  );
  const orderPriority =
    r.orderPriority === undefined ? true : r.orderPriority === true;
  d.requireValue(
    r.orderPriority === undefined || typeof r.orderPriority === "boolean",
  );
  const hobZones = d.choice(r.hobZones, 1, 2);
  const panCount = d.choice(r.panCount, 2, 3, 4);
  d.requireValue(typeof r.nativeColdHandling === "boolean");
  d.requireValue(
    financierLoads <= 3 &&
      waveIntervalMinutes >= 30 &&
      waveIntervalMinutes <= 90 &&
      (reorderThresholdUnits === undefined || reorderThresholdUnits <= 24) &&
      sesameBatches <= 3 &&
      blackTeaBatches <= 3 &&
      milkTeaBatches <= 3 &&
      espressoOrders <= 4 &&
      pourOverOrders <= 2,
  );
  return {
    kind:
      r.kind === undefined
        ? "morning-shift"
        : d.choice(r.kind, "morning-shift", "six-hour-shift"),
    financierLoads,
    piesPerType,
    financierWaves,
    waveIntervalMinutes,
    ...(reorderThresholdUnits === undefined ? {} : { reorderThresholdUnits }),
    ...(carryoverMiseEnPlace === undefined ? {} : { carryoverMiseEnPlace }),
    mouldCount,
    coolingGridSlots,
    demandPreset,
    shiftBreakPolicy,
    walkSpeedPreset,
    ...(customTravel === undefined ? {} : { customTravel }),
    sesameBatches,
    sesameRoast,
    sesameCoolingSeconds,
    sesamePreparation,
    blackTeaBatches,
    milkTeaBatches,
    espressoOrders,
    espressoAppliance,
    pourOverOrders,
    coffeeGrinder,
    workers,
    hobZones,
    panCount,
    nativeColdHandling: r.nativeColdHandling,
    miseEnPlace,
    stationRoles,
    orderPriority,
    milkJugs: r.milkJugs === undefined ? 3 : d.choice(r.milkJugs, 1, 2, 3),
    baristaHelpsProduction: optionalFlag(r.baristaHelpsProduction, false),
    strainers: r.strainers === undefined ? 2 : d.choice(r.strainers, 1, 2),
    barScale: optionalFlag(r.barScale, true),
    cupWarming:
      r.cupWarming === undefined
        ? "espresso-tap"
        : d.choice(r.cupWarming, "espresso-tap", "pan"),
  };
}

/** The morning shift runs from 07:00 for eight hours. */

function onHandLot(lot: MiseEnPlaceLot): CompiledScenario["stock"][number] {
  return {
    id: authoredId("lot", lot.lot),
    product: authoredId("product", lot.product),
    quantity: d.value(
      normalizeQuantity({ amount: lot.quantityMg, scale: 3, unit: "gram" }),
    ),
    storage: authoredId("storage", lot.storage),
  };
}

/**
 * Ginger tea from the day-before decoction: the morning pours the chilled
 * decoction, reheats it and brews the tea, without the 7-minute ginger simmer.
 */
function teaFromStock(
  tea: CompiledScenario,
  onHand: readonly MiseEnPlaceLot[],
): CompiledScenario {
  const stock = [...tea.stock];
  const storages = [...tea.storages];
  const products = [...tea.products];
  const workflows = tea.workflows.map((workflow) => {
    const decoction = gingerDecoctions().find(
      (entry) => entry.teaWorkflow === workflow.id,
    );
    const lot = onHand.find((entry) => entry.product === decoction?.product);
    if (decoction === undefined || lot === undefined) return workflow;
    const opening = onHandLot(lot);
    stock.push(opening);
    products.push({ id: opening.product, unit: "milligram" });
    storages.push({
      id: opening.storage,
      capacity: {
        kind: "material",
        product: opening.product,
        quantity: opening.quantity,
      },
      cell: null,
    });
    return teaFromDecoction(workflow, decoction);
  });
  return { ...tea, products, workflows, stock, storages };
}

/**
 * Drink service from the day-before concentrate: the batch workflow and its
 * ingredients leave the morning, and the bottled concentrate is on hand in
 * the refrigerator. Every order still doses, heats, pours and washes.
 */
function sesameServiceFromStock(
  sesame: CompiledScenario,
  concentrate: MiseEnPlaceLot,
): CompiledScenario {
  const served = new Set(["milk", "empty-cup"]);
  const stock = sesame.stock.filter((entry) => served.has(entry.product));
  const kept = new Set<string>(stock.map((entry) => entry.storage));
  const opening = onHandLot(concentrate);
  return {
    ...sesame,
    workflows: sesame.workflows.filter((w) => w.id !== "sesame-batch"),
    arrivals: sesame.arrivals.filter((a) => a.workflow !== "sesame-batch"),
    stock: [...stock, opening],
    storages: [
      ...sesame.storages.filter(
        (storage) => !storage.id.endsWith("-stock") || kept.has(storage.id),
      ),
      {
        id: opening.storage,
        capacity: {
          kind: "material",
          product: opening.product,
          quantity: opening.quantity,
        },
        cell: null,
      },
    ],
  };
}

/**
 * The previous afternoon's production: two black sesame concentrate batches,
 * the shortcrust dough and both pie fillings, braised and chilled. One baker
 * runs it from 13:00. Its outputs are the morning's mise en place.
 */
export async function compileAfternoonPrep(
  raw: unknown,
): Promise<
  Result<CompiledScenario, Readonly<{ code: "invalid_afternoon_prep" }>>
> {
  try {
    const optionalKeys =
      isRecord(raw) && "batchesPerTea" in raw && raw.batchesPerTea !== undefined
        ? (["batchesPerTea"] as const)
        : ([] as const);
    const r = d.record(raw, ["piesPerType", ...optionalKeys]);
    const piesPerType = d.choice(r.piesPerType, 0, 3, 6);
    const batchesPerTea =
      r.batchesPerTea === undefined ? 2 : d.choice(r.batchesPerTea, 1, 2, 3);
    const sesameInput = blackSesameRecipeInput();
    sesameInput.roast = "refresh";
    sesameInput.batchArrivalsSeconds = [0, 3_000];
    // The recipe needs one order; the afternoon run removes the service.
    sesameInput.orderArrivalsSeconds = [21_000];
    const brewed = await compileBlackSesameRecipe(sesameInput);
    if (!brewed.ok) return err({ code: "invalid_afternoon_prep" });
    // The concentrate waits for tomorrow, so every batch gets its own bottles.
    const sesame: CompiledScenario = {
      ...bottleEveryBatch(
        brewed.value,
        sesameInput.batchArrivalsSeconds.length,
      ),
      workflows: brewed.value.workflows.filter((w) => w.id === "sesame-batch"),
      arrivals: brewed.value.arrivals.filter(
        (a) => a.workflow === "sesame-batch",
      ),
      stock: brewed.value.stock.filter(
        (entry) => entry.product !== "milk" && entry.product !== "empty-cup",
      ),
    };
    const parts = [sesame, await decoctionPrep(batchesPerTea)];
    if (piesPerType !== 0) {
      const pies = await compilePieRecipe(
        pieRecipeInput({
          piesPerType,
          stage: "prep",
          shortcrustArrivalSeconds: 0,
          fillingArrivalsSeconds: [0, 120],
        }),
      );
      if (!pies.ok) return err({ code: "invalid_afternoon_prep" });
      parts.push(pies.value);
    }
    let products: CompiledScenario["products"][number][] = [];
    let destinations: CompiledScenario["destinations"][number][] = [];
    const resources = new Map<string, CompiledScenario["resources"][number]>();
    resources.set("baker", {
      id: authoredId("resource", "baker"),
      kind: "worker",
      capacity: 1,
      configuration: null,
      initialLocation: authoredId("location", "prep"),
      travel: shiftTravel(),
    });
    const storages = new Map<string, CompiledScenario["storages"][number]>();
    const carriers = new Map<string, CompiledScenario["carriers"][number]>();
    const stock = new Map<string, CompiledScenario["stock"][number]>();
    for (const part of parts) {
      products = sharedRecipeRecords(products, part.products);
      destinations = sharedRecipeRecords(destinations, part.destinations);
      for (const resource of part.resources)
        if (resource.kind !== "worker") resources.set(resource.id, resource);
      for (const storage of part.storages) storages.set(storage.id, storage);
      for (const carrier of part.carriers) carriers.set(carrier.id, carrier);
      for (const entry of part.stock) {
        const previous = stock.get(entry.id);
        stock.set(entry.id, {
          ...entry,
          quantity:
            previous === undefined
              ? entry.quantity
              : d.value(addQuantity(previous.quantity, entry.quantity)),
        });
      }
    }
    for (const entry of stock.values())
      storages.set(entry.storage, {
        id: entry.storage,
        capacity: {
          kind: "material",
          product: entry.product,
          quantity: entry.quantity,
        },
        cell: null,
      });
    return ok({
      schemaVersion: sesame.schemaVersion,
      id: authoredId("scenario", "afternoon-prep"),
      policy: sesame.policy,
      sources: parts.flatMap((part) => part.sources),
      limits: {
        horizon: d.value(timeFromSeconds(MORNING_SHIFT_SECONDS)),
        eventCap: sesame.limits.eventCap,
      },
      products,
      destinations,
      resources: [...resources.values()],
      storages: [...storages.values()],
      carriers: [...carriers.values()],
      stock: [...stock.values()],
      cells: [],
      workflows: parts.flatMap((part) => part.workflows),
      arrivals: parts.flatMap((part) => part.arrivals),
      dependencies: parts.flatMap((part) => part.dependencies),
      availability: [],
    });
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_afternoon_prep" });
    throw error;
  }
}

function sharedRackCellFromPanCell(rawCell: unknown): unknown {
  const parsed = parsePersistentCell(rawCell);
  if (parsed === null || parsed.fixture !== "persistent-pan-staging/1")
    return null;
  return {
    schemaVersion: parsed.schemaVersion,
    cellId: parsed.cellId,
    runId: parsed.runId,
    robot: parsed.robot,
    fixture: "persistent-rack/1",
    modelHash: parsed.modelHash,
    timestep: parsed.timestep,
    execution: parsed.execution,
    ingredients: {
      massKg: 1,
      forwardMm: 0,
      lateralMm: 0,
    },
    clampForceN: 100,
  };
}

/**
 * Compiles either the bounded two-recipe MVP (`{ financierLoads, milkTeaBatches }`)
 * or the full Plan 61E morning shift (`BakeryServiceShiftInput`): the shop's four
 * financiers and two pies with the café drinks.
 */
export async function compileBakeryShift(
  raw: unknown,
  rawCell: unknown,
): Promise<
  Result<CompiledScenario, Readonly<{ code: "invalid_bakery_shift" }>>
> {
  try {
    if (isRecord(raw) && "sesameBatches" in raw) {
      const input = parseBakeryServiceShiftInput(raw);
      const rackCell = input.nativeColdHandling
        ? sharedRackCellFromPanCell(rawCell)
        : null;
      if (input.nativeColdHandling && rackCell === null)
        return err({ code: "invalid_bakery_shift" });

      const financier = await compileFinancierRecipe(
        financierRecipeInput(
          input.financierLoads,
          input.coolingGridSlots,
          900,
          {
            waves: input.financierWaves,
            waveIntervalSeconds: input.waveIntervalMinutes * 60,
            mouldCount: input.mouldCount,
            flavours: FINANCIER_FLAVOURS,
          },
        ),
        rackCell ?? undefined,
      );

      const piesPerType = input.piesPerType;
      const dayBefore = input.miseEnPlace !== "same-morning";
      // Day-before mise en place: every lot on hand must stay inside its
      // refrigerated hold to the end of the shift, even if the afternoon
      // made it at the start of its run.
      const decoctions = gingerDecoctions();
      const teaBatches = {
        "ginger-tea-batch": input.blackTeaBatches,
        "ginger-milk-tea-batch": input.milkTeaBatches,
      } as const;
      const expectedOnHand = dayBefore
        ? miseEnPlaceLots(
            piesPerType,
            PIE_TYPES,
            decoctions.map((decoction) => ({
              product: decoction.product,
              quantityMg:
                decoctionMass(decoction) * teaBatches[decoction.teaWorkflow],
            })),
          )
        : [];
      let onHand: readonly MiseEnPlaceLot[] = expectedOnHand;
      if (input.carryoverMiseEnPlace !== undefined) {
        if (!dayBefore) return err({ code: "invalid_bakery_shift" });
        const validated: CarryoverMiseEnPlaceLot[] = [];
        for (const expected of expectedOnHand) {
          const carried = input.carryoverMiseEnPlace.find(
            (candidate) =>
              candidate.lot === expected.lot &&
              candidate.product === expected.product &&
              candidate.storage === expected.storage &&
              candidate.holdHours === expected.holdHours,
          );
          if (carried === undefined || carried.quantityMg < expected.quantityMg)
            return err({ code: "invalid_bakery_shift" });
          if (
            !withinHold(
              carried,
              carried.madeAtSeconds,
              shiftHorizonSeconds(input),
              carried.elapsedBeforeShiftSeconds,
            )
          )
            return err({ code: "invalid_bakery_shift" });
          validated.push(carried);
        }
        onHand = validated;
      } else {
        for (const lot of onHand)
          if (!withinHold(lot, 0, shiftHorizonSeconds(input)))
            return err({ code: "invalid_bakery_shift" });
      }
      const sixHour = input.kind === "six-hour-shift";
      const demand = bakeryShiftDemand(input);

      // Same morning, the shortcrust and fillings go first: the dough rests
      // for 30 minutes, and each filling braises for 90 minutes and chills.
      // With the day-before mise en place, the pie bench starts at once.
      const pies =
        piesPerType !== 0
          ? await compilePieRecipe(
              dayBefore
                ? pieRecipeInput({
                    piesPerType,
                    stage: "assembly",
                    assemblyArrivalsSeconds: sixHour
                      ? [600, Math.max(1_800, 5_400)]
                      : [600, 600],
                  })
                : pieRecipeInput({
                    piesPerType,
                    shortcrustArrivalSeconds: 0,
                    fillingArrivalsSeconds: [0, 120],
                  }),
            )
          : null;
      if (pies !== null && !pies.ok)
        return err({ code: "invalid_bakery_shift" });

      const sesameInput = blackSesameRecipeInput();
      sesameInput.roast = input.sesameRoast;
      sesameInput.durationsSeconds.cool = input.sesameCoolingSeconds;
      sesameInput.batchArrivalsSeconds = sixHour
        ? (input.sesamePreparation === "early"
            ? [0, Math.max(1_800, 6_600), Math.max(7_200, 13_200)]
            : [600, Math.max(2_400, 7_200), Math.max(7_800, 13_800)]
          ).slice(0, input.sesameBatches)
        : input.sesamePreparation === "early"
          ? [0, 3_000, 6_000].slice(0, input.sesameBatches)
          : [600, 3_600, 6_600].slice(0, input.sesameBatches);
      sesameInput.orderArrivalsSeconds = [...demand.sesameArrivalsSeconds];
      // With three milk jugs, one washes while the next drink heats in the
      // mixer and a third is dosed.
      sesameInput.jugCount = input.milkJugs;
      const brewed = await compileBlackSesameRecipe(
        sesameInput,
        rackCell ?? undefined,
      );
      const concentrate = onHand.find((lot) => lot.product === "concentrate");
      const sesame =
        brewed.ok && concentrate !== undefined
          ? ok(sesameServiceFromStock(brewed.value, concentrate))
          : brewed;

      const blackInput = gingerBlackTeaRecipeInput();
      blackInput.batchArrivalsSeconds = (
        sixHour ? [600, 6_600, 14_500] : [600, 1_800, 3_000]
      ).slice(0, input.blackTeaBatches);
      const blackBrewed = await compileGingerBlackTeaRecipe(
        blackInput,
        rawCell,
      );

      const milkInput = gingerMilkTeaRecipeInput();
      milkInput.batchArrivalsSeconds = (
        sixHour ? [1_200, 7_300, 15_200] : [660, 1_860, 3_060]
      ).slice(0, input.milkTeaBatches);
      const milkBrewed = await compileGingerMilkTeaRecipe(milkInput, rawCell);
      const blackTea =
        blackBrewed.ok && dayBefore
          ? ok(teaFromStock(blackBrewed.value, onHand))
          : blackBrewed;
      const milkStocked =
        milkBrewed.ok && dayBefore
          ? ok(teaFromStock(milkBrewed.value, onHand))
          : milkBrewed;
      const milkTea =
        milkStocked.ok && input.cupWarming !== "pan" && input.espressoOrders > 0
          ? ok({
              ...milkStocked.value,
              workflows: milkStocked.value.workflows.map((workflow) =>
                workflow.id === "ginger-milk-tea-batch"
                  ? milkTeaCupsFromBoiler(workflow)
                  : workflow,
              ),
            })
          : milkStocked;

      const espresso =
        input.espressoOrders > 0
          ? await compileEspressoShiftWorkflow({
              revision: 1,
              orders: input.espressoOrders,
              appliance: input.espressoAppliance,
              grinder: input.coffeeGrinder,
              arrivalsSeconds: [...demand.espressoArrivalsSeconds],
            })
          : null;

      const pourOver =
        input.pourOverOrders > 0
          ? await compilePourOverShiftWorkflow({
              revision: 1,
              orders: input.pourOverOrders,
              grinder: input.coffeeGrinder,
              arrivalsSeconds: [...demand.pourOverArrivalsSeconds],
            })
          : null;

      if (!financier.ok || !sesame.ok || !blackTea.ok || !milkTea.ok)
        return err({ code: "invalid_bakery_shift" });
      return ok(
        composeMorningShift(
          financier.value,
          sesame.value,
          blackTea.value,
          milkTea.value,
          espresso,
          pourOver,
          pies === null ? null : pies.value,
          input,
        ),
      );
    }

    d.requireValue(isRecord(raw));
    const boundedKeys = ["financierLoads", "milkTeaBatches"];
    if ("customTravel" in raw && raw.customTravel !== undefined)
      boundedKeys.push("customTravel");
    const input = d.record(raw, boundedKeys);
    const loads = d.positive(input.financierLoads);
    const batches = d.positive(input.milkTeaBatches);
    const customTravel =
      input.customTravel === undefined
        ? undefined
        : d.array(input.customTravel, readTravelRoute);
    d.requireValue(loads <= 3 && batches <= 2);
    const financier = await compileFinancierRecipe(
      financierRecipeInput(loads, 2, 900),
    );
    const milk = gingerMilkTeaRecipeInput();
    milk.batchArrivalsSeconds = batches === 1 ? [60] : [60, 120];
    const tea = await compileGingerMilkTeaRecipe(milk, rawCell);
    if (!financier.ok || !tea.ok) return err({ code: "invalid_bakery_shift" });
    return ok(composeBoundedShift(financier.value, tea.value, customTravel));
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_bakery_shift" });
    throw error;
  }
}

import {
  defaultMorningShiftFaultInjections,
  executeRecipeApplianceTasks,
  extractScheduledTasks,
  type ApplianceFaultInjectionSpec,
  type ApplianceWasmRuntimeSource,
  type RecipeApplianceExecutionOptions,
  type RecipeApplianceExecutionReport,
  type RecipeApplianceTaskBinding,
  type ScheduledTaskDescriptor,
  type ScheduledTaskSource,
} from "./appliance-execution.ts";
import { blackSesameApplianceTask } from "./black-sesame-milk.ts";
import { financierApplianceTask } from "./financier.ts";
import { pieApplianceTask } from "./pie.ts";
import { teaApplianceTask } from "./tea.ts";
import type { Variant } from "@purin-labs/type-utils";

export function morningShiftApplianceTask(
  task: ScheduledTaskDescriptor,
  espressoAppliance: "linea" | "eagle-one" = "linea",
): RecipeApplianceTaskBinding | null {
  return (
    financierApplianceTask(task) ??
    pieApplianceTask(task) ??
    blackSesameApplianceTask(task) ??
    teaApplianceTask(task) ??
    espressoApplianceTask(task, espressoAppliance) ??
    pourOverApplianceTask(task)
  );
}

function morningShiftApplianceTasks(
  source: ScheduledTaskSource,
  espressoAppliance: "linea" | "eagle-one" = "linea",
): readonly RecipeApplianceTaskBinding[] {
  const bindings: RecipeApplianceTaskBinding[] = [];
  for (const task of extractScheduledTasks(source)) {
    const bound = morningShiftApplianceTask(task, espressoAppliance);
    if (bound !== null) bindings.push(bound);
  }
  return bindings;
}

export async function executeMorningShiftApplianceTasks(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: RecipeApplianceExecutionOptions & {
    espressoAppliance?: "linea" | "eagle-one";
  } = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(
    morningShiftApplianceTasks(source, options.espressoAppliance ?? "linea"),
    runtime,
    {
      runId: options.runId ?? "morning-shift-appliance-wasm",
      scheduledTasks: options.scheduledTasks ?? extractScheduledTasks(source),
      ...options,
    },
  );
}

export async function executeMorningShiftApplianceFaultRestoreJourney(
  source: ScheduledTaskSource,
  runtime: ApplianceWasmRuntimeSource,
  options: Omit<RecipeApplianceExecutionOptions, "faultInjections"> & {
    espressoAppliance?: "linea" | "eagle-one";
    faultInjections?: ReadonlyMap<string, ApplianceFaultInjectionSpec>;
  } = {},
): Promise<RecipeApplianceExecutionReport> {
  return executeRecipeApplianceTasks(
    morningShiftApplianceTasks(source, options.espressoAppliance ?? "linea"),
    runtime,
    {
      runId: options.runId ?? "morning-shift-appliance-fault-restore",
      faultInjections:
        options.faultInjections ?? defaultMorningShiftFaultInjections(),
      scheduledTasks: options.scheduledTasks ?? extractScheduledTasks(source),
      ...options,
    },
  );
}
