// The read of the purge of an Organisation (Refactor 17: tenancy reads no
// table of connections): the accounts and the connections that the purge
// batch pseudonymizes, each with the hash of its provider identity. It keeps
// the two queries, their order and their errors from tenancy.
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { hashOpaqueSecret } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationPurgeSubjects } from "@purin-labs/tenancy/data/organisation-lifecycle-port";

export async function readOrganisationPurgeSubjects(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationPurgeSubjects> {
  const accounts = await db
    .prepare(
      `SELECT integration_account_id AS id, provider_account_id AS providerAccountId
       FROM integration_account
       WHERE organisation_id = ? AND source_kind != 'custom_api'`,
    )
    .bind(organisationId)
    .all<{ readonly id: unknown; readonly providerAccountId: unknown }>();
  const connections = await db
    .prepare(
      `SELECT provider_connection_id AS id, provider_subject_id AS providerSubjectId
       FROM provider_connection
       WHERE organisation_id = ? AND source_kind != 'custom_api'`,
    )
    .bind(organisationId)
    .all<{ readonly id: unknown; readonly providerSubjectId: unknown }>();
  return {
    accounts: await Promise.all(
      accounts.results.map(async (row) => ({
        id: requireString(row.id, "purged account id"),
        providerAccountHash: await hashOpaqueSecret(
          requireString(row.providerAccountId, "purged provider account id"),
        ),
      })),
    ),
    connections: await Promise.all(
      connections.results.map(async (row) => ({
        id: requireString(row.id, "purged connection id"),
        providerSubjectHash: await hashOpaqueSecret(
          requireString(row.providerSubjectId, "purged provider subject"),
        ),
      })),
    ),
  };
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new Error(`${field} is invalid`);
  return raw;
}
