/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { describe, expect, it } from "vitest";

import {
  resolveVaultHandle,
  storeVaultSecret,
} from "../src/credential-vault/service";
import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import { type OrganisationId } from "../src/ids";
import { type VaultHandle } from "../src/credential-vault/domain";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { testRoot } from "./secrets-store";
/**
 * Plan 13 C3-08 — restore behaviour when a Vault root version is unavailable.
 *
 * A restored account, or an account whose roots were rotated, can hold vault
 * rows whose `key_version` names a root the current environment does not bind.
 * These cases prove that resolution then fails closed: no fallback to another
 * root, no plaintext, and a typed error rather than a throw.
 *
 * `credential-vault-keyring.test.ts` covers the keyring primitive directly.
 * This file covers the resolution path a restored organisation actually travels.
 */
describe(
  "Credential Vault restore with an unavailable root",
  vaultRootRestoreSuite,
);

const NOW = 1_780_000_000_000;
const ORGANISATION = "organisation_vault_root_restore";
const HANDLE = "vault:test:restore:bearer";
const SECRET_VALUE = "restored-bearer-value";

function vaultRootRestoreSuite(): void {
  it("resolves while the storing root is still bound", resolvesWithStoringRoot);
  it(
    "fails closed when the storing root version is no longer bound",
    failsClosedWithoutStoringRoot,
  );
  it(
    "never falls back to another readable root version",
    neverFallsBackToAnotherRoot,
  );
  it(
    "fails closed when no active root is bound at all",
    failsClosedWithoutActiveRoot,
  );
  it(
    "fails closed when the root version is bound with different material",
    failsClosedOnRootMaterialMismatch,
  );
}

async function resolvesWithStoringRoot(): Promise<void> {
  const fixture = await seedSecretUnderV1();

  const resolved = await resolveVaultHandle({
    db: fixture.db,
    keys: fixture.storingKeys,
    organisationId: fixture.organisationId,
    handle: fixture.handle,
  });

  expect(resolved).toEqual({
    ok: true,
    value: { kind: "bearer", value: SECRET_VALUE },
  });
}

async function failsClosedWithoutStoringRoot(): Promise<void> {
  const fixture = await seedSecretUnderV1();

  const resolved = await resolveVaultHandle({
    db: fixture.db,
    keys: {
      SATYR_VAULT_ACTIVE_KEY_VERSION: "v2",
      VAULT_ROOT_V2: testRoot(22),
    },
    organisationId: fixture.organisationId,
    handle: fixture.handle,
  });

  expect(resolved).toEqual({
    ok: false,
    error: { code: "vault_root_unavailable" },
  });
}

async function neverFallsBackToAnotherRoot(): Promise<void> {
  const fixture = await seedSecretUnderV1();

  // v2 is active and readable, but the row was sealed under v1. A fallback to
  // v2 would either surface the wrong plaintext or a decrypt failure; neither
  // is acceptable, so the version guard must reject before any decrypt.
  const resolved = await resolveVaultHandle({
    db: fixture.db,
    keys: {
      SATYR_VAULT_ACTIVE_KEY_VERSION: "v2",
      VAULT_ROOT_V2: testRoot(22),
    },
    organisationId: fixture.organisationId,
    handle: fixture.handle,
  });

  expect(resolved.ok).toBe(false);

  if (resolved.ok) {
    return;
  }

  expect(resolved.error.code).toBe("vault_root_unavailable");
  expect(JSON.stringify(resolved.error)).not.toContain(SECRET_VALUE);
}

async function failsClosedWithoutActiveRoot(): Promise<void> {
  const fixture = await seedSecretUnderV1();

  const resolved = await resolveVaultHandle({
    db: fixture.db,
    keys: { SATYR_VAULT_ACTIVE_KEY_VERSION: "v1" },
    organisationId: fixture.organisationId,
    handle: fixture.handle,
  });

  expect(resolved).toEqual({
    ok: false,
    error: { code: "vault_root_invalid" },
  });
}

async function failsClosedOnRootMaterialMismatch(): Promise<void> {
  const fixture = await seedSecretUnderV1();

  // The right version label bound to the wrong bytes: a restore that recreated
  // v1 from the wrong source. AES-GCM authentication must reject it.
  const resolved = await resolveVaultHandle({
    db: fixture.db,
    keys: {
      SATYR_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: testRoot(99),
    },
    organisationId: fixture.organisationId,
    handle: fixture.handle,
  });

  expect(resolved.ok).toBe(false);

  if (resolved.ok) {
    return;
  }

  expect(resolved.error.code).toBe("vault_ciphertext_invalid");
  expect(JSON.stringify(resolved.error)).not.toContain(SECRET_VALUE);
}

type RestoreFixture = {
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly storingKeys: CredentialVaultBindings;
};

async function seedSecretUnderV1(): Promise<RestoreFixture> {
  const db = createMigratedDatabase();
  const organisationId = requireOrganisationId(ORGANISATION);
  const handle = requireVaultHandle(HANDLE);
  const storingKeys: CredentialVaultBindings = {
    SATYR_VAULT_ACTIVE_KEY_VERSION: "v1",
    VAULT_ROOT_V1: testRoot(11),
  };

  await insertOrganisation(db, organisationId);

  const stored = await storeVaultSecret({
    db,
    keys: storingKeys,
    organisationId,
    handle,
    secret: { kind: "bearer", value: SECRET_VALUE },
    now: NOW,
  });

  if (!stored.ok) {
    throw new Error(stored.error.code);
  }

  return { db, organisationId, handle, storingKeys };
}

async function insertOrganisation(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Vault Root Restore', 'beta', ?, 'active')`,
    )
    .bind(organisationId, NOW)
    .run();
}
