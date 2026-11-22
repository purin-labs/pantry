import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  connectionCredentialAuthority,
  resolveActiveProviderAccountContext,
  type ActiveProviderAccountContext,
  type ConnectionCredentialAuthority,
  type IntegrationProvider,
  type ProviderAccountContextError,
} from "@purin-labs/connections/data/integration-account";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { ExecutingActionLedgerEntry } from "../actors/action-ledger";
import type {
  IntegrationAccountId,
  SessionId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { recordCredentialAccessDenial } from "./alerts";
import type { VaultHandle, VaultResolveError, VaultSecret } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle } from "./service";
import { flowBindingMatchesIdentity, FlowBinding } from "../policy";

const providerActionResolutionBrand: unique symbol = Symbol(
  "ProviderActionResolution",
);

export type AuthorizedProviderAction = ExecutingActionLedgerEntry;

export type ProviderActionResolution = {
  readonly [providerActionResolutionBrand]: "ProviderActionResolution";
  readonly kind: "provider_action";
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly credentialGeneration: number;
  readonly handle: VaultHandle;
  readonly providerAccountId: string;
  readonly actionNonce: string;
};

export type ProviderActionResolutionError =
  | ProviderAccountContextError
  | VaultResolveError
  | { readonly code: "flow_binding_invalid" }
  | { readonly code: "credential_generation_inactive" }
  | { readonly code: "provider_connection_credential_absent" }
  | { readonly code: "account_scope_mismatch" }
  | { readonly code: "environment_mismatch" }
  | {
      readonly code: "provider_scope_mismatch";
      readonly expected: IntegrationProvider;
      readonly actual: IntegrationProvider;
    };

type CredentialGenerationRow = {
  readonly credentialRef: unknown;
  readonly lifecycle: unknown;
};

export async function authorizeProviderActionResolution(input: {
  readonly db: OrganisationDatabase;
  readonly action: AuthorizedProviderAction;
  readonly expectedProvider: IntegrationProvider;
}): Promise<Result<ProviderActionResolution, ProviderActionResolutionError>> {
  const authorized = await authorizeProviderActionResolutionInner(input);
  if (!authorized.ok) {
    await recordCredentialAccessDenial({
      db: input.db,
      organisationId: input.action.action.organisationId,
      purpose: "provider_action",
      reasonCode: authorized.error.code,
      now: Date.now(),
    });
  }
  return authorized;
}

async function authorizeProviderActionResolutionInner(input: {
  readonly db: OrganisationDatabase;
  readonly action: AuthorizedProviderAction;
  readonly expectedProvider: IntegrationProvider;
}): Promise<Result<ProviderActionResolution, ProviderActionResolutionError>> {
  const flowBinding = await FlowBinding.restore(
    input.action.action.flowBinding,
  );
  if (
    !flowBinding.ok ||
    !flowBindingMatchesIdentity(flowBinding.value, {
      organisationId: input.action.action.organisationId,
      sessionId: input.action.action.sessionId,
      authorityPartitionDigest: input.action.action.authorityPartition.digest,
    })
  ) {
    return { ok: false, error: { code: "flow_binding_invalid" } };
  }
  const context = await resolveActiveProviderAccountContext({
    db: input.db,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });

  if (!context.ok) {
    return context;
  }

  const scoped = validateProviderAccountScope(
    context.value,
    input.action.action.organisationId,
    input.action.action.integrationAccountId,
    input.expectedProvider,
  );

  if (!scoped.ok) {
    return scoped;
  }

  const organisationEnvironment = await readOrganisationEnvironment(
    input.db,
    input.action.action.organisationId,
  );

  if (
    organisationEnvironment === null ||
    organisationEnvironment !== scoped.value.account.environment
  ) {
    return { ok: false, error: { code: "environment_mismatch" } };
  }

  const authority = connectionCredentialAuthority(
    scoped.value.connection.authority,
  );

  if (authority === null) {
    return {
      ok: false,
      error: { code: "provider_connection_credential_absent" },
    };
  }

  const generationActive = await credentialGenerationIsActive({
    db: input.db,
    organisationId: input.action.action.organisationId,
    context: scoped.value,
    authority,
  });

  if (!generationActive) {
    return { ok: false, error: { code: "credential_generation_inactive" } };
  }

  return {
    ok: true,
    value: {
      [providerActionResolutionBrand]: "ProviderActionResolution",
      kind: "provider_action",
      organisationId: input.action.action.organisationId,
      sessionId: input.action.action.sessionId,
      integrationAccountId: input.action.action.integrationAccountId,
      provider: scoped.value.account.provider,
      environment: scoped.value.account.environment,
      credentialGeneration: authority.credentialGeneration,
      handle: authority.credentialRef,
      providerAccountId: scoped.value.account.providerAccountId,
      actionNonce: input.action.action.nonce.value,
    },
  };
}

export async function resolveProviderActionCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly authorization: ProviderActionResolution;
}): Promise<Result<VaultSecret, ProviderActionResolutionError>> {
  const resolved = await resolveProviderActionCredentialInner(input);
  if (!resolved.ok) {
    await recordCredentialAccessDenial({
      db: input.db,
      organisationId: input.authorization.organisationId,
      purpose: "provider_action",
      reasonCode: resolved.error.code,
      now: Date.now(),
    });
  }
  return resolved;
}

async function resolveProviderActionCredentialInner(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly authorization: ProviderActionResolution;
}): Promise<Result<VaultSecret, ProviderActionResolutionError>> {
  const stillActive = await providerActionResolutionIsActive(
    input.db,
    input.authorization,
  );

  if (!stillActive) {
    return { ok: false, error: { code: "credential_generation_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.authorization.organisationId,
    handle: input.authorization.handle,
  });
}

function validateProviderAccountScope(
  context: ActiveProviderAccountContext,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  expectedProvider: IntegrationProvider,
): Result<ActiveProviderAccountContext, ProviderActionResolutionError> {
  if (
    context.account.organisationId !== organisationId ||
    context.connection.organisationId !== organisationId ||
    context.account.integrationAccountId !== integrationAccountId ||
    context.account.providerConnectionId !==
      context.connection.providerConnectionId
  ) {
    return { ok: false, error: { code: "account_scope_mismatch" } };
  }

  if (context.account.provider !== expectedProvider) {
    return {
      ok: false,
      error: {
        code: "provider_scope_mismatch",
        expected: expectedProvider,
        actual: context.account.provider,
      },
    };
  }

  if (context.connection.provider !== expectedProvider) {
    return { ok: false, error: { code: "account_scope_mismatch" } };
  }

  if (context.account.environment !== context.connection.environment) {
    return { ok: false, error: { code: "environment_mismatch" } };
  }

  return { ok: true, value: context };
}

async function readOrganisationEnvironment(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationEnvironment | null> {
  const row = await db
    .prepare(
      `SELECT environment
       FROM organisation_onboarding
       JOIN organisation
         ON organisation.organisation_id = organisation_onboarding.organisation_id
        AND organisation.status = 'active'
       WHERE organisation_onboarding.organisation_id = ?
         AND organisation_onboarding.lifecycle = 'active'`,
    )
    .bind(organisationId)
    .first<{ readonly environment: unknown }>();

  return row?.environment === "development" || row?.environment === "production"
    ? row.environment
    : null;
}

async function credentialGenerationIsActive(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly context: ActiveProviderAccountContext;
  readonly authority: ConnectionCredentialAuthority;
}): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT credential_ref AS credentialRef, lifecycle
       FROM provider_credential_generation
       WHERE provider_connection_id = ? AND credential_generation = ?
         AND organisation_id = ? AND provider = ? AND environment = ?`,
    )
    .bind(
      input.context.connection.providerConnectionId,
      input.authority.credentialGeneration,
      input.organisationId,
      input.context.connection.provider,
      input.context.connection.environment,
    )
    .first<CredentialGenerationRow>();

  return (
    row?.lifecycle === "active" &&
    row.credentialRef === input.authority.credentialRef
  );
}

async function providerActionResolutionIsActive(
  db: OrganisationDatabase,
  authorization: ProviderActionResolution,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT provider_connection.credential_ref AS credentialRef
       FROM integration_account
       JOIN provider_connection
         ON provider_connection.provider_connection_id =
           integration_account.provider_connection_id
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
        AND organisation_onboarding.lifecycle = 'active'
       WHERE integration_account.organisation_id = ?
         AND integration_account.integration_account_id = ?
         AND integration_account.provider = ?
         AND integration_account.environment = ?
         AND integration_account.provider_account_id = ?
         AND integration_account.lifecycle = 'active'
         AND provider_connection.organisation_id = integration_account.organisation_id
         AND provider_connection.provider = integration_account.provider
         AND provider_connection.environment = integration_account.environment
         AND provider_connection.lifecycle = 'active'
         AND provider_connection.credential_generation = ?
         AND provider_connection.credential_ref = ?
         AND provider_credential_generation.organisation_id = integration_account.organisation_id
         AND provider_credential_generation.provider = integration_account.provider
         AND provider_credential_generation.environment = integration_account.environment
         AND provider_credential_generation.credential_ref = provider_connection.credential_ref
         AND provider_credential_generation.lifecycle = 'active'
         AND organisation_onboarding.environment = integration_account.environment`,
    )
    .bind(
      authorization.organisationId,
      authorization.integrationAccountId,
      authorization.provider,
      authorization.environment,
      authorization.providerAccountId,
      authorization.credentialGeneration,
      authorization.handle,
    )
    .first<{ readonly credentialRef: unknown }>();

  return row?.credentialRef === authorization.handle;
}
