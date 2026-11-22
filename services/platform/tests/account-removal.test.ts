// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it, vi } from "vitest";

import { removeIntegrationAccount } from "../src/data/account-removal";
import { reconcileProviderAccountCleanup } from "../src/provider-lifecycle/cleanup-reconciliation";
import { upsertUser } from "@purin-labs/tenancy/data/control-plane";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import {
  createConnectedIntegration,
  disableIntegrationAccount,
  resolveIntegrationAccount,
  resolveProviderConnection,
} from "@purin-labs/connections/data/integration-account";
import { parseVaultHandle, type VaultHandle } from "@purin-labs/authority/credential-vault/index";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";
import {
  createSplitTopology,
  onboardSplitOrganisation,
} from "./split-topology";

const NOW = 1_784_210_000_000;

describe("integration account removal", () => {
  it("keeps a disabled account reconnectable until an operator removes it", async () => {
    const db = createMigratedDatabase();
    const fixture = await createDisabledAccount(db, "reconnectable");

    const account = await resolveIntegrationAccount({
      db,
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
    });
    expect(account).toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "disabled" } },
    });
    await expect(
      db
        .prepare(
          `SELECT cleanup_id FROM provider_account_cleanup WHERE integration_account_id = ?`,
        )
        .bind(fixture.integrationAccountId)
        .first(),
    ).resolves.toBeNull();
  });

  it(
    "removes retained Slack destinations with the disabled workspace",
    removesSlackBindingsTest,
  );

  it(
    "removes a Slack account on the regional database and revokes its record in the global directory",
    removesSlackAccountOnSplitTopologyTest,
  );

  it("queues remote cleanup for a disabled unused account and preserves a non-sensitive tombstone", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "removal-owner",
        email: "removal@example.com",
        displayName: "Removal Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Removal Merchant",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const credential = parseVaultHandle("vault:removal:stripe:g1");
    if (!credential.ok) {
      throw new Error("removal test vault handle is invalid");
    }
    const connected = await createConnectedIntegration(db, {
      organisationId: organisation.organisationId,
      provider: "stripe",
      providerSubjectId: "acct_removal",
      environment: "development",
      authMode: "shared_pantry_app",
      authority: {
        kind: "connection_credential",
        credentialRef: credential.value,
      },
      grantedScopes: ["read_write"],
      createdByUserId: owner.userId,
      providerAccountId: "acct_removal",
      accountKind: "merchant_account",
      displayName: "Removal account",
      capabilities: ["payments.read"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      now: NOW + 1,
    });
    const disabled = await disableIntegrationAccount({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
      replacementIntegrationAccountId: null,
      disabledByUserId: owner.userId,
      reasonCode: "merchant_disabled",
      mutation: accountMutation(
        owner.userId,
        organisation.organisationId,
        "disable-removal-0001",
        2,
        NOW + 2,
      ),
      now: NOW + 2,
    });
    if (!disabled.ok) {
      throw new Error(`removal test disable failed: ${disabled.error.code}`);
    }
    const removed = await removeIntegrationAccount({
      db,
      directory: db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
      removedByUserId: owner.userId,
      mutation: accountMutation(
        owner.userId,
        organisation.organisationId,
        "remove-account-0001",
        3,
        NOW + 3,
      ),
      now: NOW + 3,
    });
    expect(removed).toMatchObject({
      ok: true,
      value: {
        configurationVersion: 4,
        projectionRevision: expect.any(Number),
      },
    });
    const account = await resolveIntegrationAccount({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
    });
    expect(account).toMatchObject({
      ok: true,
      value: {
        displayName: "Removed account",
        lifecycle: { kind: "revoked", revokedAt: NOW + 3 },
      },
    });
    if (!account.ok) {
      throw new Error("removed account disappeared");
    }
    expect(account.value.providerAccountId).toMatch(/^removed:[a-f0-9]{64}$/u);
    const connection = await resolveProviderConnection({
      db,
      organisationId: organisation.organisationId,
      providerConnectionId: connected.connection.providerConnectionId,
    });
    expect(connection).toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "disabled" } },
    });
    await expect(
      db
        .prepare(
          `SELECT lifecycle, provider_account_id AS providerAccountId
       FROM provider_account_cleanup WHERE integration_account_id = ?`,
        )
        .bind(connected.account.integrationAccountId)
        .first<{
          readonly lifecycle: unknown;
          readonly providerAccountId: unknown;
        }>(),
    ).resolves.toEqual({
      lifecycle: "pending_provider_cleanup",
      providerAccountId: "acct_removal",
    });
    await expect(
      db
        .prepare(
          `SELECT provider_account_hash AS providerAccountHash
       FROM provider_account_tombstone WHERE integration_account_id = ?`,
        )
        .bind(connected.account.integrationAccountId)
        .first<{ readonly providerAccountHash: unknown }>(),
    ).resolves.toMatchObject({
      providerAccountHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ stripe_user_id: "acct_removal" }));
    const env = cleanupEnv(db);
    await expect(
      reconcileProviderAccountCleanup({
        env,
        organisationId: organisation.organisationId,
        now: NOW + 3,
        fetcher,
      }),
    ).resolves.toBe(1);
    await expect(
      db
        .prepare(
          `SELECT lifecycle, attempt, next_attempt_at AS nextAttemptAt
       FROM provider_account_cleanup WHERE integration_account_id = ?`,
        )
        .bind(connected.account.integrationAccountId)
        .first(),
    ).resolves.toEqual({
      lifecycle: "retry_scheduled",
      attempt: 1,
      nextAttemptAt: NOW + 30_003,
    });
    await expect(
      reconcileProviderAccountCleanup({
        env,
        organisationId: organisation.organisationId,
        now: NOW + 30_002,
        fetcher,
      }),
    ).resolves.toBe(0);
    await expect(
      reconcileProviderAccountCleanup({
        env,
        organisationId: organisation.organisationId,
        now: NOW + 30_003,
        fetcher,
      }),
    ).resolves.toBe(1);
    await expect(
      db
        .prepare(
          `SELECT lifecycle, attempt, completed_at AS completedAt
       FROM provider_account_cleanup WHERE integration_account_id = ?`,
        )
        .bind(connected.account.integrationAccountId)
        .first(),
    ).resolves.toEqual({
      lifecycle: "completed",
      attempt: 2,
      completedAt: NOW + 30_003,
    });
    const revokedConnection = await resolveProviderConnection({
      db,
      organisationId: organisation.organisationId,
      providerConnectionId: connected.connection.providerConnectionId,
    });
    expect(revokedConnection).toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "revoked", revokedAt: NOW + 30_003 } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("settles manual provider cleanup after destroying retained local credentials", async () => {
    const db = createMigratedDatabase();
    const fixture = await createDisabledAccount(
      db,
      "airtable-manual",
      "airtable",
    );
    await seedStoredCredential(
      db,
      fixture.organisationId,
      fixture.credentialRef,
    );

    const removed = await removeIntegrationAccount({
      db,
      directory: db,
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
      removedByUserId: fixture.userId,
      mutation: accountMutation(
        fixture.userId,
        fixture.organisationId,
        "remove-airtable-manual",
        3,
        NOW + 3,
      ),
      now: NOW + 3,
    });
    expect(removed.ok).toBe(true);
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      reconcileProviderAccountCleanup({
        env: cleanupEnv(db),
        organisationId: fixture.organisationId,
        now: NOW + 3,
        fetcher,
      }),
    ).resolves.toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      db
        .prepare(
          `SELECT lifecycle, reason_code AS reasonCode, instruction_code AS instructionCode,
              attempt, completed_at AS completedAt
       FROM provider_account_cleanup WHERE integration_account_id = ?`,
        )
        .bind(fixture.integrationAccountId)
        .first(),
    ).resolves.toEqual({
      lifecycle: "manual_action_required",
      reasonCode: "provider_cleanup_provider_rejected",
      instructionCode: "revoke_airtable_access_in_airtable",
      attempt: 1,
      completedAt: NOW + 3,
    });
    await expect(
      db
        .prepare(
          `SELECT revoked_at AS revokedAt FROM credential_ref
       WHERE organisation_id = ? AND vault_handle = ?`,
        )
        .bind(fixture.organisationId, fixture.credentialRef)
        .first(),
    ).resolves.toEqual({
      revokedAt: NOW + 3,
    });
    await expect(
      db
        .prepare(
          `SELECT revoked_at AS revokedAt FROM vault_secret
       WHERE organisation_id = ? AND vault_handle = ?`,
        )
        .bind(fixture.organisationId, fixture.credentialRef)
        .first(),
    ).resolves.toEqual({
      revokedAt: NOW + 3,
    });
    const connection = await resolveProviderConnection({
      db,
      organisationId: fixture.organisationId,
      providerConnectionId: fixture.providerConnectionId,
    });
    expect(connection).toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "revoked", revokedAt: NOW + 3 } },
    });
  });
});

async function removesSlackBindingsTest(): Promise<void> {
  const db = createMigratedDatabase();
  const fixture = await createDisabledAccount(db, "bound-slack");
  await db.batch([
    db
      .prepare(
        `INSERT INTO organisation_communication_destination (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, selected_at
       ) VALUES (?, ?, 'workspace-bound-slack', 'channel-bound-slack', 'revision-1', ?)`,
      )
      .bind(fixture.organisationId, fixture.integrationAccountId, NOW + 2),
    db
      .prepare(
        `INSERT INTO organisation_slack_channel (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, connected_at
       ) VALUES (?, ?, 'workspace-bound-slack', 'channel-bound-slack', 'revision-1', ?)`,
      )
      .bind(fixture.organisationId, fixture.integrationAccountId, NOW + 2),
  ]);

  const removed = await removeIntegrationAccount({
    db,
    directory: db,
    organisationId: fixture.organisationId,
    integrationAccountId: fixture.integrationAccountId,
    removedByUserId: fixture.userId,
    mutation: accountMutation(
      fixture.userId,
      fixture.organisationId,
      "remove-bound-slack",
      3,
      NOW + 3,
    ),
    now: NOW + 3,
  });

  expect(removed.ok).toBe(true);
  await expect(
    db
      .prepare(
        `SELECT 1 AS retained FROM organisation_communication_destination
     WHERE integration_account_id = ?`,
      )
      .bind(fixture.integrationAccountId)
      .first(),
  ).resolves.toBeNull();
  await expect(
    db
      .prepare(
        `SELECT 1 AS retained FROM organisation_slack_channel
     WHERE integration_account_id = ?`,
      )
      .bind(fixture.integrationAccountId)
      .first(),
  ).resolves.toBeNull();
}

// The deployed topology: the account is in the Organisation's regional database
// and its Slack connection record in the global one.
async function removesSlackAccountOnSplitTopologyTest(): Promise<void> {
  const topology = createSplitTopology();
  const regional = topology.regional.db;
  const organisation = await onboardSplitOrganisation(topology, NOW);
  const organisationId = organisation.organisationId;
  const credential = parseVaultHandle("vault:split:slack:removal");
  if (!credential.ok) throw new Error("split test vault handle is invalid");
  const connected = await createConnectedIntegration(regional, {
    organisationId,
    provider: "slack",
    providerSubjectId: "workspace-split-removal",
    environment: "production",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: credential.value,
    },
    grantedScopes: ["chat:write"],
    createdByUserId: organisation.owner.userId,
    providerAccountId: "workspace-split-removal",
    accountKind: "workspace",
    displayName: "Split workspace",
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW + 1,
  });
  const integrationAccountId = connected.account.integrationAccountId;
  const disabled = await disableIntegrationAccount({
    db: regional,
    organisationId,
    integrationAccountId,
    replacementIntegrationAccountId: null,
    disabledByUserId: organisation.owner.userId,
    reasonCode: "merchant_disabled",
    mutation: accountMutation(
      organisation.owner.userId,
      organisationId,
      "disable-split-removal",
      2,
      NOW + 2,
    ),
    now: NOW + 2,
  });
  if (!disabled.ok) throw new Error(`disable failed: ${disabled.error.code}`);
  topology.global.sqlite.exec("PRAGMA foreign_keys = OFF");
  await topology.env.DB.prepare(
    `INSERT INTO slack_organisation_connection (
       connection_id, installation_id, organisation_id, integration_account_id,
       lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
     ) VALUES ('slack_organisation_connection_split_removal',
       'slack_installation_split_removal', ?, ?, 'disabled', 2, ?, ?, ?, NULL)`,
  )
    .bind(organisationId, integrationAccountId, NOW + 1, NOW + 2, NOW + 2)
    .run();

  const removed = await removeIntegrationAccount({
    db: regional,
    directory: topology.env.DB,
    organisationId,
    integrationAccountId,
    removedByUserId: organisation.owner.userId,
    mutation: accountMutation(
      organisation.owner.userId,
      organisationId,
      "remove-split-removal",
      3,
      NOW + 3,
    ),
    now: NOW + 3,
  });

  expect(removed.ok).toBe(true);
  await expect(
    resolveIntegrationAccount({
      db: regional,
      organisationId,
      integrationAccountId,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { lifecycle: { kind: "revoked", revokedAt: NOW + 3 } },
  });
  await expect(
    topology.env.DB.prepare(
      "SELECT lifecycle, revision, revoked_at AS revokedAt FROM slack_organisation_connection WHERE integration_account_id = ?",
    )
      .bind(integrationAccountId)
      .first(),
  ).resolves.toEqual({ lifecycle: "revoked", revision: 3, revokedAt: NOW + 3 });
}

async function createDisabledAccount(
  db: SingleDatabase,
  suffix: string,
  provider: "slack" | "airtable" = "slack",
): Promise<{
  readonly organisationId: Awaited<
    ReturnType<typeof requireOrganisationBootstrap>
  >["organisationId"];
  readonly integrationAccountId: Awaited<
    ReturnType<typeof createConnectedIntegration>
  >["account"]["integrationAccountId"];
  readonly providerConnectionId: Awaited<
    ReturnType<typeof createConnectedIntegration>
  >["connection"]["providerConnectionId"];
  readonly userId: Awaited<ReturnType<typeof upsertUser>>["userId"];
  readonly credentialRef: VaultHandle;
}> {
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `disabled-${suffix}`,
      email: `disabled-${suffix}@example.com`,
      displayName: "Disabled Owner",
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
    organisationName: `Disabled ${suffix}`,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const credential = parseVaultHandle(`vault:disabled:${provider}:${suffix}`);
  if (!credential.ok) throw new Error("disabled test vault handle is invalid");
  const connected = await createConnectedIntegration(db, {
    organisationId: organisation.organisationId,
    provider,
    providerSubjectId: `workspace-${suffix}`,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: credential.value,
    },
    grantedScopes:
      provider === "slack" ? ["chat:write"] : ["data.records:read"],
    createdByUserId: owner.userId,
    providerAccountId: `workspace-${suffix}`,
    accountKind: "workspace",
    displayName: `Workspace ${suffix}`,
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW + 1,
  });
  const disabled = await disableIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    replacementIntegrationAccountId: null,
    disabledByUserId: owner.userId,
    reasonCode: "merchant_disabled",
    mutation: accountMutation(
      owner.userId,
      organisation.organisationId,
      `disable-${suffix}`,
      2,
      NOW + 2,
    ),
    now: NOW + 2,
  });
  if (!disabled.ok) throw new Error(`disable failed: ${disabled.error.code}`);
  return {
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    providerConnectionId: connected.connection.providerConnectionId,
    userId: owner.userId,
    credentialRef: credential.value,
  };
}

async function seedStoredCredential(
  db: SingleDatabase,
  organisationId: Awaited<
    ReturnType<typeof requireOrganisationBootstrap>
  >["organisationId"],
  credentialRef: VaultHandle,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO credential_ref (
       organisation_id, provider, name, vault_handle, host_pattern,
       inject_as, created_at, revoked_at
     ) VALUES (?, 'airtable', 'oauth', ?, 'api.airtable.com',
       '{"kind":"header","header":"authorization","scheme":"Bearer"}', ?, NULL)`,
    )
    .bind(organisationId, credentialRef, NOW + 1)
    .run();
  await db
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (?, ?, 'v1', 'AES-GCM-256', 'nonce', 'ciphertext', ?, NULL, NULL)`,
    )
    .bind(organisationId, credentialRef, NOW + 1)
    .run();
}

function accountMutation(
  userId: Parameters<typeof removeIntegrationAccount>[0]["removedByUserId"],
  organisationId: Parameters<
    typeof removeIntegrationAccount
  >[0]["organisationId"],
  idempotencyKey: string,
  expectedConfigurationVersion: number,
  now: number,
) {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey,
      requestHash: `${idempotencyKey}-hash`,
      expectedConfigurationVersion,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}/accounts`,
      operation: idempotencyKey.startsWith("disable")
        ? "provider.account.disable"
        : "provider.account.remove",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "removal-owner-hash",
      causationId: `${idempotencyKey}-request`,
      now,
    }),
  };
}

function cleanupEnv(db: SingleDatabase) {
  return {
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: db,
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    STRIPE_CONNECT_CLIENT_ID: "stripe-client",
    STRIPE_CONNECT_CLIENT_SECRET: "stripe-secret",
  };
}
