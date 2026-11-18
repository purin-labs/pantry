import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
  sha256Hex,
} from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";
import { parseOrganisationId, type OrganisationId } from "../ids";
import type {
  CodeModeLeaseBinding,
  CodeModeOrganisationReserveInput,
} from "./code-mode-budget";

const RECORD_KIND = "code_mode_execution.v1";

/**
 * Which lease holds an admitted execution in the Session Actor.
 *
 * `bound`: the lease of one runtime generation holds it.
 * `rebinding`: a later generation's lease is intended. The owners of the
 * reservation may or may not hold it yet, so neither lease may run the
 * execution until the Session Actor adopts the intended one.
 * `generation_unrecorded`: a record written before the generation and the
 * deadline were stored. It settles under its lease and cannot be rebound.
 */
export type CodeModeExecutionAuthority = StrictUnion<
  | {
      readonly kind: "generation_unrecorded";
      readonly leaseId: string;
    }
  | {
      readonly kind: "bound";
      readonly binding: CodeModeLeaseBinding;
      readonly executionDeadlineAt: number;
    }
  | {
      readonly kind: "rebinding";
      readonly binding: CodeModeLeaseBinding;
      readonly intended: CodeModeLeaseBinding;
      readonly executionDeadlineAt: number;
    }
>;

/** The Session Actor's record of one admitted Code Mode execution. */
export type CodeModeExecutionRecord = {
  readonly executionId: string;
  readonly organisationId: OrganisationId;
  readonly admissionDigest: string;
  readonly priceBookRevision: string;
  readonly reservedCostMicros: number;
  readonly authority: CodeModeExecutionAuthority;
};

export type StoredCodeModeExecution = {
  readonly record: CodeModeExecutionRecord;
  readonly stateKind: string;
  readonly stateProjection: string;
};

type ExecutionRow = Record<string, SqlStorageValue> & {
  readonly request_envelope: string;
  readonly state_kind: string;
  readonly state_projection: string;
};

export function codeModeExecutionEffectId(executionId: string): string {
  return `execution-${executionId}`;
}

/**
 * The lease of one runtime generation for one execution. The execution
 * identity is stable, so each generation derives a different lease, and a
 * lease names its generation without a lookup.
 */
export async function deriveCodeModeLeaseBinding(
  executionId: string,
  runtimeGeneration: number,
): Promise<CodeModeLeaseBinding> {
  const digest = await sha256Hex(
    JSON.stringify({ executionId, runtimeGeneration }),
  );
  return { leaseId: `lease-${digest.slice(0, 32)}`, runtimeGeneration };
}

export function admittedCodeModeExecutionRecord(
  reserve: CodeModeOrganisationReserveInput,
): CodeModeExecutionRecord {
  return {
    executionId: reserve.executionId,
    organisationId: reserve.organisationId,
    admissionDigest: reserve.admissionDigest,
    priceBookRevision: reserve.priceBookRevision,
    reservedCostMicros: reserve.reservedCostMicros,
    authority: {
      kind: "bound",
      binding: {
        leaseId: reserve.leaseId,
        runtimeGeneration: reserve.runtimeGeneration,
      },
      executionDeadlineAt: reserve.executionDeadlineAt,
    },
  };
}

/** The lease that the Session Actor accepts for this execution. */
export function codeModeExecutionLeaseId(
  authority: CodeModeExecutionAuthority,
): string {
  switch (authority.kind) {
    case "generation_unrecorded":
      return authority.leaseId;
    case "bound":
    case "rebinding":
      return authority.binding.leaseId;
    default:
      return authority satisfies never;
  }
}

export function encodeCodeModeExecutionRecord(
  record: CodeModeExecutionRecord,
): string {
  const common = {
    kind: RECORD_KIND,
    executionId: record.executionId,
    leaseId: codeModeExecutionLeaseId(record.authority),
    organisationId: record.organisationId,
    admissionDigest: record.admissionDigest,
    priceBookRevision: record.priceBookRevision,
    reservedCostMicros: record.reservedCostMicros,
  };
  switch (record.authority.kind) {
    case "generation_unrecorded":
      return JSON.stringify(common);
    case "bound":
      return JSON.stringify({
        ...common,
        runtimeGeneration: record.authority.binding.runtimeGeneration,
        executionDeadlineAt: record.authority.executionDeadlineAt,
      });
    case "rebinding":
      return JSON.stringify({
        ...common,
        runtimeGeneration: record.authority.binding.runtimeGeneration,
        executionDeadlineAt: record.authority.executionDeadlineAt,
        rebind: {
          leaseId: record.authority.intended.leaseId,
          runtimeGeneration: record.authority.intended.runtimeGeneration,
        },
      });
    default:
      return record.authority satisfies never;
  }
}

export function parseCodeModeExecutionRecord(
  raw: string,
): CodeModeExecutionRecord | null {
  const value = parseJsonOrNull(raw);
  if (
    !isRecord(value) ||
    value.kind !== RECORD_KIND ||
    typeof value.executionId !== "string" ||
    typeof value.leaseId !== "string" ||
    typeof value.organisationId !== "string" ||
    typeof value.admissionDigest !== "string" ||
    typeof value.priceBookRevision !== "string" ||
    !isNonNegativeInteger(value.reservedCostMicros)
  )
    return null;
  const organisationId = parseOrganisationId(value.organisationId);
  if (!organisationId.ok) return null;
  const authority = parseAuthority(value, value.leaseId);
  if (authority === null) return null;
  return {
    executionId: value.executionId,
    organisationId: organisationId.value,
    admissionDigest: value.admissionDigest,
    priceBookRevision: value.priceBookRevision,
    reservedCostMicros: value.reservedCostMicros,
    authority,
  };
}

function parseAuthority(
  value: Record<string, unknown>,
  leaseId: string,
): CodeModeExecutionAuthority | null {
  if (
    value.runtimeGeneration === undefined &&
    value.executionDeadlineAt === undefined &&
    value.rebind === undefined
  )
    return { kind: "generation_unrecorded", leaseId };
  if (
    !isPositiveInteger(value.runtimeGeneration) ||
    !isNonNegativeInteger(value.executionDeadlineAt)
  )
    return null;
  const binding = { leaseId, runtimeGeneration: value.runtimeGeneration };
  if (value.rebind === undefined)
    return {
      kind: "bound",
      binding,
      executionDeadlineAt: value.executionDeadlineAt,
    };
  if (
    !isRecord(value.rebind) ||
    typeof value.rebind.leaseId !== "string" ||
    !isPositiveInteger(value.rebind.runtimeGeneration) ||
    value.rebind.runtimeGeneration <= binding.runtimeGeneration ||
    value.rebind.leaseId === leaseId
  )
    return null;
  return {
    kind: "rebinding",
    binding,
    intended: {
      leaseId: value.rebind.leaseId,
      runtimeGeneration: value.rebind.runtimeGeneration,
    },
    executionDeadlineAt: value.executionDeadlineAt,
  };
}

export function readCodeModeExecution(
  sql: SqlStorage,
  executionId: string,
):
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "found"; readonly stored: StoredCodeModeExecution } {
  const row = sql
    .exec<ExecutionRow>(
      `SELECT request_envelope, state_kind, state_projection
       FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      codeModeExecutionEffectId(executionId),
    )
    .toArray()[0];
  if (row === undefined) return { kind: "missing" };
  const record = parseCodeModeExecutionRecord(row.request_envelope);
  if (record === null || record.executionId !== executionId)
    return { kind: "corrupt" };
  return {
    kind: "found",
    stored: {
      record,
      stateKind: row.state_kind,
      stateProjection: row.state_projection,
    },
  };
}

/** Replaces the authority of a stored execution. The caller owns the transaction. */
export function writeCodeModeExecutionAuthority(
  sql: SqlStorage,
  record: CodeModeExecutionRecord,
  authority: CodeModeExecutionAuthority,
  now: number,
): void {
  sql.exec(
    `UPDATE actor_outbox SET request_envelope = ?, updated_at = ?
     WHERE effect_id = ?`,
    encodeCodeModeExecutionRecord({
      executionId: record.executionId,
      organisationId: record.organisationId,
      admissionDigest: record.admissionDigest,
      priceBookRevision: record.priceBookRevision,
      reservedCostMicros: record.reservedCostMicros,
      authority,
    }),
    now,
    codeModeExecutionEffectId(record.executionId),
  );
}
