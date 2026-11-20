import type { SingleDatabase } from "../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { upsertUser } from "../src/data/control-plane";
import { newControlMutationIdentity } from "../src/data/control-mutation";
import {
  attachIntegrationAccount,
  createConnectedIntegration,
  disableIntegrationAccount,
  finalizeConnectedIntegrationAccount,
  listActiveProviderAccountTargets,
  listIntegrationAccounts,
  integrationAccountAllowsCredentialMutation,
  providerConnectionAllowsCredentialMutation,
  connectionCredentialAuthority,
  resolveProviderConnection,
  resolveActiveProviderAccountContext,
  setIntegrationAccountLifecycle,
  switchDefaultIntegrationAccount,
  upsertProviderWebhook,
  type ConnectedIntegrationSeed,
  type IntegrationAccountMutation,
} from "../src/data/integration-account";
import {
  recordProviderStartFailure,
} from "../src/organisation/contract/provider-support-references";
import {
  type UserId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../src/ids";
import { revokeCredential, type VaultHandle } from "../src/credential-vault";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { requireUserId, requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_016_325_277;
const SQUARE_SCOPES = [
  "DEVICE_CREDENTIAL_MANAGEMENT",
  "DEVICES_READ",
  "MERCHANT_PROFILE_READ",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
] as const;

describe("integration account lifecycle", integrationAccountLifecycleSuite);

function integrationAccountLifecycleSuite(): void {
  it(
    "admits only valid credential lifecycle mutations",
    credentialMutationLifecycleTest,
  );
  it(
    "preserves identity, fences stale webhooks, and increments credentials on reconnect",
    reconnectLifecycleTest,
  );
  it(
    "recovers and rotates an isolated Square credential without changing merchant identity",
    squareCredentialRecoveryLifecycleTest,
  );
  it(
    "creates fresh authority after full credential revocation",
    revokedAuthorityRecoveryTest,
  );
  it(
    "disconnects the sole default and assigns the next connected account",
    soleDefaultDisconnectTest,
  );
  it(
    "transfers the default when disabling with a replacement",
    defaultDisableReplacementTest,
  );
  it(
    "switches the Slack default account when no setup destination is configured",
    defaultSwitchWithoutDestinationTest,
  );
  it(
    "resolves only the finalized provider's open support references",
    supportReferenceResolutionTest,
  );
}

async function revokedAuthorityRecoveryTest(): Promise<void> {
  const db = createMigratedDatabase();
  // Finalizing a non-Slack account must not depend on Slack's storage.
  await db.prepare("DROP TABLE slack_organisation_connection").run();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "revoked-authority-owner",
      email: "revoked-authority@example.com",
      displayName: "Revoked Authority Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Revoked Authority Recovery",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const firstCredential = requireVaultHandle(
    "vault:organisation:whatsapp:waba-test:oauth:revoked",
  );
  const first = await createConnectedIntegration(
    db,
    whatsappSeed(
      organisation.organisationId,
      owner.userId,
      firstCredential,
      NOW + 1,
    ),
  );
  await finalizeConnectedIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    now: NOW + 2,
  });
  const second = await attachIntegrationAccount(db, {
    organisationId: organisation.organisationId,
    providerConnectionId: first.connection.providerConnectionId,
    provider: "whatsapp",
    environment: "development",
    providerAccountId: "phone-number-second",
    accountKind: "phone_number",
    displayName: "Second WhatsApp number",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW + 2,
  });
  if (!second.ok) throw new Error(second.error.code);
  await finalizeConnectedIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: second.value.integrationAccountId,
    now: NOW + 2,
  });

  await revokeCredential({
    db,
    organisationId: organisation.organisationId,
    handle: firstCredential,
    now: NOW + 3,
  });

  const replacementCredential = requireVaultHandle(
    "vault:organisation:whatsapp:waba-test:oauth:replacement",
  );
  const replacement = await createConnectedIntegration(
    db,
    whatsappSeed(
      organisation.organisationId,
      owner.userId,
      replacementCredential,
      NOW + 4,
    ),
  );
  const recoveredSecond = await attachIntegrationAccount(db, {
    organisationId: organisation.organisationId,
    providerConnectionId: replacement.connection.providerConnectionId,
    provider: "whatsapp",
    environment: "development",
    providerAccountId: "phone-number-second",
    accountKind: "phone_number",
    displayName: "Second WhatsApp number",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW + 4,
  });
  if (!recoveredSecond.ok) throw new Error(recoveredSecond.error.code);

  expect(replacement.account.integrationAccountId).toBe(
    first.account.integrationAccountId,
  );
  expect(replacement.connection.providerConnectionId).not.toBe(
    first.connection.providerConnectionId,
  );
  expect(replacement.connection.authority).toEqual({
    kind: "connection_credential",
    credentialGeneration: 1,
    credentialRef: replacementCredential,
  });
  expect(recoveredSecond.value.integrationAccountId).toBe(
    second.value.integrationAccountId,
  );
  expect(recoveredSecond.value.providerConnectionId).toBe(
    replacement.connection.providerConnectionId,
  );
  expect(recoveredSecond.value.lifecycle.kind).toBe("pending_activation");
  await expect(
    resolveProviderConnection({
      db,
      organisationId: organisation.organisationId,
      providerConnectionId: first.connection.providerConnectionId,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { lifecycle: { kind: "revoked" } },
  });
  await expect(
    credentialGenerationLifecycle(db, first.connection.providerConnectionId, 1),
  ).resolves.toEqual({ lifecycle: "revoked", revokedAt: NOW + 3 });
  await expect(
    credentialGenerationLifecycle(
      db,
      replacement.connection.providerConnectionId,
      1,
    ),
  ).resolves.toEqual({ lifecycle: "active", revokedAt: null });
}

async function supportReferenceResolutionTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "support-resolution-owner",
      email: "support-resolution@example.com",
      displayName: "Support Resolution Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Support Resolution",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const slackFailure = await recordProviderStartFailure({
    db,
    organisationId: organisation.organisationId,
    environment: "development",
    actorUserId: owner.userId,
    provider: "slack",
    route: `/v1/control/organisations/${organisation.organisationId}/providers/slack/start`,
    reasonCode: "provider_temporarily_unavailable",
    retryable: true,
    now: NOW + 1,
  });
  const gmailFailure = await recordProviderStartFailure({
    db,
    organisationId: organisation.organisationId,
    environment: "development",
    actorUserId: owner.userId,
    provider: "gmail",
    route: `/v1/control/organisations/${organisation.organisationId}/providers/gmail/start`,
    reasonCode: "provider_temporarily_unavailable",
    retryable: true,
    now: NOW + 1,
  });

  const slack = await createConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, "T333", NOW + 2),
  );
  await finalizeConnectedIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: slack.account.integrationAccountId,
    now: NOW + 3,
  });

  await expect(
    readSupportResolution(db, slackFailure.supportReference),
  ).resolves.toBe(NOW + 3);
  await expect(
    readSupportResolution(db, gmailFailure.supportReference),
  ).resolves.toBeNull();
}

async function readSupportResolution(
  db: SingleDatabase,
  supportReference: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT resolved_at AS resolvedAt FROM onboarding_support_reference
     WHERE support_reference = ?`,
    )
    .bind(supportReference)
    .first<{ readonly resolvedAt: unknown }>();
  if (row === null) {
    throw new Error("support reference is missing");
  }
  return row.resolvedAt === null ? null : (row.resolvedAt as number);
}

async function soleDefaultDisconnectTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "sole-default-owner",
      email: "sole-default@example.com",
      displayName: "Sole Default Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Sole Default",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const first = await createConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, "T111", NOW),
  );
  await finalizeConnectedIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    now: NOW + 1,
  });

  const disabled = await disableIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    replacementIntegrationAccountId: null,
    disabledByUserId: owner.userId,
    reasonCode: "merchant_disabled",
    mutation: accountMutation(
      organisation.organisationId,
      owner.userId,
      first.account.integrationAccountId,
      "provider.account.disable",
      "sole-default-disable-0001",
      2,
      NOW + 2,
    ),
    now: NOW + 2,
  });
  expect(disabled.ok).toBe(true);

  const replacement = await createConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, "T222", NOW + 3),
  );
  await finalizeConnectedIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: replacement.account.integrationAccountId,
    now: NOW + 4,
  });

  const accounts = await listIntegrationAccounts({
    db,
    organisationId: organisation.organisationId,
  });
  expect(
    accounts
      .map((account) => ({
        accountId: account.integrationAccountId,
        lifecycle: account.lifecycle.kind,
        isDefaultForProvider: account.isDefaultForProvider,
      }))
      .sort(compareAccountState),
  ).toEqual(
    [
      {
        accountId: first.account.integrationAccountId,
        lifecycle: "disabled",
        isDefaultForProvider: false,
      },
      {
        accountId: replacement.account.integrationAccountId,
        lifecycle: "active",
        isDefaultForProvider: true,
      },
    ].sort(compareAccountState),
  );
}

function credentialMutationLifecycleTest(): void {
  expect(
    integrationAccountAllowsCredentialMutation(
      {
        kind: "disabled",
        disabledByUserId: requireUserId(
          "user_2d97a5e7-c7aa-5fbb-a911-440331bfbfda",
        ),
        disabledAt: NOW,
      },
      "reconnect",
    ),
  ).toBe(true);
  expect(
    integrationAccountAllowsCredentialMutation({ kind: "active" }, "rotate"),
  ).toBe(true);
  expect(
    integrationAccountAllowsCredentialMutation(
      { kind: "revoked", revokedAt: NOW },
      "reconnect",
    ),
  ).toBe(false);
  expect(
    integrationAccountAllowsCredentialMutation({ kind: "active" }, "reconnect"),
  ).toBe(true);
  expect(
    providerConnectionAllowsCredentialMutation(
      { kind: "disabled", disabledAt: NOW },
      "reconnect",
    ),
  ).toBe(true);
  expect(
    providerConnectionAllowsCredentialMutation({ kind: "active" }, "rotate"),
  ).toBe(true);
  expect(
    providerConnectionAllowsCredentialMutation(
      { kind: "revoked", revokedAt: NOW },
      "reconnect",
    ),
  ).toBe(false);
  expect(
    providerConnectionAllowsCredentialMutation(
      { kind: "reauth_required" },
      "rotate",
    ),
  ).toBe(false);
}

async function defaultSwitchWithoutDestinationTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "primary-switch-owner",
      email: "primary-switch@example.com",
      displayName: "Primary Switch Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Primary Switch",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const first = await createConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, "T111", NOW),
  );
  const replacement = await createConnectedIntegration(
    db,
    slackSeed(organisation.organisationId, owner.userId, "T222", NOW + 1),
  );
  const commerce = await createConnectedIntegration(
    db,
    stripeSeed(
      organisation.organisationId,
      owner.userId,
      requireVaultHandle("vault:organisation:stripe:acct_primary:oauth:g1"),
      NOW + 2,
      "acct_primary",
    ),
  );
  for (const account of [
    first.account,
    replacement.account,
    commerce.account,
  ]) {
    await setIntegrationAccountLifecycle({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: account.integrationAccountId,
      lifecycle: { kind: "active" },
      now: NOW + 3,
    });
  }
  const initialDefault = await switchDefaultIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    nextIntegrationAccountId: first.account.integrationAccountId,
    changedByUserId: owner.userId,
    mutation: accountMutation(
      organisation.organisationId,
      owner.userId,
      first.account.integrationAccountId,
      "provider.account.set_default_for_provider",
      "primary-switch-without-destination-0001",
      4,
      NOW + 4,
    ),
    now: NOW + 4,
  });
  expect(initialDefault.ok).toBe(true);
  const switched = await switchDefaultIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    nextIntegrationAccountId: replacement.account.integrationAccountId,
    changedByUserId: owner.userId,
    mutation: accountMutation(
      organisation.organisationId,
      owner.userId,
      replacement.account.integrationAccountId,
      "provider.account.set_default_for_provider",
      "primary-switch-without-destination-0002",
      5,
      NOW + 6,
    ),
    now: NOW + 6,
  });
  expect(switched.ok).toBe(true);
}

async function defaultDisableReplacementTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "primary-disable-owner",
      email: "primary-disable@example.com",
      displayName: "Primary Disable Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Primary Disable",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const first = await createConnectedIntegration(
    db,
    stripeSeed(
      organisation.organisationId,
      owner.userId,
      requireVaultHandle("vault:organisation:stripe:acct_1:oauth:g1"),
      NOW,
      "acct_1",
    ),
  );
  const replacement = await createConnectedIntegration(
    db,
    stripeSeed(
      organisation.organisationId,
      owner.userId,
      requireVaultHandle("vault:organisation:stripe:acct_2:oauth:g1"),
      NOW + 1,
      "acct_2",
    ),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 2,
  });
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: replacement.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 2,
  });

  const switched = await switchDefaultIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    nextIntegrationAccountId: first.account.integrationAccountId,
    changedByUserId: owner.userId,
    mutation: accountMutation(
      organisation.organisationId,
      owner.userId,
      first.account.integrationAccountId,
      "provider.account.set_default_for_provider",
      "primary-switch-0001",
      3,
      NOW + 3,
    ),
    now: NOW + 3,
  });
  expect(switched.ok).toBe(true);

  const disabled = await disableIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    replacementIntegrationAccountId: replacement.account.integrationAccountId,
    disabledByUserId: owner.userId,
    reasonCode: "merchant_disabled",
    mutation: accountMutation(
      organisation.organisationId,
      owner.userId,
      first.account.integrationAccountId,
      "provider.account.disable",
      "primary-disable-0001",
      4,
      NOW + 4,
    ),
    now: NOW + 4,
  });
  expect(disabled.ok).toBe(true);
  if (!disabled.ok) {
    throw new Error(disabled.error.code);
  }
  expect(disabled.value.account.lifecycle.kind).toBe("disabled");

  const accounts = await listIntegrationAccounts({
    db,
    organisationId: organisation.organisationId,
  });
  expect(
    accounts
      .map((account) => ({
        accountId: account.integrationAccountId,
        lifecycle: account.lifecycle.kind,
        isDefaultForProvider: account.isDefaultForProvider,
      }))
      .sort(compareAccountState),
  ).toEqual(
    [
      {
        accountId: replacement.account.integrationAccountId,
        lifecycle: "active",
        isDefaultForProvider: true,
      },
      {
        accountId: first.account.integrationAccountId,
        lifecycle: "disabled",
        isDefaultForProvider: false,
      },
    ].sort(compareAccountState),
  );

  await expect(
    disableIntegrationAccount({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: first.account.integrationAccountId,
      replacementIntegrationAccountId: null,
      disabledByUserId: owner.userId,
      reasonCode: "merchant_disabled",
      mutation: accountMutation(
        organisation.organisationId,
        owner.userId,
        first.account.integrationAccountId,
        "provider.account.disable",
        "primary-disable-0002",
        5,
        NOW + 5,
      ),
      now: NOW + 5,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "integration_account_inactive", lifecycle: "disabled" },
  });
}

async function reconnectLifecycleTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "integration-owner",
      email: "owner@example.com",
      displayName: "Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Integration Lifecycle",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const firstCredential = requireVaultHandle(
    "vault:organisation:stripe:acct_1:oauth:g1",
  );
  const secondCredential = requireVaultHandle(
    "vault:organisation:stripe:acct_1:oauth:g2",
  );
  const thirdCredential = requireVaultHandle(
    "vault:organisation:stripe:acct_1:oauth:g3",
  );
  const signingSecret = requireVaultHandle(
    "vault:organisation:stripe:acct_1:webhook:g1",
  );

  const first = await createConnectedIntegration(
    db,
    stripeSeed(
      organisation.organisationId,
      owner.userId,
      firstCredential,
      NOW,
      "acct_1",
    ),
  );
  expect(
    connectionCredentialAuthority(first.connection.authority)
      ?.credentialGeneration,
  ).toBe(1);
  expect(first.account.lifecycle.kind).toBe("pending_activation");

  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 1,
  });
  await upsertProviderWebhook({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    provider: "stripe",
    environment: "development",
    providerNativeId: "we_1",
    eventType: "commerce_events",
    signingSecretRef: signingSecret,
    credentialGeneration:
      connectionCredentialAuthority(first.connection.authority)
        ?.credentialGeneration ?? 1,
    lifecycle: { kind: "live", lastVerifiedAt: NOW + 1 },
    now: NOW + 1,
  });
  await expect(
    listActiveProviderAccountTargets({
      db,
      provider: "stripe",
      providerAccountId: "acct_1",
      providerNativeId: "we_1",
    }),
  ).resolves.toEqual([
    {
      organisationId: organisation.organisationId,
      integrationAccountId: first.account.integrationAccountId,
    },
  ]);

  const second = await createConnectedIntegration(
    db,
    stripeSeed(
      organisation.organisationId,
      owner.userId,
      secondCredential,
      NOW + 2,
      "acct_1",
    ),
  );
  expect(second.account.integrationAccountId).toBe(
    first.account.integrationAccountId,
  );
  expect(second.connection.providerConnectionId).toBe(
    first.connection.providerConnectionId,
  );
  expect(
    connectionCredentialAuthority(second.connection.authority)
      ?.credentialGeneration,
  ).toBe(2);
  expect(second.account.lifecycle.kind).toBe("active");
  await expect(
    credentialGenerationLifecycle(
      db,
      second.connection.providerConnectionId,
      1,
    ),
  ).resolves.toEqual({ lifecycle: "superseded", revokedAt: null });
  await expect(
    webhookLifecycle(db, first.account.integrationAccountId),
  ).resolves.toBe("disabled");

  const disabled = await disableIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    replacementIntegrationAccountId: null,
    disabledByUserId: owner.userId,
    reasonCode: "merchant_disabled",
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "disable-account-key-0001",
        requestHash: "disable-account-request",
        expectedConfigurationVersion: 3,
      },
      scope: {
        userId: owner.userId,
        organisationScope: organisation.organisationId,
        route: `/v1/control/organisations/${organisation.organisationId}/accounts/${first.account.integrationAccountId}/disable`,
        operation: "provider.account.disable",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "integration-account-owner",
        causationId: "disable-account-request",
        now: NOW + 3,
      }),
    },
    now: NOW + 3,
  });
  expect(disabled.ok && disabled.value.account.lifecycle.kind).toBe("disabled");
  await expect(
    resolveActiveProviderAccountContext({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: first.account.integrationAccountId,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "integration_account_inactive", lifecycle: "disabled" },
  });

  const third = await createConnectedIntegration(
    db,
    stripeSeed(
      organisation.organisationId,
      owner.userId,
      thirdCredential,
      NOW + 4,
      "acct_1",
    ),
  );
  expect(third.account.integrationAccountId).toBe(
    first.account.integrationAccountId,
  );
  expect(third.connection.providerConnectionId).toBe(
    first.connection.providerConnectionId,
  );
  expect(
    connectionCredentialAuthority(third.connection.authority)
      ?.credentialGeneration,
  ).toBe(3);
  expect(third.account.lifecycle.kind).toBe("active");
  await expect(
    credentialGenerationLifecycle(db, third.connection.providerConnectionId, 2),
  ).resolves.toEqual({ lifecycle: "superseded", revokedAt: null });
}

async function squareCredentialRecoveryLifecycleTest(): Promise<void> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "square-integration-owner",
      email: "square-owner@example.com",
      displayName: "Square Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Square Credential Lifecycle",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const first = await createConnectedIntegration(
    db,
    squareSeed(
      organisation.organisationId,
      owner.userId,
      squareCredential(1),
      NOW,
    ),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 1,
  });
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: first.account.integrationAccountId,
    lifecycle: {
      kind: "reauth_required",
      reasonCode: "oauth_authorization_revoked",
    },
    now: NOW + 2,
  });

  const recovered = await createConnectedIntegration(
    db,
    squareSeed(
      organisation.organisationId,
      owner.userId,
      squareCredential(2),
      NOW + 3,
    ),
  );
  expect(recovered.account.integrationAccountId).toBe(
    first.account.integrationAccountId,
  );
  expect(recovered.connection.providerConnectionId).toBe(
    first.connection.providerConnectionId,
  );
  expect(recovered.connection.providerSubjectId).toBe(
    "merchant_square_isolated",
  );
  expect(recovered.connection.grantedScopes).toEqual(SQUARE_SCOPES);
  expect(
    connectionCredentialAuthority(recovered.connection.authority)
      ?.credentialGeneration,
  ).toBe(2);
  expect(recovered.account.lifecycle.kind).toBe("active");
  await expect(
    credentialGenerationLifecycle(
      db,
      recovered.connection.providerConnectionId,
      1,
    ),
  ).resolves.toEqual({ lifecycle: "superseded", revokedAt: null });

  const disabled = await disableIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: recovered.account.integrationAccountId,
    replacementIntegrationAccountId: null,
    disabledByUserId: owner.userId,
    reasonCode: "merchant_disabled",
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "disable-square-account-key-0001",
        requestHash: "disable-square-account-request",
        expectedConfigurationVersion: 3,
      },
      scope: {
        userId: owner.userId,
        organisationScope: organisation.organisationId,
        route: `/v1/control/organisations/${organisation.organisationId}/accounts/${recovered.account.integrationAccountId}/disable`,
        operation: "provider.account.disable",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "square-integration-account-owner",
        causationId: "disable-square-account-request",
        now: NOW + 4,
      }),
    },
    now: NOW + 4,
  });
  expect(disabled.ok && disabled.value.account.lifecycle.kind).toBe("disabled");

  const reconnected = await createConnectedIntegration(
    db,
    squareSeed(
      organisation.organisationId,
      owner.userId,
      squareCredential(3),
      NOW + 5,
    ),
  );
  expect(reconnected.account.integrationAccountId).toBe(
    first.account.integrationAccountId,
  );
  expect(reconnected.connection.providerConnectionId).toBe(
    first.connection.providerConnectionId,
  );
  expect(
    connectionCredentialAuthority(reconnected.connection.authority)
      ?.credentialGeneration,
  ).toBe(3);
  await expect(
    credentialGenerationLifecycle(
      db,
      reconnected.connection.providerConnectionId,
      2,
    ),
  ).resolves.toEqual({ lifecycle: "superseded", revokedAt: null });

  const rotated = await createConnectedIntegration(
    db,
    squareSeed(
      organisation.organisationId,
      owner.userId,
      squareCredential(4),
      NOW + 6,
    ),
  );
  expect(rotated.account.integrationAccountId).toBe(
    first.account.integrationAccountId,
  );
  expect(rotated.connection.providerConnectionId).toBe(
    first.connection.providerConnectionId,
  );
  expect(rotated.connection.providerSubjectId).toBe("merchant_square_isolated");
  expect(rotated.connection.grantedScopes).toEqual(SQUARE_SCOPES);
  expect(
    connectionCredentialAuthority(rotated.connection.authority)
      ?.credentialGeneration,
  ).toBe(4);
  expect(rotated.account.lifecycle.kind).toBe("active");
  await expect(
    credentialGenerationLifecycle(
      db,
      rotated.connection.providerConnectionId,
      3,
    ),
  ).resolves.toEqual({ lifecycle: "superseded", revokedAt: null });
}

async function credentialGenerationLifecycle(
  db: SingleDatabase,
  providerConnectionId: ProviderConnectionId,
  generation: number,
): Promise<{
  readonly lifecycle: string;
  readonly revokedAt: number | null;
} | null> {
  return db
    .prepare(
      `SELECT lifecycle, revoked_at AS revokedAt
     FROM provider_credential_generation
     WHERE provider_connection_id = ? AND credential_generation = ?`,
    )
    .bind(providerConnectionId, generation)
    .first();
}

function stripeSeed(
  organisationId: OrganisationId,
  userId: UserId,
  credentialRef: VaultHandle,
  now: number,
  providerAccountId: string,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "stripe",
    providerSubjectId: providerAccountId,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: ["read_write"],
    createdByUserId: userId,
    providerAccountId,
    accountKind: "merchant_account",
    displayName: "Stripe account",
    capabilities: ["payments.read", "refunds.propose"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

function squareCredential(generation: number): VaultHandle {
  return requireVaultHandle(
    `vault:organisation:square:merchant_square_isolated:oauth:g${generation}`,
  );
}

function squareSeed(
  organisationId: OrganisationId,
  userId: UserId,
  credentialRef: VaultHandle,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "square",
    providerSubjectId: "merchant_square_isolated",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: SQUARE_SCOPES,
    createdByUserId: userId,
    providerAccountId: "merchant_square_isolated",
    accountKind: "merchant_account",
    displayName: "Square sandbox seller",
    capabilities: [
      "payments.read",
      "payments.collect_in_person",
      "refunds.execute",
    ],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

function whatsappSeed(
  organisationId: OrganisationId,
  userId: UserId,
  credentialRef: VaultHandle,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "whatsapp",
    providerSubjectId: "waba-test",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: [
      "business_management",
      "whatsapp_business_management",
      "whatsapp_business_messaging",
    ],
    createdByUserId: userId,
    providerAccountId: "phone-number-test",
    accountKind: "phone_number",
    displayName: "Test WhatsApp number",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

function slackSeed(
  organisationId: OrganisationId,
  userId: UserId,
  workspaceId: string,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "slack",
    providerSubjectId: workspaceId,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: {
      kind: "connection_credential",
      credentialRef: requireVaultHandle(
        `vault:organisation:slack:${workspaceId.toLowerCase()}:oauth:g1`,
      ),
    },
    grantedScopes: ["channels:read", "chat:write"],
    createdByUserId: userId,
    providerAccountId: workspaceId,
    accountKind: "workspace",
    displayName: workspaceId,
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}

function accountMutation(
  organisationId: OrganisationId,
  userId: UserId,
  integrationAccountId: string,
  operation:
    "provider.account.set_default_for_provider" | "provider.account.disable",
  idempotencyKey: string,
  expectedConfigurationVersion: number,
  now: number,
): IntegrationAccountMutation {
  const route =
    operation === "provider.account.set_default_for_provider"
      ? `/v1/control/organisations/${organisationId}/accounts/${integrationAccountId}/default-for-provider`
      : `/v1/control/organisations/${organisationId}/accounts/${integrationAccountId}/disable`;
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey,
      requestHash: `${idempotencyKey}-request`,
      expectedConfigurationVersion,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route,
      operation,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "primary-disable-owner",
      causationId: idempotencyKey,
      now,
    }),
  };
}

function compareAccountState(
  left: { readonly accountId: string },
  right: { readonly accountId: string },
): number {
  return left.accountId.localeCompare(right.accountId);
}

async function webhookLifecycle(
  db: SingleDatabase,
  integrationAccountId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT lifecycle FROM provider_webhook WHERE integration_account_id = ?`,
    )
    .bind(integrationAccountId)
    .first<{ lifecycle: string }>();
  return row?.lifecycle ?? null;
}
