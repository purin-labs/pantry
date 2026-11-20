import type { OrganisationDatabase } from "../database-handles";

import { readAccountMutationState } from "../data/integration-account";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";
import type { OrganisationEnvironment } from "../data/control-plane";
import {
  newIntegrationAccountId,
  newProviderConnectionId,
  parseIntegrationAccountId,
  parseProviderConnectionId,
  parseOrganisationId,
  type UserId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import {
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  type CustomConnectorDefinitionDigest,
  type CustomConnectorId,
  type CustomConnectorRevision,
} from "./identity";
import type { AuthorizedCustomConnectorSetupCommit } from "./setup";
import {
  customConnectorSetupLifecycleAllows,
  parseCustomConnectorSetupAccountLifecycle,
  type ExistingCustomConnectorSetupKind,
} from "./setup-target";
import { isNonNegativeInteger, isPositiveInteger } from "@purin-labs/std";
import {
  prepareConfigurationVersionBump,
} from "../data/organisation-onboarding-row";

export type ActiveCustomConnectorAccount = {
  readonly source: {
    readonly kind: "custom_api";
    readonly connectorId: CustomConnectorId;
  };
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly accountKind: "api_account";
  readonly displayName: string;
  readonly lifecycle: { readonly kind: "active" };
  readonly binding: {
    readonly lifecycle: "active";
    readonly acceptedRevision: CustomConnectorRevision;
    readonly definitionDigest: CustomConnectorDefinitionDigest;
    readonly bindingRevision: number;
    readonly credentialGeneration: number;
    readonly isDefaultForConnector: boolean;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
};

type CustomConnectorAccountCommitError =
  | { readonly code: "custom_connector_setup_conflict" }
  | { readonly code: "configuration_version_conflict" }
  | {
      readonly code: "custom_connector_account_already_connected";
      readonly integrationAccountId: IntegrationAccountId;
    }
  | { readonly code: "custom_connector_account_not_found" }
  | {
      readonly code: "custom_connector_account_persistence_corrupt";
      readonly field: string;
    };

type ExistingCustomConnectorCommitState = Readonly<{
  readonly providerConnectionId: ProviderConnectionId;
  readonly credentialGeneration: number;
  readonly credentialRef: VaultHandle;
}>;

type ExistingCustomConnectorCommitRow = {
  providerConnectionId: unknown;
  credentialGeneration: unknown;
  credentialRef: unknown;
  accountLifecycle: unknown;
  connectionLifecycle: unknown;
  bindingLifecycle: unknown;
};

type CustomAccountRow = {
  organisationId: unknown;
  integrationAccountId: unknown;
  providerConnectionId: unknown;
  connectorId: unknown;
  environment: unknown;
  providerAccountId: unknown;
  accountKind: unknown;
  displayName: unknown;
  accountLifecycle: unknown;
  connectionLifecycle: unknown;
  bindingLifecycle: unknown;
  acceptedRevision: unknown;
  definitionDigest: unknown;
  bindingRevision: unknown;
  credentialGeneration: unknown;
  isDefaultForConnector: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

export async function commitNewCustomConnectorAccount(input: {
  readonly db: OrganisationDatabase;
  readonly authorization: AuthorizedCustomConnectorSetupCommit;
  readonly committedByUserId: UserId;
  readonly expectedConfigurationVersion: number;
  readonly now: number;
}): Promise<
  Result<ActiveCustomConnectorAccount, CustomConnectorAccountCommitError>
> {
  const attempt = input.authorization.attempt;
  if (attempt.target.kind !== "new_account") {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const duplicate = await findCustomConnectorAccountByIdentity({
    db: input.db,
    organisationId: attempt.organisationId,
    connectorId: attempt.connectorId,
    environment: attempt.environment,
    providerAccountId: attempt.verification.providerAccountId,
    accountKind: "api_account",
  });
  if (duplicate !== null) {
    return {
      ok: false,
      error: {
        code: "custom_connector_account_already_connected",
        integrationAccountId: duplicate,
      },
    };
  }
  const configuration = await readAccountMutationState(
    input.db,
    attempt.organisationId,
  );
  if (
    configuration === null ||
    configuration.configurationVersion !== input.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const isDefaultForConnector = await connectorNeedsDefaultAccount({
    db: input.db,
    organisationId: attempt.organisationId,
    connectorId: attempt.connectorId,
    environment: attempt.environment,
  });
  const providerConnectionId = newProviderConnectionId();
  const integrationAccountId = newIntegrationAccountId();
  const operationIds =
    input.authorization.definition.operations.map(operationId);
  const session = input.db.withSession("first-primary");
  let results: D1Result[];
  try {
    results = await session.batch([
      session
        .prepare(
          `INSERT INTO provider_connection (
             provider_connection_id, organisation_id, source_kind, custom_connector_id,
             provider, auth_mode, authority_kind, credential_generation,
             credential_ref, lifecycle, granted_scopes,
             created_by_user_id, created_at, updated_at,
             disabled_at, revoked_at, environment, provider_subject_id
           )
           SELECT ?, setup.organisation_id, 'custom_api', setup.connector_id,
             'custom_api', 'api_key', 'connection_credential', 1,
             setup.candidate_credential_ref, 'active', '[]', ?, ?, ?,
             NULL, NULL, setup.environment, setup.verified_provider_account_id
           FROM custom_connector_setup_attempt AS setup
           JOIN custom_connector_revision AS revision
             ON revision.organisation_id = setup.organisation_id
            AND revision.connector_id = setup.connector_id
            AND revision.revision = setup.connector_revision
            AND revision.definition_digest = setup.definition_digest
           JOIN custom_connector AS connector
             ON connector.organisation_id = setup.organisation_id
            AND connector.connector_id = setup.connector_id
           JOIN organisation_onboarding AS onboarding
             ON onboarding.organisation_id = setup.organisation_id
            AND onboarding.configuration_version = ?
           JOIN vault_secret AS secret
             ON secret.organisation_id = setup.organisation_id
            AND secret.vault_handle = setup.candidate_credential_ref
            AND secret.revoked_at IS NULL
           WHERE setup.organisation_id = ? AND setup.attempt_id = ?
             AND setup.lifecycle = 'verified' AND setup.attempt_revision = ?
             AND setup.expires_at > ? AND revision.review_state = 'approved'
             AND connector.lifecycle IN ('draft', 'active')`,
        )
        .bind(
          providerConnectionId,
          input.committedByUserId,
          input.now,
          input.now,
          input.expectedConfigurationVersion,
          attempt.organisationId,
          attempt.attemptId,
          attempt.attemptRevision,
          input.now,
        ),
      session
        .prepare(
          `INSERT INTO provider_credential_generation (
             provider_connection_id, credential_generation, organisation_id, provider,
             environment, credential_ref, lifecycle, created_at, activated_at,
             superseded_at, revoked_at, failed_at, failure_code
           ) VALUES (?, 1, ?, 'custom_api', ?, ?, 'active', ?, ?,
                     NULL, NULL, NULL, NULL)`,
        )
        .bind(
          providerConnectionId,
          attempt.organisationId,
          attempt.environment,
          input.authorization.candidateCredentialRef,
          input.now,
          input.now,
        ),
      session
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
          integrationAccountId,
          attempt.organisationId,
          attempt.connectorId,
          providerConnectionId,
          scopedCustomProviderAccountId(
            attempt.connectorId,
            attempt.verification.providerAccountId,
          ),
          attempt.verification.displayName,
          JSON.stringify(operationIds),
          input.now,
          input.now,
          attempt.environment,
        ),
      session
        .prepare(
          `INSERT INTO custom_connector_account_binding (
             organisation_id, integration_account_id, connector_id,
             provider_account_id, account_kind, environment,
             accepted_revision, accepted_definition_digest, binding_revision,
             credential_generation, lifecycle, is_default_for_connector,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'api_account', ?, ?, ?, 1, 1, 'active', ?, ?, ?)`,
        )
        .bind(
          attempt.organisationId,
          integrationAccountId,
          attempt.connectorId,
          attempt.verification.providerAccountId,
          attempt.environment,
          attempt.connectorRevision,
          attempt.definitionDigest,
          isDefaultForConnector ? 1 : 0,
          input.now,
          input.now,
        ),
      session
        .prepare(
          `UPDATE custom_connector_setup_attempt
           SET lifecycle = 'committed', attempt_revision = attempt_revision + 1,
               committed_integration_account_id = ?, completed_at = ?, updated_at = ?
           WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'verified'
             AND attempt_revision = ? AND candidate_credential_ref = ?
             AND connector_revision = ? AND definition_digest = ? AND expires_at > ?`,
        )
        .bind(
          integrationAccountId,
          input.now,
          input.now,
          attempt.organisationId,
          attempt.attemptId,
          attempt.attemptRevision,
          input.authorization.candidateCredentialRef,
          attempt.connectorRevision,
          attempt.definitionDigest,
          input.now,
        ),
      session
        .prepare(
          `UPDATE custom_connector
           SET lifecycle = 'active', updated_at = ?
           WHERE organisation_id = ? AND connector_id = ?
             AND lifecycle IN ('draft', 'active')`,
        )
        .bind(input.now, attempt.organisationId, attempt.connectorId),
      prepareConfigurationVersionBump(session, attempt.organisationId, input.now, { atConfigurationVersion: input.expectedConfigurationVersion }),
    ]);
  } catch {
    const concurrentDuplicate = await findCustomConnectorAccountByIdentity({
      db: input.db,
      organisationId: attempt.organisationId,
      connectorId: attempt.connectorId,
      environment: attempt.environment,
      providerAccountId: attempt.verification.providerAccountId,
      accountKind: "api_account",
    });
    return concurrentDuplicate === null
      ? { ok: false, error: { code: "custom_connector_setup_conflict" } }
      : {
          ok: false,
          error: {
            code: "custom_connector_account_already_connected",
            integrationAccountId: concurrentDuplicate,
          },
        };
  }
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1 ||
    results[6]?.meta.changes !== 1
  ) {
    throw new Error("custom connector account commit invariant failed");
  }
  return resolveActiveCustomConnectorAccount({
    db: session,
    organisationId: attempt.organisationId,
    integrationAccountId,
  });
}

export async function commitExistingCustomConnectorAccount(input: {
  readonly db: OrganisationDatabase;
  readonly authorization: AuthorizedCustomConnectorSetupCommit;
  readonly expectedConfigurationVersion: number;
  readonly now: number;
}): Promise<
  Result<ActiveCustomConnectorAccount, CustomConnectorAccountCommitError>
> {
  const attempt = input.authorization.attempt;
  const target = attempt.target;
  if (target.kind === "new_account") {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const configuration = await readAccountMutationState(
    input.db,
    attempt.organisationId,
  );
  if (
    configuration === null ||
    configuration.configurationVersion !== input.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const current = await readExistingCustomConnectorCommitState({
    db: input.db,
    organisationId: attempt.organisationId,
    integrationAccountId: target.integrationAccountId,
    connectorId: attempt.connectorId,
    expectedBindingRevision: target.expectedBindingRevision,
    targetKind: target.kind,
  });
  if (!current.ok) return current;
  if (
    current.value.credentialGeneration >= Number.MAX_SAFE_INTEGER ||
    target.expectedBindingRevision >= Number.MAX_SAFE_INTEGER
  ) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const nextCredentialGeneration = current.value.credentialGeneration + 1;
  const nextBindingRevision = target.expectedBindingRevision + 1;
  const operationIds =
    input.authorization.definition.operations.map(operationId);
  const session = input.db.withSession("first-primary");
  let results: D1Result[];
  try {
    results = await session.batch([
      session
        .prepare(
          `UPDATE provider_credential_generation
           SET lifecycle = 'superseded', superseded_at = ?
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND credential_generation = ? AND credential_ref = ?
             AND lifecycle = 'active'`,
        )
        .bind(
          input.now,
          attempt.organisationId,
          current.value.providerConnectionId,
          current.value.credentialGeneration,
          current.value.credentialRef,
        ),
      session
        .prepare(
          `INSERT INTO provider_credential_generation (
             provider_connection_id, credential_generation, organisation_id, provider,
             environment, credential_ref, lifecycle, created_at, activated_at,
             superseded_at, revoked_at, failed_at, failure_code
           ) VALUES (?, ?, ?, 'custom_api', ?, ?, 'active', ?, ?,
                     NULL, NULL, NULL, NULL)`,
        )
        .bind(
          current.value.providerConnectionId,
          nextCredentialGeneration,
          attempt.organisationId,
          attempt.environment,
          input.authorization.candidateCredentialRef,
          input.now,
          input.now,
        ),
      session
        .prepare(
          `UPDATE provider_connection
           SET credential_generation = ?, credential_ref = ?, lifecycle = 'active',
               updated_at = ?, disabled_at = NULL, revoked_at = NULL
           WHERE organisation_id = ? AND provider_connection_id = ?
             AND source_kind = 'custom_api' AND custom_connector_id = ?
             AND credential_generation = ? AND credential_ref = ?
             AND lifecycle != 'revoked'`,
        )
        .bind(
          nextCredentialGeneration,
          input.authorization.candidateCredentialRef,
          input.now,
          attempt.organisationId,
          current.value.providerConnectionId,
          attempt.connectorId,
          current.value.credentialGeneration,
          current.value.credentialRef,
        ),
      session
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
          attempt.verification.displayName,
          JSON.stringify(operationIds),
          input.now,
          attempt.organisationId,
          target.integrationAccountId,
          attempt.connectorId,
          current.value.providerConnectionId,
          scopedCustomProviderAccountId(
            attempt.connectorId,
            attempt.verification.providerAccountId,
          ),
        ),
      session
        .prepare(
          `UPDATE custom_connector_account_binding
           SET accepted_revision = ?, accepted_definition_digest = ?,
               binding_revision = ?, credential_generation = ?, lifecycle = 'active',
               updated_at = ?, disabled_at = NULL, revoked_at = NULL
           WHERE organisation_id = ? AND integration_account_id = ? AND connector_id = ?
             AND binding_revision = ? AND credential_generation = ?
             AND provider_account_id = ? AND lifecycle != 'revoked'`,
        )
        .bind(
          attempt.connectorRevision,
          attempt.definitionDigest,
          nextBindingRevision,
          nextCredentialGeneration,
          input.now,
          attempt.organisationId,
          target.integrationAccountId,
          attempt.connectorId,
          target.expectedBindingRevision,
          current.value.credentialGeneration,
          attempt.verification.providerAccountId,
        ),
      session
        .prepare(
          `UPDATE custom_connector_setup_attempt
           SET lifecycle = 'committed', attempt_revision = attempt_revision + 1,
               committed_integration_account_id = ?, completed_at = ?, updated_at = ?
           WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'verified'
             AND attempt_revision = ? AND target_kind = ?
             AND target_integration_account_id = ? AND expected_binding_revision = ?
             AND candidate_credential_ref = ? AND connector_revision = ?
             AND definition_digest = ? AND expires_at > ?`,
        )
        .bind(
          target.integrationAccountId,
          input.now,
          input.now,
          attempt.organisationId,
          attempt.attemptId,
          attempt.attemptRevision,
          target.kind,
          target.integrationAccountId,
          target.expectedBindingRevision,
          input.authorization.candidateCredentialRef,
          attempt.connectorRevision,
          attempt.definitionDigest,
          input.now,
        ),
      session
        .prepare(
          `UPDATE vault_secret
           SET revoked_at = ?
           WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
        )
        .bind(input.now, attempt.organisationId, current.value.credentialRef),
      prepareConfigurationVersionBump(session, attempt.organisationId, input.now, { atConfigurationVersion: input.expectedConfigurationVersion }),
    ]);
  } catch {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  for (const result of results) {
    if (result.meta.changes !== 1) {
      throw new Error("custom connector account update invariant failed");
    }
  }
  return resolveActiveCustomConnectorAccount({
    db: session,
    organisationId: attempt.organisationId,
    integrationAccountId: target.integrationAccountId,
  });
}

async function readExistingCustomConnectorCommitState(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectorId: CustomConnectorId;
  readonly expectedBindingRevision: number;
  readonly targetKind: ExistingCustomConnectorSetupKind;
}): Promise<
  Result<ExistingCustomConnectorCommitState, CustomConnectorAccountCommitError>
> {
  const row = await input.db
    .prepare(
      `SELECT
         connection.provider_connection_id AS providerConnectionId,
         connection.credential_generation AS credentialGeneration,
         connection.credential_ref AS credentialRef,
         account.lifecycle AS accountLifecycle,
         connection.lifecycle AS connectionLifecycle,
         binding.lifecycle AS bindingLifecycle
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.organisation_id = account.organisation_id
        AND connection.provider_connection_id = account.provider_connection_id
        AND connection.source_kind = 'custom_api'
        AND connection.custom_connector_id = account.custom_connector_id
       JOIN custom_connector_account_binding AS binding
         ON binding.organisation_id = account.organisation_id
        AND binding.integration_account_id = account.integration_account_id
        AND binding.connector_id = account.custom_connector_id
        AND binding.credential_generation = connection.credential_generation
       WHERE account.organisation_id = ? AND account.integration_account_id = ?
         AND account.source_kind = 'custom_api' AND account.custom_connector_id = ?
         AND binding.binding_revision = ? AND binding.lifecycle != 'revoked'
         AND account.lifecycle != 'revoked' AND connection.lifecycle != 'revoked'
       LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.connectorId,
      input.expectedBindingRevision,
    )
    .first<ExistingCustomConnectorCommitRow>();
  if (row === null) {
    return { ok: false, error: { code: "custom_connector_account_not_found" } };
  }
  const lifecycle = parseCustomConnectorSetupAccountLifecycle({
    account: row.accountLifecycle,
    connection: row.connectionLifecycle,
    binding: row.bindingLifecycle,
  });
  if (
    lifecycle === null ||
    !customConnectorSetupLifecycleAllows(input.targetKind, lifecycle)
  ) {
    return { ok: false, error: { code: "custom_connector_account_not_found" } };
  }
  if (
    typeof row.providerConnectionId !== "string" ||
    typeof row.credentialRef !== "string"
  ) {
    return accountCorrupt("credentialAuthority");
  }
  const providerConnectionId = parseProviderConnectionId(
    row.providerConnectionId,
  );
  const credentialRef = parseVaultHandle(row.credentialRef);
  if (
    !providerConnectionId.ok ||
    !credentialRef.ok ||
    !isPositiveInteger(row.credentialGeneration)
  ) {
    return accountCorrupt("credentialGeneration");
  }
  return {
    ok: true,
    value: {
      providerConnectionId: providerConnectionId.value,
      credentialGeneration: row.credentialGeneration,
      credentialRef: credentialRef.value,
    },
  };
}

export async function resolveActiveCustomConnectorAccount(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<
  Result<ActiveCustomConnectorAccount, CustomConnectorAccountCommitError>
> {
  const row = await input.db
    .prepare(
      `SELECT
         account.organisation_id AS organisationId,
         account.integration_account_id AS integrationAccountId,
         account.provider_connection_id AS providerConnectionId,
         binding.connector_id AS connectorId,
         account.environment,
         binding.provider_account_id AS providerAccountId,
         account.account_kind AS accountKind,
         account.display_name AS displayName,
         account.lifecycle AS accountLifecycle,
         connection.lifecycle AS connectionLifecycle,
         binding.lifecycle AS bindingLifecycle,
         binding.accepted_revision AS acceptedRevision,
         binding.accepted_definition_digest AS definitionDigest,
         binding.binding_revision AS bindingRevision,
         binding.credential_generation AS credentialGeneration,
         binding.is_default_for_connector AS isDefaultForConnector,
         binding.created_at AS createdAt,
         binding.updated_at AS updatedAt
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.organisation_id = account.organisation_id
        AND connection.provider_connection_id = account.provider_connection_id
        AND connection.source_kind = 'custom_api'
        AND connection.custom_connector_id = account.custom_connector_id
       JOIN custom_connector_account_binding AS binding
         ON binding.organisation_id = account.organisation_id
        AND binding.integration_account_id = account.integration_account_id
        AND binding.connector_id = account.custom_connector_id
       WHERE account.organisation_id = ? AND account.integration_account_id = ?
         AND account.source_kind = 'custom_api'`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<CustomAccountRow>();
  return row === null
    ? { ok: false, error: { code: "custom_connector_account_not_found" } }
    : parseActiveCustomConnectorAccount(row);
}

function scopedCustomProviderAccountId(
  connectorId: CustomConnectorId,
  providerAccountId: string,
): string {
  return `${connectorId}:${providerAccountId}`;
}

async function findCustomConnectorAccountByIdentity(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly accountKind: "api_account";
}): Promise<IntegrationAccountId | null> {
  const row = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId
       FROM custom_connector_account_binding
       WHERE organisation_id = ? AND connector_id = ? AND environment = ?
         AND provider_account_id = ? AND account_kind = ?
         AND lifecycle != 'revoked'`,
    )
    .bind(
      input.organisationId,
      input.connectorId,
      input.environment,
      input.providerAccountId,
      input.accountKind,
    )
    .first<{ integrationAccountId: unknown }>();
  if (row === null) return null;
  if (typeof row.integrationAccountId !== "string") {
    throw new Error("custom connector account identity is corrupt");
  }
  const parsed = parseIntegrationAccountId(row.integrationAccountId);
  if (!parsed.ok)
    throw new Error("custom connector account identity is invalid");
  return parsed.value;
}

async function connectorNeedsDefaultAccount(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly environment: OrganisationEnvironment;
}): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS present FROM custom_connector_account_binding
       WHERE organisation_id = ? AND connector_id = ? AND environment = ?
         AND lifecycle = 'active' AND is_default_for_connector = 1
       LIMIT 1`,
    )
    .bind(input.organisationId, input.connectorId, input.environment)
    .first<{ present: unknown }>();
  return row === null;
}

function parseActiveCustomConnectorAccount(
  row: CustomAccountRow,
): Result<ActiveCustomConnectorAccount, CustomConnectorAccountCommitError> {
  const organisationId = parseStoredOrganisationId(row.organisationId);
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = parseStoredIntegrationAccountId(
    row.integrationAccountId,
  );
  if (!integrationAccountId.ok) return integrationAccountId;
  const providerConnectionId = parseStoredProviderConnectionId(
    row.providerConnectionId,
  );
  if (!providerConnectionId.ok) return providerConnectionId;
  const connectorId = parseCustomConnectorId(row.connectorId);
  if (!connectorId.ok) return accountCorrupt("connectorId");
  const acceptedRevision = parseCustomConnectorRevision(row.acceptedRevision);
  if (!acceptedRevision.ok) return accountCorrupt("acceptedRevision");
  const definitionDigest = parseCustomConnectorDefinitionDigest(
    row.definitionDigest,
  );
  if (!definitionDigest.ok) return accountCorrupt("definitionDigest");
  const environment = parseEnvironment(row.environment);
  if (
    environment === null ||
    typeof row.providerAccountId !== "string" ||
    row.accountKind !== "api_account" ||
    typeof row.displayName !== "string" ||
    row.accountLifecycle !== "active" ||
    row.connectionLifecycle !== "active" ||
    row.bindingLifecycle !== "active" ||
    !isPositiveInteger(row.bindingRevision) ||
    !isPositiveInteger(row.credentialGeneration) ||
    !isNonNegativeInteger(row.createdAt) ||
    !isNonNegativeInteger(row.updatedAt) ||
    (row.isDefaultForConnector !== 0 && row.isDefaultForConnector !== 1)
  ) {
    return accountCorrupt("account");
  }
  return {
    ok: true,
    value: {
      source: { kind: "custom_api", connectorId: connectorId.value },
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      providerConnectionId: providerConnectionId.value,
      environment,
      providerAccountId: row.providerAccountId,
      accountKind: "api_account",
      displayName: row.displayName,
      lifecycle: { kind: "active" },
      binding: {
        lifecycle: "active",
        acceptedRevision: acceptedRevision.value,
        definitionDigest: definitionDigest.value,
        bindingRevision: row.bindingRevision,
        credentialGeneration: row.credentialGeneration,
        isDefaultForConnector: row.isDefaultForConnector === 1,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

function operationId(operation: { readonly id: string }): string {
  return operation.id;
}

function parseStoredOrganisationId(
  raw: unknown,
): Result<OrganisationId, CustomConnectorAccountCommitError> {
  if (typeof raw !== "string") return accountCorrupt("organisationId");
  const parsed = parseOrganisationId(raw);
  return parsed.ok ? parsed : accountCorrupt("organisationId");
}

function parseStoredIntegrationAccountId(
  raw: unknown,
): Result<IntegrationAccountId, CustomConnectorAccountCommitError> {
  if (typeof raw !== "string") return accountCorrupt("integrationAccountId");
  const parsed = parseIntegrationAccountId(raw);
  return parsed.ok ? parsed : accountCorrupt("integrationAccountId");
}

function parseStoredProviderConnectionId(
  raw: unknown,
): Result<ProviderConnectionId, CustomConnectorAccountCommitError> {
  if (typeof raw !== "string") return accountCorrupt("providerConnectionId");
  const parsed = parseProviderConnectionId(raw);
  return parsed.ok ? parsed : accountCorrupt("providerConnectionId");
}

function parseEnvironment(raw: unknown): OrganisationEnvironment | null {
  return raw === "development" || raw === "production" ? raw : null;
}

function accountCorrupt(
  field: string,
): Result<never, CustomConnectorAccountCommitError> {
  return {
    ok: false,
    error: { code: "custom_connector_account_persistence_corrupt", field },
  };
}
