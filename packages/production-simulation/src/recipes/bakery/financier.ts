import { canonicalJson, sha256Hex } from "@purin-labs/std";
export { compileFinancierPreparation } from "./financier-preparation.ts";
export {
  compileFinancierRecipe,
  financierRecipeInput,
} from "./financier-production.ts";
import type { StationId } from "@purin-labs/bakery-model/bakery";
import {
  productionTaskChoices,
  productionDefinitionFingerprint,
  type ProductionManualTask,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  authoredId,
  parseSha256Hex,
  type ResourceId,
  type Sha256Hex,
  type TaskKey,
} from "../../identity.ts";
import { normalizeQuantity } from "../../quantity.ts";
import { err, ok, type Result } from "../../result.ts";
import { parseNativeCell, type NativeCell } from "../../native/cell-adapter.ts";
import {
  bindFinancierCells,
  type NativeFinancierProblem,
} from "./financier-native.ts";
import type { ProductionWorkcells } from "./production-workcells.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CarrierStep,
  type CompiledScenario,
  type InstanceDependency,
  type InstanceTaskReference,
  type MaterialInput,
  type MaterialOutput,
  type PhysicalCellDefinition,
  type ResourceDefinition,
  type StorageDefinition,
  type TaskDefinition,
  type TaskExecutor,
  type TravelRoute,
  type WorkflowDefinition,
} from "../../scenario.ts";
import {
  durationFromSeconds,
  interval,
  timeFromSeconds,
  ZERO_DURATION,
} from "../../time.ts";
import {
  station,
  stations,
  resolveProductionRun,
  resolveSavedOvenFinancierRun,
  transferTiming,
  travelSeconds,
  type Batch,
  type HumanResource,
  type ResolvedRunInput,
  type FinancierRunInput,
  type ResolvedScheduleLayout,
  type ScheduleSpatialLayout,
} from "./schedule.ts";

const GROUP = authoredId("carrier-role", "tray-group");
const CONTENTS = authoredId("lot-key", "financiers");
const PORTIONS = authoredId("product", "financier-portions");
const FINANCIERS = authoredId("product", "financiers");
const PACKED = authoredId("destination", "packed-financiers");
const EMPTY_GROUPS = authoredId("storage", "empty-tray-groups");
const DISPATCH = authoredId("storage", "dispatch");
const INGREDIENTS = authoredId("storage", "rested-batter");
const OVEN = authoredId("resource", "oven");
const PROGRAM = authoredId("batch-program", "financier");
const OVEN_SOURCE = authoredId("storage", "oven-source");
const OVEN_RACK = authoredId("storage", "oven-rack");
const OVEN_STEPS = {
  "oven-load": {
    skill: authoredId("skill", "oven-loading"),
    from: OVEN_SOURCE,
    to: authoredId("storage", "bake"),
  },
  "oven-retrieve": {
    skill: authoredId("skill", "oven-retrieval"),
    from: authoredId("storage", "bake"),
    to: OVEN_SOURCE,
  },
  "oven-rack": {
    skill: authoredId("skill", "rack-transfer"),
    from: OVEN_SOURCE,
    to: OVEN_RACK,
  },
};

type RecipePhysics =
  | Readonly<{
      kind: "station";
      cells: ReadonlyMap<string, NativeCell>;
      cell?: never;
    }>
  | Readonly<{
      kind: "oven";
      cell: NativeCell;
      cells?: never;
    }>;

// Settings are already validated. These conversions check adapter programming
// errors; raw authoring values never enter this compiler.
function compiled<Value, Problem>(result: Result<Value, Problem>): Value {
  if (!result.ok)
    throw new Error(
      `Invalid compiled financier value: ${canonicalJson(result.error)}`,
    );
  return result.value;
}

function duration(seconds: number) {
  return compiled(durationFromSeconds(seconds));
}

function time(seconds: number) {
  return compiled(timeFromSeconds(seconds));
}

function count(amount: number) {
  return compiled(normalizeQuantity({ amount, scale: 0, unit: "each" }));
}

function worker(
  layout: ResolvedScheduleLayout | undefined,
  resource: HumanResource,
): ResourceDefinition {
  const initialLocation = authoredId("location", `${resource.id}-start`);
  const travel: TravelRoute[] = [];
  for (const destinationItem of stations) {
    const destination = station(destinationItem.id, layout);
    const to = authoredId("location", destination.id);
    travel.push({
      from: initialLocation,
      to,
      duration: duration(
        travelSeconds(resource.start, destination.handoff, layout),
      ),
      evidence: "assumed",
    });
    for (const originItem of stations) {
      if (originItem.id === destination.id) continue;
      const origin = station(originItem.id, layout);
      travel.push({
        from: authoredId("location", origin.id),
        to,
        duration: duration(
          travelSeconds(origin.handoff, destination.handoff, layout),
        ),
        evidence: "assumed",
      });
    }
  }
  return {
    kind: "worker",
    id: authoredId("resource", resource.id),
    capacity: 1,
    configuration: null,
    initialLocation,
    travel,
  };
}

function attended(
  input: ResolvedRunInput,
  from: StationId,
  to: StationId,
  seconds: number,
): TaskExecutor {
  const [first, ...rest] = input.resources;
  if (first === undefined) throw new Error("A financier recipe needs a worker");
  const workers: [ResourceId, ...ResourceId[]] = [resourceId(first)];
  for (const resource of rest) workers.push(resourceId(resource));
  return {
    kind: "attended",
    workers,
    start: authoredId("location", from),
    finish: authoredId("location", to),
    duration: duration(seconds),
    evidence: "assumed",
  };
}

function resourceId(resource: HumanResource) {
  return authoredId("resource", resource.id);
}

function physicalCell(cell: NativeCell): PhysicalCellDefinition {
  return {
    id: cell.cellId,
    modelHash: cell.modelHash,
    controllerSourceHash: cell.controllerSourceHash,
    timestepMicroseconds: 2000,
    carrierSlots: 1,
    holdModel:
      cell.fixture === "persistent-rack/1"
        ? authoredId("hold-model", "cold-cell-rest.1")
        : null,
  };
}

function move(
  from: StationId,
  to: StationId,
  pickup: number,
  placement: number,
): CarrierStep {
  return {
    kind: "move",
    role: GROUP,
    from: authoredId("storage", from),
    to: authoredId("storage", to),
    timing: {
      kind: "declared",
      pickupAfter: duration(pickup),
      placementAfter: duration(placement),
    },
  };
}

function recipeTransfer(
  physics: RecipePhysics,
  from: StationId,
  to: StationId,
  pickup: number,
  placement: number,
): CarrierStep {
  if (physics.kind === "station" || (from !== "bake" && to !== "bake"))
    return move(from, to, pickup, placement);
  // The existing attended transfers stage the source table and clear the rack.
  // Their worker assignments and authored task addresses remain available.
  return {
    kind: "move",
    role: GROUP,
    from: from === "bake" ? OVEN_RACK : authoredId("storage", from),
    to: to === "bake" ? OVEN_SOURCE : authoredId("storage", to),
    timing: {
      kind: "declared",
      pickupAfter: duration(pickup),
      placementAfter: duration(placement),
    },
  };
}

function ovenHandling(
  batch: Batch,
  cell: NativeCell,
  key: keyof typeof OVEN_STEPS,
  previous: TaskKey,
): TaskDefinition {
  const step = OVEN_STEPS[key];
  return task(
    batch,
    null,
    authoredId("task-key", key),
    previous,
    {
      kind: "native",
      operation: {
        cell: cell.cellId,
        skill: step.skill,
        parameters: cell.modelHash,
      },
    },
    [
      {
        kind: "move",
        role: GROUP,
        from: step.from,
        to: step.to,
        timing: { kind: "native" },
      },
    ],
    [],
    [],
  );
}

function task(
  batch: Batch,
  rule: ProductionManualTask | null,
  key: TaskKey,
  previous: TaskKey | null,
  executor: TaskExecutor,
  carriers: readonly CarrierStep[],
  inputs: readonly MaterialInput[],
  outputs: readonly MaterialOutput[],
): TaskDefinition {
  return {
    key,
    priority: batch.deadline,
    releaseAfter:
      rule === null
        ? ZERO_DURATION
        : duration(Math.max(0, rule.earliestStartSeconds - batch.release)),
    prerequisites: previous === null ? [] : [previous],
    claims: [],
    executor: assignedExecutor(executor, rule),
    inputs,
    outputs,
    releases: [],
    carriers,
  };
}

function assignedExecutor(
  executor: TaskExecutor,
  rule: ProductionManualTask | null,
): TaskExecutor {
  if (rule === null || rule.workerId === null) return executor;
  if (executor.kind !== "attended")
    throw new Error("Only attended tasks accept worker assignments");
  return {
    kind: "attended",
    workers: [authoredId("resource", rule.workerId)],
    start: executor.start,
    finish: executor.finish,
    duration: executor.duration,
    evidence: executor.evidence,
  };
}

function manualRule(
  input: ResolvedRunInput,
  id: string,
): ProductionManualTask | null {
  for (const rule of input.manualTasks)
    if (rule.bakeryTaskId === id) return rule;
  return null;
}

function taskAddresses(
  input: ResolvedRunInput,
  physics: RecipePhysics,
): ReadonlyMap<string, InstanceTaskReference> {
  const addresses = new Map<string, InstanceTaskReference>();
  for (const batch of input.batches) {
    let location: StationId | null = null;
    const source = authoredId("arrival-source", `batch-${batch.id}`);
    if (physics.kind === "oven")
      for (const key of ["oven-load", "oven-retrieve", "oven-rack"])
        addresses.set(`batch:${batch.id}:native:${key}`, {
          source,
          sequence: 0,
          key: authoredId("task-key", key),
        });
    for (const step of batch.steps) {
      if (step.kind === "process") {
        addresses.set(`batch:${batch.id}:process:${step.operation}`, {
          source,
          sequence: 0,
          key: authoredId("task-key", step.operation),
        });
      } else if (step.kind === "transfer" && location !== null) {
        addresses.set(
          `batch:${batch.id}:transfer:${location}:${step.station}`,
          {
            source,
            sequence: 0,
            key: authoredId("task-key", `transfer-${location}-${step.station}`),
          },
        );
      } else if (step.kind === "native" || step.kind === "handoff") {
        const suffix =
          step.kind === "native"
            ? `native:${step.operation.tray}`
            : `handoff:${step.operation.tray}-${step.phase}`;
        addresses.set(`batch:${batch.id}:${suffix}`, {
          source,
          sequence: 0,
          key: authoredId("task-key", suffix.replace(":", "-")),
        });
      } else
        throw new Error("The financier procedure contains an unsupported step");
      location = step.station;
    }
  }
  return addresses;
}

function dependencies(
  input: ResolvedRunInput,
  physics: RecipePhysics,
): readonly InstanceDependency[] {
  const addresses = taskAddresses(input, physics);
  const assignments: { batchId: string; tray: number }[] = [];
  const rules = [...input.manualTasks];
  for (const batch of input.batches) {
    for (const step of batch.steps) {
      if (step.kind !== "native") continue;
      const operation = step.operation;
      assignments.push({ batchId: batch.id, tray: operation.tray });
      rules.push({
        bakeryTaskId: `batch:${batch.id}:handoff:${operation.tray}-stage`,
        workerId: operation.workerId,
        earliestStartSeconds: operation.earliestStartSeconds,
        dependsOn: operation.dependsOn,
      });
    }
  }
  const fixed = new Map<string, readonly string[]>();
  for (const choice of productionTaskChoices(
    input.settings,
    assignments,
    physics.kind === "oven" ? "oven-rack" : "cold-racking",
  ))
    fixed.set(choice.id, choice.predecessors);
  const result: InstanceDependency[] = [];
  for (const rule of rules) {
    const task = addresses.get(rule.bakeryTaskId);
    if (task === undefined)
      throw new Error("An authored task has no compiled address");
    for (const id of rule.dependsOn) {
      const prerequisite = addresses.get(id);
      if (prerequisite === undefined)
        throw new Error("An authored prerequisite has no compiled address");
      // The authoring UI can repeat a fixed material-order edge. Keep it once.
      if (!fixed.get(rule.bakeryTaskId)?.includes(id))
        result.push({ task, prerequisite });
    }
  }
  return result;
}

function workflow(
  input: ResolvedRunInput,
  batch: ResolvedRunInput["batches"][number],
  revision: Sha256Hex,
  cells: ReadonlyMap<string, NativeCell>,
  physics: RecipePhysics,
): WorkflowDefinition {
  const tasks: TaskDefinition[] = [];
  let previous: TaskKey | null = null;
  let location: StationId | null = null;
  for (const step of batch.steps) {
    if (step.kind === "transfer") {
      if (location === null)
        throw new Error("A transfer needs a source station");
      const key = authoredId(
        "task-key",
        `transfer-${location}-${step.station}`,
      );
      const timing = transferTiming(
        input.settings,
        location,
        step.station,
        input.layout,
      );
      tasks.push(
        task(
          batch,
          manualRule(
            input,
            `batch:${batch.id}:transfer:${location}:${step.station}`,
          ),
          key,
          previous,
          attended(input, location, step.station, timing.duration),
          [
            recipeTransfer(
              physics,
              location,
              step.station,
              timing.pickupAfter,
              timing.duration,
            ),
          ],
          [],
          [],
        ),
      );
      previous = key;
      if (physics.kind === "oven" && step.station === "bake") {
        const load = ovenHandling(batch, physics.cell, "oven-load", previous);
        tasks.push(load);
        previous = load.key;
      }
      location = step.station;
      continue;
    }
    if (step.kind === "native" || step.kind === "handoff") {
      const operation = step.operation;
      const cell = cells.get(operation.attempt.input.bindings.cell);
      if (cell === undefined)
        throw new Error("A native step needs its bound cell");
      const bindings = operation.attempt.input.bindings;
      const source = authoredId("storage", bindings.source);
      const destination = authoredId("storage", bindings.destination);
      const cooling = authoredId("storage", "cool");
      const suffix =
        step.kind === "native"
          ? `native-${operation.tray}`
          : `handoff-${operation.tray}-${step.phase}`;
      const key = authoredId("task-key", suffix);
      let executor: TaskExecutor;
      let carrier: CarrierStep;
      let rule: ProductionManualTask | null = null;
      if (step.kind === "native") {
        executor = {
          kind: "native",
          operation: {
            cell: cell.cellId,
            skill: authoredId("skill", "rack-transfer"),
            parameters: cell.modelHash,
          },
        };
        carrier = {
          kind: "move",
          role: GROUP,
          from: source,
          to: destination,
          timing: { kind: "native" },
        };
      } else {
        if (step.phase === "transfer")
          throw new Error("This compiler has no inter-cell restaging route");
        const seconds = step.phase === "stage" ? 30 : 15;
        executor = attended(input, "cool", "cool", seconds);
        rule = {
          bakeryTaskId: `batch:${batch.id}:handoff:${operation.tray}-${step.phase}`,
          workerId: operation.workerId,
          dependsOn: [],
          earliestStartSeconds:
            step.phase === "stage" ? operation.earliestStartSeconds : 0,
        };
        carrier = {
          kind: "move",
          role: GROUP,
          from: step.phase === "stage" ? cooling : destination,
          to: step.phase === "stage" ? source : cooling,
          timing: {
            kind: "declared",
            pickupAfter: ZERO_DURATION,
            placementAfter: duration(seconds),
          },
        };
      }
      tasks.push(task(batch, rule, key, previous, executor, [carrier], [], []));
      previous = key;
      location = step.station;
      continue;
    }
    if (step.kind !== "process")
      throw new Error("The financier procedure contains a native step");
    const key = authoredId("task-key", step.operation);
    let executor: TaskExecutor;
    if (step.operation === "bake") {
      executor = {
        kind: "batch",
        resource: OVEN,
        program: PROGRAM,
        carrier: GROUP,
        load: authoredId(
          "task-key",
          physics.kind === "oven" ? "oven-load" : "transfer-portion-bake",
        ),
        unload: authoredId(
          "task-key",
          physics.kind === "oven" ? "oven-retrieve" : "transfer-bake-cool",
        ),
      };
    } else if (step.attended) {
      executor = attended(
        input,
        step.station,
        step.station,
        input.settings[step.operation] * 60,
      );
    } else {
      executor = {
        kind: "declared",
        duration: duration(input.settings[step.operation] * 60),
        evidence: "assumed",
      };
    }
    const carriers: CarrierStep[] = [];
    const inputs: MaterialInput[] = [];
    const outputs: MaterialOutput[] = [];
    if (step.operation === "stage") {
      carriers.push(
        { kind: "acquire", role: GROUP, from: EMPTY_GROUPS },
        {
          kind: "move",
          role: GROUP,
          from: EMPTY_GROUPS,
          to: authoredId("storage", "stage"),
          timing: {
            kind: "declared",
            pickupAfter: ZERO_DURATION,
            placementAfter: ZERO_DURATION,
          },
        },
      );
      inputs.push({
        kind: "pool",
        product: PORTIONS,
        quantity: count(batch.quantity),
      });
      outputs.push({
        kind: "lot",
        lot: CONTENTS,
        product: FINANCIERS,
        quantity: count(batch.quantity),
        holder: { kind: "carrier", carrier: GROUP },
        disposition: "released",
        report: null,
      });
    }
    if (step.operation === "pack") {
      // Mirrors the finite recipe's production boundary: completed groups leave
      // the packing station. This declares no empty-tray return route.
      const end = duration(input.settings.pack * 60);
      carriers.push(
        {
          kind: "move",
          role: GROUP,
          from: authoredId("storage", "pack"),
          to: DISPATCH,
          timing: { kind: "declared", pickupAfter: end, placementAfter: end },
        },
        { kind: "release", role: GROUP },
      );
      inputs.push({
        kind: "lot",
        lot: CONTENTS,
        quantity: count(batch.quantity),
      });
      outputs.push({
        kind: "exit",
        product: FINANCIERS,
        quantity: count(batch.quantity),
        destination: PACKED,
      });
    }
    tasks.push(
      task(
        batch,
        manualRule(input, `batch:${batch.id}:process:${step.operation}`),
        key,
        previous,
        executor,
        carriers,
        inputs,
        outputs,
      ),
    );
    previous = key;
    if (physics.kind === "oven" && step.operation === "bake") {
      const retrieve = ovenHandling(
        batch,
        physics.cell,
        "oven-retrieve",
        previous,
      );
      const rack = ovenHandling(batch, physics.cell, "oven-rack", retrieve.key);
      tasks.push(retrieve, rack);
      previous = rack.key;
    }
    location = step.station;
  }
  return {
    id: authoredId("workflow", `financier-${batch.id}`),
    revision,
    demand: "order",
    tasks,
  };
}

/** Compile the existing finite, declared financier recipe without running a scheduler. */
export async function compileFinancier(
  input: FinancierRunInput,
): Promise<CompiledScenario> {
  return compileRecipe(input, { kind: "station", cells: new Map() });
}

/** Compile supported authored native work without accepting recorded durations as physics. */
export async function compileProductionFinancier(
  plan: ProductionWorkcells,
  definitions: readonly unknown[],
  layout: ScheduleSpatialLayout | null,
): Promise<Result<CompiledScenario, NativeFinancierProblem>> {
  const cells = bindFinancierCells(plan, definitions);
  if (!cells.ok) return cells;
  return ok(
    await compileRecipe(resolveProductionRun(plan, layout), {
      kind: "station",
      cells: cells.value,
    }),
  );
}

/** Explicit full route: worker staging, native loading/retrieval/racking, cooling, packing. */
export async function compileOvenFinancier(
  input: FinancierRunInput,
  definition: unknown,
): Promise<Result<CompiledScenario, NativeFinancierProblem>> {
  if (input.settings.traysPerBatch !== 1 || input.settings.ovenTrays !== 1)
    return err({
      code: "unsupported_recipe",
      subject:
        "The oven-rack fixture holds one tray; use one tray per batch and one oven tray",
    });
  const cell = parseNativeCell(definition);
  if (!cell.ok) return err({ code: "incompatible_cell", subject: cell.error });
  if (cell.value.fixture !== "persistent-oven-rack/1")
    return err({
      code: "incompatible_cell",
      subject: "The full route requires the persistent oven-rack fixture",
    });
  return ok(await compileRecipe(input, { kind: "oven", cell: cell.value }));
}

/** Reopen the pinned route from shared authoring without replacing its fixture. */
export async function compileSavedOvenFinancier(
  definition: VariantBy<ProductionScenario, "route", "oven-rack">,
): Promise<Result<CompiledScenario, NativeFinancierProblem>> {
  const fingerprint = await productionDefinitionFingerprint(
    definition.sourceFingerprint,
    definition.settings,
    definition.variant,
    definition.assignments,
    definition.manualTasks,
    definition,
  );
  if (fingerprint !== definition.definitionFingerprint)
    return err({
      code: "invalid_definition",
      subject:
        "The saved recipe or pinned cell differs from its definition fingerprint",
    });
  return compileOvenFinancier(
    resolveSavedOvenFinancierRun(definition),
    definition.cell,
  );
}

async function compileRecipe(
  input: ResolvedRunInput,
  physics: RecipePhysics,
): Promise<CompiledScenario> {
  const cells =
    physics.kind === "oven"
      ? new Map([[physics.cell.cellId, physics.cell]])
      : physics.cells;
  const { settings, variant } = input;
  const revision = compiled(
    parseSha256Hex(
      await sha256Hex(
        canonicalJson({
          input,
          stations,
          route: physics.kind,
          cells: [...cells.values()],
        }),
      ),
    ),
  );
  const total = count(
    settings.batchCount * settings.traysPerBatch * settings.piecesPerTray,
  );
  const storages: StorageDefinition[] = [
    {
      id: EMPTY_GROUPS,
      capacity: { kind: "carriers", slots: settings.batchCount },
      cell: null,
    },
    {
      id: DISPATCH,
      capacity: { kind: "carriers", slots: settings.batchCount },
      cell: null,
    },
    {
      id: INGREDIENTS,
      capacity: { kind: "material", product: PORTIONS, quantity: total },
      cell: null,
    },
  ];
  // The authored recipe handles a whole batch together. One logical carrier
  // represents its tray group; unused capacity cannot admit part of a batch.
  for (const resource of input.stationResources) {
    storages.push({
      id: authoredId("storage", resource.id),
      capacity: {
        kind: "carriers",
        slots:
          resource.unit === "trays"
            ? Math.floor(resource.capacity / settings.traysPerBatch)
            : resource.capacity,
      },
      cell:
        physics.kind === "oven" && resource.id === "bake"
          ? physics.cell.cellId
          : null,
    });
  }
  const resources: ResourceDefinition[] = input.resources.map(
    worker.bind(null, input.layout),
  );
  if (physics.kind === "oven") {
    for (const id of [OVEN_SOURCE, OVEN_RACK])
      storages.push({
        id,
        capacity: { kind: "carriers", slots: 1 },
        cell: physics.cell.cellId,
      });
  }
  const nativeStorages = new Map<string, StorageDefinition>();
  for (const batch of input.batches) {
    for (const step of batch.steps) {
      if (step.kind !== "native") continue;
      const bindings = step.operation.attempt.input.bindings;
      const cell = cells.get(bindings.cell);
      if (cell === undefined)
        throw new Error("A native storage needs its bound cell");
      for (const id of [bindings.source, bindings.destination]) {
        nativeStorages.set(id, {
          id: authoredId("storage", id),
          capacity: { kind: "carriers", slots: 1 },
          cell: cell.cellId,
        });
      }
    }
  }
  storages.push(...nativeStorages.values());
  // Recovery removes rejected trays to this local shelf before cell reuse.
  if (cells.size > 0)
    storages.push({
      id: authoredId("storage", "rejected-tray-groups"),
      capacity: { kind: "carriers", slots: settings.batchCount },
      cell: null,
    });
  resources.push({
    kind: "batch",
    id: OVEN,
    capacity: Math.floor(settings.ovenTrays / settings.traysPerBatch),
    configuration: null,
    storage: authoredId("storage", "bake"),
    loadWindow: duration(settings.loadWindow * 60),
    programs: [
      {
        id: PROGRAM,
        duration: duration(settings.bake * 60),
        evidence: "assumed",
      },
    ],
  });
  const workflows: WorkflowDefinition[] = [];
  const arrivals: CompiledScenario["arrivals"][number][] = [];
  const carriers: CompiledScenario["carriers"][number][] = [];
  for (const batch of input.batches) {
    const definition = workflow(input, batch, revision, cells, physics);
    workflows.push(definition);
    arrivals.push({
      id: authoredId("arrival-source", `batch-${batch.id}`),
      workflow: definition.id,
      kind: "explicit",
      arrivals: [{ time: time(batch.release), quantity: 1 }],
    });
    carriers.push({
      id: authoredId("carrier", `tray-group-${batch.id}`),
      storage: EMPTY_GROUPS,
    });
  }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: authoredId("scenario", "financier"),
    policy: DISPATCH_POLICY,
    sources: [
      {
        id: authoredId("source", "financier-recipe"),
        revision: 1,
        digest: revision,
      },
    ],
    limits: {
      horizon: time(settings.horizonMinutes * 60),
      eventCap: MAX_EVENT_CAP,
    },
    products: [
      { id: PORTIONS, unit: "each" },
      { id: FINANCIERS, unit: "each" },
    ],
    destinations: [
      { id: PACKED, role: "final-output", product: FINANCIERS },
      ...(cells.size > 0
        ? [
            {
              id: authoredId("destination", "rejected-financiers"),
              role: "rejected-output" as const,
              product: FINANCIERS,
            },
          ]
        : []),
    ],
    resources,
    storages,
    carriers,
    cells: [...cells.values()].map(physicalCell),
    stock: [
      {
        id: authoredId("lot", "rested-batter"),
        product: PORTIONS,
        quantity: total,
        storage: INGREDIENTS,
      },
    ],
    workflows,
    arrivals,
    dependencies: dependencies(input, physics),
    availability:
      variant === "normal"
        ? []
        : [
            {
              id: authoredId("availability", "oven-outage"),
              resource: OVEN,
              interval: compiled(
                interval(
                  time(settings.outageStart * 60),
                  time(settings.outageEnd * 60),
                ),
              ),
            },
          ],
  };
}

import { FINANCIER_MIX_INS } from "./financier-flavours.ts";
import type { ApplianceTaskRow } from "./appliance-execution.ts";

const FINANCIER_WORKFLOWS = {
  exact: [
    "batter-preparation",
    "financier-preheat",
    "financier-batch",
    "financier",
  ],
  prefixes: ["load-", "batch-"],
  suffixes: ["financier-preparation"],
} as const;

/** Declarative MuJoCo appliance task rows for financier recipes. */
export const FINANCIER_APPLIANCE_ROWS: readonly ApplianceTaskRow[] = [
  {
    recipe: "financier",
    taskKind: "weigh",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["weigh-black-sesame-paste"], stripTrayPrefix: true },
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.01,
      temperatureC: 20,
      specificHeat: 2400,
      densityKgL: 1.1,
      resistance: 0.1,
    },
    action: { kind: "weigh" },
  },
  {
    recipe: "financier",
    taskKind: "weigh",
    workflows: FINANCIER_WORKFLOWS,
    keys: {
      exact: FINANCIER_MIX_INS.filter((m) => m !== "black-sesame-paste").map(
        (m) => `weigh-${m}`,
      ),
      stripTrayPrefix: true,
    },
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.01,
      temperatureC: 20,
      specificHeat: 1600,
      densityKgL: 0.55,
      resistance: 0.1,
    },
    action: { kind: "weigh" },
  },
  {
    recipe: "financier",
    taskKind: "weigh",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["weigh"], stripTrayPrefix: true },
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "Weigh financier ingredients",
    productSource: "financier",
    batch: {
      idSuffix: "ingredients",
      massKg: 0.375,
      temperatureC: 20,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.1,
    },
    action: { kind: "weigh" },
  },
  ...(
    [
      ["weigh-butter", 0.11],
      ["weigh-egg-white", 0.12],
      ["weigh-icing-sugar", 0.09],
      ["weigh-almond-powder", 0.05],
      ["weigh-flour", 0.04],
      ["weigh-honey", 0.015],
      ["dose", 0.184],
    ] as const
  ).map(([key, massKg]): ApplianceTaskRow => ({
    recipe: "financier",
    taskKind: "weigh",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: [key], stripTrayPrefix: true },
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg,
      temperatureC: 20,
      specificHeat: 2800,
      densityKgL: 1.02,
      resistance: 0.15,
    },
    action: { kind: "weigh" },
  })),
  {
    recipe: "financier",
    taskKind: "weigh",
    workflows: FINANCIER_WORKFLOWS,
    keys: { prefixes: ["fill-cavity-"], stripTrayPrefix: true },
    category: "weigh",
    appliance: "ohaus-ranger-3000",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.023,
      temperatureC: 16,
      specificHeat: 2800,
      densityKgL: 1.02,
      resistance: 0.15,
    },
    action: { kind: "weigh" },
  },
  {
    recipe: "financier",
    taskKind: "hob-power",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["brown-butter"], stripTrayPrefix: true },
    category: "hob",
    appliance: "maruzen-mih-02c",
    label: "Brown {productLower} butter on induction hob",
    productSource: "financier",
    batch: {
      idSuffix: "brown-butter",
      massKg: 0.11,
      temperatureC: 20,
      specificHeat: 2700,
      densityKgL: 0.96,
      resistance: 0.08,
    },
    action: { kind: "hob-power", percent: 55, durationSeconds: 5 },
  },
  {
    recipe: "financier",
    taskKind: "chiller",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["cool-butter"], stripTrayPrefix: true },
    category: "chiller",
    appliance: "hoshizaki-rt-120snj",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.092,
      temperatureC: 45,
      specificHeat: 3000,
      densityKgL: 1.05,
      resistance: 0.25,
    },
    action: { kind: "chiller", durationSeconds: 6 },
  },
  {
    recipe: "financier",
    taskKind: "chiller",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["store-batter"], stripTrayPrefix: true },
    category: "chiller",
    appliance: "hoshizaki-rt-120snj",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.375,
      temperatureC: 24,
      specificHeat: 3000,
      densityKgL: 1.05,
      resistance: 0.25,
    },
    action: { kind: "chiller", durationSeconds: 6 },
  },
  {
    recipe: "financier",
    taskKind: "planetary-mix",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["mix-dry"], stripTrayPrefix: true },
    category: "mixer",
    appliance: "hobart-hl200",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.18,
      temperatureC: 20,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.35,
    },
    action: { kind: "planetary-mix", setting: 1, durationSeconds: 4 },
  },
  {
    recipe: "financier",
    taskKind: "planetary-mix",
    workflows: FINANCIER_WORKFLOWS,
    keys: {
      exact: ["incorporate-egg-white-and-honey"],
      stripTrayPrefix: true,
    },
    category: "mixer",
    appliance: "hobart-hl200",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.315,
      temperatureC: 20,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.35,
    },
    action: { kind: "planetary-mix", setting: 2, durationSeconds: 4 },
  },
  {
    recipe: "financier",
    taskKind: "planetary-mix",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["incorporate-brown-butter"], stripTrayPrefix: true },
    category: "mixer",
    appliance: "hobart-hl200",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.375,
      temperatureC: 26,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.35,
    },
    action: { kind: "planetary-mix", setting: 2, durationSeconds: 4 },
  },
  {
    recipe: "financier",
    taskKind: "planetary-mix",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["mix"], stripTrayPrefix: true },
    category: "mixer",
    appliance: "hobart-hl200",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.375,
      temperatureC: 20,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.35,
    },
    action: { kind: "planetary-mix", setting: 2, durationSeconds: 4 },
  },
  {
    recipe: "financier",
    taskKind: "oven-preheat",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["preheat", "preheat-oven"], stripTrayPrefix: true },
    category: "oven",
    appliance: "maruzen-mbco-5e",
    label: "Preheat convection oven for financier",
    productSource: "financier",
    batch: null,
    action: { kind: "oven-preheat", targetC: 55 },
  },
  {
    recipe: "financier",
    taskKind: "oven-bake",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["bake"], stripTrayPrefix: true },
    category: "oven",
    appliance: "maruzen-mbco-5e",
    label: "Bake {productLower} tray in convection oven",
    productSource: "financier",
    batch: {
      idSuffix: "bake-tray",
      massKg: 0.184,
      temperatureC: 18,
      specificHeat: 3100,
      densityKgL: 1.08,
      resistance: 0.35,
    },
    action: { kind: "oven-bake", targetC: 55, durationSeconds: 12 },
  },
  {
    recipe: "financier",
    taskKind: "dishwasher",
    workflows: FINANCIER_WORKFLOWS,
    keys: { exact: ["clean-mould"], stripTrayPrefix: true },
    category: "dishwasher",
    appliance: "winterhalter-uc-l",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.32,
      massSource: "fixed",
      temperatureC: 26,
      specificHeat: 1000,
      densityKgL: 1.18,
      resistance: 0.02,
    },
    action: { kind: "dishwasher", durationSeconds: 6 },
  },
  {
    recipe: "financier",
    taskKind: "dishwasher",
    workflows: FINANCIER_WORKFLOWS,
    keys: {
      exact: ["clean", "clean-preparation-vessels"],
      stripTrayPrefix: true,
    },
    category: "dishwasher",
    appliance: "winterhalter-uc-l",
    label: "{product} {key}",
    productSource: "financier",
    batch: {
      massKg: 0.45,
      massSource: "fixed",
      temperatureC: 26,
      specificHeat: 1000,
      densityKgL: 1.18,
      resistance: 0.02,
    },
    action: { kind: "dishwasher", durationSeconds: 6 },
  },
];
