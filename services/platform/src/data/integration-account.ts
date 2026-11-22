import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import type { OnboardingProvider, SurfaceKind } from "@purin-labs/contracts";

import type { InstallModel } from "../boundary";
import type { OrganisationEnvironment } from "./control-plane";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  prepareOnboardingEvent,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import {
  newIntegrationAccountId,
  newProviderConnectionId,
  newProviderWebhookId,
  parseIntegrationAccountId,
  parseProviderConnectionId,
  parseProviderWebhookId,
  parseOrganisationId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type ProviderWebhookId,
  type OrganisationId,
  parseVaultHandle,
  type VaultHandle,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { connectionFlowParts } from "./connection-flow-parts";
import type { Result } from "@purin-labs/kernel/result";
import {
  gmailProductFromScopes,
  parseGmailAuthorizationProduct,
  providerAuthorizationProduct,
  type GmailAuthorizationProduct,
  type ProviderAuthorizationProduct,
} from "../mail/gmail-authorization";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationQuerySource } from "./query-source";
import {
  assertNever,
  isPositiveInteger,
  isRecord,
  isString,
} from "@purin-labs/std";
import {
  prepareDisabledAccountInstallationDelete,
  prepareSurfaceInstallationUpsert,
} from "./surface-installation-writes";
import {
  prepareProjectionRevisionBump,
  prepareReauthProjectionBump,
  prepareUnfencedConfigurationBump,
} from "./organisation-onboarding-row";

export type IntegrationProvider = OnboardingProvider;

type ProviderAuthMode =
  "shared_pantry_app" | "api_key" | "webhook_secret";

export type ProviderConnectionAuthority = {
  readonly kind: "connection_credential";
  readonly credentialGeneration: number;
  readonly credentialRef: VaultHandle;
};

type ProviderConnectionAuthoritySeed = {
  readonly kind: "connection_credential";
  readonly credentialRef: VaultHandle;
};

export type ConnectionCredentialAuthority = ProviderConnectionAuthority;

export function connectionCredentialAuthority(
  authority: ProviderConnectionAuthority,
): ConnectionCredentialAuthority {
  return authority;
}

export function requireConnectionCredentialAuthority(
  connection: ProviderConnection,
): ConnectionCredentialAuthority {
  return connection.authority;
}

export type ProviderConnectionLifecycle =
  | { readonly kind: "connecting" }
  | { readonly kind: "active" }
  | { readonly kind: "reauth_required" }
  | { readonly kind: "disabled"; readonly disabledAt: number }
  | { readonly kind: "revoked"; readonly revokedAt: number };

export type IntegrationAccountLifecycle =
  | { readonly kind: "connecting" }
  | { readonly kind: "pending_activation" }
  | { readonly kind: "active" }
  | { readonly kind: "degraded"; readonly reasonCode: string }
  | { readonly kind: "reauth_required"; readonly reasonCode: string }
  | {
      readonly kind: "disabled";
      readonly disabledByUserId: UserId;
      readonly disabledAt: number;
    }
  | { readonly kind: "revoked"; readonly revokedAt: number };

export type ProviderConnection = {
  readonly providerConnectionId: ProviderConnectionId;
  readonly organisationId: OrganisationId;
  readonly provider: IntegrationProvider;
  readonly providerSubjectId: string;
  readonly authorizationProduct: ProviderAuthorizationProduct;
  readonly environment: OrganisationEnvironment;
  readonly authMode: ProviderAuthMode;
  readonly authority: ProviderConnectionAuthority;
  readonly lifecycle: ProviderConnectionLifecycle;
  readonly grantedScopes: readonly string[];
  readonly createdByUserId: UserId;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type IntegrationAccount = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly accountKind: string;
  readonly displayName: string;
  readonly lifecycle: IntegrationAccountLifecycle;
  readonly isDefaultForProvider: boolean;
  readonly capabilities: readonly string[];
  readonly audiencePolicy: AudiencePolicy;
  readonly retentionPolicy: RetentionPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ActiveIntegrationAccount = Omit<IntegrationAccount, "lifecycle"> & {
  readonly lifecycle: { readonly kind: "active" };
};

type AudiencePolicy =
  | { readonly kind: "operator" }
  | { readonly kind: "customer"; readonly consentRequired: true };

type RetentionPolicy =
  | { readonly kind: "organisation_default" }
  | { readonly kind: "days"; readonly days: number };

type ProviderWebhookLifecycle =
  | { readonly kind: "pending" }
  | { readonly kind: "live"; readonly lastVerifiedAt: number }
  | { readonly kind: "degraded"; readonly reasonCode: string }
  | { readonly kind: "disabled" }
  | { readonly kind: "revoked" };

type ProviderWebhook = {
  readonly providerWebhookId: ProviderWebhookId;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerNativeId: string;
  readonly eventType: string;
  readonly lifecycle: ProviderWebhookLifecycle;
  readonly signingSecretRef: VaultHandle;
  readonly credentialGeneration: number;
  readonly updatedAt: number;
};

export type ConnectedIntegrationSeed = {
  readonly organisationId: OrganisationId;
  readonly provider: IntegrationProvider;
  readonly providerSubjectId: string;
  readonly environment: OrganisationEnvironment;
  readonly authMode: ProviderAuthMode;
  readonly authority: ProviderConnectionAuthoritySeed;
  readonly grantedScopes: readonly string[];
  readonly createdByUserId: UserId;
  readonly providerAccountId: string;
  readonly accountKind: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly audiencePolicy: AudiencePolicy;
  readonly retentionPolicy: RetentionPolicy;
  readonly now: number;
  readonly authorizationProduct?: GmailAuthorizationProduct;
};

export type ConnectedIntegration = {
  readonly connection: ProviderConnection;
  readonly account: IntegrationAccount;
};

export type AccountLookupError =
  | { readonly code: "integration_account_not_found" }
  | {
      readonly code: "integration_account_inactive";
      readonly lifecycle: IntegrationAccountLifecycle["kind"];
    }
  | { readonly code: "integration_account_corrupt"; readonly field: string };

type DisabledIntegrationAccount = Omit<IntegrationAccount, "lifecycle"> & {
  readonly lifecycle: Variant<IntegrationAccountLifecycle, "disabled">;
};

type ProviderCredentialMutation = "reconnect" | "rotate";

export function integrationAccountAllowsCredentialMutation(
  lifecycle: IntegrationAccountLifecycle,
  mutation: ProviderCredentialMutation,
): boolean {
  switch (mutation) {
    case "reconnect":
      return (
        lifecycle.kind === "active" ||
        lifecycle.kind === "disabled" ||
        lifecycle.kind === "degraded" ||
        lifecycle.kind === "reauth_required"
      );
    case "rotate":
      return lifecycle.kind === "active";
  }
}

export function providerConnectionAllowsCredentialMutation(
  lifecycle: ProviderConnectionLifecycle,
  mutation: ProviderCredentialMutation,
): boolean {
  switch (mutation) {
    case "reconnect":
      return (
        lifecycle.kind === "active" ||
        lifecycle.kind === "reauth_required" ||
        lifecycle.kind === "disabled"
      );
    case "rotate":
      return lifecycle.kind === "active";
  }
}

export type IntegrationAccountMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

type DisableIntegrationAccountError =
  | AccountLookupError
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "default_account_replacement_invalid" }
  | { readonly code: "default_account_target_incapable" };

type DisableIntegrationAccountResult = {
  readonly account: DisabledIntegrationAccount;
  readonly receiptId: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

type SwitchDefaultAccountError =
  | AccountLookupError
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "default_account_unchanged" }
  | { readonly code: "default_account_target_inactive" }
  | { readonly code: "default_account_target_incapable" };

type SwitchDefaultAccountResult = {
  readonly previousIntegrationAccountId: IntegrationAccountId | null;
  readonly nextIntegrationAccountId: IntegrationAccountId;
  readonly receiptId: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

export type ActiveProviderAccountContext = {
  readonly account: ActiveIntegrationAccount;
  readonly connection: ProviderConnection & {
    readonly lifecycle: { readonly kind: "active" };
  };
};

export type LiveProviderWebhookContext = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerAccountId: string;
  readonly environment: OrganisationEnvironment;
  readonly signingSecretRef: VaultHandle;
  readonly credentialGeneration: number;
};

export type ActiveProviderAccountTarget = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
};

export type ProviderAccountContextError =
  | AccountLookupError
  | { readonly code: "provider_account_missing" }
  | { readonly code: "provider_connection_inactive" };

type ProviderConnectionRow = {
  providerConnectionId: unknown;
  organisationId: unknown;
  provider: unknown;
  providerSubjectId: unknown;
  authorizationProduct: unknown;
  environment: unknown;
  authMode: unknown;
  authorityKind: unknown;
  credentialGeneration: unknown;
  credentialRef: unknown;
  lifecycle: unknown;
  grantedScopes: unknown;
  createdByUserId: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  disabledAt: unknown;
  revokedAt: unknown;
};

type IntegrationAccountRow = {
  integrationAccountId: unknown;
  organisationId: unknown;
  providerConnectionId: unknown;
  provider: unknown;
  environment: unknown;
  providerAccountId: unknown;
  accountKind: unknown;
  displayName: unknown;
  lifecycle: unknown;
  lifecycleReasonCode: unknown;
  capabilitySet: unknown;
  audiencePolicy: unknown;
  retentionPolicy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  disabledByUserId: unknown;
  disabledAt: unknown;
  revokedAt: unknown;
  isDefaultForProvider: unknown;
};

export async function createConnectedIntegration(
  db: OrganisationDatabase,
  seed: ConnectedIntegrationSeed,
): Promise<ConnectedIntegration> {
  const session = db.withSession("first-primary");
  const existing = await resolveIntegrationAccountByProviderIdentity({
    db: session,
    organisationId: seed.organisationId,
    provider: seed.provider,
    environment: seed.environment,
    providerAccountId: seed.providerAccountId,
    accountKind: seed.accountKind,
  });
  if (!existing.ok && existing.error.code !== "integration_account_not_found") {
    throw new Error(
      `integration account reconnect failed: ${existing.error.code}`,
    );
  }
  const previousConnection =
    existing.ok && existing.value.lifecycle.kind !== "revoked"
      ? await requireReconnectableConnection(session, existing.value)
      : null;
  const providerConnectionId =
    previousConnection === null
      ? newProviderConnectionId()
      : previousConnection.providerConnectionId;
  const integrationAccountId = existing.ok
    ? existing.value.integrationAccountId
    : newIntegrationAccountId();
  const statements =
    existing.ok && previousConnection !== null
      ? reconnectStatements(session, seed, existing.value, previousConnection)
      : newConnectionStatements(
          session,
          seed,
          providerConnectionId,
          integrationAccountId,
        );

  await session.batch([
    ...statements,
    prepareUnfencedConfigurationBump(session, seed.organisationId),
  ]);

  const account = await resolveIntegrationAccountByProviderIdentity({
    db: session,
    organisationId: seed.organisationId,
    provider: seed.provider,
    environment: seed.environment,
    providerAccountId: seed.providerAccountId,
    accountKind: seed.accountKind,
  });
  const connection = await resolveProviderConnection({
    db: session,
    organisationId: seed.organisationId,
    providerConnectionId,
  });
  if (
    !account.ok ||
    !connection.ok ||
    connection.value.lifecycle.kind !== "active"
  ) {
    throw new Error("connected integration persistence invariant failed");
  }
  return {
    connection: connection.value,
    account: account.value,
  };
}

type AdditionalIntegrationAccountSeed = {
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly accountKind: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly audiencePolicy: AudiencePolicy;
  readonly retentionPolicy: RetentionPolicy;
  readonly now: number;
};

type AttachIntegrationAccountError =
  | { readonly code: "provider_connection_not_found" }
  | { readonly code: "provider_connection_inactive" }
  | { readonly code: "provider_connection_scope_mismatch" }
  | {
      readonly code: "integration_account_not_attachable";
      readonly lifecycle: string;
    }
  | AccountLookupError;

/**
 * Adds one more account under an existing provider connection. Providers that
 * grant Pantry several assets at once — a WhatsApp portfolio exposing multiple
 * phone numbers — need many accounts sharing one authority, which the
 * single-account connect path cannot express.
 */
export async function attachIntegrationAccount(
  db: OrganisationDatabase,
  seed: AdditionalIntegrationAccountSeed,
): Promise<Result<IntegrationAccount, AttachIntegrationAccountError>> {
  const session = db.withSession("first-primary");
  const connection = await resolveProviderConnection({
    db: session,
    organisationId: seed.organisationId,
    providerConnectionId: seed.providerConnectionId,
  });
  if (!connection.ok) return connection;
  if (connection.value.lifecycle.kind !== "active") {
    return { ok: false, error: { code: "provider_connection_inactive" } };
  }
  if (
    connection.value.provider !== seed.provider ||
    connection.value.environment !== seed.environment
  ) {
    return { ok: false, error: { code: "provider_connection_scope_mismatch" } };
  }
  const existing = await resolveIntegrationAccountByProviderIdentity({
    db: session,
    organisationId: seed.organisationId,
    provider: seed.provider,
    environment: seed.environment,
    providerAccountId: seed.providerAccountId,
    accountKind: seed.accountKind,
  });
  if (
    existing.ok &&
    (existing.value.lifecycle.kind === "disabled" ||
      (existing.value.lifecycle.kind === "revoked" &&
        existing.value.providerConnectionId === seed.providerConnectionId))
  ) {
    return {
      ok: false,
      error: {
        code: "integration_account_not_attachable",
        lifecycle: existing.value.lifecycle.kind,
      },
    };
  }
  const accountStatement =
    existing.ok && existing.value.lifecycle.kind === "revoked"
      ? recoverRevokedIntegrationAccountStatement(
          session,
          seed,
          existing.value.integrationAccountId,
        )
      : attachIntegrationAccountStatement(session, seed);
  await session.batch([
    accountStatement,
    prepareUnfencedConfigurationBump(session, seed.organisationId),
  ]);
  return resolveIntegrationAccountByProviderIdentity({
    db: session,
    organisationId: seed.organisationId,
    provider: seed.provider,
    environment: seed.environment,
    providerAccountId: seed.providerAccountId,
    accountKind: seed.accountKind,
  });
}

function attachIntegrationAccountStatement(
  session: OrganisationDatabaseSession,
  seed: AdditionalIntegrationAccountSeed,
): D1PreparedStatement {
  return session
    .prepare(
      `INSERT INTO integration_account (
         integration_account_id, organisation_id, provider_connection_id, provider,
         provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code,
         capability_set, audience_policy, retention_policy, created_at, updated_at,
         disabled_by_user_id, disabled_at, revoked_at, environment,
         is_default_for_provider
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, 'pending_activation', NULL, ?, ?, ?, ?, ?,
         NULL, NULL, NULL, ?, 0
       )
       ON CONFLICT (organisation_id, provider, provider_account_id, account_kind)
       WHERE source_kind = 'built_in' DO UPDATE SET
         provider_connection_id = excluded.provider_connection_id,
         display_name = excluded.display_name,
         capability_set = excluded.capability_set,
         audience_policy = excluded.audience_policy,
         retention_policy = excluded.retention_policy,
         environment = excluded.environment,
         updated_at = excluded.updated_at
     WHERE integration_account.lifecycle NOT IN ('disabled', 'revoked')`,
    )
    .bind(
      newIntegrationAccountId(),
      seed.organisationId,
      seed.providerConnectionId,
      seed.provider,
      seed.providerAccountId,
      seed.accountKind,
      seed.displayName,
      JSON.stringify(seed.capabilities),
      JSON.stringify(seed.audiencePolicy),
      JSON.stringify(seed.retentionPolicy),
      seed.now,
      seed.now,
      seed.environment,
    );
}

function recoverRevokedIntegrationAccountStatement(
  session: OrganisationDatabaseSession,
  seed: AdditionalIntegrationAccountSeed,
  integrationAccountId: IntegrationAccountId,
): D1PreparedStatement {
  return session
    .prepare(
      `UPDATE integration_account
     SET provider_connection_id = ?, display_name = ?, lifecycle = 'pending_activation',
         lifecycle_reason_code = NULL, capability_set = ?, audience_policy = ?,
         retention_policy = ?, environment = ?, updated_at = ?,
         disabled_by_user_id = NULL, disabled_at = NULL, revoked_at = NULL
     WHERE organisation_id = ? AND integration_account_id = ? AND lifecycle = 'revoked'`,
    )
    .bind(
      seed.providerConnectionId,
      seed.displayName,
      JSON.stringify(seed.capabilities),
      JSON.stringify(seed.audiencePolicy),
      JSON.stringify(seed.retentionPolicy),
      seed.environment,
      seed.now,
      seed.organisationId,
      integrationAccountId,
    );
}

async function requireReconnectableConnection(
  db: OrganisationQuerySource,
  account: IntegrationAccount,
): Promise<ProviderConnection> {
  const discriminator = await db
    .prepare(
      `SELECT provider, lifecycle
     FROM provider_connection
     WHERE organisation_id = ? AND provider_connection_id = ?
       AND source_kind = 'built_in'`,
    )
    .bind(account.organisationId, account.providerConnectionId)
    .first<{
      readonly provider: unknown;
      readonly lifecycle: unknown;
    }>();
  if (
    discriminator === null ||
    discriminator.provider !== account.provider ||
    discriminator.lifecycle === "revoked"
  ) {
    throw new Error("integration account connection cannot reconnect");
  }
  const connection = await resolveProviderConnection({
    db,
    organisationId: account.organisationId,
    providerConnectionId: account.providerConnectionId,
  });
  if (!connection.ok || connection.value.lifecycle.kind === "revoked") {
    throw new Error("integration account connection cannot reconnect");
  }
  if (connection.value.provider !== account.provider) {
    throw new Error("integration account provider mismatch");
  }
  return connection.value;
}

function newConnectionStatements(
  session: OrganisationDatabaseSession,
  seed: ConnectedIntegrationSeed,
  providerConnectionId: ProviderConnectionId,
  integrationAccountId: IntegrationAccountId,
): D1PreparedStatement[] {
  return [
    session
      .prepare(
        `INSERT INTO provider_connection (
         provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
         credential_generation, credential_ref,
         lifecycle, granted_scopes, created_by_user_id,
         created_at, updated_at, disabled_at, revoked_at, environment,
         provider_subject_id, authorization_product
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        providerConnectionId,
        seed.organisationId,
        seed.provider,
        seed.authMode,
        seed.authority.kind,
        1,
        seed.authority.credentialRef,
        JSON.stringify(seed.grantedScopes),
        seed.createdByUserId,
        seed.now,
        seed.now,
        seed.environment,
        seed.providerSubjectId,
        authorizationProductValue(seed),
      ),
    ...credentialGenerationInsert(session, seed, providerConnectionId, 1),
    session
      .prepare(
        `INSERT INTO integration_account (
         integration_account_id, organisation_id, provider_connection_id, provider,
         provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code,
         capability_set, audience_policy, retention_policy, created_at, updated_at,
         disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, 'pending_activation', NULL, ?, ?, ?, ?, ?,
         NULL, NULL, NULL, ?, 0
       )
       ON CONFLICT (organisation_id, provider, provider_account_id, account_kind)
       WHERE source_kind = 'built_in' DO UPDATE SET
         provider_connection_id = excluded.provider_connection_id,
         display_name = excluded.display_name,
         lifecycle = 'pending_activation',
         lifecycle_reason_code = NULL,
         capability_set = excluded.capability_set,
         audience_policy = excluded.audience_policy,
         retention_policy = excluded.retention_policy,
         environment = excluded.environment,
         updated_at = excluded.updated_at,
         disabled_by_user_id = NULL,
         disabled_at = NULL,
         revoked_at = NULL`,
      )
      .bind(
        integrationAccountId,
        seed.organisationId,
        providerConnectionId,
        seed.provider,
        seed.providerAccountId,
        seed.accountKind,
        seed.displayName,
        JSON.stringify(seed.capabilities),
        JSON.stringify(seed.audiencePolicy),
        JSON.stringify(seed.retentionPolicy),
        seed.now,
        seed.now,
        seed.environment,
      ),
  ];
}

function authorizationProductValue(seed: ConnectedIntegrationSeed): string {
  if (seed.provider !== "gmail") return "standard";
  // Existing seed callers are a request/persistence boundary. Gmail rows that
  // predate the product split are the private full-mailbox pilot branch.
  return seed.authorizationProduct ?? "full_mailbox_pilot";
}

function credentialGenerationInsert(
  session: OrganisationDatabaseSession,
  seed: ConnectedIntegrationSeed,
  providerConnectionId: ProviderConnectionId,
  generation: number,
): D1PreparedStatement[] {
  return [
    session
      .prepare(
        `INSERT INTO provider_credential_generation (
         provider_connection_id, credential_generation, organisation_id, provider,
         environment, credential_ref, lifecycle, created_at, activated_at,
         superseded_at, revoked_at, failed_at, failure_code
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .bind(
        providerConnectionId,
        generation,
        seed.organisationId,
        seed.provider,
        seed.environment,
        seed.authority.credentialRef,
        seed.now,
        seed.now,
      ),
  ];
}

function reconnectAuthorityStatements(
  session: OrganisationDatabaseSession,
  seed: ConnectedIntegrationSeed,
  connection: ProviderConnection,
): D1PreparedStatement[] {
  const previous = connection.authority;
  const replacement = seed.authority.credentialRef;
  return [
    session
      .prepare(
        `UPDATE provider_credential_generation
       SET lifecycle = 'superseded', superseded_at = ?
       WHERE provider_connection_id = ? AND credential_generation = ?
         AND lifecycle = 'active'`,
      )
      .bind(
        seed.now,
        connection.providerConnectionId,
        previous.credentialGeneration,
      ),
    ...credentialGenerationInsert(
      session,
      seed,
      connection.providerConnectionId,
      previous.credentialGeneration + 1,
    ),
    session
      .prepare(
        `UPDATE provider_connection
       SET auth_mode = ?, credential_generation = credential_generation + 1,
           credential_ref = ?, lifecycle = 'active', granted_scopes = ?,
           authorization_product = ?, updated_at = ?, disabled_at = NULL,
           revoked_at = NULL
       WHERE organisation_id = ? AND provider_connection_id = ?
         AND authority_kind = 'connection_credential'
         AND credential_generation = ? AND lifecycle != 'revoked'`,
      )
      .bind(
        seed.authMode,
        replacement,
        JSON.stringify(seed.grantedScopes),
        authorizationProductValue(seed),
        seed.now,
        seed.organisationId,
        connection.providerConnectionId,
        previous.credentialGeneration,
      ),
    connectionFlowParts.use().prepareCredentialRefReplacement(session, {
      organisationId: seed.organisationId,
      provider: seed.provider,
      previousCredentialRef: previous.credentialRef,
      replacementCredentialRef: replacement,
    }),
  ];
}

function reconnectStatements(
  session: OrganisationDatabaseSession,
  seed: ConnectedIntegrationSeed,
  account: IntegrationAccount,
  connection: ProviderConnection,
): D1PreparedStatement[] {
  return [
    ...reconnectAuthorityStatements(session, seed, connection),
    ...reconnectAccountStatements(session, seed, account),
  ];
}

function reconnectAccountStatements(
  session: OrganisationDatabaseSession,
  seed: ConnectedIntegrationSeed,
  account: IntegrationAccount,
): D1PreparedStatement[] {
  const lifecycle = reconnectAccountLifecycle(account.lifecycle);
  return [
    session
      .prepare(
        `UPDATE integration_account
       SET display_name = ?, lifecycle = ?, lifecycle_reason_code = NULL,
           capability_set = ?, audience_policy = ?, retention_policy = ?,
           updated_at = ?, disabled_by_user_id = NULL,
           disabled_at = NULL, revoked_at = NULL
       WHERE organisation_id = ? AND integration_account_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(
        seed.displayName,
        lifecycle,
        JSON.stringify(seed.capabilities),
        JSON.stringify(seed.audiencePolicy),
        JSON.stringify(seed.retentionPolicy),
        seed.now,
        seed.organisationId,
        account.integrationAccountId,
      ),
    session
      .prepare(
        `UPDATE provider_webhook
       SET lifecycle = 'disabled', lifecycle_reason_code = NULL, last_verified_at = NULL,
           updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(seed.now, seed.organisationId, account.integrationAccountId),
  ];
}

function reconnectAccountLifecycle(
  lifecycle: IntegrationAccountLifecycle,
): "pending_activation" | "active" {
  switch (lifecycle.kind) {
    case "connecting":
    case "pending_activation":
      return "pending_activation";
    case "active":
    case "degraded":
    case "reauth_required":
    case "disabled":
      return "active";
    case "revoked":
      throw new Error("revoked integration account cannot reconnect");
    default:
      return assertNever(lifecycle);
  }
}

export async function createActiveConnectedIntegration(
  db: OrganisationDatabase,
  seed: ConnectedIntegrationSeed,
): Promise<{
  readonly connection: ProviderConnection & {
    readonly lifecycle: { readonly kind: "active" };
  };
  readonly account: ActiveIntegrationAccount;
}> {
  const connected = await createConnectedIntegration(db, seed);
  const activated = await setIntegrationAccountLifecycle({
    db,
    organisationId: seed.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: seed.now,
  });

  if (!activated.ok || activated.value.lifecycle.kind !== "active") {
    throw new Error("connected integration activation invariant failed");
  }

  return {
    connection: buildActiveProviderConnection(connected.connection),
    account: buildActiveIntegrationAccount(activated.value),
  };
}

export async function finalizeConnectedIntegrationAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly now: number;
}): Promise<Result<ActiveIntegrationAccount, AccountLookupError>> {
  const account = await resolveIntegrationAccount(input);
  if (!account.ok) {
    return account;
  }
  if (
    account.value.lifecycle.kind === "revoked" ||
    account.value.lifecycle.kind === "disabled"
  ) {
    return {
      ok: false,
      error: {
        code: "integration_account_inactive",
        lifecycle: account.value.lifecycle.kind,
      },
    };
  }
  const session = input.db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `UPDATE integration_account
       SET lifecycle = 'active', lifecycle_reason_code = NULL,
           disabled_by_user_id = NULL, disabled_at = NULL,
           revoked_at = NULL, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle NOT IN ('disabled', 'revoked')`,
      )
      .bind(input.now, input.organisationId, input.integrationAccountId),
    session
      .prepare(
        `UPDATE integration_account
       SET is_default_for_provider = 1, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM integration_account AS current_default
           WHERE current_default.organisation_id = integration_account.organisation_id
             AND current_default.provider = integration_account.provider
             AND current_default.environment = integration_account.environment
             AND current_default.is_default_for_provider = 1
             AND current_default.lifecycle = 'active'
         )`,
      )
      .bind(input.now, input.organisationId, input.integrationAccountId),
    connectionFlowParts.use().prepareResolveOpenSupportReferences(session, {
      organisationId: input.organisationId,
      provider: account.value.provider,
      now: input.now,
    }),
    prepareProjectionRevisionBump(session, input.organisationId),
  ]);
  const finalized = await resolveIntegrationAccount({
    db: session,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!finalized.ok || finalized.value.lifecycle.kind !== "active") {
    throw new Error("integration account finalization invariant failed");
  }
  return { ok: true, value: buildActiveIntegrationAccount(finalized.value) };
}

export async function disableIntegrationAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly replacementIntegrationAccountId: IntegrationAccountId | null;
  readonly disabledByUserId: UserId;
  readonly reasonCode: "merchant_disabled" | "support_admin_disabled";
  readonly mutation: IntegrationAccountMutation;
  readonly now: number;
}): Promise<
  Result<DisableIntegrationAccountResult, DisableIntegrationAccountError>
> {
  const account = await resolveIntegrationAccount(input);
  if (!account.ok) {
    return account;
  }
  if (account.value.lifecycle.kind === "disabled") {
    return {
      ok: false,
      error: { code: "integration_account_inactive", lifecycle: "disabled" },
    };
  }
  const session = input.db.withSession("first-primary");
  const state = await readAccountMutationState(session, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const replacement = await resolveDisableReplacement({
    db: session,
    account: account.value,
    replacementIntegrationAccountId: input.replacementIntegrationAccountId,
  });
  if (!replacement.ok) {
    return replacement;
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const receipt = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    integration_account_id: input.integrationAccountId,
  };
  const defaultAccountStatements = disableDefaultAccountStatements(
    session,
    account.value,
    replacement.value,
    input.disabledByUserId,
    configurationVersion,
    input.mutation.identity.receiptId,
    input.now,
  );
  const bindingTransition =
    replacement.value === null
      ? { ok: true as const, value: [] as readonly D1PreparedStatement[] }
      : await prepareDefaultAccountBindingTransition(
          session,
          replacement.value,
          input.now,
        );
  if (!bindingTransition.ok) {
    return bindingTransition;
  }
  await session.batch([
    ...defaultAccountStatements,
    ...bindingTransition.value,
    session
      .prepare(
        `UPDATE integration_account
       SET lifecycle = 'disabled', lifecycle_reason_code = NULL,
           disabled_by_user_id = ?, disabled_at = ?, revoked_at = NULL,
           updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(
        input.disabledByUserId,
        input.now,
        input.now,
        input.organisationId,
        input.integrationAccountId,
      ),
    session
      .prepare(
        `UPDATE provider_webhook
       SET lifecycle = 'disabled', lifecycle_reason_code = NULL, last_verified_at = NULL,
           updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ? AND lifecycle != 'revoked'`,
      )
      .bind(input.now, input.organisationId, input.integrationAccountId),
    prepareDisabledAccountInstallationDelete(session, {
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
    }),
    session
      .prepare(
        `UPDATE provider_connection
       SET lifecycle = 'disabled', disabled_at = ?, updated_at = ?
       WHERE organisation_id = ? AND provider_connection_id = ? AND lifecycle != 'revoked'
         AND NOT EXISTS (
           SELECT 1 FROM integration_account
           WHERE provider_connection_id = provider_connection.provider_connection_id
             AND integration_account_id != ?
             AND lifecycle NOT IN ('disabled', 'revoked')
         )`,
      )
      .bind(
        input.now,
        input.now,
        input.organisationId,
        account.value.providerConnectionId,
        input.integrationAccountId,
      ),
    prepareUnfencedConfigurationBump(session, input.organisationId),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: account.value.environment,
      actorUserId: input.disabledByUserId,
      operation: "provider.account.disable",
      targetKind: "integration_account",
      targetId: input.integrationAccountId,
      oldLifecycle: account.value.lifecycle.kind,
      newLifecycle: "disabled",
      configurationVersion,
      projectionRevision,
      reasonCode: input.reasonCode,
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.organisationId,
      environment: account.value.environment,
      projectionRevision,
      attributes: {
        reason_code: "provider_account_disabled",
        integration_account_id: input.integrationAccountId,
      },
    }),
  ]);
  const disabled = await resolveIntegrationAccount({
    db: session,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!disabled.ok || disabled.value.lifecycle.kind !== "disabled") {
    throw new Error("integration account disable invariant failed");
  }
  return {
    ok: true,
    value: {
      account: buildDisabledIntegrationAccount(disabled.value),
      receiptId: input.mutation.identity.receiptId,
      configurationVersion,
      projectionRevision,
    },
  };
}

export async function switchDefaultIntegrationAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly nextIntegrationAccountId: IntegrationAccountId;
  readonly changedByUserId: UserId;
  readonly mutation: IntegrationAccountMutation;
  readonly now: number;
}): Promise<Result<SwitchDefaultAccountResult, SwitchDefaultAccountError>> {
  const session = input.db.withSession("first-primary");
  const state = await readAccountMutationState(session, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  const next = await resolveIntegrationAccount({
    db: session,
    organisationId: input.organisationId,
    integrationAccountId: input.nextIntegrationAccountId,
  });
  if (!next.ok) {
    return next;
  }
  if (next.value.lifecycle.kind !== "active") {
    return { ok: false, error: { code: "default_account_target_inactive" } };
  }
  const previous = await readDefaultAccount(
    session,
    input.organisationId,
    next.value.provider,
    next.value.environment,
  );
  if (previous?.integrationAccountId === next.value.integrationAccountId) {
    return { ok: false, error: { code: "default_account_unchanged" } };
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const responseBody = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    integration_account_id: next.value.integrationAccountId,
  };
  const statements: D1PreparedStatement[] = [];
  const bindingTransition = await prepareDefaultAccountBindingTransition(
    session,
    next.value,
    input.now,
  );
  if (!bindingTransition.ok) {
    return bindingTransition;
  }
  if (previous !== null) {
    statements.push(
      session
        .prepare(
          `UPDATE integration_account SET is_default_for_provider = 0, updated_at = ?
         WHERE organisation_id = ? AND integration_account_id = ? AND is_default_for_provider = 1`,
        )
        .bind(input.now, input.organisationId, previous.integrationAccountId),
    );
  }
  statements.push(
    session
      .prepare(
        `UPDATE integration_account SET is_default_for_provider = 1, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = 'active' AND is_default_for_provider = 0`,
      )
      .bind(input.now, input.organisationId, next.value.integrationAccountId),
    ...bindingTransition.value,
    prepareUnfencedConfigurationBump(session, input.organisationId),
    session
      .prepare(
        `INSERT INTO provider_default_account_history (
         default_account_change_receipt_id, organisation_id, provider, environment,
         previous_integration_account_id, next_integration_account_id,
         changed_by_user_id, configuration_version, changed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.mutation.identity.receiptId,
        input.organisationId,
        next.value.provider,
        next.value.environment,
        previous?.integrationAccountId ?? null,
        next.value.integrationAccountId,
        input.changedByUserId,
        configurationVersion,
        input.now,
      ),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: next.value.environment,
      actorUserId: input.changedByUserId,
      operation: "provider.account.set_default_for_provider",
      targetKind: "integration_account",
      targetId: next.value.integrationAccountId,
      oldLifecycle: previous === null ? null : "default_for_provider",
      newLifecycle: "default_for_provider",
      configurationVersion,
      projectionRevision,
      reasonCode: "merchant_selected",
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "default_account_changed",
      organisationId: input.organisationId,
      environment: next.value.environment,
      projectionRevision,
      attributes: {
        provider: next.value.provider,
        integration_account_id: next.value.integrationAccountId,
      },
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.organisationId,
      environment: next.value.environment,
      projectionRevision,
      attributes: {
        reason_code: "default_account_changed",
        configuration_version: configurationVersion,
      },
    }),
  );
  await session.batch(statements);
  return {
    ok: true,
    value: {
      previousIntegrationAccountId: previous?.integrationAccountId ?? null,
      nextIntegrationAccountId: next.value.integrationAccountId,
      receiptId: input.mutation.identity.receiptId,
      configurationVersion,
      projectionRevision,
    },
  };
}

async function prepareDefaultAccountBindingTransition(
  db: OrganisationQuerySource,
  next: IntegrationAccount,
  now: number,
): Promise<
  Result<
    readonly D1PreparedStatement[],
    { readonly code: "default_account_target_incapable" }
  >
> {
  if (next.provider === "slack") {
    const configuredDestination = await db
      .prepare(
        `SELECT 1 AS configured FROM organisation_communication_destination WHERE organisation_id = ?`,
      )
      .bind(next.organisationId)
      .first<{ readonly configured: unknown }>();
    if (configuredDestination === null) return { ok: true, value: [] };
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
      .bind(
        next.integrationAccountId,
        next.integrationAccountId,
        next.organisationId,
      )
      .first<{ readonly capable: unknown }>();
    if (destination?.capable !== 1) {
      return { ok: false, error: { code: "default_account_target_incapable" } };
    }
    return {
      ok: true,
      value: [
        connectionFlowParts.use().prepareCommunicationDestinationAccount(db, {
          organisationId: next.organisationId,
          integrationAccountId: next.integrationAccountId,
          now,
        }),
      ],
    };
  }
  return { ok: true, value: [] };
}

async function readDefaultAccount(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  provider: IntegrationProvider,
  environment: OrganisationEnvironment,
): Promise<IntegrationAccount | null> {
  const row = await db
    .prepare(
      accountSelect(
        `WHERE integration_account.organisation_id = ?
       AND integration_account.source_kind = 'built_in'
       AND integration_account.provider = ?
       AND integration_account.environment = ?
       AND integration_account.is_default_for_provider = 1`,
      ),
    )
    .bind(organisationId, provider, environment)
    .first<IntegrationAccountRow>();
  return row === null ? null : requireIntegrationAccountRow(row);
}

export async function resolveDisableReplacement(input: {
  readonly db: OrganisationQuerySource;
  readonly account: IntegrationAccount;
  readonly replacementIntegrationAccountId: IntegrationAccountId | null;
}): Promise<Result<IntegrationAccount | null, DisableIntegrationAccountError>> {
  if (input.replacementIntegrationAccountId === null) {
    return { ok: true, value: null };
  }
  if (!input.account.isDefaultForProvider) {
    return {
      ok: false,
      error: { code: "default_account_replacement_invalid" },
    };
  }
  const replacement = await resolveIntegrationAccount({
    db: input.db,
    organisationId: input.account.organisationId,
    integrationAccountId: input.replacementIntegrationAccountId,
  });
  if (
    !replacement.ok ||
    replacement.value.integrationAccountId ===
      input.account.integrationAccountId ||
    replacement.value.provider !== input.account.provider ||
    replacement.value.environment !== input.account.environment ||
    replacement.value.lifecycle.kind !== "active"
  ) {
    return {
      ok: false,
      error: { code: "default_account_replacement_invalid" },
    };
  }
  return { ok: true, value: replacement.value };
}

function disableDefaultAccountStatements(
  db: OrganisationQuerySource,
  account: IntegrationAccount,
  replacement: IntegrationAccount | null,
  actorUserId: UserId,
  configurationVersion: number,
  receiptId: string,
  now: number,
): readonly D1PreparedStatement[] {
  if (!account.isDefaultForProvider) {
    return [];
  }
  const clearCurrentDefault = db
    .prepare(
      `UPDATE integration_account
     SET is_default_for_provider = 0, updated_at = ?
     WHERE organisation_id = ? AND integration_account_id = ? AND is_default_for_provider = 1`,
    )
    .bind(now, account.organisationId, account.integrationAccountId);
  if (replacement === null) return [clearCurrentDefault];
  return [
    clearCurrentDefault,
    db
      .prepare(
        `UPDATE integration_account
       SET is_default_for_provider = 1, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?
         AND lifecycle = 'active' AND is_default_for_provider = 0`,
      )
      .bind(now, account.organisationId, replacement.integrationAccountId),
    db
      .prepare(
        `INSERT INTO provider_default_account_history (
         default_account_change_receipt_id, organisation_id, provider, environment,
         previous_integration_account_id, next_integration_account_id,
         changed_by_user_id, configuration_version, changed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        receiptId,
        account.organisationId,
        account.provider,
        account.environment,
        account.integrationAccountId,
        replacement.integrationAccountId,
        actorUserId,
        configurationVersion,
        now,
      ),
  ];
}

export async function readAccountMutationState(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<{
  readonly configurationVersion: number;
  readonly projectionRevision: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly configurationVersion: unknown;
      readonly projectionRevision: unknown;
    }>();
  if (
    row === null ||
    typeof row.configurationVersion !== "number" ||
    typeof row.projectionRevision !== "number"
  ) {
    return null;
  }
  return {
    configurationVersion: row.configurationVersion,
    projectionRevision: row.projectionRevision,
  };
}

export async function listIntegrationAccounts(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<readonly IntegrationAccount[]> {
  const rows = await input.db
    .prepare(
      accountSelect(
        `WHERE integration_account.organisation_id = ?
         AND integration_account.source_kind = 'built_in'
         ORDER BY integration_account.provider, integration_account.display_name`,
      ),
    )
    .bind(input.organisationId)
    .all<IntegrationAccountRow>();
  return (rows.results ?? []).map(requireIntegrationAccountRow);
}

export async function resolveIntegrationAccount(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<Result<IntegrationAccount, AccountLookupError>> {
  const row = await input.db
    .prepare(
      accountSelect(
        `WHERE integration_account.organisation_id = ?
         AND integration_account.source_kind = 'built_in'
         AND integration_account.integration_account_id = ?`,
      ),
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<IntegrationAccountRow>();
  return parseOptionalIntegrationAccount(row);
}

async function resolveActiveIntegrationAccount(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<Result<ActiveIntegrationAccount, AccountLookupError>> {
  const account = await resolveIntegrationAccount(input);
  if (!account.ok) {
    return account;
  }
  return account.value.lifecycle.kind === "active"
    ? { ok: true, value: buildActiveIntegrationAccount(account.value) }
    : {
        ok: false,
        error: {
          code: "integration_account_inactive",
          lifecycle: account.value.lifecycle.kind,
        },
      };
}

export async function resolveActiveProviderAccountContext(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<Result<ActiveProviderAccountContext, ProviderAccountContextError>> {
  const account = await resolveActiveIntegrationAccount(input);
  if (!account.ok) {
    return account;
  }
  const connection = await resolveProviderConnection({
    db: input.db,
    organisationId: input.organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (!connection.ok || connection.value.lifecycle.kind !== "active") {
    return { ok: false, error: { code: "provider_connection_inactive" } };
  }
  return {
    ok: true,
    value: {
      account: account.value,
      connection: buildActiveProviderConnection(connection.value),
    },
  };
}

export async function listLiveProviderWebhookContexts(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly provider: IntegrationProvider;
  readonly providerAccountId: string | null;
}): Promise<readonly LiveProviderWebhookContext[]> {
  const accountFilter =
    input.providerAccountId === null
      ? ""
      : " AND integration_account.provider_account_id = ?";
  const statement = input.db.prepare(
    `SELECT provider_webhook.integration_account_id AS integrationAccountId,
            integration_account.provider_account_id AS providerAccountId,
            provider_webhook.environment AS environment,
            provider_webhook.signing_secret_ref AS signingSecretRef,
            provider_webhook.credential_generation AS credentialGeneration
     FROM provider_webhook
     JOIN integration_account
       ON integration_account.integration_account_id = provider_webhook.integration_account_id
     JOIN provider_connection
       ON provider_connection.provider_connection_id = integration_account.provider_connection_id
     JOIN provider_credential_generation
       ON provider_credential_generation.provider_connection_id =
            provider_connection.provider_connection_id
      AND provider_credential_generation.credential_generation =
            provider_connection.credential_generation
     JOIN organisation
       ON organisation.organisation_id = integration_account.organisation_id
      AND organisation.status = 'active'
     JOIN organisation_onboarding
       ON organisation_onboarding.organisation_id = integration_account.organisation_id
      AND organisation_onboarding.environment = integration_account.environment
      AND organisation_onboarding.lifecycle = 'active'
     WHERE provider_webhook.organisation_id = ? AND provider_webhook.provider = ?
       AND provider_webhook.lifecycle = 'live'
       AND provider_webhook.organisation_id = integration_account.organisation_id
       AND provider_webhook.provider = integration_account.provider
       AND provider_webhook.environment = integration_account.environment
       AND integration_account.lifecycle = 'active'
       AND provider_connection.organisation_id = integration_account.organisation_id
       AND provider_connection.provider = integration_account.provider
       AND provider_connection.environment = integration_account.environment
       AND provider_connection.lifecycle = 'active'
       AND provider_connection.credential_generation =
            provider_webhook.credential_generation
       AND provider_credential_generation.organisation_id = provider_connection.organisation_id
       AND provider_credential_generation.provider = provider_connection.provider
       AND provider_credential_generation.environment = provider_connection.environment
       AND provider_credential_generation.credential_ref =
            provider_connection.credential_ref
       AND provider_credential_generation.lifecycle = 'active'${accountFilter}
     ORDER BY provider_webhook.integration_account_id, provider_webhook.provider_webhook_id`,
  );
  const bound =
    input.providerAccountId === null
      ? statement.bind(input.organisationId, input.provider)
      : statement.bind(
          input.organisationId,
          input.provider,
          input.providerAccountId,
        );
  const rows = await bound.all<{
    integrationAccountId: unknown;
    providerAccountId: unknown;
    environment: unknown;
    signingSecretRef: unknown;
    credentialGeneration: unknown;
  }>();
  return (rows.results ?? []).map(requireLiveProviderWebhookContext);
}

export async function listRegionalProviderAccountTargets(input: {
  readonly env: OrganisationPlacementBindings;
  readonly provider: IntegrationProvider;
  readonly providerAccountId: string;
  readonly providerNativeId: string;
}): Promise<readonly ActiveProviderAccountTarget[]> {
  const targets: ActiveProviderAccountTarget[] = [];
  for (const database of configuredOrganisationDatabases(input.env)) {
    const candidates = await listActiveProviderAccountTargets({
      db: database,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerNativeId: input.providerNativeId,
    });
    for (const candidate of candidates) {
      const scope = await OrganisationExecutionScope.resolve(
        input.env,
        candidate.organisationId,
      );
      if (!scope.ok) throw new Error(scope.error.code);
      if (scope.value.database === database) targets.push(candidate);
    }
  }
  return targets;
}

export async function listActiveProviderAccountTargets(input: {
  readonly db: OrganisationQuerySource;
  readonly provider: IntegrationProvider;
  readonly providerAccountId: string;
  readonly providerNativeId: string;
}): Promise<readonly ActiveProviderAccountTarget[]> {
  const rows = await input.db
    .prepare(
      `SELECT integration_account.organisation_id AS organisationId,
            integration_account.integration_account_id AS integrationAccountId
     FROM integration_account
     JOIN provider_connection
       ON provider_connection.provider_connection_id = integration_account.provider_connection_id
     JOIN provider_webhook
       ON provider_webhook.integration_account_id = integration_account.integration_account_id
     WHERE integration_account.provider = ?
       AND integration_account.provider_account_id = ?
       AND integration_account.lifecycle = 'active'
       AND provider_connection.lifecycle = 'active'
       AND provider_webhook.provider = ?
       AND provider_webhook.provider_native_id = ?
       AND provider_webhook.lifecycle = 'live'
     ORDER BY integration_account.organisation_id, integration_account.integration_account_id`,
    )
    .bind(
      input.provider,
      input.providerAccountId,
      input.provider,
      input.providerNativeId,
    )
    .all<{
      organisationId: unknown;
      integrationAccountId: unknown;
    }>();
  return (rows.results ?? []).map(requireActiveProviderAccountTarget);
}

function buildActiveIntegrationAccount(
  account: IntegrationAccount,
): ActiveIntegrationAccount {
  return {
    integrationAccountId: account.integrationAccountId,
    organisationId: account.organisationId,
    providerConnectionId: account.providerConnectionId,
    provider: account.provider,
    environment: account.environment,
    providerAccountId: account.providerAccountId,
    accountKind: account.accountKind,
    displayName: account.displayName,
    lifecycle: { kind: "active" },
    isDefaultForProvider: account.isDefaultForProvider,
    capabilities: account.capabilities,
    audiencePolicy: account.audiencePolicy,
    retentionPolicy: account.retentionPolicy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function buildActiveProviderConnection(
  connection: ProviderConnection,
): ProviderConnection & { readonly lifecycle: { readonly kind: "active" } } {
  if (connection.lifecycle.kind !== "active") {
    throw new Error(
      "active provider connection builder received inactive lifecycle",
    );
  }
  return {
    providerConnectionId: connection.providerConnectionId,
    organisationId: connection.organisationId,
    provider: connection.provider,
    providerSubjectId: connection.providerSubjectId,
    authorizationProduct: connection.authorizationProduct,
    environment: connection.environment,
    authMode: connection.authMode,
    authority: connection.authority,
    lifecycle: { kind: "active" },
    grantedScopes: connection.grantedScopes,
    createdByUserId: connection.createdByUserId,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function buildDisabledIntegrationAccount(
  account: IntegrationAccount,
): DisabledIntegrationAccount {
  if (account.lifecycle.kind !== "disabled") {
    throw new Error(
      "disabled integration account builder received active lifecycle",
    );
  }
  return {
    integrationAccountId: account.integrationAccountId,
    organisationId: account.organisationId,
    providerConnectionId: account.providerConnectionId,
    provider: account.provider,
    environment: account.environment,
    providerAccountId: account.providerAccountId,
    accountKind: account.accountKind,
    displayName: account.displayName,
    lifecycle: account.lifecycle,
    isDefaultForProvider: account.isDefaultForProvider,
    capabilities: account.capabilities,
    audiencePolicy: account.audiencePolicy,
    retentionPolicy: account.retentionPolicy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function resolveIntegrationAccountByProviderIdentity(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly accountKind: string;
}): Promise<Result<IntegrationAccount, AccountLookupError>> {
  const row = await input.db
    .prepare(
      accountSelect(
        `WHERE integration_account.organisation_id = ? AND integration_account.provider = ?
       AND integration_account.source_kind = 'built_in'
       AND integration_account.environment = ?
       AND integration_account.provider_account_id = ? AND integration_account.account_kind = ?`,
      ),
    )
    .bind(
      input.organisationId,
      input.provider,
      input.environment,
      input.providerAccountId,
      input.accountKind,
    )
    .first<IntegrationAccountRow>();
  return parseOptionalIntegrationAccount(row);
}

export async function resolveProviderConnection(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
}): Promise<
  Result<ProviderConnection, { readonly code: "provider_connection_not_found" }>
> {
  const row = await input.db
    .prepare(
      `SELECT provider_connection_id AS providerConnectionId, organisation_id AS organisationId,
            provider, auth_mode AS authMode, authority_kind AS authorityKind,
            credential_generation AS credentialGeneration,
            credential_ref AS credentialRef,
            lifecycle, granted_scopes AS grantedScopes,
            created_by_user_id AS createdByUserId,
            provider_subject_id AS providerSubjectId, authorization_product AS authorizationProduct,
            environment,
            created_at AS createdAt, updated_at AS updatedAt,
            disabled_at AS disabledAt, revoked_at AS revokedAt
     FROM provider_connection
     WHERE organisation_id = ? AND provider_connection_id = ?
       AND source_kind = 'built_in'`,
    )
    .bind(input.organisationId, input.providerConnectionId)
    .first<ProviderConnectionRow>();
  return row === null
    ? { ok: false, error: { code: "provider_connection_not_found" } }
    : { ok: true, value: requireProviderConnectionRow(row) };
}

export async function setIntegrationAccountLifecycle(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly lifecycle: IntegrationAccountLifecycle;
  readonly now: number;
}): Promise<Result<IntegrationAccount, AccountLookupError>> {
  const existing = await resolveIntegrationAccount(input);
  if (!existing.ok) {
    return existing;
  }
  const columns = lifecycleColumns(input.lifecycle);
  const session = input.db.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `UPDATE integration_account
       SET lifecycle = ?, lifecycle_reason_code = ?, disabled_by_user_id = ?,
           disabled_at = ?, revoked_at = ?, updated_at = ?
       WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(
        input.lifecycle.kind,
        columns.reasonCode,
        columns.disabledBy,
        columns.disabledAt,
        columns.revokedAt,
        input.now,
        input.organisationId,
        input.integrationAccountId,
      ),
    prepareProjectionRevisionBump(session, input.organisationId),
  ]);
  const lifecycleUpdate = results[0];
  if (lifecycleUpdate === undefined || lifecycleUpdate.meta.changes !== 1) {
    throw new Error("integration account lifecycle update invariant failed");
  }
  return resolveIntegrationAccount({
    db: session,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
}

/**
 * Records that the provider refused the account's sign-in, so that the
 * Portal asks a person to reconnect it. Only the active account that the
 * caller read changes: a reconnect or another change since then gives the
 * account a new `updated_at`, and the write then changes nothing. A refusal
 * that the account already records writes no row.
 */
export async function markIntegrationAccountReauthRequired(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly readUpdatedAt: number;
  readonly reasonCode: string;
  readonly now: number;
}): Promise<boolean> {
  const session = input.db.withSession("first-primary");
  const [marked] = await session.batch([
    session
      .prepare(
        `UPDATE integration_account
         SET lifecycle = 'reauth_required', lifecycle_reason_code = ?,
             updated_at = ?
         WHERE organisation_id = ? AND integration_account_id = ?
           AND lifecycle = 'active' AND updated_at = ?`,
      )
      .bind(
        input.reasonCode,
        input.now,
        input.organisationId,
        input.integrationAccountId,
        input.readUpdatedAt,
      ),
    prepareReauthProjectionBump(session, {
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      now: input.now,
    }),
  ]);
  return marked !== undefined && marked.meta.changes === 1;
}

export async function upsertSurfaceInstallation(input: {
  readonly db: OrganisationDatabase;
  readonly account: IntegrationAccount;
  readonly surfaceKind: SurfaceKind;
  readonly workspaceId: string;
  readonly installModel: InstallModel;
  readonly botTokenRef: VaultHandle;
  readonly scopes: readonly string[];
  readonly installedAt: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  await session.batch([
    prepareSurfaceInstallationUpsert(session, {
      integrationAccountId: input.account.integrationAccountId,
      organisationId: input.account.organisationId,
      surfaceKind: input.surfaceKind,
      workspaceId: input.workspaceId,
      installModel: input.installModel,
      botTokenRef: input.botTokenRef,
      scopes: JSON.stringify(input.scopes),
      installedAt: input.installedAt,
    }),
    prepareProjectionRevisionBump(session, input.account.organisationId),
  ]);
}

export async function upsertProviderWebhook(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerNativeId: string;
  readonly eventType: string;
  readonly signingSecretRef: VaultHandle;
  readonly credentialGeneration: number;
  readonly lifecycle: ProviderWebhookLifecycle;
  readonly now: number;
}): Promise<ProviderWebhook> {
  const session = input.db.withSession("first-primary");
  const existing = await session
    .prepare(
      `SELECT provider_webhook_id AS providerWebhookId
     FROM provider_webhook
     WHERE integration_account_id = ? AND provider_native_id = ? AND event_type = ?`,
    )
    .bind(input.integrationAccountId, input.providerNativeId, input.eventType)
    .first<{ providerWebhookId: string }>();
  const providerWebhookId =
    existing === null
      ? newProviderWebhookId()
      : requireParsedProviderWebhookId(existing.providerWebhookId);
  const columns = webhookLifecycleColumns(input.lifecycle);
  await session.batch([
    session
      .prepare(
        `INSERT INTO provider_webhook (
         provider_webhook_id, organisation_id, integration_account_id, provider,
         provider_native_id, event_type, lifecycle, lifecycle_reason_code,
         signing_secret_ref, credential_generation, last_verified_at, updated_at, environment
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (integration_account_id, provider_native_id, event_type) DO UPDATE SET
         lifecycle = excluded.lifecycle, lifecycle_reason_code = excluded.lifecycle_reason_code,
         signing_secret_ref = excluded.signing_secret_ref,
         credential_generation = excluded.credential_generation,
         last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
      )
      .bind(
        providerWebhookId,
        input.organisationId,
        input.integrationAccountId,
        input.provider,
        input.providerNativeId,
        input.eventType,
        input.lifecycle.kind,
        columns.reasonCode,
        input.signingSecretRef,
        input.credentialGeneration,
        columns.lastVerifiedAt,
        input.now,
        input.environment,
      ),
    prepareProjectionRevisionBump(session, input.organisationId),
  ]);
  return {
    providerWebhookId,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider: input.provider,
    environment: input.environment,
    providerNativeId: input.providerNativeId,
    eventType: input.eventType,
    lifecycle: input.lifecycle,
    signingSecretRef: input.signingSecretRef,
    credentialGeneration: input.credentialGeneration,
    updatedAt: input.now,
  };
}

const INTEGRATION_PROVIDERS: Readonly<Record<IntegrationProvider, true>> = {
  airtable: true,
  discord: true,
  dropbox: true,
  gmail: true,
  google_drive: true,
  notion: true,
  shopify: true,
  slack: true,
  square: true,
  stripe: true,
  whatsapp: true,
  // Supplier payout rails. Identity only: an account can be named and stored,
  // which is what a payout binding needs to point at. Connecting one is a
  // separate adapter that does not exist yet.
  gmo_aozora: true,
  wise: true,
};

function isIntegrationProvider(raw: unknown): raw is IntegrationProvider {
  return typeof raw === "string" && Object.hasOwn(INTEGRATION_PROVIDERS, raw);
}

export function parseIntegrationProvider(
  raw: unknown,
): Result<IntegrationProvider, { readonly code: "invalid_provider" }> {
  return isIntegrationProvider(raw)
    ? { ok: true, value: raw }
    : { ok: false, error: { code: "invalid_provider" } };
}

function accountSelect(where: string): string {
  return `SELECT integration_account_id AS integrationAccountId, organisation_id AS organisationId,
                 provider_connection_id AS providerConnectionId, provider,
                 environment, is_default_for_provider AS isDefaultForProvider,
                 provider_account_id AS providerAccountId, account_kind AS accountKind,
                 display_name AS displayName, lifecycle,
                 lifecycle_reason_code AS lifecycleReasonCode,
                 capability_set AS capabilitySet, audience_policy AS audiencePolicy,
                 retention_policy AS retentionPolicy, created_at AS createdAt,
                 updated_at AS updatedAt,
                 disabled_by_user_id AS disabledByUserId,
                 disabled_at AS disabledAt, revoked_at AS revokedAt
          FROM integration_account ${where}`;
}

function parseOptionalIntegrationAccount(
  row: IntegrationAccountRow | null,
): Result<IntegrationAccount, AccountLookupError> {
  if (row === null) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  try {
    return { ok: true, value: requireIntegrationAccountRow(row) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "integration_account_corrupt",
        field: error instanceof Error ? error.message : "unknown",
      },
    };
  }
}

function requireProviderConnectionRow(
  row: ProviderConnectionRow,
): ProviderConnection {
  const providerConnectionId = requireParsed(
    parseProviderConnectionId,
    row.providerConnectionId,
    "providerConnectionId",
  );
  const organisationId = requireParsed(
    parseOrganisationId,
    row.organisationId,
    "organisationId",
  );
  const provider = requireProvider(row.provider);
  const environment = requireOrganisationEnvironment(row.environment);
  const createdByUserId = requireParsed(
    parseUserId,
    row.createdByUserId,
    "createdByUserId",
  );
  if (
    !isProviderAuthMode(row.authMode) ||
    typeof row.providerSubjectId !== "string" ||
    row.providerSubjectId.length === 0 ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number"
  ) {
    throw new Error("providerConnectionShape");
  }
  const grantedScopes = requireStringArray(row.grantedScopes, "grantedScopes");
  const persistedProduct =
    typeof row.authorizationProduct === "string"
      ? parseGmailAuthorizationProduct(row.authorizationProduct)
      : null;
  const gmailProduct =
    provider === "gmail" &&
    gmailProductFromScopes(grantedScopes) === null &&
    persistedProduct === "full_mailbox_pilot"
      ? "full_mailbox_pilot"
      : provider === "gmail"
        ? gmailProductFromScopes(grantedScopes)
        : null;
  const authorizationProduct = providerAuthorizationProduct(
    provider,
    gmailProduct,
  );
  if (provider === "gmail" && authorizationProduct.kind !== "gmail") {
    throw new Error("providerConnectionAuthorizationProduct");
  }
  if (
    typeof row.authorizationProduct === "string" &&
    row.authorizationProduct !== "standard" &&
    (authorizationProduct.kind !== "gmail" ||
      row.authorizationProduct !== authorizationProduct.product)
  ) {
    throw new Error("providerConnectionAuthorizationProduct");
  }
  return {
    providerConnectionId,
    organisationId,
    provider,
    providerSubjectId: row.providerSubjectId,
    authorizationProduct,
    environment,
    authMode: row.authMode,
    authority: requireProviderConnectionAuthority(row),
    lifecycle: requireProviderConnectionLifecycle(row),
    grantedScopes,
    createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireProviderConnectionAuthority(
  row: ProviderConnectionRow,
): ProviderConnectionAuthority {
  if (
    row.authorityKind !== "connection_credential" ||
    !isPositiveInteger(row.credentialGeneration)
  ) {
    throw new Error("providerConnectionAuthority");
  }
  return {
    kind: "connection_credential",
    credentialGeneration: row.credentialGeneration,
    credentialRef: requireParsed(
      parseVaultHandle,
      row.credentialRef,
      "credentialRef",
    ),
  };
}

function requireIntegrationAccountRow(
  row: IntegrationAccountRow,
): IntegrationAccount {
  const integrationAccountId = requireParsed(
    parseIntegrationAccountId,
    row.integrationAccountId,
    "integrationAccountId",
  );
  const organisationId = requireParsed(
    parseOrganisationId,
    row.organisationId,
    "organisationId",
  );
  const providerConnectionId = requireParsed(
    parseProviderConnectionId,
    row.providerConnectionId,
    "providerConnectionId",
  );
  if (
    typeof row.providerAccountId !== "string" ||
    typeof row.accountKind !== "string" ||
    typeof row.displayName !== "string" ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number" ||
    (row.isDefaultForProvider !== 0 && row.isDefaultForProvider !== 1)
  ) {
    throw new Error("accountShape");
  }
  return {
    integrationAccountId,
    organisationId,
    providerConnectionId,
    provider: requireProvider(row.provider),
    environment: requireOrganisationEnvironment(row.environment),
    providerAccountId: row.providerAccountId,
    accountKind: row.accountKind,
    displayName: row.displayName,
    lifecycle: requireIntegrationAccountLifecycle(row),
    isDefaultForProvider: row.isDefaultForProvider === 1,
    capabilities: requireStringArray(row.capabilitySet, "capabilitySet"),
    audiencePolicy: requireAudiencePolicy(row.audiencePolicy),
    retentionPolicy: requireRetentionPolicy(row.retentionPolicy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireLiveProviderWebhookContext(row: {
  readonly integrationAccountId: unknown;
  readonly providerAccountId: unknown;
  readonly environment: unknown;
  readonly signingSecretRef: unknown;
  readonly credentialGeneration: unknown;
}): LiveProviderWebhookContext {
  const integrationAccountId = requireParsed(
    parseIntegrationAccountId,
    row.integrationAccountId,
    "integrationAccountId",
  );
  const signingSecretRef = requireParsed(
    parseVaultHandle,
    row.signingSecretRef,
    "signingSecretRef",
  );
  if (
    typeof row.providerAccountId !== "string" ||
    (row.environment !== "development" && row.environment !== "production") ||
    !isPositiveInteger(row.credentialGeneration)
  ) {
    throw new Error("providerWebhookContextShape");
  }
  return {
    integrationAccountId,
    providerAccountId: row.providerAccountId,
    environment: row.environment,
    signingSecretRef,
    credentialGeneration: row.credentialGeneration,
  };
}

function requireActiveProviderAccountTarget(row: {
  readonly organisationId: unknown;
  readonly integrationAccountId: unknown;
}): ActiveProviderAccountTarget {
  return {
    organisationId: requireParsed(
      parseOrganisationId,
      row.organisationId,
      "organisationId",
    ),
    integrationAccountId: requireParsed(
      parseIntegrationAccountId,
      row.integrationAccountId,
      "integrationAccountId",
    ),
  };
}

function requireProviderConnectionLifecycle(
  row: ProviderConnectionRow,
): ProviderConnectionLifecycle {
  switch (row.lifecycle) {
    case "connecting":
    case "active":
    case "reauth_required":
      return { kind: row.lifecycle };
    case "disabled":
      return {
        kind: "disabled",
        disabledAt: requireNumber(row.disabledAt, "disabledAt"),
      };
    case "revoked":
      return {
        kind: "revoked",
        revokedAt: requireNumber(row.revokedAt, "revokedAt"),
      };
    default:
      throw new Error("providerConnectionLifecycle");
  }
}

function requireIntegrationAccountLifecycle(
  row: IntegrationAccountRow,
): IntegrationAccountLifecycle {
  switch (row.lifecycle) {
    case "connecting":
    case "pending_activation":
    case "active":
      return { kind: row.lifecycle };
    case "degraded":
    case "reauth_required":
      return {
        kind: row.lifecycle,
        reasonCode: requireString(row.lifecycleReasonCode, "reasonCode"),
      };
    case "disabled":
      return {
        kind: "disabled",
        disabledByUserId: requireParsed(
          parseUserId,
          row.disabledByUserId,
          "disabledByUserId",
        ),
        disabledAt: requireNumber(row.disabledAt, "disabledAt"),
      };
    case "revoked":
      return {
        kind: "revoked",
        revokedAt: requireNumber(row.revokedAt, "revokedAt"),
      };
    default:
      throw new Error("accountLifecycle");
  }
}

function lifecycleColumns(lifecycle: IntegrationAccountLifecycle): {
  readonly reasonCode: string | null;
  readonly disabledBy: UserId | null;
  readonly disabledAt: number | null;
  readonly revokedAt: number | null;
} {
  switch (lifecycle.kind) {
    case "connecting":
    case "pending_activation":
    case "active":
      return {
        reasonCode: null,
        disabledBy: null,
        disabledAt: null,
        revokedAt: null,
      };
    case "degraded":
    case "reauth_required":
      return {
        reasonCode: lifecycle.reasonCode,
        disabledBy: null,
        disabledAt: null,
        revokedAt: null,
      };
    case "disabled":
      return {
        reasonCode: null,
        disabledBy: lifecycle.disabledByUserId,
        disabledAt: lifecycle.disabledAt,
        revokedAt: null,
      };
    case "revoked":
      return {
        reasonCode: null,
        disabledBy: null,
        disabledAt: null,
        revokedAt: lifecycle.revokedAt,
      };
  }
}

function webhookLifecycleColumns(lifecycle: ProviderWebhookLifecycle): {
  readonly reasonCode: string | null;
  readonly lastVerifiedAt: number | null;
} {
  switch (lifecycle.kind) {
    case "pending":
    case "disabled":
    case "revoked":
      return { reasonCode: null, lastVerifiedAt: null };
    case "live":
      return { reasonCode: null, lastVerifiedAt: lifecycle.lastVerifiedAt };
    case "degraded":
      return { reasonCode: lifecycle.reasonCode, lastVerifiedAt: null };
  }
}

function requireProvider(raw: unknown): IntegrationProvider {
  const parsed = parseIntegrationProvider(raw);
  if (!parsed.ok) {
    throw new Error("provider");
  }
  return parsed.value;
}

function requireOrganisationEnvironment(raw: unknown): OrganisationEnvironment {
  if (raw !== "development" && raw !== "production") {
    throw new Error("organisationEnvironment");
  }
  return raw;
}

function requireStringArray(raw: unknown, field: string): readonly string[] {
  const value = requireJson(raw, field);
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new Error(field);
  }
  return value;
}

function requireAudiencePolicy(raw: unknown): AudiencePolicy {
  const value = requireJson(raw, "audiencePolicy");
  if (!isRecord(value)) {
    throw new Error("audiencePolicy");
  }
  if (value.kind === "operator") {
    return { kind: "operator" };
  }
  if (value.kind === "customer" && value.consentRequired === true) {
    return { kind: "customer", consentRequired: true };
  }
  throw new Error("audiencePolicy");
}

function requireRetentionPolicy(raw: unknown): RetentionPolicy {
  const value = requireJson(raw, "retentionPolicy");
  if (!isRecord(value)) {
    throw new Error("retentionPolicy");
  }
  if (value.kind === "organisation_default") {
    return { kind: "organisation_default" };
  }
  if (value.kind === "days" && isPositiveInteger(value.days)) {
    return { kind: "days", days: value.days };
  }
  throw new Error("retentionPolicy");
}

function requireJson(raw: unknown, field: string): unknown {
  if (typeof raw !== "string") {
    throw new Error(field);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(field);
  }
}

function requireParsed<TValue>(
  parser: (raw: string) => Result<TValue, unknown>,
  raw: unknown,
  field: string,
): TValue {
  if (typeof raw !== "string") {
    throw new Error(field);
  }
  const parsed = parser(raw);
  if (!parsed.ok) {
    throw new Error(field);
  }
  return parsed.value;
}

function requireParsedProviderWebhookId(raw: string): ProviderWebhookId {
  const parsed = parseProviderWebhookId(raw);
  if (!parsed.ok) {
    throw new Error("providerWebhookId");
  }
  return parsed.value;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(field);
  }
  return raw;
}

function requireNumber(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(field);
  }
  return raw;
}

function isProviderAuthMode(raw: unknown): raw is ProviderAuthMode {
  return (
    raw === "shared_pantry_app" || raw === "api_key" || raw === "webhook_secret"
  );
}

/**
 * The connection, its first credential generation and the default account of
 * a new surface install, in the order of the install batch (Refactor 17: the
 * install of tenancy puts these connection rows into its batch).
 */
export function prepareSurfaceInstallConnectionRows(
  session: OrganisationDatabaseSession,
  input: Readonly<{
    providerConnectionId: string;
    integrationAccountId: string;
    organisationId: string;
    surfaceKind: SurfaceKind;
    botTokenRef: string;
    scopesJson: string;
    userId: string;
    workspaceId: string;
    name: string;
    capabilitySetJson: string;
    audiencePolicyJson: string;
    retentionPolicyJson: string;
    createdAt: number;
    installedAt: number;
  }>,
): D1PreparedStatement[] {
  const provider = surfaceProvider(input.surfaceKind);
  return [
    session
      .prepare(
        `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, disabled_at,
       revoked_at, environment, provider_subject_id
     ) VALUES (
       ?, ?, ?, ?, 'connection_credential', 1, ?, 'active', ?, ?, ?, ?, NULL, NULL,
       'development', ?
     )`,
      )
      .bind(
        input.providerConnectionId,
        input.organisationId,
        provider,
        surfaceAuthMode(provider),
        input.botTokenRef,
        input.scopesJson,
        input.userId,
        input.createdAt,
        input.installedAt,
        input.workspaceId,
      ),
    session
      .prepare(
        `INSERT INTO provider_credential_generation (
       provider_connection_id, credential_generation, organisation_id, provider,
       environment, credential_ref, lifecycle, created_at, activated_at,
       superseded_at, revoked_at, failed_at, failure_code
     ) VALUES (?, 1, ?, ?, 'development', ?, 'active', ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .bind(
        input.providerConnectionId,
        input.organisationId,
        provider,
        input.botTokenRef,
        input.createdAt,
        input.installedAt,
      ),
    session
      .prepare(
        `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code,
       capability_set, audience_policy, retention_policy, created_at, updated_at,
       disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?,
       NULL, NULL, NULL, 'development', 1
     )`,
      )
      .bind(
        input.integrationAccountId,
        input.organisationId,
        input.providerConnectionId,
        provider,
        input.workspaceId,
        surfaceAccountKind(provider),
        input.name,
        input.capabilitySetJson,
        input.audiencePolicyJson,
        input.retentionPolicyJson,
        input.createdAt,
        input.installedAt,
      ),
  ];
}

/** The provider of the connection that a surface install makes. */
function surfaceProvider(surfaceKind: SurfaceKind): IntegrationProvider {
  switch (surfaceKind) {
    case "slack":
    case "discord":
    case "dropbox":
      return surfaceKind;
    case "gdrive":
      return "google_drive";
    case "telegram":
    case "whatsapp":
    case "teams":
    case "line-works":
      throw new Error(`surface_provider_not_implemented:${surfaceKind}`);
    default:
      return assertNever(surfaceKind);
  }
}

function surfaceAuthMode(provider: IntegrationProvider): ProviderAuthMode {
  switch (provider) {
    case "slack":
    case "discord":
      return "shared_pantry_app";
    case "gmail":
    case "whatsapp":
    case "google_drive":
    case "dropbox":
      return "shared_pantry_app";
    case "stripe":
    case "square":
    case "shopify":
    case "airtable":
    case "notion":
    // Both payout rails authenticate with a purpose-bound secret rather than
    // an OAuth grant: there is no end user to send to a consent screen.
    case "gmo_aozora":
    case "wise":
      return "api_key";
    default:
      return assertNever(provider);
  }
}

function surfaceAccountKind(provider: IntegrationProvider): string {
  switch (provider) {
    case "slack":
      return "workspace";
    case "discord":
      return "guild";
    case "google_drive":
    case "dropbox":
    case "airtable":
    case "notion":
      return "resource";
    case "stripe":
    case "square":
    // A payout rail is bound to one funding account — a GMO source account or
    // a Wise profile — not to a workspace or a resource.
    case "gmo_aozora":
    case "wise":
      return "account";
    case "shopify":
      return "shop";
    case "gmail":
      return "mailbox";
    case "whatsapp":
      return "phone_number";
    default:
      return assertNever(provider);
  }
}

/**
 * A repeat install of a surface: it supersedes the active generation, adds
 * the next one with the new token, and makes the connection and the account
 * active again, in that order. Each statement changes a row only while the
 * `live` guard holds.
 */
export function prepareSurfaceReinstallConnectionRows(
  session: OrganisationDatabaseSession,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    botTokenRef: string;
    name: string;
    capabilitySetJson: string;
    audiencePolicyJson: string;
    retentionPolicyJson: string;
    installedAt: number;
    live: Readonly<{ sql: string; bindings: readonly unknown[] }>;
  }>,
): D1PreparedStatement[] {
  return [
    session
      .prepare(
        `UPDATE provider_credential_generation
       SET lifecycle = 'superseded', superseded_at = ?
       WHERE provider_connection_id = (
         SELECT provider_connection_id FROM integration_account
         WHERE organisation_id = ? AND integration_account_id = ?
       ) AND lifecycle = 'active' AND ${input.live.sql}`,
      )
      .bind(
        input.installedAt,
        input.organisationId,
        input.integrationAccountId,
        ...input.live.bindings,
      ),
    session
      .prepare(
        `INSERT INTO provider_credential_generation (
         provider_connection_id, credential_generation, organisation_id, provider,
         environment, credential_ref, lifecycle, created_at, activated_at,
         superseded_at, revoked_at, failed_at, failure_code
       )
       SELECT
         connection.provider_connection_id, connection.credential_generation + 1,
         connection.organisation_id, connection.provider, connection.environment,
         ?, 'active', ?, ?, NULL, NULL, NULL, NULL
       FROM provider_connection AS connection
       JOIN integration_account AS account
         ON account.provider_connection_id = connection.provider_connection_id
       WHERE account.organisation_id = ? AND account.integration_account_id = ?
         AND ${input.live.sql}`,
      )
      .bind(
        input.botTokenRef,
        input.installedAt,
        input.installedAt,
        input.organisationId,
        input.integrationAccountId,
        ...input.live.bindings,
      ),
    session
      .prepare(
        `UPDATE provider_connection
       SET credential_ref = ?, credential_generation = credential_generation + 1,
           lifecycle = 'active', updated_at = ?, disabled_at = NULL, revoked_at = NULL
       WHERE provider_connection_id = (
         SELECT provider_connection_id FROM integration_account
         WHERE organisation_id = ? AND integration_account_id = ?
       ) AND ${input.live.sql}`,
      )
      .bind(
        input.botTokenRef,
        input.installedAt,
        input.organisationId,
        input.integrationAccountId,
        ...input.live.bindings,
      ),
    session
      .prepare(
        `UPDATE integration_account
       SET display_name = ?, lifecycle = 'active', lifecycle_reason_code = NULL,
           capability_set = ?, audience_policy = ?, retention_policy = ?, updated_at = ?,
           disabled_by_user_id = NULL, disabled_at = NULL, revoked_at = NULL
       WHERE organisation_id = ? AND integration_account_id = ? AND ${input.live.sql}`,
      )
      .bind(
        input.name,
        input.capabilitySetJson,
        input.audiencePolicyJson,
        input.retentionPolicyJson,
        input.installedAt,
        input.organisationId,
        input.integrationAccountId,
        ...input.live.bindings,
      ),
  ];
}
