import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  auditCredentialClosure,
  type CredentialClosureFinding,
} from "../src/credential-vault/closure-audit";
import { d1Database } from "./sqlite-d1";
const ORGANISATION_ID = "organisation_credential_closure";
const PROVIDER_HANDLE = "vault:test:closure:provider";
const EXTERNAL_HANDLE = "vault:test:closure:external";
const STORED_REFERENCE_HANDLE = "vault:test:closure:stored-reference";
const DISCORD_VERIFIER_HANDLE = "vault:test:closure:discord-verifier";

describe("one-time credential closure audit", credentialClosureAuditSuite);

function credentialClosureAuditSuite(): void {
  it(
    "reports every active reference whose Vault row is missing",
    reportsMissingRows,
  );
  it(
    "reports revoked Vault rows without exposing stored secret material",
    reportsRevokedRows,
  );
  it("audits active standalone verifier references", reportsStandaloneVerifier);
  it(
    "reports invalid active handles without echoing their raw value",
    reportsInvalidHandle,
  );
  it(
    "does not infer Actor policy authority from D1 snapshot order",
    ignoresPolicySnapshotOrder,
  );
  it("passes when every active reference has a live Vault row", passesLiveRows);
}

async function reportsMissingRows(): Promise<void> {
  const fixture = createFixture();
  seedActiveProviderGeneration(fixture.sqlite);
  seedActiveExternalImport(fixture.sqlite);
  seedActiveCredentialReference(fixture.sqlite, STORED_REFERENCE_HANDLE);

  await expect(auditCredentialClosure(fixture.db)).resolves.toEqual({
    status: "failed",
    summary: {
      activeProviderGenerationIssues: 1,
      activeExternalImportIssues: 1,
      activeStoredRefIssues: 1,
      totalIssues: 3,
    },
    findings: [
      {
        kind: "active_provider_generation_without_live_vault",
        organisationId: ORGANISATION_ID,
        providerConnectionId: "connection_credential_closure",
        credentialGeneration: 1,
        provider: "stripe",
        environment: "development",
        vaultHandle: PROVIDER_HANDLE,
        vaultIssue: "missing",
      },
      {
        kind: "active_external_import_without_live_vault",
        organisationId: ORGANISATION_ID,
        sourceKind: "onepassword",
        vaultHandle: EXTERNAL_HANDLE,
        vaultIssue: "missing",
      },
      {
        kind: "active_stored_ref_without_live_vault",
        organisationId: ORGANISATION_ID,
        referenceKind: "credential_ref",
        referenceId: "github:admin",
        vaultHandle: STORED_REFERENCE_HANDLE,
        vaultIssue: "missing",
      },
    ],
  });
}

async function reportsRevokedRows(): Promise<void> {
  const fixture = createFixture();
  seedActiveProviderGeneration(fixture.sqlite);
  seedActiveExternalImport(fixture.sqlite);
  seedActiveCredentialReference(fixture.sqlite, STORED_REFERENCE_HANDLE);
  seedVaultSecret(fixture.sqlite, PROVIDER_HANDLE, 20);
  seedVaultSecret(fixture.sqlite, EXTERNAL_HANDLE, 20);
  seedVaultSecret(fixture.sqlite, STORED_REFERENCE_HANDLE, 20);

  const result = await auditCredentialClosure(fixture.db);
  expect(result.status).toBe("failed");
  expect(result.findings).toHaveLength(3);
  expect(result.findings.map(readVaultIssue)).toEqual([
    "revoked",
    "revoked",
    "revoked",
  ]);

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("closure-secret-material");
  expect(serialized).not.toContain("ciphertext");
  expect(serialized).not.toContain("nonce");
}

async function passesLiveRows(): Promise<void> {
  const fixture = createFixture();
  seedActiveProviderGeneration(fixture.sqlite);
  seedActiveExternalImport(fixture.sqlite);
  seedActiveCredentialReference(fixture.sqlite, STORED_REFERENCE_HANDLE);
  seedVaultSecret(fixture.sqlite, PROVIDER_HANDLE, null);
  seedVaultSecret(fixture.sqlite, EXTERNAL_HANDLE, null);
  seedVaultSecret(fixture.sqlite, STORED_REFERENCE_HANDLE, null);

  await expect(auditCredentialClosure(fixture.db)).resolves.toEqual({
    status: "passed",
    summary: {
      activeProviderGenerationIssues: 0,
      activeExternalImportIssues: 0,
      activeStoredRefIssues: 0,
      totalIssues: 0,
    },
    findings: [],
  });
}

async function reportsStandaloneVerifier(): Promise<void> {
  const fixture = createFixture();
  fixture.sqlite
    .prepare(
      `INSERT INTO discord_interaction_install (
       organisation_id, application_id, guild_id, public_key_ref, status, installed_at
     ) VALUES (?, 'discord_application_closure', 'discord_guild_closure', ?, 'active', 1)`,
    )
    .run(ORGANISATION_ID, DISCORD_VERIFIER_HANDLE);

  await expect(auditCredentialClosure(fixture.db)).resolves.toEqual({
    status: "failed",
    summary: {
      activeProviderGenerationIssues: 0,
      activeExternalImportIssues: 0,
      activeStoredRefIssues: 1,
      totalIssues: 1,
    },
    findings: [
      {
        kind: "active_stored_ref_without_live_vault",
        organisationId: ORGANISATION_ID,
        referenceKind: "discord_interaction_install",
        referenceId: "discord_application_closure",
        vaultHandle: DISCORD_VERIFIER_HANDLE,
        vaultIssue: "missing",
      },
    ],
  });
}

async function reportsInvalidHandle(): Promise<void> {
  const fixture = createFixture();
  seedActiveProviderGeneration(
    fixture.sqlite,
    "legacy-environment-secret-name",
  );

  const result = await auditCredentialClosure(fixture.db);
  expect(result).toEqual({
    status: "failed",
    summary: {
      activeProviderGenerationIssues: 1,
      activeExternalImportIssues: 0,
      activeStoredRefIssues: 0,
      totalIssues: 1,
    },
    findings: [
      {
        kind: "active_provider_generation_with_invalid_vault_handle",
        organisationId: ORGANISATION_ID,
        providerConnectionId: "connection_credential_closure",
        credentialGeneration: 1,
        provider: "stripe",
        environment: "development",
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(
    "legacy-environment-secret-name",
  );
}

async function ignoresPolicySnapshotOrder(): Promise<void> {
  const fixture = createFixture();
  seedPolicySnapshot(fixture.sqlite, 1, "vault:test:closure:actor-active");
  seedPolicySnapshot(
    fixture.sqlite,
    2,
    "vault:test:closure:numerically-latest",
  );

  await expect(auditCredentialClosure(fixture.db)).resolves.toEqual({
    status: "passed",
    summary: {
      activeProviderGenerationIssues: 0,
      activeExternalImportIssues: 0,
      activeStoredRefIssues: 0,
      totalIssues: 0,
    },
    findings: [],
  });
}

function seedActiveCredentialReference(
  sqlite: DatabaseSync,
  vaultHandle: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO credential_ref (
       organisation_id, provider, name, vault_handle, host_pattern,
       inject_as, created_at, revoked_at
     ) VALUES (?, 'github', 'admin', ?, 'api.github.com',
       '{"kind":"header","header":"authorization","scheme":"Bearer"}',
       1, NULL)`,
    )
    .run(ORGANISATION_ID, vaultHandle);
}

function readVaultIssue(finding: CredentialClosureFinding): string {
  return "vaultIssue" in finding ? finding.vaultIssue : "invalid_vault_handle";
}

function seedActiveProviderGeneration(
  sqlite: DatabaseSync,
  credentialRef: string = PROVIDER_HANDLE,
): void {
  sqlite
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES (
       'control_credential_closure', 'https://accounts.google.com',
       'credential-closure', 'credential-closure@example.com',
       'Credential Closure', 1, 1, 1
     )`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at,
       disabled_at, revoked_at, environment, provider_subject_id
     ) VALUES (
       'connection_credential_closure', ?, 'stripe', 'api_key', 'connection_credential',
       1, ?, 'active', '["read"]', 'control_credential_closure',
       1, 1, NULL, NULL, 'development', 'acct_closure'
     )`,
    )
    .run(ORGANISATION_ID, credentialRef);
  sqlite
    .prepare(
      `INSERT INTO provider_credential_generation (
       provider_connection_id, credential_generation, organisation_id, provider,
       environment, credential_ref, lifecycle, created_at, activated_at,
       superseded_at, revoked_at, failed_at, failure_code
     ) VALUES (
       'connection_credential_closure', 1, ?, 'stripe', 'development',
       ?, 'active', 1, 1, NULL, NULL, NULL, NULL
     )`,
    )
    .run(ORGANISATION_ID, credentialRef);
}

function seedActiveExternalImport(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      `INSERT INTO external_vault_import (
       organisation_id, vault_handle, source_kind, source_locator,
       external_revision, state, imported_at, activated_at, revoked_at
     ) VALUES (?, ?, 'onepassword', 'vault/item/field', 'revision-1',
       'active', 1, 1, NULL)`,
    )
    .run(ORGANISATION_ID, EXTERNAL_HANDLE);
}

function seedPolicySnapshot(
  sqlite: DatabaseSync,
  version: number,
  vaultHandle: string,
): void {
  const body = {
    version,
    egress: {
      allowedHosts: ["api.stripe.com"],
      injections: [
        {
          ruleId: "rule-closure",
          hostPattern: "api.stripe.com",
          credentialRef: vaultHandle,
          mode: {
            kind: "header",
            header: "authorization",
            scheme: "Bearer",
          },
        },
      ],
      modelRoute: { baseUrl: "https://model-gateway.internal" },
    },
    authz: {
      allowedTools: [],
      deniedTools: [],
      approvalRequired: [],
      maxBudget: null,
    },
    conversationRisk: { outputScreeningMode: "hold" },
    createdAt: version,
  };

  sqlite
    .prepare(
      `INSERT INTO policy_snapshot (
       organisation_id, version, body, created_at, created_by
     ) VALUES (?, ?, ?, ?, 'credential-closure-test')`,
    )
    .run(ORGANISATION_ID, version, JSON.stringify(body), version);
}

function seedVaultSecret(
  sqlite: DatabaseSync,
  vaultHandle: string,
  revokedAt: number | null,
): void {
  sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (?, ?, 'v1', 'AES-GCM-256', 'closure-nonce',
       'closure-secret-material', 1, NULL, ?)`,
    )
    .run(ORGANISATION_ID, vaultHandle, revokedAt);
}

type Fixture = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
};

function createFixture(): Fixture {
  const sqlite = new DatabaseSync(":memory:");

  sqlite.exec(singleDatabaseSchema());

  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Credential Closure', 'beta', 1, 'active')`,
    )
    .run(ORGANISATION_ID);

  return {
    sqlite,
    db: d1Database(sqlite),
  };
}
