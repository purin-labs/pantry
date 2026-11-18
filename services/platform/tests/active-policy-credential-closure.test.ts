/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { inspectActivePolicyCredentialClosure } from "../src/credential-vault/active-policy-closure";
import { type VaultHandle } from "../src/credential-vault/domain";
import { parseOrganisationId, type OrganisationId } from "../src/ids";
import { d1Database } from "./sqlite-d1";
import { requireOrganisationId, requireVaultHandle } from "./test-ids";
import { readMigration } from "./sqlite-d1";

describe("active policy credential closure", function activePolicyClosureSuite() {
  it(
    "uses the Actor policy and reports missing or revoked Vault rows",
    reportsVaultIssues,
  );
  it("requires an authoritative active policy", requiresActivePolicy);
  it(
    "requires matching Actor and Vault organisation identity",
    enforcesOrganisationIdentity,
  );
});

async function reportsVaultIssues(): Promise<void> {
  const fixture = closureFixture();
  insertVaultSecret(
    fixture.sqlite,
    fixture.organisationId,
    "vault:test:live",
    null,
  );
  insertVaultSecret(
    fixture.sqlite,
    fixture.organisationId,
    "vault:test:revoked",
    10,
  );
  const organisation = activePolicyStub(fixture.organisationId, 7, [
    { ruleId: "a.live", credentialRef: requireVaultHandle("vault:test:live") },
    {
      ruleId: "b.missing",
      credentialRef: requireVaultHandle("vault:test:missing"),
    },
    {
      ruleId: "c.revoked",
      credentialRef: requireVaultHandle("vault:test:revoked"),
    },
  ]);

  const result = await inspectActivePolicyCredentialClosure({
    db: fixture.db,
    organisation,
    organisationId: fixture.organisationId,
  });

  expect(result).toEqual({
    ok: true,
    value: {
      status: "failed",
      organisationId: fixture.organisationId,
      activePolicyVersion: 7,
      findings: [
        {
          kind: "active_policy_ref_without_live_vault",
          organisationId: fixture.organisationId,
          policyVersion: 7,
          ruleId: "b.missing",
          vaultHandle: "vault:test:missing",
          vaultIssue: "missing",
        },
        {
          kind: "active_policy_ref_without_live_vault",
          organisationId: fixture.organisationId,
          policyVersion: 7,
          ruleId: "c.revoked",
          vaultHandle: "vault:test:revoked",
          vaultIssue: "revoked",
        },
      ],
    },
  });
}

async function requiresActivePolicy(): Promise<void> {
  const fixture = closureFixture();
  const organisation = {
    inspectActivePolicyCredentials: function inspectActivePolicyCredentials() {
      return Promise.resolve({
        ok: true as const,
        value: {
          kind: "no_active_policy" as const,
          organisationId: fixture.organisationId,
        },
      });
    },
  };

  await expect(
    inspectActivePolicyCredentialClosure({
      db: fixture.db,
      organisation,
      organisationId: fixture.organisationId,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      status: "failed",
      organisationId: fixture.organisationId,
      activePolicyVersion: null,
      findings: [
        {
          kind: "active_policy_missing",
          organisationId: fixture.organisationId,
        },
      ],
    },
  });
}

async function enforcesOrganisationIdentity(): Promise<void> {
  const fixture = closureFixture();
  const otherOrganisationId = requireOrganisationId(
    "organisation_active_policy_closure_other",
  );
  insertOrganisation(fixture.sqlite, otherOrganisationId, "Other Organisation");
  insertVaultSecret(
    fixture.sqlite,
    otherOrganisationId,
    "vault:test:organisation-isolation",
    null,
  );
  const requestedOrganisationPolicy = activePolicyStub(
    fixture.organisationId,
    3,
    [
      {
        ruleId: "organisation.read",
        credentialRef: requireVaultHandle("vault:test:organisation-isolation"),
      },
    ],
  );

  await expect(
    inspectActivePolicyCredentialClosure({
      db: fixture.db,
      organisation: requestedOrganisationPolicy,
      organisationId: fixture.organisationId,
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      status: "failed",
      findings: [{ vaultIssue: "missing" }],
    },
  });

  insertVaultSecret(
    fixture.sqlite,
    fixture.organisationId,
    "vault:test:organisation-isolation",
    null,
  );
  await expect(
    inspectActivePolicyCredentialClosure({
      db: fixture.db,
      organisation: requestedOrganisationPolicy,
      organisationId: fixture.organisationId,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      status: "passed",
      organisationId: fixture.organisationId,
      activePolicyVersion: 3,
      findings: [],
    },
  });

  const wrongActor = activePolicyStub(otherOrganisationId, 3, [
    {
      ruleId: "organisation.read",
      credentialRef: requireVaultHandle("vault:test:organisation-isolation"),
    },
  ]);
  await expect(
    inspectActivePolicyCredentialClosure({
      db: fixture.db,
      organisation: wrongActor,
      organisationId: fixture.organisationId,
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "active_policy_closure_data_invalid" },
  });
}

function activePolicyStub(
  organisationId: OrganisationId,
  activeVersion: number,
  credentialRefs: readonly {
    readonly ruleId: string;
    readonly credentialRef: VaultHandle;
  }[],
) {
  return {
    inspectActivePolicyCredentials: function inspectActivePolicyCredentials() {
      return Promise.resolve({
        ok: true as const,
        value: {
          kind: "active_policy" as const,
          organisationId,
          activeVersion,
          credentialRefs,
        },
      });
    },
  };
}

function closureFixture(): {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readMigration("0001_current_schema.sql"));
  const organisationId = parseOrganisationId(
    "organisation_active_policy_closure",
  );
  if (!organisationId.ok) throw new Error("organisation fixture invalid");
  insertOrganisation(sqlite, organisationId.value, "Active Policy Closure");
  return {
    sqlite,
    db: d1Database(sqlite),
    organisationId: organisationId.value,
  };
}

function insertOrganisation(
  sqlite: DatabaseSync,
  organisationId: OrganisationId,
  name: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, ?, 'beta', 1, 'active')`,
    )
    .run(organisationId, name);
}

function insertVaultSecret(
  sqlite: DatabaseSync,
  organisationId: OrganisationId,
  vaultHandle: string,
  revokedAt: number | null,
): void {
  sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, revoked_at
     ) VALUES (?, ?, 'root-v1', 'AES-GCM-256', 'AA==', 'AA==', 1, ?)`,
    )
    .run(organisationId, vaultHandle, revokedAt);
}
