import type { RecordingReplayView } from "./playback-state";
import type { WorkcellSelection } from "./selection";
import {
  attemptRecording,
  workcellEnd,
  workcellTasks,
  type WorkcellTask,
  type ActiveAttempt,
} from "../recipes/bakery/workcell-attempt.ts";
import { assertNever } from "@seams/std";

export type WorkcellCursor =
  | Readonly<{ kind: "awaiting"; time: number; end?: never }>
  | Readonly<{ kind: "attached" | "detached"; time: number; end: number }>;

export type ActiveWorkcellView = Readonly<{
  kind: "active";
  attempt: ActiveAttempt;
  selection: WorkcellSelection;
  cursor: WorkcellCursor;
  tasks: readonly [WorkcellTask, ...WorkcellTask[]];
}>;
export type WorkcellView = Readonly<{ kind: "empty" }> | ActiveWorkcellView;

// One native task's attempt at a replay position, for the robot cell's
// spatial guide and bakery context.
export function workcellView(
  attempt: ActiveAttempt,
  selection: WorkcellSelection,
  replay: RecordingReplayView,
): ActiveWorkcellView {
  const cursor = workcellCursor(attempt, replay);
  return {
    kind: "active",
    attempt,
    selection,
    cursor,
    tasks: workcellTasks(attempt, cursor.time),
  };
}

function workcellCursor(
  attempt: ActiveAttempt,
  replay: RecordingReplayView,
): WorkcellCursor {
  if (
    replay.open &&
    replay.document.kind === "ready" &&
    replay.document.source.kind === "workcell" &&
    replay.document.source.input === attempt.input &&
    replay.document.recording === attemptRecording(attempt)
  ) {
    return {
      kind: "attached",
      time: replay.document.replay.time,
      end: attemptEnd(attempt),
    };
  }
  if (attempt.kind === "awaiting-evidence")
    return { kind: "awaiting", time: attempt.input.dispatch.time };
  return {
    kind: "detached",
    time: attemptEnd(attempt),
    end: attemptEnd(attempt),
  };
}

function attemptEnd(attempt: ActiveAttempt): number {
  return workcellEnd(attempt.input, attemptRecording(attempt));
}

export function workcellStatusLabel(
  kind: ActiveAttempt["kind"] | "empty" | "queued" | "running" | "blocked",
): string {
  switch (kind) {
    case "empty":
      return "No attempt";
    case "awaiting-evidence":
      return "Awaiting evidence";
    case "awaiting-return":
      return "Awaiting unloading";
    case "queued":
      return "Queued";
    case "blocked":
      return "Blocked";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "recovery-required":
      return "Recovery required";
    default:
      return assertNever(kind, "Unexpected workcell state");
  }
}
