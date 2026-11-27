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
