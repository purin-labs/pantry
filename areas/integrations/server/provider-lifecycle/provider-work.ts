/**
 * The reads of the provider work that holds a relocation (Refactor 17):
 * the connection attempts in flight and the provider cleanups. The Worker
 * registers them for the Actor runtime (`worker-ports.ts`).
 */
import type { ProviderWorkReads } from "@purin-labs/actor-runtime/data/provider-work-reads";

export const PROVIDER_WORK_READS: ProviderWorkReads = {
  pendingOperation: (db, organisationId) =>
    db
      .prepare(
        `SELECT attempt_id AS operationId FROM provider_connection_attempt
    WHERE organisation_id = ? AND lifecycle IN ('callback_received', 'provisioning')
    UNION ALL SELECT cleanup_id AS operationId FROM provider_account_cleanup
    WHERE organisation_id = ? AND lifecycle = 'running_provider_cleanup' LIMIT 1`,
      )
      .bind(organisationId, organisationId)
      .first<{ operationId: string }>(),
  unresolved: async (db, organisationId) =>
    (await db
      .prepare(
        `SELECT 1 FROM provider_account_cleanup
    WHERE organisation_id = ? AND lifecycle NOT IN ('completed', 'manual_action_required')
    UNION ALL SELECT 1 FROM provider_connection_attempt
    WHERE organisation_id = ? AND lifecycle IN ('callback_received', 'provisioning') LIMIT 1`,
      )
      .bind(organisationId, organisationId)
      .first()) !== null,
};
