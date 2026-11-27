// The stored work of the Organisation actor that sets its alarm: the action
// and Code Mode leases, the abandoned Cue claims, the Case context
// invalidations, the credential cleanups and the socket sweep. Each reads
// its own rows. The Organisation actor adds the reconcilers of the areas.
import {
  expireDueActionExecutions,
  readNextActionExecutionLeaseDeadline,
} from "@purin-labs/authority/actors/action-ledger";
import { readSocketSweepDueAt } from "@purin-labs/actor-runtime/actors/hibernatable-sockets";
import type { AlarmReconciler } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { readOrganisationMetaRow } from "@purin-labs/tenancy/actors/organisation/organisation-record";
import {
  expireCodeModeOrganisationReservations,
  readNextCodeModeOrganisationAlarmAt,
} from "./code-mode-budget";
import {
  expireAbandonedCueClaims,
  nextAbandonedCueClaimAt,
} from "./cue-delivery";

/** How often the Organisation retries stored work that waits. */
const ORGANISATION_RETRY_MS = 30_000;

/** The Organisation's alarm reconcilers of the foundation. */
export function organisationAlarmReconcilers(
  sql: SqlStorage,
): readonly AlarmReconciler[] {
  return [
    { name: "leases", nextDue: () => readNextOrganisationAlarmAt(sql) },
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
  ];
}

/** The lease step of the alarm: it ends the leases that are past their time. */
export function expireOrganisationLeases(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): void {
  expireDueActionExecutions(sql, organisationId, now);
  expireCodeModeOrganisationReservations(sql, now);
  expireAbandonedCueClaims(sql, organisationId, now);
}

/** The next end of an action lease or a Code Mode lease, or null. */
function readNextOrganisationAlarmAt(sql: SqlStorage): number | null {
  const actionAt = readNextActionExecutionLeaseDeadline(
    sql,
    requireOrganisationMetaId(sql),
  );
  const codeModeAt = readNextCodeModeOrganisationAlarmAt(sql);
  if (actionAt === null) return codeModeAt;
  if (codeModeAt === null) return actionAt;
  return Math.min(actionAt, codeModeAt);
}

function requireOrganisationMetaId(sql: SqlStorage): OrganisationId {
  const organisation = readOrganisationMetaRow(sql);
  if (organisation === undefined) throw new Error("organisation_meta_missing");
  const organisationId = parseOrganisationId(organisation.organisation_id);
  if (!organisationId.ok) throw new Error("organisation_meta_identity_invalid");
  return organisationId.value;
}

function hasRow(sql: SqlStorage, query: string): boolean {
  return sql.exec(query).toArray().length > 0;
}
