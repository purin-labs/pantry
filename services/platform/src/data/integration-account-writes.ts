// The writes of the tables `integration_account` and `provider_webhook` (the
// webhooks of an account) that other modules put into their own batch (Refactor 17: only the owner of a table writes it). Each
// statement keeps the text and the values of the site that it came from.
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import {
  purgeGuarded,
  type OrganisationPurgeContext,
} from "./organisation-lifecycle-port";

type Database = OrganisationDatabase | OrganisationDatabaseSession;

/** Adds the active account of a new custom connector connection. */
export function prepareCustomConnectorAccountInsert(
  db: Database,
  input: Readonly<{
    integrationAccountId: string;
    organisationId: string;
    connectorId: string;
    providerConnectionId: string;
    providerAccountId: string;
    displayName: string;
    capabilitySet: string;
    now: number;
    environment: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO integration_account (
             integration_account_id, organisation_id, source_kind, custom_connector_id,
             provider_connection_id, provider, provider_account_id, account_kind,
             display_name, lifecycle, lifecycle_reason_code, capability_set,
             audience_policy, retention_policy, created_at, updated_at,
             disabled_by_user_id, disabled_at, revoked_at,
             environment, is_default_for_provider
           ) VALUES (
             ?, ?, 'custom_api', ?, ?, 'custom_api', ?, 'api_account', ?,
             'active', NULL, ?, '{"kind":"operator"}',
             '{"kind":"organisation_default"}', ?, ?, NULL, NULL, NULL, ?, 0
           )`,
    )
    .bind(
      input.integrationAccountId,
      input.organisationId,
      input.connectorId,
      input.providerConnectionId,
      input.providerAccountId,
      input.displayName,
      input.capabilitySet,
      input.now,
      input.now,
      input.environment,
    );
}

/** Makes a custom connector account active again after a credential rotation. */
export function prepareCustomConnectorAccountRotation(
  db: Database,
  input: Readonly<{
    displayName: string;
    capabilitySet: string;
    now: number;
    organisationId: string;
    integrationAccountId: string;
    connectorId: string;
    providerConnectionId: string;
    providerAccountId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
           SET display_name = ?, lifecycle = 'active', lifecycle_reason_code = NULL,
               capability_set = ?, updated_at = ?,
               disabled_by_user_id = NULL, disabled_at = NULL,
               revoked_at = NULL
           WHERE organisation_id = ? AND integration_account_id = ?
             AND source_kind = 'custom_api' AND custom_connector_id = ?
             AND provider_connection_id = ? AND provider_account_id = ?
             AND lifecycle != 'revoked'`,
    )
    .bind(
      input.displayName,
      input.capabilitySet,
      input.now,
      input.organisationId,
      input.integrationAccountId,
      input.connectorId,
      input.providerConnectionId,
      input.providerAccountId,
    );
}

/** Disables the live accounts of a custom connector. */
export function prepareCustomConnectorAccountsDisable(
  db: Database,
  input: Readonly<{
    disabledByUserId: string;
    now: number;
    organisationId: string;
    connectorId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
         SET lifecycle = 'disabled', disabled_by_user_id = ?,
             disabled_at = ?, updated_at = ?
         WHERE organisation_id = ? AND custom_connector_id = ? AND source_kind = 'custom_api'
           AND lifecycle IN ('active', 'degraded', 'reauth_required')`,
    )
    .bind(
      input.disabledByUserId,
      input.now,
      input.now,
      input.organisationId,
      input.connectorId,
    );
}

/**
 * Moves the default of a provider from a revoked account to its replacement:
 * the first statement clears the old default, the second sets the new one.
 */
export function prepareDefaultAccountReplacement(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    revokedIntegrationAccountId: string;
    replacementIntegrationAccountId: string;
  }>,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE integration_account
           SET is_default_for_provider = 0, updated_at = ?
           WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(input.now, input.organisationId, input.revokedIntegrationAccountId),
    db
      .prepare(
        `UPDATE integration_account
           SET is_default_for_provider = 1, updated_at = ?
           WHERE organisation_id = ? AND integration_account_id = ?
             AND lifecycle = 'active'`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.replacementIntegrationAccountId,
      ),
  ];
}

/** Moves an account to the lifecycle that a provider observation found. */
export function prepareObservedAccountLifecycle(
  db: Database,
  input: Readonly<{
    lifecycle: "degraded" | "active";
    lifecycleReasonCode: string | null;
    now: number;
    organisationId: string;
    integrationAccountId: string;
    currentLifecycle: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
       SET lifecycle = ?, lifecycle_reason_code = ?, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = ?`,
    )
    .bind(
      input.lifecycle,
      input.lifecycleReasonCode,
      input.now,
      input.organisationId,
      input.integrationAccountId,
      input.currentLifecycle,
    );
}

/**
 * Revokes a removed account and replaces its provider account id with a
 * hash. Only a disabled account that is not the default changes.
 */
export function prepareRemovedAccountPseudonymization(
  db: Database,
  input: Readonly<{
    providerAccountHash: string;
    now: number;
    organisationId: string;
    integrationAccountId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
       SET provider_account_id = ?, display_name = 'Removed account',
           lifecycle = 'revoked', lifecycle_reason_code = NULL,
           capability_set = '[]', is_default_for_provider = 0,
           disabled_by_user_id = NULL, disabled_at = NULL,
           revoked_at = ?, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = 'disabled' AND is_default_for_provider = 0`,
    )
    .bind(
      `removed:${input.providerAccountHash}`,
      input.now,
      input.now,
      input.organisationId,
      input.integrationAccountId,
    );
}

/** Makes the accounts that wait for the activation active. */
export function preparePendingAccountsActivation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account SET lifecycle = 'active', lifecycle_reason_code = NULL,
         updated_at = ? WHERE organisation_id = ? AND lifecycle = 'pending_activation'`,
    )
    .bind(input.now, input.organisationId);
}

/**
 * Makes the oldest active account the default of each provider and
 * environment that has no default.
 */
export function prepareFirstActiveAccountDefaults(
  db: Database,
  input: Readonly<{ now: number; organisationId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
       SET is_default_for_provider = 1, updated_at = ?
       WHERE organisation_id = ? AND lifecycle = 'active' AND is_default_for_provider = 0
         AND integration_account_id = (
           SELECT candidate.integration_account_id
           FROM integration_account AS candidate
           WHERE candidate.organisation_id = integration_account.organisation_id
             AND candidate.provider = integration_account.provider
             AND candidate.environment = integration_account.environment
             AND candidate.lifecycle = 'active'
           ORDER BY candidate.created_at, candidate.integration_account_id
           LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM integration_account AS current_default
           WHERE current_default.organisation_id = integration_account.organisation_id
             AND current_default.provider = integration_account.provider
             AND current_default.environment = integration_account.environment
             AND current_default.is_default_for_provider = 1
         )`,
    )
    .bind(input.now, input.organisationId);
}

/**
 * Degrades the active accounts that match `predicate`, an SQL condition on
 * `integration_account` with no values.
 */
export function prepareInvalidAccountsDegradation(
  db: Database,
  input: Readonly<{
    predicate: string;
    reasonCode: string;
    now: number;
    organisationId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
     SET lifecycle = 'degraded', lifecycle_reason_code = ?, updated_at = ?
     WHERE organisation_id = ? AND lifecycle = 'active' AND (${input.predicate})`,
    )
    .bind(input.reasonCode, input.now, input.organisationId);
}

/**
 * Makes the active account with the smallest id the default of each provider
 * and environment that has no default.
 */
export function prepareMissingAccountDefaults(
  db: Database,
  input: Readonly<{ now: number; organisationId: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
     SET is_default_for_provider = 1, updated_at = ?
     WHERE organisation_id = ? AND lifecycle = 'active' AND is_default_for_provider = 0
       AND integration_account_id IN (
         SELECT MIN(candidate.integration_account_id)
         FROM integration_account AS candidate
         WHERE candidate.organisation_id = ? AND candidate.lifecycle = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM integration_account AS current_default
             WHERE current_default.organisation_id = candidate.organisation_id
               AND current_default.provider = candidate.provider
               AND current_default.environment = candidate.environment
               AND current_default.is_default_for_provider = 1
           )
         GROUP BY candidate.provider, candidate.environment
       )`,
    )
    .bind(input.now, input.organisationId, input.organisationId);
}

/** Revokes the live accounts whose connection holds a revoked credential. */
export function prepareCredentialHandleAccountsRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; handle: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
         SET lifecycle = 'revoked', lifecycle_reason_code = NULL,
             is_default_for_provider = 0,
             disabled_by_user_id = NULL, disabled_at = NULL,
             revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE organisation_id = ?
           AND provider_connection_id IN (
             SELECT provider_connection_id
             FROM provider_connection
             WHERE organisation_id = ? AND credential_ref = ?
           )
           AND lifecycle != 'revoked'`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.organisationId,
      input.handle,
    );
}

/** Revokes a disconnected account. */
export function prepareDisconnectedAccountRevocation(
  db: Database,
  input: Readonly<{
    now: number;
    organisationId: string;
    integrationAccountId: string;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account SET lifecycle = 'revoked', lifecycle_reason_code = NULL,
         updated_at = ?, revoked_at = ?, disabled_at = NULL, disabled_by_user_id = NULL
         WHERE organisation_id = ? AND integration_account_id = ? AND lifecycle != 'revoked'`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.integrationAccountId,
    );
}

/**
 * Revokes the live webhooks that a revoked credential signs, or that belong
 * to an account whose connection holds it.
 */
export function prepareCredentialHandleWebhooksRevocation(
  db: Database,
  input: Readonly<{ now: number; organisationId: string; handle: string }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_webhook
         SET lifecycle = 'revoked', lifecycle_reason_code = NULL, updated_at = ?
         WHERE organisation_id = ?
           AND (
             signing_secret_ref = ? OR
             integration_account_id IN (
               SELECT account.integration_account_id
               FROM integration_account AS account
               JOIN provider_connection AS connection
                 ON connection.provider_connection_id = account.provider_connection_id
                AND connection.organisation_id = account.organisation_id
               WHERE account.organisation_id = ? AND connection.credential_ref = ?
             )
           )
           AND lifecycle != 'revoked'`,
    )
    .bind(
      input.now,
      input.organisationId,
      input.handle,
      input.organisationId,
      input.handle,
    );
}

/** Deletes the webhooks of a removed account. */
export function prepareRemovedAccountWebhooksDelete(
  db: Database,
  integrationAccountId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM provider_webhook
       WHERE integration_account_id = ?`,
    )
    .bind(integrationAccountId);
}

/**
 * The archive of an Organisation disables each account that is not disabled
 * or revoked, while the guard holds.
 */
export function prepareArchivedOrganisationAccountsDisable(
  db: Database,
  input: Readonly<{
    organisationId: string;
    actorUserId: string;
    now: number;
    guard: Readonly<{ sql: string; bindings: readonly unknown[] }>;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_account
       SET lifecycle = 'disabled', lifecycle_reason_code = NULL,
           disabled_by_user_id = ?, disabled_at = ?,
           revoked_at = NULL, is_default_for_provider = 0, updated_at = ?
       WHERE organisation_id = ? AND lifecycle NOT IN ('disabled', 'revoked') AND ${input.guard.sql}`,
    )
    .bind(
      input.actorUserId,
      input.now,
      input.now,
      input.organisationId,
      ...input.guard.bindings,
    );
}

/** The archive of an Organisation disables each webhook that is not revoked. */
export function prepareArchivedOrganisationWebhooksDisable(
  db: Database,
  input: Readonly<{
    organisationId: string;
    now: number;
    guard: Readonly<{ sql: string; bindings: readonly unknown[] }>;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_webhook
       SET lifecycle = 'disabled', lifecycle_reason_code = NULL,
           last_verified_at = NULL, updated_at = ?
       WHERE organisation_id = ? AND lifecycle != 'revoked' AND ${input.guard.sql}`,
    )
    .bind(input.now, input.organisationId, ...input.guard.bindings);
}

/** The purge deletes the custom accounts and pseudonymizes the others. */
export function prepareOrganisationPurgeAccounts(
  context: OrganisationPurgeContext,
): D1PreparedStatement[] {
  return [
    purgeGuarded(
      context,
      "DELETE FROM integration_account WHERE organisation_id = ? AND source_kind = 'custom_api'",
    ),
    ...context.accounts.map((account) =>
      context.session
        .prepare(
          `UPDATE integration_account
           SET provider_account_id = ?, display_name = 'Archived account',
               lifecycle = 'revoked', lifecycle_reason_code = NULL,
               capability_set = '[]', is_default_for_provider = 0,
               disabled_by_user_id = NULL, disabled_at = NULL,
               revoked_at = ?, updated_at = ?
           WHERE integration_account_id = ? AND ${context.purged.sql}`,
        )
        .bind(
          `archived:${account.providerAccountHash}`,
          context.now,
          context.now,
          account.id,
          ...context.purged.bindings,
        ),
    ),
  ];
}
