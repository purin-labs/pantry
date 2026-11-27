import type { IntegrationCredentialReads } from "@purin-labs/authority/credential-vault/integration-reads";

// The reads of the Integrations records that the Vault makes before it gives
// a secret or raises an alert (Refactor 17). The Worker registers them
// (`worker-ports.ts`). Each one is one D1 read and writes nothing.

export const INTEGRATION_CREDENTIAL_READS: IntegrationCredentialReads = {
  async accountRemovalCleanupHoldsHandle(db, cleanup) {
    const active = await db
      .prepare(
        `SELECT cleanup.cleanup_id AS cleanupId
       FROM provider_account_cleanup AS cleanup
       WHERE cleanup.cleanup_id = ?
         AND cleanup.organisation_id = ?
         AND cleanup.integration_account_id = ?
         AND cleanup.provider = ?
         AND cleanup.environment = ?
         AND cleanup.provider_account_id = ?
         AND cleanup.provider_connection_id = ?
         AND cleanup.lifecycle IN (
           'pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled'
         )
         AND EXISTS (
           SELECT 1
           FROM json_each(cleanup.credential_handles)
           WHERE json_each.value = ?
         )
       LIMIT 1`,
      )
      .bind(
        cleanup.cleanupId,
        cleanup.organisationId,
        cleanup.integrationAccountId,
        cleanup.provider,
        cleanup.environment,
        cleanup.providerAccountId,
        cleanup.providerConnectionId,
        cleanup.handle,
      )
      .first<{ readonly cleanupId: unknown }>();
    return active?.cleanupId === cleanup.cleanupId;
  },

  async countStuckCredentialRotations(db, createdBefore) {
    const stuckRotations = await db
      .prepare(
        `SELECT COUNT(*) AS stuckCount FROM credential_rotation
       WHERE status IN ('pending_verification', 'verified') AND created_at < ?`,
      )
      .bind(createdBefore)
      .first<{ readonly stuckCount: number }>();
    return stuckRotations?.stuckCount ?? 0;
  },

  async countFailedCredentialRotations(db, createdSince) {
    const failedRotations = await db
      .prepare(
        `SELECT COUNT(*) AS failedCount FROM credential_rotation
       WHERE status = 'failed' AND created_at >= ?`,
      )
      .bind(createdSince)
      .first<{ readonly failedCount: number }>();
    return failedRotations?.failedCount ?? 0;
  },

  async discordInstallHoldsPublicKey(db, install) {
    const active = await db
      .prepare(
        `SELECT installation.public_key_ref AS publicKeyRef
       FROM discord_interaction_install AS installation
       JOIN organisation
         ON organisation.organisation_id = installation.organisation_id
        AND organisation.status = 'active'
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = installation.organisation_id
        AND onboarding.lifecycle = 'active'
       WHERE installation.organisation_id = ?
         AND installation.application_id = ?
         AND installation.guild_id = ?
         AND installation.public_key_ref = ?
         AND installation.status = 'active'
       LIMIT 1`,
      )
      .bind(
        install.organisationId,
        install.applicationId,
        install.guildId,
        install.publicKeyRef,
      )
      .first<{ readonly publicKeyRef: unknown }>();
    return active?.publicKeyRef === install.publicKeyRef;
  },
};
