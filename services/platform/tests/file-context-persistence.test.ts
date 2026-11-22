// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import { type SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { parseInitialOrganisationPlacement } from "../src/placement";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  FILE_DAILY_SOURCE_BYTE_BUDGET,
  claimFileGrantReconciliation,
  commitFileCursorAndOutbox,
  commitFileGrantReconciliation,
  createFileProjectionCommand,
  initializeFileGrantSync,
  listDueFileGrantReconciliations,
  listFileGrantSyncViews,
  listPendingFileProjectionOutboxGlobal,
  readFileGrantSync,
  readFileProviderCursor,
  replaceFileGrantAdmissions,
  reserveFileExtractionBudget,
  scheduleFileReconciliationHint,
  settleFileGrantReady,
} from "../src/context/files";
import { revokeVersionedAccessGrant } from "../src/access-control/grant-mutations";
import { d1Database } from "./sqlite-d1";
import {
  requireUserId,
  requireIntegrationAccountId,
  requireOrganisationId,
} from "./test-ids";

const migration = singleDatabaseSchema();
const NOW = 1_788_000_000_000;

describe("file context persistence", () => {
  it("claims and settles one recoverable grant reconciliation lease", async () => {
    const fixture = createFixture();
    await initializeFileGrantSync({
      db: fixture.db,
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      nextRunAt: NOW,
      now: NOW,
    });
    await expect(
      readFileGrantSync({
        db: fixture.db,
        organisationId: fixture.organisationId,
        grantId: "grant_files",
      }),
    ).resolves.toEqual({ kind: "pending", nextRunAt: NOW });
    await expect(
      listFileGrantSyncViews({
        db: fixture.db,
        organisationId: fixture.organisationId,
      }),
    ).resolves.toEqual([
      {
        grantId: "grant_files",
        state: { kind: "pending", nextRunAt: NOW },
      },
    ]);

    await expect(
      claimFileGrantReconciliation({
        scope: await requireFileFixtureScope(fixture),
        grantId: "grant_files",
        leaseId: "lease_files",
        startedAt: NOW,
        leaseExpiresAt: NOW + 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      claimFileGrantReconciliation({
        scope: await requireFileFixtureScope(fixture),
        grantId: "grant_files",
        leaseId: "lease_competing",
        startedAt: NOW + 1,
        leaseExpiresAt: NOW + 60_001,
      }),
    ).resolves.toBe(false);

    await expect(
      settleFileGrantReady({
        scope: await requireFileFixtureScope(fixture),
        grantId: "grant_files",
        leaseId: "lease_files",
        reconciledAt: NOW + 2,
        nextRunAt: NOW + 3_600_002,
      }),
    ).resolves.toBe(true);
    await expect(
      readFileGrantSync({
        db: fixture.db,
        organisationId: fixture.organisationId,
        grantId: "grant_files",
      }),
    ).resolves.toEqual({
      kind: "ready",
      reconciledAt: NOW + 2,
      nextRunAt: NOW + 3_600_002,
    });
  });

  it("commits admissions, a cursor, and projection outbox work", async () => {
    const fixture = createFixture();
    await replaceFileGrantAdmissions({
      db: fixture.db,
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      admissions: [
        {
          grantId: "grant_files",
          grantRevision: 1,
          integrationAccountId: fixture.integrationAccountId,
          provider: "dropbox",
          providerFileId: "id:recipe",
          containingScopeKey: "dropbox_folder:id:recipes",
          providerRevision: { kind: "dropbox", rev: "015" },
        },
      ],
      admittedAt: NOW,
    });
    const command = createFileProjectionCommand({
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      provider: "dropbox",
      providerFileId: "id:recipe",
      sourceSequence: 1,
      providerRevision: { kind: "dropbox", rev: "015" },
      visibilityKey: "conversation:ia_files:C123",
    });
    await commitFileCursorAndOutbox({
      scope: await requireFileFixtureScope(fixture),
      integrationAccountId: fixture.integrationAccountId,
      scopeKey: "dropbox_folder:id:recipes",
      cursor: { kind: "dropbox", cursor: "cursor-1" },
      commands: [{ outboxId: "outbox-1", command }],
      now: NOW,
    });

    await expect(
      readFileProviderCursor({
        db: fixture.db,
        organisationId: fixture.organisationId,
        integrationAccountId: fixture.integrationAccountId,
        scopeKey: "dropbox_folder:id:recipes",
      }),
    ).resolves.toEqual({ kind: "dropbox", cursor: "cursor-1" });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM file_projection_outbox WHERE organisation_id = ?",
        )
        .get(fixture.organisationId),
    ).toEqual({ count: 1 });

    await initializeFileGrantSync({
      db: fixture.db,
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      nextRunAt: NOW,
      now: NOW,
    });
    insertReadyFileProjection(fixture);
    fixture.sqlite.exec(`
      INSERT INTO organisation_onboarding (
        organisation_id, environment, lifecycle, capability_profile,
        configuration_version, projection_revision, updated_at
      ) VALUES (
        'organisation_files', 'development', 'configuring', 'read_and_propose',
        1, 1, ${NOW}
      );
    `);
    const placement = parseInitialOrganisationPlacement({
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: "files",
      locationHint: "wnam",
    });
    if (!placement.ok) throw new Error(placement.error.code);
    await ensureInitialOrganisationPlacement({
      db: fixture.db,
      organisationId: fixture.organisationId,
      placement: placement.value,
      environment: "development",
      now: NOW,
    });
    const scope = await OrganisationExecutionScope.resolve(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: placement.value.kind, placementCellId: placement.value.placementCellId, locationHint: placement.value.locationHint }),
      },
      fixture.organisationId,
    );
    if (!scope.ok) throw new Error(scope.error.code);
    const revoked = await revokeVersionedAccessGrant({
      scope: scope.value,
      grantId: "grant_files",
      expectedProjectionRevision: 1,
      expectedGrantRevision: 1,
      reason: "operator_revoked",
      actorUserId: requireUserId("user_dab01be4-5d2a-5eb0-ad17-377ebd580df4"),
      identity: {
        receiptId: "receipt_files_revoke",
        auditEventId: "audit_files_revoke",
        correlationId: "files",
        causationId: "files",
        portalSubjectHash: "files",
        createdAt: NOW + 1,
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: "files_revoke",
        requestHash: "files_revoke",
      },
    });
    expect(revoked.ok && revoked.value.grant.lifecycle.kind).toBe("revoked");
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM file_grant_admission WHERE organisation_id = ?",
        )
        .get(fixture.organisationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM file_grant_sync WHERE organisation_id = ?",
        )
        .get(fixture.organisationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT lifecycle, superseded_reason AS reason FROM context_projection",
        )
        .get(),
    ).toEqual({ lifecycle: "superseded", reason: "grant_revoked" });
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS count FROM context_projection_fts")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("preserves a webhook hint that arrives during reconciliation", async () => {
    const fixture = createFixture();
    await initializeFileGrantSync({
      db: fixture.db,
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      nextRunAt: NOW,
      now: NOW,
    });
    await claimFileGrantReconciliation({
      scope: await requireFileFixtureScope(fixture),
      grantId: "grant_files",
      leaseId: "lease_files",
      startedAt: NOW,
      leaseExpiresAt: NOW + 60_000,
    });

    await expect(
      scheduleFileReconciliationHint({
        scope: await requireFileFixtureScope(fixture),
        integrationAccountId: fixture.integrationAccountId,
        nextRunAt: NOW + 1,
      }),
    ).resolves.toBe(1);
    await expect(
      readFileGrantSync({
        db: fixture.db,
        organisationId: fixture.organisationId,
        grantId: "grant_files",
      }),
    ).resolves.toEqual({ kind: "pending", nextRunAt: NOW + 1 });
    await expect(
      settleFileGrantReady({
        scope: await requireFileFixtureScope(fixture),
        grantId: "grant_files",
        leaseId: "lease_files",
        reconciledAt: NOW + 2,
        nextRunAt: NOW + 3_600_002,
      }),
    ).resolves.toBe(false);
  });

  it("reserves the daily source-byte budget atomically", async () => {
    const fixture = createFixture();
    const scope = await requireFileFixtureScope(fixture);
    await expect(
      reserveFileExtractionBudget({
        scope,
        integrationAccountId: fixture.integrationAccountId,
        utcDay: "2026-08-29",
        sourceBytes: 10,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "reserved", admittedSourceBytes: 10 });
    await expect(
      reserveFileExtractionBudget({
        scope,
        integrationAccountId: fixture.integrationAccountId,
        utcDay: "2026-08-29",
        sourceBytes: FILE_DAILY_SOURCE_BYTE_BUDGET,
        now: NOW + 1,
      }),
    ).resolves.toEqual({ kind: "exhausted", admittedSourceBytes: 10 });
  });

  it("atomically replaces admissions with cursor-bound projection work", async () => {
    const fixture = createFixture();
    await initializeFileGrantSync({
      db: fixture.db,
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      nextRunAt: NOW,
      now: NOW,
    });
    await expect(
      listDueFileGrantReconciliations({
        db: fixture.db,
        now: NOW,
        limit: 10,
      }),
    ).resolves.toEqual([
      { organisationId: fixture.organisationId, grantId: "grant_files" },
    ]);
    const command = createFileProjectionCommand({
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      provider: "dropbox",
      providerFileId: "id:recipe",
      sourceSequence: 1,
      providerRevision: { kind: "dropbox", rev: "016" },
      visibilityKey: "conversation:ia_files:C123",
    });
    await commitFileGrantReconciliation({
      scope: await requireFileFixtureScope(fixture),
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      scopeKey: "dropbox_folder:id:recipes",
      cursor: { kind: "dropbox", cursor: "cursor-2" },
      admissions: [
        {
          grantId: "grant_files",
          grantRevision: 1,
          integrationAccountId: fixture.integrationAccountId,
          provider: "dropbox",
          providerFileId: "id:recipe",
          containingScopeKey: "dropbox_folder:id:recipes",
          providerRevision: { kind: "dropbox", rev: "016" },
        },
      ],
      commands: [{ outboxId: "outbox-2", command }],
      now: NOW,
    });

    await expect(
      listPendingFileProjectionOutboxGlobal({
        db: fixture.db,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        organisationId: fixture.organisationId,
        outboxId: "outbox-2",
        command,
      },
    ]);
    expect(
      fixture.sqlite
        .prepare(
          "SELECT provider_revision_json AS revision FROM file_grant_admission",
        )
        .get(),
    ).toEqual({ revision: JSON.stringify({ kind: "dropbox", rev: "016" }) });

    insertReadyFileProjection(fixture);
    await commitFileGrantReconciliation({
      scope: await requireFileFixtureScope(fixture),
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      scopeKey: "dropbox_folder:id:recipes",
      cursor: { kind: "dropbox", cursor: "cursor-3" },
      admissions: [],
      commands: [],
      now: NOW + 1,
    });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT lifecycle, superseded_reason AS reason FROM context_projection",
        )
        .get(),
    ).toEqual({
      lifecycle: "superseded",
      reason: "provider_resource_unavailable",
    });
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS count FROM context_projection_fts")
        .get(),
    ).toEqual({ count: 0 });
  });
});

async function requireFileFixtureScope(
  fixture: ReturnType<typeof createFixture>,
): Promise<OrganisationExecutionScope> {
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "files",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.code);
  await ensureInitialOrganisationPlacement({
    db: fixture.db,
    organisationId: fixture.organisationId,
    placement: placement.value,
    environment: "development",
    now: NOW,
  });
  const scope = await OrganisationExecutionScope.resolve(
    {
      DB: fixture.db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: placement.value.kind, placementCellId: placement.value.placementCellId, locationHint: placement.value.locationHint }),
    },
    fixture.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value;
}

function createFixture(): Readonly<{
  readonly db: SingleDatabase;
  readonly sqlite: DatabaseSync;
  readonly organisationId: ReturnType<typeof requireOrganisationId>;
  readonly integrationAccountId: ReturnType<typeof requireIntegrationAccountId>;
}> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  sqlite.exec(`
    INSERT INTO organisation (organisation_id, organisation_handle, name, created_at)
    VALUES ('organisation_files', 'files-org', 'Files', ${NOW});
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES (
      'user_dab01be4-5d2a-5eb0-ad17-377ebd580df4', 'https://issuer.example', 'files', 'files@example.com',
      'Files', 1, ${NOW}, ${NOW}
    );
    INSERT INTO provider_connection (
      provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
      credential_generation, credential_ref, lifecycle, granted_scopes,
      created_by_user_id, created_at, updated_at, environment,
      provider_subject_id
    ) VALUES (
      'connection_files', 'organisation_files', 'dropbox', 'shared_pantry_app',
      'connection_credential', 1, 'vault:dropbox:files:g1', 'active',
      '["files.metadata.read","files.content.read"]', 'user_dab01be4-5d2a-5eb0-ad17-377ebd580df4',
      ${NOW}, ${NOW}, 'development', 'dbid:files'
    );
    INSERT INTO integration_account (
      integration_account_id, organisation_id, provider_connection_id, provider,
      provider_account_id, account_kind, display_name, lifecycle,
      lifecycle_reason_code, capability_set, audience_policy, retention_policy,
      created_at, updated_at, disabled_by_user_id, disabled_at,
      revoked_at, environment, is_default_for_provider
    ) VALUES (
      'ia_files', 'organisation_files', 'connection_files', 'dropbox', 'dbid:files',
      'resource', 'Dropbox files', 'active', NULL, '["file.read"]',
      '{"kind":"operator"}', '{"kind":"organisation_default"}',
      ${NOW}, ${NOW}, NULL, NULL, NULL, 'development', 0
    );
    INSERT INTO access_grant (
      organisation_id, grant_id, subject_json, target_json, lifecycle, revision,
      reason, provenance_json, changed_at
    ) VALUES (
      'organisation_files', 'grant_files',
      '{"kind":"conversation","integrationAccountId":"ia_files","conversationId":"C123"}',
      '{"kind":"file_resource","capabilityId":"file.read","capabilityVersion":1,"integrationAccountId":"ia_files","scope":{"kind":"dropbox_folder","providerFolderId":"id:recipes","pathDisplay":"/Recipes"}}',
      'active', 1, NULL,
      '{"kind":"operator","userId":"user_dab01be4-5d2a-5eb0-ad17-377ebd580df4","mutationReceiptId":"receipt_files"}',
      ${NOW}
    );
  `);
  return {
    db: d1Database(sqlite),
    sqlite,
    organisationId: requireOrganisationId("organisation_files"),
    integrationAccountId: requireIntegrationAccountId("ia_files"),
  };
}

function insertReadyFileProjection(
  fixture: ReturnType<typeof createFixture>,
): void {
  fixture.sqlite
    .prepare(
      `INSERT INTO context_projection (
       organisation_id, source_kind, source_key, source_json, source_revision,
       source_revision_json, lifecycle, content_digest, visibility_json,
       visibility_key, flow_label_json, indexed_at, bounded_text, title,
       display_path, provenance_json, grant_id, grant_revision,
       provider_file_id, created_at, updated_at
     ) VALUES (?, 'file_segment', ?, ?, 1, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      fixture.organisationId,
      "ia_files\u0000dropbox\u0000id:recipe\u00000",
      JSON.stringify({
        kind: "file_segment",
        integrationAccountId: fixture.integrationAccountId,
        provider: "dropbox",
        providerFileId: "id:recipe",
        segmentIndex: 0,
      }),
      JSON.stringify({
        kind: "file",
        sequence: 1,
        providerRevision: { kind: "dropbox", rev: "016" },
      }),
      "digest",
      JSON.stringify({
        kind: "conversation",
        integrationAccountId: "ia_files",
        conversationId: "C123",
      }),
      "conversation:ia_files:C123",
      "{}",
      NOW,
      "recipe",
      "recipe.md",
      "/Recipes/recipe.md",
      "{}",
      "grant_files",
      "id:recipe",
      NOW,
      NOW,
    );
}
