import { nextAbandonedCueClaimAt } from "@purin-labs/agent/actors/cue-delivery";
import { readSocketSweepDueAt } from "@purin-labs/actor-runtime/actors/hibernatable-sockets";
import type { AlarmReconciler } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import { nextJevUsageAt } from "../jev-features/usage-records";
import { parseOrganisationId } from "@purin-labs/kernel/ids";

/** How often the Organisation retries stored work that waits. */
const ORGANISATION_RETRY_MS = 30_000;

/**
 * The Organisation's alarm reconcilers. Each reads its own rows: action and
 * Code Mode leases, abandoned Cue claims, Case context invalidations,
 * credential cleanups and the socket sweep. `nextLeaseDeadline` reads the
 * action and Code Mode leases.
 */
export function organisationAlarmReconcilers(
  sql: SqlStorage,
  nextLeaseDeadline: () => number | null,
): readonly AlarmReconciler[] {
  return [
    { name: "leases", nextDue: nextLeaseDeadline },
    { name: "cue_claims", nextDue: () => nextAbandonedCueClaimAt(sql) },
    {
      name: "case_context_invalidations",
      nextDue: (now) =>
        hasRow(
          sql,
          "SELECT 1 FROM case_context_collection_invalidation WHERE pending = 1 LIMIT 1",
        )
          ? now + ORGANISATION_RETRY_MS
          : null,
    },
    {
      name: "credential_cleanup",
      nextDue: (now) =>
        hasRow(sql, "SELECT 1 FROM typesafe_credential_cleanup LIMIT 1")
          ? now + ORGANISATION_RETRY_MS
          : null,
    },
    { name: "socket_sweep", nextDue: () => readSocketSweepDueAt(sql) },
    { name: "jev_usage", nextDue: () => jevUsageDueAt(sql) },
  ];
}

/** Plan 88: the next closed hour of Jev use to seal, or a record to retry. */
function jevUsageDueAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM organisation_meta LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return null;
  const organisationId = parseOrganisationId(row.organisation_id);
  return organisationId.ok ? nextJevUsageAt(sql, organisationId.value) : null;
}

function hasRow(sql: SqlStorage, query: string): boolean {
  return sql.exec(query).toArray().length > 0;
}
