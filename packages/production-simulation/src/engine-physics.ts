import { sameJson } from "@purin-labs/std";
import { sameSlot, slotAfter } from "./engine-carriers.ts";
import { freeze, held, thaw, type Draft } from "./engine-draft.ts";
import { advanceRun, completionFits } from "./engine.ts";
import type { BoundaryId, Sha256Hex } from "./identity.ts";
import {
  admitSegment,
  type AttemptAddress,
  type BoundaryCandidate,
  type RestResult,
  type Segment,
  type SegmentRejection,
  type StartOutcome,
  type Terminal,
} from "./physics.ts";
import { err, ok, type Result } from "./result.ts";
import type { CellState, ExecutionIdentity, RunState } from "./state.ts";
import {
  addSteps,
  advance as later,
  nativeEventTime,
  stepsDuration,
  type LogicalTime,
  type StepCount,
} from "./time.ts";

/**
 * Where evidence from physics enters the run. Each function checks the
 * evidence against the exact state the run is waiting in, changes nothing
 * when it does not match, and otherwise advances logical time through what
 * the evidence covers.
 */

export type EvidenceRejection =
  | SegmentRejection
  /** The run is not waiting for this evidence. */
  | "not_awaited"
  | "steps_differ"
  | "checkpoint_differs"
  | "slot_differs"
  | "conflicting_boundary"
  /** The waiting timestamp did not commit the candidate. */
  | "boundary_not_committed"
  /** A completion's measurements do not fit or balance its task. */
  | "measurement_invalid";

type Attempt = NonNullable<CellState["attempt"]>;

function sameAddress(
  identity: ExecutionIdentity,
  cell: CellState,
  attempt: Attempt,
  address: AttemptAddress,
): boolean {
  return (
    address.runId === identity.runId &&
    address.executionId === identity.executionId &&
    address.cellId === cell.id &&
    address.attemptId === attempt.id
  );
}

function cellOf(run: RunState, address: AttemptAddress): CellState | null {
  for (const cell of run.cells) if (cell.id === address.cellId) return cell;
  return null;
}

/** Applies accepted evidence, then processes what it now covers. */
function resume(
  draft: Draft,
  cell: CellState,
  until: LogicalTime = cell.committed.boundary,
): RunState {
  draft.cells.set(cell.id, cell);
  draft.status = { kind: "advancing" };
  return advanceRun(freeze(draft), until);
}

/**
 * The controller's answer to a dispatch. An accepted plan starts the attempt;
 * a plan that failed before any step ends it where it was dispatched.
 */
export function acceptStart(
  run: RunState,
  address: AttemptAddress,
  outcome: StartOutcome,
): Result<RunState, EvidenceRejection> {
  const cell = cellOf(run, address);
  if (
    run.status.kind !== "awaiting-execution" ||
    run.status.need.kind !== "start" ||
    cell === null ||
    cell.attempt === null ||
    !sameAddress(run.identity, cell, cell.attempt, address)
  )
    return err("not_awaited");
  const started: CellState = {
    ...cell,
    attempt: { ...cell.attempt, lifecycle: { kind: "running" } },
  };
  if (outcome.kind === "started") return ok(resume(thaw(run), started));
  const draft = thaw(run);
  draft.cells.set(cell.id, started);
  draft.status = { kind: "advancing" };
  return acceptTerminal(freeze(draft), outcome.terminal);
}

/**
 * Admits one segment of an executing attempt. The cell's committed state
 * moves to the segment's end, and a pickup it evidences is scheduled at its
 * own logical time. An identical repeat changes nothing.
 */
export function acceptSegment(
  run: RunState,
  segment: Segment,
  digest: Sha256Hex,
): Result<RunState, EvidenceRejection> {
  const cell = cellOf(run, segment);
  const bundle = run.identity.bundle;
  if (cell === null || cell.attempt === null || bundle === null)
    return err("stale_attempt");
  const attempt = cell.attempt;
  let modelHash: Sha256Hex | null = null;
  for (const definition of run.definition.scenario.cells)
    if (definition.id === cell.id) modelHash = definition.modelHash;
  if (modelHash === null) return err("stale_attempt");
  const admission = admitSegment(
    {
      runId: run.identity.runId,
      executionId: run.identity.executionId,
      cellId: cell.id,
      attemptId: attempt.id,
      nextSequence: attempt.segments.length,
      checkpoint: cell.committed.checkpoint.digest,
      checkpointStep: cell.committed.checkpoint.step,
      step: attempt.steps,
      bundle,
      modelHash,
      accepted: attempt.segments,
    },
    segment,
    digest,
  );
  if (admission.kind === "duplicate") return ok(run);
  if (admission.kind === "rejected") return err(admission.reason);
  if (
    run.status.kind !== "awaiting-execution" ||
    run.status.need.kind !== "advance" ||
    attempt.lifecycle.kind !== "running"
  )
    return err("not_awaited");
  const steps = (segment.steps.end - segment.steps.start) as StepCount;
  if (steps > run.status.need.steps) return err("exceeds_allowance");
  // An event lies on its segment's last step, where the cell has real state.
  for (const event of segment.events)
    if (event.step !== segment.steps.end) return err("event_inside_segment");

  const draft = thaw(run);
  const boundary = nativeEventTime(attempt.dispatchedAt, segment.steps.end);
  for (const event of segment.events)
    // A placement or failure ends the attempt and settles with its terminal.
    if (event.kind === "pickup" || event.kind === "carrier-removed")
      draft.scheduled.push({
        kind: "native-event",
        task: attempt.task,
        event,
        order: {
          time: boundary,
          phase: "settle",
          origin: "native",
          cell: cell.id,
          attempt: attempt.id,
          step: event.step,
          controllerSequence: event.controllerSequence,
        },
      });
  return ok(
    resume(draft, {
      ...cell,
      committed: {
        checkpoint: segment.checkpoint,
        boundary,
        clock: {
          ...cell.committed.clock,
          steps: addSteps(cell.committed.clock.steps, steps),
        },
      },
      attempt: {
        ...attempt,
        steps: segment.steps.end,
        segments: [...attempt.segments, digest],
      },
    }),
  );
}

/**
 * Admits the end of an attempt whose every segment is accepted. Its
 * completion or failure is scheduled at the attempt's own logical time and
 * applied there, never when the result happened to arrive.
 */
export function acceptTerminal(
  run: RunState,
  terminal: Terminal,
): Result<RunState, EvidenceRejection> {
  const cell = cellOf(run, terminal);
  if (
    cell === null ||
    cell.attempt === null ||
    !sameAddress(run.identity, cell, cell.attempt, terminal)
  )
    return err("stale_attempt");
  const attempt = cell.attempt;
  if (
    attempt.lifecycle.kind === "completed" ||
    attempt.lifecycle.kind === "failed"
  ) {
    for (const scheduled of run.scheduled)
      if (
        scheduled.kind === "native-terminal" &&
        scheduled.task === attempt.task
      )
        return sameJson(scheduled.terminal, terminal)
          ? ok(run)
          : err("conflicting_duplicate");
    return err("stale_attempt");
  }
  if (attempt.lifecycle.kind !== "running") return err("not_awaited");
  if (terminal.steps !== attempt.steps) return err("steps_differ");
  if (
    terminal.checkpoint !== null &&
    terminal.checkpoint.digest !== cell.committed.checkpoint.digest
  )
    return err("checkpoint_differs");

  const draft = thaw(run);
  if (
    terminal.outcome === "completed" &&
    !completionFits(draft, attempt.task, terminal.measurements)
  )
    return err("measurement_invalid");
  const time = nativeEventTime(attempt.dispatchedAt, terminal.steps);
  draft.scheduled.push({
    kind: "native-terminal",
    task: attempt.task,
    terminal,
    order: {
      time,
      phase: "settle",
      origin: "native",
      cell: cell.id,
      attempt: attempt.id,
      step: terminal.steps,
      // After every event the controller emitted at this step.
      controllerSequence: Number.MAX_SAFE_INTEGER,
    },
  });
  return ok(
    resume(draft, {
      ...cell,
      attempt: {
        ...attempt,
        lifecycle:
          terminal.outcome === "completed"
            ? {
                kind: "completed",
                checkpoint: terminal.checkpoint,
                steps: terminal.steps,
              }
            : {
                kind: "failed",
                steps: terminal.steps,
                disposition: terminal.disposition,
                retained:
                  terminal.checkpoint === null
                    ? { kind: "none" }
                    : { kind: "checkpoint", checkpoint: terminal.checkpoint },
              },
      },
    }),
  );
}

/** Admits an idle cell's advance to the time the run asked it to reach. */
export function acceptRest(
  run: RunState,
  rest: RestResult,
): Result<RunState, EvidenceRejection> {
  if (
    run.status.kind !== "awaiting-execution" ||
    run.status.need.kind !== "rest" ||
    run.status.need.cellId !== rest.cellId
  )
    return err("not_awaited");
  const need = run.status.need;
  const draft = thaw(run);
  const cell = held(draft.cells, rest.cellId, "cell");
  if (
    rest.predecessor !== need.predecessor ||
    rest.predecessor !== cell.committed.checkpoint.digest
  )
    return err("predecessor_differs");
  const steps = (rest.checkpoint.step -
    cell.committed.checkpoint.step) as StepCount;
  if (steps < 1) return err("steps_not_contiguous");
  if (steps > need.steps) return err("exceeds_allowance");
  if (
    rest.recording.cellId !== cell.id ||
    rest.recording.predecessor !== rest.predecessor ||
    rest.recording.checkpoint !== rest.checkpoint.digest
  )
    return err("checkpoint_differs");
  if (
    rest.recording.steps.start !== cell.committed.checkpoint.step ||
    rest.recording.steps.end !== rest.checkpoint.step
  )
    return err("steps_differ");
  const boundary = later(cell.committed.boundary, stepsDuration(steps));
  const rested: CellState = {
    ...cell,
    committed: {
      checkpoint: rest.checkpoint,
      boundary,
      clock: {
        ...cell.committed.clock,
        steps: addSteps(cell.committed.clock.steps, steps),
      },
    },
  };
  // The cell holds only under the model its scenario declares for it.
  const offer = rest.settled;
  if (
    cell.hold.kind === "unresolved" ||
    offer === null ||
    held(draft.index.cells, cell.id, "cell definition").holdModel !==
      offer.model
  )
    return ok(resume(draft, rested));
  const until = later(boundary, offer.qualified);
  // Hold entry is accepted at the common boundary, after every evolving
  // cell has supplied its state. A faster cell cannot advance factory time.
  draft.scheduled.push({
    kind: "hold-entry",
    cell: cell.id,
    order: { time: boundary, phase: "control", origin: "hold", cell: cell.id },
  });
  draft.scheduled.push({
    kind: "hold-expiry",
    cell: cell.id,
    order: { time: until, phase: "control", origin: "hold", cell: cell.id },
  });
  return ok(
    resume(draft, {
      ...rested,
      hold: { kind: "settled", model: offer.model, enteredAt: boundary, until },
    }),
  );
}

/** The checkpoint a boundary change committed, or null if it has not. */
export function committedBoundary(
  run: RunState,
  boundary: BoundaryId,
): Sha256Hex | null {
  for (const event of run.events)
    if (event.kind === "cell-committed" && event.boundary === boundary)
      return event.checkpoint;
  return null;
}

/**
 * Supplies the candidate a boundary change waits for. The engine keeps it
 * beside the cell's state and commits it with the custody change when the
 * waiting timestamp is processed. An identical repeat changes nothing, and
 * the same boundary with other contents is refused.
 */
export function supplyBoundary(
  run: RunState,
  candidate: BoundaryCandidate,
): Result<RunState, EvidenceRejection> {
  const committed = committedBoundary(run, candidate.boundary);
  if (committed !== null)
    return committed === candidate.checkpoint.digest
      ? ok(run)
      : err("conflicting_boundary");
  if (
    run.status.kind !== "awaiting-execution" ||
    run.status.need.kind !== "boundary" ||
    run.status.need.request.boundary !== candidate.boundary ||
    run.status.need.request.cellId !== candidate.cellId
  )
    return err("not_awaited");
  const request = run.status.need.request;
  const draft = thaw(run);
  const cell = held(draft.cells, candidate.cellId, "cell");
  if (
    candidate.predecessor !== request.predecessor ||
    candidate.predecessor !== cell.committed.checkpoint.digest
  )
    return err("predecessor_differs");
  const slot = slotAfter(cell.slot, request.operation);
  if (slot === null || !sameSlot(slot, candidate.slot))
    return err("slot_differs");
  // A boundary change moves one body; it takes no integration step.
  if (candidate.checkpoint.step !== cell.committed.checkpoint.step)
    return err("steps_differ");
  if (
    candidate.recording.kind !== request.operation.kind ||
    candidate.recording.cellId !== cell.id ||
    candidate.recording.predecessor !== candidate.predecessor ||
    candidate.recording.checkpoint !== candidate.checkpoint.digest
  )
    return err("checkpoint_differs");
  if (candidate.recording.step !== candidate.checkpoint.step)
    return err("steps_differ");
  // Another cell may also need a candidate at this timestamp. Keep this
  // preparation until the whole timestamp can commit atomically.
  const advanced = resume(
    draft,
    { ...cell, prepared: [candidate] },
    run.status.need.at,
  );
  if (
    committedBoundary(advanced, candidate.boundary) ===
    candidate.checkpoint.digest
  )
    return ok(advanced);
  if (
    advanced.status.kind === "awaiting-execution" &&
    advanced.status.need.kind === "boundary" &&
    advanced.status.need.at === run.status.need.at &&
    advanced.status.need.request.cellId !== candidate.cellId
  )
    return ok(advanced);
  return err("boundary_not_committed");
}

export type ContinuationError =
  "run_differs" | "execution_not_new" | "parent_differs" | "bundle_differs";

/**
 * Continues a saved run under a new execution identity. Carriers, history,
 * logical time and pending events are preserved; everything from here on
 * belongs to the new execution. An attempt in progress keeps its identity
 * and is dispatched again as a continuation of the saved one.
 */
export function continueRun(
  saved: RunState,
  identity: ExecutionIdentity,
): Result<RunState, ContinuationError> {
  if (identity.runId !== saved.identity.runId) return err("run_differs");
  if (identity.executionId === saved.identity.executionId)
    return err("execution_not_new");
  if (
    identity.parent === null ||
    identity.parent.execution !== saved.identity.executionId
  )
    return err("parent_differs");
  if (identity.bundle !== saved.identity.bundle) return err("bundle_differs");
  const cells: CellState[] = [];
  for (const cell of saved.cells) {
    const attempt = cell.attempt;
    cells.push({
      ...cell,
      // A candidate belongs to the host that prepared it.
      prepared: [],
      attempt:
        attempt === null || attempt.lifecycle.kind !== "running"
          ? attempt
          : {
              ...attempt,
              lifecycle: { kind: "dispatched" },
              origin: {
                kind: "continuation",
                sourceExecution: saved.identity.executionId,
                sourceAttempt: attempt.id,
                resumeFrom: cell.committed.checkpoint,
              },
            },
    });
  }
  const status = saved.status.kind;
  return ok({
    ...saved,
    identity,
    cells,
    status:
      status === "paused" ||
      status === "pause-requested" ||
      status === "awaiting-execution"
        ? { kind: "advancing" }
        : saved.status,
  });
}
