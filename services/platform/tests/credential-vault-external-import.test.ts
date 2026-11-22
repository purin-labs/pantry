import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createOnePasswordAdapter,
  importExternalVaultSecret,
  storeVaultSecret,
  type ExternalVaultAdapter,
  type VaultHandle,
  type VaultSecret,
} from "../src/credential-vault";
import { resolveVaultHandle } from "../src/credential-vault/service";
import type { CredentialVaultBindings } from "../src/credential-vault/keyring";
import { type OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";

describe("external Credential Vault imports", externalVaultImportSuite);

function externalVaultImportSuite(): void {
  it("is idempotent for the same external revision", importsRevisionOnce);
  it(
    "requires a new handle for a changed secret revision",
    rejectsReusedGenerationHandle,
  );
  it(
    "preserves the active secret when validation fails",
    preservesActiveSecret,
  );
  it("revokes only an authenticated tombstone", importsAuthenticatedTombstone);
  it(
    "resolves from Purin Vault while the adapter is unavailable",
    resolvesDuringOutage,
  );
}

async function rejectsReusedGenerationHandle(): Promise<void> {
  const fixture = createFixture();
  await importSecret(
    fixture,
    onePasswordAdapter(activeItemFetcher),
    acceptSecret,
    10,
  );

  await expect(
    importSecret(
      fixture,
      onePasswordAdapter(changedItemFetcher),
      acceptSecret,
      20,
    ),
  ).resolves.toEqual({
    ok: false,
    error: { code: "external_vault_generation_handle_reused" },
  });
  await expect(resolveSecret(fixture)).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "imported-secret" },
  });
}

async function importsRevisionOnce(): Promise<void> {
  const fixture = createFixture();
  const adapter = onePasswordAdapter(activeItemFetcher);

  const first = await importSecret(fixture, adapter, acceptSecret, 10);
  const second = await importSecret(fixture, adapter, acceptSecret, 20);

  expect(first).toMatchObject({
    ok: true,
    value: { revision: "7", state: "active", importedAt: 10 },
  });
  expect(second).toEqual(first);
  expect(
    fixture.sqlite
      .prepare("SELECT COUNT(*) AS count FROM external_vault_import")
      .get(),
  ).toEqual({ count: 1 });
}

async function preservesActiveSecret(): Promise<void> {
  const fixture = createFixture();
  await storeSecret(fixture, "previous-secret", 1);

  await expect(
    importSecret(
      fixture,
      onePasswordAdapter(activeItemFetcher),
      rejectSecret,
      10,
    ),
  ).resolves.toEqual({
    ok: false,
    error: { code: "external_vault_validation_failed" },
  });
  await expect(resolveSecret(fixture)).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "previous-secret" },
  });
  expect(
    fixture.sqlite
      .prepare("SELECT COUNT(*) AS count FROM external_vault_import")
      .get(),
  ).toEqual({ count: 0 });
}

async function importsAuthenticatedTombstone(): Promise<void> {
  const fixture = createFixture();
  await importSecret(
    fixture,
    onePasswordAdapter(activeItemFetcher),
    acceptSecret,
    10,
  );

  await expect(
    importSecret(
      fixture,
      onePasswordAdapter(archivedItemFetcher),
      acceptSecret,
      20,
    ),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      revision: "8",
      state: "revoked",
      activatedAt: null,
      revokedAt: 20,
    },
  });
  await expect(resolveSecret(fixture)).resolves.toEqual({
    ok: false,
    error: { code: "vault_secret_revoked", handle: fixture.handle },
  });
}

async function resolvesDuringOutage(): Promise<void> {
  const fixture = createFixture();
  await importSecret(
    fixture,
    onePasswordAdapter(activeItemFetcher),
    acceptSecret,
    10,
  );

  await expect(
    importSecret(fixture, onePasswordAdapter(outageFetcher), acceptSecret, 20),
  ).resolves.toEqual({
    ok: false,
    error: { code: "external_vault_unavailable" },
  });
  await expect(resolveSecret(fixture)).resolves.toEqual({
    ok: true,
    value: { kind: "bearer", value: "imported-secret" },
  });
}

function importSecret(
  fixture: Fixture,
  adapter: ExternalVaultAdapter,
  validate: (
    secret: VaultSecret,
  ) => Promise<
    Result<true, { readonly code: "external_vault_validation_failed" }>
  >,
  now: number,
) {
  return importExternalVaultSecret({
    db: fixture.db,
    keys: fixture.keys,
    organisationId: fixture.organisationId,
    handle: fixture.handle,
    adapter,
    validate,
    now,
  });
}

function resolveSecret(fixture: Fixture) {
  return resolveVaultHandle({
    db: fixture.db,
    keys: fixture.keys,
    organisationId: fixture.organisationId,
    handle: fixture.handle,
  });
}

async function storeSecret(
  fixture: Fixture,
  value: string,
  now: number,
): Promise<void> {
  const stored = await storeVaultSecret({
    db: fixture.db,
    keys: fixture.keys,
    organisationId: fixture.organisationId,
    handle: fixture.handle,
    secret: { kind: "bearer", value },
    now,
  });

  if (!stored.ok) {
    throw new Error(stored.error.code);
  }
}

async function acceptSecret(): Promise<Result<true, never>> {
  return { ok: true, value: true };
}

async function rejectSecret(): Promise<
  Result<true, { readonly code: "external_vault_validation_failed" }>
> {
  return { ok: false, error: { code: "external_vault_validation_failed" } };
}

function onePasswordAdapter(fetcher: typeof fetch): ExternalVaultAdapter {
  return createOnePasswordAdapter({
    config: { origin: "https://onepassword.test", token: "service-token" },
    locator: { vaultId: "vault-id", itemId: "item-id", fieldId: "credential" },
    fetcher,
  });
}

async function activeItemFetcher(): Promise<Response> {
  return Response.json({
    id: "item-id",
    version: 7,
    state: "ACTIVE",
    fields: [{ id: "credential", value: "imported-secret" }],
  });
}

async function archivedItemFetcher(): Promise<Response> {
  return Response.json({
    id: "item-id",
    version: 8,
    state: "ARCHIVED",
    fields: [],
  });
}

async function changedItemFetcher(): Promise<Response> {
  return Response.json({
    id: "item-id",
    version: 8,
    state: "ACTIVE",
    fields: [{ id: "credential", value: "changed-secret" }],
  });
}

async function outageFetcher(): Promise<Response> {
  throw new Error("offline");
}

type Fixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly keys: CredentialVaultBindings;
};

function createFixture(): Fixture {
  const sqlite = new DatabaseSync(":memory:");

  sqlite.exec(singleDatabaseSchema());

  const organisationId = requireOrganisationId("organisation_external_vault");
  const handle = requireVaultHandle("vault:test:external:credential");
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'External Vault Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);

  return {
    sqlite,
    db: d1Database(sqlite),
    organisationId,
    handle,
    keys: {
      PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
      VAULT_ROOT_V1: testRoot(),
    },
  };
}

class TestSecretsStoreSecret {
  async get(): Promise<string> {
    const bytes = new Uint8Array(32);
    bytes.fill(17);
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }
}

function testRoot(): SecretsStoreSecret {
  return new TestSecretsStoreSecret() as unknown as SecretsStoreSecret;
}
