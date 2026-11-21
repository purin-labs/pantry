import type { SingleDatabase } from "../src/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { encryptVaultPayload } from "../src/credential-vault/crypto";
import { type VaultHandle } from "../src/credential-vault/domain";
import {
  loadCredentialVaultKeyRing,
  vaultRootForVersion,
  type CredentialVaultBindings,
  type VaultKeyVersion,
} from "../src/credential-vault/keyring";
import { inspectRetainedVaultRootClosure } from "../src/credential-vault/root-closure";
import { resolveVaultHandle } from "../src/credential-vault/service";
import gateway from "../src/integration-gateway";
import { type OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import { testRoot } from "./secrets-store";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { readMigration } from "./sqlite-d1";
import { platformEnv, testExecutionContext } from "./worker-fakes";

describe("retained Vault root closure", function retainedVaultRootClosureSuite() {
  it(
    "decrypts every retained live and revoked ciphertext",
    decryptsRetainedCiphertext,
  );
  it("reports a referenced root that is unavailable", reportsUnavailableRoot);
  it(
    "fails closed after restore when a referenced root is unavailable",
    failsClosedAfterRestoreWithoutReferencedRoot,
  );
  it(
    "reports corrupt retained ciphertext without exposing it",
    reportsCorruptCiphertext,
  );
  it(
    "reports decrypted payloads that are not restorable Vault secrets",
    reportsInvalidPlaintext,
  );
  it("rejects an unknown retained key version", rejectsUnknownKeyVersion);
  it(
    "fails closed when the bounded inventory is exceeded",
    rejectsOversizedInventory,
  );
  it(
    "exposes a metadata-only authenticated inspection route",
    exposesProtectedRoute,
  );
});

async function decryptsRetainedCiphertext(): Promise<void> {
  const fixture = rootClosureFixture();
  const keys = credentialVaultKeys(true);
  await insertEncryptedVaultRow(
    fixture,
    keys,
    "v1",
    "vault:test:root-v1-live",
    null,
  );
  await insertEncryptedVaultRow(
    fixture,
    keys,
    "v1",
    "vault:test:root-v1-revoked",
    20,
  );
  await insertEncryptedVaultRow(
    fixture,
    keys,
    "v2",
    "vault:test:root-v2-live",
    null,
  );

  await expect(
    inspectRetainedVaultRootClosure({
      databases: [fixture.db],
      keys,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      status: "passed",
      auditedRowCount: 3,
      revokedRowCount: 1,
      versions: [
        { keyVersion: "v1", rowCount: 2, decryptedCount: 2 },
        { keyVersion: "v2", rowCount: 1, decryptedCount: 1 },
      ],
      findings: [],
    },
  });
}

async function reportsUnavailableRoot(): Promise<void> {
  const fixture = rootClosureFixture();
  const bothRoots = credentialVaultKeys(true);
  await insertEncryptedVaultRow(
    fixture,
    bothRoots,
    "v2",
    "vault:test:root-v2-unavailable",
    null,
  );

  await expect(
    inspectRetainedVaultRootClosure({
      databases: [fixture.db],
      keys: credentialVaultKeys(false),
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      status: "failed",
      auditedRowCount: 1,
      revokedRowCount: 0,
      versions: [{ keyVersion: "v2", rowCount: 1, decryptedCount: 0 }],
      findings: [
        {
          kind: "referenced_vault_root_unavailable",
          keyVersion: "v2",
          affectedRows: 1,
        },
      ],
    },
  });
}

async function failsClosedAfterRestoreWithoutReferencedRoot(): Promise<void> {
  const fixture = rootClosureFixture();
  const keys = credentialVaultKeys(true);
  const handle = requireVaultHandle("vault:test:restored-root-v2-unavailable");
  await insertEncryptedVaultRow(fixture, keys, "v2", handle, null);

  const backupDirectory = mkdtempSync(join(tmpdir(), "pantry-vault-restore-"));
  const backupPath = join(backupDirectory, "restored.sqlite");
  await backup(fixture.sqlite, backupPath);
  const restoredSqlite = new DatabaseSync(backupPath);

  try {
    const restoredDb = d1Database(restoredSqlite);
    const restoredKeys = credentialVaultKeys(false);
    const closure = await inspectRetainedVaultRootClosure({
      databases: [restoredDb],
      keys: restoredKeys,
    });
    const resolution = await resolveVaultHandle({
      db: restoredDb,
      keys: restoredKeys,
      organisationId: fixture.organisationId,
      handle,
    });

    expect(closure).toEqual({
      ok: true,
      value: {
        status: "failed",
        auditedRowCount: 1,
        revokedRowCount: 0,
        versions: [{ keyVersion: "v2", rowCount: 1, decryptedCount: 0 }],
        findings: [
          {
            kind: "referenced_vault_root_unavailable",
            keyVersion: "v2",
            affectedRows: 1,
          },
        ],
      },
    });
    expect(resolution).toEqual({
      ok: false,
      error: { code: "vault_root_unavailable" },
    });
    expect(JSON.stringify({ closure, resolution })).not.toContain(
      '\"value\":\"fixture\"',
    );
  } finally {
    restoredSqlite.close();
    fixture.sqlite.close();
    rmSync(backupDirectory, { recursive: true, force: true });
  }
}

async function reportsCorruptCiphertext(): Promise<void> {
  const fixture = rootClosureFixture();
  insertRawVaultRow(
    fixture,
    "v1",
    "vault:test:root-corrupt",
    "AA==",
    "sensitive-corrupt-ciphertext",
    null,
  );

  const result = await inspectRetainedVaultRootClosure({
    databases: [fixture.db],
    keys: credentialVaultKeys(false),
  });
  expect(result).toEqual({
    ok: true,
    value: {
      status: "failed",
      auditedRowCount: 1,
      revokedRowCount: 0,
      versions: [{ keyVersion: "v1", rowCount: 1, decryptedCount: 0 }],
      findings: [
        {
          kind: "retained_vault_ciphertext_invalid",
          keyVersion: "v1",
          affectedRows: 1,
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain("sensitive-corrupt-ciphertext");
  expect(JSON.stringify(result)).not.toContain("organisation_root_closure");
  expect(JSON.stringify(result)).not.toContain("vault:test:root-corrupt");
}

async function rejectsOversizedInventory(): Promise<void> {
  const fixture = rootClosureFixture();
  const insert = fixture.sqlite.prepare(
    `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (?, ?, 'v1', 'AES-GCM-256', 'AA==', 'AA==', 1, NULL, NULL)`,
  );
  for (let index = 0; index < 1_001; index += 1) {
    insert.run(fixture.organisationId, `vault:test:root-limit-${index}`);
  }

  await expect(
    inspectRetainedVaultRootClosure({
      databases: [fixture.db],
      keys: credentialVaultKeys(false),
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "retained_vault_root_inventory_exceeded" },
  });
}

async function reportsInvalidPlaintext(): Promise<void> {
  const fixture = rootClosureFixture();
  const keys = credentialVaultKeys(false);
  const keyRing = await loadCredentialVaultKeyRing(keys);
  if (!keyRing.ok) throw new Error("root fixture keyring invalid");
  const root = vaultRootForVersion(keyRing.value, "v1");
  if (!root.ok) throw new Error("root fixture version unavailable");
  const handle = requireVaultHandle("vault:test:root-invalid-plaintext");
  const encrypted = await encryptVaultPayload({
    key: root.value.key,
    organisationId: fixture.organisationId,
    handle,
    keyVersion: "v1",
    plaintext: new TextEncoder().encode('{"kind":"unknown"}'),
  });
  insertRawVaultRow(
    fixture,
    "v1",
    handle,
    encrypted.nonceB64,
    encrypted.ciphertextB64,
    null,
  );

  await expect(
    inspectRetainedVaultRootClosure({
      databases: [fixture.db],
      keys,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      status: "failed",
      auditedRowCount: 1,
      revokedRowCount: 0,
      versions: [{ keyVersion: "v1", rowCount: 1, decryptedCount: 0 }],
      findings: [
        {
          kind: "retained_vault_plaintext_invalid",
          keyVersion: "v1",
          affectedRows: 1,
        },
      ],
    },
  });
}

async function rejectsUnknownKeyVersion(): Promise<void> {
  const fixture = rootClosureFixture();
  fixture.sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (?, 'vault:test:root-unknown', 'v3', 'AES-GCM-256',
       'AA==', 'AA==', 1, NULL, NULL)`,
    )
    .run(fixture.organisationId);

  await expect(
    inspectRetainedVaultRootClosure({
      databases: [fixture.db],
      keys: credentialVaultKeys(false),
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "retained_vault_root_data_invalid" },
  });
}

async function exposesProtectedRoute(): Promise<void> {
  const fixture = rootClosureFixture();
  const keys = credentialVaultKeys(false);
  await insertEncryptedVaultRow(
    fixture,
    keys,
    "v1",
    "vault:test:root-route",
    20,
  );
  const adminToken = "retained-vault-root-closure-admin-token";
  const env = platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: fixture.db,
    ...keys,
    ORGANISATION_ADMIN_TOKEN: adminToken,
  });
  const route = "https://pantry.test/v1/admin/vault-root-closure";

  const unauthorized = await gateway.fetch(
    new Request(route),
    env,
    fakeExecutionContext(),
  );
  const wrongMethod = await gateway.fetch(
    new Request(route, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    }),
    env,
    fakeExecutionContext(),
  );
  const response = await gateway.fetch(
    new Request(route, {
      headers: { authorization: `Bearer ${adminToken}` },
    }),
    env,
    fakeExecutionContext(),
  );

  expect(unauthorized.status).toBe(404);
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("allow")).toBe("GET");
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    ok: true,
    closure: {
      status: "passed",
      auditedRowCount: 1,
      revokedRowCount: 1,
      versions: [{ keyVersion: "v1", rowCount: 1, decryptedCount: 1 }],
      findings: [],
    },
  });
  expect(body).not.toContain("organisation_root_closure");
  expect(body).not.toContain("vault:test:root-route");
  expect(body).not.toContain("fixture");
}

type RootClosureFixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
};

function rootClosureFixture(): RootClosureFixture {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readMigration("0001_current_schema.sql"));
  const organisationId = requireOrganisationId("organisation_root_closure");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Root Closure', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  return {
    sqlite,
    db: d1Database(sqlite),
    organisationId,
  };
}

async function insertEncryptedVaultRow(
  fixture: RootClosureFixture,
  keys: CredentialVaultBindings,
  keyVersion: VaultKeyVersion,
  rawHandle: string,
  revokedAt: number | null,
): Promise<void> {
  const keyRing = await loadCredentialVaultKeyRing(keys);
  if (!keyRing.ok) throw new Error("root fixture keyring invalid");
  const root = vaultRootForVersion(keyRing.value, keyVersion);
  if (!root.ok) throw new Error("root fixture version unavailable");
  const handle = requireVaultHandle(rawHandle);
  const encrypted = await encryptVaultPayload({
    key: root.value.key,
    organisationId: fixture.organisationId,
    handle,
    keyVersion,
    plaintext: new TextEncoder().encode(
      '{"kind":"bearer","value":"fixture","header":null}',
    ),
  });
  insertRawVaultRow(
    fixture,
    keyVersion,
    handle,
    encrypted.nonceB64,
    encrypted.ciphertextB64,
    revokedAt,
  );
}

function insertRawVaultRow(
  fixture: RootClosureFixture,
  keyVersion: VaultKeyVersion,
  handle: VaultHandle | string,
  nonceB64: string,
  ciphertextB64: string,
  revokedAt: number | null,
): void {
  fixture.sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (?, ?, ?, 'AES-GCM-256', ?, ?, 1, NULL, ?)`,
    )
    .run(
      fixture.organisationId,
      handle,
      keyVersion,
      nonceB64,
      ciphertextB64,
      revokedAt,
    );
}

function credentialVaultKeys(includeV2: boolean): CredentialVaultBindings {
  return includeV2
    ? {
        PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
        VAULT_ROOT_V1: testRoot(1),
        VAULT_ROOT_V2: testRoot(2),
      }
    : {
        PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
        VAULT_ROOT_V1: testRoot(1),
      };
}

function fakeExecutionContext(): ExecutionContext {
  return testExecutionContext({ waitUntil: vi.fn() });
}
