import { isNonNegativeInteger, isRecord, parseJsonOrNull } from "@purin-labs/std";
import type { CaseExecutionEffectState } from "@purin-labs/control-api";
import type {
  CaseExecutionEffectRecord,
  CaseExecutionEffectRecords,
} from "../case-execution/records";

type Row = Record<string, SqlStorageValue>;

const MAX_CASE_EFFECTS = 200;
const EFFECT_STATES: readonly CaseExecutionEffectState[] = [
  "proposed",
  "approval_requested",
  "signed",
  "executing",
  "confirmed",
  "failed",
  "rejected",
  "expired",
  "indeterminate",
];

/**
 * The governed actions the ledger holds for one Case, as they stand. This
 * read changes nothing: an action past its expiry keeps its stored state
 * until a command expires it. The ledger keeps the latest state of an action
 * only, so each execution try is not recorded. The newest actions are kept
 * when the Case holds more than the bound, and the read says so.
 */
export function readCaseEffectRecords(
  sql: SqlStorage,
  organisationId: string,
  caseId: string,
): CaseExecutionEffectRecords {
  const rows = sql
    .exec<Row>(
      `SELECT nonce, proposal_id, state, created_at, updated_at, provider_result
       FROM action_ledger
       WHERE organisation_id = ? AND case_id = ?
       ORDER BY created_at DESC, nonce DESC
       LIMIT ?`,
      organisationId,
      caseId,
      MAX_CASE_EFFECTS + 1,
    )
    .toArray();
  const truncated = rows.length > MAX_CASE_EFFECTS;
  if (truncated) rows.length = MAX_CASE_EFFECTS;
  return { truncated, effects: rows.reverse().flatMap(effectRecord) };
}

function effectRecord(row: Row): CaseExecutionEffectRecord[] {
  const state = EFFECT_STATES.find((entry) => entry === row.state);
  if (
    state === undefined ||
    typeof row.nonce !== "string" ||
    typeof row.proposal_id !== "string" ||
    !isNonNegativeInteger(row.created_at) ||
    !isNonNegativeInteger(row.updated_at)
  )
    return [];
  const result =
    typeof row.provider_result === "string"
      ? parseJsonOrNull(row.provider_result)
      : null;
  return [
    {
      actionNonce: row.nonce,
      proposalId: row.proposal_id,
      state,
      recordedAt: row.created_at,
      updatedAt: row.updated_at,
      receipt:
        isRecord(result) &&
        typeof result.receiptId === "string" &&
        typeof result.status === "string" &&
        isNonNegativeInteger(result.observedAt)
          ? {
              receiptId: result.receiptId,
              status: result.status,
              observedAt: result.observedAt,
            }
          : null,
    },
  ];
}
