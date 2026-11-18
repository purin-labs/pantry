import type { ExecutionAdapter, ExecutionFailure } from "./adapters.ts";
import {
  acceptRest,
  acceptSegment,
  acceptStart,
  acceptTerminal,
  committedBoundary,
  supplyBoundary,
  type EvidenceRejection,
} from "./engine-physics.ts";
import { advanceRun } from "./engine.ts";
import {
  storeIdleRecording,
  storeHandoffRecording,
  type StoredCellRecording,
} from "./cell-recording.ts";
import type { ExecutionNeed, Segment } from "./physics.ts";
import { err, ok, type Result } from "./result.ts";
import type { RunState } from "./state.ts";
import type { LogicalTime } from "./time.ts";

/**
 * The loop every host runs: advance the engine, perform the one thing it
 * needs from physics, hand the evidence back. A browser worker and a
 * headless process differ only in the adapter and in what they do between
 * turns; neither changes a production state transition.
 */

export type HostFailure =
  | Readonly<{
      kind: "execution";
      need: ExecutionNeed["kind"];
      failure: ExecutionFailure;
    }>
  | Readonly<{
      kind: "rejected";
      need: ExecutionNeed["kind"];
      reason: EvidenceRejection;
    }>;

export type HostObserver = Readonly<{
  /** An accepted segment and the recording it references, to be stored. */
  segment(segment: Segment, recording: string): Promise<void>;
  /** Idle or handoff observations, after their evidence is accepted. */
  cellRecording(recording: StoredCellRecording): Promise<void>;
  /**
   * Called once for each new need, before it is performed. Returning true
   * hands the run back to the caller, which may command, save or stop it.
   */
  yield(run: RunState): boolean;
}>;

export type HostStop = Readonly<{
  run: RunState;
  /** Whether the observer took the run back before it stopped by itself. */
  yielded: boolean;
}>;

function rejected(
  need: ExecutionNeed["kind"],
  reason: EvidenceRejection,
): Result<never, HostFailure> {
  return err({ kind: "rejected", need, reason });
}

function failed(
  need: ExecutionNeed["kind"],
  failure: ExecutionFailure,
): Result<never, HostFailure> {
  return err({ kind: "execution", need, failure });
}

/** Performs one need and returns the run with its evidence accepted. */
async function perform(
  run: RunState,
  need: ExecutionNeed,
  adapter: ExecutionAdapter,
  observer: HostObserver,
): Promise<Result<RunState, HostFailure>> {
  const bundle = run.identity.bundle;
  if (bundle === null)
    return failed(need.kind, {
      code: "unsupported_bundle",
      detail: "Physics requires an execution bundle",
    });
  const recordingExecution = {
    runId: run.identity.runId,
    executionId: run.identity.executionId,
    bundle,
  };
  switch (need.kind) {
    case "start": {
      const started = await adapter.start(need.dispatch);
      if (!started.ok) return failed(need.kind, started.error);
      const accepted = acceptStart(run, need.dispatch, started.value);
      return accepted.ok ? accepted : rejected(need.kind, accepted.error);
    }
    case "advance": {
      const advanced = await adapter.advance(need.attempt, need.steps);
      if (!advanced.ok) return failed(need.kind, advanced.error);
      const { segment, digest, recording } = advanced.value;
      const accepted = acceptSegment(run, segment, digest);
      if (!accepted.ok) return rejected(need.kind, accepted.error);
      await observer.segment(segment, recording);
      if (advanced.value.terminal === undefined) return accepted;
      const ended = acceptTerminal(accepted.value, advanced.value.terminal);
      return ended.ok ? ended : rejected(need.kind, ended.error);
    }
    case "rest": {
      const rested = await adapter.rest(
        need.cellId,
        need.predecessor,
        need.steps,
        need.stopAtHold,
      );
      if (!rested.ok) return failed(need.kind, rested.error);
      const accepted = acceptRest(run, rested.value);
      if (!accepted.ok) return rejected(need.kind, accepted.error);
      for (const cell of run.cells) {
        if (cell.id !== need.cellId) continue;
        await observer.cellRecording(
          await storeIdleRecording(
            recordingExecution,
            rested.value.recording,
            cell.committed.boundary,
          ),
        );
      }
      return accepted;
    }
    case "boundary": {
      const prepared = await adapter.prepareBoundary(need.request);
      if (!prepared.ok) return failed(need.kind, prepared.error);
      const candidate = prepared.value;
      // All cells prepare before the timestamp commits. Only then do the
      // adapters install their candidates. A failed prepare changes no world.
      const supplied = supplyBoundary(run, candidate);
      if (!supplied.ok) {
        await adapter.discardBoundary(candidate);
        return rejected(need.kind, supplied.error);
      }
      const candidates = [candidate];
      for (const cell of run.cells) candidates.push(...cell.prepared);
      for (const prepared of candidates) {
        if (
          committedBoundary(supplied.value, prepared.boundary) !==
          prepared.checkpoint.digest
        )
          continue;
        const settled = await adapter.commitBoundary(prepared);
        if (!settled.ok) return failed(need.kind, settled.error);
        if (settled.value.digest !== prepared.checkpoint.digest)
          return rejected(need.kind, "checkpoint_differs");
        await observer.cellRecording(
          await storeHandoffRecording(
            recordingExecution,
            prepared.recording,
            need.at,
            prepared.boundary,
          ),
        );
      }
      return supplied;
    }
    default:
      return need satisfies never;
  }
}

/**
 * Drives a run until it stops needing this host: it completes, blocks,
 * pauses, reaches `until` or a limit, or the observer takes it back.
 */
export async function driveRun(
  run: RunState,
  adapter: ExecutionAdapter,
  until: LogicalTime,
  observer: HostObserver,
): Promise<Result<HostStop, HostFailure>> {
  let current = run;
  // A run handed in while it waits was offered when it was handed back.
  let offered: RunState | null = run;
  for (;;) {
    current = advanceRun(current, until);
    if (current.status.kind !== "awaiting-execution")
      return ok({ run: current, yielded: false });
    if (current !== offered) {
      offered = current;
      if (observer.yield(current)) return ok({ run: current, yielded: true });
    }
    const performed = await perform(
      current,
      current.status.need,
      adapter,
      observer,
    );
    if (!performed.ok) return performed;
    current = performed.value;
  }
}
