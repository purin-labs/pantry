import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationProvider,
  LiveProviderWebhookContext,
} from "@purin-labs/connections/data/integration-account";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { recordCredentialAccessDenial } from "./alerts";
import type { VaultHandle, VaultResolveError, VaultSecret } from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { integrationCredentialReads } from "./integration-reads";
import { resolveVaultHandle } from "./service";

export type ProviderWebhookResolutionError =
  VaultResolveError | { readonly code: "webhook_binding_inactive" };

export async function resolveProviderWebhookCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly provider: IntegrationProvider;
  readonly context: LiveProviderWebhookContext;
}): Promise<Result<VaultSecret, ProviderWebhookResolutionError>> {
  const resolved = await resolveProviderWebhookCredentialInner(input);
  if (!resolved.ok) {
    await recordCredentialAccessDenial({
      db: input.db,
      organisationId: input.organisationId,
      purpose: "webhook",
      reasonCode: resolved.error.code,
      now: Date.now(),
    });
  }
  return resolved;
}

async function resolveProviderWebhookCredentialInner(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly provider: IntegrationProvider;
  readonly context: LiveProviderWebhookContext;
}): Promise<Result<VaultSecret, ProviderWebhookResolutionError>> {
  const active = await input.db
    .prepare(
      `SELECT webhook.signing_secret_ref AS signingSecretRef
       FROM provider_webhook AS webhook
       JOIN integration_account AS account
         ON account.integration_account_id = webhook.integration_account_id
        AND account.organisation_id = webhook.organisation_id
        AND account.provider = webhook.provider
        AND account.environment = webhook.environment
        AND account.lifecycle = 'active'
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
       WHERE webhook.organisation_id = ?
         AND webhook.provider = ?
         AND webhook.environment = ?
         AND webhook.integration_account_id = ?
         AND account.provider_account_id = ?
         AND webhook.signing_secret_ref = ?
         AND webhook.credential_generation = ?
         AND connection.credential_generation = webhook.credential_generation
         AND webhook.lifecycle = 'live'
       LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.provider,
      input.context.environment,
      input.context.integrationAccountId,
      input.context.providerAccountId,
      input.context.signingSecretRef,
      input.context.credentialGeneration,
    )
    .first<{ readonly signingSecretRef: unknown }>();

  if (active?.signingSecretRef !== input.context.signingSecretRef) {
    return { ok: false, error: { code: "webhook_binding_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.context.signingSecretRef,
  });
}

/**
 * What the Vault needs of a Discord installation to give its public key: the
 * identity of the installation and the handle that it must hold. The Discord
 * code gives its installation record, which has these fields.
 */
type DiscordVerificationBinding = Readonly<{
  organisationId: OrganisationId;
  applicationId: string;
  guildId: string;
  publicKeyRef: VaultHandle;
}>;

export async function resolveDiscordInteractionVerificationCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly install: DiscordVerificationBinding;
}): Promise<Result<VaultSecret, ProviderWebhookResolutionError>> {
  const active = await integrationCredentialReads
    .use()
    .discordInstallHoldsPublicKey(input.db, input.install);

  if (!active) {
    return { ok: false, error: { code: "webhook_binding_inactive" } };
  }

  return resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.install.organisationId,
    handle: input.install.publicKeyRef,
  });
}
