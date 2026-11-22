import { errorMessage } from "@purin-labs/std";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import { newRequestId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CodeModeBudgetError,
  CodeModeOrganisationCancelInput,
} from "./code-mode-budget";
import {
  codeModeExecutionEffectId,
  parseCodeModeExecutionRecord,
  type CodeModeExecutionRecord,
} from "./code-mode-execution-record";

/**
 * An execution whose turn ended before its script settled: the turn was
 * cancelled, failed, or could not resume. No script continues under it. Its
 * reservation is released at both owners, and its record leaves the open
 * states, so that it holds no allowance and blocks no relocation.
 *
 * A release decides the reservation only. An effect that the script
 * dispatched keeps its own receipt and its own reconciliation.
 */

/** What an owner holds for the reservation after the release. */
type ReleasedReservationState =
  /** This release cancelled the live reservation. */
  | "cancelled"
  /** The owner holds no reservation for the execution. */
  | "absent"
  /** The reservation had ended before the release: its ledger state. */
  | (string & {});

export type CodeModeExecutionRelease = StrictUnion<
  | {
      readonly kind: "released";
      readonly organisation: ReleasedReservationState;
      readonly platform: ReleasedReservationState;
    }
  /** An owner did not answer or did not accept a lease. The record stays open. */
  | { readonly kind: "deferred"; readonly reason: string }
>;

/** The cancellation of a reservation at one of its owners. */
export type CodeModeReservationCancel = (
  input: CodeModeOrganisationCancelInput,
) => Promise<Result<unknown, CodeModeBudgetError | { readonly code: string }>>;

type OpenExecutionRow = Record<string, SqlStorageValue> & {
  readonly request_envelope: string;
};

const EXECUTION_KIND = "code_mode_execution.v1";

/**
 * The open executions that no active turn owns. `activeExecutionId` is the
 * execution of the turn that the Session holds, or `null` when it holds none.
 * A record that does not parse stays open: it needs an operator.
 */
export function readEndedCodeModeExecutions(
  sql: SqlStorage,
  activeExecutionId: string | null,
): CodeModeExecutionRecord[] {
  const rows = sql
    .exec<OpenExecutionRow>(
      `SELECT request_envelope FROM actor_outbox
       WHERE state_kind IN ('pending', 'dispatching')
         AND json_extract(request_envelope, '$.kind') = ?
       ORDER BY updated_at ASC LIMIT 8`,
      EXECUTION_KIND,
    )
    .toArray();
  const ended: CodeModeExecutionRecord[] = [];
  for (const row of rows) {
    const record = parseCodeModeExecutionRecord(row.request_envelope);
    if (record !== null && record.executionId !== activeExecutionId)
      ended.push(record);
  }
  return ended;
}

/** Cancels the reservation of an ended execution at both of its owners. */
export async function releaseCodeModeReservation(input: {
  readonly record: CodeModeExecutionRecord;
  readonly organisation: CodeModeReservationCancel;
  readonly platform: CodeModeReservationCancel;
  readonly now: number;
}): Promise<CodeModeExecutionRelease> {
  const platform = await cancelAtOwner(input.platform, input.record, input.now);
  if (platform.kind === "deferred") return platform;
  const organisation = await cancelAtOwner(
    input.organisation,
    input.record,
    input.now,
  );
  if (organisation.kind === "deferred") return organisation;
  return {
    kind: "released",
    organisation: organisation.state,
    platform: platform.state,
  };
}

/**
 * Closes the record of a released execution. It returns `false` when the
 * record changed since the release began: a settlement or another release
 * decided it.
 */
export function markCodeModeExecutionReleased(
  sql: SqlStorage,
  record: CodeModeExecutionRecord,
  release: Variant<CodeModeExecutionRelease, "released">,
  cause: { readonly relocationId?: string },
  now: number,
): boolean {
  const updated = sql.exec(
    `UPDATE actor_outbox SET state_kind = 'reconciled', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind IN ('pending', 'dispatching')
       AND json_extract(request_envelope, '$.kind') = ?`,
    JSON.stringify({
      kind: "execution_released",
      organisation: release.organisation,
      platform: release.platform,
      ...(cause.relocationId === undefined
        ? {}
        : { relocationId: cause.relocationId }),
      releasedAt: now,
    }),
    now,
    codeModeExecutionEffectId(record.executionId),
    EXECUTION_KIND,
  );
  return updated.rowsWritten === 1;
}

type OwnerRelease =
  | { readonly kind: "ended"; readonly state: ReleasedReservationState }
  | Variant<CodeModeExecutionRelease, "deferred">;

async function cancelAtOwner(
  cancel: CodeModeReservationCancel,
  record: CodeModeExecutionRecord,
  now: number,
): Promise<OwnerRelease> {
  // An owner holds one lease. During a handoff it is either of two.
  for (const leaseId of heldLeases(record)) {
    let cancelled: Awaited<ReturnType<CodeModeReservationCancel>>;
    try {
      cancelled = await cancel({
        requestId: newRequestId(),
        organisationId: record.organisationId,
        executionId: record.executionId,
        leaseId,
        reason: "turn_cancelled",
        now,
      });
    } catch (error) {
      return { kind: "deferred", reason: errorMessage(error) };
    }
    if (cancelled.ok) return { kind: "ended", state: "cancelled" };
    const error = cancelled.error;
    if (error.code === "code_mode_reservation_not_found")
      return { kind: "ended", state: "absent" };
    // The reservation settled, expired, or was cancelled before this release.
    if (error.code === "code_mode_reservation_invalid_transition")
      return {
        kind: "ended",
        state: "state" in error ? error.state : "ended",
      };
    if (error.code !== "code_mode_reservation_lease_conflict")
      return { kind: "deferred", reason: error.code };
  }
  return { kind: "deferred", reason: "code_mode_reservation_lease_conflict" };
}

function heldLeases(record: CodeModeExecutionRecord): readonly string[] {
  const authority = record.authority;
  switch (authority.kind) {
    case "generation_unrecorded":
      return [authority.leaseId];
    case "bound":
      return [authority.binding.leaseId];
    case "rebinding":
      return [authority.intended.leaseId, authority.binding.leaseId];
    default:
      return authority satisfies never;
  }
}
