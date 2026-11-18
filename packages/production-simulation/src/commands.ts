import type {
  ArrivalSourceId,
  CellId,
  CommandId,
  ExecutionId,
  HostSessionId,
  ResourceId,
  RunId,
  TaskId,
  StorageId,
  ProductId,
  DestinationId,
  LocationId,
  LotId,
  Sha256Hex,
} from "./identity.ts";
import type { CheckpointRef } from "./physics.ts";
import type { Interval, LogicalTime, TickDuration } from "./time.ts";
import type { Provenance, TravelRoute } from "./scenario.ts";
import type { StrictUnion } from "@seams/type-utils";

export type RecoveryRequest = Readonly<{
  task: TaskId;
  resource: ResourceId;
  storage: StorageId;
  handling: TickDuration;
  /** The reject position is at the recovery location. Handling includes local removal. */
  attendance: StrictUnion<
    | Readonly<{ kind: "in-place" }>
    | Readonly<{ kind: "worker"; location: LocationId }>
  >;
  evidence: Provenance;
  reports: readonly Readonly<{
    product: ProductId;
    destination: DestinationId;
  }>[];
}>;

/**
 * A command reaches exactly one live execution through its owning host
 * session. A saved artifact or an earlier receipt confers no authority.
 */
export type CommandTarget = Readonly<{
  commandId: CommandId;
  runId: RunId;
  executionId: ExecutionId;
  hostSession: HostSessionId;
  /** Changes only when the engine admits a control command. */
  expectedControlRevision: number;
}>;

/**
 * Pause, resume and recovery apply at the current complete boundary. Other
 * commands apply at the next uncommitted tick. Recipe, layout, model and
 * controller edits start a separate comparison run.
 */
export type InspectionRequest = Readonly<{
  task: TaskId;
  definition: Sha256Hex;
  lots: readonly LotId[];
  outcome: "accept" | "reject";
  note: string;
}>;

export type ControlCommand = CommandTarget &
  StrictUnion<
    | Readonly<{
        kind: "withhold-resource";
        resource: ResourceId;
        interval: Interval;
      }>
    | Readonly<{
        kind: "update-worker-travel";
        resource: ResourceId;
        travel: readonly TravelRoute[];
      }>
    | Readonly<{ kind: "close-arrivals"; source: ArrivalSourceId }>
    | Readonly<{ kind: "extend-horizon"; horizon: LogicalTime }>
    | (Readonly<{ kind: "inspect" }> & InspectionRequest)
    | Readonly<{ kind: "pause" }>
    | Readonly<{ kind: "resume" }>
    | (Readonly<{ kind: "recover" }> & RecoveryRequest)
  >;

export type CommandRejection =
  | "inspection_unavailable"
  | "inspection_binding_mismatch"
  | "inspection_already_recorded"
  | "wrong_run"
  | "wrong_execution"
  | "wrong_host_session"
  | "stale_control_revision"
  | "conflicting_payload"
  | "unknown_target"
  | "invalid_worker_travel"
  | "inside_accepted_history"
  | "horizon_not_extended"
  | "not_paused"
  | "already_paused"
  | "not_advancing"
  | "boundary_unsettled"
  | "run_finished"
  | "recovery_unavailable"
  | "recovery_resource_busy"
  | "recovery_destination_full";

/**
 * Returned as soon as the engine decides admission. Acceptance records the
 * chosen effective tick; it never claims completion or releases a resource.
 * Redelivering an admitted command returns its original receipt.
 */
export type CommandReceipt = Readonly<{
  commandId: CommandId;
  runId: RunId;
  executionId: ExecutionId;
}> &
  (
    | Readonly<{
        status: "accepted";
        controlRevision: number;
        eventSequence: number;
        effectiveAt: LogicalTime;
        reason?: never;
      }>
    | Readonly<{
        status: "rejected";
        reason: CommandRejection;
        controlRevision?: never;
        eventSequence?: never;
        effectiveAt?: never;
      }>
  );

/**
 * A pause is admitted at once and settles later, when every evolving cell has
 * a real checkpoint at one accepted boundary. The two are recorded separately.
 */
export type PauseSettlement = Readonly<{ commandId: CommandId }> &
  (
    | Readonly<{
        kind: "settled";
        boundary: LogicalTime;
        cells: readonly Readonly<{ cell: CellId; checkpoint: CheckpointRef }>[];
      }>
    | Readonly<{
        kind: "recovery-required";
        /** Cells with no valid checkpoint coverage at the boundary. */
        cells: readonly CellId[];
        boundary?: never;
      }>
  );
