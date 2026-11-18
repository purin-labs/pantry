import type { StrictUnion, Variant } from "@seams/type-utils";
import type {
  ArrivalSourceId,
  AvailabilityId,
  BatchProgramId,
  CarrierId,
  CarrierRole,
  CellId,
  ConfigurationId,
  DestinationId,
  HoldModelId,
  LotId,
  LotKey,
  LocationId,
  MeasurementId,
  ProductId,
  ResourceId,
  ScenarioId,
  Sha256Hex,
  SkillId,
  SourceId,
  StorageId,
  TaskKey,
  WorkflowId,
} from "./identity.ts";
import type { MaterialQuantity, MaterialUnit } from "./quantity.ts";
import type {
  Interval,
  LogicalTime,
  TICK_MICROSECONDS,
  TickDuration,
} from "./time.ts";

/**
 * The normalized form recipe adapters compile into and the engine executes. It
 * names no recipe, station or coordinate: adapters own those meanings.
 */

/** The basis of a declared duration or parameter, kept for inspection. */
export type Provenance = "model" | "measured" | "assumed";

/** The dispatch order: task priority, then arrival order, then task identity. */
export const DISPATCH_POLICY = "priority-arrival-task/1";
export const SCENARIO_SCHEMA_VERSION = 5;
/** Task, material, resource, arrival and control events in one run. */
export const MAX_EVENT_CAP = 10_000;

/** An authoring source this scenario was compiled from, checked again at restore. */
export type SourceRevision = Readonly<{
  id: SourceId;
  revision: number;
  digest: Sha256Hex;
}>;

export type ProductDefinition = Readonly<{
  id: ProductId;
  unit: MaterialUnit;
}>;

/**
 * Where a quantity is counted. Final output, rejected output and loss leave
 * the factory. Intermediate stock is counted once and stays claimable.
 */
export type ReportingRole =
  "final-output" | "intermediate-stock" | "rejected-output" | "loss";
export type ReportingDestination = Readonly<{
  id: DestinationId;
  role: ReportingRole;
  product: ProductId;
}>;

/** Capacity held while a task runs, with the configuration it needs. */
export type ResourceClaim = Readonly<{
  resource: ResourceId;
  units: number;
  configuration: ConfigurationId | null;
}>;

/**
 * A changeover is a task in its own right. The engine creates one when the
 * resource has no active claim and waiting work requires another
 * configuration. It has a task identity, claims its whole resource and the
 * resources listed here for its declared duration, and records the same
 * reserved, started and completed events as any other task. Completion sets
 * the engine-owned configuration.
 */
export type Changeover = Readonly<{
  from: ConfigurationId;
  to: ConfigurationId;
  duration: TickDuration;
  evidence: Provenance;
  claims: readonly ResourceClaim[];
}>;

/** Recipe adapters calculate routes and durations from their layout. */
export type TravelRoute = Readonly<{
  from: LocationId;
  to: LocationId;
  duration: TickDuration;
  evidence: Provenance;
}>;

/** One compatible cohort shares this declared process duration. */
export type BatchProgram = Readonly<{
  id: BatchProgramId;
  duration: TickDuration;
  evidence: Provenance;
}>;

/** Workers have one occupant and travel from their last completed task. */
export type ResourceDefinition = Readonly<{ id: ResourceId }> &
  StrictUnion<
    | Readonly<{
        kind: "batch";
        capacity: number;
        configuration: null;
        storage: StorageId;
        loadWindow: TickDuration;
        programs: readonly BatchProgram[];
      }>
    | Readonly<{
        kind: "capacity";
        capacity: number;
        configuration: Readonly<{
          initial: ConfigurationId;
          changeovers: readonly Changeover[];
        }> | null;
      }>
    | Readonly<{
        kind: "worker";
        capacity: 1;
        configuration: null;
        initialLocation: LocationId;
        travel: readonly TravelRoute[];
      }>
  >;

export type StorageCapacity =
  | Readonly<{ kind: "carriers"; slots: number; product?: never }>
  | Readonly<{
      kind: "material";
      product: ProductId;
      quantity: MaterialQuantity;
      slots?: never;
    }>;

/**
 * A finite, named position. A position inside a cell also needs that cell's
 * carrier slot, so a carrier holds the cell from admission until removal.
 */
export type StorageDefinition = Readonly<{
  id: StorageId;
  capacity: StorageCapacity;
  cell: CellId | null;
}>;

/** A reusable carrier and the position it starts in, empty. */
export type CarrierDefinition = Readonly<{
  id: CarrierId;
  storage: StorageId;
}>;

/**
 * One independent physical world. Its model and controller source are pinned
 * here; the build that executes them is pinned by the execution bundle.
 */
export type PhysicalCellDefinition = Readonly<{
  id: CellId;
  modelHash: Sha256Hex;
  controllerSourceHash: Sha256Hex;
  timestepMicroseconds: typeof TICK_MICROSECONDS;
  /** Fixed appliances have no transferable carrier slot. */
  carrierSlots: 0 | 1;
  holdModel: HoldModelId | null;
}>;

export type InitialLot = Readonly<{
  id: LotId;
  product: ProductId;
  quantity: MaterialQuantity;
  storage: StorageId;
}>;

export type NativeOperation = Readonly<{
  cell: CellId;
  skill: SkillId;
  /** Digest of the adapter-owned request parameters pinned with the scenario. */
  parameters: Sha256Hex;
}>;

export type DecisionOutcome = "accept" | "reject";

/** The decision that a task needs, by an earlier task of its own instance. */
export type DecisionGuard = Readonly<{
  inspection: TaskKey;
  outcome: DecisionOutcome;
}>;

/**
 * A decision without an operator. Each rule is a pure function of the definition,
 * the instance and accepted evidence, so a replay reaches the same outcome.
 */
export type DecisionRule = StrictUnion<
  /** The outcome of each arrival occurrence. The last one repeats. */
  | Readonly<{
      kind: "scripted";
      outcomes: readonly [DecisionOutcome, ...DecisionOutcome[]];
    }>
  /** Accepts when an earlier measured lot of this instance is in this range. */
  | Readonly<{
      kind: "measurement";
      lot: LotKey;
      minimum: number;
      maximum: number;
    }>
>;

/** A declared duration is known at dispatch. A native duration is evidence. */
export type UnconditionalExecutor = StrictUnion<
  | Readonly<{
      kind: "inspection";
      /** A decision inside a branch skips with that branch. */
      when?: DecisionGuard;
      /** Without a rule, an operator decides and the run waits. */
      rule?: DecisionRule;
    }>
  | Readonly<{
      kind: "batch";
      resource: ResourceId;
      program: BatchProgramId;
      carrier: CarrierRole;
      /** The transfer tasks that admit and remove this carrier. */
      load: TaskKey;
      unload: TaskKey;
    }>
  | Readonly<{
      kind: "declared";
      duration: TickDuration;
      evidence: Provenance;
    }>
  | Readonly<{
      kind: "attended";
      /** Work duration after arrival, including any loaded transport. */
      duration: TickDuration;
      evidence: Provenance;
      /** First available in this order. A single entry pins an assignment. */
      workers: readonly [ResourceId, ...ResourceId[]];
      start: LocationId;
      finish: LocationId;
    }>
  | Readonly<{
      kind: "native";
      operation: NativeOperation;
    }>
>;

/** A decision can omit process work. Carrier routes and release gates stay unconditional. */
export type TaskExecutor = StrictUnion<
  | UnconditionalExecutor
  | Readonly<{
      kind: "after-inspection";
      inspection: TaskKey;
      outcome: "accept" | "reject";
      work: Variant<UnconditionalExecutor, "declared" | "attended">;
    }>
>;

export function executionWork(executor: TaskExecutor): UnconditionalExecutor {
  return executor.kind === "after-inspection" ? executor.work : executor;
}

/**
 * A pool input draws from any released lot of the product, so several
 * instances share one batch. A lot input draws from this instance's own lot.
 */
export type MaterialInput =
  | Readonly<{
      kind: "pool";
      product: ProductId;
      quantity: MaterialQuantity;
      lot?: never;
    }>
  | Readonly<{
      kind: "lot";
      lot: LotKey;
      quantity: MaterialQuantity;
      product?: never;
    }>;

export type LotHolder =
  | Readonly<{ kind: "storage"; storage: StorageId; carrier?: never }>
  | Readonly<{ kind: "carrier"; carrier: CarrierRole; storage?: never }>;

/**
 * A lot output stays in the factory; a held lot cannot fulfil a claim until a
 * later task releases it. An exit output leaves through its destination.
 * A measured output takes its quantity from the native controller's
 * completion; `bound` is the most it may report. A task with a measured
 * output measures all its outputs, and they balance its consumed inputs.
 */
export type MaterialOutput = StrictUnion<
  | Readonly<{
      kind: "inspection-exit";
      inspections: readonly TaskKey[];
      product: ProductId;
      quantity: MaterialQuantity;
      destination: DestinationId;
      rejectedProduct: ProductId;
      rejectedDestination: DestinationId;
    }>
  | Readonly<{
      kind: "lot";
      lot: LotKey;
      product: ProductId;
      quantity: MaterialQuantity;
      holder: LotHolder;
      disposition: "released" | "held";
      report: DestinationId | null;
      destination?: never;
    }>
  | Readonly<{
      kind: "exit";
      product: ProductId;
      quantity: MaterialQuantity;
      destination: DestinationId;
      lot?: never;
      holder?: never;
      disposition?: never;
      report?: never;
    }>
  | Readonly<{
      kind: "measured-lot";
      lot: LotKey;
      product: ProductId;
      measurement: MeasurementId;
      bound: MaterialQuantity;
      holder: LotHolder;
      disposition: "released" | "held";
      report: DestinationId | null;
      destination?: never;
    }>
  | Readonly<{
      kind: "measured-exit";
      product: ProductId;
      measurement: MeasurementId;
      bound: MaterialQuantity;
      destination: DestinationId;
      lot?: never;
      holder?: never;
      disposition?: never;
      report?: never;
    }>
>;

/** The declared quantity, or the bound of a measured one. */
export function outputCeiling(output: MaterialOutput): MaterialQuantity {
  return output.kind === "measured-lot" || output.kind === "measured-exit"
    ? output.bound
    : output.quantity;
}

/**
 * Declared offsets start at work arrival for attended tasks and at dispatch
 * otherwise. Native handling evidences its own boundaries.
 */
export type MoveTiming =
  | Readonly<{
      kind: "declared";
      pickupAfter: TickDuration;
      placementAfter: TickDuration;
    }>
  | Readonly<{ kind: "native"; pickupAfter?: never; placementAfter?: never }>;

/**
 * Acquire binds an empty carrier to the instance. Move reserves its destination
 * before pickup; the source stays occupied until pickup and the destination
 * becomes occupied at placement. Release returns an empty carrier to the pool.
 */
export type CarrierStep =
  | Readonly<{
      kind: "acquire";
      role: CarrierRole;
      from: StorageId;
      to?: never;
      timing?: never;
    }>
  | Readonly<{
      kind: "move";
      role: CarrierRole;
      from: StorageId;
      to: StorageId;
      timing: MoveTiming;
    }>
  | Readonly<{
      kind: "release";
      role: CarrierRole;
      from?: never;
      to?: never;
      timing?: never;
    }>;

/** Inputs are consumed, and outputs and releases recorded, at completion. */
export type TaskDefinition = Readonly<{
  key: TaskKey;
  priority: number;
  /** Earliest dispatch, measured from this workflow instance's arrival. */
  releaseAfter: TickDuration;
  prerequisites: readonly TaskKey[];
  claims: readonly ResourceClaim[];
  executor: TaskExecutor;
  inputs: readonly MaterialInput[];
  outputs: readonly MaterialOutput[];
  releases: readonly LotKey[];
  carriers: readonly CarrierStep[];
}>;

/**
 * A finite, acyclic task graph. An order completes once, when every task has;
 * a production workflow supplies material and completes no order.
 */
export type WorkflowDefinition = Readonly<{
  id: WorkflowId;
  revision: Sha256Hex;
  demand: "order" | "production";
  tasks: readonly TaskDefinition[];
}>;

export type ArrivalSource = Readonly<{
  id: ArrivalSourceId;
  workflow: WorkflowId;
}> &
  (
    | Readonly<{
        kind: "explicit";
        arrivals: readonly Readonly<{ time: LogicalTime; quantity: number }>[];
        first?: never;
        interval?: never;
        limit?: never;
      }>
    | Readonly<{
        kind: "periodic";
        first: LogicalTime;
        interval: TickDuration;
        limit:
          | Readonly<{ kind: "count"; count: number }>
          | Readonly<{ kind: "until"; end: LogicalTime }>;
        arrivals?: never;
      }>
  );

/** No task claiming the resource may start inside the interval. */
export type AvailabilityInterval = Readonly<{
  id: AvailabilityId;
  resource: ResourceId;
  interval: Interval;
}>;

export type RunLimits = Readonly<{
  horizon: LogicalTime;
  eventCap: number;
}>;

/** A task in one exact arrival occurrence. Sequence starts at zero. */
export type InstanceTaskReference = Readonly<{
  source: ArrivalSourceId;
  sequence: number;
  key: TaskKey;
}>;

export type InstanceDependency = Readonly<{
  task: InstanceTaskReference;
  prerequisite: InstanceTaskReference;
}>;

export type CompiledScenario = Readonly<{
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  id: ScenarioId;
  policy: typeof DISPATCH_POLICY;
  sources: readonly SourceRevision[];
  limits: RunLimits;
  products: readonly ProductDefinition[];
  destinations: readonly ReportingDestination[];
  resources: readonly ResourceDefinition[];
  storages: readonly StorageDefinition[];
  carriers: readonly CarrierDefinition[];
  cells: readonly PhysicalCellDefinition[];
  stock: readonly InitialLot[];
  workflows: readonly WorkflowDefinition[];
  arrivals: readonly ArrivalSource[];
  dependencies: readonly InstanceDependency[];
  availability: readonly AvailabilityInterval[];
}>;
