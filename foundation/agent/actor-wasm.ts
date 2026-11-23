import type {
  AgentSessionLifecycle,
  HarnessCheckpointRecord,
  SessionCommand,
  SessionTransition,
} from "@purin-labs/contracts";
import {
  ADVANCE_SESSION_COMMAND_SCHEMA,
  RESTORE_SESSION_SCHEMA,
  VALIDATE_HARNESS_CHECKPOINT_RESTORE_SCHEMA,
  advanceSessionCommand,
  restoreSession,
  validateHarnessCheckpointRestoreRecord,
} from "@purin-labs/contracts/session-reducer";
import type { Result } from "@purin-labs/kernel/result";
import { isRecord } from "@purin-labs/std";

export type ActorReducerValidationError =
  | { code: "actor_reducer_response_invalid" }
  | { code: "actor_reducer_rejected"; reason: string }
  | { code: "actor_reducer_result_mismatch" };

export function validateCanonicalSessionAdvance(input: {
  readonly current: AgentSessionLifecycle | null;
  readonly command: SessionCommand;
  readonly transition: SessionTransition;
  readonly state: AgentSessionLifecycle;
}): Result<true, ActorReducerValidationError> {
  const response = reducerValue(
    {
      schema: ADVANCE_SESSION_COMMAND_SCHEMA,
      current: input.current,
      command: input.command,
    },
    advanceSessionCommand,
  );
  if (!response.ok) return response;
  const { transition, state } = response.value;
  if (!isRecord(transition) || !isRecord(state))
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  if (
    JSON.stringify(transition) !== JSON.stringify(input.transition) ||
    JSON.stringify(state) !== JSON.stringify(input.state)
  ) {
    return { ok: false, error: { code: "actor_reducer_result_mismatch" } };
  }
  return { ok: true, value: true };
}

export function validateCanonicalSessionRestore(input: {
  readonly snapshot: {
    readonly lastSequence: number;
    readonly state: AgentSessionLifecycle;
  };
  readonly tail: readonly {
    readonly sequence: number;
    readonly transition: unknown;
  }[];
  readonly state: AgentSessionLifecycle;
}): Result<true, ActorReducerValidationError> {
  const response = reducerValue(
    {
      schema: RESTORE_SESSION_SCHEMA,
      snapshot: input.snapshot,
      tail: input.tail,
    },
    restoreSession,
  );
  if (!response.ok) return response;
  const state = response.value.state;
  if (!isRecord(state))
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  return JSON.stringify(state) === JSON.stringify(input.state)
    ? { ok: true, value: true }
    : { ok: false, error: { code: "actor_reducer_result_mismatch" } };
}

export function validateCanonicalHarnessCheckpointRestore(input: {
  readonly state: AgentSessionLifecycle;
  readonly checkpoint: HarnessCheckpointRecord;
}): Result<true, ActorReducerValidationError> {
  const response = reducerValue(
    {
      schema: VALIDATE_HARNESS_CHECKPOINT_RESTORE_SCHEMA,
      state: input.state,
      checkpoint: input.checkpoint,
    },
    validateHarnessCheckpointRestoreRecord,
  );
  if (!response.ok) return response;
  return response.value.valid === true
    ? { ok: true, value: true }
    : { ok: false, error: { code: "actor_reducer_response_invalid" } };
}

/**
 * The value of the reducer's answer to one request. The reducer reads JSON
 * values, as a stored or sent request holds them, so it gets a JSON copy: a
 * field with no value is absent. A fault in the reducer answers as an invalid
 * response, never as a state.
 */
function reducerValue(
  request: object,
  reducer: (input: unknown) => unknown,
): Result<Record<string, unknown>, ActorReducerValidationError> {
  let answer: unknown;
  try {
    answer = reducer(JSON.parse(JSON.stringify(request)));
  } catch {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (!isRecord(answer) || typeof answer.status !== "string") {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (answer.status === "error" && isRecord(answer.error)) {
    const reason = answer.error.code;
    return typeof reason === "string" && reason.length > 0
      ? { ok: false, error: { code: "actor_reducer_rejected", reason } }
      : { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  return answer.status === "ok" && isRecord(answer.value)
    ? { ok: true, value: answer.value }
    : { ok: false, error: { code: "actor_reducer_response_invalid" } };
}
