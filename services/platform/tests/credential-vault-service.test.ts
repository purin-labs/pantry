import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  revokeVaultSecret,
  storeVaultSecret,
  type VaultHandle,
} from "../src/credential-vault";
import { resolveVaultHandle } from "../src/credential-vault/service";
import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import { type OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { testRoot } from "./secrets-store";
describe("Credential Vault encrypted storage", credentialVaultServiceSuite);

function credentialVaultServiceSuite(): void {
  it(
    "writes with the active root and reads both root versions",
    readsMixedVersions,
  );
  it(
    "fails closed when a stored row depends on a removed root",
    rejectsRemovedRoot,
  );
  it("rejects corrupt ciphertext and unknown key versions", rejectsCorruptRows);
  it(
    "preserves the stored credential when a write fails",
    preservesCredentialOnFailedWrite,
  );
  it("still rotates an active handle in place", rotatesActiveHandle);
  it("rejects ordinary writes to revoked handles", rejectsRevokedHandleWrite);
  it(
    "returns store errors carrying no secret material or handle",
    omitsSecretsFromStoreErrors,
  );
  it(
    "round-trips an opaque Codex auth profile without interpreting it",
    roundTripsCodexProfile,
  );
}

async function roundTripsCodexProfile(): Promise<void> {
  const fixture = createFixture();
  const handle = requireVaultHandle("vault:test:codex:profile");
  const authProfile = JSON.stringify({
    tokens: { access_token: "sensitive", refresh_token: "secret" },
  });

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
      secret: {
        kind: "opaque_profile",
        format: "codex_auth_json_v1",
        value: authProfile,
      },
      now: 1,
    }),
  ).resolves.toMatchObject({ ok: true });

  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      kind: "opaque_profile",
      format: "codex_auth_json_v1",
      value: authProfile,
    },
  });

  const persisted = fixture.sqlite
    .prepare(
      `SELECT nonce_b64 AS nonce, ciphertext_b64 AS ciphertext FROM vault_secret WHERE vault_handle = ?`,
    )
    .get(handle) as { readonly nonce: string; readonly ciphertext: string };
  expect(JSON.stringify(persisted)).not.toContain("sensitive");
  expect(JSON.stringify(persisted)).not.toContain("refresh_token");
}

async function preservesCredentialOnFailedWrite(): Promise<void> {
  const fixture = createFixture();
  const handle = requireVaultHandle("vault:test:preserve:bearer");

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
      secret: { kind: "bearer", value: "original-secret" },
      now: 1,
    }),
  ).resolves.toMatchObject({ ok: true });

  const failed = await storeVaultSecret({
    db: fixture.db,
    keys: { PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1" },
    organisationId: fixture.organisationId,
    handle,
    secret: { kind: "bearer", value: "replacement-secret" },
    now: 2,
  });

  expect(failed.ok).toBe(false);

  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "original-secret" },
  });
}

async function rotatesActiveHandle(): Promise<void> {
  const fixture = createFixture();
  const handle = requireVaultHandle("vault:test:rotate:bearer");

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
      secret: { kind: "bearer", value: "first-value" },
      now: 1,
    }),
  ).resolves.toMatchObject({ ok: true });

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
      secret: { kind: "bearer", value: "rotated-value" },
      now: 2,
    }),
  ).resolves.toMatchObject({ ok: true });

  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "rotated-value" },
  });
}

async function rejectsRevokedHandleWrite(): Promise<void> {
  const fixture = createFixture();
  const handle = requireVaultHandle("vault:test:revoked:bearer");

  await requireStoredSecret(fixture, handle);
  const before = readVaultRow(fixture.sqlite, handle);

  await revokeVaultSecret({
    db: fixture.db,
    organisationId: fixture.organisationId,
    handle,
    now: 2,
  });

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle,
      secret: { kind: "bearer", value: "replacement-secret" },
      now: 3,
    }),
  ).resolves.toEqual({ ok: false, error: { code: "vault_secret_revoked" } });

  expect(readVaultRow(fixture.sqlite, handle)).toEqual({
    ciphertextB64: before.ciphertextB64,
    revokedAt: 2,
  });
}

async function omitsSecretsFromStoreErrors(): Promise<void> {
  const fixture = createFixture();
  const handle = requireVaultHandle("vault:test:redaction:bearer");

  const failed = await storeVaultSecret({
    db: fixture.db,
    keys: { PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1" },
    organisationId: fixture.organisationId,
    handle,
    secret: { kind: "bearer", value: "never-surfaced-secret" },
    now: 1,
  });

  expect(failed.ok).toBe(false);

  const serialized = JSON.stringify(failed);

  expect(serialized).not.toContain("never-surfaced-secret");
  expect(serialized).not.toContain(handle);
  expect(serialized).not.toContain(fixture.organisationId);
}

async function readsMixedVersions(): Promise<void> {
  const fixture = createFixture();
  const firstHandle = requireVaultHandle("vault:test:stripe:first");
  const secondHandle = requireVaultHandle("vault:test:stripe:second");

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v1Active,
      organisationId: fixture.organisationId,
      handle: firstHandle,
      secret: { kind: "bearer", value: "first-secret" },
      now: 1,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { keyVersion: "v1" },
  });

  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v2Active,
      organisationId: fixture.organisationId,
      handle: firstHandle,
    }),
  ).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "first-secret" },
  });

  await expect(
    storeVaultSecret({
      db: fixture.db,
      keys: fixture.v2Active,
      organisationId: fixture.organisationId,
      handle: secondHandle,
      secret: {
        kind: "header",
        header: "x-provider-key",
        value: "second-secret",
      },
      now: 2,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { keyVersion: "v2" },
  });

  expect(readKeyVersions(fixture.sqlite)).toEqual([
    { vaultHandle: firstHandle, keyVersion: "v1" },
    { vaultHandle: secondHandle, keyVersion: "v2" },
  ]);
}

async function rejectsRemovedRoot(): Promise<void> {
  const fixture = createFixture();
  const handle = requireVaultHandle("vault:test:stripe:removed-root");

  await requireStoredSecret(fixture, handle);

  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: {
        PANTRY_VAULT_ACTIVE_KEY_VERSION: "v2",
        VAULT_ROOT_V2: fixture.v2Active.VAULT_ROOT_V2,
      },
      organisationId: fixture.organisationId,
      handle,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_root_unavailable" },
  });
}

async function rejectsCorruptRows(): Promise<void> {
  const fixture = createFixture();
  const corruptHandle = requireVaultHandle("vault:test:stripe:corrupt");
  const unknownVersionHandle = requireVaultHandle(
    "vault:test:stripe:unknown-version",
  );

  await requireStoredSecret(fixture, corruptHandle);
  await requireStoredSecret(fixture, unknownVersionHandle);

  fixture.sqlite
    .prepare(
      `UPDATE vault_secret SET nonce_b64 = 'invalid' WHERE vault_handle = ?`,
    )
    .run(corruptHandle);
  fixture.sqlite
    .prepare(
      `UPDATE vault_secret SET key_version = 'v3' WHERE vault_handle = ?`,
    )
    .run(unknownVersionHandle);

  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v2Active,
      organisationId: fixture.organisationId,
      handle: corruptHandle,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_ciphertext_invalid", handle: corruptHandle },
  });
  await expect(
    resolveVaultHandle({
      db: fixture.db,
      keys: fixture.v2Active,
      organisationId: fixture.organisationId,
      handle: unknownVersionHandle,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "vault_ciphertext_invalid", handle: unknownVersionHandle },
  });
}

async function requireStoredSecret(
  fixture: CredentialVaultFixture,
  handle: VaultHandle,
): Promise<void> {
  const stored = await storeVaultSecret({
    db: fixture.db,
    keys: fixture.v1Active,
    organisationId: fixture.organisationId,
    handle,
    secret: { kind: "bearer", value: "stored-secret" },
    now: 1,
  });

  if (!stored.ok) {
    throw new Error(stored.error.code);
  }
}

type CredentialVaultFixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly v1Active: CredentialVaultBindings;
  readonly v2Active: CredentialVaultBindings;
};

function createFixture(): CredentialVaultFixture {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());

  const organisationId = requireOrganisationId("organisation_vault_test");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Vault Test', 'beta', 1, 'active')`,
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
  };
}

function readKeyVersions(
  sqlite: DatabaseSync,
): readonly { readonly vaultHandle: string; readonly keyVersion: string }[] {
  return sqlite
    .prepare(
      `SELECT vault_handle AS vaultHandle, key_version AS keyVersion
     FROM vault_secret
     ORDER BY vault_handle`,
    )
    .all() as { vaultHandle: string; keyVersion: string }[];
}

function readVaultRow(
  sqlite: DatabaseSync,
  handle: VaultHandle,
): { readonly ciphertextB64: string; readonly revokedAt: number | null } {
  return sqlite
    .prepare(
      `SELECT ciphertext_b64 AS ciphertextB64, revoked_at AS revokedAt
     FROM vault_secret
     WHERE vault_handle = ?`,
    )
    .get(handle) as { ciphertextB64: string; revokedAt: number | null };
}
