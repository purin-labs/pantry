/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  exportVaultBackup,
  importVaultBackup,
  storeVaultSecret,
  verifyRestoredVaultBackup,
  type VaultBackupEnvelope,
  type VaultHandle,
  type VaultSecret,
} from "../src/credential-vault";
import type {
  CredentialVaultBindings,
  VaultKeyVersion,
} from "../src/credential-vault/keyring";
import { type OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import { schemaDatabase } from "./split-topology";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { TestSecretsStoreSecret } from "./secrets-store";

/**
 * Plan 12 V6 — backup and restore of the Credential Vault.
 *
 * The envelope carries encrypted vault rows and rotation-job metadata only.
 * Root keys stay outside every archive, restore fails closed when a row names
 * an unreadable key version, and a clean-account restore ends with a verified
 * resolve under the restore-side bindings.
 */
describe("Credential Vault backup and restore", vaultBackupSuite);

const NOW = 1_790_000_000_000;
const V1_FILL = 11;
const V2_FILL = 22;
const ORGANISATION_ALPHA = "organisation_backup_alpha";
const ORGANISATION_BETA = "organisation_backup_beta";
const ALPHA_SECRET: VaultSecret = {
  kind: "bearer",
  value: "alpha-secret-value",
};
const BETA_SECRET: VaultSecret = {
  kind: "header",
  header: "x-provider-key",
  value: "beta-secret-value",
};

function vaultBackupSuite(): void {
  it(
    "round trips two organisations into a clean database with a verified resolve",
    roundTripsCleanRestore,
  );
  it(
    "includes rotation-job metadata and restores it intact",
    restoresRotationJobMetadata,
  );
  it(
    "fails closed before writing when a key version is unreadable",
    failsClosedOnUnreadableKeyVersion,
  );
  it(
    "rejects an envelope whose ciphertext was tampered with",
    rejectsTamperedDigest,
  );
  it(
    "rejects a restore into a target that already holds vault rows",
    rejectsNonEmptyTarget,
  );
  it("never carries root key material in the envelope", omitsRootKeyMaterial);
  it(
    "restores vault rows to a regional database and rotation jobs to the global one",
    restoresOnSplitTopology,
  );
}

async function roundTripsCleanRestore(): Promise<void> {
  const source = await seededSource();
  const envelope = await requireExportedEnvelope(source.db);

  expect(envelope.scope).toBe("all");

  const target = migratedDatabase();
  insertOrganisation(target.sqlite, source.alphaOrganisation);
  insertOrganisation(target.sqlite, source.betaOrganisation);

  const imported = await importVaultBackup({
    db: target.db,
    directory: target.db,
    envelope,
    readableKeyVersions: new Set<VaultKeyVersion>(["v1"]),
  });

  expect(imported).toEqual({
    ok: true,
    value: {
      restoredVaultSecretCount: 2,
      restoredRotationJobCount: 0,
      restoredCredentialRefCount: 1,
      restoredRevocationOperationCount: 0,
      digest: envelope.digest,
      restoredAt: expect.any(Number),
    },
  });

  await expect(
    verifyRestoredVaultBackup({
      db: target.db,
      keys: v1OnlyBindings(),
      organisationId: source.alphaOrganisation,
      handle: source.alphaHandle,
    }),
  ).resolves.toEqual({ ok: true, value: true });
  await expect(
    verifyRestoredVaultBackup({
      db: target.db,
      keys: v1OnlyBindings(),
      organisationId: source.betaOrganisation,
      handle: source.betaHandle,
    }),
  ).resolves.toEqual({ ok: true, value: true });
}

async function restoresRotationJobMetadata(): Promise<void> {
  const source = migratedDatabase();
  seedCompletedRotationJob(source.sqlite);

  const envelope = await requireExportedEnvelope(source.db);

  expect(envelope.tables.rootRotationJobs).toHaveLength(1);

  const target = migratedDatabase();
  const imported = await importVaultBackup({
    db: target.db,
    directory: target.db,
    envelope,
    readableKeyVersions: new Set<VaultKeyVersion>(["v1"]),
  });

  expect(imported).toMatchObject({
    ok: true,
    value: { restoredRotationJobCount: 1, restoredVaultSecretCount: 0 },
  });
  expect(readRotationJobRow(target.sqlite)).toEqual({
    rotationId: "vault-root-rotation-backup-test",
    sourceKeyVersion: "v1",
    targetKeyVersion: "v2",
    lifecycle: "completed",
    cursorOrganisationId: null,
    cursorVaultHandle: null,
    sourceRowCount: 3,
    processedCount: 3,
    rewrappedCount: 2,
    skippedCount: 1,
    failureCode: null,
    createdAt: 100,
    startedAt: 110,
    updatedAt: 190,
    pausedAt: null,
    completedAt: 200,
    failedAt: null,
  });
}

async function failsClosedOnUnreadableKeyVersion(): Promise<void> {
  const source = migratedDatabase();
  const alphaOrganisation = requireOrganisationId(ORGANISATION_ALPHA);
  insertOrganisation(source.sqlite, alphaOrganisation);

  const v1Handle = requireVaultHandle("vault:test:backup:under-v1");
  const v2Handle = requireVaultHandle("vault:test:backup:under-v2");
  await requireStoredSecret(
    source.db,
    v1OnlyBindings(),
    alphaOrganisation,
    v1Handle,
    ALPHA_SECRET,
  );
  await requireStoredSecret(
    source.db,
    v2ActiveBindings(),
    alphaOrganisation,
    v2Handle,
    BETA_SECRET,
  );

  const envelope = await requireExportedEnvelope(source.db);
  const target = migratedDatabase();
  insertOrganisation(target.sqlite, alphaOrganisation);

  const imported = await importVaultBackup({
    db: target.db,
    directory: target.db,
    envelope,
    readableKeyVersions: new Set<VaultKeyVersion>(["v1"]),
  });

  expect(imported).toEqual({
    ok: false,
    error: { code: "vault_restore_key_version_unavailable", keyVersion: "v2" },
  });
  expect(countRows(target.sqlite, "vault_secret")).toBe(0);
  expect(countRows(target.sqlite, "credential_ref")).toBe(0);
  expect(countRows(target.sqlite, "vault_root_rotation_job")).toBe(0);
  expect(countRows(target.sqlite, "credential_revocation_operation")).toBe(0);
}

async function rejectsTamperedDigest(): Promise<void> {
  const source = await seededSource();
  const envelope = await requireExportedEnvelope(source.db);
  const tampered: VaultBackupEnvelope = {
    ...envelope,
    tables: {
      ...envelope.tables,
      vaultSecrets: envelope.tables.vaultSecrets.map(
        function tamper(row, index) {
          return index === 0
            ? { ...row, ciphertextB64: btoa("tampered-ciphertext") }
            : row;
        },
      ),
    },
  };

  const target = migratedDatabase();
  insertOrganisation(target.sqlite, source.alphaOrganisation);
  insertOrganisation(target.sqlite, source.betaOrganisation);

  const imported = await importVaultBackup({
    db: target.db,
    directory: target.db,
    envelope: tampered,
    readableKeyVersions: new Set<VaultKeyVersion>(["v1"]),
  });

  expect(imported).toEqual({
    ok: false,
    error: { code: "vault_backup_digest_mismatch" },
  });
  expect(countRows(target.sqlite, "vault_secret")).toBe(0);
}

async function rejectsNonEmptyTarget(): Promise<void> {
  const source = await seededSource();
  const envelope = await requireExportedEnvelope(source.db);

  // Importing back into the source database: the target already holds
  // vault_secret rows for both envelope organisations, so the restore must refuse.
  const imported = await importVaultBackup({
    db: source.db,
    directory: source.db,
    envelope,
    readableKeyVersions: new Set<VaultKeyVersion>(["v1"]),
  });

  expect(imported).toEqual({
    ok: false,
    error: {
      code: "vault_restore_target_not_empty",
      organisationId: ORGANISATION_ALPHA,
    },
  });
  expect(countRows(source.sqlite, "vault_secret")).toBe(2);
}

async function omitsRootKeyMaterial(): Promise<void> {
  const source = migratedDatabase();
  const alphaOrganisation = requireOrganisationId(ORGANISATION_ALPHA);
  insertOrganisation(source.sqlite, alphaOrganisation);

  const v1Handle = requireVaultHandle("vault:test:backup:material-v1");
  const v2Handle = requireVaultHandle("vault:test:backup:material-v2");
  await requireStoredSecret(
    source.db,
    v1OnlyBindings(),
    alphaOrganisation,
    v1Handle,
    ALPHA_SECRET,
  );
  await requireStoredSecret(
    source.db,
    v2ActiveBindings(),
    alphaOrganisation,
    v2Handle,
    BETA_SECRET,
  );

  const envelope = await requireExportedEnvelope(source.db);
  const serialized = JSON.stringify(envelope);

  expect(serialized).not.toContain(testRootB64(V1_FILL));
  expect(serialized).not.toContain(testRootB64(V2_FILL));
  expect(serialized).not.toContain("alpha-secret-value");
  expect(serialized).not.toContain("beta-secret-value");
}

// The deployed topology: the vault rows are in an Organisation's regional
// database and the rotation jobs in the global one.
async function restoresOnSplitTopology(): Promise<void> {
  const alphaOrganisation = requireOrganisationId(ORGANISATION_ALPHA);
  const betaOrganisation = requireOrganisationId(ORGANISATION_BETA);
  const alphaHandle = requireVaultHandle("vault:test:backup:split-alpha");
  const betaHandle = requireVaultHandle("vault:test:backup:split-beta");
  const sourceGlobal = schemaDatabase("migrations-global");
  seedCompletedRotationJob(sourceGlobal.sqlite);
  const alphaRegion = schemaDatabase("migrations-regional");
  insertOrganisation(alphaRegion.sqlite, alphaOrganisation);
  insertCredentialRef(alphaRegion.sqlite, alphaOrganisation, alphaHandle);
  await requireStoredSecret(
    alphaRegion.db,
    v1OnlyBindings(),
    alphaOrganisation,
    alphaHandle,
    ALPHA_SECRET,
  );
  const betaRegion = schemaDatabase("migrations-regional");
  insertOrganisation(betaRegion.sqlite, betaOrganisation);
  await requireStoredSecret(
    betaRegion.db,
    v1OnlyBindings(),
    betaOrganisation,
    betaHandle,
    BETA_SECRET,
  );
  const alphaEnvelope = await requireExportedEnvelope(
    alphaRegion.db,
    sourceGlobal.db,
  );
  const betaEnvelope = await requireExportedEnvelope(
    betaRegion.db,
    sourceGlobal.db,
  );

  const targetGlobal = schemaDatabase("migrations-global");
  const targetRegion = schemaDatabase("migrations-regional");
  insertOrganisation(targetRegion.sqlite, alphaOrganisation);
  insertOrganisation(targetRegion.sqlite, betaOrganisation);
  const readableKeyVersions = new Set<VaultKeyVersion>(["v1"]);

  await expect(
    importVaultBackup({
      db: targetRegion.db,
      directory: targetGlobal.db,
      envelope: alphaEnvelope,
      readableKeyVersions,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      restoredVaultSecretCount: 1,
      restoredRotationJobCount: 1,
      restoredCredentialRefCount: 1,
    },
  });
  // The second region's envelope carries the same rotation job.
  await expect(
    importVaultBackup({
      db: targetRegion.db,
      directory: targetGlobal.db,
      envelope: betaEnvelope,
      readableKeyVersions,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { restoredVaultSecretCount: 1, restoredRotationJobCount: 0 },
  });

  expect(countRows(targetGlobal.sqlite, "vault_root_rotation_job")).toBe(1);
  expect(readRotationJobRow(targetGlobal.sqlite)).toMatchObject({
    rotationId: "vault-root-rotation-backup-test",
    lifecycle: "completed",
  });
  for (const [organisationId, handle] of [
    [alphaOrganisation, alphaHandle],
    [betaOrganisation, betaHandle],
  ] as const) {
    await expect(
      verifyRestoredVaultBackup({
        db: targetRegion.db,
        keys: v1OnlyBindings(),
        organisationId,
        handle,
      }),
    ).resolves.toEqual({ ok: true, value: true });
  }
}

type BackupFixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
};

type SeededSource = BackupFixture & {
  readonly alphaOrganisation: OrganisationId;
  readonly betaOrganisation: OrganisationId;
  readonly alphaHandle: VaultHandle;
  readonly betaHandle: VaultHandle;
};

async function seededSource(): Promise<SeededSource> {
  const fixture = migratedDatabase();
  const alphaOrganisation = requireOrganisationId(ORGANISATION_ALPHA);
  const betaOrganisation = requireOrganisationId(ORGANISATION_BETA);
  const alphaHandle = requireVaultHandle("vault:test:backup:alpha");
  const betaHandle = requireVaultHandle("vault:test:backup:beta");

  insertOrganisation(fixture.sqlite, alphaOrganisation);
  insertOrganisation(fixture.sqlite, betaOrganisation);
  insertCredentialRef(fixture.sqlite, alphaOrganisation, alphaHandle);
  await requireStoredSecret(
    fixture.db,
    v1OnlyBindings(),
    alphaOrganisation,
    alphaHandle,
    ALPHA_SECRET,
  );
  await requireStoredSecret(
    fixture.db,
    v1OnlyBindings(),
    betaOrganisation,
    betaHandle,
    BETA_SECRET,
  );

  return {
    ...fixture,
    alphaOrganisation,
    betaOrganisation,
    alphaHandle,
    betaHandle,
  };
}

async function requireExportedEnvelope(
  db: SingleDatabase,
  directory: SingleDatabase = db,
): Promise<VaultBackupEnvelope> {
  const exported = await exportVaultBackup({ db, directory });

  if (!exported.ok) {
    throw new Error(exported.error.code);
  }

  return exported.value;
}

function migratedDatabase(): BackupFixture {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());

  return { sqlite, db: d1Database(sqlite) };
}

function insertOrganisation(
  sqlite: DatabaseSync,
  organisationId: OrganisationId,
): void {
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Vault Backup Test', 'beta', ?, 'active')`,
    )
    .run(organisationId, NOW);
}

function insertCredentialRef(
  sqlite: DatabaseSync,
  organisationId: OrganisationId,
  handle: VaultHandle,
): void {
  sqlite
    .prepare(
      `INSERT INTO credential_ref (
       organisation_id, provider, name, vault_handle, host_pattern, inject_as,
       created_at, revoked_at
     )
     VALUES (?, 'stripe', 'primary', ?, 'api.stripe.com', '{"header":"authorization"}', ?, NULL)`,
    )
    .run(organisationId, handle, NOW);
}

function seedCompletedRotationJob(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      `INSERT INTO vault_root_rotation_job (
       rotation_id, source_key_version, target_key_version, lifecycle,
       cursor_organisation_id, cursor_vault_handle, source_row_count,
       processed_count, rewrapped_count, skipped_count, failure_code,
       created_at, started_at, updated_at, paused_at, completed_at, failed_at
     )
     VALUES (
       'vault-root-rotation-backup-test', 'v1', 'v2', 'completed',
       NULL, NULL, 3, 3, 2, 1, NULL, 100, 110, 190, NULL, 200, NULL
     )`,
    )
    .run();
}

async function requireStoredSecret(
  db: SingleDatabase,
  keys: CredentialVaultBindings,
  organisationId: OrganisationId,
  handle: VaultHandle,
  secret: VaultSecret,
): Promise<void> {
  const stored = await storeVaultSecret({
    db,
    keys,
    organisationId,
    handle,
    secret,
    now: NOW,
  });

  if (!stored.ok) {
    throw new Error(stored.error.code);
  }
}

function countRows(
  sqlite: DatabaseSync,
  table:
    | "vault_secret"
    | "vault_root_rotation_job"
    | "credential_ref"
    | "credential_revocation_operation",
): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS rowCount FROM ${table}`)
    .get() as {
    rowCount: number;
  };

  return row.rowCount;
}

function readRotationJobRow(sqlite: DatabaseSync): Record<string, unknown> {
  return sqlite
    .prepare(
      `SELECT rotation_id AS rotationId, source_key_version AS sourceKeyVersion,
       target_key_version AS targetKeyVersion, lifecycle AS lifecycle,
       cursor_organisation_id AS cursorOrganisationId, cursor_vault_handle AS cursorVaultHandle,
       source_row_count AS sourceRowCount, processed_count AS processedCount,
       rewrapped_count AS rewrappedCount, skipped_count AS skippedCount,
       failure_code AS failureCode, created_at AS createdAt,
       started_at AS startedAt, updated_at AS updatedAt, paused_at AS pausedAt,
       completed_at AS completedAt, failed_at AS failedAt
     FROM vault_root_rotation_job`,
    )
    .get() as Record<string, unknown>;
}

function v1OnlyBindings(): CredentialVaultBindings {
  return {
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: testRoot(V1_FILL),
  };
}

function v2ActiveBindings(): CredentialVaultBindings {
  return {
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v2",
    VAULT_ROOT_V1: testRoot(V1_FILL),
    VAULT_ROOT_V2: testRoot(V2_FILL),
  };
}

function testRootB64(fill: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(fill);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function testRoot(fill: number): CredentialVaultBindings["VAULT_ROOT_V1"] {
  return new TestSecretsStoreSecret(
    testRootB64(fill),
  ) as CredentialVaultBindings["VAULT_ROOT_V1"];
}
