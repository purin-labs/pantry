import type {
  AgentSessionLifecycle,
  HarnessCheckpointRecord,
  SessionCommand,
  SessionTransition,
} from "@seams/contracts";
import {
  advanceSessionCommand as advanceSessionCommandTypescript,
  restoreSession as restoreSessionTypescript,
  validateHarnessCheckpointRestoreRecord as validateHarnessCheckpointRestoreRecordTypescript,
} from "@seams/contracts/session-reducer";
import type { Result } from "./result";
import { isRecord } from "@seams/std";

const ADVANCE_SCHEMA = "satyr.actor.advance-session-command.v1";
const RESTORE_SCHEMA = "satyr.actor.restore-session.v1";
const VALIDATE_HARNESS_CHECKPOINT_RESTORE_SCHEMA =
  "satyr.actor.validate-harness-checkpoint-restore.v1";
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

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
  const response = decodeResponse(
    reducerResponse(
      {
        schema: ADVANCE_SCHEMA,
        current: input.current,
        command: input.command,
      },
      advanceSessionCommandTypescript,
    ),
  );
  if (!response.ok) return response;
  if (
    JSON.stringify(response.value.transition) !==
      JSON.stringify(input.transition) ||
    JSON.stringify(response.value.state) !== JSON.stringify(input.state)
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
  const response = decodeRestoreResponse(
    reducerResponse(
      { schema: RESTORE_SCHEMA, snapshot: input.snapshot, tail: input.tail },
      restoreSessionTypescript,
    ),
  );
  if (!response.ok) return response;
  return JSON.stringify(response.value.state) === JSON.stringify(input.state)
    ? { ok: true, value: true }
    : { ok: false, error: { code: "actor_reducer_result_mismatch" } };
}

export function validateCanonicalHarnessCheckpointRestore(input: {
  readonly state: AgentSessionLifecycle;
  readonly checkpoint: HarnessCheckpointRecord;
}): Result<true, ActorReducerValidationError> {
  return decodeValidationResponse(
    reducerResponse(
      {
        schema: VALIDATE_HARNESS_CHECKPOINT_RESTORE_SCHEMA,
        state: input.state,
        checkpoint: input.checkpoint,
      },
      validateHarnessCheckpointRestoreRecordTypescript,
    ),
  );
}

/** The reducer's answer to the JSON request, as response bytes. */
function reducerResponse(
  request: object,
  typescript: (input: unknown) => unknown,
): Uint8Array {
  return ENCODER.encode(typescriptText(typescript, JSON.stringify(request)));
}

function typescriptText(
  typescript: (input: unknown) => unknown,
  json: string,
): string {
  try {
    return JSON.stringify(typescript(JSON.parse(json)));
  } catch {
    // A fault in the reducer answers as an invalid response, never as a state.
    return "{}";
  }
}

function decodeResponse(
  bytes: Uint8Array,
): Result<ActorAdvanceValue, ActorReducerValidationError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(DECODER.decode(bytes));
  } catch {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (!isRecord(decoded) || typeof decoded.status !== "string") {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (decoded.status === "error" && isRecord(decoded.error)) {
    const reason = decoded.error.code;
    return typeof reason === "string" && reason.length > 0
      ? { ok: false, error: { code: "actor_reducer_rejected", reason } }
      : { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (decoded.status !== "ok" || !isRecord(decoded.value)) {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  const transition = decoded.value.transition;
  const state = decoded.value.state;
  return isRecord(transition) && isRecord(state)
    ? { ok: true, value: { transition, state } }
    : { ok: false, error: { code: "actor_reducer_response_invalid" } };
}

function decodeRestoreResponse(
  bytes: Uint8Array,
): Result<ActorRestoreValue, ActorReducerValidationError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(DECODER.decode(bytes));
  } catch {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (!isRecord(decoded) || typeof decoded.status !== "string") {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (decoded.status === "error" && isRecord(decoded.error)) {
    const reason = decoded.error.code;
    return typeof reason === "string" && reason.length > 0
      ? { ok: false, error: { code: "actor_reducer_rejected", reason } }
      : { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (
    decoded.status !== "ok" ||
    !isRecord(decoded.value) ||
    !isRecord(decoded.value.state)
  ) {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  return { ok: true, value: { state: decoded.value.state } };
}

function decodeValidationResponse(
  bytes: Uint8Array,
): Result<true, ActorReducerValidationError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(DECODER.decode(bytes));
  } catch {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (!isRecord(decoded) || typeof decoded.status !== "string") {
    return { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  if (decoded.status === "error" && isRecord(decoded.error)) {
    const reason = decoded.error.code;
    return typeof reason === "string" && reason.length > 0
      ? { ok: false, error: { code: "actor_reducer_rejected", reason } }
      : { ok: false, error: { code: "actor_reducer_response_invalid" } };
  }
  return decoded.status === "ok" &&
    isRecord(decoded.value) &&
    decoded.value.valid === true
    ? { ok: true, value: true }
    : { ok: false, error: { code: "actor_reducer_response_invalid" } };
}

type ActorAdvanceValue = {
  readonly transition: Record<string, unknown>;
  readonly state: Record<string, unknown>;
};

type ActorRestoreValue = {
  readonly state: Record<string, unknown>;
};
