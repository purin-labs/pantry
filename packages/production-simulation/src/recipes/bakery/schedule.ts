import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import { HUMAN_CELL_TRANSFER } from "./human-cell-transfer.ts";
import {
  parseProductionManualTasks,
  validProductionWorkflow,
  type ProductionManualTask,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import { err, ok, type Result } from "../../result.ts";
import {
  financierOperations,
  type StationId,
  type Operation,
  type Settings,
} from "@purin-labs/bakery-model/bakery";
import type {
  PhysicsOutcome,
  PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import type {
  ProductionWorkcells,
  ProductionWorkcell,
  PlannedProductionWorkcell,
} from "./production-workcells.ts";
import { type CompletedAttempt, type HeldAttempt } from "./workcell-attempt.ts";
import { physicsDuration, physicsOutcome } from "./physics-playback.ts";
import {
  coldCell,
  type CellId,
  nativeSkills,
  type CellInstance,
  type NativeSkill,
} from "./workcell-instances.ts";
import {
  NO_FAULTS,
  absentBaker,
  coldTrayHandlingSeconds,
  handlingTaskId,
  outageResourceName,
  recoveryFor,
  resourceOutage,
  type OutageResource,
  type RunFaults,
} from "./run-faults.ts";
import {
  workcellResources,
  type WorkcellResource,
  type WorkcellResourceId,
} from "./workcell-input.ts";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever, compareCodePoints } from "@purin-labs/std";
import {
  along,
  route,
  resolveScheduleLayout,
  station,
  stationLabel,
  stations,
  transferTiming,
  travelSeconds,
  workerStart,
  type Point,
  type ResolvedScheduleLayout,
  type ScheduleSpatialLayout,
  type Station,
} from "./schedule-layout.ts";
export * from "./schedule-layout.ts";

export type ScheduleVariant = "normal" | "outage";

export type Batch = {
  readonly id: string;
  readonly quantity: number;
  readonly trays: number;
  readonly release: number;
  readonly deadline: number;
};

type BatchProcedure = Batch & Readonly<{ steps: readonly Step[] }>;

// The cold workcell's supported first-skill requests. Continuations resume
// their predecessor's state inside the same cell.
export type WorkcellCapability = Readonly<{
  kind: "workcell-capability";
  id: CellInstance["id"];
  skills: readonly NativeSkill[];
  station: CellInstance["station"];
  capacity: CellInstance["capacity"];
}>;
export type StationResource = Readonly<{
  kind: "station";
  id: StationId;
  capacity: number;
  unit: "batches" | "trays";
}>;

const resolved: unique symbol = Symbol("resolved bakery run input");
type RunInputData = Readonly<{
  settings: Settings;
  variant: ScheduleVariant;
  faults: RunFaults;
  // Rehearsal trays are batches of one tray; views name them as trays.
  unit: "batch" | "tray";
  manualTasks: readonly ProductionManualTask[];
  batches: readonly BatchProcedure[];
  resources: readonly HumanResource[];
  stationResources: readonly StationResource[];
  workcellResources: readonly WorkcellResource[];
  /** The layout that the run used; absent on the built-in layout. */
  layout?: ResolvedScheduleLayout;
}>;
type RunModel =
  | (RunInputData &
      Readonly<{
        source: "financier";
        fingerprint: null;
        workcells: readonly [];
      }>)
  | (RunInputData &
      Readonly<{
        source: "production";
        fingerprint: string;
        workcells: readonly WorkcellCapability[];
      }>);
export type ResolvedRunInput = RunModel & Readonly<{ [resolved]: true }>;
export type FinancierRunInput = VariantBy<
  ResolvedRunInput,
  "source",
  "financier"
>;

export type HumanId = `human-${number}`;
export type ProcessTaskId = `batch:${string}:process:${Operation}`;
export type TransferTaskId =
  `batch:${string}:transfer:${StationId}:${StationId}`;
export type BakeryTaskId =
  | ProcessTaskId
  | TransferTaskId
  | `batch:${string}:native:${string}`
  | `batch:${string}:handoff:${string}`;

export type KitchenZoneId = "prep-zone" | "hearth-zone" | "finishing-zone";

export type StaffRoleId = "tourier-prep" | "four-finition" | "commis-vitrine";

export type StaffRoleProfile = Readonly<{
  role: StaffRoleId;
  roleTitle: string;
  shortRole: string;
  badgeTag: string;
  zone: KitchenZoneId;
  zoneLabel: string;
  homeStation: StationId;
  preferredStations: readonly StationId[];
}>;

export const KITCHEN_ZONE_LABELS: Readonly<Record<KitchenZoneId, string>> = {
  "prep-zone": "Prep & Portioning Zone",
  "hearth-zone": "Hearth & Cooling Zone",
  "finishing-zone": "Packing & Vitrine Zone",
};

export const STAFF_ROLE_PROFILES: readonly StaffRoleProfile[] = [
  {
    role: "tourier-prep",
    roleTitle: "Chef de Partie — Prep & Portioning",
    shortRole: "Prep & Portioning",
    badgeTag: "Prep",
    zone: "prep-zone",
    zoneLabel: KITCHEN_ZONE_LABELS["prep-zone"],
    homeStation: "stage",
    preferredStations: ["stage", "portion"],
  },
  {
    role: "four-finition",
    roleTitle: "Chef — Hearth, Cooling & Packing",
    shortRole: "Hearth & Cooling",
    badgeTag: "Hearth",
    zone: "hearth-zone",
    zoneLabel: KITCHEN_ZONE_LABELS["hearth-zone"],
    homeStation: "cool",
    preferredStations: ["bake", "cool", "pack"],
  },
  {
    role: "commis-vitrine",
    roleTitle: "Commis — Ballotin Packing & Vitrine",
    shortRole: "Packing & Vitrine",
    badgeTag: "Pack",
    zone: "finishing-zone",
    zoneLabel: KITCHEN_ZONE_LABELS["finishing-zone"],
    homeStation: "pack",
    preferredStations: ["pack", "cool"],
  },
];

export function staffRoleProfileFor(
  workerIdOrIndex: HumanId | number,
): StaffRoleProfile {
  const idx =
    typeof workerIdOrIndex === "number"
      ? workerIdOrIndex
      : Math.max(0, Number(workerIdOrIndex.slice(6)) - 1);
  return (
    STAFF_ROLE_PROFILES[idx % STAFF_ROLE_PROFILES.length] ??
    STAFF_ROLE_PROFILES[0]!
  );
}

export function stationZone(id: StationId): KitchenZoneId {
  switch (id) {
    case "stage":
    case "portion":
      return "prep-zone";
    case "bake":
    case "cool":
      return "hearth-zone";
    case "pack":
      return "finishing-zone";
    default:
      return assertNever(id, "Unexpected station id");
  }
}

export function stationZoneLabel(id: StationId): string {
  return KITCHEN_ZONE_LABELS[stationZone(id)];
}

export type ZoneHandoffInfo = Readonly<{
  fromZone: KitchenZoneId;
  toZone: KitchenZoneId;
  fromZoneLabel: string;
  toZoneLabel: string;
  isZoneBoundary: boolean;
  summary: string;
  shortSummary: string;
  passStation: StationId;
  sendingRole: StaffRoleProfile;
  receivingRole: StaffRoleProfile;
}>;

export function transferZoneHandoff(
  from: StationId,
  to: StationId,
  workerCount = 2,
): ZoneHandoffInfo {
  const fromZone = stationZone(from);
  const toZone = stationZone(to);
  const fromZoneLabel = KITCHEN_ZONE_LABELS[fromZone];
  const toZoneLabel = KITCHEN_ZONE_LABELS[toZone];
  const isZoneBoundary = fromZone !== toZone;
  const sendingRole =
    fromZone === "prep-zone"
      ? STAFF_ROLE_PROFILES[0]!
      : fromZone === "hearth-zone"
        ? STAFF_ROLE_PROFILES[Math.min(1, Math.max(0, workerCount - 1))]!
        : STAFF_ROLE_PROFILES[Math.min(2, Math.max(0, workerCount - 1))]!;
  const receivingRole =
    toZone === "prep-zone"
      ? STAFF_ROLE_PROFILES[0]!
      : toZone === "hearth-zone"
        ? STAFF_ROLE_PROFILES[Math.min(1, Math.max(0, workerCount - 1))]!
        : STAFF_ROLE_PROFILES[Math.min(2, Math.max(0, workerCount - 1))]!;
  return {
    fromZone,
    toZone,
    fromZoneLabel,
    toZoneLabel,
    isZoneBoundary,
    summary: isZoneBoundary
      ? `Zone handoff: ${fromZoneLabel} → ${toZoneLabel} (${sendingRole.shortRole} → ${receivingRole.shortRole})`
      : `Intra-zone transfer within ${fromZoneLabel}`,
    shortSummary: isZoneBoundary
      ? `Zone handoff · ${fromZone.replace("-zone", "")} → ${toZone.replace("-zone", "")}`
      : `Within ${fromZoneLabel}`,
    passStation: to,
    sendingRole,
    receivingRole,
  };
}

export type HumanResource = Readonly<{
  kind: "human";
  id: HumanId;
  name: string;
  role: StaffRoleId;
  roleTitle: string;
  shortRole: string;
  zone: KitchenZoneId;
  zoneLabel: string;
  homeStation: StationId;
  start: Point;
  capabilities: readonly ["manual-processing", "tray-handling"];
}>;

type Labor =
  | {
      readonly attended: true;
      readonly executor: HumanId;
      readonly emptyRoute: readonly Point[];
    }
  | {
      readonly attended: false;
      readonly executor?: never;
      readonly emptyRoute?: never;
    };

type Span = {
  readonly batch: string;
  readonly station: StationId;
  readonly start: number;
  readonly end: number;
};

export type Process = Span &
  Labor & {
    readonly id: ProcessTaskId;
    readonly kind: "process";
    readonly operation: Operation;
    readonly arrival: number;
  };

export type Transfer = Span & {
  readonly id: TransferTaskId;
  readonly kind: "transfer";
  readonly attended: true;
  readonly executor: HumanId;
  readonly from: StationId;
  readonly pickupStart: number;
  readonly pickup: number;
  readonly loadedEnd: number;
  readonly emptyRoute: readonly Point[];
  readonly route: readonly Point[];
};

export type Wait = Span & {
  readonly kind: "wait";
  readonly location: StationId | null;
  readonly reason:
    "station" | "worker" | "outage" | "cycle" | "dependency" | "start";
  readonly label: string;
};
export type UnresolvedWait = Readonly<{
  batch: string;
  location: StationId | null;
  station: StationId;
  reason: Wait["reason"];
  label: string;
  time: number;
}>;

export type Handoff = Span &
  Readonly<{
    id: `batch:${string}:handoff:${string}`;
    kind: "handoff";
    phase: "stage" | "clear" | "transfer";
    operationId: string;
    cellId: CellId;
    attended: true;
    executor: HumanId;
    emptyRoute: readonly Point[];
    arrival: number;
    outcome: "completed" | "failed";
  }>;
export type NativeBakeryTask = Span &
  Readonly<{
    id: `batch:${string}:native:${string}`;
    kind: "native";
    attended: false;
    executor?: never;
    operation: ProductionWorkcell &
      Readonly<{ attempt: CompletedAttempt | HeldAttempt }>;
    recording: PhysicsReplay;
  }> &
  (
    | Readonly<{ outcome: "completed" }>
    | Readonly<{ outcome: "failed" }>
    | Readonly<{ outcome: "execution-error" }>
  );
export type BakeryTask = Process | Transfer | Handoff | NativeBakeryTask;
export type NativeHold = Readonly<{
  operation: ProductionWorkcell;
  attemptId: string;
  start: number;
}> &
  (
    | Readonly<{
        kind: "awaiting-evidence";
        settledTime?: never;
        failure?: never;
      }>
    | Readonly<{
        kind: "failed";
        settledTime: number;
        failure: Exclude<PhysicsOutcome, { kind: "completed" }>;
        recoveredAt: number | null;
      }>
  );
// An injected staging or clearance failure holds its baker and the cell until
// an assumed recovery, if any, releases them.
export type HandlingFailure = Readonly<{
  task: Handoff;
  failedAt: number;
  recoveredAt: number | null;
}>;
export type InjectedFailureEvidence = Readonly<{
  source: "injected-failure";
  bakeryTaskId: Handoff["id"];
  time: number;
}>;

export type NativeReservation = Readonly<{
  operationId: string;
  materialId: ProductionWorkcell["material"]["materialId"];
  attemptId: string;
  resources: readonly (
    WorkcellResourceId | typeof HUMAN_CELL_TRANSFER.buffer
  )[];
  start: number;
}> &
  (
    | Readonly<{ kind: "reserved"; end?: never; heldAt?: never }>
    | Readonly<{ kind: "released"; end: number; heldAt?: never }>
    | Readonly<{ kind: "held"; heldAt: number; end?: never }>
  );

export type SimulatedCompletion = Readonly<{
  source: "assumed-simulation";
  bakeryTaskId: BakeryTaskId;
  time: number;
}>;

export type TaskEvent =
  | Readonly<{
      kind: "started";
      time: number;
      task: BakeryTask;
      evidence?: never;
    }>
  | Readonly<{
      kind: "native-awaiting";
      time: number;
      operation: ProductionWorkcell;
      attemptId: string;
      task?: never;
      evidence?: never;
    }>
  | Readonly<{
      kind: "picked-up";
      time: number;
      task: Transfer;
      evidence?: never;
    }>
  | Readonly<{
      kind: "completed";
      time: number;
      task: Exclude<BakeryTask, NativeBakeryTask>;
      evidence: SimulatedCompletion;
    }>
  | Readonly<{
      kind: "native-settled";
      time: number;
      task: NativeBakeryTask;
      evidence?: never;
    }>
  | Readonly<{
      kind: "failed";
      time: number;
      task: Handoff;
      evidence: InjectedFailureEvidence;
    }>;

export type TaskSnapshot =
  | Readonly<{ kind: "queued"; task: BakeryTask; evidence?: never }>
  | Readonly<{ kind: "running"; task: BakeryTask; evidence?: never }>
  | Readonly<{
      kind: "completed";
      task: Exclude<BakeryTask, NativeBakeryTask>;
      evidence: SimulatedCompletion;
    }>
  | Readonly<{
      kind: "completed";
      task: VariantBy<NativeBakeryTask, "outcome", "completed">;
      evidence: Readonly<{
        source: "native-recording";
        recording: PhysicsReplay;
      }>;
    }>
  | Readonly<{
      kind: "recovery-required";
      task: VariantBy<
        NativeBakeryTask,
        "outcome",
        "failed" | "execution-error"
      >;
      evidence?: never;
    }>
  | Readonly<{
      kind: "failed";
      task: Handoff;
      evidence: InjectedFailureEvidence;
    }>;

export type SimulationStep = Readonly<{
  time: number;
  events: readonly TaskEvent[];
}>;

export type Interval = BakeryTask | Wait;

type WorkState =
  | {
      kind: "pending";
      index: number;
      location: StationId | null;
      task?: never;
      completion?: never;
    }
  | {
      kind: "running";
      index: number;
      task: BakeryTask;
      location?: never;
      completion?: never;
    }
  | {
      kind: "native-held";
      index: number;
      location: StationId;
      hold: NativeHold;
      task?: never;
      completion?: never;
    }
  | {
      kind: "failed";
      index: number;
      location: StationId;
      hold?: never;
      task?: never;
      completion?: never;
    }
  | {
      kind: "complete";
      completion: number;
      index?: never;
      location?: never;
      task?: never;
    };

type Work = { batch: BatchProcedure; state: WorkState };

type Worker = {
  resource: HumanResource;
  position: Point;
  state: "idle" | "busy";
};

export type OvenCycle = {
  readonly id: number;
  readonly batches: readonly string[];
  readonly trays: number;
  readonly start: number;
  readonly end: number;
};

type OvenState =
  | { kind: "idle" }
  | { kind: "loading"; closeAt: number }
  | { kind: "baking"; end: number }
  | { kind: "unloading" };

// An assumed recovery releases a failed task's baker and cell at its time.
type Release = Readonly<{
  time: number;
  worker: HumanId | null;
  root: string;
  batch: string;
  station: StationId;
}>;

type RunData = RunModel & {
  readonly nativeHolds: readonly NativeHold[];
  readonly handlingFailures: readonly HandlingFailure[];
  readonly nativeReservations: readonly NativeReservation[];
  readonly unresolvedWaits: readonly UnresolvedWait[];
  readonly taskEvents: readonly TaskEvent[];
  readonly intervals: readonly Interval[];
  readonly cycles: readonly OvenCycle[];
  readonly completions: readonly { batch: string; time: number }[];
  readonly events: readonly number[];
  readonly end: number;
};

export type Run = RunData &
  (
    | { readonly kind: "complete"; readonly unfinished?: never }
    | {
        readonly kind: "horizon" | "blocked";
        readonly unfinished: readonly string[];
      }
  );

type Step =
  | { kind: "native"; station: StationId; operation: ProductionWorkcell }
  | {
      kind: "planned";
      station: StationId;
      operation: PlannedProductionWorkcell;
    }
  | {
      kind: "handoff";
      station: StationId;
      phase: "stage" | "clear" | "transfer";
      operation: ProductionWorkcell;
    }
  | { kind: "transfer"; station: StationId }
  | {
      kind: "process";
      station: StationId;
      operation: Operation;
      attended: boolean;
    };

const steps = procedureSteps();
const bakingStepIndex = steps.findIndex(isBakingStep);

function isBakingStep(step: Step): boolean {
  return step.kind === "process" && step.operation === "bake";
}

function procedureSteps(): readonly Step[] {
  const result: Step[] = [];
  let previous: StationId | null = null;
  for (const item of financierOperations) {
    if (previous !== null && previous !== item.station) {
      result.push({ kind: "transfer", station: item.station });
    }
    result.push({
      kind: "process",
      station: item.station,
      operation: item.operation,
      attended: item.attended,
    });
    previous = item.station;
  }
  return result;
}

function productionSteps(
  batchId: string,
  operations: readonly ProductionWorkcell[],
): readonly Step[] {
  if (operations.length === 0) return steps;
  const result: Step[] = [];
  for (const step of steps) {
    result.push(step);
    if (step.kind !== "process" || step.operation !== "cool") continue;
    for (const operation of operations)
      if (operation.batchId === batchId)
        result.push(...chainSteps(operation, [operation], []));
  }
  return result;
}

// One tray chain holds the cell from staging through clearance: its skills
// continue the same MuJoCo state, so no other tray may enter between them.
function chainSteps(
  root: ProductionWorkcell,
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
): readonly Step[] {
  const result: Step[] = [
    { kind: "handoff", station: "cool", phase: "stage", operation: root },
  ];
  let last = root;
  for (const operation of operations) {
    if (!sameTray(root, operation)) continue;
    if (operation.start.kind === "restaged")
      result.push({
        kind: "handoff",
        station: "cool",
        phase: "transfer",
        operation,
      });
    result.push({ kind: "native", station: "cool", operation });
    last = operation;
  }
  for (const operation of planned)
    if (sameTray(root, operation))
      result.push({ kind: "planned", station: "cool", operation });
  result.push({
    kind: "handoff",
    station: "cool",
    phase: "clear",
    operation: last,
  });
  return result;
}

function sameTray(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return operation.batchId === root.batchId && operation.tray === root.tray;
}

function chainRoot(
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): string {
  return `batch:${operation.batchId}:native:${operation.tray}`;
}

function nativeTaskId(operation: ProductionWorkcell): NativeBakeryTask["id"] {
  const prefix = `batch:${operation.batchId}:native:`;
  if (!operation.id.startsWith(prefix))
    throw new Error("Native operation identity is invalid");
  return `batch:${operation.batchId}:native:${operation.id.slice(prefix.length)}`;
}

// A continuation's recording contains its predecessor's evidence as a prefix.
export function continuationPrefix(operation: ProductionWorkcell): number {
  switch (operation.start.kind) {
    case "reset":
    case "restaged":
      return 0;
    case "continuation":
      return physicsDuration(operation.start.handoff.predecessor);
    case "continued":
      return operation.start.prefixSeconds;
  }
}

function rehearsalBatches(
  plan: ProductionWorkcells,
): readonly BatchProcedure[] {
  const batches: BatchProcedure[] = [];
  for (const root of plan.operations) {
    if (root.step !== 1) continue;
    batches.push({
      id: root.batchId,
      quantity: plan.settings.piecesPerTray,
      trays: 1,
      release: 0,
      deadline: plan.settings.horizonMinutes * 60,
      steps: chainSteps(root, plan.operations, plan.planned),
    });
  }
  return batches;
}

function stationResources(settings: Settings): readonly StationResource[] {
  return stations.map(stationResource.bind(null, settings));
}

function stationResource(settings: Settings, item: Station): StationResource {
  return {
    kind: "station",
    id: item.id,
    capacity:
      item.id === "cool"
        ? settings.rackTrays
        : item.id === "bake"
          ? settings.ovenTrays
          : 1,
    unit: item.id === "cool" || item.id === "bake" ? "trays" : "batches",
  };
}

function humanResources(
  settings: Settings,
  layout: ResolvedScheduleLayout | undefined,
): readonly HumanResource[] {
  const resources: HumanResource[] = [];
  for (let id = 0; id < settings.workerCount; id++) {
    const start = workerStart(id, layout);
    const profile = staffRoleProfileFor(id);
    resources.push({
      kind: "human",
      id: `human-${id + 1}`,
      name: `Baker ${id + 1}`,
      role: profile.role,
      roleTitle: profile.roleTitle,
      shortRole: profile.shortRole,
      zone: profile.zone,
      zoneLabel: profile.zoneLabel,
      homeStation: profile.homeStation,
      start,
      capabilities: ["manual-processing", "tray-handling"],
    });
  }
  return resources;
}

function batchProcedures(
  settings: Settings,
  operations: readonly ProductionWorkcell[],
): readonly BatchProcedure[] {
  const batches: BatchProcedure[] = [];
  for (let index = 0; index < settings.batchCount; index++) {
    const id = String.fromCharCode(65 + index);
    batches.push({
      id,
      quantity: settings.piecesPerTray * settings.traysPerBatch,
      trays: settings.traysPerBatch,
      release: index * 120,
      deadline: 2700 + index * 1200,
      steps: productionSteps(id, operations),
    });
  }
  return batches;
}

export function resolveFinancierRun(
  settings: Settings,
  variant: ScheduleVariant,
  layout: ScheduleSpatialLayout | null,
): FinancierRunInput {
  return financierRun(settings, variant, [], layout);
}

/** Shared scenario fields already passed the production authoring boundary. */
export function resolveSavedOvenFinancierRun(
  definition: VariantBy<ProductionScenario, "route", "oven-rack">,
): FinancierRunInput {
  // A saved oven route records no floor layout, so it uses the built-in one.
  return financierRun(
    definition.settings,
    definition.variant,
    definition.manualTasks,
    null,
  );
}

/** Normalize saved or authored rules before either scheduler consumes them. */
export function resolveAuthoredFinancierRun(
  settings: Settings,
  variant: ScheduleVariant,
  raw: unknown,
  layout: ScheduleSpatialLayout | null,
): Result<
  FinancierRunInput,
  Readonly<{ code: "invalid_manual_tasks" | "invalid_dependencies" }>
> {
  const rules = parseProductionManualTasks(raw, settings, [], "cold-racking");
  if (rules === null) return err({ code: "invalid_manual_tasks" });
  if (!validProductionWorkflow(settings, [], rules, "cold-racking"))
    return err({ code: "invalid_dependencies" });
  return ok(financierRun(settings, variant, rules, layout));
}

function financierRun(
  settings: Settings,
  variant: ScheduleVariant,
  manualTasks: readonly ProductionManualTask[],
  spatial: ScheduleSpatialLayout | null,
): FinancierRunInput {
  const layout = resolveScheduleLayout(spatial, settings.workerCount);
  return {
    [resolved]: true,
    source: "financier",
    fingerprint: null,
    settings,
    variant,
    faults: NO_FAULTS,
    unit: "batch",
    manualTasks,
    batches: batchProcedures(settings, []),
    resources: humanResources(settings, layout),
    stationResources: stationResources(settings),
    workcellResources: [],
    workcells: [],
    ...(layout === undefined ? {} : { layout }),
  };
}

export function resolveProductionRun(
  plan: ProductionWorkcells,
  spatial: ScheduleSpatialLayout | null,
): ResolvedRunInput {
  const layout = resolveScheduleLayout(spatial, plan.settings.workerCount);
  const resources = new Map<WorkcellResourceId, WorkcellResource>();
  const cells = new Set<CellId>();
  for (const operation of plan.operations) {
    cells.add(operation.attempt.input.bindings.cell);
    for (const resource of workcellResources(operation.attempt.input)) {
      resources.set(resource.id, resource);
    }
  }
  return {
    [resolved]: true,
    source: "production",
    fingerprint: plan.fingerprint,
    settings: plan.settings,
    variant: plan.variant,
    faults: plan.faults,
    unit: plan.procedure === "rehearsal" ? "tray" : "batch",
    manualTasks: plan.manualTasks,
    batches:
      plan.procedure === "rehearsal"
        ? rehearsalBatches(plan)
        : batchProcedures(plan.settings, plan.operations),
    resources: humanResources(plan.settings, layout),
    stationResources: stationResources(plan.settings),
    workcellResources: [...resources.values()],
    workcells: [...cells].map(workcellCapability.bind(null, plan.procedure)),
    ...(layout === undefined ? {} : { layout }),
  };
}

function workcellCapability(
  procedure: ProductionWorkcells["procedure"],
  id: CellId,
): WorkcellCapability {
  const cell = coldCell(id);
  return {
    kind: "workcell-capability",
    id,
    skills: procedure === "rehearsal" ? nativeSkills(cell) : ["table-to-rack"],
    station: cell.station,
    capacity: cell.capacity,
  };
}

function hasCellId(id: CellId, cell: WorkcellCapability): boolean {
  return cell.id === id;
}

function runModel(input: ResolvedRunInput): RunModel {
  const shared = {
    settings: input.settings,
    manualTasks: input.manualTasks,
    variant: input.variant,
    faults: input.faults,
    unit: input.unit,
    batches: input.batches,
    resources: input.resources,
    stationResources: input.stationResources,
    workcellResources: input.workcellResources,
    ...(input.layout === undefined ? {} : { layout: input.layout }),
  };
  switch (input.source) {
    case "financier":
      return {
        ...shared,
        source: "financier",
        fingerprint: null,
        workcells: [],
      };
    case "production":
      return {
        ...shared,
        source: "production",
        fingerprint: input.fingerprint,
        workcells: input.workcells,
      };
    default:
      return assertNever(input, "Unexpected simulator state");
  }
}

function hasStationId(id: StationId, resource: StationResource): boolean {
  return resource.id === id;
}

export function outageAt(
  run: Pick<Run, "variant" | "settings">,
  time: number,
): boolean {
  return (
    run.variant === "outage" &&
    time >= run.settings.outageStart * 60 &&
    time < run.settings.outageEnd * 60
  );
}

export function simulate(
  settings: Settings,
  variant: ScheduleVariant,
  layout: ScheduleSpatialLayout | null,
): Run {
  const execution = simulateSteps(
    resolveFinancierRun(settings, variant, layout),
  );
  let step = execution.next();
  while (!step.done) step = execution.next();
  return step.value;
}

export function simulateProduction(
  plan: ProductionWorkcells,
  layout: ScheduleSpatialLayout | null,
): Run {
  const execution = simulateSteps(resolveProductionRun(plan, layout));
  let step = execution.next();
  while (!step.done) step = execution.next();
  return step.value;
}

export function* simulateSteps(
  input: ResolvedRunInput,
): Generator<SimulationStep, Run, void> {
  const { settings, variant, batches, layout } = input;
  const model = runModel(input);
  const workers: Worker[] = input.resources.map(workerFromResource);
  const work: Work[] = [];
  const intervals: Interval[] = [];
  const completions: { batch: string; time: number }[] = [];
  const reservations = new Map<StationId, Set<string>>();
  const checkpoints = new Set<number>([0]);
  const cycles: OvenCycle[] = [];
  const taskEvents: TaskEvent[] = [];
  const completedTasks = new Set<string>();
  const nativeHolds: NativeHold[] = [];
  const handlingFailures: HandlingFailure[] = [];
  const releases: Release[] = [];
  const nativeReservations: NativeReservation[] = [];
  const unresolvedWaits: UnresolvedWait[] = [];
  let emittedEvents = 0;
  let oven: OvenState = { kind: "idle" };
  for (const item of stations) {
    reservations.set(item.id, new Set());
  }
  for (const batch of batches) {
    work.push({
      batch,
      state: { kind: "pending", index: 0, location: null },
    });
  }
  const horizon = settings.horizonMinutes * 60;
  let time = 0;
  while (true) {
    for (const item of work) {
      if (item.state.kind !== "running") {
        continue;
      }
      const task = item.state.task;
      if (task.kind === "transfer" && time === task.pickup) {
        reservations.get(task.from)!.delete(item.batch.id);
        taskEvents.push({ kind: "picked-up", time, task });
      }
      if (task.end > time) {
        continue;
      }
      if (task.attended) {
        const worker = allocatedWorker(workers, task.executor);
        // A failed handling task keeps its baker until recovery.
        worker.state =
          task.kind === "handoff" && task.outcome === "failed"
            ? "busy"
            : "idle";
        worker.position = station(task.station, layout).handoff;
      }
      if (task.kind === "handoff" && task.outcome === "failed") {
        const recovery = recoveryFor(input.faults, task.id);
        const recoveredAt = recovery === null ? null : time + recovery.seconds;
        handlingFailures.push({ task, failedAt: time, recoveredAt });
        taskEvents.push({
          kind: "failed",
          time,
          task,
          evidence: { source: "injected-failure", bakeryTaskId: task.id, time },
        });
        holdNativeReservation(
          nativeReservations,
          reservationForChain(nativeReservations, task.operationId),
          time,
        );
        if (recoveredAt !== null)
          releases.push({
            time: recoveredAt,
            worker: task.executor,
            root: task.operationId,
            batch: item.batch.id,
            station: task.station,
          });
        item.state = {
          kind: "failed",
          index: item.state.index,
          location: task.station,
        };
        continue;
      }
      if (task.kind === "native") {
        taskEvents.push({ kind: "native-settled", time, task });
        if (task.outcome !== "completed") {
          const failure = physicsOutcome(task.recording);
          if (failure.kind === "completed")
            throw new Error("Native failure lost its result");
          const recovery = recoveryFor(input.faults, task.operation.id);
          const hold: NativeHold = {
            kind: "failed",
            operation: task.operation,
            attemptId: task.operation.attempt.input.request.attemptId,
            start: task.start,
            settledTime: time,
            failure,
            recoveredAt: recovery === null ? null : time + recovery.seconds,
          };
          if (hold.recoveredAt !== null)
            releases.push({
              time: hold.recoveredAt,
              worker: null,
              root: chainRoot(task.operation),
              batch: item.batch.id,
              station: task.station,
            });
          nativeHolds.push(hold);
          holdNativeReservation(
            nativeReservations,
            reservationForChain(nativeReservations, chainRoot(task.operation)),
            time,
          );
          item.state = {
            kind: "native-held",
            index: item.state.index,
            location: task.station,
            hold,
          };
          continue;
        }
        completedTasks.add(task.operation.id);
      } else {
        taskEvents.push({
          kind: "completed",
          time,
          task,
          evidence: {
            source: "assumed-simulation",
            bakeryTaskId: task.id,
            time,
          },
        });
      }
      completedTasks.add(task.id);
      if (task.kind === "handoff" && task.phase === "transfer") {
        const next = batchStep(item.batch, item.state.index + 1);
        if (next.kind !== "native")
          throw new Error("Human placement must precede its receiving task");
        releaseNativeReservation(
          nativeReservations,
          reservationForChain(nativeReservations, task.operationId),
          time,
        );
        reserveNativeResources(nativeReservations, next.operation, time);
      }
      if (task.kind === "handoff" && task.phase === "clear") {
        releaseNativeReservation(
          nativeReservations,
          reservationForChain(nativeReservations, task.operationId),
          time,
        );
      }
      const index = item.state.index + 1;
      if (index === item.batch.steps.length) {
        reservations.get(task.station)!.delete(item.batch.id);
        completions.push({ batch: item.batch.id, time });
        item.state = { kind: "complete", completion: time };
      } else {
        item.state = { kind: "pending", index, location: task.station };
      }
    }
    for (const release of releases) {
      if (release.time !== time) continue;
      if (release.worker !== null)
        allocatedWorker(workers, release.worker).state = "idle";
      releaseNativeReservation(
        nativeReservations,
        reservationForChain(nativeReservations, release.root),
        time,
      );
      reservations.get(release.station)!.delete(release.batch);
    }
    const ovenOccupants = reservations.get("bake")!;
    if (oven.kind === "baking" && time >= oven.end) {
      oven = { kind: "unloading" };
    }
    if (
      oven.kind === "unloading" &&
      ovenOccupants.size === 0 &&
      !work.some(unloadingOven)
    ) {
      oven = { kind: "idle" };
    }
    const data: RunData = {
      ...model,
      taskEvents,
      nativeHolds,
      handlingFailures,
      nativeReservations,
      unresolvedWaits,
      intervals,
      cycles,
      completions,
      events: [...checkpoints].filter(beforeEnd.bind(null, time)).sort(numeric),
      end: time,
    };
    const unfinished = work.filter(notComplete).map(workId);
    if (unfinished.length === 0) {
      yield { time, events: taskEvents.slice(emittedEvents) };
      return { ...data, kind: "complete" };
    }
    if (time === horizon) {
      yield { time, events: taskEvents.slice(emittedEvents) };
      return { ...data, kind: "horizon", unfinished };
    }
    const waiting: {
      batch: string;
      location: StationId | null;
      station: StationId;
      reason: Wait["reason"];
      label: string;
    }[] = [];
    const absent = absentBaker(input.faults, time);
    const pending = work.filter(isPending).sort(priority);
    for (const item of pending) {
      if (item.state.kind !== "pending" || item.batch.release > time) {
        continue;
      }
      const index = item.state.index;
      const step = batchStep(item.batch, index);
      const destination = step.station;
      const occupied = reservations.get(destination)!;
      const stationResource = input.stationResources.find(
        hasStationId.bind(null, destination),
      );
      if (stationResource === undefined)
        throw new Error(`Missing station resource ${destination}`);
      const attended =
        step.kind === "transfer" ||
        step.kind === "handoff" ||
        (step.kind === "process" && step.attended);
      const manual = manualTaskRule(
        input.manualTasks,
        item.batch.id,
        step,
        item.state.location,
      );
      const worker = availableWorker(
        workers,
        step,
        manual?.workerId ?? null,
        absent,
        layout,
      );
      if (
        manual !== null &&
        (time < manual.earliestStartSeconds ||
          !manual.dependsOn.every(completedTasks.has.bind(completedTasks)))
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: time < manual.earliestStartSeconds ? "start" : "dependency",
          label:
            time < manual.earliestStartSeconds
              ? `Earliest task start ${clock(manual.earliestStartSeconds)}`
              : `Waiting for ${manual.dependsOn.filter(notCompletedTask.bind(null, completedTasks)).join(", ")}`,
        });
        continue;
      }
      const capacity =
        stationResource.unit === "trays"
          ? Math.floor(stationResource.capacity / settings.traysPerBatch)
          : stationResource.capacity;
      if (isBakingStep(step)) {
        continue;
      }
      if (
        step.kind === "handoff" &&
        step.phase === "stage" &&
        time < step.operation.earliestStartSeconds
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "start",
          label: `Earliest staging time ${clock(step.operation.earliestStartSeconds)}`,
        });
        continue;
      }
      if (
        step.kind === "handoff" &&
        step.phase === "stage" &&
        !step.operation.dependsOn.every(completedTasks.has.bind(completedTasks))
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "dependency",
          label: `Waiting for ${step.operation.dependsOn
            .filter(notCompletedTask.bind(null, completedTasks))
            .map(dependencyName.bind(null, work))
            .join(", ")}`,
        });
        continue;
      }
      if (step.kind === "native" || step.kind === "handoff") {
        const cell = input.workcells.find(
          hasCellId.bind(null, step.operation.attempt.input.bindings.cell),
        );
        if (
          cell === undefined ||
          cell.station !== destination ||
          !cell.skills.includes(
            step.operation.attempt.input.request.bakeryTaskId,
          )
        ) {
          throw new Error("Native operation has no compatible workcell");
        }
      }
      const conflict = conflictingNativeReservation(nativeReservations, step);
      if (conflict !== null) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "station",
          label: `Workcell resources reserved by ${conflict.operationId}`,
        });
        continue;
      }
      if (step.kind === "planned") {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "dependency",
          label: `Awaiting ${step.operation.predecessorId} continuation state`,
        });
        continue;
      }
      if (
        step.kind === "native" &&
        step.operation.step > 1 &&
        time < step.operation.earliestStartSeconds
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "start",
          label: `Earliest task start ${clock(step.operation.earliestStartSeconds)}; Robot cell held`,
        });
        continue;
      }
      const outage = resourceOutage(input.faults, stepResources(step), time);
      if (outage !== null) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "outage",
          label: `${outageResourceName(outage.resource)} unavailable until ${clock(outage.end)}${step.kind === "native" ? "; Robot cell held" : ""}`,
        });
        continue;
      }
      if (step.kind === "native") {
        const attempt = step.operation.attempt;
        if (attempt.kind === "awaiting-evidence") {
          const hold: NativeHold = {
            kind: "awaiting-evidence",
            operation: step.operation,
            attemptId: attempt.input.request.attemptId,
            start: time,
          };
          nativeHolds.push(hold);
          taskEvents.push({
            kind: "native-awaiting",
            time,
            operation: step.operation,
            attemptId: hold.attemptId,
          });
          item.state = {
            kind: "native-held",
            index,
            location: destination,
            hold,
          };
        } else if (
          attempt.kind === "completed" ||
          attempt.kind === "recovery-required"
        ) {
          const recording = attempt.recording;
          const task: NativeBakeryTask = {
            id: nativeTaskId(step.operation),
            kind: "native",
            batch: item.batch.id,
            station: destination,
            start: time,
            end:
              time +
              Math.max(
                0,
                physicsDuration(recording) - continuationPrefix(step.operation),
              ),
            attended: false,
            operation: { ...step.operation, attempt },
            recording,
            outcome: physicsOutcome(recording).kind,
          };
          intervals.push(task);
          taskEvents.push({ kind: "started", time, task });
          checkpoints.add(task.end);
          item.state = { kind: "running", index, task };
        } else {
          throw new Error(
            "Production requires a settled cold transfer attempt",
          );
        }
        continue;
      }
      if (
        destination === "bake" &&
        (oven.kind === "baking" ||
          oven.kind === "unloading" ||
          (oven.kind === "loading" && time >= oven.closeAt))
      ) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "cycle",
          label: "Waiting for the next oven cycle",
        });
        continue;
      }
      if (destination === "bake" && outageAt({ settings, variant }, time)) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "outage",
          label: `Oven unavailable until ${clock(settings.outageEnd * 60)}`,
        });
        continue;
      }
      if (!occupied.has(item.batch.id) && occupied.size >= capacity) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason: "station",
          label: `${stationLabel(destination)} full: batch ${[...occupied].join(", ")}`,
        });
        continue;
      }
      if (attended && !worker) {
        waiting.push({
          batch: item.batch.id,
          location: item.state.location,
          station: destination,
          reason:
            step.kind !== "handoff" &&
            manual?.workerId !== undefined &&
            manual.workerId === absent
              ? "outage"
              : "worker",
          label:
            step.kind === "handoff"
              ? `Assigned baker ${step.operation.workerId} is busy`
              : manual?.workerId !== null && manual?.workerId !== undefined
                ? manual.workerId === absent
                  ? `${outageResourceName(absent)} unavailable until ${clock(input.faults.outage?.end ?? time)}`
                  : `Assigned baker ${manual.workerId} is busy`
                : "All workers are busy",
        });
        continue;
      }
      let task: BakeryTask;
      if (step.kind === "handoff") {
        if (!worker) throw new Error("Staging and clearance require a worker");
        const emptyRoute = route(
          worker.position,
          station(destination, layout).handoff,
          layout,
        );
        const arrival =
          time +
          travelSeconds(
            worker.position,
            station(destination, layout).handoff,
            layout,
          );
        const id = handlingTaskId(
          item.batch.id,
          step.operation.tray,
          step.phase,
        );
        const duration =
          step.phase === "transfer"
            ? HUMAN_CELL_TRANSFER.pickupSeconds +
              HUMAN_CELL_TRANSFER.carrySeconds +
              HUMAN_CELL_TRANSFER.placementSeconds
            : coldTrayHandlingSeconds(step.phase);
        const end = arrival + duration;
        const failure = input.faults.failure;
        const failedAt =
          failure?.bakeryTaskId === id
            ? Math.min(time + failure.afterSeconds, end)
            : null;
        task = {
          id,
          kind: "handoff",
          phase: step.phase,
          operationId: chainRoot(step.operation),
          cellId: step.operation.attempt.input.bindings.cell,
          batch: item.batch.id,
          station: destination,
          start: time,
          arrival: failedAt === null ? arrival : Math.min(arrival, failedAt),
          end: failedAt ?? end,
          attended: true,
          executor: worker.resource.id,
          emptyRoute,
          outcome: failedAt === null ? "completed" : "failed",
        };
        if (step.phase === "stage") {
          reserveNativeResources(nativeReservations, step.operation, time);
        } else if (step.phase === "transfer") {
          const previous = reservationForChain(
            nativeReservations,
            chainRoot(step.operation),
          );
          releaseNativeReservation(nativeReservations, previous, time);
          nativeReservations.push({
            kind: "reserved",
            operationId: previous.operationId,
            materialId: previous.materialId,
            attemptId: step.operation.attempt.input.request.attemptId,
            resources: [
              ...new Set([
                ...previous.resources,
                ...Object.values(step.operation.material.resources),
                HUMAN_CELL_TRANSFER.buffer,
              ]),
            ],
            start: time,
          });
        }
        checkpoints.add(task.arrival);
      } else if (step.kind === "transfer") {
        if (!worker || item.state.location === null) {
          throw new Error("Transfer requires a worker and source");
        }
        const from = item.state.location;
        const emptyRoute = route(
          worker.position,
          station(from, layout).handoff,
          layout,
        );
        const loadedRoute = route(
          station(from, layout).handoff,
          station(destination, layout).handoff,
          layout,
        );
        const timing = transferTiming(settings, from, destination, layout);
        const pickupStart =
          time +
          travelSeconds(worker.position, station(from, layout).handoff, layout);
        const pickup = pickupStart + timing.pickupAfter;
        const loadedEnd = pickupStart + timing.loadedEndAfter;
        task = {
          id: `batch:${item.batch.id}:transfer:${from}:${destination}`,
          kind: "transfer",
          batch: item.batch.id,
          station: destination,
          from,
          start: time,
          pickupStart,
          pickup,
          loadedEnd,
          end: pickupStart + timing.duration,
          attended: true,
          executor: worker.resource.id,
          emptyRoute,
          route: loadedRoute,
        };
        checkpoints.add(pickup);
        checkpoints.add(loadedEnd);
      } else if (attended) {
        if (!worker) {
          throw new Error("Attended processing requires a worker");
        }
        const emptyRoute = route(
          worker.position,
          station(destination, layout).handoff,
          layout,
        );
        const arrival =
          time +
          travelSeconds(
            worker.position,
            station(destination, layout).handoff,
            layout,
          );
        task = {
          id: `batch:${item.batch.id}:process:${step.operation}`,
          kind: "process",
          batch: item.batch.id,
          station: destination,
          operation: step.operation,
          start: time,
          arrival,
          end: arrival + settings[step.operation] * 60,
          attended: true,
          executor: worker.resource.id,
          emptyRoute,
        };
        checkpoints.add(arrival);
      } else {
        task = {
          id: `batch:${item.batch.id}:process:${step.operation}`,
          kind: "process",
          batch: item.batch.id,
          station: destination,
          operation: step.operation,
          start: time,
          arrival: time,
          end: time + settings[step.operation] * 60,
          attended: false,
        };
      }
      occupied.add(item.batch.id);
      if (destination === "bake" && oven.kind === "idle") {
        oven = {
          kind: "loading",
          closeAt: time + settings.loadWindow * 60,
        };
      }
      if (task.attended) {
        allocatedWorker(workers, task.executor).state = "busy";
      }
      intervals.push(task);
      taskEvents.push({ kind: "started", time, task });
      checkpoints.add(time);
      checkpoints.add(task.end);
      item.state = { kind: "running", index, task };
    }
    const readyToBake = work.filter(readyForOven).sort(priority);
    if (
      oven.kind === "loading" &&
      readyToBake.length === ovenOccupants.size &&
      readyToBake.length > 0 &&
      !outageAt({ settings, variant }, time) &&
      (ovenOccupants.size ===
        Math.floor(settings.ovenTrays / settings.traysPerBatch) ||
        time >= oven.closeAt ||
        !work.some(beforeOven))
    ) {
      const end = time + settings.bake * 60;
      cycles.push({
        id: cycles.length + 1,
        batches: readyToBake.map(workId),
        trays: readyToBake.length * settings.traysPerBatch,
        start: time,
        end,
      });
      for (const item of readyToBake) {
        const task: Process = {
          id: `batch:${item.batch.id}:process:bake`,
          kind: "process",
          batch: item.batch.id,
          station: "bake",
          operation: "bake",
          start: time,
          arrival: time,
          end,
          attended: false,
        };
        intervals.push(task);
        taskEvents.push({ kind: "started", time, task });
        item.state = { kind: "running", index: bakingStepIndex, task };
      }
      checkpoints.add(time);
      checkpoints.add(end);
      oven = { kind: "baking", end };
    }
    for (const item of readyToBake) {
      if (item.state.kind === "pending") {
        waiting.push({
          batch: item.batch.id,
          location: "bake",
          station: "bake",
          reason: outageAt({ settings, variant }, time) ? "outage" : "cycle",
          label: outageAt({ settings, variant }, time)
            ? `Oven unavailable until ${clock(settings.outageEnd * 60)}`
            : "Loaded; waiting for the shared bake cycle",
        });
      }
    }
    yield { time, events: taskEvents.slice(emittedEvents) };
    emittedEvents = taskEvents.length;
    const future: number[] = [];
    if (oven.kind === "loading" && oven.closeAt > time) {
      future.push(oven.closeAt);
    }
    for (const item of work) {
      if (item.batch.release > time) {
        future.push(item.batch.release);
      }
      if (item.state.kind === "running") {
        const task = item.state.task;
        future.push(task.end);
        if (task.kind === "transfer" && task.pickup > time) {
          future.push(task.pickup);
        }
      }
      if (item.state.kind === "pending") {
        const step = batchStep(item.batch, item.state.index);
        const manual = manualTaskRule(
          input.manualTasks,
          item.batch.id,
          step,
          item.state.location,
        );
        if (manual !== null && manual.earliestStartSeconds > time)
          future.push(manual.earliestStartSeconds);
        if (
          ((step.kind === "handoff" && step.phase === "stage") ||
            (step.kind === "native" && step.operation.step > 1)) &&
          step.operation.earliestStartSeconds > time
        )
          future.push(step.operation.earliestStartSeconds);
      }
    }
    for (const release of releases)
      if (release.time > time) future.push(release.time);
    const outage = input.faults.outage;
    if (outage !== null)
      for (const boundary of [outage.start, outage.end])
        if (boundary > time) future.push(boundary);
    if (variant === "outage") {
      for (const boundary of [
        settings.outageStart * 60,
        settings.outageEnd * 60,
      ]) {
        if (boundary > time) {
          future.push(boundary);
        }
      }
    }
    if (future.length === 0) {
      for (const entry of waiting) {
        unresolvedWaits.push({
          batch: entry.batch,
          location: entry.location,
          station: entry.station,
          reason: entry.reason,
          label: entry.label,
          time,
        });
      }
      return { ...data, kind: "blocked", unfinished };
    }
    const next = Math.min(horizon, ...future);
    for (const entry of waiting) {
      intervals.push({
        kind: "wait",
        batch: entry.batch,
        station: entry.station,
        start: time,
        end: next,
        location: entry.location,
        reason: entry.reason,
        label: entry.label,
      });
    }
    checkpoints.add(next);
    time = next;
  }
}

function workerFromResource(resource: HumanResource): Worker {
  return { resource, position: resource.start, state: "idle" };
}

function workerAvailableFor(step: Step, worker: Worker): boolean {
  if (worker.state !== "idle") return false;
  if (step.kind === "handoff" && worker.resource.id !== step.operation.workerId)
    return false;
  if (step.kind === "transfer" || step.kind === "handoff") {
    return worker.resource.capabilities.includes("tray-handling");
  }
  return worker.resource.capabilities.includes("manual-processing");
}

function manualTaskRule(
  rules: readonly ProductionManualTask[],
  batchId: string,
  step: Step,
  location: StationId | null,
): ProductionManualTask | null {
  let id: string;
  switch (step.kind) {
    case "process":
      id = `batch:${batchId}:process:${step.operation}`;
      break;
    case "transfer":
      id = `batch:${batchId}:transfer:${location}:${step.station}`;
      break;
    case "handoff":
    case "native":
    case "planned":
      return null;
    default:
      return assertNever(step, "Unexpected simulator state");
  }
  return rules.find(hasManualTaskId.bind(null, id)) ?? null;
}
function hasManualTaskId(id: string, task: ProductionManualTask): boolean {
  return task.bakeryTaskId === id;
}
function availableWorker(
  workers: readonly Worker[],
  step: Step,
  assignedWorker: HumanId | null,
  absent: HumanId | null,
  layout: ResolvedScheduleLayout | undefined,
): Worker | undefined {
  const present = workers.filter(notWorker.bind(null, absent));
  if (step.kind === "handoff") {
    const assigned = present.find(
      hasWorkerId.bind(null, step.operation.workerId),
    );
    return assigned !== undefined && workerAvailableFor(step, assigned)
      ? assigned
      : undefined;
  }
  if (assignedWorker !== null) {
    const worker = present.find(hasWorkerId.bind(null, assignedWorker));
    return worker !== undefined && workerAvailableFor(step, worker)
      ? worker
      : undefined;
  }
  const candidates = present.filter(workerAvailableFor.bind(null, step));
  if (candidates.length <= 1 || layout === undefined) {
    return candidates[0];
  }
  const targetStation: StationId | null =
    step.kind === "process" || step.kind === "transfer" ? step.station : null;
  if (targetStation === null) {
    return candidates[0];
  }
  const targetZone = stationZone(targetStation);
  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const profile = staffRoleProfileFor(cand.resource.id);
    let score = 0;
    if (profile.zone === targetZone) score += 100;
    if (profile.preferredStations.includes(targetStation)) score += 50;
    const targetPt = station(targetStation, layout).handoff;
    const dist = Math.hypot(
      cand.position[0] - targetPt[0],
      cand.position[1] - targetPt[1],
    );
    score -= dist * 4;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}
function notWorker(id: HumanId | null, worker: Worker): boolean {
  return worker.resource.id !== id;
}

// Staging takes the baker and the chain's cell resources; clearance needs only
// the baker. A native step needs each resource its request binds.
function stepResources(step: Step): readonly OutageResource[] {
  switch (step.kind) {
    case "handoff":
      return step.phase !== "clear"
        ? [
            step.operation.workerId,
            ...Object.values(step.operation.material.resources),
          ]
        : [step.operation.workerId];
    case "native":
      return workcellResources(step.operation.attempt.input).map(resourceId);
    case "planned":
    case "transfer":
    case "process":
      return [];
    default:
      return assertNever(step, "Unexpected simulator state");
  }
}
function resourceId(resource: WorkcellResource): WorkcellResourceId {
  return resource.id;
}

// Names a prerequisite; one on a failed tray will not finish without recovery.
function dependencyName(work: readonly Work[], id: string): string {
  const batch = id.split(":")[1];
  const item = work.find(hasBatchId.bind(null, batch));
  return item !== undefined && failedWork(item)
    ? `${id} (its tray failed)`
    : id;
}
function hasBatchId(id: string | undefined, item: Work): boolean {
  return item.batch.id === id;
}
function failedWork(item: Work): boolean {
  return (
    item.state.kind === "failed" ||
    (item.state.kind === "native-held" && item.state.hold.kind === "failed")
  );
}

function notCompletedTask(completed: ReadonlySet<string>, id: string): boolean {
  return !completed.has(id);
}

// A chain owns its whole resource set until clearance or explicit recovery.
// Keeping ownership in the reservation history avoids a separate global cell lock.
function reservationForChain(
  reservations: readonly NativeReservation[],
  root: string,
): Exclude<NativeReservation, { kind: "released" }> {
  for (const reservation of reservations)
    if (reservation.kind !== "released" && reservation.operationId === root)
      return reservation;
  throw new Error(`Missing workcell reservation for ${root}`);
}

function conflictingNativeReservation(
  reservations: readonly NativeReservation[],
  step: Step,
): Exclude<NativeReservation, { kind: "released" }> | null {
  if (
    step.kind !== "native" &&
    step.kind !== "handoff" &&
    step.kind !== "planned"
  )
    return null;
  const required: NativeReservation["resources"] =
    step.kind === "handoff" && step.phase === "transfer"
      ? [
          ...Object.values(step.operation.material.resources),
          HUMAN_CELL_TRANSFER.buffer,
        ]
      : Object.values(step.operation.material.resources);
  const root = chainRoot(step.operation);
  for (const reservation of reservations) {
    if (reservation.kind === "released" || reservation.operationId === root)
      continue;
    for (const resource of required)
      if (reservation.resources.includes(resource)) return reservation;
  }
  return null;
}

function reserveNativeResources(
  reservations: NativeReservation[],
  operation: ProductionWorkcell,
  time: number,
): void {
  const binding = operation.material.resources;
  const reservation: NativeReservation = {
    kind: "reserved",
    materialId: operation.material.materialId,
    operationId: chainRoot(operation),
    attemptId: operation.attempt.input.request.attemptId,
    resources: [
      binding.arm,
      binding.tool,
      binding.tray,
      binding.source,
      binding.destination,
      binding.cell,
    ],
    start: time,
  };
  reservations.push(reservation);
}

function replaceNativeReservation(
  reservations: NativeReservation[],
  previous: NativeReservation,
  next: NativeReservation,
): void {
  const index = reservations.indexOf(previous);
  if (index < 0) throw new Error("Missing native reservation");
  reservations[index] = next;
}

function holdNativeReservation(
  reservations: NativeReservation[],
  previous: NativeReservation,
  time: number,
): void {
  const next: NativeReservation = {
    kind: "held",
    operationId: previous.operationId,
    materialId: previous.materialId,
    attemptId: previous.attemptId,
    resources: previous.resources,
    start: previous.start,
    heldAt: time,
  };
  replaceNativeReservation(reservations, previous, next);
}

function releaseNativeReservation(
  reservations: NativeReservation[],
  previous: NativeReservation,
  time: number,
): void {
  replaceNativeReservation(reservations, previous, {
    kind: "released",
    operationId: previous.operationId,
    materialId: previous.materialId,
    attemptId: previous.attemptId,
    resources: previous.resources,
    start: previous.start,
    end: time,
  });
}

function allocatedWorker(workers: readonly Worker[], id: HumanId): Worker {
  const worker = workers.find(hasWorkerId.bind(null, id));
  if (worker === undefined) throw new Error(`Missing allocated worker ${id}`);
  return worker;
}

function hasWorkerId(id: HumanId, worker: Worker): boolean {
  return worker.resource.id === id;
}

export function humanResource(run: Run, id: HumanId): HumanResource {
  for (const resource of run.resources) {
    if (resource.id === id) return resource;
  }
  throw new Error(`Missing human resource ${id}`);
}

export function taskAt(run: Run, task: BakeryTask, time: number): TaskSnapshot {
  let snapshot: TaskSnapshot = { kind: "queued", task };
  for (const event of run.taskEvents) {
    if (event.time > time) break;
    if (event.kind === "native-awaiting") continue;
    if (event.task.id !== task.id) continue;
    switch (event.kind) {
      case "started":
        snapshot = { kind: "running", task };
        break;
      case "picked-up":
        break;
      case "completed":
        snapshot = {
          kind: "completed",
          task: event.task,
          evidence: event.evidence,
        };
        break;
      case "failed":
        snapshot = {
          kind: "failed",
          task: event.task,
          evidence: event.evidence,
        };
        break;
      case "native-settled":
        snapshot =
          event.task.outcome === "completed"
            ? {
                kind: "completed",
                task: event.task,
                evidence: {
                  source: "native-recording",
                  recording: event.task.recording,
                },
              }
            : { kind: "recovery-required", task: event.task };
        break;
      default:
        assertNever(event, "Unexpected simulator state");
    }
  }
  return snapshot;
}

export function workerTasks(run: Run, id: HumanId): readonly BakeryTask[] {
  const tasks: BakeryTask[] = [];
  for (const interval of run.intervals) {
    if (
      interval.kind !== "wait" &&
      interval.attended &&
      interval.executor === id
    ) {
      tasks.push(interval);
    }
  }
  return tasks;
}

function beforeEnd(end: number, time: number): boolean {
  return time <= end;
}

function unloadingOven(item: Work): boolean {
  return (
    item.state.kind === "running" &&
    item.state.task.kind === "transfer" &&
    item.state.task.from === "bake"
  );
}

function readyForOven(item: Work): boolean {
  return (
    item.state.kind === "pending" &&
    isBakingStep(batchStep(item.batch, item.state.index))
  );
}

function batchStep(batch: BatchProcedure, index: number): Step {
  const step = batch.steps[index];
  if (step === undefined)
    throw new Error(`Missing step ${index} for batch ${batch.id}`);
  return step;
}

// Robot-only rehearsal trays never bake; only a batch with baking ahead waits.
function beforeOven(item: Work): boolean {
  return (
    item.state.kind !== "complete" &&
    item.batch.steps.slice(item.state.index + 1).some(isBakingStep)
  );
}

function numeric(a: number, b: number): number {
  return a - b;
}

function notComplete(item: Work): boolean {
  return item.state.kind !== "complete";
}

function workId(item: Work): string {
  return item.batch.id;
}

function isPending(item: Work): boolean {
  return item.state.kind === "pending";
}

function priority(a: Work, b: Work): number {
  return (
    a.batch.deadline - b.batch.deadline ||
    a.batch.release - b.batch.release ||
    compareCodePoints(a.batch.id, b.batch.id)
  );
}

export type BatchSnapshot =
  | Interval
  | { readonly kind: "complete"; readonly time: number }
  | { readonly kind: "unreleased" }
  | { readonly kind: "unfinished" };

export function batchAt(run: Run, batch: Batch, time: number): BatchSnapshot {
  for (const task of run.intervals) {
    if (task.batch === batch.id && task.start <= time && time < task.end) {
      return task;
    }
  }
  for (const item of run.completions) {
    if (item.batch === batch.id && time >= item.time) {
      return { kind: "complete", time: item.time };
    }
  }
  for (const hold of run.nativeHolds) {
    if (hold.operation.batchId !== batch.id || time < hold.start) continue;
    return {
      kind: "wait",
      batch: batch.id,
      station: "cool",
      location: "cool",
      start: hold.start,
      end: run.end,
      reason: "station",
      label:
        hold.kind === "failed"
          ? failureLabel("Native failure", hold.recoveredAt, time)
          : "Robot reserved; awaiting matching evidence",
    };
  }
  for (const failure of run.handlingFailures) {
    if (failure.task.batch !== batch.id || time < failure.failedAt) continue;
    return {
      kind: "wait",
      batch: batch.id,
      station: failure.task.station,
      location: failure.task.station,
      start: failure.failedAt,
      end: run.end,
      reason: "station",
      label: failureLabel(
        failure.task.phase === "transfer"
          ? "Human transfer failed; location uncertain"
          : failure.task.phase === "stage"
            ? "Staging failed"
            : "Clearance failed",
        failure.recoveredAt,
        time,
      ),
    };
  }
  return time < batch.release ? { kind: "unreleased" } : { kind: "unfinished" };
}

function failureLabel(
  failure: string,
  recoveredAt: number | null,
  time: number,
): string {
  if (recoveredAt === null) return `${failure}; cell and tray held`;
  return time < recoveredAt
    ? `${failure}; recovery assumed until ${clock(recoveredAt)}`
    : `${failure}; recovery released the cell`;
}

// Names the skill a native task runs; continuations resume the tray in the cell.
function nativeDescription(operation: ProductionWorkcell): string {
  const input = operation.attempt.input;
  const tray = `tray ${operation.tray}`;
  const robot = ROBOTS[input.request.robot].label;
  switch (input.kind) {
    case "transfer":
      return input.request.bakeryTaskId === "table-to-oven"
        ? `${robot} · load ${tray} into the oven`
        : `${robot} · ${tray} to rack`;
    case "native-cycle":
      return `${robot} · ${tray} oven cycle`;
    case "oven-cycle":
      return operation.start.kind === "reset"
        ? `${robot} · ${tray} oven cycle`
        : `${robot} · retrieve ${tray} from the oven`;
    case "rack-cycle":
      return operation.start.kind === "reset"
        ? `${robot} · ${tray} oven, table and rack`
        : `${robot} · rack ${tray}`;
  }
}

export function describe(snapshot: BatchSnapshot): string {
  switch (snapshot.kind) {
    case "process":
      switch (snapshot.operation) {
        case "cool":
          return "Cooling in moulds";
        case "demould":
          return "Demoulding";
        case "finishCooling":
          return "Cooling before packing";
        default:
          return stationLabel(snapshot.station);
      }
    case "transfer":
      return `Move from ${stationLabel(snapshot.from)} to ${stationLabel(snapshot.station)}`;
    case "handoff":
      if (snapshot.phase === "transfer")
        return "Human transfer: cell 1 rack → buffer → cell 2 source (assumed)";
      return snapshot.phase === "stage"
        ? "Stage cold proxy in Robot cell"
        : "Clear Robot cell to holding area";
    case "native":
      return nativeDescription(snapshot.operation);
    case "wait":
      return snapshot.label;
    case "complete":
      return "Packed";
    case "unreleased":
      return "Not released";
    case "unfinished":
      return "Unfinished at shift end";
    default:
      return assertNever(snapshot, "Unexpected simulator state");
  }
}

export type MachineState = "idle" | "running" | "ready" | "fault";

export function machineAt(
  run: Run,
  id: StationId,
  time: number,
): {
  state: MachineState;
  queue: readonly string[];
  occupants: readonly string[];
} {
  const queue: string[] = [];
  const occupants: string[] = [];
  let state: MachineState =
    id === "bake" && outageAt(run, time) ? "fault" : "idle";
  for (const batch of run.batches) {
    const current = batchAt(run, batch, time);
    if (current.kind === "wait" && current.station === id) {
      queue.push(batch.id);
    }
    if (
      (current.kind === "process" ||
        current.kind === "handoff" ||
        current.kind === "native") &&
      current.station === id
    ) {
      occupants.push(batch.id);
      if (current.kind === "native" || time >= current.arrival) {
        state = "running";
      }
    }
    if (current.kind === "wait" && current.location === id) {
      occupants.push(batch.id);
      if (state === "idle") {
        state = "ready";
      }
    }
    if (
      current.kind === "transfer" &&
      ((current.from === id && time < current.pickup) || current.station === id)
    ) {
      occupants.push(batch.id);
    }
  }
  return { state, queue, occupants };
}

export function doorAt(
  run: Run,
  id: StationId,
  time: number,
  reduced: boolean,
): number {
  let open = 0;
  for (const task of run.intervals) {
    if (task.kind !== "transfer") {
      continue;
    }
    if (task.from !== id && task.station !== id) {
      continue;
    }
    const start = task.from === id ? task.pickupStart : task.loadedEnd;
    const end = task.from === id ? task.pickup : task.end;
    if (time < start || time >= end) {
      continue;
    }
    open = Math.max(
      open,
      reduced ? 1 : Math.min(1, (time - start) / 0.75, (end - time) / 0.75),
    );
  }
  return open;
}

export function workerAt(
  run: Run,
  resource: HumanResource,
  time: number,
  reduced: boolean,
): Point {
  let point: Point = resource.start;
  for (const task of run.intervals) {
    if (
      task.kind === "wait" ||
      !task.attended ||
      task.executor !== resource.id ||
      task.start > time
    ) {
      continue;
    }
    if (task.end <= time) {
      point = station(task.station, run.layout).handoff;
      continue;
    }
    if (reduced) {
      return task.kind === "transfer" && time < task.pickup
        ? station(task.from, run.layout).handoff
        : station(task.station, run.layout).handoff;
    }
    if (task.kind === "transfer") {
      return time < task.pickup
        ? along(
            task.emptyRoute,
            (time - task.start) / Math.max(1, task.pickupStart - task.start),
          )
        : along(
            task.route,
            (time - task.pickup) / Math.max(1, task.loadedEnd - task.pickup),
          );
    }
    return time < task.arrival
      ? along(
          task.emptyRoute,
          (time - task.start) / (task.arrival - task.start),
        )
      : station(task.station, run.layout).handoff;
  }
  return point;
}

export function metrics(run: Run): {
  late: number;
  waiting: number;
  unfinished: number;
} {
  let late = 0;
  let waiting = 0;
  for (const batch of run.batches) {
    for (const item of run.completions) {
      if (item.batch === batch.id && item.time > batch.deadline) {
        late++;
      }
    }
  }
  for (const task of run.intervals) {
    if (task.kind === "wait") {
      waiting += task.end - task.start;
    }
  }
  return {
    late,
    waiting,
    unfinished: run.kind === "complete" ? 0 : run.unfinished.length,
  };
}

export function workName(run: Pick<Run, "unit">, batchId: string): string {
  return `${run.unit === "tray" ? "Tray" : "Batch"} ${batchId}`;
}

export function clock(seconds: number): string {
  const value = Math.floor(seconds);
  return `${String(6 + Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export type Plan61ASubstepId =
  | "pull-cold-ingredients"
  | "weigh-ingredients"
  | "cook-brown-butter"
  | "mix-batter"
  | "butter-moulds"
  | "deposit-batter"
  | "convection-bake"
  | "mould-set-cool"
  | "release-financiers"
  | "wash-moulds"
  | "return-clean-moulds"
  | "wire-grid-cool"
  | "crumb-check-qa"
  | "pack-ballotins"
  | "refill-vitrine";

export type Plan61ASubstep = Readonly<{
  id: Plan61ASubstepId;
  operation: Operation;
  startFraction: number;
  endFraction: number;
  label: string;
  shortLabel: string;
  equipment: string;
  massNote: string;
}>;

export const PLAN_61A_MASS_BALANCE = {
  inputGrams: 756,
  brownButterInputGrams: 180,
  brownButterOutputGrams: 158,
  brownButterEvaporationGrams: 22,
  batterCombinedGrams: 734,
  bowlResidueGrams: 8,
  transferableBatterGrams: 726,
  trayDepositedGrams: 600,
  retainedBatterGrams: 126,
  mouldCount: 3,
  cavitiesPerMould: 8,
  totalCavities: 24,
  gramsPerCavity: 25,
  bakeEvaporationGrams: 36,
  bakedPiecesGrams: 564,
  sampledPieceGrams: 23.5,
  rejectedPiecesGrams: 188,
  acceptedPackedGrams: 352.5,
  acceptedPieceCount: 15,
  rejectedPieceCount: 8,
  sampledPieceCount: 1,
} as const;

const PLAN_61A_SUBSTEPS_BY_OPERATION: Readonly<
  Record<Operation, readonly Plan61ASubstep[]>
> = {
  stage: [
    {
      id: "pull-cold-ingredients",
      operation: "stage",
      startFraction: 0,
      endFraction: 0.18,
      label:
        "Pull 4 °C cultured butter (180 g) & aged egg whites (180 g) from cold chiller to scale",
      shortLabel: "Pull butter & whites · 4 °C chiller",
      equipment: "4 °C patisserie chiller → Ohaus scale",
      massNote:
        "360 g chilled dairy & albumen carried from cold storage to prep table",
    },
    {
      id: "weigh-ingredients",
      operation: "stage",
      startFraction: 0.18,
      endFraction: 0.42,
      label: "Weigh 756 g dry powders, egg whites, honey & butter",
      shortLabel: "Weigh 756 g · Ohaus scale",
      equipment: "Ohaus Ranger 3000 (30 kg × 0.5 g)",
      massNote:
        "180 g butter, 76 g almond, 76 g hazelnut, 165 g icing sugar, 55 g T45 flour, 180 g whites, 20 g honey",
    },
    {
      id: "cook-brown-butter",
      operation: "stage",
      startFraction: 0.42,
      endFraction: 0.72,
      label: "Cook beurre noisette at 148 °C and strain to 55 °C",
      shortLabel: "Brown butter 158 g · Maruzen hob",
      equipment: "Maruzen TIH-3NN 3 kW induction hob",
      massNote: "180 g butter → 158 g nutty brown butter (22 g water evaporated)",
    },
    {
      id: "mix-batter",
      operation: "stage",
      startFraction: 0.72,
      endFraction: 1,
      label: "Fold dry powders, whites, honey & warm brown butter",
      shortLabel: "Mix 726 g batter · Hobart HL200",
      equipment: "Hobart HL200 20 qt planetary mixer",
      massNote: "734 g combined − 8 g bowl/whisk residue = 726 g batter",
    },
  ],
  portion: [
    {
      id: "butter-moulds",
      operation: "portion",
      startFraction: 0,
      endFraction: 0.3,
      label: "Brush & tare 3 Matsunaga 8-cavity Silver Stone moulds",
      shortLabel: "Prep 3 × 8P Matsunaga moulds",
      equipment: "3 × Matsunaga 8-cavity moulds on Ohaus scale",
      massNote: "24 cavities total (3 moulds × 8 cavities)",
    },
    {
      id: "deposit-batter",
      operation: "portion",
      startFraction: 0.3,
      endFraction: 1,
      label: "Deposit 25 g batter into 24 cavities (200 g per mould)",
      shortLabel: "Deposit 24 × 25 g (600 g tray)",
      equipment: "Stainless piston funnel depositor + Ohaus scale",
      massNote: "600 g deposited across 3 moulds; 126 g retained for next tray",
    },
  ],
  bake: [
    {
      id: "convection-bake",
      operation: "bake",
      startFraction: 0,
      endFraction: 1,
      label: "Bake at 170 °C convection until golden bosse forms",
      shortLabel: "Bake 170 °C · 24 cavities",
      equipment: "UNOX Bakerlux SHOP.Pro LED 4-tray convection oven",
      massNote: "600 g batter → 564 g baked financiers (36 g bake evaporation)",
    },
  ],
  cool: [
    {
      id: "mould-set-cool",
      operation: "cool",
      startFraction: 0,
      endFraction: 1,
      label: "Cool in Matsunaga moulds 2–3 min for crust set",
      shortLabel: "Cool in 3 Matsunaga moulds",
      equipment: "600 × 400 mm patisserie cooling rack",
      massNote: "564 g across 24 cavities (23.5 g per baked piece)",
    },
  ],
  demould: [
    {
      id: "release-financiers",
      operation: "demould",
      startFraction: 0,
      endFraction: 0.45,
      label: "Invert 3 Matsunaga moulds to release 24 financiers onto wire grid",
      shortLabel: "Demould 24 pcs to wire grid",
      equipment: "Wire cooling grid at cooling rack",
      massNote: "24 pieces (564 g) transferred to wire grid; 3 moulds freed",
    },
    {
      id: "wash-moulds",
      operation: "demould",
      startFraction: 0.45,
      endFraction: 0.85,
      label: "Wash & sanitize 3 Matsunaga 8-cavity moulds at kitchen sink",
      shortLabel: "Wash 3 Matsunaga moulds · Sink",
      equipment: "2-bay stainless kitchen wash sink (65 °C rinse)",
      massNote: "Removes butter film & crumb residue for hygienic mould reuse",
    },
    {
      id: "return-clean-moulds",
      operation: "demould",
      startFraction: 0.85,
      endFraction: 1,
      label: "Dry & return 3 clean Matsunaga moulds to portioning station",
      shortLabel: "Return 3 clean moulds",
      equipment: "Mould drying rack → portioning table",
      massNote: "3 × Matsunaga 8P moulds ready for next cycle",
    },
  ],
  finishCooling: [
    {
      id: "wire-grid-cool",
      operation: "finishCooling",
      startFraction: 0,
      endFraction: 0.75,
      label: "Cool demoulded financiers on wire grid (10 min before QA)",
      shortLabel: "Wire-grid cool (564 g)",
      equipment: "600 × 400 mm wire cooling grid",
      massNote: "Core cools to ambient before internal crumb inspection",
    },
    {
      id: "crumb-check-qa",
      operation: "finishCooling",
      startFraction: 0.75,
      endFraction: 1,
      label: "Halve 1 sample piece (23.5 g) for crumb & moisture QA check",
      shortLabel: "Crumb QA check (23.5 g sample)",
      equipment: "QA inspection station",
      massNote: "15 pieces accepted (352.5 g), 1 sampled (23.5 g), 8 rejected (188 g)",
    },
  ],
  pack: [
    {
      id: "pack-ballotins",
      operation: "pack",
      startFraction: 0,
      endFraction: 0.68,
      label: "Pack accepted financiers (352.5 g / 15 pcs) into gift ballotins",
      shortLabel: "Pack ballotin boxes (352.5 g)",
      equipment: "Packing table + Ohaus check-weigher",
      massNote: "352.5 g net packed weight across sealed gold-ribbon ballotins",
    },
    {
      id: "refill-vitrine",
      operation: "pack",
      startFraction: 0.68,
      endFraction: 1,
      label: "Carry fresh financiers to restock front pastry vitrine showcase",
      shortLabel: "Restock front pastry vitrine",
      equipment: "Refrigerated patisserie vitrine showcase",
      massNote: "Display trays replenished at storefront counter",
    },
  ],
};

export function plan61AOperationSubsteps(
  operation: Operation,
): readonly Plan61ASubstep[] {
  return PLAN_61A_SUBSTEPS_BY_OPERATION[operation];
}

export function plan61ASubstepAt(
  task: Pick<Process, "operation" | "start" | "arrival" | "end">,
  time: number,
): Plan61ASubstep & Readonly<{ progress: number; overallProgress: number }> {
  const steps = PLAN_61A_SUBSTEPS_BY_OPERATION[task.operation];
  const activeStart = task.start === 0 ? 0 : task.arrival;
  const duration = Math.max(1, task.end - activeStart);
  const overallProgress = Math.max(
    0,
    Math.min(1, (time - activeStart) / duration),
  );
  const matched =
    steps.find(
      (s) =>
        overallProgress >= s.startFraction && overallProgress <= s.endFraction,
    ) ?? steps[steps.length - 1]!;
  const span = Math.max(1e-4, matched.endFraction - matched.startFraction);
  const progress = Math.max(
    0,
    Math.min(1, (overallProgress - matched.startFraction) / span),
  );
  return {
    ...matched,
    progress,
    overallProgress,
  };
}

export type VitrineOrderChannel =
  | "counter"
  | "qr-order"
  | "walk-in"
  | "click-collect"
  | "boutique";

export const VITRINE_ORDER_CHANNELS: readonly Readonly<{
  id: VitrineOrderChannel;
  label: string;
}>[] = [
  { id: "counter", label: "Counter POS" },
  { id: "qr-order", label: "Table QR" },
  { id: "walk-in", label: "Walk-in" },
  { id: "click-collect", label: "Click & Collect" },
  { id: "boutique", label: "Boutique" },
];

export type VitrineOrderStatus = "upcoming" | "waiting-refill" | "fulfilled";

export type CafeBeverageRecipeId =
  | "espresso"
  | "siphon-coffee"
  | "black-sesame-milk"
  | "ginger-black-tea"
  | "ginger-milk-tea";

export type CafeBeverageStatus =
  | "upcoming"
  | "queued-bar"
  | "brewing"
  | "served";

export type VitrineCustomerOrder = Readonly<{
  id: string;
  channel: VitrineOrderChannel;
  channelLabel: string;
  label: string;
  orderedAt: number;
  orderedAtMinutes: number;
  defaultOrderedAt: number;
  defaultOrderedAtMinutes: number;
  isCustomArrival: boolean;
  isCustomOrder: boolean;
  fulfilledAt: number | null;
  loosePieces: number;
  ballotinBoxes: number;
  totalPieces: number;
  status: VitrineOrderStatus;
  fulfilledByWave: number | null;
  beverageRecipe: CafeBeverageRecipeId;
  beverageLabel: string;
  beverageCount: number;
  beverageEquipment: string;
  brewDurationSeconds: number;
  brewStart: number;
  brewEnd: number;
  beverageWaitSeconds: number;
  beverageStatus: CafeBeverageStatus;
}>;

export type VitrineRefillWaveStatus =
  | "pending"
  | "packing-ballotins"
  | "restocking-vitrine"
  | "completed";

export type VitrineRefillWave = Readonly<{
  waveNumber: number;
  batchId: string;
  workerId: HumanId | null;
  packStart: number;
  refillStart: number;
  completedAt: number;
  loosePiecesAdded: number;
  ballotinBoxesAdded: number;
  totalPiecesAdded: number;
  status: VitrineRefillWaveStatus;
}>;

export type VitrineStockStatus =
  | "stocked"
  | "low-stock"
  | "restocking"
  | "awaiting-refill";

export type VitrineRushPresetId = "quiet" | "normal" | "weekend-rush";

export type VitrineRushPresetSpec = Readonly<{
  id: VitrineRushPresetId;
  label: string;
  shortLabel: string;
  description: string;
  orderCount: number;
  totalRequestedPieces: number;
  recommendedBatchCount: number;
  recommendedWorkerCount: number;
  recommendedOvenTrays: number;
  recommendedHorizonMinutes: number;
}>;

export type VitrineStockSnapshot = Readonly<{
  rushPreset: VitrineRushPresetId;
  rushPresetLabel: string;
  recommendedBatchCount: number;
  scheduledBatchCount: number;
  batchDeficit: number;
  recommendedWorkerCount: number;
  scheduledWorkerCount: number;
  workerDeficit: number;
  recommendedOvenTrays: number;
  scheduledOvenTrays: number;
  ovenTrayDeficit: number;
  unfinishedWavesAtHorizon: number;
  capacityRecommendationLabel: string;
  autoScaleBatches: boolean;
  openingLoosePieces: number;
  openingBallotinBoxes: number;
  loosePieces: number;
  looseCapacity: number;
  ballotinBoxes: number;
  ballotinCapacity: number;
  totalAvailablePieces: number;
  lowStockThresholdLoose: number;
  status: VitrineStockStatus;
  statusLabel: string;
  soldLoosePieces: number;
  soldBallotinBoxes: number;
  restockedLoosePieces: number;
  restockedBallotinBoxes: number;
  orders: readonly VitrineCustomerOrder[];
  fulfilledOrders: readonly VitrineCustomerOrder[];
  waitingOrders: readonly VitrineCustomerOrder[];
  upcomingOrders: readonly VitrineCustomerOrder[];
  refillWaves: readonly VitrineRefillWave[];
  activeWave: VitrineRefillWave | null;
  nextWave: VitrineRefillWave | null;
  totalBeverageCups: number;
  servedBeverageCups: number;
  brewingOrder: VitrineCustomerOrder | null;
  maxBeverageWaitSeconds: number;
  barStatusLabel: string;
  customArrivalCount: number;
  hasCustomArrivals: boolean;
  customArrivalSummary: string;
}>;

export const VITRINE_REFILL_YIELD = {
  openingLoosePieces: 12,
  openingBallotinBoxes: 3,
  looseCapacity: 24,
  ballotinCapacity: 8,
  lowStockThresholdLoose: 5,
  piecesPerBallotinBox: 5,
  loosePiecesPerBatchWave: 5,
  ballotinBoxesPerBatchWave: 2,
  totalPiecesPerBatchWave: 15,
} as const;

type VitrineOrderTemplate = Readonly<{
  id: string;
  channel: VitrineOrderChannel;
  channelLabel: string;
  label: string;
  orderedAt: number;
  loosePieces: number;
  ballotinBoxes: number;
  beverageRecipe?: CafeBeverageRecipeId;
  beverageLabel?: string;
  beverageCount?: number;
  beverageEquipment?: string;
  brewDurationSeconds?: number;
}>;

export type CafeBeverageSpec = Readonly<{
  recipe: CafeBeverageRecipeId;
  shortName: string;
  label: (cups: number) => string;
  equipment: string;
  brewSecondsPerCup: number;
}>;

export const CAFE_BEVERAGE_ROTATION: readonly CafeBeverageSpec[] = [
  {
    recipe: "espresso",
    shortName: "Double Espresso (61E)",
    label: (c) => `${c}× Double Espresso (${c * 36} g · 61E)`,
    equipment: "Linea Classic S · Group 1",
    brewSecondsPerCup: 55,
  },
  {
    recipe: "black-sesame-milk",
    shortName: "Black Sesame Milk (61B)",
    label: (c) => `${c}× Black Sesame Milk (${c * 220} mL · 61B)`,
    equipment: "Heated Milk Mixer & Bar Jug",
    brewSecondsPerCup: 90,
  },
  {
    recipe: "ginger-black-tea",
    shortName: "Ginger Black Tea (61C)",
    label: (c) => `${c}× Ginger Black Tea (${c * 250} mL · 61C)`,
    equipment: "Bar Induction Hob & Strainer",
    brewSecondsPerCup: 95,
  },
  {
    recipe: "ginger-milk-tea",
    shortName: "Ginger Milk Tea (61D)",
    label: (c) => `${c}× Ginger Milk Tea (${c * 250} mL · 61D)`,
    equipment: "Bar Induction Hob & Pre-warmed Cup",
    brewSecondsPerCup: 110,
  },
  {
    recipe: "siphon-coffee",
    shortName: "Hario Siphon Coffee (61E)",
    label: (c) => `${c}× Hario Siphon Coffee (${c * 240} mL · 61E)`,
    equipment: "Hario ECA-3-B Vacuum Siphon",
    brewSecondsPerCup: 105,
  },
];

const VITRINE_ORDER_TEMPLATES_BY_PRESET: Readonly<
  Record<VitrineRushPresetId, readonly VitrineOrderTemplate[]>
> = {
  quiet: [
    {
      id: "ORD-101",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Morning Espresso & 2 Warm Financiers",
      orderedAt: 10 * 60,
      loosePieces: 2,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-102",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "1 Gold-Ribbon Ballotin + 1 Loose Financier",
      orderedAt: 22 * 60,
      loosePieces: 1,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-103",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Morning Pastry Pair (2 Loose Financiers)",
      orderedAt: 36 * 60,
      loosePieces: 2,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-104",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "1 Ballotin Gift Box + 2 Loose Financiers",
      orderedAt: 52 * 60,
      loosePieces: 2,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-105",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Late-Morning Café Duo (2 Loose Financiers)",
      orderedAt: 68 * 60,
      loosePieces: 2,
      ballotinBoxes: 0,
    },
  ],
  normal: [
    {
      id: "ORD-101",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Morning Espresso & 3 Warm Financiers",
      orderedAt: 8 * 60,
      loosePieces: 3,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-102",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "1 Gold-Ribbon Ballotin + 2 Loose Financiers",
      orderedAt: 16 * 60,
      loosePieces: 2,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-103",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Patisserie Tasting Flight (4 Loose Financiers)",
      orderedAt: 25 * 60,
      loosePieces: 4,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-104",
      channel: "click-collect",
      channelLabel: "Click & Collect",
      label: "2 Ballotin Gift Boxes + 2 Loose Financiers",
      orderedAt: 34 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-105",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "1 Ballotin Gift Box + 3 Loose Financiers",
      orderedAt: 42 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-106",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Café Gourmand Set (1 Ballotin + 3 Loose)",
      orderedAt: 53 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-107",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "Office Gift Order (2 Ballotins + 2 Loose)",
      orderedAt: 64 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-108",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Late-Morning Showcase Box (1 Ballotin + 4 Loose)",
      orderedAt: 75 * 60,
      loosePieces: 4,
      ballotinBoxes: 1,
    },
  ],
  "weekend-rush": [
    {
      id: "ORD-101",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Early Rush Espresso & 4 Warm Financiers",
      orderedAt: 5 * 60,
      loosePieces: 4,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-102",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "Weekend Brunch Table (1 Ballotin + 3 Loose)",
      orderedAt: 11 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-103",
      channel: "click-collect",
      channelLabel: "Click & Collect",
      label: "VIP Gift Pre-Order (2 Ballotins + 2 Loose)",
      orderedAt: 17 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-104",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Family Tasting Flight (4 Loose Financiers)",
      orderedAt: 23 * 60,
      loosePieces: 4,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-105",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "Hostess Gift Box (1 Ballotin + 3 Loose)",
      orderedAt: 29 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-106",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Café Counter Flight (3 Loose Financiers)",
      orderedAt: 35 * 60,
      loosePieces: 3,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-107",
      channel: "click-collect",
      channelLabel: "Click & Collect",
      label: "Weekend Celebration Box (2 Ballotins + 2 Loose)",
      orderedAt: 41 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-108",
      channel: "qr-order",
      channelLabel: "Table QR",
      label: "Patio Brunch Table (1 Ballotin + 3 Loose)",
      orderedAt: 48 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-109",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Boutique Showcase Trio (3 Loose Financiers)",
      orderedAt: 55 * 60,
      loosePieces: 3,
      ballotinBoxes: 0,
    },
    {
      id: "ORD-110",
      channel: "boutique",
      channelLabel: "Boutique",
      label: "Gold-Ribbon Gift Pair (2 Ballotins + 2 Loose)",
      orderedAt: 62 * 60,
      loosePieces: 2,
      ballotinBoxes: 2,
    },
    {
      id: "ORD-111",
      channel: "counter",
      channelLabel: "Counter POS",
      label: "Mid-Morning Gourmand Set (1 Ballotin + 3 Loose)",
      orderedAt: 69 * 60,
      loosePieces: 3,
      ballotinBoxes: 1,
    },
    {
      id: "ORD-112",
      channel: "walk-in",
      channelLabel: "Walk-in",
      label: "Late Rush Assortment (1 Ballotin + 4 Loose)",
      orderedAt: 76 * 60,
      loosePieces: 4,
      ballotinBoxes: 1,
    },
  ],
};

export const VITRINE_RUSH_PRESETS: readonly VitrineRushPresetSpec[] = [
  {
    id: "quiet",
    label: "Quiet morning (5 orders · 19 pcs)",
    shortLabel: "Quiet morning",
    description:
      "Light café traffic — opening stock covers early demand (auto-scales to 2 batches · 2 workers · 4 oven trays).",
    orderCount: 5,
    totalRequestedPieces: 19,
    recommendedBatchCount: 2,
    recommendedWorkerCount: 2,
    recommendedOvenTrays: 4,
    recommendedHorizonMinutes: 120,
  },
  {
    id: "normal",
    label: "Normal morning (8 orders · 48 pcs)",
    shortLabel: "Normal morning",
    description:
      "Standard boutique traffic — ORD-105 waits for Wave 1 refill (auto-scales to 3 batches · 2 workers · 4 oven trays).",
    orderCount: 8,
    totalRequestedPieces: 48,
    recommendedBatchCount: 3,
    recommendedWorkerCount: 2,
    recommendedOvenTrays: 4,
    recommendedHorizonMinutes: 120,
  },
  {
    id: "weekend-rush",
    label: "Weekend rush (12 orders · 91 pcs)",
    shortLabel: "Weekend rush",
    description:
      "Heavy Saturday traffic — early stockout queues orders across Waves 1–5 (auto-scales to 5 batches · 3 workers · 6 oven trays).",
    orderCount: 12,
    totalRequestedPieces: 91,
    recommendedBatchCount: 5,
    recommendedWorkerCount: 3,
    recommendedOvenTrays: 6,
    recommendedHorizonMinutes: 150,
  },
] as const;

let activeVitrineRushPreset: VitrineRushPresetId = "normal";
let autoScaleVitrineBatches = true;
let forceApplyRecommendedCapacity = false;
let vitrineDemandRevision = 0;
const vitrineRushListeners = new Set<() => void>();

export type VitrineOrderOverride = Readonly<{
  orderedAtMinutes?: number;
  channel?: VitrineOrderChannel;
  loosePieces?: number;
  ballotinBoxes?: number;
  beverageRecipe?: CafeBeverageRecipeId;
  beverageCount?: number;
}>;

const VITRINE_CUSTOM_ORDERS_STORAGE_KEY =
  "pantry.bakeryos.vitrineCustomOrders.v1";

const customOrderOverridesByPreset: Readonly<
  Record<VitrineRushPresetId, Map<string, VitrineOrderOverride>>
> = {
  quiet: new Map(),
  normal: new Map(),
  "weekend-rush": new Map(),
};

const customAddedOrdersByPreset: Record<
  VitrineRushPresetId,
  VitrineOrderTemplate[]
> = {
  quiet: [],
  normal: [],
  "weekend-rush": [],
};

function saveCustomVitrineOrdersToStorage(): void {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    const presets: readonly VitrineRushPresetId[] = [
      "quiet",
      "normal",
      "weekend-rush",
    ];
    let hasAny = false;
    const payload: Record<
      string,
      {
        overrides: [string, VitrineOrderOverride][];
        added: VitrineOrderTemplate[];
      }
    > = {};
    for (const p of presets) {
      const overrides = Array.from(customOrderOverridesByPreset[p].entries());
      const added = customAddedOrdersByPreset[p];
      if (overrides.length > 0 || added.length > 0) {
        hasAny = true;
      }
      payload[p] = { overrides, added };
    }
    if (!hasAny) {
      globalThis.localStorage.removeItem(VITRINE_CUSTOM_ORDERS_STORAGE_KEY);
    } else {
      globalThis.localStorage.setItem(
        VITRINE_CUSTOM_ORDERS_STORAGE_KEY,
        JSON.stringify(payload),
      );
    }
  } catch {
    // Ignore storage quota or access errors in restricted environments
  }
}

function loadCustomVitrineOrdersFromStorage(): void {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    const raw = globalThis.localStorage.getItem(
      VITRINE_CUSTOM_ORDERS_STORAGE_KEY,
    );
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        overrides?: [string, VitrineOrderOverride][];
        added?: VitrineOrderTemplate[];
      }
    >;
    const presets: readonly VitrineRushPresetId[] = [
      "quiet",
      "normal",
      "weekend-rush",
    ];
    for (const p of presets) {
      const entry = parsed?.[p];
      if (!entry) continue;
      if (Array.isArray(entry.overrides)) {
        for (const [id, ov] of entry.overrides) {
          if (typeof id === "string" && ov && typeof ov === "object") {
            customOrderOverridesByPreset[p].set(id, ov);
          }
        }
      }
      if (Array.isArray(entry.added)) {
        customAddedOrdersByPreset[p].splice(
          0,
          customAddedOrdersByPreset[p].length,
          ...entry.added,
        );
      }
    }
  } catch {
    // Ignore malformed storage entries
  }
}

loadCustomVitrineOrdersFromStorage();

function notifyVitrineDemandListeners(): void {
  saveCustomVitrineOrdersToStorage();
  vitrineDemandRevision += 1;
  for (const listener of vitrineRushListeners) {
    try {
      listener();
    } catch {
      // Keep remaining subscribers and caller execution intact
    }
  }
}

export function getVitrineDemandRevision(): number {
  return vitrineDemandRevision;
}

export type VitrineOrderChannelFilter = "all" | VitrineOrderChannel;

let activeVitrineChannelFilter: VitrineOrderChannelFilter = "all";
let snapVitrineOrdersToWaves = false;

export function getActiveVitrineChannelFilter(): VitrineOrderChannelFilter {
  return activeVitrineChannelFilter;
}

export function setActiveVitrineChannelFilter(
  channel: VitrineOrderChannelFilter,
): void {
  if (activeVitrineChannelFilter === channel) return;
  activeVitrineChannelFilter = channel;
  notifyVitrineDemandListeners();
}

export function getSnapVitrineOrdersToWaves(): boolean {
  return snapVitrineOrdersToWaves;
}

export function setSnapVitrineOrdersToWaves(enabled: boolean): void {
  if (snapVitrineOrdersToWaves === enabled) return;
  snapVitrineOrdersToWaves = enabled;
  notifyVitrineDemandListeners();
}

export function snapOrderMinutesToNearestWave(
  rawMinutes: number,
  waves: readonly VitrineRefillWave[],
  maxMinutes: number,
): Readonly<{ minutes: number; snappedWave: VitrineRefillWave | null }> {
  if (waves.length === 0) {
    return {
      minutes: Math.max(1, Math.min(maxMinutes, rawMinutes)),
      snappedWave: null,
    };
  }
  let nearestWave: VitrineRefillWave = waves[0]!;
  let nearestDistance = Math.abs(
    Math.round(nearestWave.completedAt / 60) - rawMinutes,
  );
  for (const wave of waves) {
    const waveMin = Math.round(wave.completedAt / 60);
    const dist = Math.abs(waveMin - rawMinutes);
    if (dist < nearestDistance) {
      nearestDistance = dist;
      nearestWave = wave;
    }
  }
  return {
    minutes: Math.max(
      1,
      Math.min(maxMinutes, Math.round(nearestWave.completedAt / 60)),
    ),
    snappedWave: nearestWave,
  };
}

function normalizeOrderOverride(
  orderId: string,
  next: VitrineOrderOverride,
  preset: VitrineRushPresetId,
): void {
  const baseIdx = VITRINE_ORDER_TEMPLATES_BY_PRESET[preset].findIndex(
    (t) => t.id === orderId,
  );
  const baseTemplate =
    baseIdx >= 0 ? VITRINE_ORDER_TEMPLATES_BY_PRESET[preset][baseIdx] : undefined;
  const overrides = customOrderOverridesByPreset[preset];
  if (baseTemplate === undefined) {
    overrides.set(orderId, next);
    return;
  }
  const defaultMinutes = Math.round(baseTemplate.orderedAt / 60);
  const defaultBevSpec =
    CAFE_BEVERAGE_ROTATION[baseIdx % CAFE_BEVERAGE_ROTATION.length]!;
  const cleaned: {
    orderedAtMinutes?: number;
    channel?: VitrineOrderChannel;
    loosePieces?: number;
    ballotinBoxes?: number;
    beverageRecipe?: CafeBeverageRecipeId;
    beverageCount?: number;
  } = {};
  if (
    next.orderedAtMinutes !== undefined &&
    next.orderedAtMinutes !== defaultMinutes
  ) {
    cleaned.orderedAtMinutes = next.orderedAtMinutes;
  }
  if (next.channel !== undefined && next.channel !== baseTemplate.channel) {
    cleaned.channel = next.channel;
  }
  if (
    next.loosePieces !== undefined &&
    next.loosePieces !== baseTemplate.loosePieces
  ) {
    cleaned.loosePieces = next.loosePieces;
  }
  if (
    next.ballotinBoxes !== undefined &&
    next.ballotinBoxes !== baseTemplate.ballotinBoxes
  ) {
    cleaned.ballotinBoxes = next.ballotinBoxes;
  }
  if (
    next.beverageRecipe !== undefined &&
    next.beverageRecipe !== (baseTemplate.beverageRecipe ?? defaultBevSpec.recipe)
  ) {
    cleaned.beverageRecipe = next.beverageRecipe;
  }
  const effLoose = cleaned.loosePieces ?? baseTemplate.loosePieces;
  const effBoxes = cleaned.ballotinBoxes ?? baseTemplate.ballotinBoxes;
  const defaultCups =
    baseTemplate.beverageCount ??
    (effBoxes >= 2 ? 3 : effLoose >= 3 ? 2 : 1);
  if (next.beverageCount !== undefined && next.beverageCount !== defaultCups) {
    cleaned.beverageCount = next.beverageCount;
  }
  if (Object.keys(cleaned).length === 0) {
    overrides.delete(orderId);
  } else {
    overrides.set(orderId, cleaned);
  }
}

export type VitrineDemandPresetSnapshot = Readonly<{
  overrides: readonly (readonly [string, VitrineOrderOverride])[];
  added: readonly VitrineOrderTemplate[];
}>;

export type VitrineDemandSnapshot = Readonly<{
  activePreset: VitrineRushPresetId;
  autoScaleBatches: boolean;
  presets: Readonly<Record<VitrineRushPresetId, VitrineDemandPresetSnapshot>>;
}>;

export type VitrineDemandHistoryEvent = Readonly<{
  label: string;
  coalesceKey?: string;
  before: VitrineDemandSnapshot;
  after: VitrineDemandSnapshot;
}>;

let isRestoringVitrineDemand = false;
const vitrineDemandHistoryListeners = new Set<
  (event: VitrineDemandHistoryEvent) => void
>();

export function captureVitrineDemandSnapshot(): VitrineDemandSnapshot {
  const presets: readonly VitrineRushPresetId[] = [
    "quiet",
    "normal",
    "weekend-rush",
  ];
  const presetMap = {} as Record<
    VitrineRushPresetId,
    VitrineDemandPresetSnapshot
  >;
  for (const p of presets) {
    presetMap[p] = {
      overrides: Array.from(customOrderOverridesByPreset[p].entries()).map(
        ([id, ov]) => [id, { ...ov }] as const,
      ),
      added: customAddedOrdersByPreset[p].map((tpl) => ({ ...tpl })),
    };
  }
  return {
    activePreset: activeVitrineRushPreset,
    autoScaleBatches: autoScaleVitrineBatches,
    presets: presetMap,
  };
}

export function restoreVitrineDemandSnapshot(
  snapshot: VitrineDemandSnapshot,
): void {
  isRestoringVitrineDemand = true;
  try {
    activeVitrineRushPreset = snapshot.activePreset;
    autoScaleVitrineBatches = snapshot.autoScaleBatches;
    const presets: readonly VitrineRushPresetId[] = [
      "quiet",
      "normal",
      "weekend-rush",
    ];
    for (const p of presets) {
      const entry = snapshot.presets[p];
      customOrderOverridesByPreset[p].clear();
      for (const [id, ov] of entry.overrides) {
        customOrderOverridesByPreset[p].set(id, { ...ov });
      }
      customAddedOrdersByPreset[p].splice(
        0,
        customAddedOrdersByPreset[p].length,
        ...entry.added.map((tpl) => ({ ...tpl })),
      );
    }
    notifyVitrineDemandListeners();
  } finally {
    isRestoringVitrineDemand = false;
  }
}

export function subscribeVitrineDemandHistory(
  listener: (event: VitrineDemandHistoryEvent) => void,
): () => void {
  vitrineDemandHistoryListeners.add(listener);
  return () => {
    vitrineDemandHistoryListeners.delete(listener);
  };
}

function emitVitrineDemandHistory(
  label: string,
  before: VitrineDemandSnapshot,
  coalesceKey?: string,
): void {
  if (isRestoringVitrineDemand) return;
  const after = captureVitrineDemandSnapshot();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const event: VitrineDemandHistoryEvent = {
    label,
    ...(coalesceKey !== undefined ? { coalesceKey } : {}),
    before,
    after,
  };
  for (const listener of vitrineDemandHistoryListeners) {
    try {
      listener(event);
    } catch {
      // Keep remaining listeners intact
    }
  }
}

export function setVitrineOrderArrivalMinutes(
  orderId: string,
  minutesFromStart: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
  coalesce = true,
): void {
  const before = captureVitrineDemandSnapshot();
  const clamped = Math.max(1, Math.min(180, Math.round(minutesFromStart)));
  const existing = customOrderOverridesByPreset[preset].get(orderId) ?? {};
  normalizeOrderOverride(
    orderId,
    { ...existing, orderedAtMinutes: clamped },
    preset,
  );
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(
    `Edit order ${orderId} arrival`,
    before,
    coalesce ? `vitrine-arrival:${preset}:${orderId}` : undefined,
  );
}

export function setVitrineOrderItems(
  orderId: string,
  patch: Readonly<{
    channel?: VitrineOrderChannel;
    loosePieces?: number;
    ballotinBoxes?: number;
    beverageRecipe?: CafeBeverageRecipeId;
    beverageCount?: number;
  }>,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const before = captureVitrineDemandSnapshot();
  const existing = customOrderOverridesByPreset[preset].get(orderId) ?? {};
  const next: VitrineOrderOverride = {
    ...existing,
    ...(patch.channel !== undefined ? { channel: patch.channel } : {}),
    ...(patch.loosePieces !== undefined
      ? { loosePieces: Math.max(0, Math.min(24, Math.round(patch.loosePieces))) }
      : {}),
    ...(patch.ballotinBoxes !== undefined
      ? {
          ballotinBoxes: Math.max(
            0,
            Math.min(8, Math.round(patch.ballotinBoxes)),
          ),
        }
      : {}),
    ...(patch.beverageRecipe !== undefined
      ? { beverageRecipe: patch.beverageRecipe }
      : {}),
    ...(patch.beverageCount !== undefined
      ? {
          beverageCount: Math.max(
            1,
            Math.min(6, Math.round(patch.beverageCount)),
          ),
        }
      : {}),
  };
  normalizeOrderOverride(orderId, next, preset);
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(`Edit order ${orderId}`, before);
}

export function nudgeVitrineOrderArrivalMinutes(
  orderId: string,
  deltaMinutes: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const allTemplates = [
    ...VITRINE_ORDER_TEMPLATES_BY_PRESET[preset],
    ...customAddedOrdersByPreset[preset],
  ];
  const tpl = allTemplates.find((t) => t.id === orderId);
  if (tpl === undefined) return;
  const currentMinutes =
    customOrderOverridesByPreset[preset].get(orderId)?.orderedAtMinutes ??
    Math.round(tpl.orderedAt / 60);
  setVitrineOrderArrivalMinutes(
    orderId,
    currentMinutes + deltaMinutes,
    preset,
    false,
  );
}

export function shiftAllVitrineOrderArrivals(
  deltaMinutes: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const before = captureVitrineDemandSnapshot();
  const allTemplates = [
    ...VITRINE_ORDER_TEMPLATES_BY_PRESET[preset],
    ...customAddedOrdersByPreset[preset],
  ];
  const overrides = customOrderOverridesByPreset[preset];
  for (const tpl of allTemplates) {
    const existing = overrides.get(tpl.id) ?? {};
    const currentMinutes =
      existing.orderedAtMinutes ?? Math.round(tpl.orderedAt / 60);
    const nextMinutes = Math.max(
      1,
      Math.min(180, Math.round(currentMinutes + deltaMinutes)),
    );
    normalizeOrderOverride(
      tpl.id,
      { ...existing, orderedAtMinutes: nextMinutes },
      preset,
    );
  }
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory("Shift all order arrivals", before);
}

export function addCustomVitrineOrder(
  options?: Readonly<{
    orderedAtMinutes?: number;
    loosePieces?: number;
    ballotinBoxes?: number;
    channel?: VitrineOrderChannel;
    beverageRecipe?: CafeBeverageRecipeId;
    beverageCount?: number;
  }>,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): string {
  const before = captureVitrineDemandSnapshot();
  const baseTemplates = VITRINE_ORDER_TEMPLATES_BY_PRESET[preset];
  const added = customAddedOrdersByPreset[preset];
  const allTemplates = [...baseTemplates, ...added];
  const overrides = customOrderOverridesByPreset[preset];
  const nextIndex = allTemplates.length + 1;
  const id = `ORD-${100 + nextIndex}`;
  const maxExistingMinutes = allTemplates.reduce((max, tpl) => {
    const mins =
      overrides.get(tpl.id)?.orderedAtMinutes ?? Math.round(tpl.orderedAt / 60);
    return Math.max(max, mins);
  }, 10);
  const orderedAtMinutes = Math.max(
    1,
    Math.min(
      180,
      Math.round(options?.orderedAtMinutes ?? maxExistingMinutes + 8),
    ),
  );
  const loosePieces = Math.max(0, Math.round(options?.loosePieces ?? 3));
  const ballotinBoxes = Math.max(0, Math.round(options?.ballotinBoxes ?? 1));
  const channel: VitrineOrderChannel = options?.channel ?? "counter";
  const channelLabel =
    channel === "counter"
      ? "Counter POS"
      : channel === "qr-order"
        ? "Table QR"
        : channel === "click-collect"
          ? "Click & Collect"
          : channel === "boutique"
            ? "Boutique"
            : "Walk-in";
  added.push({
    id,
    channel,
    channelLabel,
    label: `Custom Café Order (${ballotinBoxes} Ballotin + ${loosePieces} Loose)`,
    orderedAt: orderedAtMinutes * 60,
    loosePieces,
    ballotinBoxes,
    ...(options?.beverageRecipe !== undefined
      ? { beverageRecipe: options.beverageRecipe }
      : {}),
    ...(options?.beverageCount !== undefined
      ? { beverageCount: options.beverageCount }
      : {}),
  });
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(`Add customer order ${id}`, before);
  return id;
}

export function removeCustomVitrineOrder(
  orderId: string,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const before = captureVitrineDemandSnapshot();
  const added = customAddedOrdersByPreset[preset];
  const idx = added.findIndex((o) => o.id === orderId);
  const hadOverride = customOrderOverridesByPreset[preset].delete(orderId);
  if (idx >= 0) {
    added.splice(idx, 1);
  }
  if (idx >= 0 || hadOverride) {
    notifyVitrineDemandListeners();
    emitVitrineDemandHistory(`Remove customer order ${orderId}`, before);
  }
}

export function resetCustomVitrineOrders(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): void {
  const overrides = customOrderOverridesByPreset[preset];
  const added = customAddedOrdersByPreset[preset];
  if (overrides.size === 0 && added.length === 0) return;
  const before = captureVitrineDemandSnapshot();
  overrides.clear();
  added.length = 0;
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory("Reset customer orders", before);
}

export type VitrineOrderSchedulePayload = Readonly<{
  schemaVersion: 1;
  preset: VitrineRushPresetId;
  overrides: Readonly<Record<string, VitrineOrderOverride>>;
  addedOrders: readonly VitrineOrderTemplate[];
}>;

export function exportCustomVitrineOrdersJson(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): string {
  const overridesObj: Record<string, VitrineOrderOverride> = {};
  for (const [id, ov] of customOrderOverridesByPreset[preset].entries()) {
    overridesObj[id] = ov;
  }
  const payload: VitrineOrderSchedulePayload = {
    schemaVersion: 1,
    preset,
    overrides: overridesObj,
    addedOrders: [...customAddedOrdersByPreset[preset]],
  };
  return JSON.stringify(payload, null, 2);
}

export function importCustomVitrineOrdersJson(
  jsonText: string,
  targetPreset?: VitrineRushPresetId,
): Readonly<
  | {
      ok: true;
      preset: VitrineRushPresetId;
      orderCount: number;
      customCount: number;
    }
  | { ok: false; error: string }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "Invalid customer order schedule JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Customer order schedule JSON must be an object.",
    };
  }
  const record = parsed as Record<string, unknown>;
  const validPresets: readonly VitrineRushPresetId[] = [
    "quiet",
    "normal",
    "weekend-rush",
  ];
  const resolvedPreset: VitrineRushPresetId =
    targetPreset ??
    (typeof record.preset === "string" &&
    (validPresets as readonly string[]).includes(record.preset)
      ? (record.preset as VitrineRushPresetId)
      : activeVitrineRushPreset);

  const validChannels = new Set<string>(VITRINE_ORDER_CHANNELS.map((c) => c.id));
  const validBeverages = new Set<string>(
    CAFE_BEVERAGE_ROTATION.map((b) => b.recipe),
  );

  const rawOverrides = record.overrides;
  const overrideEntries: [string, unknown][] = Array.isArray(rawOverrides)
    ? rawOverrides.filter(
        (item): item is [string, unknown] =>
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[0] === "string",
      )
    : rawOverrides !== null && typeof rawOverrides === "object"
      ? Object.entries(rawOverrides as Record<string, unknown>)
      : [];

  const rawAdded = Array.isArray(record.addedOrders)
    ? record.addedOrders
    : Array.isArray(record.added)
      ? record.added
      : [];

  const nextAdded: VitrineOrderTemplate[] = [];
  for (const item of rawAdded) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id =
      typeof obj.id === "string" && obj.id.trim().length > 0
        ? obj.id.trim()
        : `ORD-${100 + VITRINE_ORDER_TEMPLATES_BY_PRESET[resolvedPreset].length + nextAdded.length + 1}`;
    const orderedAtMinutes =
      typeof obj.orderedAtMinutes === "number" &&
      Number.isFinite(obj.orderedAtMinutes)
        ? Math.max(1, Math.min(180, Math.round(obj.orderedAtMinutes)))
        : typeof obj.orderedAt === "number" && Number.isFinite(obj.orderedAt)
          ? Math.max(1, Math.min(180, Math.round(obj.orderedAt / 60)))
          : 90;
    const loosePieces =
      typeof obj.loosePieces === "number" && Number.isFinite(obj.loosePieces)
        ? Math.max(0, Math.min(24, Math.round(obj.loosePieces)))
        : 3;
    const ballotinBoxes =
      typeof obj.ballotinBoxes === "number" &&
      Number.isFinite(obj.ballotinBoxes)
        ? Math.max(0, Math.min(8, Math.round(obj.ballotinBoxes)))
        : 1;
    const channel: VitrineOrderChannel =
      typeof obj.channel === "string" && validChannels.has(obj.channel)
        ? (obj.channel as VitrineOrderChannel)
        : "counter";
    const channelLabel =
      VITRINE_ORDER_CHANNELS.find((c) => c.id === channel)?.label ??
      "Counter POS";
    const beverageRecipe =
      typeof obj.beverageRecipe === "string" &&
      validBeverages.has(obj.beverageRecipe)
        ? (obj.beverageRecipe as CafeBeverageRecipeId)
        : undefined;
    const beverageCount =
      typeof obj.beverageCount === "number" &&
      Number.isFinite(obj.beverageCount)
        ? Math.max(1, Math.min(6, Math.round(obj.beverageCount)))
        : undefined;
    nextAdded.push({
      id,
      channel,
      channelLabel,
      label:
        typeof obj.label === "string" && obj.label.trim().length > 0
          ? obj.label
          : `Custom Café Order (${ballotinBoxes} Ballotin + ${loosePieces} Loose)`,
      orderedAt: orderedAtMinutes * 60,
      loosePieces,
      ballotinBoxes,
      ...(beverageRecipe !== undefined ? { beverageRecipe } : {}),
      ...(beverageCount !== undefined ? { beverageCount } : {}),
    });
  }

  const before = captureVitrineDemandSnapshot();
  customOrderOverridesByPreset[resolvedPreset].clear();
  customAddedOrdersByPreset[resolvedPreset].splice(
    0,
    customAddedOrdersByPreset[resolvedPreset].length,
    ...nextAdded,
  );

  for (const [id, rawOv] of overrideEntries) {
    if (rawOv === null || typeof rawOv !== "object") continue;
    const ov = rawOv as Record<string, unknown>;
    const patch: {
      orderedAtMinutes?: number;
      channel?: VitrineOrderChannel;
      loosePieces?: number;
      ballotinBoxes?: number;
      beverageRecipe?: CafeBeverageRecipeId;
      beverageCount?: number;
    } = {};
    if (
      typeof ov.orderedAtMinutes === "number" &&
      Number.isFinite(ov.orderedAtMinutes)
    ) {
      patch.orderedAtMinutes = Math.max(
        1,
        Math.min(180, Math.round(ov.orderedAtMinutes)),
      );
    }
    if (typeof ov.channel === "string" && validChannels.has(ov.channel)) {
      patch.channel = ov.channel as VitrineOrderChannel;
    }
    if (typeof ov.loosePieces === "number" && Number.isFinite(ov.loosePieces)) {
      patch.loosePieces = Math.max(
        0,
        Math.min(24, Math.round(ov.loosePieces)),
      );
    }
    if (
      typeof ov.ballotinBoxes === "number" &&
      Number.isFinite(ov.ballotinBoxes)
    ) {
      patch.ballotinBoxes = Math.max(
        0,
        Math.min(8, Math.round(ov.ballotinBoxes)),
      );
    }
    if (
      typeof ov.beverageRecipe === "string" &&
      validBeverages.has(ov.beverageRecipe)
    ) {
      patch.beverageRecipe = ov.beverageRecipe as CafeBeverageRecipeId;
    }
    if (
      typeof ov.beverageCount === "number" &&
      Number.isFinite(ov.beverageCount)
    ) {
      patch.beverageCount = Math.max(
        1,
        Math.min(6, Math.round(ov.beverageCount)),
      );
    }
    normalizeOrderOverride(id, patch, resolvedPreset);
  }

  activeVitrineRushPreset = resolvedPreset;
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory("Import customer order schedule", before);
  const totalOrderCount =
    VITRINE_ORDER_TEMPLATES_BY_PRESET[resolvedPreset].length +
    customAddedOrdersByPreset[resolvedPreset].length;
  const customCount =
    customOrderOverridesByPreset[resolvedPreset].size +
    customAddedOrdersByPreset[resolvedPreset].length;
  return {
    ok: true,
    preset: resolvedPreset,
    orderCount: totalOrderCount,
    customCount,
  };
}

export function recommendedBatchCountForRushPreset(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): number {
  return recommendedCapacityForRushPreset(preset).batchCount;
}

export function recommendedCapacityForRushPreset(
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): Readonly<{
  batchCount: number;
  workerCount: number;
  ovenTrays: number;
  horizonMinutes: number;
}> {
  const spec =
    VITRINE_RUSH_PRESETS.find((p) => p.id === preset) ??
    VITRINE_RUSH_PRESETS[1]!;
  const added = customAddedOrdersByPreset[preset];
  const overrides = customOrderOverridesByPreset[preset];
  const hasItemOverrides = Array.from(overrides.values()).some(
    (ov) => ov.loosePieces !== undefined || ov.ballotinBoxes !== undefined,
  );
  if (added.length === 0 && !hasItemOverrides) {
    return {
      batchCount: spec.recommendedBatchCount,
      workerCount: spec.recommendedWorkerCount,
      ovenTrays: spec.recommendedOvenTrays,
      horizonMinutes: spec.recommendedHorizonMinutes,
    };
  }
  const allTemplates = [...VITRINE_ORDER_TEMPLATES_BY_PRESET[preset], ...added];
  const totalLoose = allTemplates.reduce(
    (sum, o) => sum + (overrides.get(o.id)?.loosePieces ?? o.loosePieces),
    0,
  );
  const totalBallotins = allTemplates.reduce(
    (sum, o) => sum + (overrides.get(o.id)?.ballotinBoxes ?? o.ballotinBoxes),
    0,
  );
  const batchesForLoose = Math.ceil(
    Math.max(0, totalLoose - VITRINE_REFILL_YIELD.openingLoosePieces) /
      VITRINE_REFILL_YIELD.loosePiecesPerBatchWave,
  );
  const batchesForBallotins = Math.ceil(
    Math.max(0, totalBallotins - VITRINE_REFILL_YIELD.openingBallotinBoxes) /
      VITRINE_REFILL_YIELD.ballotinBoxesPerBatchWave,
  );
  const batchCount = Math.min(
    6,
    Math.max(spec.recommendedBatchCount, batchesForLoose, batchesForBallotins),
  );
  const workerCount = Math.max(
    spec.recommendedWorkerCount,
    batchCount >= 5 ? 3 : 2,
  );
  const ovenTrays = Math.max(
    spec.recommendedOvenTrays,
    batchCount >= 5 ? 6 : 4,
  );
  const horizonMinutes = Math.max(
    spec.recommendedHorizonMinutes,
    batchCount >= 5 ? 150 : 120,
  );
  return {
    batchCount,
    workerCount,
    ovenTrays,
    horizonMinutes,
  };
}

export function shouldApplyVitrineCapacity(): boolean {
  return autoScaleVitrineBatches || forceApplyRecommendedCapacity;
}

export function applyRecommendedVitrineCapacity(): void {
  forceApplyRecommendedCapacity = true;
  try {
    notifyVitrineDemandListeners();
  } finally {
    forceApplyRecommendedCapacity = false;
  }
}

export function getAutoScaleVitrineBatches(): boolean {
  return autoScaleVitrineBatches;
}

export function setAutoScaleVitrineBatches(enabled: boolean): void {
  if (autoScaleVitrineBatches === enabled) return;
  const before = captureVitrineDemandSnapshot();
  autoScaleVitrineBatches = enabled;
  notifyVitrineDemandListeners();
  emitVitrineDemandHistory(
    enabled ? "Enable batch auto-scaling" : "Disable batch auto-scaling",
    before,
  );
}

export function getActiveVitrineRushPreset(): VitrineRushPresetId {
  return activeVitrineRushPreset;
}

export function setActiveVitrineRushPreset(preset: VitrineRushPresetId): void {
  if (activeVitrineRushPreset === preset) return;
  const before = captureVitrineDemandSnapshot();
  activeVitrineRushPreset = preset;
  notifyVitrineDemandListeners();
  const presetSpec = VITRINE_RUSH_PRESETS.find((p) => p.id === preset);
  emitVitrineDemandHistory(
    `Rush preset: ${presetSpec?.shortLabel ?? preset}`,
    before,
  );
}

export function subscribeVitrineRushPreset(listener: () => void): () => void {
  vitrineRushListeners.add(listener);
  return () => {
    vitrineRushListeners.delete(listener);
  };
}

export function vitrineStockAt(
  run: Run,
  time: number,
  preset: VitrineRushPresetId = activeVitrineRushPreset,
): VitrineStockSnapshot {
  const baseTemplates = VITRINE_ORDER_TEMPLATES_BY_PRESET[preset];
  const addedTemplates = customAddedOrdersByPreset[preset];
  const overrides = customOrderOverridesByPreset[preset];
  const resolvedTemplates = [...baseTemplates, ...addedTemplates]
    .map((tpl, templateIdx) => {
      const isCustomOrder = templateIdx >= baseTemplates.length;
      const ov = overrides.get(tpl.id);
      const orderedAt =
        ov?.orderedAtMinutes !== undefined
          ? ov.orderedAtMinutes * 60
          : tpl.orderedAt;
      const orderedAtMinutes = Math.round(orderedAt / 60);
      const defaultOrderedAt = tpl.orderedAt;
      const defaultOrderedAtMinutes = Math.round(defaultOrderedAt / 60);
      const loosePieces = ov?.loosePieces ?? tpl.loosePieces;
      const ballotinBoxes = ov?.ballotinBoxes ?? tpl.ballotinBoxes;
      const channel = ov?.channel ?? tpl.channel;
      const channelLabel =
        VITRINE_ORDER_CHANNELS.find((c) => c.id === channel)?.label ??
        tpl.channelLabel;
      const beverageRecipe = ov?.beverageRecipe ?? tpl.beverageRecipe;
      const beverageCount = ov?.beverageCount ?? tpl.beverageCount;
      const isCustomArrival =
        isCustomOrder ||
        orderedAt !== defaultOrderedAt ||
        channel !== tpl.channel ||
        loosePieces !== tpl.loosePieces ||
        ballotinBoxes !== tpl.ballotinBoxes ||
        ov?.beverageRecipe !== undefined ||
        ov?.beverageCount !== undefined;
      return {
        ...tpl,
        channel,
        channelLabel,
        loosePieces,
        ballotinBoxes,
        ...(beverageRecipe !== undefined ? { beverageRecipe } : {}),
        ...(beverageCount !== undefined ? { beverageCount } : {}),
        templateIdx,
        orderedAt,
        orderedAtMinutes,
        defaultOrderedAt,
        defaultOrderedAtMinutes,
        isCustomArrival,
        isCustomOrder,
      };
    })
    .sort(
      (a, b) => a.orderedAt - b.orderedAt || a.templateIdx - b.templateIdx,
    );
  const presetSpec =
    VITRINE_RUSH_PRESETS.find((p) => p.id === preset) ??
    VITRINE_RUSH_PRESETS[1]!;
  const recCapacity = recommendedCapacityForRushPreset(preset);
  const packProcesses = run.intervals
    .filter(
      (t): t is Process => t.kind === "process" && t.operation === "pack",
    )
    .slice()
    .sort((a, b) => a.start - b.start);

  const packByBatch = new Map<string, Process>();
  for (const task of packProcesses) {
    packByBatch.set(task.batch, task);
  }
  const packDurationSec = Math.max(60, run.settings.pack * 60);
  let lastPackStart =
    packProcesses.length > 0
      ? packProcesses[packProcesses.length - 1]!.arrival
      : 3600;

  const refillWaves: VitrineRefillWave[] = run.batches.map((batch, idx) => {
    const task = packByBatch.get(batch.id);
    const packStart =
      task !== undefined
        ? task.start === 0
          ? 0
          : task.arrival
        : (lastPackStart += 1160);
    const completedAt =
      task !== undefined ? task.end : packStart + packDurationSec;
    const refillStart = Math.round(
      packStart + (completedAt - packStart) * 0.68,
    );
    if (task !== undefined) {
      lastPackStart = packStart;
    }
    let status: VitrineRefillWaveStatus = "pending";
    if (task !== undefined && time >= completedAt) {
      status = "completed";
    } else if (task !== undefined && time >= refillStart) {
      status = "restocking-vitrine";
    } else if (task !== undefined && time >= packStart) {
      status = "packing-ballotins";
    }
    return {
      waveNumber: idx + 1,
      batchId: batch.id,
      workerId: task !== undefined && task.attended ? task.executor : null,
      packStart,
      refillStart,
      completedAt,
      loosePiecesAdded: VITRINE_REFILL_YIELD.loosePiecesPerBatchWave,
      ballotinBoxesAdded: VITRINE_REFILL_YIELD.ballotinBoxesPerBatchWave,
      totalPiecesAdded: VITRINE_REFILL_YIELD.totalPiecesPerBatchWave,
      status,
    };
  });

  // Build chronological timeline of order arrivals and completed refill waves up to `time`
  let loosePieces: number = VITRINE_REFILL_YIELD.openingLoosePieces;
  let ballotinBoxes: number = VITRINE_REFILL_YIELD.openingBallotinBoxes;
  let soldLoosePieces = 0;
  let soldBallotinBoxes = 0;
  let restockedLoosePieces = 0;
  let restockedBallotinBoxes = 0;
  let latestWaveNumber: number | null = null;

  let barAvailableAt = 0;
  const orderStates = resolvedTemplates.map((tpl) => {
    const defaultBevSpec =
      CAFE_BEVERAGE_ROTATION[tpl.templateIdx % CAFE_BEVERAGE_ROTATION.length]!;
    const beverageRecipe = tpl.beverageRecipe ?? defaultBevSpec.recipe;
    const bevSpec =
      CAFE_BEVERAGE_ROTATION.find((b) => b.recipe === beverageRecipe) ??
      defaultBevSpec;
    const beverageCount =
      tpl.beverageCount ??
      (tpl.ballotinBoxes >= 2 ? 3 : tpl.loosePieces >= 3 ? 2 : 1);
    const beverageLabel = tpl.beverageLabel ?? bevSpec.label(beverageCount);
    const beverageEquipment = tpl.beverageEquipment ?? bevSpec.equipment;
    const brewDurationSeconds =
      tpl.brewDurationSeconds ??
      Math.min(280, bevSpec.brewSecondsPerCup * beverageCount);
    const brewStart = Math.max(tpl.orderedAt, barAvailableAt);
    const brewEnd = brewStart + brewDurationSeconds;
    barAvailableAt = brewEnd;
    const beverageWaitSeconds = brewEnd - tpl.orderedAt;
    const beverageStatus: CafeBeverageStatus =
      time < tpl.orderedAt
        ? "upcoming"
        : time < brewStart
          ? "queued-bar"
          : time < brewEnd
            ? "brewing"
            : "served";
    return {
      id: tpl.id,
      channel: tpl.channel,
      channelLabel: tpl.channelLabel,
      label: tpl.label,
      orderedAt: tpl.orderedAt,
      orderedAtMinutes: tpl.orderedAtMinutes,
      defaultOrderedAt: tpl.defaultOrderedAt,
      defaultOrderedAtMinutes: tpl.defaultOrderedAtMinutes,
      isCustomArrival: tpl.isCustomArrival,
      isCustomOrder: tpl.isCustomOrder,
      loosePieces: tpl.loosePieces,
      ballotinBoxes: tpl.ballotinBoxes,
      totalPieces:
        tpl.loosePieces +
        tpl.ballotinBoxes * VITRINE_REFILL_YIELD.piecesPerBallotinBox,
      status: "upcoming" as VitrineOrderStatus,
      fulfilledAt: null as number | null,
      fulfilledByWave: null as number | null,
      beverageRecipe,
      beverageLabel,
      beverageCount,
      beverageEquipment,
      brewDurationSeconds,
      brewStart,
      brewEnd,
      beverageWaitSeconds,
      beverageStatus,
    };
  });

  type EventItem =
    | { readonly kind: "wave"; readonly at: number; readonly wave: VitrineRefillWave }
    | { readonly kind: "order"; readonly at: number; readonly orderIndex: number };

  const events: EventItem[] = [];
  for (const wave of refillWaves) {
    if (wave.status === "completed") {
      events.push({ kind: "wave", at: wave.completedAt, wave });
    }
  }
  orderStates.forEach((ord, idx) => {
    if (ord.orderedAt <= time) {
      events.push({ kind: "order", at: ord.orderedAt, orderIndex: idx });
    }
  });
  events.sort((a, b) =>
    a.at !== b.at ? a.at - b.at : a.kind === "wave" ? -1 : 1,
  );

  const tryFulfillWaiting = (now: number) => {
    for (const ord of orderStates) {
      if (ord.status !== "waiting-refill") continue;
      if (
        loosePieces >= ord.loosePieces &&
        ballotinBoxes >= ord.ballotinBoxes
      ) {
        loosePieces -= ord.loosePieces;
        ballotinBoxes -= ord.ballotinBoxes;
        soldLoosePieces += ord.loosePieces;
        soldBallotinBoxes += ord.ballotinBoxes;
        ord.status = "fulfilled";
        ord.fulfilledAt = now;
        ord.fulfilledByWave = latestWaveNumber;
      }
    }
  };

  for (const ev of events) {
    if (ev.kind === "wave") {
      loosePieces = Math.min(
        VITRINE_REFILL_YIELD.looseCapacity,
        loosePieces + ev.wave.loosePiecesAdded,
      );
      ballotinBoxes = Math.min(
        VITRINE_REFILL_YIELD.ballotinCapacity,
        ballotinBoxes + ev.wave.ballotinBoxesAdded,
      );
      restockedLoosePieces += ev.wave.loosePiecesAdded;
      restockedBallotinBoxes += ev.wave.ballotinBoxesAdded;
      latestWaveNumber = ev.wave.waveNumber;
      tryFulfillWaiting(ev.at);
    } else {
      const ord = orderStates[ev.orderIndex]!;
      const hasEarlierWaiting = orderStates.some(
        (o) => o.status === "waiting-refill",
      );
      if (
        !hasEarlierWaiting &&
        loosePieces >= ord.loosePieces &&
        ballotinBoxes >= ord.ballotinBoxes
      ) {
        loosePieces -= ord.loosePieces;
        ballotinBoxes -= ord.ballotinBoxes;
        soldLoosePieces += ord.loosePieces;
        soldBallotinBoxes += ord.ballotinBoxes;
        ord.status = "fulfilled";
        ord.fulfilledAt = ev.at;
        ord.fulfilledByWave = latestWaveNumber;
      } else {
        ord.status = "waiting-refill";
      }
    }
  }

  const orders: readonly VitrineCustomerOrder[] = orderStates;
  const fulfilledOrders = orders.filter((o) => o.status === "fulfilled");
  const waitingOrders = orders.filter((o) => o.status === "waiting-refill");
  const upcomingOrders = orders.filter((o) => o.status === "upcoming");
  const totalBeverageCups = orders.reduce((sum, o) => sum + o.beverageCount, 0);
  const servedBeverageCups = orders
    .filter((o) => o.beverageStatus === "served")
    .reduce((sum, o) => sum + o.beverageCount, 0);
  const brewingOrder =
    orders.find((o) => o.beverageStatus === "brewing") ?? null;
  const maxBeverageWaitSeconds = orders.reduce(
    (max, o) => Math.max(max, o.beverageWaitSeconds),
    0,
  );
  const barStatusLabel =
    brewingOrder !== null
      ? `Brewing ${brewingOrder.beverageLabel} (${brewingOrder.id} · ${brewingOrder.beverageEquipment})`
      : `${servedBeverageCups} / ${totalBeverageCups} cups served · Peak bar wait ${maxBeverageWaitSeconds} s (< 900 s SLA)`;
  const customArrivalCount = orders.filter((o) => o.isCustomArrival).length;
  const hasCustomArrivals = customArrivalCount > 0;
  const firstOrderAt = orders[0]?.orderedAt ?? 0;
  const lastOrderAt = orders[orders.length - 1]?.orderedAt ?? 0;
  const customArrivalSummary = hasCustomArrivals
    ? `${customArrivalCount} custom arrival${customArrivalCount === 1 ? "" : "s"} edited (${orders.length} orders · ${clock(firstOrderAt)}–${clock(lastOrderAt)})`
    : `Default preset schedule (${orders.length} orders · ${clock(firstOrderAt)}–${clock(lastOrderAt)})`;
  const activeWave =
    refillWaves.find(
      (w) =>
        w.status === "packing-ballotins" || w.status === "restocking-vitrine",
    ) ?? null;
  const nextWave = refillWaves.find((w) => w.status === "pending") ?? null;

  let status: VitrineStockStatus = "stocked";
  let statusLabel = "Vitrine stocked";
  if (activeWave !== null && activeWave.status === "restocking-vitrine") {
    status = "restocking";
    statusLabel = `Restocking vitrine (Wave ${activeWave.waveNumber} · Batch ${activeWave.batchId})`;
  } else if (waitingOrders.length > 0) {
    status = "awaiting-refill";
    const targetWave = activeWave ?? nextWave;
    statusLabel =
      targetWave !== null
        ? `${waitingOrders.length} customer order${waitingOrders.length === 1 ? "" : "s"} awaiting Wave ${targetWave.waveNumber} (Batch ${targetWave.batchId})`
        : `${waitingOrders.length} customer order${waitingOrders.length === 1 ? "" : "s"} awaiting vitrine refill`;
  } else if (
    loosePieces <= VITRINE_REFILL_YIELD.lowStockThresholdLoose ||
    ballotinBoxes === 0
  ) {
    status = "low-stock";
    const targetWave = activeWave ?? nextWave;
    statusLabel =
      targetWave !== null
        ? `Low showcase stock · Wave ${targetWave.waveNumber} (Batch ${targetWave.batchId}) queued`
        : "Low showcase stock";
  }

  const recommendedBatchCount = recCapacity.batchCount;
  const scheduledBatchCount = run.settings.batchCount;
  const batchDeficit = Math.max(0, recommendedBatchCount - scheduledBatchCount);
  const recommendedWorkerCount = recCapacity.workerCount;
  const scheduledWorkerCount = run.settings.workerCount;
  const workerDeficit = Math.max(
    0,
    recommendedWorkerCount - scheduledWorkerCount,
  );
  const recommendedOvenTrays = recCapacity.ovenTrays;
  const scheduledOvenTrays = run.settings.ovenTrays;
  const ovenTrayDeficit = Math.max(
    0,
    recommendedOvenTrays - scheduledOvenTrays,
  );
  const unfinishedWavesAtHorizon = refillWaves.filter(
    (w) => w.completedAt > run.end || !packByBatch.has(w.batchId),
  ).length;
  const capacityRecommendationLabel =
    workerDeficit > 0 || ovenTrayDeficit > 0
      ? `${scheduledWorkerCount} / ${recommendedWorkerCount} workers · ${scheduledOvenTrays} / ${recommendedOvenTrays} oven trays (Recommend ${recommendedWorkerCount} workers & ${recommendedOvenTrays} oven trays for ${recommendedBatchCount} batches)`
      : unfinishedWavesAtHorizon > 0
        ? `${scheduledWorkerCount} / ${recommendedWorkerCount} workers · ${scheduledOvenTrays} / ${recommendedOvenTrays} oven trays (${unfinishedWavesAtHorizon} wave${unfinishedWavesAtHorizon === 1 ? "" : "s"} beyond ${Math.round(run.end / 60)} min horizon)`
        : `${scheduledWorkerCount} / ${recommendedWorkerCount} workers · ${scheduledOvenTrays} / ${recommendedOvenTrays} oven trays (All ${scheduledBatchCount} waves complete in shift)`;

  return {
    rushPreset: preset,
    rushPresetLabel: presetSpec.label,
    recommendedBatchCount,
    scheduledBatchCount,
    batchDeficit,
    recommendedWorkerCount,
    scheduledWorkerCount,
    workerDeficit,
    recommendedOvenTrays,
    scheduledOvenTrays,
    ovenTrayDeficit,
    unfinishedWavesAtHorizon,
    capacityRecommendationLabel,
    autoScaleBatches: autoScaleVitrineBatches,
    openingLoosePieces: VITRINE_REFILL_YIELD.openingLoosePieces,
    openingBallotinBoxes: VITRINE_REFILL_YIELD.openingBallotinBoxes,
    loosePieces,
    looseCapacity: VITRINE_REFILL_YIELD.looseCapacity,
    ballotinBoxes,
    ballotinCapacity: VITRINE_REFILL_YIELD.ballotinCapacity,
    totalAvailablePieces:
      loosePieces +
      ballotinBoxes * VITRINE_REFILL_YIELD.piecesPerBallotinBox,
    lowStockThresholdLoose: VITRINE_REFILL_YIELD.lowStockThresholdLoose,
    status,
    statusLabel,
    soldLoosePieces,
    soldBallotinBoxes,
    restockedLoosePieces,
    restockedBallotinBoxes,
    orders,
    fulfilledOrders,
    waitingOrders,
    upcomingOrders,
    refillWaves,
    activeWave,
    nextWave,
    totalBeverageCups,
    servedBeverageCups,
    brewingOrder,
    maxBeverageWaitSeconds,
    barStatusLabel,
    customArrivalCount,
    hasCustomArrivals,
    customArrivalSummary,
  };
}

export {
  summarizeVitrineShiftService,
  exportVitrineShiftServiceJson,
  exportVitrineShiftServiceCsv,
  type VitrineShiftServiceMetrics,
} from "./shift-report.ts";
