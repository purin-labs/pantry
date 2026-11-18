import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  activateCredentialRevocationPolicy,
  recordCredentialRestrictionDeliveryProgress,
  revokeCredential,
} from "../src/credential-vault";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";

describe("Credential Vault revocation", credentialVaultRevocationSuite);

function credentialVaultRevocationSuite(): void {
  it(
    "commits the full credential teardown once and finalizes policy evidence once",
    revokesOnce,
  );
}

async function revokesOnce(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId("organisation_revocation_test");
  const handle = requireVaultHandle("vault:stripe:revocation-test");

  seedCredentialGraph(sqlite, organisationId, handle);

  const committed = await revokeCredential({
    db,
    organisationId,
    handle,
    now: 1_000,
  });

  expect(committed).toEqual({
    revocationId: `credential-revocation:${organisationId}:${handle}`,
    organisationId,
    handle,
    state: "committed",
    credentialGenerationCount: 1,
    providerConnectionCount: 1,
    integrationAccountCount: 1,
    providerWebhookCount: 1,
    credentialRefCount: 1,
    vaultSecretCount: 1,
    startedAt: 1_000,
    committedAt: 1_000,
  });
  expect(readCredentialGraph(sqlite)).toEqual({
    generation: { lifecycle: "revoked", revokedAt: 1_000 },
    connection: { lifecycle: "revoked", revokedAt: 1_000 },
    account: { lifecycle: "revoked", revokedAt: 1_000 },
    webhook: { lifecycle: "revoked", updatedAt: 1_000 },
    credential: { revokedAt: 1_000 },
    secret: { revokedAt: 1_000 },
  });

  const retriedCommit = await revokeCredential({
    db,
    organisationId,
    handle,
    now: 2_000,
  });

  expect(retriedCommit).toEqual(committed);
  expect(readCredentialGraph(sqlite)).toEqual({
    generation: { lifecycle: "revoked", revokedAt: 1_000 },
    connection: { lifecycle: "revoked", revokedAt: 1_000 },
    account: { lifecycle: "revoked", revokedAt: 1_000 },
    webhook: { lifecycle: "revoked", updatedAt: 1_000 },
    credential: { revokedAt: 1_000 },
    secret: { revokedAt: 1_000 },
  });

  if (retriedCommit.state !== "committed") {
    throw new Error("expected committed credential revocation");
  }

  const activated = await activateCredentialRevocationPolicy({
    db,
    commit: retriedCommit,
    policyVersion: 7,
    restrictionVersion: 7,
    targetConsumerCount: 2,
    acknowledgedConsumerCount: 1,
    pendingConsumerCount: 1,
    activatedAt: 1_100,
  });

  expect(activated).toMatchObject({
    state: "policy_activated",
    policyVersion: 7,
    restrictionVersion: 7,
    targetConsumerCount: 2,
    acknowledgedConsumerCount: 1,
    pendingConsumerCount: 1,
    retryCount: 0,
    restrictionLatencyMs: 100,
    policyActivatedAt: 1_100,
  });

  const retriedActivation = await activateCredentialRevocationPolicy({
    db,
    commit: retriedCommit,
    policyVersion: 8,
    restrictionVersion: 8,
    targetConsumerCount: 3,
    acknowledgedConsumerCount: 3,
    pendingConsumerCount: 0,
    activatedAt: 2_100,
  });
  const completedRetry = await revokeCredential({
    db,
    organisationId,
    handle,
    now: 3_000,
  });

  expect(retriedActivation).toEqual(activated);
  expect(completedRetry).toEqual(activated);

  await recordCredentialRestrictionDeliveryProgress({
    db,
    organisationId,
    restrictionVersion: 7,
    latencyMs: 5_000,
    outcome: "acknowledged",
  });

  await expect(
    revokeCredential({
      db,
      organisationId,
      handle,
      now: 4_000,
    }),
  ).resolves.toMatchObject({
    state: "policy_activated",
    targetConsumerCount: 2,
    acknowledgedConsumerCount: 2,
    pendingConsumerCount: 0,
    retryCount: 1,
    restrictionLatencyMs: 5_000,
  });
}

function seedCredentialGraph(
  sqlite: DatabaseSync,
  organisationId: string,
  handle: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Revocation Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  sqlite.exec(`
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES (
      'control_revocation_test', 'urn:satyr:test', 'revocation-test',
      'revocation-test@example.invalid', 'Revocation Test', 1, 1, 1
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision,
       activation_attempt_id, readiness_version,
       activation_receipt_id, activated_at,
       suspension_reason_code, suspended_at, archived_at, purge_after, updated_at
     ) VALUES (
       ?, 'development', 'active', 'read_and_propose',
       1, 1, NULL, NULL, 'activation_revocation_test', 1,
       NULL, NULL, NULL, NULL, 1
     )`,
    )
    .run(organisationId);
  sqlite
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation,
       credential_ref, lifecycle, granted_scopes, created_by_user_id,
       created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id
     ) VALUES (
       'connection_revocation_test', ?, 'stripe', 'api_key', 'connection_credential', 1,
       ?, 'active', '[]', 'control_revocation_test',
       1, 1, NULL, NULL, 'development', 'acct_revocation_test'
     )`,
    )
    .run(organisationId, handle);
  sqlite
    .prepare(
      `INSERT INTO provider_credential_generation (
       provider_connection_id, credential_generation, organisation_id, provider,
       environment, credential_ref, lifecycle, created_at, activated_at,
       superseded_at, revoked_at, failed_at, failure_code
     ) VALUES (
       'connection_revocation_test', 1, ?, 'stripe',
       'development', ?, 'active', 1, 1,
       NULL, NULL, NULL, NULL
     )`,
    )
    .run(organisationId, handle);
  sqlite
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, disabled_by_user_id, disabled_at,
       revoked_at, environment, is_default_for_provider
     ) VALUES (
       'account_revocation_test', ?, 'connection_revocation_test', 'stripe',
       'acct_revocation_test', 'account', 'Revocation Test', 'active',
       NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
       1, 1, NULL, NULL, NULL, 'development', 1
     )`,
    )
    .run(organisationId);
  sqlite
    .prepare(
      `INSERT INTO provider_webhook (
       provider_webhook_id, organisation_id, integration_account_id, provider,
       provider_native_id, event_type, lifecycle, lifecycle_reason_code,
       signing_secret_ref, credential_generation, last_verified_at, updated_at
     ) VALUES (
       'webhook_revocation_test', ?, 'account_revocation_test', 'stripe',
       'endpoint_revocation_test', 'charge.failed', 'live', NULL,
       ?, 1, 1, 1
     )`,
    )
    .run(organisationId, handle);
  sqlite
    .prepare(
      `INSERT INTO credential_ref (
       organisation_id, provider, name, vault_handle, host_pattern,
       inject_as, created_at, revoked_at
     ) VALUES (
       ?, 'stripe', 'revocation-test', ?, 'api.stripe.com',
       '{"kind":"header","header":"authorization","scheme":"Bearer"}', 1, NULL
     )`,
    )
    .run(organisationId, handle);
  sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (
       ?, ?, 'v1', 'AES-GCM-256', 'nonce', 'ciphertext', 1, NULL, NULL
     )`,
    )
    .run(organisationId, handle);
}

function readCredentialGraph(sqlite: DatabaseSync): {
  readonly generation: {
    readonly lifecycle: string;
    readonly revokedAt: number | null;
  };
  readonly connection: {
    readonly lifecycle: string;
    readonly revokedAt: number | null;
  };
  readonly account: {
    readonly lifecycle: string;
    readonly revokedAt: number | null;
  };
  readonly webhook: { readonly lifecycle: string; readonly updatedAt: number };
  readonly credential: { readonly revokedAt: number | null };
  readonly secret: { readonly revokedAt: number | null };
} {
  return {
    generation: sqlite
      .prepare(
        `SELECT lifecycle, revoked_at AS revokedAt
       FROM provider_credential_generation
       WHERE provider_connection_id = 'connection_revocation_test'`,
      )
      .get() as { lifecycle: string; revokedAt: number | null },
    connection: sqlite
      .prepare(
        `SELECT lifecycle, revoked_at AS revokedAt
       FROM provider_connection
       WHERE provider_connection_id = 'connection_revocation_test'`,
      )
      .get() as { lifecycle: string; revokedAt: number | null },
    account: sqlite
      .prepare(
        `SELECT lifecycle, revoked_at AS revokedAt
       FROM integration_account
       WHERE integration_account_id = 'account_revocation_test'`,
      )
      .get() as { lifecycle: string; revokedAt: number | null },
    webhook: sqlite
      .prepare(
        `SELECT lifecycle, updated_at AS updatedAt
       FROM provider_webhook
       WHERE provider_webhook_id = 'webhook_revocation_test'`,
      )
      .get() as { lifecycle: string; updatedAt: number },
    credential: sqlite
      .prepare(
        `SELECT revoked_at AS revokedAt
       FROM credential_ref
       WHERE name = 'revocation-test'`,
      )
      .get() as { revokedAt: number | null },
    secret: sqlite
      .prepare(
        `SELECT revoked_at AS revokedAt
       FROM vault_secret
       WHERE vault_handle = 'vault:stripe:revocation-test'`,
      )
      .get() as { revokedAt: number | null },
  };
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(singleDatabaseSchema());

  return database;
}
