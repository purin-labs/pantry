import { armAlarmBy } from "../lifecycle/actor-alarm";
import {
  createCancellableTask,
  type CancellableTask,
  type TaskCancellationReason,
} from "@purin-labs/async-control/cancellable-task";
import {
  runTaskBeforeDeadline,
  type DeadlineOutcome,
} from "@purin-labs/async-control/deadline";
import type { Result } from "../../result";
import { SessionExecutionAdmission } from "../session-execution-admission";
import { commitPreparedSessionCheckpoint } from "../actor-journal/transactions";
import type { CheckpointingStartedSessionCommit } from "../actor-journal";
import type { PreparedHarnessCheckpoint } from "../agent-session-harness-checkpoint";
import type {
  EmbeddedHarnessActiveTurn,
  EmbeddedHarnessModelUsage,
} from "../embedded-harness";
import type { TransientTeardownOutcome } from "../transient-turn";
import { RUN_TIME_STOP_GRACE_MS } from "../agent-session-budget";
import type { TransientSessionExecution } from "./support";
import type {
  CanonicalEmbeddedHarnessTextTurnError,
  TransientModelTurnError,
} from "./types";

export async function commitCheckpointAndAlarm(
  storage: DurableObjectStorage,
  prepared: PreparedHarnessCheckpoint,
  transition: CheckpointingStartedSessionCommit,
): Promise<ReturnType<typeof commitPreparedSessionCheckpoint>> {
  const committed = commitPreparedSessionCheckpoint(
    storage,
    prepared,
    transition,
  );
  if (!committed.ok) return committed;
  const due = Date.now() + 1_000;
  await armAlarmBy(storage, due);
  return committed;
}

export function embeddedHarnessFailureDetail(
  error: CanonicalEmbeddedHarnessTextTurnError,
): string | null {
  if (error.code === "embedded_harness_turn_failed_with_usage") {
    const cause = error.cause;
    const detail =
      "detail" in cause && typeof cause.detail === "string"
        ? cause.detail
        : "refusal" in cause && typeof cause.refusal === "string"
          ? cause.refusal
          : null;
    return (detail === null ? cause.code : `${cause.code}: ${detail}`).slice(
      0,
      500,
    );
  }
  if ("detail" in error && typeof error.detail === "string") {
    return error.detail.slice(0, 500);
  }
  return "reason" in error && typeof error.reason === "string"
    ? error.reason.slice(0, 500)
    : null;
}

type EmbeddedHarnessCompletion = DeadlineOutcome<
  Awaited<ReturnType<EmbeddedHarnessActiveTurn["complete"]>>,
  Awaited<ReturnType<EmbeddedHarnessActiveTurn["cancel"]>>
>;

/**
 * At its time limit a turn stops before its next model call and completes
 * with the time notice, so its history is saved and the thread goes on. A
 * turn that is still running a grace period later is cancelled.
 */
export async function completeEmbeddedHarnessTurnWithinBudget(
  turn: EmbeddedHarnessActiveTurn,
  activeWallMs: number,
): Promise<EmbeddedHarnessCompletion> {
  const stopAtNextStep = turn.stopAtNextStep;
  if (stopAtNextStep === undefined)
    return runTaskBeforeDeadline({
      timeoutMs: activeWallMs,
      start: startEmbeddedHarnessCompletion.bind(null, turn),
    });
  const softStop = setTimeout(
    stopAtNextStep.bind(turn, TURN_TIME_LIMIT_NOTICE),
    activeWallMs,
  );
  try {
    return await runTaskBeforeDeadline({
      timeoutMs: activeWallMs + RUN_TIME_STOP_GRACE_MS,
      start: startEmbeddedHarnessCompletion.bind(null, turn),
    });
  } finally {
    clearTimeout(softStop);
  }
}

const TURN_TIME_LIMIT_NOTICE =
  "Sous Chef stopped this request at the time limit for one request. Ask again to continue, in smaller steps if you can.";

function startEmbeddedHarnessCompletion(
  turn: EmbeddedHarnessActiveTurn,
): CancellableTask<
  Awaited<ReturnType<EmbeddedHarnessActiveTurn["complete"]>>,
  Awaited<ReturnType<EmbeddedHarnessActiveTurn["cancel"]>>
> {
  const completion = turn.complete();
  return createCancellableTask({
    completion,
    cancel: cancelEmbeddedHarnessCompletion.bind(null, turn, completion),
  });
}

async function cancelEmbeddedHarnessCompletion(
  turn: EmbeddedHarnessActiveTurn,
  completion: ReturnType<EmbeddedHarnessActiveTurn["complete"]>,
  _reason: TaskCancellationReason,
): Promise<Awaited<ReturnType<EmbeddedHarnessActiveTurn["cancel"]>>> {
  const cancellation = await turn.cancel();
  await completion;
  return cancellation;
}

export async function admitTransientHarnessTurn(
  admission: SessionExecutionAdmission,
  execution: TransientSessionExecution,
  turn: EmbeddedHarnessActiveTurn,
): Promise<void> {
  execution.state = { kind: "running", turn };
  if (!(await admission.isActive())) {
    const cancelled = await turn.cancel();
    if (!cancelled.ok) throw new Error(cancelled.error.detail);
  }
}

export function isTransientHarnessOpen(
  execution: TransientSessionExecution,
): boolean {
  return execution.state.kind !== "settling";
}

export function settleTransientHarnessTurn(
  execution: TransientSessionExecution,
): void {
  execution.state = { kind: "settling" };
}

/** Each recipient a label binds its content to, once. */
export function boundRecipients(
  label: import("../../policy/information-flow").FlowLabel,
): readonly import("../../policy/information-flow/types").FlowRecipient[] {
  const recipients = new Map<
    string,
    import("../../policy/information-flow/types").FlowRecipient
  >();
  for (const policy of label.policies) {
    if (policy.owner.kind === "recipient_constraint")
      recipients.set(
        JSON.stringify(policy.owner.recipient),
        policy.owner.recipient,
      );
  }
  return [...recipients.values()];
}

export function transientPlacementFailure(
  modelUsage: EmbeddedHarnessModelUsage | null,
): Result<never, TransientModelTurnError> {
  return {
    ok: false,
    error: { code: "session_placement_conflict", modelUsage },
  };
}

export function transientResultModelUsage(
  result: Result<
    { readonly modelUsage: EmbeddedHarnessModelUsage },
    TransientModelTurnError
  >,
): EmbeddedHarnessModelUsage | null {
  return result.ok ? result.value.modelUsage : result.error.modelUsage;
}

/** A Pi turn keeps nothing outside the Actor, so it has nothing to tear down. */
export function startNoTransientTeardown(
  _outcome: TransientTeardownOutcome,
): CancellableTask<
  Result<null, { readonly detail: string }>,
  Result<null, { readonly detail: string }>
> {
  const completion = Promise.resolve({ ok: true as const, value: null });
  return createCancellableTask({
    completion,
    cancel: settledTransientTeardown.bind(null, completion),
  });
}

function settledTransientTeardown(
  completion: Promise<Result<null, { readonly detail: string }>>,
): Promise<Result<null, { readonly detail: string }>> {
  return completion;
}
