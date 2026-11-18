import { type SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  applyFileProjectionCommand,
  createFileProjectionCommand,
  searchGrantedFiles,
  type FileProjectionSourceReader,
} from "../src/context/files";
import { parseCaseId } from "../src/ids";
import { defaultDenyPolicy } from "../src/policy-snapshot";
import { searchContextProjections } from "../src/context/projection";
import { d1Database } from "./sqlite-d1";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { parseInitialOrganisationPlacement } from "../src/placement";
import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";

const migration = singleDatabaseSchema();
const NOW = 1_788_000_000_000;

describe("file context projection", () => {
  it("derives visibility from the active admission and projects metadata idempotently", async () => {
    const fixture = await createFixture();
    let providerReads = 0;
    const sourceReader: FileProjectionSourceReader = {
      async readMetadata() {
        providerReads += 1;
        return {
          ok: true,
          value: {
            displayName: "Supplier contract.pdf",
            displayPath: "/Contracts/Supplier contract.pdf",
            mediaType: "application/pdf",
            deepLink:
              "https://www.dropbox.com/home/Contracts/Supplier%20contract.pdf",
            sourceBytes: 500,
            providerRevision: { kind: "dropbox", rev: "015" },
            extraction: {
              kind: "metadata_only",
              reason: "unsupported_media_type",
            },
          },
        };
      },
      async readTextContent() {
        throw new Error("metadata-only projection must not fetch content");
      },
    };
    const command = createFileProjectionCommand({
      organisationId: fixture.organisationId,
      grantId: "grant_files",
      grantRevision: 1,
      integrationAccountId: fixture.integrationAccountId,
      provider: "dropbox",
      providerFileId: "id:contract",
      sourceSequence: 1,
      providerRevision: { kind: "dropbox", rev: "015" },
      visibilityKey: "person:person_a",
    });

    await expect(
      applyFileProjectionCommand({
        scope: fixture.scope,
        command,
        sourceReader,
        now: NOW + 1,
      }),
    ).resolves.toEqual({ kind: "applied", segmentCount: 1 });
    await expect(
      applyFileProjectionCommand({
        scope: fixture.scope,
        command,
        sourceReader,
        now: NOW + 2,
      }),
    ).resolves.toEqual({ kind: "duplicate", segmentCount: 1 });
    expect(providerReads).toBe(1);
    expect(
      fixture.sqlite
        .prepare(
          `SELECT lifecycle, visibility_key AS visibilityKey, title
         FROM context_projection WHERE source_kind = 'file_segment'`,
        )
        .get(),
    ).toEqual({
      lifecycle: "ready",
      visibilityKey: "person:person_a",
      title: "Supplier contract.pdf",
    });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM context_projection_fts WHERE context_projection_fts MATCH 'Supplier'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const visible = await searchContextProjections(fixture.db, {
      organisationId: fixture.organisationId,
      visibility: [{ kind: "person", personId: "person_a" }],
      sourceKind: "file_segment",
      query: "supplier contract",
      limit: 20,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.projection).toMatchObject({
      source: {
        kind: "file_segment",
        providerFileId: "id:contract",
        segmentIndex: 0,
      },
      provenance: {
        kind: "integration_file",
        resourceScope: "dropbox_file:id:contract",
        displayName: "Supplier contract.pdf",
      },
    });
    const caseId = parseCaseId("case_files");
    if (!caseId.ok) throw new Error(caseId.error.code);
    const observations: string[] = [];
    const toolResults = await searchGrantedFiles({
      db: fixture.db,
      organisationId: fixture.organisationId,
      caseId: caseId.value,
      requestAuthority: {
        kind: "direct_conversation",
        organisationId: fixture.organisationId,
        requesterPersonId: "person_a",
        membershipRevision: 1,
        role: "operator",
        connectorId: "connector_files",
        integrationAccountId: "ia_slack",
        conversationId: "dm_files",
      },
      visibility: [{ kind: "person", personId: "person_a" }],
      query: "supplier contract",
      limit: 20,
      observe: async (observation) => {
        observations.push(observation.evidence.evidenceDigest);
      },
    });
    expect(toolResults).toHaveLength(1);
    expect(observations).toHaveLength(1);

    fixture.sqlite.exec(`
      INSERT INTO access_grant (
        organisation_id, grant_id, subject_json, target_json, lifecycle, revision,
        reason, provenance_json, changed_at
      ) VALUES (
        'organisation_files', 'grant_files_role', '{"kind":"organisation_role","role":"operator"}',
        '{"kind":"file_resource","capabilityId":"file.read","capabilityVersion":1,"integrationAccountId":"ia_files","scope":{"kind":"dropbox_file","providerFileId":"id:contract","pathDisplay":"/Contracts/Supplier contract.pdf"}}',
        'active', 1, NULL, '{"kind":"cutover","migrationId":"file_projection_test","originalChangedAt":${NOW}}', ${NOW}
      );
      INSERT INTO file_grant_admission (
        organisation_id, grant_id, grant_revision, integration_account_id, provider,
        provider_file_id, containing_scope_key, provider_revision_json, admitted_at
      ) VALUES (
        'organisation_files', 'grant_files_role', 1, 'ia_files', 'dropbox', 'id:contract',
        'dropbox_file:id:contract', '{"kind":"dropbox","rev":"015"}', ${NOW}
      );
    `);
    await expect(
      applyFileProjectionCommand({
        scope: fixture.scope,
        command: {
          ...command,
          grantId: "grant_files_role",
          visibilityKey: "organisation_role:operator",
        },
        sourceReader,
        now: NOW + 3,
      }),
    ).resolves.toEqual({ kind: "applied", segmentCount: 1 });
    expect(providerReads).toBe(2);
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM context_projection WHERE source_kind = 'file_segment'",
        )
        .get(),
    ).toEqual({ count: 2 });

    fixture.sqlite.exec(`
      INSERT INTO access_grant (
        organisation_id, grant_id, subject_json, target_json, lifecycle, revision,
        reason, provenance_json, changed_at
      ) VALUES (
        'organisation_files', 'grant_files_person_overlap', '{"kind":"person","personId":"person_a"}',
        '{"kind":"file_resource","capabilityId":"file.read","capabilityVersion":1,"integrationAccountId":"ia_files","scope":{"kind":"dropbox_file","providerFileId":"id:contract","pathDisplay":"/Contracts/Supplier contract.pdf"}}',
        'active', 1, NULL, '{"kind":"cutover","migrationId":"file_projection_test","originalChangedAt":${NOW}}', ${NOW}
      );
      INSERT INTO file_grant_admission (
        organisation_id, grant_id, grant_revision, integration_account_id, provider,
        provider_file_id, containing_scope_key, provider_revision_json, admitted_at
      ) VALUES (
        'organisation_files', 'grant_files_person_overlap', 1, 'ia_files', 'dropbox', 'id:contract',
        'dropbox_file:id:contract', '{"kind":"dropbox","rev":"015"}', ${NOW}
      );
      DELETE FROM file_grant_admission
       WHERE organisation_id = 'organisation_files' AND grant_id = 'grant_files';
    `);
    await expect(
      searchContextProjections(fixture.db, {
        organisationId: fixture.organisationId,
        visibility: [{ kind: "person", personId: "person_a" }],
        sourceKind: "file_segment",
        query: "supplier contract",
        limit: 20,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      searchGrantedFiles({
        db: fixture.db,
        organisationId: fixture.organisationId,
        caseId: caseId.value,
        requestAuthority: {
          kind: "direct_conversation",
          organisationId: fixture.organisationId,
          requesterPersonId: "person_a",
          membershipRevision: 1,
          role: "operator",
          connectorId: "connector_files",
          integrationAccountId: "ia_slack",
          conversationId: "dm_files",
        },
        visibility: [{ kind: "person", personId: "person_a" }],
        query: "supplier contract",
        limit: 20,
        observe: async () => undefined,
      }),
    ).resolves.toHaveLength(1);

    fixture.sqlite
      .prepare(
        "DELETE FROM file_grant_admission WHERE organisation_id = ? AND grant_id = ?",
      )
      .run(fixture.organisationId, "grant_files_person_overlap");
    await expect(
      searchContextProjections(fixture.db, {
        organisationId: fixture.organisationId,
        visibility: [{ kind: "person", personId: "person_a" }],
        sourceKind: "file_segment",
        query: "supplier contract",
        limit: 20,
      }),
    ).resolves.toEqual([]);
    await expect(
      applyFileProjectionCommand({
        scope: fixture.scope,
        command: { ...command, sourceSequence: 2 },
        sourceReader,
        now: NOW + 4,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "file_admission_missing" });
    expect(providerReads).toBe(2);
  });
});

async function createFixture(): Promise<
  Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly db: SingleDatabase;
    readonly sqlite: DatabaseSync;
    readonly organisationId: ReturnType<typeof requireOrganisationId>;
    readonly integrationAccountId: ReturnType<
      typeof requireIntegrationAccountId
    >;
  }>
> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const baselinePolicy = defaultDenyPolicy({ now: NOW });
  const policy = JSON.stringify({
    version: baselinePolicy.version,
    egress: baselinePolicy.egress,
    authz: {
      allowedTools: ["file.read"],
      deniedTools: baselinePolicy.authz.deniedTools,
      approvalRequired: baselinePolicy.authz.approvalRequired,
      maxBudget: baselinePolicy.authz.maxBudget,
    },
    conversationRisk: baselinePolicy.conversationRisk,
    createdAt: baselinePolicy.createdAt,
  }).replaceAll("'", "''");
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
    INSERT INTO person (organisation_id, person_id, display_name, avatar_url)
    VALUES ('organisation_files', 'person_a', 'Person A', NULL);
    INSERT INTO service_role_grant (
      organisation_id, user_id, person_id, role, status, created_at, revoked_at
    ) VALUES (
      'organisation_files', 'user_dab01be4-5d2a-5eb0-ad17-377ebd580df4', 'person_a', 'operator', 'active', ${NOW}, NULL
    );
    INSERT INTO provider_connection (
      provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
      credential_generation, credential_ref, lifecycle, granted_scopes,
      created_by_user_id, created_at, updated_at, environment,
      provider_subject_id
    ) VALUES (
      'connection_files', 'organisation_files', 'dropbox', 'shared_satyr_app',
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
      'organisation_files', 'grant_files', '{"kind":"person","personId":"person_a"}',
      '{"kind":"file_resource","capabilityId":"file.read","capabilityVersion":1,"integrationAccountId":"ia_files","scope":{"kind":"dropbox_file","providerFileId":"id:contract","pathDisplay":"/Contracts/Supplier contract.pdf"}}',
      'active', 1, NULL, '{"kind":"cutover","migrationId":"file_projection_test","originalChangedAt":${NOW}}', ${NOW}
    );
    INSERT INTO file_grant_admission (
      organisation_id, grant_id, grant_revision, integration_account_id, provider,
      provider_file_id, containing_scope_key, provider_revision_json, admitted_at
    ) VALUES (
      'organisation_files', 'grant_files', 1, 'ia_files', 'dropbox', 'id:contract',
      'dropbox_file:id:contract', '{"kind":"dropbox","rev":"015"}', ${NOW}
    );
    INSERT INTO file_resource_source (
      organisation_id, integration_account_id, provider, provider_file_id,
      source_sequence, provider_revision_json, display_name, display_path,
      media_type, deep_link, content_state, content_digest, metadata_only_reason,
      segment_count, observed_at, updated_at
    ) VALUES (
      'organisation_files', 'ia_files', 'dropbox', 'id:contract', 1,
      '{"kind":"dropbox","rev":"015"}', 'Supplier contract.pdf',
      '/Contracts/Supplier contract.pdf', 'application/pdf',
      'https://www.dropbox.com/home/Contracts/Supplier%20contract.pdf',
      'pending', NULL, NULL, NULL, ${NOW}, ${NOW}
    );
    INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by)
    VALUES ('organisation_files', 0, '${policy}', ${NOW}, 'test');
  `);
  const db = d1Database(sqlite);
  const organisationId = requireOrganisationId("organisation_files");
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "files",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.code);
  await ensureInitialOrganisationPlacement({
    db,
    organisationId,
    placement: placement.value,
    environment: "development",
    now: NOW,
  });
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: placement.value.kind, placementCellId: placement.value.placementCellId, locationHint: placement.value.locationHint }),
    },
    organisationId,
  );
  return {
    scope,
    db,
    sqlite,
    organisationId,
    integrationAccountId: requireIntegrationAccountId("ia_files"),
  };
}
