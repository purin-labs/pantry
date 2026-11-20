// The writes of the table `onboarding_reconciliation_run` that another module
// puts into its own batch (Refactor 17: only the owner of a table writes it).
import type { OrganisationDatabase } from "../database-handles";

/** Records a finished run of the email watch reconciliation. */
export function prepareEmailWatchReconciliationRun(
  db: OrganisationDatabase,
  input: Readonly<{
    reconciliationRunId: string;
    organisationId: string;
    environment: string;
    lifecycle: "completed" | "failed";
    repairCount: number;
    reasonCode: string | null;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO onboarding_reconciliation_run (
       reconciliation_run_id, organisation_id, environment, subject_kind,
       lifecycle, repair_count, reason_code, started_at, completed_at
     ) VALUES (?, ?, ?, 'email_watches', ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.reconciliationRunId,
      input.organisationId,
      input.environment,
      input.lifecycle,
      input.repairCount,
      input.reasonCode,
      input.now,
      input.now,
    );
}
