// The writes of the table `cue_log` (Refactor 17: only the owner of a table
// writes it). The cue module owns the log of each cue decision. Each
// statement keeps the text of the site that it came from.
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

/** Adds the log entry of one cue decision. An entry that exists stays. */
export function prepareCueLogEntry(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string | null;
    cueId: string;
    source: string;
    nativeId: string;
    decision: "matched" | "store_only" | "proposed";
    reason: string | null;
    at: number;
    parentCueId: string | null;
    surfaceKind: string | null;
    surfaceThreadId: string | null;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO cue_log (
         organisation_id, integration_account_id, cue_id, source, native_id,
         decision, reason, at, parent_cue_id, surface_kind, surface_thread_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.cueId,
      input.source,
      input.nativeId,
      input.decision,
      input.reason,
      input.at,
      input.parentCueId,
      input.surfaceKind,
      input.surfaceThreadId,
    );
}

/** Deletes the commerce cue entries whose native id starts with `prefix`. */
export function prepareCommerceCueLogDelete(
  db: OrganisationDatabase,
  input: Readonly<{ organisationId: string; prefix: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM cue_log
     WHERE organisation_id = ? AND source = 'commerce'
       AND substr(native_id, 1, length(?)) = ?`,
    )
    .bind(input.organisationId, input.prefix, input.prefix);
}
