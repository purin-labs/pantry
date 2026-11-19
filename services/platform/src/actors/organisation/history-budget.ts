import type { SessionId, OrganisationId } from "../../ids";
import type {
  OrganisationHarnessHistoryBudgetWarning,
  RecordOrganisationHarnessHistoryBudgetWarningInput,
} from "./types";

export function validHistoryBudgetWarning(
  input: RecordOrganisationHarnessHistoryBudgetWarningInput,
): boolean {
  return (
    Number.isSafeInteger(input.entryCount) &&
    input.entryCount >= 0 &&
    Number.isSafeInteger(input.inlineBytes) &&
    input.inlineBytes >= 0 &&
    Number.isSafeInteger(input.warningAt) &&
    input.warningAt >= 0
  );
}

export function readOrganisationHarnessHistoryBudgetWarning(
  sql: SqlStorage,
  organisationId: OrganisationId,
  sessionId: SessionId,
): OrganisationHarnessHistoryBudgetWarning | null {
  const row = sql
    .exec<{
      organisation_id: string;
      session_id: string;
      entry_count: number;
      inline_bytes: number;
      hard_limit: number;
      warning_at: number;
      updated_at: number;
    }>(
      `SELECT organisation_id, session_id, entry_count, inline_bytes, hard_limit,
            warning_at, updated_at
       FROM organisation_harness_history_budget_warning
      WHERE organisation_id = ? AND session_id = ?
      LIMIT 1`,
      organisationId,
      sessionId,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.organisation_id !== organisationId ||
    row.session_id !== sessionId ||
    !Number.isSafeInteger(row.entry_count) ||
    !Number.isSafeInteger(row.inline_bytes) ||
    (row.hard_limit !== 0 && row.hard_limit !== 1) ||
    !Number.isSafeInteger(row.warning_at) ||
    !Number.isSafeInteger(row.updated_at)
  ) {
    return null;
  }
  return {
    organisationId,
    sessionId,
    entryCount: row.entry_count,
    inlineBytes: row.inline_bytes,
    hardLimit: row.hard_limit === 1,
    warningAt: row.warning_at,
    updatedAt: row.updated_at,
  };
}
