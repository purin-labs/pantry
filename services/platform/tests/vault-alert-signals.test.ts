import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  recordCredentialAccessDenial,
  sweepVaultAlertSignals,
} from "../src/credential-vault";
import type { VaultKeyVersion } from "../src/credential-vault/keyring";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_vault_alerts";
const NOW = 10_000_000;

describe("Vault alert signals", vaultAlertSuite);

function vaultAlertSuite(): void {
  it("records metadata-only denial receipts", recordsDenials);
  it(
    "sweeps unknown key versions, stuck rotations, and delayed restrictions",
    sweepsSignals,
  );
}

async function recordsDenials(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  seedOrganisation(sqlite);

  await recordCredentialAccessDenial({
    db,
    organisationId: ORGANISATION,
    purpose: "provider_action",
    reasonCode: "credential_generation_inactive",
    now: NOW,
  });
  const row = sqlite
    .prepare(
      `SELECT organisation_id AS organisationId, purpose, reason_code AS reasonCode,
            vault_handle AS vaultHandle
     FROM credential_access_denial`,
    )
    .get() as {
    organisationId: string;
    purpose: string;
    reasonCode: string;
    vaultHandle: string | null;
  };
  expect(row).toEqual({
    organisationId: ORGANISATION,
    purpose: "provider_action",
    reasonCode: "credential_generation_inactive",
    vaultHandle: null,
  });
}

async function sweepsSignals(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  seedOrganisation(sqlite);
  seedUser(sqlite);
  seedConnection(sqlite);

  sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES
       (?, 'vault:alerts:known', 'v1', 'AES-GCM-256', 'n', 'c', 1, NULL, NULL),
       (?, 'vault:alerts:unknown', 'v2', 'AES-GCM-256', 'n', 'c', 1, NULL, NULL)`,
    )
    .run(ORGANISATION, ORGANISATION);
  sqlite
    .prepare(
      `INSERT INTO credential_rotation (
       credential_rotation_id, organisation_id, provider_connection_id,
       expected_generation, replacement_credential_ref, status, failure_code,
       created_by_user_id, created_at, verified_at, committed_at
     ) VALUES
       ('rotation_alerts_stuck', ?, 'connection_vault_alerts', 1,
        'vault:alerts:replacement', 'pending_verification', NULL,
        'control_vault_alerts', 1, NULL, NULL),
       ('rotation_alerts_failed', ?, 'connection_vault_alerts', 1,
        'vault:alerts:failed', 'failed', 'replacement_validation_failed',
        'control_vault_alerts', 1, NULL, NULL)`,
    )
    .run(ORGANISATION, ORGANISATION);
  sqlite
    .prepare(
      `INSERT INTO credential_revocation_operation (
       revocation_id, organisation_id, vault_handle, state,
       credential_generation_count, provider_connection_count,
       integration_account_count, provider_webhook_count,
       credential_ref_count, vault_secret_count,
       policy_version, restriction_version, target_consumer_count,
       acknowledged_consumer_count, pending_consumer_count,
       retry_count, restriction_latency_ms,
       started_at, committed_at, policy_activated_at
     ) VALUES
       ('revocation_alerts_delayed', ?, 'vault:alerts:delayed', 'committed',
        1, 1, 1, 0, 1, 1,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1, NULL),
       ('revocation_alerts_breach', ?, 'vault:alerts:breach', 'policy_activated',
        1, 1, 1, 0, 1, 1,
        7, 7, 1, 1, 0, 0, 9_000, 1, 1, 9_001)`,
    )
    .run(ORGANISATION, ORGANISATION);
  await recordCredentialAccessDenial({
    db,
    organisationId: ORGANISATION,
    purpose: "webhook",
    reasonCode: "webhook_binding_inactive",
    now: NOW - 1_000,
  });

  const readable = new Set<VaultKeyVersion>([
    "v1",
  ] as unknown as VaultKeyVersion[]);
  const sweep = await sweepVaultAlertSignals({
    db,
    readableKeyVersions: readable,
    now: NOW,
  });

  expect(sweep).toMatchObject({
    sweptAt: NOW,
    unknownKeyVersionRows: 1,
    stuckRotations: 1,
    failedRotations: 1,
    delayedRestrictions: 1,
    latencyBreaches: 1,
    denialsByPurpose: { webhook: 1 },
  });
}

function seedOrganisation(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Vault Alerts', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION);
}

function seedUser(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES (
      'control_vault_alerts', 'urn:satyr:test', 'vault-alerts',
      'vault-alerts@example.invalid', 'Vault Alerts', 1, 1, 1
    );
  `);
}

function seedConnection(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation,
       credential_ref, lifecycle, granted_scopes, created_by_user_id,
       created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id
     ) VALUES (
       'connection_vault_alerts', ?, 'stripe', 'api_key', 'connection_credential', 1,
       'vault:alerts:known', 'active', '[]', 'control_vault_alerts',
       1, 1, NULL, NULL, 'development', 'acct_vault_alerts'
     )`,
    )
    .run(ORGANISATION);
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(singleDatabaseSchema());
  return database;
}
