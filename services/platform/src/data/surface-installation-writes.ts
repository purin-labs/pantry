// The writes of the table `surface_installation` that other modules put into
// their own batch (Refactor 17: only the owner of a table writes it). Each
// statement keeps the text and the values of the site that it came from.
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";

type Database = OrganisationDatabase | OrganisationDatabaseSession;

/** Adds the installation of an account, or replaces the one that it has. */
export function prepareSurfaceInstallationUpsert(
  db: Database,
  input: Readonly<{
    integrationAccountId: string;
    organisationId: string;
    surfaceKind: string;
    workspaceId: string;
    installModel: string;
    botTokenRef: string;
    scopes: string;
    installedAt: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO surface_installation (
         integration_account_id, organisation_id, surface_kind, workspace_id, install_model,
         bot_token_ref, scopes, installed_at, last_event_received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (integration_account_id) DO UPDATE SET
         surface_kind = excluded.surface_kind, workspace_id = excluded.workspace_id,
         install_model = excluded.install_model, bot_token_ref = excluded.bot_token_ref,
         scopes = excluded.scopes, installed_at = excluded.installed_at`,
    )
    .bind(
      input.integrationAccountId,
      input.organisationId,
      input.surfaceKind,
      input.workspaceId,
      input.installModel,
      input.botTokenRef,
      input.scopes,
      input.installedAt,
    );
}

/** Deletes the installation of a disabled account of the Organisation. */
export function prepareDisabledAccountInstallationDelete(
  db: Database,
  input: Readonly<{ organisationId: string; integrationAccountId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM surface_installation
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId);
}

/** Deletes the installation of a removed account. */
export function prepareRemovedAccountInstallationDelete(
  db: Database,
  integrationAccountId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM surface_installation
       WHERE integration_account_id = ?`,
    )
    .bind(integrationAccountId);
}
