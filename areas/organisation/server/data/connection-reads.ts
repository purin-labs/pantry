import type { OrganisationConnectionReads } from "@purin-labs/connections/data/organisation-reads";

// The reads of the Organisation records that a connection flow of the
// connections module makes (Refactor 17). The Worker registers them
// (`worker-ports.ts`). Each one is one D1 read and writes nothing.

export const ORGANISATION_CONNECTION_READS: OrganisationConnectionReads = {
  async communicationDestinationIsConfigured(db, organisationId) {
    const configuredDestination = await db
      .prepare(
        `SELECT 1 AS configured FROM organisation_communication_destination WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<{ readonly configured: unknown }>();
    return configuredDestination !== null;
  },

  async accountReachesCommunicationDestination(
    db,
    organisationId,
    integrationAccountId,
  ) {
    const destination = await db
      .prepare(
        `SELECT 1 AS capable
       FROM organisation_communication_destination AS destination
       JOIN surface_installation AS surface
         ON surface.integration_account_id = ?
        AND surface.workspace_id = destination.workspace_id
       JOIN provider_resource_snapshot AS snapshot
         ON snapshot.organisation_id = destination.organisation_id
        AND snapshot.integration_account_id = ?
       JOIN provider_discovered_resource AS resource
         ON resource.snapshot_revision = snapshot.snapshot_revision
        AND resource.canonical_resource_id = destination.channel_id
        AND resource.access_state = 'accessible'
       WHERE destination.organisation_id = ?
       ORDER BY snapshot.created_at DESC
       LIMIT 1`,
      )
      .bind(integrationAccountId, integrationAccountId, organisationId)
      .first<{ readonly capable: unknown }>();
    return destination?.capable === 1;
  },

  async currentProviderManifestVersion(
    manifestDatabase,
    provider,
    environment,
  ) {
    const row = await manifestDatabase
      .prepare(
        `SELECT manifest_version AS version FROM provider_manifest
     WHERE provider = ? AND environment = ? ORDER BY manifest_version DESC LIMIT 1`,
      )
      .bind(provider, environment)
      .first<{ readonly version: unknown }>();
    if (row === null) return null;
    if (
      typeof row.version !== "number" ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1
    ) {
      throw new Error("provider_manifest_version_invalid");
    }
    return row.version;
  },
};
