import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import { parseVaultHandle, type VaultHandle } from "../credential-vault";
import {
  parseIntegrationAccountId,
  parseProviderConnectionId,
  type UserId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  prepareOnboardingEvent,
} from "./control-mutation";
import {
  connectionCredentialAuthority,
  integrationAccountAllowsCredentialMutation,
  parseIntegrationProvider,
  providerConnectionAllowsCredentialMutation,
  readAccountMutationState,
  resolveDisableReplacement,
  resolveIntegrationAccount,
  resolveProviderConnection,
  type ConnectionCredentialAuthority,
  type IntegrationAccount,
  type IntegrationAccountMutation,
  type ProviderConnection,
} from "./integration-account";
import { prepareConfigurationVersionBump } from "./organisation-onboarding-row";
import { prepareActiveCredentialGeneration } from "./provider-credential-generation";

const CREDENTIAL_ROTATION_FAILURE_CODES = [
  "replacement_environment_mismatch",
  "replacement_identity_mismatch",
  "replacement_validation_failed",
  "replacement_store_failed",
  "policy_activation_failed",
] as const;

export type CredentialRotationFailureCode =
  (typeof CREDENTIAL_ROTATION_FAILURE_CODES)[number];

type CredentialGenerationInventory = {
  readonly credentialGeneration: number;
  readonly lifecycle: "staged" | "active" | "superseded" | "revoked" | "failed";
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly activatedAt: number | null;
  readonly supersededAt: number | null;
  readonly revokedAt: number | null;
  readonly vault:
    | {
        readonly status: "active" | "revoked";
        readonly keyVersion: string;
        readonly storedAt: number;
        readonly rotatedAt: number | null;
        readonly revokedAt: number | null;
      }
    | { readonly status: "missing" };
};

type CredentialWebhookInventory = {
  readonly lifecycle: "pending" | "live" | "degraded" | "disabled" | "revoked";
  readonly eventType: string;
  readonly credentialGeneration: number;
  readonly lastVerifiedAt: number | null;
};

type CredentialRotationInventory = {
  readonly credentialRotationId: string;
  readonly status: "pending_verification" | "verified" | "committed" | "failed";
  readonly expectedGeneration: number;
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly verifiedAt: number | null;
  readonly committedAt: number | null;
};

type CredentialRevocationInventory = {
  readonly state: "committed" | "policy_activated";
  readonly startedAt: number;
  readonly committedAt: number;
  readonly policyActivatedAt: number | null;
  readonly restrictionLatencyMs: number | null;
};

type CredentialAccountInventory = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: IntegrationAccount["provider"];
  readonly environment: IntegrationAccount["environment"];
  readonly displayName: string;
  readonly lifecycle: IntegrationAccount["lifecycle"]["kind"];
  readonly isDefaultForProvider: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly connection: {
    readonly providerConnectionId: ProviderConnectionId;
    readonly lifecycle: ProviderConnection["lifecycle"]["kind"];
    readonly authMode: ProviderConnection["authMode"];
    readonly activeGeneration: number;
    readonly grantedScopes: readonly string[];
  };
  readonly generations: readonly CredentialGenerationInventory[];
  readonly webhooks: readonly CredentialWebhookInventory[];
  readonly rotations: readonly CredentialRotationInventory[];
  readonly revocation: CredentialRevocationInventory | null;
  /** When the current result of the provider health check was first seen. */
  readonly lastManifestObservationAt: number | null;
};

type CredentialInventory = {
  readonly organisationId: OrganisationId;
  readonly accounts: readonly CredentialAccountInventory[];
};

type InventoryRowError = { readonly code: "credential_inventory_row_invalid" };

export async function listCredentialInventory(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<Result<CredentialInventory, InventoryRowError>> {
  const rows = await input.db
    .prepare(
      `SELECT
         account.integration_account_id AS integrationAccountId,
         account.provider AS provider,
         account.environment AS environment,
         account.display_name AS displayName,
         account.lifecycle AS accountLifecycle,
         account.is_default_for_provider AS isDefaultForProvider,
         account.created_at AS accountCreatedAt,
         account.updated_at AS accountUpdatedAt,
         connection.provider_connection_id AS providerConnectionId,
         connection.lifecycle AS connectionLifecycle,
         connection.auth_mode AS authMode,
         connection.credential_generation AS activeGeneration,
         connection.granted_scopes AS grantedScopes,
         generation.credential_generation AS generationNumber,
         generation.credential_ref AS generationCredentialRef,
         generation.lifecycle AS generationLifecycle,
         generation.failure_code AS generationFailureCode,
         generation.created_at AS generationCreatedAt,
         generation.activated_at AS generationActivatedAt,
         generation.superseded_at AS generationSupersededAt,
         generation.revoked_at AS generationRevokedAt,
         secret.key_version AS vaultKeyVersion,
         secret.created_at AS vaultStoredAt,
         secret.rotated_at AS vaultRotatedAt,
         secret.revoked_at AS vaultRevokedAt,
         (CASE WHEN secret.vault_handle IS NULL THEN 0 ELSE 1 END) AS vaultPresent
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
       JOIN provider_credential_generation AS generation
         ON generation.provider_connection_id = connection.provider_connection_id
        AND generation.organisation_id = connection.organisation_id
       LEFT JOIN vault_secret AS secret
         ON secret.organisation_id = generation.organisation_id
        AND secret.vault_handle = generation.credential_ref
       WHERE account.organisation_id = ? AND account.source_kind = 'built_in'
       ORDER BY account.provider, account.display_name,
                account.integration_account_id, generation.credential_generation`,
    )
    .bind(input.organisationId)
    .all<Record<string, unknown>>();

  const webhookRows = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
              lifecycle, event_type AS eventType,
              credential_generation AS credentialGeneration,
              last_verified_at AS lastVerifiedAt
       FROM provider_webhook WHERE organisation_id = ?
       ORDER BY integration_account_id, event_type`,
    )
    .bind(input.organisationId)
    .all<Record<string, unknown>>();

  const rotationRows = await input.db
    .prepare(
      `SELECT credential_rotation_id AS credentialRotationId,
              provider_connection_id AS providerConnectionId,
              status, expected_generation AS expectedGeneration,
              failure_code AS failureCode, created_at AS createdAt,
              verified_at AS verifiedAt, committed_at AS committedAt
       FROM credential_rotation WHERE organisation_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(input.organisationId)
    .all<Record<string, unknown>>();

  const revocationRows = await input.db
    .prepare(
      `SELECT vault_handle AS vaultHandle, state,
              started_at AS startedAt, committed_at AS committedAt,
              policy_activated_at AS policyActivatedAt,
              restriction_latency_ms AS restrictionLatencyMs
       FROM credential_revocation_operation WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .all<Record<string, unknown>>();

  const observationRows = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
              MAX(observed_at) AS observedAt
       FROM provider_manifest_observation WHERE organisation_id = ?
       GROUP BY integration_account_id`,
    )
    .bind(input.organisationId)
    .all<Record<string, unknown>>();

  return assembleCredentialInventory({
    organisationId: input.organisationId,
    rows: rows.results ?? [],
    webhookRows: webhookRows.results ?? [],
    rotationRows: rotationRows.results ?? [],
    revocationRows: revocationRows.results ?? [],
    observationRows: observationRows.results ?? [],
  });
}

function assembleCredentialInventory(input: {
  readonly organisationId: OrganisationId;
  readonly rows: readonly Record<string, unknown>[];
  readonly webhookRows: readonly Record<string, unknown>[];
  readonly rotationRows: readonly Record<string, unknown>[];
  readonly revocationRows: readonly Record<string, unknown>[];
  readonly observationRows: readonly Record<string, unknown>[];
}): Result<CredentialInventory, InventoryRowError> {
  const invalid: Result<CredentialInventory, InventoryRowError> = {
    ok: false,
    error: { code: "credential_inventory_row_invalid" },
  };
  const accounts = new Map<
    string,
    {
      entry: Omit<
        CredentialAccountInventory,
        | "generations"
        | "webhooks"
        | "rotations"
        | "revocation"
        | "lastManifestObservationAt"
      >;
      generations: CredentialGenerationInventory[];
      connectionHandles: Set<string>;
      connectionId: string;
    }
  >();

  for (const row of input.rows) {
    if (
      typeof row.integrationAccountId !== "string" ||
      typeof row.provider !== "string" ||
      typeof row.environment !== "string" ||
      typeof row.displayName !== "string" ||
      typeof row.accountLifecycle !== "string" ||
      typeof row.providerConnectionId !== "string" ||
      typeof row.connectionLifecycle !== "string" ||
      typeof row.authMode !== "string" ||
      typeof row.generationLifecycle !== "string" ||
      typeof row.generationNumber !== "number" ||
      typeof row.generationCreatedAt !== "number" ||
      typeof row.activeGeneration !== "number" ||
      typeof row.grantedScopes !== "string" ||
      typeof row.accountCreatedAt !== "number" ||
      typeof row.accountUpdatedAt !== "number"
    ) {
      return invalid;
    }
    const integrationAccountId = parseIntegrationAccountId(
      row.integrationAccountId,
    );
    const providerConnectionId = parseProviderConnectionId(
      row.providerConnectionId,
    );
    if (
      !integrationAccountId.ok ||
      !providerConnectionId.ok ||
      integrationAccountId.value !== row.integrationAccountId ||
      providerConnectionId.value !== row.providerConnectionId
    ) {
      return invalid;
    }
    const generationLifecycle = parseGenerationLifecycle(
      row.generationLifecycle,
    );
    const accountLifecycle = parseAccountLifecycle(row.accountLifecycle);
    const connectionLifecycle = parseConnectionLifecycle(
      row.connectionLifecycle,
    );
    const authMode = parseAuthMode(row.authMode);
    const environment = parseEnvironment(row.environment);
    const provider = parseProvider(row.provider);
    const scopes = parseScopeList(row.grantedScopes);
    if (
      generationLifecycle === null ||
      accountLifecycle === null ||
      connectionLifecycle === null ||
      authMode === null ||
      environment === null ||
      provider === null ||
      scopes === null
    ) {
      return invalid;
    }
    const key = integrationAccountId.value;
    const existing = accounts.get(key) ?? {
      entry: {
        integrationAccountId: integrationAccountId.value,
        provider,
        environment,
        displayName: row.displayName,
        lifecycle: accountLifecycle,
        isDefaultForProvider:
          row.isDefaultForProvider === 1 || row.isDefaultForProvider === true,
        createdAt: row.accountCreatedAt,
        updatedAt: row.accountUpdatedAt,
        connection: {
          providerConnectionId: providerConnectionId.value,
          lifecycle: connectionLifecycle,
          authMode,
          activeGeneration: row.activeGeneration,
          grantedScopes: scopes,
        },
      },
      generations: [],
      connectionHandles: new Set<string>(),
      connectionId: providerConnectionId.value,
    };
    existing.generations.push({
      credentialGeneration: row.generationNumber,
      lifecycle: generationLifecycle,
      failureCode:
        typeof row.generationFailureCode === "string"
          ? row.generationFailureCode
          : null,
      createdAt: row.generationCreatedAt,
      activatedAt: numberOrNull(row.generationActivatedAt),
      supersededAt: numberOrNull(row.generationSupersededAt),
      revokedAt: numberOrNull(row.generationRevokedAt),
      vault:
        row.vaultPresent === 1 &&
        typeof row.vaultKeyVersion === "string" &&
        typeof row.vaultStoredAt === "number"
          ? {
              status:
                numberOrNull(row.vaultRevokedAt) === null
                  ? "active"
                  : "revoked",
              keyVersion: row.vaultKeyVersion,
              storedAt: row.vaultStoredAt,
              rotatedAt: numberOrNull(row.vaultRotatedAt),
              revokedAt: numberOrNull(row.vaultRevokedAt),
            }
          : { status: "missing" },
    });
    accounts.set(key, existing);
  }

  const webhooksByAccount = new Map<string, CredentialWebhookInventory[]>();
  for (const row of input.webhookRows) {
    if (
      typeof row.integrationAccountId !== "string" ||
      typeof row.lifecycle !== "string" ||
      typeof row.eventType !== "string" ||
      typeof row.credentialGeneration !== "number"
    ) {
      return invalid;
    }
    const integrationAccountId = parseIntegrationAccountId(
      row.integrationAccountId,
    );
    if (
      !integrationAccountId.ok ||
      integrationAccountId.value !== row.integrationAccountId
    ) {
      return invalid;
    }
    const lifecycle = parseWebhookLifecycle(row.lifecycle);
    if (lifecycle === null) {
      return invalid;
    }
    const list = webhooksByAccount.get(integrationAccountId.value) ?? [];
    list.push({
      lifecycle,
      eventType: row.eventType,
      credentialGeneration: row.credentialGeneration,
      lastVerifiedAt: numberOrNull(row.lastVerifiedAt),
    });
    webhooksByAccount.set(integrationAccountId.value, list);
  }

  const rotationsByConnection = new Map<
    string,
    CredentialRotationInventory[]
  >();
  for (const row of input.rotationRows) {
    if (
      typeof row.credentialRotationId !== "string" ||
      typeof row.providerConnectionId !== "string" ||
      typeof row.status !== "string" ||
      typeof row.expectedGeneration !== "number" ||
      typeof row.createdAt !== "number"
    ) {
      return invalid;
    }
    const providerConnectionId = parseProviderConnectionId(
      row.providerConnectionId,
    );
    if (
      !providerConnectionId.ok ||
      providerConnectionId.value !== row.providerConnectionId
    ) {
      return invalid;
    }
    const status = parseRotationStatus(row.status);
    if (status === null) {
      return invalid;
    }
    const list = rotationsByConnection.get(providerConnectionId.value) ?? [];
    list.push({
      credentialRotationId: row.credentialRotationId,
      status,
      expectedGeneration: row.expectedGeneration,
      failureCode: typeof row.failureCode === "string" ? row.failureCode : null,
      createdAt: row.createdAt,
      verifiedAt: numberOrNull(row.verifiedAt),
      committedAt: numberOrNull(row.committedAt),
    });
    rotationsByConnection.set(providerConnectionId.value, list);
  }

  const revocationsByHandle = new Map<string, CredentialRevocationInventory>();
  for (const row of input.revocationRows) {
    if (
      typeof row.vaultHandle !== "string" ||
      (row.state !== "committed" && row.state !== "policy_activated") ||
      typeof row.startedAt !== "number" ||
      typeof row.committedAt !== "number"
    ) {
      return invalid;
    }
    revocationsByHandle.set(row.vaultHandle, {
      state: row.state,
      startedAt: row.startedAt,
      committedAt: row.committedAt,
      policyActivatedAt: numberOrNull(row.policyActivatedAt),
      restrictionLatencyMs: numberOrNull(row.restrictionLatencyMs),
    });
  }

  const observationsByAccount = new Map<string, number>();
  for (const row of input.observationRows) {
    if (typeof row.integrationAccountId !== "string") {
      return invalid;
    }
    const integrationAccountId = parseIntegrationAccountId(
      row.integrationAccountId,
    );
    if (
      !integrationAccountId.ok ||
      integrationAccountId.value !== row.integrationAccountId
    ) {
      return invalid;
    }
    const observedAt = numberOrNull(row.observedAt);
    if (observedAt !== null) {
      observationsByAccount.set(integrationAccountId.value, observedAt);
    }
  }

  const assembled: CredentialAccountInventory[] = [];
  for (const value of accounts.values()) {
    assembled.push({
      ...value.entry,
      generations: value.generations,
      webhooks: webhooksByAccount.get(value.entry.integrationAccountId) ?? [],
      rotations: rotationsByConnection.get(value.connectionId) ?? [],
      revocation: findAccountRevocation(
        input.rows,
        value.entry.integrationAccountId,
        revocationsByHandle,
      ),
      lastManifestObservationAt:
        observationsByAccount.get(value.entry.integrationAccountId) ?? null,
    });
  }

  return {
    ok: true,
    value: { organisationId: input.organisationId, accounts: assembled },
  };
}

function findAccountRevocation(
  rows: readonly Record<string, unknown>[],
  integrationAccountId: string,
  revocationsByHandle: ReadonlyMap<string, CredentialRevocationInventory>,
): CredentialRevocationInventory | null {
  for (const row of rows) {
    if (row.integrationAccountId !== integrationAccountId) {
      continue;
    }
    const generationRef = row.generationCredentialRef;
    if (typeof generationRef === "string") {
      const revocation = revocationsByHandle.get(generationRef);
      if (revocation !== undefined) {
        return revocation;
      }
    }
  }
  return null;
}

type CredentialRevocationAuthorizationError =
  | { readonly code: "integration_account_not_found" }
  | { readonly code: "integration_account_corrupt"; readonly field: string }
  | {
      readonly code: "integration_account_inactive";
      readonly lifecycle: IntegrationAccount["lifecycle"]["kind"];
    }
  | { readonly code: "provider_connection_not_found" }
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "credential_already_revoked" }
  | { readonly code: "provider_connection_credential_absent" }
  | { readonly code: "default_account_replacement_required" }
  | { readonly code: "default_account_replacement_invalid" };

type AuthorizedCredentialRevocation = {
  readonly account: IntegrationAccount;
  readonly connection: ProviderConnection;
  readonly handle: VaultHandle;
  readonly replacementIntegrationAccountId: IntegrationAccountId | null;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

export async function authorizeCredentialRevocation(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly replacementIntegrationAccountId: IntegrationAccountId | null;
  readonly expectedConfigurationVersion: number;
}): Promise<
  Result<AuthorizedCredentialRevocation, CredentialRevocationAuthorizationError>
> {
  const account = await resolveIntegrationAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!account.ok) {
    return account;
  }
  if (account.value.lifecycle.kind === "revoked") {
    return { ok: false, error: { code: "credential_already_revoked" } };
  }
  const connection = await resolveProviderConnection({
    db: input.db,
    organisationId: input.organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (!connection.ok) {
    return connection;
  }
  if (connection.value.lifecycle.kind === "revoked") {
    return { ok: false, error: { code: "credential_already_revoked" } };
  }
  const state = await readAccountMutationState(input.db, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  if (state.configurationVersion !== input.expectedConfigurationVersion) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const defaultNeedsReplacement =
    account.value.isDefaultForProvider &&
    account.value.accountKind !== "mailbox";
  if (defaultNeedsReplacement && account.value.lifecycle.kind === "active") {
    const replacement = await resolveDisableReplacement({
      db: input.db,
      account: account.value,
      replacementIntegrationAccountId: input.replacementIntegrationAccountId,
    });
    if (!replacement.ok) {
      return {
        ok: false,
        error: { code: "default_account_replacement_invalid" },
      };
    }
    if (replacement.value === null) {
      return {
        ok: false,
        error: { code: "default_account_replacement_required" },
      };
    }
  } else if (input.replacementIntegrationAccountId !== null) {
    return {
      ok: false,
      error: { code: "default_account_replacement_invalid" },
    };
  }
  const authority = connectionCredentialAuthority(connection.value.authority);
  if (authority === null) {
    return {
      ok: false,
      error: { code: "provider_connection_credential_absent" },
    };
  }
  return {
    ok: true,
    value: {
      account: account.value,
      connection: connection.value,
      handle: authority.credentialRef,
      replacementIntegrationAccountId: input.replacementIntegrationAccountId,
      configurationVersion: state.configurationVersion + 1,
      projectionRevision: state.projectionRevision + 1,
    },
  };
}

/**
 * The two statements that settle a credential mutation in its batch: the
 * counters of the configuration row move on, and the receipt holds the answer.
 */
function settledMutationStatements(
  session: OrganisationDatabaseSession,
  input: Readonly<{
    organisationId: OrganisationId;
    mutation: IntegrationAccountMutation;
    receiptBody: Record<string, unknown>;
    now: number;
  }>,
): readonly D1PreparedStatement[] {
  return [
    prepareConfigurationVersionBump(session, input.organisationId, input.now),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: input.receiptBody,
    }),
  ];
}

export async function recordCredentialRevocationMutation(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly authorization: AuthorizedCredentialRevocation;
  readonly mutation: IntegrationAccountMutation;
  readonly actorUserId: UserId;
  readonly receiptBody: Record<string, unknown>;
  readonly now: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  const statements = [
    ...settledMutationStatements(session, input),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: input.authorization.account.environment,
      actorUserId: input.actorUserId,
      operation: "provider.credential.revoke",
      targetKind: "provider_connection",
      targetId: input.authorization.connection.providerConnectionId,
      oldLifecycle: input.authorization.account.lifecycle.kind,
      newLifecycle: "revoked",
      configurationVersion: input.authorization.configurationVersion,
      projectionRevision: input.authorization.projectionRevision,
      reasonCode: "credential_revoked",
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.organisationId,
      environment: input.authorization.account.environment,
      projectionRevision: input.authorization.projectionRevision,
      attributes: {
        reason_code: "provider_credential_revoked",
        integration_account_id:
          input.authorization.account.integrationAccountId,
      },
    }),
  ];
  if (input.authorization.replacementIntegrationAccountId !== null) {
    statements.unshift(
      session
        .prepare(
          `UPDATE integration_account
           SET is_default_for_provider = 0, updated_at = ?
           WHERE organisation_id = ? AND integration_account_id = ?`,
        )
        .bind(
          input.now,
          input.organisationId,
          input.authorization.account.integrationAccountId,
        ),
      session
        .prepare(
          `UPDATE integration_account
           SET is_default_for_provider = 1, updated_at = ?
           WHERE organisation_id = ? AND integration_account_id = ?
             AND lifecycle = 'active'`,
        )
        .bind(
          input.now,
          input.organisationId,
          input.authorization.replacementIntegrationAccountId,
        ),
    );
  }
  await session.batch(statements);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parseGenerationLifecycle(
  value: string,
): CredentialGenerationInventory["lifecycle"] | null {
  return value === "staged" ||
    value === "active" ||
    value === "superseded" ||
    value === "revoked" ||
    value === "failed"
    ? value
    : null;
}

function parseWebhookLifecycle(
  value: string,
): CredentialWebhookInventory["lifecycle"] | null {
  return value === "pending" ||
    value === "live" ||
    value === "degraded" ||
    value === "disabled" ||
    value === "revoked"
    ? value
    : null;
}

function parseRotationStatus(
  value: string,
): CredentialRotationInventory["status"] | null {
  return value === "pending_verification" ||
    value === "verified" ||
    value === "committed" ||
    value === "failed"
    ? value
    : null;
}

function parseAccountLifecycle(
  value: string,
): IntegrationAccount["lifecycle"]["kind"] | null {
  return value === "connecting" ||
    value === "pending_activation" ||
    value === "active" ||
    value === "degraded" ||
    value === "reauth_required" ||
    value === "disabled" ||
    value === "revoked"
    ? value
    : null;
}

function parseConnectionLifecycle(
  value: string,
): ProviderConnection["lifecycle"]["kind"] | null {
  return value === "connecting" ||
    value === "active" ||
    value === "reauth_required" ||
    value === "disabled" ||
    value === "revoked"
    ? value
    : null;
}

function parseAuthMode(value: string): ProviderConnection["authMode"] | null {
  return value === "shared_satyr_app" ||
    value === "api_key" ||
    value === "webhook_secret"
    ? value
    : null;
}

function parseEnvironment(
  value: string,
): IntegrationAccount["environment"] | null {
  return value === "development" || value === "production" ? value : null;
}

function parseProvider(value: string): IntegrationAccount["provider"] | null {
  const parsed = parseIntegrationProvider(value);
  return parsed.ok ? parsed.value : null;
}

function parseScopeList(value: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== "string")
    ) {
      return null;
    }
    return parsed.map(String);
  } catch {
    return null;
  }
}

type CredentialRotationBeginError =
  | { readonly code: "integration_account_not_found" }
  | { readonly code: "integration_account_corrupt"; readonly field: string }
  | {
      readonly code: "integration_account_inactive";
      readonly lifecycle: IntegrationAccount["lifecycle"]["kind"];
    }
  | { readonly code: "provider_connection_not_found" }
  | { readonly code: "credential_mutation_not_allowed" }
  | { readonly code: "provider_connection_credential_absent" }
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "credential_rotation_conflict" };

export type BegunCredentialRotation = {
  readonly credentialRotationId: string;
  readonly account: IntegrationAccount;
  readonly connection: ProviderConnection;
  /** Rotation replaces one organisation credential; shared-application grants never rotate here. */
  readonly authority: ConnectionCredentialAuthority;
  readonly replacementHandle: VaultHandle;
  readonly resumedStatus:
    "pending_verification" | "verified" | "committed" | null;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

export async function beginCredentialRotation(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly credentialRotationId: string;
  readonly replacementHandle: VaultHandle;
  readonly createdByUserId: UserId;
  readonly expectedConfigurationVersion: number;
  readonly now: number;
}): Promise<Result<BegunCredentialRotation, CredentialRotationBeginError>> {
  const account = await resolveIntegrationAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!account.ok) {
    return account;
  }
  if (
    !integrationAccountAllowsCredentialMutation(
      account.value.lifecycle,
      "rotate",
    )
  ) {
    return { ok: false, error: { code: "credential_mutation_not_allowed" } };
  }
  const connection = await resolveProviderConnection({
    db: input.db,
    organisationId: input.organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (!connection.ok) {
    return connection;
  }
  if (
    !providerConnectionAllowsCredentialMutation(
      connection.value.lifecycle,
      "rotate",
    )
  ) {
    return { ok: false, error: { code: "credential_mutation_not_allowed" } };
  }
  const authority = connectionCredentialAuthority(connection.value.authority);
  if (authority === null) {
    return {
      ok: false,
      error: { code: "provider_connection_credential_absent" },
    };
  }
  const state = await readAccountMutationState(input.db, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  if (state.configurationVersion !== input.expectedConfigurationVersion) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const existing = await input.db
    .prepare(
      `SELECT credential_rotation_id AS credentialRotationId, status,
              replacement_credential_ref AS replacementCredentialRef
       FROM credential_rotation
       WHERE organisation_id = ? AND credential_rotation_id = ?`,
    )
    .bind(input.organisationId, input.credentialRotationId)
    .first<Record<string, unknown>>();
  if (existing !== null) {
    const status =
      typeof existing.status === "string"
        ? parseRotationStatus(existing.status)
        : null;
    const storedHandle =
      typeof existing.replacementCredentialRef === "string"
        ? parseVaultHandle(existing.replacementCredentialRef)
        : {
            ok: false as const,
            error: { code: "vault_handle_invalid" as const },
          };
    if (status === null || status === "failed" || !storedHandle.ok) {
      return { ok: false, error: { code: "credential_rotation_conflict" } };
    }
    return {
      ok: true,
      value: {
        credentialRotationId: input.credentialRotationId,
        account: account.value,
        connection: connection.value,
        authority,
        replacementHandle: storedHandle.value,
        resumedStatus: status,
        configurationVersion: state.configurationVersion + 1,
        projectionRevision: state.projectionRevision + 1,
      },
    };
  }
  const open = await input.db
    .prepare(
      `SELECT COUNT(*) AS openCount
       FROM credential_rotation
       WHERE organisation_id = ? AND provider_connection_id = ?
         AND status IN ('pending_verification', 'verified')`,
    )
    .bind(input.organisationId, connection.value.providerConnectionId)
    .first<{ readonly openCount: unknown }>();
  if (
    open !== null &&
    typeof open.openCount === "number" &&
    open.openCount > 0
  ) {
    return { ok: false, error: { code: "credential_rotation_conflict" } };
  }
  await input.db
    .prepare(
      `INSERT INTO credential_rotation (
         credential_rotation_id, organisation_id, provider_connection_id,
         expected_generation, replacement_credential_ref, status,
         failure_code, created_by_user_id, created_at,
         verified_at, committed_at
       ) VALUES (?, ?, ?, ?, ?, 'pending_verification', NULL, ?, ?, NULL, NULL)`,
    )
    .bind(
      input.credentialRotationId,
      input.organisationId,
      connection.value.providerConnectionId,
      authority.credentialGeneration,
      input.replacementHandle,
      input.createdByUserId,
      input.now,
    )
    .run();
  return {
    ok: true,
    value: {
      credentialRotationId: input.credentialRotationId,
      account: account.value,
      connection: connection.value,
      authority,
      replacementHandle: input.replacementHandle,
      resumedStatus: null,
      configurationVersion: state.configurationVersion + 1,
      projectionRevision: state.projectionRevision + 1,
    },
  };
}

export async function markCredentialRotationVerified(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly credentialRotationId: string;
  readonly now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE credential_rotation
       SET status = 'verified', verified_at = ?
       WHERE organisation_id = ? AND credential_rotation_id = ?
         AND status = 'pending_verification'`,
    )
    .bind(input.now, input.organisationId, input.credentialRotationId)
    .run();
}

export async function markCredentialRotationFailed(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly credentialRotationId: string;
  readonly failureCode: CredentialRotationFailureCode;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE credential_rotation
       SET status = 'failed', failure_code = ?
       WHERE organisation_id = ? AND credential_rotation_id = ?
         AND status IN ('pending_verification', 'verified')`,
    )
    .bind(input.failureCode, input.organisationId, input.credentialRotationId)
    .run();
}

export async function commitCredentialRotation(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly rotation: BegunCredentialRotation;
  readonly mutation: IntegrationAccountMutation;
  readonly actorUserId: UserId;
  readonly receiptBody: Record<string, unknown>;
  readonly now: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `UPDATE provider_credential_generation
         SET lifecycle = 'superseded', superseded_at = ?
         WHERE organisation_id = ? AND provider_connection_id = ?
           AND credential_generation = ? AND lifecycle = 'active'`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.rotation.connection.providerConnectionId,
        input.rotation.authority.credentialGeneration,
      ),
    prepareActiveCredentialGeneration(session, {
      providerConnectionId: input.rotation.connection.providerConnectionId,
      credentialGeneration: input.rotation.authority.credentialGeneration + 1,
      organisationId: input.organisationId,
      provider: input.rotation.connection.provider,
      environment: input.rotation.connection.environment,
      credentialRef: input.rotation.replacementHandle,
      createdAt: input.now,
      activatedAt: input.now,
      ifAbsent: true,
    }),
    session
      .prepare(
        `UPDATE provider_connection
         SET credential_generation = credential_generation + 1,
             credential_ref = ?, updated_at = ?
         WHERE organisation_id = ? AND provider_connection_id = ?
           AND credential_generation = ? AND lifecycle = 'active'`,
      )
      .bind(
        input.rotation.replacementHandle,
        input.now,
        input.organisationId,
        input.rotation.connection.providerConnectionId,
        input.rotation.authority.credentialGeneration,
      ),
    session
      .prepare(
        `UPDATE credential_ref
         SET vault_handle = ?
         WHERE organisation_id = ? AND provider = ? AND vault_handle = ?
           AND revoked_at IS NULL`,
      )
      .bind(
        input.rotation.replacementHandle,
        input.organisationId,
        input.rotation.connection.provider,
        input.rotation.authority.credentialRef,
      ),
    session
      .prepare(
        `UPDATE credential_rotation
         SET status = 'committed', committed_at = ?
         WHERE organisation_id = ? AND credential_rotation_id = ?
           AND status = 'verified'`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.rotation.credentialRotationId,
      ),
    ...settledMutationStatements(session, input),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: input.rotation.account.environment,
      actorUserId: input.actorUserId,
      operation: "provider.credential.rotate",
      targetKind: "provider_connection",
      targetId: input.rotation.connection.providerConnectionId,
      oldLifecycle: `generation_${input.rotation.authority.credentialGeneration}`,
      newLifecycle: `generation_${input.rotation.authority.credentialGeneration + 1}`,
      configurationVersion: input.rotation.configurationVersion,
      projectionRevision: input.rotation.projectionRevision,
      reasonCode: "credential_rotated",
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.organisationId,
      environment: input.rotation.account.environment,
      projectionRevision: input.rotation.projectionRevision,
      attributes: {
        reason_code: "provider_credential_rotated",
        integration_account_id: input.rotation.account.integrationAccountId,
      },
    }),
  ]);
}
