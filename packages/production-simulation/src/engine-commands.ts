import { assertNever, sameJson } from "@seams/std";
import type {
  CommandReceipt,
  CommandRejection,
  ControlCommand,
} from "./commands.ts";
import { emit, freeze, thaw } from "./engine-draft.ts";
import { beginRecovery, recoveryRefusal } from "./engine-recovery.ts";
import { validWorkerTravelReplacement } from "./engine-workers.ts";
import { inspectionRefusal } from "./inspections.ts";
import type { RunState } from "./state.ts";
import {
  TICK_MICROSECONDS,
  ZERO_TIME,
  advance as later,
  tickDuration,
  type LogicalTime,
} from "./time.ts";

export type CommandResult = Readonly<{
  run: RunState;
  receipt: CommandReceipt;
}>;

function rejected(
  run: RunState,
  command: ControlCommand,
  reason: CommandRejection,
): CommandResult {
  return {
    run,
    receipt: {
      commandId: command.commandId,
      runId: command.runId,
      executionId: command.executionId,
      status: "rejected",
      reason,
    },
  };
}

// The first tick whose control phase has not run and that no cell has
// computed. A run that has not started has not processed time zero; any
// other run has processed its current time. A cell can compute ahead of the
// factory time, and a command that reaches a cell must find it at the
// command's own time.
function nextUncommittedTick(run: RunState): LogicalTime {
  if (run.status.kind === "ready") return ZERO_TIME;
  const tick = tickDuration(TICK_MICROSECONDS);
  if (!tick.ok) throw new Error("The factory tick is off its own grid");
  let committed = run.position.time;
  for (const cell of run.cells)
    if (cell.committed.boundary > committed)
      committed = cell.committed.boundary;
  return later(committed, tick.value);
}

function refusal(
  run: RunState,
  command: ControlCommand,
  effectiveAt: LogicalTime,
): CommandRejection | null {
  const status = run.status.kind;
  if (
    status === "completed" ||
    (status === "blocked" &&
      command.kind !== "recover" &&
      command.kind !== "inspect")
  )
    return "run_finished";
  switch (command.kind) {
    case "inspect":
      return status === "paused" || status === "stopped-at-limit"
        ? "not_advancing"
        : inspectionRefusal(run, command);
    case "recover":
      if (status === "paused" || status === "stopped-at-limit")
        return "not_advancing";
      return recoveryRefusal(run, command);
    case "pause":
      if (status === "paused" || status === "pause-requested")
        return "already_paused";
      if (status !== "advancing" && status !== "awaiting-execution")
        return "not_advancing";
      // A pause settles only where every cell has real state at one time.
      // A held or unresolved cell keeps one state however far time has passed.
      for (const cell of run.cells)
        if (
          cell.prepared.length > 0 ||
          cell.committed.boundary > run.position.time ||
          (cell.hold.kind !== "settled" &&
            cell.committed.boundary !== run.position.time)
        )
          return "boundary_unsettled";
      return null;
    case "resume":
      return status === "paused" ? null : "not_paused";
    case "extend-horizon":
      return command.horizon > run.position.horizon
        ? null
        : "horizon_not_extended";
    case "withhold-resource":
      if (status === "stopped-at-limit") return "not_advancing";
      for (const resource of run.resources)
        if (resource.id === command.resource)
          return command.interval.start < effectiveAt
            ? "inside_accepted_history"
            : null;
      return "unknown_target";
    case "update-worker-travel": {
      if (status === "stopped-at-limit") return "not_advancing";
      for (const definition of run.definition.scenario.resources) {
        if (definition.id !== command.resource) continue;
        if (definition.kind !== "worker") return "unknown_target";
        return validWorkerTravelReplacement(definition, command.travel)
          ? null
          : "invalid_worker_travel";
      }
      return "unknown_target";
    }
    case "close-arrivals":
      if (status === "stopped-at-limit") return "not_advancing";
      for (const source of run.arrivals)
        if (source.id === command.source) return null;
      return "unknown_target";
    default:
      return assertNever(command, "Unexpected command");
  }
}

/**
 * Decides one command and returns its receipt at once. Admission records the
 * tick the command takes effect at; it never completes work or frees a
 * resource. Delivering an admitted command again returns its first receipt,
 * and the same identity with another payload is refused.
 */
export function submitCommand(
  run: RunState,
  command: ControlCommand,
): CommandResult {
  for (const earlier of run.commands)
    if (earlier.command.commandId === command.commandId)
      return sameJson(earlier.command, command)
        ? { run, receipt: earlier.receipt }
        : rejected(run, command, "conflicting_payload");
  if (command.runId !== run.identity.runId)
    return rejected(run, command, "wrong_run");
  if (command.executionId !== run.identity.executionId)
    return rejected(run, command, "wrong_execution");
  if (command.hostSession !== run.identity.hostSession)
    return rejected(run, command, "wrong_host_session");
  if (command.expectedControlRevision !== run.position.controlRevision)
    return rejected(run, command, "stale_control_revision");
  const immediate =
    command.kind === "pause" ||
    command.kind === "resume" ||
    command.kind === "recover";
  // Inspection dispatch needs a scheduled control event, including when no
  // other work remains. It releases material at the current held boundary.
  const effectiveAt =
    immediate || command.kind === "inspect"
      ? run.position.time
      : nextUncommittedTick(run);
  const reason = refusal(run, command, effectiveAt);
  if (reason !== null) return rejected(run, command, reason);

  const draft = thaw(run);
  draft.controlRevision += 1;
  const receipt: CommandReceipt = {
    commandId: command.commandId,
    runId: command.runId,
    executionId: command.executionId,
    status: "accepted",
    controlRevision: draft.controlRevision,
    eventSequence: draft.events.length,
    effectiveAt,
  };
  draft.commands.push({ command, receipt });
  switch (command.kind) {
    case "inspect":
      draft.status = { kind: "advancing" };
      break;
    case "recover":
      beginRecovery(draft, command);
      break;
    // A pause settles at the current boundary, where each cell's committed
    // checkpoint is its real state. An attempt in progress stays bound.
    case "pause":
      draft.status = {
        kind: "paused",
        command: command.commandId,
        boundary: draft.time,
      };
      break;
    case "resume":
      draft.status = { kind: "advancing" };
      break;
    case "extend-horizon":
      draft.horizon = command.horizon;
      if (
        draft.status.kind === "stopped-at-limit" &&
        draft.status.limit === "horizon"
      )
        draft.status = { kind: "advancing" };
      break;
    case "withhold-resource":
    case "update-worker-travel":
    case "close-arrivals":
      break;
    default:
      assertNever(command, "Unexpected command");
  }
  if (immediate)
    emit(draft, effectiveAt, {
      kind: "command-admitted",
      command: command.commandId,
      controlRevision: draft.controlRevision,
    });
  // Every other command applies in the control phase of its effective tick.
  else
    draft.scheduled.push({
      kind: "command",
      command: command.commandId,
      order: {
        time: effectiveAt,
        phase: "control",
        origin: "command",
        admission: draft.controlRevision,
      },
    });
  return { run: freeze(draft), receipt };
}
