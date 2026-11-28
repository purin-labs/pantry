import { HUMAN_CELL_TRANSFER } from "./human-cell-transfer.ts";
import type { ProductionManualTask } from "@purin-labs/bakery-model/bakery-production-scenario";
import type {
  StationId,
  Operation,
  Settings,
} from "@purin-labs/bakery-model/bakery";
import type {
  PhysicsOutcome,
  PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import type {
  ProductionWorkcell,
  PlannedProductionWorkcell,
} from "./production-workcells.ts";
import type { CompletedAttempt, HeldAttempt } from "./workcell-attempt.ts";
import type {
  CellId,
  CellInstance,
  NativeSkill,
} from "./workcell-instances.ts";
import type { RunFaults } from "./run-faults.ts";
import type { WorkcellResource, WorkcellResourceId } from "./workcell-input.ts";
import type { VariantBy } from "@purin-labs/type-utils";
import type { Point, ResolvedScheduleLayout } from "./schedule-layout.ts";

export type ScheduleVariant = "normal" | "outage";

export type Batch = {
  readonly id: string;
  readonly quantity: number;
  readonly trays: number;
  readonly release: number;
  readonly deadline: number;
};

export type BatchProcedure = Batch & Readonly<{ steps: readonly Step[] }>;

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

export const resolved: unique symbol = Symbol("resolved bakery run input");
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
export type RunModel =
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
type ProcessTaskId = `batch:${string}:process:${Operation}`;
type TransferTaskId =
  `batch:${string}:transfer:${StationId}:${StationId}`;
export type BakeryTaskId =
  | ProcessTaskId
  | TransferTaskId
  | `batch:${string}:native:${string}`
  | `batch:${string}:handoff:${string}`;

export type KitchenZoneId = "prep-zone" | "hearth-zone" | "finishing-zone";

type StaffRoleId = "tourier-prep" | "four-finition" | "commis-vitrine";

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

type Transfer = Span & {
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
type InjectedFailureEvidence = Readonly<{
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

type SimulatedCompletion = Readonly<{
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

export type Work = { batch: BatchProcedure; state: WorkState };

export type Worker = {
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

export type OvenState =
  | { kind: "idle" }
  | { kind: "loading"; closeAt: number }
  | { kind: "baking"; end: number }
  | { kind: "unloading" };

// An assumed recovery releases a failed task's baker and cell at its time.
export type Release = Readonly<{
  time: number;
  worker: HumanId | null;
  root: string;
  batch: string;
  station: StationId;
}>;

export type RunData = RunModel & {
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

export type Step =
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
