import { assertNever, canonicalJson, sha256Hex } from "@seams/std";
import * as d from "../../document-values.ts";
import {
  authoredId,
  type CarrierRole,
  type LotKey,
  type ResourceId,
  type StorageId,
  type TaskKey,
} from "../../identity.ts";
import {
  addQuantity,
  normalizeQuantity,
  zeroQuantity,
  type MaterialQuantity,
} from "../../quantity.ts";
import { err, ok, type Result } from "../../result.ts";
import type {
  CarrierStep,
  CompiledScenario,
  InstanceDependency,
  LotHolder,
  MaterialInput,
  MaterialOutput,
  TaskDefinition,
  TaskExecutor,
  WorkflowDefinition,
} from "../../scenario.ts";
import {
  ZERO_DURATION,
  ZERO_TIME,
  durationFromSeconds,
  timeFromSeconds,
} from "../../time.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "./financier-production.ts";
import {
  financierLoadId,
  financierPreparationWorkflow,
  preparedFinancierBatter,
} from "./financier-flavours.ts";

/** The four operator inputs. Demand, recipe and durations stay fixed. */
export type RecurringFinancierInput = Readonly<{
  arrivalMinutes: number;
  workers: number;
  trays: number;
  coolingPositions: number;
}>;

/** Each batch is one batter preparation baked as three eight-cavity trays. */
export const RECURRING_FINANCIER_BATCHES = 8;
export const RECURRING_FINANCIER_TRAYS_PER_BATCH = 3;
export const RECURRING_FINANCIER_LIMITS = {
  arrivalMinutes: { min: 15, max: 180 },
  workers: { min: 1, max: 3 },
  trays: { min: 1, max: 6 },
  coolingPositions: { min: 1, max: 6 },
} as const;

const BATCH = authoredId("workflow", "financier-batch");
const BATCHES = authoredId("arrival-source", "financier-batches");
const PREHEAT = authoredId("arrival-source", "financier-preheat");
const TRAY_STORE = authoredId("storage", "clean-trays");
const LEFTOVER = authoredId("destination", "unused-batter");
// The recurring line bakes the hazelnut financier.
const FLAVOUR = "hazelnut";
const BATTER = authoredId("product", preparedFinancierBatter(FLAVOUR));
const PREP = authoredId("location", "prep");

export type RecurringFinancierProblem = Readonly<{
  code: "invalid_recurring_financier";
}>;

function readInput(raw: unknown): RecurringFinancierInput {
  const r = d.record(raw, [
    "arrivalMinutes",
    "workers",
    "trays",
    "coolingPositions",
  ]);
  const input = {
    arrivalMinutes: d.positive(r.arrivalMinutes),
    workers: d.positive(r.workers),
    trays: d.positive(r.trays),
    coolingPositions: d.positive(r.coolingPositions),
  };
  for (const key of Object.keys(RECURRING_FINANCIER_LIMITS) as Array<
    keyof RecurringFinancierInput
  >)
    d.requireValue(
      input[key] >= RECURRING_FINANCIER_LIMITS[key].min &&
        input[key] <= RECURRING_FINANCIER_LIMITS[key].max,
    );
  return input;
}

/** One tray's keys, lots and carrier roles live under its own prefix. */
type Tray = Readonly<{
  prefix: string;
  workers: readonly [ResourceId, ...ResourceId[]];
  /** Operator gates and the tasks each one waited on. */
  gates: ReadonlyMap<string, readonly TaskKey[]>;
}>;

function trayKey(tray: Tray, key: string): TaskKey {
  return authoredId("task-key", `${tray.prefix}${key}`);
}
function trayLot(tray: Tray, key: LotKey): LotKey {
  return authoredId("lot-key", `${tray.prefix}${key}`);
}
function trayRole(tray: Tray, role: CarrierRole): CarrierRole {
  return authoredId("carrier-role", `${tray.prefix}${role}`);
}
// Each authored mould had its own home. Recurring trays share one store.
function trayStorage(storage: StorageId): StorageId {
  return storage.startsWith("clean-mould-") ? TRAY_STORE : storage;
}
function shared(
  executor: TaskExecutor,
  workers: readonly [ResourceId, ...ResourceId[]],
): TaskExecutor {
  return executor.kind === "attended" ? { ...executor, workers } : executor;
}
function trayHolder(tray: Tray, holder: LotHolder): LotHolder {
  return holder.kind === "carrier"
    ? { kind: "carrier", carrier: trayRole(tray, holder.carrier) }
    : holder;
}
function trayInput(tray: Tray, input: MaterialInput): MaterialInput {
  return input.kind === "lot"
    ? { kind: "lot", lot: trayLot(tray, input.lot), quantity: input.quantity }
    : input;
}
// Without operator review, a held lot is released where the gate stood and
// the packed output leaves as accepted product.
function trayOutput(tray: Tray, output: MaterialOutput): MaterialOutput {
  switch (output.kind) {
    case "lot":
      return {
        ...output,
        lot: trayLot(tray, output.lot),
        holder: trayHolder(tray, output.holder),
        disposition: "released",
      };
    case "inspection-exit":
      return {
        kind: "exit",
        product: output.product,
        quantity: output.quantity,
        destination: output.destination,
      };
    case "exit":
      return output;
    case "measured-lot":
      return {
        ...output,
        lot: trayLot(tray, output.lot),
        holder: trayHolder(tray, output.holder),
      };
    case "measured-exit":
      return output;
    default:
      return assertNever(output);
  }
}
function trayCarrier(tray: Tray, step: CarrierStep): CarrierStep {
  switch (step.kind) {
    case "acquire":
      return {
        kind: "acquire",
        role: trayRole(tray, step.role),
        from: trayStorage(step.from),
      };
    case "move":
      return {
        kind: "move",
        role: trayRole(tray, step.role),
        from: trayStorage(step.from),
        to: trayStorage(step.to),
        timing: step.timing,
      };
    case "release":
      return { kind: "release", role: trayRole(tray, step.role) };
    default:
      return assertNever(step);
  }
}
function trayPrerequisites(
  tray: Tray,
  keys: readonly TaskKey[],
): readonly TaskKey[] {
  // A tray starts once its batch's batter is stored.
  if (keys.length === 0) return [authoredId("task-key", "store-batter")];
  const mapped: TaskKey[] = [];
  for (const key of keys)
    for (const resolved of tray.gates.get(key) ?? [key])
      mapped.push(trayKey(tray, resolved));
  return mapped;
}
function trayTasks(tray: Tray, load: WorkflowDefinition): TaskDefinition[] {
  const tasks: TaskDefinition[] = [];
  for (const task of load.tasks) {
    if (task.executor.kind === "inspection") continue;
    tasks.push({
      key: trayKey(tray, task.key),
      priority: task.priority,
      releaseAfter: task.releaseAfter,
      prerequisites: trayPrerequisites(tray, task.prerequisites),
      claims: task.claims,
      executor: shared(task.executor, tray.workers),
      inputs: task.inputs.map(trayInput.bind(null, tray)),
      outputs: task.outputs.map(trayOutput.bind(null, tray)),
      releases: [],
      carriers: task.carriers.map(trayCarrier.bind(null, tray)),
    });
  }
  return tasks;
}
function gatesOf(load: WorkflowDefinition): Map<string, readonly TaskKey[]> {
  const gates = new Map<string, readonly TaskKey[]>();
  for (const task of load.tasks)
    if (task.executor.kind === "inspection")
      gates.set(task.key, task.prerequisites);
  return gates;
}

function scaled<T extends Readonly<{ quantity: MaterialQuantity }>>(
  item: T,
  factor: number,
): T {
  let quantity = zeroQuantity(item.quantity.unit);
  for (let copy = 0; copy < factor; copy++)
    quantity = d.value(addQuantity(quantity, item.quantity));
  return { ...item, quantity };
}

function workflow(scenario: CompiledScenario, id: string): WorkflowDefinition {
  for (const entry of scenario.workflows) if (entry.id === id) return entry;
  throw new d.InvalidDocument("Missing financier workflow");
}

/**
 * Repeats the existing financier recipe as recurring batches through one
 * bakery: one batter preparation, three trays baked one at a time, in-mould
 * cooling, rack cooling, packing, then tray and grid return. Operator gates
 * become declared acceptance so a shift can run without stopping.
 */
export async function compileRecurringFinancier(
  raw: unknown,
): Promise<Result<CompiledScenario, RecurringFinancierProblem>> {
  try {
    const input = readInput(raw);
    const recipe = await compileFinancierRecipe(
      financierRecipeInput(
        RECURRING_FINANCIER_TRAYS_PER_BATCH,
        input.coolingPositions,
        900,
      ),
    );
    d.requireValue(recipe.ok);
    const base = recipe.value;
    const crew: [ResourceId, ...ResourceId[]] = [
      authoredId("resource", "baker-1"),
    ];
    for (let worker = 2; worker <= input.workers; worker++)
      crew.push(authoredId("resource", `baker-${worker}`));

    const preparation = workflow(base, financierPreparationWorkflow(FLAVOUR));
    const tasks: TaskDefinition[] = [];
    for (const task of preparation.tasks)
      tasks.push({ ...task, executor: shared(task.executor, crew) });
    let batter = 0;
    for (const task of preparation.tasks)
      for (const output of task.outputs)
        if (output.kind === "lot" && output.product === BATTER)
          batter += output.quantity.amount;
    let filled = 0;
    const lastFills: TaskKey[] = [];
    for (let index = 0; index < RECURRING_FINANCIER_TRAYS_PER_BATCH; index++) {
      const load = workflow(base, financierLoadId(FLAVOUR, index));
      const tray: Tray = {
        prefix: `tray-${index + 1}.`,
        workers: crew,
        gates: gatesOf(load),
      };
      const route = trayTasks(tray, load);
      let last: TaskKey | null = null;
      for (const task of route)
        for (const used of task.inputs)
          if (used.kind === "pool" && used.product === BATTER) {
            filled += used.quantity.amount;
            last = task.key;
          }
      d.requireValue(last !== null);
      lastFills.push(last);
      tasks.push(...route);
    }
    const leftover = batter - filled;
    d.requireValue(leftover >= 0);
    // Three trays use 600 g of the 745 g hazelnut batch. The rest is discarded
    // after the last fill, so no batch draws on another batch's batter.
    if (leftover > 0) {
      const quantity = d.value(
        normalizeQuantity({ amount: leftover, scale: 3, unit: "gram" }),
      );
      tasks.push({
        key: authoredId("task-key", "discard-batter"),
        priority: 0,
        releaseAfter: ZERO_DURATION,
        prerequisites: lastFills,
        claims: [],
        executor: {
          kind: "attended",
          duration: d.value(durationFromSeconds(10)),
          evidence: "assumed",
          workers: crew,
          start: PREP,
          finish: PREP,
        },
        inputs: [{ kind: "pool", product: BATTER, quantity }],
        outputs: [
          { kind: "exit", product: BATTER, quantity, destination: LEFTOVER },
        ],
        releases: [],
        carriers: [],
      });
    }

    const resources: CompiledScenario["resources"][number][] = [];
    for (const resource of base.resources) {
      if (resource.kind !== "worker") {
        resources.push(resource);
        continue;
      }
      for (const id of crew) resources.push({ ...resource, id });
    }
    const storages: CompiledScenario["storages"][number][] = [];
    for (const storage of base.storages) {
      if (storage.id.startsWith("clean-mould-")) continue;
      if (storage.id === "filled-moulds")
        storages.push({
          ...storage,
          capacity: { kind: "carriers", slots: input.trays },
        });
      else if (
        storage.capacity.kind === "material" &&
        storage.id.endsWith("-stock")
      )
        storages.push({
          ...storage,
          capacity: {
            kind: "material",
            product: storage.capacity.product,
            quantity: scaled(storage.capacity, RECURRING_FINANCIER_BATCHES)
              .quantity,
          },
        });
      else storages.push(storage);
    }
    storages.push({
      id: TRAY_STORE,
      capacity: { kind: "carriers", slots: input.trays },
      cell: null,
    });
    const carriers: CompiledScenario["carriers"][number][] = [];
    for (const carrier of base.carriers)
      if (!carrier.id.startsWith("mould-")) carriers.push(carrier);
    for (let tray = 1; tray <= input.trays; tray++)
      carriers.push({
        id: authoredId("carrier", `tray-${tray}`),
        storage: TRAY_STORE,
      });

    const stock: CompiledScenario["stock"][number][] = [];
    for (const lot of base.stock)
      stock.push(scaled(lot, RECURRING_FINANCIER_BATCHES));
    const revision = d.digest(
      await sha256Hex(
        canonicalJson({
          recipe: base.sources,
          input,
          batches: RECURRING_FINANCIER_BATCHES,
          tasks,
        }),
      ),
    );
    const dependencies: InstanceDependency[] = [];
    for (let sequence = 0; sequence < RECURRING_FINANCIER_BATCHES; sequence++)
      for (let tray = 1; tray <= RECURRING_FINANCIER_TRAYS_PER_BATCH; tray++)
        dependencies.push({
          task: {
            source: BATCHES,
            sequence,
            key: authoredId("task-key", `tray-${tray}.load-oven`),
          },
          prerequisite: {
            source: PREHEAT,
            sequence: 0,
            key: authoredId("task-key", "preheat"),
          },
        });
    return ok({
      schemaVersion: base.schemaVersion,
      id: authoredId("scenario", "recurring-financier"),
      policy: base.policy,
      sources: [
        ...base.sources,
        {
          id: authoredId("source", "recurring-financier-inputs"),
          revision: 1,
          digest: revision,
        },
      ],
      limits: {
        horizon: d.value(timeFromSeconds(24 * 3600)),
        eventCap: base.limits.eventCap,
      },
      products: base.products,
      destinations: [
        ...base.destinations,
        { id: LEFTOVER, product: BATTER, role: "loss" },
      ],
      resources,
      storages,
      stock,
      carriers,
      cells: [],
      workflows: [
        workflow(base, "financier-preheat"),
        { id: BATCH, revision, demand: "order", tasks },
      ],
      arrivals: [
        {
          id: PREHEAT,
          kind: "explicit",
          workflow: authoredId("workflow", "financier-preheat"),
          arrivals: [{ time: ZERO_TIME, quantity: 1 }],
        },
        {
          id: BATCHES,
          kind: "periodic",
          workflow: BATCH,
          first: ZERO_TIME,
          interval: d.value(durationFromSeconds(input.arrivalMinutes * 60)),
          limit: { kind: "count", count: RECURRING_FINANCIER_BATCHES },
        },
      ],
      dependencies,
      availability: [],
    });
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_recurring_financier" });
    throw error;
  }
}
