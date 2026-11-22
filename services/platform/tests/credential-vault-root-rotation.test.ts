import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  parseVaultRootRotationId,
  parseVaultRotationBatchLimit,
  pauseVaultRootRotation,
  resumeVaultRootRotation,
  runVaultRootRotationStep,
  startVaultRootRotation,
  storeVaultSecret,
  vaultRootVersionRemovalStatus,
  type VaultHandle,
  type VaultRootRotationId,
  type VaultRotationBatchLimit,
} from "../src/credential-vault";
import { resolveVaultHandle } from "../src/credential-vault/service";
import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import { type OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { testRoot } from "./secrets-store";
describe("Credential Vault root rotation", credentialVaultRootRotationSuite);

function credentialVaultRootRotationSuite(): void {
  it(
    "pauses, resumes, and completes bounded rewrap steps",
    completesBoundedRotation,
  );
  it(
    "preserves a concurrent credential update and counts it as skipped",
    preservesConcurrentUpdate,
  );
  it(
    "resumes from its durable cursor after a worker restart",
    resumesAfterRestart,
  );
  it("fails durably on corrupt ciphertext", failsOnCorruptCiphertext);
  it(
    "fails durably when the configured active version changes",
    failsOnActiveVersionChange,
  );
}

async function completesBoundedRotation(): Promise<void> {
  const fixture = createFixture();
  const handles = await storeSecrets(fixture, 3);
  const rotationId = requireRotationId("vrot_bounded_0001");
  const limit = requireBatchLimit(1);

  const started = await startVaultRootRotation({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    sourceVersion: "v1",
    now: 10,
  });

  expect(started).toMatchObject({
    ok: true,
    value: {
      kind: "pending",
      sourceVersion: "v1",
      targetVersion: "v2",
      counts: { sourceRowCount: 3, processedCount: 0 },
    },
  });

  const first = await runVaultRootRotationStep({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    limit,
    now: 11,
  });

  expect(first).toMatchObject({
    ok: true,
    value: {
      kind: "running",
      counts: { processedCount: 1, rewrappedCount: 1, skippedCount: 0 },
    },
  });
  await expect(
    vaultRootVersionRemovalStatus({
      databases: [fixture.db],
      version: "v1",
    }),
  ).resolves.toEqual({ kind: "in_use", version: "v1", rowCount: 2 });

  await expect(
    pauseVaultRootRotation({
      db: fixture.db,
      rotationId,
      now: 12,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { kind: "paused", pausedAt: 12 },
  });
  await expect(
    resumeVaultRootRotation({
      db: fixture.db,
      rotationId,
      now: 13,
    }),
  ).resolves.toMatchObject({ ok: true, value: { kind: "running" } });

  await runVaultRootRotationStep({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    limit,
    now: 14,
  });
  const completed = await runVaultRootRotationStep({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    limit,
    now: 15,
  });

  expect(completed).toMatchObject({
    ok: true,
    value: {
      kind: "completed",
      completedAt: 15,
      counts: {
        sourceRowCount: 3,
        processedCount: 3,
        rewrappedCount: 3,
        skippedCount: 0,
      },
    },
  });
  await expect(
    vaultRootVersionRemovalStatus({
      databases: [fixture.db],
      version: "v1",
    }),
  ).resolves.toEqual({ kind: "removable", version: "v1" });

  for (const handle of handles) {
    await expect(
      resolveVaultHandle({
        db: fixture.db,
        keys: fixture.v2Only,
        organisationId: fixture.organisationId,
        handle,
      }),
    ).resolves.toMatchObject({ ok: true });
  }
}

async function preservesConcurrentUpdate(): Promise<void> {
  const fixture = createFixture();
  const handles = await storeSecrets(fixture, 2);
  const rotationId = requireRotationId("vrot_concurrent_0001");

  await startVaultRootRotation({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    sourceVersion: "v1",
    now: 20,
  });
  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v2Active,
      organisationId: fixture.organisationId,
      handle: handles[1] ?? failMissingHandle(),
      secret: { kind: "bearer", value: "concurrent-value" },
      now: 21,
    }),
  ).resolves.toMatchObject({ ok: true, value: { keyVersion: "v2" } });

  const completed = await runVaultRootRotationStep({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    limit: requireBatchLimit(10),
    now: 22,
  });

  expect(completed).toMatchObject({
    ok: true,
    value: {
      kind: "completed",
      counts: {
        sourceRowCount: 2,
        processedCount: 2,
        rewrappedCount: 1,
        skippedCount: 1,
      },
    },
  });
  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v2Only,
      organisationId: fixture.organisationId,
      handle: handles[1] ?? failMissingHandle(),
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "concurrent-value" },
  });
}

async function resumesAfterRestart(): Promise<void> {
  const fixture = createFixture();
  await storeSecrets(fixture, 3);
  const rotationId = requireRotationId("vrot_restart_0001");
  const limit = requireBatchLimit(1);

  await startVaultRootRotation({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    sourceVersion: "v1",
    now: 30,
  });
  await runVaultRootRotationStep({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    limit,
    now: 31,
  });

  const restartedDb = d1Database(fixture.sqlite);
  await runVaultRootRotationStep({
    databases: [restartedDb],
    db: restartedDb,
    keys: fixture.v2Active,
    rotationId,
    limit,
    now: 32,
  });
  const completed = await runVaultRootRotationStep({
    databases: [restartedDb],
    db: restartedDb,
    keys: fixture.v2Active,
    rotationId,
    limit,
    now: 33,
  });

  expect(completed).toMatchObject({
    ok: true,
    value: {
      kind: "completed",
      counts: { processedCount: 3, rewrappedCount: 3 },
    },
  });
}

async function failsOnCorruptCiphertext(): Promise<void> {
  const fixture = createFixture();
  const handles = await storeSecrets(fixture, 1);
  const handle = handles[0] ?? failMissingHandle();
  const rotationId = requireRotationId("vrot_corrupt_0001");

  fixture.sqlite
    .prepare(
      `UPDATE vault_secret SET ciphertext_b64 = 'invalid' WHERE vault_handle = ?`,
    )
    .run(handle);
  await startVaultRootRotation({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    sourceVersion: "v1",
    now: 40,
  });

  await expect(
    runVaultRootRotationStep({
      db: fixture.db,
      databases: [fixture.db],
      keys: fixture.v2Active,
      rotationId,
      limit: requireBatchLimit(10),
      now: 41,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { kind: "failed", failureCode: "ciphertext_invalid", failedAt: 41 },
  });
}

async function failsOnActiveVersionChange(): Promise<void> {
  const fixture = createFixture();
  await storeSecrets(fixture, 1);
  const rotationId = requireRotationId("vrot_key_change_0001");

  await startVaultRootRotation({
    db: fixture.db,
    databases: [fixture.db],
    keys: fixture.v2Active,
    rotationId,
    sourceVersion: "v1",
    now: 50,
  });

  await expect(
    runVaultRootRotationStep({
      db: fixture.db,
      databases: [fixture.db],
      keys: fixture.v1Active,
      rotationId,
      limit: requireBatchLimit(10),
      now: 51,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      kind: "failed",
      failureCode: "active_key_version_changed",
      failedAt: 51,
    },
  });
}

async function storeSecrets(
  fixture: CredentialVaultFixture,
  count: number,
): Promise<readonly VaultHandle[]> {
  const handles: VaultHandle[] = [];

  for (let index = 0; index < count; index += 1) {
    const handle = requireVaultHandle(`vault:test:rotation:secret-${index}`);
    const stored = await storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
      secret: { kind: "bearer", value: `secret-${index}` },
      now: index + 1,
    });

    if (!stored.ok) {
      throw new Error(stored.error.code);
    }

    handles.push(handle);
  }

  return handles;
}

type CredentialVaultFixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly v1Active: CredentialVaultBindings;
  readonly v2Active: CredentialVaultBindings;
  readonly v2Only: CredentialVaultBindings;
};

function createFixture(): CredentialVaultFixture {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());

  const organisationId = requireOrganisationId("organisation_vault_rotation");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Vault Rotation', 'beta', 1, 'active')`,
    )
    .run(organisationId);

  const v1 = testRoot(1);
  const v2 = testRoot(2);

  return {
    sqlite,
    db: d1Database(sqlite),
    organisationId,
    v1Active: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: v1,
      VAULT_ROOT_V2: v2,
    },
    v2Active: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v2",
      VAULT_ROOT_V1: v1,
      VAULT_ROOT_V2: v2,
    },
    v2Only: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v2",
      VAULT_ROOT_V2: v2,
    },
  };
}

function requireRotationId(raw: string): VaultRootRotationId {
  const parsed = parseVaultRootRotationId(raw);

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function requireBatchLimit(raw: number): VaultRotationBatchLimit {
  const parsed = parseVaultRotationBatchLimit(raw);

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function failMissingHandle(): never {
  throw new Error("expected a stored Vault handle");
}
