import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import { parseOrganisationId, type OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  decryptVaultPayload,
  encryptVaultPayload,
  vaultPayloadsEqual,
} from "./crypto";
import { parseVaultHandle, type VaultHandle } from "./domain";
import {
  activeVaultRoot,
  loadCredentialVaultKeyRing,
  vaultRootForVersion,
  type CredentialVaultBindings,
  type VaultKeyRingError,
  type VaultKeyVersion,
  type VaultRootBinding,
} from "./keyring";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isNonNegativeInteger } from "@purin-labs/std";

const vaultRootRotationIdBrand: unique symbol = Symbol("VaultRootRotationId");
const vaultRotationBatchLimitBrand: unique symbol = Symbol(
  "VaultRotationBatchLimit",
);

export type VaultRootRotationId = string & {
  readonly [vaultRootRotationIdBrand]: "VaultRootRotationId";
};

export type VaultRotationBatchLimit = number & {
  readonly [vaultRotationBatchLimitBrand]: "VaultRotationBatchLimit";
};

export type VaultRootRotationFailureCode =
  | "active_key_version_changed"
  | "source_root_unavailable"
  | "target_root_unavailable"
  | "ciphertext_invalid"
  | "verification_failed"
  | "persistence_conflict";

type RotationCursor =
  | { readonly kind: "start" }
  | {
      readonly kind: "after";
      readonly organisationId: OrganisationId;
      readonly handle: VaultHandle;
    };

type VaultRootRotationCounts = {
  readonly sourceRowCount: number;
  readonly processedCount: number;
  readonly rewrappedCount: number;
  readonly skippedCount: number;
};

type VaultRootRotationIdentity = {
  readonly rotationId: VaultRootRotationId;
  readonly sourceVersion: VaultKeyVersion;
  readonly targetVersion: VaultKeyVersion;
  readonly cursor: RotationCursor;
  readonly counts: VaultRootRotationCounts;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type VaultRootRotationJob =
  | (VaultRootRotationIdentity & {
      readonly kind: "pending";
      readonly startedAt?: never;
      readonly pausedAt?: never;
      readonly completedAt?: never;
      readonly failedAt?: never;
      readonly failureCode?: never;
    })
  | (VaultRootRotationIdentity & {
      readonly kind: "running";
      readonly startedAt: number;
      readonly pausedAt?: never;
      readonly completedAt?: never;
      readonly failedAt?: never;
      readonly failureCode?: never;
    })
  | (VaultRootRotationIdentity & {
      readonly kind: "paused";
      readonly startedAt: number;
      readonly pausedAt: number;
      readonly completedAt?: never;
      readonly failedAt?: never;
      readonly failureCode?: never;
    })
  | (VaultRootRotationIdentity & {
      readonly kind: "completed";
      readonly startedAt: number;
      readonly completedAt: number;
      readonly pausedAt?: never;
      readonly failedAt?: never;
      readonly failureCode?: never;
    })
  | (VaultRootRotationIdentity & {
      readonly kind: "failed";
      readonly startedAt: number;
      readonly failedAt: number;
      readonly failureCode: VaultRootRotationFailureCode;
      readonly pausedAt: number | null;
      readonly completedAt?: never;
    });

export type VaultRootRotationError =
  | { readonly code: "rotation_id_invalid" }
  | { readonly code: "rotation_batch_limit_invalid" }
  | { readonly code: "rotation_active_exists" }
  | { readonly code: "rotation_unknown"; readonly rotationId: string }
  | {
      readonly code: "rotation_state_conflict";
      readonly rotationId: string;
      readonly lifecycle: VaultRootRotationJob["kind"];
    }
  | {
      readonly code: "rotation_source_matches_target";
      readonly version: VaultKeyVersion;
    }
  | {
      readonly code: "rotation_source_root_unavailable";
      readonly version: VaultKeyVersion;
    }
  | { readonly code: "rotation_keyring_invalid" }
  | { readonly code: "rotation_persistence_failed" }
  | { readonly code: "rotation_persisted_state_invalid" };

type VaultRootRotationRow = {
  readonly rotationId: unknown;
  readonly sourceVersion: unknown;
  readonly targetVersion: unknown;
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

type VaultCiphertextRow = {
  readonly organisationId: unknown;
  readonly vaultHandle: unknown;
  readonly nonceB64: unknown;
  readonly ciphertextB64: unknown;
};

type RewrapOutcome =
  | { readonly kind: "rewrapped" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "failed";
      readonly failureCode: VaultRootRotationFailureCode;
    };

const ROTATION_ID_PATTERN = /^vrot_[a-z0-9][a-z0-9_-]{7,95}$/;
const MAX_ROTATION_BATCH_LIMIT = 100;

export function parseVaultRootRotationId(
  raw: string,
): Result<VaultRootRotationId, { readonly code: "rotation_id_invalid" }> {
  const value = raw.trim();

  if (!ROTATION_ID_PATTERN.test(value)) {
    return { ok: false, error: { code: "rotation_id_invalid" } };
  }

  return { ok: true, value: value as VaultRootRotationId };
}

export function parseVaultRotationBatchLimit(
  raw: unknown,
): Result<
  VaultRotationBatchLimit,
  { readonly code: "rotation_batch_limit_invalid" }
> {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_ROTATION_BATCH_LIMIT
  ) {
    return { ok: false, error: { code: "rotation_batch_limit_invalid" } };
  }

  return { ok: true, value: raw as VaultRotationBatchLimit };
}

export async function startVaultRootRotation(input: {
  readonly db: GlobalDatabase;
  readonly databases: readonly OrganisationDatabase[];
  readonly keys: CredentialVaultBindings;
  readonly rotationId: VaultRootRotationId;
  readonly sourceVersion: VaultKeyVersion;
  readonly now: number;
}): Promise<Result<VaultRootRotationJob, VaultRootRotationError>> {
  const keyRing = await loadCredentialVaultKeyRing(input.keys);

  if (!keyRing.ok) {
    return rotationKeyRingError(keyRing.error);
  }

  const targetVersion = activeVaultRoot(keyRing.value).version;

  if (targetVersion === input.sourceVersion) {
    return {
      ok: false,
      error: { code: "rotation_source_matches_target", version: targetVersion },
    };
  }

  const sourceRoot = vaultRootForVersion(keyRing.value, input.sourceVersion);

  if (!sourceRoot.ok) {
    return {
      ok: false,
      error: {
        code: "rotation_source_root_unavailable",
        version: input.sourceVersion,
      },
    };
  }

  const sourceRowCount = await countRowsUsingVersion(
    input.databases,
    input.sourceVersion,
  );

  try {
    await input.db
      .prepare(
        `INSERT INTO vault_root_rotation_job (
           rotation_id, source_key_version, target_key_version, lifecycle,
           cursor_organisation_id, cursor_vault_handle, source_row_count,
           processed_count, rewrapped_count, skipped_count, failure_code,
           created_at, started_at, updated_at, paused_at, completed_at, failed_at
         )
         VALUES (?, ?, ?, 'pending', NULL, NULL, ?, 0, 0, 0, NULL, ?, NULL, ?, NULL, NULL, NULL)`,
      )
      .bind(
        input.rotationId,
        input.sourceVersion,
        targetVersion,
        sourceRowCount,
        input.now,
        input.now,
      )
      .run();
  } catch (error) {
    if (await hasActiveRotation(input.db)) {
      return { ok: false, error: { code: "rotation_active_exists" } };
    }

    void error;
    return { ok: false, error: { code: "rotation_persistence_failed" } };
  }

  return readVaultRootRotation({ db: input.db, rotationId: input.rotationId });
}

export async function readVaultRootRotation(input: {
  readonly db: GlobalDatabase;
  readonly rotationId: VaultRootRotationId;
}): Promise<Result<VaultRootRotationJob, VaultRootRotationError>> {
  const row = await input.db
    .prepare(
      `SELECT rotation_id AS rotationId, source_key_version AS sourceVersion,
         target_key_version AS targetVersion, lifecycle,
         cursor_organisation_id AS cursorOrganisationId, cursor_vault_handle AS cursorVaultHandle,
         source_row_count AS sourceRowCount, processed_count AS processedCount,
         rewrapped_count AS rewrappedCount, skipped_count AS skippedCount,
         failure_code AS failureCode, created_at AS createdAt, started_at AS startedAt,
         updated_at AS updatedAt, paused_at AS pausedAt, completed_at AS completedAt,
         failed_at AS failedAt
       FROM vault_root_rotation_job
       WHERE rotation_id = ?`,
    )
    .bind(input.rotationId)
    .first<VaultRootRotationRow>();

  if (row === null) {
    return {
      ok: false,
      error: { code: "rotation_unknown", rotationId: input.rotationId },
    };
  }

  return parseVaultRootRotationRow(row);
}

export async function pauseVaultRootRotation(input: {
  readonly db: GlobalDatabase;
  readonly rotationId: VaultRootRotationId;
  readonly now: number;
}): Promise<Result<VaultRootRotationJob, VaultRootRotationError>> {
  const current = await readVaultRootRotation(input);

  if (!current.ok) {
    return current;
  }

  if (current.value.kind !== "running") {
    return rotationStateConflict(current.value);
  }

  const updated = await input.db
    .prepare(
      `UPDATE vault_root_rotation_job
       SET lifecycle = 'paused', paused_at = ?, updated_at = ?
       WHERE rotation_id = ? AND lifecycle = 'running'`,
    )
    .bind(input.now, input.now, input.rotationId)
    .run();

  if (updated.meta.changes !== 1) {
    return rotationStateConflict(current.value);
  }

  return readVaultRootRotation(input);
}

export async function resumeVaultRootRotation(input: {
  readonly db: GlobalDatabase;
  readonly rotationId: VaultRootRotationId;
  readonly now: number;
}): Promise<Result<VaultRootRotationJob, VaultRootRotationError>> {
  const current = await readVaultRootRotation(input);

  if (!current.ok) {
    return current;
  }

  if (current.value.kind !== "paused") {
    return rotationStateConflict(current.value);
  }

  const updated = await input.db
    .prepare(
      `UPDATE vault_root_rotation_job
       SET lifecycle = 'running', paused_at = NULL, updated_at = ?
       WHERE rotation_id = ? AND lifecycle = 'paused'`,
    )
    .bind(input.now, input.rotationId)
    .run();

  if (updated.meta.changes !== 1) {
    return rotationStateConflict(current.value);
  }

  return readVaultRootRotation(input);
}

export async function runVaultRootRotationStep(input: {
  readonly db: GlobalDatabase;
  readonly databases: readonly OrganisationDatabase[];
  readonly keys: CredentialVaultBindings;
  readonly rotationId: VaultRootRotationId;
  readonly limit: VaultRotationBatchLimit;
  readonly now: number;
}): Promise<Result<VaultRootRotationJob, VaultRootRotationError>> {
  const current = await readVaultRootRotation(input);

  if (!current.ok) {
    return current;
  }

  if (current.value.kind !== "pending" && current.value.kind !== "running") {
    return rotationStateConflict(current.value);
  }

  const keyRing = await loadCredentialVaultKeyRing(input.keys);

  if (!keyRing.ok) {
    await failVaultRootRotation(
      input.db,
      current.value,
      keyRingFailureCode(keyRing.error, current.value),
      input.now,
    );
    return readVaultRootRotation(input);
  }

  const active = activeVaultRoot(keyRing.value);

  if (active.version !== current.value.targetVersion) {
    await failVaultRootRotation(
      input.db,
      current.value,
      "active_key_version_changed",
      input.now,
    );
    return readVaultRootRotation(input);
  }

  const source = vaultRootForVersion(
    keyRing.value,
    current.value.sourceVersion,
  );

  if (!source.ok) {
    await failVaultRootRotation(
      input.db,
      current.value,
      "source_root_unavailable",
      input.now,
    );
    return readVaultRootRotation(input);
  }

  const running: Result<
    Variant<VaultRootRotationJob, "running">,
    VaultRootRotationError
  > = current.value.kind === "pending"
    ? await startPendingRotation(input.db, current.value, input.now)
    : { ok: true, value: current.value };

  if (!running.ok) {
    return running;
  }

  const rows = await readRotationBatch(
    input.databases,
    running.value.sourceVersion,
    input.limit,
  );

  let rewrappedCount = 0;
  let skippedCount = 0;
  let cursor = running.value.cursor;

  for (const row of rows) {
    const parsed = parseCiphertextRow(row.ciphertext);

    if (!parsed.ok) {
      await failVaultRootRotation(
        input.db,
        running.value,
        "ciphertext_invalid",
        input.now,
      );
      return readVaultRootRotation(input);
    }

    const outcome = await rewrapVaultRow({
      db: row.database,
      row: parsed.value,
      source: source.value,
      target: active,
      now: input.now,
    });

    if (outcome.kind === "failed") {
      await failVaultRootRotation(
        input.db,
        running.value,
        outcome.failureCode,
        input.now,
      );
      return readVaultRootRotation(input);
    }

    if (outcome.kind === "rewrapped") {
      rewrappedCount += 1;
    } else {
      skippedCount += 1;
    }

    cursor = {
      kind: "after",
      organisationId: parsed.value.organisationId,
      handle: parsed.value.handle,
    };
  }

  const remaining = await countRowsUsingVersion(
    input.databases,
    running.value.sourceVersion,
  );
  const completed = remaining === 0;
  const observedProcessed = running.value.counts.processedCount + rows.length;
  const unobservedProcessed = completed
    ? Math.max(0, running.value.counts.sourceRowCount - observedProcessed)
    : 0;
  const processedCount = completed
    ? running.value.counts.sourceRowCount
    : Math.min(running.value.counts.sourceRowCount, observedProcessed);

  await persistRotationProgress({
    db: input.db,
    job: running.value,
    cursor,
    processedCount,
    rewrappedCount: running.value.counts.rewrappedCount + rewrappedCount,
    skippedCount:
      running.value.counts.skippedCount + skippedCount + unobservedProcessed,
    completed,
    now: input.now,
  });

  return readVaultRootRotation(input);
}

export async function vaultRootVersionRemovalStatus(input: {
  readonly databases: readonly OrganisationDatabase[];
  readonly version: VaultKeyVersion;
}): Promise<
  | { readonly kind: "removable"; readonly version: VaultKeyVersion }
  | {
      readonly kind: "in_use";
      readonly version: VaultKeyVersion;
      readonly rowCount: number;
    }
> {
  const rowCount = await countRowsUsingVersion(input.databases, input.version);

  return rowCount === 0
    ? { kind: "removable", version: input.version }
    : { kind: "in_use", version: input.version, rowCount };
}

async function startPendingRotation(
  db: GlobalDatabase,
  job: Variant<VaultRootRotationJob, "pending">,
  now: number,
): Promise<
  Result<Variant<VaultRootRotationJob, "running">, VaultRootRotationError>
> {
  const result = await db
    .prepare(
      `UPDATE vault_root_rotation_job
       SET lifecycle = 'running', started_at = ?, updated_at = ?
       WHERE rotation_id = ? AND lifecycle = 'pending'`,
    )
    .bind(now, now, job.rotationId)
    .run();

  if (result.meta.changes !== 1) {
    return rotationStateConflict(job);
  }

  const loaded = await readVaultRootRotation({
    db,
    rotationId: job.rotationId,
  });

  if (!loaded.ok) {
    return loaded;
  }

  if (loaded.value.kind !== "running") {
    return rotationStateConflict(loaded.value);
  }

  return { ok: true, value: loaded.value };
}

async function readRotationBatch(
  databases: readonly OrganisationDatabase[],
  sourceVersion: VaultKeyVersion,
  limit: VaultRotationBatchLimit,
): Promise<
  readonly { database: OrganisationDatabase; ciphertext: VaultCiphertextRow }[]
> {
  const batch: {
    database: OrganisationDatabase;
    ciphertext: VaultCiphertextRow;
  }[] = [];
  for (const database of databases) {
    const remaining = limit - batch.length;
    if (remaining === 0) break;
    // Rewrapped rows leave this selection. Retrying starts at the first remaining
    // source row, including retained copies and rows moved between cells.
    const rows = await database
      .prepare(
        `SELECT organisation_id AS organisationId, vault_handle AS vaultHandle,
        nonce_b64 AS nonceB64, ciphertext_b64 AS ciphertextB64
       FROM vault_secret WHERE key_version = ?
       ORDER BY organisation_id, vault_handle LIMIT ?`,
      )
      .bind(sourceVersion, remaining)
      .all<VaultCiphertextRow>();
    for (const ciphertext of rows.results) batch.push({ database, ciphertext });
  }
  return batch;
}

async function rewrapVaultRow(input: {
  readonly db: OrganisationDatabase;
  readonly row: {
    readonly organisationId: OrganisationId;
    readonly handle: VaultHandle;
    readonly nonceB64: string;
    readonly ciphertextB64: string;
  };
  readonly source: VaultRootBinding;
  readonly target: VaultRootBinding;
  readonly now: number;
}): Promise<RewrapOutcome> {
  const plaintext = await decryptVaultPayload({
    key: input.source.key,
    organisationId: input.row.organisationId,
    handle: input.row.handle,
    keyVersion: input.source.version,
    nonceB64: input.row.nonceB64,
    ciphertextB64: input.row.ciphertextB64,
  });

  if (!plaintext.ok) {
    return { kind: "failed", failureCode: "ciphertext_invalid" };
  }

  const encrypted = await encryptVaultPayload({
    key: input.target.key,
    organisationId: input.row.organisationId,
    handle: input.row.handle,
    keyVersion: input.target.version,
    plaintext: plaintext.value,
  });
  const verified = await decryptVaultPayload({
    key: input.target.key,
    organisationId: input.row.organisationId,
    handle: input.row.handle,
    keyVersion: input.target.version,
    nonceB64: encrypted.nonceB64,
    ciphertextB64: encrypted.ciphertextB64,
  });

  if (!verified.ok || !vaultPayloadsEqual(plaintext.value, verified.value)) {
    return { kind: "failed", failureCode: "verification_failed" };
  }

  const updated = await input.db
    .prepare(
      `UPDATE vault_secret
       SET key_version = ?, nonce_b64 = ?, ciphertext_b64 = ?, rotated_at = ?
       WHERE organisation_id = ? AND vault_handle = ? AND key_version = ?
         AND nonce_b64 = ? AND ciphertext_b64 = ?`,
    )
    .bind(
      input.target.version,
      encrypted.nonceB64,
      encrypted.ciphertextB64,
      input.now,
      input.row.organisationId,
      input.row.handle,
      input.source.version,
      input.row.nonceB64,
      input.row.ciphertextB64,
    )
    .run();

  if (updated.meta.changes === 1) {
    return { kind: "rewrapped" };
  }

  const current = await input.db
    .prepare(
      `SELECT key_version AS keyVersion
       FROM vault_secret
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(input.row.organisationId, input.row.handle)
    .first<{ readonly keyVersion: unknown }>();

  if (current?.keyVersion === input.target.version) {
    return { kind: "skipped" };
  }

  return { kind: "failed", failureCode: "persistence_conflict" };
}

async function persistRotationProgress(input: {
  readonly db: GlobalDatabase;
  readonly job: Variant<VaultRootRotationJob, "running">;
  readonly cursor: RotationCursor;
  readonly processedCount: number;
  readonly rewrappedCount: number;
  readonly skippedCount: number;
  readonly completed: boolean;
  readonly now: number;
}): Promise<void> {
  const cursorOrganisationId =
    input.cursor.kind === "after" ? input.cursor.organisationId : null;
  const cursorVaultHandle =
    input.cursor.kind === "after" ? input.cursor.handle : null;

  if (input.completed) {
    await input.db
      .prepare(
        `UPDATE vault_root_rotation_job
         SET lifecycle = 'completed', cursor_organisation_id = ?, cursor_vault_handle = ?,
           processed_count = ?, rewrapped_count = ?, skipped_count = ?,
           updated_at = ?, completed_at = ?, paused_at = NULL
         WHERE rotation_id = ? AND lifecycle = 'running'`,
      )
      .bind(
        cursorOrganisationId,
        cursorVaultHandle,
        input.processedCount,
        input.rewrappedCount,
        input.skippedCount,
        input.now,
        input.now,
        input.job.rotationId,
      )
      .run();
    return;
  }

  await input.db
    .prepare(
      `UPDATE vault_root_rotation_job
       SET cursor_organisation_id = ?, cursor_vault_handle = ?, processed_count = ?,
         rewrapped_count = ?, skipped_count = ?, updated_at = ?
       WHERE rotation_id = ? AND lifecycle = 'running'`,
    )
    .bind(
      cursorOrganisationId,
      cursorVaultHandle,
      input.processedCount,
      input.rewrappedCount,
      input.skippedCount,
      input.now,
      input.job.rotationId,
    )
    .run();
}

async function failVaultRootRotation(
  db: GlobalDatabase,
  job: Variant<VaultRootRotationJob, "pending" | "running">,
  failureCode: VaultRootRotationFailureCode,
  now: number,
): Promise<void> {
  const startedAt = job.kind === "pending" ? now : job.startedAt;

  await db
    .prepare(
      `UPDATE vault_root_rotation_job
       SET lifecycle = 'failed', started_at = ?, failure_code = ?, failed_at = ?,
         updated_at = ?, completed_at = NULL
       WHERE rotation_id = ? AND lifecycle IN ('pending', 'running')`,
    )
    .bind(startedAt, failureCode, now, now, job.rotationId)
    .run();
}

async function countRowsUsingVersion(
  databases: readonly OrganisationDatabase[],
  version: VaultKeyVersion,
): Promise<number> {
  let total = 0;
  for (const database of databases) {
    const row = await database
      .prepare(
        "SELECT COUNT(*) AS rowCount FROM vault_secret WHERE key_version = ?",
      )
      .bind(version)
      .first<{ readonly rowCount: unknown }>();
    if (row === null || !isNonNegativeInteger(row.rowCount))
      throw new Error("Vault root-version count invariant failed");
    total += row.rowCount;
  }
  return total;
}

async function hasActiveRotation(db: GlobalDatabase): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT rotation_id
       FROM vault_root_rotation_job
       WHERE lifecycle IN ('pending', 'running', 'paused')
       LIMIT 1`,
    )
    .first<{ readonly rotation_id: string }>();

  return row !== null;
}

function parseVaultRootRotationRow(
  row: VaultRootRotationRow,
): Result<VaultRootRotationJob, VaultRootRotationError> {
  const rotationId =
    typeof row.rotationId === "string"
      ? parseVaultRootRotationId(row.rotationId)
      : { ok: false as const, error: { code: "rotation_id_invalid" as const } };
  const sourceVersion = parsePersistedKeyVersion(row.sourceVersion);
  const targetVersion = parsePersistedKeyVersion(row.targetVersion);
  const cursor = parseRotationCursor(
    row.cursorOrganisationId,
    row.cursorVaultHandle,
  );

  if (
    !rotationId.ok ||
    sourceVersion === null ||
    targetVersion === null ||
    sourceVersion === targetVersion ||
    !cursor.ok ||
    !isNonNegativeInteger(row.sourceRowCount) ||
    !isNonNegativeInteger(row.processedCount) ||
    !isNonNegativeInteger(row.rewrappedCount) ||
    !isNonNegativeInteger(row.skippedCount) ||
    !isTimestamp(row.createdAt) ||
    !isTimestamp(row.updatedAt)
  ) {
    return { ok: false, error: { code: "rotation_persisted_state_invalid" } };
  }

  const identity: VaultRootRotationIdentity = {
    rotationId: rotationId.value,
    sourceVersion,
    targetVersion,
    cursor: cursor.value,
    counts: {
      sourceRowCount: row.sourceRowCount,
      processedCount: row.processedCount,
      rewrappedCount: row.rewrappedCount,
      skippedCount: row.skippedCount,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  switch (row.lifecycle) {
    case "pending":
      if (
        row.startedAt === null &&
        row.pausedAt === null &&
        row.completedAt === null &&
        row.failedAt === null &&
        row.failureCode === null
      ) {
        return { ok: true, value: { ...identity, kind: "pending" } };
      }
      break;
    case "running":
      if (
        isTimestamp(row.startedAt) &&
        row.pausedAt === null &&
        row.completedAt === null &&
        row.failedAt === null &&
        row.failureCode === null
      ) {
        return {
          ok: true,
          value: { ...identity, kind: "running", startedAt: row.startedAt },
        };
      }
      break;
    case "paused":
      if (
        isTimestamp(row.startedAt) &&
        isTimestamp(row.pausedAt) &&
        row.completedAt === null &&
        row.failedAt === null &&
        row.failureCode === null
      ) {
        return {
          ok: true,
          value: {
            ...identity,
            kind: "paused",
            startedAt: row.startedAt,
            pausedAt: row.pausedAt,
          },
        };
      }
      break;
    case "completed":
      if (
        isTimestamp(row.startedAt) &&
        isTimestamp(row.completedAt) &&
        row.pausedAt === null &&
        row.failedAt === null &&
        row.failureCode === null
      ) {
        return {
          ok: true,
          value: {
            ...identity,
            kind: "completed",
            startedAt: row.startedAt,
            completedAt: row.completedAt,
          },
        };
      }
      break;
    case "failed": {
      const failureCode = parseFailureCode(row.failureCode);

      if (
        isTimestamp(row.startedAt) &&
        isTimestamp(row.failedAt) &&
        (row.pausedAt === null || isTimestamp(row.pausedAt)) &&
        row.completedAt === null &&
        failureCode !== null
      ) {
        return {
          ok: true,
          value: {
            ...identity,
            kind: "failed",
            startedAt: row.startedAt,
            failedAt: row.failedAt,
            failureCode,
            pausedAt: row.pausedAt,
          },
        };
      }
      break;
    }
    default:
      break;
  }

  return { ok: false, error: { code: "rotation_persisted_state_invalid" } };
}

function parseRotationCursor(
  organisationIdRaw: unknown,
  vaultHandleRaw: unknown,
): Result<
  RotationCursor,
  { readonly code: "rotation_persisted_state_invalid" }
> {
  if (organisationIdRaw === null && vaultHandleRaw === null) {
    return { ok: true, value: { kind: "start" } };
  }

  if (
    typeof organisationIdRaw !== "string" ||
    typeof vaultHandleRaw !== "string"
  ) {
    return { ok: false, error: { code: "rotation_persisted_state_invalid" } };
  }

  const organisationId = parseOrganisationId(organisationIdRaw);
  const handle = parseVaultHandle(vaultHandleRaw);

  if (!organisationId.ok || !handle.ok) {
    return { ok: false, error: { code: "rotation_persisted_state_invalid" } };
  }

  return {
    ok: true,
    value: {
      kind: "after",
      organisationId: organisationId.value,
      handle: handle.value,
    },
  };
}

function parseCiphertextRow(row: VaultCiphertextRow): Result<
  {
    readonly organisationId: OrganisationId;
    readonly handle: VaultHandle;
    readonly nonceB64: string;
    readonly ciphertextB64: string;
  },
  { readonly code: "ciphertext_invalid" }
> {
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : {
          ok: false as const,
          error: { code: "invalid_organisation_id" as const },
        };
  const handle =
    typeof row.vaultHandle === "string"
      ? parseVaultHandle(row.vaultHandle)
      : {
          ok: false as const,
          error: { code: "invalid_vault_handle" as const },
        };

  if (
    !organisationId.ok ||
    !handle.ok ||
    typeof row.nonceB64 !== "string" ||
    typeof row.ciphertextB64 !== "string"
  ) {
    return { ok: false, error: { code: "ciphertext_invalid" } };
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      handle: handle.value,
      nonceB64: row.nonceB64,
      ciphertextB64: row.ciphertextB64,
    },
  };
}

function parsePersistedKeyVersion(raw: unknown): VaultKeyVersion | null {
  return raw === "v1" || raw === "v2" ? raw : null;
}

function parseFailureCode(raw: unknown): VaultRootRotationFailureCode | null {
  switch (raw) {
    case "active_key_version_changed":
    case "source_root_unavailable":
    case "target_root_unavailable":
    case "ciphertext_invalid":
    case "verification_failed":
    case "persistence_conflict":
      return raw;
    default:
      return null;
  }
}

function isTimestamp(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0;
}

function rotationStateConflict(
  job: VaultRootRotationJob,
): Result<never, VaultRootRotationError> {
  return {
    ok: false,
    error: {
      code: "rotation_state_conflict",
      rotationId: job.rotationId,
      lifecycle: job.kind,
    },
  };
}

function rotationKeyRingError(
  error: VaultKeyRingError,
): Result<never, VaultRootRotationError> {
  switch (error.code) {
    case "vault_root_unavailable":
      return {
        ok: false,
        error: {
          code: "rotation_source_root_unavailable",
          version: error.version,
        },
      };
    case "vault_active_key_version_invalid":
    case "vault_root_key_version_invalid":
    case "vault_root_binding_invalid":
    case "vault_root_version_duplicate":
    case "vault_active_root_unavailable":
    case "vault_root_invalid":
      return { ok: false, error: { code: "rotation_keyring_invalid" } };
    default:
      return assertNever(error, "Unhandled Vault keyring error");
  }
}

function keyRingFailureCode(
  error: VaultKeyRingError,
  job: Variant<VaultRootRotationJob, "pending" | "running">,
): VaultRootRotationFailureCode {
  if ("version" in error && error.version === job.targetVersion) {
    return "target_root_unavailable";
  }

  if ("version" in error && error.version === job.sourceVersion) {
    return "source_root_unavailable";
  }

  return "persistence_conflict";
}
