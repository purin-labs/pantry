import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import type {
  AttemptId,
  BoundaryId,
  CarrierId,
  CellId,
  ExecutionId,
  HoldModelId,
  MeasurementId,
  RunId,
  Sha256Hex,
  StorageId,
  TaskId,
} from "./identity.ts";
import { err, ok, type Result } from "./result.ts";
import type { NativeOperation } from "./scenario.ts";
import type { LogicalTime, StepCount, TickDuration } from "./time.ts";
import type { MaterialQuantity } from "./quantity.ts";

/**
 * What crosses between the engine and a physics host. The scheduler never
 * writes bodies, joints or controller memory; it exchanges these values with
 * the native adapter and commits what the adapter evidences.
 */

export type ExecutionBackend = "browser" | "headless";

/**
 * The approved, immutable build a resumable snapshot resumes through: Wasm or
 * native runner, its loader, the host adapter, this engine and their decoders.
 */
export type ExecutionBundle = Readonly<{
  id: Sha256Hex;
  backend: ExecutionBackend;
  protocolVersion: number;
  checkpointSchemaVersion: number;
  engineHash: Sha256Hex;
  controllerSourceHash: Sha256Hex;
  controllerHash: Sha256Hex;
  runtimeHash: Sha256Hex;
}>;

export type ResumeSupport =
  | Readonly<{ kind: "resumable"; bundle: ExecutionBundle; reason?: never }>
  | Readonly<{
      kind: "inspection-only";
      reason: "bundle_unavailable" | "backend_differs" | "bundle_altered";
      bundle?: never;
    }>;

/**
 * Whether this host can resume a snapshot saved under `saved`. Only the exact
 * retained bundle qualifies: numeric parity between backends or a newer
 * controller never substitutes for it.
 */
export function resumeSupport(
  saved: ExecutionBundle,
  backend: ExecutionBackend,
  approved: readonly ExecutionBundle[],
): ResumeSupport {
  if (saved.backend !== backend)
    return { kind: "inspection-only", reason: "backend_differs" };
  for (const bundle of approved) {
    if (bundle.id !== saved.id) continue;
    return bundle.backend === saved.backend &&
      bundle.protocolVersion === saved.protocolVersion &&
      bundle.checkpointSchemaVersion === saved.checkpointSchemaVersion &&
      bundle.engineHash === saved.engineHash &&
      bundle.controllerSourceHash === saved.controllerSourceHash &&
      bundle.controllerHash === saved.controllerHash &&
      bundle.runtimeHash === saved.runtimeHash
      ? { kind: "resumable", bundle }
      : { kind: "inspection-only", reason: "bundle_altered" };
  }
  return { kind: "inspection-only", reason: "bundle_unavailable" };
}

/** Every physics message names its run, execution, cell and attempt. */
export type AttemptAddress = Readonly<{
  runId: RunId;
  executionId: ExecutionId;
  cellId: CellId;
  attemptId: AttemptId;
}>;

/** Complete controller and physical state at an exact step boundary. */
export type CheckpointRef = Readonly<{
  digest: Sha256Hex;
  byteLength: number;
  /** Integration steps since the cell's world was created. */
  step: StepCount;
}>;

export type RecordingRef = Readonly<{
  digest: Sha256Hex;
  byteLength: number;
}>;

/** Solver observations outside an operation, validated by the cell adapter. */
export type CellRecording = Readonly<{
  cellId: CellId;
  predecessor: Sha256Hex;
  checkpoint: Sha256Hex;
  /** Native poses and provenance, retained without changing their meaning. */
  content: string;
}> &
  StrictUnion<
    | Readonly<{
        kind: "idle";
        steps: Readonly<{ start: StepCount; end: StepCount }>;
      }>
    | Readonly<{ kind: "admission" | "removal"; step: StepCount }>
  >;

/** Where the controller evidences the carrier after a failure. */
export type CarrierDisposition = "source" | "tool" | "destination" | "unknown";

/**
 * A change of domain meaning, emitted once at its physics step.
 * `controllerSequence` orders events one controller emits at the same step.
 */
export type NativeEvent = Readonly<{
  step: StepCount;
  controllerSequence: number;
}> &
  (
    | Readonly<{ kind: "pickup"; disposition?: never; reason?: never }>
    | Readonly<{ kind: "placement"; disposition?: never; reason?: never }>
    | Readonly<{ kind: "carrier-removed"; disposition?: never; reason?: never }>
    | Readonly<{
        kind: "failure";
        disposition: CarrierDisposition;
        /** The controller's own failure code, for inspection only. */
        reason: string;
      }>
  );

/**
 * Disposable progress from an executing attempt. It carries no checkpoint and
 * no events, so it cannot settle work, move custody or release a resource.
 */
export type Preview = AttemptAddress &
  Readonly<{
    kind: "preview";
    sequence: number;
    step: StepCount;
    phase: string;
  }>;

/**
 * Validated observations and events over one contiguous step interval, bound
 * to the state it started from. Accepting it does not complete its task.
 */
export type Segment = AttemptAddress &
  Readonly<{
    kind: "segment";
    sequence: number;
    /** Digest of the checkpoint this interval starts from. */
    predecessor: Sha256Hex;
    /** Steps since the original dispatch: after `start`, through `end`. */
    steps: Readonly<{ start: StepCount; end: StepCount }>;
    bundle: Sha256Hex;
    modelHash: Sha256Hex;
    events: readonly NativeEvent[];
    recording: RecordingRef;
    checkpoint: CheckpointRef;
  }>;

/** A quantity the controller measured at completion, for a measured output. */
export type Measurement = Readonly<{
  measurement: MeasurementId;
  quantity: MaterialQuantity;
}>;

/**
 * The end of an attempt. It references its segments and final checkpoint and
 * never repeats their trajectory. A completion carries the controller's
 * measurements; a fixture without measured outputs reports none.
 */
export type Terminal = AttemptAddress &
  Readonly<{
    kind: "terminal";
    sequence: number;
    steps: StepCount;
    segments: readonly number[];
  }> &
  (
    | Readonly<{
        outcome: "completed";
        checkpoint: CheckpointRef;
        measurements: readonly Measurement[];
        disposition?: never;
      }>
    | Readonly<{
        outcome: "failed";
        disposition: CarrierDisposition;
        checkpoint: CheckpointRef | null;
        measurements?: never;
      }>
  );

export type PhysicsOutput = Preview | Segment | Terminal;

/** Why the last recoverable state of an aborted attempt is what it is. */
export type RecoveryBoundary =
  | Readonly<{ kind: "checkpoint"; checkpoint: CheckpointRef }>
  | Readonly<{ kind: "none"; checkpoint?: never }>;

/** One attempt's execution, as the owning host knows it. */
export type AttemptLifecycle = StrictUnion<
  /** Bound to its starting state; the controller has not accepted a plan. */
  | Readonly<{ kind: "dispatched" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "pause-requested" }>
  | Readonly<{ kind: "paused"; checkpoint: CheckpointRef }>
  | Readonly<{ kind: "completed"; checkpoint: CheckpointRef; steps: StepCount }>
  | Readonly<{
      kind: "failed";
      steps: StepCount;
      disposition: CarrierDisposition;
      retained: RecoveryBoundary;
    }>
  | Readonly<{ kind: "aborted"; recoverable: RecoveryBoundary }>
>;

/**
 * A cell's preallocated carrier body. Reuse advances the generation, which
 * fences results still addressed to the previous carrier.
 */
export type CarrierSlot =
  | Readonly<{ kind: "inactive"; generation: number; carrier?: never }>
  | Readonly<{ kind: "active"; generation: number; carrier: CarrierId }>;

/**
 * How a cell passes time between operations. A settled hold is a qualified
 * mechanical state; anything else must advance or block dependent work.
 */
export type HoldState = StrictUnion<
  | Readonly<{
      kind: "settled";
      model: HoldModelId;
      enteredAt: LogicalTime;
      /** Where the hold's qualification ends and the cell must advance again. */
      until: LogicalTime;
    }>
  | Readonly<{ kind: "evolving" }>
  | Readonly<{ kind: "unresolved"; since: LogicalTime }>
>;

/**
 * Maps a cell's integration time to factory time. Held time is factory time
 * the solver did not integrate; it is counted here once and never as steps.
 */
export type CellClock = Readonly<{
  origin: LogicalTime;
  steps: StepCount;
  held: TickDuration;
}>;

/** A cell state the factory has committed at its accepted boundary. */
export type CommittedCell = Readonly<{
  checkpoint: CheckpointRef;
  boundary: LogicalTime;
  clock: CellClock;
}>;

/**
 * Progress computed beyond the accepted boundary. It stays separate until its
 * events commit, and is discarded if an earlier event changes its inputs.
 */
export type PendingProgress = Readonly<{
  attemptId: AttemptId;
  dispatchedAt: LogicalTime;
  predecessor: Sha256Hex;
  segments: readonly Segment[];
  checkpoint: CheckpointRef;
}>;

/** Whether an attempt began in this execution or continues a saved one. */
export type DispatchOrigin =
  | Readonly<{
      kind: "original";
      sourceExecution?: never;
      sourceAttempt?: never;
      resumeFrom?: never;
    }>
  | Readonly<{
      kind: "continuation";
      sourceExecution: ExecutionId;
      sourceAttempt: AttemptId;
      /** The saved checkpoint, whose own identity fields stay unaltered. */
      resumeFrom: CheckpointRef;
    }>;

/** One native operation bound to the exact state and resources it starts from. */
export type OperationDispatch = AttemptAddress &
  Readonly<{
    task: TaskId;
    definition: Sha256Hex;
    dispatchedAt: LogicalTime;
    startingCheckpoint: Sha256Hex;
    slot: CarrierSlot;
    operation: NativeOperation;
    origin: DispatchOrigin;
    purpose: StrictUnion<
      | Readonly<{ kind: "workflow" }>
      | Readonly<{
          kind: "recovery";
          carrier: CarrierId;
          handling: TickDuration;
        }>
    >;
  }>;

/** A world starts from its declared definition or from a compatible checkpoint. */
export type CellStart =
  | Readonly<{
      kind: "create";
      modelHash: Sha256Hex;
      checkpoint?: never;
      content?: never;
      operation?: never;
    }>
  | Readonly<{
      kind: "restore";
      checkpoint: CheckpointRef;
      /** The stored content the checkpoint's digest names. */
      content: string;
      /** The attempt the checkpoint was taken inside, and its next segment. */
      operation: Readonly<{ attempt: AttemptId; sequence: number }> | null;
      modelHash?: never;
    }>;

/** Whether the controller accepted the dispatch or its plan failed unstepped. */
export type StartOutcome =
  | Readonly<{ kind: "started"; terminal?: never }>
  | Readonly<{ kind: "refused"; terminal: Terminal }>;

/**
 * The settled hold a controller offers once a cell has rested undisturbed:
 * its model, what the carrier rests on, and how long the model is qualified
 * to stand for ordinary advancement.
 */
export type HoldOffer = Readonly<{
  model: HoldModelId;
  support: string;
  qualified: TickDuration;
}>;

/** An idle cell advanced under its held servo targets. */
export type RestResult = Readonly<{
  cellId: CellId;
  predecessor: Sha256Hex;
  checkpoint: CheckpointRef;
  recording: Variant<CellRecording, "idle">;
  /** Present when the cell may now hold instead of stepping. */
  settled: HoldOffer | null;
}>;

/**
 * The one thing physics must supply before logical time may pass. The engine
 * derives it from the run; a host performs it and returns the evidence.
 */
export type ExecutionNeed = StrictUnion<
  | Readonly<{ kind: "start"; dispatch: OperationDispatch }>
  | Readonly<{ kind: "advance"; attempt: AttemptAddress; steps: StepCount }>
  | Readonly<{
      kind: "rest";
      cellId: CellId;
      predecessor: Sha256Hex;
      steps: StepCount;
      /** Stop at the step where the cell's hold qualifies. */
      stopAtHold: boolean;
    }>
  | Readonly<{
      kind: "boundary";
      request: BoundaryRequest;
      /** The timestamp that waits for the candidate. */
      at: LogicalTime;
    }>
>;

export type BoundaryOperation =
  | Readonly<{ kind: "admission"; carrier: CarrierId; storage: StorageId }>
  | Readonly<{ kind: "removal"; carrier: CarrierId; storage: StorageId }>;

/** A carrier entering or leaving a cell, prepared against exact preconditions. */
export type BoundaryRequest = Readonly<{
  boundary: BoundaryId;
  runId: RunId;
  executionId: ExecutionId;
  cellId: CellId;
  predecessor: Sha256Hex;
  slot: CarrierSlot;
  operation: BoundaryOperation;
}>;

/**
 * The adapter's proposed result. Preparing it changes nothing: the engine
 * commits checkpoint, slot, custody and occupancy together at the boundary.
 */
export type BoundaryCandidate = Readonly<{
  boundary: BoundaryId;
  cellId: CellId;
  predecessor: Sha256Hex;
  checkpoint: CheckpointRef;
  slot: CarrierSlot;
  recording: Variant<CellRecording, "admission" | "removal">;
  digest: Sha256Hex;
}>;

export type SegmentRejection =
  | "stale_attempt"
  | "sequence_gap"
  | "conflicting_duplicate"
  | "predecessor_differs"
  | "steps_not_contiguous"
  | "bundle_differs"
  | "model_differs"
  | "exceeds_allowance"
  | "event_inside_segment";

export type SegmentAdmission =
  | Readonly<{ kind: "accepted"; reason?: never }>
  | Readonly<{ kind: "duplicate"; reason?: never }>
  | Readonly<{ kind: "rejected"; reason: SegmentRejection }>;

/** The accepted end of an attempt's history that the next segment must extend. */
export type SegmentCursor = AttemptAddress &
  Readonly<{
    nextSequence: number;
    checkpoint: Sha256Hex;
    /** The cell's own step count at that checkpoint. */
    checkpointStep: StepCount;
    step: StepCount;
    bundle: Sha256Hex;
    modelHash: Sha256Hex;
    /** Digests of accepted segments by sequence, to recognize duplicates. */
    accepted: readonly Sha256Hex[];
  }>;

/**
 * Decides whether a segment extends accepted history. An identical repeat is
 * idempotent; a gap, a stale attempt or a different starting state is refused.
 */
export function admitSegment(
  cursor: SegmentCursor,
  segment: Segment,
  digest: Sha256Hex,
): SegmentAdmission {
  if (
    segment.runId !== cursor.runId ||
    segment.executionId !== cursor.executionId ||
    segment.cellId !== cursor.cellId ||
    segment.attemptId !== cursor.attemptId
  )
    return { kind: "rejected", reason: "stale_attempt" };
  if (segment.sequence < cursor.nextSequence)
    return cursor.accepted[segment.sequence] === digest
      ? { kind: "duplicate" }
      : { kind: "rejected", reason: "conflicting_duplicate" };
  if (segment.sequence > cursor.nextSequence)
    return { kind: "rejected", reason: "sequence_gap" };
  if (segment.bundle !== cursor.bundle)
    return { kind: "rejected", reason: "bundle_differs" };
  if (segment.modelHash !== cursor.modelHash)
    return { kind: "rejected", reason: "model_differs" };
  if (segment.predecessor !== cursor.checkpoint)
    return { kind: "rejected", reason: "predecessor_differs" };
  if (
    segment.steps.start !== cursor.step ||
    segment.steps.end <= segment.steps.start ||
    segment.checkpoint.step !==
      cursor.checkpointStep + (segment.steps.end - segment.steps.start)
  )
    return { kind: "rejected", reason: "steps_not_contiguous" };
  return { kind: "accepted" };
}

export type SlotError = Readonly<{
  code: "slot_occupied" | "slot_empty" | "carrier_differs";
  slot: CarrierSlot;
}>;

/** Admission needs an inactive slot and yields a new binding generation. */
export function activateSlot(
  slot: CarrierSlot,
  carrier: CarrierId,
): Result<CarrierSlot, SlotError> {
  return slot.kind === "inactive"
    ? ok({ kind: "active", generation: slot.generation + 1, carrier })
    : err({ code: "slot_occupied", slot });
}

/** Removal parks the slot. Its generation changes at the next admission. */
export function deactivateSlot(
  slot: CarrierSlot,
  carrier: CarrierId,
): Result<CarrierSlot, SlotError> {
  if (slot.kind === "inactive") return err({ code: "slot_empty", slot });
  if (slot.carrier !== carrier) return err({ code: "carrier_differs", slot });
  return ok({ kind: "inactive", generation: slot.generation });
}
