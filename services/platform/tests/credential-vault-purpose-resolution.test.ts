import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import {
  resolveAccountRemovalCredential,
  resolveActiveProviderConnectionCredential,
  resolveDiscordInteractionVerificationCredential,
  resolveProviderManifestCredential,
  resolveProviderWebhookCredential,
  resolveSurfaceInstallationCredential,
  storeVaultSecret,
  type VaultHandle,
  type VaultSecret,
} from "../src/credential-vault";
import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import {
  parseDiscordApplicationId,
  parseDiscordGuildId,
  type DiscordApplicationId,
  type DiscordGuildId,
  type DiscordInteractionInstall,
} from "../src/data/discord-install";
import {
  resolveActiveProviderAccountContext,
  type ActiveProviderAccountContext,
  type IntegrationProvider,
  type LiveProviderWebhookContext,
} from "../src/data/integration-account";
import type { OrganisationInstallRecord } from "@purin-labs/tenancy/data/organisation";
import {
  parseProviderConnectionId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type OrganisationId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { createMigratedDatabase } from "./sqlite-d1";
import {
  requireIntegrationAccountId,
  requireOrganisationId,
  requireVaultHandle,
  requireWorkspaceId,
} from "./test-ids";
import { testRoot } from "./secrets-store";
const NOW = 10_000;
const PROVIDERS: readonly IntegrationProvider[] = [
  "slack",
  "stripe",
  "shopify",
  "discord",
  "google_drive",
  "dropbox",
];

describe(
  "purpose-bound Credential Vault resolution",
  credentialResolutionSuite,
);

function credentialResolutionSuite(): void {
  it(
    "resolves a live provider webhook and rejects forged account scope",
    providerWebhookScope,
  );
  it(
    "resolves a live Discord verification key and rejects forged install scope",
    discordWebhookScope,
  );
  it(
    "resolves an active provider connection and rejects a stale generation",
    providerConnectionScope,
  );
  it(
    "resolves provider health credentials while configuring and after degradation",
    providerManifestScope,
  );
  it(
    "resolves an active surface installation and rejects forged workspace scope",
    surfaceInstallationScope,
  );
  it(
    "resolves cleanup credentials and rejects handles outside the cleanup set",
    accountRemovalScope,
  );
  it(
    "keeps active surface credentials independent of onboarding lifecycle",
    archivedOnboardingScope,
  );
}

async function providerWebhookScope(): Promise<void> {
  const fixture = await createFixture();
  const stripe = fixture.providers.stripe;
  await insertProviderWebhook(fixture);
  const context = providerWebhookContext(fixture, stripe.providerAccountId);

  await expect(
    resolveProviderWebhookCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      provider: "stripe",
      context,
    }),
  ).resolves.toEqual(secretResult("webhook-secret"));

  const forged = providerWebhookContext(fixture, "acct_forged");
  await expect(
    resolveProviderWebhookCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      provider: "stripe",
      context: forged,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "webhook_binding_inactive" },
  });
}

async function discordWebhookScope(): Promise<void> {
  const fixture = await createFixture();
  const install = discordInstall(fixture, "123456789012345678");
  await fixture.db
    .prepare(
      `INSERT INTO discord_interaction_install (
         organisation_id, application_id, guild_id, public_key_ref, status, installed_at
       ) VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(
      fixture.organisationId,
      install.applicationId,
      install.guildId,
      install.publicKeyRef,
      NOW,
    )
    .run();

  await expect(
    resolveDiscordInteractionVerificationCredential({
      db: fixture.db,
      keys: fixture.keys,
      install,
    }),
  ).resolves.toEqual(secretResult("discord-public-key"));

  const forged = discordInstall(fixture, "999999999999999999");
  await expect(
    resolveDiscordInteractionVerificationCredential({
      db: fixture.db,
      keys: fixture.keys,
      install: forged,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "webhook_binding_inactive" },
  });
}

async function providerConnectionScope(): Promise<void> {
  const fixture = await createFixture();
  const context = await activeProviderContext(
    fixture,
    fixture.providers.stripe,
  );

  await expect(
    resolveActiveProviderConnectionCredential({
      db: fixture.db,
      keys: fixture.keys,
      context,
      expectedProvider: "stripe",
    }),
  ).resolves.toEqual(secretResult("stripe-credential"));

  await fixture.db
    .prepare(
      `UPDATE provider_credential_generation
       SET lifecycle = 'superseded', superseded_at = ?
       WHERE provider_connection_id = ? AND credential_generation = 1`,
    )
    .bind(NOW + 1, fixture.providers.stripe.providerConnectionId)
    .run();

  await expect(
    resolveActiveProviderConnectionCredential({
      db: fixture.db,
      keys: fixture.keys,
      context,
      expectedProvider: "stripe",
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "provider_connection_scope_inactive" },
  });
}

async function providerManifestScope(): Promise<void> {
  const fixture = await createFixture();
  const slack = fixture.providers.slack;
  await fixture.db
    .prepare(
      `UPDATE organisation_onboarding
     SET lifecycle = 'configuring', activation_receipt_id = NULL,
         activated_at = NULL, updated_at = ?
     WHERE organisation_id = ?`,
    )
    .bind(NOW + 1, fixture.organisationId)
    .run();
  await fixture.db
    .prepare(
      `UPDATE integration_account
     SET lifecycle = 'degraded', lifecycle_reason_code = 'provider_manifest_unhealthy',
         updated_at = ?
     WHERE integration_account_id = ?`,
    )
    .bind(NOW + 1, slack.integrationAccountId)
    .run();

  await expect(
    resolveProviderManifestCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      integrationAccountId: slack.integrationAccountId,
      provider: "slack",
      environment: "development",
      providerAccountId: slack.providerAccountId,
      credentialRef: slack.credentialRef,
    }),
  ).resolves.toEqual(secretResult("slack-credential"));

  await expect(
    resolveProviderManifestCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      integrationAccountId: slack.integrationAccountId,
      provider: "slack",
      environment: "development",
      providerAccountId: slack.providerAccountId,
      credentialRef: fixture.handles.unrelated,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "provider_manifest_scope_inactive" },
  });

  await archiveOrganisationOnboarding(fixture);
  await expect(
    resolveProviderManifestCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      integrationAccountId: slack.integrationAccountId,
      provider: "slack",
      environment: "development",
      providerAccountId: slack.providerAccountId,
      credentialRef: slack.credentialRef,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "provider_manifest_scope_inactive" },
  });
}

async function surfaceInstallationScope(): Promise<void> {
  const fixture = await createFixture();
  const install = surfaceInstall(fixture, fixture.workspaceId);
  await insertSurfaceInstallation(fixture);

  await expect(
    resolveSurfaceInstallationCredential({
      db: fixture.db,
      keys: fixture.keys,
      install,
    }),
  ).resolves.toEqual(secretResult("slack-credential"));

  const forged = surfaceInstall(
    fixture,
    requireWorkspaceId("workspace_forged"),
  );
  await expect(
    resolveSurfaceInstallationCredential({
      db: fixture.db,
      keys: fixture.keys,
      install: forged,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "surface_installation_inactive" },
  });

  await fixture.db
    .prepare(
      `UPDATE organisation SET status = 'suspended' WHERE organisation_id = ?`,
    )
    .bind(fixture.organisationId)
    .run();
  await expect(
    resolveSurfaceInstallationCredential({
      db: fixture.db,
      keys: fixture.keys,
      install,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "surface_installation_inactive" },
  });
}

async function accountRemovalScope(): Promise<void> {
  const fixture = await createFixture();
  const stripe = fixture.providers.stripe;
  await insertAccountCleanup(fixture);

  await expect(
    resolveAccountRemovalCredential({
      db: fixture.db,
      keys: fixture.keys,
      cleanupId: "cleanup_purpose_test",
      organisationId: fixture.organisationId,
      integrationAccountId: stripe.integrationAccountId,
      provider: "stripe",
      environment: "development",
      providerAccountId: stripe.providerAccountId,
      providerConnectionId: stripe.providerConnectionId,
      handle: stripe.credentialRef,
    }),
  ).resolves.toEqual(secretResult("stripe-credential"));

  await expect(
    resolveAccountRemovalCredential({
      db: fixture.db,
      keys: fixture.keys,
      cleanupId: "cleanup_purpose_test",
      organisationId: fixture.organisationId,
      integrationAccountId: stripe.integrationAccountId,
      provider: "stripe",
      environment: "development",
      providerAccountId: stripe.providerAccountId,
      providerConnectionId: stripe.providerConnectionId,
      handle: fixture.handles.unrelated,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "account_removal_scope_inactive" },
  });
}

async function archivedOnboardingScope(): Promise<void> {
  const fixture = await createFixture();
  const providerContext = await activeProviderContext(
    fixture,
    fixture.providers.stripe,
  );
  const install = surfaceInstall(fixture, fixture.workspaceId);
  const webhook = providerWebhookContext(
    fixture,
    fixture.providers.stripe.providerAccountId,
  );
  await insertProviderWebhook(fixture);
  await insertSurfaceInstallation(fixture);
  await insertAccountCleanup(fixture);
  await archiveOrganisationOnboarding(fixture);

  await expect(
    resolveActiveProviderConnectionCredential({
      db: fixture.db,
      keys: fixture.keys,
      context: providerContext,
      expectedProvider: "stripe",
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "provider_connection_scope_inactive" },
  });
  await expect(
    resolveSurfaceInstallationCredential({
      db: fixture.db,
      keys: fixture.keys,
      install,
    }),
  ).resolves.toEqual(secretResult("slack-credential"));
  await expect(
    resolveProviderWebhookCredential({
      db: fixture.db,
      keys: fixture.keys,
      organisationId: fixture.organisationId,
      provider: "stripe",
      context: webhook,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "webhook_binding_inactive" },
  });
  await expect(
    resolveAccountRemovalCredential({
      db: fixture.db,
      keys: fixture.keys,
      cleanupId: "cleanup_purpose_test",
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.providers.stripe.integrationAccountId,
      provider: "stripe",
      environment: "development",
      providerAccountId: fixture.providers.stripe.providerAccountId,
      providerConnectionId: fixture.providers.stripe.providerConnectionId,
      handle: fixture.providers.stripe.credentialRef,
    }),
  ).resolves.toEqual(secretResult("stripe-credential"));
}

async function insertProviderWebhook(
  fixture: PurposeResolutionFixture,
): Promise<void> {
  await fixture.db
    .prepare(
      `INSERT INTO provider_webhook (
         provider_webhook_id, organisation_id, integration_account_id, provider,
         provider_native_id, event_type, lifecycle, lifecycle_reason_code,
         signing_secret_ref, credential_generation, last_verified_at, updated_at,
         environment
       ) VALUES (?, ?, ?, 'stripe', 'endpoint_1', 'payment_intent.succeeded',
         'live', NULL, ?, 1, ?, ?, 'development')`,
    )
    .bind(
      "webhook_purpose_test",
      fixture.organisationId,
      fixture.providers.stripe.integrationAccountId,
      fixture.handles.webhook,
      NOW,
      NOW,
    )
    .run();
}

async function insertSurfaceInstallation(
  fixture: PurposeResolutionFixture,
): Promise<void> {
  await fixture.db
    .prepare(
      `INSERT INTO surface_installation (
         integration_account_id, organisation_id, surface_kind, workspace_id,
         install_model, bot_token_ref, scopes, installed_at, last_event_received_at
       ) VALUES (?, ?, 'slack', ?, 'custom', ?, '["chat:write"]', ?, NULL)`,
    )
    .bind(
      fixture.providers.slack.integrationAccountId,
      fixture.organisationId,
      fixture.workspaceId,
      fixture.providers.slack.credentialRef,
      NOW,
    )
    .run();
}

async function insertAccountCleanup(
  fixture: PurposeResolutionFixture,
): Promise<void> {
  const stripe = fixture.providers.stripe;
  await fixture.db
    .prepare(
      `INSERT INTO provider_account_cleanup (
         cleanup_id, organisation_id, integration_account_id, provider, environment,
         lifecycle, reason_code, instruction_code, attempt, next_attempt_at,
         created_at, updated_at, completed_at,
         provider_account_id, provider_connection_id, credential_handles,
         provider_webhook_ids, provider_context
       ) VALUES ('cleanup_purpose_test', ?, ?, 'stripe', 'development',
         'pending_provider_cleanup', NULL, NULL, 0, ?, ?, ?, NULL, ?, ?, ?, '[]',
         '{"provider":"stripe"}')`,
    )
    .bind(
      fixture.organisationId,
      stripe.integrationAccountId,
      NOW,
      NOW,
      NOW,
      stripe.providerAccountId,
      stripe.providerConnectionId,
      JSON.stringify([stripe.credentialRef]),
    )
    .run();
}

async function archiveOrganisationOnboarding(
  fixture: PurposeResolutionFixture,
): Promise<void> {
  await fixture.db
    .prepare(
      `UPDATE organisation_onboarding
       SET lifecycle = 'archived',
           activation_receipt_id = NULL,
           activated_at = NULL,
           archived_at = ?,
           purge_after = ?,
           updated_at = ?
       WHERE organisation_id = ?`,
    )
    .bind(NOW + 1, NOW + 2, NOW + 1, fixture.organisationId)
    .run();
}

type ProviderScope = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerAccountId: string;
  readonly credentialRef: VaultHandle;
};

type ProviderScopes = {
  readonly slack: ProviderScope;
  readonly stripe: ProviderScope;
  readonly shopify: ProviderScope;
  readonly discord: ProviderScope;
  readonly google_drive: ProviderScope;
  readonly dropbox: ProviderScope;
};

type PurposeHandles = {
  readonly webhook: VaultHandle;
  readonly discordPublicKey: VaultHandle;
  readonly unrelated: VaultHandle;
};

type PurposeResolutionFixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly workspaceId: WorkspaceId;
  readonly keys: CredentialVaultBindings;
  readonly providers: ProviderScopes;
  readonly handles: PurposeHandles;
};

async function createFixture(): Promise<PurposeResolutionFixture> {
  const db = createMigratedDatabase();
  const organisationId = requireOrganisationId(
    "organisation_purpose_resolution",
  );
  const keys: CredentialVaultBindings = {
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: testRoot(11),
  };
  await insertOrganisationBoundary(db, organisationId);

  const providerEntries: Partial<Record<IntegrationProvider, ProviderScope>> =
    {};
  for (const provider of PROVIDERS) {
    providerEntries[provider] = await insertProviderScope(
      db,
      keys,
      organisationId,
      provider,
    );
  }

  const handles = {
    webhook: requireVaultHandle("vault:test:purpose:webhook"),
    discordPublicKey: requireVaultHandle(
      "vault:test:purpose:discord-public-key",
    ),
    unrelated: requireVaultHandle("vault:test:purpose:unrelated"),
  };
  await storePurposeSecret(
    db,
    keys,
    organisationId,
    handles.webhook,
    "webhook-secret",
  );
  await storePurposeSecret(
    db,
    keys,
    organisationId,
    handles.discordPublicKey,
    "discord-public-key",
  );
  await storePurposeSecret(
    db,
    keys,
    organisationId,
    handles.unrelated,
    "unrelated-secret",
  );

  return {
    db,
    organisationId,
    workspaceId: requireWorkspaceId("workspace_purpose_resolution"),
    keys,
    providers: requireProviderScopes(providerEntries),
    handles,
  };
}

async function insertOrganisationBoundary(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Purpose Resolution', 'beta', ?, 'active')`,
    )
    .bind(organisationId, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (
         'user_7bf9fdfe-9f7f-50c5-86e5-9534da300b80', 'urn:test', 'purpose-resolution',
         'purpose@example.com', 'Purpose Resolution', 1, ?, ?
       )`,
    )
    .bind(NOW, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO organisation_onboarding (
         organisation_id, environment, lifecycle, capability_profile,
         configuration_version, projection_revision, activation_attempt_id,
         readiness_version, activation_receipt_id, activated_at,
         suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
       ) VALUES (
         ?, 'development', 'active', 'approved_provider_writes',
         1, 1, NULL, NULL, 'activation_purpose_resolution', ?,
         NULL, NULL, NULL, NULL, ?
       )`,
    )
    .bind(organisationId, NOW, NOW)
    .run();
}

async function insertProviderScope(
  db: SingleDatabase,
  keys: CredentialVaultBindings,
  organisationId: OrganisationId,
  provider: IntegrationProvider,
): Promise<ProviderScope> {
  const providerConnectionId = requireProviderConnectionId(
    `connection_${provider}`,
  );
  const integrationAccountId = requireIntegrationAccountId(
    `account_${provider}`,
  );
  const providerAccountId = `provider_account_${provider}`;
  const credentialRef = requireVaultHandle(`vault:test:${provider}:credential`);
  await storePurposeSecret(
    db,
    keys,
    organisationId,
    credentialRef,
    `${provider}-credential`,
  );
  await db
    .prepare(
      `INSERT INTO provider_connection (
         provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
         credential_generation, credential_ref, lifecycle, granted_scopes,
         created_by_user_id, created_at, updated_at,
         disabled_at, revoked_at, environment, provider_subject_id
       ) VALUES (
         ?, ?, ?, 'api_key', 'connection_credential', 1, ?, 'active', '["read_write"]',
         'user_7bf9fdfe-9f7f-50c5-86e5-9534da300b80', ?, ?, NULL, NULL, 'development', ?
       )`,
    )
    .bind(
      providerConnectionId,
      organisationId,
      provider,
      credentialRef,
      NOW,
      NOW,
      providerAccountId,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO integration_account (
         integration_account_id, organisation_id, provider_connection_id, provider,
         provider_account_id, account_kind, display_name, lifecycle,
         lifecycle_reason_code, capability_set, audience_policy, retention_policy,
         created_at, updated_at, disabled_by_user_id, disabled_at,
         revoked_at, environment, is_default_for_provider
       ) VALUES (
         ?, ?, ?, ?, ?, 'commerce', ?, 'active', NULL, '["read"]',
         '{"kind":"operator"}', '{"kind":"organisation_default"}', ?, ?,
         NULL, NULL, NULL, 'development', 1
       )`,
    )
    .bind(
      integrationAccountId,
      organisationId,
      providerConnectionId,
      provider,
      providerAccountId,
      `${provider} account`,
      NOW,
      NOW,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO provider_credential_generation (
         provider_connection_id, credential_generation, organisation_id, provider,
         environment, credential_ref, lifecycle, created_at, activated_at,
         superseded_at, revoked_at, failed_at, failure_code
       ) VALUES (?, 1, ?, ?, 'development', ?, 'active', ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .bind(
      providerConnectionId,
      organisationId,
      provider,
      credentialRef,
      NOW,
      NOW,
    )
    .run();

  return {
    integrationAccountId,
    providerConnectionId,
    providerAccountId,
    credentialRef,
  };
}

async function storePurposeSecret(
  db: SingleDatabase,
  keys: CredentialVaultBindings,
  organisationId: OrganisationId,
  handle: VaultHandle,
  value: string,
): Promise<void> {
  const stored = await storeVaultSecret({
    db,
    keys,
    organisationId,
    handle,
    secret: { kind: "bearer", value },
    now: NOW,
  });

  if (!stored.ok) {
    throw new Error(stored.error.code);
  }
}

async function activeProviderContext(
  fixture: PurposeResolutionFixture,
  scope: ProviderScope,
): Promise<ActiveProviderAccountContext> {
  const context = await resolveActiveProviderAccountContext({
    db: fixture.db,
    organisationId: fixture.organisationId,
    integrationAccountId: scope.integrationAccountId,
  });

  if (!context.ok) {
    throw new Error(context.error.code);
  }

  return context.value;
}

function providerWebhookContext(
  fixture: PurposeResolutionFixture,
  providerAccountId: string,
): LiveProviderWebhookContext {
  return {
    integrationAccountId: fixture.providers.stripe.integrationAccountId,
    providerAccountId,
    environment: "development",
    signingSecretRef: fixture.handles.webhook,
    credentialGeneration: 1,
  };
}

function discordInstall(
  fixture: PurposeResolutionFixture,
  guildIdRaw: string,
): DiscordInteractionInstall {
  return {
    organisationId: fixture.organisationId,
    applicationId: requireDiscordApplicationId("111111111111111111"),
    guildId: requireDiscordGuildId(guildIdRaw),
    publicKeyRef: fixture.handles.discordPublicKey,
    status: "active",
  };
}

function surfaceInstall(
  fixture: PurposeResolutionFixture,
  workspaceId: WorkspaceId,
): OrganisationInstallRecord {
  return {
    integrationAccountId: fixture.providers.slack.integrationAccountId,
    organisationId: fixture.organisationId,
    name: "Purpose Resolution",
    plan: "beta",
    organisationStatus: "active",
    surfaceKind: "slack",
    workspaceId,
    installModel: "custom",
    botTokenRef: fixture.providers.slack.credentialRef,
    scopes: ["chat:write"],
    installedAt: NOW,
    installStatus: "active",
    lastEventReceivedAt: null,
    placement: requirePlacement(),
  };
}

function secretResult(value: string): {
  readonly ok: true;
  readonly value: VaultSecret;
} {
  return {
    ok: true,
    value: { kind: "bearer", value },
  };
}

function requireProviderScopes(
  scopes: Partial<Record<IntegrationProvider, ProviderScope>>,
): ProviderScopes {
  if (
    scopes.slack === undefined ||
    scopes.stripe === undefined ||
    scopes.shopify === undefined ||
    scopes.discord === undefined ||
    scopes.google_drive === undefined ||
    scopes.dropbox === undefined
  ) {
    throw new Error("provider fixture incomplete");
  }

  return {
    slack: scopes.slack,
    stripe: scopes.stripe,
    shopify: scopes.shopify,
    discord: scopes.discord,
    google_drive: scopes.google_drive,
    dropbox: scopes.dropbox,
  };
}

function requirePlacement(): OrganisationInstallRecord["placement"] {
  const parsed = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "test-cell",
    locationHint: "wnam",
  });

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function requireProviderConnectionId(raw: string): ProviderConnectionId {
  const parsed = parseProviderConnectionId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requireDiscordApplicationId(raw: string): DiscordApplicationId {
  const parsed = parseDiscordApplicationId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requireDiscordGuildId(raw: string): DiscordGuildId {
  const parsed = parseDiscordGuildId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
