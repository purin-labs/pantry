import type { EmbeddedHarnessModelUsage, TurnIdentity } from "@seams/contracts";
import {
  createCancellableTask,
  type CancellableTask,
  type TaskCancellationReason,
} from "@seams/async-control/cancellable-task";
import { runTaskBeforeDeadline } from "@seams/async-control/deadline";

import type { Result } from "../result";
import type {
  AcceptHarnessEventInput,
  AppendHarnessHistoryInput,
  HarnessEventAcceptance,
} from "./agent-session-harness-authority";
import type {
  CanonicalHarnessEventSink,
  CanonicalHarnessHistorySink,
  EmbeddedHarnessActiveTurn,
  EmbeddedHarnessAdapter,
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessRuntime,
  EmbeddedHarnessTurnError,
  EmbeddedHarnessUserInput,
} from "./embedded-harness";
import {
  digestHarnessHistoryEntry,
  type HarnessHistoryAcceptance,
} from "./harness-history";

const TRANSIENT_CLEANUP_MAX_WALL_MS = 5_000;

/**
 * One transient turn: the harness runs under the pinned authority, its result
 * returns through this call, and transcript content stays out of accepted
 * history, checkpoints, and Actor storage. Caller-owned usage records can
 * persist separately. The sinks below satisfy the
 * adapter contract while retaining only sequence counters and digests.
 *
 * Email and WhatsApp support turns both run here. Neither one persists the
 * transcript, so this runner has no storage of its own to clean up beyond the
 * caller-supplied teardown.
 */

export type TransientTurnError =
  | {
      readonly code: "transient_turn_construction_failed";
      readonly detail: string;
      readonly modelUsage: null;
    }
  | {
      readonly code: "transient_turn_failed";
      readonly detail: string;
      readonly modelUsage: EmbeddedHarnessModelUsage | null;
    }
  | {
      readonly code: "transient_turn_output_invalid";
      readonly detail: string;
      readonly modelUsage: EmbeddedHarnessModelUsage;
    }
  | {
      readonly code: "transient_turn_cleanup_failed";
      readonly detail: string;
      readonly modelUsage: EmbeddedHarnessModelUsage | null;
    }
  | {
      readonly code: "transient_turn_token_budget_exhausted";
      readonly detail: string;
      readonly modelUsage: EmbeddedHarnessModelUsage;
    };

export type TransientTurnSuccess<TValue> = {
  readonly value: TValue;
  readonly modelUsage: EmbeddedHarnessModelUsage;
};

export type TransientTeardownOutcome = "completed" | "failed";

export type TransientTurnInput<TValue> = {
  readonly adapter: EmbeddedHarnessAdapter;
  readonly construction: Omit<
    EmbeddedHarnessConstructionInput,
    "eventSink" | "historySink"
  >;
  readonly input: readonly EmbeddedHarnessUserInput[];
  readonly maxWallMs: number;
  readonly onTurnStarted?: (turn: EmbeddedHarnessActiveTurn) => Promise<void>;
  readonly onTurnSettled?: () => void;
  /**
   * Turns the harness's final message into the caller's result. It runs
   * before teardown so an unusable output is torn down as a failed turn.
   */
  readonly complete: (
    finalMessage: string,
  ) => Result<TValue, { readonly detail: string }>;
  /**
   * Deletes the native thread, turn workspace, and temporary files. The runner
   * awaits this on every terminal branch before it reports the turn complete;
   * a teardown failure supersedes the turn outcome so the caller fails closed.
   */
  readonly teardown: (
    outcome: TransientTeardownOutcome,
  ) => CancellableTask<
    Result<null, { readonly detail: string }>,
    Result<null, { readonly detail: string }>
  >;
};

export type TransientHarnessSinkUsage = {
  readonly acceptedEvents: number;
  readonly historyEntries: number;
};

export type TransientHarnessSinks = {
  readonly eventSink: CanonicalHarnessEventSink;
  readonly historySink: CanonicalHarnessHistorySink;
  usage(): TransientHarnessSinkUsage;
};

export function createTransientHarnessSinks(
  turn: TurnIdentity,
): TransientHarnessSinks {
  const state = {
    acceptedEvents: 0,
    historyEntries: 0,
    lastEventSequence: 0,
    lastEventDigest: null as string | null,
    lastHistorySequence: 0,
    lastHistoryDigest: null as string | null,
  };
  return {
    eventSink: {
      async acceptCanonicalHarnessEvent(
        input: AcceptHarnessEventInput,
      ): Promise<Result<HarnessEventAcceptance, never>> {
        if (
          input.sequence === state.lastEventSequence &&
          state.lastEventDigest !== null
        ) {
          return {
            ok: true,
            value: {
              kind: "duplicate",
              cursor: {
                kind: "accepted",
                turn,
                lastSequence: state.lastEventSequence,
                lastEventDigest: state.lastEventDigest,
              },
            },
          };
        }
        state.lastEventSequence = input.sequence;
        state.lastEventDigest = input.eventDigest;
        state.acceptedEvents += 1;
        return {
          ok: true,
          value: {
            kind: "advanced",
            cursor: {
              kind: "accepted",
              turn,
              lastSequence: input.sequence,
              lastEventDigest: input.eventDigest,
            },
          },
        };
      },
    },
    historySink: {
      async appendHarnessHistory(
        input: AppendHarnessHistoryInput,
      ): Promise<Result<HarnessHistoryAcceptance, never>> {
        const entryDigest = await digestHarnessHistoryEntry({
          sessionId: input.sessionId,
          sequence: input.sequence,
          previousDigest: input.previousDigest,
          entry: input.entry,
        });
        if (
          input.sequence === state.lastHistorySequence &&
          state.lastHistoryDigest !== null
        ) {
          return {
            ok: true,
            value: {
              kind: "duplicate",
              cursor: {
                lastSequence: state.lastHistorySequence,
                lastEntryDigest: state.lastHistoryDigest,
              },
            },
          };
        }
        state.lastHistorySequence = input.sequence;
        state.lastHistoryDigest = entryDigest;
        state.historyEntries += 1;
        return {
          ok: true,
          value: {
            kind: "advanced",
            cursor: {
              lastSequence: input.sequence,
              lastEntryDigest: entryDigest,
            },
          },
        };
      },
    },
    usage() {
      return {
        acceptedEvents: state.acceptedEvents,
        historyEntries: state.historyEntries,
      };
    },
  };
}

export async function runTransientTurn<TValue>(
  input: TransientTurnInput<TValue>,
): Promise<Result<TransientTurnSuccess<TValue>, TransientTurnError>> {
  const deadlineAt = Date.now() + input.maxWallMs;
  const sinks = createTransientHarnessSinks(input.construction.turnLease.turn);
  const runtime = input.adapter.construct({
    ...input.construction,
    eventSink: sinks.eventSink,
    historySink: sinks.historySink,
  });
  if (!runtime.ok) {
    return sealTransientTurn(
      input.teardown,
      "failed",
      {
        ok: false,
        error: {
          code: "transient_turn_construction_failed",
          detail: runtime.error.code,
          modelUsage: null,
        },
      },
      input.maxWallMs,
    );
  }
  let outcome: Result<TransientTurnSuccess<TValue>, TransientTurnError>;
  try {
    outcome = await executeTransientTurn(runtime.value, input, deadlineAt);
  } catch (error) {
    outcome = {
      ok: false,
      error: {
        code: "transient_turn_failed",
        detail: error instanceof Error ? error.message : String(error),
        modelUsage: null,
      },
    };
  } finally {
    input.onTurnSettled?.();
    await runtime.value.close();
  }
  return sealTransientTurn(
    input.teardown,
    outcome.ok ? "completed" : "failed",
    outcome,
    input.maxWallMs,
  );
}

async function executeTransientTurn<TValue>(
  runtime: EmbeddedHarnessRuntime,
  input: TransientTurnInput<TValue>,
  deadlineAt: number,
): Promise<Result<TransientTurnSuccess<TValue>, TransientTurnError>> {
  const startedBeforeDeadline = await runTaskBeforeDeadline({
    timeoutMs: remainingTransientWallMs(deadlineAt),
    start: runtime.startTurn.bind(runtime, input.input),
  });
  if (startedBeforeDeadline.kind === "deadline_exceeded") {
    return {
      ok: false,
      error: {
        code: "transient_turn_failed",
        detail: cancellationDetail(
          startedBeforeDeadline.cancellation,
          "wall_clock_exhausted",
        ),
        modelUsage: null,
      },
    };
  }
  const started = startedBeforeDeadline.value;
  if (!started.ok) {
    return {
      ok: false,
      error: transientHarnessFailure(started.error),
    };
  }
  try {
    await input.onTurnStarted?.(started.value);
  } catch (error) {
    await started.value.cancel();
    throw error;
  }
  const completion = await runTaskBeforeDeadline({
    timeoutMs: remainingTransientWallMs(deadlineAt),
    start: startActiveTurnCompletion.bind(null, started.value),
  });
  if (completion.kind === "deadline_exceeded") {
    return {
      ok: false,
      error: {
        code: "transient_turn_failed",
        detail: cancellationDetail(
          completion.cancellation.cancellation,
          "wall_clock_exhausted",
        ),
        modelUsage: completion.cancellation.modelUsage,
      },
    };
  }
  const completed = completion.value;
  if (!completed.ok) {
    return {
      ok: false,
      error: transientHarnessFailure(completed.error),
    };
  }
  if (
    completed.value.modelUsage.totalTokens >
    input.construction.modelTokenAllowance
  ) {
    return {
      ok: false,
      error: {
        code: "transient_turn_token_budget_exhausted",
        detail: "model_token_allowance_exceeded",
        modelUsage: completed.value.modelUsage,
      },
    };
  }
  const value = input.complete(completed.value.finalMessage.trim());
  return value.ok
    ? {
        ok: true,
        value: { value: value.value, modelUsage: completed.value.modelUsage },
      }
    : {
        ok: false,
        error: {
          code: "transient_turn_output_invalid",
          detail: value.error.detail,
          modelUsage: completed.value.modelUsage,
        },
      };
}

async function sealTransientTurn<TValue>(
  teardown: TransientTurnInput<TValue>["teardown"],
  outcome: TransientTeardownOutcome,
  result: Result<TransientTurnSuccess<TValue>, TransientTurnError>,
  maxWallMs: number,
): Promise<Result<TransientTurnSuccess<TValue>, TransientTurnError>> {
  const cleanup = await runTaskBeforeDeadline({
    timeoutMs: transientCleanupWallMs(maxWallMs),
    start: teardown.bind(null, outcome),
  });
  if (cleanup.kind === "deadline_exceeded") {
    return {
      ok: false,
      error: {
        code: "transient_turn_cleanup_failed",
        detail: cancellationDetail(
          cleanup.cancellation,
          "teardown_wall_clock_exhausted",
        ),
        modelUsage: transientResultUsage(result),
      },
    };
  }
  const cleaned = cleanup.value;
  return cleaned.ok
    ? result
    : {
        ok: false,
        error: {
          code: "transient_turn_cleanup_failed",
          detail: cleaned.error.detail,
          modelUsage: transientResultUsage(result),
        },
      };
}

function remainingTransientWallMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function transientCleanupWallMs(maxWallMs: number): number {
  return Math.max(1, Math.min(TRANSIENT_CLEANUP_MAX_WALL_MS, maxWallMs));
}

function startActiveTurnCompletion(
  turn: EmbeddedHarnessActiveTurn,
): CancellableTask<
  Awaited<ReturnType<EmbeddedHarnessActiveTurn["complete"]>>,
  TransientTurnCancellation
> {
  const completion = turn.complete();
  return createCancellableTask({
    completion,
    cancel: cancelActiveTurnCompletion.bind(null, turn, completion),
  });
}

async function cancelActiveTurnCompletion(
  turn: EmbeddedHarnessActiveTurn,
  completion: ReturnType<EmbeddedHarnessActiveTurn["complete"]>,
  _reason: TaskCancellationReason,
): Promise<TransientTurnCancellation> {
  const cancellation = await turn.cancel();
  const result = await completion;
  return {
    cancellation,
    modelUsage: result.ok
      ? result.value.modelUsage
      : transientHarnessFailure(result.error).modelUsage,
  };
}

/** The cause of a turn whose provider refused a credential with nothing left. */
export const MODEL_AUTHORITY_EXHAUSTED =
  "embedded_harness_model_authority_exhausted";

type TransientTurnCancellation = Readonly<{
  cancellation: Awaited<ReturnType<EmbeddedHarnessActiveTurn["cancel"]>>;
  modelUsage: EmbeddedHarnessModelUsage | null;
}>;

function transientHarnessFailure(
  error: EmbeddedHarnessTurnError,
): TransientTurnError {
  switch (error.code) {
    case "embedded_harness_token_budget_exhausted":
      return {
        code: "transient_turn_token_budget_exhausted",
        detail: "model_token_allowance_exceeded",
        modelUsage: error.modelUsage,
      };
    case "embedded_harness_turn_failed_with_usage":
      return {
        code: "transient_turn_failed",
        detail:
          error.cause.code === "embedded_harness_model_usage_missing" &&
          error.cause.refusal === "authority_exhausted"
            ? MODEL_AUTHORITY_EXHAUSTED
            : error.cause.code,
        modelUsage: error.modelUsage,
      };
    default:
      return {
        code: "transient_turn_failed",
        detail: error.code,
        modelUsage: null,
      };
  }
}

function transientResultUsage<TValue>(
  result: Result<TransientTurnSuccess<TValue>, TransientTurnError>,
): EmbeddedHarnessModelUsage | null {
  return result.ok ? result.value.modelUsage : result.error.modelUsage;
}

function cancellationDetail(
  cancellation: Result<null, { readonly detail: string }>,
  completedDetail: string,
): string {
  return cancellation.ok ? completedDetail : cancellation.error.detail;
}
