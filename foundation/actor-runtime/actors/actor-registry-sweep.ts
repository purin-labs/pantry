/**
 * The 15-minute run of the Actor registry reconciler (Refactor 15,
 * refactor 5). A request that stopped between an Actor's reservation and its
 * activation leaves a `reserved` registry entry, and a reserved entry holds
 * the regional freeze of every placement move (`regionalFreezeReadiness`).
 * Before this run only the operator's `reconcile_reserved` command cleared
 * one. The run reconciles each Organisation that has a reservation older
 * than `ACTOR_RESERVATION_STALE_MS`: the reconciler activates the Actor, or
 * quarantines its entry when the activation conflicts. A quarantined entry no
 * longer holds a move; the relocation leaves it out with a receipt.
 */
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, parseOrganisationId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { reconcileOrganisationActorRegistry } from "./actor-registry-reconciliation";

/** A reservation is stale after one scheduled period with no activation. */
const ACTOR_RESERVATION_STALE_MS = 15 * 60_000;

/** The Organisations that one run reconciles in each database. */
const ORGANISATION_PAGE = 50;

export async function runScheduledActorRegistryReconciliation(
  env: Env,
  now: number,
): Promise<void> {
  for (const database of configuredOrganisationDatabases(env)) {
    let organisations: readonly unknown[];
    try {
      organisations = await staleReservationOrganisations(database, now);
    } catch {
      traceWarn("actor_registry.reserved_sweep_read_failed", {
        requestId: newRequestId(),
      });
      continue;
    }
    for (const value of organisations) {
      if (typeof value !== "string") continue;
      const organisationId = parseOrganisationId(value);
      if (!organisationId.ok) continue;
      try {
        const scope = await OrganisationExecutionScope.resolve(
          env,
          organisationId.value,
        );
        // Another database owns this Organisation and runs its sweep itself.
        // An Organisation with no active placement is in a move; the move's
        // own steps own its registry until it publishes or is abandoned.
        if (!scope.ok || scope.value.database !== database) continue;
        const reconciled = await reconcileOrganisationActorRegistry({
          db: scope.value.database,
          namespaces: {
            organisation: env.ORGANISATION,
            session: env.SESSION,
            case: env.CASE,
            connector: env.CONNECTOR,
          },
          organisationId: organisationId.value,
          now,
          staleReservationAgeMs: ACTOR_RESERVATION_STALE_MS,
        });
        if (!reconciled.ok)
          traceWarn("actor_registry.reserved_sweep_refused", {
            requestId: newRequestId(),
            organisation_id: organisationId.value,
            error_code: reconciled.error.code,
          });
      } catch {
        traceWarn("actor_registry.reserved_sweep_failed", {
          requestId: newRequestId(),
          organisation_id: organisationId.value,
        });
      }
    }
  }
}

async function staleReservationOrganisations(
  database: OrganisationDatabase,
  now: number,
): Promise<readonly unknown[]> {
  const rows = await database
    .prepare(
      `SELECT DISTINCT organisation_id AS organisationId FROM durable_object_registry
       WHERE lifecycle_status = 'reserved' AND reserved_at <= ?
       ORDER BY organisation_id LIMIT ?`,
    )
    .bind(now - ACTOR_RESERVATION_STALE_MS, ORGANISATION_PAGE)
    .all<{ organisationId: unknown }>();
  return rows.results.map((row) => row.organisationId);
}
