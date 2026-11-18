import * as d from "./document-values.ts";
import type * as S from "./scenario.ts";
import { SCENARIO_SCHEMA_VERSION } from "./scenario.ts";

/** Decodes the wire shape once; admission then checks its domain relationships. */
export function readScenario(raw: unknown): S.CompiledScenario {
  const r = d.record(raw, [
    "schemaVersion",
    "id",
    "policy",
    "sources",
    "limits",
    "products",
    "destinations",
    "resources",
    "storages",
    "carriers",
    "cells",
    "stock",
    "workflows",
    "arrivals",
    "dependencies",
    "availability",
  ]);
  const limits = d.record(r.limits, ["horizon", "eventCap"]);
  return {
    schemaVersion: d.choice(r.schemaVersion, SCENARIO_SCHEMA_VERSION),
    id: d.authored("scenario", r.id),
    policy: d.choice(r.policy, "priority-arrival-task/1"),
    sources: d.array(r.sources, source),
    limits: {
      horizon: d.time(limits.horizon),
      eventCap: d.positive(limits.eventCap),
    },
    products: d.array(r.products, product),
    destinations: d.array(r.destinations, destination),
    resources: d.array(r.resources, resource),
    storages: d.array(r.storages, storage),
    carriers: d.array(r.carriers, carrier),
    cells: d.array(r.cells, cell),
    stock: d.array(r.stock, stock),
    workflows: d.array(r.workflows, workflow),
    arrivals: d.array(r.arrivals, arrival),
    dependencies: d.array(r.dependencies, dependency),
    availability: d.array(r.availability, availability),
  };
}

function taskReference(raw: unknown): S.InstanceTaskReference {
  const r = d.record(raw, ["source", "sequence", "key"]);
  return {
    source: d.authored("arrival-source", r.source),
    sequence: d.natural(r.sequence),
    key: d.authored("task-key", r.key),
  };
}

function dependency(raw: unknown): S.InstanceDependency {
  const r = d.record(raw, ["task", "prerequisite"]);
  return {
    task: taskReference(r.task),
    prerequisite: taskReference(r.prerequisite),
  };
}

function source(raw: unknown): S.SourceRevision {
  const r = d.record(raw, ["id", "revision", "digest"]);
  return {
    id: d.authored("source", r.id),
    revision: d.natural(r.revision),
    digest: d.digest(r.digest),
  };
}
function product(raw: unknown): S.ProductDefinition {
  const r = d.record(raw, ["id", "unit"]);
  return {
    id: d.authored("product", r.id),
    unit: d.choice(r.unit, "each", "milligram", "microliter"),
  };
}
function destination(raw: unknown): S.ReportingDestination {
  const r = d.record(raw, ["id", "role", "product"]);
  return {
    id: d.authored("destination", r.id),
    role: d.choice(
      r.role,
      "final-output",
      "intermediate-stock",
      "rejected-output",
      "loss",
    ),
    product: d.authored("product", r.product),
  };
}
export function readClaim(raw: unknown): S.ResourceClaim {
  const r = d.record(raw, ["resource", "units", "configuration"]);
  return {
    resource: d.authored("resource", r.resource),
    units: d.positive(r.units),
    configuration: readConfigurationId(r.configuration),
  };
}
export function readConfigurationId(raw: unknown) {
  return raw === null ? null : d.authored("configuration", raw);
}
function changeover(raw: unknown): S.Changeover {
  const r = d.record(raw, ["from", "to", "duration", "evidence", "claims"]);
  return {
    from: d.authored("configuration", r.from),
    to: d.authored("configuration", r.to),
    duration: d.duration(r.duration),
    evidence: d.choice(r.evidence, "model", "measured", "assumed"),
    claims: d.array(r.claims, readClaim),
  };
}
function resourceConfiguration(
  raw: unknown,
): NonNullable<S.ResourceDefinition["configuration"]> {
  const r = d.record(raw, ["initial", "changeovers"]);
  return {
    initial: d.authored("configuration", r.initial),
    changeovers: d.array(r.changeovers, changeover),
  };
}
function resource(raw: unknown): S.ResourceDefinition {
  switch (d.kind(raw)) {
    case "batch": {
      const r = d.record(raw, [
        "kind",
        "id",
        "capacity",
        "configuration",
        "storage",
        "loadWindow",
        "programs",
      ]);
      d.requireValue(r.configuration === null);
      return {
        kind: "batch",
        id: d.authored("resource", r.id),
        capacity: d.positive(r.capacity),
        configuration: null,
        storage: d.authored("storage", r.storage),
        loadWindow: d.duration(r.loadWindow),
        programs: d.array(r.programs, batchProgram),
      };
    }
    case "capacity": {
      const r = d.record(raw, ["kind", "id", "capacity", "configuration"]);
      return {
        kind: "capacity",
        id: d.authored("resource", r.id),
        capacity: d.positive(r.capacity),
        configuration: d.nullable(r.configuration, resourceConfiguration),
      };
    }
    case "worker": {
      const r = d.record(raw, [
        "kind",
        "id",
        "capacity",
        "configuration",
        "initialLocation",
        "travel",
      ]);
      d.requireValue(r.configuration === null);
      return {
        kind: "worker",
        id: d.authored("resource", r.id),
        capacity: d.choice(r.capacity, 1),
        configuration: null,
        initialLocation: d.authored("location", r.initialLocation),
        travel: d.array(r.travel, travelRoute),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function batchProgram(raw: unknown): S.BatchProgram {
  const r = d.record(raw, ["id", "duration", "evidence"]);
  return {
    id: d.authored("batch-program", r.id),
    duration: d.duration(r.duration),
    evidence: d.choice(r.evidence, "model", "measured", "assumed"),
  };
}
export function readTravelRoute(raw: unknown): S.TravelRoute {
  const r = d.record(raw, ["from", "to", "duration", "evidence"]);
  return {
    from: d.authored("location", r.from),
    to: d.authored("location", r.to),
    duration: d.duration(r.duration),
    evidence: d.choice(r.evidence, "model", "measured", "assumed"),
  };
}
const travelRoute = readTravelRoute;
export function readWorkerIds(raw: unknown) {
  const workers = d.ids("resource", raw);
  const [first, ...rest] = workers;
  d.requireValue(first !== undefined);
  return [first, ...rest] as const;
}
function capacity(raw: unknown): S.StorageCapacity {
  switch (d.kind(raw)) {
    case "carriers": {
      const r = d.record(raw, ["kind", "slots"]);
      return { kind: "carriers", slots: d.positive(r.slots) };
    }
    case "material": {
      const r = d.record(raw, ["kind", "product", "quantity"]);
      return {
        kind: "material",
        product: d.authored("product", r.product),
        quantity: d.quantity(r.quantity),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function storage(raw: unknown): S.StorageDefinition {
  const r = d.record(raw, ["id", "capacity", "cell"]);
  return {
    id: d.authored("storage", r.id),
    capacity: capacity(r.capacity),
    cell: r.cell === null ? null : d.authored("cell", r.cell),
  };
}
function carrier(raw: unknown): S.CarrierDefinition {
  const r = d.record(raw, ["id", "storage"]);
  return {
    id: d.authored("carrier", r.id),
    storage: d.authored("storage", r.storage),
  };
}
function cell(raw: unknown): S.PhysicalCellDefinition {
  const r = d.record(raw, [
    "id",
    "modelHash",
    "controllerSourceHash",
    "timestepMicroseconds",
    "carrierSlots",
    "holdModel",
  ]);
  return {
    id: d.authored("cell", r.id),
    modelHash: d.digest(r.modelHash),
    controllerSourceHash: d.digest(r.controllerSourceHash),
    timestepMicroseconds: d.choice(r.timestepMicroseconds, 2000),
    carrierSlots: d.choice(r.carrierSlots, 0, 1),
    holdModel:
      r.holdModel === null ? null : d.authored("hold-model", r.holdModel),
  };
}
function stock(raw: unknown): S.InitialLot {
  const r = d.record(raw, ["id", "product", "quantity", "storage"]);
  return {
    id: d.authored("lot", r.id),
    product: d.authored("product", r.product),
    quantity: d.quantity(r.quantity),
    storage: d.authored("storage", r.storage),
  };
}
export function readOperation(raw: unknown): S.NativeOperation {
  const r = d.record(raw, ["cell", "skill", "parameters"]);
  return {
    cell: d.authored("cell", r.cell),
    skill: d.authored("skill", r.skill),
    parameters: d.digest(r.parameters),
  };
}
function isField(raw: unknown, field: string): boolean {
  return typeof raw === "object" && raw !== null && field in raw;
}
function decisionOutcome(raw: unknown): S.DecisionOutcome {
  return d.choice(raw, "accept", "reject");
}
function decisionGuard(raw: unknown): S.DecisionGuard {
  const r = d.record(raw, ["inspection", "outcome"]);
  return {
    inspection: d.authored("task-key", r.inspection),
    outcome: decisionOutcome(r.outcome),
  };
}
function decisionRule(raw: unknown): S.DecisionRule {
  switch (d.kind(raw)) {
    case "scripted": {
      const r = d.record(raw, ["kind", "outcomes"]);
      const [first, ...rest] = d.array(r.outcomes, decisionOutcome);
      d.requireValue(first !== undefined);
      return { kind: "scripted", outcomes: [first, ...rest] };
    }
    case "measurement": {
      const r = d.record(raw, ["kind", "lot", "minimum", "maximum"]);
      d.requireValue(
        typeof r.minimum === "number" &&
          typeof r.maximum === "number" &&
          Number.isFinite(r.minimum) &&
          Number.isFinite(r.maximum) &&
          r.minimum <= r.maximum,
      );
      return {
        kind: "measurement",
        lot: d.authored("lot-key", r.lot),
        minimum: r.minimum as number,
        maximum: r.maximum as number,
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function executor(raw: unknown): S.TaskExecutor {
  switch (d.kind(raw)) {
    case "after-inspection": {
      const r = d.record(raw, ["kind", "inspection", "outcome", "work"]);
      d.choice(d.kind(r.work), "declared", "attended");
      const work = executor(r.work);
      d.requireValue(work.kind === "declared" || work.kind === "attended");
      return {
        kind: "after-inspection",
        inspection: d.authored("task-key", r.inspection),
        outcome: d.choice(r.outcome, "accept", "reject"),
        work,
      };
    }
    case "inspection": {
      const known = ["kind"];
      if (isField(raw, "when")) known.push("when");
      if (isField(raw, "rule")) known.push("rule");
      const r = d.record(raw, known);
      return {
        kind: "inspection",
        ...(r.when === undefined ? {} : { when: decisionGuard(r.when) }),
        ...(r.rule === undefined ? {} : { rule: decisionRule(r.rule) }),
      };
    }
    case "batch": {
      const r = d.record(raw, [
        "kind",
        "resource",
        "program",
        "carrier",
        "load",
        "unload",
      ]);
      return {
        kind: "batch",
        resource: d.authored("resource", r.resource),
        program: d.authored("batch-program", r.program),
        carrier: d.authored("carrier-role", r.carrier),
        load: d.authored("task-key", r.load),
        unload: d.authored("task-key", r.unload),
      };
    }
    case "attended": {
      const r = d.record(raw, [
        "kind",
        "duration",
        "evidence",
        "workers",
        "start",
        "finish",
      ]);
      return {
        kind: "attended",
        duration: d.duration(r.duration),
        evidence: d.choice(r.evidence, "model", "measured", "assumed"),
        workers: readWorkerIds(r.workers),
        start: d.authored("location", r.start),
        finish: d.authored("location", r.finish),
      };
    }
    case "declared": {
      const r = d.record(raw, ["kind", "duration", "evidence"]);
      return {
        kind: "declared",
        duration: d.duration(r.duration),
        evidence: d.choice(r.evidence, "model", "measured", "assumed"),
      };
    }
    case "native": {
      const r = d.record(raw, ["kind", "operation"]);
      return { kind: "native", operation: readOperation(r.operation) };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function input(raw: unknown): S.MaterialInput {
  switch (d.kind(raw)) {
    case "pool": {
      const r = d.record(raw, ["kind", "product", "quantity"]);
      return {
        kind: "pool",
        product: d.authored("product", r.product),
        quantity: d.quantity(r.quantity),
      };
    }
    case "lot": {
      const r = d.record(raw, ["kind", "lot", "quantity"]);
      return {
        kind: "lot",
        lot: d.authored("lot-key", r.lot),
        quantity: d.quantity(r.quantity),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function holder(raw: unknown): S.LotHolder {
  switch (d.kind(raw)) {
    case "storage": {
      const r = d.record(raw, ["kind", "storage"]);
      return { kind: "storage", storage: d.authored("storage", r.storage) };
    }
    case "carrier": {
      const r = d.record(raw, ["kind", "carrier"]);
      return {
        kind: "carrier",
        carrier: d.authored("carrier-role", r.carrier),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function inspectionKey(raw: unknown) {
  return d.authored("task-key", raw);
}
function output(raw: unknown): S.MaterialOutput {
  switch (d.kind(raw)) {
    case "inspection-exit": {
      const r = d.record(raw, [
        "kind",
        "inspections",
        "product",
        "quantity",
        "destination",
        "rejectedProduct",
        "rejectedDestination",
      ]);
      return {
        kind: "inspection-exit",
        inspections: d.array(r.inspections, inspectionKey),
        product: d.authored("product", r.product),
        quantity: d.quantity(r.quantity),
        destination: d.authored("destination", r.destination),
        rejectedProduct: d.authored("product", r.rejectedProduct),
        rejectedDestination: d.authored("destination", r.rejectedDestination),
      };
    }
    case "lot": {
      const r = d.record(raw, [
        "kind",
        "lot",
        "product",
        "quantity",
        "holder",
        "disposition",
        "report",
      ]);
      return {
        kind: "lot",
        lot: d.authored("lot-key", r.lot),
        product: d.authored("product", r.product),
        quantity: d.quantity(r.quantity),
        holder: holder(r.holder),
        disposition: d.choice(r.disposition, "released", "held"),
        report: r.report === null ? null : d.authored("destination", r.report),
      };
    }
    case "exit": {
      const r = d.record(raw, ["kind", "product", "quantity", "destination"]);
      return {
        kind: "exit",
        product: d.authored("product", r.product),
        quantity: d.quantity(r.quantity),
        destination: d.authored("destination", r.destination),
      };
    }
    case "measured-lot": {
      const r = d.record(raw, [
        "kind",
        "lot",
        "product",
        "measurement",
        "bound",
        "holder",
        "disposition",
        "report",
      ]);
      return {
        kind: "measured-lot",
        lot: d.authored("lot-key", r.lot),
        product: d.authored("product", r.product),
        measurement: d.authored("measurement", r.measurement),
        bound: d.quantity(r.bound),
        holder: holder(r.holder),
        disposition: d.choice(r.disposition, "released", "held"),
        report: r.report === null ? null : d.authored("destination", r.report),
      };
    }
    case "measured-exit": {
      const r = d.record(raw, [
        "kind",
        "product",
        "measurement",
        "bound",
        "destination",
      ]);
      return {
        kind: "measured-exit",
        product: d.authored("product", r.product),
        measurement: d.authored("measurement", r.measurement),
        bound: d.quantity(r.bound),
        destination: d.authored("destination", r.destination),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function timing(raw: unknown): S.MoveTiming {
  if (d.kind(raw) === "native") {
    d.record(raw, ["kind"]);
    return { kind: "native" };
  }
  const r = d.record(raw, ["kind", "pickupAfter", "placementAfter"]);
  return {
    kind: d.choice(r.kind, "declared"),
    pickupAfter: d.duration(r.pickupAfter),
    placementAfter: d.duration(r.placementAfter),
  };
}
function carrierStep(raw: unknown): S.CarrierStep {
  switch (d.kind(raw)) {
    case "acquire": {
      const r = d.record(raw, ["kind", "role", "from"]);
      return {
        kind: "acquire",
        role: d.authored("carrier-role", r.role),
        from: d.authored("storage", r.from),
      };
    }
    case "move": {
      const r = d.record(raw, ["kind", "role", "from", "to", "timing"]);
      return {
        kind: "move",
        role: d.authored("carrier-role", r.role),
        from: d.authored("storage", r.from),
        to: d.authored("storage", r.to),
        timing: timing(r.timing),
      };
    }
    case "release": {
      const r = d.record(raw, ["kind", "role"]);
      return { kind: "release", role: d.authored("carrier-role", r.role) };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function task(raw: unknown): S.TaskDefinition {
  const r = d.record(raw, [
    "key",
    "priority",
    "releaseAfter",
    "prerequisites",
    "claims",
    "executor",
    "inputs",
    "outputs",
    "releases",
    "carriers",
  ]);
  return {
    key: d.authored("task-key", r.key),
    priority: d.integer(r.priority),
    releaseAfter: d.duration(r.releaseAfter),
    prerequisites: d.ids("task-key", r.prerequisites),
    claims: d.array(r.claims, readClaim),
    executor: executor(r.executor),
    inputs: d.array(r.inputs, input),
    outputs: d.array(r.outputs, output),
    releases: d.ids("lot-key", r.releases),
    carriers: d.array(r.carriers, carrierStep),
  };
}
function workflow(raw: unknown): S.WorkflowDefinition {
  const r = d.record(raw, ["id", "revision", "demand", "tasks"]);
  return {
    id: d.authored("workflow", r.id),
    revision: d.digest(r.revision),
    demand: d.choice(r.demand, "order", "production"),
    tasks: d.array(r.tasks, task),
  };
}
function explicitArrival(raw: unknown) {
  const r = d.record(raw, ["time", "quantity"]);
  return { time: d.time(r.time), quantity: d.positive(r.quantity) };
}
function arrivalLimit(raw: unknown) {
  switch (d.kind(raw)) {
    case "count": {
      const r = d.record(raw, ["kind", "count"]);
      return { kind: "count" as const, count: d.positive(r.count) };
    }
    case "until": {
      const r = d.record(raw, ["kind", "end"]);
      return { kind: "until" as const, end: d.time(r.end) };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function arrival(raw: unknown): S.ArrivalSource {
  switch (d.kind(raw)) {
    case "explicit": {
      const r = d.record(raw, ["kind", "id", "workflow", "arrivals"]);
      return {
        kind: "explicit",
        id: d.authored("arrival-source", r.id),
        workflow: d.authored("workflow", r.workflow),
        arrivals: d.array(r.arrivals, explicitArrival),
      };
    }
    case "periodic": {
      const r = d.record(raw, [
        "kind",
        "id",
        "workflow",
        "first",
        "interval",
        "limit",
      ]);
      return {
        kind: "periodic",
        id: d.authored("arrival-source", r.id),
        workflow: d.authored("workflow", r.workflow),
        first: d.time(r.first),
        interval: d.duration(r.interval),
        limit: arrivalLimit(r.limit),
      };
    }
    default:
      throw new d.InvalidDocument();
  }
}
function availability(raw: unknown): S.AvailabilityInterval {
  const r = d.record(raw, ["id", "resource", "interval"]);
  return {
    id: d.authored("availability", r.id),
    resource: d.authored("resource", r.resource),
    interval: d.interval(r.interval),
  };
}
