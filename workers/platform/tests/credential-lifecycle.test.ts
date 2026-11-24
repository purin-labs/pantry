import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { revokeCredential } from "@purin-labs/authority/credential-vault/index";
import {
  authorizeCredentialRevocation,
  beginCredentialRotation,
  commitCredentialRotation,
  listCredentialInventory,
  markCredentialRotationFailed,
  markCredentialRotationVerified,
  recordCredentialRevocationMutation,
} from "@purin-labs/area-integrations-contract/server/credential-lifecycle";
import type { IntegrationProvider } from "@purin-labs/connections/data/integration-account";
import { d1Database } from "./sqlite-d1";
import {
  requireUserId,
  requireIntegrationAccountId,
  requireOrganisationId,
  requireVaultHandle,
} from "./test-ids";

const ORGANISATION = "organisation_credential_lifecycle";
const HANDLE = "vault:stripe:lifecycle-test";
const REPLACEMENT_HANDLE =
  "vault:organisation_credential_lifecycle:rotation:rotate-1";

describe("Credential lifecycle", credentialLifecycleSuite);

function credentialLifecycleSuite(): void {
  it("lists a metadata-only generation inventory", listsInventory);
  it(
    "lists an inventory for every provider an account may be stored as",
    listsInventoryForEveryProvider,
  );
  it(
    "rejects a noncanonical persisted webhook association identity",
    rejectsMalformedInventoryIdentity,
  );
  it(
    "requires a replacement before revoking the default account credential",
    guardsDefaultAccountRevocation,
  );
  it(
    "records the revocation mutation with receipt and audit evidence",
    recordsRevocation,
  );
  it(
    "walks a supplied-credential rotation to committed exactly once",
    rotatesOnce,
  );
  it(
    "keeps a failed rotation terminal and conflicts on id reuse",
    failsRotation,
  );
}

async function listsInventoryForEveryProvider(): Promise<void> {
  const declared: Readonly<Record<IntegrationProvider, true>> = {
    airtable: true,
    discord: true,
    dropbox: true,
    gmail: true,
    gmo_aozora: true,
    google_drive: true,
    notion: true,
    shopify: true,
    slack: true,
    square: true,
    stripe: true,
    whatsapp: true,
    wise: true,
  };
  for (const provider of Object.keys(declared) as IntegrationProvider[]) {
    const sqlite = migratedDatabase();
    const db = d1Database(sqlite);
    const organisationId = requireOrganisationId(ORGANISATION);
    seedCredentialGraph(sqlite, ORGANISATION, HANDLE);
    sqlite.prepare("UPDATE integration_account SET provider = ?").run(provider);

    const inventory = await listCredentialInventory({ db, organisationId });
    if (!inventory.ok) {
      throw new Error(`${provider}: ${inventory.error.code}`);
    }
    expect(inventory.value.accounts[0]?.provider, provider).toBe(provider);
    sqlite.close();
  }
}

async function listsInventory(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId(ORGANISATION);
  seedCredentialGraph(sqlite, ORGANISATION, HANDLE);

  const inventory = await listCredentialInventory({ db, organisationId });
  if (!inventory.ok) {
    throw new Error(inventory.error.code);
  }
  expect(inventory.value.accounts).toHaveLength(1);
  const account = inventory.value.accounts[0]!;
  expect(account).toMatchObject({
    integrationAccountId: "account_lifecycle_test",
    provider: "stripe",
    environment: "development",
    lifecycle: "active",
    isDefaultForProvider: true,
    connection: {
      providerConnectionId: "connection_lifecycle_test",
      lifecycle: "active",
      authMode: "api_key",
      activeGeneration: 1,
    },
    revocation: null,
    rotations: [],
  });
  expect(account.generations).toEqual([
    {
      credentialGeneration: 1,
      lifecycle: "active",
      failureCode: null,
      createdAt: 1,
      activatedAt: 1,
      supersededAt: null,
      revokedAt: null,
      vault: {
        status: "active",
        keyVersion: "v1",
        storedAt: 1,
        rotatedAt: null,
        revokedAt: null,
      },
    },
  ]);
  expect(account.webhooks).toEqual([
    {
      lifecycle: "live",
      eventType: "charge.failed",
      credentialGeneration: 1,
      lastVerifiedAt: 1,
    },
  ]);
  expect(JSON.stringify(inventory.value)).not.toContain("ciphertext");
  expect(JSON.stringify(inventory.value)).not.toContain("nonce");
}

async function rejectsMalformedInventoryIdentity(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId(ORGANISATION);
  seedCredentialGraph(sqlite, ORGANISATION, HANDLE);
  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite
    .prepare(
      "UPDATE provider_webhook SET integration_account_id = ? WHERE integration_account_id = ?",
    )
    .run(" account_lifecycle_test ", "account_lifecycle_test");
  sqlite.exec("PRAGMA foreign_keys = ON");

  await expect(listCredentialInventory({ db, organisationId })).resolves.toEqual({
    ok: false,
    error: { code: "credential_inventory_row_invalid" },
  });
}

async function guardsDefaultAccountRevocation(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId(ORGANISATION);
  seedCredentialGraph(sqlite, ORGANISATION, HANDLE);

  const withoutReplacement = await authorizeCredentialRevocation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    replacementIntegrationAccountId: null,
    expectedConfigurationVersion: 1,
  });
  expect(withoutReplacement).toEqual({
    ok: false,
    error: { code: "default_account_replacement_required" },
  });

  const staleVersion = await authorizeCredentialRevocation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    replacementIntegrationAccountId: null,
    expectedConfigurationVersion: 7,
  });
  expect(staleVersion).toEqual({
    ok: false,
    error: { code: "configuration_version_conflict" },
  });

  seedReplacementAccount(sqlite, ORGANISATION);
  const authorized = await authorizeCredentialRevocation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    replacementIntegrationAccountId: requireIntegrationAccountId(
      "account_lifecycle_replacement",
    ),
    expectedConfigurationVersion: 1,
  });
  if (!authorized.ok) {
    throw new Error(authorized.error.code);
  }
  expect(authorized.value.handle).toBe(HANDLE);
  expect(authorized.value.configurationVersion).toBe(2);
}

async function recordsRevocation(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId(ORGANISATION);
  seedCredentialGraph(sqlite, ORGANISATION, HANDLE);
  seedReplacementAccount(sqlite, ORGANISATION);

  const authorized = await authorizeCredentialRevocation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    replacementIntegrationAccountId: requireIntegrationAccountId(
      "account_lifecycle_replacement",
    ),
    expectedConfigurationVersion: 1,
  });
  if (!authorized.ok) {
    throw new Error(authorized.error.code);
  }
  const committed = await revokeCredential({
    db,
    organisationId,
    handle: requireVaultHandle(HANDLE),
    now: 5_000,
  });
  expect(committed.state).toBe("committed");
  await recordCredentialRevocationMutation({
    db,
    organisationId,
    authorization: authorized.value,
    mutation: testMutation("provider.credential.revoke", "revoke-1"),
    actorUserId: requireUserId("user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5"),
    receiptBody: { receipt_id: "revocation_receipt", organisation_id: ORGANISATION },
    now: 5_100,
  });

  const audit = sqlite
    .prepare(
      `SELECT operation, target_id AS targetId, reason_code AS reasonCode
     FROM onboarding_audit_event WHERE organisation_id = ?`,
    )
    .get(ORGANISATION) as { operation: string; targetId: string; reasonCode: string };
  expect(audit).toEqual({
    operation: "provider.credential.revoke",
    targetId: "connection_lifecycle_test",
    reasonCode: "credential_revoked",
  });
  const onboarding = sqlite
    .prepare(
      `SELECT configuration_version AS configurationVersion FROM organisation_onboarding
     WHERE organisation_id = ?`,
    )
    .get(ORGANISATION) as { configurationVersion: number };
  expect(onboarding.configurationVersion).toBe(2);
  const defaultAccount = sqlite
    .prepare(
      `SELECT integration_account_id AS accountId FROM integration_account
     WHERE organisation_id = ? AND is_default_for_provider = 1`,
    )
    .get(ORGANISATION) as { accountId: string };
  expect(defaultAccount.accountId).toBe("account_lifecycle_replacement");

  const inventory = await listCredentialInventory({ db, organisationId });
  if (!inventory.ok) {
    throw new Error(inventory.error.code);
  }
  const revoked = inventory.value.accounts.find(
    (account) => account.integrationAccountId === "account_lifecycle_test",
  );
  expect(revoked?.revocation).toMatchObject({
    state: "committed",
    committedAt: 5_000,
  });
}

async function rotatesOnce(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId(ORGANISATION);
  seedCredentialGraph(sqlite, ORGANISATION, HANDLE);

  const rotation = await beginCredentialRotation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    credentialRotationId: "rotation_lifecycle_1",
    replacementHandle: requireVaultHandle(REPLACEMENT_HANDLE),
    createdByUserId: requireUserId(
      "user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5",
    ),
    expectedConfigurationVersion: 1,
    now: 9_000,
  });
  if (!rotation.ok) {
    throw new Error(rotation.error.code);
  }
  expect(rotation.value.resumedStatus).toBeNull();

  await markCredentialRotationVerified({
    db,
    organisationId,
    credentialRotationId: "rotation_lifecycle_1",
    now: 9_100,
  });
  await commitCredentialRotation({
    db,
    organisationId,
    rotation: rotation.value,
    mutation: testMutation("provider.credential.rotate_supplied", "rotate-1"),
    actorUserId: requireUserId("user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5"),
    receiptBody: { receipt_id: "rotation_lifecycle_1", organisation_id: ORGANISATION },
    now: 9_200,
  });

  const generations = sqlite
    .prepare(
      `SELECT credential_generation AS generation, lifecycle, credential_ref AS ref
     FROM provider_credential_generation
     WHERE provider_connection_id = 'connection_lifecycle_test'
     ORDER BY credential_generation`,
    )
    .all() as unknown as readonly {
    generation: number;
    lifecycle: string;
    ref: string;
  }[];
  expect(generations).toEqual([
    { generation: 1, lifecycle: "superseded", ref: HANDLE },
    { generation: 2, lifecycle: "active", ref: REPLACEMENT_HANDLE },
  ]);
  const connection = sqlite
    .prepare(
      `SELECT credential_generation AS generation, credential_ref AS ref
     FROM provider_connection
     WHERE provider_connection_id = 'connection_lifecycle_test'`,
    )
    .get() as { generation: number; ref: string };
  expect(connection).toEqual({ generation: 2, ref: REPLACEMENT_HANDLE });
  const rotationRow = sqlite
    .prepare(
      `SELECT status, committed_at AS committedAt FROM credential_rotation
     WHERE credential_rotation_id = 'rotation_lifecycle_1'`,
    )
    .get() as { status: string; committedAt: number };
  expect(rotationRow).toEqual({ status: "committed", committedAt: 9_200 });

  const resumed = await beginCredentialRotation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    credentialRotationId: "rotation_lifecycle_1",
    replacementHandle: requireVaultHandle(REPLACEMENT_HANDLE),
    createdByUserId: requireUserId(
      "user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5",
    ),
    expectedConfigurationVersion: 2,
    now: 9_300,
  });
  if (!resumed.ok) {
    throw new Error(resumed.error.code);
  }
  expect(resumed.value.resumedStatus).toBe("committed");
}

async function failsRotation(): Promise<void> {
  const sqlite = migratedDatabase();
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId(ORGANISATION);
  seedCredentialGraph(sqlite, ORGANISATION, HANDLE);

  const rotation = await beginCredentialRotation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    credentialRotationId: "rotation_lifecycle_failed",
    replacementHandle: requireVaultHandle(REPLACEMENT_HANDLE),
    createdByUserId: requireUserId(
      "user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5",
    ),
    expectedConfigurationVersion: 1,
    now: 9_000,
  });
  if (!rotation.ok) {
    throw new Error(rotation.error.code);
  }
  await markCredentialRotationFailed({
    db,
    organisationId,
    credentialRotationId: "rotation_lifecycle_failed",
    failureCode: "replacement_validation_failed",
  });

  const row = sqlite
    .prepare(
      `SELECT status, failure_code AS failureCode FROM credential_rotation
     WHERE credential_rotation_id = 'rotation_lifecycle_failed'`,
    )
    .get() as { status: string; failureCode: string };
  expect(row).toEqual({
    status: "failed",
    failureCode: "replacement_validation_failed",
  });

  const generations = sqlite
    .prepare(
      `SELECT COUNT(*) AS generationCount FROM provider_credential_generation
     WHERE provider_connection_id = 'connection_lifecycle_test'`,
    )
    .get() as { generationCount: number };
  expect(generations.generationCount).toBe(1);

  const reused = await beginCredentialRotation({
    db,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("account_lifecycle_test"),
    credentialRotationId: "rotation_lifecycle_failed",
    replacementHandle: requireVaultHandle(REPLACEMENT_HANDLE),
    createdByUserId: requireUserId(
      "user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5",
    ),
    expectedConfigurationVersion: 1,
    now: 9_400,
  });
  expect(reused).toEqual({
    ok: false,
    error: { code: "credential_rotation_conflict" },
  });
}

function testMutation(operation: string, idempotencyKey: string) {
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey: `lifecycle-${idempotencyKey}`,
      requestHash: `hash-${idempotencyKey}`,
      expectedConfigurationVersion: 1,
    },
    scope: {
      userId: requireUserId("user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5"),
      organisationScope: ORGANISATION,
      route: `/v1/control/organisations/${ORGANISATION}/test`,
      operation,
    },
    identity: {
      receiptId: `receipt_${idempotencyKey}`,
      auditEventId: `audit_${idempotencyKey}`,
      correlationId: `correlation_${idempotencyKey}`,
      causationId: `causation_${idempotencyKey}`,
      portalSubjectHash: "subject-hash",
      createdAt: 1_000,
    },
  };
}

function seedCredentialGraph(
  sqlite: DatabaseSync,
  organisationId: string,
  handle: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Lifecycle Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  sqlite.exec(`
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES (
      'user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5', 'urn:pantry:test', 'lifecycle-test',
      'lifecycle-test@example.invalid', 'Lifecycle Test', 1, 1, 1
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
       1, 1, NULL, NULL, 'activation_lifecycle_test', 1,
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
       'connection_lifecycle_test', ?, 'stripe', 'api_key', 'connection_credential', 1,
       ?, 'active', '["read_write"]', 'user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5',
       1, 1, NULL, NULL, 'development', 'acct_lifecycle_test'
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
       'connection_lifecycle_test', 1, ?, 'stripe',
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
       'account_lifecycle_test', ?, 'connection_lifecycle_test', 'stripe',
       'acct_lifecycle_test', 'account', 'Lifecycle Test', 'active',
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
       'webhook_lifecycle_test', ?, 'account_lifecycle_test', 'stripe',
       'endpoint_lifecycle_test', 'charge.failed', 'live', NULL,
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
       ?, 'stripe', 'lifecycle-test', ?, 'api.stripe.com',
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

function seedReplacementAccount(sqlite: DatabaseSync, organisationId: string): void {
  sqlite
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation,
       credential_ref, lifecycle, granted_scopes, created_by_user_id,
       created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id
     ) VALUES (
       'connection_lifecycle_replacement', ?, 'stripe', 'api_key', 'connection_credential', 1,
       'vault:stripe:lifecycle-replacement', 'active', '[]', 'user_cb0beed4-2b29-52c1-a1f0-92f0a406a3b5',
       1, 1, NULL, NULL, 'development', 'acct_lifecycle_replacement'
     )`,
    )
    .run(organisationId);
  sqlite
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, disabled_by_user_id, disabled_at,
       revoked_at, environment, is_default_for_provider
     ) VALUES (
       'account_lifecycle_replacement', ?, 'connection_lifecycle_replacement', 'stripe',
       'acct_lifecycle_replacement', 'account', 'Lifecycle Replacement', 'active',
       NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
       1, 1, NULL, NULL, NULL, 'development', 0
     )`,
    )
    .run(organisationId);
  sqlite
    .prepare(
      `INSERT INTO provider_credential_generation (
       provider_connection_id, credential_generation, organisation_id, provider,
       environment, credential_ref, lifecycle, created_at, activated_at,
       superseded_at, revoked_at, failed_at, failure_code
     ) VALUES (
       'connection_lifecycle_replacement', 1, ?, 'stripe',
       'development', 'vault:stripe:lifecycle-replacement', 'active', 1, 1,
       NULL, NULL, NULL, NULL
     )`,
    )
    .run(organisationId);
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(singleDatabaseSchema());
  return database;
}
