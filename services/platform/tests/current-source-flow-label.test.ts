import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import type { RequestAuthority } from "@purin-labs/contracts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  createCurrentSourceFlowLabel,
  integrationResourceScopeForGrant,
} from "../src/policy";
import { d1Database } from "./sqlite-d1";
import type { Variant } from "@purin-labs/type-utils";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION_ID = requireOrganisationId("organisation_source_policy");

describe("current source-flow labels", () => {
  it("derives control ingress from the exact current requester", async () => {
    const fixture = createFixture();
    const result = await createCurrentSourceFlowLabel({
      kind: "ingress",
      db: fixture.db,
      authority: controlAuthority(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.policies).toEqual([
        {
          owner: { kind: "organisation", organisationId: ORGANISATION_ID },
          readers: [{ kind: "person", personId: "person_source_owner" }],
        },
      ]);
    }
    fixture.sqlite.close();
  });

  it("intersects exact resource grants with current subject and account lifecycle", async () => {
    const fixture = createFixture();
    const grant = fileGrant();
    const resourceScope = integrationResourceScopeForGrant(grant);
    expect(resourceScope).toBe("dropbox_file:file_contract");
    if (resourceScope === null) return;

    const current = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: fixture.db,
      organisationId: ORGANISATION_ID,
      integrationAccountId: "account_source_dropbox",
      capabilityId: "file.read",
      resourceScope,
      grantIds: [grant.grantId],
    });
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.value.policies[0]).toMatchObject({
        owner: {
          kind: "integration_resource",
          organisationId: ORGANISATION_ID,
          integrationAccountId: "account_source_dropbox",
          resourceScope,
        },
        readers: [{ kind: "person", personId: "person_source_owner" }],
      });
    }

    fixture.sqlite
      .prepare(
        "UPDATE service_role_grant SET status = 'revoked' WHERE organisation_id = ?",
      )
      .run(ORGANISATION_ID);
    const staleSubject = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: fixture.db,
      organisationId: ORGANISATION_ID,
      integrationAccountId: "account_source_dropbox",
      capabilityId: "file.read",
      resourceScope,
      grantIds: [grant.grantId],
    });
    expect(staleSubject).toEqual({
      ok: false,
      error: { code: "source_subject_inactive", subject: grant.grantId },
    });

    fixture.sqlite
      .prepare(
        "UPDATE service_role_grant SET status = 'active' WHERE organisation_id = ?",
      )
      .run(ORGANISATION_ID);
    fixture.sqlite
      .prepare(
        "UPDATE integration_account SET lifecycle = 'disabled' WHERE organisation_id = ?",
      )
      .run(ORGANISATION_ID);
    const staleAccount = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: fixture.db,
      organisationId: ORGANISATION_ID,
      integrationAccountId: "account_source_dropbox",
      capabilityId: "file.read",
      resourceScope,
      grantIds: [grant.grantId],
    });
    expect(staleAccount).toEqual({
      ok: false,
      error: {
        code: "source_resource_inactive",
        integrationAccountId: "account_source_dropbox",
      },
    });
    fixture.sqlite.close();
  });

  it("labels integration metadata from the existing organisation policy store", async () => {
    const fixture = createFixture();
    const current = await createCurrentSourceFlowLabel({
      kind: "integration_metadata",
      db: fixture.db,
      organisationId: ORGANISATION_ID,
      grantIds: ["grant_source_integration_discovery"],
    });
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.value.policies).toEqual([
        {
          owner: { kind: "organisation", organisationId: ORGANISATION_ID },
          readers: [{ kind: "organisation_role", role: "owner" }],
        },
      ]);
    }
    fixture.sqlite.close();
  });

  it("rejects a different resource scope and a disabled organisation capability", async () => {
    const fixture = createFixture();
    const wrongScope = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: fixture.db,
      organisationId: ORGANISATION_ID,
      integrationAccountId: "account_source_dropbox",
      capabilityId: "file.read",
      resourceScope: "dropbox_file:file_other",
      grantIds: ["grant_source_file"],
    });
    expect(wrongScope).toEqual({
      ok: false,
      error: { code: "source_grant_unavailable", grantId: "grant_source_file" },
    });

    fixture.sqlite
      .prepare("DELETE FROM policy_snapshot WHERE organisation_id = ?")
      .run(ORGANISATION_ID);
    insertPolicy(fixture.sqlite, []);
    const disabled = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: fixture.db,
      organisationId: ORGANISATION_ID,
      integrationAccountId: "account_source_dropbox",
      capabilityId: "file.read",
      resourceScope: "dropbox_file:file_contract",
      grantIds: ["grant_source_file"],
    });
    expect(disabled).toEqual({
      ok: false,
      error: { code: "source_capability_disabled", capabilityId: "file.read" },
    });
    fixture.sqlite.close();
  });
});

function createFixture(): Readonly<{
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
}> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE organisation (organisation_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE service_role_grant (
      organisation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE organisation_onboarding (
      organisation_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      configuration_version INTEGER NOT NULL
    );
    CREATE TABLE integration_account (
      integration_account_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      lifecycle TEXT NOT NULL
    );
    CREATE TABLE policy_snapshot (
      organisation_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY (organisation_id, version)
    );
    CREATE TABLE access_grant (
      organisation_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      revision INTEGER NOT NULL,
      reason TEXT,
      provenance_json TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      PRIMARY KEY (organisation_id, grant_id)
    );
  `);
  sqlite
    .prepare("INSERT INTO organisation VALUES (?, 'active')")
    .run(ORGANISATION_ID);
  sqlite
    .prepare(
      "INSERT INTO service_role_grant VALUES (?, 'user_8a9f79d5-5c63-5c97-9a11-237a4dc85809', 'person_source_owner', 'owner', 'active')",
    )
    .run(ORGANISATION_ID);
  sqlite
    .prepare("INSERT INTO organisation_onboarding VALUES (?, 'active', 1)")
    .run(ORGANISATION_ID);
  sqlite
    .prepare(
      "INSERT INTO integration_account VALUES ('account_source_dropbox', ?, 'dropbox', 'active')",
    )
    .run(ORGANISATION_ID);
  insertPolicy(sqlite, ["file.read", "integration.discovery.read"]);
  sqlite
    .prepare(
      `INSERT INTO access_grant VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, 1)`,
    )
    .run(
      ORGANISATION_ID,
      "grant_source_file",
      JSON.stringify({ kind: "person", personId: "person_source_owner" }),
      JSON.stringify(fileGrant().target),
      JSON.stringify({
        kind: "cutover",
        migrationId: "source_policy_fixture",
        originalChangedAt: 1,
      }),
    );
  sqlite
    .prepare(
      `INSERT INTO access_grant VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, 1)`,
    )
    .run(
      ORGANISATION_ID,
      "grant_source_integration_discovery",
      JSON.stringify({ kind: "organisation_role", role: "owner" }),
      JSON.stringify({
        kind: "platform_capability",
        capabilityId: "integration.discovery.read",
        capabilityVersion: 1,
      }),
      JSON.stringify({
        kind: "cutover",
        migrationId: "source_policy_fixture",
        originalChangedAt: 1,
      }),
    );
  return {
    sqlite,
    db: d1Database(sqlite),
  };
}

function insertPolicy(
  sqlite: DatabaseSync,
  allowedTools: readonly string[],
): void {
  sqlite
    .prepare(
      "INSERT INTO policy_snapshot VALUES (?, 1, ?, 1, 'source-policy-test')",
    )
    .run(
      ORGANISATION_ID,
      JSON.stringify({
        version: 1,
        egress: {
          allowedHosts: [],
          injections: [],
          modelRoute: { baseUrl: "https://unavailable.invalid" },
        },
        authz: {
          allowedTools,
          deniedTools: [],
          approvalRequired: [],
          maxBudget: {
            maxTokens: 64_000,
            maxWallMs: 180_000,
            maxToolCalls: 20,
          },
        },
        conversationRisk: { outputScreeningMode: "hold" },
        createdAt: 1,
      }),
    );
}

function controlAuthority(): Variant<RequestAuthority, "control"> {
  return {
    kind: "control",
    organisationId: ORGANISATION_ID,
    requesterPersonId: "person_source_owner",
    userId: "user_8a9f79d5-5c63-5c97-9a11-237a4dc85809",
    membershipRevision: 1,
    role: "owner",
  };
}

function fileGrant() {
  return {
    grantId: "grant_source_file",
    organisationId: ORGANISATION_ID,
    subject: { kind: "person" as const, personId: "person_source_owner" },
    target: {
      kind: "file_resource" as const,
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: "account_source_dropbox",
      scope: {
        kind: "dropbox_file" as const,
        providerFileId: "file_contract",
        pathDisplay: "/Contracts/Supplier.pdf",
      },
    },
    provenance: {
      kind: "cutover" as const,
      migrationId: "source_policy_fixture",
      originalChangedAt: 1,
    },
    lifecycle: { kind: "active" as const, revision: 1, activatedAt: 1 },
  };
}
