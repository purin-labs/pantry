import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  connectionCredentialAuthority,
  type ActiveProviderAccountContext,
  type ConnectionCredentialAuthority,
  type IntegrationProvider,
} from "../data/integration-account";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { VaultHandle, VaultResolveError, VaultSecret } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle } from "./service";

export type ProviderConnectionResolutionError =
  | VaultResolveError
  | { readonly code: "provider_connection_scope_inactive" }
  | { readonly code: "provider_connection_credential_absent" };

export type ProviderManifestResolutionError =
  VaultResolveError | { readonly code: "provider_manifest_scope_inactive" };

export async function resolveActiveProviderConnectionCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly context: ActiveProviderAccountContext;
  readonly expectedProvider: IntegrationProvider;
}): Promise<Result<VaultSecret, ProviderConnectionResolutionError>> {
  const binding = await resolveActiveProviderConnectionBinding(input);
  if (!binding.ok) return binding;
  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.context.account.organisationId,
    handle: binding.value.credentialRef,
  });
}

export async function resolveActiveProviderConnectionBinding(input: {
  readonly db: OrganisationDatabase;
  readonly context: ActiveProviderAccountContext;
  readonly expectedProvider: IntegrationProvider;
}): Promise<
  Result<
    ConnectionCredentialAuthority,
    { readonly code: "provider_connection_scope_inactive" }
  >
> {
  if (
    input.context.account.provider !== input.expectedProvider ||
    input.context.connection.provider !== input.expectedProvider
  ) {
    return { ok: false, error: { code: "provider_connection_scope_inactive" } };
  }

  const authority = connectionCredentialAuthority(
    input.context.connection.authority,
  );

  const active = await input.db
    .prepare(
      `SELECT connection.credential_ref AS credentialRef
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
        AND connection.provider = account.provider
        AND connection.environment = account.environment
        AND connection.lifecycle = 'active'
       JOIN provider_credential_generation AS generation
         ON generation.provider_connection_id = connection.provider_connection_id
        AND generation.credential_generation = connection.credential_generation
        AND generation.organisation_id = connection.organisation_id
        AND generation.provider = connection.provider
        AND generation.environment = connection.environment
        AND generation.credential_ref = connection.credential_ref
        AND generation.lifecycle = 'active'
       JOIN organisation
         ON organisation.organisation_id = account.organisation_id
        AND organisation.status = 'active'
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = account.organisation_id
        AND onboarding.environment = account.environment
        AND onboarding.lifecycle = 'active'
       WHERE account.organisation_id = ?
         AND account.integration_account_id = ?
         AND account.provider_connection_id = ?
         AND account.provider = ?
         AND account.environment = ?
         AND account.provider_account_id = ?
         AND account.lifecycle = 'active'
         AND connection.credential_generation = ?
         AND connection.credential_ref = ?
       LIMIT 1`,
    )
    .bind(
      input.context.account.organisationId,
      input.context.account.integrationAccountId,
      input.context.connection.providerConnectionId,
      input.expectedProvider,
      input.context.account.environment,
      input.context.account.providerAccountId,
      authority.credentialGeneration,
      authority.credentialRef,
    )
    .first<{ readonly credentialRef: unknown }>();

  if (active?.credentialRef !== authority.credentialRef) {
    return { ok: false, error: { code: "provider_connection_scope_inactive" } };
  }

  return { ok: true, value: authority };
}

export async function resolveProviderManifestCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: IntegrationProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly credentialRef: VaultHandle;
}): Promise<Result<VaultSecret, ProviderManifestResolutionError>> {
  const active = await input.db
    .prepare(
      `SELECT connection.credential_ref AS credentialRef
     FROM integration_account AS account
     JOIN provider_connection AS connection
       ON connection.provider_connection_id = account.provider_connection_id
      AND connection.organisation_id = account.organisation_id
      AND connection.provider = account.provider
      AND connection.environment = account.environment
      AND connection.lifecycle = 'active'
     JOIN provider_credential_generation AS generation
       ON generation.provider_connection_id = connection.provider_connection_id
      AND generation.credential_generation = connection.credential_generation
      AND generation.organisation_id = connection.organisation_id
      AND generation.provider = connection.provider
      AND generation.environment = connection.environment
      AND generation.credential_ref = connection.credential_ref
      AND generation.lifecycle = 'active'
     JOIN organisation
       ON organisation.organisation_id = account.organisation_id
      AND organisation.status = 'active'
     JOIN organisation_onboarding AS onboarding
       ON onboarding.organisation_id = account.organisation_id
      AND onboarding.environment = account.environment
      AND onboarding.lifecycle IN ('configuring', 'activating', 'active')
     WHERE account.organisation_id = ?
       AND account.integration_account_id = ?
       AND account.provider = ?
       AND account.environment = ?
       AND account.provider_account_id = ?
       AND account.lifecycle IN ('active', 'degraded')
       AND connection.credential_ref = ?
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.provider,
      input.environment,
      input.providerAccountId,
      input.credentialRef,
    )
    .first<{ readonly credentialRef: unknown }>();

  if (active?.credentialRef !== input.credentialRef) {
    return { ok: false, error: { code: "provider_manifest_scope_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.credentialRef,
  });
}
