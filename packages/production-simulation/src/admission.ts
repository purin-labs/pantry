import {
  canonicalJson,
  isNonNegativeInteger,
  isPositiveInteger,
  sha256Hex,
} from "@seams/std";
import type { Variant, VariantBy } from "@seams/type-utils";
import { checkBatches } from "./batch-admission.ts";
import { executionWork, outputCeiling } from "./scenario.ts";
import { checkDependencies } from "./dependencies.ts";
import {
  parseSha256Hex,
  type CarrierRole,
  type CellId,
  type ConfigurationId,
  type DestinationId,
  type IdKind,
  type LotKey,
  type LocationId,
  type ProductId,
  type ResourceId,
  type Sha256Hex,
  type StorageId,
  type TaskKey,
  type WorkflowId,
} from "./identity.ts";
import type { MaterialUnit } from "./quantity.ts";
import { err, ok, type Result } from "./result.ts";
import {
  DISPATCH_POLICY,
  MAX_EVENT_CAP,
  SCENARIO_SCHEMA_VERSION,
  type CompiledScenario,
  type MaterialOutput,
  type ResourceClaim,
  type ResourceDefinition,
  type StorageDefinition,
  type MoveTiming,
  type TaskDefinition,
  type WorkflowDefinition,
} from "./scenario.ts";

declare const admittedBrand: unique symbol;

/** A scenario the engine may execute, with the digest its run pins. */
export type AdmittedScenario = Readonly<{
  scenario: CompiledScenario;
  digest: Sha256Hex;
}> & { readonly [admittedBrand]: "AdmittedScenario" };

/** `where` locates a problem for diagnostics. It never selects behavior. */
export type AdmissionProblem = Readonly<{ where: string }> &
  (
    | Readonly<{
        code: "invalid_dependency";
        reason: "reference" | "duplicate" | "cycle";
      }>
    | Readonly<{
        code: "invalid_batch";
        reason: "storage" | "program" | "route" | "task" | "claim";
      }>
    | Readonly<{ code: "invalid_inspection" }>
    | Readonly<{ code: "empty_worker_selection" }>
    | Readonly<{
        code: "invalid_worker";
        resource: ResourceId;
        reason: "not_worker" | "claimed_as_capacity";
      }>
    | Readonly<{
        code: "invalid_worker_route";
        resource: ResourceId;
        from: LocationId;
        to: LocationId;
        reason: "missing" | "duplicate" | "same_location";
      }>
    | Readonly<{
        code: "unsupported_scenario";
        field: "schemaVersion" | "policy";
      }>
    | Readonly<{ code: "duplicate_identity"; kind: IdKind; id: string }>
    | Readonly<{ code: "unknown_reference"; kind: IdKind; id: string }>
    | Readonly<{
        code: "invalid_number";
        field:
          | "capacity"
          | "units"
          | "priority"
          | "slots"
          | "quantity"
          | "count"
          | "eventCap"
          | "horizon"
          | "revision"
          | "interval";
        value: number;
      }>
    | Readonly<{
        code: "claim_exceeds_capacity";
        resource: ResourceId;
        units: number;
        capacity: number;
      }>
    | Readonly<{
        code: "unit_mismatch";
        product: ProductId;
        expected: MaterialUnit;
        actual: MaterialUnit;
      }>
    | Readonly<{
        code: "invalid_configuration";
        resource: ResourceId;
        configuration: ConfigurationId;
        reason: "resource_has_no_configuration" | "unreachable" | "no_change";
      }>
    | Readonly<{ code: "empty_workflow"; workflow: WorkflowId }>
    | Readonly<{
        code: "cyclic_tasks";
        workflow: WorkflowId;
        tasks: readonly TaskKey[];
      }>
    | Readonly<{ code: "cyclic_material"; products: readonly ProductId[] }>
    | Readonly<{
        code: "invalid_carrier_route";
        role: CarrierRole;
        reason:
          | "not_acquired"
          | "already_acquired"
          | "wrong_source"
          | "unordered"
          | "not_released"
          | "not_carrier_storage"
          | "timing_differs_from_executor"
          | "pickup_after_placement"
          | "placement_after_completion"
          | "outside_native_cell";
      }>
    | Readonly<{
        code: "invalid_lot";
        lot: LotKey;
        reason:
          | "not_produced_before"
          | "not_held"
          | "released_twice"
          | "over_consumed"
          | "holder_rejects_product";
      }>
    | Readonly<{
        code: "invalid_report";
        destination: DestinationId;
        reason: "role" | "product";
      }>
    | Readonly<{
        code: "unsupported_storage";
        storage: StorageId;
        reason:
          | "material_inside_cell"
          | "holds_no_carriers"
          | "holds_another_product";
      }>
    | Readonly<{
        code: "storage_overfilled";
        storage: StorageId;
        reason: "carriers" | "material" | "cell_slots";
      }>
    | Readonly<{ code: "cell_without_storage"; cell: CellId }>
    | Readonly<{
        code: "invalid_measurement";
        reason: "not_native" | "partial" | "duplicate" | "unit";
      }>
    | Readonly<{ code: "invalid_arrivals"; reason: "empty" | "unordered" }>
  );

type Index<Key extends string, Value> = ReadonlyMap<Key, Value>;

/**
 * Validates a compiled scenario before any run pins it. Unsupported routes,
 * capacities and references fail here, with every problem reported together.
 */
export async function admitScenario(
  scenario: CompiledScenario,
): Promise<Result<AdmittedScenario, readonly AdmissionProblem[]>> {
  const problems: AdmissionProblem[] = [];
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION)
    problems.push({
      code: "unsupported_scenario",
      field: "schemaVersion",
      where: "scenario",
    });
  if (scenario.policy !== DISPATCH_POLICY)
    problems.push({
      code: "unsupported_scenario",
      field: "policy",
      where: "scenario",
    });

  const products = index("product", scenario.products, problems);
  const destinations = index("destination", scenario.destinations, problems);
  const resources = index("resource", scenario.resources, problems);
  const storages = index("storage", scenario.storages, problems);
  const cells = index("cell", scenario.cells, problems);
  const workflows = index("workflow", scenario.workflows, problems);
  index("carrier", scenario.carriers, problems);
  index("lot", scenario.stock, problems);
  index("arrival-source", scenario.arrivals, problems);
  index("availability", scenario.availability, problems);
  index("source", scenario.sources, problems);

  for (const source of scenario.sources)
    if (!isNonNegativeInteger(source.revision))
      problems.push({
        code: "invalid_number",
        field: "revision",
        value: source.revision,
        where: `source ${source.id}`,
      });
  checkLimits(scenario, problems);
  for (const destination of scenario.destinations)
    requireKnown(
      products,
      "product",
      destination.product,
      `destination ${destination.id}`,
      problems,
    );
  for (const resource of scenario.resources)
    checkResource(resource, resources, problems);
  checkWorkers(scenario, resources, problems);
  checkBatches(scenario, problems);
  checkStorages(scenario, products, cells, storages, problems);
  for (const workflow of scenario.workflows)
    checkWorkflow(workflow, {
      products,
      destinations,
      resources,
      storages,
      cells,
      problems,
    });
  checkMaterialGraph(scenario, problems);
  checkArrivals(scenario, workflows, problems);
  checkDependencies(scenario, problems);
  for (const availability of scenario.availability)
    requireKnown(
      resources,
      "resource",
      availability.resource,
      `availability ${availability.id}`,
      problems,
    );

  if (problems.length > 0) return err(problems);
  const digest = parseSha256Hex(await sha256Hex(canonicalJson(scenario)));
  if (!digest.ok) throw new Error("SHA-256 produced an invalid digest");
  return ok(
    Object.freeze({ scenario, digest: digest.value }) as AdmittedScenario,
  );
}

function index<Value extends Readonly<{ id: string }>>(
  kind: IdKind,
  values: readonly Value[],
  problems: AdmissionProblem[],
): Index<Value["id"], Value> {
  const result = new Map<Value["id"], Value>();
  for (const value of values) {
    if (result.has(value.id))
      problems.push({
        code: "duplicate_identity",
        kind,
        id: value.id,
        where: "scenario",
      });
    result.set(value.id, value);
  }
  return result;
}

function requireKnown<Key extends string, Value>(
  known: Index<Key, Value>,
  kind: IdKind,
  id: Key,
  where: string,
  problems: AdmissionProblem[],
): Value | null {
  const value = known.get(id);
  if (value === undefined) {
    problems.push({ code: "unknown_reference", kind, id, where });
    return null;
  }
  return value;
}

function checkLimits(
  scenario: CompiledScenario,
  problems: AdmissionProblem[],
): void {
  const { eventCap, horizon } = scenario.limits;
  if (!isPositiveInteger(eventCap) || eventCap > MAX_EVENT_CAP)
    problems.push({
      code: "invalid_number",
      field: "eventCap",
      value: eventCap,
      where: "limits",
    });
  if (horizon <= 0)
    problems.push({
      code: "invalid_number",
      field: "horizon",
      value: horizon,
      where: "limits",
    });
}

function reachableConfigurations(
  resource: ResourceDefinition,
): ReadonlySet<ConfigurationId> {
  const reachable = new Set<ConfigurationId>();
  if (resource.configuration === null) return reachable;
  reachable.add(resource.configuration.initial);
  let grew = true;
  while (grew) {
    grew = false;
    for (const changeover of resource.configuration.changeovers)
      if (reachable.has(changeover.from) && !reachable.has(changeover.to)) {
        reachable.add(changeover.to);
        grew = true;
      }
  }
  return reachable;
}

function checkClaims(
  claims: readonly ResourceClaim[],
  resources: Index<ResourceId, ResourceDefinition>,
  where: string,
  problems: AdmissionProblem[],
): void {
  const claimed = new Set<ResourceId>();
  for (const claim of claims) {
    const resource = requireKnown(
      resources,
      "resource",
      claim.resource,
      where,
      problems,
    );
    if (claimed.has(claim.resource))
      problems.push({
        code: "duplicate_identity",
        kind: "resource",
        id: claim.resource,
        where,
      });
    claimed.add(claim.resource);
    if (!isPositiveInteger(claim.units))
      problems.push({
        code: "invalid_number",
        field: "units",
        value: claim.units,
        where,
      });
    if (resource === null) continue;
    if (resource.kind === "batch")
      problems.push({ code: "invalid_batch", reason: "claim", where });
    if (resource.kind === "worker")
      problems.push({
        code: "invalid_worker",
        resource: resource.id,
        reason: "claimed_as_capacity",
        where,
      });
    if (claim.units > resource.capacity)
      problems.push({
        code: "claim_exceeds_capacity",
        resource: claim.resource,
        units: claim.units,
        capacity: resource.capacity,
        where,
      });
    if (claim.configuration === null) continue;
    if (resource.configuration === null)
      problems.push({
        code: "invalid_configuration",
        resource: claim.resource,
        configuration: claim.configuration,
        reason: "resource_has_no_configuration",
        where,
      });
    else if (!reachableConfigurations(resource).has(claim.configuration))
      problems.push({
        code: "invalid_configuration",
        resource: claim.resource,
        configuration: claim.configuration,
        reason: "unreachable",
        where,
      });
  }
}

/** Check every possible prior endpoint, including work in another workflow. */
function checkWorkers(
  scenario: CompiledScenario,
  resources: Index<ResourceId, ResourceDefinition>,
  problems: AdmissionProblem[],
): void {
  const attended = [];
  for (const workflow of scenario.workflows) {
    for (const task of workflow.tasks) {
      const executor = executionWork(task.executor);
      if (executor.kind !== "attended") continue;
      const where = `workflow ${workflow.id} task ${task.key}`;
      attended.push(executor);
      if (executor.workers.length === 0)
        problems.push({ code: "empty_worker_selection", where });
      const seen = new Set<ResourceId>();
      for (const id of executor.workers) {
        const worker = requireKnown(resources, "resource", id, where, problems);
        if (worker !== null && worker.kind !== "worker")
          problems.push({
            code: "invalid_worker",
            resource: id,
            reason: "not_worker",
            where,
          });
        if (seen.has(id))
          problems.push({
            code: "duplicate_identity",
            kind: "resource",
            id,
            where,
          });
        seen.add(id);
      }
    }
  }
  for (const worker of resources.values()) {
    if (worker.kind !== "worker") continue;
    const where = `worker ${worker.id}`;
    const origins = new Set<LocationId>([worker.initialLocation]);
    const targets = new Set<LocationId>();
    for (const executor of attended) {
      if (!executor.workers.includes(worker.id)) continue;
      origins.add(executor.finish);
      targets.add(executor.start);
    }
    const routes = new Set<string>();
    for (const route of worker.travel) {
      const key = `${route.from}/${route.to}`;
      if (routes.has(key) || route.from === route.to)
        problems.push({
          code: "invalid_worker_route",
          resource: worker.id,
          from: route.from,
          to: route.to,
          reason: routes.has(key) ? "duplicate" : "same_location",
          where,
        });
      routes.add(key);
    }
    for (const from of origins) {
      for (const to of targets) {
        if (from === to || routes.has(`${from}/${to}`)) continue;
        problems.push({
          code: "invalid_worker_route",
          resource: worker.id,
          from,
          to,
          reason: "missing",
          where,
        });
      }
    }
  }
}

function checkResource(
  resource: ResourceDefinition,
  resources: Index<ResourceId, ResourceDefinition>,
  problems: AdmissionProblem[],
): void {
  const where = `resource ${resource.id}`;
  if (!isPositiveInteger(resource.capacity))
    problems.push({
      code: "invalid_number",
      field: "capacity",
      value: resource.capacity,
      where,
    });
  if (resource.configuration === null) return;
  for (const changeover of resource.configuration.changeovers) {
    if (changeover.from === changeover.to)
      problems.push({
        code: "invalid_configuration",
        resource: resource.id,
        configuration: changeover.to,
        reason: "no_change",
        where,
      });
    // A changeover already holds its own resource completely.
    for (const claim of changeover.claims)
      if (claim.resource === resource.id)
        problems.push({
          code: "duplicate_identity",
          kind: "resource",
          id: resource.id,
          where: `${where} changeover to ${changeover.to}`,
        });
    checkClaims(
      changeover.claims,
      resources,
      `${where} changeover to ${changeover.to}`,
      problems,
    );
  }
}

function checkStorages(
  scenario: CompiledScenario,
  products: Index<ProductId, CompiledScenario["products"][number]>,
  cells: Index<CellId, CompiledScenario["cells"][number]>,
  storages: Index<StorageId, StorageDefinition>,
  problems: AdmissionProblem[],
): void {
  const cellsWithStorage = new Set<CellId>();
  for (const storage of scenario.storages) {
    const where = `storage ${storage.id}`;
    if (storage.cell !== null) {
      const cell = requireKnown(cells, "cell", storage.cell, where, problems);
      if (cell?.carrierSlots === 0)
        problems.push({
          code: "unsupported_storage",
          storage: storage.id,
          reason: "holds_no_carriers",
          where,
        });
      cellsWithStorage.add(storage.cell);
    }
    if (storage.capacity.kind === "carriers") {
      if (!isPositiveInteger(storage.capacity.slots))
        problems.push({
          code: "invalid_number",
          field: "slots",
          value: storage.capacity.slots,
          where,
        });
      continue;
    }
    const product = requireKnown(
      products,
      "product",
      storage.capacity.product,
      where,
      problems,
    );
    // A cell's own positions hold carriers; loose material has no body there.
    if (storage.cell !== null)
      problems.push({
        code: "unsupported_storage",
        storage: storage.id,
        reason: "material_inside_cell",
        where,
      });
    if (product !== null && product.unit !== storage.capacity.quantity.unit)
      problems.push({
        code: "unit_mismatch",
        product: product.id,
        expected: product.unit,
        actual: storage.capacity.quantity.unit,
        where,
      });
    if (storage.capacity.quantity.amount <= 0)
      problems.push({
        code: "invalid_number",
        field: "quantity",
        value: storage.capacity.quantity.amount,
        where,
      });
  }
  for (const cell of scenario.cells)
    if (cell.carrierSlots === 1 && !cellsWithStorage.has(cell.id))
      problems.push({
        code: "cell_without_storage",
        cell: cell.id,
        where: `cell ${cell.id}`,
      });

  const carriersIn = new Map<StorageId, number>();
  const carriersInCell = new Map<CellId, number>();
  for (const carrier of scenario.carriers) {
    const where = `carrier ${carrier.id}`;
    const storage = requireKnown(
      storages,
      "storage",
      carrier.storage,
      where,
      problems,
    );
    if (storage === null) continue;
    if (storage.capacity.kind !== "carriers") {
      problems.push({
        code: "unsupported_storage",
        storage: storage.id,
        reason: "holds_no_carriers",
        where,
      });
      continue;
    }
    const count = (carriersIn.get(storage.id) ?? 0) + 1;
    carriersIn.set(storage.id, count);
    if (count === storage.capacity.slots + 1)
      problems.push({
        code: "storage_overfilled",
        storage: storage.id,
        reason: "carriers",
        where,
      });
    if (storage.cell === null) continue;
    const inCell = (carriersInCell.get(storage.cell) ?? 0) + 1;
    carriersInCell.set(storage.cell, inCell);
    if (inCell === 2)
      problems.push({
        code: "storage_overfilled",
        storage: storage.id,
        reason: "cell_slots",
        where,
      });
  }

  const stocked = new Map<StorageId, number>();
  for (const lot of scenario.stock) {
    const where = `stock ${lot.id}`;
    const product = requireKnown(
      products,
      "product",
      lot.product,
      where,
      problems,
    );
    const storage = requireKnown(
      storages,
      "storage",
      lot.storage,
      where,
      problems,
    );
    if (product !== null && product.unit !== lot.quantity.unit)
      problems.push({
        code: "unit_mismatch",
        product: product.id,
        expected: product.unit,
        actual: lot.quantity.unit,
        where,
      });
    if (storage === null) continue;
    if (
      storage.capacity.kind !== "material" ||
      storage.capacity.product !== lot.product
    ) {
      problems.push({
        code: "unsupported_storage",
        storage: storage.id,
        reason: "holds_another_product",
        where,
      });
      continue;
    }
    const total = (stocked.get(storage.id) ?? 0) + lot.quantity.amount;
    if (
      total > storage.capacity.quantity.amount &&
      (stocked.get(storage.id) ?? 0) <= storage.capacity.quantity.amount
    )
      problems.push({
        code: "storage_overfilled",
        storage: storage.id,
        reason: "material",
        where,
      });
    stocked.set(storage.id, total);
  }
}

type WorkflowContext = Readonly<{
  products: Index<ProductId, CompiledScenario["products"][number]>;
  destinations: Index<DestinationId, CompiledScenario["destinations"][number]>;
  resources: Index<ResourceId, ResourceDefinition>;
  storages: Index<StorageId, StorageDefinition>;
  cells: Index<CellId, CompiledScenario["cells"][number]>;
  problems: AdmissionProblem[];
}>;

/** A measurement rule reads a lot that an earlier task measured. */
function measuredBefore(
  lot: LotKey,
  before: ReadonlySet<TaskKey>,
  tasks: ReadonlyMap<TaskKey, TaskDefinition>,
): boolean {
  for (const key of before)
    for (const output of tasks.get(key)?.outputs ?? [])
      if (output.kind === "measured-lot" && output.lot === lot) return true;
  return false;
}

/** Tasks in dependency order, or the keys left on a cycle. */
function orderTasks(
  workflow: WorkflowDefinition,
  tasks: Index<TaskKey, TaskDefinition>,
): Result<readonly TaskDefinition[], readonly TaskKey[]> {
  const waiting = new Map<TaskKey, number>();
  const dependents = new Map<TaskKey, TaskKey[]>();
  // Authored order breaks ties, so the result is stable.
  const ready: TaskDefinition[] = [];
  for (const task of workflow.tasks) {
    let unmet = 0;
    for (const prerequisite of task.prerequisites) {
      if (!tasks.has(prerequisite)) continue;
      unmet += 1;
      const list = dependents.get(prerequisite) ?? [];
      list.push(task.key);
      dependents.set(prerequisite, list);
    }
    waiting.set(task.key, unmet);
    if (unmet === 0) ready.push(task);
  }
  const ordered: TaskDefinition[] = [];
  const placed = new Set<TaskKey>();
  for (let next = ready.shift(); next !== undefined; next = ready.shift()) {
    ordered.push(next);
    placed.add(next.key);
    for (const dependent of dependents.get(next.key) ?? []) {
      const remaining = (waiting.get(dependent) ?? 0) - 1;
      waiting.set(dependent, remaining);
      const task = tasks.get(dependent);
      if (remaining === 0 && task !== undefined) ready.push(task);
    }
  }
  if (ordered.length === tasks.size) return ok(ordered);
  const cyclic: TaskKey[] = [];
  for (const key of tasks.keys()) if (!placed.has(key)) cyclic.push(key);
  return err(cyclic);
}

function checkWorkflow(
  workflow: WorkflowDefinition,
  context: WorkflowContext,
): void {
  const { problems } = context;
  // An instance with no task could neither complete an order nor supply one.
  if (workflow.tasks.length === 0)
    problems.push({
      code: "empty_workflow",
      workflow: workflow.id,
      where: `workflow ${workflow.id}`,
    });
  const tasks = new Map<TaskKey, TaskDefinition>();
  for (const task of workflow.tasks) {
    if (tasks.has(task.key))
      problems.push({
        code: "duplicate_identity",
        kind: "task-key",
        id: task.key,
        where: `workflow ${workflow.id}`,
      });
    tasks.set(task.key, task);
  }
  for (const task of workflow.tasks)
    for (const prerequisite of task.prerequisites)
      requireKnown(
        tasks,
        "task-key",
        prerequisite,
        `workflow ${workflow.id} task ${task.key}`,
        problems,
      );
  const ordered = orderTasks(workflow, tasks);
  if (!ordered.ok) {
    problems.push({
      code: "cyclic_tasks",
      workflow: workflow.id,
      tasks: ordered.error,
      where: `workflow ${workflow.id}`,
    });
    return;
  }

  // Every task's transitive prerequisites, built in dependency order.
  const ancestors = new Map<TaskKey, ReadonlySet<TaskKey>>();
  for (const task of ordered.value) {
    const set = new Set<TaskKey>();
    for (const prerequisite of task.prerequisites) {
      set.add(prerequisite);
      for (const earlier of ancestors.get(prerequisite) ?? []) set.add(earlier);
    }
    ancestors.set(task.key, set);
  }

  const produced = new Map<
    LotKey,
    Readonly<{
      task: TaskKey;
      output: Variant<MaterialOutput, "lot" | "measured-lot">;
    }>
  >();
  for (const task of ordered.value)
    for (const output of task.outputs) {
      if (output.kind !== "lot" && output.kind !== "measured-lot") continue;
      if (produced.has(output.lot))
        problems.push({
          code: "duplicate_identity",
          kind: "lot-key",
          id: output.lot,
          where: `workflow ${workflow.id} task ${task.key}`,
        });
      produced.set(output.lot, { task: task.key, output });
    }

  const consumed = new Map<
    LotKey,
    {
      always: number;
      decisions: Map<TaskKey, { accept: number; reject: number }>;
    }
  >();
  const released = new Set<LotKey>();
  for (const task of ordered.value) {
    const where = `workflow ${workflow.id} task ${task.key}`;
    const before = ancestors.get(task.key) ?? new Set<TaskKey>();
    if (!Number.isSafeInteger(task.priority))
      problems.push({
        code: "invalid_number",
        field: "priority",
        value: task.priority,
        where,
      });
    checkClaims(task.claims, context.resources, where, problems);
    if (task.executor.kind === "after-inspection") {
      const gate = tasks.get(task.executor.inspection);
      if (
        gate?.executor.kind !== "inspection" ||
        !before.has(task.executor.inspection) ||
        task.carriers.length > 0 ||
        task.releases.length > 0
      )
        problems.push({ code: "invalid_inspection", where });
    }
    // A decision can release held lots, or it can only choose a branch.
    if (
      task.executor.kind === "inspection" &&
      (task.claims.length > 0 ||
        task.inputs.length > 0 ||
        task.outputs.length > 0 ||
        task.carriers.length > 0)
    )
      problems.push({ code: "invalid_inspection", where });
    if (task.executor.kind === "inspection") {
      const when = task.executor.when;
      if (
        when !== undefined &&
        (tasks.get(when.inspection)?.executor.kind !== "inspection" ||
          !before.has(when.inspection))
      )
        problems.push({ code: "invalid_inspection", where });
      const rule = task.executor.rule;
      if (
        rule?.kind === "measurement" &&
        !measuredBefore(rule.lot, before, tasks)
      )
        problems.push({ code: "invalid_inspection", where });
      // Released lots wait for a person's check. A rule cannot be that check.
      if (rule !== undefined && task.releases.length > 0)
        problems.push({ code: "invalid_inspection", where });
    }
    if (task.executor.kind === "native")
      requireKnown(
        context.cells,
        "cell",
        task.executor.operation.cell,
        where,
        problems,
      );

    for (const input of task.inputs) {
      if (input.quantity.amount <= 0)
        problems.push({
          code: "invalid_number",
          field: "quantity",
          value: input.quantity.amount,
          where,
        });
      if (input.kind === "pool") {
        checkUnit(context, input.product, input.quantity.unit, where);
        continue;
      }
      const source = produced.get(input.lot);
      if (source === undefined || !before.has(source.task)) {
        problems.push({
          code: "invalid_lot",
          lot: input.lot,
          reason: "not_produced_before",
          where,
        });
        continue;
      }
      checkUnit(context, source.output.product, input.quantity.unit, where);
      const sourceExecutor = tasks.get(source.task)?.executor;
      if (
        sourceExecutor?.kind === "after-inspection" &&
        (task.executor.kind !== "after-inspection" ||
          task.executor.inspection !== sourceExecutor.inspection ||
          task.executor.outcome !== sourceExecutor.outcome)
      )
        problems.push({ code: "invalid_inspection", where });
      const consumption = consumed.get(input.lot) ?? {
        always: 0,
        decisions: new Map<TaskKey, { accept: number; reject: number }>(),
      };
      if (task.executor.kind === "after-inspection") {
        const amounts = consumption.decisions.get(task.executor.inspection) ?? {
          accept: 0,
          reject: 0,
        };
        amounts[task.executor.outcome] += input.quantity.amount;
        consumption.decisions.set(task.executor.inspection, amounts);
      } else consumption.always += input.quantity.amount;
      consumed.set(input.lot, consumption);
      let total = consumption.always;
      for (const amounts of consumption.decisions.values())
        total += Math.max(amounts.accept, amounts.reject);
      if (total > outputCeiling(source.output).amount)
        problems.push({
          code: "invalid_lot",
          lot: input.lot,
          reason: "over_consumed",
          where,
        });
    }

    checkMeasurements(task, where, problems);
    for (const output of task.outputs) {
      const quantity = outputCeiling(output);
      if (quantity.amount <= 0)
        problems.push({
          code: "invalid_number",
          field: "quantity",
          value: quantity.amount,
          where,
        });
      checkUnit(context, output.product, quantity.unit, where);
      if (
        output.kind === "exit" ||
        output.kind === "inspection-exit" ||
        output.kind === "measured-exit"
      ) {
        const destination = requireKnown(
          context.destinations,
          "destination",
          output.destination,
          where,
          problems,
        );
        if (output.kind === "inspection-exit") {
          if (output.inspections.length === 0)
            problems.push({ code: "invalid_inspection", where });
          for (const key of output.inspections) {
            const gate = tasks.get(key);
            if (gate?.executor.kind !== "inspection" || !before.has(key))
              problems.push({ code: "invalid_inspection", where });
          }
          checkUnit(
            context,
            output.rejectedProduct,
            output.quantity.unit,
            where,
          );
          const rejected = requireKnown(
            context.destinations,
            "destination",
            output.rejectedDestination,
            where,
            problems,
          );
          if (
            rejected !== null &&
            (rejected.role !== "rejected-output" ||
              rejected.product !== output.rejectedProduct)
          )
            problems.push({
              code: "invalid_report",
              destination: rejected.id,
              reason: "role",
              where,
            });
        }
        if (destination === null) continue;
        if (destination.role === "intermediate-stock")
          problems.push({
            code: "invalid_report",
            destination: destination.id,
            reason: "role",
            where,
          });
        if (destination.product !== output.product)
          problems.push({
            code: "invalid_report",
            destination: destination.id,
            reason: "product",
            where,
          });
        continue;
      }
      if (output.report !== null) {
        const destination = requireKnown(
          context.destinations,
          "destination",
          output.report,
          where,
          problems,
        );
        if (destination !== null && destination.role !== "intermediate-stock")
          problems.push({
            code: "invalid_report",
            destination: destination.id,
            reason: "role",
            where,
          });
        if (destination !== null && destination.product !== output.product)
          problems.push({
            code: "invalid_report",
            destination: destination.id,
            reason: "product",
            where,
          });
      }
      if (output.holder.kind !== "storage") continue;
      const storage = requireKnown(
        context.storages,
        "storage",
        output.holder.storage,
        where,
        problems,
      );
      if (
        storage !== null &&
        (storage.capacity.kind !== "material" ||
          storage.capacity.product !== output.product)
      )
        problems.push({
          code: "invalid_lot",
          lot: output.lot,
          reason: "holder_rejects_product",
          where,
        });
    }

    for (const lot of task.releases) {
      const source = produced.get(lot);
      if (
        source !== undefined &&
        tasks.get(source.task)?.executor.kind === "after-inspection"
      )
        problems.push({ code: "invalid_inspection", where });
      if (source === undefined || !before.has(source.task))
        problems.push({
          code: "invalid_lot",
          lot,
          reason: "not_produced_before",
          where,
        });
      else if (source.output.disposition !== "held")
        problems.push({ code: "invalid_lot", lot, reason: "not_held", where });
      else if (released.has(lot))
        problems.push({
          code: "invalid_lot",
          lot,
          reason: "released_twice",
          where,
        });
      released.add(lot);
    }
  }
  checkCarrierRoutes(workflow, ordered.value, ancestors, context);
}

function checkUnit(
  context: WorkflowContext,
  id: ProductId,
  actual: MaterialUnit,
  where: string,
): void {
  const product = requireKnown(
    context.products,
    "product",
    id,
    where,
    context.problems,
  );
  if (product !== null && product.unit !== actual)
    context.problems.push({
      code: "unit_mismatch",
      product: id,
      expected: product.unit,
      actual,
      where,
    });
}

type RouteReason = VariantBy<
  AdmissionProblem,
  "code",
  "invalid_carrier_route"
>["reason"];
type Route = { at: StorageId | null; bound: boolean; last: TaskKey | null };

/**
 * A role's steps form one chain: acquire, moves that each start where the
 * carrier is, then release. A workflow that keeps a carrier would drain the pool.
 */
function checkCarrierRoutes(
  workflow: WorkflowDefinition,
  ordered: readonly TaskDefinition[],
  ancestors: ReadonlyMap<TaskKey, ReadonlySet<TaskKey>>,
  context: WorkflowContext,
): void {
  const { problems, storages } = context;
  const routes = new Map<CarrierRole, Route>();
  for (const task of ordered) {
    const where = `workflow ${workflow.id} task ${task.key}`;
    for (const step of task.carriers) {
      const route = routes.get(step.role) ?? {
        at: null,
        bound: false,
        last: null,
      };
      routes.set(step.role, route);
      const reasons: RouteReason[] = [];
      if (
        route.last !== null &&
        route.last !== task.key &&
        !ancestors.get(task.key)?.has(route.last)
      )
        reasons.push("unordered");
      route.last = task.key;
      if (step.kind === "release") {
        if (!route.bound) reasons.push("not_acquired");
        route.bound = false;
        route.at = null;
      } else {
        const from = requireKnown(
          storages,
          "storage",
          step.from,
          where,
          problems,
        );
        if (from !== null && from.capacity.kind !== "carriers")
          reasons.push("not_carrier_storage");
        if (step.kind === "acquire") {
          if (route.bound) reasons.push("already_acquired");
          route.bound = true;
          route.at = step.from;
        } else {
          const to = requireKnown(
            storages,
            "storage",
            step.to,
            where,
            problems,
          );
          if (to !== null && to.capacity.kind !== "carriers")
            reasons.push("not_carrier_storage");
          if (!route.bound) reasons.push("not_acquired");
          else if (route.at !== step.from) reasons.push("wrong_source");
          route.at = step.to;
          moveTimingReasons(task, step.timing, from, to, reasons);
        }
      }
      for (const reason of reasons)
        problems.push({
          code: "invalid_carrier_route",
          role: step.role,
          reason,
          where,
        });
    }
    // A lot placed on a carrier needs that carrier bound when the task runs.
    for (const output of task.outputs)
      if (
        (output.kind === "lot" || output.kind === "measured-lot") &&
        output.holder.kind === "carrier" &&
        routes.get(output.holder.carrier)?.bound !== true
      )
        problems.push({
          code: "invalid_carrier_route",
          role: output.holder.carrier,
          reason: "not_acquired",
          where,
        });
  }
  for (const [role, route] of routes)
    if (route.bound)
      problems.push({
        code: "invalid_carrier_route",
        role,
        reason: "not_released",
        where: `workflow ${workflow.id}`,
      });
}

/**
 * Only a native controller measures outputs. A measured task measures all of
 * them, in one unit with its inputs, so its outputs can balance its inputs.
 */
function checkMeasurements(
  task: TaskDefinition,
  where: string,
  problems: AdmissionProblem[],
): void {
  const measured = task.outputs.filter(
    (output) =>
      output.kind === "measured-lot" || output.kind === "measured-exit",
  );
  if (measured.length === 0) return;
  if (task.executor.kind !== "native")
    problems.push({ code: "invalid_measurement", reason: "not_native", where });
  if (measured.length !== task.outputs.length)
    problems.push({ code: "invalid_measurement", reason: "partial", where });
  const keys = new Set<string>();
  const units = new Set<string>();
  for (const output of measured) {
    if (keys.has(output.measurement))
      problems.push({
        code: "invalid_measurement",
        reason: "duplicate",
        where,
      });
    keys.add(output.measurement);
    units.add(outputCeiling(output).unit);
  }
  for (const input of task.inputs) units.add(input.quantity.unit);
  if (units.size !== 1)
    problems.push({ code: "invalid_measurement", reason: "unit", where });
}

function moveTimingReasons(
  task: TaskDefinition,
  timing: MoveTiming,
  from: StorageDefinition | null,
  to: StorageDefinition | null,
  reasons: RouteReason[],
): void {
  if (task.executor.kind === "native") {
    if (timing.kind !== "native") {
      reasons.push("timing_differs_from_executor");
      return;
    }
    // Native handling moves a carrier only inside its own physical world.
    const cell = task.executor.operation.cell;
    if (from?.cell !== cell || to?.cell !== cell)
      reasons.push("outside_native_cell");
    return;
  }
  if (timing.kind !== "declared") {
    reasons.push("timing_differs_from_executor");
    return;
  }
  if (timing.pickupAfter > timing.placementAfter)
    reasons.push("pickup_after_placement");
  if (
    task.executor.kind === "batch" ||
    task.executor.kind === "inspection" ||
    task.executor.kind === "after-inspection" ||
    timing.placementAfter > task.executor.duration
  )
    reasons.push("placement_after_completion");
}

/**
 * Pool claims link workflows through products. That product graph must stay
 * acyclic, or no order of batches could satisfy every claim.
 */
function checkMaterialGraph(
  scenario: CompiledScenario,
  problems: AdmissionProblem[],
): void {
  const edges = new Map<ProductId, Set<ProductId>>();
  for (const workflow of scenario.workflows) {
    const lots = new Map<LotKey, ProductId>();
    for (const task of workflow.tasks)
      for (const output of task.outputs)
        if (output.kind === "lot" || output.kind === "measured-lot")
          lots.set(output.lot, output.product);
    for (const task of workflow.tasks)
      for (const input of task.inputs) {
        const from =
          input.kind === "pool" ? input.product : lots.get(input.lot);
        if (from === undefined) continue;
        const targets = edges.get(from) ?? new Set<ProductId>();
        edges.set(from, targets);
        for (const output of task.outputs)
          if (output.product !== from) targets.add(output.product);
      }
  }
  const finished = new Set<ProductId>();
  for (const product of edges.keys()) {
    const cycle = materialCycle(product, edges, finished, []);
    if (cycle === null) continue;
    problems.push({
      code: "cyclic_material",
      products: cycle,
      where: "scenario",
    });
    return;
  }
}

/** The products on a cycle reachable from `product`, or null. */
function materialCycle(
  product: ProductId,
  edges: ReadonlyMap<ProductId, ReadonlySet<ProductId>>,
  finished: Set<ProductId>,
  path: readonly ProductId[],
): readonly ProductId[] | null {
  if (finished.has(product)) return null;
  const seen = path.indexOf(product);
  if (seen >= 0) return path.slice(seen);
  for (const next of edges.get(product) ?? []) {
    const cycle = materialCycle(next, edges, finished, [...path, product]);
    if (cycle !== null) return cycle;
  }
  finished.add(product);
  return null;
}

function checkArrivals(
  scenario: CompiledScenario,
  workflows: Index<WorkflowId, WorkflowDefinition>,
  problems: AdmissionProblem[],
): void {
  for (const source of scenario.arrivals) {
    const where = `arrival source ${source.id}`;
    requireKnown(workflows, "workflow", source.workflow, where, problems);
    if (source.kind === "periodic") {
      if (source.interval <= 0)
        problems.push({
          code: "invalid_number",
          field: "interval",
          value: source.interval,
          where,
        });
      if (
        source.limit.kind === "count" &&
        !isPositiveInteger(source.limit.count)
      )
        problems.push({
          code: "invalid_number",
          field: "count",
          value: source.limit.count,
          where,
        });
      if (source.limit.kind === "until" && source.limit.end < source.first)
        problems.push({ code: "invalid_arrivals", reason: "empty", where });
      continue;
    }
    if (source.arrivals.length === 0)
      problems.push({ code: "invalid_arrivals", reason: "empty", where });
    let previous = -1;
    for (const arrival of source.arrivals) {
      if (!isPositiveInteger(arrival.quantity))
        problems.push({
          code: "invalid_number",
          field: "count",
          value: arrival.quantity,
          where,
        });
      if (arrival.time < previous)
        problems.push({ code: "invalid_arrivals", reason: "unordered", where });
      previous = arrival.time;
    }
  }
}
