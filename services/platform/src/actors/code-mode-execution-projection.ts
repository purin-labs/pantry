import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { HarnessCodeModeExecutionLease } from "../agent-tools/catalog/types";
import { isNonNegativeInteger, isRecord } from "@purin-labs/std";

/**
 * The counters of one admitted Code Mode execution. The Session keeps them
 * as the state projection of the execution's row in `actor_outbox`.
 */
export type CodeModeExecutionCounter = {
  readonly capabilityCalls: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
};

export type CodeModeExecutionProjection = {
  readonly kind: "pending" | "dispatching";
} & CodeModeExecutionCounter;

type CodeModeExecutionCounterError = {
  readonly code: "code_mode_execution_state_conflict";
};

type ExecutionOutboxRow = Record<string, SqlStorageValue> & {
  readonly effect_id: string;
  readonly request_envelope: string;
  readonly state_projection: string;
};

type ExecutionRequestIdentity = {
  readonly executionId: string;
  readonly leaseId: string;
  readonly organisationId: OrganisationId;
};

function readCodeModeExecutionProjection(
  sql: SqlStorage,
  executionId: string,
): CodeModeExecutionProjection | null {
  const row = sql
    .exec<ExecutionOutboxRow>(
      `SELECT effect_id, request_envelope, state_projection
     FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      executionEffectId(executionId),
    )
    .toArray()[0];
  return row === undefined
    ? null
    : parseCodeModeExecutionProjection(row.state_projection);
}

export function writeCodeModeExecutionCounter(
  storage: DurableObjectStorage,
  executionLease: HarnessCodeModeExecutionLease,
  counter: CodeModeExecutionCounter,
  now: number,
): Result<null, CodeModeExecutionCounterError> {
  return storage.transactionSync(
    updateExecutionCounter.bind(
      null,
      storage.sql,
      executionLease,
      counter,
      now,
    ),
  );
}

export function parseCodeModeExecutionProjection(
  raw: string,
): CodeModeExecutionProjection | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const counter = parseCounter(value);
  if (counter === null) return null;
  switch (value.kind) {
    case "pending":
    case "dispatching":
      return { kind: value.kind, ...counter };
    default:
      return null;
  }
}

function updateExecutionCounter(
  sql: SqlStorage,
  executionLease: HarnessCodeModeExecutionLease,
  counter: CodeModeExecutionCounter,
  now: number,
): Result<null, CodeModeExecutionCounterError> {
  const identity = readExecutionRequestIdentity(
    sql,
    executionLease.executionId,
  );
  const projection = readCodeModeExecutionProjection(
    sql,
    executionLease.executionId,
  );
  if (
    identity === null ||
    identity.leaseId !== executionLease.leaseId ||
    projection === null
  ) {
    return {
      ok: false,
      error: { code: "code_mode_execution_state_conflict" },
    };
  }
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'dispatching', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind IN ('pending', 'dispatching')`,
    JSON.stringify({ kind: "dispatching", ...counter }),
    now,
    executionEffectId(executionLease.executionId),
  );
  return { ok: true, value: null };
}

function parseCounter(
  value: Record<string, unknown>,
): CodeModeExecutionCounter | null {
  return isNonNegativeInteger(value.capabilityCalls) &&
    isNonNegativeInteger(value.inputBytes) &&
    isNonNegativeInteger(value.outputBytes)
    ? {
        capabilityCalls: value.capabilityCalls,
        inputBytes: value.inputBytes,
        outputBytes: value.outputBytes,
      }
    : null;
}

function readExecutionRequestIdentity(
  sql: SqlStorage,
  executionId: string,
): ExecutionRequestIdentity | null {
  const row = sql
    .exec<{ request_envelope: string }>(
      `SELECT request_envelope FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      executionEffectId(executionId),
    )
    .toArray()[0];
  return row === undefined
    ? null
    : parseExecutionRequestIdentity(row.request_envelope);
}

function parseExecutionRequestIdentity(
  raw: string,
): ExecutionRequestIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.kind !== "code_mode_execution.v1" ||
    typeof value.executionId !== "string" ||
    typeof value.leaseId !== "string" ||
    typeof value.organisationId !== "string"
  )
    return null;
  const organisationId = parseOrganisationId(value.organisationId);
  if (!organisationId.ok) return null;
  return {
    executionId: value.executionId,
    leaseId: value.leaseId,
    organisationId: organisationId.value,
  };
}

function executionEffectId(executionId: string): string {
  return `execution-${executionId}`;
}
