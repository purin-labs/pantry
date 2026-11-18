/**
 * Plan 12 V6 — Credential Vault backup and restore.
 *
 * The backup envelope carries the already-encrypted vault rows plus the
 * rotation-job and credential-reference metadata needed to rebuild a clean
 * account. Root key material never enters the envelope: export reads only the
 * database and never receives `CredentialVaultBindings`, so no code path can
 * copy a root into an archive. Restore fails closed before writing anything
 * when a row names a key version the restore-side keyring cannot read, and
 * only ever targets a database holding no vault rows for the affected
 * organisations. Rotation jobs are root-level metadata without an organisation column, so
 * every scope includes them.
 *
 * The rotation jobs are in the global directory and the other rows in an
 * Organisation's regional database, so export and restore take both.
 */

import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import type { VaultHandle, VaultResolveError } from "./domain";
import type { CredentialVaultBindings, VaultKeyVersion } from "./keyring";
import { resolveVaultHandle } from "./service";
import { isRecord, isString, sha256Hex } from "@seams/std";

export const VAULT_BACKUP_SCHEMA_VERSION = "satyr.vault-backup.v1";

export type VaultBackupVaultSecretRow = {
  readonly organisationId: string;
  readonly vaultHandle: string;
  readonly keyVersion: string;
  readonly algorithm: string;
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
};

export type VaultBackupRotationJobRow = {
  readonly rotationId: string;
  readonly sourceKeyVersion: string;
  readonly targetKeyVersion: string;
  readonly lifecycle: string;
  readonly cursorOrganisationId: string | null;
  readonly cursorVaultHandle: string | null;
  readonly sourceRowCount: number;
  readonly processedCount: number;
  readonly rewrappedCount: number;
  readonly skippedCount: number;
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly updatedAt: number;
  readonly pausedAt: number | null;
  readonly completedAt: number | null;
  readonly failedAt: number | null;
};

export type VaultBackupCredentialRefRow = {
  readonly organisationId: string;
  readonly provider: string;
  readonly name: string;
  readonly vaultHandle: string;
  readonly hostPattern: string;
  readonly injectAs: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
};

export type VaultBackupRevocationOperationRow = {
  readonly revocationId: string;
  readonly organisationId: string;
  readonly vaultHandle: string;
  readonly state: string;
  readonly credentialGenerationCount: number;
  readonly providerConnectionCount: number;
  readonly integrationAccountCount: number;
  readonly providerWebhookCount: number;
  readonly credentialRefCount: number;
  readonly vaultSecretCount: number;
  readonly policyVersion: number | null;
  readonly restrictionVersion: number | null;
  readonly targetConsumerCount: number | null;
  readonly acknowledgedConsumerCount: number | null;
  readonly pendingConsumerCount: number | null;
  readonly retryCount: number | null;
  readonly restrictionLatencyMs: number | null;
  readonly startedAt: number;
  readonly committedAt: number;
  readonly policyActivatedAt: number | null;
};

export type VaultBackupTables = {
  readonly vaultSecrets: readonly VaultBackupVaultSecretRow[];
  readonly rootRotationJobs: readonly VaultBackupRotationJobRow[];
  readonly credentialRefs: readonly VaultBackupCredentialRefRow[];
  readonly credentialRevocationOperations: readonly VaultBackupRevocationOperationRow[];
};

export type VaultBackupScope = "all" | { readonly organisationId: string };

export type VaultBackupEnvelope = {
  readonly schemaVersion: "satyr.vault-backup.v1";
  readonly exportedAt: number;
  readonly scope: VaultBackupScope;
  readonly tables: VaultBackupTables;
  readonly digest: string;
};

export type VaultBackupTableName =
  | "vault_secret"
  | "vault_root_rotation_job"
  | "credential_ref"
  | "credential_revocation_operation";

export type VaultBackupError = {
  readonly code: "vault_backup_row_invalid";
  readonly table: VaultBackupTableName;
};

export type VaultRestoreError =
  | { readonly code: "vault_backup_schema_version_unsupported" }
  | { readonly code: "vault_backup_envelope_invalid" }
  | { readonly code: "vault_backup_digest_mismatch" }
  | {
      readonly code: "vault_restore_key_version_unavailable";
      readonly keyVersion: string;
    }
  | {
      readonly code: "vault_restore_target_not_empty";
      readonly organisationId: string;
    }
  | { readonly code: "vault_restore_write_failed" };

export type VaultRestoreReceipt = {
  readonly restoredVaultSecretCount: number;
  readonly restoredRotationJobCount: number;
  readonly restoredCredentialRefCount: number;
  readonly restoredRevocationOperationCount: number;
  readonly digest: string;
  readonly restoredAt: number;
};

export async function exportVaultBackup(input: {
  readonly db: OrganisationDatabase;
  // The global directory, which holds the vault root rotation jobs.
  readonly directory: GlobalDatabase;
  readonly organisationId?: OrganisationId;
}): Promise<Result<VaultBackupEnvelope, VaultBackupError>> {
  const vaultSecrets = await readVaultSecretBackupRows(
    input.db,
    input.organisationId,
  );

  if (!vaultSecrets.ok) {
    return vaultSecrets;
  }

  const rootRotationJobs = await readRotationJobBackupRows(input.directory);

  if (!rootRotationJobs.ok) {
    return rootRotationJobs;
  }

  const credentialRefs = await readCredentialRefBackupRows(
    input.db,
    input.organisationId,
  );

  if (!credentialRefs.ok) {
    return credentialRefs;
  }

  const credentialRevocationOperations =
    await readRevocationOperationBackupRows(input.db, input.organisationId);

  if (!credentialRevocationOperations.ok) {
    return credentialRevocationOperations;
  }

  const tables: VaultBackupTables = {
    vaultSecrets: vaultSecrets.value,
    rootRotationJobs: rootRotationJobs.value,
    credentialRefs: credentialRefs.value,
    credentialRevocationOperations: credentialRevocationOperations.value,
  };

  return {
    ok: true,
    value: {
      schemaVersion: VAULT_BACKUP_SCHEMA_VERSION,
      exportedAt: Date.now(),
      scope:
        input.organisationId === undefined
          ? "all"
          : { organisationId: input.organisationId },
      tables,
      digest: await hashCanonicalJson(tables),
    },
  };
}

export async function importVaultBackup(input: {
  readonly db: OrganisationDatabase;
  // The global directory, which holds the vault root rotation jobs.
  readonly directory: GlobalDatabase;
  readonly envelope: VaultBackupEnvelope;
  readonly readableKeyVersions: ReadonlySet<VaultKeyVersion>;
}): Promise<Result<VaultRestoreReceipt, VaultRestoreError>> {
  if (input.envelope.schemaVersion !== VAULT_BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      error: { code: "vault_backup_schema_version_unsupported" },
    };
  }

  let digest: string;

  try {
    digest = await hashCanonicalJson(input.envelope.tables);
  } catch {
    return { ok: false, error: { code: "vault_backup_envelope_invalid" } };
  }

  if (digest !== input.envelope.digest) {
    return { ok: false, error: { code: "vault_backup_digest_mismatch" } };
  }

  const tables = input.envelope.tables;

  for (const row of tables.vaultSecrets) {
    if (!isReadableKeyVersion(input.readableKeyVersions, row.keyVersion)) {
      return {
        ok: false,
        error: {
          code: "vault_restore_key_version_unavailable",
          keyVersion: row.keyVersion,
        },
      };
    }
  }

  for (const organisationId of collectEnvelopeOrganisationIds(tables)) {
    if (await organisationHasVaultSecretRows(input.db, organisationId)) {
      return {
        ok: false,
        error: { code: "vault_restore_target_not_empty", organisationId },
      };
    }
  }

  const rotationJobs: D1PreparedStatement[] = [];

  for (const row of tables.rootRotationJobs) {
    rotationJobs.push(insertRotationJobStatement(input.directory, row));
  }

  const statements: D1PreparedStatement[] = [];

  for (const row of tables.vaultSecrets) {
    statements.push(insertVaultSecretStatement(input.db, row));
  }

  for (const row of tables.credentialRefs) {
    statements.push(insertCredentialRefStatement(input.db, row));
  }

  for (const row of tables.credentialRevocationOperations) {
    statements.push(insertRevocationOperationStatement(input.db, row));
  }

  // Two databases, so two batches. The rotation jobs go first, and a job the
  // directory already holds is left as it is: the restore of a second regional
  // database carries the same jobs, and so does a repeat after the regional
  // batch failed.
  let restoredRotationJobCount = 0;

  try {
    if (rotationJobs.length > 0) {
      for (const result of await input.directory.batch(rotationJobs)) {
        restoredRotationJobCount += result.meta.changes;
      }
    }

    if (statements.length > 0) {
      await input.db.batch(statements);
    }
  } catch {
    return { ok: false, error: { code: "vault_restore_write_failed" } };
  }

  return {
    ok: true,
    value: {
      restoredVaultSecretCount: tables.vaultSecrets.length,
      restoredRotationJobCount,
      restoredCredentialRefCount: tables.credentialRefs.length,
      restoredRevocationOperationCount:
        tables.credentialRevocationOperations.length,
      digest,
      restoredAt: Date.now(),
    },
  };
}

/**
 * The V6 "verified resolve": prove one restored row decrypts under the
 * restore-side bindings. `verifyStoredVaultSecret` additionally compares the
 * plaintext against a caller-supplied expected secret, which a restore
 * verifier must not carry; this wrapper walks the same keyring, decrypt, and
 * payload-parse path via `resolveVaultHandle` and discards the plaintext.
 */
export async function verifyRestoredVaultBackup(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
}): Promise<Result<true, VaultResolveError>> {
  const resolved = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.handle,
  });

  if (!resolved.ok) {
    return resolved;
  }

  return { ok: true, value: true };
}

type RawVaultSecretBackupRow = {
  readonly organisationId: unknown;
  readonly vaultHandle: unknown;
  readonly keyVersion: unknown;
  readonly algorithm: unknown;
  readonly nonceB64: unknown;
  readonly ciphertextB64: unknown;
  readonly createdAt: unknown;
  readonly rotatedAt: unknown;
  readonly revokedAt: unknown;
};

type RawRotationJobBackupRow = {
  readonly rotationId: unknown;
  readonly sourceKeyVersion: unknown;
  readonly targetKeyVersion: unknown;
  readonly lifecycle: unknown;
  readonly cursorOrganisationId: unknown;
  readonly cursorVaultHandle: unknown;
  readonly sourceRowCount: unknown;
  readonly processedCount: unknown;
  readonly rewrappedCount: unknown;
  readonly skippedCount: unknown;
  readonly failureCode: unknown;
  readonly createdAt: unknown;
  readonly startedAt: unknown;
  readonly updatedAt: unknown;
  readonly pausedAt: unknown;
  readonly completedAt: unknown;
  readonly failedAt: unknown;
};

type RawCredentialRefBackupRow = {
  readonly organisationId: unknown;
  readonly provider: unknown;
  readonly name: unknown;
  readonly vaultHandle: unknown;
  readonly hostPattern: unknown;
  readonly injectAs: unknown;
  readonly createdAt: unknown;
  readonly revokedAt: unknown;
};

type RawRevocationOperationBackupRow = {
  readonly revocationId: unknown;
  readonly organisationId: unknown;
  readonly vaultHandle: unknown;
  readonly state: unknown;
  readonly credentialGenerationCount: unknown;
  readonly providerConnectionCount: unknown;
  readonly integrationAccountCount: unknown;
  readonly providerWebhookCount: unknown;
  readonly credentialRefCount: unknown;
  readonly vaultSecretCount: unknown;
  readonly policyVersion: unknown;
  readonly restrictionVersion: unknown;
  readonly targetConsumerCount: unknown;
  readonly acknowledgedConsumerCount: unknown;
  readonly pendingConsumerCount: unknown;
  readonly retryCount: unknown;
  readonly restrictionLatencyMs: unknown;
  readonly startedAt: unknown;
  readonly committedAt: unknown;
  readonly policyActivatedAt: unknown;
};

async function readVaultSecretBackupRows(
  db: OrganisationDatabase,
  organisationId: OrganisationId | undefined,
): Promise<Result<readonly VaultBackupVaultSecretRow[], VaultBackupError>> {
  const columns = `organisation_id AS organisationId, vault_handle AS vaultHandle,
    key_version AS keyVersion, algorithm AS algorithm, nonce_b64 AS nonceB64,
    ciphertext_b64 AS ciphertextB64, created_at AS createdAt,
    rotated_at AS rotatedAt, revoked_at AS revokedAt`;
  const statement =
    organisationId === undefined
      ? db.prepare(
          `SELECT ${columns} FROM vault_secret ORDER BY organisation_id, vault_handle`,
        )
      : db
          .prepare(
            `SELECT ${columns} FROM vault_secret
           WHERE organisation_id = ?
           ORDER BY organisation_id, vault_handle`,
          )
          .bind(organisationId);

  const rows = await statement.all<RawVaultSecretBackupRow>();
  const parsed: VaultBackupVaultSecretRow[] = [];

  for (const raw of rows.results) {
    const row = parseVaultSecretBackupRow(raw);

    if (!row.ok) {
      return row;
    }

    parsed.push(row.value);
  }

  return { ok: true, value: parsed };
}

async function readRotationJobBackupRows(
  directory: GlobalDatabase,
): Promise<Result<readonly VaultBackupRotationJobRow[], VaultBackupError>> {
  const rows = await directory
    .prepare(
      `SELECT rotation_id AS rotationId, source_key_version AS sourceKeyVersion,
         target_key_version AS targetKeyVersion, lifecycle AS lifecycle,
         cursor_organisation_id AS cursorOrganisationId, cursor_vault_handle AS cursorVaultHandle,
         source_row_count AS sourceRowCount, processed_count AS processedCount,
         rewrapped_count AS rewrappedCount, skipped_count AS skippedCount,
         failure_code AS failureCode, created_at AS createdAt,
         started_at AS startedAt, updated_at AS updatedAt, paused_at AS pausedAt,
         completed_at AS completedAt, failed_at AS failedAt
       FROM vault_root_rotation_job
       ORDER BY rotation_id`,
    )
    .all<RawRotationJobBackupRow>();
  const parsed: VaultBackupRotationJobRow[] = [];

  for (const raw of rows.results) {
    const row = parseRotationJobBackupRow(raw);

    if (!row.ok) {
      return row;
    }

    parsed.push(row.value);
  }

  return { ok: true, value: parsed };
}

async function readCredentialRefBackupRows(
  db: OrganisationDatabase,
  organisationId: OrganisationId | undefined,
): Promise<Result<readonly VaultBackupCredentialRefRow[], VaultBackupError>> {
  const columns = `organisation_id AS organisationId, provider AS provider, name AS name,
    vault_handle AS vaultHandle, host_pattern AS hostPattern,
    inject_as AS injectAs, created_at AS createdAt, revoked_at AS revokedAt`;
  const statement =
    organisationId === undefined
      ? db.prepare(
          `SELECT ${columns} FROM credential_ref ORDER BY organisation_id, provider, name`,
        )
      : db
          .prepare(
            `SELECT ${columns} FROM credential_ref
           WHERE organisation_id = ?
           ORDER BY organisation_id, provider, name`,
          )
          .bind(organisationId);

  const rows = await statement.all<RawCredentialRefBackupRow>();
  const parsed: VaultBackupCredentialRefRow[] = [];

  for (const raw of rows.results) {
    const row = parseCredentialRefBackupRow(raw);

    if (!row.ok) {
      return row;
    }

    parsed.push(row.value);
  }

  return { ok: true, value: parsed };
}

async function readRevocationOperationBackupRows(
  db: OrganisationDatabase,
  organisationId: OrganisationId | undefined,
): Promise<
  Result<readonly VaultBackupRevocationOperationRow[], VaultBackupError>
> {
  const columns = `revocation_id AS revocationId, organisation_id AS organisationId,
    vault_handle AS vaultHandle, state AS state,
    credential_generation_count AS credentialGenerationCount,
    provider_connection_count AS providerConnectionCount,
    integration_account_count AS integrationAccountCount,
    provider_webhook_count AS providerWebhookCount,
    credential_ref_count AS credentialRefCount,
    vault_secret_count AS vaultSecretCount,
    policy_version AS policyVersion, restriction_version AS restrictionVersion,
    target_consumer_count AS targetConsumerCount,
    acknowledged_consumer_count AS acknowledgedConsumerCount,
    pending_consumer_count AS pendingConsumerCount, retry_count AS retryCount,
    restriction_latency_ms AS restrictionLatencyMs, started_at AS startedAt,
    committed_at AS committedAt, policy_activated_at AS policyActivatedAt`;
  const statement =
    organisationId === undefined
      ? db.prepare(
          `SELECT ${columns} FROM credential_revocation_operation
         ORDER BY organisation_id, vault_handle`,
        )
      : db
          .prepare(
            `SELECT ${columns} FROM credential_revocation_operation
           WHERE organisation_id = ?
           ORDER BY organisation_id, vault_handle`,
          )
          .bind(organisationId);

  const rows = await statement.all<RawRevocationOperationBackupRow>();
  const parsed: VaultBackupRevocationOperationRow[] = [];

  for (const raw of rows.results) {
    const row = parseRevocationOperationBackupRow(raw);

    if (!row.ok) {
      return row;
    }

    parsed.push(row.value);
  }

  return { ok: true, value: parsed };
}

function parseVaultSecretBackupRow(
  raw: RawVaultSecretBackupRow,
): Result<VaultBackupVaultSecretRow, VaultBackupError> {
  if (
    !isString(raw.organisationId) ||
    !isString(raw.vaultHandle) ||
    !isString(raw.keyVersion) ||
    !isString(raw.algorithm) ||
    !isString(raw.nonceB64) ||
    !isString(raw.ciphertextB64) ||
    !isIntegerValue(raw.createdAt) ||
    !isNullableInteger(raw.rotatedAt) ||
    !isNullableInteger(raw.revokedAt)
  ) {
    return backupRowInvalid("vault_secret");
  }

  return {
    ok: true,
    value: {
      organisationId: raw.organisationId,
      vaultHandle: raw.vaultHandle,
      keyVersion: raw.keyVersion,
      algorithm: raw.algorithm,
      nonceB64: raw.nonceB64,
      ciphertextB64: raw.ciphertextB64,
      createdAt: raw.createdAt,
      rotatedAt: raw.rotatedAt,
      revokedAt: raw.revokedAt,
    },
  };
}

function parseRotationJobBackupRow(
  raw: RawRotationJobBackupRow,
): Result<VaultBackupRotationJobRow, VaultBackupError> {
  if (
    !isString(raw.rotationId) ||
    !isString(raw.sourceKeyVersion) ||
    !isString(raw.targetKeyVersion) ||
    !isString(raw.lifecycle) ||
    !isNullableText(raw.cursorOrganisationId) ||
    !isNullableText(raw.cursorVaultHandle) ||
    !isIntegerValue(raw.sourceRowCount) ||
    !isIntegerValue(raw.processedCount) ||
    !isIntegerValue(raw.rewrappedCount) ||
    !isIntegerValue(raw.skippedCount) ||
    !isNullableText(raw.failureCode) ||
    !isIntegerValue(raw.createdAt) ||
    !isNullableInteger(raw.startedAt) ||
    !isIntegerValue(raw.updatedAt) ||
    !isNullableInteger(raw.pausedAt) ||
    !isNullableInteger(raw.completedAt) ||
    !isNullableInteger(raw.failedAt)
  ) {
    return backupRowInvalid("vault_root_rotation_job");
  }

  return {
    ok: true,
    value: {
      rotationId: raw.rotationId,
      sourceKeyVersion: raw.sourceKeyVersion,
      targetKeyVersion: raw.targetKeyVersion,
      lifecycle: raw.lifecycle,
      cursorOrganisationId: raw.cursorOrganisationId,
      cursorVaultHandle: raw.cursorVaultHandle,
      sourceRowCount: raw.sourceRowCount,
      processedCount: raw.processedCount,
      rewrappedCount: raw.rewrappedCount,
      skippedCount: raw.skippedCount,
      failureCode: raw.failureCode,
      createdAt: raw.createdAt,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
      pausedAt: raw.pausedAt,
      completedAt: raw.completedAt,
      failedAt: raw.failedAt,
    },
  };
}

function parseCredentialRefBackupRow(
  raw: RawCredentialRefBackupRow,
): Result<VaultBackupCredentialRefRow, VaultBackupError> {
  if (
    !isString(raw.organisationId) ||
    !isString(raw.provider) ||
    !isString(raw.name) ||
    !isString(raw.vaultHandle) ||
    !isString(raw.hostPattern) ||
    !isString(raw.injectAs) ||
    !isIntegerValue(raw.createdAt) ||
    !isNullableInteger(raw.revokedAt)
  ) {
    return backupRowInvalid("credential_ref");
  }

  return {
    ok: true,
    value: {
      organisationId: raw.organisationId,
      provider: raw.provider,
      name: raw.name,
      vaultHandle: raw.vaultHandle,
      hostPattern: raw.hostPattern,
      injectAs: raw.injectAs,
      createdAt: raw.createdAt,
      revokedAt: raw.revokedAt,
    },
  };
}

function parseRevocationOperationBackupRow(
  raw: RawRevocationOperationBackupRow,
): Result<VaultBackupRevocationOperationRow, VaultBackupError> {
  if (
    !isString(raw.revocationId) ||
    !isString(raw.organisationId) ||
    !isString(raw.vaultHandle) ||
    !isString(raw.state) ||
    !isIntegerValue(raw.credentialGenerationCount) ||
    !isIntegerValue(raw.providerConnectionCount) ||
    !isIntegerValue(raw.integrationAccountCount) ||
    !isIntegerValue(raw.providerWebhookCount) ||
    !isIntegerValue(raw.credentialRefCount) ||
    !isIntegerValue(raw.vaultSecretCount) ||
    !isNullableInteger(raw.policyVersion) ||
    !isNullableInteger(raw.restrictionVersion) ||
    !isNullableInteger(raw.targetConsumerCount) ||
    !isNullableInteger(raw.acknowledgedConsumerCount) ||
    !isNullableInteger(raw.pendingConsumerCount) ||
    !isNullableInteger(raw.retryCount) ||
    !isNullableInteger(raw.restrictionLatencyMs) ||
    !isIntegerValue(raw.startedAt) ||
    !isIntegerValue(raw.committedAt) ||
    !isNullableInteger(raw.policyActivatedAt)
  ) {
    return backupRowInvalid("credential_revocation_operation");
  }

  return {
    ok: true,
    value: {
      revocationId: raw.revocationId,
      organisationId: raw.organisationId,
      vaultHandle: raw.vaultHandle,
      state: raw.state,
      credentialGenerationCount: raw.credentialGenerationCount,
      providerConnectionCount: raw.providerConnectionCount,
      integrationAccountCount: raw.integrationAccountCount,
      providerWebhookCount: raw.providerWebhookCount,
      credentialRefCount: raw.credentialRefCount,
      vaultSecretCount: raw.vaultSecretCount,
      policyVersion: raw.policyVersion,
      restrictionVersion: raw.restrictionVersion,
      targetConsumerCount: raw.targetConsumerCount,
      acknowledgedConsumerCount: raw.acknowledgedConsumerCount,
      pendingConsumerCount: raw.pendingConsumerCount,
      retryCount: raw.retryCount,
      restrictionLatencyMs: raw.restrictionLatencyMs,
      startedAt: raw.startedAt,
      committedAt: raw.committedAt,
      policyActivatedAt: raw.policyActivatedAt,
    },
  };
}

function insertVaultSecretStatement(
  db: OrganisationDatabase,
  row: VaultBackupVaultSecretRow,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO vault_secret (
         organisation_id, vault_handle, key_version, algorithm, nonce_b64,
         ciphertext_b64, created_at, rotated_at, revoked_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.organisationId,
      row.vaultHandle,
      row.keyVersion,
      row.algorithm,
      row.nonceB64,
      row.ciphertextB64,
      row.createdAt,
      row.rotatedAt,
      row.revokedAt,
    );
}

function insertRotationJobStatement(
  directory: GlobalDatabase,
  row: VaultBackupRotationJobRow,
): D1PreparedStatement {
  return directory
    .prepare(
      `INSERT INTO vault_root_rotation_job (
         rotation_id, source_key_version, target_key_version, lifecycle,
         cursor_organisation_id, cursor_vault_handle, source_row_count,
         processed_count, rewrapped_count, skipped_count, failure_code,
         created_at, started_at, updated_at, paused_at, completed_at, failed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (rotation_id) DO NOTHING`,
    )
    .bind(
      row.rotationId,
      row.sourceKeyVersion,
      row.targetKeyVersion,
      row.lifecycle,
      row.cursorOrganisationId,
      row.cursorVaultHandle,
      row.sourceRowCount,
      row.processedCount,
      row.rewrappedCount,
      row.skippedCount,
      row.failureCode,
      row.createdAt,
      row.startedAt,
      row.updatedAt,
      row.pausedAt,
      row.completedAt,
      row.failedAt,
    );
}

function insertCredentialRefStatement(
  db: OrganisationDatabase,
  row: VaultBackupCredentialRefRow,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO credential_ref (
         organisation_id, provider, name, vault_handle, host_pattern, inject_as,
         created_at, revoked_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.organisationId,
      row.provider,
      row.name,
      row.vaultHandle,
      row.hostPattern,
      row.injectAs,
      row.createdAt,
      row.revokedAt,
    );
}

function insertRevocationOperationStatement(
  db: OrganisationDatabase,
  row: VaultBackupRevocationOperationRow,
): D1PreparedStatement {
  return db
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
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.revocationId,
      row.organisationId,
      row.vaultHandle,
      row.state,
      row.credentialGenerationCount,
      row.providerConnectionCount,
      row.integrationAccountCount,
      row.providerWebhookCount,
      row.credentialRefCount,
      row.vaultSecretCount,
      row.policyVersion,
      row.restrictionVersion,
      row.targetConsumerCount,
      row.acknowledgedConsumerCount,
      row.pendingConsumerCount,
      row.retryCount,
      row.restrictionLatencyMs,
      row.startedAt,
      row.committedAt,
      row.policyActivatedAt,
    );
}

async function organisationHasVaultSecretRows(
  db: OrganisationDatabase,
  organisationId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM vault_secret WHERE organisation_id = ? LIMIT 1`,
    )
    .bind(organisationId)
    .first<{ readonly present: unknown }>();

  return row !== null;
}

function collectEnvelopeOrganisationIds(
  tables: VaultBackupTables,
): readonly string[] {
  const organisations = new Set<string>();

  for (const row of tables.vaultSecrets) {
    organisations.add(row.organisationId);
  }

  for (const row of tables.credentialRefs) {
    organisations.add(row.organisationId);
  }

  for (const row of tables.credentialRevocationOperations) {
    organisations.add(row.organisationId);
  }

  return [...organisations].sort();
}

function isReadableKeyVersion(
  readable: ReadonlySet<VaultKeyVersion>,
  raw: string,
): boolean {
  return (raw === "v1" || raw === "v2") && readable.has(raw);
}

function backupRowInvalid(
  table: VaultBackupTableName,
): Result<never, VaultBackupError> {
  return { ok: false, error: { code: "vault_backup_row_invalid", table } };
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isIntegerValue(value);
}

async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("vault backup envelope contains a non-finite number");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(",")}]`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const fields: string[] = [];

    for (const key of keys) {
      fields.push(
        `${JSON.stringify(key)}:${canonicalizeJsonValue(value[key])}`,
      );
    }

    return `{${fields.join(",")}}`;
  }

  throw new Error("vault backup envelope is not JSON");
}
