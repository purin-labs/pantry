import type { CellId, DigestError, IdError } from "./identity.ts";
import type { QuantityError } from "./quantity.ts";
import type { IntervalError, TimeError } from "./time.ts";
import type {
  AttemptAddress,
  BoundaryCandidate,
  BoundaryRequest,
  CellStart,
  CheckpointRef,
  ExecutionBundle,
  OperationDispatch,
  RestResult,
  Segment,
  StartOutcome,
  Terminal,
} from "./physics.ts";
import type { Result } from "./result.ts";
import type { CompiledScenario } from "./scenario.ts";
import type { StepCount } from "./time.ts";
import type { Sha256Hex } from "./identity.ts";

/**
 * The two boundaries the engine depends on. Adapters depend on the engine;
 * the engine imports neither a recipe nor a native runtime.
 */

/**
 * Compiles one authorized, immutable definition snapshot into the normalized
 * scenario. An adapter holds no stock count, reservation or schedule of its
 * own: after compilation the engine owns every balance and claim.
 */
export type RecipeAdapter<Snapshot, Problem> = Readonly<{
  compile(snapshot: Snapshot): Result<CompiledScenario, readonly Problem[]>;
}>;

/** A snapshot value that cannot enter the factory, with where it was written. */
export type ValueProblem = Readonly<{
  where: string;
  error: TimeError | IntervalError | QuantityError | IdError | DigestError;
}>;

export type ExecutionFailure = Readonly<{
  code:
    | "unsupported_bundle"
    | "invalid_checkpoint"
    | "incompatible_start"
    | "unknown_cell"
    | "unresponsive"
    | "boundary_rejected";
  /** The adapter's own explanation, for inspection only. */
  detail: string;
}>;

/** Why a bounded advance returned. */
export type AdvanceStop = "allowance" | "event" | "failure" | "completed";

export type AdvanceResult = Readonly<{
  stop: AdvanceStop;
  segment: Segment;
  /** The segment's own content digest, which recognizes a repeat of it. */
  digest: Sha256Hex;
  /** The recording the segment references, for the host to store. */
  recording: string;
}> &
  (
    | Readonly<{ stop: "allowance" | "event"; terminal?: never }>
    | Readonly<{ stop: "failure" | "completed"; terminal: Terminal }>
  );

/**
 * The shared Rust/MuJoCo controller as the engine sees it. The browser worker
 * and the headless host each implement this over the same controller library.
 * Every method validates native state itself; the engine validates addressing.
 */
export type ExecutionAdapter = Readonly<{
  bundle: ExecutionBundle;
  /** Creates a cell's world, or restores it from a compatible checkpoint. */
  open(
    cell: CellId,
    start: CellStart,
  ): Promise<Result<CheckpointRef, ExecutionFailure>>;
  /**
   * Binds a controller to the cell's current state and exact dispatch. A
   * continuation dispatch resumes the attempt its checkpoint was taken in.
   */
  start(
    dispatch: OperationDispatch,
  ): Promise<Result<StartOutcome, ExecutionFailure>>;
  /**
   * Executes at most `steps` integration steps and returns earlier on a
   * semantic event, failure or completion. Yielding never restarts planning.
   */
  advance(
    attempt: AttemptAddress,
    steps: StepCount,
  ): Promise<Result<AdvanceResult, ExecutionFailure>>;
  /**
   * Advances an idle cell under its held servo targets by `steps`, or with
   * `stopAtHold` to the step where its hold qualifies if that comes first.
   */
  rest(
    cell: CellId,
    predecessor: Sha256Hex,
    steps: StepCount,
    stopAtHold: boolean,
  ): Promise<Result<RestResult, ExecutionFailure>>;
  /** Prepares a carrier admission or removal without changing cell state. */
  prepareBoundary(
    request: BoundaryRequest,
  ): Promise<Result<BoundaryCandidate, ExecutionFailure>>;
  /** Makes a prepared candidate the cell's state, exactly once. */
  commitBoundary(
    candidate: BoundaryCandidate,
  ): Promise<Result<CheckpointRef, ExecutionFailure>>;
  /** Abandons a prepared candidate; the cell keeps its predecessor state. */
  discardBoundary(
    candidate: BoundaryCandidate,
  ): Promise<Result<CheckpointRef, ExecutionFailure>>;
  /** The stored content of the cell's current checkpoint, for a save. */
  exportCheckpoint(
    cell: CellId,
  ): Promise<
    Result<
      Readonly<{ checkpoint: CheckpointRef; content: string }>,
      ExecutionFailure
    >
  >;
  /** Releases the cell's runtime. Its saved checkpoints are unaffected. */
  dispose(cell: CellId): Promise<void>;
}>;
