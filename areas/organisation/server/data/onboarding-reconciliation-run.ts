// The writes of the table `onboarding_reconciliation_run` that another module
// puts into its own batch (Refactor 17: only the owner of a table writes it).
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { EmailWatchReconciliationRun } from "@purin-labs/area-organisation-contract/server/organisation-services";

/** Records a finished run of the email watch reconciliation. */
export function prepareEmailWatchReconciliationRun(
  db: OrganisationDatabase,
  input: EmailWatchReconciliationRun,
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
